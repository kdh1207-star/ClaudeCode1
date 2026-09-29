/* 지출 관리 앱 UI. 계산 로직은 js/logic.js (BudgetLogic) 에 있다. */
(function () {
  'use strict';

  const L = window.BudgetLogic;
  const STORAGE_KEY = 'budget-app-v1';

  // ---------- 저장소 ----------

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return L.normalizeState(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return L.defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('저장하지 못했습니다. 브라우저 저장공간 설정을 확인하세요.');
    }
  }

  let state = load();
  let currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
  let listFilter = 'all';
  let parsedItems = [];

  // ---------- 유틸 ----------

  const $ = (sel) => document.querySelector(sel);
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

  function categoryName(id) {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.name : '미분류';
  }

  function categoryOptions(selected, { includeAuto = false } = {}) {
    const opts = [];
    if (includeAuto) opts.push(`<option value="__auto">자동 분류</option>`);
    opts.push(`<option value="" ${!selected ? 'selected' : ''}>미분류</option>`);
    for (const c of state.categories) {
      opts.push(`<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`);
    }
    return opts.join('');
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  function formatOnBlur(input) {
    input.addEventListener('blur', () => {
      const n = parseAmountInput(input.value);
      if (n !== null) input.value = n.toLocaleString('ko-KR');
    });
  }

  // ---------- 탭 ----------

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    render();
  }

  // ---------- 기간 ----------

  function renderPeriod() {
    const p = currentPeriod;
    $('#period-text').textContent = `${fmtDate(p.start)} ~ ${fmtDate(p.end)}`;
    const today = L.todayISO();
    let sub;
    if (today >= p.start && today <= p.end) sub = `이번 기간 · ${L.diffDays(today, p.end) + 1}일 남음`;
    else if (today > p.end) sub = '지난 기간';
    else sub = '다가오는 기간';
    $('#period-sub').textContent = sub;
  }

  // ---------- 대시보드 ----------

  function renderIncomeBox(sum) {
    const box = $('#income-box');
    const prev = L.shiftPeriod(currentPeriod, -1, state.settings.startDay);
    const prevIncome = state.incomes[prev.key];

    if (!sum.hasIncome || box.dataset.editing === '1') {
      box.classList.add('income-prompt');
      box.innerHTML = `
        <h2>${sum.hasIncome ? '당기 수입(예산) 수정' : '이번 기간에 들어온 돈(예산)을 입력하세요'}</h2>
        <p class="muted small">${fmtDate(currentPeriod.start)} 에 시작하는 기간의 수입입니다. 비율 항목의 한도가 이 금액에 맞춰 계산됩니다.</p>
        <form class="income-form" id="income-form">
          <input type="text" inputmode="numeric" id="income-input" placeholder="예: 3,000,000" value="${sum.hasIncome ? sum.income.toLocaleString('ko-KR') : ''}">
          <button type="submit" class="primary-btn">저장</button>
          ${typeof prevIncome === 'number' ? `<button type="button" class="ghost-btn" id="income-prev">지난 기간과 같게 (${won(prevIncome)})</button>` : ''}
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
      const prevBtn = $('#income-prev');
      if (prevBtn) prevBtn.addEventListener('click', () => setIncome(prevIncome));
      const cancel = $('#income-cancel');
      if (cancel) cancel.addEventListener('click', () => {
        box.dataset.editing = '';
        render();
      });
    } else {
      box.classList.remove('income-prompt');
      box.innerHTML = `
        <div class="income-set">
          <div><span class="muted small">당기 수입(예산)</span><div class="value">${won(sum.income)}</div></div>
          <button class="ghost-btn" id="income-edit">수정</button>
        </div>`;
      $('#income-edit').addEventListener('click', () => {
        box.dataset.editing = '1';
        render();
      });
    }
  }

  function setIncome(n) {
    state.incomes[currentPeriod.key] = n;
    save();
    $('#income-box').dataset.editing = '';
    toast('당기 수입을 저장했습니다.');
    render();
  }

  function renderDashboard() {
    const sum = L.summarizePeriod(state, currentPeriod);
    renderIncomeBox(sum);

    const today = L.todayISO();
    const isCurrent = today >= currentPeriod.start && today <= currentPeriod.end;
    const daysLeft = isCurrent ? L.diffDays(today, currentPeriod.end) + 1 : 0;

    const hero = $('#hero');
    if (sum.hasIncome) {
      const perDay = isCurrent && sum.remaining > 0 ? `하루 ${won(Math.floor(sum.remaining / daysLeft))}씩 쓸 수 있어요` : '';
      hero.innerHTML = `
        <div class="label">남은 돈</div>
        <div class="figure ${sum.remaining < 0 ? 'negative' : ''}">${won(sum.remaining)}</div>
        <div class="sub">${won(sum.income)} 중 ${won(sum.totalSpent)} 사용${perDay ? ` · ${perDay}` : ''}</div>`;
    } else {
      hero.innerHTML = `
        <div class="label">이번 기간 사용한 돈</div>
        <div class="figure">${won(sum.totalSpent)}</div>
        <div class="sub">수입을 입력하면 항목별 한도와 남은 돈을 계산해 드려요.</div>`;
    }

    const usedPct = sum.hasIncome && sum.income > 0 ? Math.round((sum.totalSpent / sum.income) * 100) : null;
    $('#stats').innerHTML = [
      stat('당기 수입', sum.hasIncome ? won(sum.income) : '미입력'),
      stat('총 지출', won(sum.totalSpent) + (usedPct !== null ? ` (${usedPct}%)` : '')),
      stat('지출 건수', `${sum.transactions.length}건`),
      stat('미분류', sum.unclassifiedCount ? `${won(sum.unclassified)} · ${sum.unclassifiedCount}건` : '없음'),
    ].join('');

    let note = '';
    if (sum.hasIncome) {
      if (sum.unallocated > 0) note = `배분되지 않은 돈 ${won(sum.unallocated)}`;
      else if (sum.unallocated < 0) note = `⚠ 계획이 수입보다 ${won(-sum.unallocated)} 많아요`;
    }
    $('#alloc-note').textContent = note;

    const rowsEl = $('#category-rows');
    if (!state.categories.length) {
      rowsEl.innerHTML = '<div class="empty">자산관리계획 탭에서 항목을 추가하세요.</div>';
      return;
    }
    const rows = sum.rows.map((r) => categoryRow(r, sum.hasIncome));
    if (sum.unclassifiedCount) {
      rows.push(`
        <div class="cat-row" data-cat="__none">
          <div class="cat-top">
            <span class="cat-name">미분류<span class="badge">항목 지정 필요</span></span>
            <span class="cat-amounts"><b>${won(sum.unclassified)}</b> · ${sum.unclassifiedCount}건</span>
          </div>
        </div>`);
    }
    rowsEl.innerHTML = rows.join('');
    rowsEl.querySelectorAll('.cat-row').forEach((el) => {
      el.addEventListener('click', () => {
        listFilter = el.dataset.cat;
        showTab('list');
      });
      const r = sum.rows.find((x) => x.category.id === el.dataset.cat);
      if (r) attachTooltip(el.querySelector('.meter'), () => tooltipFor(r, sum));
    });
  }

  function stat(label, value) {
    return `<div class="stat"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`;
  }

  function categoryRow(r, hasIncome) {
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
          <span class="cat-name">${esc(c.name)}<span class="badge">${esc(badge)}</span></span>
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

  function tooltipFor(r, sum) {
    const count = sum.transactions.filter((t) => t.categoryId === r.category.id).length;
    return `
      <strong>${esc(r.category.name)}</strong>
      <div class="t-row"><span>한도</span><span>${won(r.budget)}</span></div>
      <div class="t-row"><span>사용</span><span>${won(r.spent)}</span></div>
      <div class="t-row"><span>${r.remaining >= 0 ? '남음' : '초과'}</span><span>${won(Math.abs(r.remaining))}</span></div>
      <div class="t-row"><span>건수</span><span>${count}건</span></div>`;
  }

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

  // ---------- 지출 입력 ----------

  function renderAddTab() {
    const sel = $('#m-category');
    const prev = sel.value || '__auto';
    sel.innerHTML = categoryOptions(null, { includeAuto: true });
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '__auto';
    if (!$('#m-date').value) $('#m-date').value = L.todayISO();
    updateManualHint();
    renderParseResult();
  }

  function updateManualHint() {
    const memo = $('#m-memo').value;
    const auto = L.classify(memo, state.categories, state.merchantMap);
    $('#m-hint').textContent = $('#m-category').value === '__auto' && memo.trim()
      ? `자동 분류 결과: ${categoryName(auto)}`
      : '';
  }

  function addTransactions(items) {
    for (const it of items) {
      state.transactions.push({ id: uid(), date: it.date, amount: it.amount, memo: it.memo, categoryId: it.categoryId || null });
    }
    state.transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    save();
  }

  function onManualSubmit(e) {
    e.preventDefault();
    const date = $('#m-date').value;
    const amount = parseAmountInput($('#m-amount').value);
    const memo = $('#m-memo').value.trim() || '(내용 없음)';
    if (!date) return toast('날짜를 입력해 주세요.');
    if (amount === null || amount === 0) return toast('금액을 입력해 주세요.');
    const sel = $('#m-category').value;
    const categoryId = sel === '__auto' ? L.classify(memo, state.categories, state.merchantMap) : sel || null;
    if (sel !== '__auto' && sel) state.merchantMap[L.normalizeMerchant(memo)] = sel;
    addTransactions([{ date, amount, memo, categoryId }]);
    $('#m-amount').value = '';
    $('#m-memo').value = '';
    updateManualHint();
    toast(`${categoryName(categoryId)} 항목에 ${won(amount)} 추가했습니다.`);
    jumpToDate(date);
  }

  function jumpToDate(date) {
    const p = L.getPeriod(date, state.settings.startDay);
    if (p.key !== currentPeriod.key) currentPeriod = p;
    render();
  }

  function onParse() {
    const text = $('#paste-input').value;
    const { items, skipped } = L.parseExpenseText(text, L.todayISO());
    parsedItems = items.map((it) => {
      const dup = L.isDuplicate(it, state.transactions);
      return { ...it, categoryId: L.classify(it.memo, state.categories, state.merchantMap), checked: !dup, dup };
    });
    parsedItems.skipped = skipped;
    renderParseResult();
  }

  function renderParseResult() {
    const el = $('#parse-result');
    if (!parsedItems.length && !(parsedItems.skipped || []).length) {
      el.innerHTML = '';
      return;
    }
    const skipped = parsedItems.skipped || [];
    const rows = parsedItems.map((it, i) => `
      <tr>
        <td><input type="checkbox" data-i="${i}" class="p-check" ${it.checked ? 'checked' : ''} aria-label="추가"></td>
        <td><input type="date" data-i="${i}" class="p-date" value="${it.date}"></td>
        <td class="memo">${esc(it.memo)} ${it.dup ? '<span class="tag warn">중복?</span>' : ''}</td>
        <td class="amount ${it.amount < 0 ? 'refund' : ''}">${won(it.amount)}</td>
        <td><select data-i="${i}" class="p-cat">${categoryOptions(it.categoryId)}</select></td>
      </tr>`).join('');
    el.innerHTML = `
      ${parsedItems.length ? `
      <div class="table-wrap">
        <table class="stack-table parse-table">
          <thead><tr><th></th><th>날짜</th><th>사용처</th><th class="amount">금액</th><th>항목</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="row-actions"><button id="p-add" class="primary-btn">선택한 ${parsedItems.filter((x) => x.checked).length}건 추가</button></div>` : ''}
      ${skipped.length ? `<p class="muted small">금액을 찾지 못해 건너뛴 줄 ${skipped.length}개: ${skipped.map(esc).join(' / ')}</p>` : ''}`;

    el.querySelectorAll('.p-check').forEach((c) => c.addEventListener('change', () => {
      parsedItems[c.dataset.i].checked = c.checked;
      renderParseResult();
    }));
    el.querySelectorAll('.p-date').forEach((c) => c.addEventListener('change', () => (parsedItems[c.dataset.i].date = c.value)));
    el.querySelectorAll('.p-cat').forEach((c) => c.addEventListener('change', () => {
      const it = parsedItems[c.dataset.i];
      it.categoryId = c.value || null;
      it.learn = true;
    }));
    const addBtn = $('#p-add');
    if (addBtn) addBtn.addEventListener('click', () => {
      const chosen = parsedItems.filter((x) => x.checked && x.date);
      if (!chosen.length) return toast('추가할 항목을 선택해 주세요.');
      for (const it of chosen) if (it.learn && it.categoryId) state.merchantMap[L.normalizeMerchant(it.memo)] = it.categoryId;
      addTransactions(chosen);
      parsedItems = [];
      $('#paste-input').value = '';
      toast(`${chosen.length}건을 추가했습니다.`);
      jumpToDate(chosen[0].date);
    });
  }

  // ---------- 지출 내역 ----------

  function renderList() {
    const sum = L.summarizePeriod(state, currentPeriod);
    const filterSel = $('#list-filter');
    const known = new Set(state.categories.map((c) => c.id));
    if (listFilter !== 'all' && listFilter !== '__none' && !known.has(listFilter)) listFilter = 'all';
    filterSel.innerHTML = `<option value="all">전체 항목</option><option value="__none">미분류</option>` +
      state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    filterSel.value = listFilter;

    const txs = sum.transactions.filter((t) => {
      if (listFilter === 'all') return true;
      if (listFilter === '__none') return !t.categoryId || !known.has(t.categoryId);
      return t.categoryId === listFilter;
    });

    const el = $('#tx-list');
    if (!txs.length) {
      el.innerHTML = '<div class="empty">이 기간에 해당하는 지출이 없습니다.</div>';
      return;
    }
    const total = txs.reduce((s, t) => s + t.amount, 0);
    el.innerHTML = `
      <div class="table-wrap">
        <table class="stack-table tx-table">
          <thead><tr><th>날짜</th><th>사용처</th><th class="amount">금액</th><th>항목</th><th></th></tr></thead>
          <tbody>
            ${txs.map((t) => `
              <tr>
                <td class="num">${fmtDate(t.date).slice(5)}</td>
                <td class="memo">${esc(t.memo)}</td>
                <td class="amount ${t.amount < 0 ? 'refund' : ''}">${won(t.amount)}</td>
                <td><select data-id="${esc(t.id)}" class="tx-cat">${categoryOptions(known.has(t.categoryId) ? t.categoryId : null)}</select></td>
                <td><button class="link-btn tx-del" data-id="${esc(t.id)}" aria-label="삭제">✕</button></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="2">합계 ${txs.length}건</th><th class="amount">${won(total)}</th><th colspan="2"></th></tr></tfoot>
        </table>
      </div>`;

    el.querySelectorAll('.tx-cat').forEach((s) => s.addEventListener('change', () => {
      const t = state.transactions.find((x) => x.id === s.dataset.id);
      t.categoryId = s.value || null;
      const key = L.normalizeMerchant(t.memo);
      if (s.value) state.merchantMap[key] = s.value;
      else delete state.merchantMap[key];
      save();
      toast(`'${t.memo}' 은(는) 앞으로 ${categoryName(t.categoryId)}(으)로 분류합니다.`);
      render();
    }));
    el.querySelectorAll('.tx-del').forEach((b) => b.addEventListener('click', () => {
      const t = state.transactions.find((x) => x.id === b.dataset.id);
      if (!confirm(`'${t.memo}' ${won(t.amount)} 내역을 삭제할까요?`)) return;
      state.transactions = state.transactions.filter((x) => x.id !== b.dataset.id);
      save();
      render();
    }));
  }

  function reclassifyUnclassified() {
    const known = new Set(state.categories.map((c) => c.id));
    let n = 0;
    for (const t of state.transactions) {
      if (t.categoryId && known.has(t.categoryId)) continue;
      const c = L.classify(t.memo, state.categories, state.merchantMap);
      if (c) {
        t.categoryId = c;
        n += 1;
      }
    }
    save();
    toast(n ? `${n}건을 자동 분류했습니다.` : '새로 분류된 내역이 없습니다. 키워드를 추가해 보세요.');
    render();
  }

  // ---------- 자산관리계획 ----------

  function renderPlan() {
    const sd = $('#start-day');
    if (!sd.options.length) {
      sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">매월 ${i + 1}일</option>`).join('');
    }
    sd.value = String(state.settings.startDay);
    $('#ratio-base').value = state.settings.ratioBase;

    const rowsEl = $('#plan-rows');
    rowsEl.innerHTML = `
      <div class="plan-row head"><span>항목 이름</span><span>방식</span><span>비율 / 금액</span><span>자동 분류 키워드</span><span></span></div>
      ${state.categories.map((c) => `
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
          <input type="text" class="pl-kw kw" value="${esc((c.keywords || []).join(', '))}" placeholder="예: 스타벅스, 카페" aria-label="키워드">
          <button class="link-btn pl-del" aria-label="${esc(c.name)} 삭제">✕</button>
          <div class="preview"></div>
        </div>`).join('')}`;

    rowsEl.querySelectorAll('.plan-row[data-id]').forEach((row) => {
      const c = state.categories.find((x) => x.id === row.dataset.id);
      row.querySelector('.pl-name').addEventListener('change', (e) => {
        c.name = e.target.value.trim() || '이름 없음';
        commitPlan();
      });
      row.querySelector('.pl-type').addEventListener('change', (e) => {
        c.type = e.target.value;
        c.value = 0;
        commitPlan(true);
      });
      row.querySelector('.pl-value').addEventListener('change', (e) => {
        const raw = e.target.value.replace(/[^\d.]/g, '');
        const n = Number(raw) || 0;
        c.value = c.type === 'fixed' ? Math.round(n) : Math.round(n * 100) / 100;
        if (c.type === 'fixed') e.target.value = c.value.toLocaleString('ko-KR');
        commitPlan();
      });
      row.querySelector('.pl-kw').addEventListener('change', (e) => {
        c.keywords = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        commitPlan();
      });
      row.querySelector('.pl-del').addEventListener('click', () => {
        if (!confirm(`'${c.name}' 항목을 삭제할까요? 이 항목의 지출은 미분류가 됩니다.`)) return;
        state.categories = state.categories.filter((x) => x.id !== c.id);
        for (const t of state.transactions) if (t.categoryId === c.id) t.categoryId = null;
        for (const k of Object.keys(state.merchantMap)) if (state.merchantMap[k] === c.id) delete state.merchantMap[k];
        commitPlan(true);
      });
    });
    renderPlanSummary();
  }

  function commitPlan(rerender = false) {
    save();
    if (rerender) renderPlan();
    else renderPlanSummary();
  }

  function renderPlanSummary() {
    const income = state.incomes[currentPeriod.key];
    const hasIncome = typeof income === 'number';
    const calc = L.computeBudgets(state.categories, hasIncome ? income : 0, state.settings.ratioBase);

    document.querySelectorAll('.plan-row[data-id]').forEach((row) => {
      const c = state.categories.find((x) => x.id === row.dataset.id);
      const p = row.querySelector('.preview');
      if (c.type === 'fixed') p.textContent = '수입과 상관없이 매 기간 같은 한도';
      else p.textContent = hasIncome ? `이번 기간 한도 ${won(calc.budgets[c.id])}` : '당기 수입을 입력하면 한도가 계산됩니다';
    });

    const base = state.settings.ratioBase === 'afterFixed' ? '고정 항목을 뺀 나머지' : '전체 수입';
    const lines = [
      `고정 항목 합계 <b>${won(calc.fixedTotal)}</b> · 비율 항목 합계 <b>${calc.ratioPercentTotal}%</b> (${base} 기준)`,
    ];
    if (calc.ratioPercentTotal > 100) lines.push(`<span class="warn">⚠ 비율 합계가 100%를 넘습니다.</span>`);
    else if (calc.ratioPercentTotal < 100) lines.push(`<span class="muted">비율 합계가 100%보다 ${Math.round((100 - calc.ratioPercentTotal) * 100) / 100}% 적어 일부 수입은 배분되지 않습니다.</span>`);
    if (hasIncome) {
      lines.push(`이번 기간 수입 ${won(income)} 기준: 배분 ${won(calc.allocated)}` +
        (calc.unallocated >= 0 ? ` · 남는 돈 ${won(calc.unallocated)}` : ` · <span class="warn">${won(-calc.unallocated)} 부족</span>`));
      if (state.settings.ratioBase === 'afterFixed' && calc.fixedTotal > income) {
        lines.push('<span class="warn">⚠ 고정 항목 합계가 수입보다 큽니다.</span>');
      }
    }
    $('#plan-summary').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }

  function addCategory() {
    state.categories.push({ id: `c-${uid()}`, name: '새 항목', type: 'ratio', value: 0, keywords: [] });
    commitPlan(true);
    const inputs = document.querySelectorAll('.pl-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }

  // ---------- 백업 ----------

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `지출관리-백업-${L.todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm('현재 데이터를 백업 파일의 내용으로 바꿀까요?')) return;
        state = L.normalizeState(parsed);
        save();
        currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
        toast('백업을 불러왔습니다.');
        render();
      } catch (e) {
        toast('올바른 백업 파일이 아닙니다.');
      }
    };
    reader.readAsText(file);
  }

  // ---------- 렌더 & 이벤트 ----------

  function activeTab() {
    const t = document.querySelector('.tab.active');
    return t ? t.dataset.tab : 'dashboard';
  }

  function render() {
    renderPeriod();
    const tab = activeTab();
    if (tab === 'dashboard') renderDashboard();
    else if (tab === 'add') renderAddTab();
    else if (tab === 'list') renderList();
    else if (tab === 'plan') renderPlan();
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.tab === 'list' && activeTab() !== 'list') listFilter = 'all';
    showTab(t.dataset.tab);
  }));
  $('#prev-period').addEventListener('click', () => {
    currentPeriod = L.shiftPeriod(currentPeriod, -1, state.settings.startDay);
    $('#income-box').dataset.editing = '';
    render();
  });
  $('#next-period').addEventListener('click', () => {
    currentPeriod = L.shiftPeriod(currentPeriod, 1, state.settings.startDay);
    $('#income-box').dataset.editing = '';
    render();
  });
  $('#today-period').addEventListener('click', () => {
    currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
    render();
  });

  $('#manual-form').addEventListener('submit', onManualSubmit);
  formatOnBlur($('#m-amount'));
  $('#m-memo').addEventListener('input', updateManualHint);
  $('#m-category').addEventListener('change', updateManualHint);
  $('#parse-btn').addEventListener('click', onParse);
  $('#paste-clear').addEventListener('click', () => {
    $('#paste-input').value = '';
    parsedItems = [];
    renderParseResult();
  });

  $('#list-filter').addEventListener('change', (e) => {
    listFilter = e.target.value;
    renderList();
  });
  $('#reclassify-btn').addEventListener('click', reclassifyUnclassified);

  $('#start-day').addEventListener('change', (e) => {
    const newDay = Number(e.target.value);
    const moved = Object.keys(state.incomes).length > 0;
    state.settings.startDay = newDay;
    // 입력해 둔 수입을 새 기간 기준으로 옮긴다 (같은 달에 시작하는 기간으로)
    if (moved) {
      const next = {};
      for (const [key, val] of Object.entries(state.incomes)) {
        const { y, m } = L.parseISO(key);
        const start = L.toISO(y, m, Math.min(newDay, L.daysInMonth(y, m)));
        next[start] = val;
      }
      state.incomes = next;
    }
    currentPeriod = L.getPeriod(L.todayISO(), newDay);
    save();
    renderPeriod();
    renderPlanSummary();
    toast(`이제 매월 ${newDay}일에 새 기간이 시작됩니다.`);
  });
  $('#ratio-base').addEventListener('change', (e) => {
    state.settings.ratioBase = e.target.value;
    commitPlan();
  });
  $('#add-category').addEventListener('click', addCategory);
  $('#export-btn').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('모든 지출 내역, 수입, 계획을 지우고 처음 상태로 되돌릴까요? (되돌릴 수 없습니다)')) return;
    state = L.defaultState();
    save();
    currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
    toast('초기화했습니다.');
    render();
  });

  // 기간 시작일에 수입이 아직 없으면 대시보드에서 바로 입력하도록 안내
  render();
})();
