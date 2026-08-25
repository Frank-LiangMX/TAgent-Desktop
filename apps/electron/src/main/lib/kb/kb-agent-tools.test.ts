import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let kbRoots: string[] = [];

vi.mock("../agent/session-store", () => ({
  getSessionMeta: () => ({ id: "session-test", kbRoots }),
}));

const tools = await import("./kb-agent-tools");

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
  kbRoots = [];


});

describe("kb-agent-tools", () => {
  test("Pi dual-mount 暴露三个只读工具", () => {
    const names = tools
      .buildPiKbTools({ sessionId: "session-test" })
      .map((tool) => tool.name);
    expect(names).toEqual(["kb_list_roots", "kb_search", "kb_get"]);
  });

  test("工具只检索当前会话绑定的根目录", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(
      join(root, "guide.md"),
      "# 接线说明\nPi 与 kscc 都要挂载。",
      "utf8",
    );
    kbRoots = [root];

    const result = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0].relativePath).toBe("guide.md");

    kbRoots = [];
    const empty = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(empty.content[0]!.text)).toMatchObject({ count: 0 });
  });

  test("kb_get 拒绝绑定根目录之外的文件", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(join(root, "guide.md"), "# 指南\n正文", "utf8");
    kbRoots = [root];

    const result = await tools.handleKbGet(
      { path: "../secret.md" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(result.content[0]!.text).error).toMatch(/路径穿越/);
  });

  test("知识库模式会生成对应的 Agent 检索策略", () => {
    const promptRoot = process.cwd();
    const preferred = tools.buildKbPromptAppend([promptRoot], "preferred");
    expect(preferred).toContain("当前模式：优先使用（preferred）");
    expect(preferred).toContain("必须先调用 kb_search");

    const strict = tools.buildKbPromptAppend([promptRoot], "strict");
    expect(strict).toContain("当前模式：仅使用（strict）");
    expect(strict).toContain("不得用常识猜测");

    const off = tools.buildKbPromptAppend([promptRoot], "off");
    expect(off).toContain("当前模式：不主动使用（off）");
    expect(off).not.toContain("当前模式：优先使用（preferred）");
  });
});
