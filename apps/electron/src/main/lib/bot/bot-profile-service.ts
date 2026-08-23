/**
 * Bot 库本地持久化服务。
 *
 * BotProfile 是长期身份；BotConfigRevision 是不可变配置版本。
 * 房间加入时只复制 revision 形成 RoomBotSeat，不在这里持有房间上下文。
 */
import { readJsonSafe, writeJsonAtomic } from "../atomic-json";
import { getBotProfilesPath } from "../config/config-paths";
import type {
  BotConfigRevision,
  BotProfile,
  BotProfileRecord,
  CollaborationMemberCapabilities,
  CollaborationRoleSnapshot,
} from "@tagent/shared";

const STORE_VERSION = 1;

type BotStoreFile = {
  version: typeof STORE_VERSION;
  records: BotProfileRecord[];
};

const EMPTY_STORE: BotStoreFile = { version: STORE_VERSION, records: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBackend(value: unknown): value is BotConfigRevision["backend"] {
  return value === "pi" || value === "channel" || value === "cli";
}

function isPermission(
  value: unknown,
): value is BotConfigRevision["permissionProfile"] {
  return value === "read-only" || value === "workspace-write";
}

function isCapabilities(
  value: unknown,
): value is CollaborationMemberCapabilities {
  return (
    isRecord(value) &&
    typeof value.supportsResume === "boolean" &&
    typeof value.supportsLiveInput === "boolean" &&
    typeof value.supportsToolBridge === "boolean" &&
    typeof value.supportsStructuredEvents === "boolean"
  );
}

function isRoleSnapshot(value: unknown): value is CollaborationRoleSnapshot {
  return isRecord(value) && typeof value.displayName === "string";
}

function validateRevision(
  revision: BotConfigRevision,
  profileId: string,
): string[] {
  const errors: string[] = [];
  if (!revision.id.trim()) errors.push("revision.id 必填");
  if (revision.botProfileId !== profileId)
    errors.push("revision.botProfileId 必须匹配 profile.id");
  if (!Number.isInteger(revision.version) || revision.version < 1) {
    errors.push("revision.version 必须是正整数");
  }
  if (!isBackend(revision.backend)) errors.push("revision.backend 非法");
  if (!isPermission(revision.permissionProfile))
    errors.push("revision.permissionProfile 非法");
  if (!isRoleSnapshot(revision.roleSnapshot))
    errors.push("revision.roleSnapshot 非法");
  if (!isCapabilities(revision.capabilities))
    errors.push("revision.capabilities 非法");
  if (!Number.isFinite(revision.createdAt))
    errors.push("revision.createdAt 非法");
  return errors;
}

export function validateBotProfileRecord(record: BotProfileRecord): string[] {
  const errors: string[] = [];
  const profile = record?.profile;
  const revisions = record?.revisions;
  if (!profile || !profile.id?.trim()) errors.push("profile.id 必填");
  if (!profile?.ownerUserId?.trim()) errors.push("profile.ownerUserId 必填");
  if (!profile?.displayName?.trim()) errors.push("profile.displayName 必填");
  if (!profile?.memoryNamespace?.trim())
    errors.push("profile.memoryNamespace 必填");
  if (!profile?.currentConfigRevisionId?.trim())
    errors.push("profile.currentConfigRevisionId 必填");
  if (!Array.isArray(revisions) || revisions.length === 0) {
    errors.push("profile 至少需要一个 config revision");
    return errors;
  }

  const revisionIds = new Set<string>();
  const versions = new Set<number>();
  for (const revision of revisions) {
    if (!revision || typeof revision !== "object") {
      errors.push("revision 必须是对象");
      continue;
    }
    errors.push(...validateRevision(revision, profile.id));
    if (revisionIds.has(revision.id))
      errors.push(`revision.id 重复: ${revision.id}`);
    revisionIds.add(revision.id);
    if (versions.has(revision.version))
      errors.push(`revision.version 重复: ${revision.version}`);
    versions.add(revision.version);
  }
  if (
    profile.currentConfigRevisionId &&
    !revisionIds.has(profile.currentConfigRevisionId)
  ) {
    errors.push("profile.currentConfigRevisionId 不存在");
  }
  return errors;
}

function parseStore(value: unknown): BotStoreFile {
  if (!isRecord(value)) return EMPTY_STORE;
  const records = Array.isArray(value.records) ? value.records : [];
  return {
    version: STORE_VERSION,
    records: records.filter((record): record is BotProfileRecord => {
      return validateBotProfileRecord(record).length === 0;
    }),
  };
}

function cloneRecord(record: BotProfileRecord): BotProfileRecord {
  return JSON.parse(JSON.stringify(record)) as BotProfileRecord;
}

function loadStore(): BotStoreFile {
  return parseStore(readJsonSafe<unknown>(getBotProfilesPath(), EMPTY_STORE));
}

function saveStore(store: BotStoreFile): void {
  writeJsonAtomic(getBotProfilesPath(), store);
}

/** 加载合法 Bot；损坏或不完整记录 fail-closed 丢弃，不阻断其他 Bot。 */
export function loadBotProfiles(): BotProfileRecord[] {
  return loadStore().records.map(cloneRecord);
}

export function getBotProfileRecord(
  profileId: string,
): BotProfileRecord | undefined {
  return loadBotProfiles().find((record) => record.profile.id === profileId);
}

/** 保存 profile 及其 revision 集合；revision 不能通过此函数静默改写。 */
export function saveBotProfileRecord(
  record: BotProfileRecord,
): BotProfileRecord[] {
  const errors = validateBotProfileRecord(record);
  if (errors.length > 0) throw new Error(`Bot 配置无效: ${errors.join("；")}`);

  const records = loadStore().records;
  const index = records.findIndex(
    (item) => item.profile.id === record.profile.id,
  );
  const existing = index >= 0 ? records[index] : undefined;
  if (existing) {
    for (const oldRevision of existing.revisions) {
      const nextRevision = record.revisions.find(
        (revision) => revision.id === oldRevision.id,
      );
      if (
        nextRevision &&
        JSON.stringify(nextRevision) !== JSON.stringify(oldRevision)
      ) {
        throw new Error(`Bot revision 已发布且不可修改: ${oldRevision.id}`);
      }
    }
  }
  const next = cloneRecord(record);
  if (index >= 0) records[index] = next;
  else records.push(next);
  saveStore({ version: STORE_VERSION, records });
  return records.map(cloneRecord);
}

/** 创建 Bot 时必须同时绑定首个 revision，避免产生没有可执行配置的 Bot。 */
export function createBotProfile(
  profile: BotProfile,
  initialRevision: BotConfigRevision,
): BotProfileRecord {
  if (getBotProfileRecord(profile.id))
    throw new Error(`Bot 已存在: ${profile.id}`);
  const record: BotProfileRecord = { profile, revisions: [initialRevision] };
  saveBotProfileRecord(record);
  return cloneRecord(record);
}

/** 发布新 revision；只能追加下一个版本，并自动把 profile 指向新版本。 */
export function publishBotConfigRevision(
  profileId: string,
  revision: BotConfigRevision,
): BotProfileRecord {
  const record = getBotProfileRecord(profileId);
  if (!record) throw new Error(`Bot 不存在: ${profileId}`);
  if (revision.botProfileId !== profileId)
    throw new Error("revision.botProfileId 与 Bot 不匹配");
  if (record.revisions.some((item) => item.id === revision.id)) {
    throw new Error(`Bot revision 已存在: ${revision.id}`);
  }
  const latestVersion = Math.max(
    ...record.revisions.map((item) => item.version),
  );
  if (revision.version !== latestVersion + 1) {
    throw new Error(`Bot revision.version 必须为 ${latestVersion + 1}`);
  }
  const next: BotProfileRecord = {
    profile: {
      ...record.profile,
      currentConfigRevisionId: revision.id,
      updatedAt: Math.max(record.profile.updatedAt, revision.createdAt),
    },
    revisions: [...record.revisions, revision],
  };
  saveBotProfileRecord(next);
  return cloneRecord(next);
}

/** 删除语义采用归档，不删除历史 revision，保证已有房间席位仍可解释。 */
export function archiveBotProfile(
  profileId: string,
  archivedAt = Date.now(),
): BotProfileRecord {
  const record = getBotProfileRecord(profileId);
  if (!record) throw new Error(`Bot 不存在: ${profileId}`);
  const next: BotProfileRecord = {
    ...record,
    profile: {
      ...record.profile,
      status: "archived",
      archivedAt,
      updatedAt: archivedAt,
    },
  };
  saveBotProfileRecord(next);
  return cloneRecord(next);
}
