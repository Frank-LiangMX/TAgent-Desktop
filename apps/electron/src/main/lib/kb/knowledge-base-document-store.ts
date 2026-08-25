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
import { getConfigDir } from "../config/config-paths";
import { tryReadDocumentWithOfficeCli } from "./officecli-adapter";
import { listKnowledgeBases } from "./knowledge-base-store";
import {
  cloudProviderLabel,
  extractCloudDocumentUrl,
  parseCloudDocumentReference,
} from "./cloud-document-adapter";

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

export function createKnowledgeBaseDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content?: string;
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

function extractDocxText(buffer: Uint8Array): string {
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

async function extractPdfText(buffer: Uint8Array): Promise<string> {
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
  if ([".doc", ".docx", ".pdf"].includes(extension)) {
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
    ![".doc", ".docx", ".pdf", ".md", ".markdown", ".txt"].includes(extension)
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
