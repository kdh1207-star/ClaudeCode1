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
   */
  function computeBudgets(categories, income, ratioBase) {
    const inc = Math.max(0, Number(income) || 0);
    const fixedTotal = categories
      .filter((c) => c.type === 'fixed')
      .reduce((s, c) => s + (Number(c.value) || 0), 0);
    const ratioPercentTotal = categories
      .filter((c) => c.type === 'ratio')
      .reduce((s, c) => s + (Number(c.value) || 0), 0);
    const base = ratioBase === 'afterFixed' ? Math.max(0, inc - fixedTotal) : inc;

    const budgets = {};
    for (const c of categories) {
      budgets[c.id] = c.type === 'fixed'
        ? Math.round(Number(c.value) || 0)
        : Math.round((base * (Number(c.value) || 0)) / 100);
    }
    const allocated = Object.values(budgets).reduce((s, v) => s + v, 0);
    return { budgets, fixedTotal, ratioPercentTotal, ratioBaseAmount: base, allocated, unallocated: inc - allocated };
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
    const calc = computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase);
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
      plans: [{ from: BASE_PLAN_FROM, ratioBase: 'afterFixed', categories: defaultCategories(), updatedAt: '' }],
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
var MODELS = ['claude-opus-5-5', 'claude-haiku-4-5'];
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
  // 분류는 간단한 작업이라 생각을 짧게 (effort 를 지원하지 않는 Haiku 4.5 는 제외)
  if (!/haiku/.test(model)) body.output_config.effort = 'low';
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

var INDEX_HTML = "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <title>내 지출 관리</title>\n  <style>\n:root {\n  color-scheme: light;\n  --page: #f4f4f1;\n  --surface: #fcfcfb;\n  --surface-2: #f0efec;\n  --surface-3: #e7e6e1;\n  --text: #0b0b0b;\n  --text-2: #52514e;\n  --muted: #6f6d68;\n  --border: rgba(11, 11, 11, 0.09);\n  --accent: #2a78d6;\n  --accent-track: #cde2fb;\n  --accent-soft: #e6f0fc;\n  --accent-text: #1c5cab;\n  --good: #0ca30c;\n  --good-text: #006300;\n  --warning: #fab219;\n  --warning-track: #fde8b8;\n  --critical: #d03b3b;\n  --critical-track: #f6d0d0;\n  --critical-text: #b42f2f;\n  --gray-mark: #b8b6ae;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7;\n  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04);\n  --sidebar-w: 232px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n    color-scheme: dark;\n    --page: #0d0d0d;\n    --surface: #1a1a19;\n    --surface-2: #232321;\n    --surface-3: #2e2e2b;\n    --text: #ffffff;\n    --text-2: #c3c2b7;\n    --muted: #9a988f;\n    --border: rgba(255, 255, 255, 0.09);\n    --accent: #3987e5;\n    --accent-track: #1c3558;\n    --accent-soft: #16263b;\n    --accent-text: #86b6ef;\n    --good-text: #0ca30c;\n    --warning-track: #4a3a12;\n    --critical-track: #4a1f1f;\n    --critical-text: #ec7070;\n    --gray-mark: #5c5b56;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n    --shadow: none;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --page: #0d0d0d;\n  --surface: #1a1a19;\n  --surface-2: #232321;\n  --surface-3: #2e2e2b;\n  --text: #ffffff;\n  --text-2: #c3c2b7;\n  --muted: #9a988f;\n  --border: rgba(255, 255, 255, 0.09);\n  --accent: #3987e5;\n  --accent-track: #1c3558;\n  --accent-soft: #16263b;\n  --accent-text: #86b6ef;\n  --good-text: #0ca30c;\n  --warning-track: #4a3a12;\n  --critical-track: #4a1f1f;\n  --critical-text: #ec7070;\n  --gray-mark: #5c5b56;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n  --shadow: none;\n}\n\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nbody {\n  margin: 0;\n  background: var(--page);\n  color: var(--text);\n  font-family: system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif;\n  font-size: 15px;\n  line-height: 1.5;\n}\n\nh1 { font-size: 20px; margin: 0; }\nh2 { font-size: 16px; margin: 0 0 8px; }\nh3 { font-size: 14px; margin: 16px 0 4px; }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.num { font-variant-numeric: tabular-nums; }\nsvg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n\n/* ---------- 레이아웃 ---------- */\n.app { min-height: 100vh; }\n.sidebar {\n  position: fixed;\n  inset: 0 auto 0 0;\n  width: var(--sidebar-w);\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  display: flex;\n  flex-direction: column;\n  padding: 20px 12px;\n  z-index: 30;\n}\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 0 8px 20px; }\n.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 16px; }\n.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }\n.nav-item {\n  display: flex; align-items: center; gap: 12px;\n  border: 0; background: none; color: var(--text-2);\n  font: inherit; text-align: left; padding: 10px 12px; border-radius: 10px; cursor: pointer;\n}\n.nav-item:hover { background: var(--surface-2); }\n.nav-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }\n.nav-sep { height: 1px; background: var(--border); margin: 8px 12px; }\n.sidebar-foot { padding: 12px 8px 0; }\n\n.main { margin-left: var(--sidebar-w); min-width: 0; }\n.topbar {\n  position: sticky; top: 0; z-index: 20;\n  display: flex; align-items: center; gap: 12px;\n  padding: 14px 28px;\n  background: color-mix(in srgb, var(--page) 88%, transparent);\n  backdrop-filter: blur(8px);\n}\n.topbar h1 { flex: 1; }\n.topbar-actions { display: flex; gap: 8px; align-items: center; }\n.topbar .menu-btn { display: none; }\n.content { max-width: 1040px; padding: 4px 28px 40px; }\n.page { display: none; }\n.page.active { display: block; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }\n.grid-2 > .card { margin-bottom: 16px; }\n\n.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 25; }\n.bottom-nav { display: none; }\n\n@media (max-width: 900px) {\n  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }\n  .sidebar.open { transform: none; }\n  .main { margin-left: 0; }\n  .topbar .menu-btn { display: inline-flex; }\n  .topbar { padding: 10px 16px; }\n  .content { padding: 4px 16px 96px; }\n  .grid-2 { grid-template-columns: 1fr; gap: 0; }\n  .topbar .add-btn { display: none; }\n  .bottom-nav {\n    display: grid; grid-template-columns: repeat(5, 1fr);\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n    background: var(--surface); border-top: 1px solid var(--border);\n    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));\n  }\n  .bottom-nav button {\n    display: flex; flex-direction: column; align-items: center; gap: 2px;\n    border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;\n  }\n  .bottom-nav button.active { color: var(--accent-text); font-weight: 600; }\n  .bottom-nav .bn-add svg { width: 26px; height: 26px; color: #fff; background: var(--accent); border-radius: 50%; padding: 4px; stroke-width: 2.4; }\n}\n\n/* ---------- 공통 요소 ---------- */\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 18px 20px;\n  margin-bottom: 16px;\n  box-shadow: var(--shadow);\n}\n.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }\n.card-head h2 { margin: 0; }\n.note-card { background: var(--surface-2); box-shadow: none; }\n.note-card p { margin: 4px 0 8px; }\n.warn-card { background: var(--warning-track); border-color: transparent; }\n\nbutton, input, select, textarea { font: inherit; color: inherit; }\ninput, select, textarea {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  padding: 9px 11px;\n  min-width: 0;\n}\ninput:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }\ntextarea { width: 100%; resize: vertical; }\nselect.full { width: 100%; }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn {\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  border: 1px solid var(--border); background: var(--surface); white-space: nowrap;\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n.ghost-btn:hover, .icon-btn:hover { background: var(--surface-2); }\n.danger-btn { color: var(--critical-text); }\n.icon-btn { padding: 7px; }\n.small-btn { padding: 6px 11px; font-size: 13px; }\n.link { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }\n.link-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }\n.link-btn:hover { color: var(--critical-text); }\n.file-btn { display: inline-flex; }\n.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }\n.chip { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; display: inline-block; }\n.chip.on { background: var(--accent-soft); color: var(--accent-text); }\n.tag { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }\n.tag.warn { background: var(--warning-track); color: var(--text); }\n.empty { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }\n\n.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }\n.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }\n.form-grid .wide { grid-column: span 2; }\n.form-submit { display: flex; align-items: end; }\n@media (max-width: 520px) { .form-grid .wide { grid-column: 1 / -1; } }\n\n.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; margin: 4px 0 14px; }\n.segmented button { border: 0; background: none; padding: 7px 14px; border-radius: 8px; cursor: pointer; color: var(--text-2); }\n.segmented button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }\n\n.busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -50% 0; } to { background-position: 150% 0; } }\n\n/* ---------- 기간 선택 ---------- */\n.period-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }\n.period-label { display: flex; flex-direction: column; min-width: 0; }\n.period-label strong { font-size: 16px; }\n.period-nav .icon-btn { width: 34px; height: 34px; font-size: 20px; line-height: 1; padding: 0; }\n.period-nav #today-period { margin-left: auto; }\n\n/* ---------- 홈 ---------- */\n.income-prompt { border-color: var(--accent); background: var(--accent-soft); }\n.income-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }\n.income-form input { flex: 1; min-width: 140px; }\n.income-set { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }\n.income-set .value { font-size: 18px; font-weight: 600; }\n\n.hero-card .label { color: var(--text-2); font-size: 14px; }\n.hero-card .figure { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin: 2px 0 4px; }\n.hero-card .figure.negative { color: var(--critical-text); }\n.hero-card .sub { color: var(--text-2); font-size: 14px; }\n.hero-card .meter { margin-top: 14px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 36px; } }\n\n.kv { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--border); gap: 12px; }\n.kv:first-child { border-top: 0; }\n.kv .k { color: var(--text-2); font-size: 14px; }\n.kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }\n.kv .v.plus { color: var(--accent-text); }\n\n/* 항목 행 (미터) */\n.cat-row { padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }\n.cat-row:first-child { border-top: 0; }\n.cat-row:hover .cat-name { text-decoration: underline; }\n.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.cat-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }\n.badge { font-size: 12px; font-weight: 400; color: var(--text-2); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }\n.cat-amounts { font-size: 14px; color: var(--text-2); }\n.cat-amounts b { color: var(--text); }\n.meter { position: relative; height: 10px; border-radius: 4px; background: var(--accent-track); margin: 8px 0 6px; overflow: hidden; }\n.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }\n.meter.warning { background: var(--warning-track); }\n.meter.warning .meter-fill { background: var(--warning); }\n.meter.critical { background: var(--critical-track); }\n.meter.critical .meter-fill { background: var(--critical); }\n.cat-bottom { display: flex; justify-content: space-between; font-size: 13px; gap: 8px; }\n.status { color: var(--text-2); }\n.status.warning { color: var(--text); }\n.status.critical { color: var(--critical-text); font-weight: 600; }\n.remain-good { color: var(--good-text); }\n.remain-bad { color: var(--critical-text); font-weight: 600; }\n.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }\n\n/* 거래 목록 (날짜별 묶음) */\n.tx-date { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 14px 0 4px; border-bottom: 1px solid var(--border); }\n.tx { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n.tx:last-child { border-bottom: 0; }\n.tx-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; }\n.tx-icon.gray { background: var(--gray-mark); }\n.tx-main { min-width: 0; }\n.tx-memo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tx-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }\n.tx-meta select { font-size: 12px; padding: 3px 6px; border-radius: 8px; max-width: 160px; }\n.tx-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n.tx-amount { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.tx-amount.plus { color: var(--accent-text); }\n.tx-amount.neutral { color: var(--muted); font-weight: 600; }\n.list-total { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin: 12px 0 4px; }\n.list-total b { color: var(--text); }\n.filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 8px; }\n@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }\n\n/* ---------- 달력 ---------- */\n.cal-summary { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin-bottom: 12px; }\n.cal-summary b { color: var(--text); font-size: 16px; }\n.cal-summary .plus b { color: var(--accent-text); }\n.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }\n.cal-dow { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }\n.cal-dow.sun { color: var(--critical-text); }\n.cal-day {\n  min-height: 74px; border-radius: 10px; padding: 6px; border: 1px solid transparent;\n  display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--surface-2); text-align: left;\n  font: inherit; color: inherit; min-width: 0;\n}\n.cal-day.out { background: none; cursor: default; opacity: 0.35; }\n.cal-day.today .cal-num { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 6px; }\n.cal-day.selected { border-color: var(--accent); }\n.cal-num { font-size: 12px; font-weight: 600; align-self: flex-start; }\n.cal-spent, .cal-income { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n.cal-spent { color: var(--text); }\n.cal-income { color: var(--accent-text); }\n.cal-day.h1 { background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }\n.cal-day.h2 { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }\n.cal-day.h3 { background: color-mix(in srgb, var(--accent) 36%, var(--surface-2)); }\n@media (max-width: 520px) { .cal-day { min-height: 56px; padding: 4px; } .cal-spent, .cal-income { font-size: 10px; } }\n\n/* ---------- 리포트 ---------- */\n.headline-figure { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0; }\n.delta { font-size: 14px; color: var(--text-2); }\n.delta b { color: var(--text); }\n.share-bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 14px; }\n.share-bar span { display: block; height: 100%; min-width: 2px; }\n.share-bar span:first-child { border-radius: 4px 0 0 4px; }\n.share-bar span:last-child { border-radius: 0 4px 4px 0; }\n.share-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.share-row:first-of-type { border-top: 0; }\n.share-name { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.share-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.share-amount { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.share-diff { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }\n.rank { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rank:first-of-type { border-top: 0; }\n.rank .n { color: var(--muted); font-weight: 700; text-align: center; }\n.rank .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rank .a { font-weight: 600; font-variant-numeric: tabular-nums; }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.chart svg { width: 100%; height: auto; display: block; overflow: visible; stroke: none; }\n.chart .grid-line { stroke: var(--border); stroke-width: 1; }\n.chart .axis-label { fill: var(--muted); font-size: 11px; }\n.chart .hit { fill: transparent; cursor: pointer; }\n.chart .hit:hover { fill: color-mix(in srgb, var(--text) 5%, transparent); }\n\n/* ---------- 자산 ---------- */\n.acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--border); }\n.acct:first-child { border-top: 0; }\n.acct-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }\n.acct-icon.is-card { background: var(--surface-2); color: var(--text-2); }\n.acct-name { font-weight: 600; }\n.acct-sub { font-size: 12px; color: var(--muted); }\n.acct-bal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }\n.acct-bal .acct-sub { font-weight: 400; }\n\n/* ---------- 예산 계획 ---------- */\n.plan-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 1.5fr 1.5fr auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.plan-row.head { border-top: 0; font-size: 13px; color: var(--text-2); padding-top: 0; }\n.plan-row input, .plan-row select { width: 100%; }\n.value-wrap { position: relative; }\n.value-wrap input { padding-right: 28px; text-align: right; }\n.value-wrap .unit { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13px; pointer-events: none; }\n.plan-row .preview { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-top: -4px; }\n@media (max-width: 1100px) {\n  .plan-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type value value\" \"desc desc desc\" \"kw kw kw\" \"pv pv pv\"; }\n  .plan-row.head { display: none; }\n  .plan-row .pl-name { grid-area: name; }\n  .plan-row .pl-type { grid-area: type; }\n  .plan-row .value-wrap { grid-area: value; }\n  .plan-row .pl-desc { grid-area: desc; }\n  .plan-row .pl-kw { grid-area: kw; }\n  .plan-row .pl-del { grid-area: del; }\n  .plan-row .preview { grid-area: pv; margin-top: 0; }\n}\n.plan-summary { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--surface-2); font-size: 14px; }\n.warn { color: var(--critical-text); font-weight: 600; }\n\n/* ---------- 설정 ---------- */\n.settings-grid { display: grid; grid-template-columns: 160px 1fr; gap: 20px; align-items: start; }\n.settings-nav { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 2px; }\n.settings-nav a { color: var(--text-2); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 14px; }\n.settings-nav a:hover { background: var(--surface-2); }\n.card[id^=\"set-\"] { scroll-margin-top: 72px; }\n@media (max-width: 900px) {\n  .settings-grid { grid-template-columns: 1fr; gap: 0; }\n  .settings-nav { position: static; flex-direction: row; overflow-x: auto; margin-bottom: 12px; gap: 6px; }\n  .settings-nav a { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }\n}\n.acct-row { display: grid; grid-template-columns: 1.4fr 0.9fr 0.8fr 1fr auto auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.acct-row input, .acct-row select { width: 100%; }\n.acct-row .check { display: flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }\n.acct-row .check input { width: auto; }\n@media (max-width: 700px) {\n  .acct-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type last last\" \"bal bal save\"; }\n  .acct-row .a-name { grid-area: name; }\n  .acct-row .a-type { grid-area: type; }\n  .acct-row .a-last { grid-area: last; }\n  .acct-row .a-bal { grid-area: bal; }\n  .acct-row .check { grid-area: save; }\n  .acct-row .link-btn { grid-area: del; }\n}\n.copy-row { display: flex; gap: 8px; margin: 6px 0 12px; }\n.copy-row input { flex: 1; font-size: 13px; }\n.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }\n.steps li { margin: 3px 0; }\n\n/* 표 (붙여넣기 미리보기) */\n.table-wrap { overflow-x: auto; margin-top: 12px; }\ntable { width: 100%; border-collapse: collapse; font-size: 14px; }\nth, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }\nth { font-weight: 600; color: var(--text-2); font-size: 13px; }\ntd.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntd select, td input { width: 100%; padding: 6px 8px; }\ntd.memo { min-width: 120px; word-break: break-all; }\n.refund { color: var(--good-text); }\n@media (max-width: 560px) {\n  .stack-table thead { display: none; }\n  .stack-table tbody tr { display: grid; gap: 6px 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n  .stack-table td { border: 0; padding: 0; min-width: 0; }\n  .parse-table tbody tr { grid-template-columns: auto 1fr 1fr auto; grid-template-areas: \"chk memo memo amt\" \". date cat cat\"; }\n  .parse-table td:nth-child(1) { grid-area: chk; }\n  .parse-table td:nth-child(2) { grid-area: date; }\n  .parse-table td:nth-child(3) { grid-area: memo; }\n  .parse-table td:nth-child(4) { grid-area: amt; }\n  .parse-table td:nth-child(5) { grid-area: cat; }\n}\n\n/* 툴팁 & 토스트 */\n.tooltip {\n  position: fixed; z-index: 50; pointer-events: none;\n  background: var(--surface); color: var(--text);\n  border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);\n  border-radius: 10px; padding: 8px 10px; font-size: 13px; max-width: 240px;\n}\n.tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }\n.tooltip .t-row span:first-child { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }\n.toast {\n  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);\n  background: var(--text); color: var(--page);\n  padding: 10px 16px; border-radius: 10px; z-index: 60; font-size: 14px; max-width: calc(100% - 32px);\n}\n@media (max-width: 900px) { .toast { bottom: calc(80px + env(safe-area-inset-bottom)); } }\n\n/* 처음 접속할 때 키 입력 */\n.key-gate { position: fixed; inset: 0; z-index: 70; background: var(--page); display: grid; place-items: center; padding: 16px; }\n.key-card { width: 100%; max-width: 420px; }\n.key-card input { width: 100%; margin-top: 8px; }\n\n.steps a.primary-btn { color: #fff; text-decoration: none; margin: 4px 0; }\n.steps a { color: var(--accent-text); }\ndetails summary { cursor: pointer; color: var(--text-2); margin-top: 8px; }\n</style>\n</head>\n<body>\n  <noscript>\n    <div style=\"padding:16px;margin:12px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif\">\n      이 화면에서는 앱의 기능(자바스크립트)이 실행되지 않아요. 파일 앱의 <b>미리보기</b>가 아니라 <b>크롬·삼성 인터넷·사파리</b> 같은 브라우저로 열어 주세요.\n    </div>\n  </noscript>\n  <div id=\"boot-error\" hidden style=\"position:fixed;left:12px;right:12px;top:12px;z-index:100;padding:16px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)\"></div>\n  <script>\n    // 앱이 시작되지 못하면 이유를 화면에 보여준다. (오래된 브라우저에서도 돌아가도록 옛 문법으로 작성)\n    (function () {\n      var shown = false;\n      function show(msg) {\n        if (shown) return;\n        shown = true;\n        var el = document.getElementById('boot-error');\n        el.innerHTML = '<b>앱을 시작하지 못했어요.</b><br>브라우저가 오래됐거나 미리보기 화면일 수 있어요. 최신 크롬·삼성 인터넷·사파리로 열어 보고, 그래도 안 되면 이 화면을 캡처해서 알려 주세요.' +\n          '<div style=\"margin-top:8px;font-size:12px;color:#52514e;word-break:break-all\">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent.replace(/</g, '&lt;') + '</div>';\n        el.hidden = false;\n        el.style.display = 'block';\n      }\n      window.addEventListener('error', function (e) {\n        if (window.__budgetStarted) return;\n        var where = window.__budgetCurrent || e.filename || '';\n        show((e.message || '알 수 없는 오류') + (where ? ' @ ' + where + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : ''));\n      });\n      // 구글 웹 앱용 빌드에서는 기능 코드를 base64 로 감싸 보낸다. 전달 과정에서 코드 글자가 바뀌어도 깨지지 않게 하려는 것.\n      window.__budgetRun = function (name, b64) {\n        window.__budgetCurrent = name;\n        try {\n          var bin = atob(b64);\n          var bytes = new Uint8Array(bin.length);\n          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n          var el = document.createElement('script');\n          el.text = new TextDecoder('utf-8').decode(bytes);\n          document.body.appendChild(el);\n        } catch (err) {\n          show(name + ': ' + (err && err.message));\n        }\n        window.__budgetCurrent = '';\n      };\n      window.addEventListener('load', function () {\n        setTimeout(function () {\n          if (!window.__budgetStarted) show('기능 코드가 실행되지 않았습니다.');\n        }, 3000);\n      });\n    })();\n  </script>\n  <div id=\"busy\" class=\"busy\" hidden></div>\n\n  <div class=\"app\">\n    <!-- 메뉴 -->\n    <aside class=\"sidebar\" id=\"sidebar\" aria-label=\"메뉴\">\n      <div class=\"brand\">\n        <span class=\"brand-mark\" aria-hidden=\"true\">₩</span>\n        <span>내 지출 관리</span>\n      </div>\n      <nav class=\"nav\" id=\"nav\">\n        <button class=\"nav-item\" data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n        <button class=\"nav-item\" data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n        <button class=\"nav-item\" data-page=\"list\"><svg viewBox=\"0 0 24 24\"><path d=\"M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01\"/></svg>내역</button>\n        <button class=\"nav-item\" data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n        <button class=\"nav-item\" data-page=\"assets\"><svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M16 14.5h2\"/></svg>자산</button>\n        <button class=\"nav-item\" data-page=\"plan\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/></svg>예산 계획</button>\n        <div class=\"nav-sep\"></div>\n        <button class=\"nav-item\" data-page=\"add\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>지출·수입 입력</button>\n        <button class=\"nav-item\" data-page=\"settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3\"/></svg>설정</button>\n      </nav>\n      <div class=\"sidebar-foot\">\n        <span id=\"conn-status\" class=\"chip\"></span>\n      </div>\n    </aside>\n    <div class=\"scrim\" id=\"scrim\" hidden></div>\n\n    <div class=\"main\">\n      <header class=\"topbar\">\n        <button id=\"menu-btn\" class=\"icon-btn menu-btn\" aria-label=\"메뉴 열기\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg></button>\n        <h1 id=\"page-title\">홈</h1>\n        <div class=\"topbar-actions\">\n          <button id=\"refresh-btn\" class=\"icon-btn\" aria-label=\"새로고침\" hidden><svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5\"/></svg></button>\n          <button id=\"add-btn\" class=\"primary-btn add-btn\">+ 입력</button>\n        </div>\n      </header>\n\n      <div class=\"content\">\n        <div class=\"period-nav\" id=\"period-nav\">\n          <button id=\"prev-period\" class=\"icon-btn\" aria-label=\"이전 기간\">‹</button>\n          <div class=\"period-label\">\n            <strong id=\"period-text\"></strong>\n            <span id=\"period-sub\" class=\"muted small\"></span>\n          </div>\n          <button id=\"next-period\" class=\"icon-btn\" aria-label=\"다음 기간\">›</button>\n          <button id=\"today-period\" class=\"ghost-btn small-btn\">오늘</button>\n        </div>\n\n        <!-- 홈 -->\n        <section class=\"page\" data-page=\"home\">\n          <div id=\"income-box\" class=\"card\"></div>\n          <div id=\"stale-box\"></div>\n          <div class=\"grid-2\">\n            <div class=\"card hero-card\" id=\"hero\"></div>\n            <div class=\"card\" id=\"home-summary\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 예산</h2>\n              <span id=\"alloc-note\" class=\"muted small\"></span>\n            </div>\n            <div id=\"category-rows\"></div>\n          </div>\n          <div class=\"grid-2\">\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>최근 내역</h2><button class=\"link\" data-goto=\"list\">전체 보기</button></div>\n              <div id=\"recent-list\"></div>\n            </div>\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>자산</h2><button class=\"link\" data-goto=\"assets\">자세히</button></div>\n              <div id=\"home-assets\"></div>\n            </div>\n          </div>\n        </section>\n\n        <!-- 달력 -->\n        <section class=\"page\" data-page=\"calendar\">\n          <div class=\"card\">\n            <div id=\"cal-summary\" class=\"cal-summary\"></div>\n            <div id=\"calendar\" class=\"calendar\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"day-title\"></h2><span id=\"day-total\" class=\"muted small\"></span></div>\n            <div id=\"day-list\"></div>\n          </div>\n        </section>\n\n        <!-- 내역 -->\n        <section class=\"page\" data-page=\"list\">\n          <div class=\"card\">\n            <div class=\"filters\">\n              <input type=\"search\" id=\"list-search\" placeholder=\"사용처 검색\" aria-label=\"사용처 검색\">\n              <select id=\"list-kind\" aria-label=\"종류\">\n                <option value=\"all\">모든 종류</option>\n                <option value=\"expense\">지출</option>\n                <option value=\"income\">입금</option>\n                <option value=\"transfer\">내 계좌 이체</option>\n              </select>\n              <select id=\"list-filter\" aria-label=\"항목\"></select>\n              <select id=\"list-account\" aria-label=\"결제수단\"></select>\n            </div>\n            <div class=\"row-actions\">\n              <button id=\"reclassify-unclassified\" class=\"ghost-btn small-btn\">미분류만 다시 분류</button>\n              <button id=\"reclassify-all\" class=\"ghost-btn small-btn\">이 기간 전체 다시 분류</button>\n            </div>\n            <div id=\"list-total\" class=\"list-total\"></div>\n            <div id=\"tx-list\"></div>\n            <p class=\"muted small\">항목을 직접 바꾸면 그 사용처를 기억해서 다음부터 같은 항목으로 분류합니다.</p>\n          </div>\n        </section>\n\n        <!-- 리포트 -->\n        <section class=\"page\" data-page=\"report\">\n          <div class=\"grid-2\">\n            <div class=\"card\" id=\"report-headline\"></div>\n            <div class=\"card\" id=\"report-merchants\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>어디에 썼나요</h2><span class=\"muted small\">이번 기간 지출 구성</span></div>\n            <div id=\"report-share\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>기간별 추이</h2><span class=\"muted small\">최근 6개 기간</span></div>\n            <div id=\"report-trend\"></div>\n          </div>\n        </section>\n\n        <!-- 자산 -->\n        <section class=\"page\" data-page=\"assets\">\n          <div class=\"card hero-card\" id=\"asset-hero\"></div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>계좌</h2><button class=\"link\" data-goto=\"settings\">계좌 관리</button></div>\n            <div id=\"asset-banks\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>카드</h2><span class=\"muted small\">이번 기간 사용액</span></div>\n            <div id=\"asset-cards\"></div>\n          </div>\n        </section>\n\n        <!-- 예산 계획 -->\n        <section class=\"page\" data-page=\"plan\">\n          <div id=\"plan-version\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>비율 항목의 기준 금액</h2>\n            <select id=\"ratio-base\" class=\"full\">\n              <option value=\"afterFixed\">수입에서 고정 항목을 뺀 나머지</option>\n              <option value=\"income\">전체 수입</option>\n            </select>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 배분</h2>\n              <button id=\"add-category\" class=\"ghost-btn small-btn\">+ 항목 추가</button>\n            </div>\n            <p class=\"muted small\"><b>수입 비례(%)</b>: 그 기간에 들어온 돈에 비례해 한도가 정해집니다. <b>고정 금액</b>: 수입과 상관없이 매 기간 같은 한도입니다.<br><b>설명</b>은 AI가 지출을 분류할 때 참고합니다. 예: \"외식, 배달, 장보기\". <b>키워드</b>는 쉼표로 구분하며, AI를 쓸 수 없을 때 사용처에 키워드가 들어 있으면 그 항목으로 분류합니다.</p>\n            <div id=\"plan-rows\"></div>\n            <div id=\"plan-summary\" class=\"plan-summary\"></div>\n          </div>\n        </section>\n\n        <!-- 입력 -->\n        <section class=\"page\" data-page=\"add\">\n          <div id=\"auto-hint\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>직접 입력</h2>\n            <div class=\"segmented\" id=\"m-kind\" role=\"radiogroup\" aria-label=\"종류\">\n              <button type=\"button\" data-kind=\"expense\" class=\"active\">지출</button>\n              <button type=\"button\" data-kind=\"income\">입금</button>\n              <button type=\"button\" data-kind=\"transfer\">내 계좌 이체</button>\n            </div>\n            <form id=\"manual-form\" class=\"form-grid\">\n              <label>날짜<input type=\"date\" id=\"m-date\" required></label>\n              <label>금액(원)<input type=\"text\" inputmode=\"numeric\" id=\"m-amount\" placeholder=\"12,000\" required></label>\n              <label class=\"wide\">사용처 / 메모<input type=\"text\" id=\"m-memo\" placeholder=\"스타벅스 강남점\"></label>\n              <label id=\"m-category-wrap\">항목<select id=\"m-category\"></select></label>\n              <label>결제수단<select id=\"m-account\"></select></label>\n              <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">추가</button></div>\n            </form>\n            <p id=\"m-hint\" class=\"muted small\"></p>\n          </div>\n          <div class=\"card\">\n            <h2>내역 붙여넣기</h2>\n            <p class=\"muted small\">카드 승인 문자, 은행/카드 앱 내역, 엑셀에서 복사한 표를 그대로 붙여넣으세요. 한 줄에 한 건씩 날짜·금액·사용처를 읽고 <span id=\"classifier-name\">항목</span>을 자동으로 정합니다.</p>\n            <textarea id=\"paste-input\" rows=\"6\" placeholder=\"예)&#10;2026-09-27 배달의민족 23,500원&#10;9월 25일 카카오T 택시 8,400원&#10;09/24 올리브영 강남점 32,000원\"></textarea>\n            <div class=\"row-actions\">\n              <button id=\"parse-btn\" class=\"primary-btn\">인식하기</button>\n              <button id=\"paste-clear\" class=\"ghost-btn\">지우기</button>\n            </div>\n            <div id=\"parse-result\"></div>\n          </div>\n          <div class=\"card\">\n            <h2>은행 거래내역 파일 가져오기</h2>\n            <p class=\"muted small\">카카오뱅크: 앱에서 계좌 선택 → 오른쪽 위 설정(톱니바퀴) → <b>거래내역</b> → 이메일과 기간을 넣고 받기. 메일로 온 엑셀(.xlsx)이나 CSV 파일을 그대로 올리세요. 다른 은행 파일도 날짜·금액 칸이 있으면 읽습니다. 알림으로 이미 들어온 내역은 <b>중복?</b>으로 표시하고 빼 둡니다.</p>\n            <div class=\"form-grid\">\n              <label>어느 계좌의 내역인가요<select id=\"file-account\"></select></label>\n              <label>파일<input type=\"file\" id=\"file-input\" accept=\".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"></label>\n            </div>\n            <div id=\"file-result\"></div>\n          </div>\n        </section>\n\n        <!-- 설정 -->\n        <section class=\"page\" data-page=\"settings\">\n          <div class=\"settings-grid\">\n            <nav class=\"settings-nav\" aria-label=\"설정 메뉴\">\n              <a href=\"#set-basic\">기본</a>\n              <a href=\"#set-accounts\">계좌·카드</a>\n              <a href=\"#set-auto\">자동 입력</a>\n              <a href=\"#set-data\">데이터</a>\n            </nav>\n            <div>\n              <div class=\"card\" id=\"set-basic\">\n                <h2>기본</h2>\n                <div class=\"form-grid\">\n                  <label>매 기간 시작일\n                    <select id=\"start-day\"></select>\n                  </label>\n                  <label>내 이름\n                    <input type=\"text\" id=\"my-name\" placeholder=\"홍길동\" autocomplete=\"name\">\n                  </label>\n                </div>\n                <p class=\"muted small\">기간: 예를 들어 25일로 하면 9/25 ~ 10/24 가 한 기간입니다. 없는 날짜(31일 등)는 그 달의 말일로 계산합니다.<br>내 이름: 이체 알림의 상대방이 내 이름이면 내 계좌끼리 옮긴 돈으로 보고 지출에서 뺍니다.</p>\n              </div>\n\n              <div class=\"card\" id=\"set-accounts\">\n                <div class=\"card-head\"><h2>계좌·카드</h2><button id=\"add-account\" class=\"ghost-btn small-btn\">+ 추가</button></div>\n                <p class=\"muted small\">번호는 <b>끝 4자리</b>만 넣으세요. 알림에 적힌 번호로 어느 계좌·카드의 거래인지 찾고, 은행 알림의 잔액으로 계좌 잔액을 자동으로 갱신합니다. <b>저축 계좌</b>로 옮긴 돈은 저축 항목 지출로 기록합니다.</p>\n                <div id=\"account-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-auto\"></div>\n\n              <div class=\"card\" id=\"set-data\">\n                <h2>데이터</h2>\n                <p id=\"data-note\" class=\"muted small\"></p>\n                <div class=\"row-actions\">\n                  <button id=\"export-btn\" class=\"ghost-btn\">백업 내보내기(JSON)</button>\n                  <label class=\"ghost-btn file-btn\">백업 불러오기<input type=\"file\" id=\"import-file\" accept=\"application/json,.json\" hidden></label>\n                  <button id=\"reset-btn\" class=\"danger-btn\">전체 초기화</button>\n                </div>\n              </div>\n            </div>\n          </div>\n        </section>\n      </div>\n    </div>\n\n    <!-- 휴대폰 하단 메뉴 -->\n    <nav class=\"bottom-nav\" aria-label=\"빠른 메뉴\">\n      <button data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n      <button data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n      <button data-page=\"add\" class=\"bn-add\" aria-label=\"입력\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n      <button data-open-menu><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg>전체</button>\n    </nav>\n  </div>\n\n  <div id=\"tooltip\" class=\"tooltip\" role=\"tooltip\" hidden></div>\n  <div id=\"toast\" class=\"toast\" hidden></div>\n\n  <script>/*__SERVER_CONFIG__*/</script>\n  <script>__budgetRun(\"js/logic.js\", \"LyoKICog7KeA7LacIOq0gOumrCDslbHsnZgg7Iic7IiYIOuhnOyngSAoRE9NIOyXhuydjCkuCiAqIOu4jOudvOyasOyggOyXkOyEnOuKlCB3aW5kb3cuQnVkZ2V0TG9naWMg7Jy866GcLCBOb2RlKO2FjOyKpO2KuCnsl5DshJzripQgcmVxdWlyZSDroZwg7IKs7Jqp7ZWc64ukLgogKiDrgqDsp5zripQg66qo65GQICdZWVlZLU1NLUREJyDrrLjsnpDsl7TroZwg64uk66Os64ukICjsi5zqsITrjIAg66y47KCcIO2ajO2UvCkuCiAqLwooZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHsKICBjb25zdCBhcGkgPSBmYWN0b3J5KCk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICBlbHNlIHJvb3QuQnVkZ2V0TG9naWMgPSBhcGk7Cn0pKHR5cGVvZiBnbG9iYWxUaGlzICE9PSAndW5kZWZpbmVkJyA/IGdsb2JhbFRoaXMgOiB0aGlzLCBmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICAvLyAtLS0tLS0tLS0tIOuCoOynnCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHBhZChuKSB7CiAgICByZXR1cm4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgfQoKICBmdW5jdGlvbiB0b0lTTyh5LCBtLCBkKSB7CiAgICByZXR1cm4gYCR7eX0tJHtwYWQobSl9LSR7cGFkKGQpfWA7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUlTTyhzKSB7CiAgICBjb25zdCBbeSwgbSwgZF0gPSBzLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyB5LCBtLCBkIH07CiAgfQoKICBmdW5jdGlvbiBkYXlzSW5Nb250aCh5LCBtKSB7CiAgICByZXR1cm4gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSwgMCkpLmdldFVUQ0RhdGUoKTsKICB9CgogIGZ1bmN0aW9uIGFkZE1vbnRocyh5LCBtLCBkZWx0YSkgewogICAgY29uc3QgaWR4ID0geSAqIDEyICsgKG0gLSAxKSArIGRlbHRhOwogICAgcmV0dXJuIHsgeTogTWF0aC5mbG9vcihpZHggLyAxMiksIG06IChpZHggJSAxMikgKyAxIH07CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGlzbywgZGVsdGEpIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gcGFyc2VJU08oaXNvKTsKICAgIGNvbnN0IGR0ID0gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSAtIDEsIGQgKyBkZWx0YSkpOwogICAgcmV0dXJuIHRvSVNPKGR0LmdldFVUQ0Z1bGxZZWFyKCksIGR0LmdldFVUQ01vbnRoKCkgKyAxLCBkdC5nZXRVVENEYXRlKCkpOwogIH0KCiAgZnVuY3Rpb24gZGlmZkRheXMoYSwgYikgewogICAgY29uc3QgcGEgPSBwYXJzZUlTTyhhKTsKICAgIGNvbnN0IHBiID0gcGFyc2VJU08oYik7CiAgICByZXR1cm4gTWF0aC5yb3VuZCgoRGF0ZS5VVEMocGIueSwgcGIubSAtIDEsIHBiLmQpIC0gRGF0ZS5VVEMocGEueSwgcGEubSAtIDEsIHBhLmQpKSAvIDg2NDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHRvZGF5SVNPKG5vdyA9IG5ldyBEYXRlKCkpIHsKICAgIHJldHVybiB0b0lTTyhub3cuZ2V0RnVsbFllYXIoKSwgbm93LmdldE1vbnRoKCkgKyAxLCBub3cuZ2V0RGF0ZSgpKTsKICB9CgogIC8vIOyLnOyekeydvOydtCDtlbTri7kg7JuU7JeQIOyXhuycvOuptCjsmIg6IDMx7J28KSDqt7gg64us7J2YIOunkOydvOuhnCDrp57stpjri6QuCiAgZnVuY3Rpb24gcGVyaW9kU3RhcnRJbk1vbnRoKHksIG0sIHN0YXJ0RGF5KSB7CiAgICByZXR1cm4gdG9JU08oeSwgbSwgTWF0aC5taW4oc3RhcnREYXksIGRheXNJbk1vbnRoKHksIG0pKSk7CiAgfQoKICBmdW5jdGlvbiBnZXRQZXJpb2QoZGF0ZUlTTywgc3RhcnREYXkpIHsKICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oZGF0ZUlTTyk7CiAgICBsZXQgc3RhcnQgPSBwZXJpb2RTdGFydEluTW9udGgoeSwgbSwgc3RhcnREYXkpOwogICAgbGV0IHN5ID0geTsKICAgIGxldCBzbSA9IG07CiAgICBpZiAoZGF0ZUlTTyA8IHN0YXJ0KSB7CiAgICAgICh7IHk6IHN5LCBtOiBzbSB9ID0gYWRkTW9udGhzKHksIG0sIC0xKSk7CiAgICAgIHN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKHN5LCBzbSwgc3RhcnREYXkpOwogICAgfQogICAgY29uc3QgbmV4dCA9IGFkZE1vbnRocyhzeSwgc20sIDEpOwogICAgY29uc3QgbmV4dFN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKG5leHQueSwgbmV4dC5tLCBzdGFydERheSk7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKG5leHRTdGFydCwgLTEpLCBrZXk6IHN0YXJ0IH07CiAgfQoKICBmdW5jdGlvbiBzaGlmdFBlcmlvZChwZXJpb2QsIGRlbHRhLCBzdGFydERheSkgewogICAgY29uc3QgeyB5LCBtIH0gPSBwYXJzZUlTTyhwZXJpb2Quc3RhcnQpOwogICAgY29uc3QgdCA9IGFkZE1vbnRocyh5LCBtLCBkZWx0YSk7CiAgICByZXR1cm4gZ2V0UGVyaW9kKHBlcmlvZFN0YXJ0SW5Nb250aCh0LnksIHQubSwgc3RhcnREYXkpLCBzdGFydERheSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4TsgrAgLS0tLS0tLS0tLQoKICAvKgogICAqIGNhdGVnb3JpZXM6IFt7IGlkLCBuYW1lLCB0eXBlOiAncmF0aW8nIHwgJ2ZpeGVkJywgdmFsdWUgfV0KICAgKiAgIHJhdGlvIOKGkiB2YWx1ZSDripQg7Y287IS87Yq4LCBmaXhlZCDihpIgdmFsdWUg64qUIOybkCDri6jsnIQg6riI7JWhCiAgICogcmF0aW9CYXNlOiAnaW5jb21lJyAgICAg4oaSIOu5hOycqCDtla3rqqnsnYAg7KCE7LK0IOyImOyehSDquLDspIAKICAgKiAgICAgICAgICAgICdhZnRlckZpeGVkJyDihpIg67mE7JyoIO2VreuqqeydgCAo7IiY7J6FIC0g6rOg7KCVIO2VreuqqSDtlanqs4QpIOq4sOykgAogICAqLwogIGZ1bmN0aW9uIGNvbXB1dGVCdWRnZXRzKGNhdGVnb3JpZXMsIGluY29tZSwgcmF0aW9CYXNlKSB7CiAgICBjb25zdCBpbmMgPSBNYXRoLm1heCgwLCBOdW1iZXIoaW5jb21lKSB8fCAwKTsKICAgIGNvbnN0IGZpeGVkVG90YWwgPSBjYXRlZ29yaWVzCiAgICAgIC5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gJ2ZpeGVkJykKICAgICAgLnJlZHVjZSgocywgYykgPT4gcyArIChOdW1iZXIoYy52YWx1ZSkgfHwgMCksIDApOwogICAgY29uc3QgcmF0aW9QZXJjZW50VG90YWwgPSBjYXRlZ29yaWVzCiAgICAgIC5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gJ3JhdGlvJykKICAgICAgLnJlZHVjZSgocywgYykgPT4gcyArIChOdW1iZXIoYy52YWx1ZSkgfHwgMCksIDApOwogICAgY29uc3QgYmFzZSA9IHJhdGlvQmFzZSA9PT0gJ2FmdGVyRml4ZWQnID8gTWF0aC5tYXgoMCwgaW5jIC0gZml4ZWRUb3RhbCkgOiBpbmM7CgogICAgY29uc3QgYnVkZ2V0cyA9IHt9OwogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIHsKICAgICAgYnVkZ2V0c1tjLmlkXSA9IGMudHlwZSA9PT0gJ2ZpeGVkJwogICAgICAgID8gTWF0aC5yb3VuZChOdW1iZXIoYy52YWx1ZSkgfHwgMCkKICAgICAgICA6IE1hdGgucm91bmQoKGJhc2UgKiAoTnVtYmVyKGMudmFsdWUpIHx8IDApKSAvIDEwMCk7CiAgICB9CiAgICBjb25zdCBhbGxvY2F0ZWQgPSBPYmplY3QudmFsdWVzKGJ1ZGdldHMpLnJlZHVjZSgocywgdikgPT4gcyArIHYsIDApOwogICAgcmV0dXJuIHsgYnVkZ2V0cywgZml4ZWRUb3RhbCwgcmF0aW9QZXJjZW50VG90YWwsIHJhdGlvQmFzZUFtb3VudDogYmFzZSwgYWxsb2NhdGVkLCB1bmFsbG9jYXRlZDogaW5jIC0gYWxsb2NhdGVkIH07CiAgfQoKICAvLyDqsbDrnpgg7KKF66WYOiBleHBlbnNlKOyngOy2nCwg6riw67O4KSAvIGluY29tZSjsnoXquIgpIC8gdHJhbnNmZXIo64K0IOqzhOyijOuBvOumrCDsnbTssrQg4oCUIOyngOy2nMK37IiY7J6F7JeQ7IScIOygnOyZuCkKICBmdW5jdGlvbiBraW5kT2YodCkgewogICAgcmV0dXJuIHQua2luZCA9PT0gJ2luY29tZScgfHwgdC5raW5kID09PSAndHJhbnNmZXInID8gdC5raW5kIDogJ2V4cGVuc2UnOwogIH0KCiAgZnVuY3Rpb24gdHhzSW5QZXJpb2Qoc3RhdGUsIHBlcmlvZCkgewogICAgcmV0dXJuIHN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHQuZGF0ZSA+PSBwZXJpb2Quc3RhcnQgJiYgdC5kYXRlIDw9IHBlcmlvZC5lbmQpOwogIH0KCiAgZnVuY3Rpb24gc3VtbWFyaXplUGVyaW9kKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IHBsYW4gPSBwbGFuRm9yKHN0YXRlLCBwZXJpb2Qua2V5KTsKICAgIGNvbnN0IGluY29tZSA9IHN0YXRlLmluY29tZXNbcGVyaW9kLmtleV07CiAgICBjb25zdCBoYXNJbmNvbWUgPSB0eXBlb2YgaW5jb21lID09PSAnbnVtYmVyJzsKICAgIGNvbnN0IGNhbGMgPSBjb21wdXRlQnVkZ2V0cyhwbGFuLmNhdGVnb3JpZXMsIGhhc0luY29tZSA/IGluY29tZSA6IDAsIHBsYW4ucmF0aW9CYXNlKTsKICAgIGNvbnN0IGFsbCA9IHR4c0luUGVyaW9kKHN0YXRlLCBwZXJpb2QpOwogICAgY29uc3QgdHhzID0gYWxsLmZpbHRlcigodCkgPT4ga2luZE9mKHQpID09PSAnZXhwZW5zZScpOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKCiAgICBjb25zdCBzcGVudCA9IHt9OwogICAgY29uc3QgY291bnRzID0ge307CiAgICBmb3IgKGNvbnN0IGMgb2YgcGxhbi5jYXRlZ29yaWVzKSB7CiAgICAgIHNwZW50W2MuaWRdID0gMDsKICAgICAgY291bnRzW2MuaWRdID0gMDsKICAgIH0KICAgIGxldCB1bmNsYXNzaWZpZWQgPSAwOwogICAgbGV0IHVuY2xhc3NpZmllZENvdW50ID0gMDsKICAgIGZvciAoY29uc3QgdCBvZiB0eHMpIHsKICAgICAgaWYgKHQuY2F0ZWdvcnlJZCAmJiBrbm93bi5oYXModC5jYXRlZ29yeUlkKSkgewogICAgICAgIHNwZW50W3QuY2F0ZWdvcnlJZF0gKz0gdC5hbW91bnQ7CiAgICAgICAgY291bnRzW3QuY2F0ZWdvcnlJZF0gKz0gMTsKICAgICAgfSBlbHNlIHsKICAgICAgICB1bmNsYXNzaWZpZWQgKz0gdC5hbW91bnQ7CiAgICAgICAgdW5jbGFzc2lmaWVkQ291bnQgKz0gMTsKICAgICAgfQogICAgfQogICAgY29uc3QgdG90YWxTcGVudCA9IHR4cy5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CiAgICBjb25zdCBpbmNvbWVSZWNlaXZlZCA9IGFsbC5maWx0ZXIoKHQpID0+IGtpbmRPZih0KSA9PT0gJ2luY29tZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKCiAgICBjb25zdCByb3dzID0gcGxhbi5jYXRlZ29yaWVzLm1hcCgoYykgPT4gewogICAgICBjb25zdCBidWRnZXQgPSBjYWxjLmJ1ZGdldHNbYy5pZF07CiAgICAgIGNvbnN0IHVzZWQgPSBzcGVudFtjLmlkXTsKICAgICAgcmV0dXJuIHsKICAgICAgICBjYXRlZ29yeTogYywKICAgICAgICBidWRnZXQsCiAgICAgICAgc3BlbnQ6IHVzZWQsCiAgICAgICAgY291bnQ6IGNvdW50c1tjLmlkXSwKICAgICAgICByZW1haW5pbmc6IGJ1ZGdldCAtIHVzZWQsCiAgICAgICAgcmF0aW86IGJ1ZGdldCA+IDAgPyB1c2VkIC8gYnVkZ2V0IDogdXNlZCA+IDAgPyBJbmZpbml0eSA6IDAsCiAgICAgIH07CiAgICB9KTsKCiAgICAvLyDqs4Ttmo3snbQg67CU64CQIOuSpOyXkCDslYTsp4Eg64uk7IucIOu2hOulmOuQmOyngCDslYrsnYAgKOyngeygkSDqs6DrpbTsp4Ag7JWK7J2AKSDsp4DstpwKICAgIGNvbnN0IHN0YWxlQ291bnQgPSB0eHMuZmlsdGVyKAogICAgICAodCkgPT4gdC5tZXRob2QgIT09ICdtYW51YWwnICYmICghdC5jbGFzc2lmaWVkQXQgfHwgKHBsYW4udXBkYXRlZEF0ICYmIHQuY2xhc3NpZmllZEF0IDwgcGxhbi51cGRhdGVkQXQpKQogICAgKS5sZW5ndGg7CgogICAgcmV0dXJuIHsKICAgICAgcGVyaW9kLAogICAgICBwbGFuLAogICAgICBzdGFsZUNvdW50LAogICAgICBpbmNvbWU6IGhhc0luY29tZSA/IGluY29tZSA6IG51bGwsCiAgICAgIGhhc0luY29tZSwKICAgICAgLi4uY2FsYywKICAgICAgcm93cywKICAgICAgdW5jbGFzc2lmaWVkLAogICAgICB1bmNsYXNzaWZpZWRDb3VudCwKICAgICAgdG90YWxTcGVudCwKICAgICAgaW5jb21lUmVjZWl2ZWQsCiAgICAgIHJlbWFpbmluZzogKGhhc0luY29tZSA/IGluY29tZSA6IDApIC0gdG90YWxTcGVudCwKICAgICAgdHJhbnNhY3Rpb25zOiB0eHMsCiAgICAgIGFsbFRyYW5zYWN0aW9uczogYWxsLAogICAgfTsKICB9CgogIGZ1bmN0aW9uIHN0YXR1c09mKHJhdGlvKSB7CiAgICBpZiAocmF0aW8gPiAxKSByZXR1cm4gJ2NyaXRpY2FsJzsKICAgIGlmIChyYXRpbyA+PSAwLjgpIHJldHVybiAnd2FybmluZyc7CiAgICByZXR1cm4gJ2dvb2QnOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsnpDrj5kg67aE66WYIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gbm9ybWFsaXplTWVyY2hhbnQocykgewogICAgcmV0dXJuIFN0cmluZyhzIHx8ICcnKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1xzKy9nLCAnJyk7CiAgfQoKICAvLyAxKSDsp4HsoJEg67aE66WY7ZW0IOuRlCDqsIDrp7nsoJAo7ZWZ7Iq1KSDihpIgMikg6rCA7J6lIOq4tCDtgqTsm4zrk5zqsIAg7J287LmY7ZWY64qUIO2VreuqqQogIGZ1bmN0aW9uIGNsYXNzaWZ5KG1lbW8sIGNhdGVnb3JpZXMsIG1lcmNoYW50TWFwID0ge30pIHsKICAgIGNvbnN0IG5vcm0gPSBub3JtYWxpemVNZXJjaGFudChtZW1vKTsKICAgIGlmICghbm9ybSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGNvbnN0IGxlYXJuZWQgPSBtZXJjaGFudE1hcFtub3JtXTsKICAgIGlmIChsZWFybmVkICYmIGtub3duLmhhcyhsZWFybmVkKSkgcmV0dXJuIGxlYXJuZWQ7CgogICAgbGV0IGJlc3QgPSBudWxsOwogICAgbGV0IGJlc3RMZW4gPSAwOwogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIHsKICAgICAgZm9yIChjb25zdCBrdyBvZiBjLmtleXdvcmRzIHx8IFtdKSB7CiAgICAgICAgY29uc3QgayA9IG5vcm1hbGl6ZU1lcmNoYW50KGt3KTsKICAgICAgICBpZiAoayAmJiBrLmxlbmd0aCA+IGJlc3RMZW4gJiYgbm9ybS5pbmNsdWRlcyhrKSkgewogICAgICAgICAgYmVzdCA9IGMuaWQ7CiAgICAgICAgICBiZXN0TGVuID0gay5sZW5ndGg7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gYmVzdDsKICB9CgogIC8vIEFJIOyXhuydtCDrtoTrpZg6IHsgY2F0ZWdvcnlJZCwgbWV0aG9kOiAnbGVhcm5lZCcgfCAna2V5d29yZCcgfCBudWxsIH0KICBmdW5jdGlvbiBjbGFzc2lmeUxvY2FsKG1lbW8sIGNhdGVnb3JpZXMsIG1lcmNoYW50TWFwID0ge30pIHsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCkpOwogICAgY29uc3QgbGVhcm5lZCA9IG1lcmNoYW50TWFwW25vcm1hbGl6ZU1lcmNoYW50KG1lbW8pXTsKICAgIGlmIChsZWFybmVkICYmIGtub3duLmhhcyhsZWFybmVkKSkgcmV0dXJuIHsgY2F0ZWdvcnlJZDogbGVhcm5lZCwgbWV0aG9kOiAnbGVhcm5lZCcgfTsKICAgIGNvbnN0IGlkID0gY2xhc3NpZnkobWVtbywgY2F0ZWdvcmllcywge30pOwogICAgcmV0dXJuIGlkID8geyBjYXRlZ29yeUlkOiBpZCwgbWV0aG9kOiAna2V5d29yZCcgfSA6IHsgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsIH07CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyngOy2nCDrgrTsl60g7YWN7Iqk7Yq4IOyduOyLnSAtLS0tLS0tLS0tCgogIGNvbnN0IE5PSVNFX1BBVFRFUk5TID0gWwogICAgL1xbP3dlYlxzKuuwnOyLoFxdPy9naSwKICAgIC9cW1teXF1dKlxdL2csCiAgICAvKOuIhOyggXzsnpTslaF87J6U6rOgfO2VnOuPhClccyo6P1xzKi0/W1xkLF0rXHMq7JuQPy9nLAogICAgL1woP1xzKijsnbzsi5zrtoh87ZWg67aAXHMqXGQqXHMq6rCcP+yblD98XGQrXHMq6rCc7JuUKVxzKlwpPy9nLAogICAgL1woXHMqW1xkKl17Myw0fVxzKlwpL2csIC8vIOy5tOuTnCDrgZ3snpDrpqwgKDEyMzQpCiAgICAvXCpcZHszLDR9L2csCiAgICAvXFNcKlxTL2csIC8vIOuniOyKpO2CueuQnCDsnbTrpoQg7ZmNKuuPmQogICAgL1xkezEsMn06XGR7Mn0oOlxkezJ9KT8vZywgLy8g7Iuc6rCBCiAgICAvKOyytO2BrHzsi6DsmqkpP1xzKuyKueyduCjst6jshowpPy9nLAogICAgL+qysOygnCjsmYTro4wpP3zsgqzsmqko7JmE66OMKT987Lac6riIL2csCiAgICAvKF58XHMpXFN7MSw2fey5tOuTnCg/PVxzfCQpL2csIC8vIOyLoO2VnOy5tOuTnCwgS0Lqta3rr7zsubTrk5wgLi4uCiAgXTsKCiAgZnVuY3Rpb24gaW5mZXJZZWFyKG1vbnRoLCBkYXksIHJlZklTTykgewogICAgY29uc3QgcmVmID0gcGFyc2VJU08ocmVmSVNPKTsKICAgIGxldCB5ZWFyID0gcmVmLnk7CiAgICAvLyDquLDspIDsnbzrs7Tri6Qg7ZWc7LC4IOuvuOuemOudvOuptCDsnpHrhYQg64K07Jet7Jy866GcIOuzuOuLpCAo7JiIOiAx7JuU7JeQIDEy7JuUIOuCtOyXrSDrtpnsl6zrhKPquLApCiAgICBpZiAoZGlmZkRheXMocmVmSVNPLCB0b0lTTyh5ZWFyLCBtb250aCwgTWF0aC5taW4oZGF5LCBkYXlzSW5Nb250aCh5ZWFyLCBtb250aCkpKSkgPiA3KSB5ZWFyIC09IDE7CiAgICByZXR1cm4geWVhcjsKICB9CgogIGZ1bmN0aW9uIHZhbGlkRGF0ZSh5LCBtLCBkKSB7CiAgICByZXR1cm4gbSA+PSAxICYmIG0gPD0gMTIgJiYgZCA+PSAxICYmIGQgPD0gZGF5c0luTW9udGgoeSwgbSk7CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0RGF0ZShsaW5lLCByZWZJU08pIHsKICAgIGxldCBtID0gbGluZS5tYXRjaCgvKDIwXGR7Mn0pXHMqWy5cLS/rhYRdXHMqKFxkezEsMn0pXHMqWy5cLS/sm5RdXHMqKFxkezEsMn0pXHMq7J28Py8pOwogICAgaWYgKG0pIHsKICAgICAgY29uc3QgW3ksIG1vLCBkXSA9IFtOdW1iZXIobVsxXSksIE51bWJlcihtWzJdKSwgTnVtYmVyKG1bM10pXTsKICAgICAgaWYgKHZhbGlkRGF0ZSh5LCBtbywgZCkpIHJldHVybiB7IGRhdGU6IHRvSVNPKHksIG1vLCBkKSwgcmVzdDogbGluZS5yZXBsYWNlKG1bMF0sICcgJykgfTsKICAgIH0KICAgIC8vIOyVnuyXkCDsiKvsnpDCt+yJvO2RnOqwgCDsl4bripQgMDkvMjgg6rCZ7J2AIOuCoOynnC4gKOyYpOuemOuQnCBpT1Mg7IKs7YyM66as6rCAIOygleq3nOyLnSBsb29rYmVoaW5kIOulvCDrqrsg7J297Ja07IScCiAgICAvLyDslZ4g6riA7J6Q66W8IOq3uOujueycvOuhnCDsnqHqs6Ag65CY64+M66CkIOuGk+uKlOuLpCkKICAgIGxldCBrZWVwID0gJyc7CiAgICBtID0gbGluZS5tYXRjaCgvKFxkezEsMn0pXHMq7JuUXHMqKFxkezEsMn0pXHMq7J28Lyk7CiAgICBpZiAoIW0pIHsKICAgICAgY29uc3QgbW0gPSBsaW5lLm1hdGNoKC8oXnxbXlxkLF0pKFxkezEsMn0pWy8uXC1dKFxkezEsMn0pKD8hW1xkLF0pLyk7CiAgICAgIGlmIChtbSkgewogICAgICAgIGtlZXAgPSBtbVsxXTsKICAgICAgICBtID0gW21tWzBdLCBtbVsyXSwgbW1bM11dOwogICAgICB9CiAgICB9CiAgICBpZiAobSkgewogICAgICBjb25zdCBbbW8sIGRdID0gW051bWJlcihtWzFdKSwgTnVtYmVyKG1bMl0pXTsKICAgICAgY29uc3QgeSA9IGluZmVyWWVhcihtbywgZCwgcmVmSVNPKTsKICAgICAgaWYgKHZhbGlkRGF0ZSh5LCBtbywgZCkpIHJldHVybiB7IGRhdGU6IHRvSVNPKHksIG1vLCBkKSwgcmVzdDogbGluZS5yZXBsYWNlKG1bMF0sIGAke2tlZXB9IGApIH07CiAgICB9CiAgICByZXR1cm4geyBkYXRlOiBudWxsLCByZXN0OiBsaW5lIH07CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0QW1vdW50KGxpbmUpIHsKICAgIC8vIFvsoJXqt5zsi50sIOq4iOyVoSDqt7jro7ksIOuQmOuPjOugpCDrhpPsnYQg7JWeIOq4gOyekCDqt7jro7ldCiAgICBjb25zdCBwYXR0ZXJucyA9IFsKICAgICAgWy8oLT9cZFtcZCxdKilccyrsm5AvLCAxLCAwXSwgLy8gMTIsMDAw7JuQCiAgICAgIFsvKC0/XGR7MSwzfSg/OixcZHszfSkrKSg/IVxkKS8sIDEsIDBdLCAvLyAxMiwwMDAKICAgICAgWy8oXnxcRCkoLT9cZHszLH0pKD8hXGQpLywgMiwgMV0sIC8vIDEyMDAwCiAgICBdOwogICAgZm9yIChjb25zdCBbcCwgZywga10gb2YgcGF0dGVybnMpIHsKICAgICAgY29uc3QgbSA9IGxpbmUubWF0Y2gocCk7CiAgICAgIGlmIChtKSB7CiAgICAgICAgY29uc3QgbiA9IE51bWJlcihtW2ddLnJlcGxhY2UoLywvZywgJycpKTsKICAgICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gIT09IDApIHJldHVybiB7IGFtb3VudDogbiwgcmVzdDogbGluZS5yZXBsYWNlKG1bMF0sIGAke2sgPyBtW2tdIDogJyd9IGApIH07CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB7IGFtb3VudDogbnVsbCwgcmVzdDogbGluZSB9OwogIH0KCiAgZnVuY3Rpb24gY2xlYW5NZW1vKHMpIHsKICAgIGxldCBvdXQgPSBzOwogICAgZm9yIChjb25zdCBwIG9mIE5PSVNFX1BBVFRFUk5TKSBvdXQgPSBvdXQucmVwbGFjZShwLCAnICcpOwogICAgcmV0dXJuIG91dAogICAgICAucmVwbGFjZSgvW1x0LHw7XSsvZywgJyAnKQogICAgICAucmVwbGFjZSgvXltcc1wtOsK3LygpXSt8W1xzXC06wrcvKCldKyQvZywgJycpCiAgICAgIC5yZXBsYWNlKC9ccysvZywgJyAnKQogICAgICAudHJpbSgpOwogIH0KCiAgLyoKICAgKiDsl6zrn6wg7KSE7J2YIO2FjeyKpO2KuCjsubTrk5wg66y47J6QLCDsnYDtlokg7JWxIOuCtOyXrSwg7JeR7IWAIOuzteyCrCDrk7Ep7JeQ7IScIOyngOy2nOydhCDrvZHslYTrgrjri6QuCiAgICog67CY7ZmYOiB7IGl0ZW1zOiBbeyBkYXRlLCBhbW91bnQsIG1lbW8sIHJhdyB9XSwgc2tpcHBlZDogW3Jhdy4uLl0gfQogICAqLwogIGZ1bmN0aW9uIHBhcnNlRXhwZW5zZVRleHQodGV4dCwgcmVmSVNPKSB7CiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgY29uc3Qgc2tpcHBlZCA9IFtdOwogICAgZm9yIChjb25zdCByYXdMaW5lIG9mIFN0cmluZyh0ZXh0IHx8ICcnKS5zcGxpdCgvXHI/XG4vKSkgewogICAgICBjb25zdCByYXcgPSByYXdMaW5lLnRyaW0oKTsKICAgICAgaWYgKCFyYXcpIGNvbnRpbnVlOwogICAgICBjb25zdCBpc0NhbmNlbCA9IC/st6jshox87ZmY67aILy50ZXN0KHJhdyk7CiAgICAgIC8vIOuIhOyggS/snpTslaEg6riI7JWh7J20IOqysOygnCDquIjslaHsnLzroZwg7J6h7Z6I7KeAIOyViuuPhOuhnSDrqLzsoIAg7KCc6rGwCiAgICAgIGxldCB3b3JrID0gcmF3CiAgICAgICAgLnJlcGxhY2UoLyjriITsoIF87J6U7JWhfOyelOqzoHztlZzrj4QpXHMqOj9ccyotP1tcZCxdK1xzKuybkD8vZywgJyAnKQogICAgICAgIC5yZXBsYWNlKC9cZHsxLDJ9OlxkezJ9KDpcZHsyfSk/L2csICcgJykKICAgICAgICAucmVwbGFjZSgvXChccypbXGQqXXszLDR9XHMqXCl8XCpcZHszLDR9L2csICcgJykKICAgICAgICAucmVwbGFjZSgvXHQvZywgJyAnKTsKICAgICAgY29uc3QgZCA9IGV4dHJhY3REYXRlKHdvcmssIHJlZklTTyk7CiAgICAgIHdvcmsgPSBkLnJlc3Q7CiAgICAgIGNvbnN0IGEgPSBleHRyYWN0QW1vdW50KHdvcmspOwogICAgICBpZiAoYS5hbW91bnQgPT09IG51bGwpIHsKICAgICAgICBza2lwcGVkLnB1c2gocmF3KTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBsZXQgYW1vdW50ID0gTWF0aC5hYnMoYS5hbW91bnQpOwogICAgICBpZiAoaXNDYW5jZWwgfHwgYS5hbW91bnQgPCAwKSBhbW91bnQgPSAtYW1vdW50OwogICAgICBjb25zdCBtZW1vID0gY2xlYW5NZW1vKGEucmVzdC5yZXBsYWNlKC/st6jshox87ZmY67aIL2csICcgJykpIHx8ICco64K07JqpIOyXhuydjCknOwogICAgICBpdGVtcy5wdXNoKHsgZGF0ZTogZC5kYXRlIHx8IHJlZklTTywgYW1vdW50LCBtZW1vLCByYXcgfSk7CiAgICB9CiAgICByZXR1cm4geyBpdGVtcywgc2tpcHBlZCB9OwogIH0KCiAgZnVuY3Rpb24gaXNEdXBsaWNhdGUoaXRlbSwgdHJhbnNhY3Rpb25zKSB7CiAgICByZXR1cm4gdHJhbnNhY3Rpb25zLnNvbWUoCiAgICAgICh0KSA9PiB0LmRhdGUgPT09IGl0ZW0uZGF0ZSAmJiB0LmFtb3VudCA9PT0gaXRlbS5hbW91bnQgJiYgbm9ybWFsaXplTWVyY2hhbnQodC5tZW1vKSA9PT0gbm9ybWFsaXplTWVyY2hhbnQoaXRlbS5tZW1vKQogICAgKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rKw7KCcwrfsnoXstpzquIgg7JWM66a8ICjsubTrk5wg66y47J6QLCDsnYDtlokg7JWxIOyVjOumvCkgLS0tLS0tLS0tLQoKICAvLyDqsbDrnpgg7JWM66a87LKY65+8IOuztOydtOuKlCDquIDsnbjsp4AgKOyduOymneuyiO2YuCwg6rSR6rOgIOuTseydgCDsoJzsmbgpCiAgZnVuY3Rpb24gbG9va3NMaWtlVHJhbnNhY3Rpb24odGV4dCkgewogICAgY29uc3QgdCA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICghL1tcZCxdK1xzKuybkC8udGVzdCh0KSkgcmV0dXJuIGZhbHNlOwogICAgaWYgKC/snbjspp1ccyrrsojtmLh87J247Kad7L2U65OcLy50ZXN0KHQpKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gL+yKueyduHzqsrDsoJx87IKs7JqpfOy3qOyGjHzstpzquIh87J6F6riIfOydtOyytHzshqHquIh867O064OIfOuwm+yVmC8udGVzdCh0KTsKICB9CgogIGZ1bmN0aW9uIGRpZ2l0c09ubHkocykgewogICAgcmV0dXJuIFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9cRC9nLCAnJyk7CiAgfQoKICAvLyDslYzrprzsl5Ag7KCB7Z6MIOqzhOyijMK37Lm065OcIOuyiO2YuCjqsIDroKTsp4Qg67KI7Zi4IO2PrO2VqCnsnZgg64Gd7J6Q66as66GcIOuTseuhneuQnCDqs4Tsoowv7Lm065Oc66W8IOywvuuKlOuLpAogIGZ1bmN0aW9uIG1hdGNoQWNjb3VudCh0ZXh0LCBhY2NvdW50cykgewogICAgY29uc3QgY2h1bmtzID0gU3RyaW5nKHRleHQgfHwgJycpLm1hdGNoKC9bXGQqXVtcZCpcLV17Mix9L2cpIHx8IFtdOwogICAgZm9yIChjb25zdCBhIG9mIGFjY291bnRzIHx8IFtdKSB7CiAgICAgIGNvbnN0IGxhc3Q0ID0gZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCk7CiAgICAgIGlmIChsYXN0NC5sZW5ndGggPCAzKSBjb250aW51ZTsKICAgICAgZm9yIChjb25zdCBjIG9mIGNodW5rcykgewogICAgICAgIGlmICgvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChjKSkgY29udGludWU7IC8vIOuCoOynnAogICAgICAgIGlmIChkaWdpdHNPbmx5KGMpLmVuZHNXaXRoKGxhc3Q0KSkgcmV0dXJuIGE7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gYWNjb3VudEJ5TGFzdDQobGFzdDQsIGFjY291bnRzKSB7CiAgICBjb25zdCBkID0gZGlnaXRzT25seShsYXN0NCkuc2xpY2UoLTQpOwogICAgaWYgKGQubGVuZ3RoIDwgMykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKGFjY291bnRzIHx8IFtdKS5maW5kKChhKSA9PiBkaWdpdHNPbmx5KGEubGFzdDQpLnNsaWNlKC00KSA9PT0gZCkgfHwgbnVsbDsKICB9CgogIC8vIEFJIOyXhuydtCDslYzrprzsnYQg7J297J2EIOuVjCDqsbDrnpgg7KKF66WYIOy2lOy4oQogIGZ1bmN0aW9uIGRldGVjdEtpbmQodGV4dCwgbXlOYW1lKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRleHQgfHwgJycpOwogICAgaWYgKC/sirnsnbh86rKw7KCcLy50ZXN0KHQpKSByZXR1cm4gJ2V4cGVuc2UnOwogICAgaWYgKG15TmFtZSAmJiB0LmluY2x1ZGVzKG15TmFtZSkgJiYgL+ydtOyytHzstpzquIh87Iah6riIfOuztOuDiHzsnoXquIh867Cb7JWYLy50ZXN0KHQpKSByZXR1cm4gJ3RyYW5zZmVyJzsKICAgIGlmICgv7J6F6riIfOuwm+yVmC8udGVzdCh0KSAmJiAhL+y2nOq4iC8udGVzdCh0KSkgcmV0dXJuICdpbmNvbWUnOwogICAgcmV0dXJuICdleHBlbnNlJzsKICB9CgogIC8vIEFJIOulvCDsk7gg7IiYIOyXhuydhCDrlYzsnZgg7JWM66a8IOyduOyLnS4g7Jes65+sIOykhCDslYzrprzsnYQg7ZWcIOykhOuhnCDtlanss5DshJwg7J2964qU64ukLgogIC8vIOuwmO2ZmDogeyBkYXRlLCBhbW91bnQsIG1lbW8sIGtpbmQsIGFjY291bnRJZCwgYmFsYW5jZSB9IOuYkOuKlCBudWxsCiAgZnVuY3Rpb24gcGFyc2VNZXNzYWdlRmFsbGJhY2sodGV4dCwgcmVmSVNPLCBvcHRzID0ge30pIHsKICAgIGlmICghbG9va3NMaWtlVHJhbnNhY3Rpb24odGV4dCkpIHJldHVybiBudWxsOwogICAgY29uc3QgYmFsYW5jZU1hdGNoID0gU3RyaW5nKHRleHQpLm1hdGNoKC/snpTslaFccyo6P1xzKihbXGQsXSspXHMq7JuQPy8pOwogICAgY29uc3QgYWNjb3VudCA9IG1hdGNoQWNjb3VudCh0ZXh0LCBvcHRzLmFjY291bnRzKTsKICAgIGNvbnN0IG9uZUxpbmUgPSBTdHJpbmcodGV4dCkKICAgICAgLnJlcGxhY2UoL1xyP1xuL2csICcgJykKICAgICAgLnJlcGxhY2UoLyg/OltcZFwtXStcKit8XCorW1xkXC1dKylbXGQqXC1dKnxcZHszLH0tXGR7Mix9LVxkezMsfS9nLCAnICcpIC8vIOqwgOugpOynhCDrsojtmLgsIOqzhOyijOuyiO2YuAogICAgICAucmVwbGFjZSgv7J6F6riIfOydtOyytHzshqHquIh867O064OI7Ja07JqUfOuwm+yVmOyWtOyalHzri5jsl5Dqsox864uY7J20L2csICcgJyk7CiAgICBjb25zdCB7IGl0ZW1zIH0gPSBwYXJzZUV4cGVuc2VUZXh0KG9uZUxpbmUsIHJlZklTTyk7CiAgICBjb25zdCBpdGVtID0gaXRlbXNbMF07CiAgICBpZiAoIWl0ZW0pIHJldHVybiBudWxsOwogICAgY29uc3Qga2luZCA9IGRldGVjdEtpbmQodGV4dCwgb3B0cy5teU5hbWUpOwogICAgcmV0dXJuIHsKICAgICAgZGF0ZTogaXRlbS5kYXRlLAogICAgICBhbW91bnQ6IGtpbmQgPT09ICdleHBlbnNlJyA/IGl0ZW0uYW1vdW50IDogTWF0aC5hYnMoaXRlbS5hbW91bnQpLAogICAgICBtZW1vOiBpdGVtLm1lbW8sCiAgICAgIGtpbmQsCiAgICAgIGFjY291bnRJZDogYWNjb3VudCA/IGFjY291bnQuaWQgOiBudWxsLAogICAgICBiYWxhbmNlOiBiYWxhbmNlTWF0Y2ggPyBOdW1iZXIoYmFsYW5jZU1hdGNoWzFdLnJlcGxhY2UoLywvZywgJycpKSA6IG51bGwsCiAgICB9OwogIH0KCiAgLy8gLS0tLS0tLS0tLSDquLDqsITrs4Qg7J6Q7IKw6rSA66as6rOE7ZqNIC0tLS0tLS0tLS0KCiAgY29uc3QgQkFTRV9QTEFOX0ZST00gPSAnMDAwMC0wMS0wMSc7CgogIC8vIO2VtOuLuSDquLDqsITsl5Ag7KCB7Jqp65CY64qUIOqzhO2ajTog7Iuc7J6R7J287J20IOq3uCDquLDqsIQg7J207KCE7J24IOqzhO2ajSDspJEg6rCA7J6lIOy1nOq3vCDqsoMKICBmdW5jdGlvbiBwbGFuRm9yKHN0YXRlLCBwZXJpb2RLZXkpIHsKICAgIGNvbnN0IHBsYW5zID0gc3RhdGUucGxhbnM7CiAgICBsZXQgZm91bmQgPSBwbGFuc1swXTsKICAgIGZvciAoY29uc3QgcCBvZiBwbGFucykgaWYgKHAuZnJvbSA8PSBwZXJpb2RLZXkpIGZvdW5kID0gcDsKICAgIHJldHVybiBmb3VuZDsKICB9CgogIC8vIOydtCDquLDqsITrtoDthLAg7KCB7Jqp65CY64qUIOqzhO2ajeydhCDsiJjsoJXtlZjroKTqs6Ag7ZWgIOuVjCDtmLjstpwuIOyXhuycvOuptCDsp4HsoIQg6rOE7ZqN7J2EIOuzteyCrO2VtOyEnCDrp4zrk6Dri6QuCiAgZnVuY3Rpb24gZW5zdXJlUGxhbkZvcihzdGF0ZSwgcGVyaW9kS2V5LCBub3dJU08pIHsKICAgIGNvbnN0IGV4aXN0aW5nID0gc3RhdGUucGxhbnMuZmluZCgocCkgPT4gcC5mcm9tID09PSBwZXJpb2RLZXkpOwogICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gZXhpc3Rpbmc7CiAgICBjb25zdCBiYXNlID0gcGxhbkZvcihzdGF0ZSwgcGVyaW9kS2V5KTsKICAgIGNvbnN0IGNvcHkgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGJhc2UpKTsKICAgIGNvcHkuZnJvbSA9IHBlcmlvZEtleTsKICAgIGNvcHkudXBkYXRlZEF0ID0gbm93SVNPOwogICAgc3RhdGUucGxhbnMucHVzaChjb3B5KTsKICAgIHN0YXRlLnBsYW5zLnNvcnQoKGEsIGIpID0+IChhLmZyb20gPCBiLmZyb20gPyAtMSA6IGEuZnJvbSA+IGIuZnJvbSA/IDEgOiAwKSk7CiAgICByZXR1cm4gY29weTsKICB9CgogIGZ1bmN0aW9uIG5leHRQbGFuQWZ0ZXIoc3RhdGUsIHBsYW4pIHsKICAgIHJldHVybiBzdGF0ZS5wbGFucy5maW5kKChwKSA9PiBwLmZyb20gPiBwbGFuLmZyb20pIHx8IG51bGw7CiAgfQoKICAvLyDsi5zsnpHsnbzsnYQg67CU6r6466m0IOq4sOqwhCDtgqQo7Iuc7J6RIOuCoOynnCnrpbwg6rCZ7J2AIOuLrOydmCDsg4gg7Iuc7J6R7J2866GcIOyYruq4tOuLpC4KICBmdW5jdGlvbiByZW1hcFBlcmlvZEtleXMoc3RhdGUsIG5ld1N0YXJ0RGF5KSB7CiAgICBjb25zdCBtb3ZlID0gKGtleSkgPT4gewogICAgICBpZiAoa2V5ID09PSBCQVNFX1BMQU5fRlJPTSkgcmV0dXJuIGtleTsKICAgICAgY29uc3QgeyB5LCBtIH0gPSBwYXJzZUlTTyhrZXkpOwogICAgICByZXR1cm4gdG9JU08oeSwgbSwgTWF0aC5taW4obmV3U3RhcnREYXksIGRheXNJbk1vbnRoKHksIG0pKSk7CiAgICB9OwogICAgY29uc3QgaW5jb21lcyA9IHt9OwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoc3RhdGUuaW5jb21lcykpIGluY29tZXNbbW92ZShrKV0gPSB2OwogICAgc3RhdGUuaW5jb21lcyA9IGluY29tZXM7CiAgICBmb3IgKGNvbnN0IHAgb2Ygc3RhdGUucGxhbnMpIHAuZnJvbSA9IG1vdmUocC5mcm9tKTsKICAgIHN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5ID0gbmV3U3RhcnREYXk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIEFJIOu2hOulmCDsmpTssq0g66eM65Ok6riwIC8g6rKw6rO8IOydveq4sCAtLS0tLS0tLS0tCiAgLy8g7Iuk7KCcIEFQSSDtmLjstpzsnYAg7ISc67KEKEFwcHMgU2NyaXB0KeyXkOyEnCDtlZzri6QuIOyXrOq4sOyEnOuKlCDtlITroaztlITtirjsmYAgSlNPTiDsiqTtgqTrp4jrp4wg66eM65Og64ukLgoKICBmdW5jdGlvbiBjYXRlZ29yeUJyaWVmKGNhdGVnb3JpZXMsIG1lcmNoYW50TWFwKSB7CiAgICBjb25zdCBleGFtcGxlcyA9IHt9OwogICAgZm9yIChjb25zdCBbbWVyY2hhbnQsIGlkXSBvZiBPYmplY3QuZW50cmllcyhtZXJjaGFudE1hcCB8fCB7fSkpIHsKICAgICAgKGV4YW1wbGVzW2lkXSA9IGV4YW1wbGVzW2lkXSB8fCBbXSkucHVzaChtZXJjaGFudCk7CiAgICB9CiAgICByZXR1cm4gY2F0ZWdvcmllcy5tYXAoKGMpID0+ICh7CiAgICAgIGlkOiBjLmlkLAogICAgICBuYW1lOiBjLm5hbWUsCiAgICAgIGRlc2NyaXB0aW9uOiBjLmRlc2NyaXB0aW9uIHx8ICcnLAogICAgICBrZXl3b3JkczogKGMua2V5d29yZHMgfHwgW10pLnNsaWNlKDAsIDIwKSwKICAgICAgZXhhbXBsZXM6IChleGFtcGxlc1tjLmlkXSB8fCBbXSkuc2xpY2UoLTEwKSwKICAgIH0pKTsKICB9CgogIGNvbnN0IENMQVNTSUZZX1NZU1RFTSA9IFsKICAgICfri7nsi6DsnYAg7ZWc6rWt7Ja0IOqwgOqzhOu2gOydmCDsp4Dstpwg67aE66WY6riw7J6F64uI64ukLicsCiAgICAn7IKs7Jqp7J6Q6rCAIOygle2VtCDrkZQg7J6Q7IKw6rSA66as6rOE7ZqNIO2VreuqqSDrqqnroZ3snbQg7KO87Ja07KeA66m0LCDqsIEg7KeA7Lac7J2EIOqwgOyepSDslYzrp57snYAg7ZWt66qpIGlkIO2VmOuCmOuhnCDrtoTrpZjtlZjshLjsmpQuJywKICAgICftla3rqqnsnZgg7J2066aELCDshKTrqoUsIO2CpOybjOuTnCwg7IKs7Jqp7J6Q6rCAIOyYiOyghOyXkCDsp4HsoJEg67aE66WY7ZWcIOqwgOunueygkCDsmIjsi5woZXhhbXBsZXMp66W8IOq3vOqxsOuhnCDtjJDri6jtlanri4jri6QuJywKICAgICfqsIDrp7nsoJAg7J2066aE66eM7Jy866GcIOyXheyiheydhCDstpTroaDtlbTrj4Qg65Cp64uI64ukLiDslrTripAg7ZWt66qp7JeQ64+EIOunnuyngCDslYrqsbDrgpgg64+E7KCA7Z6IIO2MkOuLqO2VoCDsiJgg7JeG7Jy866m0ICJub25lIuydhCDqs6DrpbTshLjsmpQuJywKICBdLmpvaW4oJ1xuJyk7CgogIGZ1bmN0aW9uIGJ1aWxkQ2xhc3NpZnlSZXF1ZXN0KGNhdGVnb3JpZXMsIGl0ZW1zLCBtZXJjaGFudE1hcCkgewogICAgY29uc3QgaWRzID0gY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpOwogICAgY29uc3QgdXNlciA9IEpTT04uc3RyaW5naWZ5KHsKICAgICAgY2F0ZWdvcmllczogY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCksCiAgICAgIGV4cGVuc2VzOiBpdGVtcy5tYXAoKGl0LCBpKSA9PiAoeyBpbmRleDogaSwgbWVyY2hhbnQ6IGl0Lm1lbW8sIGFtb3VudDogaXQuYW1vdW50LCBkYXRlOiBpdC5kYXRlIH0pKSwKICAgIH0pOwogICAgY29uc3Qgc2NoZW1hID0gewogICAgICB0eXBlOiAnb2JqZWN0JywKICAgICAgcHJvcGVydGllczogewogICAgICAgIHJlc3VsdHM6IHsKICAgICAgICAgIHR5cGU6ICdhcnJheScsCiAgICAgICAgICBpdGVtczogewogICAgICAgICAgICB0eXBlOiAnb2JqZWN0JywKICAgICAgICAgICAgcHJvcGVydGllczogewogICAgICAgICAgICAgIGluZGV4OiB7IHR5cGU6ICdpbnRlZ2VyJyB9LAogICAgICAgICAgICAgIGNhdGVnb3J5SWQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IGlkcy5jb25jYXQoWydub25lJ10pIH0sCiAgICAgICAgICAgIH0sCiAgICAgICAgICAgIHJlcXVpcmVkOiBbJ2luZGV4JywgJ2NhdGVnb3J5SWQnXSwKICAgICAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLAogICAgICAgICAgfSwKICAgICAgICB9LAogICAgICB9LAogICAgICByZXF1aXJlZDogWydyZXN1bHRzJ10sCiAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSwKICAgIH07CiAgICByZXR1cm4geyBzeXN0ZW06IENMQVNTSUZZX1NZU1RFTSwgdXNlciwgc2NoZW1hIH07CiAgfQoKICAvLyBBSSDsnZHri7Ug4oaSIGl0ZW1zIOyZgCDqsJnsnYAg6ri47J207J2YIGNhdGVnb3J5SWQg67Cw7Je0ICjslYwg7IiYIOyXhuycvOuptCBudWxsKQogIGZ1bmN0aW9uIHJlYWRDbGFzc2lmeVJlc3BvbnNlKGpzb24sIGNhdGVnb3JpZXMsIGNvdW50KSB7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGNvbnN0IG91dCA9IG5ldyBBcnJheShjb3VudCkuZmlsbChudWxsKTsKICAgIGZvciAoY29uc3QgciBvZiAoanNvbiAmJiBqc29uLnJlc3VsdHMpIHx8IFtdKSB7CiAgICAgIGlmIChOdW1iZXIuaXNJbnRlZ2VyKHIuaW5kZXgpICYmIHIuaW5kZXggPj0gMCAmJiByLmluZGV4IDwgY291bnQgJiYga25vd24uaGFzKHIuY2F0ZWdvcnlJZCkpIHsKICAgICAgICBvdXRbci5pbmRleF0gPSByLmNhdGVnb3J5SWQ7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBNRVNTQUdFX1NZU1RFTSA9IFsKICAgICfri7nsi6DsnYAg7ZWc6rWtIOy5tOuTnOyCrMK37J2A7ZaJ7J2YIOqysOygnC/snoXstpzquIgg7JWM66a8KOusuOyekCDrmJDripQg7JWxIOyVjOumvCnsnYQg7J297Ja0IOqwgOqzhOu2gOyXkCDquLDroZ3tlZjripQg64+E7Jqw66+47J6F64uI64ukLicsCiAgICAn7JWM66a87JeQ7IScIOqxsOuemCDsooXrpZgsIOuCoOynnCwg6riI7JWhKOybkCksIOqwgOunueygkCDrmJDripQg7IOB64yA67CpIOydtOumhCwg7J6U7JWh7J2EIOu9keqzoCwg7KeA7Lac7J2066m0IOyCrOyaqeyekOydmCDsnpDsgrDqtIDrpqzqs4Ttmo0g7ZWt66qpIOykkSDslYzrp57snYAg7ZWt66qpIGlkIOuhnCDrtoTrpZjtlZjshLjsmpQuJywKICAgICcnLAogICAgJ2tpbmQg6rec7LmZOicsCiAgICAnLSBleHBlbnNlOiDsubTrk5wg6rKw7KCcLCDqs4Tsoozsl5DshJwg64uk66W4IOyCrOuejMK36rCA6rKM66GcIOuztOuCuCDstpzquIgv7J207LK0LCDsnpDrj5nsnbTssrQsIOqzteqzvOq4iCcsCiAgICAnLSBpbmNvbWU6IOuLpOuluCDsgqzrnozsnbTrgpgg7ZqM7IKs7JeQ7IScIOuTpOyWtOyYqCDsnoXquIggKOq4ieyXrCwg7ZmY6riJIOuTsSknLAogICAgJy0gb3duX3RyYW5zZmVyOiDsgqzsmqnsnpAg67O47J24IOqzhOyijOuBvOumrCDsmK7quLQg64+ILiDsg4HrjIDrsKkg7J2066aE7J20IOyCrOyaqeyekCDsnbTrpoQobXlfbmFtZSnqs7wg6rCZ6rGw64KYLCDslYzrprzsnZgg7IOB64yAIOqzhOyijOqwgCDsgqzsmqnsnpDsnZgg65Ox66GdIOqzhOyijChhY2NvdW50cynsnbTrqbQg7ZW064u57ZWp64uI64ukLicsCiAgICAnLSBub3RfdHJhbnNhY3Rpb246IOyduOymneuyiO2YuCwg6rSR6rOgLCDslYjrgrQg65OxIOqxsOuemOqwgCDslYTri4wg7JWM66a8JywKICAgICcnLAogICAgJy0g67O47J24IOqzhOyijOuhnCDsmK7quLQg64+I7J20IOyggOy2lSDqs4TsoowoaXNTYXZpbmdzKeuCmCDsoIHquIjCt+yyreyVvcK37Kad6raMIOqzhOyijOuhnCDrk6TslrTqsIDripQg7Lac6riI7J2066m0IHRvX3NhdmluZ3Mg66W8IHRydWUg66GcIO2VmOqzoCBjYXRlZ29yeUlkIOulvCDsoIDstpUg7ISx6rKp7J2YIO2VreuqqeycvOuhnCDqs6DrpbTshLjsmpQuIOq3uCDrsJbsl5DripQgZmFsc2UuJywKICAgICctIOuIhOyggSDquIjslaEsIO2VnOuPhCwg7Lm065Ocwrfqs4Tsoowg67KI7Zi4LCDsirnsnbjrsojtmLjripQg6rGw656YIOq4iOyVoeydtCDslYTri5nri4jri6QuIOyelOyVoeydtCDsoIHtmIAg7J6I7Jy866m0IGJhbGFuY2Ug7JeQLCDsl4bsnLzrqbQgLTEuJywKICAgICctIGFjY291bnRfbGFzdDQ6IOydtCDslYzrprzsnbQg7Ja064qQIOuTseuhnSDqs4Tsoowv7Lm065Oc7JeQ7IScIOydvOyWtOuCnCDqsbDrnpjsnbjsp4Ag6re4IOuBnSA07J6Q66asLiDrqqjrpbTrqbQg67mIIOusuOyekOyXtC4nLAogICAgJy0g7Iq57J247Leo7IaML+2ZmOu2iOydtOuptCBpc19jYW5jZWwg7J2EIHRydWUg66GcIO2VmOyEuOyalC4nLAogICAgJy0gZGF0ZSDripQgWVlZWS1NTS1ERC4g7Jew64+E6rCAIOyXhuycvOuptCDsmKTripgodG9kYXkpIOq4sOykgCDqsIDsnqUg6rCA6rmM7Jq0IOqzvOqxsCDrgqDsp5wsIOuCoOynnOqwgCDsl4bsnLzrqbQgdG9kYXkuJywKICAgICctIOyngOy2nOydtCDslYTri4jqsbDrgpgg7JWM66ee7J2AIO2VreuqqeydtCDsl4bsnLzrqbQgY2F0ZWdvcnlJZCDrpbwgIm5vbmUiIOycvOuhnCDtlZjshLjsmpQuJywKICBdLmpvaW4oJ1xuJyk7CgogIGZ1bmN0aW9uIGJ1aWxkTWVzc2FnZVJlcXVlc3QoY2F0ZWdvcmllcywgdGV4dCwgdG9kYXlJU08sIG1lcmNoYW50TWFwLCBvcHRzID0ge30pIHsKICAgIGNvbnN0IGlkcyA9IGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKTsKICAgIGNvbnN0IHVzZXIgPSBKU09OLnN0cmluZ2lmeSh7CiAgICAgIHRvZGF5OiB0b2RheUlTTywKICAgICAgbXlfbmFtZTogb3B0cy5teU5hbWUgfHwgJycsCiAgICAgIGFjY291bnRzOiAob3B0cy5hY2NvdW50cyB8fCBbXSkubWFwKChhKSA9PiAoeyBuYW1lOiBhLm5hbWUsIHR5cGU6IGEudHlwZSwgbGFzdDQ6IGRpZ2l0c09ubHkoYS5sYXN0NCkuc2xpY2UoLTQpLCBpc1NhdmluZ3M6ICEhYS5pc1NhdmluZ3MgfSkpLAogICAgICBjYXRlZ29yaWVzOiBjYXRlZ29yeUJyaWVmKGNhdGVnb3JpZXMsIG1lcmNoYW50TWFwKSwKICAgICAgbWVzc2FnZTogU3RyaW5nKHRleHQpLAogICAgfSk7CiAgICBjb25zdCBzY2hlbWEgPSB7CiAgICAgIHR5cGU6ICdvYmplY3QnLAogICAgICBwcm9wZXJ0aWVzOiB7CiAgICAgICAga2luZDogeyB0eXBlOiAnc3RyaW5nJywgZW51bTogWydleHBlbnNlJywgJ2luY29tZScsICdvd25fdHJhbnNmZXInLCAnbm90X3RyYW5zYWN0aW9uJ10gfSwKICAgICAgICBpc19jYW5jZWw6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sCiAgICAgICAgdG9fc2F2aW5nczogeyB0eXBlOiAnYm9vbGVhbicgfSwKICAgICAgICBkYXRlOiB7IHR5cGU6ICdzdHJpbmcnIH0sCiAgICAgICAgYW1vdW50OiB7IHR5cGU6ICdpbnRlZ2VyJyB9LAogICAgICAgIG1lcmNoYW50OiB7IHR5cGU6ICdzdHJpbmcnIH0sCiAgICAgICAgYWNjb3VudF9sYXN0NDogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGJhbGFuY2U6IHsgdHlwZTogJ2ludGVnZXInIH0sCiAgICAgICAgY2F0ZWdvcnlJZDogeyB0eXBlOiAnc3RyaW5nJywgZW51bTogaWRzLmNvbmNhdChbJ25vbmUnXSkgfSwKICAgICAgfSwKICAgICAgcmVxdWlyZWQ6IFsna2luZCcsICdpc19jYW5jZWwnLCAndG9fc2F2aW5ncycsICdkYXRlJywgJ2Ftb3VudCcsICdtZXJjaGFudCcsICdhY2NvdW50X2xhc3Q0JywgJ2JhbGFuY2UnLCAnY2F0ZWdvcnlJZCddLAogICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsCiAgICB9OwogICAgcmV0dXJuIHsgc3lzdGVtOiBNRVNTQUdFX1NZU1RFTSwgdXNlciwgc2NoZW1hIH07CiAgfQoKICAvLyBBSSDsnZHri7Ug4oaSIHsgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kLCBjYXRlZ29yeUlkLCBhY2NvdW50SWQsIGJhbGFuY2UgfSDrmJDripQgbnVsbCjqsbDrnpgg7JWE64uYKQogIGZ1bmN0aW9uIHJlYWRNZXNzYWdlUmVzcG9uc2UoanNvbiwgY2F0ZWdvcmllcywgdG9kYXlJU08sIGFjY291bnRzKSB7CiAgICBpZiAoIWpzb24gfHwgIWpzb24ua2luZCB8fCBqc29uLmtpbmQgPT09ICdub3RfdHJhbnNhY3Rpb24nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGFtb3VudEFicyA9IE1hdGguYWJzKE1hdGgucm91bmQoTnVtYmVyKGpzb24uYW1vdW50KSB8fCAwKSk7CiAgICBpZiAoIWFtb3VudEFicykgcmV0dXJuIG51bGw7CiAgICBsZXQgZGF0ZSA9IFN0cmluZyhqc29uLmRhdGUgfHwgJycpOwogICAgaWYgKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKSkgZGF0ZSA9IHRvZGF5SVNPOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBjYXRlZ29yeUlkID0ga25vd24uaGFzKGpzb24uY2F0ZWdvcnlJZCkgPyBqc29uLmNhdGVnb3J5SWQgOiBudWxsOwogICAgY29uc3QgYWNjb3VudCA9IGFjY291bnRCeUxhc3Q0KGpzb24uYWNjb3VudF9sYXN0NCwgYWNjb3VudHMpOwoKICAgIGxldCBraW5kID0gJ2V4cGVuc2UnOwogICAgaWYgKGpzb24ua2luZCA9PT0gJ2luY29tZScpIGtpbmQgPSAnaW5jb21lJzsKICAgIGVsc2UgaWYgKGpzb24ua2luZCA9PT0gJ293bl90cmFuc2ZlcicgJiYgIWpzb24udG9fc2F2aW5ncykga2luZCA9ICd0cmFuc2Zlcic7CgogICAgcmV0dXJuIHsKICAgICAgZGF0ZSwKICAgICAgYW1vdW50OiBraW5kID09PSAnZXhwZW5zZScgJiYganNvbi5pc19jYW5jZWwgPyAtYW1vdW50QWJzIDogYW1vdW50QWJzLAogICAgICBtZW1vOiBTdHJpbmcoanNvbi5tZXJjaGFudCB8fCAnJykudHJpbSgpIHx8ICco64K07JqpIOyXhuydjCknLAogICAgICBraW5kLAogICAgICBjYXRlZ29yeUlkOiBraW5kID09PSAnZXhwZW5zZScgPyBjYXRlZ29yeUlkIDogbnVsbCwKICAgICAgYWNjb3VudElkOiBhY2NvdW50ID8gYWNjb3VudC5pZCA6IG51bGwsCiAgICAgIGJhbGFuY2U6IE51bWJlci5pc0ludGVnZXIoanNvbi5iYWxhbmNlKSAmJiBqc29uLmJhbGFuY2UgPj0gMCA/IGpzb24uYmFsYW5jZSA6IG51bGwsCiAgICB9OwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsnYDtlokg6rGw656Y64K07JetIO2MjOydvCAo7JeR7IWAL0NTVikgLS0tLS0tLS0tLQogIC8vIOydgO2WieuniOuLpCDtla3rqqkg7J2066aE7J20IOuLrOudvOyEnCwg66i466as6riAKOyyqyDspIQp7J2YIOydtOumhOydhCDrs7Tqs6Ag7Lm47J2EIOywvuuKlOuLpC4KCiAgY29uc3QgQ09MVU1OX0hJTlRTID0gWwogICAgWydkYXRlJywgL+qxsOuemFxzKuydvOyLnHzqsbDrnphccyrsnbzsnpB86rGw656YXHMq64Kg7KecfF7snbzsi5wkfF7rgqDsp5wkfF7snbzsnpAkfF7qsbDrnpjsnbwkL10sCiAgICBbJ3RpbWUnLCAvXuyLnOqwhCR86rGw656YXHMq7Iuc6rCEfF7si5zqsIEkL10sCiAgICBbJ2NhdGVnb3J5JywgL+qxsOuemFxzKuq1rOu2hHzqsbDrnphccyrsnKDtmJV86rGw656YXHMq7KKF66WYL10sCiAgICBbJ3R5cGUnLCAvXuq1rOu2hCR87J6F7Lac6riIXHMq6rWs67aEfOyehVxzKlwvXHMq7Lac6riIfF7snoXstpzquIgkL10sCiAgICBbJ291dCcsIC/stpzquIhccyoo7JWhfOq4iOyVoSk/JHzssL7snLzsi6BccyrquIjslaF87KeA6riJXHMqKOyVoXzquIjslaEpPyQvXSwKICAgIFsnaW4nLCAv7J6F6riIXHMqKOyVoXzquIjslaEpPyR866eh6riw7IugXHMq6riI7JWhL10sCiAgICBbJ2Ftb3VudCcsIC/qsbDrnphccyrquIjslaF8Xuq4iOyVoSQvXSwKICAgIFsnYmFsYW5jZScsIC/snpTslaEvXSwKICAgIFsnbWVtbycsIC9e64K07JqpJHzqsbDrnphccyrrgrTsmql87KCB7JqUfOuwm+uKlFxzKuu2hHzrs7TrgrhccyrrtoR86rGw656Y7LKYfOq4sOyerFxzKuuCtOyaqXzsg4HrjIAvXSwKICAgIFsnbm90ZScsIC9e66mU66qoJC9dLAogIF07CgogIGZ1bmN0aW9uIGNlbGxUZXh0KHYpIHsKICAgIHJldHVybiB2ID09PSBudWxsIHx8IHYgPT09IHVuZGVmaW5lZCA/ICcnIDogU3RyaW5nKHYpLnRyaW0oKTsKICB9CgogIGZ1bmN0aW9uIGZpbmRIZWFkZXIocm93cykgewogICAgZm9yIChsZXQgciA9IDA7IHIgPCBNYXRoLm1pbihyb3dzLmxlbmd0aCwgMzApOyByKyspIHsKICAgICAgY29uc3QgY29scyA9IHt9OwogICAgICAocm93c1tyXSB8fCBbXSkuZm9yRWFjaCgoY2VsbCwgYykgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSBjZWxsVGV4dChjZWxsKS5yZXBsYWNlKC9ccysvZywgJyAnKTsKICAgICAgICBpZiAoIW5hbWUpIHJldHVybjsKICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHJlXSBvZiBDT0xVTU5fSElOVFMpIHsKICAgICAgICAgIGlmIChjb2xzW2tleV0gPT09IHVuZGVmaW5lZCAmJiByZS50ZXN0KG5hbWUpKSB7CiAgICAgICAgICAgIGNvbHNba2V5XSA9IGM7CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgfSk7CiAgICAgIGlmIChjb2xzLmRhdGUgIT09IHVuZGVmaW5lZCAmJiAoY29scy5hbW91bnQgIT09IHVuZGVmaW5lZCB8fCBjb2xzLm91dCAhPT0gdW5kZWZpbmVkIHx8IGNvbHMuaW4gIT09IHVuZGVmaW5lZCkpIHJldHVybiB7IHJvdzogciwgY29scyB9OwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICAvLyDsl5HshYAg64Kg7KecIOydvOugqOuyiO2YuCg0NTkyOCDrk7EpIOuYkOuKlCAiMjAyNi4wOS4yOCAxNDowMiIg6rCZ7J2AIOq4gOyekCDihpIgeyBkYXRlLCB0aW1lIH0KICBmdW5jdGlvbiBwYXJzZURhdGVDZWxsKHYpIHsKICAgIGlmICh0eXBlb2YgdiA9PT0gJ251bWJlcicgJiYgdiA+IDIwMDAwICYmIHYgPCA4MDAwMCkgewogICAgICBjb25zdCBtcyA9IE1hdGgucm91bmQoKHYgLSAyNTU2OSkgKiA4NjQwMDAwMCk7CiAgICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShtcyk7CiAgICAgIHJldHVybiB7CiAgICAgICAgZGF0ZTogdG9JU08oZC5nZXRVVENGdWxsWWVhcigpLCBkLmdldFVUQ01vbnRoKCkgKyAxLCBkLmdldFVUQ0RhdGUoKSksCiAgICAgICAgdGltZTogTnVtYmVyLmlzSW50ZWdlcih2KSA/ICcnIDogYCR7cGFkKGQuZ2V0VVRDSG91cnMoKSl9OiR7cGFkKGQuZ2V0VVRDTWludXRlcygpKX06JHtwYWQoZC5nZXRVVENTZWNvbmRzKCkpfWAsCiAgICAgIH07CiAgICB9CiAgICBjb25zdCBzID0gY2VsbFRleHQodik7CiAgICBjb25zdCBtID0gcy5tYXRjaCgvKFxkezR9KVxzKlsuXC0v64WEXVxzKihcZHsxLDJ9KVxzKlsuXC0v7JuUXVxzKihcZHsxLDJ9KS8pOwogICAgaWYgKCFtKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IFt5LCBtbywgZF0gPSBbTnVtYmVyKG1bMV0pLCBOdW1iZXIobVsyXSksIE51bWJlcihtWzNdKV07CiAgICBpZiAoIXZhbGlkRGF0ZSh5LCBtbywgZCkpIHJldHVybiBudWxsOwogICAgY29uc3QgdCA9IHMuc2xpY2UobS5pbmRleCArIG1bMF0ubGVuZ3RoKS5tYXRjaCgvKFxkezEsMn0pOihcZHsyfSkoPzo6KFxkezJ9KSk/Lyk7CiAgICByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHRpbWU6IHQgPyBgJHtwYWQodFsxXSl9OiR7dFsyXX06JHt0WzNdIHx8ICcwMCd9YCA6ICcnIH07CiAgfQoKICBmdW5jdGlvbiBwYXJzZUFtb3VudENlbGwodikgewogICAgaWYgKHR5cGVvZiB2ID09PSAnbnVtYmVyJykgcmV0dXJuIHY7CiAgICBsZXQgcyA9IGNlbGxUZXh0KHYpLnJlcGxhY2UoL1ssXHPsm5BdL2csICcnKTsKICAgIGlmICghcykgcmV0dXJuIG51bGw7CiAgICBsZXQgbmVnID0gZmFsc2U7CiAgICBpZiAoL15cKC4qXCkkLy50ZXN0KHMpKSB7CiAgICAgIG5lZyA9IHRydWU7CiAgICAgIHMgPSBzLnNsaWNlKDEsIC0xKTsKICAgIH0KICAgIGNvbnN0IG4gPSBOdW1iZXIocyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gbmVnID8gLW4gOiBuOwogIH0KCiAgLyoKICAgKiDqsbDrnpjrgrTsl60g7ZGcKDLssKjsm5Ag67Cw7Je0KeulvCDrgrTsl63snLzroZwg67CU6r6864ukLgogICAqIG9wdHM6IHsgbXlOYW1lLCBhY2NvdW50SWQgfQogICAqIOuwmO2ZmDogeyBpdGVtczogW3tkYXRlLCB0aW1lLCBhbW91bnQsIG1lbW8sIGtpbmQsIGFjY291bnRJZCwgYmFsYW5jZSwgcmF3fV0sIHNraXBwZWQsIGhlYWRlciwgbGF0ZXN0OiB7ZGF0ZSwgdGltZSwgYmFsYW5jZX0gfCBudWxsIH0KICAgKi8KICBmdW5jdGlvbiBwYXJzZVN0YXRlbWVudFJvd3Mocm93cywgb3B0cyA9IHt9KSB7CiAgICBjb25zdCBoZWFkZXIgPSBmaW5kSGVhZGVyKHJvd3MpOwogICAgaWYgKCFoZWFkZXIpIHJldHVybiB7IGl0ZW1zOiBbXSwgc2tpcHBlZDogMCwgaGVhZGVyOiBudWxsLCBsYXRlc3Q6IG51bGwgfTsKICAgIGNvbnN0IHsgY29scyB9ID0gaGVhZGVyOwogICAgY29uc3QgZ2V0ID0gKHJvdywga2V5KSA9PiAoY29sc1trZXldID09PSB1bmRlZmluZWQgPyAnJyA6IHJvd1tjb2xzW2tleV1dKTsKICAgIGNvbnN0IGl0ZW1zID0gW107CiAgICBsZXQgc2tpcHBlZCA9IDA7CiAgICBsZXQgbGF0ZXN0ID0gbnVsbDsKICAgIC8vIOq4iOyVoSDtlZwg7Lm47JeQIOy2nOq4iOydgCDsnYzsiJjroZwg7KCB64qUIO2MjOydvOyduOyngCAo6re466CH64uk66m0IOyWkeyImOuKlCDsnoXquIgpCiAgICBjb25zdCBzaWduZWQgPSBjb2xzLmFtb3VudCAhPT0gdW5kZWZpbmVkICYmIHJvd3Muc2xpY2UoaGVhZGVyLnJvdyArIDEpLnNvbWUoKHJvdykgPT4gKHBhcnNlQW1vdW50Q2VsbCgocm93IHx8IFtdKVtjb2xzLmFtb3VudF0pIHx8IDApIDwgMCk7CgogICAgZm9yIChsZXQgciA9IGhlYWRlci5yb3cgKyAxOyByIDwgcm93cy5sZW5ndGg7IHIrKykgewogICAgICBjb25zdCByb3cgPSByb3dzW3JdIHx8IFtdOwogICAgICBpZiAoIXJvdy5zb21lKChjKSA9PiBjZWxsVGV4dChjKSkpIGNvbnRpbnVlOwogICAgICBjb25zdCB3aGVuID0gcGFyc2VEYXRlQ2VsbChnZXQocm93LCAnZGF0ZScpKTsKICAgICAgaWYgKCF3aGVuKSB7CiAgICAgICAgc2tpcHBlZCArPSAxOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICghd2hlbi50aW1lICYmIGNvbHMudGltZSAhPT0gdW5kZWZpbmVkKSB7CiAgICAgICAgY29uc3QgdCA9IGNlbGxUZXh0KGdldChyb3csICd0aW1lJykpLm1hdGNoKC8oXGR7MSwyfSk6KFxkezJ9KSg/OjooXGR7Mn0pKT8vKTsKICAgICAgICBpZiAodCkgd2hlbi50aW1lID0gYCR7cGFkKHRbMV0pfToke3RbMl19OiR7dFszXSB8fCAnMDAnfWA7CiAgICAgIH0KCiAgICAgIGNvbnN0IHR5cGVUZXh0ID0gY2VsbFRleHQoZ2V0KHJvdywgJ3R5cGUnKSk7CiAgICAgIGNvbnN0IGNhdGVnb3J5VGV4dCA9IGNlbGxUZXh0KGdldChyb3csICdjYXRlZ29yeScpKTsKICAgICAgY29uc3Qgb3V0ID0gcGFyc2VBbW91bnRDZWxsKGdldChyb3csICdvdXQnKSk7CiAgICAgIGNvbnN0IGlubiA9IHBhcnNlQW1vdW50Q2VsbChnZXQocm93LCAnaW4nKSk7CiAgICAgIGNvbnN0IGFtdCA9IHBhcnNlQW1vdW50Q2VsbChnZXQocm93LCAnYW1vdW50JykpOwoKICAgICAgbGV0IGtpbmQ7CiAgICAgIGxldCBhbW91bnQ7CiAgICAgIGlmIChvdXQpIHsKICAgICAgICBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGFtb3VudCA9IE1hdGguYWJzKG91dCk7CiAgICAgIH0gZWxzZSBpZiAoaW5uKSB7CiAgICAgICAga2luZCA9ICdpbmNvbWUnOwogICAgICAgIGFtb3VudCA9IE1hdGguYWJzKGlubik7CiAgICAgIH0gZWxzZSBpZiAoYW10KSB7CiAgICAgICAgYW1vdW50ID0gTWF0aC5hYnMoYW10KTsKICAgICAgICBpZiAoL+yeheq4iC8udGVzdCh0eXBlVGV4dCkpIGtpbmQgPSAnaW5jb21lJzsKICAgICAgICBlbHNlIGlmICgv7Lac6riIfOyngOq4iS8udGVzdCh0eXBlVGV4dCkpIGtpbmQgPSAnZXhwZW5zZSc7CiAgICAgICAgZWxzZSBpZiAoYW10IDwgMCkga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBlbHNlIGtpbmQgPSBzaWduZWQgPyAnaW5jb21lJyA6ICdleHBlbnNlJzsKICAgICAgfSBlbHNlIHsKICAgICAgICBza2lwcGVkICs9IDE7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KCiAgICAgIGNvbnN0IG1lbW9NYWluID0gY2VsbFRleHQoZ2V0KHJvdywgJ21lbW8nKSk7CiAgICAgIGNvbnN0IG5vdGUgPSBjZWxsVGV4dChnZXQocm93LCAnbm90ZScpKTsKICAgICAgY29uc3QgbWVtbyA9IG1lbW9NYWluIHx8IG5vdGUgfHwgY2F0ZWdvcnlUZXh0IHx8ICco64K07JqpIOyXhuydjCknOwogICAgICBjb25zdCBhbGxUZXh0ID0gYCR7dHlwZVRleHR9ICR7Y2F0ZWdvcnlUZXh0fSAke21lbW99ICR7bm90ZX1gOwoKICAgICAgLy8g7Lm065OcIOqysOygnCDst6jshozCt+2ZmOu2iOuhnCDrk6TslrTsmKgg64+I7J2AIOyngOy2nOydhCDspITsnbTripQg6rKD7Jy866GcIOuzuOuLpAogICAgICBpZiAoa2luZCA9PT0gJ2luY29tZScgJiYgL+y3qOyGjHztmZjrtogvLnRlc3QoYWxsVGV4dCkpIHsKICAgICAgICBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGFtb3VudCA9IC1hbW91bnQ7CiAgICAgIH0KICAgICAgaWYgKG9wdHMubXlOYW1lICYmIG1lbW8uaW5jbHVkZXMob3B0cy5teU5hbWUpICYmICEv7Lm065OcfOqysOygnHzsirnsnbgvLnRlc3QoYWxsVGV4dCkpIGtpbmQgPSAndHJhbnNmZXInOwoKICAgICAgY29uc3QgYmFsYW5jZSA9IHBhcnNlQW1vdW50Q2VsbChnZXQocm93LCAnYmFsYW5jZScpKTsKICAgICAgY29uc3QgaXRlbSA9IHsKICAgICAgICBkYXRlOiB3aGVuLmRhdGUsCiAgICAgICAgdGltZTogd2hlbi50aW1lLAogICAgICAgIGFtb3VudCwKICAgICAgICBtZW1vLAogICAgICAgIGtpbmQsCiAgICAgICAgYWNjb3VudElkOiBvcHRzLmFjY291bnRJZCB8fCBudWxsLAogICAgICAgIGJhbGFuY2U6IE51bWJlci5pc0Zpbml0ZShiYWxhbmNlKSA/IGJhbGFuY2UgOiBudWxsLAogICAgICAgIHJhdzogcm93Lm1hcChjZWxsVGV4dCkuZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyB8ICcpLnNsaWNlKDAsIDMwMCksCiAgICAgIH07CiAgICAgIGl0ZW1zLnB1c2goaXRlbSk7CiAgICAgIGlmIChpdGVtLmJhbGFuY2UgIT09IG51bGwpIHsKICAgICAgICBjb25zdCBrZXkgPSBgJHtpdGVtLmRhdGV9ICR7aXRlbS50aW1lfWA7CiAgICAgICAgaWYgKCFsYXRlc3QgfHwga2V5ID49IGAke2xhdGVzdC5kYXRlfSAke2xhdGVzdC50aW1lfWApIGxhdGVzdCA9IHsgZGF0ZTogaXRlbS5kYXRlLCB0aW1lOiBpdGVtLnRpbWUsIGJhbGFuY2U6IGl0ZW0uYmFsYW5jZSB9OwogICAgICB9CiAgICB9CiAgICByZXR1cm4geyBpdGVtcywgc2tpcHBlZCwgaGVhZGVyLCBsYXRlc3QgfTsKICB9CgogIC8vIENTViDquIDsnpAg4oaSIDLssKjsm5Ag67Cw7Je0ICjrlLDsmLTtkZwg7JWI7J2YIOyJvO2RnMK37KSE67CU6r+IIOyymOumrCkKICBmdW5jdGlvbiBwYXJzZUNTVih0ZXh0KSB7CiAgICBjb25zdCByb3dzID0gW107CiAgICBsZXQgcm93ID0gW107CiAgICBsZXQgY2VsbCA9ICcnOwogICAgbGV0IHF1b3RlZCA9IGZhbHNlOwogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKS5yZXBsYWNlKC9eXHVGRUZGLywgJycpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IGNoID0gc1tpXTsKICAgICAgaWYgKHF1b3RlZCkgewogICAgICAgIGlmIChjaCA9PT0gJyInICYmIHNbaSArIDFdID09PSAnIicpIHsKICAgICAgICAgIGNlbGwgKz0gJyInOwogICAgICAgICAgaSArPSAxOwogICAgICAgIH0gZWxzZSBpZiAoY2ggPT09ICciJykgcXVvdGVkID0gZmFsc2U7CiAgICAgICAgZWxzZSBjZWxsICs9IGNoOwogICAgICB9IGVsc2UgaWYgKGNoID09PSAnIicpIHF1b3RlZCA9IHRydWU7CiAgICAgIGVsc2UgaWYgKGNoID09PSAnLCcgfHwgY2ggPT09ICdcdCcpIHsKICAgICAgICByb3cucHVzaChjZWxsKTsKICAgICAgICBjZWxsID0gJyc7CiAgICAgIH0gZWxzZSBpZiAoY2ggPT09ICdcbicgfHwgY2ggPT09ICdccicpIHsKICAgICAgICBpZiAoY2ggPT09ICdccicgJiYgc1tpICsgMV0gPT09ICdcbicpIGkgKz0gMTsKICAgICAgICByb3cucHVzaChjZWxsKTsKICAgICAgICByb3dzLnB1c2gocm93KTsKICAgICAgICByb3cgPSBbXTsKICAgICAgICBjZWxsID0gJyc7CiAgICAgIH0gZWxzZSBjZWxsICs9IGNoOwogICAgfQogICAgaWYgKGNlbGwgfHwgcm93Lmxlbmd0aCkgewogICAgICByb3cucHVzaChjZWxsKTsKICAgICAgcm93cy5wdXNoKHJvdyk7CiAgICB9CiAgICByZXR1cm4gcm93czsKICB9CgogIC8vIOyVjOumvOycvOuhnCDsnbTrr7gg65Ok7Ja07JioIOuCtOyXreyduOyngDog7KCV7ZmV7Z6IIOqwmeqxsOuCmCwg6rCZ7J2AIOuCoMK36rCZ7J2AIOq4iOyVocK36rCZ7J2AIOyiheulmOydtOuptOyEnCDsgqzsmqnsspjqsIAg6rK57LmY6rGw64KYIOqwmeydgCDqs4TsoowKICBmdW5jdGlvbiBmaW5kRHVwbGljYXRlKGl0ZW0sIHRyYW5zYWN0aW9ucykgewogICAgY29uc3QgbWVtbyA9IG5vcm1hbGl6ZU1lcmNoYW50KGl0ZW0ubWVtbyk7CiAgICByZXR1cm4gdHJhbnNhY3Rpb25zLmZpbmQoKHQpID0+IHsKICAgICAgaWYgKHQuZGF0ZSAhPT0gaXRlbS5kYXRlIHx8IE1hdGguYWJzKHQuYW1vdW50KSAhPT0gTWF0aC5hYnMoaXRlbS5hbW91bnQpKSByZXR1cm4gZmFsc2U7CiAgICAgIGlmIChraW5kT2YodCkgIT09IGtpbmRPZihpdGVtKSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCB0bSA9IG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbyk7CiAgICAgIGlmICh0bSA9PT0gbWVtbyB8fCAodG0gJiYgbWVtbyAmJiAodG0uaW5jbHVkZXMobWVtbykgfHwgbWVtby5pbmNsdWRlcyh0bSkpKSkgcmV0dXJuIHRydWU7CiAgICAgIHJldHVybiAhIShpdGVtLmFjY291bnRJZCAmJiB0LmFjY291bnRJZCA9PT0gaXRlbS5hY2NvdW50SWQpOwogICAgfSkgfHwgbnVsbDsKICB9CgogIC8vIC0tLS0tLS0tLS0g66as7Y+s7Yq4IC0tLS0tLS0tLS0KCiAgLy8g7ZWt66qp67OEIOyngOy2nCAo66eO7J20IOyTtCDsiJwpLiDsg4nsnYAg6rOE7ZqNIOyViOydmCDsiJzshJwoY29sb3JJbmRleCnroZwg7KCV7ZW0IOyInOychOqwgCDrsJTrgIzslrTrj4Qg6rCZ7J2AIO2VreuqqeydgCDqsJnsnYAg7IOJLgogIGZ1bmN0aW9uIGNhdGVnb3J5QnJlYWtkb3duKHN1bW1hcnkpIHsKICAgIGNvbnN0IHJvd3MgPSBzdW1tYXJ5LnJvd3MubWFwKChyLCBpKSA9PiAoeyBpZDogci5jYXRlZ29yeS5pZCwgbmFtZTogci5jYXRlZ29yeS5uYW1lLCBhbW91bnQ6IHIuc3BlbnQsIGNvdW50OiByLmNvdW50LCBjb2xvckluZGV4OiBpIH0pKTsKICAgIGlmIChzdW1tYXJ5LnVuY2xhc3NpZmllZCkgcm93cy5wdXNoKHsgaWQ6ICdfX25vbmUnLCBuYW1lOiAn66+467aE66WYJywgYW1vdW50OiBzdW1tYXJ5LnVuY2xhc3NpZmllZCwgY291bnQ6IHN1bW1hcnkudW5jbGFzc2lmaWVkQ291bnQsIGNvbG9ySW5kZXg6IC0xIH0pOwogICAgY29uc3QgdG90YWwgPSByb3dzLnJlZHVjZSgocywgcikgPT4gcyArIE1hdGgubWF4KDAsIHIuYW1vdW50KSwgMCk7CiAgICByZXR1cm4gcm93cwogICAgICAuZmlsdGVyKChyKSA9PiByLmFtb3VudCA+IDApCiAgICAgIC5tYXAoKHIpID0+ICh7IC4uLnIsIHNoYXJlOiB0b3RhbCA/IHIuYW1vdW50IC8gdG90YWwgOiAwIH0pKQogICAgICAuc29ydCgoYSwgYikgPT4gYi5hbW91bnQgLSBhLmFtb3VudCk7CiAgfQoKICAvLyDsnbTrsogg6riw6rCE6rO8IOyngeyghCDquLDqsITsnZgg7ZWt66qp67OEIOu5hOq1kCAo7J2067KIIOq4sOqwhCDqs4Ttmo3snZgg7ZWt66qpIOq4sOykgCwg6rCZ7J2AIGlkIOuBvOumrCkKICBmdW5jdGlvbiBjb21wYXJlV2l0aFByZXZpb3VzKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IGN1ciA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcGVyaW9kKTsKICAgIGNvbnN0IHByZXZQZXJpb2QgPSBzaGlmdFBlcmlvZChwZXJpb2QsIC0xLCBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSk7CiAgICBjb25zdCBwcmV2ID0gc3VtbWFyaXplUGVyaW9kKHN0YXRlLCBwcmV2UGVyaW9kKTsKICAgIGNvbnN0IHByZXZTcGVudCA9IHt9OwogICAgZm9yIChjb25zdCByIG9mIHByZXYucm93cykgcHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdID0gci5zcGVudDsKICAgIGNvbnN0IHJvd3MgPSBjdXIucm93cy5tYXAoKHIpID0+ICh7CiAgICAgIGlkOiByLmNhdGVnb3J5LmlkLAogICAgICBuYW1lOiByLmNhdGVnb3J5Lm5hbWUsCiAgICAgIGN1cnJlbnQ6IHIuc3BlbnQsCiAgICAgIHByZXZpb3VzOiBwcmV2U3BlbnRbci5jYXRlZ29yeS5pZF0gfHwgMCwKICAgICAgZGlmZjogci5zcGVudCAtIChwcmV2U3BlbnRbci5jYXRlZ29yeS5pZF0gfHwgMCksCiAgICB9KSk7CiAgICByZXR1cm4geyBjdXJyZW50OiBjdXIsIHByZXZpb3VzOiBwcmV2LCByb3dzLCB0b3RhbERpZmY6IGN1ci50b3RhbFNwZW50IC0gcHJldi50b3RhbFNwZW50IH07CiAgfQoKICBmdW5jdGlvbiB0b3BNZXJjaGFudHModHhzLCBuID0gNSkgewogICAgY29uc3QgbWFwID0ge307CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7CiAgICAgIGlmIChraW5kT2YodCkgIT09ICdleHBlbnNlJykgY29udGludWU7CiAgICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbyk7CiAgICAgIGNvbnN0IG0gPSAobWFwW2tleV0gPSBtYXBba2V5XSB8fCB7IG1lbW86IHQubWVtbywgdG90YWw6IDAsIGNvdW50OiAwIH0pOwogICAgICBtLnRvdGFsICs9IHQuYW1vdW50OwogICAgICBtLmNvdW50ICs9IDE7CiAgICB9CiAgICByZXR1cm4gT2JqZWN0LnZhbHVlcyhtYXApLnNvcnQoKGEsIGIpID0+IGIudG90YWwgLSBhLnRvdGFsKS5zbGljZSgwLCBuKTsKICB9CgogIC8vIOy1nOq3vCBuIOqwnCDquLDqsIQgKOyYpOuemOuQnCDqsoPrtoDthLApOiDsmIjsgrDsnLzroZwg7J6F66Cl7ZWcIOyImOyehSwg7Iuk7KCcIOyeheq4iCwg7KeA7LacCiAgZnVuY3Rpb24gdHJlbmQoc3RhdGUsIHBlcmlvZCwgbiA9IDYpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChsZXQgaSA9IG4gLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gc2hpZnRQZXJpb2QocGVyaW9kLCAtaSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICBjb25zdCBzID0gc3VtbWFyaXplUGVyaW9kKHN0YXRlLCBwKTsKICAgICAgb3V0LnB1c2goeyBwZXJpb2Q6IHAsIGJ1ZGdldEluY29tZTogcy5oYXNJbmNvbWUgPyBzLmluY29tZSA6IG51bGwsIGluY29tZVJlY2VpdmVkOiBzLmluY29tZVJlY2VpdmVkLCBzcGVudDogcy50b3RhbFNwZW50IH0pOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOuCoOynnOuzhCDtlanqs4Q6IHsgJ1lZWVktTU0tREQnOiB7IHNwZW50LCBpbmNvbWUsIGNvdW50IH0gfQogIGZ1bmN0aW9uIGRhaWx5VG90YWxzKHR4cykgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7CiAgICAgIGNvbnN0IGQgPSAob3V0W3QuZGF0ZV0gPSBvdXRbdC5kYXRlXSB8fCB7IHNwZW50OiAwLCBpbmNvbWU6IDAsIGNvdW50OiAwIH0pOwogICAgICBjb25zdCBrID0ga2luZE9mKHQpOwogICAgICBpZiAoayA9PT0gJ2V4cGVuc2UnKSBkLnNwZW50ICs9IHQuYW1vdW50OwogICAgICBlbHNlIGlmIChrID09PSAnaW5jb21lJykgZC5pbmNvbWUgKz0gdC5hbW91bnQ7CiAgICAgIGQuY291bnQgKz0gMTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDsnpDsgrA6IOqzhOyijCDsnpTslaEg7ZWp6rOELCDsubTrk5zrs4Qg7J2067KIIOq4sOqwhCDsgqzsmqnslaEKICBmdW5jdGlvbiBhc3NldFN1bW1hcnkoc3RhdGUsIHBlcmlvZCkgewogICAgY29uc3QgdHhzID0gdHhzSW5QZXJpb2Qoc3RhdGUsIHBlcmlvZCk7CiAgICBjb25zdCBiYW5rcyA9IHN0YXRlLmFjY291bnRzLmZpbHRlcigoYSkgPT4gYS50eXBlICE9PSAnY2FyZCcpOwogICAgY29uc3QgY2FyZHMgPSBzdGF0ZS5hY2NvdW50cy5maWx0ZXIoKGEpID0+IGEudHlwZSA9PT0gJ2NhcmQnKTsKICAgIGNvbnN0IHRvdGFsID0gYmFua3MucmVkdWNlKChzLCBhKSA9PiBzICsgKHR5cGVvZiBhLmJhbGFuY2UgPT09ICdudW1iZXInID8gYS5iYWxhbmNlIDogMCksIDApOwogICAgY29uc3Qgc2F2aW5ncyA9IGJhbmtzLmZpbHRlcigoYSkgPT4gYS5pc1NhdmluZ3MpLnJlZHVjZSgocywgYSkgPT4gcyArICh0eXBlb2YgYS5iYWxhbmNlID09PSAnbnVtYmVyJyA/IGEuYmFsYW5jZSA6IDApLCAwKTsKICAgIGNvbnN0IHNwZW5kQnkgPSB7fTsKICAgIGZvciAoY29uc3QgdCBvZiB0eHMpIGlmIChraW5kT2YodCkgPT09ICdleHBlbnNlJyAmJiB0LmFjY291bnRJZCkgc3BlbmRCeVt0LmFjY291bnRJZF0gPSAoc3BlbmRCeVt0LmFjY291bnRJZF0gfHwgMCkgKyB0LmFtb3VudDsKICAgIHJldHVybiB7CiAgICAgIHRvdGFsLAogICAgICBzYXZpbmdzLAogICAgICBiYW5rczogYmFua3MubWFwKChhKSA9PiAoeyAuLi5hLCBzcGVudDogc3BlbmRCeVthLmlkXSB8fCAwIH0pKSwKICAgICAgY2FyZHM6IGNhcmRzLm1hcCgoYSkgPT4gKHsgLi4uYSwgc3BlbnQ6IHNwZW5kQnlbYS5pZF0gfHwgMCB9KSksCiAgICAgIHVubGlua2VkU3BlbnQ6IHR4cy5maWx0ZXIoKHQpID0+IGtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnICYmICF0LmFjY291bnRJZCkucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6riw67O4IOuNsOydtO2EsCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIGRlZmF1bHRDYXRlZ29yaWVzKCkgewogICAgcmV0dXJuIFsKICAgICAgeyBpZDogJ2MtaG91c2UnLCBuYW1lOiAn7KO86rGwL+q0gOumrOu5hCcsIHR5cGU6ICdmaXhlZCcsIHZhbHVlOiA1MDAwMDAsIGRlc2NyaXB0aW9uOiAn7JuU7IS4LCDqtIDrpqzruYQsIOyghOq4sMK36rCA7IqkwrfsiJjrj4Qg7JqU6riIJywga2V5d29yZHM6IFsn7JuU7IS4JywgJ+q0gOumrOu5hCcsICfsoITquLDsmpTquIgnLCAn64+E7Iuc6rCA7IqkJywgJ+yImOuPhOyalOq4iCddIH0sCiAgICAgIHsgaWQ6ICdjLXBob25lJywgbmFtZTogJ+2GteyLoC/qtazrj4UnLCB0eXBlOiAnZml4ZWQnLCB2YWx1ZTogODAwMDAsIGRlc2NyaXB0aW9uOiAn7Zy064yA7Y+wIOyalOq4iCwg7J247YSw64S3LCBPVFTCt+ydjOyVhSDrk7Eg7KCV6riwIOq1rOuPhScsIGtleXdvcmRzOiBbJ1NLVCcsICdLVCcsICdMRyBVKycsICfthrXsi6AnLCAn64S37ZSM66at7IqkJywgJ+ycoO2KnOu4jCcsICfrqZzroaAnLCAn7L+g7Yyh7JmA7JqwJywgJ+uUlOymiOuLiCddIH0sCiAgICAgIHsgaWQ6ICdjLWZvb2QnLCBuYW1lOiAn7Iud67mEJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDMwLCBkZXNjcmlwdGlvbjogJ+yLneuLuSwg67Cw64usLCDsnqXrs7TquLAsIO2OuOydmOygkCDsnYzsi50nLCBrZXl3b3JkczogWyfsi53ri7knLCAn67Cw64us7J2Y66+87KGxJywgJ+uwsOuvvCcsICfsmpTquLDsmpQnLCAn7L+g7Yyh7J207LigJywgJ+ydtOuniO2KuCcsICftmYjtlIzrn6zsiqQnLCAn66Gv642w66eI7Yq4JywgJ+uniO2KuCcsICftjrjsnZjsoJAnLCAnR1MyNScsICdDVScsICfshLjruJDsnbzroIjruJAnLCAn6rmA67ClJywgJ+y5mO2CqCddIH0sCiAgICAgIHsgaWQ6ICdjLWNhZmUnLCBuYW1lOiAn7Lm07Y6YL+qwhOyLnScsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA1LCBkZXNjcmlwdGlvbjogJ+y7pO2UvCwg7J2M66OMLCDrubUsIOuUlOyggO2KuCcsIGtleXdvcmRzOiBbJ+yKpO2DgOuyheyKpCcsICftiKzsjbgnLCAn7J2065SU7JW8JywgJ+uplOqwgOy7pO2UvCcsICfrqZTqsIBNR0MnLCAn7Lu07Y+s7KaIJywgJ+u5veuLpOuwqScsICfsubTtjpgnLCAn7YyM66as67CU6rKM65yoJywgJ+uanOugiOylrOultCcsICfrsqDsnbTsu6TrpqwnXSB9LAogICAgICB7IGlkOiAnYy1tb3ZlJywgbmFtZTogJ+q1kO2GtScsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA3LCBkZXNjcmlwdGlvbjogJ+uMgOykkeq1kO2GtSwg7YOd7IucLCDquLDssKgsIOyjvOycoCwg7KO87LCoJywga2V5d29yZHM6IFsn7YOd7IucJywgJ+y5tOy5tOyYpFQnLCAn67KE7IqkJywgJ+yngO2VmOyyoCcsICfti7DrqLjri4gnLCAn7L2U66CI7J28JywgJ1NSVCcsICfso7zsnKAnLCAn7KO87LCoJ10gfSwKICAgICAgeyBpZDogJ2Mtc2hvcCcsIG5hbWU6ICfsh7ztlZEnLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogMTAsIGRlc2NyaXB0aW9uOiAn7Jio65287J24IOyHvO2VkSwg7Ji3LCDsg53tmZzsmqntkogsIO2ZlOyepe2SiCcsIGtleXdvcmRzOiBbJ+y/oO2MoScsICcxMeuyiOqwgCcsICdH66eI7LyTJywgJ+ustOyLoOyCrCcsICfsmKzrpqzruIzsmIEnLCAn64uk7J207IaMJywgJ+uEpOydtOuyhO2OmOydtCddIH0sCiAgICAgIHsgaWQ6ICdjLWZ1bicsIG5hbWU6ICfrrLjtmZQv7Jes6rCAJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDgsIGRlc2NyaXB0aW9uOiAn7JiB7ZmULCDqs7Xsl7AsIOyxhSwg7Leo66+4LCDsl6ztloknLCBrZXl3b3JkczogWydDR1YnLCAn66mU6rCA67CV7IqkJywgJ+uhr+uNsOyLnOuEpOuniCcsICfqtZDrs7TrrLjqs6AnLCAnWUVTMjQnLCAn7JWM652865SYJ10gfSwKICAgICAgeyBpZDogJ2Mtc2F2ZScsIG5hbWU6ICfsoIDstpUv7Yis7J6QJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDQwLCBkZXNjcmlwdGlvbjogJ+yggeq4iCwg7KCA7LaVIOydtOyytCwg7Kad6raMIOqzhOyijCDsnoXquIgsIOyyreyVvScsIGtleXdvcmRzOiBbJ+yggeq4iCcsICfsoIDstpUnLCAn7Kad6raMJywgJ+yyreyVvSddIH0sCiAgICBdOwogIH0KCiAgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKCkgewogICAgcmV0dXJuIHsKICAgICAgdmVyc2lvbjogMiwKICAgICAgc2V0dGluZ3M6IHsgc3RhcnREYXk6IDEsIG15TmFtZTogJycgfSwKICAgICAgcGxhbnM6IFt7IGZyb206IEJBU0VfUExBTl9GUk9NLCByYXRpb0Jhc2U6ICdhZnRlckZpeGVkJywgY2F0ZWdvcmllczogZGVmYXVsdENhdGVnb3JpZXMoKSwgdXBkYXRlZEF0OiAnJyB9XSwKICAgICAgYWNjb3VudHM6IFtdLAogICAgICBpbmNvbWVzOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBbXSwKICAgICAgbWVyY2hhbnRNYXA6IHt9LAogICAgfTsKICB9CgogIC8vIOyggOyepeuQnCDrjbDsnbTthLDrpbwg7ZiE7J6sIOq1rOyhsOuhnCDrp57stpjri6QuICh2MTog6rOE7ZqN7J20IO2VmOuCmOu/kOydtOuNmCDqtazsobAg4oaSIHYyOiDquLDqsITrs4Qg6rOE7ZqNKQogIGZ1bmN0aW9uIG5vcm1hbGl6ZVN0YXRlKHJhdykgewogICAgY29uc3QgYmFzZSA9IGRlZmF1bHRTdGF0ZSgpOwogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBiYXNlOwogICAgY29uc3Qgc2V0dGluZ3MgPSByYXcuc2V0dGluZ3MgfHwge307CiAgICBjb25zdCBzdGFydERheSA9IE1hdGgubWluKDMxLCBNYXRoLm1heCgxLCBOdW1iZXIoc2V0dGluZ3Muc3RhcnREYXkpIHx8IDEpKTsKCiAgICBsZXQgcGxhbnM7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyYXcucGxhbnMpICYmIHJhdy5wbGFucy5sZW5ndGgpIHsKICAgICAgcGxhbnMgPSByYXcucGxhbnM7CiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocmF3LmNhdGVnb3JpZXMpKSB7CiAgICAgIHBsYW5zID0gW3sgZnJvbTogQkFTRV9QTEFOX0ZST00sIHJhdGlvQmFzZTogc2V0dGluZ3MucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLCBjYXRlZ29yaWVzOiByYXcuY2F0ZWdvcmllcywgdXBkYXRlZEF0OiAnJyB9XTsKICAgIH0gZWxzZSB7CiAgICAgIHBsYW5zID0gYmFzZS5wbGFuczsKICAgIH0KICAgIHBsYW5zID0gcGxhbnMKICAgICAgLm1hcCgocCkgPT4gKHsKICAgICAgICBmcm9tOiBTdHJpbmcocC5mcm9tIHx8IEJBU0VfUExBTl9GUk9NKSwKICAgICAgICByYXRpb0Jhc2U6IHAucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLAogICAgICAgIGNhdGVnb3JpZXM6IEFycmF5LmlzQXJyYXkocC5jYXRlZ29yaWVzKSA/IHAuY2F0ZWdvcmllcyA6IFtdLAogICAgICAgIHVwZGF0ZWRBdDogU3RyaW5nKHAudXBkYXRlZEF0IHx8ICcnKSwKICAgICAgfSkpCiAgICAgIC5zb3J0KChhLCBiKSA9PiAoYS5mcm9tIDwgYi5mcm9tID8gLTEgOiBhLmZyb20gPiBiLmZyb20gPyAxIDogMCkpOwoKICAgIGNvbnN0IGFjY291bnRzID0gKEFycmF5LmlzQXJyYXkocmF3LmFjY291bnRzKSA/IHJhdy5hY2NvdW50cyA6IFtdKS5tYXAoKGEpID0+ICh7CiAgICAgIGlkOiBTdHJpbmcoYS5pZCksCiAgICAgIG5hbWU6IFN0cmluZyhhLm5hbWUgfHwgJycpLAogICAgICB0eXBlOiBhLnR5cGUgPT09ICdjYXJkJyA/ICdjYXJkJyA6ICdiYW5rJywKICAgICAgbGFzdDQ6IGRpZ2l0c09ubHkoYS5sYXN0NCkuc2xpY2UoLTQpLAogICAgICBpc1NhdmluZ3M6ICEhYS5pc1NhdmluZ3MsCiAgICAgIGJhbGFuY2U6IHR5cGVvZiBhLmJhbGFuY2UgPT09ICdudW1iZXInID8gYS5iYWxhbmNlIDogbnVsbCwKICAgICAgYmFsYW5jZUF0OiBTdHJpbmcoYS5iYWxhbmNlQXQgfHwgJycpLAogICAgfSkpOwoKICAgIHJldHVybiB7CiAgICAgIHZlcnNpb246IDIsCiAgICAgIHNldHRpbmdzOiB7IHN0YXJ0RGF5LCBteU5hbWU6IFN0cmluZyhzZXR0aW5ncy5teU5hbWUgfHwgJycpIH0sCiAgICAgIHBsYW5zLAogICAgICBhY2NvdW50cywKICAgICAgaW5jb21lczogcmF3LmluY29tZXMgJiYgdHlwZW9mIHJhdy5pbmNvbWVzID09PSAnb2JqZWN0JyA/IHJhdy5pbmNvbWVzIDoge30sCiAgICAgIHRyYW5zYWN0aW9uczogQXJyYXkuaXNBcnJheShyYXcudHJhbnNhY3Rpb25zKSA/IHJhdy50cmFuc2FjdGlvbnMgOiBbXSwKICAgICAgbWVyY2hhbnRNYXA6IHJhdy5tZXJjaGFudE1hcCAmJiB0eXBlb2YgcmF3Lm1lcmNoYW50TWFwID09PSAnb2JqZWN0JyA/IHJhdy5tZXJjaGFudE1hcCA6IHt9LAogICAgfTsKICB9CgogIHJldHVybiB7CiAgICB0b0lTTywKICAgIHBhcnNlSVNPLAogICAgYWRkRGF5cywKICAgIGRpZmZEYXlzLAogICAgdG9kYXlJU08sCiAgICBkYXlzSW5Nb250aCwKICAgIGdldFBlcmlvZCwKICAgIHNoaWZ0UGVyaW9kLAogICAgY29tcHV0ZUJ1ZGdldHMsCiAgICBzdW1tYXJpemVQZXJpb2QsCiAgICBzdGF0dXNPZiwKICAgIG5vcm1hbGl6ZU1lcmNoYW50LAogICAgY2xhc3NpZnksCiAgICBjbGFzc2lmeUxvY2FsLAogICAgcGFyc2VFeHBlbnNlVGV4dCwKICAgIGtpbmRPZiwKICAgIGxvb2tzTGlrZVRyYW5zYWN0aW9uLAogICAgbWF0Y2hBY2NvdW50LAogICAgcGFyc2VNZXNzYWdlRmFsbGJhY2ssCiAgICBpc0R1cGxpY2F0ZSwKICAgIEJBU0VfUExBTl9GUk9NLAogICAgcGxhbkZvciwKICAgIGVuc3VyZVBsYW5Gb3IsCiAgICBuZXh0UGxhbkFmdGVyLAogICAgcmVtYXBQZXJpb2RLZXlzLAogICAgYnVpbGRDbGFzc2lmeVJlcXVlc3QsCiAgICByZWFkQ2xhc3NpZnlSZXNwb25zZSwKICAgIGJ1aWxkTWVzc2FnZVJlcXVlc3QsCiAgICByZWFkTWVzc2FnZVJlc3BvbnNlLAogICAgcGFyc2VTdGF0ZW1lbnRSb3dzLAogICAgcGFyc2VDU1YsCiAgICBmaW5kRHVwbGljYXRlLAogICAgY2F0ZWdvcnlCcmVha2Rvd24sCiAgICBjb21wYXJlV2l0aFByZXZpb3VzLAogICAgdG9wTWVyY2hhbnRzLAogICAgdHJlbmQsCiAgICBkYWlseVRvdGFscywKICAgIGFzc2V0U3VtbWFyeSwKICAgIGRlZmF1bHRTdGF0ZSwKICAgIG5vcm1hbGl6ZVN0YXRlLAogIH07Cn0pOwo=\");</script>\n  <script>__budgetRun(\"js/charts.js\", \"Lyog7LCo7Yq4IChTVkcg66y47J6Q7Je07J2EIOunjOuToOuLpCkuIOyDieydgCBjc3Mg67OA7IiYIC0tczEgfiAtLXM3ICjtla3rqqkg7Iic7ISc64yA66GcIOqzoOyglSksIOq3uCDrsJbsnYAg7ZqM7IOJLiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IFNMT1RTID0gNzsKCiAgZnVuY3Rpb24gc2VyaWVzQ29sb3IoY29sb3JJbmRleCkgewogICAgcmV0dXJuIGNvbG9ySW5kZXggPj0gMCAmJiBjb2xvckluZGV4IDwgU0xPVFMgPyBgdmFyKC0tcyR7Y29sb3JJbmRleCArIDF9KWAgOiAndmFyKC0tZ3JheS1tYXJrKSc7CiAgfQoKICAvLyAxMiwzNDAsMDAwIOKGkiAiMSwyMzTrp4wiLCAx7Ja1IOydtOyDgeydgCAiMS4y7Ja1IgogIGZ1bmN0aW9uIHNob3J0V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHNpZ24gPSBuIDwgMCA/ICctJyA6ICcnOwogICAgaWYgKGEgPj0gMWU4KSByZXR1cm4gYCR7c2lnbn0keyhhIC8gMWU4KS50b0ZpeGVkKGEgPj0gMWU5ID8gMCA6IDEpLnJlcGxhY2UoL1wuMCQvLCAnJyl97Ja1YDsKICAgIGlmIChhID49IDFlNCkgcmV0dXJuIGAke3NpZ259JHtNYXRoLnJvdW5kKGEgLyAxZTQpLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeunjGA7CiAgICByZXR1cm4gYCR7c2lnbn0ke01hdGgucm91bmQoYSkudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyl9YDsKICB9CgogIC8vIOuLrOugpeyymOufvCDsooHsnYAg7Lm47JqpOiA2LDIwMCDihpIgIjYuMuyynCIsIDEyLDQwMCDihpIgIjEuMuunjCIsIDUxMiwwMDAg4oaSICI1MeunjCIKICBmdW5jdGlvbiB0aW55V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHRyaW0gPSAoeCkgPT4geC50b0ZpeGVkKDEpLnJlcGxhY2UoL1wuMCQvLCAnJyk7CiAgICBpZiAoYSA+PSAxZTgpIHJldHVybiBgJHt0cmltKGEgLyAxZTgpfeyWtWA7CiAgICBpZiAoYSA+PSAxZTUpIHJldHVybiBgJHtNYXRoLnJvdW5kKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTQpIHJldHVybiBgJHt0cmltKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTMpIHJldHVybiBgJHt0cmltKGEgLyAxZTMpfeyynGA7CiAgICByZXR1cm4gU3RyaW5nKE1hdGgucm91bmQoYSkpOwogIH0KCiAgZnVuY3Rpb24gbmljZU1heCh2KSB7CiAgICBpZiAodiA8PSAwKSByZXR1cm4gMTAwMDA7CiAgICBjb25zdCBwID0gTWF0aC5wb3coMTAsIE1hdGguZmxvb3IoTWF0aC5sb2cxMCh2KSkpOwogICAgZm9yIChjb25zdCBtIG9mIFsxLCAyLCAyLjUsIDUsIDEwXSkgaWYgKG0gKiBwID49IHYpIHJldHVybiBtICogcDsKICAgIHJldHVybiAxMCAqIHA7CiAgfQoKICAvLyDqtazshLEg66eJ64yAOiByb3dzID0gW3tuYW1lLCBhbW91bnQsIGNvbG9ySW5kZXh9XSAo66eO7J20IOyTtCDsiJwpLiA467KI7Ke4IOyDieu2gO2EsOuKlCAi6riw7YOAIuuhnCDtlansuZzri6QuCiAgZnVuY3Rpb24gc2hhcmVTZWdtZW50cyhyb3dzKSB7CiAgICBjb25zdCBtYWluID0gcm93cy5maWx0ZXIoKHIpID0+IHIuY29sb3JJbmRleCA+PSAwICYmIHIuY29sb3JJbmRleCA8IFNMT1RTKTsKICAgIGNvbnN0IHJlc3QgPSByb3dzLmZpbHRlcigocikgPT4gIShyLmNvbG9ySW5kZXggPj0gMCAmJiByLmNvbG9ySW5kZXggPCBTTE9UUykpOwogICAgY29uc3Qgc2VncyA9IG1haW4ubWFwKChyKSA9PiAoeyBuYW1lOiByLm5hbWUsIGFtb3VudDogci5hbW91bnQsIGNvbG9yOiBzZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpIH0pKTsKICAgIGNvbnN0IHJlc3RTdW0gPSByZXN0LnJlZHVjZSgocywgcikgPT4gcyArIHIuYW1vdW50LCAwKTsKICAgIGlmIChyZXN0U3VtID4gMCkgc2Vncy5wdXNoKHsgbmFtZTogcmVzdC5sZW5ndGggPT09IDEgPyByZXN0WzBdLm5hbWUgOiAn6riw7YOAJywgYW1vdW50OiByZXN0U3VtLCBjb2xvcjogc2VyaWVzQ29sb3IoLTEpIH0pOwogICAgcmV0dXJuIHNlZ3M7CiAgfQoKICBmdW5jdGlvbiBzaGFyZUJhcihyb3dzKSB7CiAgICBjb25zdCBzZWdzID0gc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgIGNvbnN0IHRvdGFsID0gc2Vncy5yZWR1Y2UoKHMsIHIpID0+IHMgKyByLmFtb3VudCwgMCkgfHwgMTsKICAgIHJldHVybiBgPGRpdiBjbGFzcz0ic2hhcmUtYmFyIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iu2VreuqqeuzhCDsp4Dstpwg6rWs7ISxIj4ke3NlZ3MKICAgICAgLm1hcCgocywgaSkgPT4gYDxzcGFuIGRhdGEtc2VnPSIke2l9IiBzdHlsZT0iZmxleDoke3MuYW1vdW50IC8gdG90YWx9O2JhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPmApCiAgICAgIC5qb2luKCcnKX08L2Rpdj5gOwogIH0KCiAgLyoKICAgKiDquLDqsITrs4Qg7LaU7J20OiDquLDqsITrp4jri6QgW+yImOyehSwg7KeA7LacXSDrkZAg66eJ64yALiBkYXRhID0gW3tsYWJlbCwgaW5jb21lLCBzcGVudH1dCiAgICog66eJ64yAIOyCrOydtCAycHgg6rCE6rKpLCDsnJfrtoDrtoQgNHB4IOuRpeq4gOqyjCwg67CU64ul7J2AIOq4sOykgOyEoOyXkCDrtpnsnoQuCiAgICovCiAgZnVuY3Rpb24gdHJlbmRDaGFydChkYXRhLCB7IHdpZHRoID0gNjQwLCBoZWlnaHQgPSAyMjAgfSA9IHt9KSB7CiAgICBjb25zdCBwYWQgPSB7IHRvcDogMTIsIHJpZ2h0OiA4LCBib3R0b206IDI2LCBsZWZ0OiA0NCB9OwogICAgY29uc3QgdyA9IHdpZHRoIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgICBjb25zdCBoID0gaGVpZ2h0IC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgICBjb25zdCBtYXggPSBuaWNlTWF4KE1hdGgubWF4KDEsIC4uLmRhdGEubWFwKChkKSA9PiBNYXRoLm1heChkLmluY29tZSB8fCAwLCBkLnNwZW50IHx8IDApKSkpOwogICAgY29uc3QgeSA9ICh2KSA9PiBwYWQudG9wICsgaCAtIChNYXRoLm1heCgwLCB2KSAvIG1heCkgKiBoOwogICAgY29uc3QgYmFuZCA9IHcgLyBkYXRhLmxlbmd0aDsKICAgIGNvbnN0IGJhclcgPSBNYXRoLm1pbigyNiwgKGJhbmQgLSAxOCkgLyAyKTsKICAgIGNvbnN0IGdhcCA9IDI7CiAgICBjb25zdCBwYXJ0cyA9IFtdOwoKICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDQ7IGkrKykgewogICAgICBjb25zdCB2ID0gKG1heCAvIDQpICogaTsKICAgICAgY29uc3QgeXkgPSB5KHYpOwogICAgICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz0iZ3JpZC1saW5lIiB4MT0iJHtwYWQubGVmdH0iIHgyPSIke3dpZHRoIC0gcGFkLnJpZ2h0fSIgeTE9IiR7eXl9IiB5Mj0iJHt5eX0iLz5gKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7cGFkLmxlZnQgLSA2fSIgeT0iJHt5eSArIDR9IiB0ZXh0LWFuY2hvcj0iZW5kIj4ke3Nob3J0V29uKHYpfTwvdGV4dD5gKTsKICAgIH0KCiAgICBjb25zdCBiYXIgPSAoeCwgdiwgY29sb3IpID0+IHsKICAgICAgaWYgKCF2IHx8IHYgPD0gMCkgcmV0dXJuICcnOwogICAgICBjb25zdCB0b3AgPSB5KHYpOwogICAgICBjb25zdCBiaCA9IHBhZC50b3AgKyBoIC0gdG9wOwogICAgICBjb25zdCByID0gTWF0aC5taW4oNCwgYmgpOwogICAgICAvLyDsnITsqr0g66qo7ISc66as66eMIOuRpeq3vCDrp4nrjIAKICAgICAgcmV0dXJuIGA8cGF0aCBmaWxsPSIke2NvbG9yfSIgZD0iTSR7eH0sJHtwYWQudG9wICsgaH0gViR7dG9wICsgcn0gUSR7eH0sJHt0b3B9ICR7eCArIHJ9LCR7dG9wfSBIJHt4ICsgYmFyVyAtIHJ9IFEke3ggKyBiYXJXfSwke3RvcH0gJHt4ICsgYmFyV30sJHt0b3AgKyByfSBWJHtwYWQudG9wICsgaH0gWiIvPmA7CiAgICB9OwoKICAgIGRhdGEuZm9yRWFjaCgoZCwgaSkgPT4gewogICAgICBjb25zdCBjeCA9IHBhZC5sZWZ0ICsgYmFuZCAqIGkgKyBiYW5kIC8gMjsKICAgICAgcGFydHMucHVzaChiYXIoY3ggLSBiYXJXIC0gZ2FwIC8gMiwgZC5pbmNvbWUsICd2YXIoLS1zMSknKSk7CiAgICAgIHBhcnRzLnB1c2goYmFyKGN4ICsgZ2FwIC8gMiwgZC5zcGVudCwgJ3ZhcigtLXMyKScpKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7Y3h9IiB5PSIke2hlaWdodCAtIDh9IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj4ke2QubGFiZWx9PC90ZXh0PmApOwogICAgICBwYXJ0cy5wdXNoKGA8cmVjdCBjbGFzcz0iaGl0IiBkYXRhLWk9IiR7aX0iIHg9IiR7cGFkLmxlZnQgKyBiYW5kICogaX0iIHk9IiR7cGFkLnRvcH0iIHdpZHRoPSIke2JhbmR9IiBoZWlnaHQ9IiR7aH0iLz5gKTsKICAgIH0pOwoKICAgIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3aWR0aH0gJHtoZWlnaHR9IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iuq4sOqwhOuzhCDsiJjsnoXqs7wg7KeA7LacIj4ke3BhcnRzLmpvaW4oJycpfTwvc3ZnPmA7CiAgfQoKICByb290LkJ1ZGdldENoYXJ0cyA9IHsgc2VyaWVzQ29sb3IsIHNob3J0V29uLCB0aW55V29uLCBzaGFyZVNlZ21lbnRzLCBzaGFyZUJhciwgdHJlbmRDaGFydCB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/xlsx.js\", \"Lyog7JeR7IWAKC54bHN4KSDssqsg67KI7Ke4IOyLnO2KuOulvCAy7LCo7JuQIOuwsOyXtOuhnCDsnb3ripTri6QuIOyZuOu2gCDrnbzsnbTruIzrn6zrpqwg7JeG7J20IOu4jOudvOyasOyggCDquLDriqXrp4wg7JO064ukLgogKiAueGxzeCDripQgemlwIOyViOyXkCBYTUwg7J20IOuToCDtjIzsnbzsnbTrnbwsIHppcCDsnYQg7ZKA6rOgKERlY29tcHJlc3Npb25TdHJlYW0pIFhNTCDsnYQg7J2964qU64ukKERPTVBhcnNlcikuCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGZ1bmN0aW9uIGZhaWwoY29kZSwgbWVzc2FnZSkgewogICAgY29uc3QgZSA9IG5ldyBFcnJvcihtZXNzYWdlKTsKICAgIGUuY29kZSA9IGNvZGU7CiAgICByZXR1cm4gZTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGluZmxhdGVSYXcoYnl0ZXMpIHsKICAgIGlmICh0eXBlb2YgRGVjb21wcmVzc2lvblN0cmVhbSA9PT0gJ3VuZGVmaW5lZCcpIHsKICAgICAgdGhyb3cgZmFpbCgndW5zdXBwb3J0ZWQnLCAn7J20IOu4jOudvOyasOyggOuKlCDsl5HshYAg7YyM7J287J2EIO2SgCDsiJgg7JeG7Ja07JqULiDstZzsi6Ag7YGs66GswrfsgqztjIzrpqzrpbwg7JOw6rGw64KYLCDsl5HshYDsl5DshJwgQ1NWIOuhnCDsoIDsnqXtlbQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBCbG9iKFtieXRlc10pLnN0cmVhbSgpLnBpcGVUaHJvdWdoKG5ldyBEZWNvbXByZXNzaW9uU3RyZWFtKCdkZWZsYXRlLXJhdycpKTsKICAgIHJldHVybiBuZXcgVWludDhBcnJheShhd2FpdCBuZXcgUmVzcG9uc2Uoc3RyZWFtKS5hcnJheUJ1ZmZlcigpKTsKICB9CgogIC8vIHppcCDslYjsnZgg7YyM7J28IOuqqeuhnSDihpIgeyDsnbTrpoQ6IGFzeW5jICgpID0+IOuCtOyaqShVaW50OEFycmF5KSB9CiAgZnVuY3Rpb24gcmVhZFppcERpcmVjdG9yeShidWYpIHsKICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcoYnVmKTsKICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYnVmKTsKICAgIGxldCBlb2NkID0gLTE7CiAgICBmb3IgKGxldCBpID0gYnVmLmJ5dGVMZW5ndGggLSAyMjsgaSA+PSBNYXRoLm1heCgwLCBidWYuYnl0ZUxlbmd0aCAtIDY1NTU3KTsgaS0tKSB7CiAgICAgIGlmICh2aWV3LmdldFVpbnQzMihpLCB0cnVlKSA9PT0gMHgwNjA1NGI1MCkgewogICAgICAgIGVvY2QgPSBpOwogICAgICAgIGJyZWFrOwogICAgICB9CiAgICB9CiAgICBpZiAoZW9jZCA8IDApIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAg7YyM7J28IOq1rOyhsOulvCDsnb3sp4Ag66q77ZaI7Ja07JqULicpOwogICAgY29uc3QgY291bnQgPSB2aWV3LmdldFVpbnQxNihlb2NkICsgMTAsIHRydWUpOwogICAgbGV0IHAgPSB2aWV3LmdldFVpbnQzMihlb2NkICsgMTYsIHRydWUpOwogICAgY29uc3QgZmlsZXMgPSB7fTsKICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTsKICAgIGZvciAobGV0IG4gPSAwOyBuIDwgY291bnQ7IG4rKykgewogICAgICBpZiAodmlldy5nZXRVaW50MzIocCwgdHJ1ZSkgIT09IDB4MDIwMTRiNTApIGJyZWFrOwogICAgICBjb25zdCBtZXRob2QgPSB2aWV3LmdldFVpbnQxNihwICsgMTAsIHRydWUpOwogICAgICBjb25zdCBjb21wU2l6ZSA9IHZpZXcuZ2V0VWludDMyKHAgKyAyMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWVMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMjgsIHRydWUpOwogICAgICBjb25zdCBleHRyYUxlbiA9IHZpZXcuZ2V0VWludDE2KHAgKyAzMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGNvbW1lbnRMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMzIsIHRydWUpOwogICAgICBjb25zdCBsb2NhbCA9IHZpZXcuZ2V0VWludDMyKHAgKyA0MiwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVyLmRlY29kZShieXRlcy5zdWJhcnJheShwICsgNDYsIHAgKyA0NiArIG5hbWVMZW4pKTsKICAgICAgZmlsZXNbbmFtZV0gPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc3RhcnQgPSBsb2NhbCArIDMwICsgdmlldy5nZXRVaW50MTYobG9jYWwgKyAyNiwgdHJ1ZSkgKyB2aWV3LmdldFVpbnQxNihsb2NhbCArIDI4LCB0cnVlKTsKICAgICAgICBjb25zdCBkYXRhID0gYnl0ZXMuc3ViYXJyYXkoc3RhcnQsIHN0YXJ0ICsgY29tcFNpemUpOwogICAgICAgIGlmIChtZXRob2QgPT09IDApIHJldHVybiBkYXRhOwogICAgICAgIGlmIChtZXRob2QgPT09IDgpIHJldHVybiBpbmZsYXRlUmF3KGRhdGEpOwogICAgICAgIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsp4Dsm5DtlZjsp4Ag7JWK64qUIOyVley2lSDrsKnsi53snbTsl5DsmpQuJyk7CiAgICAgIH07CiAgICAgIHAgKz0gNDYgKyBuYW1lTGVuICsgZXh0cmFMZW4gKyBjb21tZW50TGVuOwogICAgfQogICAgcmV0dXJuIGZpbGVzOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFhtbChmaWxlcywgbmFtZSkgewogICAgaWYgKCFmaWxlc1tuYW1lXSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGF3YWl0IGZpbGVzW25hbWVdKCkpOwogICAgcmV0dXJuIG5ldyBET01QYXJzZXIoKS5wYXJzZUZyb21TdHJpbmcodGV4dCwgJ2FwcGxpY2F0aW9uL3htbCcpOwogIH0KCiAgY29uc3QgdGFncyA9IChub2RlLCBuYW1lKSA9PiBBcnJheS5mcm9tKG5vZGUuZ2V0RWxlbWVudHNCeVRhZ05hbWUobmFtZSkpOwoKICBmdW5jdGlvbiBjb2x1bW5JbmRleChyZWYpIHsKICAgIGNvbnN0IGxldHRlcnMgPSBTdHJpbmcocmVmIHx8ICcnKS5tYXRjaCgvXltBLVpdKy8pOwogICAgaWYgKCFsZXR0ZXJzKSByZXR1cm4gLTE7CiAgICBsZXQgbiA9IDA7CiAgICBmb3IgKGNvbnN0IGNoIG9mIGxldHRlcnNbMF0pIG4gPSBuICogMjYgKyAoY2guY2hhckNvZGVBdCgwKSAtIDY0KTsKICAgIHJldHVybiBuIC0gMTsKICB9CgogIC8vIOyyqyDrsojsp7gg7Iuc7Yq47J2YIOqyveuhnCAod29ya2Jvb2sueG1sIOydmCDssqsgc2hlZXQg4oaSIOq0gOqzhCDtjIzsnbzsl5DshJwg7Iuk7KCcIOqyveuhnCkKICBhc3luYyBmdW5jdGlvbiBmaXJzdFNoZWV0UGF0aChmaWxlcykgewogICAgY29uc3Qgd2IgPSBhd2FpdCByZWFkWG1sKGZpbGVzLCAneGwvd29ya2Jvb2sueG1sJyk7CiAgICBjb25zdCByZWxzID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzJyk7CiAgICBpZiAod2IgJiYgcmVscykgewogICAgICBjb25zdCBzaGVldCA9IHRhZ3Mod2IsICdzaGVldCcpWzBdOwogICAgICBjb25zdCByaWQgPSBzaGVldCAmJiAoc2hlZXQuZ2V0QXR0cmlidXRlKCdyOmlkJykgfHwgc2hlZXQuZ2V0QXR0cmlidXRlTlMoJ2h0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMnLCAnaWQnKSk7CiAgICAgIGNvbnN0IHJlbCA9IHRhZ3MocmVscywgJ1JlbGF0aW9uc2hpcCcpLmZpbmQoKHIpID0+IHIuZ2V0QXR0cmlidXRlKCdJZCcpID09PSByaWQpOwogICAgICBpZiAocmVsKSB7CiAgICAgICAgY29uc3QgdGFyZ2V0ID0gcmVsLmdldEF0dHJpYnV0ZSgnVGFyZ2V0JykucmVwbGFjZSgvXlwvLywgJycpOwogICAgICAgIHJldHVybiB0YXJnZXQuc3RhcnRzV2l0aCgneGwvJykgPyB0YXJnZXQgOiBgeGwvJHt0YXJnZXR9YDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIE9iamVjdC5rZXlzKGZpbGVzKS5maWx0ZXIoKG4pID0+IC9eeGxcL3dvcmtzaGVldHNcL3NoZWV0XGQrXC54bWwkLy50ZXN0KG4pKS5zb3J0KClbMF07CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkWGxzeChhcnJheUJ1ZmZlcikgewogICAgY29uc3QgaGVhZCA9IG5ldyBVaW50OEFycmF5KGFycmF5QnVmZmVyLnNsaWNlKDAsIDQpKTsKICAgIC8vIEQwIENGIDExIEUwOiDruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgOydtOqxsOuCmCDsmJvrgqAgLnhscyDtmJXsi50KICAgIGlmIChoZWFkWzBdID09PSAweGQwICYmIGhlYWRbMV0gPT09IDB4Y2YgJiYgaGVhZFsyXSA9PT0gMHgxMSAmJiBoZWFkWzNdID09PSAweGUwKSB7CiAgICAgIHRocm93IGZhaWwoJ2VuY3J5cHRlZCcsICfruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgCjrmJDripQg7Jib64KgIC54bHMpIO2MjOydvOydtOyXkOyalC4g7JeR7IWA7J2064KYIOq1rOq4gCDsi5ztirjsl5DshJwg7Je07Ja0IOu5hOuwgOuyiO2YuCDsl4bsnbQgLnhsc3gg65iQ64qUIENTViDroZwg64uk7IucIOyggOyepe2VnCDrkqQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGlmICghKGhlYWRbMF0gPT09IDB4NTAgJiYgaGVhZFsxXSA9PT0gMHg0YikpIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAoLnhsc3gpIO2MjOydvOydtCDslYTri4jsl5DsmpQuJyk7CgogICAgY29uc3QgZmlsZXMgPSByZWFkWmlwRGlyZWN0b3J5KGFycmF5QnVmZmVyKTsKICAgIGNvbnN0IHNoYXJlZCA9IFtdOwogICAgY29uc3Qgc3N0ID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL3NoYXJlZFN0cmluZ3MueG1sJyk7CiAgICBpZiAoc3N0KSB7CiAgICAgIGZvciAoY29uc3Qgc2kgb2YgdGFncyhzc3QsICdzaScpKSB7CiAgICAgICAgLy8g7J2964qUIOuylSDtkZzsi5woclBoKSDslYjsnZgg6riA7J6Q64qUIOu5vOqzoCDtlansuZzri6QKICAgICAgICBzaGFyZWQucHVzaCh0YWdzKHNpLCAndCcpLmZpbHRlcigodCkgPT4gISh0LnBhcmVudE5vZGUgJiYgdC5wYXJlbnROb2RlLm5vZGVOYW1lID09PSAnclBoJykpLm1hcCgodCkgPT4gdC50ZXh0Q29udGVudCkuam9pbignJykpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBwYXRoID0gYXdhaXQgZmlyc3RTaGVldFBhdGgoZmlsZXMpOwogICAgY29uc3Qgc2hlZXQgPSBwYXRoICYmIChhd2FpdCByZWFkWG1sKGZpbGVzLCBwYXRoKSk7CiAgICBpZiAoIXNoZWV0KSB0aHJvdyBmYWlsKCdmb3JtYXQnLCAn7Iuc7Yq466W8IOywvuyngCDrqrvtlojslrTsmpQuJyk7CgogICAgY29uc3Qgcm93cyA9IFtdOwogICAgZm9yIChjb25zdCByb3cgb2YgdGFncyhzaGVldCwgJ3JvdycpKSB7CiAgICAgIGNvbnN0IHIgPSBOdW1iZXIocm93LmdldEF0dHJpYnV0ZSgncicpKSAtIDE7CiAgICAgIGNvbnN0IG91dCA9IFtdOwogICAgICB0YWdzKHJvdywgJ2MnKS5mb3JFYWNoKChjLCBpKSA9PiB7CiAgICAgICAgY29uc3QgY29sID0gYy5nZXRBdHRyaWJ1dGUoJ3InKSA/IGNvbHVtbkluZGV4KGMuZ2V0QXR0cmlidXRlKCdyJykpIDogaTsKICAgICAgICBjb25zdCB0eXBlID0gYy5nZXRBdHRyaWJ1dGUoJ3QnKTsKICAgICAgICBjb25zdCB2ID0gdGFncyhjLCAndicpWzBdOwogICAgICAgIGxldCB2YWx1ZSA9ICcnOwogICAgICAgIGlmICh0eXBlID09PSAncycpIHZhbHVlID0gc2hhcmVkW051bWJlcih2ICYmIHYudGV4dENvbnRlbnQpXSB8fCAnJzsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnaW5saW5lU3RyJykgdmFsdWUgPSB0YWdzKGMsICd0JykubWFwKCh0KSA9PiB0LnRleHRDb250ZW50KS5qb2luKCcnKTsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnc3RyJyB8fCB0eXBlID09PSAnYicgfHwgdHlwZSA9PT0gJ2UnKSB2YWx1ZSA9IHYgPyB2LnRleHRDb250ZW50IDogJyc7CiAgICAgICAgZWxzZSBpZiAodikgdmFsdWUgPSBOdW1iZXIodi50ZXh0Q29udGVudCk7CiAgICAgICAgb3V0W2NvbF0gPSB2YWx1ZTsKICAgICAgfSk7CiAgICAgIHJvd3NbciA+PSAwID8gciA6IHJvd3MubGVuZ3RoXSA9IG91dDsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHJvd3MsIChyKSA9PiBBcnJheS5mcm9tKHIgfHwgW10sIChjKSA9PiAoYyA9PT0gdW5kZWZpbmVkID8gJycgOiBjKSkpOwogIH0KCiAgLy8g7YyM7J28IO2VmOuCmOulvCDsnb3slrQgMuywqOybkCDrsLDsl7TroZwuIENTViDripQg6riA7J6QIOq3uOuMgOuhnCjtlZzquIAg7JeR7IWAIENTViDripQgRVVDLUtSIOyduCDqsr3smrDqsIAg66eO7JWEIOqwmeydtCDsi5zrj4QpCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFRhYmxlRmlsZShmaWxlKSB7CiAgICBjb25zdCBidWYgPSBhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCk7CiAgICBjb25zdCBoZWFkID0gbmV3IFVpbnQ4QXJyYXkoYnVmLnNsaWNlKDAsIDQpKTsKICAgIGNvbnN0IGlzWmlwT3JPbGUgPSAoaGVhZFswXSA9PT0gMHg1MCAmJiBoZWFkWzFdID09PSAweDRiKSB8fCAoaGVhZFswXSA9PT0gMHhkMCAmJiBoZWFkWzFdID09PSAweGNmKTsKICAgIGlmIChpc1ppcE9yT2xlIHx8IC9cLnhsc3g/JC9pLnRlc3QoZmlsZS5uYW1lKSkgcmV0dXJuIHJlYWRYbHN4KGJ1Zik7CiAgICBsZXQgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigndXRmLTgnKS5kZWNvZGUoYnVmKTsKICAgIGlmICh0ZXh0LmluY2x1ZGVzKCfvv70nKSkgewogICAgICB0cnkgewogICAgICAgIHRleHQgPSBuZXcgVGV4dERlY29kZXIoJ2V1Yy1rcicpLmRlY29kZShidWYpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyogdXRmLTgg6re464yA66GcICovCiAgICAgIH0KICAgIH0KICAgIHJldHVybiByb290LkJ1ZGdldExvZ2ljLnBhcnNlQ1NWKHRleHQpOwogIH0KCiAgcm9vdC5CdWRnZXRYbHN4ID0geyByZWFkWGxzeCwgcmVhZFRhYmxlRmlsZSB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/store.js\", \"Lyog7KCA7J6l7IaMLiDrkZAg6rCA7KeAIOuwqeyLneydhCDqsJnsnYAg7ZWo7IiY66GcIOuLpOujrOuLpC4KICogIC0gbG9jYWwgOiDsnbQg67iM65287Jqw7KCAKGxvY2FsU3RvcmFnZSnsl5Drp4wg7KCA7J6lLCDtgqTsm4zrk5zroZwg67aE66WYCiAqICAtIHJlbW90ZTog6rWs6riAIEFwcHMgU2NyaXB0IOyEnOuyhCjqtazquIAg7Iuc7Yq4KeyXkCDsoIDsnqUsIENsYXVkZSBBSSDroZwg67aE66WYLCDslYzrprwg7J6Q64+ZIOyeheugpQogKiAgICAgICAgICAgIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOygnOqzte2VmOuptCDsnpDrj5nsnLzroZwgcmVtb3RlLCDslYTri4jrqbQg7ISk7KCV7JeQ7IScIOyEnOuyhCDso7zshozrpbwg7Jew6rKwCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IEwgPSByb290LkJ1ZGdldExvZ2ljOwogIGNvbnN0IFNUT1JBR0VfS0VZID0gJ2J1ZGdldC1hcHAtdjEnOwogIGNvbnN0IFNFUlZFUl9LRVkgPSAnYnVkZ2V0LWFwcC1zZXJ2ZXInOwogIGNvbnN0IE1JR1JBVEVfS0VZID0gJ2J1ZGdldC1hcHAtbWlncmF0ZSc7CgogIGNvbnN0IHVpZCA9ICgpID0+IERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCk7CiAgY29uc3Qgbm93SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpOwoKICBjb25zdCBLRVlfU1RPUkUgPSAnYnVkZ2V0LWFwcC1rZXknOwoKICBmdW5jdGlvbiByZWFkU2VydmVyQ29uZmlnKCkgewogICAgLy8g6rWs6riAIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOykhCDrlYw6IO2CpOuKlCDso7zshowoP2tleT0pIOuYkOuKlCDsnbQg6riw6riw7JeQIOq4sOyWte2VnCDqsJIKICAgIGlmIChyb290Ll9fQlVER0VUX1NFUlZFUl9fKSB7CiAgICAgIGxldCBrZXkgPSByb290Ll9fQlVER0VUX1NFUlZFUl9fLmtleSB8fCAnJzsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoa2V5KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgZWxzZSBrZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShLRVlfU1RPUkUpIHx8ICcnOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog6riw7Ja1IOuquyDtlZjrqbQg66ek67KIIOyeheugpSAqLwogICAgICB9CiAgICAgIHJldHVybiB7IC4uLnJvb3QuX19CVURHRVRfU0VSVkVSX18sIGtleSwgZW1iZWRkZWQ6IHRydWUgfTsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFUlZFUl9LRVkpOwogICAgICBjb25zdCBjID0gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDogbnVsbDsKICAgICAgcmV0dXJuIGMgJiYgYy51cmwgJiYgYy5rZXkgPyBjIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBjb25zdCBzZXJ2ZXIgPSByZWFkU2VydmVyQ29uZmlnKCk7CgogIGNvbnN0IHN0b3JlID0gewogICAgbW9kZTogc2VydmVyID8gJ3JlbW90ZScgOiAnbG9jYWwnLAogICAgc2VydmVyLAogICAgYWlFbmFibGVkOiBmYWxzZSwKICAgIGFpTW9kZWw6ICcnLAogICAgYWlNb2RlbHM6IFtdLAogICAgYWlFcnJvcjogJycsCiAgICBzZXJ2aWNlVXJsOiBzZXJ2ZXIgPyBzZXJ2ZXIudXJsIDogJycsCiAgICBzdGF0ZTogTC5kZWZhdWx0U3RhdGUoKSwKICAgIG9uRXJyb3I6ICgpID0+IHt9LAogIH07CgogIGxldCBtZXRhVGltZXIgPSBudWxsOwoKICBmdW5jdGlvbiBjYWxsQXBpKGFjdGlvbiwgcGF5bG9hZCwgdGFyZ2V0ID0gc2VydmVyKSB7CiAgICBjb25zdCByZXEgPSB7IGtleTogdGFyZ2V0LmtleSwgYWN0aW9uLCBwYXlsb2FkOiBwYXlsb2FkIHx8IHt9IH07CiAgICBjb25zdCB1bndyYXAgPSAocikgPT4gewogICAgICBpZiAoIXIgfHwgIXIub2spIHRocm93IG5ldyBFcnJvcigociAmJiByLmVycm9yKSB8fCAn7ISc67KEIOydkeuLtSDsmKTrpZgnKTsKICAgICAgcmV0dXJuIHI7CiAgICB9OwogICAgaWYgKHRhcmdldCA9PT0gc2VydmVyICYmIHJvb3QuZ29vZ2xlICYmIHJvb3QuZ29vZ2xlLnNjcmlwdCAmJiByb290Lmdvb2dsZS5zY3JpcHQucnVuKSB7CiAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgICAgcm9vdC5nb29nbGUuc2NyaXB0LnJ1bgogICAgICAgICAgLndpdGhTdWNjZXNzSGFuZGxlcigocikgPT4gewogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHJlc29sdmUodW53cmFwKHIpKTsKICAgICAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgICAgIHJlamVjdChlKTsKICAgICAgICAgICAgfQogICAgICAgICAgfSkKICAgICAgICAgIC53aXRoRmFpbHVyZUhhbmRsZXIocmVqZWN0KQogICAgICAgICAgLmFwaShyZXEpOwogICAgICB9KTsKICAgIH0KICAgIC8vIHRleHQvcGxhaW4g7Jy866GcIOuztOuCtOuptCBDT1JTIOyCrOyghCDsmpTssq0g7JeG7J20IEFwcHMgU2NyaXB0IOuhnCDrs7Trgrwg7IiYIOyeiOuLpAogICAgcmV0dXJuIGZldGNoKHRhcmdldC51cmwsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcSkgfSkKICAgICAgLnRoZW4oKHIpID0+IHIuanNvbigpKQogICAgICAudGhlbih1bndyYXApOwogIH0KCiAgZnVuY3Rpb24gbWV0YU9mKHMpIHsKICAgIGNvbnN0IHsgdHJhbnNhY3Rpb25zLCAuLi5tZXRhIH0gPSBzOwogICAgcmV0dXJuIG1ldGE7CiAgfQoKICBmdW5jdGlvbiBwbGFuRm9yRGF0ZShkYXRlKSB7CiAgICByZXR1cm4gTC5wbGFuRm9yKHN0b3JlLnN0YXRlLCBMLmdldFBlcmlvZChkYXRlLCBzdG9yZS5zdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KTsKICB9CgogIGZ1bmN0aW9uIHNhdmVMb2NhbCgpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNUT1JBR0VfS0VZLCBKU09OLnN0cmluZ2lmeShzdG9yZS5zdGF0ZSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcign7KCA7J6l7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4g67iM65287Jqw7KCAIOyggOyepeqzteqwhCDshKTsoJXsnYQg7ZmV7J247ZWY7IS47JqULicpKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlYWRMb2NhbFN0YXRlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oU1RPUkFHRV9LRVkpOwogICAgICByZXR1cm4gcmF3ID8gTC5ub3JtYWxpemVTdGF0ZShKU09OLnBhcnNlKHJhdykpIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBhcHBseVN0YXR1cyhyKSB7CiAgICBzdG9yZS5haUVuYWJsZWQgPSAhIXIuYWk7CiAgICBzdG9yZS5haU1vZGVsID0gci5tb2RlbCB8fCAnJzsKICAgIHN0b3JlLmFpTW9kZWxzID0gci5tb2RlbHMgfHwgW107CiAgICBzdG9yZS5haUVycm9yID0gci5sYXN0RXJyb3IgfHwgJyc7CiAgICBpZiAoci51cmwpIHN0b3JlLnNlcnZpY2VVcmwgPSByLnVybDsKICB9CgogIGZ1bmN0aW9uIGlzRXhwZW5zZShpdCkgewogICAgcmV0dXJuICFpdC5raW5kIHx8IGl0LmtpbmQgPT09ICdleHBlbnNlJzsKICB9CgogIE9iamVjdC5hc3NpZ24oc3RvcmUsIHsKICAgIHBsYW5Gb3JEYXRlLAogICAgcmVhZExvY2FsU3RhdGUsCgogICAgYXN5bmMgaW5pdCgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICBzdG9yZS5zdGF0ZSA9IHJlYWRMb2NhbFN0YXRlKCkgfHwgTC5kZWZhdWx0U3RhdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ2xvYWQnKTsKICAgICAgc3RvcmUuc3RhdGUgPSBMLm5vcm1hbGl6ZVN0YXRlKHIuc3RhdGUpOwogICAgICBhcHBseVN0YXR1cyhyKTsKICAgIH0sCgogICAgLy8g7LKY7J2MIOygkeyGje2VoCDrlYwg7J6F66Cl7ZWcIO2CpOqwgCDrp57ripTsp4Ag7ZmV7J247ZWY6rOgIOq4sOyWte2VnOuLpAogICAgYXN5bmMgdXNlS2V5KGtleSkgewogICAgICBjb25zdCBwcmV2ID0gc2VydmVyLmtleTsKICAgICAgc2VydmVyLmtleSA9IGtleTsKICAgICAgdHJ5IHsKICAgICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdwaW5nJykpOwogICAgICAgIHRyeSB7CiAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgLyog66y07IucICovCiAgICAgICAgfQogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgc2VydmVyLmtleSA9IHByZXY7CiAgICAgICAgdGhyb3cgZTsKICAgICAgfQogICAgfSwKCiAgICBmb3JnZXRLZXkoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oS0VZX1NUT1JFKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIC8qIOustOyLnCAqLwogICAgICB9CiAgICB9LAoKICAgIGFzeW5jIHNldEFwaUtleShhcGlLZXkpIHsKICAgICAgYXBwbHlTdGF0dXMoYXdhaXQgY2FsbEFwaSgnc2V0QXBpS2V5JywgeyBhcGlLZXkgfSkpOwogICAgfSwKCiAgICBhc3luYyBzZXRNb2RlbChtb2RlbCkgewogICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdzZXRNb2RlbCcsIHsgbW9kZWwgfSkpOwogICAgfSwKCiAgICAvLyDqs4Ttmo3Ct+yImOyehcK36rOE7KKMwrftlZnsirUg7KCV67O0IOyggOyepS4g7ISc67KE7JeQ64qUIOyeheugpeydtCDrqYjstpgg65KkIO2VnCDrsojsl5Ag67O064K464ukLgogICAgc2F2ZU1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSByZXR1cm4gc2F2ZUxvY2FsKCk7CiAgICAgIGNsZWFyVGltZW91dChtZXRhVGltZXIpOwogICAgICBtZXRhVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHN0b3JlLmZsdXNoTWV0YSgpLCA3MDApOwogICAgfSwKCiAgICBoYXNQZW5kaW5nTWV0YSgpIHsKICAgICAgcmV0dXJuICEhbWV0YVRpbWVyOwogICAgfSwKCiAgICBhc3luYyBmbHVzaE1ldGEoKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnIHx8ICFtZXRhVGltZXIpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KG1ldGFUaW1lcik7CiAgICAgIG1ldGFUaW1lciA9IG51bGw7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgY2FsbEFwaSgnc2F2ZU1ldGEnLCB7IG1ldGE6IG1ldGFPZihzdG9yZS5zdGF0ZSkgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICBzdG9yZS5vbkVycm9yKG5ldyBFcnJvcihg7ISk7KCVIOyggOyepSDsi6TtjKg6ICR7ZS5tZXNzYWdlfWApKTsKICAgICAgfQogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW99XSDihpIgW3tjYXRlZ29yeUlkLCBtZXRob2R9XQogICAgYXN5bmMgY2xhc3NpZnkoaXRlbXMpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICByZXR1cm4gaXRlbXMubWFwKChpdCkgPT4gTC5jbGFzc2lmeUxvY2FsKGl0Lm1lbW8sIHBsYW5Gb3JEYXRlKGl0LmRhdGUpLmNhdGVnb3JpZXMsIHN0b3JlLnN0YXRlLm1lcmNoYW50TWFwKSk7CiAgICAgIH0KICAgICAgYXdhaXQgc3RvcmUuZmx1c2hNZXRhKCk7CiAgICAgIHJldHVybiAoYXdhaXQgY2FsbEFwaSgnY2xhc3NpZnknLCB7IGl0ZW1zIH0pKS5yZXN1bHRzOwogICAgfSwKCiAgICAvLyBpdGVtczogW3tkYXRlLCBhbW91bnQsIG1lbW8sIGtpbmQsIGFjY291bnRJZCwgY2F0ZWdvcnlJZCAoJ19fYXV0bycg7J2066m0IOyekOuPmSDrtoTrpZgpLCBtZXRob2QsIHNvdXJjZSwgcmF3fV0KICAgIGFzeW5jIGFkZFRyYW5zYWN0aW9ucyhpdGVtcykgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIGNvbnN0IGF1dG8gPSBpdGVtcy5maWx0ZXIoKGl0KSA9PiBpc0V4cGVuc2UoaXQpICYmIGl0LmNhdGVnb3J5SWQgPT09ICdfX2F1dG8nKTsKICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeShhdXRvKTsKICAgICAgICBhdXRvLmZvckVhY2goKGl0LCBpKSA9PiBPYmplY3QuYXNzaWduKGl0LCByZXNbaV0pKTsKICAgICAgICBjb25zdCBub3cgPSBub3dJU08oKTsKICAgICAgICBjb25zdCBhZGRlZCA9IGl0ZW1zLm1hcCgoaXQpID0+IHsKICAgICAgICAgIGNvbnN0IGV4cGVuc2UgPSBpc0V4cGVuc2UoaXQpOwogICAgICAgICAgY29uc3QgY2F0ZWdvcnlJZCA9IGV4cGVuc2UgJiYgaXQuY2F0ZWdvcnlJZCAmJiBpdC5jYXRlZ29yeUlkICE9PSAnX19hdXRvJyA/IGl0LmNhdGVnb3J5SWQgOiBudWxsOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgaWQ6IHVpZCgpLAogICAgICAgICAgICBkYXRlOiBpdC5kYXRlLAogICAgICAgICAgICBhbW91bnQ6IGl0LmFtb3VudCwKICAgICAgICAgICAgbWVtbzogaXQubWVtbywKICAgICAgICAgICAgY2F0ZWdvcnlJZCwKICAgICAgICAgICAgbWV0aG9kOiBjYXRlZ29yeUlkID8gaXQubWV0aG9kIHx8ICdtYW51YWwnIDogbnVsbCwKICAgICAgICAgICAgc291cmNlOiBpdC5zb3VyY2UgfHwgJ2FwcCcsCiAgICAgICAgICAgIHJhdzogaXQucmF3IHx8ICcnLAogICAgICAgICAgICBjcmVhdGVkQXQ6IG5vdywKICAgICAgICAgICAgY2xhc3NpZmllZEF0OiBub3csCiAgICAgICAgICAgIGtpbmQ6IGV4cGVuc2UgPyAnZXhwZW5zZScgOiBpdC5raW5kLAogICAgICAgICAgICBhY2NvdW50SWQ6IGl0LmFjY291bnRJZCB8fCBudWxsLAogICAgICAgICAgfTsKICAgICAgICB9KTsKICAgICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMucHVzaCguLi5hZGRlZCk7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuIGFkZGVkOwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgnYWRkVHJhbnNhY3Rpb25zJywgeyBpdGVtcyB9KTsKICAgICAgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLnB1c2goLi4uci5hZGRlZCk7CiAgICAgIHJldHVybiByLmFkZGVkOwogICAgfSwKCiAgICBhc3luYyB1cGRhdGVUcmFuc2FjdGlvbihpZCwgcGF0Y2gpIHsKICAgICAgY29uc3QgdCA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSB7CiAgICAgICAgT2JqZWN0LmFzc2lnbih0LCBwYXRjaCwgeyBjbGFzc2lmaWVkQXQ6IG5vd0lTTygpIH0pOwogICAgICAgIHNhdmVMb2NhbCgpOwogICAgICAgIHJldHVybiB0OwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgndXBkYXRlVHJhbnNhY3Rpb24nLCB7IGlkLCBwYXRjaCB9KTsKICAgICAgT2JqZWN0LmFzc2lnbih0LCByLnR4KTsKICAgICAgcmV0dXJuIHQ7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZVRyYW5zYWN0aW9uKGlkKSB7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAncmVtb3RlJykgYXdhaXQgY2FsbEFwaSgnZGVsZXRlVHJhbnNhY3Rpb24nLCB7IGlkIH0pOwogICAgICBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMgPSBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgIGlmIChzdG9yZS5tb2RlID09PSAnbG9jYWwnKSBzYXZlTG9jYWwoKTsKICAgIH0sCgogICAgLy8g6riw6rCEIOyViOydmCDsp4DstpzsnYQg6re4IOq4sOqwhCDqs4Ttmo3sl5Ag66ee7LawIOuLpOyLnCDrtoTrpZguIOuwmO2ZmDog64uk7IucIOu2hOulmO2VnCDsp4Dstpwg7IiYCiAgICBhc3luYyByZWNsYXNzaWZ5KHBlcmlvZCwgb25seVVuY2xhc3NpZmllZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIHsKICAgICAgICBhd2FpdCBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgncmVjbGFzc2lmeScsIHsgc3RhcnQ6IHBlcmlvZC5zdGFydCwgZW5kOiBwZXJpb2QuZW5kLCBvbmx5VW5jbGFzc2lmaWVkIH0pOwogICAgICAgIGZvciAoY29uc3QgdSBvZiByLnVwZGF0ZWQpIE9iamVjdC5hc3NpZ24oc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLmZpbmQoKHQpID0+IHQuaWQgPT09IHUuaWQpIHx8IHt9LCB1KTsKICAgICAgICByZXR1cm4gci51cGRhdGVkLmxlbmd0aDsKICAgICAgfQogICAgICBjb25zdCBwbGFuID0gcGxhbkZvckRhdGUocGVyaW9kLnN0YXJ0KTsKICAgICAgY29uc3Qga25vd24gPSBuZXcgU2V0KHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgICAgY29uc3QgdGFyZ2V0cyA9IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IHsKICAgICAgICBpZiAodC5kYXRlIDwgcGVyaW9kLnN0YXJ0IHx8IHQuZGF0ZSA+IHBlcmlvZC5lbmQgfHwgTC5raW5kT2YodCkgIT09ICdleHBlbnNlJykgcmV0dXJuIGZhbHNlOwogICAgICAgIGNvbnN0IGV4aXN0cyA9IGtub3duLmhhcyh0LmNhdGVnb3J5SWQpOwogICAgICAgIHJldHVybiBvbmx5VW5jbGFzc2lmaWVkID8gIWV4aXN0cyA6ICEodC5tZXRob2QgPT09ICdtYW51YWwnICYmIGV4aXN0cyk7CiAgICAgIH0pOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBzdG9yZS5jbGFzc2lmeSh0YXJnZXRzKTsKICAgICAgY29uc3Qgbm93ID0gbm93SVNPKCk7CiAgICAgIHRhcmdldHMuZm9yRWFjaCgodCwgaSkgPT4gT2JqZWN0LmFzc2lnbih0LCByZXNbaV0sIHsgY2xhc3NpZmllZEF0OiBub3cgfSkpOwogICAgICBzYXZlTG9jYWwoKTsKICAgICAgcmV0dXJuIHRhcmdldHMubGVuZ3RoOwogICAgfSwKCiAgICBhc3luYyByZWZyZXNoKCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIGF3YWl0IHN0b3JlLmluaXQoKTsKICAgIH0sCgogICAgLy8g7ISc67KEIOyXsOqysCDtmZXsnbggKOyXsOqysCDsoITsnbTrnbwg7KO87IaM7JmAIO2CpOulvCDsp4HsoJEg67Cb64qU64ukKQogICAgcGluZyh1cmwsIGtleSkgewogICAgICByZXR1cm4gY2FsbEFwaSgncGluZycsIHt9LCB7IHVybCwga2V5IH0pOwogICAgfSwKCiAgICBjb25uZWN0KHVybCwga2V5LCBtaWdyYXRlKSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFUlZFUl9LRVksIEpTT04uc3RyaW5naWZ5KHsgdXJsLCBrZXkgfSkpOwogICAgICBpZiAobWlncmF0ZSkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUlHUkFURV9LRVksICcxJyk7CiAgICB9LAoKICAgIGRpc2Nvbm5lY3QoKSB7CiAgICAgIHRyeSB7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU0VSVkVSX0tFWSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICAvKiDrrLTsi5wgKi8KICAgICAgfQogICAgfSwKCiAgICAvLyDshJzrsoTsl5Ag7Jew6rKw7ZWcIOynge2bhCDtlZwg67KIOiDsnbQg6riw6riw7JeQIOyeiOuNmCDrjbDsnbTthLDrpbwg7Jiu6ri47KeACiAgICB0YWtlTWlncmF0aW9uKCkgewogICAgICB0cnkgewogICAgICAgIGlmIChzdG9yZS5tb2RlICE9PSAncmVtb3RlJyB8fCBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNSUdSQVRFX0tFWSkgIT09ICcxJykgcmV0dXJuIG51bGw7CiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oTUlHUkFURV9LRVkpOwogICAgICAgIHJldHVybiByZWFkTG9jYWxTdGF0ZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgIH0sCgogICAgLy8g67Cx7JeFKOuYkOuKlCDsnbQg6riw6riwIOuNsOydtO2EsCkg67aI65+s7Jik6riwCiAgICBhc3luYyBpbXBvcnRTdGF0ZShpbXBvcnRlZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIHN0b3JlLnN0YXRlID0gaW1wb3J0ZWQ7CiAgICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IHR4cyA9IGltcG9ydGVkLnRyYW5zYWN0aW9uczsKICAgICAgc3RvcmUuc3RhdGUgPSB7IC4uLmltcG9ydGVkLCB0cmFuc2FjdGlvbnM6IHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucyB9OwogICAgICBhd2FpdCBjYWxsQXBpKCdzYXZlTWV0YScsIHsgbWV0YTogbWV0YU9mKHN0b3JlLnN0YXRlKSB9KTsKICAgICAgY29uc3QgZnJlc2ggPSB0eHMuZmlsdGVyKCh0KSA9PiAhTC5pc0R1cGxpY2F0ZSh0LCBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMpKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmcmVzaC5sZW5ndGg7IGkgKz0gMjAwKSB7CiAgICAgICAgYXdhaXQgc3RvcmUuYWRkVHJhbnNhY3Rpb25zKAogICAgICAgICAgZnJlc2guc2xpY2UoaSwgaSArIDIwMCkubWFwKCh0KSA9PiAoewogICAgICAgICAgICBkYXRlOiB0LmRhdGUsCiAgICAgICAgICAgIGFtb3VudDogdC5hbW91bnQsCiAgICAgICAgICAgIG1lbW86IHQubWVtbywKICAgICAgICAgICAga2luZDogTC5raW5kT2YodCksCiAgICAgICAgICAgIGFjY291bnRJZDogdC5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICAgICAgY2F0ZWdvcnlJZDogdC5jYXRlZ29yeUlkIHx8IG51bGwsCiAgICAgICAgICAgIG1ldGhvZDogdC5tZXRob2QgfHwgKHQuY2F0ZWdvcnlJZCA/ICdtYW51YWwnIDogbnVsbCksCiAgICAgICAgICAgIHNvdXJjZTogdC5zb3VyY2UgfHwgJ2ltcG9ydCcsCiAgICAgICAgICAgIHJhdzogdC5yYXcgfHwgJycsCiAgICAgICAgICB9KSkKICAgICAgICApOwogICAgICB9CiAgICB9LAoKICAgIHJlc2V0KCkgewogICAgICBzdG9yZS5zdGF0ZSA9IEwuZGVmYXVsdFN0YXRlKCk7CiAgICAgIHNhdmVMb2NhbCgpOwogICAgfSwKICB9KTsKCiAgcm9vdC5CdWRnZXRTdG9yZSA9IHN0b3JlOwp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/app.js\", \"Lyog7KeA7LacIOq0gOumrCDslbEg7ZmU66m0LiDqs4TsgrDsnYAganMvbG9naWMuanMsIOyggOyepeydgCBqcy9zdG9yZS5qcywg7LCo7Yq464qUIGpzL2NoYXJ0cy5qcyAqLwooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgTCA9IHdpbmRvdy5CdWRnZXRMb2dpYzsKICBjb25zdCBDID0gd2luZG93LkJ1ZGdldENoYXJ0czsKICBjb25zdCBzdG9yZSA9IHdpbmRvdy5CdWRnZXRTdG9yZTsKICBjb25zdCBTID0gKCkgPT4gc3RvcmUuc3RhdGU7CgogIC8vIC0tLS0tLS0tLS0g7Jyg7Yu4IC0tLS0tLS0tLS0KCiAgY29uc3QgJCA9IChzZWwpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTsKICBjb25zdCAkJCA9IChzZWwpID0+IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCldOwogIGNvbnN0IHdvbiA9IChuKSA9PiBgJHtNYXRoLnJvdW5kKG4pLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeybkGA7CiAgY29uc3QgdWlkID0gKCkgPT4gRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KTsKICBjb25zdCBub3dJU08gPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CgogIGZ1bmN0aW9uIGVzYyhzKSB7CiAgICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgKGMpID0+ICh7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjXSkpOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRJbnB1dChzKSB7CiAgICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHMgfHwgJycpLnJlcGxhY2UoL1teXGQtXS9nLCAnJyk7CiAgICBpZiAoIWNsZWFuZWQgfHwgY2xlYW5lZCA9PT0gJy0nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IG4gPSBOdW1iZXIoY2xlYW5lZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlKGlzbykgewogICAgY29uc3QgeyB5LCBtLCBkIH0gPSBMLnBhcnNlSVNPKGlzbyk7CiAgICByZXR1cm4gYCR7eX0uJHtTdHJpbmcobSkucGFkU3RhcnQoMiwgJzAnKX0uJHtTdHJpbmcoZCkucGFkU3RhcnQoMiwgJzAnKX1gOwogIH0KCiAgY29uc3QgRE9XID0gWyfsnbwnLCAn7JuUJywgJ+2ZlCcsICfsiJgnLCAn66qpJywgJ+q4iCcsICfthqAnXTsKICBmdW5jdGlvbiBkb3dPZihpc28pIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gTC5wYXJzZUlTTyhpc28pOwogICAgcmV0dXJuIG5ldyBEYXRlKERhdGUuVVRDKHksIG0gLSAxLCBkKSkuZ2V0VVRDRGF5KCk7CiAgfQoKICBmdW5jdGlvbiBmbXREYXkoaXNvKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08oaXNvKTsKICAgIHJldHVybiBgJHttfeyblCAke2R97J28ICR7RE9XW2Rvd09mKGlzbyldfeyalOydvGA7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlVGltZShpc29UaW1lKSB7CiAgICBpZiAoIWlzb1RpbWUpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShpc29UaW1lKTsKICAgIGlmIChpc05hTihkKSkgcmV0dXJuICcnOwogICAgcmV0dXJuIGAke2QuZ2V0TW9udGgoKSArIDF9LyR7ZC5nZXREYXRlKCl9ICR7U3RyaW5nKGQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcoZC5nZXRNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICB9CgogIGxldCB0b2FzdFRpbWVyOwogIGZ1bmN0aW9uIHRvYXN0KG1zZywgbXMgPSAyNjAwKSB7CiAgICBjb25zdCBlbCA9ICQoJyN0b2FzdCcpOwogICAgZWwudGV4dENvbnRlbnQgPSBtc2c7CiAgICBlbC5oaWRkZW4gPSBmYWxzZTsKICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsKICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IChlbC5oaWRkZW4gPSB0cnVlKSwgbXMpOwogIH0KICBzdG9yZS5vbkVycm9yID0gKGUpID0+IHRvYXN0KGUubWVzc2FnZSwgNTAwMCk7CgogIGxldCBidXN5Q291bnQgPSAwOwogIGFzeW5jIGZ1bmN0aW9uIGJ1c3kobGFiZWwsIGZuKSB7CiAgICBidXN5Q291bnQgKz0gMTsKICAgICQoJyNidXN5JykuaGlkZGVuID0gZmFsc2U7CiAgICBpZiAobGFiZWwpIHRvYXN0KGxhYmVsLCA2MDAwMCk7CiAgICB0cnkgewogICAgICByZXR1cm4gYXdhaXQgZm4oKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgdG9hc3QoYOyYpOulmDogJHtlLm1lc3NhZ2UgfHwgZX1gLCA1MDAwKTsKICAgICAgdGhyb3cgZTsKICAgIH0gZmluYWxseSB7CiAgICAgIGJ1c3lDb3VudCAtPSAxOwogICAgICBpZiAoIWJ1c3lDb3VudCkgJCgnI2J1c3knKS5oaWRkZW4gPSB0cnVlOwogICAgICBpZiAobGFiZWwgJiYgJCgnI3RvYXN0JykudGV4dENvbnRlbnQgPT09IGxhYmVsKSAkKCcjdG9hc3QnKS5oaWRkZW4gPSB0cnVlOwogICAgfQogIH0KCiAgLy8gYnVzeSDqsIAg7J2066+4IOyYpOulmOulvCDslYzroLjsnLzrr4DroZwg7J2067Kk7Yq4IO2VuOuTpOufrOyXkOyEnOuKlCDsgrztgqjri6QKICBjb25zdCBxdWlldCA9IChmbikgPT4gKC4uLmFyZ3MpID0+IFByb21pc2UucmVzb2x2ZShmbiguLi5hcmdzKSkuY2F0Y2goKCkgPT4ge30pOwoKICBmdW5jdGlvbiBmb3JtYXRPbkJsdXIoaW5wdXQpIHsKICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiB7CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KGlucHV0LnZhbHVlKTsKICAgICAgaWYgKG4gIT09IG51bGwpIGlucHV0LnZhbHVlID0gbi50b0xvY2FsZVN0cmluZygna28tS1InKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gY29weVRleHQodGV4dCwgaW5wdXQpIHsKICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB0b2FzdCgn67O17IKs7ZaI7Iq164uI64ukLicpOwogICAgY29uc3QgZmFsbGJhY2sgPSAoKSA9PiB7CiAgICAgIGlucHV0LnNlbGVjdCgpOwogICAgICB0cnkgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjb3B5Jyk7CiAgICAgICAgZG9uZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgdG9hc3QoJ+q4uOqyjCDriIzrn6wg7KeB7KCRIOuzteyCrO2VtCDso7zshLjsmpQuJyk7CiAgICAgIH0KICAgIH07CiAgICBpZiAobmF2aWdhdG9yLmNsaXBib2FyZCkgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCkudGhlbihkb25lLCBmYWxsYmFjayk7CiAgICBlbHNlIGZhbGxiYWNrKCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyDge2DnCAtLS0tLS0tLS0tCgogIGxldCBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCAxKTsKICBsZXQgY3VycmVudFBhZ2UgPSAnaG9tZSc7CiAgbGV0IHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgY29uc3QgbGlzdFN0YXRlID0geyBzZWFyY2g6ICcnLCBraW5kOiAnYWxsJywgY2F0ZWdvcnk6ICdhbGwnLCBhY2NvdW50OiAnYWxsJyB9OwogIGxldCBtYW51YWxLaW5kID0gJ2V4cGVuc2UnOwoKICBjb25zdCBwbGFuRm9yRGF0ZSA9IChkYXRlKSA9PiBzdG9yZS5wbGFuRm9yRGF0ZShkYXRlKTsKICBjb25zdCBjdXJyZW50UGxhbiA9ICgpID0+IEwucGxhbkZvcihTKCksIGN1cnJlbnRQZXJpb2Qua2V5KTsKCiAgZnVuY3Rpb24gY2F0ZWdvcnlJbmZvKGlkLCBjYXRlZ29yaWVzID0gY3VycmVudFBsYW4oKS5jYXRlZ29yaWVzKSB7CiAgICBjb25zdCBpID0gY2F0ZWdvcmllcy5maW5kSW5kZXgoKGMpID0+IGMuaWQgPT09IGlkKTsKICAgIHJldHVybiBpID49IDAgPyB7IG5hbWU6IGNhdGVnb3JpZXNbaV0ubmFtZSwgY29sb3JJbmRleDogaSB9IDogeyBuYW1lOiAn66+467aE66WYJywgY29sb3JJbmRleDogLTEgfTsKICB9CgogIGZ1bmN0aW9uIGFjY291bnROYW1lKGlkKSB7CiAgICBjb25zdCBhID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgIHJldHVybiBhID8gYS5uYW1lIHx8IGAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+y5tOuTnCcgOiAn6rOE7KKMJ30gJHthLmxhc3Q0fWAgOiAnJzsKICB9CgogIGZ1bmN0aW9uIGNhdGVnb3J5T3B0aW9ucyhjYXRlZ29yaWVzLCBzZWxlY3RlZCwgeyBpbmNsdWRlQXV0byA9IGZhbHNlIH0gPSB7fSkgewogICAgY29uc3Qgb3B0cyA9IFtdOwogICAgaWYgKGluY2x1ZGVBdXRvKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9Il9fYXV0byI+7J6Q64+ZIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfTwvb3B0aW9uPmApOwogICAgb3B0cy5wdXNoKGA8b3B0aW9uIHZhbHVlPSIiICR7IXNlbGVjdGVkID8gJ3NlbGVjdGVkJyA6ICcnfT7rr7jrtoTrpZg8L29wdGlvbj5gKTsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGMuaWQpfSIgJHtjLmlkID09PSBzZWxlY3RlZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKTsKICAgIHJldHVybiBvcHRzLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gYWNjb3VudE9wdGlvbnMoc2VsZWN0ZWQsIGVtcHR5TGFiZWwgPSAn7ISg7YOdIOyViCDtlagnKSB7CiAgICByZXR1cm4gW2A8b3B0aW9uIHZhbHVlPSIiPiR7ZW1wdHlMYWJlbH08L29wdGlvbj5gXQogICAgICAuY29uY2F0KFMoKS5hY2NvdW50cy5tYXAoKGEpID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhhLmlkKX0iICR7YS5pZCA9PT0gc2VsZWN0ZWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGFjY291bnROYW1lKGEuaWQpKX08L29wdGlvbj5gKSkKICAgICAgLmpvaW4oJycpOwogIH0KCiAgY29uc3QgTUVUSE9EX0xBQkVMID0geyBhaTogJ0FJJywgbGVhcm5lZDogJ+q4sOyWtScsIGtleXdvcmQ6ICftgqTsm4zrk5wnLCBtYW51YWw6ICfsp4HsoJEnIH07CiAgY29uc3QgbWV0aG9kVGFnID0gKG0pID0+IChtICYmIE1FVEhPRF9MQUJFTFttXSA/IGA8c3BhbiBjbGFzcz0idGFnIj4ke01FVEhPRF9MQUJFTFttXX08L3NwYW4+YCA6ICcnKTsKCiAgLy8gLS0tLS0tLS0tLSDtjpjsnbTsp4Ag7J2064+ZIC0tLS0tLS0tLS0KCiAgY29uc3QgUEFHRVMgPSB7CiAgICBob21lOiB7IHRpdGxlOiAn7ZmIJywgcGVyaW9kOiB0cnVlIH0sCiAgICBjYWxlbmRhcjogeyB0aXRsZTogJ+uLrOugpScsIHBlcmlvZDogdHJ1ZSB9LAogICAgbGlzdDogeyB0aXRsZTogJ+uCtOyXrScsIHBlcmlvZDogdHJ1ZSB9LAogICAgcmVwb3J0OiB7IHRpdGxlOiAn66as7Y+s7Yq4JywgcGVyaW9kOiB0cnVlIH0sCiAgICBhc3NldHM6IHsgdGl0bGU6ICfsnpDsgrAnLCBwZXJpb2Q6IHRydWUgfSwKICAgIHBsYW46IHsgdGl0bGU6ICfsmIjsgrAg6rOE7ZqNJywgcGVyaW9kOiB0cnVlIH0sCiAgICBhZGQ6IHsgdGl0bGU6ICfsp4DstpzCt+yImOyehSDsnoXroKUnLCBwZXJpb2Q6IGZhbHNlIH0sCiAgICBzZXR0aW5nczogeyB0aXRsZTogJ+yEpOyglScsIHBlcmlvZDogZmFsc2UgfSwKICB9OwoKICBmdW5jdGlvbiBzaG93UGFnZShuYW1lLCB7IHB1c2ggPSB0cnVlIH0gPSB7fSkgewogICAgaWYgKCFQQUdFU1tuYW1lXSkgbmFtZSA9ICdob21lJzsKICAgIGN1cnJlbnRQYWdlID0gbmFtZTsKICAgICQkKCcucGFnZScpLmZvckVhY2goKHApID0+IHAuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgcC5kYXRhc2V0LnBhZ2UgPT09IG5hbWUpKTsKICAgICQkKCcubmF2LWl0ZW0nKS5mb3JFYWNoKChiKSA9PiBiLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGIuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkJCgnLmJvdHRvbS1uYXYgW2RhdGEtcGFnZV0nKS5mb3JFYWNoKChiKSA9PiBiLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGIuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkKCcjcGFnZS10aXRsZScpLnRleHRDb250ZW50ID0gUEFHRVNbbmFtZV0udGl0bGU7CiAgICAkKCcjcGVyaW9kLW5hdicpLmhpZGRlbiA9ICFQQUdFU1tuYW1lXS5wZXJpb2Q7CiAgICBjbG9zZU1lbnUoKTsKICAgIC8vIOq1rOq4gCBBcHBzIFNjcmlwdCDtmZTrqbQoaWZyYW1lKeyymOufvCDso7zshozrpbwg66q7IOuwlOq+uOuKlCDqs7Psl5DshJzrj4Qg7J2064+Z7J2AIOuQmOqyjAogICAgdHJ5IHsKICAgICAgaWYgKHB1c2ggJiYgbG9jYXRpb24uaGFzaCAhPT0gYCMke25hbWV9YCkgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwgJycsIGAjJHtuYW1lfWApOwogICAgfSBjYXRjaCAoZSkgewogICAgICAvKiDrrLTsi5wgKi8KICAgIH0KICAgIHdpbmRvdy5zY3JvbGxUbygwLCAwKTsKICAgIHJlbmRlcigpOwogIH0KCiAgZnVuY3Rpb24gb3Blbk1lbnUoKSB7CiAgICAkKCcjc2lkZWJhcicpLmNsYXNzTGlzdC5hZGQoJ29wZW4nKTsKICAgICQoJyNzY3JpbScpLmhpZGRlbiA9IGZhbHNlOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VNZW51KCkgewogICAgJCgnI3NpZGViYXInKS5jbGFzc0xpc3QucmVtb3ZlKCdvcGVuJyk7CiAgICAkKCcjc2NyaW0nKS5oaWRkZW4gPSB0cnVlOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDqs7XthrUg66i466asIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQ2hyb21lKCkgewogICAgY29uc3QgY2hpcCA9ICQoJyNjb25uLXN0YXR1cycpOwogICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgY2hpcC50ZXh0Q29udGVudCA9ICfsnbQg6riw6riw7JeQ66eMIOyggOyepSc7CiAgICAgIGNoaXAuY2xhc3NOYW1lID0gJ2NoaXAnOwogICAgfSBlbHNlIHsKICAgICAgY2hpcC50ZXh0Q29udGVudCA9IHN0b3JlLmFpRW5hYmxlZCA/ICfqtazquIAg7Iuc7Yq4IMK3IEFJIOu2hOulmCcgOiAn6rWs6riAIOyLnO2KuCDCtyBBSSDqurzsp5AnOwogICAgICBjaGlwLmNsYXNzTmFtZSA9IGBjaGlwICR7c3RvcmUuYWlFbmFibGVkID8gJ29uJyA6ICcnfWA7CiAgICB9CiAgICAkKCcjcmVmcmVzaC1idG4nKS5oaWRkZW4gPSBzdG9yZS5tb2RlICE9PSAncmVtb3RlJzsKCiAgICBjb25zdCBwID0gY3VycmVudFBlcmlvZDsKICAgICQoJyNwZXJpb2QtdGV4dCcpLnRleHRDb250ZW50ID0gYCR7Zm10RGF0ZShwLnN0YXJ0KX0gfiAke2ZtdERhdGUocC5lbmQpLnNsaWNlKDUpfWA7CiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGxldCBzdWI7CiAgICBpZiAodG9kYXkgPj0gcC5zdGFydCAmJiB0b2RheSA8PSBwLmVuZCkgc3ViID0gYOydtOuyiCDquLDqsIQgwrcgJHtMLmRpZmZEYXlzKHRvZGF5LCBwLmVuZCkgKyAxfeydvCDrgqjsnYxgOwogICAgZWxzZSBpZiAodG9kYXkgPiBwLmVuZCkgc3ViID0gJ+yngOuCnCDquLDqsIQnOwogICAgZWxzZSBzdWIgPSAn64uk6rCA7Jik64qUIOq4sOqwhCc7CiAgICAkKCcjcGVyaW9kLXN1YicpLnRleHRDb250ZW50ID0gc3ViOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDtiLTtjIEgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBhdHRhY2hUb29sdGlwKGVsLCBodG1sKSB7CiAgICBjb25zdCB0aXAgPSAkKCcjdG9vbHRpcCcpOwogICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsKICAgICAgdGlwLmlubmVySFRNTCA9IGh0bWwoKTsKICAgICAgdGlwLmhpZGRlbiA9IGZhbHNlOwogICAgfSk7CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCAoZSkgPT4gewogICAgICBjb25zdCB4ID0gTWF0aC5taW4oZS5jbGllbnRYICsgMTQsIHdpbmRvdy5pbm5lcldpZHRoIC0gdGlwLm9mZnNldFdpZHRoIC0gOCk7CiAgICAgIHRpcC5zdHlsZS5sZWZ0ID0gYCR7eH1weGA7CiAgICAgIHRpcC5zdHlsZS50b3AgPSBgJHtlLmNsaWVudFkgKyAxNH1weGA7CiAgICB9KTsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiAodGlwLmhpZGRlbiA9IHRydWUpKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rGw656YIO2VnCDspIQgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiB0eFJvdyh0LCB7IGVkaXRhYmxlID0gdHJ1ZSB9ID0ge30pIHsKICAgIGNvbnN0IGtpbmQgPSBMLmtpbmRPZih0KTsKICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yRGF0ZSh0LmRhdGUpLmNhdGVnb3JpZXM7CiAgICBjb25zdCBpbmZvID0gY2F0ZWdvcnlJbmZvKHQuY2F0ZWdvcnlJZCwgY2F0cyk7CiAgICBsZXQgaWNvbjsKICAgIGxldCBhbW91bnQ7CiAgICBpZiAoa2luZCA9PT0gJ2luY29tZScpIHsKICAgICAgaWNvbiA9ICc8ZGl2IGNsYXNzPSJ0eC1pY29uIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpIj4rPC9kaXY+JzsKICAgICAgYW1vdW50ID0gYDxzcGFuIGNsYXNzPSJ0eC1hbW91bnQgcGx1cyI+KyR7d29uKHQuYW1vdW50KX08L3NwYW4+YDsKICAgIH0gZWxzZSBpZiAoa2luZCA9PT0gJ3RyYW5zZmVyJykgewogICAgICBpY29uID0gJzxkaXYgY2xhc3M9InR4LWljb24gZ3JheSI+4oaUPC9kaXY+JzsKICAgICAgYW1vdW50ID0gYDxzcGFuIGNsYXNzPSJ0eC1hbW91bnQgbmV1dHJhbCI+JHt3b24odC5hbW91bnQpfTwvc3Bhbj5gOwogICAgfSBlbHNlIHsKICAgICAgaWNvbiA9IGA8ZGl2IGNsYXNzPSJ0eC1pY29uICR7aW5mby5jb2xvckluZGV4IDwgMCA/ICdncmF5JyA6ICcnfSIgc3R5bGU9IiR7aW5mby5jb2xvckluZGV4ID49IDAgPyBgYmFja2dyb3VuZDoke0Muc2VyaWVzQ29sb3IoaW5mby5jb2xvckluZGV4KX1gIDogJyd9Ij4ke2VzYyhpbmZvLm5hbWUuc2xpY2UoMCwgMSkpfTwvZGl2PmA7CiAgICAgIGFtb3VudCA9IGA8c3BhbiBjbGFzcz0idHgtYW1vdW50ICR7dC5hbW91bnQgPCAwID8gJ3BsdXMnIDogJyd9Ij4ke3QuYW1vdW50IDwgMCA/ICcrJyA6ICcnfSR7d29uKE1hdGguYWJzKHQuYW1vdW50KSl9PC9zcGFuPmA7CiAgICB9CiAgICBjb25zdCBtZXRhID0gW107CiAgICBpZiAoZWRpdGFibGUpIHsKICAgICAgLy8g7ZWt66qp6rO8IOyiheulmCjsnoXquIjCt+ydtOyytCnrpbwg7ZWcIOy5uOyXkOyEnCDqs6Drpbjri6QKICAgICAgY29uc3QgY3VycmVudCA9IGtpbmQgIT09ICdleHBlbnNlJyA/IGBraW5kOiR7a2luZH1gIDogaW5mby5jb2xvckluZGV4ID49IDAgPyB0LmNhdGVnb3J5SWQgOiAnJzsKICAgICAgbWV0YS5wdXNoKGA8c2VsZWN0IGNsYXNzPSJ0eC1jYXQiIGRhdGEtaWQ9IiR7ZXNjKHQuaWQpfSIgYXJpYS1sYWJlbD0i7ZWt66qpIj4KICAgICAgICAke2NhdGVnb3J5T3B0aW9ucyhjYXRzLCBjdXJyZW50KX0KICAgICAgICA8b3B0Z3JvdXAgbGFiZWw9IuyngOy2nOydtCDslYTri5giPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ia2luZDppbmNvbWUiICR7Y3VycmVudCA9PT0gJ2tpbmQ6aW5jb21lJyA/ICdzZWxlY3RlZCcgOiAnJ30+7J6F6riIPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJraW5kOnRyYW5zZmVyIiAke2N1cnJlbnQgPT09ICdraW5kOnRyYW5zZmVyJyA/ICdzZWxlY3RlZCcgOiAnJ30+64K0IOqzhOyijCDsnbTssrQ8L29wdGlvbj4KICAgICAgICA8L29wdGdyb3VwPgogICAgICA8L3NlbGVjdD5gKTsKICAgIH0gZWxzZSB7CiAgICAgIG1ldGEucHVzaChlc2Moa2luZCA9PT0gJ2luY29tZScgPyAn7J6F6riIJyA6IGtpbmQgPT09ICd0cmFuc2ZlcicgPyAn64K0IOqzhOyijCDsnbTssrQnIDogaW5mby5uYW1lKSk7CiAgICB9CiAgICBpZiAoa2luZCA9PT0gJ2V4cGVuc2UnICYmIGluZm8uY29sb3JJbmRleCA+PSAwKSBtZXRhLnB1c2gobWV0aG9kVGFnKHQubWV0aG9kKSk7CiAgICBpZiAodC5hY2NvdW50SWQgJiYgYWNjb3VudE5hbWUodC5hY2NvdW50SWQpKSBtZXRhLnB1c2goYDxzcGFuPiR7ZXNjKGFjY291bnROYW1lKHQuYWNjb3VudElkKSl9PC9zcGFuPmApOwogICAgaWYgKHQuc291cmNlID09PSAnc21zJyB8fCB0LnNvdXJjZSA9PT0gJ2JhbmsnKSBtZXRhLnB1c2goYDxzcGFuIGNsYXNzPSJ0YWciPiR7dC5zb3VyY2UgPT09ICdiYW5rJyA/ICfsnYDtlokg7JWM66a8JyA6ICfrrLjsnpAnfTwvc3Bhbj5gKTsKICAgIHJldHVybiBgCiAgICAgIDxkaXYgY2xhc3M9InR4Ij4KICAgICAgICAke2ljb259CiAgICAgICAgPGRpdiBjbGFzcz0idHgtbWFpbiI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0eC1tZW1vIj4ke2VzYyh0Lm1lbW8pfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idHgtbWV0YSI+JHttZXRhLmpvaW4oJycpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InR4LXJpZ2h0Ij4KICAgICAgICAgICR7YW1vdW50fQogICAgICAgICAgJHtlZGl0YWJsZSA/IGA8YnV0dG9uIGNsYXNzPSJsaW5rLWJ0biB0eC1kZWwiIGRhdGEtaWQ9IiR7ZXNjKHQuaWQpfSIgYXJpYS1sYWJlbD0i7IKt7KCcIj7sgq3soJw8L2J1dHRvbj5gIDogJyd9CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PmA7CiAgfQoKICAvLyDrgqDsp5zrs4TroZwg66y27J2AIOuqqeuhnQogIGZ1bmN0aW9uIHR4R3JvdXBzKHR4cywgb3B0cykgewogICAgY29uc3Qgc29ydGVkID0gWy4uLnR4c10uc29ydCgoYSwgYikgPT4gKGEuZGF0ZSA8IGIuZGF0ZSA/IDEgOiBhLmRhdGUgPiBiLmRhdGUgPyAtMSA6IDApKTsKICAgIGNvbnN0IGdyb3VwcyA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHNvcnRlZCkgewogICAgICBsZXQgZyA9IGdyb3Vwc1tncm91cHMubGVuZ3RoIC0gMV07CiAgICAgIGlmICghZyB8fCBnLmRhdGUgIT09IHQuZGF0ZSkgZ3JvdXBzLnB1c2goKGcgPSB7IGRhdGU6IHQuZGF0ZSwgaXRlbXM6IFtdIH0pKTsKICAgICAgZy5pdGVtcy5wdXNoKHQpOwogICAgfQogICAgcmV0dXJuIGdyb3VwcwogICAgICAubWFwKChnKSA9PiB7CiAgICAgICAgY29uc3Qgc3BlbnQgPSBnLml0ZW1zLmZpbHRlcigodCkgPT4gTC5raW5kT2YodCkgPT09ICdleHBlbnNlJykucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgICAgIHJldHVybiBgPGRpdiBjbGFzcz0idHgtZGF0ZSI+PHNwYW4+JHtmbXREYXkoZy5kYXRlKX08L3NwYW4+PHNwYW4+JHtzcGVudCA/IGDsp4DstpwgJHt3b24oc3BlbnQpfWAgOiAnJ308L3NwYW4+PC9kaXY+JHtnLml0ZW1zLm1hcCgodCkgPT4gdHhSb3codCwgb3B0cykpLmpvaW4oJycpfWA7CiAgICAgIH0pCiAgICAgIC5qb2luKCcnKTsKICB9CgogIGZ1bmN0aW9uIGJpbmRUeEV2ZW50cyhjb250YWluZXIpIHsKICAgIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCcudHgtY2F0JykuZm9yRWFjaCgocykgPT4gcy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHQgPSBTKCkudHJhbnNhY3Rpb25zLmZpbmQoKHgpID0+IHguaWQgPT09IHMuZGF0YXNldC5pZCk7CiAgICAgIGlmIChzLnZhbHVlLnN0YXJ0c1dpdGgoJ2tpbmQ6JykpIHsKICAgICAgICBhd2FpdCBidXN5KG51bGwsICgpID0+IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZDogcy52YWx1ZS5zbGljZSg1KSwgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsIH0pKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3Qga2V5ID0gTC5ub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBpZiAocy52YWx1ZSkgUygpLm1lcmNoYW50TWFwW2tleV0gPSBzLnZhbHVlOwogICAgICBlbHNlIGRlbGV0ZSBTKCkubWVyY2hhbnRNYXBba2V5XTsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS51cGRhdGVUcmFuc2FjdGlvbih0LmlkLCB7IGtpbmQ6ICdleHBlbnNlJywgY2F0ZWdvcnlJZDogcy52YWx1ZSB8fCBudWxsLCBtZXRob2Q6IHMudmFsdWUgPyAnbWFudWFsJyA6IG51bGwgfSkpOwogICAgICB0b2FzdChgJyR7dC5tZW1vfScg7J2AKOuKlCkg7JWe7Jy866GcICR7Y2F0ZWdvcnlJbmZvKHQuY2F0ZWdvcnlJZCwgcGxhbkZvckRhdGUodC5kYXRlKS5jYXRlZ29yaWVzKS5uYW1lfSjsnLwp66GcIOu2hOulmO2VqeuLiOuLpC5gKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KSkpOwogICAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50eC1kZWwnKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB0ID0gUygpLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBiLmRhdGFzZXQuaWQpOwogICAgICBpZiAoIWNvbmZpcm0oYCcke3QubWVtb30nICR7d29uKHQuYW1vdW50KX0g64K07Jet7J2EIOyCreygnO2VoOq5jOyalD9gKSkgcmV0dXJuOwogICAgICBhd2FpdCBidXN5KG51bGwsICgpID0+IHN0b3JlLmRlbGV0ZVRyYW5zYWN0aW9uKHQuaWQpKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KSkpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDtmYggLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJJbmNvbWVCb3goc3VtKSB7CiAgICBjb25zdCBib3ggPSAkKCcjaW5jb21lLWJveCcpOwogICAgY29uc3QgcHJldiA9IEwuc2hpZnRQZXJpb2QoY3VycmVudFBlcmlvZCwgLTEsIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICBjb25zdCBwcmV2SW5jb21lID0gUygpLmluY29tZXNbcHJldi5rZXldOwoKICAgIGlmICghc3VtLmhhc0luY29tZSB8fCBib3guZGF0YXNldC5lZGl0aW5nID09PSAnMScpIHsKICAgICAgYm94LmNsYXNzTGlzdC5hZGQoJ2luY29tZS1wcm9tcHQnKTsKICAgICAgY29uc3QgcmVjZWl2ZWQgPSBzdW0uaW5jb21lUmVjZWl2ZWQgPiAwID8gYDxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iZ2hvc3QtYnRuIiBpZD0iaW5jb21lLXJlY2VpdmVkIj7rsJvsnYAg7J6F6riIIO2VqeqzhOuhnCAoJHt3b24oc3VtLmluY29tZVJlY2VpdmVkKX0pPC9idXR0b24+YCA6ICcnOwogICAgICBib3guaW5uZXJIVE1MID0gYAogICAgICAgIDxoMj4ke3N1bS5oYXNJbmNvbWUgPyAn64u56riwIOyImOyehSjsmIjsgrApIOyImOyglScgOiAn7J2067KIIOq4sOqwhOyXkCDrk6TslrTsmKgg64+IKOyYiOyCsCnsnYQg7J6F66Cl7ZWY7IS47JqUJ308L2gyPgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+JHtmbXREYXRlKGN1cnJlbnRQZXJpb2Quc3RhcnQpfSDsl5Ag7Iuc7J6R7ZWY64qUIOq4sOqwhOydmCDsiJjsnoXsnoXri4jri6QuIOu5hOycqCDtla3rqqnsnZgg7ZWc64+E6rCAIOydtCDquIjslaHsl5Ag66ee7LawIOqzhOyCsOuQqeuLiOuLpC48L3A+CiAgICAgICAgPGZvcm0gY2xhc3M9ImluY29tZS1mb3JtIiBpZD0iaW5jb21lLWZvcm0iPgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlucHV0bW9kZT0ibnVtZXJpYyIgaWQ9ImluY29tZS1pbnB1dCIgcGxhY2Vob2xkZXI9IuyYiDogMywwMDAsMDAwIiB2YWx1ZT0iJHtzdW0uaGFzSW5jb21lID8gc3VtLmluY29tZS50b0xvY2FsZVN0cmluZygna28tS1InKSA6ICcnfSI+CiAgICAgICAgICA8YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7soIDsnqU8L2J1dHRvbj4KICAgICAgICAgICR7dHlwZW9mIHByZXZJbmNvbWUgPT09ICdudW1iZXInID8gYDxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iZ2hvc3QtYnRuIiBpZD0iaW5jb21lLXByZXYiPuyngOuCnCDquLDqsITqs7wg6rCZ6rKMICgke3dvbihwcmV2SW5jb21lKX0pPC9idXR0b24+YCA6ICcnfQogICAgICAgICAgJHtyZWNlaXZlZH0KICAgICAgICAgICR7c3VtLmhhc0luY29tZSA/ICc8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imdob3N0LWJ0biIgaWQ9ImluY29tZS1jYW5jZWwiPuy3qOyGjDwvYnV0dG9uPicgOiAnJ30KICAgICAgICA8L2Zvcm0+YDsKICAgICAgY29uc3QgaW5wdXQgPSAkKCcjaW5jb21lLWlucHV0Jyk7CiAgICAgIGZvcm1hdE9uQmx1cihpbnB1dCk7CiAgICAgICQoJyNpbmNvbWUtZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KGlucHV0LnZhbHVlKTsKICAgICAgICBpZiAobiA9PT0gbnVsbCB8fCBuIDwgMCkgcmV0dXJuIHRvYXN0KCfquIjslaHsnYQg7Iir7J6Q66GcIOyeheugpe2VtCDso7zshLjsmpQuJyk7CiAgICAgICAgc2V0SW5jb21lKG4pOwogICAgICB9KTsKICAgICAgY29uc3QgYmluZCA9IChpZCwgZm4pID0+ICQoaWQpICYmICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZm4pOwogICAgICBiaW5kKCcjaW5jb21lLXByZXYnLCAoKSA9PiBzZXRJbmNvbWUocHJldkluY29tZSkpOwogICAgICBiaW5kKCcjaW5jb21lLXJlY2VpdmVkJywgKCkgPT4gc2V0SW5jb21lKHN1bS5pbmNvbWVSZWNlaXZlZCkpOwogICAgICBiaW5kKCcjaW5jb21lLWNhbmNlbCcsICgpID0+IHsKICAgICAgICBib3guZGF0YXNldC5lZGl0aW5nID0gJyc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0pOwogICAgfSBlbHNlIHsKICAgICAgYm94LmNsYXNzTGlzdC5yZW1vdmUoJ2luY29tZS1wcm9tcHQnKTsKICAgICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgICA8ZGl2IGNsYXNzPSJpbmNvbWUtc2V0Ij4KICAgICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9Im11dGVkIHNtYWxsIj7ri7nquLAg7IiY7J6FKOyYiOyCsCk8L3NwYW4+PGRpdiBjbGFzcz0idmFsdWUiPiR7d29uKHN1bS5pbmNvbWUpfTwvZGl2PjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2hvc3QtYnRuIHNtYWxsLWJ0biIgaWQ9ImluY29tZS1lZGl0Ij7siJjsoJU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj5gOwogICAgICAkKCcjaW5jb21lLWVkaXQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBib3guZGF0YXNldC5lZGl0aW5nID0gJzEnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9KTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHNldEluY29tZShuKSB7CiAgICBTKCkuaW5jb21lc1tjdXJyZW50UGVyaW9kLmtleV0gPSBuOwogICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICQoJyNpbmNvbWUtYm94JykuZGF0YXNldC5lZGl0aW5nID0gJyc7CiAgICB0b2FzdCgn64u56riwIOyImOyeheydhCDsoIDsnqXtlojsirXri4jri6QuJyk7CiAgICByZW5kZXIoKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclN0YWxlQm94KHN1bSkgewogICAgY29uc3QgYm94ID0gJCgnI3N0YWxlLWJveCcpOwogICAgaWYgKCFzdW0uc3RhbGVDb3VudCB8fCAhc3VtLnBsYW4udXBkYXRlZEF0KSB7CiAgICAgIGJveC5pbm5lckhUTUwgPSAnJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgYm94LmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBub3RlLWNhcmQgd2Fybi1jYXJkIj4KICAgICAgICA8Yj7smIjsgrAg6rOE7ZqN7J20IOuwlOuAjOyXiOyWtOyalC48L2I+CiAgICAgICAgPHAgY2xhc3M9InNtYWxsIj7rsJTrgJAg6rOE7ZqN7JeQIOunnuy2sCDslYTsp4Eg64uk7IucIOu2hOulmO2VmOyngCDslYrsnYAg7KeA7Lac7J20ICR7c3VtLnN0YWxlQ291bnR96rG0IOyeiOyWtOyalC4g7KeB7KCRIOqzoOuluCDtla3rqqnsnYAg6re464yA66GcIOuRkOqzoCDrgpjrqLjsp4Drpbwg7IOIIO2VreuqqSDquLDspIDsnLzroZwg67aE66WY7ZWp64uI64ukLjwvcD4KICAgICAgICA8YnV0dG9uIGlkPSJzdGFsZS1yZWNsYXNzaWZ5IiBjbGFzcz0icHJpbWFyeS1idG4iPuyDiCDqs4Ttmo3snLzroZwg64uk7IucIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfTwvYnV0dG9uPgogICAgICA8L2Rpdj5gOwogICAgJCgnI3N0YWxlLXJlY2xhc3NpZnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KCgpID0+IHJ1blJlY2xhc3NpZnkoZmFsc2UpKSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJIb21lKCkgewogICAgY29uc3Qgc3VtID0gTC5zdW1tYXJpemVQZXJpb2QoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIHJlbmRlckluY29tZUJveChzdW0pOwogICAgcmVuZGVyU3RhbGVCb3goc3VtKTsKCiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGNvbnN0IGlzQ3VycmVudCA9IHRvZGF5ID49IGN1cnJlbnRQZXJpb2Quc3RhcnQgJiYgdG9kYXkgPD0gY3VycmVudFBlcmlvZC5lbmQ7CiAgICBjb25zdCBkYXlzTGVmdCA9IGlzQ3VycmVudCA/IEwuZGlmZkRheXModG9kYXksIGN1cnJlbnRQZXJpb2QuZW5kKSArIDEgOiAwOwogICAgY29uc3QgaGVybyA9ICQoJyNoZXJvJyk7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBjb25zdCByYXRpbyA9IHN1bS5pbmNvbWUgPiAwID8gc3VtLnRvdGFsU3BlbnQgLyBzdW0uaW5jb21lIDogc3VtLnRvdGFsU3BlbnQgPiAwID8gSW5maW5pdHkgOiAwOwogICAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHJhdGlvKTsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuuCqOydgCDrj4g8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUgJHtzdW0ucmVtYWluaW5nIDwgMCA/ICduZWdhdGl2ZScgOiAnJ30iPiR7d29uKHN1bS5yZW1haW5pbmcpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHt3b24oc3VtLmluY29tZSl9IOykkSAke3dvbihzdW0udG90YWxTcGVudCl9IOyCrOyaqSAoJHtzdW0uaW5jb21lID4gMCA/IE1hdGgucm91bmQocmF0aW8gKiAxMDApIDogMH0lKTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7c3RhdHVzfSIgcm9sZT0ibWV0ZXIiIGFyaWEtdmFsdWVtaW49IjAiIGFyaWEtdmFsdWVtYXg9IiR7c3VtLmluY29tZX0iIGFyaWEtdmFsdWVub3c9IiR7c3VtLnRvdGFsU3BlbnR9IiBhcmlhLWxhYmVsPSLsmIjsgrAg7IKs7JqpIj48ZGl2IGNsYXNzPSJtZXRlci1maWxsIiBzdHlsZT0id2lkdGg6JHtNYXRoLm1pbigxMDAsIHJhdGlvICogMTAwKX0lIj48L2Rpdj48L2Rpdj5gOwogICAgfSBlbHNlIHsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuydtOuyiCDquLDqsIQg7JO0IOuPiDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZ3VyZSI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+7IiY7J6F7J2EIOyeheugpe2VmOuptCDtla3rqqnrs4Qg7ZWc64+E7JmAIOuCqOydgCDrj4jsnYQg6rOE7IKw7ZW0IOuTnOugpOyalC48L2Rpdj5gOwogICAgfQoKICAgIGNvbnN0IHBlckRheSA9IGlzQ3VycmVudCAmJiBzdW0uaGFzSW5jb21lICYmIHN1bS5yZW1haW5pbmcgPiAwID8gd29uKE1hdGguZmxvb3Ioc3VtLnJlbWFpbmluZyAvIGRheXNMZWZ0KSkgOiAn4oCUJzsKICAgICQoJyNob21lLXN1bW1hcnknKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+7J2067KIIOq4sOqwhCDsp4Dstpw8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKHN1bS50b3RhbFNwZW50KX0gwrcgJHtzdW0udHJhbnNhY3Rpb25zLmxlbmd0aH3qsbQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+67Cb7J2AIOyeheq4iDwvc3Bhbj48c3BhbiBjbGFzcz0idiBwbHVzIj4ke3N1bS5pbmNvbWVSZWNlaXZlZCA/IGArJHt3b24oc3VtLmluY29tZVJlY2VpdmVkKX1gIDogJ+KAlCd9PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPu2VmOujqCDqtozsnqUg7IKs7Jqp7JWhPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3BlckRheX08L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+66+467aE66WYPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3N1bS51bmNsYXNzaWZpZWRDb3VudCA/IGAke3dvbihzdW0udW5jbGFzc2lmaWVkKX0gwrcgJHtzdW0udW5jbGFzc2lmaWVkQ291bnR96rG0YCA6ICfsl4bsnYwnfTwvc3Bhbj48L2Rpdj5gOwoKICAgIGxldCBub3RlID0gJyc7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBpZiAoc3VtLnVuYWxsb2NhdGVkID4gMCkgbm90ZSA9IGDrsLDrtoTrkJjsp4Ag7JWK7J2AIOuPiCAke3dvbihzdW0udW5hbGxvY2F0ZWQpfWA7CiAgICAgIGVsc2UgaWYgKHN1bS51bmFsbG9jYXRlZCA8IDApIG5vdGUgPSBg4pqgIOqzhO2ajeydtCDsiJjsnoXrs7Tri6QgJHt3b24oLXN1bS51bmFsbG9jYXRlZCl9IOunjuyVhOyalGA7CiAgICB9CiAgICAkKCcjYWxsb2Mtbm90ZScpLnRleHRDb250ZW50ID0gbm90ZTsKCiAgICBjb25zdCByb3dzRWwgPSAkKCcjY2F0ZWdvcnktcm93cycpOwogICAgaWYgKCFzdW0ucGxhbi5jYXRlZ29yaWVzLmxlbmd0aCkgewogICAgICByb3dzRWwuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7smIjsgrAg6rOE7ZqN7JeQ7IScIO2VreuqqeydhCDstpTqsIDtlZjshLjsmpQuPC9kaXY+JzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IHJvd3MgPSBzdW0ucm93cy5tYXAoKHIsIGkpID0+IGNhdGVnb3J5Um93KHIsIGksIHN1bS5oYXNJbmNvbWUpKTsKICAgICAgaWYgKHN1bS51bmNsYXNzaWZpZWRDb3VudCkgewogICAgICAgIHJvd3MucHVzaChgCiAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtcm93IiBkYXRhLWNhdD0iX19ub25lIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iY2F0LXRvcCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1ncmF5LW1hcmspIj48L3NwYW4+66+467aE66WYPHNwYW4gY2xhc3M9ImJhZGdlIj7tla3rqqkg7KeA7KCVIO2VhOyalDwvc3Bhbj48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1hbW91bnRzIj48Yj4ke3dvbihzdW0udW5jbGFzc2lmaWVkKX08L2I+IMK3ICR7c3VtLnVuY2xhc3NpZmllZENvdW50feqxtDwvc3Bhbj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj5gKTsKICAgICAgfQogICAgICByb3dzRWwuaW5uZXJIVE1MID0gcm93cy5qb2luKCcnKTsKICAgICAgcm93c0VsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jYXQtcm93JykuZm9yRWFjaCgoZWwpID0+IHsKICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICAgIE9iamVjdC5hc3NpZ24obGlzdFN0YXRlLCB7IGNhdGVnb3J5OiBlbC5kYXRhc2V0LmNhdCwga2luZDogJ2FsbCcsIGFjY291bnQ6ICdhbGwnLCBzZWFyY2g6ICcnIH0pOwogICAgICAgICAgc2hvd1BhZ2UoJ2xpc3QnKTsKICAgICAgICB9KTsKICAgICAgICBjb25zdCByID0gc3VtLnJvd3MuZmluZCgoeCkgPT4geC5jYXRlZ29yeS5pZCA9PT0gZWwuZGF0YXNldC5jYXQpOwogICAgICAgIGlmIChyKSBhdHRhY2hUb29sdGlwKGVsLnF1ZXJ5U2VsZWN0b3IoJy5tZXRlcicpLCAoKSA9PiBgCiAgICAgICAgICA8c3Ryb25nPiR7ZXNjKHIuY2F0ZWdvcnkubmFtZSl9PC9zdHJvbmc+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+7ZWc64+EPC9zcGFuPjxzcGFuPiR7d29uKHIuYnVkZ2V0KX08L3NwYW4+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+7IKs7JqpPC9zcGFuPjxzcGFuPiR7d29uKHIuc3BlbnQpfTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj4ke3IucmVtYWluaW5nID49IDAgPyAn64Ko7J2MJyA6ICfstIjqs7wnfTwvc3Bhbj48c3Bhbj4ke3dvbihNYXRoLmFicyhyLnJlbWFpbmluZykpfTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj7qsbTsiJg8L3NwYW4+PHNwYW4+JHtyLmNvdW50feqxtDwvc3Bhbj48L2Rpdj5gKTsKICAgICAgfSk7CiAgICB9CgogICAgY29uc3QgcmVjZW50ID0gWy4uLnN1bS5hbGxUcmFuc2FjdGlvbnNdLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgKyAoYS5jcmVhdGVkQXQgfHwgJycpIDwgYi5kYXRlICsgKGIuY3JlYXRlZEF0IHx8ICcnKSA/IDEgOiAtMSkpLnNsaWNlKDAsIDUpOwogICAgJCgnI3JlY2VudC1saXN0JykuaW5uZXJIVE1MID0gcmVjZW50Lmxlbmd0aCA/IHJlY2VudC5tYXAoKHQpID0+IHR4Um93KHQsIHsgZWRpdGFibGU6IGZhbHNlIH0pKS5qb2luKCcnKSA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7J20IOq4sOqwhCDrgrTsl63snbQg7JeG7Iq164uI64ukLjwvZGl2Pic7CgogICAgY29uc3QgYXNzZXRzID0gTC5hc3NldFN1bW1hcnkoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgICQoJyNob21lLWFzc2V0cycpLmlubmVySFRNTCA9IGFzc2V0cy5iYW5rcy5sZW5ndGggfHwgYXNzZXRzLmNhcmRzLmxlbmd0aAogICAgICA/IGA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPuqzhOyijCDsnpTslaEg7ZWp6rOEPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3dvbihhc3NldHMudG90YWwpfTwvc3Bhbj48L2Rpdj4KICAgICAgICAgJHthc3NldHMuc2F2aW5ncyA/IGA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPuq3uOykkSDsoIDstpU8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7d29uKGFzc2V0cy5zYXZpbmdzKX08L3NwYW4+PC9kaXY+YCA6ICcnfQogICAgICAgICAke2Fzc2V0cy5jYXJkcy5tYXAoKGMpID0+IGA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4gY2xhc3M9ImsiPiR7ZXNjKGFjY291bnROYW1lKGMuaWQpKX0gKOydtOuyiCDquLDqsIQpPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3dvbihjLnNwZW50KX08L3NwYW4+PC9kaXY+YCkuam9pbignJyl9YAogICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+7ISk7KCV7JeQ7IScIOqzhOyijMK37Lm065Oc66W8IOuTseuhne2VmOuptCDsnpTslaHqs7wg7Lm065Oc67OEIOyCrOyaqeyVoeydhCDrs7Tsl6zrk5zroKTsmpQuPC9kaXY+JzsKICB9CgogIGZ1bmN0aW9uIGNhdGVnb3J5Um93KHIsIGluZGV4LCBoYXNJbmNvbWUpIHsKICAgIGNvbnN0IGMgPSByLmNhdGVnb3J5OwogICAgY29uc3QgYmFkZ2UgPSBjLnR5cGUgPT09ICdmaXhlZCcgPyBg6rOg7KCVICR7d29uKGMudmFsdWUpfWAgOiBg7IiY7J6F7J2YICR7Yy52YWx1ZX0lYDsKICAgIGNvbnN0IHN0YXR1cyA9IEwuc3RhdHVzT2Yoci5yYXRpbyk7CiAgICBjb25zdCBwY3QgPSByLmJ1ZGdldCA+IDAgPyBNYXRoLnJvdW5kKHIucmF0aW8gKiAxMDApIDogbnVsbDsKICAgIGNvbnN0IHdpZHRoID0gci5idWRnZXQgPiAwID8gTWF0aC5taW4oMTAwLCByLnJhdGlvICogMTAwKSA6IHIuc3BlbnQgPiAwID8gMTAwIDogMDsKICAgIGNvbnN0IG5vQnVkZ2V0ID0gYy50eXBlID09PSAncmF0aW8nICYmICFoYXNJbmNvbWU7CgogICAgbGV0IHN0YXR1c1RleHQ7CiAgICBpZiAobm9CdWRnZXQpIHN0YXR1c1RleHQgPSAn7IiY7J6FIOyeheugpSDsoIQnOwogICAgZWxzZSBpZiAoc3RhdHVzID09PSAnY3JpdGljYWwnKSBzdGF0dXNUZXh0ID0gYOKaoCDstIjqs7wgJHtwY3QgPT09IG51bGwgPyAnJyA6IGAoJHtwY3R9JSlgfWA7CiAgICBlbHNlIGlmIChzdGF0dXMgPT09ICd3YXJuaW5nJykgc3RhdHVzVGV4dCA9IHBjdCA9PT0gMTAwID8gJ+2VnOuPhCDrj4Tri6wgMTAwJScgOiBgISDso7zsnZggJHtwY3R9JWA7CiAgICBlbHNlIHN0YXR1c1RleHQgPSBwY3QgPT09IG51bGwgPyAnJyA6IGAke3BjdH0lIOyCrOyaqWA7CgogICAgY29uc3QgcmVtYWluID0gbm9CdWRnZXQKICAgICAgPyAnJwogICAgICA6IHIucmVtYWluaW5nID49IDAKICAgICAgICA/IGA8c3BhbiBjbGFzcz0icmVtYWluLWdvb2QiPiR7d29uKHIucmVtYWluaW5nKX0g64Ko7J2MPC9zcGFuPmAKICAgICAgICA6IGA8c3BhbiBjbGFzcz0icmVtYWluLWJhZCI+JHt3b24oLXIucmVtYWluaW5nKX0g7LSI6rO8PC9zcGFuPmA7CgogICAgcmV0dXJuIGAKICAgICAgPGRpdiBjbGFzcz0iY2F0LXJvdyIgZGF0YS1jYXQ9IiR7ZXNjKGMuaWQpfSI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2F0LXRvcCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iY2F0LW5hbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiR7Qy5zZXJpZXNDb2xvcihpbmRleCl9Ij48L3NwYW4+JHtlc2MoYy5uYW1lKX08c3BhbiBjbGFzcz0iYmFkZ2UiPiR7ZXNjKGJhZGdlKX08L3NwYW4+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1hbW91bnRzIj48Yj4ke3dvbihyLnNwZW50KX08L2I+IC8gJHtub0J1ZGdldCA/ICfigJQnIDogd29uKHIuYnVkZ2V0KX08L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0ZXIgJHtub0J1ZGdldCA/ICcnIDogc3RhdHVzfSIgcm9sZT0ibWV0ZXIiIGFyaWEtdmFsdWVtaW49IjAiIGFyaWEtdmFsdWVtYXg9IiR7ci5idWRnZXR9IiBhcmlhLXZhbHVlbm93PSIke3Iuc3BlbnR9IiBhcmlhLWxhYmVsPSIke2VzYyhjLm5hbWUpfSDsgqzsmqnslaEiPgogICAgICAgICAgPGRpdiBjbGFzcz0ibWV0ZXItZmlsbCIgc3R5bGU9IndpZHRoOiR7d2lkdGh9JSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2F0LWJvdHRvbSI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzICR7bm9CdWRnZXQgPyAnJyA6IHN0YXR1c30iPiR7c3RhdHVzVGV4dH08L3NwYW4+CiAgICAgICAgICAke3JlbWFpbn0KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+YDsKICB9CgogIC8vIC0tLS0tLS0tLS0g64us66ClIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQ2FsZW5kYXIoKSB7CiAgICBjb25zdCBwID0gY3VycmVudFBlcmlvZDsKICAgIGNvbnN0IHN1bSA9IEwuc3VtbWFyaXplUGVyaW9kKFMoKSwgcCk7CiAgICBjb25zdCBkYXlzID0gTC5kYWlseVRvdGFscyhzdW0uYWxsVHJhbnNhY3Rpb25zKTsKICAgIGNvbnN0IHRvZGF5ID0gTC50b2RheUlTTygpOwogICAgaWYgKCFzZWxlY3RlZERhdGUgfHwgc2VsZWN0ZWREYXRlIDwgcC5zdGFydCB8fCBzZWxlY3RlZERhdGUgPiBwLmVuZCkgc2VsZWN0ZWREYXRlID0gdG9kYXkgPj0gcC5zdGFydCAmJiB0b2RheSA8PSBwLmVuZCA/IHRvZGF5IDogcC5zdGFydDsKCiAgICAkKCcjY2FsLXN1bW1hcnknKS5pbm5lckhUTUwgPSBgCiAgICAgIDxzcGFuPuyngOy2nCA8Yj4ke3dvbihzdW0udG90YWxTcGVudCl9PC9iPjwvc3Bhbj4KICAgICAgPHNwYW4gY2xhc3M9InBsdXMiPuyeheq4iCA8Yj4ke3N1bS5pbmNvbWVSZWNlaXZlZCA/IGArJHt3b24oc3VtLmluY29tZVJlY2VpdmVkKX1gIDogJzDsm5AnfTwvYj48L3NwYW4+CiAgICAgICR7c3VtLmhhc0luY29tZSA/IGA8c3Bhbj7rgqjsnYAg64+IIDxiPiR7d29uKHN1bS5yZW1haW5pbmcpfTwvYj48L3NwYW4+YCA6ICcnfWA7CgogICAgY29uc3QgbWF4U3BlbnQgPSBNYXRoLm1heCgwLCAuLi5PYmplY3QudmFsdWVzKGRheXMpLm1hcCgoZCkgPT4gZC5zcGVudCkpOwogICAgY29uc3QgZmlyc3QgPSBMLmFkZERheXMocC5zdGFydCwgLWRvd09mKHAuc3RhcnQpKTsKICAgIGNvbnN0IGxhc3QgPSBMLmFkZERheXMocC5lbmQsIDYgLSBkb3dPZihwLmVuZCkpOwogICAgY29uc3QgY2VsbHMgPSBET1cubWFwKCh3LCBpKSA9PiBgPGRpdiBjbGFzcz0iY2FsLWRvdyAke2kgPT09IDAgPyAnc3VuJyA6ICcnfSI+JHt3fTwvZGl2PmApOwogICAgZm9yIChsZXQgY3Vyc29yID0gZmlyc3Q7IGN1cnNvciA8PSBsYXN0OyBjdXJzb3IgPSBMLmFkZERheXMoY3Vyc29yLCAxKSkgewogICAgICBjb25zdCBpblBlcmlvZCA9IGN1cnNvciA+PSBwLnN0YXJ0ICYmIGN1cnNvciA8PSBwLmVuZDsKICAgICAgY29uc3QgaW5mbyA9IGRheXNbY3Vyc29yXSB8fCB7IHNwZW50OiAwLCBpbmNvbWU6IDAgfTsKICAgICAgY29uc3QgcSA9IEwucGFyc2VJU08oY3Vyc29yKTsKICAgICAgY29uc3QgbGFiZWwgPSBxLmQgPT09IDEgfHwgY3Vyc29yID09PSBwLnN0YXJ0ID8gYCR7cS5tfS8ke3EuZH1gIDogcS5kOwogICAgICBsZXQgaGVhdCA9ICcnOwogICAgICBpZiAoaW5QZXJpb2QgJiYgaW5mby5zcGVudCA+IDAgJiYgbWF4U3BlbnQgPiAwKSBoZWF0ID0gYGgke01hdGgubWluKDMsIE1hdGguY2VpbCgoaW5mby5zcGVudCAvIG1heFNwZW50KSAqIDMpKX1gOwogICAgICBjZWxscy5wdXNoKGluUGVyaW9kCiAgICAgICAgPyBgPGJ1dHRvbiBjbGFzcz0iY2FsLWRheSAke2hlYXR9ICR7Y3Vyc29yID09PSB0b2RheSA/ICd0b2RheScgOiAnJ30gJHtjdXJzb3IgPT09IHNlbGVjdGVkRGF0ZSA/ICdzZWxlY3RlZCcgOiAnJ30iIGRhdGEtZGF0ZT0iJHtjdXJzb3J9IiBhcmlhLWxhYmVsPSIke2ZtdERheShjdXJzb3IpfSDsp4DstpwgJHt3b24oaW5mby5zcGVudCl9Ij4KICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjYWwtbnVtIj4ke2xhYmVsfTwvc3Bhbj4KICAgICAgICAgICAgICR7aW5mby5zcGVudCA/IGA8c3BhbiBjbGFzcz0iY2FsLXNwZW50Ij4tJHtDLnRpbnlXb24oaW5mby5zcGVudCl9PC9zcGFuPmAgOiAnJ30KICAgICAgICAgICAgICR7aW5mby5pbmNvbWUgPyBgPHNwYW4gY2xhc3M9ImNhbC1pbmNvbWUiPiske0MudGlueVdvbihpbmZvLmluY29tZSl9PC9zcGFuPmAgOiAnJ30KICAgICAgICAgICA8L2J1dHRvbj5gCiAgICAgICAgOiBgPGRpdiBjbGFzcz0iY2FsLWRheSBvdXQiPjxzcGFuIGNsYXNzPSJjYWwtbnVtIj4ke2xhYmVsfTwvc3Bhbj48L2Rpdj5gKTsKICAgIH0KICAgIGNvbnN0IGNhbCA9ICQoJyNjYWxlbmRhcicpOwogICAgY2FsLmlubmVySFRNTCA9IGNlbGxzLmpvaW4oJycpOwogICAgY2FsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jYWwtZGF5W2RhdGEtZGF0ZV0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBzZWxlY3RlZERhdGUgPSBiLmRhdGFzZXQuZGF0ZTsKICAgICAgcmVuZGVyQ2FsZW5kYXIoKTsKICAgIH0pKTsKCiAgICBjb25zdCBkYXlUeHMgPSBzdW0uYWxsVHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gdC5kYXRlID09PSBzZWxlY3RlZERhdGUpOwogICAgJCgnI2RheS10aXRsZScpLnRleHRDb250ZW50ID0gZm10RGF5KHNlbGVjdGVkRGF0ZSk7CiAgICBjb25zdCBpbmZvID0gZGF5c1tzZWxlY3RlZERhdGVdOwogICAgJCgnI2RheS10b3RhbCcpLnRleHRDb250ZW50ID0gaW5mbyA/IGDsp4DstpwgJHt3b24oaW5mby5zcGVudCl9JHtpbmZvLmluY29tZSA/IGAgwrcg7J6F6riIICR7d29uKGluZm8uaW5jb21lKX1gIDogJyd9YCA6ICcnOwogICAgY29uc3QgbGlzdCA9ICQoJyNkYXktbGlzdCcpOwogICAgbGlzdC5pbm5lckhUTUwgPSBkYXlUeHMubGVuZ3RoID8gZGF5VHhzLm1hcCgodCkgPT4gdHhSb3codCkpLmpvaW4oJycpIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7snbTrgqDsnYAg64K07Jet7J20IOyXhuyWtOyalC48L2Rpdj4nOwogICAgYmluZFR4RXZlbnRzKGxpc3QpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrgrTsl60gLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJMaXN0KCkgewogICAgY29uc3Qgc3VtID0gTC5zdW1tYXJpemVQZXJpb2QoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IGNhdHMgPSBzdW0ucGxhbi5jYXRlZ29yaWVzOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdHMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBpZiAobGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnYWxsJyAmJiBsaXN0U3RhdGUuY2F0ZWdvcnkgIT09ICdfX25vbmUnICYmICFrbm93bi5oYXMobGlzdFN0YXRlLmNhdGVnb3J5KSkgbGlzdFN0YXRlLmNhdGVnb3J5ID0gJ2FsbCc7CgogICAgJCgnI2xpc3QtZmlsdGVyJykuaW5uZXJIVE1MID0gYDxvcHRpb24gdmFsdWU9ImFsbCI+66qo65OgIO2VreuqqTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9Il9fbm9uZSI+66+467aE66WYPC9vcHRpb24+YCArCiAgICAgIGNhdHMubWFwKChjKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2MoYy5pZCl9Ij4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpOwogICAgJCgnI2xpc3QtZmlsdGVyJykudmFsdWUgPSBsaXN0U3RhdGUuY2F0ZWdvcnk7CiAgICAkKCcjbGlzdC1hY2NvdW50JykuaW5uZXJIVE1MID0gYDxvcHRpb24gdmFsdWU9ImFsbCI+66qo65OgIOqysOygnOyImOuLqDwvb3B0aW9uPmAgKwogICAgICBTKCkuYWNjb3VudHMubWFwKChhKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2MoYS5pZCl9Ij4ke2VzYyhhY2NvdW50TmFtZShhLmlkKSl9PC9vcHRpb24+YCkuam9pbignJyk7CiAgICAkKCcjbGlzdC1hY2NvdW50JykudmFsdWUgPSBTKCkuYWNjb3VudHMuc29tZSgoYSkgPT4gYS5pZCA9PT0gbGlzdFN0YXRlLmFjY291bnQpID8gbGlzdFN0YXRlLmFjY291bnQgOiAnYWxsJzsKICAgICQoJyNsaXN0LWtpbmQnKS52YWx1ZSA9IGxpc3RTdGF0ZS5raW5kOwogICAgJCgnI2xpc3Qtc2VhcmNoJykudmFsdWUgPSBsaXN0U3RhdGUuc2VhcmNoOwogICAgJCgnI3JlY2xhc3NpZnktYWxsJykudGV4dENvbnRlbnQgPSBg7J20IOq4sOqwhCDsoITssrQg64uk7IucIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfWA7CgogICAgY29uc3QgcSA9IEwubm9ybWFsaXplTWVyY2hhbnQobGlzdFN0YXRlLnNlYXJjaCk7CiAgICBjb25zdCB0eHMgPSBzdW0uYWxsVHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gewogICAgICBjb25zdCBraW5kID0gTC5raW5kT2YodCk7CiAgICAgIGlmIChsaXN0U3RhdGUua2luZCAhPT0gJ2FsbCcgJiYga2luZCAhPT0gbGlzdFN0YXRlLmtpbmQpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKGxpc3RTdGF0ZS5jYXRlZ29yeSA9PT0gJ19fbm9uZScgJiYgKGtpbmQgIT09ICdleHBlbnNlJyB8fCBrbm93bi5oYXModC5jYXRlZ29yeUlkKSkpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKGxpc3RTdGF0ZS5jYXRlZ29yeSAhPT0gJ2FsbCcgJiYgbGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnX19ub25lJyAmJiB0LmNhdGVnb3J5SWQgIT09IGxpc3RTdGF0ZS5jYXRlZ29yeSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAobGlzdFN0YXRlLmFjY291bnQgIT09ICdhbGwnICYmIHQuYWNjb3VudElkICE9PSBsaXN0U3RhdGUuYWNjb3VudCkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAocSAmJiAhTC5ub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pLmluY2x1ZGVzKHEpKSByZXR1cm4gZmFsc2U7CiAgICAgIHJldHVybiB0cnVlOwogICAgfSk7CgogICAgY29uc3Qgc3BlbnQgPSB0eHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CiAgICBjb25zdCBpbmMgPSB0eHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2luY29tZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgICQoJyNsaXN0LXRvdGFsJykuaW5uZXJIVE1MID0gYDxzcGFuPiR7dHhzLmxlbmd0aH3qsbQ8L3NwYW4+PHNwYW4+7KeA7LacIDxiPiR7d29uKHNwZW50KX08L2I+PC9zcGFuPiR7aW5jID8gYDxzcGFuPuyeheq4iCA8Yj4rJHt3b24oaW5jKX08L2I+PC9zcGFuPmAgOiAnJ31gOwoKICAgIGNvbnN0IGVsID0gJCgnI3R4LWxpc3QnKTsKICAgIGVsLmlubmVySFRNTCA9IHR4cy5sZW5ndGggPyB0eEdyb3Vwcyh0eHMpIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7sobDqsbTsl5Ag66ee64qUIOuCtOyXreydtCDsl4bsirXri4jri6QuPC9kaXY+JzsKICAgIGJpbmRUeEV2ZW50cyhlbCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBydW5SZWNsYXNzaWZ5KG9ubHlVbmNsYXNzaWZpZWQpIHsKICAgIGNvbnN0IGxhYmVsID0gc3RvcmUuYWlFbmFibGVkID8gJ0FJ6rCAIOuLpOyLnCDrtoTrpZjtlZjripQg7KSR4oCmJyA6ICfri6Tsi5wg67aE66WY7ZWY64qUIOykkeKApic7CiAgICBjb25zdCBuID0gYXdhaXQgYnVzeShsYWJlbCwgKCkgPT4gc3RvcmUucmVjbGFzc2lmeShjdXJyZW50UGVyaW9kLCBvbmx5VW5jbGFzc2lmaWVkKSk7CiAgICB0b2FzdChuID8gYCR7bn3qsbTsnYQg64uk7IucIOu2hOulmO2WiOyKteuLiOuLpC5gIDogJ+uLpOyLnCDrtoTrpZjtlaAg7KeA7Lac7J20IOyXhuyKteuLiOuLpC4nKTsKICAgIHJlbmRlcigpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrpqztj6ztirggLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBwZXJpb2RMYWJlbChwKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08ocC5zdGFydCk7CiAgICByZXR1cm4gUygpLnNldHRpbmdzLnN0YXJ0RGF5ID09PSAxID8gYCR7bX3sm5RgIDogYCR7bX0vJHtkfWA7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZXBvcnQoKSB7CiAgICBjb25zdCBjbXAgPSBMLmNvbXBhcmVXaXRoUHJldmlvdXMoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IHN1bSA9IGNtcC5jdXJyZW50OwogICAgY29uc3QgZGlmZiA9IGNtcC50b3RhbERpZmY7CiAgICBjb25zdCBwcmV2U3BlbnQgPSBjbXAucHJldmlvdXMudG90YWxTcGVudDsKICAgIGxldCBkZWx0YVRleHQ7CiAgICBpZiAoIXByZXZTcGVudCAmJiAhc3VtLnRvdGFsU3BlbnQpIGRlbHRhVGV4dCA9ICfslYTsp4Eg7KeA7Lac7J20IOyXhuyWtOyalC4nOwogICAgZWxzZSBpZiAoIXByZXZTcGVudCkgZGVsdGFUZXh0ID0gJ+yngOuCnCDquLDqsIQg6riw66Gd7J20IOyXhuyWtCDruYTqtZDtlaAg7IiYIOyXhuyWtOyalC4nOwogICAgZWxzZSBpZiAoZGlmZiA+IDApIGRlbHRhVGV4dCA9IGDsp4Drgpwg6riw6rCE67O064ukIDxiPiR7d29uKGRpZmYpfSDrjZQ8L2I+IOyNvOyWtOyalCDilrJgOwogICAgZWxzZSBpZiAoZGlmZiA8IDApIGRlbHRhVGV4dCA9IGDsp4Drgpwg6riw6rCE67O064ukIDxiPiR7d29uKC1kaWZmKX0g642cPC9iPiDsjbzslrTsmpQg4pa8YDsKICAgIGVsc2UgZGVsdGFUZXh0ID0gJ+yngOuCnCDquLDqsITqs7wg65iR6rCZ7J20IOyNvOyWtOyalC4nOwogICAgY29uc3QgYnVkZ2V0TGluZSA9IHN1bS5oYXNJbmNvbWUgJiYgc3VtLmluY29tZSA+IDAgPyBgPGRpdiBjbGFzcz0iZGVsdGEiPuyYiOyCsOydmCA8Yj4ke01hdGgucm91bmQoKHN1bS50b3RhbFNwZW50IC8gc3VtLmluY29tZSkgKiAxMDApfSU8L2I+IOyCrOyaqTwvZGl2PmAgOiAnJzsKICAgICQoJyNyZXBvcnQtaGVhZGxpbmUnKS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9Im11dGVkIHNtYWxsIj7snbTrsogg6riw6rCEIOyngOy2nDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoZWFkbGluZS1maWd1cmUiPiR7d29uKHN1bS50b3RhbFNwZW50KX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZGVsdGEiPiR7ZGVsdGFUZXh0fTwvZGl2PgogICAgICAke2J1ZGdldExpbmV9YDsKCiAgICBjb25zdCB0b3AgPSBMLnRvcE1lcmNoYW50cyhzdW0uYWxsVHJhbnNhY3Rpb25zLCA1KTsKICAgICQoJyNyZXBvcnQtbWVyY2hhbnRzJykuaW5uZXJIVE1MID0gYDxoMj7rp47snbQg7JO0IOqzszwvaDI+JHt0b3AubGVuZ3RoCiAgICAgID8gdG9wLm1hcCgobSwgaSkgPT4gYDxkaXYgY2xhc3M9InJhbmsiPjxzcGFuIGNsYXNzPSJuIj4ke2kgKyAxfTwvc3Bhbj48c3BhbiBjbGFzcz0ibSI+JHtlc2MobS5tZW1vKX0gPHNwYW4gY2xhc3M9Im11dGVkIHNtYWxsIj4ke20uY291bnR97ZqMPC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz0iYSI+JHt3b24obS50b3RhbCl9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7sp4DstpzsnbQg7JeG7Ja07JqULjwvZGl2Pid9YDsKCiAgICBjb25zdCByb3dzID0gTC5jYXRlZ29yeUJyZWFrZG93bihzdW0pOwogICAgY29uc3QgZGlmZkJ5SWQgPSB7fTsKICAgIGZvciAoY29uc3QgciBvZiBjbXAucm93cykgZGlmZkJ5SWRbci5pZF0gPSByLmRpZmY7CiAgICBjb25zdCBzaGFyZSA9ICQoJyNyZXBvcnQtc2hhcmUnKTsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgc2hhcmUuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7snbQg6riw6rCEIOyngOy2nOydtCDsl4bslrTsmpQuPC9kaXY+JzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGZtdERpZmYgPSAoZCkgPT4gKGQgPT09IHVuZGVmaW5lZCA/ICcnIDogZCA+IDAgPyBg4payICR7d29uKGQpfWAgOiBkIDwgMCA/IGDilrwgJHt3b24oLWQpfWAgOiAn67OA64+ZIOyXhuydjCcpOwogICAgICBzaGFyZS5pbm5lckhUTUwgPSBDLnNoYXJlQmFyKHJvd3MpICsgcm93cy5tYXAoKHIpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJzaGFyZS1yb3ciPgogICAgICAgICAgPHNwYW4gY2xhc3M9InNoYXJlLW5hbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiR7Qy5zZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpfSI+PC9zcGFuPjxzcGFuPiR7ZXNjKHIubmFtZSl9IDxzcGFuIGNsYXNzPSJtdXRlZCBzbWFsbCI+JHtNYXRoLnJvdW5kKHIuc2hhcmUgKiAxMDApfSU8L3NwYW4+PC9zcGFuPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzaGFyZS1hbW91bnQiPiR7d29uKHIuYW1vdW50KX08L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic2hhcmUtZGlmZiIgdGl0bGU9IuyngOuCnCDquLDqsIQg64yA67mEIj4ke2ZtdERpZmYoZGlmZkJ5SWRbci5pZF0pfTwvc3Bhbj4KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKTsKICAgICAgY29uc3Qgc2VncyA9IEMuc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgICAgc2hhcmUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtc2VnXScpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgICAgY29uc3QgcyA9IHNlZ3NbZWwuZGF0YXNldC5zZWddOwogICAgICAgIGF0dGFjaFRvb2x0aXAoZWwsICgpID0+IGA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPiR7ZXNjKHMubmFtZSl9PC9zcGFuPjxzcGFuPiR7d29uKHMuYW1vdW50KX08L3NwYW4+PC9kaXY+YCk7CiAgICAgIH0pOwogICAgfQoKICAgIGNvbnN0IHRyID0gTC50cmVuZChTKCksIGN1cnJlbnRQZXJpb2QsIDYpOwogICAgY29uc3QgZGF0YSA9IHRyLm1hcCgoeCkgPT4gKHsgbGFiZWw6IHBlcmlvZExhYmVsKHgucGVyaW9kKSwgaW5jb21lOiB4LmJ1ZGdldEluY29tZSAhPT0gbnVsbCA/IHguYnVkZ2V0SW5jb21lIDogeC5pbmNvbWVSZWNlaXZlZCwgc3BlbnQ6IHguc3BlbnQgfSkpOwogICAgY29uc3QgdHJlbmRFbCA9ICQoJyNyZXBvcnQtdHJlbmQnKTsKICAgIHRyZW5kRWwuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmQiPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMxKSI+PC9zcGFuPuyImOyehTwvc3Bhbj48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1zMikiPjwvc3Bhbj7sp4Dstpw8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0Ij4ke0MudHJlbmRDaGFydChkYXRhKX08L2Rpdj5gOwogICAgdHJlbmRFbC5xdWVyeVNlbGVjdG9yQWxsKCcuaGl0JykuZm9yRWFjaCgoZWwpID0+IHsKICAgICAgY29uc3QgaSA9IE51bWJlcihlbC5kYXRhc2V0LmkpOwogICAgICBjb25zdCB4ID0gdHJbaV07CiAgICAgIGF0dGFjaFRvb2x0aXAoZWwsICgpID0+IGAKICAgICAgICA8c3Ryb25nPiR7Zm10RGF0ZSh4LnBlcmlvZC5zdGFydCl9IH48L3N0cm9uZz4KICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tczEpIj48L3NwYW4+7IiY7J6FJHt4LmJ1ZGdldEluY29tZSA9PT0gbnVsbCA/ICcgKOuwm+ydgCDsnoXquIgpJyA6ICcnfTwvc3Bhbj48c3Bhbj4ke3dvbihkYXRhW2ldLmluY29tZSB8fCAwKX08L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMyKSI+PC9zcGFuPuyngOy2nDwvc3Bhbj48c3Bhbj4ke3dvbih4LnNwZW50KX08L3NwYW4+PC9kaXY+YCk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGN1cnJlbnRQZXJpb2QgPSB4LnBlcmlvZDsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6Q7IKwIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQXNzZXRzKCkgewogICAgY29uc3QgYSA9IEwuYXNzZXRTdW1tYXJ5KFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICBjb25zdCBoYXNCYWxhbmNlID0gYS5iYW5rcy5zb21lKChiKSA9PiB0eXBlb2YgYi5iYWxhbmNlID09PSAnbnVtYmVyJyk7CiAgICAkKCcjYXNzZXQtaGVybycpLmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPuqzhOyijCDsnpTslaEg7ZWp6rOEPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZ3VyZSI+JHtoYXNCYWxhbmNlID8gd29uKGEudG90YWwpIDogJ+KAlCd9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHthLnNhdmluZ3MgPyBg7KCA7LaVIOqzhOyijCAke3dvbihhLnNhdmluZ3MpfSDCtyBgIDogJyd965Ox66Gd7ZWcIOqzhOyijCAke2EuYmFua3MubGVuZ3RofeqwnCwg7Lm065OcICR7YS5jYXJkcy5sZW5ndGh96rCcPC9kaXY+YDsKCiAgICBjb25zdCBiYW5rcyA9ICQoJyNhc3NldC1iYW5rcycpOwogICAgYmFua3MuaW5uZXJIVE1MID0gYS5iYW5rcy5sZW5ndGgKICAgICAgPyBhLmJhbmtzLm1hcCgoYikgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9ImFjY3QiPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1pY29uIj4ke2VzYygoYi5uYW1lIHx8ICfqs4TsoownKS5zbGljZSgwLCAxKSl9PC9kaXY+CiAgICAgICAgICA8ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+JHtlc2MoYWNjb3VudE5hbWUoYi5pZCkpfTwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7rgZ3snpDrpqwgJHtlc2MoYi5sYXN0NCB8fCAnLS0tLScpfSR7Yi5pc1NhdmluZ3MgPyAnIMK3IOyggOy2lScgOiAnJ30ke2Iuc3BlbnQgPyBgIMK3IOydtOuyiCDquLDqsIQg7Lac6riIICR7d29uKGIuc3BlbnQpfWAgOiAnJ308L2Rpdj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3R5cGVvZiBiLmJhbGFuY2UgPT09ICdudW1iZXInID8gd29uKGIuYmFsYW5jZSkgOiAnPHNwYW4gY2xhc3M9Im11dGVkIj7snpTslaEg66+47J6F66ClPC9zcGFuPid9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3Qtc3ViIj4ke2IuYmFsYW5jZUF0ID8gYCR7Zm10RGF0ZVRpbWUoYi5iYWxhbmNlQXQpfSDquLDspIAgYCA6ICcnfTxidXR0b24gY2xhc3M9ImxpbmsgZWRpdC1iYWxhbmNlIiBkYXRhLWlkPSIke2VzYyhiLmlkKX0iPuyImOyglTwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDqs4TsoozqsIAg7JeG7Ja07JqULiA8YnV0dG9uIGNsYXNzPSJsaW5rIiBkYXRhLWdvdG89InNldHRpbmdzIj7qs4Tsoowg65Ox66Gd7ZWY6riwPC9idXR0b24+PC9kaXY+JzsKICAgIGJhbmtzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5lZGl0LWJhbGFuY2UnKS5mb3JFYWNoKChidG4pID0+IGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgY29uc3QgYWNjID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGJ0bi5kYXRhc2V0LmlkKTsKICAgICAgY29uc3QgdiA9IHByb21wdChgJHthY2NvdW50TmFtZShhY2MuaWQpfSDsnZgg7ZiE7J6sIOyelOyVoSjsm5ApYCwgdHlwZW9mIGFjYy5iYWxhbmNlID09PSAnbnVtYmVyJyA/IFN0cmluZyhhY2MuYmFsYW5jZSkgOiAnJyk7CiAgICAgIGlmICh2ID09PSBudWxsKSByZXR1cm47CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KHYpOwogICAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIHRvYXN0KCfsiKvsnpDroZwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgICAgYWNjLmJhbGFuY2UgPSBuOwogICAgICBhY2MuYmFsYW5jZUF0ID0gbm93SVNPKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpOwoKICAgICQoJyNhc3NldC1jYXJkcycpLmlubmVySFRNTCA9IGEuY2FyZHMubGVuZ3RoCiAgICAgID8gYS5jYXJkcy5tYXAoKGMpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtaWNvbiBpcy1jYXJkIj4ke2VzYygoYy5uYW1lIHx8ICfsubTrk5wnKS5zbGljZSgwLCAxKSl9PC9kaXY+CiAgICAgICAgICA8ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+JHtlc2MoYWNjb3VudE5hbWUoYy5pZCkpfTwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7rgZ3snpDrpqwgJHtlc2MoYy5sYXN0NCB8fCAnLS0tLScpfTwvZGl2PjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1iYWwiPiR7d29uKGMuc3BlbnQpfTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpICsgKGEudW5saW5rZWRTcGVudCA/IGA8ZGl2IGNsYXNzPSJhY2N0Ij48ZGl2IGNsYXNzPSJhY2N0LWljb24gaXMtY2FyZCI+PzwvZGl2PjxkaXY+PGRpdiBjbGFzcz0iYWNjdC1uYW1lIj7qsrDsoJzsiJjri6gg66qo66aEPC9kaXY+PGRpdiBjbGFzcz0iYWNjdC1zdWIiPuyVjOumvOyXkOyEnCDsubTrk5zCt+qzhOyijOulvCDssL7sp4Ag66q77ZWcIOyngOy2nDwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3dvbihhLnVubGlua2VkU3BlbnQpfTwvZGl2PjwvZGl2PmAgOiAnJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDsubTrk5zqsIAg7JeG7Ja07JqULjwvZGl2Pic7CiAgICAkJCgnI2Fzc2V0LWJhbmtzIFtkYXRhLWdvdG9dLCAjYXNzZXQtY2FyZHMgW2RhdGEtZ290b10nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoYi5kYXRhc2V0LmdvdG8pKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4Ttmo0gLS0tLS0tLS0tLQoKICAvLyDsnbQg6riw6rCE7J2YIOqzhO2ajeydhCDqs6DsuZjquLAg7KCE7JeQIO2YuOy2nDog7KeA64KcIOq4sOqwhCDqs4Ttmo3snYQg66y866Ck67Cb6rOgIOyeiOyXiOuLpOuptCDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDsg4gg6rOE7ZqN7J2EIOunjOuToOuLpC4KICBmdW5jdGlvbiBlZGl0YWJsZVBsYW4oKSB7CiAgICBjb25zdCBwbGFuID0gTC5lbnN1cmVQbGFuRm9yKFMoKSwgY3VycmVudFBlcmlvZC5rZXksIG5vd0lTTygpKTsKICAgIHBsYW4udXBkYXRlZEF0ID0gbm93SVNPKCk7CiAgICByZXR1cm4gcGxhbjsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclBsYW5WZXJzaW9uKCkgewogICAgY29uc3QgcGxhbiA9IGN1cnJlbnRQbGFuKCk7CiAgICBjb25zdCBpbmhlcml0ZWQgPSBwbGFuLmZyb20gIT09IGN1cnJlbnRQZXJpb2Qua2V5OwogICAgY29uc3QgbmV4dCA9IEwubmV4dFBsYW5BZnRlcihTKCksIHsgZnJvbTogY3VycmVudFBlcmlvZC5rZXkgfSk7CiAgICBjb25zdCBwYXJ0cyA9IFtgPGI+JHtmbXREYXRlKGN1cnJlbnRQZXJpb2Quc3RhcnQpfSDquLDqsITsnZgg6rOE7ZqNPC9iPmBdOwogICAgcGFydHMucHVzaChwbGFuLmZyb20gPT09IEwuQkFTRV9QTEFOX0ZST00gPyAn7LKY7J2M67aA7YSwIOyTsOuNmCDqs4Ttmo3snoXri4jri6QuJyA6IGAke2ZtdERhdGUocGxhbi5mcm9tKX0g6riw6rCE67aA7YSwIOyggeyaqeuQnCDqs4Ttmo3snoXri4jri6QuYCk7CiAgICBwYXJ0cy5wdXNoKGluaGVyaXRlZAogICAgICA/ICfsl6zquLDshJwg6rOg7LmY66m0IDxiPuydtOuyiCDquLDqsITrtoDthLA8L2I+IOyDiCDqs4Ttmo3snLzroZwg7KCA7J6l65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuVjCDqs4Ttmo0g6re464yA66GcIOuCqOyVhOyalC4nCiAgICAgIDogJ+qzoOy5mOuptCDsnbQg6riw6rCE6rO8IOydtO2bhCDquLDqsITsl5Ag7KCB7Jqp65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuMgOuhnCDrgqjslYTsmpQuJyk7CiAgICBpZiAobmV4dCkgcGFydHMucHVzaChgJHtmbXREYXRlKG5leHQuZnJvbSl9IOq4sOqwhOu2gO2EsOuKlCDqt7gg65Kk7JeQIOuwlOq+vCDqs4Ttmo3snbQg7KCB7Jqp64+87JqULmApOwogICAgJCgnI3BsYW4tdmVyc2lvbicpLmlubmVySFRNTCA9IHBhcnRzLm1hcCgoeCkgPT4gYDxkaXYgY2xhc3M9InNtYWxsIj4ke3h9PC9kaXY+YCkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJQbGFuKCkgewogICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgIGNvbnN0IHBsYW4gPSBjdXJyZW50UGxhbigpOwogICAgJCgnI3JhdGlvLWJhc2UnKS52YWx1ZSA9IHBsYW4ucmF0aW9CYXNlOwoKICAgIGNvbnN0IHJvd3NFbCA9ICQoJyNwbGFuLXJvd3MnKTsKICAgIHJvd3NFbC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9InBsYW4tcm93IGhlYWQiPjxzcGFuPu2VreuqqSDsnbTrpoQ8L3NwYW4+PHNwYW4+67Cp7IudPC9zcGFuPjxzcGFuPuu5hOycqCAvIOq4iOyVoTwvc3Bhbj48c3Bhbj7shKTrqoUgKEFJIOywuOqzoCk8L3NwYW4+PHNwYW4+7YKk7JuM65OcPC9zcGFuPjxzcGFuPjwvc3Bhbj48L2Rpdj4KICAgICAgJHtwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0icGxhbi1yb3ciIGRhdGEtaWQ9IiR7ZXNjKGMuaWQpfSI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InBsLW5hbWUiIHZhbHVlPSIke2VzYyhjLm5hbWUpfSIgYXJpYS1sYWJlbD0i7ZWt66qpIOydtOumhCI+CiAgICAgICAgICA8c2VsZWN0IGNsYXNzPSJwbC10eXBlIiBhcmlhLWxhYmVsPSLrsKnsi50iPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyYXRpbyIgJHtjLnR5cGUgPT09ICdyYXRpbycgPyAnc2VsZWN0ZWQnIDogJyd9PuyImOyehSDruYTroYAoJSk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZml4ZWQiICR7Yy50eXBlID09PSAnZml4ZWQnID8gJ3NlbGVjdGVkJyA6ICcnfT7qs6DsoJUg6riI7JWhPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDxkaXYgY2xhc3M9InZhbHVlLXdyYXAiPgogICAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJkZWNpbWFsIiBjbGFzcz0icGwtdmFsdWUiIHZhbHVlPSIke2MudHlwZSA9PT0gJ2ZpeGVkJyA/IE51bWJlcihjLnZhbHVlKS50b0xvY2FsZVN0cmluZygna28tS1InKSA6IGMudmFsdWV9IiBhcmlhLWxhYmVsPSLqsJIiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idW5pdCI+JHtjLnR5cGUgPT09ICdmaXhlZCcgPyAn7JuQJyA6ICclJ308L3NwYW4+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwtZGVzYyIgdmFsdWU9IiR7ZXNjKGMuZGVzY3JpcHRpb24gfHwgJycpfSIgcGxhY2Vob2xkZXI9IuyYiDog7Jm47IudLCDrsLDri6wsIOyepeuztOq4sCIgYXJpYS1sYWJlbD0i7ISk66qFIj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwta3ciIHZhbHVlPSIke2VzYygoYy5rZXl3b3JkcyB8fCBbXSkuam9pbignLCAnKSl9IiBwbGFjZWhvbGRlcj0i7JiIOiDsiqTtg4DrsoXsiqQsIOy5tO2OmCIgYXJpYS1sYWJlbD0i7YKk7JuM65OcIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImxpbmstYnRuIHBsLWRlbCIgYXJpYS1sYWJlbD0iJHtlc2MoYy5uYW1lKX0g7IKt7KCcIj7inJU8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgY2xhc3M9InByZXZpZXciPjwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpfWA7CgogICAgY29uc3QgZWRpdCA9IChpZCwgZm4sIHJlcmVuZGVyKSA9PiB7CiAgICAgIGNvbnN0IGMgPSBlZGl0YWJsZVBsYW4oKS5jYXRlZ29yaWVzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgICAgZm4oYyk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIGlmIChyZXJlbmRlcikgcmVuZGVyUGxhbigpOwogICAgICBlbHNlIHsKICAgICAgICByZW5kZXJQbGFuVmVyc2lvbigpOwogICAgICAgIHJlbmRlclBsYW5TdW1tYXJ5KCk7CiAgICAgIH0KICAgIH07CgogICAgcm93c0VsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5wbGFuLXJvd1tkYXRhLWlkXScpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBpZCA9IHJvdy5kYXRhc2V0LmlkOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLW5hbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IChjLm5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCkgfHwgJ+ydtOumhCDsl4bsnYwnKSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXR5cGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IHsKICAgICAgICBjLnR5cGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBjLnZhbHVlID0gMDsKICAgICAgfSwgdHJ1ZSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXZhbHVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiB7CiAgICAgICAgY29uc3QgbiA9IE51bWJlcihlLnRhcmdldC52YWx1ZS5yZXBsYWNlKC9bXlxkLl0vZywgJycpKSB8fCAwOwogICAgICAgIGMudmFsdWUgPSBjLnR5cGUgPT09ICdmaXhlZCcgPyBNYXRoLnJvdW5kKG4pIDogTWF0aC5yb3VuZChuICogMTAwKSAvIDEwMDsKICAgICAgICBpZiAoYy50eXBlID09PSAnZml4ZWQnKSBlLnRhcmdldC52YWx1ZSA9IGMudmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyk7CiAgICAgIH0pKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1kZXNjJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiAoYy5kZXNjcmlwdGlvbiA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKSkpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1rdycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBlZGl0KGlkLCAoYykgPT4gewogICAgICAgIGMua2V5d29yZHMgPSBlLnRhcmdldC52YWx1ZS5zcGxpdCgvWyzvvIxdLykubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICB9KSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcucGwtZGVsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY29uc3QgYyA9IGN1cnJlbnRQbGFuKCkuY2F0ZWdvcmllcy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHtjLm5hbWV9JyDtla3rqqnsnYQg7J2067KIIOq4sOqwhCDqs4Ttmo3rtoDthLAg67qE6rmM7JqUPyDsnbQg7ZWt66qp7Jy866GcIOu2hOulmOuQnCDsnbTrsogg6riw6rCEIOyngOy2nOydgCDri6Tsi5wg67aE66WY7ZW07JW8IO2VqeuLiOuLpC5gKSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHAgPSBlZGl0YWJsZVBsYW4oKTsKICAgICAgICBwLmNhdGVnb3JpZXMgPSBwLmNhdGVnb3JpZXMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgICByZW5kZXJQbGFuKCk7CiAgICAgIH0pOwogICAgfSk7CiAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUGxhblN1bW1hcnkoKSB7CiAgICBjb25zdCBwbGFuID0gY3VycmVudFBsYW4oKTsKICAgIGNvbnN0IGluY29tZSA9IFMoKS5pbmNvbWVzW2N1cnJlbnRQZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IEwuY29tcHV0ZUJ1ZGdldHMocGxhbi5jYXRlZ29yaWVzLCBoYXNJbmNvbWUgPyBpbmNvbWUgOiAwLCBwbGFuLnJhdGlvQmFzZSk7CgogICAgJCQoJy5wbGFuLXJvd1tkYXRhLWlkXScpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBjID0gcGxhbi5jYXRlZ29yaWVzLmZpbmQoKHgpID0+IHguaWQgPT09IHJvdy5kYXRhc2V0LmlkKTsKICAgICAgY29uc3QgcCA9IHJvdy5xdWVyeVNlbGVjdG9yKCcucHJldmlldycpOwogICAgICBpZiAoIWMpIHJldHVybjsKICAgICAgaWYgKGMudHlwZSA9PT0gJ2ZpeGVkJykgcC50ZXh0Q29udGVudCA9ICfsiJjsnoXqs7wg7IOB6rSA7JeG7J20IOunpCDquLDqsIQg6rCZ7J2AIO2VnOuPhCc7CiAgICAgIGVsc2UgcC50ZXh0Q29udGVudCA9IGhhc0luY29tZSA/IGDsnbTrsogg6riw6rCEIO2VnOuPhCAke3dvbihjYWxjLmJ1ZGdldHNbYy5pZF0pfWAgOiAn64u56riwIOyImOyeheydhCDsnoXroKXtlZjrqbQg7ZWc64+E6rCAIOqzhOyCsOuQqeuLiOuLpCc7CiAgICB9KTsKCiAgICBjb25zdCBiYXNlID0gcGxhbi5yYXRpb0Jhc2UgPT09ICdhZnRlckZpeGVkJyA/ICfqs6DsoJUg7ZWt66qp7J2EIOu6gCDrgpjrqLjsp4AnIDogJ+yghOyytCDsiJjsnoUnOwogICAgY29uc3QgbGluZXMgPSBbYOqzoOyglSDtla3rqqkg7ZWp6rOEIDxiPiR7d29uKGNhbGMuZml4ZWRUb3RhbCl9PC9iPiDCtyDruYTsnKgg7ZWt66qpIO2VqeqzhCA8Yj4ke2NhbGMucmF0aW9QZXJjZW50VG90YWx9JTwvYj4gKCR7YmFzZX0g6riw7KSAKWBdOwogICAgaWYgKGNhbGMucmF0aW9QZXJjZW50VG90YWwgPiAxMDApIGxpbmVzLnB1c2goJzxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg67mE7JyoIO2VqeqzhOqwgCAxMDAl66W8IOuEmOyKteuLiOuLpC48L3NwYW4+Jyk7CiAgICBlbHNlIGlmIChjYWxjLnJhdGlvUGVyY2VudFRvdGFsIDwgMTAwKSBsaW5lcy5wdXNoKGA8c3BhbiBjbGFzcz0ibXV0ZWQiPuu5hOycqCDtlanqs4TqsIAgMTAwJeuztOuLpCAke01hdGgucm91bmQoKDEwMCAtIGNhbGMucmF0aW9QZXJjZW50VG90YWwpICogMTAwKSAvIDEwMH0lIOyggeyWtCDsnbzrtoAg7IiY7J6F7J2AIOuwsOu2hOuQmOyngCDslYrsirXri4jri6QuPC9zcGFuPmApOwogICAgaWYgKGhhc0luY29tZSkgewogICAgICBsaW5lcy5wdXNoKGDsnbTrsogg6riw6rCEIOyImOyehSAke3dvbihpbmNvbWUpfSDquLDspIA6IOuwsOu2hCAke3dvbihjYWxjLmFsbG9jYXRlZCl9YCArCiAgICAgICAgKGNhbGMudW5hbGxvY2F0ZWQgPj0gMCA/IGAgwrcg64Ko64qUIOuPiCAke3dvbihjYWxjLnVuYWxsb2NhdGVkKX1gIDogYCDCtyA8c3BhbiBjbGFzcz0id2FybiI+JHt3b24oLWNhbGMudW5hbGxvY2F0ZWQpfSDrtoDsobE8L3NwYW4+YCkpOwogICAgICBpZiAocGxhbi5yYXRpb0Jhc2UgPT09ICdhZnRlckZpeGVkJyAmJiBjYWxjLmZpeGVkVG90YWwgPiBpbmNvbWUpIGxpbmVzLnB1c2goJzxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukIO2BveuLiOuLpC48L3NwYW4+Jyk7CiAgICB9CiAgICAkKCcjcGxhbi1zdW1tYXJ5JykuaW5uZXJIVE1MID0gbGluZXMubWFwKChsKSA9PiBgPGRpdj4ke2x9PC9kaXY+YCkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBhZGRDYXRlZ29yeSgpIHsKICAgIGNvbnN0IHBsYW4gPSBlZGl0YWJsZVBsYW4oKTsKICAgIHBsYW4uY2F0ZWdvcmllcy5wdXNoKHsgaWQ6IGBjLSR7dWlkKCl9YCwgbmFtZTogJ+yDiCDtla3rqqknLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogMCwgZGVzY3JpcHRpb246ICcnLCBrZXl3b3JkczogW10gfSk7CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgcmVuZGVyUGxhbigpOwogICAgY29uc3QgaW5wdXRzID0gJCQoJy5wbC1uYW1lJyk7CiAgICBjb25zdCBsYXN0ID0gaW5wdXRzW2lucHV0cy5sZW5ndGggLSAxXTsKICAgIGxhc3QuZm9jdXMoKTsKICAgIGxhc3Quc2VsZWN0KCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyeheugpSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckFkZCgpIHsKICAgICQoJyNhdXRvLWhpbnQnKS5pbm5lckhUTUwgPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJwogICAgICA/ICc8Yj7subTrk5wg66y47J6Q7JmAIOydgO2WiSDslYzrprzsnYAg7J6Q64+Z7Jy866GcIOuTpOyWtOyZgOyalC48L2I+IDxzcGFuIGNsYXNzPSJzbWFsbCI+7Zy064yA7Y+wIOyekOuPme2ZlCjshKTsoJUg4oaSIOyekOuPmSDsnoXroKUp66W8IO2VtCDrkZDrqbQg6rKw7KCcwrfsnbTssrQg7JWM66a87J20IOyYrCDrlYzrp4jri6QgQUnqsIAg7J296rOgIOu2hOulmO2VtOyEnCDquLDroZ3tlanri4jri6QuIOyXrOq4sOyEnOuKlCDqt7gg67CW7J2YIOuCtOyXreydhCDrhKPsnLzshLjsmpQuPC9zcGFuPicKICAgICAgOiAnPGI+7KeA6riI7J2AIOydtCDquLDquLDsl5Drp4wg7KCA7J6l7ZWY64qUIOuqqOuTnOyYiOyalC48L2I+IDxzcGFuIGNsYXNzPSJzbWFsbCI+7Lm065OcwrfsnYDtlokg7JWM66a8IOyekOuPmSDsnoXroKXqs7wgQUkg67aE66WY66W8IOyTsOugpOuptCDshKTsoJUg4oaSIOyekOuPmSDsnoXroKXsl5DshJwg6rWs6riAIOyLnO2KuCDshJzrsoTrpbwg7Jew6rKw7ZWY7IS47JqULjwvc3Bhbj4nOwogICAgJCgnI2NsYXNzaWZpZXItbmFtZScpLnRleHRDb250ZW50ID0gc3RvcmUuYWlFbmFibGVkID8gJ0FJ6rCAIO2VreuqqScgOiAn7YKk7JuM65Oc66GcIO2VreuqqSc7CgogICAgJCQoJyNtLWtpbmQgYnV0dG9uJykuZm9yRWFjaCgoYikgPT4gYi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBiLmRhdGFzZXQua2luZCA9PT0gbWFudWFsS2luZCkpOwogICAgJCgnI20tY2F0ZWdvcnktd3JhcCcpLmhpZGRlbiA9IG1hbnVhbEtpbmQgIT09ICdleHBlbnNlJzsKICAgIGNvbnN0IHNlbCA9ICQoJyNtLWNhdGVnb3J5Jyk7CiAgICBjb25zdCBwcmV2ID0gc2VsLnZhbHVlIHx8ICdfX2F1dG8nOwogICAgaWYgKCEkKCcjbS1kYXRlJykudmFsdWUpICQoJyNtLWRhdGUnKS52YWx1ZSA9IEwudG9kYXlJU08oKTsKICAgIHNlbC5pbm5lckhUTUwgPSBjYXRlZ29yeU9wdGlvbnMocGxhbkZvckRhdGUoJCgnI20tZGF0ZScpLnZhbHVlKS5jYXRlZ29yaWVzLCBudWxsLCB7IGluY2x1ZGVBdXRvOiB0cnVlIH0pOwogICAgc2VsLnZhbHVlID0gWy4uLnNlbC5vcHRpb25zXS5zb21lKChvKSA9PiBvLnZhbHVlID09PSBwcmV2KSA/IHByZXYgOiAnX19hdXRvJzsKICAgIGNvbnN0IGFjYyA9ICQoJyNtLWFjY291bnQnKS52YWx1ZTsKICAgICQoJyNtLWFjY291bnQnKS5pbm5lckhUTUwgPSBhY2NvdW50T3B0aW9ucyhhY2MpOwogICAgY29uc3QgZmlsZUFjYyA9ICQoJyNmaWxlLWFjY291bnQnKS52YWx1ZSB8fCAoUygpLmFjY291bnRzLmZpbmQoKGEpID0+IGEudHlwZSAhPT0gJ2NhcmQnKSB8fCB7fSkuaWQgfHwgJyc7CiAgICAkKCcjZmlsZS1hY2NvdW50JykuaW5uZXJIVE1MID0gYWNjb3VudE9wdGlvbnMoZmlsZUFjYywgJ+qzhOyijCDshKDtg50g7JWIIO2VqCcpOwogICAgJCgnI20tbWVtbycpLnBsYWNlaG9sZGVyID0gbWFudWFsS2luZCA9PT0gJ2luY29tZScgPyAnKOyjvCntmozsgqwg6riJ7JesJyA6IG1hbnVhbEtpbmQgPT09ICd0cmFuc2ZlcicgPyAn7KCB6riIIOqzhOyijOuhnCcgOiAn7Iqk7YOA67KF7IqkIOqwleuCqOygkCc7CiAgICB1cGRhdGVNYW51YWxIaW50KCk7CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgZnVuY3Rpb24gdXBkYXRlTWFudWFsSGludCgpIHsKICAgIGNvbnN0IG1lbW8gPSAkKCcjbS1tZW1vJykudmFsdWU7CiAgICBpZiAobWFudWFsS2luZCA9PT0gJ3RyYW5zZmVyJykgewogICAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSAn64K0IOqzhOyijOuBvOumrCDsmK7quLQg64+I7J2AIOyngOy2nMK37IiY7J6FIO2VqeqzhOyXkOyEnCDruaDsp5Hri4jri6QuIOyggOy2lSDrqqnsoIHsnbTrqbQgIuyngOy2nCLroZwg64Sj6rOgIOyggOy2lSDtla3rqqnsnYQg6rOg66W07IS47JqULic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChtYW51YWxLaW5kICE9PSAnZXhwZW5zZScgfHwgJCgnI20tY2F0ZWdvcnknKS52YWx1ZSAhPT0gJ19fYXV0bycgfHwgIW1lbW8udHJpbSgpKSB7CiAgICAgICQoJyNtLWhpbnQnKS50ZXh0Q29udGVudCA9ICcnOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoc3RvcmUuYWlFbmFibGVkKSB7CiAgICAgICQoJyNtLWhpbnQnKS50ZXh0Q29udGVudCA9ICfstpTqsIDtlZjrqbQgQUnqsIAg7ZWt66qp7J2EIOygle2VqeuLiOuLpC4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBwbGFuID0gcGxhbkZvckRhdGUoJCgnI20tZGF0ZScpLnZhbHVlIHx8IEwudG9kYXlJU08oKSk7CiAgICBjb25zdCByID0gTC5jbGFzc2lmeUxvY2FsKG1lbW8sIHBsYW4uY2F0ZWdvcmllcywgUygpLm1lcmNoYW50TWFwKTsKICAgICQoJyNtLWhpbnQnKS50ZXh0Q29udGVudCA9IGDsnpDrj5kg67aE66WYIOqysOqzvDogJHtjYXRlZ29yeUluZm8oci5jYXRlZ29yeUlkLCBwbGFuLmNhdGVnb3JpZXMpLm5hbWV9YDsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9uTWFudWFsU3VibWl0KGUpIHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IGRhdGUgPSAkKCcjbS1kYXRlJykudmFsdWU7CiAgICBjb25zdCBhbW91bnQgPSBwYXJzZUFtb3VudElucHV0KCQoJyNtLWFtb3VudCcpLnZhbHVlKTsKICAgIGNvbnN0IG1lbW8gPSAkKCcjbS1tZW1vJykudmFsdWUudHJpbSgpIHx8ICco64K07JqpIOyXhuydjCknOwogICAgaWYgKCFkYXRlKSByZXR1cm4gdG9hc3QoJ+uCoOynnOulvCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgaWYgKGFtb3VudCA9PT0gbnVsbCB8fCBhbW91bnQgPT09IDApIHJldHVybiB0b2FzdCgn6riI7JWh7J2EIOyeheugpe2VtCDso7zshLjsmpQuJyk7CiAgICBjb25zdCBzZWwgPSBtYW51YWxLaW5kID09PSAnZXhwZW5zZScgPyAkKCcjbS1jYXRlZ29yeScpLnZhbHVlIDogJyc7CiAgICBpZiAoc2VsICYmIHNlbCAhPT0gJ19fYXV0bycpIHsKICAgICAgUygpLm1lcmNoYW50TWFwW0wubm9ybWFsaXplTWVyY2hhbnQobWVtbyldID0gc2VsOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgfQogICAgY29uc3QgaXRlbSA9IHsKICAgICAgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kOiBtYW51YWxLaW5kLCBhY2NvdW50SWQ6ICQoJyNtLWFjY291bnQnKS52YWx1ZSB8fCBudWxsLCBzb3VyY2U6ICdtYW51YWwnLAogICAgICBjYXRlZ29yeUlkOiBzZWwgPT09ICcnID8gbnVsbCA6IHNlbCwKICAgICAgbWV0aG9kOiBzZWwgJiYgc2VsICE9PSAnX19hdXRvJyA/ICdtYW51YWwnIDogdW5kZWZpbmVkLAogICAgfTsKICAgIGNvbnN0IFt0eF0gPSBhd2FpdCBidXN5KHNlbCA9PT0gJ19fYXV0bycgJiYgc3RvcmUuYWlFbmFibGVkID8gJ0FJ6rCAIOu2hOulmO2VmOuKlCDspJHigKYnIDogbnVsbCwgKCkgPT4gc3RvcmUuYWRkVHJhbnNhY3Rpb25zKFtpdGVtXSkpOwogICAgJCgnI20tYW1vdW50JykudmFsdWUgPSAnJzsKICAgICQoJyNtLW1lbW8nKS52YWx1ZSA9ICcnOwogICAgdXBkYXRlTWFudWFsSGludCgpOwogICAgY29uc3Qgd2hhdCA9IG1hbnVhbEtpbmQgPT09ICdleHBlbnNlJyA/IGAke2NhdGVnb3J5SW5mbyh0eC5jYXRlZ29yeUlkLCBwbGFuRm9yRGF0ZSh0eC5kYXRlKS5jYXRlZ29yaWVzKS5uYW1lfSDtla3rqqnsl5BgIDogbWFudWFsS2luZCA9PT0gJ2luY29tZScgPyAn7J6F6riI7Jy866GcJyA6ICfrgrQg6rOE7KKMIOydtOyytOuhnCc7CiAgICB0b2FzdChgJHt3aGF0fSAke3dvbihhbW91bnQpfSDstpTqsIDtlojsirXri4jri6QuYCk7CiAgICBqdW1wVG9EYXRlKGRhdGUpOwogIH0KCiAgZnVuY3Rpb24ganVtcFRvRGF0ZShkYXRlKSB7CiAgICBjb25zdCBwID0gTC5nZXRQZXJpb2QoZGF0ZSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgIGlmIChwLmtleSAhPT0gY3VycmVudFBlcmlvZC5rZXkpIGN1cnJlbnRQZXJpb2QgPSBwOwogICAgcmVuZGVyKCk7CiAgfQoKICAvLyDrtpnsl6zrhKPquLDsmYAg7YyM7J28IOqwgOyguOyYpOq4sOqwgCDqsJnsnYAg66+466as67O06riw66W8IOyTtOuLpC4gcHJldmlldy5zb3VyY2U6ICdwYXN0ZScgfCAnZmlsZScKICBjb25zdCBwcmV2aWV3ID0geyBzb3VyY2U6ICdwYXN0ZScsIGl0ZW1zOiBbXSwgc2tpcHBlZDogW10sIGxhdGVzdDogbnVsbCwgYWNjb3VudElkOiBudWxsLCBmaWxlTmFtZTogJycgfTsKCiAgZnVuY3Rpb24gY2xlYXJQcmV2aWV3KCkgewogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IGl0ZW1zOiBbXSwgc2tpcHBlZDogW10sIGxhdGVzdDogbnVsbCwgYWNjb3VudElkOiBudWxsLCBmaWxlTmFtZTogJycgfSk7CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgLy8g7KeA7Lac66eMIOu2hOulmO2VnOuLpC4g7ISc67KEKEFJKeuKlCDsl6zrn6wg67KI7JeQIOuCmOuIoCDrs7Trgrjri6QuCiAgYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlQcmV2aWV3KGl0ZW1zKSB7CiAgICBjb25zdCBleHBlbnNlcyA9IGl0ZW1zLmZpbHRlcigoaXQpID0+IGl0LmtpbmQgPT09ICdleHBlbnNlJyk7CiAgICBjb25zdCBzdGVwID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgPyA2MCA6IGV4cGVuc2VzLmxlbmd0aCB8fCAxOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBleHBlbnNlcy5sZW5ndGg7IGkgKz0gc3RlcCkgewogICAgICBjb25zdCBjaHVuayA9IGV4cGVuc2VzLnNsaWNlKGksIGkgKyBzdGVwKTsKICAgICAgaWYgKHN0b3JlLmFpRW5hYmxlZCAmJiBleHBlbnNlcy5sZW5ndGggPiBzdGVwKSB0b2FzdChgQUnqsIAg67aE66WY7ZWY64qUIOykkeKApiAoJHtNYXRoLm1pbihpICsgc3RlcCwgZXhwZW5zZXMubGVuZ3RoKX0vJHtleHBlbnNlcy5sZW5ndGh9KWAsIDYwMDAwKTsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgc3RvcmUuY2xhc3NpZnkoY2h1bmsubWFwKCh7IGRhdGUsIGFtb3VudCwgbWVtbyB9KSA9PiAoeyBkYXRlLCBhbW91bnQsIG1lbW8gfSkpKTsKICAgICAgY2h1bmsuZm9yRWFjaCgoaXQsIGspID0+IE9iamVjdC5hc3NpZ24oaXQsIHJlc1trXSkpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gd2l0aER1cEZsYWdzKGl0ZW1zKSB7CiAgICByZXR1cm4gaXRlbXMubWFwKChpdCkgPT4gewogICAgICBjb25zdCBkdXAgPSAhIUwuZmluZER1cGxpY2F0ZShpdCwgUygpLnRyYW5zYWN0aW9ucyk7CiAgICAgIHJldHVybiB7IGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCwgLi4uaXQsIGR1cCwgY2hlY2tlZDogIWR1cCB9OwogICAgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvblBhcnNlKCkgewogICAgY29uc3QgeyBpdGVtcywgc2tpcHBlZCB9ID0gTC5wYXJzZUV4cGVuc2VUZXh0KCQoJyNwYXN0ZS1pbnB1dCcpLnZhbHVlLCBMLnRvZGF5SVNPKCkpOwogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IHNvdXJjZTogJ3Bhc3RlJywgc2tpcHBlZCwgbGF0ZXN0OiBudWxsLCBhY2NvdW50SWQ6IG51bGwsIGZpbGVOYW1lOiAnJyB9KTsKICAgIHByZXZpZXcuaXRlbXMgPSB3aXRoRHVwRmxhZ3MoaXRlbXMubWFwKChpdCkgPT4gKHsgLi4uaXQsIGtpbmQ6ICdleHBlbnNlJyB9KSkpOwogICAgaWYgKHByZXZpZXcuaXRlbXMubGVuZ3RoKSBhd2FpdCBidXN5KHN0b3JlLmFpRW5hYmxlZCA/IGBBSeqwgCAke3ByZXZpZXcuaXRlbXMubGVuZ3RofeqxtOydhCDrtoTrpZjtlZjripQg7KSR4oCmYCA6IG51bGwsICgpID0+IGNsYXNzaWZ5UHJldmlldyhwcmV2aWV3Lml0ZW1zKSk7CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb25GaWxlQ2hvc2VuKGZpbGUpIHsKICAgIGNvbnN0IGFjY291bnRJZCA9ICQoJyNmaWxlLWFjY291bnQnKS52YWx1ZSB8fCBudWxsOwogICAgbGV0IHJvd3M7CiAgICB0cnkgewogICAgICByb3dzID0gYXdhaXQgd2luZG93LkJ1ZGdldFhsc3gucmVhZFRhYmxlRmlsZShmaWxlKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIHRvYXN0KGUubWVzc2FnZSB8fCAn7YyM7J287J2EIOydveyngCDrqrvtlojslrTsmpQuJywgNzAwMCk7CiAgICB9CiAgICBjb25zdCBwYXJzZWQgPSBMLnBhcnNlU3RhdGVtZW50Um93cyhyb3dzLCB7IG15TmFtZTogUygpLnNldHRpbmdzLm15TmFtZSwgYWNjb3VudElkIH0pOwogICAgaWYgKCFwYXJzZWQuaGVhZGVyKSByZXR1cm4gdG9hc3QoJ+qxsOuemOuCtOyXrSDtkZzrpbwg7LC+7KeAIOuqu+2WiOyWtOyalC4g64Kg7Kec7JmAIOq4iOyVoSDsubjsnbQg7J6I64qUIOydgO2WiSDqsbDrnpjrgrTsl60g7YyM7J287J247KeAIO2ZleyduO2VtCDso7zshLjsmpQuJywgNzAwMCk7CiAgICBPYmplY3QuYXNzaWduKHByZXZpZXcsIHsgc291cmNlOiAnZmlsZScsIHNraXBwZWQ6IFtdLCBsYXRlc3Q6IHBhcnNlZC5sYXRlc3QsIGFjY291bnRJZCwgZmlsZU5hbWU6IGZpbGUubmFtZSB9KTsKICAgIHByZXZpZXcuaXRlbXMgPSB3aXRoRHVwRmxhZ3MocGFyc2VkLml0ZW1zKTsKICAgIGlmIChwYXJzZWQuc2tpcHBlZCkgcHJldmlldy5za2lwcGVkID0gW2DrgqDsp5zrpbwg7J297KeAIOuqu+2VnCDspIQgJHtwYXJzZWQuc2tpcHBlZH3qsJxgXTsKICAgIGlmIChwcmV2aWV3Lml0ZW1zLmxlbmd0aCkgewogICAgICBhd2FpdCBidXN5KHN0b3JlLmFpRW5hYmxlZCA/IGBBSeqwgCAke3ByZXZpZXcuaXRlbXMuZmlsdGVyKCh4KSA9PiB4LmtpbmQgPT09ICdleHBlbnNlJykubGVuZ3RofeqxtOydhCDrtoTrpZjtlZjripQg7KSR4oCmYCA6IG51bGwsICgpID0+IGNsYXNzaWZ5UHJldmlldyhwcmV2aWV3Lml0ZW1zKSk7CiAgICB9CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgY29uc3QgS0lORF9MQUJFTCA9IHsgaW5jb21lOiAn7J6F6riIJywgdHJhbnNmZXI6ICfrgrQg6rOE7KKMIOydtOyytCcgfTsKCiAgZnVuY3Rpb24gcmVuZGVyUGFyc2VSZXN1bHQoKSB7CiAgICBjb25zdCB0YXJnZXQgPSBwcmV2aWV3LnNvdXJjZSA9PT0gJ2ZpbGUnID8gJCgnI2ZpbGUtcmVzdWx0JykgOiAkKCcjcGFyc2UtcmVzdWx0Jyk7CiAgICBjb25zdCBvdGhlciA9IHByZXZpZXcuc291cmNlID09PSAnZmlsZScgPyAkKCcjcGFyc2UtcmVzdWx0JykgOiAkKCcjZmlsZS1yZXN1bHQnKTsKICAgIG90aGVyLmlubmVySFRNTCA9ICcnOwogICAgaWYgKCFwcmV2aWV3Lml0ZW1zLmxlbmd0aCAmJiAhcHJldmlldy5za2lwcGVkLmxlbmd0aCkgewogICAgICB0YXJnZXQuaW5uZXJIVE1MID0gJyc7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGl0ZW1zID0gcHJldmlldy5pdGVtczsKICAgIGNvbnN0IHJvd3MgPSBpdGVtcy5tYXAoKGl0LCBpKSA9PiBgCiAgICAgIDx0cj4KICAgICAgICA8dGQ+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBkYXRhLWk9IiR7aX0iIGNsYXNzPSJwLWNoZWNrIiAke2l0LmNoZWNrZWQgPyAnY2hlY2tlZCcgOiAnJ30gYXJpYS1sYWJlbD0i7LaU6rCAIj48L3RkPgogICAgICAgIDx0ZD48aW5wdXQgdHlwZT0iZGF0ZSIgZGF0YS1pPSIke2l9IiBjbGFzcz0icC1kYXRlIiB2YWx1ZT0iJHtpdC5kYXRlfSI+PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im1lbW8iPiR7ZXNjKGl0Lm1lbW8pfSAke2l0LmR1cCA/ICc8c3BhbiBjbGFzcz0idGFnIHdhcm4iPuykkeuztT88L3NwYW4+JyA6ICcnfSAke2l0LmtpbmQgPT09ICdleHBlbnNlJyA/IG1ldGhvZFRhZyhpdC5tZXRob2QpIDogJyd9PC90ZD4KICAgICAgICA8dGQgY2xhc3M9ImFtb3VudCAke2l0LmtpbmQgPT09ICdpbmNvbWUnIHx8IGl0LmFtb3VudCA8IDAgPyAncmVmdW5kJyA6ICcnfSI+JHtpdC5raW5kID09PSAnaW5jb21lJyA/ICcrJyA6ICcnfSR7d29uKGl0LmFtb3VudCl9PC90ZD4KICAgICAgICA8dGQ+JHtpdC5raW5kID09PSAnZXhwZW5zZScKICAgICAgICAgID8gYDxzZWxlY3QgZGF0YS1pPSIke2l9IiBjbGFzcz0icC1jYXQiPiR7Y2F0ZWdvcnlPcHRpb25zKHBsYW5Gb3JEYXRlKGl0LmRhdGUpLmNhdGVnb3JpZXMsIGl0LmNhdGVnb3J5SWQpfTwvc2VsZWN0PmAKICAgICAgICAgIDogYDxzcGFuIGNsYXNzPSJ0YWciPiR7S0lORF9MQUJFTFtpdC5raW5kXX08L3NwYW4+YH08L3RkPgogICAgICA8L3RyPmApLmpvaW4oJycpOwogICAgY29uc3QgZHVwcyA9IGl0ZW1zLmZpbHRlcigoeCkgPT4geC5kdXApLmxlbmd0aDsKICAgIGNvbnN0IGRhdGVzID0gaXRlbXMubWFwKCh4KSA9PiB4LmRhdGUpLnNvcnQoKTsKICAgIGNvbnN0IHN1bW1hcnkgPSBwcmV2aWV3LnNvdXJjZSA9PT0gJ2ZpbGUnICYmIGl0ZW1zLmxlbmd0aAogICAgICA/IGA8cCBjbGFzcz0ic21hbGwiPiR7ZXNjKHByZXZpZXcuZmlsZU5hbWUpfSDCtyAke2ZtdERhdGUoZGF0ZXNbMF0pfSB+ICR7Zm10RGF0ZShkYXRlc1tkYXRlcy5sZW5ndGggLSAxXSl9IMK3ICR7aXRlbXMubGVuZ3RofeqxtCR7ZHVwcyA/IGAgKOydtOuvuCDsnojripQg64K07Jet7Jy866GcIOuztOydtOuKlCAke2R1cHN96rG07J2AIOu5vCDrkZDsl4jslrTsmpQpYCA6ICcnfSR7cHJldmlldy5sYXRlc3QgPyBgIMK3IOuniOyngOuniSDsnpTslaEgJHt3b24ocHJldmlldy5sYXRlc3QuYmFsYW5jZSl9YCA6ICcnfTwvcD5gCiAgICAgIDogJyc7CiAgICB0YXJnZXQuaW5uZXJIVE1MID0gYAogICAgICAke3N1bW1hcnl9CiAgICAgICR7aXRlbXMubGVuZ3RoID8gYAogICAgICA8ZGl2IGNsYXNzPSJyb3ctYWN0aW9ucyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2hvc3QtYnRuIHNtYWxsLWJ0biIgaWQ9InAtYWxsIj7rqqjrkZAg7ISg7YOdPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2hvc3QtYnRuIHNtYWxsLWJ0biIgaWQ9InAtbm9uZSI+66qo65GQIO2VtOygnDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+CiAgICAgICAgPHRhYmxlIGNsYXNzPSJzdGFjay10YWJsZSBwYXJzZS10YWJsZSI+CiAgICAgICAgICA8dGhlYWQ+PHRyPjx0aD48L3RoPjx0aD7rgqDsp5w8L3RoPjx0aD7sgqzsmqnsspg8L3RoPjx0aCBjbGFzcz0iYW1vdW50Ij7quIjslaE8L3RoPjx0aD7tla3rqqk8L3RoPjwvdHI+PC90aGVhZD4KICAgICAgICAgIDx0Ym9keT4ke3Jvd3N9PC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPjxidXR0b24gaWQ9InAtYWRkIiBjbGFzcz0icHJpbWFyeS1idG4iPuyEoO2Dne2VnCAke2l0ZW1zLmZpbHRlcigoeCkgPT4geC5jaGVja2VkKS5sZW5ndGh96rG0IOy2lOqwgDwvYnV0dG9uPjwvZGl2PmAgOiAnJ30KICAgICAgJHtwcmV2aWV3LnNraXBwZWQubGVuZ3RoID8gYDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+6rG064SI65u0IOykhCAke3ByZXZpZXcuc2tpcHBlZC5sZW5ndGh96rCcOiAke3ByZXZpZXcuc2tpcHBlZC5tYXAoZXNjKS5qb2luKCcgLyAnKX08L3A+YCA6ICcnfWA7CgogICAgY29uc3Qgc2V0QWxsID0gKHYpID0+IHsKICAgICAgaXRlbXMuZm9yRWFjaCgoeCkgPT4gKHguY2hlY2tlZCA9IHYpKTsKICAgICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICAgIH07CiAgICBpZiAoJCgnI3AtYWxsJykpICQoJyNwLWFsbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2V0QWxsKHRydWUpKTsKICAgIGlmICgkKCcjcC1ub25lJykpICQoJyNwLW5vbmUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEFsbChmYWxzZSkpOwogICAgdGFyZ2V0LnF1ZXJ5U2VsZWN0b3JBbGwoJy5wLWNoZWNrJykuZm9yRWFjaCgoYykgPT4gYy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGl0ZW1zW2MuZGF0YXNldC5pXS5jaGVja2VkID0gYy5jaGVja2VkOwogICAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogICAgfSkpOwogICAgdGFyZ2V0LnF1ZXJ5U2VsZWN0b3JBbGwoJy5wLWRhdGUnKS5mb3JFYWNoKChjKSA9PiBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IChpdGVtc1tjLmRhdGFzZXQuaV0uZGF0ZSA9IGMudmFsdWUpKSk7CiAgICB0YXJnZXQucXVlcnlTZWxlY3RvckFsbCgnLnAtY2F0JykuZm9yRWFjaCgoYykgPT4gYy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGNvbnN0IGl0ID0gaXRlbXNbYy5kYXRhc2V0LmldOwogICAgICBpdC5jYXRlZ29yeUlkID0gYy52YWx1ZSB8fCBudWxsOwogICAgICBpdC5tZXRob2QgPSBjLnZhbHVlID8gJ21hbnVhbCcgOiBudWxsOwogICAgfSkpOwogICAgY29uc3QgYWRkQnRuID0gJCgnI3AtYWRkJyk7CiAgICBpZiAoYWRkQnRuKSBhZGRCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldChhZGRQcmV2aWV3SXRlbXMpKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGFkZFByZXZpZXdJdGVtcygpIHsKICAgIGNvbnN0IGNob3NlbiA9IHByZXZpZXcuaXRlbXMuZmlsdGVyKCh4KSA9PiB4LmNoZWNrZWQgJiYgeC5kYXRlKTsKICAgIGlmICghY2hvc2VuLmxlbmd0aCkgcmV0dXJuIHRvYXN0KCfstpTqsIDtlaAg64K07Jet7J2EIOyEoO2Dne2VtCDso7zshLjsmpQuJyk7CiAgICBsZXQgY2hhbmdlZE1ldGEgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgaXQgb2YgY2hvc2VuKSB7CiAgICAgIGlmIChpdC5tZXRob2QgPT09ICdtYW51YWwnICYmIGl0LmNhdGVnb3J5SWQpIHsKICAgICAgICBTKCkubWVyY2hhbnRNYXBbTC5ub3JtYWxpemVNZXJjaGFudChpdC5tZW1vKV0gPSBpdC5jYXRlZ29yeUlkOwogICAgICAgIGNoYW5nZWRNZXRhID0gdHJ1ZTsKICAgICAgfQogICAgfQogICAgLy8g7YyM7J287J2YIOuniOyngOuniSDsnpTslaHsnbQg7KeA6riIIOyVjOqzoCDsnojripQg7J6U7JWh67O064ukIOy1nOq3vOydtOuptCDqs4Tsoowg7J6U7JWh7J2EIOuwlOq+vOuLpAogICAgY29uc3QgYWNjID0gcHJldmlldy5hY2NvdW50SWQgJiYgUygpLmFjY291bnRzLmZpbmQoKGEpID0+IGEuaWQgPT09IHByZXZpZXcuYWNjb3VudElkKTsKICAgIGlmIChhY2MgJiYgcHJldmlldy5sYXRlc3QpIHsKICAgICAgY29uc3QgYXQgPSBuZXcgRGF0ZShgJHtwcmV2aWV3LmxhdGVzdC5kYXRlfVQke3ByZXZpZXcubGF0ZXN0LnRpbWUgfHwgJzIzOjU5OjU5J30rMDk6MDBgKS50b0lTT1N0cmluZygpOwogICAgICBpZiAoIWFjYy5iYWxhbmNlQXQgfHwgYXQgPiBhY2MuYmFsYW5jZUF0KSB7CiAgICAgICAgYWNjLmJhbGFuY2UgPSBwcmV2aWV3LmxhdGVzdC5iYWxhbmNlOwogICAgICAgIGFjYy5iYWxhbmNlQXQgPSBhdDsKICAgICAgICBjaGFuZ2VkTWV0YSA9IHRydWU7CiAgICAgIH0KICAgIH0KICAgIGlmIChjaGFuZ2VkTWV0YSkgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIGNvbnN0IHNvdXJjZSA9IHByZXZpZXcuc291cmNlID09PSAnZmlsZScgPyAnZmlsZScgOiAncGFzdGUnOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjaG9zZW4ubGVuZ3RoOyBpICs9IDIwMCkgewogICAgICBjb25zdCBwYXJ0ID0gY2hvc2VuLnNsaWNlKGksIGkgKyAyMDApOwogICAgICBhd2FpdCBidXN5KGDsoIDsnqXtlZjripQg7KSR4oCmICgke01hdGgubWluKGkgKyAyMDAsIGNob3Nlbi5sZW5ndGgpfS8ke2Nob3Nlbi5sZW5ndGh9KWAsICgpID0+CiAgICAgICAgc3RvcmUuYWRkVHJhbnNhY3Rpb25zKHBhcnQubWFwKChpdCkgPT4gKHsKICAgICAgICAgIGRhdGU6IGl0LmRhdGUsIGFtb3VudDogaXQuYW1vdW50LCBtZW1vOiBpdC5tZW1vLCBraW5kOiBpdC5raW5kIHx8ICdleHBlbnNlJywgYWNjb3VudElkOiBpdC5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICAgIGNhdGVnb3J5SWQ6IGl0LmtpbmQgPT09ICdleHBlbnNlJyA/IGl0LmNhdGVnb3J5SWQgOiBudWxsLCBtZXRob2Q6IGl0Lm1ldGhvZCwgc291cmNlLCByYXc6IGl0LnJhdywKICAgICAgICB9KSkpCiAgICAgICk7CiAgICB9CiAgICBjb25zdCBsYXRlc3REYXRlID0gY2hvc2VuLm1hcCgoeCkgPT4geC5kYXRlKS5zb3J0KCkucG9wKCk7CiAgICBpZiAocHJldmlldy5zb3VyY2UgPT09ICdwYXN0ZScpICQoJyNwYXN0ZS1pbnB1dCcpLnZhbHVlID0gJyc7CiAgICBlbHNlICQoJyNmaWxlLWlucHV0JykudmFsdWUgPSAnJzsKICAgIGNsZWFyUHJldmlldygpOwogICAgdG9hc3QoYCR7Y2hvc2VuLmxlbmd0aH3qsbTsnYQg7LaU6rCA7ZaI7Iq164uI64ukLmApOwogICAganVtcFRvRGF0ZShsYXRlc3REYXRlKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7ISk7KCVIC0tLS0tLS0tLS0KCiAgLy8g7JWM66a8IOyXsOqysCDslbEo7JWI65Oc66Gc7J2065OcKSDrgrTroKTrsJvquLAg7KO87IaMIChHaXRIdWIgQWN0aW9ucyDqsIAgbWFpbiDsl5Ag7Jis65286rCIIOuVjOuniOuLpCDqsLHsi6ApCiAgY29uc3QgTk9USV9BUEtfVVJMID0gJ2h0dHBzOi8vZ2l0aHViLmNvbS9rZGgxMjA3LXN0YXIvQ2xhdWRlQ29kZTEvcmVsZWFzZXMvZG93bmxvYWQvbm90aS1hcHAvYnVkZ2V0LW5vdGkuYXBrJzsKCiAgLy8g7ISk7LmY65CcIOyVjOumvCDsl7DqsrAg7JWx7J2EIOyXtOuptOyEnCDshJzrsoQg7KO87IaM66W8IOuEmOq4tOuLpCAo7YGs66GsIOyViOuTnOuhnOydtOuTnOydmCBpbnRlbnQg66eB7YGsKQogIGZ1bmN0aW9uIGNvbm5lY3RMaW5rKCkgewogICAgY29uc3QgdXJsID0gZW5jb2RlVVJJQ29tcG9uZW50KG5vdGlmeVVybCgnYmFuaycpKTsKICAgIHJldHVybiBgaW50ZW50Oi8vc2V0dXA/dXJsPSR7dXJsfSNJbnRlbnQ7c2NoZW1lPWJ1ZGdldG5vdGk7cGFja2FnZT1jb20ua2RoMTIwNy5idWRnZXRub3RpO1MuYnJvd3Nlcl9mYWxsYmFja191cmw9JHtlbmNvZGVVUklDb21wb25lbnQoTk9USV9BUEtfVVJMKX07ZW5kYDsKICB9CgogIGZ1bmN0aW9uIG5vdGlmeVVybChzb3VyY2UpIHsKICAgIHJldHVybiBzdG9yZS5zZXJ2aWNlVXJsID8gYCR7c3RvcmUuc2VydmljZVVybH0/YWN0aW9uPXNtcyZrZXk9JHtlbmNvZGVVUklDb21wb25lbnQoc3RvcmUuc2VydmVyLmtleSl9JHtzb3VyY2UgPyBgJnNvdXJjZT0ke3NvdXJjZX1gIDogJyd9YCA6ICcnOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyU2V0dGluZ3MoKSB7CiAgICBjb25zdCBzZCA9ICQoJyNzdGFydC1kYXknKTsKICAgIGlmICghc2Qub3B0aW9ucy5sZW5ndGgpIHNkLmlubmVySFRNTCA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDMxIH0sIChfLCBpKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtpICsgMX0iPuunpOyblCAke2kgKyAxfeydvDwvb3B0aW9uPmApLmpvaW4oJycpOwogICAgc2QudmFsdWUgPSBTdHJpbmcoUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICQoJyNteS1uYW1lJykudmFsdWUgPSBTKCkuc2V0dGluZ3MubXlOYW1lIHx8ICcnOwogICAgcmVuZGVyQWNjb3VudFJvd3MoKTsKICAgIHJlbmRlckF1dG9DYXJkKCk7CiAgICAkKCcjZGF0YS1ub3RlJykudGV4dENvbnRlbnQgPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJwogICAgICA/ICfrjbDsnbTthLDripQg6rWs6riAIOyLnO2KuOyXkCDsoIDsnqXrkKnri4jri6QuIOuwseyXhSDrtojrn6zsmKTquLDrpbwg7ZWY66m0IOuwseyXheydmCDqs4Ttmo3Ct+qzhOyijOulvCDsoIHsmqntlZjqs6Ag64K07Jet7J2EIOyLnO2KuOyXkCDstpTqsIDtlanri4jri6QuJwogICAgICA6ICfrqqjrk6Ag642w7J207YSw64qUIOydtCDruIzrnbzsmrDsoIDsl5Drp4wg7KCA7J6l65Cp64uI64ukLiDri6Trpbgg6riw6riw66GcIOyYruq4sOqxsOuCmCDrsLHsl4XtlZjroKTrqbQg64K067O064K06riw66W8IOyCrOyaqe2VmOyEuOyalC4nOwogICAgJCgnI3Jlc2V0LWJ0bicpLmhpZGRlbiA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQWNjb3VudFJvd3MoKSB7CiAgICBjb25zdCBlbCA9ICQoJyNhY2NvdW50LXJvd3MnKTsKICAgIGNvbnN0IGFjY291bnRzID0gUygpLmFjY291bnRzOwogICAgZWwuaW5uZXJIVE1MID0gYWNjb3VudHMubGVuZ3RoCiAgICAgID8gYWNjb3VudHMubWFwKChhKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1yb3ciIGRhdGEtaWQ9IiR7ZXNjKGEuaWQpfSI+CiAgICAgICAgICA8aW5wdXQgY2xhc3M9ImEtbmFtZSIgdHlwZT0idGV4dCIgdmFsdWU9IiR7ZXNjKGEubmFtZSl9IiBwbGFjZWhvbGRlcj0iJHthLnR5cGUgPT09ICdjYXJkJyA/ICfsmIg6IOyLoO2VnCDssrTtgazsubTrk5wnIDogJ+yYiDog6rWt66+8IOyjvOqxsOuemCd9IiBhcmlhLWxhYmVsPSLsnbTrpoQiPgogICAgICAgICAgPHNlbGVjdCBjbGFzcz0iYS10eXBlIiBhcmlhLWxhYmVsPSLsooXrpZgiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJiYW5rIiAke2EudHlwZSAhPT0gJ2NhcmQnID8gJ3NlbGVjdGVkJyA6ICcnfT7snYDtlokg6rOE7KKMPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImNhcmQiICR7YS50eXBlID09PSAnY2FyZCcgPyAnc2VsZWN0ZWQnIDogJyd9Puy5tOuTnDwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgICA8aW5wdXQgY2xhc3M9ImEtbGFzdCIgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJudW1lcmljIiBtYXhsZW5ndGg9IjQiIHZhbHVlPSIke2VzYyhhLmxhc3Q0KX0iIHBsYWNlaG9sZGVyPSLrgZ0gNOyekOumrCIgYXJpYS1sYWJlbD0i64GdIDTsnpDrpqwiPgogICAgICAgICAgPGlucHV0IGNsYXNzPSJhLWJhbCIgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJudW1lcmljIiB2YWx1ZT0iJHt0eXBlb2YgYS5iYWxhbmNlID09PSAnbnVtYmVyJyA/IGEuYmFsYW5jZS50b0xvY2FsZVN0cmluZygna28tS1InKSA6ICcnfSIgcGxhY2Vob2xkZXI9IiR7YS50eXBlID09PSAnY2FyZCcgPyAn4oCUJyA6ICftmITsnqwg7J6U7JWhJ30iICR7YS50eXBlID09PSAnY2FyZCcgPyAnZGlzYWJsZWQnIDogJyd9IGFyaWEtbGFiZWw9IuyelOyVoSI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImNoZWNrIj48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNsYXNzPSJhLXNhdmUiICR7YS5pc1NhdmluZ3MgPyAnY2hlY2tlZCcgOiAnJ30gJHthLnR5cGUgPT09ICdjYXJkJyA/ICdkaXNhYmxlZCcgOiAnJ30+7KCA7LaVPC9sYWJlbD4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImxpbmstYnRuIGEtZGVsIiBhcmlhLWxhYmVsPSLsgq3soJwiPuKclTwvYnV0dG9uPgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7slYTsp4Eg65Ox66Gd7ZWcIOqzhOyijMK37Lm065Oc6rCAIOyXhuyWtOyalC48L2Rpdj4nOwoKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5hY2N0LXJvdycpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBhID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IHJvdy5kYXRhc2V0LmlkKTsKICAgICAgY29uc3Qgc2F2ZSA9IChyZXJlbmRlcikgPT4gewogICAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgICAgaWYgKHJlcmVuZGVyKSByZW5kZXJBY2NvdW50Um93cygpOwogICAgICB9OwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtbmFtZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5uYW1lID0gZS50YXJnZXQudmFsdWUudHJpbSgpOwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS10eXBlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLnR5cGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBpZiAoYS50eXBlID09PSAnY2FyZCcpIE9iamVjdC5hc3NpZ24oYSwgeyBiYWxhbmNlOiBudWxsLCBpc1NhdmluZ3M6IGZhbHNlIH0pOwogICAgICAgIHNhdmUodHJ1ZSk7CiAgICAgIH0pOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtbGFzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5sYXN0NCA9IGUudGFyZ2V0LnZhbHVlLnJlcGxhY2UoL1xEL2csICcnKS5zbGljZSgtNCk7CiAgICAgICAgZS50YXJnZXQudmFsdWUgPSBhLmxhc3Q0OwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIGZvcm1hdE9uQmx1cihyb3cucXVlcnlTZWxlY3RvcignLmEtYmFsJykpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtYmFsJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLmJhbGFuY2UgPSBwYXJzZUFtb3VudElucHV0KGUudGFyZ2V0LnZhbHVlKTsKICAgICAgICBhLmJhbGFuY2VBdCA9IG5vd0lTTygpOwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1zYXZlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLmlzU2F2aW5ncyA9IGUudGFyZ2V0LmNoZWNrZWQ7CiAgICAgICAgc2F2ZSgpOwogICAgICB9KTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLWRlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGlmICghY29uZmlybShgJyR7YS5uYW1lIHx8IGEubGFzdDR9JyDsnYQo66W8KSDsgq3soJztlaDquYzsmpQ/IOydtOuvuCDquLDroZ3rkJwg64K07Jet7J2AIOq3uOuMgOuhnCDrgqjsirXri4jri6QuYCkpIHJldHVybjsKICAgICAgICBTKCkuYWNjb3VudHMgPSBTKCkuYWNjb3VudHMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBhLmlkKTsKICAgICAgICBzYXZlKHRydWUpOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gYWRkQWNjb3VudCgpIHsKICAgIFMoKS5hY2NvdW50cy5wdXNoKHsgaWQ6IGBhLSR7dWlkKCl9YCwgbmFtZTogJycsIHR5cGU6ICdiYW5rJywgbGFzdDQ6ICcnLCBpc1NhdmluZ3M6IGZhbHNlLCBiYWxhbmNlOiBudWxsLCBiYWxhbmNlQXQ6ICcnIH0pOwogICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIHJlbmRlckFjY291bnRSb3dzKCk7CiAgICBjb25zdCBuYW1lcyA9ICQkKCcuYWNjdC1yb3cgLmEtbmFtZScpOwogICAgbmFtZXNbbmFtZXMubGVuZ3RoIC0gMV0uZm9jdXMoKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckF1dG9DYXJkKCkgewogICAgY29uc3QgY2FyZCA9ICQoJyNzZXQtYXV0bycpOwogICAgaWYgKHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnKSB7CiAgICAgIGNvbnN0IE1PREVMX0xBQkVMID0geyAnY2xhdWRlLW9wdXMtNS01JzogJ0NsYXVkZSBPcHVzIDUuNSAo6riw67O4LCDqsIDsnqUg7KCV7ZmVKScsICdjbGF1ZGUtaGFpa3UtNC01JzogJ0NsYXVkZSBIYWlrdSA0LjUgKOyggOugtCwg7JW9IDEvNCDruYTsmqkpJyB9OwogICAgICBjYXJkLmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+7J6Q64+ZIOyeheugpTwvaDI+CiAgICAgICAgPGgzPkNsYXVkZSBBSSDrtoTrpZg8L2gzPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+JHtzdG9yZS5haUVuYWJsZWQgPyAnPGI+7Lyc7KC4IOyeiOyWtOyalC48L2I+IOyVjOumvOqzvCDrtpnsl6zrhKPsnYAg64K07Jet7J2EIEFJ6rCAIOyYiOyCsCDtla3rqqnsl5Ag66ee7LawIOu2hOulmO2VqeuLiOuLpC4nIDogJzxiPuq6vOyguCDsnojslrTsmpQuPC9iPiDsp4DquIjsnYAg7YKk7JuM65Oc66GcIOu2hOulmO2VqeuLiOuLpC4g7JWE656Y7JeQIENsYXVkZSBBUEkg7YKk66W8IOuEo+ycvOuptCDsvJzsoLjsmpQuIO2CpOuKlCBjb25zb2xlLmFudGhyb3BpYy5jb20g7JeQ7IScIOqysOygnCDsiJjri6jsnYQg65Ox66Gd7ZWcIOuSpCBBUEkgS2V5cyDrqZTribTsl5DshJwg66eM65OkIOyImCDsnojslrTsmpQuJ308L3A+CiAgICAgICAgPGZvcm0gaWQ9ImFpLWZvcm0iIGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ3aWRlIj5DbGF1ZGUgQVBJIO2CpDxpbnB1dCB0eXBlPSJwYXNzd29yZCIgaWQ9ImFpLWtleSIgYXV0b2NvbXBsZXRlPSJvZmYiIHBsYWNlaG9sZGVyPSIke3N0b3JlLmFpRW5hYmxlZCA/ICfsoIDsnqXrkKggKOuwlOq+uOugpOuptCDsg4gg7YKkIOyeheugpSknIDogJ3NrLWFudC3igKYnfSI+PC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tc3VibWl0Ij48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7tmZXsnbjtlZjqs6Ag7KCA7J6lPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9mb3JtPgogICAgICAgICR7c3RvcmUuYWlFbmFibGVkID8gYDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsIGNsYXNzPSJ3aWRlIj7sgqzsmqntlaAg66qo6424PHNlbGVjdCBpZD0iYWktbW9kZWwiPiR7KHN0b3JlLmFpTW9kZWxzLmxlbmd0aCA/IHN0b3JlLmFpTW9kZWxzIDogW3N0b3JlLmFpTW9kZWxdKS5tYXAoKG0pID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhtKX0iICR7bSA9PT0gc3RvcmUuYWlNb2RlbCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoTU9ERUxfTEFCRUxbbV0gfHwgbSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9sYWJlbD48L2Rpdj5gIDogJyd9CiAgICAgICAgJHtzdG9yZS5haUVycm9yID8gYDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+7LWc6re8IEFJIOyYpOulmDogJHtlc2Moc3RvcmUuYWlFcnJvcil9PC9wPmAgOiAnJ30KICAgICAgICA8aDM+7Lm07Lm07Jik67GF7YGsIOusuOyekCDsnpDrj5kg7J6F66ClIChNYWNyb0Ryb2lkIOustOujjCk8L2gzPgogICAgICAgIDxvbCBjbGFzcz0ic3RlcHMiPgogICAgICAgICAgPGxpPu2UjOugiOydtCDsiqTthqDslrTsl5DshJwgPGI+TWFjcm9Ecm9pZDwvYj4g7ISk7LmYIChQcm8gN+ydvCDssrTtl5gg7JWI64K064qUIOuLq+q4sCk8L2xpPgogICAgICAgICAgPGxpPuunpO2BrOuhnCDstpTqsIAg4oaSIO2KuOumrOqxsCA8Yj7soITtmZQvU01TIOKGkiBTTVMg7IiY7IugPC9iPiAo66qo65OgIOuyiO2YuCwg64K07Jqp7JeQIDxjb2RlPuyelOyVoTwvY29kZT4g7Y+s7ZWoKTwvbGk+CiAgICAgICAgICA8bGk+64+Z7J6RIDxiPuybuSDsoJHsho0g4oaSIEhUVFAg7JqU7LKtPC9iPjogUE9TVCwg7JWE656YIOyjvOyGjCwg67O466y4IHRleHQvcGxhaW4g7JeQIOunpOyngSDthY3siqTtirggPGNvZGU+W3Ntc19tZXNzYWdlXTwvY29kZT48L2xpPgogICAgICAgICAgPGxpPuyggOyepSDtm4Qg7Zy064yA7Y+wIOyEpOygleyXkOyEnCBNYWNyb0Ryb2lkIOuwsO2EsOumrCA8Yj7soJztlZwg7JeG7J2MPC9iPjwvbGk+CiAgICAgICAgPC9vbD4KICAgICAgICA8ZGl2IGNsYXNzPSJjb3B5LXJvdyI+PGlucHV0IHR5cGU9InRleHQiIHJlYWRvbmx5IHZhbHVlPSIke2VzYyhub3RpZnlVcmwoJ2JhbmsnKSl9IiBpZD0idXJsLWJhbmsiPjxidXR0b24gY2xhc3M9Imdob3N0LWJ0biIgZGF0YS1jb3B5PSJ1cmwtYmFuayI+67O17IKsPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7rrLjsnpDqsIAg7JmA64+EIOuwmOydkeydtCDsl4bsnLzrqbQg7Yq466as6rGw66W8IDxiPuyVjOumvCDsiJjsi6A8L2I+KOuplOyLnOyngCDslbEsIOuCtOyaqSA8Y29kZT7snpTslaE8L2NvZGU+KeycvOuhnCDrsJTqvrjqs6Ag67O466y47J2EIDxjb2RlPltub3RpZmljYXRpb25fdGl0bGVdIFtub3RpZmljYXRpb25dPC9jb2RlPiDroZwg7ZWY7IS47JqULiDqs4TsoozCt+y5tOuTnOyXkCDsubTsubTsmKTrsYXtgawg64GdIDTsnpDrpqzrpbwg65Ox66Gd7ZW0IOuRkOuptCDsnpTslaHrj4Qg6rCx7Iug64+87JqULiDsnpDshLjtlZwg67Cp67KV7J2AIFNFVFVQLm1kIDbri6jqs4Tsl5Ag7J6I7Ja07JqULjwvcD4KICAgICAgICA8ZGV0YWlscyBjbGFzcz0ic21hbGwiPgogICAgICAgICAgPHN1bW1hcnk+7KeB7KCRIOunjOuToCDslYzrprwg7Jew6rKwIOyVsSAo7ISg7YOdLCDrs7TslYgg7LCo64uo65CgIOyImCDsnojsnYwpPC9zdW1tYXJ5PgogICAgICAgICAgPHAgY2xhc3M9Im11dGVkIj7tlIzroIjsnbQg7Iqk7Yag7Ja0IOuwliDslbHsnbTrnbwg7IK87ISxIOuztOyViCDquLDriqXsnbQg7ISk7LmY66W8IOunieydhCDsiJgg7J6I7Ja07JqULiDrs7TslYgg7ISk7KCV7J2EIOuBhOuptOyEnOq5jOyngCDsk7DripQg6rKD7J2AIOq2jO2VmOyngCDslYrslYTsmpQuIDxhIGhyZWY9IiR7Tk9USV9BUEtfVVJMfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkFQSyDrsJvquLA8L2E+IMK3IDxhIGhyZWY9IiR7ZXNjKGNvbm5lY3RMaW5rKCkpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPuyEpOy5mO2VnCDslbHsl5Ag7Jew6rKwPC9hPjwvcD4KICAgICAgICA8L2RldGFpbHM+CiAgICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPgogICAgICAgICAgJHtzdG9yZS5zZXJ2ZXIuZW1iZWRkZWQgPyAnPGJ1dHRvbiBpZD0iZm9yZ2V0LWtleS1idG4iIGNsYXNzPSJnaG9zdC1idG4gc21hbGwtYnRuIj7snbQg6riw6riw7JeQ7IScIOygkeyGjSDtgqQg7KeA7Jqw6riwPC9idXR0b24+JyA6ICc8YnV0dG9uIGlkPSJkaXNjb25uZWN0LWJ0biIgY2xhc3M9ImRhbmdlci1idG4iPuyXsOqysCDtlbTsoJwgKOydtCDquLDquLAg7KCA7J6l7Jy866GcKTwvYnV0dG9uPid9CiAgICAgICAgPC9kaXY+YDsKICAgICAgJCgnI2FpLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCBxdWlldChhc3luYyAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBrZXkgPSAkKCcjYWkta2V5JykudmFsdWUudHJpbSgpOwogICAgICAgIGlmICgha2V5ICYmICFjb25maXJtKCdBUEkg7YKk66W8IOyngOyasOqzoCBBSSDrtoTrpZjrpbwg64GM6rmM7JqUPycpKSByZXR1cm47CiAgICAgICAgYXdhaXQgYnVzeSgnQVBJIO2CpOulvCDtmZXsnbjtlZjripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuc2V0QXBpS2V5KGtleSkpOwogICAgICAgIHRvYXN0KHN0b3JlLmFpRW5hYmxlZCA/ICdBSSDrtoTrpZjrpbwg7Lyw7Ja07JqULicgOiAnQUkg67aE66WY66W8IOq7kOyWtOyalC4nKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSkpOwogICAgICBjb25zdCBtb2RlbFNlbCA9ICQoJyNhaS1tb2RlbCcpOwogICAgICBpZiAobW9kZWxTZWwpIG1vZGVsU2VsLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgICBhd2FpdCBidXN5KG51bGwsICgpID0+IHN0b3JlLnNldE1vZGVsKG1vZGVsU2VsLnZhbHVlKSk7CiAgICAgICAgdG9hc3QoJ+uqqOuNuOydhCDrsJTqv6jslrTsmpQuJyk7CiAgICAgIH0pKTsKICAgICAgY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jb3B5XScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY29uc3QgaW5wdXQgPSAkKGAjJHtiLmRhdGFzZXQuY29weX1gKTsKICAgICAgICBjb3B5VGV4dChpbnB1dC52YWx1ZSwgaW5wdXQpOwogICAgICB9KSk7CiAgICAgIGNvbnN0IGZrID0gJCgnI2ZvcmdldC1rZXktYnRuJyk7CiAgICAgIGlmIChmaykgZmsuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgaWYgKCFjb25maXJtKCfsnbQg6riw6riw7JeQ7IScIOygkeyGjSDtgqTrpbwg7KeA7Jq46rmM7JqUPyDri6TsnYzsl5Ag7Je0IOuVjCDri6Tsi5wg7J6F66Cl7ZW07JW8IO2VtOyalC4nKSkgcmV0dXJuOwogICAgICAgIHN0b3JlLmZvcmdldEtleSgpOwogICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpOwogICAgICB9KTsKICAgICAgY29uc3QgZGMgPSAkKCcjZGlzY29ubmVjdC1idG4nKTsKICAgICAgaWYgKGRjKSBkYy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgICBpZiAoIWNvbmZpcm0oJ+yEnOuyhCDsl7DqsrDsnYQg7ZW07KCc7ZWg6rmM7JqUPyDqtazquIAg7Iuc7Yq47J2YIOuNsOydtO2EsOuKlCDqt7jrjIDroZwg64Ko7JWEIOyeiOyKteuLiOuLpC4nKSkgcmV0dXJuOwogICAgICAgIHN0b3JlLmRpc2Nvbm5lY3QoKTsKICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTsKICAgICAgfSk7CiAgICB9IGVsc2UgewogICAgICBjYXJkLmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+7J6Q64+ZIOyeheugpSAo6rWs6riAIOyLnO2KuCDshJzrsoQg7Jew6rKwKTwvaDI+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj7subTrk5wg66y47J6QwrfsnYDtlokg7JWM66a8IOyekOuPmSDsnoXroKXqs7wgQUkg67aE66WY64qUIOq1rOq4gCDsi5ztirgg7ISc67KE6rCAIOyeiOyWtOyVvCDrj5nsnpHtlbTsmpQuIOyggOyepeyGjOydmCA8Yj5TRVRVUC5tZDwvYj4g64yA66GcIOq1rOq4gCBBcHBzIFNjcmlwdCDrpbwg67Cw7Y+s7ZWcIOuSpCwg7Ju57JWxIOyjvOyGjOyZgCDsoJHsho0g7YKk66W8IOuEo+ycvOyEuOyalC4g7Ju57JWxIOyjvOyGjOuhnCDrsJTroZwg7KCR7IaN7ZW07IScIOyNqOuPhCDrkKnri4jri6QuPC9wPgogICAgICAgIDxmb3JtIGlkPSJjb25uZWN0LWZvcm0iIGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ3aWRlIj7sm7nslbEg7KO87IaMPGlucHV0IHR5cGU9InVybCIgaWQ9ImMtdXJsIiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3Mvcy/igKYvZXhlYyIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD7soJHsho0g7YKkPGlucHV0IHR5cGU9InRleHQiIGlkPSJjLWtleSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tc3VibWl0Ij48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7sl7DqsrA8L2J1dHRvbj48L2Rpdj4KICAgICAgICA8L2Zvcm0+YDsKICAgICAgJCgnI2Nvbm5lY3QtZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIHF1aWV0KGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IHVybCA9ICQoJyNjLXVybCcpLnZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cPy4qJC8sICcnKTsKICAgICAgICBjb25zdCBrZXkgPSAkKCcjYy1rZXknKS52YWx1ZS50cmltKCk7CiAgICAgICAgYXdhaXQgYnVzeSgn7Jew6rKwIO2ZleyduCDspJHigKYnLCAoKSA9PiBzdG9yZS5waW5nKHVybCwga2V5KSk7CiAgICAgICAgY29uc3QgbWlncmF0ZSA9IFMoKS50cmFuc2FjdGlvbnMubGVuZ3RoID4gMCAmJiBjb25maXJtKCfsnbQg6riw6riw7JeQIOyeiOuNmCDqs4Ttmo3qs7wg64K07Jet7J2EIOq1rOq4gCDsi5ztirjroZwg7Jiu6ri46rmM7JqUPycpOwogICAgICAgIHN0b3JlLmNvbm5lY3QodXJsLCBrZXksIG1pZ3JhdGUpOwogICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpOwogICAgICB9KSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjaGFuZ2VTdGFydERheShuZXdEYXkpIHsKICAgIEwucmVtYXBQZXJpb2RLZXlzKFMoKSwgbmV3RGF5KTsKICAgIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIG5ld0RheSk7CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgcmVuZGVyQ2hyb21lKCk7CiAgICB0b2FzdChg7J207KCcIOunpOyblCAke25ld0RheX3snbzsl5Ag7IOIIOq4sOqwhOydtCDsi5zsnpHrkKnri4jri6QuYCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuwseyXhSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIGV4cG9ydERhdGEoKSB7CiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW0pTT04uc3RyaW5naWZ5KFMoKSwgbnVsbCwgMildLCB7IHR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyB9KTsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgYS5kb3dubG9hZCA9IGDsp4DstpzqtIDrpqwt67Cx7JeFLSR7TC50b2RheUlTTygpfS5qc29uYDsKICAgIGEuY2xpY2soKTsKICAgIHNldFRpbWVvdXQoKCkgPT4gVVJMLnJldm9rZU9iamVjdFVSTChhLmhyZWYpLCAxMDAwKTsKICB9CgogIGZ1bmN0aW9uIGltcG9ydERhdGEoZmlsZSkgewogICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTsKICAgIHJlYWRlci5vbmxvYWQgPSBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgIGxldCBwYXJzZWQ7CiAgICAgIHRyeSB7CiAgICAgICAgcGFyc2VkID0gTC5ub3JtYWxpemVTdGF0ZShKU09OLnBhcnNlKHJlYWRlci5yZXN1bHQpKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIHJldHVybiB0b2FzdCgn7Jis67CU66W4IOuwseyXhSDtjIzsnbzsnbQg7JWE64uZ64uI64ukLicpOwogICAgICB9CiAgICAgIGNvbnN0IG1zZyA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnID8gJ+uwseyXheydmCDqs4Ttmo3Ct+qzhOyijOulvCDsoIHsmqntlZjqs6Ag64K07Jet7J2EIOq1rOq4gCDsi5ztirjsl5Ag7LaU6rCA7ZWg6rmM7JqUPycgOiAn7ZiE7J6sIOuNsOydtO2EsOulvCDrsLHsl4Ug7YyM7J287J2YIOuCtOyaqeycvOuhnCDrsJTqv4DquYzsmpQ/JzsKICAgICAgaWYgKCFjb25maXJtKG1zZykpIHJldHVybjsKICAgICAgYXdhaXQgYnVzeSgn67aI65+s7Jik64qUIOykkeKApicsICgpID0+IHN0b3JlLmltcG9ydFN0YXRlKHBhcnNlZCkpOwogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICB0b2FzdCgn67Cx7JeF7J2EIOu2iOufrOyZlOyKteuLiOuLpC4nKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KTsKICAgIHJlYWRlci5yZWFkQXNUZXh0KGZpbGUpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDroIzrjZQgJiDsnbTrsqTtirggLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXIoKSB7CiAgICByZW5kZXJDaHJvbWUoKTsKICAgIGNvbnN0IHBhZ2UgPSBjdXJyZW50UGFnZTsKICAgIGlmIChwYWdlID09PSAnaG9tZScpIHJlbmRlckhvbWUoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdjYWxlbmRhcicpIHJlbmRlckNhbGVuZGFyKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnbGlzdCcpIHJlbmRlckxpc3QoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdyZXBvcnQnKSByZW5kZXJSZXBvcnQoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdhc3NldHMnKSByZW5kZXJBc3NldHMoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdwbGFuJykgcmVuZGVyUGxhbigpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ2FkZCcpIHJlbmRlckFkZCgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ3NldHRpbmdzJykgcmVuZGVyU2V0dGluZ3MoKTsKICB9CgogIGZ1bmN0aW9uIGJpbmRFdmVudHMoKSB7CiAgICAkJCgnLm5hdi1pdGVtW2RhdGEtcGFnZV0sIC5ib3R0b20tbmF2IFtkYXRhLXBhZ2VdJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNob3dQYWdlKGIuZGF0YXNldC5wYWdlKSkpOwogICAgJCQoJ1tkYXRhLWdvdG9dJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNob3dQYWdlKGIuZGF0YXNldC5nb3RvKSkpOwogICAgJCQoJ1tkYXRhLW9wZW4tbWVudV0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb3Blbk1lbnUpKTsKICAgICQoJyNtZW51LWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb3Blbk1lbnUpOwogICAgJCgnI3NjcmltJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBjbG9zZU1lbnUpOwogICAgJCgnI2FkZC1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNob3dQYWdlKCdhZGQnKSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignaGFzaGNoYW5nZScsICgpID0+IHsKICAgICAgY29uc3QgbmFtZSA9IGxvY2F0aW9uLmhhc2guc2xpY2UoMSk7CiAgICAgIGlmIChQQUdFU1tuYW1lXSAmJiBuYW1lICE9PSBjdXJyZW50UGFnZSkgc2hvd1BhZ2UobmFtZSwgeyBwdXNoOiBmYWxzZSB9KTsKICAgIH0pOwogICAgJCQoJy5zZXR0aW5ncy1uYXYgYScpLmZvckVhY2goKGEpID0+IGEuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICQoYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSkuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogJ3Ntb290aCcsIGJsb2NrOiAnc3RhcnQnIH0pOwogICAgfSkpOwoKICAgIGNvbnN0IG1vdmUgPSAoZGVsdGEpID0+IHsKICAgICAgY3VycmVudFBlcmlvZCA9IEwuc2hpZnRQZXJpb2QoY3VycmVudFBlcmlvZCwgZGVsdGEsIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAgICQoJyNpbmNvbWUtYm94JykuZGF0YXNldC5lZGl0aW5nID0gJyc7CiAgICAgIHJlbmRlcigpOwogICAgfTsKICAgICQoJyNwcmV2LXBlcmlvZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gbW92ZSgtMSkpOwogICAgJCgnI25leHQtcGVyaW9kJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBtb3ZlKDEpKTsKICAgICQoJyN0b2RheS1wZXJpb2QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgc2VsZWN0ZWREYXRlID0gbnVsbDsKICAgICAgcmVuZGVyKCk7CiAgICB9KTsKICAgICQoJyNyZWZyZXNoLWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBhd2FpdCBidXN5KCfrtojrn6zsmKTripQg7KSR4oCmJywgKCkgPT4gc3RvcmUucmVmcmVzaCgpKTsKICAgICAgcmVuZGVyKCk7CiAgICB9KSk7CgogICAgLy8g7J6F66ClCiAgICAkJCgnI20ta2luZCBidXR0b24nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBtYW51YWxLaW5kID0gYi5kYXRhc2V0LmtpbmQ7CiAgICAgIHJlbmRlckFkZCgpOwogICAgfSkpOwogICAgJCgnI21hbnVhbC1mb3JtJykuYWRkRXZlbnRMaXN0ZW5lcignc3VibWl0JywgcXVpZXQob25NYW51YWxTdWJtaXQpKTsKICAgIGZvcm1hdE9uQmx1cigkKCcjbS1hbW91bnQnKSk7CiAgICAkKCcjbS1tZW1vJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCB1cGRhdGVNYW51YWxIaW50KTsKICAgICQoJyNtLWNhdGVnb3J5JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgdXBkYXRlTWFudWFsSGludCk7CiAgICAkKCcjbS1kYXRlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcmVuZGVyQWRkKTsKICAgICQoJyNwYXJzZS1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KG9uUGFyc2UpKTsKICAgICQoJyNwYXN0ZS1jbGVhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAkKCcjcGFzdGUtaW5wdXQnKS52YWx1ZSA9ICcnOwogICAgICBjbGVhclByZXZpZXcoKTsKICAgIH0pOwogICAgJCgnI2ZpbGUtaW5wdXQnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWlldChhc3luYyAoZSkgPT4gewogICAgICBpZiAoZS50YXJnZXQuZmlsZXNbMF0pIGF3YWl0IG9uRmlsZUNob3NlbihlLnRhcmdldC5maWxlc1swXSk7CiAgICB9KSk7CgogICAgLy8g64K07JetCiAgICBjb25zdCBzZXRGaWx0ZXIgPSAoa2V5LCB2YWx1ZSkgPT4gewogICAgICBsaXN0U3RhdGVba2V5XSA9IHZhbHVlOwogICAgICByZW5kZXJMaXN0KCk7CiAgICB9OwogICAgJCgnI2xpc3Qtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZSkgPT4gc2V0RmlsdGVyKCdzZWFyY2gnLCBlLnRhcmdldC52YWx1ZSkpOwogICAgJCgnI2xpc3Qta2luZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBzZXRGaWx0ZXIoJ2tpbmQnLCBlLnRhcmdldC52YWx1ZSkpOwogICAgJCgnI2xpc3QtZmlsdGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHNldEZpbHRlcignY2F0ZWdvcnknLCBlLnRhcmdldC52YWx1ZSkpOwogICAgJCgnI2xpc3QtYWNjb3VudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBzZXRGaWx0ZXIoJ2FjY291bnQnLCBlLnRhcmdldC52YWx1ZSkpOwogICAgJCgnI3JlY2xhc3NpZnktdW5jbGFzc2lmaWVkJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBydW5SZWNsYXNzaWZ5KHRydWUpKSk7CiAgICAkKCcjcmVjbGFzc2lmeS1hbGwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KCgpID0+IHJ1blJlY2xhc3NpZnkoZmFsc2UpKSk7CgogICAgLy8g7JiI7IKwIOqzhO2ajQogICAgJCgnI3JhdGlvLWJhc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBlZGl0YWJsZVBsYW4oKS5yYXRpb0Jhc2UgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgICAgcmVuZGVyUGxhblN1bW1hcnkoKTsKICAgIH0pOwogICAgJCgnI2FkZC1jYXRlZ29yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQ2F0ZWdvcnkpOwoKICAgIC8vIOyEpOyglQogICAgJCgnI3N0YXJ0LWRheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBjaGFuZ2VTdGFydERheShOdW1iZXIoZS50YXJnZXQudmFsdWUpKSk7CiAgICAkKCcjbXktbmFtZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgIFMoKS5zZXR0aW5ncy5teU5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICB9KTsKICAgICQoJyNhZGQtYWNjb3VudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQWNjb3VudCk7CiAgICAkKCcjZXhwb3J0LWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXhwb3J0RGF0YSk7CiAgICAkKCcjaW1wb3J0LWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBpZiAoZS50YXJnZXQuZmlsZXNbMF0pIGltcG9ydERhdGEoZS50YXJnZXQuZmlsZXNbMF0pOwogICAgICBlLnRhcmdldC52YWx1ZSA9ICcnOwogICAgfSk7CiAgICAkKCcjcmVzZXQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgn66qo65OgIOuCtOyXrSwg7IiY7J6FLCDqs4Ttmo0sIOqzhOyijOulvCDsp4DsmrDqs6Ag7LKY7J2MIOyDge2DnOuhnCDrkJjrj4zrprTquYzsmpQ/ICjrkJjrj4zrprQg7IiYIOyXhuyKteuLiOuLpCknKSkgcmV0dXJuOwogICAgICBzdG9yZS5yZXNldCgpOwogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICB0b2FzdCgn7LSI6riw7ZmU7ZaI7Iq164uI64ukLicpOwogICAgICByZW5kZXIoKTsKICAgIH0pOwoKICAgIC8vIOyVseydhCDrlqDrgqAg65WMIOyVhOyngSDrs7TrgrTsp4Ag7JWK7J2AIOuzgOqyveydhCDsoIDsnqXtlZjqs6AsIOuPjOyVhOyYpOuptCDsg4jroZwg65Ok7Ja07JioIOyVjOumvCDrgrTsl63snYQg67aI65+s7Jio64ukCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSAnaGlkZGVuJykgcmV0dXJuIHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIWJ1c3lDb3VudCAmJiAhc3RvcmUuaGFzUGVuZGluZ01ldGEoKSkgewogICAgICAgIGF3YWl0IHN0b3JlLnJlZnJlc2goKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfQogICAgfSkpOwogIH0KCiAgLy8g6rWs6riAIOybuSDslbHsnLzroZwg7LKY7J2MIOyXtOyXiOydhCDrlYw6IOygkeyGjSDtgqTrpbwg7ZWcIOuyiCDsnoXroKXrsJvslYQg7J20IOq4sOq4sOyXkCDquLDslrXtlZzri6QKICBmdW5jdGlvbiBhc2tLZXkoKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICAgIGJveC5jbGFzc05hbWUgPSAna2V5LWdhdGUnOwogICAgICBib3guaW5uZXJIVE1MID0gYAogICAgICAgIDxmb3JtIGNsYXNzPSJjYXJkIGtleS1jYXJkIiBpZD0ia2V5LWZvcm0iPgogICAgICAgICAgPGgyPuygkeyGjSDtgqTrpbwg7J6F66Cl7ZWY7IS47JqUPC9oMj4KICAgICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+6rWs6riAIEFwcHMgU2NyaXB0IO2OuOynkeq4sOyXkOyEnCA8Yj5zZXR1cDwvYj4g7J2EIOyLpO2Wie2VmOuptCDsi6Ttlokg6riw66Gd7JeQIOuCmOyYpOuKlCDtgqTsmIjsmpQuICjslYgg67O07J2066m0IOKamSDtlITroZzsoJ3tirgg7ISk7KCVIOKGkiDsiqTtgazrpr3tirgg7IaN7ISx7J2YIDxiPkFQUF9LRVk8L2I+KSDtlZwg67KIIOyeheugpe2VmOuptCDsnbQg6riw6riw6rCAIOq4sOyWte2VtOyalC48L3A+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icGFzc3dvcmQiIGlkPSJrZXktaW5wdXQiIGF1dG9jb21wbGV0ZT0iY3VycmVudC1wYXNzd29yZCIgcGxhY2Vob2xkZXI9IuygkeyGjSDtgqQiIHJlcXVpcmVkPgogICAgICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPjxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPuuTpOyWtOqwgOq4sDwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPHAgY2xhc3M9InNtYWxsIHdhcm4iIGlkPSJrZXktZXJyb3IiIGhpZGRlbj48L3A+CiAgICAgICAgPC9mb3JtPmA7CiAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYm94KTsKICAgICAgJCgnI2tleS1pbnB1dCcpLmZvY3VzKCk7CiAgICAgICQoJyNrZXktZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGVyciA9ICQoJyNrZXktZXJyb3InKTsKICAgICAgICBlcnIuaGlkZGVuID0gdHJ1ZTsKICAgICAgICB0cnkgewogICAgICAgICAgYXdhaXQgc3RvcmUudXNlS2V5KCQoJyNrZXktaW5wdXQnKS52YWx1ZS50cmltKCkpOwogICAgICAgICAgYm94LnJlbW92ZSgpOwogICAgICAgICAgcmVzb2x2ZSgpOwogICAgICAgIH0gY2F0Y2ggKGV4KSB7CiAgICAgICAgICBlcnIudGV4dENvbnRlbnQgPSAvdW5hdXRob3JpemVkLy50ZXN0KGV4Lm1lc3NhZ2UpID8gJ+2CpOqwgCDrp57sp4Ag7JWK7JWE7JqULiDri6Tsi5wg7ZmV7J247ZW0IOyjvOyEuOyalC4nIDogYO2ZleyduO2VmOyngCDrqrvtlojslrTsmpQ6ICR7ZXgubWVzc2FnZX1gOwogICAgICAgICAgZXJyLmhpZGRlbiA9IGZhbHNlOwogICAgICAgIH0KICAgICAgfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgd2luZG93Ll9fYnVkZ2V0U3RhcnRlZCA9IHRydWU7CiAgICBiaW5kRXZlbnRzKCk7CiAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIXN0b3JlLnNlcnZlci5rZXkpIGF3YWl0IGFza0tleSgpOwogICAgY29uc3QgdG9NaWdyYXRlID0gc3RvcmUudGFrZU1pZ3JhdGlvbigpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYnVzeShzdG9yZS5tb2RlID09PSAncmVtb3RlJyA/ICfrtojrn6zsmKTripQg7KSR4oCmJyA6IG51bGwsICgpID0+IHN0b3JlLmluaXQoKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgICQoJyNjYXRlZ29yeS1yb3dzJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImVtcHR5Ij7shJzrsoTsl5Ag7Jew6rKw7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4gKCR7ZXNjKGUubWVzc2FnZSB8fCBlKX0pPGJyPuyEpOyglSDihpIg7J6Q64+ZIOyeheugpeyXkOyEnCDso7zshozsmYAg7YKk66W8IO2ZleyduO2VmOyEuOyalC48L2Rpdj5gOwogICAgfQogICAgaWYgKHRvTWlncmF0ZSkgewogICAgICBhd2FpdCBidXN5KCfsnbQg6riw6riwIOuNsOydtO2EsOulvCDsmK7quLDripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuaW1wb3J0U3RhdGUodG9NaWdyYXRlKSkuY2F0Y2goKCkgPT4ge30pOwogICAgICB0b2FzdCgn7J20IOq4sOq4sCDrjbDsnbTthLDrpbwg6rWs6riAIOyLnO2KuOuhnCDsmK7qsrzsirXri4jri6QuJyk7CiAgICB9CiAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgc2hvd1BhZ2UobG9jYXRpb24uaGFzaC5zbGljZSgxKSB8fCAnaG9tZScsIHsgcHVzaDogZmFsc2UgfSk7CiAgfQoKICBzdGFydCgpOwp9KSgpOwo=\");</script>\n</body>\n</html>\n";
