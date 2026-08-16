/**
 * 棰滆壊 Token 婧? *
 * 鏉冨▉瑙嗚婧愶細`prototypes/spatial-theme-study/theme-tokens.css`锛坴4 Spatial Lens锛夈€? *
 * 璁捐鍘熷垯锛? * 1. **绾?65% 杩戜腑鎬х┖闂?+ A/B 鐭跨墿鍏?*锛歴cene-base / glass 杩戞棤鑹诧紝韬唤鍙潬 scene A/B 鍏? * 2. **accent 鍙粰 CTA / focus / 鍏抽敭杩涘害**锛氭槧灏勪负 Tailwind `primary`锛沘ctive 涓€х幓鐠冧笉鏌?accent
 * 3. **ink 鍥涚骇瀛楄壊**锛歠oreground 鈮?ink-strong锛屾鏂?娆¤鐢ㄤ綆 chroma 鍐锋殩瀛楄壊锛屼笉鏁撮〉鏌撹壊
 * 4. **鍏富棰樺喎鏆?*锛歞efault 鐭跨墿鐡峰厜 / ocean 闈掔摲姘村厜 / forest 鑼剁儫姗勬 /
 *    slate 鐜勬鏆栫伆 / orange 鐞ョ弨骞插厜 / purple 楦㈠熬鐑熷厜锛堢闇撹櫣绱級
 * 5. **scene 涓庢潗璐ㄦ浜?*锛氫富棰樺彧瀹?hue / primary / ink / scene锛涙潗璐ㄥ彧鏀?blur/opacity/rim
 *
 * 鍊兼牸寮忥細HSL 涓夊厓缁勫瓧绗︿覆锛堝 "220 14% 96%"锛夛紝涓嶅惈 hsl()锛? * scene-*-rgb / glass-rgb 涓?`r g b` 绌烘牸涓夊厓缁勩€? * 鐢熸垚鍣ㄦ妸姣忎釜 key 浜у嚭 `--{key}` CSS 鍙橀噺銆? */

/** 寮ユ暎娓愬彉鐜鑹蹭笁鍏冪粍锛堢敱姣忎釜 ThemeName 瀹氫箟锛?*/
export interface SceneField {
  /** 寮ユ暎娓愬彉鍩哄簳鑹诧紙绐楀彛搴曡壊锛氭祬鑹茬摲鐧?/ 娣辫壊娣卞簳锛?*/
  base: string
  /** 涓荤幆澧冨厜鏂戣壊锛堝乏涓婂厜鏂?+ glass 鑹叉暎鍙充晶锛涗腑楗卞拰锛屼繚璇佸厜鏂戜笌鑹叉暎鍙锛?*/
  a: string
  /** 娆＄幆澧冨厜鏂戣壊锛堝彸涓嬪厜鏂戯紱鏋佹贰銆俤efault-light 涓烘瀬寮辨殩闆撅紝涓嶆硾榛勶級 */
  b: string
  c: string
  glass: string
  baseRgb: string
  aRgb: string
  aPos: string
  aSize: string
  aStrength: string
  bRgb: string
  bPos: string
  bSize: string
  bStrength: string
  cRgb: string
  cPos: string
  cSize: string
  cStrength: string
}

export interface ThemeColors {
  /** 鑳屾櫙鑹?*/
  background: string
  foreground: string
  muted: string
  'muted-foreground': string
  border: string
  input: string
  ring: string
  primary: string
  'primary-foreground': string
  secondary: string
  'secondary-foreground': string
  accent: string
  'accent-foreground': string
  destructive: string
  'destructive-foreground': string
  card: string
  'card-foreground': string
  popover: string
  'popover-foreground': string
  dialog: string
  'dialog-foreground': string
  tooltip: string
  'tooltip-foreground': string
  'tooltip-muted': string
  'content-area': string
  /** 寮ユ暎娓愬彉鍩哄簳鑹诧紙绐楀彛搴曞眰 scene 鑳屾櫙锛?*/
  'scene-base': string
  /** 涓荤幆澧冨厜鏂戣壊 */
  'scene-ambient-a': string
  /** 娆＄幆澧冨厜鏂戣壊 */
  'scene-ambient-b': string
  'scene-ambient-c': string
  'scene-base-rgb': string
  'scene-a-rgb': string
  'scene-a-pos': string
  'scene-a-size': string
  'scene-a-strength': string
  'scene-b-rgb': string
  'scene-b-pos': string
  'scene-b-size': string
  'scene-b-strength': string
  'scene-c-rgb': string
  'scene-c-pos': string
  'scene-c-size': string
  'scene-c-strength': string
  'glass-rgb': string
}

export type ThemeName =
  | 'default-light'
  | 'default-dark'
  | 'ocean-light'
  | 'ocean-dark'
  | 'forest-light'
  | 'forest-dark'
  | 'slate-light'
  | 'slate-dark'
  | 'orange-light'
  | 'orange-dark'
  | 'purple-light'
  | 'purple-dark'

/**
 * 姣忎釜涓婚鐨?scene 寮ユ暎鐜鑹蹭笁鍏冪粍銆? *
 * 璁捐绾︽潫锛? * - 娴呰壊锛歜ase 楂?lightness锛?4-96%锛夌摲鐧?杩戜腑鎬э紝a 涓ケ鍜屼腑 lightness 鍋氬彲瑙佸厜鏂戯紝
 *   b 鏋佹贰鍋氭瑕佸厜鏂戯紙default-light 鐨?b 鏄瀬寮辨殩闆撅紝sat 鈮?22% 涓嶆硾榛勶級銆? * - 娣辫壊锛歜ase 浣?lightness锛?3-15%锛夋繁搴曪紝a/b 涓轰綆 lightness锛?9-26%锛変富棰樿壊鍏夋枒锛? *   娣辫壊鑳屾櫙闇€瑕佹洿浜殑涓婚鍏夋枒鎵嶈兘璁╁讥鏁ｆ笎鍙樺彲瑙併€? * - a 鍚屾椂鎵挎媴 glass 鑹叉暎鍙充晶鑹诧紝鏁?lightness 涓嶈兘杩囬珮锛堝惁鍒欒壊鏁ｄ笉鍙锛夈€? */
function scene(
  base: string,
  a: string,
  b: string,
  c: string,
  glass: string,
  field: Omit<SceneField, 'base' | 'a' | 'b' | 'c' | 'glass'>
): SceneField {
  return { base, a, b, c, glass, ...field }
}

const SCENE: Record<ThemeName, SceneField> = {
  // 默认浅色：对齐 layout-direction-study 冷灰蓝底 + 高透淡蓝光斑（禁止暖瓷白平板）
  'default-light': scene('218 16% 88%', '211 28% 78%', '8 24% 78%', '152 22% 72%', '248 250 253', {
    baseRgb: '217 222 231', // #d9dee7 冷灰底
    // A：淡冷蓝雾（强度克制，勿压成色斑）
    aRgb: '168 196 224',
    aPos: '36% 10%',
    aSize: '42% 48%',
    aStrength: '0.22',
    bRgb: '216 184 180', // 右下：灰玫瑰
    bPos: '82% 78%',
    bSize: '52% 58%',
    bStrength: '0.22',
    cRgb: '168 200 186', // 下中：薄荷（离开左缘，避免与 A 叠亮）
    cPos: '48% 88%',
    cSize: '40% 46%',
    cStrength: '0.22',
  }),
  'default-dark': scene('220 8% 15%', '211 28% 37%', '8 16% 28%', '152 14% 22%', '50 52 56', {
    baseRgb: '36 38 42',
    aRgb: '68 94 122',
    aPos: '36% 10%',
    aSize: '42% 48%',
    aStrength: '0.34',
    bRgb: '88 64 62',
    bPos: '82% 78%',
    bSize: '52% 58%',
    bStrength: '0.18',
    cRgb: '48 68 58',
    cPos: '48% 88%',
    cSize: '40% 46%',
    cStrength: '0.2',
  }),
  // Ocean 澶╅潚锛氶潚/teal 鍏夋枒
  'ocean-light': scene('195 21% 93%', '196 42% 62%', '35 40% 81%', '203 9% 67%', '250 252 252', {
    baseRgb: '232 238 240',
    aRgb: '120 176 196',
    aPos: '16% 12%',
    aSize: '40% 44%',
    aStrength: '0.26',
    bRgb: '226 210 188',
    bPos: '86% 84%',
    bSize: '36% 40%',
    bStrength: '0.14',
    cRgb: '164 174 180',
    cPos: '50% 100%',
    cSize: '76% 38%',
    cStrength: '0.13',
  }),
  'ocean-dark': scene('192 14% 15%', '191 41% 29%', '33 20% 25%', '195 9% 17%', '48 54 56', {
    baseRgb: '32 40 42',
    aRgb: '44 92 104',
    aPos: '16% 12%',
    aSize: '40% 44%',
    aStrength: '0.26',
    bRgb: '78 66 52',
    bPos: '86% 84%',
    bSize: '36% 40%',
    bStrength: '0.16',
    cRgb: '40 46 48',
    cPos: '50% 100%',
    cSize: '76% 38%',
    cStrength: '0.15',
  }),
  // Moss 闈掕嫈锛氱豢鍏夋枒
  'forest-light': scene('75 17% 91%', '116 25% 64%', '36 36% 75%', '90 7% 66%', '250 250 246', {
    baseRgb: '234 236 228',
    aRgb: '148 184 142',
    aPos: '16% 12%',
    aSize: '38% 42%',
    aStrength: '0.26',
    bRgb: '218 196 162',
    bPos: '84% 16%',
    bSize: '36% 40%',
    bStrength: '0.14',
    cRgb: '168 174 162',
    cPos: '78% 96%',
    cSize: '42% 34%',
    cStrength: '0.14',
  }),
  'forest-dark': scene('100 8% 15%', '128 23% 29%', '35 25% 26%', '100 7% 18%', '52 54 50', {
    baseRgb: '36 40 34',
    aRgb: '58 92 64',
    aPos: '16% 12%',
    aSize: '38% 42%',
    aStrength: '0.26',
    bRgb: '84 70 50',
    bPos: '84% 16%',
    bSize: '36% 40%',
    bStrength: '0.16',
    cRgb: '44 48 42',
    cPos: '78% 96%',
    cSize: '42% 34%',
    cStrength: '0.16',
  }),
  // 暖砂：亚麻 / 灰褐矿砂，低饱和，冷石板当副光
  'slate-light': scene('36 10% 90%', '32 16% 70%', '208 10% 72%', '30 7% 64%', '248 246 242', {
    baseRgb: '232 228 222',
    aRgb: '191 179 164',
    aPos: '22% 8%',
    aSize: '38% 42%',
    aStrength: '0.22',
    bRgb: '176 184 191',
    bPos: '88% 86%',
    bSize: '36% 40%',
    bStrength: '0.18',
    cRgb: '168 163 156',
    cPos: '12% 92%',
    cSize: '38% 36%',
    cStrength: '0.14',
  }),
  'slate-dark': scene('32 7% 14%', '30 14% 28%', '208 10% 26%', '28 6% 18%', '52 50 48', {
    baseRgb: '38 36 33',
    aRgb: '82 72 61',
    aPos: '22% 8%',
    aSize: '38% 42%',
    aStrength: '0.24',
    bRgb: '60 66 72',
    bPos: '88% 86%',
    bSize: '36% 40%',
    bStrength: '0.18',
    cRgb: '48 46 43',
    cPos: '12% 92%',
    cSize: '38% 36%',
    cStrength: '0.16',
  }),
  // 琥珀：蜂蜜铜金，高饱和琥珀光，副光走赤铜而不是蓝灰
  'orange-light': scene('36 40% 90%', '34 70% 58%', '16 50% 56%', '38 24% 64%', '253 248 236', {
    baseRgb: '242 228 204',
    aRgb: '224 158 64',
    aPos: '16% 8%',
    aSize: '42% 46%',
    aStrength: '0.34',
    bRgb: '204 118 71',
    bPos: '86% 80%',
    bSize: '38% 42%',
    bStrength: '0.24',
    cRgb: '186 168 130',
    cPos: '52% 100%',
    cSize: '74% 38%',
    cStrength: '0.16',
  }),
  'orange-dark': scene('26 20% 12%', '32 56% 30%', '14 40% 24%', '34 16% 16%', '58 46 34', {
    baseRgb: '37 27 20',
    aRgb: '119 76 34',
    aPos: '16% 8%',
    aSize: '42% 46%',
    aStrength: '0.36',
    bRgb: '86 47 37',
    bPos: '86% 80%',
    bSize: '38% 42%',
    bStrength: '0.22',
    cRgb: '47 40 34',
    cPos: '52% 100%',
    cSize: '74% 38%',
    cStrength: '0.16',
  }),
  // 绱棨
  'purple-light': scene('252 12% 92%', '249 28% 71%', '38 34% 78%', '240 6% 69%', '251 250 253', {
    baseRgb: '234 233 238',
    aRgb: '168 160 204',
    aPos: '16% 12%',
    aSize: '38% 42%',
    aStrength: '0.26',
    bRgb: '218 204 180',
    bPos: '88% 28%',
    bSize: '34% 32%',
    bStrength: '0.14',
    cRgb: '172 172 182',
    cPos: '50% 100%',
    cSize: '76% 38%',
    cStrength: '0.13',
  }),
  'purple-dark': scene('255 11% 15%', '253 22% 33%', '35 19% 25%', '240 6% 18%', '52 51 56', {
    baseRgb: '36 34 42',
    aRgb: '74 66 104',
    aPos: '16% 12%',
    aSize: '38% 42%',
    aStrength: '0.26',
    bRgb: '76 66 52',
    bPos: '88% 28%',
    bSize: '34% 32%',
    bStrength: '0.14',
    cRgb: '44 44 50',
    cPos: '50% 100%',
    cSize: '76% 38%',
    cStrength: '0.15',
  }),
}

/**
 * Ink + Accent 璇箟鑹诧紙瀵归綈 spatial-theme-study theme-tokens.css v4锛夈€? * RGB 婧愯鍘熷瀷娉ㄩ噴锛涙澶勪负 HSL 涓夊厓缁勪緵 shadcn / Tailwind 娑堣垂銆? */
interface ThemeInkAccent {
  /** 琛ㄩ潰鏃?hue锛堟瀬浣?sat锛屼笉鎵胯浇涓婚韬唤锛?*/
  hue: number
  /** CTA / focus / ring 鈥斺€?鍘熷瀷 --accent-rgb */
  primary: string
  'primary-foreground': string
  /** 姝ｆ枃涓昏壊 鈥斺€?鍘熷瀷 --ink-strong-rgb */
  foreground: string
  /** 娆¤璇存槑 鈥斺€?鍘熷瀷 --ink-muted-rgb */
  'muted-foreground': string
  /** 姝ｆ枃娆＄骇 / card 瀛楄壊 鈥斺€?鍘熷瀷 --ink-rgb */
  ink: string
  /** 寮辨爣绛?鈥斺€?鍘熷瀷 --ink-faint-rgb */
  faint: string
}

/**
 * 鍏富棰?脳 鏄庢殫 ink/accent锛岀洿鎺ョ敱鍘熷瀷 RGB 鎹㈢畻锛? * default #48566C / ocean #306068 / forest #44644E /
 * slate #946044 / orange #A07038 / purple #5C5476
 */
const INK_ACCENT: Record<ThemeName, ThemeInkAccent> = {
  'default-light': {
    // 冷灰蓝壳层（对齐 layout-direction-study --ink / body 底），不用暖黄瓷白
    hue: 218,
    primary: '217 20% 35%',
    'primary-foreground': '0 0% 100%',
    foreground: '216 11% 18%',
    // 原型 ink-muted 在浅底上 < AA；压到 L42% 保次要文字对比
    'muted-foreground': '218 8% 42%',
    ink: '220 8% 30%',
    faint: '220 6% 63%',
  },
  'default-dark': {
    hue: 220,
    primary: '218 19% 62%',
    'primary-foreground': '216 17% 11%',
    foreground: '220 14% 91%',
    'muted-foreground': '220 8% 58%',
    ink: '216 11% 82%',
    faint: '220 9% 41%',
  },
  'ocean-light': {
    hue: 195,
    primary: '189 37% 30%',
    'primary-foreground': '0 0% 100%',
    foreground: '195 17% 18%',
    'muted-foreground': '192 10% 40%',
    ink: '192 14% 28%',
    faint: '190 6% 60%',
  },
  'ocean-dark': {
    hue: 192,
    primary: '186 24% 52%',
    'primary-foreground': '180 15% 10%',
    foreground: '180 16% 90%',
    'muted-foreground': '171 6% 55%',
    ink: '170 12% 81%',
    faint: '171 7% 38%',
  },
  'forest-light': {
    hue: 90,
    primary: '139 19% 33%',
    'primary-foreground': '0 0% 100%',
    foreground: '105 8% 19%',
    'muted-foreground': '110 6% 40%',
    ink: '100 8% 29%',
    faint: '100 6% 60%',
  },
  'forest-dark': {
    hue: 100,
    primary: '131 14% 55%',
    'primary-foreground': '120 15% 10%',
    foreground: '100 12% 90%',
    'muted-foreground': '103 6% 54%',
    ink: '108 10% 80%',
    faint: '105 9% 37%',
  },
  'slate-light': {
    hue: 32,
    primary: '28 18% 36%',
    'primary-foreground': '0 0% 100%',
    foreground: '32 6% 18%',
    'muted-foreground': '32 5% 40%',
    ink: '30 6% 28%',
    faint: '32 5% 60%',
  },
  'slate-dark': {
    hue: 32,
    primary: '30 16% 62%',
    'primary-foreground': '30 12% 10%',
    foreground: '34 6% 90%',
    'muted-foreground': '32 5% 56%',
    ink: '32 6% 80%',
    faint: '32 5% 38%',
  },
  'orange-light': {
    hue: 30,
    primary: '30 66% 40%',
    'primary-foreground': '0 0% 100%',
    foreground: '26 28% 16%',
    'muted-foreground': '28 18% 38%',
    ink: '26 22% 26%',
    faint: '32 20% 56%',
  },
  'orange-dark': {
    hue: 30,
    primary: '32 64% 58%',
    'primary-foreground': '26 40% 10%',
    foreground: '36 28% 91%',
    'muted-foreground': '32 16% 62%',
    ink: '34 20% 80%',
    faint: '32 14% 40%',
  },
  'purple-light': {
    hue: 255,
    primary: '254 17% 40%',
    'primary-foreground': '0 0% 100%',
    foreground: '252 10% 20%',
    'muted-foreground': '255 8% 42%',
    ink: '257 9% 30%',
    faint: '257 7% 62%',
  },
  'purple-dark': {
    hue: 255,
    primary: '255 17% 63%',
    'primary-foreground': '255 14% 11%',
    foreground: '260 12% 90%',
    'muted-foreground': '249 6% 55%',
    ink: '252 10% 81%',
    faint: '250 6% 38%',
  },
}

function sceneTokens(
  scene: SceneField
): Pick<
  ThemeColors,
  | 'scene-base'
  | 'scene-ambient-a'
  | 'scene-ambient-b'
  | 'scene-ambient-c'
  | 'scene-base-rgb'
  | 'scene-a-rgb'
  | 'scene-a-pos'
  | 'scene-a-size'
  | 'scene-a-strength'
  | 'scene-b-rgb'
  | 'scene-b-pos'
  | 'scene-b-size'
  | 'scene-b-strength'
  | 'scene-c-rgb'
  | 'scene-c-pos'
  | 'scene-c-size'
  | 'scene-c-strength'
  | 'glass-rgb'
> {
  return {
    'scene-base': scene.base,
    'scene-ambient-a': scene.a,
    'scene-ambient-b': scene.b,
    'scene-ambient-c': scene.c,
    'scene-base-rgb': scene.baseRgb,
    'scene-a-rgb': scene.aRgb,
    'scene-a-pos': scene.aPos,
    'scene-a-size': scene.aSize,
    'scene-a-strength': scene.aStrength,
    'scene-b-rgb': scene.bRgb,
    'scene-b-pos': scene.bPos,
    'scene-b-size': scene.bSize,
    'scene-b-strength': scene.bStrength,
    'scene-c-rgb': scene.cRgb,
    'scene-c-pos': scene.cPos,
    'scene-c-size': scene.cSize,
    'scene-c-strength': scene.cStrength,
    'glass-rgb': scene.glass,
  }
}

/**
 * 娴呰壊杩戜腑鎬ц〃闈€? * 琛ㄩ潰 chroma 鏋佷綆锛?鈥?0%锛夛紝涓嶆暣椤垫煋鑹诧紱primary/ink 鏉ヨ嚜鍘熷瀷銆? * Tailwind `accent` 浠嶆槸 hover 娴呭簳锛堥潪 solid CTA锛夆€斺€?涓庡師鍨嬨€宎ctive 涓€с€嶄竴鑷淬€? */
function lightPalette(ink: ThemeInkAccent, scene: SceneField): ThemeColors {
  const h = String(ink.hue)
  return {
    // 璐磋繎 scene-base 鐨勬瀬娣″簳锛岄伩鍏嶇洊浣忓讥鏁ｅ満
    background: `${h} 8% 93%`,
    foreground: ink.foreground,
    muted: `${h} 6% 90%`,
    'muted-foreground': ink['muted-foreground'],
    border: `${h} 6% 86%`,
    input: `${h} 6% 86%`,
    ring: ink.primary,
    primary: ink.primary,
    'primary-foreground': ink['primary-foreground'],
    secondary: `${h} 6% 92%`,
    'secondary-foreground': ink.ink,
    // hover/閫変腑娴呭簳锛岀姝㈢粦 solid primary锛坓host 浼氭暣鍧楁煋鑹诧級
    accent: `${h} 8% 90%`,
    'accent-foreground': ink.ink,
    destructive: '0 50% 52%',
    'destructive-foreground': '0 0% 98%',
    // 杩戞棤鑹茬摲闈紝瀵归綈鍘熷瀷 glass-rgb
    card: `${h} 10% 97%`,
    'card-foreground': ink.foreground,
    popover: `${h} 10% 97%`,
    'popover-foreground': ink.foreground,
    dialog: `${h} 12% 98%`,
    'dialog-foreground': ink.foreground,
    tooltip: `${h} 12% 98%`,
    'tooltip-foreground': ink.foreground,
    'tooltip-muted': ink.faint,
    'content-area': `${h} 7% 94%`,
    ...sceneTokens(scene),
  }
}

/** 鏆楄壊杩戜腑鎬ц〃闈紙瀵归綈鍘熷瀷娣卞簳 ink + 鎻愪寒 accent锛?*/
function darkPalette(ink: ThemeInkAccent, scene: SceneField): ThemeColors {
  const h = String(ink.hue)
  return {
    background: `${h} 10% 15%`,
    foreground: ink.foreground,
    muted: `${h} 8% 19%`,
    'muted-foreground': ink['muted-foreground'],
    border: `${h} 8% 22%`,
    input: `${h} 8% 22%`,
    ring: ink.primary,
    primary: ink.primary,
    'primary-foreground': ink['primary-foreground'],
    secondary: `${h} 8% 18%`,
    'secondary-foreground': ink.ink,
    accent: `${h} 8% 22%`,
    'accent-foreground': ink.ink,
    destructive: '0 50% 58%',
    'destructive-foreground': ink['primary-foreground'],
    card: `${h} 10% 16%`,
    'card-foreground': ink.foreground,
    popover: `${h} 10% 16%`,
    'popover-foreground': ink.foreground,
    dialog: `${h} 10% 18%`,
    'dialog-foreground': ink.foreground,
    tooltip: `${h} 10% 20%`,
    'tooltip-foreground': ink.foreground,
    'tooltip-muted': ink.faint,
    'content-area': `${h} 10% 14%`,
    ...sceneTokens(scene),
  }
}

/**
 * Spatial Lens 鑹茶〃锛堝榻?prototypes/spatial-theme-study锛? *
 * primary = 鍘熷瀷 accent锛堜綆 chroma 鐭跨墿鑹诧紝闈炰寒鐭胯摑/闇撹櫣绱級锛? * - default 鐭冲ⅷ钃濈伆 #48566C
 * - ocean 娣遍潚鐡?#306068
 * - forest 娣辫尪缁?#44644E
 * - slate 閾滈攬妫?#946044
 * - orange 閲戣 #A07038
 * - purple 娣遍涪灏剧伆 #5C5476锛坈hroma鈮?.08锛? */
export const colors: Record<ThemeName, ThemeColors> = {
  'default-light': lightPalette(INK_ACCENT['default-light'], SCENE['default-light']),
  'default-dark': darkPalette(INK_ACCENT['default-dark'], SCENE['default-dark']),

  'ocean-light': lightPalette(INK_ACCENT['ocean-light'], SCENE['ocean-light']),
  'ocean-dark': darkPalette(INK_ACCENT['ocean-dark'], SCENE['ocean-dark']),

  'forest-light': lightPalette(INK_ACCENT['forest-light'], SCENE['forest-light']),
  'forest-dark': darkPalette(INK_ACCENT['forest-dark'], SCENE['forest-dark']),

  'slate-light': lightPalette(INK_ACCENT['slate-light'], SCENE['slate-light']),
  'slate-dark': darkPalette(INK_ACCENT['slate-dark'], SCENE['slate-dark']),

  'orange-light': lightPalette(INK_ACCENT['orange-light'], SCENE['orange-light']),
  'orange-dark': darkPalette(INK_ACCENT['orange-dark'], SCENE['orange-dark']),

  'purple-light': lightPalette(INK_ACCENT['purple-light'], SCENE['purple-light']),
  'purple-dark': darkPalette(INK_ACCENT['purple-dark'], SCENE['purple-dark']),
}

/**
 * Tailwind 棰滆壊 token 鏄犲皠
 *
 * 鎶?CSS 鍙橀噺妗ユ帴鍒?Tailwind colors 閰嶇疆锛岃缁勪欢鐢?`bg-background` / `text-foreground` 绛夌被銆? * 杩欓噷闆嗕腑瀹氫箟锛岄伩鍏嶆暎钀藉湪 tailwind.config.js銆? */
export const tailwindColorTokens = {
  border: 'hsl(var(--border) / <alpha-value>)',
  input: 'hsl(var(--input))',
  ring: 'hsl(var(--ring))',
  background: 'hsl(var(--background) / <alpha-value>)',
  foreground: 'hsl(var(--foreground) / <alpha-value>)',
  primary: {
    DEFAULT: 'hsl(var(--primary))',
    foreground: 'hsl(var(--primary-foreground))',
  },
  secondary: {
    DEFAULT: 'hsl(var(--secondary))',
    foreground: 'hsl(var(--secondary-foreground))',
  },
  muted: {
    DEFAULT: 'hsl(var(--muted))',
    foreground: 'hsl(var(--muted-foreground))',
  },
  accent: {
    DEFAULT: 'hsl(var(--accent))',
    foreground: 'hsl(var(--accent-foreground))',
  },
  destructive: {
    DEFAULT: 'hsl(var(--destructive))',
    foreground: 'hsl(var(--destructive-foreground))',
  },
  card: {
    DEFAULT: 'hsl(var(--card))',
    foreground: 'hsl(var(--card-foreground))',
  },
  popover: {
    DEFAULT: 'hsl(var(--popover))',
    foreground: 'hsl(var(--popover-foreground))',
  },
  dialog: {
    DEFAULT: 'hsl(var(--dialog))',
    foreground: 'hsl(var(--dialog-foreground))',
  },
  tooltip: {
    DEFAULT: 'hsl(var(--tooltip) / <alpha-value>)',
    foreground: 'hsl(var(--tooltip-foreground) / <alpha-value>)',
    muted: 'hsl(var(--tooltip-muted) / <alpha-value>)',
  },
  'content-area': 'hsl(var(--content-area) / <alpha-value>)',
} as const
