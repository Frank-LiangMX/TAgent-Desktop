import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KbFsIndex } from "./kb-fs-index";

const dirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tagent-kb-"));
  dirs.push(root);
  return root;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("KbFsIndex", () => {
  test("检索 markdown/txt 并返回标题、摘录和来源", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "ipc.md"),
      "# IPC 目录约定\n\n主进程通过 preload 暴露安全 API。\n",
      "utf8",
    );
    writeFileSync(
      join(root, "notes.txt"),
      "向量检索暂不属于 Phase 0。",
      "utf8",
    );

    const index = new KbFsIndex();
    const hits = index.search([root], "IPC");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      relativePath: "ipc.md",
      title: "IPC 目录约定",
      matchedIn: "both",
    });
    expect(hits[0]!.excerpt).toContain("IPC");
  });

  test("跳过忽略目录并支持 front matter 后的标题", () => {
    const root = makeRoot();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(
      join(root, "guide.md"),
      "---\ntitle: demo\n---\n## 真正标题\n\n内容",
      "utf8",
    );
    writeFileSync(
      join(root, "node_modules", "secret.md"),
      "# 不应命中\nIPC",
      "utf8",
    );

    const hits = new KbFsIndex().search([root], "IPC");
    expect(hits).toHaveLength(0);
    const titleHit = new KbFsIndex().search([root], "内容");
    expect(titleHit[0]?.title).toBe("真正标题");
  });

  test("多个根目录联合检索，rootId 可隔离", () => {
    const first = makeRoot();
    const second = makeRoot();
    writeFileSync(join(first, "a.md"), "# A\n共享关键词", "utf8");
    writeFileSync(join(second, "b.md"), "# B\n共享关键词", "utf8");

    const index = new KbFsIndex();
    const all = index.search([first, second], "共享关键词");
    expect(all.map((hit) => hit.relativePath)).toEqual(["a.md", "b.md"]);

    const onlySecond = index.search([first, second], "共享关键词", {
      rootId: second,
    });
    expect(onlySecond).toHaveLength(1);
    expect(onlySecond[0]?.rootId).toBe(second);
  });

  test("未绑定根目录返回空，kb_get 拒绝路径穿越", () => {
    const root = makeRoot();
    writeFileSync(join(root, "ok.md"), "# OK\n正文", "utf8");
    const index = new KbFsIndex();

    expect(index.search([], "正文")).toEqual([]);
    expect(index.getFile([], "ok.md")).toBeNull();
    expect(index.getFile([root], "../outside.md")).toBeNull();
    expect(index.getFile([root], join(root, "ok.md"))?.relativePath).toBe(
      "ok.md",
    );
  });
});
