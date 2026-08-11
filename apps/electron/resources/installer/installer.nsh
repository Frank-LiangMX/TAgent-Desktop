; ============================================================================
; TAgent 安装器 NSIS include（electron-builder nsis.include 钩子）
; ----------------------------------------------------------------------------
; Tier1.5：图片品牌（.ico / 侧图 / 页眉 BMP）+ MUI 文案 + 静默守卫的标准
;         MUI_PAGE_WELCOME 欢迎页。
; Tier2  ：新增 customPageAfterChangeDir 钩子 —— 真正的 nsDialogs `PageEx custom`
;         「准备安装」品牌摘要页（自定义版式 + 控件：自定义字体大标题 + 运行期
;         读取 $INSTDIR / $installMode 的安装摘要标签），带 ${Silent} / ${isUpdated}
;         守卫，无 MessageBox。不触碰 per-user/per-machine（multiUser UAC 页）、
;         目录页、InstFiles、完成页的既有语义与 electron-updater 静默路径。
;
; Silent / Update 安全契约（必须保持）：
;   - 所有自定义页 PRE 在 /S 静默或 --updated 时 Abort 跳过该页。
;   - /S 本就跳过全部 MUI 页 + PageEx custom 页（NSIS 内建）；PRE 守卫为双保险。
;   - 无 MessageBox、无阻塞交互；electron-updater `/S --updated` 路径不受影响。
;   - 本文件经 sharedHeader 先于 MUI2.nsh 引入：顶层只用 !define（预处理指令）；
;     需要 LogicLib（${If}）/ nsDialogs 的代码必须放在宏体内——customWelcomePage /
;     customPageAfterChangeDir 在 assistedInstaller.nsh 的页面区展开，此时
;     MUI2.nsh（LogicLib）已引入，nsDialogs.nsh 由 multiUserUi.nsh 先 include。
;
; 可覆盖宏（源码级证据：app-builder-lib@26.15.3 templates/nsis/assistedInstaller.nsh）：
;   - customWelcomePage         行 9-11   欢迎页（Tier1.5：标准 MUI_PAGE_WELCOME + 侧图）
;   - customPageAfterChangeDir   行 42-44  目录页后 / InstFiles 前的自定义页（Tier2 用）
;   - customFinishPage          行 47-64  替换完成页（未用：会丢失 run-after-finish/--updated）
;   multiUser 选择页（multiUserUi.nsh 的 PAGE_INSTALL_MODE，assistedInstaller 行 19）本身
;   已是 nsDialogs PageEx custom，含 UAC 提权 + BCM_SETSHIELD 逻辑；替换会危及静默
;   per-machine 提权路径，故保留默认（perMachine 未设 → 显示选择页，不强制管理员）。
; ============================================================================

; ── 完成页文案（默认 MUI_PAGE_FINISH 由 assistedInstaller.nsh 注入，此处预定义）──
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "TAgent 已安装完成，可以开始使用了。$\r$\n勾选下方选项可立即启动 TAgent，点击「完成」退出安装程序。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 TAgent"

; ── 目录页顶部提示（MUI_PAGE_DIRECTORY）──
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 TAgent 的安装位置："

; ── 卸载欢迎页 / 完成页文案（MUI_UNPAGE_WELCOME / MUI_UNPAGE_FINISH）──
!define MUI_UNWELCOMEPAGE_TITLE "卸载 TAgent"
!define MUI_UNWELCOMEPAGE_TEXT "将从你的电脑移除 TAgent。$\r$\n点击「下一步」继续。"
!define MUI_UNFINISHPAGE_TITLE "卸载完成"
!define MUI_UNFINISHPAGE_TEXT "TAgent 已从你的电脑移除。"

; ============================================================================
; 品牌欢迎页（Tier1.5）：默认辅助向导无欢迎页，经 customWelcomePage 注入标准
; MUI_PAGE_WELCOME（配品牌标题/正文 + 侧图 installerSidebar）。
; PRE 守卫：/S 静默或 --updated 时 Abort 跳过该页，确保 silent / update 不阻塞。
; ============================================================================
!macro customWelcomePage
  Function TagentWelcomePre
    ${If} ${Silent}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE TagentWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 TAgent"
  !define MUI_WELCOMEPAGE_TEXT "TAgent 将安装到你的电脑，整个过程只需几步。$\r$\n$\r$\n点击「下一步」继续，或点击「取消」退出安装。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ============================================================================
; 品牌准备安装页（Tier2）：经 customPageAfterChangeDir 注入真正的 nsDialogs
; `PageEx custom` 自定义页（目录页之后、InstFiles 之前）。
;
; 这是 Tier2 的核心交付：用真正的 nsDialogs 版式与控件取代该位的默认空位，形成
; TAgent 品牌层级，而非标准 MUI 页面。
;   - 自定义版式：nsDialogs::Create 1018 + 多个按对话框单位精确定位的标签控件。
;   - 自定义控件：${NSD_CreateLabel} 标签；大标题经 CreateFont + WM_SETFONT(0x0030)
;     应用 22px / 粗体字体，与正文形成层级。
;   - 运行期摘要：读取 $INSTDIR（目录页后已定）与 $installMode（multiUser 页后已定），
;     展示实际安装位置（与 instFilesPre 规整逻辑一致：$INSTDIR 已含 APP_FILENAME
;     则不重复追加）与安装范围。只读展示，不修改任何安装状态。
;   - silent 守卫：PRE 在 ${Silent} 或 ${isUpdated} 时 Abort 跳过整页。
;   - 无 MessageBox、无阻塞交互；不触碰 per-user/per-machine、目录、InstFiles、
;     完成页语义，不强制 perMachine。
;
; 源码级证据：assistedInstaller.nsh 行 42-44
;   !ifmacrodef customPageAfterChangeDir
;     !insertmacro customPageAfterChangeDir
;   !endif
; 该宏在 assistedInstaller.nsh 页面区展开（MUI2.nsh / multiUserUi.nsh 之后），
; 故 LogicLib、nsDialogs、${StrContains}（StrContains.nsh 由 allowToChangeInstallationDirectory
; 分支行 23 先 include）均可用。multiUserUi.nsh 行 1 已 !include nsDialogs.nsh，此处幂等再 include。
; ============================================================================
!macro customPageAfterChangeDir
  !include "nsDialogs.nsh"

  Function TagentReadyPre
    ; silent / --updated 双保险守卫（/S 本就跳过 PageEx custom 页）
    ${If} ${Silent}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $R0

    ; ── 大标题（自定义字体：MS Shell Dlg / 22px / 粗体，与正文形成层级）──
    ; CreateFont 签名（NSIS 3.0.4.1 实测）：$(user_var) face_name [height weight /ITALIC /UNDERLINE /STRIKE]
    ${NSD_CreateLabel} 0u 2u 300u 30u "准备安装 TAgent"
    Pop $R1
    CreateFont $R2 "MS Shell Dlg" 22 700
    SendMessage $R1 0x0030 $R2 0

    ; ── 副标题 ──
    ${NSD_CreateLabel} 0u 36u 300u 18u "即将开始安装，请确认以下信息："
    Pop $R1

    ; ── 安装位置（与 instFilesPre 规整一致：$INSTDIR 已含 APP_FILENAME 则不重复追加）──
    ${StrContains} $R3 "${APP_FILENAME}" $INSTDIR
    ${If} $R3 == ""
      StrCpy $R3 "$INSTDIR\${APP_FILENAME}"
    ${Else}
      StrCpy $R3 "$INSTDIR"
    ${EndIf}
    ${NSD_CreateLabel} 12u 62u 288u 18u "安装位置：$R3"
    Pop $R1

    ; ── 安装范围（$installMode 由 multiUser 页设置：all / current）──
    ${If} $installMode == "all"
      ${NSD_CreateLabel} 12u 82u 288u 18u "安装范围：为使用这台电脑的所有用户安装"
      Pop $R1
    ${Else}
      ${NSD_CreateLabel} 12u 82u 288u 18u "安装范围：仅为当前用户安装"
      Pop $R1
    ${EndIf}

    ; ── 快捷方式（契约保留：桌面 + 开始菜单）──
    ${NSD_CreateLabel} 12u 102u 288u 18u "将创建桌面快捷方式与开始菜单快捷方式。"
    Pop $R1

    ; ── 底部提示 ──
    ${NSD_CreateLabel} 0u 124u 300u 16u "点击「下一步」开始安装。"
    Pop $R1

    nsDialogs::Show
  FunctionEnd

  ; leave 回调（PageCallbacks 第二参数，与 multiUserUi.nsh 用法一致；本页无需读取
  ; 状态，立即返回即正常进入 InstFiles 页）。Return 保证函数非空，规避 -WX 空函数告警。
  Function TagentReadyLeave
    Return
  FunctionEnd

  PageEx custom
    PageCallbacks TagentReadyPre TagentReadyLeave
    Caption " "
  PageExEnd
!macroend
