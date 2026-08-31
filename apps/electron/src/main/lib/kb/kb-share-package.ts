/**
 * 知识库导出 / 导入分享包（刀 4）。
 *
 * 单库导出为瘦 JSON 分享包（{@link KnowledgeBaseSharePackage}），导入成**新库**（新 id）。
 *
 * 设计要点（见 KB-P1-8-SHARE-PACK-brief）：
 * - 不导出旧库 / 文档 id（导入一律新生成）；不导出 `relatedWorkspaceIds`（别人机器无意义）。
 * - 来源目录路径不保证可移植：导出可带 `{ label, path? }` 作参考，导入**默认不绑定目录**
 *   （避免绑到别人的盘符）；path 在本机是否存在不影响导入，仅保留正式文档。
 * - 云来源元数据（url / provider / externalId / accessMode / syncedAt）原样带上，无则省略。
 * - 不做 zip / 附件二进制、不合并同名库、不自动关联工作区、不加密。
 *
 * 纯函数 + 依赖 store 的 IO：便于单测在 `TAGENT_CONFIG_DIR` 临时目录下跑 roundtrip。
 *
 * @see docs/dev/knowledge-base/KB-P1-8-SHARE-PACK-brief.md
 */
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseRecord,
  KnowledgeBaseSharePackage,
  KnowledgeBaseSharePackageDocument,
} from "@tagent/shared";
import {
  KNOWLEDGE_BASE_SHARE_FORMAT,
  KNOWLEDGE_BASE_SHARE_VERSION,
  isKnowledgeBaseDocumentKind,
  isKnowledgeBaseSourceAccessMode,
  isKnowledgeBaseSourceProvider,
} from "@tagent/shared";
import { listKnowledgeBases, createKnowledgeBase } from "./knowledge-base-store";
import {
  createKnowledgeBaseDocument,
  listKnowledgeBaseDocuments,
} from "./knowledge-base-document-store";

/** 导出结果：成功时带写入用的 JSON 字符串，便于 IPC 层落盘；失败抛错 */
export interface BuildSharePackageResult {
  /** UTF-8 JSON 文本（2 空格缩进，便于审阅与单测） */
  json: string;
  package: KnowledgeBaseSharePackage;
}

/**
 * 构建知识库分享包（纯组装 + 序列化，不碰 dialog / 文件系统）。
 *
 * 不导出：库 id、文档 id、knowledgeBaseId、relatedWorkspaceIds、source.id、source.createdAt。
 * 保留：库 name/description、来源 { label, path? }（仅提示）、文档正文 + kind/snapshotAt/originNote/云字段。
 *
 * @param knowledgeBaseId 待导出的知识库 id
 * @throws 库不存在时抛「知识库不存在」
 */
export function buildKnowledgeBaseSharePackage(
  knowledgeBaseId: string,
): BuildSharePackageResult {
  const record = listKnowledgeBases().find((item) => item.id === knowledgeBaseId);
  if (!record) throw new Error("知识库不存在");
  const documents = listKnowledgeBaseDocuments(knowledgeBaseId);
  const pkg: KnowledgeBaseSharePackage = {
    format: KNOWLEDGE_BASE_SHARE_FORMAT,
    version: KNOWLEDGE_BASE_SHARE_VERSION,
    exportedAt: Date.now(),
    library: {
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      // 来源目录路径不保证可移植：仅带 label + path 作提示，导入默认不绑定。
      ...(record.sources.length > 0
        ? {
            sources: record.sources.map((source) => ({
              label: source.label,
              ...(source.path ? { path: source.path } : {}),
            })),
          }
        : {}),
    },
    documents: documents.map(toSharePackageDocument),
  };
  return { json: JSON.stringify(pkg, null, 2), package: pkg };
}

function toSharePackageDocument(
  doc: KnowledgeBaseDocument,
): KnowledgeBaseSharePackageDocument {
  return {
    title: doc.title,
    content: doc.content,
    ...(isKnowledgeBaseDocumentKind(doc.kind) ? { kind: doc.kind } : {}),
    ...(doc.summary ? { summary: doc.summary } : {}),
    ...(doc.sources ? { sources: doc.sources } : {}),
    ...(doc.parseWarnings ? { parseWarnings: doc.parseWarnings } : {}),
    ...(doc.uncertainties ? { uncertainties: doc.uncertainties } : {}),
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.status ? { status: doc.status } : {}),
    ...(typeof doc.snapshotAt === "number" && Number.isFinite(doc.snapshotAt)
      ? { snapshotAt: doc.snapshotAt }
      : {}),
    ...(typeof doc.originNote === "string" && doc.originNote.trim()
      ? { originNote: doc.originNote.trim() }
      : {}),
    ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
    ...(isKnowledgeBaseSourceProvider(doc.sourceProvider)
      ? { sourceProvider: doc.sourceProvider }
      : {}),
    ...(doc.sourceExternalId ? { sourceExternalId: doc.sourceExternalId } : {}),
    ...(isKnowledgeBaseSourceAccessMode(doc.sourceAccessMode)
      ? { sourceAccessMode: doc.sourceAccessMode }
      : {}),
    ...(typeof doc.sourceSyncedAt === "number" && doc.sourceSyncedAt
      ? { sourceSyncedAt: doc.sourceSyncedAt }
      : {}),
  };
}

/**
 * 导入知识库分享包：校验 format/version → 建新库（新 id）→ 逐条建文档。
 *
 * - 默认**不绑定来源目录**（即便 package.library.sources 带 path 且在本机存在）：
 *   避免把分享包绑到别人盘符；本轮仅保留正式文档。
 * - 非法文档项（非对象 / 无标题）跳过，不抛错；库必须有名。
 * - 文档 kind / 云字段仅当合法时透传，否则丢弃（防御坏包）。
 *
 * @returns 新建的知识库 record（含新 id）
 * @throws format 不匹配 / version 不支持 / 库名称为空
 */
export function importKnowledgeBaseSharePackage(
  raw: unknown,
): KnowledgeBaseRecord {
  const pkg = validateSharePackage(raw);
  const name = pkg.library.name.trim();
  if (!name) throw new Error("分享包库名称为空");

  // 默认不绑定目录：sourcePaths 留空。库 description 透传。
  const record = createKnowledgeBase({
    name,
    ...(pkg.library.description?.trim()
      ? { description: pkg.library.description.trim() }
      : {}),
  });

  // 文档来自不可信 JSON：validateSharePackage 只校验顶层结构，逐条字段用 typeof 运行时兜底。
  // item 类型是接口（TS 视为已定型），但运行时可能为任意形状，故每个字段都做 typeof 守卫。
  const documents = Array.isArray(pkg.documents) ? pkg.documents : [];
  for (const item of documents) {
    if (!item) continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue; // 非法文档项跳过，不阻断整包导入
    const content = typeof item.content === "string" ? item.content : "";
    createKnowledgeBaseDocument({
      knowledgeBaseId: record.id,
      title,
      content,
      ...(isKnowledgeBaseDocumentKind(item.kind) ? { kind: item.kind } : {}),
      ...(typeof item.summary === "string" && item.summary.trim()
        ? { summary: item.summary.trim() }
        : {}),
      ...(Array.isArray(item.sources) ? { sources: item.sources } : {}),
      ...(Array.isArray(item.parseWarnings) ? { parseWarnings: item.parseWarnings } : {}),
      ...(Array.isArray(item.uncertainties) ? { uncertainties: item.uncertainties } : {}),
      ...(item.author === "user" || item.author === "agent" ? { author: item.author } : {}),
      ...(item.status === "draft" || item.status === "confirmed" || item.status === "archived"
        ? { status: item.status }
        : {}),
      ...(typeof item.snapshotAt === "number" && Number.isFinite(item.snapshotAt)
        ? { snapshotAt: item.snapshotAt }
        : {}),
      ...(typeof item.originNote === "string" && item.originNote.trim()
        ? { originNote: item.originNote.trim() }
        : {}),
      ...(typeof item.sourceUrl === "string" && item.sourceUrl
        ? { sourceUrl: item.sourceUrl }
        : {}),
      ...(isKnowledgeBaseSourceProvider(item.sourceProvider)
        ? { sourceProvider: item.sourceProvider }
        : {}),
      ...(typeof item.sourceExternalId === "string" && item.sourceExternalId
        ? { sourceExternalId: item.sourceExternalId }
        : {}),
      ...(isKnowledgeBaseSourceAccessMode(item.sourceAccessMode)
        ? { sourceAccessMode: item.sourceAccessMode }
        : {}),
      ...(typeof item.sourceSyncedAt === "number" && item.sourceSyncedAt
        ? { sourceSyncedAt: item.sourceSyncedAt }
        : {}),
    });
  }
  return record;
}

/** 校验分享包顶层结构 + format/version，返回类型化的 package；不抛时已通过基础校验 */
function validateSharePackage(raw: unknown): KnowledgeBaseSharePackage {
  if (!raw || typeof raw !== "object") {
    throw new Error("分享包格式不正确：不是合法的 JSON 对象");
  }
  const pkg = raw as Record<string, unknown>;
  if (pkg.format !== KNOWLEDGE_BASE_SHARE_FORMAT) {
    throw new Error("分享包格式不正确（format 不匹配）");
  }
  if (pkg.version !== KNOWLEDGE_BASE_SHARE_VERSION) {
    throw new Error(`不支持的分享包版本：${String(pkg.version)}`);
  }
  const library = pkg.library;
  if (!library || typeof library !== "object") {
    throw new Error("分享包缺少库信息");
  }
  const lib = library as Record<string, unknown>;
  if (typeof lib.name !== "string") {
    throw new Error("分享包缺少库名称");
  }
  // exportedAt 仅要求是数字（不强校验范围）；documents 在导入循环里逐条容错。
  if (typeof pkg.exportedAt !== "number" || !Number.isFinite(pkg.exportedAt)) {
    throw new Error("分享包缺少导出时间");
  }
  return pkg as unknown as KnowledgeBaseSharePackage;
}
