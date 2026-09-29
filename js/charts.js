/* 차트 (SVG 문자열을 만든다). 색은 css 변수 --s1 ~ --s7 (항목 순서대로 고정), 그 밖은 회색. */
(function (root) {
  'use strict';

  const SLOTS = 7;

  function seriesColor(colorIndex) {
    return colorIndex >= 0 && colorIndex < SLOTS ? `var(--s${colorIndex + 1})` : 'var(--gray-mark)';
  }

  // 12,340,000 → "1,234만", 1억 이상은 "1.2억"
  function shortWon(n) {
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '')}억`;
    if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ko-KR')}만`;
    return `${sign}${Math.round(a).toLocaleString('ko-KR')}`;
  }

  // 달력처럼 좁은 칸용: 6,200 → "6.2천", 12,400 → "1.2만", 512,000 → "51만"
  function tinyWon(n) {
    const a = Math.abs(n);
    const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
    if (a >= 1e8) return `${trim(a / 1e8)}억`;
    if (a >= 1e5) return `${Math.round(a / 1e4)}만`;
    if (a >= 1e4) return `${trim(a / 1e4)}만`;
    if (a >= 1e3) return `${trim(a / 1e3)}천`;
    return String(Math.round(a));
  }

  function niceMax(v) {
    if (v <= 0) return 10000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // 구성 막대: rows = [{name, amount, colorIndex}] (많이 쓴 순). 8번째 색부터는 "기타"로 합친다.
  function shareSegments(rows) {
    const main = rows.filter((r) => r.colorIndex >= 0 && r.colorIndex < SLOTS);
    const rest = rows.filter((r) => !(r.colorIndex >= 0 && r.colorIndex < SLOTS));
    const segs = main.map((r) => ({ name: r.name, amount: r.amount, color: seriesColor(r.colorIndex) }));
    const restSum = rest.reduce((s, r) => s + r.amount, 0);
    if (restSum > 0) segs.push({ name: rest.length === 1 ? rest[0].name : '기타', amount: restSum, color: seriesColor(-1) });
    return segs;
  }

  function shareBar(rows) {
    const segs = shareSegments(rows);
    const total = segs.reduce((s, r) => s + r.amount, 0) || 1;
    return `<div class="share-bar" role="img" aria-label="항목별 지출 구성">${segs
      .map((s, i) => `<span data-seg="${i}" style="flex:${s.amount / total};background:${s.color}"></span>`)
      .join('')}</div>`;
  }

  /*
   * 기간별 추이: 기간마다 [수입, 지출] 두 막대. data = [{label, income, spent}]
   * 막대 사이 2px 간격, 윗부분 4px 둥글게, 바닥은 기준선에 붙임.
   */
  function trendChart(data, { width = 640, height = 220 } = {}) {
    const pad = { top: 12, right: 8, bottom: 26, left: 44 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(1, ...data.map((d) => Math.max(d.income || 0, d.spent || 0))));
    const y = (v) => pad.top + h - (Math.max(0, v) / max) * h;
    const band = w / data.length;
    const barW = Math.min(26, (band - 18) / 2);
    const gap = 2;
    const parts = [];

    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const yy = y(v);
      parts.push(`<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text class="axis-label" x="${pad.left - 6}" y="${yy + 4}" text-anchor="end">${shortWon(v)}</text>`);
    }

    const bar = (x, v, color) => {
      if (!v || v <= 0) return '';
      const top = y(v);
      const bh = pad.top + h - top;
      const r = Math.min(4, bh);
      // 위쪽 모서리만 둥근 막대
      return `<path fill="${color}" d="M${x},${pad.top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.top + h} Z"/>`;
    };

    data.forEach((d, i) => {
      const cx = pad.left + band * i + band / 2;
      parts.push(bar(cx - barW - gap / 2, d.income, 'var(--s1)'));
      parts.push(bar(cx + gap / 2, d.spent, 'var(--s2)'));
      parts.push(`<text class="axis-label" x="${cx}" y="${height - 8}" text-anchor="middle">${d.label}</text>`);
      parts.push(`<rect class="hit" data-i="${i}" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${h}"/>`);
    });

    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="기간별 수입과 지출">${parts.join('')}</svg>`;
  }

  root.BudgetCharts = { seriesColor, shortWon, tinyWon, shareSegments, shareBar, trendChart };
})(typeof globalThis !== 'undefined' ? globalThis : this);
