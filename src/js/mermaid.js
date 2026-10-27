/* ============================================================
   mermaid.js —— mermaid 流程图：懒加载 5.3MB 的库，按「主题 + 源码」缓存渲染结果
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：src, preview, esc, update
   回填 core：renderMermaid, mermaidPng
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var src = CD.src, preview = CD.preview, esc = CD.esc, update = CD.update;

  /* ---------- mermaid ----------
     5.3MB 的库，全量预加载会把启动时间打回原形，所以只在文档里真出现
     mermaid 代码块时才注入 script。渲染结果按「主题 + 源码」做键缓存：
     打字时源码没变就同步复用上一次的 SVG，否则每敲一个字都要重画一次图，
     既卡又闪。 */
  var mmCache = {}, mmSeq = 0, mmInitTheme = null;
  var mmLoad = { state: "idle", waiting: [] };

  function mmTheme(){
    var t = document.documentElement.getAttribute("data-theme");
    var dark = t ? t === "dark"
                 : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? "dark" : "default";
  }

  function mmEnsure(cb){
    if (mmLoad.state === "ready") return cb(true);
    if (mmLoad.state === "failed") return cb(false);
    mmLoad.waiting.push(cb);
    if (mmLoad.state === "loading") return;
    mmLoad.state = "loading";
    var sc = document.createElement("script");
    sc.src = "./vendor/mermaid.min.js";
    sc.onload = function(){
      mmLoad.state = window.mermaid ? "ready" : "failed";
      var ok = mmLoad.state === "ready";
      mmLoad.waiting.splice(0).forEach(function(f){ f(ok); });
    };
    sc.onerror = function(){
      mmLoad.state = "failed";
      mmLoad.waiting.splice(0).forEach(function(f){ f(false); });
    };
    document.head.appendChild(sc);
  }

  /* 配色直接从 :root 的 token 读，不在这儿再抄一份 hex——
     以后调色板，流程图自动跟着变，保持单一真相源。
     mermaid 只有 base 主题完整接受 themeVariables，别的主题会忽略大半。 */
  function mmVars(){
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb){ return (cs.getPropertyValue(name) || "").trim() || fb; }
    return {
      rail:     v("--rail",      "#F0EEE6"),
      ink:      v("--ink",       "#141413"),
      inkSoft:  v("--ink-soft",  "#6F6C63"),
      inkFaint: v("--ink-faint", "#9A968B"),
      clay:     v("--clay",      "#D97757"),
      paper:    v("--paper",     "#FAF9F5"),
      surface:  v("--surface",   "#FFFFFF"),
      line:     v("--line",      "#E6E3D9")
    };
  }

  /* mermaid 的配色是烘焙进 SVG 的，不认 CSS 变量，切深浅色必须重新 initialize */
  function mmInit(theme){
    if (mmInitTheme === theme) return;
    var c = mmVars();
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        background: c.surface,
        /* 节点退成纸面：靠底色差和正文区分，不靠彩色 */
        primaryColor: c.rail,
        mainBkg: c.rail,
        secondaryColor: c.surface,
        tertiaryColor: c.surface,
        /* 边框勾出边界即可，别喧宾夺主 */
        primaryBorderColor: c.inkFaint,
        nodeBorder: c.inkFaint,
        /* 文字与正文同色，图是正文的一部分 */
        primaryTextColor: c.ink,
        nodeTextColor: c.ink,
        textColor: c.ink,
        /* 连线比节点边框重——结构主干才是信息所在，把层级正过来 */
        lineColor: c.inkSoft,
        edgeLabelBackground: c.paper,
        /* 子图再退一层 */
        clusterBkg: c.surface,
        clusterBorder: c.line,
        titleColor: c.clay,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: "14px"
      }
    });
    mmInitTheme = theme;
  }

  function mmSwap(code, html){
    var pre = code.parentNode;
    if (!pre || pre.tagName !== "PRE" || !pre.parentNode) return;
    var box = document.createElement("div");
    box.className = "mermaid-box";
    box.innerHTML = html;
    /* 位置属性要搬过来，否则图渲染出来后就双击不回源码了 */
    ["data-pos","data-tok","data-bi"].forEach(function(a){
      if (pre.hasAttribute(a)) box.setAttribute(a, pre.getAttribute(a));
    });
    pre.parentNode.replaceChild(box, pre);
  }

  function mmErr(src, e){
    var msg = (e && (e.message || e.str)) ? String(e.message || e.str) : String(e);
    return '<div class="mermaid-err"><b>流程图语法有误</b>：' + esc(msg) + '</div>'
         + '<pre><code>' + esc(src) + '</code></pre>';
  }

  function renderMermaid(){
    var codes = preview.querySelectorAll("pre > code.language-mermaid");
    if (!codes.length) return;
    var theme = mmTheme(), todo = [];
    Array.prototype.forEach.call(codes, function(code){
      var src = code.textContent;
      var hit = mmCache[theme + "||" + src];
      if (hit) mmSwap(code, hit);
      else if (todo.indexOf(src) < 0) todo.push(src);
    });
    if (!todo.length) return;
    mmEnsure(function(ok){
      if (!ok) return;            /* 加载失败就让代码块原样留着，不至于白屏 */
      mmInit(theme);
      Promise.all(todo.map(function(src){
        return window.mermaid.render("mmd" + (++mmSeq), src).then(
          function(r){ mmCache[theme + "||" + src] = r.svg; },
          function(e){ mmCache[theme + "||" + src] = mmErr(src, e); }
        );
      })).then(function(){
        /* 渲染期间 DOM 可能已被新一轮 update 换掉，所以不保留旧引用，
           重新扫一遍拿缓存替换。此时全部命中，不会再递归。 */
        renderMermaid();
      });
    });
  }

  /* ---------- 导出用：把一张图渲染成 PNG ----------
     给 word.js 用。Word 不认 mermaid，也不认我们屏幕上那份 SVG。

     **屏幕上那份 SVG 不能直接拿来栅格化。** mermaid 的 htmlLabels 默认为 true，
     节点文字是 <foreignObject> 里的 HTML；而 canvas 的 drawImage 画到
     foreignObject 就停住——Chromium 不渲染它，出来的是一张只有连线和方框、
     没有任何文字的图。所以导出必须用 htmlLabels:false 重新渲染一遍，
     让文字变成 SVG 原生的 <text>。

     重渲染是离屏的（mermaid.render 返回字符串，不碰预览 DOM），屏幕不会闪。
     渲染完把 mmInitTheme 置空，下一次 update() 会自动把屏幕配置初始化回来。 */
  function mmExportInit(){
    var noHtml = { htmlLabels: false, useMaxWidth: false };
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      flowchart: noHtml,
      class: noHtml,
      state: noHtml,
      themeVariables: {
        /* 纸面固定走浅色，不跟随当前主题——深色主题导出的 Word 不该是黑底 */
        background: "#FFFFFF",
        primaryColor: "#F4F2EC",
        mainBkg: "#F4F2EC",
        secondaryColor: "#FFFFFF",
        tertiaryColor: "#FFFFFF",
        primaryBorderColor: "#6F6C63",
        nodeBorder: "#6F6C63",
        primaryTextColor: "#141413",
        nodeTextColor: "#141413",
        textColor: "#141413",
        lineColor: "#4A4843",
        edgeLabelBackground: "#FFFFFF",
        clusterBkg: "#FFFFFF",
        clusterBorder: "#D9D5CA",
        titleColor: "#C2643F",
        /* 与 docx.rs 的 layout::F_CJK 一致，图里的字和正文才是一套 */
        fontFamily: "Microsoft YaHei, Times New Roman, sans-serif",
        fontSize: "14px"
      }
    });
    mmInitTheme = null;   /* 让下一轮 update() 把屏幕配置装回来 */
  }

  /** 返回 Promise<{data, w, h}>：data 是不带前缀的 base64 PNG，w/h 是 CSS 像素 */
  function mermaidPng(code, scale){
    scale = scale || 2;
    return new Promise(function(resolve, reject){
      mmEnsure(function(ok){
        if (!ok) return reject(new Error("mermaid 未能加载"));
        try { mmExportInit(); } catch(e){ return reject(e); }
        var id = "mmx" + (++mmSeq);
        var done = function(svg){
          var holder = document.createElement("div");
          holder.innerHTML = svg;
          var el = holder.querySelector("svg");
          if (!el) return reject(new Error("mermaid 没有产出 SVG"));
          /* canvas 需要显式的像素尺寸，只有 viewBox 是量不出来的 */
          var vb = (el.getAttribute("viewBox") || "").split(/[\s,]+/);
          var w = Math.ceil(parseFloat(el.getAttribute("width")) || parseFloat(vb[2]) || 800);
          var h = Math.ceil(parseFloat(el.getAttribute("height")) || parseFloat(vb[3]) || 600);
          el.setAttribute("width", w);
          el.setAttribute("height", h);
          var ser = new XMLSerializer().serializeToString(el);
          var img = new Image();
          img.onload = function(){
            try {
              var cv = document.createElement("canvas");
              cv.width = w * scale; cv.height = h * scale;
              var cx = cv.getContext("2d");
              cx.fillStyle = "#FFFFFF";          /* PNG 默认透明，Word 里会透出底色 */
              cx.fillRect(0, 0, cv.width, cv.height);
              cx.drawImage(img, 0, 0, cv.width, cv.height);
              var url = cv.toDataURL("image/png");
              resolve({ data: url.slice(url.indexOf(",") + 1), w: w, h: h });
            } catch(e){ reject(e); }
          };
          img.onerror = function(){ reject(new Error("SVG 栅格化失败")); };
          /* 走 base64 而不是 blob URL：blob 在部分环境下会污染 canvas，
             一污染 toDataURL 就抛 SecurityError。 */
          img.src = "data:image/svg+xml;base64," +
            btoa(unescape(encodeURIComponent(ser)));
        };
        try {
          var r = window.mermaid.render(id, code);
          /* mermaid 10+ 返回 Promise，更早的版本是同步返回对象 */
          if (r && typeof r.then === "function") r.then(function(o){ done(o.svg); }, reject);
          else done(r && r.svg ? r.svg : r);
        } catch(e){ reject(e); }
      });
    });
  }

  /* ---------- 回填 core ---------- */
  CD.renderMermaid = renderMermaid;
  CD.mermaidPng = mermaidPng;
})();
