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
  const now = Date.now();
  const record: KnowledgeBaseRecord = {
    id: randomUUID(),
    name,
    ...(input.description?.trim()
      ? { description: input.description.trim() }
      : {}),
    sources: paths.map((path) => makeSource(path)),
    createdAt: now,
    updatedAt: now,
  };
  writeRecords([...readRecords(), record]);
  return record;
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
