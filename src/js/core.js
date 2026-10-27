/* ============================================================
   core.js —— 共享内核
   DOM 引用、文档状态、渲染管线、块映射、原地编辑、工具栏、
   同步滚动、字体自检、窗格开关、环境探测。

   拆分约定（改动前务必先读）：
     1. 本文件必须最先加载，它建立 window.CD；模块只依赖 core，模块之间不互相依赖
     2. 跨文件共享的符号一律挂 CD，模块顶部取同名别名，函数体因此一字未改
     3. 被别名引用的变量不得整体重新赋值（会让别名指向陈旧值），只能就地修改
     4. core 调用模块里的函数一律写 CD.xxx()——模块尚未加载时 bare 名字不在任何
        作用域里，typeof 守卫会静默返回 undefined，功能无声失效
   ============================================================ */


(function(){
  /* 模块共享面：模块按同名别名取用，末尾统一赋值 */
  var CD = window.CD = {};

  "use strict";

  /* 启动文件尽早开问：这趟 IPC 与下面几百毫秒的初始化并行跑，
     等初始化做完时结果通常已经在手。好处是整个启动只渲染一次，
     且渲染的就是目标文件——不再「先渲染示例稿、再被目标文件覆盖」。 */
  var bootReq = null;
  try {
    var bootApi = window.__TAURI__;
    if (bootApi && bootApi.core && bootApi.core.invoke){
      bootReq = bootApi.core.invoke("take_startup_file").then(function(p){
        return p ? bootApi.core.invoke("read_doc", { path: p }) : null;
      });
    }
  } catch(e){ bootReq = null; }

  var SAMPLE = [
    "# 制丝车间杀虫库WES系统 V1.0",
    "",
    "> 软著登记表 · 填写建议稿（示例文稿，可整段替换成你自己的内容）",
    "",
    "## 开发目的",
    "",
    "针对卷烟厂烟丝库木质烟箱充氮虫情治理作业中，立体库 **WMS**、**AGV 调度系统**、电控 **PLC**、输送装置及安全监测等子系统相互独立、缺乏统一调度核心，作业过程依赖人工纸质记录与经验计时的问题，开发本软件。系统以仓储执行系统（WES）作为总调度中枢，将“生产工单 — 设备动作 — 充氮工艺计时 — 安全联锁 — 数据追溯”纳入一体化闭环管控。",
    "",
    "## 软件的主要功能",
    "",
    "| 模块 | 核心职责 | 关键输出 |",
    "| --- | --- | --- |",
    "| 工单与任务管理 | 解析 MES 工单并拆解排程 | 出库 / 搬运 / 入位 / 回库任务 |",
    "| 充氮工艺与计时 | 按批次独立计时、超时预警 | 杀虫起止时间、工艺状态 |",
    "| 标记与追溯 | 生成批次特征码 | “一箱一码”全链路档案 |",
    "| 安全联动 | 氧浓度 / 火灾信号联锁 | 排风、停机、声光报警 |",
    "",
    "### 核心业务逻辑",
    "",
    "1. **状态机**：空闲 — 占用 — 杀虫中 — 已完成 — 待回库，保证账实一致",
    "2. **编码规则**：特征码含作业批次、入位时间、杀虫起止时间、货位号",
    "3. **分配算法**：按空闲状态、分区规则与就近原则自动优选货位",
    "4. **计时引擎**：支持按品种设定不同杀虫时长，到期自动提醒",
    "",
    "### 接口对接",
    "",
    "对上采用 `RESTful` 对接 MES 与 WMS，对下采用 `OPC UA / Modbus TCP` 对接电控 PLC。",
    "",
    "```json",
    "{",
    "  \"batchNo\": \"SC20260810-01\",",
    "  \"slot\":    \"A-12\",",
    "  \"state\":   \"杀虫中\",",
    "  \"endAt\":   \"2026-08-10T18:30:00+08:00\"",
    "}",
    "```",
    "",
    "---",
    "",
    "*字数按「中文字符 + 英文单词」计，与软著登记表、招投标文件的通行口径一致。*",
    ""
  ].join("\n");

  var KEY = "clay-draft-doc";
  /* 预览里点得开的本地文档类型，与「打开」对话框的筛选保持一致 */
  var DOC_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;
  var src = document.getElementById("src");
  var preview = document.getElementById("preview");
  var app = document.getElementById("app");
  var toastEl = document.getElementById("toast");

  var render;
  if (window.marked) {
    if (window.marked.setOptions) window.marked.setOptions({ gfm:true, breaks:true, headerIds:false, mangle:false });
    render = function(t){ return (window.marked.parse ? window.marked.parse(t) : window.marked(t)); };
  } else {
    render = fallbackRender;
  }

  function esc(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function inline(s){
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }

  function fallbackRender(text){
    var lines = text.split(/\r?\n/), out = [], i = 0;
    function cells(l){ return l.replace(/^\||\|$/g,"").split("|").map(function(s){ return s.trim(); }); }
    function buildTable(rows){
      var th = rows[0].map(function(c){ return "<th>" + inline(c) + "</th>"; }).join("");
      var tb = rows.slice(2).map(function(r){
        return "<tr>" + r.map(function(c){ return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
      }).join("");
      return "<table><thead><tr>" + th + "</tr></thead><tbody>" + tb + "</tbody></table>";
    }

    while (i < lines.length){
      var l = lines[i];
      if (/^```/.test(l)){
        var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if (/^\s*$/.test(l)) { i++; continue; }
      if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      var h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h){ var n = h[1].length; out.push("<h"+n+">"+inline(h[2])+"</h"+n+">"); i++; continue; }
      if (/^\|/.test(l) && i+1 < lines.length && /^\|?[\s:|-]+$/.test(lines[i+1])){
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push(buildTable(rows)); continue;
      }
      if (/^>\s?/.test(l)){
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/,"")); i++; }
        out.push("<blockquote>" + fallbackRender(q.join("\n")) + "</blockquote>"); continue;
      }
      if (/^\s*[-*+]\s+/.test(l)){
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push("<li>"+inline(lines[i].replace(/^\s*[-*+]\s+/,""))+"</li>"); i++; }
        out.push("<ul>"+ul.join("")+"</ul>"); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)){
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push("<li>"+inline(lines[i].replace(/^\s*\d+[.)]\s+/,""))+"</li>"); i++; }
        out.push("<ol>"+ol.join("")+"</ol>"); continue;
      }
      var p = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>|\||```|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) { p.push(lines[i]); i++; }
      out.push("<p>" + inline(p.join("\n")).replace(/\n/g,"<br>") + "</p>");
    }
    return out.join("\n");
  }

  /* 用内联 SVG 而不是字符图标：字符会从回落字体里取字形，
     不同字体的大小和基线差别很大，控制不住。 */
  var ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<rect x="5.6" y="5.6" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>'
    + '<path d="M10.4 3.4 H3.6 A1.6 1.6 0 0 0 2 5 v6.8" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linecap="round"/></svg>';
  /* 格式化图标：三条递进缩进的横线，比 {} 更直白地表达「重新排版」 */
  var ICON_FMT = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M2.5 4 H13.5 M5.5 8 H13.5 M5.5 12 H11" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3.4 8.4 L6.4 11.4 L12.6 4.6" fill="none" stroke="currentColor"'
    + ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* clipboard API 被拦时的兜底复制。代码块要的是原样纯文本，走隐藏 textarea。 */
  function legacyCopyText(text){
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch(e){}
    document.body.removeChild(ta);
    return ok;
  }

  /* JSON 格式化。必须写回源码——只改显示的话，下一次 update 重建就没了。
     走和原地编辑同一套：先校验源码没漂，再用 insertText 写回保住撤销栈。 */
  function formatJson(bi, btn){
    var blk = blockMap[bi];
    if (!blk){ toast("找不到对应的源码位置"); return; }
    if (src.value.slice(blk.start, blk.end) !== blk.raw){
      toast("源码已变化，请重新试一次"); return;
    }
    var tk = blk.token, obj;
    try { obj = JSON.parse(tk.text); }
    catch(e){ toast("JSON 语法有误：" + e.message); return; }

    var pretty = JSON.stringify(obj, null, 2);
    if (pretty === tk.text){ toast("已经是格式化好的"); return; }

    var tail = (blk.raw.match(/\n*$/) || [""])[0];   /* code 块的 raw 未必带尾换行，这里不能想当然 */
    var next = "```" + (tk.lang || "json") + "\n" + pretty + "\n```" + tail;
    src.focus();
    src.setSelectionRange(blk.start, blk.end);
    var ok = false;
    try { ok = document.execCommand("insertText", false, next); } catch(e){}
    if (!ok){
      src.value = src.value.slice(0, blk.start) + next + src.value.slice(blk.end);
      update(); scheduleSave();
    }
    btn.classList.add("ok");
    toast("已格式化");
  }

  function copyCode(pre, btn){
    var code = pre.querySelector("code");
    var text = code ? code.textContent : pre.textContent;
    function done(ok){
      if (!ok) { toast("复制被拦截，请手动选取"); return; }
      btn.innerHTML = ICON_OK;
      btn.classList.add("ok");
      btn.title = "已复制";
      clearTimeout(btn._t);
      btn._t = setTimeout(function(){
        btn.innerHTML = ICON_COPY; btn.classList.remove("ok"); btn.title = "复制代码";
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(
        function(){ done(true); },
        function(){ done(legacyCopyText(text)); }
      );
    } else {
      done(legacyCopyText(text));
    }
  }


  /* ---------- 预览块 ↔ 源码位置映射 ----------
     给每个顶层元素记下它在源码里的字符区间，双击就能跳回去。

     偏移不能靠累加 raw.length：引用式链接定义（[ref]: url）不会进顶层 token
     数组，一旦文档里有这种写法，它之后所有块的偏移会整体错位，写回时就会
     啃掉别人的内容。改成从上一个 token 的结束处往后 indexOf，缝隙自动跳过。 */
  var blockMap = [];

  function tagBlocks(text){
    blockMap.length = 0;   /* 就地清空：images.js 持有它的别名，整体重新赋值会让那边指向陈旧数组 */
    if (!(window.marked && window.marked.lexer)) return;   /* 回退渲染器没有 lexer */
    var tokens;
    try { tokens = window.marked.lexer(text); } catch(e){ return; }

    /* 保险：token 数与顶层元素数对不上就整体放弃。
       宁可这个功能失效，也不能错位——错位会导致写回时改错地方。 */
    var solid = tokens.filter(function(t){ return t.type !== "space"; });
    if (solid.length !== preview.children.length) return;

    var cursor = 0, ei = 0;
    tokens.forEach(function(tk){
      var idx = text.indexOf(tk.raw, cursor);
      if (idx < 0) return;
      cursor = idx + tk.raw.length;
      if (tk.type === "space") return;
      var el = preview.children[ei++];
      if (!el) return;
      el.setAttribute("data-pos", idx + "," + cursor);
      el.setAttribute("data-tok", tk.type);
      el.setAttribute("data-bi", blockMap.length);
      blockMap.push({ start: idx, end: cursor, raw: tk.raw, token: tk });
    });
  }

  /* 把源码区滚到指定区间并选中。textarea 没有「滚动到选区」的原生 API，
     只能按行号乘行高自己算。 */
  function locateInSource(start, end){
    if (!paneOn.edit){ paneOn.edit = true; applyPanes(); }   /* 编辑区关着就先打开 */
    src.focus();
    src.setSelectionRange(start, end);

    var line = src.value.slice(0, start).split("\n").length;
    var cs = getComputedStyle(src);
    var lh = parseFloat(cs.lineHeight) || 24;
    var padTop = parseFloat(cs.paddingTop) || 0;
    var top = padTop + (line - 1) * lh - src.clientHeight / 3;

    /* 借用同步滚动的锁：程序化滚动会触发 scroll 事件，
       不压住的话预览会被反向拖走，双击的那块就滚出视野了。 */
    lock = "v";
    src.scrollTop = Math.max(0, top);
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function(){ lock = null; }, 150);
  }

  /* ---------- 原地编辑（标题 / 代码块）----------
     编辑的是 markdown 源文本而不是渲染后的 HTML：标题里的 **加粗** 原样显示。
     这样不需要写 HTML→Markdown 转换器，也就没有「转换丢格式」这类数据风险。 */
  var editingBox = null;

  function autoGrow(ta){
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  function startInline(el, bi){
    if (editingBox) return;
    var blk = blockMap[bi];
    if (!blk) return;
    /* 源码必须与记录时逐字一致，否则位置可能已经漂了，直接放弃 */
    if (src.value.slice(blk.start, blk.end) !== blk.raw){
      toast("源码已变化，请重新双击"); return;
    }
    var tk = blk.token;
    var isCode = tk.type === "code", isHeading = tk.type === "heading";
    /* 标题和代码块给「净内容」（不含 ## 和围栏），其余块直接编辑它的
       markdown 原文——这样段落、列表、引用、表格用同一套机制就都能改，
       在段落里敲两个回车分成两段，顺带就是「新增」。 */
    var body = (isHeading || isCode) ? tk.text : blk.raw.replace(/\n+$/, "");
    /* 表格、列表这类在编辑源码，竖线和缩进要对齐，必须等宽；
       标题和段落是自然语言，用原字体读着顺。 */
    var mono = !isHeading && tk.type !== "paragraph";

    var ta = document.createElement("textarea");
    ta.className = "inline-edit" + (mono ? " code" : "");
    ta.value = body;
    ta.spellcheck = false;
    if (!mono){
      var cs = getComputedStyle(el);
      ta.style.fontSize = cs.fontSize;
      ta.style.fontFamily = cs.fontFamily;
      ta.style.fontWeight = cs.fontWeight;
      ta.style.lineHeight = cs.lineHeight;
    }
    el.style.display = "none";
    el.parentNode.insertBefore(ta, el);
    editingBox = { ta: ta, el: el, blk: blk, orig: body };
    autoGrow(ta); ta.focus(); ta.select();

    ta.addEventListener("input", function(){ autoGrow(ta); });
    ta.addEventListener("keydown", function(ev){
      if (ev.key === "Escape"){ ev.preventDefault(); endInline(false); }
      else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)){ ev.preventDefault(); endInline(true); }
      else if (ev.key === "Enter" && isHeading && !ev.shiftKey){ ev.preventDefault(); endInline(true); }
    });
    ta.addEventListener("blur", function(){ endInline(true); });
  }

  function endInline(commit){
    if (!editingBox) return;
    var box = editingBox;
    editingBox = null;                      /* 先清空，避免 blur 再次进来 */
    var blk = box.blk, tk = blk.token, value = box.ta.value;
    if (box.ta.parentNode) box.ta.parentNode.removeChild(box.ta);
    box.el.style.display = "";

    if (!commit || value === box.orig) return;
    if (src.value.slice(blk.start, blk.end) !== blk.raw){
      toast("源码已变化，改动未写回"); return;
    }

    var tail = blk.raw.match(/\n*$/)[0];   /* 原有的尾部空行数量要留住 */
    var next;
    if (tk.type === "heading"){
      /* 标题只能占一行，用户敲进来的换行折成空格 */
      next = new Array(tk.depth + 1).join("#") + " "
           + value.replace(/\s*\n+\s*/g, " ") + tail;
    } else if (tk.type === "code"){
      var fence = "```";
      next = fence + (tk.lang || "") + "\n" + value + "\n" + fence + tail;
    } else {
      /* 编辑的本来就是 markdown 原文，原样写回即可 */
      next = value + tail;
    }

    src.focus();
    src.setSelectionRange(blk.start, blk.end);
    /* 用 insertText 而不是直接赋值 value：后者会清掉浏览器原生撤销栈，
       在预览里改完再按 Ctrl+Z 就会一口气退回很早的状态。
       insertText 同时会触发 input 事件，update 和自动存草稿都跟着走。 */
    var ok = false;
    try { ok = document.execCommand("insertText", false, next); } catch(e){}
    if (!ok){
      src.value = src.value.slice(0, blk.start) + next + src.value.slice(blk.end);
      update(); scheduleSave();
    }
  }

  preview.addEventListener("dblclick", function(ev){
    if (!ev.target || !ev.target.closest) return;
    /* 双击文档链接 = 点了两下，第一下已经切走了，这里再开编辑框就是对着
       已经换掉的正文改，白忙一场还会弹「源码已变化」 */
    if (ev.target.closest("a.doclink")) return;
    var el = ev.target.closest("[data-pos]");
    if (!el) return;
    var bi = +el.getAttribute("data-bi");
    /* 双击 = 原地改；Alt+双击 = 跳回源码对应位置。两个手势分开，互不抢。 */
    if (!ev.altKey && blockMap[bi]){
      startInline(el, bi);
      return;
    }
    var p = (el.getAttribute("data-pos") || "").split(",");
    if (p.length !== 2) return;
    locateInSource(+p[0], +p[1]);
  });

  /* 语法高亮。每次 update 都会重建 innerHTML，代码块要重新上色；
     按「语言 + 源码」缓存结果，打字时同一块不重复跑。 */
  var hlCache = {};

  function highlightCode(){
    if (!window.Prism) return;
    Array.prototype.forEach.call(
      preview.querySelectorAll("pre > code[class*='language-']"), function(code){
        var m = /language-([\w-]+)/.exec(code.className || "");
        var lang = m ? m[1] : "";
        if (!lang || !window.Prism.languages[lang]) return;   /* 没这门语言就原样留着 */
        var key = lang + "||" + code.textContent;
        if (hlCache[key] != null){ code.innerHTML = hlCache[key]; return; }
        try {
          window.Prism.highlightElement(code);
          hlCache[key] = code.innerHTML;
        } catch(e){}
      });
  }


  function update(){
    if (editingBox) return;    /* 正在原地编辑，重建会把光标连根拔掉 */
    var t = src.value;
    preview.innerHTML = render(t);
    tagBlocks(t);          /* 必须紧跟渲染，此时 DOM 还是 marked 的原始输出 */
    Array.prototype.forEach.call(preview.querySelectorAll("table"), function(tb){
      if (tb.parentElement && tb.parentElement.classList.contains("tablewrap")) return;
      var w = document.createElement("div"); w.className = "tablewrap";
      tb.parentNode.insertBefore(w, tb); w.appendChild(tb);
    });
    CD.renderMermaid();
    highlightCode();
    CD.resolveImages();
    CD.decorateImages();
    Array.prototype.forEach.call(preview.querySelectorAll("pre"), function(pre){
      var w = pre.parentElement;
      if (!w || !w.classList.contains("codewrap")){
        w = document.createElement("div");
        w.className = "codewrap";
        pre.parentNode.insertBefore(w, pre);
        w.appendChild(pre);
      }
      var tools = document.createElement("div");
      tools.className = "code-tools";

      /* 只有 JSON 给格式化按钮：别的语言各需一套 formatter，体积不划算 */
      var code = pre.querySelector("code");
      var lang = code ? (/language-([\w-]+)/.exec(code.className || "") || [])[1] : "";
      var bi = pre.getAttribute("data-bi");
      if (lang === "json" && bi !== null && blockMap[+bi]){
        var f = document.createElement("button");
        f.type = "button";
        f.className = "code-btn code-fmt";
        f.title = "格式化 JSON";
        f.setAttribute("aria-label", "格式化 JSON");
        f.innerHTML = ICON_FMT;
        (function(idx, btn){
          btn.addEventListener("click", function(){ formatJson(idx, btn); });
        })(+bi, f);
        tools.appendChild(f);
      }

      var b = document.createElement("button");
      b.type = "button";
      b.className = "code-btn code-copy";
      b.title = "复制代码";
      b.setAttribute("aria-label", "复制代码");
      b.innerHTML = ICON_COPY;
      b.addEventListener("click", function(){ copyCode(pre, b); });
      tools.appendChild(b);
      w.appendChild(tools);
    });
    Array.prototype.forEach.call(preview.querySelectorAll("a[href]"), function(a){
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) === "#") return;                  /* 页内锚点，交给浏览器 */
      /* 相对路径指向的本地文档：只打标记，点击由 file.js 接管（见「文档间跳转」）。
         带协议的（http/mailto/...）和其余相对路径仍按外链处理。 */
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && DOC_EXT.test(href.split(/[#?]/)[0])){
        a.classList.add("doclink");
        a.title = "点击打开：" + href;
        return;
      }
      a.target = "_blank"; a.rel = "noopener";
    });
    CD.buildToc();

    var plain = t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
    var cjk = (plain.match(/[㐀-鿿豈-﫿぀-ヿ]/g) || []).length;
    var en  = (plain.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
    document.getElementById("cCjk").textContent   = cjk.toLocaleString();
    document.getElementById("cEn").textContent    = en.toLocaleString();
    document.getElementById("cTotal").textContent = (cjk + en).toLocaleString();
    document.getElementById("cPara").textContent  = t.split(/\n\s*\n/).filter(function(s){ return s.trim(); }).length;
    document.getElementById("cLine").textContent  = t.split(/\n/).length;
  }

  /* 先让编辑区把源码显示出来（textarea 赋值几乎零成本），
     预览的解析与排版推迟到这一帧画完之后——大文档下能提前几百毫秒看到内容。
     rAF 的回调仍在绘制之前执行，所以要再套一层 setTimeout 才真正让出这一帧。 */
  function renderSoon(){
    if (!window.requestAnimationFrame) return update();
    requestAnimationFrame(function(){ setTimeout(update, 0); });
  }


  var saveTimer, dot = document.getElementById("dot"), savedAt = document.getElementById("savedAt");
  function pad(n){ return n < 10 ? "0" + n : "" + n; }
  function hhmm(){ var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

  /* 取路径最后一段。放在 core 而不是 file.js，是因为 word.js 也要用它起默认文件名，
     而模块之间不该互相取符号。 */
  function baseName(p){
    if (!p) return "未命名";
    var m = String(p).split(/[\\/]/);
    return m[m.length - 1] || p;
  }

  /* 当前文档的落盘状态。saved 存的是最后一次与磁盘一致的文本，
     用它跟编辑区比对得出「有无未保存修改」，比维护一个 dirty 布尔可靠。 */
  var docState = { path: null, encoding: "utf-8", eol: "lf", saved: null };

  function scheduleSave(){
    dot.classList.remove("on");
    savedAt.textContent = docState.path ? "有未保存的修改" : "编辑中...";
    if (CD.refreshFileUI) CD.refreshFileUI();
    CD.refreshTabs();            /* 脏标记同时画在标签上 */
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      /* 已绑定文件的文档不自动写盘——自动改用户磁盘上的文件太冒失，
         只有未命名草稿才存到浏览器本地，防止意外丢失 */
      if (docState.path) return;
      try {
        /* 每个未命名标签各存各的草稿；首个标签仍用 KEY 这个旧键 */
        localStorage.setItem(CD.tabDraftKey ? CD.tabDraftKey() : KEY, src.value);
        savedAt.textContent = "草稿已存本机 " + hhmm();
        dot.classList.add("on");
      } catch(e){ savedAt.textContent = "本机存储不可用"; }
    }, 500);
  }

  var initial = SAMPLE, restored = false;
  try { var s = localStorage.getItem(KEY); if (s !== null && s.trim()) { initial = s; restored = true; } } catch(e){}
  /* 本机草稿 / 示例稿的开局。withFileUI 只在桌面版为真——
     浏览器模式下 refreshFileUI 依赖的几个 DOM 引用要到文件层才赋值。 */
  function bootLocal(withFileUI){
    src.value = initial;
    renderSoon();
    if (restored) { savedAt.textContent = "已载入本机草稿"; dot.classList.add("on"); }
    if (withFileUI) refreshFileUI();
  }

  /* 桌面版的开局顺序：先恢复上次开着的标签，再把双击带进来的文件另开一个标签。
     两者都没有才落到本机草稿 / 示例稿。此时所有模块已加载完（bootReq 是异步的），
     所以这里可以放心调 CD.restoreSession。 */
  function bootStart(doc){
    var restoredTabs = CD.restoreSession ? CD.restoreSession() : false;
    if (doc) CD.afterLoad(doc);
    else if (!restoredTabs) bootLocal(true);
  }

  if (bootReq){
    bootReq.then(
      function(doc){ bootStart(doc); },
      function(err){ bootStart(null); toast(String(err)); }
    );
  } else {
    /* 浏览器模式：同步开局，tabs.js 随后把它认领成第一个标签 */
    bootLocal(false);
  }

  src.addEventListener("input", function(){ update(); scheduleSave(); });

  function setSel(a, b){ src.focus(); src.setSelectionRange(a, b); }

  function wrap(mark){
    var s = src.selectionStart, e = src.selectionEnd, v = src.value;
    var sel = v.slice(s, e) || "文字";
    var before = v.slice(0, s), after = v.slice(e);
    if (before.slice(-mark.length) === mark && after.slice(0, mark.length) === mark){
      src.value = before.slice(0, -mark.length) + sel + after.slice(mark.length);
      setSel(s - mark.length, s - mark.length + sel.length);
    } else {
      src.value = before + mark + sel + mark + after;
      setSel(s + mark.length, s + mark.length + sel.length);
    }
    update(); scheduleSave();
  }

  function lineMark(mark){
    var v = src.value, s = src.selectionStart, e = src.selectionEnd;
    var a = v.lastIndexOf("\n", s - 1) + 1;
    var b = v.indexOf("\n", e); if (b === -1) b = v.length;
    var block = v.slice(a, b).split("\n");
    var ordered = /^\d+\.\s$/.test(mark);
    var already = block.every(function(l){
      return ordered ? /^\d+[.)]\s/.test(l) : l.indexOf(mark) === 0;
    });
    var outLines = block.map(function(l, idx){
      var clean = l.replace(/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/, "");
      if (already) return clean;
      return (ordered ? (idx + 1) + ". " : mark) + clean;
    });
    var joined = outLines.join("\n");
    src.value = v.slice(0, a) + joined + v.slice(b);
    setSel(a, a + joined.length);
    update(); scheduleSave();
  }

  function insert(kind){
    var s = src.selectionStart, e = src.selectionEnd, v = src.value, sel = v.slice(s, e);
    var text, caret;
    if (kind === "link"){ text = "[" + (sel || "链接文字") + "](https://)"; caret = text.length - 1; }
    else if (kind === "rule"){ text = "\n---\n"; caret = text.length; }
    else { text = "\n| 项目 | 说明 |\n| --- | --- |\n| 　 | 　 |\n"; caret = text.length; }
    src.value = v.slice(0, s) + text + v.slice(e);
    setSel(s + caret, s + caret);
    update(); scheduleSave();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tb"), function(btn){
    btn.addEventListener("click", function(){
      if (btn.dataset.wrap) wrap(btn.dataset.wrap);
      else if (btn.dataset.line) lineMark(btn.dataset.line);
      else if (btn.dataset.insert) insert(btn.dataset.insert);
    });
  });

  src.addEventListener("keydown", function(ev){
    var mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === "b"){ ev.preventDefault(); wrap("**"); }
    else if (mod && ev.key.toLowerCase() === "i"){ ev.preventDefault(); wrap("*"); }
    else if (mod && ev.key.toLowerCase() === "k"){ ev.preventDefault(); insert("link"); }
    else if (ev.key === "Tab" && !mod){   /* Ctrl+Tab 是切标签，别在这里吃掉 */
      ev.preventDefault();
      var s = src.selectionStart, e = src.selectionEnd;
      src.value = src.value.slice(0, s) + "  " + src.value.slice(e);
      setSel(s + 2, s + 2); update(); scheduleSave();
    }
  });

  function toast(msg){
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function(){ toastEl.classList.remove("show"); }, 1800);
  }

  document.getElementById("copyMd").addEventListener("click", function(){
    var t = src.value;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(
        function(){ toast("Markdown 原文已复制"); },
        function(){ toast("复制被浏览器拦截，请手动全选"); }
      );
    } else {
      src.select();
      try { document.execCommand("copy"); toast("Markdown 原文已复制"); }
      catch(e){ toast("复制被浏览器拦截，请手动全选"); }
    }
  });

  var themeBtn = document.getElementById("theme");
  try { var st = localStorage.getItem("clay-draft-theme"); if (st) document.documentElement.setAttribute("data-theme", st); } catch(e){}
  themeBtn.addEventListener("click", function(){
    var cur = document.documentElement.getAttribute("data-theme");
    var isDark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("clay-draft-theme", next); } catch(e){}
    update();   /* mermaid 的主题是渲染进 SVG 的，不重画就会留一张旧配色的图 */
  });

  var panes = document.getElementById("panes"), splitter = document.getElementById("split"), dragging = false;
  splitter.addEventListener("mousedown", function(ev){ dragging = true; ev.preventDefault(); document.body.style.cursor = "col-resize"; });
  window.addEventListener("mousemove", function(ev){
    if (!dragging) return;
    var r = panes.getBoundingClientRect();
    var pct = ((ev.clientX - r.left) / r.width) * 100;
    pct = Math.min(78, Math.max(22, pct));
    document.documentElement.style.setProperty("--split", pct.toFixed(2) + "%");
  });
  window.addEventListener("mouseup", function(){ if (dragging){ dragging = false; document.body.style.cursor = ""; } });

  var lock = null, lockTimer;
  function link(a, b, tag){
    a.addEventListener("scroll", function(){
      if (lock && lock !== tag) return;
      lock = tag;
      var max = a.scrollHeight - a.clientHeight;
      var ratio = max > 0 ? a.scrollTop / max : 0;
      b.scrollTop = ratio * (b.scrollHeight - b.clientHeight);
      clearTimeout(lockTimer); lockTimer = setTimeout(function(){ lock = null; }, 90);
    });
  }
  var paneEdit = document.getElementById("paneEdit"), paneView = document.getElementById("paneView");
  /* 编辑侧要接 textarea 而不是 .pane-edit：后者的 scrollHeight 恒等于 clientHeight，
     永远不会触发 scroll，双栏同步一直是失效的。 */
  link(src, paneView, "e"); link(paneView, src, "v");

  /* 程序化设置 scrollTop 同样会触发 scroll 事件，会被同步滚动当成用户操作反向拖走。
     切标签恢复滚动位置时先压一下：tag 取 "x"，两个方向的 handler 都会直接返回。 */
  function holdScroll(){
    lock = "x";
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function(){ lock = null; }, 140);
  }

  /* 字体实测：用 canvas 量同一串拉丁字的宽度，与 monospace 基线比较。
     宽度一致说明该家族没命中，浏览器已静默回落。 */
  function fontHit(family, weight){
    var ctx = document.createElement("canvas").getContext("2d");
    var probe = "WMillLM@0123456789 Handgloves";
    ctx.font = (weight || 400) + " 16px monospace";
    var base = ctx.measureText(probe).width;
    ctx.font = (weight || 400) + ' 16px "' + family + '", monospace';
    return Math.abs(ctx.measureText(probe).width - base) > 0.5;
  }

  /* 汉字几乎都是全宽，换字体后字面宽度不变，量宽法在 CJK 上失效。
     改量墨迹外框（actualBoundingBox*），与微软雅黑基线比对。 */
  function cjkHit(family, weight){
    var ctx = document.createElement("canvas").getContext("2d");
    var probe = "制丝车间杀虫库";
    function ink(stack){
      ctx.font = (weight || 500) + ' 48px ' + stack;
      var m = ctx.measureText(probe);
      return [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent,
              m.actualBoundingBoxLeft, m.actualBoundingBoxRight]
        .map(function(v){ return Math.round((v || 0) * 100); }).join("/");
    }
    return ink('"' + family + '","Microsoft YaHei"') !== ink('"Microsoft YaHei"');
  }

  function reportFonts(){
    var checks = [
      { label: "Times",   ok: fontHit("Times New Roman", 400) },
      { label: "兰亭黑",   ok: cjkHit("FZLanTingHei", 400) },
      { label: "思源宋",   ok: cjkHit("Noto Serif SC HAN", 500) }
    ];
    var el = document.getElementById("fontState");
    el.innerHTML = checks.map(function(c){
      return c.label + " " + (c.ok ? "&#10003;" : "&#10007; 回落");
    }).join(" &middot; ");
    el.style.color = checks.every(function(c){ return c.ok; }) ? "" : "var(--clay)";
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportFonts);
  else setTimeout(reportFonts, 300);

  /* ---------- 文件层（仅桌面版可用） ----------
     浏览器里打开时 window.__TAURI__ 不存在，本段整体降级：
     文件按钮禁用，其余功能照常，同一份 index.html 两处都能跑。 */
  var TAURI   = window.__TAURI__;
  var isApp   = !!(TAURI && TAURI.core && TAURI.core.invoke);
  var invoke  = isApp ? TAURI.core.invoke : null;
  var dlg     = isApp && TAURI.dialog ? TAURI.dialog : null;
  var appWin  = null;
  try { appWin = isApp && TAURI.window ? TAURI.window.getCurrentWindow() : null; } catch(e){}

  /* ---------- 窗格开关 ----------
     两栏各自独立开关；关掉编辑区即得到铺满整窗的全局预览。
     不允许两栏同时关闭——真关掉就什么都没有了，此时把另一栏顶上来。 */
  var ptEdit = document.getElementById("ptEdit");
  var ptView = document.getElementById("ptView");
  var paneOn = { edit: true, view: true };

  try {
    var pstate = localStorage.getItem("clay-draft-panes");
    if (pstate === "edit")      paneOn = { edit: true,  view: false };
    else if (pstate === "view") paneOn = { edit: false, view: true  };
  } catch(e){}

  function applyPanes(){
    app.classList.toggle("hide-edit", !paneOn.edit);
    app.classList.toggle("hide-view", !paneOn.view);
    ptEdit.setAttribute("aria-pressed", String(paneOn.edit));
    ptView.setAttribute("aria-pressed", String(paneOn.view));
    try {
      localStorage.setItem("clay-draft-panes",
        paneOn.edit && paneOn.view ? "both" : (paneOn.edit ? "edit" : "view"));
    } catch(e){}
  }

  function togglePane(which){
    paneOn[which] = !paneOn[which];
    if (!paneOn.edit && !paneOn.view) paneOn[which === "edit" ? "view" : "edit"] = true;
    applyPanes();
    CD.markActive();
  }

  ptEdit.addEventListener("click", function(){ togglePane("edit"); });
  ptView.addEventListener("click", function(){ togglePane("view"); });

  /* Ctrl/Cmd + \ 在「分屏」与「全局预览」之间来回切 */
  window.addEventListener("keydown", function(ev){
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "\\"){
      ev.preventDefault();
      togglePane("edit");
    }
  });

  applyPanes();

  /* ---------- 导出给 js/*.js 的共享面 ----------
     赋值放在最末尾，确保上面所有 var 都已初始化。 */
  CD.src = src;
  CD.preview = preview;
  CD.paneView = paneView;
  CD.dot = dot;
  CD.savedAt = savedAt;
  CD.docState = docState;
  CD.blockMap = blockMap;
  CD.esc = esc;
  CD.render = render;
  CD.endInline = endInline;
  CD.holdScroll = holdScroll;
  CD.SAMPLE = SAMPLE;
  CD.toast = toast;
  CD.update = update;
  CD.renderSoon = renderSoon;
  CD.scheduleSave = scheduleSave;
  CD.hhmm = hhmm;
  CD.baseName = baseName;
  CD.TAURI = TAURI;
  CD.isApp = isApp;
  CD.invoke = invoke;
  CD.dlg = dlg;
  CD.appWin = appWin;
})();
