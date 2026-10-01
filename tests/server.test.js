// apps-script/Code.gs 를 구글 서비스 가짜 구현 위에서 실행해 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function fakeSheet(name) {
  const rows = [];
  return {
    name,
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((r) => r.length)),
    getRange(a, b, nr, nc) {
      if (typeof a === 'string') return { setNumberFormat() {} };
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[a - 1 + i] || [])[b - 1 + j] ?? '')),
        setValues(vals) {
          vals.forEach((r, i) => {
            const row = rows[a - 1 + i] || (rows[a - 1 + i] = []);
            r.forEach((v, j) => (row[b - 1 + j] = v));
          });
        },
      };
    },
    deleteRow: (r) => rows.splice(r - 1, 1),
    clearContents: () => rows.splice(0, rows.length),
    setFrozenRows() {},
  };
}

// claude: (body) => 응답 JSON 객체 (content 안의 text 로 넣을 값) 또는 { status, error }
function makeEnv({ props = {}, claude } = {}) {
  const sheets = {};
  const requests = [];
  const properties = { APP_KEY: 'secret', ...props };
  let uuid = 0;
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = fakeSheet(n)),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => properties[k] ?? null,
        setProperty: (k, v) => (properties[k] = v),
        deleteProperty: (k) => delete properties[k],
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => `id-${++uuid}-0000-4000-8000-${String(uuid).padStart(12, '0')}`,
      formatDate: () => '2026-09-29',
    },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }) },
    Logger: { log() {} },
    UrlFetchApp: {
      fetch(url, opts) {
        if (/\/v1\/models/.test(url)) {
          const code = opts.headers['x-api-key'] === 'sk-ant-good' ? 200 : 401;
          return { getResponseCode: () => code, getContentText: () => '{}' };
        }
        const body = JSON.parse(opts.payload);
        requests.push({ url, headers: opts.headers, body });
        const out = claude ? claude(body) : { status: 500, error: 'no fake' };
        if (out && out.status) {
          return { getResponseCode: () => out.status, getContentText: () => JSON.stringify({ error: { message: out.error } }) };
        }
        const resp = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(out) }] };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(resp) };
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    HtmlService: {
      createHtmlOutputFromFile: () => { throw new Error('Index 파일 없이 INDEX_HTML 을 써야 함'); },
      createHtmlOutput: (html) => ({ html, setTitle() { return this; }, addMetaTag() { return this; } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const api = (action, payload, key = 'secret') => ctx.api({ key, action, payload });
  const sms = (text, key = 'secret') => JSON.parse(ctx.doPost({ parameter: { action: 'sms', key }, postData: { contents: text } }).text);
  return { ctx, sheets, requests, properties, api, sms };
}

const msg = (o) => ({ kind: 'expense', is_cancel: false, to_savings: false, date: '2026-09-29', amount: 0, merchant: '', account_last4: '', balance: -1, categoryId: 'none', ...o });
const SMS = '[Web발신]\n신한카드(1234)승인\n홍*동\n12,000원(일시불)\n09/28 13:45\n김밥천국 역삼점\n누적1,234,567원';

test('키가 틀리면 거부한다', () => {
  const env = makeEnv();
  assert.deepEqual(JSON.parse(JSON.stringify(env.api('load', {}, 'wrong'))), { ok: false, error: 'unauthorized' });
  assert.equal(env.sms(SMS, 'wrong').ok, false);
  // 화면은 열리지만 틀린 키는 넣어 주지 않는다 (앱이 키를 다시 묻는다)
  assert.match(env.ctx.doGet({ parameter: { key: 'nope' } }).html, /window\.__BUDGET_SERVER__ = \{"key":"",/);
});

test('웹앱 화면에 서버 설정을 넣어 준다', () => {
  const env = makeEnv();
  const out = env.ctx.doGet({ parameter: { key: 'secret' } });
  assert.match(out.html, /window\.__BUDGET_SERVER__ = \{"key":"secret","url":"https:\/\/script\.google\.com\/macros\/s\/X\/exec"\}/);
  assert.match(out.html, /<div class="app">/); // 화면 전체가 Code.gs 안에 들어 있다
});

test('카드 문자 → Claude 가 읽고 분류해서 시트에 기록', () => {
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk-test' },
    claude: () => msg({ date: '2026-09-28', amount: 12000, merchant: '김밥천국 역삼점', categoryId: 'c-food' }),
  });
  const r = env.sms(SMS);
  assert.equal(r.saved, true);
  assert.equal(r.tx.categoryId, 'c-food');
  assert.equal(r.tx.method, 'ai');

  // 요청 형식
  const req = env.requests[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-test');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.match(JSON.parse(req.body.messages[0].content).message, /김밥천국/);

  // 시트에 기록됨
  const rows = env.sheets['지출'].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(1, 8), ['2026-09-28', 12000, '김밥천국 역삼점', 'c-food', '식비', 'ai', 'sms']);
  assert.deepEqual(rows[1].slice(11), ['expense', '']);

  // 같은 문자가 또 오면 중복으로 무시
  assert.equal(env.sms(SMS).reason, 'duplicate');
});

test('Haiku 로 바꾸면 effort·fallbacks 를 보내지 않는다', () => {
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk', CLAUDE_MODEL: 'claude-haiku-4-5' },
    claude: () => msg({ kind: 'not_transaction', amount: 0, categoryId: 'none' }),
  });
  assert.equal(env.sms('광고 문자 10,000원 할인 결제').reason, 'not_transaction');
  const body = env.requests[0].body;
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.output_config.effort, undefined);
  assert.equal(body.fallbacks, undefined);
});

test('API 키가 없거나 AI 호출이 실패하면 규칙으로 읽고 키워드로 분류', () => {
  const noKey = makeEnv();
  const r = noKey.sms(SMS);
  assert.equal(r.saved, true);
  assert.equal(r.tx.amount, 12000);
  assert.equal(r.tx.memo, '김밥천국 역삼점');
  assert.equal(r.tx.categoryId, 'c-food'); // '김밥' 키워드
  assert.equal(r.tx.method, 'keyword');
  assert.equal(noKey.sms('[Web발신] 인증번호 [482913]').saved, false);

  const failing = makeEnv({ props: { ANTHROPIC_API_KEY: 'sk' }, claude: () => ({ status: 529, error: 'overloaded' }) });
  const f = failing.sms(SMS);
  assert.equal(f.saved, true);
  assert.equal(f.tx.method, 'keyword');
  assert.match(f.aiError, /529/);
  assert.match(failing.properties.LAST_AI_ERROR, /overloaded/);
});

test('직접 분류해 둔 가맹점은 AI 결과보다 우선', () => {
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk' },
    claude: () => msg({ date: '2026-09-28', amount: 12000, merchant: '김밥천국 역삼점', categoryId: 'c-food' }),
  });
  const meta = env.api('load').state;
  meta.merchantMap['김밥천국역삼점'] = 'c-fun';
  env.api('saveMeta', { meta });
  const r = env.sms(SMS);
  assert.equal(r.tx.categoryId, 'c-fun');
  assert.equal(r.tx.method, 'learned');
});

test('화면에서 추가: 자동 분류는 AI, 직접 고른 항목은 그대로', () => {
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk' },
    claude: (body) => {
      const n = JSON.parse(body.messages[0].content).expenses.length;
      return { results: Array.from({ length: n }, (_, i) => ({ index: i, categoryId: 'c-shop' })) };
    },
  });
  const r = env.api('addTransactions', {
    items: [
      { date: '2026-09-28', amount: 30000, memo: '동네 문구점', categoryId: '__auto' },
      { date: '2026-09-28', amount: 5000, memo: '편의점', categoryId: 'c-food', method: 'manual' },
      { date: '2026-09-28', amount: 7000, memo: '모름', categoryId: null },
    ],
  });
  assert.deepEqual(r.added.map((t) => [t.categoryId, t.method]), [['c-shop', 'ai'], ['c-food', 'manual'], [null, null]]);
  assert.equal(env.requests.length, 1); // 자동 분류할 1건만 AI 로

  const loaded = env.api('load').state.transactions;
  assert.equal(loaded.length, 3);
  const upd = env.api('updateTransaction', { id: loaded[0].id, patch: { categoryId: 'c-fun', method: 'manual' } });
  assert.equal(upd.tx.categoryId, 'c-fun');
  env.api('deleteTransaction', { id: loaded[2].id });
  assert.equal(env.api('load').state.transactions.length, 2);
});

test('계획이 바뀌면 그 기간 지출을 새 항목 기준으로 다시 분류', () => {
  let categoriesSeen = null;
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk' },
    claude: (body) => {
      const input = JSON.parse(body.messages[0].content);
      categoriesSeen = input.categories.map((c) => c.id);
      return { results: input.expenses.map((e, i) => ({ index: i, categoryId: categoriesSeen.includes('c-snack') ? 'c-snack' : 'c-cafe' })) };
    },
  });
  env.api('addTransactions', {
    items: [
      { date: '2026-09-10', amount: 4500, memo: '메가커피', categoryId: '__auto' },
      { date: '2026-09-11', amount: 8000, memo: '편의점', categoryId: 'c-food', method: 'manual' },
      { date: '2026-08-20', amount: 4000, memo: '지난달 카페', categoryId: '__auto' },
    ],
  });

  // 9월 기간부터 '카페/간식' 을 없애고 '간식' 항목을 새로 만든 계획
  const meta = env.api('load').state;
  delete meta.transactions;
  const sepPlan = JSON.parse(JSON.stringify(meta.plans[0]));
  sepPlan.from = '2026-09-01';
  sepPlan.updatedAt = new Date().toISOString();
  sepPlan.categories = sepPlan.categories.filter((c) => c.id !== 'c-cafe');
  sepPlan.categories.push({ id: 'c-snack', name: '간식', type: 'ratio', value: 5, description: '커피, 디저트', keywords: [] });
  meta.plans.push(sepPlan);
  env.api('saveMeta', { meta });

  const r = env.api('reclassify', { start: '2026-09-01', end: '2026-09-30' });
  assert.deepEqual(r.updated.map((t) => [t.memo, t.categoryId]), [['메가커피', 'c-snack']]); // 직접 고른 편의점은 그대로
  assert.ok(categoriesSeen.includes('c-snack') && !categoriesSeen.includes('c-cafe'));

  const all = env.api('load').state.transactions;
  assert.equal(all.find((t) => t.memo === '지난달 카페').categoryId, 'c-cafe'); // 지난 기간은 그대로
  assert.equal(env.sheets['지출'].rows.find((row) => row[3] === '메가커피')[5], '간식');
});

test('은행 앱 알림: 계좌를 찾아 잔액을 갱신하고, 화면의 오래된 설정이 덮어쓰지 않는다', () => {
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk' },
    claude: () => msg({ amount: 500000, merchant: '김철수', account_last4: '9012', balance: 1234000, categoryId: 'none' }),
  });
  const meta = env.api('load').state;
  delete meta.transactions;
  meta.settings.myName = '홍길동';
  meta.accounts = [{ id: 'kb', name: '국민 주거래', type: 'bank', last4: '9012', balance: 2000000, balanceAt: '2026-09-01T00:00:00.000Z' }];
  env.api('saveMeta', { meta });

  const r = JSON.parse(env.ctx.doPost({ parameter: { action: 'sms', key: 'secret', source: 'bank' }, postData: { contents: '[KB국민] 123456-**-789012 출금 500,000원 김철수 잔액 1,234,000원' } }).text);
  assert.equal(r.saved, true);
  assert.deepEqual([r.tx.kind, r.tx.accountId, r.tx.source, r.tx.categoryId], ['expense', 'kb', 'bank', null]);
  const body = JSON.parse(env.requests[0].body.messages[0].content);
  assert.equal(body.my_name, '홍길동');
  assert.equal(body.accounts[0].last4, '9012');

  let acc = env.api('load').state.accounts[0];
  assert.equal(acc.balance, 1234000);

  // 화면이 예전 잔액이 담긴 설정을 저장해도 알림으로 갱신된 잔액은 유지
  env.api('saveMeta', { meta });
  acc = env.api('load').state.accounts[0];
  assert.equal(acc.balance, 1234000);
  // 사용자가 잔액을 직접 고치면(더 최근 시각) 그 값이 저장
  meta.accounts[0].balance = 999;
  meta.accounts[0].balanceAt = '2999-01-01T00:00:00.000Z';
  env.api('saveMeta', { meta });
  assert.equal(env.api('load').state.accounts[0].balance, 999);
});

test('입금·내 계좌 이체는 지출 분류·재분류 대상이 아니다', () => {
  let n = 0;
  const env = makeEnv({
    props: { ANTHROPIC_API_KEY: 'sk' },
    claude: (body) => {
      n += 1;
      const input = JSON.parse(body.messages[0].content);
      if (input.message) return msg({ kind: n === 1 ? 'income' : 'own_transfer', amount: 3000000, merchant: n === 1 ? '(주)회사' : '홍길동', categoryId: 'c-food' });
      return { results: input.expenses.map((e, i) => ({ index: i, categoryId: 'c-shop' })) };
    },
  });
  assert.equal(env.sms('[KB국민] 입금 3,000,000원 (주)회사').tx.kind, 'income');
  const t = env.sms('[KB국민] 이체 3,000,000원 홍길동').tx;
  assert.deepEqual([t.kind, t.categoryId], ['transfer', null]);
  const added = env.api('addTransactions', { items: [{ date: '2026-09-29', amount: 100, memo: '용돈', kind: 'income', categoryId: '__auto' }] }).added[0];
  assert.deepEqual([added.kind, added.categoryId], ['income', null]);
  const r = env.api('reclassify', { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(r.updated.length, 0);
  assert.equal(env.sheets['지출'].rows[1][5], '입금');
});

test('setup: 접속 키가 없으면 만들어 주고, 있으면 그대로 보여준다', () => {
  const env = makeEnv({ props: { APP_KEY: '' } });
  const msg = env.ctx.setup();
  const key = env.properties.APP_KEY;
  assert.ok(key && key.length >= 20);
  assert.ok(msg.includes(key));
  env.ctx.setup();
  assert.equal(env.properties.APP_KEY, key);
  assert.ok(env.sheets['지출'] && env.sheets['설정']);
});

test('앱 설정에서 Claude API 키 넣기·지우기, 모델 바꾸기', () => {
  const env = makeEnv();
  const off = env.api('ping');
  assert.equal(off.ai, false);
  assert.equal(off.model, 'claude-opus-5-5');
  assert.deepEqual([...off.models], ['claude-opus-5-5', 'claude-haiku-4-5']);

  assert.match(env.api('setApiKey', { apiKey: 'hello' }).error, /sk-ant-/);
  assert.match(env.api('setApiKey', { apiKey: 'sk-ant-bad' }).error, /올바르지 않아요/);
  assert.equal(env.properties.ANTHROPIC_API_KEY, undefined);

  env.properties.LAST_AI_ERROR = '예전 오류';
  const on = env.api('setApiKey', { apiKey: 'sk-ant-good' });
  assert.equal(on.ai, true);
  assert.equal(on.lastError, '');
  assert.equal(env.properties.ANTHROPIC_API_KEY, 'sk-ant-good');
  assert.equal(JSON.stringify(on).includes('sk-ant-good'), false); // 키를 화면으로 돌려주지 않는다

  assert.equal(env.api('setModel', { model: 'claude-haiku-4-5' }).model, 'claude-haiku-4-5');
  assert.match(env.api('setModel', { model: 'gpt' }).error, /지원하지 않는/);
  assert.equal(env.api('setApiKey', { apiKey: '' }).ai, false);
});
