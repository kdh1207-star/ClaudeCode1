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
