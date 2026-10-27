/* ============================================================
   word.js —— 导出 .docx
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：src, docState, toast, baseName, isApp, invoke, dlg
   函数体内调用：CD.mermaidPng（mermaid.js）——写在函数体里，不在顶层取
   回填 core：（无）

   分工：这里把 marked 的 token 树转成一份中间结构（IR），Rust 侧
   (src-tauri/src/docx.rs) 再把 IR 变成 OOXML。markdown 不在 Rust 里重解析一遍——
   预览用的就是 marked，重写一套必然分叉。
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var src = CD.src, docState = CD.docState, toast = CD.toast,
      baseName = CD.baseName, isApp = CD.isApp, invoke = CD.invoke, dlg = CD.dlg;

  var btn = document.getElementById("fileWord");

  /* 版心宽度。与 docx.rs 的 layout::CONTENT_W 同源：
     (11906 - 1021*2) twip ÷ 1440 × 96dpi ≈ 657px。图片再宽也不越过它。 */
  var MAX_W = 657;

  /* ---------- 语法高亮配色 ----------
     颜色从 CSSOM 里的 @media print 规则实时读，不在这儿抄第二份——
     否则主题就多了第五处要同步的定义（见 CLAUDE.md「主题三态（其实是四处）」）。
     下面这份只是兜底：file:// 下读 link 进来的样式表会因跨源抛 SecurityError，
     但那个模式本来就没有导出功能，兜底值只为不让代码炸掉。 */
  var SYN_FALLBACK = {
    comment: "9A968B", key: "9B4B2E", str: "5C7355",
    num: "8A6A28", fn: "3F5E7A", prop: "6B4E7D", op: "6F6C63"
  };
  var synCache = null;

  function hex6(v){
    v = String(v || "").trim().replace(/^#/, "");
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : "";
  }

  function synColors(){
    if (synCache) return synCache;
    var out = {};
    for (var k in SYN_FALLBACK) out[k] = SYN_FALLBACK[k];
    try {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++){
        var rules;
        try { rules = sheets[i].cssRules; } catch(e){ continue; }  /* 跨源，跳过 */
        if (!rules) continue;
        for (var j = 0; j < rules.length; j++){
          var r = rules[j];
          if (!r.media || String(r.media.mediaText).indexOf("print") < 0) continue;
          for (var m = 0; m < r.cssRules.length; m++){
            var sub = r.cssRules[m];
            if (!sub.style || !sub.selectorText) continue;
            if (sub.selectorText.indexOf(":root") < 0) continue;
            for (var key in out){
              var v = hex6(sub.style.getPropertyValue("--syn-" + key));
              if (v) out[key] = v;
            }
          }
        }
      }
    } catch(e){}
    synCache = out;
    return out;
  }

  /* Prism 的 token 类型 → 配色键。照抄 css/doc.css 里那组 .token.* 选择器，
     改那边记得改这里。 */
  var TOKEN_COLOR = {
    comment: "comment", prolog: "comment", doctype: "comment", cdata: "comment",
    punctuation: "op", operator: "op", entity: "op", url: "op",
    property: "prop", tag: "prop", symbol: "prop", "attr-name": "prop", deleted: "prop",
    boolean: "num", number: "num", constant: "num",
    string: "str", char: "str", "attr-value": "str", builtin: "str",
    inserted: "str", selector: "str",
    atrule: "key", keyword: "key", important: "key",
    "function": "fn", "class-name": "fn", regex: "fn", variable: "fn"
  };

  function flattenPrism(toks, color, bold, out){
    var colors = synColors();
    toks.forEach(function(t){
      if (typeof t === "string"){ out.push({ text: t, color: color, b: bold }); return; }
      var key = TOKEN_COLOR[t.type] || (t.alias && TOKEN_COLOR[[].concat(t.alias)[0]]) || null;
      var c = key ? (colors[key] || color) : color;
      var bd = key === "key" ? true : bold;
      if (typeof t.content === "string") out.push({ text: t.content, color: c, b: bd });
      else flattenPrism([].concat(t.content), c, bd, out);
    });
  }

  /** 代码块 → 逐行的 run 数组。每行单独成段，长代码才能分页 */
  function codeLines(text, lang){
    var runs = [];
    var grammar = window.Prism && lang && window.Prism.languages[lang];
    if (grammar){
      try { flattenPrism(window.Prism.tokenize(text, grammar), "", false, runs); }
      catch(e){ runs = [{ text: text }]; }
    } else {
      runs = [{ text: text }];
    }
    var lines = [], cur = [];
    lines.push(cur);
    runs.forEach(function(r){
      var parts = String(r.text).split("\n");
      for (var i = 0; i < parts.length; i++){
        if (i > 0){ cur = []; lines.push(cur); }
        if (parts[i]) cur.push({ text: parts[i], color: r.color || "", b: !!r.b });
      }
    });
    while (lines.length && !lines[lines.length - 1].length) lines.pop();
    return lines.length ? lines : [[]];
  }

  /* ---------- 行内 ---------- */

  /* marked 的 text / codespan 里留的是 HTML 实体（&amp; &lt; 之类），
     渲染时才由 renderer 还原。我们要的是字面文本，所以这里解一次。 */
  function unent(s){
    if (s == null) return "";
    s = String(s);
    if (s.indexOf("&") < 0) return s;
    var d = document.createElement("textarea");
    d.innerHTML = s;
    return d.value;
  }

  function stripTags(h){
    var d = document.createElement("div");
    d.innerHTML = String(h || "");
    return d.textContent || "";
  }

  function mk(text, st){
    return {
      text: unent(text), b: !!st.b, i: !!st.i, s: !!st.s,
      code: !!st.code, link: st.link || "", color: ""
    };
  }

  /** 把 md 源里的 <img> 标签抠出来（本项目的图片尺寸就是写成 HTML 的） */
  function imgsInHtml(html){
    var d = document.createElement("div");
    d.innerHTML = String(html || "");
    return Array.prototype.map.call(d.querySelectorAll("img"), function(im){
      return { src: im.getAttribute("src") || "", width: parseInt(im.getAttribute("width"), 10) || 0 };
    });
  }

  function inlineRuns(tokens, st, out, ctx){
    (tokens || []).forEach(function(t){
      var n = { b: st.b, i: st.i, s: st.s, code: st.code, link: st.link };
      switch (t.type){
        case "strong": n.b = true; inlineRuns(t.tokens, n, out, ctx); break;
        case "em":     n.i = true; inlineRuns(t.tokens, n, out, ctx); break;
        case "del":    n.s = true; inlineRuns(t.tokens, n, out, ctx); break;
        case "link":
          n.link = t.href || "";
          inlineRuns(t.tokens, n, out, ctx);
          break;
        case "codespan":
          n.code = true;
          out.push(mk(t.text, n));
          break;
        case "br":
          /* 本项目开了 breaks:true，单换行也是换行，不能当空格吞掉 */
          out.push({ text: "", br: true, b: false, i: false, s: false, code: false, link: "", color: "" });
          break;
        case "image":
          ctx.imgs.push({ src: t.href || "", width: 0, alt: t.text || "" });
          break;
        case "html":
          imgsInHtml(t.text).forEach(function(g){ ctx.imgs.push({ src: g.src, width: g.width, alt: "" }); });
          var rest = stripTags(t.text);
          if (rest.trim()) out.push(mk(rest, n));
          break;
        case "escape":
          out.push(mk(t.text, n));
          break;
        default:
          if (t.tokens && t.tokens.length) inlineRuns(t.tokens, n, out, ctx);
          else if (t.text != null) out.push(mk(t.text, n));
      }
    });
  }

  var BASE = { b: false, i: false, s: false, code: false, link: "" };

  function runsOf(tokens, ctx){
    var out = [];
    inlineRuns(tokens, BASE, out, ctx);
    return out;
  }

  /* ---------- 块 ---------- */

  function walkList(list, level, items, ctx){
    var ordered = !!list.ordered;
    /* 序号在这里算成字面文本，**不交给 Word 的自动编号**。
       Word 那边所有有序列表会被当成同一个序列一路递增：第二个列表接着上一个的号
       继续数下去。而 markdown 里每个列表都是独立的，各自从自己的 start 开始。
       嵌套列表走各自的递归，所以也各有各的计数。 */
    var n = ordered ? (parseInt(list.start, 10) || 1) : 0;
    (list.items || []).forEach(function(it){
      var runs = [];
      (it.tokens || []).forEach(function(sub){
        if (sub.type === "list") return;                 /* 嵌套稍后单独走 */
        if (sub.type === "text" || sub.type === "paragraph"){
          inlineRuns(sub.tokens && sub.tokens.length ? sub.tokens
                     : [{ type: "text", text: sub.text }], BASE, runs, ctx);
        } else if (sub.tokens){
          inlineRuns(sub.tokens, BASE, runs, ctx);
        } else if (sub.text != null){
          runs.push(mk(sub.text, BASE));
        }
      });
      if (it.task) runs.unshift(mk(it.checked ? "☑ " : "☐ ", BASE));
      items.push({ level: level, num: ordered ? (n++) + "." : "", runs: runs });
      (it.tokens || []).forEach(function(sub){
        if (sub.type === "list") walkList(sub, level + 1, items, ctx);
      });
    });
  }

  function blocksOf(tokens, ctx){
    var out = [];
    (tokens || []).forEach(function(t){
      switch (t.type){
        case "space":
        case "def":
          break;

        case "heading":
          out.push({ type: "heading", level: Math.min(6, t.depth || 1),
                     runs: runsOf(t.tokens, ctx) });
          break;

        case "code":
          if ((t.lang || "").toLowerCase() === "mermaid"){
            /* mermaid 交给 mermaid.js 重新渲染并栅格化。
               它是模块间调用，写在函数体里用 CD.xxx，不在顶层取——
               顶层取的话就依赖 script 的加载顺序了。 */
            var mid = ctx.newId();
            ctx.jobs.push(
              (CD.mermaidPng ? CD.mermaidPng(t.text, 2) : Promise.reject())
                .then(function(r){
                  var w = Math.min(r.w, MAX_W);
                  return { id: mid, data: r.data, ext: "png",
                           w: Math.round(w), h: Math.round(w * r.h / r.w) };
                }, function(){ return { id: mid, fail: true }; })
            );
            out.push({ type: "image", id: mid, w: 0, h: 0, alt: "流程图" });
          } else {
            out.push({ type: "code", lang: t.lang || "",
                       lines: codeLines(t.text || "", (t.lang || "").toLowerCase()) });
          }
          break;

        case "blockquote":
          out.push({ type: "quote", blocks: blocksOf(t.tokens, ctx) });
          break;

        case "list":
          var items = [];
          walkList(t, 0, items, ctx);
          out.push({ type: "list", items: items });
          break;

        case "table":
          out.push({
            type: "table",
            header: (t.header || []).map(function(c){ return runsOf(c.tokens, ctx); }),
            rows: (t.rows || []).map(function(row){
              return row.map(function(c){ return runsOf(c.tokens, ctx); });
            }),
            align: (t.align || []).map(function(a){ return a || "left"; })
          });
          break;

        case "hr":
          out.push({ type: "hr" });
          break;

        case "html":
          imgsInHtml(t.text).forEach(function(g){
            out.push(imageBlock(g.src, g.width, "", ctx));
          });
          var txt = stripTags(t.text);
          if (txt.trim()) out.push({ type: "para", runs: [mk(txt, BASE)] });
          break;

        case "paragraph":
        default:
          var sub = { imgs: [], jobs: ctx.jobs, newId: ctx.newId };
          var runs = runsOf(t.tokens || [], sub);
          /* 图片单独成块居中排，不做行内图——Word 里正文夹图排版更难收拾 */
          var hasText = runs.some(function(r){ return r.text && r.text.trim(); });
          if (hasText) out.push({ type: "para", runs: runs });
          sub.imgs.forEach(function(g){
            out.push(imageBlock(g.src, g.width, g.alt, ctx));
          });
      }
    });
    return out;
  }

  /* ---------- 图片 ---------- */

  function extOfDataUrl(url){
    var m = /^data:image\/([a-z0-9.+-]+)/i.exec(url || "");
    var e = (m ? m[1] : "png").toLowerCase();
    if (e === "jpg") e = "jpeg";
    return ["png", "jpeg", "gif", "bmp"].indexOf(e) >= 0 ? e : "png";
  }

  /** data URL → 尺寸算好的图片记录。拿不到就 resolve 一个 fail，整张图跳过 */
  function measure(id, url, wantW){
    return new Promise(function(res){
      var im = new Image();
      im.onload = function(){
        var nw = im.naturalWidth || 1, nh = im.naturalHeight || 1;
        var w = wantW || nw;
        if (w > MAX_W) w = MAX_W;
        res({ id: id, data: url.slice(url.indexOf(",") + 1), ext: extOfDataUrl(url),
              w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(w * nh / nw)) });
      };
      im.onerror = function(){ res({ id: id, fail: true }); };
      im.src = url;
    });
  }

  function imageBlock(rawSrc, width, alt, ctx){
    var id = ctx.newId();
    var p = rawSrc || "";
    /* marked 会把路径当 URL 做百分号编码，中文目录会变成 %E7%AC%94%E8%AE%B0…，
       拿去找文件必然落空。和 images.js 一样，交给 Rust 前先解回来。 */
    try { p = decodeURIComponent(p); } catch(e){}

    if (/^data:/i.test(p)){
      ctx.jobs.push(measure(id, p, width));
    } else if (/^(https?:|blob:|tauri:)/i.test(p) || !p){
      /* 外链不下载：导出不该在用户不知情时发起网络请求 */
      ctx.jobs.push(Promise.resolve({ id: id, fail: true }));
    } else {
      ctx.jobs.push(
        invoke("read_image", { docPath: docState.path, src: p })
          .then(function(url){ return measure(id, url, width); },
                function(){ return { id: id, fail: true }; })
      );
    }
    return { type: "image", id: id, w: 0, h: 0, alt: alt || "" };
  }

  /** 把异步拿到的尺寸填回占位块，并剔掉失败的图 */
  function fixup(blocks, got){
    var out = [];
    blocks.forEach(function(b){
      if (b.type === "image"){
        var r = got[b.id];
        if (!r || r.fail) return;          /* 读不到的图整块丢掉，不留破图 */
        b.w = r.w; b.h = r.h;
        out.push(b);
        return;
      }
      if (b.type === "quote") b.blocks = fixup(b.blocks, got);
      out.push(b);
    });
    return out;
  }

  /* ---------- 导出 ---------- */

  function buildIr(){
    var seq = 0;
    var ctx = {
      jobs: [],
      imgs: [],
      newId: function(){ return "img" + (++seq); }
    };
    var tokens = window.marked.lexer(src.value);
    var blocks = blocksOf(tokens, ctx);

    return Promise.all(ctx.jobs).then(function(res){
      var got = {}, images = [];
      res.forEach(function(r){
        if (!r || r.fail) { if (r) got[r.id] = r; return; }
        got[r.id] = r;
        images.push({ id: r.id, data: r.data, ext: r.ext });
      });
      return {
        title: baseName(docState.path).replace(/\.[^.]+$/, ""),
        blocks: fixup(blocks, got),
        images: images
      };
    });
  }

  function doExportWord(){
    if (!dlg || !isApp) return;
    if (!window.marked || !window.marked.lexer){
      toast("Markdown 解析器未加载，无法导出");
      return;
    }
    var base = docState.path ? baseName(docState.path).replace(/\.[^.]+$/, "") : "未命名";
    return dlg.save({
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
      defaultPath: base + ".docx"
    }).then(function(path){
      if (!path) return;
      toast("正在生成 Word...");
      return buildIr().then(function(ir){
        return invoke("export_docx", { path: path, doc: ir }).then(function(){
          toast("已导出 " + baseName(path));
        });
      });
    }).catch(function(err){ toast(String(err)); });
  }

  if (btn){
    if (isApp){
      btn.addEventListener("click", doExportWord);
    } else {
      /* 浏览器模式没有文件系统，和其余文件按钮一样禁掉 */
      btn.disabled = true;
      btn.style.opacity = ".4";
      btn.style.cursor = "not-allowed";
      btn.title = "导出 Word 仅在桌面版可用";
    }
  }
})();
