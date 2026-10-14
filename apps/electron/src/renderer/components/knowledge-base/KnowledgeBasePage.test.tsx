// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseRecord,
} from "@tagent/shared";
import { KnowledgeBasePage } from "./KnowledgeBasePage";
import {
  confirmKnowledgeLeave,
  type KnowledgeNavigation,
} from "./knowledge-navigation";

vi.mock("@tagent/ui", async (original) => ({
  ...(await original<typeof import("@tagent/ui")>()),
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));

let root: Root,
  container: HTMLDivElement,
  bases: KnowledgeBaseRecord[],
  documents: KnowledgeBaseDocument[];
const api = {
  listKnowledgeBases: vi.fn(),
  listKnowledgeBaseDocuments: vi.fn(),
  updateKnowledgeBaseDocument: vi.fn(),
  createKnowledgeBase: vi.fn(),
  createKnowledgeBaseDocument: vi.fn(),
  openFolderDialog: vi.fn(),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  bases = [
    {
      id: "product",
      name: "产品方法",
      description: "经过验证的设计经验",
      sources: [],
      createdAt: 1,
      updatedAt: 10,
    },
    { id: "life", name: "生活阅读", sources: [], createdAt: 1, updatedAt: 10 },
  ];
  documents = [
    {
      id: "design",
      knowledgeBaseId: "product",
      title: "设计评审方法",
      content: "评审时先明确问题，再讨论解决办法。",
      tags: ["产品/交互"],
      createdAt: 1,
      updatedAt: 30,
    },
    {
      id: "notes",
      knowledgeBaseId: "product",
      title: "会议记录模板",
      content: "保留讨论背景与行动项。",
      tags: ["工作"],
      createdAt: 1,
      updatedAt: 20,
    },
    {
      id: "reading",
      knowledgeBaseId: "life",
      title: "阅读与复盘",
      content: "用自己的话复述观点，留下一条可行动的收获。",
      tags: ["阅读"],
      createdAt: 1,
      updatedAt: 10,
    },
  ];
  api.listKnowledgeBases.mockImplementation(async () => bases);
  api.listKnowledgeBaseDocuments.mockImplementation(
    async ({ knowledgeBaseId }) =>
      documents.filter((doc) => doc.knowledgeBaseId === knowledgeBaseId),
  );
  api.updateKnowledgeBaseDocument.mockImplementation(async (input) => {
    const updated = {
      ...documents.find((doc) => doc.id === input.id)!,
      ...input,
      updatedAt: 40,
    };
    documents = documents.map((doc) => (doc.id === input.id ? updated : doc));
    return updated;
  });
  api.createKnowledgeBase.mockImplementation(async (input) => {
    const created = {
      id: "new",
      ...input,
      sources: [],
      createdAt: 1,
      updatedAt: 10,
    };
    bases = [...bases, created];
    return created;
  });
  api.createKnowledgeBaseDocument.mockImplementation(async (input) => {
    const created = {
      id: "created",
      ...input,
      tags: [],
      createdAt: 1,
      updatedAt: 40,
    };
    documents = [created, ...documents];
    return created;
  });
  api.openFolderDialog.mockResolvedValue([]);
  window.electronAPI = api as unknown as typeof window.electronAPI;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(navigation?: KnowledgeNavigation) {
  await act(async () =>
    root.render(<KnowledgeBasePage navigation={navigation} />),
  );
}
function findButton(label: string) {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (button) =>
      button.getAttribute("aria-label") === label ||
      button.textContent?.trim() === label,
  );
  if (!found) throw new Error("Missing button: " + label);
  return found;
}
async function click(label: string) {
  await act(async () => findButton(label).click());
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("personal knowledge inside the workbench", () => {
  it("finds documents across libraries by body and tags and opens the chosen document", async () => {
    await render();
    expect(container.querySelectorAll(".kl-document-card")).toHaveLength(3);
    await input("搜索全部知识", "可行动");
    expect(container.querySelectorAll(".kl-document-card")).toHaveLength(1);
    await click("阅读：阅读与复盘");
    expect(container.querySelector(".kl-reader h3")?.textContent).toBe(
      "阅读与复盘",
    );
    expect(container.querySelector(".kl-header h2")?.textContent).toBe(
      "生活阅读",
    );
    await click("全部知识");
    await input("搜索全部知识", "产品/交互");
    expect(container.querySelectorAll(".kl-document-card")).toHaveLength(1);
    await input("搜索全部知识", "");
    await click("筛选知识标签：产品");
    expect(container.querySelectorAll(".kl-document-card")).toHaveLength(1);
    await click("阅读：设计评审方法");
    expect(container.querySelector(".kl-reader")?.textContent).toContain(
      "先明确问题",
    );
  });
  it("retains edits when leaving is cancelled and saves title, content and tags together", async () => {
    await render({
      requestId: 1,
      knowledgeBaseId: "product",
      documentId: "design",
    });
    await click("编辑");
    await input("文档标题", "设计评审清单");
    await input("文档内容", "更新后的方法与依据");
    await input("知识文档标签", "#产品/评审 #方法");
    vi.mocked(window.confirm).mockReturnValue(false);
    expect(confirmKnowledgeLeave()).toBe(false);
    await click("阅读：会议记录模板");
    expect(
      (container.querySelector('[aria-label="文档标题"]') as HTMLInputElement)
        .value,
    ).toBe("设计评审清单");
    await click("预览");
    expect(container.querySelector(".kl-reader")?.textContent).toContain(
      "更新后的方法与依据",
    );
    await click("保存修改");
    expect(api.updateKnowledgeBaseDocument).toHaveBeenCalledWith({
      id: "design",
      title: "设计评审清单",
      content: "更新后的方法与依据",
      tags: ["产品/评审", "方法"],
    });
    expect(confirmKnowledgeLeave()).toBe(true);
    await click("全部知识");
    expect(container.querySelector(".kl-document-grid")?.textContent).toContain(
      "设计评审清单",
    );
  });
  it("waits for slow library loading before resolving a document-only reference, and handles later jumps", async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.listKnowledgeBaseDocuments.mockImplementation(
      async ({ knowledgeBaseId }) => {
        await loaded;
        return documents.filter(
          (doc) => doc.knowledgeBaseId === knowledgeBaseId,
        );
      },
    );
    await render({ requestId: 1, documentId: "reading" });
    expect(container.querySelector(".kl-reader")).toBeNull();
    await act(async () => {
      release();
      await loaded;
    });
    expect(container.querySelector(".kl-reader h3")?.textContent).toBe(
      "阅读与复盘",
    );
    await render({
      requestId: 2,
      knowledgeBaseId: "product",
      documentId: "notes",
    });
    expect(container.querySelector(".kl-reader h3")?.textContent).toBe(
      "会议记录模板",
    );
    await render({
      requestId: 3,
      knowledgeBaseId: "product",
      documentId: "design",
    });
    expect(container.querySelector(".kl-reader h3")?.textContent).toBe(
      "设计评审方法",
    );
  });
  it("reports a missing reference instead of opening an unrelated document", async () => {
    await render({
      requestId: 1,
      knowledgeBaseId: "product",
      documentId: "missing",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "找不到这篇知识文档",
    );
    expect(container.querySelector(".kl-reader h3")).toBeNull();
  });
  it("creates a library and document without an application sidebar", async () => {
    bases = [];
    documents = [];
    await render();
    await click("新建知识库");
    const field = document.querySelector<HTMLInputElement>(
      'input[placeholder="例如：产品设计规范"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "个人方法");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("创建知识库");
    expect(container.querySelector(".kl-header h2")?.textContent).toBe(
      "个人方法",
    );
    await click("新建知识文档");
    expect(api.createKnowledgeBaseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: "new", kind: "note" }),
    );
    expect(container.querySelector('[aria-label="文档内容"]')).not.toBeNull();
  });
  it("keeps storage errors visible when a reference cannot be loaded", async () => {
    api.listKnowledgeBaseDocuments.mockRejectedValue(
      new Error("知识库文档无法读取，原文件已保留。"),
    );
    await render({ requestId: 1, documentId: "reading" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "原文件已保留",
    );
    expect(
      container.querySelector('[role="alert"]')?.textContent,
    ).not.toContain("可能已被删除");
  });
});
