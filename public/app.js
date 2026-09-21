/* 访谈稿匿名化映射编辑器 —— 前端逻辑
 *
 * 核心规则（优先级从高到低）：
 * 1. 显式框选优先：用户框选的片段占据其字符区间，称呼命中与保留原文例外与之重叠时让位；
 * 2. 保留原文例外：按原稿字符区间记录，区间内原文照录，并屏蔽与之重叠的所有自动称呼命中；
 *    显式框选仍可切开、覆盖例外；
 * 3. 最长称呼优先：称呼命中之间发生重叠时，更长的称呼优先，长度相同则先出现者优先；
 * 4. 原稿永不改动：匿名结果只体现在预览中，同时维护双向字符区间映射。
 *
 * 标记例外、恢复匿名、添加/删除/合并人物、框选均进入同一个撤销栈；
 * 合并人物为原子操作：一次入栈，撤销时按原 ID、列表位置、称呼与全部关联区间精确恢复。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  var state = {
    text: '',          // 原稿（加载后只读）
    persons: [],       // { id, codename, aliases:[], color }
    selections: [],    // { id, start, end, personId } 显式框选
    exceptions: [],    // { id, start, end, personId } 保留原文例外
    history: [],       // 撤销栈：person / selection / exception / restore / removePerson / mergePerson
    currentPreview: '',
    currentMap: []     // { id, kind, oStart, oEnd, pStart, pEnd, personId, explicit, exId }
  };
  var personSeq = 1;
  var selSeq = 1;
  var excSeq = 1;

  var PALETTE = ['#ffe08a', '#b5e0a8', '#a8d8ff', '#ffc6c6', '#e3c6ff', '#ffd9a8', '#a8e6e0', '#f5c6e0'];

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var inputSection = $('inputSection'), editorSection = $('editorSection');
  var textInput = $('textInput');
  var originalView = $('originalView'), previewView = $('previewView');
  var personForm = $('personForm'), codenameInput = $('codenameInput'), aliasesInput = $('aliasesInput');
  var personList = $('personList'), exceptionList = $('exceptionList'), statsEl = $('stats');
  var mappingBody = document.querySelector('#mappingTable tbody');
  var selPopup = $('selPopup'), popupPerson = $('popupPerson'), popupNewFields = $('popupNewFields');
  var popupCodename = $('popupCodename'), popupAlias = $('popupAlias');
  var mergeDialog = $('mergeDialog'), mergeTargetEl = $('mergeTarget'), mergeSource = $('mergeSource');
  var mergeCodenames = $('mergeCodenames'), mergeAliases = $('mergeAliases'), mergeCounts = $('mergeCounts');
  var toastEl = $('toast');

  // ---------- 工具 ----------
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2200);
  }

  function parseAliases(raw) {
    return raw.split(/[,，、;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function personById(id) {
    for (var i = 0; i < state.persons.length; i++) {
      if (state.persons[i].id === id) return state.persons[i];
    }
    return null;
  }

  function exceptionById(id) {
    for (var i = 0; i < state.exceptions.length; i++) {
      if (state.exceptions[i].id === id) return state.exceptions[i];
    }
    return null;
  }

  // ---------- 匿名化引擎（public/anonymize.js，纯函数） ----------
  function anonymize() {
    return Anonymizer.anonymize(state.text, state.persons, state.selections, state.exceptions);
  }

  // ---------- 渲染 ----------
  function renderView(container, text, intervals) {
    container.innerHTML = '';
    var cursor = 0;
    intervals.forEach(function (iv) {
      if (iv.start > cursor) {
        container.appendChild(document.createTextNode(text.slice(cursor, iv.start)));
      }
      var span = document.createElement('span');
      span.className = 'frag' + (iv.kind === 'keep' ? ' keep' : (iv.explicit ? ' explicit' : ''));
      span.dataset.mid = iv.id;
      span.textContent = text.slice(iv.start, iv.end);
      span.style.background = iv.color;
      container.appendChild(span);
      cursor = iv.end;
    });
    if (cursor < text.length) {
      container.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  function render() {
    var result = anonymize();
    state.currentPreview = result.preview;
    state.currentMap = result.map;

    // 当前仍在预览中生效的例外（未被显式框选完全覆盖）
    var activeExIds = {};
    result.map.forEach(function (m) { if (m.kind === 'keep') activeExIds[m.exId] = true; });

    // 原稿侧区间
    var oIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.oStart, end: m.oEnd, kind: m.kind, explicit: m.explicit, color: p ? p.color : '' };
    });
    // 预览侧区间（同一 id，实现双向对应）
    var pIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.pStart, end: m.pEnd, kind: m.kind, explicit: m.explicit, color: p ? p.color : '' };
    });

    renderView(originalView, state.text, oIntervals);
    renderView(previewView, result.preview, pIntervals);
    renderPersons();
    renderExceptions(activeExIds);
    renderMapping(result.map);
    renderStats(result.map);

    $('btnUndo').disabled = state.history.length === 0;
    $('btnCopy').disabled = !state.text;
  }

  function renderPersons() {
    personList.innerHTML = '';
    state.persons.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'person-item';

      var head = document.createElement('div');
      head.className = 'person-head';
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      var name = document.createElement('span');
      name.className = 'codename';
      name.textContent = p.codename;
      var merge = document.createElement('button');
      merge.className = 'merge';
      merge.title = '把另一人物合并进「' + p.codename + '」（可撤销）';
      merge.textContent = '合并';
      merge.addEventListener('click', function () { openMergeDialog(p.id); });
      var del = document.createElement('button');
      del.className = 'del';
      del.title = '删除该人物及其规则（可撤销）';
      del.textContent = '×';
      del.addEventListener('click', function () { removePerson(p.id); });
      head.appendChild(dot); head.appendChild(name); head.appendChild(merge); head.appendChild(del);
      li.appendChild(head);

      var tags = document.createElement('div');
      tags.className = 'alias-tags';
      if (p.aliases.length) {
        p.aliases.forEach(function (a) {
          var t = document.createElement('span');
          t.className = 'alias-tag';
          t.textContent = a;
          tags.appendChild(t);
        });
      } else {
        var em = document.createElement('span');
        em.className = 'alias-empty';
        em.textContent = '（未登记称呼，仅框选生效）';
        tags.appendChild(em);
      }
      li.appendChild(tags);
      personList.appendChild(li);
    });
  }

  function renderExceptions(activeExIds) {
    exceptionList.innerHTML = '';
    if (!state.exceptions.length) {
      var empty = document.createElement('li');
      empty.className = 'exception-empty';
      empty.textContent = '（暂无例外，去映射表标记称呼命中吧）';
      exceptionList.appendChild(empty);
      return;
    }
    // 按原稿位置排序展示
    state.exceptions.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (x) {
      var p = personById(x.personId);
      var li = document.createElement('li');
      li.className = 'exception-item' + (activeExIds[x.id] ? '' : ' exception-covered');

      var row = document.createElement('div');
      row.className = 'exception-row';
      var frag = document.createElement('span');
      frag.className = 'exception-frag';
      frag.title = '点击定位原稿位置';
      frag.textContent = state.text.slice(x.start, x.end);
      frag.addEventListener('click', function () { locateException(x.id); });

      var restore = document.createElement('button');
      restore.className = 'exception-restore';
      restore.title = '删除该例外、恢复匿名（可撤销）';
      restore.textContent = '恢复匿名';
      restore.addEventListener('click', function () { restoreException(x.id); });
      row.appendChild(frag);
      row.appendChild(restore);
      li.appendChild(row);

      var meta = document.createElement('div');
      meta.className = 'exception-meta';
      var metaText = '来源人物：' + (p ? p.codename : '（已删除）') +
        ' ｜ 区间 [' + x.start + ', ' + x.end + ')';
      if (!activeExIds[x.id]) metaText += ' ｜ 已被显式框选完全覆盖';
      meta.textContent = metaText;
      li.appendChild(meta);

      exceptionList.appendChild(li);
    });
  }

  function renderMapping(map) {
    mappingBody.innerHTML = '';
    map.forEach(function (m, i) {
      var p = personById(m.personId);
      var tr = document.createElement('tr');
      tr.dataset.mid = m.id;
      if (m.kind === 'keep') tr.classList.add('row-keep');
      var cells = [
        String(i + 1),
        p ? p.codename : '（已删除）',
        null, // 来源
        '[' + m.oStart + ', ' + m.oEnd + ')',
        state.text.slice(m.oStart, m.oEnd),
        '[' + m.pStart + ', ' + m.pEnd + ')',
        state.currentPreview.slice(m.pStart, m.pEnd),
        null  // 操作
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        if (ci === 2) {
          if (m.kind === 'keep') {
            td.textContent = '保留原文例外';
            td.className = 'src-keep';
          } else {
            td.textContent = m.explicit ? '显式框选' : '称呼命中';
            td.className = m.explicit ? 'src-explicit' : 'src-alias';
          }
        } else if (ci === 7) {
          // 操作列：自动称呼命中可标为例外；例外片段可恢复匿名
          var btn = document.createElement('button');
          btn.className = 'btn btn-mini';
          if (m.kind === 'keep') {
            btn.textContent = '恢复匿名';
            btn.addEventListener('click', function () { restoreException(m.exId); });
          } else if (!m.explicit) {
            btn.textContent = '保留原文';
            btn.title = '将此处称呼命中标为「保留原文」例外';
            btn.addEventListener('click', function () { markException(m); });
          } else {
            btn.textContent = '—';
            btn.disabled = true;
            btn.title = '显式框选不能标为例外';
          }
          td.appendChild(btn);
        } else {
          td.textContent = c;
        }
        tr.appendChild(td);
      });
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return; // 点操作按钮不触发行定位
        activate(m.id, true);
      });
      mappingBody.appendChild(tr);
    });
  }

  function renderStats(map) {
    var explicit = map.filter(function (m) { return m.explicit; }).length;
    var keeps = map.filter(function (m) { return m.kind === 'keep'; }).length;
    var aliases = map.length - explicit - keeps;
    var covered = state.exceptions.length -
      state.exceptions.filter(function (x) {
        return map.some(function (m) { return m.kind === 'keep' && m.exId === x.id; });
      }).length;
    var stats = '人物 ' + state.persons.length + ' 位 ｜ 共处理 ' + map.length +
      ' 处（框选 ' + explicit + ' · 称呼 ' + aliases + ' · 保留原文 ' + keeps + '）';
    if (state.exceptions.length) {
      stats += ' ｜ 例外 ' + state.exceptions.length + ' 条';
      if (covered) stats += '（其中 ' + covered + ' 条被框选完全覆盖）';
    }
    statsEl.textContent = stats;
  }

  // ---------- 双向高亮 ----------
  function clearActive() {
    document.querySelectorAll('.frag.active').forEach(function (el) { el.classList.remove('active'); });
  }

  function activate(mid, scroll) {
    clearActive();
    var targets = document.querySelectorAll('.frag[data-mid="' + mid + '"]');
    targets.forEach(function (el) { el.classList.add('active'); });
    if (scroll && targets.length) {
      targets.forEach(function (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  // 在两个视图中定位覆盖某原稿位置的片段
  function locateOffsets(start, end) {
    var hit = state.currentMap.find(function (m) {
      return m.oStart <= start && m.oEnd >= end;
    }) || state.currentMap.find(function (m) {
      return start < m.oEnd && end > m.oStart;
    });
    if (hit) activate(hit.id, true);
  }

  function locateException(exId) {
    var x = exceptionById(exId);
    if (!x) return;
    var m = state.currentMap.find(function (mm) { return mm.kind === 'keep' && mm.exId === exId; });
    if (m) { activate(m.id, true); return; }
    // 被框选完全覆盖时，定位覆盖它的框选片段
    locateOffsets(x.start, x.end);
  }

  [originalView, previewView].forEach(function (view) {
    view.addEventListener('click', function (e) {
      var frag = e.target.closest('.frag');
      if (!frag) { clearActive(); return; }
      activate(frag.dataset.mid, true);
    });
    // 悬停时联动另一侧
    view.addEventListener('mouseover', function (e) {
      var frag = e.target.closest('.frag');
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
      if (!frag) return;
      document.querySelectorAll('.frag[data-mid="' + frag.dataset.mid + '"]').forEach(function (el) {
        if (el !== frag) el.classList.add('match');
      });
    });
    view.addEventListener('mouseleave', function () {
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
    });
  });

  // ---------- 规则操作 ----------
  function addPerson(codename, aliases, recordHistory) {
    var person = {
      id: personSeq++,
      codename: codename,
      aliases: aliases,
      color: PALETTE[(personSeq - 2) % PALETTE.length]
    };
    state.persons.push(person);
    if (recordHistory !== false) state.history.push({ type: 'person', person: person });
    render();
    return person;
  }

  function addSelection(personId, start, end) {
    var clash = state.selections.some(function (s) { return start < s.end && end > s.start; });
    if (clash) { toast('所选区间与已有框选重叠'); return false; }
    var sel = { id: selSeq++, start: start, end: end, personId: personId };
    state.selections.push(sel);
    state.history.push({ type: 'selection', selection: sel });
    render();
    return true;
  }

  function removePerson(id) {
    var person = personById(id);
    if (!person) return;
    var removedSels = state.selections.filter(function (s) { return s.personId === id; });
    var removedExs = state.exceptions.filter(function (x) { return x.personId === id; });
    state.persons = state.persons.filter(function (p) { return p.id !== id; });
    state.selections = state.selections.filter(function (s) { return s.personId !== id; });
    state.exceptions = state.exceptions.filter(function (x) { return x.personId !== id; });
    // 人物删除进入撤销栈（连同其框选与例外一起恢复）
    state.history.push({
      type: 'removePerson',
      person: person,
      selections: removedSels,
      exceptions: removedExs
    });
    render();
    toast('已删除人物「' + person.codename + '」，可撤销');
  }

  // ---------- 合并人物 ----------
  // 目标人物保留；源人物的称呼（去重后）、框选与例外统一改绑到目标人物，源人物删除。
  // 重叠称呼仍由引擎按「最长称呼优先」处理，无需额外规则。
  var mergeTargetId = null; // 弹窗当前的目标人物 id

  function dedupAliases(target, source) {
    var merged = target.aliases.slice();
    source.aliases.forEach(function (a) {
      if (merged.indexOf(a) === -1) merged.push(a);
    });
    return merged;
  }

  function openMergeDialog(targetId) {
    var target = personById(targetId);
    if (!target) return;
    if (state.persons.length < 2) { toast('至少需要两位人物才能合并'); return; }
    mergeTargetId = targetId;
    mergeTargetEl.textContent = target.codename;
    // 源人物下拉：除目标外的所有人物
    mergeSource.innerHTML = '';
    state.persons.forEach(function (p) {
      if (p.id === targetId) return;
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.codename;
      mergeSource.appendChild(o);
    });
    updateMergePreview();
    mergeDialog.classList.remove('hidden');
  }

  function closeMergeDialog() {
    mergeDialog.classList.add('hidden');
    mergeTargetId = null;
  }

  // 弹窗预览：双方代号、去重后的称呼、将迁移的框选与例外数量（随源人物选择实时刷新）
  function updateMergePreview() {
    var target = personById(mergeTargetId);
    var source = personById(Number(mergeSource.value));
    if (!target || !source) return;
    mergeCodenames.textContent = '「' + target.codename + '」（目标，保留）＋「' +
      source.codename + '」（源，合并后删除）';

    var merged = dedupAliases(target, source);
    mergeAliases.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'merge-label';
    label.textContent = '合并后称呼（已去重）：';
    mergeAliases.appendChild(label);
    if (merged.length) {
      merged.forEach(function (a) {
        var t = document.createElement('span');
        t.className = 'alias-tag';
        t.textContent = a;
        mergeAliases.appendChild(t);
      });
    } else {
      var em = document.createElement('span');
      em.className = 'alias-empty';
      em.textContent = '（双方均未登记称呼，仅框选生效）';
      mergeAliases.appendChild(em);
    }

    var selCount = state.selections.filter(function (s) { return s.personId === source.id; }).length;
    var exCount = state.exceptions.filter(function (x) { return x.personId === source.id; }).length;
    mergeCounts.textContent = '将迁移到目标人物：框选 ' + selCount + ' 处 ｜ 保留原文例外 ' + exCount + ' 条';
  }

  function mergePerson(targetId, sourceId) {
    var target = personById(targetId);
    var source = personById(sourceId);
    if (!target || !source || target === source) return;
    var sourceIndex = state.persons.indexOf(source);
    var targetAliasesBefore = target.aliases.slice();
    // 保留对象引用：撤销时按引用把 personId 改回源人物
    var movedSels = state.selections.filter(function (s) { return s.personId === sourceId; });
    var movedExs = state.exceptions.filter(function (x) { return x.personId === sourceId; });

    target.aliases = dedupAliases(target, source);
    movedSels.forEach(function (s) { s.personId = targetId; });
    movedExs.forEach(function (x) { x.personId = targetId; });
    state.persons = state.persons.filter(function (p) { return p.id !== sourceId; });

    // 整次合并作为一条原子记录进入撤销栈
    state.history.push({
      type: 'mergePerson',
      targetId: targetId,
      targetAliasesBefore: targetAliasesBefore,
      source: source,
      sourceIndex: sourceIndex,
      selections: movedSels,
      exceptions: movedExs
    });
    render();
    toast('已将「' + source.codename + '」合并进「' + target.codename + '」，可撤销');
  }

  // ---------- 保留原文例外 ----------
  function markException(mapItem) {
    if (mapItem.kind !== 'replace' || mapItem.explicit) return;
    var start = mapItem.oStart, end = mapItem.oEnd, personId = mapItem.personId;
    var clash = state.exceptions.some(function (x) {
      return start < x.end && end > x.start && x.personId === personId;
    });
    if (clash) { toast('该片段已被同人物的其他例外覆盖'); return; }
    var ex = { id: excSeq++, start: start, end: end, personId: personId };
    state.exceptions.push(ex);
    state.history.push({ type: 'exception', exception: ex });
    render();
    toast('已标记保留原文：' + state.text.slice(start, end));
  }

  function restoreException(id) {
    var ex = exceptionById(id);
    if (!ex) return;
    state.exceptions = state.exceptions.filter(function (x) { return x.id !== id; });
    // 恢复匿名同样进入撤销栈（可再撤销以重新保留）
    state.history.push({ type: 'restore', exception: ex });
    render();
    toast('已恢复匿名：' + state.text.slice(ex.start, ex.end));
  }

  function undo() {
    var action = state.history.pop();
    if (!action) return;
    switch (action.type) {
      case 'person':
        state.persons = state.persons.filter(function (p) { return p.id !== action.person.id; });
        state.selections = state.selections.filter(function (s) { return s.personId !== action.person.id; });
        state.exceptions = state.exceptions.filter(function (x) { return x.personId !== action.person.id; });
        toast('已撤销人物「' + action.person.codename + '」');
        break;
      case 'selection':
        state.selections = state.selections.filter(function (s) { return s.id !== action.selection.id; });
        toast('已撤销一次框选');
        break;
      case 'exception':
        state.exceptions = state.exceptions.filter(function (x) { return x.id !== action.exception.id; });
        toast('已撤销保留原文标记');
        break;
      case 'restore':
        if (personById(action.exception.personId)) state.exceptions.push(action.exception);
        toast('已撤销恢复匿名');
        break;
      case 'removePerson':
        state.persons.push(action.person);
        state.selections = state.selections.concat(action.selections);
        state.exceptions = state.exceptions.concat(action.exceptions);
        toast('已恢复人物「' + action.person.codename + '」及其规则');
        break;
      case 'mergePerson':
        // 精确恢复：目标称呼还原、关联区间改回源人物、源人物按原 ID 与原列表位置放回
        var mTarget = personById(action.targetId);
        if (mTarget) mTarget.aliases = action.targetAliasesBefore.slice();
        action.selections.forEach(function (s) { s.personId = action.source.id; });
        action.exceptions.forEach(function (x) { x.personId = action.source.id; });
        state.persons.splice(Math.min(action.sourceIndex, state.persons.length), 0, action.source);
        toast('已撤销合并，恢复人物「' + action.source.codename + '」');
        break;
    }
    render();
  }

  // ---------- 框选 ----------
  var pendingSel = null; // { start, end }

  function selectionOffsets() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!originalView.contains(range.startContainer) || !originalView.contains(range.endContainer)) return null;
    var pre = document.createRange();
    pre.selectNodeContents(originalView);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length;
    var end = start + range.toString().length;
    if (end <= start) return null;
    return { start: start, end: end, rect: range.getBoundingClientRect() };
  }

  function openPopup(info) {
    pendingSel = info;
    // 填充人物下拉
    popupPerson.innerHTML = '';
    var optNew = document.createElement('option');
    optNew.value = '__new';
    optNew.textContent = '＋ 新建人物…';
    popupPerson.appendChild(optNew);
    state.persons.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.codename;
      popupPerson.appendChild(o);
    });
    popupNewFields.classList.remove('hidden');
    popupCodename.value = '';
    popupAlias.value = state.text.slice(info.start, info.end);

    var x = Math.min(info.rect.left, window.innerWidth - 270);
    var y = info.rect.bottom + 8;
    if (y + 200 > window.innerHeight) y = info.rect.top - 210;
    selPopup.style.left = Math.max(8, x) + 'px';
    selPopup.style.top = Math.max(8, y) + 'px';
    selPopup.classList.remove('hidden');
  }

  function closePopup() {
    selPopup.classList.add('hidden');
    pendingSel = null;
  }

  originalView.addEventListener('mouseup', function () {
    setTimeout(function () {
      var info = selectionOffsets();
      if (info) openPopup(info);
    }, 10);
  });

  popupPerson.addEventListener('change', function () {
    popupNewFields.classList.toggle('hidden', popupPerson.value !== '__new');
  });

  $('popupOk').addEventListener('click', function () {
    if (!pendingSel) return;
    var personId;
    if (popupPerson.value === '__new') {
      var codename = popupCodename.value.trim();
      if (!codename) { toast('请填写统一代号'); return; }
      var aliases = parseAliases(popupAlias.value);
      var person = addPerson(codename, aliases); // 人物规则入历史
      personId = person.id;
    } else {
      personId = Number(popupPerson.value);
    }
    if (addSelection(personId, pendingSel.start, pendingSel.end)) {
      window.getSelection().removeAllRanges();
      closePopup();
    }
  });

  $('popupCancel').addEventListener('click', function () {
    window.getSelection().removeAllRanges();
    closePopup();
  });

  document.addEventListener('mousedown', function (e) {
    if (!selPopup.classList.contains('hidden') && !selPopup.contains(e.target) && e.target !== originalView) {
      // 点击弹窗以外区域时关闭（在原稿上重新框选会由 mouseup 重新打开）
      if (!originalView.contains(e.target)) closePopup();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePopup(); closeMergeDialog(); }
  });

  // ---------- 合并人物弹窗 ----------
  mergeSource.addEventListener('change', updateMergePreview);

  $('mergeConfirm').addEventListener('click', function () {
    var sourceId = Number(mergeSource.value);
    var targetId = mergeTargetId;
    if (!personById(targetId) || !personById(sourceId)) { closeMergeDialog(); return; }
    closeMergeDialog();
    mergePerson(targetId, sourceId);
  });

  $('mergeCancel').addEventListener('click', closeMergeDialog);

  mergeDialog.addEventListener('mousedown', function (e) {
    if (e.target === mergeDialog) closeMergeDialog(); // 点击遮罩关闭
  });

  // ---------- 顶部操作 ----------
  $('btnLoadText').addEventListener('click', function () {
    var text = textInput.value;
    if (!text.trim()) { toast('请先粘贴访谈原稿'); return; }
    loadText(text);
  });

  function loadText(text) {
    state.text = text;
    state.persons = [];
    state.selections = [];
    state.exceptions = [];
    state.history = [];
    closeMergeDialog();
    inputSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
    $('btnResetText').classList.remove('hidden');
    render();
  }

  $('btnResetText').addEventListener('click', function () {
    if ((state.persons.length || state.selections.length || state.exceptions.length) &&
        !window.confirm('重新粘贴将清空当前所有人物规则、框选与例外，确定继续？')) return;
    textInput.value = state.text;
    editorSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
    $('btnResetText').classList.add('hidden');
    closeMergeDialog();
    state.text = '';
    state.persons = [];
    state.selections = [];
    state.exceptions = [];
    state.history = [];
  });

  $('btnExample').addEventListener('click', function () {
    fetch('/api/example')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loadText(data.text);
        data.persons.forEach(function (p) { addPerson(p.codename, p.aliases, false); });
        state.history = []; // 示例预置规则不计入可撤销历史
        render();
        toast('已加载内置示例');
      })
      .catch(function () { toast('示例加载失败'); });
  });

  $('btnUndo').addEventListener('click', undo);

  $('btnCopy').addEventListener('click', function () {
    var done = function () { toast('匿名预览已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.currentPreview).then(done, function () { toast('复制失败'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = state.currentPreview;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  });

  // ---------- 人物表单 ----------
  personForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var codename = codenameInput.value.trim();
    if (!codename) { toast('请填写统一代号'); return; }
    var aliases = parseAliases(aliasesInput.value);
    addPerson(codename, aliases);
    codenameInput.value = '';
    aliasesInput.value = '';
    toast('已添加人物「' + codename + '」');
  });
})();
