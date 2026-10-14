import { dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { WORKBENCH_IPC, type WorkbenchMutationInput } from "@tagent/shared";
import { workbenchService as store } from "./workbench-service";
import { getKnowledgeBaseDocument } from "../kb/knowledge-base-document-store";

export function registerWorkbenchIpc(): void {
  for (const channel of [
    WORKBENCH_IPC.READ,
    WORKBENCH_IPC.MUTATE,
    WORKBENCH_IPC.EXPORT,
  ])
    ipcMain.removeHandler(channel);
  ipcMain.handle(WORKBENCH_IPC.READ, () => store.read());
  ipcMain.handle(
    WORKBENCH_IPC.MUTATE,
    (_event, input: WorkbenchMutationInput) => {
      if (input.change.type === "record-knowledge") {
        const change = input.change;
        const document = getKnowledgeBaseDocument(change.documentId);
        if (
          !document ||
          document.knowledgeBaseId !== change.knowledgeBaseId ||
          document.originNote !==
            `工作台笔记 ${change.noteId} · 版本 ${store.read().notes.find((note) => note.id === change.noteId)?.revision}` ||
          document.title !== change.title ||
          JSON.stringify(document.tags ?? []) !== JSON.stringify(change.tags)
        )
          throw new Error("知识文档或来源已变化，请重新入库以记录足迹");
      }
      const state = store.mutate(input);
      return state;
    },
  );
  ipcMain.handle(WORKBENCH_IPC.EXPORT, async () => {
    const state = store.read();
    const result = await dialog.showSaveDialog({
      defaultPath: "tagent-workbench.json",
      filters: [{ name: "工作台备份 JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return { canceled: false, path: result.filePath };
  });
}
