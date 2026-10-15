// 자동 생성 파일 (npm run build). 직접 고치지 말고 js/logic.js, server/server.js 를 고치세요.
// 구글 Apps Script 의 Code.gs 에 이 파일 전체를 붙여넣으면 됩니다.
/** @OnlyCurrentDoc */ // 이 코드가 붙은 시트 하나만 읽고 쓰도록 권한을 좁힌다 (내 다른 시트에는 접근 권한 없음)
/*
 * 지출 관리 앱의 순수 로직 (DOM 없음).
 * 브라우저에서는 window.BudgetLogic 으로, Node(테스트)에서는 require 로 사용한다.
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다룬다 (시간대 문제 회피).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 날짜 ----------

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function toISO(y, m, d) {
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function addMonths(y, m, delta) {
    const idx = y * 12 + (m - 1) + delta;
    return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
  }

  function addDays(iso, delta) {
    const { y, m, d } = parseISO(iso);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function diffDays(a, b) {
    const pa = parseISO(a);
    const pb = parseISO(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
  }

  function todayISO(now = new Date()) {
    return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  // 시작일이 해당 월에 없으면(예: 31일) 그 달의 말일로 맞춘다.
  function periodStartInMonth(y, m, startDay) {
    return toISO(y, m, Math.min(startDay, daysInMonth(y, m)));
  }

  function getPeriod(dateISO, startDay) {
    const { y, m } = parseISO(dateISO);
    let start = periodStartInMonth(y, m, startDay);
    let sy = y;
    let sm = m;
    if (dateISO < start) {
      ({ y: sy, m: sm } = addMonths(y, m, -1));
      start = periodStartInMonth(sy, sm, startDay);
    }
    const next = addMonths(sy, sm, 1);
    const nextStart = periodStartInMonth(next.y, next.m, startDay);
    return { start, end: addDays(nextStart, -1), key: start };
  }

  function shiftPeriod(period, delta, startDay) {
    const { y, m } = parseISO(period.start);
    const t = addMonths(y, m, delta);
    return getPeriod(periodStartInMonth(t.y, t.m, startDay), startDay);
  }

  // ---------- 예산 계산 ----------

  /*
   * categories: [{ id, name, type: 'ratio' | 'fixed', value }]
   *   ratio → value 는 퍼센트, fixed → value 는 원 단위 금액
   * ratioBase: 'income'     → 비율 항목은 전체 수입 기준
   *            'afterFixed' → 비율 항목은 (수입 - 고정 항목 합계) 기준
   * fixedOverflow: 고정 항목 합계가 수입보다 클 때
   *            'warn'  → 정한 금액 그대로 두고 화면에서 알린다 (기본)
   *            'scale' → 고정 항목끼리의 비율을 유지한 채 합계가 수입과 같아지도록 줄인다
   * 수입이 0(아직 입력 안 함)이면 줄이지 않는다.
   */
  function computeBudgets(categories, income, ratioBase, fixedOverflow) {
    const inc = Math.max(0, Number(income) || 0);
    const fixedCats = categories.filter((c) => c.type === 'fixed');
    const fixedTotal = fixedCats.reduce((s, c) => s + Math.round(Number(c.value) || 0), 0);
    const ratioPercentTotal = categories
      .filter((c) => c.type === 'ratio')
      .reduce((s, c) => s + (Number(c.value) || 0), 0);
    const fixedOver = inc > 0 ? Math.max(0, fixedTotal - inc) : 0;
    const fixedScaled = fixedOverflow === 'scale' && fixedOver > 0;

    const budgets = {};
    for (const c of fixedCats) budgets[c.id] = Math.round(Number(c.value) || 0);
    if (fixedScaled) {
      // 비례해서 내림한 뒤, 남은 몇 원은 소수점 아래가 큰 항목부터 1원씩 더해 합계를 수입과 정확히 맞춘다
      const parts = fixedCats.map((c) => {
        const exact = (budgets[c.id] * inc) / fixedTotal;
        return { id: c.id, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
      });
      let left = inc - parts.reduce((s, x) => s + x.floor, 0);
      parts.sort((a, b) => b.frac - a.frac);
      for (const x of parts) {
        budgets[x.id] = x.floor + (left > 0 ? 1 : 0);
        if (left > 0) left -= 1;
      }
    }
    const fixedBudgetTotal = fixedCats.reduce((s, c) => s + budgets[c.id], 0);
    const base = ratioBase === 'afterFixed' ? Math.max(0, inc - fixedBudgetTotal) : inc;

    for (const c of categories) {
      if (c.type !== 'fixed') budgets[c.id] = Math.round((base * (Number(c.value) || 0)) / 100);
    }
    const allocated = Object.values(budgets).reduce((s, v) => s + v, 0);
    return {
      budgets,
      fixedTotal,
      fixedBudgetTotal,
      fixedOver,
      fixedScaled,
      fixedScale: fixedScaled ? inc / fixedTotal : 1,
      ratioPercentTotal,
      ratioBaseAmount: base,
      allocated,
      unallocated: inc - allocated,
    };
  }

  // 거래 종류: expense(지출, 기본) / income(입금) / transfer(내 계좌끼리 이체 — 지출·수입에서 제외)
  function kindOf(t) {
    return t.kind === 'income' || t.kind === 'transfer' ? t.kind : 'expense';
  }

  function txsInPeriod(state, period) {
    return state.transactions.filter((t) => t.date >= period.start && t.date <= period.end);
  }

  function summarizePeriod(state, period) {
    const plan = planFor(state, period.key);
    const income = state.incomes[period.key];
    const hasIncome = typeof income === 'number';
    const calc = computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase, plan.fixedOverflow);
    const all = txsInPeriod(state, period);
    const txs = all.filter((t) => kindOf(t) === 'expense');
    const known = new Set(plan.categories.map((c) => c.id));

    const spent = {};
    const counts = {};
    for (const c of plan.categories) {
      spent[c.id] = 0;
      counts[c.id] = 0;
    }
    let unclassified = 0;
    let unclassifiedCount = 0;
    for (const t of txs) {
      if (t.categoryId && known.has(t.categoryId)) {
        spent[t.categoryId] += t.amount;
        counts[t.categoryId] += 1;
      } else {
        unclassified += t.amount;
        unclassifiedCount += 1;
      }
    }
    const totalSpent = txs.reduce((s, t) => s + t.amount, 0);
    const incomeReceived = all.filter((t) => kindOf(t) === 'income').reduce((s, t) => s + t.amount, 0);

    const rows = plan.categories.map((c) => {
      const budget = calc.budgets[c.id];
      const used = spent[c.id];
      return {
        category: c,
        budget,
        spent: used,
        count: counts[c.id],
        remaining: budget - used,
        ratio: budget > 0 ? used / budget : used > 0 ? Infinity : 0,
      };
    });

    // 계획이 바뀐 뒤에 아직 다시 분류되지 않은 (직접 고르지 않은) 지출
    const staleCount = txs.filter(
      (t) => t.method !== 'manual' && (!t.classifiedAt || (plan.updatedAt && t.classifiedAt < plan.updatedAt))
    ).length;

    return {
      period,
      plan,
      staleCount,
      income: hasIncome ? income : null,
      hasIncome,
      ...calc,
      rows,
      unclassified,
      unclassifiedCount,
      totalSpent,
      incomeReceived,
      remaining: (hasIncome ? income : 0) - totalSpent,
      transactions: txs,
      allTransactions: all,
    };
  }

  function statusOf(ratio) {
    if (ratio > 1) return 'critical';
    if (ratio >= 0.8) return 'warning';
    return 'good';
  }

  // ---------- 자동 분류 ----------

  function normalizeMerchant(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '');
  }

  // 1) 직접 분류해 둔 가맹점(학습) → 2) 가장 긴 키워드가 일치하는 항목
  function classify(memo, categories, merchantMap = {}) {
    const norm = normalizeMerchant(memo);
    if (!norm) return null;
    const known = new Set(categories.map((c) => c.id));
    const learned = merchantMap[norm];
    if (learned && known.has(learned)) return learned;

    let best = null;
    let bestLen = 0;
    for (const c of categories) {
      for (const kw of c.keywords || []) {
        const k = normalizeMerchant(kw);
        if (k && k.length > bestLen && norm.includes(k)) {
          best = c.id;
          bestLen = k.length;
        }
      }
    }
    return best;
  }

  // AI 없이 분류: { categoryId, method: 'learned' | 'keyword' | null }
  function classifyLocal(memo, categories, merchantMap = {}) {
    const known = new Set(categories.map((c) => c.id));
    const learned = merchantMap[normalizeMerchant(memo)];
    if (learned && known.has(learned)) return { categoryId: learned, method: 'learned' };
    const id = classify(memo, categories, {});
    return id ? { categoryId: id, method: 'keyword' } : { categoryId: null, method: null };
  }

  // ---------- 지출 내역 텍스트 인식 ----------

  const NOISE_PATTERNS = [
    /\[?web\s*발신\]?/gi,
    /\[[^\]]*\]/g,
    /(누적|잔액|잔고|한도)\s*:?\s*-?[\d,]+\s*원?/g,
    /\(?\s*(일시불|할부\s*\d*\s*개?월?|\d+\s*개월)\s*\)?/g,
    /\(\s*[\d*]{3,4}\s*\)/g, // 카드 끝자리 (1234)
    /\*\d{3,4}/g,
    /\S\*\S/g, // 마스킹된 이름 홍*동
    /\d{1,2}:\d{2}(:\d{2})?/g, // 시각
    /(체크|신용)?\s*승인(취소)?/g,
    /결제(완료)?|사용(완료)?|출금/g,
    /(^|\s)\S{1,6}카드(?=\s|$)/g, // 신한카드, KB국민카드 ...
  ];

  function inferYear(month, day, refISO) {
    const ref = parseISO(refISO);
    let year = ref.y;
    // 기준일보다 한참 미래라면 작년 내역으로 본다 (예: 1월에 12월 내역 붙여넣기)
    if (diffDays(refISO, toISO(year, month, Math.min(day, daysInMonth(year, month)))) > 7) year -= 1;
    return year;
  }

  function validDate(y, m, d) {
    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }

  function extractDate(line, refISO) {
    let m = line.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (validDate(y, mo, d)) return { date: toISO(y, mo, d), rest: line.replace(m[0], ' ') };
    }
    // 앞에 숫자·쉼표가 없는 09/28 같은 날짜. (오래된 iOS 사파리가 정규식 lookbehind 를 못 읽어서
    // 앞 글자를 그룹으로 잡고 되돌려 놓는다)
    let keep = '';
    m = line.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (!m) {
      const mm = line.match(/(^|[^\d,])(\d{1,2})[/.\-](\d{1,2})(?![\d,])/);
      if (mm) {
        keep = mm[1];
        m = [mm[0], mm[2], mm[3]];
      }
    }
    if (m) {
      const [mo, d] = [Number(m[1]), Number(m[2])];
      const y = inferYear(mo, d, refISO);
      if (validDate(y, mo, d)) return { date: toISO(y, mo, d), rest: line.replace(m[0], `${keep} `) };
    }
    return { date: null, rest: line };
  }

  function extractAmount(line) {
    // [정규식, 금액 그룹, 되돌려 놓을 앞 글자 그룹]
    const patterns = [
      [/(-?\d[\d,]*)\s*원/, 1, 0], // 12,000원
      [/(-?\d{1,3}(?:,\d{3})+)(?!\d)/, 1, 0], // 12,000
      [/(^|\D)(-?\d{3,})(?!\d)/, 2, 1], // 12000
    ];
    for (const [p, g, k] of patterns) {
      const m = line.match(p);
      if (m) {
        const n = Number(m[g].replace(/,/g, ''));
        if (Number.isFinite(n) && n !== 0) return { amount: n, rest: line.replace(m[0], `${k ? m[k] : ''} `) };
      }
    }
    return { amount: null, rest: line };
  }

  function cleanMemo(s) {
    let out = s;
    for (const p of NOISE_PATTERNS) out = out.replace(p, ' ');
    return out
      .replace(/[\t,|;]+/g, ' ')
      .replace(/^[\s\-:·/()]+|[\s\-:·/()]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /*
   * 여러 줄의 텍스트(카드 문자, 은행 앱 내역, 엑셀 복사 등)에서 지출을 뽑아낸다.
   * 반환: { items: [{ date, amount, memo, raw }], skipped: [raw...] }
   */
  function parseExpenseText(text, refISO) {
    const items = [];
    const skipped = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const raw = rawLine.trim();
      if (!raw) continue;
      const isCancel = /취소|환불/.test(raw);
      // 누적/잔액 금액이 결제 금액으로 잡히지 않도록 먼저 제거
      let work = raw
        .replace(/(누적|잔액|잔고|한도)\s*:?\s*-?[\d,]+\s*원?/g, ' ')
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
        .replace(/\(\s*[\d*]{3,4}\s*\)|\*\d{3,4}/g, ' ')
        .replace(/\t/g, ' ');
      const d = extractDate(work, refISO);
      work = d.rest;
      const a = extractAmount(work);
      if (a.amount === null) {
        skipped.push(raw);
        continue;
      }
      let amount = Math.abs(a.amount);
      if (isCancel || a.amount < 0) amount = -amount;
      const memo = cleanMemo(a.rest.replace(/취소|환불/g, ' ')) || '(내용 없음)';
      items.push({ date: d.date || refISO, amount, memo, raw });
    }
    return { items, skipped };
  }

  function isDuplicate(item, transactions) {
    return transactions.some(
      (t) => t.date === item.date && t.amount === item.amount && normalizeMerchant(t.memo) === normalizeMerchant(item.memo)
    );
  }

  // ---------- 결제·입출금 알림 (카드 문자, 은행 앱 알림) ----------

  // 거래 알림처럼 보이는 글인지 (인증번호, 광고 등은 제외)
  function looksLikeTransaction(text) {
    const t = String(text || '');
    if (!/[\d,]+\s*원/.test(t)) return false;
    if (/인증\s*번호|인증코드/.test(t)) return false;
    return /승인|결제|사용|취소|출금|입금|이체|송금|보냈|받았/.test(t);
  }

  function digitsOnly(s) {
    return String(s || '').replace(/\D/g, '');
  }

  // 알림에 적힌 계좌·카드 번호(가려진 번호 포함)의 끝자리로 등록된 계좌/카드를 찾는다
  function matchAccount(text, accounts) {
    const chunks = String(text || '').match(/[\d*][\d*\-]{2,}/g) || [];
    for (const a of accounts || []) {
      const last4 = digitsOnly(a.last4).slice(-4);
      if (last4.length < 3) continue;
      for (const c of chunks) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(c)) continue; // 날짜
        if (digitsOnly(c).endsWith(last4)) return a;
      }
    }
    return null;
  }

  function accountByLast4(last4, accounts) {
    const d = digitsOnly(last4).slice(-4);
    if (d.length < 3) return null;
    return (accounts || []).find((a) => digitsOnly(a.last4).slice(-4) === d) || null;
  }

  // AI 없이 알림을 읽을 때 거래 종류 추측
  function detectKind(text, myName) {
    const t = String(text || '');
    if (/승인|결제/.test(t)) return 'expense';
    if (myName && t.includes(myName) && /이체|출금|송금|보냈|입금|받았/.test(t)) return 'transfer';
    if (/입금|받았/.test(t) && !/출금/.test(t)) return 'income';
    return 'expense';
  }

  // AI 를 쓸 수 없을 때의 알림 인식. 여러 줄 알림을 한 줄로 합쳐서 읽는다.
  // 반환: { date, amount, memo, kind, accountId, balance } 또는 null
  function parseMessageFallback(text, refISO, opts = {}) {
    if (!looksLikeTransaction(text)) return null;
    const balanceMatch = String(text).match(/잔액\s*:?\s*([\d,]+)\s*원?/);
    const account = matchAccount(text, opts.accounts);
    const oneLine = String(text)
      .replace(/\r?\n/g, ' ')
      .replace(/(?:[\d\-]+\*+|\*+[\d\-]+)[\d*\-]*|\d{3,}-\d{2,}-\d{3,}/g, ' ') // 가려진 번호, 계좌번호
      .replace(/입금|이체|송금|보냈어요|받았어요|님에게|님이/g, ' ');
    const { items } = parseExpenseText(oneLine, refISO);
    const item = items[0];
    if (!item) return null;
    const kind = detectKind(text, opts.myName);
    return {
      date: item.date,
      amount: kind === 'expense' ? item.amount : Math.abs(item.amount),
      memo: item.memo,
      kind,
      accountId: account ? account.id : null,
      balance: balanceMatch ? Number(balanceMatch[1].replace(/,/g, '')) : null,
    };
  }

  // ---------- 기간별 자산관리계획 ----------

  const BASE_PLAN_FROM = '0000-01-01';

  // 해당 기간에 적용되는 계획: 시작일이 그 기간 이전인 계획 중 가장 최근 것
  function planFor(state, periodKey) {
    const plans = state.plans;
    let found = plans[0];
    for (const p of plans) if (p.from <= periodKey) found = p;
    return found;
  }

  // 미분류 = 지출인데 항목이 없거나, 그 날짜가 속한 기간의 계획에 없는 항목인 것
  function isUnclassified(state, t) {
    if (kindOf(t) !== 'expense') return false;
    const cats = planFor(state, getPeriod(t.date, state.settings.startDay).key).categories;
    return !(t.categoryId && cats.some((c) => c.id === t.categoryId));
  }

  // 기간별 미분류 건수: [{ period, count, total }] 최근 기간부터
  function unclassifiedByPeriod(state) {
    const byKey = new Map();
    for (const t of state.transactions) {
      if (!isUnclassified(state, t)) continue;
      const p = getPeriod(t.date, state.settings.startDay);
      if (!byKey.has(p.key)) byKey.set(p.key, { period: p, count: 0, total: 0 });
      const e = byKey.get(p.key);
      e.count += 1;
      e.total += t.amount;
    }
    return [...byKey.values()].sort((a, b) => (a.period.key < b.period.key ? 1 : -1));
  }

  // 미분류 지출을 가맹점(상대방)별로 묶는다. period 를 주면 그 기간 것만. 최근에 생긴 묶음부터.
  function unclassifiedGroups(state, period) {
    const byKey = new Map();
    for (const t of state.transactions) {
      if (period && (t.date < period.start || t.date > period.end)) continue;
      if (!isUnclassified(state, t)) continue;
      const key = normalizeMerchant(t.memo) || t.memo;
      if (!byKey.has(key)) byKey.set(key, { key, memo: t.memo, items: [], total: 0, latest: '' });
      const g = byKey.get(key);
      g.items.push(t);
      g.total += t.amount;
      if (t.date > g.latest) g.latest = t.date;
    }
    const groups = [...byKey.values()];
    for (const g of groups) g.items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    groups.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : b.total - a.total));
    return groups;
  }

  // 이 기간부터 적용되는 계획을 수정하려고 할 때 호출. 없으면 직전 계획을 복사해서 만든다.
  function ensurePlanFor(state, periodKey, nowISO) {
    const existing = state.plans.find((p) => p.from === periodKey);
    if (existing) return existing;
    const base = planFor(state, periodKey);
    const copy = JSON.parse(JSON.stringify(base));
    copy.from = periodKey;
    copy.updatedAt = nowISO;
    state.plans.push(copy);
    state.plans.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    return copy;
  }

  function nextPlanAfter(state, plan) {
    return state.plans.find((p) => p.from > plan.from) || null;
  }

  // 시작일을 바꾸면 기간 키(시작 날짜)를 같은 달의 새 시작일로 옮긴다.
  function remapPeriodKeys(state, newStartDay) {
    const move = (key) => {
      if (key === BASE_PLAN_FROM) return key;
      const { y, m } = parseISO(key);
      return toISO(y, m, Math.min(newStartDay, daysInMonth(y, m)));
    };
    const incomes = {};
    for (const [k, v] of Object.entries(state.incomes)) incomes[move(k)] = v;
    state.incomes = incomes;
    for (const p of state.plans) p.from = move(p.from);
    state.settings.startDay = newStartDay;
  }

  // ---------- AI 분류 요청 만들기 / 결과 읽기 ----------
  // 실제 API 호출은 서버(Apps Script)에서 한다. 여기서는 프롬프트와 JSON 스키마만 만든다.

  function categoryBrief(categories, merchantMap) {
    const examples = {};
    for (const [merchant, id] of Object.entries(merchantMap || {})) {
      (examples[id] = examples[id] || []).push(merchant);
    }
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description || '',
      keywords: (c.keywords || []).slice(0, 20),
      examples: (examples[c.id] || []).slice(-10),
    }));
  }

  const CLASSIFY_SYSTEM = [
    '당신은 한국어 가계부의 지출 분류기입니다.',
    '사용자가 정해 둔 자산관리계획 항목 목록이 주어지면, 각 지출을 가장 알맞은 항목 id 하나로 분류하세요.',
    '항목의 이름, 설명, 키워드, 사용자가 예전에 직접 분류한 가맹점 예시(examples)를 근거로 판단합니다.',
    '가맹점 이름만으로 업종을 추론해도 됩니다. 어느 항목에도 맞지 않거나 도저히 판단할 수 없으면 "none"을 고르세요.',
  ].join('\n');

  function buildClassifyRequest(categories, items, merchantMap) {
    const ids = categories.map((c) => c.id);
    const user = JSON.stringify({
      categories: categoryBrief(categories, merchantMap),
      expenses: items.map((it, i) => ({ index: i, merchant: it.memo, amount: it.amount, date: it.date })),
    });
    const schema = {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              categoryId: { type: 'string', enum: ids.concat(['none']) },
            },
            required: ['index', 'categoryId'],
            additionalProperties: false,
          },
        },
      },
      required: ['results'],
      additionalProperties: false,
    };
    return { system: CLASSIFY_SYSTEM, user, schema };
  }

  // AI 응답 → items 와 같은 길이의 categoryId 배열 (알 수 없으면 null)
  function readClassifyResponse(json, categories, count) {
    const known = new Set(categories.map((c) => c.id));
    const out = new Array(count).fill(null);
    for (const r of (json && json.results) || []) {
      if (Number.isInteger(r.index) && r.index >= 0 && r.index < count && known.has(r.categoryId)) {
        out[r.index] = r.categoryId;
      }
    }
    return out;
  }

  const MESSAGE_SYSTEM = [
    '당신은 한국 카드사·은행의 결제/입출금 알림(문자 또는 앱 알림)을 읽어 가계부에 기록하는 도우미입니다.',
    '알림에서 거래 종류, 날짜, 금액(원), 가맹점 또는 상대방 이름, 잔액을 뽑고, 지출이면 사용자의 자산관리계획 항목 중 알맞은 항목 id 로 분류하세요.',
    '',
    'kind 규칙:',
    '- expense: 카드 결제, 계좌에서 다른 사람·가게로 보낸 출금/이체, 자동이체, 공과금',
    '- income: 다른 사람이나 회사에서 들어온 입금 (급여, 환급 등)',
    '- own_transfer: 사용자 본인 계좌끼리 옮긴 돈. 상대방 이름이 사용자 이름(my_name)과 같거나, 알림의 상대 계좌가 사용자의 등록 계좌(accounts)이면 해당합니다.',
    '- not_transaction: 인증번호, 광고, 안내 등 거래가 아닌 알림',
    '',
    '- 본인 계좌로 옮긴 돈이 저축 계좌(isSavings)나 적금·청약·증권 계좌로 들어가는 출금이면 to_savings 를 true 로 하고 categoryId 를 저축 성격의 항목으로 고르세요. 그 밖에는 false.',
    '- 누적 금액, 한도, 카드·계좌 번호, 승인번호는 거래 금액이 아닙니다. 잔액이 적혀 있으면 balance 에, 없으면 -1.',
    '- account_last4: 이 알림이 어느 등록 계좌/카드에서 일어난 거래인지 그 끝 4자리. 모르면 빈 문자열.',
    '- 승인취소/환불이면 is_cancel 을 true 로 하세요.',
    '- date 는 YYYY-MM-DD. 연도가 없으면 오늘(today) 기준 가장 가까운 과거 날짜, 날짜가 없으면 today.',
    '- 지출이 아니거나 알맞은 항목이 없으면 categoryId 를 "none" 으로 하세요.',
  ].join('\n');

  function buildMessageRequest(categories, text, todayISO, merchantMap, opts = {}) {
    const ids = categories.map((c) => c.id);
    const user = JSON.stringify({
      today: todayISO,
      my_name: opts.myName || '',
      accounts: (opts.accounts || []).map((a) => ({ name: a.name, type: a.type, last4: digitsOnly(a.last4).slice(-4), isSavings: !!a.isSavings })),
      categories: categoryBrief(categories, merchantMap),
      message: String(text),
    });
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['expense', 'income', 'own_transfer', 'not_transaction'] },
        is_cancel: { type: 'boolean' },
        to_savings: { type: 'boolean' },
        date: { type: 'string' },
        amount: { type: 'integer' },
        merchant: { type: 'string' },
        account_last4: { type: 'string' },
        balance: { type: 'integer' },
        categoryId: { type: 'string', enum: ids.concat(['none']) },
      },
      required: ['kind', 'is_cancel', 'to_savings', 'date', 'amount', 'merchant', 'account_last4', 'balance', 'categoryId'],
      additionalProperties: false,
    };
    return { system: MESSAGE_SYSTEM, user, schema };
  }

  // AI 응답 → { date, amount, memo, kind, categoryId, accountId, balance } 또는 null(거래 아님)
  function readMessageResponse(json, categories, todayISO, accounts) {
    if (!json || !json.kind || json.kind === 'not_transaction') return null;
    const amountAbs = Math.abs(Math.round(Number(json.amount) || 0));
    if (!amountAbs) return null;
    let date = String(json.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayISO;
    const known = new Set(categories.map((c) => c.id));
    const categoryId = known.has(json.categoryId) ? json.categoryId : null;
    const account = accountByLast4(json.account_last4, accounts);

    let kind = 'expense';
    if (json.kind === 'income') kind = 'income';
    else if (json.kind === 'own_transfer' && !json.to_savings) kind = 'transfer';

    return {
      date,
      amount: kind === 'expense' && json.is_cancel ? -amountAbs : amountAbs,
      memo: String(json.merchant || '').trim() || '(내용 없음)',
      kind,
      categoryId: kind === 'expense' ? categoryId : null,
      accountId: account ? account.id : null,
      balance: Number.isInteger(json.balance) && json.balance >= 0 ? json.balance : null,
    };
  }

  // ---------- 은행 거래내역 파일 (엑셀/CSV) ----------
  // 은행마다 항목 이름이 달라서, 머리글(첫 줄)의 이름을 보고 칸을 찾는다.

  const COLUMN_HINTS = [
    ['date', /거래\s*일시|거래\s*일자|거래\s*날짜|^일시$|^날짜$|^일자$|^거래일$/],
    ['time', /^시간$|거래\s*시간|^시각$/],
    ['category', /거래\s*구분|거래\s*유형|거래\s*종류/],
    ['type', /^구분$|입출금\s*구분|입\s*\/\s*출금|^입출금$/],
    ['out', /출금\s*(액|금액)?$|찾으신\s*금액|지급\s*(액|금액)?$/],
    ['in', /입금\s*(액|금액)?$|맡기신\s*금액/],
    ['amount', /거래\s*금액|^금액$/],
    ['balance', /잔액/],
    ['memo', /^내용$|거래\s*내용|적요|받는\s*분|보낸\s*분|거래처|기재\s*내용|상대/],
    ['note', /^메모$/],
  ];

  function cellText(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const cols = {};
      (rows[r] || []).forEach((cell, c) => {
        const name = cellText(cell).replace(/\s+/g, ' ');
        if (!name) return;
        for (const [key, re] of COLUMN_HINTS) {
          if (cols[key] === undefined && re.test(name)) {
            cols[key] = c;
            break;
          }
        }
      });
      if (cols.date !== undefined && (cols.amount !== undefined || cols.out !== undefined || cols.in !== undefined)) return { row: r, cols };
    }
    return null;
  }

  // 엑셀 날짜 일련번호(45928 등) 또는 "2026.09.28 14:02" 같은 글자 → { date, time }
  function parseDateCell(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const ms = Math.round((v - 25569) * 86400000);
      const d = new Date(ms);
      return {
        date: toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
        time: Number.isInteger(v) ? '' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
      };
    }
    const s = cellText(v);
    const m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    const t = s.slice(m.index + m[0].length).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return { date: toISO(y, mo, d), time: t ? `${pad(t[1])}:${t[2]}:${t[3] || '00'}` : '' };
  }

  function parseAmountCell(v) {
    if (typeof v === 'number') return v;
    let s = cellText(v).replace(/[,\s원]/g, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) {
      neg = true;
      s = s.slice(1, -1);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }

  /*
   * 거래내역 표(2차원 배열)를 내역으로 바꾼다.
   * opts: { myName, accountId }
   * 반환: { items: [{date, time, amount, memo, kind, accountId, balance, raw}], skipped, header, latest: {date, time, balance} | null }
   */
  function parseStatementRows(rows, opts = {}) {
    const header = findHeader(rows);
    if (!header) return { items: [], skipped: 0, header: null, latest: null };
    const { cols } = header;
    const get = (row, key) => (cols[key] === undefined ? '' : row[cols[key]]);
    const items = [];
    let skipped = 0;
    let latest = null;
    // 금액 한 칸에 출금은 음수로 적는 파일인지 (그렇다면 양수는 입금)
    const signed = cols.amount !== undefined && rows.slice(header.row + 1).some((row) => (parseAmountCell((row || [])[cols.amount]) || 0) < 0);

    for (let r = header.row + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some((c) => cellText(c))) continue;
      const when = parseDateCell(get(row, 'date'));
      if (!when) {
        skipped += 1;
        continue;
      }
      if (!when.time && cols.time !== undefined) {
        const t = cellText(get(row, 'time')).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (t) when.time = `${pad(t[1])}:${t[2]}:${t[3] || '00'}`;
      }

      const typeText = cellText(get(row, 'type'));
      const categoryText = cellText(get(row, 'category'));
      const out = parseAmountCell(get(row, 'out'));
      const inn = parseAmountCell(get(row, 'in'));
      const amt = parseAmountCell(get(row, 'amount'));

      let kind;
      let amount;
      if (out) {
        kind = 'expense';
        amount = Math.abs(out);
      } else if (inn) {
        kind = 'income';
        amount = Math.abs(inn);
      } else if (amt) {
        amount = Math.abs(amt);
        if (/입금/.test(typeText)) kind = 'income';
        else if (/출금|지급/.test(typeText)) kind = 'expense';
        else if (amt < 0) kind = 'expense';
        else kind = signed ? 'income' : 'expense';
      } else {
        skipped += 1;
        continue;
      }

      const memoMain = cellText(get(row, 'memo'));
      const note = cellText(get(row, 'note'));
      const memo = memoMain || note || categoryText || '(내용 없음)';
      const allText = `${typeText} ${categoryText} ${memo} ${note}`;

      // 카드 결제 취소·환불로 들어온 돈은 지출을 줄이는 것으로 본다
      if (kind === 'income' && /취소|환불/.test(allText)) {
        kind = 'expense';
        amount = -amount;
      }
      if (opts.myName && memo.includes(opts.myName) && !/카드|결제|승인/.test(allText)) kind = 'transfer';

      const balance = parseAmountCell(get(row, 'balance'));
      const item = {
        date: when.date,
        time: when.time,
        amount,
        memo,
        kind,
        accountId: opts.accountId || null,
        balance: Number.isFinite(balance) ? balance : null,
        raw: row.map(cellText).filter(Boolean).join(' | ').slice(0, 300),
      };
      items.push(item);
      if (item.balance !== null) {
        const key = `${item.date} ${item.time}`;
        if (!latest || key >= `${latest.date} ${latest.time}`) latest = { date: item.date, time: item.time, balance: item.balance };
      }
    }
    return { items, skipped, header, latest };
  }

  // CSV 글자 → 2차원 배열 (따옴표 안의 쉼표·줄바꿈 처리)
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const s = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '\t') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  // 알림으로 이미 들어온 내역인지: 정확히 같거나, 같은 날·같은 금액·같은 종류이면서 사용처가 겹치거나 같은 계좌
  function findDuplicate(item, transactions) {
    const memo = normalizeMerchant(item.memo);
    return transactions.find((t) => {
      if (t.date !== item.date || Math.abs(t.amount) !== Math.abs(item.amount)) return false;
      if (kindOf(t) !== kindOf(item)) return false;
      const tm = normalizeMerchant(t.memo);
      if (tm === memo || (tm && memo && (tm.includes(memo) || memo.includes(tm)))) return true;
      return !!(item.accountId && t.accountId === item.accountId);
    }) || null;
  }

  // ---------- 리포트 ----------

  // 항목별 지출 (많이 쓴 순). 색은 계획 안의 순서(colorIndex)로 정해 순위가 바뀌어도 같은 항목은 같은 색.
  function categoryBreakdown(summary) {
    const rows = summary.rows.map((r, i) => ({ id: r.category.id, name: r.category.name, amount: r.spent, count: r.count, colorIndex: i }));
    if (summary.unclassified) rows.push({ id: '__none', name: '미분류', amount: summary.unclassified, count: summary.unclassifiedCount, colorIndex: -1 });
    const total = rows.reduce((s, r) => s + Math.max(0, r.amount), 0);
    return rows
      .filter((r) => r.amount > 0)
      .map((r) => ({ ...r, share: total ? r.amount / total : 0 }))
      .sort((a, b) => b.amount - a.amount);
  }

  // 이번 기간과 직전 기간의 항목별 비교 (이번 기간 계획의 항목 기준, 같은 id 끼리)
  function compareWithPrevious(state, period) {
    const cur = summarizePeriod(state, period);
    const prevPeriod = shiftPeriod(period, -1, state.settings.startDay);
    const prev = summarizePeriod(state, prevPeriod);
    const prevSpent = {};
    for (const r of prev.rows) prevSpent[r.category.id] = r.spent;
    const rows = cur.rows.map((r) => ({
      id: r.category.id,
      name: r.category.name,
      current: r.spent,
      previous: prevSpent[r.category.id] || 0,
      diff: r.spent - (prevSpent[r.category.id] || 0),
    }));
    return { current: cur, previous: prev, rows, totalDiff: cur.totalSpent - prev.totalSpent };
  }

  function topMerchants(txs, n = 5) {
    const map = {};
    for (const t of txs) {
      if (kindOf(t) !== 'expense') continue;
      const key = normalizeMerchant(t.memo);
      const m = (map[key] = map[key] || { memo: t.memo, total: 0, count: 0 });
      m.total += t.amount;
      m.count += 1;
    }
    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, n);
  }

  // 최근 n 개 기간 (오래된 것부터): 예산으로 입력한 수입, 실제 입금, 지출
  function trend(state, period, n = 6) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const p = shiftPeriod(period, -i, state.settings.startDay);
      const s = summarizePeriod(state, p);
      out.push({ period: p, budgetIncome: s.hasIncome ? s.income : null, incomeReceived: s.incomeReceived, spent: s.totalSpent });
    }
    return out;
  }

  // 날짜별 합계: { 'YYYY-MM-DD': { spent, income, count } }
  function dailyTotals(txs) {
    const out = {};
    for (const t of txs) {
      const d = (out[t.date] = out[t.date] || { spent: 0, income: 0, count: 0 });
      const k = kindOf(t);
      if (k === 'expense') d.spent += t.amount;
      else if (k === 'income') d.income += t.amount;
      d.count += 1;
    }
    return out;
  }

  // 자산: 계좌 잔액 합계, 카드별 이번 기간 사용액
  function assetSummary(state, period) {
    const txs = txsInPeriod(state, period);
    const banks = state.accounts.filter((a) => a.type !== 'card');
    const cards = state.accounts.filter((a) => a.type === 'card');
    const total = banks.reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);
    const savings = banks.filter((a) => a.isSavings).reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);
    const spendBy = {};
    for (const t of txs) if (kindOf(t) === 'expense' && t.accountId) spendBy[t.accountId] = (spendBy[t.accountId] || 0) + t.amount;
    return {
      total,
      savings,
      banks: banks.map((a) => ({ ...a, spent: spendBy[a.id] || 0 })),
      cards: cards.map((a) => ({ ...a, spent: spendBy[a.id] || 0 })),
      unlinkedSpent: txs.filter((t) => kindOf(t) === 'expense' && !t.accountId).reduce((s, t) => s + t.amount, 0),
    };
  }

  // ---------- 기본 데이터 ----------

  function defaultCategories() {
    return [
      { id: 'c-house', name: '주거/관리비', type: 'fixed', value: 500000, description: '월세, 관리비, 전기·가스·수도 요금', keywords: ['월세', '관리비', '전기요금', '도시가스', '수도요금'] },
      { id: 'c-phone', name: '통신/구독', type: 'fixed', value: 80000, description: '휴대폰 요금, 인터넷, OTT·음악 등 정기 구독', keywords: ['SKT', 'KT', 'LG U+', '통신', '넷플릭스', '유튜브', '멜론', '쿠팡와우', '디즈니'] },
      { id: 'c-food', name: '식비', type: 'ratio', value: 30, description: '식당, 배달, 장보기, 편의점 음식', keywords: ['식당', '배달의민족', '배민', '요기요', '쿠팡이츠', '이마트', '홈플러스', '롯데마트', '마트', '편의점', 'GS25', 'CU', '세븐일레븐', '김밥', '치킨'] },
      { id: 'c-cafe', name: '카페/간식', type: 'ratio', value: 5, description: '커피, 음료, 빵, 디저트', keywords: ['스타벅스', '투썸', '이디야', '메가커피', '메가MGC', '컴포즈', '빽다방', '카페', '파리바게뜨', '뚜레쥬르', '베이커리'] },
      { id: 'c-move', name: '교통', type: 'ratio', value: 7, description: '대중교통, 택시, 기차, 주유, 주차', keywords: ['택시', '카카오T', '버스', '지하철', '티머니', '코레일', 'SRT', '주유', '주차'] },
      { id: 'c-shop', name: '쇼핑', type: 'ratio', value: 10, description: '온라인 쇼핑, 옷, 생활용품, 화장품', keywords: ['쿠팡', '11번가', 'G마켓', '무신사', '올리브영', '다이소', '네이버페이'] },
      { id: 'c-fun', name: '문화/여가', type: 'ratio', value: 8, description: '영화, 공연, 책, 취미, 여행', keywords: ['CGV', '메가박스', '롯데시네마', '교보문고', 'YES24', '알라딘'] },
      { id: 'c-save', name: '저축/투자', type: 'ratio', value: 40, description: '적금, 저축 이체, 증권 계좌 입금, 청약', keywords: ['적금', '저축', '증권', '청약'] },
    ];
  }

  function defaultState() {
    return {
      version: 2,
      settings: { startDay: 1, myName: '' },
      plans: [{ from: BASE_PLAN_FROM, ratioBase: 'afterFixed', fixedOverflow: 'warn', categories: defaultCategories(), updatedAt: '' }],
      accounts: [],
      incomes: {},
      transactions: [],
      merchantMap: {},
    };
  }

  // 저장된 데이터를 현재 구조로 맞춘다. (v1: 계획이 하나뿐이던 구조 → v2: 기간별 계획)
  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const settings = raw.settings || {};
    const startDay = Math.min(31, Math.max(1, Number(settings.startDay) || 1));

    let plans;
    if (Array.isArray(raw.plans) && raw.plans.length) {
      plans = raw.plans;
    } else if (Array.isArray(raw.categories)) {
      plans = [{ from: BASE_PLAN_FROM, ratioBase: settings.ratioBase === 'income' ? 'income' : 'afterFixed', categories: raw.categories, updatedAt: '' }];
    } else {
      plans = base.plans;
    }
    plans = plans
      .map((p) => ({
        from: String(p.from || BASE_PLAN_FROM),
        ratioBase: p.ratioBase === 'income' ? 'income' : 'afterFixed',
        fixedOverflow: p.fixedOverflow === 'scale' ? 'scale' : 'warn',
        categories: Array.isArray(p.categories) ? p.categories : [],
        updatedAt: String(p.updatedAt || ''),
      }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

    const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
      id: String(a.id),
      name: String(a.name || ''),
      type: a.type === 'card' ? 'card' : 'bank',
      last4: digitsOnly(a.last4).slice(-4),
      isSavings: !!a.isSavings,
      balance: typeof a.balance === 'number' ? a.balance : null,
      balanceAt: String(a.balanceAt || ''),
    }));

    return {
      version: 2,
      settings: { startDay, myName: String(settings.myName || '') },
      plans,
      accounts,
      incomes: raw.incomes && typeof raw.incomes === 'object' ? raw.incomes : {},
      transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
      merchantMap: raw.merchantMap && typeof raw.merchantMap === 'object' ? raw.merchantMap : {},
    };
  }

  return {
    toISO,
    parseISO,
    addDays,
    diffDays,
    todayISO,
    daysInMonth,
    getPeriod,
    shiftPeriod,
    computeBudgets,
    summarizePeriod,
    statusOf,
    normalizeMerchant,
    classify,
    classifyLocal,
    parseExpenseText,
    kindOf,
    looksLikeTransaction,
    matchAccount,
    parseMessageFallback,
    isDuplicate,
    BASE_PLAN_FROM,
    planFor,
    unclassifiedGroups,
    unclassifiedByPeriod,
    ensurePlanFor,
    nextPlanAfter,
    remapPeriodKeys,
    buildClassifyRequest,
    readClassifyResponse,
    buildMessageRequest,
    readMessageResponse,
    parseStatementRows,
    parseCSV,
    findDuplicate,
    categoryBreakdown,
    compareWithPrevious,
    topMerchants,
    trend,
    dailyTotals,
    assetSummary,
    defaultState,
    normalizeState,
  };
});

/*
 * 구글 Apps Script 서버.
 * - 구글 시트에 지출 내역(시트 "지출")과 설정(시트 "설정")을 저장한다.
 * - 휴대폰 자동화 앱(MacroDroid)이 보낸 카드 문자·은행 앱 알림을 받아 Claude 로 읽고 분류해서 기록한다.
 * - 웹앱 화면(Index.html)을 제공하고, 화면의 요청(api)을 처리한다.
 *
 * 빌드 시 js/logic.js 와 화면(INDEX_HTML)이 이 파일과 합쳐져 apps-script/Code.gs 파일 하나가 된다.
 *
 * 스크립트 속성 (직접 넣지 않아도 된다):
 *   APP_KEY            앱 접속/알림 전송용 비밀 키. setup() 을 실행하면 자동으로 만든다.
 *   ANTHROPIC_API_KEY  Claude API 키. 앱의 설정 → 자동 입력 화면에서 넣는다. (없으면 키워드로 분류)
 *   CLAUDE_MODEL       사용할 모델. 앱 설정에서 고른다. 기본값 claude-opus-5-5
 */

var BL = BudgetLogic;
var TX_SHEET = '지출';
var META_SHEET = '설정';
var TX_HEADERS = ['id', 'date', 'amount', 'memo', 'categoryId', 'categoryName', 'method', 'source', 'raw', 'createdAt', 'classifiedAt', 'kind', 'accountId'];
var DEFAULT_MODEL = 'claude-opus-5-5';
var MODELS = ['claude-opus-5-5', 'claude-haiku-5-5'];
var TZ = 'Asia/Seoul';
var AI_BATCH = 40;

// ---------- 처음 설정 ----------

// 편집기에서 한 번 실행 (함수 목록 맨 위에 오도록 파일에서 가장 먼저 둔다): 시트를 만들고, 접속 키가 없으면 새로 만들어 실행 기록에 보여준다.
function setup() {
  txSheet_();
  saveMeta_(loadMeta_(), true);
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('APP_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 24);
    props.setProperty('APP_KEY', key);
  }
  var msg = [
    '준비 완료!',
    '접속 키: ' + key + '   ← 앱을 처음 열 때 이 키를 입력하세요. (다시 보려면 setup 을 또 실행하면 됩니다)',
    'Claude API 키: ' + (props.getProperty('ANTHROPIC_API_KEY') ? '설정됨' : '아직 없음 (앱의 설정 → 자동 입력에서 넣을 수 있어요)'),
    '다음 단계: 오른쪽 위 [배포] → [새 배포] → 웹 앱 (실행: 나, 액세스: 모든 사용자)',
  ].join('\n');
  Logger.log(msg);
  return msg;
}

// ---------- 진입점 ----------

// 화면은 항상 내려주고, 데이터는 접속 키가 맞아야만 준다. 키는 처음 한 번 화면에서 입력하면 그 기기가 기억한다.
function doGet(e) {
  var key = (e && e.parameter && e.parameter.key) || '';
  var html = typeof INDEX_HTML !== 'undefined' ? INDEX_HTML : HtmlService.createHtmlOutputFromFile('Index').getContent();
  var config = { key: checkKey_(key) ? key : '', url: serviceUrl_() };
  html = html.replace('/*__SERVER_CONFIG__*/', 'window.__BUDGET_SERVER__ = ' + JSON.stringify(config) + ';');
  return HtmlService.createHtmlOutput(html)
    .setTitle('내 지출 관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 알림 전송: POST <웹앱 주소>?action=sms&key=<APP_KEY>  (본문 = 문자·알림 내용 그대로, &source=bank 처럼 출처를 붙여도 됨)
// 화면 요청: POST <웹앱 주소>  (본문 = {"key","action","payload"} JSON)
function doPost(e) {
  var params = (e && e.parameter) || {};
  var body = (e && e.postData && e.postData.contents) || '';
  var result;
  try {
    if (params.action === 'sms' || params.action === 'notify') {
      if (!checkKey_(params.key)) throw new Error('unauthorized');
      result = receiveMessage_(body, params.source || 'sms');
    } else {
      result = handleApi_(JSON.parse(body || '{}'));
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Index.html 안에서 google.script.run.api(...) 로 호출
function api(req) {
  try {
    return handleApi_(req);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ---------- 요청 처리 ----------

function handleApi_(req) {
  req = req || {};
  if (!checkKey_(req.key)) throw new Error('unauthorized');
  var p = req.payload || {};
  switch (req.action) {
    case 'ping':
      return aiStatus_({ ok: true });
    case 'load':
      return aiStatus_({ ok: true, state: loadState_() });
    case 'setApiKey':
      return setApiKey_(p.apiKey);
    case 'setModel':
      if (MODELS.indexOf(p.model) < 0) throw new Error('지원하지 않는 모델입니다.');
      PropertiesService.getScriptProperties().setProperty('CLAUDE_MODEL', p.model);
      return aiStatus_({ ok: true });
    case 'saveMeta':
      return withLock_(function () {
        saveMeta_(p.meta);
        return { ok: true };
      });
    case 'classify':
      return { ok: true, results: classifyItems_(p.items || [], loadMeta_()) };
    case 'addTransactions':
      return withLock_(function () {
        return { ok: true, added: addTransactions_(p.items || []) };
      });
    case 'updateTransaction':
      return withLock_(function () {
        return { ok: true, tx: updateTransaction_(p.id, p.patch || {}) };
      });
    case 'deleteTransaction':
      return withLock_(function () {
        deleteTransaction_(p.id);
        return { ok: true };
      });
    case 'reclassify':
      return withLock_(function () {
        return { ok: true, updated: reclassify_(p.start, p.end, p.onlyUnclassified) };
      });
    default:
      throw new Error('unknown action: ' + req.action);
  }
}

function receiveMessage_(text, source) {
  text = String(text || '').trim();
  if (!text) return { ok: true, saved: false, reason: 'empty' };
  return withLock_(function () {
    var meta = loadMeta_();
    var today = today_();
    var cats = BL.planFor(meta, BL.getPeriod(today, meta.settings.startDay).key).categories;
    var opts = { accounts: meta.accounts, myName: meta.settings.myName };

    var parsed = null;
    var method = null;
    var ai = callClaude_(BL.buildMessageRequest(cats, text, today, meta.merchantMap, opts));
    if (ai.ok) {
      parsed = BL.readMessageResponse(ai.json, cats, today, meta.accounts);
      if (!parsed) return { ok: true, saved: false, reason: 'not_transaction' };
      method = parsed.categoryId ? 'ai' : null;
    } else {
      parsed = BL.parseMessageFallback(text, today, opts);
      if (!parsed) return { ok: true, saved: false, reason: 'not_transaction' };
      parsed.categoryId = null;
    }
    // AI 가 계좌를 못 찾았으면 번호로 한 번 더 찾는다
    if (!parsed.accountId) {
      var acc = BL.matchAccount(text, meta.accounts);
      if (acc) parsed.accountId = acc.id;
    }

    // 지출이면: 사용자가 직접 분류해 둔 가맹점을 우선하고, AI 결과가 없으면 키워드로
    if (parsed.kind === 'expense') {
      var planCats = BL.planFor(meta, BL.getPeriod(parsed.date, meta.settings.startDay).key).categories;
      var local = BL.classifyLocal(parsed.memo, planCats, meta.merchantMap);
      if (local.method === 'learned' || (!parsed.categoryId && local.categoryId)) {
        parsed.categoryId = local.categoryId;
        method = local.method;
      }
    }

    // 알림에 잔액이 있으면 계좌 잔액 갱신
    if (parsed.accountId && typeof parsed.balance === 'number') {
      meta.accounts.forEach(function (a) {
        if (a.id === parsed.accountId) {
          a.balance = parsed.balance;
          a.balanceAt = nowISO_();
        }
      });
      saveMeta_(meta, true);
    }

    var existing = readTransactions_();
    if (BL.isDuplicate(parsed, existing)) return { ok: true, saved: false, reason: 'duplicate' };

    var tx = newTx_(parsed, parsed.categoryId ? method : null, source, text);
    appendTxRows_([tx], meta);
    return { ok: true, saved: true, tx: tx, aiError: ai.ok ? null : ai.error };
  });
}

// items: [{date, amount, memo, categoryId?, method?, source?, raw?}]
// categoryId 가 '__auto' 이거나 없으면 서버에서 분류한다.
function addTransactions_(items) {
  var meta = loadMeta_();
  var auto = [];
  items.forEach(function (it, i) {
    var isExpense = !it.kind || it.kind === 'expense';
    if (!isExpense) it.categoryId = null;
    else if (it.categoryId === '__auto' || it.categoryId === undefined) auto.push(i);
  });
  if (auto.length) {
    var res = classifyItems_(auto.map(function (i) { return items[i]; }), meta);
    auto.forEach(function (i, k) {
      items[i].categoryId = res[k].categoryId;
      items[i].method = res[k].method;
    });
  }
  var txs = items.map(function (it) {
    return newTx_(it, it.categoryId ? it.method || 'manual' : null, it.source || 'app', it.raw || '');
  });
  appendTxRows_(txs, meta);
  return txs;
}

// 분류: 학습된 가맹점 → Claude → 키워드. 각 지출의 날짜가 속한 기간의 계획을 기준으로 한다.
// 반환: [{categoryId, method}]
function classifyItems_(items, meta) {
  var results = items.map(function () { return { categoryId: null, method: null }; });
  var groups = {}; // 계획(from) 별로 묶어서 AI 호출
  items.forEach(function (it, i) {
    var plan = BL.planFor(meta, BL.getPeriod(it.date, meta.settings.startDay).key);
    var local = BL.classifyLocal(it.memo, plan.categories, meta.merchantMap);
    if (local.method === 'learned') {
      results[i] = local;
      return;
    }
    results[i] = local; // AI 실패 시 키워드 결과가 남는다
    (groups[plan.from] = groups[plan.from] || { plan: plan, idx: [] }).idx.push(i);
  });

  Object.keys(groups).forEach(function (from) {
    var g = groups[from];
    for (var s = 0; s < g.idx.length; s += AI_BATCH) {
      var chunk = g.idx.slice(s, s + AI_BATCH);
      var chunkItems = chunk.map(function (i) { return items[i]; });
      var ai = callClaude_(BL.buildClassifyRequest(g.plan.categories, chunkItems, meta.merchantMap));
      if (!ai.ok) continue;
      var ids = BL.readClassifyResponse(ai.json, g.plan.categories, chunk.length);
      chunk.forEach(function (i, k) {
        results[i] = ids[k] ? { categoryId: ids[k], method: 'ai' } : { categoryId: null, method: null };
      });
    }
  });
  return results;
}

// 기간 안의 지출을 그 기간 계획에 맞춰 다시 분류한다. 직접 고른 항목(method=manual)은
// 그 항목이 계획에 아직 있으면 그대로 둔다.
function reclassify_(start, end, onlyUnclassified) {
  var meta = loadMeta_();
  var txs = readTransactions_();
  var targets = txs.filter(function (t) {
    if (t.date < start || t.date > end) return false;
    if (BL.kindOf(t) !== 'expense') return false;
    var plan = BL.planFor(meta, BL.getPeriod(t.date, meta.settings.startDay).key);
    var exists = plan.categories.some(function (c) { return c.id === t.categoryId; });
    if (onlyUnclassified) return !t.categoryId || !exists;
    return !(t.method === 'manual' && exists);
  });
  if (!targets.length) return [];
  var res = classifyItems_(targets, meta);
  var now = nowISO_();
  targets.forEach(function (t, i) {
    t.categoryId = res[i].categoryId;
    t.method = res[i].method;
    t.classifiedAt = now;
  });
  writeTxRows_(targets, meta);
  return targets;
}

function updateTransaction_(id, patch) {
  var meta = loadMeta_();
  var txs = readTransactions_();
  var tx = txs.filter(function (t) { return t.id === id; })[0];
  if (!tx) throw new Error('not found: ' + id);
  ['date', 'amount', 'memo', 'categoryId', 'method', 'kind', 'accountId'].forEach(function (k) {
    if (patch[k] !== undefined) tx[k] = patch[k];
  });
  tx.classifiedAt = nowISO_();
  writeTxRows_([tx], meta);
  return tx;
}

function deleteTransaction_(id) {
  var sh = txSheet_();
  var ids = sh.getRange(2, 1, Math.max(0, sh.getLastRow() - 1), 1).getValues();
  for (var r = ids.length - 1; r >= 0; r--) {
    if (String(ids[r][0]) === id) sh.deleteRow(r + 2);
  }
}

// ---------- Claude API ----------

function aiStatus_(out) {
  out.ai = !!prop_('ANTHROPIC_API_KEY');
  out.model = model_();
  out.models = MODELS;
  out.lastError = prop_('LAST_AI_ERROR');
  out.url = serviceUrl_();
  return out;
}

// 앱 설정 화면에서 넣은 API 키를 확인(모델 목록 조회, 비용 없음)한 뒤 저장한다. 빈 값이면 지운다.
function setApiKey_(apiKey) {
  var props = PropertiesService.getScriptProperties();
  apiKey = String(apiKey || '').trim();
  if (!apiKey) {
    props.deleteProperty('ANTHROPIC_API_KEY');
    return aiStatus_({ ok: true });
  }
  if (!/^sk-ant-/.test(apiKey)) throw new Error('Claude API 키는 sk-ant- 로 시작해요.');
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models?limit=1', {
    method: 'get',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('API 키가 올바르지 않아요. (HTTP ' + code + ')');
  if (code !== 200) throw new Error('키를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요. (HTTP ' + code + ')');
  props.setProperty('ANTHROPIC_API_KEY', apiKey);
  props.deleteProperty('LAST_AI_ERROR');
  return aiStatus_({ ok: true });
}

function model_() {
  return prop_('CLAUDE_MODEL') || DEFAULT_MODEL;
}

// req: {system, user, schema} → {ok, json} 또는 {ok:false, error}
function callClaude_(req) {
  var apiKey = prop_('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  var model = model_();
  var body = {
    model: model,
    max_tokens: 8000,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: { format: { type: 'json_schema', schema: req.schema } },
  };
  var headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  // 분류는 간단한 작업이라 생각을 짧게 (effort 를 지원하지 않는 예전 Haiku 4.5 는 제외)
  if (!/^claude-haiku-4/.test(model)) body.output_config.effort = 'low';
  // 안전 필터에 걸려 거절되면 다른 모델로 자동 재시도
  if (/^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  try {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var data = JSON.parse(res.getContentText() || '{}');
    if (code !== 200) return fail_('HTTP ' + code + ': ' + ((data.error && data.error.message) || ''));
    if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') return fail_('stop_reason ' + data.stop_reason);
    var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return { ok: true, json: JSON.parse(text) };
  } catch (err) {
    return fail_(String(err && err.message ? err.message : err));
  }
}

function fail_(msg) {
  PropertiesService.getScriptProperties().setProperty('LAST_AI_ERROR', nowISO_() + ' ' + msg.slice(0, 300));
  return { ok: false, error: msg };
}

// ---------- 저장소 (구글 시트) ----------

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function txSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(TX_SHEET);
  if (!sh) {
    sh = ss.insertSheet(TX_SHEET);
    sh.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]);
    sh.setFrozenRows(1);
    // 날짜·id 가 시트에서 날짜/숫자로 바뀌지 않도록 일반 텍스트로
    sh.getRange('A:B').setNumberFormat('@');
    sh.getRange('J:K').setNumberFormat('@');
  } else if (sh.getLastColumn && sh.getLastColumn() < TX_HEADERS.length) {
    sh.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]); // 예전 버전 시트에 열 추가
  }
  return sh;
}

function metaSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(META_SHEET);
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function loadMeta_() {
  var sh = metaSheet_();
  var n = sh.getLastRow();
  var json = n ? sh.getRange(1, 1, n, 1).getValues().map(function (r) { return r[0]; }).join('') : '';
  var raw = json ? JSON.parse(json) : null;
  var state = BL.normalizeState(raw);
  delete state.transactions;
  return state;
}

// 셀 하나에 5만 자까지라 4만 자씩 나눠 저장.
// 화면이 오래된 설정을 보내도, 알림으로 더 최근에 갱신된 계좌 잔액은 덮어쓰지 않는다. (fromServer 면 그대로 저장)
function saveMeta_(meta, fromServer) {
  var clean = BL.normalizeState(meta);
  delete clean.transactions;
  if (!fromServer) {
    var current = loadMeta_().accounts;
    clean.accounts.forEach(function (a) {
      var cur = current.filter(function (c) { return c.id === a.id; })[0];
      if (cur && cur.balanceAt > a.balanceAt) {
        a.balance = cur.balance;
        a.balanceAt = cur.balanceAt;
      }
    });
  }
  var json = JSON.stringify(clean);
  var chunks = [];
  for (var i = 0; i < json.length; i += 40000) chunks.push([json.slice(i, i + 40000)]);
  var sh = metaSheet_();
  sh.clearContents();
  sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
}

function loadState_() {
  var meta = loadMeta_();
  meta.transactions = readTransactions_();
  return meta;
}

function cellToString_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function readTransactions_() {
  var sh = txSheet_();
  var n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, TX_HEADERS.length).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      return {
        id: cellToString_(r[0]),
        date: cellToString_(r[1]),
        amount: Number(r[2]) || 0,
        memo: cellToString_(r[3]),
        categoryId: cellToString_(r[4]) || null,
        method: cellToString_(r[6]) || null,
        source: cellToString_(r[7]),
        raw: cellToString_(r[8]),
        createdAt: cellToString_(r[9]),
        classifiedAt: cellToString_(r[10]),
        kind: cellToString_(r[11]) || 'expense',
        accountId: cellToString_(r[12]) || null,
      };
    });
}

function txToRow_(t, meta) {
  var plan = BL.planFor(meta, BL.getPeriod(t.date, meta.settings.startDay).key);
  var cat = plan.categories.filter(function (c) { return c.id === t.categoryId; })[0];
  var kind = BL.kindOf(t);
  var label = kind === 'income' ? '입금' : kind === 'transfer' ? '내 계좌 이체' : cat ? cat.name : '미분류';
  return [t.id, t.date, t.amount, t.memo, t.categoryId || '', label, t.method || '', t.source || '', t.raw || '', t.createdAt || '', t.classifiedAt || '', kind, t.accountId || ''];
}

function appendTxRows_(txs, meta) {
  if (!txs.length) return;
  var sh = txSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, txs.length, TX_HEADERS.length).setValues(txs.map(function (t) { return txToRow_(t, meta); }));
}

function writeTxRows_(txs, meta) {
  var sh = txSheet_();
  var n = sh.getLastRow() - 1;
  if (n <= 0) return;
  var ids = sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); });
  txs.forEach(function (t) {
    var r = ids.indexOf(t.id);
    if (r >= 0) sh.getRange(r + 2, 1, 1, TX_HEADERS.length).setValues([txToRow_(t, meta)]);
  });
}

// ---------- 유틸 ----------

function newTx_(it, method, source, raw) {
  var now = nowISO_();
  return {
    id: Utilities.getUuid(),
    date: it.date,
    amount: Number(it.amount) || 0,
    memo: String(it.memo || '(내용 없음)'),
    categoryId: it.categoryId || null,
    method: method || null,
    source: source || '',
    raw: String(raw || '').slice(0, 1000),
    createdAt: now,
    classifiedAt: now,
    kind: it.kind === 'income' || it.kind === 'transfer' ? it.kind : 'expense',
    accountId: it.accountId || null,
  };
}

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function checkKey_(key) {
  var expected = prop_('APP_KEY');
  return !!expected && key === expected;
}

function serviceUrl_() {
  try {
    return ScriptApp.getService().getUrl();
  } catch (e) {
    return '';
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function nowISO_() {
  return new Date().toISOString();
}

var INDEX_HTML = "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <title>내 지출 관리</title>\n  <style>\n:root {\n  color-scheme: light;\n  --page: #f4f4f1;\n  --surface: #fcfcfb;\n  --surface-2: #f0efec;\n  --surface-3: #e7e6e1;\n  --text: #0b0b0b;\n  --text-2: #52514e;\n  --muted: #6f6d68;\n  --border: rgba(11, 11, 11, 0.09);\n  --accent: #2a78d6;\n  --accent-track: #cde2fb;\n  --accent-soft: #e6f0fc;\n  --accent-text: #1c5cab;\n  --good: #0ca30c;\n  --good-text: #006300;\n  --warning: #fab219;\n  --warning-track: #fde8b8;\n  --critical: #d03b3b;\n  --critical-track: #f6d0d0;\n  --critical-text: #b42f2f;\n  --gray-mark: #b8b6ae;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7;\n  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04);\n  --sidebar-w: 232px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n    color-scheme: dark;\n    --page: #0d0d0d;\n    --surface: #1a1a19;\n    --surface-2: #232321;\n    --surface-3: #2e2e2b;\n    --text: #ffffff;\n    --text-2: #c3c2b7;\n    --muted: #9a988f;\n    --border: rgba(255, 255, 255, 0.09);\n    --accent: #3987e5;\n    --accent-track: #1c3558;\n    --accent-soft: #16263b;\n    --accent-text: #86b6ef;\n    --good-text: #0ca30c;\n    --warning-track: #4a3a12;\n    --critical-track: #4a1f1f;\n    --critical-text: #ec7070;\n    --gray-mark: #5c5b56;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n    --shadow: none;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --page: #0d0d0d;\n  --surface: #1a1a19;\n  --surface-2: #232321;\n  --surface-3: #2e2e2b;\n  --text: #ffffff;\n  --text-2: #c3c2b7;\n  --muted: #9a988f;\n  --border: rgba(255, 255, 255, 0.09);\n  --accent: #3987e5;\n  --accent-track: #1c3558;\n  --accent-soft: #16263b;\n  --accent-text: #86b6ef;\n  --good-text: #0ca30c;\n  --warning-track: #4a3a12;\n  --critical-track: #4a1f1f;\n  --critical-text: #ec7070;\n  --gray-mark: #5c5b56;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n  --shadow: none;\n}\n\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nbody {\n  margin: 0;\n  background: var(--page);\n  color: var(--text);\n  font-family: system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif;\n  font-size: 15px;\n  line-height: 1.5;\n}\n\nh1 { font-size: 20px; margin: 0; }\nh2 { font-size: 16px; margin: 0 0 8px; }\nh3 { font-size: 14px; margin: 16px 0 4px; }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.num { font-variant-numeric: tabular-nums; }\nsvg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n\n/* ---------- 레이아웃 ---------- */\n.app { min-height: 100vh; }\n.sidebar {\n  position: fixed;\n  inset: 0 auto 0 0;\n  width: var(--sidebar-w);\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  display: flex;\n  flex-direction: column;\n  padding: 20px 12px;\n  z-index: 30;\n}\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 0 8px 20px; }\n.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 16px; }\n.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }\n.nav-item {\n  display: flex; align-items: center; gap: 12px;\n  border: 0; background: none; color: var(--text-2);\n  font: inherit; text-align: left; padding: 10px 12px; border-radius: 10px; cursor: pointer;\n}\n.nav-item:hover { background: var(--surface-2); }\n.nav-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }\n.nav-sep { height: 1px; background: var(--border); margin: 8px 12px; }\n.sidebar-foot { padding: 12px 8px 0; }\n\n.main { margin-left: var(--sidebar-w); min-width: 0; }\n.topbar {\n  position: sticky; top: 0; z-index: 20;\n  display: flex; align-items: center; gap: 12px;\n  padding: 14px 28px;\n  background: color-mix(in srgb, var(--page) 88%, transparent);\n  backdrop-filter: blur(8px);\n}\n.topbar h1 { flex: 1; }\n.topbar-actions { display: flex; gap: 8px; align-items: center; }\n.topbar .menu-btn { display: none; }\n.content { max-width: 1040px; padding: 4px 28px 40px; }\n.page { display: none; }\n.page.active { display: block; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }\n.grid-2 > .card { margin-bottom: 16px; }\n\n.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 25; }\n.bottom-nav { display: none; }\n\n@media (max-width: 900px) {\n  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }\n  .sidebar.open { transform: none; }\n  .main { margin-left: 0; }\n  .topbar .menu-btn { display: inline-flex; }\n  .topbar { padding: 10px 16px; }\n  .content { padding: 4px 16px 96px; }\n  .grid-2 { grid-template-columns: 1fr; gap: 0; }\n  .topbar .add-btn { display: none; }\n  .bottom-nav {\n    display: grid; grid-template-columns: repeat(5, 1fr);\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n    background: var(--surface); border-top: 1px solid var(--border);\n    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));\n  }\n  .bottom-nav button {\n    display: flex; flex-direction: column; align-items: center; gap: 2px;\n    border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;\n  }\n  .bottom-nav button.active { color: var(--accent-text); font-weight: 600; }\n  .bottom-nav .bn-add svg { width: 26px; height: 26px; color: #fff; background: var(--accent); border-radius: 50%; padding: 4px; stroke-width: 2.4; }\n}\n\n/* ---------- 공통 요소 ---------- */\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 18px 20px;\n  margin-bottom: 16px;\n  box-shadow: var(--shadow);\n}\n.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }\n.card-head h2 { margin: 0; }\n.note-card { background: var(--surface-2); box-shadow: none; }\n.note-card p { margin: 4px 0 8px; }\n.warn-card { background: var(--warning-track); border-color: transparent; }\n.card .sub-head { margin-top: 18px; }\n\nbutton, input, select, textarea { font: inherit; color: inherit; }\ninput, select, textarea {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  padding: 9px 11px;\n  min-width: 0;\n}\ninput:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }\ntextarea { width: 100%; resize: vertical; }\nselect.full { width: 100%; }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn {\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  border: 1px solid var(--border); background: var(--surface); white-space: nowrap;\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n.ghost-btn:hover, .icon-btn:hover { background: var(--surface-2); }\n.danger-btn { color: var(--critical-text); }\n.icon-btn { padding: 7px; }\n.small-btn { padding: 6px 11px; font-size: 13px; }\n.link { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }\n.link-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }\n.link-btn:hover { color: var(--critical-text); }\n.file-btn { display: inline-flex; }\n.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }\n.chip { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; display: inline-block; }\n.chip.on { background: var(--accent-soft); color: var(--accent-text); }\n.tag { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }\n.tag.warn { background: var(--warning-track); color: var(--text); }\n.empty { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }\n\n.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }\n.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }\n.form-grid .wide { grid-column: span 2; }\n.form-submit { display: flex; align-items: end; }\n@media (max-width: 520px) { .form-grid .wide { grid-column: 1 / -1; } }\n\n.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; margin: 4px 0 14px; }\n.segmented button { border: 0; background: none; padding: 7px 14px; border-radius: 8px; cursor: pointer; color: var(--text-2); }\n.segmented button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }\n\n.busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -50% 0; } to { background-position: 150% 0; } }\n\n/* ---------- 기간 선택 ---------- */\n.period-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }\n.period-label { display: flex; flex-direction: column; min-width: 0; }\n.period-label strong { font-size: 16px; }\n.period-nav .icon-btn { width: 34px; height: 34px; font-size: 20px; line-height: 1; padding: 0; }\n.period-nav #today-period { margin-left: auto; }\n\n/* ---------- 홈 ---------- */\n.income-prompt { border-color: var(--accent); background: var(--accent-soft); }\n.income-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }\n.income-form input { flex: 1; min-width: 140px; }\n.income-set { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }\n.income-set .value { font-size: 18px; font-weight: 600; }\n\n.hero-card .label { color: var(--text-2); font-size: 14px; }\n.hero-card .figure { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin: 2px 0 4px; }\n.hero-card .figure.negative { color: var(--critical-text); }\n.hero-card .sub { color: var(--text-2); font-size: 14px; }\n.hero-card .meter { margin-top: 14px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 36px; } }\n\n.kv { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--border); gap: 12px; }\n.kv:first-child { border-top: 0; }\n.kv .k { color: var(--text-2); font-size: 14px; }\n.kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }\n.kv .v.plus { color: var(--accent-text); }\n\n/* 항목 행 (미터) */\n.cat-row { padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }\n.cat-row:first-child { border-top: 0; }\n.cat-row:hover .cat-name { text-decoration: underline; }\n.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.cat-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }\n.badge { font-size: 12px; font-weight: 400; color: var(--text-2); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }\n.cat-amounts { font-size: 14px; color: var(--text-2); }\n.cat-amounts b { color: var(--text); }\n.meter { position: relative; height: 10px; border-radius: 4px; background: var(--accent-track); margin: 8px 0 6px; overflow: hidden; }\n.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }\n.meter.warning { background: var(--warning-track); }\n.meter.warning .meter-fill { background: var(--warning); }\n.meter.critical { background: var(--critical-track); }\n.meter.critical .meter-fill { background: var(--critical); }\n.cat-bottom { display: flex; justify-content: space-between; font-size: 13px; gap: 8px; }\n.status { color: var(--text-2); }\n.status.warning { color: var(--text); }\n.status.critical { color: var(--critical-text); font-weight: 600; }\n.remain-good { color: var(--good-text); }\n.remain-bad { color: var(--critical-text); font-weight: 600; }\n.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }\n\n/* 거래 목록 (날짜별 묶음) */\n.tx-date { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 14px 0 4px; border-bottom: 1px solid var(--border); }\n.tx { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n.tx:last-child { border-bottom: 0; }\n.tx-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; }\n.tx-icon.gray { background: var(--gray-mark); }\n.tx-main { min-width: 0; }\n.tx-memo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tx-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }\n.tx-meta select { font-size: 12px; padding: 3px 6px; border-radius: 8px; max-width: 160px; }\n.tx-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n.tx-amount { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.tx-amount.plus { color: var(--accent-text); }\n.tx-amount.neutral { color: var(--muted); font-weight: 600; }\n.list-total { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin: 12px 0 4px; }\n.list-total b { color: var(--text); }\n.filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 8px; }\n@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }\n\n/* ---------- 달력 ---------- */\n.cal-summary { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin-bottom: 12px; }\n.cal-summary b { color: var(--text); font-size: 16px; }\n.cal-summary .plus b { color: var(--accent-text); }\n.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }\n.cal-dow { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }\n.cal-dow.sun { color: var(--critical-text); }\n.cal-day {\n  min-height: 74px; border-radius: 10px; padding: 6px; border: 1px solid transparent;\n  display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--surface-2); text-align: left;\n  font: inherit; color: inherit; min-width: 0;\n}\n.cal-day.out { background: none; cursor: default; opacity: 0.35; }\n.cal-day.today .cal-num { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 6px; }\n.cal-day.selected { border-color: var(--accent); }\n.cal-num { font-size: 12px; font-weight: 600; align-self: flex-start; }\n.cal-spent, .cal-income { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n.cal-spent { color: var(--text); }\n.cal-income { color: var(--accent-text); }\n.cal-day.h1 { background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }\n.cal-day.h2 { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }\n.cal-day.h3 { background: color-mix(in srgb, var(--accent) 36%, var(--surface-2)); }\n@media (max-width: 520px) { .cal-day { min-height: 56px; padding: 4px; } .cal-spent, .cal-income { font-size: 10px; } }\n\n/* ---------- 리포트 ---------- */\n.headline-figure { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0; }\n.delta { font-size: 14px; color: var(--text-2); }\n.delta b { color: var(--text); }\n.share-bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 14px; }\n.share-bar span { display: block; height: 100%; min-width: 2px; }\n.share-bar span:first-child { border-radius: 4px 0 0 4px; }\n.share-bar span:last-child { border-radius: 0 4px 4px 0; }\n.share-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.share-row:first-of-type { border-top: 0; }\n.share-name { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.share-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.share-amount { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.share-diff { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }\n.rank { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rank:first-of-type { border-top: 0; }\n.rank .n { color: var(--muted); font-weight: 700; text-align: center; }\n.rank .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rank .a { font-weight: 600; font-variant-numeric: tabular-nums; }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.chart svg { width: 100%; height: auto; display: block; overflow: visible; stroke: none; }\n.chart .grid-line { stroke: var(--border); stroke-width: 1; }\n.chart .axis-label { fill: var(--muted); font-size: 11px; }\n.chart .hit { fill: transparent; cursor: pointer; }\n.chart .hit:hover { fill: color-mix(in srgb, var(--text) 5%, transparent); }\n\n/* ---------- 자산 ---------- */\n.acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--border); }\n.acct:first-child { border-top: 0; }\n.acct-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }\n.acct-icon.is-card { background: var(--surface-2); color: var(--text-2); }\n.acct-name { font-weight: 600; }\n.acct-sub { font-size: 12px; color: var(--muted); }\n.acct-bal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }\n.acct-bal .acct-sub { font-weight: 400; }\n\n/* ---------- 예산 계획 ---------- */\n.plan-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 1.5fr 1.5fr auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.plan-row.head { border-top: 0; font-size: 13px; color: var(--text-2); padding-top: 0; }\n.plan-row input, .plan-row select { width: 100%; }\n.value-wrap { position: relative; }\n.value-wrap input { padding-right: 28px; text-align: right; }\n.value-wrap .unit { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13px; pointer-events: none; }\n.plan-row .preview { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-top: -4px; }\n@media (max-width: 1100px) {\n  .plan-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type value value\" \"desc desc desc\" \"kw kw kw\" \"pv pv pv\"; }\n  .plan-row.head { display: none; }\n  .plan-row .pl-name { grid-area: name; }\n  .plan-row .pl-type { grid-area: type; }\n  .plan-row .value-wrap { grid-area: value; }\n  .plan-row .pl-desc { grid-area: desc; }\n  .plan-row .pl-kw { grid-area: kw; }\n  .plan-row .pl-del { grid-area: del; }\n  .plan-row .preview { grid-area: pv; margin-top: 0; }\n}\n.plan-summary { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--surface-2); font-size: 14px; }\n.warn { color: var(--critical-text); font-weight: 600; }\n\n/* ---------- 설정 ---------- */\n.settings-grid { display: grid; grid-template-columns: 160px 1fr; gap: 20px; align-items: start; }\n.settings-nav { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 2px; }\n.settings-nav a { color: var(--text-2); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 14px; }\n.settings-nav a:hover { background: var(--surface-2); }\n.card[id^=\"set-\"] { scroll-margin-top: 72px; }\n@media (max-width: 900px) {\n  .settings-grid { grid-template-columns: 1fr; gap: 0; }\n  .settings-nav { position: static; flex-direction: row; overflow-x: auto; margin-bottom: 12px; gap: 6px; }\n  .settings-nav a { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }\n}\n.acct-row { display: grid; grid-template-columns: 1.4fr 0.9fr 0.8fr 1fr auto auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.acct-row input, .acct-row select { width: 100%; }\n.acct-row .check { display: flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }\n.acct-row .check input { width: auto; }\n@media (max-width: 700px) {\n  .acct-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type last last\" \"bal bal save\"; }\n  .acct-row .a-name { grid-area: name; }\n  .acct-row .a-type { grid-area: type; }\n  .acct-row .a-last { grid-area: last; }\n  .acct-row .a-bal { grid-area: bal; }\n  .acct-row .check { grid-area: save; }\n  .acct-row .link-btn { grid-area: del; }\n}\n.copy-row { display: flex; gap: 8px; margin: 6px 0 12px; }\n.copy-row input { flex: 1; font-size: 13px; }\n.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }\n.steps li { margin: 3px 0; }\n\n/* 표 (붙여넣기 미리보기) */\n.table-wrap { overflow-x: auto; margin-top: 12px; }\ntable { width: 100%; border-collapse: collapse; font-size: 14px; }\nth, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }\nth { font-weight: 600; color: var(--text-2); font-size: 13px; }\ntd.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntd select, td input { width: 100%; padding: 6px 8px; }\ntd.memo { min-width: 120px; word-break: break-all; }\n.refund { color: var(--good-text); }\n@media (max-width: 560px) {\n  .stack-table thead { display: none; }\n  .stack-table tbody tr { display: grid; gap: 6px 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n  .stack-table td { border: 0; padding: 0; min-width: 0; }\n  .parse-table tbody tr { grid-template-columns: auto 1fr 1fr auto; grid-template-areas: \"chk memo memo amt\" \". date cat cat\"; }\n  .parse-table td:nth-child(1) { grid-area: chk; }\n  .parse-table td:nth-child(2) { grid-area: date; }\n  .parse-table td:nth-child(3) { grid-area: memo; }\n  .parse-table td:nth-child(4) { grid-area: amt; }\n  .parse-table td:nth-child(5) { grid-area: cat; }\n}\n\n/* 툴팁 & 토스트 */\n.tooltip {\n  position: fixed; z-index: 50; pointer-events: none;\n  background: var(--surface); color: var(--text);\n  border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);\n  border-radius: 10px; padding: 8px 10px; font-size: 13px; max-width: 240px;\n}\n.tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }\n.tooltip .t-row span:first-child { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }\n.toast {\n  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);\n  background: var(--text); color: var(--page);\n  padding: 10px 16px; border-radius: 10px; z-index: 60; font-size: 14px; max-width: calc(100% - 32px);\n}\n@media (max-width: 900px) { .toast { bottom: calc(80px + env(safe-area-inset-bottom)); } }\n\n/* 처음 접속할 때 키 입력 */\n.key-gate { position: fixed; inset: 0; z-index: 70; background: var(--page); display: grid; place-items: center; padding: 16px; }\n.key-card { width: 100%; max-width: 420px; }\n.key-card input { width: 100%; margin-top: 8px; }\n\n.steps a.primary-btn { color: #fff; text-decoration: none; margin: 4px 0; }\n.steps a { color: var(--accent-text); }\ndetails summary { cursor: pointer; color: var(--text-2); margin-top: 8px; }\n\n/* 미분류 정리 */\n.nav-count { margin-left: auto; min-width: 22px; padding: 0 7px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; line-height: 20px; text-align: center; }\n.check-row { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; margin-top: 10px; cursor: pointer; }\n.check-row input { margin-top: 3px; }\n.sort-group { display: flex; flex-direction: column; gap: 10px; }\n.sort-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }\n.sort-memo { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }\n.sort-sum { font-variant-numeric: tabular-nums; white-space: nowrap; }\n.sort-dates { font-size: 13px; color: var(--text-2); }\n.sort-raw { font-size: 13px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }\n.pick-row { display: flex; flex-wrap: wrap; gap: 6px; }\n.pick-btn { border: 1px solid var(--border); background: var(--surface); color: inherit; font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }\n.pick-btn:hover { background: var(--surface-2); }\n.pick-btn .dot { width: 8px; height: 8px; border-radius: 50%; }\n.pick-btn.other { color: var(--text-2); border-style: dashed; }\n.sort-group details summary { font-size: 13px; color: var(--text-2); cursor: pointer; }\n.sort-others { margin-top: 12px; align-items: center; }\n.sort-others:empty { display: none; }\n</style>\n</head>\n<body>\n  <noscript>\n    <div style=\"padding:16px;margin:12px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif\">\n      이 화면에서는 앱의 기능(자바스크립트)이 실행되지 않아요. 파일 앱의 <b>미리보기</b>가 아니라 <b>크롬·삼성 인터넷·사파리</b> 같은 브라우저로 열어 주세요.\n    </div>\n  </noscript>\n  <div id=\"boot-error\" hidden style=\"position:fixed;left:12px;right:12px;top:12px;z-index:100;padding:16px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)\"></div>\n  <script>\n    // 앱이 시작되지 못하면 이유를 화면에 보여준다. (오래된 브라우저에서도 돌아가도록 옛 문법으로 작성)\n    (function () {\n      var shown = false;\n      function show(msg) {\n        if (shown) return;\n        shown = true;\n        var el = document.getElementById('boot-error');\n        el.innerHTML = '<b>앱을 시작하지 못했어요.</b><br>브라우저가 오래됐거나 미리보기 화면일 수 있어요. 최신 크롬·삼성 인터넷·사파리로 열어 보고, 그래도 안 되면 이 화면을 캡처해서 알려 주세요.' +\n          '<div style=\"margin-top:8px;font-size:12px;color:#52514e;word-break:break-all\">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent.replace(/</g, '&lt;') + '</div>';\n        el.hidden = false;\n        el.style.display = 'block';\n      }\n      window.addEventListener('error', function (e) {\n        if (window.__budgetStarted) return;\n        var where = window.__budgetCurrent || e.filename || '';\n        show((e.message || '알 수 없는 오류') + (where ? ' @ ' + where + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : ''));\n      });\n      // 구글 웹 앱용 빌드에서는 기능 코드를 base64 로 감싸 보낸다. 전달 과정에서 코드 글자가 바뀌어도 깨지지 않게 하려는 것.\n      window.__budgetRun = function (name, b64) {\n        window.__budgetCurrent = name;\n        try {\n          var bin = atob(b64);\n          var bytes = new Uint8Array(bin.length);\n          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n          var el = document.createElement('script');\n          el.text = new TextDecoder('utf-8').decode(bytes);\n          document.body.appendChild(el);\n        } catch (err) {\n          show(name + ': ' + (err && err.message));\n        }\n        window.__budgetCurrent = '';\n      };\n      window.addEventListener('load', function () {\n        setTimeout(function () {\n          if (!window.__budgetStarted) show('기능 코드가 실행되지 않았습니다.');\n        }, 3000);\n      });\n    })();\n  </script>\n  <div id=\"busy\" class=\"busy\" hidden></div>\n\n  <div class=\"app\">\n    <!-- 메뉴 -->\n    <aside class=\"sidebar\" id=\"sidebar\" aria-label=\"메뉴\">\n      <div class=\"brand\">\n        <span class=\"brand-mark\" aria-hidden=\"true\">₩</span>\n        <span>내 지출 관리</span>\n      </div>\n      <nav class=\"nav\" id=\"nav\">\n        <button class=\"nav-item\" data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n        <button class=\"nav-item\" data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n        <button class=\"nav-item\" data-page=\"list\"><svg viewBox=\"0 0 24 24\"><path d=\"M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01\"/></svg>내역</button>\n        <button class=\"nav-item\" data-page=\"sort\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 5h16l-6 7.5V19l-4 1.5v-8z\"/></svg>미분류 정리<span id=\"sort-count\" class=\"nav-count\" hidden></span></button>\n        <button class=\"nav-item\" data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n        <button class=\"nav-item\" data-page=\"assets\"><svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M16 14.5h2\"/></svg>자산</button>\n        <button class=\"nav-item\" data-page=\"plan\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/></svg>예산 계획</button>\n        <div class=\"nav-sep\"></div>\n        <button class=\"nav-item\" data-page=\"add\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>지출·수입 입력</button>\n        <button class=\"nav-item\" data-page=\"settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3\"/></svg>설정</button>\n      </nav>\n      <div class=\"sidebar-foot\">\n        <span id=\"conn-status\" class=\"chip\"></span>\n      </div>\n    </aside>\n    <div class=\"scrim\" id=\"scrim\" hidden></div>\n\n    <div class=\"main\">\n      <header class=\"topbar\">\n        <button id=\"menu-btn\" class=\"icon-btn menu-btn\" aria-label=\"메뉴 열기\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg></button>\n        <h1 id=\"page-title\">홈</h1>\n        <div class=\"topbar-actions\">\n          <button id=\"refresh-btn\" class=\"icon-btn\" aria-label=\"새로고침\" hidden><svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5\"/></svg></button>\n          <button id=\"add-btn\" class=\"primary-btn add-btn\">+ 입력</button>\n        </div>\n      </header>\n\n      <div class=\"content\">\n        <div class=\"period-nav\" id=\"period-nav\">\n          <button id=\"prev-period\" class=\"icon-btn\" aria-label=\"이전 기간\">‹</button>\n          <div class=\"period-label\">\n            <strong id=\"period-text\"></strong>\n            <span id=\"period-sub\" class=\"muted small\"></span>\n          </div>\n          <button id=\"next-period\" class=\"icon-btn\" aria-label=\"다음 기간\">›</button>\n          <button id=\"today-period\" class=\"ghost-btn small-btn\">오늘</button>\n        </div>\n\n        <!-- 홈 -->\n        <section class=\"page\" data-page=\"home\">\n          <div id=\"income-box\" class=\"card\"></div>\n          <div id=\"stale-box\"></div>\n          <div id=\"fixed-box\"></div>\n          <div class=\"grid-2\">\n            <div class=\"card hero-card\" id=\"hero\"></div>\n            <div class=\"card\" id=\"home-summary\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 예산</h2>\n              <span id=\"alloc-note\" class=\"muted small\"></span>\n            </div>\n            <div id=\"category-rows\"></div>\n          </div>\n          <div class=\"grid-2\">\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>최근 내역</h2><button class=\"link\" data-goto=\"list\">전체 보기</button></div>\n              <div id=\"recent-list\"></div>\n            </div>\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>자산</h2><button class=\"link\" data-goto=\"assets\">자세히</button></div>\n              <div id=\"home-assets\"></div>\n            </div>\n          </div>\n        </section>\n\n        <!-- 달력 -->\n        <section class=\"page\" data-page=\"calendar\">\n          <div class=\"card\">\n            <div id=\"cal-summary\" class=\"cal-summary\"></div>\n            <div id=\"calendar\" class=\"calendar\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"day-title\"></h2><span id=\"day-total\" class=\"muted small\"></span></div>\n            <div id=\"day-list\"></div>\n          </div>\n        </section>\n\n        <!-- 내역 -->\n        <section class=\"page\" data-page=\"list\">\n          <div class=\"card\">\n            <div class=\"filters\">\n              <input type=\"search\" id=\"list-search\" placeholder=\"사용처 검색\" aria-label=\"사용처 검색\">\n              <select id=\"list-kind\" aria-label=\"종류\">\n                <option value=\"all\">모든 종류</option>\n                <option value=\"expense\">지출</option>\n                <option value=\"income\">입금</option>\n                <option value=\"transfer\">내 계좌 이체</option>\n              </select>\n              <select id=\"list-filter\" aria-label=\"항목\"></select>\n              <select id=\"list-account\" aria-label=\"결제수단\"></select>\n            </div>\n            <div class=\"row-actions\">\n              <button id=\"reclassify-unclassified\" class=\"ghost-btn small-btn\">미분류만 다시 분류</button>\n              <button id=\"reclassify-all\" class=\"ghost-btn small-btn\">이 기간 전체 다시 분류</button>\n            </div>\n            <div id=\"list-total\" class=\"list-total\"></div>\n            <div id=\"tx-list\"></div>\n            <p class=\"muted small\">항목을 직접 바꾸면 그 사용처를 기억해서 다음부터 같은 항목으로 분류합니다.</p>\n          </div>\n        </section>\n\n        <!-- 리포트 -->\n        <section class=\"page\" data-page=\"report\">\n          <div class=\"grid-2\">\n            <div class=\"card\" id=\"report-headline\"></div>\n            <div class=\"card\" id=\"report-merchants\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>어디에 썼나요</h2><span class=\"muted small\">이번 기간 지출 구성</span></div>\n            <div id=\"report-share\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>기간별 추이</h2><span class=\"muted small\">최근 6개 기간</span></div>\n            <div id=\"report-trend\"></div>\n          </div>\n        </section>\n\n        <!-- 자산 -->\n        <section class=\"page\" data-page=\"assets\">\n          <div class=\"card hero-card\" id=\"asset-hero\"></div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>계좌</h2><button class=\"link\" data-goto=\"settings\">계좌 관리</button></div>\n            <div id=\"asset-banks\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>카드</h2><span class=\"muted small\">이번 기간 사용액</span></div>\n            <div id=\"asset-cards\"></div>\n          </div>\n        </section>\n\n        <!-- 미분류 정리 -->\n        <section class=\"page\" data-page=\"sort\">\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"sort-title\">미분류 정리</h2><span id=\"sort-total\" class=\"muted small\"></span></div>\n            <p class=\"muted small\">위에서 고른 기간에 AI나 키워드가 항목을 정하지 못한 지출이에요. 같은 가맹점·상대에게 쓴 것끼리 묶었으니, 알맞은 항목을 누르면 묶음 전체가 그 항목으로 들어가요.</p>\n            <label class=\"check-row\"><input type=\"checkbox\" id=\"sort-learn\" checked> 고른 항목을 기억해서 다음부터 같은 가맹점·상대는 자동으로 분류</label>\n            <div id=\"sort-others\" class=\"pick-row sort-others\"></div>\n          </div>\n          <div id=\"sort-groups\"></div>\n        </section>\n\n        <!-- 예산 계획 -->\n        <section class=\"page\" data-page=\"plan\">\n          <div id=\"plan-version\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>비율 항목의 기준 금액</h2>\n            <select id=\"ratio-base\" class=\"full\">\n              <option value=\"afterFixed\">수입에서 고정 항목을 뺀 나머지</option>\n              <option value=\"income\">전체 수입</option>\n            </select>\n            <h2 class=\"sub-head\">고정 항목 합계가 수입보다 클 때</h2>\n            <select id=\"fixed-overflow\" class=\"full\">\n              <option value=\"warn\">그대로 두고 알려 주기</option>\n              <option value=\"scale\">수입에 맞게 비율대로 줄이기</option>\n            </select>\n            <p class=\"muted small\">줄이기를 고르면 고정 항목끼리의 비율은 그대로 두고, 합계가 그 기간 수입과 같아지도록 한도를 낮춥니다. 예: 월세 60만·통신 10만(합 70만)인데 수입이 56만이면 월세 48만·통신 8만.</p>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 배분</h2>\n              <button id=\"add-category\" class=\"ghost-btn small-btn\">+ 항목 추가</button>\n            </div>\n            <p class=\"muted small\"><b>수입 비례(%)</b>: 그 기간에 들어온 돈에 비례해 한도가 정해집니다. <b>고정 금액</b>: 수입과 상관없이 매 기간 같은 한도입니다.<br><b>설명</b>은 AI가 지출을 분류할 때 참고합니다. 예: \"외식, 배달, 장보기\". <b>키워드</b>는 쉼표로 구분하며, AI를 쓸 수 없을 때 사용처에 키워드가 들어 있으면 그 항목으로 분류합니다.</p>\n            <div id=\"plan-rows\"></div>\n            <div id=\"plan-summary\" class=\"plan-summary\"></div>\n          </div>\n        </section>\n\n        <!-- 입력 -->\n        <section class=\"page\" data-page=\"add\">\n          <div id=\"auto-hint\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>직접 입력</h2>\n            <div class=\"segmented\" id=\"m-kind\" role=\"radiogroup\" aria-label=\"종류\">\n              <button type=\"button\" data-kind=\"expense\" class=\"active\">지출</button>\n              <button type=\"button\" data-kind=\"income\">입금</button>\n              <button type=\"button\" data-kind=\"transfer\">내 계좌 이체</button>\n            </div>\n            <form id=\"manual-form\" class=\"form-grid\">\n              <label>날짜<input type=\"date\" id=\"m-date\" required></label>\n              <label>금액(원)<input type=\"text\" inputmode=\"numeric\" id=\"m-amount\" placeholder=\"12,000\" required></label>\n              <label class=\"wide\">사용처 / 메모<input type=\"text\" id=\"m-memo\" placeholder=\"스타벅스 강남점\"></label>\n              <label id=\"m-category-wrap\">항목<select id=\"m-category\"></select></label>\n              <label>결제수단<select id=\"m-account\"></select></label>\n              <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">추가</button></div>\n            </form>\n            <p id=\"m-hint\" class=\"muted small\"></p>\n          </div>\n          <div class=\"card\">\n            <h2>내역 붙여넣기</h2>\n            <p class=\"muted small\">카드 승인 문자, 은행/카드 앱 내역, 엑셀에서 복사한 표를 그대로 붙여넣으세요. 한 줄에 한 건씩 날짜·금액·사용처를 읽고 <span id=\"classifier-name\">항목</span>을 자동으로 정합니다.</p>\n            <textarea id=\"paste-input\" rows=\"6\" placeholder=\"예)&#10;2026-09-27 배달의민족 23,500원&#10;9월 25일 카카오T 택시 8,400원&#10;09/24 올리브영 강남점 32,000원\"></textarea>\n            <div class=\"row-actions\">\n              <button id=\"parse-btn\" class=\"primary-btn\">인식하기</button>\n              <button id=\"paste-clear\" class=\"ghost-btn\">지우기</button>\n            </div>\n            <div id=\"parse-result\"></div>\n          </div>\n          <div class=\"card\">\n            <h2>은행 거래내역 파일 가져오기</h2>\n            <p class=\"muted small\">카카오뱅크: 앱에서 계좌 선택 → 오른쪽 위 설정(톱니바퀴) → <b>거래내역</b> → 이메일과 기간을 넣고 받기. 메일로 온 엑셀(.xlsx)이나 CSV 파일을 그대로 올리세요. 다른 은행 파일도 날짜·금액 칸이 있으면 읽습니다. 알림으로 이미 들어온 내역은 <b>중복?</b>으로 표시하고 빼 둡니다.</p>\n            <div class=\"form-grid\">\n              <label>어느 계좌의 내역인가요<select id=\"file-account\"></select></label>\n              <label>파일<input type=\"file\" id=\"file-input\" accept=\".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"></label>\n            </div>\n            <div id=\"file-result\"></div>\n          </div>\n        </section>\n\n        <!-- 설정 -->\n        <section class=\"page\" data-page=\"settings\">\n          <div class=\"settings-grid\">\n            <nav class=\"settings-nav\" aria-label=\"설정 메뉴\">\n              <a href=\"#set-basic\">기본</a>\n              <a href=\"#set-accounts\">계좌·카드</a>\n              <a href=\"#set-auto\">자동 입력</a>\n              <a href=\"#set-data\">데이터</a>\n            </nav>\n            <div>\n              <div class=\"card\" id=\"set-basic\">\n                <h2>기본</h2>\n                <div class=\"form-grid\">\n                  <label>매 기간 시작일\n                    <select id=\"start-day\"></select>\n                  </label>\n                  <label>내 이름\n                    <input type=\"text\" id=\"my-name\" placeholder=\"홍길동\" autocomplete=\"name\">\n                  </label>\n                </div>\n                <p class=\"muted small\">기간: 예를 들어 25일로 하면 9/25 ~ 10/24 가 한 기간입니다. 없는 날짜(31일 등)는 그 달의 말일로 계산합니다.<br>내 이름: 이체 알림의 상대방이 내 이름이면 내 계좌끼리 옮긴 돈으로 보고 지출에서 뺍니다.</p>\n              </div>\n\n              <div class=\"card\" id=\"set-accounts\">\n                <div class=\"card-head\"><h2>계좌·카드</h2><button id=\"add-account\" class=\"ghost-btn small-btn\">+ 추가</button></div>\n                <p class=\"muted small\">번호는 <b>끝 4자리</b>만 넣으세요. 알림에 적힌 번호로 어느 계좌·카드의 거래인지 찾고, 은행 알림의 잔액으로 계좌 잔액을 자동으로 갱신합니다. <b>저축 계좌</b>로 옮긴 돈은 저축 항목 지출로 기록합니다.</p>\n                <div id=\"account-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-auto\"></div>\n\n              <div class=\"card\" id=\"set-data\">\n                <h2>데이터</h2>\n                <p id=\"data-note\" class=\"muted small\"></p>\n                <div class=\"row-actions\">\n                  <button id=\"export-btn\" class=\"ghost-btn\">백업 내보내기(JSON)</button>\n                  <label class=\"ghost-btn file-btn\">백업 불러오기<input type=\"file\" id=\"import-file\" accept=\"application/json,.json\" hidden></label>\n                  <button id=\"reset-btn\" class=\"danger-btn\">전체 초기화</button>\n                </div>\n              </div>\n            </div>\n          </div>\n        </section>\n      </div>\n    </div>\n\n    <!-- 휴대폰 하단 메뉴 -->\n    <nav class=\"bottom-nav\" aria-label=\"빠른 메뉴\">\n      <button data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n      <button data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n      <button data-page=\"add\" class=\"bn-add\" aria-label=\"입력\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n      <button data-open-menu><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg>전체</button>\n    </nav>\n  </div>\n\n  <div id=\"tooltip\" class=\"tooltip\" role=\"tooltip\" hidden></div>\n  <div id=\"toast\" class=\"toast\" hidden></div>\n\n  <script>/*__SERVER_CONFIG__*/</script>\n  <script>__budgetRun(\"js/logic.js\", \"LyoKICog7KeA7LacIOq0gOumrCDslbHsnZgg7Iic7IiYIOuhnOyngSAoRE9NIOyXhuydjCkuCiAqIOu4jOudvOyasOyggOyXkOyEnOuKlCB3aW5kb3cuQnVkZ2V0TG9naWMg7Jy866GcLCBOb2RlKO2FjOyKpO2KuCnsl5DshJzripQgcmVxdWlyZSDroZwg7IKs7Jqp7ZWc64ukLgogKiDrgqDsp5zripQg66qo65GQICdZWVlZLU1NLUREJyDrrLjsnpDsl7TroZwg64uk66Os64ukICjsi5zqsITrjIAg66y47KCcIO2ajO2UvCkuCiAqLwooZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHsKICBjb25zdCBhcGkgPSBmYWN0b3J5KCk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICBlbHNlIHJvb3QuQnVkZ2V0TG9naWMgPSBhcGk7Cn0pKHR5cGVvZiBnbG9iYWxUaGlzICE9PSAndW5kZWZpbmVkJyA/IGdsb2JhbFRoaXMgOiB0aGlzLCBmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICAvLyAtLS0tLS0tLS0tIOuCoOynnCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHBhZChuKSB7CiAgICByZXR1cm4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgfQoKICBmdW5jdGlvbiB0b0lTTyh5LCBtLCBkKSB7CiAgICByZXR1cm4gYCR7eX0tJHtwYWQobSl9LSR7cGFkKGQpfWA7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUlTTyhzKSB7CiAgICBjb25zdCBbeSwgbSwgZF0gPSBzLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyB5LCBtLCBkIH07CiAgfQoKICBmdW5jdGlvbiBkYXlzSW5Nb250aCh5LCBtKSB7CiAgICByZXR1cm4gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSwgMCkpLmdldFVUQ0RhdGUoKTsKICB9CgogIGZ1bmN0aW9uIGFkZE1vbnRocyh5LCBtLCBkZWx0YSkgewogICAgY29uc3QgaWR4ID0geSAqIDEyICsgKG0gLSAxKSArIGRlbHRhOwogICAgcmV0dXJuIHsgeTogTWF0aC5mbG9vcihpZHggLyAxMiksIG06IChpZHggJSAxMikgKyAxIH07CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGlzbywgZGVsdGEpIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gcGFyc2VJU08oaXNvKTsKICAgIGNvbnN0IGR0ID0gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSAtIDEsIGQgKyBkZWx0YSkpOwogICAgcmV0dXJuIHRvSVNPKGR0LmdldFVUQ0Z1bGxZZWFyKCksIGR0LmdldFVUQ01vbnRoKCkgKyAxLCBkdC5nZXRVVENEYXRlKCkpOwogIH0KCiAgZnVuY3Rpb24gZGlmZkRheXMoYSwgYikgewogICAgY29uc3QgcGEgPSBwYXJzZUlTTyhhKTsKICAgIGNvbnN0IHBiID0gcGFyc2VJU08oYik7CiAgICByZXR1cm4gTWF0aC5yb3VuZCgoRGF0ZS5VVEMocGIueSwgcGIubSAtIDEsIHBiLmQpIC0gRGF0ZS5VVEMocGEueSwgcGEubSAtIDEsIHBhLmQpKSAvIDg2NDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHRvZGF5SVNPKG5vdyA9IG5ldyBEYXRlKCkpIHsKICAgIHJldHVybiB0b0lTTyhub3cuZ2V0RnVsbFllYXIoKSwgbm93LmdldE1vbnRoKCkgKyAxLCBub3cuZ2V0RGF0ZSgpKTsKICB9CgogIC8vIOyLnOyekeydvOydtCDtlbTri7kg7JuU7JeQIOyXhuycvOuptCjsmIg6IDMx7J28KSDqt7gg64us7J2YIOunkOydvOuhnCDrp57stpjri6QuCiAgZnVuY3Rpb24gcGVyaW9kU3RhcnRJbk1vbnRoKHksIG0sIHN0YXJ0RGF5KSB7CiAgICByZXR1cm4gdG9JU08oeSwgbSwgTWF0aC5taW4oc3RhcnREYXksIGRheXNJbk1vbnRoKHksIG0pKSk7CiAgfQoKICBmdW5jdGlvbiBnZXRQZXJpb2QoZGF0ZUlTTywgc3RhcnREYXkpIHsKICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oZGF0ZUlTTyk7CiAgICBsZXQgc3RhcnQgPSBwZXJpb2RTdGFydEluTW9udGgoeSwgbSwgc3RhcnREYXkpOwogICAgbGV0IHN5ID0geTsKICAgIGxldCBzbSA9IG07CiAgICBpZiAoZGF0ZUlTTyA8IHN0YXJ0KSB7CiAgICAgICh7IHk6IHN5LCBtOiBzbSB9ID0gYWRkTW9udGhzKHksIG0sIC0xKSk7CiAgICAgIHN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKHN5LCBzbSwgc3RhcnREYXkpOwogICAgfQogICAgY29uc3QgbmV4dCA9IGFkZE1vbnRocyhzeSwgc20sIDEpOwogICAgY29uc3QgbmV4dFN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKG5leHQueSwgbmV4dC5tLCBzdGFydERheSk7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKG5leHRTdGFydCwgLTEpLCBrZXk6IHN0YXJ0IH07CiAgfQoKICBmdW5jdGlvbiBzaGlmdFBlcmlvZChwZXJpb2QsIGRlbHRhLCBzdGFydERheSkgewogICAgY29uc3QgeyB5LCBtIH0gPSBwYXJzZUlTTyhwZXJpb2Quc3RhcnQpOwogICAgY29uc3QgdCA9IGFkZE1vbnRocyh5LCBtLCBkZWx0YSk7CiAgICByZXR1cm4gZ2V0UGVyaW9kKHBlcmlvZFN0YXJ0SW5Nb250aCh0LnksIHQubSwgc3RhcnREYXkpLCBzdGFydERheSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4TsgrAgLS0tLS0tLS0tLQoKICAvKgogICAqIGNhdGVnb3JpZXM6IFt7IGlkLCBuYW1lLCB0eXBlOiAncmF0aW8nIHwgJ2ZpeGVkJywgdmFsdWUgfV0KICAgKiAgIHJhdGlvIOKGkiB2YWx1ZSDripQg7Y287IS87Yq4LCBmaXhlZCDihpIgdmFsdWUg64qUIOybkCDri6jsnIQg6riI7JWhCiAgICogcmF0aW9CYXNlOiAnaW5jb21lJyAgICAg4oaSIOu5hOycqCDtla3rqqnsnYAg7KCE7LK0IOyImOyehSDquLDspIAKICAgKiAgICAgICAgICAgICdhZnRlckZpeGVkJyDihpIg67mE7JyoIO2VreuqqeydgCAo7IiY7J6FIC0g6rOg7KCVIO2VreuqqSDtlanqs4QpIOq4sOykgAogICAqIGZpeGVkT3ZlcmZsb3c6IOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOyImOyeheuztOuLpCDtgbQg65WMCiAgICogICAgICAgICAgICAnd2FybicgIOKGkiDsoJXtlZwg6riI7JWhIOq3uOuMgOuhnCDrkZDqs6Ag7ZmU66m07JeQ7IScIOyVjOumsOuLpCAo6riw67O4KQogICAqICAgICAgICAgICAgJ3NjYWxlJyDihpIg6rOg7KCVIO2VreuqqeuBvOumrOydmCDruYTsnKjsnYQg7Jyg7KeA7ZWcIOyxhCDtlanqs4TqsIAg7IiY7J6F6rO8IOqwmeyVhOyngOuPhOuhnSDspITsnbjri6QKICAgKiDsiJjsnoXsnbQgMCjslYTsp4Eg7J6F66ClIOyViCDtlagp7J2066m0IOykhOydtOyngCDslYrripTri6QuCiAgICovCiAgZnVuY3Rpb24gY29tcHV0ZUJ1ZGdldHMoY2F0ZWdvcmllcywgaW5jb21lLCByYXRpb0Jhc2UsIGZpeGVkT3ZlcmZsb3cpIHsKICAgIGNvbnN0IGluYyA9IE1hdGgubWF4KDAsIE51bWJlcihpbmNvbWUpIHx8IDApOwogICAgY29uc3QgZml4ZWRDYXRzID0gY2F0ZWdvcmllcy5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gJ2ZpeGVkJyk7CiAgICBjb25zdCBmaXhlZFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIE1hdGgucm91bmQoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IHJhdGlvUGVyY2VudFRvdGFsID0gY2F0ZWdvcmllcwogICAgICAuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09ICdyYXRpbycpCiAgICAgIC5yZWR1Y2UoKHMsIGMpID0+IHMgKyAoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IGZpeGVkT3ZlciA9IGluYyA+IDAgPyBNYXRoLm1heCgwLCBmaXhlZFRvdGFsIC0gaW5jKSA6IDA7CiAgICBjb25zdCBmaXhlZFNjYWxlZCA9IGZpeGVkT3ZlcmZsb3cgPT09ICdzY2FsZScgJiYgZml4ZWRPdmVyID4gMDsKCiAgICBjb25zdCBidWRnZXRzID0ge307CiAgICBmb3IgKGNvbnN0IGMgb2YgZml4ZWRDYXRzKSBidWRnZXRzW2MuaWRdID0gTWF0aC5yb3VuZChOdW1iZXIoYy52YWx1ZSkgfHwgMCk7CiAgICBpZiAoZml4ZWRTY2FsZWQpIHsKICAgICAgLy8g67mE66GA7ZW07IScIOuCtOumvO2VnCDrkqQsIOuCqOydgCDrqocg7JuQ7J2AIOyGjOyImOygkCDslYTrnpjqsIAg7YGwIO2Vreuqqeu2gO2EsCAx7JuQ7JSpIOuNlO2VtCDtlanqs4Trpbwg7IiY7J6F6rO8IOygle2Zle2eiCDrp57stpjri6QKICAgICAgY29uc3QgcGFydHMgPSBmaXhlZENhdHMubWFwKChjKSA9PiB7CiAgICAgICAgY29uc3QgZXhhY3QgPSAoYnVkZ2V0c1tjLmlkXSAqIGluYykgLyBmaXhlZFRvdGFsOwogICAgICAgIHJldHVybiB7IGlkOiBjLmlkLCBmbG9vcjogTWF0aC5mbG9vcihleGFjdCksIGZyYWM6IGV4YWN0IC0gTWF0aC5mbG9vcihleGFjdCkgfTsKICAgICAgfSk7CiAgICAgIGxldCBsZWZ0ID0gaW5jIC0gcGFydHMucmVkdWNlKChzLCB4KSA9PiBzICsgeC5mbG9vciwgMCk7CiAgICAgIHBhcnRzLnNvcnQoKGEsIGIpID0+IGIuZnJhYyAtIGEuZnJhYyk7CiAgICAgIGZvciAoY29uc3QgeCBvZiBwYXJ0cykgewogICAgICAgIGJ1ZGdldHNbeC5pZF0gPSB4LmZsb29yICsgKGxlZnQgPiAwID8gMSA6IDApOwogICAgICAgIGlmIChsZWZ0ID4gMCkgbGVmdCAtPSAxOwogICAgICB9CiAgICB9CiAgICBjb25zdCBmaXhlZEJ1ZGdldFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIGJ1ZGdldHNbYy5pZF0sIDApOwogICAgY29uc3QgYmFzZSA9IHJhdGlvQmFzZSA9PT0gJ2FmdGVyRml4ZWQnID8gTWF0aC5tYXgoMCwgaW5jIC0gZml4ZWRCdWRnZXRUb3RhbCkgOiBpbmM7CgogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIHsKICAgICAgaWYgKGMudHlwZSAhPT0gJ2ZpeGVkJykgYnVkZ2V0c1tjLmlkXSA9IE1hdGgucm91bmQoKGJhc2UgKiAoTnVtYmVyKGMudmFsdWUpIHx8IDApKSAvIDEwMCk7CiAgICB9CiAgICBjb25zdCBhbGxvY2F0ZWQgPSBPYmplY3QudmFsdWVzKGJ1ZGdldHMpLnJlZHVjZSgocywgdikgPT4gcyArIHYsIDApOwogICAgcmV0dXJuIHsKICAgICAgYnVkZ2V0cywKICAgICAgZml4ZWRUb3RhbCwKICAgICAgZml4ZWRCdWRnZXRUb3RhbCwKICAgICAgZml4ZWRPdmVyLAogICAgICBmaXhlZFNjYWxlZCwKICAgICAgZml4ZWRTY2FsZTogZml4ZWRTY2FsZWQgPyBpbmMgLyBmaXhlZFRvdGFsIDogMSwKICAgICAgcmF0aW9QZXJjZW50VG90YWwsCiAgICAgIHJhdGlvQmFzZUFtb3VudDogYmFzZSwKICAgICAgYWxsb2NhdGVkLAogICAgICB1bmFsbG9jYXRlZDogaW5jIC0gYWxsb2NhdGVkLAogICAgfTsKICB9CgogIC8vIOqxsOuemCDsooXrpZg6IGV4cGVuc2Uo7KeA7LacLCDquLDrs7gpIC8gaW5jb21lKOyeheq4iCkgLyB0cmFuc2ZlcijrgrQg6rOE7KKM64G866asIOydtOyytCDigJQg7KeA7LacwrfsiJjsnoXsl5DshJwg7KCc7Jm4KQogIGZ1bmN0aW9uIGtpbmRPZih0KSB7CiAgICByZXR1cm4gdC5raW5kID09PSAnaW5jb21lJyB8fCB0LmtpbmQgPT09ICd0cmFuc2ZlcicgPyB0LmtpbmQgOiAnZXhwZW5zZSc7CiAgfQoKICBmdW5jdGlvbiB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKSB7CiAgICByZXR1cm4gc3RhdGUudHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gdC5kYXRlID49IHBlcmlvZC5zdGFydCAmJiB0LmRhdGUgPD0gcGVyaW9kLmVuZCk7CiAgfQoKICBmdW5jdGlvbiBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCkgewogICAgY29uc3QgcGxhbiA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZC5rZXkpOwogICAgY29uc3QgaW5jb21lID0gc3RhdGUuaW5jb21lc1twZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IGNvbXB1dGVCdWRnZXRzKHBsYW4uY2F0ZWdvcmllcywgaGFzSW5jb21lID8gaW5jb21lIDogMCwgcGxhbi5yYXRpb0Jhc2UsIHBsYW4uZml4ZWRPdmVyZmxvdyk7CiAgICBjb25zdCBhbGwgPSB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKTsKICAgIGNvbnN0IHR4cyA9IGFsbC5maWx0ZXIoKHQpID0+IGtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKTsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CgogICAgY29uc3Qgc3BlbnQgPSB7fTsKICAgIGNvbnN0IGNvdW50cyA9IHt9OwogICAgZm9yIChjb25zdCBjIG9mIHBsYW4uY2F0ZWdvcmllcykgewogICAgICBzcGVudFtjLmlkXSA9IDA7CiAgICAgIGNvdW50c1tjLmlkXSA9IDA7CiAgICB9CiAgICBsZXQgdW5jbGFzc2lmaWVkID0gMDsKICAgIGxldCB1bmNsYXNzaWZpZWRDb3VudCA9IDA7CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7CiAgICAgIGlmICh0LmNhdGVnb3J5SWQgJiYga25vd24uaGFzKHQuY2F0ZWdvcnlJZCkpIHsKICAgICAgICBzcGVudFt0LmNhdGVnb3J5SWRdICs9IHQuYW1vdW50OwogICAgICAgIGNvdW50c1t0LmNhdGVnb3J5SWRdICs9IDE7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdW5jbGFzc2lmaWVkICs9IHQuYW1vdW50OwogICAgICAgIHVuY2xhc3NpZmllZENvdW50ICs9IDE7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IHRvdGFsU3BlbnQgPSB0eHMucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgY29uc3QgaW5jb21lUmVjZWl2ZWQgPSBhbGwuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdpbmNvbWUnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CgogICAgY29uc3Qgcm93cyA9IHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IHsKICAgICAgY29uc3QgYnVkZ2V0ID0gY2FsYy5idWRnZXRzW2MuaWRdOwogICAgICBjb25zdCB1c2VkID0gc3BlbnRbYy5pZF07CiAgICAgIHJldHVybiB7CiAgICAgICAgY2F0ZWdvcnk6IGMsCiAgICAgICAgYnVkZ2V0LAogICAgICAgIHNwZW50OiB1c2VkLAogICAgICAgIGNvdW50OiBjb3VudHNbYy5pZF0sCiAgICAgICAgcmVtYWluaW5nOiBidWRnZXQgLSB1c2VkLAogICAgICAgIHJhdGlvOiBidWRnZXQgPiAwID8gdXNlZCAvIGJ1ZGdldCA6IHVzZWQgPiAwID8gSW5maW5pdHkgOiAwLAogICAgICB9OwogICAgfSk7CgogICAgLy8g6rOE7ZqN7J20IOuwlOuAkCDrkqTsl5Ag7JWE7KeBIOuLpOyLnCDrtoTrpZjrkJjsp4Ag7JWK7J2AICjsp4HsoJEg6rOg66W07KeAIOyViuydgCkg7KeA7LacCiAgICBjb25zdCBzdGFsZUNvdW50ID0gdHhzLmZpbHRlcigKICAgICAgKHQpID0+IHQubWV0aG9kICE9PSAnbWFudWFsJyAmJiAoIXQuY2xhc3NpZmllZEF0IHx8IChwbGFuLnVwZGF0ZWRBdCAmJiB0LmNsYXNzaWZpZWRBdCA8IHBsYW4udXBkYXRlZEF0KSkKICAgICkubGVuZ3RoOwoKICAgIHJldHVybiB7CiAgICAgIHBlcmlvZCwKICAgICAgcGxhbiwKICAgICAgc3RhbGVDb3VudCwKICAgICAgaW5jb21lOiBoYXNJbmNvbWUgPyBpbmNvbWUgOiBudWxsLAogICAgICBoYXNJbmNvbWUsCiAgICAgIC4uLmNhbGMsCiAgICAgIHJvd3MsCiAgICAgIHVuY2xhc3NpZmllZCwKICAgICAgdW5jbGFzc2lmaWVkQ291bnQsCiAgICAgIHRvdGFsU3BlbnQsCiAgICAgIGluY29tZVJlY2VpdmVkLAogICAgICByZW1haW5pbmc6IChoYXNJbmNvbWUgPyBpbmNvbWUgOiAwKSAtIHRvdGFsU3BlbnQsCiAgICAgIHRyYW5zYWN0aW9uczogdHhzLAogICAgICBhbGxUcmFuc2FjdGlvbnM6IGFsbCwKICAgIH07CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNPZihyYXRpbykgewogICAgaWYgKHJhdGlvID4gMSkgcmV0dXJuICdjcml0aWNhbCc7CiAgICBpZiAocmF0aW8gPj0gMC44KSByZXR1cm4gJ3dhcm5pbmcnOwogICAgcmV0dXJuICdnb29kJzsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6Q64+ZIOu2hOulmCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIG5vcm1hbGl6ZU1lcmNoYW50KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9ccysvZywgJycpOwogIH0KCiAgLy8gMSkg7KeB7KCRIOu2hOulmO2VtCDrkZQg6rCA66e57KCQKO2VmeyKtSkg4oaSIDIpIOqwgOyepSDquLQg7YKk7JuM65Oc6rCAIOydvOy5mO2VmOuKlCDtla3rqqkKICBmdW5jdGlvbiBjbGFzc2lmeShtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBub3JtID0gbm9ybWFsaXplTWVyY2hhbnQobWVtbyk7CiAgICBpZiAoIW5vcm0pIHJldHVybiBudWxsOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBsZWFybmVkID0gbWVyY2hhbnRNYXBbbm9ybV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiBsZWFybmVkOwoKICAgIGxldCBiZXN0ID0gbnVsbDsKICAgIGxldCBiZXN0TGVuID0gMDsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSB7CiAgICAgIGZvciAoY29uc3Qga3cgb2YgYy5rZXl3b3JkcyB8fCBbXSkgewogICAgICAgIGNvbnN0IGsgPSBub3JtYWxpemVNZXJjaGFudChrdyk7CiAgICAgICAgaWYgKGsgJiYgay5sZW5ndGggPiBiZXN0TGVuICYmIG5vcm0uaW5jbHVkZXMoaykpIHsKICAgICAgICAgIGJlc3QgPSBjLmlkOwogICAgICAgICAgYmVzdExlbiA9IGsubGVuZ3RoOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgcmV0dXJuIGJlc3Q7CiAgfQoKICAvLyBBSSDsl4bsnbQg67aE66WYOiB7IGNhdGVnb3J5SWQsIG1ldGhvZDogJ2xlYXJuZWQnIHwgJ2tleXdvcmQnIHwgbnVsbCB9CiAgZnVuY3Rpb24gY2xhc3NpZnlMb2NhbChtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGNvbnN0IGxlYXJuZWQgPSBtZXJjaGFudE1hcFtub3JtYWxpemVNZXJjaGFudChtZW1vKV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiB7IGNhdGVnb3J5SWQ6IGxlYXJuZWQsIG1ldGhvZDogJ2xlYXJuZWQnIH07CiAgICBjb25zdCBpZCA9IGNsYXNzaWZ5KG1lbW8sIGNhdGVnb3JpZXMsIHt9KTsKICAgIHJldHVybiBpZCA/IHsgY2F0ZWdvcnlJZDogaWQsIG1ldGhvZDogJ2tleXdvcmQnIH0gOiB7IGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9OwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsp4Dstpwg64K07JetIO2FjeyKpO2KuCDsnbjsi50gLS0tLS0tLS0tLQoKICBjb25zdCBOT0lTRV9QQVRURVJOUyA9IFsKICAgIC9cWz93ZWJccyrrsJzsi6BcXT8vZ2ksCiAgICAvXFtbXlxdXSpcXS9nLAogICAgLyjriITsoIF87J6U7JWhfOyelOqzoHztlZzrj4QpXHMqOj9ccyotP1tcZCxdK1xzKuybkD8vZywKICAgIC9cKD9ccyoo7J287Iuc67aIfO2VoOu2gFxzKlxkKlxzKuqwnD/sm5Q/fFxkK1xzKuqwnOyblClccypcKT8vZywKICAgIC9cKFxzKltcZCpdezMsNH1ccypcKS9nLCAvLyDsubTrk5wg64Gd7J6Q66asICgxMjM0KQogICAgL1wqXGR7Myw0fS9nLAogICAgL1xTXCpcUy9nLCAvLyDrp4jsiqTtgrnrkJwg7J2066aEIO2ZjSrrj5kKICAgIC9cZHsxLDJ9OlxkezJ9KDpcZHsyfSk/L2csIC8vIOyLnOqwgQogICAgLyjssrTtgax87Iug7JqpKT9ccyrsirnsnbgo7Leo7IaMKT8vZywKICAgIC/qsrDsoJwo7JmE66OMKT987IKs7JqpKOyZhOujjCk/fOy2nOq4iC9nLAogICAgLyhefFxzKVxTezEsNn3subTrk5woPz1cc3wkKS9nLCAvLyDsi6DtlZzsubTrk5wsIEtC6rWt66+87Lm065OcIC4uLgogIF07CgogIGZ1bmN0aW9uIGluZmVyWWVhcihtb250aCwgZGF5LCByZWZJU08pIHsKICAgIGNvbnN0IHJlZiA9IHBhcnNlSVNPKHJlZklTTyk7CiAgICBsZXQgeWVhciA9IHJlZi55OwogICAgLy8g6riw7KSA7J2867O064ukIO2VnOywuCDrr7jrnpjrnbzrqbQg7J6R64WEIOuCtOyXreycvOuhnCDrs7jri6QgKOyYiDogMeyblOyXkCAxMuyblCDrgrTsl60g67aZ7Jes64Sj6riwKQogICAgaWYgKGRpZmZEYXlzKHJlZklTTywgdG9JU08oeWVhciwgbW9udGgsIE1hdGgubWluKGRheSwgZGF5c0luTW9udGgoeWVhciwgbW9udGgpKSkpID4gNykgeWVhciAtPSAxOwogICAgcmV0dXJuIHllYXI7CiAgfQoKICBmdW5jdGlvbiB2YWxpZERhdGUoeSwgbSwgZCkgewogICAgcmV0dXJuIG0gPj0gMSAmJiBtIDw9IDEyICYmIGQgPj0gMSAmJiBkIDw9IGRheXNJbk1vbnRoKHksIG0pOwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdERhdGUobGluZSwgcmVmSVNPKSB7CiAgICBsZXQgbSA9IGxpbmUubWF0Y2goLygyMFxkezJ9KVxzKlsuXC0v64WEXVxzKihcZHsxLDJ9KVxzKlsuXC0v7JuUXVxzKihcZHsxLDJ9KVxzKuydvD8vKTsKICAgIGlmIChtKSB7CiAgICAgIGNvbnN0IFt5LCBtbywgZF0gPSBbTnVtYmVyKG1bMV0pLCBOdW1iZXIobVsyXSksIE51bWJlcihtWzNdKV07CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCAnICcpIH07CiAgICB9CiAgICAvLyDslZ7sl5Ag7Iir7J6QwrfsibztkZzqsIAg7JeG64qUIDA5LzI4IOqwmeydgCDrgqDsp5wuICjsmKTrnpjrkJwgaU9TIOyCrO2MjOumrOqwgCDsoJXqt5zsi50gbG9va2JlaGluZCDrpbwg66q7IOydveyWtOyEnAogICAgLy8g7JWeIOq4gOyekOulvCDqt7jro7nsnLzroZwg7J6h6rOgIOuQmOuPjOugpCDrhpPripTri6QpCiAgICBsZXQga2VlcCA9ICcnOwogICAgbSA9IGxpbmUubWF0Y2goLyhcZHsxLDJ9KVxzKuyblFxzKihcZHsxLDJ9KVxzKuydvC8pOwogICAgaWYgKCFtKSB7CiAgICAgIGNvbnN0IG1tID0gbGluZS5tYXRjaCgvKF58W15cZCxdKShcZHsxLDJ9KVsvLlwtXShcZHsxLDJ9KSg/IVtcZCxdKS8pOwogICAgICBpZiAobW0pIHsKICAgICAgICBrZWVwID0gbW1bMV07CiAgICAgICAgbSA9IFttbVswXSwgbW1bMl0sIG1tWzNdXTsKICAgICAgfQogICAgfQogICAgaWYgKG0pIHsKICAgICAgY29uc3QgW21vLCBkXSA9IFtOdW1iZXIobVsxXSksIE51bWJlcihtWzJdKV07CiAgICAgIGNvbnN0IHkgPSBpbmZlclllYXIobW8sIGQsIHJlZklTTyk7CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrZWVwfSBgKSB9OwogICAgfQogICAgcmV0dXJuIHsgZGF0ZTogbnVsbCwgcmVzdDogbGluZSB9OwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdEFtb3VudChsaW5lKSB7CiAgICAvLyBb7KCV6rec7IudLCDquIjslaEg6re466O5LCDrkJjrj4zroKQg64aT7J2EIOyVniDquIDsnpAg6re466O5XQogICAgY29uc3QgcGF0dGVybnMgPSBbCiAgICAgIFsvKC0/XGRbXGQsXSopXHMq7JuQLywgMSwgMF0sIC8vIDEyLDAwMOybkAogICAgICBbLygtP1xkezEsM30oPzosXGR7M30pKykoPyFcZCkvLCAxLCAwXSwgLy8gMTIsMDAwCiAgICAgIFsvKF58XEQpKC0/XGR7Myx9KSg/IVxkKS8sIDIsIDFdLCAvLyAxMjAwMAogICAgXTsKICAgIGZvciAoY29uc3QgW3AsIGcsIGtdIG9mIHBhdHRlcm5zKSB7CiAgICAgIGNvbnN0IG0gPSBsaW5lLm1hdGNoKHApOwogICAgICBpZiAobSkgewogICAgICAgIGNvbnN0IG4gPSBOdW1iZXIobVtnXS5yZXBsYWNlKC8sL2csICcnKSk7CiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShuKSAmJiBuICE9PSAwKSByZXR1cm4geyBhbW91bnQ6IG4sIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrID8gbVtrXSA6ICcnfSBgKSB9OwogICAgICB9CiAgICB9CiAgICByZXR1cm4geyBhbW91bnQ6IG51bGwsIHJlc3Q6IGxpbmUgfTsKICB9CgogIGZ1bmN0aW9uIGNsZWFuTWVtbyhzKSB7CiAgICBsZXQgb3V0ID0gczsKICAgIGZvciAoY29uc3QgcCBvZiBOT0lTRV9QQVRURVJOUykgb3V0ID0gb3V0LnJlcGxhY2UocCwgJyAnKTsKICAgIHJldHVybiBvdXQKICAgICAgLnJlcGxhY2UoL1tcdCx8O10rL2csICcgJykKICAgICAgLnJlcGxhY2UoL15bXHNcLTrCty8oKV0rfFtcc1wtOsK3LygpXSskL2csICcnKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgICAgLnRyaW0oKTsKICB9CgogIC8qCiAgICog7Jes65+sIOykhOydmCDthY3siqTtirgo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDrgrTsl60sIOyXkeyFgCDrs7Xsgqwg65OxKeyXkOyEnCDsp4DstpzsnYQg672R7JWE64K464ukLgogICAqIOuwmO2ZmDogeyBpdGVtczogW3sgZGF0ZSwgYW1vdW50LCBtZW1vLCByYXcgfV0sIHNraXBwZWQ6IFtyYXcuLi5dIH0KICAgKi8KICBmdW5jdGlvbiBwYXJzZUV4cGVuc2VUZXh0KHRleHQsIHJlZklTTykgewogICAgY29uc3QgaXRlbXMgPSBbXTsKICAgIGNvbnN0IHNraXBwZWQgPSBbXTsKICAgIGZvciAoY29uc3QgcmF3TGluZSBvZiBTdHJpbmcodGV4dCB8fCAnJykuc3BsaXQoL1xyP1xuLykpIHsKICAgICAgY29uc3QgcmF3ID0gcmF3TGluZS50cmltKCk7CiAgICAgIGlmICghcmF3KSBjb250aW51ZTsKICAgICAgY29uc3QgaXNDYW5jZWwgPSAv7Leo7IaMfO2ZmOu2iC8udGVzdChyYXcpOwogICAgICAvLyDriITsoIEv7J6U7JWhIOq4iOyVoeydtCDqsrDsoJwg6riI7JWh7Jy866GcIOyeoe2eiOyngCDslYrrj4TroZ0g66i87KCAIOygnOqxsAogICAgICBsZXQgd29yayA9IHJhdwogICAgICAgIC5yZXBsYWNlKC8o64iE7KCBfOyelOyVoXzsnpTqs6B87ZWc64+EKVxzKjo/XHMqLT9bXGQsXStccyrsm5A/L2csICcgJykKICAgICAgICAucmVwbGFjZSgvXGR7MSwyfTpcZHsyfSg6XGR7Mn0pPy9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1woXHMqW1xkKl17Myw0fVxzKlwpfFwqXGR7Myw0fS9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1x0L2csICcgJyk7CiAgICAgIGNvbnN0IGQgPSBleHRyYWN0RGF0ZSh3b3JrLCByZWZJU08pOwogICAgICB3b3JrID0gZC5yZXN0OwogICAgICBjb25zdCBhID0gZXh0cmFjdEFtb3VudCh3b3JrKTsKICAgICAgaWYgKGEuYW1vdW50ID09PSBudWxsKSB7CiAgICAgICAgc2tpcHBlZC5wdXNoKHJhdyk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgbGV0IGFtb3VudCA9IE1hdGguYWJzKGEuYW1vdW50KTsKICAgICAgaWYgKGlzQ2FuY2VsIHx8IGEuYW1vdW50IDwgMCkgYW1vdW50ID0gLWFtb3VudDsKICAgICAgY29uc3QgbWVtbyA9IGNsZWFuTWVtbyhhLnJlc3QucmVwbGFjZSgv7Leo7IaMfO2ZmOu2iC9nLCAnICcpKSB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgICAgaXRlbXMucHVzaCh7IGRhdGU6IGQuZGF0ZSB8fCByZWZJU08sIGFtb3VudCwgbWVtbywgcmF3IH0pOwogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQgfTsKICB9CgogIGZ1bmN0aW9uIGlzRHVwbGljYXRlKGl0ZW0sIHRyYW5zYWN0aW9ucykgewogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5zb21lKAogICAgICAodCkgPT4gdC5kYXRlID09PSBpdGVtLmRhdGUgJiYgdC5hbW91bnQgPT09IGl0ZW0uYW1vdW50ICYmIG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgPT09IG5vcm1hbGl6ZU1lcmNoYW50KGl0ZW0ubWVtbykKICAgICk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOqysOygnMK37J6F7Lac6riIIOyVjOumvCAo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDslYzrprwpIC0tLS0tLS0tLS0KCiAgLy8g6rGw656YIOyVjOumvOyymOufvCDrs7TsnbTripQg6riA7J247KeAICjsnbjspp3rsojtmLgsIOq0keqzoCDrk7HsnYAg7KCc7Jm4KQogIGZ1bmN0aW9uIGxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpIHsKICAgIGNvbnN0IHQgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBpZiAoIS9bXGQsXStccyrsm5AvLnRlc3QodCkpIHJldHVybiBmYWxzZTsKICAgIGlmICgv7J247KadXHMq67KI7Zi4fOyduOymney9lOuTnC8udGVzdCh0KSkgcmV0dXJuIGZhbHNlOwogICAgcmV0dXJuIC/sirnsnbh86rKw7KCcfOyCrOyaqXzst6jshox87Lac6riIfOyeheq4iHzsnbTssrR87Iah6riIfOuztOuDiHzrsJvslZgvLnRlc3QodCk7CiAgfQoKICBmdW5jdGlvbiBkaWdpdHNPbmx5KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvXEQvZywgJycpOwogIH0KCiAgLy8g7JWM66a87JeQIOygge2ejCDqs4TsoozCt+y5tOuTnCDrsojtmLgo6rCA66Ck7KeEIOuyiO2YuCDtj6ztlagp7J2YIOuBneyekOumrOuhnCDrk7HroZ3rkJwg6rOE7KKML+y5tOuTnOulvCDssL7ripTri6QKICBmdW5jdGlvbiBtYXRjaEFjY291bnQodGV4dCwgYWNjb3VudHMpIHsKICAgIGNvbnN0IGNodW5rcyA9IFN0cmluZyh0ZXh0IHx8ICcnKS5tYXRjaCgvW1xkKl1bXGQqXC1dezIsfS9nKSB8fCBbXTsKICAgIGZvciAoY29uc3QgYSBvZiBhY2NvdW50cyB8fCBbXSkgewogICAgICBjb25zdCBsYXN0NCA9IGRpZ2l0c09ubHkoYS5sYXN0NCkuc2xpY2UoLTQpOwogICAgICBpZiAobGFzdDQubGVuZ3RoIDwgMykgY29udGludWU7CiAgICAgIGZvciAoY29uc3QgYyBvZiBjaHVua3MpIHsKICAgICAgICBpZiAoL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoYykpIGNvbnRpbnVlOyAvLyDrgqDsp5wKICAgICAgICBpZiAoZGlnaXRzT25seShjKS5lbmRzV2l0aChsYXN0NCkpIHJldHVybiBhOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIGZ1bmN0aW9uIGFjY291bnRCeUxhc3Q0KGxhc3Q0LCBhY2NvdW50cykgewogICAgY29uc3QgZCA9IGRpZ2l0c09ubHkobGFzdDQpLnNsaWNlKC00KTsKICAgIGlmIChkLmxlbmd0aCA8IDMpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChhY2NvdW50cyB8fCBbXSkuZmluZCgoYSkgPT4gZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCkgPT09IGQpIHx8IG51bGw7CiAgfQoKICAvLyBBSSDsl4bsnbQg7JWM66a87J2EIOydveydhCDrlYwg6rGw656YIOyiheulmCDstpTsuKEKICBmdW5jdGlvbiBkZXRlY3RLaW5kKHRleHQsIG15TmFtZSkgewogICAgY29uc3QgdCA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgv7Iq57J24fOqysOygnC8udGVzdCh0KSkgcmV0dXJuICdleHBlbnNlJzsKICAgIGlmIChteU5hbWUgJiYgdC5pbmNsdWRlcyhteU5hbWUpICYmIC/snbTssrR87Lac6riIfOyGoeq4iHzrs7Trg4h87J6F6riIfOuwm+yVmC8udGVzdCh0KSkgcmV0dXJuICd0cmFuc2Zlcic7CiAgICBpZiAoL+yeheq4iHzrsJvslZgvLnRlc3QodCkgJiYgIS/stpzquIgvLnRlc3QodCkpIHJldHVybiAnaW5jb21lJzsKICAgIHJldHVybiAnZXhwZW5zZSc7CiAgfQoKICAvLyBBSSDrpbwg7JO4IOyImCDsl4bsnYQg65WM7J2YIOyVjOumvCDsnbjsi50uIOyXrOufrCDspIQg7JWM66a87J2EIO2VnCDspITroZwg7ZWp7LOQ7IScIOydveuKlOuLpC4KICAvLyDrsJjtmZg6IHsgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGJhbGFuY2UgfSDrmJDripQgbnVsbAogIGZ1bmN0aW9uIHBhcnNlTWVzc2FnZUZhbGxiYWNrKHRleHQsIHJlZklTTywgb3B0cyA9IHt9KSB7CiAgICBpZiAoIWxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGJhbGFuY2VNYXRjaCA9IFN0cmluZyh0ZXh0KS5tYXRjaCgv7J6U7JWhXHMqOj9ccyooW1xkLF0rKVxzKuybkD8vKTsKICAgIGNvbnN0IGFjY291bnQgPSBtYXRjaEFjY291bnQodGV4dCwgb3B0cy5hY2NvdW50cyk7CiAgICBjb25zdCBvbmVMaW5lID0gU3RyaW5nKHRleHQpCiAgICAgIC5yZXBsYWNlKC9ccj9cbi9nLCAnICcpCiAgICAgIC5yZXBsYWNlKC8oPzpbXGRcLV0rXCorfFwqK1tcZFwtXSspW1xkKlwtXSp8XGR7Myx9LVxkezIsfS1cZHszLH0vZywgJyAnKSAvLyDqsIDroKTsp4Qg67KI7Zi4LCDqs4TsoozrsojtmLgKICAgICAgLnJlcGxhY2UoL+yeheq4iHzsnbTssrR87Iah6riIfOuztOuDiOyWtOyalHzrsJvslZjslrTsmpR864uY7JeQ6rKMfOuLmOydtC9nLCAnICcpOwogICAgY29uc3QgeyBpdGVtcyB9ID0gcGFyc2VFeHBlbnNlVGV4dChvbmVMaW5lLCByZWZJU08pOwogICAgY29uc3QgaXRlbSA9IGl0ZW1zWzBdOwogICAgaWYgKCFpdGVtKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGtpbmQgPSBkZXRlY3RLaW5kKHRleHQsIG9wdHMubXlOYW1lKTsKICAgIHJldHVybiB7CiAgICAgIGRhdGU6IGl0ZW0uZGF0ZSwKICAgICAgYW1vdW50OiBraW5kID09PSAnZXhwZW5zZScgPyBpdGVtLmFtb3VudCA6IE1hdGguYWJzKGl0ZW0uYW1vdW50KSwKICAgICAgbWVtbzogaXRlbS5tZW1vLAogICAgICBraW5kLAogICAgICBhY2NvdW50SWQ6IGFjY291bnQgPyBhY2NvdW50LmlkIDogbnVsbCwKICAgICAgYmFsYW5jZTogYmFsYW5jZU1hdGNoID8gTnVtYmVyKGJhbGFuY2VNYXRjaFsxXS5yZXBsYWNlKC8sL2csICcnKSkgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6riw6rCE67OEIOyekOyCsOq0gOumrOqzhO2ajSAtLS0tLS0tLS0tCgogIGNvbnN0IEJBU0VfUExBTl9GUk9NID0gJzAwMDAtMDEtMDEnOwoKICAvLyDtlbTri7kg6riw6rCE7JeQIOyggeyaqeuQmOuKlCDqs4Ttmo06IOyLnOyekeydvOydtCDqt7gg6riw6rCEIOydtOyghOyduCDqs4Ttmo0g7KSRIOqwgOyepSDstZzqt7wg6rKDCiAgZnVuY3Rpb24gcGxhbkZvcihzdGF0ZSwgcGVyaW9kS2V5KSB7CiAgICBjb25zdCBwbGFucyA9IHN0YXRlLnBsYW5zOwogICAgbGV0IGZvdW5kID0gcGxhbnNbMF07CiAgICBmb3IgKGNvbnN0IHAgb2YgcGxhbnMpIGlmIChwLmZyb20gPD0gcGVyaW9kS2V5KSBmb3VuZCA9IHA7CiAgICByZXR1cm4gZm91bmQ7CiAgfQoKICAvLyDrr7jrtoTrpZggPSDsp4DstpzsnbjrjbAg7ZWt66qp7J20IOyXhuqxsOuCmCwg6re4IOuCoOynnOqwgCDsho3tlZwg6riw6rCE7J2YIOqzhO2ajeyXkCDsl4bripQg7ZWt66qp7J24IOqygwogIGZ1bmN0aW9uIGlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSB7CiAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yKHN0YXRlLCBnZXRQZXJpb2QodC5kYXRlLCBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KS5jYXRlZ29yaWVzOwogICAgcmV0dXJuICEodC5jYXRlZ29yeUlkICYmIGNhdHMuc29tZSgoYykgPT4gYy5pZCA9PT0gdC5jYXRlZ29yeUlkKSk7CiAgfQoKICAvLyDquLDqsITrs4Qg66+467aE66WYIOqxtOyImDogW3sgcGVyaW9kLCBjb3VudCwgdG90YWwgfV0g7LWc6re8IOq4sOqwhOu2gO2EsAogIGZ1bmN0aW9uIHVuY2xhc3NpZmllZEJ5UGVyaW9kKHN0YXRlKSB7CiAgICBjb25zdCBieUtleSA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgdCBvZiBzdGF0ZS50cmFuc2FjdGlvbnMpIHsKICAgICAgaWYgKCFpc1VuY2xhc3NpZmllZChzdGF0ZSwgdCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBwID0gZ2V0UGVyaW9kKHQuZGF0ZSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICBpZiAoIWJ5S2V5LmhhcyhwLmtleSkpIGJ5S2V5LnNldChwLmtleSwgeyBwZXJpb2Q6IHAsIGNvdW50OiAwLCB0b3RhbDogMCB9KTsKICAgICAgY29uc3QgZSA9IGJ5S2V5LmdldChwLmtleSk7CiAgICAgIGUuY291bnQgKz0gMTsKICAgICAgZS50b3RhbCArPSB0LmFtb3VudDsKICAgIH0KICAgIHJldHVybiBbLi4uYnlLZXkudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IChhLnBlcmlvZC5rZXkgPCBiLnBlcmlvZC5rZXkgPyAxIDogLTEpKTsKICB9CgogIC8vIOuvuOu2hOulmCDsp4DstpzsnYQg6rCA66e57KCQKOyDgeuMgOuwqSnrs4TroZwg66y264qU64ukLiBwZXJpb2Qg66W8IOyjvOuptCDqt7gg6riw6rCEIOqyg+unjC4g7LWc6re87JeQIOyDneq4tCDrrLbsnYzrtoDthLAuCiAgZnVuY3Rpb24gdW5jbGFzc2lmaWVkR3JvdXBzKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IGJ5S2V5ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCB0IG9mIHN0YXRlLnRyYW5zYWN0aW9ucykgewogICAgICBpZiAocGVyaW9kICYmICh0LmRhdGUgPCBwZXJpb2Quc3RhcnQgfHwgdC5kYXRlID4gcGVyaW9kLmVuZCkpIGNvbnRpbnVlOwogICAgICBpZiAoIWlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSkgY29udGludWU7CiAgICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgfHwgdC5tZW1vOwogICAgICBpZiAoIWJ5S2V5LmhhcyhrZXkpKSBieUtleS5zZXQoa2V5LCB7IGtleSwgbWVtbzogdC5tZW1vLCBpdGVtczogW10sIHRvdGFsOiAwLCBsYXRlc3Q6ICcnIH0pOwogICAgICBjb25zdCBnID0gYnlLZXkuZ2V0KGtleSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgICAgZy50b3RhbCArPSB0LmFtb3VudDsKICAgICAgaWYgKHQuZGF0ZSA+IGcubGF0ZXN0KSBnLmxhdGVzdCA9IHQuZGF0ZTsKICAgIH0KICAgIGNvbnN0IGdyb3VwcyA9IFsuLi5ieUtleS52YWx1ZXMoKV07CiAgICBmb3IgKGNvbnN0IGcgb2YgZ3JvdXBzKSBnLml0ZW1zLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBncm91cHMuc29ydCgoYSwgYikgPT4gKGEubGF0ZXN0IDwgYi5sYXRlc3QgPyAxIDogYS5sYXRlc3QgPiBiLmxhdGVzdCA/IC0xIDogYi50b3RhbCAtIGEudG90YWwpKTsKICAgIHJldHVybiBncm91cHM7CiAgfQoKICAvLyDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDqs4Ttmo3snYQg7IiY7KCV7ZWY66Ck6rOgIO2VoCDrlYwg7Zi47LacLiDsl4bsnLzrqbQg7KeB7KCEIOqzhO2ajeydhCDrs7XsgqztlbTshJwg66eM65Og64ukLgogIGZ1bmN0aW9uIGVuc3VyZVBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSwgbm93SVNPKSB7CiAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLnBsYW5zLmZpbmQoKHApID0+IHAuZnJvbSA9PT0gcGVyaW9kS2V5KTsKICAgIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nOwogICAgY29uc3QgYmFzZSA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSk7CiAgICBjb25zdCBjb3B5ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShiYXNlKSk7CiAgICBjb3B5LmZyb20gPSBwZXJpb2RLZXk7CiAgICBjb3B5LnVwZGF0ZWRBdCA9IG5vd0lTTzsKICAgIHN0YXRlLnBsYW5zLnB1c2goY29weSk7CiAgICBzdGF0ZS5wbGFucy5zb3J0KChhLCBiKSA9PiAoYS5mcm9tIDwgYi5mcm9tID8gLTEgOiBhLmZyb20gPiBiLmZyb20gPyAxIDogMCkpOwogICAgcmV0dXJuIGNvcHk7CiAgfQoKICBmdW5jdGlvbiBuZXh0UGxhbkFmdGVyKHN0YXRlLCBwbGFuKSB7CiAgICByZXR1cm4gc3RhdGUucGxhbnMuZmluZCgocCkgPT4gcC5mcm9tID4gcGxhbi5mcm9tKSB8fCBudWxsOwogIH0KCiAgLy8g7Iuc7J6R7J287J2EIOuwlOq+uOuptCDquLDqsIQg7YKkKOyLnOyekSDrgqDsp5wp66W8IOqwmeydgCDri6zsnZgg7IOIIOyLnOyekeydvOuhnCDsmK7quLTri6QuCiAgZnVuY3Rpb24gcmVtYXBQZXJpb2RLZXlzKHN0YXRlLCBuZXdTdGFydERheSkgewogICAgY29uc3QgbW92ZSA9IChrZXkpID0+IHsKICAgICAgaWYgKGtleSA9PT0gQkFTRV9QTEFOX0ZST00pIHJldHVybiBrZXk7CiAgICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oa2V5KTsKICAgICAgcmV0dXJuIHRvSVNPKHksIG0sIE1hdGgubWluKG5ld1N0YXJ0RGF5LCBkYXlzSW5Nb250aCh5LCBtKSkpOwogICAgfTsKICAgIGNvbnN0IGluY29tZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLmluY29tZXMpKSBpbmNvbWVzW21vdmUoayldID0gdjsKICAgIHN0YXRlLmluY29tZXMgPSBpbmNvbWVzOwogICAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBsYW5zKSBwLmZyb20gPSBtb3ZlKHAuZnJvbSk7CiAgICBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSA9IG5ld1N0YXJ0RGF5OwogIH0KCiAgLy8gLS0tLS0tLS0tLSBBSSDrtoTrpZgg7JqU7LKtIOunjOuTpOq4sCAvIOqysOqzvCDsnb3quLAgLS0tLS0tLS0tLQogIC8vIOyLpOygnCBBUEkg7Zi47Lac7J2AIOyEnOuyhChBcHBzIFNjcmlwdCnsl5DshJwg7ZWc64ukLiDsl6zquLDshJzripQg7ZSE66Gs7ZSE7Yq47JmAIEpTT04g7Iqk7YKk66eI66eMIOunjOuToOuLpC4KCiAgZnVuY3Rpb24gY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCkgewogICAgY29uc3QgZXhhbXBsZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW21lcmNoYW50LCBpZF0gb2YgT2JqZWN0LmVudHJpZXMobWVyY2hhbnRNYXAgfHwge30pKSB7CiAgICAgIChleGFtcGxlc1tpZF0gPSBleGFtcGxlc1tpZF0gfHwgW10pLnB1c2gobWVyY2hhbnQpOwogICAgfQogICAgcmV0dXJuIGNhdGVnb3JpZXMubWFwKChjKSA9PiAoewogICAgICBpZDogYy5pZCwKICAgICAgbmFtZTogYy5uYW1lLAogICAgICBkZXNjcmlwdGlvbjogYy5kZXNjcmlwdGlvbiB8fCAnJywKICAgICAga2V5d29yZHM6IChjLmtleXdvcmRzIHx8IFtdKS5zbGljZSgwLCAyMCksCiAgICAgIGV4YW1wbGVzOiAoZXhhbXBsZXNbYy5pZF0gfHwgW10pLnNsaWNlKC0xMCksCiAgICB9KSk7CiAgfQoKICBjb25zdCBDTEFTU0lGWV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1reyWtCDqsIDqs4TrtoDsnZgg7KeA7LacIOu2hOulmOq4sOyeheuLiOuLpC4nLAogICAgJ+yCrOyaqeyekOqwgCDsoJXtlbQg65GUIOyekOyCsOq0gOumrOqzhO2ajSDtla3rqqkg66qp66Gd7J20IOyjvOyWtOyngOuptCwg6rCBIOyngOy2nOydhCDqsIDsnqUg7JWM66ee7J2AIO2VreuqqSBpZCDtlZjrgpjroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAn7ZWt66qp7J2YIOydtOumhCwg7ISk66qFLCDtgqTsm4zrk5wsIOyCrOyaqeyekOqwgCDsmIjsoITsl5Ag7KeB7KCRIOu2hOulmO2VnCDqsIDrp7nsoJAg7JiI7IucKGV4YW1wbGVzKeulvCDqt7zqsbDroZwg7YyQ64uo7ZWp64uI64ukLicsCiAgICAn6rCA66e57KCQIOydtOumhOunjOycvOuhnCDsl4XsooXsnYQg7LaU66Gg7ZW064+EIOuQqeuLiOuLpC4g7Ja064qQIO2VreuqqeyXkOuPhCDrp57sp4Ag7JWK6rGw64KYIOuPhOyggO2eiCDtjJDri6jtlaAg7IiYIOyXhuycvOuptCAibm9uZSLsnYQg6rOg66W07IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZENsYXNzaWZ5UmVxdWVzdChjYXRlZ29yaWVzLCBpdGVtcywgbWVyY2hhbnRNYXApIHsKICAgIGNvbnN0IGlkcyA9IGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKTsKICAgIGNvbnN0IHVzZXIgPSBKU09OLnN0cmluZ2lmeSh7CiAgICAgIGNhdGVnb3JpZXM6IGNhdGVnb3J5QnJpZWYoY2F0ZWdvcmllcywgbWVyY2hhbnRNYXApLAogICAgICBleHBlbnNlczogaXRlbXMubWFwKChpdCwgaSkgPT4gKHsgaW5kZXg6IGksIG1lcmNoYW50OiBpdC5tZW1vLCBhbW91bnQ6IGl0LmFtb3VudCwgZGF0ZTogaXQuZGF0ZSB9KSksCiAgICB9KTsKICAgIGNvbnN0IHNjaGVtYSA9IHsKICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICByZXN1bHRzOiB7CiAgICAgICAgICB0eXBlOiAnYXJyYXknLAogICAgICAgICAgaXRlbXM6IHsKICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgICAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICAgICAgICBpbmRleDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICAgICAgICBjYXRlZ29yeUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBlbnVtOiBpZHMuY29uY2F0KFsnbm9uZSddKSB9LAogICAgICAgICAgICB9LAogICAgICAgICAgICByZXF1aXJlZDogWydpbmRleCcsICdjYXRlZ29yeUlkJ10sCiAgICAgICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSwKICAgICAgICAgIH0sCiAgICAgICAgfSwKICAgICAgfSwKICAgICAgcmVxdWlyZWQ6IFsncmVzdWx0cyddLAogICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsCiAgICB9OwogICAgcmV0dXJuIHsgc3lzdGVtOiBDTEFTU0lGWV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiBpdGVtcyDsmYAg6rCZ7J2AIOq4uOydtOydmCBjYXRlZ29yeUlkIOuwsOyXtCAo7JWMIOyImCDsl4bsnLzrqbQgbnVsbCkKICBmdW5jdGlvbiByZWFkQ2xhc3NpZnlSZXNwb25zZShqc29uLCBjYXRlZ29yaWVzLCBjb3VudCkgewogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBvdXQgPSBuZXcgQXJyYXkoY291bnQpLmZpbGwobnVsbCk7CiAgICBmb3IgKGNvbnN0IHIgb2YgKGpzb24gJiYganNvbi5yZXN1bHRzKSB8fCBbXSkgewogICAgICBpZiAoTnVtYmVyLmlzSW50ZWdlcihyLmluZGV4KSAmJiByLmluZGV4ID49IDAgJiYgci5pbmRleCA8IGNvdW50ICYmIGtub3duLmhhcyhyLmNhdGVnb3J5SWQpKSB7CiAgICAgICAgb3V0W3IuaW5kZXhdID0gci5jYXRlZ29yeUlkOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgTUVTU0FHRV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1rSDsubTrk5zsgqzCt+ydgO2WieydmCDqsrDsoJwv7J6F7Lac6riIIOyVjOumvCjrrLjsnpAg65iQ64qUIOyVsSDslYzrprwp7J2EIOydveyWtCDqsIDqs4TrtoDsl5Ag6riw66Gd7ZWY64qUIOuPhOyasOuvuOyeheuLiOuLpC4nLAogICAgJ+yVjOumvOyXkOyEnCDqsbDrnpgg7KKF66WYLCDrgqDsp5wsIOq4iOyVoSjsm5ApLCDqsIDrp7nsoJAg65iQ64qUIOyDgeuMgOuwqSDsnbTrpoQsIOyelOyVoeydhCDrvZHqs6AsIOyngOy2nOydtOuptCDsgqzsmqnsnpDsnZgg7J6Q7IKw6rSA66as6rOE7ZqNIO2VreuqqSDspJEg7JWM66ee7J2AIO2VreuqqSBpZCDroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAnJywKICAgICdraW5kIOq3nOy5mTonLAogICAgJy0gZXhwZW5zZTog7Lm065OcIOqysOygnCwg6rOE7KKM7JeQ7IScIOuLpOuluCDsgqzrnozCt+qwgOqyjOuhnCDrs7Trgrgg7Lac6riIL+ydtOyytCwg7J6Q64+Z7J207LK0LCDqs7Xqs7zquIgnLAogICAgJy0gaW5jb21lOiDri6Trpbgg7IKs656M7J2064KYIO2ajOyCrOyXkOyEnCDrk6TslrTsmKgg7J6F6riIICjquInsl6wsIO2ZmOq4iSDrk7EpJywKICAgICctIG93bl90cmFuc2Zlcjog7IKs7Jqp7J6QIOuzuOyduCDqs4Tsoozrgbzrpqwg7Jiu6ri0IOuPiC4g7IOB64yA67CpIOydtOumhOydtCDsgqzsmqnsnpAg7J2066aEKG15X25hbWUp6rO8IOqwmeqxsOuCmCwg7JWM66a87J2YIOyDgeuMgCDqs4TsoozqsIAg7IKs7Jqp7J6Q7J2YIOuTseuhnSDqs4TsoowoYWNjb3VudHMp7J2066m0IO2VtOuLue2VqeuLiOuLpC4nLAogICAgJy0gbm90X3RyYW5zYWN0aW9uOiDsnbjspp3rsojtmLgsIOq0keqzoCwg7JWI64K0IOuTsSDqsbDrnpjqsIAg7JWE64uMIOyVjOumvCcsCiAgICAnJywKICAgICctIOuzuOyduCDqs4TsoozroZwg7Jiu6ri0IOuPiOydtCDsoIDstpUg6rOE7KKMKGlzU2F2aW5ncynrgpgg7KCB6riIwrfssq3slb3Ct+ymneq2jCDqs4TsoozroZwg65Ok7Ja06rCA64qUIOy2nOq4iOydtOuptCB0b19zYXZpbmdzIOulvCB0cnVlIOuhnCDtlZjqs6AgY2F0ZWdvcnlJZCDrpbwg7KCA7LaVIOyEseqyqeydmCDtla3rqqnsnLzroZwg6rOg66W07IS47JqULiDqt7gg67CW7JeQ64qUIGZhbHNlLicsCiAgICAnLSDriITsoIEg6riI7JWhLCDtlZzrj4QsIOy5tOuTnMK36rOE7KKMIOuyiO2YuCwg7Iq57J2467KI7Zi464qUIOqxsOuemCDquIjslaHsnbQg7JWE64uZ64uI64ukLiDsnpTslaHsnbQg7KCB7ZiAIOyeiOycvOuptCBiYWxhbmNlIOyXkCwg7JeG7Jy866m0IC0xLicsCiAgICAnLSBhY2NvdW50X2xhc3Q0OiDsnbQg7JWM66a87J20IOyWtOuKkCDrk7HroZ0g6rOE7KKML+y5tOuTnOyXkOyEnCDsnbzslrTrgpwg6rGw656Y7J247KeAIOq3uCDrgZ0gNOyekOumrC4g66qo66W066m0IOu5iCDrrLjsnpDsl7QuJywKICAgICctIOyKueyduOy3qOyGjC/tmZjrtojsnbTrqbQgaXNfY2FuY2VsIOydhCB0cnVlIOuhnCDtlZjshLjsmpQuJywKICAgICctIGRhdGUg64qUIFlZWVktTU0tREQuIOyXsOuPhOqwgCDsl4bsnLzrqbQg7Jik64qYKHRvZGF5KSDquLDspIAg6rCA7J6lIOqwgOq5jOyatCDqs7zqsbAg64Kg7KecLCDrgqDsp5zqsIAg7JeG7Jy866m0IHRvZGF5LicsCiAgICAnLSDsp4DstpzsnbQg7JWE64uI6rGw64KYIOyVjOunnuydgCDtla3rqqnsnbQg7JeG7Jy866m0IGNhdGVnb3J5SWQg66W8ICJub25lIiDsnLzroZwg7ZWY7IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZE1lc3NhZ2VSZXF1ZXN0KGNhdGVnb3JpZXMsIHRleHQsIHRvZGF5SVNPLCBtZXJjaGFudE1hcCwgb3B0cyA9IHt9KSB7CiAgICBjb25zdCBpZHMgPSBjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCk7CiAgICBjb25zdCB1c2VyID0gSlNPTi5zdHJpbmdpZnkoewogICAgICB0b2RheTogdG9kYXlJU08sCiAgICAgIG15X25hbWU6IG9wdHMubXlOYW1lIHx8ICcnLAogICAgICBhY2NvdW50czogKG9wdHMuYWNjb3VudHMgfHwgW10pLm1hcCgoYSkgPT4gKHsgbmFtZTogYS5uYW1lLCB0eXBlOiBhLnR5cGUsIGxhc3Q0OiBkaWdpdHNPbmx5KGEubGFzdDQpLnNsaWNlKC00KSwgaXNTYXZpbmdzOiAhIWEuaXNTYXZpbmdzIH0pKSwKICAgICAgY2F0ZWdvcmllczogY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCksCiAgICAgIG1lc3NhZ2U6IFN0cmluZyh0ZXh0KSwKICAgIH0pOwogICAgY29uc3Qgc2NoZW1hID0gewogICAgICB0eXBlOiAnb2JqZWN0JywKICAgICAgcHJvcGVydGllczogewogICAgICAgIGtpbmQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IFsnZXhwZW5zZScsICdpbmNvbWUnLCAnb3duX3RyYW5zZmVyJywgJ25vdF90cmFuc2FjdGlvbiddIH0sCiAgICAgICAgaXNfY2FuY2VsOiB7IHR5cGU6ICdib29sZWFuJyB9LAogICAgICAgIHRvX3NhdmluZ3M6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sCiAgICAgICAgZGF0ZTogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFtb3VudDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICBtZXJjaGFudDogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFjY291bnRfbGFzdDQ6IHsgdHlwZTogJ3N0cmluZycgfSwKICAgICAgICBiYWxhbmNlOiB7IHR5cGU6ICdpbnRlZ2VyJyB9LAogICAgICAgIGNhdGVnb3J5SWQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IGlkcy5jb25jYXQoWydub25lJ10pIH0sCiAgICAgIH0sCiAgICAgIHJlcXVpcmVkOiBbJ2tpbmQnLCAnaXNfY2FuY2VsJywgJ3RvX3NhdmluZ3MnLCAnZGF0ZScsICdhbW91bnQnLCAnbWVyY2hhbnQnLCAnYWNjb3VudF9sYXN0NCcsICdiYWxhbmNlJywgJ2NhdGVnb3J5SWQnXSwKICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLAogICAgfTsKICAgIHJldHVybiB7IHN5c3RlbTogTUVTU0FHRV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiB7IGRhdGUsIGFtb3VudCwgbWVtbywga2luZCwgY2F0ZWdvcnlJZCwgYWNjb3VudElkLCBiYWxhbmNlIH0g65iQ64qUIG51bGwo6rGw656YIOyVhOuLmCkKICBmdW5jdGlvbiByZWFkTWVzc2FnZVJlc3BvbnNlKGpzb24sIGNhdGVnb3JpZXMsIHRvZGF5SVNPLCBhY2NvdW50cykgewogICAgaWYgKCFqc29uIHx8ICFqc29uLmtpbmQgfHwganNvbi5raW5kID09PSAnbm90X3RyYW5zYWN0aW9uJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhbW91bnRBYnMgPSBNYXRoLmFicyhNYXRoLnJvdW5kKE51bWJlcihqc29uLmFtb3VudCkgfHwgMCkpOwogICAgaWYgKCFhbW91bnRBYnMpIHJldHVybiBudWxsOwogICAgbGV0IGRhdGUgPSBTdHJpbmcoanNvbi5kYXRlIHx8ICcnKTsKICAgIGlmICghL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSkpIGRhdGUgPSB0b2RheUlTTzsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCkpOwogICAgY29uc3QgY2F0ZWdvcnlJZCA9IGtub3duLmhhcyhqc29uLmNhdGVnb3J5SWQpID8ganNvbi5jYXRlZ29yeUlkIDogbnVsbDsKICAgIGNvbnN0IGFjY291bnQgPSBhY2NvdW50QnlMYXN0NChqc29uLmFjY291bnRfbGFzdDQsIGFjY291bnRzKTsKCiAgICBsZXQga2luZCA9ICdleHBlbnNlJzsKICAgIGlmIChqc29uLmtpbmQgPT09ICdpbmNvbWUnKSBraW5kID0gJ2luY29tZSc7CiAgICBlbHNlIGlmIChqc29uLmtpbmQgPT09ICdvd25fdHJhbnNmZXInICYmICFqc29uLnRvX3NhdmluZ3MpIGtpbmQgPSAndHJhbnNmZXInOwoKICAgIHJldHVybiB7CiAgICAgIGRhdGUsCiAgICAgIGFtb3VudDoga2luZCA9PT0gJ2V4cGVuc2UnICYmIGpzb24uaXNfY2FuY2VsID8gLWFtb3VudEFicyA6IGFtb3VudEFicywKICAgICAgbWVtbzogU3RyaW5nKGpzb24ubWVyY2hhbnQgfHwgJycpLnRyaW0oKSB8fCAnKOuCtOyaqSDsl4bsnYwpJywKICAgICAga2luZCwKICAgICAgY2F0ZWdvcnlJZDoga2luZCA9PT0gJ2V4cGVuc2UnID8gY2F0ZWdvcnlJZCA6IG51bGwsCiAgICAgIGFjY291bnRJZDogYWNjb3VudCA/IGFjY291bnQuaWQgOiBudWxsLAogICAgICBiYWxhbmNlOiBOdW1iZXIuaXNJbnRlZ2VyKGpzb24uYmFsYW5jZSkgJiYganNvbi5iYWxhbmNlID49IDAgPyBqc29uLmJhbGFuY2UgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J2A7ZaJIOqxsOuemOuCtOyXrSDtjIzsnbwgKOyXkeyFgC9DU1YpIC0tLS0tLS0tLS0KICAvLyDsnYDtlonrp4jri6Qg7ZWt66qpIOydtOumhOydtCDri6zrnbzshJwsIOuouOumrOq4gCjssqsg7KSEKeydmCDsnbTrpoTsnYQg67O06rOgIOy5uOydhCDssL7ripTri6QuCgogIGNvbnN0IENPTFVNTl9ISU5UUyA9IFsKICAgIFsnZGF0ZScsIC/qsbDrnphccyrsnbzsi5x86rGw656YXHMq7J287J6QfOqxsOuemFxzKuuCoOynnHxe7J287IucJHxe64Kg7KecJHxe7J287J6QJHxe6rGw656Y7J28JC9dLAogICAgWyd0aW1lJywgL17si5zqsIQkfOqxsOuemFxzKuyLnOqwhHxe7Iuc6rCBJC9dLAogICAgWydjYXRlZ29yeScsIC/qsbDrnphccyrqtazrtoR86rGw656YXHMq7Jyg7ZiVfOqxsOuemFxzKuyiheulmC9dLAogICAgWyd0eXBlJywgL17qtazrtoQkfOyehey2nOq4iFxzKuq1rOu2hHzsnoVccypcL1xzKuy2nOq4iHxe7J6F7Lac6riIJC9dLAogICAgWydvdXQnLCAv7Lac6riIXHMqKOyVoXzquIjslaEpPyR87LC+7Jy87IugXHMq6riI7JWhfOyngOq4iVxzKijslaF86riI7JWhKT8kL10sCiAgICBbJ2luJywgL+yeheq4iFxzKijslaF86riI7JWhKT8kfOunoeq4sOyLoFxzKuq4iOyVoS9dLAogICAgWydhbW91bnQnLCAv6rGw656YXHMq6riI7JWhfF7quIjslaEkL10sCiAgICBbJ2JhbGFuY2UnLCAv7J6U7JWhL10sCiAgICBbJ21lbW8nLCAvXuuCtOyaqSR86rGw656YXHMq64K07JqpfOyggeyalHzrsJvripRccyrrtoR867O064K4XHMq67aEfOqxsOuemOyymHzquLDsnqxccyrrgrTsmql87IOB64yAL10sCiAgICBbJ25vdGUnLCAvXuuplOuqqCQvXSwKICBdOwoKICBmdW5jdGlvbiBjZWxsVGV4dCh2KSB7CiAgICByZXR1cm4gdiA9PT0gbnVsbCB8fCB2ID09PSB1bmRlZmluZWQgPyAnJyA6IFN0cmluZyh2KS50cmltKCk7CiAgfQoKICBmdW5jdGlvbiBmaW5kSGVhZGVyKHJvd3MpIHsKICAgIGZvciAobGV0IHIgPSAwOyByIDwgTWF0aC5taW4ocm93cy5sZW5ndGgsIDMwKTsgcisrKSB7CiAgICAgIGNvbnN0IGNvbHMgPSB7fTsKICAgICAgKHJvd3Nbcl0gfHwgW10pLmZvckVhY2goKGNlbGwsIGMpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gY2VsbFRleHQoY2VsbCkucmVwbGFjZSgvXHMrL2csICcgJyk7CiAgICAgICAgaWYgKCFuYW1lKSByZXR1cm47CiAgICAgICAgZm9yIChjb25zdCBba2V5LCByZV0gb2YgQ09MVU1OX0hJTlRTKSB7CiAgICAgICAgICBpZiAoY29sc1trZXldID09PSB1bmRlZmluZWQgJiYgcmUudGVzdChuYW1lKSkgewogICAgICAgICAgICBjb2xzW2tleV0gPSBjOwogICAgICAgICAgICBicmVhazsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0pOwogICAgICBpZiAoY29scy5kYXRlICE9PSB1bmRlZmluZWQgJiYgKGNvbHMuYW1vdW50ICE9PSB1bmRlZmluZWQgfHwgY29scy5vdXQgIT09IHVuZGVmaW5lZCB8fCBjb2xzLmluICE9PSB1bmRlZmluZWQpKSByZXR1cm4geyByb3c6IHIsIGNvbHMgfTsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgLy8g7JeR7IWAIOuCoOynnCDsnbzroKjrsojtmLgoNDU5Mjgg65OxKSDrmJDripQgIjIwMjYuMDkuMjggMTQ6MDIiIOqwmeydgCDquIDsnpAg4oaSIHsgZGF0ZSwgdGltZSB9CiAgZnVuY3Rpb24gcGFyc2VEYXRlQ2VsbCh2KSB7CiAgICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInICYmIHYgPiAyMDAwMCAmJiB2IDwgODAwMDApIHsKICAgICAgY29uc3QgbXMgPSBNYXRoLnJvdW5kKCh2IC0gMjU1NjkpICogODY0MDAwMDApOwogICAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgICByZXR1cm4gewogICAgICAgIGRhdGU6IHRvSVNPKGQuZ2V0VVRDRnVsbFllYXIoKSwgZC5nZXRVVENNb250aCgpICsgMSwgZC5nZXRVVENEYXRlKCkpLAogICAgICAgIHRpbWU6IE51bWJlci5pc0ludGVnZXIodikgPyAnJyA6IGAke3BhZChkLmdldFVUQ0hvdXJzKCkpfToke3BhZChkLmdldFVUQ01pbnV0ZXMoKSl9OiR7cGFkKGQuZ2V0VVRDU2Vjb25kcygpKX1gLAogICAgICB9OwogICAgfQogICAgY29uc3QgcyA9IGNlbGxUZXh0KHYpOwogICAgY29uc3QgbSA9IHMubWF0Y2goLyhcZHs0fSlccypbLlwtL+uFhF1ccyooXGR7MSwyfSlccypbLlwtL+yblF1ccyooXGR7MSwyfSkvKTsKICAgIGlmICghbSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBbeSwgbW8sIGRdID0gW051bWJlcihtWzFdKSwgTnVtYmVyKG1bMl0pLCBOdW1iZXIobVszXSldOwogICAgaWYgKCF2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHQgPSBzLnNsaWNlKG0uaW5kZXggKyBtWzBdLmxlbmd0aCkubWF0Y2goLyhcZHsxLDJ9KTooXGR7Mn0pKD86OihcZHsyfSkpPy8pOwogICAgcmV0dXJuIHsgZGF0ZTogdG9JU08oeSwgbW8sIGQpLCB0aW1lOiB0ID8gYCR7cGFkKHRbMV0pfToke3RbMl19OiR7dFszXSB8fCAnMDAnfWAgOiAnJyB9OwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRDZWxsKHYpIHsKICAgIGlmICh0eXBlb2YgdiA9PT0gJ251bWJlcicpIHJldHVybiB2OwogICAgbGV0IHMgPSBjZWxsVGV4dCh2KS5yZXBsYWNlKC9bLFxz7JuQXS9nLCAnJyk7CiAgICBpZiAoIXMpIHJldHVybiBudWxsOwogICAgbGV0IG5lZyA9IGZhbHNlOwogICAgaWYgKC9eXCguKlwpJC8udGVzdChzKSkgewogICAgICBuZWcgPSB0cnVlOwogICAgICBzID0gcy5zbGljZSgxLCAtMSk7CiAgICB9CiAgICBjb25zdCBuID0gTnVtYmVyKHMpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikpIHJldHVybiBudWxsOwogICAgcmV0dXJuIG5lZyA/IC1uIDogbjsKICB9CgogIC8qCiAgICog6rGw656Y64K07JetIO2RnCgy7LCo7JuQIOuwsOyXtCnrpbwg64K07Jet7Jy866GcIOuwlOq+vOuLpC4KICAgKiBvcHRzOiB7IG15TmFtZSwgYWNjb3VudElkIH0KICAgKiDrsJjtmZg6IHsgaXRlbXM6IFt7ZGF0ZSwgdGltZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGJhbGFuY2UsIHJhd31dLCBza2lwcGVkLCBoZWFkZXIsIGxhdGVzdDoge2RhdGUsIHRpbWUsIGJhbGFuY2V9IHwgbnVsbCB9CiAgICovCiAgZnVuY3Rpb24gcGFyc2VTdGF0ZW1lbnRSb3dzKHJvd3MsIG9wdHMgPSB7fSkgewogICAgY29uc3QgaGVhZGVyID0gZmluZEhlYWRlcihyb3dzKTsKICAgIGlmICghaGVhZGVyKSByZXR1cm4geyBpdGVtczogW10sIHNraXBwZWQ6IDAsIGhlYWRlcjogbnVsbCwgbGF0ZXN0OiBudWxsIH07CiAgICBjb25zdCB7IGNvbHMgfSA9IGhlYWRlcjsKICAgIGNvbnN0IGdldCA9IChyb3csIGtleSkgPT4gKGNvbHNba2V5XSA9PT0gdW5kZWZpbmVkID8gJycgOiByb3dbY29sc1trZXldXSk7CiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgbGV0IHNraXBwZWQgPSAwOwogICAgbGV0IGxhdGVzdCA9IG51bGw7CiAgICAvLyDquIjslaEg7ZWcIOy5uOyXkCDstpzquIjsnYAg7J2M7IiY66GcIOyggeuKlCDtjIzsnbzsnbjsp4AgKOq3uOugh+uLpOuptCDslpHsiJjripQg7J6F6riIKQogICAgY29uc3Qgc2lnbmVkID0gY29scy5hbW91bnQgIT09IHVuZGVmaW5lZCAmJiByb3dzLnNsaWNlKGhlYWRlci5yb3cgKyAxKS5zb21lKChyb3cpID0+IChwYXJzZUFtb3VudENlbGwoKHJvdyB8fCBbXSlbY29scy5hbW91bnRdKSB8fCAwKSA8IDApOwoKICAgIGZvciAobGV0IHIgPSBoZWFkZXIucm93ICsgMTsgciA8IHJvd3MubGVuZ3RoOyByKyspIHsKICAgICAgY29uc3Qgcm93ID0gcm93c1tyXSB8fCBbXTsKICAgICAgaWYgKCFyb3cuc29tZSgoYykgPT4gY2VsbFRleHQoYykpKSBjb250aW51ZTsKICAgICAgY29uc3Qgd2hlbiA9IHBhcnNlRGF0ZUNlbGwoZ2V0KHJvdywgJ2RhdGUnKSk7CiAgICAgIGlmICghd2hlbikgewogICAgICAgIHNraXBwZWQgKz0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoIXdoZW4udGltZSAmJiBjb2xzLnRpbWUgIT09IHVuZGVmaW5lZCkgewogICAgICAgIGNvbnN0IHQgPSBjZWxsVGV4dChnZXQocm93LCAndGltZScpKS5tYXRjaCgvKFxkezEsMn0pOihcZHsyfSkoPzo6KFxkezJ9KSk/Lyk7CiAgICAgICAgaWYgKHQpIHdoZW4udGltZSA9IGAke3BhZCh0WzFdKX06JHt0WzJdfToke3RbM10gfHwgJzAwJ31gOwogICAgICB9CgogICAgICBjb25zdCB0eXBlVGV4dCA9IGNlbGxUZXh0KGdldChyb3csICd0eXBlJykpOwogICAgICBjb25zdCBjYXRlZ29yeVRleHQgPSBjZWxsVGV4dChnZXQocm93LCAnY2F0ZWdvcnknKSk7CiAgICAgIGNvbnN0IG91dCA9IHBhcnNlQW1vdW50Q2VsbChnZXQocm93LCAnb3V0JykpOwogICAgICBjb25zdCBpbm4gPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2luJykpOwogICAgICBjb25zdCBhbXQgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2Ftb3VudCcpKTsKCiAgICAgIGxldCBraW5kOwogICAgICBsZXQgYW1vdW50OwogICAgICBpZiAob3V0KSB7CiAgICAgICAga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBhbW91bnQgPSBNYXRoLmFicyhvdXQpOwogICAgICB9IGVsc2UgaWYgKGlubikgewogICAgICAgIGtpbmQgPSAnaW5jb21lJzsKICAgICAgICBhbW91bnQgPSBNYXRoLmFicyhpbm4pOwogICAgICB9IGVsc2UgaWYgKGFtdCkgewogICAgICAgIGFtb3VudCA9IE1hdGguYWJzKGFtdCk7CiAgICAgICAgaWYgKC/snoXquIgvLnRlc3QodHlwZVRleHQpKSBraW5kID0gJ2luY29tZSc7CiAgICAgICAgZWxzZSBpZiAoL+y2nOq4iHzsp4DquIkvLnRlc3QodHlwZVRleHQpKSBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGVsc2UgaWYgKGFtdCA8IDApIGtpbmQgPSAnZXhwZW5zZSc7CiAgICAgICAgZWxzZSBraW5kID0gc2lnbmVkID8gJ2luY29tZScgOiAnZXhwZW5zZSc7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2tpcHBlZCArPSAxOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICBjb25zdCBtZW1vTWFpbiA9IGNlbGxUZXh0KGdldChyb3csICdtZW1vJykpOwogICAgICBjb25zdCBub3RlID0gY2VsbFRleHQoZ2V0KHJvdywgJ25vdGUnKSk7CiAgICAgIGNvbnN0IG1lbW8gPSBtZW1vTWFpbiB8fCBub3RlIHx8IGNhdGVnb3J5VGV4dCB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgICAgY29uc3QgYWxsVGV4dCA9IGAke3R5cGVUZXh0fSAke2NhdGVnb3J5VGV4dH0gJHttZW1vfSAke25vdGV9YDsKCiAgICAgIC8vIOy5tOuTnCDqsrDsoJwg7Leo7IaMwrftmZjrtojroZwg65Ok7Ja07JioIOuPiOydgCDsp4DstpzsnYQg7KSE7J2064qUIOqyg+ycvOuhnCDrs7jri6QKICAgICAgaWYgKGtpbmQgPT09ICdpbmNvbWUnICYmIC/st6jshox87ZmY67aILy50ZXN0KGFsbFRleHQpKSB7CiAgICAgICAga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBhbW91bnQgPSAtYW1vdW50OwogICAgICB9CiAgICAgIGlmIChvcHRzLm15TmFtZSAmJiBtZW1vLmluY2x1ZGVzKG9wdHMubXlOYW1lKSAmJiAhL+y5tOuTnHzqsrDsoJx87Iq57J24Ly50ZXN0KGFsbFRleHQpKSBraW5kID0gJ3RyYW5zZmVyJzsKCiAgICAgIGNvbnN0IGJhbGFuY2UgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2JhbGFuY2UnKSk7CiAgICAgIGNvbnN0IGl0ZW0gPSB7CiAgICAgICAgZGF0ZTogd2hlbi5kYXRlLAogICAgICAgIHRpbWU6IHdoZW4udGltZSwKICAgICAgICBhbW91bnQsCiAgICAgICAgbWVtbywKICAgICAgICBraW5kLAogICAgICAgIGFjY291bnRJZDogb3B0cy5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICBiYWxhbmNlOiBOdW1iZXIuaXNGaW5pdGUoYmFsYW5jZSkgPyBiYWxhbmNlIDogbnVsbCwKICAgICAgICByYXc6IHJvdy5tYXAoY2VsbFRleHQpLmZpbHRlcihCb29sZWFuKS5qb2luKCcgfCAnKS5zbGljZSgwLCAzMDApLAogICAgICB9OwogICAgICBpdGVtcy5wdXNoKGl0ZW0pOwogICAgICBpZiAoaXRlbS5iYWxhbmNlICE9PSBudWxsKSB7CiAgICAgICAgY29uc3Qga2V5ID0gYCR7aXRlbS5kYXRlfSAke2l0ZW0udGltZX1gOwogICAgICAgIGlmICghbGF0ZXN0IHx8IGtleSA+PSBgJHtsYXRlc3QuZGF0ZX0gJHtsYXRlc3QudGltZX1gKSBsYXRlc3QgPSB7IGRhdGU6IGl0ZW0uZGF0ZSwgdGltZTogaXRlbS50aW1lLCBiYWxhbmNlOiBpdGVtLmJhbGFuY2UgfTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQsIGhlYWRlciwgbGF0ZXN0IH07CiAgfQoKICAvLyBDU1Yg6riA7J6QIOKGkiAy7LCo7JuQIOuwsOyXtCAo65Sw7Ji07ZGcIOyViOydmCDsibztkZzCt+ykhOuwlOq/iCDsspjrpqwpCiAgZnVuY3Rpb24gcGFyc2VDU1YodGV4dCkgewogICAgY29uc3Qgcm93cyA9IFtdOwogICAgbGV0IHJvdyA9IFtdOwogICAgbGV0IGNlbGwgPSAnJzsKICAgIGxldCBxdW90ZWQgPSBmYWxzZTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXlx1RkVGRi8sICcnKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7IGkrKykgewogICAgICBjb25zdCBjaCA9IHNbaV07CiAgICAgIGlmIChxdW90ZWQpIHsKICAgICAgICBpZiAoY2ggPT09ICciJyAmJiBzW2kgKyAxXSA9PT0gJyInKSB7CiAgICAgICAgICBjZWxsICs9ICciJzsKICAgICAgICAgIGkgKz0gMTsKICAgICAgICB9IGVsc2UgaWYgKGNoID09PSAnIicpIHF1b3RlZCA9IGZhbHNlOwogICAgICAgIGVsc2UgY2VsbCArPSBjaDsKICAgICAgfSBlbHNlIGlmIChjaCA9PT0gJyInKSBxdW90ZWQgPSB0cnVlOwogICAgICBlbHNlIGlmIChjaCA9PT0gJywnIHx8IGNoID09PSAnXHQnKSB7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgaWYgKGNoID09PSAnXG4nIHx8IGNoID09PSAnXHInKSB7CiAgICAgICAgaWYgKGNoID09PSAnXHInICYmIHNbaSArIDFdID09PSAnXG4nKSBpICs9IDE7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgcm93cy5wdXNoKHJvdyk7CiAgICAgICAgcm93ID0gW107CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgY2VsbCArPSBjaDsKICAgIH0KICAgIGlmIChjZWxsIHx8IHJvdy5sZW5ndGgpIHsKICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgIHJvd3MucHVzaChyb3cpOwogICAgfQogICAgcmV0dXJuIHJvd3M7CiAgfQoKICAvLyDslYzrprzsnLzroZwg7J2066+4IOuTpOyWtOyYqCDrgrTsl63snbjsp4A6IOygle2Zle2eiCDqsJnqsbDrgpgsIOqwmeydgCDrgqDCt+qwmeydgCDquIjslaHCt+qwmeydgCDsooXrpZjsnbTrqbTshJwg7IKs7Jqp7LKY6rCAIOqyuey5mOqxsOuCmCDqsJnsnYAg6rOE7KKMCiAgZnVuY3Rpb24gZmluZER1cGxpY2F0ZShpdGVtLCB0cmFuc2FjdGlvbnMpIHsKICAgIGNvbnN0IG1lbW8gPSBub3JtYWxpemVNZXJjaGFudChpdGVtLm1lbW8pOwogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5maW5kKCh0KSA9PiB7CiAgICAgIGlmICh0LmRhdGUgIT09IGl0ZW0uZGF0ZSB8fCBNYXRoLmFicyh0LmFtb3VudCkgIT09IE1hdGguYWJzKGl0ZW0uYW1vdW50KSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAoa2luZE9mKHQpICE9PSBraW5kT2YoaXRlbSkpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgdG0gPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBpZiAodG0gPT09IG1lbW8gfHwgKHRtICYmIG1lbW8gJiYgKHRtLmluY2x1ZGVzKG1lbW8pIHx8IG1lbW8uaW5jbHVkZXModG0pKSkpIHJldHVybiB0cnVlOwogICAgICByZXR1cm4gISEoaXRlbS5hY2NvdW50SWQgJiYgdC5hY2NvdW50SWQgPT09IGl0ZW0uYWNjb3VudElkKTsKICAgIH0pIHx8IG51bGw7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOumrO2PrO2KuCAtLS0tLS0tLS0tCgogIC8vIO2VreuqqeuzhCDsp4DstpwgKOunjuydtCDsk7Qg7IicKS4g7IOJ7J2AIOqzhO2ajSDslYjsnZgg7Iic7IScKGNvbG9ySW5kZXgp66GcIOygle2VtCDsiJzsnITqsIAg67CU64CM7Ja064+EIOqwmeydgCDtla3rqqnsnYAg6rCZ7J2AIOyDiS4KICBmdW5jdGlvbiBjYXRlZ29yeUJyZWFrZG93bihzdW1tYXJ5KSB7CiAgICBjb25zdCByb3dzID0gc3VtbWFyeS5yb3dzLm1hcCgociwgaSkgPT4gKHsgaWQ6IHIuY2F0ZWdvcnkuaWQsIG5hbWU6IHIuY2F0ZWdvcnkubmFtZSwgYW1vdW50OiByLnNwZW50LCBjb3VudDogci5jb3VudCwgY29sb3JJbmRleDogaSB9KSk7CiAgICBpZiAoc3VtbWFyeS51bmNsYXNzaWZpZWQpIHJvd3MucHVzaCh7IGlkOiAnX19ub25lJywgbmFtZTogJ+uvuOu2hOulmCcsIGFtb3VudDogc3VtbWFyeS51bmNsYXNzaWZpZWQsIGNvdW50OiBzdW1tYXJ5LnVuY2xhc3NpZmllZENvdW50LCBjb2xvckluZGV4OiAtMSB9KTsKICAgIGNvbnN0IHRvdGFsID0gcm93cy5yZWR1Y2UoKHMsIHIpID0+IHMgKyBNYXRoLm1heCgwLCByLmFtb3VudCksIDApOwogICAgcmV0dXJuIHJvd3MKICAgICAgLmZpbHRlcigocikgPT4gci5hbW91bnQgPiAwKQogICAgICAubWFwKChyKSA9PiAoeyAuLi5yLCBzaGFyZTogdG90YWwgPyByLmFtb3VudCAvIHRvdGFsIDogMCB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYW1vdW50IC0gYS5hbW91bnQpOwogIH0KCiAgLy8g7J2067KIIOq4sOqwhOqzvCDsp4HsoIQg6riw6rCE7J2YIO2VreuqqeuzhCDruYTqtZAgKOydtOuyiCDquLDqsIQg6rOE7ZqN7J2YIO2VreuqqSDquLDspIAsIOqwmeydgCBpZCDrgbzrpqwpCiAgZnVuY3Rpb24gY29tcGFyZVdpdGhQcmV2aW91cyhzdGF0ZSwgcGVyaW9kKSB7CiAgICBjb25zdCBjdXIgPSBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCk7CiAgICBjb25zdCBwcmV2UGVyaW9kID0gc2hpZnRQZXJpb2QocGVyaW9kLCAtMSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgY29uc3QgcHJldiA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcHJldlBlcmlvZCk7CiAgICBjb25zdCBwcmV2U3BlbnQgPSB7fTsKICAgIGZvciAoY29uc3QgciBvZiBwcmV2LnJvd3MpIHByZXZTcGVudFtyLmNhdGVnb3J5LmlkXSA9IHIuc3BlbnQ7CiAgICBjb25zdCByb3dzID0gY3VyLnJvd3MubWFwKChyKSA9PiAoewogICAgICBpZDogci5jYXRlZ29yeS5pZCwKICAgICAgbmFtZTogci5jYXRlZ29yeS5uYW1lLAogICAgICBjdXJyZW50OiByLnNwZW50LAogICAgICBwcmV2aW91czogcHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDAsCiAgICAgIGRpZmY6IHIuc3BlbnQgLSAocHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDApLAogICAgfSkpOwogICAgcmV0dXJuIHsgY3VycmVudDogY3VyLCBwcmV2aW91czogcHJldiwgcm93cywgdG90YWxEaWZmOiBjdXIudG90YWxTcGVudCAtIHByZXYudG90YWxTcGVudCB9OwogIH0KCiAgZnVuY3Rpb24gdG9wTWVyY2hhbnRzKHR4cywgbiA9IDUpIHsKICAgIGNvbnN0IG1hcCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIGNvbnRpbnVlOwogICAgICBjb25zdCBrZXkgPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBjb25zdCBtID0gKG1hcFtrZXldID0gbWFwW2tleV0gfHwgeyBtZW1vOiB0Lm1lbW8sIHRvdGFsOiAwLCBjb3VudDogMCB9KTsKICAgICAgbS50b3RhbCArPSB0LmFtb3VudDsKICAgICAgbS5jb3VudCArPSAxOwogICAgfQogICAgcmV0dXJuIE9iamVjdC52YWx1ZXMobWFwKS5zb3J0KChhLCBiKSA9PiBiLnRvdGFsIC0gYS50b3RhbCkuc2xpY2UoMCwgbik7CiAgfQoKICAvLyDstZzqt7wgbiDqsJwg6riw6rCEICjsmKTrnpjrkJwg6rKD67aA7YSwKTog7JiI7IKw7Jy866GcIOyeheugpe2VnCDsiJjsnoUsIOyLpOygnCDsnoXquIgsIOyngOy2nAogIGZ1bmN0aW9uIHRyZW5kKHN0YXRlLCBwZXJpb2QsIG4gPSA2KSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgY29uc3QgcCA9IHNoaWZ0UGVyaW9kKHBlcmlvZCwgLWksIHN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgY29uc3QgcyA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcCk7CiAgICAgIG91dC5wdXNoKHsgcGVyaW9kOiBwLCBidWRnZXRJbmNvbWU6IHMuaGFzSW5jb21lID8gcy5pbmNvbWUgOiBudWxsLCBpbmNvbWVSZWNlaXZlZDogcy5pbmNvbWVSZWNlaXZlZCwgc3BlbnQ6IHMudG90YWxTcGVudCB9KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDrgqDsp5zrs4Qg7ZWp6rOEOiB7ICdZWVlZLU1NLUREJzogeyBzcGVudCwgaW5jb21lLCBjb3VudCB9IH0KICBmdW5jdGlvbiBkYWlseVRvdGFscyh0eHMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBjb25zdCBkID0gKG91dFt0LmRhdGVdID0gb3V0W3QuZGF0ZV0gfHwgeyBzcGVudDogMCwgaW5jb21lOiAwLCBjb3VudDogMCB9KTsKICAgICAgY29uc3QgayA9IGtpbmRPZih0KTsKICAgICAgaWYgKGsgPT09ICdleHBlbnNlJykgZC5zcGVudCArPSB0LmFtb3VudDsKICAgICAgZWxzZSBpZiAoayA9PT0gJ2luY29tZScpIGQuaW5jb21lICs9IHQuYW1vdW50OwogICAgICBkLmNvdW50ICs9IDE7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g7J6Q7IKwOiDqs4Tsoowg7J6U7JWhIO2VqeqzhCwg7Lm065Oc67OEIOydtOuyiCDquLDqsIQg7IKs7Jqp7JWhCiAgZnVuY3Rpb24gYXNzZXRTdW1tYXJ5KHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IHR4cyA9IHR4c0luUGVyaW9kKHN0YXRlLCBwZXJpb2QpOwogICAgY29uc3QgYmFua3MgPSBzdGF0ZS5hY2NvdW50cy5maWx0ZXIoKGEpID0+IGEudHlwZSAhPT0gJ2NhcmQnKTsKICAgIGNvbnN0IGNhcmRzID0gc3RhdGUuYWNjb3VudHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09ICdjYXJkJyk7CiAgICBjb25zdCB0b3RhbCA9IGJhbmtzLnJlZHVjZSgocywgYSkgPT4gcyArICh0eXBlb2YgYS5iYWxhbmNlID09PSAnbnVtYmVyJyA/IGEuYmFsYW5jZSA6IDApLCAwKTsKICAgIGNvbnN0IHNhdmluZ3MgPSBiYW5rcy5maWx0ZXIoKGEpID0+IGEuaXNTYXZpbmdzKS5yZWR1Y2UoKHMsIGEpID0+IHMgKyAodHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiAwKSwgMCk7CiAgICBjb25zdCBzcGVuZEJ5ID0ge307CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSBpZiAoa2luZE9mKHQpID09PSAnZXhwZW5zZScgJiYgdC5hY2NvdW50SWQpIHNwZW5kQnlbdC5hY2NvdW50SWRdID0gKHNwZW5kQnlbdC5hY2NvdW50SWRdIHx8IDApICsgdC5hbW91bnQ7CiAgICByZXR1cm4gewogICAgICB0b3RhbCwKICAgICAgc2F2aW5ncywKICAgICAgYmFua3M6IGJhbmtzLm1hcCgoYSkgPT4gKHsgLi4uYSwgc3BlbnQ6IHNwZW5kQnlbYS5pZF0gfHwgMCB9KSksCiAgICAgIGNhcmRzOiBjYXJkcy5tYXAoKGEpID0+ICh7IC4uLmEsIHNwZW50OiBzcGVuZEJ5W2EuaWRdIHx8IDAgfSkpLAogICAgICB1bmxpbmtlZFNwZW50OiB0eHMuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdleHBlbnNlJyAmJiAhdC5hY2NvdW50SWQpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKSwKICAgIH07CiAgfQoKICAvLyAtLS0tLS0tLS0tIOq4sOuzuCDrjbDsnbTthLAgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBkZWZhdWx0Q2F0ZWdvcmllcygpIHsKICAgIHJldHVybiBbCiAgICAgIHsgaWQ6ICdjLWhvdXNlJywgbmFtZTogJ+yjvOqxsC/qtIDrpqzruYQnLCB0eXBlOiAnZml4ZWQnLCB2YWx1ZTogNTAwMDAwLCBkZXNjcmlwdGlvbjogJ+yblOyEuCwg6rSA66as67mELCDsoITquLDCt+qwgOyKpMK37IiY64+EIOyalOq4iCcsIGtleXdvcmRzOiBbJ+yblOyEuCcsICfqtIDrpqzruYQnLCAn7KCE6riw7JqU6riIJywgJ+uPhOyLnOqwgOyKpCcsICfsiJjrj4TsmpTquIgnXSB9LAogICAgICB7IGlkOiAnYy1waG9uZScsIG5hbWU6ICfthrXsi6Av6rWs64+FJywgdHlwZTogJ2ZpeGVkJywgdmFsdWU6IDgwMDAwLCBkZXNjcmlwdGlvbjogJ+2ctOuMgO2PsCDsmpTquIgsIOyduO2EsOuEtywgT1RUwrfsnYzslYUg65OxIOygleq4sCDqtazrj4UnLCBrZXl3b3JkczogWydTS1QnLCAnS1QnLCAnTEcgVSsnLCAn7Ya17IugJywgJ+uEt+2UjOumreyKpCcsICfsnKDtipzruIwnLCAn66mc66GgJywgJ+y/oO2MoeyZgOyasCcsICfrlJTspojri4gnXSB9LAogICAgICB7IGlkOiAnYy1mb29kJywgbmFtZTogJ+yLneu5hCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiAzMCwgZGVzY3JpcHRpb246ICfsi53ri7ksIOuwsOuLrCwg7J6l67O06riwLCDtjrjsnZjsoJAg7J2M7IudJywga2V5d29yZHM6IFsn7Iud64u5JywgJ+uwsOuLrOydmOuvvOyhsScsICfrsLDrr7wnLCAn7JqU6riw7JqUJywgJ+y/oO2MoeydtOy4oCcsICfsnbTrp4jtirgnLCAn7ZmI7ZSM65+s7IqkJywgJ+uhr+uNsOuniO2KuCcsICfrp4jtirgnLCAn7Y647J2Y7KCQJywgJ0dTMjUnLCAnQ1UnLCAn7IS467iQ7J2866CI67iQJywgJ+q5gOuwpScsICfsuZjtgqgnXSB9LAogICAgICB7IGlkOiAnYy1jYWZlJywgbmFtZTogJ+y5tO2OmC/qsITsi50nLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNSwgZGVzY3JpcHRpb246ICfsu6TtlLwsIOydjOujjCwg67m1LCDrlJTsoIDtirgnLCBrZXl3b3JkczogWyfsiqTtg4DrsoXsiqQnLCAn7Yis7I24JywgJ+ydtOuUlOyVvCcsICfrqZTqsIDsu6TtlLwnLCAn66mU6rCATUdDJywgJ+y7tO2PrOymiCcsICfrub3ri6TrsKknLCAn7Lm07Y6YJywgJ+2MjOumrOuwlOqyjOucqCcsICfrmpzroIjspazrpbQnLCAn67Kg7J207Luk66asJ10gfSwKICAgICAgeyBpZDogJ2MtbW92ZScsIG5hbWU6ICfqtZDthrUnLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNywgZGVzY3JpcHRpb246ICfrjIDspJHqtZDthrUsIO2DneyLnCwg6riw7LCoLCDso7zsnKAsIOyjvOywqCcsIGtleXdvcmRzOiBbJ+2DneyLnCcsICfsubTsubTsmKRUJywgJ+uyhOyKpCcsICfsp4DtlZjssqAnLCAn7Yuw66i464uIJywgJ+y9lOugiOydvCcsICdTUlQnLCAn7KO87JygJywgJ+yjvOywqCddIH0sCiAgICAgIHsgaWQ6ICdjLXNob3AnLCBuYW1lOiAn7Ie87ZWRJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDEwLCBkZXNjcmlwdGlvbjogJ+yYqOudvOyduCDsh7ztlZEsIOyYtywg7IOd7Zmc7Jqp7ZKILCDtmZTsnqXtkognLCBrZXl3b3JkczogWyfsv6DtjKEnLCAnMTHrsojqsIAnLCAnR+uniOy8kycsICfrrLTsi6DsgqwnLCAn7Jis66as67iM7JiBJywgJ+uLpOydtOyGjCcsICfrhKTsnbTrsoTtjpjsnbQnXSB9LAogICAgICB7IGlkOiAnYy1mdW4nLCBuYW1lOiAn66y47ZmUL+yXrOqwgCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA4LCBkZXNjcmlwdGlvbjogJ+yYge2ZlCwg6rO17JewLCDssYUsIOy3qOuvuCwg7Jes7ZaJJywga2V5d29yZHM6IFsnQ0dWJywgJ+uplOqwgOuwleyKpCcsICfroa/rjbDsi5zrhKTrp4gnLCAn6rWQ67O066y46rOgJywgJ1lFUzI0JywgJ+yVjOudvOuUmCddIH0sCiAgICAgIHsgaWQ6ICdjLXNhdmUnLCBuYW1lOiAn7KCA7LaVL+2IrOyekCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA0MCwgZGVzY3JpcHRpb246ICfsoIHquIgsIOyggOy2lSDsnbTssrQsIOymneq2jCDqs4Tsoowg7J6F6riILCDssq3slb0nLCBrZXl3b3JkczogWyfsoIHquIgnLCAn7KCA7LaVJywgJ+ymneq2jCcsICfssq3slb0nXSB9LAogICAgXTsKICB9CgogIGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSgpIHsKICAgIHJldHVybiB7CiAgICAgIHZlcnNpb246IDIsCiAgICAgIHNldHRpbmdzOiB7IHN0YXJ0RGF5OiAxLCBteU5hbWU6ICcnIH0sCiAgICAgIHBsYW5zOiBbeyBmcm9tOiBCQVNFX1BMQU5fRlJPTSwgcmF0aW9CYXNlOiAnYWZ0ZXJGaXhlZCcsIGZpeGVkT3ZlcmZsb3c6ICd3YXJuJywgY2F0ZWdvcmllczogZGVmYXVsdENhdGVnb3JpZXMoKSwgdXBkYXRlZEF0OiAnJyB9XSwKICAgICAgYWNjb3VudHM6IFtdLAogICAgICBpbmNvbWVzOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBbXSwKICAgICAgbWVyY2hhbnRNYXA6IHt9LAogICAgfTsKICB9CgogIC8vIOyggOyepeuQnCDrjbDsnbTthLDrpbwg7ZiE7J6sIOq1rOyhsOuhnCDrp57stpjri6QuICh2MTog6rOE7ZqN7J20IO2VmOuCmOu/kOydtOuNmCDqtazsobAg4oaSIHYyOiDquLDqsITrs4Qg6rOE7ZqNKQogIGZ1bmN0aW9uIG5vcm1hbGl6ZVN0YXRlKHJhdykgewogICAgY29uc3QgYmFzZSA9IGRlZmF1bHRTdGF0ZSgpOwogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBiYXNlOwogICAgY29uc3Qgc2V0dGluZ3MgPSByYXcuc2V0dGluZ3MgfHwge307CiAgICBjb25zdCBzdGFydERheSA9IE1hdGgubWluKDMxLCBNYXRoLm1heCgxLCBOdW1iZXIoc2V0dGluZ3Muc3RhcnREYXkpIHx8IDEpKTsKCiAgICBsZXQgcGxhbnM7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyYXcucGxhbnMpICYmIHJhdy5wbGFucy5sZW5ndGgpIHsKICAgICAgcGxhbnMgPSByYXcucGxhbnM7CiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocmF3LmNhdGVnb3JpZXMpKSB7CiAgICAgIHBsYW5zID0gW3sgZnJvbTogQkFTRV9QTEFOX0ZST00sIHJhdGlvQmFzZTogc2V0dGluZ3MucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLCBjYXRlZ29yaWVzOiByYXcuY2F0ZWdvcmllcywgdXBkYXRlZEF0OiAnJyB9XTsKICAgIH0gZWxzZSB7CiAgICAgIHBsYW5zID0gYmFzZS5wbGFuczsKICAgIH0KICAgIHBsYW5zID0gcGxhbnMKICAgICAgLm1hcCgocCkgPT4gKHsKICAgICAgICBmcm9tOiBTdHJpbmcocC5mcm9tIHx8IEJBU0VfUExBTl9GUk9NKSwKICAgICAgICByYXRpb0Jhc2U6IHAucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLAogICAgICAgIGZpeGVkT3ZlcmZsb3c6IHAuZml4ZWRPdmVyZmxvdyA9PT0gJ3NjYWxlJyA/ICdzY2FsZScgOiAnd2FybicsCiAgICAgICAgY2F0ZWdvcmllczogQXJyYXkuaXNBcnJheShwLmNhdGVnb3JpZXMpID8gcC5jYXRlZ29yaWVzIDogW10sCiAgICAgICAgdXBkYXRlZEF0OiBTdHJpbmcocC51cGRhdGVkQXQgfHwgJycpLAogICAgICB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IChhLmZyb20gPCBiLmZyb20gPyAtMSA6IGEuZnJvbSA+IGIuZnJvbSA/IDEgOiAwKSk7CgogICAgY29uc3QgYWNjb3VudHMgPSAoQXJyYXkuaXNBcnJheShyYXcuYWNjb3VudHMpID8gcmF3LmFjY291bnRzIDogW10pLm1hcCgoYSkgPT4gKHsKICAgICAgaWQ6IFN0cmluZyhhLmlkKSwKICAgICAgbmFtZTogU3RyaW5nKGEubmFtZSB8fCAnJyksCiAgICAgIHR5cGU6IGEudHlwZSA9PT0gJ2NhcmQnID8gJ2NhcmQnIDogJ2JhbmsnLAogICAgICBsYXN0NDogZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCksCiAgICAgIGlzU2F2aW5nczogISFhLmlzU2F2aW5ncywKICAgICAgYmFsYW5jZTogdHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiBudWxsLAogICAgICBiYWxhbmNlQXQ6IFN0cmluZyhhLmJhbGFuY2VBdCB8fCAnJyksCiAgICB9KSk7CgogICAgcmV0dXJuIHsKICAgICAgdmVyc2lvbjogMiwKICAgICAgc2V0dGluZ3M6IHsgc3RhcnREYXksIG15TmFtZTogU3RyaW5nKHNldHRpbmdzLm15TmFtZSB8fCAnJykgfSwKICAgICAgcGxhbnMsCiAgICAgIGFjY291bnRzLAogICAgICBpbmNvbWVzOiByYXcuaW5jb21lcyAmJiB0eXBlb2YgcmF3LmluY29tZXMgPT09ICdvYmplY3QnID8gcmF3LmluY29tZXMgOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBBcnJheS5pc0FycmF5KHJhdy50cmFuc2FjdGlvbnMpID8gcmF3LnRyYW5zYWN0aW9ucyA6IFtdLAogICAgICBtZXJjaGFudE1hcDogcmF3Lm1lcmNoYW50TWFwICYmIHR5cGVvZiByYXcubWVyY2hhbnRNYXAgPT09ICdvYmplY3QnID8gcmF3Lm1lcmNoYW50TWFwIDoge30sCiAgICB9OwogIH0KCiAgcmV0dXJuIHsKICAgIHRvSVNPLAogICAgcGFyc2VJU08sCiAgICBhZGREYXlzLAogICAgZGlmZkRheXMsCiAgICB0b2RheUlTTywKICAgIGRheXNJbk1vbnRoLAogICAgZ2V0UGVyaW9kLAogICAgc2hpZnRQZXJpb2QsCiAgICBjb21wdXRlQnVkZ2V0cywKICAgIHN1bW1hcml6ZVBlcmlvZCwKICAgIHN0YXR1c09mLAogICAgbm9ybWFsaXplTWVyY2hhbnQsCiAgICBjbGFzc2lmeSwKICAgIGNsYXNzaWZ5TG9jYWwsCiAgICBwYXJzZUV4cGVuc2VUZXh0LAogICAga2luZE9mLAogICAgbG9va3NMaWtlVHJhbnNhY3Rpb24sCiAgICBtYXRjaEFjY291bnQsCiAgICBwYXJzZU1lc3NhZ2VGYWxsYmFjaywKICAgIGlzRHVwbGljYXRlLAogICAgQkFTRV9QTEFOX0ZST00sCiAgICBwbGFuRm9yLAogICAgdW5jbGFzc2lmaWVkR3JvdXBzLAogICAgdW5jbGFzc2lmaWVkQnlQZXJpb2QsCiAgICBlbnN1cmVQbGFuRm9yLAogICAgbmV4dFBsYW5BZnRlciwKICAgIHJlbWFwUGVyaW9kS2V5cywKICAgIGJ1aWxkQ2xhc3NpZnlSZXF1ZXN0LAogICAgcmVhZENsYXNzaWZ5UmVzcG9uc2UsCiAgICBidWlsZE1lc3NhZ2VSZXF1ZXN0LAogICAgcmVhZE1lc3NhZ2VSZXNwb25zZSwKICAgIHBhcnNlU3RhdGVtZW50Um93cywKICAgIHBhcnNlQ1NWLAogICAgZmluZER1cGxpY2F0ZSwKICAgIGNhdGVnb3J5QnJlYWtkb3duLAogICAgY29tcGFyZVdpdGhQcmV2aW91cywKICAgIHRvcE1lcmNoYW50cywKICAgIHRyZW5kLAogICAgZGFpbHlUb3RhbHMsCiAgICBhc3NldFN1bW1hcnksCiAgICBkZWZhdWx0U3RhdGUsCiAgICBub3JtYWxpemVTdGF0ZSwKICB9Owp9KTsK\");</script>\n  <script>__budgetRun(\"js/charts.js\", \"Lyog7LCo7Yq4IChTVkcg66y47J6Q7Je07J2EIOunjOuToOuLpCkuIOyDieydgCBjc3Mg67OA7IiYIC0tczEgfiAtLXM3ICjtla3rqqkg7Iic7ISc64yA66GcIOqzoOyglSksIOq3uCDrsJbsnYAg7ZqM7IOJLiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IFNMT1RTID0gNzsKCiAgZnVuY3Rpb24gc2VyaWVzQ29sb3IoY29sb3JJbmRleCkgewogICAgcmV0dXJuIGNvbG9ySW5kZXggPj0gMCAmJiBjb2xvckluZGV4IDwgU0xPVFMgPyBgdmFyKC0tcyR7Y29sb3JJbmRleCArIDF9KWAgOiAndmFyKC0tZ3JheS1tYXJrKSc7CiAgfQoKICAvLyAxMiwzNDAsMDAwIOKGkiAiMSwyMzTrp4wiLCAx7Ja1IOydtOyDgeydgCAiMS4y7Ja1IgogIGZ1bmN0aW9uIHNob3J0V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHNpZ24gPSBuIDwgMCA/ICctJyA6ICcnOwogICAgaWYgKGEgPj0gMWU4KSByZXR1cm4gYCR7c2lnbn0keyhhIC8gMWU4KS50b0ZpeGVkKGEgPj0gMWU5ID8gMCA6IDEpLnJlcGxhY2UoL1wuMCQvLCAnJyl97Ja1YDsKICAgIGlmIChhID49IDFlNCkgcmV0dXJuIGAke3NpZ259JHtNYXRoLnJvdW5kKGEgLyAxZTQpLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeunjGA7CiAgICByZXR1cm4gYCR7c2lnbn0ke01hdGgucm91bmQoYSkudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyl9YDsKICB9CgogIC8vIOuLrOugpeyymOufvCDsooHsnYAg7Lm47JqpOiA2LDIwMCDihpIgIjYuMuyynCIsIDEyLDQwMCDihpIgIjEuMuunjCIsIDUxMiwwMDAg4oaSICI1MeunjCIKICBmdW5jdGlvbiB0aW55V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHRyaW0gPSAoeCkgPT4geC50b0ZpeGVkKDEpLnJlcGxhY2UoL1wuMCQvLCAnJyk7CiAgICBpZiAoYSA+PSAxZTgpIHJldHVybiBgJHt0cmltKGEgLyAxZTgpfeyWtWA7CiAgICBpZiAoYSA+PSAxZTUpIHJldHVybiBgJHtNYXRoLnJvdW5kKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTQpIHJldHVybiBgJHt0cmltKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTMpIHJldHVybiBgJHt0cmltKGEgLyAxZTMpfeyynGA7CiAgICByZXR1cm4gU3RyaW5nKE1hdGgucm91bmQoYSkpOwogIH0KCiAgZnVuY3Rpb24gbmljZU1heCh2KSB7CiAgICBpZiAodiA8PSAwKSByZXR1cm4gMTAwMDA7CiAgICBjb25zdCBwID0gTWF0aC5wb3coMTAsIE1hdGguZmxvb3IoTWF0aC5sb2cxMCh2KSkpOwogICAgZm9yIChjb25zdCBtIG9mIFsxLCAyLCAyLjUsIDUsIDEwXSkgaWYgKG0gKiBwID49IHYpIHJldHVybiBtICogcDsKICAgIHJldHVybiAxMCAqIHA7CiAgfQoKICAvLyDqtazshLEg66eJ64yAOiByb3dzID0gW3tuYW1lLCBhbW91bnQsIGNvbG9ySW5kZXh9XSAo66eO7J20IOyTtCDsiJwpLiA467KI7Ke4IOyDieu2gO2EsOuKlCAi6riw7YOAIuuhnCDtlansuZzri6QuCiAgZnVuY3Rpb24gc2hhcmVTZWdtZW50cyhyb3dzKSB7CiAgICBjb25zdCBtYWluID0gcm93cy5maWx0ZXIoKHIpID0+IHIuY29sb3JJbmRleCA+PSAwICYmIHIuY29sb3JJbmRleCA8IFNMT1RTKTsKICAgIGNvbnN0IHJlc3QgPSByb3dzLmZpbHRlcigocikgPT4gIShyLmNvbG9ySW5kZXggPj0gMCAmJiByLmNvbG9ySW5kZXggPCBTTE9UUykpOwogICAgY29uc3Qgc2VncyA9IG1haW4ubWFwKChyKSA9PiAoeyBuYW1lOiByLm5hbWUsIGFtb3VudDogci5hbW91bnQsIGNvbG9yOiBzZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpIH0pKTsKICAgIGNvbnN0IHJlc3RTdW0gPSByZXN0LnJlZHVjZSgocywgcikgPT4gcyArIHIuYW1vdW50LCAwKTsKICAgIGlmIChyZXN0U3VtID4gMCkgc2Vncy5wdXNoKHsgbmFtZTogcmVzdC5sZW5ndGggPT09IDEgPyByZXN0WzBdLm5hbWUgOiAn6riw7YOAJywgYW1vdW50OiByZXN0U3VtLCBjb2xvcjogc2VyaWVzQ29sb3IoLTEpIH0pOwogICAgcmV0dXJuIHNlZ3M7CiAgfQoKICBmdW5jdGlvbiBzaGFyZUJhcihyb3dzKSB7CiAgICBjb25zdCBzZWdzID0gc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgIGNvbnN0IHRvdGFsID0gc2Vncy5yZWR1Y2UoKHMsIHIpID0+IHMgKyByLmFtb3VudCwgMCkgfHwgMTsKICAgIHJldHVybiBgPGRpdiBjbGFzcz0ic2hhcmUtYmFyIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iu2VreuqqeuzhCDsp4Dstpwg6rWs7ISxIj4ke3NlZ3MKICAgICAgLm1hcCgocywgaSkgPT4gYDxzcGFuIGRhdGEtc2VnPSIke2l9IiBzdHlsZT0iZmxleDoke3MuYW1vdW50IC8gdG90YWx9O2JhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPmApCiAgICAgIC5qb2luKCcnKX08L2Rpdj5gOwogIH0KCiAgLyoKICAgKiDquLDqsITrs4Qg7LaU7J20OiDquLDqsITrp4jri6QgW+yImOyehSwg7KeA7LacXSDrkZAg66eJ64yALiBkYXRhID0gW3tsYWJlbCwgaW5jb21lLCBzcGVudH1dCiAgICog66eJ64yAIOyCrOydtCAycHgg6rCE6rKpLCDsnJfrtoDrtoQgNHB4IOuRpeq4gOqyjCwg67CU64ul7J2AIOq4sOykgOyEoOyXkCDrtpnsnoQuCiAgICovCiAgZnVuY3Rpb24gdHJlbmRDaGFydChkYXRhLCB7IHdpZHRoID0gNjQwLCBoZWlnaHQgPSAyMjAgfSA9IHt9KSB7CiAgICBjb25zdCBwYWQgPSB7IHRvcDogMTIsIHJpZ2h0OiA4LCBib3R0b206IDI2LCBsZWZ0OiA0NCB9OwogICAgY29uc3QgdyA9IHdpZHRoIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgICBjb25zdCBoID0gaGVpZ2h0IC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgICBjb25zdCBtYXggPSBuaWNlTWF4KE1hdGgubWF4KDEsIC4uLmRhdGEubWFwKChkKSA9PiBNYXRoLm1heChkLmluY29tZSB8fCAwLCBkLnNwZW50IHx8IDApKSkpOwogICAgY29uc3QgeSA9ICh2KSA9PiBwYWQudG9wICsgaCAtIChNYXRoLm1heCgwLCB2KSAvIG1heCkgKiBoOwogICAgY29uc3QgYmFuZCA9IHcgLyBkYXRhLmxlbmd0aDsKICAgIGNvbnN0IGJhclcgPSBNYXRoLm1pbigyNiwgKGJhbmQgLSAxOCkgLyAyKTsKICAgIGNvbnN0IGdhcCA9IDI7CiAgICBjb25zdCBwYXJ0cyA9IFtdOwoKICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDQ7IGkrKykgewogICAgICBjb25zdCB2ID0gKG1heCAvIDQpICogaTsKICAgICAgY29uc3QgeXkgPSB5KHYpOwogICAgICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz0iZ3JpZC1saW5lIiB4MT0iJHtwYWQubGVmdH0iIHgyPSIke3dpZHRoIC0gcGFkLnJpZ2h0fSIgeTE9IiR7eXl9IiB5Mj0iJHt5eX0iLz5gKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7cGFkLmxlZnQgLSA2fSIgeT0iJHt5eSArIDR9IiB0ZXh0LWFuY2hvcj0iZW5kIj4ke3Nob3J0V29uKHYpfTwvdGV4dD5gKTsKICAgIH0KCiAgICBjb25zdCBiYXIgPSAoeCwgdiwgY29sb3IpID0+IHsKICAgICAgaWYgKCF2IHx8IHYgPD0gMCkgcmV0dXJuICcnOwogICAgICBjb25zdCB0b3AgPSB5KHYpOwogICAgICBjb25zdCBiaCA9IHBhZC50b3AgKyBoIC0gdG9wOwogICAgICBjb25zdCByID0gTWF0aC5taW4oNCwgYmgpOwogICAgICAvLyDsnITsqr0g66qo7ISc66as66eMIOuRpeq3vCDrp4nrjIAKICAgICAgcmV0dXJuIGA8cGF0aCBmaWxsPSIke2NvbG9yfSIgZD0iTSR7eH0sJHtwYWQudG9wICsgaH0gViR7dG9wICsgcn0gUSR7eH0sJHt0b3B9ICR7eCArIHJ9LCR7dG9wfSBIJHt4ICsgYmFyVyAtIHJ9IFEke3ggKyBiYXJXfSwke3RvcH0gJHt4ICsgYmFyV30sJHt0b3AgKyByfSBWJHtwYWQudG9wICsgaH0gWiIvPmA7CiAgICB9OwoKICAgIGRhdGEuZm9yRWFjaCgoZCwgaSkgPT4gewogICAgICBjb25zdCBjeCA9IHBhZC5sZWZ0ICsgYmFuZCAqIGkgKyBiYW5kIC8gMjsKICAgICAgcGFydHMucHVzaChiYXIoY3ggLSBiYXJXIC0gZ2FwIC8gMiwgZC5pbmNvbWUsICd2YXIoLS1zMSknKSk7CiAgICAgIHBhcnRzLnB1c2goYmFyKGN4ICsgZ2FwIC8gMiwgZC5zcGVudCwgJ3ZhcigtLXMyKScpKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7Y3h9IiB5PSIke2hlaWdodCAtIDh9IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj4ke2QubGFiZWx9PC90ZXh0PmApOwogICAgICBwYXJ0cy5wdXNoKGA8cmVjdCBjbGFzcz0iaGl0IiBkYXRhLWk9IiR7aX0iIHg9IiR7cGFkLmxlZnQgKyBiYW5kICogaX0iIHk9IiR7cGFkLnRvcH0iIHdpZHRoPSIke2JhbmR9IiBoZWlnaHQ9IiR7aH0iLz5gKTsKICAgIH0pOwoKICAgIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3aWR0aH0gJHtoZWlnaHR9IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iuq4sOqwhOuzhCDsiJjsnoXqs7wg7KeA7LacIj4ke3BhcnRzLmpvaW4oJycpfTwvc3ZnPmA7CiAgfQoKICByb290LkJ1ZGdldENoYXJ0cyA9IHsgc2VyaWVzQ29sb3IsIHNob3J0V29uLCB0aW55V29uLCBzaGFyZVNlZ21lbnRzLCBzaGFyZUJhciwgdHJlbmRDaGFydCB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/xlsx.js\", \"Lyog7JeR7IWAKC54bHN4KSDssqsg67KI7Ke4IOyLnO2KuOulvCAy7LCo7JuQIOuwsOyXtOuhnCDsnb3ripTri6QuIOyZuOu2gCDrnbzsnbTruIzrn6zrpqwg7JeG7J20IOu4jOudvOyasOyggCDquLDriqXrp4wg7JO064ukLgogKiAueGxzeCDripQgemlwIOyViOyXkCBYTUwg7J20IOuToCDtjIzsnbzsnbTrnbwsIHppcCDsnYQg7ZKA6rOgKERlY29tcHJlc3Npb25TdHJlYW0pIFhNTCDsnYQg7J2964qU64ukKERPTVBhcnNlcikuCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGZ1bmN0aW9uIGZhaWwoY29kZSwgbWVzc2FnZSkgewogICAgY29uc3QgZSA9IG5ldyBFcnJvcihtZXNzYWdlKTsKICAgIGUuY29kZSA9IGNvZGU7CiAgICByZXR1cm4gZTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGluZmxhdGVSYXcoYnl0ZXMpIHsKICAgIGlmICh0eXBlb2YgRGVjb21wcmVzc2lvblN0cmVhbSA9PT0gJ3VuZGVmaW5lZCcpIHsKICAgICAgdGhyb3cgZmFpbCgndW5zdXBwb3J0ZWQnLCAn7J20IOu4jOudvOyasOyggOuKlCDsl5HshYAg7YyM7J287J2EIO2SgCDsiJgg7JeG7Ja07JqULiDstZzsi6Ag7YGs66GswrfsgqztjIzrpqzrpbwg7JOw6rGw64KYLCDsl5HshYDsl5DshJwgQ1NWIOuhnCDsoIDsnqXtlbQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBCbG9iKFtieXRlc10pLnN0cmVhbSgpLnBpcGVUaHJvdWdoKG5ldyBEZWNvbXByZXNzaW9uU3RyZWFtKCdkZWZsYXRlLXJhdycpKTsKICAgIHJldHVybiBuZXcgVWludDhBcnJheShhd2FpdCBuZXcgUmVzcG9uc2Uoc3RyZWFtKS5hcnJheUJ1ZmZlcigpKTsKICB9CgogIC8vIHppcCDslYjsnZgg7YyM7J28IOuqqeuhnSDihpIgeyDsnbTrpoQ6IGFzeW5jICgpID0+IOuCtOyaqShVaW50OEFycmF5KSB9CiAgZnVuY3Rpb24gcmVhZFppcERpcmVjdG9yeShidWYpIHsKICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcoYnVmKTsKICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYnVmKTsKICAgIGxldCBlb2NkID0gLTE7CiAgICBmb3IgKGxldCBpID0gYnVmLmJ5dGVMZW5ndGggLSAyMjsgaSA+PSBNYXRoLm1heCgwLCBidWYuYnl0ZUxlbmd0aCAtIDY1NTU3KTsgaS0tKSB7CiAgICAgIGlmICh2aWV3LmdldFVpbnQzMihpLCB0cnVlKSA9PT0gMHgwNjA1NGI1MCkgewogICAgICAgIGVvY2QgPSBpOwogICAgICAgIGJyZWFrOwogICAgICB9CiAgICB9CiAgICBpZiAoZW9jZCA8IDApIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAg7YyM7J28IOq1rOyhsOulvCDsnb3sp4Ag66q77ZaI7Ja07JqULicpOwogICAgY29uc3QgY291bnQgPSB2aWV3LmdldFVpbnQxNihlb2NkICsgMTAsIHRydWUpOwogICAgbGV0IHAgPSB2aWV3LmdldFVpbnQzMihlb2NkICsgMTYsIHRydWUpOwogICAgY29uc3QgZmlsZXMgPSB7fTsKICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTsKICAgIGZvciAobGV0IG4gPSAwOyBuIDwgY291bnQ7IG4rKykgewogICAgICBpZiAodmlldy5nZXRVaW50MzIocCwgdHJ1ZSkgIT09IDB4MDIwMTRiNTApIGJyZWFrOwogICAgICBjb25zdCBtZXRob2QgPSB2aWV3LmdldFVpbnQxNihwICsgMTAsIHRydWUpOwogICAgICBjb25zdCBjb21wU2l6ZSA9IHZpZXcuZ2V0VWludDMyKHAgKyAyMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWVMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMjgsIHRydWUpOwogICAgICBjb25zdCBleHRyYUxlbiA9IHZpZXcuZ2V0VWludDE2KHAgKyAzMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGNvbW1lbnRMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMzIsIHRydWUpOwogICAgICBjb25zdCBsb2NhbCA9IHZpZXcuZ2V0VWludDMyKHAgKyA0MiwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVyLmRlY29kZShieXRlcy5zdWJhcnJheShwICsgNDYsIHAgKyA0NiArIG5hbWVMZW4pKTsKICAgICAgZmlsZXNbbmFtZV0gPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc3RhcnQgPSBsb2NhbCArIDMwICsgdmlldy5nZXRVaW50MTYobG9jYWwgKyAyNiwgdHJ1ZSkgKyB2aWV3LmdldFVpbnQxNihsb2NhbCArIDI4LCB0cnVlKTsKICAgICAgICBjb25zdCBkYXRhID0gYnl0ZXMuc3ViYXJyYXkoc3RhcnQsIHN0YXJ0ICsgY29tcFNpemUpOwogICAgICAgIGlmIChtZXRob2QgPT09IDApIHJldHVybiBkYXRhOwogICAgICAgIGlmIChtZXRob2QgPT09IDgpIHJldHVybiBpbmZsYXRlUmF3KGRhdGEpOwogICAgICAgIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsp4Dsm5DtlZjsp4Ag7JWK64qUIOyVley2lSDrsKnsi53snbTsl5DsmpQuJyk7CiAgICAgIH07CiAgICAgIHAgKz0gNDYgKyBuYW1lTGVuICsgZXh0cmFMZW4gKyBjb21tZW50TGVuOwogICAgfQogICAgcmV0dXJuIGZpbGVzOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFhtbChmaWxlcywgbmFtZSkgewogICAgaWYgKCFmaWxlc1tuYW1lXSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGF3YWl0IGZpbGVzW25hbWVdKCkpOwogICAgcmV0dXJuIG5ldyBET01QYXJzZXIoKS5wYXJzZUZyb21TdHJpbmcodGV4dCwgJ2FwcGxpY2F0aW9uL3htbCcpOwogIH0KCiAgY29uc3QgdGFncyA9IChub2RlLCBuYW1lKSA9PiBBcnJheS5mcm9tKG5vZGUuZ2V0RWxlbWVudHNCeVRhZ05hbWUobmFtZSkpOwoKICBmdW5jdGlvbiBjb2x1bW5JbmRleChyZWYpIHsKICAgIGNvbnN0IGxldHRlcnMgPSBTdHJpbmcocmVmIHx8ICcnKS5tYXRjaCgvXltBLVpdKy8pOwogICAgaWYgKCFsZXR0ZXJzKSByZXR1cm4gLTE7CiAgICBsZXQgbiA9IDA7CiAgICBmb3IgKGNvbnN0IGNoIG9mIGxldHRlcnNbMF0pIG4gPSBuICogMjYgKyAoY2guY2hhckNvZGVBdCgwKSAtIDY0KTsKICAgIHJldHVybiBuIC0gMTsKICB9CgogIC8vIOyyqyDrsojsp7gg7Iuc7Yq47J2YIOqyveuhnCAod29ya2Jvb2sueG1sIOydmCDssqsgc2hlZXQg4oaSIOq0gOqzhCDtjIzsnbzsl5DshJwg7Iuk7KCcIOqyveuhnCkKICBhc3luYyBmdW5jdGlvbiBmaXJzdFNoZWV0UGF0aChmaWxlcykgewogICAgY29uc3Qgd2IgPSBhd2FpdCByZWFkWG1sKGZpbGVzLCAneGwvd29ya2Jvb2sueG1sJyk7CiAgICBjb25zdCByZWxzID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzJyk7CiAgICBpZiAod2IgJiYgcmVscykgewogICAgICBjb25zdCBzaGVldCA9IHRhZ3Mod2IsICdzaGVldCcpWzBdOwogICAgICBjb25zdCByaWQgPSBzaGVldCAmJiAoc2hlZXQuZ2V0QXR0cmlidXRlKCdyOmlkJykgfHwgc2hlZXQuZ2V0QXR0cmlidXRlTlMoJ2h0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMnLCAnaWQnKSk7CiAgICAgIGNvbnN0IHJlbCA9IHRhZ3MocmVscywgJ1JlbGF0aW9uc2hpcCcpLmZpbmQoKHIpID0+IHIuZ2V0QXR0cmlidXRlKCdJZCcpID09PSByaWQpOwogICAgICBpZiAocmVsKSB7CiAgICAgICAgY29uc3QgdGFyZ2V0ID0gcmVsLmdldEF0dHJpYnV0ZSgnVGFyZ2V0JykucmVwbGFjZSgvXlwvLywgJycpOwogICAgICAgIHJldHVybiB0YXJnZXQuc3RhcnRzV2l0aCgneGwvJykgPyB0YXJnZXQgOiBgeGwvJHt0YXJnZXR9YDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIE9iamVjdC5rZXlzKGZpbGVzKS5maWx0ZXIoKG4pID0+IC9eeGxcL3dvcmtzaGVldHNcL3NoZWV0XGQrXC54bWwkLy50ZXN0KG4pKS5zb3J0KClbMF07CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkWGxzeChhcnJheUJ1ZmZlcikgewogICAgY29uc3QgaGVhZCA9IG5ldyBVaW50OEFycmF5KGFycmF5QnVmZmVyLnNsaWNlKDAsIDQpKTsKICAgIC8vIEQwIENGIDExIEUwOiDruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgOydtOqxsOuCmCDsmJvrgqAgLnhscyDtmJXsi50KICAgIGlmIChoZWFkWzBdID09PSAweGQwICYmIGhlYWRbMV0gPT09IDB4Y2YgJiYgaGVhZFsyXSA9PT0gMHgxMSAmJiBoZWFkWzNdID09PSAweGUwKSB7CiAgICAgIHRocm93IGZhaWwoJ2VuY3J5cHRlZCcsICfruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgCjrmJDripQg7Jib64KgIC54bHMpIO2MjOydvOydtOyXkOyalC4g7JeR7IWA7J2064KYIOq1rOq4gCDsi5ztirjsl5DshJwg7Je07Ja0IOu5hOuwgOuyiO2YuCDsl4bsnbQgLnhsc3gg65iQ64qUIENTViDroZwg64uk7IucIOyggOyepe2VnCDrkqQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGlmICghKGhlYWRbMF0gPT09IDB4NTAgJiYgaGVhZFsxXSA9PT0gMHg0YikpIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAoLnhsc3gpIO2MjOydvOydtCDslYTri4jsl5DsmpQuJyk7CgogICAgY29uc3QgZmlsZXMgPSByZWFkWmlwRGlyZWN0b3J5KGFycmF5QnVmZmVyKTsKICAgIGNvbnN0IHNoYXJlZCA9IFtdOwogICAgY29uc3Qgc3N0ID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL3NoYXJlZFN0cmluZ3MueG1sJyk7CiAgICBpZiAoc3N0KSB7CiAgICAgIGZvciAoY29uc3Qgc2kgb2YgdGFncyhzc3QsICdzaScpKSB7CiAgICAgICAgLy8g7J2964qUIOuylSDtkZzsi5woclBoKSDslYjsnZgg6riA7J6Q64qUIOu5vOqzoCDtlansuZzri6QKICAgICAgICBzaGFyZWQucHVzaCh0YWdzKHNpLCAndCcpLmZpbHRlcigodCkgPT4gISh0LnBhcmVudE5vZGUgJiYgdC5wYXJlbnROb2RlLm5vZGVOYW1lID09PSAnclBoJykpLm1hcCgodCkgPT4gdC50ZXh0Q29udGVudCkuam9pbignJykpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBwYXRoID0gYXdhaXQgZmlyc3RTaGVldFBhdGgoZmlsZXMpOwogICAgY29uc3Qgc2hlZXQgPSBwYXRoICYmIChhd2FpdCByZWFkWG1sKGZpbGVzLCBwYXRoKSk7CiAgICBpZiAoIXNoZWV0KSB0aHJvdyBmYWlsKCdmb3JtYXQnLCAn7Iuc7Yq466W8IOywvuyngCDrqrvtlojslrTsmpQuJyk7CgogICAgY29uc3Qgcm93cyA9IFtdOwogICAgZm9yIChjb25zdCByb3cgb2YgdGFncyhzaGVldCwgJ3JvdycpKSB7CiAgICAgIGNvbnN0IHIgPSBOdW1iZXIocm93LmdldEF0dHJpYnV0ZSgncicpKSAtIDE7CiAgICAgIGNvbnN0IG91dCA9IFtdOwogICAgICB0YWdzKHJvdywgJ2MnKS5mb3JFYWNoKChjLCBpKSA9PiB7CiAgICAgICAgY29uc3QgY29sID0gYy5nZXRBdHRyaWJ1dGUoJ3InKSA/IGNvbHVtbkluZGV4KGMuZ2V0QXR0cmlidXRlKCdyJykpIDogaTsKICAgICAgICBjb25zdCB0eXBlID0gYy5nZXRBdHRyaWJ1dGUoJ3QnKTsKICAgICAgICBjb25zdCB2ID0gdGFncyhjLCAndicpWzBdOwogICAgICAgIGxldCB2YWx1ZSA9ICcnOwogICAgICAgIGlmICh0eXBlID09PSAncycpIHZhbHVlID0gc2hhcmVkW051bWJlcih2ICYmIHYudGV4dENvbnRlbnQpXSB8fCAnJzsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnaW5saW5lU3RyJykgdmFsdWUgPSB0YWdzKGMsICd0JykubWFwKCh0KSA9PiB0LnRleHRDb250ZW50KS5qb2luKCcnKTsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnc3RyJyB8fCB0eXBlID09PSAnYicgfHwgdHlwZSA9PT0gJ2UnKSB2YWx1ZSA9IHYgPyB2LnRleHRDb250ZW50IDogJyc7CiAgICAgICAgZWxzZSBpZiAodikgdmFsdWUgPSBOdW1iZXIodi50ZXh0Q29udGVudCk7CiAgICAgICAgb3V0W2NvbF0gPSB2YWx1ZTsKICAgICAgfSk7CiAgICAgIHJvd3NbciA+PSAwID8gciA6IHJvd3MubGVuZ3RoXSA9IG91dDsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHJvd3MsIChyKSA9PiBBcnJheS5mcm9tKHIgfHwgW10sIChjKSA9PiAoYyA9PT0gdW5kZWZpbmVkID8gJycgOiBjKSkpOwogIH0KCiAgLy8g7YyM7J28IO2VmOuCmOulvCDsnb3slrQgMuywqOybkCDrsLDsl7TroZwuIENTViDripQg6riA7J6QIOq3uOuMgOuhnCjtlZzquIAg7JeR7IWAIENTViDripQgRVVDLUtSIOyduCDqsr3smrDqsIAg66eO7JWEIOqwmeydtCDsi5zrj4QpCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFRhYmxlRmlsZShmaWxlKSB7CiAgICBjb25zdCBidWYgPSBhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCk7CiAgICBjb25zdCBoZWFkID0gbmV3IFVpbnQ4QXJyYXkoYnVmLnNsaWNlKDAsIDQpKTsKICAgIGNvbnN0IGlzWmlwT3JPbGUgPSAoaGVhZFswXSA9PT0gMHg1MCAmJiBoZWFkWzFdID09PSAweDRiKSB8fCAoaGVhZFswXSA9PT0gMHhkMCAmJiBoZWFkWzFdID09PSAweGNmKTsKICAgIGlmIChpc1ppcE9yT2xlIHx8IC9cLnhsc3g/JC9pLnRlc3QoZmlsZS5uYW1lKSkgcmV0dXJuIHJlYWRYbHN4KGJ1Zik7CiAgICBsZXQgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigndXRmLTgnKS5kZWNvZGUoYnVmKTsKICAgIGlmICh0ZXh0LmluY2x1ZGVzKCfvv70nKSkgewogICAgICB0cnkgewogICAgICAgIHRleHQgPSBuZXcgVGV4dERlY29kZXIoJ2V1Yy1rcicpLmRlY29kZShidWYpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyogdXRmLTgg6re464yA66GcICovCiAgICAgIH0KICAgIH0KICAgIHJldHVybiByb290LkJ1ZGdldExvZ2ljLnBhcnNlQ1NWKHRleHQpOwogIH0KCiAgcm9vdC5CdWRnZXRYbHN4ID0geyByZWFkWGxzeCwgcmVhZFRhYmxlRmlsZSB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/store.js\", \"Lyog7KCA7J6l7IaMLiDrkZAg6rCA7KeAIOuwqeyLneydhCDqsJnsnYAg7ZWo7IiY66GcIOuLpOujrOuLpC4KICogIC0gbG9jYWwgOiDsnbQg67iM65287Jqw7KCAKGxvY2FsU3RvcmFnZSnsl5Drp4wg7KCA7J6lLCDtgqTsm4zrk5zroZwg67aE66WYCiAqICAtIHJlbW90ZTog6rWs6riAIEFwcHMgU2NyaXB0IOyEnOuyhCjqtazquIAg7Iuc7Yq4KeyXkCDsoIDsnqUsIENsYXVkZSBBSSDroZwg67aE66WYLCDslYzrprwg7J6Q64+ZIOyeheugpQogKiAgICAgICAgICAgIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOygnOqzte2VmOuptCDsnpDrj5nsnLzroZwgcmVtb3RlLCDslYTri4jrqbQg7ISk7KCV7JeQ7IScIOyEnOuyhCDso7zshozrpbwg7Jew6rKwCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IEwgPSByb290LkJ1ZGdldExvZ2ljOwogIGNvbnN0IFNUT1JBR0VfS0VZID0gJ2J1ZGdldC1hcHAtdjEnOwogIGNvbnN0IFNFUlZFUl9LRVkgPSAnYnVkZ2V0LWFwcC1zZXJ2ZXInOwogIGNvbnN0IE1JR1JBVEVfS0VZID0gJ2J1ZGdldC1hcHAtbWlncmF0ZSc7CgogIGNvbnN0IHVpZCA9ICgpID0+IERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCk7CiAgY29uc3Qgbm93SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpOwoKICBjb25zdCBLRVlfU1RPUkUgPSAnYnVkZ2V0LWFwcC1rZXknOwoKICBmdW5jdGlvbiByZWFkU2VydmVyQ29uZmlnKCkgewogICAgLy8g6rWs6riAIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOykhCDrlYw6IO2CpOuKlCDso7zshowoP2tleT0pIOuYkOuKlCDsnbQg6riw6riw7JeQIOq4sOyWte2VnCDqsJIKICAgIGlmIChyb290Ll9fQlVER0VUX1NFUlZFUl9fKSB7CiAgICAgIGxldCBrZXkgPSByb290Ll9fQlVER0VUX1NFUlZFUl9fLmtleSB8fCAnJzsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoa2V5KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgZWxzZSBrZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShLRVlfU1RPUkUpIHx8ICcnOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog6riw7Ja1IOuquyDtlZjrqbQg66ek67KIIOyeheugpSAqLwogICAgICB9CiAgICAgIHJldHVybiB7IC4uLnJvb3QuX19CVURHRVRfU0VSVkVSX18sIGtleSwgZW1iZWRkZWQ6IHRydWUgfTsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFUlZFUl9LRVkpOwogICAgICBjb25zdCBjID0gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDogbnVsbDsKICAgICAgcmV0dXJuIGMgJiYgYy51cmwgJiYgYy5rZXkgPyBjIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBjb25zdCBzZXJ2ZXIgPSByZWFkU2VydmVyQ29uZmlnKCk7CgogIGNvbnN0IHN0b3JlID0gewogICAgbW9kZTogc2VydmVyID8gJ3JlbW90ZScgOiAnbG9jYWwnLAogICAgc2VydmVyLAogICAgYWlFbmFibGVkOiBmYWxzZSwKICAgIGFpTW9kZWw6ICcnLAogICAgYWlNb2RlbHM6IFtdLAogICAgYWlFcnJvcjogJycsCiAgICBzZXJ2aWNlVXJsOiBzZXJ2ZXIgPyBzZXJ2ZXIudXJsIDogJycsCiAgICBzdGF0ZTogTC5kZWZhdWx0U3RhdGUoKSwKICAgIG9uRXJyb3I6ICgpID0+IHt9LAogIH07CgogIGxldCBtZXRhVGltZXIgPSBudWxsOwoKICBmdW5jdGlvbiBjYWxsQXBpKGFjdGlvbiwgcGF5bG9hZCwgdGFyZ2V0ID0gc2VydmVyKSB7CiAgICBjb25zdCByZXEgPSB7IGtleTogdGFyZ2V0LmtleSwgYWN0aW9uLCBwYXlsb2FkOiBwYXlsb2FkIHx8IHt9IH07CiAgICBjb25zdCB1bndyYXAgPSAocikgPT4gewogICAgICBpZiAoIXIgfHwgIXIub2spIHRocm93IG5ldyBFcnJvcigociAmJiByLmVycm9yKSB8fCAn7ISc67KEIOydkeuLtSDsmKTrpZgnKTsKICAgICAgcmV0dXJuIHI7CiAgICB9OwogICAgaWYgKHRhcmdldCA9PT0gc2VydmVyICYmIHJvb3QuZ29vZ2xlICYmIHJvb3QuZ29vZ2xlLnNjcmlwdCAmJiByb290Lmdvb2dsZS5zY3JpcHQucnVuKSB7CiAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgICAgcm9vdC5nb29nbGUuc2NyaXB0LnJ1bgogICAgICAgICAgLndpdGhTdWNjZXNzSGFuZGxlcigocikgPT4gewogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHJlc29sdmUodW53cmFwKHIpKTsKICAgICAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgICAgIHJlamVjdChlKTsKICAgICAgICAgICAgfQogICAgICAgICAgfSkKICAgICAgICAgIC53aXRoRmFpbHVyZUhhbmRsZXIocmVqZWN0KQogICAgICAgICAgLmFwaShyZXEpOwogICAgICB9KTsKICAgIH0KICAgIC8vIHRleHQvcGxhaW4g7Jy866GcIOuztOuCtOuptCBDT1JTIOyCrOyghCDsmpTssq0g7JeG7J20IEFwcHMgU2NyaXB0IOuhnCDrs7Trgrwg7IiYIOyeiOuLpAogICAgcmV0dXJuIGZldGNoKHRhcmdldC51cmwsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcSkgfSkKICAgICAgLnRoZW4oKHIpID0+IHIuanNvbigpKQogICAgICAudGhlbih1bndyYXApOwogIH0KCiAgZnVuY3Rpb24gbWV0YU9mKHMpIHsKICAgIGNvbnN0IHsgdHJhbnNhY3Rpb25zLCAuLi5tZXRhIH0gPSBzOwogICAgcmV0dXJuIG1ldGE7CiAgfQoKICBmdW5jdGlvbiBwbGFuRm9yRGF0ZShkYXRlKSB7CiAgICByZXR1cm4gTC5wbGFuRm9yKHN0b3JlLnN0YXRlLCBMLmdldFBlcmlvZChkYXRlLCBzdG9yZS5zdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KTsKICB9CgogIGZ1bmN0aW9uIHNhdmVMb2NhbCgpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNUT1JBR0VfS0VZLCBKU09OLnN0cmluZ2lmeShzdG9yZS5zdGF0ZSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcign7KCA7J6l7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4g67iM65287Jqw7KCAIOyggOyepeqzteqwhCDshKTsoJXsnYQg7ZmV7J247ZWY7IS47JqULicpKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlYWRMb2NhbFN0YXRlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oU1RPUkFHRV9LRVkpOwogICAgICByZXR1cm4gcmF3ID8gTC5ub3JtYWxpemVTdGF0ZShKU09OLnBhcnNlKHJhdykpIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBhcHBseVN0YXR1cyhyKSB7CiAgICBzdG9yZS5haUVuYWJsZWQgPSAhIXIuYWk7CiAgICBzdG9yZS5haU1vZGVsID0gci5tb2RlbCB8fCAnJzsKICAgIHN0b3JlLmFpTW9kZWxzID0gci5tb2RlbHMgfHwgW107CiAgICBzdG9yZS5haUVycm9yID0gci5sYXN0RXJyb3IgfHwgJyc7CiAgICBpZiAoci51cmwpIHN0b3JlLnNlcnZpY2VVcmwgPSByLnVybDsKICB9CgogIGZ1bmN0aW9uIGlzRXhwZW5zZShpdCkgewogICAgcmV0dXJuICFpdC5raW5kIHx8IGl0LmtpbmQgPT09ICdleHBlbnNlJzsKICB9CgogIE9iamVjdC5hc3NpZ24oc3RvcmUsIHsKICAgIHBsYW5Gb3JEYXRlLAogICAgcmVhZExvY2FsU3RhdGUsCgogICAgYXN5bmMgaW5pdCgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICBzdG9yZS5zdGF0ZSA9IHJlYWRMb2NhbFN0YXRlKCkgfHwgTC5kZWZhdWx0U3RhdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ2xvYWQnKTsKICAgICAgc3RvcmUuc3RhdGUgPSBMLm5vcm1hbGl6ZVN0YXRlKHIuc3RhdGUpOwogICAgICBhcHBseVN0YXR1cyhyKTsKICAgIH0sCgogICAgLy8g7LKY7J2MIOygkeyGje2VoCDrlYwg7J6F66Cl7ZWcIO2CpOqwgCDrp57ripTsp4Ag7ZmV7J247ZWY6rOgIOq4sOyWte2VnOuLpAogICAgYXN5bmMgdXNlS2V5KGtleSkgewogICAgICBjb25zdCBwcmV2ID0gc2VydmVyLmtleTsKICAgICAgc2VydmVyLmtleSA9IGtleTsKICAgICAgdHJ5IHsKICAgICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdwaW5nJykpOwogICAgICAgIHRyeSB7CiAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgLyog66y07IucICovCiAgICAgICAgfQogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgc2VydmVyLmtleSA9IHByZXY7CiAgICAgICAgdGhyb3cgZTsKICAgICAgfQogICAgfSwKCiAgICBmb3JnZXRLZXkoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oS0VZX1NUT1JFKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIC8qIOustOyLnCAqLwogICAgICB9CiAgICB9LAoKICAgIGFzeW5jIHNldEFwaUtleShhcGlLZXkpIHsKICAgICAgYXBwbHlTdGF0dXMoYXdhaXQgY2FsbEFwaSgnc2V0QXBpS2V5JywgeyBhcGlLZXkgfSkpOwogICAgfSwKCiAgICBhc3luYyBzZXRNb2RlbChtb2RlbCkgewogICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdzZXRNb2RlbCcsIHsgbW9kZWwgfSkpOwogICAgfSwKCiAgICAvLyDqs4Ttmo3Ct+yImOyehcK36rOE7KKMwrftlZnsirUg7KCV67O0IOyggOyepS4g7ISc67KE7JeQ64qUIOyeheugpeydtCDrqYjstpgg65KkIO2VnCDrsojsl5Ag67O064K464ukLgogICAgc2F2ZU1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSByZXR1cm4gc2F2ZUxvY2FsKCk7CiAgICAgIGNsZWFyVGltZW91dChtZXRhVGltZXIpOwogICAgICBtZXRhVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHN0b3JlLmZsdXNoTWV0YSgpLCA3MDApOwogICAgfSwKCiAgICBoYXNQZW5kaW5nTWV0YSgpIHsKICAgICAgcmV0dXJuICEhbWV0YVRpbWVyOwogICAgfSwKCiAgICBhc3luYyBmbHVzaE1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnIHx8ICFtZXRhVGltZXIpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KG1ldGFUaW1lcik7CiAgICAgIG1ldGFUaW1lciA9IG51bGw7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgY2FsbEFwaSgnc2F2ZU1ldGEnLCB7IG1ldGE6IG1ldGFPZihzdG9yZS5zdGF0ZSkgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcihg7ISk7KCVIOyggOyepSDsi6TtjKg6ICR7ZS5tZXNzYWdlfWApKTsKICAgICAgfQogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW99XSDihpIgW3tjYXRlZ29yeUlkLCBtZXRob2R9XQogICAgYXN5bmMgY2xhc3NpZnkoaXRlbXMpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICByZXR1cm4gaXRlbXMubWFwKChpdCkgPT4gTC5jbGFzc2lmeUxvY2FsKGl0Lm1lbW8sIHBsYW5Gb3JEYXRlKGl0LmRhdGUpLmNhdGVnb3JpZXMsIHN0b3JlLnN0YXRlLm1lcmNoYW50TWFwKSk7CiAgICAgIH0KICAgICAgYXdhaXQgc3RvcmUuZmx1c2hNZXRhKCk7CiAgICAgIHJldHVybiAoYXdhaXQgY2FsbEFwaSgnY2xhc3NpZnknLCB7IGl0ZW1zIH0pKS5yZXN1bHRzOwogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW8sIGtpbmQsIGFjY291bnRJZCwgY2F0ZWdvcnlJZCAoJ19fYXV0bycg7J2066m0IOyekOuPmSDrtoTrpZgpLCBtZXRob2QsIHNvdXJjZSwgcmF3fV0KICAgIGFzeW5jIGFkZFRyYW5zYWN0aW9ucyhpdGVtcykgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIGNvbnN0IGF1dG8gPSBpdGVtcy5maWx0ZXIoKGl0KSA9PiBpc0V4cGVuc2UoaXQpICYmIGl0LmNhdGVnb3J5SWQgPT09ICdfX2F1dG8nKTsKICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeShhdXRvKTsKICAgICAgICBhdXRvLmZvckVhY2goKGl0LCBpKSA9PiBPYmplY3QuYXNzaWduKGl0LCByZXNbaV0pKTsKICAgICAgICBjb25zdCBub3cgPSBub3dJU08oKTsKICAgICAgICBjb25zdCBhZGRlZCA9IGl0ZW1zLm1hcCgoaXQpID0+IHsKICAgICAgICAgIGNvbnN0IGV4cGVuc2UgPSBpc0V4cGVuc2UoaXQpOwogICAgICAgICAgY29uc3QgY2F0ZWdvcnlJZCA9IGV4cGVuc2UgJiYgaXQuY2F0ZWdvcnlJZCAmJiBpdC5jYXRlZ29yeUlkICE9PSAnX19hdXRvJyA/IGl0LmNhdGVnb3J5SWQgOiBudWxsOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgaWQ6IHVpZCgpLAogICAgICAgICAgICBkYXRlOiBpdC5kYXRlLAogICAgICAgICAgICBhbW91bnQ6IGl0LmFtb3VudCwKICAgICAgICAgICAgbWVtbzogaXQubWVtbywKICAgICAgICAgICAgY2F0ZWdvcnlJZCwKICAgICAgICAgICAgbWV0aG9kOiBjYXRlZ29yeUlkID8gaXQubWV0aG9kIHx8ICdtYW51YWwnIDogbnVsbCwKICAgICAgICAgICAgc291cmNlOiBpdC5zb3VyY2UgfHwgJ2FwcCcsCiAgICAgICAgICAgIHJhdzogaXQucmF3IHx8ICcnLAogICAgICAgICAgICBjcmVhdGVkQXQ6IG5vdywKICAgICAgICAgICAgY2xhc3NpZmllZEF0OiBub3csCiAgICAgICAgICAgIGtpbmQ6IGV4cGVuc2UgPyAnZXhwZW5zZScgOiBpdC5raW5kLAogICAgICAgICAgICBhY2NvdW50SWQ6IGl0LmFjY291bnRJZCB8fCBudWxsLAogICAgICAgICAgfTsKICAgICAgICB9KTsKICAgICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMucHVzaCguLi5hZGRlZCk7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuIGFkZGVkOwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgnYWRkVHJhbnNhY3Rpb25zJywgeyBpdGVtcyB9KTsKICAgICAgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLnB1c2goLi4uci5hZGRlZCk7CiAgICAgIHJldHVybiByLmFkZGVkOwogICAgfSwKCiAgICBhc3luYyB1cGRhdGVUcmFuc2FjdGlvbihpZCwgcGF0Y2gpIHsKICAgICAgY29uc3QgdCA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSB7CiAgICAgICAgT2JqZWN0LmFzc2lnbih0LCBwYXRjaCwgeyBjbGFzc2lmaWVkQXQ6IG5vd0lTTygpIH0pOwogICAgICAgIHNhdmVMb2NhbCgpOwogICAgICAgIHJldHVybiB0OwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgndXBkYXRlVHJhbnNhY3Rpb24nLCB7IGlkLCBwYXRjaCB9KTsKICAgICAgT2JqZWN0LmFzc2lnbih0LCByLnR4KTsKICAgICAgcmV0dXJuIHQ7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZVRyYW5zYWN0aW9uKGlkKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAncmVtb3RlJykgYXdhaXQgY2FsbEFwaSgnZGVsZXRlVHJhbnNhY3Rpb24nLCB7IGlkIH0pOwogICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMgPSBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSBzYXZlTG9jYWwoKTsKICAgIH0sCgogICAgLy8g6riw6rCEIOyViOydmCDsp4DstpzsnYQg6re4IOq4sOqwhCDqs4Ttmo3sl5Ag66ee7LawIOuLpOyLnCDrtoTrpZguIOuwmO2ZmDog64uk7IucIOu2hOulmO2VnCDsp4Dstpwg7IiYCiAgICBhc3luYyByZWNsYXNzaWZ5KHBlcmlvZCwgb25seVVuY2xhc3NpZmllZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIHsKICAgICAgICBhd2FpdCBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgncmVjbGFzc2lmeScsIHsgc3RhcnQ6IHBlcmlvZC5zdGFydCwgZW5kOiBwZXJpb2QuZW5kLCBvbmx5VW5jbGFzc2lmaWVkIH0pOwogICAgICAgIGZvciAoY29uc3QgdSBvZiByLnVwZGF0ZWQpIE9iamVjdC5hc3NpZ24oc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLmZpbmQoKHQpID0+IHQuaWQgPT09IHUuaWQpIHx8IHt9LCB1KTsKICAgICAgICByZXR1cm4gci51cGRhdGVkLmxlbmd0aDsKICAgICAgfQogICAgICBjb25zdCBwbGFuID0gcGxhbkZvckRhdGUocGVyaW9kLnN0YXJ0KTsKICAgICAgY29uc3Qga25vd24gPSBuZXcgU2V0KHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgICAgY29uc3QgdGFyZ2V0cyA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHsKICAgICAgICBpZiAodC5kYXRlIDwgcGVyaW9kLnN0YXJ0IHx8IHQuZGF0ZSA+IHBlcmlvZC5lbmQgfHwgTC5raW5kT2YodCkgIT09ICdleHBlbnNlJykgcmV0dXJuIGZhbHNlOwogICAgICAgIGNvbnN0IGV4aXN0cyA9IGtub3duLmhhcyh0LmNhdGVnb3J5SWQpOwogICAgICAgIHJldHVybiBvbmx5VW5jbGFzc2lmaWVkID8gIWV4aXN0cyA6ICEodC5tZXRob2QgPT09ICdtYW51YWwnICYmIGV4aXN0cyk7CiAgICAgIH0pOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeSh0YXJnZXRzKTsKICAgICAgY29uc3Qgbm93ID0gbm93SVNPKCk7CiAgICAgIHRhcmdldHMuZm9yRWFjaCgodCwgaSkgPT4gT2JqZWN0LmFzc2lnbih0LCByZXNbaV0sIHsgY2xhc3NpZmllZEF0OiBub3cgfSkpOwogICAgICBzYXZlTG9jYWwoKTsKICAgICAgcmV0dXJuIHRhcmdldHMubGVuZ3RoOwogICAgfSwKCiAgICBhc3luYyByZWZyZXNoKCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIGF3YWl0IHN0b3JlLmluaXQoKTsKICAgIH0sCgogICAgLy8g7ISc67KEIOyXsOqysCDtmZXsnbggKOyXsOqysCDsoITsnbTrnbwg7KO87IaM7JmAIO2CpOulvCDsp4HsoJEg67Cb64qU64ukKQogICAgcGluZyh1cmwsIGtleSkgewogICAgICByZXR1cm4gY2FsbEFwaSgncGluZycsIHt9LCB7IHVybCwga2V5IH0pOwogICAgfSwKCiAgICBjb25uZWN0KHVybCwga2V5LCBtaWdyYXRlKSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFUlZFUl9LRVksIEpTT04uc3RyaW5naWZ5KHsgdXJsLCBrZXkgfSkpOwogICAgICBpZiAobWlncmF0ZSkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUlHUkFURV9LRVksICcxJyk7CiAgICB9LAoKICAgIGRpc2Nvbm5lY3QoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU0VSVkVSX0tFWSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICAvKiDrrLTsi5wgKi8KICAgICAgfQogICAgfSwKCiAgICAvLyDshJzrsoTsl5Ag7Jew6rKw7ZWcIOynge2bhCDtlZwg67KIOiDsnbQg6riw6riw7JeQIOyeiOuNmCDrjbDsnbTthLDrpbwg7Jiu6ri47KeACiAgICB0YWtlTWlncmF0aW9uKCkgewogICAgICB0cnkgewogICAgICAgIGlmIChzdG9yZS5tb2RlICE9PSAncmVtb3RlJyB8fCBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNSUdSQVRFX0tFWSkgIT09ICcxJykgcmV0dXJuIG51bGw7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oTUlHUkFURV9LRVkpOwogICAgICAgIHJldHVybiByZWFkTG9jYWxTdGF0ZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgIH0sCgogICAgLy8g67Cx7JeFKOuYkOuKlCDsnbQg6riw6riwIOuNsOydtO2EsCkg67aI65+s7Jik6riwCiAgICBhc3luYyBpbXBvcnRTdGF0ZShpbXBvcnRlZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIHN0b3JlLnN0YXRlID0gaW1wb3J0ZWQ7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IHR4cyA9IGltcG9ydGVkLnRyYW5zYWN0aW9uczsKICAgICAgc3RvcmUuc3RhdGUgPSB7IC4uLmltcG9ydGVkLCB0cmFuc2FjdGlvbnM6IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucyB9OwogICAgICBhd2FpdCBjYWxsQXBpKCdzYXZlTWV0YScsIHsgbWV0YTogbWV0YU9mKHN0b3JlLnN0YXRlKSB9KTsKICAgICAgY29uc3QgZnJlc2ggPSB0eHMuZmlsdGVyKCh0KSA9PiAhTC5pc0R1cGxpY2F0ZSh0LCBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMpKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmcmVzaC5sZW5ndGg7IGkgKz0gMjAwKSB7CiAgICAgICAgYXdhaXQgc3RvcmUuYWRkVHJhbnNhY3Rpb25zKAogICAgICAgICAgZnJlc2guc2xpY2UoaSwgaSArIDIwMCkubWFwKCh0KSA9PiAoewogICAgICAgICAgICBkYXRlOiB0LmRhdGUsCiAgICAgICAgICAgIGFtb3VudDogdC5hbW91bnQsCiAgICAgICAgICAgIG1lbW86IHQubWVtbywKICAgICAgICAgICAga2luZDogTC5raW5kT2YodCksCiAgICAgICAgICAgIGFjY291bnRJZDogdC5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICAgICAgY2F0ZWdvcnlJZDogdC5jYXRlZ29yeUlkIHx8IG51bGwsCiAgICAgICAgICAgIG1ldGhvZDogdC5tZXRob2QgfHwgKHQuY2F0ZWdvcnlJZCA/ICdtYW51YWwnIDogbnVsbCksCiAgICAgICAgICAgIHNvdXJjZTogdC5zb3VyY2UgfHwgJ2ltcG9ydCcsCiAgICAgICAgICAgIHJhdzogdC5yYXcgfHwgJycsCiAgICAgICAgICB9KSkKICAgICAgICApOwogICAgICB9CiAgICB9LAoKICAgIHJlc2V0KCkgewogICAgICBzdG9yZS5zdGF0ZSA9IEwuZGVmYXVsdFN0YXRlKCk7CiAgICAgIHNhdmVMb2NhbCgpOwogICAgfSwKICB9KTsKCiAgcm9vdC5CdWRnZXRTdG9yZSA9IHN0b3JlOwp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/app.js\", \"Lyog7KeA7LacIOq0gOumrCDslbEg7ZmU66m0LiDqs4TsgrDsnYAganMvbG9naWMuanMsIOyggOyepeydgCBqcy9zdG9yZS5qcywg7LCo7Yq464qUIGpzL2NoYXJ0cy5qcyAqLwooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgTCA9IHdpbmRvdy5CdWRnZXRMb2dpYzsKICBjb25zdCBDID0gd2luZG93LkJ1ZGdldENoYXJ0czsKICBjb25zdCBzdG9yZSA9IHdpbmRvdy5CdWRnZXRTdG9yZTsKICBjb25zdCBTID0gKCkgPT4gc3RvcmUuc3RhdGU7CgogIC8vIC0tLS0tLS0tLS0g7Jyg7Yu4IC0tLS0tLS0tLS0KCiAgY29uc3QgJCA9IChzZWwpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTsKICBjb25zdCAkJCA9IChzZWwpID0+IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCldOwogIGNvbnN0IHdvbiA9IChuKSA9PiBgJHtNYXRoLnJvdW5kKG4pLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeybkGA7CiAgY29uc3QgdWlkID0gKCkgPT4gRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KTsKICBjb25zdCBub3dJU08gPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CgogIGZ1bmN0aW9uIGVzYyhzKSB7CiAgICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgKGMpID0+ICh7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjXSkpOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRJbnB1dChzKSB7CiAgICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHMgfHwgJycpLnJlcGxhY2UoL1teXGQtXS9nLCAnJyk7CiAgICBpZiAoIWNsZWFuZWQgfHwgY2xlYW5lZCA9PT0gJy0nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IG4gPSBOdW1iZXIoY2xlYW5lZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlKGlzbykgewogICAgY29uc3QgeyB5LCBtLCBkIH0gPSBMLnBhcnNlSVNPKGlzbyk7CiAgICByZXR1cm4gYCR7eX0uJHtTdHJpbmcobSkucGFkU3RhcnQoMiwgJzAnKX0uJHtTdHJpbmcoZCkucGFkU3RhcnQoMiwgJzAnKX1gOwogIH0KCiAgY29uc3QgRE9XID0gWyfsnbwnLCAn7JuUJywgJ+2ZlCcsICfsiJgnLCAn66qpJywgJ+q4iCcsICfthqAnXTsKICBmdW5jdGlvbiBkb3dPZihpc28pIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gTC5wYXJzZUlTTyhpc28pOwogICAgcmV0dXJuIG5ldyBEYXRlKERhdGUuVVRDKHksIG0gLSAxLCBkKSkuZ2V0VVRDRGF5KCk7CiAgfQoKICBmdW5jdGlvbiBmbXREYXkoaXNvKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08oaXNvKTsKICAgIHJldHVybiBgJHttfeyblCAke2R97J28ICR7RE9XW2Rvd09mKGlzbyldfeyalOydvGA7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlVGltZShpc29UaW1lKSB7CiAgICBpZiAoIWlzb1RpbWUpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShpc29UaW1lKTsKICAgIGlmIChpc05hTihkKSkgcmV0dXJuICcnOwogICAgcmV0dXJuIGAke2QuZ2V0TW9udGgoKSArIDF9LyR7ZC5nZXREYXRlKCl9ICR7U3RyaW5nKGQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcoZC5nZXRNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICB9CgogIGxldCB0b2FzdFRpbWVyOwogIGZ1bmN0aW9uIHRvYXN0KG1zZywgbXMgPSAyNjAwKSB7CiAgICBjb25zdCBlbCA9ICQoJyN0b2FzdCcpOwogICAgZWwudGV4dENvbnRlbnQgPSBtc2c7CiAgICBlbC5oaWRkZW4gPSBmYWxzZTsKICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsKICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IChlbC5oaWRkZW4gPSB0cnVlKSwgbXMpOwogIH0KICBzdG9yZS5vbkVycm9yID0gKGUpID0+IHRvYXN0KGUubWVzc2FnZSwgNTAwMCk7CgogIGxldCBidXN5Q291bnQgPSAwOwogIGFzeW5jIGZ1bmN0aW9uIGJ1c3kobGFiZWwsIGZuKSB7CiAgICBidXN5Q291bnQgKz0gMTsKICAgICQoJyNidXN5JykuaGlkZGVuID0gZmFsc2U7CiAgICBpZiAobGFiZWwpIHRvYXN0KGxhYmVsLCA2MDAwMCk7CiAgICB0cnkgewogICAgICByZXR1cm4gYXdhaXQgZm4oKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgdG9hc3QoYOyYpOulmDogJHtlLm1lc3NhZ2UgfHwgZX1gLCA1MDAwKTsKICAgICAgdGhyb3cgZTsKICAgIH0gZmluYWxseSB7CiAgICAgIGJ1c3lDb3VudCAtPSAxOwogICAgICBpZiAoIWJ1c3lDb3VudCkgJCgnI2J1c3knKS5oaWRkZW4gPSB0cnVlOwogICAgICBpZiAobGFiZWwgJiYgJCgnI3RvYXN0JykudGV4dENvbnRlbnQgPT09IGxhYmVsKSAkKCcjdG9hc3QnKS5oaWRkZW4gPSB0cnVlOwogICAgfQogIH0KCiAgLy8gYnVzeSDqsIAg7J2066+4IOyYpOulmOulvCDslYzroLjsnLzrr4DroZwg7J2067Kk7Yq4IO2VuOuTpOufrOyXkOyEnOuKlCDsgrztgqjri6QKICBjb25zdCBxdWlldCA9IChmbikgPT4gKC4uLmFyZ3MpID0+IFByb21pc2UucmVzb2x2ZShmbiguLi5hcmdzKSkuY2F0Y2goKCkgPT4ge30pOwoKICBmdW5jdGlvbiBmb3JtYXRPbkJsdXIoaW5wdXQpIHsKICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiB7CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KGlucHV0LnZhbHVlKTsKICAgICAgaWYgKG4gIT09IG51bGwpIGlucHV0LnZhbHVlID0gbi50b0xvY2FsZVN0cmluZygna28tS1InKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gY29weVRleHQodGV4dCwgaW5wdXQpIHsKICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB0b2FzdCgn67O17IKs7ZaI7Iq164uI64ukLicpOwogICAgY29uc3QgZmFsbGJhY2sgPSAoKSA9PiB7CiAgICAgIGlucHV0LnNlbGVjdCgpOwogICAgICB0cnkgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjb3B5Jyk7CiAgICAgICAgZG9uZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgdG9hc3QoJ+q4uOqyjCDriIzrn6wg7KeB7KCRIOuzteyCrO2VtCDso7zshLjsmpQuJyk7CiAgICAgIH0KICAgIH07CiAgICBpZiAobmF2aWdhdG9yLmNsaXBib2FyZCkgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCkudGhlbihkb25lLCBmYWxsYmFjayk7CiAgICBlbHNlIGZhbGxiYWNrKCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyDge2DnCAtLS0tLS0tLS0tCgogIGxldCBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCAxKTsKICBsZXQgY3VycmVudFBhZ2UgPSAnaG9tZSc7CiAgbGV0IHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgY29uc3QgbGlzdFN0YXRlID0geyBzZWFyY2g6ICcnLCBraW5kOiAnYWxsJywgY2F0ZWdvcnk6ICdhbGwnLCBhY2NvdW50OiAnYWxsJyB9OwogIGxldCBtYW51YWxLaW5kID0gJ2V4cGVuc2UnOwoKICBjb25zdCBwbGFuRm9yRGF0ZSA9IChkYXRlKSA9PiBzdG9yZS5wbGFuRm9yRGF0ZShkYXRlKTsKICBjb25zdCBjdXJyZW50UGxhbiA9ICgpID0+IEwucGxhbkZvcihTKCksIGN1cnJlbnRQZXJpb2Qua2V5KTsKCiAgZnVuY3Rpb24gY2F0ZWdvcnlJbmZvKGlkLCBjYXRlZ29yaWVzID0gY3VycmVudFBsYW4oKS5jYXRlZ29yaWVzKSB7CiAgICBjb25zdCBpID0gY2F0ZWdvcmllcy5maW5kSW5kZXgoKGMpID0+IGMuaWQgPT09IGlkKTsKICAgIHJldHVybiBpID49IDAgPyB7IG5hbWU6IGNhdGVnb3JpZXNbaV0ubmFtZSwgY29sb3JJbmRleDogaSB9IDogeyBuYW1lOiAn66+467aE66WYJywgY29sb3JJbmRleDogLTEgfTsKICB9CgogIGZ1bmN0aW9uIGFjY291bnROYW1lKGlkKSB7CiAgICBjb25zdCBhID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgIHJldHVybiBhID8gYS5uYW1lIHx8IGAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+y5tOuTnCcgOiAn6rOE7KKMJ30gJHthLmxhc3Q0fWAgOiAnJzsKICB9CgogIGZ1bmN0aW9uIGNhdGVnb3J5T3B0aW9ucyhjYXRlZ29yaWVzLCBzZWxlY3RlZCwgeyBpbmNsdWRlQXV0byA9IGZhbHNlIH0gPSB7fSkgewogICAgY29uc3Qgb3B0cyA9IFtdOwogICAgaWYgKGluY2x1ZGVBdXRvKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9Il9fYXV0byI+7J6Q64+ZIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfTwvb3B0aW9uPmApOwogICAgb3B0cy5wdXNoKGA8b3B0aW9uIHZhbHVlPSIiICR7IXNlbGVjdGVkID8gJ3NlbGVjdGVkJyA6ICcnfT7rr7jrtoTrpZg8L29wdGlvbj5gKTsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGMuaWQpfSIgJHtjLmlkID09PSBzZWxlY3RlZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKTsKICAgIHJldHVybiBvcHRzLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gYWNjb3VudE9wdGlvbnMoc2VsZWN0ZWQsIGVtcHR5TGFiZWwgPSAn7ISg7YOdIOyViCDtlagnKSB7CiAgICByZXR1cm4gW2A8b3B0aW9uIHZhbHVlPSIiPiR7ZW1wdHlMYWJlbH08L29wdGlvbj5gXQogICAgICAuY29uY2F0KFMoKS5hY2NvdW50cy5tYXAoKGEpID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhhLmlkKX0iICR7YS5pZCA9PT0gc2VsZWN0ZWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGFjY291bnROYW1lKGEuaWQpKX08L29wdGlvbj5gKSkKICAgICAgLmpvaW4oJycpOwogIH0KCiAgY29uc3QgTUVUSE9EX0xBQkVMID0geyBhaTogJ0FJJywgbGVhcm5lZDogJ+q4sOyWtScsIGtleXdvcmQ6ICftgqTsm4zrk5wnLCBtYW51YWw6ICfsp4HsoJEnIH07CiAgY29uc3QgbWV0aG9kVGFnID0gKG0pID0+IChtICYmIE1FVEhPRF9MQUJFTFttXSA/IGA8c3BhbiBjbGFzcz0idGFnIj4ke01FVEhPRF9MQUJFTFttXX08L3NwYW4+YCA6ICcnKTsKCiAgLy8gLS0tLS0tLS0tLSDtjpjsnbTsp4Ag7J2064+ZIC0tLS0tLS0tLS0KCiAgY29uc3QgUEFHRVMgPSB7CiAgICBob21lOiB7IHRpdGxlOiAn7ZmIJywgcGVyaW9kOiB0cnVlIH0sCiAgICBjYWxlbmRhcjogeyB0aXRsZTogJ+uLrOugpScsIHBlcmlvZDogdHJ1ZSB9LAogICAgbGlzdDogeyB0aXRsZTogJ+uCtOyXrScsIHBlcmlvZDogdHJ1ZSB9LAogICAgc29ydDogeyB0aXRsZTogJ+uvuOu2hOulmCDsoJXrpqwnLCBwZXJpb2Q6IHRydWUgfSwKICAgIHJlcG9ydDogeyB0aXRsZTogJ+umrO2PrO2KuCcsIHBlcmlvZDogdHJ1ZSB9LAogICAgYXNzZXRzOiB7IHRpdGxlOiAn7J6Q7IKwJywgcGVyaW9kOiB0cnVlIH0sCiAgICBwbGFuOiB7IHRpdGxlOiAn7JiI7IKwIOqzhO2ajScsIHBlcmlvZDogdHJ1ZSB9LAogICAgYWRkOiB7IHRpdGxlOiAn7KeA7LacwrfsiJjsnoUg7J6F66ClJywgcGVyaW9kOiBmYWxzZSB9LAogICAgc2V0dGluZ3M6IHsgdGl0bGU6ICfshKTsoJUnLCBwZXJpb2Q6IGZhbHNlIH0sCiAgfTsKCiAgZnVuY3Rpb24gc2hvd1BhZ2UobmFtZSwgeyBwdXNoID0gdHJ1ZSwga2VlcFBlcmlvZCA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKCFQQUdFU1tuYW1lXSkgbmFtZSA9ICdob21lJzsKICAgIGN1cnJlbnRQYWdlID0gbmFtZTsKICAgIC8vIOuvuOu2hOulmCDsoJXrpqzripQg65Ok7Ja07JisIOuVjOuniOuLpCDsnbTrsogg6riw6rCEKOyEpOygle2VnCDsi5zsnpHsnbwg6riw7KSAKeu2gO2EsCDrs7Tsl6zspIDri6QKICAgIGlmIChuYW1lID09PSAnc29ydCcgJiYgIWtlZXBQZXJpb2QpIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAkJCgnLnBhZ2UnKS5mb3JFYWNoKChwKSA9PiBwLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHAuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkJCgnLm5hdi1pdGVtJykuZm9yRWFjaCgoYikgPT4gYi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBiLmRhdGFzZXQucGFnZSA9PT0gbmFtZSkpOwogICAgJCQoJy5ib3R0b20tbmF2IFtkYXRhLXBhZ2VdJykuZm9yRWFjaCgoYikgPT4gYi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBiLmRhdGFzZXQucGFnZSA9PT0gbmFtZSkpOwogICAgJCgnI3BhZ2UtdGl0bGUnKS50ZXh0Q29udGVudCA9IFBBR0VTW25hbWVdLnRpdGxlOwogICAgJCgnI3BlcmlvZC1uYXYnKS5oaWRkZW4gPSAhUEFHRVNbbmFtZV0ucGVyaW9kOwogICAgY2xvc2VNZW51KCk7CiAgICAvLyDqtazquIAgQXBwcyBTY3JpcHQg7ZmU66m0KGlmcmFtZSnsspjrn7wg7KO87IaM66W8IOuquyDrsJTqvrjripQg6rOz7JeQ7ISc64+EIOydtOuPmeydgCDrkJjqsowKICAgIHRyeSB7CiAgICAgIGlmIChwdXNoICYmIGxvY2F0aW9uLmhhc2ggIT09IGAjJHtuYW1lfWApIGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsICcnLCBgIyR7bmFtZX1gKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLyog66y07IucICovCiAgICB9CiAgICB3aW5kb3cuc2Nyb2xsVG8oMCwgMCk7CiAgICByZW5kZXIoKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KCkgewogICAgJCgnI3NpZGViYXInKS5jbGFzc0xpc3QuYWRkKCdvcGVuJyk7CiAgICAkKCcjc2NyaW0nKS5oaWRkZW4gPSBmYWxzZTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlTWVudSgpIHsKICAgICQoJyNzaWRlYmFyJykuY2xhc3NMaXN0LnJlbW92ZSgnb3BlbicpOwogICAgJCgnI3NjcmltJykuaGlkZGVuID0gdHJ1ZTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rO17Ya1IOuouOumrCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckNocm9tZSgpIHsKICAgIGNvbnN0IGNoaXAgPSAkKCcjY29ubi1zdGF0dXMnKTsKICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSB7CiAgICAgIGNoaXAudGV4dENvbnRlbnQgPSAn7J20IOq4sOq4sOyXkOunjCDsoIDsnqUnOwogICAgICBjaGlwLmNsYXNzTmFtZSA9ICdjaGlwJzsKICAgIH0gZWxzZSB7CiAgICAgIGNoaXAudGV4dENvbnRlbnQgPSBzdG9yZS5haUVuYWJsZWQgPyAn6rWs6riAIOyLnO2KuCDCtyBBSSDrtoTrpZgnIDogJ+q1rOq4gCDsi5ztirggwrcgQUkg6rq87KeQJzsKICAgICAgY2hpcC5jbGFzc05hbWUgPSBgY2hpcCAke3N0b3JlLmFpRW5hYmxlZCA/ICdvbicgOiAnJ31gOwogICAgfQogICAgJCgnI3JlZnJlc2gtYnRuJykuaGlkZGVuID0gc3RvcmUubW9kZSAhPT0gJ3JlbW90ZSc7CiAgICBjb25zdCB1bnNvcnRlZCA9IEwudW5jbGFzc2lmaWVkQnlQZXJpb2QoUygpKS5yZWR1Y2UoKG4sIGUpID0+IG4gKyBlLmNvdW50LCAwKTsKICAgICQoJyNzb3J0LWNvdW50JykudGV4dENvbnRlbnQgPSB1bnNvcnRlZCA+IDk5ID8gJzk5KycgOiBTdHJpbmcodW5zb3J0ZWQpOwogICAgJCgnI3NvcnQtY291bnQnKS5oaWRkZW4gPSAhdW5zb3J0ZWQ7CgogICAgY29uc3QgcCA9IGN1cnJlbnRQZXJpb2Q7CiAgICAkKCcjcGVyaW9kLXRleHQnKS50ZXh0Q29udGVudCA9IGAke2ZtdERhdGUocC5zdGFydCl9IH4gJHtmbXREYXRlKHAuZW5kKS5zbGljZSg1KX1gOwogICAgY29uc3QgdG9kYXkgPSBMLnRvZGF5SVNPKCk7CiAgICBsZXQgc3ViOwogICAgaWYgKHRvZGF5ID49IHAuc3RhcnQgJiYgdG9kYXkgPD0gcC5lbmQpIHN1YiA9IGDsnbTrsogg6riw6rCEIMK3ICR7TC5kaWZmRGF5cyh0b2RheSwgcC5lbmQpICsgMX3snbwg64Ko7J2MYDsKICAgIGVsc2UgaWYgKHRvZGF5ID4gcC5lbmQpIHN1YiA9ICfsp4Drgpwg6riw6rCEJzsKICAgIGVsc2Ugc3ViID0gJ+uLpOqwgOyYpOuKlCDquLDqsIQnOwogICAgJCgnI3BlcmlvZC1zdWInKS50ZXh0Q29udGVudCA9IHN1YjsKICB9CgogIC8vIC0tLS0tLS0tLS0g7Yi07YyBIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gYXR0YWNoVG9vbHRpcChlbCwgaHRtbCkgewogICAgY29uc3QgdGlwID0gJCgnI3Rvb2x0aXAnKTsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7CiAgICAgIHRpcC5pbm5lckhUTUwgPSBodG1sKCk7CiAgICAgIHRpcC5oaWRkZW4gPSBmYWxzZTsKICAgIH0pOwogICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGUpID0+IHsKICAgICAgY29uc3QgeCA9IE1hdGgubWluKGUuY2xpZW50WCArIDE0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHRpcC5vZmZzZXRXaWR0aCAtIDgpOwogICAgICB0aXAuc3R5bGUubGVmdCA9IGAke3h9cHhgOwogICAgICB0aXAuc3R5bGUudG9wID0gYCR7ZS5jbGllbnRZICsgMTR9cHhgOwogICAgfSk7CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4gKHRpcC5oaWRkZW4gPSB0cnVlKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOqxsOuemCDtlZwg7KSEIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gdHhSb3codCwgeyBlZGl0YWJsZSA9IHRydWUgfSA9IHt9KSB7CiAgICBjb25zdCBraW5kID0gTC5raW5kT2YodCk7CiAgICBjb25zdCBjYXRzID0gcGxhbkZvckRhdGUodC5kYXRlKS5jYXRlZ29yaWVzOwogICAgY29uc3QgaW5mbyA9IGNhdGVnb3J5SW5mbyh0LmNhdGVnb3J5SWQsIGNhdHMpOwogICAgbGV0IGljb247CiAgICBsZXQgYW1vdW50OwogICAgaWYgKGtpbmQgPT09ICdpbmNvbWUnKSB7CiAgICAgIGljb24gPSAnPGRpdiBjbGFzcz0idHgtaWNvbiIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tYWNjZW50KSI+KzwvZGl2Pic7CiAgICAgIGFtb3VudCA9IGA8c3BhbiBjbGFzcz0idHgtYW1vdW50IHBsdXMiPiske3dvbih0LmFtb3VudCl9PC9zcGFuPmA7CiAgICB9IGVsc2UgaWYgKGtpbmQgPT09ICd0cmFuc2ZlcicpIHsKICAgICAgaWNvbiA9ICc8ZGl2IGNsYXNzPSJ0eC1pY29uIGdyYXkiPuKGlDwvZGl2Pic7CiAgICAgIGFtb3VudCA9IGA8c3BhbiBjbGFzcz0idHgtYW1vdW50IG5ldXRyYWwiPiR7d29uKHQuYW1vdW50KX08L3NwYW4+YDsKICAgIH0gZWxzZSB7CiAgICAgIGljb24gPSBgPGRpdiBjbGFzcz0idHgtaWNvbiAke2luZm8uY29sb3JJbmRleCA8IDAgPyAnZ3JheScgOiAnJ30iIHN0eWxlPSIke2luZm8uY29sb3JJbmRleCA+PSAwID8gYGJhY2tncm91bmQ6JHtDLnNlcmllc0NvbG9yKGluZm8uY29sb3JJbmRleCl9YCA6ICcnfSI+JHtlc2MoaW5mby5uYW1lLnNsaWNlKDAsIDEpKX08L2Rpdj5gOwogICAgICBhbW91bnQgPSBgPHNwYW4gY2xhc3M9InR4LWFtb3VudCAke3QuYW1vdW50IDwgMCA/ICdwbHVzJyA6ICcnfSI+JHt0LmFtb3VudCA8IDAgPyAnKycgOiAnJ30ke3dvbihNYXRoLmFicyh0LmFtb3VudCkpfTwvc3Bhbj5gOwogICAgfQogICAgY29uc3QgbWV0YSA9IFtdOwogICAgaWYgKGVkaXRhYmxlKSB7CiAgICAgIC8vIO2VreuqqeqzvCDsooXrpZgo7J6F6riIwrfsnbTssrQp66W8IO2VnCDsubjsl5DshJwg6rOg66W464ukCiAgICAgIGNvbnN0IGN1cnJlbnQgPSBraW5kICE9PSAnZXhwZW5zZScgPyBga2luZDoke2tpbmR9YCA6IGluZm8uY29sb3JJbmRleCA+PSAwID8gdC5jYXRlZ29yeUlkIDogJyc7CiAgICAgIG1ldGEucHVzaChgPHNlbGVjdCBjbGFzcz0idHgtY2F0IiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9Iu2VreuqqSI+CiAgICAgICAgJHtjYXRlZ29yeU9wdGlvbnMoY2F0cywgY3VycmVudCl9CiAgICAgICAgPG9wdGdyb3VwIGxhYmVsPSLsp4DstpzsnbQg7JWE64uYIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtpbmQ6aW5jb21lIiAke2N1cnJlbnQgPT09ICdraW5kOmluY29tZScgPyAnc2VsZWN0ZWQnIDogJyd9Puyeheq4iDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ia2luZDp0cmFuc2ZlciIgJHtjdXJyZW50ID09PSAna2luZDp0cmFuc2ZlcicgPyAnc2VsZWN0ZWQnIDogJyd9PuuCtCDqs4Tsoowg7J207LK0PC9vcHRpb24+CiAgICAgICAgPC9vcHRncm91cD4KICAgICAgPC9zZWxlY3Q+YCk7CiAgICB9IGVsc2UgewogICAgICBtZXRhLnB1c2goZXNjKGtpbmQgPT09ICdpbmNvbWUnID8gJ+yeheq4iCcgOiBraW5kID09PSAndHJhbnNmZXInID8gJ+uCtCDqs4Tsoowg7J207LK0JyA6IGluZm8ubmFtZSkpOwogICAgfQogICAgaWYgKGtpbmQgPT09ICdleHBlbnNlJyAmJiBpbmZvLmNvbG9ySW5kZXggPj0gMCkgbWV0YS5wdXNoKG1ldGhvZFRhZyh0Lm1ldGhvZCkpOwogICAgaWYgKHQuYWNjb3VudElkICYmIGFjY291bnROYW1lKHQuYWNjb3VudElkKSkgbWV0YS5wdXNoKGA8c3Bhbj4ke2VzYyhhY2NvdW50TmFtZSh0LmFjY291bnRJZCkpfTwvc3Bhbj5gKTsKICAgIGlmICh0LnNvdXJjZSA9PT0gJ3NtcycgfHwgdC5zb3VyY2UgPT09ICdiYW5rJykgbWV0YS5wdXNoKGA8c3BhbiBjbGFzcz0idGFnIj4ke3Quc291cmNlID09PSAnYmFuaycgPyAn7J2A7ZaJIOyVjOumvCcgOiAn66y47J6QJ308L3NwYW4+YCk7CiAgICByZXR1cm4gYAogICAgICA8ZGl2IGNsYXNzPSJ0eCI+CiAgICAgICAgJHtpY29ufQogICAgICAgIDxkaXYgY2xhc3M9InR4LW1haW4iPgogICAgICAgICAgPGRpdiBjbGFzcz0idHgtbWVtbyI+JHtlc2ModC5tZW1vKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InR4LW1ldGEiPiR7bWV0YS5qb2luKCcnKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0eC1yaWdodCI+CiAgICAgICAgICAke2Ftb3VudH0KICAgICAgICAgICR7ZWRpdGFibGUgPyBgPGJ1dHRvbiBjbGFzcz0ibGluay1idG4gdHgtZGVsIiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9IuyCreygnCI+7IKt7KCcPC9idXR0b24+YCA6ICcnfQogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj5gOwogIH0KCiAgLy8g64Kg7Kec67OE66GcIOustuydgCDrqqnroZ0KICBmdW5jdGlvbiB0eEdyb3Vwcyh0eHMsIG9wdHMpIHsKICAgIGNvbnN0IHNvcnRlZCA9IFsuLi50eHNdLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBjb25zdCBncm91cHMgPSBbXTsKICAgIGZvciAoY29uc3QgdCBvZiBzb3J0ZWQpIHsKICAgICAgbGV0IGcgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdOwogICAgICBpZiAoIWcgfHwgZy5kYXRlICE9PSB0LmRhdGUpIGdyb3Vwcy5wdXNoKChnID0geyBkYXRlOiB0LmRhdGUsIGl0ZW1zOiBbXSB9KSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgIH0KICAgIHJldHVybiBncm91cHMKICAgICAgLm1hcCgoZykgPT4gewogICAgICAgIGNvbnN0IHNwZW50ID0gZy5pdGVtcy5maWx0ZXIoKHQpID0+IEwua2luZE9mKHQpID09PSAnZXhwZW5zZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgICAgICByZXR1cm4gYDxkaXYgY2xhc3M9InR4LWRhdGUiPjxzcGFuPiR7Zm10RGF5KGcuZGF0ZSl9PC9zcGFuPjxzcGFuPiR7c3BlbnQgPyBg7KeA7LacICR7d29uKHNwZW50KX1gIDogJyd9PC9zcGFuPjwvZGl2PiR7Zy5pdGVtcy5tYXAoKHQpID0+IHR4Um93KHQsIG9wdHMpKS5qb2luKCcnKX1gOwogICAgICB9KQogICAgICAuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBiaW5kVHhFdmVudHMoY29udGFpbmVyKSB7CiAgICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnLnR4LWNhdCcpLmZvckVhY2goKHMpID0+IHMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB0ID0gUygpLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBzLmRhdGFzZXQuaWQpOwogICAgICBpZiAocy52YWx1ZS5zdGFydHNXaXRoKCdraW5kOicpKSB7CiAgICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS51cGRhdGVUcmFuc2FjdGlvbih0LmlkLCB7IGtpbmQ6IHMudmFsdWUuc2xpY2UoNSksIGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9KSk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IGtleSA9IEwubm9ybWFsaXplTWVyY2hhbnQodC5tZW1vKTsKICAgICAgaWYgKHMudmFsdWUpIFMoKS5tZXJjaGFudE1hcFtrZXldID0gcy52YWx1ZTsKICAgICAgZWxzZSBkZWxldGUgUygpLm1lcmNoYW50TWFwW2tleV07CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kOiAnZXhwZW5zZScsIGNhdGVnb3J5SWQ6IHMudmFsdWUgfHwgbnVsbCwgbWV0aG9kOiBzLnZhbHVlID8gJ21hbnVhbCcgOiBudWxsIH0pKTsKICAgICAgdG9hc3QoYCcke3QubWVtb30nIOydgCjripQpIOyVnuycvOuhnCAke2NhdGVnb3J5SW5mbyh0LmNhdGVnb3J5SWQsIHBsYW5Gb3JEYXRlKHQuZGF0ZSkuY2F0ZWdvcmllcykubmFtZX0o7Jy8KeuhnCDrtoTrpZjtlanri4jri6QuYCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpKTsKICAgIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCcudHgtZGVsJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgdCA9IFMoKS50cmFuc2FjdGlvbnMuZmluZCgoeCkgPT4geC5pZCA9PT0gYi5kYXRhc2V0LmlkKTsKICAgICAgaWYgKCFjb25maXJtKGAnJHt0Lm1lbW99JyAke3dvbih0LmFtb3VudCl9IOuCtOyXreydhCDsgq3soJztlaDquYzsmpQ/YCkpIHJldHVybjsKICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS5kZWxldGVUcmFuc2FjdGlvbih0LmlkKSk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7ZmIIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVySW5jb21lQm94KHN1bSkgewogICAgY29uc3QgYm94ID0gJCgnI2luY29tZS1ib3gnKTsKICAgIGNvbnN0IHByZXYgPSBMLnNoaWZ0UGVyaW9kKGN1cnJlbnRQZXJpb2QsIC0xLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgY29uc3QgcHJldkluY29tZSA9IFMoKS5pbmNvbWVzW3ByZXYua2V5XTsKCiAgICBpZiAoIXN1bS5oYXNJbmNvbWUgfHwgYm94LmRhdGFzZXQuZWRpdGluZyA9PT0gJzEnKSB7CiAgICAgIGJveC5jbGFzc0xpc3QuYWRkKCdpbmNvbWUtcHJvbXB0Jyk7CiAgICAgIGNvbnN0IHJlY2VpdmVkID0gc3VtLmluY29tZVJlY2VpdmVkID4gMCA/IGA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imdob3N0LWJ0biIgaWQ9ImluY29tZS1yZWNlaXZlZCI+67Cb7J2AIOyeheq4iCDtlanqs4TroZwgKCR7d29uKHN1bS5pbmNvbWVSZWNlaXZlZCl9KTwvYnV0dG9uPmAgOiAnJzsKICAgICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+JHtzdW0uaGFzSW5jb21lID8gJ+uLueq4sCDsiJjsnoUo7JiI7IKwKSDsiJjsoJUnIDogJ+ydtOuyiCDquLDqsITsl5Ag65Ok7Ja07JioIOuPiCjsmIjsgrAp7J2EIOyeheugpe2VmOyEuOyalCd9PC9oMj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPiR7Zm10RGF0ZShjdXJyZW50UGVyaW9kLnN0YXJ0KX0g7JeQIOyLnOyeke2VmOuKlCDquLDqsITsnZgg7IiY7J6F7J6F64uI64ukLiDruYTsnKgg7ZWt66qp7J2YIO2VnOuPhOqwgCDsnbQg6riI7JWh7JeQIOunnuy2sCDqs4TsgrDrkKnri4jri6QuPC9wPgogICAgICAgIDxmb3JtIGNsYXNzPSJpbmNvbWUtZm9ybSIgaWQ9ImluY29tZS1mb3JtIj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpbnB1dG1vZGU9Im51bWVyaWMiIGlkPSJpbmNvbWUtaW5wdXQiIHBsYWNlaG9sZGVyPSLsmIg6IDMsMDAwLDAwMCIgdmFsdWU9IiR7c3VtLmhhc0luY29tZSA/IHN1bS5pbmNvbWUudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJykgOiAnJ30iPgogICAgICAgICAgPGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJwcmltYXJ5LWJ0biI+7KCA7J6lPC9idXR0b24+CiAgICAgICAgICAke3R5cGVvZiBwcmV2SW5jb21lID09PSAnbnVtYmVyJyA/IGA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imdob3N0LWJ0biIgaWQ9ImluY29tZS1wcmV2Ij7sp4Drgpwg6riw6rCE6rO8IOqwmeqyjCAoJHt3b24ocHJldkluY29tZSl9KTwvYnV0dG9uPmAgOiAnJ30KICAgICAgICAgICR7cmVjZWl2ZWR9CiAgICAgICAgICAke3N1bS5oYXNJbmNvbWUgPyAnPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJnaG9zdC1idG4iIGlkPSJpbmNvbWUtY2FuY2VsIj7st6jshow8L2J1dHRvbj4nIDogJyd9CiAgICAgICAgPC9mb3JtPmA7CiAgICAgIGNvbnN0IGlucHV0ID0gJCgnI2luY29tZS1pbnB1dCcpOwogICAgICBmb3JtYXRPbkJsdXIoaW5wdXQpOwogICAgICAkKCcjaW5jb21lLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBuID0gcGFyc2VBbW91bnRJbnB1dChpbnB1dC52YWx1ZSk7CiAgICAgICAgaWYgKG4gPT09IG51bGwgfHwgbiA8IDApIHJldHVybiB0b2FzdCgn6riI7JWh7J2EIOyIq+yekOuhnCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgICAgIHNldEluY29tZShuKTsKICAgICAgfSk7CiAgICAgIGNvbnN0IGJpbmQgPSAoaWQsIGZuKSA9PiAkKGlkKSAmJiAkKGlkKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGZuKTsKICAgICAgYmluZCgnI2luY29tZS1wcmV2JywgKCkgPT4gc2V0SW5jb21lKHByZXZJbmNvbWUpKTsKICAgICAgYmluZCgnI2luY29tZS1yZWNlaXZlZCcsICgpID0+IHNldEluY29tZShzdW0uaW5jb21lUmVjZWl2ZWQpKTsKICAgICAgYmluZCgnI2luY29tZS1jYW5jZWwnLCAoKSA9PiB7CiAgICAgICAgYm94LmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9KTsKICAgIH0gZWxzZSB7CiAgICAgIGJveC5jbGFzc0xpc3QucmVtb3ZlKCdpbmNvbWUtcHJvbXB0Jyk7CiAgICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0iaW5jb21lLXNldCI+CiAgICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+64u56riwIOyImOyehSjsmIjsgrApPC9zcGFuPjxkaXYgY2xhc3M9InZhbHVlIj4ke3dvbihzdW0uaW5jb21lKX08L2Rpdj48L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJpbmNvbWUtZWRpdCI+7IiY7KCVPC9idXR0b24+CiAgICAgICAgPC9kaXY+YDsKICAgICAgJCgnI2luY29tZS1lZGl0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgYm94LmRhdGFzZXQuZWRpdGluZyA9ICcxJzsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBzZXRJbmNvbWUobikgewogICAgUygpLmluY29tZXNbY3VycmVudFBlcmlvZC5rZXldID0gbjsKICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAkKCcjaW5jb21lLWJveCcpLmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgdG9hc3QoJ+uLueq4sCDsiJjsnoXsnYQg7KCA7J6l7ZaI7Iq164uI64ukLicpOwogICAgcmVuZGVyKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJTdGFsZUJveChzdW0pIHsKICAgIGNvbnN0IGJveCA9ICQoJyNzdGFsZS1ib3gnKTsKICAgIGlmICghc3VtLnN0YWxlQ291bnQgfHwgIXN1bS5wbGFuLnVwZGF0ZWRBdCkgewogICAgICBib3guaW5uZXJIVE1MID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQgbm90ZS1jYXJkIHdhcm4tY2FyZCI+CiAgICAgICAgPGI+7JiI7IKwIOqzhO2ajeydtCDrsJTrgIzsl4jslrTsmpQuPC9iPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+67CU64CQIOqzhO2ajeyXkCDrp57strAg7JWE7KeBIOuLpOyLnCDrtoTrpZjtlZjsp4Ag7JWK7J2AIOyngOy2nOydtCAke3N1bS5zdGFsZUNvdW50feqxtCDsnojslrTsmpQuIOyngeygkSDqs6Drpbgg7ZWt66qp7J2AIOq3uOuMgOuhnCDrkZDqs6Ag64KY66i47KeA66W8IOyDiCDtla3rqqkg6riw7KSA7Jy866GcIOu2hOulmO2VqeuLiOuLpC48L3A+CiAgICAgICAgPGJ1dHRvbiBpZD0ic3RhbGUtcmVjbGFzc2lmeSIgY2xhc3M9InByaW1hcnktYnRuIj7sg4gg6rOE7ZqN7Jy866GcIOuLpOyLnCDrtoTrpZgke3N0b3JlLmFpRW5hYmxlZCA/ICcgKEFJKScgOiAnJ308L2J1dHRvbj4KICAgICAgPC9kaXY+YDsKICAgICQoJyNzdGFsZS1yZWNsYXNzaWZ5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBydW5SZWNsYXNzaWZ5KGZhbHNlKSkpOwogIH0KCiAgLy8g6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7J2067KIIOq4sOqwhCDsiJjsnoXrs7Tri6Qg7YG0IOuVjCDslYzrprwKICBmdW5jdGlvbiByZW5kZXJGaXhlZEJveChzdW0pIHsKICAgIGNvbnN0IGJveCA9ICQoJyNmaXhlZC1ib3gnKTsKICAgIGlmICghc3VtLmhhc0luY29tZSB8fCAhc3VtLmZpeGVkT3ZlcikgewogICAgICBib3guaW5uZXJIVE1MID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHBjdCA9IE1hdGgucm91bmQoc3VtLmZpeGVkU2NhbGUgKiAxMDApOwogICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBub3RlLWNhcmQgd2Fybi1jYXJkIj4KICAgICAgICA8Yj7qs6DsoJUg7ZWt66qpIO2VqeqzhOqwgCDsiJjsnoXrs7Tri6QgJHt3b24oc3VtLmZpeGVkT3Zlcil9IOunjuyVhOyalC48L2I+CiAgICAgICAgPHAgY2xhc3M9InNtYWxsIj7qs6DsoJUg7ZWt66qpICR7d29uKHN1bS5maXhlZFRvdGFsKX0gwrcg7J2067KIIOq4sOqwhCDsiJjsnoUgJHt3b24oc3VtLmluY29tZSl9LgogICAgICAgICR7c3VtLmZpeGVkU2NhbGVkCiAgICAgICAgICA/IGDqs4Ttmo0g7ISk7KCV7JeQIOuUsOudvCDqs6DsoJUg7ZWt66qpIO2VnOuPhOulvCDsoJXtlZwg6riI7JWh7J2YIOyVvSAke3BjdH0l66GcIOykhOyXrCDsiJjsnoXsl5Ag66ee7LeE7Ja07JqULmAKICAgICAgICAgIDogJ+ygle2VnCDquIjslaEg6re464yA66GcIOuRkOyXiOq4sCDrlYzrrLjsl5Ag6rOE7ZqN7J20IOyImOyeheydhCDrhJjslrTsmpQuIOqzoOyglSDquIjslaHsnYQg6rOg7LmY6rGw64KYLCDqs4Ttmo3sl5DshJwgPGI+67mE7Jyo64yA66GcIOykhOydtOq4sDwvYj7rpbwg6rOg66W8IOyImCDsnojslrTsmpQuJ30KICAgICAgICAke3N1bS5yYXRpb1BlcmNlbnRUb3RhbCA+IDAgJiYgc3VtLnBsYW4ucmF0aW9CYXNlID09PSAnYWZ0ZXJGaXhlZCcgPyAnIOqzoOyglSDtla3rqqnsnYQg67m86rOgIOuCqOuKlCDrj4jsnbQg7JeG7Ja0IOu5hOycqCDtla3rqqkg7ZWc64+E64qUIDDsm5DsnbTsl5DsmpQuJyA6ICcnfTwvcD4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4iIGRhdGEtZ290bz0icGxhbiI+6rOE7ZqNIOuztOq4sDwvYnV0dG9uPgogICAgICA8L2Rpdj5gOwogICAgYm94LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWdvdG9dJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZSgncGxhbicpKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckhvbWUoKSB7CiAgICBjb25zdCBzdW0gPSBMLnN1bW1hcml6ZVBlcmlvZChTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgcmVuZGVySW5jb21lQm94KHN1bSk7CiAgICByZW5kZXJTdGFsZUJveChzdW0pOwogICAgcmVuZGVyRml4ZWRCb3goc3VtKTsKCiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGNvbnN0IGlzQ3VycmVudCA9IHRvZGF5ID49IGN1cnJlbnRQZXJpb2Quc3RhcnQgJiYgdG9kYXkgPD0gY3VycmVudFBlcmlvZC5lbmQ7CiAgICBjb25zdCBkYXlzTGVmdCA9IGlzQ3VycmVudCA/IEwuZGlmZkRheXModG9kYXksIGN1cnJlbnRQZXJpb2QuZW5kKSArIDEgOiAwOwogICAgY29uc3QgaGVybyA9ICQoJyNoZXJvJyk7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBjb25zdCByYXRpbyA9IHN1bS5pbmNvbWUgPiAwID8gc3VtLnRvdGFsU3BlbnQgLyBzdW0uaW5jb21lIDogc3VtLnRvdGFsU3BlbnQgPiAwID8gSW5maW5pdHkgOiAwOwogICAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHJhdGlvKTsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuuCqOydgCDrj4g8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUgJHtzdW0ucmVtYWluaW5nIDwgMCA/ICduZWdhdGl2ZScgOiAnJ30iPiR7d29uKHN1bS5yZW1haW5pbmcpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHt3b24oc3VtLmluY29tZSl9IOykkSAke3dvbihzdW0udG90YWxTcGVudCl9IOyCrOyaqSAoJHtzdW0uaW5jb21lID4gMCA/IE1hdGgucm91bmQocmF0aW8gKiAxMDApIDogMH0lKTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7c3RhdHVzfSIgcm9sZT0ibWV0ZXIiIGFyaWEtdmFsdWVtaW49IjAiIGFyaWEtdmFsdWVtYXg9IiR7c3VtLmluY29tZX0iIGFyaWEtdmFsdWVub3c9IiR7c3VtLnRvdGFsU3BlbnR9IiBhcmlhLWxhYmVsPSLsmIjsgrAg7IKs7JqpIj48ZGl2IGNsYXNzPSJtZXRlci1maWxsIiBzdHlsZT0id2lkdGg6JHtNYXRoLm1pbigxMDAsIHJhdGlvICogMTAwKX0lIj48L2Rpdj48L2Rpdj5gOwogICAgfSBlbHNlIHsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuydtOuyiCDquLDqsIQg7JO0IOuPiDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZ3VyZSI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+7IiY7J6F7J2EIOyeheugpe2VmOuptCDtla3rqqnrs4Qg7ZWc64+E7JmAIOuCqOydgCDrj4jsnYQg6rOE7IKw7ZW0IOuTnOugpOyalC48L2Rpdj5gOwogICAgfQoKICAgIGNvbnN0IHBlckRheSA9IGlzQ3VycmVudCAmJiBzdW0uaGFzSW5jb21lICYmIHN1bS5yZW1haW5pbmcgPiAwID8gd29uKE1hdGguZmxvb3Ioc3VtLnJlbWFpbmluZyAvIGRheXNMZWZ0KSkgOiAn4oCUJzsKICAgICQoJyNob21lLXN1bW1hcnknKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+7J2067KIIOq4sOqwhCDsp4Dstpw8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKHN1bS50b3RhbFNwZW50KX0gwrcgJHtzdW0udHJhbnNhY3Rpb25zLmxlbmd0aH3qsbQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+67Cb7J2AIOyeheq4iDwvc3Bhbj48c3BhbiBjbGFzcz0idiBwbHVzIj4ke3N1bS5pbmNvbWVSZWNlaXZlZCA/IGArJHt3b24oc3VtLmluY29tZVJlY2VpdmVkKX1gIDogJ+KAlCd9PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPu2VmOujqCDqtozsnqUg7IKs7Jqp7JWhPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3BlckRheX08L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+66+467aE66WYPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3N1bS51bmNsYXNzaWZpZWRDb3VudCA/IGAke3dvbihzdW0udW5jbGFzc2lmaWVkKX0gwrcgJHtzdW0udW5jbGFzc2lmaWVkQ291bnR96rG0YCA6ICfsl4bsnYwnfTwvc3Bhbj48L2Rpdj5gOwoKICAgIGxldCBub3RlID0gJyc7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBpZiAoc3VtLnVuYWxsb2NhdGVkID4gMCkgbm90ZSA9IGDrsLDrtoTrkJjsp4Ag7JWK7J2AIOuPiCAke3dvbihzdW0udW5hbGxvY2F0ZWQpfWA7CiAgICAgIGVsc2UgaWYgKHN1bS51bmFsbG9jYXRlZCA8IDApIG5vdGUgPSBg4pqgIOqzhO2ajeydtCDsiJjsnoXrs7Tri6QgJHt3b24oLXN1bS51bmFsbG9jYXRlZCl9IOunjuyVhOyalGA7CiAgICB9CiAgICAkKCcjYWxsb2Mtbm90ZScpLnRleHRDb250ZW50ID0gbm90ZTsKCiAgICBjb25zdCByb3dzRWwgPSAkKCcjY2F0ZWdvcnktcm93cycpOwogICAgaWYgKCFzdW0ucGxhbi5jYXRlZ29yaWVzLmxlbmd0aCkgewogICAgICByb3dzRWwuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7smIjsgrAg6rOE7ZqN7JeQ7IScIO2VreuqqeydhCDstpTqsIDtlZjshLjsmpQuPC9kaXY+JzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IHJvd3MgPSBzdW0ucm93cy5tYXAoKHIsIGkpID0+IGNhdGVnb3J5Um93KHIsIGksIHN1bS5oYXNJbmNvbWUpKTsKICAgICAgaWYgKHN1bS51bmNsYXNzaWZpZWRDb3VudCkgewogICAgICAgIHJvd3MucHVzaChgCiAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtcm93IiBkYXRhLWNhdD0iX19ub25lIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iY2F0LXRvcCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1ncmF5LW1hcmspIj48L3NwYW4+66+467aE66WYPHNwYW4gY2xhc3M9ImJhZGdlIj7riIzrn6zshJwg7KCV66as7ZWY6riwPC9zcGFuPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2F0LWFtb3VudHMiPjxiPiR7d29uKHN1bS51bmNsYXNzaWZpZWQpfTwvYj4gwrcgJHtzdW0udW5jbGFzc2lmaWVkQ291bnR96rG0PC9zcGFuPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PmApOwogICAgICB9CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSByb3dzLmpvaW4oJycpOwogICAgICByb3dzRWwucXVlcnlTZWxlY3RvckFsbCgnLmNhdC1yb3cnKS5mb3JFYWNoKChlbCkgPT4gewogICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgICAgaWYgKGVsLmRhdGFzZXQuY2F0ID09PSAnX19ub25lJykgcmV0dXJuIHNob3dQYWdlKCdzb3J0JywgeyBrZWVwUGVyaW9kOiB0cnVlIH0pOwogICAgICAgICAgT2JqZWN0LmFzc2lnbihsaXN0U3RhdGUsIHsgY2F0ZWdvcnk6IGVsLmRhdGFzZXQuY2F0LCBraW5kOiAnYWxsJywgYWNjb3VudDogJ2FsbCcsIHNlYXJjaDogJycgfSk7CiAgICAgICAgICBzaG93UGFnZSgnbGlzdCcpOwogICAgICAgIH0pOwogICAgICAgIGNvbnN0IHIgPSBzdW0ucm93cy5maW5kKCh4KSA9PiB4LmNhdGVnb3J5LmlkID09PSBlbC5kYXRhc2V0LmNhdCk7CiAgICAgICAgaWYgKHIpIGF0dGFjaFRvb2x0aXAoZWwucXVlcnlTZWxlY3RvcignLm1ldGVyJyksICgpID0+IGAKICAgICAgICAgIDxzdHJvbmc+JHtlc2Moci5jYXRlZ29yeS5uYW1lKX08L3N0cm9uZz4KICAgICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj7tlZzrj4Q8L3NwYW4+PHNwYW4+JHt3b24oci5idWRnZXQpfTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj7sgqzsmqk8L3NwYW4+PHNwYW4+JHt3b24oci5zcGVudCl9PC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPiR7ci5yZW1haW5pbmcgPj0gMCA/ICfrgqjsnYwnIDogJ+y0iOqzvCd9PC9zcGFuPjxzcGFuPiR7d29uKE1hdGguYWJzKHIucmVtYWluaW5nKSl9PC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPuqxtOyImDwvc3Bhbj48c3Bhbj4ke3IuY291bnR96rG0PC9zcGFuPjwvZGl2PmApOwogICAgICB9KTsKICAgIH0KCiAgICBjb25zdCByZWNlbnQgPSBbLi4uc3VtLmFsbFRyYW5zYWN0aW9uc10uc29ydCgoYSwgYikgPT4gKGEuZGF0ZSArIChhLmNyZWF0ZWRBdCB8fCAnJykgPCBiLmRhdGUgKyAoYi5jcmVhdGVkQXQgfHwgJycpID8gMSA6IC0xKSkuc2xpY2UoMCwgNSk7CiAgICAkKCcjcmVjZW50LWxpc3QnKS5pbm5lckhUTUwgPSByZWNlbnQubGVuZ3RoID8gcmVjZW50Lm1hcCgodCkgPT4gdHhSb3codCwgeyBlZGl0YWJsZTogZmFsc2UgfSkpLmpvaW4oJycpIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7snbQg6riw6rCEIOuCtOyXreydtCDsl4bsirXri4jri6QuPC9kaXY+JzsKCiAgICBjb25zdCBhc3NldHMgPSBMLmFzc2V0U3VtbWFyeShTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgJCgnI2hvbWUtYXNzZXRzJykuaW5uZXJIVE1MID0gYXNzZXRzLmJhbmtzLmxlbmd0aCB8fCBhc3NldHMuY2FyZHMubGVuZ3RoCiAgICAgID8gYDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+6rOE7KKMIOyelOyVoSDtlanqs4Q8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKGFzc2V0cy50b3RhbCl9PC9zcGFuPjwvZGl2PgogICAgICAgICAke2Fzc2V0cy5zYXZpbmdzID8gYDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+6re47KSRIOyggOy2lTwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oYXNzZXRzLnNhdmluZ3MpfTwvc3Bhbj48L2Rpdj5gIDogJyd9CiAgICAgICAgICR7YXNzZXRzLmNhcmRzLm1hcCgoYykgPT4gYDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+JHtlc2MoYWNjb3VudE5hbWUoYy5pZCkpfSAo7J2067KIIOq4sOqwhCk8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKGMuc3BlbnQpfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCcnKX1gCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7shKTsoJXsl5DshJwg6rOE7KKMwrfsubTrk5zrpbwg65Ox66Gd7ZWY66m0IOyelOyVoeqzvCDsubTrk5zrs4Qg7IKs7Jqp7JWh7J2EIOuztOyXrOuTnOugpOyalC48L2Rpdj4nOwogIH0KCiAgZnVuY3Rpb24gY2F0ZWdvcnlSb3cociwgaW5kZXgsIGhhc0luY29tZSkgewogICAgY29uc3QgYyA9IHIuY2F0ZWdvcnk7CiAgICBjb25zdCBiYWRnZSA9IGMudHlwZSA9PT0gJ2ZpeGVkJyA/IGDqs6DsoJUgJHt3b24oYy52YWx1ZSl9YCA6IGDsiJjsnoXsnZggJHtjLnZhbHVlfSVgOwogICAgY29uc3Qgc3RhdHVzID0gTC5zdGF0dXNPZihyLnJhdGlvKTsKICAgIGNvbnN0IHBjdCA9IHIuYnVkZ2V0ID4gMCA/IE1hdGgucm91bmQoci5yYXRpbyAqIDEwMCkgOiBudWxsOwogICAgY29uc3Qgd2lkdGggPSByLmJ1ZGdldCA+IDAgPyBNYXRoLm1pbigxMDAsIHIucmF0aW8gKiAxMDApIDogci5zcGVudCA+IDAgPyAxMDAgOiAwOwogICAgY29uc3Qgbm9CdWRnZXQgPSBjLnR5cGUgPT09ICdyYXRpbycgJiYgIWhhc0luY29tZTsKCiAgICBsZXQgc3RhdHVzVGV4dDsKICAgIGlmIChub0J1ZGdldCkgc3RhdHVzVGV4dCA9ICfsiJjsnoUg7J6F66ClIOyghCc7CiAgICBlbHNlIGlmIChzdGF0dXMgPT09ICdjcml0aWNhbCcpIHN0YXR1c1RleHQgPSBg4pqgIOy0iOqzvCAke3BjdCA9PT0gbnVsbCA/ICcnIDogYCgke3BjdH0lKWB9YDsKICAgIGVsc2UgaWYgKHN0YXR1cyA9PT0gJ3dhcm5pbmcnKSBzdGF0dXNUZXh0ID0gcGN0ID09PSAxMDAgPyAn7ZWc64+EIOuPhOuLrCAxMDAlJyA6IGAhIOyjvOydmCAke3BjdH0lYDsKICAgIGVsc2Ugc3RhdHVzVGV4dCA9IHBjdCA9PT0gbnVsbCA/ICcnIDogYCR7cGN0fSUg7IKs7JqpYDsKCiAgICBjb25zdCByZW1haW4gPSBub0J1ZGdldAogICAgICA/ICcnCiAgICAgIDogci5yZW1haW5pbmcgPj0gMAogICAgICAgID8gYDxzcGFuIGNsYXNzPSJyZW1haW4tZ29vZCI+JHt3b24oci5yZW1haW5pbmcpfSDrgqjsnYw8L3NwYW4+YAogICAgICAgIDogYDxzcGFuIGNsYXNzPSJyZW1haW4tYmFkIj4ke3dvbigtci5yZW1haW5pbmcpfSDstIjqs7w8L3NwYW4+YDsKCiAgICByZXR1cm4gYAogICAgICA8ZGl2IGNsYXNzPSJjYXQtcm93IiBkYXRhLWNhdD0iJHtlc2MoYy5pZCl9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtdG9wIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJjYXQtbmFtZSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JHtDLnNlcmllc0NvbG9yKGluZGV4KX0iPjwvc3Bhbj4ke2VzYyhjLm5hbWUpfTxzcGFuIGNsYXNzPSJiYWRnZSI+JHtlc2MoYmFkZ2UpfTwvc3Bhbj48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iY2F0LWFtb3VudHMiPjxiPiR7d29uKHIuc3BlbnQpfTwvYj4gLyAke25vQnVkZ2V0ID8gJ+KAlCcgOiB3b24oci5idWRnZXQpfTwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRlciAke25vQnVkZ2V0ID8gJycgOiBzdGF0dXN9IiByb2xlPSJtZXRlciIgYXJpYS12YWx1ZW1pbj0iMCIgYXJpYS12YWx1ZW1heD0iJHtyLmJ1ZGdldH0iIGFyaWEtdmFsdWVub3c9IiR7ci5zcGVudH0iIGFyaWEtbGFiZWw9IiR7ZXNjKGMubmFtZSl9IOyCrOyaqeyVoSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtZXRlci1maWxsIiBzdHlsZT0id2lkdGg6JHt3aWR0aH0lIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtYm90dG9tIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzdGF0dXMgJHtub0J1ZGdldCA/ICcnIDogc3RhdHVzfSI+JHtzdGF0dXNUZXh0fTwvc3Bhbj4KICAgICAgICAgICR7cmVtYWlufQogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj5gOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDri6zroKUgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJDYWxlbmRhcigpIHsKICAgIGNvbnN0IHAgPSBjdXJyZW50UGVyaW9kOwogICAgY29uc3Qgc3VtID0gTC5zdW1tYXJpemVQZXJpb2QoUygpLCBwKTsKICAgIGNvbnN0IGRheXMgPSBMLmRhaWx5VG90YWxzKHN1bS5hbGxUcmFuc2FjdGlvbnMpOwogICAgY29uc3QgdG9kYXkgPSBMLnRvZGF5SVNPKCk7CiAgICBpZiAoIXNlbGVjdGVkRGF0ZSB8fCBzZWxlY3RlZERhdGUgPCBwLnN0YXJ0IHx8IHNlbGVjdGVkRGF0ZSA+IHAuZW5kKSBzZWxlY3RlZERhdGUgPSB0b2RheSA+PSBwLnN0YXJ0ICYmIHRvZGF5IDw9IHAuZW5kID8gdG9kYXkgOiBwLnN0YXJ0OwoKICAgICQoJyNjYWwtc3VtbWFyeScpLmlubmVySFRNTCA9IGAKICAgICAgPHNwYW4+7KeA7LacIDxiPiR7d29uKHN1bS50b3RhbFNwZW50KX08L2I+PC9zcGFuPgogICAgICA8c3BhbiBjbGFzcz0icGx1cyI+7J6F6riIIDxiPiR7c3VtLmluY29tZVJlY2VpdmVkID8gYCske3dvbihzdW0uaW5jb21lUmVjZWl2ZWQpfWAgOiAnMOybkCd9PC9iPjwvc3Bhbj4KICAgICAgJHtzdW0uaGFzSW5jb21lID8gYDxzcGFuPuuCqOydgCDrj4ggPGI+JHt3b24oc3VtLnJlbWFpbmluZyl9PC9iPjwvc3Bhbj5gIDogJyd9YDsKCiAgICBjb25zdCBtYXhTcGVudCA9IE1hdGgubWF4KDAsIC4uLk9iamVjdC52YWx1ZXMoZGF5cykubWFwKChkKSA9PiBkLnNwZW50KSk7CiAgICBjb25zdCBmaXJzdCA9IEwuYWRkRGF5cyhwLnN0YXJ0LCAtZG93T2YocC5zdGFydCkpOwogICAgY29uc3QgbGFzdCA9IEwuYWRkRGF5cyhwLmVuZCwgNiAtIGRvd09mKHAuZW5kKSk7CiAgICBjb25zdCBjZWxscyA9IERPVy5tYXAoKHcsIGkpID0+IGA8ZGl2IGNsYXNzPSJjYWwtZG93ICR7aSA9PT0gMCA/ICdzdW4nIDogJyd9Ij4ke3d9PC9kaXY+YCk7CiAgICBmb3IgKGxldCBjdXJzb3IgPSBmaXJzdDsgY3Vyc29yIDw9IGxhc3Q7IGN1cnNvciA9IEwuYWRkRGF5cyhjdXJzb3IsIDEpKSB7CiAgICAgIGNvbnN0IGluUGVyaW9kID0gY3Vyc29yID49IHAuc3RhcnQgJiYgY3Vyc29yIDw9IHAuZW5kOwogICAgICBjb25zdCBpbmZvID0gZGF5c1tjdXJzb3JdIHx8IHsgc3BlbnQ6IDAsIGluY29tZTogMCB9OwogICAgICBjb25zdCBxID0gTC5wYXJzZUlTTyhjdXJzb3IpOwogICAgICBjb25zdCBsYWJlbCA9IHEuZCA9PT0gMSB8fCBjdXJzb3IgPT09IHAuc3RhcnQgPyBgJHtxLm19LyR7cS5kfWAgOiBxLmQ7CiAgICAgIGxldCBoZWF0ID0gJyc7CiAgICAgIGlmIChpblBlcmlvZCAmJiBpbmZvLnNwZW50ID4gMCAmJiBtYXhTcGVudCA+IDApIGhlYXQgPSBgaCR7TWF0aC5taW4oMywgTWF0aC5jZWlsKChpbmZvLnNwZW50IC8gbWF4U3BlbnQpICogMykpfWA7CiAgICAgIGNlbGxzLnB1c2goaW5QZXJpb2QKICAgICAgICA/IGA8YnV0dG9uIGNsYXNzPSJjYWwtZGF5ICR7aGVhdH0gJHtjdXJzb3IgPT09IHRvZGF5ID8gJ3RvZGF5JyA6ICcnfSAke2N1cnNvciA9PT0gc2VsZWN0ZWREYXRlID8gJ3NlbGVjdGVkJyA6ICcnfSIgZGF0YS1kYXRlPSIke2N1cnNvcn0iIGFyaWEtbGFiZWw9IiR7Zm10RGF5KGN1cnNvcil9IOyngOy2nCAke3dvbihpbmZvLnNwZW50KX0iPgogICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhbC1udW0iPiR7bGFiZWx9PC9zcGFuPgogICAgICAgICAgICAgJHtpbmZvLnNwZW50ID8gYDxzcGFuIGNsYXNzPSJjYWwtc3BlbnQiPi0ke0MudGlueVdvbihpbmZvLnNwZW50KX08L3NwYW4+YCA6ICcnfQogICAgICAgICAgICAgJHtpbmZvLmluY29tZSA/IGA8c3BhbiBjbGFzcz0iY2FsLWluY29tZSI+KyR7Qy50aW55V29uKGluZm8uaW5jb21lKX08L3NwYW4+YCA6ICcnfQogICAgICAgICAgIDwvYnV0dG9uPmAKICAgICAgICA6IGA8ZGl2IGNsYXNzPSJjYWwtZGF5IG91dCI+PHNwYW4gY2xhc3M9ImNhbC1udW0iPiR7bGFiZWx9PC9zcGFuPjwvZGl2PmApOwogICAgfQogICAgY29uc3QgY2FsID0gJCgnI2NhbGVuZGFyJyk7CiAgICBjYWwuaW5uZXJIVE1MID0gY2VsbHMuam9pbignJyk7CiAgICBjYWwucXVlcnlTZWxlY3RvckFsbCgnLmNhbC1kYXlbZGF0YS1kYXRlXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHNlbGVjdGVkRGF0ZSA9IGIuZGF0YXNldC5kYXRlOwogICAgICByZW5kZXJDYWxlbmRhcigpOwogICAgfSkpOwoKICAgIGNvbnN0IGRheVR4cyA9IHN1bS5hbGxUcmFuc2FjdGlvbnMuZmlsdGVyKCh0KSA9PiB0LmRhdGUgPT09IHNlbGVjdGVkRGF0ZSk7CiAgICAkKCcjZGF5LXRpdGxlJykudGV4dENvbnRlbnQgPSBmbXREYXkoc2VsZWN0ZWREYXRlKTsKICAgIGNvbnN0IGluZm8gPSBkYXlzW3NlbGVjdGVkRGF0ZV07CiAgICAkKCcjZGF5LXRvdGFsJykudGV4dENvbnRlbnQgPSBpbmZvID8gYOyngOy2nCAke3dvbihpbmZvLnNwZW50KX0ke2luZm8uaW5jb21lID8gYCDCtyDsnoXquIggJHt3b24oaW5mby5pbmNvbWUpfWAgOiAnJ31gIDogJyc7CiAgICBjb25zdCBsaXN0ID0gJCgnI2RheS1saXN0Jyk7CiAgICBsaXN0LmlubmVySFRNTCA9IGRheVR4cy5sZW5ndGggPyBkYXlUeHMubWFwKCh0KSA9PiB0eFJvdyh0KSkuam9pbignJykgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuydtOuCoOydgCDrgrTsl63snbQg7JeG7Ja07JqULjwvZGl2Pic7CiAgICBiaW5kVHhFdmVudHMobGlzdCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuCtOyXrSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckxpc3QoKSB7CiAgICBjb25zdCBzdW0gPSBMLnN1bW1hcml6ZVBlcmlvZChTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgY29uc3QgY2F0cyA9IHN1bS5wbGFuLmNhdGVnb3JpZXM7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0cy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGlmIChsaXN0U3RhdGUuY2F0ZWdvcnkgIT09ICdhbGwnICYmIGxpc3RTdGF0ZS5jYXRlZ29yeSAhPT0gJ19fbm9uZScgJiYgIWtub3duLmhhcyhsaXN0U3RhdGUuY2F0ZWdvcnkpKSBsaXN0U3RhdGUuY2F0ZWdvcnkgPSAnYWxsJzsKCiAgICAkKCcjbGlzdC1maWx0ZXInKS5pbm5lckhUTUwgPSBgPG9wdGlvbiB2YWx1ZT0iYWxsIj7rqqjrk6Ag7ZWt66qpPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iX19ub25lIj7rr7jrtoTrpZg8L29wdGlvbj5gICsKICAgICAgY2F0cy5tYXAoKGMpID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhjLmlkKX0iPiR7ZXNjKGMubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyk7CiAgICAkKCcjbGlzdC1maWx0ZXInKS52YWx1ZSA9IGxpc3RTdGF0ZS5jYXRlZ29yeTsKICAgICQoJyNsaXN0LWFjY291bnQnKS5pbm5lckhUTUwgPSBgPG9wdGlvbiB2YWx1ZT0iYWxsIj7rqqjrk6Ag6rKw7KCc7IiY64uoPC9vcHRpb24+YCArCiAgICAgIFMoKS5hY2NvdW50cy5tYXAoKGEpID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhhLmlkKX0iPiR7ZXNjKGFjY291bnROYW1lKGEuaWQpKX08L29wdGlvbj5gKS5qb2luKCcnKTsKICAgICQoJyNsaXN0LWFjY291bnQnKS52YWx1ZSA9IFMoKS5hY2NvdW50cy5zb21lKChhKSA9PiBhLmlkID09PSBsaXN0U3RhdGUuYWNjb3VudCkgPyBsaXN0U3RhdGUuYWNjb3VudCA6ICdhbGwnOwogICAgJCgnI2xpc3Qta2luZCcpLnZhbHVlID0gbGlzdFN0YXRlLmtpbmQ7CiAgICAkKCcjbGlzdC1zZWFyY2gnKS52YWx1ZSA9IGxpc3RTdGF0ZS5zZWFyY2g7CiAgICAkKCcjcmVjbGFzc2lmeS1hbGwnKS50ZXh0Q29udGVudCA9IGDsnbQg6riw6rCEIOyghOyytCDri6Tsi5wg67aE66WYJHtzdG9yZS5haUVuYWJsZWQgPyAnIChBSSknIDogJyd9YDsKCiAgICBjb25zdCBxID0gTC5ub3JtYWxpemVNZXJjaGFudChsaXN0U3RhdGUuc2VhcmNoKTsKICAgIGNvbnN0IHR4cyA9IHN1bS5hbGxUcmFuc2FjdGlvbnMuZmlsdGVyKCh0KSA9PiB7CiAgICAgIGNvbnN0IGtpbmQgPSBMLmtpbmRPZih0KTsKICAgICAgaWYgKGxpc3RTdGF0ZS5raW5kICE9PSAnYWxsJyAmJiBraW5kICE9PSBsaXN0U3RhdGUua2luZCkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAobGlzdFN0YXRlLmNhdGVnb3J5ID09PSAnX19ub25lJyAmJiAoa2luZCAhPT0gJ2V4cGVuc2UnIHx8IGtub3duLmhhcyh0LmNhdGVnb3J5SWQpKSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAobGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnYWxsJyAmJiBsaXN0U3RhdGUuY2F0ZWdvcnkgIT09ICdfX25vbmUnICYmIHQuY2F0ZWdvcnlJZCAhPT0gbGlzdFN0YXRlLmNhdGVnb3J5KSByZXR1cm4gZmFsc2U7CiAgICAgIGlmIChsaXN0U3RhdGUuYWNjb3VudCAhPT0gJ2FsbCcgJiYgdC5hY2NvdW50SWQgIT09IGxpc3RTdGF0ZS5hY2NvdW50KSByZXR1cm4gZmFsc2U7CiAgICAgIGlmIChxICYmICFMLm5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykuaW5jbHVkZXMocSkpIHJldHVybiBmYWxzZTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9KTsKCiAgICBjb25zdCBzcGVudCA9IHR4cy5maWx0ZXIoKHQpID0+IEwua2luZE9mKHQpID09PSAnZXhwZW5zZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgIGNvbnN0IGluYyA9IHR4cy5maWx0ZXIoKHQpID0+IEwua2luZE9mKHQpID09PSAnaW5jb21lJykucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgJCgnI2xpc3QtdG90YWwnKS5pbm5lckhUTUwgPSBgPHNwYW4+JHt0eHMubGVuZ3RofeqxtDwvc3Bhbj48c3Bhbj7sp4DstpwgPGI+JHt3b24oc3BlbnQpfTwvYj48L3NwYW4+JHtpbmMgPyBgPHNwYW4+7J6F6riIIDxiPiske3dvbihpbmMpfTwvYj48L3NwYW4+YCA6ICcnfWA7CgogICAgY29uc3QgZWwgPSAkKCcjdHgtbGlzdCcpOwogICAgZWwuaW5uZXJIVE1MID0gdHhzLmxlbmd0aCA/IHR4R3JvdXBzKHR4cykgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuyhsOqxtOyXkCDrp57ripQg64K07Jet7J20IOyXhuyKteuLiOuLpC48L2Rpdj4nOwogICAgYmluZFR4RXZlbnRzKGVsKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g66+467aE66WYIOygleumrCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlclNvcnQoKSB7CiAgICBjb25zdCBncm91cHMgPSBMLnVuY2xhc3NpZmllZEdyb3VwcyhTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgY29uc3QgY291bnQgPSBncm91cHMucmVkdWNlKChuLCBnKSA9PiBuICsgZy5pdGVtcy5sZW5ndGgsIDApOwogICAgY29uc3QgdG90YWwgPSBncm91cHMucmVkdWNlKChuLCBnKSA9PiBuICsgZy50b3RhbCwgMCk7CiAgICAkKCcjc29ydC10aXRsZScpLnRleHRDb250ZW50ID0gJ+ydtCDquLDqsIQg66+467aE66WYJzsKICAgICQoJyNzb3J0LXRvdGFsJykudGV4dENvbnRlbnQgPSBjb3VudCA/IGAke2NvdW50feqxtCDCtyAke3dvbih0b3RhbCl9YCA6ICcnOwoKICAgIC8vIOuLpOuluCDquLDqsITsl5Ag64Ko7J2AIOuvuOu2hOulmDog64iM65+s7IScIOq3uCDquLDqsITsnLzroZwg7J2064+ZCiAgICBjb25zdCBvdGhlcnMgPSBMLnVuY2xhc3NpZmllZEJ5UGVyaW9kKFMoKSkuZmlsdGVyKChlKSA9PiBlLnBlcmlvZC5rZXkgIT09IGN1cnJlbnRQZXJpb2Qua2V5KTsKICAgIGNvbnN0IG90aGVyRWwgPSAkKCcjc29ydC1vdGhlcnMnKTsKICAgIG90aGVyRWwuaW5uZXJIVE1MID0gb3RoZXJzLmxlbmd0aAogICAgICA/IGA8c3BhbiBjbGFzcz0ibXV0ZWQgc21hbGwiPuuLpOuluCDquLDqsITsl5Drj4Qg64Ko7JWEIOyeiOyWtOyalDo8L3NwYW4+ICR7b3RoZXJzLm1hcCgoZSkgPT4gYDxidXR0b24gY2xhc3M9InBpY2stYnRuIiBkYXRhLXBlcmlvZD0iJHtlc2MoZS5wZXJpb2Qua2V5KX0iPiR7ZXNjKHBlcmlvZExhYmVsKGUucGVyaW9kKSl9IMK3ICR7ZS5jb3VudH3qsbQ8L2J1dHRvbj5gKS5qb2luKCcnKX1gCiAgICAgIDogJyc7CiAgICBvdGhlckVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBlcmlvZF0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBjb25zdCBlID0gb3RoZXJzLmZpbmQoKHgpID0+IHgucGVyaW9kLmtleSA9PT0gYi5kYXRhc2V0LnBlcmlvZCk7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBlLnBlcmlvZDsKICAgICAgcmVuZGVyKCk7CiAgICAgIHdpbmRvdy5zY3JvbGxUbygwLCAwKTsKICAgIH0pKTsKCiAgICBjb25zdCBlbCA9ICQoJyNzb3J0LWdyb3VwcycpOwogICAgaWYgKCFncm91cHMubGVuZ3RoKSB7CiAgICAgIGVsLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+7J20IOq4sOqwhOyXkOuKlCDrr7jrtoTrpZgg7KeA7Lac7J20IOyXhuyWtOyalC4ke290aGVycy5sZW5ndGggPyAnIOychOyXkOyEnCDri6Trpbgg6riw6rCE7J2EIOqzqOudvCDsoJXrpqztlZjshLjsmpQuJyA6ICcg66qo65GQIOygleumrOuQkOyWtOyalC4nfTwvZGl2PjwvZGl2PmA7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGVsLmlubmVySFRNTCA9IGdyb3Vwcy5tYXAoKGcsIGdpKSA9PiB7CiAgICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yRGF0ZShnLmxhdGVzdCkuY2F0ZWdvcmllczsKICAgICAgY29uc3QgZGF5cyA9IFsuLi5uZXcgU2V0KGcuaXRlbXMubWFwKCh0KSA9PiB0LmRhdGUpKV07CiAgICAgIGNvbnN0IGRhdGVzID0gZGF5cy5zbGljZSgwLCAzKS5tYXAoZm10RGF5KS5qb2luKCcsICcpICsgKGRheXMubGVuZ3RoID4gMyA/IGAg7Jm4ICR7ZGF5cy5sZW5ndGggLSAzfeydvGAgOiAnJyk7CiAgICAgIGNvbnN0IHJhdyA9IGcuaXRlbXMuZmluZCgodCkgPT4gdC5yYXcpPy5yYXc7CiAgICAgIHJldHVybiBgCiAgICAgICAgPGRpdiBjbGFzcz0iY2FyZCBzb3J0LWdyb3VwIiBkYXRhLWc9IiR7Z2l9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNvcnQtaGVhZCI+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJzb3J0LW1lbW8iPiR7ZXNjKGcubWVtbyl9PC9zcGFuPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0ic29ydC1zdW0iPjxiPiR7d29uKGcudG90YWwpfTwvYj4ke2cuaXRlbXMubGVuZ3RoID4gMSA/IGAgwrcgJHtnLml0ZW1zLmxlbmd0aH3qsbRgIDogJyd9PC9zcGFuPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzb3J0LWRhdGVzIj4ke2VzYyhkYXRlcyl9JHtnLml0ZW1zWzBdLmFjY291bnRJZCAmJiBhY2NvdW50TmFtZShnLml0ZW1zWzBdLmFjY291bnRJZCkgPyBgIMK3ICR7ZXNjKGFjY291bnROYW1lKGcuaXRlbXNbMF0uYWNjb3VudElkKSl9YCA6ICcnfTwvZGl2PgogICAgICAgICAgJHtyYXcgPyBgPGRpdiBjbGFzcz0ic29ydC1yYXciPiR7ZXNjKHJhdyl9PC9kaXY+YCA6ICcnfQogICAgICAgICAgPGRpdiBjbGFzcz0icGljay1yb3ciPgogICAgICAgICAgICAke2NhdHMubWFwKChjLCBpKSA9PiBgPGJ1dHRvbiBjbGFzcz0icGljay1idG4iIGRhdGEtY2F0PSIke2VzYyhjLmlkKX0iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiR7Qy5zZXJpZXNDb2xvcihpKX0iPjwvc3Bhbj4ke2VzYyhjLm5hbWUpfTwvYnV0dG9uPmApLmpvaW4oJycpfQogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWNrLWJ0biBvdGhlciIgZGF0YS1raW5kPSJ0cmFuc2ZlciI+64K0IOqzhOyijCDsnbTrj5k8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGljay1idG4gb3RoZXIiIGRhdGEta2luZD0iaW5jb21lIj7snoXquIg8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgJHtnLml0ZW1zLmxlbmd0aCA+IDEgPyBgPGRldGFpbHM+PHN1bW1hcnk+7ZWY64KY7JSpIOuUsOuhnCDqs6DrpbTquLA8L3N1bW1hcnk+PGRpdiBjbGFzcz0idHgtbGlzdCI+JHtnLml0ZW1zLm1hcCgodCkgPT4gdHhSb3codCkpLmpvaW4oJycpfTwvZGl2PjwvZGV0YWlscz5gIDogJyd9CiAgICAgICAgPC9kaXY+YDsKICAgIH0pLmpvaW4oJycpOwoKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5zb3J0LWdyb3VwJykuZm9yRWFjaCgoY2FyZCkgPT4gewogICAgICBjb25zdCBnID0gZ3JvdXBzW051bWJlcihjYXJkLmRhdGFzZXQuZyldOwogICAgICBjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWNrLWJ0bicpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBhc3NpZ25Hcm91cChnLCBiLmRhdGFzZXQuY2F0LCBiLmRhdGFzZXQua2luZCkpKSk7CiAgICAgIGJpbmRUeEV2ZW50cyhjYXJkKTsKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gYXNzaWduR3JvdXAoZywgY2F0ZWdvcnlJZCwga2luZCkgewogICAgY29uc3QgbGVhcm4gPSAkKCcjc29ydC1sZWFybicpLmNoZWNrZWQ7CiAgICBpZiAoY2F0ZWdvcnlJZCAmJiBsZWFybikgewogICAgICBTKCkubWVyY2hhbnRNYXBbZy5rZXldID0gY2F0ZWdvcnlJZDsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIH0KICAgIGxldCBkb25lID0gMDsKICAgIGF3YWl0IGJ1c3koZy5pdGVtcy5sZW5ndGggPiAzID8gJ+ygleumrO2VmOuKlCDspJHigKYnIDogbnVsbCwgYXN5bmMgKCkgPT4gewogICAgICBmb3IgKGNvbnN0IHQgb2YgZy5pdGVtcykgewogICAgICAgIGlmIChraW5kKSB7CiAgICAgICAgICBhd2FpdCBzdG9yZS51cGRhdGVUcmFuc2FjdGlvbih0LmlkLCB7IGtpbmQsIGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9KTsKICAgICAgICAgIGRvbmUgKz0gMTsKICAgICAgICB9IGVsc2UgaWYgKHBsYW5Gb3JEYXRlKHQuZGF0ZSkuY2F0ZWdvcmllcy5zb21lKChjKSA9PiBjLmlkID09PSBjYXRlZ29yeUlkKSkgewogICAgICAgICAgLy8g6re4IOuCoOynnOydmCDqs4Ttmo3sl5Ag7JeG64qUIO2VreuqqeydtOuptCDqsbTrhIjrm7Tri6QgKOyngOuCnCDquLDqsIQg6rOE7ZqN6rO8IO2VreuqqeydtCDri6Trpbwg7IiYIOyeiOydjCkKICAgICAgICAgIGF3YWl0IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZDogJ2V4cGVuc2UnLCBjYXRlZ29yeUlkLCBtZXRob2Q6ICdtYW51YWwnIH0pOwogICAgICAgICAgZG9uZSArPSAxOwogICAgICAgIH0KICAgICAgfQogICAgfSk7CiAgICBjb25zdCB3aGF0ID0ga2luZCA9PT0gJ3RyYW5zZmVyJyA/ICfrgrQg6rOE7KKMIOydtOuPmScgOiBraW5kID09PSAnaW5jb21lJyA/ICfsnoXquIgnIDogY2F0ZWdvcnlJbmZvKGNhdGVnb3J5SWQsIHBsYW5Gb3JEYXRlKGcubGF0ZXN0KS5jYXRlZ29yaWVzKS5uYW1lOwogICAgY29uc3Qgc2tpcHBlZCA9IGcuaXRlbXMubGVuZ3RoIC0gZG9uZTsKICAgIHRvYXN0KGAnJHtnLm1lbW99JyAke2RvbmV96rG07J2EICR7d2hhdH0o7Jy8KeuhnCDsoJXrpqztlojslrTsmpQuYCArCiAgICAgIChza2lwcGVkID8gYCAoJHtza2lwcGVkfeqxtOydgCDqt7jrlYwg6rOE7ZqN7JeQIOydtCDtla3rqqnsnbQg7JeG7Ja0IOuCqOqyqCDrkoDslrTsmpQpYCA6ICcnKSArCiAgICAgIChjYXRlZ29yeUlkICYmIGxlYXJuID8gJyDri6TsnYzrtoDthLAg7J6Q64+Z7Jy866GcIOu2hOulmO2VtOyalC4nIDogJycpKTsKICAgIHJlbmRlcigpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcnVuUmVjbGFzc2lmeShvbmx5VW5jbGFzc2lmaWVkKSB7CiAgICBjb25zdCBsYWJlbCA9IHN0b3JlLmFpRW5hYmxlZCA/ICdBSeqwgCDri6Tsi5wg67aE66WY7ZWY64qUIOykkeKApicgOiAn64uk7IucIOu2hOulmO2VmOuKlCDspJHigKYnOwogICAgY29uc3QgbiA9IGF3YWl0IGJ1c3kobGFiZWwsICgpID0+IHN0b3JlLnJlY2xhc3NpZnkoY3VycmVudFBlcmlvZCwgb25seVVuY2xhc3NpZmllZCkpOwogICAgdG9hc3QobiA/IGAke2596rG07J2EIOuLpOyLnCDrtoTrpZjtlojsirXri4jri6QuYCA6ICfri6Tsi5wg67aE66WY7ZWgIOyngOy2nOydtCDsl4bsirXri4jri6QuJyk7CiAgICByZW5kZXIoKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g66as7Y+s7Yq4IC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcGVyaW9kTGFiZWwocCkgewogICAgY29uc3QgeyBtLCBkIH0gPSBMLnBhcnNlSVNPKHAuc3RhcnQpOwogICAgcmV0dXJuIFMoKS5zZXR0aW5ncy5zdGFydERheSA9PT0gMSA/IGAke2197JuUYCA6IGAke219LyR7ZH1gOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUmVwb3J0KCkgewogICAgY29uc3QgY21wID0gTC5jb21wYXJlV2l0aFByZXZpb3VzKFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICBjb25zdCBzdW0gPSBjbXAuY3VycmVudDsKICAgIGNvbnN0IGRpZmYgPSBjbXAudG90YWxEaWZmOwogICAgY29uc3QgcHJldlNwZW50ID0gY21wLnByZXZpb3VzLnRvdGFsU3BlbnQ7CiAgICBsZXQgZGVsdGFUZXh0OwogICAgaWYgKCFwcmV2U3BlbnQgJiYgIXN1bS50b3RhbFNwZW50KSBkZWx0YVRleHQgPSAn7JWE7KeBIOyngOy2nOydtCDsl4bslrTsmpQuJzsKICAgIGVsc2UgaWYgKCFwcmV2U3BlbnQpIGRlbHRhVGV4dCA9ICfsp4Drgpwg6riw6rCEIOq4sOuhneydtCDsl4bslrQg67mE6rWQ7ZWgIOyImCDsl4bslrTsmpQuJzsKICAgIGVsc2UgaWYgKGRpZmYgPiAwKSBkZWx0YVRleHQgPSBg7KeA64KcIOq4sOqwhOuztOuLpCA8Yj4ke3dvbihkaWZmKX0g642UPC9iPiDsjbzslrTsmpQg4payYDsKICAgIGVsc2UgaWYgKGRpZmYgPCAwKSBkZWx0YVRleHQgPSBg7KeA64KcIOq4sOqwhOuztOuLpCA8Yj4ke3dvbigtZGlmZil9IOuNnDwvYj4g7I287Ja07JqUIOKWvGA7CiAgICBlbHNlIGRlbHRhVGV4dCA9ICfsp4Drgpwg6riw6rCE6rO8IOuYkeqwmeydtCDsjbzslrTsmpQuJzsKICAgIGNvbnN0IGJ1ZGdldExpbmUgPSBzdW0uaGFzSW5jb21lICYmIHN1bS5pbmNvbWUgPiAwID8gYDxkaXYgY2xhc3M9ImRlbHRhIj7smIjsgrDsnZggPGI+JHtNYXRoLnJvdW5kKChzdW0udG90YWxTcGVudCAvIHN1bS5pbmNvbWUpICogMTAwKX0lPC9iPiDsgqzsmqk8L2Rpdj5gIDogJyc7CiAgICAkKCcjcmVwb3J0LWhlYWRsaW5lJykuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJtdXRlZCBzbWFsbCI+7J2067KIIOq4sOqwhCDsp4Dstpw8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGVhZGxpbmUtZmlndXJlIj4ke3dvbihzdW0udG90YWxTcGVudCl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRlbHRhIj4ke2RlbHRhVGV4dH08L2Rpdj4KICAgICAgJHtidWRnZXRMaW5lfWA7CgogICAgY29uc3QgdG9wID0gTC50b3BNZXJjaGFudHMoc3VtLmFsbFRyYW5zYWN0aW9ucywgNSk7CiAgICAkKCcjcmVwb3J0LW1lcmNoYW50cycpLmlubmVySFRNTCA9IGA8aDI+66eO7J20IOyTtCDqs7M8L2gyPiR7dG9wLmxlbmd0aAogICAgICA/IHRvcC5tYXAoKG0sIGkpID0+IGA8ZGl2IGNsYXNzPSJyYW5rIj48c3BhbiBjbGFzcz0ibiI+JHtpICsgMX08L3NwYW4+PHNwYW4gY2xhc3M9Im0iPiR7ZXNjKG0ubWVtbyl9IDxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+JHttLmNvdW50fe2ajDwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9ImEiPiR7d29uKG0udG90YWwpfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCcnKQogICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7KeA7Lac7J20IOyXhuyWtOyalC48L2Rpdj4nfWA7CgogICAgY29uc3Qgcm93cyA9IEwuY2F0ZWdvcnlCcmVha2Rvd24oc3VtKTsKICAgIGNvbnN0IGRpZmZCeUlkID0ge307CiAgICBmb3IgKGNvbnN0IHIgb2YgY21wLnJvd3MpIGRpZmZCeUlkW3IuaWRdID0gci5kaWZmOwogICAgY29uc3Qgc2hhcmUgPSAkKCcjcmVwb3J0LXNoYXJlJyk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSB7CiAgICAgIHNoYXJlLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7J20IOq4sOqwhCDsp4DstpzsnbQg7JeG7Ja07JqULjwvZGl2Pic7CiAgICB9IGVsc2UgewogICAgICBjb25zdCBmbXREaWZmID0gKGQpID0+IChkID09PSB1bmRlZmluZWQgPyAnJyA6IGQgPiAwID8gYOKWsiAke3dvbihkKX1gIDogZCA8IDAgPyBg4pa8ICR7d29uKC1kKX1gIDogJ+uzgOuPmSDsl4bsnYwnKTsKICAgICAgc2hhcmUuaW5uZXJIVE1MID0gQy5zaGFyZUJhcihyb3dzKSArIHJvd3MubWFwKChyKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0ic2hhcmUtcm93Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzaGFyZS1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDoke0Muc2VyaWVzQ29sb3Ioci5jb2xvckluZGV4KX0iPjwvc3Bhbj48c3Bhbj4ke2VzYyhyLm5hbWUpfSA8c3BhbiBjbGFzcz0ibXV0ZWQgc21hbGwiPiR7TWF0aC5yb3VuZChyLnNoYXJlICogMTAwKX0lPC9zcGFuPjwvc3Bhbj48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic2hhcmUtYW1vdW50Ij4ke3dvbihyLmFtb3VudCl9PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InNoYXJlLWRpZmYiIHRpdGxlPSLsp4Drgpwg6riw6rCEIOuMgOu5hCI+JHtmbXREaWZmKGRpZmZCeUlkW3IuaWRdKX08L3NwYW4+CiAgICAgICAgPC9kaXY+YCkuam9pbignJyk7CiAgICAgIGNvbnN0IHNlZ3MgPSBDLnNoYXJlU2VnbWVudHMocm93cyk7CiAgICAgIHNoYXJlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXNlZ10nKS5mb3JFYWNoKChlbCkgPT4gewogICAgICAgIGNvbnN0IHMgPSBzZWdzW2VsLmRhdGFzZXQuc2VnXTsKICAgICAgICBhdHRhY2hUb29sdGlwKGVsLCAoKSA9PiBgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiR7cy5jb2xvcn0iPjwvc3Bhbj4ke2VzYyhzLm5hbWUpfTwvc3Bhbj48c3Bhbj4ke3dvbihzLmFtb3VudCl9PC9zcGFuPjwvZGl2PmApOwogICAgICB9KTsKICAgIH0KCiAgICBjb25zdCB0ciA9IEwudHJlbmQoUygpLCBjdXJyZW50UGVyaW9kLCA2KTsKICAgIGNvbnN0IGRhdGEgPSB0ci5tYXAoKHgpID0+ICh7IGxhYmVsOiBwZXJpb2RMYWJlbCh4LnBlcmlvZCksIGluY29tZTogeC5idWRnZXRJbmNvbWUgIT09IG51bGwgPyB4LmJ1ZGdldEluY29tZSA6IHguaW5jb21lUmVjZWl2ZWQsIHNwZW50OiB4LnNwZW50IH0pKTsKICAgIGNvbnN0IHRyZW5kRWwgPSAkKCcjcmVwb3J0LXRyZW5kJyk7CiAgICB0cmVuZEVsLmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0ibGVnZW5kIj48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1zMSkiPjwvc3Bhbj7siJjsnoU8L3NwYW4+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tczIpIj48L3NwYW4+7KeA7LacPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjaGFydCI+JHtDLnRyZW5kQ2hhcnQoZGF0YSl9PC9kaXY+YDsKICAgIHRyZW5kRWwucXVlcnlTZWxlY3RvckFsbCgnLmhpdCcpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgIGNvbnN0IGkgPSBOdW1iZXIoZWwuZGF0YXNldC5pKTsKICAgICAgY29uc3QgeCA9IHRyW2ldOwogICAgICBhdHRhY2hUb29sdGlwKGVsLCAoKSA9PiBgCiAgICAgICAgPHN0cm9uZz4ke2ZtdERhdGUoeC5wZXJpb2Quc3RhcnQpfSB+PC9zdHJvbmc+CiAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMxKSI+PC9zcGFuPuyImOyehSR7eC5idWRnZXRJbmNvbWUgPT09IG51bGwgPyAnICjrsJvsnYAg7J6F6riIKScgOiAnJ308L3NwYW4+PHNwYW4+JHt3b24oZGF0YVtpXS5pbmNvbWUgfHwgMCl9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1zMikiPjwvc3Bhbj7sp4Dstpw8L3NwYW4+PHNwYW4+JHt3b24oeC5zcGVudCl9PC9zcGFuPjwvZGl2PmApOwogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBjdXJyZW50UGVyaW9kID0geC5wZXJpb2Q7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyekOyCsCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckFzc2V0cygpIHsKICAgIGNvbnN0IGEgPSBMLmFzc2V0U3VtbWFyeShTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgY29uc3QgaGFzQmFsYW5jZSA9IGEuYmFua3Muc29tZSgoYikgPT4gdHlwZW9mIGIuYmFsYW5jZSA9PT0gJ251bWJlcicpOwogICAgJCgnI2Fzc2V0LWhlcm8nKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9ImxhYmVsIj7qs4Tsoowg7J6U7JWhIO2VqeqzhDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUiPiR7aGFzQmFsYW5jZSA/IHdvbihhLnRvdGFsKSA6ICfigJQnfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPiR7YS5zYXZpbmdzID8gYOyggOy2lSDqs4TsoowgJHt3b24oYS5zYXZpbmdzKX0gwrcgYCA6ICcnfeuTseuhne2VnCDqs4TsoowgJHthLmJhbmtzLmxlbmd0aH3qsJwsIOy5tOuTnCAke2EuY2FyZHMubGVuZ3RofeqwnDwvZGl2PmA7CgogICAgY29uc3QgYmFua3MgPSAkKCcjYXNzZXQtYmFua3MnKTsKICAgIGJhbmtzLmlubmVySFRNTCA9IGEuYmFua3MubGVuZ3RoCiAgICAgID8gYS5iYW5rcy5tYXAoKGIpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtaWNvbiI+JHtlc2MoKGIubmFtZSB8fCAn6rOE7KKMJykuc2xpY2UoMCwgMSkpfTwvZGl2PgogICAgICAgICAgPGRpdj48ZGl2IGNsYXNzPSJhY2N0LW5hbWUiPiR7ZXNjKGFjY291bnROYW1lKGIuaWQpKX08L2Rpdj48ZGl2IGNsYXNzPSJhY2N0LXN1YiI+64Gd7J6Q66asICR7ZXNjKGIubGFzdDQgfHwgJy0tLS0nKX0ke2IuaXNTYXZpbmdzID8gJyDCtyDsoIDstpUnIDogJyd9JHtiLnNwZW50ID8gYCDCtyDsnbTrsogg6riw6rCEIOy2nOq4iCAke3dvbihiLnNwZW50KX1gIDogJyd9PC9kaXY+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0LWJhbCI+JHt0eXBlb2YgYi5iYWxhbmNlID09PSAnbnVtYmVyJyA/IHdvbihiLmJhbGFuY2UpIDogJzxzcGFuIGNsYXNzPSJtdXRlZCI+7J6U7JWhIOuvuOyeheugpTwvc3Bhbj4nfQogICAgICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0LXN1YiI+JHtiLmJhbGFuY2VBdCA/IGAke2ZtdERhdGVUaW1lKGIuYmFsYW5jZUF0KX0g6riw7KSAIGAgOiAnJ308YnV0dG9uIGNsYXNzPSJsaW5rIGVkaXQtYmFsYW5jZSIgZGF0YS1pZD0iJHtlc2MoYi5pZCl9Ij7siJjsoJU8L2J1dHRvbj48L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7rk7HroZ3tlZwg6rOE7KKM6rCAIOyXhuyWtOyalC4gPGJ1dHRvbiBjbGFzcz0ibGluayIgZGF0YS1nb3RvPSJzZXR0aW5ncyI+6rOE7KKMIOuTseuhne2VmOq4sDwvYnV0dG9uPjwvZGl2Pic7CiAgICBiYW5rcy5xdWVyeVNlbGVjdG9yQWxsKCcuZWRpdC1iYWxhbmNlJykuZm9yRWFjaCgoYnRuKSA9PiBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGNvbnN0IGFjYyA9IFMoKS5hY2NvdW50cy5maW5kKCh4KSA9PiB4LmlkID09PSBidG4uZGF0YXNldC5pZCk7CiAgICAgIGNvbnN0IHYgPSBwcm9tcHQoYCR7YWNjb3VudE5hbWUoYWNjLmlkKX0g7J2YIO2YhOyerCDsnpTslaEo7JuQKWAsIHR5cGVvZiBhY2MuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBTdHJpbmcoYWNjLmJhbGFuY2UpIDogJycpOwogICAgICBpZiAodiA9PT0gbnVsbCkgcmV0dXJuOwogICAgICBjb25zdCBuID0gcGFyc2VBbW91bnRJbnB1dCh2KTsKICAgICAgaWYgKG4gPT09IG51bGwpIHJldHVybiB0b2FzdCgn7Iir7J6Q66GcIOyeheugpe2VtCDso7zshLjsmpQuJyk7CiAgICAgIGFjYy5iYWxhbmNlID0gbjsKICAgICAgYWNjLmJhbGFuY2VBdCA9IG5vd0lTTygpOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgICByZW5kZXIoKTsKICAgIH0pKTsKCiAgICAkKCcjYXNzZXQtY2FyZHMnKS5pbm5lckhUTUwgPSBhLmNhcmRzLmxlbmd0aAogICAgICA/IGEuY2FyZHMubWFwKChjKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iYWNjdCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0LWljb24gaXMtY2FyZCI+JHtlc2MoKGMubmFtZSB8fCAn7Lm065OcJykuc2xpY2UoMCwgMSkpfTwvZGl2PgogICAgICAgICAgPGRpdj48ZGl2IGNsYXNzPSJhY2N0LW5hbWUiPiR7ZXNjKGFjY291bnROYW1lKGMuaWQpKX08L2Rpdj48ZGl2IGNsYXNzPSJhY2N0LXN1YiI+64Gd7J6Q66asICR7ZXNjKGMubGFzdDQgfHwgJy0tLS0nKX08L2Rpdj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3dvbihjLnNwZW50KX08L2Rpdj4KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKSArIChhLnVubGlua2VkU3BlbnQgPyBgPGRpdiBjbGFzcz0iYWNjdCI+PGRpdiBjbGFzcz0iYWNjdC1pY29uIGlzLWNhcmQiPj88L2Rpdj48ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+6rKw7KCc7IiY64uoIOuqqOumhDwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7slYzrprzsl5DshJwg7Lm065Ocwrfqs4Tsoozrpbwg7LC+7KeAIOuqu+2VnCDsp4Dstpw8L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJhY2N0LWJhbCI+JHt3b24oYS51bmxpbmtlZFNwZW50KX08L2Rpdj48L2Rpdj5gIDogJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7rk7HroZ3tlZwg7Lm065Oc6rCAIOyXhuyWtOyalC48L2Rpdj4nOwogICAgJCQoJyNhc3NldC1iYW5rcyBbZGF0YS1nb3RvXSwgI2Fzc2V0LWNhcmRzIFtkYXRhLWdvdG9dJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNob3dQYWdlKGIuZGF0YXNldC5nb3RvKSkpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsmIjsgrAg6rOE7ZqNIC0tLS0tLS0tLS0KCiAgLy8g7J20IOq4sOqwhOydmCDqs4Ttmo3snYQg6rOg7LmY6riwIOyghOyXkCDtmLjstpw6IOyngOuCnCDquLDqsIQg6rOE7ZqN7J2EIOusvOugpOuwm+qzoCDsnojsl4jri6TrqbQg7J20IOq4sOqwhOu2gO2EsCDsoIHsmqnrkJjripQg7IOIIOqzhO2ajeydhCDrp4zrk6Dri6QuCiAgLy8g7ZWc64+EIOqzhOyCsCDrsKnsi53rp4wg67CU6r+AIOuVjDog67aE66WY7JmAIOyDgeq0gOyXhuycvOuLiCAn64uk7IucIOu2hOulmCcg7JWI64K06rCAIOucqOyngCDslYrqsowg7IiY7KCVIOyLnOqwgeydhCDqt7jrjIDroZwg65GU64ukCiAgZnVuY3Rpb24gYnVkZ2V0UGxhbigpIHsKICAgIGNvbnN0IGJlZm9yZSA9IGN1cnJlbnRQbGFuKCk7CiAgICBjb25zdCBwbGFuID0gTC5lbnN1cmVQbGFuRm9yKFMoKSwgY3VycmVudFBlcmlvZC5rZXksIG5vd0lTTygpKTsKICAgIGlmIChwbGFuICE9PSBiZWZvcmUpIHBsYW4udXBkYXRlZEF0ID0gYmVmb3JlLnVwZGF0ZWRBdDsKICAgIHJldHVybiBwbGFuOwogIH0KCiAgZnVuY3Rpb24gZWRpdGFibGVQbGFuKCkgewogICAgY29uc3QgcGxhbiA9IEwuZW5zdXJlUGxhbkZvcihTKCksIGN1cnJlbnRQZXJpb2Qua2V5LCBub3dJU08oKSk7CiAgICBwbGFuLnVwZGF0ZWRBdCA9IG5vd0lTTygpOwogICAgcmV0dXJuIHBsYW47CiAgfQoKICBmdW5jdGlvbiByZW5kZXJQbGFuVmVyc2lvbigpIHsKICAgIGNvbnN0IHBsYW4gPSBjdXJyZW50UGxhbigpOwogICAgY29uc3QgaW5oZXJpdGVkID0gcGxhbi5mcm9tICE9PSBjdXJyZW50UGVyaW9kLmtleTsKICAgIGNvbnN0IG5leHQgPSBMLm5leHRQbGFuQWZ0ZXIoUygpLCB7IGZyb206IGN1cnJlbnRQZXJpb2Qua2V5IH0pOwogICAgY29uc3QgcGFydHMgPSBbYDxiPiR7Zm10RGF0ZShjdXJyZW50UGVyaW9kLnN0YXJ0KX0g6riw6rCE7J2YIOqzhO2ajTwvYj5gXTsKICAgIHBhcnRzLnB1c2gocGxhbi5mcm9tID09PSBMLkJBU0VfUExBTl9GUk9NID8gJ+yymOydjOu2gO2EsCDsk7DrjZgg6rOE7ZqN7J6F64uI64ukLicgOiBgJHtmbXREYXRlKHBsYW4uZnJvbSl9IOq4sOqwhOu2gO2EsCDsoIHsmqnrkJwg6rOE7ZqN7J6F64uI64ukLmApOwogICAgcGFydHMucHVzaChpbmhlcml0ZWQKICAgICAgPyAn7Jes6riw7IScIOqzoOy5mOuptCA8Yj7snbTrsogg6riw6rCE67aA7YSwPC9iPiDsg4gg6rOE7ZqN7Jy866GcIOyggOyepeuQmOqzoCwg7KeA64KcIOq4sOqwhOydgCDqt7jrlYwg6rOE7ZqNIOq3uOuMgOuhnCDrgqjslYTsmpQuJwogICAgICA6ICfqs6DsuZjrqbQg7J20IOq4sOqwhOqzvCDsnbTtm4Qg6riw6rCE7JeQIOyggeyaqeuQmOqzoCwg7KeA64KcIOq4sOqwhOydgCDqt7jrjIDroZwg64Ko7JWE7JqULicpOwogICAgaWYgKG5leHQpIHBhcnRzLnB1c2goYCR7Zm10RGF0ZShuZXh0LmZyb20pfSDquLDqsITrtoDthLDripQg6re4IOuSpOyXkCDrsJTqvrwg6rOE7ZqN7J20IOyggeyaqeuPvOyalC5gKTsKICAgICQoJyNwbGFuLXZlcnNpb24nKS5pbm5lckhUTUwgPSBwYXJ0cy5tYXAoKHgpID0+IGA8ZGl2IGNsYXNzPSJzbWFsbCI+JHt4fTwvZGl2PmApLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUGxhbigpIHsKICAgIHJlbmRlclBsYW5WZXJzaW9uKCk7CiAgICBjb25zdCBwbGFuID0gY3VycmVudFBsYW4oKTsKICAgICQoJyNyYXRpby1iYXNlJykudmFsdWUgPSBwbGFuLnJhdGlvQmFzZTsKICAgICQoJyNmaXhlZC1vdmVyZmxvdycpLnZhbHVlID0gcGxhbi5maXhlZE92ZXJmbG93IHx8ICd3YXJuJzsKCiAgICBjb25zdCByb3dzRWwgPSAkKCcjcGxhbi1yb3dzJyk7CiAgICByb3dzRWwuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJwbGFuLXJvdyBoZWFkIj48c3Bhbj7tla3rqqkg7J2066aEPC9zcGFuPjxzcGFuPuuwqeyLnTwvc3Bhbj48c3Bhbj7ruYTsnKggLyDquIjslaE8L3NwYW4+PHNwYW4+7ISk66qFIChBSSDssLjqs6ApPC9zcGFuPjxzcGFuPu2CpOybjOuTnDwvc3Bhbj48c3Bhbj48L3NwYW4+PC9kaXY+CiAgICAgICR7cGxhbi5jYXRlZ29yaWVzLm1hcCgoYykgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9InBsYW4tcm93IiBkYXRhLWlkPSIke2VzYyhjLmlkKX0iPgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJwbC1uYW1lIiB2YWx1ZT0iJHtlc2MoYy5uYW1lKX0iIGFyaWEtbGFiZWw9Iu2VreuqqSDsnbTrpoQiPgogICAgICAgICAgPHNlbGVjdCBjbGFzcz0icGwtdHlwZSIgYXJpYS1sYWJlbD0i67Cp7IudIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmF0aW8iICR7Yy50eXBlID09PSAncmF0aW8nID8gJ3NlbGVjdGVkJyA6ICcnfT7siJjsnoUg67mE66GAKCUpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImZpeGVkIiAke2MudHlwZSA9PT0gJ2ZpeGVkJyA/ICdzZWxlY3RlZCcgOiAnJ30+6rOg7KCVIOq4iOyVoTwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ2YWx1ZS13cmFwIj4KICAgICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlucHV0bW9kZT0iZGVjaW1hbCIgY2xhc3M9InBsLXZhbHVlIiB2YWx1ZT0iJHtjLnR5cGUgPT09ICdmaXhlZCcgPyBOdW1iZXIoYy52YWx1ZSkudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJykgOiBjLnZhbHVlfSIgYXJpYS1sYWJlbD0i6rCSIj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InVuaXQiPiR7Yy50eXBlID09PSAnZml4ZWQnID8gJ+ybkCcgOiAnJSd9PC9zcGFuPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InBsLWRlc2MiIHZhbHVlPSIke2VzYyhjLmRlc2NyaXB0aW9uIHx8ICcnKX0iIHBsYWNlaG9sZGVyPSLsmIg6IOyZuOyLnSwg67Cw64usLCDsnqXrs7TquLAiIGFyaWEtbGFiZWw9IuyEpOuqhSI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InBsLWt3IiB2YWx1ZT0iJHtlc2MoKGMua2V5d29yZHMgfHwgW10pLmpvaW4oJywgJykpfSIgcGxhY2Vob2xkZXI9IuyYiDog7Iqk7YOA67KF7IqkLCDsubTtjpgiIGFyaWEtbGFiZWw9Iu2CpOybjOuTnCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJsaW5rLWJ0biBwbC1kZWwiIGFyaWEtbGFiZWw9IiR7ZXNjKGMubmFtZSl9IOyCreygnCI+4pyVPC9idXR0b24+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJwcmV2aWV3Ij48L2Rpdj4KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKX1gOwoKICAgIGNvbnN0IGVkaXQgPSAoaWQsIGZuLCByZXJlbmRlcikgPT4gewogICAgICBjb25zdCBjID0gZWRpdGFibGVQbGFuKCkuY2F0ZWdvcmllcy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgIGZuKGMpOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgICBpZiAocmVyZW5kZXIpIHJlbmRlclBsYW4oKTsKICAgICAgZWxzZSB7CiAgICAgICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgICAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogICAgICB9CiAgICB9OwoKICAgIHJvd3NFbC5xdWVyeVNlbGVjdG9yQWxsKCcucGxhbi1yb3dbZGF0YS1pZF0nKS5mb3JFYWNoKChyb3cpID0+IHsKICAgICAgY29uc3QgaWQgPSByb3cuZGF0YXNldC5pZDsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1uYW1lJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiAoYy5uYW1lID0gZS50YXJnZXQudmFsdWUudHJpbSgpIHx8ICfsnbTrpoQg7JeG7J2MJykpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC10eXBlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiB7CiAgICAgICAgYy50eXBlID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgYy52YWx1ZSA9IDA7CiAgICAgIH0sIHRydWUpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC12YWx1ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBlZGl0KGlkLCAoYykgPT4gewogICAgICAgIGNvbnN0IG4gPSBOdW1iZXIoZS50YXJnZXQudmFsdWUucmVwbGFjZSgvW15cZC5dL2csICcnKSkgfHwgMDsKICAgICAgICBjLnZhbHVlID0gYy50eXBlID09PSAnZml4ZWQnID8gTWF0aC5yb3VuZChuKSA6IE1hdGgucm91bmQobiAqIDEwMCkgLyAxMDA7CiAgICAgICAgaWYgKGMudHlwZSA9PT0gJ2ZpeGVkJykgZS50YXJnZXQudmFsdWUgPSBjLnZhbHVlLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpOwogICAgICB9KSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcucGwtZGVzYycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBlZGl0KGlkLCAoYykgPT4gKGMuZGVzY3JpcHRpb24gPSBlLnRhcmdldC52YWx1ZS50cmltKCkpKSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcucGwta3cnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IHsKICAgICAgICBjLmtleXdvcmRzID0gZS50YXJnZXQudmFsdWUuc3BsaXQoL1ss77yMXS8pLm1hcCgocykgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKTsKICAgICAgfSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLWRlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGNvbnN0IGMgPSBjdXJyZW50UGxhbigpLmNhdGVnb3JpZXMuZmluZCgoeCkgPT4geC5pZCA9PT0gaWQpOwogICAgICAgIGlmICghY29uZmlybShgJyR7Yy5uYW1lfScg7ZWt66qp7J2EIOydtOuyiCDquLDqsIQg6rOE7ZqN67aA7YSwIOu6hOq5jOyalD8g7J20IO2VreuqqeycvOuhnCDrtoTrpZjrkJwg7J2067KIIOq4sOqwhCDsp4DstpzsnYAg64uk7IucIOu2hOulmO2VtOyVvCDtlanri4jri6QuYCkpIHJldHVybjsKICAgICAgICBjb25zdCBwID0gZWRpdGFibGVQbGFuKCk7CiAgICAgICAgcC5jYXRlZ29yaWVzID0gcC5jYXRlZ29yaWVzLmZpbHRlcigoeCkgPT4geC5pZCAhPT0gaWQpOwogICAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgICAgcmVuZGVyUGxhbigpOwogICAgICB9KTsKICAgIH0pOwogICAgcmVuZGVyUGxhblN1bW1hcnkoKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclBsYW5TdW1tYXJ5KCkgewogICAgY29uc3QgcGxhbiA9IGN1cnJlbnRQbGFuKCk7CiAgICBjb25zdCBpbmNvbWUgPSBTKCkuaW5jb21lc1tjdXJyZW50UGVyaW9kLmtleV07CiAgICBjb25zdCBoYXNJbmNvbWUgPSB0eXBlb2YgaW5jb21lID09PSAnbnVtYmVyJzsKICAgIGNvbnN0IGNhbGMgPSBMLmNvbXB1dGVCdWRnZXRzKHBsYW4uY2F0ZWdvcmllcywgaGFzSW5jb21lID8gaW5jb21lIDogMCwgcGxhbi5yYXRpb0Jhc2UsIHBsYW4uZml4ZWRPdmVyZmxvdyk7CgogICAgJCQoJy5wbGFuLXJvd1tkYXRhLWlkXScpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBjID0gcGxhbi5jYXRlZ29yaWVzLmZpbmQoKHgpID0+IHguaWQgPT09IHJvdy5kYXRhc2V0LmlkKTsKICAgICAgY29uc3QgcCA9IHJvdy5xdWVyeVNlbGVjdG9yKCcucHJldmlldycpOwogICAgICBpZiAoIWMpIHJldHVybjsKICAgICAgaWYgKGMudHlwZSA9PT0gJ2ZpeGVkJykgewogICAgICAgIHAudGV4dENvbnRlbnQgPSBoYXNJbmNvbWUgJiYgY2FsYy5maXhlZFNjYWxlZAogICAgICAgICAgPyBg7J2067KIIOq4sOqwhCDtlZzrj4QgJHt3b24oY2FsYy5idWRnZXRzW2MuaWRdKX0gKOyImOyeheydtCDrqqjsnpDrnbwg7KSE7J6EKWAKICAgICAgICAgIDogJ+yImOyeheqzvCDsg4HqtIDsl4bsnbQg66ekIOq4sOqwhCDqsJnsnYAg7ZWc64+EJzsKICAgICAgfQogICAgICBlbHNlIHAudGV4dENvbnRlbnQgPSBoYXNJbmNvbWUgPyBg7J2067KIIOq4sOqwhCDtlZzrj4QgJHt3b24oY2FsYy5idWRnZXRzW2MuaWRdKX1gIDogJ+uLueq4sCDsiJjsnoXsnYQg7J6F66Cl7ZWY66m0IO2VnOuPhOqwgCDqs4TsgrDrkKnri4jri6QnOwogICAgfSk7CgogICAgY29uc3QgYmFzZSA9IHBsYW4ucmF0aW9CYXNlID09PSAnYWZ0ZXJGaXhlZCcgPyAn6rOg7KCVIO2VreuqqeydhCDruoAg64KY66i47KeAJyA6ICfsoITssrQg7IiY7J6FJzsKICAgIGNvbnN0IGxpbmVzID0gW2Dqs6DsoJUg7ZWt66qpIO2VqeqzhCA8Yj4ke3dvbihjYWxjLmZpeGVkVG90YWwpfTwvYj4gwrcg67mE7JyoIO2VreuqqSDtlanqs4QgPGI+JHtjYWxjLnJhdGlvUGVyY2VudFRvdGFsfSU8L2I+ICgke2Jhc2V9IOq4sOykgClgXTsKICAgIGlmIChjYWxjLnJhdGlvUGVyY2VudFRvdGFsID4gMTAwKSBsaW5lcy5wdXNoKCc8c3BhbiBjbGFzcz0id2FybiI+4pqgIOu5hOycqCDtlanqs4TqsIAgMTAwJeulvCDrhJjsirXri4jri6QuPC9zcGFuPicpOwogICAgZWxzZSBpZiAoY2FsYy5yYXRpb1BlcmNlbnRUb3RhbCA8IDEwMCkgbGluZXMucHVzaChgPHNwYW4gY2xhc3M9Im11dGVkIj7ruYTsnKgg7ZWp6rOE6rCAIDEwMCXrs7Tri6QgJHtNYXRoLnJvdW5kKCgxMDAgLSBjYWxjLnJhdGlvUGVyY2VudFRvdGFsKSAqIDEwMCkgLyAxMDB9JSDsoIHslrQg7J2867aAIOyImOyeheydgCDrsLDrtoTrkJjsp4Ag7JWK7Iq164uI64ukLjwvc3Bhbj5gKTsKICAgIGlmIChoYXNJbmNvbWUpIHsKICAgICAgbGluZXMucHVzaChg7J2067KIIOq4sOqwhCDsiJjsnoUgJHt3b24oaW5jb21lKX0g6riw7KSAOiDrsLDrtoQgJHt3b24oY2FsYy5hbGxvY2F0ZWQpfWAgKwogICAgICAgIChjYWxjLnVuYWxsb2NhdGVkID49IDAgPyBgIMK3IOuCqOuKlCDrj4ggJHt3b24oY2FsYy51bmFsbG9jYXRlZCl9YCA6IGAgwrcgPHNwYW4gY2xhc3M9Indhcm4iPiR7d29uKC1jYWxjLnVuYWxsb2NhdGVkKX0g67aA7KGxPC9zcGFuPmApKTsKICAgICAgaWYgKGNhbGMuZml4ZWRPdmVyKSB7CiAgICAgICAgbGluZXMucHVzaChjYWxjLmZpeGVkU2NhbGVkCiAgICAgICAgICA/IGA8c3BhbiBjbGFzcz0id2FybiI+4pqgIOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOyImOyeheuztOuLpCAke3dvbihjYWxjLmZpeGVkT3Zlcil9IOunjuyVhCwg6rOg7KCVIO2VreuqqSDtlZzrj4Trpbwg7JW9ICR7TWF0aC5yb3VuZChjYWxjLmZpeGVkU2NhbGUgKiAxMDApfSXroZwg7KSE7JiA7Iq164uI64ukLjwvc3Bhbj5gCiAgICAgICAgICA6IGA8c3BhbiBjbGFzcz0id2FybiI+4pqgIOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOyImOyeheuztOuLpCAke3dvbihjYWxjLmZpeGVkT3Zlcil9IOunjuyKteuLiOuLpC48L3NwYW4+YCk7CiAgICAgIH0KICAgIH0KICAgICQoJyNwbGFuLXN1bW1hcnknKS5pbm5lckhUTUwgPSBsaW5lcy5tYXAoKGwpID0+IGA8ZGl2PiR7bH08L2Rpdj5gKS5qb2luKCcnKTsKICB9CgogIGZ1bmN0aW9uIGFkZENhdGVnb3J5KCkgewogICAgY29uc3QgcGxhbiA9IGVkaXRhYmxlUGxhbigpOwogICAgcGxhbi5jYXRlZ29yaWVzLnB1c2goeyBpZDogYGMtJHt1aWQoKX1gLCBuYW1lOiAn7IOIIO2VreuqqScsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiAwLCBkZXNjcmlwdGlvbjogJycsIGtleXdvcmRzOiBbXSB9KTsKICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICByZW5kZXJQbGFuKCk7CiAgICBjb25zdCBpbnB1dHMgPSAkJCgnLnBsLW5hbWUnKTsKICAgIGNvbnN0IGxhc3QgPSBpbnB1dHNbaW5wdXRzLmxlbmd0aCAtIDFdOwogICAgbGFzdC5mb2N1cygpOwogICAgbGFzdC5zZWxlY3QoKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6F66ClIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQWRkKCkgewogICAgJCgnI2F1dG8taGludCcpLmlubmVySFRNTCA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnCiAgICAgID8gJzxiPuy5tOuTnCDrrLjsnpDsmYAg7J2A7ZaJIOyVjOumvOydgCDsnpDrj5nsnLzroZwg65Ok7Ja07JmA7JqULjwvYj4gPHNwYW4gY2xhc3M9InNtYWxsIj7tnLTrjIDtj7Ag7J6Q64+Z7ZmUKOyEpOyglSDihpIg7J6Q64+ZIOyeheugpSnrpbwg7ZW0IOuRkOuptCDqsrDsoJzCt+ydtOyytCDslYzrprzsnbQg7JisIOuVjOuniOuLpCBBSeqwgCDsnb3qs6Ag67aE66WY7ZW07IScIOq4sOuhne2VqeuLiOuLpC4g7Jes6riw7ISc64qUIOq3uCDrsJbsnZgg64K07Jet7J2EIOuEo+ycvOyEuOyalC48L3NwYW4+JwogICAgICA6ICc8Yj7sp4DquIjsnYAg7J20IOq4sOq4sOyXkOunjCDsoIDsnqXtlZjripQg66qo65Oc7JiI7JqULjwvYj4gPHNwYW4gY2xhc3M9InNtYWxsIj7subTrk5zCt+ydgO2WiSDslYzrprwg7J6Q64+ZIOyeheugpeqzvCBBSSDrtoTrpZjrpbwg7JOw66Ck66m0IOyEpOyglSDihpIg7J6Q64+ZIOyeheugpeyXkOyEnCDqtazquIAg7Iuc7Yq4IOyEnOuyhOulvCDsl7DqsrDtlZjshLjsmpQuPC9zcGFuPic7CiAgICAkKCcjY2xhc3NpZmllci1uYW1lJykudGV4dENvbnRlbnQgPSBzdG9yZS5haUVuYWJsZWQgPyAnQUnqsIAg7ZWt66qpJyA6ICftgqTsm4zrk5zroZwg7ZWt66qpJzsKCiAgICAkJCgnI20ta2luZCBidXR0b24nKS5mb3JFYWNoKChiKSA9PiBiLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGIuZGF0YXNldC5raW5kID09PSBtYW51YWxLaW5kKSk7CiAgICAkKCcjbS1jYXRlZ29yeS13cmFwJykuaGlkZGVuID0gbWFudWFsS2luZCAhPT0gJ2V4cGVuc2UnOwogICAgY29uc3Qgc2VsID0gJCgnI20tY2F0ZWdvcnknKTsKICAgIGNvbnN0IHByZXYgPSBzZWwudmFsdWUgfHwgJ19fYXV0byc7CiAgICBpZiAoISQoJyNtLWRhdGUnKS52YWx1ZSkgJCgnI20tZGF0ZScpLnZhbHVlID0gTC50b2RheUlTTygpOwogICAgc2VsLmlubmVySFRNTCA9IGNhdGVnb3J5T3B0aW9ucyhwbGFuRm9yRGF0ZSgkKCcjbS1kYXRlJykudmFsdWUpLmNhdGVnb3JpZXMsIG51bGwsIHsgaW5jbHVkZUF1dG86IHRydWUgfSk7CiAgICBzZWwudmFsdWUgPSBbLi4uc2VsLm9wdGlvbnNdLnNvbWUoKG8pID0+IG8udmFsdWUgPT09IHByZXYpID8gcHJldiA6ICdfX2F1dG8nOwogICAgY29uc3QgYWNjID0gJCgnI20tYWNjb3VudCcpLnZhbHVlOwogICAgJCgnI20tYWNjb3VudCcpLmlubmVySFRNTCA9IGFjY291bnRPcHRpb25zKGFjYyk7CiAgICBjb25zdCBmaWxlQWNjID0gJCgnI2ZpbGUtYWNjb3VudCcpLnZhbHVlIHx8IChTKCkuYWNjb3VudHMuZmluZCgoYSkgPT4gYS50eXBlICE9PSAnY2FyZCcpIHx8IHt9KS5pZCB8fCAnJzsKICAgICQoJyNmaWxlLWFjY291bnQnKS5pbm5lckhUTUwgPSBhY2NvdW50T3B0aW9ucyhmaWxlQWNjLCAn6rOE7KKMIOyEoO2DnSDslYgg7ZWoJyk7CiAgICAkKCcjbS1tZW1vJykucGxhY2Vob2xkZXIgPSBtYW51YWxLaW5kID09PSAnaW5jb21lJyA/ICco7KO8Ke2ajOyCrCDquInsl6wnIDogbWFudWFsS2luZCA9PT0gJ3RyYW5zZmVyJyA/ICfsoIHquIgg6rOE7KKM66GcJyA6ICfsiqTtg4DrsoXsiqQg6rCV64Ko7KCQJzsKICAgIHVwZGF0ZU1hbnVhbEhpbnQoKTsKICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgfQoKICBmdW5jdGlvbiB1cGRhdGVNYW51YWxIaW50KCkgewogICAgY29uc3QgbWVtbyA9ICQoJyNtLW1lbW8nKS52YWx1ZTsKICAgIGlmIChtYW51YWxLaW5kID09PSAndHJhbnNmZXInKSB7CiAgICAgICQoJyNtLWhpbnQnKS50ZXh0Q29udGVudCA9ICfrgrQg6rOE7KKM64G866asIOyYruq4tCDrj4jsnYAg7KeA7LacwrfsiJjsnoUg7ZWp6rOE7JeQ7IScIOu5oOynkeuLiOuLpC4g7KCA7LaVIOuqqeyggeydtOuptCAi7KeA7LacIuuhnCDrhKPqs6Ag7KCA7LaVIO2VreuqqeydhCDqs6DrpbTshLjsmpQuJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKG1hbnVhbEtpbmQgIT09ICdleHBlbnNlJyB8fCAkKCcjbS1jYXRlZ29yeScpLnZhbHVlICE9PSAnX19hdXRvJyB8fCAhbWVtby50cmltKCkpIHsKICAgICAgJCgnI20taGludCcpLnRleHRDb250ZW50ID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChzdG9yZS5haUVuYWJsZWQpIHsKICAgICAgJCgnI20taGludCcpLnRleHRDb250ZW50ID0gJ+y2lOqwgO2VmOuptCBBSeqwgCDtla3rqqnsnYQg7KCV7ZWp64uI64ukLic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHBsYW4gPSBwbGFuRm9yRGF0ZSgkKCcjbS1kYXRlJykudmFsdWUgfHwgTC50b2RheUlTTygpKTsKICAgIGNvbnN0IHIgPSBMLmNsYXNzaWZ5TG9jYWwobWVtbywgcGxhbi5jYXRlZ29yaWVzLCBTKCkubWVyY2hhbnRNYXApOwogICAgJCgnI20taGludCcpLnRleHRDb250ZW50ID0gYOyekOuPmSDrtoTrpZgg6rKw6rO8OiAke2NhdGVnb3J5SW5mbyhyLmNhdGVnb3J5SWQsIHBsYW4uY2F0ZWdvcmllcykubmFtZX1gOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb25NYW51YWxTdWJtaXQoZSkgewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgZGF0ZSA9ICQoJyNtLWRhdGUnKS52YWx1ZTsKICAgIGNvbnN0IGFtb3VudCA9IHBhcnNlQW1vdW50SW5wdXQoJCgnI20tYW1vdW50JykudmFsdWUpOwogICAgY29uc3QgbWVtbyA9ICQoJyNtLW1lbW8nKS52YWx1ZS50cmltKCkgfHwgJyjrgrTsmqkg7JeG7J2MKSc7CiAgICBpZiAoIWRhdGUpIHJldHVybiB0b2FzdCgn64Kg7Kec66W8IOyeheugpe2VtCDso7zshLjsmpQuJyk7CiAgICBpZiAoYW1vdW50ID09PSBudWxsIHx8IGFtb3VudCA9PT0gMCkgcmV0dXJuIHRvYXN0KCfquIjslaHsnYQg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgIGNvbnN0IHNlbCA9IG1hbnVhbEtpbmQgPT09ICdleHBlbnNlJyA/ICQoJyNtLWNhdGVnb3J5JykudmFsdWUgOiAnJzsKICAgIGlmIChzZWwgJiYgc2VsICE9PSAnX19hdXRvJykgewogICAgICBTKCkubWVyY2hhbnRNYXBbTC5ub3JtYWxpemVNZXJjaGFudChtZW1vKV0gPSBzZWw7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICB9CiAgICBjb25zdCBpdGVtID0gewogICAgICBkYXRlLCBhbW91bnQsIG1lbW8sIGtpbmQ6IG1hbnVhbEtpbmQsIGFjY291bnRJZDogJCgnI20tYWNjb3VudCcpLnZhbHVlIHx8IG51bGwsIHNvdXJjZTogJ21hbnVhbCcsCiAgICAgIGNhdGVnb3J5SWQ6IHNlbCA9PT0gJycgPyBudWxsIDogc2VsLAogICAgICBtZXRob2Q6IHNlbCAmJiBzZWwgIT09ICdfX2F1dG8nID8gJ21hbnVhbCcgOiB1bmRlZmluZWQsCiAgICB9OwogICAgY29uc3QgW3R4XSA9IGF3YWl0IGJ1c3koc2VsID09PSAnX19hdXRvJyAmJiBzdG9yZS5haUVuYWJsZWQgPyAnQUnqsIAg67aE66WY7ZWY64qUIOykkeKApicgOiBudWxsLCAoKSA9PiBzdG9yZS5hZGRUcmFuc2FjdGlvbnMoW2l0ZW1dKSk7CiAgICAkKCcjbS1hbW91bnQnKS52YWx1ZSA9ICcnOwogICAgJCgnI20tbWVtbycpLnZhbHVlID0gJyc7CiAgICB1cGRhdGVNYW51YWxIaW50KCk7CiAgICBjb25zdCB3aGF0ID0gbWFudWFsS2luZCA9PT0gJ2V4cGVuc2UnID8gYCR7Y2F0ZWdvcnlJbmZvKHR4LmNhdGVnb3J5SWQsIHBsYW5Gb3JEYXRlKHR4LmRhdGUpLmNhdGVnb3JpZXMpLm5hbWV9IO2VreuqqeyXkGAgOiBtYW51YWxLaW5kID09PSAnaW5jb21lJyA/ICfsnoXquIjsnLzroZwnIDogJ+uCtCDqs4Tsoowg7J207LK066GcJzsKICAgIHRvYXN0KGAke3doYXR9ICR7d29uKGFtb3VudCl9IOy2lOqwgO2WiOyKteuLiOuLpC5gKTsKICAgIGp1bXBUb0RhdGUoZGF0ZSk7CiAgfQoKICBmdW5jdGlvbiBqdW1wVG9EYXRlKGRhdGUpIHsKICAgIGNvbnN0IHAgPSBMLmdldFBlcmlvZChkYXRlLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgaWYgKHAua2V5ICE9PSBjdXJyZW50UGVyaW9kLmtleSkgY3VycmVudFBlcmlvZCA9IHA7CiAgICByZW5kZXIoKTsKICB9CgogIC8vIOu2meyXrOuEo+q4sOyZgCDtjIzsnbwg6rCA7KC47Jik6riw6rCAIOqwmeydgCDrr7jrpqzrs7TquLDrpbwg7JO064ukLiBwcmV2aWV3LnNvdXJjZTogJ3Bhc3RlJyB8ICdmaWxlJwogIGNvbnN0IHByZXZpZXcgPSB7IHNvdXJjZTogJ3Bhc3RlJywgaXRlbXM6IFtdLCBza2lwcGVkOiBbXSwgbGF0ZXN0OiBudWxsLCBhY2NvdW50SWQ6IG51bGwsIGZpbGVOYW1lOiAnJyB9OwoKICBmdW5jdGlvbiBjbGVhclByZXZpZXcoKSB7CiAgICBPYmplY3QuYXNzaWduKHByZXZpZXcsIHsgaXRlbXM6IFtdLCBza2lwcGVkOiBbXSwgbGF0ZXN0OiBudWxsLCBhY2NvdW50SWQ6IG51bGwsIGZpbGVOYW1lOiAnJyB9KTsKICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgfQoKICAvLyDsp4Dstpzrp4wg67aE66WY7ZWc64ukLiDshJzrsoQoQUkp64qUIOyXrOufrCDrsojsl5Ag64KY64igIOuztOuCuOuLpC4KICBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeVByZXZpZXcoaXRlbXMpIHsKICAgIGNvbnN0IGV4cGVuc2VzID0gaXRlbXMuZmlsdGVyKChpdCkgPT4gaXQua2luZCA9PT0gJ2V4cGVuc2UnKTsKICAgIGNvbnN0IHN0ZXAgPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJyA/IDYwIDogZXhwZW5zZXMubGVuZ3RoIHx8IDE7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGV4cGVuc2VzLmxlbmd0aDsgaSArPSBzdGVwKSB7CiAgICAgIGNvbnN0IGNodW5rID0gZXhwZW5zZXMuc2xpY2UoaSwgaSArIHN0ZXApOwogICAgICBpZiAoc3RvcmUuYWlFbmFibGVkICYmIGV4cGVuc2VzLmxlbmd0aCA+IHN0ZXApIHRvYXN0KGBBSeqwgCDrtoTrpZjtlZjripQg7KSR4oCmICgke01hdGgubWluKGkgKyBzdGVwLCBleHBlbnNlcy5sZW5ndGgpfS8ke2V4cGVuc2VzLmxlbmd0aH0pYCwgNjAwMDApOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeShjaHVuay5tYXAoKHsgZGF0ZSwgYW1vdW50LCBtZW1vIH0pID0+ICh7IGRhdGUsIGFtb3VudCwgbWVtbyB9KSkpOwogICAgICBjaHVuay5mb3JFYWNoKChpdCwgaykgPT4gT2JqZWN0LmFzc2lnbihpdCwgcmVzW2tdKSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiB3aXRoRHVwRmxhZ3MoaXRlbXMpIHsKICAgIHJldHVybiBpdGVtcy5tYXAoKGl0KSA9PiB7CiAgICAgIGNvbnN0IGR1cCA9ICEhTC5maW5kRHVwbGljYXRlKGl0LCBTKCkudHJhbnNhY3Rpb25zKTsKICAgICAgcmV0dXJuIHsgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsLCAuLi5pdCwgZHVwLCBjaGVja2VkOiAhZHVwIH07CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9uUGFyc2UoKSB7CiAgICBjb25zdCB7IGl0ZW1zLCBza2lwcGVkIH0gPSBMLnBhcnNlRXhwZW5zZVRleHQoJCgnI3Bhc3RlLWlucHV0JykudmFsdWUsIEwudG9kYXlJU08oKSk7CiAgICBPYmplY3QuYXNzaWduKHByZXZpZXcsIHsgc291cmNlOiAncGFzdGUnLCBza2lwcGVkLCBsYXRlc3Q6IG51bGwsIGFjY291bnRJZDogbnVsbCwgZmlsZU5hbWU6ICcnIH0pOwogICAgcHJldmlldy5pdGVtcyA9IHdpdGhEdXBGbGFncyhpdGVtcy5tYXAoKGl0KSA9PiAoeyAuLi5pdCwga2luZDogJ2V4cGVuc2UnIH0pKSk7CiAgICBpZiAocHJldmlldy5pdGVtcy5sZW5ndGgpIGF3YWl0IGJ1c3koc3RvcmUuYWlFbmFibGVkID8gYEFJ6rCAICR7cHJldmlldy5pdGVtcy5sZW5ndGh96rG07J2EIOu2hOulmO2VmOuKlCDspJHigKZgIDogbnVsbCwgKCkgPT4gY2xhc3NpZnlQcmV2aWV3KHByZXZpZXcuaXRlbXMpKTsKICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvbkZpbGVDaG9zZW4oZmlsZSkgewogICAgY29uc3QgYWNjb3VudElkID0gJCgnI2ZpbGUtYWNjb3VudCcpLnZhbHVlIHx8IG51bGw7CiAgICBsZXQgcm93czsKICAgIHRyeSB7CiAgICAgIHJvd3MgPSBhd2FpdCB3aW5kb3cuQnVkZ2V0WGxzeC5yZWFkVGFibGVGaWxlKGZpbGUpOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gdG9hc3QoZS5tZXNzYWdlIHx8ICftjIzsnbzsnYQg7J297KeAIOuqu+2WiOyWtOyalC4nLCA3MDAwKTsKICAgIH0KICAgIGNvbnN0IHBhcnNlZCA9IEwucGFyc2VTdGF0ZW1lbnRSb3dzKHJvd3MsIHsgbXlOYW1lOiBTKCkuc2V0dGluZ3MubXlOYW1lLCBhY2NvdW50SWQgfSk7CiAgICBpZiAoIXBhcnNlZC5oZWFkZXIpIHJldHVybiB0b2FzdCgn6rGw656Y64K07JetIO2RnOulvCDssL7sp4Ag66q77ZaI7Ja07JqULiDrgqDsp5zsmYAg6riI7JWhIOy5uOydtCDsnojripQg7J2A7ZaJIOqxsOuemOuCtOyXrSDtjIzsnbzsnbjsp4Ag7ZmV7J247ZW0IOyjvOyEuOyalC4nLCA3MDAwKTsKICAgIE9iamVjdC5hc3NpZ24ocHJldmlldywgeyBzb3VyY2U6ICdmaWxlJywgc2tpcHBlZDogW10sIGxhdGVzdDogcGFyc2VkLmxhdGVzdCwgYWNjb3VudElkLCBmaWxlTmFtZTogZmlsZS5uYW1lIH0pOwogICAgcHJldmlldy5pdGVtcyA9IHdpdGhEdXBGbGFncyhwYXJzZWQuaXRlbXMpOwogICAgaWYgKHBhcnNlZC5za2lwcGVkKSBwcmV2aWV3LnNraXBwZWQgPSBbYOuCoOynnOulvCDsnb3sp4Ag66q77ZWcIOykhCAke3BhcnNlZC5za2lwcGVkfeqwnGBdOwogICAgaWYgKHByZXZpZXcuaXRlbXMubGVuZ3RoKSB7CiAgICAgIGF3YWl0IGJ1c3koc3RvcmUuYWlFbmFibGVkID8gYEFJ6rCAICR7cHJldmlldy5pdGVtcy5maWx0ZXIoKHgpID0+IHgua2luZCA9PT0gJ2V4cGVuc2UnKS5sZW5ndGh96rG07J2EIOu2hOulmO2VmOuKlCDspJHigKZgIDogbnVsbCwgKCkgPT4gY2xhc3NpZnlQcmV2aWV3KHByZXZpZXcuaXRlbXMpKTsKICAgIH0KICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgfQoKICBjb25zdCBLSU5EX0xBQkVMID0geyBpbmNvbWU6ICfsnoXquIgnLCB0cmFuc2ZlcjogJ+uCtCDqs4Tsoowg7J207LK0JyB9OwoKICBmdW5jdGlvbiByZW5kZXJQYXJzZVJlc3VsdCgpIHsKICAgIGNvbnN0IHRhcmdldCA9IHByZXZpZXcuc291cmNlID09PSAnZmlsZScgPyAkKCcjZmlsZS1yZXN1bHQnKSA6ICQoJyNwYXJzZS1yZXN1bHQnKTsKICAgIGNvbnN0IG90aGVyID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyA/ICQoJyNwYXJzZS1yZXN1bHQnKSA6ICQoJyNmaWxlLXJlc3VsdCcpOwogICAgb3RoZXIuaW5uZXJIVE1MID0gJyc7CiAgICBpZiAoIXByZXZpZXcuaXRlbXMubGVuZ3RoICYmICFwcmV2aWV3LnNraXBwZWQubGVuZ3RoKSB7CiAgICAgIHRhcmdldC5pbm5lckhUTUwgPSAnJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgaXRlbXMgPSBwcmV2aWV3Lml0ZW1zOwogICAgY29uc3Qgcm93cyA9IGl0ZW1zLm1hcCgoaXQsIGkpID0+IGAKICAgICAgPHRyPgogICAgICAgIDx0ZD48aW5wdXQgdHlwZT0iY2hlY2tib3giIGRhdGEtaT0iJHtpfSIgY2xhc3M9InAtY2hlY2siICR7aXQuY2hlY2tlZCA/ICdjaGVja2VkJyA6ICcnfSBhcmlhLWxhYmVsPSLstpTqsIAiPjwvdGQ+CiAgICAgICAgPHRkPjxpbnB1dCB0eXBlPSJkYXRlIiBkYXRhLWk9IiR7aX0iIGNsYXNzPSJwLWRhdGUiIHZhbHVlPSIke2l0LmRhdGV9Ij48L3RkPgogICAgICAgIDx0ZCBjbGFzcz0ibWVtbyI+JHtlc2MoaXQubWVtbyl9ICR7aXQuZHVwID8gJzxzcGFuIGNsYXNzPSJ0YWcgd2FybiI+7KSR67O1Pzwvc3Bhbj4nIDogJyd9ICR7aXQua2luZCA9PT0gJ2V4cGVuc2UnID8gbWV0aG9kVGFnKGl0Lm1ldGhvZCkgOiAnJ308L3RkPgogICAgICAgIDx0ZCBjbGFzcz0iYW1vdW50ICR7aXQua2luZCA9PT0gJ2luY29tZScgfHwgaXQuYW1vdW50IDwgMCA/ICdyZWZ1bmQnIDogJyd9Ij4ke2l0LmtpbmQgPT09ICdpbmNvbWUnID8gJysnIDogJyd9JHt3b24oaXQuYW1vdW50KX08L3RkPgogICAgICAgIDx0ZD4ke2l0LmtpbmQgPT09ICdleHBlbnNlJwogICAgICAgICAgPyBgPHNlbGVjdCBkYXRhLWk9IiR7aX0iIGNsYXNzPSJwLWNhdCI+JHtjYXRlZ29yeU9wdGlvbnMocGxhbkZvckRhdGUoaXQuZGF0ZSkuY2F0ZWdvcmllcywgaXQuY2F0ZWdvcnlJZCl9PC9zZWxlY3Q+YAogICAgICAgICAgOiBgPHNwYW4gY2xhc3M9InRhZyI+JHtLSU5EX0xBQkVMW2l0LmtpbmRdfTwvc3Bhbj5gfTwvdGQ+CiAgICAgIDwvdHI+YCkuam9pbignJyk7CiAgICBjb25zdCBkdXBzID0gaXRlbXMuZmlsdGVyKCh4KSA9PiB4LmR1cCkubGVuZ3RoOwogICAgY29uc3QgZGF0ZXMgPSBpdGVtcy5tYXAoKHgpID0+IHguZGF0ZSkuc29ydCgpOwogICAgY29uc3Qgc3VtbWFyeSA9IHByZXZpZXcuc291cmNlID09PSAnZmlsZScgJiYgaXRlbXMubGVuZ3RoCiAgICAgID8gYDxwIGNsYXNzPSJzbWFsbCI+JHtlc2MocHJldmlldy5maWxlTmFtZSl9IMK3ICR7Zm10RGF0ZShkYXRlc1swXSl9IH4gJHtmbXREYXRlKGRhdGVzW2RhdGVzLmxlbmd0aCAtIDFdKX0gwrcgJHtpdGVtcy5sZW5ndGh96rG0JHtkdXBzID8gYCAo7J2066+4IOyeiOuKlCDrgrTsl63snLzroZwg67O07J2064qUICR7ZHVwc33qsbTsnYAg67m8IOuRkOyXiOyWtOyalClgIDogJyd9JHtwcmV2aWV3LmxhdGVzdCA/IGAgwrcg66eI7KeA66eJIOyelOyVoSAke3dvbihwcmV2aWV3LmxhdGVzdC5iYWxhbmNlKX1gIDogJyd9PC9wPmAKICAgICAgOiAnJzsKICAgIHRhcmdldC5pbm5lckhUTUwgPSBgCiAgICAgICR7c3VtbWFyeX0KICAgICAgJHtpdGVtcy5sZW5ndGggPyBgCiAgICAgIDxkaXYgY2xhc3M9InJvdy1hY3Rpb25zIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4gc21hbGwtYnRuIiBpZD0icC1hbGwiPuuqqOuRkCDshKDtg508L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4gc21hbGwtYnRuIiBpZD0icC1ub25lIj7rqqjrkZAg7ZW07KCcPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIj4KICAgICAgICA8dGFibGUgY2xhc3M9InN0YWNrLXRhYmxlIHBhcnNlLXRhYmxlIj4KICAgICAgICAgIDx0aGVhZD48dHI+PHRoPjwvdGg+PHRoPuuCoOynnDwvdGg+PHRoPuyCrOyaqeyymDwvdGg+PHRoIGNsYXNzPSJhbW91bnQiPuq4iOyVoTwvdGg+PHRoPu2VreuqqTwvdGg+PC90cj48L3RoZWFkPgogICAgICAgICAgPHRib2R5PiR7cm93c308L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ctYWN0aW9ucyI+PGJ1dHRvbiBpZD0icC1hZGQiIGNsYXNzPSJwcmltYXJ5LWJ0biI+7ISg7YOd7ZWcICR7aXRlbXMuZmlsdGVyKCh4KSA9PiB4LmNoZWNrZWQpLmxlbmd0aH3qsbQg7LaU6rCAPC9idXR0b24+PC9kaXY+YCA6ICcnfQogICAgICAke3ByZXZpZXcuc2tpcHBlZC5sZW5ndGggPyBgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7qsbTrhIjrm7Qg7KSEICR7cHJldmlldy5za2lwcGVkLmxlbmd0aH3qsJw6ICR7cHJldmlldy5za2lwcGVkLm1hcChlc2MpLmpvaW4oJyAvICcpfTwvcD5gIDogJyd9YDsKCiAgICBjb25zdCBzZXRBbGwgPSAodikgPT4gewogICAgICBpdGVtcy5mb3JFYWNoKCh4KSA9PiAoeC5jaGVja2VkID0gdikpOwogICAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogICAgfTsKICAgIGlmICgkKCcjcC1hbGwnKSkgJCgnI3AtYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRBbGwodHJ1ZSkpOwogICAgaWYgKCQoJyNwLW5vbmUnKSkgJCgnI3Atbm9uZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2V0QWxsKGZhbHNlKSk7CiAgICB0YXJnZXQucXVlcnlTZWxlY3RvckFsbCgnLnAtY2hlY2snKS5mb3JFYWNoKChjKSA9PiBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsKICAgICAgaXRlbXNbYy5kYXRhc2V0LmldLmNoZWNrZWQgPSBjLmNoZWNrZWQ7CiAgICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgICB9KSk7CiAgICB0YXJnZXQucXVlcnlTZWxlY3RvckFsbCgnLnAtZGF0ZScpLmZvckVhY2goKGMpID0+IGMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gKGl0ZW1zW2MuZGF0YXNldC5pXS5kYXRlID0gYy52YWx1ZSkpKTsKICAgIHRhcmdldC5xdWVyeVNlbGVjdG9yQWxsKCcucC1jYXQnKS5mb3JFYWNoKChjKSA9PiBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsKICAgICAgY29uc3QgaXQgPSBpdGVtc1tjLmRhdGFzZXQuaV07CiAgICAgIGl0LmNhdGVnb3J5SWQgPSBjLnZhbHVlIHx8IG51bGw7CiAgICAgIGl0Lm1ldGhvZCA9IGMudmFsdWUgPyAnbWFudWFsJyA6IG51bGw7CiAgICB9KSk7CiAgICBjb25zdCBhZGRCdG4gPSAkKCcjcC1hZGQnKTsKICAgIGlmIChhZGRCdG4pIGFkZEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFkZFByZXZpZXdJdGVtcykpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gYWRkUHJldmlld0l0ZW1zKCkgewogICAgY29uc3QgY2hvc2VuID0gcHJldmlldy5pdGVtcy5maWx0ZXIoKHgpID0+IHguY2hlY2tlZCAmJiB4LmRhdGUpOwogICAgaWYgKCFjaG9zZW4ubGVuZ3RoKSByZXR1cm4gdG9hc3QoJ+y2lOqwgO2VoCDrgrTsl63snYQg7ISg7YOd7ZW0IOyjvOyEuOyalC4nKTsKICAgIGxldCBjaGFuZ2VkTWV0YSA9IGZhbHNlOwogICAgZm9yIChjb25zdCBpdCBvZiBjaG9zZW4pIHsKICAgICAgaWYgKGl0Lm1ldGhvZCA9PT0gJ21hbnVhbCcgJiYgaXQuY2F0ZWdvcnlJZCkgewogICAgICAgIFMoKS5tZXJjaGFudE1hcFtMLm5vcm1hbGl6ZU1lcmNoYW50KGl0Lm1lbW8pXSA9IGl0LmNhdGVnb3J5SWQ7CiAgICAgICAgY2hhbmdlZE1ldGEgPSB0cnVlOwogICAgICB9CiAgICB9CiAgICAvLyDtjIzsnbzsnZgg66eI7KeA66eJIOyelOyVoeydtCDsp4DquIgg7JWM6rOgIOyeiOuKlCDsnpTslaHrs7Tri6Qg7LWc6re87J2066m0IOqzhOyijCDsnpTslaHsnYQg67CU6r6864ukCiAgICBjb25zdCBhY2MgPSBwcmV2aWV3LmFjY291bnRJZCAmJiBTKCkuYWNjb3VudHMuZmluZCgoYSkgPT4gYS5pZCA9PT0gcHJldmlldy5hY2NvdW50SWQpOwogICAgaWYgKGFjYyAmJiBwcmV2aWV3LmxhdGVzdCkgewogICAgICBjb25zdCBhdCA9IG5ldyBEYXRlKGAke3ByZXZpZXcubGF0ZXN0LmRhdGV9VCR7cHJldmlldy5sYXRlc3QudGltZSB8fCAnMjM6NTk6NTknfSswOTowMGApLnRvSVNPU3RyaW5nKCk7CiAgICAgIGlmICghYWNjLmJhbGFuY2VBdCB8fCBhdCA+IGFjYy5iYWxhbmNlQXQpIHsKICAgICAgICBhY2MuYmFsYW5jZSA9IHByZXZpZXcubGF0ZXN0LmJhbGFuY2U7CiAgICAgICAgYWNjLmJhbGFuY2VBdCA9IGF0OwogICAgICAgIGNoYW5nZWRNZXRhID0gdHJ1ZTsKICAgICAgfQogICAgfQogICAgaWYgKGNoYW5nZWRNZXRhKSBzdG9yZS5zYXZlTWV0YSgpOwogICAgY29uc3Qgc291cmNlID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyA/ICdmaWxlJyA6ICdwYXN0ZSc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNob3Nlbi5sZW5ndGg7IGkgKz0gMjAwKSB7CiAgICAgIGNvbnN0IHBhcnQgPSBjaG9zZW4uc2xpY2UoaSwgaSArIDIwMCk7CiAgICAgIGF3YWl0IGJ1c3koYOyggOyepe2VmOuKlCDspJHigKYgKCR7TWF0aC5taW4oaSArIDIwMCwgY2hvc2VuLmxlbmd0aCl9LyR7Y2hvc2VuLmxlbmd0aH0pYCwgKCkgPT4KICAgICAgICBzdG9yZS5hZGRUcmFuc2FjdGlvbnMocGFydC5tYXAoKGl0KSA9PiAoewogICAgICAgICAgZGF0ZTogaXQuZGF0ZSwgYW1vdW50OiBpdC5hbW91bnQsIG1lbW86IGl0Lm1lbW8sIGtpbmQ6IGl0LmtpbmQgfHwgJ2V4cGVuc2UnLCBhY2NvdW50SWQ6IGl0LmFjY291bnRJZCB8fCBudWxsLAogICAgICAgICAgY2F0ZWdvcnlJZDogaXQua2luZCA9PT0gJ2V4cGVuc2UnID8gaXQuY2F0ZWdvcnlJZCA6IG51bGwsIG1ldGhvZDogaXQubWV0aG9kLCBzb3VyY2UsIHJhdzogaXQucmF3LAogICAgICAgIH0pKSkKICAgICAgKTsKICAgIH0KICAgIGNvbnN0IGxhdGVzdERhdGUgPSBjaG9zZW4ubWFwKCh4KSA9PiB4LmRhdGUpLnNvcnQoKS5wb3AoKTsKICAgIGlmIChwcmV2aWV3LnNvdXJjZSA9PT0gJ3Bhc3RlJykgJCgnI3Bhc3RlLWlucHV0JykudmFsdWUgPSAnJzsKICAgIGVsc2UgJCgnI2ZpbGUtaW5wdXQnKS52YWx1ZSA9ICcnOwogICAgY2xlYXJQcmV2aWV3KCk7CiAgICB0b2FzdChgJHtjaG9zZW4ubGVuZ3RofeqxtOydhCDstpTqsIDtlojsirXri4jri6QuYCk7CiAgICBqdW1wVG9EYXRlKGxhdGVzdERhdGUpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDshKTsoJUgLS0tLS0tLS0tLQoKICAvLyDslYzrprwg7Jew6rKwIOyVsSjslYjrk5zroZzsnbTrk5wpIOuCtOugpOuwm+q4sCDso7zshowgKEdpdEh1YiBBY3Rpb25zIOqwgCBtYWluIOyXkCDsmKzrnbzqsIgg65WM66eI64ukIOqwseyLoCkKICBjb25zdCBOT1RJX0FQS19VUkwgPSAnaHR0cHM6Ly9naXRodWIuY29tL2tkaDEyMDctc3Rhci9DbGF1ZGVDb2RlMS9yZWxlYXNlcy9kb3dubG9hZC9ub3RpLWFwcC9idWRnZXQtbm90aS5hcGsnOwoKICAvLyDshKTsuZjrkJwg7JWM66a8IOyXsOqysCDslbHsnYQg7Je066m07IScIOyEnOuyhCDso7zshozrpbwg64SY6ri064ukICjtgazroawg7JWI65Oc66Gc7J2065Oc7J2YIGludGVudCDrp4HtgawpCiAgZnVuY3Rpb24gY29ubmVjdExpbmsoKSB7CiAgICBjb25zdCB1cmwgPSBlbmNvZGVVUklDb21wb25lbnQobm90aWZ5VXJsKCdiYW5rJykpOwogICAgcmV0dXJuIGBpbnRlbnQ6Ly9zZXR1cD91cmw9JHt1cmx9I0ludGVudDtzY2hlbWU9YnVkZ2V0bm90aTtwYWNrYWdlPWNvbS5rZGgxMjA3LmJ1ZGdldG5vdGk7Uy5icm93c2VyX2ZhbGxiYWNrX3VybD0ke2VuY29kZVVSSUNvbXBvbmVudChOT1RJX0FQS19VUkwpfTtlbmRgOwogIH0KCiAgZnVuY3Rpb24gbm90aWZ5VXJsKHNvdXJjZSkgewogICAgcmV0dXJuIHN0b3JlLnNlcnZpY2VVcmwgPyBgJHtzdG9yZS5zZXJ2aWNlVXJsfT9hY3Rpb249c21zJmtleT0ke2VuY29kZVVSSUNvbXBvbmVudChzdG9yZS5zZXJ2ZXIua2V5KX0ke3NvdXJjZSA/IGAmc291cmNlPSR7c291cmNlfWAgOiAnJ31gIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJTZXR0aW5ncygpIHsKICAgIGNvbnN0IHNkID0gJCgnI3N0YXJ0LWRheScpOwogICAgaWYgKCFzZC5vcHRpb25zLmxlbmd0aCkgc2QuaW5uZXJIVE1MID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogMzEgfSwgKF8sIGkpID0+IGA8b3B0aW9uIHZhbHVlPSIke2kgKyAxfSI+66ek7JuUICR7aSArIDF97J28PC9vcHRpb24+YCkuam9pbignJyk7CiAgICBzZC52YWx1ZSA9IFN0cmluZyhTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgJCgnI215LW5hbWUnKS52YWx1ZSA9IFMoKS5zZXR0aW5ncy5teU5hbWUgfHwgJyc7CiAgICByZW5kZXJBY2NvdW50Um93cygpOwogICAgcmVuZGVyQXV0b0NhcmQoKTsKICAgICQoJyNkYXRhLW5vdGUnKS50ZXh0Q29udGVudCA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnCiAgICAgID8gJ+uNsOydtO2EsOuKlCDqtazquIAg7Iuc7Yq47JeQIOyggOyepeuQqeuLiOuLpC4g67Cx7JeFIOu2iOufrOyYpOq4sOulvCDtlZjrqbQg67Cx7JeF7J2YIOqzhO2ajcK36rOE7KKM66W8IOyggeyaqe2VmOqzoCDrgrTsl63snYQg7Iuc7Yq47JeQIOy2lOqwgO2VqeuLiOuLpC4nCiAgICAgIDogJ+uqqOuToCDrjbDsnbTthLDripQg7J20IOu4jOudvOyasOyggOyXkOunjCDsoIDsnqXrkKnri4jri6QuIOuLpOuluCDquLDquLDroZwg7Jiu6riw6rGw64KYIOuwseyXhe2VmOugpOuptCDrgrTrs7TrgrTquLDrpbwg7IKs7Jqp7ZWY7IS47JqULic7CiAgICAkKCcjcmVzZXQtYnRuJykuaGlkZGVuID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZSc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJBY2NvdW50Um93cygpIHsKICAgIGNvbnN0IGVsID0gJCgnI2FjY291bnQtcm93cycpOwogICAgY29uc3QgYWNjb3VudHMgPSBTKCkuYWNjb3VudHM7CiAgICBlbC5pbm5lckhUTUwgPSBhY2NvdW50cy5sZW5ndGgKICAgICAgPyBhY2NvdW50cy5tYXAoKGEpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0LXJvdyIgZGF0YS1pZD0iJHtlc2MoYS5pZCl9Ij4KICAgICAgICAgIDxpbnB1dCBjbGFzcz0iYS1uYW1lIiB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJHtlc2MoYS5uYW1lKX0iIHBsYWNlaG9sZGVyPSIke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+yYiDog7Iug7ZWcIOyytO2BrOy5tOuTnCcgOiAn7JiIOiDqta3rr7wg7KO86rGw656YJ30iIGFyaWEtbGFiZWw9IuydtOumhCI+CiAgICAgICAgICA8c2VsZWN0IGNsYXNzPSJhLXR5cGUiIGFyaWEtbGFiZWw9IuyiheulmCI+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJhbmsiICR7YS50eXBlICE9PSAnY2FyZCcgPyAnc2VsZWN0ZWQnIDogJyd9PuydgO2WiSDqs4Tsoow8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iY2FyZCIgJHthLnR5cGUgPT09ICdjYXJkJyA/ICdzZWxlY3RlZCcgOiAnJ30+7Lm065OcPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDxpbnB1dCBjbGFzcz0iYS1sYXN0IiB0eXBlPSJ0ZXh0IiBpbnB1dG1vZGU9Im51bWVyaWMiIG1heGxlbmd0aD0iNCIgdmFsdWU9IiR7ZXNjKGEubGFzdDQpfSIgcGxhY2Vob2xkZXI9IuuBnSA07J6Q66asIiBhcmlhLWxhYmVsPSLrgZ0gNOyekOumrCI+CiAgICAgICAgICA8aW5wdXQgY2xhc3M9ImEtYmFsIiB0eXBlPSJ0ZXh0IiBpbnB1dG1vZGU9Im51bWVyaWMiIHZhbHVlPSIke3R5cGVvZiBhLmJhbGFuY2UgPT09ICdudW1iZXInID8gYS5iYWxhbmNlLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpIDogJyd9IiBwbGFjZWhvbGRlcj0iJHthLnR5cGUgPT09ICdjYXJkJyA/ICfigJQnIDogJ+2YhOyerCDsnpTslaEnfSIgJHthLnR5cGUgPT09ICdjYXJkJyA/ICdkaXNhYmxlZCcgOiAnJ30gYXJpYS1sYWJlbD0i7J6U7JWhIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0iY2hlY2siPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2xhc3M9ImEtc2F2ZSIgJHthLmlzU2F2aW5ncyA/ICdjaGVja2VkJyA6ICcnfSAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ2Rpc2FibGVkJyA6ICcnfT7soIDstpU8L2xhYmVsPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibGluay1idG4gYS1kZWwiIGFyaWEtbGFiZWw9IuyCreygnCI+4pyVPC9idXR0b24+CiAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuyVhOyngSDrk7HroZ3tlZwg6rOE7KKMwrfsubTrk5zqsIAg7JeG7Ja07JqULjwvZGl2Pic7CgogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnLmFjY3Qtcm93JykuZm9yRWFjaCgocm93KSA9PiB7CiAgICAgIGNvbnN0IGEgPSBTKCkuYWNjb3VudHMuZmluZCgoeCkgPT4geC5pZCA9PT0gcm93LmRhdGFzZXQuaWQpOwogICAgICBjb25zdCBzYXZlID0gKHJlcmVuZGVyKSA9PiB7CiAgICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgICBpZiAocmVyZW5kZXIpIHJlbmRlckFjY291bnRSb3dzKCk7CiAgICAgIH07CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1uYW1lJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLm5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCk7CiAgICAgICAgc2F2ZSgpOwogICAgICB9KTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLXR5cGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEudHlwZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIGlmIChhLnR5cGUgPT09ICdjYXJkJykgT2JqZWN0LmFzc2lnbihhLCB7IGJhbGFuY2U6IG51bGwsIGlzU2F2aW5nczogZmFsc2UgfSk7CiAgICAgICAgc2F2ZSh0cnVlKTsKICAgICAgfSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1sYXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLmxhc3Q0ID0gZS50YXJnZXQudmFsdWUucmVwbGFjZSgvXEQvZywgJycpLnNsaWNlKC00KTsKICAgICAgICBlLnRhcmdldC52YWx1ZSA9IGEubGFzdDQ7CiAgICAgICAgc2F2ZSgpOwogICAgICB9KTsKICAgICAgZm9ybWF0T25CbHVyKHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1iYWwnKSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1iYWwnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEuYmFsYW5jZSA9IHBhcnNlQW1vdW50SW5wdXQoZS50YXJnZXQudmFsdWUpOwogICAgICAgIGEuYmFsYW5jZUF0ID0gbm93SVNPKCk7CiAgICAgICAgc2F2ZSgpOwogICAgICB9KTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLXNhdmUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEuaXNTYXZpbmdzID0gZS50YXJnZXQuY2hlY2tlZDsKICAgICAgICBzYXZlKCk7CiAgICAgIH0pOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtZGVsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHthLm5hbWUgfHwgYS5sYXN0NH0nIOydhCjrpbwpIOyCreygnO2VoOq5jOyalD8g7J2066+4IOq4sOuhneuQnCDrgrTsl63snYAg6re464yA66GcIOuCqOyKteuLiOuLpC5gKSkgcmV0dXJuOwogICAgICAgIFMoKS5hY2NvdW50cyA9IFMoKS5hY2NvdW50cy5maWx0ZXIoKHgpID0+IHguaWQgIT09IGEuaWQpOwogICAgICAgIHNhdmUodHJ1ZSk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBhZGRBY2NvdW50KCkgewogICAgUygpLmFjY291bnRzLnB1c2goeyBpZDogYGEtJHt1aWQoKX1gLCBuYW1lOiAnJywgdHlwZTogJ2JhbmsnLCBsYXN0NDogJycsIGlzU2F2aW5nczogZmFsc2UsIGJhbGFuY2U6IG51bGwsIGJhbGFuY2VBdDogJycgfSk7CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgcmVuZGVyQWNjb3VudFJvd3MoKTsKICAgIGNvbnN0IG5hbWVzID0gJCQoJy5hY2N0LXJvdyAuYS1uYW1lJyk7CiAgICBuYW1lc1tuYW1lcy5sZW5ndGggLSAxXS5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQXV0b0NhcmQoKSB7CiAgICBjb25zdCBjYXJkID0gJCgnI3NldC1hdXRvJyk7CiAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIHsKICAgICAgY29uc3QgTU9ERUxfTEFCRUwgPSB7ICdjbGF1ZGUtb3B1cy01LTUnOiAnQ2xhdWRlIE9wdXMgNS41ICjquLDrs7gsIOqwgOyepSDsoJXtmZUpJywgJ2NsYXVkZS1oYWlrdS01LTUnOiAnQ2xhdWRlIEhhaWt1IDUuNSAo7LaU7LKcLCDslYTso7wg7KCA66C0KScsICdjbGF1ZGUtaGFpa3UtNC01JzogJ0NsYXVkZSBIYWlrdSA0LjUgKOyYiOyghCDrqqjrjbgpJyB9OwogICAgICBjYXJkLmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+7J6Q64+ZIOyeheugpTwvaDI+CiAgICAgICAgPGgzPkNsYXVkZSBBSSDrtoTrpZg8L2gzPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+JHtzdG9yZS5haUVuYWJsZWQgPyAnPGI+7Lyc7KC4IOyeiOyWtOyalC48L2I+IOyVjOumvOqzvCDrtpnsl6zrhKPsnYAg64K07Jet7J2EIEFJ6rCAIOyYiOyCsCDtla3rqqnsl5Ag66ee7LawIOu2hOulmO2VqeuLiOuLpC4nIDogJzxiPuq6vOyguCDsnojslrTsmpQuPC9iPiDsp4DquIjsnYAg7YKk7JuM65Oc66GcIOu2hOulmO2VqeuLiOuLpC4g7JWE656Y7JeQIENsYXVkZSBBUEkg7YKk66W8IOuEo+ycvOuptCDsvJzsoLjsmpQuIO2CpOuKlCBjb25zb2xlLmFudGhyb3BpYy5jb20g7JeQ7IScIOqysOygnCDsiJjri6jsnYQg65Ox66Gd7ZWcIOuSpCBBUEkgS2V5cyDrqZTribTsl5DshJwg66eM65OkIOyImCDsnojslrTsmpQuJ308L3A+CiAgICAgICAgPGZvcm0gaWQ9ImFpLWZvcm0iIGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ3aWRlIj5DbGF1ZGUgQVBJIO2CpDxpbnB1dCB0eXBlPSJwYXNzd29yZCIgaWQ9ImFpLWtleSIgYXV0b2NvbXBsZXRlPSJvZmYiIHBsYWNlaG9sZGVyPSIke3N0b3JlLmFpRW5hYmxlZCA/ICfsoIDsnqXrkKggKOuwlOq+uOugpOuptCDsg4gg7YKkIOyeheugpSknIDogJ3NrLWFudC3igKYnfSI+PC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tc3VibWl0Ij48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7tmZXsnbjtlZjqs6Ag7KCA7J6lPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9mb3JtPgogICAgICAgICR7c3RvcmUuYWlFbmFibGVkID8gYDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsIGNsYXNzPSJ3aWRlIj7sgqzsmqntlaAg66qo6424PHNlbGVjdCBpZD0iYWktbW9kZWwiPiR7KHN0b3JlLmFpTW9kZWxzLmxlbmd0aCA/IHN0b3JlLmFpTW9kZWxzIDogW3N0b3JlLmFpTW9kZWxdKS5tYXAoKG0pID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhtKX0iICR7bSA9PT0gc3RvcmUuYWlNb2RlbCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoTU9ERUxfTEFCRUxbbV0gfHwgbSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9sYWJlbD48L2Rpdj5gIDogJyd9CiAgICAgICAgJHtzdG9yZS5haUVycm9yID8gYDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+7LWc6re8IEFJIOyYpOulmDogJHtlc2Moc3RvcmUuYWlFcnJvcil9PC9wPmAgOiAnJ30KICAgICAgICA8aDM+7Lm07Lm07Jik67GF7YGsIOusuOyekCDsnpDrj5kg7J6F66ClIChNYWNyb0Ryb2lkIOustOujjCk8L2gzPgogICAgICAgIDxvbCBjbGFzcz0ic3RlcHMiPgogICAgICAgICAgPGxpPu2UjOugiOydtCDsiqTthqDslrTsl5DshJwgPGI+TWFjcm9Ecm9pZDwvYj4g7ISk7LmYIChQcm8gN+ydvCDssrTtl5gg7JWI64K064qUIOuLq+q4sCk8L2xpPgogICAgICAgICAgPGxpPuunpO2BrOuhnCDstpTqsIAg4oaSIO2KuOumrOqxsCA8Yj7soITtmZQvU01TIOKGkiBTTVMg7IiY7IugPC9iPiAo66qo65OgIOuyiO2YuCwg64K07Jqp7JeQIDxjb2RlPuyelOyVoTwvY29kZT4g7Y+s7ZWoKTwvbGk+CiAgICAgICAgICA8bGk+64+Z7J6RIDxiPuybuSDsoJHsho0g4oaSIEhUVFAg7JqU7LKtPC9iPjogUE9TVCwg7JWE656YIOyjvOyGjCwg67O466y4IHRleHQvcGxhaW4g7JeQIOunpOyngSDthY3siqTtirggPGNvZGU+W3Ntc19tZXNzYWdlXTwvY29kZT48L2xpPgogICAgICAgICAgPGxpPuyggOyepSDtm4Qg7Zy064yA7Y+wIOyEpOygleyXkOyEnCBNYWNyb0Ryb2lkIOuwsO2EsOumrCA8Yj7soJztlZwg7JeG7J2MPC9iPjwvbGk+CiAgICAgICAgPC9vbD4KICAgICAgICA8ZGl2IGNsYXNzPSJjb3B5LXJvdyI+PGlucHV0IHR5cGU9InRleHQiIHJlYWRvbmx5IHZhbHVlPSIke2VzYyhub3RpZnlVcmwoJ2JhbmsnKSl9IiBpZD0idXJsLWJhbmsiPjxidXR0b24gY2xhc3M9Imdob3N0LWJ0biIgZGF0YS1jb3B5PSJ1cmwtYmFuayI+67O17IKsPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7rrLjsnpDqsIAg7JmA64+EIOuwmOydkeydtCDsl4bsnLzrqbQg7Yq466as6rGw66W8IDxiPuyVjOumvCDsiJjsi6A8L2I+KOuplOyLnOyngCDslbEsIOuCtOyaqSA8Y29kZT7snpTslaE8L2NvZGU+KeycvOuhnCDrsJTqvrjqs6Ag67O466y47J2EIDxjb2RlPltub3RpZmljYXRpb25fdGl0bGVdIFtub3RpZmljYXRpb25dPC9jb2RlPiDroZwg7ZWY7IS47JqULiDqs4TsoozCt+y5tOuTnOyXkCDsubTsubTsmKTrsYXtgawg64GdIDTsnpDrpqzrpbwg65Ox66Gd7ZW0IOuRkOuptCDsnpTslaHrj4Qg6rCx7Iug64+87JqULiDsnpDshLjtlZwg67Cp67KV7J2AIFNFVFVQLm1kIDbri6jqs4Tsl5Ag7J6I7Ja07JqULjwvcD4KICAgICAgICA8ZGV0YWlscyBjbGFzcz0ic21hbGwiPgogICAgICAgICAgPHN1bW1hcnk+7KeB7KCRIOunjOuToCDslYzrprwg7Jew6rKwIOyVsSAo7ISg7YOdLCDrs7TslYgg7LCo64uo65CgIOyImCDsnojsnYwpPC9zdW1tYXJ5PgogICAgICAgICAgPHAgY2xhc3M9Im11dGVkIj7tlIzroIjsnbQg7Iqk7Yag7Ja0IOuwliDslbHsnbTrnbwg7IK87ISxIOuztOyViCDquLDriqXsnbQg7ISk7LmY66W8IOunieydhCDsiJgg7J6I7Ja07JqULiDrs7TslYgg7ISk7KCV7J2EIOuBhOuptOyEnOq5jOyngCDsk7DripQg6rKD7J2AIOq2jO2VmOyngCDslYrslYTsmpQuIDxhIGhyZWY9IiR7Tk9USV9BUEtfVVJMfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkFQSyDrsJvquLA8L2E+IMK3IDxhIGhyZWY9IiR7ZXNjKGNvbm5lY3RMaW5rKCkpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPuyEpOy5mO2VnCDslbHsl5Ag7Jew6rKwPC9hPjwvcD4KICAgICAgICA8L2RldGFpbHM+CiAgICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPgogICAgICAgICAgJHtzdG9yZS5zZXJ2ZXIuZW1iZWRkZWQgPyAnPGJ1dHRvbiBpZD0iZm9yZ2V0LWtleS1idG4iIGNsYXNzPSJnaG9zdC1idG4gc21hbGwtYnRuIj7snbQg6riw6riw7JeQ7IScIOygkeyGjSDtgqQg7KeA7Jqw6riwPC9idXR0b24+JyA6ICc8YnV0dG9uIGlkPSJkaXNjb25uZWN0LWJ0biIgY2xhc3M9ImRhbmdlci1idG4iPuyXsOqysCDtlbTsoJwgKOydtCDquLDquLAg7KCA7J6l7Jy866GcKTwvYnV0dG9uPid9CiAgICAgICAgPC9kaXY+YDsKICAgICAgJCgnI2FpLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCBxdWlldChhc3luYyAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBrZXkgPSAkKCcjYWkta2V5JykudmFsdWUudHJpbSgpOwogICAgICAgIGlmICgha2V5ICYmICFjb25maXJtKCdBUEkg7YKk66W8IOyngOyasOqzoCBBSSDrtoTrpZjrpbwg64GM6rmM7JqUPycpKSByZXR1cm47CiAgICAgICAgYXdhaXQgYnVzeSgnQVBJIO2CpOulvCDtmZXsnbjtlZjripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuc2V0QXBpS2V5KGtleSkpOwogICAgICAgIHRvYXN0KHN0b3JlLmFpRW5hYmxlZCA/ICdBSSDrtoTrpZjrpbwg7Lyw7Ja07JqULicgOiAnQUkg67aE66WY66W8IOq7kOyWtOyalC4nKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSkpOwogICAgICBjb25zdCBtb2RlbFNlbCA9ICQoJyNhaS1tb2RlbCcpOwogICAgICBpZiAobW9kZWxTZWwpIG1vZGVsU2VsLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgICBhd2FpdCBidXN5KG51bGwsICgpID0+IHN0b3JlLnNldE1vZGVsKG1vZGVsU2VsLnZhbHVlKSk7CiAgICAgICAgdG9hc3QoJ+uqqOuNuOydhCDrsJTqv6jslrTsmpQuJyk7CiAgICAgIH0pKTsKICAgICAgY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jb3B5XScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY29uc3QgaW5wdXQgPSAkKGAjJHtiLmRhdGFzZXQuY29weX1gKTsKICAgICAgICBjb3B5VGV4dChpbnB1dC52YWx1ZSwgaW5wdXQpOwogICAgICB9KSk7CiAgICAgIGNvbnN0IGZrID0gJCgnI2ZvcmdldC1rZXktYnRuJyk7CiAgICAgIGlmIChmaykgZmsuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgaWYgKCFjb25maXJtKCfsnbQg6riw6riw7JeQ7IScIOygkeyGjSDtgqTrpbwg7KeA7Jq46rmM7JqUPyDri6TsnYzsl5Ag7Je0IOuVjCDri6Tsi5wg7J6F66Cl7ZW07JW8IO2VtOyalC4nKSkgcmV0dXJuOwogICAgICAgIHN0b3JlLmZvcmdldEtleSgpOwogICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpOwogICAgICB9KTsKICAgICAgY29uc3QgZGMgPSAkKCcjZGlzY29ubmVjdC1idG4nKTsKICAgICAgaWYgKGRjKSBkYy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBpZiAoIWNvbmZpcm0oJ+yEnOuyhCDsl7DqsrDsnYQg7ZW07KCc7ZWg6rmM7JqUPyDqtazquIAg7Iuc7Yq47J2YIOuNsOydtO2EsOuKlCDqt7jrjIDroZwg64Ko7JWEIOyeiOyKteuLiOuLpC4nKSkgcmV0dXJuOwogICAgICAgIHN0b3JlLmRpc2Nvbm5lY3QoKTsKICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTsKICAgICAgfSk7CiAgICB9IGVsc2UgewogICAgICBjYXJkLmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+7J6Q64+ZIOyeheugpSAo6rWs6riAIOyLnO2KuCDshJzrsoQg7Jew6rKwKTwvaDI+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7subTrk5wg66y47J6QwrfsnYDtlokg7JWM66a8IOyekOuPmSDsnoXroKXqs7wgQUkg67aE66WY64qUIOq1rOq4gCDsi5ztirgg7ISc67KE6rCAIOyeiOyWtOyVvCDrj5nsnpHtlbTsmpQuIOyggOyepeyGjOydmCA8Yj5TRVRVUC5tZDwvYj4g64yA66GcIOq1rOq4gCBBcHBzIFNjcmlwdCDrpbwg67Cw7Y+s7ZWcIOuSpCwg7Ju57JWxIOyjvOyGjOyZgCDsoJHsho0g7YKk66W8IOuEo+ycvOyEuOyalC4g7Ju57JWxIOyjvOyGjOuhnCDrsJTroZwg7KCR7IaN7ZW07IScIOyNqOuPhCDrkKnri4jri6QuPC9wPgogICAgICAgIDxmb3JtIGlkPSJjb25uZWN0LWZvcm0iIGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ3aWRlIj7sm7nslbEg7KO87IaMPGlucHV0IHR5cGU9InVybCIgaWQ9ImMtdXJsIiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3Mvcy/igKYvZXhlYyIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD7soJHsho0g7YKkPGlucHV0IHR5cGU9InRleHQiIGlkPSJjLWtleSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tc3VibWl0Ij48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7sl7DqsrA8L2J1dHRvbj48L2Rpdj4KICAgICAgICA8L2Zvcm0+YDsKICAgICAgJCgnI2Nvbm5lY3QtZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIHF1aWV0KGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IHVybCA9ICQoJyNjLXVybCcpLnZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cPy4qJC8sICcnKTsKICAgICAgICBjb25zdCBrZXkgPSAkKCcjYy1rZXknKS52YWx1ZS50cmltKCk7CiAgICAgICAgYXdhaXQgYnVzeSgn7Jew6rKwIO2ZleyduCDspJHigKYnLCAoKSA9PiBzdG9yZS5waW5nKHVybCwga2V5KSk7CiAgICAgICAgY29uc3QgbWlncmF0ZSA9IFMoKS50cmFuc2FjdGlvbnMubGVuZ3RoID4gMCAmJiBjb25maXJtKCfsnbQg6riw6riw7JeQIOyeiOuNmCDqs4Ttmo3qs7wg64K07Jet7J2EIOq1rOq4gCDsi5ztirjroZwg7Jiu6ri46rmM7JqUPycpOwogICAgICAgIHN0b3JlLmNvbm5lY3QodXJsLCBrZXksIG1pZ3JhdGUpOwogICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpOwogICAgICB9KSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjaGFuZ2VTdGFydERheShuZXdEYXkpIHsKICAgIEwucmVtYXBQZXJpb2RLZXlzKFMoKSwgbmV3RGF5KTsKICAgIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIG5ld0RheSk7CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgcmVuZGVyQ2hyb21lKCk7CiAgICB0b2FzdChg7J207KCcIOunpOyblCAke25ld0RheX3snbzsl5Ag7IOIIOq4sOqwhOydtCDsi5zsnpHrkKnri4jri6QuYCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuwseyXhSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIGV4cG9ydERhdGEoKSB7CiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW0pTT04uc3RyaW5naWZ5KFMoKSwgbnVsbCwgMildLCB7IHR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyB9KTsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgYS5kb3dubG9hZCA9IGDsp4DstpzqtIDrpqwt67Cx7JeFLSR7TC50b2RheUlTTygpfS5qc29uYDsKICAgIGEuY2xpY2soKTsKICAgIHNldFRpbWVvdXQoKCkgPT4gVVJMLnJldm9rZU9iamVjdFVSTChhLmhyZWYpLCAxMDAwKTsKICB9CgogIGZ1bmN0aW9uIGltcG9ydERhdGEoZmlsZSkgewogICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTsKICAgIHJlYWRlci5vbmxvYWQgPSBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgIGxldCBwYXJzZWQ7CiAgICAgIHRyeSB7CiAgICAgICAgcGFyc2VkID0gTC5ub3JtYWxpemVTdGF0ZShKU09OLnBhcnNlKHJlYWRlci5yZXN1bHQpKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIHJldHVybiB0b2FzdCgn7Jis67CU66W4IOuwseyXhSDtjIzsnbzsnbQg7JWE64uZ64uI64ukLicpOwogICAgICB9CiAgICAgIGNvbnN0IG1zZyA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnID8gJ+uwseyXheydmCDqs4Ttmo3Ct+qzhOyijOulvCDsoIHsmqntlZjqs6Ag64K07Jet7J2EIOq1rOq4gCDsi5ztirjsl5Ag7LaU6rCA7ZWg6rmM7JqUPycgOiAn7ZiE7J6sIOuNsOydtO2EsOulvCDrsLHsl4Ug7YyM7J287J2YIOuCtOyaqeycvOuhnCDrsJTqv4DquYzsmpQ/JzsKICAgICAgaWYgKCFjb25maXJtKG1zZykpIHJldHVybjsKICAgICAgYXdhaXQgYnVzeSgn67aI65+s7Jik64qUIOykkeKApicsICgpID0+IHN0b3JlLmltcG9ydFN0YXRlKHBhcnNlZCkpOwogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICB0b2FzdCgn67Cx7JeF7J2EIOu2iOufrOyZlOyKteuLiOuLpC4nKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KTsKICAgIHJlYWRlci5yZWFkQXNUZXh0KGZpbGUpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDroIzrjZQgJiDsnbTrsqTtirggLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXIoKSB7CiAgICByZW5kZXJDaHJvbWUoKTsKICAgIGNvbnN0IHBhZ2UgPSBjdXJyZW50UGFnZTsKICAgIGlmIChwYWdlID09PSAnaG9tZScpIHJlbmRlckhvbWUoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdjYWxlbmRhcicpIHJlbmRlckNhbGVuZGFyKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnbGlzdCcpIHJlbmRlckxpc3QoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdzb3J0JykgcmVuZGVyU29ydCgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ3JlcG9ydCcpIHJlbmRlclJlcG9ydCgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ2Fzc2V0cycpIHJlbmRlckFzc2V0cygpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ3BsYW4nKSByZW5kZXJQbGFuKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnYWRkJykgcmVuZGVyQWRkKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnc2V0dGluZ3MnKSByZW5kZXJTZXR0aW5ncygpOwogIH0KCiAgZnVuY3Rpb24gYmluZEV2ZW50cygpIHsKICAgICQkKCcubmF2LWl0ZW1bZGF0YS1wYWdlXSwgLmJvdHRvbS1uYXYgW2RhdGEtcGFnZV0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoYi5kYXRhc2V0LnBhZ2UpKSk7CiAgICAkJCgnW2RhdGEtZ290b10nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoYi5kYXRhc2V0LmdvdG8pKSk7CiAgICAkJCgnW2RhdGEtb3Blbi1tZW51XScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuTWVudSkpOwogICAgJCgnI21lbnUtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuTWVudSk7CiAgICAkKCcjc2NyaW0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGNsb3NlTWVudSk7CiAgICAkKCcjYWRkLWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoJ2FkZCcpKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdoYXNoY2hhbmdlJywgKCkgPT4gewogICAgICBjb25zdCBuYW1lID0gbG9jYXRpb24uaGFzaC5zbGljZSgxKTsKICAgICAgaWYgKFBBR0VTW25hbWVdICYmIG5hbWUgIT09IGN1cnJlbnRQYWdlKSBzaG93UGFnZShuYW1lLCB7IHB1c2g6IGZhbHNlIH0pOwogICAgfSk7CiAgICAkJCgnLnNldHRpbmdzLW5hdiBhJykuZm9yRWFjaCgoYSkgPT4gYS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChlKSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgJChhLmdldEF0dHJpYnV0ZSgnaHJlZicpKS5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiAnc21vb3RoJywgYmxvY2s6ICdzdGFydCcgfSk7CiAgICB9KSk7CgogICAgY29uc3QgbW92ZSA9IChkZWx0YSkgPT4gewogICAgICBjdXJyZW50UGVyaW9kID0gTC5zaGlmdFBlcmlvZChjdXJyZW50UGVyaW9kLCBkZWx0YSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgJCgnI2luY29tZS1ib3gnKS5kYXRhc2V0LmVkaXRpbmcgPSAnJzsKICAgICAgcmVuZGVyKCk7CiAgICB9OwogICAgJCgnI3ByZXYtcGVyaW9kJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBtb3ZlKC0xKSk7CiAgICAkKCcjbmV4dC1wZXJpb2QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG1vdmUoMSkpOwogICAgJCgnI3RvZGF5LXBlcmlvZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICBzZWxlY3RlZERhdGUgPSBudWxsOwogICAgICByZW5kZXIoKTsKICAgIH0pOwogICAgJCgnI3JlZnJlc2gtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgIGF3YWl0IGJ1c3koJ+u2iOufrOyYpOuKlCDspJHigKYnLCAoKSA9PiBzdG9yZS5yZWZyZXNoKCkpOwogICAgICByZW5kZXIoKTsKICAgIH0pKTsKCiAgICAvLyDsnoXroKUKICAgICQkKCcjbS1raW5kIGJ1dHRvbicpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIG1hbnVhbEtpbmQgPSBiLmRhdGFzZXQua2luZDsKICAgICAgcmVuZGVyQWRkKCk7CiAgICB9KSk7CiAgICAkKCcjbWFudWFsLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCBxdWlldChvbk1hbnVhbFN1Ym1pdCkpOwogICAgZm9ybWF0T25CbHVyKCQoJyNtLWFtb3VudCcpKTsKICAgICQoJyNtLW1lbW8nKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHVwZGF0ZU1hbnVhbEhpbnQpOwogICAgJCgnI20tY2F0ZWdvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCB1cGRhdGVNYW51YWxIaW50KTsKICAgICQoJyNtLWRhdGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCByZW5kZXJBZGQpOwogICAgJCgnI3BhcnNlLWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQob25QYXJzZSkpOwogICAgJCgnI3Bhc3RlLWNsZWFyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICQoJyNwYXN0ZS1pbnB1dCcpLnZhbHVlID0gJyc7CiAgICAgIGNsZWFyUHJldmlldygpOwogICAgfSk7CiAgICAkKCcjZmlsZS1pbnB1dCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHF1aWV0KGFzeW5jIChlKSA9PiB7CiAgICAgIGlmIChlLnRhcmdldC5maWxlc1swXSkgYXdhaXQgb25GaWxlQ2hvc2VuKGUudGFyZ2V0LmZpbGVzWzBdKTsKICAgIH0pKTsKCiAgICAvLyDrgrTsl60KICAgIGNvbnN0IHNldEZpbHRlciA9IChrZXksIHZhbHVlKSA9PiB7CiAgICAgIGxpc3RTdGF0ZVtrZXldID0gdmFsdWU7CiAgICAgIHJlbmRlckxpc3QoKTsKICAgIH07CiAgICAkKCcjbGlzdC1zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChlKSA9PiBzZXRGaWx0ZXIoJ3NlYXJjaCcsIGUudGFyZ2V0LnZhbHVlKSk7CiAgICAkKCcjbGlzdC1raW5kJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHNldEZpbHRlcigna2luZCcsIGUudGFyZ2V0LnZhbHVlKSk7CiAgICAkKCcjbGlzdC1maWx0ZXInKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gc2V0RmlsdGVyKCdjYXRlZ29yeScsIGUudGFyZ2V0LnZhbHVlKSk7CiAgICAkKCcjbGlzdC1hY2NvdW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHNldEZpbHRlcignYWNjb3VudCcsIGUudGFyZ2V0LnZhbHVlKSk7CiAgICAkKCcjcmVjbGFzc2lmeS11bmNsYXNzaWZpZWQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KCgpID0+IHJ1blJlY2xhc3NpZnkodHJ1ZSkpKTsKICAgICQoJyNyZWNsYXNzaWZ5LWFsbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoKCkgPT4gcnVuUmVjbGFzc2lmeShmYWxzZSkpKTsKCiAgICAvLyDsmIjsgrAg6rOE7ZqNCiAgICAkKCcjcmF0aW8tYmFzZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgIGJ1ZGdldFBsYW4oKS5yYXRpb0Jhc2UgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgICAgcmVuZGVyUGxhblN1bW1hcnkoKTsKICAgIH0pOwogICAgJCgnI2ZpeGVkLW92ZXJmbG93JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgYnVkZ2V0UGxhbigpLmZpeGVkT3ZlcmZsb3cgPSBlLnRhcmdldC52YWx1ZSA9PT0gJ3NjYWxlJyA/ICdzY2FsZScgOiAnd2Fybic7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIHJlbmRlclBsYW5WZXJzaW9uKCk7CiAgICAgIHJlbmRlclBsYW5TdW1tYXJ5KCk7CiAgICB9KTsKICAgICQoJyNhZGQtY2F0ZWdvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFkZENhdGVnb3J5KTsKCiAgICAvLyDshKTsoJUKICAgICQoJyNzdGFydC1kYXknKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gY2hhbmdlU3RhcnREYXkoTnVtYmVyKGUudGFyZ2V0LnZhbHVlKSkpOwogICAgJCgnI215LW5hbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBTKCkuc2V0dGluZ3MubXlOYW1lID0gZS50YXJnZXQudmFsdWUudHJpbSgpOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgfSk7CiAgICAkKCcjYWRkLWFjY291bnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFkZEFjY291bnQpOwogICAgJCgnI2V4cG9ydC1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGV4cG9ydERhdGEpOwogICAgJCgnI2ltcG9ydC1maWxlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgaWYgKGUudGFyZ2V0LmZpbGVzWzBdKSBpbXBvcnREYXRhKGUudGFyZ2V0LmZpbGVzWzBdKTsKICAgICAgZS50YXJnZXQudmFsdWUgPSAnJzsKICAgIH0pOwogICAgJCgnI3Jlc2V0LWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBpZiAoIWNvbmZpcm0oJ+uqqOuToCDrgrTsl60sIOyImOyehSwg6rOE7ZqNLCDqs4Tsoozrpbwg7KeA7Jqw6rOgIOyymOydjCDsg4Htg5zroZwg65CY64+M66a06rmM7JqUPyAo65CY64+M66a0IOyImCDsl4bsirXri4jri6QpJykpIHJldHVybjsKICAgICAgc3RvcmUucmVzZXQoKTsKICAgICAgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgdG9hc3QoJ+y0iOq4sO2ZlO2WiOyKteuLiOuLpC4nKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KTsKCiAgICAvLyDslbHsnYQg65ag64KgIOuVjCDslYTsp4Eg67O064K07KeAIOyViuydgCDrs4Dqsr3snYQg7KCA7J6l7ZWY6rOgLCDrj4zslYTsmKTrqbQg7IOI66GcIOuTpOyWtOyYqCDslYzrprwg64K07Jet7J2EIOu2iOufrOyYqOuLpAogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgaWYgKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSA9PT0gJ2hpZGRlbicpIHJldHVybiBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnICYmICFidXN5Q291bnQgJiYgIXN0b3JlLmhhc1BlbmRpbmdNZXRhKCkpIHsKICAgICAgICBhd2FpdCBzdG9yZS5yZWZyZXNoKCk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0KICAgIH0pKTsKICB9CgogIC8vIOq1rOq4gCDsm7kg7JWx7Jy866GcIOyymOydjCDsl7Tsl4jsnYQg65WMOiDsoJHsho0g7YKk66W8IO2VnCDrsogg7J6F66Cl67Cb7JWEIOydtCDquLDquLDsl5Ag6riw7Ja17ZWc64ukCiAgZnVuY3Rpb24gYXNrS2V5KCkgewogICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7CiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgICBib3guY2xhc3NOYW1lID0gJ2tleS1nYXRlJzsKICAgICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgICA8Zm9ybSBjbGFzcz0iY2FyZCBrZXktY2FyZCIgaWQ9ImtleS1mb3JtIj4KICAgICAgICAgIDxoMj7soJHsho0g7YKk66W8IOyeheugpe2VmOyEuOyalDwvaDI+CiAgICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuq1rOq4gCBBcHBzIFNjcmlwdCDtjrjsp5HquLDsl5DshJwgPGI+c2V0dXA8L2I+IOydhCDsi6TtlontlZjrqbQg7Iuk7ZaJIOq4sOuhneyXkCDrgpjsmKTripQg7YKk7JiI7JqULiAo7JWIIOuztOydtOuptCDimpkg7ZSE66Gc7KCd7Yq4IOyEpOyglSDihpIg7Iqk7YGs66a97Yq4IOyGjeyEseydmCA8Yj5BUFBfS0VZPC9iPikg7ZWcIOuyiCDsnoXroKXtlZjrqbQg7J20IOq4sOq4sOqwgCDquLDslrXtlbTsmpQuPC9wPgogICAgICAgICAgPGlucHV0IHR5cGU9InBhc3N3b3JkIiBpZD0ia2V5LWlucHV0IiBhdXRvY29tcGxldGU9ImN1cnJlbnQtcGFzc3dvcmQiIHBsYWNlaG9sZGVyPSLsoJHsho0g7YKkIiByZXF1aXJlZD4KICAgICAgICAgIDxkaXYgY2xhc3M9InJvdy1hY3Rpb25zIj48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7rk6TslrTqsIDquLA8L2J1dHRvbj48L2Rpdj4KICAgICAgICAgIDxwIGNsYXNzPSJzbWFsbCB3YXJuIiBpZD0ia2V5LWVycm9yIiBoaWRkZW4+PC9wPgogICAgICAgIDwvZm9ybT5gOwogICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGJveCk7CiAgICAgICQoJyNrZXktaW5wdXQnKS5mb2N1cygpOwogICAgICAkKCcja2V5LWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCBhc3luYyAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBlcnIgPSAkKCcja2V5LWVycm9yJyk7CiAgICAgICAgZXJyLmhpZGRlbiA9IHRydWU7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGF3YWl0IHN0b3JlLnVzZUtleSgkKCcja2V5LWlucHV0JykudmFsdWUudHJpbSgpKTsKICAgICAgICAgIGJveC5yZW1vdmUoKTsKICAgICAgICAgIHJlc29sdmUoKTsKICAgICAgICB9IGNhdGNoIChleCkgewogICAgICAgICAgZXJyLnRleHRDb250ZW50ID0gL3VuYXV0aG9yaXplZC8udGVzdChleC5tZXNzYWdlKSA/ICftgqTqsIAg66ee7KeAIOyViuyVhOyalC4g64uk7IucIO2ZleyduO2VtCDso7zshLjsmpQuJyA6IGDtmZXsnbjtlZjsp4Ag66q77ZaI7Ja07JqUOiAke2V4Lm1lc3NhZ2V9YDsKICAgICAgICAgIGVyci5oaWRkZW4gPSBmYWxzZTsKICAgICAgICB9CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzdGFydCgpIHsKICAgIHdpbmRvdy5fX2J1ZGdldFN0YXJ0ZWQgPSB0cnVlOwogICAgYmluZEV2ZW50cygpOwogICAgaWYgKHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnICYmICFzdG9yZS5zZXJ2ZXIua2V5KSBhd2FpdCBhc2tLZXkoKTsKICAgIGNvbnN0IHRvTWlncmF0ZSA9IHN0b3JlLnRha2VNaWdyYXRpb24oKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGJ1c3koc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgPyAn67aI65+s7Jik64qUIOykkeKApicgOiBudWxsLCAoKSA9PiBzdG9yZS5pbml0KCkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICAkKCcjY2F0ZWdvcnktcm93cycpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJlbXB0eSI+7ISc67KE7JeQIOyXsOqysO2VmOyngCDrqrvtlojsirXri4jri6QuICgke2VzYyhlLm1lc3NhZ2UgfHwgZSl9KTxicj7shKTsoJUg4oaSIOyekOuPmSDsnoXroKXsl5DshJwg7KO87IaM7JmAIO2CpOulvCDtmZXsnbjtlZjshLjsmpQuPC9kaXY+YDsKICAgIH0KICAgIGlmICh0b01pZ3JhdGUpIHsKICAgICAgYXdhaXQgYnVzeSgn7J20IOq4sOq4sCDrjbDsnbTthLDrpbwg7Jiu6riw64qUIOykkeKApicsICgpID0+IHN0b3JlLmltcG9ydFN0YXRlKHRvTWlncmF0ZSkpLmNhdGNoKCgpID0+IHt9KTsKICAgICAgdG9hc3QoJ+ydtCDquLDquLAg642w7J207YSw66W8IOq1rOq4gCDsi5ztirjroZwg7Jiu6rK87Iq164uI64ukLicpOwogICAgfQogICAgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgIHNob3dQYWdlKGxvY2F0aW9uLmhhc2guc2xpY2UoMSkgfHwgJ2hvbWUnLCB7IHB1c2g6IGZhbHNlIH0pOwogIH0KCiAgc3RhcnQoKTsKfSkoKTsK\");</script>\n</body>\n</html>\n";
