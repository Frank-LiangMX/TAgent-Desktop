import { describe, expect, test } from "vitest";
import {
  KIND_CREATE_OPTIONS,
  KIND_LABELS,
  KIND_SHORT_LABELS,
  contractTemplate,
  kindLabel,
  kindShortLabel,
  noteTemplate,
  normTemplate,
  snapshotTemplate,
  templateForKind,
} from "./kb-document-templates";

describe("kb-document-templates", () => {
  test("contract 模板含接口约定关键标题锚点", () => {
    const tpl = contractTemplate();
    expect(tpl.title).toBe("未命名接口约定");
    expect(tpl.content.trim()).not.toBe("");
    for (const anchor of [
      "## 概述",
      "## 入口（路由 / 函数）",
      "## 关键参数",
      "## 约定与禁忌",
      "## 相关文件指针",
      "## 备注",
    ]) {
      expect(tpl.content).toContain(anchor);
    }
    // 首行是 H1 标题
    expect(tpl.content.startsWith("# 未命名接口约定")).toBe(true);
  });

  test("norm 模板含规范关键标题锚点", () => {
    const tpl = normTemplate();
    expect(tpl.title).toBe("未命名规范");
    expect(tpl.content.trim()).not.toBe("");
    for (const anchor of [
      "## 适用范围",
      "## 必须做到",
      "## 禁止",
      "## 示例",
      "## 相关文件",
    ]) {
      expect(tpl.content).toContain(anchor);
    }
    expect(tpl.content.startsWith("# 未命名规范")).toBe(true);
  });

  test("snapshot 模板含常识快照关键标题锚点", () => {
    const tpl = snapshotTemplate();
    expect(tpl.title).toBe("未命名常识快照");
    expect(tpl.content.trim()).not.toBe("");
    for (const anchor of [
      "## 探查时间",
      "## 范围",
      "## 正文数据区",
      "## 如何更新",
    ]) {
      expect(tpl.content).toContain(anchor);
    }
    expect(tpl.content.startsWith("# 未命名常识快照")).toBe(true);
  });

  test("note 模板保持「未命名文档」空模板", () => {
    const tpl = noteTemplate();
    expect(tpl.title).toBe("未命名文档");
    expect(tpl.content).toBe("# 未命名文档\n\n");
  });

  test("templateForKind 按 kind 取模板；非法/缺省回退 note", () => {
    expect(templateForKind("contract").title).toBe("未命名接口约定");
    expect(templateForKind("norm").title).toBe("未命名规范");
    expect(templateForKind("snapshot").title).toBe("未命名常识快照");
    expect(templateForKind("note").title).toBe("未命名文档");
    // 缺省 / 非法 → note 模板
    expect(templateForKind(undefined).title).toBe("未命名文档");
    expect(templateForKind("garbage").title).toBe("未命名文档");
    // 各 kind 正文互不相同（非空且彼此不同）
    const titles = [
      templateForKind("note").content,
      templateForKind("contract").content,
      templateForKind("norm").content,
      templateForKind("snapshot").content,
    ];
    expect(new Set(titles).size).toBe(4);
  });

  test("kindLabel / kindShortLabel 缺省/非法归一为 note", () => {
    expect(kindLabel("contract")).toBe("接口约定");
    expect(kindLabel("norm")).toBe("规范");
    expect(kindLabel("snapshot")).toBe("常识快照");
    expect(kindLabel("note")).toBe("笔记");
    expect(kindLabel(undefined)).toBe("笔记");
    expect(kindLabel("garbage")).toBe("笔记");

    expect(kindShortLabel("contract")).toBe("公约");
    expect(kindShortLabel("snapshot")).toBe("快照");
    expect(kindShortLabel(undefined)).toBe("笔记");
  });

  test("KIND_CREATE_OPTIONS 覆盖四种 kind 且无重复", () => {
    const kinds = KIND_CREATE_OPTIONS.map((o) => o.kind);
    expect(kinds).toEqual(["note", "contract", "norm", "snapshot"]);
    expect(new Set(kinds).size).toBe(4);
    // 每个选项有非空 label / description
    for (const option of KIND_CREATE_OPTIONS) {
      expect(option.label.trim()).not.toBe("");
      expect(option.description.trim()).not.toBe("");
      // label 与元数据表一致
      expect(KIND_LABELS[option.kind]).toBeTruthy();
      expect(KIND_SHORT_LABELS[option.kind]).toBeTruthy();
    }
  });
});
