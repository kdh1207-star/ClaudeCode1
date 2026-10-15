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

var INDEX_HTML = "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <title>내 지출 관리</title>\n  <style>\n:root {\n  color-scheme: light;\n  --page: #f4f4f1;\n  --surface: #fcfcfb;\n  --surface-2: #f0efec;\n  --surface-3: #e7e6e1;\n  --text: #0b0b0b;\n  --text-2: #52514e;\n  --muted: #6f6d68;\n  --border: rgba(11, 11, 11, 0.09);\n  --accent: #2a78d6;\n  --accent-track: #cde2fb;\n  --accent-soft: #e6f0fc;\n  --accent-text: #1c5cab;\n  --good: #0ca30c;\n  --good-text: #006300;\n  --warning: #fab219;\n  --warning-track: #fde8b8;\n  --critical: #d03b3b;\n  --critical-track: #f6d0d0;\n  --critical-text: #b42f2f;\n  --gray-mark: #b8b6ae;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7;\n  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04);\n  --sidebar-w: 232px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n    color-scheme: dark;\n    --page: #0d0d0d;\n    --surface: #1a1a19;\n    --surface-2: #232321;\n    --surface-3: #2e2e2b;\n    --text: #ffffff;\n    --text-2: #c3c2b7;\n    --muted: #9a988f;\n    --border: rgba(255, 255, 255, 0.09);\n    --accent: #3987e5;\n    --accent-track: #1c3558;\n    --accent-soft: #16263b;\n    --accent-text: #86b6ef;\n    --good-text: #0ca30c;\n    --warning-track: #4a3a12;\n    --critical-track: #4a1f1f;\n    --critical-text: #ec7070;\n    --gray-mark: #5c5b56;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n    --shadow: none;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --page: #0d0d0d;\n  --surface: #1a1a19;\n  --surface-2: #232321;\n  --surface-3: #2e2e2b;\n  --text: #ffffff;\n  --text-2: #c3c2b7;\n  --muted: #9a988f;\n  --border: rgba(255, 255, 255, 0.09);\n  --accent: #3987e5;\n  --accent-track: #1c3558;\n  --accent-soft: #16263b;\n  --accent-text: #86b6ef;\n  --good-text: #0ca30c;\n  --warning-track: #4a3a12;\n  --critical-track: #4a1f1f;\n  --critical-text: #ec7070;\n  --gray-mark: #5c5b56;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n  --shadow: none;\n}\n\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nbody {\n  margin: 0;\n  background: var(--page);\n  color: var(--text);\n  font-family: system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif;\n  font-size: 15px;\n  line-height: 1.5;\n}\n\nh1 { font-size: 20px; margin: 0; }\nh2 { font-size: 16px; margin: 0 0 8px; }\nh3 { font-size: 14px; margin: 16px 0 4px; }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.num { font-variant-numeric: tabular-nums; }\nsvg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n\n/* ---------- 레이아웃 ---------- */\n.app { min-height: 100vh; }\n.sidebar {\n  position: fixed;\n  inset: 0 auto 0 0;\n  width: var(--sidebar-w);\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  display: flex;\n  flex-direction: column;\n  padding: 20px 12px;\n  z-index: 30;\n}\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 0 8px 20px; }\n.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 16px; }\n.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }\n.nav-item {\n  display: flex; align-items: center; gap: 12px;\n  border: 0; background: none; color: var(--text-2);\n  font: inherit; text-align: left; padding: 10px 12px; border-radius: 10px; cursor: pointer;\n}\n.nav-item:hover { background: var(--surface-2); }\n.nav-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }\n.nav-sep { height: 1px; background: var(--border); margin: 8px 12px; }\n.sidebar-foot { padding: 12px 8px 0; }\n\n.main { margin-left: var(--sidebar-w); min-width: 0; }\n.topbar {\n  position: sticky; top: 0; z-index: 20;\n  display: flex; align-items: center; gap: 12px;\n  padding: 14px 28px;\n  background: color-mix(in srgb, var(--page) 88%, transparent);\n  backdrop-filter: blur(8px);\n}\n.topbar h1 { flex: 1; }\n.topbar-actions { display: flex; gap: 8px; align-items: center; }\n.topbar .menu-btn { display: none; }\n.content { max-width: 1040px; padding: 4px 28px 40px; }\n.page { display: none; }\n.page.active { display: block; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }\n.grid-2 > .card { margin-bottom: 16px; }\n\n.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 25; }\n.bottom-nav { display: none; }\n\n@media (max-width: 900px) {\n  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }\n  .sidebar.open { transform: none; }\n  .main { margin-left: 0; }\n  .topbar .menu-btn { display: inline-flex; }\n  .topbar { padding: 10px 16px; }\n  .content { padding: 4px 16px 96px; }\n  .grid-2 { grid-template-columns: 1fr; gap: 0; }\n  .topbar .add-btn { display: none; }\n  .bottom-nav {\n    display: grid; grid-template-columns: repeat(5, 1fr);\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n    background: var(--surface); border-top: 1px solid var(--border);\n    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));\n  }\n  .bottom-nav button {\n    display: flex; flex-direction: column; align-items: center; gap: 2px;\n    border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;\n  }\n  .bottom-nav button.active { color: var(--accent-text); font-weight: 600; }\n  .bottom-nav .bn-add svg { width: 26px; height: 26px; color: #fff; background: var(--accent); border-radius: 50%; padding: 4px; stroke-width: 2.4; }\n}\n\n/* ---------- 공통 요소 ---------- */\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 18px 20px;\n  margin-bottom: 16px;\n  box-shadow: var(--shadow);\n}\n.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }\n.card-head h2 { margin: 0; }\n.note-card { background: var(--surface-2); box-shadow: none; }\n.note-card p { margin: 4px 0 8px; }\n.warn-card { background: var(--warning-track); border-color: transparent; }\n.card .sub-head { margin-top: 18px; }\n\nbutton, input, select, textarea { font: inherit; color: inherit; }\ninput, select, textarea {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  padding: 9px 11px;\n  min-width: 0;\n}\ninput:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }\ntextarea { width: 100%; resize: vertical; }\nselect.full { width: 100%; }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn {\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  border: 1px solid var(--border); background: var(--surface); white-space: nowrap;\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n.ghost-btn:hover, .icon-btn:hover { background: var(--surface-2); }\n.danger-btn { color: var(--critical-text); }\n.icon-btn { padding: 7px; }\n.small-btn { padding: 6px 11px; font-size: 13px; }\n.link { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }\n.link-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }\n.link-btn:hover { color: var(--critical-text); }\n.file-btn { display: inline-flex; }\n.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }\n.chip { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; display: inline-block; }\n.chip.on { background: var(--accent-soft); color: var(--accent-text); }\n.tag { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }\n.tag.warn { background: var(--warning-track); color: var(--text); }\n.empty { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }\n\n.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }\n.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }\n.form-grid .wide { grid-column: span 2; }\n.form-submit { display: flex; align-items: end; }\n@media (max-width: 520px) { .form-grid .wide { grid-column: 1 / -1; } }\n\n.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; margin: 4px 0 14px; }\n.segmented button { border: 0; background: none; padding: 7px 14px; border-radius: 8px; cursor: pointer; color: var(--text-2); }\n.segmented button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }\n\n.busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -50% 0; } to { background-position: 150% 0; } }\n\n/* ---------- 기간 선택 ---------- */\n.period-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }\n.period-label { display: flex; flex-direction: column; min-width: 0; }\n.period-label strong { font-size: 16px; }\n.period-nav .icon-btn { width: 34px; height: 34px; font-size: 20px; line-height: 1; padding: 0; }\n.period-nav #today-period { margin-left: auto; }\n\n/* ---------- 홈 ---------- */\n.income-prompt { border-color: var(--accent); background: var(--accent-soft); }\n.income-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }\n.income-form input { flex: 1; min-width: 140px; }\n.income-set { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }\n.income-set .value { font-size: 18px; font-weight: 600; }\n\n.hero-card .label { color: var(--text-2); font-size: 14px; }\n.hero-card .figure { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin: 2px 0 4px; }\n.hero-card .figure.negative { color: var(--critical-text); }\n.hero-card .sub { color: var(--text-2); font-size: 14px; }\n.hero-card .meter { margin-top: 14px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 36px; } }\n\n.kv { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--border); gap: 12px; }\n.kv:first-child { border-top: 0; }\n.kv .k { color: var(--text-2); font-size: 14px; }\n.kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }\n.kv .v.plus { color: var(--accent-text); }\n\n/* 항목 행 (미터) */\n.cat-row { padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }\n.cat-row:first-child { border-top: 0; }\n.cat-row:hover .cat-name { text-decoration: underline; }\n.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.cat-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }\n.badge { font-size: 12px; font-weight: 400; color: var(--text-2); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }\n.cat-amounts { font-size: 14px; color: var(--text-2); }\n.cat-amounts b { color: var(--text); }\n.meter { position: relative; height: 10px; border-radius: 4px; background: var(--accent-track); margin: 8px 0 6px; overflow: hidden; }\n.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }\n.meter.warning { background: var(--warning-track); }\n.meter.warning .meter-fill { background: var(--warning); }\n.meter.critical { background: var(--critical-track); }\n.meter.critical .meter-fill { background: var(--critical); }\n.cat-bottom { display: flex; justify-content: space-between; font-size: 13px; gap: 8px; }\n.status { color: var(--text-2); }\n.status.warning { color: var(--text); }\n.status.critical { color: var(--critical-text); font-weight: 600; }\n.remain-good { color: var(--good-text); }\n.remain-bad { color: var(--critical-text); font-weight: 600; }\n.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }\n\n/* 거래 목록 (날짜별 묶음) */\n.tx-date { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 14px 0 4px; border-bottom: 1px solid var(--border); }\n.tx { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n.tx:last-child { border-bottom: 0; }\n.tx-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; }\n.tx-icon.gray { background: var(--gray-mark); }\n.tx-main { min-width: 0; }\n.tx-memo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tx-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }\n.tx-meta select { font-size: 12px; padding: 3px 6px; border-radius: 8px; max-width: 160px; }\n.tx-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n.tx-amount { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.tx-amount.plus { color: var(--accent-text); }\n.tx-amount.neutral { color: var(--muted); font-weight: 600; }\n.list-total { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin: 12px 0 4px; }\n.list-total b { color: var(--text); }\n.filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 8px; }\n@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }\n\n/* ---------- 달력 ---------- */\n.cal-summary { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin-bottom: 12px; }\n.cal-summary b { color: var(--text); font-size: 16px; }\n.cal-summary .plus b { color: var(--accent-text); }\n.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }\n.cal-dow { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }\n.cal-dow.sun { color: var(--critical-text); }\n.cal-day {\n  min-height: 74px; border-radius: 10px; padding: 6px; border: 1px solid transparent;\n  display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--surface-2); text-align: left;\n  font: inherit; color: inherit; min-width: 0;\n}\n.cal-day.out { background: none; cursor: default; opacity: 0.35; }\n.cal-day.today .cal-num { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 6px; }\n.cal-day.selected { border-color: var(--accent); }\n.cal-num { font-size: 12px; font-weight: 600; align-self: flex-start; }\n.cal-spent, .cal-income { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n.cal-spent { color: var(--text); }\n.cal-income { color: var(--accent-text); }\n.cal-day.h1 { background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }\n.cal-day.h2 { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }\n.cal-day.h3 { background: color-mix(in srgb, var(--accent) 36%, var(--surface-2)); }\n@media (max-width: 520px) { .cal-day { min-height: 56px; padding: 4px; } .cal-spent, .cal-income { font-size: 10px; } }\n\n/* ---------- 리포트 ---------- */\n.headline-figure { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0; }\n.delta { font-size: 14px; color: var(--text-2); }\n.delta b { color: var(--text); }\n.share-bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 14px; }\n.share-bar span { display: block; height: 100%; min-width: 2px; }\n.share-bar span:first-child { border-radius: 4px 0 0 4px; }\n.share-bar span:last-child { border-radius: 0 4px 4px 0; }\n.share-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.share-row:first-of-type { border-top: 0; }\n.share-name { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.share-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.share-amount { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.share-diff { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }\n.rank { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rank:first-of-type { border-top: 0; }\n.rank .n { color: var(--muted); font-weight: 700; text-align: center; }\n.rank .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rank .a { font-weight: 600; font-variant-numeric: tabular-nums; }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.chart svg { width: 100%; height: auto; display: block; overflow: visible; stroke: none; }\n.chart .grid-line { stroke: var(--border); stroke-width: 1; }\n.chart .axis-label { fill: var(--muted); font-size: 11px; }\n.chart .hit { fill: transparent; cursor: pointer; }\n.chart .hit:hover { fill: color-mix(in srgb, var(--text) 5%, transparent); }\n\n/* ---------- 자산 ---------- */\n.acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--border); }\n.acct:first-child { border-top: 0; }\n.acct-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }\n.acct-icon.is-card { background: var(--surface-2); color: var(--text-2); }\n.acct-name { font-weight: 600; }\n.acct-sub { font-size: 12px; color: var(--muted); }\n.acct-bal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }\n.acct-bal .acct-sub { font-weight: 400; }\n\n/* ---------- 예산 계획 ---------- */\n.plan-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 1.5fr 1.5fr auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.plan-row.head { border-top: 0; font-size: 13px; color: var(--text-2); padding-top: 0; }\n.plan-row input, .plan-row select { width: 100%; }\n.value-wrap { position: relative; }\n.value-wrap input { padding-right: 28px; text-align: right; }\n.value-wrap .unit { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13px; pointer-events: none; }\n.plan-row .preview { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-top: -4px; }\n@media (max-width: 1100px) {\n  .plan-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type value value\" \"desc desc desc\" \"kw kw kw\" \"pv pv pv\"; }\n  .plan-row.head { display: none; }\n  .plan-row .pl-name { grid-area: name; }\n  .plan-row .pl-type { grid-area: type; }\n  .plan-row .value-wrap { grid-area: value; }\n  .plan-row .pl-desc { grid-area: desc; }\n  .plan-row .pl-kw { grid-area: kw; }\n  .plan-row .pl-del { grid-area: del; }\n  .plan-row .preview { grid-area: pv; margin-top: 0; }\n}\n.plan-summary { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--surface-2); font-size: 14px; }\n.warn { color: var(--critical-text); font-weight: 600; }\n\n/* ---------- 설정 ---------- */\n.settings-grid { display: grid; grid-template-columns: 160px 1fr; gap: 20px; align-items: start; }\n.settings-nav { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 2px; }\n.settings-nav a { color: var(--text-2); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 14px; }\n.settings-nav a:hover { background: var(--surface-2); }\n.card[id^=\"set-\"] { scroll-margin-top: 72px; }\n@media (max-width: 900px) {\n  .settings-grid { grid-template-columns: 1fr; gap: 0; }\n  .settings-nav { position: static; flex-direction: row; overflow-x: auto; margin-bottom: 12px; gap: 6px; }\n  .settings-nav a { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }\n}\n.acct-row { display: grid; grid-template-columns: 1.4fr 0.9fr 0.8fr 1fr auto auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.acct-row input, .acct-row select { width: 100%; }\n.acct-row .check { display: flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }\n.acct-row .check input { width: auto; }\n@media (max-width: 700px) {\n  .acct-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type last last\" \"bal bal save\"; }\n  .acct-row .a-name { grid-area: name; }\n  .acct-row .a-type { grid-area: type; }\n  .acct-row .a-last { grid-area: last; }\n  .acct-row .a-bal { grid-area: bal; }\n  .acct-row .check { grid-area: save; }\n  .acct-row .link-btn { grid-area: del; }\n}\n.copy-row { display: flex; gap: 8px; margin: 6px 0 12px; }\n.copy-row input { flex: 1; font-size: 13px; }\n.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }\n.steps li { margin: 3px 0; }\n\n/* 표 (붙여넣기 미리보기) */\n.table-wrap { overflow-x: auto; margin-top: 12px; }\ntable { width: 100%; border-collapse: collapse; font-size: 14px; }\nth, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }\nth { font-weight: 600; color: var(--text-2); font-size: 13px; }\ntd.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntd select, td input { width: 100%; padding: 6px 8px; }\ntd.memo { min-width: 120px; word-break: break-all; }\n.refund { color: var(--good-text); }\n@media (max-width: 560px) {\n  .stack-table thead { display: none; }\n  .stack-table tbody tr { display: grid; gap: 6px 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n  .stack-table td { border: 0; padding: 0; min-width: 0; }\n  .parse-table tbody tr { grid-template-columns: auto 1fr 1fr auto; grid-template-areas: \"chk memo memo amt\" \". date cat cat\"; }\n  .parse-table td:nth-child(1) { grid-area: chk; }\n  .parse-table td:nth-child(2) { grid-area: date; }\n  .parse-table td:nth-child(3) { grid-area: memo; }\n  .parse-table td:nth-child(4) { grid-area: amt; }\n  .parse-table td:nth-child(5) { grid-area: cat; }\n}\n\n/* 툴팁 & 토스트 */\n.tooltip {\n  position: fixed; z-index: 50; pointer-events: none;\n  background: var(--surface); color: var(--text);\n  border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);\n  border-radius: 10px; padding: 8px 10px; font-size: 13px; max-width: 240px;\n}\n.tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }\n.tooltip .t-row span:first-child { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }\n.toast {\n  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);\n  background: var(--text); color: var(--page);\n  padding: 10px 16px; border-radius: 10px; z-index: 60; font-size: 14px; max-width: calc(100% - 32px);\n}\n@media (max-width: 900px) { .toast { bottom: calc(80px + env(safe-area-inset-bottom)); } }\n\n/* 처음 접속할 때 키 입력 */\n.key-gate { position: fixed; inset: 0; z-index: 70; background: var(--page); display: grid; place-items: center; padding: 16px; }\n.key-card { width: 100%; max-width: 420px; }\n.key-card input { width: 100%; margin-top: 8px; }\n\n.steps a.primary-btn { color: #fff; text-decoration: none; margin: 4px 0; }\n.steps a { color: var(--accent-text); }\ndetails summary { cursor: pointer; color: var(--text-2); margin-top: 8px; }\n\n/* 미분류 정리 */\n.nav-count { margin-left: auto; min-width: 22px; padding: 0 7px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; line-height: 20px; text-align: center; }\n.check-row { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; margin-top: 10px; cursor: pointer; }\n.check-row input { margin-top: 3px; }\n.sort-group { display: flex; flex-direction: column; gap: 10px; }\n.sort-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }\n.sort-memo { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }\n.sort-sum { font-variant-numeric: tabular-nums; white-space: nowrap; }\n.sort-dates { font-size: 13px; color: var(--text-2); }\n.sort-raw { font-size: 13px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }\n.pick-row { display: flex; flex-wrap: wrap; gap: 6px; }\n.pick-btn { border: 1px solid var(--border); background: var(--surface); color: inherit; font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }\n.pick-btn:hover { background: var(--surface-2); }\n.pick-btn .dot { width: 8px; height: 8px; border-radius: 50%; }\n.pick-btn.other { color: var(--text-2); border-style: dashed; }\n.sort-group details summary { font-size: 13px; color: var(--text-2); cursor: pointer; }\n.sort-others { margin-top: 12px; align-items: center; }\n.sort-others:empty { display: none; }\n</style>\n</head>\n<body>\n  <noscript>\n    <div style=\"padding:16px;margin:12px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif\">\n      이 화면에서는 앱의 기능(자바스크립트)이 실행되지 않아요. 파일 앱의 <b>미리보기</b>가 아니라 <b>크롬·삼성 인터넷·사파리</b> 같은 브라우저로 열어 주세요.\n    </div>\n  </noscript>\n  <div id=\"boot-error\" hidden style=\"position:fixed;left:12px;right:12px;top:12px;z-index:100;padding:16px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)\"></div>\n  <script>\n    // 앱이 시작되지 못하면 이유를 화면에 보여준다. (오래된 브라우저에서도 돌아가도록 옛 문법으로 작성)\n    (function () {\n      var shown = false;\n      function show(msg) {\n        if (shown) return;\n        shown = true;\n        var el = document.getElementById('boot-error');\n        el.innerHTML = '<b>앱을 시작하지 못했어요.</b><br>브라우저가 오래됐거나 미리보기 화면일 수 있어요. 최신 크롬·삼성 인터넷·사파리로 열어 보고, 그래도 안 되면 이 화면을 캡처해서 알려 주세요.' +\n          '<div style=\"margin-top:8px;font-size:12px;color:#52514e;word-break:break-all\">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent.replace(/</g, '&lt;') + '</div>';\n        el.hidden = false;\n        el.style.display = 'block';\n      }\n      window.addEventListener('error', function (e) {\n        if (window.__budgetStarted) return;\n        var where = window.__budgetCurrent || e.filename || '';\n        show((e.message || '알 수 없는 오류') + (where ? ' @ ' + where + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : ''));\n      });\n      // 구글 웹 앱용 빌드에서는 기능 코드를 base64 로 감싸 보낸다. 전달 과정에서 코드 글자가 바뀌어도 깨지지 않게 하려는 것.\n      window.__budgetRun = function (name, b64) {\n        window.__budgetCurrent = name;\n        try {\n          var bin = atob(b64);\n          var bytes = new Uint8Array(bin.length);\n          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n          var el = document.createElement('script');\n          el.text = new TextDecoder('utf-8').decode(bytes);\n          document.body.appendChild(el);\n        } catch (err) {\n          show(name + ': ' + (err && err.message));\n        }\n        window.__budgetCurrent = '';\n      };\n      window.addEventListener('load', function () {\n        setTimeout(function () {\n          if (!window.__budgetStarted) show('기능 코드가 실행되지 않았습니다.');\n        }, 3000);\n      });\n    })();\n  </script>\n  <div id=\"busy\" class=\"busy\" hidden></div>\n\n  <div class=\"app\">\n    <!-- 메뉴 -->\n    <aside class=\"sidebar\" id=\"sidebar\" aria-label=\"메뉴\">\n      <div class=\"brand\">\n        <span class=\"brand-mark\" aria-hidden=\"true\">₩</span>\n        <span>내 지출 관리</span>\n      </div>\n      <nav class=\"nav\" id=\"nav\">\n        <button class=\"nav-item\" data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n        <button class=\"nav-item\" data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n        <button class=\"nav-item\" data-page=\"list\"><svg viewBox=\"0 0 24 24\"><path d=\"M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01\"/></svg>내역</button>\n        <button class=\"nav-item\" data-page=\"sort\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 5h16l-6 7.5V19l-4 1.5v-8z\"/></svg>미분류 정리<span id=\"sort-count\" class=\"nav-count\" hidden></span></button>\n        <button class=\"nav-item\" data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n        <button class=\"nav-item\" data-page=\"assets\"><svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M16 14.5h2\"/></svg>자산</button>\n        <button class=\"nav-item\" data-page=\"plan\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/></svg>예산 계획</button>\n        <div class=\"nav-sep\"></div>\n        <button class=\"nav-item\" data-page=\"add\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>지출·수입 입력</button>\n        <button class=\"nav-item\" data-page=\"settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3\"/></svg>설정</button>\n      </nav>\n      <div class=\"sidebar-foot\">\n        <span id=\"conn-status\" class=\"chip\"></span>\n      </div>\n    </aside>\n    <div class=\"scrim\" id=\"scrim\" hidden></div>\n\n    <div class=\"main\">\n      <header class=\"topbar\">\n        <button id=\"menu-btn\" class=\"icon-btn menu-btn\" aria-label=\"메뉴 열기\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg></button>\n        <h1 id=\"page-title\">홈</h1>\n        <div class=\"topbar-actions\">\n          <button id=\"refresh-btn\" class=\"icon-btn\" aria-label=\"새로고침\" hidden><svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5\"/></svg></button>\n          <button id=\"add-btn\" class=\"primary-btn add-btn\">+ 입력</button>\n        </div>\n      </header>\n\n      <div class=\"content\">\n        <div class=\"period-nav\" id=\"period-nav\">\n          <button id=\"prev-period\" class=\"icon-btn\" aria-label=\"이전 기간\">‹</button>\n          <div class=\"period-label\">\n            <strong id=\"period-text\"></strong>\n            <span id=\"period-sub\" class=\"muted small\"></span>\n          </div>\n          <button id=\"next-period\" class=\"icon-btn\" aria-label=\"다음 기간\">›</button>\n          <button id=\"today-period\" class=\"ghost-btn small-btn\">오늘</button>\n        </div>\n\n        <!-- 홈 -->\n        <section class=\"page\" data-page=\"home\">\n          <div id=\"income-box\" class=\"card\"></div>\n          <div id=\"stale-box\"></div>\n          <div id=\"fixed-box\"></div>\n          <div class=\"grid-2\">\n            <div class=\"card hero-card\" id=\"hero\"></div>\n            <div class=\"card\" id=\"home-summary\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 예산</h2>\n              <span id=\"alloc-note\" class=\"muted small\"></span>\n            </div>\n            <div id=\"category-rows\"></div>\n          </div>\n          <div class=\"grid-2\">\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>최근 내역</h2><button class=\"link\" data-goto=\"list\">전체 보기</button></div>\n              <div id=\"recent-list\"></div>\n            </div>\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>자산</h2><button class=\"link\" data-goto=\"assets\">자세히</button></div>\n              <div id=\"home-assets\"></div>\n            </div>\n          </div>\n        </section>\n\n        <!-- 달력 -->\n        <section class=\"page\" data-page=\"calendar\">\n          <div class=\"card\">\n            <div id=\"cal-summary\" class=\"cal-summary\"></div>\n            <div id=\"calendar\" class=\"calendar\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"day-title\"></h2><span id=\"day-total\" class=\"muted small\"></span></div>\n            <div id=\"day-list\"></div>\n          </div>\n        </section>\n\n        <!-- 내역 -->\n        <section class=\"page\" data-page=\"list\">\n          <div class=\"card\">\n            <div class=\"filters\">\n              <input type=\"search\" id=\"list-search\" placeholder=\"사용처 검색\" aria-label=\"사용처 검색\">\n              <select id=\"list-kind\" aria-label=\"종류\">\n                <option value=\"all\">모든 종류</option>\n                <option value=\"expense\">지출</option>\n                <option value=\"income\">입금</option>\n                <option value=\"transfer\">내 계좌 이체</option>\n              </select>\n              <select id=\"list-filter\" aria-label=\"항목\"></select>\n              <select id=\"list-account\" aria-label=\"결제수단\"></select>\n            </div>\n            <div class=\"row-actions\">\n              <button id=\"reclassify-unclassified\" class=\"ghost-btn small-btn\">미분류만 다시 분류</button>\n              <button id=\"reclassify-all\" class=\"ghost-btn small-btn\">이 기간 전체 다시 분류</button>\n            </div>\n            <div id=\"list-total\" class=\"list-total\"></div>\n            <div id=\"tx-list\"></div>\n            <p class=\"muted small\">항목을 직접 바꾸면 그 사용처를 기억해서 다음부터 같은 항목으로 분류합니다.</p>\n          </div>\n        </section>\n\n        <!-- 리포트 -->\n        <section class=\"page\" data-page=\"report\">\n          <div class=\"grid-2\">\n            <div class=\"card\" id=\"report-headline\"></div>\n            <div class=\"card\" id=\"report-merchants\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>어디에 썼나요</h2><span class=\"muted small\">이번 기간 지출 구성</span></div>\n            <div id=\"report-share\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>기간별 추이</h2><span class=\"muted small\">최근 6개 기간</span></div>\n            <div id=\"report-trend\"></div>\n          </div>\n        </section>\n\n        <!-- 자산 -->\n        <section class=\"page\" data-page=\"assets\">\n          <div class=\"card hero-card\" id=\"asset-hero\"></div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>계좌</h2><button class=\"link\" data-goto=\"settings\">계좌 관리</button></div>\n            <div id=\"asset-banks\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>카드</h2><span class=\"muted small\">이번 기간 사용액</span></div>\n            <div id=\"asset-cards\"></div>\n          </div>\n        </section>\n\n        <!-- 미분류 정리 -->\n        <section class=\"page\" data-page=\"sort\">\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"sort-title\">미분류 정리</h2><span id=\"sort-total\" class=\"muted small\"></span></div>\n            <p class=\"muted small\">위에서 고른 기간에 AI나 키워드가 항목을 정하지 못한 지출이에요. 같은 가맹점·상대에게 쓴 것끼리 묶었으니, 알맞은 항목을 누르면 묶음 전체가 그 항목으로 들어가요.</p>\n            <label class=\"check-row\"><input type=\"checkbox\" id=\"sort-learn\" checked> 고른 항목을 기억해서 다음부터 같은 가맹점·상대는 자동으로 분류</label>\n            <div id=\"sort-others\" class=\"pick-row sort-others\"></div>\n          </div>\n          <div id=\"sort-groups\"></div>\n        </section>\n\n        <!-- 예산 계획 -->\n        <section class=\"page\" data-page=\"plan\">\n          <div id=\"plan-version\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>비율 항목의 기준 금액</h2>\n            <select id=\"ratio-base\" class=\"full\">\n              <option value=\"afterFixed\">수입에서 고정 항목을 뺀 나머지</option>\n              <option value=\"income\">전체 수입</option>\n            </select>\n            <h2 class=\"sub-head\">고정 항목 합계가 수입보다 클 때</h2>\n            <select id=\"fixed-overflow\" class=\"full\">\n              <option value=\"warn\">그대로 두고 알려 주기</option>\n              <option value=\"scale\">수입에 맞게 비율대로 줄이기</option>\n            </select>\n            <p class=\"muted small\">줄이기를 고르면 고정 항목끼리의 비율은 그대로 두고, 합계가 그 기간 수입과 같아지도록 한도를 낮춥니다. 예: 월세 60만·통신 10만(합 70만)인데 수입이 56만이면 월세 48만·통신 8만.</p>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 배분</h2>\n              <button id=\"add-category\" class=\"ghost-btn small-btn\">+ 항목 추가</button>\n            </div>\n            <p class=\"muted small\"><b>수입 비례(%)</b>: 그 기간에 들어온 돈에 비례해 한도가 정해집니다. <b>고정 금액</b>: 수입과 상관없이 매 기간 같은 한도입니다.<br><b>설명</b>은 AI가 지출을 분류할 때 참고합니다. 예: \"외식, 배달, 장보기\". <b>키워드</b>는 쉼표로 구분하며, AI를 쓸 수 없을 때 사용처에 키워드가 들어 있으면 그 항목으로 분류합니다.</p>\n            <div id=\"plan-rows\"></div>\n            <div id=\"plan-summary\" class=\"plan-summary\"></div>\n          </div>\n        </section>\n\n        <!-- 입력 -->\n        <section class=\"page\" data-page=\"add\">\n          <div id=\"auto-hint\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>직접 입력</h2>\n            <div class=\"segmented\" id=\"m-kind\" role=\"radiogroup\" aria-label=\"종류\">\n              <button type=\"button\" data-kind=\"expense\" class=\"active\">지출</button>\n              <button type=\"button\" data-kind=\"income\">입금</button>\n              <button type=\"button\" data-kind=\"transfer\">내 계좌 이체</button>\n            </div>\n            <form id=\"manual-form\" class=\"form-grid\">\n              <label>날짜<input type=\"date\" id=\"m-date\" required></label>\n              <label>금액(원)<input type=\"text\" inputmode=\"numeric\" id=\"m-amount\" placeholder=\"12,000\" required></label>\n              <label class=\"wide\">사용처 / 메모<input type=\"text\" id=\"m-memo\" placeholder=\"스타벅스 강남점\"></label>\n              <label id=\"m-category-wrap\">항목<select id=\"m-category\"></select></label>\n              <label>결제수단<select id=\"m-account\"></select></label>\n              <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">추가</button></div>\n            </form>\n            <p id=\"m-hint\" class=\"muted small\"></p>\n          </div>\n          <div class=\"card\">\n            <h2>내역 붙여넣기</h2>\n            <p class=\"muted small\">카드 승인 문자, 은행/카드 앱 내역, 엑셀에서 복사한 표를 그대로 붙여넣으세요. 한 줄에 한 건씩 날짜·금액·사용처를 읽고 <span id=\"classifier-name\">항목</span>을 자동으로 정합니다.</p>\n            <textarea id=\"paste-input\" rows=\"6\" placeholder=\"예)&#10;2026-09-27 배달의민족 23,500원&#10;9월 25일 카카오T 택시 8,400원&#10;09/24 올리브영 강남점 32,000원\"></textarea>\n            <div class=\"row-actions\">\n              <button id=\"parse-btn\" class=\"primary-btn\">인식하기</button>\n              <button id=\"paste-clear\" class=\"ghost-btn\">지우기</button>\n            </div>\n            <div id=\"parse-result\"></div>\n          </div>\n          <div class=\"card\">\n            <h2>은행 거래내역 파일 가져오기</h2>\n            <p class=\"muted small\">카카오뱅크: 앱에서 계좌 선택 → 오른쪽 위 설정(톱니바퀴) → <b>거래내역</b> → 이메일과 기간을 넣고 받기. 메일로 온 엑셀(.xlsx)이나 CSV 파일을 그대로 올리세요. 다른 은행 파일도 날짜·금액 칸이 있으면 읽습니다. 알림으로 이미 들어온 내역은 <b>중복?</b>으로 표시하고 빼 둡니다.</p>\n            <div class=\"form-grid\">\n              <label>어느 계좌의 내역인가요<select id=\"file-account\"></select></label>\n              <label>파일<input type=\"file\" id=\"file-input\" accept=\".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"></label>\n            </div>\n            <div id=\"file-result\"></div>\n          </div>\n        </section>\n\n        <!-- 설정 -->\n        <section class=\"page\" data-page=\"settings\">\n          <div class=\"settings-grid\">\n            <nav class=\"settings-nav\" aria-label=\"설정 메뉴\">\n              <a href=\"#set-basic\">기본</a>\n              <a href=\"#set-accounts\">계좌·카드</a>\n              <a href=\"#set-auto\">자동 입력</a>\n              <a href=\"#set-data\">데이터</a>\n            </nav>\n            <div>\n              <div class=\"card\" id=\"set-basic\">\n                <h2>기본</h2>\n                <div class=\"form-grid\">\n                  <label>매 기간 시작일\n                    <select id=\"start-day\"></select>\n                  </label>\n                  <label>내 이름\n                    <input type=\"text\" id=\"my-name\" placeholder=\"홍길동\" autocomplete=\"name\">\n                  </label>\n                </div>\n                <p class=\"muted small\">기간: 예를 들어 25일로 하면 9/25 ~ 10/24 가 한 기간입니다. 없는 날짜(31일 등)는 그 달의 말일로 계산합니다.<br>내 이름: 이체 알림의 상대방이 내 이름이면 내 계좌끼리 옮긴 돈으로 보고 지출에서 뺍니다.</p>\n              </div>\n\n              <div class=\"card\" id=\"set-accounts\">\n                <div class=\"card-head\"><h2>계좌·카드</h2><button id=\"add-account\" class=\"ghost-btn small-btn\">+ 추가</button></div>\n                <p class=\"muted small\">번호는 <b>끝 4자리</b>만 넣으세요. 알림에 적힌 번호로 어느 계좌·카드의 거래인지 찾고, 은행 알림의 잔액으로 계좌 잔액을 자동으로 갱신합니다. <b>저축 계좌</b>로 옮긴 돈은 저축 항목 지출로 기록합니다.</p>\n                <div id=\"account-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-auto\"></div>\n\n              <div class=\"card\" id=\"set-data\">\n                <h2>데이터</h2>\n                <p id=\"data-note\" class=\"muted small\"></p>\n                <div class=\"row-actions\">\n                  <button id=\"export-btn\" class=\"ghost-btn\">백업 내보내기(JSON)</button>\n                  <label class=\"ghost-btn file-btn\">백업 불러오기<input type=\"file\" id=\"import-file\" accept=\"application/json,.json\" hidden></label>\n                  <button id=\"reset-btn\" class=\"danger-btn\">전체 초기화</button>\n                </div>\n              </div>\n            </div>\n          </div>\n        </section>\n      </div>\n    </div>\n\n    <!-- 휴대폰 하단 메뉴 -->\n    <nav class=\"bottom-nav\" aria-label=\"빠른 메뉴\">\n      <button data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n      <button data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n      <button data-page=\"add\" class=\"bn-add\" aria-label=\"입력\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n      <button data-open-menu><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg>전체</button>\n    </nav>\n  </div>\n\n  <div id=\"tooltip\" class=\"tooltip\" role=\"tooltip\" hidden></div>\n  <div id=\"toast\" class=\"toast\" hidden></div>\n\n  <script>/*__SERVER_CONFIG__*/</script>\n  <script>__budgetRun(\"js/logic.js\", \"LyoKICog7KeA7LacIOq0gOumrCDslbHsnZgg7Iic7IiYIOuhnOyngSAoRE9NIOyXhuydjCkuCiAqIOu4jOudvOyasOyggOyXkOyEnOuKlCB3aW5kb3cuQnVkZ2V0TG9naWMg7Jy866GcLCBOb2RlKO2FjOyKpO2KuCnsl5DshJzripQgcmVxdWlyZSDroZwg7IKs7Jqp7ZWc64ukLgogKiDrgqDsp5zripQg66qo65GQICdZWVlZLU1NLUREJyDrrLjsnpDsl7TroZwg64uk66Os64ukICjsi5zqsITrjIAg66y47KCcIO2ajO2UvCkuCiAqLwooZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHsKICBjb25zdCBhcGkgPSBmYWN0b3J5KCk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICBlbHNlIHJvb3QuQnVkZ2V0TG9naWMgPSBhcGk7Cn0pKHR5cGVvZiBnbG9iYWxUaGlzICE9PSAndW5kZWZpbmVkJyA/IGdsb2JhbFRoaXMgOiB0aGlzLCBmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICAvLyAtLS0tLS0tLS0tIOuCoOynnCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHBhZChuKSB7CiAgICByZXR1cm4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgfQoKICBmdW5jdGlvbiB0b0lTTyh5LCBtLCBkKSB7CiAgICByZXR1cm4gYCR7eX0tJHtwYWQobSl9LSR7cGFkKGQpfWA7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUlTTyhzKSB7CiAgICBjb25zdCBbeSwgbSwgZF0gPSBzLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyB5LCBtLCBkIH07CiAgfQoKICBmdW5jdGlvbiBkYXlzSW5Nb250aCh5LCBtKSB7CiAgICByZXR1cm4gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSwgMCkpLmdldFVUQ0RhdGUoKTsKICB9CgogIGZ1bmN0aW9uIGFkZE1vbnRocyh5LCBtLCBkZWx0YSkgewogICAgY29uc3QgaWR4ID0geSAqIDEyICsgKG0gLSAxKSArIGRlbHRhOwogICAgcmV0dXJuIHsgeTogTWF0aC5mbG9vcihpZHggLyAxMiksIG06IChpZHggJSAxMikgKyAxIH07CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGlzbywgZGVsdGEpIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gcGFyc2VJU08oaXNvKTsKICAgIGNvbnN0IGR0ID0gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSAtIDEsIGQgKyBkZWx0YSkpOwogICAgcmV0dXJuIHRvSVNPKGR0LmdldFVUQ0Z1bGxZZWFyKCksIGR0LmdldFVUQ01vbnRoKCkgKyAxLCBkdC5nZXRVVENEYXRlKCkpOwogIH0KCiAgZnVuY3Rpb24gZGlmZkRheXMoYSwgYikgewogICAgY29uc3QgcGEgPSBwYXJzZUlTTyhhKTsKICAgIGNvbnN0IHBiID0gcGFyc2VJU08oYik7CiAgICByZXR1cm4gTWF0aC5yb3VuZCgoRGF0ZS5VVEMocGIueSwgcGIubSAtIDEsIHBiLmQpIC0gRGF0ZS5VVEMocGEueSwgcGEubSAtIDEsIHBhLmQpKSAvIDg2NDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHRvZGF5SVNPKG5vdyA9IG5ldyBEYXRlKCkpIHsKICAgIHJldHVybiB0b0lTTyhub3cuZ2V0RnVsbFllYXIoKSwgbm93LmdldE1vbnRoKCkgKyAxLCBub3cuZ2V0RGF0ZSgpKTsKICB9CgogIC8vIOyLnOyekeydvOydtCDtlbTri7kg7JuU7JeQIOyXhuycvOuptCjsmIg6IDMx7J28KSDqt7gg64us7J2YIOunkOydvOuhnCDrp57stpjri6QuCiAgZnVuY3Rpb24gcGVyaW9kU3RhcnRJbk1vbnRoKHksIG0sIHN0YXJ0RGF5KSB7CiAgICByZXR1cm4gdG9JU08oeSwgbSwgTWF0aC5taW4oc3RhcnREYXksIGRheXNJbk1vbnRoKHksIG0pKSk7CiAgfQoKICBmdW5jdGlvbiBnZXRQZXJpb2QoZGF0ZUlTTywgc3RhcnREYXkpIHsKICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oZGF0ZUlTTyk7CiAgICBsZXQgc3RhcnQgPSBwZXJpb2RTdGFydEluTW9udGgoeSwgbSwgc3RhcnREYXkpOwogICAgbGV0IHN5ID0geTsKICAgIGxldCBzbSA9IG07CiAgICBpZiAoZGF0ZUlTTyA8IHN0YXJ0KSB7CiAgICAgICh7IHk6IHN5LCBtOiBzbSB9ID0gYWRkTW9udGhzKHksIG0sIC0xKSk7CiAgICAgIHN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKHN5LCBzbSwgc3RhcnREYXkpOwogICAgfQogICAgY29uc3QgbmV4dCA9IGFkZE1vbnRocyhzeSwgc20sIDEpOwogICAgY29uc3QgbmV4dFN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKG5leHQueSwgbmV4dC5tLCBzdGFydERheSk7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKG5leHRTdGFydCwgLTEpLCBrZXk6IHN0YXJ0IH07CiAgfQoKICBmdW5jdGlvbiBzaGlmdFBlcmlvZChwZXJpb2QsIGRlbHRhLCBzdGFydERheSkgewogICAgY29uc3QgeyB5LCBtIH0gPSBwYXJzZUlTTyhwZXJpb2Quc3RhcnQpOwogICAgY29uc3QgdCA9IGFkZE1vbnRocyh5LCBtLCBkZWx0YSk7CiAgICByZXR1cm4gZ2V0UGVyaW9kKHBlcmlvZFN0YXJ0SW5Nb250aCh0LnksIHQubSwgc3RhcnREYXkpLCBzdGFydERheSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4TsgrAgLS0tLS0tLS0tLQoKICAvKgogICAqIGNhdGVnb3JpZXM6IFt7IGlkLCBuYW1lLCB0eXBlOiAncmF0aW8nIHwgJ2ZpeGVkJywgdmFsdWUgfV0KICAgKiAgIHJhdGlvIOKGkiB2YWx1ZSDripQg7Y287IS87Yq4LCBmaXhlZCDihpIgdmFsdWUg64qUIOybkCDri6jsnIQg6riI7JWhCiAgICogcmF0aW9CYXNlOiAnaW5jb21lJyAgICAg4oaSIOu5hOycqCDtla3rqqnsnYAg7KCE7LK0IOyImOyehSDquLDspIAKICAgKiAgICAgICAgICAgICdhZnRlckZpeGVkJyDihpIg67mE7JyoIO2VreuqqeydgCAo7IiY7J6FIC0g6rOg7KCVIO2VreuqqSDtlanqs4QpIOq4sOykgAogICAqIGZpeGVkT3ZlcmZsb3c6IOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOyImOyeheuztOuLpCDtgbQg65WMCiAgICogICAgICAgICAgICAnd2FybicgIOKGkiDsoJXtlZwg6riI7JWhIOq3uOuMgOuhnCDrkZDqs6Ag7ZmU66m07JeQ7IScIOyVjOumsOuLpCAo6riw67O4KQogICAqICAgICAgICAgICAgJ3NjYWxlJyDihpIg6rOg7KCVIO2VreuqqeuBvOumrOydmCDruYTsnKjsnYQg7Jyg7KeA7ZWcIOyxhCDtlanqs4TqsIAg7IiY7J6F6rO8IOqwmeyVhOyngOuPhOuhnSDspITsnbjri6QKICAgKiDsiJjsnoXsnbQgMCjslYTsp4Eg7J6F66ClIOyViCDtlagp7J2066m0IOykhOydtOyngCDslYrripTri6QuCiAgICovCiAgZnVuY3Rpb24gY29tcHV0ZUJ1ZGdldHMoY2F0ZWdvcmllcywgaW5jb21lLCByYXRpb0Jhc2UsIGZpeGVkT3ZlcmZsb3cpIHsKICAgIGNvbnN0IGluYyA9IE1hdGgubWF4KDAsIE51bWJlcihpbmNvbWUpIHx8IDApOwogICAgY29uc3QgZml4ZWRDYXRzID0gY2F0ZWdvcmllcy5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gJ2ZpeGVkJyk7CiAgICBjb25zdCBmaXhlZFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIE1hdGgucm91bmQoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IHJhdGlvUGVyY2VudFRvdGFsID0gY2F0ZWdvcmllcwogICAgICAuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09ICdyYXRpbycpCiAgICAgIC5yZWR1Y2UoKHMsIGMpID0+IHMgKyAoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IGZpeGVkT3ZlciA9IGluYyA+IDAgPyBNYXRoLm1heCgwLCBmaXhlZFRvdGFsIC0gaW5jKSA6IDA7CiAgICBjb25zdCBmaXhlZFNjYWxlZCA9IGZpeGVkT3ZlcmZsb3cgPT09ICdzY2FsZScgJiYgZml4ZWRPdmVyID4gMDsKCiAgICBjb25zdCBidWRnZXRzID0ge307CiAgICBmb3IgKGNvbnN0IGMgb2YgZml4ZWRDYXRzKSBidWRnZXRzW2MuaWRdID0gTWF0aC5yb3VuZChOdW1iZXIoYy52YWx1ZSkgfHwgMCk7CiAgICBpZiAoZml4ZWRTY2FsZWQpIHsKICAgICAgLy8g67mE66GA7ZW07IScIOuCtOumvO2VnCDrkqQsIOuCqOydgCDrqocg7JuQ7J2AIOyGjOyImOygkCDslYTrnpjqsIAg7YGwIO2Vreuqqeu2gO2EsCAx7JuQ7JSpIOuNlO2VtCDtlanqs4Trpbwg7IiY7J6F6rO8IOygle2Zle2eiCDrp57stpjri6QKICAgICAgY29uc3QgcGFydHMgPSBmaXhlZENhdHMubWFwKChjKSA9PiB7CiAgICAgICAgY29uc3QgZXhhY3QgPSAoYnVkZ2V0c1tjLmlkXSAqIGluYykgLyBmaXhlZFRvdGFsOwogICAgICAgIHJldHVybiB7IGlkOiBjLmlkLCBmbG9vcjogTWF0aC5mbG9vcihleGFjdCksIGZyYWM6IGV4YWN0IC0gTWF0aC5mbG9vcihleGFjdCkgfTsKICAgICAgfSk7CiAgICAgIGxldCBsZWZ0ID0gaW5jIC0gcGFydHMucmVkdWNlKChzLCB4KSA9PiBzICsgeC5mbG9vciwgMCk7CiAgICAgIHBhcnRzLnNvcnQoKGEsIGIpID0+IGIuZnJhYyAtIGEuZnJhYyk7CiAgICAgIGZvciAoY29uc3QgeCBvZiBwYXJ0cykgewogICAgICAgIGJ1ZGdldHNbeC5pZF0gPSB4LmZsb29yICsgKGxlZnQgPiAwID8gMSA6IDApOwogICAgICAgIGlmIChsZWZ0ID4gMCkgbGVmdCAtPSAxOwogICAgICB9CiAgICB9CiAgICBjb25zdCBmaXhlZEJ1ZGdldFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIGJ1ZGdldHNbYy5pZF0sIDApOwogICAgY29uc3QgYmFzZSA9IHJhdGlvQmFzZSA9PT0gJ2FmdGVyRml4ZWQnID8gTWF0aC5tYXgoMCwgaW5jIC0gZml4ZWRCdWRnZXRUb3RhbCkgOiBpbmM7CgogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIHsKICAgICAgaWYgKGMudHlwZSAhPT0gJ2ZpeGVkJykgYnVkZ2V0c1tjLmlkXSA9IE1hdGgucm91bmQoKGJhc2UgKiAoTnVtYmVyKGMudmFsdWUpIHx8IDApKSAvIDEwMCk7CiAgICB9CiAgICBjb25zdCBhbGxvY2F0ZWQgPSBPYmplY3QudmFsdWVzKGJ1ZGdldHMpLnJlZHVjZSgocywgdikgPT4gcyArIHYsIDApOwogICAgcmV0dXJuIHsKICAgICAgYnVkZ2V0cywKICAgICAgZml4ZWRUb3RhbCwKICAgICAgZml4ZWRCdWRnZXRUb3RhbCwKICAgICAgZml4ZWRPdmVyLAogICAgICBmaXhlZFNjYWxlZCwKICAgICAgZml4ZWRTY2FsZTogZml4ZWRTY2FsZWQgPyBpbmMgLyBmaXhlZFRvdGFsIDogMSwKICAgICAgcmF0aW9QZXJjZW50VG90YWwsCiAgICAgIHJhdGlvQmFzZUFtb3VudDogYmFzZSwKICAgICAgYWxsb2NhdGVkLAogICAgICB1bmFsbG9jYXRlZDogaW5jIC0gYWxsb2NhdGVkLAogICAgfTsKICB9CgogIC8vIOqxsOuemCDsooXrpZg6IGV4cGVuc2Uo7KeA7LacLCDquLDrs7gpIC8gaW5jb21lKOyeheq4iCkgLyB0cmFuc2ZlcijrgrQg6rOE7KKM64G866asIOydtOyytCDigJQg7KeA7LacwrfsiJjsnoXsl5DshJwg7KCc7Jm4KQogIGZ1bmN0aW9uIGtpbmRPZih0KSB7CiAgICByZXR1cm4gdC5raW5kID09PSAnaW5jb21lJyB8fCB0LmtpbmQgPT09ICd0cmFuc2ZlcicgPyB0LmtpbmQgOiAnZXhwZW5zZSc7CiAgfQoKICBmdW5jdGlvbiB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKSB7CiAgICByZXR1cm4gc3RhdGUudHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gdC5kYXRlID49IHBlcmlvZC5zdGFydCAmJiB0LmRhdGUgPD0gcGVyaW9kLmVuZCk7CiAgfQoKICBmdW5jdGlvbiBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCkgewogICAgY29uc3QgcGxhbiA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZC5rZXkpOwogICAgY29uc3QgaW5jb21lID0gc3RhdGUuaW5jb21lc1twZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IGNvbXB1dGVCdWRnZXRzKHBsYW4uY2F0ZWdvcmllcywgaGFzSW5jb21lID8gaW5jb21lIDogMCwgcGxhbi5yYXRpb0Jhc2UsIHBsYW4uZml4ZWRPdmVyZmxvdyk7CiAgICBjb25zdCBhbGwgPSB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKTsKICAgIGNvbnN0IHR4cyA9IGFsbC5maWx0ZXIoKHQpID0+IGtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKTsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CgogICAgY29uc3Qgc3BlbnQgPSB7fTsKICAgIGNvbnN0IGNvdW50cyA9IHt9OwogICAgZm9yIChjb25zdCBjIG9mIHBsYW4uY2F0ZWdvcmllcykgewogICAgICBzcGVudFtjLmlkXSA9IDA7CiAgICAgIGNvdW50c1tjLmlkXSA9IDA7CiAgICB9CiAgICBsZXQgdW5jbGFzc2lmaWVkID0gMDsKICAgIGxldCB1bmNsYXNzaWZpZWRDb3VudCA9IDA7CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7CiAgICAgIGlmICh0LmNhdGVnb3J5SWQgJiYga25vd24uaGFzKHQuY2F0ZWdvcnlJZCkpIHsKICAgICAgICBzcGVudFt0LmNhdGVnb3J5SWRdICs9IHQuYW1vdW50OwogICAgICAgIGNvdW50c1t0LmNhdGVnb3J5SWRdICs9IDE7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdW5jbGFzc2lmaWVkICs9IHQuYW1vdW50OwogICAgICAgIHVuY2xhc3NpZmllZENvdW50ICs9IDE7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IHRvdGFsU3BlbnQgPSB0eHMucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgY29uc3QgaW5jb21lUmVjZWl2ZWQgPSBhbGwuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdpbmNvbWUnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CgogICAgY29uc3Qgcm93cyA9IHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IHsKICAgICAgY29uc3QgYnVkZ2V0ID0gY2FsYy5idWRnZXRzW2MuaWRdOwogICAgICBjb25zdCB1c2VkID0gc3BlbnRbYy5pZF07CiAgICAgIHJldHVybiB7CiAgICAgICAgY2F0ZWdvcnk6IGMsCiAgICAgICAgYnVkZ2V0LAogICAgICAgIHNwZW50OiB1c2VkLAogICAgICAgIGNvdW50OiBjb3VudHNbYy5pZF0sCiAgICAgICAgcmVtYWluaW5nOiBidWRnZXQgLSB1c2VkLAogICAgICAgIHJhdGlvOiBidWRnZXQgPiAwID8gdXNlZCAvIGJ1ZGdldCA6IHVzZWQgPiAwID8gSW5maW5pdHkgOiAwLAogICAgICB9OwogICAgfSk7CgogICAgLy8g6rOE7ZqN7J20IOuwlOuAkCDrkqTsl5Ag7JWE7KeBIOuLpOyLnCDrtoTrpZjrkJjsp4Ag7JWK7J2AICjsp4HsoJEg6rOg66W07KeAIOyViuydgCkg7KeA7LacCiAgICBjb25zdCBzdGFsZUNvdW50ID0gdHhzLmZpbHRlcigKICAgICAgKHQpID0+IHQubWV0aG9kICE9PSAnbWFudWFsJyAmJiAoIXQuY2xhc3NpZmllZEF0IHx8IChwbGFuLnVwZGF0ZWRBdCAmJiB0LmNsYXNzaWZpZWRBdCA8IHBsYW4udXBkYXRlZEF0KSkKICAgICkubGVuZ3RoOwoKICAgIHJldHVybiB7CiAgICAgIHBlcmlvZCwKICAgICAgcGxhbiwKICAgICAgc3RhbGVDb3VudCwKICAgICAgaW5jb21lOiBoYXNJbmNvbWUgPyBpbmNvbWUgOiBudWxsLAogICAgICBoYXNJbmNvbWUsCiAgICAgIC4uLmNhbGMsCiAgICAgIHJvd3MsCiAgICAgIHVuY2xhc3NpZmllZCwKICAgICAgdW5jbGFzc2lmaWVkQ291bnQsCiAgICAgIHRvdGFsU3BlbnQsCiAgICAgIGluY29tZVJlY2VpdmVkLAogICAgICByZW1haW5pbmc6IChoYXNJbmNvbWUgPyBpbmNvbWUgOiAwKSAtIHRvdGFsU3BlbnQsCiAgICAgIHRyYW5zYWN0aW9uczogdHhzLAogICAgICBhbGxUcmFuc2FjdGlvbnM6IGFsbCwKICAgIH07CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNPZihyYXRpbykgewogICAgaWYgKHJhdGlvID4gMSkgcmV0dXJuICdjcml0aWNhbCc7CiAgICBpZiAocmF0aW8gPj0gMC44KSByZXR1cm4gJ3dhcm5pbmcnOwogICAgcmV0dXJuICdnb29kJzsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6Q64+ZIOu2hOulmCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIG5vcm1hbGl6ZU1lcmNoYW50KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9ccysvZywgJycpOwogIH0KCiAgLy8gMSkg7KeB7KCRIOu2hOulmO2VtCDrkZQg6rCA66e57KCQKO2VmeyKtSkg4oaSIDIpIOqwgOyepSDquLQg7YKk7JuM65Oc6rCAIOydvOy5mO2VmOuKlCDtla3rqqkKICBmdW5jdGlvbiBjbGFzc2lmeShtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBub3JtID0gbm9ybWFsaXplTWVyY2hhbnQobWVtbyk7CiAgICBpZiAoIW5vcm0pIHJldHVybiBudWxsOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBsZWFybmVkID0gbWVyY2hhbnRNYXBbbm9ybV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiBsZWFybmVkOwoKICAgIGxldCBiZXN0ID0gbnVsbDsKICAgIGxldCBiZXN0TGVuID0gMDsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSB7CiAgICAgIGZvciAoY29uc3Qga3cgb2YgYy5rZXl3b3JkcyB8fCBbXSkgewogICAgICAgIGNvbnN0IGsgPSBub3JtYWxpemVNZXJjaGFudChrdyk7CiAgICAgICAgaWYgKGsgJiYgay5sZW5ndGggPiBiZXN0TGVuICYmIG5vcm0uaW5jbHVkZXMoaykpIHsKICAgICAgICAgIGJlc3QgPSBjLmlkOwogICAgICAgICAgYmVzdExlbiA9IGsubGVuZ3RoOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgcmV0dXJuIGJlc3Q7CiAgfQoKICAvLyBBSSDsl4bsnbQg67aE66WYOiB7IGNhdGVnb3J5SWQsIG1ldGhvZDogJ2xlYXJuZWQnIHwgJ2tleXdvcmQnIHwgbnVsbCB9CiAgZnVuY3Rpb24gY2xhc3NpZnlMb2NhbChtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGNvbnN0IGxlYXJuZWQgPSBtZXJjaGFudE1hcFtub3JtYWxpemVNZXJjaGFudChtZW1vKV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiB7IGNhdGVnb3J5SWQ6IGxlYXJuZWQsIG1ldGhvZDogJ2xlYXJuZWQnIH07CiAgICBjb25zdCBpZCA9IGNsYXNzaWZ5KG1lbW8sIGNhdGVnb3JpZXMsIHt9KTsKICAgIHJldHVybiBpZCA/IHsgY2F0ZWdvcnlJZDogaWQsIG1ldGhvZDogJ2tleXdvcmQnIH0gOiB7IGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9OwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsp4Dstpwg64K07JetIO2FjeyKpO2KuCDsnbjsi50gLS0tLS0tLS0tLQoKICBjb25zdCBOT0lTRV9QQVRURVJOUyA9IFsKICAgIC9cWz93ZWJccyrrsJzsi6BcXT8vZ2ksCiAgICAvXFtbXlxdXSpcXS9nLAogICAgLyjriITsoIF87J6U7JWhfOyelOqzoHztlZzrj4QpXHMqOj9ccyotP1tcZCxdK1xzKuybkD8vZywKICAgIC9cKD9ccyoo7J287Iuc67aIfO2VoOu2gFxzKlxkKlxzKuqwnD/sm5Q/fFxkK1xzKuqwnOyblClccypcKT8vZywKICAgIC9cKFxzKltcZCpdezMsNH1ccypcKS9nLCAvLyDsubTrk5wg64Gd7J6Q66asICgxMjM0KQogICAgL1wqXGR7Myw0fS9nLAogICAgL1xTXCpcUy9nLCAvLyDrp4jsiqTtgrnrkJwg7J2066aEIO2ZjSrrj5kKICAgIC9cZHsxLDJ9OlxkezJ9KDpcZHsyfSk/L2csIC8vIOyLnOqwgQogICAgLyjssrTtgax87Iug7JqpKT9ccyrsirnsnbgo7Leo7IaMKT8vZywKICAgIC/qsrDsoJwo7JmE66OMKT987IKs7JqpKOyZhOujjCk/fOy2nOq4iC9nLAogICAgLyhefFxzKVxTezEsNn3subTrk5woPz1cc3wkKS9nLCAvLyDsi6DtlZzsubTrk5wsIEtC6rWt66+87Lm065OcIC4uLgogIF07CgogIGZ1bmN0aW9uIGluZmVyWWVhcihtb250aCwgZGF5LCByZWZJU08pIHsKICAgIGNvbnN0IHJlZiA9IHBhcnNlSVNPKHJlZklTTyk7CiAgICBsZXQgeWVhciA9IHJlZi55OwogICAgLy8g6riw7KSA7J2867O064ukIO2VnOywuCDrr7jrnpjrnbzrqbQg7J6R64WEIOuCtOyXreycvOuhnCDrs7jri6QgKOyYiDogMeyblOyXkCAxMuyblCDrgrTsl60g67aZ7Jes64Sj6riwKQogICAgaWYgKGRpZmZEYXlzKHJlZklTTywgdG9JU08oeWVhciwgbW9udGgsIE1hdGgubWluKGRheSwgZGF5c0luTW9udGgoeWVhciwgbW9udGgpKSkpID4gNykgeWVhciAtPSAxOwogICAgcmV0dXJuIHllYXI7CiAgfQoKICBmdW5jdGlvbiB2YWxpZERhdGUoeSwgbSwgZCkgewogICAgcmV0dXJuIG0gPj0gMSAmJiBtIDw9IDEyICYmIGQgPj0gMSAmJiBkIDw9IGRheXNJbk1vbnRoKHksIG0pOwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdERhdGUobGluZSwgcmVmSVNPKSB7CiAgICBsZXQgbSA9IGxpbmUubWF0Y2goLygyMFxkezJ9KVxzKlsuXC0v64WEXVxzKihcZHsxLDJ9KVxzKlsuXC0v7JuUXVxzKihcZHsxLDJ9KVxzKuydvD8vKTsKICAgIGlmIChtKSB7CiAgICAgIGNvbnN0IFt5LCBtbywgZF0gPSBbTnVtYmVyKG1bMV0pLCBOdW1iZXIobVsyXSksIE51bWJlcihtWzNdKV07CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCAnICcpIH07CiAgICB9CiAgICAvLyDslZ7sl5Ag7Iir7J6QwrfsibztkZzqsIAg7JeG64qUIDA5LzI4IOqwmeydgCDrgqDsp5wuICjsmKTrnpjrkJwgaU9TIOyCrO2MjOumrOqwgCDsoJXqt5zsi50gbG9va2JlaGluZCDrpbwg66q7IOydveyWtOyEnAogICAgLy8g7JWeIOq4gOyekOulvCDqt7jro7nsnLzroZwg7J6h6rOgIOuQmOuPjOugpCDrhpPripTri6QpCiAgICBsZXQga2VlcCA9ICcnOwogICAgbSA9IGxpbmUubWF0Y2goLyhcZHsxLDJ9KVxzKuyblFxzKihcZHsxLDJ9KVxzKuydvC8pOwogICAgaWYgKCFtKSB7CiAgICAgIGNvbnN0IG1tID0gbGluZS5tYXRjaCgvKF58W15cZCxdKShcZHsxLDJ9KVsvLlwtXShcZHsxLDJ9KSg/IVtcZCxdKS8pOwogICAgICBpZiAobW0pIHsKICAgICAgICBrZWVwID0gbW1bMV07CiAgICAgICAgbSA9IFttbVswXSwgbW1bMl0sIG1tWzNdXTsKICAgICAgfQogICAgfQogICAgaWYgKG0pIHsKICAgICAgY29uc3QgW21vLCBkXSA9IFtOdW1iZXIobVsxXSksIE51bWJlcihtWzJdKV07CiAgICAgIGNvbnN0IHkgPSBpbmZlclllYXIobW8sIGQsIHJlZklTTyk7CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrZWVwfSBgKSB9OwogICAgfQogICAgcmV0dXJuIHsgZGF0ZTogbnVsbCwgcmVzdDogbGluZSB9OwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdEFtb3VudChsaW5lKSB7CiAgICAvLyBb7KCV6rec7IudLCDquIjslaEg6re466O5LCDrkJjrj4zroKQg64aT7J2EIOyVniDquIDsnpAg6re466O5XQogICAgY29uc3QgcGF0dGVybnMgPSBbCiAgICAgIFsvKC0/XGRbXGQsXSopXHMq7JuQLywgMSwgMF0sIC8vIDEyLDAwMOybkAogICAgICBbLygtP1xkezEsM30oPzosXGR7M30pKykoPyFcZCkvLCAxLCAwXSwgLy8gMTIsMDAwCiAgICAgIFsvKF58XEQpKC0/XGR7Myx9KSg/IVxkKS8sIDIsIDFdLCAvLyAxMjAwMAogICAgXTsKICAgIGZvciAoY29uc3QgW3AsIGcsIGtdIG9mIHBhdHRlcm5zKSB7CiAgICAgIGNvbnN0IG0gPSBsaW5lLm1hdGNoKHApOwogICAgICBpZiAobSkgewogICAgICAgIGNvbnN0IG4gPSBOdW1iZXIobVtnXS5yZXBsYWNlKC8sL2csICcnKSk7CiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShuKSAmJiBuICE9PSAwKSByZXR1cm4geyBhbW91bnQ6IG4sIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrID8gbVtrXSA6ICcnfSBgKSB9OwogICAgICB9CiAgICB9CiAgICByZXR1cm4geyBhbW91bnQ6IG51bGwsIHJlc3Q6IGxpbmUgfTsKICB9CgogIGZ1bmN0aW9uIGNsZWFuTWVtbyhzKSB7CiAgICBsZXQgb3V0ID0gczsKICAgIGZvciAoY29uc3QgcCBvZiBOT0lTRV9QQVRURVJOUykgb3V0ID0gb3V0LnJlcGxhY2UocCwgJyAnKTsKICAgIHJldHVybiBvdXQKICAgICAgLnJlcGxhY2UoL1tcdCx8O10rL2csICcgJykKICAgICAgLnJlcGxhY2UoL15bXHNcLTrCty8oKV0rfFtcc1wtOsK3LygpXSskL2csICcnKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgICAgLnRyaW0oKTsKICB9CgogIC8qCiAgICog7Jes65+sIOykhOydmCDthY3siqTtirgo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDrgrTsl60sIOyXkeyFgCDrs7Xsgqwg65OxKeyXkOyEnCDsp4DstpzsnYQg672R7JWE64K464ukLgogICAqIOuwmO2ZmDogeyBpdGVtczogW3sgZGF0ZSwgYW1vdW50LCBtZW1vLCByYXcgfV0sIHNraXBwZWQ6IFtyYXcuLi5dIH0KICAgKi8KICBmdW5jdGlvbiBwYXJzZUV4cGVuc2VUZXh0KHRleHQsIHJlZklTTykgewogICAgY29uc3QgaXRlbXMgPSBbXTsKICAgIGNvbnN0IHNraXBwZWQgPSBbXTsKICAgIGZvciAoY29uc3QgcmF3TGluZSBvZiBTdHJpbmcodGV4dCB8fCAnJykuc3BsaXQoL1xyP1xuLykpIHsKICAgICAgY29uc3QgcmF3ID0gcmF3TGluZS50cmltKCk7CiAgICAgIGlmICghcmF3KSBjb250aW51ZTsKICAgICAgY29uc3QgaXNDYW5jZWwgPSAv7Leo7IaMfO2ZmOu2iC8udGVzdChyYXcpOwogICAgICAvLyDriITsoIEv7J6U7JWhIOq4iOyVoeydtCDqsrDsoJwg6riI7JWh7Jy866GcIOyeoe2eiOyngCDslYrrj4TroZ0g66i87KCAIOygnOqxsAogICAgICBsZXQgd29yayA9IHJhdwogICAgICAgIC5yZXBsYWNlKC8o64iE7KCBfOyelOyVoXzsnpTqs6B87ZWc64+EKVxzKjo/XHMqLT9bXGQsXStccyrsm5A/L2csICcgJykKICAgICAgICAucmVwbGFjZSgvXGR7MSwyfTpcZHsyfSg6XGR7Mn0pPy9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1woXHMqW1xkKl17Myw0fVxzKlwpfFwqXGR7Myw0fS9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1x0L2csICcgJyk7CiAgICAgIGNvbnN0IGQgPSBleHRyYWN0RGF0ZSh3b3JrLCByZWZJU08pOwogICAgICB3b3JrID0gZC5yZXN0OwogICAgICBjb25zdCBhID0gZXh0cmFjdEFtb3VudCh3b3JrKTsKICAgICAgaWYgKGEuYW1vdW50ID09PSBudWxsKSB7CiAgICAgICAgc2tpcHBlZC5wdXNoKHJhdyk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgbGV0IGFtb3VudCA9IE1hdGguYWJzKGEuYW1vdW50KTsKICAgICAgaWYgKGlzQ2FuY2VsIHx8IGEuYW1vdW50IDwgMCkgYW1vdW50ID0gLWFtb3VudDsKICAgICAgY29uc3QgbWVtbyA9IGNsZWFuTWVtbyhhLnJlc3QucmVwbGFjZSgv7Leo7IaMfO2ZmOu2iC9nLCAnICcpKSB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgICAgaXRlbXMucHVzaCh7IGRhdGU6IGQuZGF0ZSB8fCByZWZJU08sIGFtb3VudCwgbWVtbywgcmF3IH0pOwogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQgfTsKICB9CgogIGZ1bmN0aW9uIGlzRHVwbGljYXRlKGl0ZW0sIHRyYW5zYWN0aW9ucykgewogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5zb21lKAogICAgICAodCkgPT4gdC5kYXRlID09PSBpdGVtLmRhdGUgJiYgdC5hbW91bnQgPT09IGl0ZW0uYW1vdW50ICYmIG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgPT09IG5vcm1hbGl6ZU1lcmNoYW50KGl0ZW0ubWVtbykKICAgICk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOqysOygnMK37J6F7Lac6riIIOyVjOumvCAo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDslYzrprwpIC0tLS0tLS0tLS0KCiAgLy8g6rGw656YIOyVjOumvOyymOufvCDrs7TsnbTripQg6riA7J247KeAICjsnbjspp3rsojtmLgsIOq0keqzoCDrk7HsnYAg7KCc7Jm4KQogIGZ1bmN0aW9uIGxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpIHsKICAgIGNvbnN0IHQgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBpZiAoIS9bXGQsXStccyrsm5AvLnRlc3QodCkpIHJldHVybiBmYWxzZTsKICAgIGlmICgv7J247KadXHMq67KI7Zi4fOyduOymney9lOuTnC8udGVzdCh0KSkgcmV0dXJuIGZhbHNlOwogICAgcmV0dXJuIC/sirnsnbh86rKw7KCcfOyCrOyaqXzst6jshox87Lac6riIfOyeheq4iHzsnbTssrR87Iah6riIfOuztOuDiHzrsJvslZgvLnRlc3QodCk7CiAgfQoKICBmdW5jdGlvbiBkaWdpdHNPbmx5KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvXEQvZywgJycpOwogIH0KCiAgLy8g7JWM66a87JeQIOygge2ejCDqs4TsoozCt+y5tOuTnCDrsojtmLgo6rCA66Ck7KeEIOuyiO2YuCDtj6ztlagp7J2YIOuBneyekOumrOuhnCDrk7HroZ3rkJwg6rOE7KKML+y5tOuTnOulvCDssL7ripTri6QKICBmdW5jdGlvbiBtYXRjaEFjY291bnQodGV4dCwgYWNjb3VudHMpIHsKICAgIGNvbnN0IGNodW5rcyA9IFN0cmluZyh0ZXh0IHx8ICcnKS5tYXRjaCgvW1xkKl1bXGQqXC1dezIsfS9nKSB8fCBbXTsKICAgIGZvciAoY29uc3QgYSBvZiBhY2NvdW50cyB8fCBbXSkgewogICAgICBjb25zdCBsYXN0NCA9IGRpZ2l0c09ubHkoYS5sYXN0NCkuc2xpY2UoLTQpOwogICAgICBpZiAobGFzdDQubGVuZ3RoIDwgMykgY29udGludWU7CiAgICAgIGZvciAoY29uc3QgYyBvZiBjaHVua3MpIHsKICAgICAgICBpZiAoL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoYykpIGNvbnRpbnVlOyAvLyDrgqDsp5wKICAgICAgICBpZiAoZGlnaXRzT25seShjKS5lbmRzV2l0aChsYXN0NCkpIHJldHVybiBhOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIGZ1bmN0aW9uIGFjY291bnRCeUxhc3Q0KGxhc3Q0LCBhY2NvdW50cykgewogICAgY29uc3QgZCA9IGRpZ2l0c09ubHkobGFzdDQpLnNsaWNlKC00KTsKICAgIGlmIChkLmxlbmd0aCA8IDMpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChhY2NvdW50cyB8fCBbXSkuZmluZCgoYSkgPT4gZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCkgPT09IGQpIHx8IG51bGw7CiAgfQoKICAvLyBBSSDsl4bsnbQg7JWM66a87J2EIOydveydhCDrlYwg6rGw656YIOyiheulmCDstpTsuKEKICBmdW5jdGlvbiBkZXRlY3RLaW5kKHRleHQsIG15TmFtZSkgewogICAgY29uc3QgdCA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgv7Iq57J24fOqysOygnC8udGVzdCh0KSkgcmV0dXJuICdleHBlbnNlJzsKICAgIGlmIChteU5hbWUgJiYgdC5pbmNsdWRlcyhteU5hbWUpICYmIC/snbTssrR87Lac6riIfOyGoeq4iHzrs7Trg4h87J6F6riIfOuwm+yVmC8udGVzdCh0KSkgcmV0dXJuICd0cmFuc2Zlcic7CiAgICBpZiAoL+yeheq4iHzrsJvslZgvLnRlc3QodCkgJiYgIS/stpzquIgvLnRlc3QodCkpIHJldHVybiAnaW5jb21lJzsKICAgIHJldHVybiAnZXhwZW5zZSc7CiAgfQoKICAvLyBBSSDrpbwg7JO4IOyImCDsl4bsnYQg65WM7J2YIOyVjOumvCDsnbjsi50uIOyXrOufrCDspIQg7JWM66a87J2EIO2VnCDspITroZwg7ZWp7LOQ7IScIOydveuKlOuLpC4KICAvLyDrsJjtmZg6IHsgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGJhbGFuY2UgfSDrmJDripQgbnVsbAogIGZ1bmN0aW9uIHBhcnNlTWVzc2FnZUZhbGxiYWNrKHRleHQsIHJlZklTTywgb3B0cyA9IHt9KSB7CiAgICBpZiAoIWxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGJhbGFuY2VNYXRjaCA9IFN0cmluZyh0ZXh0KS5tYXRjaCgv7J6U7JWhXHMqOj9ccyooW1xkLF0rKVxzKuybkD8vKTsKICAgIGNvbnN0IGFjY291bnQgPSBtYXRjaEFjY291bnQodGV4dCwgb3B0cy5hY2NvdW50cyk7CiAgICBjb25zdCBvbmVMaW5lID0gU3RyaW5nKHRleHQpCiAgICAgIC5yZXBsYWNlKC9ccj9cbi9nLCAnICcpCiAgICAgIC5yZXBsYWNlKC8oPzpbXGRcLV0rXCorfFwqK1tcZFwtXSspW1xkKlwtXSp8XGR7Myx9LVxkezIsfS1cZHszLH0vZywgJyAnKSAvLyDqsIDroKTsp4Qg67KI7Zi4LCDqs4TsoozrsojtmLgKICAgICAgLnJlcGxhY2UoL+yeheq4iHzsnbTssrR87Iah6riIfOuztOuDiOyWtOyalHzrsJvslZjslrTsmpR864uY7JeQ6rKMfOuLmOydtC9nLCAnICcpOwogICAgY29uc3QgeyBpdGVtcyB9ID0gcGFyc2VFeHBlbnNlVGV4dChvbmVMaW5lLCByZWZJU08pOwogICAgY29uc3QgaXRlbSA9IGl0ZW1zWzBdOwogICAgaWYgKCFpdGVtKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGtpbmQgPSBkZXRlY3RLaW5kKHRleHQsIG9wdHMubXlOYW1lKTsKICAgIHJldHVybiB7CiAgICAgIGRhdGU6IGl0ZW0uZGF0ZSwKICAgICAgYW1vdW50OiBraW5kID09PSAnZXhwZW5zZScgPyBpdGVtLmFtb3VudCA6IE1hdGguYWJzKGl0ZW0uYW1vdW50KSwKICAgICAgbWVtbzogaXRlbS5tZW1vLAogICAgICBraW5kLAogICAgICBhY2NvdW50SWQ6IGFjY291bnQgPyBhY2NvdW50LmlkIDogbnVsbCwKICAgICAgYmFsYW5jZTogYmFsYW5jZU1hdGNoID8gTnVtYmVyKGJhbGFuY2VNYXRjaFsxXS5yZXBsYWNlKC8sL2csICcnKSkgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6riw6rCE67OEIOyekOyCsOq0gOumrOqzhO2ajSAtLS0tLS0tLS0tCgogIGNvbnN0IEJBU0VfUExBTl9GUk9NID0gJzAwMDAtMDEtMDEnOwoKICAvLyDtlbTri7kg6riw6rCE7JeQIOyggeyaqeuQmOuKlCDqs4Ttmo06IOyLnOyekeydvOydtCDqt7gg6riw6rCEIOydtOyghOyduCDqs4Ttmo0g7KSRIOqwgOyepSDstZzqt7wg6rKDCiAgZnVuY3Rpb24gcGxhbkZvcihzdGF0ZSwgcGVyaW9kS2V5KSB7CiAgICBjb25zdCBwbGFucyA9IHN0YXRlLnBsYW5zOwogICAgbGV0IGZvdW5kID0gcGxhbnNbMF07CiAgICBmb3IgKGNvbnN0IHAgb2YgcGxhbnMpIGlmIChwLmZyb20gPD0gcGVyaW9kS2V5KSBmb3VuZCA9IHA7CiAgICByZXR1cm4gZm91bmQ7CiAgfQoKICAvLyDrr7jrtoTrpZggPSDsp4DstpzsnbjrjbAg7ZWt66qp7J20IOyXhuqxsOuCmCwg6re4IOuCoOynnOqwgCDsho3tlZwg6riw6rCE7J2YIOqzhO2ajeyXkCDsl4bripQg7ZWt66qp7J24IOqygwogIGZ1bmN0aW9uIGlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSB7CiAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yKHN0YXRlLCBnZXRQZXJpb2QodC5kYXRlLCBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KS5jYXRlZ29yaWVzOwogICAgcmV0dXJuICEodC5jYXRlZ29yeUlkICYmIGNhdHMuc29tZSgoYykgPT4gYy5pZCA9PT0gdC5jYXRlZ29yeUlkKSk7CiAgfQoKICAvLyDquLDqsITrs4Qg66+467aE66WYIOqxtOyImDogW3sgcGVyaW9kLCBjb3VudCwgdG90YWwgfV0g7LWc6re8IOq4sOqwhOu2gO2EsAogIGZ1bmN0aW9uIHVuY2xhc3NpZmllZEJ5UGVyaW9kKHN0YXRlKSB7CiAgICBjb25zdCBieUtleSA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgdCBvZiBzdGF0ZS50cmFuc2FjdGlvbnMpIHsKICAgICAgaWYgKCFpc1VuY2xhc3NpZmllZChzdGF0ZSwgdCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBwID0gZ2V0UGVyaW9kKHQuZGF0ZSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICBpZiAoIWJ5S2V5LmhhcyhwLmtleSkpIGJ5S2V5LnNldChwLmtleSwgeyBwZXJpb2Q6IHAsIGNvdW50OiAwLCB0b3RhbDogMCB9KTsKICAgICAgY29uc3QgZSA9IGJ5S2V5LmdldChwLmtleSk7CiAgICAgIGUuY291bnQgKz0gMTsKICAgICAgZS50b3RhbCArPSB0LmFtb3VudDsKICAgIH0KICAgIHJldHVybiBbLi4uYnlLZXkudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IChhLnBlcmlvZC5rZXkgPCBiLnBlcmlvZC5rZXkgPyAxIDogLTEpKTsKICB9CgogIC8vIOuvuOu2hOulmCDsp4DstpzsnYQg6rCA66e57KCQKOyDgeuMgOuwqSnrs4TroZwg66y264qU64ukLiBwZXJpb2Qg66W8IOyjvOuptCDqt7gg6riw6rCEIOqyg+unjC4g7LWc6re87JeQIOyDneq4tCDrrLbsnYzrtoDthLAuCiAgZnVuY3Rpb24gdW5jbGFzc2lmaWVkR3JvdXBzKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IGJ5S2V5ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCB0IG9mIHN0YXRlLnRyYW5zYWN0aW9ucykgewogICAgICBpZiAocGVyaW9kICYmICh0LmRhdGUgPCBwZXJpb2Quc3RhcnQgfHwgdC5kYXRlID4gcGVyaW9kLmVuZCkpIGNvbnRpbnVlOwogICAgICBpZiAoIWlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSkgY29udGludWU7CiAgICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgfHwgdC5tZW1vOwogICAgICBpZiAoIWJ5S2V5LmhhcyhrZXkpKSBieUtleS5zZXQoa2V5LCB7IGtleSwgbWVtbzogdC5tZW1vLCBpdGVtczogW10sIHRvdGFsOiAwLCBsYXRlc3Q6ICcnIH0pOwogICAgICBjb25zdCBnID0gYnlLZXkuZ2V0KGtleSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgICAgZy50b3RhbCArPSB0LmFtb3VudDsKICAgICAgaWYgKHQuZGF0ZSA+IGcubGF0ZXN0KSBnLmxhdGVzdCA9IHQuZGF0ZTsKICAgIH0KICAgIGNvbnN0IGdyb3VwcyA9IFsuLi5ieUtleS52YWx1ZXMoKV07CiAgICBmb3IgKGNvbnN0IGcgb2YgZ3JvdXBzKSBnLml0ZW1zLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBncm91cHMuc29ydCgoYSwgYikgPT4gKGEubGF0ZXN0IDwgYi5sYXRlc3QgPyAxIDogYS5sYXRlc3QgPiBiLmxhdGVzdCA/IC0xIDogYi50b3RhbCAtIGEudG90YWwpKTsKICAgIHJldHVybiBncm91cHM7CiAgfQoKICAvLyDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDqs4Ttmo3snYQg7IiY7KCV7ZWY66Ck6rOgIO2VoCDrlYwg7Zi47LacLiDsl4bsnLzrqbQg7KeB7KCEIOqzhO2ajeydhCDrs7XsgqztlbTshJwg66eM65Og64ukLgogIGZ1bmN0aW9uIGVuc3VyZVBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSwgbm93SVNPKSB7CiAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLnBsYW5zLmZpbmQoKHApID0+IHAuZnJvbSA9PT0gcGVyaW9kS2V5KTsKICAgIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nOwogICAgY29uc3QgYmFzZSA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSk7CiAgICBjb25zdCBjb3B5ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShiYXNlKSk7CiAgICBjb3B5LmZyb20gPSBwZXJpb2RLZXk7CiAgICBjb3B5LnVwZGF0ZWRBdCA9IG5vd0lTTzsKICAgIHN0YXRlLnBsYW5zLnB1c2goY29weSk7CiAgICBzdGF0ZS5wbGFucy5zb3J0KChhLCBiKSA9PiAoYS5mcm9tIDwgYi5mcm9tID8gLTEgOiBhLmZyb20gPiBiLmZyb20gPyAxIDogMCkpOwogICAgcmV0dXJuIGNvcHk7CiAgfQoKICBmdW5jdGlvbiBuZXh0UGxhbkFmdGVyKHN0YXRlLCBwbGFuKSB7CiAgICByZXR1cm4gc3RhdGUucGxhbnMuZmluZCgocCkgPT4gcC5mcm9tID4gcGxhbi5mcm9tKSB8fCBudWxsOwogIH0KCiAgLy8g7Iuc7J6R7J287J2EIOuwlOq+uOuptCDquLDqsIQg7YKkKOyLnOyekSDrgqDsp5wp66W8IOqwmeydgCDri6zsnZgg7IOIIOyLnOyekeydvOuhnCDsmK7quLTri6QuCiAgZnVuY3Rpb24gcmVtYXBQZXJpb2RLZXlzKHN0YXRlLCBuZXdTdGFydERheSkgewogICAgY29uc3QgbW92ZSA9IChrZXkpID0+IHsKICAgICAgaWYgKGtleSA9PT0gQkFTRV9QTEFOX0ZST00pIHJldHVybiBrZXk7CiAgICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oa2V5KTsKICAgICAgcmV0dXJuIHRvSVNPKHksIG0sIE1hdGgubWluKG5ld1N0YXJ0RGF5LCBkYXlzSW5Nb250aCh5LCBtKSkpOwogICAgfTsKICAgIGNvbnN0IGluY29tZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLmluY29tZXMpKSBpbmNvbWVzW21vdmUoayldID0gdjsKICAgIHN0YXRlLmluY29tZXMgPSBpbmNvbWVzOwogICAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBsYW5zKSBwLmZyb20gPSBtb3ZlKHAuZnJvbSk7CiAgICBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSA9IG5ld1N0YXJ0RGF5OwogIH0KCiAgLy8gLS0tLS0tLS0tLSBBSSDrtoTrpZgg7JqU7LKtIOunjOuTpOq4sCAvIOqysOqzvCDsnb3quLAgLS0tLS0tLS0tLQogIC8vIOyLpOygnCBBUEkg7Zi47Lac7J2AIOyEnOuyhChBcHBzIFNjcmlwdCnsl5DshJwg7ZWc64ukLiDsl6zquLDshJzripQg7ZSE66Gs7ZSE7Yq47JmAIEpTT04g7Iqk7YKk66eI66eMIOunjOuToOuLpC4KCiAgZnVuY3Rpb24gY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCkgewogICAgY29uc3QgZXhhbXBsZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW21lcmNoYW50LCBpZF0gb2YgT2JqZWN0LmVudHJpZXMobWVyY2hhbnRNYXAgfHwge30pKSB7CiAgICAgIChleGFtcGxlc1tpZF0gPSBleGFtcGxlc1tpZF0gfHwgW10pLnB1c2gobWVyY2hhbnQpOwogICAgfQogICAgcmV0dXJuIGNhdGVnb3JpZXMubWFwKChjKSA9PiAoewogICAgICBpZDogYy5pZCwKICAgICAgbmFtZTogYy5uYW1lLAogICAgICBkZXNjcmlwdGlvbjogYy5kZXNjcmlwdGlvbiB8fCAnJywKICAgICAga2V5d29yZHM6IChjLmtleXdvcmRzIHx8IFtdKS5zbGljZSgwLCAyMCksCiAgICAgIGV4YW1wbGVzOiAoZXhhbXBsZXNbYy5pZF0gfHwgW10pLnNsaWNlKC0xMCksCiAgICB9KSk7CiAgfQoKICBjb25zdCBDTEFTU0lGWV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1reyWtCDqsIDqs4TrtoDsnZgg7KeA7LacIOu2hOulmOq4sOyeheuLiOuLpC4nLAogICAgJ+yCrOyaqeyekOqwgCDsoJXtlbQg65GUIOyekOyCsOq0gOumrOqzhO2ajSDtla3rqqkg66qp66Gd7J20IOyjvOyWtOyngOuptCwg6rCBIOyngOy2nOydhCDqsIDsnqUg7JWM66ee7J2AIO2VreuqqSBpZCDtlZjrgpjroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAn7ZWt66qp7J2YIOydtOumhCwg7ISk66qFLCDtgqTsm4zrk5wsIOyCrOyaqeyekOqwgCDsmIjsoITsl5Ag7KeB7KCRIOu2hOulmO2VnCDqsIDrp7nsoJAg7JiI7IucKGV4YW1wbGVzKeulvCDqt7zqsbDroZwg7YyQ64uo7ZWp64uI64ukLicsCiAgICAn6rCA66e57KCQIOydtOumhOunjOycvOuhnCDsl4XsooXsnYQg7LaU66Gg7ZW064+EIOuQqeuLiOuLpC4g7Ja064qQIO2VreuqqeyXkOuPhCDrp57sp4Ag7JWK6rGw64KYIOuPhOyggO2eiCDtjJDri6jtlaAg7IiYIOyXhuycvOuptCAibm9uZSLsnYQg6rOg66W07IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZENsYXNzaWZ5UmVxdWVzdChjYXRlZ29yaWVzLCBpdGVtcywgbWVyY2hhbnRNYXApIHsKICAgIGNvbnN0IGlkcyA9IGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKTsKICAgIGNvbnN0IHVzZXIgPSBKU09OLnN0cmluZ2lmeSh7CiAgICAgIGNhdGVnb3JpZXM6IGNhdGVnb3J5QnJpZWYoY2F0ZWdvcmllcywgbWVyY2hhbnRNYXApLAogICAgICBleHBlbnNlczogaXRlbXMubWFwKChpdCwgaSkgPT4gKHsgaW5kZXg6IGksIG1lcmNoYW50OiBpdC5tZW1vLCBhbW91bnQ6IGl0LmFtb3VudCwgZGF0ZTogaXQuZGF0ZSB9KSksCiAgICB9KTsKICAgIGNvbnN0IHNjaGVtYSA9IHsKICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICByZXN1bHRzOiB7CiAgICAgICAgICB0eXBlOiAnYXJyYXknLAogICAgICAgICAgaXRlbXM6IHsKICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgICAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICAgICAgICBpbmRleDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICAgICAgICBjYXRlZ29yeUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBlbnVtOiBpZHMuY29uY2F0KFsnbm9uZSddKSB9LAogICAgICAgICAgICB9LAogICAgICAgICAgICByZXF1aXJlZDogWydpbmRleCcsICdjYXRlZ29yeUlkJ10sCiAgICAgICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSwKICAgICAgICAgIH0sCiAgICAgICAgfSwKICAgICAgfSwKICAgICAgcmVxdWlyZWQ6IFsncmVzdWx0cyddLAogICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsCiAgICB9OwogICAgcmV0dXJuIHsgc3lzdGVtOiBDTEFTU0lGWV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiBpdGVtcyDsmYAg6rCZ7J2AIOq4uOydtOydmCBjYXRlZ29yeUlkIOuwsOyXtCAo7JWMIOyImCDsl4bsnLzrqbQgbnVsbCkKICBmdW5jdGlvbiByZWFkQ2xhc3NpZnlSZXNwb25zZShqc29uLCBjYXRlZ29yaWVzLCBjb3VudCkgewogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBvdXQgPSBuZXcgQXJyYXkoY291bnQpLmZpbGwobnVsbCk7CiAgICBmb3IgKGNvbnN0IHIgb2YgKGpzb24gJiYganNvbi5yZXN1bHRzKSB8fCBbXSkgewogICAgICBpZiAoTnVtYmVyLmlzSW50ZWdlcihyLmluZGV4KSAmJiByLmluZGV4ID49IDAgJiYgci5pbmRleCA8IGNvdW50ICYmIGtub3duLmhhcyhyLmNhdGVnb3J5SWQpKSB7CiAgICAgICAgb3V0W3IuaW5kZXhdID0gci5jYXRlZ29yeUlkOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgTUVTU0FHRV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1rSDsubTrk5zsgqzCt+ydgO2WieydmCDqsrDsoJwv7J6F7Lac6riIIOyVjOumvCjrrLjsnpAg65iQ64qUIOyVsSDslYzrprwp7J2EIOydveyWtCDqsIDqs4TrtoDsl5Ag6riw66Gd7ZWY64qUIOuPhOyasOuvuOyeheuLiOuLpC4nLAogICAgJ+yVjOumvOyXkOyEnCDqsbDrnpgg7KKF66WYLCDrgqDsp5wsIOq4iOyVoSjsm5ApLCDqsIDrp7nsoJAg65iQ64qUIOyDgeuMgOuwqSDsnbTrpoQsIOyelOyVoeydhCDrvZHqs6AsIOyngOy2nOydtOuptCDsgqzsmqnsnpDsnZgg7J6Q7IKw6rSA66as6rOE7ZqNIO2VreuqqSDspJEg7JWM66ee7J2AIO2VreuqqSBpZCDroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAnJywKICAgICdraW5kIOq3nOy5mTonLAogICAgJy0gZXhwZW5zZTog7Lm065OcIOqysOygnCwg6rOE7KKM7JeQ7IScIOuLpOuluCDsgqzrnozCt+qwgOqyjOuhnCDrs7Trgrgg7Lac6riIL+ydtOyytCwg7J6Q64+Z7J207LK0LCDqs7Xqs7zquIgnLAogICAgJy0gaW5jb21lOiDri6Trpbgg7IKs656M7J2064KYIO2ajOyCrOyXkOyEnCDrk6TslrTsmKgg7J6F6riIICjquInsl6wsIO2ZmOq4iSDrk7EpJywKICAgICctIG93bl90cmFuc2Zlcjog7IKs7Jqp7J6QIOuzuOyduCDqs4Tsoozrgbzrpqwg7Jiu6ri0IOuPiC4g7IOB64yA67CpIOydtOumhOydtCDsgqzsmqnsnpAg7J2066aEKG15X25hbWUp6rO8IOqwmeqxsOuCmCwg7JWM66a87J2YIOyDgeuMgCDqs4TsoozqsIAg7IKs7Jqp7J6Q7J2YIOuTseuhnSDqs4TsoowoYWNjb3VudHMp7J2066m0IO2VtOuLue2VqeuLiOuLpC4nLAogICAgJy0gbm90X3RyYW5zYWN0aW9uOiDsnbjspp3rsojtmLgsIOq0keqzoCwg7JWI64K0IOuTsSDqsbDrnpjqsIAg7JWE64uMIOyVjOumvCcsCiAgICAnJywKICAgICctIOuzuOyduCDqs4TsoozroZwg7Jiu6ri0IOuPiOydtCDsoIDstpUg6rOE7KKMKGlzU2F2aW5ncynrgpgg7KCB6riIwrfssq3slb3Ct+ymneq2jCDqs4TsoozroZwg65Ok7Ja06rCA64qUIOy2nOq4iOydtOuptCB0b19zYXZpbmdzIOulvCB0cnVlIOuhnCDtlZjqs6AgY2F0ZWdvcnlJZCDrpbwg7KCA7LaVIOyEseqyqeydmCDtla3rqqnsnLzroZwg6rOg66W07IS47JqULiDqt7gg67CW7JeQ64qUIGZhbHNlLicsCiAgICAnLSDriITsoIEg6riI7JWhLCDtlZzrj4QsIOy5tOuTnMK36rOE7KKMIOuyiO2YuCwg7Iq57J2467KI7Zi464qUIOqxsOuemCDquIjslaHsnbQg7JWE64uZ64uI64ukLiDsnpTslaHsnbQg7KCB7ZiAIOyeiOycvOuptCBiYWxhbmNlIOyXkCwg7JeG7Jy866m0IC0xLicsCiAgICAnLSBhY2NvdW50X2xhc3Q0OiDsnbQg7JWM66a87J20IOyWtOuKkCDrk7HroZ0g6rOE7KKML+y5tOuTnOyXkOyEnCDsnbzslrTrgpwg6rGw656Y7J247KeAIOq3uCDrgZ0gNOyekOumrC4g66qo66W066m0IOu5iCDrrLjsnpDsl7QuJywKICAgICctIOyKueyduOy3qOyGjC/tmZjrtojsnbTrqbQgaXNfY2FuY2VsIOydhCB0cnVlIOuhnCDtlZjshLjsmpQuJywKICAgICctIGRhdGUg64qUIFlZWVktTU0tREQuIOyXsOuPhOqwgCDsl4bsnLzrqbQg7Jik64qYKHRvZGF5KSDquLDspIAg6rCA7J6lIOqwgOq5jOyatCDqs7zqsbAg64Kg7KecLCDrgqDsp5zqsIAg7JeG7Jy866m0IHRvZGF5LicsCiAgICAnLSDsp4DstpzsnbQg7JWE64uI6rGw64KYIOyVjOunnuydgCDtla3rqqnsnbQg7JeG7Jy866m0IGNhdGVnb3J5SWQg66W8ICJub25lIiDsnLzroZwg7ZWY7IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZE1lc3NhZ2VSZXF1ZXN0KGNhdGVnb3JpZXMsIHRleHQsIHRvZGF5SVNPLCBtZXJjaGFudE1hcCwgb3B0cyA9IHt9KSB7CiAgICBjb25zdCBpZHMgPSBjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCk7CiAgICBjb25zdCB1c2VyID0gSlNPTi5zdHJpbmdpZnkoewogICAgICB0b2RheTogdG9kYXlJU08sCiAgICAgIG15X25hbWU6IG9wdHMubXlOYW1lIHx8ICcnLAogICAgICBhY2NvdW50czogKG9wdHMuYWNjb3VudHMgfHwgW10pLm1hcCgoYSkgPT4gKHsgbmFtZTogYS5uYW1lLCB0eXBlOiBhLnR5cGUsIGxhc3Q0OiBkaWdpdHNPbmx5KGEubGFzdDQpLnNsaWNlKC00KSwgaXNTYXZpbmdzOiAhIWEuaXNTYXZpbmdzIH0pKSwKICAgICAgY2F0ZWdvcmllczogY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCksCiAgICAgIG1lc3NhZ2U6IFN0cmluZyh0ZXh0KSwKICAgIH0pOwogICAgY29uc3Qgc2NoZW1hID0gewogICAgICB0eXBlOiAnb2JqZWN0JywKICAgICAgcHJvcGVydGllczogewogICAgICAgIGtpbmQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IFsnZXhwZW5zZScsICdpbmNvbWUnLCAnb3duX3RyYW5zZmVyJywgJ25vdF90cmFuc2FjdGlvbiddIH0sCiAgICAgICAgaXNfY2FuY2VsOiB7IHR5cGU6ICdib29sZWFuJyB9LAogICAgICAgIHRvX3NhdmluZ3M6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sCiAgICAgICAgZGF0ZTogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFtb3VudDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICBtZXJjaGFudDogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFjY291bnRfbGFzdDQ6IHsgdHlwZTogJ3N0cmluZycgfSwKICAgICAgICBiYWxhbmNlOiB7IHR5cGU6ICdpbnRlZ2VyJyB9LAogICAgICAgIGNhdGVnb3J5SWQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IGlkcy5jb25jYXQoWydub25lJ10pIH0sCiAgICAgIH0sCiAgICAgIHJlcXVpcmVkOiBbJ2tpbmQnLCAnaXNfY2FuY2VsJywgJ3RvX3NhdmluZ3MnLCAnZGF0ZScsICdhbW91bnQnLCAnbWVyY2hhbnQnLCAnYWNjb3VudF9sYXN0NCcsICdiYWxhbmNlJywgJ2NhdGVnb3J5SWQnXSwKICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLAogICAgfTsKICAgIHJldHVybiB7IHN5c3RlbTogTUVTU0FHRV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiB7IGRhdGUsIGFtb3VudCwgbWVtbywga2luZCwgY2F0ZWdvcnlJZCwgYWNjb3VudElkLCBiYWxhbmNlIH0g65iQ64qUIG51bGwo6rGw656YIOyVhOuLmCkKICBmdW5jdGlvbiByZWFkTWVzc2FnZVJlc3BvbnNlKGpzb24sIGNhdGVnb3JpZXMsIHRvZGF5SVNPLCBhY2NvdW50cykgewogICAgaWYgKCFqc29uIHx8ICFqc29uLmtpbmQgfHwganNvbi5raW5kID09PSAnbm90X3RyYW5zYWN0aW9uJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhbW91bnRBYnMgPSBNYXRoLmFicyhNYXRoLnJvdW5kKE51bWJlcihqc29uLmFtb3VudCkgfHwgMCkpOwogICAgaWYgKCFhbW91bnRBYnMpIHJldHVybiBudWxsOwogICAgbGV0IGRhdGUgPSBTdHJpbmcoanNvbi5kYXRlIHx8ICcnKTsKICAgIGlmICghL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSkpIGRhdGUgPSB0b2RheUlTTzsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCkpOwogICAgY29uc3QgY2F0ZWdvcnlJZCA9IGtub3duLmhhcyhqc29uLmNhdGVnb3J5SWQpID8ganNvbi5jYXRlZ29yeUlkIDogbnVsbDsKICAgIGNvbnN0IGFjY291bnQgPSBhY2NvdW50QnlMYXN0NChqc29uLmFjY291bnRfbGFzdDQsIGFjY291bnRzKTsKCiAgICBsZXQga2luZCA9ICdleHBlbnNlJzsKICAgIGlmIChqc29uLmtpbmQgPT09ICdpbmNvbWUnKSBraW5kID0gJ2luY29tZSc7CiAgICBlbHNlIGlmIChqc29uLmtpbmQgPT09ICdvd25fdHJhbnNmZXInICYmICFqc29uLnRvX3NhdmluZ3MpIGtpbmQgPSAndHJhbnNmZXInOwoKICAgIHJldHVybiB7CiAgICAgIGRhdGUsCiAgICAgIGFtb3VudDoga2luZCA9PT0gJ2V4cGVuc2UnICYmIGpzb24uaXNfY2FuY2VsID8gLWFtb3VudEFicyA6IGFtb3VudEFicywKICAgICAgbWVtbzogU3RyaW5nKGpzb24ubWVyY2hhbnQgfHwgJycpLnRyaW0oKSB8fCAnKOuCtOyaqSDsl4bsnYwpJywKICAgICAga2luZCwKICAgICAgY2F0ZWdvcnlJZDoga2luZCA9PT0gJ2V4cGVuc2UnID8gY2F0ZWdvcnlJZCA6IG51bGwsCiAgICAgIGFjY291bnRJZDogYWNjb3VudCA/IGFjY291bnQuaWQgOiBudWxsLAogICAgICBiYWxhbmNlOiBOdW1iZXIuaXNJbnRlZ2VyKGpzb24uYmFsYW5jZSkgJiYganNvbi5iYWxhbmNlID49IDAgPyBqc29uLmJhbGFuY2UgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J2A7ZaJIOqxsOuemOuCtOyXrSDtjIzsnbwgKOyXkeyFgC9DU1YpIC0tLS0tLS0tLS0KICAvLyDsnYDtlonrp4jri6Qg7ZWt66qpIOydtOumhOydtCDri6zrnbzshJwsIOuouOumrOq4gCjssqsg7KSEKeydmCDsnbTrpoTsnYQg67O06rOgIOy5uOydhCDssL7ripTri6QuCgogIGNvbnN0IENPTFVNTl9ISU5UUyA9IFsKICAgIFsnZGF0ZScsIC/qsbDrnphccyrsnbzsi5x86rGw656YXHMq7J287J6QfOqxsOuemFxzKuuCoOynnHxe7J287IucJHxe64Kg7KecJHxe7J287J6QJHxe6rGw656Y7J28JC9dLAogICAgWyd0aW1lJywgL17si5zqsIQkfOqxsOuemFxzKuyLnOqwhHxe7Iuc6rCBJC9dLAogICAgWydjYXRlZ29yeScsIC/qsbDrnphccyrqtazrtoR86rGw656YXHMq7Jyg7ZiVfOqxsOuemFxzKuyiheulmC9dLAogICAgWyd0eXBlJywgL17qtazrtoQkfOyehey2nOq4iFxzKuq1rOu2hHzsnoVccypcL1xzKuy2nOq4iHxe7J6F7Lac6riIJC9dLAogICAgWydvdXQnLCAv7Lac6riIXHMqKOyVoXzquIjslaEpPyR87LC+7Jy87IugXHMq6riI7JWhfOyngOq4iVxzKijslaF86riI7JWhKT8kL10sCiAgICBbJ2luJywgL+yeheq4iFxzKijslaF86riI7JWhKT8kfOunoeq4sOyLoFxzKuq4iOyVoS9dLAogICAgWydhbW91bnQnLCAv6rGw656YXHMq6riI7JWhfF7quIjslaEkL10sCiAgICBbJ2JhbGFuY2UnLCAv7J6U7JWhL10sCiAgICBbJ21lbW8nLCAvXuuCtOyaqSR86rGw656YXHMq64K07JqpfOyggeyalHzrsJvripRccyrrtoR867O064K4XHMq67aEfOqxsOuemOyymHzquLDsnqxccyrrgrTsmql87IOB64yAL10sCiAgICBbJ25vdGUnLCAvXuuplOuqqCQvXSwKICBdOwoKICBmdW5jdGlvbiBjZWxsVGV4dCh2KSB7CiAgICByZXR1cm4gdiA9PT0gbnVsbCB8fCB2ID09PSB1bmRlZmluZWQgPyAnJyA6IFN0cmluZyh2KS50cmltKCk7CiAgfQoKICBmdW5jdGlvbiBmaW5kSGVhZGVyKHJvd3MpIHsKICAgIGZvciAobGV0IHIgPSAwOyByIDwgTWF0aC5taW4ocm93cy5sZW5ndGgsIDMwKTsgcisrKSB7CiAgICAgIGNvbnN0IGNvbHMgPSB7fTsKICAgICAgKHJvd3Nbcl0gfHwgW10pLmZvckVhY2goKGNlbGwsIGMpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gY2VsbFRleHQoY2VsbCkucmVwbGFjZSgvXHMrL2csICcgJyk7CiAgICAgICAgaWYgKCFuYW1lKSByZXR1cm47CiAgICAgICAgZm9yIChjb25zdCBba2V5LCByZV0gb2YgQ09MVU1OX0hJTlRTKSB7CiAgICAgICAgICBpZiAoY29sc1trZXldID09PSB1bmRlZmluZWQgJiYgcmUudGVzdChuYW1lKSkgewogICAgICAgICAgICBjb2xzW2tleV0gPSBjOwogICAgICAgICAgICBicmVhazsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0pOwogICAgICBpZiAoY29scy5kYXRlICE9PSB1bmRlZmluZWQgJiYgKGNvbHMuYW1vdW50ICE9PSB1bmRlZmluZWQgfHwgY29scy5vdXQgIT09IHVuZGVmaW5lZCB8fCBjb2xzLmluICE9PSB1bmRlZmluZWQpKSByZXR1cm4geyByb3c6IHIsIGNvbHMgfTsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgLy8g7JeR7IWAIOuCoOynnCDsnbzroKjrsojtmLgoNDU5Mjgg65OxKSDrmJDripQgIjIwMjYuMDkuMjggMTQ6MDIiIOqwmeydgCDquIDsnpAg4oaSIHsgZGF0ZSwgdGltZSB9CiAgZnVuY3Rpb24gcGFyc2VEYXRlQ2VsbCh2KSB7CiAgICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInICYmIHYgPiAyMDAwMCAmJiB2IDwgODAwMDApIHsKICAgICAgY29uc3QgbXMgPSBNYXRoLnJvdW5kKCh2IC0gMjU1NjkpICogODY0MDAwMDApOwogICAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgICByZXR1cm4gewogICAgICAgIGRhdGU6IHRvSVNPKGQuZ2V0VVRDRnVsbFllYXIoKSwgZC5nZXRVVENNb250aCgpICsgMSwgZC5nZXRVVENEYXRlKCkpLAogICAgICAgIHRpbWU6IE51bWJlci5pc0ludGVnZXIodikgPyAnJyA6IGAke3BhZChkLmdldFVUQ0hvdXJzKCkpfToke3BhZChkLmdldFVUQ01pbnV0ZXMoKSl9OiR7cGFkKGQuZ2V0VVRDU2Vjb25kcygpKX1gLAogICAgICB9OwogICAgfQogICAgY29uc3QgcyA9IGNlbGxUZXh0KHYpOwogICAgY29uc3QgbSA9IHMubWF0Y2goLyhcZHs0fSlccypbLlwtL+uFhF1ccyooXGR7MSwyfSlccypbLlwtL+yblF1ccyooXGR7MSwyfSkvKTsKICAgIGlmICghbSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBbeSwgbW8sIGRdID0gW051bWJlcihtWzFdKSwgTnVtYmVyKG1bMl0pLCBOdW1iZXIobVszXSldOwogICAgaWYgKCF2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHQgPSBzLnNsaWNlKG0uaW5kZXggKyBtWzBdLmxlbmd0aCkubWF0Y2goLyhcZHsxLDJ9KTooXGR7Mn0pKD86OihcZHsyfSkpPy8pOwogICAgcmV0dXJuIHsgZGF0ZTogdG9JU08oeSwgbW8sIGQpLCB0aW1lOiB0ID8gYCR7cGFkKHRbMV0pfToke3RbMl19OiR7dFszXSB8fCAnMDAnfWAgOiAnJyB9OwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRDZWxsKHYpIHsKICAgIGlmICh0eXBlb2YgdiA9PT0gJ251bWJlcicpIHJldHVybiB2OwogICAgbGV0IHMgPSBjZWxsVGV4dCh2KS5yZXBsYWNlKC9bLFxz7JuQXS9nLCAnJyk7CiAgICBpZiAoIXMpIHJldHVybiBudWxsOwogICAgbGV0IG5lZyA9IGZhbHNlOwogICAgaWYgKC9eXCguKlwpJC8udGVzdChzKSkgewogICAgICBuZWcgPSB0cnVlOwogICAgICBzID0gcy5zbGljZSgxLCAtMSk7CiAgICB9CiAgICBjb25zdCBuID0gTnVtYmVyKHMpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikpIHJldHVybiBudWxsOwogICAgcmV0dXJuIG5lZyA/IC1uIDogbjsKICB9CgogIC8qCiAgICog6rGw656Y64K07JetIO2RnCgy7LCo7JuQIOuwsOyXtCnrpbwg64K07Jet7Jy866GcIOuwlOq+vOuLpC4KICAgKiBvcHRzOiB7IG15TmFtZSwgYWNjb3VudElkIH0KICAgKiDrsJjtmZg6IHsgaXRlbXM6IFt7ZGF0ZSwgdGltZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGJhbGFuY2UsIHJhd31dLCBza2lwcGVkLCBoZWFkZXIsIGxhdGVzdDoge2RhdGUsIHRpbWUsIGJhbGFuY2V9IHwgbnVsbCB9CiAgICovCiAgZnVuY3Rpb24gcGFyc2VTdGF0ZW1lbnRSb3dzKHJvd3MsIG9wdHMgPSB7fSkgewogICAgY29uc3QgaGVhZGVyID0gZmluZEhlYWRlcihyb3dzKTsKICAgIGlmICghaGVhZGVyKSByZXR1cm4geyBpdGVtczogW10sIHNraXBwZWQ6IDAsIGhlYWRlcjogbnVsbCwgbGF0ZXN0OiBudWxsIH07CiAgICBjb25zdCB7IGNvbHMgfSA9IGhlYWRlcjsKICAgIGNvbnN0IGdldCA9IChyb3csIGtleSkgPT4gKGNvbHNba2V5XSA9PT0gdW5kZWZpbmVkID8gJycgOiByb3dbY29sc1trZXldXSk7CiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgbGV0IHNraXBwZWQgPSAwOwogICAgbGV0IGxhdGVzdCA9IG51bGw7CiAgICAvLyDquIjslaEg7ZWcIOy5uOyXkCDstpzquIjsnYAg7J2M7IiY66GcIOyggeuKlCDtjIzsnbzsnbjsp4AgKOq3uOugh+uLpOuptCDslpHsiJjripQg7J6F6riIKQogICAgY29uc3Qgc2lnbmVkID0gY29scy5hbW91bnQgIT09IHVuZGVmaW5lZCAmJiByb3dzLnNsaWNlKGhlYWRlci5yb3cgKyAxKS5zb21lKChyb3cpID0+IChwYXJzZUFtb3VudENlbGwoKHJvdyB8fCBbXSlbY29scy5hbW91bnRdKSB8fCAwKSA8IDApOwoKICAgIGZvciAobGV0IHIgPSBoZWFkZXIucm93ICsgMTsgciA8IHJvd3MubGVuZ3RoOyByKyspIHsKICAgICAgY29uc3Qgcm93ID0gcm93c1tyXSB8fCBbXTsKICAgICAgaWYgKCFyb3cuc29tZSgoYykgPT4gY2VsbFRleHQoYykpKSBjb250aW51ZTsKICAgICAgY29uc3Qgd2hlbiA9IHBhcnNlRGF0ZUNlbGwoZ2V0KHJvdywgJ2RhdGUnKSk7CiAgICAgIGlmICghd2hlbikgewogICAgICAgIHNraXBwZWQgKz0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoIXdoZW4udGltZSAmJiBjb2xzLnRpbWUgIT09IHVuZGVmaW5lZCkgewogICAgICAgIGNvbnN0IHQgPSBjZWxsVGV4dChnZXQocm93LCAndGltZScpKS5tYXRjaCgvKFxkezEsMn0pOihcZHsyfSkoPzo6KFxkezJ9KSk/Lyk7CiAgICAgICAgaWYgKHQpIHdoZW4udGltZSA9IGAke3BhZCh0WzFdKX06JHt0WzJdfToke3RbM10gfHwgJzAwJ31gOwogICAgICB9CgogICAgICBjb25zdCB0eXBlVGV4dCA9IGNlbGxUZXh0KGdldChyb3csICd0eXBlJykpOwogICAgICBjb25zdCBjYXRlZ29yeVRleHQgPSBjZWxsVGV4dChnZXQocm93LCAnY2F0ZWdvcnknKSk7CiAgICAgIGNvbnN0IG91dCA9IHBhcnNlQW1vdW50Q2VsbChnZXQocm93LCAnb3V0JykpOwogICAgICBjb25zdCBpbm4gPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2luJykpOwogICAgICBjb25zdCBhbXQgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2Ftb3VudCcpKTsKCiAgICAgIGxldCBraW5kOwogICAgICBsZXQgYW1vdW50OwogICAgICBpZiAob3V0KSB7CiAgICAgICAga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBhbW91bnQgPSBNYXRoLmFicyhvdXQpOwogICAgICB9IGVsc2UgaWYgKGlubikgewogICAgICAgIGtpbmQgPSAnaW5jb21lJzsKICAgICAgICBhbW91bnQgPSBNYXRoLmFicyhpbm4pOwogICAgICB9IGVsc2UgaWYgKGFtdCkgewogICAgICAgIGFtb3VudCA9IE1hdGguYWJzKGFtdCk7CiAgICAgICAgaWYgKC/snoXquIgvLnRlc3QodHlwZVRleHQpKSBraW5kID0gJ2luY29tZSc7CiAgICAgICAgZWxzZSBpZiAoL+y2nOq4iHzsp4DquIkvLnRlc3QodHlwZVRleHQpKSBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGVsc2UgaWYgKGFtdCA8IDApIGtpbmQgPSAnZXhwZW5zZSc7CiAgICAgICAgZWxzZSBraW5kID0gc2lnbmVkID8gJ2luY29tZScgOiAnZXhwZW5zZSc7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2tpcHBlZCArPSAxOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICBjb25zdCBtZW1vTWFpbiA9IGNlbGxUZXh0KGdldChyb3csICdtZW1vJykpOwogICAgICBjb25zdCBub3RlID0gY2VsbFRleHQoZ2V0KHJvdywgJ25vdGUnKSk7CiAgICAgIGNvbnN0IG1lbW8gPSBtZW1vTWFpbiB8fCBub3RlIHx8IGNhdGVnb3J5VGV4dCB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgICAgY29uc3QgYWxsVGV4dCA9IGAke3R5cGVUZXh0fSAke2NhdGVnb3J5VGV4dH0gJHttZW1vfSAke25vdGV9YDsKCiAgICAgIC8vIOy5tOuTnCDqsrDsoJwg7Leo7IaMwrftmZjrtojroZwg65Ok7Ja07JioIOuPiOydgCDsp4DstpzsnYQg7KSE7J2064qUIOqyg+ycvOuhnCDrs7jri6QKICAgICAgaWYgKGtpbmQgPT09ICdpbmNvbWUnICYmIC/st6jshox87ZmY67aILy50ZXN0KGFsbFRleHQpKSB7CiAgICAgICAga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBhbW91bnQgPSAtYW1vdW50OwogICAgICB9CiAgICAgIGlmIChvcHRzLm15TmFtZSAmJiBtZW1vLmluY2x1ZGVzKG9wdHMubXlOYW1lKSAmJiAhL+y5tOuTnHzqsrDsoJx87Iq57J24Ly50ZXN0KGFsbFRleHQpKSBraW5kID0gJ3RyYW5zZmVyJzsKCiAgICAgIGNvbnN0IGJhbGFuY2UgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2JhbGFuY2UnKSk7CiAgICAgIGNvbnN0IGl0ZW0gPSB7CiAgICAgICAgZGF0ZTogd2hlbi5kYXRlLAogICAgICAgIHRpbWU6IHdoZW4udGltZSwKICAgICAgICBhbW91bnQsCiAgICAgICAgbWVtbywKICAgICAgICBraW5kLAogICAgICAgIGFjY291bnRJZDogb3B0cy5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICBiYWxhbmNlOiBOdW1iZXIuaXNGaW5pdGUoYmFsYW5jZSkgPyBiYWxhbmNlIDogbnVsbCwKICAgICAgICByYXc6IHJvdy5tYXAoY2VsbFRleHQpLmZpbHRlcihCb29sZWFuKS5qb2luKCcgfCAnKS5zbGljZSgwLCAzMDApLAogICAgICB9OwogICAgICBpdGVtcy5wdXNoKGl0ZW0pOwogICAgICBpZiAoaXRlbS5iYWxhbmNlICE9PSBudWxsKSB7CiAgICAgICAgY29uc3Qga2V5ID0gYCR7aXRlbS5kYXRlfSAke2l0ZW0udGltZX1gOwogICAgICAgIGlmICghbGF0ZXN0IHx8IGtleSA+PSBgJHtsYXRlc3QuZGF0ZX0gJHtsYXRlc3QudGltZX1gKSBsYXRlc3QgPSB7IGRhdGU6IGl0ZW0uZGF0ZSwgdGltZTogaXRlbS50aW1lLCBiYWxhbmNlOiBpdGVtLmJhbGFuY2UgfTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQsIGhlYWRlciwgbGF0ZXN0IH07CiAgfQoKICAvLyBDU1Yg6riA7J6QIOKGkiAy7LCo7JuQIOuwsOyXtCAo65Sw7Ji07ZGcIOyViOydmCDsibztkZzCt+ykhOuwlOq/iCDsspjrpqwpCiAgZnVuY3Rpb24gcGFyc2VDU1YodGV4dCkgewogICAgY29uc3Qgcm93cyA9IFtdOwogICAgbGV0IHJvdyA9IFtdOwogICAgbGV0IGNlbGwgPSAnJzsKICAgIGxldCBxdW90ZWQgPSBmYWxzZTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXlx1RkVGRi8sICcnKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7IGkrKykgewogICAgICBjb25zdCBjaCA9IHNbaV07CiAgICAgIGlmIChxdW90ZWQpIHsKICAgICAgICBpZiAoY2ggPT09ICciJyAmJiBzW2kgKyAxXSA9PT0gJyInKSB7CiAgICAgICAgICBjZWxsICs9ICciJzsKICAgICAgICAgIGkgKz0gMTsKICAgICAgICB9IGVsc2UgaWYgKGNoID09PSAnIicpIHF1b3RlZCA9IGZhbHNlOwogICAgICAgIGVsc2UgY2VsbCArPSBjaDsKICAgICAgfSBlbHNlIGlmIChjaCA9PT0gJyInKSBxdW90ZWQgPSB0cnVlOwogICAgICBlbHNlIGlmIChjaCA9PT0gJywnIHx8IGNoID09PSAnXHQnKSB7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgaWYgKGNoID09PSAnXG4nIHx8IGNoID09PSAnXHInKSB7CiAgICAgICAgaWYgKGNoID09PSAnXHInICYmIHNbaSArIDFdID09PSAnXG4nKSBpICs9IDE7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgcm93cy5wdXNoKHJvdyk7CiAgICAgICAgcm93ID0gW107CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgY2VsbCArPSBjaDsKICAgIH0KICAgIGlmIChjZWxsIHx8IHJvdy5sZW5ndGgpIHsKICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgIHJvd3MucHVzaChyb3cpOwogICAgfQogICAgcmV0dXJuIHJvd3M7CiAgfQoKICAvLyDslYzrprzsnLzroZwg7J2066+4IOuTpOyWtOyYqCDrgrTsl63snbjsp4A6IOygle2Zle2eiCDqsJnqsbDrgpgsIOqwmeydgCDrgqDCt+qwmeydgCDquIjslaHCt+qwmeydgCDsooXrpZjsnbTrqbTshJwg7IKs7Jqp7LKY6rCAIOqyuey5mOqxsOuCmCDqsJnsnYAg6rOE7KKMCiAgZnVuY3Rpb24gZmluZER1cGxpY2F0ZShpdGVtLCB0cmFuc2FjdGlvbnMpIHsKICAgIGNvbnN0IG1lbW8gPSBub3JtYWxpemVNZXJjaGFudChpdGVtLm1lbW8pOwogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5maW5kKCh0KSA9PiB7CiAgICAgIGlmICh0LmRhdGUgIT09IGl0ZW0uZGF0ZSB8fCBNYXRoLmFicyh0LmFtb3VudCkgIT09IE1hdGguYWJzKGl0ZW0uYW1vdW50KSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAoa2luZE9mKHQpICE9PSBraW5kT2YoaXRlbSkpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgdG0gPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBpZiAodG0gPT09IG1lbW8gfHwgKHRtICYmIG1lbW8gJiYgKHRtLmluY2x1ZGVzKG1lbW8pIHx8IG1lbW8uaW5jbHVkZXModG0pKSkpIHJldHVybiB0cnVlOwogICAgICByZXR1cm4gISEoaXRlbS5hY2NvdW50SWQgJiYgdC5hY2NvdW50SWQgPT09IGl0ZW0uYWNjb3VudElkKTsKICAgIH0pIHx8IG51bGw7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOumrO2PrO2KuCAtLS0tLS0tLS0tCgogIC8vIO2VreuqqeuzhCDsp4DstpwgKOunjuydtCDsk7Qg7IicKS4g7IOJ7J2AIOqzhO2ajSDslYjsnZgg7Iic7IScKGNvbG9ySW5kZXgp66GcIOygle2VtCDsiJzsnITqsIAg67CU64CM7Ja064+EIOqwmeydgCDtla3rqqnsnYAg6rCZ7J2AIOyDiS4KICBmdW5jdGlvbiBjYXRlZ29yeUJyZWFrZG93bihzdW1tYXJ5KSB7CiAgICBjb25zdCByb3dzID0gc3VtbWFyeS5yb3dzLm1hcCgociwgaSkgPT4gKHsgaWQ6IHIuY2F0ZWdvcnkuaWQsIG5hbWU6IHIuY2F0ZWdvcnkubmFtZSwgYW1vdW50OiByLnNwZW50LCBjb3VudDogci5jb3VudCwgY29sb3JJbmRleDogaSB9KSk7CiAgICBpZiAoc3VtbWFyeS51bmNsYXNzaWZpZWQpIHJvd3MucHVzaCh7IGlkOiAnX19ub25lJywgbmFtZTogJ+uvuOu2hOulmCcsIGFtb3VudDogc3VtbWFyeS51bmNsYXNzaWZpZWQsIGNvdW50OiBzdW1tYXJ5LnVuY2xhc3NpZmllZENvdW50LCBjb2xvckluZGV4OiAtMSB9KTsKICAgIGNvbnN0IHRvdGFsID0gcm93cy5yZWR1Y2UoKHMsIHIpID0+IHMgKyBNYXRoLm1heCgwLCByLmFtb3VudCksIDApOwogICAgcmV0dXJuIHJvd3MKICAgICAgLmZpbHRlcigocikgPT4gci5hbW91bnQgPiAwKQogICAgICAubWFwKChyKSA9PiAoeyAuLi5yLCBzaGFyZTogdG90YWwgPyByLmFtb3VudCAvIHRvdGFsIDogMCB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYW1vdW50IC0gYS5hbW91bnQpOwogIH0KCiAgLy8g7J2067KIIOq4sOqwhOqzvCDsp4HsoIQg6riw6rCE7J2YIO2VreuqqeuzhCDruYTqtZAgKOydtOuyiCDquLDqsIQg6rOE7ZqN7J2YIO2VreuqqSDquLDspIAsIOqwmeydgCBpZCDrgbzrpqwpCiAgZnVuY3Rpb24gY29tcGFyZVdpdGhQcmV2aW91cyhzdGF0ZSwgcGVyaW9kKSB7CiAgICBjb25zdCBjdXIgPSBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCk7CiAgICBjb25zdCBwcmV2UGVyaW9kID0gc2hpZnRQZXJpb2QocGVyaW9kLCAtMSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgY29uc3QgcHJldiA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcHJldlBlcmlvZCk7CiAgICBjb25zdCBwcmV2U3BlbnQgPSB7fTsKICAgIGZvciAoY29uc3QgciBvZiBwcmV2LnJvd3MpIHByZXZTcGVudFtyLmNhdGVnb3J5LmlkXSA9IHIuc3BlbnQ7CiAgICBjb25zdCByb3dzID0gY3VyLnJvd3MubWFwKChyKSA9PiAoewogICAgICBpZDogci5jYXRlZ29yeS5pZCwKICAgICAgbmFtZTogci5jYXRlZ29yeS5uYW1lLAogICAgICBjdXJyZW50OiByLnNwZW50LAogICAgICBwcmV2aW91czogcHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDAsCiAgICAgIGRpZmY6IHIuc3BlbnQgLSAocHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDApLAogICAgfSkpOwogICAgcmV0dXJuIHsgY3VycmVudDogY3VyLCBwcmV2aW91czogcHJldiwgcm93cywgdG90YWxEaWZmOiBjdXIudG90YWxTcGVudCAtIHByZXYudG90YWxTcGVudCB9OwogIH0KCiAgZnVuY3Rpb24gdG9wTWVyY2hhbnRzKHR4cywgbiA9IDUpIHsKICAgIGNvbnN0IG1hcCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIGNvbnRpbnVlOwogICAgICBjb25zdCBrZXkgPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBjb25zdCBtID0gKG1hcFtrZXldID0gbWFwW2tleV0gfHwgeyBtZW1vOiB0Lm1lbW8sIHRvdGFsOiAwLCBjb3VudDogMCB9KTsKICAgICAgbS50b3RhbCArPSB0LmFtb3VudDsKICAgICAgbS5jb3VudCArPSAxOwogICAgfQogICAgcmV0dXJuIE9iamVjdC52YWx1ZXMobWFwKS5zb3J0KChhLCBiKSA9PiBiLnRvdGFsIC0gYS50b3RhbCkuc2xpY2UoMCwgbik7CiAgfQoKICAvLyDstZzqt7wgbiDqsJwg6riw6rCEICjsmKTrnpjrkJwg6rKD67aA7YSwKTog7JiI7IKw7Jy866GcIOyeheugpe2VnCDsiJjsnoUsIOyLpOygnCDsnoXquIgsIOyngOy2nAogIGZ1bmN0aW9uIHRyZW5kKHN0YXRlLCBwZXJpb2QsIG4gPSA2KSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgY29uc3QgcCA9IHNoaWZ0UGVyaW9kKHBlcmlvZCwgLWksIHN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgY29uc3QgcyA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcCk7CiAgICAgIG91dC5wdXNoKHsgcGVyaW9kOiBwLCBidWRnZXRJbmNvbWU6IHMuaGFzSW5jb21lID8gcy5pbmNvbWUgOiBudWxsLCBpbmNvbWVSZWNlaXZlZDogcy5pbmNvbWVSZWNlaXZlZCwgc3BlbnQ6IHMudG90YWxTcGVudCB9KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDrgqDsp5zrs4Qg7ZWp6rOEOiB7ICdZWVlZLU1NLUREJzogeyBzcGVudCwgaW5jb21lLCBjb3VudCB9IH0KICBmdW5jdGlvbiBkYWlseVRvdGFscyh0eHMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBjb25zdCBkID0gKG91dFt0LmRhdGVdID0gb3V0W3QuZGF0ZV0gfHwgeyBzcGVudDogMCwgaW5jb21lOiAwLCBjb3VudDogMCB9KTsKICAgICAgY29uc3QgayA9IGtpbmRPZih0KTsKICAgICAgaWYgKGsgPT09ICdleHBlbnNlJykgZC5zcGVudCArPSB0LmFtb3VudDsKICAgICAgZWxzZSBpZiAoayA9PT0gJ2luY29tZScpIGQuaW5jb21lICs9IHQuYW1vdW50OwogICAgICBkLmNvdW50ICs9IDE7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g7J6Q7IKwOiDqs4Tsoowg7J6U7JWhIO2VqeqzhCwg7Lm065Oc67OEIOydtOuyiCDquLDqsIQg7IKs7Jqp7JWhCiAgZnVuY3Rpb24gYXNzZXRTdW1tYXJ5KHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IHR4cyA9IHR4c0luUGVyaW9kKHN0YXRlLCBwZXJpb2QpOwogICAgY29uc3QgYmFua3MgPSBzdGF0ZS5hY2NvdW50cy5maWx0ZXIoKGEpID0+IGEudHlwZSAhPT0gJ2NhcmQnKTsKICAgIGNvbnN0IGNhcmRzID0gc3RhdGUuYWNjb3VudHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09ICdjYXJkJyk7CiAgICBjb25zdCB0b3RhbCA9IGJhbmtzLnJlZHVjZSgocywgYSkgPT4gcyArICh0eXBlb2YgYS5iYWxhbmNlID09PSAnbnVtYmVyJyA/IGEuYmFsYW5jZSA6IDApLCAwKTsKICAgIGNvbnN0IHNhdmluZ3MgPSBiYW5rcy5maWx0ZXIoKGEpID0+IGEuaXNTYXZpbmdzKS5yZWR1Y2UoKHMsIGEpID0+IHMgKyAodHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiAwKSwgMCk7CiAgICBjb25zdCBzcGVuZEJ5ID0ge307CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSBpZiAoa2luZE9mKHQpID09PSAnZXhwZW5zZScgJiYgdC5hY2NvdW50SWQpIHNwZW5kQnlbdC5hY2NvdW50SWRdID0gKHNwZW5kQnlbdC5hY2NvdW50SWRdIHx8IDApICsgdC5hbW91bnQ7CiAgICByZXR1cm4gewogICAgICB0b3RhbCwKICAgICAgc2F2aW5ncywKICAgICAgYmFua3M6IGJhbmtzLm1hcCgoYSkgPT4gKHsgLi4uYSwgc3BlbnQ6IHNwZW5kQnlbYS5pZF0gfHwgMCB9KSksCiAgICAgIGNhcmRzOiBjYXJkcy5tYXAoKGEpID0+ICh7IC4uLmEsIHNwZW50OiBzcGVuZEJ5W2EuaWRdIHx8IDAgfSkpLAogICAgICB1bmxpbmtlZFNwZW50OiB0eHMuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdleHBlbnNlJyAmJiAhdC5hY2NvdW50SWQpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKSwKICAgIH07CiAgfQoKICAvLyAtLS0tLS0tLS0tIOq4sOuzuCDrjbDsnbTthLAgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBkZWZhdWx0Q2F0ZWdvcmllcygpIHsKICAgIHJldHVybiBbCiAgICAgIHsgaWQ6ICdjLWhvdXNlJywgbmFtZTogJ+yjvOqxsC/qtIDrpqzruYQnLCB0eXBlOiAnZml4ZWQnLCB2YWx1ZTogNTAwMDAwLCBkZXNjcmlwdGlvbjogJ+yblOyEuCwg6rSA66as67mELCDsoITquLDCt+qwgOyKpMK37IiY64+EIOyalOq4iCcsIGtleXdvcmRzOiBbJ+yblOyEuCcsICfqtIDrpqzruYQnLCAn7KCE6riw7JqU6riIJywgJ+uPhOyLnOqwgOyKpCcsICfsiJjrj4TsmpTquIgnXSB9LAogICAgICB7IGlkOiAnYy1waG9uZScsIG5hbWU6ICfthrXsi6Av6rWs64+FJywgdHlwZTogJ2ZpeGVkJywgdmFsdWU6IDgwMDAwLCBkZXNjcmlwdGlvbjogJ+2ctOuMgO2PsCDsmpTquIgsIOyduO2EsOuEtywgT1RUwrfsnYzslYUg65OxIOygleq4sCDqtazrj4UnLCBrZXl3b3JkczogWydTS1QnLCAnS1QnLCAnTEcgVSsnLCAn7Ya17IugJywgJ+uEt+2UjOumreyKpCcsICfsnKDtipzruIwnLCAn66mc66GgJywgJ+y/oO2MoeyZgOyasCcsICfrlJTspojri4gnXSB9LAogICAgICB7IGlkOiAnYy1mb29kJywgbmFtZTogJ+yLneu5hCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiAzMCwgZGVzY3JpcHRpb246ICfsi53ri7ksIOuwsOuLrCwg7J6l67O06riwLCDtjrjsnZjsoJAg7J2M7IudJywga2V5d29yZHM6IFsn7Iud64u5JywgJ+uwsOuLrOydmOuvvOyhsScsICfrsLDrr7wnLCAn7JqU6riw7JqUJywgJ+y/oO2MoeydtOy4oCcsICfsnbTrp4jtirgnLCAn7ZmI7ZSM65+s7IqkJywgJ+uhr+uNsOuniO2KuCcsICfrp4jtirgnLCAn7Y647J2Y7KCQJywgJ0dTMjUnLCAnQ1UnLCAn7IS467iQ7J2866CI67iQJywgJ+q5gOuwpScsICfsuZjtgqgnXSB9LAogICAgICB7IGlkOiAnYy1jYWZlJywgbmFtZTogJ+y5tO2OmC/qsITsi50nLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNSwgZGVzY3JpcHRpb246ICfsu6TtlLwsIOydjOujjCwg67m1LCDrlJTsoIDtirgnLCBrZXl3b3JkczogWyfsiqTtg4DrsoXsiqQnLCAn7Yis7I24JywgJ+ydtOuUlOyVvCcsICfrqZTqsIDsu6TtlLwnLCAn66mU6rCATUdDJywgJ+y7tO2PrOymiCcsICfrub3ri6TrsKknLCAn7Lm07Y6YJywgJ+2MjOumrOuwlOqyjOucqCcsICfrmpzroIjspazrpbQnLCAn67Kg7J207Luk66asJ10gfSwKICAgICAgeyBpZDogJ2MtbW92ZScsIG5hbWU6ICfqtZDthrUnLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNywgZGVzY3JpcHRpb246ICfrjIDspJHqtZDthrUsIO2DneyLnCwg6riw7LCoLCDso7zsnKAsIOyjvOywqCcsIGtleXdvcmRzOiBbJ+2DneyLnCcsICfsubTsubTsmKRUJywgJ+uyhOyKpCcsICfsp4DtlZjssqAnLCAn7Yuw66i464uIJywgJ+y9lOugiOydvCcsICdTUlQnLCAn7KO87JygJywgJ+yjvOywqCddIH0sCiAgICAgIHsgaWQ6ICdjLXNob3AnLCBuYW1lOiAn7Ie87ZWRJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDEwLCBkZXNjcmlwdGlvbjogJ+yYqOudvOyduCDsh7ztlZEsIOyYtywg7IOd7Zmc7Jqp7ZKILCDtmZTsnqXtkognLCBrZXl3b3JkczogWyfsv6DtjKEnLCAnMTHrsojqsIAnLCAnR+uniOy8kycsICfrrLTsi6DsgqwnLCAn7Jis66as67iM7JiBJywgJ+uLpOydtOyGjCcsICfrhKTsnbTrsoTtjpjsnbQnXSB9LAogICAgICB7IGlkOiAnYy1mdW4nLCBuYW1lOiAn66y47ZmUL+yXrOqwgCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA4LCBkZXNjcmlwdGlvbjogJ+yYge2ZlCwg6rO17JewLCDssYUsIOy3qOuvuCwg7Jes7ZaJJywga2V5d29yZHM6IFsnQ0dWJywgJ+uplOqwgOuwleyKpCcsICfroa/rjbDsi5zrhKTrp4gnLCAn6rWQ67O066y46rOgJywgJ1lFUzI0JywgJ+yVjOudvOuUmCddIH0sCiAgICAgIHsgaWQ6ICdjLXNhdmUnLCBuYW1lOiAn7KCA7LaVL+2IrOyekCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA0MCwgZGVzY3JpcHRpb246ICfsoIHquIgsIOyggOy2lSDsnbTssrQsIOymneq2jCDqs4Tsoowg7J6F6riILCDssq3slb0nLCBrZXl3b3JkczogWyfsoIHquIgnLCAn7KCA7LaVJywgJ+ymneq2jCcsICfssq3slb0nXSB9LAogICAgXTsKICB9CgogIGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSgpIHsKICAgIHJldHVybiB7CiAgICAgIHZlcnNpb246IDIsCiAgICAgIHNldHRpbmdzOiB7IHN0YXJ0RGF5OiAxLCBteU5hbWU6ICcnIH0sCiAgICAgIHBsYW5zOiBbeyBmcm9tOiBCQVNFX1BMQU5fRlJPTSwgcmF0aW9CYXNlOiAnYWZ0ZXJGaXhlZCcsIGZpeGVkT3ZlcmZsb3c6ICd3YXJuJywgY2F0ZWdvcmllczogZGVmYXVsdENhdGVnb3JpZXMoKSwgdXBkYXRlZEF0OiAnJyB9XSwKICAgICAgYWNjb3VudHM6IFtdLAogICAgICBpbmNvbWVzOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBbXSwKICAgICAgbWVyY2hhbnRNYXA6IHt9LAogICAgfTsKICB9CgogIC8vIOyggOyepeuQnCDrjbDsnbTthLDrpbwg7ZiE7J6sIOq1rOyhsOuhnCDrp57stpjri6QuICh2MTog6rOE7ZqN7J20IO2VmOuCmOu/kOydtOuNmCDqtazsobAg4oaSIHYyOiDquLDqsITrs4Qg6rOE7ZqNKQogIGZ1bmN0aW9uIG5vcm1hbGl6ZVN0YXRlKHJhdykgewogICAgY29uc3QgYmFzZSA9IGRlZmF1bHRTdGF0ZSgpOwogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBiYXNlOwogICAgY29uc3Qgc2V0dGluZ3MgPSByYXcuc2V0dGluZ3MgfHwge307CiAgICBjb25zdCBzdGFydERheSA9IE1hdGgubWluKDMxLCBNYXRoLm1heCgxLCBOdW1iZXIoc2V0dGluZ3Muc3RhcnREYXkpIHx8IDEpKTsKCiAgICBsZXQgcGxhbnM7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyYXcucGxhbnMpICYmIHJhdy5wbGFucy5sZW5ndGgpIHsKICAgICAgcGxhbnMgPSByYXcucGxhbnM7CiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocmF3LmNhdGVnb3JpZXMpKSB7CiAgICAgIHBsYW5zID0gW3sgZnJvbTogQkFTRV9QTEFOX0ZST00sIHJhdGlvQmFzZTogc2V0dGluZ3MucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLCBjYXRlZ29yaWVzOiByYXcuY2F0ZWdvcmllcywgdXBkYXRlZEF0OiAnJyB9XTsKICAgIH0gZWxzZSB7CiAgICAgIHBsYW5zID0gYmFzZS5wbGFuczsKICAgIH0KICAgIHBsYW5zID0gcGxhbnMKICAgICAgLm1hcCgocCkgPT4gKHsKICAgICAgICBmcm9tOiBTdHJpbmcocC5mcm9tIHx8IEJBU0VfUExBTl9GUk9NKSwKICAgICAgICByYXRpb0Jhc2U6IHAucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLAogICAgICAgIGZpeGVkT3ZlcmZsb3c6IHAuZml4ZWRPdmVyZmxvdyA9PT0gJ3NjYWxlJyA/ICdzY2FsZScgOiAnd2FybicsCiAgICAgICAgY2F0ZWdvcmllczogQXJyYXkuaXNBcnJheShwLmNhdGVnb3JpZXMpID8gcC5jYXRlZ29yaWVzIDogW10sCiAgICAgICAgdXBkYXRlZEF0OiBTdHJpbmcocC51cGRhdGVkQXQgfHwgJycpLAogICAgICB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IChhLmZyb20gPCBiLmZyb20gPyAtMSA6IGEuZnJvbSA+IGIuZnJvbSA/IDEgOiAwKSk7CgogICAgY29uc3QgYWNjb3VudHMgPSAoQXJyYXkuaXNBcnJheShyYXcuYWNjb3VudHMpID8gcmF3LmFjY291bnRzIDogW10pLm1hcCgoYSkgPT4gKHsKICAgICAgaWQ6IFN0cmluZyhhLmlkKSwKICAgICAgbmFtZTogU3RyaW5nKGEubmFtZSB8fCAnJyksCiAgICAgIHR5cGU6IGEudHlwZSA9PT0gJ2NhcmQnID8gJ2NhcmQnIDogJ2JhbmsnLAogICAgICBsYXN0NDogZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCksCiAgICAgIGlzU2F2aW5nczogISFhLmlzU2F2aW5ncywKICAgICAgYmFsYW5jZTogdHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiBudWxsLAogICAgICBiYWxhbmNlQXQ6IFN0cmluZyhhLmJhbGFuY2VBdCB8fCAnJyksCiAgICB9KSk7CgogICAgcmV0dXJuIHsKICAgICAgdmVyc2lvbjogMiwKICAgICAgc2V0dGluZ3M6IHsgc3RhcnREYXksIG15TmFtZTogU3RyaW5nKHNldHRpbmdzLm15TmFtZSB8fCAnJykgfSwKICAgICAgcGxhbnMsCiAgICAgIGFjY291bnRzLAogICAgICBpbmNvbWVzOiByYXcuaW5jb21lcyAmJiB0eXBlb2YgcmF3LmluY29tZXMgPT09ICdvYmplY3QnID8gcmF3LmluY29tZXMgOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBBcnJheS5pc0FycmF5KHJhdy50cmFuc2FjdGlvbnMpID8gcmF3LnRyYW5zYWN0aW9ucyA6IFtdLAogICAgICBtZXJjaGFudE1hcDogcmF3Lm1lcmNoYW50TWFwICYmIHR5cGVvZiByYXcubWVyY2hhbnRNYXAgPT09ICdvYmplY3QnID8gcmF3Lm1lcmNoYW50TWFwIDoge30sCiAgICB9OwogIH0KCiAgcmV0dXJuIHsKICAgIHRvSVNPLAogICAgcGFyc2VJU08sCiAgICBhZGREYXlzLAogICAgZGlmZkRheXMsCiAgICB0b2RheUlTTywKICAgIGRheXNJbk1vbnRoLAogICAgZ2V0UGVyaW9kLAogICAgc2hpZnRQZXJpb2QsCiAgICBjb21wdXRlQnVkZ2V0cywKICAgIHN1bW1hcml6ZVBlcmlvZCwKICAgIHN0YXR1c09mLAogICAgbm9ybWFsaXplTWVyY2hhbnQsCiAgICBjbGFzc2lmeSwKICAgIGNsYXNzaWZ5TG9jYWwsCiAgICBwYXJzZUV4cGVuc2VUZXh0LAogICAga2luZE9mLAogICAgbG9va3NMaWtlVHJhbnNhY3Rpb24sCiAgICBtYXRjaEFjY291bnQsCiAgICBwYXJzZU1lc3NhZ2VGYWxsYmFjaywKICAgIGlzRHVwbGljYXRlLAogICAgQkFTRV9QTEFOX0ZST00sCiAgICBwbGFuRm9yLAogICAgdW5jbGFzc2lmaWVkR3JvdXBzLAogICAgdW5jbGFzc2lmaWVkQnlQZXJpb2QsCiAgICBlbnN1cmVQbGFuRm9yLAogICAgbmV4dFBsYW5BZnRlciwKICAgIHJlbWFwUGVyaW9kS2V5cywKICAgIGJ1aWxkQ2xhc3NpZnlSZXF1ZXN0LAogICAgcmVhZENsYXNzaWZ5UmVzcG9uc2UsCiAgICBidWlsZE1lc3NhZ2VSZXF1ZXN0LAogICAgcmVhZE1lc3NhZ2VSZXNwb25zZSwKICAgIHBhcnNlU3RhdGVtZW50Um93cywKICAgIHBhcnNlQ1NWLAogICAgZmluZER1cGxpY2F0ZSwKICAgIGNhdGVnb3J5QnJlYWtkb3duLAogICAgY29tcGFyZVdpdGhQcmV2aW91cywKICAgIHRvcE1lcmNoYW50cywKICAgIHRyZW5kLAogICAgZGFpbHlUb3RhbHMsCiAgICBhc3NldFN1bW1hcnksCiAgICBkZWZhdWx0U3RhdGUsCiAgICBub3JtYWxpemVTdGF0ZSwKICB9Owp9KTsK\");</script>\n  <script>__budgetRun(\"js/charts.js\", \"Lyog7LCo7Yq4IChTVkcg66y47J6Q7Je07J2EIOunjOuToOuLpCkuIOyDieydgCBjc3Mg67OA7IiYIC0tczEgfiAtLXM3ICjtla3rqqkg7Iic7ISc64yA66GcIOqzoOyglSksIOq3uCDrsJbsnYAg7ZqM7IOJLiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IFNMT1RTID0gNzsKCiAgZnVuY3Rpb24gc2VyaWVzQ29sb3IoY29sb3JJbmRleCkgewogICAgcmV0dXJuIGNvbG9ySW5kZXggPj0gMCAmJiBjb2xvckluZGV4IDwgU0xPVFMgPyBgdmFyKC0tcyR7Y29sb3JJbmRleCArIDF9KWAgOiAndmFyKC0tZ3JheS1tYXJrKSc7CiAgfQoKICAvLyAxMiwzNDAsMDAwIOKGkiAiMSwyMzTrp4wiLCAx7Ja1IOydtOyDgeydgCAiMS4y7Ja1IgogIGZ1bmN0aW9uIHNob3J0V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHNpZ24gPSBuIDwgMCA/ICctJyA6ICcnOwogICAgaWYgKGEgPj0gMWU4KSByZXR1cm4gYCR7c2lnbn0keyhhIC8gMWU4KS50b0ZpeGVkKGEgPj0gMWU5ID8gMCA6IDEpLnJlcGxhY2UoL1wuMCQvLCAnJyl97Ja1YDsKICAgIGlmIChhID49IDFlNCkgcmV0dXJuIGAke3NpZ259JHtNYXRoLnJvdW5kKGEgLyAxZTQpLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeunjGA7CiAgICByZXR1cm4gYCR7c2lnbn0ke01hdGgucm91bmQoYSkudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyl9YDsKICB9CgogIC8vIOuLrOugpeyymOufvCDsooHsnYAg7Lm47JqpOiA2LDIwMCDihpIgIjYuMuyynCIsIDEyLDQwMCDihpIgIjEuMuunjCIsIDUxMiwwMDAg4oaSICI1MeunjCIKICBmdW5jdGlvbiB0aW55V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHRyaW0gPSAoeCkgPT4geC50b0ZpeGVkKDEpLnJlcGxhY2UoL1wuMCQvLCAnJyk7CiAgICBpZiAoYSA+PSAxZTgpIHJldHVybiBgJHt0cmltKGEgLyAxZTgpfeyWtWA7CiAgICBpZiAoYSA+PSAxZTUpIHJldHVybiBgJHtNYXRoLnJvdW5kKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTQpIHJldHVybiBgJHt0cmltKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTMpIHJldHVybiBgJHt0cmltKGEgLyAxZTMpfeyynGA7CiAgICByZXR1cm4gU3RyaW5nKE1hdGgucm91bmQoYSkpOwogIH0KCiAgZnVuY3Rpb24gbmljZU1heCh2KSB7CiAgICBpZiAodiA8PSAwKSByZXR1cm4gMTAwMDA7CiAgICBjb25zdCBwID0gTWF0aC5wb3coMTAsIE1hdGguZmxvb3IoTWF0aC5sb2cxMCh2KSkpOwogICAgZm9yIChjb25zdCBtIG9mIFsxLCAyLCAyLjUsIDUsIDEwXSkgaWYgKG0gKiBwID49IHYpIHJldHVybiBtICogcDsKICAgIHJldHVybiAxMCAqIHA7CiAgfQoKICAvLyDqtazshLEg66eJ64yAOiByb3dzID0gW3tuYW1lLCBhbW91bnQsIGNvbG9ySW5kZXh9XSAo66eO7J20IOyTtCDsiJwpLiA467KI7Ke4IOyDieu2gO2EsOuKlCAi6riw7YOAIuuhnCDtlansuZzri6QuCiAgZnVuY3Rpb24gc2hhcmVTZWdtZW50cyhyb3dzKSB7CiAgICBjb25zdCBtYWluID0gcm93cy5maWx0ZXIoKHIpID0+IHIuY29sb3JJbmRleCA+PSAwICYmIHIuY29sb3JJbmRleCA8IFNMT1RTKTsKICAgIGNvbnN0IHJlc3QgPSByb3dzLmZpbHRlcigocikgPT4gIShyLmNvbG9ySW5kZXggPj0gMCAmJiByLmNvbG9ySW5kZXggPCBTTE9UUykpOwogICAgY29uc3Qgc2VncyA9IG1haW4ubWFwKChyKSA9PiAoeyBuYW1lOiByLm5hbWUsIGFtb3VudDogci5hbW91bnQsIGNvbG9yOiBzZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpIH0pKTsKICAgIGNvbnN0IHJlc3RTdW0gPSByZXN0LnJlZHVjZSgocywgcikgPT4gcyArIHIuYW1vdW50LCAwKTsKICAgIGlmIChyZXN0U3VtID4gMCkgc2Vncy5wdXNoKHsgbmFtZTogcmVzdC5sZW5ndGggPT09IDEgPyByZXN0WzBdLm5hbWUgOiAn6riw7YOAJywgYW1vdW50OiByZXN0U3VtLCBjb2xvcjogc2VyaWVzQ29sb3IoLTEpIH0pOwogICAgcmV0dXJuIHNlZ3M7CiAgfQoKICBmdW5jdGlvbiBzaGFyZUJhcihyb3dzKSB7CiAgICBjb25zdCBzZWdzID0gc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgIGNvbnN0IHRvdGFsID0gc2Vncy5yZWR1Y2UoKHMsIHIpID0+IHMgKyByLmFtb3VudCwgMCkgfHwgMTsKICAgIHJldHVybiBgPGRpdiBjbGFzcz0ic2hhcmUtYmFyIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iu2VreuqqeuzhCDsp4Dstpwg6rWs7ISxIj4ke3NlZ3MKICAgICAgLm1hcCgocywgaSkgPT4gYDxzcGFuIGRhdGEtc2VnPSIke2l9IiBzdHlsZT0iZmxleDoke3MuYW1vdW50IC8gdG90YWx9O2JhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPmApCiAgICAgIC5qb2luKCcnKX08L2Rpdj5gOwogIH0KCiAgLyoKICAgKiDquLDqsITrs4Qg7LaU7J20OiDquLDqsITrp4jri6QgW+yImOyehSwg7KeA7LacXSDrkZAg66eJ64yALiBkYXRhID0gW3tsYWJlbCwgaW5jb21lLCBzcGVudH1dCiAgICog66eJ64yAIOyCrOydtCAycHgg6rCE6rKpLCDsnJfrtoDrtoQgNHB4IOuRpeq4gOqyjCwg67CU64ul7J2AIOq4sOykgOyEoOyXkCDrtpnsnoQuCiAgICovCiAgZnVuY3Rpb24gdHJlbmRDaGFydChkYXRhLCB7IHdpZHRoID0gNjQwLCBoZWlnaHQgPSAyMjAgfSA9IHt9KSB7CiAgICBjb25zdCBwYWQgPSB7IHRvcDogMTIsIHJpZ2h0OiA4LCBib3R0b206IDI2LCBsZWZ0OiA0NCB9OwogICAgY29uc3QgdyA9IHdpZHRoIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgICBjb25zdCBoID0gaGVpZ2h0IC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgICBjb25zdCBtYXggPSBuaWNlTWF4KE1hdGgubWF4KDEsIC4uLmRhdGEubWFwKChkKSA9PiBNYXRoLm1heChkLmluY29tZSB8fCAwLCBkLnNwZW50IHx8IDApKSkpOwogICAgY29uc3QgeSA9ICh2KSA9PiBwYWQudG9wICsgaCAtIChNYXRoLm1heCgwLCB2KSAvIG1heCkgKiBoOwogICAgY29uc3QgYmFuZCA9IHcgLyBkYXRhLmxlbmd0aDsKICAgIGNvbnN0IGJhclcgPSBNYXRoLm1pbigyNiwgKGJhbmQgLSAxOCkgLyAyKTsKICAgIGNvbnN0IGdhcCA9IDI7CiAgICBjb25zdCBwYXJ0cyA9IFtdOwoKICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDQ7IGkrKykgewogICAgICBjb25zdCB2ID0gKG1heCAvIDQpICogaTsKICAgICAgY29uc3QgeXkgPSB5KHYpOwogICAgICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz0iZ3JpZC1saW5lIiB4MT0iJHtwYWQubGVmdH0iIHgyPSIke3dpZHRoIC0gcGFkLnJpZ2h0fSIgeTE9IiR7eXl9IiB5Mj0iJHt5eX0iLz5gKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7cGFkLmxlZnQgLSA2fSIgeT0iJHt5eSArIDR9IiB0ZXh0LWFuY2hvcj0iZW5kIj4ke3Nob3J0V29uKHYpfTwvdGV4dD5gKTsKICAgIH0KCiAgICBjb25zdCBiYXIgPSAoeCwgdiwgY29sb3IpID0+IHsKICAgICAgaWYgKCF2IHx8IHYgPD0gMCkgcmV0dXJuICcnOwogICAgICBjb25zdCB0b3AgPSB5KHYpOwogICAgICBjb25zdCBiaCA9IHBhZC50b3AgKyBoIC0gdG9wOwogICAgICBjb25zdCByID0gTWF0aC5taW4oNCwgYmgpOwogICAgICAvLyDsnITsqr0g66qo7ISc66as66eMIOuRpeq3vCDrp4nrjIAKICAgICAgcmV0dXJuIGA8cGF0aCBmaWxsPSIke2NvbG9yfSIgZD0iTSR7eH0sJHtwYWQudG9wICsgaH0gViR7dG9wICsgcn0gUSR7eH0sJHt0b3B9ICR7eCArIHJ9LCR7dG9wfSBIJHt4ICsgYmFyVyAtIHJ9IFEke3ggKyBiYXJXfSwke3RvcH0gJHt4ICsgYmFyV30sJHt0b3AgKyByfSBWJHtwYWQudG9wICsgaH0gWiIvPmA7CiAgICB9OwoKICAgIGRhdGEuZm9yRWFjaCgoZCwgaSkgPT4gewogICAgICBjb25zdCBjeCA9IHBhZC5sZWZ0ICsgYmFuZCAqIGkgKyBiYW5kIC8gMjsKICAgICAgcGFydHMucHVzaChiYXIoY3ggLSBiYXJXIC0gZ2FwIC8gMiwgZC5pbmNvbWUsICd2YXIoLS1zMSknKSk7CiAgICAgIHBhcnRzLnB1c2goYmFyKGN4ICsgZ2FwIC8gMiwgZC5zcGVudCwgJ3ZhcigtLXMyKScpKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7Y3h9IiB5PSIke2hlaWdodCAtIDh9IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj4ke2QubGFiZWx9PC90ZXh0PmApOwogICAgICBwYXJ0cy5wdXNoKGA8cmVjdCBjbGFzcz0iaGl0IiBkYXRhLWk9IiR7aX0iIHg9IiR7cGFkLmxlZnQgKyBiYW5kICogaX0iIHk9IiR7cGFkLnRvcH0iIHdpZHRoPSIke2JhbmR9IiBoZWlnaHQ9IiR7aH0iLz5gKTsKICAgIH0pOwoKICAgIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3aWR0aH0gJHtoZWlnaHR9IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iuq4sOqwhOuzhCDsiJjsnoXqs7wg7KeA7LacIj4ke3BhcnRzLmpvaW4oJycpfTwvc3ZnPmA7CiAgfQoKICByb290LkJ1ZGdldENoYXJ0cyA9IHsgc2VyaWVzQ29sb3IsIHNob3J0V29uLCB0aW55V29uLCBzaGFyZVNlZ21lbnRzLCBzaGFyZUJhciwgdHJlbmRDaGFydCB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/xlsx.js\", \"Lyog7JeR7IWAKC54bHN4KSDssqsg67KI7Ke4IOyLnO2KuOulvCAy7LCo7JuQIOuwsOyXtOuhnCDsnb3ripTri6QuIOyZuOu2gCDrnbzsnbTruIzrn6zrpqwg7JeG7J20IOu4jOudvOyasOyggCDquLDriqXrp4wg7JO064ukLgogKiAueGxzeCDripQgemlwIOyViOyXkCBYTUwg7J20IOuToCDtjIzsnbzsnbTrnbwsIHppcCDsnYQg7ZKA6rOgKERlY29tcHJlc3Npb25TdHJlYW0pIFhNTCDsnYQg7J2964qU64ukKERPTVBhcnNlcikuCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGZ1bmN0aW9uIGZhaWwoY29kZSwgbWVzc2FnZSkgewogICAgY29uc3QgZSA9IG5ldyBFcnJvcihtZXNzYWdlKTsKICAgIGUuY29kZSA9IGNvZGU7CiAgICByZXR1cm4gZTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGluZmxhdGVSYXcoYnl0ZXMpIHsKICAgIGlmICh0eXBlb2YgRGVjb21wcmVzc2lvblN0cmVhbSA9PT0gJ3VuZGVmaW5lZCcpIHsKICAgICAgdGhyb3cgZmFpbCgndW5zdXBwb3J0ZWQnLCAn7J20IOu4jOudvOyasOyggOuKlCDsl5HshYAg7YyM7J287J2EIO2SgCDsiJgg7JeG7Ja07JqULiDstZzsi6Ag7YGs66GswrfsgqztjIzrpqzrpbwg7JOw6rGw64KYLCDsl5HshYDsl5DshJwgQ1NWIOuhnCDsoIDsnqXtlbQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBCbG9iKFtieXRlc10pLnN0cmVhbSgpLnBpcGVUaHJvdWdoKG5ldyBEZWNvbXByZXNzaW9uU3RyZWFtKCdkZWZsYXRlLXJhdycpKTsKICAgIHJldHVybiBuZXcgVWludDhBcnJheShhd2FpdCBuZXcgUmVzcG9uc2Uoc3RyZWFtKS5hcnJheUJ1ZmZlcigpKTsKICB9CgogIC8vIHppcCDslYjsnZgg7YyM7J28IOuqqeuhnSDihpIgeyDsnbTrpoQ6IGFzeW5jICgpID0+IOuCtOyaqShVaW50OEFycmF5KSB9CiAgZnVuY3Rpb24gcmVhZFppcERpcmVjdG9yeShidWYpIHsKICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcoYnVmKTsKICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYnVmKTsKICAgIGxldCBlb2NkID0gLTE7CiAgICBmb3IgKGxldCBpID0gYnVmLmJ5dGVMZW5ndGggLSAyMjsgaSA+PSBNYXRoLm1heCgwLCBidWYuYnl0ZUxlbmd0aCAtIDY1NTU3KTsgaS0tKSB7CiAgICAgIGlmICh2aWV3LmdldFVpbnQzMihpLCB0cnVlKSA9PT0gMHgwNjA1NGI1MCkgewogICAgICAgIGVvY2QgPSBpOwogICAgICAgIGJyZWFrOwogICAgICB9CiAgICB9CiAgICBpZiAoZW9jZCA8IDApIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAg7YyM7J28IOq1rOyhsOulvCDsnb3sp4Ag66q77ZaI7Ja07JqULicpOwogICAgY29uc3QgY291bnQgPSB2aWV3LmdldFVpbnQxNihlb2NkICsgMTAsIHRydWUpOwogICAgbGV0IHAgPSB2aWV3LmdldFVpbnQzMihlb2NkICsgMTYsIHRydWUpOwogICAgY29uc3QgZmlsZXMgPSB7fTsKICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTsKICAgIGZvciAobGV0IG4gPSAwOyBuIDwgY291bnQ7IG4rKykgewogICAgICBpZiAodmlldy5nZXRVaW50MzIocCwgdHJ1ZSkgIT09IDB4MDIwMTRiNTApIGJyZWFrOwogICAgICBjb25zdCBtZXRob2QgPSB2aWV3LmdldFVpbnQxNihwICsgMTAsIHRydWUpOwogICAgICBjb25zdCBjb21wU2l6ZSA9IHZpZXcuZ2V0VWludDMyKHAgKyAyMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWVMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMjgsIHRydWUpOwogICAgICBjb25zdCBleHRyYUxlbiA9IHZpZXcuZ2V0VWludDE2KHAgKyAzMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGNvbW1lbnRMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMzIsIHRydWUpOwogICAgICBjb25zdCBsb2NhbCA9IHZpZXcuZ2V0VWludDMyKHAgKyA0MiwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVyLmRlY29kZShieXRlcy5zdWJhcnJheShwICsgNDYsIHAgKyA0NiArIG5hbWVMZW4pKTsKICAgICAgZmlsZXNbbmFtZV0gPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc3RhcnQgPSBsb2NhbCArIDMwICsgdmlldy5nZXRVaW50MTYobG9jYWwgKyAyNiwgdHJ1ZSkgKyB2aWV3LmdldFVpbnQxNihsb2NhbCArIDI4LCB0cnVlKTsKICAgICAgICBjb25zdCBkYXRhID0gYnl0ZXMuc3ViYXJyYXkoc3RhcnQsIHN0YXJ0ICsgY29tcFNpemUpOwogICAgICAgIGlmIChtZXRob2QgPT09IDApIHJldHVybiBkYXRhOwogICAgICAgIGlmIChtZXRob2QgPT09IDgpIHJldHVybiBpbmZsYXRlUmF3KGRhdGEpOwogICAgICAgIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsp4Dsm5DtlZjsp4Ag7JWK64qUIOyVley2lSDrsKnsi53snbTsl5DsmpQuJyk7CiAgICAgIH07CiAgICAgIHAgKz0gNDYgKyBuYW1lTGVuICsgZXh0cmFMZW4gKyBjb21tZW50TGVuOwogICAgfQogICAgcmV0dXJuIGZpbGVzOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFhtbChmaWxlcywgbmFtZSkgewogICAgaWYgKCFmaWxlc1tuYW1lXSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGF3YWl0IGZpbGVzW25hbWVdKCkpOwogICAgcmV0dXJuIG5ldyBET01QYXJzZXIoKS5wYXJzZUZyb21TdHJpbmcodGV4dCwgJ2FwcGxpY2F0aW9uL3htbCcpOwogIH0KCiAgY29uc3QgdGFncyA9IChub2RlLCBuYW1lKSA9PiBBcnJheS5mcm9tKG5vZGUuZ2V0RWxlbWVudHNCeVRhZ05hbWUobmFtZSkpOwoKICBmdW5jdGlvbiBjb2x1bW5JbmRleChyZWYpIHsKICAgIGNvbnN0IGxldHRlcnMgPSBTdHJpbmcocmVmIHx8ICcnKS5tYXRjaCgvXltBLVpdKy8pOwogICAgaWYgKCFsZXR0ZXJzKSByZXR1cm4gLTE7CiAgICBsZXQgbiA9IDA7CiAgICBmb3IgKGNvbnN0IGNoIG9mIGxldHRlcnNbMF0pIG4gPSBuICogMjYgKyAoY2guY2hhckNvZGVBdCgwKSAtIDY0KTsKICAgIHJldHVybiBuIC0gMTsKICB9CgogIC8vIOyyqyDrsojsp7gg7Iuc7Yq47J2YIOqyveuhnCAod29ya2Jvb2sueG1sIOydmCDssqsgc2hlZXQg4oaSIOq0gOqzhCDtjIzsnbzsl5DshJwg7Iuk7KCcIOqyveuhnCkKICBhc3luYyBmdW5jdGlvbiBmaXJzdFNoZWV0UGF0aChmaWxlcykgewogICAgY29uc3Qgd2IgPSBhd2FpdCByZWFkWG1sKGZpbGVzLCAneGwvd29ya2Jvb2sueG1sJyk7CiAgICBjb25zdCByZWxzID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzJyk7CiAgICBpZiAod2IgJiYgcmVscykgewogICAgICBjb25zdCBzaGVldCA9IHRhZ3Mod2IsICdzaGVldCcpWzBdOwogICAgICBjb25zdCByaWQgPSBzaGVldCAmJiAoc2hlZXQuZ2V0QXR0cmlidXRlKCdyOmlkJykgfHwgc2hlZXQuZ2V0QXR0cmlidXRlTlMoJ2h0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMnLCAnaWQnKSk7CiAgICAgIGNvbnN0IHJlbCA9IHRhZ3MocmVscywgJ1JlbGF0aW9uc2hpcCcpLmZpbmQoKHIpID0+IHIuZ2V0QXR0cmlidXRlKCdJZCcpID09PSByaWQpOwogICAgICBpZiAocmVsKSB7CiAgICAgICAgY29uc3QgdGFyZ2V0ID0gcmVsLmdldEF0dHJpYnV0ZSgnVGFyZ2V0JykucmVwbGFjZSgvXlwvLywgJycpOwogICAgICAgIHJldHVybiB0YXJnZXQuc3RhcnRzV2l0aCgneGwvJykgPyB0YXJnZXQgOiBgeGwvJHt0YXJnZXR9YDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIE9iamVjdC5rZXlzKGZpbGVzKS5maWx0ZXIoKG4pID0+IC9eeGxcL3dvcmtzaGVldHNcL3NoZWV0XGQrXC54bWwkLy50ZXN0KG4pKS5zb3J0KClbMF07CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkWGxzeChhcnJheUJ1ZmZlcikgewogICAgY29uc3QgaGVhZCA9IG5ldyBVaW50OEFycmF5KGFycmF5QnVmZmVyLnNsaWNlKDAsIDQpKTsKICAgIC8vIEQwIENGIDExIEUwOiDruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgOydtOqxsOuCmCDsmJvrgqAgLnhscyDtmJXsi50KICAgIGlmIChoZWFkWzBdID09PSAweGQwICYmIGhlYWRbMV0gPT09IDB4Y2YgJiYgaGVhZFsyXSA9PT0gMHgxMSAmJiBoZWFkWzNdID09PSAweGUwKSB7CiAgICAgIHRocm93IGZhaWwoJ2VuY3J5cHRlZCcsICfruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgCjrmJDripQg7Jib64KgIC54bHMpIO2MjOydvOydtOyXkOyalC4g7JeR7IWA7J2064KYIOq1rOq4gCDsi5ztirjsl5DshJwg7Je07Ja0IOu5hOuwgOuyiO2YuCDsl4bsnbQgLnhsc3gg65iQ64qUIENTViDroZwg64uk7IucIOyggOyepe2VnCDrkqQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGlmICghKGhlYWRbMF0gPT09IDB4NTAgJiYgaGVhZFsxXSA9PT0gMHg0YikpIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAoLnhsc3gpIO2MjOydvOydtCDslYTri4jsl5DsmpQuJyk7CgogICAgY29uc3QgZmlsZXMgPSByZWFkWmlwRGlyZWN0b3J5KGFycmF5QnVmZmVyKTsKICAgIGNvbnN0IHNoYXJlZCA9IFtdOwogICAgY29uc3Qgc3N0ID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL3NoYXJlZFN0cmluZ3MueG1sJyk7CiAgICBpZiAoc3N0KSB7CiAgICAgIGZvciAoY29uc3Qgc2kgb2YgdGFncyhzc3QsICdzaScpKSB7CiAgICAgICAgLy8g7J2964qUIOuylSDtkZzsi5woclBoKSDslYjsnZgg6riA7J6Q64qUIOu5vOqzoCDtlansuZzri6QKICAgICAgICBzaGFyZWQucHVzaCh0YWdzKHNpLCAndCcpLmZpbHRlcigodCkgPT4gISh0LnBhcmVudE5vZGUgJiYgdC5wYXJlbnROb2RlLm5vZGVOYW1lID09PSAnclBoJykpLm1hcCgodCkgPT4gdC50ZXh0Q29udGVudCkuam9pbignJykpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBwYXRoID0gYXdhaXQgZmlyc3RTaGVldFBhdGgoZmlsZXMpOwogICAgY29uc3Qgc2hlZXQgPSBwYXRoICYmIChhd2FpdCByZWFkWG1sKGZpbGVzLCBwYXRoKSk7CiAgICBpZiAoIXNoZWV0KSB0aHJvdyBmYWlsKCdmb3JtYXQnLCAn7Iuc7Yq466W8IOywvuyngCDrqrvtlojslrTsmpQuJyk7CgogICAgY29uc3Qgcm93cyA9IFtdOwogICAgZm9yIChjb25zdCByb3cgb2YgdGFncyhzaGVldCwgJ3JvdycpKSB7CiAgICAgIGNvbnN0IHIgPSBOdW1iZXIocm93LmdldEF0dHJpYnV0ZSgncicpKSAtIDE7CiAgICAgIGNvbnN0IG91dCA9IFtdOwogICAgICB0YWdzKHJvdywgJ2MnKS5mb3JFYWNoKChjLCBpKSA9PiB7CiAgICAgICAgY29uc3QgY29sID0gYy5nZXRBdHRyaWJ1dGUoJ3InKSA/IGNvbHVtbkluZGV4KGMuZ2V0QXR0cmlidXRlKCdyJykpIDogaTsKICAgICAgICBjb25zdCB0eXBlID0gYy5nZXRBdHRyaWJ1dGUoJ3QnKTsKICAgICAgICBjb25zdCB2ID0gdGFncyhjLCAndicpWzBdOwogICAgICAgIGxldCB2YWx1ZSA9ICcnOwogICAgICAgIGlmICh0eXBlID09PSAncycpIHZhbHVlID0gc2hhcmVkW051bWJlcih2ICYmIHYudGV4dENvbnRlbnQpXSB8fCAnJzsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnaW5saW5lU3RyJykgdmFsdWUgPSB0YWdzKGMsICd0JykubWFwKCh0KSA9PiB0LnRleHRDb250ZW50KS5qb2luKCcnKTsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnc3RyJyB8fCB0eXBlID09PSAnYicgfHwgdHlwZSA9PT0gJ2UnKSB2YWx1ZSA9IHYgPyB2LnRleHRDb250ZW50IDogJyc7CiAgICAgICAgZWxzZSBpZiAodikgdmFsdWUgPSBOdW1iZXIodi50ZXh0Q29udGVudCk7CiAgICAgICAgb3V0W2NvbF0gPSB2YWx1ZTsKICAgICAgfSk7CiAgICAgIHJvd3NbciA+PSAwID8gciA6IHJvd3MubGVuZ3RoXSA9IG91dDsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHJvd3MsIChyKSA9PiBBcnJheS5mcm9tKHIgfHwgW10sIChjKSA9PiAoYyA9PT0gdW5kZWZpbmVkID8gJycgOiBjKSkpOwogIH0KCiAgLy8g7YyM7J28IO2VmOuCmOulvCDsnb3slrQgMuywqOybkCDrsLDsl7TroZwuIENTViDripQg6riA7J6QIOq3uOuMgOuhnCjtlZzquIAg7JeR7IWAIENTViDripQgRVVDLUtSIOyduCDqsr3smrDqsIAg66eO7JWEIOqwmeydtCDsi5zrj4QpCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFRhYmxlRmlsZShmaWxlKSB7CiAgICBjb25zdCBidWYgPSBhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCk7CiAgICBjb25zdCBoZWFkID0gbmV3IFVpbnQ4QXJyYXkoYnVmLnNsaWNlKDAsIDQpKTsKICAgIGNvbnN0IGlzWmlwT3JPbGUgPSAoaGVhZFswXSA9PT0gMHg1MCAmJiBoZWFkWzFdID09PSAweDRiKSB8fCAoaGVhZFswXSA9PT0gMHhkMCAmJiBoZWFkWzFdID09PSAweGNmKTsKICAgIGlmIChpc1ppcE9yT2xlIHx8IC9cLnhsc3g/JC9pLnRlc3QoZmlsZS5uYW1lKSkgcmV0dXJuIHJlYWRYbHN4KGJ1Zik7CiAgICBsZXQgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigndXRmLTgnKS5kZWNvZGUoYnVmKTsKICAgIGlmICh0ZXh0LmluY2x1ZGVzKCfvv70nKSkgewogICAgICB0cnkgewogICAgICAgIHRleHQgPSBuZXcgVGV4dERlY29kZXIoJ2V1Yy1rcicpLmRlY29kZShidWYpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyogdXRmLTgg6re464yA66GcICovCiAgICAgIH0KICAgIH0KICAgIHJldHVybiByb290LkJ1ZGdldExvZ2ljLnBhcnNlQ1NWKHRleHQpOwogIH0KCiAgcm9vdC5CdWRnZXRYbHN4ID0geyByZWFkWGxzeCwgcmVhZFRhYmxlRmlsZSB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/store.js\", \"Lyog7KCA7J6l7IaMLiDrkZAg6rCA7KeAIOuwqeyLneydhCDqsJnsnYAg7ZWo7IiY66GcIOuLpOujrOuLpC4KICogIC0gbG9jYWwgOiDsnbQg67iM65287Jqw7KCAKGxvY2FsU3RvcmFnZSnsl5Drp4wg7KCA7J6lLCDtgqTsm4zrk5zroZwg67aE66WYCiAqICAtIHJlbW90ZTog6rWs6riAIEFwcHMgU2NyaXB0IOyEnOuyhCjqtazquIAg7Iuc7Yq4KeyXkCDsoIDsnqUsIENsYXVkZSBBSSDroZwg67aE66WYLCDslYzrprwg7J6Q64+ZIOyeheugpQogKiAgICAgICAgICAgIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOygnOqzte2VmOuptCDsnpDrj5nsnLzroZwgcmVtb3RlLCDslYTri4jrqbQg7ISk7KCV7JeQ7IScIOyEnOuyhCDso7zshozrpbwg7Jew6rKwCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IEwgPSByb290LkJ1ZGdldExvZ2ljOwogIGNvbnN0IFNUT1JBR0VfS0VZID0gJ2J1ZGdldC1hcHAtdjEnOwogIGNvbnN0IFNFUlZFUl9LRVkgPSAnYnVkZ2V0LWFwcC1zZXJ2ZXInOwogIGNvbnN0IE1JR1JBVEVfS0VZID0gJ2J1ZGdldC1hcHAtbWlncmF0ZSc7CgogIGNvbnN0IHVpZCA9ICgpID0+IERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCk7CiAgY29uc3Qgbm93SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpOwoKICBjb25zdCBLRVlfU1RPUkUgPSAnYnVkZ2V0LWFwcC1rZXknOwoKICBmdW5jdGlvbiByZWFkU2VydmVyQ29uZmlnKCkgewogICAgLy8g6rWs6riAIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOykhCDrlYw6IO2CpOuKlCDso7zshowoP2tleT0pIOuYkOuKlCDsnbQg6riw6riw7JeQIOq4sOyWte2VnCDqsJIKICAgIGlmIChyb290Ll9fQlVER0VUX1NFUlZFUl9fKSB7CiAgICAgIGxldCBrZXkgPSByb290Ll9fQlVER0VUX1NFUlZFUl9fLmtleSB8fCAnJzsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoa2V5KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgZWxzZSBrZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShLRVlfU1RPUkUpIHx8ICcnOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog6riw7Ja1IOuquyDtlZjrqbQg66ek67KIIOyeheugpSAqLwogICAgICB9CiAgICAgIHJldHVybiB7IC4uLnJvb3QuX19CVURHRVRfU0VSVkVSX18sIGtleSwgZW1iZWRkZWQ6IHRydWUgfTsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFUlZFUl9LRVkpOwogICAgICBjb25zdCBjID0gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDogbnVsbDsKICAgICAgcmV0dXJuIGMgJiYgYy51cmwgJiYgYy5rZXkgPyBjIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBjb25zdCBzZXJ2ZXIgPSByZWFkU2VydmVyQ29uZmlnKCk7CgogIGNvbnN0IHN0b3JlID0gewogICAgbW9kZTogc2VydmVyID8gJ3JlbW90ZScgOiAnbG9jYWwnLAogICAgc2VydmVyLAogICAgYWlFbmFibGVkOiBmYWxzZSwKICAgIGFpTW9kZWw6ICcnLAogICAgYWlNb2RlbHM6IFtdLAogICAgYWlFcnJvcjogJycsCiAgICBzZXJ2aWNlVXJsOiBzZXJ2ZXIgPyBzZXJ2ZXIudXJsIDogJycsCiAgICBzdGF0ZTogTC5kZWZhdWx0U3RhdGUoKSwKICAgIG9uRXJyb3I6ICgpID0+IHt9LAogIH07CgogIGxldCBtZXRhVGltZXIgPSBudWxsOwoKICBmdW5jdGlvbiBjYWxsQXBpKGFjdGlvbiwgcGF5bG9hZCwgdGFyZ2V0ID0gc2VydmVyKSB7CiAgICBjb25zdCByZXEgPSB7IGtleTogdGFyZ2V0LmtleSwgYWN0aW9uLCBwYXlsb2FkOiBwYXlsb2FkIHx8IHt9IH07CiAgICBjb25zdCB1bndyYXAgPSAocikgPT4gewogICAgICBpZiAoIXIgfHwgIXIub2spIHRocm93IG5ldyBFcnJvcigociAmJiByLmVycm9yKSB8fCAn7ISc67KEIOydkeuLtSDsmKTrpZgnKTsKICAgICAgcmV0dXJuIHI7CiAgICB9OwogICAgaWYgKHRhcmdldCA9PT0gc2VydmVyICYmIHJvb3QuZ29vZ2xlICYmIHJvb3QuZ29vZ2xlLnNjcmlwdCAmJiByb290Lmdvb2dsZS5zY3JpcHQucnVuKSB7CiAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgICAgcm9vdC5nb29nbGUuc2NyaXB0LnJ1bgogICAgICAgICAgLndpdGhTdWNjZXNzSGFuZGxlcigocikgPT4gewogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHJlc29sdmUodW53cmFwKHIpKTsKICAgICAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgICAgIHJlamVjdChlKTsKICAgICAgICAgICAgfQogICAgICAgICAgfSkKICAgICAgICAgIC53aXRoRmFpbHVyZUhhbmRsZXIocmVqZWN0KQogICAgICAgICAgLmFwaShyZXEpOwogICAgICB9KTsKICAgIH0KICAgIC8vIHRleHQvcGxhaW4g7Jy866GcIOuztOuCtOuptCBDT1JTIOyCrOyghCDsmpTssq0g7JeG7J20IEFwcHMgU2NyaXB0IOuhnCDrs7Trgrwg7IiYIOyeiOuLpAogICAgcmV0dXJuIGZldGNoKHRhcmdldC51cmwsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcSkgfSkKICAgICAgLnRoZW4oKHIpID0+IHIuanNvbigpKQogICAgICAudGhlbih1bndyYXApOwogIH0KCiAgZnVuY3Rpb24gbWV0YU9mKHMpIHsKICAgIGNvbnN0IHsgdHJhbnNhY3Rpb25zLCAuLi5tZXRhIH0gPSBzOwogICAgcmV0dXJuIG1ldGE7CiAgfQoKICBmdW5jdGlvbiBwbGFuRm9yRGF0ZShkYXRlKSB7CiAgICByZXR1cm4gTC5wbGFuRm9yKHN0b3JlLnN0YXRlLCBMLmdldFBlcmlvZChkYXRlLCBzdG9yZS5zdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KTsKICB9CgogIGZ1bmN0aW9uIHNhdmVMb2NhbCgpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNUT1JBR0VfS0VZLCBKU09OLnN0cmluZ2lmeShzdG9yZS5zdGF0ZSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcign7KCA7J6l7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4g67iM65287Jqw7KCAIOyggOyepeqzteqwhCDshKTsoJXsnYQg7ZmV7J247ZWY7IS47JqULicpKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlYWRMb2NhbFN0YXRlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oU1RPUkFHRV9LRVkpOwogICAgICByZXR1cm4gcmF3ID8gTC5ub3JtYWxpemVTdGF0ZShKU09OLnBhcnNlKHJhdykpIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBhcHBseVN0YXR1cyhyKSB7CiAgICBzdG9yZS5haUVuYWJsZWQgPSAhIXIuYWk7CiAgICBzdG9yZS5haU1vZGVsID0gci5tb2RlbCB8fCAnJzsKICAgIHN0b3JlLmFpTW9kZWxzID0gci5tb2RlbHMgfHwgW107CiAgICBzdG9yZS5haUVycm9yID0gci5sYXN0RXJyb3IgfHwgJyc7CiAgICBpZiAoci51cmwpIHN0b3JlLnNlcnZpY2VVcmwgPSByLnVybDsKICB9CgogIGZ1bmN0aW9uIGlzRXhwZW5zZShpdCkgewogICAgcmV0dXJuICFpdC5raW5kIHx8IGl0LmtpbmQgPT09ICdleHBlbnNlJzsKICB9CgogIE9iamVjdC5hc3NpZ24oc3RvcmUsIHsKICAgIHBsYW5Gb3JEYXRlLAogICAgcmVhZExvY2FsU3RhdGUsCgogICAgYXN5bmMgaW5pdCgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICBzdG9yZS5zdGF0ZSA9IHJlYWRMb2NhbFN0YXRlKCkgfHwgTC5kZWZhdWx0U3RhdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ2xvYWQnKTsKICAgICAgc3RvcmUuc3RhdGUgPSBMLm5vcm1hbGl6ZVN0YXRlKHIuc3RhdGUpOwogICAgICBhcHBseVN0YXR1cyhyKTsKICAgIH0sCgogICAgLy8g7LKY7J2MIOygkeyGje2VoCDrlYwg7J6F66Cl7ZWcIO2CpOqwgCDrp57ripTsp4Ag7ZmV7J247ZWY6rOgIOq4sOyWte2VnOuLpAogICAgYXN5bmMgdXNlS2V5KGtleSkgewogICAgICBjb25zdCBwcmV2ID0gc2VydmVyLmtleTsKICAgICAgc2VydmVyLmtleSA9IGtleTsKICAgICAgdHJ5IHsKICAgICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdwaW5nJykpOwogICAgICAgIHRyeSB7CiAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgLyog66y07IucICovCiAgICAgICAgfQogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgc2VydmVyLmtleSA9IHByZXY7CiAgICAgICAgdGhyb3cgZTsKICAgICAgfQogICAgfSwKCiAgICBmb3JnZXRLZXkoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oS0VZX1NUT1JFKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIC8qIOustOyLnCAqLwogICAgICB9CiAgICB9LAoKICAgIGFzeW5jIHNldEFwaUtleShhcGlLZXkpIHsKICAgICAgYXBwbHlTdGF0dXMoYXdhaXQgY2FsbEFwaSgnc2V0QXBpS2V5JywgeyBhcGlLZXkgfSkpOwogICAgfSwKCiAgICBhc3luYyBzZXRNb2RlbChtb2RlbCkgewogICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdzZXRNb2RlbCcsIHsgbW9kZWwgfSkpOwogICAgfSwKCiAgICAvLyDqs4Ttmo3Ct+yImOyehcK36rOE7KKMwrftlZnsirUg7KCV67O0IOyggOyepS4g7ISc67KE7JeQ64qUIOyeheugpeydtCDrqYjstpgg65KkIO2VnCDrsojsl5Ag67O064K464ukLgogICAgc2F2ZU1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSByZXR1cm4gc2F2ZUxvY2FsKCk7CiAgICAgIGNsZWFyVGltZW91dChtZXRhVGltZXIpOwogICAgICBtZXRhVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHN0b3JlLmZsdXNoTWV0YSgpLCA3MDApOwogICAgfSwKCiAgICBoYXNQZW5kaW5nTWV0YSgpIHsKICAgICAgcmV0dXJuICEhbWV0YVRpbWVyOwogICAgfSwKCiAgICBhc3luYyBmbHVzaE1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnIHx8ICFtZXRhVGltZXIpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KG1ldGFUaW1lcik7CiAgICAgIG1ldGFUaW1lciA9IG51bGw7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgY2FsbEFwaSgnc2F2ZU1ldGEnLCB7IG1ldGE6IG1ldGFPZihzdG9yZS5zdGF0ZSkgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcihg7ISk7KCVIOyggOyepSDsi6TtjKg6ICR7ZS5tZXNzYWdlfWApKTsKICAgICAgfQogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW99XSDihpIgW3tjYXRlZ29yeUlkLCBtZXRob2R9XQogICAgYXN5bmMgY2xhc3NpZnkoaXRlbXMpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICByZXR1cm4gaXRlbXMubWFwKChpdCkgPT4gTC5jbGFzc2lmeUxvY2FsKGl0Lm1lbW8sIHBsYW5Gb3JEYXRlKGl0LmRhdGUpLmNhdGVnb3JpZXMsIHN0b3JlLnN0YXRlLm1lcmNoYW50TWFwKSk7CiAgICAgIH0KICAgICAgYXdhaXQgc3RvcmUuZmx1c2hNZXRhKCk7CiAgICAgIHJldHVybiAoYXdhaXQgY2FsbEFwaSgnY2xhc3NpZnknLCB7IGl0ZW1zIH0pKS5yZXN1bHRzOwogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW8sIGtpbmQsIGFjY291bnRJZCwgY2F0ZWdvcnlJZCAoJ19fYXV0bycg7J2066m0IOyekOuPmSDrtoTrpZgpLCBtZXRob2QsIHNvdXJjZSwgcmF3fV0KICAgIGFzeW5jIGFkZFRyYW5zYWN0aW9ucyhpdGVtcykgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIGNvbnN0IGF1dG8gPSBpdGVtcy5maWx0ZXIoKGl0KSA9PiBpc0V4cGVuc2UoaXQpICYmIGl0LmNhdGVnb3J5SWQgPT09ICdfX2F1dG8nKTsKICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeShhdXRvKTsKICAgICAgICBhdXRvLmZvckVhY2goKGl0LCBpKSA9PiBPYmplY3QuYXNzaWduKGl0LCByZXNbaV0pKTsKICAgICAgICBjb25zdCBub3cgPSBub3dJU08oKTsKICAgICAgICBjb25zdCBhZGRlZCA9IGl0ZW1zLm1hcCgoaXQpID0+IHsKICAgICAgICAgIGNvbnN0IGV4cGVuc2UgPSBpc0V4cGVuc2UoaXQpOwogICAgICAgICAgY29uc3QgY2F0ZWdvcnlJZCA9IGV4cGVuc2UgJiYgaXQuY2F0ZWdvcnlJZCAmJiBpdC5jYXRlZ29yeUlkICE9PSAnX19hdXRvJyA/IGl0LmNhdGVnb3J5SWQgOiBudWxsOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgaWQ6IHVpZCgpLAogICAgICAgICAgICBkYXRlOiBpdC5kYXRlLAogICAgICAgICAgICBhbW91bnQ6IGl0LmFtb3VudCwKICAgICAgICAgICAgbWVtbzogaXQubWVtbywKICAgICAgICAgICAgY2F0ZWdvcnlJZCwKICAgICAgICAgICAgbWV0aG9kOiBjYXRlZ29yeUlkID8gaXQubWV0aG9kIHx8ICdtYW51YWwnIDogbnVsbCwKICAgICAgICAgICAgc291cmNlOiBpdC5zb3VyY2UgfHwgJ2FwcCcsCiAgICAgICAgICAgIHJhdzogaXQucmF3IHx8ICcnLAogICAgICAgICAgICBjcmVhdGVkQXQ6IG5vdywKICAgICAgICAgICAgY2xhc3NpZmllZEF0OiBub3csCiAgICAgICAgICAgIGtpbmQ6IGV4cGVuc2UgPyAnZXhwZW5zZScgOiBpdC5raW5kLAogICAgICAgICAgICBhY2NvdW50SWQ6IGl0LmFjY291bnRJZCB8fCBudWxsLAogICAgICAgICAgfTsKICAgICAgICB9KTsKICAgICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMucHVzaCguLi5hZGRlZCk7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuIGFkZGVkOwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgnYWRkVHJhbnNhY3Rpb25zJywgeyBpdGVtcyB9KTsKICAgICAgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLnB1c2goLi4uci5hZGRlZCk7CiAgICAgIHJldHVybiByLmFkZGVkOwogICAgfSwKCiAgICBhc3luYyB1cGRhdGVUcmFuc2FjdGlvbihpZCwgcGF0Y2gpIHsKICAgICAgY29uc3QgdCA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSB7CiAgICAgICAgT2JqZWN0LmFzc2lnbih0LCBwYXRjaCwgeyBjbGFzc2lmaWVkQXQ6IG5vd0lTTygpIH0pOwogICAgICAgIHNhdmVMb2NhbCgpOwogICAgICAgIHJldHVybiB0OwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgndXBkYXRlVHJhbnNhY3Rpb24nLCB7IGlkLCBwYXRjaCB9KTsKICAgICAgT2JqZWN0LmFzc2lnbih0LCByLnR4KTsKICAgICAgcmV0dXJuIHQ7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZVRyYW5zYWN0aW9uKGlkKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAncmVtb3RlJykgYXdhaXQgY2FsbEFwaSgnZGVsZXRlVHJhbnNhY3Rpb24nLCB7IGlkIH0pOwogICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMgPSBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSBzYXZlTG9jYWwoKTsKICAgIH0sCgogICAgLy8g6riw6rCEIOyViOydmCDsp4DstpzsnYQg6re4IOq4sOqwhCDqs4Ttmo3sl5Ag66ee7LawIOuLpOyLnCDrtoTrpZguIOuwmO2ZmDog64uk7IucIOu2hOulmO2VnCDsp4Dstpwg7IiYCiAgICBhc3luYyByZWNsYXNzaWZ5KHBlcmlvZCwgb25seVVuY2xhc3NpZmllZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIHsKICAgICAgICBhd2FpdCBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgncmVjbGFzc2lmeScsIHsgc3RhcnQ6IHBlcmlvZC5zdGFydCwgZW5kOiBwZXJpb2QuZW5kLCBvbmx5VW5jbGFzc2lmaWVkIH0pOwogICAgICAgIGZvciAoY29uc3QgdSBvZiByLnVwZGF0ZWQpIE9iamVjdC5hc3NpZ24oc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLmZpbmQoKHQpID0+IHQuaWQgPT09IHUuaWQpIHx8IHt9LCB1KTsKICAgICAgICByZXR1cm4gci51cGRhdGVkLmxlbmd0aDsKICAgICAgfQogICAgICBjb25zdCBwbGFuID0gcGxhbkZvckRhdGUocGVyaW9kLnN0YXJ0KTsKICAgICAgY29uc3Qga25vd24gPSBuZXcgU2V0KHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgICAgY29uc3QgdGFyZ2V0cyA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHsKICAgICAgICBpZiAodC5kYXRlIDwgcGVyaW9kLnN0YXJ0IHx8IHQuZGF0ZSA+IHBlcmlvZC5lbmQgfHwgTC5raW5kT2YodCkgIT09ICdleHBlbnNlJykgcmV0dXJuIGZhbHNlOwogICAgICAgIGNvbnN0IGV4aXN0cyA9IGtub3duLmhhcyh0LmNhdGVnb3J5SWQpOwogICAgICAgIHJldHVybiBvbmx5VW5jbGFzc2lmaWVkID8gIWV4aXN0cyA6ICEodC5tZXRob2QgPT09ICdtYW51YWwnICYmIGV4aXN0cyk7CiAgICAgIH0pOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeSh0YXJnZXRzKTsKICAgICAgY29uc3Qgbm93ID0gbm93SVNPKCk7CiAgICAgIHRhcmdldHMuZm9yRWFjaCgodCwgaSkgPT4gT2JqZWN0LmFzc2lnbih0LCByZXNbaV0sIHsgY2xhc3NpZmllZEF0OiBub3cgfSkpOwogICAgICBzYXZlTG9jYWwoKTsKICAgICAgcmV0dXJuIHRhcmdldHMubGVuZ3RoOwogICAgfSwKCiAgICBhc3luYyByZWZyZXNoKCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIGF3YWl0IHN0b3JlLmluaXQoKTsKICAgIH0sCgogICAgLy8g7ISc67KEIOyXsOqysCDtmZXsnbggKOyXsOqysCDsoITsnbTrnbwg7KO87IaM7JmAIO2CpOulvCDsp4HsoJEg67Cb64qU64ukKQogICAgcGluZyh1cmwsIGtleSkgewogICAgICByZXR1cm4gY2FsbEFwaSgncGluZycsIHt9LCB7IHVybCwga2V5IH0pOwogICAgfSwKCiAgICBjb25uZWN0KHVybCwga2V5LCBtaWdyYXRlKSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFUlZFUl9LRVksIEpTT04uc3RyaW5naWZ5KHsgdXJsLCBrZXkgfSkpOwogICAgICBpZiAobWlncmF0ZSkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUlHUkFURV9LRVksICcxJyk7CiAgICB9LAoKICAgIGRpc2Nvbm5lY3QoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU0VSVkVSX0tFWSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICAvKiDrrLTsi5wgKi8KICAgICAgfQogICAgfSwKCiAgICAvLyDshJzrsoTsl5Ag7Jew6rKw7ZWcIOynge2bhCDtlZwg67KIOiDsnbQg6riw6riw7JeQIOyeiOuNmCDrjbDsnbTthLDrpbwg7Jiu6ri47KeACiAgICB0YWtlTWlncmF0aW9uKCkgewogICAgICB0cnkgewogICAgICAgIGlmIChzdG9yZS5tb2RlICE9PSAncmVtb3RlJyB8fCBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNSUdSQVRFX0tFWSkgIT09ICcxJykgcmV0dXJuIG51bGw7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oTUlHUkFURV9LRVkpOwogICAgICAgIHJldHVybiByZWFkTG9jYWxTdGF0ZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgIH0sCgogICAgLy8g67Cx7JeFKOuYkOuKlCDsnbQg6riw6riwIOuNsOydtO2EsCkg67aI65+s7Jik6riwCiAgICBhc3luYyBpbXBvcnRTdGF0ZShpbXBvcnRlZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIHN0b3JlLnN0YXRlID0gaW1wb3J0ZWQ7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IHR4cyA9IGltcG9ydGVkLnRyYW5zYWN0aW9uczsKICAgICAgc3RvcmUuc3RhdGUgPSB7IC4uLmltcG9ydGVkLCB0cmFuc2FjdGlvbnM6IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucyB9OwogICAgICBhd2FpdCBjYWxsQXBpKCdzYXZlTWV0YScsIHsgbWV0YTogbWV0YU9mKHN0b3JlLnN0YXRlKSB9KTsKICAgICAgY29uc3QgZnJlc2ggPSB0eHMuZmlsdGVyKCh0KSA9PiAhTC5pc0R1cGxpY2F0ZSh0LCBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMpKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmcmVzaC5sZW5ndGg7IGkgKz0gMjAwKSB7CiAgICAgICAgYXdhaXQgc3RvcmUuYWRkVHJhbnNhY3Rpb25zKAogICAgICAgICAgZnJlc2guc2xpY2UoaSwgaSArIDIwMCkubWFwKCh0KSA9PiAoewogICAgICAgICAgICBkYXRlOiB0LmRhdGUsCiAgICAgICAgICAgIGFtb3VudDogdC5hbW91bnQsCiAgICAgICAgICAgIG1lbW86IHQubWVtbywKICAgICAgICAgICAga2luZDogTC5raW5kT2YodCksCiAgICAgICAgICAgIGFjY291bnRJZDogdC5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICAgICAgY2F0ZWdvcnlJZDogdC5jYXRlZ29yeUlkIHx8IG51bGwsCiAgICAgICAgICAgIG1ldGhvZDogdC5tZXRob2QgfHwgKHQuY2F0ZWdvcnlJZCA/ICdtYW51YWwnIDogbnVsbCksCiAgICAgICAgICAgIHNvdXJjZTogdC5zb3VyY2UgfHwgJ2ltcG9ydCcsCiAgICAgICAgICAgIHJhdzogdC5yYXcgfHwgJycsCiAgICAgICAgICB9KSkKICAgICAgICApOwogICAgICB9CiAgICB9LAoKICAgIHJlc2V0KCkgewogICAgICBzdG9yZS5zdGF0ZSA9IEwuZGVmYXVsdFN0YXRlKCk7CiAgICAgIHNhdmVMb2NhbCgpOwogICAgfSwKICB9KTsKCiAgcm9vdC5CdWRnZXRTdG9yZSA9IHN0b3JlOwp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/app.js\", \"Lyog7KeA7LacIOq0gOumrCDslbEg7ZmU66m0LiDqs4TsgrDsnYAganMvbG9naWMuanMsIOyggOyepeydgCBqcy9zdG9yZS5qcywg7LCo7Yq464qUIGpzL2NoYXJ0cy5qcyAqLwooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgTCA9IHdpbmRvdy5CdWRnZXRMb2dpYzsKICBjb25zdCBDID0gd2luZG93LkJ1ZGdldENoYXJ0czsKICBjb25zdCBzdG9yZSA9IHdpbmRvdy5CdWRnZXRTdG9yZTsKICBjb25zdCBTID0gKCkgPT4gc3RvcmUuc3RhdGU7CgogIC8vIC0tLS0tLS0tLS0g7Jyg7Yu4IC0tLS0tLS0tLS0KCiAgY29uc3QgJCA9IChzZWwpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTsKICBjb25zdCAkJCA9IChzZWwpID0+IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCldOwogIGNvbnN0IHdvbiA9IChuKSA9PiBgJHtNYXRoLnJvdW5kKG4pLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeybkGA7CiAgY29uc3QgdWlkID0gKCkgPT4gRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KTsKICBjb25zdCBub3dJU08gPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CgogIGZ1bmN0aW9uIGVzYyhzKSB7CiAgICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgKGMpID0+ICh7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjXSkpOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRJbnB1dChzKSB7CiAgICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHMgfHwgJycpLnJlcGxhY2UoL1teXGQtXS9nLCAnJyk7CiAgICBpZiAoIWNsZWFuZWQgfHwgY2xlYW5lZCA9PT0gJy0nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IG4gPSBOdW1iZXIoY2xlYW5lZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlKGlzbykgewogICAgY29uc3QgeyB5LCBtLCBkIH0gPSBMLnBhcnNlSVNPKGlzbyk7CiAgICByZXR1cm4gYCR7eX0uJHtTdHJpbmcobSkucGFkU3RhcnQoMiwgJzAnKX0uJHtTdHJpbmcoZCkucGFkU3RhcnQoMiwgJzAnKX1gOwogIH0KCiAgY29uc3QgRE9XID0gWyfsnbwnLCAn7JuUJywgJ+2ZlCcsICfsiJgnLCAn66qpJywgJ+q4iCcsICfthqAnXTsKICBmdW5jdGlvbiBkb3dPZihpc28pIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gTC5wYXJzZUlTTyhpc28pOwogICAgcmV0dXJuIG5ldyBEYXRlKERhdGUuVVRDKHksIG0gLSAxLCBkKSkuZ2V0VVRDRGF5KCk7CiAgfQoKICBmdW5jdGlvbiBmbXREYXkoaXNvKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08oaXNvKTsKICAgIHJldHVybiBgJHttfeyblCAke2R97J28ICR7RE9XW2Rvd09mKGlzbyldfeyalOydvGA7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlVGltZShpc29UaW1lKSB7CiAgICBpZiAoIWlzb1RpbWUpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShpc29UaW1lKTsKICAgIGlmIChpc05hTihkKSkgcmV0dXJuICcnOwogICAgcmV0dXJuIGAke2QuZ2V0TW9udGgoKSArIDF9LyR7ZC5nZXREYXRlKCl9ICR7U3RyaW5nKGQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcoZC5nZXRNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICB9CgogIGxldCB0b2FzdFRpbWVyOwogIGZ1bmN0aW9uIHRvYXN0KG1zZywgbXMgPSAyNjAwKSB7CiAgICBjb25zdCBlbCA9ICQoJyN0b2FzdCcpOwogICAgZWwudGV4dENvbnRlbnQgPSBtc2c7CiAgICBlbC5oaWRkZW4gPSBmYWxzZTsKICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsKICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IChlbC5oaWRkZW4gPSB0cnVlKSwgbXMpOwogIH0KICBzdG9yZS5vbkVycm9yID0gKGUpID0+IHRvYXN0KGUubWVzc2FnZSwgNTAwMCk7CgogIGxldCBidXN5Q291bnQgPSAwOwogIGFzeW5jIGZ1bmN0aW9uIGJ1c3kobGFiZWwsIGZuKSB7CiAgICBidXN5Q291bnQgKz0gMTsKICAgICQoJyNidXN5JykuaGlkZGVuID0gZmFsc2U7CiAgICBpZiAobGFiZWwpIHRvYXN0KGxhYmVsLCA2MDAwMCk7CiAgICB0cnkgewogICAgICByZXR1cm4gYXdhaXQgZm4oKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgdG9hc3QoYOyYpOulmDogJHtlLm1lc3NhZ2UgfHwgZX1gLCA1MDAwKTsKICAgICAgdGhyb3cgZTsKICAgIH0gZmluYWxseSB7CiAgICAgIGJ1c3lDb3VudCAtPSAxOwogICAgICBpZiAoIWJ1c3lDb3VudCkgJCgnI2J1c3knKS5oaWRkZW4gPSB0cnVlOwogICAgICBpZiAobGFiZWwgJiYgJCgnI3RvYXN0JykudGV4dENvbnRlbnQgPT09IGxhYmVsKSAkKCcjdG9hc3QnKS5oaWRkZW4gPSB0cnVlOwogICAgfQogIH0KCiAgLy8gYnVzeSDqsIAg7J2066+4IOyYpOulmOulvCDslYzroLjsnLzrr4DroZwg7J2067Kk7Yq4IO2VuOuTpOufrOyXkOyEnOuKlCDsgrztgqjri6QKICBjb25zdCBxdWlldCA9IChmbikgPT4gKC4uLmFyZ3MpID0+IFByb21pc2UucmVzb2x2ZShmbiguLi5hcmdzKSkuY2F0Y2goKCkgPT4ge30pOwoKICBmdW5jdGlvbiBmb3JtYXRPbkJsdXIoaW5wdXQpIHsKICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiB7CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KGlucHV0LnZhbHVlKTsKICAgICAgaWYgKG4gIT09IG51bGwpIGlucHV0LnZhbHVlID0gbi50b0xvY2FsZVN0cmluZygna28tS1InKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gY29weVRleHQodGV4dCwgaW5wdXQpIHsKICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB0b2FzdCgn67O17IKs7ZaI7Iq164uI64ukLicpOwogICAgY29uc3QgZmFsbGJhY2sgPSAoKSA9PiB7CiAgICAgIGlucHV0LnNlbGVjdCgpOwogICAgICB0cnkgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjb3B5Jyk7CiAgICAgICAgZG9uZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgdG9hc3QoJ+q4uOqyjCDriIzrn6wg7KeB7KCRIOuzteyCrO2VtCDso7zshLjsmpQuJyk7CiAgICAgIH0KICAgIH07CiAgICBpZiAobmF2aWdhdG9yLmNsaXBib2FyZCkgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCkudGhlbihkb25lLCBmYWxsYmFjayk7CiAgICBlbHNlIGZhbGxiYWNrKCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyDge2DnCAtLS0tLS0tLS0tCgogIGxldCBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCAxKTsKICBsZXQgY3VycmVudFBhZ2UgPSAnaG9tZSc7CiAgbGV0IHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgY29uc3QgbGlzdFN0YXRlID0geyBzZWFyY2g6ICcnLCBraW5kOiAnYWxsJywgY2F0ZWdvcnk6ICdhbGwnLCBhY2NvdW50OiAnYWxsJyB9OwogIGxldCBtYW51YWxLaW5kID0gJ2V4cGVuc2UnOwoKICBjb25zdCBwbGFuRm9yRGF0ZSA9IChkYXRlKSA9PiBzdG9yZS5wbGFuRm9yRGF0ZShkYXRlKTsKICBjb25zdCBjdXJyZW50UGxhbiA9ICgpID0+IEwucGxhbkZvcihTKCksIGN1cnJlbnRQZXJpb2Qua2V5KTsKCiAgZnVuY3Rpb24gY2F0ZWdvcnlJbmZvKGlkLCBjYXRlZ29yaWVzID0gY3VycmVudFBsYW4oKS5jYXRlZ29yaWVzKSB7CiAgICBjb25zdCBpID0gY2F0ZWdvcmllcy5maW5kSW5kZXgoKGMpID0+IGMuaWQgPT09IGlkKTsKICAgIHJldHVybiBpID49IDAgPyB7IG5hbWU6IGNhdGVnb3JpZXNbaV0ubmFtZSwgY29sb3JJbmRleDogaSB9IDogeyBuYW1lOiAn66+467aE66WYJywgY29sb3JJbmRleDogLTEgfTsKICB9CgogIGZ1bmN0aW9uIGFjY291bnROYW1lKGlkKSB7CiAgICBjb25zdCBhID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgIHJldHVybiBhID8gYS5uYW1lIHx8IGAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+y5tOuTnCcgOiAn6rOE7KKMJ30gJHthLmxhc3Q0fWAgOiAnJzsKICB9CgogIGZ1bmN0aW9uIGNhdGVnb3J5T3B0aW9ucyhjYXRlZ29yaWVzLCBzZWxlY3RlZCwgeyBpbmNsdWRlQXV0byA9IGZhbHNlIH0gPSB7fSkgewogICAgY29uc3Qgb3B0cyA9IFtdOwogICAgaWYgKGluY2x1ZGVBdXRvKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9Il9fYXV0byI+7J6Q64+ZIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfTwvb3B0aW9uPmApOwogICAgb3B0cy5wdXNoKGA8b3B0aW9uIHZhbHVlPSIiICR7IXNlbGVjdGVkID8gJ3NlbGVjdGVkJyA6ICcnfT7rr7jrtoTrpZg8L29wdGlvbj5gKTsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGMuaWQpfSIgJHtjLmlkID09PSBzZWxlY3RlZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKTsKICAgIHJldHVybiBvcHRzLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gYWNjb3VudE9wdGlvbnMoc2VsZWN0ZWQsIGVtcHR5TGFiZWwgPSAn7ISg7YOdIOyViCDtlagnKSB7CiAgICByZXR1cm4gW2A8b3B0aW9uIHZhbHVlPSIiPiR7ZW1wdHlMYWJlbH08L29wdGlvbj5gXQogICAgICAuY29uY2F0KFMoKS5hY2NvdW50cy5tYXAoKGEpID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhhLmlkKX0iICR7YS5pZCA9PT0gc2VsZWN0ZWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGFjY291bnROYW1lKGEuaWQpKX08L29wdGlvbj5gKSkKICAgICAgLmpvaW4oJycpOwogIH0KCiAgY29uc3QgTUVUSE9EX0xBQkVMID0geyBhaTogJ0FJJywgbGVhcm5lZDogJ+q4sOyWtScsIGtleXdvcmQ6ICftgqTsm4zrk5wnLCBtYW51YWw6ICfsp4HsoJEnIH07CiAgY29uc3QgbWV0aG9kVGFnID0gKG0pID0+IChtICYmIE1FVEhPRF9MQUJFTFttXSA/IGA8c3BhbiBjbGFzcz0idGFnIj4ke01FVEhPRF9MQUJFTFttXX08L3NwYW4+YCA6ICcnKTsKCiAgLy8gLS0tLS0tLS0tLSDtjpjsnbTsp4Ag7J2064+ZIC0tLS0tLS0tLS0KCiAgY29uc3QgUEFHRVMgPSB7CiAgICBob21lOiB7IHRpdGxlOiAn7ZmIJywgcGVyaW9kOiB0cnVlIH0sCiAgICBjYWxlbmRhcjogeyB0aXRsZTogJ+uLrOugpScsIHBlcmlvZDogdHJ1ZSB9LAogICAgbGlzdDogeyB0aXRsZTogJ+uCtOyXrScsIHBlcmlvZDogdHJ1ZSB9LAogICAgc29ydDogeyB0aXRsZTogJ+uvuOu2hOulmCDsoJXrpqwnLCBwZXJpb2Q6IHRydWUgfSwKICAgIHJlcG9ydDogeyB0aXRsZTogJ+umrO2PrO2KuCcsIHBlcmlvZDogdHJ1ZSB9LAogICAgYXNzZXRzOiB7IHRpdGxlOiAn7J6Q7IKwJywgcGVyaW9kOiB0cnVlIH0sCiAgICBwbGFuOiB7IHRpdGxlOiAn7JiI7IKwIOqzhO2ajScsIHBlcmlvZDogdHJ1ZSB9LAogICAgYWRkOiB7IHRpdGxlOiAn7KeA7LacwrfsiJjsnoUg7J6F66ClJywgcGVyaW9kOiBmYWxzZSB9LAogICAgc2V0dGluZ3M6IHsgdGl0bGU6ICfshKTsoJUnLCBwZXJpb2Q6IGZhbHNlIH0sCiAgfTsKCiAgZnVuY3Rpb24gc2hvd1BhZ2UobmFtZSwgeyBwdXNoID0gdHJ1ZSB9ID0ge30pIHsKICAgIGlmICghUEFHRVNbbmFtZV0pIG5hbWUgPSAnaG9tZSc7CiAgICBjdXJyZW50UGFnZSA9IG5hbWU7CiAgICAkJCgnLnBhZ2UnKS5mb3JFYWNoKChwKSA9PiBwLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHAuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkJCgnLm5hdi1pdGVtJykuZm9yRWFjaCgoYikgPT4gYi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBiLmRhdGFzZXQucGFnZSA9PT0gbmFtZSkpOwogICAgJCQoJy5ib3R0b20tbmF2IFtkYXRhLXBhZ2VdJykuZm9yRWFjaCgoYikgPT4gYi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBiLmRhdGFzZXQucGFnZSA9PT0gbmFtZSkpOwogICAgJCgnI3BhZ2UtdGl0bGUnKS50ZXh0Q29udGVudCA9IFBBR0VTW25hbWVdLnRpdGxlOwogICAgJCgnI3BlcmlvZC1uYXYnKS5oaWRkZW4gPSAhUEFHRVNbbmFtZV0ucGVyaW9kOwogICAgY2xvc2VNZW51KCk7CiAgICAvLyDqtazquIAgQXBwcyBTY3JpcHQg7ZmU66m0KGlmcmFtZSnsspjrn7wg7KO87IaM66W8IOuquyDrsJTqvrjripQg6rOz7JeQ7ISc64+EIOydtOuPmeydgCDrkJjqsowKICAgIHRyeSB7CiAgICAgIGlmIChwdXNoICYmIGxvY2F0aW9uLmhhc2ggIT09IGAjJHtuYW1lfWApIGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsICcnLCBgIyR7bmFtZX1gKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLyog66y07IucICovCiAgICB9CiAgICB3aW5kb3cuc2Nyb2xsVG8oMCwgMCk7CiAgICByZW5kZXIoKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KCkgewogICAgJCgnI3NpZGViYXInKS5jbGFzc0xpc3QuYWRkKCdvcGVuJyk7CiAgICAkKCcjc2NyaW0nKS5oaWRkZW4gPSBmYWxzZTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlTWVudSgpIHsKICAgICQoJyNzaWRlYmFyJykuY2xhc3NMaXN0LnJlbW92ZSgnb3BlbicpOwogICAgJCgnI3NjcmltJykuaGlkZGVuID0gdHJ1ZTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rO17Ya1IOuouOumrCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckNocm9tZSgpIHsKICAgIGNvbnN0IGNoaXAgPSAkKCcjY29ubi1zdGF0dXMnKTsKICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSB7CiAgICAgIGNoaXAudGV4dENvbnRlbnQgPSAn7J20IOq4sOq4sOyXkOunjCDsoIDsnqUnOwogICAgICBjaGlwLmNsYXNzTmFtZSA9ICdjaGlwJzsKICAgIH0gZWxzZSB7CiAgICAgIGNoaXAudGV4dENvbnRlbnQgPSBzdG9yZS5haUVuYWJsZWQgPyAn6rWs6riAIOyLnO2KuCDCtyBBSSDrtoTrpZgnIDogJ+q1rOq4gCDsi5ztirggwrcgQUkg6rq87KeQJzsKICAgICAgY2hpcC5jbGFzc05hbWUgPSBgY2hpcCAke3N0b3JlLmFpRW5hYmxlZCA/ICdvbicgOiAnJ31gOwogICAgfQogICAgJCgnI3JlZnJlc2gtYnRuJykuaGlkZGVuID0gc3RvcmUubW9kZSAhPT0gJ3JlbW90ZSc7CiAgICBjb25zdCB1bnNvcnRlZCA9IEwudW5jbGFzc2lmaWVkQnlQZXJpb2QoUygpKS5yZWR1Y2UoKG4sIGUpID0+IG4gKyBlLmNvdW50LCAwKTsKICAgICQoJyNzb3J0LWNvdW50JykudGV4dENvbnRlbnQgPSB1bnNvcnRlZCA+IDk5ID8gJzk5KycgOiBTdHJpbmcodW5zb3J0ZWQpOwogICAgJCgnI3NvcnQtY291bnQnKS5oaWRkZW4gPSAhdW5zb3J0ZWQ7CgogICAgY29uc3QgcCA9IGN1cnJlbnRQZXJpb2Q7CiAgICAkKCcjcGVyaW9kLXRleHQnKS50ZXh0Q29udGVudCA9IGAke2ZtdERhdGUocC5zdGFydCl9IH4gJHtmbXREYXRlKHAuZW5kKS5zbGljZSg1KX1gOwogICAgY29uc3QgdG9kYXkgPSBMLnRvZGF5SVNPKCk7CiAgICBsZXQgc3ViOwogICAgaWYgKHRvZGF5ID49IHAuc3RhcnQgJiYgdG9kYXkgPD0gcC5lbmQpIHN1YiA9IGDsnbTrsogg6riw6rCEIMK3ICR7TC5kaWZmRGF5cyh0b2RheSwgcC5lbmQpICsgMX3snbwg64Ko7J2MYDsKICAgIGVsc2UgaWYgKHRvZGF5ID4gcC5lbmQpIHN1YiA9ICfsp4Drgpwg6riw6rCEJzsKICAgIGVsc2Ugc3ViID0gJ+uLpOqwgOyYpOuKlCDquLDqsIQnOwogICAgJCgnI3BlcmlvZC1zdWInKS50ZXh0Q29udGVudCA9IHN1YjsKICB9CgogIC8vIC0tLS0tLS0tLS0g7Yi07YyBIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gYXR0YWNoVG9vbHRpcChlbCwgaHRtbCkgewogICAgY29uc3QgdGlwID0gJCgnI3Rvb2x0aXAnKTsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7CiAgICAgIHRpcC5pbm5lckhUTUwgPSBodG1sKCk7CiAgICAgIHRpcC5oaWRkZW4gPSBmYWxzZTsKICAgIH0pOwogICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGUpID0+IHsKICAgICAgY29uc3QgeCA9IE1hdGgubWluKGUuY2xpZW50WCArIDE0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHRpcC5vZmZzZXRXaWR0aCAtIDgpOwogICAgICB0aXAuc3R5bGUubGVmdCA9IGAke3h9cHhgOwogICAgICB0aXAuc3R5bGUudG9wID0gYCR7ZS5jbGllbnRZICsgMTR9cHhgOwogICAgfSk7CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4gKHRpcC5oaWRkZW4gPSB0cnVlKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOqxsOuemCDtlZwg7KSEIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gdHhSb3codCwgeyBlZGl0YWJsZSA9IHRydWUgfSA9IHt9KSB7CiAgICBjb25zdCBraW5kID0gTC5raW5kT2YodCk7CiAgICBjb25zdCBjYXRzID0gcGxhbkZvckRhdGUodC5kYXRlKS5jYXRlZ29yaWVzOwogICAgY29uc3QgaW5mbyA9IGNhdGVnb3J5SW5mbyh0LmNhdGVnb3J5SWQsIGNhdHMpOwogICAgbGV0IGljb247CiAgICBsZXQgYW1vdW50OwogICAgaWYgKGtpbmQgPT09ICdpbmNvbWUnKSB7CiAgICAgIGljb24gPSAnPGRpdiBjbGFzcz0idHgtaWNvbiIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tYWNjZW50KSI+KzwvZGl2Pic7CiAgICAgIGFtb3VudCA9IGA8c3BhbiBjbGFzcz0idHgtYW1vdW50IHBsdXMiPiske3dvbih0LmFtb3VudCl9PC9zcGFuPmA7CiAgICB9IGVsc2UgaWYgKGtpbmQgPT09ICd0cmFuc2ZlcicpIHsKICAgICAgaWNvbiA9ICc8ZGl2IGNsYXNzPSJ0eC1pY29uIGdyYXkiPuKGlDwvZGl2Pic7CiAgICAgIGFtb3VudCA9IGA8c3BhbiBjbGFzcz0idHgtYW1vdW50IG5ldXRyYWwiPiR7d29uKHQuYW1vdW50KX08L3NwYW4+YDsKICAgIH0gZWxzZSB7CiAgICAgIGljb24gPSBgPGRpdiBjbGFzcz0idHgtaWNvbiAke2luZm8uY29sb3JJbmRleCA8IDAgPyAnZ3JheScgOiAnJ30iIHN0eWxlPSIke2luZm8uY29sb3JJbmRleCA+PSAwID8gYGJhY2tncm91bmQ6JHtDLnNlcmllc0NvbG9yKGluZm8uY29sb3JJbmRleCl9YCA6ICcnfSI+JHtlc2MoaW5mby5uYW1lLnNsaWNlKDAsIDEpKX08L2Rpdj5gOwogICAgICBhbW91bnQgPSBgPHNwYW4gY2xhc3M9InR4LWFtb3VudCAke3QuYW1vdW50IDwgMCA/ICdwbHVzJyA6ICcnfSI+JHt0LmFtb3VudCA8IDAgPyAnKycgOiAnJ30ke3dvbihNYXRoLmFicyh0LmFtb3VudCkpfTwvc3Bhbj5gOwogICAgfQogICAgY29uc3QgbWV0YSA9IFtdOwogICAgaWYgKGVkaXRhYmxlKSB7CiAgICAgIC8vIO2VreuqqeqzvCDsooXrpZgo7J6F6riIwrfsnbTssrQp66W8IO2VnCDsubjsl5DshJwg6rOg66W464ukCiAgICAgIGNvbnN0IGN1cnJlbnQgPSBraW5kICE9PSAnZXhwZW5zZScgPyBga2luZDoke2tpbmR9YCA6IGluZm8uY29sb3JJbmRleCA+PSAwID8gdC5jYXRlZ29yeUlkIDogJyc7CiAgICAgIG1ldGEucHVzaChgPHNlbGVjdCBjbGFzcz0idHgtY2F0IiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9Iu2VreuqqSI+CiAgICAgICAgJHtjYXRlZ29yeU9wdGlvbnMoY2F0cywgY3VycmVudCl9CiAgICAgICAgPG9wdGdyb3VwIGxhYmVsPSLsp4DstpzsnbQg7JWE64uYIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtpbmQ6aW5jb21lIiAke2N1cnJlbnQgPT09ICdraW5kOmluY29tZScgPyAnc2VsZWN0ZWQnIDogJyd9Puyeheq4iDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ia2luZDp0cmFuc2ZlciIgJHtjdXJyZW50ID09PSAna2luZDp0cmFuc2ZlcicgPyAnc2VsZWN0ZWQnIDogJyd9PuuCtCDqs4Tsoowg7J207LK0PC9vcHRpb24+CiAgICAgICAgPC9vcHRncm91cD4KICAgICAgPC9zZWxlY3Q+YCk7CiAgICB9IGVsc2UgewogICAgICBtZXRhLnB1c2goZXNjKGtpbmQgPT09ICdpbmNvbWUnID8gJ+yeheq4iCcgOiBraW5kID09PSAndHJhbnNmZXInID8gJ+uCtCDqs4Tsoowg7J207LK0JyA6IGluZm8ubmFtZSkpOwogICAgfQogICAgaWYgKGtpbmQgPT09ICdleHBlbnNlJyAmJiBpbmZvLmNvbG9ySW5kZXggPj0gMCkgbWV0YS5wdXNoKG1ldGhvZFRhZyh0Lm1ldGhvZCkpOwogICAgaWYgKHQuYWNjb3VudElkICYmIGFjY291bnROYW1lKHQuYWNjb3VudElkKSkgbWV0YS5wdXNoKGA8c3Bhbj4ke2VzYyhhY2NvdW50TmFtZSh0LmFjY291bnRJZCkpfTwvc3Bhbj5gKTsKICAgIGlmICh0LnNvdXJjZSA9PT0gJ3NtcycgfHwgdC5zb3VyY2UgPT09ICdiYW5rJykgbWV0YS5wdXNoKGA8c3BhbiBjbGFzcz0idGFnIj4ke3Quc291cmNlID09PSAnYmFuaycgPyAn7J2A7ZaJIOyVjOumvCcgOiAn66y47J6QJ308L3NwYW4+YCk7CiAgICByZXR1cm4gYAogICAgICA8ZGl2IGNsYXNzPSJ0eCI+CiAgICAgICAgJHtpY29ufQogICAgICAgIDxkaXYgY2xhc3M9InR4LW1haW4iPgogICAgICAgICAgPGRpdiBjbGFzcz0idHgtbWVtbyI+JHtlc2ModC5tZW1vKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InR4LW1ldGEiPiR7bWV0YS5qb2luKCcnKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0eC1yaWdodCI+CiAgICAgICAgICAke2Ftb3VudH0KICAgICAgICAgICR7ZWRpdGFibGUgPyBgPGJ1dHRvbiBjbGFzcz0ibGluay1idG4gdHgtZGVsIiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9IuyCreygnCI+7IKt7KCcPC9idXR0b24+YCA6ICcnfQogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj5gOwogIH0KCiAgLy8g64Kg7Kec67OE66GcIOustuydgCDrqqnroZ0KICBmdW5jdGlvbiB0eEdyb3Vwcyh0eHMsIG9wdHMpIHsKICAgIGNvbnN0IHNvcnRlZCA9IFsuLi50eHNdLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBjb25zdCBncm91cHMgPSBbXTsKICAgIGZvciAoY29uc3QgdCBvZiBzb3J0ZWQpIHsKICAgICAgbGV0IGcgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdOwogICAgICBpZiAoIWcgfHwgZy5kYXRlICE9PSB0LmRhdGUpIGdyb3Vwcy5wdXNoKChnID0geyBkYXRlOiB0LmRhdGUsIGl0ZW1zOiBbXSB9KSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgIH0KICAgIHJldHVybiBncm91cHMKICAgICAgLm1hcCgoZykgPT4gewogICAgICAgIGNvbnN0IHNwZW50ID0gZy5pdGVtcy5maWx0ZXIoKHQpID0+IEwua2luZE9mKHQpID09PSAnZXhwZW5zZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgICAgICByZXR1cm4gYDxkaXYgY2xhc3M9InR4LWRhdGUiPjxzcGFuPiR7Zm10RGF5KGcuZGF0ZSl9PC9zcGFuPjxzcGFuPiR7c3BlbnQgPyBg7KeA7LacICR7d29uKHNwZW50KX1gIDogJyd9PC9zcGFuPjwvZGl2PiR7Zy5pdGVtcy5tYXAoKHQpID0+IHR4Um93KHQsIG9wdHMpKS5qb2luKCcnKX1gOwogICAgICB9KQogICAgICAuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBiaW5kVHhFdmVudHMoY29udGFpbmVyKSB7CiAgICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnLnR4LWNhdCcpLmZvckVhY2goKHMpID0+IHMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB0ID0gUygpLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBzLmRhdGFzZXQuaWQpOwogICAgICBpZiAocy52YWx1ZS5zdGFydHNXaXRoKCdraW5kOicpKSB7CiAgICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS51cGRhdGVUcmFuc2FjdGlvbih0LmlkLCB7IGtpbmQ6IHMudmFsdWUuc2xpY2UoNSksIGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9KSk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IGtleSA9IEwubm9ybWFsaXplTWVyY2hhbnQodC5tZW1vKTsKICAgICAgaWYgKHMudmFsdWUpIFMoKS5tZXJjaGFudE1hcFtrZXldID0gcy52YWx1ZTsKICAgICAgZWxzZSBkZWxldGUgUygpLm1lcmNoYW50TWFwW2tleV07CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kOiAnZXhwZW5zZScsIGNhdGVnb3J5SWQ6IHMudmFsdWUgfHwgbnVsbCwgbWV0aG9kOiBzLnZhbHVlID8gJ21hbnVhbCcgOiBudWxsIH0pKTsKICAgICAgdG9hc3QoYCcke3QubWVtb30nIOydgCjripQpIOyVnuycvOuhnCAke2NhdGVnb3J5SW5mbyh0LmNhdGVnb3J5SWQsIHBsYW5Gb3JEYXRlKHQuZGF0ZSkuY2F0ZWdvcmllcykubmFtZX0o7Jy8KeuhnCDrtoTrpZjtlanri4jri6QuYCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpKTsKICAgIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCcudHgtZGVsJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgdCA9IFMoKS50cmFuc2FjdGlvbnMuZmluZCgoeCkgPT4geC5pZCA9PT0gYi5kYXRhc2V0LmlkKTsKICAgICAgaWYgKCFjb25maXJtKGAnJHt0Lm1lbW99JyAke3dvbih0LmFtb3VudCl9IOuCtOyXreydhCDsgq3soJztlaDquYzsmpQ/YCkpIHJldHVybjsKICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS5kZWxldGVUcmFuc2FjdGlvbih0LmlkKSk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7ZmIIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVySW5jb21lQm94KHN1bSkgewogICAgY29uc3QgYm94ID0gJCgnI2luY29tZS1ib3gnKTsKICAgIGNvbnN0IHByZXYgPSBMLnNoaWZ0UGVyaW9kKGN1cnJlbnRQZXJpb2QsIC0xLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgY29uc3QgcHJldkluY29tZSA9IFMoKS5pbmNvbWVzW3ByZXYua2V5XTsKCiAgICBpZiAoIXN1bS5oYXNJbmNvbWUgfHwgYm94LmRhdGFzZXQuZWRpdGluZyA9PT0gJzEnKSB7CiAgICAgIGJveC5jbGFzc0xpc3QuYWRkKCdpbmNvbWUtcHJvbXB0Jyk7CiAgICAgIGNvbnN0IHJlY2VpdmVkID0gc3VtLmluY29tZVJlY2VpdmVkID4gMCA/IGA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imdob3N0LWJ0biIgaWQ9ImluY29tZS1yZWNlaXZlZCI+67Cb7J2AIOyeheq4iCDtlanqs4TroZwgKCR7d29uKHN1bS5pbmNvbWVSZWNlaXZlZCl9KTwvYnV0dG9uPmAgOiAnJzsKICAgICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+JHtzdW0uaGFzSW5jb21lID8gJ+uLueq4sCDsiJjsnoUo7JiI7IKwKSDsiJjsoJUnIDogJ+ydtOuyiCDquLDqsITsl5Ag65Ok7Ja07JioIOuPiCjsmIjsgrAp7J2EIOyeheugpe2VmOyEuOyalCd9PC9oMj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPiR7Zm10RGF0ZShjdXJyZW50UGVyaW9kLnN0YXJ0KX0g7JeQIOyLnOyeke2VmOuKlCDquLDqsITsnZgg7IiY7J6F7J6F64uI64ukLiDruYTsnKgg7ZWt66qp7J2YIO2VnOuPhOqwgCDsnbQg6riI7JWh7JeQIOunnuy2sCDqs4TsgrDrkKnri4jri6QuPC9wPgogICAgICAgIDxmb3JtIGNsYXNzPSJpbmNvbWUtZm9ybSIgaWQ9ImluY29tZS1mb3JtIj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpbnB1dG1vZGU9Im51bWVyaWMiIGlkPSJpbmNvbWUtaW5wdXQiIHBsYWNlaG9sZGVyPSLsmIg6IDMsMDAwLDAwMCIgdmFsdWU9IiR7c3VtLmhhc0luY29tZSA/IHN1bS5pbmNvbWUudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJykgOiAnJ30iPgogICAgICAgICAgPGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJwcmltYXJ5LWJ0biI+7KCA7J6lPC9idXR0b24+CiAgICAgICAgICAke3R5cGVvZiBwcmV2SW5jb21lID09PSAnbnVtYmVyJyA/IGA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imdob3N0LWJ0biIgaWQ9ImluY29tZS1wcmV2Ij7sp4Drgpwg6riw6rCE6rO8IOqwmeqyjCAoJHt3b24ocHJldkluY29tZSl9KTwvYnV0dG9uPmAgOiAnJ30KICAgICAgICAgICR7cmVjZWl2ZWR9CiAgICAgICAgICAke3N1bS5oYXNJbmNvbWUgPyAnPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJnaG9zdC1idG4iIGlkPSJpbmNvbWUtY2FuY2VsIj7st6jshow8L2J1dHRvbj4nIDogJyd9CiAgICAgICAgPC9mb3JtPmA7CiAgICAgIGNvbnN0IGlucHV0ID0gJCgnI2luY29tZS1pbnB1dCcpOwogICAgICBmb3JtYXRPbkJsdXIoaW5wdXQpOwogICAgICAkKCcjaW5jb21lLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBuID0gcGFyc2VBbW91bnRJbnB1dChpbnB1dC52YWx1ZSk7CiAgICAgICAgaWYgKG4gPT09IG51bGwgfHwgbiA8IDApIHJldHVybiB0b2FzdCgn6riI7JWh7J2EIOyIq+yekOuhnCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgICAgIHNldEluY29tZShuKTsKICAgICAgfSk7CiAgICAgIGNvbnN0IGJpbmQgPSAoaWQsIGZuKSA9PiAkKGlkKSAmJiAkKGlkKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGZuKTsKICAgICAgYmluZCgnI2luY29tZS1wcmV2JywgKCkgPT4gc2V0SW5jb21lKHByZXZJbmNvbWUpKTsKICAgICAgYmluZCgnI2luY29tZS1yZWNlaXZlZCcsICgpID0+IHNldEluY29tZShzdW0uaW5jb21lUmVjZWl2ZWQpKTsKICAgICAgYmluZCgnI2luY29tZS1jYW5jZWwnLCAoKSA9PiB7CiAgICAgICAgYm94LmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9KTsKICAgIH0gZWxzZSB7CiAgICAgIGJveC5jbGFzc0xpc3QucmVtb3ZlKCdpbmNvbWUtcHJvbXB0Jyk7CiAgICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0iaW5jb21lLXNldCI+CiAgICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+64u56riwIOyImOyehSjsmIjsgrApPC9zcGFuPjxkaXYgY2xhc3M9InZhbHVlIj4ke3dvbihzdW0uaW5jb21lKX08L2Rpdj48L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJpbmNvbWUtZWRpdCI+7IiY7KCVPC9idXR0b24+CiAgICAgICAgPC9kaXY+YDsKICAgICAgJCgnI2luY29tZS1lZGl0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgYm94LmRhdGFzZXQuZWRpdGluZyA9ICcxJzsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBzZXRJbmNvbWUobikgewogICAgUygpLmluY29tZXNbY3VycmVudFBlcmlvZC5rZXldID0gbjsKICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAkKCcjaW5jb21lLWJveCcpLmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgdG9hc3QoJ+uLueq4sCDsiJjsnoXsnYQg7KCA7J6l7ZaI7Iq164uI64ukLicpOwogICAgcmVuZGVyKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJTdGFsZUJveChzdW0pIHsKICAgIGNvbnN0IGJveCA9ICQoJyNzdGFsZS1ib3gnKTsKICAgIGlmICghc3VtLnN0YWxlQ291bnQgfHwgIXN1bS5wbGFuLnVwZGF0ZWRBdCkgewogICAgICBib3guaW5uZXJIVE1MID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQgbm90ZS1jYXJkIHdhcm4tY2FyZCI+CiAgICAgICAgPGI+7JiI7IKwIOqzhO2ajeydtCDrsJTrgIzsl4jslrTsmpQuPC9iPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+67CU64CQIOqzhO2ajeyXkCDrp57strAg7JWE7KeBIOuLpOyLnCDrtoTrpZjtlZjsp4Ag7JWK7J2AIOyngOy2nOydtCAke3N1bS5zdGFsZUNvdW50feqxtCDsnojslrTsmpQuIOyngeygkSDqs6Drpbgg7ZWt66qp7J2AIOq3uOuMgOuhnCDrkZDqs6Ag64KY66i47KeA66W8IOyDiCDtla3rqqkg6riw7KSA7Jy866GcIOu2hOulmO2VqeuLiOuLpC48L3A+CiAgICAgICAgPGJ1dHRvbiBpZD0ic3RhbGUtcmVjbGFzc2lmeSIgY2xhc3M9InByaW1hcnktYnRuIj7sg4gg6rOE7ZqN7Jy866GcIOuLpOyLnCDrtoTrpZgke3N0b3JlLmFpRW5hYmxlZCA/ICcgKEFJKScgOiAnJ308L2J1dHRvbj4KICAgICAgPC9kaXY+YDsKICAgICQoJyNzdGFsZS1yZWNsYXNzaWZ5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBydW5SZWNsYXNzaWZ5KGZhbHNlKSkpOwogIH0KCiAgLy8g6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7J2067KIIOq4sOqwhCDsiJjsnoXrs7Tri6Qg7YG0IOuVjCDslYzrprwKICBmdW5jdGlvbiByZW5kZXJGaXhlZEJveChzdW0pIHsKICAgIGNvbnN0IGJveCA9ICQoJyNmaXhlZC1ib3gnKTsKICAgIGlmICghc3VtLmhhc0luY29tZSB8fCAhc3VtLmZpeGVkT3ZlcikgewogICAgICBib3guaW5uZXJIVE1MID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHBjdCA9IE1hdGgucm91bmQoc3VtLmZpeGVkU2NhbGUgKiAxMDApOwogICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBub3RlLWNhcmQgd2Fybi1jYXJkIj4KICAgICAgICA8Yj7qs6DsoJUg7ZWt66qpIO2VqeqzhOqwgCDsiJjsnoXrs7Tri6QgJHt3b24oc3VtLmZpeGVkT3Zlcil9IOunjuyVhOyalC48L2I+CiAgICAgICAgPHAgY2xhc3M9InNtYWxsIj7qs6DsoJUg7ZWt66qpICR7d29uKHN1bS5maXhlZFRvdGFsKX0gwrcg7J2067KIIOq4sOqwhCDsiJjsnoUgJHt3b24oc3VtLmluY29tZSl9LgogICAgICAgICR7c3VtLmZpeGVkU2NhbGVkCiAgICAgICAgICA/IGDqs4Ttmo0g7ISk7KCV7JeQIOuUsOudvCDqs6DsoJUg7ZWt66qpIO2VnOuPhOulvCDsoJXtlZwg6riI7JWh7J2YIOyVvSAke3BjdH0l66GcIOykhOyXrCDsiJjsnoXsl5Ag66ee7LeE7Ja07JqULmAKICAgICAgICAgIDogJ+ygle2VnCDquIjslaEg6re464yA66GcIOuRkOyXiOq4sCDrlYzrrLjsl5Ag6rOE7ZqN7J20IOyImOyeheydhCDrhJjslrTsmpQuIOqzoOyglSDquIjslaHsnYQg6rOg7LmY6rGw64KYLCDqs4Ttmo3sl5DshJwgPGI+67mE7Jyo64yA66GcIOykhOydtOq4sDwvYj7rpbwg6rOg66W8IOyImCDsnojslrTsmpQuJ30KICAgICAgICAke3N1bS5yYXRpb1BlcmNlbnRUb3RhbCA+IDAgJiYgc3VtLnBsYW4ucmF0aW9CYXNlID09PSAnYWZ0ZXJGaXhlZCcgPyAnIOqzoOyglSDtla3rqqnsnYQg67m86rOgIOuCqOuKlCDrj4jsnbQg7JeG7Ja0IOu5hOycqCDtla3rqqkg7ZWc64+E64qUIDDsm5DsnbTsl5DsmpQuJyA6ICcnfTwvcD4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4iIGRhdGEtZ290bz0icGxhbiI+6rOE7ZqNIOuztOq4sDwvYnV0dG9uPgogICAgICA8L2Rpdj5gOwogICAgYm94LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWdvdG9dJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZSgncGxhbicpKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckhvbWUoKSB7CiAgICBjb25zdCBzdW0gPSBMLnN1bW1hcml6ZVBlcmlvZChTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgcmVuZGVySW5jb21lQm94KHN1bSk7CiAgICByZW5kZXJTdGFsZUJveChzdW0pOwogICAgcmVuZGVyRml4ZWRCb3goc3VtKTsKCiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGNvbnN0IGlzQ3VycmVudCA9IHRvZGF5ID49IGN1cnJlbnRQZXJpb2Quc3RhcnQgJiYgdG9kYXkgPD0gY3VycmVudFBlcmlvZC5lbmQ7CiAgICBjb25zdCBkYXlzTGVmdCA9IGlzQ3VycmVudCA/IEwuZGlmZkRheXModG9kYXksIGN1cnJlbnRQZXJpb2QuZW5kKSArIDEgOiAwOwogICAgY29uc3QgaGVybyA9ICQoJyNoZXJvJyk7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBjb25zdCByYXRpbyA9IHN1bS5pbmNvbWUgPiAwID8gc3VtLnRvdGFsU3BlbnQgLyBzdW0uaW5jb21lIDogc3VtLnRvdGFsU3BlbnQgPiAwID8gSW5maW5pdHkgOiAwOwogICAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHJhdGlvKTsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuuCqOydgCDrj4g8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUgJHtzdW0ucmVtYWluaW5nIDwgMCA/ICduZWdhdGl2ZScgOiAnJ30iPiR7d29uKHN1bS5yZW1haW5pbmcpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHt3b24oc3VtLmluY29tZSl9IOykkSAke3dvbihzdW0udG90YWxTcGVudCl9IOyCrOyaqSAoJHtzdW0uaW5jb21lID4gMCA/IE1hdGgucm91bmQocmF0aW8gKiAxMDApIDogMH0lKTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7c3RhdHVzfSIgcm9sZT0ibWV0ZXIiIGFyaWEtdmFsdWVtaW49IjAiIGFyaWEtdmFsdWVtYXg9IiR7c3VtLmluY29tZX0iIGFyaWEtdmFsdWVub3c9IiR7c3VtLnRvdGFsU3BlbnR9IiBhcmlhLWxhYmVsPSLsmIjsgrAg7IKs7JqpIj48ZGl2IGNsYXNzPSJtZXRlci1maWxsIiBzdHlsZT0id2lkdGg6JHtNYXRoLm1pbigxMDAsIHJhdGlvICogMTAwKX0lIj48L2Rpdj48L2Rpdj5gOwogICAgfSBlbHNlIHsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuydtOuyiCDquLDqsIQg7JO0IOuPiDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZ3VyZSI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+7IiY7J6F7J2EIOyeheugpe2VmOuptCDtla3rqqnrs4Qg7ZWc64+E7JmAIOuCqOydgCDrj4jsnYQg6rOE7IKw7ZW0IOuTnOugpOyalC48L2Rpdj5gOwogICAgfQoKICAgIGNvbnN0IHBlckRheSA9IGlzQ3VycmVudCAmJiBzdW0uaGFzSW5jb21lICYmIHN1bS5yZW1haW5pbmcgPiAwID8gd29uKE1hdGguZmxvb3Ioc3VtLnJlbWFpbmluZyAvIGRheXNMZWZ0KSkgOiAn4oCUJzsKICAgICQoJyNob21lLXN1bW1hcnknKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+7J2067KIIOq4sOqwhCDsp4Dstpw8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKHN1bS50b3RhbFNwZW50KX0gwrcgJHtzdW0udHJhbnNhY3Rpb25zLmxlbmd0aH3qsbQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+67Cb7J2AIOyeheq4iDwvc3Bhbj48c3BhbiBjbGFzcz0idiBwbHVzIj4ke3N1bS5pbmNvbWVSZWNlaXZlZCA/IGArJHt3b24oc3VtLmluY29tZVJlY2VpdmVkKX1gIDogJ+KAlCd9PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPu2VmOujqCDqtozsnqUg7IKs7Jqp7JWhPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3BlckRheX08L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+66+467aE66WYPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3N1bS51bmNsYXNzaWZpZWRDb3VudCA/IGAke3dvbihzdW0udW5jbGFzc2lmaWVkKX0gwrcgJHtzdW0udW5jbGFzc2lmaWVkQ291bnR96rG0YCA6ICfsl4bsnYwnfTwvc3Bhbj48L2Rpdj5gOwoKICAgIGxldCBub3RlID0gJyc7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBpZiAoc3VtLnVuYWxsb2NhdGVkID4gMCkgbm90ZSA9IGDrsLDrtoTrkJjsp4Ag7JWK7J2AIOuPiCAke3dvbihzdW0udW5hbGxvY2F0ZWQpfWA7CiAgICAgIGVsc2UgaWYgKHN1bS51bmFsbG9jYXRlZCA8IDApIG5vdGUgPSBg4pqgIOqzhO2ajeydtCDsiJjsnoXrs7Tri6QgJHt3b24oLXN1bS51bmFsbG9jYXRlZCl9IOunjuyVhOyalGA7CiAgICB9CiAgICAkKCcjYWxsb2Mtbm90ZScpLnRleHRDb250ZW50ID0gbm90ZTsKCiAgICBjb25zdCByb3dzRWwgPSAkKCcjY2F0ZWdvcnktcm93cycpOwogICAgaWYgKCFzdW0ucGxhbi5jYXRlZ29yaWVzLmxlbmd0aCkgewogICAgICByb3dzRWwuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7smIjsgrAg6rOE7ZqN7JeQ7IScIO2VreuqqeydhCDstpTqsIDtlZjshLjsmpQuPC9kaXY+JzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IHJvd3MgPSBzdW0ucm93cy5tYXAoKHIsIGkpID0+IGNhdGVnb3J5Um93KHIsIGksIHN1bS5oYXNJbmNvbWUpKTsKICAgICAgaWYgKHN1bS51bmNsYXNzaWZpZWRDb3VudCkgewogICAgICAgIHJvd3MucHVzaChgCiAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtcm93IiBkYXRhLWNhdD0iX19ub25lIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iY2F0LXRvcCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1ncmF5LW1hcmspIj48L3NwYW4+66+467aE66WYPHNwYW4gY2xhc3M9ImJhZGdlIj7riIzrn6zshJwg7KCV66as7ZWY6riwPC9zcGFuPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2F0LWFtb3VudHMiPjxiPiR7d29uKHN1bS51bmNsYXNzaWZpZWQpfTwvYj4gwrcgJHtzdW0udW5jbGFzc2lmaWVkQ291bnR96rG0PC9zcGFuPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PmApOwogICAgICB9CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSByb3dzLmpvaW4oJycpOwogICAgICByb3dzRWwucXVlcnlTZWxlY3RvckFsbCgnLmNhdC1yb3cnKS5mb3JFYWNoKChlbCkgPT4gewogICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgICAgaWYgKGVsLmRhdGFzZXQuY2F0ID09PSAnX19ub25lJykgcmV0dXJuIHNob3dQYWdlKCdzb3J0Jyk7CiAgICAgICAgICBPYmplY3QuYXNzaWduKGxpc3RTdGF0ZSwgeyBjYXRlZ29yeTogZWwuZGF0YXNldC5jYXQsIGtpbmQ6ICdhbGwnLCBhY2NvdW50OiAnYWxsJywgc2VhcmNoOiAnJyB9KTsKICAgICAgICAgIHNob3dQYWdlKCdsaXN0Jyk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3QgciA9IHN1bS5yb3dzLmZpbmQoKHgpID0+IHguY2F0ZWdvcnkuaWQgPT09IGVsLmRhdGFzZXQuY2F0KTsKICAgICAgICBpZiAocikgYXR0YWNoVG9vbHRpcChlbC5xdWVyeVNlbGVjdG9yKCcubWV0ZXInKSwgKCkgPT4gYAogICAgICAgICAgPHN0cm9uZz4ke2VzYyhyLmNhdGVnb3J5Lm5hbWUpfTwvc3Ryb25nPgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPu2VnOuPhDwvc3Bhbj48c3Bhbj4ke3dvbihyLmJ1ZGdldCl9PC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPuyCrOyaqTwvc3Bhbj48c3Bhbj4ke3dvbihyLnNwZW50KX08L3NwYW4+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+JHtyLnJlbWFpbmluZyA+PSAwID8gJ+uCqOydjCcgOiAn7LSI6rO8J308L3NwYW4+PHNwYW4+JHt3b24oTWF0aC5hYnMoci5yZW1haW5pbmcpKX08L3NwYW4+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+6rG07IiYPC9zcGFuPjxzcGFuPiR7ci5jb3VudH3qsbQ8L3NwYW4+PC9kaXY+YCk7CiAgICAgIH0pOwogICAgfQoKICAgIGNvbnN0IHJlY2VudCA9IFsuLi5zdW0uYWxsVHJhbnNhY3Rpb25zXS5zb3J0KChhLCBiKSA9PiAoYS5kYXRlICsgKGEuY3JlYXRlZEF0IHx8ICcnKSA8IGIuZGF0ZSArIChiLmNyZWF0ZWRBdCB8fCAnJykgPyAxIDogLTEpKS5zbGljZSgwLCA1KTsKICAgICQoJyNyZWNlbnQtbGlzdCcpLmlubmVySFRNTCA9IHJlY2VudC5sZW5ndGggPyByZWNlbnQubWFwKCh0KSA9PiB0eFJvdyh0LCB7IGVkaXRhYmxlOiBmYWxzZSB9KSkuam9pbignJykgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuydtCDquLDqsIQg64K07Jet7J20IOyXhuyKteuLiOuLpC48L2Rpdj4nOwoKICAgIGNvbnN0IGFzc2V0cyA9IEwuYXNzZXRTdW1tYXJ5KFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICAkKCcjaG9tZS1hc3NldHMnKS5pbm5lckhUTUwgPSBhc3NldHMuYmFua3MubGVuZ3RoIHx8IGFzc2V0cy5jYXJkcy5sZW5ndGgKICAgICAgPyBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7qs4Tsoowg7J6U7JWhIO2VqeqzhDwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oYXNzZXRzLnRvdGFsKX08L3NwYW4+PC9kaXY+CiAgICAgICAgICR7YXNzZXRzLnNhdmluZ3MgPyBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7qt7jspJEg7KCA7LaVPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3dvbihhc3NldHMuc2F2aW5ncyl9PC9zcGFuPjwvZGl2PmAgOiAnJ30KICAgICAgICAgJHthc3NldHMuY2FyZHMubWFwKChjKSA9PiBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj4ke2VzYyhhY2NvdW50TmFtZShjLmlkKSl9ICjsnbTrsogg6riw6rCEKTwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oYy5zcGVudCl9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfWAKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuyEpOygleyXkOyEnCDqs4TsoozCt+y5tOuTnOulvCDrk7HroZ3tlZjrqbQg7J6U7JWh6rO8IOy5tOuTnOuzhCDsgqzsmqnslaHsnYQg67O07Jes65Oc66Ck7JqULjwvZGl2Pic7CiAgfQoKICBmdW5jdGlvbiBjYXRlZ29yeVJvdyhyLCBpbmRleCwgaGFzSW5jb21lKSB7CiAgICBjb25zdCBjID0gci5jYXRlZ29yeTsKICAgIGNvbnN0IGJhZGdlID0gYy50eXBlID09PSAnZml4ZWQnID8gYOqzoOyglSAke3dvbihjLnZhbHVlKX1gIDogYOyImOyeheydmCAke2MudmFsdWV9JWA7CiAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHIucmF0aW8pOwogICAgY29uc3QgcGN0ID0gci5idWRnZXQgPiAwID8gTWF0aC5yb3VuZChyLnJhdGlvICogMTAwKSA6IG51bGw7CiAgICBjb25zdCB3aWR0aCA9IHIuYnVkZ2V0ID4gMCA/IE1hdGgubWluKDEwMCwgci5yYXRpbyAqIDEwMCkgOiByLnNwZW50ID4gMCA/IDEwMCA6IDA7CiAgICBjb25zdCBub0J1ZGdldCA9IGMudHlwZSA9PT0gJ3JhdGlvJyAmJiAhaGFzSW5jb21lOwoKICAgIGxldCBzdGF0dXNUZXh0OwogICAgaWYgKG5vQnVkZ2V0KSBzdGF0dXNUZXh0ID0gJ+yImOyehSDsnoXroKUg7KCEJzsKICAgIGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2NyaXRpY2FsJykgc3RhdHVzVGV4dCA9IGDimqAg7LSI6rO8ICR7cGN0ID09PSBudWxsID8gJycgOiBgKCR7cGN0fSUpYH1gOwogICAgZWxzZSBpZiAoc3RhdHVzID09PSAnd2FybmluZycpIHN0YXR1c1RleHQgPSBwY3QgPT09IDEwMCA/ICftlZzrj4Qg64+E64usIDEwMCUnIDogYCEg7KO87J2YICR7cGN0fSVgOwogICAgZWxzZSBzdGF0dXNUZXh0ID0gcGN0ID09PSBudWxsID8gJycgOiBgJHtwY3R9JSDsgqzsmqlgOwoKICAgIGNvbnN0IHJlbWFpbiA9IG5vQnVkZ2V0CiAgICAgID8gJycKICAgICAgOiByLnJlbWFpbmluZyA+PSAwCiAgICAgICAgPyBgPHNwYW4gY2xhc3M9InJlbWFpbi1nb29kIj4ke3dvbihyLnJlbWFpbmluZyl9IOuCqOydjDwvc3Bhbj5gCiAgICAgICAgOiBgPHNwYW4gY2xhc3M9InJlbWFpbi1iYWQiPiR7d29uKC1yLnJlbWFpbmluZyl9IOy0iOqzvDwvc3Bhbj5gOwoKICAgIHJldHVybiBgCiAgICAgIDxkaXYgY2xhc3M9ImNhdC1yb3ciIGRhdGEtY2F0PSIke2VzYyhjLmlkKX0iPgogICAgICAgIDxkaXYgY2xhc3M9ImNhdC10b3AiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDoke0Muc2VyaWVzQ29sb3IoaW5kZXgpfSI+PC9zcGFuPiR7ZXNjKGMubmFtZSl9PHNwYW4gY2xhc3M9ImJhZGdlIj4ke2VzYyhiYWRnZSl9PC9zcGFuPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJjYXQtYW1vdW50cyI+PGI+JHt3b24oci5zcGVudCl9PC9iPiAvICR7bm9CdWRnZXQgPyAn4oCUJyA6IHdvbihyLmJ1ZGdldCl9PC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7bm9CdWRnZXQgPyAnJyA6IHN0YXR1c30iIHJvbGU9Im1ldGVyIiBhcmlhLXZhbHVlbWluPSIwIiBhcmlhLXZhbHVlbWF4PSIke3IuYnVkZ2V0fSIgYXJpYS12YWx1ZW5vdz0iJHtyLnNwZW50fSIgYXJpYS1sYWJlbD0iJHtlc2MoYy5uYW1lKX0g7IKs7Jqp7JWhIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyLWZpbGwiIHN0eWxlPSJ3aWR0aDoke3dpZHRofSUiPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNhdC1ib3R0b20iPgogICAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cyAke25vQnVkZ2V0ID8gJycgOiBzdGF0dXN9Ij4ke3N0YXR1c1RleHR9PC9zcGFuPgogICAgICAgICAgJHtyZW1haW59CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PmA7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuLrOugpSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckNhbGVuZGFyKCkgewogICAgY29uc3QgcCA9IGN1cnJlbnRQZXJpb2Q7CiAgICBjb25zdCBzdW0gPSBMLnN1bW1hcml6ZVBlcmlvZChTKCksIHApOwogICAgY29uc3QgZGF5cyA9IEwuZGFpbHlUb3RhbHMoc3VtLmFsbFRyYW5zYWN0aW9ucyk7CiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGlmICghc2VsZWN0ZWREYXRlIHx8IHNlbGVjdGVkRGF0ZSA8IHAuc3RhcnQgfHwgc2VsZWN0ZWREYXRlID4gcC5lbmQpIHNlbGVjdGVkRGF0ZSA9IHRvZGF5ID49IHAuc3RhcnQgJiYgdG9kYXkgPD0gcC5lbmQgPyB0b2RheSA6IHAuc3RhcnQ7CgogICAgJCgnI2NhbC1zdW1tYXJ5JykuaW5uZXJIVE1MID0gYAogICAgICA8c3Bhbj7sp4DstpwgPGI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfTwvYj48L3NwYW4+CiAgICAgIDxzcGFuIGNsYXNzPSJwbHVzIj7snoXquIggPGI+JHtzdW0uaW5jb21lUmVjZWl2ZWQgPyBgKyR7d29uKHN1bS5pbmNvbWVSZWNlaXZlZCl9YCA6ICcw7JuQJ308L2I+PC9zcGFuPgogICAgICAke3N1bS5oYXNJbmNvbWUgPyBgPHNwYW4+64Ko7J2AIOuPiCA8Yj4ke3dvbihzdW0ucmVtYWluaW5nKX08L2I+PC9zcGFuPmAgOiAnJ31gOwoKICAgIGNvbnN0IG1heFNwZW50ID0gTWF0aC5tYXgoMCwgLi4uT2JqZWN0LnZhbHVlcyhkYXlzKS5tYXAoKGQpID0+IGQuc3BlbnQpKTsKICAgIGNvbnN0IGZpcnN0ID0gTC5hZGREYXlzKHAuc3RhcnQsIC1kb3dPZihwLnN0YXJ0KSk7CiAgICBjb25zdCBsYXN0ID0gTC5hZGREYXlzKHAuZW5kLCA2IC0gZG93T2YocC5lbmQpKTsKICAgIGNvbnN0IGNlbGxzID0gRE9XLm1hcCgodywgaSkgPT4gYDxkaXYgY2xhc3M9ImNhbC1kb3cgJHtpID09PSAwID8gJ3N1bicgOiAnJ30iPiR7d308L2Rpdj5gKTsKICAgIGZvciAobGV0IGN1cnNvciA9IGZpcnN0OyBjdXJzb3IgPD0gbGFzdDsgY3Vyc29yID0gTC5hZGREYXlzKGN1cnNvciwgMSkpIHsKICAgICAgY29uc3QgaW5QZXJpb2QgPSBjdXJzb3IgPj0gcC5zdGFydCAmJiBjdXJzb3IgPD0gcC5lbmQ7CiAgICAgIGNvbnN0IGluZm8gPSBkYXlzW2N1cnNvcl0gfHwgeyBzcGVudDogMCwgaW5jb21lOiAwIH07CiAgICAgIGNvbnN0IHEgPSBMLnBhcnNlSVNPKGN1cnNvcik7CiAgICAgIGNvbnN0IGxhYmVsID0gcS5kID09PSAxIHx8IGN1cnNvciA9PT0gcC5zdGFydCA/IGAke3EubX0vJHtxLmR9YCA6IHEuZDsKICAgICAgbGV0IGhlYXQgPSAnJzsKICAgICAgaWYgKGluUGVyaW9kICYmIGluZm8uc3BlbnQgPiAwICYmIG1heFNwZW50ID4gMCkgaGVhdCA9IGBoJHtNYXRoLm1pbigzLCBNYXRoLmNlaWwoKGluZm8uc3BlbnQgLyBtYXhTcGVudCkgKiAzKSl9YDsKICAgICAgY2VsbHMucHVzaChpblBlcmlvZAogICAgICAgID8gYDxidXR0b24gY2xhc3M9ImNhbC1kYXkgJHtoZWF0fSAke2N1cnNvciA9PT0gdG9kYXkgPyAndG9kYXknIDogJyd9ICR7Y3Vyc29yID09PSBzZWxlY3RlZERhdGUgPyAnc2VsZWN0ZWQnIDogJyd9IiBkYXRhLWRhdGU9IiR7Y3Vyc29yfSIgYXJpYS1sYWJlbD0iJHtmbXREYXkoY3Vyc29yKX0g7KeA7LacICR7d29uKGluZm8uc3BlbnQpfSI+CiAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2FsLW51bSI+JHtsYWJlbH08L3NwYW4+CiAgICAgICAgICAgICAke2luZm8uc3BlbnQgPyBgPHNwYW4gY2xhc3M9ImNhbC1zcGVudCI+LSR7Qy50aW55V29uKGluZm8uc3BlbnQpfTwvc3Bhbj5gIDogJyd9CiAgICAgICAgICAgICAke2luZm8uaW5jb21lID8gYDxzcGFuIGNsYXNzPSJjYWwtaW5jb21lIj4rJHtDLnRpbnlXb24oaW5mby5pbmNvbWUpfTwvc3Bhbj5gIDogJyd9CiAgICAgICAgICAgPC9idXR0b24+YAogICAgICAgIDogYDxkaXYgY2xhc3M9ImNhbC1kYXkgb3V0Ij48c3BhbiBjbGFzcz0iY2FsLW51bSI+JHtsYWJlbH08L3NwYW4+PC9kaXY+YCk7CiAgICB9CiAgICBjb25zdCBjYWwgPSAkKCcjY2FsZW5kYXInKTsKICAgIGNhbC5pbm5lckhUTUwgPSBjZWxscy5qb2luKCcnKTsKICAgIGNhbC5xdWVyeVNlbGVjdG9yQWxsKCcuY2FsLWRheVtkYXRhLWRhdGVdJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgc2VsZWN0ZWREYXRlID0gYi5kYXRhc2V0LmRhdGU7CiAgICAgIHJlbmRlckNhbGVuZGFyKCk7CiAgICB9KSk7CgogICAgY29uc3QgZGF5VHhzID0gc3VtLmFsbFRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHQuZGF0ZSA9PT0gc2VsZWN0ZWREYXRlKTsKICAgICQoJyNkYXktdGl0bGUnKS50ZXh0Q29udGVudCA9IGZtdERheShzZWxlY3RlZERhdGUpOwogICAgY29uc3QgaW5mbyA9IGRheXNbc2VsZWN0ZWREYXRlXTsKICAgICQoJyNkYXktdG90YWwnKS50ZXh0Q29udGVudCA9IGluZm8gPyBg7KeA7LacICR7d29uKGluZm8uc3BlbnQpfSR7aW5mby5pbmNvbWUgPyBgIMK3IOyeheq4iCAke3dvbihpbmZvLmluY29tZSl9YCA6ICcnfWAgOiAnJzsKICAgIGNvbnN0IGxpc3QgPSAkKCcjZGF5LWxpc3QnKTsKICAgIGxpc3QuaW5uZXJIVE1MID0gZGF5VHhzLmxlbmd0aCA/IGRheVR4cy5tYXAoKHQpID0+IHR4Um93KHQpKS5qb2luKCcnKSA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7J2064Kg7J2AIOuCtOyXreydtCDsl4bslrTsmpQuPC9kaXY+JzsKICAgIGJpbmRUeEV2ZW50cyhsaXN0KTsKICB9CgogIC8vIC0tLS0tLS0tLS0g64K07JetIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyTGlzdCgpIHsKICAgIGNvbnN0IHN1bSA9IEwuc3VtbWFyaXplUGVyaW9kKFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICBjb25zdCBjYXRzID0gc3VtLnBsYW4uY2F0ZWdvcmllczsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChjYXRzLm1hcCgoYykgPT4gYy5pZCkpOwogICAgaWYgKGxpc3RTdGF0ZS5jYXRlZ29yeSAhPT0gJ2FsbCcgJiYgbGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnX19ub25lJyAmJiAha25vd24uaGFzKGxpc3RTdGF0ZS5jYXRlZ29yeSkpIGxpc3RTdGF0ZS5jYXRlZ29yeSA9ICdhbGwnOwoKICAgICQoJyNsaXN0LWZpbHRlcicpLmlubmVySFRNTCA9IGA8b3B0aW9uIHZhbHVlPSJhbGwiPuuqqOuToCDtla3rqqk8L29wdGlvbj48b3B0aW9uIHZhbHVlPSJfX25vbmUiPuuvuOu2hOulmDwvb3B0aW9uPmAgKwogICAgICBjYXRzLm1hcCgoYykgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGMuaWQpfSI+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKTsKICAgICQoJyNsaXN0LWZpbHRlcicpLnZhbHVlID0gbGlzdFN0YXRlLmNhdGVnb3J5OwogICAgJCgnI2xpc3QtYWNjb3VudCcpLmlubmVySFRNTCA9IGA8b3B0aW9uIHZhbHVlPSJhbGwiPuuqqOuToCDqsrDsoJzsiJjri6g8L29wdGlvbj5gICsKICAgICAgUygpLmFjY291bnRzLm1hcCgoYSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGEuaWQpfSI+JHtlc2MoYWNjb3VudE5hbWUoYS5pZCkpfTwvb3B0aW9uPmApLmpvaW4oJycpOwogICAgJCgnI2xpc3QtYWNjb3VudCcpLnZhbHVlID0gUygpLmFjY291bnRzLnNvbWUoKGEpID0+IGEuaWQgPT09IGxpc3RTdGF0ZS5hY2NvdW50KSA/IGxpc3RTdGF0ZS5hY2NvdW50IDogJ2FsbCc7CiAgICAkKCcjbGlzdC1raW5kJykudmFsdWUgPSBsaXN0U3RhdGUua2luZDsKICAgICQoJyNsaXN0LXNlYXJjaCcpLnZhbHVlID0gbGlzdFN0YXRlLnNlYXJjaDsKICAgICQoJyNyZWNsYXNzaWZ5LWFsbCcpLnRleHRDb250ZW50ID0gYOydtCDquLDqsIQg7KCE7LK0IOuLpOyLnCDrtoTrpZgke3N0b3JlLmFpRW5hYmxlZCA/ICcgKEFJKScgOiAnJ31gOwoKICAgIGNvbnN0IHEgPSBMLm5vcm1hbGl6ZU1lcmNoYW50KGxpc3RTdGF0ZS5zZWFyY2gpOwogICAgY29uc3QgdHhzID0gc3VtLmFsbFRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHsKICAgICAgY29uc3Qga2luZCA9IEwua2luZE9mKHQpOwogICAgICBpZiAobGlzdFN0YXRlLmtpbmQgIT09ICdhbGwnICYmIGtpbmQgIT09IGxpc3RTdGF0ZS5raW5kKSByZXR1cm4gZmFsc2U7CiAgICAgIGlmIChsaXN0U3RhdGUuY2F0ZWdvcnkgPT09ICdfX25vbmUnICYmIChraW5kICE9PSAnZXhwZW5zZScgfHwga25vd24uaGFzKHQuY2F0ZWdvcnlJZCkpKSByZXR1cm4gZmFsc2U7CiAgICAgIGlmIChsaXN0U3RhdGUuY2F0ZWdvcnkgIT09ICdhbGwnICYmIGxpc3RTdGF0ZS5jYXRlZ29yeSAhPT0gJ19fbm9uZScgJiYgdC5jYXRlZ29yeUlkICE9PSBsaXN0U3RhdGUuY2F0ZWdvcnkpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKGxpc3RTdGF0ZS5hY2NvdW50ICE9PSAnYWxsJyAmJiB0LmFjY291bnRJZCAhPT0gbGlzdFN0YXRlLmFjY291bnQpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKHEgJiYgIUwubm9ybWFsaXplTWVyY2hhbnQodC5tZW1vKS5pbmNsdWRlcyhxKSkgcmV0dXJuIGZhbHNlOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0pOwoKICAgIGNvbnN0IHNwZW50ID0gdHhzLmZpbHRlcigodCkgPT4gTC5raW5kT2YodCkgPT09ICdleHBlbnNlJykucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgY29uc3QgaW5jID0gdHhzLmZpbHRlcigodCkgPT4gTC5raW5kT2YodCkgPT09ICdpbmNvbWUnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CiAgICAkKCcjbGlzdC10b3RhbCcpLmlubmVySFRNTCA9IGA8c3Bhbj4ke3R4cy5sZW5ndGh96rG0PC9zcGFuPjxzcGFuPuyngOy2nCA8Yj4ke3dvbihzcGVudCl9PC9iPjwvc3Bhbj4ke2luYyA/IGA8c3Bhbj7snoXquIggPGI+KyR7d29uKGluYyl9PC9iPjwvc3Bhbj5gIDogJyd9YDsKCiAgICBjb25zdCBlbCA9ICQoJyN0eC1saXN0Jyk7CiAgICBlbC5pbm5lckhUTUwgPSB0eHMubGVuZ3RoID8gdHhHcm91cHModHhzKSA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7KGw6rG07JeQIOunnuuKlCDrgrTsl63snbQg7JeG7Iq164uI64ukLjwvZGl2Pic7CiAgICBiaW5kVHhFdmVudHMoZWwpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrr7jrtoTrpZgg7KCV66asIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyU29ydCgpIHsKICAgIGNvbnN0IGdyb3VwcyA9IEwudW5jbGFzc2lmaWVkR3JvdXBzKFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICBjb25zdCBjb3VudCA9IGdyb3Vwcy5yZWR1Y2UoKG4sIGcpID0+IG4gKyBnLml0ZW1zLmxlbmd0aCwgMCk7CiAgICBjb25zdCB0b3RhbCA9IGdyb3Vwcy5yZWR1Y2UoKG4sIGcpID0+IG4gKyBnLnRvdGFsLCAwKTsKICAgICQoJyNzb3J0LXRpdGxlJykudGV4dENvbnRlbnQgPSAn7J20IOq4sOqwhCDrr7jrtoTrpZgnOwogICAgJCgnI3NvcnQtdG90YWwnKS50ZXh0Q29udGVudCA9IGNvdW50ID8gYCR7Y291bnR96rG0IMK3ICR7d29uKHRvdGFsKX1gIDogJyc7CgogICAgLy8g64uk66W4IOq4sOqwhOyXkCDrgqjsnYAg66+467aE66WYOiDriIzrn6zshJwg6re4IOq4sOqwhOycvOuhnCDsnbTrj5kKICAgIGNvbnN0IG90aGVycyA9IEwudW5jbGFzc2lmaWVkQnlQZXJpb2QoUygpKS5maWx0ZXIoKGUpID0+IGUucGVyaW9kLmtleSAhPT0gY3VycmVudFBlcmlvZC5rZXkpOwogICAgY29uc3Qgb3RoZXJFbCA9ICQoJyNzb3J0LW90aGVycycpOwogICAgb3RoZXJFbC5pbm5lckhUTUwgPSBvdGhlcnMubGVuZ3RoCiAgICAgID8gYDxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+64uk66W4IOq4sOqwhOyXkOuPhCDrgqjslYQg7J6I7Ja07JqUOjwvc3Bhbj4gJHtvdGhlcnMubWFwKChlKSA9PiBgPGJ1dHRvbiBjbGFzcz0icGljay1idG4iIGRhdGEtcGVyaW9kPSIke2VzYyhlLnBlcmlvZC5rZXkpfSI+JHtlc2MocGVyaW9kTGFiZWwoZS5wZXJpb2QpKX0gwrcgJHtlLmNvdW50feqxtDwvYnV0dG9uPmApLmpvaW4oJycpfWAKICAgICAgOiAnJzsKICAgIG90aGVyRWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGVyaW9kXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGNvbnN0IGUgPSBvdGhlcnMuZmluZCgoeCkgPT4geC5wZXJpb2Qua2V5ID09PSBiLmRhdGFzZXQucGVyaW9kKTsKICAgICAgY3VycmVudFBlcmlvZCA9IGUucGVyaW9kOwogICAgICByZW5kZXIoKTsKICAgICAgd2luZG93LnNjcm9sbFRvKDAsIDApOwogICAgfSkpOwoKICAgIGNvbnN0IGVsID0gJCgnI3NvcnQtZ3JvdXBzJyk7CiAgICBpZiAoIWdyb3Vwcy5sZW5ndGgpIHsKICAgICAgZWwuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij7snbQg6riw6rCE7JeQ64qUIOuvuOu2hOulmCDsp4DstpzsnbQg7JeG7Ja07JqULiR7b3RoZXJzLmxlbmd0aCA/ICcg7JyE7JeQ7IScIOuLpOuluCDquLDqsITsnYQg6rOo6528IOygleumrO2VmOyEuOyalC4nIDogJyDrqqjrkZAg7KCV66as65CQ7Ja07JqULid9PC9kaXY+PC9kaXY+YDsKICAgICAgcmV0dXJuOwogICAgfQogICAgZWwuaW5uZXJIVE1MID0gZ3JvdXBzLm1hcCgoZywgZ2kpID0+IHsKICAgICAgY29uc3QgY2F0cyA9IHBsYW5Gb3JEYXRlKGcubGF0ZXN0KS5jYXRlZ29yaWVzOwogICAgICBjb25zdCBkYXlzID0gWy4uLm5ldyBTZXQoZy5pdGVtcy5tYXAoKHQpID0+IHQuZGF0ZSkpXTsKICAgICAgY29uc3QgZGF0ZXMgPSBkYXlzLnNsaWNlKDAsIDMpLm1hcChmbXREYXkpLmpvaW4oJywgJykgKyAoZGF5cy5sZW5ndGggPiAzID8gYCDsmbggJHtkYXlzLmxlbmd0aCAtIDN97J28YCA6ICcnKTsKICAgICAgY29uc3QgcmF3ID0gZy5pdGVtcy5maW5kKCh0KSA9PiB0LnJhdyk/LnJhdzsKICAgICAgcmV0dXJuIGAKICAgICAgICA8ZGl2IGNsYXNzPSJjYXJkIHNvcnQtZ3JvdXAiIGRhdGEtZz0iJHtnaX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0ic29ydC1oZWFkIj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InNvcnQtbWVtbyI+JHtlc2MoZy5tZW1vKX08L3NwYW4+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJzb3J0LXN1bSI+PGI+JHt3b24oZy50b3RhbCl9PC9iPiR7Zy5pdGVtcy5sZW5ndGggPiAxID8gYCDCtyAke2cuaXRlbXMubGVuZ3RofeqxtGAgOiAnJ308L3NwYW4+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InNvcnQtZGF0ZXMiPiR7ZXNjKGRhdGVzKX0ke2cuaXRlbXNbMF0uYWNjb3VudElkICYmIGFjY291bnROYW1lKGcuaXRlbXNbMF0uYWNjb3VudElkKSA/IGAgwrcgJHtlc2MoYWNjb3VudE5hbWUoZy5pdGVtc1swXS5hY2NvdW50SWQpKX1gIDogJyd9PC9kaXY+CiAgICAgICAgICAke3JhdyA/IGA8ZGl2IGNsYXNzPSJzb3J0LXJhdyI+JHtlc2MocmF3KX08L2Rpdj5gIDogJyd9CiAgICAgICAgICA8ZGl2IGNsYXNzPSJwaWNrLXJvdyI+CiAgICAgICAgICAgICR7Y2F0cy5tYXAoKGMsIGkpID0+IGA8YnV0dG9uIGNsYXNzPSJwaWNrLWJ0biIgZGF0YS1jYXQ9IiR7ZXNjKGMuaWQpfSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JHtDLnNlcmllc0NvbG9yKGkpfSI+PC9zcGFuPiR7ZXNjKGMubmFtZSl9PC9idXR0b24+YCkuam9pbignJyl9CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpY2stYnRuIG90aGVyIiBkYXRhLWtpbmQ9InRyYW5zZmVyIj7rgrQg6rOE7KKMIOydtOuPmTwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWNrLWJ0biBvdGhlciIgZGF0YS1raW5kPSJpbmNvbWUiPuyeheq4iDwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICAke2cuaXRlbXMubGVuZ3RoID4gMSA/IGA8ZGV0YWlscz48c3VtbWFyeT7tlZjrgpjslKkg65Sw66GcIOqzoOultOq4sDwvc3VtbWFyeT48ZGl2IGNsYXNzPSJ0eC1saXN0Ij4ke2cuaXRlbXMubWFwKCh0KSA9PiB0eFJvdyh0KSkuam9pbignJyl9PC9kaXY+PC9kZXRhaWxzPmAgOiAnJ30KICAgICAgICA8L2Rpdj5gOwogICAgfSkuam9pbignJyk7CgogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnLnNvcnQtZ3JvdXAnKS5mb3JFYWNoKChjYXJkKSA9PiB7CiAgICAgIGNvbnN0IGcgPSBncm91cHNbTnVtYmVyKGNhcmQuZGF0YXNldC5nKV07CiAgICAgIGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLnBpY2stYnRuJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KCgpID0+IGFzc2lnbkdyb3VwKGcsIGIuZGF0YXNldC5jYXQsIGIuZGF0YXNldC5raW5kKSkpKTsKICAgICAgYmluZFR4RXZlbnRzKGNhcmQpOwogICAgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhc3NpZ25Hcm91cChnLCBjYXRlZ29yeUlkLCBraW5kKSB7CiAgICBjb25zdCBsZWFybiA9ICQoJyNzb3J0LWxlYXJuJykuY2hlY2tlZDsKICAgIGlmIChjYXRlZ29yeUlkICYmIGxlYXJuKSB7CiAgICAgIFMoKS5tZXJjaGFudE1hcFtnLmtleV0gPSBjYXRlZ29yeUlkOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgfQogICAgbGV0IGRvbmUgPSAwOwogICAgYXdhaXQgYnVzeShnLml0ZW1zLmxlbmd0aCA+IDMgPyAn7KCV66as7ZWY64qUIOykkeKApicgOiBudWxsLCBhc3luYyAoKSA9PiB7CiAgICAgIGZvciAoY29uc3QgdCBvZiBnLml0ZW1zKSB7CiAgICAgICAgaWYgKGtpbmQpIHsKICAgICAgICAgIGF3YWl0IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZCwgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsIH0pOwogICAgICAgICAgZG9uZSArPSAxOwogICAgICAgIH0gZWxzZSBpZiAocGxhbkZvckRhdGUodC5kYXRlKS5jYXRlZ29yaWVzLnNvbWUoKGMpID0+IGMuaWQgPT09IGNhdGVnb3J5SWQpKSB7CiAgICAgICAgICAvLyDqt7gg64Kg7Kec7J2YIOqzhO2ajeyXkCDsl4bripQg7ZWt66qp7J2066m0IOqxtOuEiOubtOuLpCAo7KeA64KcIOq4sOqwhCDqs4Ttmo3qs7wg7ZWt66qp7J20IOuLpOulvCDsiJgg7J6I7J2MKQogICAgICAgICAgYXdhaXQgc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kOiAnZXhwZW5zZScsIGNhdGVnb3J5SWQsIG1ldGhvZDogJ21hbnVhbCcgfSk7CiAgICAgICAgICBkb25lICs9IDE7CiAgICAgICAgfQogICAgICB9CiAgICB9KTsKICAgIGNvbnN0IHdoYXQgPSBraW5kID09PSAndHJhbnNmZXInID8gJ+uCtCDqs4Tsoowg7J2064+ZJyA6IGtpbmQgPT09ICdpbmNvbWUnID8gJ+yeheq4iCcgOiBjYXRlZ29yeUluZm8oY2F0ZWdvcnlJZCwgcGxhbkZvckRhdGUoZy5sYXRlc3QpLmNhdGVnb3JpZXMpLm5hbWU7CiAgICBjb25zdCBza2lwcGVkID0gZy5pdGVtcy5sZW5ndGggLSBkb25lOwogICAgdG9hc3QoYCcke2cubWVtb30nICR7ZG9uZX3qsbTsnYQgJHt3aGF0fSjsnLwp66GcIOygleumrO2WiOyWtOyalC5gICsKICAgICAgKHNraXBwZWQgPyBgICgke3NraXBwZWR96rG07J2AIOq3uOuVjCDqs4Ttmo3sl5Ag7J20IO2VreuqqeydtCDsl4bslrQg64Ko6rKoIOuSgOyWtOyalClgIDogJycpICsKICAgICAgKGNhdGVnb3J5SWQgJiYgbGVhcm4gPyAnIOuLpOydjOu2gO2EsCDsnpDrj5nsnLzroZwg67aE66WY7ZW07JqULicgOiAnJykpOwogICAgcmVuZGVyKCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBydW5SZWNsYXNzaWZ5KG9ubHlVbmNsYXNzaWZpZWQpIHsKICAgIGNvbnN0IGxhYmVsID0gc3RvcmUuYWlFbmFibGVkID8gJ0FJ6rCAIOuLpOyLnCDrtoTrpZjtlZjripQg7KSR4oCmJyA6ICfri6Tsi5wg67aE66WY7ZWY64qUIOykkeKApic7CiAgICBjb25zdCBuID0gYXdhaXQgYnVzeShsYWJlbCwgKCkgPT4gc3RvcmUucmVjbGFzc2lmeShjdXJyZW50UGVyaW9kLCBvbmx5VW5jbGFzc2lmaWVkKSk7CiAgICB0b2FzdChuID8gYCR7bn3qsbTsnYQg64uk7IucIOu2hOulmO2WiOyKteuLiOuLpC5gIDogJ+uLpOyLnCDrtoTrpZjtlaAg7KeA7Lac7J20IOyXhuyKteuLiOuLpC4nKTsKICAgIHJlbmRlcigpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrpqztj6ztirggLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBwZXJpb2RMYWJlbChwKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08ocC5zdGFydCk7CiAgICByZXR1cm4gUygpLnNldHRpbmdzLnN0YXJ0RGF5ID09PSAxID8gYCR7bX3sm5RgIDogYCR7bX0vJHtkfWA7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZXBvcnQoKSB7CiAgICBjb25zdCBjbXAgPSBMLmNvbXBhcmVXaXRoUHJldmlvdXMoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IHN1bSA9IGNtcC5jdXJyZW50OwogICAgY29uc3QgZGlmZiA9IGNtcC50b3RhbERpZmY7CiAgICBjb25zdCBwcmV2U3BlbnQgPSBjbXAucHJldmlvdXMudG90YWxTcGVudDsKICAgIGxldCBkZWx0YVRleHQ7CiAgICBpZiAoIXByZXZTcGVudCAmJiAhc3VtLnRvdGFsU3BlbnQpIGRlbHRhVGV4dCA9ICfslYTsp4Eg7KeA7Lac7J20IOyXhuyWtOyalC4nOwogICAgZWxzZSBpZiAoIXByZXZTcGVudCkgZGVsdGFUZXh0ID0gJ+yngOuCnCDquLDqsIQg6riw66Gd7J20IOyXhuyWtCDruYTqtZDtlaAg7IiYIOyXhuyWtOyalC4nOwogICAgZWxzZSBpZiAoZGlmZiA+IDApIGRlbHRhVGV4dCA9IGDsp4Drgpwg6riw6rCE67O064ukIDxiPiR7d29uKGRpZmYpfSDrjZQ8L2I+IOyNvOyWtOyalCDilrJgOwogICAgZWxzZSBpZiAoZGlmZiA8IDApIGRlbHRhVGV4dCA9IGDsp4Drgpwg6riw6rCE67O064ukIDxiPiR7d29uKC1kaWZmKX0g642cPC9iPiDsjbzslrTsmpQg4pa8YDsKICAgIGVsc2UgZGVsdGFUZXh0ID0gJ+yngOuCnCDquLDqsITqs7wg65iR6rCZ7J20IOyNvOyWtOyalC4nOwogICAgY29uc3QgYnVkZ2V0TGluZSA9IHN1bS5oYXNJbmNvbWUgJiYgc3VtLmluY29tZSA+IDAgPyBgPGRpdiBjbGFzcz0iZGVsdGEiPuyYiOyCsOydmCA8Yj4ke01hdGgucm91bmQoKHN1bS50b3RhbFNwZW50IC8gc3VtLmluY29tZSkgKiAxMDApfSU8L2I+IOyCrOyaqTwvZGl2PmAgOiAnJzsKICAgICQoJyNyZXBvcnQtaGVhZGxpbmUnKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9Im11dGVkIHNtYWxsIj7snbTrsogg6riw6rCEIOyngOy2nDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoZWFkbGluZS1maWd1cmUiPiR7d29uKHN1bS50b3RhbFNwZW50KX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZGVsdGEiPiR7ZGVsdGFUZXh0fTwvZGl2PgogICAgICAke2J1ZGdldExpbmV9YDsKCiAgICBjb25zdCB0b3AgPSBMLnRvcE1lcmNoYW50cyhzdW0uYWxsVHJhbnNhY3Rpb25zLCA1KTsKICAgICQoJyNyZXBvcnQtbWVyY2hhbnRzJykuaW5uZXJIVE1MID0gYDxoMj7rp47snbQg7JO0IOqzszwvaDI+JHt0b3AubGVuZ3RoCiAgICAgID8gdG9wLm1hcCgobSwgaSkgPT4gYDxkaXYgY2xhc3M9InJhbmsiPjxzcGFuIGNsYXNzPSJuIj4ke2kgKyAxfTwvc3Bhbj48c3BhbiBjbGFzcz0ibSI+JHtlc2MobS5tZW1vKX0gPHNwYW4gY2xhc3M9Im11dGVkIHNtYWxsIj4ke20uY291bnR97ZqMPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iYSI+JHt3b24obS50b3RhbCl9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7sp4DstpzsnbQg7JeG7Ja07JqULjwvZGl2Pid9YDsKCiAgICBjb25zdCByb3dzID0gTC5jYXRlZ29yeUJyZWFrZG93bihzdW0pOwogICAgY29uc3QgZGlmZkJ5SWQgPSB7fTsKICAgIGZvciAoY29uc3QgciBvZiBjbXAucm93cykgZGlmZkJ5SWRbci5pZF0gPSByLmRpZmY7CiAgICBjb25zdCBzaGFyZSA9ICQoJyNyZXBvcnQtc2hhcmUnKTsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgc2hhcmUuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7snbQg6riw6rCEIOyngOy2nOydtCDsl4bslrTsmpQuPC9kaXY+JzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGZtdERpZmYgPSAoZCkgPT4gKGQgPT09IHVuZGVmaW5lZCA/ICcnIDogZCA+IDAgPyBg4payICR7d29uKGQpfWAgOiBkIDwgMCA/IGDilrwgJHt3b24oLWQpfWAgOiAn67OA64+ZIOyXhuydjCcpOwogICAgICBzaGFyZS5pbm5lckhUTUwgPSBDLnNoYXJlQmFyKHJvd3MpICsgcm93cy5tYXAoKHIpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJzaGFyZS1yb3ciPgogICAgICAgICAgPHNwYW4gY2xhc3M9InNoYXJlLW5hbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiR7Qy5zZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpfSI+PC9zcGFuPjxzcGFuPiR7ZXNjKHIubmFtZSl9IDxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+JHtNYXRoLnJvdW5kKHIuc2hhcmUgKiAxMDApfSU8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzaGFyZS1hbW91bnQiPiR7d29uKHIuYW1vdW50KX08L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic2hhcmUtZGlmZiIgdGl0bGU9IuyngOuCnCDquLDqsIQg64yA67mEIj4ke2ZtdERpZmYoZGlmZkJ5SWRbci5pZF0pfTwvc3Bhbj4KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKTsKICAgICAgY29uc3Qgc2VncyA9IEMuc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgICAgc2hhcmUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtc2VnXScpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgICAgY29uc3QgcyA9IHNlZ3NbZWwuZGF0YXNldC5zZWddOwogICAgICAgIGF0dGFjaFRvb2x0aXAoZWwsICgpID0+IGA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPiR7ZXNjKHMubmFtZSl9PC9zcGFuPjxzcGFuPiR7d29uKHMuYW1vdW50KX08L3NwYW4+PC9kaXY+YCk7CiAgICAgIH0pOwogICAgfQoKICAgIGNvbnN0IHRyID0gTC50cmVuZChTKCksIGN1cnJlbnRQZXJpb2QsIDYpOwogICAgY29uc3QgZGF0YSA9IHRyLm1hcCgoeCkgPT4gKHsgbGFiZWw6IHBlcmlvZExhYmVsKHgucGVyaW9kKSwgaW5jb21lOiB4LmJ1ZGdldEluY29tZSAhPT0gbnVsbCA/IHguYnVkZ2V0SW5jb21lIDogeC5pbmNvbWVSZWNlaXZlZCwgc3BlbnQ6IHguc3BlbnQgfSkpOwogICAgY29uc3QgdHJlbmRFbCA9ICQoJyNyZXBvcnQtdHJlbmQnKTsKICAgIHRyZW5kRWwuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmQiPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMxKSI+PC9zcGFuPuyImOyehTwvc3Bhbj48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1zMikiPjwvc3Bhbj7sp4Dstpw8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0Ij4ke0MudHJlbmRDaGFydChkYXRhKX08L2Rpdj5gOwogICAgdHJlbmRFbC5xdWVyeVNlbGVjdG9yQWxsKCcuaGl0JykuZm9yRWFjaCgoZWwpID0+IHsKICAgICAgY29uc3QgaSA9IE51bWJlcihlbC5kYXRhc2V0LmkpOwogICAgICBjb25zdCB4ID0gdHJbaV07CiAgICAgIGF0dGFjaFRvb2x0aXAoZWwsICgpID0+IGAKICAgICAgICA8c3Ryb25nPiR7Zm10RGF0ZSh4LnBlcmlvZC5zdGFydCl9IH48L3N0cm9uZz4KICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tczEpIj48L3NwYW4+7IiY7J6FJHt4LmJ1ZGdldEluY29tZSA9PT0gbnVsbCA/ICcgKOuwm+ydgCDsnoXquIgpJyA6ICcnfTwvc3Bhbj48c3Bhbj4ke3dvbihkYXRhW2ldLmluY29tZSB8fCAwKX08L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMyKSI+PC9zcGFuPuyngOy2nDwvc3Bhbj48c3Bhbj4ke3dvbih4LnNwZW50KX08L3NwYW4+PC9kaXY+YCk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGN1cnJlbnRQZXJpb2QgPSB4LnBlcmlvZDsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6Q7IKwIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQXNzZXRzKCkgewogICAgY29uc3QgYSA9IEwuYXNzZXRTdW1tYXJ5KFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICBjb25zdCBoYXNCYWxhbmNlID0gYS5iYW5rcy5zb21lKChiKSA9PiB0eXBlb2YgYi5iYWxhbmNlID09PSAnbnVtYmVyJyk7CiAgICAkKCcjYXNzZXQtaGVybycpLmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuqzhOyijCDsnpTslaEg7ZWp6rOEPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZ3VyZSI+JHtoYXNCYWxhbmNlID8gd29uKGEudG90YWwpIDogJ+KAlCd9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHthLnNhdmluZ3MgPyBg7KCA7LaVIOqzhOyijCAke3dvbihhLnNhdmluZ3MpfSDCtyBgIDogJyd965Ox66Gd7ZWcIOqzhOyijCAke2EuYmFua3MubGVuZ3RofeqwnCwg7Lm065OcICR7YS5jYXJkcy5sZW5ndGh96rCcPC9kaXY+YDsKCiAgICBjb25zdCBiYW5rcyA9ICQoJyNhc3NldC1iYW5rcycpOwogICAgYmFua3MuaW5uZXJIVE1MID0gYS5iYW5rcy5sZW5ndGgKICAgICAgPyBhLmJhbmtzLm1hcCgoYikgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9ImFjY3QiPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1pY29uIj4ke2VzYygoYi5uYW1lIHx8ICfqs4TsoownKS5zbGljZSgwLCAxKSl9PC9kaXY+CiAgICAgICAgICA8ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+JHtlc2MoYWNjb3VudE5hbWUoYi5pZCkpfTwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7rgZ3snpDrpqwgJHtlc2MoYi5sYXN0NCB8fCAnLS0tLScpfSR7Yi5pc1NhdmluZ3MgPyAnIMK3IOyggOy2lScgOiAnJ30ke2Iuc3BlbnQgPyBgIMK3IOydtOuyiCDquLDqsIQg7Lac6riIICR7d29uKGIuc3BlbnQpfWAgOiAnJ308L2Rpdj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3R5cGVvZiBiLmJhbGFuY2UgPT09ICdudW1iZXInID8gd29uKGIuYmFsYW5jZSkgOiAnPHNwYW4gY2xhc3M9Im11dGVkIj7snpTslaEg66+47J6F66ClPC9zcGFuPid9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3Qtc3ViIj4ke2IuYmFsYW5jZUF0ID8gYCR7Zm10RGF0ZVRpbWUoYi5iYWxhbmNlQXQpfSDquLDspIAgYCA6ICcnfTxidXR0b24gY2xhc3M9ImxpbmsgZWRpdC1iYWxhbmNlIiBkYXRhLWlkPSIke2VzYyhiLmlkKX0iPuyImOyglTwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDqs4TsoozqsIAg7JeG7Ja07JqULiA8YnV0dG9uIGNsYXNzPSJsaW5rIiBkYXRhLWdvdG89InNldHRpbmdzIj7qs4Tsoowg65Ox66Gd7ZWY6riwPC9idXR0b24+PC9kaXY+JzsKICAgIGJhbmtzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5lZGl0LWJhbGFuY2UnKS5mb3JFYWNoKChidG4pID0+IGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgY29uc3QgYWNjID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGJ0bi5kYXRhc2V0LmlkKTsKICAgICAgY29uc3QgdiA9IHByb21wdChgJHthY2NvdW50TmFtZShhY2MuaWQpfSDsnZgg7ZiE7J6sIOyelOyVoSjsm5ApYCwgdHlwZW9mIGFjYy5iYWxhbmNlID09PSAnbnVtYmVyJyA/IFN0cmluZyhhY2MuYmFsYW5jZSkgOiAnJyk7CiAgICAgIGlmICh2ID09PSBudWxsKSByZXR1cm47CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KHYpOwogICAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIHRvYXN0KCfsiKvsnpDroZwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgICAgYWNjLmJhbGFuY2UgPSBuOwogICAgICBhY2MuYmFsYW5jZUF0ID0gbm93SVNPKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpOwoKICAgICQoJyNhc3NldC1jYXJkcycpLmlubmVySFRNTCA9IGEuY2FyZHMubGVuZ3RoCiAgICAgID8gYS5jYXJkcy5tYXAoKGMpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtaWNvbiBpcy1jYXJkIj4ke2VzYygoYy5uYW1lIHx8ICfsubTrk5wnKS5zbGljZSgwLCAxKSl9PC9kaXY+CiAgICAgICAgICA8ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+JHtlc2MoYWNjb3VudE5hbWUoYy5pZCkpfTwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7rgZ3snpDrpqwgJHtlc2MoYy5sYXN0NCB8fCAnLS0tLScpfTwvZGl2PjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1iYWwiPiR7d29uKGMuc3BlbnQpfTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpICsgKGEudW5saW5rZWRTcGVudCA/IGA8ZGl2IGNsYXNzPSJhY2N0Ij48ZGl2IGNsYXNzPSJhY2N0LWljb24gaXMtY2FyZCI+PzwvZGl2PjxkaXY+PGRpdiBjbGFzcz0iYWNjdC1uYW1lIj7qsrDsoJzsiJjri6gg66qo66aEPC9kaXY+PGRpdiBjbGFzcz0iYWNjdC1zdWIiPuyVjOumvOyXkOyEnCDsubTrk5zCt+qzhOyijOulvCDssL7sp4Ag66q77ZWcIOyngOy2nDwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3dvbihhLnVubGlua2VkU3BlbnQpfTwvZGl2PjwvZGl2PmAgOiAnJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDsubTrk5zqsIAg7JeG7Ja07JqULjwvZGl2Pic7CiAgICAkJCgnI2Fzc2V0LWJhbmtzIFtkYXRhLWdvdG9dLCAjYXNzZXQtY2FyZHMgW2RhdGEtZ290b10nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoYi5kYXRhc2V0LmdvdG8pKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4Ttmo0gLS0tLS0tLS0tLQoKICAvLyDsnbQg6riw6rCE7J2YIOqzhO2ajeydhCDqs6DsuZjquLAg7KCE7JeQIO2YuOy2nDog7KeA64KcIOq4sOqwhCDqs4Ttmo3snYQg66y866Ck67Cb6rOgIOyeiOyXiOuLpOuptCDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDsg4gg6rOE7ZqN7J2EIOunjOuToOuLpC4KICAvLyDtlZzrj4Qg6rOE7IKwIOuwqeyLneunjCDrsJTqv4Ag65WMOiDrtoTrpZjsmYAg7IOB6rSA7JeG7Jy864uIICfri6Tsi5wg67aE66WYJyDslYjrgrTqsIAg65yo7KeAIOyViuqyjCDsiJjsoJUg7Iuc6rCB7J2EIOq3uOuMgOuhnCDrkZTri6QKICBmdW5jdGlvbiBidWRnZXRQbGFuKCkgewogICAgY29uc3QgYmVmb3JlID0gY3VycmVudFBsYW4oKTsKICAgIGNvbnN0IHBsYW4gPSBMLmVuc3VyZVBsYW5Gb3IoUygpLCBjdXJyZW50UGVyaW9kLmtleSwgbm93SVNPKCkpOwogICAgaWYgKHBsYW4gIT09IGJlZm9yZSkgcGxhbi51cGRhdGVkQXQgPSBiZWZvcmUudXBkYXRlZEF0OwogICAgcmV0dXJuIHBsYW47CiAgfQoKICBmdW5jdGlvbiBlZGl0YWJsZVBsYW4oKSB7CiAgICBjb25zdCBwbGFuID0gTC5lbnN1cmVQbGFuRm9yKFMoKSwgY3VycmVudFBlcmlvZC5rZXksIG5vd0lTTygpKTsKICAgIHBsYW4udXBkYXRlZEF0ID0gbm93SVNPKCk7CiAgICByZXR1cm4gcGxhbjsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclBsYW5WZXJzaW9uKCkgewogICAgY29uc3QgcGxhbiA9IGN1cnJlbnRQbGFuKCk7CiAgICBjb25zdCBpbmhlcml0ZWQgPSBwbGFuLmZyb20gIT09IGN1cnJlbnRQZXJpb2Qua2V5OwogICAgY29uc3QgbmV4dCA9IEwubmV4dFBsYW5BZnRlcihTKCksIHsgZnJvbTogY3VycmVudFBlcmlvZC5rZXkgfSk7CiAgICBjb25zdCBwYXJ0cyA9IFtgPGI+JHtmbXREYXRlKGN1cnJlbnRQZXJpb2Quc3RhcnQpfSDquLDqsITsnZgg6rOE7ZqNPC9iPmBdOwogICAgcGFydHMucHVzaChwbGFuLmZyb20gPT09IEwuQkFTRV9QTEFOX0ZST00gPyAn7LKY7J2M67aA7YSwIOyTsOuNmCDqs4Ttmo3snoXri4jri6QuJyA6IGAke2ZtdERhdGUocGxhbi5mcm9tKX0g6riw6rCE67aA7YSwIOyggeyaqeuQnCDqs4Ttmo3snoXri4jri6QuYCk7CiAgICBwYXJ0cy5wdXNoKGluaGVyaXRlZAogICAgICA/ICfsl6zquLDshJwg6rOg7LmY66m0IDxiPuydtOuyiCDquLDqsITrtoDthLA8L2I+IOyDiCDqs4Ttmo3snLzroZwg7KCA7J6l65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuVjCDqs4Ttmo0g6re464yA66GcIOuCqOyVhOyalC4nCiAgICAgIDogJ+qzoOy5mOuptCDsnbQg6riw6rCE6rO8IOydtO2bhCDquLDqsITsl5Ag7KCB7Jqp65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuMgOuhnCDrgqjslYTsmpQuJyk7CiAgICBpZiAobmV4dCkgcGFydHMucHVzaChgJHtmbXREYXRlKG5leHQuZnJvbSl9IOq4sOqwhOu2gO2EsOuKlCDqt7gg65Kk7JeQIOuwlOq+vCDqs4Ttmo3snbQg7KCB7Jqp64+87JqULmApOwogICAgJCgnI3BsYW4tdmVyc2lvbicpLmlubmVySFRNTCA9IHBhcnRzLm1hcCgoeCkgPT4gYDxkaXYgY2xhc3M9InNtYWxsIj4ke3h9PC9kaXY+YCkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJQbGFuKCkgewogICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgIGNvbnN0IHBsYW4gPSBjdXJyZW50UGxhbigpOwogICAgJCgnI3JhdGlvLWJhc2UnKS52YWx1ZSA9IHBsYW4ucmF0aW9CYXNlOwogICAgJCgnI2ZpeGVkLW92ZXJmbG93JykudmFsdWUgPSBwbGFuLmZpeGVkT3ZlcmZsb3cgfHwgJ3dhcm4nOwoKICAgIGNvbnN0IHJvd3NFbCA9ICQoJyNwbGFuLXJvd3MnKTsKICAgIHJvd3NFbC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9InBsYW4tcm93IGhlYWQiPjxzcGFuPu2VreuqqSDsnbTrpoQ8L3NwYW4+PHNwYW4+67Cp7IudPC9zcGFuPjxzcGFuPuu5hOycqCAvIOq4iOyVoTwvc3Bhbj48c3Bhbj7shKTrqoUgKEFJIOywuOqzoCk8L3NwYW4+PHNwYW4+7YKk7JuM65OcPC9zcGFuPjxzcGFuPjwvc3Bhbj48L2Rpdj4KICAgICAgJHtwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0icGxhbi1yb3ciIGRhdGEtaWQ9IiR7ZXNjKGMuaWQpfSI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InBsLW5hbWUiIHZhbHVlPSIke2VzYyhjLm5hbWUpfSIgYXJpYS1sYWJlbD0i7ZWt66qpIOydtOumhCI+CiAgICAgICAgICA8c2VsZWN0IGNsYXNzPSJwbC10eXBlIiBhcmlhLWxhYmVsPSLrsKnsi50iPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyYXRpbyIgJHtjLnR5cGUgPT09ICdyYXRpbycgPyAnc2VsZWN0ZWQnIDogJyd9PuyImOyehSDruYTroYAoJSk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZml4ZWQiICR7Yy50eXBlID09PSAnZml4ZWQnID8gJ3NlbGVjdGVkJyA6ICcnfT7qs6DsoJUg6riI7JWhPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDxkaXYgY2xhc3M9InZhbHVlLXdyYXAiPgogICAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJkZWNpbWFsIiBjbGFzcz0icGwtdmFsdWUiIHZhbHVlPSIke2MudHlwZSA9PT0gJ2ZpeGVkJyA/IE51bWJlcihjLnZhbHVlKS50b0xvY2FsZVN0cmluZygna28tS1InKSA6IGMudmFsdWV9IiBhcmlhLWxhYmVsPSLqsJIiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idW5pdCI+JHtjLnR5cGUgPT09ICdmaXhlZCcgPyAn7JuQJyA6ICclJ308L3NwYW4+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwtZGVzYyIgdmFsdWU9IiR7ZXNjKGMuZGVzY3JpcHRpb24gfHwgJycpfSIgcGxhY2Vob2xkZXI9IuyYiDog7Jm47IudLCDrsLDri6wsIOyepeuztOq4sCIgYXJpYS1sYWJlbD0i7ISk66qFIj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwta3ciIHZhbHVlPSIke2VzYygoYy5rZXl3b3JkcyB8fCBbXSkuam9pbignLCAnKSl9IiBwbGFjZWhvbGRlcj0i7JiIOiDsiqTtg4DrsoXsiqQsIOy5tO2OmCIgYXJpYS1sYWJlbD0i7YKk7JuM65OcIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImxpbmstYnRuIHBsLWRlbCIgYXJpYS1sYWJlbD0iJHtlc2MoYy5uYW1lKX0g7IKt7KCcIj7inJU8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgY2xhc3M9InByZXZpZXciPjwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpfWA7CgogICAgY29uc3QgZWRpdCA9IChpZCwgZm4sIHJlcmVuZGVyKSA9PiB7CiAgICAgIGNvbnN0IGMgPSBlZGl0YWJsZVBsYW4oKS5jYXRlZ29yaWVzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgICAgZm4oYyk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIGlmIChyZXJlbmRlcikgcmVuZGVyUGxhbigpOwogICAgICBlbHNlIHsKICAgICAgICByZW5kZXJQbGFuVmVyc2lvbigpOwogICAgICAgIHJlbmRlclBsYW5TdW1tYXJ5KCk7CiAgICAgIH0KICAgIH07CgogICAgcm93c0VsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5wbGFuLXJvd1tkYXRhLWlkXScpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBpZCA9IHJvdy5kYXRhc2V0LmlkOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLW5hbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IChjLm5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCkgfHwgJ+ydtOumhCDsl4bsnYwnKSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXR5cGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IHsKICAgICAgICBjLnR5cGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBjLnZhbHVlID0gMDsKICAgICAgfSwgdHJ1ZSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXZhbHVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiB7CiAgICAgICAgY29uc3QgbiA9IE51bWJlcihlLnRhcmdldC52YWx1ZS5yZXBsYWNlKC9bXlxkLl0vZywgJycpKSB8fCAwOwogICAgICAgIGMudmFsdWUgPSBjLnR5cGUgPT09ICdmaXhlZCcgPyBNYXRoLnJvdW5kKG4pIDogTWF0aC5yb3VuZChuICogMTAwKSAvIDEwMDsKICAgICAgICBpZiAoYy50eXBlID09PSAnZml4ZWQnKSBlLnRhcmdldC52YWx1ZSA9IGMudmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyk7CiAgICAgIH0pKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1kZXNjJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiAoYy5kZXNjcmlwdGlvbiA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKSkpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1rdycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBlZGl0KGlkLCAoYykgPT4gewogICAgICAgIGMua2V5d29yZHMgPSBlLnRhcmdldC52YWx1ZS5zcGxpdCgvWyzvvIxdLykubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICB9KSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcucGwtZGVsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY29uc3QgYyA9IGN1cnJlbnRQbGFuKCkuY2F0ZWdvcmllcy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHtjLm5hbWV9JyDtla3rqqnsnYQg7J2067KIIOq4sOqwhCDqs4Ttmo3rtoDthLAg67qE6rmM7JqUPyDsnbQg7ZWt66qp7Jy866GcIOu2hOulmOuQnCDsnbTrsogg6riw6rCEIOyngOy2nOydgCDri6Tsi5wg67aE66WY7ZW07JW8IO2VqeuLiOuLpC5gKSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHAgPSBlZGl0YWJsZVBsYW4oKTsKICAgICAgICBwLmNhdGVnb3JpZXMgPSBwLmNhdGVnb3JpZXMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgICByZW5kZXJQbGFuKCk7CiAgICAgIH0pOwogICAgfSk7CiAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUGxhblN1bW1hcnkoKSB7CiAgICBjb25zdCBwbGFuID0gY3VycmVudFBsYW4oKTsKICAgIGNvbnN0IGluY29tZSA9IFMoKS5pbmNvbWVzW2N1cnJlbnRQZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IEwuY29tcHV0ZUJ1ZGdldHMocGxhbi5jYXRlZ29yaWVzLCBoYXNJbmNvbWUgPyBpbmNvbWUgOiAwLCBwbGFuLnJhdGlvQmFzZSwgcGxhbi5maXhlZE92ZXJmbG93KTsKCiAgICAkJCgnLnBsYW4tcm93W2RhdGEtaWRdJykuZm9yRWFjaCgocm93KSA9PiB7CiAgICAgIGNvbnN0IGMgPSBwbGFuLmNhdGVnb3JpZXMuZmluZCgoeCkgPT4geC5pZCA9PT0gcm93LmRhdGFzZXQuaWQpOwogICAgICBjb25zdCBwID0gcm93LnF1ZXJ5U2VsZWN0b3IoJy5wcmV2aWV3Jyk7CiAgICAgIGlmICghYykgcmV0dXJuOwogICAgICBpZiAoYy50eXBlID09PSAnZml4ZWQnKSB7CiAgICAgICAgcC50ZXh0Q29udGVudCA9IGhhc0luY29tZSAmJiBjYWxjLmZpeGVkU2NhbGVkCiAgICAgICAgICA/IGDsnbTrsogg6riw6rCEIO2VnOuPhCAke3dvbihjYWxjLmJ1ZGdldHNbYy5pZF0pfSAo7IiY7J6F7J20IOuqqOyekOudvCDspITsnoQpYAogICAgICAgICAgOiAn7IiY7J6F6rO8IOyDgeq0gOyXhuydtCDrp6Qg6riw6rCEIOqwmeydgCDtlZzrj4QnOwogICAgICB9CiAgICAgIGVsc2UgcC50ZXh0Q29udGVudCA9IGhhc0luY29tZSA/IGDsnbTrsogg6riw6rCEIO2VnOuPhCAke3dvbihjYWxjLmJ1ZGdldHNbYy5pZF0pfWAgOiAn64u56riwIOyImOyeheydhCDsnoXroKXtlZjrqbQg7ZWc64+E6rCAIOqzhOyCsOuQqeuLiOuLpCc7CiAgICB9KTsKCiAgICBjb25zdCBiYXNlID0gcGxhbi5yYXRpb0Jhc2UgPT09ICdhZnRlckZpeGVkJyA/ICfqs6DsoJUg7ZWt66qp7J2EIOu6gCDrgpjrqLjsp4AnIDogJ+yghOyytCDsiJjsnoUnOwogICAgY29uc3QgbGluZXMgPSBbYOqzoOyglSDtla3rqqkg7ZWp6rOEIDxiPiR7d29uKGNhbGMuZml4ZWRUb3RhbCl9PC9iPiDCtyDruYTsnKgg7ZWt66qpIO2VqeqzhCA8Yj4ke2NhbGMucmF0aW9QZXJjZW50VG90YWx9JTwvYj4gKCR7YmFzZX0g6riw7KSAKWBdOwogICAgaWYgKGNhbGMucmF0aW9QZXJjZW50VG90YWwgPiAxMDApIGxpbmVzLnB1c2goJzxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg67mE7JyoIO2VqeqzhOqwgCAxMDAl66W8IOuEmOyKteuLiOuLpC48L3NwYW4+Jyk7CiAgICBlbHNlIGlmIChjYWxjLnJhdGlvUGVyY2VudFRvdGFsIDwgMTAwKSBsaW5lcy5wdXNoKGA8c3BhbiBjbGFzcz0ibXV0ZWQiPuu5hOycqCDtlanqs4TqsIAgMTAwJeuztOuLpCAke01hdGgucm91bmQoKDEwMCAtIGNhbGMucmF0aW9QZXJjZW50VG90YWwpICogMTAwKSAvIDEwMH0lIOyggeyWtCDsnbzrtoAg7IiY7J6F7J2AIOuwsOu2hOuQmOyngCDslYrsirXri4jri6QuPC9zcGFuPmApOwogICAgaWYgKGhhc0luY29tZSkgewogICAgICBsaW5lcy5wdXNoKGDsnbTrsogg6riw6rCEIOyImOyehSAke3dvbihpbmNvbWUpfSDquLDspIA6IOuwsOu2hCAke3dvbihjYWxjLmFsbG9jYXRlZCl9YCArCiAgICAgICAgKGNhbGMudW5hbGxvY2F0ZWQgPj0gMCA/IGAgwrcg64Ko64qUIOuPiCAke3dvbihjYWxjLnVuYWxsb2NhdGVkKX1gIDogYCDCtyA8c3BhbiBjbGFzcz0id2FybiI+JHt3b24oLWNhbGMudW5hbGxvY2F0ZWQpfSDrtoDsobE8L3NwYW4+YCkpOwogICAgICBpZiAoY2FsYy5maXhlZE92ZXIpIHsKICAgICAgICBsaW5lcy5wdXNoKGNhbGMuZml4ZWRTY2FsZWQKICAgICAgICAgID8gYDxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukICR7d29uKGNhbGMuZml4ZWRPdmVyKX0g66eO7JWELCDqs6DsoJUg7ZWt66qpIO2VnOuPhOulvCDslb0gJHtNYXRoLnJvdW5kKGNhbGMuZml4ZWRTY2FsZSAqIDEwMCl9JeuhnCDspITsmIDsirXri4jri6QuPC9zcGFuPmAKICAgICAgICAgIDogYDxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukICR7d29uKGNhbGMuZml4ZWRPdmVyKX0g66eO7Iq164uI64ukLjwvc3Bhbj5gKTsKICAgICAgfQogICAgfQogICAgJCgnI3BsYW4tc3VtbWFyeScpLmlubmVySFRNTCA9IGxpbmVzLm1hcCgobCkgPT4gYDxkaXY+JHtsfTwvZGl2PmApLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gYWRkQ2F0ZWdvcnkoKSB7CiAgICBjb25zdCBwbGFuID0gZWRpdGFibGVQbGFuKCk7CiAgICBwbGFuLmNhdGVnb3JpZXMucHVzaCh7IGlkOiBgYy0ke3VpZCgpfWAsIG5hbWU6ICfsg4gg7ZWt66qpJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDAsIGRlc2NyaXB0aW9uOiAnJywga2V5d29yZHM6IFtdIH0pOwogICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIHJlbmRlclBsYW4oKTsKICAgIGNvbnN0IGlucHV0cyA9ICQkKCcucGwtbmFtZScpOwogICAgY29uc3QgbGFzdCA9IGlucHV0c1tpbnB1dHMubGVuZ3RoIC0gMV07CiAgICBsYXN0LmZvY3VzKCk7CiAgICBsYXN0LnNlbGVjdCgpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsnoXroKUgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJBZGQoKSB7CiAgICAkKCcjYXV0by1oaW50JykuaW5uZXJIVE1MID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScKICAgICAgPyAnPGI+7Lm065OcIOusuOyekOyZgCDsnYDtlokg7JWM66a87J2AIOyekOuPmeycvOuhnCDrk6TslrTsmYDsmpQuPC9iPiA8c3BhbiBjbGFzcz0ic21hbGwiPu2ctOuMgO2PsCDsnpDrj5ntmZQo7ISk7KCVIOKGkiDsnpDrj5kg7J6F66ClKeulvCDtlbQg65GQ66m0IOqysOygnMK37J207LK0IOyVjOumvOydtCDsmKwg65WM66eI64ukIEFJ6rCAIOydveqzoCDrtoTrpZjtlbTshJwg6riw66Gd7ZWp64uI64ukLiDsl6zquLDshJzripQg6re4IOuwluydmCDrgrTsl63snYQg64Sj7Jy87IS47JqULjwvc3Bhbj4nCiAgICAgIDogJzxiPuyngOq4iOydgCDsnbQg6riw6riw7JeQ66eMIOyggOyepe2VmOuKlCDrqqjrk5zsmIjsmpQuPC9iPiA8c3BhbiBjbGFzcz0ic21hbGwiPuy5tOuTnMK37J2A7ZaJIOyVjOumvCDsnpDrj5kg7J6F66Cl6rO8IEFJIOu2hOulmOulvCDsk7DroKTrqbQg7ISk7KCVIOKGkiDsnpDrj5kg7J6F66Cl7JeQ7IScIOq1rOq4gCDsi5ztirgg7ISc67KE66W8IOyXsOqysO2VmOyEuOyalC48L3NwYW4+JzsKICAgICQoJyNjbGFzc2lmaWVyLW5hbWUnKS50ZXh0Q29udGVudCA9IHN0b3JlLmFpRW5hYmxlZCA/ICdBSeqwgCDtla3rqqknIDogJ+2CpOybjOuTnOuhnCDtla3rqqknOwoKICAgICQkKCcjbS1raW5kIGJ1dHRvbicpLmZvckVhY2goKGIpID0+IGIuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYi5kYXRhc2V0LmtpbmQgPT09IG1hbnVhbEtpbmQpKTsKICAgICQoJyNtLWNhdGVnb3J5LXdyYXAnKS5oaWRkZW4gPSBtYW51YWxLaW5kICE9PSAnZXhwZW5zZSc7CiAgICBjb25zdCBzZWwgPSAkKCcjbS1jYXRlZ29yeScpOwogICAgY29uc3QgcHJldiA9IHNlbC52YWx1ZSB8fCAnX19hdXRvJzsKICAgIGlmICghJCgnI20tZGF0ZScpLnZhbHVlKSAkKCcjbS1kYXRlJykudmFsdWUgPSBMLnRvZGF5SVNPKCk7CiAgICBzZWwuaW5uZXJIVE1MID0gY2F0ZWdvcnlPcHRpb25zKHBsYW5Gb3JEYXRlKCQoJyNtLWRhdGUnKS52YWx1ZSkuY2F0ZWdvcmllcywgbnVsbCwgeyBpbmNsdWRlQXV0bzogdHJ1ZSB9KTsKICAgIHNlbC52YWx1ZSA9IFsuLi5zZWwub3B0aW9uc10uc29tZSgobykgPT4gby52YWx1ZSA9PT0gcHJldikgPyBwcmV2IDogJ19fYXV0byc7CiAgICBjb25zdCBhY2MgPSAkKCcjbS1hY2NvdW50JykudmFsdWU7CiAgICAkKCcjbS1hY2NvdW50JykuaW5uZXJIVE1MID0gYWNjb3VudE9wdGlvbnMoYWNjKTsKICAgIGNvbnN0IGZpbGVBY2MgPSAkKCcjZmlsZS1hY2NvdW50JykudmFsdWUgfHwgKFMoKS5hY2NvdW50cy5maW5kKChhKSA9PiBhLnR5cGUgIT09ICdjYXJkJykgfHwge30pLmlkIHx8ICcnOwogICAgJCgnI2ZpbGUtYWNjb3VudCcpLmlubmVySFRNTCA9IGFjY291bnRPcHRpb25zKGZpbGVBY2MsICfqs4Tsoowg7ISg7YOdIOyViCDtlagnKTsKICAgICQoJyNtLW1lbW8nKS5wbGFjZWhvbGRlciA9IG1hbnVhbEtpbmQgPT09ICdpbmNvbWUnID8gJyjso7wp7ZqM7IKsIOq4ieyXrCcgOiBtYW51YWxLaW5kID09PSAndHJhbnNmZXInID8gJ+yggeq4iCDqs4TsoozroZwnIDogJ+yKpO2DgOuyheyKpCDqsJXrgqjsoJAnOwogICAgdXBkYXRlTWFudWFsSGludCgpOwogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIGZ1bmN0aW9uIHVwZGF0ZU1hbnVhbEhpbnQoKSB7CiAgICBjb25zdCBtZW1vID0gJCgnI20tbWVtbycpLnZhbHVlOwogICAgaWYgKG1hbnVhbEtpbmQgPT09ICd0cmFuc2ZlcicpIHsKICAgICAgJCgnI20taGludCcpLnRleHRDb250ZW50ID0gJ+uCtCDqs4Tsoozrgbzrpqwg7Jiu6ri0IOuPiOydgCDsp4DstpzCt+yImOyehSDtlanqs4Tsl5DshJwg67mg7KeR64uI64ukLiDsoIDstpUg66qp7KCB7J2066m0ICLsp4Dstpwi66GcIOuEo+qzoCDsoIDstpUg7ZWt66qp7J2EIOqzoOultOyEuOyalC4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAobWFudWFsS2luZCAhPT0gJ2V4cGVuc2UnIHx8ICQoJyNtLWNhdGVnb3J5JykudmFsdWUgIT09ICdfX2F1dG8nIHx8ICFtZW1vLnRyaW0oKSkgewogICAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSAnJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKHN0b3JlLmFpRW5hYmxlZCkgewogICAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSAn7LaU6rCA7ZWY66m0IEFJ6rCAIO2VreuqqeydhCDsoJXtlanri4jri6QuJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgcGxhbiA9IHBsYW5Gb3JEYXRlKCQoJyNtLWRhdGUnKS52YWx1ZSB8fCBMLnRvZGF5SVNPKCkpOwogICAgY29uc3QgciA9IEwuY2xhc3NpZnlMb2NhbChtZW1vLCBwbGFuLmNhdGVnb3JpZXMsIFMoKS5tZXJjaGFudE1hcCk7CiAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSBg7J6Q64+ZIOu2hOulmCDqsrDqs7w6ICR7Y2F0ZWdvcnlJbmZvKHIuY2F0ZWdvcnlJZCwgcGxhbi5jYXRlZ29yaWVzKS5uYW1lfWA7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvbk1hbnVhbFN1Ym1pdChlKSB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBkYXRlID0gJCgnI20tZGF0ZScpLnZhbHVlOwogICAgY29uc3QgYW1vdW50ID0gcGFyc2VBbW91bnRJbnB1dCgkKCcjbS1hbW91bnQnKS52YWx1ZSk7CiAgICBjb25zdCBtZW1vID0gJCgnI20tbWVtbycpLnZhbHVlLnRyaW0oKSB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgIGlmICghZGF0ZSkgcmV0dXJuIHRvYXN0KCfrgqDsp5zrpbwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgIGlmIChhbW91bnQgPT09IG51bGwgfHwgYW1vdW50ID09PSAwKSByZXR1cm4gdG9hc3QoJ+q4iOyVoeydhCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgY29uc3Qgc2VsID0gbWFudWFsS2luZCA9PT0gJ2V4cGVuc2UnID8gJCgnI20tY2F0ZWdvcnknKS52YWx1ZSA6ICcnOwogICAgaWYgKHNlbCAmJiBzZWwgIT09ICdfX2F1dG8nKSB7CiAgICAgIFMoKS5tZXJjaGFudE1hcFtMLm5vcm1hbGl6ZU1lcmNoYW50KG1lbW8pXSA9IHNlbDsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIH0KICAgIGNvbnN0IGl0ZW0gPSB7CiAgICAgIGRhdGUsIGFtb3VudCwgbWVtbywga2luZDogbWFudWFsS2luZCwgYWNjb3VudElkOiAkKCcjbS1hY2NvdW50JykudmFsdWUgfHwgbnVsbCwgc291cmNlOiAnbWFudWFsJywKICAgICAgY2F0ZWdvcnlJZDogc2VsID09PSAnJyA/IG51bGwgOiBzZWwsCiAgICAgIG1ldGhvZDogc2VsICYmIHNlbCAhPT0gJ19fYXV0bycgPyAnbWFudWFsJyA6IHVuZGVmaW5lZCwKICAgIH07CiAgICBjb25zdCBbdHhdID0gYXdhaXQgYnVzeShzZWwgPT09ICdfX2F1dG8nICYmIHN0b3JlLmFpRW5hYmxlZCA/ICdBSeqwgCDrtoTrpZjtlZjripQg7KSR4oCmJyA6IG51bGwsICgpID0+IHN0b3JlLmFkZFRyYW5zYWN0aW9ucyhbaXRlbV0pKTsKICAgICQoJyNtLWFtb3VudCcpLnZhbHVlID0gJyc7CiAgICAkKCcjbS1tZW1vJykudmFsdWUgPSAnJzsKICAgIHVwZGF0ZU1hbnVhbEhpbnQoKTsKICAgIGNvbnN0IHdoYXQgPSBtYW51YWxLaW5kID09PSAnZXhwZW5zZScgPyBgJHtjYXRlZ29yeUluZm8odHguY2F0ZWdvcnlJZCwgcGxhbkZvckRhdGUodHguZGF0ZSkuY2F0ZWdvcmllcykubmFtZX0g7ZWt66qp7JeQYCA6IG1hbnVhbEtpbmQgPT09ICdpbmNvbWUnID8gJ+yeheq4iOycvOuhnCcgOiAn64K0IOqzhOyijCDsnbTssrTroZwnOwogICAgdG9hc3QoYCR7d2hhdH0gJHt3b24oYW1vdW50KX0g7LaU6rCA7ZaI7Iq164uI64ukLmApOwogICAganVtcFRvRGF0ZShkYXRlKTsKICB9CgogIGZ1bmN0aW9uIGp1bXBUb0RhdGUoZGF0ZSkgewogICAgY29uc3QgcCA9IEwuZ2V0UGVyaW9kKGRhdGUsIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICBpZiAocC5rZXkgIT09IGN1cnJlbnRQZXJpb2Qua2V5KSBjdXJyZW50UGVyaW9kID0gcDsKICAgIHJlbmRlcigpOwogIH0KCiAgLy8g67aZ7Jes64Sj6riw7JmAIO2MjOydvCDqsIDsoLjsmKTquLDqsIAg6rCZ7J2AIOuvuOumrOuztOq4sOulvCDsk7Tri6QuIHByZXZpZXcuc291cmNlOiAncGFzdGUnIHwgJ2ZpbGUnCiAgY29uc3QgcHJldmlldyA9IHsgc291cmNlOiAncGFzdGUnLCBpdGVtczogW10sIHNraXBwZWQ6IFtdLCBsYXRlc3Q6IG51bGwsIGFjY291bnRJZDogbnVsbCwgZmlsZU5hbWU6ICcnIH07CgogIGZ1bmN0aW9uIGNsZWFyUHJldmlldygpIHsKICAgIE9iamVjdC5hc3NpZ24ocHJldmlldywgeyBpdGVtczogW10sIHNraXBwZWQ6IFtdLCBsYXRlc3Q6IG51bGwsIGFjY291bnRJZDogbnVsbCwgZmlsZU5hbWU6ICcnIH0pOwogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIC8vIOyngOy2nOunjCDrtoTrpZjtlZzri6QuIOyEnOuyhChBSSnripQg7Jes65+sIOuyiOyXkCDrgpjriKAg67O064K464ukLgogIGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5UHJldmlldyhpdGVtcykgewogICAgY29uc3QgZXhwZW5zZXMgPSBpdGVtcy5maWx0ZXIoKGl0KSA9PiBpdC5raW5kID09PSAnZXhwZW5zZScpOwogICAgY29uc3Qgc3RlcCA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnID8gNjAgOiBleHBlbnNlcy5sZW5ndGggfHwgMTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZXhwZW5zZXMubGVuZ3RoOyBpICs9IHN0ZXApIHsKICAgICAgY29uc3QgY2h1bmsgPSBleHBlbnNlcy5zbGljZShpLCBpICsgc3RlcCk7CiAgICAgIGlmIChzdG9yZS5haUVuYWJsZWQgJiYgZXhwZW5zZXMubGVuZ3RoID4gc3RlcCkgdG9hc3QoYEFJ6rCAIOu2hOulmO2VmOuKlCDspJHigKYgKCR7TWF0aC5taW4oaSArIHN0ZXAsIGV4cGVuc2VzLmxlbmd0aCl9LyR7ZXhwZW5zZXMubGVuZ3RofSlgLCA2MDAwMCk7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHN0b3JlLmNsYXNzaWZ5KGNodW5rLm1hcCgoeyBkYXRlLCBhbW91bnQsIG1lbW8gfSkgPT4gKHsgZGF0ZSwgYW1vdW50LCBtZW1vIH0pKSk7CiAgICAgIGNodW5rLmZvckVhY2goKGl0LCBrKSA9PiBPYmplY3QuYXNzaWduKGl0LCByZXNba10pKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHdpdGhEdXBGbGFncyhpdGVtcykgewogICAgcmV0dXJuIGl0ZW1zLm1hcCgoaXQpID0+IHsKICAgICAgY29uc3QgZHVwID0gISFMLmZpbmREdXBsaWNhdGUoaXQsIFMoKS50cmFuc2FjdGlvbnMpOwogICAgICByZXR1cm4geyBjYXRlZ29yeUlkOiBudWxsLCBtZXRob2Q6IG51bGwsIC4uLml0LCBkdXAsIGNoZWNrZWQ6ICFkdXAgfTsKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb25QYXJzZSgpIHsKICAgIGNvbnN0IHsgaXRlbXMsIHNraXBwZWQgfSA9IEwucGFyc2VFeHBlbnNlVGV4dCgkKCcjcGFzdGUtaW5wdXQnKS52YWx1ZSwgTC50b2RheUlTTygpKTsKICAgIE9iamVjdC5hc3NpZ24ocHJldmlldywgeyBzb3VyY2U6ICdwYXN0ZScsIHNraXBwZWQsIGxhdGVzdDogbnVsbCwgYWNjb3VudElkOiBudWxsLCBmaWxlTmFtZTogJycgfSk7CiAgICBwcmV2aWV3Lml0ZW1zID0gd2l0aER1cEZsYWdzKGl0ZW1zLm1hcCgoaXQpID0+ICh7IC4uLml0LCBraW5kOiAnZXhwZW5zZScgfSkpKTsKICAgIGlmIChwcmV2aWV3Lml0ZW1zLmxlbmd0aCkgYXdhaXQgYnVzeShzdG9yZS5haUVuYWJsZWQgPyBgQUnqsIAgJHtwcmV2aWV3Lml0ZW1zLmxlbmd0aH3qsbTsnYQg67aE66WY7ZWY64qUIOykkeKApmAgOiBudWxsLCAoKSA9PiBjbGFzc2lmeVByZXZpZXcocHJldmlldy5pdGVtcykpOwogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9uRmlsZUNob3NlbihmaWxlKSB7CiAgICBjb25zdCBhY2NvdW50SWQgPSAkKCcjZmlsZS1hY2NvdW50JykudmFsdWUgfHwgbnVsbDsKICAgIGxldCByb3dzOwogICAgdHJ5IHsKICAgICAgcm93cyA9IGF3YWl0IHdpbmRvdy5CdWRnZXRYbHN4LnJlYWRUYWJsZUZpbGUoZmlsZSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIHJldHVybiB0b2FzdChlLm1lc3NhZ2UgfHwgJ+2MjOydvOydhCDsnb3sp4Ag66q77ZaI7Ja07JqULicsIDcwMDApOwogICAgfQogICAgY29uc3QgcGFyc2VkID0gTC5wYXJzZVN0YXRlbWVudFJvd3Mocm93cywgeyBteU5hbWU6IFMoKS5zZXR0aW5ncy5teU5hbWUsIGFjY291bnRJZCB9KTsKICAgIGlmICghcGFyc2VkLmhlYWRlcikgcmV0dXJuIHRvYXN0KCfqsbDrnpjrgrTsl60g7ZGc66W8IOywvuyngCDrqrvtlojslrTsmpQuIOuCoOynnOyZgCDquIjslaEg7Lm47J20IOyeiOuKlCDsnYDtlokg6rGw656Y64K07JetIO2MjOydvOyduOyngCDtmZXsnbjtlbQg7KO87IS47JqULicsIDcwMDApOwogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IHNvdXJjZTogJ2ZpbGUnLCBza2lwcGVkOiBbXSwgbGF0ZXN0OiBwYXJzZWQubGF0ZXN0LCBhY2NvdW50SWQsIGZpbGVOYW1lOiBmaWxlLm5hbWUgfSk7CiAgICBwcmV2aWV3Lml0ZW1zID0gd2l0aER1cEZsYWdzKHBhcnNlZC5pdGVtcyk7CiAgICBpZiAocGFyc2VkLnNraXBwZWQpIHByZXZpZXcuc2tpcHBlZCA9IFtg64Kg7Kec66W8IOydveyngCDrqrvtlZwg7KSEICR7cGFyc2VkLnNraXBwZWR96rCcYF07CiAgICBpZiAocHJldmlldy5pdGVtcy5sZW5ndGgpIHsKICAgICAgYXdhaXQgYnVzeShzdG9yZS5haUVuYWJsZWQgPyBgQUnqsIAgJHtwcmV2aWV3Lml0ZW1zLmZpbHRlcigoeCkgPT4geC5raW5kID09PSAnZXhwZW5zZScpLmxlbmd0aH3qsbTsnYQg67aE66WY7ZWY64qUIOykkeKApmAgOiBudWxsLCAoKSA9PiBjbGFzc2lmeVByZXZpZXcocHJldmlldy5pdGVtcykpOwogICAgfQogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIGNvbnN0IEtJTkRfTEFCRUwgPSB7IGluY29tZTogJ+yeheq4iCcsIHRyYW5zZmVyOiAn64K0IOqzhOyijCDsnbTssrQnIH07CgogIGZ1bmN0aW9uIHJlbmRlclBhcnNlUmVzdWx0KCkgewogICAgY29uc3QgdGFyZ2V0ID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyA/ICQoJyNmaWxlLXJlc3VsdCcpIDogJCgnI3BhcnNlLXJlc3VsdCcpOwogICAgY29uc3Qgb3RoZXIgPSBwcmV2aWV3LnNvdXJjZSA9PT0gJ2ZpbGUnID8gJCgnI3BhcnNlLXJlc3VsdCcpIDogJCgnI2ZpbGUtcmVzdWx0Jyk7CiAgICBvdGhlci5pbm5lckhUTUwgPSAnJzsKICAgIGlmICghcHJldmlldy5pdGVtcy5sZW5ndGggJiYgIXByZXZpZXcuc2tpcHBlZC5sZW5ndGgpIHsKICAgICAgdGFyZ2V0LmlubmVySFRNTCA9ICcnOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBpdGVtcyA9IHByZXZpZXcuaXRlbXM7CiAgICBjb25zdCByb3dzID0gaXRlbXMubWFwKChpdCwgaSkgPT4gYAogICAgICA8dHI+CiAgICAgICAgPHRkPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgZGF0YS1pPSIke2l9IiBjbGFzcz0icC1jaGVjayIgJHtpdC5jaGVja2VkID8gJ2NoZWNrZWQnIDogJyd9IGFyaWEtbGFiZWw9Iuy2lOqwgCI+PC90ZD4KICAgICAgICA8dGQ+PGlucHV0IHR5cGU9ImRhdGUiIGRhdGEtaT0iJHtpfSIgY2xhc3M9InAtZGF0ZSIgdmFsdWU9IiR7aXQuZGF0ZX0iPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJtZW1vIj4ke2VzYyhpdC5tZW1vKX0gJHtpdC5kdXAgPyAnPHNwYW4gY2xhc3M9InRhZyB3YXJuIj7spJHrs7U/PC9zcGFuPicgOiAnJ30gJHtpdC5raW5kID09PSAnZXhwZW5zZScgPyBtZXRob2RUYWcoaXQubWV0aG9kKSA6ICcnfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJhbW91bnQgJHtpdC5raW5kID09PSAnaW5jb21lJyB8fCBpdC5hbW91bnQgPCAwID8gJ3JlZnVuZCcgOiAnJ30iPiR7aXQua2luZCA9PT0gJ2luY29tZScgPyAnKycgOiAnJ30ke3dvbihpdC5hbW91bnQpfTwvdGQ+CiAgICAgICAgPHRkPiR7aXQua2luZCA9PT0gJ2V4cGVuc2UnCiAgICAgICAgICA/IGA8c2VsZWN0IGRhdGEtaT0iJHtpfSIgY2xhc3M9InAtY2F0Ij4ke2NhdGVnb3J5T3B0aW9ucyhwbGFuRm9yRGF0ZShpdC5kYXRlKS5jYXRlZ29yaWVzLCBpdC5jYXRlZ29yeUlkKX08L3NlbGVjdD5gCiAgICAgICAgICA6IGA8c3BhbiBjbGFzcz0idGFnIj4ke0tJTkRfTEFCRUxbaXQua2luZF19PC9zcGFuPmB9PC90ZD4KICAgICAgPC90cj5gKS5qb2luKCcnKTsKICAgIGNvbnN0IGR1cHMgPSBpdGVtcy5maWx0ZXIoKHgpID0+IHguZHVwKS5sZW5ndGg7CiAgICBjb25zdCBkYXRlcyA9IGl0ZW1zLm1hcCgoeCkgPT4geC5kYXRlKS5zb3J0KCk7CiAgICBjb25zdCBzdW1tYXJ5ID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyAmJiBpdGVtcy5sZW5ndGgKICAgICAgPyBgPHAgY2xhc3M9InNtYWxsIj4ke2VzYyhwcmV2aWV3LmZpbGVOYW1lKX0gwrcgJHtmbXREYXRlKGRhdGVzWzBdKX0gfiAke2ZtdERhdGUoZGF0ZXNbZGF0ZXMubGVuZ3RoIC0gMV0pfSDCtyAke2l0ZW1zLmxlbmd0aH3qsbQke2R1cHMgPyBgICjsnbTrr7gg7J6I64qUIOuCtOyXreycvOuhnCDrs7TsnbTripQgJHtkdXBzfeqxtOydgCDrubwg65GQ7JeI7Ja07JqUKWAgOiAnJ30ke3ByZXZpZXcubGF0ZXN0ID8gYCDCtyDrp4jsp4Drp4kg7J6U7JWhICR7d29uKHByZXZpZXcubGF0ZXN0LmJhbGFuY2UpfWAgOiAnJ308L3A+YAogICAgICA6ICcnOwogICAgdGFyZ2V0LmlubmVySFRNTCA9IGAKICAgICAgJHtzdW1tYXJ5fQogICAgICAke2l0ZW1zLmxlbmd0aCA/IGAKICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJwLWFsbCI+66qo65GQIOyEoO2DnTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJwLW5vbmUiPuuqqOuRkCDtlbTsoJw8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAiPgogICAgICAgIDx0YWJsZSBjbGFzcz0ic3RhY2stdGFibGUgcGFyc2UtdGFibGUiPgogICAgICAgICAgPHRoZWFkPjx0cj48dGg+PC90aD48dGg+64Kg7KecPC90aD48dGg+7IKs7Jqp7LKYPC90aD48dGggY2xhc3M9ImFtb3VudCI+6riI7JWhPC90aD48dGg+7ZWt66qpPC90aD48L3RyPjwvdGhlYWQ+CiAgICAgICAgICA8dGJvZHk+JHtyb3dzfTwvdGJvZHk+CiAgICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdy1hY3Rpb25zIj48YnV0dG9uIGlkPSJwLWFkZCIgY2xhc3M9InByaW1hcnktYnRuIj7shKDtg53tlZwgJHtpdGVtcy5maWx0ZXIoKHgpID0+IHguY2hlY2tlZCkubGVuZ3RofeqxtCDstpTqsIA8L2J1dHRvbj48L2Rpdj5gIDogJyd9CiAgICAgICR7cHJldmlldy5za2lwcGVkLmxlbmd0aCA/IGA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuqxtOuEiOubtCDspIQgJHtwcmV2aWV3LnNraXBwZWQubGVuZ3RofeqwnDogJHtwcmV2aWV3LnNraXBwZWQubWFwKGVzYykuam9pbignIC8gJyl9PC9wPmAgOiAnJ31gOwoKICAgIGNvbnN0IHNldEFsbCA9ICh2KSA9PiB7CiAgICAgIGl0ZW1zLmZvckVhY2goKHgpID0+ICh4LmNoZWNrZWQgPSB2KSk7CiAgICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgICB9OwogICAgaWYgKCQoJyNwLWFsbCcpKSAkKCcjcC1hbGwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEFsbCh0cnVlKSk7CiAgICBpZiAoJCgnI3Atbm9uZScpKSAkKCcjcC1ub25lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRBbGwoZmFsc2UpKTsKICAgIHRhcmdldC5xdWVyeVNlbGVjdG9yQWxsKCcucC1jaGVjaycpLmZvckVhY2goKGMpID0+IGMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogICAgICBpdGVtc1tjLmRhdGFzZXQuaV0uY2hlY2tlZCA9IGMuY2hlY2tlZDsKICAgICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICAgIH0pKTsKICAgIHRhcmdldC5xdWVyeVNlbGVjdG9yQWxsKCcucC1kYXRlJykuZm9yRWFjaCgoYykgPT4gYy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiAoaXRlbXNbYy5kYXRhc2V0LmldLmRhdGUgPSBjLnZhbHVlKSkpOwogICAgdGFyZ2V0LnF1ZXJ5U2VsZWN0b3JBbGwoJy5wLWNhdCcpLmZvckVhY2goKGMpID0+IGMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogICAgICBjb25zdCBpdCA9IGl0ZW1zW2MuZGF0YXNldC5pXTsKICAgICAgaXQuY2F0ZWdvcnlJZCA9IGMudmFsdWUgfHwgbnVsbDsKICAgICAgaXQubWV0aG9kID0gYy52YWx1ZSA/ICdtYW51YWwnIDogbnVsbDsKICAgIH0pKTsKICAgIGNvbnN0IGFkZEJ0biA9ICQoJyNwLWFkZCcpOwogICAgaWYgKGFkZEJ0bikgYWRkQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoYWRkUHJldmlld0l0ZW1zKSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhZGRQcmV2aWV3SXRlbXMoKSB7CiAgICBjb25zdCBjaG9zZW4gPSBwcmV2aWV3Lml0ZW1zLmZpbHRlcigoeCkgPT4geC5jaGVja2VkICYmIHguZGF0ZSk7CiAgICBpZiAoIWNob3Nlbi5sZW5ndGgpIHJldHVybiB0b2FzdCgn7LaU6rCA7ZWgIOuCtOyXreydhCDshKDtg53tlbQg7KO87IS47JqULicpOwogICAgbGV0IGNoYW5nZWRNZXRhID0gZmFsc2U7CiAgICBmb3IgKGNvbnN0IGl0IG9mIGNob3NlbikgewogICAgICBpZiAoaXQubWV0aG9kID09PSAnbWFudWFsJyAmJiBpdC5jYXRlZ29yeUlkKSB7CiAgICAgICAgUygpLm1lcmNoYW50TWFwW0wubm9ybWFsaXplTWVyY2hhbnQoaXQubWVtbyldID0gaXQuY2F0ZWdvcnlJZDsKICAgICAgICBjaGFuZ2VkTWV0YSA9IHRydWU7CiAgICAgIH0KICAgIH0KICAgIC8vIO2MjOydvOydmCDrp4jsp4Drp4kg7J6U7JWh7J20IOyngOq4iCDslYzqs6Ag7J6I64qUIOyelOyVoeuztOuLpCDstZzqt7zsnbTrqbQg6rOE7KKMIOyelOyVoeydhCDrsJTqvrzri6QKICAgIGNvbnN0IGFjYyA9IHByZXZpZXcuYWNjb3VudElkICYmIFMoKS5hY2NvdW50cy5maW5kKChhKSA9PiBhLmlkID09PSBwcmV2aWV3LmFjY291bnRJZCk7CiAgICBpZiAoYWNjICYmIHByZXZpZXcubGF0ZXN0KSB7CiAgICAgIGNvbnN0IGF0ID0gbmV3IERhdGUoYCR7cHJldmlldy5sYXRlc3QuZGF0ZX1UJHtwcmV2aWV3LmxhdGVzdC50aW1lIHx8ICcyMzo1OTo1OSd9KzA5OjAwYCkudG9JU09TdHJpbmcoKTsKICAgICAgaWYgKCFhY2MuYmFsYW5jZUF0IHx8IGF0ID4gYWNjLmJhbGFuY2VBdCkgewogICAgICAgIGFjYy5iYWxhbmNlID0gcHJldmlldy5sYXRlc3QuYmFsYW5jZTsKICAgICAgICBhY2MuYmFsYW5jZUF0ID0gYXQ7CiAgICAgICAgY2hhbmdlZE1ldGEgPSB0cnVlOwogICAgICB9CiAgICB9CiAgICBpZiAoY2hhbmdlZE1ldGEpIHN0b3JlLnNhdmVNZXRhKCk7CiAgICBjb25zdCBzb3VyY2UgPSBwcmV2aWV3LnNvdXJjZSA9PT0gJ2ZpbGUnID8gJ2ZpbGUnIDogJ3Bhc3RlJzsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY2hvc2VuLmxlbmd0aDsgaSArPSAyMDApIHsKICAgICAgY29uc3QgcGFydCA9IGNob3Nlbi5zbGljZShpLCBpICsgMjAwKTsKICAgICAgYXdhaXQgYnVzeShg7KCA7J6l7ZWY64qUIOykkeKApiAoJHtNYXRoLm1pbihpICsgMjAwLCBjaG9zZW4ubGVuZ3RoKX0vJHtjaG9zZW4ubGVuZ3RofSlgLCAoKSA9PgogICAgICAgIHN0b3JlLmFkZFRyYW5zYWN0aW9ucyhwYXJ0Lm1hcCgoaXQpID0+ICh7CiAgICAgICAgICBkYXRlOiBpdC5kYXRlLCBhbW91bnQ6IGl0LmFtb3VudCwgbWVtbzogaXQubWVtbywga2luZDogaXQua2luZCB8fCAnZXhwZW5zZScsIGFjY291bnRJZDogaXQuYWNjb3VudElkIHx8IG51bGwsCiAgICAgICAgICBjYXRlZ29yeUlkOiBpdC5raW5kID09PSAnZXhwZW5zZScgPyBpdC5jYXRlZ29yeUlkIDogbnVsbCwgbWV0aG9kOiBpdC5tZXRob2QsIHNvdXJjZSwgcmF3OiBpdC5yYXcsCiAgICAgICAgfSkpKQogICAgICApOwogICAgfQogICAgY29uc3QgbGF0ZXN0RGF0ZSA9IGNob3Nlbi5tYXAoKHgpID0+IHguZGF0ZSkuc29ydCgpLnBvcCgpOwogICAgaWYgKHByZXZpZXcuc291cmNlID09PSAncGFzdGUnKSAkKCcjcGFzdGUtaW5wdXQnKS52YWx1ZSA9ICcnOwogICAgZWxzZSAkKCcjZmlsZS1pbnB1dCcpLnZhbHVlID0gJyc7CiAgICBjbGVhclByZXZpZXcoKTsKICAgIHRvYXN0KGAke2Nob3Nlbi5sZW5ndGh96rG07J2EIOy2lOqwgO2WiOyKteuLiOuLpC5gKTsKICAgIGp1bXBUb0RhdGUobGF0ZXN0RGF0ZSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyEpOyglSAtLS0tLS0tLS0tCgogIC8vIOyVjOumvCDsl7DqsrAg7JWxKOyViOuTnOuhnOydtOuTnCkg64K066Ck67Cb6riwIOyjvOyGjCAoR2l0SHViIEFjdGlvbnMg6rCAIG1haW4g7JeQIOyYrOudvOqwiCDrlYzrp4jri6Qg6rCx7IugKQogIGNvbnN0IE5PVElfQVBLX1VSTCA9ICdodHRwczovL2dpdGh1Yi5jb20va2RoMTIwNy1zdGFyL0NsYXVkZUNvZGUxL3JlbGVhc2VzL2Rvd25sb2FkL25vdGktYXBwL2J1ZGdldC1ub3RpLmFwayc7CgogIC8vIOyEpOy5mOuQnCDslYzrprwg7Jew6rKwIOyVseydhCDsl7TrqbTshJwg7ISc67KEIOyjvOyGjOulvCDrhJjquLTri6QgKO2BrOuhrCDslYjrk5zroZzsnbTrk5zsnZggaW50ZW50IOunge2BrCkKICBmdW5jdGlvbiBjb25uZWN0TGluaygpIHsKICAgIGNvbnN0IHVybCA9IGVuY29kZVVSSUNvbXBvbmVudChub3RpZnlVcmwoJ2JhbmsnKSk7CiAgICByZXR1cm4gYGludGVudDovL3NldHVwP3VybD0ke3VybH0jSW50ZW50O3NjaGVtZT1idWRnZXRub3RpO3BhY2thZ2U9Y29tLmtkaDEyMDcuYnVkZ2V0bm90aTtTLmJyb3dzZXJfZmFsbGJhY2tfdXJsPSR7ZW5jb2RlVVJJQ29tcG9uZW50KE5PVElfQVBLX1VSTCl9O2VuZGA7CiAgfQoKICBmdW5jdGlvbiBub3RpZnlVcmwoc291cmNlKSB7CiAgICByZXR1cm4gc3RvcmUuc2VydmljZVVybCA/IGAke3N0b3JlLnNlcnZpY2VVcmx9P2FjdGlvbj1zbXMma2V5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JlLnNlcnZlci5rZXkpfSR7c291cmNlID8gYCZzb3VyY2U9JHtzb3VyY2V9YCA6ICcnfWAgOiAnJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclNldHRpbmdzKCkgewogICAgY29uc3Qgc2QgPSAkKCcjc3RhcnQtZGF5Jyk7CiAgICBpZiAoIXNkLm9wdGlvbnMubGVuZ3RoKSBzZC5pbm5lckhUTUwgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzMSB9LCAoXywgaSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7aSArIDF9Ij7rp6Tsm5QgJHtpICsgMX3snbw8L29wdGlvbj5gKS5qb2luKCcnKTsKICAgIHNkLnZhbHVlID0gU3RyaW5nKFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAkKCcjbXktbmFtZScpLnZhbHVlID0gUygpLnNldHRpbmdzLm15TmFtZSB8fCAnJzsKICAgIHJlbmRlckFjY291bnRSb3dzKCk7CiAgICByZW5kZXJBdXRvQ2FyZCgpOwogICAgJCgnI2RhdGEtbm90ZScpLnRleHRDb250ZW50ID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScKICAgICAgPyAn642w7J207YSw64qUIOq1rOq4gCDsi5ztirjsl5Ag7KCA7J6l65Cp64uI64ukLiDrsLHsl4Ug67aI65+s7Jik6riw66W8IO2VmOuptCDrsLHsl4XsnZgg6rOE7ZqNwrfqs4Tsoozrpbwg7KCB7Jqp7ZWY6rOgIOuCtOyXreydhCDsi5ztirjsl5Ag7LaU6rCA7ZWp64uI64ukLicKICAgICAgOiAn66qo65OgIOuNsOydtO2EsOuKlCDsnbQg67iM65287Jqw7KCA7JeQ66eMIOyggOyepeuQqeuLiOuLpC4g64uk66W4IOq4sOq4sOuhnCDsmK7quLDqsbDrgpgg67Cx7JeF7ZWY66Ck66m0IOuCtOuztOuCtOq4sOulvCDsgqzsmqntlZjshLjsmpQuJzsKICAgICQoJyNyZXNldC1idG4nKS5oaWRkZW4gPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckFjY291bnRSb3dzKCkgewogICAgY29uc3QgZWwgPSAkKCcjYWNjb3VudC1yb3dzJyk7CiAgICBjb25zdCBhY2NvdW50cyA9IFMoKS5hY2NvdW50czsKICAgIGVsLmlubmVySFRNTCA9IGFjY291bnRzLmxlbmd0aAogICAgICA/IGFjY291bnRzLm1hcCgoYSkgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9ImFjY3Qtcm93IiBkYXRhLWlkPSIke2VzYyhhLmlkKX0iPgogICAgICAgICAgPGlucHV0IGNsYXNzPSJhLW5hbWUiIHR5cGU9InRleHQiIHZhbHVlPSIke2VzYyhhLm5hbWUpfSIgcGxhY2Vob2xkZXI9IiR7YS50eXBlID09PSAnY2FyZCcgPyAn7JiIOiDsi6DtlZwg7LK07YGs7Lm065OcJyA6ICfsmIg6IOq1reuvvCDso7zqsbDrnpgnfSIgYXJpYS1sYWJlbD0i7J2066aEIj4KICAgICAgICAgIDxzZWxlY3QgY2xhc3M9ImEtdHlwZSIgYXJpYS1sYWJlbD0i7KKF66WYIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYmFuayIgJHthLnR5cGUgIT09ICdjYXJkJyA/ICdzZWxlY3RlZCcgOiAnJ30+7J2A7ZaJIOqzhOyijDwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJjYXJkIiAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ3NlbGVjdGVkJyA6ICcnfT7subTrk5w8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgPGlucHV0IGNsYXNzPSJhLWxhc3QiIHR5cGU9InRleHQiIGlucHV0bW9kZT0ibnVtZXJpYyIgbWF4bGVuZ3RoPSI0IiB2YWx1ZT0iJHtlc2MoYS5sYXN0NCl9IiBwbGFjZWhvbGRlcj0i64GdIDTsnpDrpqwiIGFyaWEtbGFiZWw9IuuBnSA07J6Q66asIj4KICAgICAgICAgIDxpbnB1dCBjbGFzcz0iYS1iYWwiIHR5cGU9InRleHQiIGlucHV0bW9kZT0ibnVtZXJpYyIgdmFsdWU9IiR7dHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJykgOiAnJ30iIHBsYWNlaG9sZGVyPSIke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+KAlCcgOiAn7ZiE7J6sIOyelOyVoSd9IiAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ2Rpc2FibGVkJyA6ICcnfSBhcmlhLWxhYmVsPSLsnpTslaEiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJjaGVjayI+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYS1zYXZlIiAke2EuaXNTYXZpbmdzID8gJ2NoZWNrZWQnIDogJyd9ICR7YS50eXBlID09PSAnY2FyZCcgPyAnZGlzYWJsZWQnIDogJyd9PuyggOy2lTwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJsaW5rLWJ0biBhLWRlbCIgYXJpYS1sYWJlbD0i7IKt7KCcIj7inJU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKQogICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7JWE7KeBIOuTseuhne2VnCDqs4TsoozCt+y5tOuTnOqwgCDsl4bslrTsmpQuPC9kaXY+JzsKCiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCcuYWNjdC1yb3cnKS5mb3JFYWNoKChyb3cpID0+IHsKICAgICAgY29uc3QgYSA9IFMoKS5hY2NvdW50cy5maW5kKCh4KSA9PiB4LmlkID09PSByb3cuZGF0YXNldC5pZCk7CiAgICAgIGNvbnN0IHNhdmUgPSAocmVyZW5kZXIpID0+IHsKICAgICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgICAgIGlmIChyZXJlbmRlcikgcmVuZGVyQWNjb3VudFJvd3MoKTsKICAgICAgfTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLW5hbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEubmFtZSA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKTsKICAgICAgICBzYXZlKCk7CiAgICAgIH0pOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtdHlwZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS50eXBlID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgaWYgKGEudHlwZSA9PT0gJ2NhcmQnKSBPYmplY3QuYXNzaWduKGEsIHsgYmFsYW5jZTogbnVsbCwgaXNTYXZpbmdzOiBmYWxzZSB9KTsKICAgICAgICBzYXZlKHRydWUpOwogICAgICB9KTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLWxhc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEubGFzdDQgPSBlLnRhcmdldC52YWx1ZS5yZXBsYWNlKC9cRC9nLCAnJykuc2xpY2UoLTQpOwogICAgICAgIGUudGFyZ2V0LnZhbHVlID0gYS5sYXN0NDsKICAgICAgICBzYXZlKCk7CiAgICAgIH0pOwogICAgICBmb3JtYXRPbkJsdXIocm93LnF1ZXJ5U2VsZWN0b3IoJy5hLWJhbCcpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLWJhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5iYWxhbmNlID0gcGFyc2VBbW91bnRJbnB1dChlLnRhcmdldC52YWx1ZSk7CiAgICAgICAgYS5iYWxhbmNlQXQgPSBub3dJU08oKTsKICAgICAgICBzYXZlKCk7CiAgICAgIH0pOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtc2F2ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5pc1NhdmluZ3MgPSBlLnRhcmdldC5jaGVja2VkOwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1kZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBpZiAoIWNvbmZpcm0oYCcke2EubmFtZSB8fCBhLmxhc3Q0fScg7J2EKOulvCkg7IKt7KCc7ZWg6rmM7JqUPyDsnbTrr7gg6riw66Gd65CcIOuCtOyXreydgCDqt7jrjIDroZwg64Ko7Iq164uI64ukLmApKSByZXR1cm47CiAgICAgICAgUygpLmFjY291bnRzID0gUygpLmFjY291bnRzLmZpbHRlcigoeCkgPT4geC5pZCAhPT0gYS5pZCk7CiAgICAgICAgc2F2ZSh0cnVlKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGFkZEFjY291bnQoKSB7CiAgICBTKCkuYWNjb3VudHMucHVzaCh7IGlkOiBgYS0ke3VpZCgpfWAsIG5hbWU6ICcnLCB0eXBlOiAnYmFuaycsIGxhc3Q0OiAnJywgaXNTYXZpbmdzOiBmYWxzZSwgYmFsYW5jZTogbnVsbCwgYmFsYW5jZUF0OiAnJyB9KTsKICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICByZW5kZXJBY2NvdW50Um93cygpOwogICAgY29uc3QgbmFtZXMgPSAkJCgnLmFjY3Qtcm93IC5hLW5hbWUnKTsKICAgIG5hbWVzW25hbWVzLmxlbmd0aCAtIDFdLmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJBdXRvQ2FyZCgpIHsKICAgIGNvbnN0IGNhcmQgPSAkKCcjc2V0LWF1dG8nKTsKICAgIGlmIChzdG9yZS5tb2RlID09PSAncmVtb3RlJykgewogICAgICBjb25zdCBNT0RFTF9MQUJFTCA9IHsgJ2NsYXVkZS1vcHVzLTUtNSc6ICdDbGF1ZGUgT3B1cyA1LjUgKOq4sOuzuCwg6rCA7J6lIOygle2ZlSknLCAnY2xhdWRlLWhhaWt1LTUtNSc6ICdDbGF1ZGUgSGFpa3UgNS41ICjstpTsspwsIOyVhOyjvCDsoIDroLQpJywgJ2NsYXVkZS1oYWlrdS00LTUnOiAnQ2xhdWRlIEhhaWt1IDQuNSAo7JiI7KCEIOuqqOuNuCknIH07CiAgICAgIGNhcmQuaW5uZXJIVE1MID0gYAogICAgICAgIDxoMj7snpDrj5kg7J6F66ClPC9oMj4KICAgICAgICA8aDM+Q2xhdWRlIEFJIOu2hOulmDwvaDM+CiAgICAgICAgPHAgY2xhc3M9InNtYWxsIj4ke3N0b3JlLmFpRW5hYmxlZCA/ICc8Yj7svJzsoLgg7J6I7Ja07JqULjwvYj4g7JWM66a86rO8IOu2meyXrOuEo+ydgCDrgrTsl63snYQgQUnqsIAg7JiI7IKwIO2VreuqqeyXkCDrp57strAg67aE66WY7ZWp64uI64ukLicgOiAnPGI+6rq87KC4IOyeiOyWtOyalC48L2I+IOyngOq4iOydgCDtgqTsm4zrk5zroZwg67aE66WY7ZWp64uI64ukLiDslYTrnpjsl5AgQ2xhdWRlIEFQSSDtgqTrpbwg64Sj7Jy866m0IOy8nOyguOyalC4g7YKk64qUIGNvbnNvbGUuYW50aHJvcGljLmNvbSDsl5DshJwg6rKw7KCcIOyImOuLqOydhCDrk7HroZ3tlZwg65KkIEFQSSBLZXlzIOuplOuJtOyXkOyEnCDrp4zrk6Qg7IiYIOyeiOyWtOyalC4nfTwvcD4KICAgICAgICA8Zm9ybSBpZD0iYWktZm9ybSIgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9IndpZGUiPkNsYXVkZSBBUEkg7YKkPGlucHV0IHR5cGU9InBhc3N3b3JkIiBpZD0iYWkta2V5IiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IiR7c3RvcmUuYWlFbmFibGVkID8gJ+yggOyepeuQqCAo67CU6r6466Ck66m0IOyDiCDtgqQg7J6F66ClKScgOiAnc2stYW50LeKApid9Ij48L2xhYmVsPgogICAgICAgICAgPGRpdiBjbGFzcz0iZm9ybS1zdWJtaXQiPjxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPu2ZleyduO2VmOqzoCDsoIDsnqU8L2J1dHRvbj48L2Rpdj4KICAgICAgICA8L2Zvcm0+CiAgICAgICAgJHtzdG9yZS5haUVuYWJsZWQgPyBgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij48bGFiZWwgY2xhc3M9IndpZGUiPuyCrOyaqe2VoCDrqqjrjbg8c2VsZWN0IGlkPSJhaS1tb2RlbCI+JHsoc3RvcmUuYWlNb2RlbHMubGVuZ3RoID8gc3RvcmUuYWlNb2RlbHMgOiBbc3RvcmUuYWlNb2RlbF0pLm1hcCgobSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKG0pfSIgJHttID09PSBzdG9yZS5haU1vZGVsID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2VzYyhNT0RFTF9MQUJFTFttXSB8fCBtKX08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2xhYmVsPjwvZGl2PmAgOiAnJ30KICAgICAgICAke3N0b3JlLmFpRXJyb3IgPyBgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7stZzqt7wgQUkg7Jik66WYOiAke2VzYyhzdG9yZS5haUVycm9yKX08L3A+YCA6ICcnfQogICAgICAgIDxoMz7subTsubTsmKTrsYXtgawg66y47J6QIOyekOuPmSDsnoXroKUgKE1hY3JvRHJvaWQg66y066OMKTwvaDM+CiAgICAgICAgPG9sIGNsYXNzPSJzdGVwcyI+CiAgICAgICAgICA8bGk+7ZSM66CI7J20IOyKpO2GoOyWtOyXkOyEnCA8Yj5NYWNyb0Ryb2lkPC9iPiDshKTsuZggKFBybyA37J28IOyytO2XmCDslYjrgrTripQg64ur6riwKTwvbGk+CiAgICAgICAgICA8bGk+66ek7YGs66GcIOy2lOqwgCDihpIg7Yq466as6rGwIDxiPuyghO2ZlC9TTVMg4oaSIFNNUyDsiJjsi6A8L2I+ICjrqqjrk6Ag67KI7Zi4LCDrgrTsmqnsl5AgPGNvZGU+7J6U7JWhPC9jb2RlPiDtj6ztlagpPC9saT4KICAgICAgICAgIDxsaT7rj5nsnpEgPGI+7Ju5IOygkeyGjSDihpIgSFRUUCDsmpTssq08L2I+OiBQT1NULCDslYTrnpgg7KO87IaMLCDrs7jrrLggdGV4dC9wbGFpbiDsl5Ag66ek7KeBIO2FjeyKpO2KuCA8Y29kZT5bc21zX21lc3NhZ2VdPC9jb2RlPjwvbGk+CiAgICAgICAgICA8bGk+7KCA7J6lIO2bhCDtnLTrjIDtj7Ag7ISk7KCV7JeQ7IScIE1hY3JvRHJvaWQg67Cw7YSw66asIDxiPuygnO2VnCDsl4bsnYw8L2I+PC9saT4KICAgICAgICA8L29sPgogICAgICAgIDxkaXYgY2xhc3M9ImNvcHktcm93Ij48aW5wdXQgdHlwZT0idGV4dCIgcmVhZG9ubHkgdmFsdWU9IiR7ZXNjKG5vdGlmeVVybCgnYmFuaycpKX0iIGlkPSJ1cmwtYmFuayI+PGJ1dHRvbiBjbGFzcz0iZ2hvc3QtYnRuIiBkYXRhLWNvcHk9InVybC1iYW5rIj7rs7Xsgqw8L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuusuOyekOqwgCDsmYDrj4Qg67CY7J2R7J20IOyXhuycvOuptCDtirjrpqzqsbDrpbwgPGI+7JWM66a8IOyImOyLoDwvYj4o66mU7Iuc7KeAIOyVsSwg64K07JqpIDxjb2RlPuyelOyVoTwvY29kZT4p7Jy866GcIOuwlOq+uOqzoCDrs7jrrLjsnYQgPGNvZGU+W25vdGlmaWNhdGlvbl90aXRsZV0gW25vdGlmaWNhdGlvbl08L2NvZGU+IOuhnCDtlZjshLjsmpQuIOqzhOyijMK37Lm065Oc7JeQIOy5tOy5tOyYpOuxhe2BrCDrgZ0gNOyekOumrOulvCDrk7HroZ3tlbQg65GQ66m0IOyelOyVoeuPhCDqsLHsi6Drj7zsmpQuIOyekOyEuO2VnCDrsKnrspXsnYAgU0VUVVAubWQgNuuLqOqzhOyXkCDsnojslrTsmpQuPC9wPgogICAgICAgIDxkZXRhaWxzIGNsYXNzPSJzbWFsbCI+CiAgICAgICAgICA8c3VtbWFyeT7sp4HsoJEg66eM65OgIOyVjOumvCDsl7DqsrAg7JWxICjshKDtg50sIOuztOyViCDssKjri6jrkKAg7IiYIOyeiOydjCk8L3N1bW1hcnk+CiAgICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPu2UjOugiOydtCDsiqTthqDslrQg67CWIOyVseydtOudvCDsgrzshLEg67O07JWIIOq4sOuKpeydtCDshKTsuZjrpbwg66eJ7J2EIOyImCDsnojslrTsmpQuIOuztOyViCDshKTsoJXsnYQg64GE66m07ISc6rmM7KeAIOyTsOuKlCDqsoPsnYAg6raM7ZWY7KeAIOyViuyVhOyalC4gPGEgaHJlZj0iJHtOT1RJX0FQS19VUkx9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+QVBLIOuwm+q4sDwvYT4gwrcgPGEgaHJlZj0iJHtlc2MoY29ubmVjdExpbmsoKSl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+7ISk7LmY7ZWcIOyVseyXkCDsl7DqsrA8L2E+PC9wPgogICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ctYWN0aW9ucyI+CiAgICAgICAgICAke3N0b3JlLnNlcnZlci5lbWJlZGRlZCA/ICc8YnV0dG9uIGlkPSJmb3JnZXQta2V5LWJ0biIgY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iPuydtCDquLDquLDsl5DshJwg7KCR7IaNIO2CpCDsp4DsmrDquLA8L2J1dHRvbj4nIDogJzxidXR0b24gaWQ9ImRpc2Nvbm5lY3QtYnRuIiBjbGFzcz0iZGFuZ2VyLWJ0biI+7Jew6rKwIO2VtOygnCAo7J20IOq4sOq4sCDsoIDsnqXsnLzroZwpPC9idXR0b24+J30KICAgICAgICA8L2Rpdj5gOwogICAgICAkKCcjYWktZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIHF1aWV0KGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGtleSA9ICQoJyNhaS1rZXknKS52YWx1ZS50cmltKCk7CiAgICAgICAgaWYgKCFrZXkgJiYgIWNvbmZpcm0oJ0FQSSDtgqTrpbwg7KeA7Jqw6rOgIEFJIOu2hOulmOulvCDrgYzquYzsmpQ/JykpIHJldHVybjsKICAgICAgICBhd2FpdCBidXN5KCdBUEkg7YKk66W8IO2ZleyduO2VmOuKlCDspJHigKYnLCAoKSA9PiBzdG9yZS5zZXRBcGlLZXkoa2V5KSk7CiAgICAgICAgdG9hc3Qoc3RvcmUuYWlFbmFibGVkID8gJ0FJIOu2hOulmOulvCDsvLDslrTsmpQuJyA6ICdBSSDrtoTrpZjrpbwg6ruQ7Ja07JqULicpOwogICAgICAgIHJlbmRlcigpOwogICAgICB9KSk7CiAgICAgIGNvbnN0IG1vZGVsU2VsID0gJCgnI2FpLW1vZGVsJyk7CiAgICAgIGlmIChtb2RlbFNlbCkgbW9kZWxTZWwuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUuc2V0TW9kZWwobW9kZWxTZWwudmFsdWUpKTsKICAgICAgICB0b2FzdCgn66qo64247J2EIOuwlOq/qOyWtOyalC4nKTsKICAgICAgfSkpOwogICAgICBjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNvcHldJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBjb25zdCBpbnB1dCA9ICQoYCMke2IuZGF0YXNldC5jb3B5fWApOwogICAgICAgIGNvcHlUZXh0KGlucHV0LnZhbHVlLCBpbnB1dCk7CiAgICAgIH0pKTsKICAgICAgY29uc3QgZmsgPSAkKCcjZm9yZ2V0LWtleS1idG4nKTsKICAgICAgaWYgKGZrKSBmay5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBpZiAoIWNvbmZpcm0oJ+ydtCDquLDquLDsl5DshJwg7KCR7IaNIO2CpOulvCDsp4DsmrjquYzsmpQ/IOuLpOydjOyXkCDsl7Qg65WMIOuLpOyLnCDsnoXroKXtlbTslbwg7ZW07JqULicpKSByZXR1cm47CiAgICAgICAgc3RvcmUuZm9yZ2V0S2V5KCk7CiAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7CiAgICAgIH0pOwogICAgICBjb25zdCBkYyA9ICQoJyNkaXNjb25uZWN0LWJ0bicpOwogICAgICBpZiAoZGMpIGRjLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGlmICghY29uZmlybSgn7ISc67KEIOyXsOqysOydhCDtlbTsoJztlaDquYzsmpQ/IOq1rOq4gCDsi5ztirjsnZgg642w7J207YSw64qUIOq3uOuMgOuhnCDrgqjslYQg7J6I7Iq164uI64ukLicpKSByZXR1cm47CiAgICAgICAgc3RvcmUuZGlzY29ubmVjdCgpOwogICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpOwogICAgICB9KTsKICAgIH0gZWxzZSB7CiAgICAgIGNhcmQuaW5uZXJIVE1MID0gYAogICAgICAgIDxoMj7snpDrj5kg7J6F66ClICjqtazquIAg7Iuc7Yq4IOyEnOuyhCDsl7DqsrApPC9oMj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuy5tOuTnCDrrLjsnpDCt+ydgO2WiSDslYzrprwg7J6Q64+ZIOyeheugpeqzvCBBSSDrtoTrpZjripQg6rWs6riAIOyLnO2KuCDshJzrsoTqsIAg7J6I7Ja07JW8IOuPmeyeke2VtOyalC4g7KCA7J6l7IaM7J2YIDxiPlNFVFVQLm1kPC9iPiDrjIDroZwg6rWs6riAIEFwcHMgU2NyaXB0IOulvCDrsLDtj6ztlZwg65KkLCDsm7nslbEg7KO87IaM7JmAIOygkeyGjSDtgqTrpbwg64Sj7Jy87IS47JqULiDsm7nslbEg7KO87IaM66GcIOuwlOuhnCDsoJHsho3tlbTshJwg7I2o64+EIOuQqeuLiOuLpC48L3A+CiAgICAgICAgPGZvcm0gaWQ9ImNvbm5lY3QtZm9ybSIgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9IndpZGUiPuybueyVsSDso7zshow8aW5wdXQgdHlwZT0idXJsIiBpZD0iYy11cmwiIHBsYWNlaG9sZGVyPSJodHRwczovL3NjcmlwdC5nb29nbGUuY29tL21hY3Jvcy9zL+KApi9leGVjIiByZXF1aXJlZD48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPuygkeyGjSDtgqQ8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImMta2V5IiByZXF1aXJlZD48L2xhYmVsPgogICAgICAgICAgPGRpdiBjbGFzcz0iZm9ybS1zdWJtaXQiPjxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPuyXsOqysDwvYnV0dG9uPjwvZGl2PgogICAgICAgIDwvZm9ybT5gOwogICAgICAkKCcjY29ubmVjdC1mb3JtJykuYWRkRXZlbnRMaXN0ZW5lcignc3VibWl0JywgcXVpZXQoYXN5bmMgKGUpID0+IHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgdXJsID0gJCgnI2MtdXJsJykudmFsdWUudHJpbSgpLnJlcGxhY2UoL1w/LiokLywgJycpOwogICAgICAgIGNvbnN0IGtleSA9ICQoJyNjLWtleScpLnZhbHVlLnRyaW0oKTsKICAgICAgICBhd2FpdCBidXN5KCfsl7DqsrAg7ZmV7J24IOykkeKApicsICgpID0+IHN0b3JlLnBpbmcodXJsLCBrZXkpKTsKICAgICAgICBjb25zdCBtaWdyYXRlID0gUygpLnRyYW5zYWN0aW9ucy5sZW5ndGggPiAwICYmIGNvbmZpcm0oJ+ydtCDquLDquLDsl5Ag7J6I642YIOqzhO2ajeqzvCDrgrTsl63snYQg6rWs6riAIOyLnO2KuOuhnCDsmK7quLjquYzsmpQ/Jyk7CiAgICAgICAgc3RvcmUuY29ubmVjdCh1cmwsIGtleSwgbWlncmF0ZSk7CiAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7CiAgICAgIH0pKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGNoYW5nZVN0YXJ0RGF5KG5ld0RheSkgewogICAgTC5yZW1hcFBlcmlvZEtleXMoUygpLCBuZXdEYXkpOwogICAgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgbmV3RGF5KTsKICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICByZW5kZXJDaHJvbWUoKTsKICAgIHRvYXN0KGDsnbTsoJwg66ek7JuUICR7bmV3RGF5feydvOyXkCDsg4gg6riw6rCE7J20IOyLnOyekeuQqeuLiOuLpC5gKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g67Cx7JeFIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gZXhwb3J0RGF0YSgpIHsKICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbSlNPTi5zdHJpbmdpZnkoUygpLCBudWxsLCAyKV0sIHsgdHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nIH0pOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CiAgICBhLmRvd25sb2FkID0gYOyngOy2nOq0gOumrC3rsLHsl4UtJHtMLnRvZGF5SVNPKCl9Lmpzb25gOwogICAgYS5jbGljaygpOwogICAgc2V0VGltZW91dCgoKSA9PiBVUkwucmV2b2tlT2JqZWN0VVJMKGEuaHJlZiksIDEwMDApOwogIH0KCiAgZnVuY3Rpb24gaW1wb3J0RGF0YShmaWxlKSB7CiAgICBjb25zdCByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpOwogICAgcmVhZGVyLm9ubG9hZCA9IHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgbGV0IHBhcnNlZDsKICAgICAgdHJ5IHsKICAgICAgICBwYXJzZWQgPSBMLm5vcm1hbGl6ZVN0YXRlKEpTT04ucGFyc2UocmVhZGVyLnJlc3VsdCkpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgcmV0dXJuIHRvYXN0KCfsmKzrsJTrpbgg67Cx7JeFIO2MjOydvOydtCDslYTri5nri4jri6QuJyk7CiAgICAgIH0KICAgICAgY29uc3QgbXNnID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgPyAn67Cx7JeF7J2YIOqzhO2ajcK36rOE7KKM66W8IOyggeyaqe2VmOqzoCDrgrTsl63snYQg6rWs6riAIOyLnO2KuOyXkCDstpTqsIDtlaDquYzsmpQ/JyA6ICftmITsnqwg642w7J207YSw66W8IOuwseyXhSDtjIzsnbzsnZgg64K07Jqp7Jy866GcIOuwlOq/gOq5jOyalD8nOwogICAgICBpZiAoIWNvbmZpcm0obXNnKSkgcmV0dXJuOwogICAgICBhd2FpdCBidXN5KCfrtojrn6zsmKTripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuaW1wb3J0U3RhdGUocGFyc2VkKSk7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAgIHRvYXN0KCfrsLHsl4XsnYQg67aI65+s7JmU7Iq164uI64ukLicpOwogICAgICByZW5kZXIoKTsKICAgIH0pOwogICAgcmVhZGVyLnJlYWRBc1RleHQoZmlsZSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOugjOuNlCAmIOydtOuypO2KuCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlcigpIHsKICAgIHJlbmRlckNocm9tZSgpOwogICAgY29uc3QgcGFnZSA9IGN1cnJlbnRQYWdlOwogICAgaWYgKHBhZ2UgPT09ICdob21lJykgcmVuZGVySG9tZSgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ2NhbGVuZGFyJykgcmVuZGVyQ2FsZW5kYXIoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdsaXN0JykgcmVuZGVyTGlzdCgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ3NvcnQnKSByZW5kZXJTb3J0KCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAncmVwb3J0JykgcmVuZGVyUmVwb3J0KCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnYXNzZXRzJykgcmVuZGVyQXNzZXRzKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAncGxhbicpIHJlbmRlclBsYW4oKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdhZGQnKSByZW5kZXJBZGQoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdzZXR0aW5ncycpIHJlbmRlclNldHRpbmdzKCk7CiAgfQoKICBmdW5jdGlvbiBiaW5kRXZlbnRzKCkgewogICAgJCQoJy5uYXYtaXRlbVtkYXRhLXBhZ2VdLCAuYm90dG9tLW5hdiBbZGF0YS1wYWdlXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZShiLmRhdGFzZXQucGFnZSkpKTsKICAgICQkKCdbZGF0YS1nb3RvXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZShiLmRhdGFzZXQuZ290bykpKTsKICAgICQkKCdbZGF0YS1vcGVuLW1lbnVdJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5NZW51KSk7CiAgICAkKCcjbWVudS1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5NZW51KTsKICAgICQoJyNzY3JpbScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgY2xvc2VNZW51KTsKICAgICQoJyNhZGQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZSgnYWRkJykpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2hhc2hjaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGNvbnN0IG5hbWUgPSBsb2NhdGlvbi5oYXNoLnNsaWNlKDEpOwogICAgICBpZiAoUEFHRVNbbmFtZV0gJiYgbmFtZSAhPT0gY3VycmVudFBhZ2UpIHNob3dQYWdlKG5hbWUsIHsgcHVzaDogZmFsc2UgfSk7CiAgICB9KTsKICAgICQkKCcuc2V0dGluZ3MtbmF2IGEnKS5mb3JFYWNoKChhKSA9PiBhLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAkKGEuZ2V0QXR0cmlidXRlKCdocmVmJykpLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6ICdzbW9vdGgnLCBibG9jazogJ3N0YXJ0JyB9KTsKICAgIH0pKTsKCiAgICBjb25zdCBtb3ZlID0gKGRlbHRhKSA9PiB7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBMLnNoaWZ0UGVyaW9kKGN1cnJlbnRQZXJpb2QsIGRlbHRhLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICAkKCcjaW5jb21lLWJveCcpLmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgICByZW5kZXIoKTsKICAgIH07CiAgICAkKCcjcHJldi1wZXJpb2QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG1vdmUoLTEpKTsKICAgICQoJyNuZXh0LXBlcmlvZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gbW92ZSgxKSk7CiAgICAkKCcjdG9kYXktcGVyaW9kJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAgIHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgICAgIHJlbmRlcigpOwogICAgfSk7CiAgICAkKCcjcmVmcmVzaC1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgYXdhaXQgYnVzeSgn67aI65+s7Jik64qUIOykkeKApicsICgpID0+IHN0b3JlLnJlZnJlc2goKSk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpOwoKICAgIC8vIOyeheugpQogICAgJCQoJyNtLWtpbmQgYnV0dG9uJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgbWFudWFsS2luZCA9IGIuZGF0YXNldC5raW5kOwogICAgICByZW5kZXJBZGQoKTsKICAgIH0pKTsKICAgICQoJyNtYW51YWwtZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIHF1aWV0KG9uTWFudWFsU3VibWl0KSk7CiAgICBmb3JtYXRPbkJsdXIoJCgnI20tYW1vdW50JykpOwogICAgJCgnI20tbWVtbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgdXBkYXRlTWFudWFsSGludCk7CiAgICAkKCcjbS1jYXRlZ29yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHVwZGF0ZU1hbnVhbEhpbnQpOwogICAgJCgnI20tZGF0ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHJlbmRlckFkZCk7CiAgICAkKCcjcGFyc2UtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldChvblBhcnNlKSk7CiAgICAkKCcjcGFzdGUtY2xlYXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgJCgnI3Bhc3RlLWlucHV0JykudmFsdWUgPSAnJzsKICAgICAgY2xlYXJQcmV2aWV3KCk7CiAgICB9KTsKICAgICQoJyNmaWxlLWlucHV0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKGUpID0+IHsKICAgICAgaWYgKGUudGFyZ2V0LmZpbGVzWzBdKSBhd2FpdCBvbkZpbGVDaG9zZW4oZS50YXJnZXQuZmlsZXNbMF0pOwogICAgfSkpOwoKICAgIC8vIOuCtOyXrQogICAgY29uc3Qgc2V0RmlsdGVyID0gKGtleSwgdmFsdWUpID0+IHsKICAgICAgbGlzdFN0YXRlW2tleV0gPSB2YWx1ZTsKICAgICAgcmVuZGVyTGlzdCgpOwogICAgfTsKICAgICQoJyNsaXN0LXNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGUpID0+IHNldEZpbHRlcignc2VhcmNoJywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWtpbmQnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gc2V0RmlsdGVyKCdraW5kJywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWZpbHRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBzZXRGaWx0ZXIoJ2NhdGVnb3J5JywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWFjY291bnQnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gc2V0RmlsdGVyKCdhY2NvdW50JywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNyZWNsYXNzaWZ5LXVuY2xhc3NpZmllZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoKCkgPT4gcnVuUmVjbGFzc2lmeSh0cnVlKSkpOwogICAgJCgnI3JlY2xhc3NpZnktYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBydW5SZWNsYXNzaWZ5KGZhbHNlKSkpOwoKICAgIC8vIOyYiOyCsCDqs4Ttmo0KICAgICQoJyNyYXRpby1iYXNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgYnVkZ2V0UGxhbigpLnJhdGlvQmFzZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgICByZW5kZXJQbGFuVmVyc2lvbigpOwogICAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogICAgfSk7CiAgICAkKCcjZml4ZWQtb3ZlcmZsb3cnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBidWRnZXRQbGFuKCkuZml4ZWRPdmVyZmxvdyA9IGUudGFyZ2V0LnZhbHVlID09PSAnc2NhbGUnID8gJ3NjYWxlJyA6ICd3YXJuJzsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgICAgcmVuZGVyUGxhblN1bW1hcnkoKTsKICAgIH0pOwogICAgJCgnI2FkZC1jYXRlZ29yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQ2F0ZWdvcnkpOwoKICAgIC8vIOyEpOyglQogICAgJCgnI3N0YXJ0LWRheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBjaGFuZ2VTdGFydERheShOdW1iZXIoZS50YXJnZXQudmFsdWUpKSk7CiAgICAkKCcjbXktbmFtZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgIFMoKS5zZXR0aW5ncy5teU5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICB9KTsKICAgICQoJyNhZGQtYWNjb3VudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQWNjb3VudCk7CiAgICAkKCcjZXhwb3J0LWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXhwb3J0RGF0YSk7CiAgICAkKCcjaW1wb3J0LWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBpZiAoZS50YXJnZXQuZmlsZXNbMF0pIGltcG9ydERhdGEoZS50YXJnZXQuZmlsZXNbMF0pOwogICAgICBlLnRhcmdldC52YWx1ZSA9ICcnOwogICAgfSk7CiAgICAkKCcjcmVzZXQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgn66qo65OgIOuCtOyXrSwg7IiY7J6FLCDqs4Ttmo0sIOqzhOyijOulvCDsp4DsmrDqs6Ag7LKY7J2MIOyDge2DnOuhnCDrkJjrj4zrprTquYzsmpQ/ICjrkJjrj4zrprQg7IiYIOyXhuyKteuLiOuLpCknKSkgcmV0dXJuOwogICAgICBzdG9yZS5yZXNldCgpOwogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICB0b2FzdCgn7LSI6riw7ZmU7ZaI7Iq164uI64ukLicpOwogICAgICByZW5kZXIoKTsKICAgIH0pOwoKICAgIC8vIOyVseydhCDrlqDrgqAg65WMIOyVhOyngSDrs7TrgrTsp4Ag7JWK7J2AIOuzgOqyveydhCDsoIDsnqXtlZjqs6AsIOuPjOyVhOyYpOuptCDsg4jroZwg65Ok7Ja07JioIOyVjOumvCDrgrTsl63snYQg67aI65+s7Jio64ukCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSAnaGlkZGVuJykgcmV0dXJuIHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIWJ1c3lDb3VudCAmJiAhc3RvcmUuaGFzUGVuZGluZ01ldGEoKSkgewogICAgICAgIGF3YWl0IHN0b3JlLnJlZnJlc2goKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfQogICAgfSkpOwogIH0KCiAgLy8g6rWs6riAIOybuSDslbHsnLzroZwg7LKY7J2MIOyXtOyXiOydhCDrlYw6IOygkeyGjSDtgqTrpbwg7ZWcIOuyiCDsnoXroKXrsJvslYQg7J20IOq4sOq4sOyXkCDquLDslrXtlZzri6QKICBmdW5jdGlvbiBhc2tLZXkoKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICAgIGJveC5jbGFzc05hbWUgPSAna2V5LWdhdGUnOwogICAgICBib3guaW5uZXJIVE1MID0gYAogICAgICAgIDxmb3JtIGNsYXNzPSJjYXJkIGtleS1jYXJkIiBpZD0ia2V5LWZvcm0iPgogICAgICAgICAgPGgyPuygkeyGjSDtgqTrpbwg7J6F66Cl7ZWY7IS47JqUPC9oMj4KICAgICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+6rWs6riAIEFwcHMgU2NyaXB0IO2OuOynkeq4sOyXkOyEnCA8Yj5zZXR1cDwvYj4g7J2EIOyLpO2Wie2VmOuptCDsi6Ttlokg6riw66Gd7JeQIOuCmOyYpOuKlCDtgqTsmIjsmpQuICjslYgg67O07J2066m0IOKamSDtlITroZzsoJ3tirgg7ISk7KCVIOKGkiDsiqTtgazrpr3tirgg7IaN7ISx7J2YIDxiPkFQUF9LRVk8L2I+KSDtlZwg67KIIOyeheugpe2VmOuptCDsnbQg6riw6riw6rCAIOq4sOyWte2VtOyalC48L3A+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icGFzc3dvcmQiIGlkPSJrZXktaW5wdXQiIGF1dG9jb21wbGV0ZT0iY3VycmVudC1wYXNzd29yZCIgcGxhY2Vob2xkZXI9IuygkeyGjSDtgqQiIHJlcXVpcmVkPgogICAgICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPjxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPuuTpOyWtOqwgOq4sDwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPHAgY2xhc3M9InNtYWxsIHdhcm4iIGlkPSJrZXktZXJyb3IiIGhpZGRlbj48L3A+CiAgICAgICAgPC9mb3JtPmA7CiAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYm94KTsKICAgICAgJCgnI2tleS1pbnB1dCcpLmZvY3VzKCk7CiAgICAgICQoJyNrZXktZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGVyciA9ICQoJyNrZXktZXJyb3InKTsKICAgICAgICBlcnIuaGlkZGVuID0gdHJ1ZTsKICAgICAgICB0cnkgewogICAgICAgICAgYXdhaXQgc3RvcmUudXNlS2V5KCQoJyNrZXktaW5wdXQnKS52YWx1ZS50cmltKCkpOwogICAgICAgICAgYm94LnJlbW92ZSgpOwogICAgICAgICAgcmVzb2x2ZSgpOwogICAgICAgIH0gY2F0Y2ggKGV4KSB7CiAgICAgICAgICBlcnIudGV4dENvbnRlbnQgPSAvdW5hdXRob3JpemVkLy50ZXN0KGV4Lm1lc3NhZ2UpID8gJ+2CpOqwgCDrp57sp4Ag7JWK7JWE7JqULiDri6Tsi5wg7ZmV7J247ZW0IOyjvOyEuOyalC4nIDogYO2ZleyduO2VmOyngCDrqrvtlojslrTsmpQ6ICR7ZXgubWVzc2FnZX1gOwogICAgICAgICAgZXJyLmhpZGRlbiA9IGZhbHNlOwogICAgICAgIH0KICAgICAgfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgd2luZG93Ll9fYnVkZ2V0U3RhcnRlZCA9IHRydWU7CiAgICBiaW5kRXZlbnRzKCk7CiAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIXN0b3JlLnNlcnZlci5rZXkpIGF3YWl0IGFza0tleSgpOwogICAgY29uc3QgdG9NaWdyYXRlID0gc3RvcmUudGFrZU1pZ3JhdGlvbigpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYnVzeShzdG9yZS5tb2RlID09PSAncmVtb3RlJyA/ICfrtojrn6zsmKTripQg7KSR4oCmJyA6IG51bGwsICgpID0+IHN0b3JlLmluaXQoKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgICQoJyNjYXRlZ29yeS1yb3dzJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImVtcHR5Ij7shJzrsoTsl5Ag7Jew6rKw7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4gKCR7ZXNjKGUubWVzc2FnZSB8fCBlKX0pPGJyPuyEpOyglSDihpIg7J6Q64+ZIOyeheugpeyXkOyEnCDso7zshozsmYAg7YKk66W8IO2ZleyduO2VmOyEuOyalC48L2Rpdj5gOwogICAgfQogICAgaWYgKHRvTWlncmF0ZSkgewogICAgICBhd2FpdCBidXN5KCfsnbQg6riw6riwIOuNsOydtO2EsOulvCDsmK7quLDripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuaW1wb3J0U3RhdGUodG9NaWdyYXRlKSkuY2F0Y2goKCkgPT4ge30pOwogICAgICB0b2FzdCgn7J20IOq4sOq4sCDrjbDsnbTthLDrpbwg6rWs6riAIOyLnO2KuOuhnCDsmK7qsrzsirXri4jri6QuJyk7CiAgICB9CiAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgc2hvd1BhZ2UobG9jYXRpb24uaGFzaC5zbGljZSgxKSB8fCAnaG9tZScsIHsgcHVzaDogZmFsc2UgfSk7CiAgfQoKICBzdGFydCgpOwp9KSgpOwo=\");</script>\n</body>\n</html>\n";
