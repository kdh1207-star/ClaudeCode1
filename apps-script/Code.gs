// 자동 생성 파일 (npm run build). 직접 고치지 말고 js/logic.js, server/server.js 를 고치세요.
// 구글 Apps Script 의 Code.gs 에 이 파일 전체를 붙여넣으면 됩니다.
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
    const s = String(text || '').replace(/^﻿/, '');
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

// 편집기에서 한 번 실행: 시트를 만들고, 접속 키가 없으면 새로 만들어 실행 기록에 보여준다.
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

var INDEX_HTML = "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <title>내 지출 관리</title>\n  <style>\n:root {\n  color-scheme: light;\n  --page: #f4f4f1;\n  --surface: #fcfcfb;\n  --surface-2: #f0efec;\n  --surface-3: #e7e6e1;\n  --text: #0b0b0b;\n  --text-2: #52514e;\n  --muted: #6f6d68;\n  --border: rgba(11, 11, 11, 0.09);\n  --accent: #2a78d6;\n  --accent-track: #cde2fb;\n  --accent-soft: #e6f0fc;\n  --accent-text: #1c5cab;\n  --good: #0ca30c;\n  --good-text: #006300;\n  --warning: #fab219;\n  --warning-track: #fde8b8;\n  --critical: #d03b3b;\n  --critical-track: #f6d0d0;\n  --critical-text: #b42f2f;\n  --gray-mark: #b8b6ae;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7;\n  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04);\n  --sidebar-w: 232px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n    color-scheme: dark;\n    --page: #0d0d0d;\n    --surface: #1a1a19;\n    --surface-2: #232321;\n    --surface-3: #2e2e2b;\n    --text: #ffffff;\n    --text-2: #c3c2b7;\n    --muted: #9a988f;\n    --border: rgba(255, 255, 255, 0.09);\n    --accent: #3987e5;\n    --accent-track: #1c3558;\n    --accent-soft: #16263b;\n    --accent-text: #86b6ef;\n    --good-text: #0ca30c;\n    --warning-track: #4a3a12;\n    --critical-track: #4a1f1f;\n    --critical-text: #ec7070;\n    --gray-mark: #5c5b56;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n    --shadow: none;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --page: #0d0d0d;\n  --surface: #1a1a19;\n  --surface-2: #232321;\n  --surface-3: #2e2e2b;\n  --text: #ffffff;\n  --text-2: #c3c2b7;\n  --muted: #9a988f;\n  --border: rgba(255, 255, 255, 0.09);\n  --accent: #3987e5;\n  --accent-track: #1c3558;\n  --accent-soft: #16263b;\n  --accent-text: #86b6ef;\n  --good-text: #0ca30c;\n  --warning-track: #4a3a12;\n  --critical-track: #4a1f1f;\n  --critical-text: #ec7070;\n  --gray-mark: #5c5b56;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9;\n  --shadow: none;\n}\n\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nbody {\n  margin: 0;\n  background: var(--page);\n  color: var(--text);\n  font-family: system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif;\n  font-size: 15px;\n  line-height: 1.5;\n}\n\nh1 { font-size: 20px; margin: 0; }\nh2 { font-size: 16px; margin: 0 0 8px; }\nh3 { font-size: 14px; margin: 16px 0 4px; }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.num { font-variant-numeric: tabular-nums; }\nsvg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n\n/* ---------- 레이아웃 ---------- */\n.app { min-height: 100vh; }\n.sidebar {\n  position: fixed;\n  inset: 0 auto 0 0;\n  width: var(--sidebar-w);\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  display: flex;\n  flex-direction: column;\n  padding: 20px 12px;\n  z-index: 30;\n}\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 0 8px 20px; }\n.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 16px; }\n.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }\n.nav-item {\n  display: flex; align-items: center; gap: 12px;\n  border: 0; background: none; color: var(--text-2);\n  font: inherit; text-align: left; padding: 10px 12px; border-radius: 10px; cursor: pointer;\n}\n.nav-item:hover { background: var(--surface-2); }\n.nav-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }\n.nav-sep { height: 1px; background: var(--border); margin: 8px 12px; }\n.sidebar-foot { padding: 12px 8px 0; }\n\n.main { margin-left: var(--sidebar-w); min-width: 0; }\n.topbar {\n  position: sticky; top: 0; z-index: 20;\n  display: flex; align-items: center; gap: 12px;\n  padding: 14px 28px;\n  background: color-mix(in srgb, var(--page) 88%, transparent);\n  backdrop-filter: blur(8px);\n}\n.topbar h1 { flex: 1; }\n.topbar-actions { display: flex; gap: 8px; align-items: center; }\n.topbar .menu-btn { display: none; }\n.content { max-width: 1040px; padding: 4px 28px 40px; }\n.page { display: none; }\n.page.active { display: block; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }\n.grid-2 > .card { margin-bottom: 16px; }\n\n.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 25; }\n.bottom-nav { display: none; }\n\n@media (max-width: 900px) {\n  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }\n  .sidebar.open { transform: none; }\n  .main { margin-left: 0; }\n  .topbar .menu-btn { display: inline-flex; }\n  .topbar { padding: 10px 16px; }\n  .content { padding: 4px 16px 96px; }\n  .grid-2 { grid-template-columns: 1fr; gap: 0; }\n  .topbar .add-btn { display: none; }\n  .bottom-nav {\n    display: grid; grid-template-columns: repeat(5, 1fr);\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n    background: var(--surface); border-top: 1px solid var(--border);\n    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));\n  }\n  .bottom-nav button {\n    display: flex; flex-direction: column; align-items: center; gap: 2px;\n    border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;\n  }\n  .bottom-nav button.active { color: var(--accent-text); font-weight: 600; }\n  .bottom-nav .bn-add svg { width: 26px; height: 26px; color: #fff; background: var(--accent); border-radius: 50%; padding: 4px; stroke-width: 2.4; }\n}\n\n/* ---------- 공통 요소 ---------- */\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 18px 20px;\n  margin-bottom: 16px;\n  box-shadow: var(--shadow);\n}\n.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }\n.card-head h2 { margin: 0; }\n.note-card { background: var(--surface-2); box-shadow: none; }\n.note-card p { margin: 4px 0 8px; }\n.warn-card { background: var(--warning-track); border-color: transparent; }\n\nbutton, input, select, textarea { font: inherit; color: inherit; }\ninput, select, textarea {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  padding: 9px 11px;\n  min-width: 0;\n}\ninput:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }\ntextarea { width: 100%; resize: vertical; }\nselect.full { width: 100%; }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn {\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  border: 1px solid var(--border); background: var(--surface); white-space: nowrap;\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n.ghost-btn:hover, .icon-btn:hover { background: var(--surface-2); }\n.danger-btn { color: var(--critical-text); }\n.icon-btn { padding: 7px; }\n.small-btn { padding: 6px 11px; font-size: 13px; }\n.link { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }\n.link-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }\n.link-btn:hover { color: var(--critical-text); }\n.file-btn { display: inline-flex; }\n.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }\n.chip { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; display: inline-block; }\n.chip.on { background: var(--accent-soft); color: var(--accent-text); }\n.tag { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }\n.tag.warn { background: var(--warning-track); color: var(--text); }\n.empty { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }\n\n.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }\n.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }\n.form-grid .wide { grid-column: span 2; }\n.form-submit { display: flex; align-items: end; }\n@media (max-width: 520px) { .form-grid .wide { grid-column: 1 / -1; } }\n\n.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; margin: 4px 0 14px; }\n.segmented button { border: 0; background: none; padding: 7px 14px; border-radius: 8px; cursor: pointer; color: var(--text-2); }\n.segmented button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }\n\n.busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -50% 0; } to { background-position: 150% 0; } }\n\n/* ---------- 기간 선택 ---------- */\n.period-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }\n.period-label { display: flex; flex-direction: column; min-width: 0; }\n.period-label strong { font-size: 16px; }\n.period-nav .icon-btn { width: 34px; height: 34px; font-size: 20px; line-height: 1; padding: 0; }\n.period-nav #today-period { margin-left: auto; }\n\n/* ---------- 홈 ---------- */\n.income-prompt { border-color: var(--accent); background: var(--accent-soft); }\n.income-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }\n.income-form input { flex: 1; min-width: 140px; }\n.income-set { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }\n.income-set .value { font-size: 18px; font-weight: 600; }\n\n.hero-card .label { color: var(--text-2); font-size: 14px; }\n.hero-card .figure { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin: 2px 0 4px; }\n.hero-card .figure.negative { color: var(--critical-text); }\n.hero-card .sub { color: var(--text-2); font-size: 14px; }\n.hero-card .meter { margin-top: 14px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 36px; } }\n\n.kv { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--border); gap: 12px; }\n.kv:first-child { border-top: 0; }\n.kv .k { color: var(--text-2); font-size: 14px; }\n.kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }\n.kv .v.plus { color: var(--accent-text); }\n\n/* 항목 행 (미터) */\n.cat-row { padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }\n.cat-row:first-child { border-top: 0; }\n.cat-row:hover .cat-name { text-decoration: underline; }\n.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.cat-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }\n.badge { font-size: 12px; font-weight: 400; color: var(--text-2); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }\n.cat-amounts { font-size: 14px; color: var(--text-2); }\n.cat-amounts b { color: var(--text); }\n.meter { position: relative; height: 10px; border-radius: 4px; background: var(--accent-track); margin: 8px 0 6px; overflow: hidden; }\n.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }\n.meter.warning { background: var(--warning-track); }\n.meter.warning .meter-fill { background: var(--warning); }\n.meter.critical { background: var(--critical-track); }\n.meter.critical .meter-fill { background: var(--critical); }\n.cat-bottom { display: flex; justify-content: space-between; font-size: 13px; gap: 8px; }\n.status { color: var(--text-2); }\n.status.warning { color: var(--text); }\n.status.critical { color: var(--critical-text); font-weight: 600; }\n.remain-good { color: var(--good-text); }\n.remain-bad { color: var(--critical-text); font-weight: 600; }\n.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }\n\n/* 거래 목록 (날짜별 묶음) */\n.tx-date { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 14px 0 4px; border-bottom: 1px solid var(--border); }\n.tx { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n.tx:last-child { border-bottom: 0; }\n.tx-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; }\n.tx-icon.gray { background: var(--gray-mark); }\n.tx-main { min-width: 0; }\n.tx-memo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tx-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }\n.tx-meta select { font-size: 12px; padding: 3px 6px; border-radius: 8px; max-width: 160px; }\n.tx-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n.tx-amount { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.tx-amount.plus { color: var(--accent-text); }\n.tx-amount.neutral { color: var(--muted); font-weight: 600; }\n.list-total { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin: 12px 0 4px; }\n.list-total b { color: var(--text); }\n.filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 8px; }\n@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }\n\n/* ---------- 달력 ---------- */\n.cal-summary { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin-bottom: 12px; }\n.cal-summary b { color: var(--text); font-size: 16px; }\n.cal-summary .plus b { color: var(--accent-text); }\n.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }\n.cal-dow { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }\n.cal-dow.sun { color: var(--critical-text); }\n.cal-day {\n  min-height: 74px; border-radius: 10px; padding: 6px; border: 1px solid transparent;\n  display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--surface-2); text-align: left;\n  font: inherit; color: inherit; min-width: 0;\n}\n.cal-day.out { background: none; cursor: default; opacity: 0.35; }\n.cal-day.today .cal-num { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 6px; }\n.cal-day.selected { border-color: var(--accent); }\n.cal-num { font-size: 12px; font-weight: 600; align-self: flex-start; }\n.cal-spent, .cal-income { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n.cal-spent { color: var(--text); }\n.cal-income { color: var(--accent-text); }\n.cal-day.h1 { background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }\n.cal-day.h2 { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }\n.cal-day.h3 { background: color-mix(in srgb, var(--accent) 36%, var(--surface-2)); }\n@media (max-width: 520px) { .cal-day { min-height: 56px; padding: 4px; } .cal-spent, .cal-income { font-size: 10px; } }\n\n/* ---------- 리포트 ---------- */\n.headline-figure { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0; }\n.delta { font-size: 14px; color: var(--text-2); }\n.delta b { color: var(--text); }\n.share-bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 14px; }\n.share-bar span { display: block; height: 100%; min-width: 2px; }\n.share-bar span:first-child { border-radius: 4px 0 0 4px; }\n.share-bar span:last-child { border-radius: 0 4px 4px 0; }\n.share-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.share-row:first-of-type { border-top: 0; }\n.share-name { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.share-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.share-amount { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.share-diff { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }\n.rank { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rank:first-of-type { border-top: 0; }\n.rank .n { color: var(--muted); font-weight: 700; text-align: center; }\n.rank .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rank .a { font-weight: 600; font-variant-numeric: tabular-nums; }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.chart svg { width: 100%; height: auto; display: block; overflow: visible; stroke: none; }\n.chart .grid-line { stroke: var(--border); stroke-width: 1; }\n.chart .axis-label { fill: var(--muted); font-size: 11px; }\n.chart .hit { fill: transparent; cursor: pointer; }\n.chart .hit:hover { fill: color-mix(in srgb, var(--text) 5%, transparent); }\n\n/* ---------- 자산 ---------- */\n.acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--border); }\n.acct:first-child { border-top: 0; }\n.acct-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }\n.acct-icon.is-card { background: var(--surface-2); color: var(--text-2); }\n.acct-name { font-weight: 600; }\n.acct-sub { font-size: 12px; color: var(--muted); }\n.acct-bal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }\n.acct-bal .acct-sub { font-weight: 400; }\n\n/* ---------- 예산 계획 ---------- */\n.plan-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 1.5fr 1.5fr auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.plan-row.head { border-top: 0; font-size: 13px; color: var(--text-2); padding-top: 0; }\n.plan-row input, .plan-row select { width: 100%; }\n.value-wrap { position: relative; }\n.value-wrap input { padding-right: 28px; text-align: right; }\n.value-wrap .unit { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13px; pointer-events: none; }\n.plan-row .preview { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-top: -4px; }\n@media (max-width: 1100px) {\n  .plan-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type value value\" \"desc desc desc\" \"kw kw kw\" \"pv pv pv\"; }\n  .plan-row.head { display: none; }\n  .plan-row .pl-name { grid-area: name; }\n  .plan-row .pl-type { grid-area: type; }\n  .plan-row .value-wrap { grid-area: value; }\n  .plan-row .pl-desc { grid-area: desc; }\n  .plan-row .pl-kw { grid-area: kw; }\n  .plan-row .pl-del { grid-area: del; }\n  .plan-row .preview { grid-area: pv; margin-top: 0; }\n}\n.plan-summary { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--surface-2); font-size: 14px; }\n.warn { color: var(--critical-text); font-weight: 600; }\n\n/* ---------- 설정 ---------- */\n.settings-grid { display: grid; grid-template-columns: 160px 1fr; gap: 20px; align-items: start; }\n.settings-nav { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 2px; }\n.settings-nav a { color: var(--text-2); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 14px; }\n.settings-nav a:hover { background: var(--surface-2); }\n.card[id^=\"set-\"] { scroll-margin-top: 72px; }\n@media (max-width: 900px) {\n  .settings-grid { grid-template-columns: 1fr; gap: 0; }\n  .settings-nav { position: static; flex-direction: row; overflow-x: auto; margin-bottom: 12px; gap: 6px; }\n  .settings-nav a { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }\n}\n.acct-row { display: grid; grid-template-columns: 1.4fr 0.9fr 0.8fr 1fr auto auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.acct-row input, .acct-row select { width: 100%; }\n.acct-row .check { display: flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }\n.acct-row .check input { width: auto; }\n@media (max-width: 700px) {\n  .acct-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type last last\" \"bal bal save\"; }\n  .acct-row .a-name { grid-area: name; }\n  .acct-row .a-type { grid-area: type; }\n  .acct-row .a-last { grid-area: last; }\n  .acct-row .a-bal { grid-area: bal; }\n  .acct-row .check { grid-area: save; }\n  .acct-row .link-btn { grid-area: del; }\n}\n.copy-row { display: flex; gap: 8px; margin: 6px 0 12px; }\n.copy-row input { flex: 1; font-size: 13px; }\n.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }\n.steps li { margin: 3px 0; }\n\n/* 표 (붙여넣기 미리보기) */\n.table-wrap { overflow-x: auto; margin-top: 12px; }\ntable { width: 100%; border-collapse: collapse; font-size: 14px; }\nth, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }\nth { font-weight: 600; color: var(--text-2); font-size: 13px; }\ntd.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntd select, td input { width: 100%; padding: 6px 8px; }\ntd.memo { min-width: 120px; word-break: break-all; }\n.refund { color: var(--good-text); }\n@media (max-width: 560px) {\n  .stack-table thead { display: none; }\n  .stack-table tbody tr { display: grid; gap: 6px 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n  .stack-table td { border: 0; padding: 0; min-width: 0; }\n  .parse-table tbody tr { grid-template-columns: auto 1fr 1fr auto; grid-template-areas: \"chk memo memo amt\" \". date cat cat\"; }\n  .parse-table td:nth-child(1) { grid-area: chk; }\n  .parse-table td:nth-child(2) { grid-area: date; }\n  .parse-table td:nth-child(3) { grid-area: memo; }\n  .parse-table td:nth-child(4) { grid-area: amt; }\n  .parse-table td:nth-child(5) { grid-area: cat; }\n}\n\n/* 툴팁 & 토스트 */\n.tooltip {\n  position: fixed; z-index: 50; pointer-events: none;\n  background: var(--surface); color: var(--text);\n  border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);\n  border-radius: 10px; padding: 8px 10px; font-size: 13px; max-width: 240px;\n}\n.tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }\n.tooltip .t-row span:first-child { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }\n.toast {\n  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);\n  background: var(--text); color: var(--page);\n  padding: 10px 16px; border-radius: 10px; z-index: 60; font-size: 14px; max-width: calc(100% - 32px);\n}\n@media (max-width: 900px) { .toast { bottom: calc(80px + env(safe-area-inset-bottom)); } }\n\n/* 처음 접속할 때 키 입력 */\n.key-gate { position: fixed; inset: 0; z-index: 70; background: var(--page); display: grid; place-items: center; padding: 16px; }\n.key-card { width: 100%; max-width: 420px; }\n.key-card input { width: 100%; margin-top: 8px; }\n\n.steps a.primary-btn { color: #fff; text-decoration: none; margin: 4px 0; }\n.steps a { color: var(--accent-text); }\ndetails summary { cursor: pointer; color: var(--text-2); margin-top: 8px; }\n</style>\n</head>\n<body>\n  <noscript>\n    <div style=\"padding:16px;margin:12px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif\">\n      이 화면에서는 앱의 기능(자바스크립트)이 실행되지 않아요. 파일 앱의 <b>미리보기</b>가 아니라 <b>크롬·삼성 인터넷·사파리</b> 같은 브라우저로 열어 주세요.\n    </div>\n  </noscript>\n  <div id=\"boot-error\" hidden style=\"position:fixed;left:12px;right:12px;top:12px;z-index:100;padding:16px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)\"></div>\n  <script>\n    // 앱이 시작되지 못하면 이유를 화면에 보여준다. (오래된 브라우저에서도 돌아가도록 옛 문법으로 작성)\n    (function () {\n      var shown = false;\n      function show(msg) {\n        if (shown) return;\n        shown = true;\n        var el = document.getElementById('boot-error');\n        el.innerHTML = '<b>앱을 시작하지 못했어요.</b><br>브라우저가 오래됐거나 미리보기 화면일 수 있어요. 최신 크롬·삼성 인터넷·사파리로 열어 보고, 그래도 안 되면 이 화면을 캡처해서 알려 주세요.' +\n          '<div style=\"margin-top:8px;font-size:12px;color:#52514e;word-break:break-all\">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent.replace(/</g, '&lt;') + '</div>';\n        el.hidden = false;\n        el.style.display = 'block';\n      }\n      window.addEventListener('error', function (e) {\n        if (!window.__budgetStarted) show(e.message || '알 수 없는 오류');\n      });\n      window.addEventListener('load', function () {\n        setTimeout(function () {\n          if (!window.__budgetStarted) show('기능 코드가 실행되지 않았습니다.');\n        }, 3000);\n      });\n    })();\n  </script>\n  <div id=\"busy\" class=\"busy\" hidden></div>\n\n  <div class=\"app\">\n    <!-- 메뉴 -->\n    <aside class=\"sidebar\" id=\"sidebar\" aria-label=\"메뉴\">\n      <div class=\"brand\">\n        <span class=\"brand-mark\" aria-hidden=\"true\">₩</span>\n        <span>내 지출 관리</span>\n      </div>\n      <nav class=\"nav\" id=\"nav\">\n        <button class=\"nav-item\" data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n        <button class=\"nav-item\" data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n        <button class=\"nav-item\" data-page=\"list\"><svg viewBox=\"0 0 24 24\"><path d=\"M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01\"/></svg>내역</button>\n        <button class=\"nav-item\" data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n        <button class=\"nav-item\" data-page=\"assets\"><svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M16 14.5h2\"/></svg>자산</button>\n        <button class=\"nav-item\" data-page=\"plan\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/></svg>예산 계획</button>\n        <div class=\"nav-sep\"></div>\n        <button class=\"nav-item\" data-page=\"add\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>지출·수입 입력</button>\n        <button class=\"nav-item\" data-page=\"settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3\"/></svg>설정</button>\n      </nav>\n      <div class=\"sidebar-foot\">\n        <span id=\"conn-status\" class=\"chip\"></span>\n      </div>\n    </aside>\n    <div class=\"scrim\" id=\"scrim\" hidden></div>\n\n    <div class=\"main\">\n      <header class=\"topbar\">\n        <button id=\"menu-btn\" class=\"icon-btn menu-btn\" aria-label=\"메뉴 열기\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg></button>\n        <h1 id=\"page-title\">홈</h1>\n        <div class=\"topbar-actions\">\n          <button id=\"refresh-btn\" class=\"icon-btn\" aria-label=\"새로고침\" hidden><svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5\"/></svg></button>\n          <button id=\"add-btn\" class=\"primary-btn add-btn\">+ 입력</button>\n        </div>\n      </header>\n\n      <div class=\"content\">\n        <div class=\"period-nav\" id=\"period-nav\">\n          <button id=\"prev-period\" class=\"icon-btn\" aria-label=\"이전 기간\">‹</button>\n          <div class=\"period-label\">\n            <strong id=\"period-text\"></strong>\n            <span id=\"period-sub\" class=\"muted small\"></span>\n          </div>\n          <button id=\"next-period\" class=\"icon-btn\" aria-label=\"다음 기간\">›</button>\n          <button id=\"today-period\" class=\"ghost-btn small-btn\">오늘</button>\n        </div>\n\n        <!-- 홈 -->\n        <section class=\"page\" data-page=\"home\">\n          <div id=\"income-box\" class=\"card\"></div>\n          <div id=\"stale-box\"></div>\n          <div class=\"grid-2\">\n            <div class=\"card hero-card\" id=\"hero\"></div>\n            <div class=\"card\" id=\"home-summary\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 예산</h2>\n              <span id=\"alloc-note\" class=\"muted small\"></span>\n            </div>\n            <div id=\"category-rows\"></div>\n          </div>\n          <div class=\"grid-2\">\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>최근 내역</h2><button class=\"link\" data-goto=\"list\">전체 보기</button></div>\n              <div id=\"recent-list\"></div>\n            </div>\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>자산</h2><button class=\"link\" data-goto=\"assets\">자세히</button></div>\n              <div id=\"home-assets\"></div>\n            </div>\n          </div>\n        </section>\n\n        <!-- 달력 -->\n        <section class=\"page\" data-page=\"calendar\">\n          <div class=\"card\">\n            <div id=\"cal-summary\" class=\"cal-summary\"></div>\n            <div id=\"calendar\" class=\"calendar\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"day-title\"></h2><span id=\"day-total\" class=\"muted small\"></span></div>\n            <div id=\"day-list\"></div>\n          </div>\n        </section>\n\n        <!-- 내역 -->\n        <section class=\"page\" data-page=\"list\">\n          <div class=\"card\">\n            <div class=\"filters\">\n              <input type=\"search\" id=\"list-search\" placeholder=\"사용처 검색\" aria-label=\"사용처 검색\">\n              <select id=\"list-kind\" aria-label=\"종류\">\n                <option value=\"all\">모든 종류</option>\n                <option value=\"expense\">지출</option>\n                <option value=\"income\">입금</option>\n                <option value=\"transfer\">내 계좌 이체</option>\n              </select>\n              <select id=\"list-filter\" aria-label=\"항목\"></select>\n              <select id=\"list-account\" aria-label=\"결제수단\"></select>\n            </div>\n            <div class=\"row-actions\">\n              <button id=\"reclassify-unclassified\" class=\"ghost-btn small-btn\">미분류만 다시 분류</button>\n              <button id=\"reclassify-all\" class=\"ghost-btn small-btn\">이 기간 전체 다시 분류</button>\n            </div>\n            <div id=\"list-total\" class=\"list-total\"></div>\n            <div id=\"tx-list\"></div>\n            <p class=\"muted small\">항목을 직접 바꾸면 그 사용처를 기억해서 다음부터 같은 항목으로 분류합니다.</p>\n          </div>\n        </section>\n\n        <!-- 리포트 -->\n        <section class=\"page\" data-page=\"report\">\n          <div class=\"grid-2\">\n            <div class=\"card\" id=\"report-headline\"></div>\n            <div class=\"card\" id=\"report-merchants\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>어디에 썼나요</h2><span class=\"muted small\">이번 기간 지출 구성</span></div>\n            <div id=\"report-share\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>기간별 추이</h2><span class=\"muted small\">최근 6개 기간</span></div>\n            <div id=\"report-trend\"></div>\n          </div>\n        </section>\n\n        <!-- 자산 -->\n        <section class=\"page\" data-page=\"assets\">\n          <div class=\"card hero-card\" id=\"asset-hero\"></div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>계좌</h2><button class=\"link\" data-goto=\"settings\">계좌 관리</button></div>\n            <div id=\"asset-banks\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>카드</h2><span class=\"muted small\">이번 기간 사용액</span></div>\n            <div id=\"asset-cards\"></div>\n          </div>\n        </section>\n\n        <!-- 예산 계획 -->\n        <section class=\"page\" data-page=\"plan\">\n          <div id=\"plan-version\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>비율 항목의 기준 금액</h2>\n            <select id=\"ratio-base\" class=\"full\">\n              <option value=\"afterFixed\">수입에서 고정 항목을 뺀 나머지</option>\n              <option value=\"income\">전체 수입</option>\n            </select>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 배분</h2>\n              <button id=\"add-category\" class=\"ghost-btn small-btn\">+ 항목 추가</button>\n            </div>\n            <p class=\"muted small\"><b>수입 비례(%)</b>: 그 기간에 들어온 돈에 비례해 한도가 정해집니다. <b>고정 금액</b>: 수입과 상관없이 매 기간 같은 한도입니다.<br><b>설명</b>은 AI가 지출을 분류할 때 참고합니다. 예: \"외식, 배달, 장보기\". <b>키워드</b>는 쉼표로 구분하며, AI를 쓸 수 없을 때 사용처에 키워드가 들어 있으면 그 항목으로 분류합니다.</p>\n            <div id=\"plan-rows\"></div>\n            <div id=\"plan-summary\" class=\"plan-summary\"></div>\n          </div>\n        </section>\n\n        <!-- 입력 -->\n        <section class=\"page\" data-page=\"add\">\n          <div id=\"auto-hint\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>직접 입력</h2>\n            <div class=\"segmented\" id=\"m-kind\" role=\"radiogroup\" aria-label=\"종류\">\n              <button type=\"button\" data-kind=\"expense\" class=\"active\">지출</button>\n              <button type=\"button\" data-kind=\"income\">입금</button>\n              <button type=\"button\" data-kind=\"transfer\">내 계좌 이체</button>\n            </div>\n            <form id=\"manual-form\" class=\"form-grid\">\n              <label>날짜<input type=\"date\" id=\"m-date\" required></label>\n              <label>금액(원)<input type=\"text\" inputmode=\"numeric\" id=\"m-amount\" placeholder=\"12,000\" required></label>\n              <label class=\"wide\">사용처 / 메모<input type=\"text\" id=\"m-memo\" placeholder=\"스타벅스 강남점\"></label>\n              <label id=\"m-category-wrap\">항목<select id=\"m-category\"></select></label>\n              <label>결제수단<select id=\"m-account\"></select></label>\n              <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">추가</button></div>\n            </form>\n            <p id=\"m-hint\" class=\"muted small\"></p>\n          </div>\n          <div class=\"card\">\n            <h2>내역 붙여넣기</h2>\n            <p class=\"muted small\">카드 승인 문자, 은행/카드 앱 내역, 엑셀에서 복사한 표를 그대로 붙여넣으세요. 한 줄에 한 건씩 날짜·금액·사용처를 읽고 <span id=\"classifier-name\">항목</span>을 자동으로 정합니다.</p>\n            <textarea id=\"paste-input\" rows=\"6\" placeholder=\"예)&#10;2026-09-27 배달의민족 23,500원&#10;9월 25일 카카오T 택시 8,400원&#10;09/24 올리브영 강남점 32,000원\"></textarea>\n            <div class=\"row-actions\">\n              <button id=\"parse-btn\" class=\"primary-btn\">인식하기</button>\n              <button id=\"paste-clear\" class=\"ghost-btn\">지우기</button>\n            </div>\n            <div id=\"parse-result\"></div>\n          </div>\n          <div class=\"card\">\n            <h2>은행 거래내역 파일 가져오기</h2>\n            <p class=\"muted small\">카카오뱅크: 앱에서 계좌 선택 → 오른쪽 위 설정(톱니바퀴) → <b>거래내역</b> → 이메일과 기간을 넣고 받기. 메일로 온 엑셀(.xlsx)이나 CSV 파일을 그대로 올리세요. 다른 은행 파일도 날짜·금액 칸이 있으면 읽습니다. 알림으로 이미 들어온 내역은 <b>중복?</b>으로 표시하고 빼 둡니다.</p>\n            <div class=\"form-grid\">\n              <label>어느 계좌의 내역인가요<select id=\"file-account\"></select></label>\n              <label>파일<input type=\"file\" id=\"file-input\" accept=\".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"></label>\n            </div>\n            <div id=\"file-result\"></div>\n          </div>\n        </section>\n\n        <!-- 설정 -->\n        <section class=\"page\" data-page=\"settings\">\n          <div class=\"settings-grid\">\n            <nav class=\"settings-nav\" aria-label=\"설정 메뉴\">\n              <a href=\"#set-basic\">기본</a>\n              <a href=\"#set-accounts\">계좌·카드</a>\n              <a href=\"#set-auto\">자동 입력</a>\n              <a href=\"#set-data\">데이터</a>\n            </nav>\n            <div>\n              <div class=\"card\" id=\"set-basic\">\n                <h2>기본</h2>\n                <div class=\"form-grid\">\n                  <label>매 기간 시작일\n                    <select id=\"start-day\"></select>\n                  </label>\n                  <label>내 이름\n                    <input type=\"text\" id=\"my-name\" placeholder=\"홍길동\" autocomplete=\"name\">\n                  </label>\n                </div>\n                <p class=\"muted small\">기간: 예를 들어 25일로 하면 9/25 ~ 10/24 가 한 기간입니다. 없는 날짜(31일 등)는 그 달의 말일로 계산합니다.<br>내 이름: 이체 알림의 상대방이 내 이름이면 내 계좌끼리 옮긴 돈으로 보고 지출에서 뺍니다.</p>\n              </div>\n\n              <div class=\"card\" id=\"set-accounts\">\n                <div class=\"card-head\"><h2>계좌·카드</h2><button id=\"add-account\" class=\"ghost-btn small-btn\">+ 추가</button></div>\n                <p class=\"muted small\">번호는 <b>끝 4자리</b>만 넣으세요. 알림에 적힌 번호로 어느 계좌·카드의 거래인지 찾고, 은행 알림의 잔액으로 계좌 잔액을 자동으로 갱신합니다. <b>저축 계좌</b>로 옮긴 돈은 저축 항목 지출로 기록합니다.</p>\n                <div id=\"account-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-auto\"></div>\n\n              <div class=\"card\" id=\"set-data\">\n                <h2>데이터</h2>\n                <p id=\"data-note\" class=\"muted small\"></p>\n                <div class=\"row-actions\">\n                  <button id=\"export-btn\" class=\"ghost-btn\">백업 내보내기(JSON)</button>\n                  <label class=\"ghost-btn file-btn\">백업 불러오기<input type=\"file\" id=\"import-file\" accept=\"application/json,.json\" hidden></label>\n                  <button id=\"reset-btn\" class=\"danger-btn\">전체 초기화</button>\n                </div>\n              </div>\n            </div>\n          </div>\n        </section>\n      </div>\n    </div>\n\n    <!-- 휴대폰 하단 메뉴 -->\n    <nav class=\"bottom-nav\" aria-label=\"빠른 메뉴\">\n      <button data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n      <button data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n      <button data-page=\"add\" class=\"bn-add\" aria-label=\"입력\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n      <button data-open-menu><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg>전체</button>\n    </nav>\n  </div>\n\n  <div id=\"tooltip\" class=\"tooltip\" role=\"tooltip\" hidden></div>\n  <div id=\"toast\" class=\"toast\" hidden></div>\n\n  <script>/*__SERVER_CONFIG__*/</script>\n  <script>\n/*\n * 지출 관리 앱의 순수 로직 (DOM 없음).\n * 브라우저에서는 window.BudgetLogic 으로, Node(테스트)에서는 require 로 사용한다.\n * 날짜는 모두 'YYYY-MM-DD' 문자열로 다룬다 (시간대 문제 회피).\n */\n(function (root, factory) {\n  const api = factory();\n  if (typeof module !== 'undefined' && module.exports) module.exports = api;\n  else root.BudgetLogic = api;\n})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n  'use strict';\n\n  // ---------- 날짜 ----------\n\n  function pad(n) {\n    return String(n).padStart(2, '0');\n  }\n\n  function toISO(y, m, d) {\n    return `${y}-${pad(m)}-${pad(d)}`;\n  }\n\n  function parseISO(s) {\n    const [y, m, d] = s.split('-').map(Number);\n    return { y, m, d };\n  }\n\n  function daysInMonth(y, m) {\n    return new Date(Date.UTC(y, m, 0)).getUTCDate();\n  }\n\n  function addMonths(y, m, delta) {\n    const idx = y * 12 + (m - 1) + delta;\n    return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };\n  }\n\n  function addDays(iso, delta) {\n    const { y, m, d } = parseISO(iso);\n    const dt = new Date(Date.UTC(y, m - 1, d + delta));\n    return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());\n  }\n\n  function diffDays(a, b) {\n    const pa = parseISO(a);\n    const pb = parseISO(b);\n    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);\n  }\n\n  function todayISO(now = new Date()) {\n    return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());\n  }\n\n  // 시작일이 해당 월에 없으면(예: 31일) 그 달의 말일로 맞춘다.\n  function periodStartInMonth(y, m, startDay) {\n    return toISO(y, m, Math.min(startDay, daysInMonth(y, m)));\n  }\n\n  function getPeriod(dateISO, startDay) {\n    const { y, m } = parseISO(dateISO);\n    let start = periodStartInMonth(y, m, startDay);\n    let sy = y;\n    let sm = m;\n    if (dateISO < start) {\n      ({ y: sy, m: sm } = addMonths(y, m, -1));\n      start = periodStartInMonth(sy, sm, startDay);\n    }\n    const next = addMonths(sy, sm, 1);\n    const nextStart = periodStartInMonth(next.y, next.m, startDay);\n    return { start, end: addDays(nextStart, -1), key: start };\n  }\n\n  function shiftPeriod(period, delta, startDay) {\n    const { y, m } = parseISO(period.start);\n    const t = addMonths(y, m, delta);\n    return getPeriod(periodStartInMonth(t.y, t.m, startDay), startDay);\n  }\n\n  // ---------- 예산 계산 ----------\n\n  /*\n   * categories: [{ id, name, type: 'ratio' | 'fixed', value }]\n   *   ratio → value 는 퍼센트, fixed → value 는 원 단위 금액\n   * ratioBase: 'income'     → 비율 항목은 전체 수입 기준\n   *            'afterFixed' → 비율 항목은 (수입 - 고정 항목 합계) 기준\n   */\n  function computeBudgets(categories, income, ratioBase) {\n    const inc = Math.max(0, Number(income) || 0);\n    const fixedTotal = categories\n      .filter((c) => c.type === 'fixed')\n      .reduce((s, c) => s + (Number(c.value) || 0), 0);\n    const ratioPercentTotal = categories\n      .filter((c) => c.type === 'ratio')\n      .reduce((s, c) => s + (Number(c.value) || 0), 0);\n    const base = ratioBase === 'afterFixed' ? Math.max(0, inc - fixedTotal) : inc;\n\n    const budgets = {};\n    for (const c of categories) {\n      budgets[c.id] = c.type === 'fixed'\n        ? Math.round(Number(c.value) || 0)\n        : Math.round((base * (Number(c.value) || 0)) / 100);\n    }\n    const allocated = Object.values(budgets).reduce((s, v) => s + v, 0);\n    return { budgets, fixedTotal, ratioPercentTotal, ratioBaseAmount: base, allocated, unallocated: inc - allocated };\n  }\n\n  // 거래 종류: expense(지출, 기본) / income(입금) / transfer(내 계좌끼리 이체 — 지출·수입에서 제외)\n  function kindOf(t) {\n    return t.kind === 'income' || t.kind === 'transfer' ? t.kind : 'expense';\n  }\n\n  function txsInPeriod(state, period) {\n    return state.transactions.filter((t) => t.date >= period.start && t.date <= period.end);\n  }\n\n  function summarizePeriod(state, period) {\n    const plan = planFor(state, period.key);\n    const income = state.incomes[period.key];\n    const hasIncome = typeof income === 'number';\n    const calc = computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase);\n    const all = txsInPeriod(state, period);\n    const txs = all.filter((t) => kindOf(t) === 'expense');\n    const known = new Set(plan.categories.map((c) => c.id));\n\n    const spent = {};\n    const counts = {};\n    for (const c of plan.categories) {\n      spent[c.id] = 0;\n      counts[c.id] = 0;\n    }\n    let unclassified = 0;\n    let unclassifiedCount = 0;\n    for (const t of txs) {\n      if (t.categoryId && known.has(t.categoryId)) {\n        spent[t.categoryId] += t.amount;\n        counts[t.categoryId] += 1;\n      } else {\n        unclassified += t.amount;\n        unclassifiedCount += 1;\n      }\n    }\n    const totalSpent = txs.reduce((s, t) => s + t.amount, 0);\n    const incomeReceived = all.filter((t) => kindOf(t) === 'income').reduce((s, t) => s + t.amount, 0);\n\n    const rows = plan.categories.map((c) => {\n      const budget = calc.budgets[c.id];\n      const used = spent[c.id];\n      return {\n        category: c,\n        budget,\n        spent: used,\n        count: counts[c.id],\n        remaining: budget - used,\n        ratio: budget > 0 ? used / budget : used > 0 ? Infinity : 0,\n      };\n    });\n\n    // 계획이 바뀐 뒤에 아직 다시 분류되지 않은 (직접 고르지 않은) 지출\n    const staleCount = txs.filter(\n      (t) => t.method !== 'manual' && (!t.classifiedAt || (plan.updatedAt && t.classifiedAt < plan.updatedAt))\n    ).length;\n\n    return {\n      period,\n      plan,\n      staleCount,\n      income: hasIncome ? income : null,\n      hasIncome,\n      ...calc,\n      rows,\n      unclassified,\n      unclassifiedCount,\n      totalSpent,\n      incomeReceived,\n      remaining: (hasIncome ? income : 0) - totalSpent,\n      transactions: txs,\n      allTransactions: all,\n    };\n  }\n\n  function statusOf(ratio) {\n    if (ratio > 1) return 'critical';\n    if (ratio >= 0.8) return 'warning';\n    return 'good';\n  }\n\n  // ---------- 자동 분류 ----------\n\n  function normalizeMerchant(s) {\n    return String(s || '').toLowerCase().replace(/\\s+/g, '');\n  }\n\n  // 1) 직접 분류해 둔 가맹점(학습) → 2) 가장 긴 키워드가 일치하는 항목\n  function classify(memo, categories, merchantMap = {}) {\n    const norm = normalizeMerchant(memo);\n    if (!norm) return null;\n    const known = new Set(categories.map((c) => c.id));\n    const learned = merchantMap[norm];\n    if (learned && known.has(learned)) return learned;\n\n    let best = null;\n    let bestLen = 0;\n    for (const c of categories) {\n      for (const kw of c.keywords || []) {\n        const k = normalizeMerchant(kw);\n        if (k && k.length > bestLen && norm.includes(k)) {\n          best = c.id;\n          bestLen = k.length;\n        }\n      }\n    }\n    return best;\n  }\n\n  // AI 없이 분류: { categoryId, method: 'learned' | 'keyword' | null }\n  function classifyLocal(memo, categories, merchantMap = {}) {\n    const known = new Set(categories.map((c) => c.id));\n    const learned = merchantMap[normalizeMerchant(memo)];\n    if (learned && known.has(learned)) return { categoryId: learned, method: 'learned' };\n    const id = classify(memo, categories, {});\n    return id ? { categoryId: id, method: 'keyword' } : { categoryId: null, method: null };\n  }\n\n  // ---------- 지출 내역 텍스트 인식 ----------\n\n  const NOISE_PATTERNS = [\n    /\\[?web\\s*발신\\]?/gi,\n    /\\[[^\\]]*\\]/g,\n    /(누적|잔액|잔고|한도)\\s*:?\\s*-?[\\d,]+\\s*원?/g,\n    /\\(?\\s*(일시불|할부\\s*\\d*\\s*개?월?|\\d+\\s*개월)\\s*\\)?/g,\n    /\\(\\s*[\\d*]{3,4}\\s*\\)/g, // 카드 끝자리 (1234)\n    /\\*\\d{3,4}/g,\n    /\\S\\*\\S/g, // 마스킹된 이름 홍*동\n    /\\d{1,2}:\\d{2}(:\\d{2})?/g, // 시각\n    /(체크|신용)?\\s*승인(취소)?/g,\n    /결제(완료)?|사용(완료)?|출금/g,\n    /(^|\\s)\\S{1,6}카드(?=\\s|$)/g, // 신한카드, KB국민카드 ...\n  ];\n\n  function inferYear(month, day, refISO) {\n    const ref = parseISO(refISO);\n    let year = ref.y;\n    // 기준일보다 한참 미래라면 작년 내역으로 본다 (예: 1월에 12월 내역 붙여넣기)\n    if (diffDays(refISO, toISO(year, month, Math.min(day, daysInMonth(year, month)))) > 7) year -= 1;\n    return year;\n  }\n\n  function validDate(y, m, d) {\n    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);\n  }\n\n  function extractDate(line, refISO) {\n    let m = line.match(/(20\\d{2})\\s*[.\\-/년]\\s*(\\d{1,2})\\s*[.\\-/월]\\s*(\\d{1,2})\\s*일?/);\n    if (m) {\n      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];\n      if (validDate(y, mo, d)) return { date: toISO(y, mo, d), rest: line.replace(m[0], ' ') };\n    }\n    // 앞에 숫자·쉼표가 없는 09/28 같은 날짜. (오래된 iOS 사파리가 정규식 lookbehind 를 못 읽어서\n    // 앞 글자를 그룹으로 잡고 되돌려 놓는다)\n    let keep = '';\n    m = line.match(/(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일/);\n    if (!m) {\n      const mm = line.match(/(^|[^\\d,])(\\d{1,2})[/.\\-](\\d{1,2})(?![\\d,])/);\n      if (mm) {\n        keep = mm[1];\n        m = [mm[0], mm[2], mm[3]];\n      }\n    }\n    if (m) {\n      const [mo, d] = [Number(m[1]), Number(m[2])];\n      const y = inferYear(mo, d, refISO);\n      if (validDate(y, mo, d)) return { date: toISO(y, mo, d), rest: line.replace(m[0], `${keep} `) };\n    }\n    return { date: null, rest: line };\n  }\n\n  function extractAmount(line) {\n    // [정규식, 금액 그룹, 되돌려 놓을 앞 글자 그룹]\n    const patterns = [\n      [/(-?\\d[\\d,]*)\\s*원/, 1, 0], // 12,000원\n      [/(-?\\d{1,3}(?:,\\d{3})+)(?!\\d)/, 1, 0], // 12,000\n      [/(^|\\D)(-?\\d{3,})(?!\\d)/, 2, 1], // 12000\n    ];\n    for (const [p, g, k] of patterns) {\n      const m = line.match(p);\n      if (m) {\n        const n = Number(m[g].replace(/,/g, ''));\n        if (Number.isFinite(n) && n !== 0) return { amount: n, rest: line.replace(m[0], `${k ? m[k] : ''} `) };\n      }\n    }\n    return { amount: null, rest: line };\n  }\n\n  function cleanMemo(s) {\n    let out = s;\n    for (const p of NOISE_PATTERNS) out = out.replace(p, ' ');\n    return out\n      .replace(/[\\t,|;]+/g, ' ')\n      .replace(/^[\\s\\-:·/()]+|[\\s\\-:·/()]+$/g, '')\n      .replace(/\\s+/g, ' ')\n      .trim();\n  }\n\n  /*\n   * 여러 줄의 텍스트(카드 문자, 은행 앱 내역, 엑셀 복사 등)에서 지출을 뽑아낸다.\n   * 반환: { items: [{ date, amount, memo, raw }], skipped: [raw...] }\n   */\n  function parseExpenseText(text, refISO) {\n    const items = [];\n    const skipped = [];\n    for (const rawLine of String(text || '').split(/\\r?\\n/)) {\n      const raw = rawLine.trim();\n      if (!raw) continue;\n      const isCancel = /취소|환불/.test(raw);\n      // 누적/잔액 금액이 결제 금액으로 잡히지 않도록 먼저 제거\n      let work = raw\n        .replace(/(누적|잔액|잔고|한도)\\s*:?\\s*-?[\\d,]+\\s*원?/g, ' ')\n        .replace(/\\d{1,2}:\\d{2}(:\\d{2})?/g, ' ')\n        .replace(/\\(\\s*[\\d*]{3,4}\\s*\\)|\\*\\d{3,4}/g, ' ')\n        .replace(/\\t/g, ' ');\n      const d = extractDate(work, refISO);\n      work = d.rest;\n      const a = extractAmount(work);\n      if (a.amount === null) {\n        skipped.push(raw);\n        continue;\n      }\n      let amount = Math.abs(a.amount);\n      if (isCancel || a.amount < 0) amount = -amount;\n      const memo = cleanMemo(a.rest.replace(/취소|환불/g, ' ')) || '(내용 없음)';\n      items.push({ date: d.date || refISO, amount, memo, raw });\n    }\n    return { items, skipped };\n  }\n\n  function isDuplicate(item, transactions) {\n    return transactions.some(\n      (t) => t.date === item.date && t.amount === item.amount && normalizeMerchant(t.memo) === normalizeMerchant(item.memo)\n    );\n  }\n\n  // ---------- 결제·입출금 알림 (카드 문자, 은행 앱 알림) ----------\n\n  // 거래 알림처럼 보이는 글인지 (인증번호, 광고 등은 제외)\n  function looksLikeTransaction(text) {\n    const t = String(text || '');\n    if (!/[\\d,]+\\s*원/.test(t)) return false;\n    if (/인증\\s*번호|인증코드/.test(t)) return false;\n    return /승인|결제|사용|취소|출금|입금|이체|송금|보냈|받았/.test(t);\n  }\n\n  function digitsOnly(s) {\n    return String(s || '').replace(/\\D/g, '');\n  }\n\n  // 알림에 적힌 계좌·카드 번호(가려진 번호 포함)의 끝자리로 등록된 계좌/카드를 찾는다\n  function matchAccount(text, accounts) {\n    const chunks = String(text || '').match(/[\\d*][\\d*\\-]{2,}/g) || [];\n    for (const a of accounts || []) {\n      const last4 = digitsOnly(a.last4).slice(-4);\n      if (last4.length < 3) continue;\n      for (const c of chunks) {\n        if (/^\\d{4}-\\d{2}-\\d{2}$/.test(c)) continue; // 날짜\n        if (digitsOnly(c).endsWith(last4)) return a;\n      }\n    }\n    return null;\n  }\n\n  function accountByLast4(last4, accounts) {\n    const d = digitsOnly(last4).slice(-4);\n    if (d.length < 3) return null;\n    return (accounts || []).find((a) => digitsOnly(a.last4).slice(-4) === d) || null;\n  }\n\n  // AI 없이 알림을 읽을 때 거래 종류 추측\n  function detectKind(text, myName) {\n    const t = String(text || '');\n    if (/승인|결제/.test(t)) return 'expense';\n    if (myName && t.includes(myName) && /이체|출금|송금|보냈|입금|받았/.test(t)) return 'transfer';\n    if (/입금|받았/.test(t) && !/출금/.test(t)) return 'income';\n    return 'expense';\n  }\n\n  // AI 를 쓸 수 없을 때의 알림 인식. 여러 줄 알림을 한 줄로 합쳐서 읽는다.\n  // 반환: { date, amount, memo, kind, accountId, balance } 또는 null\n  function parseMessageFallback(text, refISO, opts = {}) {\n    if (!looksLikeTransaction(text)) return null;\n    const balanceMatch = String(text).match(/잔액\\s*:?\\s*([\\d,]+)\\s*원?/);\n    const account = matchAccount(text, opts.accounts);\n    const oneLine = String(text)\n      .replace(/\\r?\\n/g, ' ')\n      .replace(/(?:[\\d\\-]+\\*+|\\*+[\\d\\-]+)[\\d*\\-]*|\\d{3,}-\\d{2,}-\\d{3,}/g, ' ') // 가려진 번호, 계좌번호\n      .replace(/입금|이체|송금|보냈어요|받았어요|님에게|님이/g, ' ');\n    const { items } = parseExpenseText(oneLine, refISO);\n    const item = items[0];\n    if (!item) return null;\n    const kind = detectKind(text, opts.myName);\n    return {\n      date: item.date,\n      amount: kind === 'expense' ? item.amount : Math.abs(item.amount),\n      memo: item.memo,\n      kind,\n      accountId: account ? account.id : null,\n      balance: balanceMatch ? Number(balanceMatch[1].replace(/,/g, '')) : null,\n    };\n  }\n\n  // ---------- 기간별 자산관리계획 ----------\n\n  const BASE_PLAN_FROM = '0000-01-01';\n\n  // 해당 기간에 적용되는 계획: 시작일이 그 기간 이전인 계획 중 가장 최근 것\n  function planFor(state, periodKey) {\n    const plans = state.plans;\n    let found = plans[0];\n    for (const p of plans) if (p.from <= periodKey) found = p;\n    return found;\n  }\n\n  // 이 기간부터 적용되는 계획을 수정하려고 할 때 호출. 없으면 직전 계획을 복사해서 만든다.\n  function ensurePlanFor(state, periodKey, nowISO) {\n    const existing = state.plans.find((p) => p.from === periodKey);\n    if (existing) return existing;\n    const base = planFor(state, periodKey);\n    const copy = JSON.parse(JSON.stringify(base));\n    copy.from = periodKey;\n    copy.updatedAt = nowISO;\n    state.plans.push(copy);\n    state.plans.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));\n    return copy;\n  }\n\n  function nextPlanAfter(state, plan) {\n    return state.plans.find((p) => p.from > plan.from) || null;\n  }\n\n  // 시작일을 바꾸면 기간 키(시작 날짜)를 같은 달의 새 시작일로 옮긴다.\n  function remapPeriodKeys(state, newStartDay) {\n    const move = (key) => {\n      if (key === BASE_PLAN_FROM) return key;\n      const { y, m } = parseISO(key);\n      return toISO(y, m, Math.min(newStartDay, daysInMonth(y, m)));\n    };\n    const incomes = {};\n    for (const [k, v] of Object.entries(state.incomes)) incomes[move(k)] = v;\n    state.incomes = incomes;\n    for (const p of state.plans) p.from = move(p.from);\n    state.settings.startDay = newStartDay;\n  }\n\n  // ---------- AI 분류 요청 만들기 / 결과 읽기 ----------\n  // 실제 API 호출은 서버(Apps Script)에서 한다. 여기서는 프롬프트와 JSON 스키마만 만든다.\n\n  function categoryBrief(categories, merchantMap) {\n    const examples = {};\n    for (const [merchant, id] of Object.entries(merchantMap || {})) {\n      (examples[id] = examples[id] || []).push(merchant);\n    }\n    return categories.map((c) => ({\n      id: c.id,\n      name: c.name,\n      description: c.description || '',\n      keywords: (c.keywords || []).slice(0, 20),\n      examples: (examples[c.id] || []).slice(-10),\n    }));\n  }\n\n  const CLASSIFY_SYSTEM = [\n    '당신은 한국어 가계부의 지출 분류기입니다.',\n    '사용자가 정해 둔 자산관리계획 항목 목록이 주어지면, 각 지출을 가장 알맞은 항목 id 하나로 분류하세요.',\n    '항목의 이름, 설명, 키워드, 사용자가 예전에 직접 분류한 가맹점 예시(examples)를 근거로 판단합니다.',\n    '가맹점 이름만으로 업종을 추론해도 됩니다. 어느 항목에도 맞지 않거나 도저히 판단할 수 없으면 \"none\"을 고르세요.',\n  ].join('\\n');\n\n  function buildClassifyRequest(categories, items, merchantMap) {\n    const ids = categories.map((c) => c.id);\n    const user = JSON.stringify({\n      categories: categoryBrief(categories, merchantMap),\n      expenses: items.map((it, i) => ({ index: i, merchant: it.memo, amount: it.amount, date: it.date })),\n    });\n    const schema = {\n      type: 'object',\n      properties: {\n        results: {\n          type: 'array',\n          items: {\n            type: 'object',\n            properties: {\n              index: { type: 'integer' },\n              categoryId: { type: 'string', enum: ids.concat(['none']) },\n            },\n            required: ['index', 'categoryId'],\n            additionalProperties: false,\n          },\n        },\n      },\n      required: ['results'],\n      additionalProperties: false,\n    };\n    return { system: CLASSIFY_SYSTEM, user, schema };\n  }\n\n  // AI 응답 → items 와 같은 길이의 categoryId 배열 (알 수 없으면 null)\n  function readClassifyResponse(json, categories, count) {\n    const known = new Set(categories.map((c) => c.id));\n    const out = new Array(count).fill(null);\n    for (const r of (json && json.results) || []) {\n      if (Number.isInteger(r.index) && r.index >= 0 && r.index < count && known.has(r.categoryId)) {\n        out[r.index] = r.categoryId;\n      }\n    }\n    return out;\n  }\n\n  const MESSAGE_SYSTEM = [\n    '당신은 한국 카드사·은행의 결제/입출금 알림(문자 또는 앱 알림)을 읽어 가계부에 기록하는 도우미입니다.',\n    '알림에서 거래 종류, 날짜, 금액(원), 가맹점 또는 상대방 이름, 잔액을 뽑고, 지출이면 사용자의 자산관리계획 항목 중 알맞은 항목 id 로 분류하세요.',\n    '',\n    'kind 규칙:',\n    '- expense: 카드 결제, 계좌에서 다른 사람·가게로 보낸 출금/이체, 자동이체, 공과금',\n    '- income: 다른 사람이나 회사에서 들어온 입금 (급여, 환급 등)',\n    '- own_transfer: 사용자 본인 계좌끼리 옮긴 돈. 상대방 이름이 사용자 이름(my_name)과 같거나, 알림의 상대 계좌가 사용자의 등록 계좌(accounts)이면 해당합니다.',\n    '- not_transaction: 인증번호, 광고, 안내 등 거래가 아닌 알림',\n    '',\n    '- 본인 계좌로 옮긴 돈이 저축 계좌(isSavings)나 적금·청약·증권 계좌로 들어가는 출금이면 to_savings 를 true 로 하고 categoryId 를 저축 성격의 항목으로 고르세요. 그 밖에는 false.',\n    '- 누적 금액, 한도, 카드·계좌 번호, 승인번호는 거래 금액이 아닙니다. 잔액이 적혀 있으면 balance 에, 없으면 -1.',\n    '- account_last4: 이 알림이 어느 등록 계좌/카드에서 일어난 거래인지 그 끝 4자리. 모르면 빈 문자열.',\n    '- 승인취소/환불이면 is_cancel 을 true 로 하세요.',\n    '- date 는 YYYY-MM-DD. 연도가 없으면 오늘(today) 기준 가장 가까운 과거 날짜, 날짜가 없으면 today.',\n    '- 지출이 아니거나 알맞은 항목이 없으면 categoryId 를 \"none\" 으로 하세요.',\n  ].join('\\n');\n\n  function buildMessageRequest(categories, text, todayISO, merchantMap, opts = {}) {\n    const ids = categories.map((c) => c.id);\n    const user = JSON.stringify({\n      today: todayISO,\n      my_name: opts.myName || '',\n      accounts: (opts.accounts || []).map((a) => ({ name: a.name, type: a.type, last4: digitsOnly(a.last4).slice(-4), isSavings: !!a.isSavings })),\n      categories: categoryBrief(categories, merchantMap),\n      message: String(text),\n    });\n    const schema = {\n      type: 'object',\n      properties: {\n        kind: { type: 'string', enum: ['expense', 'income', 'own_transfer', 'not_transaction'] },\n        is_cancel: { type: 'boolean' },\n        to_savings: { type: 'boolean' },\n        date: { type: 'string' },\n        amount: { type: 'integer' },\n        merchant: { type: 'string' },\n        account_last4: { type: 'string' },\n        balance: { type: 'integer' },\n        categoryId: { type: 'string', enum: ids.concat(['none']) },\n      },\n      required: ['kind', 'is_cancel', 'to_savings', 'date', 'amount', 'merchant', 'account_last4', 'balance', 'categoryId'],\n      additionalProperties: false,\n    };\n    return { system: MESSAGE_SYSTEM, user, schema };\n  }\n\n  // AI 응답 → { date, amount, memo, kind, categoryId, accountId, balance } 또는 null(거래 아님)\n  function readMessageResponse(json, categories, todayISO, accounts) {\n    if (!json || !json.kind || json.kind === 'not_transaction') return null;\n    const amountAbs = Math.abs(Math.round(Number(json.amount) || 0));\n    if (!amountAbs) return null;\n    let date = String(json.date || '');\n    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) date = todayISO;\n    const known = new Set(categories.map((c) => c.id));\n    const categoryId = known.has(json.categoryId) ? json.categoryId : null;\n    const account = accountByLast4(json.account_last4, accounts);\n\n    let kind = 'expense';\n    if (json.kind === 'income') kind = 'income';\n    else if (json.kind === 'own_transfer' && !json.to_savings) kind = 'transfer';\n\n    return {\n      date,\n      amount: kind === 'expense' && json.is_cancel ? -amountAbs : amountAbs,\n      memo: String(json.merchant || '').trim() || '(내용 없음)',\n      kind,\n      categoryId: kind === 'expense' ? categoryId : null,\n      accountId: account ? account.id : null,\n      balance: Number.isInteger(json.balance) && json.balance >= 0 ? json.balance : null,\n    };\n  }\n\n  // ---------- 은행 거래내역 파일 (엑셀/CSV) ----------\n  // 은행마다 항목 이름이 달라서, 머리글(첫 줄)의 이름을 보고 칸을 찾는다.\n\n  const COLUMN_HINTS = [\n    ['date', /거래\\s*일시|거래\\s*일자|거래\\s*날짜|^일시$|^날짜$|^일자$|^거래일$/],\n    ['time', /^시간$|거래\\s*시간|^시각$/],\n    ['category', /거래\\s*구분|거래\\s*유형|거래\\s*종류/],\n    ['type', /^구분$|입출금\\s*구분|입\\s*\\/\\s*출금|^입출금$/],\n    ['out', /출금\\s*(액|금액)?$|찾으신\\s*금액|지급\\s*(액|금액)?$/],\n    ['in', /입금\\s*(액|금액)?$|맡기신\\s*금액/],\n    ['amount', /거래\\s*금액|^금액$/],\n    ['balance', /잔액/],\n    ['memo', /^내용$|거래\\s*내용|적요|받는\\s*분|보낸\\s*분|거래처|기재\\s*내용|상대/],\n    ['note', /^메모$/],\n  ];\n\n  function cellText(v) {\n    return v === null || v === undefined ? '' : String(v).trim();\n  }\n\n  function findHeader(rows) {\n    for (let r = 0; r < Math.min(rows.length, 30); r++) {\n      const cols = {};\n      (rows[r] || []).forEach((cell, c) => {\n        const name = cellText(cell).replace(/\\s+/g, ' ');\n        if (!name) return;\n        for (const [key, re] of COLUMN_HINTS) {\n          if (cols[key] === undefined && re.test(name)) {\n            cols[key] = c;\n            break;\n          }\n        }\n      });\n      if (cols.date !== undefined && (cols.amount !== undefined || cols.out !== undefined || cols.in !== undefined)) return { row: r, cols };\n    }\n    return null;\n  }\n\n  // 엑셀 날짜 일련번호(45928 등) 또는 \"2026.09.28 14:02\" 같은 글자 → { date, time }\n  function parseDateCell(v) {\n    if (typeof v === 'number' && v > 20000 && v < 80000) {\n      const ms = Math.round((v - 25569) * 86400000);\n      const d = new Date(ms);\n      return {\n        date: toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),\n        time: Number.isInteger(v) ? '' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,\n      };\n    }\n    const s = cellText(v);\n    const m = s.match(/(\\d{4})\\s*[.\\-/년]\\s*(\\d{1,2})\\s*[.\\-/월]\\s*(\\d{1,2})/);\n    if (!m) return null;\n    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];\n    if (!validDate(y, mo, d)) return null;\n    const t = s.slice(m.index + m[0].length).match(/(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/);\n    return { date: toISO(y, mo, d), time: t ? `${pad(t[1])}:${t[2]}:${t[3] || '00'}` : '' };\n  }\n\n  function parseAmountCell(v) {\n    if (typeof v === 'number') return v;\n    let s = cellText(v).replace(/[,\\s원]/g, '');\n    if (!s) return null;\n    let neg = false;\n    if (/^\\(.*\\)$/.test(s)) {\n      neg = true;\n      s = s.slice(1, -1);\n    }\n    const n = Number(s);\n    if (!Number.isFinite(n)) return null;\n    return neg ? -n : n;\n  }\n\n  /*\n   * 거래내역 표(2차원 배열)를 내역으로 바꾼다.\n   * opts: { myName, accountId }\n   * 반환: { items: [{date, time, amount, memo, kind, accountId, balance, raw}], skipped, header, latest: {date, time, balance} | null }\n   */\n  function parseStatementRows(rows, opts = {}) {\n    const header = findHeader(rows);\n    if (!header) return { items: [], skipped: 0, header: null, latest: null };\n    const { cols } = header;\n    const get = (row, key) => (cols[key] === undefined ? '' : row[cols[key]]);\n    const items = [];\n    let skipped = 0;\n    let latest = null;\n    // 금액 한 칸에 출금은 음수로 적는 파일인지 (그렇다면 양수는 입금)\n    const signed = cols.amount !== undefined && rows.slice(header.row + 1).some((row) => (parseAmountCell((row || [])[cols.amount]) || 0) < 0);\n\n    for (let r = header.row + 1; r < rows.length; r++) {\n      const row = rows[r] || [];\n      if (!row.some((c) => cellText(c))) continue;\n      const when = parseDateCell(get(row, 'date'));\n      if (!when) {\n        skipped += 1;\n        continue;\n      }\n      if (!when.time && cols.time !== undefined) {\n        const t = cellText(get(row, 'time')).match(/(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/);\n        if (t) when.time = `${pad(t[1])}:${t[2]}:${t[3] || '00'}`;\n      }\n\n      const typeText = cellText(get(row, 'type'));\n      const categoryText = cellText(get(row, 'category'));\n      const out = parseAmountCell(get(row, 'out'));\n      const inn = parseAmountCell(get(row, 'in'));\n      const amt = parseAmountCell(get(row, 'amount'));\n\n      let kind;\n      let amount;\n      if (out) {\n        kind = 'expense';\n        amount = Math.abs(out);\n      } else if (inn) {\n        kind = 'income';\n        amount = Math.abs(inn);\n      } else if (amt) {\n        amount = Math.abs(amt);\n        if (/입금/.test(typeText)) kind = 'income';\n        else if (/출금|지급/.test(typeText)) kind = 'expense';\n        else if (amt < 0) kind = 'expense';\n        else kind = signed ? 'income' : 'expense';\n      } else {\n        skipped += 1;\n        continue;\n      }\n\n      const memoMain = cellText(get(row, 'memo'));\n      const note = cellText(get(row, 'note'));\n      const memo = memoMain || note || categoryText || '(내용 없음)';\n      const allText = `${typeText} ${categoryText} ${memo} ${note}`;\n\n      // 카드 결제 취소·환불로 들어온 돈은 지출을 줄이는 것으로 본다\n      if (kind === 'income' && /취소|환불/.test(allText)) {\n        kind = 'expense';\n        amount = -amount;\n      }\n      if (opts.myName && memo.includes(opts.myName) && !/카드|결제|승인/.test(allText)) kind = 'transfer';\n\n      const balance = parseAmountCell(get(row, 'balance'));\n      const item = {\n        date: when.date,\n        time: when.time,\n        amount,\n        memo,\n        kind,\n        accountId: opts.accountId || null,\n        balance: Number.isFinite(balance) ? balance : null,\n        raw: row.map(cellText).filter(Boolean).join(' | ').slice(0, 300),\n      };\n      items.push(item);\n      if (item.balance !== null) {\n        const key = `${item.date} ${item.time}`;\n        if (!latest || key >= `${latest.date} ${latest.time}`) latest = { date: item.date, time: item.time, balance: item.balance };\n      }\n    }\n    return { items, skipped, header, latest };\n  }\n\n  // CSV 글자 → 2차원 배열 (따옴표 안의 쉼표·줄바꿈 처리)\n  function parseCSV(text) {\n    const rows = [];\n    let row = [];\n    let cell = '';\n    let quoted = false;\n    const s = String(text || '').replace(/^﻿/, '');\n    for (let i = 0; i < s.length; i++) {\n      const ch = s[i];\n      if (quoted) {\n        if (ch === '\"' && s[i + 1] === '\"') {\n          cell += '\"';\n          i += 1;\n        } else if (ch === '\"') quoted = false;\n        else cell += ch;\n      } else if (ch === '\"') quoted = true;\n      else if (ch === ',' || ch === '\\t') {\n        row.push(cell);\n        cell = '';\n      } else if (ch === '\\n' || ch === '\\r') {\n        if (ch === '\\r' && s[i + 1] === '\\n') i += 1;\n        row.push(cell);\n        rows.push(row);\n        row = [];\n        cell = '';\n      } else cell += ch;\n    }\n    if (cell || row.length) {\n      row.push(cell);\n      rows.push(row);\n    }\n    return rows;\n  }\n\n  // 알림으로 이미 들어온 내역인지: 정확히 같거나, 같은 날·같은 금액·같은 종류이면서 사용처가 겹치거나 같은 계좌\n  function findDuplicate(item, transactions) {\n    const memo = normalizeMerchant(item.memo);\n    return transactions.find((t) => {\n      if (t.date !== item.date || Math.abs(t.amount) !== Math.abs(item.amount)) return false;\n      if (kindOf(t) !== kindOf(item)) return false;\n      const tm = normalizeMerchant(t.memo);\n      if (tm === memo || (tm && memo && (tm.includes(memo) || memo.includes(tm)))) return true;\n      return !!(item.accountId && t.accountId === item.accountId);\n    }) || null;\n  }\n\n  // ---------- 리포트 ----------\n\n  // 항목별 지출 (많이 쓴 순). 색은 계획 안의 순서(colorIndex)로 정해 순위가 바뀌어도 같은 항목은 같은 색.\n  function categoryBreakdown(summary) {\n    const rows = summary.rows.map((r, i) => ({ id: r.category.id, name: r.category.name, amount: r.spent, count: r.count, colorIndex: i }));\n    if (summary.unclassified) rows.push({ id: '__none', name: '미분류', amount: summary.unclassified, count: summary.unclassifiedCount, colorIndex: -1 });\n    const total = rows.reduce((s, r) => s + Math.max(0, r.amount), 0);\n    return rows\n      .filter((r) => r.amount > 0)\n      .map((r) => ({ ...r, share: total ? r.amount / total : 0 }))\n      .sort((a, b) => b.amount - a.amount);\n  }\n\n  // 이번 기간과 직전 기간의 항목별 비교 (이번 기간 계획의 항목 기준, 같은 id 끼리)\n  function compareWithPrevious(state, period) {\n    const cur = summarizePeriod(state, period);\n    const prevPeriod = shiftPeriod(period, -1, state.settings.startDay);\n    const prev = summarizePeriod(state, prevPeriod);\n    const prevSpent = {};\n    for (const r of prev.rows) prevSpent[r.category.id] = r.spent;\n    const rows = cur.rows.map((r) => ({\n      id: r.category.id,\n      name: r.category.name,\n      current: r.spent,\n      previous: prevSpent[r.category.id] || 0,\n      diff: r.spent - (prevSpent[r.category.id] || 0),\n    }));\n    return { current: cur, previous: prev, rows, totalDiff: cur.totalSpent - prev.totalSpent };\n  }\n\n  function topMerchants(txs, n = 5) {\n    const map = {};\n    for (const t of txs) {\n      if (kindOf(t) !== 'expense') continue;\n      const key = normalizeMerchant(t.memo);\n      const m = (map[key] = map[key] || { memo: t.memo, total: 0, count: 0 });\n      m.total += t.amount;\n      m.count += 1;\n    }\n    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, n);\n  }\n\n  // 최근 n 개 기간 (오래된 것부터): 예산으로 입력한 수입, 실제 입금, 지출\n  function trend(state, period, n = 6) {\n    const out = [];\n    for (let i = n - 1; i >= 0; i--) {\n      const p = shiftPeriod(period, -i, state.settings.startDay);\n      const s = summarizePeriod(state, p);\n      out.push({ period: p, budgetIncome: s.hasIncome ? s.income : null, incomeReceived: s.incomeReceived, spent: s.totalSpent });\n    }\n    return out;\n  }\n\n  // 날짜별 합계: { 'YYYY-MM-DD': { spent, income, count } }\n  function dailyTotals(txs) {\n    const out = {};\n    for (const t of txs) {\n      const d = (out[t.date] = out[t.date] || { spent: 0, income: 0, count: 0 });\n      const k = kindOf(t);\n      if (k === 'expense') d.spent += t.amount;\n      else if (k === 'income') d.income += t.amount;\n      d.count += 1;\n    }\n    return out;\n  }\n\n  // 자산: 계좌 잔액 합계, 카드별 이번 기간 사용액\n  function assetSummary(state, period) {\n    const txs = txsInPeriod(state, period);\n    const banks = state.accounts.filter((a) => a.type !== 'card');\n    const cards = state.accounts.filter((a) => a.type === 'card');\n    const total = banks.reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);\n    const savings = banks.filter((a) => a.isSavings).reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);\n    const spendBy = {};\n    for (const t of txs) if (kindOf(t) === 'expense' && t.accountId) spendBy[t.accountId] = (spendBy[t.accountId] || 0) + t.amount;\n    return {\n      total,\n      savings,\n      banks: banks.map((a) => ({ ...a, spent: spendBy[a.id] || 0 })),\n      cards: cards.map((a) => ({ ...a, spent: spendBy[a.id] || 0 })),\n      unlinkedSpent: txs.filter((t) => kindOf(t) === 'expense' && !t.accountId).reduce((s, t) => s + t.amount, 0),\n    };\n  }\n\n  // ---------- 기본 데이터 ----------\n\n  function defaultCategories() {\n    return [\n      { id: 'c-house', name: '주거/관리비', type: 'fixed', value: 500000, description: '월세, 관리비, 전기·가스·수도 요금', keywords: ['월세', '관리비', '전기요금', '도시가스', '수도요금'] },\n      { id: 'c-phone', name: '통신/구독', type: 'fixed', value: 80000, description: '휴대폰 요금, 인터넷, OTT·음악 등 정기 구독', keywords: ['SKT', 'KT', 'LG U+', '통신', '넷플릭스', '유튜브', '멜론', '쿠팡와우', '디즈니'] },\n      { id: 'c-food', name: '식비', type: 'ratio', value: 30, description: '식당, 배달, 장보기, 편의점 음식', keywords: ['식당', '배달의민족', '배민', '요기요', '쿠팡이츠', '이마트', '홈플러스', '롯데마트', '마트', '편의점', 'GS25', 'CU', '세븐일레븐', '김밥', '치킨'] },\n      { id: 'c-cafe', name: '카페/간식', type: 'ratio', value: 5, description: '커피, 음료, 빵, 디저트', keywords: ['스타벅스', '투썸', '이디야', '메가커피', '메가MGC', '컴포즈', '빽다방', '카페', '파리바게뜨', '뚜레쥬르', '베이커리'] },\n      { id: 'c-move', name: '교통', type: 'ratio', value: 7, description: '대중교통, 택시, 기차, 주유, 주차', keywords: ['택시', '카카오T', '버스', '지하철', '티머니', '코레일', 'SRT', '주유', '주차'] },\n      { id: 'c-shop', name: '쇼핑', type: 'ratio', value: 10, description: '온라인 쇼핑, 옷, 생활용품, 화장품', keywords: ['쿠팡', '11번가', 'G마켓', '무신사', '올리브영', '다이소', '네이버페이'] },\n      { id: 'c-fun', name: '문화/여가', type: 'ratio', value: 8, description: '영화, 공연, 책, 취미, 여행', keywords: ['CGV', '메가박스', '롯데시네마', '교보문고', 'YES24', '알라딘'] },\n      { id: 'c-save', name: '저축/투자', type: 'ratio', value: 40, description: '적금, 저축 이체, 증권 계좌 입금, 청약', keywords: ['적금', '저축', '증권', '청약'] },\n    ];\n  }\n\n  function defaultState() {\n    return {\n      version: 2,\n      settings: { startDay: 1, myName: '' },\n      plans: [{ from: BASE_PLAN_FROM, ratioBase: 'afterFixed', categories: defaultCategories(), updatedAt: '' }],\n      accounts: [],\n      incomes: {},\n      transactions: [],\n      merchantMap: {},\n    };\n  }\n\n  // 저장된 데이터를 현재 구조로 맞춘다. (v1: 계획이 하나뿐이던 구조 → v2: 기간별 계획)\n  function normalizeState(raw) {\n    const base = defaultState();\n    if (!raw || typeof raw !== 'object') return base;\n    const settings = raw.settings || {};\n    const startDay = Math.min(31, Math.max(1, Number(settings.startDay) || 1));\n\n    let plans;\n    if (Array.isArray(raw.plans) && raw.plans.length) {\n      plans = raw.plans;\n    } else if (Array.isArray(raw.categories)) {\n      plans = [{ from: BASE_PLAN_FROM, ratioBase: settings.ratioBase === 'income' ? 'income' : 'afterFixed', categories: raw.categories, updatedAt: '' }];\n    } else {\n      plans = base.plans;\n    }\n    plans = plans\n      .map((p) => ({\n        from: String(p.from || BASE_PLAN_FROM),\n        ratioBase: p.ratioBase === 'income' ? 'income' : 'afterFixed',\n        categories: Array.isArray(p.categories) ? p.categories : [],\n        updatedAt: String(p.updatedAt || ''),\n      }))\n      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));\n\n    const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({\n      id: String(a.id),\n      name: String(a.name || ''),\n      type: a.type === 'card' ? 'card' : 'bank',\n      last4: digitsOnly(a.last4).slice(-4),\n      isSavings: !!a.isSavings,\n      balance: typeof a.balance === 'number' ? a.balance : null,\n      balanceAt: String(a.balanceAt || ''),\n    }));\n\n    return {\n      version: 2,\n      settings: { startDay, myName: String(settings.myName || '') },\n      plans,\n      accounts,\n      incomes: raw.incomes && typeof raw.incomes === 'object' ? raw.incomes : {},\n      transactions: Array.isArray(raw.transactions) ? raw.transactions : [],\n      merchantMap: raw.merchantMap && typeof raw.merchantMap === 'object' ? raw.merchantMap : {},\n    };\n  }\n\n  return {\n    toISO,\n    parseISO,\n    addDays,\n    diffDays,\n    todayISO,\n    daysInMonth,\n    getPeriod,\n    shiftPeriod,\n    computeBudgets,\n    summarizePeriod,\n    statusOf,\n    normalizeMerchant,\n    classify,\n    classifyLocal,\n    parseExpenseText,\n    kindOf,\n    looksLikeTransaction,\n    matchAccount,\n    parseMessageFallback,\n    isDuplicate,\n    BASE_PLAN_FROM,\n    planFor,\n    ensurePlanFor,\n    nextPlanAfter,\n    remapPeriodKeys,\n    buildClassifyRequest,\n    readClassifyResponse,\n    buildMessageRequest,\n    readMessageResponse,\n    parseStatementRows,\n    parseCSV,\n    findDuplicate,\n    categoryBreakdown,\n    compareWithPrevious,\n    topMerchants,\n    trend,\n    dailyTotals,\n    assetSummary,\n    defaultState,\n    normalizeState,\n  };\n});\n</script>\n  <script>\n/* 차트 (SVG 문자열을 만든다). 색은 css 변수 --s1 ~ --s7 (항목 순서대로 고정), 그 밖은 회색. */\n(function (root) {\n  'use strict';\n\n  const SLOTS = 7;\n\n  function seriesColor(colorIndex) {\n    return colorIndex >= 0 && colorIndex < SLOTS ? `var(--s${colorIndex + 1})` : 'var(--gray-mark)';\n  }\n\n  // 12,340,000 → \"1,234만\", 1억 이상은 \"1.2억\"\n  function shortWon(n) {\n    const a = Math.abs(n);\n    const sign = n < 0 ? '-' : '';\n    if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\\.0$/, '')}억`;\n    if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ko-KR')}만`;\n    return `${sign}${Math.round(a).toLocaleString('ko-KR')}`;\n  }\n\n  // 달력처럼 좁은 칸용: 6,200 → \"6.2천\", 12,400 → \"1.2만\", 512,000 → \"51만\"\n  function tinyWon(n) {\n    const a = Math.abs(n);\n    const trim = (x) => x.toFixed(1).replace(/\\.0$/, '');\n    if (a >= 1e8) return `${trim(a / 1e8)}억`;\n    if (a >= 1e5) return `${Math.round(a / 1e4)}만`;\n    if (a >= 1e4) return `${trim(a / 1e4)}만`;\n    if (a >= 1e3) return `${trim(a / 1e3)}천`;\n    return String(Math.round(a));\n  }\n\n  function niceMax(v) {\n    if (v <= 0) return 10000;\n    const p = Math.pow(10, Math.floor(Math.log10(v)));\n    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;\n    return 10 * p;\n  }\n\n  // 구성 막대: rows = [{name, amount, colorIndex}] (많이 쓴 순). 8번째 색부터는 \"기타\"로 합친다.\n  function shareSegments(rows) {\n    const main = rows.filter((r) => r.colorIndex >= 0 && r.colorIndex < SLOTS);\n    const rest = rows.filter((r) => !(r.colorIndex >= 0 && r.colorIndex < SLOTS));\n    const segs = main.map((r) => ({ name: r.name, amount: r.amount, color: seriesColor(r.colorIndex) }));\n    const restSum = rest.reduce((s, r) => s + r.amount, 0);\n    if (restSum > 0) segs.push({ name: rest.length === 1 ? rest[0].name : '기타', amount: restSum, color: seriesColor(-1) });\n    return segs;\n  }\n\n  function shareBar(rows) {\n    const segs = shareSegments(rows);\n    const total = segs.reduce((s, r) => s + r.amount, 0) || 1;\n    return `<div class=\"share-bar\" role=\"img\" aria-label=\"항목별 지출 구성\">${segs\n      .map((s, i) => `<span data-seg=\"${i}\" style=\"flex:${s.amount / total};background:${s.color}\"></span>`)\n      .join('')}</div>`;\n  }\n\n  /*\n   * 기간별 추이: 기간마다 [수입, 지출] 두 막대. data = [{label, income, spent}]\n   * 막대 사이 2px 간격, 윗부분 4px 둥글게, 바닥은 기준선에 붙임.\n   */\n  function trendChart(data, { width = 640, height = 220 } = {}) {\n    const pad = { top: 12, right: 8, bottom: 26, left: 44 };\n    const w = width - pad.left - pad.right;\n    const h = height - pad.top - pad.bottom;\n    const max = niceMax(Math.max(1, ...data.map((d) => Math.max(d.income || 0, d.spent || 0))));\n    const y = (v) => pad.top + h - (Math.max(0, v) / max) * h;\n    const band = w / data.length;\n    const barW = Math.min(26, (band - 18) / 2);\n    const gap = 2;\n    const parts = [];\n\n    for (let i = 0; i <= 4; i++) {\n      const v = (max / 4) * i;\n      const yy = y(v);\n      parts.push(`<line class=\"grid-line\" x1=\"${pad.left}\" x2=\"${width - pad.right}\" y1=\"${yy}\" y2=\"${yy}\"/>`);\n      parts.push(`<text class=\"axis-label\" x=\"${pad.left - 6}\" y=\"${yy + 4}\" text-anchor=\"end\">${shortWon(v)}</text>`);\n    }\n\n    const bar = (x, v, color) => {\n      if (!v || v <= 0) return '';\n      const top = y(v);\n      const bh = pad.top + h - top;\n      const r = Math.min(4, bh);\n      // 위쪽 모서리만 둥근 막대\n      return `<path fill=\"${color}\" d=\"M${x},${pad.top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.top + h} Z\"/>`;\n    };\n\n    data.forEach((d, i) => {\n      const cx = pad.left + band * i + band / 2;\n      parts.push(bar(cx - barW - gap / 2, d.income, 'var(--s1)'));\n      parts.push(bar(cx + gap / 2, d.spent, 'var(--s2)'));\n      parts.push(`<text class=\"axis-label\" x=\"${cx}\" y=\"${height - 8}\" text-anchor=\"middle\">${d.label}</text>`);\n      parts.push(`<rect class=\"hit\" data-i=\"${i}\" x=\"${pad.left + band * i}\" y=\"${pad.top}\" width=\"${band}\" height=\"${h}\"/>`);\n    });\n\n    return `<svg viewBox=\"0 0 ${width} ${height}\" role=\"img\" aria-label=\"기간별 수입과 지출\">${parts.join('')}</svg>`;\n  }\n\n  root.BudgetCharts = { seriesColor, shortWon, tinyWon, shareSegments, shareBar, trendChart };\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n</script>\n  <script>\n/* 엑셀(.xlsx) 첫 번째 시트를 2차원 배열로 읽는다. 외부 라이브러리 없이 브라우저 기능만 쓴다.\n * .xlsx 는 zip 안에 XML 이 든 파일이라, zip 을 풀고(DecompressionStream) XML 을 읽는다(DOMParser).\n */\n(function (root) {\n  'use strict';\n\n  function fail(code, message) {\n    const e = new Error(message);\n    e.code = code;\n    return e;\n  }\n\n  async function inflateRaw(bytes) {\n    if (typeof DecompressionStream === 'undefined') {\n      throw fail('unsupported', '이 브라우저는 엑셀 파일을 풀 수 없어요. 최신 크롬·사파리를 쓰거나, 엑셀에서 CSV 로 저장해 올려 주세요.');\n    }\n    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));\n    return new Uint8Array(await new Response(stream).arrayBuffer());\n  }\n\n  // zip 안의 파일 목록 → { 이름: async () => 내용(Uint8Array) }\n  function readZipDirectory(buf) {\n    const view = new DataView(buf);\n    const bytes = new Uint8Array(buf);\n    let eocd = -1;\n    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {\n      if (view.getUint32(i, true) === 0x06054b50) {\n        eocd = i;\n        break;\n      }\n    }\n    if (eocd < 0) throw fail('format', '엑셀 파일 구조를 읽지 못했어요.');\n    const count = view.getUint16(eocd + 10, true);\n    let p = view.getUint32(eocd + 16, true);\n    const files = {};\n    const decoder = new TextDecoder();\n    for (let n = 0; n < count; n++) {\n      if (view.getUint32(p, true) !== 0x02014b50) break;\n      const method = view.getUint16(p + 10, true);\n      const compSize = view.getUint32(p + 20, true);\n      const nameLen = view.getUint16(p + 28, true);\n      const extraLen = view.getUint16(p + 30, true);\n      const commentLen = view.getUint16(p + 32, true);\n      const local = view.getUint32(p + 42, true);\n      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));\n      files[name] = async () => {\n        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);\n        const data = bytes.subarray(start, start + compSize);\n        if (method === 0) return data;\n        if (method === 8) return inflateRaw(data);\n        throw fail('format', '지원하지 않는 압축 방식이에요.');\n      };\n      p += 46 + nameLen + extraLen + commentLen;\n    }\n    return files;\n  }\n\n  async function readXml(files, name) {\n    if (!files[name]) return null;\n    const text = new TextDecoder().decode(await files[name]());\n    return new DOMParser().parseFromString(text, 'application/xml');\n  }\n\n  const tags = (node, name) => Array.from(node.getElementsByTagName(name));\n\n  function columnIndex(ref) {\n    const letters = String(ref || '').match(/^[A-Z]+/);\n    if (!letters) return -1;\n    let n = 0;\n    for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);\n    return n - 1;\n  }\n\n  // 첫 번째 시트의 경로 (workbook.xml 의 첫 sheet → 관계 파일에서 실제 경로)\n  async function firstSheetPath(files) {\n    const wb = await readXml(files, 'xl/workbook.xml');\n    const rels = await readXml(files, 'xl/_rels/workbook.xml.rels');\n    if (wb && rels) {\n      const sheet = tags(wb, 'sheet')[0];\n      const rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));\n      const rel = tags(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);\n      if (rel) {\n        const target = rel.getAttribute('Target').replace(/^\\//, '');\n        return target.startsWith('xl/') ? target : `xl/${target}`;\n      }\n    }\n    return Object.keys(files).filter((n) => /^xl\\/worksheets\\/sheet\\d+\\.xml$/.test(n)).sort()[0];\n  }\n\n  async function readXlsx(arrayBuffer) {\n    const head = new Uint8Array(arrayBuffer.slice(0, 4));\n    // D0 CF 11 E0: 비밀번호가 걸린 엑셀이거나 옛날 .xls 형식\n    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {\n      throw fail('encrypted', '비밀번호가 걸린 엑셀(또는 옛날 .xls) 파일이에요. 엑셀이나 구글 시트에서 열어 비밀번호 없이 .xlsx 또는 CSV 로 다시 저장한 뒤 올려 주세요.');\n    }\n    if (!(head[0] === 0x50 && head[1] === 0x4b)) throw fail('format', '엑셀(.xlsx) 파일이 아니에요.');\n\n    const files = readZipDirectory(arrayBuffer);\n    const shared = [];\n    const sst = await readXml(files, 'xl/sharedStrings.xml');\n    if (sst) {\n      for (const si of tags(sst, 'si')) {\n        // 읽는 법 표시(rPh) 안의 글자는 빼고 합친다\n        shared.push(tags(si, 't').filter((t) => !(t.parentNode && t.parentNode.nodeName === 'rPh')).map((t) => t.textContent).join(''));\n      }\n    }\n    const path = await firstSheetPath(files);\n    const sheet = path && (await readXml(files, path));\n    if (!sheet) throw fail('format', '시트를 찾지 못했어요.');\n\n    const rows = [];\n    for (const row of tags(sheet, 'row')) {\n      const r = Number(row.getAttribute('r')) - 1;\n      const out = [];\n      tags(row, 'c').forEach((c, i) => {\n        const col = c.getAttribute('r') ? columnIndex(c.getAttribute('r')) : i;\n        const type = c.getAttribute('t');\n        const v = tags(c, 'v')[0];\n        let value = '';\n        if (type === 's') value = shared[Number(v && v.textContent)] || '';\n        else if (type === 'inlineStr') value = tags(c, 't').map((t) => t.textContent).join('');\n        else if (type === 'str' || type === 'b' || type === 'e') value = v ? v.textContent : '';\n        else if (v) value = Number(v.textContent);\n        out[col] = value;\n      });\n      rows[r >= 0 ? r : rows.length] = out;\n    }\n    return Array.from(rows, (r) => Array.from(r || [], (c) => (c === undefined ? '' : c)));\n  }\n\n  // 파일 하나를 읽어 2차원 배열로. CSV 는 글자 그대로(한글 엑셀 CSV 는 EUC-KR 인 경우가 많아 같이 시도)\n  async function readTableFile(file) {\n    const buf = await file.arrayBuffer();\n    const head = new Uint8Array(buf.slice(0, 4));\n    const isZipOrOle = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);\n    if (isZipOrOle || /\\.xlsx?$/i.test(file.name)) return readXlsx(buf);\n    let text = new TextDecoder('utf-8').decode(buf);\n    if (text.includes('�')) {\n      try {\n        text = new TextDecoder('euc-kr').decode(buf);\n      } catch (e) {\n        /* utf-8 그대로 */\n      }\n    }\n    return root.BudgetLogic.parseCSV(text);\n  }\n\n  root.BudgetXlsx = { readXlsx, readTableFile };\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n</script>\n  <script>\n/* 저장소. 두 가지 방식을 같은 함수로 다룬다.\n *  - local : 이 브라우저(localStorage)에만 저장, 키워드로 분류\n *  - remote: 구글 Apps Script 서버(구글 시트)에 저장, Claude AI 로 분류, 알림 자동 입력\n *            Apps Script 가 화면을 직접 제공하면 자동으로 remote, 아니면 설정에서 서버 주소를 연결\n */\n(function (root) {\n  'use strict';\n\n  const L = root.BudgetLogic;\n  const STORAGE_KEY = 'budget-app-v1';\n  const SERVER_KEY = 'budget-app-server';\n  const MIGRATE_KEY = 'budget-app-migrate';\n\n  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);\n  const nowISO = () => new Date().toISOString();\n\n  const KEY_STORE = 'budget-app-key';\n\n  function readServerConfig() {\n    // 구글 Apps Script 가 화면을 직접 줄 때: 키는 주소(?key=) 또는 이 기기에 기억한 값\n    if (root.__BUDGET_SERVER__) {\n      let key = root.__BUDGET_SERVER__.key || '';\n      try {\n        if (key) localStorage.setItem(KEY_STORE, key);\n        else key = localStorage.getItem(KEY_STORE) || '';\n      } catch (e) {\n        /* 기억 못 하면 매번 입력 */\n      }\n      return { ...root.__BUDGET_SERVER__, key, embedded: true };\n    }\n    try {\n      const raw = localStorage.getItem(SERVER_KEY);\n      const c = raw ? JSON.parse(raw) : null;\n      return c && c.url && c.key ? c : null;\n    } catch (e) {\n      return null;\n    }\n  }\n\n  const server = readServerConfig();\n\n  const store = {\n    mode: server ? 'remote' : 'local',\n    server,\n    aiEnabled: false,\n    aiModel: '',\n    aiModels: [],\n    aiError: '',\n    serviceUrl: server ? server.url : '',\n    state: L.defaultState(),\n    onError: () => {},\n  };\n\n  let metaTimer = null;\n\n  function callApi(action, payload, target = server) {\n    const req = { key: target.key, action, payload: payload || {} };\n    const unwrap = (r) => {\n      if (!r || !r.ok) throw new Error((r && r.error) || '서버 응답 오류');\n      return r;\n    };\n    if (target === server && root.google && root.google.script && root.google.script.run) {\n      return new Promise((resolve, reject) => {\n        root.google.script.run\n          .withSuccessHandler((r) => {\n            try {\n              resolve(unwrap(r));\n            } catch (e) {\n              reject(e);\n            }\n          })\n          .withFailureHandler(reject)\n          .api(req);\n      });\n    }\n    // text/plain 으로 보내면 CORS 사전 요청 없이 Apps Script 로 보낼 수 있다\n    return fetch(target.url, { method: 'POST', body: JSON.stringify(req) })\n      .then((r) => r.json())\n      .then(unwrap);\n  }\n\n  function metaOf(s) {\n    const { transactions, ...meta } = s;\n    return meta;\n  }\n\n  function planForDate(date) {\n    return L.planFor(store.state, L.getPeriod(date, store.state.settings.startDay).key);\n  }\n\n  function saveLocal() {\n    try {\n      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.state));\n    } catch (e) {\n      store.onError(new Error('저장하지 못했습니다. 브라우저 저장공간 설정을 확인하세요.'));\n    }\n  }\n\n  function readLocalState() {\n    try {\n      const raw = localStorage.getItem(STORAGE_KEY);\n      return raw ? L.normalizeState(JSON.parse(raw)) : null;\n    } catch (e) {\n      return null;\n    }\n  }\n\n  function applyStatus(r) {\n    store.aiEnabled = !!r.ai;\n    store.aiModel = r.model || '';\n    store.aiModels = r.models || [];\n    store.aiError = r.lastError || '';\n    if (r.url) store.serviceUrl = r.url;\n  }\n\n  function isExpense(it) {\n    return !it.kind || it.kind === 'expense';\n  }\n\n  Object.assign(store, {\n    planForDate,\n    readLocalState,\n\n    async init() {\n      if (store.mode === 'local') {\n        store.state = readLocalState() || L.defaultState();\n        return;\n      }\n      const r = await callApi('load');\n      store.state = L.normalizeState(r.state);\n      applyStatus(r);\n    },\n\n    // 처음 접속할 때 입력한 키가 맞는지 확인하고 기억한다\n    async useKey(key) {\n      const prev = server.key;\n      server.key = key;\n      try {\n        applyStatus(await callApi('ping'));\n        try {\n          localStorage.setItem(KEY_STORE, key);\n        } catch (e) {\n          /* 무시 */\n        }\n      } catch (e) {\n        server.key = prev;\n        throw e;\n      }\n    },\n\n    forgetKey() {\n      try {\n        localStorage.removeItem(KEY_STORE);\n      } catch (e) {\n        /* 무시 */\n      }\n    },\n\n    async setApiKey(apiKey) {\n      applyStatus(await callApi('setApiKey', { apiKey }));\n    },\n\n    async setModel(model) {\n      applyStatus(await callApi('setModel', { model }));\n    },\n\n    // 계획·수입·계좌·학습 정보 저장. 서버에는 입력이 멈춘 뒤 한 번에 보낸다.\n    saveMeta() {\n      if (store.mode === 'local') return saveLocal();\n      clearTimeout(metaTimer);\n      metaTimer = setTimeout(() => store.flushMeta(), 700);\n    },\n\n    hasPendingMeta() {\n      return !!metaTimer;\n    },\n\n    async flushMeta() {\n      if (store.mode === 'local' || !metaTimer) return;\n      clearTimeout(metaTimer);\n      metaTimer = null;\n      try {\n        await callApi('saveMeta', { meta: metaOf(store.state) });\n      } catch (e) {\n        store.onError(new Error(`설정 저장 실패: ${e.message}`));\n      }\n    },\n\n    // items: [{date, amount, memo}] → [{categoryId, method}]\n    async classify(items) {\n      if (store.mode === 'local') {\n        return items.map((it) => L.classifyLocal(it.memo, planForDate(it.date).categories, store.state.merchantMap));\n      }\n      await store.flushMeta();\n      return (await callApi('classify', { items })).results;\n    },\n\n    // items: [{date, amount, memo, kind, accountId, categoryId ('__auto' 이면 자동 분류), method, source, raw}]\n    async addTransactions(items) {\n      if (store.mode === 'local') {\n        const auto = items.filter((it) => isExpense(it) && it.categoryId === '__auto');\n        const res = await store.classify(auto);\n        auto.forEach((it, i) => Object.assign(it, res[i]));\n        const now = nowISO();\n        const added = items.map((it) => {\n          const expense = isExpense(it);\n          const categoryId = expense && it.categoryId && it.categoryId !== '__auto' ? it.categoryId : null;\n          return {\n            id: uid(),\n            date: it.date,\n            amount: it.amount,\n            memo: it.memo,\n            categoryId,\n            method: categoryId ? it.method || 'manual' : null,\n            source: it.source || 'app',\n            raw: it.raw || '',\n            createdAt: now,\n            classifiedAt: now,\n            kind: expense ? 'expense' : it.kind,\n            accountId: it.accountId || null,\n          };\n        });\n        store.state.transactions.push(...added);\n        saveLocal();\n        return added;\n      }\n      await store.flushMeta();\n      const r = await callApi('addTransactions', { items });\n      store.state.transactions.push(...r.added);\n      return r.added;\n    },\n\n    async updateTransaction(id, patch) {\n      const t = store.state.transactions.find((x) => x.id === id);\n      if (store.mode === 'local') {\n        Object.assign(t, patch, { classifiedAt: nowISO() });\n        saveLocal();\n        return t;\n      }\n      await store.flushMeta();\n      const r = await callApi('updateTransaction', { id, patch });\n      Object.assign(t, r.tx);\n      return t;\n    },\n\n    async deleteTransaction(id) {\n      if (store.mode === 'remote') await callApi('deleteTransaction', { id });\n      store.state.transactions = store.state.transactions.filter((x) => x.id !== id);\n      if (store.mode === 'local') saveLocal();\n    },\n\n    // 기간 안의 지출을 그 기간 계획에 맞춰 다시 분류. 반환: 다시 분류한 지출 수\n    async reclassify(period, onlyUnclassified) {\n      if (store.mode === 'remote') {\n        await store.flushMeta();\n        const r = await callApi('reclassify', { start: period.start, end: period.end, onlyUnclassified });\n        for (const u of r.updated) Object.assign(store.state.transactions.find((t) => t.id === u.id) || {}, u);\n        return r.updated.length;\n      }\n      const plan = planForDate(period.start);\n      const known = new Set(plan.categories.map((c) => c.id));\n      const targets = store.state.transactions.filter((t) => {\n        if (t.date < period.start || t.date > period.end || L.kindOf(t) !== 'expense') return false;\n        const exists = known.has(t.categoryId);\n        return onlyUnclassified ? !exists : !(t.method === 'manual' && exists);\n      });\n      const res = await store.classify(targets);\n      const now = nowISO();\n      targets.forEach((t, i) => Object.assign(t, res[i], { classifiedAt: now }));\n      saveLocal();\n      return targets.length;\n    },\n\n    async refresh() {\n      if (store.mode === 'remote') await store.init();\n    },\n\n    // 서버 연결 확인 (연결 전이라 주소와 키를 직접 받는다)\n    ping(url, key) {\n      return callApi('ping', {}, { url, key });\n    },\n\n    connect(url, key, migrate) {\n      localStorage.setItem(SERVER_KEY, JSON.stringify({ url, key }));\n      if (migrate) localStorage.setItem(MIGRATE_KEY, '1');\n    },\n\n    disconnect() {\n      try {\n        localStorage.removeItem(SERVER_KEY);\n      } catch (e) {\n        /* 무시 */\n      }\n    },\n\n    // 서버에 연결한 직후 한 번: 이 기기에 있던 데이터를 옮길지\n    takeMigration() {\n      try {\n        if (store.mode !== 'remote' || localStorage.getItem(MIGRATE_KEY) !== '1') return null;\n        localStorage.removeItem(MIGRATE_KEY);\n        return readLocalState();\n      } catch (e) {\n        return null;\n      }\n    },\n\n    // 백업(또는 이 기기 데이터) 불러오기\n    async importState(imported) {\n      if (store.mode === 'local') {\n        store.state = imported;\n        saveLocal();\n        return;\n      }\n      const txs = imported.transactions;\n      store.state = { ...imported, transactions: store.state.transactions };\n      await callApi('saveMeta', { meta: metaOf(store.state) });\n      const fresh = txs.filter((t) => !L.isDuplicate(t, store.state.transactions));\n      for (let i = 0; i < fresh.length; i += 200) {\n        await store.addTransactions(\n          fresh.slice(i, i + 200).map((t) => ({\n            date: t.date,\n            amount: t.amount,\n            memo: t.memo,\n            kind: L.kindOf(t),\n            accountId: t.accountId || null,\n            categoryId: t.categoryId || null,\n            method: t.method || (t.categoryId ? 'manual' : null),\n            source: t.source || 'import',\n            raw: t.raw || '',\n          }))\n        );\n      }\n    },\n\n    reset() {\n      store.state = L.defaultState();\n      saveLocal();\n    },\n  });\n\n  root.BudgetStore = store;\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n</script>\n  <script>\n/* 지출 관리 앱 화면. 계산은 js/logic.js, 저장은 js/store.js, 차트는 js/charts.js */\n(function () {\n  'use strict';\n\n  const L = window.BudgetLogic;\n  const C = window.BudgetCharts;\n  const store = window.BudgetStore;\n  const S = () => store.state;\n\n  // ---------- 유틸 ----------\n\n  const $ = (sel) => document.querySelector(sel);\n  const $$ = (sel) => [...document.querySelectorAll(sel)];\n  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;\n  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);\n  const nowISO = () => new Date().toISOString();\n\n  function esc(s) {\n    return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  }\n\n  function parseAmountInput(s) {\n    const cleaned = String(s || '').replace(/[^\\d-]/g, '');\n    if (!cleaned || cleaned === '-') return null;\n    const n = Number(cleaned);\n    return Number.isFinite(n) ? n : null;\n  }\n\n  function fmtDate(iso) {\n    const { y, m, d } = L.parseISO(iso);\n    return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;\n  }\n\n  const DOW = ['일', '월', '화', '수', '목', '금', '토'];\n  function dowOf(iso) {\n    const { y, m, d } = L.parseISO(iso);\n    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();\n  }\n\n  function fmtDay(iso) {\n    const { m, d } = L.parseISO(iso);\n    return `${m}월 ${d}일 ${DOW[dowOf(iso)]}요일`;\n  }\n\n  function fmtDateTime(isoTime) {\n    if (!isoTime) return '';\n    const d = new Date(isoTime);\n    if (isNaN(d)) return '';\n    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;\n  }\n\n  let toastTimer;\n  function toast(msg, ms = 2600) {\n    const el = $('#toast');\n    el.textContent = msg;\n    el.hidden = false;\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => (el.hidden = true), ms);\n  }\n  store.onError = (e) => toast(e.message, 5000);\n\n  let busyCount = 0;\n  async function busy(label, fn) {\n    busyCount += 1;\n    $('#busy').hidden = false;\n    if (label) toast(label, 60000);\n    try {\n      return await fn();\n    } catch (e) {\n      toast(`오류: ${e.message || e}`, 5000);\n      throw e;\n    } finally {\n      busyCount -= 1;\n      if (!busyCount) $('#busy').hidden = true;\n      if (label && $('#toast').textContent === label) $('#toast').hidden = true;\n    }\n  }\n\n  // busy 가 이미 오류를 알렸으므로 이벤트 핸들러에서는 삼킨다\n  const quiet = (fn) => (...args) => Promise.resolve(fn(...args)).catch(() => {});\n\n  function formatOnBlur(input) {\n    input.addEventListener('blur', () => {\n      const n = parseAmountInput(input.value);\n      if (n !== null) input.value = n.toLocaleString('ko-KR');\n    });\n  }\n\n  function copyText(text, input) {\n    const done = () => toast('복사했습니다.');\n    const fallback = () => {\n      input.select();\n      try {\n        document.execCommand('copy');\n        done();\n      } catch (e) {\n        toast('길게 눌러 직접 복사해 주세요.');\n      }\n    };\n    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);\n    else fallback();\n  }\n\n  // ---------- 상태 ----------\n\n  let currentPeriod = L.getPeriod(L.todayISO(), 1);\n  let currentPage = 'home';\n  let selectedDate = null;\n  const listState = { search: '', kind: 'all', category: 'all', account: 'all' };\n  let manualKind = 'expense';\n\n  const planForDate = (date) => store.planForDate(date);\n  const currentPlan = () => L.planFor(S(), currentPeriod.key);\n\n  function categoryInfo(id, categories = currentPlan().categories) {\n    const i = categories.findIndex((c) => c.id === id);\n    return i >= 0 ? { name: categories[i].name, colorIndex: i } : { name: '미분류', colorIndex: -1 };\n  }\n\n  function accountName(id) {\n    const a = S().accounts.find((x) => x.id === id);\n    return a ? a.name || `${a.type === 'card' ? '카드' : '계좌'} ${a.last4}` : '';\n  }\n\n  function categoryOptions(categories, selected, { includeAuto = false } = {}) {\n    const opts = [];\n    if (includeAuto) opts.push(`<option value=\"__auto\">자동 분류${store.aiEnabled ? ' (AI)' : ''}</option>`);\n    opts.push(`<option value=\"\" ${!selected ? 'selected' : ''}>미분류</option>`);\n    for (const c of categories) opts.push(`<option value=\"${esc(c.id)}\" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`);\n    return opts.join('');\n  }\n\n  function accountOptions(selected, emptyLabel = '선택 안 함') {\n    return [`<option value=\"\">${emptyLabel}</option>`]\n      .concat(S().accounts.map((a) => `<option value=\"${esc(a.id)}\" ${a.id === selected ? 'selected' : ''}>${esc(accountName(a.id))}</option>`))\n      .join('');\n  }\n\n  const METHOD_LABEL = { ai: 'AI', learned: '기억', keyword: '키워드', manual: '직접' };\n  const methodTag = (m) => (m && METHOD_LABEL[m] ? `<span class=\"tag\">${METHOD_LABEL[m]}</span>` : '');\n\n  // ---------- 페이지 이동 ----------\n\n  const PAGES = {\n    home: { title: '홈', period: true },\n    calendar: { title: '달력', period: true },\n    list: { title: '내역', period: true },\n    report: { title: '리포트', period: true },\n    assets: { title: '자산', period: true },\n    plan: { title: '예산 계획', period: true },\n    add: { title: '지출·수입 입력', period: false },\n    settings: { title: '설정', period: false },\n  };\n\n  function showPage(name, { push = true } = {}) {\n    if (!PAGES[name]) name = 'home';\n    currentPage = name;\n    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));\n    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));\n    $$('.bottom-nav [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));\n    $('#page-title').textContent = PAGES[name].title;\n    $('#period-nav').hidden = !PAGES[name].period;\n    closeMenu();\n    // 구글 Apps Script 화면(iframe)처럼 주소를 못 바꾸는 곳에서도 이동은 되게\n    try {\n      if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);\n    } catch (e) {\n      /* 무시 */\n    }\n    window.scrollTo(0, 0);\n    render();\n  }\n\n  function openMenu() {\n    $('#sidebar').classList.add('open');\n    $('#scrim').hidden = false;\n  }\n\n  function closeMenu() {\n    $('#sidebar').classList.remove('open');\n    $('#scrim').hidden = true;\n  }\n\n  // ---------- 공통 머리 ----------\n\n  function renderChrome() {\n    const chip = $('#conn-status');\n    if (store.mode === 'local') {\n      chip.textContent = '이 기기에만 저장';\n      chip.className = 'chip';\n    } else {\n      chip.textContent = store.aiEnabled ? '구글 시트 · AI 분류' : '구글 시트 · AI 꺼짐';\n      chip.className = `chip ${store.aiEnabled ? 'on' : ''}`;\n    }\n    $('#refresh-btn').hidden = store.mode !== 'remote';\n\n    const p = currentPeriod;\n    $('#period-text').textContent = `${fmtDate(p.start)} ~ ${fmtDate(p.end).slice(5)}`;\n    const today = L.todayISO();\n    let sub;\n    if (today >= p.start && today <= p.end) sub = `이번 기간 · ${L.diffDays(today, p.end) + 1}일 남음`;\n    else if (today > p.end) sub = '지난 기간';\n    else sub = '다가오는 기간';\n    $('#period-sub').textContent = sub;\n  }\n\n  // ---------- 툴팁 ----------\n\n  function attachTooltip(el, html) {\n    const tip = $('#tooltip');\n    el.addEventListener('mouseenter', () => {\n      tip.innerHTML = html();\n      tip.hidden = false;\n    });\n    el.addEventListener('mousemove', (e) => {\n      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);\n      tip.style.left = `${x}px`;\n      tip.style.top = `${e.clientY + 14}px`;\n    });\n    el.addEventListener('mouseleave', () => (tip.hidden = true));\n  }\n\n  // ---------- 거래 한 줄 ----------\n\n  function txRow(t, { editable = true } = {}) {\n    const kind = L.kindOf(t);\n    const cats = planForDate(t.date).categories;\n    const info = categoryInfo(t.categoryId, cats);\n    let icon;\n    let amount;\n    if (kind === 'income') {\n      icon = '<div class=\"tx-icon\" style=\"background:var(--accent)\">+</div>';\n      amount = `<span class=\"tx-amount plus\">+${won(t.amount)}</span>`;\n    } else if (kind === 'transfer') {\n      icon = '<div class=\"tx-icon gray\">↔</div>';\n      amount = `<span class=\"tx-amount neutral\">${won(t.amount)}</span>`;\n    } else {\n      icon = `<div class=\"tx-icon ${info.colorIndex < 0 ? 'gray' : ''}\" style=\"${info.colorIndex >= 0 ? `background:${C.seriesColor(info.colorIndex)}` : ''}\">${esc(info.name.slice(0, 1))}</div>`;\n      amount = `<span class=\"tx-amount ${t.amount < 0 ? 'plus' : ''}\">${t.amount < 0 ? '+' : ''}${won(Math.abs(t.amount))}</span>`;\n    }\n    const meta = [];\n    if (editable) {\n      // 항목과 종류(입금·이체)를 한 칸에서 고른다\n      const current = kind !== 'expense' ? `kind:${kind}` : info.colorIndex >= 0 ? t.categoryId : '';\n      meta.push(`<select class=\"tx-cat\" data-id=\"${esc(t.id)}\" aria-label=\"항목\">\n        ${categoryOptions(cats, current)}\n        <optgroup label=\"지출이 아님\">\n          <option value=\"kind:income\" ${current === 'kind:income' ? 'selected' : ''}>입금</option>\n          <option value=\"kind:transfer\" ${current === 'kind:transfer' ? 'selected' : ''}>내 계좌 이체</option>\n        </optgroup>\n      </select>`);\n    } else {\n      meta.push(esc(kind === 'income' ? '입금' : kind === 'transfer' ? '내 계좌 이체' : info.name));\n    }\n    if (kind === 'expense' && info.colorIndex >= 0) meta.push(methodTag(t.method));\n    if (t.accountId && accountName(t.accountId)) meta.push(`<span>${esc(accountName(t.accountId))}</span>`);\n    if (t.source === 'sms' || t.source === 'bank') meta.push(`<span class=\"tag\">${t.source === 'bank' ? '은행 알림' : '문자'}</span>`);\n    return `\n      <div class=\"tx\">\n        ${icon}\n        <div class=\"tx-main\">\n          <div class=\"tx-memo\">${esc(t.memo)}</div>\n          <div class=\"tx-meta\">${meta.join('')}</div>\n        </div>\n        <div class=\"tx-right\">\n          ${amount}\n          ${editable ? `<button class=\"link-btn tx-del\" data-id=\"${esc(t.id)}\" aria-label=\"삭제\">삭제</button>` : ''}\n        </div>\n      </div>`;\n  }\n\n  // 날짜별로 묶은 목록\n  function txGroups(txs, opts) {\n    const sorted = [...txs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));\n    const groups = [];\n    for (const t of sorted) {\n      let g = groups[groups.length - 1];\n      if (!g || g.date !== t.date) groups.push((g = { date: t.date, items: [] }));\n      g.items.push(t);\n    }\n    return groups\n      .map((g) => {\n        const spent = g.items.filter((t) => L.kindOf(t) === 'expense').reduce((s, t) => s + t.amount, 0);\n        return `<div class=\"tx-date\"><span>${fmtDay(g.date)}</span><span>${spent ? `지출 ${won(spent)}` : ''}</span></div>${g.items.map((t) => txRow(t, opts)).join('')}`;\n      })\n      .join('');\n  }\n\n  function bindTxEvents(container) {\n    container.querySelectorAll('.tx-cat').forEach((s) => s.addEventListener('change', quiet(async () => {\n      const t = S().transactions.find((x) => x.id === s.dataset.id);\n      if (s.value.startsWith('kind:')) {\n        await busy(null, () => store.updateTransaction(t.id, { kind: s.value.slice(5), categoryId: null, method: null }));\n        render();\n        return;\n      }\n      const key = L.normalizeMerchant(t.memo);\n      if (s.value) S().merchantMap[key] = s.value;\n      else delete S().merchantMap[key];\n      store.saveMeta();\n      await busy(null, () => store.updateTransaction(t.id, { kind: 'expense', categoryId: s.value || null, method: s.value ? 'manual' : null }));\n      toast(`'${t.memo}' 은(는) 앞으로 ${categoryInfo(t.categoryId, planForDate(t.date).categories).name}(으)로 분류합니다.`);\n      render();\n    })));\n    container.querySelectorAll('.tx-del').forEach((b) => b.addEventListener('click', quiet(async () => {\n      const t = S().transactions.find((x) => x.id === b.dataset.id);\n      if (!confirm(`'${t.memo}' ${won(t.amount)} 내역을 삭제할까요?`)) return;\n      await busy(null, () => store.deleteTransaction(t.id));\n      render();\n    })));\n  }\n\n  // ---------- 홈 ----------\n\n  function renderIncomeBox(sum) {\n    const box = $('#income-box');\n    const prev = L.shiftPeriod(currentPeriod, -1, S().settings.startDay);\n    const prevIncome = S().incomes[prev.key];\n\n    if (!sum.hasIncome || box.dataset.editing === '1') {\n      box.classList.add('income-prompt');\n      const received = sum.incomeReceived > 0 ? `<button type=\"button\" class=\"ghost-btn\" id=\"income-received\">받은 입금 합계로 (${won(sum.incomeReceived)})</button>` : '';\n      box.innerHTML = `\n        <h2>${sum.hasIncome ? '당기 수입(예산) 수정' : '이번 기간에 들어온 돈(예산)을 입력하세요'}</h2>\n        <p class=\"muted small\">${fmtDate(currentPeriod.start)} 에 시작하는 기간의 수입입니다. 비율 항목의 한도가 이 금액에 맞춰 계산됩니다.</p>\n        <form class=\"income-form\" id=\"income-form\">\n          <input type=\"text\" inputmode=\"numeric\" id=\"income-input\" placeholder=\"예: 3,000,000\" value=\"${sum.hasIncome ? sum.income.toLocaleString('ko-KR') : ''}\">\n          <button type=\"submit\" class=\"primary-btn\">저장</button>\n          ${typeof prevIncome === 'number' ? `<button type=\"button\" class=\"ghost-btn\" id=\"income-prev\">지난 기간과 같게 (${won(prevIncome)})</button>` : ''}\n          ${received}\n          ${sum.hasIncome ? '<button type=\"button\" class=\"ghost-btn\" id=\"income-cancel\">취소</button>' : ''}\n        </form>`;\n      const input = $('#income-input');\n      formatOnBlur(input);\n      $('#income-form').addEventListener('submit', (e) => {\n        e.preventDefault();\n        const n = parseAmountInput(input.value);\n        if (n === null || n < 0) return toast('금액을 숫자로 입력해 주세요.');\n        setIncome(n);\n      });\n      const bind = (id, fn) => $(id) && $(id).addEventListener('click', fn);\n      bind('#income-prev', () => setIncome(prevIncome));\n      bind('#income-received', () => setIncome(sum.incomeReceived));\n      bind('#income-cancel', () => {\n        box.dataset.editing = '';\n        render();\n      });\n    } else {\n      box.classList.remove('income-prompt');\n      box.innerHTML = `\n        <div class=\"income-set\">\n          <div><span class=\"muted small\">당기 수입(예산)</span><div class=\"value\">${won(sum.income)}</div></div>\n          <button class=\"ghost-btn small-btn\" id=\"income-edit\">수정</button>\n        </div>`;\n      $('#income-edit').addEventListener('click', () => {\n        box.dataset.editing = '1';\n        render();\n      });\n    }\n  }\n\n  function setIncome(n) {\n    S().incomes[currentPeriod.key] = n;\n    store.saveMeta();\n    $('#income-box').dataset.editing = '';\n    toast('당기 수입을 저장했습니다.');\n    render();\n  }\n\n  function renderStaleBox(sum) {\n    const box = $('#stale-box');\n    if (!sum.staleCount || !sum.plan.updatedAt) {\n      box.innerHTML = '';\n      return;\n    }\n    box.innerHTML = `\n      <div class=\"card note-card warn-card\">\n        <b>예산 계획이 바뀌었어요.</b>\n        <p class=\"small\">바뀐 계획에 맞춰 아직 다시 분류하지 않은 지출이 ${sum.staleCount}건 있어요. 직접 고른 항목은 그대로 두고 나머지를 새 항목 기준으로 분류합니다.</p>\n        <button id=\"stale-reclassify\" class=\"primary-btn\">새 계획으로 다시 분류${store.aiEnabled ? ' (AI)' : ''}</button>\n      </div>`;\n    $('#stale-reclassify').addEventListener('click', quiet(() => runReclassify(false)));\n  }\n\n  function renderHome() {\n    const sum = L.summarizePeriod(S(), currentPeriod);\n    renderIncomeBox(sum);\n    renderStaleBox(sum);\n\n    const today = L.todayISO();\n    const isCurrent = today >= currentPeriod.start && today <= currentPeriod.end;\n    const daysLeft = isCurrent ? L.diffDays(today, currentPeriod.end) + 1 : 0;\n    const hero = $('#hero');\n    if (sum.hasIncome) {\n      const ratio = sum.income > 0 ? sum.totalSpent / sum.income : sum.totalSpent > 0 ? Infinity : 0;\n      const status = L.statusOf(ratio);\n      hero.innerHTML = `\n        <div class=\"label\">남은 돈</div>\n        <div class=\"figure ${sum.remaining < 0 ? 'negative' : ''}\">${won(sum.remaining)}</div>\n        <div class=\"sub\">${won(sum.income)} 중 ${won(sum.totalSpent)} 사용 (${sum.income > 0 ? Math.round(ratio * 100) : 0}%)</div>\n        <div class=\"meter ${status}\" role=\"meter\" aria-valuemin=\"0\" aria-valuemax=\"${sum.income}\" aria-valuenow=\"${sum.totalSpent}\" aria-label=\"예산 사용\"><div class=\"meter-fill\" style=\"width:${Math.min(100, ratio * 100)}%\"></div></div>`;\n    } else {\n      hero.innerHTML = `\n        <div class=\"label\">이번 기간 쓴 돈</div>\n        <div class=\"figure\">${won(sum.totalSpent)}</div>\n        <div class=\"sub\">수입을 입력하면 항목별 한도와 남은 돈을 계산해 드려요.</div>`;\n    }\n\n    const perDay = isCurrent && sum.hasIncome && sum.remaining > 0 ? won(Math.floor(sum.remaining / daysLeft)) : '—';\n    $('#home-summary').innerHTML = `\n      <div class=\"kv\"><span class=\"k\">이번 기간 지출</span><span class=\"v\">${won(sum.totalSpent)} · ${sum.transactions.length}건</span></div>\n      <div class=\"kv\"><span class=\"k\">받은 입금</span><span class=\"v plus\">${sum.incomeReceived ? `+${won(sum.incomeReceived)}` : '—'}</span></div>\n      <div class=\"kv\"><span class=\"k\">하루 권장 사용액</span><span class=\"v\">${perDay}</span></div>\n      <div class=\"kv\"><span class=\"k\">미분류</span><span class=\"v\">${sum.unclassifiedCount ? `${won(sum.unclassified)} · ${sum.unclassifiedCount}건` : '없음'}</span></div>`;\n\n    let note = '';\n    if (sum.hasIncome) {\n      if (sum.unallocated > 0) note = `배분되지 않은 돈 ${won(sum.unallocated)}`;\n      else if (sum.unallocated < 0) note = `⚠ 계획이 수입보다 ${won(-sum.unallocated)} 많아요`;\n    }\n    $('#alloc-note').textContent = note;\n\n    const rowsEl = $('#category-rows');\n    if (!sum.plan.categories.length) {\n      rowsEl.innerHTML = '<div class=\"empty\">예산 계획에서 항목을 추가하세요.</div>';\n    } else {\n      const rows = sum.rows.map((r, i) => categoryRow(r, i, sum.hasIncome));\n      if (sum.unclassifiedCount) {\n        rows.push(`\n          <div class=\"cat-row\" data-cat=\"__none\">\n            <div class=\"cat-top\">\n              <span class=\"cat-name\"><span class=\"dot\" style=\"background:var(--gray-mark)\"></span>미분류<span class=\"badge\">항목 지정 필요</span></span>\n              <span class=\"cat-amounts\"><b>${won(sum.unclassified)}</b> · ${sum.unclassifiedCount}건</span>\n            </div>\n          </div>`);\n      }\n      rowsEl.innerHTML = rows.join('');\n      rowsEl.querySelectorAll('.cat-row').forEach((el) => {\n        el.addEventListener('click', () => {\n          Object.assign(listState, { category: el.dataset.cat, kind: 'all', account: 'all', search: '' });\n          showPage('list');\n        });\n        const r = sum.rows.find((x) => x.category.id === el.dataset.cat);\n        if (r) attachTooltip(el.querySelector('.meter'), () => `\n          <strong>${esc(r.category.name)}</strong>\n          <div class=\"t-row\"><span>한도</span><span>${won(r.budget)}</span></div>\n          <div class=\"t-row\"><span>사용</span><span>${won(r.spent)}</span></div>\n          <div class=\"t-row\"><span>${r.remaining >= 0 ? '남음' : '초과'}</span><span>${won(Math.abs(r.remaining))}</span></div>\n          <div class=\"t-row\"><span>건수</span><span>${r.count}건</span></div>`);\n      });\n    }\n\n    const recent = [...sum.allTransactions].sort((a, b) => (a.date + (a.createdAt || '') < b.date + (b.createdAt || '') ? 1 : -1)).slice(0, 5);\n    $('#recent-list').innerHTML = recent.length ? recent.map((t) => txRow(t, { editable: false })).join('') : '<div class=\"empty\">이 기간 내역이 없습니다.</div>';\n\n    const assets = L.assetSummary(S(), currentPeriod);\n    $('#home-assets').innerHTML = assets.banks.length || assets.cards.length\n      ? `<div class=\"kv\"><span class=\"k\">계좌 잔액 합계</span><span class=\"v\">${won(assets.total)}</span></div>\n         ${assets.savings ? `<div class=\"kv\"><span class=\"k\">그중 저축</span><span class=\"v\">${won(assets.savings)}</span></div>` : ''}\n         ${assets.cards.map((c) => `<div class=\"kv\"><span class=\"k\">${esc(accountName(c.id))} (이번 기간)</span><span class=\"v\">${won(c.spent)}</span></div>`).join('')}`\n      : '<div class=\"empty\">설정에서 계좌·카드를 등록하면 잔액과 카드별 사용액을 보여드려요.</div>';\n  }\n\n  function categoryRow(r, index, hasIncome) {\n    const c = r.category;\n    const badge = c.type === 'fixed' ? `고정 ${won(c.value)}` : `수입의 ${c.value}%`;\n    const status = L.statusOf(r.ratio);\n    const pct = r.budget > 0 ? Math.round(r.ratio * 100) : null;\n    const width = r.budget > 0 ? Math.min(100, r.ratio * 100) : r.spent > 0 ? 100 : 0;\n    const noBudget = c.type === 'ratio' && !hasIncome;\n\n    let statusText;\n    if (noBudget) statusText = '수입 입력 전';\n    else if (status === 'critical') statusText = `⚠ 초과 ${pct === null ? '' : `(${pct}%)`}`;\n    else if (status === 'warning') statusText = pct === 100 ? '한도 도달 100%' : `! 주의 ${pct}%`;\n    else statusText = pct === null ? '' : `${pct}% 사용`;\n\n    const remain = noBudget\n      ? ''\n      : r.remaining >= 0\n        ? `<span class=\"remain-good\">${won(r.remaining)} 남음</span>`\n        : `<span class=\"remain-bad\">${won(-r.remaining)} 초과</span>`;\n\n    return `\n      <div class=\"cat-row\" data-cat=\"${esc(c.id)}\">\n        <div class=\"cat-top\">\n          <span class=\"cat-name\"><span class=\"dot\" style=\"background:${C.seriesColor(index)}\"></span>${esc(c.name)}<span class=\"badge\">${esc(badge)}</span></span>\n          <span class=\"cat-amounts\"><b>${won(r.spent)}</b> / ${noBudget ? '—' : won(r.budget)}</span>\n        </div>\n        <div class=\"meter ${noBudget ? '' : status}\" role=\"meter\" aria-valuemin=\"0\" aria-valuemax=\"${r.budget}\" aria-valuenow=\"${r.spent}\" aria-label=\"${esc(c.name)} 사용액\">\n          <div class=\"meter-fill\" style=\"width:${width}%\"></div>\n        </div>\n        <div class=\"cat-bottom\">\n          <span class=\"status ${noBudget ? '' : status}\">${statusText}</span>\n          ${remain}\n        </div>\n      </div>`;\n  }\n\n  // ---------- 달력 ----------\n\n  function renderCalendar() {\n    const p = currentPeriod;\n    const sum = L.summarizePeriod(S(), p);\n    const days = L.dailyTotals(sum.allTransactions);\n    const today = L.todayISO();\n    if (!selectedDate || selectedDate < p.start || selectedDate > p.end) selectedDate = today >= p.start && today <= p.end ? today : p.start;\n\n    $('#cal-summary').innerHTML = `\n      <span>지출 <b>${won(sum.totalSpent)}</b></span>\n      <span class=\"plus\">입금 <b>${sum.incomeReceived ? `+${won(sum.incomeReceived)}` : '0원'}</b></span>\n      ${sum.hasIncome ? `<span>남은 돈 <b>${won(sum.remaining)}</b></span>` : ''}`;\n\n    const maxSpent = Math.max(0, ...Object.values(days).map((d) => d.spent));\n    const first = L.addDays(p.start, -dowOf(p.start));\n    const last = L.addDays(p.end, 6 - dowOf(p.end));\n    const cells = DOW.map((w, i) => `<div class=\"cal-dow ${i === 0 ? 'sun' : ''}\">${w}</div>`);\n    for (let cursor = first; cursor <= last; cursor = L.addDays(cursor, 1)) {\n      const inPeriod = cursor >= p.start && cursor <= p.end;\n      const info = days[cursor] || { spent: 0, income: 0 };\n      const q = L.parseISO(cursor);\n      const label = q.d === 1 || cursor === p.start ? `${q.m}/${q.d}` : q.d;\n      let heat = '';\n      if (inPeriod && info.spent > 0 && maxSpent > 0) heat = `h${Math.min(3, Math.ceil((info.spent / maxSpent) * 3))}`;\n      cells.push(inPeriod\n        ? `<button class=\"cal-day ${heat} ${cursor === today ? 'today' : ''} ${cursor === selectedDate ? 'selected' : ''}\" data-date=\"${cursor}\" aria-label=\"${fmtDay(cursor)} 지출 ${won(info.spent)}\">\n             <span class=\"cal-num\">${label}</span>\n             ${info.spent ? `<span class=\"cal-spent\">-${C.tinyWon(info.spent)}</span>` : ''}\n             ${info.income ? `<span class=\"cal-income\">+${C.tinyWon(info.income)}</span>` : ''}\n           </button>`\n        : `<div class=\"cal-day out\"><span class=\"cal-num\">${label}</span></div>`);\n    }\n    const cal = $('#calendar');\n    cal.innerHTML = cells.join('');\n    cal.querySelectorAll('.cal-day[data-date]').forEach((b) => b.addEventListener('click', () => {\n      selectedDate = b.dataset.date;\n      renderCalendar();\n    }));\n\n    const dayTxs = sum.allTransactions.filter((t) => t.date === selectedDate);\n    $('#day-title').textContent = fmtDay(selectedDate);\n    const info = days[selectedDate];\n    $('#day-total').textContent = info ? `지출 ${won(info.spent)}${info.income ? ` · 입금 ${won(info.income)}` : ''}` : '';\n    const list = $('#day-list');\n    list.innerHTML = dayTxs.length ? dayTxs.map((t) => txRow(t)).join('') : '<div class=\"empty\">이날은 내역이 없어요.</div>';\n    bindTxEvents(list);\n  }\n\n  // ---------- 내역 ----------\n\n  function renderList() {\n    const sum = L.summarizePeriod(S(), currentPeriod);\n    const cats = sum.plan.categories;\n    const known = new Set(cats.map((c) => c.id));\n    if (listState.category !== 'all' && listState.category !== '__none' && !known.has(listState.category)) listState.category = 'all';\n\n    $('#list-filter').innerHTML = `<option value=\"all\">모든 항목</option><option value=\"__none\">미분류</option>` +\n      cats.map((c) => `<option value=\"${esc(c.id)}\">${esc(c.name)}</option>`).join('');\n    $('#list-filter').value = listState.category;\n    $('#list-account').innerHTML = `<option value=\"all\">모든 결제수단</option>` +\n      S().accounts.map((a) => `<option value=\"${esc(a.id)}\">${esc(accountName(a.id))}</option>`).join('');\n    $('#list-account').value = S().accounts.some((a) => a.id === listState.account) ? listState.account : 'all';\n    $('#list-kind').value = listState.kind;\n    $('#list-search').value = listState.search;\n    $('#reclassify-all').textContent = `이 기간 전체 다시 분류${store.aiEnabled ? ' (AI)' : ''}`;\n\n    const q = L.normalizeMerchant(listState.search);\n    const txs = sum.allTransactions.filter((t) => {\n      const kind = L.kindOf(t);\n      if (listState.kind !== 'all' && kind !== listState.kind) return false;\n      if (listState.category === '__none' && (kind !== 'expense' || known.has(t.categoryId))) return false;\n      if (listState.category !== 'all' && listState.category !== '__none' && t.categoryId !== listState.category) return false;\n      if (listState.account !== 'all' && t.accountId !== listState.account) return false;\n      if (q && !L.normalizeMerchant(t.memo).includes(q)) return false;\n      return true;\n    });\n\n    const spent = txs.filter((t) => L.kindOf(t) === 'expense').reduce((s, t) => s + t.amount, 0);\n    const inc = txs.filter((t) => L.kindOf(t) === 'income').reduce((s, t) => s + t.amount, 0);\n    $('#list-total').innerHTML = `<span>${txs.length}건</span><span>지출 <b>${won(spent)}</b></span>${inc ? `<span>입금 <b>+${won(inc)}</b></span>` : ''}`;\n\n    const el = $('#tx-list');\n    el.innerHTML = txs.length ? txGroups(txs) : '<div class=\"empty\">조건에 맞는 내역이 없습니다.</div>';\n    bindTxEvents(el);\n  }\n\n  async function runReclassify(onlyUnclassified) {\n    const label = store.aiEnabled ? 'AI가 다시 분류하는 중…' : '다시 분류하는 중…';\n    const n = await busy(label, () => store.reclassify(currentPeriod, onlyUnclassified));\n    toast(n ? `${n}건을 다시 분류했습니다.` : '다시 분류할 지출이 없습니다.');\n    render();\n  }\n\n  // ---------- 리포트 ----------\n\n  function periodLabel(p) {\n    const { m, d } = L.parseISO(p.start);\n    return S().settings.startDay === 1 ? `${m}월` : `${m}/${d}`;\n  }\n\n  function renderReport() {\n    const cmp = L.compareWithPrevious(S(), currentPeriod);\n    const sum = cmp.current;\n    const diff = cmp.totalDiff;\n    const prevSpent = cmp.previous.totalSpent;\n    let deltaText;\n    if (!prevSpent && !sum.totalSpent) deltaText = '아직 지출이 없어요.';\n    else if (!prevSpent) deltaText = '지난 기간 기록이 없어 비교할 수 없어요.';\n    else if (diff > 0) deltaText = `지난 기간보다 <b>${won(diff)} 더</b> 썼어요 ▲`;\n    else if (diff < 0) deltaText = `지난 기간보다 <b>${won(-diff)} 덜</b> 썼어요 ▼`;\n    else deltaText = '지난 기간과 똑같이 썼어요.';\n    const budgetLine = sum.hasIncome && sum.income > 0 ? `<div class=\"delta\">예산의 <b>${Math.round((sum.totalSpent / sum.income) * 100)}%</b> 사용</div>` : '';\n    $('#report-headline').innerHTML = `\n      <div class=\"muted small\">이번 기간 지출</div>\n      <div class=\"headline-figure\">${won(sum.totalSpent)}</div>\n      <div class=\"delta\">${deltaText}</div>\n      ${budgetLine}`;\n\n    const top = L.topMerchants(sum.allTransactions, 5);\n    $('#report-merchants').innerHTML = `<h2>많이 쓴 곳</h2>${top.length\n      ? top.map((m, i) => `<div class=\"rank\"><span class=\"n\">${i + 1}</span><span class=\"m\">${esc(m.memo)} <span class=\"muted small\">${m.count}회</span></span><span class=\"a\">${won(m.total)}</span></div>`).join('')\n      : '<div class=\"empty\">지출이 없어요.</div>'}`;\n\n    const rows = L.categoryBreakdown(sum);\n    const diffById = {};\n    for (const r of cmp.rows) diffById[r.id] = r.diff;\n    const share = $('#report-share');\n    if (!rows.length) {\n      share.innerHTML = '<div class=\"empty\">이 기간 지출이 없어요.</div>';\n    } else {\n      const fmtDiff = (d) => (d === undefined ? '' : d > 0 ? `▲ ${won(d)}` : d < 0 ? `▼ ${won(-d)}` : '변동 없음');\n      share.innerHTML = C.shareBar(rows) + rows.map((r) => `\n        <div class=\"share-row\">\n          <span class=\"share-name\"><span class=\"dot\" style=\"background:${C.seriesColor(r.colorIndex)}\"></span><span>${esc(r.name)} <span class=\"muted small\">${Math.round(r.share * 100)}%</span></span></span>\n          <span class=\"share-amount\">${won(r.amount)}</span>\n          <span class=\"share-diff\" title=\"지난 기간 대비\">${fmtDiff(diffById[r.id])}</span>\n        </div>`).join('');\n      const segs = C.shareSegments(rows);\n      share.querySelectorAll('[data-seg]').forEach((el) => {\n        const s = segs[el.dataset.seg];\n        attachTooltip(el, () => `<div class=\"t-row\"><span><span class=\"dot\" style=\"background:${s.color}\"></span>${esc(s.name)}</span><span>${won(s.amount)}</span></div>`);\n      });\n    }\n\n    const tr = L.trend(S(), currentPeriod, 6);\n    const data = tr.map((x) => ({ label: periodLabel(x.period), income: x.budgetIncome !== null ? x.budgetIncome : x.incomeReceived, spent: x.spent }));\n    const trendEl = $('#report-trend');\n    trendEl.innerHTML = `\n      <div class=\"legend\"><span><span class=\"dot\" style=\"background:var(--s1)\"></span>수입</span><span><span class=\"dot\" style=\"background:var(--s2)\"></span>지출</span></div>\n      <div class=\"chart\">${C.trendChart(data)}</div>`;\n    trendEl.querySelectorAll('.hit').forEach((el) => {\n      const i = Number(el.dataset.i);\n      const x = tr[i];\n      attachTooltip(el, () => `\n        <strong>${fmtDate(x.period.start)} ~</strong>\n        <div class=\"t-row\"><span><span class=\"dot\" style=\"background:var(--s1)\"></span>수입${x.budgetIncome === null ? ' (받은 입금)' : ''}</span><span>${won(data[i].income || 0)}</span></div>\n        <div class=\"t-row\"><span><span class=\"dot\" style=\"background:var(--s2)\"></span>지출</span><span>${won(x.spent)}</span></div>`);\n      el.addEventListener('click', () => {\n        currentPeriod = x.period;\n        render();\n      });\n    });\n  }\n\n  // ---------- 자산 ----------\n\n  function renderAssets() {\n    const a = L.assetSummary(S(), currentPeriod);\n    const hasBalance = a.banks.some((b) => typeof b.balance === 'number');\n    $('#asset-hero').innerHTML = `\n      <div class=\"label\">계좌 잔액 합계</div>\n      <div class=\"figure\">${hasBalance ? won(a.total) : '—'}</div>\n      <div class=\"sub\">${a.savings ? `저축 계좌 ${won(a.savings)} · ` : ''}등록한 계좌 ${a.banks.length}개, 카드 ${a.cards.length}개</div>`;\n\n    const banks = $('#asset-banks');\n    banks.innerHTML = a.banks.length\n      ? a.banks.map((b) => `\n        <div class=\"acct\">\n          <div class=\"acct-icon\">${esc((b.name || '계좌').slice(0, 1))}</div>\n          <div><div class=\"acct-name\">${esc(accountName(b.id))}</div><div class=\"acct-sub\">끝자리 ${esc(b.last4 || '----')}${b.isSavings ? ' · 저축' : ''}${b.spent ? ` · 이번 기간 출금 ${won(b.spent)}` : ''}</div></div>\n          <div class=\"acct-bal\">${typeof b.balance === 'number' ? won(b.balance) : '<span class=\"muted\">잔액 미입력</span>'}\n            <div class=\"acct-sub\">${b.balanceAt ? `${fmtDateTime(b.balanceAt)} 기준 ` : ''}<button class=\"link edit-balance\" data-id=\"${esc(b.id)}\">수정</button></div>\n          </div>\n        </div>`).join('')\n      : '<div class=\"empty\">등록한 계좌가 없어요. <button class=\"link\" data-goto=\"settings\">계좌 등록하기</button></div>';\n    banks.querySelectorAll('.edit-balance').forEach((btn) => btn.addEventListener('click', () => {\n      const acc = S().accounts.find((x) => x.id === btn.dataset.id);\n      const v = prompt(`${accountName(acc.id)} 의 현재 잔액(원)`, typeof acc.balance === 'number' ? String(acc.balance) : '');\n      if (v === null) return;\n      const n = parseAmountInput(v);\n      if (n === null) return toast('숫자로 입력해 주세요.');\n      acc.balance = n;\n      acc.balanceAt = nowISO();\n      store.saveMeta();\n      render();\n    }));\n\n    $('#asset-cards').innerHTML = a.cards.length\n      ? a.cards.map((c) => `\n        <div class=\"acct\">\n          <div class=\"acct-icon is-card\">${esc((c.name || '카드').slice(0, 1))}</div>\n          <div><div class=\"acct-name\">${esc(accountName(c.id))}</div><div class=\"acct-sub\">끝자리 ${esc(c.last4 || '----')}</div></div>\n          <div class=\"acct-bal\">${won(c.spent)}</div>\n        </div>`).join('') + (a.unlinkedSpent ? `<div class=\"acct\"><div class=\"acct-icon is-card\">?</div><div><div class=\"acct-name\">결제수단 모름</div><div class=\"acct-sub\">알림에서 카드·계좌를 찾지 못한 지출</div></div><div class=\"acct-bal\">${won(a.unlinkedSpent)}</div></div>` : '')\n      : '<div class=\"empty\">등록한 카드가 없어요.</div>';\n    $$('#asset-banks [data-goto], #asset-cards [data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));\n  }\n\n  // ---------- 예산 계획 ----------\n\n  // 이 기간의 계획을 고치기 전에 호출: 지난 기간 계획을 물려받고 있었다면 이 기간부터 적용되는 새 계획을 만든다.\n  function editablePlan() {\n    const plan = L.ensurePlanFor(S(), currentPeriod.key, nowISO());\n    plan.updatedAt = nowISO();\n    return plan;\n  }\n\n  function renderPlanVersion() {\n    const plan = currentPlan();\n    const inherited = plan.from !== currentPeriod.key;\n    const next = L.nextPlanAfter(S(), { from: currentPeriod.key });\n    const parts = [`<b>${fmtDate(currentPeriod.start)} 기간의 계획</b>`];\n    parts.push(plan.from === L.BASE_PLAN_FROM ? '처음부터 쓰던 계획입니다.' : `${fmtDate(plan.from)} 기간부터 적용된 계획입니다.`);\n    parts.push(inherited\n      ? '여기서 고치면 <b>이번 기간부터</b> 새 계획으로 저장되고, 지난 기간은 그때 계획 그대로 남아요.'\n      : '고치면 이 기간과 이후 기간에 적용되고, 지난 기간은 그대로 남아요.');\n    if (next) parts.push(`${fmtDate(next.from)} 기간부터는 그 뒤에 바꾼 계획이 적용돼요.`);\n    $('#plan-version').innerHTML = parts.map((x) => `<div class=\"small\">${x}</div>`).join('');\n  }\n\n  function renderPlan() {\n    renderPlanVersion();\n    const plan = currentPlan();\n    $('#ratio-base').value = plan.ratioBase;\n\n    const rowsEl = $('#plan-rows');\n    rowsEl.innerHTML = `\n      <div class=\"plan-row head\"><span>항목 이름</span><span>방식</span><span>비율 / 금액</span><span>설명 (AI 참고)</span><span>키워드</span><span></span></div>\n      ${plan.categories.map((c) => `\n        <div class=\"plan-row\" data-id=\"${esc(c.id)}\">\n          <input type=\"text\" class=\"pl-name\" value=\"${esc(c.name)}\" aria-label=\"항목 이름\">\n          <select class=\"pl-type\" aria-label=\"방식\">\n            <option value=\"ratio\" ${c.type === 'ratio' ? 'selected' : ''}>수입 비례(%)</option>\n            <option value=\"fixed\" ${c.type === 'fixed' ? 'selected' : ''}>고정 금액</option>\n          </select>\n          <div class=\"value-wrap\">\n            <input type=\"text\" inputmode=\"decimal\" class=\"pl-value\" value=\"${c.type === 'fixed' ? Number(c.value).toLocaleString('ko-KR') : c.value}\" aria-label=\"값\">\n            <span class=\"unit\">${c.type === 'fixed' ? '원' : '%'}</span>\n          </div>\n          <input type=\"text\" class=\"pl-desc\" value=\"${esc(c.description || '')}\" placeholder=\"예: 외식, 배달, 장보기\" aria-label=\"설명\">\n          <input type=\"text\" class=\"pl-kw\" value=\"${esc((c.keywords || []).join(', '))}\" placeholder=\"예: 스타벅스, 카페\" aria-label=\"키워드\">\n          <button class=\"link-btn pl-del\" aria-label=\"${esc(c.name)} 삭제\">✕</button>\n          <div class=\"preview\"></div>\n        </div>`).join('')}`;\n\n    const edit = (id, fn, rerender) => {\n      const c = editablePlan().categories.find((x) => x.id === id);\n      fn(c);\n      store.saveMeta();\n      if (rerender) renderPlan();\n      else {\n        renderPlanVersion();\n        renderPlanSummary();\n      }\n    };\n\n    rowsEl.querySelectorAll('.plan-row[data-id]').forEach((row) => {\n      const id = row.dataset.id;\n      row.querySelector('.pl-name').addEventListener('change', (e) => edit(id, (c) => (c.name = e.target.value.trim() || '이름 없음')));\n      row.querySelector('.pl-type').addEventListener('change', (e) => edit(id, (c) => {\n        c.type = e.target.value;\n        c.value = 0;\n      }, true));\n      row.querySelector('.pl-value').addEventListener('change', (e) => edit(id, (c) => {\n        const n = Number(e.target.value.replace(/[^\\d.]/g, '')) || 0;\n        c.value = c.type === 'fixed' ? Math.round(n) : Math.round(n * 100) / 100;\n        if (c.type === 'fixed') e.target.value = c.value.toLocaleString('ko-KR');\n      }));\n      row.querySelector('.pl-desc').addEventListener('change', (e) => edit(id, (c) => (c.description = e.target.value.trim())));\n      row.querySelector('.pl-kw').addEventListener('change', (e) => edit(id, (c) => {\n        c.keywords = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);\n      }));\n      row.querySelector('.pl-del').addEventListener('click', () => {\n        const c = currentPlan().categories.find((x) => x.id === id);\n        if (!confirm(`'${c.name}' 항목을 이번 기간 계획부터 뺄까요? 이 항목으로 분류된 이번 기간 지출은 다시 분류해야 합니다.`)) return;\n        const p = editablePlan();\n        p.categories = p.categories.filter((x) => x.id !== id);\n        store.saveMeta();\n        renderPlan();\n      });\n    });\n    renderPlanSummary();\n  }\n\n  function renderPlanSummary() {\n    const plan = currentPlan();\n    const income = S().incomes[currentPeriod.key];\n    const hasIncome = typeof income === 'number';\n    const calc = L.computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase);\n\n    $$('.plan-row[data-id]').forEach((row) => {\n      const c = plan.categories.find((x) => x.id === row.dataset.id);\n      const p = row.querySelector('.preview');\n      if (!c) return;\n      if (c.type === 'fixed') p.textContent = '수입과 상관없이 매 기간 같은 한도';\n      else p.textContent = hasIncome ? `이번 기간 한도 ${won(calc.budgets[c.id])}` : '당기 수입을 입력하면 한도가 계산됩니다';\n    });\n\n    const base = plan.ratioBase === 'afterFixed' ? '고정 항목을 뺀 나머지' : '전체 수입';\n    const lines = [`고정 항목 합계 <b>${won(calc.fixedTotal)}</b> · 비율 항목 합계 <b>${calc.ratioPercentTotal}%</b> (${base} 기준)`];\n    if (calc.ratioPercentTotal > 100) lines.push('<span class=\"warn\">⚠ 비율 합계가 100%를 넘습니다.</span>');\n    else if (calc.ratioPercentTotal < 100) lines.push(`<span class=\"muted\">비율 합계가 100%보다 ${Math.round((100 - calc.ratioPercentTotal) * 100) / 100}% 적어 일부 수입은 배분되지 않습니다.</span>`);\n    if (hasIncome) {\n      lines.push(`이번 기간 수입 ${won(income)} 기준: 배분 ${won(calc.allocated)}` +\n        (calc.unallocated >= 0 ? ` · 남는 돈 ${won(calc.unallocated)}` : ` · <span class=\"warn\">${won(-calc.unallocated)} 부족</span>`));\n      if (plan.ratioBase === 'afterFixed' && calc.fixedTotal > income) lines.push('<span class=\"warn\">⚠ 고정 항목 합계가 수입보다 큽니다.</span>');\n    }\n    $('#plan-summary').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');\n  }\n\n  function addCategory() {\n    const plan = editablePlan();\n    plan.categories.push({ id: `c-${uid()}`, name: '새 항목', type: 'ratio', value: 0, description: '', keywords: [] });\n    store.saveMeta();\n    renderPlan();\n    const inputs = $$('.pl-name');\n    const last = inputs[inputs.length - 1];\n    last.focus();\n    last.select();\n  }\n\n  // ---------- 입력 ----------\n\n  function renderAdd() {\n    $('#auto-hint').innerHTML = store.mode === 'remote'\n      ? '<b>카드 문자와 은행 알림은 자동으로 들어와요.</b> <span class=\"small\">휴대폰 자동화(설정 → 자동 입력)를 해 두면 결제·이체 알림이 올 때마다 AI가 읽고 분류해서 기록합니다. 여기서는 그 밖의 내역을 넣으세요.</span>'\n      : '<b>지금은 이 기기에만 저장하는 모드예요.</b> <span class=\"small\">카드·은행 알림 자동 입력과 AI 분류를 쓰려면 설정 → 자동 입력에서 구글 시트 서버를 연결하세요.</span>';\n    $('#classifier-name').textContent = store.aiEnabled ? 'AI가 항목' : '키워드로 항목';\n\n    $$('#m-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === manualKind));\n    $('#m-category-wrap').hidden = manualKind !== 'expense';\n    const sel = $('#m-category');\n    const prev = sel.value || '__auto';\n    if (!$('#m-date').value) $('#m-date').value = L.todayISO();\n    sel.innerHTML = categoryOptions(planForDate($('#m-date').value).categories, null, { includeAuto: true });\n    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '__auto';\n    const acc = $('#m-account').value;\n    $('#m-account').innerHTML = accountOptions(acc);\n    const fileAcc = $('#file-account').value || (S().accounts.find((a) => a.type !== 'card') || {}).id || '';\n    $('#file-account').innerHTML = accountOptions(fileAcc, '계좌 선택 안 함');\n    $('#m-memo').placeholder = manualKind === 'income' ? '(주)회사 급여' : manualKind === 'transfer' ? '적금 계좌로' : '스타벅스 강남점';\n    updateManualHint();\n    renderParseResult();\n  }\n\n  function updateManualHint() {\n    const memo = $('#m-memo').value;\n    if (manualKind === 'transfer') {\n      $('#m-hint').textContent = '내 계좌끼리 옮긴 돈은 지출·수입 합계에서 빠집니다. 저축 목적이면 \"지출\"로 넣고 저축 항목을 고르세요.';\n      return;\n    }\n    if (manualKind !== 'expense' || $('#m-category').value !== '__auto' || !memo.trim()) {\n      $('#m-hint').textContent = '';\n      return;\n    }\n    if (store.aiEnabled) {\n      $('#m-hint').textContent = '추가하면 AI가 항목을 정합니다.';\n      return;\n    }\n    const plan = planForDate($('#m-date').value || L.todayISO());\n    const r = L.classifyLocal(memo, plan.categories, S().merchantMap);\n    $('#m-hint').textContent = `자동 분류 결과: ${categoryInfo(r.categoryId, plan.categories).name}`;\n  }\n\n  async function onManualSubmit(e) {\n    e.preventDefault();\n    const date = $('#m-date').value;\n    const amount = parseAmountInput($('#m-amount').value);\n    const memo = $('#m-memo').value.trim() || '(내용 없음)';\n    if (!date) return toast('날짜를 입력해 주세요.');\n    if (amount === null || amount === 0) return toast('금액을 입력해 주세요.');\n    const sel = manualKind === 'expense' ? $('#m-category').value : '';\n    if (sel && sel !== '__auto') {\n      S().merchantMap[L.normalizeMerchant(memo)] = sel;\n      store.saveMeta();\n    }\n    const item = {\n      date, amount, memo, kind: manualKind, accountId: $('#m-account').value || null, source: 'manual',\n      categoryId: sel === '' ? null : sel,\n      method: sel && sel !== '__auto' ? 'manual' : undefined,\n    };\n    const [tx] = await busy(sel === '__auto' && store.aiEnabled ? 'AI가 분류하는 중…' : null, () => store.addTransactions([item]));\n    $('#m-amount').value = '';\n    $('#m-memo').value = '';\n    updateManualHint();\n    const what = manualKind === 'expense' ? `${categoryInfo(tx.categoryId, planForDate(tx.date).categories).name} 항목에` : manualKind === 'income' ? '입금으로' : '내 계좌 이체로';\n    toast(`${what} ${won(amount)} 추가했습니다.`);\n    jumpToDate(date);\n  }\n\n  function jumpToDate(date) {\n    const p = L.getPeriod(date, S().settings.startDay);\n    if (p.key !== currentPeriod.key) currentPeriod = p;\n    render();\n  }\n\n  // 붙여넣기와 파일 가져오기가 같은 미리보기를 쓴다. preview.source: 'paste' | 'file'\n  const preview = { source: 'paste', items: [], skipped: [], latest: null, accountId: null, fileName: '' };\n\n  function clearPreview() {\n    Object.assign(preview, { items: [], skipped: [], latest: null, accountId: null, fileName: '' });\n    renderParseResult();\n  }\n\n  // 지출만 분류한다. 서버(AI)는 여러 번에 나눠 보낸다.\n  async function classifyPreview(items) {\n    const expenses = items.filter((it) => it.kind === 'expense');\n    const step = store.mode === 'remote' ? 60 : expenses.length || 1;\n    for (let i = 0; i < expenses.length; i += step) {\n      const chunk = expenses.slice(i, i + step);\n      if (store.aiEnabled && expenses.length > step) toast(`AI가 분류하는 중… (${Math.min(i + step, expenses.length)}/${expenses.length})`, 60000);\n      const res = await store.classify(chunk.map(({ date, amount, memo }) => ({ date, amount, memo })));\n      chunk.forEach((it, k) => Object.assign(it, res[k]));\n    }\n  }\n\n  function withDupFlags(items) {\n    return items.map((it) => {\n      const dup = !!L.findDuplicate(it, S().transactions);\n      return { categoryId: null, method: null, ...it, dup, checked: !dup };\n    });\n  }\n\n  async function onParse() {\n    const { items, skipped } = L.parseExpenseText($('#paste-input').value, L.todayISO());\n    Object.assign(preview, { source: 'paste', skipped, latest: null, accountId: null, fileName: '' });\n    preview.items = withDupFlags(items.map((it) => ({ ...it, kind: 'expense' })));\n    if (preview.items.length) await busy(store.aiEnabled ? `AI가 ${preview.items.length}건을 분류하는 중…` : null, () => classifyPreview(preview.items));\n    renderParseResult();\n  }\n\n  async function onFileChosen(file) {\n    const accountId = $('#file-account').value || null;\n    let rows;\n    try {\n      rows = await window.BudgetXlsx.readTableFile(file);\n    } catch (e) {\n      return toast(e.message || '파일을 읽지 못했어요.', 7000);\n    }\n    const parsed = L.parseStatementRows(rows, { myName: S().settings.myName, accountId });\n    if (!parsed.header) return toast('거래내역 표를 찾지 못했어요. 날짜와 금액 칸이 있는 은행 거래내역 파일인지 확인해 주세요.', 7000);\n    Object.assign(preview, { source: 'file', skipped: [], latest: parsed.latest, accountId, fileName: file.name });\n    preview.items = withDupFlags(parsed.items);\n    if (parsed.skipped) preview.skipped = [`날짜를 읽지 못한 줄 ${parsed.skipped}개`];\n    if (preview.items.length) {\n      await busy(store.aiEnabled ? `AI가 ${preview.items.filter((x) => x.kind === 'expense').length}건을 분류하는 중…` : null, () => classifyPreview(preview.items));\n    }\n    renderParseResult();\n  }\n\n  const KIND_LABEL = { income: '입금', transfer: '내 계좌 이체' };\n\n  function renderParseResult() {\n    const target = preview.source === 'file' ? $('#file-result') : $('#parse-result');\n    const other = preview.source === 'file' ? $('#parse-result') : $('#file-result');\n    other.innerHTML = '';\n    if (!preview.items.length && !preview.skipped.length) {\n      target.innerHTML = '';\n      return;\n    }\n    const items = preview.items;\n    const rows = items.map((it, i) => `\n      <tr>\n        <td><input type=\"checkbox\" data-i=\"${i}\" class=\"p-check\" ${it.checked ? 'checked' : ''} aria-label=\"추가\"></td>\n        <td><input type=\"date\" data-i=\"${i}\" class=\"p-date\" value=\"${it.date}\"></td>\n        <td class=\"memo\">${esc(it.memo)} ${it.dup ? '<span class=\"tag warn\">중복?</span>' : ''} ${it.kind === 'expense' ? methodTag(it.method) : ''}</td>\n        <td class=\"amount ${it.kind === 'income' || it.amount < 0 ? 'refund' : ''}\">${it.kind === 'income' ? '+' : ''}${won(it.amount)}</td>\n        <td>${it.kind === 'expense'\n          ? `<select data-i=\"${i}\" class=\"p-cat\">${categoryOptions(planForDate(it.date).categories, it.categoryId)}</select>`\n          : `<span class=\"tag\">${KIND_LABEL[it.kind]}</span>`}</td>\n      </tr>`).join('');\n    const dups = items.filter((x) => x.dup).length;\n    const dates = items.map((x) => x.date).sort();\n    const summary = preview.source === 'file' && items.length\n      ? `<p class=\"small\">${esc(preview.fileName)} · ${fmtDate(dates[0])} ~ ${fmtDate(dates[dates.length - 1])} · ${items.length}건${dups ? ` (이미 있는 내역으로 보이는 ${dups}건은 빼 두었어요)` : ''}${preview.latest ? ` · 마지막 잔액 ${won(preview.latest.balance)}` : ''}</p>`\n      : '';\n    target.innerHTML = `\n      ${summary}\n      ${items.length ? `\n      <div class=\"row-actions\">\n        <button class=\"ghost-btn small-btn\" id=\"p-all\">모두 선택</button>\n        <button class=\"ghost-btn small-btn\" id=\"p-none\">모두 해제</button>\n      </div>\n      <div class=\"table-wrap\">\n        <table class=\"stack-table parse-table\">\n          <thead><tr><th></th><th>날짜</th><th>사용처</th><th class=\"amount\">금액</th><th>항목</th></tr></thead>\n          <tbody>${rows}</tbody>\n        </table>\n      </div>\n      <div class=\"row-actions\"><button id=\"p-add\" class=\"primary-btn\">선택한 ${items.filter((x) => x.checked).length}건 추가</button></div>` : ''}\n      ${preview.skipped.length ? `<p class=\"muted small\">건너뛴 줄 ${preview.skipped.length}개: ${preview.skipped.map(esc).join(' / ')}</p>` : ''}`;\n\n    const setAll = (v) => {\n      items.forEach((x) => (x.checked = v));\n      renderParseResult();\n    };\n    if ($('#p-all')) $('#p-all').addEventListener('click', () => setAll(true));\n    if ($('#p-none')) $('#p-none').addEventListener('click', () => setAll(false));\n    target.querySelectorAll('.p-check').forEach((c) => c.addEventListener('change', () => {\n      items[c.dataset.i].checked = c.checked;\n      renderParseResult();\n    }));\n    target.querySelectorAll('.p-date').forEach((c) => c.addEventListener('change', () => (items[c.dataset.i].date = c.value)));\n    target.querySelectorAll('.p-cat').forEach((c) => c.addEventListener('change', () => {\n      const it = items[c.dataset.i];\n      it.categoryId = c.value || null;\n      it.method = c.value ? 'manual' : null;\n    }));\n    const addBtn = $('#p-add');\n    if (addBtn) addBtn.addEventListener('click', quiet(addPreviewItems));\n  }\n\n  async function addPreviewItems() {\n    const chosen = preview.items.filter((x) => x.checked && x.date);\n    if (!chosen.length) return toast('추가할 내역을 선택해 주세요.');\n    let changedMeta = false;\n    for (const it of chosen) {\n      if (it.method === 'manual' && it.categoryId) {\n        S().merchantMap[L.normalizeMerchant(it.memo)] = it.categoryId;\n        changedMeta = true;\n      }\n    }\n    // 파일의 마지막 잔액이 지금 알고 있는 잔액보다 최근이면 계좌 잔액을 바꾼다\n    const acc = preview.accountId && S().accounts.find((a) => a.id === preview.accountId);\n    if (acc && preview.latest) {\n      const at = new Date(`${preview.latest.date}T${preview.latest.time || '23:59:59'}+09:00`).toISOString();\n      if (!acc.balanceAt || at > acc.balanceAt) {\n        acc.balance = preview.latest.balance;\n        acc.balanceAt = at;\n        changedMeta = true;\n      }\n    }\n    if (changedMeta) store.saveMeta();\n    const source = preview.source === 'file' ? 'file' : 'paste';\n    for (let i = 0; i < chosen.length; i += 200) {\n      const part = chosen.slice(i, i + 200);\n      await busy(`저장하는 중… (${Math.min(i + 200, chosen.length)}/${chosen.length})`, () =>\n        store.addTransactions(part.map((it) => ({\n          date: it.date, amount: it.amount, memo: it.memo, kind: it.kind || 'expense', accountId: it.accountId || null,\n          categoryId: it.kind === 'expense' ? it.categoryId : null, method: it.method, source, raw: it.raw,\n        })))\n      );\n    }\n    const latestDate = chosen.map((x) => x.date).sort().pop();\n    if (preview.source === 'paste') $('#paste-input').value = '';\n    else $('#file-input').value = '';\n    clearPreview();\n    toast(`${chosen.length}건을 추가했습니다.`);\n    jumpToDate(latestDate);\n  }\n\n  // ---------- 설정 ----------\n\n  // 알림 연결 앱(안드로이드) 내려받기 주소 (GitHub Actions 가 main 에 올라갈 때마다 갱신)\n  const NOTI_APK_URL = 'https://github.com/kdh1207-star/ClaudeCode1/releases/download/noti-app/budget-noti.apk';\n\n  // 설치된 알림 연결 앱을 열면서 서버 주소를 넘긴다 (크롬 안드로이드의 intent 링크)\n  function connectLink() {\n    const url = encodeURIComponent(notifyUrl('bank'));\n    return `intent://setup?url=${url}#Intent;scheme=budgetnoti;package=com.kdh1207.budgetnoti;S.browser_fallback_url=${encodeURIComponent(NOTI_APK_URL)};end`;\n  }\n\n  function notifyUrl(source) {\n    return store.serviceUrl ? `${store.serviceUrl}?action=sms&key=${encodeURIComponent(store.server.key)}${source ? `&source=${source}` : ''}` : '';\n  }\n\n  function renderSettings() {\n    const sd = $('#start-day');\n    if (!sd.options.length) sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value=\"${i + 1}\">매월 ${i + 1}일</option>`).join('');\n    sd.value = String(S().settings.startDay);\n    $('#my-name').value = S().settings.myName || '';\n    renderAccountRows();\n    renderAutoCard();\n    $('#data-note').textContent = store.mode === 'remote'\n      ? '데이터는 구글 시트에 저장됩니다. 백업 불러오기를 하면 백업의 계획·계좌를 적용하고 내역을 시트에 추가합니다.'\n      : '모든 데이터는 이 브라우저에만 저장됩니다. 다른 기기로 옮기거나 백업하려면 내보내기를 사용하세요.';\n    $('#reset-btn').hidden = store.mode === 'remote';\n  }\n\n  function renderAccountRows() {\n    const el = $('#account-rows');\n    const accounts = S().accounts;\n    el.innerHTML = accounts.length\n      ? accounts.map((a) => `\n        <div class=\"acct-row\" data-id=\"${esc(a.id)}\">\n          <input class=\"a-name\" type=\"text\" value=\"${esc(a.name)}\" placeholder=\"${a.type === 'card' ? '예: 신한 체크카드' : '예: 국민 주거래'}\" aria-label=\"이름\">\n          <select class=\"a-type\" aria-label=\"종류\">\n            <option value=\"bank\" ${a.type !== 'card' ? 'selected' : ''}>은행 계좌</option>\n            <option value=\"card\" ${a.type === 'card' ? 'selected' : ''}>카드</option>\n          </select>\n          <input class=\"a-last\" type=\"text\" inputmode=\"numeric\" maxlength=\"4\" value=\"${esc(a.last4)}\" placeholder=\"끝 4자리\" aria-label=\"끝 4자리\">\n          <input class=\"a-bal\" type=\"text\" inputmode=\"numeric\" value=\"${typeof a.balance === 'number' ? a.balance.toLocaleString('ko-KR') : ''}\" placeholder=\"${a.type === 'card' ? '—' : '현재 잔액'}\" ${a.type === 'card' ? 'disabled' : ''} aria-label=\"잔액\">\n          <label class=\"check\"><input type=\"checkbox\" class=\"a-save\" ${a.isSavings ? 'checked' : ''} ${a.type === 'card' ? 'disabled' : ''}>저축</label>\n          <button class=\"link-btn a-del\" aria-label=\"삭제\">✕</button>\n        </div>`).join('')\n      : '<div class=\"empty\">아직 등록한 계좌·카드가 없어요.</div>';\n\n    el.querySelectorAll('.acct-row').forEach((row) => {\n      const a = S().accounts.find((x) => x.id === row.dataset.id);\n      const save = (rerender) => {\n        store.saveMeta();\n        if (rerender) renderAccountRows();\n      };\n      row.querySelector('.a-name').addEventListener('change', (e) => {\n        a.name = e.target.value.trim();\n        save();\n      });\n      row.querySelector('.a-type').addEventListener('change', (e) => {\n        a.type = e.target.value;\n        if (a.type === 'card') Object.assign(a, { balance: null, isSavings: false });\n        save(true);\n      });\n      row.querySelector('.a-last').addEventListener('change', (e) => {\n        a.last4 = e.target.value.replace(/\\D/g, '').slice(-4);\n        e.target.value = a.last4;\n        save();\n      });\n      formatOnBlur(row.querySelector('.a-bal'));\n      row.querySelector('.a-bal').addEventListener('change', (e) => {\n        a.balance = parseAmountInput(e.target.value);\n        a.balanceAt = nowISO();\n        save();\n      });\n      row.querySelector('.a-save').addEventListener('change', (e) => {\n        a.isSavings = e.target.checked;\n        save();\n      });\n      row.querySelector('.a-del').addEventListener('click', () => {\n        if (!confirm(`'${a.name || a.last4}' 을(를) 삭제할까요? 이미 기록된 내역은 그대로 남습니다.`)) return;\n        S().accounts = S().accounts.filter((x) => x.id !== a.id);\n        save(true);\n      });\n    });\n  }\n\n  function addAccount() {\n    S().accounts.push({ id: `a-${uid()}`, name: '', type: 'bank', last4: '', isSavings: false, balance: null, balanceAt: '' });\n    store.saveMeta();\n    renderAccountRows();\n    const names = $$('.acct-row .a-name');\n    names[names.length - 1].focus();\n  }\n\n  function renderAutoCard() {\n    const card = $('#set-auto');\n    if (store.mode === 'remote') {\n      const MODEL_LABEL = { 'claude-opus-5-5': 'Claude Opus 5.5 (기본, 가장 정확)', 'claude-haiku-4-5': 'Claude Haiku 4.5 (저렴, 약 1/4 비용)' };\n      card.innerHTML = `\n        <h2>자동 입력</h2>\n        <h3>Claude AI 분류</h3>\n        <p class=\"small\">${store.aiEnabled ? '<b>켜져 있어요.</b> 알림과 붙여넣은 내역을 AI가 예산 항목에 맞춰 분류합니다.' : '<b>꺼져 있어요.</b> 지금은 키워드로 분류합니다. 아래에 Claude API 키를 넣으면 켜져요. 키는 console.anthropic.com 에서 결제 수단을 등록한 뒤 API Keys 메뉴에서 만들 수 있어요.'}</p>\n        <form id=\"ai-form\" class=\"form-grid\">\n          <label class=\"wide\">Claude API 키<input type=\"password\" id=\"ai-key\" autocomplete=\"off\" placeholder=\"${store.aiEnabled ? '저장됨 (바꾸려면 새 키 입력)' : 'sk-ant-…'}\"></label>\n          <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">확인하고 저장</button></div>\n        </form>\n        ${store.aiEnabled ? `<div class=\"form-grid\" style=\"margin-top:12px\"><label class=\"wide\">사용할 모델<select id=\"ai-model\">${(store.aiModels.length ? store.aiModels : [store.aiModel]).map((m) => `<option value=\"${esc(m)}\" ${m === store.aiModel ? 'selected' : ''}>${esc(MODEL_LABEL[m] || m)}</option>`).join('')}</select></label></div>` : ''}\n        ${store.aiError ? `<p class=\"muted small\">최근 AI 오류: ${esc(store.aiError)}</p>` : ''}\n        <h3>카카오뱅크 문자 자동 입력 (MacroDroid 무료)</h3>\n        <ol class=\"steps\">\n          <li>플레이 스토어에서 <b>MacroDroid</b> 설치 (Pro 7일 체험 안내는 닫기)</li>\n          <li>매크로 추가 → 트리거 <b>전화/SMS → SMS 수신</b> (모든 번호, 내용에 <code>잔액</code> 포함)</li>\n          <li>동작 <b>연결 → HTTP 요청</b>: POST, 아래 주소, 본문 text/plain 에 매직 텍스트 <code>[sms_message]</code></li>\n          <li>저장 후 휴대폰 설정에서 MacroDroid 배터리 <b>제한 없음</b></li>\n        </ol>\n        <div class=\"copy-row\"><input type=\"text\" readonly value=\"${esc(notifyUrl('bank'))}\" id=\"url-bank\"><button class=\"ghost-btn\" data-copy=\"url-bank\">복사</button></div>\n        <p class=\"muted small\">문자가 와도 반응이 없으면 트리거를 <b>알림 수신</b>(메시지 앱, 내용 <code>잔액</code>)으로 바꾸고 본문을 <code>[notification_title] [notification]</code> 로 하세요. 계좌·카드에 카카오뱅크 끝 4자리를 등록해 두면 잔액도 갱신돼요. 자세한 방법은 SETUP.md 6단계에 있어요.</p>\n        <details class=\"small\">\n          <summary>직접 만든 알림 연결 앱 (선택, 보안 차단될 수 있음)</summary>\n          <p class=\"muted\">플레이 스토어 밖 앱이라 삼성 보안 기능이 설치를 막을 수 있어요. 보안 설정을 끄면서까지 쓰는 것은 권하지 않아요. <a href=\"${NOTI_APK_URL}\" target=\"_blank\" rel=\"noopener\">APK 받기</a> · <a href=\"${esc(connectLink())}\" target=\"_blank\" rel=\"noopener\">설치한 앱에 연결</a></p>\n        </details>\n        <div class=\"row-actions\">\n          ${store.server.embedded ? '<button id=\"forget-key-btn\" class=\"ghost-btn small-btn\">이 기기에서 접속 키 지우기</button>' : '<button id=\"disconnect-btn\" class=\"danger-btn\">연결 해제 (이 기기 저장으로)</button>'}\n        </div>`;\n      $('#ai-form').addEventListener('submit', quiet(async (e) => {\n        e.preventDefault();\n        const key = $('#ai-key').value.trim();\n        if (!key && !confirm('API 키를 지우고 AI 분류를 끌까요?')) return;\n        await busy('API 키를 확인하는 중…', () => store.setApiKey(key));\n        toast(store.aiEnabled ? 'AI 분류를 켰어요.' : 'AI 분류를 껐어요.');\n        render();\n      }));\n      const modelSel = $('#ai-model');\n      if (modelSel) modelSel.addEventListener('change', quiet(async () => {\n        await busy(null, () => store.setModel(modelSel.value));\n        toast('모델을 바꿨어요.');\n      }));\n      card.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {\n        const input = $(`#${b.dataset.copy}`);\n        copyText(input.value, input);\n      }));\n      const fk = $('#forget-key-btn');\n      if (fk) fk.addEventListener('click', () => {\n        if (!confirm('이 기기에서 접속 키를 지울까요? 다음에 열 때 다시 입력해야 해요.')) return;\n        store.forgetKey();\n        location.reload();\n      });\n      const dc = $('#disconnect-btn');\n      if (dc) dc.addEventListener('click', () => {\n        if (!confirm('서버 연결을 해제할까요? 구글 시트의 데이터는 그대로 남아 있습니다.')) return;\n        store.disconnect();\n        location.reload();\n      });\n    } else {\n      card.innerHTML = `\n        <h2>자동 입력 (구글 시트 서버 연결)</h2>\n        <p class=\"muted small\">카드 문자·은행 알림 자동 입력과 AI 분류는 구글 시트 서버가 있어야 동작해요. 저장소의 <b>SETUP.md</b> 대로 구글 Apps Script 를 배포한 뒤, 웹앱 주소와 접속 키를 넣으세요. 웹앱 주소로 바로 접속해서 써도 됩니다.</p>\n        <form id=\"connect-form\" class=\"form-grid\">\n          <label class=\"wide\">웹앱 주소<input type=\"url\" id=\"c-url\" placeholder=\"https://script.google.com/macros/s/…/exec\" required></label>\n          <label>접속 키<input type=\"text\" id=\"c-key\" required></label>\n          <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">연결</button></div>\n        </form>`;\n      $('#connect-form').addEventListener('submit', quiet(async (e) => {\n        e.preventDefault();\n        const url = $('#c-url').value.trim().replace(/\\?.*$/, '');\n        const key = $('#c-key').value.trim();\n        await busy('연결 확인 중…', () => store.ping(url, key));\n        const migrate = S().transactions.length > 0 && confirm('이 기기에 있던 계획과 내역을 구글 시트로 옮길까요?');\n        store.connect(url, key, migrate);\n        location.reload();\n      }));\n    }\n  }\n\n  function changeStartDay(newDay) {\n    L.remapPeriodKeys(S(), newDay);\n    currentPeriod = L.getPeriod(L.todayISO(), newDay);\n    store.saveMeta();\n    renderChrome();\n    toast(`이제 매월 ${newDay}일에 새 기간이 시작됩니다.`);\n  }\n\n  // ---------- 백업 ----------\n\n  function exportData() {\n    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: 'application/json' });\n    const a = document.createElement('a');\n    a.href = URL.createObjectURL(blob);\n    a.download = `지출관리-백업-${L.todayISO()}.json`;\n    a.click();\n    setTimeout(() => URL.revokeObjectURL(a.href), 1000);\n  }\n\n  function importData(file) {\n    const reader = new FileReader();\n    reader.onload = quiet(async () => {\n      let parsed;\n      try {\n        parsed = L.normalizeState(JSON.parse(reader.result));\n      } catch (e) {\n        return toast('올바른 백업 파일이 아닙니다.');\n      }\n      const msg = store.mode === 'remote' ? '백업의 계획·계좌를 적용하고 내역을 구글 시트에 추가할까요?' : '현재 데이터를 백업 파일의 내용으로 바꿀까요?';\n      if (!confirm(msg)) return;\n      await busy('불러오는 중…', () => store.importState(parsed));\n      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);\n      toast('백업을 불러왔습니다.');\n      render();\n    });\n    reader.readAsText(file);\n  }\n\n  // ---------- 렌더 & 이벤트 ----------\n\n  function render() {\n    renderChrome();\n    const page = currentPage;\n    if (page === 'home') renderHome();\n    else if (page === 'calendar') renderCalendar();\n    else if (page === 'list') renderList();\n    else if (page === 'report') renderReport();\n    else if (page === 'assets') renderAssets();\n    else if (page === 'plan') renderPlan();\n    else if (page === 'add') renderAdd();\n    else if (page === 'settings') renderSettings();\n  }\n\n  function bindEvents() {\n    $$('.nav-item[data-page], .bottom-nav [data-page]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));\n    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));\n    $$('[data-open-menu]').forEach((b) => b.addEventListener('click', openMenu));\n    $('#menu-btn').addEventListener('click', openMenu);\n    $('#scrim').addEventListener('click', closeMenu);\n    $('#add-btn').addEventListener('click', () => showPage('add'));\n    window.addEventListener('hashchange', () => {\n      const name = location.hash.slice(1);\n      if (PAGES[name] && name !== currentPage) showPage(name, { push: false });\n    });\n    $$('.settings-nav a').forEach((a) => a.addEventListener('click', (e) => {\n      e.preventDefault();\n      $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });\n    }));\n\n    const move = (delta) => {\n      currentPeriod = L.shiftPeriod(currentPeriod, delta, S().settings.startDay);\n      $('#income-box').dataset.editing = '';\n      render();\n    };\n    $('#prev-period').addEventListener('click', () => move(-1));\n    $('#next-period').addEventListener('click', () => move(1));\n    $('#today-period').addEventListener('click', () => {\n      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);\n      selectedDate = null;\n      render();\n    });\n    $('#refresh-btn').addEventListener('click', quiet(async () => {\n      await busy('불러오는 중…', () => store.refresh());\n      render();\n    }));\n\n    // 입력\n    $$('#m-kind button').forEach((b) => b.addEventListener('click', () => {\n      manualKind = b.dataset.kind;\n      renderAdd();\n    }));\n    $('#manual-form').addEventListener('submit', quiet(onManualSubmit));\n    formatOnBlur($('#m-amount'));\n    $('#m-memo').addEventListener('input', updateManualHint);\n    $('#m-category').addEventListener('change', updateManualHint);\n    $('#m-date').addEventListener('change', renderAdd);\n    $('#parse-btn').addEventListener('click', quiet(onParse));\n    $('#paste-clear').addEventListener('click', () => {\n      $('#paste-input').value = '';\n      clearPreview();\n    });\n    $('#file-input').addEventListener('change', quiet(async (e) => {\n      if (e.target.files[0]) await onFileChosen(e.target.files[0]);\n    }));\n\n    // 내역\n    const setFilter = (key, value) => {\n      listState[key] = value;\n      renderList();\n    };\n    $('#list-search').addEventListener('input', (e) => setFilter('search', e.target.value));\n    $('#list-kind').addEventListener('change', (e) => setFilter('kind', e.target.value));\n    $('#list-filter').addEventListener('change', (e) => setFilter('category', e.target.value));\n    $('#list-account').addEventListener('change', (e) => setFilter('account', e.target.value));\n    $('#reclassify-unclassified').addEventListener('click', quiet(() => runReclassify(true)));\n    $('#reclassify-all').addEventListener('click', quiet(() => runReclassify(false)));\n\n    // 예산 계획\n    $('#ratio-base').addEventListener('change', (e) => {\n      editablePlan().ratioBase = e.target.value;\n      store.saveMeta();\n      renderPlanVersion();\n      renderPlanSummary();\n    });\n    $('#add-category').addEventListener('click', addCategory);\n\n    // 설정\n    $('#start-day').addEventListener('change', (e) => changeStartDay(Number(e.target.value)));\n    $('#my-name').addEventListener('change', (e) => {\n      S().settings.myName = e.target.value.trim();\n      store.saveMeta();\n    });\n    $('#add-account').addEventListener('click', addAccount);\n    $('#export-btn').addEventListener('click', exportData);\n    $('#import-file').addEventListener('change', (e) => {\n      if (e.target.files[0]) importData(e.target.files[0]);\n      e.target.value = '';\n    });\n    $('#reset-btn').addEventListener('click', () => {\n      if (!confirm('모든 내역, 수입, 계획, 계좌를 지우고 처음 상태로 되돌릴까요? (되돌릴 수 없습니다)')) return;\n      store.reset();\n      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);\n      toast('초기화했습니다.');\n      render();\n    });\n\n    // 앱을 떠날 때 아직 보내지 않은 변경을 저장하고, 돌아오면 새로 들어온 알림 내역을 불러온다\n    document.addEventListener('visibilitychange', quiet(async () => {\n      if (document.visibilityState === 'hidden') return store.flushMeta();\n      if (store.mode === 'remote' && !busyCount && !store.hasPendingMeta()) {\n        await store.refresh();\n        render();\n      }\n    }));\n  }\n\n  // 구글 웹 앱으로 처음 열었을 때: 접속 키를 한 번 입력받아 이 기기에 기억한다\n  function askKey() {\n    return new Promise((resolve) => {\n      const box = document.createElement('div');\n      box.className = 'key-gate';\n      box.innerHTML = `\n        <form class=\"card key-card\" id=\"key-form\">\n          <h2>접속 키를 입력하세요</h2>\n          <p class=\"muted small\">구글 Apps Script 편집기에서 <b>setup</b> 을 실행하면 실행 기록에 나오는 키예요. 한 번 입력하면 이 기기가 기억해요.</p>\n          <input type=\"password\" id=\"key-input\" autocomplete=\"current-password\" placeholder=\"접속 키\" required>\n          <div class=\"row-actions\"><button type=\"submit\" class=\"primary-btn\">들어가기</button></div>\n          <p class=\"small warn\" id=\"key-error\" hidden></p>\n        </form>`;\n      document.body.appendChild(box);\n      $('#key-input').focus();\n      $('#key-form').addEventListener('submit', async (e) => {\n        e.preventDefault();\n        const err = $('#key-error');\n        err.hidden = true;\n        try {\n          await store.useKey($('#key-input').value.trim());\n          box.remove();\n          resolve();\n        } catch (ex) {\n          err.textContent = /unauthorized/.test(ex.message) ? '키가 맞지 않아요. 다시 확인해 주세요.' : `확인하지 못했어요: ${ex.message}`;\n          err.hidden = false;\n        }\n      });\n    });\n  }\n\n  async function start() {\n    window.__budgetStarted = true;\n    bindEvents();\n    if (store.mode === 'remote' && !store.server.key) await askKey();\n    const toMigrate = store.takeMigration();\n    try {\n      await busy(store.mode === 'remote' ? '불러오는 중…' : null, () => store.init());\n    } catch (e) {\n      $('#category-rows').innerHTML = `<div class=\"empty\">서버에 연결하지 못했습니다. (${esc(e.message || e)})<br>설정 → 자동 입력에서 주소와 키를 확인하세요.</div>`;\n    }\n    if (toMigrate) {\n      await busy('이 기기 데이터를 옮기는 중…', () => store.importState(toMigrate)).catch(() => {});\n      toast('이 기기 데이터를 구글 시트로 옮겼습니다.');\n    }\n    currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);\n    showPage(location.hash.slice(1) || 'home', { push: false });\n  }\n\n  start();\n})();\n</script>\n</body>\n</html>\n";
