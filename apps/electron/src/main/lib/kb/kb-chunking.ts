export interface KnowledgeChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  section?: string;
  content: string;
  startLine: number;
  endLine: number;
}

const MAX_CHUNK_CHARS = 1600;

function splitLongBlock(
  block: string,
  startLine: number,
  documentId: string,
  documentTitle: string,
  section: string | undefined,
): KnowledgeChunk[] {
  const lines = block.split("\n");
  const chunks: KnowledgeChunk[] = [];
  let current: string[] = [];
  let currentStart = startLine;
  const flush = (endLine: number): void => {
    const content = current.join("\n").trim();
    if (!content) return;
    chunks.push({
      id: `${documentId}:${currentStart}-${endLine}`,
      documentId,
      documentTitle,
      ...(section ? { section } : {}),
      content,
      startLine: currentStart,
      endLine,
    });
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (current.length > 0 && current.join("\n").length + line.length + 1 > MAX_CHUNK_CHARS) {
      flush(startLine + index - 1);
      currentStart = startLine + index;
    }
    current.push(line);
  }
  flush(startLine + lines.length - 1);
  return chunks;
}

/**
 * 按 Markdown 标题、段落和代码块边界切分正式知识。
 * 这是查询时生成的轻量 MVP，不改变存储格式；chunk id 由文档 id 和行号稳定生成。
 */
export function splitKnowledgeDocument(input: {
  documentId: string;
  title: string;
  content: string;
}): KnowledgeChunk[] {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  const chunks: KnowledgeChunk[] = [];
  let section: string | undefined;
  let block: string[] = [];
  let blockStart = 1;
  let inFence = false;

  const flush = (endLine: number): void => {
    if (block.length === 0) return;
    chunks.push(
      ...splitLongBlock(
        block.join("\n"),
        blockStart,
        input.documentId,
        input.title,
        section,
      ),
    );
    block = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading && !inFence) {
      flush(lineNumber - 1);
      section = heading[2]?.trim() || undefined;
      block = [line];
      blockStart = lineNumber;
      continue;
    }
    if (/^\s*\`\`\`/.test(line)) {
      if (block.length === 0) blockStart = lineNumber;
      block.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && !line.trim()) {
      flush(lineNumber - 1);
      continue;
    }
    if (block.length === 0) blockStart = lineNumber;
    block.push(line);
  }
  flush(lines.length);
  return chunks;
}
