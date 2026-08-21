/**
 * Dockview 标签栏 DnD 约束。
 *
 * 标签栏右侧空白（.dv-void-container）默认是整组拖动手柄，
 * 会拖出 "Multiple Panels (N)" 幽灵并在落下时留下空 group。
 */

export function isGroupHeaderDrag(
  data: { panelId: string | null } | undefined,
): boolean {
  return !data?.panelId;
}

/** 关掉 void 容器的整组拖：仍可当「插到末尾」的 drop 区 */
export function disableVoidGroupDrag(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".dv-void-container").forEach((el) => {
    el.draggable = false;
    el.classList.remove("dv-draggable");
  });
}

export function pruneEmptyDockGroups<T extends { groups: ReadonlyArray<{ size: number }> }>(
  api: T & { removeGroup: (group: T["groups"][number]) => void },
): void {
  const empties = api.groups.filter((group) => group.size === 0);
  if (empties.length === 0) return;
  const keepOne = empties.length === api.groups.length;
  empties.forEach((group, index) => {
    if (keepOne && index === 0) return;
    api.removeGroup(group);
  });
}
