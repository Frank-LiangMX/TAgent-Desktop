/**
 * 知识库正式文档存储。
 *
 * 文档是知识库的第一等对象；当前保存 Markdown 正文，后续可扩展来源和版本信息。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { unzipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import type { KnowledgeBaseDocument } from "@tagent/shared";
import {
  isKnowledgeBaseDocumentKind,
  normalizeKnowledgeBaseDocumentKind,
} from "@tagent/shared";
import { getConfigDir } from "../config/config-paths";
import { tryReadDocumentWithOfficeCli } from "./officecli-adapter";
import { listKnowledgeBases } from "./knowledge-base-store";
import {
  clampSearchLimit,
  scoreKeywordHits,
  tokenize,
} from "./kb-search-score";
import {
  cloudProviderLabel,
  extractCloudDocumentUrl,
  parseCloudDocumentReference,
} from "./cloud-document-adapter";
import { splitKnowledgeDocument } from "./kb-chunking";

const STORE_FILE = "knowledge-base-documents.json";

function storePath(): string {
  return join(getConfigDir(), STORE_FILE);
}

function readDocuments(): KnowledgeBaseDocument[] {
  if (!existsSync(storePath())) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is KnowledgeBaseDocument =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as KnowledgeBaseDocument).id === "string" &&
        typeof (item as KnowledgeBaseDocument).knowledgeBaseId === "string" &&
        typeof (item as KnowledgeBaseDocument).title === "string" &&
        typeof (item as KnowledgeBaseDocument).content === "string",
    );
  } catch {
    return [];
  }
}

function writeDocuments(documents: KnowledgeBaseDocument[]): void {
  writeFileSync(storePath(), JSON.stringify(documents, null, 2), "utf8");
}

function ensureKnowledgeBase(id: string): void {
  if (!listKnowledgeBases().some((item) => item.id === id)) {
    throw new Error("知识库不存在");
  }
}

export function listKnowledgeBaseDocuments(
  knowledgeBaseId: string,
  query?: string,
): KnowledgeBaseDocument[] {
  ensureKnowledgeBase(knowledgeBaseId);
  const normalized = query?.trim().toLowerCase() ?? "";
  return readDocuments()
    .filter((document) => {
      if (document.knowledgeBaseId !== knowledgeBaseId) return false;
      if (!normalized) return true;
      return (
        document.title.toLowerCase().includes(normalized) ||
        document.content.toLowerCase().includes(normalized)
      );
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 按 id 读取单篇正式文档（不做 query 过滤；检索层自己打分）。
 * 不校验知识库是否存在：文档要么存在要么 undefined，调用方再做会话级授权校验。
 */
export function getKnowledgeBaseDocument(
  id: string,
): KnowledgeBaseDocument | undefined {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!trimmed) return undefined;
  return readDocuments().find((document) => document.id === trimmed);
}

/**
 * 列出多个知识库下的全部正式文档（不做 query 过滤，检索层自己打分）。
 * 用于 Agent 检索统一数据源：会话绑定的 knowledgeBaseIds → 候选文档集。
 * 不校验知识库是否存在：仅返回确实存在且属于给定 ids 的文档。
 */
export function listKnowledgeBaseDocumentsForIds(
  knowledgeBaseIds: string[],
): KnowledgeBaseDocument[] {
  const ids = new Set(
    (Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds : [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean),
  );
  if (ids.size === 0) return [];
  return readDocuments()
    .filter((document) => ids.has(document.knowledgeBaseId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** kb_search 文档命中（与目录命中同构，供 tools 层合并） */
export interface KbDocumentSearchHit {
  knowledgeBaseId: string;
  documentId: string;
  title: string;
  score: number;
  excerpt: string;
  matchedIn: "title" | "body" | "both";
  /** 文档类型标注（缺省归一为 note）；directory 命中无此字段 */
  kind: KnowledgeBaseDocument["kind"];
  chunkId?: string;
  section?: string;
  sourcePosition?: { startLine: number; endLine: number };
}

/**
 * 在给定知识库内对正式文档做关键词检索（与 fs-index 同类打分，P1-1 §B）。
 * 不做 query 过滤的子串匹配，而是用 tokenize + scoreKeywordHits，保证与目录命中可比、可合并排序。
 * @param input.knowledgeBaseIds 授权检索的知识库 id（会话绑定）
 * @param input.query 查询关键词
 * @param input.limit 返回上限（默认 10，上限 50）
 */
export function searchKnowledgeBaseDocuments(input: {
  knowledgeBaseIds: string[];
  query: string;
  limit?: number;
}): KbDocumentSearchHit[] {
  const ids = new Set(
    (Array.isArray(input?.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean),
  );
  if (ids.size === 0) return [];
  const keywords = tokenize(input?.query ?? "");
  if (keywords.length === 0) return [];
  const limit = clampSearchLimit(input?.limit);
  const hits: KbDocumentSearchHit[] = [];
  for (const document of readDocuments()) {
    if (!ids.has(document.knowledgeBaseId)) continue;
    const chunks = splitKnowledgeDocument({
      documentId: document.id,
      title: document.title,
      content: document.content,
    });
    for (const chunk of chunks) {
      const scored = scoreKeywordHits(document.title, chunk.content, keywords);
      if (!scored) continue;
      hits.push({
        knowledgeBaseId: document.knowledgeBaseId,
        documentId: document.id,
        title: document.title,
        score: scored.score,
        excerpt: scored.excerpt,
        matchedIn: scored.matchedIn,
        kind: normalizeKnowledgeBaseDocumentKind(document.kind),
        chunkId: chunk.id,
        ...(chunk.section ? { section: chunk.section } : {}),
        sourcePosition: { startLine: chunk.startLine, endLine: chunk.endLine },
      });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      (a.sourcePosition?.startLine ?? 0) - (b.sourcePosition?.startLine ?? 0),
  );
  return hits.slice(0, limit);
}

export function createKnowledgeBaseDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content?: string;
  /** 文档类型标注；非法 / 缺省 → 不写入（读取时归一为 note） */
  kind?: KnowledgeBaseDocument["kind"];
  /** snapshot 探查时间（epoch ms）；建议 snapshot 类写入 */
  snapshotAt?: number;
  /** 沉淀来源备注（如「由会话确认沉淀」） */
  originNote?: string;
  /** 结构化草稿确认入库后保留的可追溯元数据。 */
  summary?: string;
  sources?: NonNullable<KnowledgeBaseDocument["sources"]>;
  parseWarnings?: string[];
  uncertainties?: string[];
  author?: KnowledgeBaseDocument["author"];
  status?: KnowledgeBaseDocument["status"];
  sourceUrl?: string;
  sourceProvider?: KnowledgeBaseDocument["sourceProvider"];
  sourceExternalId?: string;
  sourceAccessMode?: KnowledgeBaseDocument["sourceAccessMode"];
  sourceSyncedAt?: number;
}): KnowledgeBaseDocument {
  ensureKnowledgeBase(input.knowledgeBaseId);
  const title = input.title.trim();
  if (!title) throw new Error("文档标题不能为空");
  const now = Date.now();
  const document: KnowledgeBaseDocument = {
    id: randomUUID(),
    knowledgeBaseId: input.knowledgeBaseId,
    title,
    content: input.content ?? "",
    ...(isKnowledgeBaseDocumentKind(input.kind) ? { kind: input.kind } : {}),
    ...(typeof input.snapshotAt === "number" && Number.isFinite(input.snapshotAt)
      ? { snapshotAt: input.snapshotAt }
      : {}),
    ...(typeof input.originNote === "string" && input.originNote.trim()
      ? { originNote: input.originNote.trim() }
      : {}),
    ...(typeof input.summary === "string" && input.summary.trim()
      ? { summary: input.summary.trim() }
      : {}),
    ...(Array.isArray(input.sources) && input.sources.length > 0
      ? { sources: input.sources }
      : {}),
    ...(Array.isArray(input.parseWarnings) && input.parseWarnings.length > 0
      ? { parseWarnings: input.parseWarnings }
      : {}),
    ...(Array.isArray(input.uncertainties) && input.uncertainties.length > 0
      ? { uncertainties: input.uncertainties }
      : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sourceProvider ? { sourceProvider: input.sourceProvider } : {}),
    ...(input.sourceExternalId ? { sourceExternalId: input.sourceExternalId } : {}),
    ...(input.sourceAccessMode ? { sourceAccessMode: input.sourceAccessMode } : {}),
    ...(input.sourceSyncedAt ? { sourceSyncedAt: input.sourceSyncedAt } : {}),
    createdAt: now,
    updatedAt: now,
  };
  writeDocuments([...readDocuments(), document]);
  return document;
}

export function updateKnowledgeBaseDocument(input: {
  id: string;
  title: string;
  content: string;
  /** 可选：覆盖文档类型标注；非法值忽略，保留原值 */
  kind?: KnowledgeBaseDocument["kind"];
  /** 可选：覆盖 snapshot 探查时间 */
  snapshotAt?: number;
  /** 可选：覆盖沉淀来源备注 */
  originNote?: string;
  /** 可选：覆盖结构化知识草稿元数据。 */
  summary?: string;
  sources?: NonNullable<KnowledgeBaseDocument["sources"]>;
  parseWarnings?: string[];
  uncertainties?: string[];
  author?: KnowledgeBaseDocument["author"];
  status?: KnowledgeBaseDocument["status"];
}): KnowledgeBaseDocument {
  const documents = readDocuments();
  const index = documents.findIndex((document) => document.id === input.id);
  if (index < 0) throw new Error("文档不存在");
  const title = input.title.trim();
  if (!title) throw new Error("文档标题不能为空");
  const current = documents[index];
  if (!current) throw new Error("文档不存在");
  const updated: KnowledgeBaseDocument = {
    ...current,
    title,
    content: input.content,
    updatedAt: Date.now(),
  };
  // kind / snapshotAt / originNote：仅在传入合法值时覆盖，否则保留原值（不清空）。
  if (isKnowledgeBaseDocumentKind(input.kind)) updated.kind = input.kind;
  if (typeof input.snapshotAt === "number" && Number.isFinite(input.snapshotAt)) {
    updated.snapshotAt = input.snapshotAt;
  }
  if (typeof input.originNote === "string" && input.originNote.trim()) {
    updated.originNote = input.originNote.trim();
  }
  if (typeof input.summary === "string" && input.summary.trim()) {
    updated.summary = input.summary.trim();
  }
  if (Array.isArray(input.sources)) updated.sources = input.sources;
  if (Array.isArray(input.parseWarnings)) updated.parseWarnings = input.parseWarnings;
  if (Array.isArray(input.uncertainties)) updated.uncertainties = input.uncertainties;
  if (input.author) updated.author = input.author;
  if (input.status) updated.status = input.status;
  documents[index] = updated;
  writeDocuments(documents);
  return updated;
}

export function deleteKnowledgeBaseDocument(id: string): boolean {
  const documents = readDocuments();
  const next = documents.filter((document) => document.id !== id);
  if (next.length === documents.length) return false;
  writeDocuments(next);
  return true;
}

export function deleteKnowledgeBaseDocumentsForKnowledgeBase(
  knowledgeBaseId: string,
): void {
  const documents = readDocuments();
  const next = documents.filter(
    (document) => document.knowledgeBaseId !== knowledgeBaseId,
  );
  if (next.length !== documents.length) writeDocuments(next);
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}



function zipPath(pathValue: string): string {
  const parts = pathValue.replace(/^\/+/, '').split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/')
}
function xmlAttribute(tag: string, name: string): string {
  const double = new RegExp(name + '[ ]*=[ ]*"([^"]*)"').exec(tag)
  if (double?.[1] !== undefined) return decodeXml(double[1])
  const single = new RegExp(name + "[ ]*=[ ]*'([^']*)'").exec(tag)
  return single?.[1] !== undefined ? decodeXml(single[1]) : ''
}
function xmlText(fragment: string): string {
  return decodeXml(fragment.replace(/<[^>]+>/g, ''))
}
export function extractXlsxSheets(buffer: Uint8Array): Array<{ name: string; content: string }> {
  const files = unzipSync(buffer)
  const workbookBytes = files['xl/workbook.xml']
  if (!workbookBytes) throw new Error('XLSX 中没有找到工作簿')
  const workbook = new TextDecoder().decode(workbookBytes)
  const relationships = new Map<string, string>()
  const relsBytes = files['xl/_rels/workbook.xml.rels']
  if (relsBytes) {
    for (const match of new TextDecoder().decode(relsBytes).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = xmlAttribute(match[0], 'Id')
      const target = xmlAttribute(match[0], 'Target')
      if (id && target) relationships.set(id, target)
    }
  }
  const sharedStrings: string[] = []
  const sharedBytes = files['xl/sharedStrings.xml']
  if (sharedBytes) {
    for (const match of new TextDecoder().decode(sharedBytes).matchAll(/<si\b[\s\S]*?<\/si>/g)) {
      sharedStrings.push([...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => item[1] || '').join(''))
    }
  }
  const cellValue = (cell: string, type: string): string => {
    const inline = [...cell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => item[1] || '').join('')
    const raw = type === 'inlineStr' ? inline : (/<v\b[^>]*>([\s\S]*?)<\/v>/g.exec(cell)?.[1] || '')
    if (!raw && type !== 'inlineStr') {
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/g.exec(cell)?.[1]
      return formula ? '=' + xmlText(formula) : ''
    }
    const decoded = xmlText(raw)
    if (type === 's') return sharedStrings[Number(decoded)] || ''
    if (type === 'b') return decoded === '1' ? 'TRUE' : 'FALSE'
    return decoded
  }
  const tableForSheet = (sheetXml: string): string => {
    const rows = new Map<number, Map<number, string>>()
    let fallbackRow = 0
    for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowTag = rowMatch[0].slice(0, rowMatch[0].indexOf('>') + 1)
      const rowNumber = Number(xmlAttribute(rowTag, 'r')) || fallbackRow + 1
      fallbackRow = rowNumber
      const values = new Map<number, string>()
      let fallbackColumn = 0
      for (const cellMatch of (rowMatch[1] || '').matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cellMatch[1] || ''
        const ref = xmlAttribute(attributes, 'r')
        const letters = ref.match(/^[A-Za-z]+/)?.[0] || ''
        let column = 0
        for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
        column = Math.max(1, column || fallbackColumn + 1)
        fallbackColumn = column
        values.set(column, cellValue(cellMatch[2] || '', xmlAttribute(attributes, 't')))
      }
      if (values.size) rows.set(rowNumber, values)
    }
    const orderedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, values]) => values)
    if (!orderedRows.length) return ''
    const width = Math.max(...orderedRows.map((row) => Math.max(...row.keys())))
    const escape = (value: string): string => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
    const matrix = orderedRows.map((row) => Array.from({ length: width }, (_, index) => escape(row.get(index + 1) || '')))
    const lines = matrix.map((row) => '| ' + row.join(' | ') + ' |')
    lines.splice(1, 0, '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |')
    return lines.join('\n')
  }
  const results: Array<{ name: string; content: string }> = []
  for (const sheetMatch of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const sheetTag = sheetMatch[0]
    const name = xmlAttribute(sheetTag, 'name') || '工作表'
    const relationId = xmlAttribute(sheetTag, 'r:id') || xmlAttribute(sheetTag, 'id')
    const target = relationships.get(relationId)
    if (!target) continue
    const sheetBytes = files[zipPath(target.startsWith('/') ? target : 'xl/' + target)]
    if (!sheetBytes) continue
    const content = tableForSheet(new TextDecoder().decode(sheetBytes))
    if (content) results.push({ name, content })
  }
  if (!results.length) throw new Error('XLSX 中没有可导入的工作表内容')
  return results
}
export function extractDocxText(buffer: Uint8Array): string {
  const files = unzipSync(buffer);
  const xmlBytes = files["word/document.xml"];
  if (!xmlBytes) throw new Error("DOCX 中没有找到正文");
  const xml = new TextDecoder().decode(xmlBytes);
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs
    .map((paragraph) =>
      decodeXml(
        paragraph
          .replace(/<w:tab\s*\/?>/g, "\t")
          .replace(/<w:br\s*\/?>/g, "\n")
          .replace(/<w:cr\s*\/?>/g, "\n")
          .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, "$1")
          .replace(/<[^>]+>/g, ""),
      ).trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}


export async function extractPdfText(buffer: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: buffer,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .filter(Boolean)
          .join(" "),
      );
    }
  } finally {
    await document.destroy();
  }
  return pages.filter(Boolean).join("\n\n");
}

// ── 附件 / 来源材料解析（统一中间格式，零写入）──────────────
//
// 主线第一步：让 Agent 能读取当前会话刚上传的附件，用于后续整理成结构化知识草稿。
// 这里只做「文件 → 结构化中间格式」，不写知识库、不自动保存；写入仍走 createKnowledgeBaseDocument
// 且必须经 kb_propose_save 用户确认（见 kb-agent-tools.ts）。
//
// 复用已有 DOCX/PDF/XLSX 解析逻辑（extractDocxText / extractPdfText / extractXlsxSheets），
// 不走 officecli 子进程：附件读取要求快、可单测，且产品决策不追求原样高保真还原
// （见 KB-DESIGN-DECISION.md「明确不做」）。officecli 仅留作正式导入的高保真回退。
// XLSX 保留各工作表名与各表内容（markdown 表格），不混入页面参数 / HTML / CSS。

/** kb_read_attachment / parseAttachmentFile 支持的附件扩展名 */
const SUPPORTED_ATTACHMENT_EXTS = new Set([
  ".docx",
  ".pdf",
  ".xlsx",
  ".md",
  ".markdown",
  ".txt",
  ".csv",
]);

/** 附件扩展名 → 标准 mediaType（结果回传用；未知回落 octet-stream） */
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

/** 附件正文字符上限：超过即截断并在 warnings 明确告知（不静默截断） */
const MAX_ATTACHMENT_TEXT_CHARS = 256 * 1024;
/** XLSX 单个工作表字符上限：同上，每表独立截断并告警 */
const MAX_SHEET_CONTENT_CHARS = 64 * 1024;

/** 解析后的单个工作表（保留表名与内容；过大时截断并标记） */
export interface ParsedSourceSheet {
  name: string;
  content: string;
  /** 该表内容是否被截断 */
  truncated: boolean;
  /** 截断前原始字符数（未截断时等于 content.length） */
  originalLength: number;
}

/** 附件 / 来源材料解析中间格式（零写入，供 Agent 整理草稿） */
export interface ParsedSourceContent {
  /** 统一文本（docx/pdf/md/txt/csv）；xlsx 时空串 */
  content: string;
  /** content 是否被截断 */
  truncated: boolean;
  /** content 截断前原始字符数（未截断时等于 content.length） */
  originalLength: number;
  /** xlsx 工作表（保留多表名与各表内容）；非 xlsx 时空数组 */
  sheets: ParsedSourceSheet[];
  /** 解析告警（截断 / 空内容等），不静默截断 */
  warnings: string[];
}

/** 判断扩展名是否为 kb_read_attachment 支持的附件格式 */
export function isSupportedAttachmentExt(ext: string): boolean {
  return SUPPORTED_ATTACHMENT_EXTS.has(
    typeof ext === "string" ? ext.toLowerCase() : "",
  );
}

/** 附件扩展名 → mediaType；未知回落 application/octet-stream */
export function attachmentMediaType(ext: string): string {
  return (
    ATTACHMENT_MEDIA_TYPES[typeof ext === "string" ? ext.toLowerCase() : ""] ??
    "application/octet-stream"
  );
}

/**
 * 把附件 / 来源文件解析为统一中间格式（零写入）。
 *
 * - .docx → extractDocxText（段落正文）
 * - .pdf  → extractPdfText（pdfjs 文本层）
 * - .xlsx → extractXlsxSheets（各工作表名 + markdown 表格，保留多表）
 * - .md/.markdown/.txt/.csv → utf8 文本
 * - 其它扩展名 / 空内容 → 抛错（由调用方转为 error JSON，不伪造结果）
 *
 * 过大内容截断时在 warnings 明确告知，绝不静默截断。
 */
export async function parseAttachmentFile(
  filePath: string,
): Promise<ParsedSourceContent> {
  const ext = extname(filePath).toLowerCase();
  if (!isSupportedAttachmentExt(ext)) {
    throw new Error(
      `不支持的附件格式：${ext || "无扩展名"}（kb_read_attachment 支持 .docx / .pdf / .xlsx / .md / .markdown / .txt / .csv）`,
    );
  }
  const buffer = readFileSync(filePath);
  const warnings: string[] = [];

  if (ext === ".xlsx") {
    const rawSheets = extractXlsxSheets(buffer); // 无工作簿 / 无内容时抛错
    const sheets: ParsedSourceSheet[] = rawSheets.map((sheet) => {
      const originalLength = sheet.content.length;
      if (originalLength > MAX_SHEET_CONTENT_CHARS) {
        warnings.push(
          `工作表「${sheet.name}」内容过长（${originalLength} 字符），已截断至前 ${MAX_SHEET_CONTENT_CHARS} 字符以便整理；如需完整内容请分段说明。`,
        );
        return {
          name: sheet.name,
          content: sheet.content.slice(0, MAX_SHEET_CONTENT_CHARS),
          truncated: true,
          originalLength,
        };
      }
      return {
        name: sheet.name,
        content: sheet.content,
        truncated: false,
        originalLength,
      };
    });
    return {
      content: "",
      truncated: false,
      originalLength: 0,
      sheets,
      warnings,
    };
  }

  let content: string;
  if (ext === ".docx") {
    content = extractDocxText(buffer);
  } else if (ext === ".pdf") {
    content = await extractPdfText(buffer);
  } else {
    // .md / .markdown / .txt / .csv：utf8 文本
    content = buffer.toString("utf8");
  }
  content = content.replace(/\r\n/g, "\n").trim();
  if (!content) {
    throw new Error(
      ext === ".pdf"
        ? "PDF 没有可提取文本，可能是扫描件；当前暂不支持 OCR"
        : "文件中没有可提取的文本内容",
    );
  }
  const originalLength = content.length;
  if (originalLength > MAX_ATTACHMENT_TEXT_CHARS) {
    warnings.push(
      `附件正文过长（${originalLength} 字符），已截断至前 ${MAX_ATTACHMENT_TEXT_CHARS} 字符以便整理；如需完整内容请分段说明。`,
    );
    return {
      content: content.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
      truncated: true,
      originalLength,
      sheets: [],
      warnings,
    };
  }
  return {
    content,
    truncated: false,
    originalLength,
    sheets: [],
    warnings,
  };
}

const MAX_REMOTE_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 5;

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (normalized.startsWith("10.") || normalized.startsWith("192.168."))
    return true;
  if (normalized.startsWith("169.254.") || normalized.startsWith("0."))
    return true;
  const octets = normalized.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets[0] === 172 &&
    octets[1] !== undefined &&
    octets[1] >= 16 &&
    octets[1] <= 31
  ) {
    return true;
  }
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.")
  );
}

async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  const cleaned = extractCloudDocumentUrl(rawUrl);
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)
    ? cleaned
    : "https://" + cleaned;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Invalid cloud document URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https document URLs are supported");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Local addresses are not allowed");
  }
  const records = await lookup(hostname, { all: true });
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("Private network addresses are not allowed");
  }
  return url;
}

async function readRemoteBytes(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REMOTE_DOCUMENT_BYTES) {
    throw new Error("Cloud document exceeds the 20 MB limit");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_DOCUMENT_BYTES) {
      throw new Error("Cloud document exceeds the 20 MB limit");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > MAX_REMOTE_DOCUMENT_BYTES) {
        throw new Error("Cloud document exceeds the 20 MB limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function remoteExtension(
  url: URL,
  contentType: string,
  provider: ReturnType<typeof parseCloudDocumentReference>["provider"] = "unknown",
): string {
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("pdf")) return ".pdf";
  if (normalizedType.includes("wordprocessingml.document")) return ".docx";
  if (normalizedType.includes("application/msword")) return ".doc";
  if (normalizedType.includes("text/markdown")) return ".md";
  if (normalizedType.startsWith("text/plain")) return ".txt";
  const pathExtension = extname(url.pathname).toLowerCase();
  if (
    [".doc", ".docx", ".pdf", ".md", ".markdown", ".txt"].includes(
      pathExtension,
    )
  ) {
    return pathExtension;
  }
  if (normalizedType.includes("text/html")) {
    if (provider !== "unknown") {
      throw new Error(
        `${cloudProviderLabel(provider)}分享链接需要平台授权才能读取正文；请先连接账号，或下载为 DOCX/PDF 后导入`,
      );
    }
    throw new Error("云文档链接返回的是网页预览页，请提供直接下载地址");
  }
  throw new Error("Unsupported cloud document format");
}

async function fetchRemoteDocument(rawUrl: string): Promise<{
  url: string;
  bytes: Uint8Array;
  contentType: string;
}> {
  let current = rawUrl;
  for (let redirect = 0; redirect <= MAX_REMOTE_REDIRECTS; redirect += 1) {
    const url = await assertSafeRemoteUrl(current);
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "TAgent-KnowledgeBase/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid redirect location");
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(
        "Cloud document download failed (HTTP " + response.status + ")",
      );
    }
    return {
      url: url.toString(),
      bytes: await readRemoteBytes(response),
      contentType: response.headers.get("content-type") ?? "",
    };
  }
  throw new Error("Too many cloud document redirects");
}

function titleFromRemoteUrl(url: URL, extension: string): string {
  const lastSegment = url.pathname.split("/").filter(Boolean).pop();
  if (!lastSegment) return "Cloud document";
  try {
    const decoded = decodeURIComponent(lastSegment);
    const title = decoded.endsWith(extension)
      ? decoded.slice(0, -extension.length)
      : decoded;
    return title.trim() || "Cloud document";
  } catch {
    return "Cloud document";
  }
}

export async function importKnowledgeBaseDocumentFromUrl(input: {
  knowledgeBaseId: string;
  url: string;
  title?: string;
}): Promise<KnowledgeBaseDocument> {
  ensureKnowledgeBase(input.knowledgeBaseId);
  const reference = parseCloudDocumentReference(input.url);
  const remote = await fetchRemoteDocument(reference.sourceUrl);
  const remoteUrl = new URL(remote.url);
  const extension = remoteExtension(remoteUrl, remote.contentType, reference.provider);
  const fallbackTitle =
    input.title?.trim() || titleFromRemoteUrl(remoteUrl, extension);
  if ([".doc", ".docx", ".pdf", ".xls"].includes(extension)) {
    const tempDirectory = mkdtempSync(join(tmpdir(), "tagent-kb-"));
    const tempFile = join(tempDirectory, "document" + extension);
    writeFileSync(tempFile, Buffer.from(remote.bytes));
    try {
      return await importKnowledgeBaseDocument({
        knowledgeBaseId: input.knowledgeBaseId,
        filePath: tempFile,
        title: fallbackTitle,
        sourceUrl: reference.sourceUrl,
        sourceProvider: reference.provider,
        sourceExternalId: reference.externalId,
        sourceAccessMode: "public",
        sourceSyncedAt: Date.now(),
      });
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
  const content = new TextDecoder()
    .decode(remote.bytes)
    .replace(/\r\n/g, "\n")
    .trim();
  if (!content) throw new Error("Cloud document has no text content");
  return createKnowledgeBaseDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    title: fallbackTitle,
    content,
    sourceUrl: reference.sourceUrl,
    sourceProvider: reference.provider,
    sourceExternalId: reference.externalId,
    sourceAccessMode: "public",
    sourceSyncedAt: Date.now(),
  });
}



export async function importKnowledgeBaseDocuments(input: {
  knowledgeBaseId: string;
  filePath: string;
  title?: string;
  sourceUrl?: string;
  sourceProvider?: KnowledgeBaseDocument["sourceProvider"];
  sourceExternalId?: string;
  sourceAccessMode?: KnowledgeBaseDocument["sourceAccessMode"];
  sourceSyncedAt?: number;
}): Promise<KnowledgeBaseDocument[]> {
  ensureKnowledgeBase(input.knowledgeBaseId)
  const extension = extname(input.filePath).toLowerCase()
  if (extension !== '.xlsx') return [await importKnowledgeBaseDocument(input)]
  const sheets = extractXlsxSheets(readFileSync(input.filePath))
  const baseTitle = input.title?.trim() || basename(input.filePath, extension)
  return sheets.map((sheet) => createKnowledgeBaseDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    title: baseTitle + '｜' + sheet.name,
    content: sheet.content,
    sourceUrl: input.sourceUrl,
    sourceProvider: input.sourceProvider,
    sourceExternalId: input.sourceExternalId,
    sourceAccessMode: input.sourceAccessMode,
    sourceSyncedAt: input.sourceSyncedAt,
    originNote: '原始工作簿：' + baseTitle + '；工作表：' + sheet.name,
  }))
}


export async function importKnowledgeBaseDocument(input: {
  knowledgeBaseId: string;
  filePath: string;
  title?: string;
  sourceUrl?: string;
  sourceProvider?: KnowledgeBaseDocument["sourceProvider"];
  sourceExternalId?: string;
  sourceAccessMode?: KnowledgeBaseDocument["sourceAccessMode"];
  sourceSyncedAt?: number;
}): Promise<KnowledgeBaseDocument> {
  ensureKnowledgeBase(input.knowledgeBaseId);
  const extension = extname(input.filePath).toLowerCase();
  if (
    ![".doc", ".docx", ".pdf", ".xls", ".md", ".markdown", ".txt"].includes(extension)
  ) {
    throw new Error(
      "\u652f\u6301\u5bfc\u5165 .doc\u3001.docx\u3001.pdf\u3001.md\u3001.markdown \u548c .txt \u6587\u4ef6",
    );
  }
  const buffer = readFileSync(input.filePath);
  let content: string;
  if ([".doc", ".docx", ".pdf"].includes(extension)) {
    content = (await tryReadDocumentWithOfficeCli(input.filePath)) ?? "";
  } else {
    content = "";
  }
  if (!content && extension === ".docx") {
    content = extractDocxText(buffer);
  } else if (!content && extension === ".pdf") {
    content = await extractPdfText(buffer);
  } else if (!content && extension === ".doc") {
    throw new Error(
      "\u65e7\u7248 .doc \u9700\u8981\u5b89\u88c5 OfficeCLI \u7684\u5bf9\u5e94\u63d2\u4ef6\uff0c\u6216\u5148\u53e6\u5b58\u4e3a .docx",
    );
  } else if (!content && extension === ".xls") {
    throw new Error(
      "XLS \u6587\u4ef6\u9700\u8981 OfficeCLI \u5b89\u88c5\u5bf9\u5e94\u63d2\u4ef6\uff0c\u6216\u53e6\u5b58\u4e3a .xlsx",
    );
  } else if (!content) {
    content = buffer.toString("utf8");
  }
  content = content.replace(/\r\n/g, "\n").trim();
  if (!content) {
    throw new Error(
      extension === ".pdf"
        ? "PDF 没有可提取文本，可能是扫描件；当前暂不支持 OCR"
        : "文件中没有可导入的文本内容",
    );
  }
  return createKnowledgeBaseDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    title: input.title?.trim() || basename(input.filePath, extension),
    content,
    sourceUrl: input.sourceUrl,
    sourceProvider: input.sourceProvider,
    sourceExternalId: input.sourceExternalId,
    sourceAccessMode: input.sourceAccessMode,
    sourceSyncedAt: input.sourceSyncedAt,
  });
}
