/* ============================================================
   file.js —— 文件层：打开 / 保存 / 另存为 / 导出 PDF / 插图（仅桌面版可用）
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：src, preview, dot, savedAt, docState, toast, update, scheduleSave, hhmm, baseName, isApp, invoke, dlg, appWin, TAURI
   回填 core：refreshFileUI, afterLoad, saveActive
   打开的文档交给 tabs.js 安置（CD.openDoc），本文件不再自己往 src 里塞正文。
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var src = CD.src, preview = CD.preview, dot = CD.dot, savedAt = CD.savedAt, docState = CD.docState, toast = CD.toast, update = CD.update, scheduleSave = CD.scheduleSave, hhmm = CD.hhmm, baseName = CD.baseName, isApp = CD.isApp, invoke = CD.invoke, dlg = CD.dlg, appWin = CD.appWin, TAURI = CD.TAURI;


  var fileInfo = document.getElementById("fileInfo");
  var encInfo  = document.getElementById("encInfo");
  var btnOpen  = document.getElementById("fileOpen");
  var btnSave  = document.getElementById("fileSave");
  var btnSaveAs= document.getElementById("fileSaveAs");
  var btnPdf   = document.getElementById("filePdf");

  var MD_FILTER = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }];

  function isDirty(){ return docState.saved !== null && src.value !== docState.saved; }

  function refreshFileUI(){
    var dirty = isDirty();
    fileInfo.textContent = baseName(docState.path);
    fileInfo.title = docState.path || "尚未保存到文件";
    fileInfo.classList.toggle("dirty", dirty);
    var encLabel = ({
      "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", "gb18030": "GB18030",
      "gbk": "GBK", "big5": "Big5", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE"
    })[docState.encoding] || docState.encoding.toUpperCase();
    encInfo.textContent = encLabel + " \u00b7 " + docState.eol.toUpperCase();
    if (appWin && appWin.setTitle){
      appWin.setTitle((dirty ? "\u25cf " : "") + baseName(docState.path) + " — Clay Draft").catch(function(){});
    }
  }

  /* 读盘回来的文档一律交给标签层安置：已开着的切过去，当前是空白页就顶掉它，
     否则另开一个。渲染、目录重建、状态栏都在 tabs.js 的 apply() 里做。 */
  function afterLoad(doc){
    CD.openDoc(doc);
    CD.tocPane.scrollTop = 0;
  }

  function openPath(path){
    if (!isApp) return;
    invoke("read_doc", { path: path })
      .then(afterLoad)
      .catch(function(err){ toast(String(err)); });
  }

  /* 打开不再顶掉当前文档，一律进新标签，所以也就不用再问「放弃修改吗」。
     顺带允许多选：选几个就开几个标签。 */
  function doOpen(){
    if (!dlg) return;
    dlg.open({ multiple: true, filters: MD_FILTER }).then(function(sel){
      if (!sel) return;
      var list = Array.isArray(sel) ? sel : [sel];
      list.forEach(function(one){
        openPath(typeof one === "string" ? one : one.path);
      });
    }).catch(function(err){ toast(String(err)); });
  }

  function writeTo(path){
    return invoke("write_doc", {
      path: path, text: src.value,
      encoding: docState.encoding, eol: docState.eol
    }).then(function(){
      docState.path = path;
      docState.saved = src.value;
      dot.classList.add("on");
      savedAt.textContent = "已保存 " + hhmm();
      refreshFileUI();
      CD.refreshTabs();          /* 另存为会改名，标签上的文件名要跟着走 */
      toast("已保存到 " + baseName(path));
    }).catch(function(err){ toast(String(err)); });
  }

  function doSave(){
    if (!isApp) return;
    if (!docState.path) return doSaveAs();
    return writeTo(docState.path);
  }

  function stemOf(p){ return baseName(p).replace(/\.[^.]+$/, ""); }

  /* 另存为会改文档名，而图片目录是跟着文档名走的（笔记.md → 笔记.assets/）。
     不迁移的话，新文件里的引用会全部指向旧名字的目录，图就全断了。
     Rust 侧做的是复制而非移动，所以原文件不受影响。 */
  function migrateAssets(oldPath, newPath){
    if (!oldPath || oldPath === newPath || typeof invoke !== "function" || !invoke){
      return Promise.resolve();
    }
    return invoke("copy_assets", { oldDoc: oldPath, newDoc: newPath }).then(
      function(copied){
        if (!copied) return;
        var from = stemOf(oldPath) + ".assets/";
        var to   = stemOf(newPath) + ".assets/";
        /* 只换了目录位置、名字没变（比如另存到别的文件夹），引用不用动 */
        if (from === to || src.value.indexOf(from) < 0){
          toast("图片目录已一并复制过去");
          return;
        }
        var next = src.value.split(from).join(to);
        src.focus();
        src.setSelectionRange(0, src.value.length);
        var ok = false;
        try { ok = document.execCommand("insertText", false, next); } catch(e){}
        if (!ok){ src.value = next; update(); scheduleSave(); }
        toast("图片目录和引用已跟着改名");
      },
      function(err){ toast("图片目录迁移失败：" + err); }
    );
  }

  function doSaveAs(){
    if (!dlg) return;
    return dlg.save({
      filters: MD_FILTER,
      defaultPath: docState.path || "未命名.md"
    }).then(function(path){
      if (!path) return;
      /* 必须先迁移并改写引用，再写盘——否则存下去的还是旧引用 */
      var old = docState.path;
      return migrateAssets(old, path).then(function(){ return writeTo(path); });
    }).catch(function(err){ toast(String(err)); });
  }

  /* 导出 PDF。版面由 @media print 决定，Rust 侧只负责把当前页面写成文件。
     导出的是预览渲染结果，所以即便此刻关着预览栏也能正常出稿。 */
  function doExportPdf(){
    if (!dlg) return;
    var base = baseName(docState.path).replace(/\.[^.]+$/, "");
    if (!docState.path) base = "未命名";
    return dlg.save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: base + ".pdf"
    }).then(function(path){
      if (!path) return;
      toast("正在导出 PDF...");
      return invoke("export_pdf", { path: path }).then(function(){
        toast("已导出 " + baseName(path));
      });
    }).catch(function(err){ toast(String(err)); });
  }

  /* 在光标处插入文本。走 insertText 而不是改 value，保住原生撤销栈 */
  function insertAtCursor(text){
    src.focus();
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch(e){}
    if (!ok){
      var a = src.selectionStart, b = src.selectionEnd;
      src.value = src.value.slice(0, a) + text + src.value.slice(b);
      src.setSelectionRange(a + text.length, a + text.length);
      update(); scheduleSave();
    }
  }

  /* 文件名用时间戳到毫秒，同一秒连贴几张也不会撞名 */
  function imgStamp(ext){
    var d = new Date();
    function p(n, w){ var t = "" + n; while (t.length < (w || 2)) t = "0" + t; return t; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-"
         + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + "-"
         + p(d.getMilliseconds(), 3) + "." + ext;
  }

  var IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

  function needSavedDoc(){
    if (docState.path) return true;
    /* 没有文件路径就不知道图片该放哪。宁可提示，也不偷偷塞进临时目录 */
    toast("请先保存文档——图片要放在文档旁边的目录里");
    return false;
  }

  function afterInsertImage(rel){
    insertAtCursor("![](" + rel + ")\n");
    toast("已插入图片");
  }

  /* 粘贴进来的截图：转 base64 交给 Rust 落盘 */
  function insertImageBlob(file){
    if (!needSavedDoc()) return;
    var ext = ((file.type || "").split("/")[1] || "png").toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    var name = imgStamp(ext);
    var fr = new FileReader();
    fr.onload = function(){
      var b64 = String(fr.result || "").split(",")[1] || "";
      invoke("save_image", { docPath: docState.path, name: name, data: b64 })
        .then(afterInsertImage)
        .catch(function(e){ toast(String(e)); });
    };
    fr.readAsDataURL(file);
  }

  /* 磁盘上已有的图片：让 Rust 拷进 assets 目录 */
  function importImagePath(from){
    if (!needSavedDoc()) return;
    var ext = (String(from).split(".").pop() || "png").toLowerCase();
    invoke("import_image", { docPath: docState.path, from: from, name: imgStamp(ext) })
      .then(afterInsertImage)
      .catch(function(e){ toast(String(e)); });
  }

  src.addEventListener("paste", function(ev){
    if (typeof invoke !== "function" || !invoke) return;
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++){
      if ((items[i].type || "").indexOf("image/") !== 0) continue;
      var f = items[i].getAsFile();
      if (!f) continue;
      ev.preventDefault();
      insertImageBlob(f);
      return;
    }
  });

  document.getElementById("insertImg").addEventListener("click", function(){
    if (!dlg){ toast("插入图片仅桌面版可用"); return; }
    if (!needSavedDoc()) return;
    dlg.open({ multiple: false, filters: [{ name: "图片",
        extensions: ["png","jpg","jpeg","gif","webp","bmp","svg"] }] })
      .then(function(sel){
        if (!sel) return;
        importImagePath(typeof sel === "string" ? sel : sel.path);
      })
      .catch(function(e){ toast(String(e)); });
  });

  /* ---------- 文档间跳转 ----------
     `[说明](01-系统总览.md)` 这种相对链接点开同目录的文档，开成新标签。
     core 在每次 update 里给这类链接打了 .doclink，这里用事件委托接管点击——
     预览的 innerHTML 每次都重建，监听只能挂在 preview 上。 */
  preview.addEventListener("click", function(ev){
    var a = ev.target && ev.target.closest ? ev.target.closest("a.doclink") : null;
    if (!a) return;
    ev.preventDefault();
    if (!isApp){ toast("打开文档仅桌面版可用"); return; }
    if (!docState.path){ toast("请先保存当前文档——相对链接要靠它定位"); return; }
    var href = (a.getAttribute("href") || "").split(/[#?]/)[0];
    /* marked 会把路径当 URL 做百分号编码，中文文件名会变成 %E7%B3%BB... 这种，
       直接拿去找文件必然落空。这里解回真实文件名再交给 Rust。 */
    try { href = decodeURIComponent(href); } catch(e){}
    if (!href) return;
    invoke("resolve_doc", { docPath: docState.path, href: href })
      .then(openPath, function(err){ toast(String(err)); });
  });

  /* 关窗前把所有脏标签一起写盘。未命名标签的 saved 是 null，永远算不上脏
     （它们走 localStorage 草稿），所以这里每个 t 都一定有 path。 */
  function saveAllDirty(list){
    return list.reduce(function(chain, t){
      return chain.then(function(){
        return invoke("write_doc", {
          path: t.path, text: t.text, encoding: t.encoding, eol: t.eol
        });
      });
    }, Promise.resolve());
  }

  if (isApp){
    btnOpen.addEventListener("click", doOpen);
    btnSave.addEventListener("click", doSave);
    btnSaveAs.addEventListener("click", doSaveAs);
    btnPdf.addEventListener("click", doExportPdf);

    window.addEventListener("keydown", function(ev){
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var k = ev.key.toLowerCase();
      if (k === "o"){ ev.preventDefault(); doOpen(); }
      else if (k === "s"){ ev.preventDefault(); ev.shiftKey ? doSaveAs() : doSave(); }
    });

    /* 拖文件到窗口直接打开 */
    if (appWin && appWin.onDragDropEvent){
      appWin.onDragDropEvent(function(ev){
        var pl = ev && ev.payload;
        if (pl && pl.type === "drop" && pl.paths && pl.paths.length){
          /* 图片插到当前文档里，文档各开一个标签；一次拖进来一堆也照单全收 */
          pl.paths.forEach(function(p){
            if (IMG_EXT.test(p)) importImagePath(p);
            else openPath(p);
          });
        }
      }).catch(function(){});
    }

    /* 关窗前拦一道，避免改了半天直接丢掉 */
    if (appWin && appWin.onCloseRequested){
      appWin.onCloseRequested(function(ev){
        var dirty = CD.dirtyTabs();
        if (!dirty.length) return;
        ev.preventDefault();
        CD.saveSession();        /* 下次启动要照原样把这些标签恢复回来 */
        var msg = dirty.length === 1
          ? "「" + baseName(dirty[0].path) + "」有未保存的修改。要先保存吗？"
          : "有 " + dirty.length + " 个标签未保存：" +
            dirty.map(function(t){ return baseName(t.path); }).join("、") +
            "。要全部保存吗？";
        dlg.ask(msg, {
          title: "关闭前确认", kind: "warning", okLabel: "保存并关闭", cancelLabel: "直接关闭"
        }).then(function(save){
          var done = save ? saveAllDirty(dirty) : Promise.resolve();
          return Promise.resolve(done).then(function(){ appWin.destroy(); });
        }).catch(function(){});
      }).catch(function(){});
    }

    /* 程序已经在跑时又双击了一个 .md：Rust 侧的 single-instance 拦下第二个进程，
       把路径发成 open-file 事件转过来，这里开成新标签。 */
    if (TAURI && TAURI.event && TAURI.event.listen){
      TAURI.event.listen("open-file", function(ev){
        if (ev && ev.payload) openPath(String(ev.payload));
      }).catch(function(){});
    }

    /* 双击 .md 启动时资源管理器传来的路径，已在脚本最开头就发起请求
       （见 bootReq），此处不再重复取——take_startup_file 取走即清空，
       晚取一轮就等于白等一趟 IPC 加一次多余渲染。 */
  } else {
    [btnOpen, btnSave, btnSaveAs, btnPdf].forEach(function(b){
      b.disabled = true;
      b.style.opacity = ".4";
      b.style.cursor = "not-allowed";
      b.title = "文件读写仅在桌面版可用";
    });
    refreshFileUI();
  }

  /* ---------- 回填 core ---------- */
  CD.refreshFileUI = refreshFileUI;
  CD.afterLoad = afterLoad;
  CD.saveActive = doSave;        /* 标签层关一个脏标签时要先存 */
})();
