/**
 * 知识库文档模板与 kind 元数据（刀 2：公约 / 常识卡模板）。
 *
 * 纯 Markdown 骨架，供管理页「新建」按 kind 预填标题与正文；正文仍由用户在编辑态改写。
 * Agent 侧（kb_propose_save）不调用本文件——Agent 自行生成正文；模板仅服务于人工新建。
 *
 * kind 元数据（标签 / 图标 key）也集中在此，供列表项与新建菜单复用。
 *
 * @see docs/dev/knowledge-base/KB-P1-6-CARD-TEMPLATES-brief.md §B
 */
import type { KnowledgeBaseDocumentKind } from "@tagent/shared";
import { normalizeKnowledgeBaseDocumentKind } from "@tagent/shared";

export type { KnowledgeBaseDocumentKind };

/** kind → 中文标签（列表小标签 / 菜单项 / 详情头用） */
export const KIND_LABELS: Record<KnowledgeBaseDocumentKind, string> = {
  note: "笔记",
  contract: "接口约定",
  norm: "规范",
  snapshot: "常识快照",
};

/** kind → 简短短标签（列表行内紧凑展示） */
export const KIND_SHORT_LABELS: Record<KnowledgeBaseDocumentKind, string> = {
  note: "笔记",
  contract: "公约",
  norm: "规范",
  snapshot: "快照",
};

/** 新建菜单选项（顺序即菜单展示顺序） */
export interface KnowledgeBaseKindOption {
  kind: KnowledgeBaseDocumentKind;
  label: string;
  description: string;
}

/** 新建菜单选项列表：空白笔记 / 接口约定 / 规范 / 常识快照 */
export const KIND_CREATE_OPTIONS: KnowledgeBaseKindOption[] = [
  {
    kind: "note",
    label: "空白笔记",
    description: "从空白 Markdown 开始",
  },
  {
    kind: "contract",
    label: "接口约定",
    description: "入口 / 参数 / 禁忌 / 相关文件",
  },
  {
    kind: "norm",
    label: "规范",
    description: "适用范围 / 必须 / 禁止 / 示例",
  },
  {
    kind: "snapshot",
    label: "常识快照",
    description: "探查时间 / 范围 / 数据 / 如何更新",
  },
];

/** 读取 kind 的人类标签；非法 / 缺省归一为 note */
export function kindLabel(kind: string | undefined): string {
  return KIND_LABELS[normalizeKnowledgeBaseDocumentKind(kind)];
}

/** 读取 kind 的短标签；非法 / 缺省归一为 note */
export function kindShortLabel(kind: string | undefined): string {
  return KIND_SHORT_LABELS[normalizeKnowledgeBaseDocumentKind(kind)];
}

/** 模板生成结果：预填标题 + Markdown 正文骨架 */
export interface KnowledgeBaseDocumentTemplate {
  title: string;
  content: string;
}

/** note：保持现有「未命名文档」空模板 */
export function noteTemplate(): KnowledgeBaseDocumentTemplate {
  return {
    title: "未命名文档",
    content: "# 未命名文档\n\n",
  };
}

/** contract（接口约定）：入口 / 参数 / 禁忌 / 相关文件指针 / 备注 */
export function contractTemplate(): KnowledgeBaseDocumentTemplate {
  return {
    title: "未命名接口约定",
    content: [
      "# 未命名接口约定",
      "",
      "> 一句话说明这个接口 / 模块对外提供什么能力。",
      "",
      "## 概述",
      "",
      "- ",
      "",
      "## 入口（路由 / 函数）",
      "",
      "- 路由 / 函数名：",
      "- 调用方式：",
      "",
      "## 关键参数",
      "",
      "- 参数名 — 类型 — 含义 — 是否必填",
      "- ",
      "",
      "## 约定与禁忌",
      "",
      "- 必须：",
      "- 禁止：",
      "",
      "## 相关文件指针",
      "",
      "- ",
      "",
      "## 备注",
      "",
      "- ",
      "",
    ].join("\n"),
  };
}

/** norm（规范）：适用范围 / 必须做到 / 禁止 / 示例 / 相关文件 */
export function normTemplate(): KnowledgeBaseDocumentTemplate {
  return {
    title: "未命名规范",
    content: [
      "# 未命名规范",
      "",
      "> 一句话说明这条规范约束什么。",
      "",
      "## 适用范围",
      "",
      "- ",
      "",
      "## 必须做到",
      "",
      "- ",
      "",
      "## 禁止",
      "",
      "- ",
      "",
      "## 示例",
      "",
      "```",
      "",
      "```",
      "",
      "## 相关文件",
      "",
      "- ",
      "",
    ].join("\n"),
  };
}

/** snapshot（常识快照）：探查时间 / 范围 / 正文数据区 / 如何更新 */
export function snapshotTemplate(): KnowledgeBaseDocumentTemplate {
  return {
    title: "未命名常识快照",
    content: [
      "# 未命名常识快照",
      "",
      "> 一次探查得到的项目常识 / 统计快照；过期前请复测。",
      "",
      "## 探查时间",
      "",
      "- ",
      "",
      "## 范围",
      "",
      "- ",
      "",
      "## 正文数据区",
      "",
      "- ",
      "",
      "## 如何更新",
      "",
      "- 复测条件：",
      "- 数据来源：",
      "",
    ].join("\n"),
  };
}

const TEMPLATE_BUILDERS: Record<
  KnowledgeBaseDocumentKind,
  () => KnowledgeBaseDocumentTemplate
> = {
  note: noteTemplate,
  contract: contractTemplate,
  norm: normTemplate,
  snapshot: snapshotTemplate,
};

/** 按 kind 取模板（标题 + Markdown 骨架）；非法 / 缺省回退 note 模板 */
export function templateForKind(
  kind: string | undefined,
): KnowledgeBaseDocumentTemplate {
  return TEMPLATE_BUILDERS[normalizeKnowledgeBaseDocumentKind(kind)]();
}
