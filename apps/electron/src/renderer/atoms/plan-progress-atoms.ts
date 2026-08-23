import { atom } from "jotai";
import type { PlanProgress } from "../components/chat/plan-progress-model";

/** 当前会话的计划快照，跨 Chat 实例保留，避免切换标签页后计划卡消失。 */
export const sessionPlanProgressAtom = atom<Record<string, PlanProgress>>({});
