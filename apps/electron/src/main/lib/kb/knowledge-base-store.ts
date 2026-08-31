/**
 * 全局知识库存储。
 *
 * 知识库是应用级资源，不属于 workspace；这里只保存用户定义的名称和来源目录。
 * 当前来源为只读本地目录，检索仍由 kb-fs-index 负责。
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KnowledgeBaseRecord, KnowledgeBaseSource } from "@tagent/shared";
import { getConfigDir } from "../config/config-paths";

const STORE_FILE = "knowledge-bases.json";

function getStorePath(): string {
  return join(getConfigDir(), STORE_FILE);
}

function readRecords(): KnowledgeBaseRecord[] {
  const path = getStorePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is KnowledgeBaseRecord =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as KnowledgeBaseRecord).id === "string" &&
        typeof (item as KnowledgeBaseRecord).name === "string" &&
        Array.isArray((item as KnowledgeBaseRecord).sources),
    );
  } catch {
    return [];
  }
}

function writeRecords(records: KnowledgeBaseRecord[]): void {
  writeFileSync(getStorePath(), JSON.stringify(records, null, 2), "utf8");
}

function normalizeDirectoryPath(input: string): string {
  const candidate = resolve(input.trim());
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error("知识库来源必须是存在的目录");
  }
  return realpathSync(candidate);
}

function makeSource(path: string, label?: string): KnowledgeBaseSource {
  const normalized = normalizeDirectoryPath(path);
  return {
    id: randomUUID(),
    type: "directory",
    path: normalized,
    label: label?.trim() || basename(normalized) || normalized,
    createdAt: Date.now(),
  };
}

export function listKnowledgeBases(): KnowledgeBaseRecord[] {
  return readRecords()
    .map((record) => ({
      ...record,
      sources: [...record.sources],
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createKnowledgeBase(input: {
  name: string;
  description?: string;
  sourcePaths?: string[];
  /** 可选：与工作区的弱关联（刀 3，仅用于未挂库时荐库，不自动挂载） */
  relatedWorkspaceIds?: string[];
}): KnowledgeBaseRecord {
  const name = input.name.trim();
  if (!name) throw new Error("知识库名称不能为空");
  const paths = Array.from(
    new Set(
      (input.sourcePaths ?? [])
        .map((path) => normalizeDirectoryPath(path))
        .filter(Boolean),
    ),
  );
  const relatedWorkspaceIds = normalizeRelatedWorkspaceIds(
    input.relatedWorkspaceIds,
  );
  const now = Date.now();
  const record: KnowledgeBaseRecord = {
    id: randomUUID(),
    name,
    ...(input.description?.trim()
      ? { description: input.description.trim() }
      : {}),
    sources: paths.map((path) => makeSource(path)),
    ...(relatedWorkspaceIds.length > 0 ? { relatedWorkspaceIds } : {}),
    createdAt: now,
    updatedAt: now,
  };
  writeRecords([...readRecords(), record]);
  return record;
}

/**
 * 规范化关联工作区 id 列表：trim、去重、去空（保留顺序）。
 * 纯函数，便于单测。
 */
export function normalizeRelatedWorkspaceIds(
  ids: string[] | undefined,
): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * 更新全局知识库元数据（刀 3：名称 / 描述 / 关联工作区）。
 * 全部字段可选：仅传需要改的字段；未传字段保持原值。
 * - name：trim 后非空，否则抛错。
 * - description：传入字符串则覆盖（trim 后空串 → 清除）；不传则保留。
 * - relatedWorkspaceIds：传入数组则覆盖（normalize 去重）；不传则保留。
 * 返回更新后的记录（含 sources 副本）。
 */
export function updateKnowledgeBase(input: {
  id: string;
  name?: string;
  description?: string;
  relatedWorkspaceIds?: string[];
}): KnowledgeBaseRecord {
  const records = readRecords();
  const record = records.find((item) => item.id === input.id);
  if (!record) throw new Error("知识库不存在");
  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!name) throw new Error("知识库名称不能为空");
    record.name = name;
  }
  if (typeof input.description === "string") {
    const description = input.description.trim();
    if (description) {
      record.description = description;
    } else {
      delete record.description;
    }
  }
  if (Array.isArray(input.relatedWorkspaceIds)) {
    const relatedWorkspaceIds = normalizeRelatedWorkspaceIds(
      input.relatedWorkspaceIds,
    );
    if (relatedWorkspaceIds.length > 0) {
      record.relatedWorkspaceIds = relatedWorkspaceIds;
    } else {
      delete record.relatedWorkspaceIds;
    }
  }
  record.updatedAt = Date.now();
  writeRecords(records);
  return { ...record, sources: [...record.sources] };
}

export function deleteKnowledgeBase(id: string): boolean {
  const before = readRecords();
  const next = before.filter((record) => record.id !== id);
  if (next.length === before.length) return false;
  writeRecords(next);
  return true;
}

export function addKnowledgeBaseSource(
  id: string,
  path: string,
): KnowledgeBaseRecord {
  const records = readRecords();
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error("知识库不存在");
  const normalized = normalizeDirectoryPath(path);
  if (!record.sources.some((source) => source.path === normalized)) {
    record.sources.push(makeSource(normalized));
    record.updatedAt = Date.now();
    writeRecords(records);
  }
  return record;
}

export function removeKnowledgeBaseSource(
  id: string,
  sourceId: string,
): KnowledgeBaseRecord {
  const records = readRecords();
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error("知识库不存在");
  record.sources = record.sources.filter((source) => source.id !== sourceId);
  record.updatedAt = Date.now();
  writeRecords(records);
  return record;
}

/** 解析多个全局知识库 ID 为当前检索引擎使用的目录路径。 */
export function resolveKnowledgeBaseRoots(ids: string[] | undefined): string[] {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const records = readRecords();
  const selected = new Set(ids);
  return Array.from(
    new Set(
      records
        .filter((record) => selected.has(record.id))
        .flatMap((record) => record.sources.map((source) => source.path)),
    ),
  );
}

/** 新模型优先；旧会话没有 knowledgeBaseIds 时继续使用 kbRoots。 */
export function resolveKnowledgeBaseRootsForSession(input: {
  knowledgeBaseIds?: string[];
  kbRoots?: string[];
}): string[] {
  if (Array.isArray(input.knowledgeBaseIds)) {
    return resolveKnowledgeBaseRoots(input.knowledgeBaseIds);
  }
  return Array.isArray(input.kbRoots) ? input.kbRoots : [];
}
