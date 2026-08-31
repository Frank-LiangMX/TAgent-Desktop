import { describe, expect, test } from "vitest";
import {
  extractCloudDocumentUrl,
  parseCloudDocumentReference,
} from "./cloud-document-adapter";

describe("knowledge-base-document-store cloud URL parsing", () => {
  test("从 WPS 文档标题和 Markdown 链接中提取 URL", () => {
    const pasted =
      "【金山文档 | WPS云文档】 M0Demo工程说明文档 [https://365.kdocs.cn/l/cqmXGBESDqBl](https://365.kdocs.cn/l/cqmXGBESDqBl)";
    expect(extractCloudDocumentUrl(pasted)).toBe(
      "https://365.kdocs.cn/l/cqmXGBESDqBl",
    );
  });

  test("从 WPS 规范文档标题和 Markdown 链接中提取 URL", () => {
    const pasted =
      "【金山文档 | WPS云文档】 JX3\\_UE\\_场景资源命名规范\\n[https://365.kdocs.cn/l/chkOSp07TCPM](https://365.kdocs.cn/l/chkOSp07TCPM)";
    expect(extractCloudDocumentUrl(pasted)).toBe(
      "https://365.kdocs.cn/l/chkOSp07TCPM",
    );
  });

  test("保留直接 URL 并清理复制时的标点", () => {
    expect(
      extractCloudDocumentUrl("https://365.kdocs.cn/l/cqmXGBESDqBl。"),
    ).toBe("https://365.kdocs.cn/l/cqmXGBESDqBl");
  });
  test("识别主流云文档平台和外部文档 ID", () => {
    expect(
      parseCloudDocumentReference("https://365.kdocs.cn/l/cqmXGBESDqBl"),
    ).toMatchObject({
      provider: "wps",
      externalId: "cqmXGBESDqBl",
    });
    expect(
      parseCloudDocumentReference("https://acme.feishu.cn/docx/doxcn123/edit"),
    ).toMatchObject({ provider: "feishu", externalId: "doxcn123" });
    expect(
      parseCloudDocumentReference(
        "https://docs.google.com/document/d/abc123/edit",
      ),
    ).toMatchObject({ provider: "google-drive", externalId: "abc123" });
  });
});
