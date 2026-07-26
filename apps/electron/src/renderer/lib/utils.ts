/**
 * 渲染层工具函数
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 tailwind class（clsx + tailwind-merge） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
