/* ============================================================
   tabs.js —— 标签页：多文档共存于一个窗口
   core.js 先于本文件加载，共享符号挂在 window.CD 上。
   依赖 core：src, paneView, docState, dot, savedAt, toast, update, baseName,
             isApp, invoke, dlg, holdScroll, SAMPLE
   回填 core：openDoc, newTab, closeActive, cycleTab, gotoTab, tabDraftKey,
             dirtyTabs, restoreSession, saveSession, refreshTabs, hasTabs

   —— 设计取舍（改动前务必读）——
   活动标签的「真状态」始终在 src.value 和 docState 里，Tab 对象只在它不活动时
   持有快照。切换 = snapshot(旧) + apply(新)，不做双向同步，避免两份状态打架。

   apply() 里对 src.value 是**直接赋值**，这是全项目唯一允许这么干的地方：
   赋值会清掉浏览器原生撤销栈，所以切走再切回来，那个标签的 Ctrl+Z 历史归零。
   这是「单 textarea」方案已知且接受的代价（另一条路是每标签一个 textarea，
   撤销栈天然各自保留，但要改掉 CD.src 的别名契约）。别顺手把别处的 insertText
   也改成赋值——那条规矩依然成立，见 CLAUDE.md「预览即编辑」。
   ============================================================ */

(function(){
  "use strict";
  var CD = window.CD;
  var src = CD.src, paneView = CD.paneView, docState = CD.docState, dot = CD.dot,
      savedAt = CD.savedAt, toast = CD.toast, update = CD.update, baseName = CD.baseName,
      isApp = CD.isApp, invoke = CD.invoke, dlg = CD.dlg, holdScroll = CD.holdScroll,
      SAMPLE = CD.SAMPLE;

  var DRAFT   = "clay-draft-doc";        /* 未命名草稿的 localStorage 键前缀（首个标签沿用旧键） */
  var SESSION = "clay-draft-session";

  var tabsEl = document.getElementById("tabs");
  var tabbar = document.getElementById("tabbar");

  var tabs = [], active = -1, seq = 0;

  /* ---------- Tab 模型 ----------
     loaded=false 表示「会话恢复出来的壳」：只有路径，正文等到第一次切过去才读盘。
     开五六个标签时启动只读一个文件。 */
  function mkTab(o){
    var id = "t" + (++seq);
    return {
      id: id,
      path: o.path || null,
      encoding: o.encoding || "utf-8",
      eol: o.eol || "lf",
      text: o.text != null ? o.text : "",
      saved: o.saved != null ? o.saved : null,
      loaded: o.loaded !== false,
      draftKey: o.draftKey || null,
      sel: [0, 0], edTop: 0, viewTop: 0,
      node: null, nameEl: null
    };
  }

  function cur(){ return active >= 0 ? tabs[active] : null; }
  function indexOf(t){ return tabs.indexOf(t); }

  function isDirty(t){
    if (!t || !t.loaded) return false;
    if (t === cur()) return docState.saved !== null && src.value !== docState.saved;
    return t.saved !== null && t.text !== t.saved;
  }

  /* 空白标签：未命名、没动过。开文件时优先顶掉它，免得留一个空壳 */
  function isPristine(t){
    if (!t || !t.loaded || t.path || isDirty(t)) return false;
    var text = (t === cur()) ? src.value : t.text;
    return !text.trim() || text === SAMPLE;
  }

  /* 把实时状态落回快照。**只能传当前活动标签**——它读的是 src / docState，
     传别的标签会把活动文档的内容写进那个标签里。 */
  function snapshot(t){
    if (!t || !t.loaded || t !== cur()) return;
    t.text = src.value;
    t.path = docState.path; t.encoding = docState.encoding;
    t.eol = docState.eol;   t.saved = docState.saved;
    t.sel = [src.selectionStart, src.selectionEnd];
    t.edTop = src.scrollTop;
    t.viewTop = paneView.scrollTop;

    /* core 的存草稿是 500ms 防抖的，赶在它之前切走的话，那一拍的内容会被写到
       新标签的键上——等于旧标签最后几下输入丢了。离开前先自己刷一次。 */
    if (!t.path && t.draftKey){
      try { localStorage.setItem(t.draftKey, t.text); } catch(e){}
    }
    /* 存成文件之后草稿就没用了，留着只会在 localStorage 里积灰 */
    if (t.path && t.draftKey){
      try { localStorage.removeItem(t.draftKey); } catch(e){}
      t.draftKey = null;
    }
  }

  function apply(t){
    if (CD.endInline) CD.endInline(false);      /* 预览里还开着编辑框就先收掉 */
    src.readOnly = false;                       /* 解掉读盘期间的锁 */
    /* 唯一允许直接赋值 value 的地方，代价见文件头 */
    src.value = t.text;
    /* docState 被 file/images/word 三个模块按别名持有，只能就地改，不能整体换对象 */
    docState.path = t.path; docState.encoding = t.encoding;
    docState.eol = t.eol;   docState.saved = t.saved;

    if (CD.resetToc) CD.resetToc();
    update();                                   /* 同步渲染，随后恢复滚动位置才有意义 */

    if (holdScroll) holdScroll();               /* 压住同步滚动，否则两边互相拽 */
    try { src.setSelectionRange(t.sel[0], t.sel[1]); } catch(e){}
    src.scrollTop = t.edTop;
    paneView.scrollTop = t.viewTop;

    dot.classList.toggle("on", !isDirty(t));
    savedAt.textContent = t.path ? (isDirty(t) ? "有未保存的修改" : "已打开") : "编辑中...";
    if (CD.refreshFileUI) CD.refreshFileUI();
    refreshTabs();
  }

  /* ---------- 标签条 ---------- */
  function renderBar(){
    tabsEl.textContent = "";
    tabs.forEach(function(t){
      var el = document.createElement("div");
      el.className = "tab";
      el.setAttribute("role", "tab");
      var name = document.createElement("span");
      name.className = "tab-name";
      var x = document.createElement("button");
      x.className = "tab-x";
      x.type = "button";
      x.title = "关闭  Ctrl+W";
      x.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">'
        + '<path d="M3 3 L9 9 M9 3 L3 9" fill="none" stroke="currentColor"'
        + ' stroke-width="1.5" stroke-linecap="round"/></svg>';
      el.appendChild(name); el.appendChild(x);

      el.addEventListener("mousedown", function(ev){
        if (ev.button === 1){ ev.preventDefault(); closeTab(indexOf(t)); }   /* 中键关闭 */
        else if (ev.button === 0 && ev.target !== x && !x.contains(ev.target)) switchTo(indexOf(t));
      });
      x.addEventListener("click", function(ev){ ev.stopPropagation(); closeTab(indexOf(t)); });

      t.node = el; t.nameEl = name;
      tabsEl.appendChild(el);
    });
    refreshTabs();
  }

  /* 只刷文字与状态类，不重建 DOM——每次按键都会走到这里 */
  function refreshTabs(){
    tabs.forEach(function(t, i){
      if (!t.node) return;
      var label = t.path ? baseName(t.path) : "未命名";
      if (t.nameEl.textContent !== label) t.nameEl.textContent = label;
      t.node.title = t.path || "尚未保存到文件";
      t.node.classList.toggle("active", i === active);
      t.node.classList.toggle("dirty", isDirty(t));
      t.node.classList.toggle("pending", !t.loaded);
      t.node.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    tabbar.classList.toggle("single", tabs.length < 2);
    saveSessionSoon();
  }

  /* ---------- 切换 ---------- */
  function switchTo(i){
    if (i < 0 || i >= tabs.length) return;
    var t = tabs[i];
    if (i === active && t.loaded) return;
    var prev = cur();
    if (prev && prev !== t) snapshot(prev);

    if (!t.loaded){
      /* 会话恢复出来的壳：先把标签点亮，读盘回来再上屏。
         这几十毫秒里编辑区显示的还是上一个文档的正文，不锁住的话在这期间敲的字
         会被随后的 apply() 直接冲掉，且没有任何提示。 */
      active = i; src.readOnly = true; refreshTabs();
      if (!invoke){ t.loaded = true; apply(t); return; }
      invoke("read_doc", { path: t.path }).then(function(doc){
        t.text = doc.text; t.saved = doc.text; t.path = doc.path;
        t.encoding = doc.encoding; t.eol = doc.eol; t.loaded = true;
        if (cur() === t) apply(t); else refreshTabs();
      }, function(err){
        toast(baseName(t.path) + " 打不开：" + err);
        drop(indexOf(t));
      });
      return;
    }
    active = i;
    apply(t);
  }

  function cycleTab(step){
    if (tabs.length < 2) return;
    switchTo((active + step + tabs.length) % tabs.length);
  }

  function gotoTab(n){ if (n >= 0 && n < tabs.length) switchTo(n); }

  /* ---------- 新建 / 关闭 ---------- */
  function newTab(doc){
    var prev = cur();
    if (prev) snapshot(prev);
    var t = mkTab(doc || {});
    if (!t.path && !t.draftKey) t.draftKey = DRAFT + ":" + t.id;
    tabs.push(t);
    active = tabs.length - 1;
    renderBar();
    apply(t);
    return t;
  }

  /* 真正从列表里摘掉，不问脏不脏 */
  function drop(i){
    if (i < 0 || i >= tabs.length) return;
    var t = tabs[i];
    if (t.draftKey){ try { localStorage.removeItem(t.draftKey); } catch(e){} }
    tabs.splice(i, 1);
    if (!tabs.length){                       /* 关到一个不剩就补一个空白页 */
      active = -1;
      newTab({});
      return;
    }
    if (active > i) active--;
    else if (active === i) active = Math.min(i, tabs.length - 1);
    var next = tabs[active];
    renderBar();
    if (next.loaded) apply(next);
    else { active = -1; switchTo(tabs.indexOf(next)); }
  }

  function closeTab(i){
    var t = tabs[i];
    if (!t) return;
    if (!isDirty(t) || !dlg || !dlg.ask){ drop(i); return; }
    /* 系统对话框只有两个按钮，与关窗确认保持同一套措辞 */
    dlg.ask("「" + baseName(t.path) + "」有未保存的修改。要先保存吗？", {
      title: "关闭标签", kind: "warning", okLabel: "保存并关闭", cancelLabel: "直接关闭"
    }).then(function(save){
      if (!save){ drop(indexOf(t)); return; }
      if (indexOf(t) !== active) switchTo(indexOf(t));
      var done = CD.saveActive ? CD.saveActive() : null;
      Promise.resolve(done).then(function(){ drop(indexOf(t)); });
    }).catch(function(){ drop(indexOf(t)); });
  }

  function closeActive(){ closeTab(active); }

  /* ---------- 对外：打开一份文档 ----------
     已经开着就切过去；当前是空白页就顶掉它；否则另开一个。 */
  function openDoc(doc){
    var i = -1;
    if (doc.path){
      for (var k = 0; k < tabs.length; k++){
        if (tabs[k].path === doc.path){ i = k; break; }
      }
    }
    if (i >= 0){
      var hit = tabs[i];
      if (isDirty(hit)){ switchTo(i); toast("这个文件已经开着，且有未保存的修改"); return hit; }
      hit.text = doc.text; hit.saved = doc.text;
      hit.encoding = doc.encoding; hit.eol = doc.eol; hit.loaded = true;
      hit.sel = [0, 0]; hit.edTop = 0; hit.viewTop = 0;
      if (i === active) apply(hit); else switchTo(i);
      return hit;
    }
    var c = cur();
    if (c && isPristine(c)){
      if (c.draftKey){ try { localStorage.removeItem(c.draftKey); } catch(e){} c.draftKey = null; }
      c.text = doc.text; c.saved = doc.text; c.path = doc.path;
      c.encoding = doc.encoding; c.eol = doc.eol; c.loaded = true;
      c.sel = [0, 0]; c.edTop = 0; c.viewTop = 0;
      apply(c);
      return c;
    }
    return newTab({
      path: doc.path, text: doc.text, saved: doc.text,
      encoding: doc.encoding, eol: doc.eol, loaded: true
    });
  }

  /* 未命名标签各存各的草稿。首个标签沿用旧键，老草稿不会丢 */
  function tabDraftKey(){
    var t = cur();
    return (t && t.draftKey) || DRAFT;
  }

  /* 给关窗确认用。先把活动标签的实时内容落回快照，否则它的 text 是陈旧的 */
  function dirtyTabs(){
    var c = cur();
    var list = tabs.filter(isDirty);
    if (c) snapshot(c);
    return list;
  }

  function hasTabs(){ return tabs.length; }

  /* ---------- 会话 ----------
     只记路径和草稿键，正文不进 localStorage（未命名草稿本来就在那儿）。 */
  var sessTimer;
  function saveSessionSoon(){
    clearTimeout(sessTimer);
    sessTimer = setTimeout(saveSession, 800);
  }

  function saveSession(){
    if (!isApp) return;
    var c = cur();
    if (c) snapshot(c);
    var list = [];
    tabs.forEach(function(t){
      if (t.path) list.push({ path: t.path });
      else if (t.draftKey) list.push({ draft: t.draftKey });
    });
    try {
      localStorage.setItem(SESSION, JSON.stringify({
        v: 1, active: Math.max(0, active), tabs: list
      }));
    } catch(e){}
  }

  function restoreSession(){
    if (!isApp) return false;
    var s = null;
    try { s = JSON.parse(localStorage.getItem(SESSION) || "null"); } catch(e){}
    if (!s || !s.tabs || !s.tabs.length) return false;

    var list = [];
    s.tabs.forEach(function(e){
      if (e.path){ list.push(mkTab({ path: e.path, loaded: false })); return; }
      if (!e.draft) return;
      var txt = null;
      try { txt = localStorage.getItem(e.draft); } catch(x){}
      if (txt !== null && txt.trim()) list.push(mkTab({ text: txt, draftKey: e.draft }));
    });
    if (!list.length) return false;

    tabs.length = 0;                              /* 就地清空，别整体换数组 */
    list.forEach(function(t){ tabs.push(t); });
    active = -1;
    renderBar();
    switchTo(Math.min(Math.max(0, s.active | 0), tabs.length - 1));
    return true;
  }

  /* ---------- 初始化 ----------
     core 已经把开局内容放进 src 了（浏览器模式是示例稿或本机草稿，桌面模式是空的，
     等 bootReq 回来再走 openDoc / restoreSession），这里把它认领成第一个标签。 */
  tabs.push(mkTab({
    text: src.value, path: docState.path,
    encoding: docState.encoding, eol: docState.eol, saved: docState.saved,
    draftKey: DRAFT                                /* 首个标签用旧键，兼容已有草稿 */
  }));
  active = 0;
  renderBar();

  document.getElementById("tabNew").addEventListener("click", function(){ newTab({}); });

  window.addEventListener("keydown", function(ev){
    if (!(ev.ctrlKey || ev.metaKey)) return;
    var k = ev.key.toLowerCase();
    if (k === "t"){ ev.preventDefault(); newTab({}); }
    else if (k === "w"){ ev.preventDefault(); closeActive(); }
    else if (ev.key === "Tab"){ ev.preventDefault(); cycleTab(ev.shiftKey ? -1 : 1); }
    else if (ev.key === "PageDown"){ ev.preventDefault(); cycleTab(1); }
    else if (ev.key === "PageUp"){ ev.preventDefault(); cycleTab(-1); }
    else if (/^[1-9]$/.test(ev.key)){ ev.preventDefault(); gotoTab(+ev.key - 1); }
  });

  /* ---------- 回填 core ---------- */
  CD.openDoc        = openDoc;
  CD.newTab         = newTab;
  CD.closeActive    = closeActive;
  CD.cycleTab       = cycleTab;
  CD.gotoTab        = gotoTab;
  CD.tabDraftKey    = tabDraftKey;
  CD.dirtyTabs      = dirtyTabs;
  CD.restoreSession = restoreSession;
  CD.saveSession    = saveSession;
  CD.refreshTabs    = refreshTabs;
  CD.hasTabs        = hasTabs;
})();
