# Clay Draft — 桌面版

基于 Tauri 2 的 Markdown 编辑器。复用系统 WebView2，不打包 Chromium。
面向中文技术文档写作，能注册为 Windows 上 `.md` 的默认打开程序。

## 运行

```bash
npm run tauri dev      # 开发模式，改 src/ 下的文件刷新即生效
npm run tauri build    # 出安装包，产物在 src-tauri/target/release/bundle/
```

首次 `dev` 需要编译几百个 Rust crate，约 5–15 分钟；之后增量编译只要几秒。
前端**没有构建步骤**——CSS 走 `<link>`、JS 走普通 `<script>`，改完刷新就行。

## 目录

```
src/
  index.html            HTML 骨架 + 样式与脚本引用
  css/                  tokens（调色板） / app（外壳） / doc（正文） / media（打印与窄屏）
  js/                   core（共享内核，建立 window.CD）
                        + mermaid / toc / images / file / word
  vendor/               marked / prism / mermaid，全部本地化以便离线运行
src-tauri/
  src/lib.rs            文件读写命令 + 编码探测 + PDF 导出 + 图片存取
  src/docx.rs           导出 Word：IR → OOXML → zip
  tauri.conf.json       窗口与打包配置
  capabilities/         权限声明（Tauri 2 的 ACL）
tools/
  check-frontend.py     前端自检（语法、CSS 配对、window.CD 握手）
  check-docx.py         Word 导出自检（zip、XML 良构性、元素顺序）
```

架构上的取舍与踩过的坑都在 `CLAUDE.md` 里，改代码前值得先读。

## 功能

**文件**

- 打开 / 保存 / 另存为（`Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S`）
- **编码探测**：BOM → 严格 UTF-8 → 统计探测（chardetng）。中文 .md 常见 GBK/GB18030，一律当 UTF-8 读会满屏乱码
- **编码与换行符原样写回**：GBK 文件不会被默默转成 UTF-8，CRLF 不会被改成 LF 导致整文件 diff 炸掉
- 双击 .md 启动时接收命令行路径并打开；拖文件到窗口也能打开
- 关窗前拦截未保存修改

已绑定文件的文档**不会自动写盘**——自动改用户磁盘上的文件太冒失。
只有未命名草稿才自动存到本地存储防丢。

**编辑与预览**

- 双栏实时预览，可各自开关；层级目录可折叠、能跟随滚动高亮
- **预览即编辑**：双击预览里任意块就地改，`Alt+双击` 跳回源码对应位置
- 中文字数统计（中文字符 + 英文单词，与软著登记表、招投标文件的口径一致）
- 代码块语法高亮（Prism）、mermaid 流程图（懒加载）
- 图片存成本地文件而非内联 base64，支持粘贴截图、拖入、拖拽调宽

**导出**

- **PDF**：走 WebView2 的 `PrintToPdf`，选好路径直接落盘，不弹打印对话框
- **Word**：真 `.docx`。标题落到 Word 的「标题 1/2/3」样式，导航窗格、折叠、
  插入自动目录都能用；表格、图片、代码高亮、mermaid 流程图一并带过去

## 自检

没有测试框架，靠这三样挡低级错误：

```bash
cd src-tauri && cargo test --lib   # 路径解析、assets 迁移、docx 生成
python tools/check-frontend.py     # 前端
python tools/check-docx.py         # Word 导出（先跑 cargo test 生成样张）
```

但**有相当一部分只能实机点**——ACL 权限、PDF 落盘、粘贴截图、中文目录下的图片、
Word 里的实际观感，这些单测和静态检查都覆盖不到。清单见 `CLAUDE.md` 的「运行时验证」。

## 打包与文件关联

`npm run tauri build` 出 NSIS 安装包（`installMode: currentUser`，免管理员权限）。
**不出 MSI**：WiX 工具链要从 GitHub 下载，本机网络会超时，且 NSIS 已覆盖文件关联。

安装包会注册 `.md` / `.markdown` / `.mdown` / `.mkd` 的关联，并写入
`Capabilities` + `RegisteredApplications`——少了后两组键，程序在「设置 → 默认应用」
里根本不作为一个「应用」出现。

注：Windows 10 1803+ 起 `UserChoice` 注册表项有哈希保护，**程序无法自行抢占默认
打开方式**。安装包只能把路铺平，用户仍需在「打开方式」里手动确认一次
（VS Code、Typora 同理）。

## 浏览器兼容

`src/index.html` 在普通浏览器里直接打开也能跑——检测不到 `window.__TAURI__` 时
文件相关按钮自动禁用，其余功能照常。这也是不改用 ES module 的原因：
`type="module"` 在 `file://` 下会被 CORS 拒绝。
