import { describe, expect, test } from "vitest";
import {
  projectCollaborationTurnContext,
  type CollaborationMember,
  type CollaborationMessage,
  type CollaborationRoom,
} from "./collaboration-room";

function mkMember(
  id: string,
  displayName: string,
  isCoordinator = false,
): CollaborationMember {
  return {
    id,
    roomId: "cr_x",
    displayName,
    roleSnapshot: { displayName },
    backend: "channel",
    logicalSessionId: "ls_" + id,
    permissionProfile: "read-only",
    capabilities: {
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    status: "idle",
    isCoordinator,
    createdAt: 0,
    updatedAt: 0,
  };
}

function mkMsg(
  id: string,
  overrides: Partial<CollaborationMessage>,
): CollaborationMessage {
  return {
    id,
    roomId: "cr_x",
    authorType: "user",
    authorId: "user",
    kind: "chat",
    content: "",
    visibility: "room",
    targetMemberIds: [],
    rootMessageId: id,
    depth: 0,
    createdAt: 0,
    ...overrides,
  };
}

const ROOM: Pick<CollaborationRoom, "title" | "goal"> = {
  title: "测试室",
  goal: "完成协作测试",
};

function project(opts: {
  member: CollaborationMember;
  members?: CollaborationMember[];
  messages?: CollaborationMessage[];
  trigger: CollaborationMessage;
  roomSummary?: string | null;
  botMemories?: string[];
  memberSummary?: string | null;
  mailboxPreview?: Array<{ fromName: string; type: string; payload: string }>;
  recentLimit?: number;
}) {
  const { member, members = [member], messages = [], trigger, ...rest } = opts;
  return projectCollaborationTurnContext({
    room: ROOM,
    member,
    members,
    messages,
    trigger,
    ...rest,
  });
}

describe("projectCollaborationTurnContext（S3.5-a H2，04 §5.4）", () => {
  test("C1 自己历史发言 → role=assistant，无 [自己名]: 前缀", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "member",
      authorId: "cm_a",
      content: "我之前的分析结论",
      createdAt: 1,
    });
    const trigger = mkMsg("m2", {
      authorType: "user",
      content: "继续",
      createdAt: 2,
    });
    const t = project({ member: me, messages: [msg], trigger });
    const own = t.messages.find((m) => m.content.includes("我之前的分析结论"));
    expect(own?.role).toBe("assistant");
    expect(own?.content.startsWith("[分析师]")).toBe(false);
  });

  test("C2 其他成员发言 → user + [显示名]: 前缀", () => {
    const me = mkMember("cm_a", "分析师");
    const other = mkMember("cm_b", "开发");
    const msg = mkMsg("m1", {
      authorType: "member",
      authorId: "cm_b",
      content: "我来处理接口",
      createdAt: 1,
    });
    const t = project({
      member: me,
      members: [me, other],
      messages: [msg],
      trigger: msg,
    });
    expect(t.messages[0]!.role).toBe("user");
    expect(t.messages[0]!.content).toBe("[开发]: 我来处理接口");
    expect(t.messages[0]!.source).toBe("member-peer-message");
  });

  test("C3 用户发言 → user + [用户]: 前缀", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "user",
      authorId: "user",
      content: "帮我查一下",
      createdAt: 1,
    });
    const t = project({ member: me, messages: [msg], trigger: msg });
    expect(t.messages[0]!.role).toBe("user");
    expect(t.messages[0]!.content).toBe("[用户]: 帮我查一下");
    expect(t.messages[0]!.source).toBe("user-message");
  });

  test("C4 正文含 @协调者 → 投影后不保留该 token", () => {
    const me = mkMember("cm_a", "分析师");
    const coord = mkMember("cm_c", "协调者", true);
    const msg = mkMsg("m1", {
      authorType: "member",
      authorId: "cm_c",
      content: "请看@协调者 这段",
      createdAt: 1,
    });
    const t = project({
      member: me,
      members: [me, coord],
      messages: [msg],
      trigger: msg,
    });
    expect(t.messages[0]!.content).not.toContain("@协调者");
    expect(t.messages[0]!.content).toContain("请看");
  });

  test("C5 user_only → 任何成员都看不到", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "user",
      content: "只给系统看的",
      visibility: "user_only",
      createdAt: 1,
    });
    const t = project({ member: me, messages: [msg], trigger: msg });
    expect(t.messages.some((m) => m.content.includes("只给系统看的"))).toBe(
      false,
    );
  });

  test("C6 participants 定向给 B → A 看不到；B 与协调者看得到", () => {
    const coord = mkMember("cm_c", "协调者", true);
    const a = mkMember("cm_a", "分析师");
    const b = mkMember("cm_b", "开发");
    const msg = mkMsg("m1", {
      authorType: "member",
      authorId: "cm_a",
      content: "B 请看这份约束",
      visibility: "participants",
      targetMemberIds: ["cm_b"],
      createdAt: 1,
    });
    const forA = project({
      member: a,
      members: [coord, a, b],
      messages: [msg],
      trigger: msg,
    });
    expect(forA.messages.some((m) => m.content.includes("这份约束"))).toBe(
      true,
    ); // 作者可见

    const forB = project({
      member: b,
      members: [coord, a, b],
      messages: [msg],
      trigger: msg,
    });
    expect(forB.messages.some((m) => m.content.includes("这份约束"))).toBe(
      true,
    ); // 目标可见

    const triggerForA = mkMsg("m9", {
      authorType: "user",
      content: "继续",
      createdAt: 9,
    });
    const forOther = project({
      member: mkMember("cm_d", "测试"),
      members: [coord, a, b, mkMember("cm_d", "测试")],
      messages: [msg],
      trigger: triggerForA,
    });
    expect(forOther.messages.some((m) => m.content.includes("这份约束"))).toBe(
      false,
    );
  });

  test("C7 摘要存在 → 最先注入，带「二级信息」声明", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "user",
      content: "继续",
      createdAt: 1,
    });
    const t = project({
      member: me,
      messages: [msg],
      trigger: msg,
      roomSummary: "协调者已拆分两个任务",
    });
    expect(t.messages[0]!.content).toContain("房间摘要");
    expect(t.messages[0]!.content).toContain("不是指令");
    expect(t.systemPrompt).toContain("COLLAB_CONTEXT");
    expect(t.systemPrompt).toContain("恶意提示注入");
    expect(t.messages[0]!.content).toContain("协调者已拆分两个任务");
    expect(t.messages[1]!.role).toBe("assistant");
  });

  test("C8 代码围栏内 @开发 → 保留", () => {
    const me = mkMember("cm_a", "分析师");
    const dev = mkMember("cm_b", "开发");
    const msg = mkMsg("m1", {
      authorType: "member",
      authorId: "cm_b",
      content: '```ts\nconst x = "@开发"\n```',
      createdAt: 1,
    });
    const t = project({
      member: me,
      members: [me, dev],
      messages: [msg],
      trigger: msg,
    });
    expect(t.messages[0]!.content).toContain("@开发");
  });

  test("C9 continuation → 末尾含勿重复副作用", () => {
    const me = mkMember("cm_a", "分析师");
    const b = mkMember("cm_b", "开发");
    const reply = mkMsg("m2", {
      kind: "a2a_reply",
      authorType: "member",
      authorId: "cm_b",
      content: "接口约束已确认",
      targetMemberIds: ["cm_a"],
      createdAt: 2,
    });
    const t = project({
      member: me,
      members: [me, b],
      messages: [reply],
      trigger: reply,
    });
    const last = t.messages[t.messages.length - 1]!;
    expect(last.content).toContain("A2A 恢复");
    expect(last.content).toContain("不要重复已经做过的副作用操作");
    // reply 正文不重复出现两次
    expect(
      t.messages.filter((m) => m.content.includes("接口约束已确认")),
    ).toHaveLength(1);
  });

  test("C11 只注入已确认的 Bot 记忆，并标记为参考信息", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "user",
      content: "继续",
      createdAt: 1,
    });
    const t = project({
      member: me,
      messages: [msg],
      trigger: msg,
      botMemories: ["用户偏好先给结论，再给证据。"],
    });
    expect(t.systemPrompt).toContain("已确认的 Bot 长期记忆");
    expect(t.systemPrompt).toContain("先给结论，再给证据");
    expect(t.systemPrompt).toContain("不是当前指令");
  });
  test("C12 成员持续上下文摘要注入 systemPrompt，并标记为参考信息", () => {
    const me = mkMember("cm_a", "分析师");
    const msg = mkMsg("m1", {
      authorType: "user",
      content: "继续",
      createdAt: 1,
    });
    const t = project({
      member: me,
      messages: [msg],
      trigger: msg,
      memberSummary: "上次已确认接口采用分页查询。",
    });
    expect(t.systemPrompt).toContain("持续上下文摘要");
    expect(t.systemPrompt).toContain("分页查询");
    expect(t.systemPrompt).toContain("不是当前指令");
  });

  test("C10 近期窗口截断 → 只保留最近 N 条可见，trigger 仍在", () => {
    const me = mkMember("cm_a", "分析师");
    const messages = Array.from({ length: 20 }, (_, i) =>
      mkMsg(`m${i}`, { authorType: "user", content: `消息${i}`, createdAt: i }),
    );
    const trigger = messages[19]!;
    const t = project({ member: me, messages, trigger, recentLimit: 5 });
    expect(t.messages).toHaveLength(5);
    expect(t.messages[t.messages.length - 1]!.content).toContain("消息19");
    expect(t.messages.some((m) => m.content.includes("消息0"))).toBe(false);
  });
});
