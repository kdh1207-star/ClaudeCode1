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

  const METHOD_LABEL = { ai: 'AI', learned: '기억', keyword: '키워드', manual: '직접' };
  const methodTag = (m) => (m && METHOD_LABEL[m] ? `<span class="tag">${METHOD_LABEL[m]}</span>` : '');

  // ---------- 페이지 이동 ----------

  const PAGES = {
    home: { title: '홈', period: true },
    calendar: { title: '달력', period: true },
    list: { title: '내역', period: true },
    report: { title: '리포트', period: true },
    assets: { title: '자산', period: true },
    plan: { title: '예산 계획', period: true },
    add: { title: '지출·수입 입력', period: false },
    settings: { title: '설정', period: false },
  };

  function showPage(name, { push = true } = {}) {
    if (!PAGES[name]) name = 'home';
    currentPage = name;
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    $$('.bottom-nav [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    $('#page-title').textContent = PAGES[name].title;
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
    const chip = $('#conn-status');
    if (store.mode === 'local') {
      chip.textContent = '이 기기에만 저장';
      chip.className = 'chip';
    } else {
      chip.textContent = store.aiEnabled ? '구글 시트 · AI 분류' : '구글 시트 · AI 꺼짐';
      chip.className = `chip ${store.aiEnabled ? 'on' : ''}`;
    }
    $('#refresh-btn').hidden = store.mode !== 'remote';

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
    const cats = planForDate(t.date).categories;
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
      const key = L.normalizeMerchant(t.memo);
      if (s.value) S().merchantMap[key] = s.value;
      else delete S().merchantMap[key];
      store.saveMeta();
      await busy(null, () => store.updateTransaction(t.id, { kind: 'expense', categoryId: s.value || null, method: s.value ? 'manual' : null }));
      toast(`'${t.memo}' 은(는) 앞으로 ${categoryInfo(t.categoryId, planForDate(t.date).categories).name}(으)로 분류합니다.`);
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

  function renderHome() {
    const sum = L.summarizePeriod(S(), currentPeriod);
    renderIncomeBox(sum);
    renderStaleBox(sum);

    const today = L.todayISO();
    const isCurrent = today >= currentPeriod.start && today <= currentPeriod.end;
    const daysLeft = isCurrent ? L.diffDays(today, currentPeriod.end) + 1 : 0;
    const hero = $('#hero');
    if (sum.hasIncome) {
      const ratio = sum.income > 0 ? sum.totalSpent / sum.income : sum.totalSpent > 0 ? Infinity : 0;
      const status = L.statusOf(ratio);
      hero.innerHTML = `
        <div class="label">남은 돈</div>
        <div class="figure ${sum.remaining < 0 ? 'negative' : ''}">${won(sum.remaining)}</div>
        <div class="sub">${won(sum.income)} 중 ${won(sum.totalSpent)} 사용 (${sum.income > 0 ? Math.round(ratio * 100) : 0}%)</div>
        <div class="meter ${status}" role="meter" aria-valuemin="0" aria-valuemax="${sum.income}" aria-valuenow="${sum.totalSpent}" aria-label="예산 사용"><div class="meter-fill" style="width:${Math.min(100, ratio * 100)}%"></div></div>`;
    } else {
      hero.innerHTML = `
        <div class="label">이번 기간 쓴 돈</div>
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
              <span class="cat-name"><span class="dot" style="background:var(--gray-mark)"></span>미분류<span class="badge">항목 지정 필요</span></span>
              <span class="cat-amounts"><b>${won(sum.unclassified)}</b> · ${sum.unclassifiedCount}건</span>
            </div>
          </div>`);
      }
      rowsEl.innerHTML = rows.join('');
      rowsEl.querySelectorAll('.cat-row').forEach((el) => {
        el.addEventListener('click', () => {
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
    const days = L.dailyTotals(sum.allTransactions);
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

    const dayTxs = sum.allTransactions.filter((t) => t.date === selectedDate);
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

  function renderAssets() {
    const a = L.assetSummary(S(), currentPeriod);
    const hasBalance = a.banks.some((b) => typeof b.balance === 'number');
    $('#asset-hero').innerHTML = `
      <div class="label">계좌 잔액 합계</div>
      <div class="figure">${hasBalance ? won(a.total) : '—'}</div>
      <div class="sub">${a.savings ? `저축 계좌 ${won(a.savings)} · ` : ''}등록한 계좌 ${a.banks.length}개, 카드 ${a.cards.length}개</div>`;

    const banks = $('#asset-banks');
    banks.innerHTML = a.banks.length
      ? a.banks.map((b) => `
        <div class="acct">
          <div class="acct-icon">${esc((b.name || '계좌').slice(0, 1))}</div>
          <div><div class="acct-name">${esc(accountName(b.id))}</div><div class="acct-sub">끝자리 ${esc(b.last4 || '----')}${b.isSavings ? ' · 저축' : ''}${b.spent ? ` · 이번 기간 출금 ${won(b.spent)}` : ''}</div></div>
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
    const calc = L.computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase);

    $$('.plan-row[data-id]').forEach((row) => {
      const c = plan.categories.find((x) => x.id === row.dataset.id);
      const p = row.querySelector('.preview');
      if (!c) return;
      if (c.type === 'fixed') p.textContent = '수입과 상관없이 매 기간 같은 한도';
      else p.textContent = hasIncome ? `이번 기간 한도 ${won(calc.budgets[c.id])}` : '당기 수입을 입력하면 한도가 계산됩니다';
    });

    const base = plan.ratioBase === 'afterFixed' ? '고정 항목을 뺀 나머지' : '전체 수입';
    const lines = [`고정 항목 합계 <b>${won(calc.fixedTotal)}</b> · 비율 항목 합계 <b>${calc.ratioPercentTotal}%</b> (${base} 기준)`];
    if (calc.ratioPercentTotal > 100) lines.push('<span class="warn">⚠ 비율 합계가 100%를 넘습니다.</span>');
    else if (calc.ratioPercentTotal < 100) lines.push(`<span class="muted">비율 합계가 100%보다 ${Math.round((100 - calc.ratioPercentTotal) * 100) / 100}% 적어 일부 수입은 배분되지 않습니다.</span>`);
    if (hasIncome) {
      lines.push(`이번 기간 수입 ${won(income)} 기준: 배분 ${won(calc.allocated)}` +
        (calc.unallocated >= 0 ? ` · 남는 돈 ${won(calc.unallocated)}` : ` · <span class="warn">${won(-calc.unallocated)} 부족</span>`));
      if (plan.ratioBase === 'afterFixed' && calc.fixedTotal > income) lines.push('<span class="warn">⚠ 고정 항목 합계가 수입보다 큽니다.</span>');
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
    if (sel && sel !== '__auto') {
      S().merchantMap[L.normalizeMerchant(memo)] = sel;
      store.saveMeta();
    }
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
    preview.items = withDupFlags(items.map((it) => ({ ...it, kind: 'expense' })));
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
    const parsed = L.parseStatementRows(rows, { myName: S().settings.myName, accountId });
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
    for (const it of chosen) {
      if (it.method === 'manual' && it.categoryId) {
        S().merchantMap[L.normalizeMerchant(it.memo)] = it.categoryId;
        changedMeta = true;
      }
    }
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

  function notifyUrl(source) {
    return store.serviceUrl ? `${store.serviceUrl}?action=sms&key=${encodeURIComponent(store.server.key)}${source ? `&source=${source}` : ''}` : '';
  }

  function renderSettings() {
    const sd = $('#start-day');
    if (!sd.options.length) sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">매월 ${i + 1}일</option>`).join('');
    sd.value = String(S().settings.startDay);
    $('#my-name').value = S().settings.myName || '';
    renderAccountRows();
    renderAutoCard();
    $('#data-note').textContent = store.mode === 'remote'
      ? '데이터는 구글 시트에 저장됩니다. 백업 불러오기를 하면 백업의 계획·계좌를 적용하고 내역을 시트에 추가합니다.'
      : '모든 데이터는 이 브라우저에만 저장됩니다. 다른 기기로 옮기거나 백업하려면 내보내기를 사용하세요.';
    $('#reset-btn').hidden = store.mode === 'remote';
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
          </select>
          <input class="a-last" type="text" inputmode="numeric" maxlength="4" value="${esc(a.last4)}" placeholder="끝 4자리" aria-label="끝 4자리">
          <input class="a-bal" type="text" inputmode="numeric" value="${typeof a.balance === 'number' ? a.balance.toLocaleString('ko-KR') : ''}" placeholder="${a.type === 'card' ? '—' : '현재 잔액'}" ${a.type === 'card' ? 'disabled' : ''} aria-label="잔액">
          <label class="check"><input type="checkbox" class="a-save" ${a.isSavings ? 'checked' : ''} ${a.type === 'card' ? 'disabled' : ''}>저축</label>
          <button class="link-btn a-del" aria-label="삭제">✕</button>
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
        save(true);
      });
      row.querySelector('.a-last').addEventListener('change', (e) => {
        a.last4 = e.target.value.replace(/\D/g, '').slice(-4);
        e.target.value = a.last4;
        save();
      });
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

  function renderAutoCard() {
    const card = $('#set-auto');
    if (store.mode === 'remote') {
      card.innerHTML = `
        <h2>자동 입력</h2>
        <p class="small">내역은 구글 시트에 저장되고, ${store.aiEnabled ? '<b>Claude AI가 분류</b>합니다.' : '<b>AI 키가 없어 키워드로 분류</b>합니다. Apps Script 스크립트 속성에 ANTHROPIC_API_KEY 를 넣으면 AI 분류가 켜져요.'}</p>
        <h3>① 카드 결제 문자</h3>
        <p class="muted small">MacroDroid 트리거 <b>SMS 수신</b> → 동작 <b>HTTP 요청</b>(POST, 본문 = SMS 메시지)에 이 주소를 넣으세요.</p>
        <div class="copy-row"><input type="text" readonly value="${esc(notifyUrl(''))}" id="url-sms"><button class="ghost-btn" data-copy="url-sms">복사</button></div>
        <h3>② 은행 앱 입출금 알림 (계좌 이체)</h3>
        <p class="muted small">MacroDroid 트리거 <b>알림 수신</b>(은행 앱·토스 선택) → 동작 <b>HTTP 요청</b>(POST, 본문 = 알림 제목과 알림 텍스트)에 이 주소를 넣으세요. 계좌·카드에 계좌 끝자리를 등록해 두면 어느 계좌인지 찾고 잔액도 갱신합니다.</p>
        <div class="copy-row"><input type="text" readonly value="${esc(notifyUrl('bank'))}" id="url-bank"><button class="ghost-btn" data-copy="url-bank">복사</button></div>
        <p class="muted small">자세한 설정 방법은 저장소의 <b>SETUP.md</b> 에 있어요.</p>
        ${store.server.embedded ? '' : '<div class="row-actions"><button id="disconnect-btn" class="danger-btn">연결 해제 (이 기기 저장으로)</button></div>'}`;
      card.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
        const input = $(`#${b.dataset.copy}`);
        copyText(input.value, input);
      }));
      const dc = $('#disconnect-btn');
      if (dc) dc.addEventListener('click', () => {
        if (!confirm('서버 연결을 해제할까요? 구글 시트의 데이터는 그대로 남아 있습니다.')) return;
        store.disconnect();
        location.reload();
      });
    } else {
      card.innerHTML = `
        <h2>자동 입력 (구글 시트 서버 연결)</h2>
        <p class="muted small">카드 문자·은행 알림 자동 입력과 AI 분류는 구글 시트 서버가 있어야 동작해요. 저장소의 <b>SETUP.md</b> 대로 구글 Apps Script 를 배포한 뒤, 웹앱 주소와 APP_KEY 를 넣으세요. 웹앱 주소(<code>?key=</code> 포함)로 바로 접속해도 됩니다.</p>
        <form id="connect-form" class="form-grid">
          <label class="wide">웹앱 주소<input type="url" id="c-url" placeholder="https://script.google.com/macros/s/…/exec" required></label>
          <label>APP_KEY<input type="text" id="c-key" required></label>
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
    else if (page === 'report') renderReport();
    else if (page === 'assets') renderAssets();
    else if (page === 'plan') renderPlan();
    else if (page === 'add') renderAdd();
    else if (page === 'settings') renderSettings();
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

    // 예산 계획
    $('#ratio-base').addEventListener('change', (e) => {
      editablePlan().ratioBase = e.target.value;
      store.saveMeta();
      renderPlanVersion();
      renderPlanSummary();
    });
    $('#add-category').addEventListener('click', addCategory);

    // 설정
    $('#start-day').addEventListener('change', (e) => changeStartDay(Number(e.target.value)));
    $('#my-name').addEventListener('change', (e) => {
      S().settings.myName = e.target.value.trim();
      store.saveMeta();
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

  async function start() {
    window.__budgetStarted = true;
    bindEvents();
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
    currentPeriod = L.getPeriod(L.todayISO(), S().settings.startDay);
    showPage(location.hash.slice(1) || 'home', { push: false });
  }

  start();
})();
