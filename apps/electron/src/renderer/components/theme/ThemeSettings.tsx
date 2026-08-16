/**
 * ThemeSettings — 主题选择（精简色卡）
 *
 * 深浅模式（浅/深/跟随系统）+ 6 色系色卡（default/ocean/forest/slate/orange/purple）。
 * 色卡预览用各主题的 --scene-base-rgb + --scene-a-rgb 渐变（取自 tokens.css 静态值），
 * 不搬 TAgent_General 的 ThemePreview 装饰 SVG。Popover 弹出。
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Popover, PopoverTrigger, PopoverContent, Badge } from '@tagent/ui'
import { Palette } from '@phosphor-icons/react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  themeModeAtom,
  themeStyleAtom,
  systemIsDarkAtom,
  resolvedDarkAtom,
  setThemeMode,
  setThemeStyle,
  type ThemeMode,
  type ThemeStyle,
} from '../../atoms/theme'

/** 各色系色卡预览（scene-base + scene-a 静态 RGB，取自 tokens.css） */
const STYLE_CARDS: { style: ThemeStyle; label: string; light: string; dark: string }[] = [
  { style: 'default', label: '中性', light: 'rgb(217 222 231)', dark: 'rgb(36 38 42)' },
  { style: 'slate', label: '暖砂', light: 'rgb(232 228 222)', dark: 'rgb(38 36 33)' },
  { style: 'ocean', label: '碧海', light: 'rgb(232 238 240)', dark: 'rgb(32 40 42)' },
  { style: 'forest', label: '翠林', light: 'rgb(234 236 228)', dark: 'rgb(36 40 34)' },
  { style: 'orange', label: '琥珀', light: 'rgb(242 228 204)', dark: 'rgb(37 27 20)' },
  { style: 'purple', label: '紫藤', light: 'rgb(234 233 238)', dark: 'rgb(36 34 42)' },
]

const MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
  { mode: 'system', label: '跟随系统' },
]

export function ThemeSettings(): JSX.Element {
  const mode = useAtomValue(themeModeAtom)
  const style = useAtomValue(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const resolvedDark = useAtomValue(resolvedDarkAtom)
  const setMode = useSetAtom(themeModeAtom)
  const setStyle = useSetAtom(themeStyleAtom)

  const handleMode = (m: ThemeMode): void => {
    setMode(m)
    setThemeMode(m, style)
  }
  const handleStyle = (s: ThemeStyle): void => {
    setStyle(s)
    setThemeStyle(s, mode)
  }

  // 色卡预览用当前解析的明暗态
  const previewDark = mode === 'system' ? systemIsDark : mode === 'dark'
  void resolvedDark // 暂留供后续预览细节

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'rail-island-btn titlebar-no-drag flex size-9 items-center justify-center rounded-xl transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Palette size={18} weight="regular" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-3">
        {/* 深浅模式 */}
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">深浅模式</div>
        <div className="mb-3 flex gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.mode}
              onClick={() => handleMode(m.mode)}
              className={cn(
                'flex-1 rounded-glass-popover px-2 py-1.5 text-xs transition-colors',
                'hover:bg-accent',
                mode === m.mode && 'bg-accent font-medium',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* 色系 */}
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">色系</div>
        <div className="grid grid-cols-3 gap-1.5">
          {STYLE_CARDS.map((c) => {
            const active = style === c.style
            return (
              <button
                key={c.style}
                onClick={() => handleStyle(c.style)}
                className={cn(
                  'group relative overflow-hidden rounded-glass-popover border p-1.5 text-left transition-all',
                  active ? 'border-primary/40 ring-2 ring-primary/20' : 'border-border hover:border-foreground/20',
                )}
              >
                {/* 色卡预览：该主题 scene 渐变 */}
                <div
                  className="mb-1 h-8 w-full rounded-[6px]"
                  style={{
                    background: `linear-gradient(135deg, ${previewDark ? c.dark : c.light}, ${
                      previewDark ? c.dark : c.light
                    })`,
                  }}
                />
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium">{c.label}</span>
                  {active && <Check className="size-3 text-primary" />}
                </div>
              </button>
            )
          })}
        </div>

        {mode === 'system' && (
          <div className="mt-2">
            <Badge variant="outline" className="text-[10px]">
              系统：{systemIsDark ? '深色' : '浅色'}
            </Badge>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
