export type CloudDocumentProvider =
  | "wps"
  | "feishu"
  | "google-drive"
  | "unknown";

export interface CloudDocumentReference {
  provider: CloudDocumentProvider;
  sourceUrl: string;
  externalId?: string;
}

/** 从用户任意粘贴文本中提取第一个云文档 URL。 */
export function extractCloudDocumentUrl(rawUrl: string): string {
  const candidate = rawUrl.trim().replace(/^<|>$/g, "");
  const markdownMatch = candidate.match(
    /^\[[^\]]+\]\(\s*(https?:\/\/[^)\s]+)\s*\)$/i,
  );
  const embeddedMatch = candidate.match(/https?:\/\/[^\s<>{}\]\)]+/i);
  const cleaned = markdownMatch?.[1] ?? embeddedMatch?.[0] ?? candidate;
  return cleaned.replace(/[),.;!?，。；！？】》]+$/g, "");
}

function normalizedUrl(rawUrl: string): URL {
  const extracted = extractCloudDocumentUrl(rawUrl);
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(extracted)
    ? extracted
    : "https://" + extracted;
  try {
    return new URL(value);
  } catch {
    throw new Error("Invalid cloud document URL");
  }
}

export function parseCloudDocumentReference(
  rawUrl: string,
): CloudDocumentReference {
  const url = normalizedUrl(rawUrl);
  const hostname = url.hostname.toLowerCase();
  const path = url.pathname;
  if (hostname.endsWith(".kdocs.cn") || hostname.endsWith(".wps.cn")) {
    const id = path.match(/\/(?:l|doc|file)\/([^/?#]+)/i)?.[1];
    return {
      provider: "wps",
      sourceUrl: url.toString(),
      ...(id ? { externalId: id } : {}),
    };
  }
  if (hostname.endsWith(".feishu.cn") || hostname.endsWith(".larksuite.com")) {
    const id = path.match(/\/(?:docx|docs|wiki|sheet|base)\/([^/?#]+)/i)?.[1];
    return {
      provider: "feishu",
      sourceUrl: url.toString(),
      ...(id ? { externalId: id } : {}),
    };
  }
  if (hostname === "docs.google.com" || hostname.endsWith(".google.com")) {
    const id = path.match(/\/document\/d\/([^/]+)/i)?.[1];
    return {
      provider: "google-drive",
      sourceUrl: url.toString(),
      ...(id ? { externalId: id } : {}),
    };
  }
  return { provider: "unknown", sourceUrl: url.toString() };
}

export function cloudProviderLabel(provider: CloudDocumentProvider): string {
  switch (provider) {
    case "wps":
      return "WPS 云文档";
    case "feishu":
      return "飞书云文档";
    case "google-drive":
      return "Google 云文档";
    default:
      return "云文档";
  }
}
