/* 匿名化引擎（纯函数，浏览器与 Node 共用）
 *
 * 规则（优先级从高到低）：
 * 1. 显式框选优先：框选片段占据其字符区间，称呼命中、保留原文例外与之重叠时均让位；
 * 2. 保留原文例外：按原稿字符区间记录，区间内（扣除被显式框选覆盖的部分）原文照录，
 *    并屏蔽与之重叠的所有自动称呼命中；
 * 3. 最长称呼优先：称呼命中之间重叠时，更长者优先，长度相同则位置靠前者优先；
 * 4. 原稿不被改动：仅生成预览文本与双向字符区间映射。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Anonymizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function validRange(text, s, e) {
    return Number.isInteger(s) && Number.isInteger(e) && e > s && s >= 0 && e <= text.length;
  }

  /**
   * 从 [s,e) 中扣除所有与之重叠的显式框选区间，返回剩余的零到多个子区间。
   * 即：显式框选可以切开并覆盖保留原文例外。
   */
  function subtractClaimed(parts, claimed) {
    claimed.forEach(function (c) {
      var next = [];
      parts.forEach(function (part) {
        if (c[0] >= part[1] || c[1] <= part[0]) {
          next.push(part); // 不相交
          return;
        }
        if (c[0] > part[0]) next.push([part[0], Math.min(c[0], part[1])]);
        if (c[1] < part[1]) next.push([Math.max(c[1], part[0]), part[1]]);
      });
      parts = next;
    });
    return parts;
  }

  /**
   * @param {string} text 原稿
   * @param {Array} persons [{ id, codename, aliases: [] }]
   * @param {Array} selections [{ start, end, personId }] 显式框选（最高优先级）
   * @param {Array} exceptions [{ id, start, end, personId }] 保留原文例外（来源人物）
   * @returns {{ preview: string, map: Array }} 预览文本与双向区间映射
   *   map 项: { id, kind:'replace'|'keep', oStart, oEnd, pStart, pEnd,
   *             personId, explicit, exId }
   */
  function anonymize(text, persons, selections, exceptions) {
    selections = selections || [];
    exceptions = exceptions || [];
    var byId = {};
    persons.forEach(function (p) { byId[p.id] = p; });

    var claimed = []; // 已被占用的字符区间 [[s,e),...]
    var reps = [];    // 最终替换项
    var keeps = [];   // 最终保留原文项

    // 1) 显式框选优先占位（可覆盖例外）
    selections.forEach(function (s) {
      if (!byId[s.personId]) return;
      if (!validRange(text, s.start, s.end)) return;
      reps.push({ start: s.start, end: s.end, personId: s.personId, explicit: true });
      claimed.push([s.start, s.end]);
    });

    // 2) 保留原文例外：扣除被显式框选覆盖的部分，剩余部分占位并屏蔽称呼命中
    exceptions.forEach(function (x) {
      if (!byId[x.personId]) return;
      if (!validRange(text, x.start, x.end)) return;
      var parts = subtractClaimed([[x.start, x.end]], claimed);
      parts.forEach(function (part) {
        keeps.push({ start: part[0], end: part[1], personId: x.personId, exId: x.id });
        claimed.push(part);
      });
    });

    // 3) 收集所有称呼命中
    var hits = [];
    persons.forEach(function (p) {
      p.aliases.forEach(function (alias) {
        if (!alias) return;
        var i = text.indexOf(alias);
        while (i !== -1) {
          hits.push({ start: i, end: i + alias.length, personId: p.id });
          i = text.indexOf(alias, i + 1);
        }
      });
    });

    // 最长称呼优先；长度相同则位置靠前者优先
    hits.sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    });

    function overlaps(s, e) {
      return claimed.some(function (c) { return s < c[1] && e > c[0]; });
    }
    hits.forEach(function (h) {
      if (overlaps(h.start, h.end)) return; // 与框选/例外/更长称呼重叠，让位
      h.explicit = false;
      reps.push(h);
      claimed.push([h.start, h.end]);
    });

    // 4) 按原稿顺序生成预览与双向映射（替换项与保留项统一编号，便于双向高亮）
    var items = reps.concat(keeps).sort(function (a, b) { return a.start - b.start; });
    var preview = '';
    var map = [];
    var cursor = 0;
    items.forEach(function (r, idx) {
      var person = byId[r.personId];
      if (!person) return;
      preview += text.slice(cursor, r.start);
      var pStart = preview.length;
      var isKeep = !!r.exId;
      if (isKeep) {
        preview += text.slice(r.start, r.end); // 保留原文：预览照录
      } else {
        preview += '【' + person.codename + '】';
      }
      map.push({
        id: idx,
        kind: isKeep ? 'keep' : 'replace',
        oStart: r.start, oEnd: r.end,
        pStart: pStart, pEnd: preview.length,
        personId: r.personId,
        explicit: !isKeep && !!r.explicit,
        exId: isKeep ? r.exId : null
      });
      cursor = r.end;
    });
    preview += text.slice(cursor);
    return { preview: preview, map: map };
  }

  return { anonymize: anonymize };
});
