/* ============================================================
   toc.js —— 目录树：按标题签名决定是否重建，折叠状态存 localStorage
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：preview, paneView, update
   回填 core：buildToc, markActive, tocPane, resetToc
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var preview = CD.preview, paneView = CD.paneView, update = CD.update;

  /* ---------- 目录 ----------
     每次 update() 重建。为避免正文打字时目录反复闪烁，先算一个标题签名，
     签名没变就直接跳过重建；折叠状态按「层级|标题文本#序号」记键，
     重名标题靠序号区分，存 localStorage。 */
  var tocEl      = document.getElementById("toc");
  var tocBody    = document.getElementById("tocBody");
  var tocCountEl = document.getElementById("tocCount");
  var tocToggle  = document.getElementById("tocToggle");
  var tocPane    = document.getElementById("paneView");
  var tocResize  = document.getElementById("tocResize");
  /* 用 SVG 而非 ▸ 字符：字符会从回落字体取字形，各字体里大小和基线差别很大 */
  var CHEV = '<svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">'
           + '<path d="M5 2.5 L10 7 L5 11.5" fill="none" stroke="currentColor"'
           + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var tocFold = {}, tocSig = "";

  try { tocFold = JSON.parse(localStorage.getItem("clay-draft-fold") || "{}") || {}; } catch(e){ tocFold = {}; }
  try { if (localStorage.getItem("clay-draft-toc") === "closed") tocEl.classList.add("collapsed"); } catch(e){}
  tocToggle.setAttribute("aria-expanded", String(!tocEl.classList.contains("collapsed")));

  tocToggle.addEventListener("click", function(){
    var collapsed = tocEl.classList.toggle("collapsed");
    tocToggle.setAttribute("aria-expanded", String(!collapsed));
    try { localStorage.setItem("clay-draft-toc", collapsed ? "closed" : "open"); } catch(e){}
  });

  function jumpTo(id){
    var el = document.getElementById(id);
    if (!el) return;
    /* 目录已移到左侧栏，不再遮挡顶部，只留一点呼吸余量 */
    var top = tocPane.scrollTop
            + (el.getBoundingClientRect().top - tocPane.getBoundingClientRect().top)
            - 16;
    if (tocPane.scrollTo) tocPane.scrollTo({ top: top, behavior: reduceMotion ? "auto" : "smooth" });
    else tocPane.scrollTop = top;
  }

  function renderNodes(nodes){
    var ul = document.createElement("ul");
    ul.className = "toc-list";
    nodes.forEach(function(n){
      var li = document.createElement("li");
      li.className = "toc-item lv" + n.level;
      var row = document.createElement("div");
      row.className = "toc-row";

      if (n.children.length){
        var tg = document.createElement("button");
        tg.type = "button";
        tg.className = "toc-tg";
        tg.innerHTML = CHEV;
        tg.setAttribute("aria-expanded", String(!tocFold[n.key]));
        tg.setAttribute("aria-label", (tocFold[n.key] ? "展开 " : "收起 ") + n.text);
        tg.addEventListener("click", function(ev){
          ev.stopPropagation();
          tocFold[n.key] = !tocFold[n.key];
          try { localStorage.setItem("clay-draft-fold", JSON.stringify(tocFold)); } catch(e){}
          buildToc(true);
        });
        row.appendChild(tg);
      } else {
        var sp = document.createElement("span");
        sp.className = "toc-tg empty";
        sp.setAttribute("aria-hidden", "true");
        row.appendChild(sp);
      }

      var link = document.createElement("button");
      link.type = "button";
      link.className = "toc-link";
      link.textContent = n.text;
      link.title = n.text;
      link.setAttribute("data-target", n.id);
      link.addEventListener("click", function(){ jumpTo(n.id); });
      row.appendChild(link);

      li.appendChild(row);
      if (n.children.length && !tocFold[n.key]) li.appendChild(renderNodes(n.children));
      ul.appendChild(li);
    });
    return ul;
  }

  function buildToc(force){
    var hs = Array.prototype.slice.call(preview.querySelectorAll("h1,h2,h3,h4"));
    /* innerHTML 每次都被替换，id 必须每轮重新写 */
    hs.forEach(function(h, i){ h.id = "hd" + i; });
    tocCountEl.textContent = hs.length;

    var sig = hs.map(function(h){ return h.tagName + "|" + h.textContent; }).join("\n")
            + "##" + JSON.stringify(tocFold);
    if (sig === tocSig && !force) return;
    tocSig = sig;

    if (!hs.length){
      tocBody.innerHTML = '<p class="toc-empty">文稿里还没有标题。用 # 开头写一级标题、## 写二级，目录会自动生成。</p>';
      return;
    }

    var root = { level: 0, children: [] }, stack = [root], seen = {};
    hs.forEach(function(h){
      var lv = +h.tagName.charAt(1);
      var base = lv + "|" + h.textContent;
      seen[base] = (seen[base] || 0) + 1;
      var node = { text: h.textContent, id: h.id, level: lv, children: [], key: base + "#" + seen[base] };
      while (stack.length > 1 && stack[stack.length - 1].level >= lv) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    });

    var keep = tocBody.scrollTop;
    tocBody.innerHTML = "";
    tocBody.appendChild(renderNodes(root.children));
    tocBody.scrollTop = keep;
    markActive();
  }

  function markActive(){
    var links = tocBody.querySelectorAll(".toc-link");
    if (!links.length) return;
    var edge = 32, cur = null;
    var paneTop = tocPane.getBoundingClientRect().top;
    Array.prototype.forEach.call(links, function(l){
      var el = document.getElementById(l.getAttribute("data-target"));
      if (el && el.getBoundingClientRect().top - paneTop <= edge) cur = l;
    });
    /* 停在文档最顶端时没有标题越过判定线，cur 为 null。
       兜底取第一项，保证任何时候都有且只有一项标着「你在这」。 */
    if (!cur) cur = links[0];
    Array.prototype.forEach.call(links, function(l){ l.classList.toggle("active", l === cur); });
  }

  /* 目录栏拖拽调宽：写到 :root 的 --toc-w，正文区 flex:1 会自动重排 */
  var TOC_MIN = 150, TOC_MAX = 460, tocW = 236, tocDrag = false;
  try {
    var savedW = parseInt(localStorage.getItem("clay-draft-tocw"), 10);
    if (savedW >= TOC_MIN && savedW <= TOC_MAX) tocW = savedW;
  } catch(e){}
  document.documentElement.style.setProperty("--toc-w", tocW + "px");

  tocResize.addEventListener("mousedown", function(ev){
    tocDrag = true;
    ev.preventDefault();
    tocEl.classList.add("dragging");
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", function(ev){
    if (!tocDrag) return;
    var left = tocEl.getBoundingClientRect().left;
    tocW = Math.min(TOC_MAX, Math.max(TOC_MIN, ev.clientX - left));
    document.documentElement.style.setProperty("--toc-w", tocW + "px");
  });
  window.addEventListener("mouseup", function(){
    if (!tocDrag) return;
    tocDrag = false;
    tocEl.classList.remove("dragging");
    document.body.style.cursor = "";
    try { localStorage.setItem("clay-draft-tocw", String(Math.round(tocW))); } catch(e){}
  });
  /* 双击拖拽边恢复默认宽度 */
  tocResize.addEventListener("dblclick", function(){
    tocW = 236;
    document.documentElement.style.setProperty("--toc-w", "236px");
    try { localStorage.setItem("clay-draft-tocw", "236"); } catch(e){}
  });

  var tocTick = false;
  tocPane.addEventListener("scroll", function(){
    if (tocTick) return;
    tocTick = true;
    requestAnimationFrame(function(){ markActive(); tocTick = false; });
  });

  /* 供 file.js 在打开新文档后强制重建目录（原先是直接写 tocSig） */
  function resetToc(){ tocSig = ""; }

  /* ---------- 回填 core ---------- */
  CD.buildToc = buildToc;
  CD.markActive = markActive;
  CD.tocPane = tocPane;
  CD.resetToc = resetToc;
})();
