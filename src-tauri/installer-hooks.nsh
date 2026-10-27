; Clay Draft 安装钩子 —— 补齐「可被选为 .md 默认程序」所需的注册表项
;
; 为什么需要这个文件：
; Tauri 的 fileAssociations 只注册 ProgID 与 .md 的 OpenWithProgids，
; 这够让程序出现在「打开方式」列表里，但 Windows 的「设置 → 默认应用」
; 要按应用整体指定，还需要 Capabilities + RegisteredApplications 两组键。
; 缺了它，程序在默认应用列表里根本不作为一个「应用」出现，
; 用户只能每次走「打开方式」。
;
; 注意：Windows 10 1803+ 起 UserChoice 有哈希保护，安装程序无法直接
; 抢占默认打开方式（VS Code、Typora 同理）。这里只能把「可被选为默认」
; 这条路铺平，最终仍需用户手动确认一次。
;
; 全部写 HKCU：本项目 installMode 固定 currentUser，没有管理员权限，
; 写 HKLM 会静默失败。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Clay Draft\Capabilities" "ApplicationName" "Clay Draft"
  WriteRegStr HKCU "Software\Clay Draft\Capabilities" "ApplicationDescription" "面向中文技术文档写作的 Markdown 编辑器"
  WriteRegStr HKCU "Software\Clay Draft\Capabilities" "ApplicationIcon" "$INSTDIR\clay-draft-app.exe,0"

  ; 四个扩展名共用一个 ProgID——与 tauri.conf.json 的 fileAssociations.name 必须一致
  WriteRegStr HKCU "Software\Clay Draft\Capabilities\FileAssociations" ".md" "ClayDraft.md"
  WriteRegStr HKCU "Software\Clay Draft\Capabilities\FileAssociations" ".markdown" "ClayDraft.md"
  WriteRegStr HKCU "Software\Clay Draft\Capabilities\FileAssociations" ".mdown" "ClayDraft.md"
  WriteRegStr HKCU "Software\Clay Draft\Capabilities\FileAssociations" ".mkd" "ClayDraft.md"

  WriteRegStr HKCU "Software\RegisteredApplications" "Clay Draft" "Software\Clay Draft\Capabilities"

  ; 让资源管理器立刻重读关联，否则要等注销或重启才认
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "Clay Draft"
  DeleteRegKey HKCU "Software\Clay Draft"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
