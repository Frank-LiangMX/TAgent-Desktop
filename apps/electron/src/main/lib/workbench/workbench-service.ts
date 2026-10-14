import { BrowserWindow } from "electron";
import { join } from "node:path";
import { WORKBENCH_IPC, type WorkbenchMutationInput } from "@tagent/shared";
import { getConfigDir } from "../config/config-paths";
import { WorkbenchStore } from "./workbench-store";

// IPC and Pi use the same store and change notifications; no cached snapshots.
const store = () =>
  new WorkbenchStore(join(getConfigDir(), "workbench", "workbench.json"));
export const workbenchService = {
  read: () => store().read(),
  mutate: (input: WorkbenchMutationInput) => {
    const state = store().mutate(input);
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed())
          win.webContents.send(WORKBENCH_IPC.CHANGED);
      } catch (error) {
        console.warn("[workbench] 已保存，窗口通知失败", error);
      }
    }
    return state;
  },
};
