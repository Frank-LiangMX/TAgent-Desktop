/**
 * 知识库文件系统索引（Phase 0 · 进程内只读检索）
 *
 * - 绑定根目录（kbRoots，绝对路径 0..N）下扫描 .md / .markdown / .txt
 * - 限制深度（默认 4）+ 单文件大小上限，忽略 node_modules / .git 等目录，跳过符号链接防穿越
 * - mtime 内存缓存（root 目录 mtime 失效文件列表；文件 mtime 失效正文缓存）
 * - 标题（首个 Markdown 标题 / 首个非空行 / 文件名）+ 正文关键词检索，命中带短摘录
 * - 按绑定 root 读取单文件，强制容器校验防路径穿越；未配置 root 时明确返回空结果
 *
 * 纯 Node（node:fs / node:path），不依赖 electron，便于单测。
 * 与 L0–L5 记忆 / BotMemory 物理隔离：本模块只读、零写入。
 *
 * @see docs/dev/knowledge-base/KB-PRODUCT-SPEC-v1.md §5 Phase 0
 * @see docs/dev/knowledge-base/KB-PHASE0-brief.md
 */
import {
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  basename,
  extname,
  isAbsolute,
  sep,
} from "node:path";

/** 最大递归深度（root 直接子项记为深度 0） */
const MAX_DEPTH = 4;
/** 纳入检索索引的单文件大小上限（1 MiB）；超过则跳过索引（仍可 kb_get 读取，按上限截断） */
const MAX_INDEX_BYTES = 1 * 1024 * 1024;
/** 单 root 最多索引文件数，防失控扫描 */
const MAX_FILES_PER_ROOT = 2000;
/** kb_get 返回正文的字节上限（256 KiB），超出截断并置 truncated */
const MAX_GET_BYTES = 256 * 1024;
/** 读取文件头部用于提取标题的字节数 */
const HEAD_BYTES = 4096;
/** 单条命中摘录最大字符数 */
const SEARCH_EXCERPT_LEN = 200;
/** kb_search 默认返回上限 */
const DEFAULT_SEARCH_LIMIT = 10;
/** kb_search 绝对上限 */
const MAX_SEARCH_LIMIT = 50;
/** 正文缓存条目上限，超过即整体清空（简单防膨胀） */
const MAX_CACHE_ENTRIES = 5000;

const INDEXED_EXTS = new Set([".md", ".markdown", ".txt"]);
/** 跳过的目录名（不递归） */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "bower_components",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".cache",
  ".venv",
  "venv",
]);

/** 已绑定的知识库根目录 */
export interface KbRoot {
  /** 稳定 id：规范化后的绝对路径（用作 kb_search rootId 匹配键） */
  id: string;
  /** 规范化后的绝对路径 */
  path: string;
  /** 显示名（basename） */
  label: string;
}

/** 已索引的文件条目 */
export interface KbFileEntry {
  rootId: string;
  rootPath: string;
  /** 相对 root 的 POSIX 风格路径 */
  relativePath: string;
  absolutePath: string;
  title: string;
  mtimeMs: number;
  size: number;
}

/** kb_search 单条命中 */
export interface KbSearchHit {
  rootId: string;
  rootLabel: string;
  relativePath: string;
  absolutePath: string;
  title: string;
  score: number;
  excerpt: string;
  matchedIn: "title" | "body" | "both";
}

/** kb_get 返回 */
export interface KbGetResult {
  rootId: string;
  rootLabel: string;
  relativePath: string;
  absolutePath: string;
  title: string;
  size: number;
  content: string;
  truncated: boolean;
}

/** POSIX 风格路径（统一 emitted relativePath） */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** 去扩展名的文件名（标题兜底用） */
function stripExt(name: string): string {
  const e = extname(name);
  return e ? name.slice(0, -e.length) : name;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 容器校验：target 是否严格位于 root 之内（不含 root 自身）。
 * 经 resolve 后 `..` 已折叠，再用 relative 判定，可拒绝绝对路径穿越。
 */
function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return false; // target === root 本身（目录），非文件
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** 读取文件头部指定字节数（提取标题用；失败返回空串） */
function readHead(full: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(full, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 从文本提取标题：首个 Markdown 标题 → 首个非空行（跳过 YAML front matter）→ 兜底名 */
function extractTitle(head: string, fallbackName: string): string {
  const lines = head.split(/\r?\n/);
  let inFrontMatter = false;
  let frontMatterSeen = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === "---" && !frontMatterSeen) {
      inFrontMatter = true;
      frontMatterSeen = true;
      continue;
    }
    if (inFrontMatter) {
      if (t === "---") inFrontMatter = false;
      continue;
    }
    if (!t) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(t);
    if (m) return m[1]!.trim();
    return t;
  }
  return stripExt(fallbackName);
}

/** 查询分词：空白 / 常见标点切分，小写去重；CJK 无空格则整体作一词 */
function tokenize(query: string): string[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const tokens = lower
    .split(/[\s,，。、；;:：!?！？()（）\[\]{}'"`|/\\]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

/** 围绕首个关键词命中位置截取短摘录，折叠空白 */
function makeExcerpt(content: string, firstKw: string, maxLen: number): string {
  if (!content) return "";
  const lower = content.toLowerCase();
  const idx = firstKw ? lower.indexOf(firstKw) : -1;
  let start = 0;
  if (idx >= 0) start = Math.max(0, idx - Math.floor(maxLen / 3));
  let snippet = content
    .slice(start, start + maxLen)
    .replace(/\s+/g, " ")
    .trim();
  if (start > 0) snippet = "…" + snippet;
  if (start + maxLen < content.length) snippet = snippet + "…";
  return snippet;
}

/**
 * 规范化 kbRoots 列表为 KbRoot[]：resolve 去重，仅保留现存目录。
 * 纯函数，无缓存，便于单测。
 */
export function normalizeKbRoots(input: string[] | undefined): KbRoot[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: KbRoot[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p || !isAbsolute(p)) continue;
    const abs = resolve(p);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // 不存在的 root 静默跳过
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue; // 仅接受真实目录
    seen.add(key);
    out.push({ id: abs, path: abs, label: basename(abs) || abs });
  }
  return out;
}

interface RootEntryCache {
  dirMtimeMs: number;
  entries: KbFileEntry[];
}

interface ContentCache {
  mtimeMs: number;
  text: string;
}

/**
 * 知识库文件系统索引（进程内、单实例可复用）。
 * 生产环境用 {@link getDefaultKbIndex} 单例；单测可 `new KbFsIndex()` 隔离缓存。
 */
export class KbFsIndex {
  /** root 目录 mtime → 文件列表缓存 */
  private entryCache = new Map<string, RootEntryCache>();
  /** 文件 mtime → 正文缓存 */
  private contentCache = new Map<string, ContentCache>();

  /** 列出已绑定的根目录（规范化 + 现存目录过滤） */
  listRoots(kbRoots: string[] | undefined): KbRoot[] {
    return normalizeKbRoots(kbRoots);
  }

  /** 清空全部缓存（配置变更 / 测试隔离用） */
  clearCache(): void {
    this.entryCache.clear();
    this.contentCache.clear();
  }

  /** 扫描单个 root 下符合条件的文件（深度/数量/大小受限，跳过符号链接与忽略目录） */
  private scanRoot(root: KbRoot): KbFileEntry[] {
    const out: KbFileEntry[] = [];
    const stack: Array<{ dir: string; depth: number }> = [
      { dir: root.path, depth: 0 },
    ];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        // 防穿越：跳过符号链接（不跟随到 root 之外）
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (depth >= MAX_DEPTH) continue;
          if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
          stack.push({ dir: full, depth: depth + 1 });
        } else if (st.isFile()) {
          const ext = extname(name).toLowerCase();
          if (!INDEXED_EXTS.has(ext)) continue;
          if (st.size > MAX_INDEX_BYTES) continue;
          if (out.length >= MAX_FILES_PER_ROOT) return out;
          out.push({
            rootId: root.id,
            rootPath: root.path,
            relativePath: toPosix(relative(root.path, full)),
            absolutePath: full,
            title: extractTitle(readHead(full, HEAD_BYTES), name),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        }
      }
    }
    out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return out;
  }

  /** 取 roots 对应的全部已索引文件条目（root 目录 mtime 命中缓存） */
  private listEntries(roots: KbRoot[]): KbFileEntry[] {
    const out: KbFileEntry[] = [];
    for (const r of roots) {
      let dirMtime = 0;
      try {
        dirMtime = statSync(r.path).mtimeMs;
      } catch {
        this.entryCache.delete(r.path);
        continue;
      }
      const cached = this.entryCache.get(r.path);
      if (cached && cached.dirMtimeMs === dirMtime) {
        out.push(...cached.entries);
      } else {
        const entries = this.scanRoot(r);
        this.entryCache.set(r.path, { dirMtimeMs: dirMtime, entries });
        out.push(...entries);
      }
    }
    return out;
  }

  /** 取文件正文（文件 mtime 命中缓存；超 MAX_INDEX_BYTES 视为无正文参与检索） */
  private getContent(absolutePath: string, mtimeMs: number): string {
    const cached = this.contentCache.get(absolutePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.text;
    let text = "";
    try {
      const st = statSync(absolutePath);
      if (st.size <= MAX_INDEX_BYTES) {
        text = readFileSync(absolutePath, "utf8");
      }
    } catch {
      return cached?.text ?? "";
    }
    if (this.contentCache.size > MAX_CACHE_ENTRIES) this.contentCache.clear();
    this.contentCache.set(absolutePath, { mtimeMs, text });
    return text;
  }

  /**
   * 在已绑定 roots 内关键词检索。
   * @param kbRoots 绑定的根目录绝对路径列表
   * @param query 查询关键词（空白/标点分词，OR 语义按命中度排序）
   * @param opts.rootId 限定单个 root（= KbRoot.id，即 root 规范化路径）
   * @param opts.limit 返回上限（默认 10，上限 50）
   */
  search(
    kbRoots: string[] | undefined,
    query: string,
    opts?: { rootId?: string; limit?: number },
  ): KbSearchHit[] {
    const roots = normalizeKbRoots(kbRoots);
    if (roots.length === 0) return [];
    const keywords = tokenize(query);
    if (keywords.length === 0) return [];
    const limit = clamp(
      opts?.limit ?? DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
    const rootFilter = opts?.rootId;
    const rootLabelById = new Map(roots.map((r) => [r.id, r.label]));
    const entries = this.listEntries(roots);
    const hits: KbSearchHit[] = [];
    for (const e of entries) {
      if (rootFilter && e.rootId !== rootFilter) continue;
      const content = this.getContent(e.absolutePath, e.mtimeMs);
      const titleLower = e.title.toLowerCase();
      const bodyLower = content.toLowerCase();
      let score = 0;
      let matchedInTitle = false;
      let matchedInBody = false;
      for (const kw of keywords) {
        if (titleLower.includes(kw)) {
          score += 5;
          matchedInTitle = true;
        }
        let c = 0;
        let idx = 0;
        while ((idx = bodyLower.indexOf(kw, idx)) !== -1) {
          c += 1;
          idx += kw.length;
          if (c >= 100) break;
        }
        if (c > 0) {
          score += Math.min(c, 10);
          matchedInBody = true;
        }
      }
      if (score > 0) {
        const matchedIn =
          matchedInTitle && matchedInBody
            ? "both"
            : matchedInTitle
              ? "title"
              : "body";
        hits.push({
          rootId: e.rootId,
          rootLabel: rootLabelById.get(e.rootId) ?? "",
          relativePath: e.relativePath,
          absolutePath: e.absolutePath,
          title: e.title,
          score,
          excerpt: makeExcerpt(content, keywords[0] ?? "", SEARCH_EXCERPT_LEN),
          matchedIn,
        });
      }
    }
    hits.sort(
      (a, b) =>
        b.score - a.score || a.relativePath.localeCompare(b.relativePath),
    );
    return hits.slice(0, limit);
  }

  /**
   * 按绑定 root 读取单文件（防路径穿越）。
   * @param path 绝对路径或相对路径（相对路径按各 root 解析，命中首个容器校验通过的 root）
   */
  getFile(kbRoots: string[] | undefined, path: string): KbGetResult | null {
    const roots = normalizeKbRoots(kbRoots);
    if (roots.length === 0) return null;
    const raw = typeof path === "string" ? path.trim() : "";
    if (!raw) return null;
    const target = this.resolveWithinRoots(roots, raw);
    if (!target) return null;
    const { root, absolutePath } = target;
    if (!isWithinRoot(root.path, absolutePath)) return null;
    // Lexical containment alone is insufficient when a file or an intermediate
    // directory is a symlink. Resolve both sides and reject symlink traversal.
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(root.path);
      realTarget = realpathSync(absolutePath);
    } catch {
      return null;
    }
    if (
      !isWithinRoot(realRoot, realTarget) ||
      realTarget.toLowerCase() !== absolutePath.toLowerCase()
    ) {
      return null;
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(absolutePath);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const ext = extname(absolutePath).toLowerCase();
    if (!INDEXED_EXTS.has(ext)) return null;
    let content = "";
    let truncated = false;
    try {
      const buf = readFileSync(absolutePath);
      if (buf.length > MAX_GET_BYTES) {
        content = buf.subarray(0, MAX_GET_BYTES).toString("utf8");
        truncated = true;
      } else {
        content = buf.toString("utf8");
      }
    } catch {
      return null;
    }
    return {
      rootId: root.id,
      rootLabel: root.label,
      relativePath: toPosix(relative(root.path, absolutePath)),
      absolutePath,
      title: extractTitle(content, basename(absolutePath)),
      size: st.size,
      content,
      truncated,
    };
  }

  /**
   * 将用户输入路径解析为「位于某 root 之内」的绝对路径。
   * 绝对路径直接容器校验；相对路径按各 root resolve 后校验。返回首个通过的 root + 绝对路径。
   */
  private resolveWithinRoots(
    roots: KbRoot[],
    raw: string,
  ): { root: KbRoot; absolutePath: string } | null {
    if (isAbsolute(raw)) {
      const abs = resolve(raw);
      for (const r of roots) {
        if (isWithinRoot(r.path, abs)) return { root: r, absolutePath: abs };
      }
      return null;
    }
    for (const r of roots) {
      const abs = resolve(r.path, raw);
      if (isWithinRoot(r.path, abs)) return { root: r, absolutePath: abs };
    }
    return null;
  }
}

let _default: KbFsIndex | undefined;

/** 进程级默认索引单例（生产用；工具层通过它检索） */
export function getDefaultKbIndex(): KbFsIndex {
  if (!_default) _default = new KbFsIndex();
  return _default;
}
