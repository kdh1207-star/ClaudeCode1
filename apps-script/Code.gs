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

  // 내역이 계산되는 기간. 실제 날짜는 그대로 두고 periodShift(+1 다음 기간, -1 이전 기간)만큼 옮길 수 있다.
  // (월급이 시작일 하루 전에 들어온 경우 등. 시작일을 바꿔도 몇 기간 옮겼는지만 저장하니 어긋나지 않는다)
  function txPeriod(t, startDay) {
    const p = getPeriod(t.date, startDay);
    const n = Math.trunc(Number(t.periodShift) || 0);
    return n ? shiftPeriod(p, n, startDay) : p;
  }

  function txsInPeriod(state, period) {
    return state.transactions.filter((t) => txPeriod(t, state.settings.startDay).key === period.key);
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

  // ---------- 간편결제 머니 (카카오페이 등) ----------
  // 은행 내역에 '카카오페이'로 찍히는 출금은 페이 머니로 옮긴 돈(충전)이라 지출이 아니다.
  // 실제 지출은 페이 결제내역(그 페이 계정으로 가져온 내역)으로 센다. 금액이 달라도 1:1로 맞출 필요가 없다.
  function payAccountForMemo(memo, accounts) {
    const m = normalizeMerchant(memo);
    if (!m) return null;
    for (const a of accounts || []) {
      if (a.type !== 'pay') continue;
      const key = normalizeMerchant(a.payName || a.name);
      if (key && m.includes(key)) return a;
    }
    return null;
  }

  // 다른 계좌의 내역인데 사용처가 페이 이름이면 '내 계좌 이체'(충전·환급)으로 바꾼다. 바꿨으면 true
  function applyPayRules(item, accounts) {
    if (kindOf(item) === 'transfer') return false;
    const acc = payAccountForMemo(item.memo, accounts);
    if (!acc || item.accountId === acc.id) return false;
    item.kind = 'transfer';
    item.categoryId = null;
    item.method = null;
    return true;
  }

  // 이중 계산 찾기: 페이 결제내역도 들어와 있는데, 다른 계좌의 같은 이름 출금이 아직 지출(또는 입금)로 남은 것.
  // 페이를 '은행 계좌'로 등록해 둔 경우(이름에 페이/pay, 그 계정에 지출이 있음)도 찾아서 종류를 바꾸라고 알려 준다.
  function payDoubleCounts(state) {
    const out = [];
    for (const a of state.accounts) {
      const looksPay = a.type !== 'card' && /페이|pay/i.test(a.name) &&
        state.transactions.some((t) => t.accountId === a.id && kindOf(t) === 'expense');
      if (a.type !== 'pay' && !looksPay) continue;
      const pseudo = { ...a, type: 'pay', payName: a.payName || a.name };
      const txs = state.transactions.filter((t) => applyPayRules({ ...t }, [pseudo]));
      if (txs.length) out.push({ account: a, payName: pseudo.payName, needsType: a.type !== 'pay', txs, total: txs.reduce((s, t) => s + (kindOf(t) === 'expense' ? t.amount : 0), 0) });
    }
    return out;
  }

  // '카카오페이 출금 정리' 버튼용: 정리할 페이 이름과 계정, 바꿀 내역.
  // 간편결제 머니로 등록한 계정이 없으면 이름이 카카오페이인 계정, 그것도 없으면 '카카오페이' 이름만으로 찾는다.
  function payTopupCandidates(state) {
    const acc = state.accounts.find((a) => a.type === 'pay') ||
      state.accounts.find((a) => a.type !== 'card' && /카카오\s*페이/i.test(a.name)) || null;
    const payName = (acc && (acc.payName || acc.name)) || '카카오페이';
    const pseudo = { ...(acc || { id: '__none', name: payName }), type: 'pay', payName };
    const txs = state.transactions.filter((t) => applyPayRules({ ...t }, [pseudo]));
    return { account: acc, payName, needsType: !!acc && acc.type !== 'pay', txs };
  }

  // 기간별 페이 머니 흐름: 충전(다른 계좌에서 옮긴 돈)과 페이 결제내역
  function payFlows(state, period) {
    const txs = txsInPeriod(state, period);
    return state.accounts.filter((a) => a.type === 'pay').map((acc) => {
      let topup = 0;
      let spent = 0;
      let count = 0;
      for (const t of txs) {
        const k = kindOf(t);
        if (t.accountId === acc.id) {
          if (k === 'expense') {
            spent += t.amount;
            count += 1;
          }
        } else if (k === 'transfer' && payAccountForMemo(t.memo, [acc])) {
          topup += t.amount;
        }
      }
      return { account: acc, topup, spent, count };
    });
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
    const cats = planFor(state, txPeriod(t, state.settings.startDay).key).categories;
    return !(t.categoryId && cats.some((c) => c.id === t.categoryId));
  }

  // 기간별 미분류 건수: [{ period, count, total }] 최근 기간부터
  function unclassifiedByPeriod(state) {
    const byKey = new Map();
    for (const t of state.transactions) {
      if (!isUnclassified(state, t)) continue;
      const p = txPeriod(t, state.settings.startDay);
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
      if (period && txPeriod(t, state.settings.startDay).key !== period.key) continue;
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
    ['date', /거래\s*일시|거래\s*일자|거래\s*날짜|(결제|사용|이용|승인)\s*(일시|일자|날짜)|^일시$|^날짜$|^일자$|^거래일$/],
    ['time', /^시간$|거래\s*시간|^시각$/],
    ['category', /거래\s*구분|거래\s*유형|거래\s*종류/],
    ['type', /^구분$|입출금\s*구분|입\s*\/\s*출금|^입출금$/],
    ['out', /출금\s*(액|금액)?$|찾으신\s*금액|지급\s*(액|금액)?$/],
    ['in', /입금\s*(액|금액)?$|맡기신\s*금액/],
    ['amount', /거래\s*금액|(결제|사용|이용|승인)\s*금액|^금액$/],
    ['balance', /잔액/],
    // 카카오페이 등 결제내역: '사용처'(가맹점)가 무엇을 샀는지 알려 주므로 '내용'보다 먼저 쓴다
    ['merchant', /사용처|가맹점|상호|결제처|이용처/],
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

      const merchant = cellText(get(row, 'merchant'));
      const memoMain = cellText(get(row, 'memo'));
      const note = cellText(get(row, 'note'));
      const memo = merchant || memoMain || note || categoryText || typeText || '(내용 없음)';
      const allText = `${typeText} ${categoryText} ${memo} ${memoMain} ${note}`;

      // 카드 결제 취소·환불로 들어온 돈은 지출을 줄이는 것으로 본다
      if (kind === 'income' && /취소|환불/.test(allText)) {
        kind = 'expense';
        amount = -amount;
      }
      if (opts.myName && memo.includes(opts.myName) && !/카드|결제|승인/.test(allText)) kind = 'transfer';
      // 페이 결제내역 파일: 은행에서 채워 넣은 충전은 지출·수입이 아니라 내 계좌 이체
      if (opts.payAccount && /충전/.test(allText) && !/취소|환불/.test(allText)) kind = 'transfer';

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
      type: a.type === 'card' || a.type === 'pay' ? a.type : 'bank',
      last4: digitsOnly(a.last4).slice(-4),
      payName: String(a.payName || ''),
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
    payAccountForMemo,
    applyPayRules,
    payFlows,
    payDoubleCounts,
    payTopupCandidates,
    txPeriod,
    txsInPeriod,
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
var TX_HEADERS = ['id', 'date', 'amount', 'memo', 'categoryId', 'categoryName', 'method', 'source', 'raw', 'createdAt', 'classifiedAt', 'kind', 'accountId', 'periodShift'];
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

    // 페이 앱 알림(source=pay)은 그 페이 머니에서 쓴 것. 충전 알림은 내 계좌 이체
    var payAcc = meta.accounts.filter(function (a) { return a.type === 'pay'; })[0];
    if (source === 'pay' && payAcc) {
      if (!parsed.accountId) parsed.accountId = payAcc.id;
      if (/충전/.test(text) && !/취소|환불/.test(text)) {
        parsed.kind = 'transfer';
        parsed.categoryId = null;
      }
    }
    // 은행 문자에 '카카오페이' 등으로 찍힌 출금은 페이 머니 충전 → 지출이 아니라 내 계좌 이체
    if (BL.applyPayRules(parsed, meta.accounts)) method = null;

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
    var plan = BL.planFor(meta, BL.txPeriod(it, meta.settings.startDay).key);
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
  var periodKey = BL.getPeriod(start, meta.settings.startDay).key;
  var targets = txs.filter(function (t) {
    if (BL.txPeriod(t, meta.settings.startDay).key !== periodKey) return false; // 다른 기간으로 옮긴 내역은 옮긴 기간 기준
    if (BL.kindOf(t) !== 'expense') return false;
    var plan = BL.planFor(meta, periodKey);
    var exists = plan.categories.some(function (c) { return c.id === t.categoryId; });
    if (onlyUnclassified) return !t.categoryId || !exists;
    return !(t.method === 'manual' && exists);
  });
  if (!targets.length) return [];
  var now = nowISO_();
  // 간편결제 머니(카카오페이 등) 충전 출금은 항목을 고르지 않고 내 계좌 이체로 바꾼다
  var moved = targets.filter(function (t) { return BL.applyPayRules(t, meta.accounts); });
  moved.forEach(function (t) { t.classifiedAt = now; });
  var rest = targets.filter(function (t) { return BL.kindOf(t) === 'expense'; });
  var res = rest.length ? classifyItems_(rest, meta) : [];
  rest.forEach(function (t, i) {
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
  ['date', 'amount', 'memo', 'categoryId', 'method', 'kind', 'accountId', 'periodShift'].forEach(function (k) {
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
        periodShift: Math.trunc(Number(r[13]) || 0),
      };
    });
}

function txToRow_(t, meta) {
  var plan = BL.planFor(meta, BL.txPeriod(t, meta.settings.startDay).key);
  var cat = plan.categories.filter(function (c) { return c.id === t.categoryId; })[0];
  var kind = BL.kindOf(t);
  var label = kind === 'income' ? '입금' : kind === 'transfer' ? '내 계좌 이체' : cat ? cat.name : '미분류';
  return [t.id, t.date, t.amount, t.memo, t.categoryId || '', label, t.method || '', t.source || '', t.raw || '', t.createdAt || '', t.classifiedAt || '', kind, t.accountId || '', Math.trunc(Number(t.periodShift) || 0) || ''];
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

var INDEX_HTML = "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <title>내 지출 관리</title>\n  <link href=\"https://fonts.googleapis.com\" rel=\"preconnect\">\n  <link href=\"https://fonts.gstatic.com\" rel=\"preconnect\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,500;6..96,800&family=Cinzel:wght@600;800&family=IBM+Plex+Sans+KR:wght@400;500;700&family=Nanum+Myeongjo:wght@800&display=swap\" rel=\"stylesheet\">\n  <style>\n/* 크롬 나이트: 검정 필름 위 빤딱한 크롬 실버, 은은한 빛 번짐, 넓은 세리프 대문자.\n   일부러 한 가지 모습(어두운 화면)으로 고정한다. */\n:root {\n  color-scheme: dark;\n  --page: #07080a;\n  --surface: #0f1114;\n  --surface-2: #171a1f;\n  --surface-3: #22262d;\n  --text: #eef1f6;\n  --text-2: #b4bac5;\n  --muted: #7d8491;\n  --ink: #eef1f6;\n  --paper: #07080a;\n  --border: rgba(214, 222, 235, 0.14);\n  --edge: rgba(214, 222, 235, 0.32);\n  --accent: #cfd6e2;\n  --accent-track: #1d2128;\n  --accent-soft: #1a1e25;\n  --accent-text: #dfe6f2;\n  --ice: #9fc2ff;\n  --hot: #ff5a6e;\n  --hot-soft: #2a1116;\n  --hi: #ffffff;\n  --good: #7fe0c4;\n  --good-text: #8be6cc;\n  --warning: #f2c46b;\n  --warning-track: #2b2410;\n  --critical: #ff5a6e;\n  --critical-track: #2a1116;\n  --critical-text: #ff8090;\n  --gray-mark: #4a505b;\n  --s1: #e3e8f0; --s2: #8fb8ff; --s3: #c3a8ff; --s4: #7fe0c4; --s5: #ffb0c4; --s6: #f2c46b; --s7: #8a93a3;\n  --chrome: linear-gradient(178deg, #ffffff 0%, #f3f6fa 14%, #9aa2af 30%, #2b2f36 44%, #11141a 48%, #e8ecf2 53%, #ffffff 60%, #9ea6b3 76%, #f4f6fa 90%, #ffffff 100%);\n  --chrome-flat: linear-gradient(180deg, #f7f9fc 0%, #c9cfd9 45%, #8e96a4 55%, #dfe4eb 100%);\n  --glow: 0 0 18px rgba(220, 230, 255, 0.22);\n  --shadow: 0 0 0 1px var(--border), 0 18px 40px -24px rgba(0, 0, 0, 0.9);\n  --sidebar-w: 240px;\n  --font-display: \"Bodoni Moda\", \"Nanum Myeongjo\", serif;\n  --font-caps: \"Cinzel\", \"Nanum Myeongjo\", serif;\n  --font-ko-display: \"Nanum Myeongjo\", \"Bodoni Moda\", serif;\n  --font-body: \"IBM Plex Sans KR\", system-ui, -apple-system, \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif;\n  --font-mono: \"IBM Plex Sans KR\", system-ui, sans-serif;\n  --font-hand: \"Nanum Myeongjo\", serif;\n}\n\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\n\nbody {\n  margin: 0;\n  background: var(--page);\n  color: var(--text);\n  font-family: var(--font-body);\n  font-size: 15px;\n  line-height: 1.5;\n}\n\nh1 { font-size: 20px; margin: 0; }\nh2 { font-size: 16px; margin: 0 0 8px; }\nh3 { font-size: 14px; margin: 16px 0 4px; }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.num { font-variant-numeric: tabular-nums; }\nsvg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n\n/* ---------- 레이아웃 ---------- */\n.app { min-height: 100vh; }\n.sidebar {\n  position: fixed;\n  inset: 0 auto 0 0;\n  width: var(--sidebar-w);\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  display: flex;\n  flex-direction: column;\n  padding: 20px 12px;\n  z-index: 30;\n}\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 0 8px 20px; }\n.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 16px; }\n.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }\n.nav-item {\n  display: flex; align-items: center; gap: 12px;\n  border: 0; background: none; color: var(--text-2);\n  font: inherit; text-align: left; padding: 10px 12px; border-radius: 10px; cursor: pointer;\n}\n.nav-item:hover { background: var(--surface-2); }\n.nav-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }\n.nav-sep { height: 1px; background: var(--border); margin: 8px 12px; }\n.sidebar-foot { padding: 12px 8px 0; }\n\n.main { margin-left: var(--sidebar-w); min-width: 0; }\n.topbar {\n  position: sticky; top: 0; z-index: 20;\n  display: flex; align-items: center; gap: 12px;\n  padding: 14px 28px;\n  background: color-mix(in srgb, var(--page) 88%, transparent);\n  backdrop-filter: blur(8px);\n}\n.topbar h1 { flex: 1; }\n.topbar-actions { display: flex; gap: 8px; align-items: center; }\n.topbar .menu-btn { display: none; }\n.content { max-width: 1040px; padding: 4px 28px 40px; }\n.page { display: none; }\n.page.active { display: block; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }\n.grid-2 > .card { margin-bottom: 16px; }\n\n.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 25; }\n.bottom-nav { display: none; }\n\n@media (max-width: 900px) {\n  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }\n  .sidebar.open { transform: none; }\n  .main { margin-left: 0; }\n  .topbar .menu-btn { display: inline-flex; }\n  .topbar { padding: 10px 16px; }\n  .content { padding: 4px 16px 96px; }\n  .grid-2 { grid-template-columns: 1fr; gap: 0; }\n  .topbar .add-btn { display: none; }\n  .bottom-nav {\n    display: grid; grid-template-columns: repeat(5, 1fr);\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n    background: var(--surface); border-top: 1px solid var(--border);\n    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));\n  }\n  .bottom-nav button {\n    display: flex; flex-direction: column; align-items: center; gap: 2px;\n    border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer;\n  }\n  .bottom-nav button.active { color: var(--accent-text); font-weight: 600; }\n  .bottom-nav .bn-add svg { width: 26px; height: 26px; color: #fff; background: var(--accent); border-radius: 50%; padding: 4px; stroke-width: 2.4; }\n}\n\n/* ---------- 공통 요소 ---------- */\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 18px 20px;\n  margin-bottom: 16px;\n  box-shadow: var(--shadow);\n}\n.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }\n.card-head h2 { margin: 0; }\n.note-card { background: var(--surface-2); box-shadow: none; }\n.note-card p { margin: 4px 0 8px; }\n.warn-card { background: var(--warning-track); border-color: transparent; }\n.card .sub-head { margin-top: 18px; }\n\nbutton, input, select, textarea { font: inherit; color: inherit; }\ninput, select, textarea {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  padding: 9px 11px;\n  min-width: 0;\n}\ninput:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }\ntextarea { width: 100%; resize: vertical; }\nselect.full { width: 100%; }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn {\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  border: 1px solid var(--border); background: var(--surface); white-space: nowrap;\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n.ghost-btn:hover, .icon-btn:hover { background: var(--surface-2); }\n.danger-btn { color: var(--critical-text); }\n.icon-btn { padding: 7px; }\n.small-btn { padding: 6px 11px; font-size: 13px; }\n.link { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }\n.link-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }\n.link-btn:hover { color: var(--critical-text); }\n.file-btn { display: inline-flex; }\n.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }\n.chip { font-size: 12px; border-radius: 999px; padding: 3px 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; display: inline-block; }\n.chip.on { background: var(--accent-soft); color: var(--accent-text); }\n.tag { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }\n.tag.warn { background: var(--warning-track); color: var(--text); }\n.empty { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }\n\n.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }\n.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); }\n.form-grid .wide { grid-column: span 2; }\n.form-submit { display: flex; align-items: end; }\n@media (max-width: 520px) { .form-grid .wide { grid-column: 1 / -1; } }\n\n.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; margin: 4px 0 14px; }\n.segmented button { border: 0; background: none; padding: 7px 14px; border-radius: 8px; cursor: pointer; color: var(--text-2); }\n.segmented button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }\n\n.busy { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -50% 0; } to { background-position: 150% 0; } }\n\n/* ---------- 기간 선택 ---------- */\n.period-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }\n.period-label { display: flex; flex-direction: column; min-width: 0; }\n.period-label strong { font-size: 16px; }\n.period-nav .icon-btn { width: 34px; height: 34px; font-size: 20px; line-height: 1; padding: 0; }\n.period-nav #today-period { margin-left: auto; }\n\n/* ---------- 홈 ---------- */\n.income-prompt { border-color: var(--accent); background: var(--accent-soft); }\n.income-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }\n.income-form input { flex: 1; min-width: 140px; }\n.income-set { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }\n.income-set .value { font-size: 18px; font-weight: 600; }\n\n.hero-card .label { color: var(--text-2); font-size: 14px; }\n.hero-card .figure { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin: 2px 0 4px; }\n.hero-card .figure.negative { color: var(--critical-text); }\n.hero-card .sub { color: var(--text-2); font-size: 14px; }\n.hero-card .meter { margin-top: 14px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 36px; } }\n\n.kv { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--border); gap: 12px; }\n.kv:first-child { border-top: 0; }\n.kv .k { color: var(--text-2); font-size: 14px; }\n.kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }\n.kv .v.plus { color: var(--accent-text); }\n\n/* 항목 행 (미터) */\n.cat-row { padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }\n.cat-row:first-child { border-top: 0; }\n.cat-row:hover .cat-name { text-decoration: underline; }\n.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.cat-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }\n.badge { font-size: 12px; font-weight: 400; color: var(--text-2); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }\n.cat-amounts { font-size: 14px; color: var(--text-2); }\n.cat-amounts b { color: var(--text); }\n.meter { position: relative; height: 10px; border-radius: 4px; background: var(--accent-track); margin: 8px 0 6px; overflow: hidden; }\n.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }\n.meter.warning { background: var(--warning-track); }\n.meter.warning .meter-fill { background: var(--warning); }\n.meter.critical { background: var(--critical-track); }\n.meter.critical .meter-fill { background: var(--critical); }\n.cat-bottom { display: flex; justify-content: space-between; font-size: 13px; gap: 8px; }\n.status { color: var(--text-2); }\n.status.warning { color: var(--text); }\n.status.critical { color: var(--critical-text); font-weight: 600; }\n.remain-good { color: var(--good-text); }\n.remain-bad { color: var(--critical-text); font-weight: 600; }\n.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }\n\n/* 거래 목록 (날짜별 묶음) */\n.tx-date { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 14px 0 4px; border-bottom: 1px solid var(--border); }\n.tx { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n.tx:last-child { border-bottom: 0; }\n.tx-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; }\n.tx-icon.gray { background: var(--gray-mark); }\n.tx-main { min-width: 0; }\n.tx-memo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tx-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }\n.tx-meta select { font-size: 12px; padding: 3px 6px; border-radius: 8px; max-width: 160px; }\n.tx-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n.tx-amount { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.tx-amount.plus { color: var(--accent-text); }\n.tx-amount.neutral { color: var(--muted); font-weight: 600; }\n.list-total { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin: 12px 0 4px; }\n.list-total b { color: var(--text); }\n.filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 8px; }\n@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }\n\n/* ---------- 달력 ---------- */\n.cal-summary { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: var(--text-2); margin-bottom: 12px; }\n.cal-summary b { color: var(--text); font-size: 16px; }\n.cal-summary .plus b { color: var(--accent-text); }\n.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }\n.cal-dow { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0; }\n.cal-dow.sun { color: var(--critical-text); }\n.cal-day {\n  min-height: 74px; border-radius: 10px; padding: 6px; border: 1px solid transparent;\n  display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--surface-2); text-align: left;\n  font: inherit; color: inherit; min-width: 0;\n}\n.cal-day.out { background: none; cursor: default; opacity: 0.35; }\n.cal-day.today .cal-num { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 6px; }\n.cal-day.selected { border-color: var(--accent); }\n.cal-num { font-size: 12px; font-weight: 600; align-self: flex-start; }\n.cal-spent, .cal-income { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n.cal-spent { color: var(--text); }\n.cal-income { color: var(--accent-text); }\n.cal-day.h1 { background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }\n.cal-day.h2 { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }\n.cal-day.h3 { background: color-mix(in srgb, var(--accent) 36%, var(--surface-2)); }\n@media (max-width: 520px) { .cal-day { min-height: 56px; padding: 4px; } .cal-spent, .cal-income { font-size: 10px; } }\n\n/* ---------- 리포트 ---------- */\n.headline-figure { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0; }\n.delta { font-size: 14px; color: var(--text-2); }\n.delta b { color: var(--text); }\n.share-bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 14px; }\n.share-bar span { display: block; height: 100%; min-width: 2px; }\n.share-bar span:first-child { border-radius: 4px 0 0 4px; }\n.share-bar span:last-child { border-radius: 0 4px 4px 0; }\n.share-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.share-row:first-of-type { border-top: 0; }\n.share-name { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.share-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.share-amount { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.share-diff { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }\n.rank { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rank:first-of-type { border-top: 0; }\n.rank .n { color: var(--muted); font-weight: 700; text-align: center; }\n.rank .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rank .a { font-weight: 600; font-variant-numeric: tabular-nums; }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.chart svg { width: 100%; height: auto; display: block; overflow: visible; stroke: none; }\n.chart .grid-line { stroke: var(--border); stroke-width: 1; }\n.chart .axis-label { fill: var(--muted); font-size: 11px; }\n.chart .hit { fill: transparent; cursor: pointer; }\n.chart .hit:hover { fill: color-mix(in srgb, var(--text) 5%, transparent); }\n\n/* ---------- 자산 ---------- */\n.acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--border); }\n.acct:first-child { border-top: 0; }\n.acct-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }\n.acct-icon.is-card { background: var(--surface-2); color: var(--text-2); }\n.acct-name { font-weight: 600; }\n.acct-sub { font-size: 12px; color: var(--muted); }\n.acct-bal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }\n.acct-bal .acct-sub { font-weight: 400; }\n\n/* ---------- 예산 계획 ---------- */\n.plan-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 1.5fr 1.5fr auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.plan-row.head { border-top: 0; font-size: 13px; color: var(--text-2); padding-top: 0; }\n.plan-row input, .plan-row select { width: 100%; }\n.value-wrap { position: relative; }\n.value-wrap input { padding-right: 28px; text-align: right; }\n.value-wrap .unit { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13px; pointer-events: none; }\n.plan-row .preview { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-top: -4px; }\n@media (max-width: 1100px) {\n  .plan-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type value value\" \"desc desc desc\" \"kw kw kw\" \"pv pv pv\"; }\n  .plan-row.head { display: none; }\n  .plan-row .pl-name { grid-area: name; }\n  .plan-row .pl-type { grid-area: type; }\n  .plan-row .value-wrap { grid-area: value; }\n  .plan-row .pl-desc { grid-area: desc; }\n  .plan-row .pl-kw { grid-area: kw; }\n  .plan-row .pl-del { grid-area: del; }\n  .plan-row .preview { grid-area: pv; margin-top: 0; }\n}\n.plan-summary { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--surface-2); font-size: 14px; }\n.warn { color: var(--critical-text); font-weight: 600; }\n\n/* ---------- 설정 ---------- */\n.settings-grid { display: grid; grid-template-columns: 160px 1fr; gap: 20px; align-items: start; }\n.settings-nav { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 2px; }\n.settings-nav a { color: var(--text-2); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 14px; }\n.settings-nav a:hover { background: var(--surface-2); }\n.card[id^=\"set-\"] { scroll-margin-top: 72px; }\n@media (max-width: 900px) {\n  .settings-grid { grid-template-columns: 1fr; gap: 0; }\n  .settings-nav { position: static; flex-direction: row; overflow-x: auto; margin-bottom: 12px; gap: 6px; }\n  .settings-nav a { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }\n}\n.acct-row { display: grid; grid-template-columns: 1.4fr 0.9fr 0.8fr 1fr auto auto; gap: 8px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }\n.acct-row input, .acct-row select { width: 100%; }\n.acct-row .check { display: flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }\n.acct-row .check input { width: auto; }\n@media (max-width: 700px) {\n  .acct-row { grid-template-columns: 1fr 1fr auto; grid-template-areas: \"name name del\" \"type last last\" \"bal bal save\" \"note note note\"; }\n  .acct-row .a-payname { grid-area: last; }\n  .acct-row .acct-note { grid-area: note; }\n  .acct-row .a-name { grid-area: name; }\n  .acct-row .a-type { grid-area: type; }\n  .acct-row .a-last { grid-area: last; }\n  .acct-row .a-bal { grid-area: bal; }\n  .acct-row .check { grid-area: save; }\n  .acct-row .a-del { grid-area: del; }\n}\n.copy-row { display: flex; gap: 8px; margin: 6px 0 12px; }\n.copy-row input { flex: 1; font-size: 13px; }\n.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }\n.steps li { margin: 3px 0; }\n\n/* 표 (붙여넣기 미리보기) */\n.table-wrap { overflow-x: auto; margin-top: 12px; }\ntable { width: 100%; border-collapse: collapse; font-size: 14px; }\nth, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }\nth { font-weight: 600; color: var(--text-2); font-size: 13px; }\ntd.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntd select, td input { width: 100%; padding: 6px 8px; }\ntd.memo { min-width: 120px; word-break: break-all; }\n.refund { color: var(--good-text); }\n@media (max-width: 560px) {\n  .stack-table thead { display: none; }\n  .stack-table tbody tr { display: grid; gap: 6px 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }\n  .stack-table td { border: 0; padding: 0; min-width: 0; }\n  .parse-table tbody tr { grid-template-columns: auto 1fr 1fr auto; grid-template-areas: \"chk memo memo amt\" \". date cat cat\"; }\n  .parse-table td:nth-child(1) { grid-area: chk; }\n  .parse-table td:nth-child(2) { grid-area: date; }\n  .parse-table td:nth-child(3) { grid-area: memo; }\n  .parse-table td:nth-child(4) { grid-area: amt; }\n  .parse-table td:nth-child(5) { grid-area: cat; }\n}\n\n/* 툴팁 & 토스트 */\n.tooltip {\n  position: fixed; z-index: 50; pointer-events: none;\n  background: var(--surface); color: var(--text);\n  border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);\n  border-radius: 10px; padding: 8px 10px; font-size: 13px; max-width: 240px;\n}\n.tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }\n.tooltip .t-row span:first-child { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }\n.toast {\n  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);\n  background: var(--text); color: var(--page);\n  padding: 10px 16px; border-radius: 10px; z-index: 60; font-size: 14px; max-width: calc(100% - 32px);\n}\n@media (max-width: 900px) { .toast { bottom: calc(80px + env(safe-area-inset-bottom)); } }\n\n/* 처음 접속할 때 키 입력 */\n.key-gate { position: fixed; inset: 0; z-index: 70; background: var(--page); display: grid; place-items: center; padding: 16px; }\n.key-card { width: 100%; max-width: 420px; }\n.key-card input { width: 100%; margin-top: 8px; }\n\n.steps a.primary-btn { color: #fff; text-decoration: none; margin: 4px 0; }\n.steps a { color: var(--accent-text); }\ndetails summary { cursor: pointer; color: var(--text-2); margin-top: 8px; }\n\n/* 미분류 정리 */\n.nav-count { margin-left: auto; min-width: 22px; padding: 0 7px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; line-height: 20px; text-align: center; }\n.check-row { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; margin-top: 10px; cursor: pointer; }\n.check-row input { margin-top: 3px; }\n.sort-group { display: flex; flex-direction: column; gap: 10px; }\n.sort-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }\n.sort-memo { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }\n.sort-sum { font-variant-numeric: tabular-nums; white-space: nowrap; }\n.sort-dates { font-size: 13px; color: var(--text-2); }\n.sort-raw { font-size: 13px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }\n.pick-row { display: flex; flex-wrap: wrap; gap: 6px; }\n.pick-btn { border: 1px solid var(--border); background: var(--surface); color: inherit; font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }\n.pick-btn:hover { background: var(--surface-2); }\n.pick-btn .dot { width: 8px; height: 8px; border-radius: 50%; }\n.pick-btn.other { color: var(--text-2); border-style: dashed; }\n.sort-group details summary { font-size: 13px; color: var(--text-2); cursor: pointer; }\n.sort-others { margin-top: 12px; align-items: center; }\n.sort-others:empty { display: none; }\n.rule-rows { margin-top: 12px; display: flex; flex-direction: column; }\n.rule-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }\n.rule-name { font-weight: 600; overflow-wrap: anywhere; }\n.rule-arrow { color: var(--text-2); }\n.tx-meta select.tx-move { max-width: 150px; color: var(--text-2); }\n.acct-note { grid-column: 1 / -1; line-height: 1.5; }\n.paste-acct { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin: 6px 0 10px; max-width: 320px; }\n\n/* =====================================================================\n   CHROME SKIN — 배치는 위 그대로, 겉모습만 덮어쓴다\n   ===================================================================== */\nbody {\n  background-color: var(--page);\n  background-image:\n    url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .13 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\"),\n    url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='900'%3E%3Cg stroke='%23e6ecf7' fill='none'%3E%3Cpath d='M120 0 L126 900' stroke-opacity='.12' stroke-dasharray='40 6 120 3 300 9'/%3E%3Cpath d='M610 0 L604 900' stroke-opacity='.08' stroke-width='.7'/%3E%3Cpath d='M0 330 L900 372' stroke-opacity='.07' stroke-width='.5'/%3E%3Cpath d='M820 0 L690 900' stroke-opacity='.1' stroke-width='.5' stroke-dasharray='200 14 60 8'/%3E%3Cpath d='M38 0 L44 900' stroke-opacity='.06' stroke-dasharray='3 9'/%3E%3C/g%3E%3Cg fill='%23ffffff'%3E%3Crect x='70' y='140' width='2' height='2' opacity='.5'/%3E%3Crect x='72' y='160' width='1' height='6' opacity='.4'/%3E%3Crect x='520' y='80' width='2' height='1' opacity='.45'/%3E%3Crect x='760' y='520' width='3' height='2' opacity='.35'/%3E%3Crect x='300' y='700' width='1' height='9' opacity='.3'/%3E%3Crect x='860' y='260' width='2' height='2' opacity='.5'/%3E%3Crect x='180' y='480' width='1' height='1' opacity='.6'/%3E%3C/g%3E%3C/svg%3E\"),\n    radial-gradient(ellipse 70% 45% at 50% 8%, rgba(175, 195, 235, .18), transparent 70%),\n    radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, .7) 100%);\n  background-size: 240px 240px, 900px 900px, 100% 100%, 100% 100%;\n  background-attachment: fixed;\n}\n::selection { background: #dfe6f2; color: #07080a; }\n.chrome-text, h1, .hero-card .figure, .headline-figure, .brand {\n  background: var(--chrome); -webkit-background-clip: text; background-clip: text; color: transparent;\n  filter: drop-shadow(0 0 1px rgba(255, 255, 255, .9)) drop-shadow(0 0 10px rgba(225, 235, 255, .45)) drop-shadow(0 0 28px rgba(150, 180, 255, .25));\n}\nh1 { font-family: var(--font-ko-display); font-weight: 800; font-size: 32px; letter-spacing: -0.02em; }\nh2 { font-family: var(--font-ko-display); font-weight: 800; font-size: 18px; letter-spacing: -0.01em; color: var(--text); }\nh3 { font-family: var(--font-caps); font-weight: 600; font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-2); margin-top: 22px; }\n:focus-visible { outline: 2px solid #dfe6f2 !important; outline-offset: 2px; }\na { color: var(--ice); }\n.num, .tx-amount, .kv .v, .acct-bal, .share-amount, .rank .a, .cat-amounts, .cal-spent, .cal-income, td.amount, .sort-sum, .list-total { font-variant-numeric: tabular-nums; }\n\n/* 카드: 어두운 유리 + 크롬 테두리 */\n.card {\n  background: linear-gradient(180deg, rgba(25, 28, 34, .92), rgba(12, 14, 17, .92));\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background-clip: padding-box;\n  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px var(--edge), 0 24px 48px -28px rgba(0, 0, 0, .95);\n  padding: 20px;\n  margin-bottom: 18px;\n}\n.card-head h2 { margin: 0; }\n.note-card { background: rgba(15, 17, 20, .6); box-shadow: 0 0 0 1px var(--border); }\n.warn-card { background: linear-gradient(180deg, rgba(60, 20, 28, .9), rgba(30, 10, 14, .9)); box-shadow: 0 0 0 1px rgba(255, 90, 110, .45), 0 0 24px -6px rgba(255, 90, 110, .35); }\n.warn-card b { color: #ffd6dc; }\n\n/* 버튼: 크롬 */\ninput, select, textarea { background: rgba(7, 8, 10, .8); border: 1px solid var(--edge); border-radius: 4px; color: var(--text); }\ninput::placeholder, textarea::placeholder { color: var(--muted); }\ninput:focus, select:focus, textarea:focus { outline: 1px solid #dfe6f2; box-shadow: 0 0 12px rgba(220, 230, 255, .25); }\n.primary-btn, .ghost-btn, .danger-btn, .icon-btn { border-radius: 999px; font-weight: 600; transition: box-shadow .15s ease, transform .15s ease; }\n.primary-btn {\n  background: var(--chrome-flat); color: #0b0d10; border: 1px solid rgba(255, 255, 255, .7);\n  box-shadow: inset 0 1px 0 #fff, inset 0 -2px 4px rgba(0, 0, 0, .25), 0 0 16px rgba(220, 230, 255, .25);\n}\n.primary-btn:hover { box-shadow: inset 0 1px 0 #fff, inset 0 -2px 4px rgba(0, 0, 0, .25), 0 0 26px rgba(220, 230, 255, .45); }\n.ghost-btn, .icon-btn, .danger-btn { background: rgba(255, 255, 255, .03); border: 1px solid var(--edge); color: var(--text); }\n.ghost-btn:hover, .icon-btn:hover { background: rgba(255, 255, 255, .07); box-shadow: 0 0 14px rgba(220, 230, 255, .18); }\n.danger-btn { color: var(--critical-text); border-color: rgba(255, 90, 110, .5); }\n.primary-btn:active, .ghost-btn:active { transform: translateY(1px); }\n.link { color: var(--text); text-decoration: underline; text-decoration-color: var(--edge); text-underline-offset: 3px; }\n.link-btn { color: var(--muted); }\n.chip, .tag, .badge { border-radius: 999px; background: rgba(255, 255, 255, .04); border: 1px solid var(--border); color: var(--text-2); }\n.chip.on { background: var(--chrome-flat); color: #0b0d10; border-color: transparent; }\n.tag.warn { color: var(--critical-text); border-color: rgba(255, 90, 110, .4); }\n.segmented { background: rgba(255, 255, 255, .03); border: 1px solid var(--edge); border-radius: 999px; }\n.segmented button { border-radius: 999px; color: var(--text-2); }\n.segmented button.active { background: var(--chrome-flat); color: #0b0d10; box-shadow: 0 0 12px rgba(220, 230, 255, .25); }\n.empty { font-family: var(--font-caps); letter-spacing: .12em; font-size: 13px; text-transform: uppercase; }\n.busy { height: 2px; background: linear-gradient(90deg, transparent, #fff, transparent); background-size: 40% 100%; background-repeat: no-repeat; box-shadow: 0 0 10px #fff; animation: busy 1s linear infinite; }\n@keyframes busy { from { background-position: -40% 0; } to { background-position: 140% 0; } }\n\n/* 사이드바 */\n.sidebar { background: rgba(5, 6, 8, .96); border-right: 1px solid var(--border); }\n.brand { font-family: var(--font-caps); font-weight: 800; font-size: 19px; letter-spacing: .08em; }\n.brand-mark { background: var(--chrome-flat); color: #0b0d10; border-radius: 50%; box-shadow: 0 0 14px rgba(220, 230, 255, .35); -webkit-text-fill-color: #0b0d10; }\n.nav-item { color: var(--text-2); border-radius: 6px; }\n.nav-item:hover { background: rgba(255, 255, 255, .04); color: var(--text); }\n.nav-item.active { background: rgba(255, 255, 255, .06); color: var(--text); font-weight: 600; box-shadow: inset 2px 0 0 #dfe6f2, 0 0 18px -6px rgba(220, 230, 255, .35); }\n.nav-count { background: var(--chrome-flat); color: #0b0d10; }\n\n/* 머리 */\n.topbar { background: linear-gradient(180deg, rgba(7, 8, 10, .95), rgba(7, 8, 10, .7)); border-bottom: 1px solid var(--border); }\n.period-label strong { font-family: var(--font-caps); font-weight: 600; letter-spacing: .08em; font-size: 15px; }\n.period-label .muted { font-size: 12px; }\n\n/* 히어로: 중앙 정렬 포스터 */\n.hero-card { text-align: center; padding: 34px 8px 30px; position: relative; overflow: visible; background: none; box-shadow: none; }\n.hero-card + .card, #income-box { }\n.hero-card::before {\n  content: \"✦\"; position: absolute; top: 22px; right: 14%; color: #fff; font-size: 22px;\n  text-shadow: 0 0 6px #fff, 0 0 18px #fff, 0 0 34px rgba(200, 220, 255, .9);\n}\n.hero-card::after {\n  content: \"✦\"; position: absolute; top: 46%; left: 9%; color: #fff; font-size: 13px; opacity: .85;\n  text-shadow: 0 0 8px #fff, 0 0 20px rgba(200, 220, 255, .8);\n}\n.hero-card .label { font-family: var(--font-caps); font-weight: 800; font-size: 13px; letter-spacing: .38em; color: #cfd6e2; text-shadow: 0 0 10px rgba(220, 230, 255, .5); }\n.hero-card .figure { font-family: var(--font-display); font-weight: 800; font-size: 76px; line-height: 1; letter-spacing: -0.02em; margin: 14px 0 10px; }\n.hero-card .figure.negative { background: linear-gradient(180deg, #ffd0d6, #ff5a6e 55%, #ffd0d6); -webkit-background-clip: text; background-clip: text; }\n.hero-card .sub { color: var(--text-2); font-size: 13px; }\n.hero-card .meter { margin: 18px auto 0; max-width: 520px; }\n@media (max-width: 520px) { .hero-card .figure { font-size: 54px; } }\n\n/* 막대: 크롬 */\n.meter { height: 8px; border-radius: 999px; background: rgba(255, 255, 255, .06); box-shadow: inset 0 0 0 1px var(--border); overflow: hidden; }\n.meter-fill { border-radius: 999px; background: linear-gradient(180deg, #ffffff 0%, #c4cad4 40%, #5d646f 55%, #e9edf3 75%, #ffffff 100%); box-shadow: 0 0 12px rgba(220, 230, 255, .6); }\n.meter.warning, .meter.critical { background: rgba(255, 255, 255, .06); }\n.meter.warning .meter-fill { background: linear-gradient(180deg, #ffe7b0, #f2c46b 50%, #ffe7b0); box-shadow: 0 0 10px rgba(242, 196, 107, .5); }\n.meter.critical .meter-fill { background: linear-gradient(180deg, #ffd0d6, #ff5a6e 50%, #ffd0d6); box-shadow: 0 0 12px rgba(255, 90, 110, .6); }\n.cat-name { font-weight: 600; }\n.dot { border-radius: 50%; box-shadow: 0 0 6px currentColor; }\n.kv .k { color: var(--text-2); }\n.kv .v.plus, .tx-amount.plus, .cal-income, .cal-summary .plus b { color: var(--ice); }\n.remain-good { color: var(--good-text); }\n.remain-bad, .status.critical, .warn { color: var(--critical-text); }\n\n/* 거래 목록 */\n.tx-icon { border-radius: 50%; color: #0b0d10; font-weight: 700; box-shadow: inset 0 1px 0 rgba(255,255,255,.6), 0 0 10px -2px rgba(220, 230, 255, .35); }\n.tx-icon.gray { background: #2a2f37; color: var(--text-2); }\n.tx-date { font-family: var(--font-caps); font-size: 11px; letter-spacing: .14em; color: var(--text-2); }\n.tx-amount { font-weight: 700; }\n\n/* 달력 */\n.cal-day { background: rgba(255, 255, 255, .025); border: 1px solid var(--border); border-radius: 6px; }\n.cal-day.out { background: none; border-color: transparent; }\n.cal-day.today .cal-num { background: var(--chrome-flat); color: #0b0d10; box-shadow: 0 0 10px rgba(220, 230, 255, .5); }\n.cal-day.selected { border-color: #dfe6f2; box-shadow: 0 0 14px -2px rgba(220, 230, 255, .4); }\n.cal-day.h1 { background: rgba(200, 215, 240, .07); }\n.cal-day.h2 { background: rgba(200, 215, 240, .14); }\n.cal-day.h3 { background: rgba(200, 215, 240, .24); }\n.cal-dow { font-family: var(--font-caps); letter-spacing: .1em; }\n\n/* 리포트·자산·계획·설정 */\n.headline-figure { font-family: var(--font-display); font-weight: 800; font-size: 42px; }\n.share-bar { border-radius: 999px; height: 14px; background: rgba(255, 255, 255, .05); }\n.acct-icon { border-radius: 50%; background: var(--chrome-flat); color: #0b0d10; box-shadow: 0 0 12px -2px rgba(220, 230, 255, .4); }\n.acct-icon.is-card { background: linear-gradient(135deg, #2a2f37, #4a515d); color: var(--text); }\n.plan-summary { background: rgba(255, 255, 255, .03); border: 1px solid var(--border); }\n.settings-nav a { color: var(--text-2); }\n.settings-nav a:hover { color: var(--text); background: rgba(255, 255, 255, .04); }\n@media (max-width: 900px) { .settings-nav a { background: rgba(255, 255, 255, .03); border: 1px solid var(--edge); } }\n.steps { color: var(--text-2); }\n\n/* 미분류 정리 */\n.sort-memo { font-weight: 700; font-size: 18px; }\n.sort-raw { background: rgba(255, 255, 255, .03); border-left: 2px solid #dfe6f2; border-radius: 0 4px 4px 0; }\n.pick-btn { background: rgba(255, 255, 255, .03); border: 1px solid var(--edge); color: var(--text); }\n.pick-btn:hover { background: var(--chrome-flat); color: #0b0d10; box-shadow: 0 0 14px rgba(220, 230, 255, .35); }\n.pick-btn.other { border-style: dashed; color: var(--text-2); }\n\n/* 표 */\nth { font-family: var(--font-caps); font-size: 11px; letter-spacing: .12em; color: var(--text-2); }\n\n/* 툴팁·토스트 */\n.tooltip { background: rgba(10, 12, 15, .96); border: 1px solid var(--edge); box-shadow: 0 0 18px rgba(0, 0, 0, .6); }\n.toast { background: var(--chrome-flat); color: #0b0d10; border-radius: 999px; font-weight: 600; box-shadow: 0 0 24px rgba(220, 230, 255, .35); }\n.key-gate { background: var(--page); }\n\n/* 하단 메뉴 (폰) */\n@media (max-width: 900px) {\n  .bottom-nav { background: rgba(5, 6, 8, .96); border-top: 1px solid var(--border); backdrop-filter: blur(10px); }\n  .bottom-nav button { color: var(--muted); }\n  .bottom-nav button.active { color: var(--text); text-shadow: 0 0 10px rgba(220, 230, 255, .6); }\n  .bottom-nav .bn-add svg { background: var(--chrome-flat); color: #0b0d10; box-shadow: 0 0 16px rgba(220, 230, 255, .45); }\n  .sidebar { box-shadow: none; }\n}\n\n/* 설명 문구 접기 (ⓘ) */\n.hint-toggle {\n  display: inline-grid; place-items: center; width: 20px; height: 20px; margin-left: 8px; vertical-align: middle;\n  border: 1px solid var(--edge); border-radius: 50%; background: transparent; color: var(--text-2);\n  font-family: var(--font-caps); font-size: 11px; font-weight: 800; cursor: pointer; padding: 0;\n}\n.hint-toggle[aria-expanded=\"true\"] { background: var(--chrome-flat); color: #0b0d10; }\np.hint-collapsed { display: none; }\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { transition: none !important; animation: none !important; }\n}\n</style>\n</head>\n<body>\n  <noscript>\n    <div style=\"padding:16px;margin:12px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif\">\n      이 화면에서는 앱의 기능(자바스크립트)이 실행되지 않아요. 파일 앱의 <b>미리보기</b>가 아니라 <b>크롬·삼성 인터넷·사파리</b> 같은 브라우저로 열어 주세요.\n    </div>\n  </noscript>\n  <div id=\"boot-error\" hidden style=\"position:fixed;left:12px;right:12px;top:12px;z-index:100;padding:16px;border-radius:12px;background:#fde8b8;color:#0b0b0b;font:15px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)\"></div>\n  <script>\n    // 앱이 시작되지 못하면 이유를 화면에 보여준다. (오래된 브라우저에서도 돌아가도록 옛 문법으로 작성)\n    (function () {\n      var shown = false;\n      function show(msg) {\n        if (shown) return;\n        shown = true;\n        var el = document.getElementById('boot-error');\n        el.innerHTML = '<b>앱을 시작하지 못했어요.</b><br>브라우저가 오래됐거나 미리보기 화면일 수 있어요. 최신 크롬·삼성 인터넷·사파리로 열어 보고, 그래도 안 되면 이 화면을 캡처해서 알려 주세요.' +\n          '<div style=\"margin-top:8px;font-size:12px;color:#52514e;word-break:break-all\">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent.replace(/</g, '&lt;') + '</div>';\n        el.hidden = false;\n        el.style.display = 'block';\n      }\n      window.addEventListener('error', function (e) {\n        if (window.__budgetStarted) return;\n        var where = window.__budgetCurrent || e.filename || '';\n        show((e.message || '알 수 없는 오류') + (where ? ' @ ' + where + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : ''));\n      });\n      // 구글 웹 앱용 빌드에서는 기능 코드를 base64 로 감싸 보낸다. 전달 과정에서 코드 글자가 바뀌어도 깨지지 않게 하려는 것.\n      window.__budgetRun = function (name, b64) {\n        window.__budgetCurrent = name;\n        try {\n          var bin = atob(b64);\n          var bytes = new Uint8Array(bin.length);\n          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n          var el = document.createElement('script');\n          el.text = new TextDecoder('utf-8').decode(bytes);\n          document.body.appendChild(el);\n        } catch (err) {\n          show(name + ': ' + (err && err.message));\n        }\n        window.__budgetCurrent = '';\n      };\n      window.addEventListener('load', function () {\n        setTimeout(function () {\n          if (!window.__budgetStarted) show('기능 코드가 실행되지 않았습니다.');\n        }, 3000);\n      });\n    })();\n  </script>\n  <div id=\"busy\" class=\"busy\" hidden></div>\n\n  <div class=\"app\">\n    <!-- 메뉴 -->\n    <aside class=\"sidebar\" id=\"sidebar\" aria-label=\"메뉴\">\n      <div class=\"brand\">\n        <span class=\"brand-mark\" aria-hidden=\"true\">₩</span>\n        <span>내 지출 관리</span>\n      </div>\n      <nav class=\"nav\" id=\"nav\">\n        <button class=\"nav-item\" data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n        <button class=\"nav-item\" data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n        <button class=\"nav-item\" data-page=\"list\"><svg viewBox=\"0 0 24 24\"><path d=\"M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01\"/></svg>내역</button>\n        <button class=\"nav-item\" data-page=\"sort\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 5h16l-6 7.5V19l-4 1.5v-8z\"/></svg>미분류 정리<span id=\"sort-count\" class=\"nav-count\" hidden></span></button>\n        <button class=\"nav-item\" data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n        <button class=\"nav-item\" data-page=\"assets\"><svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M16 14.5h2\"/></svg>자산</button>\n        <button class=\"nav-item\" data-page=\"plan\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/></svg>예산 계획</button>\n        <div class=\"nav-sep\"></div>\n        <button class=\"nav-item\" data-page=\"add\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>지출·수입 입력</button>\n        <button class=\"nav-item\" data-page=\"settings\"><svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3\"/></svg>설정</button>\n      </nav>\n      <div class=\"sidebar-foot\">\n        <span id=\"conn-status\" class=\"chip\"></span>\n      </div>\n    </aside>\n    <div class=\"scrim\" id=\"scrim\" hidden></div>\n\n    <div class=\"main\">\n      <header class=\"topbar\">\n        <button id=\"menu-btn\" class=\"icon-btn menu-btn\" aria-label=\"메뉴 열기\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg></button>\n        <h1 id=\"page-title\">홈</h1>\n        <div class=\"topbar-actions\">\n          <button id=\"refresh-btn\" class=\"icon-btn\" aria-label=\"새로고침\" hidden><svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5\"/></svg></button>\n          <button id=\"add-btn\" class=\"primary-btn add-btn\">+ 입력</button>\n        </div>\n      </header>\n\n      <div class=\"content\">\n        <div class=\"period-nav\" id=\"period-nav\">\n          <button id=\"prev-period\" class=\"icon-btn\" aria-label=\"이전 기간\">‹</button>\n          <div class=\"period-label\">\n            <strong id=\"period-text\"></strong>\n            <span id=\"period-sub\" class=\"muted small\"></span>\n          </div>\n          <button id=\"next-period\" class=\"icon-btn\" aria-label=\"다음 기간\">›</button>\n          <button id=\"today-period\" class=\"ghost-btn small-btn\">오늘</button>\n        </div>\n\n        <!-- 홈 -->\n        <section class=\"page\" data-page=\"home\">\n          <div id=\"income-box\" class=\"card\"></div>\n          <div id=\"stale-box\"></div>\n          <div id=\"fixed-box\"></div>\n          <div id=\"pay-box\"></div>\n          <div class=\"grid-2\">\n            <div class=\"card hero-card\" id=\"hero\"></div>\n            <div class=\"card\" id=\"home-summary\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 예산</h2>\n              <span id=\"alloc-note\" class=\"muted small\"></span>\n            </div>\n            <div id=\"category-rows\"></div>\n          </div>\n          <div class=\"grid-2\">\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>최근 내역</h2><button class=\"link\" data-goto=\"list\">전체 보기</button></div>\n              <div id=\"recent-list\"></div>\n            </div>\n            <div class=\"card\">\n              <div class=\"card-head\"><h2>자산</h2><button class=\"link\" data-goto=\"assets\">자세히</button></div>\n              <div id=\"home-assets\"></div>\n            </div>\n          </div>\n        </section>\n\n        <!-- 달력 -->\n        <section class=\"page\" data-page=\"calendar\">\n          <div class=\"card\">\n            <div id=\"cal-summary\" class=\"cal-summary\"></div>\n            <div id=\"calendar\" class=\"calendar\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"day-title\"></h2><span id=\"day-total\" class=\"muted small\"></span></div>\n            <div id=\"day-list\"></div>\n          </div>\n        </section>\n\n        <!-- 내역 -->\n        <section class=\"page\" data-page=\"list\">\n          <div class=\"card\">\n            <div class=\"filters\">\n              <input type=\"search\" id=\"list-search\" placeholder=\"사용처 검색\" aria-label=\"사용처 검색\">\n              <select id=\"list-kind\" aria-label=\"종류\">\n                <option value=\"all\">모든 종류</option>\n                <option value=\"expense\">지출</option>\n                <option value=\"income\">입금</option>\n                <option value=\"transfer\">내 계좌 이체</option>\n              </select>\n              <select id=\"list-filter\" aria-label=\"항목\"></select>\n              <select id=\"list-account\" aria-label=\"결제수단\"></select>\n            </div>\n            <div class=\"row-actions\">\n              <button id=\"reclassify-unclassified\" class=\"ghost-btn small-btn\">미분류만 다시 분류</button>\n              <button id=\"reclassify-all\" class=\"ghost-btn small-btn\">이 기간 전체 다시 분류</button>\n              <button id=\"pay-topups\" class=\"ghost-btn small-btn\">카카오페이 출금 → 내 계좌 이체</button>\n            </div>\n            <div id=\"list-total\" class=\"list-total\"></div>\n            <div id=\"tx-list\"></div>\n            <p class=\"muted small\">항목을 바꾸면 그 내역 하나만 바뀌어요. 같은 사용처를 항상 같은 항목으로 넣으려면 설정 → 자동 분류 규칙에서 규칙을 만드세요.</p>\n          </div>\n        </section>\n\n        <!-- 리포트 -->\n        <section class=\"page\" data-page=\"report\">\n          <div class=\"grid-2\">\n            <div class=\"card\" id=\"report-headline\"></div>\n            <div class=\"card\" id=\"report-merchants\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>어디에 썼나요</h2><span class=\"muted small\">이번 기간 지출 구성</span></div>\n            <div id=\"report-share\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>기간별 추이</h2><span class=\"muted small\">최근 6개 기간</span></div>\n            <div id=\"report-trend\"></div>\n          </div>\n        </section>\n\n        <!-- 자산 -->\n        <section class=\"page\" data-page=\"assets\">\n          <div class=\"card hero-card\" id=\"asset-hero\"></div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>계좌</h2><button class=\"link\" data-goto=\"settings\">계좌 관리</button></div>\n            <div id=\"asset-banks\"></div>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\"><h2>카드</h2><span class=\"muted small\">이번 기간 사용액</span></div>\n            <div id=\"asset-cards\"></div>\n          </div>\n        </section>\n\n        <!-- 미분류 정리 -->\n        <section class=\"page\" data-page=\"sort\">\n          <div class=\"card\">\n            <div class=\"card-head\"><h2 id=\"sort-title\">미분류 정리</h2><span id=\"sort-total\" class=\"muted small\"></span></div>\n            <p class=\"muted small\">위에서 고른 기간에 AI나 키워드가 항목을 정하지 못한 지출이에요. 같은 가맹점·상대에게 쓴 것끼리 묶었으니, 알맞은 항목을 누르면 묶음 전체가 그 항목으로 들어가요.</p>\n            <label class=\"check-row\"><input type=\"checkbox\" id=\"sort-learn\"> 고를 때 자동 분류 규칙도 만들기 (같은 가맹점·상대는 앞으로 항상 이 항목으로)</label>\n            <div id=\"sort-others\" class=\"pick-row sort-others\"></div>\n          </div>\n          <div id=\"sort-groups\"></div>\n        </section>\n\n        <!-- 예산 계획 -->\n        <section class=\"page\" data-page=\"plan\">\n          <div id=\"plan-version\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>비율 항목의 기준 금액</h2>\n            <select id=\"ratio-base\" class=\"full\">\n              <option value=\"afterFixed\">수입에서 고정 항목을 뺀 나머지</option>\n              <option value=\"income\">전체 수입</option>\n            </select>\n            <h2 class=\"sub-head\">고정 항목 합계가 수입보다 클 때</h2>\n            <select id=\"fixed-overflow\" class=\"full\">\n              <option value=\"warn\">그대로 두고 알려 주기</option>\n              <option value=\"scale\">수입에 맞게 비율대로 줄이기</option>\n            </select>\n            <p class=\"muted small\">줄이기를 고르면 고정 항목끼리의 비율은 그대로 두고, 합계가 그 기간 수입과 같아지도록 한도를 낮춥니다. 예: 월세 60만·통신 10만(합 70만)인데 수입이 56만이면 월세 48만·통신 8만.</p>\n          </div>\n          <div class=\"card\">\n            <div class=\"card-head\">\n              <h2>항목별 배분</h2>\n              <button id=\"add-category\" class=\"ghost-btn small-btn\">+ 항목 추가</button>\n            </div>\n            <p class=\"muted small\"><b>수입 비례(%)</b>: 그 기간에 들어온 돈에 비례해 한도가 정해집니다. <b>고정 금액</b>: 수입과 상관없이 매 기간 같은 한도입니다.<br><b>설명</b>은 AI가 지출을 분류할 때 참고합니다. 예: \"외식, 배달, 장보기\". <b>키워드</b>는 쉼표로 구분하며, AI를 쓸 수 없을 때 사용처에 키워드가 들어 있으면 그 항목으로 분류합니다.</p>\n            <div id=\"plan-rows\"></div>\n            <div id=\"plan-summary\" class=\"plan-summary\"></div>\n          </div>\n        </section>\n\n        <!-- 입력 -->\n        <section class=\"page\" data-page=\"add\">\n          <div id=\"auto-hint\" class=\"card note-card\"></div>\n          <div class=\"card\">\n            <h2>직접 입력</h2>\n            <div class=\"segmented\" id=\"m-kind\" role=\"radiogroup\" aria-label=\"종류\">\n              <button type=\"button\" data-kind=\"expense\" class=\"active\">지출</button>\n              <button type=\"button\" data-kind=\"income\">입금</button>\n              <button type=\"button\" data-kind=\"transfer\">내 계좌 이체</button>\n            </div>\n            <form id=\"manual-form\" class=\"form-grid\">\n              <label>날짜<input type=\"date\" id=\"m-date\" required></label>\n              <label>금액(원)<input type=\"text\" inputmode=\"numeric\" id=\"m-amount\" placeholder=\"12,000\" required></label>\n              <label class=\"wide\">사용처 / 메모<input type=\"text\" id=\"m-memo\" placeholder=\"스타벅스 강남점\"></label>\n              <label id=\"m-category-wrap\">항목<select id=\"m-category\"></select></label>\n              <label>결제수단<select id=\"m-account\"></select></label>\n              <div class=\"form-submit\"><button type=\"submit\" class=\"primary-btn\">추가</button></div>\n            </form>\n            <p id=\"m-hint\" class=\"muted small\"></p>\n          </div>\n          <div class=\"card\">\n            <h2>내역 붙여넣기</h2>\n            <p class=\"muted small\">카드 승인 문자, 은행/카드 앱 내역, 엑셀에서 복사한 표를 그대로 붙여넣으세요. 한 줄에 한 건씩 날짜·금액·사용처를 읽고 <span id=\"classifier-name\">항목</span>을 자동으로 정합니다.</p>\n            <label class=\"paste-acct\">결제수단<select id=\"paste-account\"></select></label>\n            <textarea id=\"paste-input\" rows=\"6\" placeholder=\"예)&#10;2026-09-27 배달의민족 23,500원&#10;9월 25일 카카오T 택시 8,400원&#10;09/24 올리브영 강남점 32,000원\"></textarea>\n            <div class=\"row-actions\">\n              <button id=\"parse-btn\" class=\"primary-btn\">인식하기</button>\n              <button id=\"paste-clear\" class=\"ghost-btn\">지우기</button>\n            </div>\n            <div id=\"parse-result\"></div>\n          </div>\n          <div class=\"card\">\n            <h2>거래내역 파일 가져오기 (은행·카카오페이)</h2>\n            <p class=\"muted small\">카카오뱅크: 앱에서 계좌 선택 → 오른쪽 위 설정(톱니바퀴) → <b>거래내역</b> → 이메일과 기간을 넣고 받기. 메일로 온 엑셀(.xlsx)이나 CSV 파일을 그대로 올리세요. 다른 은행 파일도 날짜·금액 칸이 있으면 읽습니다. 알림으로 이미 들어온 내역은 <b>중복?</b>으로 표시하고 빼 둡니다.</p>\n            <div class=\"form-grid\">\n              <label>어느 계좌·페이의 내역인가요<select id=\"file-account\"></select></label>\n              <label>파일<input type=\"file\" id=\"file-input\" accept=\".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"></label>\n            </div>\n            <div id=\"file-result\"></div>\n          </div>\n        </section>\n\n        <!-- 설정 -->\n        <section class=\"page\" data-page=\"settings\">\n          <div class=\"settings-grid\">\n            <nav class=\"settings-nav\" aria-label=\"설정 메뉴\">\n              <a href=\"#set-basic\">기본</a>\n              <a href=\"#set-accounts\">계좌·카드</a>\n              <a href=\"#set-rules\">자동 분류 규칙</a>\n              <a href=\"#set-auto\">자동 입력</a>\n              <a href=\"#set-data\">데이터</a>\n            </nav>\n            <div>\n              <div class=\"card\" id=\"set-basic\">\n                <h2>기본</h2>\n                <div class=\"form-grid\">\n                  <label>매 기간 시작일\n                    <select id=\"start-day\"></select>\n                  </label>\n                  <label>내 이름\n                    <input type=\"text\" id=\"my-name\" placeholder=\"홍길동\" autocomplete=\"name\">\n                  </label>\n                </div>\n                <p class=\"muted small\">기간: 예를 들어 25일로 하면 9/25 ~ 10/24 가 한 기간입니다. 없는 날짜(31일 등)는 그 달의 말일로 계산합니다.<br>내 이름: 이체 알림의 상대방이 내 이름이면 내 계좌끼리 옮긴 돈으로 보고 지출에서 뺍니다.</p>\n              </div>\n\n              <div class=\"card\" id=\"set-accounts\">\n                <div class=\"card-head\"><h2>계좌·카드</h2><button id=\"add-account\" class=\"ghost-btn small-btn\">+ 추가</button></div>\n                <p class=\"muted small\">번호는 <b>끝 4자리</b>만 넣으세요. 알림에 적힌 번호로 어느 계좌·카드의 거래인지 찾고, 은행 알림의 잔액으로 계좌 잔액을 자동으로 갱신합니다. <b>저축 계좌</b>로 옮긴 돈은 저축 항목 지출로 기록합니다.</p>\n                <div id=\"account-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-rules\">\n                <h2>자동 분류 규칙</h2>\n                <p class=\"muted small\">여기 적은 가맹점·상대는 AI보다 먼저, 항상 정한 항목으로 분류합니다. 내역에서 항목을 바꾸는 건 그 내역 하나에만 적용되고 규칙을 만들지 않아요. 같은 사람에게 여러 용도로 보내는 경우엔 규칙을 만들지 마세요.</p>\n                <form id=\"rule-form\" class=\"form-grid\">\n                  <label>가맹점·상대 이름<input type=\"text\" id=\"rule-name\" placeholder=\"예: 스타벅스, 집주인\" autocomplete=\"off\"></label>\n                  <label>항목<select id=\"rule-cat\"></select></label>\n                  <div class=\"form-submit\"><button type=\"submit\" class=\"ghost-btn\">규칙 추가</button></div>\n                </form>\n                <div id=\"rule-rows\" class=\"rule-rows\"></div>\n              </div>\n\n              <div class=\"card\" id=\"set-auto\"></div>\n\n              <div class=\"card\" id=\"set-data\">\n                <h2>데이터</h2>\n                <p id=\"data-note\" class=\"muted small\"></p>\n                <p class=\"muted small\">앱 버전 <code id=\"build-id\">0f3ac72</code></p>\n                <div class=\"row-actions\">\n                  <button id=\"export-btn\" class=\"ghost-btn\">백업 내보내기(JSON)</button>\n                  <label class=\"ghost-btn file-btn\">백업 불러오기<input type=\"file\" id=\"import-file\" accept=\"application/json,.json\" hidden></label>\n                  <button id=\"reset-btn\" class=\"danger-btn\">전체 초기화</button>\n                </div>\n              </div>\n            </div>\n          </div>\n        </section>\n      </div>\n    </div>\n\n    <!-- 휴대폰 하단 메뉴 -->\n    <nav class=\"bottom-nav\" aria-label=\"빠른 메뉴\">\n      <button data-page=\"home\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/></svg>홈</button>\n      <button data-page=\"calendar\"><svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></svg>달력</button>\n      <button data-page=\"add\" class=\"bn-add\" aria-label=\"입력\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button data-page=\"report\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>리포트</button>\n      <button data-open-menu><svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></svg>전체</button>\n    </nav>\n  </div>\n\n  <div id=\"tooltip\" class=\"tooltip\" role=\"tooltip\" hidden></div>\n  <div id=\"toast\" class=\"toast\" hidden></div>\n\n  <script>/*__SERVER_CONFIG__*/</script>\n  <script>__budgetRun(\"js/logic.js\", \"LyoKICog7KeA7LacIOq0gOumrCDslbHsnZgg7Iic7IiYIOuhnOyngSAoRE9NIOyXhuydjCkuCiAqIOu4jOudvOyasOyggOyXkOyEnOuKlCB3aW5kb3cuQnVkZ2V0TG9naWMg7Jy866GcLCBOb2RlKO2FjOyKpO2KuCnsl5DshJzripQgcmVxdWlyZSDroZwg7IKs7Jqp7ZWc64ukLgogKiDrgqDsp5zripQg66qo65GQICdZWVlZLU1NLUREJyDrrLjsnpDsl7TroZwg64uk66Os64ukICjsi5zqsITrjIAg66y47KCcIO2ajO2UvCkuCiAqLwooZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHsKICBjb25zdCBhcGkgPSBmYWN0b3J5KCk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICBlbHNlIHJvb3QuQnVkZ2V0TG9naWMgPSBhcGk7Cn0pKHR5cGVvZiBnbG9iYWxUaGlzICE9PSAndW5kZWZpbmVkJyA/IGdsb2JhbFRoaXMgOiB0aGlzLCBmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICAvLyAtLS0tLS0tLS0tIOuCoOynnCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHBhZChuKSB7CiAgICByZXR1cm4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgfQoKICBmdW5jdGlvbiB0b0lTTyh5LCBtLCBkKSB7CiAgICByZXR1cm4gYCR7eX0tJHtwYWQobSl9LSR7cGFkKGQpfWA7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUlTTyhzKSB7CiAgICBjb25zdCBbeSwgbSwgZF0gPSBzLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyB5LCBtLCBkIH07CiAgfQoKICBmdW5jdGlvbiBkYXlzSW5Nb250aCh5LCBtKSB7CiAgICByZXR1cm4gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSwgMCkpLmdldFVUQ0RhdGUoKTsKICB9CgogIGZ1bmN0aW9uIGFkZE1vbnRocyh5LCBtLCBkZWx0YSkgewogICAgY29uc3QgaWR4ID0geSAqIDEyICsgKG0gLSAxKSArIGRlbHRhOwogICAgcmV0dXJuIHsgeTogTWF0aC5mbG9vcihpZHggLyAxMiksIG06IChpZHggJSAxMikgKyAxIH07CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGlzbywgZGVsdGEpIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gcGFyc2VJU08oaXNvKTsKICAgIGNvbnN0IGR0ID0gbmV3IERhdGUoRGF0ZS5VVEMoeSwgbSAtIDEsIGQgKyBkZWx0YSkpOwogICAgcmV0dXJuIHRvSVNPKGR0LmdldFVUQ0Z1bGxZZWFyKCksIGR0LmdldFVUQ01vbnRoKCkgKyAxLCBkdC5nZXRVVENEYXRlKCkpOwogIH0KCiAgZnVuY3Rpb24gZGlmZkRheXMoYSwgYikgewogICAgY29uc3QgcGEgPSBwYXJzZUlTTyhhKTsKICAgIGNvbnN0IHBiID0gcGFyc2VJU08oYik7CiAgICByZXR1cm4gTWF0aC5yb3VuZCgoRGF0ZS5VVEMocGIueSwgcGIubSAtIDEsIHBiLmQpIC0gRGF0ZS5VVEMocGEueSwgcGEubSAtIDEsIHBhLmQpKSAvIDg2NDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHRvZGF5SVNPKG5vdyA9IG5ldyBEYXRlKCkpIHsKICAgIHJldHVybiB0b0lTTyhub3cuZ2V0RnVsbFllYXIoKSwgbm93LmdldE1vbnRoKCkgKyAxLCBub3cuZ2V0RGF0ZSgpKTsKICB9CgogIC8vIOyLnOyekeydvOydtCDtlbTri7kg7JuU7JeQIOyXhuycvOuptCjsmIg6IDMx7J28KSDqt7gg64us7J2YIOunkOydvOuhnCDrp57stpjri6QuCiAgZnVuY3Rpb24gcGVyaW9kU3RhcnRJbk1vbnRoKHksIG0sIHN0YXJ0RGF5KSB7CiAgICByZXR1cm4gdG9JU08oeSwgbSwgTWF0aC5taW4oc3RhcnREYXksIGRheXNJbk1vbnRoKHksIG0pKSk7CiAgfQoKICBmdW5jdGlvbiBnZXRQZXJpb2QoZGF0ZUlTTywgc3RhcnREYXkpIHsKICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oZGF0ZUlTTyk7CiAgICBsZXQgc3RhcnQgPSBwZXJpb2RTdGFydEluTW9udGgoeSwgbSwgc3RhcnREYXkpOwogICAgbGV0IHN5ID0geTsKICAgIGxldCBzbSA9IG07CiAgICBpZiAoZGF0ZUlTTyA8IHN0YXJ0KSB7CiAgICAgICh7IHk6IHN5LCBtOiBzbSB9ID0gYWRkTW9udGhzKHksIG0sIC0xKSk7CiAgICAgIHN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKHN5LCBzbSwgc3RhcnREYXkpOwogICAgfQogICAgY29uc3QgbmV4dCA9IGFkZE1vbnRocyhzeSwgc20sIDEpOwogICAgY29uc3QgbmV4dFN0YXJ0ID0gcGVyaW9kU3RhcnRJbk1vbnRoKG5leHQueSwgbmV4dC5tLCBzdGFydERheSk7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKG5leHRTdGFydCwgLTEpLCBrZXk6IHN0YXJ0IH07CiAgfQoKICBmdW5jdGlvbiBzaGlmdFBlcmlvZChwZXJpb2QsIGRlbHRhLCBzdGFydERheSkgewogICAgY29uc3QgeyB5LCBtIH0gPSBwYXJzZUlTTyhwZXJpb2Quc3RhcnQpOwogICAgY29uc3QgdCA9IGFkZE1vbnRocyh5LCBtLCBkZWx0YSk7CiAgICByZXR1cm4gZ2V0UGVyaW9kKHBlcmlvZFN0YXJ0SW5Nb250aCh0LnksIHQubSwgc3RhcnREYXkpLCBzdGFydERheSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4TsgrAgLS0tLS0tLS0tLQoKICAvKgogICAqIGNhdGVnb3JpZXM6IFt7IGlkLCBuYW1lLCB0eXBlOiAncmF0aW8nIHwgJ2ZpeGVkJywgdmFsdWUgfV0KICAgKiAgIHJhdGlvIOKGkiB2YWx1ZSDripQg7Y287IS87Yq4LCBmaXhlZCDihpIgdmFsdWUg64qUIOybkCDri6jsnIQg6riI7JWhCiAgICogcmF0aW9CYXNlOiAnaW5jb21lJyAgICAg4oaSIOu5hOycqCDtla3rqqnsnYAg7KCE7LK0IOyImOyehSDquLDspIAKICAgKiAgICAgICAgICAgICdhZnRlckZpeGVkJyDihpIg67mE7JyoIO2VreuqqeydgCAo7IiY7J6FIC0g6rOg7KCVIO2VreuqqSDtlanqs4QpIOq4sOykgAogICAqIGZpeGVkT3ZlcmZsb3c6IOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOyImOyeheuztOuLpCDtgbQg65WMCiAgICogICAgICAgICAgICAnd2FybicgIOKGkiDsoJXtlZwg6riI7JWhIOq3uOuMgOuhnCDrkZDqs6Ag7ZmU66m07JeQ7IScIOyVjOumsOuLpCAo6riw67O4KQogICAqICAgICAgICAgICAgJ3NjYWxlJyDihpIg6rOg7KCVIO2VreuqqeuBvOumrOydmCDruYTsnKjsnYQg7Jyg7KeA7ZWcIOyxhCDtlanqs4TqsIAg7IiY7J6F6rO8IOqwmeyVhOyngOuPhOuhnSDspITsnbjri6QKICAgKiDsiJjsnoXsnbQgMCjslYTsp4Eg7J6F66ClIOyViCDtlagp7J2066m0IOykhOydtOyngCDslYrripTri6QuCiAgICovCiAgZnVuY3Rpb24gY29tcHV0ZUJ1ZGdldHMoY2F0ZWdvcmllcywgaW5jb21lLCByYXRpb0Jhc2UsIGZpeGVkT3ZlcmZsb3cpIHsKICAgIGNvbnN0IGluYyA9IE1hdGgubWF4KDAsIE51bWJlcihpbmNvbWUpIHx8IDApOwogICAgY29uc3QgZml4ZWRDYXRzID0gY2F0ZWdvcmllcy5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gJ2ZpeGVkJyk7CiAgICBjb25zdCBmaXhlZFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIE1hdGgucm91bmQoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IHJhdGlvUGVyY2VudFRvdGFsID0gY2F0ZWdvcmllcwogICAgICAuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09ICdyYXRpbycpCiAgICAgIC5yZWR1Y2UoKHMsIGMpID0+IHMgKyAoTnVtYmVyKGMudmFsdWUpIHx8IDApLCAwKTsKICAgIGNvbnN0IGZpeGVkT3ZlciA9IGluYyA+IDAgPyBNYXRoLm1heCgwLCBmaXhlZFRvdGFsIC0gaW5jKSA6IDA7CiAgICBjb25zdCBmaXhlZFNjYWxlZCA9IGZpeGVkT3ZlcmZsb3cgPT09ICdzY2FsZScgJiYgZml4ZWRPdmVyID4gMDsKCiAgICBjb25zdCBidWRnZXRzID0ge307CiAgICBmb3IgKGNvbnN0IGMgb2YgZml4ZWRDYXRzKSBidWRnZXRzW2MuaWRdID0gTWF0aC5yb3VuZChOdW1iZXIoYy52YWx1ZSkgfHwgMCk7CiAgICBpZiAoZml4ZWRTY2FsZWQpIHsKICAgICAgLy8g67mE66GA7ZW07IScIOuCtOumvO2VnCDrkqQsIOuCqOydgCDrqocg7JuQ7J2AIOyGjOyImOygkCDslYTrnpjqsIAg7YGwIO2Vreuqqeu2gO2EsCAx7JuQ7JSpIOuNlO2VtCDtlanqs4Trpbwg7IiY7J6F6rO8IOygle2Zle2eiCDrp57stpjri6QKICAgICAgY29uc3QgcGFydHMgPSBmaXhlZENhdHMubWFwKChjKSA9PiB7CiAgICAgICAgY29uc3QgZXhhY3QgPSAoYnVkZ2V0c1tjLmlkXSAqIGluYykgLyBmaXhlZFRvdGFsOwogICAgICAgIHJldHVybiB7IGlkOiBjLmlkLCBmbG9vcjogTWF0aC5mbG9vcihleGFjdCksIGZyYWM6IGV4YWN0IC0gTWF0aC5mbG9vcihleGFjdCkgfTsKICAgICAgfSk7CiAgICAgIGxldCBsZWZ0ID0gaW5jIC0gcGFydHMucmVkdWNlKChzLCB4KSA9PiBzICsgeC5mbG9vciwgMCk7CiAgICAgIHBhcnRzLnNvcnQoKGEsIGIpID0+IGIuZnJhYyAtIGEuZnJhYyk7CiAgICAgIGZvciAoY29uc3QgeCBvZiBwYXJ0cykgewogICAgICAgIGJ1ZGdldHNbeC5pZF0gPSB4LmZsb29yICsgKGxlZnQgPiAwID8gMSA6IDApOwogICAgICAgIGlmIChsZWZ0ID4gMCkgbGVmdCAtPSAxOwogICAgICB9CiAgICB9CiAgICBjb25zdCBmaXhlZEJ1ZGdldFRvdGFsID0gZml4ZWRDYXRzLnJlZHVjZSgocywgYykgPT4gcyArIGJ1ZGdldHNbYy5pZF0sIDApOwogICAgY29uc3QgYmFzZSA9IHJhdGlvQmFzZSA9PT0gJ2FmdGVyRml4ZWQnID8gTWF0aC5tYXgoMCwgaW5jIC0gZml4ZWRCdWRnZXRUb3RhbCkgOiBpbmM7CgogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIHsKICAgICAgaWYgKGMudHlwZSAhPT0gJ2ZpeGVkJykgYnVkZ2V0c1tjLmlkXSA9IE1hdGgucm91bmQoKGJhc2UgKiAoTnVtYmVyKGMudmFsdWUpIHx8IDApKSAvIDEwMCk7CiAgICB9CiAgICBjb25zdCBhbGxvY2F0ZWQgPSBPYmplY3QudmFsdWVzKGJ1ZGdldHMpLnJlZHVjZSgocywgdikgPT4gcyArIHYsIDApOwogICAgcmV0dXJuIHsKICAgICAgYnVkZ2V0cywKICAgICAgZml4ZWRUb3RhbCwKICAgICAgZml4ZWRCdWRnZXRUb3RhbCwKICAgICAgZml4ZWRPdmVyLAogICAgICBmaXhlZFNjYWxlZCwKICAgICAgZml4ZWRTY2FsZTogZml4ZWRTY2FsZWQgPyBpbmMgLyBmaXhlZFRvdGFsIDogMSwKICAgICAgcmF0aW9QZXJjZW50VG90YWwsCiAgICAgIHJhdGlvQmFzZUFtb3VudDogYmFzZSwKICAgICAgYWxsb2NhdGVkLAogICAgICB1bmFsbG9jYXRlZDogaW5jIC0gYWxsb2NhdGVkLAogICAgfTsKICB9CgogIC8vIOqxsOuemCDsooXrpZg6IGV4cGVuc2Uo7KeA7LacLCDquLDrs7gpIC8gaW5jb21lKOyeheq4iCkgLyB0cmFuc2ZlcijrgrQg6rOE7KKM64G866asIOydtOyytCDigJQg7KeA7LacwrfsiJjsnoXsl5DshJwg7KCc7Jm4KQogIGZ1bmN0aW9uIGtpbmRPZih0KSB7CiAgICByZXR1cm4gdC5raW5kID09PSAnaW5jb21lJyB8fCB0LmtpbmQgPT09ICd0cmFuc2ZlcicgPyB0LmtpbmQgOiAnZXhwZW5zZSc7CiAgfQoKICAvLyDrgrTsl63snbQg6rOE7IKw65CY64qUIOq4sOqwhC4g7Iuk7KCcIOuCoOynnOuKlCDqt7jrjIDroZwg65GQ6rOgIHBlcmlvZFNoaWZ0KCsxIOuLpOydjCDquLDqsIQsIC0xIOydtOyghCDquLDqsIQp66eM7YG8IOyYruq4uCDsiJgg7J6I64ukLgogIC8vICjsm5TquInsnbQg7Iuc7J6R7J28IO2VmOujqCDsoITsl5Ag65Ok7Ja07JioIOqyveyasCDrk7EuIOyLnOyekeydvOydhCDrsJTqv5Trj4Qg66qHIOq4sOqwhCDsmK7qsrzripTsp4Drp4wg7KCA7J6l7ZWY64uIIOyWtOq4i+uCmOyngCDslYrripTri6QpCiAgZnVuY3Rpb24gdHhQZXJpb2QodCwgc3RhcnREYXkpIHsKICAgIGNvbnN0IHAgPSBnZXRQZXJpb2QodC5kYXRlLCBzdGFydERheSk7CiAgICBjb25zdCBuID0gTWF0aC50cnVuYyhOdW1iZXIodC5wZXJpb2RTaGlmdCkgfHwgMCk7CiAgICByZXR1cm4gbiA/IHNoaWZ0UGVyaW9kKHAsIG4sIHN0YXJ0RGF5KSA6IHA7CiAgfQoKICBmdW5jdGlvbiB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKSB7CiAgICByZXR1cm4gc3RhdGUudHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gdHhQZXJpb2QodCwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpLmtleSA9PT0gcGVyaW9kLmtleSk7CiAgfQoKICBmdW5jdGlvbiBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCkgewogICAgY29uc3QgcGxhbiA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZC5rZXkpOwogICAgY29uc3QgaW5jb21lID0gc3RhdGUuaW5jb21lc1twZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IGNvbXB1dGVCdWRnZXRzKHBsYW4uY2F0ZWdvcmllcywgaGFzSW5jb21lID8gaW5jb21lIDogMCwgcGxhbi5yYXRpb0Jhc2UsIHBsYW4uZml4ZWRPdmVyZmxvdyk7CiAgICBjb25zdCBhbGwgPSB0eHNJblBlcmlvZChzdGF0ZSwgcGVyaW9kKTsKICAgIGNvbnN0IHR4cyA9IGFsbC5maWx0ZXIoKHQpID0+IGtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKTsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CgogICAgY29uc3Qgc3BlbnQgPSB7fTsKICAgIGNvbnN0IGNvdW50cyA9IHt9OwogICAgZm9yIChjb25zdCBjIG9mIHBsYW4uY2F0ZWdvcmllcykgewogICAgICBzcGVudFtjLmlkXSA9IDA7CiAgICAgIGNvdW50c1tjLmlkXSA9IDA7CiAgICB9CiAgICBsZXQgdW5jbGFzc2lmaWVkID0gMDsKICAgIGxldCB1bmNsYXNzaWZpZWRDb3VudCA9IDA7CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7CiAgICAgIGlmICh0LmNhdGVnb3J5SWQgJiYga25vd24uaGFzKHQuY2F0ZWdvcnlJZCkpIHsKICAgICAgICBzcGVudFt0LmNhdGVnb3J5SWRdICs9IHQuYW1vdW50OwogICAgICAgIGNvdW50c1t0LmNhdGVnb3J5SWRdICs9IDE7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdW5jbGFzc2lmaWVkICs9IHQuYW1vdW50OwogICAgICAgIHVuY2xhc3NpZmllZENvdW50ICs9IDE7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IHRvdGFsU3BlbnQgPSB0eHMucmVkdWNlKChzLCB0KSA9PiBzICsgdC5hbW91bnQsIDApOwogICAgY29uc3QgaW5jb21lUmVjZWl2ZWQgPSBhbGwuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdpbmNvbWUnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CgogICAgY29uc3Qgcm93cyA9IHBsYW4uY2F0ZWdvcmllcy5tYXAoKGMpID0+IHsKICAgICAgY29uc3QgYnVkZ2V0ID0gY2FsYy5idWRnZXRzW2MuaWRdOwogICAgICBjb25zdCB1c2VkID0gc3BlbnRbYy5pZF07CiAgICAgIHJldHVybiB7CiAgICAgICAgY2F0ZWdvcnk6IGMsCiAgICAgICAgYnVkZ2V0LAogICAgICAgIHNwZW50OiB1c2VkLAogICAgICAgIGNvdW50OiBjb3VudHNbYy5pZF0sCiAgICAgICAgcmVtYWluaW5nOiBidWRnZXQgLSB1c2VkLAogICAgICAgIHJhdGlvOiBidWRnZXQgPiAwID8gdXNlZCAvIGJ1ZGdldCA6IHVzZWQgPiAwID8gSW5maW5pdHkgOiAwLAogICAgICB9OwogICAgfSk7CgogICAgLy8g6rOE7ZqN7J20IOuwlOuAkCDrkqTsl5Ag7JWE7KeBIOuLpOyLnCDrtoTrpZjrkJjsp4Ag7JWK7J2AICjsp4HsoJEg6rOg66W07KeAIOyViuydgCkg7KeA7LacCiAgICBjb25zdCBzdGFsZUNvdW50ID0gdHhzLmZpbHRlcigKICAgICAgKHQpID0+IHQubWV0aG9kICE9PSAnbWFudWFsJyAmJiAoIXQuY2xhc3NpZmllZEF0IHx8IChwbGFuLnVwZGF0ZWRBdCAmJiB0LmNsYXNzaWZpZWRBdCA8IHBsYW4udXBkYXRlZEF0KSkKICAgICkubGVuZ3RoOwoKICAgIHJldHVybiB7CiAgICAgIHBlcmlvZCwKICAgICAgcGxhbiwKICAgICAgc3RhbGVDb3VudCwKICAgICAgaW5jb21lOiBoYXNJbmNvbWUgPyBpbmNvbWUgOiBudWxsLAogICAgICBoYXNJbmNvbWUsCiAgICAgIC4uLmNhbGMsCiAgICAgIHJvd3MsCiAgICAgIHVuY2xhc3NpZmllZCwKICAgICAgdW5jbGFzc2lmaWVkQ291bnQsCiAgICAgIHRvdGFsU3BlbnQsCiAgICAgIGluY29tZVJlY2VpdmVkLAogICAgICByZW1haW5pbmc6IChoYXNJbmNvbWUgPyBpbmNvbWUgOiAwKSAtIHRvdGFsU3BlbnQsCiAgICAgIHRyYW5zYWN0aW9uczogdHhzLAogICAgICBhbGxUcmFuc2FjdGlvbnM6IGFsbCwKICAgIH07CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNPZihyYXRpbykgewogICAgaWYgKHJhdGlvID4gMSkgcmV0dXJuICdjcml0aWNhbCc7CiAgICBpZiAocmF0aW8gPj0gMC44KSByZXR1cm4gJ3dhcm5pbmcnOwogICAgcmV0dXJuICdnb29kJzsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J6Q64+ZIOu2hOulmCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIG5vcm1hbGl6ZU1lcmNoYW50KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9ccysvZywgJycpOwogIH0KCiAgLy8gMSkg7KeB7KCRIOu2hOulmO2VtCDrkZQg6rCA66e57KCQKO2VmeyKtSkg4oaSIDIpIOqwgOyepSDquLQg7YKk7JuM65Oc6rCAIOydvOy5mO2VmOuKlCDtla3rqqkKICBmdW5jdGlvbiBjbGFzc2lmeShtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBub3JtID0gbm9ybWFsaXplTWVyY2hhbnQobWVtbyk7CiAgICBpZiAoIW5vcm0pIHJldHVybiBudWxsOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBsZWFybmVkID0gbWVyY2hhbnRNYXBbbm9ybV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiBsZWFybmVkOwoKICAgIGxldCBiZXN0ID0gbnVsbDsKICAgIGxldCBiZXN0TGVuID0gMDsKICAgIGZvciAoY29uc3QgYyBvZiBjYXRlZ29yaWVzKSB7CiAgICAgIGZvciAoY29uc3Qga3cgb2YgYy5rZXl3b3JkcyB8fCBbXSkgewogICAgICAgIGNvbnN0IGsgPSBub3JtYWxpemVNZXJjaGFudChrdyk7CiAgICAgICAgaWYgKGsgJiYgay5sZW5ndGggPiBiZXN0TGVuICYmIG5vcm0uaW5jbHVkZXMoaykpIHsKICAgICAgICAgIGJlc3QgPSBjLmlkOwogICAgICAgICAgYmVzdExlbiA9IGsubGVuZ3RoOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgcmV0dXJuIGJlc3Q7CiAgfQoKICAvLyBBSSDsl4bsnbQg67aE66WYOiB7IGNhdGVnb3J5SWQsIG1ldGhvZDogJ2xlYXJuZWQnIHwgJ2tleXdvcmQnIHwgbnVsbCB9CiAgZnVuY3Rpb24gY2xhc3NpZnlMb2NhbChtZW1vLCBjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCA9IHt9KSB7CiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQoY2F0ZWdvcmllcy5tYXAoKGMpID0+IGMuaWQpKTsKICAgIGNvbnN0IGxlYXJuZWQgPSBtZXJjaGFudE1hcFtub3JtYWxpemVNZXJjaGFudChtZW1vKV07CiAgICBpZiAobGVhcm5lZCAmJiBrbm93bi5oYXMobGVhcm5lZCkpIHJldHVybiB7IGNhdGVnb3J5SWQ6IGxlYXJuZWQsIG1ldGhvZDogJ2xlYXJuZWQnIH07CiAgICBjb25zdCBpZCA9IGNsYXNzaWZ5KG1lbW8sIGNhdGVnb3JpZXMsIHt9KTsKICAgIHJldHVybiBpZCA/IHsgY2F0ZWdvcnlJZDogaWQsIG1ldGhvZDogJ2tleXdvcmQnIH0gOiB7IGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9OwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsp4Dstpwg64K07JetIO2FjeyKpO2KuCDsnbjsi50gLS0tLS0tLS0tLQoKICBjb25zdCBOT0lTRV9QQVRURVJOUyA9IFsKICAgIC9cWz93ZWJccyrrsJzsi6BcXT8vZ2ksCiAgICAvXFtbXlxdXSpcXS9nLAogICAgLyjriITsoIF87J6U7JWhfOyelOqzoHztlZzrj4QpXHMqOj9ccyotP1tcZCxdK1xzKuybkD8vZywKICAgIC9cKD9ccyoo7J287Iuc67aIfO2VoOu2gFxzKlxkKlxzKuqwnD/sm5Q/fFxkK1xzKuqwnOyblClccypcKT8vZywKICAgIC9cKFxzKltcZCpdezMsNH1ccypcKS9nLCAvLyDsubTrk5wg64Gd7J6Q66asICgxMjM0KQogICAgL1wqXGR7Myw0fS9nLAogICAgL1xTXCpcUy9nLCAvLyDrp4jsiqTtgrnrkJwg7J2066aEIO2ZjSrrj5kKICAgIC9cZHsxLDJ9OlxkezJ9KDpcZHsyfSk/L2csIC8vIOyLnOqwgQogICAgLyjssrTtgax87Iug7JqpKT9ccyrsirnsnbgo7Leo7IaMKT8vZywKICAgIC/qsrDsoJwo7JmE66OMKT987IKs7JqpKOyZhOujjCk/fOy2nOq4iC9nLAogICAgLyhefFxzKVxTezEsNn3subTrk5woPz1cc3wkKS9nLCAvLyDsi6DtlZzsubTrk5wsIEtC6rWt66+87Lm065OcIC4uLgogIF07CgogIGZ1bmN0aW9uIGluZmVyWWVhcihtb250aCwgZGF5LCByZWZJU08pIHsKICAgIGNvbnN0IHJlZiA9IHBhcnNlSVNPKHJlZklTTyk7CiAgICBsZXQgeWVhciA9IHJlZi55OwogICAgLy8g6riw7KSA7J2867O064ukIO2VnOywuCDrr7jrnpjrnbzrqbQg7J6R64WEIOuCtOyXreycvOuhnCDrs7jri6QgKOyYiDogMeyblOyXkCAxMuyblCDrgrTsl60g67aZ7Jes64Sj6riwKQogICAgaWYgKGRpZmZEYXlzKHJlZklTTywgdG9JU08oeWVhciwgbW9udGgsIE1hdGgubWluKGRheSwgZGF5c0luTW9udGgoeWVhciwgbW9udGgpKSkpID4gNykgeWVhciAtPSAxOwogICAgcmV0dXJuIHllYXI7CiAgfQoKICBmdW5jdGlvbiB2YWxpZERhdGUoeSwgbSwgZCkgewogICAgcmV0dXJuIG0gPj0gMSAmJiBtIDw9IDEyICYmIGQgPj0gMSAmJiBkIDw9IGRheXNJbk1vbnRoKHksIG0pOwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdERhdGUobGluZSwgcmVmSVNPKSB7CiAgICBsZXQgbSA9IGxpbmUubWF0Y2goLygyMFxkezJ9KVxzKlsuXC0v64WEXVxzKihcZHsxLDJ9KVxzKlsuXC0v7JuUXVxzKihcZHsxLDJ9KVxzKuydvD8vKTsKICAgIGlmIChtKSB7CiAgICAgIGNvbnN0IFt5LCBtbywgZF0gPSBbTnVtYmVyKG1bMV0pLCBOdW1iZXIobVsyXSksIE51bWJlcihtWzNdKV07CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCAnICcpIH07CiAgICB9CiAgICAvLyDslZ7sl5Ag7Iir7J6QwrfsibztkZzqsIAg7JeG64qUIDA5LzI4IOqwmeydgCDrgqDsp5wuICjsmKTrnpjrkJwgaU9TIOyCrO2MjOumrOqwgCDsoJXqt5zsi50gbG9va2JlaGluZCDrpbwg66q7IOydveyWtOyEnAogICAgLy8g7JWeIOq4gOyekOulvCDqt7jro7nsnLzroZwg7J6h6rOgIOuQmOuPjOugpCDrhpPripTri6QpCiAgICBsZXQga2VlcCA9ICcnOwogICAgbSA9IGxpbmUubWF0Y2goLyhcZHsxLDJ9KVxzKuyblFxzKihcZHsxLDJ9KVxzKuydvC8pOwogICAgaWYgKCFtKSB7CiAgICAgIGNvbnN0IG1tID0gbGluZS5tYXRjaCgvKF58W15cZCxdKShcZHsxLDJ9KVsvLlwtXShcZHsxLDJ9KSg/IVtcZCxdKS8pOwogICAgICBpZiAobW0pIHsKICAgICAgICBrZWVwID0gbW1bMV07CiAgICAgICAgbSA9IFttbVswXSwgbW1bMl0sIG1tWzNdXTsKICAgICAgfQogICAgfQogICAgaWYgKG0pIHsKICAgICAgY29uc3QgW21vLCBkXSA9IFtOdW1iZXIobVsxXSksIE51bWJlcihtWzJdKV07CiAgICAgIGNvbnN0IHkgPSBpbmZlclllYXIobW8sIGQsIHJlZklTTyk7CiAgICAgIGlmICh2YWxpZERhdGUoeSwgbW8sIGQpKSByZXR1cm4geyBkYXRlOiB0b0lTTyh5LCBtbywgZCksIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrZWVwfSBgKSB9OwogICAgfQogICAgcmV0dXJuIHsgZGF0ZTogbnVsbCwgcmVzdDogbGluZSB9OwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdEFtb3VudChsaW5lKSB7CiAgICAvLyBb7KCV6rec7IudLCDquIjslaEg6re466O5LCDrkJjrj4zroKQg64aT7J2EIOyVniDquIDsnpAg6re466O5XQogICAgY29uc3QgcGF0dGVybnMgPSBbCiAgICAgIFsvKC0/XGRbXGQsXSopXHMq7JuQLywgMSwgMF0sIC8vIDEyLDAwMOybkAogICAgICBbLygtP1xkezEsM30oPzosXGR7M30pKykoPyFcZCkvLCAxLCAwXSwgLy8gMTIsMDAwCiAgICAgIFsvKF58XEQpKC0/XGR7Myx9KSg/IVxkKS8sIDIsIDFdLCAvLyAxMjAwMAogICAgXTsKICAgIGZvciAoY29uc3QgW3AsIGcsIGtdIG9mIHBhdHRlcm5zKSB7CiAgICAgIGNvbnN0IG0gPSBsaW5lLm1hdGNoKHApOwogICAgICBpZiAobSkgewogICAgICAgIGNvbnN0IG4gPSBOdW1iZXIobVtnXS5yZXBsYWNlKC8sL2csICcnKSk7CiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShuKSAmJiBuICE9PSAwKSByZXR1cm4geyBhbW91bnQ6IG4sIHJlc3Q6IGxpbmUucmVwbGFjZShtWzBdLCBgJHtrID8gbVtrXSA6ICcnfSBgKSB9OwogICAgICB9CiAgICB9CiAgICByZXR1cm4geyBhbW91bnQ6IG51bGwsIHJlc3Q6IGxpbmUgfTsKICB9CgogIGZ1bmN0aW9uIGNsZWFuTWVtbyhzKSB7CiAgICBsZXQgb3V0ID0gczsKICAgIGZvciAoY29uc3QgcCBvZiBOT0lTRV9QQVRURVJOUykgb3V0ID0gb3V0LnJlcGxhY2UocCwgJyAnKTsKICAgIHJldHVybiBvdXQKICAgICAgLnJlcGxhY2UoL1tcdCx8O10rL2csICcgJykKICAgICAgLnJlcGxhY2UoL15bXHNcLTrCty8oKV0rfFtcc1wtOsK3LygpXSskL2csICcnKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgICAgLnRyaW0oKTsKICB9CgogIC8qCiAgICog7Jes65+sIOykhOydmCDthY3siqTtirgo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDrgrTsl60sIOyXkeyFgCDrs7Xsgqwg65OxKeyXkOyEnCDsp4DstpzsnYQg672R7JWE64K464ukLgogICAqIOuwmO2ZmDogeyBpdGVtczogW3sgZGF0ZSwgYW1vdW50LCBtZW1vLCByYXcgfV0sIHNraXBwZWQ6IFtyYXcuLi5dIH0KICAgKi8KICBmdW5jdGlvbiBwYXJzZUV4cGVuc2VUZXh0KHRleHQsIHJlZklTTykgewogICAgY29uc3QgaXRlbXMgPSBbXTsKICAgIGNvbnN0IHNraXBwZWQgPSBbXTsKICAgIGZvciAoY29uc3QgcmF3TGluZSBvZiBTdHJpbmcodGV4dCB8fCAnJykuc3BsaXQoL1xyP1xuLykpIHsKICAgICAgY29uc3QgcmF3ID0gcmF3TGluZS50cmltKCk7CiAgICAgIGlmICghcmF3KSBjb250aW51ZTsKICAgICAgY29uc3QgaXNDYW5jZWwgPSAv7Leo7IaMfO2ZmOu2iC8udGVzdChyYXcpOwogICAgICAvLyDriITsoIEv7J6U7JWhIOq4iOyVoeydtCDqsrDsoJwg6riI7JWh7Jy866GcIOyeoe2eiOyngCDslYrrj4TroZ0g66i87KCAIOygnOqxsAogICAgICBsZXQgd29yayA9IHJhdwogICAgICAgIC5yZXBsYWNlKC8o64iE7KCBfOyelOyVoXzsnpTqs6B87ZWc64+EKVxzKjo/XHMqLT9bXGQsXStccyrsm5A/L2csICcgJykKICAgICAgICAucmVwbGFjZSgvXGR7MSwyfTpcZHsyfSg6XGR7Mn0pPy9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1woXHMqW1xkKl17Myw0fVxzKlwpfFwqXGR7Myw0fS9nLCAnICcpCiAgICAgICAgLnJlcGxhY2UoL1x0L2csICcgJyk7CiAgICAgIGNvbnN0IGQgPSBleHRyYWN0RGF0ZSh3b3JrLCByZWZJU08pOwogICAgICB3b3JrID0gZC5yZXN0OwogICAgICBjb25zdCBhID0gZXh0cmFjdEFtb3VudCh3b3JrKTsKICAgICAgaWYgKGEuYW1vdW50ID09PSBudWxsKSB7CiAgICAgICAgc2tpcHBlZC5wdXNoKHJhdyk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgbGV0IGFtb3VudCA9IE1hdGguYWJzKGEuYW1vdW50KTsKICAgICAgaWYgKGlzQ2FuY2VsIHx8IGEuYW1vdW50IDwgMCkgYW1vdW50ID0gLWFtb3VudDsKICAgICAgY29uc3QgbWVtbyA9IGNsZWFuTWVtbyhhLnJlc3QucmVwbGFjZSgv7Leo7IaMfO2ZmOu2iC9nLCAnICcpKSB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgICAgaXRlbXMucHVzaCh7IGRhdGU6IGQuZGF0ZSB8fCByZWZJU08sIGFtb3VudCwgbWVtbywgcmF3IH0pOwogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQgfTsKICB9CgogIGZ1bmN0aW9uIGlzRHVwbGljYXRlKGl0ZW0sIHRyYW5zYWN0aW9ucykgewogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5zb21lKAogICAgICAodCkgPT4gdC5kYXRlID09PSBpdGVtLmRhdGUgJiYgdC5hbW91bnQgPT09IGl0ZW0uYW1vdW50ICYmIG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgPT09IG5vcm1hbGl6ZU1lcmNoYW50KGl0ZW0ubWVtbykKICAgICk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOqysOygnMK37J6F7Lac6riIIOyVjOumvCAo7Lm065OcIOusuOyekCwg7J2A7ZaJIOyVsSDslYzrprwpIC0tLS0tLS0tLS0KCiAgLy8g6rGw656YIOyVjOumvOyymOufvCDrs7TsnbTripQg6riA7J247KeAICjsnbjspp3rsojtmLgsIOq0keqzoCDrk7HsnYAg7KCc7Jm4KQogIGZ1bmN0aW9uIGxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpIHsKICAgIGNvbnN0IHQgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBpZiAoIS9bXGQsXStccyrsm5AvLnRlc3QodCkpIHJldHVybiBmYWxzZTsKICAgIGlmICgv7J247KadXHMq67KI7Zi4fOyduOymney9lOuTnC8udGVzdCh0KSkgcmV0dXJuIGZhbHNlOwogICAgcmV0dXJuIC/sirnsnbh86rKw7KCcfOyCrOyaqXzst6jshox87Lac6riIfOyeheq4iHzsnbTssrR87Iah6riIfOuztOuDiHzrsJvslZgvLnRlc3QodCk7CiAgfQoKICBmdW5jdGlvbiBkaWdpdHNPbmx5KHMpIHsKICAgIHJldHVybiBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvXEQvZywgJycpOwogIH0KCiAgLy8g7JWM66a87JeQIOygge2ejCDqs4TsoozCt+y5tOuTnCDrsojtmLgo6rCA66Ck7KeEIOuyiO2YuCDtj6ztlagp7J2YIOuBneyekOumrOuhnCDrk7HroZ3rkJwg6rOE7KKML+y5tOuTnOulvCDssL7ripTri6QKICBmdW5jdGlvbiBtYXRjaEFjY291bnQodGV4dCwgYWNjb3VudHMpIHsKICAgIGNvbnN0IGNodW5rcyA9IFN0cmluZyh0ZXh0IHx8ICcnKS5tYXRjaCgvW1xkKl1bXGQqXC1dezIsfS9nKSB8fCBbXTsKICAgIGZvciAoY29uc3QgYSBvZiBhY2NvdW50cyB8fCBbXSkgewogICAgICBjb25zdCBsYXN0NCA9IGRpZ2l0c09ubHkoYS5sYXN0NCkuc2xpY2UoLTQpOwogICAgICBpZiAobGFzdDQubGVuZ3RoIDwgMykgY29udGludWU7CiAgICAgIGZvciAoY29uc3QgYyBvZiBjaHVua3MpIHsKICAgICAgICBpZiAoL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoYykpIGNvbnRpbnVlOyAvLyDrgqDsp5wKICAgICAgICBpZiAoZGlnaXRzT25seShjKS5lbmRzV2l0aChsYXN0NCkpIHJldHVybiBhOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rCE7Y646rKw7KCcIOuouOuLiCAo7Lm07Lm07Jik7Y6Y7J20IOuTsSkgLS0tLS0tLS0tLQogIC8vIOydgO2WiSDrgrTsl63sl5AgJ+y5tOy5tOyYpO2OmOydtCfroZwg7LCN7Z6I64qUIOy2nOq4iOydgCDtjpjsnbQg66i464uI66GcIOyYruq4tCDrj4go7Lap7KCEKeydtOudvCDsp4DstpzsnbQg7JWE64uI64ukLgogIC8vIOyLpOygnCDsp4DstpzsnYAg7Y6Y7J20IOqysOygnOuCtOyXrSjqt7gg7Y6Y7J20IOqzhOygleycvOuhnCDqsIDsoLjsmKgg64K07JetKeycvOuhnCDshLzri6QuIOq4iOyVoeydtCDri6zrnbzrj4QgMTox66GcIOunnuy2nCDtlYTsmpTqsIAg7JeG64ukLgogIGZ1bmN0aW9uIHBheUFjY291bnRGb3JNZW1vKG1lbW8sIGFjY291bnRzKSB7CiAgICBjb25zdCBtID0gbm9ybWFsaXplTWVyY2hhbnQobWVtbyk7CiAgICBpZiAoIW0pIHJldHVybiBudWxsOwogICAgZm9yIChjb25zdCBhIG9mIGFjY291bnRzIHx8IFtdKSB7CiAgICAgIGlmIChhLnR5cGUgIT09ICdwYXknKSBjb250aW51ZTsKICAgICAgY29uc3Qga2V5ID0gbm9ybWFsaXplTWVyY2hhbnQoYS5wYXlOYW1lIHx8IGEubmFtZSk7CiAgICAgIGlmIChrZXkgJiYgbS5pbmNsdWRlcyhrZXkpKSByZXR1cm4gYTsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgLy8g64uk66W4IOqzhOyijOydmCDrgrTsl63snbjrjbAg7IKs7Jqp7LKY6rCAIO2OmOydtCDsnbTrpoTsnbTrqbQgJ+uCtCDqs4Tsoowg7J207LK0JyjstqnsoITCt+2ZmOq4iSnsnLzroZwg67CU6r6864ukLiDrsJTqv6jsnLzrqbQgdHJ1ZQogIGZ1bmN0aW9uIGFwcGx5UGF5UnVsZXMoaXRlbSwgYWNjb3VudHMpIHsKICAgIGlmIChraW5kT2YoaXRlbSkgPT09ICd0cmFuc2ZlcicpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGFjYyA9IHBheUFjY291bnRGb3JNZW1vKGl0ZW0ubWVtbywgYWNjb3VudHMpOwogICAgaWYgKCFhY2MgfHwgaXRlbS5hY2NvdW50SWQgPT09IGFjYy5pZCkgcmV0dXJuIGZhbHNlOwogICAgaXRlbS5raW5kID0gJ3RyYW5zZmVyJzsKICAgIGl0ZW0uY2F0ZWdvcnlJZCA9IG51bGw7CiAgICBpdGVtLm1ldGhvZCA9IG51bGw7CiAgICByZXR1cm4gdHJ1ZTsKICB9CgogIC8vIOydtOykkSDqs4TsgrAg7LC+6riwOiDtjpjsnbQg6rKw7KCc64K07Jet64+EIOuTpOyWtOyZgCDsnojripTrjbAsIOuLpOuluCDqs4TsoozsnZgg6rCZ7J2AIOydtOumhCDstpzquIjsnbQg7JWE7KeBIOyngOy2nCjrmJDripQg7J6F6riIKeuhnCDrgqjsnYAg6rKDLgogIC8vIO2OmOydtOulvCAn7J2A7ZaJIOqzhOyijCfroZwg65Ox66Gd7ZW0IOuRlCDqsr3smrAo7J2066aE7JeQIO2OmOydtC9wYXksIOq3uCDqs4TsoJXsl5Ag7KeA7Lac7J20IOyeiOydjCnrj4Qg7LC+7JWE7IScIOyiheulmOulvCDrsJTqvrjrnbzqs6Ag7JWM66CkIOykgOuLpC4KICBmdW5jdGlvbiBwYXlEb3VibGVDb3VudHMoc3RhdGUpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChjb25zdCBhIG9mIHN0YXRlLmFjY291bnRzKSB7CiAgICAgIGNvbnN0IGxvb2tzUGF5ID0gYS50eXBlICE9PSAnY2FyZCcgJiYgL+2OmOydtHxwYXkvaS50ZXN0KGEubmFtZSkgJiYKICAgICAgICBzdGF0ZS50cmFuc2FjdGlvbnMuc29tZSgodCkgPT4gdC5hY2NvdW50SWQgPT09IGEuaWQgJiYga2luZE9mKHQpID09PSAnZXhwZW5zZScpOwogICAgICBpZiAoYS50eXBlICE9PSAncGF5JyAmJiAhbG9va3NQYXkpIGNvbnRpbnVlOwogICAgICBjb25zdCBwc2V1ZG8gPSB7IC4uLmEsIHR5cGU6ICdwYXknLCBwYXlOYW1lOiBhLnBheU5hbWUgfHwgYS5uYW1lIH07CiAgICAgIGNvbnN0IHR4cyA9IHN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IGFwcGx5UGF5UnVsZXMoeyAuLi50IH0sIFtwc2V1ZG9dKSk7CiAgICAgIGlmICh0eHMubGVuZ3RoKSBvdXQucHVzaCh7IGFjY291bnQ6IGEsIHBheU5hbWU6IHBzZXVkby5wYXlOYW1lLCBuZWVkc1R5cGU6IGEudHlwZSAhPT0gJ3BheScsIHR4cywgdG90YWw6IHR4cy5yZWR1Y2UoKHMsIHQpID0+IHMgKyAoa2luZE9mKHQpID09PSAnZXhwZW5zZScgPyB0LmFtb3VudCA6IDApLCAwKSB9KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAn7Lm07Lm07Jik7Y6Y7J20IOy2nOq4iCDsoJXrpqwnIOuyhO2KvOyaqTog7KCV66as7ZWgIO2OmOydtCDsnbTrpoTqs7wg6rOE7KCVLCDrsJTqv4Ag64K07JetLgogIC8vIOqwhO2OuOqysOygnCDrqLjri4jroZwg65Ox66Gd7ZWcIOqzhOygleydtCDsl4bsnLzrqbQg7J2066aE7J20IOy5tOy5tOyYpO2OmOydtOyduCDqs4TsoJUsIOq3uOqyg+uPhCDsl4bsnLzrqbQgJ+y5tOy5tOyYpO2OmOydtCcg7J2066aE66eM7Jy866GcIOywvuuKlOuLpC4KICBmdW5jdGlvbiBwYXlUb3B1cENhbmRpZGF0ZXMoc3RhdGUpIHsKICAgIGNvbnN0IGFjYyA9IHN0YXRlLmFjY291bnRzLmZpbmQoKGEpID0+IGEudHlwZSA9PT0gJ3BheScpIHx8CiAgICAgIHN0YXRlLmFjY291bnRzLmZpbmQoKGEpID0+IGEudHlwZSAhPT0gJ2NhcmQnICYmIC/subTsubTsmKRccyrtjpjsnbQvaS50ZXN0KGEubmFtZSkpIHx8IG51bGw7CiAgICBjb25zdCBwYXlOYW1lID0gKGFjYyAmJiAoYWNjLnBheU5hbWUgfHwgYWNjLm5hbWUpKSB8fCAn7Lm07Lm07Jik7Y6Y7J20JzsKICAgIGNvbnN0IHBzZXVkbyA9IHsgLi4uKGFjYyB8fCB7IGlkOiAnX19ub25lJywgbmFtZTogcGF5TmFtZSB9KSwgdHlwZTogJ3BheScsIHBheU5hbWUgfTsKICAgIGNvbnN0IHR4cyA9IHN0YXRlLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IGFwcGx5UGF5UnVsZXMoeyAuLi50IH0sIFtwc2V1ZG9dKSk7CiAgICByZXR1cm4geyBhY2NvdW50OiBhY2MsIHBheU5hbWUsIG5lZWRzVHlwZTogISFhY2MgJiYgYWNjLnR5cGUgIT09ICdwYXknLCB0eHMgfTsKICB9CgogIC8vIOq4sOqwhOuzhCDtjpjsnbQg66i464uIIO2dkOumhDog7Lap7KCEKOuLpOuluCDqs4Tsoozsl5DshJwg7Jiu6ri0IOuPiCnqs7wg7Y6Y7J20IOqysOygnOuCtOyXrQogIGZ1bmN0aW9uIHBheUZsb3dzKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IHR4cyA9IHR4c0luUGVyaW9kKHN0YXRlLCBwZXJpb2QpOwogICAgcmV0dXJuIHN0YXRlLmFjY291bnRzLmZpbHRlcigoYSkgPT4gYS50eXBlID09PSAncGF5JykubWFwKChhY2MpID0+IHsKICAgICAgbGV0IHRvcHVwID0gMDsKICAgICAgbGV0IHNwZW50ID0gMDsKICAgICAgbGV0IGNvdW50ID0gMDsKICAgICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICAgIGNvbnN0IGsgPSBraW5kT2YodCk7CiAgICAgICAgaWYgKHQuYWNjb3VudElkID09PSBhY2MuaWQpIHsKICAgICAgICAgIGlmIChrID09PSAnZXhwZW5zZScpIHsKICAgICAgICAgICAgc3BlbnQgKz0gdC5hbW91bnQ7CiAgICAgICAgICAgIGNvdW50ICs9IDE7CiAgICAgICAgICB9CiAgICAgICAgfSBlbHNlIGlmIChrID09PSAndHJhbnNmZXInICYmIHBheUFjY291bnRGb3JNZW1vKHQubWVtbywgW2FjY10pKSB7CiAgICAgICAgICB0b3B1cCArPSB0LmFtb3VudDsKICAgICAgICB9CiAgICAgIH0KICAgICAgcmV0dXJuIHsgYWNjb3VudDogYWNjLCB0b3B1cCwgc3BlbnQsIGNvdW50IH07CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGFjY291bnRCeUxhc3Q0KGxhc3Q0LCBhY2NvdW50cykgewogICAgY29uc3QgZCA9IGRpZ2l0c09ubHkobGFzdDQpLnNsaWNlKC00KTsKICAgIGlmIChkLmxlbmd0aCA8IDMpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChhY2NvdW50cyB8fCBbXSkuZmluZCgoYSkgPT4gZGlnaXRzT25seShhLmxhc3Q0KS5zbGljZSgtNCkgPT09IGQpIHx8IG51bGw7CiAgfQoKICAvLyBBSSDsl4bsnbQg7JWM66a87J2EIOydveydhCDrlYwg6rGw656YIOyiheulmCDstpTsuKEKICBmdW5jdGlvbiBkZXRlY3RLaW5kKHRleHQsIG15TmFtZSkgewogICAgY29uc3QgdCA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgv7Iq57J24fOqysOygnC8udGVzdCh0KSkgcmV0dXJuICdleHBlbnNlJzsKICAgIGlmIChteU5hbWUgJiYgdC5pbmNsdWRlcyhteU5hbWUpICYmIC/snbTssrR87Lac6riIfOyGoeq4iHzrs7Trg4h87J6F6riIfOuwm+yVmC8udGVzdCh0KSkgcmV0dXJuICd0cmFuc2Zlcic7CiAgICBpZiAoL+yeheq4iHzrsJvslZgvLnRlc3QodCkgJiYgIS/stpzquIgvLnRlc3QodCkpIHJldHVybiAnaW5jb21lJzsKICAgIHJldHVybiAnZXhwZW5zZSc7CiAgfQoKICAvLyBBSSDrpbwg7JO4IOyImCDsl4bsnYQg65WM7J2YIOyVjOumvCDsnbjsi50uIOyXrOufrCDspIQg7JWM66a87J2EIO2VnCDspITroZwg7ZWp7LOQ7IScIOydveuKlOuLpC4KICAvLyDrsJjtmZg6IHsgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGJhbGFuY2UgfSDrmJDripQgbnVsbAogIGZ1bmN0aW9uIHBhcnNlTWVzc2FnZUZhbGxiYWNrKHRleHQsIHJlZklTTywgb3B0cyA9IHt9KSB7CiAgICBpZiAoIWxvb2tzTGlrZVRyYW5zYWN0aW9uKHRleHQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGJhbGFuY2VNYXRjaCA9IFN0cmluZyh0ZXh0KS5tYXRjaCgv7J6U7JWhXHMqOj9ccyooW1xkLF0rKVxzKuybkD8vKTsKICAgIGNvbnN0IGFjY291bnQgPSBtYXRjaEFjY291bnQodGV4dCwgb3B0cy5hY2NvdW50cyk7CiAgICBjb25zdCBvbmVMaW5lID0gU3RyaW5nKHRleHQpCiAgICAgIC5yZXBsYWNlKC9ccj9cbi9nLCAnICcpCiAgICAgIC5yZXBsYWNlKC8oPzpbXGRcLV0rXCorfFwqK1tcZFwtXSspW1xkKlwtXSp8XGR7Myx9LVxkezIsfS1cZHszLH0vZywgJyAnKSAvLyDqsIDroKTsp4Qg67KI7Zi4LCDqs4TsoozrsojtmLgKICAgICAgLnJlcGxhY2UoL+yeheq4iHzsnbTssrR87Iah6riIfOuztOuDiOyWtOyalHzrsJvslZjslrTsmpR864uY7JeQ6rKMfOuLmOydtC9nLCAnICcpOwogICAgY29uc3QgeyBpdGVtcyB9ID0gcGFyc2VFeHBlbnNlVGV4dChvbmVMaW5lLCByZWZJU08pOwogICAgY29uc3QgaXRlbSA9IGl0ZW1zWzBdOwogICAgaWYgKCFpdGVtKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGtpbmQgPSBkZXRlY3RLaW5kKHRleHQsIG9wdHMubXlOYW1lKTsKICAgIHJldHVybiB7CiAgICAgIGRhdGU6IGl0ZW0uZGF0ZSwKICAgICAgYW1vdW50OiBraW5kID09PSAnZXhwZW5zZScgPyBpdGVtLmFtb3VudCA6IE1hdGguYWJzKGl0ZW0uYW1vdW50KSwKICAgICAgbWVtbzogaXRlbS5tZW1vLAogICAgICBraW5kLAogICAgICBhY2NvdW50SWQ6IGFjY291bnQgPyBhY2NvdW50LmlkIDogbnVsbCwKICAgICAgYmFsYW5jZTogYmFsYW5jZU1hdGNoID8gTnVtYmVyKGJhbGFuY2VNYXRjaFsxXS5yZXBsYWNlKC8sL2csICcnKSkgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6riw6rCE67OEIOyekOyCsOq0gOumrOqzhO2ajSAtLS0tLS0tLS0tCgogIGNvbnN0IEJBU0VfUExBTl9GUk9NID0gJzAwMDAtMDEtMDEnOwoKICAvLyDtlbTri7kg6riw6rCE7JeQIOyggeyaqeuQmOuKlCDqs4Ttmo06IOyLnOyekeydvOydtCDqt7gg6riw6rCEIOydtOyghOyduCDqs4Ttmo0g7KSRIOqwgOyepSDstZzqt7wg6rKDCiAgZnVuY3Rpb24gcGxhbkZvcihzdGF0ZSwgcGVyaW9kS2V5KSB7CiAgICBjb25zdCBwbGFucyA9IHN0YXRlLnBsYW5zOwogICAgbGV0IGZvdW5kID0gcGxhbnNbMF07CiAgICBmb3IgKGNvbnN0IHAgb2YgcGxhbnMpIGlmIChwLmZyb20gPD0gcGVyaW9kS2V5KSBmb3VuZCA9IHA7CiAgICByZXR1cm4gZm91bmQ7CiAgfQoKICAvLyDrr7jrtoTrpZggPSDsp4DstpzsnbjrjbAg7ZWt66qp7J20IOyXhuqxsOuCmCwg6re4IOuCoOynnOqwgCDsho3tlZwg6riw6rCE7J2YIOqzhO2ajeyXkCDsl4bripQg7ZWt66qp7J24IOqygwogIGZ1bmN0aW9uIGlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSB7CiAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yKHN0YXRlLCB0eFBlcmlvZCh0LCBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KS5jYXRlZ29yaWVzOwogICAgcmV0dXJuICEodC5jYXRlZ29yeUlkICYmIGNhdHMuc29tZSgoYykgPT4gYy5pZCA9PT0gdC5jYXRlZ29yeUlkKSk7CiAgfQoKICAvLyDquLDqsITrs4Qg66+467aE66WYIOqxtOyImDogW3sgcGVyaW9kLCBjb3VudCwgdG90YWwgfV0g7LWc6re8IOq4sOqwhOu2gO2EsAogIGZ1bmN0aW9uIHVuY2xhc3NpZmllZEJ5UGVyaW9kKHN0YXRlKSB7CiAgICBjb25zdCBieUtleSA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgdCBvZiBzdGF0ZS50cmFuc2FjdGlvbnMpIHsKICAgICAgaWYgKCFpc1VuY2xhc3NpZmllZChzdGF0ZSwgdCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBwID0gdHhQZXJpb2QodCwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICBpZiAoIWJ5S2V5LmhhcyhwLmtleSkpIGJ5S2V5LnNldChwLmtleSwgeyBwZXJpb2Q6IHAsIGNvdW50OiAwLCB0b3RhbDogMCB9KTsKICAgICAgY29uc3QgZSA9IGJ5S2V5LmdldChwLmtleSk7CiAgICAgIGUuY291bnQgKz0gMTsKICAgICAgZS50b3RhbCArPSB0LmFtb3VudDsKICAgIH0KICAgIHJldHVybiBbLi4uYnlLZXkudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IChhLnBlcmlvZC5rZXkgPCBiLnBlcmlvZC5rZXkgPyAxIDogLTEpKTsKICB9CgogIC8vIOuvuOu2hOulmCDsp4DstpzsnYQg6rCA66e57KCQKOyDgeuMgOuwqSnrs4TroZwg66y264qU64ukLiBwZXJpb2Qg66W8IOyjvOuptCDqt7gg6riw6rCEIOqyg+unjC4g7LWc6re87JeQIOyDneq4tCDrrLbsnYzrtoDthLAuCiAgZnVuY3Rpb24gdW5jbGFzc2lmaWVkR3JvdXBzKHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IGJ5S2V5ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCB0IG9mIHN0YXRlLnRyYW5zYWN0aW9ucykgewogICAgICBpZiAocGVyaW9kICYmIHR4UGVyaW9kKHQsIHN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5KS5rZXkgIT09IHBlcmlvZC5rZXkpIGNvbnRpbnVlOwogICAgICBpZiAoIWlzVW5jbGFzc2lmaWVkKHN0YXRlLCB0KSkgY29udGludWU7CiAgICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU1lcmNoYW50KHQubWVtbykgfHwgdC5tZW1vOwogICAgICBpZiAoIWJ5S2V5LmhhcyhrZXkpKSBieUtleS5zZXQoa2V5LCB7IGtleSwgbWVtbzogdC5tZW1vLCBpdGVtczogW10sIHRvdGFsOiAwLCBsYXRlc3Q6ICcnIH0pOwogICAgICBjb25zdCBnID0gYnlLZXkuZ2V0KGtleSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgICAgZy50b3RhbCArPSB0LmFtb3VudDsKICAgICAgaWYgKHQuZGF0ZSA+IGcubGF0ZXN0KSBnLmxhdGVzdCA9IHQuZGF0ZTsKICAgIH0KICAgIGNvbnN0IGdyb3VwcyA9IFsuLi5ieUtleS52YWx1ZXMoKV07CiAgICBmb3IgKGNvbnN0IGcgb2YgZ3JvdXBzKSBnLml0ZW1zLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBncm91cHMuc29ydCgoYSwgYikgPT4gKGEubGF0ZXN0IDwgYi5sYXRlc3QgPyAxIDogYS5sYXRlc3QgPiBiLmxhdGVzdCA/IC0xIDogYi50b3RhbCAtIGEudG90YWwpKTsKICAgIHJldHVybiBncm91cHM7CiAgfQoKICAvLyDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDqs4Ttmo3snYQg7IiY7KCV7ZWY66Ck6rOgIO2VoCDrlYwg7Zi47LacLiDsl4bsnLzrqbQg7KeB7KCEIOqzhO2ajeydhCDrs7XsgqztlbTshJwg66eM65Og64ukLgogIGZ1bmN0aW9uIGVuc3VyZVBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSwgbm93SVNPKSB7CiAgICBjb25zdCBleGlzdGluZyA9IHN0YXRlLnBsYW5zLmZpbmQoKHApID0+IHAuZnJvbSA9PT0gcGVyaW9kS2V5KTsKICAgIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nOwogICAgY29uc3QgYmFzZSA9IHBsYW5Gb3Ioc3RhdGUsIHBlcmlvZEtleSk7CiAgICBjb25zdCBjb3B5ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShiYXNlKSk7CiAgICBjb3B5LmZyb20gPSBwZXJpb2RLZXk7CiAgICBjb3B5LnVwZGF0ZWRBdCA9IG5vd0lTTzsKICAgIHN0YXRlLnBsYW5zLnB1c2goY29weSk7CiAgICBzdGF0ZS5wbGFucy5zb3J0KChhLCBiKSA9PiAoYS5mcm9tIDwgYi5mcm9tID8gLTEgOiBhLmZyb20gPiBiLmZyb20gPyAxIDogMCkpOwogICAgcmV0dXJuIGNvcHk7CiAgfQoKICBmdW5jdGlvbiBuZXh0UGxhbkFmdGVyKHN0YXRlLCBwbGFuKSB7CiAgICByZXR1cm4gc3RhdGUucGxhbnMuZmluZCgocCkgPT4gcC5mcm9tID4gcGxhbi5mcm9tKSB8fCBudWxsOwogIH0KCiAgLy8g7Iuc7J6R7J287J2EIOuwlOq+uOuptCDquLDqsIQg7YKkKOyLnOyekSDrgqDsp5wp66W8IOqwmeydgCDri6zsnZgg7IOIIOyLnOyekeydvOuhnCDsmK7quLTri6QuCiAgZnVuY3Rpb24gcmVtYXBQZXJpb2RLZXlzKHN0YXRlLCBuZXdTdGFydERheSkgewogICAgY29uc3QgbW92ZSA9IChrZXkpID0+IHsKICAgICAgaWYgKGtleSA9PT0gQkFTRV9QTEFOX0ZST00pIHJldHVybiBrZXk7CiAgICAgIGNvbnN0IHsgeSwgbSB9ID0gcGFyc2VJU08oa2V5KTsKICAgICAgcmV0dXJuIHRvSVNPKHksIG0sIE1hdGgubWluKG5ld1N0YXJ0RGF5LCBkYXlzSW5Nb250aCh5LCBtKSkpOwogICAgfTsKICAgIGNvbnN0IGluY29tZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLmluY29tZXMpKSBpbmNvbWVzW21vdmUoayldID0gdjsKICAgIHN0YXRlLmluY29tZXMgPSBpbmNvbWVzOwogICAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBsYW5zKSBwLmZyb20gPSBtb3ZlKHAuZnJvbSk7CiAgICBzdGF0ZS5zZXR0aW5ncy5zdGFydERheSA9IG5ld1N0YXJ0RGF5OwogIH0KCiAgLy8gLS0tLS0tLS0tLSBBSSDrtoTrpZgg7JqU7LKtIOunjOuTpOq4sCAvIOqysOqzvCDsnb3quLAgLS0tLS0tLS0tLQogIC8vIOyLpOygnCBBUEkg7Zi47Lac7J2AIOyEnOuyhChBcHBzIFNjcmlwdCnsl5DshJwg7ZWc64ukLiDsl6zquLDshJzripQg7ZSE66Gs7ZSE7Yq47JmAIEpTT04g7Iqk7YKk66eI66eMIOunjOuToOuLpC4KCiAgZnVuY3Rpb24gY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCkgewogICAgY29uc3QgZXhhbXBsZXMgPSB7fTsKICAgIGZvciAoY29uc3QgW21lcmNoYW50LCBpZF0gb2YgT2JqZWN0LmVudHJpZXMobWVyY2hhbnRNYXAgfHwge30pKSB7CiAgICAgIChleGFtcGxlc1tpZF0gPSBleGFtcGxlc1tpZF0gfHwgW10pLnB1c2gobWVyY2hhbnQpOwogICAgfQogICAgcmV0dXJuIGNhdGVnb3JpZXMubWFwKChjKSA9PiAoewogICAgICBpZDogYy5pZCwKICAgICAgbmFtZTogYy5uYW1lLAogICAgICBkZXNjcmlwdGlvbjogYy5kZXNjcmlwdGlvbiB8fCAnJywKICAgICAga2V5d29yZHM6IChjLmtleXdvcmRzIHx8IFtdKS5zbGljZSgwLCAyMCksCiAgICAgIGV4YW1wbGVzOiAoZXhhbXBsZXNbYy5pZF0gfHwgW10pLnNsaWNlKC0xMCksCiAgICB9KSk7CiAgfQoKICBjb25zdCBDTEFTU0lGWV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1reyWtCDqsIDqs4TrtoDsnZgg7KeA7LacIOu2hOulmOq4sOyeheuLiOuLpC4nLAogICAgJ+yCrOyaqeyekOqwgCDsoJXtlbQg65GUIOyekOyCsOq0gOumrOqzhO2ajSDtla3rqqkg66qp66Gd7J20IOyjvOyWtOyngOuptCwg6rCBIOyngOy2nOydhCDqsIDsnqUg7JWM66ee7J2AIO2VreuqqSBpZCDtlZjrgpjroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAn7ZWt66qp7J2YIOydtOumhCwg7ISk66qFLCDtgqTsm4zrk5wsIOyCrOyaqeyekOqwgCDsmIjsoITsl5Ag7KeB7KCRIOu2hOulmO2VnCDqsIDrp7nsoJAg7JiI7IucKGV4YW1wbGVzKeulvCDqt7zqsbDroZwg7YyQ64uo7ZWp64uI64ukLicsCiAgICAn6rCA66e57KCQIOydtOumhOunjOycvOuhnCDsl4XsooXsnYQg7LaU66Gg7ZW064+EIOuQqeuLiOuLpC4g7Ja064qQIO2VreuqqeyXkOuPhCDrp57sp4Ag7JWK6rGw64KYIOuPhOyggO2eiCDtjJDri6jtlaAg7IiYIOyXhuycvOuptCAibm9uZSLsnYQg6rOg66W07IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZENsYXNzaWZ5UmVxdWVzdChjYXRlZ29yaWVzLCBpdGVtcywgbWVyY2hhbnRNYXApIHsKICAgIGNvbnN0IGlkcyA9IGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKTsKICAgIGNvbnN0IHVzZXIgPSBKU09OLnN0cmluZ2lmeSh7CiAgICAgIGNhdGVnb3JpZXM6IGNhdGVnb3J5QnJpZWYoY2F0ZWdvcmllcywgbWVyY2hhbnRNYXApLAogICAgICBleHBlbnNlczogaXRlbXMubWFwKChpdCwgaSkgPT4gKHsgaW5kZXg6IGksIG1lcmNoYW50OiBpdC5tZW1vLCBhbW91bnQ6IGl0LmFtb3VudCwgZGF0ZTogaXQuZGF0ZSB9KSksCiAgICB9KTsKICAgIGNvbnN0IHNjaGVtYSA9IHsKICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICByZXN1bHRzOiB7CiAgICAgICAgICB0eXBlOiAnYXJyYXknLAogICAgICAgICAgaXRlbXM6IHsKICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsCiAgICAgICAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICAgICAgICBpbmRleDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICAgICAgICBjYXRlZ29yeUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBlbnVtOiBpZHMuY29uY2F0KFsnbm9uZSddKSB9LAogICAgICAgICAgICB9LAogICAgICAgICAgICByZXF1aXJlZDogWydpbmRleCcsICdjYXRlZ29yeUlkJ10sCiAgICAgICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSwKICAgICAgICAgIH0sCiAgICAgICAgfSwKICAgICAgfSwKICAgICAgcmVxdWlyZWQ6IFsncmVzdWx0cyddLAogICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsCiAgICB9OwogICAgcmV0dXJuIHsgc3lzdGVtOiBDTEFTU0lGWV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiBpdGVtcyDsmYAg6rCZ7J2AIOq4uOydtOydmCBjYXRlZ29yeUlkIOuwsOyXtCAo7JWMIOyImCDsl4bsnLzrqbQgbnVsbCkKICBmdW5jdGlvbiByZWFkQ2xhc3NpZnlSZXNwb25zZShqc29uLCBjYXRlZ29yaWVzLCBjb3VudCkgewogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBjb25zdCBvdXQgPSBuZXcgQXJyYXkoY291bnQpLmZpbGwobnVsbCk7CiAgICBmb3IgKGNvbnN0IHIgb2YgKGpzb24gJiYganNvbi5yZXN1bHRzKSB8fCBbXSkgewogICAgICBpZiAoTnVtYmVyLmlzSW50ZWdlcihyLmluZGV4KSAmJiByLmluZGV4ID49IDAgJiYgci5pbmRleCA8IGNvdW50ICYmIGtub3duLmhhcyhyLmNhdGVnb3J5SWQpKSB7CiAgICAgICAgb3V0W3IuaW5kZXhdID0gci5jYXRlZ29yeUlkOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgTUVTU0FHRV9TWVNURU0gPSBbCiAgICAn64u57Iug7J2AIO2VnOq1rSDsubTrk5zsgqzCt+ydgO2WieydmCDqsrDsoJwv7J6F7Lac6riIIOyVjOumvCjrrLjsnpAg65iQ64qUIOyVsSDslYzrprwp7J2EIOydveyWtCDqsIDqs4TrtoDsl5Ag6riw66Gd7ZWY64qUIOuPhOyasOuvuOyeheuLiOuLpC4nLAogICAgJ+yVjOumvOyXkOyEnCDqsbDrnpgg7KKF66WYLCDrgqDsp5wsIOq4iOyVoSjsm5ApLCDqsIDrp7nsoJAg65iQ64qUIOyDgeuMgOuwqSDsnbTrpoQsIOyelOyVoeydhCDrvZHqs6AsIOyngOy2nOydtOuptCDsgqzsmqnsnpDsnZgg7J6Q7IKw6rSA66as6rOE7ZqNIO2VreuqqSDspJEg7JWM66ee7J2AIO2VreuqqSBpZCDroZwg67aE66WY7ZWY7IS47JqULicsCiAgICAnJywKICAgICdraW5kIOq3nOy5mTonLAogICAgJy0gZXhwZW5zZTog7Lm065OcIOqysOygnCwg6rOE7KKM7JeQ7IScIOuLpOuluCDsgqzrnozCt+qwgOqyjOuhnCDrs7Trgrgg7Lac6riIL+ydtOyytCwg7J6Q64+Z7J207LK0LCDqs7Xqs7zquIgnLAogICAgJy0gaW5jb21lOiDri6Trpbgg7IKs656M7J2064KYIO2ajOyCrOyXkOyEnCDrk6TslrTsmKgg7J6F6riIICjquInsl6wsIO2ZmOq4iSDrk7EpJywKICAgICctIG93bl90cmFuc2Zlcjog7IKs7Jqp7J6QIOuzuOyduCDqs4Tsoozrgbzrpqwg7Jiu6ri0IOuPiC4g7IOB64yA67CpIOydtOumhOydtCDsgqzsmqnsnpAg7J2066aEKG15X25hbWUp6rO8IOqwmeqxsOuCmCwg7JWM66a87J2YIOyDgeuMgCDqs4TsoozqsIAg7IKs7Jqp7J6Q7J2YIOuTseuhnSDqs4TsoowoYWNjb3VudHMp7J2066m0IO2VtOuLue2VqeuLiOuLpC4nLAogICAgJy0gbm90X3RyYW5zYWN0aW9uOiDsnbjspp3rsojtmLgsIOq0keqzoCwg7JWI64K0IOuTsSDqsbDrnpjqsIAg7JWE64uMIOyVjOumvCcsCiAgICAnJywKICAgICctIOuzuOyduCDqs4TsoozroZwg7Jiu6ri0IOuPiOydtCDsoIDstpUg6rOE7KKMKGlzU2F2aW5ncynrgpgg7KCB6riIwrfssq3slb3Ct+ymneq2jCDqs4TsoozroZwg65Ok7Ja06rCA64qUIOy2nOq4iOydtOuptCB0b19zYXZpbmdzIOulvCB0cnVlIOuhnCDtlZjqs6AgY2F0ZWdvcnlJZCDrpbwg7KCA7LaVIOyEseqyqeydmCDtla3rqqnsnLzroZwg6rOg66W07IS47JqULiDqt7gg67CW7JeQ64qUIGZhbHNlLicsCiAgICAnLSDriITsoIEg6riI7JWhLCDtlZzrj4QsIOy5tOuTnMK36rOE7KKMIOuyiO2YuCwg7Iq57J2467KI7Zi464qUIOqxsOuemCDquIjslaHsnbQg7JWE64uZ64uI64ukLiDsnpTslaHsnbQg7KCB7ZiAIOyeiOycvOuptCBiYWxhbmNlIOyXkCwg7JeG7Jy866m0IC0xLicsCiAgICAnLSBhY2NvdW50X2xhc3Q0OiDsnbQg7JWM66a87J20IOyWtOuKkCDrk7HroZ0g6rOE7KKML+y5tOuTnOyXkOyEnCDsnbzslrTrgpwg6rGw656Y7J247KeAIOq3uCDrgZ0gNOyekOumrC4g66qo66W066m0IOu5iCDrrLjsnpDsl7QuJywKICAgICctIOyKueyduOy3qOyGjC/tmZjrtojsnbTrqbQgaXNfY2FuY2VsIOydhCB0cnVlIOuhnCDtlZjshLjsmpQuJywKICAgICctIGRhdGUg64qUIFlZWVktTU0tREQuIOyXsOuPhOqwgCDsl4bsnLzrqbQg7Jik64qYKHRvZGF5KSDquLDspIAg6rCA7J6lIOqwgOq5jOyatCDqs7zqsbAg64Kg7KecLCDrgqDsp5zqsIAg7JeG7Jy866m0IHRvZGF5LicsCiAgICAnLSDsp4DstpzsnbQg7JWE64uI6rGw64KYIOyVjOunnuydgCDtla3rqqnsnbQg7JeG7Jy866m0IGNhdGVnb3J5SWQg66W8ICJub25lIiDsnLzroZwg7ZWY7IS47JqULicsCiAgXS5qb2luKCdcbicpOwoKICBmdW5jdGlvbiBidWlsZE1lc3NhZ2VSZXF1ZXN0KGNhdGVnb3JpZXMsIHRleHQsIHRvZGF5SVNPLCBtZXJjaGFudE1hcCwgb3B0cyA9IHt9KSB7CiAgICBjb25zdCBpZHMgPSBjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCk7CiAgICBjb25zdCB1c2VyID0gSlNPTi5zdHJpbmdpZnkoewogICAgICB0b2RheTogdG9kYXlJU08sCiAgICAgIG15X25hbWU6IG9wdHMubXlOYW1lIHx8ICcnLAogICAgICBhY2NvdW50czogKG9wdHMuYWNjb3VudHMgfHwgW10pLm1hcCgoYSkgPT4gKHsgbmFtZTogYS5uYW1lLCB0eXBlOiBhLnR5cGUsIGxhc3Q0OiBkaWdpdHNPbmx5KGEubGFzdDQpLnNsaWNlKC00KSwgaXNTYXZpbmdzOiAhIWEuaXNTYXZpbmdzIH0pKSwKICAgICAgY2F0ZWdvcmllczogY2F0ZWdvcnlCcmllZihjYXRlZ29yaWVzLCBtZXJjaGFudE1hcCksCiAgICAgIG1lc3NhZ2U6IFN0cmluZyh0ZXh0KSwKICAgIH0pOwogICAgY29uc3Qgc2NoZW1hID0gewogICAgICB0eXBlOiAnb2JqZWN0JywKICAgICAgcHJvcGVydGllczogewogICAgICAgIGtpbmQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IFsnZXhwZW5zZScsICdpbmNvbWUnLCAnb3duX3RyYW5zZmVyJywgJ25vdF90cmFuc2FjdGlvbiddIH0sCiAgICAgICAgaXNfY2FuY2VsOiB7IHR5cGU6ICdib29sZWFuJyB9LAogICAgICAgIHRvX3NhdmluZ3M6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sCiAgICAgICAgZGF0ZTogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFtb3VudDogeyB0eXBlOiAnaW50ZWdlcicgfSwKICAgICAgICBtZXJjaGFudDogeyB0eXBlOiAnc3RyaW5nJyB9LAogICAgICAgIGFjY291bnRfbGFzdDQ6IHsgdHlwZTogJ3N0cmluZycgfSwKICAgICAgICBiYWxhbmNlOiB7IHR5cGU6ICdpbnRlZ2VyJyB9LAogICAgICAgIGNhdGVnb3J5SWQ6IHsgdHlwZTogJ3N0cmluZycsIGVudW06IGlkcy5jb25jYXQoWydub25lJ10pIH0sCiAgICAgIH0sCiAgICAgIHJlcXVpcmVkOiBbJ2tpbmQnLCAnaXNfY2FuY2VsJywgJ3RvX3NhdmluZ3MnLCAnZGF0ZScsICdhbW91bnQnLCAnbWVyY2hhbnQnLCAnYWNjb3VudF9sYXN0NCcsICdiYWxhbmNlJywgJ2NhdGVnb3J5SWQnXSwKICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLAogICAgfTsKICAgIHJldHVybiB7IHN5c3RlbTogTUVTU0FHRV9TWVNURU0sIHVzZXIsIHNjaGVtYSB9OwogIH0KCiAgLy8gQUkg7J2R64u1IOKGkiB7IGRhdGUsIGFtb3VudCwgbWVtbywga2luZCwgY2F0ZWdvcnlJZCwgYWNjb3VudElkLCBiYWxhbmNlIH0g65iQ64qUIG51bGwo6rGw656YIOyVhOuLmCkKICBmdW5jdGlvbiByZWFkTWVzc2FnZVJlc3BvbnNlKGpzb24sIGNhdGVnb3JpZXMsIHRvZGF5SVNPLCBhY2NvdW50cykgewogICAgaWYgKCFqc29uIHx8ICFqc29uLmtpbmQgfHwganNvbi5raW5kID09PSAnbm90X3RyYW5zYWN0aW9uJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhbW91bnRBYnMgPSBNYXRoLmFicyhNYXRoLnJvdW5kKE51bWJlcihqc29uLmFtb3VudCkgfHwgMCkpOwogICAgaWYgKCFhbW91bnRBYnMpIHJldHVybiBudWxsOwogICAgbGV0IGRhdGUgPSBTdHJpbmcoanNvbi5kYXRlIHx8ICcnKTsKICAgIGlmICghL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSkpIGRhdGUgPSB0b2RheUlTTzsKICAgIGNvbnN0IGtub3duID0gbmV3IFNldChjYXRlZ29yaWVzLm1hcCgoYykgPT4gYy5pZCkpOwogICAgY29uc3QgY2F0ZWdvcnlJZCA9IGtub3duLmhhcyhqc29uLmNhdGVnb3J5SWQpID8ganNvbi5jYXRlZ29yeUlkIDogbnVsbDsKICAgIGNvbnN0IGFjY291bnQgPSBhY2NvdW50QnlMYXN0NChqc29uLmFjY291bnRfbGFzdDQsIGFjY291bnRzKTsKCiAgICBsZXQga2luZCA9ICdleHBlbnNlJzsKICAgIGlmIChqc29uLmtpbmQgPT09ICdpbmNvbWUnKSBraW5kID0gJ2luY29tZSc7CiAgICBlbHNlIGlmIChqc29uLmtpbmQgPT09ICdvd25fdHJhbnNmZXInICYmICFqc29uLnRvX3NhdmluZ3MpIGtpbmQgPSAndHJhbnNmZXInOwoKICAgIHJldHVybiB7CiAgICAgIGRhdGUsCiAgICAgIGFtb3VudDoga2luZCA9PT0gJ2V4cGVuc2UnICYmIGpzb24uaXNfY2FuY2VsID8gLWFtb3VudEFicyA6IGFtb3VudEFicywKICAgICAgbWVtbzogU3RyaW5nKGpzb24ubWVyY2hhbnQgfHwgJycpLnRyaW0oKSB8fCAnKOuCtOyaqSDsl4bsnYwpJywKICAgICAga2luZCwKICAgICAgY2F0ZWdvcnlJZDoga2luZCA9PT0gJ2V4cGVuc2UnID8gY2F0ZWdvcnlJZCA6IG51bGwsCiAgICAgIGFjY291bnRJZDogYWNjb3VudCA/IGFjY291bnQuaWQgOiBudWxsLAogICAgICBiYWxhbmNlOiBOdW1iZXIuaXNJbnRlZ2VyKGpzb24uYmFsYW5jZSkgJiYganNvbi5iYWxhbmNlID49IDAgPyBqc29uLmJhbGFuY2UgOiBudWxsLAogICAgfTsKICB9CgogIC8vIC0tLS0tLS0tLS0g7J2A7ZaJIOqxsOuemOuCtOyXrSDtjIzsnbwgKOyXkeyFgC9DU1YpIC0tLS0tLS0tLS0KICAvLyDsnYDtlonrp4jri6Qg7ZWt66qpIOydtOumhOydtCDri6zrnbzshJwsIOuouOumrOq4gCjssqsg7KSEKeydmCDsnbTrpoTsnYQg67O06rOgIOy5uOydhCDssL7ripTri6QuCgogIGNvbnN0IENPTFVNTl9ISU5UUyA9IFsKICAgIFsnZGF0ZScsIC/qsbDrnphccyrsnbzsi5x86rGw656YXHMq7J287J6QfOqxsOuemFxzKuuCoOynnHwo6rKw7KCcfOyCrOyaqXzsnbTsmql87Iq57J24KVxzKijsnbzsi5x87J287J6QfOuCoOynnCl8XuydvOyLnCR8XuuCoOynnCR8XuydvOyekCR8XuqxsOuemOydvCQvXSwKICAgIFsndGltZScsIC9e7Iuc6rCEJHzqsbDrnphccyrsi5zqsIR8XuyLnOqwgSQvXSwKICAgIFsnY2F0ZWdvcnknLCAv6rGw656YXHMq6rWs67aEfOqxsOuemFxzKuycoO2YlXzqsbDrnphccyrsooXrpZgvXSwKICAgIFsndHlwZScsIC9e6rWs67aEJHzsnoXstpzquIhccyrqtazrtoR87J6FXHMqXC9ccyrstpzquIh8Xuyehey2nOq4iCQvXSwKICAgIFsnb3V0JywgL+y2nOq4iFxzKijslaF86riI7JWhKT8kfOywvuycvOyLoFxzKuq4iOyVoXzsp4DquIlccyoo7JWhfOq4iOyVoSk/JC9dLAogICAgWydpbicsIC/snoXquIhccyoo7JWhfOq4iOyVoSk/JHzrp6HquLDsi6BccyrquIjslaEvXSwKICAgIFsnYW1vdW50JywgL+qxsOuemFxzKuq4iOyVoXwo6rKw7KCcfOyCrOyaqXzsnbTsmql87Iq57J24KVxzKuq4iOyVoXxe6riI7JWhJC9dLAogICAgWydiYWxhbmNlJywgL+yelOyVoS9dLAogICAgLy8g7Lm07Lm07Jik7Y6Y7J20IOuTsSDqsrDsoJzrgrTsl606ICfsgqzsmqnsspgnKOqwgOunueygkCnqsIAg66y07JeH7J2EIOyDgOuKlOyngCDslYzroKQg7KO866+A66GcICfrgrTsmqkn67O064ukIOuovOyggCDsk7Tri6QKICAgIFsnbWVyY2hhbnQnLCAv7IKs7Jqp7LKYfOqwgOunueygkHzsg4HtmLh86rKw7KCc7LKYfOydtOyaqeyymC9dLAogICAgWydtZW1vJywgL17rgrTsmqkkfOqxsOuemFxzKuuCtOyaqXzsoIHsmpR867Cb64qUXHMq67aEfOuztOuCuFxzKuu2hHzqsbDrnpjssph86riw7J6sXHMq64K07JqpfOyDgeuMgC9dLAogICAgWydub3RlJywgL17rqZTrqqgkL10sCiAgXTsKCiAgZnVuY3Rpb24gY2VsbFRleHQodikgewogICAgcmV0dXJuIHYgPT09IG51bGwgfHwgdiA9PT0gdW5kZWZpbmVkID8gJycgOiBTdHJpbmcodikudHJpbSgpOwogIH0KCiAgZnVuY3Rpb24gZmluZEhlYWRlcihyb3dzKSB7CiAgICBmb3IgKGxldCByID0gMDsgciA8IE1hdGgubWluKHJvd3MubGVuZ3RoLCAzMCk7IHIrKykgewogICAgICBjb25zdCBjb2xzID0ge307CiAgICAgIChyb3dzW3JdIHx8IFtdKS5mb3JFYWNoKChjZWxsLCBjKSA9PiB7CiAgICAgICAgY29uc3QgbmFtZSA9IGNlbGxUZXh0KGNlbGwpLnJlcGxhY2UoL1xzKy9nLCAnICcpOwogICAgICAgIGlmICghbmFtZSkgcmV0dXJuOwogICAgICAgIGZvciAoY29uc3QgW2tleSwgcmVdIG9mIENPTFVNTl9ISU5UUykgewogICAgICAgICAgaWYgKGNvbHNba2V5XSA9PT0gdW5kZWZpbmVkICYmIHJlLnRlc3QobmFtZSkpIHsKICAgICAgICAgICAgY29sc1trZXldID0gYzsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9KTsKICAgICAgaWYgKGNvbHMuZGF0ZSAhPT0gdW5kZWZpbmVkICYmIChjb2xzLmFtb3VudCAhPT0gdW5kZWZpbmVkIHx8IGNvbHMub3V0ICE9PSB1bmRlZmluZWQgfHwgY29scy5pbiAhPT0gdW5kZWZpbmVkKSkgcmV0dXJuIHsgcm93OiByLCBjb2xzIH07CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIC8vIOyXkeyFgCDrgqDsp5wg7J2866Co67KI7Zi4KDQ1OTI4IOuTsSkg65iQ64qUICIyMDI2LjA5LjI4IDE0OjAyIiDqsJnsnYAg6riA7J6QIOKGkiB7IGRhdGUsIHRpbWUgfQogIGZ1bmN0aW9uIHBhcnNlRGF0ZUNlbGwodikgewogICAgaWYgKHR5cGVvZiB2ID09PSAnbnVtYmVyJyAmJiB2ID4gMjAwMDAgJiYgdiA8IDgwMDAwKSB7CiAgICAgIGNvbnN0IG1zID0gTWF0aC5yb3VuZCgodiAtIDI1NTY5KSAqIDg2NDAwMDAwKTsKICAgICAgY29uc3QgZCA9IG5ldyBEYXRlKG1zKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBkYXRlOiB0b0lTTyhkLmdldFVUQ0Z1bGxZZWFyKCksIGQuZ2V0VVRDTW9udGgoKSArIDEsIGQuZ2V0VVRDRGF0ZSgpKSwKICAgICAgICB0aW1lOiBOdW1iZXIuaXNJbnRlZ2VyKHYpID8gJycgOiBgJHtwYWQoZC5nZXRVVENIb3VycygpKX06JHtwYWQoZC5nZXRVVENNaW51dGVzKCkpfToke3BhZChkLmdldFVUQ1NlY29uZHMoKSl9YCwKICAgICAgfTsKICAgIH0KICAgIGNvbnN0IHMgPSBjZWxsVGV4dCh2KTsKICAgIGNvbnN0IG0gPSBzLm1hdGNoKC8oXGR7NH0pXHMqWy5cLS/rhYRdXHMqKFxkezEsMn0pXHMqWy5cLS/sm5RdXHMqKFxkezEsMn0pLyk7CiAgICBpZiAoIW0pIHJldHVybiBudWxsOwogICAgY29uc3QgW3ksIG1vLCBkXSA9IFtOdW1iZXIobVsxXSksIE51bWJlcihtWzJdKSwgTnVtYmVyKG1bM10pXTsKICAgIGlmICghdmFsaWREYXRlKHksIG1vLCBkKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ID0gcy5zbGljZShtLmluZGV4ICsgbVswXS5sZW5ndGgpLm1hdGNoKC8oXGR7MSwyfSk6KFxkezJ9KSg/OjooXGR7Mn0pKT8vKTsKICAgIHJldHVybiB7IGRhdGU6IHRvSVNPKHksIG1vLCBkKSwgdGltZTogdCA/IGAke3BhZCh0WzFdKX06JHt0WzJdfToke3RbM10gfHwgJzAwJ31gIDogJycgfTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQW1vdW50Q2VsbCh2KSB7CiAgICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInKSByZXR1cm4gdjsKICAgIGxldCBzID0gY2VsbFRleHQodikucmVwbGFjZSgvWyxcc+ybkF0vZywgJycpOwogICAgaWYgKCFzKSByZXR1cm4gbnVsbDsKICAgIGxldCBuZWcgPSBmYWxzZTsKICAgIGlmICgvXlwoLipcKSQvLnRlc3QocykpIHsKICAgICAgbmVnID0gdHJ1ZTsKICAgICAgcyA9IHMuc2xpY2UoMSwgLTEpOwogICAgfQogICAgY29uc3QgbiA9IE51bWJlcihzKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBuZWcgPyAtbiA6IG47CiAgfQoKICAvKgogICAqIOqxsOuemOuCtOyXrSDtkZwoMuywqOybkCDrsLDsl7Qp66W8IOuCtOyXreycvOuhnCDrsJTqvrzri6QuCiAgICogb3B0czogeyBteU5hbWUsIGFjY291bnRJZCB9CiAgICog67CY7ZmYOiB7IGl0ZW1zOiBbe2RhdGUsIHRpbWUsIGFtb3VudCwgbWVtbywga2luZCwgYWNjb3VudElkLCBiYWxhbmNlLCByYXd9XSwgc2tpcHBlZCwgaGVhZGVyLCBsYXRlc3Q6IHtkYXRlLCB0aW1lLCBiYWxhbmNlfSB8IG51bGwgfQogICAqLwogIGZ1bmN0aW9uIHBhcnNlU3RhdGVtZW50Um93cyhyb3dzLCBvcHRzID0ge30pIHsKICAgIGNvbnN0IGhlYWRlciA9IGZpbmRIZWFkZXIocm93cyk7CiAgICBpZiAoIWhlYWRlcikgcmV0dXJuIHsgaXRlbXM6IFtdLCBza2lwcGVkOiAwLCBoZWFkZXI6IG51bGwsIGxhdGVzdDogbnVsbCB9OwogICAgY29uc3QgeyBjb2xzIH0gPSBoZWFkZXI7CiAgICBjb25zdCBnZXQgPSAocm93LCBrZXkpID0+IChjb2xzW2tleV0gPT09IHVuZGVmaW5lZCA/ICcnIDogcm93W2NvbHNba2V5XV0pOwogICAgY29uc3QgaXRlbXMgPSBbXTsKICAgIGxldCBza2lwcGVkID0gMDsKICAgIGxldCBsYXRlc3QgPSBudWxsOwogICAgLy8g6riI7JWhIO2VnCDsubjsl5Ag7Lac6riI7J2AIOydjOyImOuhnCDsoIHripQg7YyM7J287J247KeAICjqt7jroIfri6TrqbQg7JaR7IiY64qUIOyeheq4iCkKICAgIGNvbnN0IHNpZ25lZCA9IGNvbHMuYW1vdW50ICE9PSB1bmRlZmluZWQgJiYgcm93cy5zbGljZShoZWFkZXIucm93ICsgMSkuc29tZSgocm93KSA9PiAocGFyc2VBbW91bnRDZWxsKChyb3cgfHwgW10pW2NvbHMuYW1vdW50XSkgfHwgMCkgPCAwKTsKCiAgICBmb3IgKGxldCByID0gaGVhZGVyLnJvdyArIDE7IHIgPCByb3dzLmxlbmd0aDsgcisrKSB7CiAgICAgIGNvbnN0IHJvdyA9IHJvd3Nbcl0gfHwgW107CiAgICAgIGlmICghcm93LnNvbWUoKGMpID0+IGNlbGxUZXh0KGMpKSkgY29udGludWU7CiAgICAgIGNvbnN0IHdoZW4gPSBwYXJzZURhdGVDZWxsKGdldChyb3csICdkYXRlJykpOwogICAgICBpZiAoIXdoZW4pIHsKICAgICAgICBza2lwcGVkICs9IDE7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKCF3aGVuLnRpbWUgJiYgY29scy50aW1lICE9PSB1bmRlZmluZWQpIHsKICAgICAgICBjb25zdCB0ID0gY2VsbFRleHQoZ2V0KHJvdywgJ3RpbWUnKSkubWF0Y2goLyhcZHsxLDJ9KTooXGR7Mn0pKD86OihcZHsyfSkpPy8pOwogICAgICAgIGlmICh0KSB3aGVuLnRpbWUgPSBgJHtwYWQodFsxXSl9OiR7dFsyXX06JHt0WzNdIHx8ICcwMCd9YDsKICAgICAgfQoKICAgICAgY29uc3QgdHlwZVRleHQgPSBjZWxsVGV4dChnZXQocm93LCAndHlwZScpKTsKICAgICAgY29uc3QgY2F0ZWdvcnlUZXh0ID0gY2VsbFRleHQoZ2V0KHJvdywgJ2NhdGVnb3J5JykpOwogICAgICBjb25zdCBvdXQgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ291dCcpKTsKICAgICAgY29uc3QgaW5uID0gcGFyc2VBbW91bnRDZWxsKGdldChyb3csICdpbicpKTsKICAgICAgY29uc3QgYW10ID0gcGFyc2VBbW91bnRDZWxsKGdldChyb3csICdhbW91bnQnKSk7CgogICAgICBsZXQga2luZDsKICAgICAgbGV0IGFtb3VudDsKICAgICAgaWYgKG91dCkgewogICAgICAgIGtpbmQgPSAnZXhwZW5zZSc7CiAgICAgICAgYW1vdW50ID0gTWF0aC5hYnMob3V0KTsKICAgICAgfSBlbHNlIGlmIChpbm4pIHsKICAgICAgICBraW5kID0gJ2luY29tZSc7CiAgICAgICAgYW1vdW50ID0gTWF0aC5hYnMoaW5uKTsKICAgICAgfSBlbHNlIGlmIChhbXQpIHsKICAgICAgICBhbW91bnQgPSBNYXRoLmFicyhhbXQpOwogICAgICAgIGlmICgv7J6F6riILy50ZXN0KHR5cGVUZXh0KSkga2luZCA9ICdpbmNvbWUnOwogICAgICAgIGVsc2UgaWYgKC/stpzquIh87KeA6riJLy50ZXN0KHR5cGVUZXh0KSkga2luZCA9ICdleHBlbnNlJzsKICAgICAgICBlbHNlIGlmIChhbXQgPCAwKSBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGVsc2Uga2luZCA9IHNpZ25lZCA/ICdpbmNvbWUnIDogJ2V4cGVuc2UnOwogICAgICB9IGVsc2UgewogICAgICAgIHNraXBwZWQgKz0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgY29uc3QgbWVyY2hhbnQgPSBjZWxsVGV4dChnZXQocm93LCAnbWVyY2hhbnQnKSk7CiAgICAgIGNvbnN0IG1lbW9NYWluID0gY2VsbFRleHQoZ2V0KHJvdywgJ21lbW8nKSk7CiAgICAgIGNvbnN0IG5vdGUgPSBjZWxsVGV4dChnZXQocm93LCAnbm90ZScpKTsKICAgICAgY29uc3QgbWVtbyA9IG1lcmNoYW50IHx8IG1lbW9NYWluIHx8IG5vdGUgfHwgY2F0ZWdvcnlUZXh0IHx8IHR5cGVUZXh0IHx8ICco64K07JqpIOyXhuydjCknOwogICAgICBjb25zdCBhbGxUZXh0ID0gYCR7dHlwZVRleHR9ICR7Y2F0ZWdvcnlUZXh0fSAke21lbW99ICR7bWVtb01haW59ICR7bm90ZX1gOwoKICAgICAgLy8g7Lm065OcIOqysOygnCDst6jshozCt+2ZmOu2iOuhnCDrk6TslrTsmKgg64+I7J2AIOyngOy2nOydhCDspITsnbTripQg6rKD7Jy866GcIOuzuOuLpAogICAgICBpZiAoa2luZCA9PT0gJ2luY29tZScgJiYgL+y3qOyGjHztmZjrtogvLnRlc3QoYWxsVGV4dCkpIHsKICAgICAgICBraW5kID0gJ2V4cGVuc2UnOwogICAgICAgIGFtb3VudCA9IC1hbW91bnQ7CiAgICAgIH0KICAgICAgaWYgKG9wdHMubXlOYW1lICYmIG1lbW8uaW5jbHVkZXMob3B0cy5teU5hbWUpICYmICEv7Lm065OcfOqysOygnHzsirnsnbgvLnRlc3QoYWxsVGV4dCkpIGtpbmQgPSAndHJhbnNmZXInOwogICAgICAvLyDtjpjsnbQg6rKw7KCc64K07JetIO2MjOydvDog7J2A7ZaJ7JeQ7IScIOyxhOybjCDrhKPsnYAg7Lap7KCE7J2AIOyngOy2nMK37IiY7J6F7J20IOyVhOuLiOudvCDrgrQg6rOE7KKMIOydtOyytAogICAgICBpZiAob3B0cy5wYXlBY2NvdW50ICYmIC/stqnsoIQvLnRlc3QoYWxsVGV4dCkgJiYgIS/st6jshox87ZmY67aILy50ZXN0KGFsbFRleHQpKSBraW5kID0gJ3RyYW5zZmVyJzsKCiAgICAgIGNvbnN0IGJhbGFuY2UgPSBwYXJzZUFtb3VudENlbGwoZ2V0KHJvdywgJ2JhbGFuY2UnKSk7CiAgICAgIGNvbnN0IGl0ZW0gPSB7CiAgICAgICAgZGF0ZTogd2hlbi5kYXRlLAogICAgICAgIHRpbWU6IHdoZW4udGltZSwKICAgICAgICBhbW91bnQsCiAgICAgICAgbWVtbywKICAgICAgICBraW5kLAogICAgICAgIGFjY291bnRJZDogb3B0cy5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICBiYWxhbmNlOiBOdW1iZXIuaXNGaW5pdGUoYmFsYW5jZSkgPyBiYWxhbmNlIDogbnVsbCwKICAgICAgICByYXc6IHJvdy5tYXAoY2VsbFRleHQpLmZpbHRlcihCb29sZWFuKS5qb2luKCcgfCAnKS5zbGljZSgwLCAzMDApLAogICAgICB9OwogICAgICBpdGVtcy5wdXNoKGl0ZW0pOwogICAgICBpZiAoaXRlbS5iYWxhbmNlICE9PSBudWxsKSB7CiAgICAgICAgY29uc3Qga2V5ID0gYCR7aXRlbS5kYXRlfSAke2l0ZW0udGltZX1gOwogICAgICAgIGlmICghbGF0ZXN0IHx8IGtleSA+PSBgJHtsYXRlc3QuZGF0ZX0gJHtsYXRlc3QudGltZX1gKSBsYXRlc3QgPSB7IGRhdGU6IGl0ZW0uZGF0ZSwgdGltZTogaXRlbS50aW1lLCBiYWxhbmNlOiBpdGVtLmJhbGFuY2UgfTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIHsgaXRlbXMsIHNraXBwZWQsIGhlYWRlciwgbGF0ZXN0IH07CiAgfQoKICAvLyBDU1Yg6riA7J6QIOKGkiAy7LCo7JuQIOuwsOyXtCAo65Sw7Ji07ZGcIOyViOydmCDsibztkZzCt+ykhOuwlOq/iCDsspjrpqwpCiAgZnVuY3Rpb24gcGFyc2VDU1YodGV4dCkgewogICAgY29uc3Qgcm93cyA9IFtdOwogICAgbGV0IHJvdyA9IFtdOwogICAgbGV0IGNlbGwgPSAnJzsKICAgIGxldCBxdW90ZWQgPSBmYWxzZTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXlx1RkVGRi8sICcnKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7IGkrKykgewogICAgICBjb25zdCBjaCA9IHNbaV07CiAgICAgIGlmIChxdW90ZWQpIHsKICAgICAgICBpZiAoY2ggPT09ICciJyAmJiBzW2kgKyAxXSA9PT0gJyInKSB7CiAgICAgICAgICBjZWxsICs9ICciJzsKICAgICAgICAgIGkgKz0gMTsKICAgICAgICB9IGVsc2UgaWYgKGNoID09PSAnIicpIHF1b3RlZCA9IGZhbHNlOwogICAgICAgIGVsc2UgY2VsbCArPSBjaDsKICAgICAgfSBlbHNlIGlmIChjaCA9PT0gJyInKSBxdW90ZWQgPSB0cnVlOwogICAgICBlbHNlIGlmIChjaCA9PT0gJywnIHx8IGNoID09PSAnXHQnKSB7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgaWYgKGNoID09PSAnXG4nIHx8IGNoID09PSAnXHInKSB7CiAgICAgICAgaWYgKGNoID09PSAnXHInICYmIHNbaSArIDFdID09PSAnXG4nKSBpICs9IDE7CiAgICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgICAgcm93cy5wdXNoKHJvdyk7CiAgICAgICAgcm93ID0gW107CiAgICAgICAgY2VsbCA9ICcnOwogICAgICB9IGVsc2UgY2VsbCArPSBjaDsKICAgIH0KICAgIGlmIChjZWxsIHx8IHJvdy5sZW5ndGgpIHsKICAgICAgcm93LnB1c2goY2VsbCk7CiAgICAgIHJvd3MucHVzaChyb3cpOwogICAgfQogICAgcmV0dXJuIHJvd3M7CiAgfQoKICAvLyDslYzrprzsnLzroZwg7J2066+4IOuTpOyWtOyYqCDrgrTsl63snbjsp4A6IOygle2Zle2eiCDqsJnqsbDrgpgsIOqwmeydgCDrgqDCt+qwmeydgCDquIjslaHCt+qwmeydgCDsooXrpZjsnbTrqbTshJwg7IKs7Jqp7LKY6rCAIOqyuey5mOqxsOuCmCDqsJnsnYAg6rOE7KKMCiAgZnVuY3Rpb24gZmluZER1cGxpY2F0ZShpdGVtLCB0cmFuc2FjdGlvbnMpIHsKICAgIGNvbnN0IG1lbW8gPSBub3JtYWxpemVNZXJjaGFudChpdGVtLm1lbW8pOwogICAgcmV0dXJuIHRyYW5zYWN0aW9ucy5maW5kKCh0KSA9PiB7CiAgICAgIGlmICh0LmRhdGUgIT09IGl0ZW0uZGF0ZSB8fCBNYXRoLmFicyh0LmFtb3VudCkgIT09IE1hdGguYWJzKGl0ZW0uYW1vdW50KSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAoa2luZE9mKHQpICE9PSBraW5kT2YoaXRlbSkpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgdG0gPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBpZiAodG0gPT09IG1lbW8gfHwgKHRtICYmIG1lbW8gJiYgKHRtLmluY2x1ZGVzKG1lbW8pIHx8IG1lbW8uaW5jbHVkZXModG0pKSkpIHJldHVybiB0cnVlOwogICAgICByZXR1cm4gISEoaXRlbS5hY2NvdW50SWQgJiYgdC5hY2NvdW50SWQgPT09IGl0ZW0uYWNjb3VudElkKTsKICAgIH0pIHx8IG51bGw7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOumrO2PrO2KuCAtLS0tLS0tLS0tCgogIC8vIO2VreuqqeuzhCDsp4DstpwgKOunjuydtCDsk7Qg7IicKS4g7IOJ7J2AIOqzhO2ajSDslYjsnZgg7Iic7IScKGNvbG9ySW5kZXgp66GcIOygle2VtCDsiJzsnITqsIAg67CU64CM7Ja064+EIOqwmeydgCDtla3rqqnsnYAg6rCZ7J2AIOyDiS4KICBmdW5jdGlvbiBjYXRlZ29yeUJyZWFrZG93bihzdW1tYXJ5KSB7CiAgICBjb25zdCByb3dzID0gc3VtbWFyeS5yb3dzLm1hcCgociwgaSkgPT4gKHsgaWQ6IHIuY2F0ZWdvcnkuaWQsIG5hbWU6IHIuY2F0ZWdvcnkubmFtZSwgYW1vdW50OiByLnNwZW50LCBjb3VudDogci5jb3VudCwgY29sb3JJbmRleDogaSB9KSk7CiAgICBpZiAoc3VtbWFyeS51bmNsYXNzaWZpZWQpIHJvd3MucHVzaCh7IGlkOiAnX19ub25lJywgbmFtZTogJ+uvuOu2hOulmCcsIGFtb3VudDogc3VtbWFyeS51bmNsYXNzaWZpZWQsIGNvdW50OiBzdW1tYXJ5LnVuY2xhc3NpZmllZENvdW50LCBjb2xvckluZGV4OiAtMSB9KTsKICAgIGNvbnN0IHRvdGFsID0gcm93cy5yZWR1Y2UoKHMsIHIpID0+IHMgKyBNYXRoLm1heCgwLCByLmFtb3VudCksIDApOwogICAgcmV0dXJuIHJvd3MKICAgICAgLmZpbHRlcigocikgPT4gci5hbW91bnQgPiAwKQogICAgICAubWFwKChyKSA9PiAoeyAuLi5yLCBzaGFyZTogdG90YWwgPyByLmFtb3VudCAvIHRvdGFsIDogMCB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYW1vdW50IC0gYS5hbW91bnQpOwogIH0KCiAgLy8g7J2067KIIOq4sOqwhOqzvCDsp4HsoIQg6riw6rCE7J2YIO2VreuqqeuzhCDruYTqtZAgKOydtOuyiCDquLDqsIQg6rOE7ZqN7J2YIO2VreuqqSDquLDspIAsIOqwmeydgCBpZCDrgbzrpqwpCiAgZnVuY3Rpb24gY29tcGFyZVdpdGhQcmV2aW91cyhzdGF0ZSwgcGVyaW9kKSB7CiAgICBjb25zdCBjdXIgPSBzdW1tYXJpemVQZXJpb2Qoc3RhdGUsIHBlcmlvZCk7CiAgICBjb25zdCBwcmV2UGVyaW9kID0gc2hpZnRQZXJpb2QocGVyaW9kLCAtMSwgc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgY29uc3QgcHJldiA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcHJldlBlcmlvZCk7CiAgICBjb25zdCBwcmV2U3BlbnQgPSB7fTsKICAgIGZvciAoY29uc3QgciBvZiBwcmV2LnJvd3MpIHByZXZTcGVudFtyLmNhdGVnb3J5LmlkXSA9IHIuc3BlbnQ7CiAgICBjb25zdCByb3dzID0gY3VyLnJvd3MubWFwKChyKSA9PiAoewogICAgICBpZDogci5jYXRlZ29yeS5pZCwKICAgICAgbmFtZTogci5jYXRlZ29yeS5uYW1lLAogICAgICBjdXJyZW50OiByLnNwZW50LAogICAgICBwcmV2aW91czogcHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDAsCiAgICAgIGRpZmY6IHIuc3BlbnQgLSAocHJldlNwZW50W3IuY2F0ZWdvcnkuaWRdIHx8IDApLAogICAgfSkpOwogICAgcmV0dXJuIHsgY3VycmVudDogY3VyLCBwcmV2aW91czogcHJldiwgcm93cywgdG90YWxEaWZmOiBjdXIudG90YWxTcGVudCAtIHByZXYudG90YWxTcGVudCB9OwogIH0KCiAgZnVuY3Rpb24gdG9wTWVyY2hhbnRzKHR4cywgbiA9IDUpIHsKICAgIGNvbnN0IG1hcCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBpZiAoa2luZE9mKHQpICE9PSAnZXhwZW5zZScpIGNvbnRpbnVlOwogICAgICBjb25zdCBrZXkgPSBub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pOwogICAgICBjb25zdCBtID0gKG1hcFtrZXldID0gbWFwW2tleV0gfHwgeyBtZW1vOiB0Lm1lbW8sIHRvdGFsOiAwLCBjb3VudDogMCB9KTsKICAgICAgbS50b3RhbCArPSB0LmFtb3VudDsKICAgICAgbS5jb3VudCArPSAxOwogICAgfQogICAgcmV0dXJuIE9iamVjdC52YWx1ZXMobWFwKS5zb3J0KChhLCBiKSA9PiBiLnRvdGFsIC0gYS50b3RhbCkuc2xpY2UoMCwgbik7CiAgfQoKICAvLyDstZzqt7wgbiDqsJwg6riw6rCEICjsmKTrnpjrkJwg6rKD67aA7YSwKTog7JiI7IKw7Jy866GcIOyeheugpe2VnCDsiJjsnoUsIOyLpOygnCDsnoXquIgsIOyngOy2nAogIGZ1bmN0aW9uIHRyZW5kKHN0YXRlLCBwZXJpb2QsIG4gPSA2KSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgY29uc3QgcCA9IHNoaWZ0UGVyaW9kKHBlcmlvZCwgLWksIHN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgY29uc3QgcyA9IHN1bW1hcml6ZVBlcmlvZChzdGF0ZSwgcCk7CiAgICAgIG91dC5wdXNoKHsgcGVyaW9kOiBwLCBidWRnZXRJbmNvbWU6IHMuaGFzSW5jb21lID8gcy5pbmNvbWUgOiBudWxsLCBpbmNvbWVSZWNlaXZlZDogcy5pbmNvbWVSZWNlaXZlZCwgc3BlbnQ6IHMudG90YWxTcGVudCB9KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDrgqDsp5zrs4Qg7ZWp6rOEOiB7ICdZWVlZLU1NLUREJzogeyBzcGVudCwgaW5jb21lLCBjb3VudCB9IH0KICBmdW5jdGlvbiBkYWlseVRvdGFscyh0eHMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCB0IG9mIHR4cykgewogICAgICBjb25zdCBkID0gKG91dFt0LmRhdGVdID0gb3V0W3QuZGF0ZV0gfHwgeyBzcGVudDogMCwgaW5jb21lOiAwLCBjb3VudDogMCB9KTsKICAgICAgY29uc3QgayA9IGtpbmRPZih0KTsKICAgICAgaWYgKGsgPT09ICdleHBlbnNlJykgZC5zcGVudCArPSB0LmFtb3VudDsKICAgICAgZWxzZSBpZiAoayA9PT0gJ2luY29tZScpIGQuaW5jb21lICs9IHQuYW1vdW50OwogICAgICBkLmNvdW50ICs9IDE7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g7J6Q7IKwOiDqs4Tsoowg7J6U7JWhIO2VqeqzhCwg7Lm065Oc67OEIOydtOuyiCDquLDqsIQg7IKs7Jqp7JWhCiAgZnVuY3Rpb24gYXNzZXRTdW1tYXJ5KHN0YXRlLCBwZXJpb2QpIHsKICAgIGNvbnN0IHR4cyA9IHR4c0luUGVyaW9kKHN0YXRlLCBwZXJpb2QpOwogICAgY29uc3QgYmFua3MgPSBzdGF0ZS5hY2NvdW50cy5maWx0ZXIoKGEpID0+IGEudHlwZSAhPT0gJ2NhcmQnKTsKICAgIGNvbnN0IGNhcmRzID0gc3RhdGUuYWNjb3VudHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09ICdjYXJkJyk7CiAgICBjb25zdCB0b3RhbCA9IGJhbmtzLnJlZHVjZSgocywgYSkgPT4gcyArICh0eXBlb2YgYS5iYWxhbmNlID09PSAnbnVtYmVyJyA/IGEuYmFsYW5jZSA6IDApLCAwKTsKICAgIGNvbnN0IHNhdmluZ3MgPSBiYW5rcy5maWx0ZXIoKGEpID0+IGEuaXNTYXZpbmdzKS5yZWR1Y2UoKHMsIGEpID0+IHMgKyAodHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiAwKSwgMCk7CiAgICBjb25zdCBzcGVuZEJ5ID0ge307CiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSBpZiAoa2luZE9mKHQpID09PSAnZXhwZW5zZScgJiYgdC5hY2NvdW50SWQpIHNwZW5kQnlbdC5hY2NvdW50SWRdID0gKHNwZW5kQnlbdC5hY2NvdW50SWRdIHx8IDApICsgdC5hbW91bnQ7CiAgICByZXR1cm4gewogICAgICB0b3RhbCwKICAgICAgc2F2aW5ncywKICAgICAgYmFua3M6IGJhbmtzLm1hcCgoYSkgPT4gKHsgLi4uYSwgc3BlbnQ6IHNwZW5kQnlbYS5pZF0gfHwgMCB9KSksCiAgICAgIGNhcmRzOiBjYXJkcy5tYXAoKGEpID0+ICh7IC4uLmEsIHNwZW50OiBzcGVuZEJ5W2EuaWRdIHx8IDAgfSkpLAogICAgICB1bmxpbmtlZFNwZW50OiB0eHMuZmlsdGVyKCh0KSA9PiBraW5kT2YodCkgPT09ICdleHBlbnNlJyAmJiAhdC5hY2NvdW50SWQpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKSwKICAgIH07CiAgfQoKICAvLyAtLS0tLS0tLS0tIOq4sOuzuCDrjbDsnbTthLAgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBkZWZhdWx0Q2F0ZWdvcmllcygpIHsKICAgIHJldHVybiBbCiAgICAgIHsgaWQ6ICdjLWhvdXNlJywgbmFtZTogJ+yjvOqxsC/qtIDrpqzruYQnLCB0eXBlOiAnZml4ZWQnLCB2YWx1ZTogNTAwMDAwLCBkZXNjcmlwdGlvbjogJ+yblOyEuCwg6rSA66as67mELCDsoITquLDCt+qwgOyKpMK37IiY64+EIOyalOq4iCcsIGtleXdvcmRzOiBbJ+yblOyEuCcsICfqtIDrpqzruYQnLCAn7KCE6riw7JqU6riIJywgJ+uPhOyLnOqwgOyKpCcsICfsiJjrj4TsmpTquIgnXSB9LAogICAgICB7IGlkOiAnYy1waG9uZScsIG5hbWU6ICfthrXsi6Av6rWs64+FJywgdHlwZTogJ2ZpeGVkJywgdmFsdWU6IDgwMDAwLCBkZXNjcmlwdGlvbjogJ+2ctOuMgO2PsCDsmpTquIgsIOyduO2EsOuEtywgT1RUwrfsnYzslYUg65OxIOygleq4sCDqtazrj4UnLCBrZXl3b3JkczogWydTS1QnLCAnS1QnLCAnTEcgVSsnLCAn7Ya17IugJywgJ+uEt+2UjOumreyKpCcsICfsnKDtipzruIwnLCAn66mc66GgJywgJ+y/oO2MoeyZgOyasCcsICfrlJTspojri4gnXSB9LAogICAgICB7IGlkOiAnYy1mb29kJywgbmFtZTogJ+yLneu5hCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiAzMCwgZGVzY3JpcHRpb246ICfsi53ri7ksIOuwsOuLrCwg7J6l67O06riwLCDtjrjsnZjsoJAg7J2M7IudJywga2V5d29yZHM6IFsn7Iud64u5JywgJ+uwsOuLrOydmOuvvOyhsScsICfrsLDrr7wnLCAn7JqU6riw7JqUJywgJ+y/oO2MoeydtOy4oCcsICfsnbTrp4jtirgnLCAn7ZmI7ZSM65+s7IqkJywgJ+uhr+uNsOuniO2KuCcsICfrp4jtirgnLCAn7Y647J2Y7KCQJywgJ0dTMjUnLCAnQ1UnLCAn7IS467iQ7J2866CI67iQJywgJ+q5gOuwpScsICfsuZjtgqgnXSB9LAogICAgICB7IGlkOiAnYy1jYWZlJywgbmFtZTogJ+y5tO2OmC/qsITsi50nLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNSwgZGVzY3JpcHRpb246ICfsu6TtlLwsIOydjOujjCwg67m1LCDrlJTsoIDtirgnLCBrZXl3b3JkczogWyfsiqTtg4DrsoXsiqQnLCAn7Yis7I24JywgJ+ydtOuUlOyVvCcsICfrqZTqsIDsu6TtlLwnLCAn66mU6rCATUdDJywgJ+y7tO2PrOymiCcsICfrub3ri6TrsKknLCAn7Lm07Y6YJywgJ+2MjOumrOuwlOqyjOucqCcsICfrmpzroIjspazrpbQnLCAn67Kg7J207Luk66asJ10gfSwKICAgICAgeyBpZDogJ2MtbW92ZScsIG5hbWU6ICfqtZDthrUnLCB0eXBlOiAncmF0aW8nLCB2YWx1ZTogNywgZGVzY3JpcHRpb246ICfrjIDspJHqtZDthrUsIO2DneyLnCwg6riw7LCoLCDso7zsnKAsIOyjvOywqCcsIGtleXdvcmRzOiBbJ+2DneyLnCcsICfsubTsubTsmKRUJywgJ+uyhOyKpCcsICfsp4DtlZjssqAnLCAn7Yuw66i464uIJywgJ+y9lOugiOydvCcsICdTUlQnLCAn7KO87JygJywgJ+yjvOywqCddIH0sCiAgICAgIHsgaWQ6ICdjLXNob3AnLCBuYW1lOiAn7Ie87ZWRJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDEwLCBkZXNjcmlwdGlvbjogJ+yYqOudvOyduCDsh7ztlZEsIOyYtywg7IOd7Zmc7Jqp7ZKILCDtmZTsnqXtkognLCBrZXl3b3JkczogWyfsv6DtjKEnLCAnMTHrsojqsIAnLCAnR+uniOy8kycsICfrrLTsi6DsgqwnLCAn7Jis66as67iM7JiBJywgJ+uLpOydtOyGjCcsICfrhKTsnbTrsoTtjpjsnbQnXSB9LAogICAgICB7IGlkOiAnYy1mdW4nLCBuYW1lOiAn66y47ZmUL+yXrOqwgCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA4LCBkZXNjcmlwdGlvbjogJ+yYge2ZlCwg6rO17JewLCDssYUsIOy3qOuvuCwg7Jes7ZaJJywga2V5d29yZHM6IFsnQ0dWJywgJ+uplOqwgOuwleyKpCcsICfroa/rjbDsi5zrhKTrp4gnLCAn6rWQ67O066y46rOgJywgJ1lFUzI0JywgJ+yVjOudvOuUmCddIH0sCiAgICAgIHsgaWQ6ICdjLXNhdmUnLCBuYW1lOiAn7KCA7LaVL+2IrOyekCcsIHR5cGU6ICdyYXRpbycsIHZhbHVlOiA0MCwgZGVzY3JpcHRpb246ICfsoIHquIgsIOyggOy2lSDsnbTssrQsIOymneq2jCDqs4Tsoowg7J6F6riILCDssq3slb0nLCBrZXl3b3JkczogWyfsoIHquIgnLCAn7KCA7LaVJywgJ+ymneq2jCcsICfssq3slb0nXSB9LAogICAgXTsKICB9CgogIGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSgpIHsKICAgIHJldHVybiB7CiAgICAgIHZlcnNpb246IDIsCiAgICAgIHNldHRpbmdzOiB7IHN0YXJ0RGF5OiAxLCBteU5hbWU6ICcnIH0sCiAgICAgIHBsYW5zOiBbeyBmcm9tOiBCQVNFX1BMQU5fRlJPTSwgcmF0aW9CYXNlOiAnYWZ0ZXJGaXhlZCcsIGZpeGVkT3ZlcmZsb3c6ICd3YXJuJywgY2F0ZWdvcmllczogZGVmYXVsdENhdGVnb3JpZXMoKSwgdXBkYXRlZEF0OiAnJyB9XSwKICAgICAgYWNjb3VudHM6IFtdLAogICAgICBpbmNvbWVzOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBbXSwKICAgICAgbWVyY2hhbnRNYXA6IHt9LAogICAgfTsKICB9CgogIC8vIOyggOyepeuQnCDrjbDsnbTthLDrpbwg7ZiE7J6sIOq1rOyhsOuhnCDrp57stpjri6QuICh2MTog6rOE7ZqN7J20IO2VmOuCmOu/kOydtOuNmCDqtazsobAg4oaSIHYyOiDquLDqsITrs4Qg6rOE7ZqNKQogIGZ1bmN0aW9uIG5vcm1hbGl6ZVN0YXRlKHJhdykgewogICAgY29uc3QgYmFzZSA9IGRlZmF1bHRTdGF0ZSgpOwogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBiYXNlOwogICAgY29uc3Qgc2V0dGluZ3MgPSByYXcuc2V0dGluZ3MgfHwge307CiAgICBjb25zdCBzdGFydERheSA9IE1hdGgubWluKDMxLCBNYXRoLm1heCgxLCBOdW1iZXIoc2V0dGluZ3Muc3RhcnREYXkpIHx8IDEpKTsKCiAgICBsZXQgcGxhbnM7CiAgICBpZiAoQXJyYXkuaXNBcnJheShyYXcucGxhbnMpICYmIHJhdy5wbGFucy5sZW5ndGgpIHsKICAgICAgcGxhbnMgPSByYXcucGxhbnM7CiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocmF3LmNhdGVnb3JpZXMpKSB7CiAgICAgIHBsYW5zID0gW3sgZnJvbTogQkFTRV9QTEFOX0ZST00sIHJhdGlvQmFzZTogc2V0dGluZ3MucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLCBjYXRlZ29yaWVzOiByYXcuY2F0ZWdvcmllcywgdXBkYXRlZEF0OiAnJyB9XTsKICAgIH0gZWxzZSB7CiAgICAgIHBsYW5zID0gYmFzZS5wbGFuczsKICAgIH0KICAgIHBsYW5zID0gcGxhbnMKICAgICAgLm1hcCgocCkgPT4gKHsKICAgICAgICBmcm9tOiBTdHJpbmcocC5mcm9tIHx8IEJBU0VfUExBTl9GUk9NKSwKICAgICAgICByYXRpb0Jhc2U6IHAucmF0aW9CYXNlID09PSAnaW5jb21lJyA/ICdpbmNvbWUnIDogJ2FmdGVyRml4ZWQnLAogICAgICAgIGZpeGVkT3ZlcmZsb3c6IHAuZml4ZWRPdmVyZmxvdyA9PT0gJ3NjYWxlJyA/ICdzY2FsZScgOiAnd2FybicsCiAgICAgICAgY2F0ZWdvcmllczogQXJyYXkuaXNBcnJheShwLmNhdGVnb3JpZXMpID8gcC5jYXRlZ29yaWVzIDogW10sCiAgICAgICAgdXBkYXRlZEF0OiBTdHJpbmcocC51cGRhdGVkQXQgfHwgJycpLAogICAgICB9KSkKICAgICAgLnNvcnQoKGEsIGIpID0+IChhLmZyb20gPCBiLmZyb20gPyAtMSA6IGEuZnJvbSA+IGIuZnJvbSA/IDEgOiAwKSk7CgogICAgY29uc3QgYWNjb3VudHMgPSAoQXJyYXkuaXNBcnJheShyYXcuYWNjb3VudHMpID8gcmF3LmFjY291bnRzIDogW10pLm1hcCgoYSkgPT4gKHsKICAgICAgaWQ6IFN0cmluZyhhLmlkKSwKICAgICAgbmFtZTogU3RyaW5nKGEubmFtZSB8fCAnJyksCiAgICAgIHR5cGU6IGEudHlwZSA9PT0gJ2NhcmQnIHx8IGEudHlwZSA9PT0gJ3BheScgPyBhLnR5cGUgOiAnYmFuaycsCiAgICAgIGxhc3Q0OiBkaWdpdHNPbmx5KGEubGFzdDQpLnNsaWNlKC00KSwKICAgICAgcGF5TmFtZTogU3RyaW5nKGEucGF5TmFtZSB8fCAnJyksCiAgICAgIGlzU2F2aW5nczogISFhLmlzU2F2aW5ncywKICAgICAgYmFsYW5jZTogdHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UgOiBudWxsLAogICAgICBiYWxhbmNlQXQ6IFN0cmluZyhhLmJhbGFuY2VBdCB8fCAnJyksCiAgICB9KSk7CgogICAgcmV0dXJuIHsKICAgICAgdmVyc2lvbjogMiwKICAgICAgc2V0dGluZ3M6IHsgc3RhcnREYXksIG15TmFtZTogU3RyaW5nKHNldHRpbmdzLm15TmFtZSB8fCAnJykgfSwKICAgICAgcGxhbnMsCiAgICAgIGFjY291bnRzLAogICAgICBpbmNvbWVzOiByYXcuaW5jb21lcyAmJiB0eXBlb2YgcmF3LmluY29tZXMgPT09ICdvYmplY3QnID8gcmF3LmluY29tZXMgOiB7fSwKICAgICAgdHJhbnNhY3Rpb25zOiBBcnJheS5pc0FycmF5KHJhdy50cmFuc2FjdGlvbnMpID8gcmF3LnRyYW5zYWN0aW9ucyA6IFtdLAogICAgICBtZXJjaGFudE1hcDogcmF3Lm1lcmNoYW50TWFwICYmIHR5cGVvZiByYXcubWVyY2hhbnRNYXAgPT09ICdvYmplY3QnID8gcmF3Lm1lcmNoYW50TWFwIDoge30sCiAgICB9OwogIH0KCiAgcmV0dXJuIHsKICAgIHRvSVNPLAogICAgcGFyc2VJU08sCiAgICBhZGREYXlzLAogICAgZGlmZkRheXMsCiAgICB0b2RheUlTTywKICAgIGRheXNJbk1vbnRoLAogICAgZ2V0UGVyaW9kLAogICAgcGF5QWNjb3VudEZvck1lbW8sCiAgICBhcHBseVBheVJ1bGVzLAogICAgcGF5Rmxvd3MsCiAgICBwYXlEb3VibGVDb3VudHMsCiAgICBwYXlUb3B1cENhbmRpZGF0ZXMsCiAgICB0eFBlcmlvZCwKICAgIHR4c0luUGVyaW9kLAogICAgc2hpZnRQZXJpb2QsCiAgICBjb21wdXRlQnVkZ2V0cywKICAgIHN1bW1hcml6ZVBlcmlvZCwKICAgIHN0YXR1c09mLAogICAgbm9ybWFsaXplTWVyY2hhbnQsCiAgICBjbGFzc2lmeSwKICAgIGNsYXNzaWZ5TG9jYWwsCiAgICBwYXJzZUV4cGVuc2VUZXh0LAogICAga2luZE9mLAogICAgbG9va3NMaWtlVHJhbnNhY3Rpb24sCiAgICBtYXRjaEFjY291bnQsCiAgICBwYXJzZU1lc3NhZ2VGYWxsYmFjaywKICAgIGlzRHVwbGljYXRlLAogICAgQkFTRV9QTEFOX0ZST00sCiAgICBwbGFuRm9yLAogICAgdW5jbGFzc2lmaWVkR3JvdXBzLAogICAgdW5jbGFzc2lmaWVkQnlQZXJpb2QsCiAgICBlbnN1cmVQbGFuRm9yLAogICAgbmV4dFBsYW5BZnRlciwKICAgIHJlbWFwUGVyaW9kS2V5cywKICAgIGJ1aWxkQ2xhc3NpZnlSZXF1ZXN0LAogICAgcmVhZENsYXNzaWZ5UmVzcG9uc2UsCiAgICBidWlsZE1lc3NhZ2VSZXF1ZXN0LAogICAgcmVhZE1lc3NhZ2VSZXNwb25zZSwKICAgIHBhcnNlU3RhdGVtZW50Um93cywKICAgIHBhcnNlQ1NWLAogICAgZmluZER1cGxpY2F0ZSwKICAgIGNhdGVnb3J5QnJlYWtkb3duLAogICAgY29tcGFyZVdpdGhQcmV2aW91cywKICAgIHRvcE1lcmNoYW50cywKICAgIHRyZW5kLAogICAgZGFpbHlUb3RhbHMsCiAgICBhc3NldFN1bW1hcnksCiAgICBkZWZhdWx0U3RhdGUsCiAgICBub3JtYWxpemVTdGF0ZSwKICB9Owp9KTsK\");</script>\n  <script>__budgetRun(\"js/charts.js\", \"Lyog7LCo7Yq4IChTVkcg66y47J6Q7Je07J2EIOunjOuToOuLpCkuIOyDieydgCBjc3Mg67OA7IiYIC0tczEgfiAtLXM3ICjtla3rqqkg7Iic7ISc64yA66GcIOqzoOyglSksIOq3uCDrsJbsnYAg7ZqM7IOJLiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IFNMT1RTID0gNzsKCiAgZnVuY3Rpb24gc2VyaWVzQ29sb3IoY29sb3JJbmRleCkgewogICAgcmV0dXJuIGNvbG9ySW5kZXggPj0gMCAmJiBjb2xvckluZGV4IDwgU0xPVFMgPyBgdmFyKC0tcyR7Y29sb3JJbmRleCArIDF9KWAgOiAndmFyKC0tZ3JheS1tYXJrKSc7CiAgfQoKICAvLyAxMiwzNDAsMDAwIOKGkiAiMSwyMzTrp4wiLCAx7Ja1IOydtOyDgeydgCAiMS4y7Ja1IgogIGZ1bmN0aW9uIHNob3J0V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHNpZ24gPSBuIDwgMCA/ICctJyA6ICcnOwogICAgaWYgKGEgPj0gMWU4KSByZXR1cm4gYCR7c2lnbn0keyhhIC8gMWU4KS50b0ZpeGVkKGEgPj0gMWU5ID8gMCA6IDEpLnJlcGxhY2UoL1wuMCQvLCAnJyl97Ja1YDsKICAgIGlmIChhID49IDFlNCkgcmV0dXJuIGAke3NpZ259JHtNYXRoLnJvdW5kKGEgLyAxZTQpLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeunjGA7CiAgICByZXR1cm4gYCR7c2lnbn0ke01hdGgucm91bmQoYSkudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyl9YDsKICB9CgogIC8vIOuLrOugpeyymOufvCDsooHsnYAg7Lm47JqpOiA2LDIwMCDihpIgIjYuMuyynCIsIDEyLDQwMCDihpIgIjEuMuunjCIsIDUxMiwwMDAg4oaSICI1MeunjCIKICBmdW5jdGlvbiB0aW55V29uKG4pIHsKICAgIGNvbnN0IGEgPSBNYXRoLmFicyhuKTsKICAgIGNvbnN0IHRyaW0gPSAoeCkgPT4geC50b0ZpeGVkKDEpLnJlcGxhY2UoL1wuMCQvLCAnJyk7CiAgICBpZiAoYSA+PSAxZTgpIHJldHVybiBgJHt0cmltKGEgLyAxZTgpfeyWtWA7CiAgICBpZiAoYSA+PSAxZTUpIHJldHVybiBgJHtNYXRoLnJvdW5kKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTQpIHJldHVybiBgJHt0cmltKGEgLyAxZTQpfeunjGA7CiAgICBpZiAoYSA+PSAxZTMpIHJldHVybiBgJHt0cmltKGEgLyAxZTMpfeyynGA7CiAgICByZXR1cm4gU3RyaW5nKE1hdGgucm91bmQoYSkpOwogIH0KCiAgZnVuY3Rpb24gbmljZU1heCh2KSB7CiAgICBpZiAodiA8PSAwKSByZXR1cm4gMTAwMDA7CiAgICBjb25zdCBwID0gTWF0aC5wb3coMTAsIE1hdGguZmxvb3IoTWF0aC5sb2cxMCh2KSkpOwogICAgZm9yIChjb25zdCBtIG9mIFsxLCAyLCAyLjUsIDUsIDEwXSkgaWYgKG0gKiBwID49IHYpIHJldHVybiBtICogcDsKICAgIHJldHVybiAxMCAqIHA7CiAgfQoKICAvLyDqtazshLEg66eJ64yAOiByb3dzID0gW3tuYW1lLCBhbW91bnQsIGNvbG9ySW5kZXh9XSAo66eO7J20IOyTtCDsiJwpLiA467KI7Ke4IOyDieu2gO2EsOuKlCAi6riw7YOAIuuhnCDtlansuZzri6QuCiAgZnVuY3Rpb24gc2hhcmVTZWdtZW50cyhyb3dzKSB7CiAgICBjb25zdCBtYWluID0gcm93cy5maWx0ZXIoKHIpID0+IHIuY29sb3JJbmRleCA+PSAwICYmIHIuY29sb3JJbmRleCA8IFNMT1RTKTsKICAgIGNvbnN0IHJlc3QgPSByb3dzLmZpbHRlcigocikgPT4gIShyLmNvbG9ySW5kZXggPj0gMCAmJiByLmNvbG9ySW5kZXggPCBTTE9UUykpOwogICAgY29uc3Qgc2VncyA9IG1haW4ubWFwKChyKSA9PiAoeyBuYW1lOiByLm5hbWUsIGFtb3VudDogci5hbW91bnQsIGNvbG9yOiBzZXJpZXNDb2xvcihyLmNvbG9ySW5kZXgpIH0pKTsKICAgIGNvbnN0IHJlc3RTdW0gPSByZXN0LnJlZHVjZSgocywgcikgPT4gcyArIHIuYW1vdW50LCAwKTsKICAgIGlmIChyZXN0U3VtID4gMCkgc2Vncy5wdXNoKHsgbmFtZTogcmVzdC5sZW5ndGggPT09IDEgPyByZXN0WzBdLm5hbWUgOiAn6riw7YOAJywgYW1vdW50OiByZXN0U3VtLCBjb2xvcjogc2VyaWVzQ29sb3IoLTEpIH0pOwogICAgcmV0dXJuIHNlZ3M7CiAgfQoKICBmdW5jdGlvbiBzaGFyZUJhcihyb3dzKSB7CiAgICBjb25zdCBzZWdzID0gc2hhcmVTZWdtZW50cyhyb3dzKTsKICAgIGNvbnN0IHRvdGFsID0gc2Vncy5yZWR1Y2UoKHMsIHIpID0+IHMgKyByLmFtb3VudCwgMCkgfHwgMTsKICAgIHJldHVybiBgPGRpdiBjbGFzcz0ic2hhcmUtYmFyIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iu2VreuqqeuzhCDsp4Dstpwg6rWs7ISxIj4ke3NlZ3MKICAgICAgLm1hcCgocywgaSkgPT4gYDxzcGFuIGRhdGEtc2VnPSIke2l9IiBzdHlsZT0iZmxleDoke3MuYW1vdW50IC8gdG90YWx9O2JhY2tncm91bmQ6JHtzLmNvbG9yfSI+PC9zcGFuPmApCiAgICAgIC5qb2luKCcnKX08L2Rpdj5gOwogIH0KCiAgLyoKICAgKiDquLDqsITrs4Qg7LaU7J20OiDquLDqsITrp4jri6QgW+yImOyehSwg7KeA7LacXSDrkZAg66eJ64yALiBkYXRhID0gW3tsYWJlbCwgaW5jb21lLCBzcGVudH1dCiAgICog66eJ64yAIOyCrOydtCAycHgg6rCE6rKpLCDsnJfrtoDrtoQgNHB4IOuRpeq4gOqyjCwg67CU64ul7J2AIOq4sOykgOyEoOyXkCDrtpnsnoQuCiAgICovCiAgZnVuY3Rpb24gdHJlbmRDaGFydChkYXRhLCB7IHdpZHRoID0gNjQwLCBoZWlnaHQgPSAyMjAgfSA9IHt9KSB7CiAgICBjb25zdCBwYWQgPSB7IHRvcDogMTIsIHJpZ2h0OiA4LCBib3R0b206IDI2LCBsZWZ0OiA0NCB9OwogICAgY29uc3QgdyA9IHdpZHRoIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgICBjb25zdCBoID0gaGVpZ2h0IC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgICBjb25zdCBtYXggPSBuaWNlTWF4KE1hdGgubWF4KDEsIC4uLmRhdGEubWFwKChkKSA9PiBNYXRoLm1heChkLmluY29tZSB8fCAwLCBkLnNwZW50IHx8IDApKSkpOwogICAgY29uc3QgeSA9ICh2KSA9PiBwYWQudG9wICsgaCAtIChNYXRoLm1heCgwLCB2KSAvIG1heCkgKiBoOwogICAgY29uc3QgYmFuZCA9IHcgLyBkYXRhLmxlbmd0aDsKICAgIGNvbnN0IGJhclcgPSBNYXRoLm1pbigyNiwgKGJhbmQgLSAxOCkgLyAyKTsKICAgIGNvbnN0IGdhcCA9IDI7CiAgICBjb25zdCBwYXJ0cyA9IFtdOwoKICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDQ7IGkrKykgewogICAgICBjb25zdCB2ID0gKG1heCAvIDQpICogaTsKICAgICAgY29uc3QgeXkgPSB5KHYpOwogICAgICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz0iZ3JpZC1saW5lIiB4MT0iJHtwYWQubGVmdH0iIHgyPSIke3dpZHRoIC0gcGFkLnJpZ2h0fSIgeTE9IiR7eXl9IiB5Mj0iJHt5eX0iLz5gKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7cGFkLmxlZnQgLSA2fSIgeT0iJHt5eSArIDR9IiB0ZXh0LWFuY2hvcj0iZW5kIj4ke3Nob3J0V29uKHYpfTwvdGV4dD5gKTsKICAgIH0KCiAgICBjb25zdCBiYXIgPSAoeCwgdiwgY29sb3IpID0+IHsKICAgICAgaWYgKCF2IHx8IHYgPD0gMCkgcmV0dXJuICcnOwogICAgICBjb25zdCB0b3AgPSB5KHYpOwogICAgICBjb25zdCBiaCA9IHBhZC50b3AgKyBoIC0gdG9wOwogICAgICBjb25zdCByID0gTWF0aC5taW4oNCwgYmgpOwogICAgICAvLyDsnITsqr0g66qo7ISc66as66eMIOuRpeq3vCDrp4nrjIAKICAgICAgcmV0dXJuIGA8cGF0aCBmaWxsPSIke2NvbG9yfSIgZD0iTSR7eH0sJHtwYWQudG9wICsgaH0gViR7dG9wICsgcn0gUSR7eH0sJHt0b3B9ICR7eCArIHJ9LCR7dG9wfSBIJHt4ICsgYmFyVyAtIHJ9IFEke3ggKyBiYXJXfSwke3RvcH0gJHt4ICsgYmFyV30sJHt0b3AgKyByfSBWJHtwYWQudG9wICsgaH0gWiIvPmA7CiAgICB9OwoKICAgIGRhdGEuZm9yRWFjaCgoZCwgaSkgPT4gewogICAgICBjb25zdCBjeCA9IHBhZC5sZWZ0ICsgYmFuZCAqIGkgKyBiYW5kIC8gMjsKICAgICAgcGFydHMucHVzaChiYXIoY3ggLSBiYXJXIC0gZ2FwIC8gMiwgZC5pbmNvbWUsICd2YXIoLS1zMSknKSk7CiAgICAgIHBhcnRzLnB1c2goYmFyKGN4ICsgZ2FwIC8gMiwgZC5zcGVudCwgJ3ZhcigtLXMyKScpKTsKICAgICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9ImF4aXMtbGFiZWwiIHg9IiR7Y3h9IiB5PSIke2hlaWdodCAtIDh9IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj4ke2QubGFiZWx9PC90ZXh0PmApOwogICAgICBwYXJ0cy5wdXNoKGA8cmVjdCBjbGFzcz0iaGl0IiBkYXRhLWk9IiR7aX0iIHg9IiR7cGFkLmxlZnQgKyBiYW5kICogaX0iIHk9IiR7cGFkLnRvcH0iIHdpZHRoPSIke2JhbmR9IiBoZWlnaHQ9IiR7aH0iLz5gKTsKICAgIH0pOwoKICAgIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3aWR0aH0gJHtoZWlnaHR9IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Iuq4sOqwhOuzhCDsiJjsnoXqs7wg7KeA7LacIj4ke3BhcnRzLmpvaW4oJycpfTwvc3ZnPmA7CiAgfQoKICByb290LkJ1ZGdldENoYXJ0cyA9IHsgc2VyaWVzQ29sb3IsIHNob3J0V29uLCB0aW55V29uLCBzaGFyZVNlZ21lbnRzLCBzaGFyZUJhciwgdHJlbmRDaGFydCB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/xlsx.js\", \"Lyog7JeR7IWAKC54bHN4KSDssqsg67KI7Ke4IOyLnO2KuOulvCAy7LCo7JuQIOuwsOyXtOuhnCDsnb3ripTri6QuIOyZuOu2gCDrnbzsnbTruIzrn6zrpqwg7JeG7J20IOu4jOudvOyasOyggCDquLDriqXrp4wg7JO064ukLgogKiAueGxzeCDripQgemlwIOyViOyXkCBYTUwg7J20IOuToCDtjIzsnbzsnbTrnbwsIHppcCDsnYQg7ZKA6rOgKERlY29tcHJlc3Npb25TdHJlYW0pIFhNTCDsnYQg7J2964qU64ukKERPTVBhcnNlcikuCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGZ1bmN0aW9uIGZhaWwoY29kZSwgbWVzc2FnZSkgewogICAgY29uc3QgZSA9IG5ldyBFcnJvcihtZXNzYWdlKTsKICAgIGUuY29kZSA9IGNvZGU7CiAgICByZXR1cm4gZTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGluZmxhdGVSYXcoYnl0ZXMpIHsKICAgIGlmICh0eXBlb2YgRGVjb21wcmVzc2lvblN0cmVhbSA9PT0gJ3VuZGVmaW5lZCcpIHsKICAgICAgdGhyb3cgZmFpbCgndW5zdXBwb3J0ZWQnLCAn7J20IOu4jOudvOyasOyggOuKlCDsl5HshYAg7YyM7J287J2EIO2SgCDsiJgg7JeG7Ja07JqULiDstZzsi6Ag7YGs66GswrfsgqztjIzrpqzrpbwg7JOw6rGw64KYLCDsl5HshYDsl5DshJwgQ1NWIOuhnCDsoIDsnqXtlbQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBCbG9iKFtieXRlc10pLnN0cmVhbSgpLnBpcGVUaHJvdWdoKG5ldyBEZWNvbXByZXNzaW9uU3RyZWFtKCdkZWZsYXRlLXJhdycpKTsKICAgIHJldHVybiBuZXcgVWludDhBcnJheShhd2FpdCBuZXcgUmVzcG9uc2Uoc3RyZWFtKS5hcnJheUJ1ZmZlcigpKTsKICB9CgogIC8vIHppcCDslYjsnZgg7YyM7J28IOuqqeuhnSDihpIgeyDsnbTrpoQ6IGFzeW5jICgpID0+IOuCtOyaqShVaW50OEFycmF5KSB9CiAgZnVuY3Rpb24gcmVhZFppcERpcmVjdG9yeShidWYpIHsKICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcoYnVmKTsKICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYnVmKTsKICAgIGxldCBlb2NkID0gLTE7CiAgICBmb3IgKGxldCBpID0gYnVmLmJ5dGVMZW5ndGggLSAyMjsgaSA+PSBNYXRoLm1heCgwLCBidWYuYnl0ZUxlbmd0aCAtIDY1NTU3KTsgaS0tKSB7CiAgICAgIGlmICh2aWV3LmdldFVpbnQzMihpLCB0cnVlKSA9PT0gMHgwNjA1NGI1MCkgewogICAgICAgIGVvY2QgPSBpOwogICAgICAgIGJyZWFrOwogICAgICB9CiAgICB9CiAgICBpZiAoZW9jZCA8IDApIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAg7YyM7J28IOq1rOyhsOulvCDsnb3sp4Ag66q77ZaI7Ja07JqULicpOwogICAgY29uc3QgY291bnQgPSB2aWV3LmdldFVpbnQxNihlb2NkICsgMTAsIHRydWUpOwogICAgbGV0IHAgPSB2aWV3LmdldFVpbnQzMihlb2NkICsgMTYsIHRydWUpOwogICAgY29uc3QgZmlsZXMgPSB7fTsKICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTsKICAgIGZvciAobGV0IG4gPSAwOyBuIDwgY291bnQ7IG4rKykgewogICAgICBpZiAodmlldy5nZXRVaW50MzIocCwgdHJ1ZSkgIT09IDB4MDIwMTRiNTApIGJyZWFrOwogICAgICBjb25zdCBtZXRob2QgPSB2aWV3LmdldFVpbnQxNihwICsgMTAsIHRydWUpOwogICAgICBjb25zdCBjb21wU2l6ZSA9IHZpZXcuZ2V0VWludDMyKHAgKyAyMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWVMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMjgsIHRydWUpOwogICAgICBjb25zdCBleHRyYUxlbiA9IHZpZXcuZ2V0VWludDE2KHAgKyAzMCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGNvbW1lbnRMZW4gPSB2aWV3LmdldFVpbnQxNihwICsgMzIsIHRydWUpOwogICAgICBjb25zdCBsb2NhbCA9IHZpZXcuZ2V0VWludDMyKHAgKyA0MiwgdHJ1ZSk7CiAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVyLmRlY29kZShieXRlcy5zdWJhcnJheShwICsgNDYsIHAgKyA0NiArIG5hbWVMZW4pKTsKICAgICAgZmlsZXNbbmFtZV0gPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc3RhcnQgPSBsb2NhbCArIDMwICsgdmlldy5nZXRVaW50MTYobG9jYWwgKyAyNiwgdHJ1ZSkgKyB2aWV3LmdldFVpbnQxNihsb2NhbCArIDI4LCB0cnVlKTsKICAgICAgICBjb25zdCBkYXRhID0gYnl0ZXMuc3ViYXJyYXkoc3RhcnQsIHN0YXJ0ICsgY29tcFNpemUpOwogICAgICAgIGlmIChtZXRob2QgPT09IDApIHJldHVybiBkYXRhOwogICAgICAgIGlmIChtZXRob2QgPT09IDgpIHJldHVybiBpbmZsYXRlUmF3KGRhdGEpOwogICAgICAgIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsp4Dsm5DtlZjsp4Ag7JWK64qUIOyVley2lSDrsKnsi53snbTsl5DsmpQuJyk7CiAgICAgIH07CiAgICAgIHAgKz0gNDYgKyBuYW1lTGVuICsgZXh0cmFMZW4gKyBjb21tZW50TGVuOwogICAgfQogICAgcmV0dXJuIGZpbGVzOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFhtbChmaWxlcywgbmFtZSkgewogICAgaWYgKCFmaWxlc1tuYW1lXSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ZXh0ID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGF3YWl0IGZpbGVzW25hbWVdKCkpOwogICAgcmV0dXJuIG5ldyBET01QYXJzZXIoKS5wYXJzZUZyb21TdHJpbmcodGV4dCwgJ2FwcGxpY2F0aW9uL3htbCcpOwogIH0KCiAgY29uc3QgdGFncyA9IChub2RlLCBuYW1lKSA9PiBBcnJheS5mcm9tKG5vZGUuZ2V0RWxlbWVudHNCeVRhZ05hbWUobmFtZSkpOwoKICBmdW5jdGlvbiBjb2x1bW5JbmRleChyZWYpIHsKICAgIGNvbnN0IGxldHRlcnMgPSBTdHJpbmcocmVmIHx8ICcnKS5tYXRjaCgvXltBLVpdKy8pOwogICAgaWYgKCFsZXR0ZXJzKSByZXR1cm4gLTE7CiAgICBsZXQgbiA9IDA7CiAgICBmb3IgKGNvbnN0IGNoIG9mIGxldHRlcnNbMF0pIG4gPSBuICogMjYgKyAoY2guY2hhckNvZGVBdCgwKSAtIDY0KTsKICAgIHJldHVybiBuIC0gMTsKICB9CgogIC8vIOyyqyDrsojsp7gg7Iuc7Yq47J2YIOqyveuhnCAod29ya2Jvb2sueG1sIOydmCDssqsgc2hlZXQg4oaSIOq0gOqzhCDtjIzsnbzsl5DshJwg7Iuk7KCcIOqyveuhnCkKICBhc3luYyBmdW5jdGlvbiBmaXJzdFNoZWV0UGF0aChmaWxlcykgewogICAgY29uc3Qgd2IgPSBhd2FpdCByZWFkWG1sKGZpbGVzLCAneGwvd29ya2Jvb2sueG1sJyk7CiAgICBjb25zdCByZWxzID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzJyk7CiAgICBpZiAod2IgJiYgcmVscykgewogICAgICBjb25zdCBzaGVldCA9IHRhZ3Mod2IsICdzaGVldCcpWzBdOwogICAgICBjb25zdCByaWQgPSBzaGVldCAmJiAoc2hlZXQuZ2V0QXR0cmlidXRlKCdyOmlkJykgfHwgc2hlZXQuZ2V0QXR0cmlidXRlTlMoJ2h0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMnLCAnaWQnKSk7CiAgICAgIGNvbnN0IHJlbCA9IHRhZ3MocmVscywgJ1JlbGF0aW9uc2hpcCcpLmZpbmQoKHIpID0+IHIuZ2V0QXR0cmlidXRlKCdJZCcpID09PSByaWQpOwogICAgICBpZiAocmVsKSB7CiAgICAgICAgY29uc3QgdGFyZ2V0ID0gcmVsLmdldEF0dHJpYnV0ZSgnVGFyZ2V0JykucmVwbGFjZSgvXlwvLywgJycpOwogICAgICAgIHJldHVybiB0YXJnZXQuc3RhcnRzV2l0aCgneGwvJykgPyB0YXJnZXQgOiBgeGwvJHt0YXJnZXR9YDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIE9iamVjdC5rZXlzKGZpbGVzKS5maWx0ZXIoKG4pID0+IC9eeGxcL3dvcmtzaGVldHNcL3NoZWV0XGQrXC54bWwkLy50ZXN0KG4pKS5zb3J0KClbMF07CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkWGxzeChhcnJheUJ1ZmZlcikgewogICAgY29uc3QgaGVhZCA9IG5ldyBVaW50OEFycmF5KGFycmF5QnVmZmVyLnNsaWNlKDAsIDQpKTsKICAgIC8vIEQwIENGIDExIEUwOiDruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgOydtOqxsOuCmCDsmJvrgqAgLnhscyDtmJXsi50KICAgIGlmIChoZWFkWzBdID09PSAweGQwICYmIGhlYWRbMV0gPT09IDB4Y2YgJiYgaGVhZFsyXSA9PT0gMHgxMSAmJiBoZWFkWzNdID09PSAweGUwKSB7CiAgICAgIHRocm93IGZhaWwoJ2VuY3J5cHRlZCcsICfruYTrsIDrsojtmLjqsIAg6rG466awIOyXkeyFgCjrmJDripQg7Jib64KgIC54bHMpIO2MjOydvOydtOyXkOyalC4g7JeR7IWA7J2064KYIOq1rOq4gCDsi5ztirjsl5DshJwg7Je07Ja0IOu5hOuwgOuyiO2YuCDsl4bsnbQgLnhsc3gg65iQ64qUIENTViDroZwg64uk7IucIOyggOyepe2VnCDrkqQg7Jis66CkIOyjvOyEuOyalC4nKTsKICAgIH0KICAgIGlmICghKGhlYWRbMF0gPT09IDB4NTAgJiYgaGVhZFsxXSA9PT0gMHg0YikpIHRocm93IGZhaWwoJ2Zvcm1hdCcsICfsl5HshYAoLnhsc3gpIO2MjOydvOydtCDslYTri4jsl5DsmpQuJyk7CgogICAgY29uc3QgZmlsZXMgPSByZWFkWmlwRGlyZWN0b3J5KGFycmF5QnVmZmVyKTsKICAgIGNvbnN0IHNoYXJlZCA9IFtdOwogICAgY29uc3Qgc3N0ID0gYXdhaXQgcmVhZFhtbChmaWxlcywgJ3hsL3NoYXJlZFN0cmluZ3MueG1sJyk7CiAgICBpZiAoc3N0KSB7CiAgICAgIGZvciAoY29uc3Qgc2kgb2YgdGFncyhzc3QsICdzaScpKSB7CiAgICAgICAgLy8g7J2964qUIOuylSDtkZzsi5woclBoKSDslYjsnZgg6riA7J6Q64qUIOu5vOqzoCDtlansuZzri6QKICAgICAgICBzaGFyZWQucHVzaCh0YWdzKHNpLCAndCcpLmZpbHRlcigodCkgPT4gISh0LnBhcmVudE5vZGUgJiYgdC5wYXJlbnROb2RlLm5vZGVOYW1lID09PSAnclBoJykpLm1hcCgodCkgPT4gdC50ZXh0Q29udGVudCkuam9pbignJykpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBwYXRoID0gYXdhaXQgZmlyc3RTaGVldFBhdGgoZmlsZXMpOwogICAgY29uc3Qgc2hlZXQgPSBwYXRoICYmIChhd2FpdCByZWFkWG1sKGZpbGVzLCBwYXRoKSk7CiAgICBpZiAoIXNoZWV0KSB0aHJvdyBmYWlsKCdmb3JtYXQnLCAn7Iuc7Yq466W8IOywvuyngCDrqrvtlojslrTsmpQuJyk7CgogICAgY29uc3Qgcm93cyA9IFtdOwogICAgZm9yIChjb25zdCByb3cgb2YgdGFncyhzaGVldCwgJ3JvdycpKSB7CiAgICAgIGNvbnN0IHIgPSBOdW1iZXIocm93LmdldEF0dHJpYnV0ZSgncicpKSAtIDE7CiAgICAgIGNvbnN0IG91dCA9IFtdOwogICAgICB0YWdzKHJvdywgJ2MnKS5mb3JFYWNoKChjLCBpKSA9PiB7CiAgICAgICAgY29uc3QgY29sID0gYy5nZXRBdHRyaWJ1dGUoJ3InKSA/IGNvbHVtbkluZGV4KGMuZ2V0QXR0cmlidXRlKCdyJykpIDogaTsKICAgICAgICBjb25zdCB0eXBlID0gYy5nZXRBdHRyaWJ1dGUoJ3QnKTsKICAgICAgICBjb25zdCB2ID0gdGFncyhjLCAndicpWzBdOwogICAgICAgIGxldCB2YWx1ZSA9ICcnOwogICAgICAgIGlmICh0eXBlID09PSAncycpIHZhbHVlID0gc2hhcmVkW051bWJlcih2ICYmIHYudGV4dENvbnRlbnQpXSB8fCAnJzsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnaW5saW5lU3RyJykgdmFsdWUgPSB0YWdzKGMsICd0JykubWFwKCh0KSA9PiB0LnRleHRDb250ZW50KS5qb2luKCcnKTsKICAgICAgICBlbHNlIGlmICh0eXBlID09PSAnc3RyJyB8fCB0eXBlID09PSAnYicgfHwgdHlwZSA9PT0gJ2UnKSB2YWx1ZSA9IHYgPyB2LnRleHRDb250ZW50IDogJyc7CiAgICAgICAgZWxzZSBpZiAodikgdmFsdWUgPSBOdW1iZXIodi50ZXh0Q29udGVudCk7CiAgICAgICAgb3V0W2NvbF0gPSB2YWx1ZTsKICAgICAgfSk7CiAgICAgIHJvd3NbciA+PSAwID8gciA6IHJvd3MubGVuZ3RoXSA9IG91dDsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHJvd3MsIChyKSA9PiBBcnJheS5mcm9tKHIgfHwgW10sIChjKSA9PiAoYyA9PT0gdW5kZWZpbmVkID8gJycgOiBjKSkpOwogIH0KCiAgLy8g7YyM7J28IO2VmOuCmOulvCDsnb3slrQgMuywqOybkCDrsLDsl7TroZwuIENTViDripQg6riA7J6QIOq3uOuMgOuhnCjtlZzquIAg7JeR7IWAIENTViDripQgRVVDLUtSIOyduCDqsr3smrDqsIAg66eO7JWEIOqwmeydtCDsi5zrj4QpCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFRhYmxlRmlsZShmaWxlKSB7CiAgICBjb25zdCBidWYgPSBhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCk7CiAgICBjb25zdCBoZWFkID0gbmV3IFVpbnQ4QXJyYXkoYnVmLnNsaWNlKDAsIDQpKTsKICAgIGNvbnN0IGlzWmlwT3JPbGUgPSAoaGVhZFswXSA9PT0gMHg1MCAmJiBoZWFkWzFdID09PSAweDRiKSB8fCAoaGVhZFswXSA9PT0gMHhkMCAmJiBoZWFkWzFdID09PSAweGNmKTsKICAgIGlmIChpc1ppcE9yT2xlIHx8IC9cLnhsc3g/JC9pLnRlc3QoZmlsZS5uYW1lKSkgcmV0dXJuIHJlYWRYbHN4KGJ1Zik7CiAgICBsZXQgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigndXRmLTgnKS5kZWNvZGUoYnVmKTsKICAgIGlmICh0ZXh0LmluY2x1ZGVzKCfvv70nKSkgewogICAgICB0cnkgewogICAgICAgIHRleHQgPSBuZXcgVGV4dERlY29kZXIoJ2V1Yy1rcicpLmRlY29kZShidWYpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyogdXRmLTgg6re464yA66GcICovCiAgICAgIH0KICAgIH0KICAgIHJldHVybiByb290LkJ1ZGdldExvZ2ljLnBhcnNlQ1NWKHRleHQpOwogIH0KCiAgcm9vdC5CdWRnZXRYbHN4ID0geyByZWFkWGxzeCwgcmVhZFRhYmxlRmlsZSB9Owp9KSh0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWxUaGlzIDogdGhpcyk7Cg==\");</script>\n  <script>__budgetRun(\"js/store.js\", \"Lyog7KCA7J6l7IaMLiDrkZAg6rCA7KeAIOuwqeyLneydhCDqsJnsnYAg7ZWo7IiY66GcIOuLpOujrOuLpC4KICogIC0gbG9jYWwgOiDsnbQg67iM65287Jqw7KCAKGxvY2FsU3RvcmFnZSnsl5Drp4wg7KCA7J6lLCDtgqTsm4zrk5zroZwg67aE66WYCiAqICAtIHJlbW90ZTog6rWs6riAIEFwcHMgU2NyaXB0IOyEnOuyhCjqtazquIAg7Iuc7Yq4KeyXkCDsoIDsnqUsIENsYXVkZSBBSSDroZwg67aE66WYLCDslYzrprwg7J6Q64+ZIOyeheugpQogKiAgICAgICAgICAgIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOygnOqzte2VmOuptCDsnpDrj5nsnLzroZwgcmVtb3RlLCDslYTri4jrqbQg7ISk7KCV7JeQ7IScIOyEnOuyhCDso7zshozrpbwg7Jew6rKwCiAqLwooZnVuY3Rpb24gKHJvb3QpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IEwgPSByb290LkJ1ZGdldExvZ2ljOwogIGNvbnN0IFNUT1JBR0VfS0VZID0gJ2J1ZGdldC1hcHAtdjEnOwogIGNvbnN0IFNFUlZFUl9LRVkgPSAnYnVkZ2V0LWFwcC1zZXJ2ZXInOwogIGNvbnN0IE1JR1JBVEVfS0VZID0gJ2J1ZGdldC1hcHAtbWlncmF0ZSc7CgogIGNvbnN0IHVpZCA9ICgpID0+IERhdGUubm93KCkudG9TdHJpbmcoMzYpICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCk7CiAgY29uc3Qgbm93SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpOwoKICBjb25zdCBLRVlfU1RPUkUgPSAnYnVkZ2V0LWFwcC1rZXknOwoKICBmdW5jdGlvbiByZWFkU2VydmVyQ29uZmlnKCkgewogICAgLy8g6rWs6riAIEFwcHMgU2NyaXB0IOqwgCDtmZTrqbTsnYQg7KeB7KCRIOykhCDrlYw6IO2CpOuKlCDso7zshowoP2tleT0pIOuYkOuKlCDsnbQg6riw6riw7JeQIOq4sOyWte2VnCDqsJIKICAgIGlmIChyb290Ll9fQlVER0VUX1NFUlZFUl9fKSB7CiAgICAgIGxldCBrZXkgPSByb290Ll9fQlVER0VUX1NFUlZFUl9fLmtleSB8fCAnJzsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoa2V5KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVlfU1RPUkUsIGtleSk7CiAgICAgICAgZWxzZSBrZXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShLRVlfU1RPUkUpIHx8ICcnOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog6riw7Ja1IOuquyDtlZjrqbQg66ek67KIIOyeheugpSAqLwogICAgICB9CiAgICAgIHJldHVybiB7IC4uLnJvb3QuX19CVURHRVRfU0VSVkVSX18sIGtleSwgZW1iZWRkZWQ6IHRydWUgfTsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFUlZFUl9LRVkpOwogICAgICBjb25zdCBjID0gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDogbnVsbDsKICAgICAgcmV0dXJuIGMgJiYgYy51cmwgJiYgYy5rZXkgPyBjIDogbnVsbDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBjb25zdCBzZXJ2ZXIgPSByZWFkU2VydmVyQ29uZmlnKCk7CgogIGNvbnN0IHN0b3JlID0gewogICAgbW9kZTogc2VydmVyID8gJ3JlbW90ZScgOiAnbG9jYWwnLAogICAgc2VydmVyLAogICAgYWlFbmFibGVkOiBmYWxzZSwKICAgIGFpTW9kZWw6ICcnLAogICAgYWlNb2RlbHM6IFtdLAogICAgYWlFcnJvcjogJycsCiAgICBzZXJ2aWNlVXJsOiBzZXJ2ZXIgPyBzZXJ2ZXIudXJsIDogJycsCiAgICBzdGF0ZTogTC5kZWZhdWx0U3RhdGUoKSwKICAgIG9uRXJyb3I6ICgpID0+IHt9LAogIH07CgogIGxldCBtZXRhVGltZXIgPSBudWxsOwoKICBmdW5jdGlvbiBjYWxsQXBpKGFjdGlvbiwgcGF5bG9hZCwgdGFyZ2V0ID0gc2VydmVyKSB7CiAgICBjb25zdCByZXEgPSB7IGtleTogdGFyZ2V0LmtleSwgYWN0aW9uLCBwYXlsb2FkOiBwYXlsb2FkIHx8IHt9IH07CiAgICBjb25zdCB1bndyYXAgPSAocikgPT4gewogICAgICBpZiAoIXIgfHwgIXIub2spIHRocm93IG5ldyBFcnJvcigociAmJiByLmVycm9yKSB8fCAn7ISc67KEIOydkeuLtSDsmKTrpZgnKTsKICAgICAgcmV0dXJuIHI7CiAgICB9OwogICAgaWYgKHRhcmdldCA9PT0gc2VydmVyICYmIHJvb3QuZ29vZ2xlICYmIHJvb3QuZ29vZ2xlLnNjcmlwdCAmJiByb290Lmdvb2dsZS5zY3JpcHQucnVuKSB7CiAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgICAgcm9vdC5nb29nbGUuc2NyaXB0LnJ1bgogICAgICAgICAgLndpdGhTdWNjZXNzSGFuZGxlcigocikgPT4gewogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHJlc29sdmUodW53cmFwKHIpKTsKICAgICAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgICAgIHJlamVjdChlKTsKICAgICAgICAgICAgfQogICAgICAgICAgfSkKICAgICAgICAgIC53aXRoRmFpbHVyZUhhbmRsZXIocmVqZWN0KQogICAgICAgICAgLmFwaShyZXEpOwogICAgICB9KTsKICAgIH0KICAgIC8vIHRleHQvcGxhaW4g7Jy866GcIOuztOuCtOuptCBDT1JTIOyCrOyghCDsmpTssq0g7JeG7J20IEFwcHMgU2NyaXB0IOuhnCDrs7Trgrwg7IiYIOyeiOuLpAogICAgcmV0dXJuIGZldGNoKHRhcmdldC51cmwsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlcSkgfSkKICAgICAgLnRoZW4oKHIpID0+IHIuanNvbigpKQogICAgICAudGhlbih1bndyYXApOwogIH0KCiAgZnVuY3Rpb24gbWV0YU9mKHMpIHsKICAgIGNvbnN0IHsgdHJhbnNhY3Rpb25zLCAuLi5tZXRhIH0gPSBzOwogICAgcmV0dXJuIG1ldGE7CiAgfQoKICBmdW5jdGlvbiBwbGFuRm9yRGF0ZShkYXRlKSB7CiAgICByZXR1cm4gTC5wbGFuRm9yKHN0b3JlLnN0YXRlLCBMLmdldFBlcmlvZChkYXRlLCBzdG9yZS5zdGF0ZS5zZXR0aW5ncy5zdGFydERheSkua2V5KTsKICB9CgogIC8vIOuCtOyXreydtCDqs4TsgrDrkJjripQg6riw6rCEKOuLpOuluCDquLDqsITsnLzroZwg7Jiu6rK87Jy866m0IOq3uCDquLDqsIQp7J2YIOqzhO2ajQogIGZ1bmN0aW9uIHBsYW5Gb3JUeCh0KSB7CiAgICByZXR1cm4gTC5wbGFuRm9yKHN0b3JlLnN0YXRlLCBMLnR4UGVyaW9kKHQsIHN0b3JlLnN0YXRlLnNldHRpbmdzLnN0YXJ0RGF5KS5rZXkpOwogIH0KCiAgZnVuY3Rpb24gc2F2ZUxvY2FsKCkgewogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU1RPUkFHRV9LRVksIEpTT04uc3RyaW5naWZ5KHN0b3JlLnN0YXRlKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIHN0b3JlLm9uRXJyb3IobmV3IEVycm9yKCfsoIDsnqXtlZjsp4Ag66q77ZaI7Iq164uI64ukLiDruIzrnbzsmrDsoIAg7KCA7J6l6rO16rCEIOyEpOygleydhCDtmZXsnbjtlZjshLjsmpQuJykpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcmVhZExvY2FsU3RhdGUoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTVE9SQUdFX0tFWSk7CiAgICAgIHJldHVybiByYXcgPyBMLm5vcm1hbGl6ZVN0YXRlKEpTT04ucGFyc2UocmF3KSkgOiBudWxsOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGFwcGx5U3RhdHVzKHIpIHsKICAgIHN0b3JlLmFpRW5hYmxlZCA9ICEhci5haTsKICAgIHN0b3JlLmFpTW9kZWwgPSByLm1vZGVsIHx8ICcnOwogICAgc3RvcmUuYWlNb2RlbHMgPSByLm1vZGVscyB8fCBbXTsKICAgIHN0b3JlLmFpRXJyb3IgPSByLmxhc3RFcnJvciB8fCAnJzsKICAgIGlmIChyLnVybCkgc3RvcmUuc2VydmljZVVybCA9IHIudXJsOwogIH0KCiAgZnVuY3Rpb24gaXNFeHBlbnNlKGl0KSB7CiAgICByZXR1cm4gIWl0LmtpbmQgfHwgaXQua2luZCA9PT0gJ2V4cGVuc2UnOwogIH0KCiAgT2JqZWN0LmFzc2lnbihzdG9yZSwgewogICAgcGxhbkZvckRhdGUsCiAgICBwbGFuRm9yVHgsCiAgICByZWFkTG9jYWxTdGF0ZSwKCiAgICBhc3luYyBpbml0KCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIHN0b3JlLnN0YXRlID0gcmVhZExvY2FsU3RhdGUoKSB8fCBMLmRlZmF1bHRTdGF0ZSgpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBjb25zdCByID0gYXdhaXQgY2FsbEFwaSgnbG9hZCcpOwogICAgICBzdG9yZS5zdGF0ZSA9IEwubm9ybWFsaXplU3RhdGUoci5zdGF0ZSk7CiAgICAgIGFwcGx5U3RhdHVzKHIpOwogICAgfSwKCiAgICAvLyDsspjsnYwg7KCR7IaN7ZWgIOuVjCDsnoXroKXtlZwg7YKk6rCAIOunnuuKlOyngCDtmZXsnbjtlZjqs6Ag6riw7Ja17ZWc64ukCiAgICBhc3luYyB1c2VLZXkoa2V5KSB7CiAgICAgIGNvbnN0IHByZXYgPSBzZXJ2ZXIua2V5OwogICAgICBzZXJ2ZXIua2V5ID0ga2V5OwogICAgICB0cnkgewogICAgICAgIGFwcGx5U3RhdHVzKGF3YWl0IGNhbGxBcGkoJ3BpbmcnKSk7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEtFWV9TVE9SRSwga2V5KTsKICAgICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgICAvKiDrrLTsi5wgKi8KICAgICAgICB9CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICBzZXJ2ZXIua2V5ID0gcHJldjsKICAgICAgICB0aHJvdyBlOwogICAgICB9CiAgICB9LAoKICAgIGZvcmdldEtleSgpIHsKICAgICAgdHJ5IHsKICAgICAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShLRVlfU1RPUkUpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog66y07IucICovCiAgICAgIH0KICAgIH0sCgogICAgYXN5bmMgc2V0QXBpS2V5KGFwaUtleSkgewogICAgICBhcHBseVN0YXR1cyhhd2FpdCBjYWxsQXBpKCdzZXRBcGlLZXknLCB7IGFwaUtleSB9KSk7CiAgICB9LAoKICAgIGFzeW5jIHNldE1vZGVsKG1vZGVsKSB7CiAgICAgIGFwcGx5U3RhdHVzKGF3YWl0IGNhbGxBcGkoJ3NldE1vZGVsJywgeyBtb2RlbCB9KSk7CiAgICB9LAoKICAgIC8vIOqzhO2ajcK37IiY7J6Fwrfqs4TsoozCt+2VmeyKtSDsoJXrs7Qg7KCA7J6lLiDshJzrsoTsl5DripQg7J6F66Cl7J20IOupiOy2mCDrkqQg7ZWcIOuyiOyXkCDrs7Trgrjri6QuCiAgICBzYXZlTWV0YSgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHJldHVybiBzYXZlTG9jYWwoKTsKICAgICAgY2xlYXJUaW1lb3V0KG1ldGFUaW1lcik7CiAgICAgIG1ldGFUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gc3RvcmUuZmx1c2hNZXRhKCksIDcwMCk7CiAgICB9LAoKICAgIGhhc1BlbmRpbmdNZXRhKCkgewogICAgICByZXR1cm4gISFtZXRhVGltZXI7CiAgICB9LAoKICAgIGFzeW5jIGZsdXNoTWV0YSgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcgfHwgIW1ldGFUaW1lcikgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQobWV0YVRpbWVyKTsKICAgICAgbWV0YVRpbWVyID0gbnVsbDsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCBjYWxsQXBpKCdzYXZlTWV0YScsIHsgbWV0YTogbWV0YU9mKHN0b3JlLnN0YXRlKSB9KTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIHN0b3JlLm9uRXJyb3IobmV3IEVycm9yKGDshKTsoJUg7KCA7J6lIOyLpO2MqDogJHtlLm1lc3NhZ2V9YCkpOwogICAgICB9CiAgICB9LAoKICAgIC8vIGl0ZW1zOiBbe2RhdGUsIGFtb3VudCwgbWVtb31dIOKGkiBbe2NhdGVnb3J5SWQsIG1ldGhvZH1dCiAgICBhc3luYyBjbGFzc2lmeShpdGVtcykgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIHJldHVybiBpdGVtcy5tYXAoKGl0KSA9PiBMLmNsYXNzaWZ5TG9jYWwoaXQubWVtbywgcGxhbkZvclR4KGl0KS5jYXRlZ29yaWVzLCBzdG9yZS5zdGF0ZS5tZXJjaGFudE1hcCkpOwogICAgICB9CiAgICAgIGF3YWl0IHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICByZXR1cm4gKGF3YWl0IGNhbGxBcGkoJ2NsYXNzaWZ5JywgeyBpdGVtcyB9KSkucmVzdWx0czsKICAgIH0sCgogICAgLy8gaXRlbXM6IFt7ZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kLCBhY2NvdW50SWQsIGNhdGVnb3J5SWQgKCdfX2F1dG8nIOydtOuptCDsnpDrj5kg67aE66WYKSwgbWV0aG9kLCBzb3VyY2UsIHJhd31dCiAgICBhc3luYyBhZGRUcmFuc2FjdGlvbnMoaXRlbXMpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICBjb25zdCBhdXRvID0gaXRlbXMuZmlsdGVyKChpdCkgPT4gaXNFeHBlbnNlKGl0KSAmJiBpdC5jYXRlZ29yeUlkID09PSAnX19hdXRvJyk7CiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgc3RvcmUuY2xhc3NpZnkoYXV0byk7CiAgICAgICAgYXV0by5mb3JFYWNoKChpdCwgaSkgPT4gT2JqZWN0LmFzc2lnbihpdCwgcmVzW2ldKSk7CiAgICAgICAgY29uc3Qgbm93ID0gbm93SVNPKCk7CiAgICAgICAgY29uc3QgYWRkZWQgPSBpdGVtcy5tYXAoKGl0KSA9PiB7CiAgICAgICAgICBjb25zdCBleHBlbnNlID0gaXNFeHBlbnNlKGl0KTsKICAgICAgICAgIGNvbnN0IGNhdGVnb3J5SWQgPSBleHBlbnNlICYmIGl0LmNhdGVnb3J5SWQgJiYgaXQuY2F0ZWdvcnlJZCAhPT0gJ19fYXV0bycgPyBpdC5jYXRlZ29yeUlkIDogbnVsbDsKICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgIGlkOiB1aWQoKSwKICAgICAgICAgICAgZGF0ZTogaXQuZGF0ZSwKICAgICAgICAgICAgYW1vdW50OiBpdC5hbW91bnQsCiAgICAgICAgICAgIG1lbW86IGl0Lm1lbW8sCiAgICAgICAgICAgIGNhdGVnb3J5SWQsCiAgICAgICAgICAgIG1ldGhvZDogY2F0ZWdvcnlJZCA/IGl0Lm1ldGhvZCB8fCAnbWFudWFsJyA6IG51bGwsCiAgICAgICAgICAgIHNvdXJjZTogaXQuc291cmNlIHx8ICdhcHAnLAogICAgICAgICAgICByYXc6IGl0LnJhdyB8fCAnJywKICAgICAgICAgICAgY3JlYXRlZEF0OiBub3csCiAgICAgICAgICAgIGNsYXNzaWZpZWRBdDogbm93LAogICAgICAgICAgICBraW5kOiBleHBlbnNlID8gJ2V4cGVuc2UnIDogaXQua2luZCwKICAgICAgICAgICAgYWNjb3VudElkOiBpdC5hY2NvdW50SWQgfHwgbnVsbCwKICAgICAgICAgIH07CiAgICAgICAgfSk7CiAgICAgICAgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLnB1c2goLi4uYWRkZWQpOwogICAgICAgIHNhdmVMb2NhbCgpOwogICAgICAgIHJldHVybiBhZGRlZDsKICAgICAgfQogICAgICBhd2FpdCBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ2FkZFRyYW5zYWN0aW9ucycsIHsgaXRlbXMgfSk7CiAgICAgIHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5wdXNoKC4uLnIuYWRkZWQpOwogICAgICByZXR1cm4gci5hZGRlZDsKICAgIH0sCgogICAgYXN5bmMgdXBkYXRlVHJhbnNhY3Rpb24oaWQsIHBhdGNoKSB7CiAgICAgIGNvbnN0IHQgPSBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMuZmluZCgoeCkgPT4geC5pZCA9PT0gaWQpOwogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgewogICAgICAgIE9iamVjdC5hc3NpZ24odCwgcGF0Y2gsIHsgY2xhc3NpZmllZEF0OiBub3dJU08oKSB9KTsKICAgICAgICBzYXZlTG9jYWwoKTsKICAgICAgICByZXR1cm4gdDsKICAgICAgfQogICAgICBhd2FpdCBzdG9yZS5mbHVzaE1ldGEoKTsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ3VwZGF0ZVRyYW5zYWN0aW9uJywgeyBpZCwgcGF0Y2ggfSk7CiAgICAgIE9iamVjdC5hc3NpZ24odCwgci50eCk7CiAgICAgIHJldHVybiB0OwogICAgfSwKCiAgICBhc3luYyBkZWxldGVUcmFuc2FjdGlvbihpZCkgewogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIGF3YWl0IGNhbGxBcGkoJ2RlbGV0ZVRyYW5zYWN0aW9uJywgeyBpZCB9KTsKICAgICAgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zID0gc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zLmZpbHRlcigoeCkgPT4geC5pZCAhPT0gaWQpOwogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ2xvY2FsJykgc2F2ZUxvY2FsKCk7CiAgICB9LAoKICAgIC8vIOq4sOqwhCDslYjsnZgg7KeA7Lac7J2EIOq3uCDquLDqsIQg6rOE7ZqN7JeQIOunnuy2sCDri6Tsi5wg67aE66WYLiDrsJjtmZg6IOuLpOyLnCDrtoTrpZjtlZwg7KeA7LacIOyImAogICAgYXN5bmMgcmVjbGFzc2lmeShwZXJpb2QsIG9ubHlVbmNsYXNzaWZpZWQpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnKSB7CiAgICAgICAgYXdhaXQgc3RvcmUuZmx1c2hNZXRhKCk7CiAgICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGxBcGkoJ3JlY2xhc3NpZnknLCB7IHN0YXJ0OiBwZXJpb2Quc3RhcnQsIGVuZDogcGVyaW9kLmVuZCwgb25seVVuY2xhc3NpZmllZCB9KTsKICAgICAgICBmb3IgKGNvbnN0IHUgb2Ygci51cGRhdGVkKSBPYmplY3QuYXNzaWduKHN0b3JlLnN0YXRlLnRyYW5zYWN0aW9ucy5maW5kKCh0KSA9PiB0LmlkID09PSB1LmlkKSB8fCB7fSwgdSk7CiAgICAgICAgcmV0dXJuIHIudXBkYXRlZC5sZW5ndGg7CiAgICAgIH0KICAgICAgY29uc3QgcGxhbiA9IEwucGxhbkZvcihzdG9yZS5zdGF0ZSwgcGVyaW9kLmtleSk7CiAgICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBjLmlkKSk7CiAgICAgIGNvbnN0IHRhcmdldHMgPSBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMuZmlsdGVyKCh0KSA9PiB7CiAgICAgICAgaWYgKEwudHhQZXJpb2QodCwgc3RvcmUuc3RhdGUuc2V0dGluZ3Muc3RhcnREYXkpLmtleSAhPT0gcGVyaW9kLmtleSB8fCBMLmtpbmRPZih0KSAhPT0gJ2V4cGVuc2UnKSByZXR1cm4gZmFsc2U7CiAgICAgICAgY29uc3QgZXhpc3RzID0ga25vd24uaGFzKHQuY2F0ZWdvcnlJZCk7CiAgICAgICAgcmV0dXJuIG9ubHlVbmNsYXNzaWZpZWQgPyAhZXhpc3RzIDogISh0Lm1ldGhvZCA9PT0gJ21hbnVhbCcgJiYgZXhpc3RzKTsKICAgICAgfSk7CiAgICAgIGNvbnN0IG5vdyA9IG5vd0lTTygpOwogICAgICAvLyDqsITtjrjqsrDsoJwg66i464uIIOy2qeyghCDstpzquIjsnYAg7ZWt66qpIOuMgOyLoCDrgrQg6rOE7KKMIOydtOyytOuhnAogICAgICB0YXJnZXRzLmZpbHRlcigodCkgPT4gTC5hcHBseVBheVJ1bGVzKHQsIHN0b3JlLnN0YXRlLmFjY291bnRzKSkuZm9yRWFjaCgodCkgPT4gT2JqZWN0LmFzc2lnbih0LCB7IGNsYXNzaWZpZWRBdDogbm93IH0pKTsKICAgICAgY29uc3QgcmVzdCA9IHRhcmdldHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKTsKICAgICAgY29uc3QgcmVzID0gcmVzdC5sZW5ndGggPyBhd2FpdCBzdG9yZS5jbGFzc2lmeShyZXN0KSA6IFtdOwogICAgICByZXN0LmZvckVhY2goKHQsIGkpID0+IE9iamVjdC5hc3NpZ24odCwgcmVzW2ldLCB7IGNsYXNzaWZpZWRBdDogbm93IH0pKTsKICAgICAgc2F2ZUxvY2FsKCk7CiAgICAgIHJldHVybiB0YXJnZXRzLmxlbmd0aDsKICAgIH0sCgogICAgYXN5bmMgcmVmcmVzaCgpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnKSBhd2FpdCBzdG9yZS5pbml0KCk7CiAgICB9LAoKICAgIC8vIOyEnOuyhCDsl7DqsrAg7ZmV7J24ICjsl7DqsrAg7KCE7J206528IOyjvOyGjOyZgCDtgqTrpbwg7KeB7KCRIOuwm+uKlOuLpCkKICAgIHBpbmcodXJsLCBrZXkpIHsKICAgICAgcmV0dXJuIGNhbGxBcGkoJ3BpbmcnLCB7fSwgeyB1cmwsIGtleSB9KTsKICAgIH0sCgogICAgY29ubmVjdCh1cmwsIGtleSwgbWlncmF0ZSkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVJWRVJfS0VZLCBKU09OLnN0cmluZ2lmeSh7IHVybCwga2V5IH0pKTsKICAgICAgaWYgKG1pZ3JhdGUpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKE1JR1JBVEVfS0VZLCAnMScpOwogICAgfSwKCiAgICBkaXNjb25uZWN0KCkgewogICAgICB0cnkgewogICAgICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFNFUlZFUl9LRVkpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgLyog66y07IucICovCiAgICAgIH0KICAgIH0sCgogICAgLy8g7ISc67KE7JeQIOyXsOqysO2VnCDsp4Htm4Qg7ZWcIOuyiDog7J20IOq4sOq4sOyXkCDsnojrjZgg642w7J207YSw66W8IOyYruq4uOyngAogICAgdGFrZU1pZ3JhdGlvbigpIHsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoc3RvcmUubW9kZSAhPT0gJ3JlbW90ZScgfHwgbG9jYWxTdG9yYWdlLmdldEl0ZW0oTUlHUkFURV9LRVkpICE9PSAnMScpIHJldHVybiBudWxsOwogICAgICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE1JR1JBVEVfS0VZKTsKICAgICAgICByZXR1cm4gcmVhZExvY2FsU3RhdGUoKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIHJldHVybiBudWxsOwogICAgICB9CiAgICB9LAoKICAgIC8vIOuwseyXhSjrmJDripQg7J20IOq4sOq4sCDrjbDsnbTthLApIOu2iOufrOyYpOq4sAogICAgYXN5bmMgaW1wb3J0U3RhdGUoaW1wb3J0ZWQpIHsKICAgICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgICBzdG9yZS5zdGF0ZSA9IGltcG9ydGVkOwogICAgICAgIHNhdmVMb2NhbCgpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBjb25zdCB0eHMgPSBpbXBvcnRlZC50cmFuc2FjdGlvbnM7CiAgICAgIHN0b3JlLnN0YXRlID0geyAuLi5pbXBvcnRlZCwgdHJhbnNhY3Rpb25zOiBzdG9yZS5zdGF0ZS50cmFuc2FjdGlvbnMgfTsKICAgICAgYXdhaXQgY2FsbEFwaSgnc2F2ZU1ldGEnLCB7IG1ldGE6IG1ldGFPZihzdG9yZS5zdGF0ZSkgfSk7CiAgICAgIGNvbnN0IGZyZXNoID0gdHhzLmZpbHRlcigodCkgPT4gIUwuaXNEdXBsaWNhdGUodCwgc3RvcmUuc3RhdGUudHJhbnNhY3Rpb25zKSk7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZnJlc2gubGVuZ3RoOyBpICs9IDIwMCkgewogICAgICAgIGF3YWl0IHN0b3JlLmFkZFRyYW5zYWN0aW9ucygKICAgICAgICAgIGZyZXNoLnNsaWNlKGksIGkgKyAyMDApLm1hcCgodCkgPT4gKHsKICAgICAgICAgICAgZGF0ZTogdC5kYXRlLAogICAgICAgICAgICBhbW91bnQ6IHQuYW1vdW50LAogICAgICAgICAgICBtZW1vOiB0Lm1lbW8sCiAgICAgICAgICAgIGtpbmQ6IEwua2luZE9mKHQpLAogICAgICAgICAgICBhY2NvdW50SWQ6IHQuYWNjb3VudElkIHx8IG51bGwsCiAgICAgICAgICAgIGNhdGVnb3J5SWQ6IHQuY2F0ZWdvcnlJZCB8fCBudWxsLAogICAgICAgICAgICBtZXRob2Q6IHQubWV0aG9kIHx8ICh0LmNhdGVnb3J5SWQgPyAnbWFudWFsJyA6IG51bGwpLAogICAgICAgICAgICBzb3VyY2U6IHQuc291cmNlIHx8ICdpbXBvcnQnLAogICAgICAgICAgICByYXc6IHQucmF3IHx8ICcnLAogICAgICAgICAgfSkpCiAgICAgICAgKTsKICAgICAgfQogICAgfSwKCiAgICByZXNldCgpIHsKICAgICAgc3RvcmUuc3RhdGUgPSBMLmRlZmF1bHRTdGF0ZSgpOwogICAgICBzYXZlTG9jYWwoKTsKICAgIH0sCiAgfSk7CgogIHJvb3QuQnVkZ2V0U3RvcmUgPSBzdG9yZTsKfSkodHlwZW9mIGdsb2JhbFRoaXMgIT09ICd1bmRlZmluZWQnID8gZ2xvYmFsVGhpcyA6IHRoaXMpOwo=\");</script>\n  <script>__budgetRun(\"js/app.js\", \"Lyog7KeA7LacIOq0gOumrCDslbEg7ZmU66m0LiDqs4TsgrDsnYAganMvbG9naWMuanMsIOyggOyepeydgCBqcy9zdG9yZS5qcywg7LCo7Yq464qUIGpzL2NoYXJ0cy5qcyAqLwooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgTCA9IHdpbmRvdy5CdWRnZXRMb2dpYzsKICBjb25zdCBDID0gd2luZG93LkJ1ZGdldENoYXJ0czsKICBjb25zdCBzdG9yZSA9IHdpbmRvdy5CdWRnZXRTdG9yZTsKICBjb25zdCBTID0gKCkgPT4gc3RvcmUuc3RhdGU7CgogIC8vIC0tLS0tLS0tLS0g7Jyg7Yu4IC0tLS0tLS0tLS0KCiAgY29uc3QgJCA9IChzZWwpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTsKICBjb25zdCAkJCA9IChzZWwpID0+IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCldOwogIGNvbnN0IHdvbiA9IChuKSA9PiBgJHtNYXRoLnJvdW5kKG4pLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpfeybkGA7CiAgY29uc3QgdWlkID0gKCkgPT4gRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KTsKICBjb25zdCBub3dJU08gPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CgogIGZ1bmN0aW9uIGVzYyhzKSB7CiAgICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgKGMpID0+ICh7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjXSkpOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBbW91bnRJbnB1dChzKSB7CiAgICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHMgfHwgJycpLnJlcGxhY2UoL1teXGQtXS9nLCAnJyk7CiAgICBpZiAoIWNsZWFuZWQgfHwgY2xlYW5lZCA9PT0gJy0nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IG4gPSBOdW1iZXIoY2xlYW5lZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlKGlzbykgewogICAgY29uc3QgeyB5LCBtLCBkIH0gPSBMLnBhcnNlSVNPKGlzbyk7CiAgICByZXR1cm4gYCR7eX0uJHtTdHJpbmcobSkucGFkU3RhcnQoMiwgJzAnKX0uJHtTdHJpbmcoZCkucGFkU3RhcnQoMiwgJzAnKX1gOwogIH0KCiAgY29uc3QgRE9XID0gWyfsnbwnLCAn7JuUJywgJ+2ZlCcsICfsiJgnLCAn66qpJywgJ+q4iCcsICfthqAnXTsKICBmdW5jdGlvbiBkb3dPZihpc28pIHsKICAgIGNvbnN0IHsgeSwgbSwgZCB9ID0gTC5wYXJzZUlTTyhpc28pOwogICAgcmV0dXJuIG5ldyBEYXRlKERhdGUuVVRDKHksIG0gLSAxLCBkKSkuZ2V0VVRDRGF5KCk7CiAgfQoKICBmdW5jdGlvbiBmbXREYXkoaXNvKSB7CiAgICBjb25zdCB7IG0sIGQgfSA9IEwucGFyc2VJU08oaXNvKTsKICAgIHJldHVybiBgJHttfeyblCAke2R97J28ICR7RE9XW2Rvd09mKGlzbyldfeyalOydvGA7CiAgfQoKICBmdW5jdGlvbiBmbXREYXRlVGltZShpc29UaW1lKSB7CiAgICBpZiAoIWlzb1RpbWUpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShpc29UaW1lKTsKICAgIGlmIChpc05hTihkKSkgcmV0dXJuICcnOwogICAgcmV0dXJuIGAke2QuZ2V0TW9udGgoKSArIDF9LyR7ZC5nZXREYXRlKCl9ICR7U3RyaW5nKGQuZ2V0SG91cnMoKSkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcoZC5nZXRNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICB9CgogIGxldCB0b2FzdFRpbWVyOwogIGZ1bmN0aW9uIHRvYXN0KG1zZywgbXMgPSAyNjAwKSB7CiAgICBjb25zdCBlbCA9ICQoJyN0b2FzdCcpOwogICAgZWwudGV4dENvbnRlbnQgPSBtc2c7CiAgICBlbC5oaWRkZW4gPSBmYWxzZTsKICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsKICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IChlbC5oaWRkZW4gPSB0cnVlKSwgbXMpOwogIH0KICBzdG9yZS5vbkVycm9yID0gKGUpID0+IHRvYXN0KGUubWVzc2FnZSwgNTAwMCk7CgogIGxldCBidXN5Q291bnQgPSAwOwogIGFzeW5jIGZ1bmN0aW9uIGJ1c3kobGFiZWwsIGZuKSB7CiAgICBidXN5Q291bnQgKz0gMTsKICAgICQoJyNidXN5JykuaGlkZGVuID0gZmFsc2U7CiAgICBpZiAobGFiZWwpIHRvYXN0KGxhYmVsLCA2MDAwMCk7CiAgICB0cnkgewogICAgICByZXR1cm4gYXdhaXQgZm4oKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgdG9hc3QoYOyYpOulmDogJHtlLm1lc3NhZ2UgfHwgZX1gLCA1MDAwKTsKICAgICAgdGhyb3cgZTsKICAgIH0gZmluYWxseSB7CiAgICAgIGJ1c3lDb3VudCAtPSAxOwogICAgICBpZiAoIWJ1c3lDb3VudCkgJCgnI2J1c3knKS5oaWRkZW4gPSB0cnVlOwogICAgICBpZiAobGFiZWwgJiYgJCgnI3RvYXN0JykudGV4dENvbnRlbnQgPT09IGxhYmVsKSAkKCcjdG9hc3QnKS5oaWRkZW4gPSB0cnVlOwogICAgfQogIH0KCiAgLy8gYnVzeSDqsIAg7J2066+4IOyYpOulmOulvCDslYzroLjsnLzrr4DroZwg7J2067Kk7Yq4IO2VuOuTpOufrOyXkOyEnOuKlCDsgrztgqjri6QKICBjb25zdCBxdWlldCA9IChmbikgPT4gKC4uLmFyZ3MpID0+IFByb21pc2UucmVzb2x2ZShmbiguLi5hcmdzKSkuY2F0Y2goKCkgPT4ge30pOwoKICBmdW5jdGlvbiBmb3JtYXRPbkJsdXIoaW5wdXQpIHsKICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiB7CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KGlucHV0LnZhbHVlKTsKICAgICAgaWYgKG4gIT09IG51bGwpIGlucHV0LnZhbHVlID0gbi50b0xvY2FsZVN0cmluZygna28tS1InKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gY29weVRleHQodGV4dCwgaW5wdXQpIHsKICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB0b2FzdCgn67O17IKs7ZaI7Iq164uI64ukLicpOwogICAgY29uc3QgZmFsbGJhY2sgPSAoKSA9PiB7CiAgICAgIGlucHV0LnNlbGVjdCgpOwogICAgICB0cnkgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjb3B5Jyk7CiAgICAgICAgZG9uZSgpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgdG9hc3QoJ+q4uOqyjCDriIzrn6wg7KeB7KCRIOuzteyCrO2VtCDso7zshLjsmpQuJyk7CiAgICAgIH0KICAgIH07CiAgICBpZiAobmF2aWdhdG9yLmNsaXBib2FyZCkgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCkudGhlbihkb25lLCBmYWxsYmFjayk7CiAgICBlbHNlIGZhbGxiYWNrKCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyDge2DnCAtLS0tLS0tLS0tCgogIGxldCBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCAxKTsKICBsZXQgY3VycmVudFBhZ2UgPSAnaG9tZSc7CiAgbGV0IHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgY29uc3QgbGlzdFN0YXRlID0geyBzZWFyY2g6ICcnLCBraW5kOiAnYWxsJywgY2F0ZWdvcnk6ICdhbGwnLCBhY2NvdW50OiAnYWxsJyB9OwogIGxldCBtYW51YWxLaW5kID0gJ2V4cGVuc2UnOwoKICBjb25zdCBwbGFuRm9yRGF0ZSA9IChkYXRlKSA9PiBzdG9yZS5wbGFuRm9yRGF0ZShkYXRlKTsKICBjb25zdCBwbGFuRm9yVHggPSAodCkgPT4gc3RvcmUucGxhbkZvclR4KHQpOwogIGNvbnN0IGN1cnJlbnRQbGFuID0gKCkgPT4gTC5wbGFuRm9yKFMoKSwgY3VycmVudFBlcmlvZC5rZXkpOwoKICBmdW5jdGlvbiBjYXRlZ29yeUluZm8oaWQsIGNhdGVnb3JpZXMgPSBjdXJyZW50UGxhbigpLmNhdGVnb3JpZXMpIHsKICAgIGNvbnN0IGkgPSBjYXRlZ29yaWVzLmZpbmRJbmRleCgoYykgPT4gYy5pZCA9PT0gaWQpOwogICAgcmV0dXJuIGkgPj0gMCA/IHsgbmFtZTogY2F0ZWdvcmllc1tpXS5uYW1lLCBjb2xvckluZGV4OiBpIH0gOiB7IG5hbWU6ICfrr7jrtoTrpZgnLCBjb2xvckluZGV4OiAtMSB9OwogIH0KCiAgZnVuY3Rpb24gYWNjb3VudE5hbWUoaWQpIHsKICAgIGNvbnN0IGEgPSBTKCkuYWNjb3VudHMuZmluZCgoeCkgPT4geC5pZCA9PT0gaWQpOwogICAgcmV0dXJuIGEgPyBhLm5hbWUgfHwgYCR7YS50eXBlID09PSAnY2FyZCcgPyAn7Lm065OcJyA6ICfqs4TsoownfSAke2EubGFzdDR9YCA6ICcnOwogIH0KCiAgZnVuY3Rpb24gY2F0ZWdvcnlPcHRpb25zKGNhdGVnb3JpZXMsIHNlbGVjdGVkLCB7IGluY2x1ZGVBdXRvID0gZmFsc2UgfSA9IHt9KSB7CiAgICBjb25zdCBvcHRzID0gW107CiAgICBpZiAoaW5jbHVkZUF1dG8pIG9wdHMucHVzaChgPG9wdGlvbiB2YWx1ZT0iX19hdXRvIj7snpDrj5kg67aE66WYJHtzdG9yZS5haUVuYWJsZWQgPyAnIChBSSknIDogJyd9PC9vcHRpb24+YCk7CiAgICBvcHRzLnB1c2goYDxvcHRpb24gdmFsdWU9IiIgJHshc2VsZWN0ZWQgPyAnc2VsZWN0ZWQnIDogJyd9PuuvuOu2hOulmDwvb3B0aW9uPmApOwogICAgZm9yIChjb25zdCBjIG9mIGNhdGVnb3JpZXMpIG9wdHMucHVzaChgPG9wdGlvbiB2YWx1ZT0iJHtlc2MoYy5pZCl9IiAke2MuaWQgPT09IHNlbGVjdGVkID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApOwogICAgcmV0dXJuIG9wdHMuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBhY2NvdW50T3B0aW9ucyhzZWxlY3RlZCwgZW1wdHlMYWJlbCA9ICfshKDtg50g7JWIIO2VqCcpIHsKICAgIHJldHVybiBbYDxvcHRpb24gdmFsdWU9IiI+JHtlbXB0eUxhYmVsfTwvb3B0aW9uPmBdCiAgICAgIC5jb25jYXQoUygpLmFjY291bnRzLm1hcCgoYSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGEuaWQpfSIgJHthLmlkID09PSBzZWxlY3RlZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYWNjb3VudE5hbWUoYS5pZCkpfTwvb3B0aW9uPmApKQogICAgICAuam9pbignJyk7CiAgfQoKICBjb25zdCBNRVRIT0RfTEFCRUwgPSB7IGFpOiAnQUknLCBsZWFybmVkOiAn6rec7LmZJywga2V5d29yZDogJ+2CpOybjOuTnCcsIG1hbnVhbDogJ+yngeygkScgfTsKICBjb25zdCBtZXRob2RUYWcgPSAobSkgPT4gKG0gJiYgTUVUSE9EX0xBQkVMW21dID8gYDxzcGFuIGNsYXNzPSJ0YWciPiR7TUVUSE9EX0xBQkVMW21dfTwvc3Bhbj5gIDogJycpOwoKICAvLyAtLS0tLS0tLS0tIO2OmOydtOyngCDsnbTrj5kgLS0tLS0tLS0tLQoKICBjb25zdCBQQUdFUyA9IHsKICAgIGhvbWU6IHsgdGl0bGU6ICftmYgnLCBwZXJpb2Q6IHRydWUgfSwKICAgIGNhbGVuZGFyOiB7IHRpdGxlOiAn64us66ClJywgcGVyaW9kOiB0cnVlIH0sCiAgICBsaXN0OiB7IHRpdGxlOiAn64K07JetJywgcGVyaW9kOiB0cnVlIH0sCiAgICBzb3J0OiB7IHRpdGxlOiAn66+467aE66WYIOygleumrCcsIHBlcmlvZDogdHJ1ZSB9LAogICAgcmVwb3J0OiB7IHRpdGxlOiAn66as7Y+s7Yq4JywgcGVyaW9kOiB0cnVlIH0sCiAgICBhc3NldHM6IHsgdGl0bGU6ICfsnpDsgrAnLCBwZXJpb2Q6IHRydWUgfSwKICAgIHBsYW46IHsgdGl0bGU6ICfsmIjsgrAg6rOE7ZqNJywgcGVyaW9kOiB0cnVlIH0sCiAgICBhZGQ6IHsgdGl0bGU6ICfsp4DstpzCt+yImOyehSDsnoXroKUnLCBwZXJpb2Q6IGZhbHNlIH0sCiAgICBzZXR0aW5nczogeyB0aXRsZTogJ+yEpOyglScsIHBlcmlvZDogZmFsc2UgfSwKICB9OwoKICBmdW5jdGlvbiBzaG93UGFnZShuYW1lLCB7IHB1c2ggPSB0cnVlLCBrZWVwUGVyaW9kID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoIVBBR0VTW25hbWVdKSBuYW1lID0gJ2hvbWUnOwogICAgY3VycmVudFBhZ2UgPSBuYW1lOwogICAgLy8g66+467aE66WYIOygleumrOuKlCDrk6TslrTsmKwg65WM66eI64ukIOydtOuyiCDquLDqsIQo7ISk7KCV7ZWcIOyLnOyekeydvCDquLDspIAp67aA7YSwIOuztOyXrOykgOuLpAogICAgaWYgKG5hbWUgPT09ICdzb3J0JyAmJiAha2VlcFBlcmlvZCkgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICQkKCcucGFnZScpLmZvckVhY2goKHApID0+IHAuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgcC5kYXRhc2V0LnBhZ2UgPT09IG5hbWUpKTsKICAgICQkKCcubmF2LWl0ZW0nKS5mb3JFYWNoKChiKSA9PiBiLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGIuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkJCgnLmJvdHRvbS1uYXYgW2RhdGEtcGFnZV0nKS5mb3JFYWNoKChiKSA9PiBiLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGIuZGF0YXNldC5wYWdlID09PSBuYW1lKSk7CiAgICAkKCcjcGFnZS10aXRsZScpLnRleHRDb250ZW50ID0gUEFHRVNbbmFtZV0udGl0bGU7CiAgICAkKCcjcGVyaW9kLW5hdicpLmhpZGRlbiA9ICFQQUdFU1tuYW1lXS5wZXJpb2Q7CiAgICBjbG9zZU1lbnUoKTsKICAgIC8vIOq1rOq4gCBBcHBzIFNjcmlwdCDtmZTrqbQoaWZyYW1lKeyymOufvCDso7zshozrpbwg66q7IOuwlOq+uOuKlCDqs7Psl5DshJzrj4Qg7J2064+Z7J2AIOuQmOqyjAogICAgdHJ5IHsKICAgICAgaWYgKHB1c2ggJiYgbG9jYXRpb24uaGFzaCAhPT0gYCMke25hbWV9YCkgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwgJycsIGAjJHtuYW1lfWApOwogICAgfSBjYXRjaCAoZSkgewogICAgICAvKiDrrLTsi5wgKi8KICAgIH0KICAgIHdpbmRvdy5zY3JvbGxUbygwLCAwKTsKICAgIHJlbmRlcigpOwogIH0KCiAgZnVuY3Rpb24gb3Blbk1lbnUoKSB7CiAgICAkKCcjc2lkZWJhcicpLmNsYXNzTGlzdC5hZGQoJ29wZW4nKTsKICAgICQoJyNzY3JpbScpLmhpZGRlbiA9IGZhbHNlOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VNZW51KCkgewogICAgJCgnI3NpZGViYXInKS5jbGFzc0xpc3QucmVtb3ZlKCdvcGVuJyk7CiAgICAkKCcjc2NyaW0nKS5oaWRkZW4gPSB0cnVlOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDqs7XthrUg66i466asIC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyQ2hyb21lKCkgewogICAgY29uc3QgY2hpcCA9ICQoJyNjb25uLXN0YXR1cycpOwogICAgaWYgKHN0b3JlLm1vZGUgPT09ICdsb2NhbCcpIHsKICAgICAgY2hpcC50ZXh0Q29udGVudCA9ICfsnbQg6riw6riw7JeQ66eMIOyggOyepSc7CiAgICAgIGNoaXAuY2xhc3NOYW1lID0gJ2NoaXAnOwogICAgfSBlbHNlIHsKICAgICAgY2hpcC50ZXh0Q29udGVudCA9IHN0b3JlLmFpRW5hYmxlZCA/ICfqtazquIAg7Iuc7Yq4IMK3IEFJIOu2hOulmCcgOiAn6rWs6riAIOyLnO2KuCDCtyBBSSDqurzsp5AnOwogICAgICBjaGlwLmNsYXNzTmFtZSA9IGBjaGlwICR7c3RvcmUuYWlFbmFibGVkID8gJ29uJyA6ICcnfWA7CiAgICB9CiAgICAkKCcjcmVmcmVzaC1idG4nKS5oaWRkZW4gPSBzdG9yZS5tb2RlICE9PSAncmVtb3RlJzsKICAgIGNvbnN0IHVuc29ydGVkID0gTC51bmNsYXNzaWZpZWRCeVBlcmlvZChTKCkpLnJlZHVjZSgobiwgZSkgPT4gbiArIGUuY291bnQsIDApOwogICAgJCgnI3NvcnQtY291bnQnKS50ZXh0Q29udGVudCA9IHVuc29ydGVkID4gOTkgPyAnOTkrJyA6IFN0cmluZyh1bnNvcnRlZCk7CiAgICAkKCcjc29ydC1jb3VudCcpLmhpZGRlbiA9ICF1bnNvcnRlZDsKCiAgICBjb25zdCBwID0gY3VycmVudFBlcmlvZDsKICAgICQoJyNwZXJpb2QtdGV4dCcpLnRleHRDb250ZW50ID0gYCR7Zm10RGF0ZShwLnN0YXJ0KX0gfiAke2ZtdERhdGUocC5lbmQpLnNsaWNlKDUpfWA7CiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGxldCBzdWI7CiAgICBpZiAodG9kYXkgPj0gcC5zdGFydCAmJiB0b2RheSA8PSBwLmVuZCkgc3ViID0gYOydtOuyiCDquLDqsIQgwrcgJHtMLmRpZmZEYXlzKHRvZGF5LCBwLmVuZCkgKyAxfeydvCDrgqjsnYxgOwogICAgZWxzZSBpZiAodG9kYXkgPiBwLmVuZCkgc3ViID0gJ+yngOuCnCDquLDqsIQnOwogICAgZWxzZSBzdWIgPSAn64uk6rCA7Jik64qUIOq4sOqwhCc7CiAgICAkKCcjcGVyaW9kLXN1YicpLnRleHRDb250ZW50ID0gc3ViOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDtiLTtjIEgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBhdHRhY2hUb29sdGlwKGVsLCBodG1sKSB7CiAgICBjb25zdCB0aXAgPSAkKCcjdG9vbHRpcCcpOwogICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsKICAgICAgdGlwLmlubmVySFRNTCA9IGh0bWwoKTsKICAgICAgdGlwLmhpZGRlbiA9IGZhbHNlOwogICAgfSk7CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCAoZSkgPT4gewogICAgICBjb25zdCB4ID0gTWF0aC5taW4oZS5jbGllbnRYICsgMTQsIHdpbmRvdy5pbm5lcldpZHRoIC0gdGlwLm9mZnNldFdpZHRoIC0gOCk7CiAgICAgIHRpcC5zdHlsZS5sZWZ0ID0gYCR7eH1weGA7CiAgICAgIHRpcC5zdHlsZS50b3AgPSBgJHtlLmNsaWVudFkgKyAxNH1weGA7CiAgICB9KTsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiAodGlwLmhpZGRlbiA9IHRydWUpKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g6rGw656YIO2VnCDspIQgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiB0eFJvdyh0LCB7IGVkaXRhYmxlID0gdHJ1ZSB9ID0ge30pIHsKICAgIGNvbnN0IGtpbmQgPSBMLmtpbmRPZih0KTsKICAgIGNvbnN0IGNhdHMgPSBwbGFuRm9yVHgodCkuY2F0ZWdvcmllczsKICAgIGNvbnN0IGluZm8gPSBjYXRlZ29yeUluZm8odC5jYXRlZ29yeUlkLCBjYXRzKTsKICAgIGxldCBpY29uOwogICAgbGV0IGFtb3VudDsKICAgIGlmIChraW5kID09PSAnaW5jb21lJykgewogICAgICBpY29uID0gJzxkaXYgY2xhc3M9InR4LWljb24iIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWFjY2VudCkiPis8L2Rpdj4nOwogICAgICBhbW91bnQgPSBgPHNwYW4gY2xhc3M9InR4LWFtb3VudCBwbHVzIj4rJHt3b24odC5hbW91bnQpfTwvc3Bhbj5gOwogICAgfSBlbHNlIGlmIChraW5kID09PSAndHJhbnNmZXInKSB7CiAgICAgIGljb24gPSAnPGRpdiBjbGFzcz0idHgtaWNvbiBncmF5Ij7ihpQ8L2Rpdj4nOwogICAgICBhbW91bnQgPSBgPHNwYW4gY2xhc3M9InR4LWFtb3VudCBuZXV0cmFsIj4ke3dvbih0LmFtb3VudCl9PC9zcGFuPmA7CiAgICB9IGVsc2UgewogICAgICBpY29uID0gYDxkaXYgY2xhc3M9InR4LWljb24gJHtpbmZvLmNvbG9ySW5kZXggPCAwID8gJ2dyYXknIDogJyd9IiBzdHlsZT0iJHtpbmZvLmNvbG9ySW5kZXggPj0gMCA/IGBiYWNrZ3JvdW5kOiR7Qy5zZXJpZXNDb2xvcihpbmZvLmNvbG9ySW5kZXgpfWAgOiAnJ30iPiR7ZXNjKGluZm8ubmFtZS5zbGljZSgwLCAxKSl9PC9kaXY+YDsKICAgICAgYW1vdW50ID0gYDxzcGFuIGNsYXNzPSJ0eC1hbW91bnQgJHt0LmFtb3VudCA8IDAgPyAncGx1cycgOiAnJ30iPiR7dC5hbW91bnQgPCAwID8gJysnIDogJyd9JHt3b24oTWF0aC5hYnModC5hbW91bnQpKX08L3NwYW4+YDsKICAgIH0KICAgIGNvbnN0IG1ldGEgPSBbXTsKICAgIGlmIChlZGl0YWJsZSkgewogICAgICAvLyDtla3rqqnqs7wg7KKF66WYKOyeheq4iMK37J207LK0KeulvCDtlZwg7Lm47JeQ7IScIOqzoOuluOuLpAogICAgICBjb25zdCBjdXJyZW50ID0ga2luZCAhPT0gJ2V4cGVuc2UnID8gYGtpbmQ6JHtraW5kfWAgOiBpbmZvLmNvbG9ySW5kZXggPj0gMCA/IHQuY2F0ZWdvcnlJZCA6ICcnOwogICAgICBtZXRhLnB1c2goYDxzZWxlY3QgY2xhc3M9InR4LWNhdCIgZGF0YS1pZD0iJHtlc2ModC5pZCl9IiBhcmlhLWxhYmVsPSLtla3rqqkiPgogICAgICAgICR7Y2F0ZWdvcnlPcHRpb25zKGNhdHMsIGN1cnJlbnQpfQogICAgICAgIDxvcHRncm91cCBsYWJlbD0i7KeA7Lac7J20IOyVhOuLmCI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJraW5kOmluY29tZSIgJHtjdXJyZW50ID09PSAna2luZDppbmNvbWUnID8gJ3NlbGVjdGVkJyA6ICcnfT7snoXquIg8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtpbmQ6dHJhbnNmZXIiICR7Y3VycmVudCA9PT0gJ2tpbmQ6dHJhbnNmZXInID8gJ3NlbGVjdGVkJyA6ICcnfT7rgrQg6rOE7KKMIOydtOyytDwvb3B0aW9uPgogICAgICAgIDwvb3B0Z3JvdXA+CiAgICAgIDwvc2VsZWN0PmApOwogICAgfSBlbHNlIHsKICAgICAgbWV0YS5wdXNoKGVzYyhraW5kID09PSAnaW5jb21lJyA/ICfsnoXquIgnIDoga2luZCA9PT0gJ3RyYW5zZmVyJyA/ICfrgrQg6rOE7KKMIOydtOyytCcgOiBpbmZvLm5hbWUpKTsKICAgIH0KICAgIGlmIChraW5kID09PSAnZXhwZW5zZScgJiYgaW5mby5jb2xvckluZGV4ID49IDApIG1ldGEucHVzaChtZXRob2RUYWcodC5tZXRob2QpKTsKICAgIGlmICh0LmFjY291bnRJZCAmJiBhY2NvdW50TmFtZSh0LmFjY291bnRJZCkpIG1ldGEucHVzaChgPHNwYW4+JHtlc2MoYWNjb3VudE5hbWUodC5hY2NvdW50SWQpKX08L3NwYW4+YCk7CiAgICBpZiAodC5zb3VyY2UgPT09ICdzbXMnIHx8IHQuc291cmNlID09PSAnYmFuaycpIG1ldGEucHVzaChgPHNwYW4gY2xhc3M9InRhZyI+JHt0LnNvdXJjZSA9PT0gJ2JhbmsnID8gJ+ydgO2WiSDslYzrprwnIDogJ+usuOyekCd9PC9zcGFuPmApOwogICAgLy8g64Kg7Kec64qUIOq3uOuMgOuhnCDrkZDqs6Ag6rOE7IKw7ZWgIOq4sOqwhOunjCDslZ7rkqTroZwg7Jiu6ri064ukICjsmIg6IOyLnOyekeydvCDtlZjro6gg7KCE7JeQIOuTpOyWtOyYqCDsm5TquIkpCiAgICBjb25zdCBzaGlmdCA9IE1hdGgudHJ1bmMoTnVtYmVyKHQucGVyaW9kU2hpZnQpIHx8IDApOwogICAgaWYgKGVkaXRhYmxlKSB7CiAgICAgIGNvbnN0IHNkID0gUygpLnNldHRpbmdzLnN0YXJ0RGF5OwogICAgICBjb25zdCBvd24gPSBMLmdldFBlcmlvZCh0LmRhdGUsIHNkKTsKICAgICAgY29uc3Qgc2hvcnQgPSAobikgPT4gewogICAgICAgIGNvbnN0IHEgPSBMLnBhcnNlSVNPKChuID8gTC5zaGlmdFBlcmlvZChvd24sIG4sIHNkKSA6IG93bikuc3RhcnQpOwogICAgICAgIHJldHVybiBgJHtxLm19LyR7cS5kfX5gOwogICAgICB9OwogICAgICBjb25zdCBzaGlmdHMgPSBbLi4ubmV3IFNldChbLTEsIDAsIDEsIHNoaWZ0XSldLnNvcnQoKGEsIGIpID0+IGEgLSBiKTsKICAgICAgbWV0YS5wdXNoKGA8c2VsZWN0IGNsYXNzPSJ0eC1tb3ZlIiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9IuqzhOyCsO2VoCDquLDqsIQiPgogICAgICAgICR7c2hpZnRzLm1hcCgobikgPT4gYDxvcHRpb24gdmFsdWU9IiR7bn0iICR7biA9PT0gc2hpZnQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7biA9PT0gMCA/IGDsi6TsoJwg64Kg7KecIOq4sOqwhCgke3Nob3J0KDApfSlgIDogYCR7c2hvcnQobil9IOq4sOqwhOycvOuhnCDsmK7quYBgfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICA8L3NlbGVjdD5gKTsKICAgIH0gZWxzZSBpZiAoc2hpZnQpIHsKICAgICAgbWV0YS5wdXNoKGA8c3BhbiBjbGFzcz0idGFnIj4ke3NoaWZ0ID4gMCA/ICfri6TsnYwnIDogJ+ydtOyghCd9IOq4sOqwhOycvOuhnCDsmK7quYA8L3NwYW4+YCk7CiAgICB9CiAgICByZXR1cm4gYAogICAgICA8ZGl2IGNsYXNzPSJ0eCI+CiAgICAgICAgJHtpY29ufQogICAgICAgIDxkaXYgY2xhc3M9InR4LW1haW4iPgogICAgICAgICAgPGRpdiBjbGFzcz0idHgtbWVtbyI+JHtlc2ModC5tZW1vKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InR4LW1ldGEiPiR7bWV0YS5qb2luKCcnKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0eC1yaWdodCI+CiAgICAgICAgICAke2Ftb3VudH0KICAgICAgICAgICR7ZWRpdGFibGUgPyBgPGJ1dHRvbiBjbGFzcz0ibGluay1idG4gdHgtZGVsIiBkYXRhLWlkPSIke2VzYyh0LmlkKX0iIGFyaWEtbGFiZWw9IuyCreygnCI+7IKt7KCcPC9idXR0b24+YCA6ICcnfQogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj5gOwogIH0KCiAgLy8g64Kg7Kec67OE66GcIOustuydgCDrqqnroZ0KICBmdW5jdGlvbiB0eEdyb3Vwcyh0eHMsIG9wdHMpIHsKICAgIGNvbnN0IHNvcnRlZCA9IFsuLi50eHNdLnNvcnQoKGEsIGIpID0+IChhLmRhdGUgPCBiLmRhdGUgPyAxIDogYS5kYXRlID4gYi5kYXRlID8gLTEgOiAwKSk7CiAgICBjb25zdCBncm91cHMgPSBbXTsKICAgIGZvciAoY29uc3QgdCBvZiBzb3J0ZWQpIHsKICAgICAgbGV0IGcgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdOwogICAgICBpZiAoIWcgfHwgZy5kYXRlICE9PSB0LmRhdGUpIGdyb3Vwcy5wdXNoKChnID0geyBkYXRlOiB0LmRhdGUsIGl0ZW1zOiBbXSB9KSk7CiAgICAgIGcuaXRlbXMucHVzaCh0KTsKICAgIH0KICAgIHJldHVybiBncm91cHMKICAgICAgLm1hcCgoZykgPT4gewogICAgICAgIGNvbnN0IHNwZW50ID0gZy5pdGVtcy5maWx0ZXIoKHQpID0+IEwua2luZE9mKHQpID09PSAnZXhwZW5zZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgICAgICByZXR1cm4gYDxkaXYgY2xhc3M9InR4LWRhdGUiPjxzcGFuPiR7Zm10RGF5KGcuZGF0ZSl9PC9zcGFuPjxzcGFuPiR7c3BlbnQgPyBg7KeA7LacICR7d29uKHNwZW50KX1gIDogJyd9PC9zcGFuPjwvZGl2PiR7Zy5pdGVtcy5tYXAoKHQpID0+IHR4Um93KHQsIG9wdHMpKS5qb2luKCcnKX1gOwogICAgICB9KQogICAgICAuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBiaW5kVHhFdmVudHMoY29udGFpbmVyKSB7CiAgICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnLnR4LWNhdCcpLmZvckVhY2goKHMpID0+IHMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB0ID0gUygpLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBzLmRhdGFzZXQuaWQpOwogICAgICBpZiAocy52YWx1ZS5zdGFydHNXaXRoKCdraW5kOicpKSB7CiAgICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS51cGRhdGVUcmFuc2FjdGlvbih0LmlkLCB7IGtpbmQ6IHMudmFsdWUuc2xpY2UoNSksIGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCB9KSk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIOydtCDrgrTsl60g7ZWY64KY66eMIOuwlOq+vOuLpC4g6rCZ7J2AIOqwgOunueygkMK37IOB64yA66W8IOqzhOyGjSDqsJnsnYAg7ZWt66qp7Jy866GcIOuEo+ycvOugpOuptCDshKTsoJUg4oaSIOyekOuPmSDrtoTrpZgg6rec7LmZ7JeQ7IScIOuUsOuhnCDrp4zrk6Dri6QuCiAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kOiAnZXhwZW5zZScsIGNhdGVnb3J5SWQ6IHMudmFsdWUgfHwgbnVsbCwgbWV0aG9kOiBzLnZhbHVlID8gJ21hbnVhbCcgOiBudWxsIH0pKTsKICAgICAgdG9hc3QoYOydtCDrgrTsl63rp4wgJHtjYXRlZ29yeUluZm8ocy52YWx1ZSB8fCBudWxsLCBwbGFuRm9yVHgodCkuY2F0ZWdvcmllcykubmFtZX0o7Jy8KeuhnCDrsJTqv6jslrTsmpQuYCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpKTsKICAgIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCcudHgtbW92ZScpLmZvckVhY2goKHMpID0+IHMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB0ID0gUygpLnRyYW5zYWN0aW9ucy5maW5kKCh4KSA9PiB4LmlkID09PSBzLmRhdGFzZXQuaWQpOwogICAgICBjb25zdCBuID0gTWF0aC50cnVuYyhOdW1iZXIocy52YWx1ZSkgfHwgMCk7CiAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBwZXJpb2RTaGlmdDogbiB9KSk7CiAgICAgIGNvbnN0IHAgPSBMLnR4UGVyaW9kKHQsIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAgIHRvYXN0KG4gPyBg64Kg7Kec64qUIOq3uOuMgOuhnCDrkZDqs6AgJHtmbXREYXRlKHAuc3RhcnQpfSDquLDqsITsl5Ag6rOE7IKw7ZW07JqULmAgOiAn7JuQ656YIOuCoOynnOydmCDquLDqsITsnLzroZwg65CY64+M66C47Ja07JqULicpOwogICAgICByZW5kZXIoKTsKICAgIH0pKSk7CiAgICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnLnR4LWRlbCcpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHQgPSBTKCkudHJhbnNhY3Rpb25zLmZpbmQoKHgpID0+IHguaWQgPT09IGIuZGF0YXNldC5pZCk7CiAgICAgIGlmICghY29uZmlybShgJyR7dC5tZW1vfScgJHt3b24odC5hbW91bnQpfSDrgrTsl63snYQg7IKt7KCc7ZWg6rmM7JqUP2ApKSByZXR1cm47CiAgICAgIGF3YWl0IGJ1c3kobnVsbCwgKCkgPT4gc3RvcmUuZGVsZXRlVHJhbnNhY3Rpb24odC5pZCkpOwogICAgICByZW5kZXIoKTsKICAgIH0pKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIO2ZiCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckluY29tZUJveChzdW0pIHsKICAgIGNvbnN0IGJveCA9ICQoJyNpbmNvbWUtYm94Jyk7CiAgICBjb25zdCBwcmV2ID0gTC5zaGlmdFBlcmlvZChjdXJyZW50UGVyaW9kLCAtMSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgIGNvbnN0IHByZXZJbmNvbWUgPSBTKCkuaW5jb21lc1twcmV2LmtleV07CgogICAgaWYgKCFzdW0uaGFzSW5jb21lIHx8IGJveC5kYXRhc2V0LmVkaXRpbmcgPT09ICcxJykgewogICAgICBib3guY2xhc3NMaXN0LmFkZCgnaW5jb21lLXByb21wdCcpOwogICAgICBjb25zdCByZWNlaXZlZCA9IHN1bS5pbmNvbWVSZWNlaXZlZCA+IDAgPyBgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJnaG9zdC1idG4iIGlkPSJpbmNvbWUtcmVjZWl2ZWQiPuuwm+ydgCDsnoXquIgg7ZWp6rOE66GcICgke3dvbihzdW0uaW5jb21lUmVjZWl2ZWQpfSk8L2J1dHRvbj5gIDogJyc7CiAgICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgICAgPGgyPiR7c3VtLmhhc0luY29tZSA/ICfri7nquLAg7IiY7J6FKOyYiOyCsCkg7IiY7KCVJyA6ICfsnbTrsogg6riw6rCE7JeQIOuTpOyWtOyYqCDrj4go7JiI7IKwKeydhCDsnoXroKXtlZjshLjsmpQnfTwvaDI+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIHNtYWxsIj4ke2ZtdERhdGUoY3VycmVudFBlcmlvZC5zdGFydCl9IOyXkCDsi5zsnpHtlZjripQg6riw6rCE7J2YIOyImOyeheyeheuLiOuLpC4g67mE7JyoIO2VreuqqeydmCDtlZzrj4TqsIAg7J20IOq4iOyVoeyXkCDrp57strAg6rOE7IKw65Cp64uI64ukLjwvcD4KICAgICAgICA8Zm9ybSBjbGFzcz0iaW5jb21lLWZvcm0iIGlkPSJpbmNvbWUtZm9ybSI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJudW1lcmljIiBpZD0iaW5jb21lLWlucHV0IiBwbGFjZWhvbGRlcj0i7JiIOiAzLDAwMCwwMDAiIHZhbHVlPSIke3N1bS5oYXNJbmNvbWUgPyBzdW0uaW5jb21lLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpIDogJyd9Ij4KICAgICAgICAgIDxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPuyggOyepTwvYnV0dG9uPgogICAgICAgICAgJHt0eXBlb2YgcHJldkluY29tZSA9PT0gJ251bWJlcicgPyBgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJnaG9zdC1idG4iIGlkPSJpbmNvbWUtcHJldiI+7KeA64KcIOq4sOqwhOqzvCDqsJnqsowgKCR7d29uKHByZXZJbmNvbWUpfSk8L2J1dHRvbj5gIDogJyd9CiAgICAgICAgICAke3JlY2VpdmVkfQogICAgICAgICAgJHtzdW0uaGFzSW5jb21lID8gJzxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iZ2hvc3QtYnRuIiBpZD0iaW5jb21lLWNhbmNlbCI+7Leo7IaMPC9idXR0b24+JyA6ICcnfQogICAgICAgIDwvZm9ybT5gOwogICAgICBjb25zdCBpbnB1dCA9ICQoJyNpbmNvbWUtaW5wdXQnKTsKICAgICAgZm9ybWF0T25CbHVyKGlucHV0KTsKICAgICAgJCgnI2luY29tZS1mb3JtJykuYWRkRXZlbnRMaXN0ZW5lcignc3VibWl0JywgKGUpID0+IHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgbiA9IHBhcnNlQW1vdW50SW5wdXQoaW5wdXQudmFsdWUpOwogICAgICAgIGlmIChuID09PSBudWxsIHx8IG4gPCAwKSByZXR1cm4gdG9hc3QoJ+q4iOyVoeydhCDsiKvsnpDroZwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgICAgICBzZXRJbmNvbWUobik7CiAgICAgIH0pOwogICAgICBjb25zdCBiaW5kID0gKGlkLCBmbikgPT4gJChpZCkgJiYgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmbik7CiAgICAgIGJpbmQoJyNpbmNvbWUtcHJldicsICgpID0+IHNldEluY29tZShwcmV2SW5jb21lKSk7CiAgICAgIGJpbmQoJyNpbmNvbWUtcmVjZWl2ZWQnLCAoKSA9PiBzZXRJbmNvbWUoc3VtLmluY29tZVJlY2VpdmVkKSk7CiAgICAgIGJpbmQoJyNpbmNvbWUtY2FuY2VsJywgKCkgPT4gewogICAgICAgIGJveC5kYXRhc2V0LmVkaXRpbmcgPSAnJzsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSk7CiAgICB9IGVsc2UgewogICAgICBib3guY2xhc3NMaXN0LnJlbW92ZSgnaW5jb21lLXByb21wdCcpOwogICAgICBib3guaW5uZXJIVE1MID0gYAogICAgICAgIDxkaXYgY2xhc3M9ImluY29tZS1zZXQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0ibXV0ZWQgc21hbGwiPuuLueq4sCDsiJjsnoUo7JiI7IKwKTwvc3Bhbj48ZGl2IGNsYXNzPSJ2YWx1ZSI+JHt3b24oc3VtLmluY29tZSl9PC9kaXY+PC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4gc21hbGwtYnRuIiBpZD0iaW5jb21lLWVkaXQiPuyImOyglTwvYnV0dG9uPgogICAgICAgIDwvZGl2PmA7CiAgICAgICQoJyNpbmNvbWUtZWRpdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGJveC5kYXRhc2V0LmVkaXRpbmcgPSAnMSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0pOwogICAgfQogIH0KCiAgZnVuY3Rpb24gc2V0SW5jb21lKG4pIHsKICAgIFMoKS5pbmNvbWVzW2N1cnJlbnRQZXJpb2Qua2V5XSA9IG47CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgJCgnI2luY29tZS1ib3gnKS5kYXRhc2V0LmVkaXRpbmcgPSAnJzsKICAgIHRvYXN0KCfri7nquLAg7IiY7J6F7J2EIOyggOyepe2WiOyKteuLiOuLpC4nKTsKICAgIHJlbmRlcigpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyU3RhbGVCb3goc3VtKSB7CiAgICBjb25zdCBib3ggPSAkKCcjc3RhbGUtYm94Jyk7CiAgICBpZiAoIXN1bS5zdGFsZUNvdW50IHx8ICFzdW0ucGxhbi51cGRhdGVkQXQpIHsKICAgICAgYm94LmlubmVySFRNTCA9ICcnOwogICAgICByZXR1cm47CiAgICB9CiAgICBib3guaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJjYXJkIG5vdGUtY2FyZCB3YXJuLWNhcmQiPgogICAgICAgIDxiPuyYiOyCsCDqs4Ttmo3snbQg67CU64CM7JeI7Ja07JqULjwvYj4KICAgICAgICA8cCBjbGFzcz0ic21hbGwiPuuwlOuAkCDqs4Ttmo3sl5Ag66ee7LawIOyVhOyngSDri6Tsi5wg67aE66WY7ZWY7KeAIOyViuydgCDsp4DstpzsnbQgJHtzdW0uc3RhbGVDb3VudH3qsbQg7J6I7Ja07JqULiDsp4HsoJEg6rOg66W4IO2VreuqqeydgCDqt7jrjIDroZwg65GQ6rOgIOuCmOuouOyngOulvCDsg4gg7ZWt66qpIOq4sOykgOycvOuhnCDrtoTrpZjtlanri4jri6QuPC9wPgogICAgICAgIDxidXR0b24gaWQ9InN0YWxlLXJlY2xhc3NpZnkiIGNsYXNzPSJwcmltYXJ5LWJ0biI+7IOIIOqzhO2ajeycvOuhnCDri6Tsi5wg67aE66WYJHtzdG9yZS5haUVuYWJsZWQgPyAnIChBSSknIDogJyd9PC9idXR0b24+CiAgICAgIDwvZGl2PmA7CiAgICAkKCcjc3RhbGUtcmVjbGFzc2lmeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoKCkgPT4gcnVuUmVjbGFzc2lmeShmYWxzZSkpKTsKICB9CgogIC8vIOqzoOyglSDtla3rqqkg7ZWp6rOE6rCAIOydtOuyiCDquLDqsIQg7IiY7J6F67O064ukIO2BtCDrlYwg7JWM66a8CiAgZnVuY3Rpb24gcmVuZGVyRml4ZWRCb3goc3VtKSB7CiAgICBjb25zdCBib3ggPSAkKCcjZml4ZWQtYm94Jyk7CiAgICBpZiAoIXN1bS5oYXNJbmNvbWUgfHwgIXN1bS5maXhlZE92ZXIpIHsKICAgICAgYm94LmlubmVySFRNTCA9ICcnOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBwY3QgPSBNYXRoLnJvdW5kKHN1bS5maXhlZFNjYWxlICogMTAwKTsKICAgIGJveC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9ImNhcmQgbm90ZS1jYXJkIHdhcm4tY2FyZCI+CiAgICAgICAgPGI+6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukICR7d29uKHN1bS5maXhlZE92ZXIpfSDrp47slYTsmpQuPC9iPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+6rOg7KCVIO2VreuqqSAke3dvbihzdW0uZml4ZWRUb3RhbCl9IMK3IOydtOuyiCDquLDqsIQg7IiY7J6FICR7d29uKHN1bS5pbmNvbWUpfS4KICAgICAgICAke3N1bS5maXhlZFNjYWxlZAogICAgICAgICAgPyBg6rOE7ZqNIOyEpOygleyXkCDrlLDrnbwg6rOg7KCVIO2VreuqqSDtlZzrj4Trpbwg7KCV7ZWcIOq4iOyVoeydmCDslb0gJHtwY3R9JeuhnCDspITsl6wg7IiY7J6F7JeQIOunnuy3hOyWtOyalC5gCiAgICAgICAgICA6ICfsoJXtlZwg6riI7JWhIOq3uOuMgOuhnCDrkZDsl4jquLAg65WM66y47JeQIOqzhO2ajeydtCDsiJjsnoXsnYQg64SY7Ja07JqULiDqs6DsoJUg6riI7JWh7J2EIOqzoOy5mOqxsOuCmCwg6rOE7ZqN7JeQ7IScIDxiPuu5hOycqOuMgOuhnCDspITsnbTquLA8L2I+66W8IOqzoOulvCDsiJgg7J6I7Ja07JqULid9CiAgICAgICAgJHtzdW0ucmF0aW9QZXJjZW50VG90YWwgPiAwICYmIHN1bS5wbGFuLnJhdGlvQmFzZSA9PT0gJ2FmdGVyRml4ZWQnID8gJyDqs6DsoJUg7ZWt66qp7J2EIOu5vOqzoCDrgqjripQg64+I7J20IOyXhuyWtCDruYTsnKgg7ZWt66qpIO2VnOuPhOuKlCAw7JuQ7J207JeQ7JqULicgOiAnJ308L3A+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2hvc3QtYnRuIiBkYXRhLWdvdG89InBsYW4iPuqzhO2ajSDrs7TquLA8L2J1dHRvbj4KICAgICAgPC9kaXY+YDsKICAgIGJveC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1nb3RvXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoJ3BsYW4nKSk7CiAgfQoKICAvLyDtjpjsnbQg66i464uI66GcIOyYruq4tCDrj4jsnYAg7J6I64qU642wIOq3uCDquLDqsIQg7Y6Y7J20IOqysOygnOuCtOyXreydtCDsl4bsnLzrqbQg6rCA7KC47Jik65286rOgIOyVjOumsOuLpAogIGZ1bmN0aW9uIHJlbmRlclBheUJveCgpIHsKICAgIGNvbnN0IGJveCA9ICQoJyNwYXktYm94Jyk7CiAgICBjb25zdCBkb3VibGVzID0gTC5wYXlEb3VibGVDb3VudHMoUygpKTsKICAgIGNvbnN0IG1pc3NpbmcgPSBMLnBheUZsb3dzKFMoKSwgY3VycmVudFBlcmlvZCkuZmlsdGVyKChmKSA9PiBmLnRvcHVwID4gMCAmJiAhZi5jb3VudCk7CiAgICBib3guaW5uZXJIVE1MID0gZG91Ymxlcy5tYXAoKGQsIGkpID0+IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBub3RlLWNhcmQgd2Fybi1jYXJkIj4KICAgICAgICA8Yj4ke2VzYyhkLnBheU5hbWUpfSDstpzquIggJHtkLnR4cy5sZW5ndGh96rG0JHtkLnRvdGFsID8gYCgke3dvbihkLnRvdGFsKX0pYCA6ICcnfeydtCDqsrDsoJzrgrTsl63qs7wg7J207KSR7Jy866GcIOqzhOyCsOuQmOqzoCDsnojslrTsmpQuPC9iPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+7J2A7ZaJ7JeQ7IScICR7ZXNjKGQucGF5TmFtZSl9KOycvCnroZwg67mg7KC464KY6rCEIOuPiOydgCDtjpjsnbQg66i464uIIOy2qeyghOydtOqzoCwg7Iuk7KCcIOyngOy2nOydgCAke2VzYyhkLnBheU5hbWUpfSDqsrDsoJzrgrTsl63snLzroZwg7J2066+4IOyEuOqzoCDsnojslrTsmpQuIOy2qeyghCDsqr3snYQgJ+uCtCDqs4Tsoowg7J207LK0J+ycvOuhnCDrsJTqvrjrqbQg7KSR67O17J20IOyXhuyWtOynkeuLiOuLpC4ke2QubmVlZHNUeXBlID8gYCAoJyR7ZXNjKGQuYWNjb3VudC5uYW1lKX0n7J2YIOyiheulmOuPhCDqsITtjrjqsrDsoJwg66i464uI66GcIOuwlOq/ieuLiOuLpClgIDogJyd9PC9wPgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnktYnRuIiBkYXRhLWZpeD0iJHtpfSI+7Lap7KCE7Jy866GcIOuwlOq/lOyEnCDspJHrs7Ug7JeG7JWg6riwPC9idXR0b24+CiAgICAgIDwvZGl2PmApLmpvaW4oJycpICsgbWlzc2luZy5tYXAoKGYpID0+IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBub3RlLWNhcmQgd2Fybi1jYXJkIj4KICAgICAgICA8Yj4ke2VzYyhhY2NvdW50TmFtZShmLmFjY291bnQuaWQpKX3roZwg7Jiu6ri0IOuPiCAke3dvbihmLnRvcHVwKX3snZgg6rKw7KCc64K07Jet7J20IOyVhOyngSDsl4bslrTsmpQuPC9iPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+7J2A7ZaJIOuCtOyXreydmCAke2VzYyhmLmFjY291bnQucGF5TmFtZSB8fCBmLmFjY291bnQubmFtZSl9IOy2nOq4iOydgCDstqnsoITsnbTrnbwg7KeA7Lac66GcIOyEuOyngCDslYrslYTsmpQuIOyLpOygnOuhnCDrrLTsl4fsnYQg7IOA64qU7KeA64qUICR7ZXNjKGYuYWNjb3VudC5wYXlOYW1lIHx8IGYuYWNjb3VudC5uYW1lKX0g6rKw7KCc64K07Jet7J2EIOqwgOyguOyZgOyVvCDsp4Dstpzsl5Ag65Ok7Ja06rCA7JqULjwvcD4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4iIGRhdGEtZ290bz0iYWRkIj7qsrDsoJzrgrTsl60g6rCA7KC47Jik6riwPC9idXR0b24+CiAgICAgIDwvZGl2PmApLmpvaW4oJycpOwogICAgYm94LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWdvdG9dJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNob3dQYWdlKCdhZGQnKSkpOwogICAgYm94LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWZpeF0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBkID0gZG91Ymxlc1tOdW1iZXIoYi5kYXRhc2V0LmZpeCldOwogICAgICBpZiAoZC5uZWVkc1R5cGUpIHsKICAgICAgICBPYmplY3QuYXNzaWduKGQuYWNjb3VudCwgeyB0eXBlOiAncGF5JywgcGF5TmFtZTogZC5wYXlOYW1lLCBpc1NhdmluZ3M6IGZhbHNlIH0pOwogICAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIH0KICAgICAgYXdhaXQgYnVzeShg7KCV66as7ZWY64qUIOykkeKApiAoJHtkLnR4cy5sZW5ndGh96rG0KWAsIGFzeW5jICgpID0+IHsKICAgICAgICBmb3IgKGNvbnN0IHQgb2YgZC50eHMpIGF3YWl0IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZDogJ3RyYW5zZmVyJywgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsIH0pOwogICAgICB9KTsKICAgICAgdG9hc3QoYCR7ZC50eHMubGVuZ3RofeqxtOydhCDstqnsoIQo64K0IOqzhOyijCDsnbTssrQp7Jy866GcIOuwlOq/qOyWtOyalC4g7J207KCcIOyngOy2nOydgCDqsrDsoJzrgrTsl63snLzroZzrp4wg7IWJ64uI64ukLmApOwogICAgICByZW5kZXIoKTsKICAgIH0pKSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJIb21lKCkgewogICAgY29uc3Qgc3VtID0gTC5zdW1tYXJpemVQZXJpb2QoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIHJlbmRlckluY29tZUJveChzdW0pOwogICAgcmVuZGVyU3RhbGVCb3goc3VtKTsKICAgIHJlbmRlckZpeGVkQm94KHN1bSk7CiAgICByZW5kZXJQYXlCb3goKTsKCiAgICBjb25zdCB0b2RheSA9IEwudG9kYXlJU08oKTsKICAgIGNvbnN0IGlzQ3VycmVudCA9IHRvZGF5ID49IGN1cnJlbnRQZXJpb2Quc3RhcnQgJiYgdG9kYXkgPD0gY3VycmVudFBlcmlvZC5lbmQ7CiAgICBjb25zdCBkYXlzTGVmdCA9IGlzQ3VycmVudCA/IEwuZGlmZkRheXModG9kYXksIGN1cnJlbnRQZXJpb2QuZW5kKSArIDEgOiAwOwogICAgY29uc3QgaGVybyA9ICQoJyNoZXJvJyk7CiAgICBpZiAoc3VtLmhhc0luY29tZSkgewogICAgICBjb25zdCByYXRpbyA9IHN1bS5pbmNvbWUgPiAwID8gc3VtLnRvdGFsU3BlbnQgLyBzdW0uaW5jb21lIDogc3VtLnRvdGFsU3BlbnQgPiAwID8gSW5maW5pdHkgOiAwOwogICAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHJhdGlvKTsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPkxFRlQgVE8gU1BFTkQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUgJHtzdW0ucmVtYWluaW5nIDwgMCA/ICduZWdhdGl2ZScgOiAnJ30iPiR7d29uKHN1bS5yZW1haW5pbmcpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN1YiI+JHt3b24oc3VtLmluY29tZSl9IOykkSAke3dvbihzdW0udG90YWxTcGVudCl9IOyCrOyaqSAoJHtzdW0uaW5jb21lID4gMCA/IE1hdGgucm91bmQocmF0aW8gKiAxMDApIDogMH0lKTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7c3RhdHVzfSIgcm9sZT0ibWV0ZXIiIGFyaWEtdmFsdWVtaW49IjAiIGFyaWEtdmFsdWVtYXg9IiR7c3VtLmluY29tZX0iIGFyaWEtdmFsdWVub3c9IiR7c3VtLnRvdGFsU3BlbnR9IiBhcmlhLWxhYmVsPSLsmIjsgrAg7IKs7JqpIj48ZGl2IGNsYXNzPSJtZXRlci1maWxsIiBzdHlsZT0id2lkdGg6JHtNYXRoLm1pbigxMDAsIHJhdGlvICogMTAwKX0lIj48L2Rpdj48L2Rpdj5gOwogICAgfSBlbHNlIHsKICAgICAgaGVyby5pbm5lckhUTUwgPSBgCiAgICAgICAgPGRpdiBjbGFzcz0ibGFiZWwiPlNQRU5UIFRISVMgUEVSSU9EPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlndXJlIj4ke3dvbihzdW0udG90YWxTcGVudCl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic3ViIj7siJjsnoXsnYQg7J6F66Cl7ZWY66m0IO2VreuqqeuzhCDtlZzrj4TsmYAg64Ko7J2AIOuPiOydhCDqs4TsgrDtlbQg65Oc66Ck7JqULjwvZGl2PmA7CiAgICB9CgogICAgY29uc3QgcGVyRGF5ID0gaXNDdXJyZW50ICYmIHN1bS5oYXNJbmNvbWUgJiYgc3VtLnJlbWFpbmluZyA+IDAgPyB3b24oTWF0aC5mbG9vcihzdW0ucmVtYWluaW5nIC8gZGF5c0xlZnQpKSA6ICfigJQnOwogICAgJCgnI2hvbWUtc3VtbWFyeScpLmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7snbTrsogg6riw6rCEIOyngOy2nDwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfSDCtyAke3N1bS50cmFuc2FjdGlvbnMubGVuZ3RofeqxtDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7rsJvsnYAg7J6F6riIPC9zcGFuPjxzcGFuIGNsYXNzPSJ2IHBsdXMiPiR7c3VtLmluY29tZVJlY2VpdmVkID8gYCske3dvbihzdW0uaW5jb21lUmVjZWl2ZWQpfWAgOiAn4oCUJ308L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imt2Ij48c3BhbiBjbGFzcz0iayI+7ZWY66OoIOq2jOyepSDsgqzsmqnslaE8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7cGVyRGF5fTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7rr7jrtoTrpZg8L3NwYW4+PHNwYW4gY2xhc3M9InYiPiR7c3VtLnVuY2xhc3NpZmllZENvdW50ID8gYCR7d29uKHN1bS51bmNsYXNzaWZpZWQpfSDCtyAke3N1bS51bmNsYXNzaWZpZWRDb3VudH3qsbRgIDogJ+yXhuydjCd9PC9zcGFuPjwvZGl2PmA7CgogICAgbGV0IG5vdGUgPSAnJzsKICAgIGlmIChzdW0uaGFzSW5jb21lKSB7CiAgICAgIGlmIChzdW0udW5hbGxvY2F0ZWQgPiAwKSBub3RlID0gYOuwsOu2hOuQmOyngCDslYrsnYAg64+IICR7d29uKHN1bS51bmFsbG9jYXRlZCl9YDsKICAgICAgZWxzZSBpZiAoc3VtLnVuYWxsb2NhdGVkIDwgMCkgbm90ZSA9IGDimqAg6rOE7ZqN7J20IOyImOyeheuztOuLpCAke3dvbigtc3VtLnVuYWxsb2NhdGVkKX0g66eO7JWE7JqUYDsKICAgIH0KICAgICQoJyNhbGxvYy1ub3RlJykudGV4dENvbnRlbnQgPSBub3RlOwoKICAgIGNvbnN0IHJvd3NFbCA9ICQoJyNjYXRlZ29yeS1yb3dzJyk7CiAgICBpZiAoIXN1bS5wbGFuLmNhdGVnb3JpZXMubGVuZ3RoKSB7CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPuyYiOyCsCDqs4Ttmo3sl5DshJwg7ZWt66qp7J2EIOy2lOqwgO2VmOyEuOyalC48L2Rpdj4nOwogICAgfSBlbHNlIHsKICAgICAgY29uc3Qgcm93cyA9IHN1bS5yb3dzLm1hcCgociwgaSkgPT4gY2F0ZWdvcnlSb3cociwgaSwgc3VtLmhhc0luY29tZSkpOwogICAgICBpZiAoc3VtLnVuY2xhc3NpZmllZENvdW50KSB7CiAgICAgICAgcm93cy5wdXNoKGAKICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdC1yb3ciIGRhdGEtY2F0PSJfX25vbmUiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXQtdG9wIj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2F0LW5hbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWdyYXktbWFyaykiPjwvc3Bhbj7rr7jrtoTrpZg8c3BhbiBjbGFzcz0iYmFkZ2UiPuuIjOufrOyEnCDsoJXrpqztlZjquLA8L3NwYW4+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjYXQtYW1vdW50cyI+PGI+JHt3b24oc3VtLnVuY2xhc3NpZmllZCl9PC9iPiDCtyAke3N1bS51bmNsYXNzaWZpZWRDb3VudH3qsbQ8L3NwYW4+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+YCk7CiAgICAgIH0KICAgICAgcm93c0VsLmlubmVySFRNTCA9IHJvd3Muam9pbignJyk7CiAgICAgIHJvd3NFbC5xdWVyeVNlbGVjdG9yQWxsKCcuY2F0LXJvdycpLmZvckVhY2goKGVsKSA9PiB7CiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgICBpZiAoZWwuZGF0YXNldC5jYXQgPT09ICdfX25vbmUnKSByZXR1cm4gc2hvd1BhZ2UoJ3NvcnQnLCB7IGtlZXBQZXJpb2Q6IHRydWUgfSk7CiAgICAgICAgICBPYmplY3QuYXNzaWduKGxpc3RTdGF0ZSwgeyBjYXRlZ29yeTogZWwuZGF0YXNldC5jYXQsIGtpbmQ6ICdhbGwnLCBhY2NvdW50OiAnYWxsJywgc2VhcmNoOiAnJyB9KTsKICAgICAgICAgIHNob3dQYWdlKCdsaXN0Jyk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3QgciA9IHN1bS5yb3dzLmZpbmQoKHgpID0+IHguY2F0ZWdvcnkuaWQgPT09IGVsLmRhdGFzZXQuY2F0KTsKICAgICAgICBpZiAocikgYXR0YWNoVG9vbHRpcChlbC5xdWVyeVNlbGVjdG9yKCcubWV0ZXInKSwgKCkgPT4gYAogICAgICAgICAgPHN0cm9uZz4ke2VzYyhyLmNhdGVnb3J5Lm5hbWUpfTwvc3Ryb25nPgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPu2VnOuPhDwvc3Bhbj48c3Bhbj4ke3dvbihyLmJ1ZGdldCl9PC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idC1yb3ciPjxzcGFuPuyCrOyaqTwvc3Bhbj48c3Bhbj4ke3dvbihyLnNwZW50KX08L3NwYW4+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+JHtyLnJlbWFpbmluZyA+PSAwID8gJ+uCqOydjCcgOiAn7LSI6rO8J308L3NwYW4+PHNwYW4+JHt3b24oTWF0aC5hYnMoci5yZW1haW5pbmcpKX08L3NwYW4+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+6rG07IiYPC9zcGFuPjxzcGFuPiR7ci5jb3VudH3qsbQ8L3NwYW4+PC9kaXY+YCk7CiAgICAgIH0pOwogICAgfQoKICAgIGNvbnN0IHJlY2VudCA9IFsuLi5zdW0uYWxsVHJhbnNhY3Rpb25zXS5zb3J0KChhLCBiKSA9PiAoYS5kYXRlICsgKGEuY3JlYXRlZEF0IHx8ICcnKSA8IGIuZGF0ZSArIChiLmNyZWF0ZWRBdCB8fCAnJykgPyAxIDogLTEpKS5zbGljZSgwLCA1KTsKICAgICQoJyNyZWNlbnQtbGlzdCcpLmlubmVySFRNTCA9IHJlY2VudC5sZW5ndGggPyByZWNlbnQubWFwKCh0KSA9PiB0eFJvdyh0LCB7IGVkaXRhYmxlOiBmYWxzZSB9KSkuam9pbignJykgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuydtCDquLDqsIQg64K07Jet7J20IOyXhuyKteuLiOuLpC48L2Rpdj4nOwoKICAgIGNvbnN0IGFzc2V0cyA9IEwuYXNzZXRTdW1tYXJ5KFMoKSwgY3VycmVudFBlcmlvZCk7CiAgICAkKCcjaG9tZS1hc3NldHMnKS5pbm5lckhUTUwgPSBhc3NldHMuYmFua3MubGVuZ3RoIHx8IGFzc2V0cy5jYXJkcy5sZW5ndGgKICAgICAgPyBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7qs4Tsoowg7J6U7JWhIO2VqeqzhDwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oYXNzZXRzLnRvdGFsKX08L3NwYW4+PC9kaXY+CiAgICAgICAgICR7YXNzZXRzLnNhdmluZ3MgPyBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj7qt7jspJEg7KCA7LaVPC9zcGFuPjxzcGFuIGNsYXNzPSJ2Ij4ke3dvbihhc3NldHMuc2F2aW5ncyl9PC9zcGFuPjwvZGl2PmAgOiAnJ30KICAgICAgICAgJHthc3NldHMuY2FyZHMubWFwKChjKSA9PiBgPGRpdiBjbGFzcz0ia3YiPjxzcGFuIGNsYXNzPSJrIj4ke2VzYyhhY2NvdW50TmFtZShjLmlkKSl9ICjsnbTrsogg6riw6rCEKTwvc3Bhbj48c3BhbiBjbGFzcz0idiI+JHt3b24oYy5zcGVudCl9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfWAKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuyEpOygleyXkOyEnCDqs4TsoozCt+y5tOuTnOulvCDrk7HroZ3tlZjrqbQg7J6U7JWh6rO8IOy5tOuTnOuzhCDsgqzsmqnslaHsnYQg67O07Jes65Oc66Ck7JqULjwvZGl2Pic7CiAgfQoKICBmdW5jdGlvbiBjYXRlZ29yeVJvdyhyLCBpbmRleCwgaGFzSW5jb21lKSB7CiAgICBjb25zdCBjID0gci5jYXRlZ29yeTsKICAgIGNvbnN0IGJhZGdlID0gYy50eXBlID09PSAnZml4ZWQnID8gYOqzoOyglSAke3dvbihjLnZhbHVlKX1gIDogYOyImOyeheydmCAke2MudmFsdWV9JWA7CiAgICBjb25zdCBzdGF0dXMgPSBMLnN0YXR1c09mKHIucmF0aW8pOwogICAgY29uc3QgcGN0ID0gci5idWRnZXQgPiAwID8gTWF0aC5yb3VuZChyLnJhdGlvICogMTAwKSA6IG51bGw7CiAgICBjb25zdCB3aWR0aCA9IHIuYnVkZ2V0ID4gMCA/IE1hdGgubWluKDEwMCwgci5yYXRpbyAqIDEwMCkgOiByLnNwZW50ID4gMCA/IDEwMCA6IDA7CiAgICBjb25zdCBub0J1ZGdldCA9IGMudHlwZSA9PT0gJ3JhdGlvJyAmJiAhaGFzSW5jb21lOwoKICAgIGxldCBzdGF0dXNUZXh0OwogICAgaWYgKG5vQnVkZ2V0KSBzdGF0dXNUZXh0ID0gJ+yImOyehSDsnoXroKUg7KCEJzsKICAgIGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2NyaXRpY2FsJykgc3RhdHVzVGV4dCA9IGDimqAg7LSI6rO8ICR7cGN0ID09PSBudWxsID8gJycgOiBgKCR7cGN0fSUpYH1gOwogICAgZWxzZSBpZiAoc3RhdHVzID09PSAnd2FybmluZycpIHN0YXR1c1RleHQgPSBwY3QgPT09IDEwMCA/ICftlZzrj4Qg64+E64usIDEwMCUnIDogYCEg7KO87J2YICR7cGN0fSVgOwogICAgZWxzZSBzdGF0dXNUZXh0ID0gcGN0ID09PSBudWxsID8gJycgOiBgJHtwY3R9JSDsgqzsmqlgOwoKICAgIGNvbnN0IHJlbWFpbiA9IG5vQnVkZ2V0CiAgICAgID8gJycKICAgICAgOiByLnJlbWFpbmluZyA+PSAwCiAgICAgICAgPyBgPHNwYW4gY2xhc3M9InJlbWFpbi1nb29kIj4ke3dvbihyLnJlbWFpbmluZyl9IOuCqOydjDwvc3Bhbj5gCiAgICAgICAgOiBgPHNwYW4gY2xhc3M9InJlbWFpbi1iYWQiPiR7d29uKC1yLnJlbWFpbmluZyl9IOy0iOqzvDwvc3Bhbj5gOwoKICAgIHJldHVybiBgCiAgICAgIDxkaXYgY2xhc3M9ImNhdC1yb3ciIGRhdGEtY2F0PSIke2VzYyhjLmlkKX0iPgogICAgICAgIDxkaXYgY2xhc3M9ImNhdC10b3AiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImNhdC1uYW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDoke0Muc2VyaWVzQ29sb3IoaW5kZXgpfSI+PC9zcGFuPiR7ZXNjKGMubmFtZSl9PHNwYW4gY2xhc3M9ImJhZGdlIj4ke2VzYyhiYWRnZSl9PC9zcGFuPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJjYXQtYW1vdW50cyI+PGI+JHt3b24oci5zcGVudCl9PC9iPiAvICR7bm9CdWRnZXQgPyAn4oCUJyA6IHdvbihyLmJ1ZGdldCl9PC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyICR7bm9CdWRnZXQgPyAnJyA6IHN0YXR1c30iIHJvbGU9Im1ldGVyIiBhcmlhLXZhbHVlbWluPSIwIiBhcmlhLXZhbHVlbWF4PSIke3IuYnVkZ2V0fSIgYXJpYS12YWx1ZW5vdz0iJHtyLnNwZW50fSIgYXJpYS1sYWJlbD0iJHtlc2MoYy5uYW1lKX0g7IKs7Jqp7JWhIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldGVyLWZpbGwiIHN0eWxlPSJ3aWR0aDoke3dpZHRofSUiPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNhdC1ib3R0b20iPgogICAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cyAke25vQnVkZ2V0ID8gJycgOiBzdGF0dXN9Ij4ke3N0YXR1c1RleHR9PC9zcGFuPgogICAgICAgICAgJHtyZW1haW59CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PmA7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuLrOugpSAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHJlbmRlckNhbGVuZGFyKCkgewogICAgY29uc3QgcCA9IGN1cnJlbnRQZXJpb2Q7CiAgICBjb25zdCBzdW0gPSBMLnN1bW1hcml6ZVBlcmlvZChTKCksIHApOwogICAgLy8g64us66Cl7J2AIOyLpOygnCDrgqDsp5wg6riw7KSAICjri6Trpbgg6riw6rCE7Jy866GcIOyYruq4tCDrgrTsl63rj4Qg7JO0IOuCoOyXkCDrs7Tsnbjri6QpCiAgICBjb25zdCBkYXRlZCA9IFMoKS50cmFuc2FjdGlvbnMuZmlsdGVyKCh0KSA9PiB0LmRhdGUgPj0gcC5zdGFydCAmJiB0LmRhdGUgPD0gcC5lbmQpOwogICAgY29uc3QgZGF5cyA9IEwuZGFpbHlUb3RhbHMoZGF0ZWQpOwogICAgY29uc3QgdG9kYXkgPSBMLnRvZGF5SVNPKCk7CiAgICBpZiAoIXNlbGVjdGVkRGF0ZSB8fCBzZWxlY3RlZERhdGUgPCBwLnN0YXJ0IHx8IHNlbGVjdGVkRGF0ZSA+IHAuZW5kKSBzZWxlY3RlZERhdGUgPSB0b2RheSA+PSBwLnN0YXJ0ICYmIHRvZGF5IDw9IHAuZW5kID8gdG9kYXkgOiBwLnN0YXJ0OwoKICAgICQoJyNjYWwtc3VtbWFyeScpLmlubmVySFRNTCA9IGAKICAgICAgPHNwYW4+7KeA7LacIDxiPiR7d29uKHN1bS50b3RhbFNwZW50KX08L2I+PC9zcGFuPgogICAgICA8c3BhbiBjbGFzcz0icGx1cyI+7J6F6riIIDxiPiR7c3VtLmluY29tZVJlY2VpdmVkID8gYCske3dvbihzdW0uaW5jb21lUmVjZWl2ZWQpfWAgOiAnMOybkCd9PC9iPjwvc3Bhbj4KICAgICAgJHtzdW0uaGFzSW5jb21lID8gYDxzcGFuPuuCqOydgCDrj4ggPGI+JHt3b24oc3VtLnJlbWFpbmluZyl9PC9iPjwvc3Bhbj5gIDogJyd9YDsKCiAgICBjb25zdCBtYXhTcGVudCA9IE1hdGgubWF4KDAsIC4uLk9iamVjdC52YWx1ZXMoZGF5cykubWFwKChkKSA9PiBkLnNwZW50KSk7CiAgICBjb25zdCBmaXJzdCA9IEwuYWRkRGF5cyhwLnN0YXJ0LCAtZG93T2YocC5zdGFydCkpOwogICAgY29uc3QgbGFzdCA9IEwuYWRkRGF5cyhwLmVuZCwgNiAtIGRvd09mKHAuZW5kKSk7CiAgICBjb25zdCBjZWxscyA9IERPVy5tYXAoKHcsIGkpID0+IGA8ZGl2IGNsYXNzPSJjYWwtZG93ICR7aSA9PT0gMCA/ICdzdW4nIDogJyd9Ij4ke3d9PC9kaXY+YCk7CiAgICBmb3IgKGxldCBjdXJzb3IgPSBmaXJzdDsgY3Vyc29yIDw9IGxhc3Q7IGN1cnNvciA9IEwuYWRkRGF5cyhjdXJzb3IsIDEpKSB7CiAgICAgIGNvbnN0IGluUGVyaW9kID0gY3Vyc29yID49IHAuc3RhcnQgJiYgY3Vyc29yIDw9IHAuZW5kOwogICAgICBjb25zdCBpbmZvID0gZGF5c1tjdXJzb3JdIHx8IHsgc3BlbnQ6IDAsIGluY29tZTogMCB9OwogICAgICBjb25zdCBxID0gTC5wYXJzZUlTTyhjdXJzb3IpOwogICAgICBjb25zdCBsYWJlbCA9IHEuZCA9PT0gMSB8fCBjdXJzb3IgPT09IHAuc3RhcnQgPyBgJHtxLm19LyR7cS5kfWAgOiBxLmQ7CiAgICAgIGxldCBoZWF0ID0gJyc7CiAgICAgIGlmIChpblBlcmlvZCAmJiBpbmZvLnNwZW50ID4gMCAmJiBtYXhTcGVudCA+IDApIGhlYXQgPSBgaCR7TWF0aC5taW4oMywgTWF0aC5jZWlsKChpbmZvLnNwZW50IC8gbWF4U3BlbnQpICogMykpfWA7CiAgICAgIGNlbGxzLnB1c2goaW5QZXJpb2QKICAgICAgICA/IGA8YnV0dG9uIGNsYXNzPSJjYWwtZGF5ICR7aGVhdH0gJHtjdXJzb3IgPT09IHRvZGF5ID8gJ3RvZGF5JyA6ICcnfSAke2N1cnNvciA9PT0gc2VsZWN0ZWREYXRlID8gJ3NlbGVjdGVkJyA6ICcnfSIgZGF0YS1kYXRlPSIke2N1cnNvcn0iIGFyaWEtbGFiZWw9IiR7Zm10RGF5KGN1cnNvcil9IOyngOy2nCAke3dvbihpbmZvLnNwZW50KX0iPgogICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNhbC1udW0iPiR7bGFiZWx9PC9zcGFuPgogICAgICAgICAgICAgJHtpbmZvLnNwZW50ID8gYDxzcGFuIGNsYXNzPSJjYWwtc3BlbnQiPi0ke0MudGlueVdvbihpbmZvLnNwZW50KX08L3NwYW4+YCA6ICcnfQogICAgICAgICAgICAgJHtpbmZvLmluY29tZSA/IGA8c3BhbiBjbGFzcz0iY2FsLWluY29tZSI+KyR7Qy50aW55V29uKGluZm8uaW5jb21lKX08L3NwYW4+YCA6ICcnfQogICAgICAgICAgIDwvYnV0dG9uPmAKICAgICAgICA6IGA8ZGl2IGNsYXNzPSJjYWwtZGF5IG91dCI+PHNwYW4gY2xhc3M9ImNhbC1udW0iPiR7bGFiZWx9PC9zcGFuPjwvZGl2PmApOwogICAgfQogICAgY29uc3QgY2FsID0gJCgnI2NhbGVuZGFyJyk7CiAgICBjYWwuaW5uZXJIVE1MID0gY2VsbHMuam9pbignJyk7CiAgICBjYWwucXVlcnlTZWxlY3RvckFsbCgnLmNhbC1kYXlbZGF0YS1kYXRlXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHNlbGVjdGVkRGF0ZSA9IGIuZGF0YXNldC5kYXRlOwogICAgICByZW5kZXJDYWxlbmRhcigpOwogICAgfSkpOwoKICAgIGNvbnN0IGRheVR4cyA9IGRhdGVkLmZpbHRlcigodCkgPT4gdC5kYXRlID09PSBzZWxlY3RlZERhdGUpOwogICAgJCgnI2RheS10aXRsZScpLnRleHRDb250ZW50ID0gZm10RGF5KHNlbGVjdGVkRGF0ZSk7CiAgICBjb25zdCBpbmZvID0gZGF5c1tzZWxlY3RlZERhdGVdOwogICAgJCgnI2RheS10b3RhbCcpLnRleHRDb250ZW50ID0gaW5mbyA/IGDsp4DstpwgJHt3b24oaW5mby5zcGVudCl9JHtpbmZvLmluY29tZSA/IGAgwrcg7J6F6riIICR7d29uKGluZm8uaW5jb21lKX1gIDogJyd9YCA6ICcnOwogICAgY29uc3QgbGlzdCA9ICQoJyNkYXktbGlzdCcpOwogICAgbGlzdC5pbm5lckhUTUwgPSBkYXlUeHMubGVuZ3RoID8gZGF5VHhzLm1hcCgodCkgPT4gdHhSb3codCkpLmpvaW4oJycpIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7snbTrgqDsnYAg64K07Jet7J20IOyXhuyWtOyalC48L2Rpdj4nOwogICAgYmluZFR4RXZlbnRzKGxpc3QpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrgrTsl60gLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJMaXN0KCkgewogICAgY29uc3Qgc3VtID0gTC5zdW1tYXJpemVQZXJpb2QoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IGNhdHMgPSBzdW0ucGxhbi5jYXRlZ29yaWVzOwogICAgY29uc3Qga25vd24gPSBuZXcgU2V0KGNhdHMubWFwKChjKSA9PiBjLmlkKSk7CiAgICBpZiAobGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnYWxsJyAmJiBsaXN0U3RhdGUuY2F0ZWdvcnkgIT09ICdfX25vbmUnICYmICFrbm93bi5oYXMobGlzdFN0YXRlLmNhdGVnb3J5KSkgbGlzdFN0YXRlLmNhdGVnb3J5ID0gJ2FsbCc7CgogICAgJCgnI2xpc3QtZmlsdGVyJykuaW5uZXJIVE1MID0gYDxvcHRpb24gdmFsdWU9ImFsbCI+66qo65OgIO2VreuqqTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9Il9fbm9uZSI+66+467aE66WYPC9vcHRpb24+YCArCiAgICAgIGNhdHMubWFwKChjKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2MoYy5pZCl9Ij4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpOwogICAgJCgnI2xpc3QtZmlsdGVyJykudmFsdWUgPSBsaXN0U3RhdGUuY2F0ZWdvcnk7CiAgICAkKCcjbGlzdC1hY2NvdW50JykuaW5uZXJIVE1MID0gYDxvcHRpb24gdmFsdWU9ImFsbCI+66qo65OgIOqysOygnOyImOuLqDwvb3B0aW9uPmAgKwogICAgICBTKCkuYWNjb3VudHMubWFwKChhKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2MoYS5pZCl9Ij4ke2VzYyhhY2NvdW50TmFtZShhLmlkKSl9PC9vcHRpb24+YCkuam9pbignJyk7CiAgICAkKCcjbGlzdC1hY2NvdW50JykudmFsdWUgPSBTKCkuYWNjb3VudHMuc29tZSgoYSkgPT4gYS5pZCA9PT0gbGlzdFN0YXRlLmFjY291bnQpID8gbGlzdFN0YXRlLmFjY291bnQgOiAnYWxsJzsKICAgICQoJyNsaXN0LWtpbmQnKS52YWx1ZSA9IGxpc3RTdGF0ZS5raW5kOwogICAgJCgnI2xpc3Qtc2VhcmNoJykudmFsdWUgPSBsaXN0U3RhdGUuc2VhcmNoOwogICAgJCgnI3JlY2xhc3NpZnktYWxsJykudGV4dENvbnRlbnQgPSBg7J20IOq4sOqwhCDsoITssrQg64uk7IucIOu2hOulmCR7c3RvcmUuYWlFbmFibGVkID8gJyAoQUkpJyA6ICcnfWA7CgogICAgY29uc3QgcSA9IEwubm9ybWFsaXplTWVyY2hhbnQobGlzdFN0YXRlLnNlYXJjaCk7CiAgICBjb25zdCB0eHMgPSBzdW0uYWxsVHJhbnNhY3Rpb25zLmZpbHRlcigodCkgPT4gewogICAgICBjb25zdCBraW5kID0gTC5raW5kT2YodCk7CiAgICAgIGlmIChsaXN0U3RhdGUua2luZCAhPT0gJ2FsbCcgJiYga2luZCAhPT0gbGlzdFN0YXRlLmtpbmQpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKGxpc3RTdGF0ZS5jYXRlZ29yeSA9PT0gJ19fbm9uZScgJiYgKGtpbmQgIT09ICdleHBlbnNlJyB8fCBrbm93bi5oYXModC5jYXRlZ29yeUlkKSkpIHJldHVybiBmYWxzZTsKICAgICAgaWYgKGxpc3RTdGF0ZS5jYXRlZ29yeSAhPT0gJ2FsbCcgJiYgbGlzdFN0YXRlLmNhdGVnb3J5ICE9PSAnX19ub25lJyAmJiB0LmNhdGVnb3J5SWQgIT09IGxpc3RTdGF0ZS5jYXRlZ29yeSkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAobGlzdFN0YXRlLmFjY291bnQgIT09ICdhbGwnICYmIHQuYWNjb3VudElkICE9PSBsaXN0U3RhdGUuYWNjb3VudCkgcmV0dXJuIGZhbHNlOwogICAgICBpZiAocSAmJiAhTC5ub3JtYWxpemVNZXJjaGFudCh0Lm1lbW8pLmluY2x1ZGVzKHEpKSByZXR1cm4gZmFsc2U7CiAgICAgIHJldHVybiB0cnVlOwogICAgfSk7CgogICAgY29uc3Qgc3BlbnQgPSB0eHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CiAgICBjb25zdCBpbmMgPSB0eHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2luY29tZScpLnJlZHVjZSgocywgdCkgPT4gcyArIHQuYW1vdW50LCAwKTsKICAgICQoJyNsaXN0LXRvdGFsJykuaW5uZXJIVE1MID0gYDxzcGFuPiR7dHhzLmxlbmd0aH3qsbQ8L3NwYW4+PHNwYW4+7KeA7LacIDxiPiR7d29uKHNwZW50KX08L2I+PC9zcGFuPiR7aW5jID8gYDxzcGFuPuyeheq4iCA8Yj4rJHt3b24oaW5jKX08L2I+PC9zcGFuPmAgOiAnJ31gOwoKICAgIGNvbnN0IGVsID0gJCgnI3R4LWxpc3QnKTsKICAgIGVsLmlubmVySFRNTCA9IHR4cy5sZW5ndGggPyB0eEdyb3Vwcyh0eHMpIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7sobDqsbTsl5Ag66ee64qUIOuCtOyXreydtCDsl4bsirXri4jri6QuPC9kaXY+JzsKICAgIGJpbmRUeEV2ZW50cyhlbCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOuvuOu2hOulmCDsoJXrpqwgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJTb3J0KCkgewogICAgY29uc3QgZ3JvdXBzID0gTC51bmNsYXNzaWZpZWRHcm91cHMoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IGNvdW50ID0gZ3JvdXBzLnJlZHVjZSgobiwgZykgPT4gbiArIGcuaXRlbXMubGVuZ3RoLCAwKTsKICAgIGNvbnN0IHRvdGFsID0gZ3JvdXBzLnJlZHVjZSgobiwgZykgPT4gbiArIGcudG90YWwsIDApOwogICAgJCgnI3NvcnQtdGl0bGUnKS50ZXh0Q29udGVudCA9ICfsnbQg6riw6rCEIOuvuOu2hOulmCc7CiAgICAkKCcjc29ydC10b3RhbCcpLnRleHRDb250ZW50ID0gY291bnQgPyBgJHtjb3VudH3qsbQgwrcgJHt3b24odG90YWwpfWAgOiAnJzsKCiAgICAvLyDri6Trpbgg6riw6rCE7JeQIOuCqOydgCDrr7jrtoTrpZg6IOuIjOufrOyEnCDqt7gg6riw6rCE7Jy866GcIOydtOuPmQogICAgY29uc3Qgb3RoZXJzID0gTC51bmNsYXNzaWZpZWRCeVBlcmlvZChTKCkpLmZpbHRlcigoZSkgPT4gZS5wZXJpb2Qua2V5ICE9PSBjdXJyZW50UGVyaW9kLmtleSk7CiAgICBjb25zdCBvdGhlckVsID0gJCgnI3NvcnQtb3RoZXJzJyk7CiAgICBvdGhlckVsLmlubmVySFRNTCA9IG90aGVycy5sZW5ndGgKICAgICAgPyBgPHNwYW4gY2xhc3M9Im11dGVkIHNtYWxsIj7ri6Trpbgg6riw6rCE7JeQ64+EIOuCqOyVhCDsnojslrTsmpQ6PC9zcGFuPiAke290aGVycy5tYXAoKGUpID0+IGA8YnV0dG9uIGNsYXNzPSJwaWNrLWJ0biIgZGF0YS1wZXJpb2Q9IiR7ZXNjKGUucGVyaW9kLmtleSl9Ij4ke2VzYyhwZXJpb2RMYWJlbChlLnBlcmlvZCkpfSDCtyAke2UuY291bnR96rG0PC9idXR0b24+YCkuam9pbignJyl9YAogICAgICA6ICcnOwogICAgb3RoZXJFbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wZXJpb2RdJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgY29uc3QgZSA9IG90aGVycy5maW5kKCh4KSA9PiB4LnBlcmlvZC5rZXkgPT09IGIuZGF0YXNldC5wZXJpb2QpOwogICAgICBjdXJyZW50UGVyaW9kID0gZS5wZXJpb2Q7CiAgICAgIHJlbmRlcigpOwogICAgICB3aW5kb3cuc2Nyb2xsVG8oMCwgMCk7CiAgICB9KSk7CgogICAgY29uc3QgZWwgPSAkKCcjc29ydC1ncm91cHMnKTsKICAgIGlmICghZ3JvdXBzLmxlbmd0aCkgewogICAgICBlbC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPuydtCDquLDqsITsl5DripQg66+467aE66WYIOyngOy2nOydtCDsl4bslrTsmpQuJHtvdGhlcnMubGVuZ3RoID8gJyDsnITsl5DshJwg64uk66W4IOq4sOqwhOydhCDqs6jrnbwg7KCV66as7ZWY7IS47JqULicgOiAnIOuqqOuRkCDsoJXrpqzrkJDslrTsmpQuJ308L2Rpdj48L2Rpdj5gOwogICAgICByZXR1cm47CiAgICB9CiAgICBlbC5pbm5lckhUTUwgPSBncm91cHMubWFwKChnLCBnaSkgPT4gewogICAgICBjb25zdCBjYXRzID0gcGxhbkZvclR4KGcuaXRlbXNbMF0pLmNhdGVnb3JpZXM7CiAgICAgIGNvbnN0IGRheXMgPSBbLi4ubmV3IFNldChnLml0ZW1zLm1hcCgodCkgPT4gdC5kYXRlKSldOwogICAgICBjb25zdCBkYXRlcyA9IGRheXMuc2xpY2UoMCwgMykubWFwKGZtdERheSkuam9pbignLCAnKSArIChkYXlzLmxlbmd0aCA+IDMgPyBgIOyZuCAke2RheXMubGVuZ3RoIC0gM33snbxgIDogJycpOwogICAgICBjb25zdCByYXcgPSBnLml0ZW1zLmZpbmQoKHQpID0+IHQucmF3KT8ucmF3OwogICAgICByZXR1cm4gYAogICAgICAgIDxkaXYgY2xhc3M9ImNhcmQgc29ydC1ncm91cCIgZGF0YS1nPSIke2dpfSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzb3J0LWhlYWQiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0ic29ydC1tZW1vIj4ke2VzYyhnLm1lbW8pfTwvc3Bhbj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InNvcnQtc3VtIj48Yj4ke3dvbihnLnRvdGFsKX08L2I+JHtnLml0ZW1zLmxlbmd0aCA+IDEgPyBgIMK3ICR7Zy5pdGVtcy5sZW5ndGh96rG0YCA6ICcnfTwvc3Bhbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ic29ydC1kYXRlcyI+JHtlc2MoZGF0ZXMpfSR7Zy5pdGVtc1swXS5hY2NvdW50SWQgJiYgYWNjb3VudE5hbWUoZy5pdGVtc1swXS5hY2NvdW50SWQpID8gYCDCtyAke2VzYyhhY2NvdW50TmFtZShnLml0ZW1zWzBdLmFjY291bnRJZCkpfWAgOiAnJ308L2Rpdj4KICAgICAgICAgICR7cmF3ID8gYDxkaXYgY2xhc3M9InNvcnQtcmF3Ij4ke2VzYyhyYXcpfTwvZGl2PmAgOiAnJ30KICAgICAgICAgIDxkaXYgY2xhc3M9InBpY2stcm93Ij4KICAgICAgICAgICAgJHtjYXRzLm1hcCgoYywgaSkgPT4gYDxidXR0b24gY2xhc3M9InBpY2stYnRuIiBkYXRhLWNhdD0iJHtlc2MoYy5pZCl9Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDoke0Muc2VyaWVzQ29sb3IoaSl9Ij48L3NwYW4+JHtlc2MoYy5uYW1lKX08L2J1dHRvbj5gKS5qb2luKCcnKX0KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGljay1idG4gb3RoZXIiIGRhdGEta2luZD0idHJhbnNmZXIiPuuCtCDqs4Tsoowg7J207LK0PC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpY2stYnRuIG90aGVyIiBkYXRhLWtpbmQ9ImluY29tZSI+7J6F6riIPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICR7Zy5pdGVtcy5sZW5ndGggPiAxID8gYDxkZXRhaWxzPjxzdW1tYXJ5Pu2VmOuCmOyUqSDrlLDroZwg6rOg66W06riwPC9zdW1tYXJ5PjxkaXYgY2xhc3M9InR4LWxpc3QiPiR7Zy5pdGVtcy5tYXAoKHQpID0+IHR4Um93KHQpKS5qb2luKCcnKX08L2Rpdj48L2RldGFpbHM+YCA6ICcnfQogICAgICAgIDwvZGl2PmA7CiAgICB9KS5qb2luKCcnKTsKCiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCcuc29ydC1ncm91cCcpLmZvckVhY2goKGNhcmQpID0+IHsKICAgICAgY29uc3QgZyA9IGdyb3Vwc1tOdW1iZXIoY2FyZC5kYXRhc2V0LmcpXTsKICAgICAgY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCcucGljay1idG4nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoKCkgPT4gYXNzaWduR3JvdXAoZywgYi5kYXRhc2V0LmNhdCwgYi5kYXRhc2V0LmtpbmQpKSkpOwogICAgICBiaW5kVHhFdmVudHMoY2FyZCk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGFzc2lnbkdyb3VwKGcsIGNhdGVnb3J5SWQsIGtpbmQpIHsKICAgIGNvbnN0IGxlYXJuID0gJCgnI3NvcnQtbGVhcm4nKS5jaGVja2VkOwogICAgaWYgKGNhdGVnb3J5SWQgJiYgbGVhcm4pIHsKICAgICAgUygpLm1lcmNoYW50TWFwW2cua2V5XSA9IGNhdGVnb3J5SWQ7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICB9CiAgICBsZXQgZG9uZSA9IDA7CiAgICBhd2FpdCBidXN5KGcuaXRlbXMubGVuZ3RoID4gMyA/ICfsoJXrpqztlZjripQg7KSR4oCmJyA6IG51bGwsIGFzeW5jICgpID0+IHsKICAgICAgZm9yIChjb25zdCB0IG9mIGcuaXRlbXMpIHsKICAgICAgICBpZiAoa2luZCkgewogICAgICAgICAgYXdhaXQgc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kLCBjYXRlZ29yeUlkOiBudWxsLCBtZXRob2Q6IG51bGwgfSk7CiAgICAgICAgICBkb25lICs9IDE7CiAgICAgICAgfSBlbHNlIGlmIChwbGFuRm9yVHgodCkuY2F0ZWdvcmllcy5zb21lKChjKSA9PiBjLmlkID09PSBjYXRlZ29yeUlkKSkgewogICAgICAgICAgLy8g6re4IOuCoOynnOydmCDqs4Ttmo3sl5Ag7JeG64qUIO2VreuqqeydtOuptCDqsbTrhIjrm7Tri6QgKOyngOuCnCDquLDqsIQg6rOE7ZqN6rO8IO2VreuqqeydtCDri6Trpbwg7IiYIOyeiOydjCkKICAgICAgICAgIGF3YWl0IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZDogJ2V4cGVuc2UnLCBjYXRlZ29yeUlkLCBtZXRob2Q6ICdtYW51YWwnIH0pOwogICAgICAgICAgZG9uZSArPSAxOwogICAgICAgIH0KICAgICAgfQogICAgfSk7CiAgICBjb25zdCB3aGF0ID0ga2luZCA9PT0gJ3RyYW5zZmVyJyA/ICfrgrQg6rOE7KKMIOydtOyytCcgOiBraW5kID09PSAnaW5jb21lJyA/ICfsnoXquIgnIDogY2F0ZWdvcnlJbmZvKGNhdGVnb3J5SWQsIHBsYW5Gb3JUeChnLml0ZW1zWzBdKS5jYXRlZ29yaWVzKS5uYW1lOwogICAgY29uc3Qgc2tpcHBlZCA9IGcuaXRlbXMubGVuZ3RoIC0gZG9uZTsKICAgIHRvYXN0KGAnJHtnLm1lbW99JyAke2RvbmV96rG07J2EICR7d2hhdH0o7Jy8KeuhnCDsoJXrpqztlojslrTsmpQuYCArCiAgICAgIChza2lwcGVkID8gYCAoJHtza2lwcGVkfeqxtOydgCDqt7jrlYwg6rOE7ZqN7JeQIOydtCDtla3rqqnsnbQg7JeG7Ja0IOuCqOqyqCDrkoDslrTsmpQpYCA6ICcnKSArCiAgICAgIChjYXRlZ29yeUlkICYmIGxlYXJuID8gJyDsnpDrj5kg67aE66WYIOq3nOy5meuPhCDrp4zrk6Tsl4jslrTsmpQuJyA6ICcnKSk7CiAgICByZW5kZXIoKTsKICB9CgogIC8vIOuqqOuToCDquLDqsITsnZgg7Lm07Lm07Jik7Y6Y7J20IOy2nOq4iCjstqnsoIQp7J2EIO2VnCDrsojsl5AgJ+uCtCDqs4Tsoowg7J207LK0J+uhnCDrsJTqvrzri6QuCiAgLy8g64uk7J2M67aA7YSwIOyekOuPmeycvOuhnCDrkJjrj4TroZ0g7Lm07Lm07Jik7Y6Y7J2066W8IOqwhO2OuOqysOygnCDrqLjri4jroZwg65Ox66GdKOyXhuycvOuptCDsg4jroZwg7LaU6rCAKe2VnOuLpC4KICBhc3luYyBmdW5jdGlvbiBmaXhQYXlUb3B1cHMoKSB7CiAgICBjb25zdCBjID0gTC5wYXlUb3B1cENhbmRpZGF0ZXMoUygpKTsKICAgIGlmICghYy50eHMubGVuZ3RoKSByZXR1cm4gdG9hc3QoYCcke2MucGF5TmFtZX0nKOycvCnroZwg7LCN7Z6MIOyngOy2nMK37J6F6riI7J20IOyXhuyWtOyalC4g7J2066+4IOuqqOuRkCDrgrQg6rOE7KKMIOydtOyytOyYiOyalC5gKTsKICAgIGNvbnN0IHRvdGFsID0gYy50eHMuZmlsdGVyKCh0KSA9PiBMLmtpbmRPZih0KSA9PT0gJ2V4cGVuc2UnKS5yZWR1Y2UoKHMsIHQpID0+IHMgKyB0LmFtb3VudCwgMCk7CiAgICBpZiAoIWNvbmZpcm0oYCcke2MucGF5TmFtZX0nKOycvCnroZwg67mg7KC464KY6rCEIOuCtOyXrSAke2MudHhzLmxlbmd0aH3qsbQoJHt3b24odG90YWwpfSnsnYQg66qo65GQICfrgrQg6rOE7KKMIOydtOyytCfroZwg67CU6r+A6rmM7JqUPyDsp4Dstpzsl5DshJwg67mg7KeA6rOgLCDsubTsubTsmKTtjpjsnbQg6rKw7KCc64K07Jet7Jy866Gc66eMIOyngOy2nOydhCDshYnri4jri6QuYCkpIHJldHVybjsKICAgIGlmICghYy5hY2NvdW50KSB7CiAgICAgIFMoKS5hY2NvdW50cy5wdXNoKHsgaWQ6IGBhLSR7dWlkKCl9YCwgbmFtZTogJ+y5tOy5tOyYpO2OmOydtCcsIHR5cGU6ICdwYXknLCBwYXlOYW1lOiBjLnBheU5hbWUsIGxhc3Q0OiAnJywgaXNTYXZpbmdzOiBmYWxzZSwgYmFsYW5jZTogbnVsbCwgYmFsYW5jZUF0OiAnJyB9KTsKICAgIH0gZWxzZSBpZiAoYy5uZWVkc1R5cGUpIHsKICAgICAgT2JqZWN0LmFzc2lnbihjLmFjY291bnQsIHsgdHlwZTogJ3BheScsIHBheU5hbWU6IGMucGF5TmFtZSwgaXNTYXZpbmdzOiBmYWxzZSB9KTsKICAgIH0KICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICBhd2FpdCBidXN5KGDrsJTqvrjripQg7KSR4oCmICgke2MudHhzLmxlbmd0aH3qsbQpYCwgYXN5bmMgKCkgPT4gewogICAgICBmb3IgKGNvbnN0IHQgb2YgYy50eHMpIGF3YWl0IHN0b3JlLnVwZGF0ZVRyYW5zYWN0aW9uKHQuaWQsIHsga2luZDogJ3RyYW5zZmVyJywgY2F0ZWdvcnlJZDogbnVsbCwgbWV0aG9kOiBudWxsIH0pOwogICAgfSk7CiAgICB0b2FzdChgJHtjLnR4cy5sZW5ndGh96rG07J2EIOuCtCDqs4Tsoowg7J207LK066GcIOuwlOq/qOyWtOyalC4g7JWe7Jy866GcIOuTpOyWtOyYpOuKlCDsubTsubTsmKTtjpjsnbQg7Lac6riI64+EIOyekOuPmeycvOuhnCDrgrQg6rOE7KKMIOydtOyytOqwgCDrj7zsmpQuYCk7CiAgICByZW5kZXIoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJ1blJlY2xhc3NpZnkob25seVVuY2xhc3NpZmllZCkgewogICAgY29uc3QgbGFiZWwgPSBzdG9yZS5haUVuYWJsZWQgPyAnQUnqsIAg64uk7IucIOu2hOulmO2VmOuKlCDspJHigKYnIDogJ+uLpOyLnCDrtoTrpZjtlZjripQg7KSR4oCmJzsKICAgIGNvbnN0IG4gPSBhd2FpdCBidXN5KGxhYmVsLCAoKSA9PiBzdG9yZS5yZWNsYXNzaWZ5KGN1cnJlbnRQZXJpb2QsIG9ubHlVbmNsYXNzaWZpZWQpKTsKICAgIHRvYXN0KG4gPyBgJHtufeqxtOydhCDri6Tsi5wg67aE66WY7ZaI7Iq164uI64ukLmAgOiAn64uk7IucIOu2hOulmO2VoCDsp4DstpzsnbQg7JeG7Iq164uI64ukLicpOwogICAgcmVuZGVyKCk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOumrO2PrO2KuCAtLS0tLS0tLS0tCgogIGZ1bmN0aW9uIHBlcmlvZExhYmVsKHApIHsKICAgIGNvbnN0IHsgbSwgZCB9ID0gTC5wYXJzZUlTTyhwLnN0YXJ0KTsKICAgIHJldHVybiBTKCkuc2V0dGluZ3Muc3RhcnREYXkgPT09IDEgPyBgJHttfeyblGAgOiBgJHttfS8ke2R9YDsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclJlcG9ydCgpIHsKICAgIGNvbnN0IGNtcCA9IEwuY29tcGFyZVdpdGhQcmV2aW91cyhTKCksIGN1cnJlbnRQZXJpb2QpOwogICAgY29uc3Qgc3VtID0gY21wLmN1cnJlbnQ7CiAgICBjb25zdCBkaWZmID0gY21wLnRvdGFsRGlmZjsKICAgIGNvbnN0IHByZXZTcGVudCA9IGNtcC5wcmV2aW91cy50b3RhbFNwZW50OwogICAgbGV0IGRlbHRhVGV4dDsKICAgIGlmICghcHJldlNwZW50ICYmICFzdW0udG90YWxTcGVudCkgZGVsdGFUZXh0ID0gJ+yVhOyngSDsp4DstpzsnbQg7JeG7Ja07JqULic7CiAgICBlbHNlIGlmICghcHJldlNwZW50KSBkZWx0YVRleHQgPSAn7KeA64KcIOq4sOqwhCDquLDroZ3snbQg7JeG7Ja0IOu5hOq1kO2VoCDsiJgg7JeG7Ja07JqULic7CiAgICBlbHNlIGlmIChkaWZmID4gMCkgZGVsdGFUZXh0ID0gYOyngOuCnCDquLDqsITrs7Tri6QgPGI+JHt3b24oZGlmZil9IOuNlDwvYj4g7I287Ja07JqUIOKWsmA7CiAgICBlbHNlIGlmIChkaWZmIDwgMCkgZGVsdGFUZXh0ID0gYOyngOuCnCDquLDqsITrs7Tri6QgPGI+JHt3b24oLWRpZmYpfSDrjZw8L2I+IOyNvOyWtOyalCDilrxgOwogICAgZWxzZSBkZWx0YVRleHQgPSAn7KeA64KcIOq4sOqwhOqzvCDrmJHqsJnsnbQg7I287Ja07JqULic7CiAgICBjb25zdCBidWRnZXRMaW5lID0gc3VtLmhhc0luY29tZSAmJiBzdW0uaW5jb21lID4gMCA/IGA8ZGl2IGNsYXNzPSJkZWx0YSI+7JiI7IKw7J2YIDxiPiR7TWF0aC5yb3VuZCgoc3VtLnRvdGFsU3BlbnQgLyBzdW0uaW5jb21lKSAqIDEwMCl9JTwvYj4g7IKs7JqpPC9kaXY+YCA6ICcnOwogICAgJCgnI3JlcG9ydC1oZWFkbGluZScpLmlubmVySFRNTCA9IGAKICAgICAgPGRpdiBjbGFzcz0ibXV0ZWQgc21hbGwiPuydtOuyiCDquLDqsIQg7KeA7LacPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhlYWRsaW5lLWZpZ3VyZSI+JHt3b24oc3VtLnRvdGFsU3BlbnQpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJkZWx0YSI+JHtkZWx0YVRleHR9PC9kaXY+CiAgICAgICR7YnVkZ2V0TGluZX1gOwoKICAgIGNvbnN0IHRvcCA9IEwudG9wTWVyY2hhbnRzKHN1bS5hbGxUcmFuc2FjdGlvbnMsIDUpOwogICAgJCgnI3JlcG9ydC1tZXJjaGFudHMnKS5pbm5lckhUTUwgPSBgPGgyPuunjuydtCDsk7Qg6rOzPC9oMj4ke3RvcC5sZW5ndGgKICAgICAgPyB0b3AubWFwKChtLCBpKSA9PiBgPGRpdiBjbGFzcz0icmFuayI+PHNwYW4gY2xhc3M9Im4iPiR7aSArIDF9PC9zcGFuPjxzcGFuIGNsYXNzPSJtIj4ke2VzYyhtLm1lbW8pfSA8c3BhbiBjbGFzcz0ibXV0ZWQgc21hbGwiPiR7bS5jb3VudH3tmow8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJhIj4ke3dvbihtLnRvdGFsKX08L3NwYW4+PC9kaXY+YCkuam9pbignJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuyngOy2nOydtCDsl4bslrTsmpQuPC9kaXY+J31gOwoKICAgIGNvbnN0IHJvd3MgPSBMLmNhdGVnb3J5QnJlYWtkb3duKHN1bSk7CiAgICBjb25zdCBkaWZmQnlJZCA9IHt9OwogICAgZm9yIChjb25zdCByIG9mIGNtcC5yb3dzKSBkaWZmQnlJZFtyLmlkXSA9IHIuZGlmZjsKICAgIGNvbnN0IHNoYXJlID0gJCgnI3JlcG9ydC1zaGFyZScpOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgewogICAgICBzaGFyZS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPuydtCDquLDqsIQg7KeA7Lac7J20IOyXhuyWtOyalC48L2Rpdj4nOwogICAgfSBlbHNlIHsKICAgICAgY29uc3QgZm10RGlmZiA9IChkKSA9PiAoZCA9PT0gdW5kZWZpbmVkID8gJycgOiBkID4gMCA/IGDilrIgJHt3b24oZCl9YCA6IGQgPCAwID8gYOKWvCAke3dvbigtZCl9YCA6ICfrs4Drj5kg7JeG7J2MJyk7CiAgICAgIHNoYXJlLmlubmVySFRNTCA9IEMuc2hhcmVCYXIocm93cykgKyByb3dzLm1hcCgocikgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9InNoYXJlLXJvdyI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic2hhcmUtbmFtZSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JHtDLnNlcmllc0NvbG9yKHIuY29sb3JJbmRleCl9Ij48L3NwYW4+PHNwYW4+JHtlc2Moci5uYW1lKX0gPHNwYW4gY2xhc3M9Im11dGVkIHNtYWxsIj4ke01hdGgucm91bmQoci5zaGFyZSAqIDEwMCl9JTwvc3Bhbj48L3NwYW4+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InNoYXJlLWFtb3VudCI+JHt3b24oci5hbW91bnQpfTwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzaGFyZS1kaWZmIiB0aXRsZT0i7KeA64KcIOq4sOqwhCDrjIDruYQiPiR7Zm10RGlmZihkaWZmQnlJZFtyLmlkXSl9PC9zcGFuPgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpOwogICAgICBjb25zdCBzZWdzID0gQy5zaGFyZVNlZ21lbnRzKHJvd3MpOwogICAgICBzaGFyZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1zZWddJykuZm9yRWFjaCgoZWwpID0+IHsKICAgICAgICBjb25zdCBzID0gc2Vnc1tlbC5kYXRhc2V0LnNlZ107CiAgICAgICAgYXR0YWNoVG9vbHRpcChlbCwgKCkgPT4gYDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDoke3MuY29sb3J9Ij48L3NwYW4+JHtlc2Mocy5uYW1lKX08L3NwYW4+PHNwYW4+JHt3b24ocy5hbW91bnQpfTwvc3Bhbj48L2Rpdj5gKTsKICAgICAgfSk7CiAgICB9CgogICAgY29uc3QgdHIgPSBMLnRyZW5kKFMoKSwgY3VycmVudFBlcmlvZCwgNik7CiAgICBjb25zdCBkYXRhID0gdHIubWFwKCh4KSA9PiAoeyBsYWJlbDogcGVyaW9kTGFiZWwoeC5wZXJpb2QpLCBpbmNvbWU6IHguYnVkZ2V0SW5jb21lICE9PSBudWxsID8geC5idWRnZXRJbmNvbWUgOiB4LmluY29tZVJlY2VpdmVkLCBzcGVudDogeC5zcGVudCB9KSk7CiAgICBjb25zdCB0cmVuZEVsID0gJCgnI3JlcG9ydC10cmVuZCcpOwogICAgdHJlbmRFbC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9ImxlZ2VuZCI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tczEpIj48L3NwYW4+7IiY7J6FPC9zcGFuPjxzcGFuPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLXMyKSI+PC9zcGFuPuyngOy2nDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2hhcnQiPiR7Qy50cmVuZENoYXJ0KGRhdGEpfTwvZGl2PmA7CiAgICB0cmVuZEVsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5oaXQnKS5mb3JFYWNoKChlbCkgPT4gewogICAgICBjb25zdCBpID0gTnVtYmVyKGVsLmRhdGFzZXQuaSk7CiAgICAgIGNvbnN0IHggPSB0cltpXTsKICAgICAgYXR0YWNoVG9vbHRpcChlbCwgKCkgPT4gYAogICAgICAgIDxzdHJvbmc+JHtmbXREYXRlKHgucGVyaW9kLnN0YXJ0KX0gfjwvc3Ryb25nPgogICAgICAgIDxkaXYgY2xhc3M9InQtcm93Ij48c3Bhbj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1zMSkiPjwvc3Bhbj7siJjsnoUke3guYnVkZ2V0SW5jb21lID09PSBudWxsID8gJyAo67Cb7J2AIOyeheq4iCknIDogJyd9PC9zcGFuPjxzcGFuPiR7d29uKGRhdGFbaV0uaW5jb21lIHx8IDApfTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0LXJvdyI+PHNwYW4+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tczIpIj48L3NwYW4+7KeA7LacPC9zcGFuPjxzcGFuPiR7d29uKHguc3BlbnQpfTwvc3Bhbj48L2Rpdj5gKTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY3VycmVudFBlcmlvZCA9IHgucGVyaW9kOwogICAgICAgIHJlbmRlcigpOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsnpDsgrAgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBwYXlGbG93VGV4dChpZCkgewogICAgY29uc3QgZiA9IEwucGF5Rmxvd3MoUygpLCBjdXJyZW50UGVyaW9kKS5maW5kKCh4KSA9PiB4LmFjY291bnQuaWQgPT09IGlkKTsKICAgIHJldHVybiBg6rCE7Y646rKw7KCcIOuouOuLiCDCtyDsnbTrsogg6riw6rCEIOy2qeyghCAke3dvbihmID8gZi50b3B1cCA6IDApfSDCtyDqsrDsoJwgJHt3b24oZiA/IGYuc3BlbnQgOiAwKX0ke2YgJiYgZi5jb3VudCA/IGAgKCR7Zi5jb3VudH3qsbQpYCA6ICcnfWA7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJBc3NldHMoKSB7CiAgICBjb25zdCBhID0gTC5hc3NldFN1bW1hcnkoUygpLCBjdXJyZW50UGVyaW9kKTsKICAgIGNvbnN0IGhhc0JhbGFuY2UgPSBhLmJhbmtzLnNvbWUoKGIpID0+IHR5cGVvZiBiLmJhbGFuY2UgPT09ICdudW1iZXInKTsKICAgICQoJyNhc3NldC1oZXJvJykuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJsYWJlbCI+VE9UQUwgQkFMQU5DRTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWd1cmUiPiR7aGFzQmFsYW5jZSA/IHdvbihhLnRvdGFsKSA6ICfigJQnfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPiR7YS5zYXZpbmdzID8gYOyggOy2lSDqs4TsoowgJHt3b24oYS5zYXZpbmdzKX0gwrcgYCA6ICcnfeuTseuhne2VnCDqs4TsoowgJHthLmJhbmtzLmxlbmd0aH3qsJwsIOy5tOuTnCAke2EuY2FyZHMubGVuZ3RofeqwnDwvZGl2PmA7CgogICAgY29uc3QgYmFua3MgPSAkKCcjYXNzZXQtYmFua3MnKTsKICAgIGJhbmtzLmlubmVySFRNTCA9IGEuYmFua3MubGVuZ3RoCiAgICAgID8gYS5iYW5rcy5tYXAoKGIpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtaWNvbiI+JHtlc2MoKGIubmFtZSB8fCAn6rOE7KKMJykuc2xpY2UoMCwgMSkpfTwvZGl2PgogICAgICAgICAgPGRpdj48ZGl2IGNsYXNzPSJhY2N0LW5hbWUiPiR7ZXNjKGFjY291bnROYW1lKGIuaWQpKX08L2Rpdj48ZGl2IGNsYXNzPSJhY2N0LXN1YiI+JHtiLnR5cGUgPT09ICdwYXknID8gcGF5Rmxvd1RleHQoYi5pZCkgOiBg64Gd7J6Q66asICR7ZXNjKGIubGFzdDQgfHwgJy0tLS0nKX0ke2IuaXNTYXZpbmdzID8gJyDCtyDsoIDstpUnIDogJyd9JHtiLnNwZW50ID8gYCDCtyDsnbTrsogg6riw6rCEIOy2nOq4iCAke3dvbihiLnNwZW50KX1gIDogJyd9YH08L2Rpdj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3R5cGVvZiBiLmJhbGFuY2UgPT09ICdudW1iZXInID8gd29uKGIuYmFsYW5jZSkgOiAnPHNwYW4gY2xhc3M9Im11dGVkIj7snpTslaEg66+47J6F66ClPC9zcGFuPid9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3Qtc3ViIj4ke2IuYmFsYW5jZUF0ID8gYCR7Zm10RGF0ZVRpbWUoYi5iYWxhbmNlQXQpfSDquLDspIAgYCA6ICcnfTxidXR0b24gY2xhc3M9ImxpbmsgZWRpdC1iYWxhbmNlIiBkYXRhLWlkPSIke2VzYyhiLmlkKX0iPuyImOyglTwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDqs4TsoozqsIAg7JeG7Ja07JqULiA8YnV0dG9uIGNsYXNzPSJsaW5rIiBkYXRhLWdvdG89InNldHRpbmdzIj7qs4Tsoowg65Ox66Gd7ZWY6riwPC9idXR0b24+PC9kaXY+JzsKICAgIGJhbmtzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5lZGl0LWJhbGFuY2UnKS5mb3JFYWNoKChidG4pID0+IGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgY29uc3QgYWNjID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IGJ0bi5kYXRhc2V0LmlkKTsKICAgICAgY29uc3QgdiA9IHByb21wdChgJHthY2NvdW50TmFtZShhY2MuaWQpfSDsnZgg7ZiE7J6sIOyelOyVoSjsm5ApYCwgdHlwZW9mIGFjYy5iYWxhbmNlID09PSAnbnVtYmVyJyA/IFN0cmluZyhhY2MuYmFsYW5jZSkgOiAnJyk7CiAgICAgIGlmICh2ID09PSBudWxsKSByZXR1cm47CiAgICAgIGNvbnN0IG4gPSBwYXJzZUFtb3VudElucHV0KHYpOwogICAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIHRvYXN0KCfsiKvsnpDroZwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgICAgYWNjLmJhbGFuY2UgPSBuOwogICAgICBhY2MuYmFsYW5jZUF0ID0gbm93SVNPKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpOwoKICAgICQoJyNhc3NldC1jYXJkcycpLmlubmVySFRNTCA9IGEuY2FyZHMubGVuZ3RoCiAgICAgID8gYS5jYXJkcy5tYXAoKGMpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJhY2N0Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjY3QtaWNvbiBpcy1jYXJkIj4ke2VzYygoYy5uYW1lIHx8ICfsubTrk5wnKS5zbGljZSgwLCAxKSl9PC9kaXY+CiAgICAgICAgICA8ZGl2PjxkaXYgY2xhc3M9ImFjY3QtbmFtZSI+JHtlc2MoYWNjb3VudE5hbWUoYy5pZCkpfTwvZGl2PjxkaXYgY2xhc3M9ImFjY3Qtc3ViIj7rgZ3snpDrpqwgJHtlc2MoYy5sYXN0NCB8fCAnLS0tLScpfTwvZGl2PjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iYWNjdC1iYWwiPiR7d29uKGMuc3BlbnQpfTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpICsgKGEudW5saW5rZWRTcGVudCA/IGA8ZGl2IGNsYXNzPSJhY2N0Ij48ZGl2IGNsYXNzPSJhY2N0LWljb24gaXMtY2FyZCI+PzwvZGl2PjxkaXY+PGRpdiBjbGFzcz0iYWNjdC1uYW1lIj7qsrDsoJzsiJjri6gg66qo66aEPC9kaXY+PGRpdiBjbGFzcz0iYWNjdC1zdWIiPuyVjOumvOyXkOyEnCDsubTrk5zCt+qzhOyijOulvCDssL7sp4Ag66q77ZWcIOyngOy2nDwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjY3QtYmFsIj4ke3dvbihhLnVubGlua2VkU3BlbnQpfTwvZGl2PjwvZGl2PmAgOiAnJykKICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPuuTseuhne2VnCDsubTrk5zqsIAg7JeG7Ja07JqULjwvZGl2Pic7CiAgICAkJCgnI2Fzc2V0LWJhbmtzIFtkYXRhLWdvdG9dLCAjYXNzZXQtY2FyZHMgW2RhdGEtZ290b10nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2hvd1BhZ2UoYi5kYXRhc2V0LmdvdG8pKSk7CiAgfQoKICAvLyAtLS0tLS0tLS0tIOyYiOyCsCDqs4Ttmo0gLS0tLS0tLS0tLQoKICAvLyDsnbQg6riw6rCE7J2YIOqzhO2ajeydhCDqs6DsuZjquLAg7KCE7JeQIO2YuOy2nDog7KeA64KcIOq4sOqwhCDqs4Ttmo3snYQg66y866Ck67Cb6rOgIOyeiOyXiOuLpOuptCDsnbQg6riw6rCE67aA7YSwIOyggeyaqeuQmOuKlCDsg4gg6rOE7ZqN7J2EIOunjOuToOuLpC4KICAvLyDtlZzrj4Qg6rOE7IKwIOuwqeyLneunjCDrsJTqv4Ag65WMOiDrtoTrpZjsmYAg7IOB6rSA7JeG7Jy864uIICfri6Tsi5wg67aE66WYJyDslYjrgrTqsIAg65yo7KeAIOyViuqyjCDsiJjsoJUg7Iuc6rCB7J2EIOq3uOuMgOuhnCDrkZTri6QKICBmdW5jdGlvbiBidWRnZXRQbGFuKCkgewogICAgY29uc3QgYmVmb3JlID0gY3VycmVudFBsYW4oKTsKICAgIGNvbnN0IHBsYW4gPSBMLmVuc3VyZVBsYW5Gb3IoUygpLCBjdXJyZW50UGVyaW9kLmtleSwgbm93SVNPKCkpOwogICAgaWYgKHBsYW4gIT09IGJlZm9yZSkgcGxhbi51cGRhdGVkQXQgPSBiZWZvcmUudXBkYXRlZEF0OwogICAgcmV0dXJuIHBsYW47CiAgfQoKICBmdW5jdGlvbiBlZGl0YWJsZVBsYW4oKSB7CiAgICBjb25zdCBwbGFuID0gTC5lbnN1cmVQbGFuRm9yKFMoKSwgY3VycmVudFBlcmlvZC5rZXksIG5vd0lTTygpKTsKICAgIHBsYW4udXBkYXRlZEF0ID0gbm93SVNPKCk7CiAgICByZXR1cm4gcGxhbjsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclBsYW5WZXJzaW9uKCkgewogICAgY29uc3QgcGxhbiA9IGN1cnJlbnRQbGFuKCk7CiAgICBjb25zdCBpbmhlcml0ZWQgPSBwbGFuLmZyb20gIT09IGN1cnJlbnRQZXJpb2Qua2V5OwogICAgY29uc3QgbmV4dCA9IEwubmV4dFBsYW5BZnRlcihTKCksIHsgZnJvbTogY3VycmVudFBlcmlvZC5rZXkgfSk7CiAgICBjb25zdCBwYXJ0cyA9IFtgPGI+JHtmbXREYXRlKGN1cnJlbnRQZXJpb2Quc3RhcnQpfSDquLDqsITsnZgg6rOE7ZqNPC9iPmBdOwogICAgcGFydHMucHVzaChwbGFuLmZyb20gPT09IEwuQkFTRV9QTEFOX0ZST00gPyAn7LKY7J2M67aA7YSwIOyTsOuNmCDqs4Ttmo3snoXri4jri6QuJyA6IGAke2ZtdERhdGUocGxhbi5mcm9tKX0g6riw6rCE67aA7YSwIOyggeyaqeuQnCDqs4Ttmo3snoXri4jri6QuYCk7CiAgICBwYXJ0cy5wdXNoKGluaGVyaXRlZAogICAgICA/ICfsl6zquLDshJwg6rOg7LmY66m0IDxiPuydtOuyiCDquLDqsITrtoDthLA8L2I+IOyDiCDqs4Ttmo3snLzroZwg7KCA7J6l65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuVjCDqs4Ttmo0g6re464yA66GcIOuCqOyVhOyalC4nCiAgICAgIDogJ+qzoOy5mOuptCDsnbQg6riw6rCE6rO8IOydtO2bhCDquLDqsITsl5Ag7KCB7Jqp65CY6rOgLCDsp4Drgpwg6riw6rCE7J2AIOq3uOuMgOuhnCDrgqjslYTsmpQuJyk7CiAgICBpZiAobmV4dCkgcGFydHMucHVzaChgJHtmbXREYXRlKG5leHQuZnJvbSl9IOq4sOqwhOu2gO2EsOuKlCDqt7gg65Kk7JeQIOuwlOq+vCDqs4Ttmo3snbQg7KCB7Jqp64+87JqULmApOwogICAgJCgnI3BsYW4tdmVyc2lvbicpLmlubmVySFRNTCA9IHBhcnRzLm1hcCgoeCkgPT4gYDxkaXYgY2xhc3M9InNtYWxsIj4ke3h9PC9kaXY+YCkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJQbGFuKCkgewogICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgIGNvbnN0IHBsYW4gPSBjdXJyZW50UGxhbigpOwogICAgJCgnI3JhdGlvLWJhc2UnKS52YWx1ZSA9IHBsYW4ucmF0aW9CYXNlOwogICAgJCgnI2ZpeGVkLW92ZXJmbG93JykudmFsdWUgPSBwbGFuLmZpeGVkT3ZlcmZsb3cgfHwgJ3dhcm4nOwoKICAgIGNvbnN0IHJvd3NFbCA9ICQoJyNwbGFuLXJvd3MnKTsKICAgIHJvd3NFbC5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9InBsYW4tcm93IGhlYWQiPjxzcGFuPu2VreuqqSDsnbTrpoQ8L3NwYW4+PHNwYW4+67Cp7IudPC9zcGFuPjxzcGFuPuu5hOycqCAvIOq4iOyVoTwvc3Bhbj48c3Bhbj7shKTrqoUgKEFJIOywuOqzoCk8L3NwYW4+PHNwYW4+7YKk7JuM65OcPC9zcGFuPjxzcGFuPjwvc3Bhbj48L2Rpdj4KICAgICAgJHtwbGFuLmNhdGVnb3JpZXMubWFwKChjKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0icGxhbi1yb3ciIGRhdGEtaWQ9IiR7ZXNjKGMuaWQpfSI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InBsLW5hbWUiIHZhbHVlPSIke2VzYyhjLm5hbWUpfSIgYXJpYS1sYWJlbD0i7ZWt66qpIOydtOumhCI+CiAgICAgICAgICA8c2VsZWN0IGNsYXNzPSJwbC10eXBlIiBhcmlhLWxhYmVsPSLrsKnsi50iPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyYXRpbyIgJHtjLnR5cGUgPT09ICdyYXRpbycgPyAnc2VsZWN0ZWQnIDogJyd9PuyImOyehSDruYTroYAoJSk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZml4ZWQiICR7Yy50eXBlID09PSAnZml4ZWQnID8gJ3NlbGVjdGVkJyA6ICcnfT7qs6DsoJUg6riI7JWhPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDxkaXYgY2xhc3M9InZhbHVlLXdyYXAiPgogICAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaW5wdXRtb2RlPSJkZWNpbWFsIiBjbGFzcz0icGwtdmFsdWUiIHZhbHVlPSIke2MudHlwZSA9PT0gJ2ZpeGVkJyA/IE51bWJlcihjLnZhbHVlKS50b0xvY2FsZVN0cmluZygna28tS1InKSA6IGMudmFsdWV9IiBhcmlhLWxhYmVsPSLqsJIiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idW5pdCI+JHtjLnR5cGUgPT09ICdmaXhlZCcgPyAn7JuQJyA6ICclJ308L3NwYW4+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwtZGVzYyIgdmFsdWU9IiR7ZXNjKGMuZGVzY3JpcHRpb24gfHwgJycpfSIgcGxhY2Vob2xkZXI9IuyYiDog7Jm47IudLCDrsLDri6wsIOyepeuztOq4sCIgYXJpYS1sYWJlbD0i7ISk66qFIj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icGwta3ciIHZhbHVlPSIke2VzYygoYy5rZXl3b3JkcyB8fCBbXSkuam9pbignLCAnKSl9IiBwbGFjZWhvbGRlcj0i7JiIOiDsiqTtg4DrsoXsiqQsIOy5tO2OmCIgYXJpYS1sYWJlbD0i7YKk7JuM65OcIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImxpbmstYnRuIHBsLWRlbCIgYXJpYS1sYWJlbD0iJHtlc2MoYy5uYW1lKX0g7IKt7KCcIj7inJU8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgY2xhc3M9InByZXZpZXciPjwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpfWA7CgogICAgY29uc3QgZWRpdCA9IChpZCwgZm4sIHJlcmVuZGVyKSA9PiB7CiAgICAgIGNvbnN0IGMgPSBlZGl0YWJsZVBsYW4oKS5jYXRlZ29yaWVzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgICAgZm4oYyk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgIGlmIChyZXJlbmRlcikgcmVuZGVyUGxhbigpOwogICAgICBlbHNlIHsKICAgICAgICByZW5kZXJQbGFuVmVyc2lvbigpOwogICAgICAgIHJlbmRlclBsYW5TdW1tYXJ5KCk7CiAgICAgIH0KICAgIH07CgogICAgcm93c0VsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5wbGFuLXJvd1tkYXRhLWlkXScpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBpZCA9IHJvdy5kYXRhc2V0LmlkOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLW5hbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IChjLm5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCkgfHwgJ+ydtOumhCDsl4bsnYwnKSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXR5cGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gZWRpdChpZCwgKGMpID0+IHsKICAgICAgICBjLnR5cGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBjLnZhbHVlID0gMDsKICAgICAgfSwgdHJ1ZSkpOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLnBsLXZhbHVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiB7CiAgICAgICAgY29uc3QgbiA9IE51bWJlcihlLnRhcmdldC52YWx1ZS5yZXBsYWNlKC9bXlxkLl0vZywgJycpKSB8fCAwOwogICAgICAgIGMudmFsdWUgPSBjLnR5cGUgPT09ICdmaXhlZCcgPyBNYXRoLnJvdW5kKG4pIDogTWF0aC5yb3VuZChuICogMTAwKSAvIDEwMDsKICAgICAgICBpZiAoYy50eXBlID09PSAnZml4ZWQnKSBlLnRhcmdldC52YWx1ZSA9IGMudmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJyk7CiAgICAgIH0pKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1kZXNjJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IGVkaXQoaWQsIChjKSA9PiAoYy5kZXNjcmlwdGlvbiA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKSkpKTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5wbC1rdycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBlZGl0KGlkLCAoYykgPT4gewogICAgICAgIGMua2V5d29yZHMgPSBlLnRhcmdldC52YWx1ZS5zcGxpdCgvWyzvvIxdLykubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICB9KSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcucGwtZGVsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgY29uc3QgYyA9IGN1cnJlbnRQbGFuKCkuY2F0ZWdvcmllcy5maW5kKCh4KSA9PiB4LmlkID09PSBpZCk7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHtjLm5hbWV9JyDtla3rqqnsnYQg7J2067KIIOq4sOqwhCDqs4Ttmo3rtoDthLAg67qE6rmM7JqUPyDsnbQg7ZWt66qp7Jy866GcIOu2hOulmOuQnCDsnbTrsogg6riw6rCEIOyngOy2nOydgCDri6Tsi5wg67aE66WY7ZW07JW8IO2VqeuLiOuLpC5gKSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHAgPSBlZGl0YWJsZVBsYW4oKTsKICAgICAgICBwLmNhdGVnb3JpZXMgPSBwLmNhdGVnb3JpZXMuZmlsdGVyKCh4KSA9PiB4LmlkICE9PSBpZCk7CiAgICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgICByZW5kZXJQbGFuKCk7CiAgICAgIH0pOwogICAgfSk7CiAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUGxhblN1bW1hcnkoKSB7CiAgICBjb25zdCBwbGFuID0gY3VycmVudFBsYW4oKTsKICAgIGNvbnN0IGluY29tZSA9IFMoKS5pbmNvbWVzW2N1cnJlbnRQZXJpb2Qua2V5XTsKICAgIGNvbnN0IGhhc0luY29tZSA9IHR5cGVvZiBpbmNvbWUgPT09ICdudW1iZXInOwogICAgY29uc3QgY2FsYyA9IEwuY29tcHV0ZUJ1ZGdldHMocGxhbi5jYXRlZ29yaWVzLCBoYXNJbmNvbWUgPyBpbmNvbWUgOiAwLCBwbGFuLnJhdGlvQmFzZSwgcGxhbi5maXhlZE92ZXJmbG93KTsKCiAgICAkJCgnLnBsYW4tcm93W2RhdGEtaWRdJykuZm9yRWFjaCgocm93KSA9PiB7CiAgICAgIGNvbnN0IGMgPSBwbGFuLmNhdGVnb3JpZXMuZmluZCgoeCkgPT4geC5pZCA9PT0gcm93LmRhdGFzZXQuaWQpOwogICAgICBjb25zdCBwID0gcm93LnF1ZXJ5U2VsZWN0b3IoJy5wcmV2aWV3Jyk7CiAgICAgIGlmICghYykgcmV0dXJuOwogICAgICBpZiAoYy50eXBlID09PSAnZml4ZWQnKSB7CiAgICAgICAgcC50ZXh0Q29udGVudCA9IGhhc0luY29tZSAmJiBjYWxjLmZpeGVkU2NhbGVkCiAgICAgICAgICA/IGDsnbTrsogg6riw6rCEIO2VnOuPhCAke3dvbihjYWxjLmJ1ZGdldHNbYy5pZF0pfSAo7IiY7J6F7J20IOuqqOyekOudvCDspITsnoQpYAogICAgICAgICAgOiAn7IiY7J6F6rO8IOyDgeq0gOyXhuydtCDrp6Qg6riw6rCEIOqwmeydgCDtlZzrj4QnOwogICAgICB9CiAgICAgIGVsc2UgcC50ZXh0Q29udGVudCA9IGhhc0luY29tZSA/IGDsnbTrsogg6riw6rCEIO2VnOuPhCAke3dvbihjYWxjLmJ1ZGdldHNbYy5pZF0pfWAgOiAn64u56riwIOyImOyeheydhCDsnoXroKXtlZjrqbQg7ZWc64+E6rCAIOqzhOyCsOuQqeuLiOuLpCc7CiAgICB9KTsKCiAgICBjb25zdCBiYXNlID0gcGxhbi5yYXRpb0Jhc2UgPT09ICdhZnRlckZpeGVkJyA/ICfqs6DsoJUg7ZWt66qp7J2EIOu6gCDrgpjrqLjsp4AnIDogJ+yghOyytCDsiJjsnoUnOwogICAgY29uc3QgbGluZXMgPSBbYOqzoOyglSDtla3rqqkg7ZWp6rOEIDxiPiR7d29uKGNhbGMuZml4ZWRUb3RhbCl9PC9iPiDCtyDruYTsnKgg7ZWt66qpIO2VqeqzhCA8Yj4ke2NhbGMucmF0aW9QZXJjZW50VG90YWx9JTwvYj4gKCR7YmFzZX0g6riw7KSAKWBdOwogICAgaWYgKGNhbGMucmF0aW9QZXJjZW50VG90YWwgPiAxMDApIGxpbmVzLnB1c2goJzxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg67mE7JyoIO2VqeqzhOqwgCAxMDAl66W8IOuEmOyKteuLiOuLpC48L3NwYW4+Jyk7CiAgICBlbHNlIGlmIChjYWxjLnJhdGlvUGVyY2VudFRvdGFsIDwgMTAwKSBsaW5lcy5wdXNoKGA8c3BhbiBjbGFzcz0ibXV0ZWQiPuu5hOycqCDtlanqs4TqsIAgMTAwJeuztOuLpCAke01hdGgucm91bmQoKDEwMCAtIGNhbGMucmF0aW9QZXJjZW50VG90YWwpICogMTAwKSAvIDEwMH0lIOyggeyWtCDsnbzrtoAg7IiY7J6F7J2AIOuwsOu2hOuQmOyngCDslYrsirXri4jri6QuPC9zcGFuPmApOwogICAgaWYgKGhhc0luY29tZSkgewogICAgICBsaW5lcy5wdXNoKGDsnbTrsogg6riw6rCEIOyImOyehSAke3dvbihpbmNvbWUpfSDquLDspIA6IOuwsOu2hCAke3dvbihjYWxjLmFsbG9jYXRlZCl9YCArCiAgICAgICAgKGNhbGMudW5hbGxvY2F0ZWQgPj0gMCA/IGAgwrcg64Ko64qUIOuPiCAke3dvbihjYWxjLnVuYWxsb2NhdGVkKX1gIDogYCDCtyA8c3BhbiBjbGFzcz0id2FybiI+JHt3b24oLWNhbGMudW5hbGxvY2F0ZWQpfSDrtoDsobE8L3NwYW4+YCkpOwogICAgICBpZiAoY2FsYy5maXhlZE92ZXIpIHsKICAgICAgICBsaW5lcy5wdXNoKGNhbGMuZml4ZWRTY2FsZWQKICAgICAgICAgID8gYDxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukICR7d29uKGNhbGMuZml4ZWRPdmVyKX0g66eO7JWELCDqs6DsoJUg7ZWt66qpIO2VnOuPhOulvCDslb0gJHtNYXRoLnJvdW5kKGNhbGMuZml4ZWRTY2FsZSAqIDEwMCl9JeuhnCDspITsmIDsirXri4jri6QuPC9zcGFuPmAKICAgICAgICAgIDogYDxzcGFuIGNsYXNzPSJ3YXJuIj7imqAg6rOg7KCVIO2VreuqqSDtlanqs4TqsIAg7IiY7J6F67O064ukICR7d29uKGNhbGMuZml4ZWRPdmVyKX0g66eO7Iq164uI64ukLjwvc3Bhbj5gKTsKICAgICAgfQogICAgfQogICAgJCgnI3BsYW4tc3VtbWFyeScpLmlubmVySFRNTCA9IGxpbmVzLm1hcCgobCkgPT4gYDxkaXY+JHtsfTwvZGl2PmApLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gYWRkQ2F0ZWdvcnkoKSB7CiAgICBjb25zdCBwbGFuID0gZWRpdGFibGVQbGFuKCk7CiAgICBwbGFuLmNhdGVnb3JpZXMucHVzaCh7IGlkOiBgYy0ke3VpZCgpfWAsIG5hbWU6ICfsg4gg7ZWt66qpJywgdHlwZTogJ3JhdGlvJywgdmFsdWU6IDAsIGRlc2NyaXB0aW9uOiAnJywga2V5d29yZHM6IFtdIH0pOwogICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIHJlbmRlclBsYW4oKTsKICAgIGNvbnN0IGlucHV0cyA9ICQkKCcucGwtbmFtZScpOwogICAgY29uc3QgbGFzdCA9IGlucHV0c1tpbnB1dHMubGVuZ3RoIC0gMV07CiAgICBsYXN0LmZvY3VzKCk7CiAgICBsYXN0LnNlbGVjdCgpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDsnoXroKUgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiByZW5kZXJBZGQoKSB7CiAgICAkKCcjYXV0by1oaW50JykuaW5uZXJIVE1MID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScKICAgICAgPyAnPGI+7Lm065OcIOusuOyekOyZgCDsnYDtlokg7JWM66a87J2AIOyekOuPmeycvOuhnCDrk6TslrTsmYDsmpQuPC9iPiA8c3BhbiBjbGFzcz0ic21hbGwiPu2ctOuMgO2PsCDsnpDrj5ntmZQo7ISk7KCVIOKGkiDsnpDrj5kg7J6F66ClKeulvCDtlbQg65GQ66m0IOqysOygnMK37J207LK0IOyVjOumvOydtCDsmKwg65WM66eI64ukIEFJ6rCAIOydveqzoCDrtoTrpZjtlbTshJwg6riw66Gd7ZWp64uI64ukLiDsl6zquLDshJzripQg6re4IOuwluydmCDrgrTsl63snYQg64Sj7Jy87IS47JqULjwvc3Bhbj4nCiAgICAgIDogJzxiPuyngOq4iOydgCDsnbQg6riw6riw7JeQ66eMIOyggOyepe2VmOuKlCDrqqjrk5zsmIjsmpQuPC9iPiA8c3BhbiBjbGFzcz0ic21hbGwiPuy5tOuTnMK37J2A7ZaJIOyVjOumvCDsnpDrj5kg7J6F66Cl6rO8IEFJIOu2hOulmOulvCDsk7DroKTrqbQg7ISk7KCVIOKGkiDsnpDrj5kg7J6F66Cl7JeQ7IScIOq1rOq4gCDsi5ztirgg7ISc67KE66W8IOyXsOqysO2VmOyEuOyalC48L3NwYW4+JzsKICAgICQoJyNjbGFzc2lmaWVyLW5hbWUnKS50ZXh0Q29udGVudCA9IHN0b3JlLmFpRW5hYmxlZCA/ICdBSeqwgCDtla3rqqknIDogJ+2CpOybjOuTnOuhnCDtla3rqqknOwoKICAgICQkKCcjbS1raW5kIGJ1dHRvbicpLmZvckVhY2goKGIpID0+IGIuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYi5kYXRhc2V0LmtpbmQgPT09IG1hbnVhbEtpbmQpKTsKICAgICQoJyNtLWNhdGVnb3J5LXdyYXAnKS5oaWRkZW4gPSBtYW51YWxLaW5kICE9PSAnZXhwZW5zZSc7CiAgICBjb25zdCBzZWwgPSAkKCcjbS1jYXRlZ29yeScpOwogICAgY29uc3QgcHJldiA9IHNlbC52YWx1ZSB8fCAnX19hdXRvJzsKICAgIGlmICghJCgnI20tZGF0ZScpLnZhbHVlKSAkKCcjbS1kYXRlJykudmFsdWUgPSBMLnRvZGF5SVNPKCk7CiAgICBzZWwuaW5uZXJIVE1MID0gY2F0ZWdvcnlPcHRpb25zKHBsYW5Gb3JEYXRlKCQoJyNtLWRhdGUnKS52YWx1ZSkuY2F0ZWdvcmllcywgbnVsbCwgeyBpbmNsdWRlQXV0bzogdHJ1ZSB9KTsKICAgIHNlbC52YWx1ZSA9IFsuLi5zZWwub3B0aW9uc10uc29tZSgobykgPT4gby52YWx1ZSA9PT0gcHJldikgPyBwcmV2IDogJ19fYXV0byc7CiAgICBjb25zdCBhY2MgPSAkKCcjbS1hY2NvdW50JykudmFsdWU7CiAgICAkKCcjbS1hY2NvdW50JykuaW5uZXJIVE1MID0gYWNjb3VudE9wdGlvbnMoYWNjKTsKICAgIGNvbnN0IGZpbGVBY2MgPSAkKCcjZmlsZS1hY2NvdW50JykudmFsdWUgfHwgKFMoKS5hY2NvdW50cy5maW5kKChhKSA9PiBhLnR5cGUgIT09ICdjYXJkJykgfHwge30pLmlkIHx8ICcnOwogICAgJCgnI2ZpbGUtYWNjb3VudCcpLmlubmVySFRNTCA9IGFjY291bnRPcHRpb25zKGZpbGVBY2MsICfqs4Tsoowg7ISg7YOdIOyViCDtlagnKTsKICAgICQoJyNwYXN0ZS1hY2NvdW50JykuaW5uZXJIVE1MID0gYWNjb3VudE9wdGlvbnMoJCgnI3Bhc3RlLWFjY291bnQnKS52YWx1ZSwgJ+qysOygnOyImOuLqCDrqqjrpoQnKTsKICAgICQoJyNtLW1lbW8nKS5wbGFjZWhvbGRlciA9IG1hbnVhbEtpbmQgPT09ICdpbmNvbWUnID8gJyjso7wp7ZqM7IKsIOq4ieyXrCcgOiBtYW51YWxLaW5kID09PSAndHJhbnNmZXInID8gJ+yggeq4iCDqs4TsoozroZwnIDogJ+yKpO2DgOuyheyKpCDqsJXrgqjsoJAnOwogICAgdXBkYXRlTWFudWFsSGludCgpOwogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIGZ1bmN0aW9uIHVwZGF0ZU1hbnVhbEhpbnQoKSB7CiAgICBjb25zdCBtZW1vID0gJCgnI20tbWVtbycpLnZhbHVlOwogICAgaWYgKG1hbnVhbEtpbmQgPT09ICd0cmFuc2ZlcicpIHsKICAgICAgJCgnI20taGludCcpLnRleHRDb250ZW50ID0gJ+uCtCDqs4Tsoozrgbzrpqwg7Jiu6ri0IOuPiOydgCDsp4DstpzCt+yImOyehSDtlanqs4Tsl5DshJwg67mg7KeR64uI64ukLiDsoIDstpUg66qp7KCB7J2066m0ICLsp4Dstpwi66GcIOuEo+qzoCDsoIDstpUg7ZWt66qp7J2EIOqzoOultOyEuOyalC4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAobWFudWFsS2luZCAhPT0gJ2V4cGVuc2UnIHx8ICQoJyNtLWNhdGVnb3J5JykudmFsdWUgIT09ICdfX2F1dG8nIHx8ICFtZW1vLnRyaW0oKSkgewogICAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSAnJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKHN0b3JlLmFpRW5hYmxlZCkgewogICAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSAn7LaU6rCA7ZWY66m0IEFJ6rCAIO2VreuqqeydhCDsoJXtlanri4jri6QuJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgcGxhbiA9IHBsYW5Gb3JEYXRlKCQoJyNtLWRhdGUnKS52YWx1ZSB8fCBMLnRvZGF5SVNPKCkpOwogICAgY29uc3QgciA9IEwuY2xhc3NpZnlMb2NhbChtZW1vLCBwbGFuLmNhdGVnb3JpZXMsIFMoKS5tZXJjaGFudE1hcCk7CiAgICAkKCcjbS1oaW50JykudGV4dENvbnRlbnQgPSBg7J6Q64+ZIOu2hOulmCDqsrDqs7w6ICR7Y2F0ZWdvcnlJbmZvKHIuY2F0ZWdvcnlJZCwgcGxhbi5jYXRlZ29yaWVzKS5uYW1lfWA7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvbk1hbnVhbFN1Ym1pdChlKSB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBkYXRlID0gJCgnI20tZGF0ZScpLnZhbHVlOwogICAgY29uc3QgYW1vdW50ID0gcGFyc2VBbW91bnRJbnB1dCgkKCcjbS1hbW91bnQnKS52YWx1ZSk7CiAgICBjb25zdCBtZW1vID0gJCgnI20tbWVtbycpLnZhbHVlLnRyaW0oKSB8fCAnKOuCtOyaqSDsl4bsnYwpJzsKICAgIGlmICghZGF0ZSkgcmV0dXJuIHRvYXN0KCfrgqDsp5zrpbwg7J6F66Cl7ZW0IOyjvOyEuOyalC4nKTsKICAgIGlmIChhbW91bnQgPT09IG51bGwgfHwgYW1vdW50ID09PSAwKSByZXR1cm4gdG9hc3QoJ+q4iOyVoeydhCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgY29uc3Qgc2VsID0gbWFudWFsS2luZCA9PT0gJ2V4cGVuc2UnID8gJCgnI20tY2F0ZWdvcnknKS52YWx1ZSA6ICcnOwogICAgY29uc3QgaXRlbSA9IHsKICAgICAgZGF0ZSwgYW1vdW50LCBtZW1vLCBraW5kOiBtYW51YWxLaW5kLCBhY2NvdW50SWQ6ICQoJyNtLWFjY291bnQnKS52YWx1ZSB8fCBudWxsLCBzb3VyY2U6ICdtYW51YWwnLAogICAgICBjYXRlZ29yeUlkOiBzZWwgPT09ICcnID8gbnVsbCA6IHNlbCwKICAgICAgbWV0aG9kOiBzZWwgJiYgc2VsICE9PSAnX19hdXRvJyA/ICdtYW51YWwnIDogdW5kZWZpbmVkLAogICAgfTsKICAgIGNvbnN0IFt0eF0gPSBhd2FpdCBidXN5KHNlbCA9PT0gJ19fYXV0bycgJiYgc3RvcmUuYWlFbmFibGVkID8gJ0FJ6rCAIOu2hOulmO2VmOuKlCDspJHigKYnIDogbnVsbCwgKCkgPT4gc3RvcmUuYWRkVHJhbnNhY3Rpb25zKFtpdGVtXSkpOwogICAgJCgnI20tYW1vdW50JykudmFsdWUgPSAnJzsKICAgICQoJyNtLW1lbW8nKS52YWx1ZSA9ICcnOwogICAgdXBkYXRlTWFudWFsSGludCgpOwogICAgY29uc3Qgd2hhdCA9IG1hbnVhbEtpbmQgPT09ICdleHBlbnNlJyA/IGAke2NhdGVnb3J5SW5mbyh0eC5jYXRlZ29yeUlkLCBwbGFuRm9yRGF0ZSh0eC5kYXRlKS5jYXRlZ29yaWVzKS5uYW1lfSDtla3rqqnsl5BgIDogbWFudWFsS2luZCA9PT0gJ2luY29tZScgPyAn7J6F6riI7Jy866GcJyA6ICfrgrQg6rOE7KKMIOydtOyytOuhnCc7CiAgICB0b2FzdChgJHt3aGF0fSAke3dvbihhbW91bnQpfSDstpTqsIDtlojsirXri4jri6QuYCk7CiAgICBqdW1wVG9EYXRlKGRhdGUpOwogIH0KCiAgZnVuY3Rpb24ganVtcFRvRGF0ZShkYXRlKSB7CiAgICBjb25zdCBwID0gTC5nZXRQZXJpb2QoZGF0ZSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgIGlmIChwLmtleSAhPT0gY3VycmVudFBlcmlvZC5rZXkpIGN1cnJlbnRQZXJpb2QgPSBwOwogICAgcmVuZGVyKCk7CiAgfQoKICAvLyDrtpnsl6zrhKPquLDsmYAg7YyM7J28IOqwgOyguOyYpOq4sOqwgCDqsJnsnYAg66+466as67O06riw66W8IOyTtOuLpC4gcHJldmlldy5zb3VyY2U6ICdwYXN0ZScgfCAnZmlsZScKICBjb25zdCBwcmV2aWV3ID0geyBzb3VyY2U6ICdwYXN0ZScsIGl0ZW1zOiBbXSwgc2tpcHBlZDogW10sIGxhdGVzdDogbnVsbCwgYWNjb3VudElkOiBudWxsLCBmaWxlTmFtZTogJycgfTsKCiAgZnVuY3Rpb24gY2xlYXJQcmV2aWV3KCkgewogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IGl0ZW1zOiBbXSwgc2tpcHBlZDogW10sIGxhdGVzdDogbnVsbCwgYWNjb3VudElkOiBudWxsLCBmaWxlTmFtZTogJycgfSk7CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgLy8g7KeA7Lac66eMIOu2hOulmO2VnOuLpC4g7ISc67KEKEFJKeuKlCDsl6zrn6wg67KI7JeQIOuCmOuIoCDrs7Trgrjri6QuCiAgYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlQcmV2aWV3KGl0ZW1zKSB7CiAgICBjb25zdCBleHBlbnNlcyA9IGl0ZW1zLmZpbHRlcigoaXQpID0+IGl0LmtpbmQgPT09ICdleHBlbnNlJyk7CiAgICBjb25zdCBzdGVwID0gc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgPyA2MCA6IGV4cGVuc2VzLmxlbmd0aCB8fCAxOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBleHBlbnNlcy5sZW5ndGg7IGkgKz0gc3RlcCkgewogICAgICBjb25zdCBjaHVuayA9IGV4cGVuc2VzLnNsaWNlKGksIGkgKyBzdGVwKTsKICAgICAgaWYgKHN0b3JlLmFpRW5hYmxlZCAmJiBleHBlbnNlcy5sZW5ndGggPiBzdGVwKSB0b2FzdChgQUnqsIAg67aE66WY7ZWY64qUIOykkeKApiAoJHtNYXRoLm1pbihpICsgc3RlcCwgZXhwZW5zZXMubGVuZ3RoKX0vJHtleHBlbnNlcy5sZW5ndGh9KWAsIDYwMDAwKTsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgc3RvcmUuY2xhc3NpZnkoY2h1bmsubWFwKCh7IGRhdGUsIGFtb3VudCwgbWVtbyB9KSA9PiAoeyBkYXRlLCBhbW91bnQsIG1lbW8gfSkpKTsKICAgICAgY2h1bmsuZm9yRWFjaCgoaXQsIGspID0+IE9iamVjdC5hc3NpZ24oaXQsIHJlc1trXSkpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gd2l0aER1cEZsYWdzKGl0ZW1zKSB7CiAgICByZXR1cm4gaXRlbXMubWFwKChpdCkgPT4gewogICAgICBjb25zdCBkdXAgPSAhIUwuZmluZER1cGxpY2F0ZShpdCwgUygpLnRyYW5zYWN0aW9ucyk7CiAgICAgIHJldHVybiB7IGNhdGVnb3J5SWQ6IG51bGwsIG1ldGhvZDogbnVsbCwgLi4uaXQsIGR1cCwgY2hlY2tlZDogIWR1cCB9OwogICAgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvblBhcnNlKCkgewogICAgY29uc3QgeyBpdGVtcywgc2tpcHBlZCB9ID0gTC5wYXJzZUV4cGVuc2VUZXh0KCQoJyNwYXN0ZS1pbnB1dCcpLnZhbHVlLCBMLnRvZGF5SVNPKCkpOwogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IHNvdXJjZTogJ3Bhc3RlJywgc2tpcHBlZCwgbGF0ZXN0OiBudWxsLCBhY2NvdW50SWQ6IG51bGwsIGZpbGVOYW1lOiAnJyB9KTsKICAgIGNvbnN0IHBhc3RlQWNjID0gJCgnI3Bhc3RlLWFjY291bnQnKS52YWx1ZSB8fCBudWxsOwogICAgcHJldmlldy5pdGVtcyA9IHdpdGhEdXBGbGFncyhpdGVtcy5tYXAoKGl0KSA9PiB7CiAgICAgIGNvbnN0IHggPSB7IC4uLml0LCBraW5kOiAnZXhwZW5zZScsIGFjY291bnRJZDogcGFzdGVBY2MgfTsKICAgICAgTC5hcHBseVBheVJ1bGVzKHgsIFMoKS5hY2NvdW50cyk7CiAgICAgIHJldHVybiB4OwogICAgfSkpOwogICAgaWYgKHByZXZpZXcuaXRlbXMubGVuZ3RoKSBhd2FpdCBidXN5KHN0b3JlLmFpRW5hYmxlZCA/IGBBSeqwgCAke3ByZXZpZXcuaXRlbXMubGVuZ3RofeqxtOydhCDrtoTrpZjtlZjripQg7KSR4oCmYCA6IG51bGwsICgpID0+IGNsYXNzaWZ5UHJldmlldyhwcmV2aWV3Lml0ZW1zKSk7CiAgICByZW5kZXJQYXJzZVJlc3VsdCgpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb25GaWxlQ2hvc2VuKGZpbGUpIHsKICAgIGNvbnN0IGFjY291bnRJZCA9ICQoJyNmaWxlLWFjY291bnQnKS52YWx1ZSB8fCBudWxsOwogICAgbGV0IHJvd3M7CiAgICB0cnkgewogICAgICByb3dzID0gYXdhaXQgd2luZG93LkJ1ZGdldFhsc3gucmVhZFRhYmxlRmlsZShmaWxlKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIHRvYXN0KGUubWVzc2FnZSB8fCAn7YyM7J287J2EIOydveyngCDrqrvtlojslrTsmpQuJywgNzAwMCk7CiAgICB9CiAgICBjb25zdCBmaWxlQWNjb3VudCA9IFMoKS5hY2NvdW50cy5maW5kKChhKSA9PiBhLmlkID09PSBhY2NvdW50SWQpOwogICAgY29uc3QgcGFyc2VkID0gTC5wYXJzZVN0YXRlbWVudFJvd3Mocm93cywgeyBteU5hbWU6IFMoKS5zZXR0aW5ncy5teU5hbWUsIGFjY291bnRJZCwgcGF5QWNjb3VudDogISFmaWxlQWNjb3VudCAmJiBmaWxlQWNjb3VudC50eXBlID09PSAncGF5JyB9KTsKICAgIHBhcnNlZC5pdGVtcy5mb3JFYWNoKChpdCkgPT4gTC5hcHBseVBheVJ1bGVzKGl0LCBTKCkuYWNjb3VudHMpKTsKICAgIGlmICghcGFyc2VkLmhlYWRlcikgcmV0dXJuIHRvYXN0KCfqsbDrnpjrgrTsl60g7ZGc66W8IOywvuyngCDrqrvtlojslrTsmpQuIOuCoOynnOyZgCDquIjslaEg7Lm47J20IOyeiOuKlCDsnYDtlokg6rGw656Y64K07JetIO2MjOydvOyduOyngCDtmZXsnbjtlbQg7KO87IS47JqULicsIDcwMDApOwogICAgT2JqZWN0LmFzc2lnbihwcmV2aWV3LCB7IHNvdXJjZTogJ2ZpbGUnLCBza2lwcGVkOiBbXSwgbGF0ZXN0OiBwYXJzZWQubGF0ZXN0LCBhY2NvdW50SWQsIGZpbGVOYW1lOiBmaWxlLm5hbWUgfSk7CiAgICBwcmV2aWV3Lml0ZW1zID0gd2l0aER1cEZsYWdzKHBhcnNlZC5pdGVtcyk7CiAgICBpZiAocGFyc2VkLnNraXBwZWQpIHByZXZpZXcuc2tpcHBlZCA9IFtg64Kg7Kec66W8IOydveyngCDrqrvtlZwg7KSEICR7cGFyc2VkLnNraXBwZWR96rCcYF07CiAgICBpZiAocHJldmlldy5pdGVtcy5sZW5ndGgpIHsKICAgICAgYXdhaXQgYnVzeShzdG9yZS5haUVuYWJsZWQgPyBgQUnqsIAgJHtwcmV2aWV3Lml0ZW1zLmZpbHRlcigoeCkgPT4geC5raW5kID09PSAnZXhwZW5zZScpLmxlbmd0aH3qsbTsnYQg67aE66WY7ZWY64qUIOykkeKApmAgOiBudWxsLCAoKSA9PiBjbGFzc2lmeVByZXZpZXcocHJldmlldy5pdGVtcykpOwogICAgfQogICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICB9CgogIGNvbnN0IEtJTkRfTEFCRUwgPSB7IGluY29tZTogJ+yeheq4iCcsIHRyYW5zZmVyOiAn64K0IOqzhOyijCDsnbTssrQnIH07CgogIGZ1bmN0aW9uIHJlbmRlclBhcnNlUmVzdWx0KCkgewogICAgY29uc3QgdGFyZ2V0ID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyA/ICQoJyNmaWxlLXJlc3VsdCcpIDogJCgnI3BhcnNlLXJlc3VsdCcpOwogICAgY29uc3Qgb3RoZXIgPSBwcmV2aWV3LnNvdXJjZSA9PT0gJ2ZpbGUnID8gJCgnI3BhcnNlLXJlc3VsdCcpIDogJCgnI2ZpbGUtcmVzdWx0Jyk7CiAgICBvdGhlci5pbm5lckhUTUwgPSAnJzsKICAgIGlmICghcHJldmlldy5pdGVtcy5sZW5ndGggJiYgIXByZXZpZXcuc2tpcHBlZC5sZW5ndGgpIHsKICAgICAgdGFyZ2V0LmlubmVySFRNTCA9ICcnOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBpdGVtcyA9IHByZXZpZXcuaXRlbXM7CiAgICBjb25zdCByb3dzID0gaXRlbXMubWFwKChpdCwgaSkgPT4gYAogICAgICA8dHI+CiAgICAgICAgPHRkPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgZGF0YS1pPSIke2l9IiBjbGFzcz0icC1jaGVjayIgJHtpdC5jaGVja2VkID8gJ2NoZWNrZWQnIDogJyd9IGFyaWEtbGFiZWw9Iuy2lOqwgCI+PC90ZD4KICAgICAgICA8dGQ+PGlucHV0IHR5cGU9ImRhdGUiIGRhdGEtaT0iJHtpfSIgY2xhc3M9InAtZGF0ZSIgdmFsdWU9IiR7aXQuZGF0ZX0iPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJtZW1vIj4ke2VzYyhpdC5tZW1vKX0gJHtpdC5kdXAgPyAnPHNwYW4gY2xhc3M9InRhZyB3YXJuIj7spJHrs7U/PC9zcGFuPicgOiAnJ30gJHtpdC5raW5kID09PSAnZXhwZW5zZScgPyBtZXRob2RUYWcoaXQubWV0aG9kKSA6ICcnfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJhbW91bnQgJHtpdC5raW5kID09PSAnaW5jb21lJyB8fCBpdC5hbW91bnQgPCAwID8gJ3JlZnVuZCcgOiAnJ30iPiR7aXQua2luZCA9PT0gJ2luY29tZScgPyAnKycgOiAnJ30ke3dvbihpdC5hbW91bnQpfTwvdGQ+CiAgICAgICAgPHRkPiR7aXQua2luZCA9PT0gJ2V4cGVuc2UnCiAgICAgICAgICA/IGA8c2VsZWN0IGRhdGEtaT0iJHtpfSIgY2xhc3M9InAtY2F0Ij4ke2NhdGVnb3J5T3B0aW9ucyhwbGFuRm9yRGF0ZShpdC5kYXRlKS5jYXRlZ29yaWVzLCBpdC5jYXRlZ29yeUlkKX08L3NlbGVjdD5gCiAgICAgICAgICA6IGA8c3BhbiBjbGFzcz0idGFnIj4ke0tJTkRfTEFCRUxbaXQua2luZF19PC9zcGFuPmB9PC90ZD4KICAgICAgPC90cj5gKS5qb2luKCcnKTsKICAgIGNvbnN0IGR1cHMgPSBpdGVtcy5maWx0ZXIoKHgpID0+IHguZHVwKS5sZW5ndGg7CiAgICBjb25zdCBkYXRlcyA9IGl0ZW1zLm1hcCgoeCkgPT4geC5kYXRlKS5zb3J0KCk7CiAgICBjb25zdCBzdW1tYXJ5ID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyAmJiBpdGVtcy5sZW5ndGgKICAgICAgPyBgPHAgY2xhc3M9InNtYWxsIj4ke2VzYyhwcmV2aWV3LmZpbGVOYW1lKX0gwrcgJHtmbXREYXRlKGRhdGVzWzBdKX0gfiAke2ZtdERhdGUoZGF0ZXNbZGF0ZXMubGVuZ3RoIC0gMV0pfSDCtyAke2l0ZW1zLmxlbmd0aH3qsbQke2R1cHMgPyBgICjsnbTrr7gg7J6I64qUIOuCtOyXreycvOuhnCDrs7TsnbTripQgJHtkdXBzfeqxtOydgCDrubwg65GQ7JeI7Ja07JqUKWAgOiAnJ30ke3ByZXZpZXcubGF0ZXN0ID8gYCDCtyDrp4jsp4Drp4kg7J6U7JWhICR7d29uKHByZXZpZXcubGF0ZXN0LmJhbGFuY2UpfWAgOiAnJ308L3A+YAogICAgICA6ICcnOwogICAgdGFyZ2V0LmlubmVySFRNTCA9IGAKICAgICAgJHtzdW1tYXJ5fQogICAgICAke2l0ZW1zLmxlbmd0aCA/IGAKICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJwLWFsbCI+66qo65GQIOyEoO2DnTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9Imdob3N0LWJ0biBzbWFsbC1idG4iIGlkPSJwLW5vbmUiPuuqqOuRkCDtlbTsoJw8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAiPgogICAgICAgIDx0YWJsZSBjbGFzcz0ic3RhY2stdGFibGUgcGFyc2UtdGFibGUiPgogICAgICAgICAgPHRoZWFkPjx0cj48dGg+PC90aD48dGg+64Kg7KecPC90aD48dGg+7IKs7Jqp7LKYPC90aD48dGggY2xhc3M9ImFtb3VudCI+6riI7JWhPC90aD48dGg+7ZWt66qpPC90aD48L3RyPjwvdGhlYWQ+CiAgICAgICAgICA8dGJvZHk+JHtyb3dzfTwvdGJvZHk+CiAgICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdy1hY3Rpb25zIj48YnV0dG9uIGlkPSJwLWFkZCIgY2xhc3M9InByaW1hcnktYnRuIj7shKDtg53tlZwgJHtpdGVtcy5maWx0ZXIoKHgpID0+IHguY2hlY2tlZCkubGVuZ3RofeqxtCDstpTqsIA8L2J1dHRvbj48L2Rpdj5gIDogJyd9CiAgICAgICR7cHJldmlldy5za2lwcGVkLmxlbmd0aCA/IGA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuqxtOuEiOubtCDspIQgJHtwcmV2aWV3LnNraXBwZWQubGVuZ3RofeqwnDogJHtwcmV2aWV3LnNraXBwZWQubWFwKGVzYykuam9pbignIC8gJyl9PC9wPmAgOiAnJ31gOwoKICAgIGNvbnN0IHNldEFsbCA9ICh2KSA9PiB7CiAgICAgIGl0ZW1zLmZvckVhY2goKHgpID0+ICh4LmNoZWNrZWQgPSB2KSk7CiAgICAgIHJlbmRlclBhcnNlUmVzdWx0KCk7CiAgICB9OwogICAgaWYgKCQoJyNwLWFsbCcpKSAkKCcjcC1hbGwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNldEFsbCh0cnVlKSk7CiAgICBpZiAoJCgnI3Atbm9uZScpKSAkKCcjcC1ub25lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzZXRBbGwoZmFsc2UpKTsKICAgIHRhcmdldC5xdWVyeVNlbGVjdG9yQWxsKCcucC1jaGVjaycpLmZvckVhY2goKGMpID0+IGMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogICAgICBpdGVtc1tjLmRhdGFzZXQuaV0uY2hlY2tlZCA9IGMuY2hlY2tlZDsKICAgICAgcmVuZGVyUGFyc2VSZXN1bHQoKTsKICAgIH0pKTsKICAgIHRhcmdldC5xdWVyeVNlbGVjdG9yQWxsKCcucC1kYXRlJykuZm9yRWFjaCgoYykgPT4gYy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiAoaXRlbXNbYy5kYXRhc2V0LmldLmRhdGUgPSBjLnZhbHVlKSkpOwogICAgdGFyZ2V0LnF1ZXJ5U2VsZWN0b3JBbGwoJy5wLWNhdCcpLmZvckVhY2goKGMpID0+IGMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogICAgICBjb25zdCBpdCA9IGl0ZW1zW2MuZGF0YXNldC5pXTsKICAgICAgaXQuY2F0ZWdvcnlJZCA9IGMudmFsdWUgfHwgbnVsbDsKICAgICAgaXQubWV0aG9kID0gYy52YWx1ZSA/ICdtYW51YWwnIDogbnVsbDsKICAgIH0pKTsKICAgIGNvbnN0IGFkZEJ0biA9ICQoJyNwLWFkZCcpOwogICAgaWYgKGFkZEJ0bikgYWRkQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoYWRkUHJldmlld0l0ZW1zKSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhZGRQcmV2aWV3SXRlbXMoKSB7CiAgICBjb25zdCBjaG9zZW4gPSBwcmV2aWV3Lml0ZW1zLmZpbHRlcigoeCkgPT4geC5jaGVja2VkICYmIHguZGF0ZSk7CiAgICBpZiAoIWNob3Nlbi5sZW5ndGgpIHJldHVybiB0b2FzdCgn7LaU6rCA7ZWgIOuCtOyXreydhCDshKDtg53tlbQg7KO87IS47JqULicpOwogICAgbGV0IGNoYW5nZWRNZXRhID0gZmFsc2U7CiAgICAvLyDtjIzsnbzsnZgg66eI7KeA66eJIOyelOyVoeydtCDsp4DquIgg7JWM6rOgIOyeiOuKlCDsnpTslaHrs7Tri6Qg7LWc6re87J2066m0IOqzhOyijCDsnpTslaHsnYQg67CU6r6864ukCiAgICBjb25zdCBhY2MgPSBwcmV2aWV3LmFjY291bnRJZCAmJiBTKCkuYWNjb3VudHMuZmluZCgoYSkgPT4gYS5pZCA9PT0gcHJldmlldy5hY2NvdW50SWQpOwogICAgaWYgKGFjYyAmJiBwcmV2aWV3LmxhdGVzdCkgewogICAgICBjb25zdCBhdCA9IG5ldyBEYXRlKGAke3ByZXZpZXcubGF0ZXN0LmRhdGV9VCR7cHJldmlldy5sYXRlc3QudGltZSB8fCAnMjM6NTk6NTknfSswOTowMGApLnRvSVNPU3RyaW5nKCk7CiAgICAgIGlmICghYWNjLmJhbGFuY2VBdCB8fCBhdCA+IGFjYy5iYWxhbmNlQXQpIHsKICAgICAgICBhY2MuYmFsYW5jZSA9IHByZXZpZXcubGF0ZXN0LmJhbGFuY2U7CiAgICAgICAgYWNjLmJhbGFuY2VBdCA9IGF0OwogICAgICAgIGNoYW5nZWRNZXRhID0gdHJ1ZTsKICAgICAgfQogICAgfQogICAgaWYgKGNoYW5nZWRNZXRhKSBzdG9yZS5zYXZlTWV0YSgpOwogICAgY29uc3Qgc291cmNlID0gcHJldmlldy5zb3VyY2UgPT09ICdmaWxlJyA/ICdmaWxlJyA6ICdwYXN0ZSc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNob3Nlbi5sZW5ndGg7IGkgKz0gMjAwKSB7CiAgICAgIGNvbnN0IHBhcnQgPSBjaG9zZW4uc2xpY2UoaSwgaSArIDIwMCk7CiAgICAgIGF3YWl0IGJ1c3koYOyggOyepe2VmOuKlCDspJHigKYgKCR7TWF0aC5taW4oaSArIDIwMCwgY2hvc2VuLmxlbmd0aCl9LyR7Y2hvc2VuLmxlbmd0aH0pYCwgKCkgPT4KICAgICAgICBzdG9yZS5hZGRUcmFuc2FjdGlvbnMocGFydC5tYXAoKGl0KSA9PiAoewogICAgICAgICAgZGF0ZTogaXQuZGF0ZSwgYW1vdW50OiBpdC5hbW91bnQsIG1lbW86IGl0Lm1lbW8sIGtpbmQ6IGl0LmtpbmQgfHwgJ2V4cGVuc2UnLCBhY2NvdW50SWQ6IGl0LmFjY291bnRJZCB8fCBudWxsLAogICAgICAgICAgY2F0ZWdvcnlJZDogaXQua2luZCA9PT0gJ2V4cGVuc2UnID8gaXQuY2F0ZWdvcnlJZCA6IG51bGwsIG1ldGhvZDogaXQubWV0aG9kLCBzb3VyY2UsIHJhdzogaXQucmF3LAogICAgICAgIH0pKSkKICAgICAgKTsKICAgIH0KICAgIGNvbnN0IGxhdGVzdERhdGUgPSBjaG9zZW4ubWFwKCh4KSA9PiB4LmRhdGUpLnNvcnQoKS5wb3AoKTsKICAgIGlmIChwcmV2aWV3LnNvdXJjZSA9PT0gJ3Bhc3RlJykgJCgnI3Bhc3RlLWlucHV0JykudmFsdWUgPSAnJzsKICAgIGVsc2UgJCgnI2ZpbGUtaW5wdXQnKS52YWx1ZSA9ICcnOwogICAgY2xlYXJQcmV2aWV3KCk7CiAgICB0b2FzdChgJHtjaG9zZW4ubGVuZ3RofeqxtOydhCDstpTqsIDtlojsirXri4jri6QuYCk7CiAgICBqdW1wVG9EYXRlKGxhdGVzdERhdGUpOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDshKTsoJUgLS0tLS0tLS0tLQoKICAvLyDslYzrprwg7Jew6rKwIOyVsSjslYjrk5zroZzsnbTrk5wpIOuCtOugpOuwm+q4sCDso7zshowgKEdpdEh1YiBBY3Rpb25zIOqwgCBtYWluIOyXkCDsmKzrnbzqsIgg65WM66eI64ukIOqwseyLoCkKICBjb25zdCBOT1RJX0FQS19VUkwgPSAnaHR0cHM6Ly9naXRodWIuY29tL2tkaDEyMDctc3Rhci9DbGF1ZGVDb2RlMS9yZWxlYXNlcy9kb3dubG9hZC9ub3RpLWFwcC9idWRnZXQtbm90aS5hcGsnOwoKICAvLyDshKTsuZjrkJwg7JWM66a8IOyXsOqysCDslbHsnYQg7Je066m07IScIOyEnOuyhCDso7zshozrpbwg64SY6ri064ukICjtgazroawg7JWI65Oc66Gc7J2065Oc7J2YIGludGVudCDrp4HtgawpCiAgZnVuY3Rpb24gY29ubmVjdExpbmsoKSB7CiAgICBjb25zdCB1cmwgPSBlbmNvZGVVUklDb21wb25lbnQobm90aWZ5VXJsKCdiYW5rJykpOwogICAgcmV0dXJuIGBpbnRlbnQ6Ly9zZXR1cD91cmw9JHt1cmx9I0ludGVudDtzY2hlbWU9YnVkZ2V0bm90aTtwYWNrYWdlPWNvbS5rZGgxMjA3LmJ1ZGdldG5vdGk7Uy5icm93c2VyX2ZhbGxiYWNrX3VybD0ke2VuY29kZVVSSUNvbXBvbmVudChOT1RJX0FQS19VUkwpfTtlbmRgOwogIH0KCiAgZnVuY3Rpb24gbm90aWZ5VXJsKHNvdXJjZSkgewogICAgcmV0dXJuIHN0b3JlLnNlcnZpY2VVcmwgPyBgJHtzdG9yZS5zZXJ2aWNlVXJsfT9hY3Rpb249c21zJmtleT0ke2VuY29kZVVSSUNvbXBvbmVudChzdG9yZS5zZXJ2ZXIua2V5KX0ke3NvdXJjZSA/IGAmc291cmNlPSR7c291cmNlfWAgOiAnJ31gIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJTZXR0aW5ncygpIHsKICAgIGNvbnN0IHNkID0gJCgnI3N0YXJ0LWRheScpOwogICAgaWYgKCFzZC5vcHRpb25zLmxlbmd0aCkgc2QuaW5uZXJIVE1MID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogMzEgfSwgKF8sIGkpID0+IGA8b3B0aW9uIHZhbHVlPSIke2kgKyAxfSI+66ek7JuUICR7aSArIDF97J28PC9vcHRpb24+YCkuam9pbignJyk7CiAgICBzZC52YWx1ZSA9IFN0cmluZyhTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgJCgnI215LW5hbWUnKS52YWx1ZSA9IFMoKS5zZXR0aW5ncy5teU5hbWUgfHwgJyc7CiAgICByZW5kZXJBY2NvdW50Um93cygpOwogICAgcmVuZGVyUnVsZXMoKTsKICAgIHJlbmRlckF1dG9DYXJkKCk7CiAgICAkKCcjZGF0YS1ub3RlJykudGV4dENvbnRlbnQgPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJwogICAgICA/ICfrjbDsnbTthLDripQg6rWs6riAIOyLnO2KuOyXkCDsoIDsnqXrkKnri4jri6QuIOuwseyXhSDrtojrn6zsmKTquLDrpbwg7ZWY66m0IOuwseyXheydmCDqs4Ttmo3Ct+qzhOyijOulvCDsoIHsmqntlZjqs6Ag64K07Jet7J2EIOyLnO2KuOyXkCDstpTqsIDtlanri4jri6QuJwogICAgICA6ICfrqqjrk6Ag642w7J207YSw64qUIOydtCDruIzrnbzsmrDsoIDsl5Drp4wg7KCA7J6l65Cp64uI64ukLiDri6Trpbgg6riw6riw66GcIOyYruq4sOqxsOuCmCDrsLHsl4XtlZjroKTrqbQg64K067O064K06riw66W8IOyCrOyaqe2VmOyEuOyalC4nOwogICAgJCgnI3Jlc2V0LWJ0bicpLmhpZGRlbiA9IHN0b3JlLm1vZGUgPT09ICdyZW1vdGUnOwogIH0KCiAgLy8g7J6Q64+ZIOu2hOulmCDqt5zsuZk6IOydtCDqsIDrp7nsoJDCt+yDgeuMgOuKlCDtla3sg4Eg7J20IO2VreuqqSAoQUnrs7Tri6Qg66i87KCAIOyggeyaqSkuIOyngeygkSDrp4zrk6Tqs6Ag7KeA7Jq064ukLgogIGZ1bmN0aW9uIHJlbmRlclJ1bGVzKCkgewogICAgY29uc3QgY2F0cyA9IGN1cnJlbnRQbGFuKCkuY2F0ZWdvcmllczsKICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhTKCkubWVyY2hhbnRNYXApLnNvcnQoKGEsIGIpID0+IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdLCAna28nKSk7CiAgICAkKCcjcnVsZS1jYXQnKS5pbm5lckhUTUwgPSBjYXRzLm1hcCgoYykgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGMuaWQpfSI+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKTsKICAgIGNvbnN0IGVsID0gJCgnI3J1bGUtcm93cycpOwogICAgZWwuaW5uZXJIVE1MID0gZW50cmllcy5sZW5ndGgKICAgICAgPyBlbnRyaWVzLm1hcCgoW25hbWUsIGlkXSkgPT4gewogICAgICAgIGNvbnN0IGMgPSBjYXRzLmZpbmQoKHgpID0+IHguaWQgPT09IGlkKTsKICAgICAgICByZXR1cm4gYDxkaXYgY2xhc3M9InJ1bGUtcm93Ij48c3BhbiBjbGFzcz0icnVsZS1uYW1lIj4ke2VzYyhuYW1lKX08L3NwYW4+PHNwYW4gY2xhc3M9InJ1bGUtYXJyb3ciPuKGkjwvc3Bhbj48c3Bhbj4ke2MgPyBlc2MoYy5uYW1lKSA6ICc8c3BhbiBjbGFzcz0ibXV0ZWQiPuyngOq4iCDqs4Ttmo3sl5Ag7JeG64qUIO2VreuqqTwvc3Bhbj4nfTwvc3Bhbj48YnV0dG9uIGNsYXNzPSJsaW5rLWJ0biBydWxlLWRlbCIgZGF0YS1uYW1lPSIke2VzYyhuYW1lKX0iIGFyaWEtbGFiZWw9IiR7ZXNjKG5hbWUpfSDqt5zsuZkg7IKt7KCcIj7inJU8L2J1dHRvbj48L2Rpdj5gOwogICAgICB9KS5qb2luKCcnKQogICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSBzbWFsbCI+7JWE7KeBIOq3nOy5meydtCDsl4bslrTsmpQuIOuqqOuToCDsp4DstpzsnYAgQUko65iQ64qUIO2CpOybjOuTnCnqsIAg67aE66WY7ZWp64uI64ukLjwvZGl2Pic7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCcucnVsZS1kZWwnKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBkZWxldGUgUygpLm1lcmNoYW50TWFwW2IuZGF0YXNldC5uYW1lXTsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgdG9hc3QoJ+q3nOy5meydhCDsp4Dsm6DslrTsmpQuIOydtOuvuCDrtoTrpZjrkJwg64K07Jet7J2AIOq3uOuMgOuhnOyYiOyalC4nKTsKICAgICAgcmVuZGVyUnVsZXMoKTsKICAgIH0pKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckFjY291bnRSb3dzKCkgewogICAgY29uc3QgZWwgPSAkKCcjYWNjb3VudC1yb3dzJyk7CiAgICBjb25zdCBhY2NvdW50cyA9IFMoKS5hY2NvdW50czsKICAgIGVsLmlubmVySFRNTCA9IGFjY291bnRzLmxlbmd0aAogICAgICA/IGFjY291bnRzLm1hcCgoYSkgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9ImFjY3Qtcm93IiBkYXRhLWlkPSIke2VzYyhhLmlkKX0iPgogICAgICAgICAgPGlucHV0IGNsYXNzPSJhLW5hbWUiIHR5cGU9InRleHQiIHZhbHVlPSIke2VzYyhhLm5hbWUpfSIgcGxhY2Vob2xkZXI9IiR7YS50eXBlID09PSAnY2FyZCcgPyAn7JiIOiDsi6DtlZwg7LK07YGs7Lm065OcJyA6ICfsmIg6IOq1reuvvCDso7zqsbDrnpgnfSIgYXJpYS1sYWJlbD0i7J2066aEIj4KICAgICAgICAgIDxzZWxlY3QgY2xhc3M9ImEtdHlwZSIgYXJpYS1sYWJlbD0i7KKF66WYIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYmFuayIgJHthLnR5cGUgIT09ICdjYXJkJyA/ICdzZWxlY3RlZCcgOiAnJ30+7J2A7ZaJIOqzhOyijDwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJjYXJkIiAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ3NlbGVjdGVkJyA6ICcnfT7subTrk5w8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGF5IiAke2EudHlwZSA9PT0gJ3BheScgPyAnc2VsZWN0ZWQnIDogJyd9PuqwhO2OuOqysOygnCDrqLjri4g8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgJHthLnR5cGUgPT09ICdwYXknCiAgICAgICAgICAgID8gYDxpbnB1dCBjbGFzcz0iYS1wYXluYW1lIiB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJHtlc2MoYS5wYXlOYW1lKX0iIHBsYWNlaG9sZGVyPSLsnYDtlokg64K07Jet7JeQIOywje2eiOuKlCDsnbTrpoQgKOyYiDog7Lm07Lm07Jik7Y6Y7J20KSIgYXJpYS1sYWJlbD0i7J2A7ZaJIOuCtOyXreyXkCDssI3tnojripQg7J2066aEIj5gCiAgICAgICAgICAgIDogYDxpbnB1dCBjbGFzcz0iYS1sYXN0IiB0eXBlPSJ0ZXh0IiBpbnB1dG1vZGU9Im51bWVyaWMiIG1heGxlbmd0aD0iNCIgdmFsdWU9IiR7ZXNjKGEubGFzdDQpfSIgcGxhY2Vob2xkZXI9IuuBnSA07J6Q66asIiBhcmlhLWxhYmVsPSLrgZ0gNOyekOumrCI+YH0KICAgICAgICAgIDxpbnB1dCBjbGFzcz0iYS1iYWwiIHR5cGU9InRleHQiIGlucHV0bW9kZT0ibnVtZXJpYyIgdmFsdWU9IiR7dHlwZW9mIGEuYmFsYW5jZSA9PT0gJ251bWJlcicgPyBhLmJhbGFuY2UudG9Mb2NhbGVTdHJpbmcoJ2tvLUtSJykgOiAnJ30iIHBsYWNlaG9sZGVyPSIke2EudHlwZSA9PT0gJ2NhcmQnID8gJ+KAlCcgOiAn7ZiE7J6sIOyelOyVoSd9IiAke2EudHlwZSA9PT0gJ2NhcmQnID8gJ2Rpc2FibGVkJyA6ICcnfSBhcmlhLWxhYmVsPSLsnpTslaEiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJjaGVjayI+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYS1zYXZlIiAke2EuaXNTYXZpbmdzID8gJ2NoZWNrZWQnIDogJyd9ICR7YS50eXBlICE9PSAnYmFuaycgPyAnZGlzYWJsZWQnIDogJyd9PuyggOy2lTwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJsaW5rLWJ0biBhLWRlbCIgYXJpYS1sYWJlbD0i7IKt7KCcIj7inJU8L2J1dHRvbj4KICAgICAgICAgICR7YS50eXBlID09PSAncGF5JyA/IGA8ZGl2IGNsYXNzPSJhY2N0LW5vdGUgc21hbGwgbXV0ZWQiPuydgO2WiSDrgrTsl63sl5AgJyR7ZXNjKGEucGF5TmFtZSB8fCAn7J2066aEJyl9JyjsnLwp66GcIOywje2ejCDstpzquIjsnYAg7Lap7KCE7Jy866GcIOuztOqzoCDsp4Dstpzsl5DshJwg67qN64uI64ukLiDqsrDsoJzrgrTsl63snYAg67aZ7Jes64Sj6riwwrftjIzsnbwg6rCA7KC47Jik6riw7JeQ7IScIOqysOygnOyImOuLqOydhCDsnbQg7ZWt66qp7Jy866GcIOqzqOudvCDrhKPsnLzshLjsmpQuIDxidXR0b24gY2xhc3M9ImxpbmsgYS1hcHBseSI+7J2066+4IOq4sOuhneuQnCDrgrTsl63sl5Drj4Qg7KCB7JqpPC9idXR0b24+PC9kaXY+YCA6ICcnfQogICAgICAgIDwvZGl2PmApLmpvaW4oJycpCiAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij7slYTsp4Eg65Ox66Gd7ZWcIOqzhOyijMK37Lm065Oc6rCAIOyXhuyWtOyalC48L2Rpdj4nOwoKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5hY2N0LXJvdycpLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBhID0gUygpLmFjY291bnRzLmZpbmQoKHgpID0+IHguaWQgPT09IHJvdy5kYXRhc2V0LmlkKTsKICAgICAgY29uc3Qgc2F2ZSA9IChyZXJlbmRlcikgPT4gewogICAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICAgICAgaWYgKHJlcmVuZGVyKSByZW5kZXJBY2NvdW50Um93cygpOwogICAgICB9OwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtbmFtZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5uYW1lID0gZS50YXJnZXQudmFsdWUudHJpbSgpOwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS10eXBlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgICBhLnR5cGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBpZiAoYS50eXBlID09PSAnY2FyZCcpIE9iamVjdC5hc3NpZ24oYSwgeyBiYWxhbmNlOiBudWxsLCBpc1NhdmluZ3M6IGZhbHNlIH0pOwogICAgICAgIGlmIChhLnR5cGUgPT09ICdwYXknKSBPYmplY3QuYXNzaWduKGEsIHsgaXNTYXZpbmdzOiBmYWxzZSwgcGF5TmFtZTogYS5wYXlOYW1lIHx8ICgv7Y6Y7J20fHBheS9pLnRlc3QoYS5uYW1lKSA/IGEubmFtZSA6ICfsubTsubTsmKTtjpjsnbQnKSB9KTsKICAgICAgICBzYXZlKHRydWUpOwogICAgICB9KTsKICAgICAgY29uc3QgbGFzdCA9IHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1sYXN0Jyk7CiAgICAgIGlmIChsYXN0KSBsYXN0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgICAgYS5sYXN0NCA9IGUudGFyZ2V0LnZhbHVlLnJlcGxhY2UoL1xEL2csICcnKS5zbGljZSgtNCk7CiAgICAgICAgZS50YXJnZXQudmFsdWUgPSBhLmxhc3Q0OwogICAgICAgIHNhdmUoKTsKICAgICAgfSk7CiAgICAgIGNvbnN0IHBheU5hbWUgPSByb3cucXVlcnlTZWxlY3RvcignLmEtcGF5bmFtZScpOwogICAgICBpZiAocGF5TmFtZSkgcGF5TmFtZS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEucGF5TmFtZSA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKTsKICAgICAgICBzYXZlKHRydWUpOwogICAgICB9KTsKICAgICAgY29uc3QgYXBwbHkgPSByb3cucXVlcnlTZWxlY3RvcignLmEtYXBwbHknKTsKICAgICAgaWYgKGFwcGx5KSBhcHBseS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgICBjb25zdCB0YXJnZXRzID0gUygpLnRyYW5zYWN0aW9ucy5maWx0ZXIoKHQpID0+IEwuYXBwbHlQYXlSdWxlcyh7IC4uLnQgfSwgW2FdKSk7CiAgICAgICAgaWYgKCF0YXJnZXRzLmxlbmd0aCkgcmV0dXJuIHRvYXN0KGAnJHthLnBheU5hbWV9JyjsnLwp66GcIOywje2ejCDsp4DstpzCt+yeheq4iOydtCDsl4bslrTsmpQuYCk7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHthLnBheU5hbWV9JyjsnLwp66GcIOywje2ejCDrgrTsl60gJHt0YXJnZXRzLmxlbmd0aH3qsbTsnYQg7Lap7KCEKOuCtCDqs4Tsoowg7J207LK0KeycvOuhnCDrsJTqv4DquYzsmpQ/IOyngOy2nOyXkOyEnCDruaDsp5Hri4jri6QuYCkpIHJldHVybjsKICAgICAgICBhd2FpdCBidXN5KGDsoJXrpqztlZjripQg7KSR4oCmICgke3RhcmdldHMubGVuZ3RofeqxtClgLCBhc3luYyAoKSA9PiB7CiAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgdGFyZ2V0cykgYXdhaXQgc3RvcmUudXBkYXRlVHJhbnNhY3Rpb24odC5pZCwgeyBraW5kOiAndHJhbnNmZXInLCBjYXRlZ29yeUlkOiBudWxsLCBtZXRob2Q6IG51bGwgfSk7CiAgICAgICAgfSk7CiAgICAgICAgdG9hc3QoYCR7dGFyZ2V0cy5sZW5ndGh96rG07J2EIOy2qeyghOycvOuhnCDrsJTqv6jslrTsmpQuYCk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0pKTsKICAgICAgZm9ybWF0T25CbHVyKHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1iYWwnKSk7CiAgICAgIHJvdy5xdWVyeVNlbGVjdG9yKCcuYS1iYWwnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEuYmFsYW5jZSA9IHBhcnNlQW1vdW50SW5wdXQoZS50YXJnZXQudmFsdWUpOwogICAgICAgIGEuYmFsYW5jZUF0ID0gbm93SVNPKCk7CiAgICAgICAgc2F2ZSgpOwogICAgICB9KTsKICAgICAgcm93LnF1ZXJ5U2VsZWN0b3IoJy5hLXNhdmUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICAgIGEuaXNTYXZpbmdzID0gZS50YXJnZXQuY2hlY2tlZDsKICAgICAgICBzYXZlKCk7CiAgICAgIH0pOwogICAgICByb3cucXVlcnlTZWxlY3RvcignLmEtZGVsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgaWYgKCFjb25maXJtKGAnJHthLm5hbWUgfHwgYS5sYXN0NH0nIOydhCjrpbwpIOyCreygnO2VoOq5jOyalD8g7J2066+4IOq4sOuhneuQnCDrgrTsl63snYAg6re464yA66GcIOuCqOyKteuLiOuLpC5gKSkgcmV0dXJuOwogICAgICAgIFMoKS5hY2NvdW50cyA9IFMoKS5hY2NvdW50cy5maWx0ZXIoKHgpID0+IHguaWQgIT09IGEuaWQpOwogICAgICAgIHNhdmUodHJ1ZSk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBhZGRBY2NvdW50KCkgewogICAgUygpLmFjY291bnRzLnB1c2goeyBpZDogYGEtJHt1aWQoKX1gLCBuYW1lOiAnJywgdHlwZTogJ2JhbmsnLCBsYXN0NDogJycsIGlzU2F2aW5nczogZmFsc2UsIGJhbGFuY2U6IG51bGwsIGJhbGFuY2VBdDogJycgfSk7CiAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgcmVuZGVyQWNjb3VudFJvd3MoKTsKICAgIGNvbnN0IG5hbWVzID0gJCQoJy5hY2N0LXJvdyAuYS1uYW1lJyk7CiAgICBuYW1lc1tuYW1lcy5sZW5ndGggLSAxXS5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQXV0b0NhcmQoKSB7CiAgICBjb25zdCBjYXJkID0gJCgnI3NldC1hdXRvJyk7CiAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScpIHsKICAgICAgY29uc3QgTU9ERUxfTEFCRUwgPSB7ICdjbGF1ZGUtb3B1cy01LTUnOiAnQ2xhdWRlIE9wdXMgNS41ICjquLDrs7gsIOqwgOyepSDsoJXtmZUpJywgJ2NsYXVkZS1oYWlrdS01LTUnOiAnQ2xhdWRlIEhhaWt1IDUuNSAo7LaU7LKcLCDslYTso7wg7KCA66C0KScsICdjbGF1ZGUtaGFpa3UtNC01JzogJ0NsYXVkZSBIYWlrdSA0LjUgKOyYiOyghCDrqqjrjbgpJyB9OwogICAgICBjYXJkLmlubmVySFRNTCA9IGAKICAgICAgICA8aDI+7J6Q64+ZIOyeheugpTwvaDI+CiAgICAgICAgPGgzPkNsYXVkZSBBSSDrtoTrpZg8L2gzPgogICAgICAgIDxwIGNsYXNzPSJzbWFsbCI+JHtzdG9yZS5haUVuYWJsZWQgPyAnPGI+7Lyc7KC4IOyeiOyWtOyalC48L2I+IOyVjOumvOqzvCDrtpnsl6zrhKPsnYAg64K07Jet7J2EIEFJ6rCAIOyYiOyCsCDtla3rqqnsl5Ag66ee7LawIOu2hOulmO2VqeuLiOuLpC4nIDogJzxiPuq6vOyguCDsnojslrTsmpQuPC9iPiDsp4DquIjsnYAg7YKk7JuM65Oc66GcIOu2hOulmO2VqeuLiOuLpC4g7JWE656Y7JeQIENsYXVkZSBBUEkg7YKk66W8IOuEo+ycvOuptCDsvJzsoLjsmpQuIO2CpOuKlCBjb25zb2xlLmFudGhyb3BpYy5jb20g7JeQ7IScIOqysOygnCDsiJjri6jsnYQg65Ox66Gd7ZWcIOuSpCBBUEkgS2V5cyDrqZTribTsl5DshJwg66eM65OkIOyImCDsnojslrTsmpQuJ308L3A+CiAgICAgICAgPGZvcm0gaWQ9ImFpLWZvcm0iIGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ3aWRlIj5DbGF1ZGUgQVBJIO2CpDxpbnB1dCB0eXBlPSJwYXNzd29yZCIgaWQ9ImFpLWtleSIgYXV0b2NvbXBsZXRlPSJvZmYiIHBsYWNlaG9sZGVyPSIke3N0b3JlLmFpRW5hYmxlZCA/ICfsoIDsnqXrkKggKOuwlOq+uOugpOuptCDsg4gg7YKkIOyeheugpSknIDogJ3NrLWFudC3igKYnfSI+PC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tc3VibWl0Ij48YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9InByaW1hcnktYnRuIj7tmZXsnbjtlZjqs6Ag7KCA7J6lPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9mb3JtPgogICAgICAgICR7c3RvcmUuYWlFbmFibGVkID8gYDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsIGNsYXNzPSJ3aWRlIj7sgqzsmqntlaAg66qo6424PHNlbGVjdCBpZD0iYWktbW9kZWwiPiR7KHN0b3JlLmFpTW9kZWxzLmxlbmd0aCA/IHN0b3JlLmFpTW9kZWxzIDogW3N0b3JlLmFpTW9kZWxdKS5tYXAoKG0pID0+IGA8b3B0aW9uIHZhbHVlPSIke2VzYyhtKX0iICR7bSA9PT0gc3RvcmUuYWlNb2RlbCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2MoTU9ERUxfTEFCRUxbbV0gfHwgbSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9sYWJlbD48L2Rpdj5gIDogJyd9CiAgICAgICAgJHtzdG9yZS5haUVycm9yID8gYDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+7LWc6re8IEFJIOyYpOulmDogJHtlc2Moc3RvcmUuYWlFcnJvcil9PC9wPmAgOiAnJ30KICAgICAgICA8aDM+7Lm07Lm07Jik67GF7YGsIOusuOyekCDsnpDrj5kg7J6F66ClIChNYWNyb0Ryb2lkIOustOujjCk8L2gzPgogICAgICAgIDxvbCBjbGFzcz0ic3RlcHMiPgogICAgICAgICAgPGxpPu2UjOugiOydtCDsiqTthqDslrTsl5DshJwgPGI+TWFjcm9Ecm9pZDwvYj4g7ISk7LmYIChQcm8gN+ydvCDssrTtl5gg7JWI64K064qUIOuLq+q4sCk8L2xpPgogICAgICAgICAgPGxpPuunpO2BrOuhnCDstpTqsIAg4oaSIO2KuOumrOqxsCA8Yj7soITtmZQvU01TIOKGkiBTTVMg7IiY7IugPC9iPiAo66qo65OgIOuyiO2YuCwg64K07Jqp7JeQIDxjb2RlPuyelOyVoTwvY29kZT4g7Y+s7ZWoKTwvbGk+CiAgICAgICAgICA8bGk+64+Z7J6RIDxiPuybuSDsoJHsho0g4oaSIEhUVFAg7JqU7LKtPC9iPjogUE9TVCwg7JWE656YIOyjvOyGjCwg67O466y4IHRleHQvcGxhaW4g7JeQIDxiPuKApijrp6Tsp4Eg7YWN7Iqk7Yq4KSDihpIgU01TIOuplOyLnOyngDwvYj4g7ISg7YOdICjrsoTsoITsl5Ag65Sw6528IDxjb2RlPntzbXNfbWVzc2FnZX08L2NvZGU+IOuYkOuKlCA8Y29kZT5bc21zX21lc3NhZ2VdPC9jb2RlPuuhnCDrk6TslrTqsIDsmpQuIOq3uOuMgOuhnCDrkZDshLjsmpQpPC9saT4KICAgICAgICAgIDxsaT7soIDsnqUg7ZuEIO2ctOuMgO2PsCDshKTsoJXsl5DshJwgTWFjcm9Ecm9pZCDrsLDthLDrpqwgPGI+7KCc7ZWcIOyXhuydjDwvYj48L2xpPgogICAgICAgIDwvb2w+CiAgICAgICAgPGRpdiBjbGFzcz0iY29weS1yb3ciPjxpbnB1dCB0eXBlPSJ0ZXh0IiByZWFkb25seSB2YWx1ZT0iJHtlc2Mobm90aWZ5VXJsKCdiYW5rJykpfSIgaWQ9InVybC1iYW5rIj48YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4iIGRhdGEtY29weT0idXJsLWJhbmsiPuuzteyCrDwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+66y47J6Q6rCAIOyZgOuPhCDrsJjsnZHsnbQg7JeG7Jy866m0IO2KuOumrOqxsOulvCA8Yj7slYzrprwg7IiY7IugPC9iPijrqZTsi5zsp4Ag7JWxLCDrgrTsmqkgPGNvZGU+7J6U7JWhPC9jb2RlPinsnLzroZwg67CU6r646rOgIOuzuOusuOydhCA8Y29kZT5bbm90aWZpY2F0aW9uX3RpdGxlXSBbbm90aWZpY2F0aW9uXTwvY29kZT4g66GcIO2VmOyEuOyalC4g6rOE7KKMwrfsubTrk5zsl5Ag7Lm07Lm07Jik67GF7YGsIOuBnSA07J6Q66as66W8IOuTseuhne2VtCDrkZDrqbQg7J6U7JWh64+EIOqwseyLoOuPvOyalC4g7J6Q7IS47ZWcIOuwqeuyleydgCBTRVRVUC5tZCA264uo6rOE7JeQIOyeiOyWtOyalC48L3A+CiAgICAgICAgPGgzPuy5tOy5tOyYpO2OmOydtCDqsrDsoJwg7JWM66a8ICjshKDtg50pPC9oMz4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgc21hbGwiPuqzhOyijOydmCDsubTsubTsmKTtjpjsnbQg7Lac6riI7J2AIOy2qeyghOydtOudvCDsp4DstpzroZwg7IS47KeAIOyViuyVhOyalCjqs4TsoozCt+y5tOuTnOyXkCA8Yj7qsITtjrjqsrDsoJwg66i464uIPC9iPuuhnCDsubTsubTsmKTtjpjsnbTrpbwg65Ox66GdKS4g7Iuk7KCcIOqysOygnOuKlCDsubTsubTsmKTtjpjsnbQg6rKw7KCc64K07Jet7J2EIOu2meyXrOuEo+q4sMK37YyM7J2866GcIOqwgOyguOyYpOqxsOuCmCwgTWFjcm9Ecm9pZCDrp6TtgazroZzrpbwg7ZWY64KYIOuNlCDrp4zrk6TslrQg7Iuk7Iuc6rCE7Jy866GcIOuwm+ydhCDsiJgg7J6I7Ja07JqUOiDtirjrpqzqsbAgPGI+7JWM66a8IOyImOyLoDwvYj4o7JWxOiDsubTsubTsmKTtjpjsnbQsIOuCtOyaqeyXkCA8Y29kZT7sm5A8L2NvZGU+KSDihpIg64+Z7J6RIDxiPuybuSDsoJHsho0g4oaSIEhUVFAg7JqU7LKtPC9iPihQT1NULCDslYTrnpgg7KO87IaMLCDrs7jrrLggPGNvZGU+W25vdGlmaWNhdGlvbl90aXRsZV0gW25vdGlmaWNhdGlvbl08L2NvZGU+KS4g7JWM66a8IOygkeq3vCDqtoztlZzsnbQg7ZWE7JqU7ZW07JqULjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJjb3B5LXJvdyI+PGlucHV0IHR5cGU9InRleHQiIHJlYWRvbmx5IHZhbHVlPSIke2VzYyhub3RpZnlVcmwoJ3BheScpKX0iIGlkPSJ1cmwtcGF5Ij48YnV0dG9uIGNsYXNzPSJnaG9zdC1idG4iIGRhdGEtY29weT0idXJsLXBheSI+67O17IKsPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRldGFpbHMgY2xhc3M9InNtYWxsIj4KICAgICAgICAgIDxzdW1tYXJ5PuyngeygkSDrp4zrk6Ag7JWM66a8IOyXsOqysCDslbEgKOyEoO2DnSwg67O07JWIIOywqOuLqOuQoCDsiJgg7J6I7J2MKTwvc3VtbWFyeT4KICAgICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+7ZSM66CI7J20IOyKpO2GoOyWtCDrsJYg7JWx7J206528IOyCvOyEsSDrs7TslYgg6riw64ql7J20IOyEpOy5mOulvCDrp4nsnYQg7IiYIOyeiOyWtOyalC4g67O07JWIIOyEpOygleydhCDrgYTrqbTshJzquYzsp4Ag7JOw64qUIOqyg+ydgCDqtoztlZjsp4Ag7JWK7JWE7JqULiA8YSBocmVmPSIke05PVElfQVBLX1VSTH0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5BUEsg67Cb6riwPC9hPiDCtyA8YSBocmVmPSIke2VzYyhjb25uZWN0TGluaygpKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj7shKTsuZjtlZwg7JWx7JeQIOyXsOqysDwvYT48L3A+CiAgICAgICAgPC9kZXRhaWxzPgogICAgICAgIDxkaXYgY2xhc3M9InJvdy1hY3Rpb25zIj4KICAgICAgICAgICR7c3RvcmUuc2VydmVyLmVtYmVkZGVkID8gJzxidXR0b24gaWQ9ImZvcmdldC1rZXktYnRuIiBjbGFzcz0iZ2hvc3QtYnRuIHNtYWxsLWJ0biI+7J20IOq4sOq4sOyXkOyEnCDsoJHsho0g7YKkIOyngOyasOq4sDwvYnV0dG9uPicgOiAnPGJ1dHRvbiBpZD0iZGlzY29ubmVjdC1idG4iIGNsYXNzPSJkYW5nZXItYnRuIj7sl7DqsrAg7ZW07KCcICjsnbQg6riw6riwIOyggOyepeycvOuhnCk8L2J1dHRvbj4nfQogICAgICAgIDwvZGl2PmA7CiAgICAgICQoJyNhaS1mb3JtJykuYWRkRXZlbnRMaXN0ZW5lcignc3VibWl0JywgcXVpZXQoYXN5bmMgKGUpID0+IHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3Qga2V5ID0gJCgnI2FpLWtleScpLnZhbHVlLnRyaW0oKTsKICAgICAgICBpZiAoIWtleSAmJiAhY29uZmlybSgnQVBJIO2CpOulvCDsp4DsmrDqs6AgQUkg67aE66WY66W8IOuBjOq5jOyalD8nKSkgcmV0dXJuOwogICAgICAgIGF3YWl0IGJ1c3koJ0FQSSDtgqTrpbwg7ZmV7J247ZWY64qUIOykkeKApicsICgpID0+IHN0b3JlLnNldEFwaUtleShrZXkpKTsKICAgICAgICB0b2FzdChzdG9yZS5haUVuYWJsZWQgPyAnQUkg67aE66WY66W8IOy8sOyWtOyalC4nIDogJ0FJIOu2hOulmOulvCDqu5DslrTsmpQuJyk7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0pKTsKICAgICAgY29uc3QgbW9kZWxTZWwgPSAkKCcjYWktbW9kZWwnKTsKICAgICAgaWYgKG1vZGVsU2VsKSBtb2RlbFNlbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWlldChhc3luYyAoKSA9PiB7CiAgICAgICAgYXdhaXQgYnVzeShudWxsLCAoKSA9PiBzdG9yZS5zZXRNb2RlbChtb2RlbFNlbC52YWx1ZSkpOwogICAgICAgIHRvYXN0KCfrqqjrjbjsnYQg67CU6r+o7Ja07JqULicpOwogICAgICB9KSk7CiAgICAgIGNhcmQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY29weV0nKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGNvbnN0IGlucHV0ID0gJChgIyR7Yi5kYXRhc2V0LmNvcHl9YCk7CiAgICAgICAgY29weVRleHQoaW5wdXQudmFsdWUsIGlucHV0KTsKICAgICAgfSkpOwogICAgICBjb25zdCBmayA9ICQoJyNmb3JnZXQta2V5LWJ0bicpOwogICAgICBpZiAoZmspIGZrLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGlmICghY29uZmlybSgn7J20IOq4sOq4sOyXkOyEnCDsoJHsho0g7YKk66W8IOyngOyauOq5jOyalD8g64uk7J2M7JeQIOyXtCDrlYwg64uk7IucIOyeheugpe2VtOyVvCDtlbTsmpQuJykpIHJldHVybjsKICAgICAgICBzdG9yZS5mb3JnZXRLZXkoKTsKICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTsKICAgICAgfSk7CiAgICAgIGNvbnN0IGRjID0gJCgnI2Rpc2Nvbm5lY3QtYnRuJyk7CiAgICAgIGlmIChkYykgZGMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgICAgaWYgKCFjb25maXJtKCfshJzrsoQg7Jew6rKw7J2EIO2VtOygnO2VoOq5jOyalD8g6rWs6riAIOyLnO2KuOydmCDrjbDsnbTthLDripQg6re464yA66GcIOuCqOyVhCDsnojsirXri4jri6QuJykpIHJldHVybjsKICAgICAgICBzdG9yZS5kaXNjb25uZWN0KCk7CiAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7CiAgICAgIH0pOwogICAgfSBlbHNlIHsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgCiAgICAgICAgPGgyPuyekOuPmSDsnoXroKUgKOq1rOq4gCDsi5ztirgg7ISc67KEIOyXsOqysCk8L2gyPgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+7Lm065OcIOusuOyekMK37J2A7ZaJIOyVjOumvCDsnpDrj5kg7J6F66Cl6rO8IEFJIOu2hOulmOuKlCDqtazquIAg7Iuc7Yq4IOyEnOuyhOqwgCDsnojslrTslbwg64+Z7J6R7ZW07JqULiDsoIDsnqXshozsnZggPGI+U0VUVVAubWQ8L2I+IOuMgOuhnCDqtazquIAgQXBwcyBTY3JpcHQg66W8IOuwsO2PrO2VnCDrkqQsIOybueyVsSDso7zshozsmYAg7KCR7IaNIO2CpOulvCDrhKPsnLzshLjsmpQuIOybueyVsSDso7zshozroZwg67CU66GcIOygkeyGje2VtOyEnCDsjajrj4Qg65Cp64uI64ukLjwvcD4KICAgICAgICA8Zm9ybSBpZD0iY29ubmVjdC1mb3JtIiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0id2lkZSI+7Ju57JWxIOyjvOyGjDxpbnB1dCB0eXBlPSJ1cmwiIGlkPSJjLXVybCIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vc2NyaXB0Lmdvb2dsZS5jb20vbWFjcm9zL3Mv4oCmL2V4ZWMiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+7KCR7IaNIO2CpDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iYy1rZXkiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmb3JtLXN1Ym1pdCI+PGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJwcmltYXJ5LWJ0biI+7Jew6rKwPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9mb3JtPmA7CiAgICAgICQoJyNjb25uZWN0LWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCBxdWlldChhc3luYyAoZSkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCB1cmwgPSAkKCcjYy11cmwnKS52YWx1ZS50cmltKCkucmVwbGFjZSgvXD8uKiQvLCAnJyk7CiAgICAgICAgY29uc3Qga2V5ID0gJCgnI2Mta2V5JykudmFsdWUudHJpbSgpOwogICAgICAgIGF3YWl0IGJ1c3koJ+yXsOqysCDtmZXsnbgg7KSR4oCmJywgKCkgPT4gc3RvcmUucGluZyh1cmwsIGtleSkpOwogICAgICAgIGNvbnN0IG1pZ3JhdGUgPSBTKCkudHJhbnNhY3Rpb25zLmxlbmd0aCA+IDAgJiYgY29uZmlybSgn7J20IOq4sOq4sOyXkCDsnojrjZgg6rOE7ZqN6rO8IOuCtOyXreydhCDqtazquIAg7Iuc7Yq466GcIOyYruq4uOq5jOyalD8nKTsKICAgICAgICBzdG9yZS5jb25uZWN0KHVybCwga2V5LCBtaWdyYXRlKTsKICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTsKICAgICAgfSkpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gY2hhbmdlU3RhcnREYXkobmV3RGF5KSB7CiAgICBMLnJlbWFwUGVyaW9kS2V5cyhTKCksIG5ld0RheSk7CiAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBuZXdEYXkpOwogICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgIHJlbmRlckNocm9tZSgpOwogICAgdG9hc3QoYOydtOygnCDrp6Tsm5QgJHtuZXdEYXl97J287JeQIOyDiCDquLDqsITsnbQg7Iuc7J6R65Cp64uI64ukLmApOwogIH0KCiAgLy8gLS0tLS0tLS0tLSDrsLHsl4UgLS0tLS0tLS0tLQoKICBmdW5jdGlvbiBleHBvcnREYXRhKCkgewogICAgY29uc3QgYmxvYiA9IG5ldyBCbG9iKFtKU09OLnN0cmluZ2lmeShTKCksIG51bGwsIDIpXSwgeyB0eXBlOiAnYXBwbGljYXRpb24vanNvbicgfSk7CiAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpOwogICAgYS5ocmVmID0gVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsKICAgIGEuZG93bmxvYWQgPSBg7KeA7Lac6rSA66asLeuwseyXhS0ke0wudG9kYXlJU08oKX0uanNvbmA7CiAgICBhLmNsaWNrKCk7CiAgICBzZXRUaW1lb3V0KCgpID0+IFVSTC5yZXZva2VPYmplY3RVUkwoYS5ocmVmKSwgMTAwMCk7CiAgfQoKICBmdW5jdGlvbiBpbXBvcnREYXRhKGZpbGUpIHsKICAgIGNvbnN0IHJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7CiAgICByZWFkZXIub25sb2FkID0gcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBsZXQgcGFyc2VkOwogICAgICB0cnkgewogICAgICAgIHBhcnNlZCA9IEwubm9ybWFsaXplU3RhdGUoSlNPTi5wYXJzZShyZWFkZXIucmVzdWx0KSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICByZXR1cm4gdG9hc3QoJ+yYrOuwlOuluCDrsLHsl4Ug7YyM7J287J20IOyVhOuLmeuLiOuLpC4nKTsKICAgICAgfQogICAgICBjb25zdCBtc2cgPSBzdG9yZS5tb2RlID09PSAncmVtb3RlJyA/ICfrsLHsl4XsnZgg6rOE7ZqNwrfqs4Tsoozrpbwg7KCB7Jqp7ZWY6rOgIOuCtOyXreydhCDqtazquIAg7Iuc7Yq47JeQIOy2lOqwgO2VoOq5jOyalD8nIDogJ+2YhOyerCDrjbDsnbTthLDrpbwg67Cx7JeFIO2MjOydvOydmCDrgrTsmqnsnLzroZwg67CU6r+A6rmM7JqUPyc7CiAgICAgIGlmICghY29uZmlybShtc2cpKSByZXR1cm47CiAgICAgIGF3YWl0IGJ1c3koJ+u2iOufrOyYpOuKlCDspJHigKYnLCAoKSA9PiBzdG9yZS5pbXBvcnRTdGF0ZShwYXJzZWQpKTsKICAgICAgY3VycmVudFBlcmlvZCA9IEwuZ2V0UGVyaW9kKEwudG9kYXlJU08oKSwgUygpLnNldHRpbmdzLnN0YXJ0RGF5KTsKICAgICAgdG9hc3QoJ+uwseyXheydhCDrtojrn6zsmZTsirXri4jri6QuJyk7CiAgICAgIHJlbmRlcigpOwogICAgfSk7CiAgICByZWFkZXIucmVhZEFzVGV4dChmaWxlKTsKICB9CgogIC8vIC0tLS0tLS0tLS0g66CM642UICYg7J2067Kk7Yq4IC0tLS0tLS0tLS0KCiAgZnVuY3Rpb24gcmVuZGVyKCkgewogICAgcmVuZGVyQ2hyb21lKCk7CiAgICBjb25zdCBwYWdlID0gY3VycmVudFBhZ2U7CiAgICBpZiAocGFnZSA9PT0gJ2hvbWUnKSByZW5kZXJIb21lKCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnY2FsZW5kYXInKSByZW5kZXJDYWxlbmRhcigpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ2xpc3QnKSByZW5kZXJMaXN0KCk7CiAgICBlbHNlIGlmIChwYWdlID09PSAnc29ydCcpIHJlbmRlclNvcnQoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdyZXBvcnQnKSByZW5kZXJSZXBvcnQoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdhc3NldHMnKSByZW5kZXJBc3NldHMoKTsKICAgIGVsc2UgaWYgKHBhZ2UgPT09ICdwbGFuJykgcmVuZGVyUGxhbigpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ2FkZCcpIHJlbmRlckFkZCgpOwogICAgZWxzZSBpZiAocGFnZSA9PT0gJ3NldHRpbmdzJykgcmVuZGVyU2V0dGluZ3MoKTsKICAgIHRpZHlIaW50cygpOwogIH0KCiAgLy8g6ri0IOyEpOuqhSDrrLjqtazripQg7KCR7Ja0IOuRkOqzoCDsoJzrqqkg7JiGIOKTmCDrpbwg64iM65+s7JW8IOuztOydtOqyjCDtlZzri6QgKO2ZlOuptOydhCDqsIDrs43qsowpCiAgZnVuY3Rpb24gdGlkeUhpbnRzKCkgewogICAgJCQoJy5jb250ZW50IHAubXV0ZWQuc21hbGw6bm90KFtpZF0pOm5vdChbZGF0YS1oaW50XSknKS5mb3JFYWNoKChwKSA9PiB7CiAgICAgIHAuZGF0YXNldC5oaW50ID0gJzEnOwogICAgICBpZiAocC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoIDwgNDUgfHwgcC5jbG9zZXN0KCcuYWNjdC1ub3RlLCB0YWJsZSwgLmtleS1jYXJkJykpIHJldHVybjsKICAgICAgcC5jbGFzc0xpc3QuYWRkKCdoaW50LWNvbGxhcHNlZCcpOwogICAgICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsKICAgICAgYnRuLnR5cGUgPSAnYnV0dG9uJzsKICAgICAgYnRuLmNsYXNzTmFtZSA9ICdoaW50LXRvZ2dsZSc7CiAgICAgIGJ0bi50ZXh0Q29udGVudCA9ICdpJzsKICAgICAgYnRuLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsICfshKTrqoUg67O06riwJyk7CiAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCAnZmFsc2UnKTsKICAgICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICAgIGNvbnN0IG9wZW4gPSBwLmNsYXNzTGlzdC50b2dnbGUoJ2hpbnQtY29sbGFwc2VkJykgPT09IGZhbHNlOwogICAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCBTdHJpbmcob3BlbikpOwogICAgICB9KTsKICAgICAgLy8g6rCZ7J2AIOy5tOuTnCDslYgg67CU66GcIOyVnuydmCDsoJzrqqkg7JiG7JeQIOu2meydtOqzoCwg7JeG7Jy866m0IOusuOuLqCDsnpDrpqzsl5Ag65GU64ukCiAgICAgIGxldCBwcmV2ID0gcC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICB3aGlsZSAocHJldiAmJiAhL15IWzIzXSQvLnRlc3QocHJldi50YWdOYW1lKSAmJiAhcHJldi5jbGFzc0xpc3QuY29udGFpbnMoJ2NhcmQtaGVhZCcpKSBwcmV2ID0gcHJldi5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICBjb25zdCB0YXJnZXQgPSBwcmV2ICYmIChwcmV2LmNsYXNzTGlzdC5jb250YWlucygnY2FyZC1oZWFkJykgPyBwcmV2LnF1ZXJ5U2VsZWN0b3IoJ2gyJykgOiBwcmV2KTsKICAgICAgaWYgKHRhcmdldCAmJiAhdGFyZ2V0LnF1ZXJ5U2VsZWN0b3IoJy5oaW50LXRvZ2dsZScpKSB0YXJnZXQuYXBwZW5kQ2hpbGQoYnRuKTsKICAgICAgZWxzZSBwLmJlZm9yZShidG4pOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBiaW5kRXZlbnRzKCkgewogICAgJCQoJy5uYXYtaXRlbVtkYXRhLXBhZ2VdLCAuYm90dG9tLW5hdiBbZGF0YS1wYWdlXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZShiLmRhdGFzZXQucGFnZSkpKTsKICAgICQkKCdbZGF0YS1nb3RvXScpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZShiLmRhdGFzZXQuZ290bykpKTsKICAgICQkKCdbZGF0YS1vcGVuLW1lbnVdJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5NZW51KSk7CiAgICAkKCcjbWVudS1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5NZW51KTsKICAgICQoJyNzY3JpbScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgY2xvc2VNZW51KTsKICAgICQoJyNhZGQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBzaG93UGFnZSgnYWRkJykpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2hhc2hjaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGNvbnN0IG5hbWUgPSBsb2NhdGlvbi5oYXNoLnNsaWNlKDEpOwogICAgICBpZiAoUEFHRVNbbmFtZV0gJiYgbmFtZSAhPT0gY3VycmVudFBhZ2UpIHNob3dQYWdlKG5hbWUsIHsgcHVzaDogZmFsc2UgfSk7CiAgICB9KTsKICAgICQkKCcuc2V0dGluZ3MtbmF2IGEnKS5mb3JFYWNoKChhKSA9PiBhLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAkKGEuZ2V0QXR0cmlidXRlKCdocmVmJykpLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6ICdzbW9vdGgnLCBibG9jazogJ3N0YXJ0JyB9KTsKICAgIH0pKTsKCiAgICBjb25zdCBtb3ZlID0gKGRlbHRhKSA9PiB7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBMLnNoaWZ0UGVyaW9kKGN1cnJlbnRQZXJpb2QsIGRlbHRhLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICAkKCcjaW5jb21lLWJveCcpLmRhdGFzZXQuZWRpdGluZyA9ICcnOwogICAgICByZW5kZXIoKTsKICAgIH07CiAgICAkKCcjcHJldi1wZXJpb2QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG1vdmUoLTEpKTsKICAgICQoJyNuZXh0LXBlcmlvZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gbW92ZSgxKSk7CiAgICAkKCcjdG9kYXktcGVyaW9kJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGN1cnJlbnRQZXJpb2QgPSBMLmdldFBlcmlvZChMLnRvZGF5SVNPKCksIFMoKS5zZXR0aW5ncy5zdGFydERheSk7CiAgICAgIHNlbGVjdGVkRGF0ZSA9IG51bGw7CiAgICAgIHJlbmRlcigpOwogICAgfSk7CiAgICAkKCcjcmVmcmVzaC1idG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGFzeW5jICgpID0+IHsKICAgICAgYXdhaXQgYnVzeSgn67aI65+s7Jik64qUIOykkeKApicsICgpID0+IHN0b3JlLnJlZnJlc2goKSk7CiAgICAgIHJlbmRlcigpOwogICAgfSkpOwoKICAgIC8vIOyeheugpQogICAgJCQoJyNtLWtpbmQgYnV0dG9uJykuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgbWFudWFsS2luZCA9IGIuZGF0YXNldC5raW5kOwogICAgICByZW5kZXJBZGQoKTsKICAgIH0pKTsKICAgICQoJyNtYW51YWwtZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIHF1aWV0KG9uTWFudWFsU3VibWl0KSk7CiAgICBmb3JtYXRPbkJsdXIoJCgnI20tYW1vdW50JykpOwogICAgJCgnI20tbWVtbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgdXBkYXRlTWFudWFsSGludCk7CiAgICAkKCcjbS1jYXRlZ29yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHVwZGF0ZU1hbnVhbEhpbnQpOwogICAgJCgnI20tZGF0ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHJlbmRlckFkZCk7CiAgICAkKCcjcGFyc2UtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldChvblBhcnNlKSk7CiAgICAkKCcjcGFzdGUtY2xlYXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgJCgnI3Bhc3RlLWlucHV0JykudmFsdWUgPSAnJzsKICAgICAgY2xlYXJQcmV2aWV3KCk7CiAgICB9KTsKICAgICQoJyNmaWxlLWlucHV0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVpZXQoYXN5bmMgKGUpID0+IHsKICAgICAgaWYgKGUudGFyZ2V0LmZpbGVzWzBdKSBhd2FpdCBvbkZpbGVDaG9zZW4oZS50YXJnZXQuZmlsZXNbMF0pOwogICAgfSkpOwoKICAgIC8vIOuCtOyXrQogICAgY29uc3Qgc2V0RmlsdGVyID0gKGtleSwgdmFsdWUpID0+IHsKICAgICAgbGlzdFN0YXRlW2tleV0gPSB2YWx1ZTsKICAgICAgcmVuZGVyTGlzdCgpOwogICAgfTsKICAgICQoJyNsaXN0LXNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGUpID0+IHNldEZpbHRlcignc2VhcmNoJywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWtpbmQnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gc2V0RmlsdGVyKCdraW5kJywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWZpbHRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBzZXRGaWx0ZXIoJ2NhdGVnb3J5JywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNsaXN0LWFjY291bnQnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gc2V0RmlsdGVyKCdhY2NvdW50JywgZS50YXJnZXQudmFsdWUpKTsKICAgICQoJyNyZWNsYXNzaWZ5LXVuY2xhc3NpZmllZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcXVpZXQoKCkgPT4gcnVuUmVjbGFzc2lmeSh0cnVlKSkpOwogICAgJCgnI3JlY2xhc3NpZnktYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBxdWlldCgoKSA9PiBydW5SZWNsYXNzaWZ5KGZhbHNlKSkpOwogICAgJCgnI3BheS10b3B1cHMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHF1aWV0KGZpeFBheVRvcHVwcykpOwoKICAgIC8vIOyYiOyCsCDqs4Ttmo0KICAgICQoJyNyYXRpby1iYXNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGUpID0+IHsKICAgICAgYnVkZ2V0UGxhbigpLnJhdGlvQmFzZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICBzdG9yZS5zYXZlTWV0YSgpOwogICAgICByZW5kZXJQbGFuVmVyc2lvbigpOwogICAgICByZW5kZXJQbGFuU3VtbWFyeSgpOwogICAgfSk7CiAgICAkKCcjZml4ZWQtb3ZlcmZsb3cnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBidWRnZXRQbGFuKCkuZml4ZWRPdmVyZmxvdyA9IGUudGFyZ2V0LnZhbHVlID09PSAnc2NhbGUnID8gJ3NjYWxlJyA6ICd3YXJuJzsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgcmVuZGVyUGxhblZlcnNpb24oKTsKICAgICAgcmVuZGVyUGxhblN1bW1hcnkoKTsKICAgIH0pOwogICAgJCgnI2FkZC1jYXRlZ29yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQ2F0ZWdvcnkpOwoKICAgIC8vIOyEpOyglQogICAgJCgnI3N0YXJ0LWRheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiBjaGFuZ2VTdGFydERheShOdW1iZXIoZS50YXJnZXQudmFsdWUpKSk7CiAgICAkKCcjbXktbmFtZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChlKSA9PiB7CiAgICAgIFMoKS5zZXR0aW5ncy5teU5hbWUgPSBlLnRhcmdldC52YWx1ZS50cmltKCk7CiAgICAgIHN0b3JlLnNhdmVNZXRhKCk7CiAgICB9KTsKICAgICQoJyNydWxlLWZvcm0nKS5hZGRFdmVudExpc3RlbmVyKCdzdWJtaXQnLCAoZSkgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGNvbnN0IG5hbWUgPSBMLm5vcm1hbGl6ZU1lcmNoYW50KCQoJyNydWxlLW5hbWUnKS52YWx1ZSk7CiAgICAgIGlmICghbmFtZSkgcmV0dXJuIHRvYXN0KCfqsIDrp7nsoJDsnbTrgpgg7IOB64yAIOydtOumhOydhCDsnoXroKXtlbQg7KO87IS47JqULicpOwogICAgICBTKCkubWVyY2hhbnRNYXBbbmFtZV0gPSAkKCcjcnVsZS1jYXQnKS52YWx1ZTsKICAgICAgc3RvcmUuc2F2ZU1ldGEoKTsKICAgICAgJCgnI3J1bGUtbmFtZScpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KCfqt5zsuZnsnYQg66eM65Ok7JeI7Ja07JqULiDslZ7snLzroZwg65Ok7Ja07Jik64qUIOuCtOyXreu2gO2EsCDsoIHsmqnrj7zsmpQuJyk7CiAgICAgIHJlbmRlclJ1bGVzKCk7CiAgICB9KTsKICAgICQoJyNhZGQtYWNjb3VudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYWRkQWNjb3VudCk7CiAgICAkKCcjZXhwb3J0LWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXhwb3J0RGF0YSk7CiAgICAkKCcjaW1wb3J0LWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZSkgPT4gewogICAgICBpZiAoZS50YXJnZXQuZmlsZXNbMF0pIGltcG9ydERhdGEoZS50YXJnZXQuZmlsZXNbMF0pOwogICAgICBlLnRhcmdldC52YWx1ZSA9ICcnOwogICAgfSk7CiAgICAkKCcjcmVzZXQtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgn66qo65OgIOuCtOyXrSwg7IiY7J6FLCDqs4Ttmo0sIOqzhOyijOulvCDsp4DsmrDqs6Ag7LKY7J2MIOyDge2DnOuhnCDrkJjrj4zrprTquYzsmpQ/ICjrkJjrj4zrprQg7IiYIOyXhuyKteuLiOuLpCknKSkgcmV0dXJuOwogICAgICBzdG9yZS5yZXNldCgpOwogICAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgICB0b2FzdCgn7LSI6riw7ZmU7ZaI7Iq164uI64ukLicpOwogICAgICByZW5kZXIoKTsKICAgIH0pOwoKICAgIC8vIOyVseydhCDrlqDrgqAg65WMIOyVhOyngSDrs7TrgrTsp4Ag7JWK7J2AIOuzgOqyveydhCDsoIDsnqXtlZjqs6AsIOuPjOyVhOyYpOuptCDsg4jroZwg65Ok7Ja07JioIOyVjOumvCDrgrTsl63snYQg67aI65+s7Jio64ukCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgcXVpZXQoYXN5bmMgKCkgPT4gewogICAgICBpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSAnaGlkZGVuJykgcmV0dXJuIHN0b3JlLmZsdXNoTWV0YSgpOwogICAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIWJ1c3lDb3VudCAmJiAhc3RvcmUuaGFzUGVuZGluZ01ldGEoKSkgewogICAgICAgIGF3YWl0IHN0b3JlLnJlZnJlc2goKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfQogICAgfSkpOwogIH0KCiAgLy8g6rWs6riAIOybuSDslbHsnLzroZwg7LKY7J2MIOyXtOyXiOydhCDrlYw6IOygkeyGjSDtgqTrpbwg7ZWcIOuyiCDsnoXroKXrsJvslYQg7J20IOq4sOq4sOyXkCDquLDslrXtlZzri6QKICBmdW5jdGlvbiBhc2tLZXkoKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICAgIGJveC5jbGFzc05hbWUgPSAna2V5LWdhdGUnOwogICAgICBib3guaW5uZXJIVE1MID0gYAogICAgICAgIDxmb3JtIGNsYXNzPSJjYXJkIGtleS1jYXJkIiBpZD0ia2V5LWZvcm0iPgogICAgICAgICAgPGgyPuygkeyGjSDtgqTrpbwg7J6F66Cl7ZWY7IS47JqUPC9oMj4KICAgICAgICAgIDxwIGNsYXNzPSJtdXRlZCBzbWFsbCI+6rWs6riAIEFwcHMgU2NyaXB0IO2OuOynkeq4sOyXkOyEnCA8Yj5zZXR1cDwvYj4g7J2EIOyLpO2Wie2VmOuptCDsi6Ttlokg6riw66Gd7JeQIOuCmOyYpOuKlCDtgqTsmIjsmpQuICjslYgg67O07J2066m0IOKamSDtlITroZzsoJ3tirgg7ISk7KCVIOKGkiDsiqTtgazrpr3tirgg7IaN7ISx7J2YIDxiPkFQUF9LRVk8L2I+KSDtlZwg67KIIOyeheugpe2VmOuptCDsnbQg6riw6riw6rCAIOq4sOyWte2VtOyalC48L3A+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icGFzc3dvcmQiIGlkPSJrZXktaW5wdXQiIGF1dG9jb21wbGV0ZT0iY3VycmVudC1wYXNzd29yZCIgcGxhY2Vob2xkZXI9IuygkeyGjSDtgqQiIHJlcXVpcmVkPgogICAgICAgICAgPGRpdiBjbGFzcz0icm93LWFjdGlvbnMiPjxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0icHJpbWFyeS1idG4iPuuTpOyWtOqwgOq4sDwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPHAgY2xhc3M9InNtYWxsIHdhcm4iIGlkPSJrZXktZXJyb3IiIGhpZGRlbj48L3A+CiAgICAgICAgPC9mb3JtPmA7CiAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYm94KTsKICAgICAgJCgnI2tleS1pbnB1dCcpLmZvY3VzKCk7CiAgICAgICQoJyNrZXktZm9ybScpLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Ym1pdCcsIGFzeW5jIChlKSA9PiB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGVyciA9ICQoJyNrZXktZXJyb3InKTsKICAgICAgICBlcnIuaGlkZGVuID0gdHJ1ZTsKICAgICAgICB0cnkgewogICAgICAgICAgYXdhaXQgc3RvcmUudXNlS2V5KCQoJyNrZXktaW5wdXQnKS52YWx1ZS50cmltKCkpOwogICAgICAgICAgYm94LnJlbW92ZSgpOwogICAgICAgICAgcmVzb2x2ZSgpOwogICAgICAgIH0gY2F0Y2ggKGV4KSB7CiAgICAgICAgICBlcnIudGV4dENvbnRlbnQgPSAvdW5hdXRob3JpemVkLy50ZXN0KGV4Lm1lc3NhZ2UpID8gJ+2CpOqwgCDrp57sp4Ag7JWK7JWE7JqULiDri6Tsi5wg7ZmV7J247ZW0IOyjvOyEuOyalC4nIDogYO2ZleyduO2VmOyngCDrqrvtlojslrTsmpQ6ICR7ZXgubWVzc2FnZX1gOwogICAgICAgICAgZXJyLmhpZGRlbiA9IGZhbHNlOwogICAgICAgIH0KICAgICAgfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgd2luZG93Ll9fYnVkZ2V0U3RhcnRlZCA9IHRydWU7CiAgICBiaW5kRXZlbnRzKCk7CiAgICBpZiAoc3RvcmUubW9kZSA9PT0gJ3JlbW90ZScgJiYgIXN0b3JlLnNlcnZlci5rZXkpIGF3YWl0IGFza0tleSgpOwogICAgY29uc3QgdG9NaWdyYXRlID0gc3RvcmUudGFrZU1pZ3JhdGlvbigpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYnVzeShzdG9yZS5tb2RlID09PSAncmVtb3RlJyA/ICfrtojrn6zsmKTripQg7KSR4oCmJyA6IG51bGwsICgpID0+IHN0b3JlLmluaXQoKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgICQoJyNjYXRlZ29yeS1yb3dzJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImVtcHR5Ij7shJzrsoTsl5Ag7Jew6rKw7ZWY7KeAIOuqu+2WiOyKteuLiOuLpC4gKCR7ZXNjKGUubWVzc2FnZSB8fCBlKX0pPGJyPuyEpOyglSDihpIg7J6Q64+ZIOyeheugpeyXkOyEnCDso7zshozsmYAg7YKk66W8IO2ZleyduO2VmOyEuOyalC48L2Rpdj5gOwogICAgfQogICAgaWYgKHRvTWlncmF0ZSkgewogICAgICBhd2FpdCBidXN5KCfsnbQg6riw6riwIOuNsOydtO2EsOulvCDsmK7quLDripQg7KSR4oCmJywgKCkgPT4gc3RvcmUuaW1wb3J0U3RhdGUodG9NaWdyYXRlKSkuY2F0Y2goKCkgPT4ge30pOwogICAgICB0b2FzdCgn7J20IOq4sOq4sCDrjbDsnbTthLDrpbwg6rWs6riAIOyLnO2KuOuhnCDsmK7qsrzsirXri4jri6QuJyk7CiAgICB9CiAgICBjdXJyZW50UGVyaW9kID0gTC5nZXRQZXJpb2QoTC50b2RheUlTTygpLCBTKCkuc2V0dGluZ3Muc3RhcnREYXkpOwogICAgc2hvd1BhZ2UobG9jYXRpb24uaGFzaC5zbGljZSgxKSB8fCAnaG9tZScsIHsgcHVzaDogZmFsc2UgfSk7CiAgfQoKICBzdGFydCgpOwp9KSgpOwo=\");</script>\n</body>\n</html>\n";
