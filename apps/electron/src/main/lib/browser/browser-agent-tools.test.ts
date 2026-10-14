import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ extractText: vi.fn() }));
vi.mock("../ipc/browser-service", () => ({ getBrowserController: () => mock }));
import {
  buildPiBrowserTools,
  handleBrowserReadText,
} from "./browser-agent-tools";
import { isChatModeBlockedTool } from "@tagent/shared";

beforeEach(() => vi.clearAllMocks());
describe("browser visible text tool", () => {
  it("reuses page extraction with actual source metadata and paginates long bodies", async () => {
    const text = "网页正文".repeat(6000);
    mock.extractText.mockResolvedValue({
      sessionId: "session",
      tabId: "tab",
      url: "https://example.com/actual",
      title: "文章标题",
      text,
    });
    const tool = buildPiBrowserTools({ sessionId: "session" }).find(
      (tool) => tool.name === "browser_read_text",
    )!;
    const firstResult = await tool.execute(
      "read-1",
      {},
      new AbortController().signal,
    );
    const first = JSON.parse((firstResult.content[0] as { text: string }).text);
    expect(first).toMatchObject({
      ok: true,
      url: "https://example.com/actual",
      title: "文章标题",
      contentType: "visible-page-text",
      nextOffset: 20000,
    });
    expect(first.text).toHaveLength(20000);
    const second = JSON.parse(
      (
        await handleBrowserReadText(
          { offset: first.nextOffset },
          { sessionId: "session" },
        )
      ).content[0]!.text,
    );
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBeNull();
    expect(mock.extractText).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({ waitForLoad: true }),
    );
    expect(isChatModeBlockedTool("browser_read_text", {})).toBe(false);
  });
  it("reports missing text and extraction failures instead of inventing a page body", async () => {
    mock.extractText.mockResolvedValue({
      sessionId: "session",
      tabId: "tab",
      url: "https://example.com",
      title: "视频页",
      text: "",
    });
    expect(
      JSON.parse(
        (await handleBrowserReadText({}, { sessionId: "session" })).content[0]!
          .text,
      ),
    ).toMatchObject({ ok: false, text: "" });
    mock.extractText.mockRejectedValue(new Error("页面仍在加载"));
    expect(
      JSON.parse(
        (await handleBrowserReadText({}, { sessionId: "session" })).content[0]!
          .text,
      ),
    ).toMatchObject({ ok: false, error: "页面仍在加载" });
  });
});
