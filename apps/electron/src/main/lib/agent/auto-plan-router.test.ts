import { describe, expect, it } from "vitest";
import {
  assessAutoKanban,
  assessAutoPlan,
  buildAutoKanbanPrompt,
  buildAutoPlanPrompt,
} from "./auto-plan-router";

describe("auto-plan-router", () => {
  it("简单查询直达", () => {
    expect(assessAutoPlan("帮我查一下今天的金价", "work").shouldPlan).toBe(
      false,
    );
  });

  it("调查、修改、验证的组合自动规划", () => {
    const result = assessAutoPlan(
      "先分析这个 bug，修改相关模块，最后编译并运行测试",
      "work",
    );
    expect(result.shouldPlan).toBe(true);
    expect(
      buildAutoPlanPrompt(
        "先分析这个 bug，修改相关模块，最后编译并运行测试",
        "work",
      ),
    ).toMatch(/EnterPlanMode|ExitPlanMode/);
  });

  it("明确要求看板时自动进入派工路径", () => {
    const result = assessAutoKanban(
      "请开看板，把登录重构、迁移脚本和回归测试分工并行处理",
      "work",
    );
    expect(result).toMatchObject({
      shouldDispatch: true,
      explicit: true,
      reason: "explicit_request",
    });
    expect(
      buildAutoKanbanPrompt(
        "请开看板，把登录重构、迁移脚本和回归测试分工并行处理",
        "work",
      ),
    ).toMatch(
      /kanban_create_board[\s\S]*kanban_add_task[\s\S]*kanban_list_tasks/,
    );
  });

  it("长交付任务自动进入看板，单文件小修直达", () => {
    expect(
      assessAutoKanban(
        "请先分析认证模块，重构服务层和前端状态管理，补充数据库迁移、完善接口文档，最后编译、运行完整测试并整理发布说明。",
        "work",
      ).shouldDispatch,
    ).toBe(true);
    expect(
      assessAutoKanban("只改一个文件里的拼写并运行一次检查", "work")
        .shouldDispatch,
    ).toBe(false);
    expect(
      assessAutoKanban("分析并修复这个问题，然后运行测试", "chat")
        .shouldDispatch,
    ).toBe(false);
    expect(
      assessAutoKanban("分析并修复这个问题，然后运行测试", "work", true)
        .shouldDispatch,
    ).toBe(false);
  });

  it("Chat 和运行中引导不触发自动规划", () => {
    expect(
      assessAutoPlan("分析并修复这个问题，然后运行测试", "chat").shouldPlan,
    ).toBe(false);
    expect(
      assessAutoPlan("分析并修复这个问题，然后运行测试", "work", true)
        .shouldPlan,
    ).toBe(false);
  });
});
