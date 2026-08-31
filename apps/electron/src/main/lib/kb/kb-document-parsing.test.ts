import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import {
  attachmentMediaType,
  extractDocxText,
  extractXlsxSheets,
  isSupportedAttachmentExt,
  parseAttachmentFile,
} from "./knowledge-base-document-store";
import { AGENT_IPC_CHANNELS } from "@tagent/shared";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function buildXlsx(
  sheets: Array<{ name: string; xml: string }>,
  sharedStrings: string[],
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = enc(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  );
  files["_rels/.rels"] = enc(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const sheetTags = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  files["xl/workbook.xml"] = enc(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`,
  );
  const relTags = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  files["xl/_rels/workbook.xml.rels"] = enc(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`,
  );
  const sharedItems = sharedStrings.map((s) => `<si><t>${s}</t></si>`).join("");
  files["xl/sharedStrings.xml"] = enc(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedItems}</sst>`,
  );
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.xml}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

describe("extractXlsxSheets", () => {
  test("parses all worksheets with shared strings and numbers", () => {
    const sheet1 =
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row>`;
    const sheet2 = `<row r="1"><c r="A1"><v>42</v></c></row>`;
    const buffer = buildXlsx(
      [
        { name: "Sheet1", xml: sheet1 },
        { name: "数据", xml: sheet2 },
      ],
      ["名称", "数量", "苹果"],
    );
    const sheets = extractXlsxSheets(buffer);
    expect(sheets.length).toBe(2);
    const first = sheets[0]!;
    const second = sheets[1]!;
    expect(first.name).toBe("Sheet1");
    expect(first.content).toContain("名称");
    expect(first.content).toContain("数量");
    expect(first.content).toContain("苹果");
    expect(first.content).toContain("10");
    expect(second.name).toBe("数据");
    expect(second.content).toContain("42");
  });

  test("renders a markdown table per sheet", () => {
    const buffer = buildXlsx(
      [{ name: "S1", xml: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` }],
      ["标题"],
    );
    const sheet = extractXlsxSheets(buffer)[0]!;
    expect(sheet.content).toContain("| 标题 |");
    expect(sheet.content).toContain("| --- |");
  });

  test("throws when workbook.xml is missing", () => {
    const files: Record<string, Uint8Array> = {
      "[Content_Types].xml": enc("<Types/>"),
    };
    expect(() => extractXlsxSheets(zipSync(files))).toThrow();
  });
});

describe("extractDocxText", () => {
  test("extracts paragraphs from document.xml", () => {
    const files: Record<string, Uint8Array> = {
      "word/document.xml": enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>`,
      ),
    };
    const text = extractDocxText(zipSync(files));
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
    expect(text).toBe("第一段\n\n第二段");
  });

  test("decodes XML entities", () => {
    const files: Record<string, Uint8Array> = {
      "word/document.xml": enc(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>a&amp;b &lt;tag&gt;</w:t></w:r></w:p></w:body></w:document>`,
      ),
    };
    const text = extractDocxText(zipSync(files));
    expect(text).toContain("a&b <tag>");
  });
});

describe("cloud document raw-download import IPC", () => {
  test("exposes a dedicated download import channel", () => {
    expect(AGENT_IPC_CHANNELS.IMPORT_KNOWLEDGE_BASE_DOCUMENT_DOWNLOAD).toBe(
      "agent:import-knowledge-base-document-download",
    );
  });
});

// ── 主线第一步：parseAttachmentFile 附件解析中间格式 ─────────────────

describe("parseAttachmentFile", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tagent-parse-"));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("isSupportedAttachmentExt / attachmentMediaType 边界", () => {
    expect(isSupportedAttachmentExt(".docx")).toBe(true);
    expect(isSupportedAttachmentExt(".csv")).toBe(true);
    expect(isSupportedAttachmentExt(".MARKDOWN")).toBe(true);
    expect(isSupportedAttachmentExt(".zip")).toBe(false);
    expect(isSupportedAttachmentExt("")).toBe(false);
    expect(attachmentMediaType(".pdf")).toBe("application/pdf");
    expect(attachmentMediaType(".xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(attachmentMediaType(".csv")).toBe("text/csv");
    expect(attachmentMediaType(".zip")).toBe("application/octet-stream");
  });

  test(".docx → 提取段落文本，sheets 为空", async () => {
    const docx = zipSync({
      "word/document.xml": enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    const filePath = join(dir, "a.docx");
    writeFileSync(filePath, docx);
    const parsed = await parseAttachmentFile(filePath);
    expect(parsed.content).toBe("第一段\n\n第二段");
    expect(parsed.sheets).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.warnings).toEqual([]);
  });

  test(".xlsx → 保留多个工作表名与各表内容，content 为空", async () => {
    const sheet1 =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row>';
    const sheet2 = '<row r="1"><c r="A1"><v>42</v></c></row>';
    const xlsx = buildXlsx(
      [
        { name: "Sheet1", xml: sheet1 },
        { name: "数据", xml: sheet2 },
      ],
      ["名称", "数量", "苹果"],
    );
    const filePath = join(dir, "b.xlsx");
    writeFileSync(filePath, xlsx);
    const parsed = await parseAttachmentFile(filePath);
    expect(parsed.sheets).toHaveLength(2);
    expect(parsed.sheets.map((s) => s.name)).toEqual(["Sheet1", "数据"]);
    expect(parsed.sheets[0]!.content).toContain("名称");
    expect(parsed.sheets[0]!.content).toContain("苹果");
    expect(parsed.sheets[0]!.content).toContain("10");
    expect(parsed.sheets[1]!.content).toContain("42");
    // 不混入页面参数 / HTML / CSS / 原始 XML 标签
    expect(parsed.sheets[0]!.content).not.toMatch(/[<]/);
    expect(parsed.content).toBe("");
    expect(parsed.truncated).toBe(false);
  });

  test(".txt / .csv → utf8 文本", async () => {
    const filePath = join(dir, "c.csv");
    writeFileSync(filePath, "name,value\r\n苹果,10\r\n", "utf8");
    const parsed = await parseAttachmentFile(filePath);
    expect(parsed.content).toContain("苹果,10");
    expect(parsed.content).not.toContain("\r");
    expect(parsed.sheets).toEqual([]);
  });

  test("不支持格式 → 抛错（不伪造结果）", async () => {
    const filePath = join(dir, "x.zip");
    writeFileSync(filePath, Buffer.from("PK"));
    await expect(parseAttachmentFile(filePath)).rejects.toThrow(/不支持.*格式/);
  });

  test("空文本 → 抛错（不伪造结果）", async () => {
    const filePath = join(dir, "empty.txt");
    writeFileSync(filePath, "   \n  \n", "utf8");
    await expect(parseAttachmentFile(filePath)).rejects.toThrow(
      /没有可提取的文本内容/,
    );
  });

  test("过大内容截断并在 warnings 明确告知（不静默截断）", async () => {
    const big = "a".repeat(300_000); // > 256 * 1024
    const filePath = join(dir, "big.txt");
    writeFileSync(filePath, big, "utf8");
    const parsed = await parseAttachmentFile(filePath);
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalLength).toBe(300_000);
    expect(parsed.content.length).toBe(256 * 1024);
    expect(parsed.warnings.some((w) => /已截断/.test(w))).toBe(true);
  });
});
