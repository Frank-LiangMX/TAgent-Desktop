import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CollaborationRoomService } from "./collaboration-room-service"
import {
  appendRoomEvent,
  listRoomEvents,
} from "./collaboration-room-repository"

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-collab-events-test-"))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
})

describe("RoomEvent 本地账本", () => {
  test("按房间递增序号、幂等键去重并拒绝错误 expectedSequence", () => {
    const first = appendRoomEvent({
      roomId: "cr_events_a",
      type: "room.updated",
      actorUserId: "user-a",
      idempotencyKey: "update-1",
      payload: { title: "A" },
      expectedSequence: 0,
    })
    expect(first.sequence).toBe(1)

    const duplicate = appendRoomEvent({
      roomId: "cr_events_a",
      type: "room.updated",
      actorUserId: "user-a",
      idempotencyKey: "update-1",
      payload: { title: "ignored" },
      expectedSequence: 0,
    })
    expect(duplicate.id).toBe(first.id)
    expect(listRoomEvents("cr_events_a")).toHaveLength(1)

    expect(() =>
      appendRoomEvent({
        roomId: "cr_events_a",
        type: "room.updated",
        actorUserId: "user-b",
        payload: { title: "B" },
        expectedSequence: 0,
      }),
    ).toThrow(/sequence/)
  })

  test("服务层用户消息同时保留旧消息投影和 RoomEvent", () => {
    const service = CollaborationRoomService.create()
    const room = service.createRoom({
      title: "event projection",
      members: [
        {
          displayName: "开发",
          isCoordinator: true,
          permissionProfile: "read-only",
        },
      ],
    })
    const message = service.appendUserMessage({
      roomId: room.id,
      content: "请记录这条事件",
      actorUserId: "local-user",
    })
    const events = service.listRoomEvents(room.id)
    const event = events.find((item) => item.entityId === message.id)
    expect(event?.type).toBe("message.appended")
    expect(event?.actorUserId).toBe("local-user")
    expect(event?.payload).toMatchObject({
      messageId: message.id,
      content: "请记录这条事件",
    })
  })
})