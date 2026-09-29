/* 지출 관리 앱 UI. 계산 로직은 js/logic.js (BudgetLogic) 에 있다.
 *
 * 저장 방식 두 가지:
 *  - local : 이 브라우저(localStorage)에만 저장, 키워드로 분류
 *  - remote: 구글 Apps Script 서버(구글 시트)에 저장, Claude AI 로 분류, 카드 문자 자동 입력
 *            Apps Script 가 이 화면을 직접 제공하면 자동으로 remote, 아니면 설정 탭에서 서버 주소를 연결
 */
(function () {
  'use strict';

  const L = window.BudgetLogic;
  const STORAGE_KEY = 'budget-app-v1';
  const SERVER_KEY = 'budget-app-server';

  // ---------- 유틸 ----------

  const $ = (sel) => document.querySelector(sel);
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

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

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

  function formatOnBlur(input) {
    input.addEventListener('blur', () => {
      const n = parseAmountInput(input.value);
      if (n !== null) input.value = n.toLocaleString('ko-KR');
    });
  }

  // ---------- 저장소 ----------

  function readServerConfig() {
    if (window.__BUDGET_SERVER__ && window.__BUDGET_SERVER__.key) return { ...window.__BUDGET_SERVER__, embedded: true };
    try {
      const raw = localStorage.getItem(SERVER_KEY);
      const c = raw ? JSON.parse(raw) : null;
      return c && c.url && c.key ? c : null;
    } catch (e) {
      return null;
    }
  }

  const server = readServerConfig();
  const mode = server ? 'remote' : 'local';
  let aiEnabled = false;
  let serviceUrl = server ? server.url : '';

  function callApi(action, payload) {
    const req = { key: server.key, action, payload: payload || {} };
    const unwrap = (r) => {
      if (!r || !r.ok) throw new Error((r && r.error) || '서버 응답 오류');
      return r;
    };
    if (window.google && google.script && google.script.run) {
      return new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler((r) => {
            try {
              resolve(unwrap(r));
            } catch (e) {
              reject(e);
            }
          })
          .withFailureHandler(reject)
          .api(req);
      });
    }
    // text/plain 으로 보내면 CORS 사전 요청 없이 Apps Script 로 보낼 수 있다
    return fetch(server.url, { method: 'POST', body: JSON.stringify(req) })
      .then((r) => r.json())
      .then(unwrap);
  }

  function metaOf(s) {
    const { transactions, ...meta } = s;
    return meta;
  }

  let state = L.defaultState();
  let metaTimer = null;

  const store = {
    async init() {
      if (mode === 'local') {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          state = L.normalizeState(raw ? JSON.parse(raw) : null);
        } catch (e) {
          state = L.defaultState();
        }
        return;
      }
      const r = await callApi('load');
      state = L.normalizeState(r.state);
      aiEnabled = !!r.ai;
      if (r.url) serviceUrl = r.url;
    },

    saveLocal() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        toast('저장하지 못했습니다. 브라우저 저장공간 설정을 확인하세요.');
      }
    },

    // 계획·수입·학습 정보 저장. 서버에는 입력이 멈춘 뒤 한 번에 보낸다.
    saveMeta() {
      if (mode === 'local') return store.saveLocal();
      clearTimeout(metaTimer);
      metaTimer = setTimeout(() => store.flushMeta(), 700);
    },

    async flushMeta() {
      if (mode === 'local' || !metaTimer) return;
      clearTimeout(metaTimer);
      metaTimer = null;
      try {
        await callApi('saveMeta', { meta: metaOf(state) });
      } catch (e) {
        toast(`설정 저장 실패: ${e.message}`, 5000);
      }
    },

    // items: [{date, amount, memo}] → [{categoryId, method}]
    async classify(items) {
      if (mode === 'local') {
        return items.map((it) => L.classifyLocal(it.memo, planForDate(it.date).categories, state.merchantMap));
      }
      await store.flushMeta();
      return (await callApi('classify', { items })).results;
    },

    // items: [{date, amount, memo, categoryId ('__auto' 이면 자동 분류), method, source, raw}]
    async addTransactions(items) {
      if (mode === 'local') {
        const auto = items.filter((it) => it.categoryId === '__auto');
        const res = await store.classify(auto);
        auto.forEach((it, i) => Object.assign(it, res[i]));
        const now = nowISO();
        const added = items.map((it) => ({
          id: uid(),
          date: it.date,
          amount: it.amount,
          memo: it.memo,
          categoryId: it.categoryId || null,
          method: it.categoryId ? it.method || 'manual' : null,
          source: it.source || 'app',
          raw: it.raw || '',
          createdAt: now,
          classifiedAt: now,
        }));
        state.transactions.push(...added);
        store.saveLocal();
        return added;
      }
      await store.flushMeta();
      const r = await callApi('addTransactions', { items });
      state.transactions.push(...r.added);
      return r.added;
    },

    async updateTransaction(id, patch) {
      const t = state.transactions.find((x) => x.id === id);
      if (mode === 'local') {
        Object.assign(t, patch, { classifiedAt: nowISO() });
        store.saveLocal();
        return t;
      }
      await store.flushMeta();
      const r = await callApi('updateTransaction', { id, patch });
      Object.assign(t, r.tx);
      return t;
    },

    async deleteTransaction(id) {
      if (mode === 'remote') await callApi('deleteTransaction', { id });
      state.transactions = state.transactions.filter((x) => x.id !== id);
      if (mode === 'local') store.saveLocal();
    },

    // 기간 안의 지출을 그 기간 계획에 맞춰 다시 분류. 반환: 바뀐 지출 수
    async reclassify(period, onlyUnclassified) {
      if (mode === 'remote') {
        await store.flushMeta();
        const r = await callApi('reclassify', { start: period.start, end: period.end, onlyUnclassified });
        for (const u of r.updated) Object.assign(state.transactions.find((t) => t.id === u.id) || {}, u);
        return r.updated.length;
      }
      const plan = planForDate(period.start);
      const known = new Set(plan.categories.map((c) => c.id));
      const targets = state.transactions.filter((t) => {
        if (t.date < period.start || t.date > period.end) return false;
        const exists = known.has(t.categoryId);
        return onlyUnclassified ? !exists : !(t.method === 'manual' && exists);
      });
      const res = await store.classify(targets);
      const now = nowISO();
      targets.forEach((t, i) => Object.assign(t, res[i], { classifiedAt: now }));
      store.saveLocal();
      return targets.length;
    },

    async refresh() {
      if (mode === 'remote') await store.init();
    },
  };

  // ---------- 상태 ----------

  let currentPeriod = L.getPeriod(L.todayISO(), 1);
  let listFilter = 'all';
  let parsedItems = [];
  let parsedSkipped = [];

  function planForDate(date) {
    return L.planFor(state, L.getPeriod(date, state.settings.startDay).key);
  }

  function currentPlan() {
    return L.planFor(state, currentPeriod.key);
  }

  function categoryName(id, categories = currentPlan().categories) {
    const c = categories.find((x) => x.id === id);
    return c ? c.name : '미분류';
  }

  function categoryOptions(categories, selected, { includeAuto = false } = {}) {
    const opts = [];
    if (includeAuto) opts.push(`<option value="__auto">자동 분류${aiEnabled ? ' (AI)' : ''}</option>`);
    opts.push(`<option value="" ${!selected ? 'selected' : ''}>미분류</option>`);
    for (const c of categories) {
      opts.push(`<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`);
    }
    return opts.join('');
  }

  const METHOD_LABEL = { ai: 'AI', learned: '기억', keyword: '키워드', manual: '직접' };

  function methodTag(method) {
    return method && METHOD_LABEL[method] ? `<span class="tag">${METHOD_LABEL[method]}</span>` : '';
  }

  // ---------- 탭 ----------

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    render();
  }

  function activeTab() {
    const t = document.querySelector('.tab.active');
    return t ? t.dataset.tab : 'dashboard';
  }

  // ---------- 머리글 ----------

  function renderHeader() {
    const chip = $('#conn-status');
    if (mode === 'local') {
      chip.textContent = '이 기기에만 저장';
      chip.className = 'chip';
    } else {
      chip.textContent = aiEnabled ? '구글 시트 · AI 분류' : '구글 시트 · AI 꺼짐';
      chip.className = `chip ${aiEnabled ? 'on' : ''}`;
    }
    $('#refresh-btn').hidden = mode !== 'remote';
  }

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
        <b>자산관리계획이 바뀌었어요.</b>
        <p class="small">바뀐 계획에 맞춰 아직 다시 분류하지 않은 지출이 ${sum.staleCount}건 있어요. 직접 고른 항목은 그대로 두고 나머지를 새 항목 기준으로 분류합니다.</p>
        <button id="stale-reclassify" class="primary-btn">새 계획으로 다시 분류${aiEnabled ? ' (AI)' : ''}</button>
      </div>`;
    $('#stale-reclassify').addEventListener('click', () => runReclassify(false));
  }

  function renderDashboard() {
    const sum = L.summarizePeriod(state, currentPeriod);
    renderIncomeBox(sum);
    renderStaleBox(sum);

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
    if (!sum.plan.categories.length) {
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
    const hint = $('#auto-hint');
    if (mode === 'remote') {
      hint.innerHTML = '<b>카드 문자는 자동으로 들어와요.</b> <span class="small">휴대폰 자동화(설정 탭 참고)를 해 두면 결제 문자가 올 때마다 AI가 읽고 분류해서 기록합니다. 아래는 문자 외의 지출을 넣을 때 쓰세요.</span>';
    } else {
      hint.innerHTML = '<b>지금은 이 기기에만 저장하는 모드예요.</b> <span class="small">카드 문자 자동 입력과 AI 분류를 쓰려면 설정 탭에서 구글 시트 서버를 연결하세요.</span>';
    }
    $('#classifier-name').textContent = aiEnabled ? 'AI가 항목' : '키워드로 항목';

    const sel = $('#m-category');
    const prev = sel.value || '__auto';
    sel.innerHTML = categoryOptions(planForDate($('#m-date').value || L.todayISO()).categories, null, { includeAuto: true });
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '__auto';
    if (!$('#m-date').value) $('#m-date').value = L.todayISO();
    updateManualHint();
    renderParseResult();
  }

  function updateManualHint() {
    const memo = $('#m-memo').value;
    if ($('#m-category').value !== '__auto' || !memo.trim()) {
      $('#m-hint').textContent = '';
      return;
    }
    if (aiEnabled) {
      $('#m-hint').textContent = '추가하면 AI가 항목을 정합니다.';
      return;
    }
    const plan = planForDate($('#m-date').value || L.todayISO());
    const r = L.classifyLocal(memo, plan.categories, state.merchantMap);
    $('#m-hint').textContent = `자동 분류 결과: ${categoryName(r.categoryId, plan.categories)}`;
  }

  async function onManualSubmit(e) {
    e.preventDefault();
    const date = $('#m-date').value;
    const amount = parseAmountInput($('#m-amount').value);
    const memo = $('#m-memo').value.trim() || '(내용 없음)';
    if (!date) return toast('날짜를 입력해 주세요.');
    if (amount === null || amount === 0) return toast('금액을 입력해 주세요.');
    const sel = $('#m-category').value;
    if (sel && sel !== '__auto') {
      state.merchantMap[L.normalizeMerchant(memo)] = sel;
      store.saveMeta();
    }
    const [tx] = await busy(sel === '__auto' && aiEnabled ? 'AI가 분류하는 중…' : null, () =>
      store.addTransactions([{ date, amount, memo, categoryId: sel === '' ? null : sel, method: sel && sel !== '__auto' ? 'manual' : undefined, source: 'manual' }])
    );
    $('#m-amount').value = '';
    $('#m-memo').value = '';
    updateManualHint();
    toast(`${categoryName(tx.categoryId, planForDate(tx.date).categories)} 항목에 ${won(amount)} 추가했습니다.`);
    jumpToDate(date);
  }

  function jumpToDate(date) {
    const p = L.getPeriod(date, state.settings.startDay);
    if (p.key !== currentPeriod.key) currentPeriod = p;
    render();
  }

  async function onParse() {
    const { items, skipped } = L.parseExpenseText($('#paste-input').value, L.todayISO());
    parsedSkipped = skipped;
    parsedItems = items.map((it) => ({ ...it, categoryId: null, method: null, checked: !L.isDuplicate(it, state.transactions), dup: L.isDuplicate(it, state.transactions) }));
    if (parsedItems.length) {
      const res = await busy(aiEnabled ? `AI가 ${parsedItems.length}건을 분류하는 중…` : null, () =>
        store.classify(parsedItems.map(({ date, amount, memo }) => ({ date, amount, memo })))
      );
      parsedItems.forEach((it, i) => Object.assign(it, res[i]));
    }
    renderParseResult();
  }

  function renderParseResult() {
    const el = $('#parse-result');
    if (!parsedItems.length && !parsedSkipped.length) {
      el.innerHTML = '';
      return;
    }
    const rows = parsedItems.map((it, i) => `
      <tr>
        <td><input type="checkbox" data-i="${i}" class="p-check" ${it.checked ? 'checked' : ''} aria-label="추가"></td>
        <td><input type="date" data-i="${i}" class="p-date" value="${it.date}"></td>
        <td class="memo">${esc(it.memo)} ${it.dup ? '<span class="tag warn">중복?</span>' : ''} ${methodTag(it.method)}</td>
        <td class="amount ${it.amount < 0 ? 'refund' : ''}">${won(it.amount)}</td>
        <td><select data-i="${i}" class="p-cat">${categoryOptions(planForDate(it.date).categories, it.categoryId)}</select></td>
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
      ${parsedSkipped.length ? `<p class="muted small">금액을 찾지 못해 건너뛴 줄 ${parsedSkipped.length}개: ${parsedSkipped.map(esc).join(' / ')}</p>` : ''}`;

    el.querySelectorAll('.p-check').forEach((c) => c.addEventListener('change', () => {
      parsedItems[c.dataset.i].checked = c.checked;
      renderParseResult();
    }));
    el.querySelectorAll('.p-date').forEach((c) => c.addEventListener('change', () => (parsedItems[c.dataset.i].date = c.value)));
    el.querySelectorAll('.p-cat').forEach((c) => c.addEventListener('change', () => {
      const it = parsedItems[c.dataset.i];
      it.categoryId = c.value || null;
      it.method = c.value ? 'manual' : null;
    }));
    const addBtn = $('#p-add');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const chosen = parsedItems.filter((x) => x.checked && x.date);
      if (!chosen.length) return toast('추가할 항목을 선택해 주세요.');
      let learned = false;
      for (const it of chosen) {
        if (it.method === 'manual' && it.categoryId) {
          state.merchantMap[L.normalizeMerchant(it.memo)] = it.categoryId;
          learned = true;
        }
      }
      if (learned) store.saveMeta();
      await busy('저장하는 중…', () =>
        store.addTransactions(chosen.map((it) => ({ date: it.date, amount: it.amount, memo: it.memo, categoryId: it.categoryId, method: it.method, source: 'paste', raw: it.raw })))
      );
      parsedItems = [];
      parsedSkipped = [];
      $('#paste-input').value = '';
      toast(`${chosen.length}건을 추가했습니다.`);
      jumpToDate(chosen[0].date);
    });
  }

  // ---------- 지출 내역 ----------

  function renderList() {
    const sum = L.summarizePeriod(state, currentPeriod);
    const cats = sum.plan.categories;
    const known = new Set(cats.map((c) => c.id));
    if (listFilter !== 'all' && listFilter !== '__none' && !known.has(listFilter)) listFilter = 'all';
    const filterSel = $('#list-filter');
    filterSel.innerHTML = `<option value="all">전체 항목</option><option value="__none">미분류</option>` +
      cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    filterSel.value = listFilter;
    $('#reclassify-all').textContent = `이 기간 전체 다시 분류${aiEnabled ? ' (AI)' : ''}`;

    const txs = sum.transactions
      .filter((t) => {
        if (listFilter === 'all') return true;
        if (listFilter === '__none') return !known.has(t.categoryId);
        return t.categoryId === listFilter;
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

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
                <td class="memo">${esc(t.memo)} ${t.source === 'sms' ? '<span class="tag">문자</span>' : ''}</td>
                <td class="amount ${t.amount < 0 ? 'refund' : ''}">${won(t.amount)}</td>
                <td class="cat-cell"><select data-id="${esc(t.id)}" class="tx-cat" aria-label="항목">${categoryOptions(cats, known.has(t.categoryId) ? t.categoryId : null)}</select>${known.has(t.categoryId) ? methodTag(t.method) : ''}</td>
                <td><button class="link-btn tx-del" data-id="${esc(t.id)}" aria-label="삭제">✕</button></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="2">합계 ${txs.length}건</th><th class="amount">${won(total)}</th><th colspan="2"></th></tr></tfoot>
        </table>
      </div>`;

    el.querySelectorAll('.tx-cat').forEach((s) => s.addEventListener('change', async () => {
      const t = state.transactions.find((x) => x.id === s.dataset.id);
      const key = L.normalizeMerchant(t.memo);
      if (s.value) state.merchantMap[key] = s.value;
      else delete state.merchantMap[key];
      store.saveMeta();
      await busy(null, () => store.updateTransaction(t.id, { categoryId: s.value || null, method: s.value ? 'manual' : null }));
      toast(`'${t.memo}' 은(는) 앞으로 ${categoryName(t.categoryId, cats)}(으)로 분류합니다.`);
      render();
    }));
    el.querySelectorAll('.tx-del').forEach((b) => b.addEventListener('click', async () => {
      const t = state.transactions.find((x) => x.id === b.dataset.id);
      if (!confirm(`'${t.memo}' ${won(t.amount)} 내역을 삭제할까요?`)) return;
      await busy(null, () => store.deleteTransaction(t.id));
      render();
    }));
  }

  async function runReclassify(onlyUnclassified) {
    const label = aiEnabled ? 'AI가 다시 분류하는 중…' : '다시 분류하는 중…';
    const n = await busy(label, () => store.reclassify(currentPeriod, onlyUnclassified));
    toast(n ? `${n}건을 다시 분류했습니다.` : '다시 분류할 지출이 없습니다.');
    render();
  }

  // ---------- 자산관리계획 ----------

  // 이 기간의 계획을 고치기 전에 호출: 지난 기간 계획을 물려받고 있었다면 이 기간부터 적용되는 새 계획을 만든다.
  function editablePlan() {
    const plan = L.ensurePlanFor(state, currentPeriod.key, nowISO());
    plan.updatedAt = nowISO();
    return plan;
  }

  function renderPlanVersion() {
    const plan = currentPlan();
    const inherited = plan.from !== currentPeriod.key;
    const nextFrom = L.nextPlanAfter(state, { from: currentPeriod.key });
    const parts = [];
    parts.push(`<b>${fmtDate(currentPeriod.start)} 기간의 계획</b>`);
    if (plan.from === L.BASE_PLAN_FROM) parts.push('처음부터 쓰던 계획입니다.');
    else parts.push(`${fmtDate(plan.from)} 기간부터 적용된 계획입니다.`);
    if (inherited) parts.push('여기서 고치면 <b>이번 기간부터</b> 새 계획으로 저장되고, 지난 기간은 그때 계획 그대로 남아요.');
    else parts.push('고치면 이 기간과 이후 기간에 적용되고, 지난 기간은 그대로 남아요.');
    if (nextFrom) parts.push(`${fmtDate(nextFrom.from)} 기간부터는 그 뒤에 바꾼 계획이 적용돼요.`);
    $('#plan-version').innerHTML = parts.map((p) => `<div class="small">${p}</div>`).join('');
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
        const plan = editablePlan();
        plan.categories = plan.categories.filter((x) => x.id !== id);
        store.saveMeta();
        renderPlan();
      });
    });
    renderPlanSummary();
  }

  function renderPlanSummary() {
    const plan = currentPlan();
    const income = state.incomes[currentPeriod.key];
    const hasIncome = typeof income === 'number';
    const calc = L.computeBudgets(plan.categories, hasIncome ? income : 0, plan.ratioBase);

    document.querySelectorAll('.plan-row[data-id]').forEach((row) => {
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
    const inputs = document.querySelectorAll('.pl-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }

  // ---------- 설정 ----------

  function smsUrl() {
    return serviceUrl ? `${serviceUrl}?action=sms&key=${encodeURIComponent(server.key)}` : '';
  }

  function renderSettings() {
    const sd = $('#start-day');
    if (!sd.options.length) {
      sd.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">매월 ${i + 1}일</option>`).join('');
    }
    sd.value = String(state.settings.startDay);

    const card = $('#connection-card');
    if (mode === 'remote') {
      const url = smsUrl();
      card.innerHTML = `
        <h2>구글 시트 서버</h2>
        <p class="small">지출은 구글 시트에 저장되고, ${aiEnabled ? '<b>Claude AI가 분류</b>합니다.' : '<b>AI 키가 없어 키워드로 분류</b>합니다. Apps Script 스크립트 속성에 ANTHROPIC_API_KEY 를 넣으면 AI 분류가 켜져요.'}</p>
        <h3>카드 문자 자동 입력 (MacroDroid)</h3>
        <p class="muted small">MacroDroid 의 "HTTP 요청" 동작에 아래 주소를 넣고, 방식은 POST, 본문은 받은 문자 내용으로 설정하세요. 자세한 방법은 저장소의 <b>SETUP.md</b> 에 있어요.</p>
        <div class="copy-row">
          <input type="text" id="sms-url" readonly value="${esc(url || '(웹앱 주소를 알 수 없음)')}">
          <button id="copy-sms-url" class="ghost-btn">복사</button>
        </div>
        ${server.embedded ? '' : '<div class="row-actions"><button id="disconnect-btn" class="danger-btn">연결 해제 (이 기기 저장으로)</button></div>'}`;
      $('#copy-sms-url').addEventListener('click', () => copyText(url));
      const dc = $('#disconnect-btn');
      if (dc) dc.addEventListener('click', () => {
        if (!confirm('서버 연결을 해제할까요? 구글 시트의 데이터는 그대로 남아 있습니다.')) return;
        try {
          localStorage.removeItem(SERVER_KEY);
        } catch (e) {
          /* 무시 */
        }
        location.reload();
      });
    } else {
      card.innerHTML = `
        <h2>구글 시트 서버 연결 (AI 분류 · 문자 자동 입력)</h2>
        <p class="muted small">저장소의 <b>SETUP.md</b> 대로 구글 Apps Script 를 배포하면 받는 웹앱 주소와 APP_KEY 를 넣으세요. 웹앱 주소(<code>?key=</code> 포함)로 바로 접속해도 됩니다.</p>
        <form id="connect-form" class="form-grid">
          <label class="wide">웹앱 주소<input type="url" id="c-url" placeholder="https://script.google.com/macros/s/…/exec" required></label>
          <label>APP_KEY<input type="text" id="c-key" required></label>
          <div class="form-submit"><button type="submit" class="primary-btn">연결</button></div>
        </form>`;
      $('#connect-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = $('#c-url').value.trim().replace(/\?.*$/, '');
        const key = $('#c-key').value.trim();
        try {
          const r = await busy('연결 확인 중…', () =>
            fetch(url, { method: 'POST', body: JSON.stringify({ key, action: 'ping' }) }).then((x) => x.json())
          );
          if (!r.ok) throw new Error(r.error || '연결 실패');
          localStorage.setItem(SERVER_KEY, JSON.stringify({ url, key }));
          if (state.transactions.length && confirm('이 기기에 있던 계획과 지출을 구글 시트로 옮길까요?')) {
            localStorage.setItem('budget-app-migrate', '1');
          }
          location.reload();
        } catch (err) {
          toast(`연결하지 못했습니다: ${err.message || err}`, 5000);
        }
      });
    }

    $('#data-note').textContent = mode === 'remote'
      ? '데이터는 구글 시트에 저장됩니다. 백업 불러오기를 하면 백업의 계획을 적용하고 지출을 시트에 추가합니다.'
      : '모든 데이터는 이 브라우저에만 저장됩니다. 다른 기기로 옮기거나 백업하려면 내보내기를 사용하세요.';
    $('#reset-btn').hidden = mode === 'remote';
  }

  function copyText(text) {
    const done = () => toast('복사했습니다.');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    const input = $('#sms-url');
    input.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      toast('길게 눌러 직접 복사해 주세요.');
    }
  }

  async function changeStartDay(newDay) {
    L.remapPeriodKeys(state, newDay);
    currentPeriod = L.getPeriod(L.todayISO(), newDay);
    store.saveMeta();
    renderPeriod();
    toast(`이제 매월 ${newDay}일에 새 기간이 시작됩니다.`);
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

  async function importState(imported) {
    if (mode === 'local') {
      state = imported;
      store.saveLocal();
      return;
    }
    const txs = imported.transactions;
    state = { ...imported, transactions: state.transactions };
    await callApi('saveMeta', { meta: metaOf(state) });
    const existing = state.transactions;
    const fresh = txs.filter((t) => !L.isDuplicate(t, existing));
    for (let i = 0; i < fresh.length; i += 200) {
      await store.addTransactions(
        fresh.slice(i, i + 200).map((t) => ({ date: t.date, amount: t.amount, memo: t.memo, categoryId: t.categoryId || null, method: t.method || (t.categoryId ? 'manual' : null), source: t.source || 'import', raw: t.raw || '' }))
      );
    }
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try {
        parsed = L.normalizeState(JSON.parse(reader.result));
      } catch (e) {
        return toast('올바른 백업 파일이 아닙니다.');
      }
      const msg = mode === 'remote' ? '백업의 계획을 적용하고 지출을 구글 시트에 추가할까요?' : '현재 데이터를 백업 파일의 내용으로 바꿀까요?';
      if (!confirm(msg)) return;
      await busy('불러오는 중…', () => importState(parsed));
      currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
      toast('백업을 불러왔습니다.');
      render();
    };
    reader.readAsText(file);
  }

  // ---------- 렌더 & 이벤트 ----------

  function render() {
    renderHeader();
    renderPeriod();
    const tab = activeTab();
    if (tab === 'dashboard') renderDashboard();
    else if (tab === 'add') renderAddTab();
    else if (tab === 'list') renderList();
    else if (tab === 'plan') renderPlan();
    else if (tab === 'settings') renderSettings();
  }

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      if (t.dataset.tab === 'list' && activeTab() !== 'list') listFilter = 'all';
      showTab(t.dataset.tab);
    }));
    const move = (delta) => {
      currentPeriod = L.shiftPeriod(currentPeriod, delta, state.settings.startDay);
      $('#income-box').dataset.editing = '';
      render();
    };
    $('#prev-period').addEventListener('click', () => move(-1));
    $('#next-period').addEventListener('click', () => move(1));
    $('#today-period').addEventListener('click', () => {
      currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
      render();
    });
    $('#refresh-btn').addEventListener('click', async () => {
      await busy('불러오는 중…', () => store.refresh());
      render();
    });

    $('#manual-form').addEventListener('submit', onManualSubmit);
    formatOnBlur($('#m-amount'));
    $('#m-memo').addEventListener('input', updateManualHint);
    $('#m-category').addEventListener('change', updateManualHint);
    $('#m-date').addEventListener('change', renderAddTab);
    $('#parse-btn').addEventListener('click', onParse);
    $('#paste-clear').addEventListener('click', () => {
      $('#paste-input').value = '';
      parsedItems = [];
      parsedSkipped = [];
      renderParseResult();
    });

    $('#list-filter').addEventListener('change', (e) => {
      listFilter = e.target.value;
      renderList();
    });
    $('#reclassify-unclassified').addEventListener('click', () => runReclassify(true));
    $('#reclassify-all').addEventListener('click', () => runReclassify(false));

    $('#ratio-base').addEventListener('change', (e) => {
      editablePlan().ratioBase = e.target.value;
      store.saveMeta();
      renderPlanVersion();
      renderPlanSummary();
    });
    $('#add-category').addEventListener('click', addCategory);

    $('#start-day').addEventListener('change', (e) => changeStartDay(Number(e.target.value)));
    $('#export-btn').addEventListener('click', exportData);
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#reset-btn').addEventListener('click', () => {
      if (!confirm('모든 지출 내역, 수입, 계획을 지우고 처음 상태로 되돌릴까요? (되돌릴 수 없습니다)')) return;
      state = L.defaultState();
      store.saveLocal();
      currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
      toast('초기화했습니다.');
      render();
    });

    // 앱으로 돌아오면 문자로 새로 들어온 지출을 불러온다
    document.addEventListener('visibilitychange', async () => {
      // 앱을 떠날 때 아직 보내지 않은 계획·수입 변경을 바로 저장
      if (document.visibilityState === 'hidden') {
        store.flushMeta();
        return;
      }
      if (mode === 'remote' && !busyCount && !metaTimer) {
        try {
          await store.refresh();
          render();
        } catch (e) {
          /* 다음에 다시 시도 */
        }
      }
    });
  }

  async function start() {
    bindEvents();
    // 이 기기 데이터를 서버로 옮기기 (연결 직후 한 번)
    let localToMigrate = null;
    if (mode === 'remote') {
      try {
        if (localStorage.getItem('budget-app-migrate') === '1') {
          localStorage.removeItem('budget-app-migrate');
          localToMigrate = L.normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
        }
      } catch (e) {
        localToMigrate = null;
      }
    }
    try {
      await busy(mode === 'remote' ? '불러오는 중…' : null, () => store.init());
    } catch (e) {
      $('#category-rows').innerHTML = `<div class="empty">서버에 연결하지 못했습니다. (${esc(e.message || e)})<br>설정 탭에서 주소와 키를 확인하세요.</div>`;
    }
    if (localToMigrate) {
      await busy('이 기기 데이터를 옮기는 중…', () => importState(localToMigrate));
      toast('이 기기 데이터를 구글 시트로 옮겼습니다.');
    }
    currentPeriod = L.getPeriod(L.todayISO(), state.settings.startDay);
    render();
  }

  start();
})();
