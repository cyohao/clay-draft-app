# Clay Draft

Tauri 2 桌面版 Markdown 编辑器。面向中文技术文档写作（软著材料、技术方案、投标文件），
最终产物要能注册为 Windows 上 `.md` 的默认打开程序。

## 架构

前端**没有构建步骤、没有框架、没有打包器**，改完直接刷新即可。多文件靠浏览器原生
加载：CSS 走 `<link>`，JS 走普通 `<script>` 顺序执行。不要引入 npm 前端依赖，
也不要改成 ES module——`type="module"` 在 `file://` 下会被 CORS 拒绝，
那样就毁掉了「浏览器里直接打开 index.html」这个能力（见「前端约定」）。
`tauri.conf.json` 的 `frontendDist` 直接指向 `../src` 这个静态目录。

```
src/
  index.html              仅 HTML 骨架 + 样式与脚本引用（约 100 行）
  css/tokens.css          字体归并 + 调色板四态（含打印态，见「前端约定」）
  css/app.css             界面外壳：顶栏 / 工具栏 / 窗格 / 分隔条 / 源码区 / 目录栏
  css/doc.css             预览正文 / 代码块与 Prism / 表格 / 图片与灯箱 / 状态栏
  css/media.css           窄屏响应式 / 打印版面与分页 / 减少动效
  js/core.js              共享内核，建立 window.CD（见「前端模块」）
  js/tabs.js              标签页：多文档共存、会话恢复（见「标签页」）
  js/mermaid.js           流程图
  js/toc.js               目录树
  js/images.js            本地图片
  js/file.js              文件层
  js/word.js              导出 Word（见「导出 Word」）
  vendor/marked.min.js    Markdown 解析（49KB）
  vendor/prism.min.js     语法高亮（51KB，core + 19 种语言拼的，见下）
  vendor/mermaid.min.js   流程图（5.3MB，懒加载，见下）
src-tauri/
  src/lib.rs              文件读写、编码探测、PDF 导出、图片存取
  src/docx.rs             导出 Word：IR → OOXML → zip（见「导出 Word」）
  src/main.rs             仅调用 lib::run()
  tauri.conf.json         窗口与打包配置
  capabilities/default.json   Tauri 2 的 ACL 权限声明
  installer-hooks.nsh     NSIS 钩子：注册「可被选为 .md 默认程序」所需的键
  .cargo/config.toml      crates 镜像（项目级，见下）
app-icon.png              图标源图 1024x1024
icon-candidates/          图标备选稿，与构建无关，可删
```

Rust 侧的命令（`invoke_handler` 注册顺序即下表）：

| 命令 | 用途 |
|---|---|
| `read_doc` / `write_doc` | 编码探测与原样写回，见「文件读写约定」 |
| `take_startup_file` | 双击 .md 时的启动参数，取走即清空 |
| `export_pdf` | WebView2 的 `PrintToPdf`，直接落盘不弹打印框 |
| `export_docx` | IR → OOXML → zip，见 `src/docx.rs` 与「导出 Word」 |
| `save_image` / `import_image` | 粘贴的截图落盘 / 把已有图片拷进 assets |
| `read_image` | 读成 data URL 给预览用 |
| `resolve_doc` | 相对链接 → 绝对路径，见「文档间跳转」 |
| `copy_assets` | 另存为时迁移图片目录 |

`withGlobalTauri: true`，所以前端直接用 `window.__TAURI__.core.invoke` 等全局对象，
不需要 `@tauri-apps/api` 的 npm 包。

## 命令

```bash
npm run tauri dev       # 开发运行
npm run tauri build     # 出安装包 → src-tauri/target/release/bundle/
cd src-tauri && cargo test --lib   # Rust 单测：图片路径解析、assets 迁移、docx 生成
```

`cargo test` 覆盖的是最容易在 Windows 上翻车的路径逻辑（中文目录、含点的文件名、
子目录跟随、原目录保留）。**但它测不到前端到 Rust 之间的那一段**——图片路径的
百分号编码就是从这个缝里漏过去的，见下面的坑。

改完前端后的自检（无测试框架，这是唯一的自动化防线）：

```bash
python tools/check-frontend.py     # 前端
python tools/check-docx.py         # Word 导出（先跑 cargo test 生成样张）
```

覆盖：各 JS 文件语法（`node --check`）、CSS 注释与花括号配对、未定义的 CSS 变量、
`getElementById` 引用的 id 是否存在、**`window.CD` 握手是否完整**、
**模块顶层有没有读取别的模块的符号**。

最后两项是多文件结构独有的风险：模块在顶层（加载时）读取另一个模块回填的符号，
会因加载顺序拿到 `undefined` 且不报错——正是本项目反复吃亏的那类静默失效。
规矩是**模块顶层只许从 core 取符号**。

`check-docx.py` 校验的是 `cargo test` 产出的样张（临时目录下的 `clay_sample.docx`）：
zip 的 CRC、每个 part 的 XML 良构性、标题的 outlineLvl、rId 是否都有对应关系、
表格列数是否自洽，以及**元素顺序是否符合 schema**。最后这项最要紧——顺序错了
XML 照样良构，前面几项全会放行，只有 Word 会拒绝打开。

## 本项目踩过的坑（都已验证）

**管道会吞掉 cargo 的退出码。** 不要写 `cargo build | grep ... | tail`——Bash 管道的退出状态
取自最后一个命令，`grep`/`tail` 几乎总成功，编译失败会被报成 exit 0。
正确写法：`cargo build > _build.log 2>&1; code=$?`。本项目因此两次误判"构建成功"。

**PowerShell 里 `[` `]` 是通配符。** 本仓库路径含 `[简称：SCWES]`，
`Get-ChildItem "...[...]..."` 会静默返回空，看起来像产物没生成。
用 `-LiteralPath`，或改用 bash 的 `find`。

**crates.io 直连不可用。** 本机 `index.crates.io` 可达但 `static.crates.io`（存放 .crate 包）
超时，表现为 cargo 进程挂着、CPU 为 0、`target/` 不生成——像编译慢，其实是下载卡死。
已配 `src-tauri/.cargo/config.toml` 走 rsproxy 镜像，**项目级，不要改成全局**。

**`encoding_rs` 的返回元数不统一。** `decode()` 返回 `(Cow, &Encoding, bool)` 三元组，
`decode_without_bom_handling()` / `encode()` 的情况各不相同，解构前先确认。

**非 ASCII 路径本身没问题。** 中文目录名、方括号、全角冒号，Rust 编译链接全程正常，
不需要为此挪动项目。

**`target/` 会把项目的旧绝对路径焊死在缓存里。** 本项目从 `D:\work\...` 挪到 `E:\` 之后，
增量编译一律失败：`failed to read plugin permissions: ... D:\work\...\app_hide.toml`。
陈旧路径存在 `target/{debug,release}/build/tauri-*/output` 里。
**debug 和 release 两侧要分别清**——只清一侧，另一侧会一直坏着，而 `cargo check` 走缓存
不报错，很容易误以为好了：

```bash
cargo clean -p tauri -p tauri-plugin-dialog -p tauri-plugin-fs -p tauri-plugin-opener \
              -p tauri-runtime -p tauri-runtime-wry -p clay-draft-app          # debug
cargo clean -p tauri ... --release                                             # release
```

**换完图标必须强制重编，否则打出来的还是旧图标。** `npx tauri icon` 只改
`src-tauri/icons/`，cargo 的变更检测看不见这些文件，直接复用之前编好的 exe。
更坑的是 NSIS 打包时会 patch exe 写入 bundle 信息，**exe 的修改时间会更新**，看起来像是重编过。
正确做法是 `cargo clean -p clay-draft-app --release` 之后再 build，
并且用二进制特征比对来验证，别信时间戳：

```bash
python -c "
import io
ico=io.open('src-tauri/icons/icon.ico','rb').read()
i=ico.find(b'\x89PNG'); sig=ico[i:i+96]
d=io.open('src-tauri/target/release/clay-draft-app.exe','rb').read()
print('exe 含新图标:', sig in d)"
```

**marked 会把图片路径当 URL 做百分号编码。** `![](笔记.assets/a.png)` 渲染出来的
`img.src` 是 `%E7%AC%94%E8%AE%B0.assets/a.png`，拿它去磁盘找文件必然落空。
交给 Rust 前要 `decodeURIComponent`。纯英文数字路径不会被编码，所以这个 bug
只在中文目录下暴露；而 Rust 单测是直接喂中文路径的，绕过了 marked 这一环——
两边各自都"测过了"，缝隙正好在中间。

**marked 的 code token，`raw` 不一定带尾部换行。** 块后面的空行是独立的 `space` token。
所以 `raw.match(/\n+$/)[0]` 会在某些文档结构下抛 `Cannot read properties of null`。
要么用 `/\n*$/`（零次也匹配），要么加兜底。

**引用式链接定义不进顶层 token 数组。** `[ref]: https://example.com` 被 marked 收进
`tokens.links`，于是"累加 `raw.length` 算偏移"会从这一行起整体错位，写回时啃掉隔壁内容。
正确做法是从上一个 token 的结束处往后 `indexOf(tk.raw, cursor)`，缝隙自动跳过。

**滚动的是 `textarea` 自己，不是 `.pane-edit`。** textarea 是替换元素，`min-height:100%`
不会被内容撑高，`.pane-edit` 的 `scrollHeight` 恒等于 `clientHeight`。
双栏同步滚动一度整个是失效的，因为监听挂在了一个永远不滚动的元素上。

**CSS 特异性能把后写的规则压住。** `.toc-item.lv1>.toc-row>.toc-link` 是 (0,4,0)，
而 `.toc-link.active` 只有 (0,2,0)，导致目录里一二级标题高亮时只有底色生效、颜色被吃掉。
排查这类问题别靠读代码，直接遍历 `document.styleSheets` 把命中该元素的规则全列出来。

## 文件读写约定

`read_doc` / `write_doc` 在 Rust 侧实现，**不要改用 fs 插件**——编码探测必须在字节层面做。

- **编码探测顺序**：BOM → 严格 UTF-8（`std::str::from_utf8` 能过就一定是）→ chardetng 统计探测。
  中文 `.md` 常见 GBK/GB18030，一律当 UTF-8 读会满屏乱码。
- **编码与换行符原样写回**：GBK 文件不得被默默转成 UTF-8，CRLF 不得被改成 LF
  （否则一次保存就让整个文件的 git diff 炸掉）。前端统一按 `\n` 处理，落盘时按 `docState.eol` 还原。
- **已绑定文件的文档不自动写盘**。自动修改用户磁盘上的文件太冒失；只有未命名草稿
  才自动存 localStorage 防丢。这是有意的设计，不要"优化"成自动保存。

## 前端模块

`js/core.js` 必须最先加载，它建立 `window.CD` 并在**文件末尾**把共享符号挂上去
（放末尾是为了确保所有 `var` 都已初始化）。其余几个模块各自包在 IIFE 里，
顶部从 `CD` 取**同名别名**——正因为名字相同，搬过去的函数体一字未改。

**模块顶层只许依赖 core。** 模块之间要互调，写在函数体里用 `CD.xxx()`——调用时才解析，
与加载顺序无关（`word.js` 调 `CD.mermaidPng()` 就是这样）。顶层（加载时）取另一个模块的
符号则会拿到 `undefined` 且不报错。这条不变式是拆分能安全存在的前提，
`tools/check-frontend.py` 查的正是它，所以 core.js 之后那几行 `<script>` 顺序可以任意调换。

| 模块 | 依赖 core 的符号 | 回填给 core |
|---|---|---|
| `js/tabs.js` | `src` `paneView` `docState` `dot` `savedAt` `toast` `update` `baseName` `isApp` `invoke` `dlg` `holdScroll` `SAMPLE` | `openDoc` `newTab` `closeActive` `cycleTab` `gotoTab` `tabDraftKey` `dirtyTabs` `restoreSession` `saveSession` `refreshTabs` `hasTabs` |
| `js/mermaid.js` | `src` `preview` `esc` `update` | `renderMermaid` `mermaidPng` |
| `js/toc.js` | `preview` `paneView` `update` | `buildToc` `markActive` `tocPane` `resetToc` |
| `js/images.js` | `src` `preview` `docState` `blockMap` `toast` `update` `scheduleSave` `invoke` | `resolveImages` `decorateImages` |
| `js/file.js` | `src` `preview` `dot` `savedAt` `docState` `toast` `update` `scheduleSave` `hhmm` `baseName` `isApp` `invoke` `dlg` `appWin` `TAURI` | `refreshFileUI` `afterLoad` `saveActive` |
| `js/word.js` | `src` `docState` `toast` `baseName` `isApp` `invoke` `dlg` | （无） |

三条会静默失效的规矩：

1. **core 调用模块里的函数一律写 `CD.xxx()`**，不能写裸名字。裸名字不在任何外层
   作用域里，`typeof` 守卫会安静地返回 `"undefined"`，功能无声消失。
   `update()` 里调 `CD.renderMermaid()` / `CD.buildToc()` 等就是这个缘故。
2. **被别名引用的变量不得整体重新赋值**，只能就地改。`blockMap` 原本写
   `blockMap = []` 清空，拆分后必须写 `blockMap.length = 0`——否则 core 换了新数组，
   images.js 手里的别名还指着旧的那个空数组。
3. **模块顶层不得读取别的模块回填的符号**（加载时对方可能还没跑）。要用就在函数体里
   用 `CD.xxx`，调用时才解析。`file.js` 里的 `CD.resetToc()` / `CD.tocPane` 即是。

`python tools/check-frontend.py` 会检查第 1、3 条和握手完整性；第 2 条查不出来，改动
共享变量时自己留神。

## 前端约定

**降级运行**：`window.__TAURI__` 不存在时（普通浏览器里打开 `src/index.html`），
文件按钮自动禁用，其余功能照常。改动不要破坏这个双环境能力。

**离线优先**：不得引入任何 CDN 外链。marked、prism、mermaid 都已下载到 `src/vendor/`，
Google Fonts 外链已移除，字体全部走本机已安装的。
**本机 CDN 不通**（cdnjs / jsdelivr 都超时），取新库只能走 `npm pack` 解包，
别写 `<script src="https://...">` 试。

**目录树重建**：目录跟着每次 `update()` 重建，靠「所有标题的层级+文本」算签名，
签名不变就跳过重建——否则正文打字时目录会疯狂闪烁。折叠状态按
`层级|标题文本#序号` 记键，序号用来区分重名标题。

**主题三态（其实是四处）**：浅色调色板定义在裸 `:root`；深色在
`@media (prefers-color-scheme:dark){ :root:not([data-theme="light"]) }` 和
`:root[data-theme="dark"]` 各写一份。任何颜色**不得只定义在** media 或 `[data-theme]` 块里，
否则未标记状态下会出现一套主题的文字配另一套主题的底色。

**第四处是 `@media print`**：打印强制走浅色，新增的颜色 token 必须在那里也覆盖一遍，
漏了的话深色主题导出的 PDF 会出现黑底代码块。目前需要四处同步的有
`--code-bg`（行内代码底）、`--sel`（划选底）、`--syn-*`（语法高亮七色）。

**这四处现已全部集中在 `css/tokens.css`，上下相邻**，加 token 时四处在同一屏里，
不必再跨 400 行去找。打印的**版面**规则仍在 `css/media.css`——只有调色板那一块提了过来。
所以 `tokens.css` 末尾有一个单独的 `@media print{ :root... }`，那不是重复，别合并回去。

## 标签页

一个窗口里开多个文档。**活动标签的「真状态」始终在 `src.value` 和 `docState` 里**，
Tab 对象只在它不活动时持有快照；切换 = `snapshot(旧)` + `apply(新)`，不做双向同步。
两份状态同时可写必然打架，这里刻意只留一份。

**`tabs.js` 的 `apply()` 是全项目唯一允许直接赋值 `src.value` 的地方。** 代价是
切走再切回来，那个标签的原生撤销栈归零——这是「单 textarea」方案已知且接受的取舍。
另一条路是每标签一个 textarea（撤销栈天然各自保留），但要改掉 `CD.src` 的别名契约，
50 处引用加打印隔离。真觉得撤销丢得难受再换，Tab 模型不用动，只是把「存 text 字符串」
换成「存 textarea 节点」。**别因此把别处的 `insertText` 也改成赋值**，那条规矩依然成立。

- **会话恢复**：只把路径和草稿键写进 `clay-draft-session`，正文不进 localStorage。
  恢复出来的是**壳**（`loaded:false`），第一次切过去才读盘——开六个标签启动只读一个文件
- **未命名标签各存各的草稿**。首个标签沿用旧键 `clay-draft-doc`，老草稿不会丢；
  其余是 `clay-draft-doc:<id>`。core 的存草稿是 500ms 防抖的，**切走前 `snapshot()` 要自己
  刷一次**，否则那一拍的内容会被写到新标签的键上
- **打开不再顶掉当前文档**，所以 `doOpen` / 拖拽都不再问「放弃修改吗」。空白标签会被顶掉，
  已开着的文件切过去而不是开第二份
- **关窗确认覆盖所有脏标签**，逐个写盘（`saveAllDirty`）而不是切过去再存——未命名标签的
  `saved` 恒为 null，永远算不上脏，所以每个脏标签一定有 path
- 键位：`Ctrl+T` 新建、`Ctrl+W` 关闭、`Ctrl+Tab` / `Ctrl+PageUp/Down` 轮换、`Ctrl+1..9` 跳转、
  中键关闭。**`Ctrl+Tab` 与 core 里「Tab 插两个空格」那条冲突过**，那边加了 `&& !mod`

### 文档间跳转

`[说明](01-系统总览.md)` 这种相对链接，在预览里点开同目录的文档、开成新标签。
`core.js` 的链接装饰按扩展名打 `.doclink` 标记，`file.js` 在 `preview` 上事件委托接管点击
（预览 innerHTML 每次 update 都重建，监听只能挂在容器上）。

**路径解析放 Rust 的 `resolve_doc`，不在 JS 里拼。** 与 `read_image` 共用 `resolve_relative`，
免得两套规则慢慢分叉；`canonicalize` 顺带把 `../` 折平——不折平的话，
`子目录/../a.md` 和 `a.md` 是两个不同的字符串，标签层按路径认身份，同一个文件会开成两个标签。
Windows 的 `canonicalize` 返回 `\\?\E:\...` 扩展长度前缀，必须剥掉才和别处的路径写法对得上
（`strip_verbatim` 连 UNC 一起处理了）。`resolve_doc_finds_sibling_documents` 覆盖中文名、
含点的文件名、子目录、`../` 上跳、目标不存在、目标是目录。

**href 交给 Rust 前要 `decodeURIComponent`**——marked 会把路径当 URL 做百分号编码，
和图片那个坑是同一个，只在中文文件名下暴露。

**双击第二个 .md 要靠 `tauri-plugin-single-instance`**，否则另起进程另开窗口，标签页就白做了。
它必须**第一个注册**；拦下的路径用 `win.emit("open-file", p)` 发给前端，`file.js` 收到后
开新标签。这是本项目唯一新增的 crates.io 下载，走镜像拿得到。

## 预览即编辑

预览区不是只读的。**双击任意块 = 原地改，Alt+双击 = 跳回源码对应位置并选中。**

编辑框里放的是 **markdown 源文本**，不是渲染后的 HTML——标题里的 `**加粗**` 原样显示。
这是有意的：不做 HTML→Markdown 转换，就没有"转换丢格式"这类数据风险。
标题和代码块给净内容（不含 `##` 和围栏），段落、列表、引用、表格直接给原文。
在段落编辑框里敲两个空行分成两段，写回后 marked 重新分块，**这就是「新增」**。

块与源码的映射靠 `marked.lexer` + `indexOf` 逐块定位（不能累加 raw，理由见坑）。
两道保险，缺一不可：

1. token 数与顶层元素数对不上就**整体放弃**打标记——宁可功能失效，不能错位
2. 每次写回前再校验一次 `src.value.slice(start,end) === blk.raw`，对不上就拒绝写入并提示

**所有写回一律走 `document.execCommand("insertText")`，不要直接赋值 `textarea.value`。**
赋值会清掉浏览器原生撤销历史，在预览里改完再按 Ctrl+Z 会一口气退回很早的状态。
`insertText` 还会顺带触发 `input` 事件，`update()` 和自动存草稿都跟着走。

## 图片

存**本地文件**，不内联 base64——一张普通截图 base64 后是 4.5 万到上百万字符，
全挤在源码区的同一行里，左边编辑区就没法用了。

- 目录约定：`笔记.md` 配 `笔记.assets/`。用文件名做前缀，同目录多个 md 才不会混
- 文件名是精确到毫秒的时间戳，连贴几张不会撞名
- 三种插入方式：Ctrl+V 粘贴截图、拖图片进窗口、工具栏「图片」按钮
- 拖进来的如果是 `.md` 仍然是打开文档，按扩展名分流
- **文档没保存时拒绝插图并提示**——没有文件路径就不知道图该放哪，不偷偷塞临时目录

**预览能显示本地图，靠的是 Rust 读成 data URL 换上去。** 预览页的 base URL 是
`tauri://localhost`，md 里的相对路径在 webview 里根本解析不到。按「文档路径 + src」
缓存，打字时不会反复读盘。（另一条路是开 `assetProtocol` + `convertFileSrc`，
它走 `tauri.conf.json` 的 security 配置、不经过 ACL，图片多到内存吃紧时再换。）

图片尺寸靠拖右下角手柄调，**写回成标准 HTML** `<img src="..." width="600">`——
markdown 标准语法没有尺寸，但 HTML 是规范允许的，GitHub、VS Code 都认，
比 Typora 那种 `=600x` 私有扩展通用。再拖是更新 `width` 而不是追加。

另存为时会**复制**（不是移动）旧文档的 assets 目录到新名字下，并把正文里所有
`旧名.assets/` 改写成 `新名.assets/`，**然后才写盘**——顺序反了存下去的就还是旧引用。
用复制是因为另存为语义上是存副本，移走会把原文件的图弄断。

## mermaid 与语法高亮

**mermaid 5.3MB，必须懒加载**：只有文档里真出现 ```` ```mermaid ```` 才注入 script，
不含图的文档一个字节都不下载。渲染结果按「主题 + 源码」缓存，否则每敲一个字都要重画整张图。
切深浅色要强制重画——mermaid 的配色是烘焙进 SVG 的，不认 CSS 变量。

**Prism 51KB，直接加载**，是 core + 19 种语言按依赖顺序拼出来的单文件。
语言之间有依赖（`typescript` 要 `javascript`，`csharp`/`java`/`go` 都要 `clike`），
顺序错了会静默不高亮。加语言就从 npm 包里取对应的 `components/prism-*.min.js` 接进去。
highlight.js 不能用：它的 npm 包里没有浏览器可用的 bundle，只有 ES/CJS 模块，本项目没有构建步骤。

**两者的配色都接项目 token，不用各自的默认主题。** mermaid 默认是淡紫色系、Prism 自带主题
是按别的设计体系调的，混进来就是第二套色板。mermaid 用 `theme:"base"` + `themeVariables`
从 `:root` 实时读色值（只有 base 主题完整接受这些变量）；Prism 的 token class 映射到
`--syn-*` 那组变量，刻意压在低饱和区间——代码块整片都是彩色，饱和度一高就成圣诞树。

## 导出 PDF

走 WebView2 的 `ICoreWebView2_7::PrintToPdf`，选好路径直接落盘，不弹系统打印对话框。
命令必须是 **async**：`PrintToPdf` 的完成回调在主线程跑，同步阻塞等结果必然死锁。

版面完全由 `@media print` 决定。那套样式的要害是**把整条 flex 链路放平**
（`html/body/.app/.panes/.pane-view/.pane-scroll` 全部 `height:auto` + `overflow:visible`），
否则固定高度和 overflow 会让导出的 PDF 只有第一屏。其余分页规则：标题不与正文分家、
表格跨页重复表头、代码块强制换行、深色主题强制转浅色。

**页边距只在 `@page` 里设一次，`PrintSettings` 里故意不设**——两边各设一次会叠加成双倍。

## 导出 Word

真 `.docx`，不是改后缀的 HTML。分工是 **markdown 在前端解析、OOXML 在 Rust 生成**：

```
src.value ──marked.lexer──▶ js/word.js 组装 IR(JSON) ──invoke──▶ src-tauri/src/docx.rs
```

**不要在 Rust 里重写 markdown 解析。** 预览用的就是 marked，重写一套必然分叉，
GFM 表格、任务列表这些行为一对不上就成了「预览一个样、导出另一个样」。

**版面参数以 `@media print` 为基准**（A4、20mm/18mm 边距、正文 11pt、H1 20pt / H2 15pt），
集中在 `docx.rs` 的 `mod layout`。代码配色同理，`word.js` 从 CSSOM 实时读
`@media print` 里的 `--syn-*`，不在 JS 里抄第二份——否则主题就多了第五处要同步的定义。

### 有意不跟 print 的地方（不要「顺手改回去对齐」）

纸面归纸面，Word 归 Word。下面这些都是按使用者反馈定的，不是漏改：

| | `@media print` | Word 导出 | 为什么 |
|---|---|---|---|
| 正文行距 | 1.7 | **单倍**（`LINE = 240`） | 1.7 在屏幕和 PDF 上好看，落到 Word 的纸面偏松。1.7 → 1.5 → 单倍，是一路收下来的 |
| 标题行距 | h1 1.3 / h2 1.35 / 其余 1.7 | **单倍**（`LINE_H` 全 240） | 见下 |
| 正文段前 / 段后 | `margin:0 0 1.1em`（段后 12pt、段前 0） | **段前段后各 5 磅** | Word 是把上一段的段后与下一段的段前**相加**的（CSS 的 margin 会折叠，Word 不会），所以段间实际 10 磅 |
| 标题段前距 | h2 是 `2em`（30pt） | **12pt 起按级递减** | 2em 在 Word 里空得过分 |
| 标题段后距 | h2 是 `.6em` + `.35em` 内距 | **各级统一 100 twip（5pt）** | 预览里标题下方有细边框和内距把空白「撑出结构」，Word 没那条线，同样数值读起来就是一片空荡 |
| 表格边框 | 只有横线 | **六边全框** | 导出的多半要进正式文档，那边通行完整网格 |
| 代码块底 | `padding` 直接给 | **套在单元格里靠 `tcMar`** | 见下 |

`cargo test` 里 `line_spacing_is_single_everywhere`、`table_has_all_six_borders`、
`code_block_gets_padding_from_a_cell` 就是拿来挡「改回去对齐」的。

**标题的行距不能套正文的。** 超出字号的那部分行距，Word 大半摊在文字下方——
看起来就是「标题下面空一大块」，字号越大越明显。这里曾经全填 1.7，是这个毛病的来源；
后来按 CSS 给到 1.3/1.35 仍偏松，最终定为单倍。标题基本都是一两行，单倍不会挤，
层次由字号和段前距去拉，不靠行距。

**代码块的内边距只能靠表格单元格。** 段落底纹（`w:shd`）铺满的范围**就是**左右缩进
之间那条带子——文字正好贴着底纹边缘，没有内边距这回事；加缩进只会把底纹连同文字
一起挪走。所以代码块套在一个单元格的表格里，底色由单元格出，四边内边距由 `w:tcMar` 给。
行仍是一行一段（整块一个段落的话长代码没法分页），表格行默认允许跨页断开，
所以长代码块照样能翻页。那张表**不带 `TableGrid` 样式**，`check-docx.py` 以此把它
和数据表格区分开，不去查它的边框。

**项目符号的字形要写成 XML 数字引用。** `&#xF0B7;`（Symbol，实心圆点）、`o`
（Courier New，空心圈）、`&#xF0A7;`（Wingdings，实心方块）——就是 Word 内置项目符号
用的那三个。它们落在私用区 U+F0xx，**在源码里是不可见字符**，极容易在复制粘贴或
编码转换中丢掉。这里曾经就是空字符串，`<w:lvlText w:val=""/>`，结果整份文档的项目
符号一个都不显示，而 Word 不会报任何错。`bullet_glyphs_are_not_empty` 挡的就是这个。

### 有序列表不用 Word 的自动编号

序号由 `word.js` 按「每个列表各自从自己的 `start` 起算」算成**字面文本**写进正文，
Rust 侧只给悬挂缩进，不写 `w:numPr`。

因为 Word 的自动编号会把全文所有有序列表**串成同一个序列一路递增**——第二个列表接着
上一个的号继续数，而 markdown 里每个列表都是独立的、各自从 1 开始。文档里多处出现
`1.` 开头的小节时，这个毛病特别刺眼。

无序列表仍然走 `numbering.xml` 的项目符号：项目符号没有递增这回事，用 Word 的列表
反而能拿到正经的悬挂缩进。所以 `numbering.xml` 里那套编号型 `abstractNum`（`numId=2`）
目前是留着没用的，别当成死代码删掉——`check-docx.py` 会验「用到的 numId 都指向有效
abstractNum」，留着不碍事。

序号后面跟一个 `<w:tab/>`，配合 `w:hanging` 悬挂缩进，折行的第二行才会与首行文字对齐，
而不是顶到序号底下。

标题落到 `Heading1`–`Heading6`，`w:name` 必须写成内建名 `heading N`（Word 中文界面才
显示成「标题 N」），并带 `w:outlineLvl`。**导航窗格、折叠、插入自动目录全靠 outlineLvl**，
丢了这一个属性，「多级标题」整个就废了。标题不自动编号，是刻意的：原文里常已手写
「3.2 接口设计」，再自动编号就成了双重编号。

依赖只加了 `flate2` 与 `crc32fast`，**两者本来就在 `Cargo.lock` 里**（tauri 传递引入），
提为直接依赖不触发下载。没用 `zip` crate 是因为那是新下载，而这里只写不读。

### 这几个坑都实际踩到过

**OOXML 的子元素顺序是 `xsd:sequence`，schema 强制。** `w:rPr` 是
`rStyle → rFonts → b → i → strike → color → sz → szCs → u → shd`，`w:pPr` 是
`pStyle → numPr → pBdr → shd → spacing → ind → jc → outlineLvl`，且 `w:pPr` 必须排在该段
所有 run 之前。顺序错了 **XML 依然良构**，单测和 zip 校验全会通过，但 Word 拒绝打开
且只说「文件已损坏」，不指出错在哪。开发时就是这么踩的：图片段落写成了 `jc` 在
`spacing` 前面。`tools/check-docx.py` 的第 8 项专门查这个，改完 `docx.rs` 一定要跑。

**mermaid 屏幕上那份 SVG 不能直接栅格化。** `htmlLabels` 默认为 true，节点文字是
`<foreignObject>` 里的 HTML，而 **Chromium 的 canvas 不渲染 foreignObject**——
画出来是一张只有方框和连线、没有任何文字的图。所以 `CD.mermaidPng()` 用
`htmlLabels:false` 离屏重渲染一遍，让文字变成 SVG 原生的 `<text>`。

**中文必须走 `w:eastAsia`。** 只设 `w:ascii` 的话中文会掉回 Word 默认字体，整篇观感全变。
代码块的中文用**新宋体**而不是微软雅黑：Consolas 不含汉字，而新宋体是等宽的，
用比例字体会让含中文注释的代码列错开。

**XML 1.0 非法字符光转义没用。** U+0000–U+0008 这类控制字符在 XML 1.0 里根本不合法，
必须直接丢掉，留着 Word 就拒开。`docx.rs` 的 `esc()` 一并做了这件事。

**图片的 `wp:docPr@id` 必须全局唯一且非 0**，`wp:extent` 与 `a:ext` 两处尺寸必须一致
（单位 EMU，96dpi 下 1px = 9525）。图片与 `word/media/` 的对应关系**按 id 查表**，
不要从 `"img3"` 里解析数字——那要求前端数组顺序恰好与 id 编号一致，是个没人记得住的
隐式约定，错了就是配错图。

**超链接是关系不是属性**：每个外链要在 `document.xml.rels` 登记一条 `TargetMode="External"`，
正文里用 `w:hyperlink r:id` 引用，URL 里的 `&` 还要转义。

## 字体（改动前必读）

Windows 会把超过 4 字面的字体家族**拆成多个子家族**（字重被塞进 Family 名，
Subfamily 一律写 `Regular`），直接用 `font-weight` 取不到中间字重。
因此本项目用 `@font-face` + `local()` 把子家族重新归并，每档指向真实字面，
避免浏览器合成假粗/假斜（汉字的合成假粗会让笔画黏连，很糊）。

当前配置：**西文 Times New Roman，中文微软雅黑；H1/H2 的中文用 Noto Serif SC。**

字体栈靠**逐字符穿透**工作——排在前面的字体缺某个字，该字自动让位给后面的。
所以西文字体必须排在中文字体前面。

- `--sans` 正文与界面，`--sans-label` 小标题（当前 = `var(--sans)`），
  `--serif` H1/H2，`--mono` 源码区（**必须保持等宽**，比例字体会让表格竖线错位）
- **Styrene A / Tiempos Text 是纯拉丁字体，cmap 实测 CJK 覆盖为 0**，不能承担中文。
  它们的 `@font-face` 声明保留着但当前未被引用，便于切回。
- 微软雅黑只有 Regular(400) 和 Bold(700)，**没有 Medium**。小标题写 500 会静默回落成
  Regular、与正文同重、层次消失，所以用 700。改字体前先查目标字体有哪些真实字面：

```powershell
Add-Type -AssemblyName System.Drawing
(New-Object System.Drawing.Text.InstalledFontCollection).Families |
  Where-Object { $_.Name -match '关键词' } | ForEach-Object { $_.Name }
```

字体的真实 Family / PostScript 名要从字体文件的 name 表里读，
**不要猜**——国产字体常把中文名挂在 zh-CN 语言项下，GDI+ 只报英文名，用中文名搜不到。

## 打包

图标源图是项目根目录的 `app-icon.png`（1024x1024）。改完重跑 `npx tauri icon app-icon.png`
即可重新生成全套（含 Windows 的多尺寸 `icon.ico`）。

`targets` 只留 `nsis`，**不要加回 msi**——MSI 需要从 GitHub 下载 WiX 工具链，本机网络会超时，
且 NSIS 已覆盖文件关联，`installMode: currentUser` 还免管理员权限。

产物体积参考：主程序 6.0 MB，安装包 2.88 MB（涨的主要是 mermaid 那 5.3 MB 前端资源）。

### 文件关联

`fileAssociations` 的 `name` 字段在 Windows 上**直接当 ProgID 用**。
早期写的是通用词 `Markdown`，被别的 Markdown 软件覆盖后整个关联就没了——
表现是「打开方式」列表里找得到本程序，但设不成默认。现在用 `ClayDraft.md` 独占命名空间。

光有 ProgID 还不够：Windows 的「设置 → 默认应用」要按应用整体指定，
还需要 `Capabilities` + `RegisteredApplications` 两组键，缺了它程序在那个列表里
根本不作为一个「应用」出现。这两组由 `installer-hooks.nsh` 在 `NSIS_HOOK_POSTINSTALL` 里写，
全部写 HKCU（`installMode` 固定 currentUser，没有管理员权限，写 HKLM 会静默失败）。
该文件**必须存成 UTF-8 BOM**，缺 BOM 时 makensis 会把中文按 ANSI 解析成乱码。

注：Windows 10 1803+ 起 `UserChoice` 注册表项有哈希保护，**程序无法自行抢占默认打开方式**。
安装包只能把路铺平，用户仍需手动确认一次。VS Code、Typora 同理。

## 运行时验证（每次发版前过一遍）

v0.1.0 全过。此后前端拆成了多文件、加了 Word 导出，**1.0.0 的这份清单尚未整体重跑**
（Word 导出的版面在开发中反复验过，其余项没有逐条复核）。

Tauri 2 的 ACL（`capabilities/default.json`）写错时**编译期不报错、运行时静默失败**，
只能实际点一遍才能确认。**改动权限声明后务必重跑这份清单**：

- `dialog:default` -> Ctrl+O 打开对话框、另存为对话框、未保存确认框
- `core:window:allow-set-title` -> 标题栏随文件名和脏标记更新
- `core:window:allow-destroy` -> 关窗确认后能真正关闭
- 编码探测 -> 用 `../test-md/` 下四个样本逐个验，编码栏应分别显示
  `UTF-8 · LF` / `UTF-8 BOM · LF` / `GB18030 · CRLF` / `UTF-8 · CRLF`

下面这些**只能实机点**，headless 浏览器和单测都覆盖不到，改相关代码后要过一遍：

- 导出 PDF -> 点按钮能选路径并真的落盘；开深色主题再导一次，PDF 应是浅色
- 粘贴截图 -> Ctrl+V 后图片出现在预览里，且 `<文档名>.assets/` 下确实多了文件
- 图片显示 -> **务必用中文目录的文档验**，纯英文路径不会触发百分号编码那个坑
- 另存为迁移 -> 带图的文档另存成别的名字，新文件里的图仍然显示
- 文件关联 -> 装完后「设置 → 默认应用」里搜得到 Clay Draft，双击 .md 能打开
- 标签页 -> 开三四个文档来回切，正文 / 目录 / 字数 / 编码栏 / 窗口标题都跟着走；
  滚动位置和光标位置切回来还在；改一个不存的直接关，另外几个不受影响
- 单实例 -> 程序开着时在资源管理器里**再双击一个 .md**，应当是原窗口多一个标签而不是新开窗口
- 文档间跳转 -> 写一个 `[x](同目录文件.md)`，预览里点它应开成新标签；**用中文文件名验一次**
  （百分号编码那个坑纯英文路径不触发）；再验一次 `../` 上跳和指向不存在文件时的提示
- 会话恢复 -> 开几个文件后关掉程序再启动，标签应原样回来；把其中一个文件挪走再启动，
  那个标签应提示打不开并自行消失，其余不受影响
- 导出 Word -> **用 Word 真的打开一次**，不能报「文件已损坏」；导航窗格里有多级标题树、
  标题可折叠；「引用 → 插入目录」能生成自动目录；中文不是默认字体；表格有边框且跨页重复表头；
  带 mermaid 的文档里图是图而不是白框；**用中文目录的带图文档验一次**图片在不在

`test-md/` 是专为此准备的样本集，包含中文正文、生僻字与中文标点，不要删。
