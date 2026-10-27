/* ============================================================
   images.js —— 本地图片：Rust 读成 data URL、拖拽调宽、点击放大
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：src, preview, docState, blockMap, toast, update, scheduleSave, invoke
   回填 core：resolveImages, decorateImages
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var src = CD.src, preview = CD.preview, docState = CD.docState, blockMap = CD.blockMap, toast = CD.toast, update = CD.update, scheduleSave = CD.scheduleSave, invoke = CD.invoke;

  /* ---------- 本地图片 ----------
     预览页的 base URL 是 tauri://localhost，md 里的相对路径在 webview 里
     解析不到，只能让 Rust 读成 data URL 换上去。按「文档路径 + src」缓存，
     打字时不会反复读盘。 */
  var imgCache = {};

  function resolveImages(){
    /* invoke 在文件层才赋值，这里用 typeof 兜住浏览器模式和首次渲染 */
    if (typeof invoke !== "function" || !invoke || !docState.path) return;
    var pending = [];
    Array.prototype.forEach.call(preview.querySelectorAll("img[src]"), function(im){
      var attr = im.getAttribute("src") || "";
      if (!attr || /^(data:|https?:|blob:|tauri:)/i.test(attr)) return;   /* 外链和内联图不碰 */
      /* marked 会把路径当 URL 做百分号编码，中文目录名会变成 %E6%8A%80... 这种，
         直接拿去找文件必然落空。这里解回真实文件名再交给 Rust。 */
      var raw = attr;
      try { raw = decodeURIComponent(attr); } catch(e){}
      var key = docState.path + "||" + raw;
      if (Object.prototype.hasOwnProperty.call(imgCache, key)){
        if (imgCache[key]){ im.dataset.origSrc = raw; im.src = imgCache[key]; }
        else { im.removeAttribute("src"); im.setAttribute("data-missing", "1");
               if (!im.alt) im.alt = "图片不存在：" + raw; }
        return;
      }
      if (pending.indexOf(raw) < 0) pending.push(raw);
    });
    if (!pending.length) return;
    Promise.all(pending.map(function(raw){
      var key = docState.path + "||" + raw;
      return invoke("read_image", { docPath: docState.path, src: raw }).then(
        function(url){ imgCache[key] = url; },
        function(){ imgCache[key] = ""; }   /* 失败也记一笔，否则会反复读盘 */
      );
    })).then(function(){ resolveImages(); });   /* 回来时 DOM 可能已重建，重扫一遍 */
  }

  /* ---------- 图片：拖拽调宽 + 点击放大 ----------
     尺寸要留得住就必须写进源码。markdown 标准语法没有尺寸，所以改写成标准
     HTML 的 <img width>，GitHub、VS Code 这些都认，不是私有扩展。 */
  function escRe(t){ return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* 把图片尺寸写回源码：markdown 形式改成 HTML 形式，已是 HTML 的就更新 width */
  function setImageWidth(bi, srcRaw, width){
    var blk = blockMap[bi];
    if (!blk) return;
    if (src.value.slice(blk.start, blk.end) !== blk.raw){ toast("源码已变化，尺寸未保存"); return; }
    var q = escRe(srcRaw), next = null, raw = blk.raw;

    /* 已经是 <img ...>：有 width 就换掉，没有就插一个 */
    var htmlRe = new RegExp("<img\\s[^>]*src=[\"']" + q + "[\"'][^>]*>", "i");
    var hit = raw.match(htmlRe);
    if (hit){
      var tag = hit[0];
      var newTag = /\swidth=/i.test(tag)
        ? tag.replace(/\swidth=[\"']?\d+[\"']?/i, ' width="' + width + '"')
        : tag.replace(/\s*\/?>$/, ' width="' + width + '">');
      next = raw.replace(tag, newTag);
    } else {
      /* markdown 形式 ![alt](src) */
      var mdRe = new RegExp("!\\[([^\\]]*)\\]\\(" + q + "\\)");
      var m = raw.match(mdRe);
      if (!m) return;
      var alt = m[1] ? ' alt="' + m[1].replace(/"/g, "&quot;") + '"' : "";
      next = raw.replace(m[0], '<img src="' + srcRaw + '"' + alt + ' width="' + width + '">');
    }
    if (next === null || next === raw) return;

    src.focus();
    src.setSelectionRange(blk.start, blk.end);
    var ok = false;
    try { ok = document.execCommand("insertText", false, next); } catch(e){}
    if (!ok){
      src.value = src.value.slice(0, blk.start) + next + src.value.slice(blk.end);
      update(); scheduleSave();
    }
  }

  var lightbox = null;
  function openLightbox(url){
    closeLightbox();
    lightbox = document.createElement("div");
    lightbox.className = "lightbox";
    var big = document.createElement("img");
    big.src = url;
    lightbox.appendChild(big);
    lightbox.addEventListener("click", closeLightbox);
    document.body.appendChild(lightbox);
  }
  function closeLightbox(){
    if (lightbox && lightbox.parentNode) lightbox.parentNode.removeChild(lightbox);
    lightbox = null;
  }
  window.addEventListener("keydown", function(ev){
    if (ev.key === "Escape" && lightbox){ ev.preventDefault(); closeLightbox(); }
  });

  /* 每轮 update 都重建 DOM，手柄要跟着重挂 */
  function decorateImages(){
    Array.prototype.forEach.call(preview.querySelectorAll("img"), function(im){
      var wrap = im.parentElement;
      if (!wrap || !wrap.classList.contains("imgwrap")){
        wrap = document.createElement("span");
        wrap.className = "imgwrap";
        im.parentNode.insertBefore(wrap, im);
        wrap.appendChild(im);
      }
      if (wrap.querySelector(".img-handle")) return;

      im.addEventListener("click", function(ev){
        /* 停止冒泡，免得连带触发所在段落的双击编辑 */
        ev.stopPropagation();
        if (im.getAttribute("src")) openLightbox(im.src);
      });

      var badge = document.createElement("span");
      badge.className = "img-size";
      wrap.appendChild(badge);

      var h = document.createElement("span");
      h.className = "img-handle";
      h.title = "拖动调整宽度";
      wrap.appendChild(h);

      h.addEventListener("mousedown", function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var startX = ev.clientX, startW = im.getBoundingClientRect().width;
        var maxW = preview.clientWidth - 56;
        wrap.classList.add("resizing");
        function move(e){
          var w = Math.round(Math.min(maxW, Math.max(60, startW + (e.clientX - startX))));
          im.style.width = w + "px";
          im.style.maxWidth = "100%";
          badge.textContent = w + " px";
        }
        function up(){
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          wrap.classList.remove("resizing");
          var finalW = Math.round(im.getBoundingClientRect().width);
          var host = im.closest("[data-bi]");
          if (!host) return;
          var attr = im.getAttribute("src") || "";
          var raw = attr;
          try { raw = decodeURIComponent(attr); } catch(e){}
          /* data URL 是我们换上去的，写回要用源码里原本那个相对路径 */
          if (im.dataset && im.dataset.origSrc) raw = im.dataset.origSrc;
          setImageWidth(+host.getAttribute("data-bi"), raw, finalW);
        }
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    });
  }

  /* ---------- 回填 core ---------- */
  CD.resolveImages = resolveImages;
  CD.decorateImages = decorateImages;
})();
