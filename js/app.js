/* 지출 관리 앱 화면. 계산은 js/logic.js, 저장은 js/store.js, 차트는 js/charts.js */
(function () {
  'use strict';

  const L = window.BudgetLogic;
  const C = window.BudgetCharts;
  const store = window.BudgetStore;
  const S = () => store.state;

  // ---------- 유틸 ----------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowISO = () => new Date().toISOString();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function parseAmountInput(s) {
    const cleaned = String(s || '').replace(/[^\d-]/g, '');
    if (!cleaned || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function fmtDate(iso) {
    const { y, m, d } = L.parseISO(iso);
    return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function dowOf(iso) {
    const { y, m, d } = L.parseISO(iso);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function fmtDay(iso) {
    const { m, d } = L.parseISO(iso);
    return `${m}월 ${d}일 ${DOW[dowOf(iso)]}요일`;
  }

  function fmtDateTime(isoTime) {
    if (!isoTime) return '';
    const d = new Date(isoTime);
    if (isNaN(d)) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }
  store.onError = (e) => toast(e.message, 5000);

  let busyCount = 0;
  async function busy(label, fn) {
    busyCount += 1;
    $('#busy').hidden = false;
    if (label) toast(label, 60000);
    try {
      return await fn();
    } catch (e) {
      toast(`오류: ${e.message || e}`, 5000);
      throw e;
    } finally {
      busyCount -= 1;
      if (!busyCount) $('#busy').hidden = true;
      if (label && $('#toast').textContent === label) $('#toast').hidden = true;
    }
  }

  // busy 가 이미 오류를 알렸으므로 이벤트 핸들러에서는 삼킨다
  const quiet = (fn) => (...args) => Promise.resolve(fn(...args)).catch(() => {});

  function formatOnBlur(input) {
    input.addEventListener('blur', () => {
      const n = parseAmountInput(input.value);
      if (n !== null) input.value = n.toLocaleString('ko-KR');
    });
  }

  function copyText(text, input) {
    const done = () => toast('복사했습니다.');
    const fallback = () => {
      input.select();
      try {
        document.execCommand('copy');
        done();
      } catch (e) {
        toast('길게 눌러 직접 복사해 주세요.');
      }
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ---------- 상태 ----------

  let currentPeriod = L.getPeriod(L.todayISO(), 1);
  let currentPage = 'home';
  let selectedDate = null;
  const listState = { search: '', kind: 'all', category: 'all', account: 'all' };
  let manualKind = 'expense';

  const planForDate = (date) => store.planForDate(date);
  const planForTx = (t) => store.planForTx(t);
  const currentPlan = () => L.planFor(S(), currentPeriod.key);

  function categoryInfo(id, categories = currentPlan().categories) {
    const i = categories.findIndex((c) => c.id === id);
    return i >= 0 ? { name: categories[i].name, colorIndex: i } : { name: '미분류', colorIndex: -1 };
  }

  function accountName(id) {
    const a = S().accounts.find((x) => x.id === id);
    return a ? a.name || `${a.type === 'card' ? '카드' : '계좌'} ${a.last4}` : '';
  }

  function categoryOptions(categories, selected, { includeAuto = false } = {}) {
    const opts = [];
    if (includeAuto) opts.push(`<option value="__auto">자동 분류${store.aiEnabled ? ' (AI)' : ''}</option>`);
    opts.push(`<option value="" ${!selected ? 'selected' : ''}>미분류</option>`);
    for (const c of categories) opts.push(`<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`);
    return opts.join('');
  }

  function accountOptions(selected, emptyLabel = '선택 안 함') {
    return [`<option value="">${emptyLabel}</option>`]
      .concat(S().accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(accountName(a.id))}</option>`))
      .join('');
  }

  const METHOD_LABEL = { ai: 'AI', learned: '규칙', keyword: '키워드', manual: '직접' };
  const methodTag = (m) => (m && METHOD_LABEL[m] ? `<span class="tag">${METHOD_LABEL[m]}</span>` : '');

  // ---------- 페이지 이동 ----------

  const PAGES = {
    home: { title: '홈', period: true },
    calendar: { title: '달력', period: true },
    list: { title: '내역', period: true },
    sort: { title: '미분류 정리', period: true },
    report: { title: '리포트', period: true },
    assets: { title: '자산', period: true },
    plan: { title: '예산 계획', period: true },
    add: { title: '지출·수입 입력', period: false },
    settings: { title: '설정', period: false },
  };

  function showPage(name, { push = true, keepPeriod = false } = {}) {
    if (!PAGES[name]) name = 'home';
    currentPage = name;
    // 미분류 정리는 들어올 때마다 이번 기간(설정한 시작일 기준)부터 보여준다
    if (name === 'sort' && !keepPeriod) currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    $$('.bottom-nav [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    const title = $('#page-title');
    title.textContent = PAGES[name].title;
    // 테마별 전환 애니메이션을 다시 시작하도록 클래스를 붙였다 뗀다 (레트로 터미널: 제목 타자 효과)
    title.classList.remove('typing');
    void title.offsetWidth;
    title.classList.add('typing');
    $('#period-nav').hidden = !PAGES[name].period;
    closeMenu();
    // 구글 Apps Script 화면(iframe)처럼 주소를 못 바꾸는 곳에서도 이동은 되게
    try {
      if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    } catch (e) {
      /* 무시 */
    }
    window.scrollTo(0, 0);
    render();
  }

  function openMenu() {
    $('#sidebar').classList.add('open');
    $('#scrim').hidden = false;
  }

  function closeMenu() {
    $('#sidebar').classList.remove('open');
    $('#scrim').hidden = true;
  }

  // ---------- 공통 머리 ----------

  function renderChrome() {
    applyTheme(); // 다른 기기에서 테마를 바꿨을 수도 있으니 불러올 때마다 맞춘다
    const chip = $('#conn-status');
    if (store.mode === 'local') {
      chip.textContent = '이 기기에만 저장';
      chip.className = 'chip';
    } else {
      chip.textContent = store.aiEnabled ? '구글 시트 · AI 분류' : '구글 시트 · AI 꺼짐';
      chip.className = `chip ${store.aiEnabled ? 'on' : ''}`;
    }
    $('#refresh-btn').hidden = store.mode !== 'remote';
    const unsorted = L.unclassifiedByPeriod(S()).reduce((n, e) => n + e.count, 0);
    $('#sort-count').textContent = unsorted > 99 ? '99+' : String(unsorted);
    $('#sort-count').hidden = !unsorted;

    const p = currentPeriod;
    $('#period-text').textContent = `${fmtDate(p.start)} ~ ${fmtDate(p.end).slice(5)}`;
    const today = L.todayISO();
    let sub;
    if (today >= p.start && today <= p.end) sub = `이번 기간 · ${L.diffDays(today, p.end) + 1}일 남음`;
    else if (today > p.end) sub = '지난 기간';
    else sub = '다가오는 기간';
    $('#period-sub').textContent = sub;
  }

  // ---------- 툴팁 ----------

  function attachTooltip(el, html) {
    const tip = $('#tooltip');
    el.addEventListener('mouseenter', () => {
      tip.innerHTML = html();
      tip.hidden = false;
    });
    el.addEventListener('mousemove', (e) => {
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });
    el.addEventListener('mouseleave', () => (tip.hidden = true));
  }

  // ---------- 거래 한 줄 ----------

  function txRow(t, { editable = true } = {}) {
    const kind = L.kindOf(t);
    const cats = planForTx(t).categories;
    const info = categoryInfo(t.categoryId, cats);
    let icon;
    let amount;
    if (kind === 'income') {
      icon = '<div class="tx-icon" style="background:var(--accent)">+</div>';
      amount = `<span class="tx-amount plus">+${won(t.amount)}</span>`;
    } else if (kind === 'transfer') {
      icon = '<div class="tx-icon gray">↔</div>';
      amount = `<span class="tx-amount neutral">${won(t.amount)}</span>`;
    } else {
      icon = `<div class="tx-icon ${info.colorIndex < 0 ? 'gray' : ''}" style="${info.colorIndex >= 0 ? `background:${C.seriesColor(info.colorIndex)}` : ''}">${esc(info.name.slice(0, 1))}</div>`;
      amount = `<span class="tx-amount ${t.amount < 0 ? 'plus' : ''}">${t.amount < 0 ? '+' : ''}${won(Math.abs(t.amount))}</span>`;
    }
    const meta = [];
    if (editable) {
      // 항목과 종류(입금·이체)를 한 칸에서 고른다
      const current = kind !== 'expense' ? `kind:${kind}` : info.colorIndex >= 0 ? t.categoryId : '';
      meta.push(`<select class="tx-cat" data-id="${esc(t.id)}" aria-label="항목">
        ${categoryOptions(cats, current)}
        <optgroup label="지출이 아님">
          <option value="kind:income" ${current === 'kind:income' ? 'selected' : ''}>입금</option>
          <option value="kind:transfer" ${current === 'kind:transfer' ? 'selected' : ''}>내 계좌 이체</option>
        </optgroup>
      </select>`);
    } else {
      meta.push(esc(kind === 'income' ? '입금' : kind === 'transfer' ? '내 계좌 이체' : info.name));
    }
    if (kind === 'expense' && info.colorIndex >= 0) meta.push(methodTag(t.method));
    if (t.accountId && accountName(t.accountId)) meta.push(`<span>${esc(accountName(t.accountId))}</span>`);
    if (t.source === 'sms' || t.source === 'bank') meta.push(`<span class="tag">${t.source === 'bank' ? '은행 알림' : '문자'}</span>`);
    // 날짜는 그대로 두고 계산할 기간만 앞뒤로 옮긴다 (예: 시작일 하루 전에 들어온 월급)
    const shift = Math.trunc(Number(t.periodShift) || 0);
    if (editable) {
      const sd = S().settings.startDay;
      const own = L.getPeriod(t.date, sd);
      const short = (n) => {
        const q = L.parseISO((n ? L.shiftPeriod(own, n, sd) : own).start);
        return `${q.m}/${q.d}~`;
      };
      const shifts = [...new Set([-1, 0, 1, shift])].sort((a, b) => a - b);
      meta.push(`<select class="tx-move" data-id="${esc(t.id)}" aria-label="계산할 기간">
        ${shifts.map((n) => `<option value="${n}" ${n === shift ? 'selected' : ''}>${n === 0 ? `실제 날짜 기간(${short(0)})` : `${short(n)} 기간으로 옮김`}</option>`).join('')}
      </select>`);
    } else if (shift) {
      meta.push(`<span class="tag">${shift > 0 ? '다음' : '이전'} 기간으로 옮김</span>`);
    }
    return `
      <div class="tx">
        ${icon}
        <div class="tx-main">
          <div class="tx-memo">${esc(t.memo)}</div>
          <div class="tx-meta">${meta.join('')}</div>
        </div>
        <div class="tx-right">
          ${amount}
          ${editable ? `<button class="link-btn tx-del" data-id="${esc(t.id)}" aria-label="삭제">삭제</button>` : ''}
        </div>
      </div>`;
  }

  // 날짜별로 묶은 목록
  function txGroups(txs, opts) {
    const sorted = [...txs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const groups = [];
    for (const t of sorted) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== t.date) groups.push((g = { date: t.date, items: [] }));
      g.items.push(t);
    }
    return groups
      .map((g) => {
        const spent = g.items.filter((t) => L.kindOf(t) === 'expense').reduce((s, t) => s + t.amount, 0);
        return `<div class="tx-date"><span>${fmtDay(g.date)}</span><span>${spent ? `지출 ${won(spent)}` : ''}</span></div>${g.items.map((t) => txRow(t, opts)).join('')}`;
      })
      .join('');
  }

  function bindTxEvents(container) {
    container.querySelectorAll('.tx-cat').forEach((s) => s.addEventListener('change', quiet(async () => {
      const t = S().transactions.find((x) => x.id === s.dataset.id);
      if (s.value.startsWith('kind:')) {
        await busy(null, () => store.updateTransaction(t.id, { kind: s.value.slice(5), categoryId: null, method: null }));
        render();
        return;
      }
      // 이 내역 하나만 바꾼다. 같은 가맹점·상대를 계속 같은 항목으로 넣으려면 설정 → 자동 분류 규칙에서 따로 만든다.
      await busy(null, () => store.updateTransaction(t.id, { kind: 'expense', categoryId: s.value || null, method: s.value ? 'manual' : null }));
      toast(`이 내역만 ${categoryInfo(s.value || null, planForTx(t).categories).name}(으)로 바꿨어요.`);
      render();
    })));
    container.querySelectorAll('.tx-move').forEach((s) => s.addEventListener('change', quiet(async () => {
      const t = S().transactions.find((x) => x.id === s.dataset.id);
      const n = Math.trunc(Number(s.value) || 0);
      await busy(null, () => store.updateTransaction(t.id, { periodShift: n }));
      const p = L.txPeriod(t, S().settings.startDay);
      toast(n ? `날짜는 그대로 두고 ${fmtDate(p.start)} 기간에 계산해요.` : '원래 날짜의 기간으로 되돌렸어요.');
      render();
    })));
    container.querySelectorAll('.tx-del').forEach((b) => b.addEventListener('click', quiet(async () => {
      const t = S().transactions.find((x) => x.id === b.dataset.id);
      if (!confirm(`'${t.memo}' ${won(t.amount)} 내역을 삭제할까요?`)) return;
      await busy(null, () => store.deleteTransaction(t.id));
      render();
    })));
  }

  // ---------- 홈 ----------

  function renderIncomeBox(sum) {
    const box = $('#income-box');
    const prev = L.shiftPeriod(currentPeriod, -1, S().settings.startDay);
    const prevIncome = S().incomes[prev.key];

    if (!sum.hasIncome || box.dataset.editing === '1') {
      box.classList.add('income-prompt');
      const received = sum.incomeReceived > 0 ? `<button type="button" class="ghost-btn" id="income-received">받은 입금 합계로 (${won(sum.incomeReceived)})</button>` : '';
      box.innerHTML = `
        <h2>${sum.hasIncome ? '당기 수입(예산) 수정' : '이번 기간에 들어온 돈(예산)을 입력하세요'}</h2>
        <p class="muted small">${fmtDate(currentPeriod.start)} 에 시작하는 기간의 수입입니다. 비율 항목의 한도가 이 금액에 맞춰 계산됩니다.</p>
        <form class="income-form" id="income-form">
          <input type="text" inputmode="numeric" id="income-input" placeholder="예: 3,000,000" value="${sum.hasIncome ? sum.income.toLocaleString('ko-KR') : ''}">
          <button type="submit" class="primary-btn">저장</button>
          ${typeof prevIncome === 'number' ? `<button type="button" class="ghost-btn" id="income-prev">지난 기간과 같게 (${won(prevIncome)})</button>` : ''}
          ${received}
          ${sum.hasIncome ? '<button type="button" class="ghost-btn" id="income-cancel">취소</button>' : ''}
        </form>`;
      const input = $('#income-input');
      formatOnBlur(input);
      $('#income-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const n = parseAmountInput(input.value);
        if (n === null || n < 0) return toast('금액을 숫자로 입력해 주세요.');
        setIncome(n);
      });
      const bind = (id, fn) => $(id) && $(id).addEventListener('click', fn);
      bind('#income-prev', () => setIncome(prevIncome));
      bind('#income-received', () => setIncome(sum.incomeReceived));
      bind('#income-cancel', () => {
        box.dataset.editing = '';
        render();
      });
    } else {
      box.classList.remove('income-prompt');
      box.innerHTML = `
        <div class="income-set">
          <div><span class="muted small">당기 수입(예산)</span><div class="value">${won(sum.income)}</div></div>
          <button class="ghost-btn small-btn" id="income-edit">수정</button>
        </div>`;
      $('#income-edit').addEventListener('click', () => {
        box.dataset.editing = '1';
        render();
      });
    }
  }

  function setIncome(n) {
    S().incomes[currentPeriod.key] = n;
    store.saveMeta();
    $('#income-box').dataset.editing = '';
    toast('당기 수입을 저장했습니다.');
    render();
  }

  function renderStaleBox(sum) {
    const box = $('#stale-box');
    if (!sum.staleCount || !sum.plan.updatedAt) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="card note-card warn-card">
        <b>예산 계획이 바뀌었어요.</b>
        <p class="small">바뀐 계획에 맞춰 아직 다시 분류하지 않은 지출이 ${sum.staleCount}건 있어요. 직접 고른 항목은 그대로 두고 나머지를 새 항목 기준으로 분류합니다.</p>
        <button id="stale-reclassify" class="primary-btn">새 계획으로 다시 분류${store.aiEnabled ? ' (AI)' : ''}</button>
      </div>`;
    $('#stale-reclassify').addEventListener('click', quiet(() => runReclassify(false)));
  }

  // 고정 항목 합계가 이번 기간 수입보다 클 때 알림
  function renderFixedBox(sum) {
    const box = $('#fixed-box');
    if (!sum.hasIncome || !sum.fixedOver) {
      box.innerHTML = '';
      return;
    }
    const pct = Math.round(sum.fixedScale * 100);
    box.innerHTML = `
      <div class="card note-card warn-card">
        <b>고정 항목 합계가 수입보다 ${won(sum.fixedOver)} 많아요.</b>
        <p class="small">고정 항목 ${won(sum.fixedTotal)} · 이번 기간 수입 ${won(sum.income)}.
        ${sum.fixedScaled
          ? `계획 설정에 따라 고정 항목 한도를 정한 금액의 약 ${pct}%로 줄여 수입에 맞췄어요.`
          : '정한 금액 그대로 두었기 때문에 계획이 수입을 넘어요. 고정 금액을 고치거나, 계획에서 <b>비율대로 줄이기</b>를 고를 수 있어요.'}
        ${sum.ratioPercentTotal > 0 && sum.plan.ratioBase === 'afterFixed' ? ' 고정 항목을 빼고 남는 돈이 없어 비율 항목 한도는 0원이에요.' : ''}</p>
        <button class="ghost-btn" data-goto="plan">계획 보기</button>
      </div>`;
    box.querySelector('[data-goto]').addEventListener('click', () => showPage('plan'));
  }

  // 페이 머니로 옮긴 돈은 있는데 그 기간 페이 결제내역이 없으면 가져오라고 알린다
  function renderPayBox() {
    const box = $('#pay-box');
    const doubles = L.payDoubleCounts(S());
    const missing = L.payFlows(S(), currentPeriod).filter((f) => f.topup > 0 && !f.count);
    box.innerHTML = doubles.map((d, i) => `
      <div class="card note-card warn-card">
        <b>${esc(d.payName)} 출금 ${d.txs.length}건${d.total ? `(${won(d.total)})` : ''}이 결제내역과 이중으로 계산되고 있어요.</b>
        <p class="small">은행에서 ${esc(d.payName)}(으)로 빠져나간 돈은 페이 머니 충전이고, 실제 지출은 ${esc(d.payName)} 결제내역으로 이미 세고 있어요. 충전 쪽을 '내 계좌 이체'으로 바꾸면 중복이 없어집니다.${d.needsType ? ` ('${esc(d.account.name)}'의 종류도 간편결제 머니로 바꿉니다)` : ''}</p>
        <button class="primary-btn" data-fix="${i}">충전으로 바꿔서 중복 없애기</button>
      </div>`).join('') + missing.map((f) => `
      <div class="card note-card warn-card">
        <b>${esc(accountName(f.account.id))}로 옮긴 돈 ${won(f.topup)}의 결제내역이 아직 없어요.</b>
        <p class="small">은행 내역의 ${esc(f.account.payName || f.account.name)} 출금은 충전이라 지출로 세지 않아요. 실제로 무엇을 샀는지는 ${esc(f.account.payName || f.account.name)} 결제내역을 가져와야 지출에 들어가요.</p>
        <button class="ghost-btn" data-goto="add">결제내역 가져오기</button>
      </div>`).join('');
    box.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage('add')));
    box.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', quiet(async () => {
      const d = doubles[Number(b.dataset.fix)];
      if (d.needsType) {
        Object.assign(d.account, { type: 'pay', payName: d.payName, isSavings: false });
        store.saveMeta();
      }
      await busy(`정리하는 중… (${d.txs.length}건)`, async () => {
        for (const t of d.txs) await store.updateTransaction(t.id, { kind: 'transfer', categoryId: null, method: null });
      });
      toast(`${d.txs.length}건을 충전(내 계좌 이체)으로 바꿨어요. 이제 지출은 결제내역으로만 셉니다.`);
      render();
    })));
  }

  // 포스터 머리줄: VOL(월) ✦ 기간 ✦ D-day, 그리고 반짝이 장식
  function heroMeta(isCurrent, daysLeft) {
    const p = currentPeriod;
    const s = L.parseISO(p.start);
    const e = L.parseISO(p.end);
    const pad = (n) => String(n).padStart(2, '0');
    const parts = [`VOL.${pad(s.m)}`, `${s.y}.${pad(s.m)}.${pad(s.d)} — ${pad(e.m)}.${pad(e.d)}`];
    if (isCurrent) parts.push(`D-${daysLeft}`);
    return `<div class="hero-meta">${parts.map(esc).join(' <span>✦</span> ')}</div>`;
  }

  function renderHome() {
    const sum = L.summarizePeriod(S(), currentPeriod);
    renderIncomeBox(sum);
    renderStaleBox(sum);
    renderFixedBox(sum);
    renderPayBox();

    const today = L.todayISO();
    const isCurrent = today >= currentPeriod.start && today <= currentPeriod.end;
    const daysLeft = isCurrent ? L.diffDays(today, currentPeriod.end) + 1 : 0;
    const hero = $('#hero');
    if (sum.hasIncome) {
      const ratio = sum.income > 0 ? sum.totalSpent / sum.income : sum.totalSpent > 0 ? Infinity : 0;
      const status = L.statusOf(ratio);
      hero.innerHTML = `
        ${heroMeta(isCurrent, daysLeft)}
        <div class="label">LEFT TO SPEND</div>
        <div class="figure ${sum.remaining < 0 ? 'negative' : ''}">${won(sum.remaining)}</div>
        <div class="sub">${won(sum.income)} 중 ${won(sum.totalSpent)} 사용 (${sum.income > 0 ? Math.round(ratio * 100) : 0}%)</div>
        <div class="meter ${status}" role="meter" aria-valuemin="0" aria-valuemax="${sum.income}" aria-valuenow="${sum.totalSpent}" aria-label="예산 사용"><div class="meter-fill" style="width:${Math.min(100, ratio * 100)}%"></div></div>`;
    } else {
      hero.innerHTML = `
        ${heroMeta(isCurrent, daysLeft)}
        <div class="label">SPENT THIS PERIOD</div>
        <div class="figure">${won(sum.totalSpent)}</div>
        <div class="sub">수입을 입력하면 항목별 한도와 남은 돈을 계산해 드려요.</div>`;
    }

    const perDay = isCurrent && sum.hasIncome && sum.remaining > 0 ? won(Math.floor(sum.remaining / daysLeft)) : '—';
    $('#home-summary').innerHTML = `
      <div class="kv"><span class="k">이번 기간 지출</span><span class="v">${won(sum.totalSpent)} · ${sum.transactions.length}건</span></div>
      <div class="kv"><span class="k">받은 입금</span><span class="v plus">${sum.incomeReceived ? `+${won(sum.incomeReceived)}` : '—'}</span></div>
      <div class="kv"><span class="k">하루 권장 사용액</span><span class="v">${perDay}</span></div>
      <div class="kv"><span class="k">미분류</span><span class="v">${sum.unclassifiedCount ? `${won(sum.unclassified)} · ${sum.unclassifiedCount}건` : '없음'}</span></div>`;

    let note = '';
    if (sum.hasIncome) {
      if (sum.unallocated > 0) note = `배분되지 않은 돈 ${won(sum.unallocated)}`;
      else if (sum.unallocated < 0) note = `⚠ 계획이 수입보다 ${won(-sum.unallocated)} 많아요`;
    }
    $('#alloc-note').textContent = note;

    const rowsEl = $('#category-rows');
    if (!sum.plan.categories.length) {
      rowsEl.innerHTML = '<div class="empty">예산 계획에서 항목을 추가하세요.</div>';
    } else {
      const rows = sum.rows.map((r, i) => categoryRow(r, i, sum.hasIncome));
      if (sum.unclassifiedCount) {
        rows.push(`
          <div class="cat-row" data-cat="__none">
            <div class="cat-top">
              <span class="cat-name"><span class="dot" style="background:var(--gray-mark)"></span>미분류<span class="badge">눌러서 정리하기</span></span>
              <span class="cat-amounts"><b>${won(sum.unclassified)}</b> · ${sum.unclassifiedCount}건</span>
            </div>
          </div>`);
      }
      rowsEl.innerHTML = rows.join('');
      rowsEl.querySelectorAll('.cat-row').forEach((el) => {
        el.addEventListener('click', () => {
          if (el.dataset.cat === '__none') return showPage('sort', { keepPeriod: true });
          Object.assign(listState, { category: el.dataset.cat, kind: 'all', account: 'all', search: '' });
          showPage('list');
        });
        const r = sum.rows.find((x) => x.category.id === el.dataset.cat);
        if (r) attachTooltip(el.querySelector('.meter'), () => `
          <strong>${esc(r.category.name)}</strong>
          <div class="t-row"><span>한도</span><span>${won(r.budget)}</span></div>
          <div class="t-row"><span>사용</span><span>${won(r.spent)}</span></div>
          <div class="t-row"><span>${r.remaining >= 0 ? '남음' : '초과'}</span><span>${won(Math.abs(r.remaining))}</span></div>
          <div class="t-row"><span>건수</span><span>${r.count}건</span></div>`);
      });
    }

    const recent = [...sum.allTransactions].sort((a, b) => (a.date + (a.createdAt || '') < b.date + (b.createdAt || '') ? 1 : -1)).slice(0, 5);
    $('#recent-list').innerHTML = recent.length ? recent.map((t) => txRow(t, { editable: false })).join('') : '<div class="empty">이 기간 내역이 없습니다.</div>';

    const assets = L.assetSummary(S(), currentPeriod);
    $('#home-assets').innerHTML = assets.banks.length || assets.cards.length
      ? `<div class="kv"><span class="k">계좌 잔액 합계</span><span class="v">${won(assets.total)}</span></div>
         ${assets.savings ? `<div class="kv"><span class="k">그중 저축</span><span class="v">${won(assets.savings)}</span></div>` : ''}
         ${assets.cards.map((c) => `<div class="kv"><span class="k">${esc(accountName(c.id))} (이번 기간)</span><span class="v">${won(c.spent)}</span></div>`).join('')}`
      : '<div class="empty">설정에서 계좌·카드를 등록하면 잔액과 카드별 사용액을 보여드려요.</div>';
  }

  function categoryRow(r, index, hasIncome) {
    const c = r.category;
    const badge = c.type === 'fixed' ? `고정 ${won(c.value)}` : `수입의 ${c.value}%`;
    const status = L.statusOf(r.ratio);
    const pct = r.budget > 0 ? Math.round(r.ratio * 100) : null;
    const width = r.budget > 0 ? Math.min(100, r.ratio * 100) : r.spent > 0 ? 100 : 0;
    const noBudget = c.type === 'ratio' && !hasIncome;

    let statusText;
    if (noBudget) statusText = '수입 입력 전';
    else if (status === 'critical') statusText = `⚠ 초과 ${pct === null ? '' : `(${pct}%)`}`;
    else if (status === 'warning') statusText = pct === 100 ? '한도 도달 100%' : `! 주의 ${pct}%`;
    else statusText = pct === null ? '' : `${pct}% 사용`;

    const remain = noBudget
      ? ''
      : r.remaining >= 0
        ? `<span class="remain-good">${won(r.remaining)} 남음</span>`
        : `<span class="remain-bad">${won(-r.remaining)} 초과</span>`;

    return `
      <div class="cat-row" data-cat="${esc(c.id)}">
        <div class="cat-top">
          <span class="cat-name"><span class="dot" style="background:${C.seriesColor(index)}"></span>${esc(c.name)}<span class="badge">${esc(badge)}</span></span>
          <span class="cat-amounts"><b>${won(r.spent)}</b> / ${noBudget ? '—' : won(r.budget)}</span>
        </div>
        <div class="meter ${noBudget ? '' : status}" role="meter" aria-valuemin="0" aria-valuemax="${r.budget}" aria-valuenow="${r.spent}" aria-label="${esc(c.name)} 사용액">
          <div class="meter-fill" style="width:${width}%"></div>
        </div>
        <div class="cat-bottom">
          <span class="status ${noBudget ? '' : status}">${statusText}</span>
          ${remain}
        </div>
      </div>`;
  }

  // ---------- 달력 ----------

  function renderCalendar() {
    const p = currentPeriod;
    const sum = L.summarizePeriod(S(), p);
    // 달력은 실제 날짜 기준 (다른 기간으로 옮긴 내역도 쓴 날에 보인다)
    const dated = S().transactions.filter((t) => t.date >= p.start && t.date <= p.end);
    const days = L.dailyTotals(dated);
    const today = L.todayISO();
    if (!selectedDate || selectedDate < p.start || selectedDate > p.end) selectedDate = today >= p.start && today <= p.end ? today : p.start;

    $('#cal-summary').innerHTML = `
      <span>지출 <b>${won(sum.totalSpent)}</b></span>
      <span class="plus">입금 <b>${sum.incomeReceived ? `+${won(sum.incomeReceived)}` : '0원'}</b></span>
      ${sum.hasIncome ? `<span>남은 돈 <b>${won(sum.remaining)}</b></span>` : ''}`;

    const maxSpent = Math.max(0, ...Object.values(days).map((d) => d.spent));
    const first = L.addDays(p.start, -dowOf(p.start));
    const last = L.addDays(p.end, 6 - dowOf(p.end));
    const cells = DOW.map((w, i) => `<div class="cal-dow ${i === 0 ? 'sun' : ''}">${w}</div>`);
    for (let cursor = first; cursor <= last; cursor = L.addDays(cursor, 1)) {
      const inPeriod = cursor >= p.start && cursor <= p.end;
      const info = days[cursor] || { spent: 0, income: 0 };
      const q = L.parseISO(cursor);
      const label = q.d === 1 || cursor === p.start ? `${q.m}/${q.d}` : q.d;
      let heat = '';
      if (inPeriod && info.spent > 0 && maxSpent > 0) heat = `h${Math.min(3, Math.ceil((info.spent / maxSpent) * 3))}`;
      cells.push(inPeriod
        ? `<button class="cal-day ${heat} ${cursor === today ? 'today' : ''} ${cursor === selectedDate ? 'selected' : ''}" data-date="${cursor}" aria-label="${fmtDay(cursor)} 지출 ${won(info.spent)}">
             <span class="cal-num">${label}</span>
             ${info.spent ? `<span class="cal-spent">-${C.tinyWon(info.spent)}</span>` : ''}
             ${info.income ? `<span class="cal-income">+${C.tinyWon(info.income)}</span>` : ''}
           </button>`
        : `<div class="cal-day out"><span class="cal-num">${label}</span></div>`);
    }
    const cal = $('#calendar');
    cal.innerHTML = cells.join('');
    cal.querySelectorAll('.cal-day[data-date]').forEach((b) => b.addEventListener('click', () => {
      selectedDate = b.dataset.date;
      renderCalendar();
    }));

    const dayTxs = dated.filter((t) => t.date === selectedDate);
    $('#day-title').textContent = fmtDay(selectedDate);
    const info = days[selectedDate];
    $('#day-total').textContent = info ? `지출 ${won(info.spent)}${info.income ? ` · 입금 ${won(info.income)}` : ''}` : '';
    const list = $('#day-list');
    list.innerHTML = dayTxs.length ? dayTxs.map((t) => txRow(t)).join('') : '<div class="empty">이날은 내역이 없어요.</div>';
    bindTxEvents(list);
  }

  // ---------- 내역 ----------

  function renderList() {
    const sum = L.summarizePeriod(S(), currentPeriod);
    const cats = sum.plan.categories;
    const known = new Set(cats.map((c) => c.id));
    if (listState.category !== 'all' && listState.category !== '__none' && !known.has(listState.category)) listState.category = 'all';

    $('#list-filter').innerHTML = `<option value="all">모든 항목</option><option value="__none">미분류</option>` +
      cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#list-filter').value = listState.category;
    $('#list-account').innerHTML = `<option value="all">모든 결제수단</option>` +
      S().accounts.map((a) => `<option value="${esc(a.id)}">${esc(accountName(a.id))}</option>`).join('');
    $('#list-account').value = S().accounts.some((a) => a.id === listState.account) ? listState.account : 'all';
    $('#list-kind').value = listState.kind;
    $('#list-search').value = listState.search;
    $('#reclassify-all').textContent = `이 기간 전체 다시 분류${store.aiEnabled ? ' (AI)' : ''}`;

    const q = L.normalizeMerchant(listState.search);
    const txs = sum.allTransactions.filter((t) => {
      const kind = L.kindOf(t);
      if (listState.kind !== 'all' && kind !== listState.kind) return false;
      if (listState.category === '__none' && (kind !== 'expense' || known.has(t.categoryId))) return false;
      if (listState.category !== 'all' && listState.category !== '__none' && t.categoryId !== listState.category) return false;
      if (listState.account !== 'all' && t.accountId !== listState.account) return false;
      if (q && !L.normalizeMerchant(t.memo).includes(q)) return false;
      return true;
    });

    const spent = txs.filter((t) => L.kindOf(t) === 'expense').reduce((s, t) => s + t.amount, 0);
    const inc = txs.filter((t) => L.kindOf(t) === 'income').reduce((s, t) => s + t.amount, 0);
    $('#list-total').innerHTML = `<span>${txs.length}건</span><span>지출 <b>${won(spent)}</b></span>${inc ? `<span>입금 <b>+${won(inc)}</b></span>` : ''}`;

    const el = $('#tx-list');
    el.innerHTML = txs.length ? txGroups(txs) : '<div class="empty">조건에 맞는 내역이 없습니다.</div>';
    bindTxEvents(el);
  }

  // ---------- 미분류 정리 ----------

  function renderSort() {
    const groups = L.unclassifiedGroups(S(), currentPeriod);
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    const total = groups.reduce((n, g) => n + g.total, 0);
    $('#sort-title').textContent = '이 기간 미분류';
    $('#sort-total').textContent = count ? `${count}건 · ${won(total)}` : '';

    // 다른 기간에 남은 미분류: 눌러서 그 기간으로 이동
    const others = L.unclassifiedByPeriod(S()).filter((e) => e.period.key !== currentPeriod.key);
    const otherEl = $('#sort-others');
    otherEl.innerHTML = others.length
      ? `<span class="muted small">다른 기간에도 남아 있어요:</span> ${others.map((e) => `<button class="pick-btn" data-period="${esc(e.period.key)}">${esc(periodLabel(e.period))} · ${e.count}건</button>`).join('')}`
      : '';
    otherEl.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
      const e = others.find((x) => x.period.key === b.dataset.period);
      currentPeriod = e.period;
      render();
      window.scrollTo(0, 0);
    }));

    const el = $('#sort-groups');
    if (!groups.length) {
      el.innerHTML = `<div class="card"><div class="empty">이 기간에는 미분류 지출이 없어요.${others.length ? ' 위에서 다른 기간을 골라 정리하세요.' : ' 모두 정리됐어요.'}</div></div>`;
      return;
    }
    el.innerHTML = groups.map((g, gi) => {
      const cats = planForTx(g.items[0]).categories;
      const days = [...new Set(g.items.map((t) => t.date))];
      const dates = days.slice(0, 3).map(fmtDay).join(', ') + (days.length > 3 ? ` 외 ${days.length - 3}일` : '');
      const raw = g.items.find((t) => t.raw)?.raw;
      return `
        <div class="card sort-group" data-g="${gi}">
          <div class="sort-head">
            <span class="sort-memo">${esc(g.memo)}</span>
            <span class="sort-sum"><b>${won(g.total)}</b>${g.items.length > 1 ? ` · ${g.items.length}건` : ''}</span>
          </div>
          <div class="sort-dates">${esc(dates)}${g.items[0].accountId && accountName(g.items[0].accountId) ? ` · ${esc(accountName(g.items[0].accountId))}` : ''}</div>
          ${raw ? `<div class="sort-raw">${esc(raw)}</div>` : ''}
          <div class="pick-row">
            ${cats.map((c, i) => `<button class="pick-btn" data-cat="${esc(c.id)}"><span class="dot" style="background:${C.seriesColor(i)}"></span>${esc(c.name)}</button>`).join('')}
            <button class="pick-btn other" data-kind="transfer">내 계좌 이체</button>
            <button class="pick-btn other" data-kind="income">입금</button>
          </div>
          ${g.items.length > 1 ? `<details><summary>하나씩 따로 고르기</summary><div class="tx-list">${g.items.map((t) => txRow(t)).join('')}</div></details>` : ''}
        </div>`;
    }).join('');

    el.querySelectorAll('.sort-group').forEach((card) => {
      const g = groups[Number(card.dataset.g)];
      card.querySelectorAll('.pick-btn').forEach((b) => b.addEventListener('click', quiet(() => assignGroup(g, b.dataset.cat, b.dataset.kind))));
      bindTxEvents(card);
    });
  }

  async function assignGroup(g, categoryId, kind) {
    const learn = $('#sort-learn').checked;
    if (categoryId && learn) {
      S().merchantMap[g.key] = categoryId;
      store.saveMeta();
    }
    let done = 0;
    await busy(g.items.length > 3 ? '정리하는 중…' : null, async () => {
      for (const t of g.items) {
        if (kind) {
          await store.updateTransaction(t.id, { kind, categoryId: null, method: null });
          done += 1;
        } else if (planForTx(t).categories.some((c) => c.id === categoryId)) {
          // 그 날짜의 계획에 없는 항목이면 건너뛴다 (지난 기간 계획과 항목이 다를 수 있음)
          await store.updateTransaction(t.id, { kind: 'expense', categoryId, method: 'manual' });
          done += 1;
        }
      }
    });
    const what = kind === 'transfer' ? '내 계좌 이체' : kind === 'income' ? '입금' : categoryInfo(categoryId, planForTx(g.items[0]).categories).name;
    const skipped = g.items.length - done;
    toast(`'${g.memo}' ${done}건을 ${what}(으)로 정리했어요.` +
      (skipped ? ` (${skipped}건은 그때 계획에 이 항목이 없어 남겨 뒀어요)` : '') +
      (categoryId && learn ? ' 자동 분류 규칙도 만들었어요.' : ''));
    render();
  }

  // 모든 기간의 카카오페이 출금(충전)을 한 번에 '내 계좌 이체'로 바꾼다.
  // 다음부터 자동으로 되도록 카카오페이를 간편결제 머니로 등록(없으면 새로 추가)한다.
  async function fixPayTopups() {
    const c = L.payTopupCandidates(S());
    if (!c.txs.length) return toast(`'${c.payName}'(으)로 찍힌 지출·입금이 없어요. 이미 모두 내 계좌 이체예요.`);
    const total = c.txs.filter((t) => L.kindOf(t) === 'expense').reduce((s, t) => s + t.amount, 0);
    if (!confirm(`'${c.payName}'(으)로 빠져나간 내역 ${c.txs.length}건(${won(total)})을 모두 '내 계좌 이체'로 바꿀까요? 지출에서 빠지고, 카카오페이 결제내역으로만 지출을 셉니다.`)) return;
    if (!c.account) {
      S().accounts.push({ id: `a-${uid()}`, name: '카카오페이', type: 'pay', payName: c.payName, last4: '', isSavings: false, balance: null, balanceAt: '' });
    } else if (c.needsType) {
      Object.assign(c.account, { type: 'pay', payName: c.payName, isSavings: false });
    }
    store.saveMeta();
    await busy(`바꾸는 중… (${c.txs.length}건)`, async () => {
      for (const t of c.txs) await store.updateTransaction(t.id, { kind: 'transfer', categoryId: null, method: null });
    });
    toast(`${c.txs.length}건을 내 계좌 이체로 바꿨어요. 앞으로 들어오는 카카오페이 출금도 자동으로 내 계좌 이체가 돼요.`);
    render();
  }

  async function runReclassify(onlyUnclassified) {
    const label = store.aiEnabled ? 'AI가 다시 분류하는 중…' : '다시 분류하는 중…';
    const n = await busy(label, () => store.reclassify(currentPeriod, onlyUnclassified));
    toast(n ? `${n}건을 다시 분류했습니다.` : '다시 분류할 지출이 없습니다.');
    render();
  }

  // ---------- 리포트 ----------

  function periodLabel(p) {
    const { m, d } = L.parseISO(p.start);
    return S().settings.startDay === 1 ? `${m}월` : `${m}/${d}`;
  }

  function renderReport() {
    const cmp = L.compareWithPrevious(S(), currentPeriod);
    const sum = cmp.current;
    const diff = cmp.totalDiff;
    const prevSpent = cmp.previous.totalSpent;
    let deltaText;
    if (!prevSpent && !sum.totalSpent) deltaText = '아직 지출이 없어요.';
    else if (!prevSpent) deltaText = '지난 기간 기록이 없어 비교할 수 없어요.';
    else if (diff > 0) deltaText = `지난 기간보다 <b>${won(diff)} 더</b> 썼어요 ▲`;
    else if (diff < 0) deltaText = `지난 기간보다 <b>${won(-diff)} 덜</b> 썼어요 ▼`;
    else deltaText = '지난 기간과 똑같이 썼어요.';
    const budgetLine = sum.hasIncome && sum.income > 0 ? `<div class="delta">예산의 <b>${Math.round((sum.totalSpent / sum.income) * 100)}%</b> 사용</div>` : '';
    $('#report-headline').innerHTML = `
      <div class="muted small">이번 기간 지출</div>
      <div class="headline-figure">${won(sum.totalSpent)}</div>
      <div class="delta">${deltaText}</div>
      ${budgetLine}`;

    const top = L.topMerchants(sum.allTransactions, 5);
    $('#report-merchants').innerHTML = `<h2>많이 쓴 곳</h2>${top.length
      ? top.map((m, i) => `<div class="rank"><span class="n">${i + 1}</span><span class="m">${esc(m.memo)} <span class="muted small">${m.count}회</span></span><span class="a">${won(m.total)}</span></div>`).join('')
      : '<div class="empty">지출이 없어요.</div>'}`;

    const rows = L.categoryBreakdown(sum);
    const diffById = {};
    for (const r of cmp.rows) diffById[r.id] = r.diff;
    const share = $('#report-share');
    if (!rows.length) {
      share.innerHTML = '<div class="empty">이 기간 지출이 없어요.</div>';
    } else {
      const fmtDiff = (d) => (d === undefined ? '' : d > 0 ? `▲ ${won(d)}` : d < 0 ? `▼ ${won(-d)}` : '변동 없음');
      share.innerHTML = C.shareBar(rows) + rows.map((r) => `
        <div class="share-row">
          <span class="share-name"><span class="dot" style="background:${C.seriesColor(r.colorIndex)}"></span><span>${esc(r.name)} <span class="muted small">${Math.round(r.share * 100)}%</span></span></span>
          <span class="share-amount">${won(r.amount)}</span>
          <span class="share-diff" title="지난 기간 대비">${fmtDiff(diffById[r.id])}</span>
        </div>`).join('');
      const segs = C.shareSegments(rows);
      share.querySelectorAll('[data-seg]').forEach((el) => {
        const s = segs[el.dataset.seg];
        attachTooltip(el, () => `<div class="t-row"><span><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span><span>${won(s.amount)}</span></div>`);
      });
    }

    const tr = L.trend(S(), currentPeriod, 6);
    const data = tr.map((x) => ({ label: periodLabel(x.period), income: x.budgetIncome !== null ? x.budgetIncome : x.incomeReceived, spent: x.spent }));
    const trendEl = $('#report-trend');
    trendEl.innerHTML = `
      <div class="legend"><span><span class="dot" style="background:var(--s1)"></span>수입</span><span><span class="dot" style="background:var(--s2)"></span>지출</span></div>
      <div class="chart">${C.trendChart(data)}</div>`;
    trendEl.querySelectorAll('.hit').forEach((el) => {
      const i = Number(el.dataset.i);
      const x = tr[i];
      attachTooltip(el, () => `
        <strong>${fmtDate(x.period.start)} ~</strong>
        <div class="t-row"><span><span class="dot" style="background:var(--s1)"></span>수입${x.budgetIncome === null ? ' (받은 입금)' : ''}</span><span>${won(data[i].income || 0)}</span></div>
        <div class="t-row"><span><span class="dot" style="background:var(--s2)"></span>지출</span><span>${won(x.spent)}</span></div>`);
      el.addEventListener('click', () => {
        currentPeriod = x.period;
        render();
      });
    });
  }

  // ---------- 자산 ----------

  function payFlowText(id) {
    const f = L.payFlows(S(), currentPeriod).find((x) => x.account.id === id);
    return `간편결제 머니 · 이번 기간 충전 ${won(f ? f.topup : 0)} · 결제 ${won(f ? f.spent : 0)}${f && f.count ? ` (${f.count}건)` : ''}`;
  }

  function renderAssets() {
    const a = L.assetSummary(S(), currentPeriod);
    const hasBalance = a.banks.some((b) => typeof b.balance === 'number');
    $('#asset-hero').innerHTML = `
      <div class="label">TOTAL BALANCE</div>
      <div class="figure">${hasBalance ? won(a.total) : '—'}</div>
      <div class="sub">${a.savings ? `저축 계좌 ${won(a.savings)} · ` : ''}등록한 계좌 ${a.banks.length}개, 카드 ${a.cards.length}개</div>`;

    const banks = $('#asset-banks');
    banks.innerHTML = a.banks.length
      ? a.banks.map((b) => `
        <div class="acct">
          <div class="acct-icon">${esc((b.name || '계좌').slice(0, 1))}</div>
          <div><div class="acct-name">${esc(accountName(b.id))}</div><div class="acct-sub">${b.type === 'pay' ? payFlowText(b.id) : `끝자리 ${esc(b.last4 || '----')}${b.isSavings ? ' · 저축' : ''}${b.spent ? ` · 이번 기간 출금 ${won(b.spent)}` : ''}`}</div></div>
          <div class="acct-bal">${typeof b.balance === 'number' ? won(b.balance) : '<span class="muted">잔액 미입력</span>'}
            <div class="acct-sub">${b.balanceAt ? `${fmtDateTime(b.balanceAt)} 기준 ` : ''}<button class="link edit-balance" data-id="${esc(b.id)}">수정</button></div>
          </div>
        </div>`).join('')
      : '<div class="empty">등록한 계좌가 없어요. <button class="link" data-goto="settings">계좌 등록하기</button></div>';
    banks.querySelectorAll('.edit-balance').forEach((btn) => btn.addEventListener('click', () => {
      const acc = S().accounts.find((x) => x.id === btn.dataset.id);
      const v = prompt(`${accountName(acc.id)} 의 현재 잔액(원)`, typeof acc.balance === 'number' ? String(acc.balance) : '');
      if (v === null) return;
      const n = parseAmountInput(v);
      if (n === null) return toast('숫자로 입력해 주세요.');
      acc.balance = n;
      acc.balanceAt = nowISO();
      store.saveMeta();
      render();
    }));

    $('#asset-cards').innerHTML = a.cards.length
      ? a.cards.map((c) => `
        <div class="acct">
          <div class="acct-icon is-card">${esc((c.name || '카드').slice(0, 1))}</div>
          <div><div class="acct-name">${esc(accountName(c.id))}</div><div class="acct-sub">끝자리 ${esc(c.last4 || '----')}</div></div>
          <div class="acct-bal">${won(c.spent)}</div>
        </div>`).join('') + (a.unlinkedSpent ? `<div class="acct"><div class="acct-icon is-card">?</div><div><div class="acct-name">결제수단 모름</div><div class="acct-sub">알림에서 카드·계좌를 찾지 못한 지출</div></div><div class="acct-bal">${won(a.unlinkedSpent)}</div></div>` : '')
      : '<div class="empty">등록한 카드가 없어요.</div>';
    $$('#asset-banks [data-goto], #asset-cards [data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));
  }

  // ---------- 예산 계획 ----------

  // 이 기간의 계획을 고치기 전에 호출: 지난 기간 계획을 물려받고 있었다면 이 기간부터 적용되는 새 계획을 만든다.
  // 한도 계산 방식만 바꿀 때: 분류와 상관없으니 '다시 분류' 안내가 뜨지 않게 수정 시각을 그대로 둔다
  function budgetPlan() {
    const before = currentPlan();
    const plan = L.ensurePlanFor(S(), currentPeriod.key, nowISO());
    if (plan !== before) plan.updatedAt = before.updatedAt;
    return plan;
  }

  function editablePlan() {
    const plan = L.ensurePlanFor(S(), currentPeriod.key, nowISO());
    plan.updatedAt = nowISO();
    return plan;
  }

  function renderPlanVersion() {
    const plan = currentPlan();
    const inherited = plan.from !== currentPeriod.key;
    const next = L.nextPlanAfter(S(), { from: currentPeriod.key });
    const parts = [`<b>${fmtDate(currentPeriod.start)} 기간의 계획</b>`];
    parts.push(plan.from === L.BASE_PLAN_FROM ? '처음부터 쓰던 계획입니다.' : `${fmtDate(plan.from)} 기간부터 적용된 계획입니다.`);
    parts.push(inherited
      ? '여기서 고치면 <b>이번 기간부터</b> 새 계획으로 저장되고, 지난 기간은 그때 계획 그대로 남아요.'
      : '고치면 이 기간과 이후 기간에 적용되고, 지난 기간은 그대로 남아요.');
    if (next) parts.push(`${fmtDate(next.from)} 기간부터는 그 뒤에 바꾼 계획이 적용돼요.`);
    $('#plan-version').innerHTML = parts.map((x) => `<div class="small">${x}</div>`).join('');
  }

  function renderPlan() {
    renderPlanVersion();
    const plan = currentPlan();
    $('#ratio-base').value = plan.ratioBase;
    $('#fixed-overflow').value = plan.fixedOverflow || 'warn';

    const rowsEl = $('#plan-rows');
    rowsEl.innerHTML = `
      <div class="plan-row head"><span>항목 이름</span><span>방식</span><span>비율 / 금액</span><span>설명 (AI 참고)</span><span>키워드</span><span></span></div>
      ${plan.categories.map((c) => `
        <div class="plan-row" data-id="${esc(c.id)}">
          <input type="text" class="pl-name" value="${esc(c.name)}" aria-label="항목 이름">
          <select class="pl-type" aria-label="방식">
            <option value="ratio" ${c.type === 'ratio' ? 'selected' : ''}>수입 비례(%)</option>
            <option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>고정 금액</option>
          </select>
          <div class="value-wrap">
            <input type="text" inputmode="decimal" class="pl-value" value="${c.type === 'fixed' ? Number(c.value).toLocaleString('ko-KR') : c.value}" aria-label="값">
            <span class="unit">${c.type === 'fixed' ? '원' : '%'}</span>
          </div>
          <input type="text" class="pl-desc" value="${esc(c.description || '')}" placeholder="예: 외식, 배달, 장보기" aria-label="설명">
          <input type="text" class="pl-kw" value="${esc((c.keywords || []).join(', '))}" placeholder="예: 스타벅스, 카페" aria-label="키워드">
          <button class="link-btn pl-del" aria-label="${esc(c.name)} 삭제">✕</button>
          <div class="preview"></div>
        </div>`).join('')}`;

    const edit = (id, fn, rerender) => {
      const c = editablePlan().categories.find((x) => x.id === id);
      fn(c);
      store.saveMeta();
      if (rerender) renderPlan();
      else {
        renderPlanVersion();
        renderPlanSummary();
      }
    };

    rowsEl.querySelectorAll('.plan-row[data-id]').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.pl-name').addEventListener('change', (e) => edit(id, (c) => (c.name = e.target.value.trim() || '이름 없음')));
      row.querySelector('.pl-type').addEventListener('change', (e) => edit(id, (c) => {
        c.type = e.target.value;
        c.value = 0;
      }, true));
      row.querySelector('.pl-value').addEventListener('change', (e) => edit(id, (c) => {
        const n = Number(e.target.value.replace(/[^\d.]/g, '')) || 0;
        c.value = c.type === 'fixed' ? Math.round(n) : Math.round(n * 100) / 100;
        if (c.type === 'fixed') e.target.value = c.value.toLocaleString('ko-KR');
      }));
      row.querySelector('.pl-desc').addEventListener('change', (e) => edit(id, (c) => (c.description = e.target.value.trim())));
      row.querySelector('.pl-kw').addEventListener('change', (e) => edit(id, (c) => {
        c.keywords = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      }));
      row.querySelector('.pl-del').addEventListener('click', () => {
        const c = currentPlan().categories.find((x) => x.id === id);
        if (!confirm(`'${c.name}' 항목을 이번 기간 계획부터 뺄까요? 이 항목으로 분류된 이번 기간 지출은 다시 분류해야 합니다.`)) return;
        const p = editablePlan();
        p.categories = p.categories.filter((x) => x.id !== id);
        store.saveMeta();
        renderPlan();
      });
    });
    renderPlanSummary();
  }

  function renderPlanSummary() {
    const plan = currentPlan();
    const income = S().incomes[currentPeriod.key];
    const hasIncome = typeof income === 'number';
    const calc = L.computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase, plan.fixedOverflow);

    $$('.plan-row[data-id]').forEach((row) => {
      const c = plan.categories.find((x) => x.id === row.dataset.id);
      const p = row.querySelector('.preview');
      if (!c) return;
      if (c.type === 'fixed') {
        p.textContent = hasIncome && calc.fixedScaled
          ? `이번 기간 한도 ${won(calc.budgets[c.id])} (수입이 모자라 줄임)`
          : '수입과 상관없이 매 기간 같은 한도';
      }
      else p.textContent = hasIncome ? `이번 기간 한도 ${won(calc.budgets[c.id])}` : '당기 수입을 입력하면 한도가 계산됩니다';
    });

    const base = plan.ratioBase === 'afterFixed' ? '고정 항목을 뺀 나머지' : '전체 수입';
    const lines = [`고정 항목 합계 <b>${won(calc.fixedTotal)}</b> · 비율 항목 합계 <b>${calc.ratioPercentTotal}%</b> (${base} 기준)`];
    if (calc.ratioPercentTotal > 100) lines.push('<span class="warn">⚠ 비율 합계가 100%를 넘습니다.</span>');
    else if (calc.ratioPercentTotal < 100) lines.push(`<span class="muted">비율 합계가 100%보다 ${Math.round((100 - calc.ratioPercentTotal) * 100) / 100}% 적어 일부 수입은 배분되지 않습니다.</span>`);
    if (hasIncome) {
      lines.push(`이번 기간 수입 ${won(income)} 기준: 배분 ${won(calc.allocated)}` +
        (calc.unallocated >= 0 ? ` · 남는 돈 ${won(calc.unallocated)}` : ` · <span class="warn">${won(-calc.unallocated)} 부족</span>`));
      if (calc.fixedOver) {
        lines.push(calc.fixedScaled
          ? `<span class="warn">⚠ 고정 항목 합계가 수입보다 ${won(calc.fixedOver)} 많아, 고정 항목 한도를 약 ${Math.round(calc.fixedScale * 100)}%로 줄였습니다.</span>`
          : `<span class="warn">⚠ 고정 항목 합계가 수입보다 ${won(calc.fixedOver)} 많습니다.</span>`);
      }
    }
    $('#plan-summary').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }

  function addCategory() {
    const plan = editablePlan();
    plan.categories.push({ id: `c-${uid()}`, name: '새 항목', type: 'ratio', value: 0, description: '', keywords: [] });
    store.saveMeta();
    renderPlan();
    const inputs = $$('.pl-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }

  // ---------- 입력 ----------

  function renderAdd() {
    $('#auto-hint').innerHTML = store.mode === 'remote'
      ? '<b>카드 문자와 은행 알림은 자동으로 들어와요.</b> <span class="small">휴대폰 자동화(설정 → 자동 입력)를 해 두면 결제·이체 알림이 올 때마다 AI가 읽고 분류해서 기록합니다. 여기서는 그 밖의 내역을 넣으세요.</span>'
      : '<b>지금은 이 기기에만 저장하는 모드예요.</b> <span class="small">카드·은행 알림 자동 입력과 AI 분류를 쓰려면 설정 → 자동 입력에서 구글 시트 서버를 연결하세요.</span>';
    $('#classifier-name').textContent = store.aiEnabled ? 'AI가 항목' : '키워드로 항목';

    $$('#m-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === manualKind));
    $('#m-category-wrap').hidden = manualKind !== 'expense';
    const sel = $('#m-category');
    const prev = sel.value || '__auto';
    if (!$('#m-date').value) $('#m-date').value = L.todayISO();
    sel.innerHTML = categoryOptions(planForDate($('#m-date').value).categories, null, { includeAuto: true });
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '__auto';
    const acc = $('#m-account').value;
    $('#m-account').innerHTML = accountOptions(acc);
    const fileAcc = $('#file-account').value || (S().accounts.find((a) => a.type !== 'card') || {}).id || '';
    $('#file-account').innerHTML = accountOptions(fileAcc, '계좌 선택 안 함');
    $('#paste-account').innerHTML = accountOptions($('#paste-account').value, '결제수단 모름');
    $('#m-memo').placeholder = manualKind === 'income' ? '(주)회사 급여' : manualKind === 'transfer' ? '적금 계좌로' : '스타벅스 강남점';
    updateManualHint();
    renderParseResult();
  }

  function updateManualHint() {
    const memo = $('#m-memo').value;
    if (manualKind === 'transfer') {
      $('#m-hint').textContent = '내 계좌끼리 옮긴 돈은 지출·수입 합계에서 빠집니다. 저축 목적이면 "지출"로 넣고 저축 항목을 고르세요.';
      return;
    }
    if (manualKind !== 'expense' || $('#m-category').value !== '__auto' || !memo.trim()) {
      $('#m-hint').textContent = '';
      return;
    }
    if (store.aiEnabled) {
      $('#m-hint').textContent = '추가하면 AI가 항목을 정합니다.';
      return;
    }
    const plan = planForDate($('#m-date').value || L.todayISO());
    const r = L.classifyLocal(memo, plan.categories, S().merchantMap);
    $('#m-hint').textContent = `자동 분류 결과: ${categoryInfo(r.categoryId, plan.categories).name}`;
  }

  async function onManualSubmit(e) {
    e.preventDefault();
    const date = $('#m-date').value;
    const amount = parseAmountInput($('#m-amount').value);
    const memo = $('#m-memo').value.trim() || '(내용 없음)';
    if (!date) return toast('날짜를 입력해 주세요.');
    if (amount === null || amount === 0) return toast('금액을 입력해 주세요.');
    const sel = manualKind === 'expense' ? $('#m-category').value : '';
    const item = {
      date, amount, memo, kind: manualKind, accountId: $('#m-account').value || null, source: 'manual',
      categoryId: sel === '' ? null : sel,
      method: sel && sel !== '__auto' ? 'manual' : undefined,
    };
    const [tx] = await busy(sel === '__auto' && store.aiEnabled ? 'AI가 분류하는 중…' : null, () => store.addTransactions([item]));
    $('#m-amount').value = '';
    $('#m-memo').value = '';
    updateManualHint();
    const what = manualKind === 'expense' ? `${categoryInfo(tx.categoryId, planForDate(tx.date).categories).name} 항목에` : manualKind === 'income' ? '입금으로' : '내 계좌 이체로';
    toast(`${what} ${won(amount)} 추가했습니다.`);
    jumpToDate(date);
  }

  function jumpToDate(date) {
    const p = L.getPeriod(date, S().settings.startDay);
    if (p.key !== currentPeriod.key) currentPeriod = p;
    render();
  }

  // 붙여넣기와 파일 가져오기가 같은 미리보기를 쓴다. preview.source: 'paste' | 'file'
  const preview = { source: 'paste', items: [], skipped: [], latest: null, accountId: null, fileName: '' };

  function clearPreview() {
    Object.assign(preview, { items: [], skipped: [], latest: null, accountId: null, fileName: '' });
    renderParseResult();
  }

  // 지출만 분류한다. 서버(AI)는 여러 번에 나눠 보낸다.
  async function classifyPreview(items) {
    const expenses = items.filter((it) => it.kind === 'expense');
    const step = store.mode === 'remote' ? 60 : expenses.length || 1;
    for (let i = 0; i < expenses.length; i += step) {
      const chunk = expenses.slice(i, i + step);
      if (store.aiEnabled && expenses.length > step) toast(`AI가 분류하는 중… (${Math.min(i + step, expenses.length)}/${expenses.length})`, 60000);
      const res = await store.classify(chunk.map(({ date, amount, memo }) => ({ date, amount, memo })));
      chunk.forEach((it, k) => Object.assign(it, res[k]));
    }
  }

  function withDupFlags(items) {
    return items.map((it) => {
      const dup = !!L.findDuplicate(it, S().transactions);
      return { categoryId: null, method: null, ...it, dup, checked: !dup };
    });
  }

  async function onParse() {
    const { items, skipped } = L.parseExpenseText($('#paste-input').value, L.todayISO());
    Object.assign(preview, { source: 'paste', skipped, latest: null, accountId: null, fileName: '' });
    const pasteAcc = $('#paste-account').value || null;
    preview.items = withDupFlags(items.map((it) => {
      const x = { ...it, kind: 'expense', accountId: pasteAcc };
      L.applyPayRules(x, S().accounts);
      return x;
    }));
    if (preview.items.length) await busy(store.aiEnabled ? `AI가 ${preview.items.length}건을 분류하는 중…` : null, () => classifyPreview(preview.items));
    renderParseResult();
  }

  async function onFileChosen(file) {
    const accountId = $('#file-account').value || null;
    let rows;
    try {
      rows = await window.BudgetXlsx.readTableFile(file);
    } catch (e) {
      return toast(e.message || '파일을 읽지 못했어요.', 7000);
    }
    const fileAccount = S().accounts.find((a) => a.id === accountId);
    const parsed = L.parseStatementRows(rows, { myName: S().settings.myName, accountId, payAccount: !!fileAccount && fileAccount.type === 'pay' });
    parsed.items.forEach((it) => L.applyPayRules(it, S().accounts));
    if (!parsed.header) return toast('거래내역 표를 찾지 못했어요. 날짜와 금액 칸이 있는 은행 거래내역 파일인지 확인해 주세요.', 7000);
    Object.assign(preview, { source: 'file', skipped: [], latest: parsed.latest, accountId, fileName: file.name });
    preview.items = withDupFlags(parsed.items);
    if (parsed.skipped) preview.skipped = [`날짜를 읽지 못한 줄 ${parsed.skipped}개`];
    if (preview.items.length) {
      await busy(store.aiEnabled ? `AI가 ${preview.items.filter((x) => x.kind === 'expense').length}건을 분류하는 중…` : null, () => classifyPreview(preview.items));
    }
    renderParseResult();
  }

  const KIND_LABEL = { income: '입금', transfer: '내 계좌 이체' };

  function renderParseResult() {
    const target = preview.source === 'file' ? $('#file-result') : $('#parse-result');
    const other = preview.source === 'file' ? $('#parse-result') : $('#file-result');
    other.innerHTML = '';
    if (!preview.items.length && !preview.skipped.length) {
      target.innerHTML = '';
      return;
    }
    const items = preview.items;
    const rows = items.map((it, i) => `
      <tr>
        <td><input type="checkbox" data-i="${i}" class="p-check" ${it.checked ? 'checked' : ''} aria-label="추가"></td>
        <td><input type="date" data-i="${i}" class="p-date" value="${it.date}"></td>
        <td class="memo">${esc(it.memo)} ${it.dup ? '<span class="tag warn">중복?</span>' : ''} ${it.kind === 'expense' ? methodTag(it.method) : ''}</td>
        <td class="amount ${it.kind === 'income' || it.amount < 0 ? 'refund' : ''}">${it.kind === 'income' ? '+' : ''}${won(it.amount)}</td>
        <td>${it.kind === 'expense'
          ? `<select data-i="${i}" class="p-cat">${categoryOptions(planForDate(it.date).categories, it.categoryId)}</select>`
          : `<span class="tag">${KIND_LABEL[it.kind]}</span>`}</td>
      </tr>`).join('');
    const dups = items.filter((x) => x.dup).length;
    const dates = items.map((x) => x.date).sort();
    const summary = preview.source === 'file' && items.length
      ? `<p class="small">${esc(preview.fileName)} · ${fmtDate(dates[0])} ~ ${fmtDate(dates[dates.length - 1])} · ${items.length}건${dups ? ` (이미 있는 내역으로 보이는 ${dups}건은 빼 두었어요)` : ''}${preview.latest ? ` · 마지막 잔액 ${won(preview.latest.balance)}` : ''}</p>`
      : '';
    target.innerHTML = `
      ${summary}
      ${items.length ? `
      <div class="row-actions">
        <button class="ghost-btn small-btn" id="p-all">모두 선택</button>
        <button class="ghost-btn small-btn" id="p-none">모두 해제</button>
      </div>
      <div class="table-wrap">
        <table class="stack-table parse-table">
          <thead><tr><th></th><th>날짜</th><th>사용처</th><th class="amount">금액</th><th>항목</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="row-actions"><button id="p-add" class="primary-btn">선택한 ${items.filter((x) => x.checked).length}건 추가</button></div>` : ''}
      ${preview.skipped.length ? `<p class="muted small">건너뛴 줄 ${preview.skipped.length}개: ${preview.skipped.map(esc).join(' / ')}</p>` : ''}`;

    const setAll = (v) => {
      items.forEach((x) => (x.checked = v));
      renderParseResult();
    };
    if ($('#p-all')) $('#p-all').addEventListener('click', () => setAll(true));
    if ($('#p-none')) $('#p-none').addEventListener('click', () => setAll(false));
    target.querySelectorAll('.p-check').forEach((c) => c.addEventListener('change', () => {
      items[c.dataset.i].checked = c.checked;
      renderParseResult();
    }));
    target.querySelectorAll('.p-date').forEach((c) => c.addEventListener('change', () => (items[c.dataset.i].date = c.value)));
    target.querySelectorAll('.p-cat').forEach((c) => c.addEventListener('change', () => {
      const it = items[c.dataset.i];
      it.categoryId = c.value || null;
      it.method = c.value ? 'manual' : null;
    }));
    const addBtn = $('#p-add');
    if (addBtn) addBtn.addEventListener('click', quiet(addPreviewItems));
  }

  async function addPreviewItems() {
    const chosen = preview.items.filter((x) => x.checked && x.date);
    if (!chosen.length) return toast('추가할 내역을 선택해 주세요.');
    let changedMeta = false;
    // 파일의 마지막 잔액이 지금 알고 있는 잔액보다 최근이면 계좌 잔액을 바꾼다
    const acc = preview.accountId && S().accounts.find((a) => a.id === preview.accountId);
    if (acc && preview.latest) {
      const at = new Date(`${preview.latest.date}T${preview.latest.time || '23:59:59'}+09:00`).toISOString();
      if (!acc.balanceAt || at > acc.balanceAt) {
        acc.balance = preview.latest.balance;
        acc.balanceAt = at;
        changedMeta = true;
      }
    }
    if (changedMeta) store.saveMeta();
    const source = preview.source === 'file' ? 'file' : 'paste';
    for (let i = 0; i < chosen.length; i += 200) {
      const part = chosen.slice(i, i + 200);
      await busy(`저장하는 중… (${Math.min(i + 200, chosen.length)}/${chosen.length})`, () =>
        store.addTransactions(part.map((it) => ({
          date: it.date, amount: it.amount, memo: it.memo, kind: it.kind || 'expense', accountId: it.accountId || null,
          categoryId: it.kind === 'expense' ? it.categoryId : null, method: it.method, source, raw: it.raw,
        })))
      );
    }
    const latestDate = chosen.map((x) => x.date).sort().pop();
    if (preview.source === 'paste') $('#paste-input').value = '';
    else $('#file-input').value = '';
    clearPreview();
    toast(`${chosen.length}건을 추가했습니다.`);
    jumpToDate(latestDate);
  }

  // ---------- 설정 ----------

  // 알림 연결 앱(안드로이드) 내려받기 주소 (GitHub Actions 가 main 에 올라갈 때마다 갱신)
  const NOTI_APK_URL = 'https://github.com/kdh1207-star/ClaudeCode1/releases/download/noti-app/budget-noti.apk';

  // 설치된 알림 연결 앱을 열면서 서버 주소를 넘긴다 (크롬 안드로이드의 intent 링크)
  function connectLink() {
    const url = encodeURIComponent(notifyUrl('bank'));
    return `intent://setup?url=${url}#Intent;scheme=budgetnoti;package=com.kdh1207.budgetnoti;S.browser_fallback_url=${encodeURIComponent(NOTI_APK_URL)};end`;
  }

  function notifyUrl(source) {
    return store.serviceUrl ? `${store.serviceUrl}?action=sms&key=${encodeURIComponent(store.server.key)}${source ? `&source=${source}` : ''}` : '';
  }

  function renderSettings() {
    const sd = $('#start-day');
    if (!sd.options.length) sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">매월 ${i + 1}일</option>`).join('');
    sd.value = String(S().settings.startDay);
    $('#my-name').value = S().settings.myName || '';
    $('#theme-select').value = S().settings.theme || 'basic';
    renderAccountRows();
    renderRules();
    renderAutoCard();
    $('#data-note').textContent = store.mode === 'remote'
      ? '데이터는 구글 시트에 저장됩니다. 백업 불러오기를 하면 백업의 계획·계좌를 적용하고 내역을 시트에 추가합니다.'
      : '모든 데이터는 이 브라우저에만 저장됩니다. 다른 기기로 옮기거나 백업하려면 내보내기를 사용하세요.';
    $('#reset-btn').hidden = store.mode === 'remote';
  }

  // 자동 분류 규칙: 이 가맹점·상대는 항상 이 항목 (AI보다 먼저 적용). 직접 만들고 지운다.
  function renderRules() {
    const cats = currentPlan().categories;
    const entries = Object.entries(S().merchantMap).sort((a, b) => a[0].localeCompare(b[0], 'ko'));
    $('#rule-cat').innerHTML = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const el = $('#rule-rows');
    el.innerHTML = entries.length
      ? entries.map(([name, id]) => {
        const c = cats.find((x) => x.id === id);
        return `<div class="rule-row"><span class="rule-name">${esc(name)}</span><span class="rule-arrow">→</span><span>${c ? esc(c.name) : '<span class="muted">지금 계획에 없는 항목</span>'}</span><button class="link-btn rule-del" data-name="${esc(name)}" aria-label="${esc(name)} 규칙 삭제">✕</button></div>`;
      }).join('')
      : '<div class="empty small">아직 규칙이 없어요. 모든 지출은 AI(또는 키워드)가 분류합니다.</div>';
    el.querySelectorAll('.rule-del').forEach((b) => b.addEventListener('click', () => {
      delete S().merchantMap[b.dataset.name];
      store.saveMeta();
      toast('규칙을 지웠어요. 이미 분류된 내역은 그대로예요.');
      renderRules();
    }));
  }

  function renderAccountRows() {
    const el = $('#account-rows');
    const accounts = S().accounts;
    el.innerHTML = accounts.length
      ? accounts.map((a) => `
        <div class="acct-row" data-id="${esc(a.id)}">
          <input class="a-name" type="text" value="${esc(a.name)}" placeholder="${a.type === 'card' ? '예: 신한 체크카드' : '예: 국민 주거래'}" aria-label="이름">
          <select class="a-type" aria-label="종류">
            <option value="bank" ${a.type !== 'card' ? 'selected' : ''}>은행 계좌</option>
            <option value="card" ${a.type === 'card' ? 'selected' : ''}>카드</option>
            <option value="pay" ${a.type === 'pay' ? 'selected' : ''}>간편결제 머니</option>
          </select>
          ${a.type === 'pay'
            ? `<input class="a-payname" type="text" value="${esc(a.payName)}" placeholder="은행 내역에 찍히는 이름 (예: 카카오페이)" aria-label="은행 내역에 찍히는 이름">`
            : `<input class="a-last" type="text" inputmode="numeric" maxlength="4" value="${esc(a.last4)}" placeholder="끝 4자리" aria-label="끝 4자리">`}
          <input class="a-bal" type="text" inputmode="numeric" value="${typeof a.balance === 'number' ? a.balance.toLocaleString('ko-KR') : ''}" placeholder="${a.type === 'card' ? '—' : '현재 잔액'}" ${a.type === 'card' ? 'disabled' : ''} aria-label="잔액">
          <label class="check"><input type="checkbox" class="a-save" ${a.isSavings ? 'checked' : ''} ${a.type !== 'bank' ? 'disabled' : ''}>저축</label>
          <button class="link-btn a-del" aria-label="삭제">✕</button>
          ${a.type === 'pay' ? `<div class="acct-note small muted">은행 내역에 '${esc(a.payName || '이름')}'(으)로 찍힌 출금은 충전으로 보고 지출에서 뺍니다. 결제내역은 붙여넣기·파일 가져오기에서 결제수단을 이 항목으로 골라 넣으세요. <button class="link a-apply">이미 기록된 내역에도 적용</button></div>` : ''}
        </div>`).join('')
      : '<div class="empty">아직 등록한 계좌·카드가 없어요.</div>';

    el.querySelectorAll('.acct-row').forEach((row) => {
      const a = S().accounts.find((x) => x.id === row.dataset.id);
      const save = (rerender) => {
        store.saveMeta();
        if (rerender) renderAccountRows();
      };
      row.querySelector('.a-name').addEventListener('change', (e) => {
        a.name = e.target.value.trim();
        save();
      });
      row.querySelector('.a-type').addEventListener('change', (e) => {
        a.type = e.target.value;
        if (a.type === 'card') Object.assign(a, { balance: null, isSavings: false });
        if (a.type === 'pay') Object.assign(a, { isSavings: false, payName: a.payName || (/페이|pay/i.test(a.name) ? a.name : '카카오페이') });
        save(true);
      });
      const last = row.querySelector('.a-last');
      if (last) last.addEventListener('change', (e) => {
        a.last4 = e.target.value.replace(/\D/g, '').slice(-4);
        e.target.value = a.last4;
        save();
      });
      const payName = row.querySelector('.a-payname');
      if (payName) payName.addEventListener('change', (e) => {
        a.payName = e.target.value.trim();
        save(true);
      });
      const apply = row.querySelector('.a-apply');
      if (apply) apply.addEventListener('click', quiet(async () => {
        const targets = S().transactions.filter((t) => L.applyPayRules({ ...t }, [a]));
        if (!targets.length) return toast(`'${a.payName}'(으)로 찍힌 지출·입금이 없어요.`);
        if (!confirm(`'${a.payName}'(으)로 찍힌 내역 ${targets.length}건을 충전(내 계좌 이체)으로 바꿀까요? 지출에서 빠집니다.`)) return;
        await busy(`정리하는 중… (${targets.length}건)`, async () => {
          for (const t of targets) await store.updateTransaction(t.id, { kind: 'transfer', categoryId: null, method: null });
        });
        toast(`${targets.length}건을 충전으로 바꿨어요.`);
        render();
      }));
      formatOnBlur(row.querySelector('.a-bal'));
      row.querySelector('.a-bal').addEventListener('change', (e) => {
        a.balance = parseAmountInput(e.target.value);
        a.balanceAt = nowISO();
        save();
      });
      row.querySelector('.a-save').addEventListener('change', (e) => {
        a.isSavings = e.target.checked;
        save();
      });
      row.querySelector('.a-del').addEventListener('click', () => {
        if (!confirm(`'${a.name || a.last4}' 을(를) 삭제할까요? 이미 기록된 내역은 그대로 남습니다.`)) return;
        S().accounts = S().accounts.filter((x) => x.id !== a.id);
        save(true);
      });
    });
  }

  function addAccount() {
    S().accounts.push({ id: `a-${uid()}`, name: '', type: 'bank', last4: '', isSavings: false, balance: null, balanceAt: '' });
    store.saveMeta();
    renderAccountRows();
    const names = $$('.acct-row .a-name');
    names[names.length - 1].focus();
  }

  // 설치형 앱(GitHub Pages) 주소. #connect= 뒤에 서버 주소·접속 키를 실어 보낸다 (# 뒤는 서버로 전송되지 않음)
  const PWA_URL = 'https://kdh1207-star.github.io/ClaudeCode1/';
  function pwaLink() {
    const json = JSON.stringify({ u: store.serviceUrl, k: store.server.key });
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${PWA_URL}#connect=${b64}`;
  }

  function renderAutoCard() {
    const card = $('#set-auto');
    if (store.mode === 'remote') {
      const MODEL_LABEL = { 'claude-opus-5-5': 'Claude Opus 5.5 (기본, 가장 정확)', 'claude-haiku-5-5': 'Claude Haiku 5.5 (추천, 아주 저렴)', 'claude-haiku-4-5': 'Claude Haiku 4.5 (예전 모델)' };
      card.innerHTML = `
        <h2>자동 입력</h2>
        <h3>Claude AI 분류</h3>
        <p class="small">${store.aiEnabled ? '<b>켜져 있어요.</b> 알림과 붙여넣은 내역을 AI가 예산 항목에 맞춰 분류합니다.' : '<b>꺼져 있어요.</b> 지금은 키워드로 분류합니다. 아래에 Claude API 키를 넣으면 켜져요. 키는 console.anthropic.com 에서 결제 수단을 등록한 뒤 API Keys 메뉴에서 만들 수 있어요.'}</p>
        <form id="ai-form" class="form-grid">
          <label class="wide">Claude API 키<input type="password" id="ai-key" autocomplete="off" placeholder="${store.aiEnabled ? '저장됨 (바꾸려면 새 키 입력)' : 'sk-ant-…'}"></label>
          <div class="form-submit"><button type="submit" class="primary-btn">확인하고 저장</button></div>
        </form>
        ${store.aiEnabled ? `<div class="form-grid" style="margin-top:12px"><label class="wide">사용할 모델<select id="ai-model">${(store.aiModels.length ? store.aiModels : [store.aiModel]).map((m) => `<option value="${esc(m)}" ${m === store.aiModel ? 'selected' : ''}>${esc(MODEL_LABEL[m] || m)}</option>`).join('')}</select></label></div>` : ''}
        ${store.aiError ? `<p class="muted small">최근 AI 오류: ${esc(store.aiError)}</p>` : ''}
        ${store.server.embedded ? `
        <h3>앱으로 설치 (주소창 없는 화면)</h3>
        <p class="muted small">아래 버튼을 누르면 설치형 앱 화면이 열리고 이 서버 주소·접속 키가 자동으로 연결돼요. 열린 화면에서 크롬 메뉴 <b>⋮ → 홈 화면에 추가(앱 설치)</b>를 누르세요. 화면은 자동으로 최신 버전이 돼요.</p>
        <div class="row-actions"><a class="primary-btn" target="_blank" rel="noopener" href="${esc(pwaLink())}">앱 화면 열기</a></div>` : ''}
        <h3>카카오뱅크 문자 자동 입력 (MacroDroid 무료)</h3>
        <ol class="steps">
          <li>플레이 스토어에서 <b>MacroDroid</b> 설치 (Pro 7일 체험 안내는 닫기)</li>
          <li>매크로 추가 → 트리거 <b>전화/SMS → SMS 수신</b> (모든 번호, 내용에 <code>잔액</code> 포함)</li>
          <li>동작 <b>웹 접속 → HTTP 요청</b>: POST, 아래 주소, 본문 text/plain 에 <b>…(매직 텍스트) → SMS 메시지</b> 선택 (버전에 따라 <code>{sms_message}</code> 또는 <code>[sms_message]</code>로 들어가요. 그대로 두세요)</li>
          <li>저장 후 휴대폰 설정에서 MacroDroid 배터리 <b>제한 없음</b></li>
        </ol>
        <div class="copy-row"><input type="text" readonly value="${esc(notifyUrl('bank'))}" id="url-bank"><button class="ghost-btn" data-copy="url-bank">복사</button></div>
        <p class="muted small">문자가 와도 반응이 없으면 트리거를 <b>알림 수신</b>(메시지 앱, 내용 <code>잔액</code>)으로 바꾸고 본문을 <code>[notification_title] [notification]</code> 로 하세요. 계좌·카드에 카카오뱅크 끝 4자리를 등록해 두면 잔액도 갱신돼요. 자세한 방법은 SETUP.md 6단계에 있어요.</p>
        <h3>카카오페이 결제 알림 (선택)</h3>
        <p class="muted small">계좌의 카카오페이 출금은 충전이라 지출로 세지 않아요(계좌·카드에 <b>간편결제 머니</b>로 카카오페이를 등록). 실제 결제는 카카오페이 결제내역을 붙여넣기·파일로 가져오거나, MacroDroid 매크로를 하나 더 만들어 실시간으로 받을 수 있어요: 트리거 <b>알림 수신</b>(앱: 카카오페이, 내용에 <code>원</code>) → 동작 <b>웹 접속 → HTTP 요청</b>(POST, 아래 주소, 본문 <code>[notification_title] [notification]</code>). 알림 접근 권한이 필요해요.</p>
        <div class="copy-row"><input type="text" readonly value="${esc(notifyUrl('pay'))}" id="url-pay"><button class="ghost-btn" data-copy="url-pay">복사</button></div>
        <details class="small">
          <summary>직접 만든 알림 연결 앱 (선택, 보안 차단될 수 있음)</summary>
          <p class="muted">플레이 스토어 밖 앱이라 삼성 보안 기능이 설치를 막을 수 있어요. 보안 설정을 끄면서까지 쓰는 것은 권하지 않아요. <a href="${NOTI_APK_URL}" target="_blank" rel="noopener">APK 받기</a> · <a href="${esc(connectLink())}" target="_blank" rel="noopener">설치한 앱에 연결</a></p>
        </details>
        <div class="row-actions">
          ${store.server.embedded ? '<button id="forget-key-btn" class="ghost-btn small-btn">이 기기에서 접속 키 지우기</button>' : '<button id="disconnect-btn" class="danger-btn">연결 해제 (이 기기 저장으로)</button>'}
        </div>`;
      $('#ai-form').addEventListener('submit', quiet(async (e) => {
        e.preventDefault();
        const key = $('#ai-key').value.trim();
        if (!key && !confirm('API 키를 지우고 AI 분류를 끌까요?')) return;
        await busy('API 키를 확인하는 중…', () => store.setApiKey(key));
        toast(store.aiEnabled ? 'AI 분류를 켰어요.' : 'AI 분류를 껐어요.');
        render();
      }));
      const modelSel = $('#ai-model');
      if (modelSel) modelSel.addEventListener('change', quiet(async () => {
        await busy(null, () => store.setModel(modelSel.value));
        toast('모델을 바꿨어요.');
      }));
      card.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
        const input = $(`#${b.dataset.copy}`);
        copyText(input.value, input);
      }));
      const fk = $('#forget-key-btn');
      if (fk) fk.addEventListener('click', () => {
        if (!confirm('이 기기에서 접속 키를 지울까요? 다음에 열 때 다시 입력해야 해요.')) return;
        store.forgetKey();
        location.reload();
      });
      const dc = $('#disconnect-btn');
      if (dc) dc.addEventListener('click', () => {
        if (!confirm('서버 연결을 해제할까요? 구글 시트의 데이터는 그대로 남아 있습니다.')) return;
        store.disconnect();
        location.reload();
      });
    } else {
      card.innerHTML = `
        <h2>자동 입력 (구글 시트 서버 연결)</h2>
        <p class="muted small">카드 문자·은행 알림 자동 입력과 AI 분류는 구글 시트 서버가 있어야 동작해요. 저장소의 <b>SETUP.md</b> 대로 구글 Apps Script 를 배포한 뒤, 웹앱 주소와 접속 키를 넣으세요. 웹앱 주소로 바로 접속해서 써도 됩니다.</p>
        <form id="connect-form" class="form-grid">
          <label class="wide">웹앱 주소<input type="url" id="c-url" placeholder="https://script.google.com/macros/s/…/exec" required></label>
          <label>접속 키<input type="text" id="c-key" required></label>
          <div class="form-submit"><button type="submit" class="primary-btn">연결</button></div>
        </form>`;
      $('#connect-form').addEventListener('submit', quiet(async (e) => {
        e.preventDefault();
        const url = $('#c-url').value.trim().replace(/\?.*$/, '');
        const key = $('#c-key').value.trim();
        await busy('연결 확인 중…', () => store.ping(url, key));
        const migrate = S().transactions.length > 0 && confirm('이 기기에 있던 계획과 내역을 구글 시트로 옮길까요?');
        store.connect(url, key, migrate);
        location.reload();
      }));
    }
  }

  function changeStartDay(newDay) {
    L.remapPeriodKeys(S(), newDay);
    currentPeriod = L.getPeriod(L.todayISO(), newDay);
    store.saveMeta();
    renderChrome();
    toast(`이제 매월 ${newDay}일에 새 기간이 시작됩니다.`);
  }

  // ---------- 백업 ----------

  function exportData() {
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `지출관리-백업-${L.todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = quiet(async () => {
      let parsed;
      try {
        parsed = L.normalizeState(JSON.parse(reader.result));
      } catch (e) {
        return toast('올바른 백업 파일이 아닙니다.');
      }
      const msg = store.mode === 'remote' ? '백업의 계획·계좌를 적용하고 내역을 구글 시트에 추가할까요?' : '현재 데이터를 백업 파일의 내용으로 바꿀까요?';
      if (!confirm(msg)) return;
      await busy('불러오는 중…', () => store.importState(parsed));
      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
      toast('백업을 불러왔습니다.');
      render();
    });
    reader.readAsText(file);
  }

  // ---------- 렌더 & 이벤트 ----------

  function render() {
    renderChrome();
    const page = currentPage;
    if (page === 'home') renderHome();
    else if (page === 'calendar') renderCalendar();
    else if (page === 'list') renderList();
    else if (page === 'sort') renderSort();
    else if (page === 'report') renderReport();
    else if (page === 'assets') renderAssets();
    else if (page === 'plan') renderPlan();
    else if (page === 'add') renderAdd();
    else if (page === 'settings') renderSettings();
    tidyHints();
  }

  // 긴 설명 문구는 접어 두고 제목 옆 ⓘ 를 눌러야 보이게 한다 (화면을 가볍게)
  function tidyHints() {
    $$('.content p.muted.small:not([id]):not([data-hint])').forEach((p) => {
      p.dataset.hint = '1';
      if (p.textContent.trim().length < 45 || p.closest('.acct-note, table, .key-card')) return;
      p.classList.add('hint-collapsed');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hint-toggle';
      btn.textContent = 'i';
      btn.setAttribute('aria-label', '설명 보기');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const open = p.classList.toggle('hint-collapsed') === false;
        btn.setAttribute('aria-expanded', String(open));
      });
      // 같은 카드 안 바로 앞의 제목 옆에 붙이고, 없으면 문단 자리에 둔다
      let prev = p.previousElementSibling;
      while (prev && !/^H[23]$/.test(prev.tagName) && !prev.classList.contains('card-head')) prev = prev.previousElementSibling;
      const target = prev && (prev.classList.contains('card-head') ? prev.querySelector('h2') : prev);
      if (target && !target.querySelector('.hint-toggle')) target.appendChild(btn);
      else p.before(btn);
    });
  }

  function bindEvents() {
    $$('.nav-item[data-page], .bottom-nav [data-page]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));
    $$('[data-open-menu]').forEach((b) => b.addEventListener('click', openMenu));
    $('#menu-btn').addEventListener('click', openMenu);
    $('#scrim').addEventListener('click', closeMenu);
    $('#add-btn').addEventListener('click', () => showPage('add'));
    window.addEventListener('hashchange', () => {
      const name = location.hash.slice(1);
      if (PAGES[name] && name !== currentPage) showPage(name, { push: false });
    });
    $$('.settings-nav a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    const move = (delta) => {
      currentPeriod = L.shiftPeriod(currentPeriod, delta, S().settings.startDay);
      $('#income-box').dataset.editing = '';
      render();
    };
    $('#prev-period').addEventListener('click', () => move(-1));
    $('#next-period').addEventListener('click', () => move(1));
    $('#today-period').addEventListener('click', () => {
      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
      selectedDate = null;
      render();
    });
    $('#refresh-btn').addEventListener('click', quiet(async () => {
      await busy('불러오는 중…', () => store.refresh());
      render();
    }));

    // 입력
    $$('#m-kind button').forEach((b) => b.addEventListener('click', () => {
      manualKind = b.dataset.kind;
      renderAdd();
    }));
    $('#manual-form').addEventListener('submit', quiet(onManualSubmit));
    formatOnBlur($('#m-amount'));
    $('#m-memo').addEventListener('input', updateManualHint);
    $('#m-category').addEventListener('change', updateManualHint);
    $('#m-date').addEventListener('change', renderAdd);
    $('#parse-btn').addEventListener('click', quiet(onParse));
    $('#paste-clear').addEventListener('click', () => {
      $('#paste-input').value = '';
      clearPreview();
    });
    $('#file-input').addEventListener('change', quiet(async (e) => {
      if (e.target.files[0]) await onFileChosen(e.target.files[0]);
    }));

    // 내역
    const setFilter = (key, value) => {
      listState[key] = value;
      renderList();
    };
    $('#list-search').addEventListener('input', (e) => setFilter('search', e.target.value));
    $('#list-kind').addEventListener('change', (e) => setFilter('kind', e.target.value));
    $('#list-filter').addEventListener('change', (e) => setFilter('category', e.target.value));
    $('#list-account').addEventListener('change', (e) => setFilter('account', e.target.value));
    $('#reclassify-unclassified').addEventListener('click', quiet(() => runReclassify(true)));
    $('#reclassify-all').addEventListener('click', quiet(() => runReclassify(false)));
    $('#pay-topups').addEventListener('click', quiet(fixPayTopups));

    // 예산 계획
    $('#ratio-base').addEventListener('change', (e) => {
      budgetPlan().ratioBase = e.target.value;
      store.saveMeta();
      renderPlanVersion();
      renderPlanSummary();
    });
    $('#fixed-overflow').addEventListener('change', (e) => {
      budgetPlan().fixedOverflow = e.target.value === 'scale' ? 'scale' : 'warn';
      store.saveMeta();
      renderPlanVersion();
      renderPlanSummary();
    });
    $('#add-category').addEventListener('click', addCategory);

    // 설정
    $('#start-day').addEventListener('change', (e) => changeStartDay(Number(e.target.value)));
    $('#theme-select').addEventListener('change', (e) => {
      S().settings.theme = THEMES.includes(e.target.value) ? e.target.value : 'basic';
      store.saveMeta();
      applyTheme();
    });
    $('#my-name').addEventListener('change', (e) => {
      S().settings.myName = e.target.value.trim();
      store.saveMeta();
    });
    $('#rule-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = L.normalizeMerchant($('#rule-name').value);
      if (!name) return toast('가맹점이나 상대 이름을 입력해 주세요.');
      S().merchantMap[name] = $('#rule-cat').value;
      store.saveMeta();
      $('#rule-name').value = '';
      toast('규칙을 만들었어요. 앞으로 들어오는 내역부터 적용돼요.');
      renderRules();
    });
    $('#add-account').addEventListener('click', addAccount);
    $('#export-btn').addEventListener('click', exportData);
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#reset-btn').addEventListener('click', () => {
      if (!confirm('모든 내역, 수입, 계획, 계좌를 지우고 처음 상태로 되돌릴까요? (되돌릴 수 없습니다)')) return;
      store.reset();
      currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
      toast('초기화했습니다.');
      render();
    });

    // 앱을 떠날 때 아직 보내지 않은 변경을 저장하고, 돌아오면 새로 들어온 알림 내역을 불러온다
    document.addEventListener('visibilitychange', quiet(async () => {
      if (document.visibilityState === 'hidden') return store.flushMeta();
      if (store.mode === 'remote' && !busyCount && !store.hasPendingMeta()) {
        await store.refresh();
        render();
      }
    }));
  }

  // 구글 웹 앱으로 처음 열었을 때: 접속 키를 한 번 입력받아 이 기기에 기억한다
  function askKey() {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'key-gate';
      box.innerHTML = `
        <form class="card key-card" id="key-form">
          <h2>접속 키를 입력하세요</h2>
          <p class="muted small">구글 Apps Script 편집기에서 <b>setup</b> 을 실행하면 실행 기록에 나오는 키예요. (안 보이면 ⚙ 프로젝트 설정 → 스크립트 속성의 <b>APP_KEY</b>) 한 번 입력하면 이 기기가 기억해요.</p>
          <input type="password" id="key-input" autocomplete="current-password" placeholder="접속 키" required>
          <div class="row-actions"><button type="submit" class="primary-btn">들어가기</button></div>
          <p class="small warn" id="key-error" hidden></p>
        </form>`;
      document.body.appendChild(box);
      $('#key-input').focus();
      $('#key-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#key-error');
        err.hidden = true;
        try {
          await store.useKey($('#key-input').value.trim());
          box.remove();
          resolve();
        } catch (ex) {
          err.textContent = /unauthorized/.test(ex.message) ? '키가 맞지 않아요. 다시 확인해 주세요.' : `확인하지 못했어요: ${ex.message}`;
          err.hidden = false;
        }
      });
    });
  }

  const THEMES = ['basic', 'y2k', 'cyber', 'terminal'];

  // 테마: <html data-skin> 로 겉모습을 바꾸고, 다음에 열 때 깜빡이지 않게 이 기기에도 기억한다
  function applyTheme() {
    const t = THEMES.includes(S().settings.theme) ? S().settings.theme : 'basic';
    const root = document.documentElement;
    if ((root.getAttribute('data-skin') || 'basic') === t && document.getElementById('backdrop')) return;
    if (t === 'basic') root.removeAttribute('data-skin');
    else root.setAttribute('data-skin', t);
    // 휴대폰 상태바 색을 테마 바탕색에 맞춘다
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--page').trim() || '#f4f4f1');
    try {
      localStorage.setItem('budget-theme', t);
    } catch (e) {
      /* 저장 못 해도 괜찮음 */
    }
    try {
      drawBackdrop();
    } catch (e) {
      /* 장식 */
    }
  }

  // 배경 장식 (매번 같은 무늬가 나오도록 고정 씨앗). Y2K: 4갈래 반짝임·별점 / 사이버펑크: HUD 표식·데이터 조각
  function drawBackdrop() {
    let cv = document.getElementById('backdrop');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'backdrop';
      cv.setAttribute('aria-hidden', 'true');
      document.body.prepend(cv);
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    let seed = 20261015;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const area = (w * h) / (390 * 844);
    const skin = document.documentElement.getAttribute('data-skin');
    if (!skin || skin === 'terminal') return; // 기본·터미널은 깨끗한 화면
    if (document.documentElement.getAttribute('data-skin') === 'cyber') {
      // 작은 + 표식, 모서리 괄호, 짧은 데이터 막대
      const cols = ['0, 240, 255', '252, 238, 10', '255, 31, 75'];
      g.lineWidth = 1;
      for (let i = 0; i < 18 * area; i++) {
        const x = Math.round(rnd() * w) + 0.5;
        const y = Math.round(rnd() * h) + 0.5;
        const c = cols[rnd() < 0.7 ? 0 : rnd() < 0.6 ? 1 : 2];
        g.strokeStyle = `rgba(${c}, ${0.18 + rnd() * 0.3})`;
        g.beginPath();
        if (rnd() < 0.55) {
          const r = 3 + Math.round(rnd() * 3);
          g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y - r); g.lineTo(x, y + r);
        } else {
          const r = 6 + Math.round(rnd() * 8);
          g.moveTo(x, y + r); g.lineTo(x, y); g.lineTo(x + r, y);
        }
        g.stroke();
      }
      for (let i = 0; i < 26 * area; i++) {
        const c = cols[rnd() < 0.6 ? 0 : rnd() < 0.5 ? 1 : 2];
        g.fillStyle = `rgba(${c}, ${0.08 + rnd() * 0.22})`;
        g.fillRect(Math.round(rnd() * w), Math.round(rnd() * h), 4 + Math.round(rnd() * 28), rnd() < 0.8 ? 1 : 2);
      }
      return;
    }
    const tints = ['236, 244, 255', '143, 227, 255', '201, 168, 255', '255, 158, 224'];

    // 작은 별점
    for (let i = 0; i < 90 * area; i++) {
      const s = rnd() < 0.85 ? 1 : 2;
      g.fillStyle = `rgba(${tints[Math.floor(rnd() * tints.length)]}, ${0.2 + rnd() * 0.55})`;
      g.fillRect(Math.round(rnd() * w), Math.round(rnd() * h), s, s);
    }
    // 4갈래 반짝임: 작은 것 위주, 가끔 큰 것
    for (let i = 0; i < 22 * area; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const big = rnd() < 0.15;
      const r = big ? 9 + rnd() * 9 : 3 + rnd() * 5;
      const tint = tints[Math.floor(rnd() * tints.length)];
      const a = 0.45 + rnd() * 0.5;
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 1.6);
      glow.addColorStop(0, `rgba(${tint}, ${a * 0.45})`);
      glow.addColorStop(1, `rgba(${tint}, 0)`);
      g.fillStyle = glow;
      g.beginPath();
      g.arc(x, y, r * 1.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `rgba(255, 255, 255, ${a})`;
      g.beginPath();
      g.moveTo(x, y - r);
      g.quadraticCurveTo(x, y, x + r * 0.62, y);
      g.quadraticCurveTo(x, y, x, y + r);
      g.quadraticCurveTo(x, y, x - r * 0.62, y);
      g.quadraticCurveTo(x, y, x, y - r);
      g.fill();
    }
  }

  async function start() {
    window.__budgetStarted = true;
    try {
      drawBackdrop();
    } catch (e) {
      /* 장식이라 실패해도 앱은 그대로 */
    }
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { try { drawBackdrop(); } catch (e) { /* 무시 */ } }, 150);
    });
    bindEvents();
    if (store.mode === 'remote' && !store.server.key) await askKey();
    const toMigrate = store.takeMigration();
    try {
      await busy(store.mode === 'remote' ? '불러오는 중…' : null, () => store.init());
    } catch (e) {
      $('#category-rows').innerHTML = `<div class="empty">서버에 연결하지 못했습니다. (${esc(e.message || e)})<br>설정 → 자동 입력에서 주소와 키를 확인하세요.</div>`;
    }
    if (toMigrate) {
      await busy('이 기기 데이터를 옮기는 중…', () => store.importState(toMigrate)).catch(() => {});
      toast('이 기기 데이터를 구글 시트로 옮겼습니다.');
    }
    applyTheme();
    currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
    showPage(location.hash.slice(1) || 'home', { push: false });
  }

  start();
})();
