/* 저장소. 두 가지 방식을 같은 함수로 다룬다.
 *  - local : 이 브라우저(localStorage)에만 저장, 키워드로 분류
 *  - remote: 구글 Apps Script 서버(구글 시트)에 저장, Claude AI 로 분류, 알림 자동 입력
 *            Apps Script 가 화면을 직접 제공하면 자동으로 remote, 아니면 설정에서 서버 주소를 연결
 */
(function (root) {
  'use strict';

  const L = root.BudgetLogic;
  const STORAGE_KEY = 'budget-app-v1';
  const SERVER_KEY = 'budget-app-server';
  const MIGRATE_KEY = 'budget-app-migrate';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowISO = () => new Date().toISOString();

  const KEY_STORE = 'budget-app-key';

  function readServerConfig() {
    // 구글 Apps Script 가 화면을 직접 줄 때: 키는 주소(?key=) 또는 이 기기에 기억한 값
    if (root.__BUDGET_SERVER__) {
      let key = root.__BUDGET_SERVER__.key || '';
      try {
        if (key) localStorage.setItem(KEY_STORE, key);
        else key = localStorage.getItem(KEY_STORE) || '';
      } catch (e) {
        /* 기억 못 하면 매번 입력 */
      }
      return { ...root.__BUDGET_SERVER__, key, embedded: true };
    }
    try {
      const raw = localStorage.getItem(SERVER_KEY);
      const c = raw ? JSON.parse(raw) : null;
      return c && c.url && c.key ? c : null;
    } catch (e) {
      return null;
    }
  }

  const server = readServerConfig();

  const store = {
    mode: server ? 'remote' : 'local',
    server,
    aiEnabled: false,
    aiModel: '',
    aiModels: [],
    aiError: '',
    serviceUrl: server ? server.url : '',
    state: L.defaultState(),
    onError: () => {},
  };

  let metaTimer = null;

  function callApi(action, payload, target = server) {
    const req = { key: target.key, action, payload: payload || {} };
    const unwrap = (r) => {
      if (!r || !r.ok) throw new Error((r && r.error) || '서버 응답 오류');
      return r;
    };
    if (target === server && root.google && root.google.script && root.google.script.run) {
      return new Promise((resolve, reject) => {
        root.google.script.run
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
    return fetch(target.url, { method: 'POST', body: JSON.stringify(req) })
      .then((r) => r.json())
      .then(unwrap);
  }

  function metaOf(s) {
    const { transactions, ...meta } = s;
    return meta;
  }

  function planForDate(date) {
    return L.planFor(store.state, L.getPeriod(date, store.state.settings.startDay).key);
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.state));
    } catch (e) {
      store.onError(new Error('저장하지 못했습니다. 브라우저 저장공간 설정을 확인하세요.'));
    }
  }

  function readLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? L.normalizeState(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  function applyStatus(r) {
    store.aiEnabled = !!r.ai;
    store.aiModel = r.model || '';
    store.aiModels = r.models || [];
    store.aiError = r.lastError || '';
    if (r.url) store.serviceUrl = r.url;
  }

  function isExpense(it) {
    return !it.kind || it.kind === 'expense';
  }

  Object.assign(store, {
    planForDate,
    readLocalState,

    async init() {
      if (store.mode === 'local') {
        store.state = readLocalState() || L.defaultState();
        return;
      }
      const r = await callApi('load');
      store.state = L.normalizeState(r.state);
      applyStatus(r);
    },

    // 처음 접속할 때 입력한 키가 맞는지 확인하고 기억한다
    async useKey(key) {
      const prev = server.key;
      server.key = key;
      try {
        applyStatus(await callApi('ping'));
        try {
          localStorage.setItem(KEY_STORE, key);
        } catch (e) {
          /* 무시 */
        }
      } catch (e) {
        server.key = prev;
        throw e;
      }
    },

    forgetKey() {
      try {
        localStorage.removeItem(KEY_STORE);
      } catch (e) {
        /* 무시 */
      }
    },

    async setApiKey(apiKey) {
      applyStatus(await callApi('setApiKey', { apiKey }));
    },

    async setModel(model) {
      applyStatus(await callApi('setModel', { model }));
    },

    // 계획·수입·계좌·학습 정보 저장. 서버에는 입력이 멈춘 뒤 한 번에 보낸다.
    saveMeta() {
      if (store.mode === 'local') return saveLocal();
      clearTimeout(metaTimer);
      metaTimer = setTimeout(() => store.flushMeta(), 700);
    },

    hasPendingMeta() {
      return !!metaTimer;
    },

    async flushMeta() {
      if (store.mode === 'local' || !metaTimer) return;
      clearTimeout(metaTimer);
      metaTimer = null;
      try {
        await callApi('saveMeta', { meta: metaOf(store.state) });
      } catch (e) {
        store.onError(new Error(`설정 저장 실패: ${e.message}`));
      }
    },

    // items: [{date, amount, memo}] → [{categoryId, method}]
    async classify(items) {
      if (store.mode === 'local') {
        return items.map((it) => L.classifyLocal(it.memo, planForDate(it.date).categories, store.state.merchantMap));
      }
      await store.flushMeta();
      return (await callApi('classify', { items })).results;
    },

    // items: [{date, amount, memo, kind, accountId, categoryId ('__auto' 이면 자동 분류), method, source, raw}]
    async addTransactions(items) {
      if (store.mode === 'local') {
        const auto = items.filter((it) => isExpense(it) && it.categoryId === '__auto');
        const res = await store.classify(auto);
        auto.forEach((it, i) => Object.assign(it, res[i]));
        const now = nowISO();
        const added = items.map((it) => {
          const expense = isExpense(it);
          const categoryId = expense && it.categoryId && it.categoryId !== '__auto' ? it.categoryId : null;
          return {
            id: uid(),
            date: it.date,
            amount: it.amount,
            memo: it.memo,
            categoryId,
            method: categoryId ? it.method || 'manual' : null,
            source: it.source || 'app',
            raw: it.raw || '',
            createdAt: now,
            classifiedAt: now,
            kind: expense ? 'expense' : it.kind,
            accountId: it.accountId || null,
          };
        });
        store.state.transactions.push(...added);
        saveLocal();
        return added;
      }
      await store.flushMeta();
      const r = await callApi('addTransactions', { items });
      store.state.transactions.push(...r.added);
      return r.added;
    },

    async updateTransaction(id, patch) {
      const t = store.state.transactions.find((x) => x.id === id);
      if (store.mode === 'local') {
        Object.assign(t, patch, { classifiedAt: nowISO() });
        saveLocal();
        return t;
      }
      await store.flushMeta();
      const r = await callApi('updateTransaction', { id, patch });
      Object.assign(t, r.tx);
      return t;
    },

    async deleteTransaction(id) {
      if (store.mode === 'remote') await callApi('deleteTransaction', { id });
      store.state.transactions = store.state.transactions.filter((x) => x.id !== id);
      if (store.mode === 'local') saveLocal();
    },

    // 기간 안의 지출을 그 기간 계획에 맞춰 다시 분류. 반환: 다시 분류한 지출 수
    async reclassify(period, onlyUnclassified) {
      if (store.mode === 'remote') {
        await store.flushMeta();
        const r = await callApi('reclassify', { start: period.start, end: period.end, onlyUnclassified });
        for (const u of r.updated) Object.assign(store.state.transactions.find((t) => t.id === u.id) || {}, u);
        return r.updated.length;
      }
      const plan = planForDate(period.start);
      const known = new Set(plan.categories.map((c) => c.id));
      const targets = store.state.transactions.filter((t) => {
        if (t.date < period.start || t.date > period.end || L.kindOf(t) !== 'expense') return false;
        const exists = known.has(t.categoryId);
        return onlyUnclassified ? !exists : !(t.method === 'manual' && exists);
      });
      const res = await store.classify(targets);
      const now = nowISO();
      targets.forEach((t, i) => Object.assign(t, res[i], { classifiedAt: now }));
      saveLocal();
      return targets.length;
    },

    async refresh() {
      if (store.mode === 'remote') await store.init();
    },

    // 서버 연결 확인 (연결 전이라 주소와 키를 직접 받는다)
    ping(url, key) {
      return callApi('ping', {}, { url, key });
    },

    connect(url, key, migrate) {
      localStorage.setItem(SERVER_KEY, JSON.stringify({ url, key }));
      if (migrate) localStorage.setItem(MIGRATE_KEY, '1');
    },

    disconnect() {
      try {
        localStorage.removeItem(SERVER_KEY);
      } catch (e) {
        /* 무시 */
      }
    },

    // 서버에 연결한 직후 한 번: 이 기기에 있던 데이터를 옮길지
    takeMigration() {
      try {
        if (store.mode !== 'remote' || localStorage.getItem(MIGRATE_KEY) !== '1') return null;
        localStorage.removeItem(MIGRATE_KEY);
        return readLocalState();
      } catch (e) {
        return null;
      }
    },

    // 백업(또는 이 기기 데이터) 불러오기
    async importState(imported) {
      if (store.mode === 'local') {
        store.state = imported;
        saveLocal();
        return;
      }
      const txs = imported.transactions;
      store.state = { ...imported, transactions: store.state.transactions };
      await callApi('saveMeta', { meta: metaOf(store.state) });
      const fresh = txs.filter((t) => !L.isDuplicate(t, store.state.transactions));
      for (let i = 0; i < fresh.length; i += 200) {
        await store.addTransactions(
          fresh.slice(i, i + 200).map((t) => ({
            date: t.date,
            amount: t.amount,
            memo: t.memo,
            kind: L.kindOf(t),
            accountId: t.accountId || null,
            categoryId: t.categoryId || null,
            method: t.method || (t.categoryId ? 'manual' : null),
            source: t.source || 'import',
            raw: t.raw || '',
          }))
        );
      }
    },

    reset() {
      store.state = L.defaultState();
      saveLocal();
    },
  });

  root.BudgetStore = store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
