import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileFusionRoomWorkspaceLeaseStore } from "./fusion-room-workspace-lease-store";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("FileFusionRoomWorkspaceLeaseStore", () => {
  test("同一路径互斥，释放后可再次获取", () => {
    const root = mkdtempSync(join(tmpdir(), "tagent-room-lease-"));
    cleanup.push(root);
    const store = new FileFusionRoomWorkspaceLeaseStore({
      rootForRoom: () => root,
    });

    const first = store.acquire("room-1", ["shared/report.md"], "run-1");
    expect(first).toBeDefined();
    expect(
      store.acquire("room-1", ["shared/report.md"], "run-2"),
    ).toBeUndefined();
    expect(store.acquire("room-1", ["shared/other.md"], "run-3")).toBeDefined();

    first?.release();
    expect(
      store.acquire("room-1", ["shared/report.md"], "run-4"),
    ).toBeDefined();
  });

  test("workspace 粗粒度租约与所有文件租约冲突", () => {
    const root = mkdtempSync(join(tmpdir(), "tagent-room-lease-"));
    cleanup.push(root);
    const store = new FileFusionRoomWorkspaceLeaseStore({
      rootForRoom: () => root,
    });

    const command = store.acquire("room-1", ["workspace"], "run-command");
    expect(command).toBeDefined();
    expect(store.acquire("room-1", ["a.txt"], "run-write")).toBeUndefined();
    command?.release();
    expect(store.acquire("room-1", ["a.txt"], "run-write")).toBeDefined();
  });

  test("过期租约可在下一次获取时回收", () => {
    const root = mkdtempSync(join(tmpdir(), "tagent-room-lease-"));
    cleanup.push(root);
    let now = 1_000;
    const store = new FileFusionRoomWorkspaceLeaseStore({
      rootForRoom: () => root,
      now: () => now,
      leaseMs: 1_000,
    });

    expect(store.acquire("room-1", ["a.txt"], "run-1")).toBeDefined();
    now = 2_001;
    expect(store.acquire("room-1", ["a.txt"], "run-2")).toBeDefined();
  });
  test("根消息预算作用域支持跨实例互斥和较长 TTL", () => {
    const root = mkdtempSync(join(tmpdir(), "tagent-room-lease-budget-"));
    cleanup.push(root);
    let now = 10_000;
    const firstStore = new FileFusionRoomWorkspaceLeaseStore({ rootForRoom: () => root, now: () => now });
    const secondStore = new FileFusionRoomWorkspaceLeaseStore({ rootForRoom: () => root, now: () => now });
    const first = firstStore.acquire("room-1", ["__root-budget__:message-1"], "run-1", { leaseMs: 5_000 });
    expect(first).toBeDefined();
    expect(secondStore.acquire("room-1", ["__root-budget__:message-1"], "run-2")).toBeUndefined();
    now += 4_999;
    expect(secondStore.acquire("room-1", ["__root-budget__:message-1"], "run-2")).toBeUndefined();
    now += 1;
    expect(secondStore.acquire("room-1", ["__root-budget__:message-1"], "run-2")).toBeDefined();
  });
  test("崩溃遗留的 registry mutex 可回收", () => {
    const root = mkdtempSync(join(tmpdir(), "tagent-room-lease-"));
    cleanup.push(root);
    const mutex = join(root, "audit", ".tagent-leases", ".registry-mutex");
    mkdirSync(mutex, { recursive: true });
    utimesSync(mutex, new Date(0), new Date(0));
    const store = new FileFusionRoomWorkspaceLeaseStore({
      rootForRoom: () => root,
      now: () => 120_000,
    });

    expect(store.acquire("room-1", ["a.txt"], "run-after-crash")).toBeDefined();
  });
});
