const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

test('기간: 시작일 기준으로 기간을 계산한다', () => {
  assert.deepEqual(L.getPeriod('2026-09-29', 25), { start: '2026-09-25', end: '2026-10-24', key: '2026-09-25' });
  assert.deepEqual(L.getPeriod('2026-09-10', 25), { start: '2026-08-25', end: '2026-09-24', key: '2026-08-25' });
  assert.deepEqual(L.getPeriod('2026-09-10', 1), { start: '2026-09-01', end: '2026-09-30', key: '2026-09-01' });
});

test('기간: 없는 날짜(31일)는 말일로 맞춘다', () => {
  assert.deepEqual(L.getPeriod('2026-02-28', 31), { start: '2026-02-28', end: '2026-03-30', key: '2026-02-28' });
  assert.deepEqual(L.getPeriod('2026-02-27', 31), { start: '2026-01-31', end: '2026-02-27', key: '2026-01-31' });
});

test('기간: 이전/다음 기간 이동', () => {
  const p = L.getPeriod('2026-01-10', 25);
  assert.equal(L.shiftPeriod(p, 1, 25).start, '2026-01-25');
  assert.equal(L.shiftPeriod(p, -1, 25).start, '2025-11-25');
});

const cats = [
  { id: 'a', name: '월세', type: 'fixed', value: 500000 },
  { id: 'b', name: '식비', type: 'ratio', value: 50 },
  { id: 'c', name: '저축', type: 'ratio', value: 50 },
];

test('예산: 고정 항목은 수입과 무관, 비율 항목은 수입에 비례', () => {
  const r1 = L.computeBudgets(cats, 3000000, 'income');
  assert.deepEqual(r1.budgets, { a: 500000, b: 1500000, c: 1500000 });
  assert.equal(r1.unallocated, -500000);

  const r2 = L.computeBudgets(cats, 3000000, 'afterFixed');
  assert.deepEqual(r2.budgets, { a: 500000, b: 1250000, c: 1250000 });
  assert.equal(r2.unallocated, 0);

  const r3 = L.computeBudgets(cats, 2000000, 'afterFixed');
  assert.deepEqual(r3.budgets, { a: 500000, b: 750000, c: 750000 });
});

test('자동 분류: 가장 긴 키워드, 학습된 가맹점 우선', () => {
  const c = [
    { id: 'shop', keywords: ['쿠팡'] },
    { id: 'food', keywords: ['쿠팡이츠', '스타벅스'] },
  ];
  assert.equal(L.classify('쿠팡이츠 주문', c), 'food');
  assert.equal(L.classify('쿠팡(주)', c), 'shop');
  assert.equal(L.classify('스타 벅스 강남', c), 'food');
  assert.equal(L.classify('알 수 없음', c), null);
  assert.equal(L.classify('쿠팡(주)', c, { '쿠팡(주)': 'food' }), 'food');
});

test('인식: 카드 승인 문자', () => {
  const text = '[Web발신]\n신한카드(1234)승인 홍*동 12,000원(일시불)09/28 13:45 스타벅스 강남점 누적1,234,567원';
  const { items, skipped } = L.parseExpenseText(text, '2026-09-29');
  assert.equal(items.length, 1);
  assert.deepEqual(skipped, ['[Web발신]']);
  assert.equal(items[0].amount, 12000);
  assert.equal(items[0].date, '2026-09-28');
  assert.equal(items[0].memo, '스타벅스 강남점');
});

test('인식: 다양한 형식', () => {
  const text = [
    '2026-09-27 배달의민족 23,500원',
    '2026.09.26\t이마트\t54000',
    '9월 25일 카카오T 택시 8,400원',
    '09/24 쿠팡 승인취소 15,000원',
  ].join('\n');
  const { items } = L.parseExpenseText(text, '2026-09-29');
  assert.deepEqual(
    items.map((i) => [i.date, i.amount, i.memo]),
    [
      ['2026-09-27', 23500, '배달의민족'],
      ['2026-09-26', 54000, '이마트'],
      ['2026-09-25', 8400, '카카오T 택시'],
      ['2026-09-24', -15000, '쿠팡'],
    ]
  );
});

test('인식: 날짜가 없으면 기준일, 연말 내역은 작년으로', () => {
  assert.equal(L.parseExpenseText('편의점 3,000원', '2026-09-29').items[0].date, '2026-09-29');
  assert.equal(L.parseExpenseText('12/30 편의점 3,000원', '2027-01-03').items[0].date, '2026-12-30');
});

test('기간 요약: 항목별 사용액과 미분류', () => {
  const state = {
    settings: { startDay: 25 },
    plans: [{ from: L.BASE_PLAN_FROM, ratioBase: 'afterFixed', categories: cats, updatedAt: '' }],
    incomes: { '2026-09-25': 3000000 },
    transactions: [
      { id: 1, date: '2026-09-25', amount: 500000, memo: '월세', categoryId: 'a' },
      { id: 2, date: '2026-09-30', amount: 20000, memo: '식당', categoryId: 'b' },
      { id: 3, date: '2026-10-01', amount: 7000, memo: '?', categoryId: null },
      { id: 4, date: '2026-09-24', amount: 99999, memo: '지난 기간', categoryId: 'b' },
    ],
  };
  const s = L.summarizePeriod(state, L.getPeriod('2026-09-29', 25));
  assert.equal(s.totalSpent, 527000);
  assert.equal(s.remaining, 2473000);
  assert.equal(s.unclassified, 7000);
  assert.equal(s.rows.find((r) => r.category.id === 'b').remaining, 1230000);
  assert.equal(L.statusOf(0.5), 'good');
  assert.equal(L.statusOf(0.9), 'warning');
  assert.equal(L.statusOf(1.1), 'critical');
});

test('기간별 계획: 이번 기간부터 바꾼 계획은 지난 기간에 영향을 주지 않는다', () => {
  const state = L.defaultState();
  state.settings.startDay = 25;
  const sep = L.getPeriod('2026-09-29', 25);
  const aug = L.shiftPeriod(sep, -1, 25);
  const oct = L.shiftPeriod(sep, 1, 25);

  const plan = L.ensurePlanFor(state, sep.key, '2026-09-29T00:00:00Z');
  plan.categories = plan.categories.filter((c) => c.id !== 'c-cafe');
  plan.categories.find((c) => c.id === 'c-food').value = 35;

  assert.equal(L.planFor(state, aug.key).categories.length, 8);
  assert.equal(L.planFor(state, sep.key).categories.length, 7);
  assert.equal(L.planFor(state, oct.key), plan); // 다음 기간은 새 계획을 물려받음
  assert.equal(L.ensurePlanFor(state, sep.key, 'x'), plan); // 같은 기간은 새로 만들지 않음
  assert.equal(L.nextPlanAfter(state, { from: aug.key }), plan);
});

test('기간별 계획: 계획이 바뀐 뒤 다시 분류하지 않은 지출 수', () => {
  const state = L.defaultState();
  const p = L.getPeriod('2026-09-10', 1);
  state.transactions = [
    { id: 1, date: '2026-09-02', amount: 1000, memo: 'a', categoryId: 'c-food', method: 'ai', classifiedAt: '2026-09-02T00:00:00Z' },
    { id: 2, date: '2026-09-03', amount: 1000, memo: 'b', categoryId: 'c-food', method: 'manual', classifiedAt: '2026-09-03T00:00:00Z' },
    { id: 3, date: '2026-09-20', amount: 1000, memo: 'c', categoryId: 'c-food', method: 'ai', classifiedAt: '2026-09-20T00:00:00Z' },
  ];
  assert.equal(L.summarizePeriod(state, p).staleCount, 0);
  L.ensurePlanFor(state, p.key, '2026-09-10T00:00:00Z');
  assert.equal(L.summarizePeriod(state, p).staleCount, 1); // 직접 고른 것, 계획 변경 뒤 분류된 것은 제외
});

test('시작일 변경: 수입과 계획의 기간 키를 옮긴다', () => {
  const state = L.defaultState();
  state.incomes = { '2026-09-01': 100 };
  L.ensurePlanFor(state, '2026-09-01', 'x');
  L.remapPeriodKeys(state, 25);
  assert.deepEqual(state.incomes, { '2026-09-25': 100 });
  assert.deepEqual(state.plans.map((p) => p.from), [L.BASE_PLAN_FROM, '2026-09-25']);
  assert.equal(state.settings.startDay, 25);
});

test('예전(v1) 데이터를 기간별 계획 구조로 옮긴다', () => {
  const v1 = { settings: { startDay: 25, ratioBase: 'income' }, categories: cats, incomes: { a: 1 }, transactions: [], merchantMap: {} };
  const s = L.normalizeState(v1);
  assert.equal(s.version, 2);
  assert.equal(s.plans.length, 1);
  assert.equal(s.plans[0].ratioBase, 'income');
  assert.equal(s.plans[0].categories, cats);
  assert.equal(s.settings.startDay, 25);
});

test('알림 인식(AI 없이): 여러 줄 카드 문자, 거래 아닌 문자는 무시', () => {
  const sms = '[Web발신]\n신한카드(1234)승인\n홍*동\n12,000원(일시불)\n09/28 13:45\n스타벅스 강남점\n누적1,234,567원';
  const r = L.parseMessageFallback(sms, '2026-09-29');
  assert.deepEqual([r.date, r.amount, r.memo, r.kind], ['2026-09-28', 12000, '스타벅스 강남점', 'expense']);
  assert.equal(L.parseMessageFallback('[Web발신] 인증번호 [123456]을 입력하세요', '2026-09-29'), null);
  assert.equal(L.parseMessageFallback('KB국민카드 승인취소 15,000원 쿠팡', '2026-09-29').amount, -15000);
});

test('알림 인식(AI 없이): 은행 입출금 알림, 계좌 연결, 잔액, 내 계좌끼리 이체', () => {
  const accounts = [{ id: 'kb', name: '국민', type: 'bank', last4: '9012' }, { id: 'card', name: '신한카드', type: 'card', last4: '1234' }];
  const opts = { accounts, myName: '홍길동' };
  const out = L.parseMessageFallback('[KB국민] 123456-**-789012 09/29 14:02 출금 500,000원 김철수 잔액 1,234,000원', '2026-09-29', opts);
  assert.deepEqual(out, { date: '2026-09-29', amount: 500000, memo: '김철수', kind: 'expense', accountId: 'kb', balance: 1234000 });
  const inc = L.parseMessageFallback('[KB국민] ***9012 09/25 입금 3,000,000원 (주)회사 잔액 4,000,000원', '2026-09-29', opts);
  assert.deepEqual([inc.kind, inc.amount, inc.accountId, inc.balance], ['income', 3000000, 'kb', 4000000]);
  assert.equal(L.parseMessageFallback('[KB국민] ***9012 이체 300,000원 홍길동 잔액 900,000원', '2026-09-29', opts).kind, 'transfer');
  assert.equal(L.parseMessageFallback('신한카드(1234)승인 홍길동님 8,000원 김밥천국', '2026-09-29', opts).accountId, 'card');
  assert.equal(L.matchAccount('2026-09-12 결제 5,000원', [{ id: 'x', last4: '0912' }]), null); // 날짜는 번호로 보지 않음
});

test('AI 요청: 항목 id 만 고를 수 있고, 직접 분류한 가맹점을 예시로 준다', () => {
  const categories = [
    { id: 'food', name: '식비', description: '외식', keywords: ['식당'] },
    { id: 'cafe', name: '카페', keywords: [] },
  ];
  const req = L.buildClassifyRequest(categories, [{ memo: '동네 빵집', amount: 5000, date: '2026-09-01' }], { '동네빵집': 'cafe' });
  const enumIds = req.schema.properties.results.items.properties.categoryId.enum;
  assert.deepEqual(enumIds, ['food', 'cafe', 'none']);
  const body = JSON.parse(req.user);
  assert.deepEqual(body.categories[1].examples, ['동네빵집']);
  assert.equal(body.expenses[0].merchant, '동네 빵집');

  assert.deepEqual(
    L.readClassifyResponse({ results: [{ index: 1, categoryId: 'cafe' }, { index: 0, categoryId: 'none' }, { index: 9, categoryId: 'food' }] }, categories, 2),
    [null, 'cafe']
  );
});

test('AI 알림 응답 읽기: 종류, 계좌, 잔액, 저축 이체', () => {
  const categories = [{ id: 'food', name: '식비' }, { id: 'save', name: '저축' }];
  const accounts = [{ id: 'kb', last4: '9012' }];
  const base = { kind: 'expense', is_cancel: false, to_savings: false, date: '2026-09-28', amount: 12000, merchant: '김밥천국', account_last4: '9012', balance: 88000, categoryId: 'food' };
  assert.deepEqual(L.readMessageResponse(base, categories, '2026-09-29', accounts), {
    date: '2026-09-28', amount: 12000, memo: '김밥천국', kind: 'expense', categoryId: 'food', accountId: 'kb', balance: 88000,
  });
  assert.equal(L.readMessageResponse({ ...base, kind: 'not_transaction' }, categories, '2026-09-29', accounts), null);
  const inc = L.readMessageResponse({ ...base, kind: 'income', categoryId: 'food' }, categories, '2026-09-29', accounts);
  assert.deepEqual([inc.kind, inc.categoryId], ['income', null]);
  const own = L.readMessageResponse({ ...base, kind: 'own_transfer', categoryId: 'none', balance: -1 }, categories, '2026-09-29', accounts);
  assert.deepEqual([own.kind, own.categoryId, own.balance], ['transfer', null, null]);
  const save = L.readMessageResponse({ ...base, kind: 'own_transfer', to_savings: true, categoryId: 'save' }, categories, '2026-09-29', accounts);
  assert.deepEqual([save.kind, save.categoryId], ['expense', 'save']); // 저축 계좌로 옮긴 돈은 저축 항목 지출
  const cancel = L.readMessageResponse({ ...base, is_cancel: true, date: '28일', account_last4: '' }, categories, '2026-09-29', accounts);
  assert.deepEqual([cancel.amount, cancel.date, cancel.accountId], [-12000, '2026-09-29', null]);
});

test('AI 알림 요청: 등록 계좌와 내 이름을 알려준다', () => {
  const req = L.buildMessageRequest([{ id: 'food', name: '식비' }], '알림', '2026-09-29', {}, { myName: '홍길동', accounts: [{ name: '적금', type: 'bank', last4: '12-3344', isSavings: true }] });
  const body = JSON.parse(req.user);
  assert.equal(body.my_name, '홍길동');
  assert.deepEqual(body.accounts, [{ name: '적금', type: 'bank', last4: '3344', isSavings: true }]);
  assert.deepEqual(req.schema.properties.kind.enum, ['expense', 'income', 'own_transfer', 'not_transaction']);
});

test('집계: 이체는 지출에서 빼고, 입금은 따로 모은다', () => {
  const state = L.defaultState();
  state.transactions = [
    { id: 1, date: '2026-09-02', amount: 10000, memo: '김밥', categoryId: 'c-food' },
    { id: 2, date: '2026-09-03', amount: 500000, memo: '내 계좌', kind: 'transfer' },
    { id: 3, date: '2026-09-04', amount: 3000000, memo: '급여', kind: 'income' },
    { id: 4, date: '2026-09-05', amount: 4000, memo: '김밥', categoryId: 'c-food', kind: 'expense' },
    { id: 5, date: '2026-08-05', amount: 8000, memo: '지난달 김밥', categoryId: 'c-food' },
  ];
  const p = L.getPeriod('2026-09-10', 1);
  const s = L.summarizePeriod(state, p);
  assert.equal(s.totalSpent, 14000);
  assert.equal(s.incomeReceived, 3000000);
  assert.equal(s.transactions.length, 2);
  assert.equal(s.allTransactions.length, 4);

  const days = L.dailyTotals(s.allTransactions);
  assert.deepEqual(days['2026-09-04'], { spent: 0, income: 3000000, count: 1 });
  assert.deepEqual(days['2026-09-03'], { spent: 0, income: 0, count: 1 });

  assert.deepEqual(L.topMerchants(s.allTransactions), [{ memo: '김밥', total: 14000, count: 2 }]);
  const cmp = L.compareWithPrevious(state, p);
  assert.equal(cmp.totalDiff, 6000);
  assert.deepEqual(cmp.rows.find((r) => r.id === 'c-food'), { id: 'c-food', name: '식비', current: 14000, previous: 8000, diff: 6000 });

  const br = L.categoryBreakdown(s);
  assert.deepEqual(br.map((r) => [r.id, r.share, r.colorIndex]), [['c-food', 1, 2]]);

  const tr = L.trend(state, p, 2);
  assert.deepEqual(tr.map((x) => [x.period.key, x.spent, x.incomeReceived]), [['2026-08-01', 8000, 0], ['2026-09-01', 14000, 3000000]]);
});

test('자산: 계좌 잔액 합계와 카드별 사용액', () => {
  const state = L.normalizeState({
    accounts: [
      { id: 'kb', name: '국민', type: 'bank', last4: '9012', balance: 1000000 },
      { id: 'sv', name: '적금', type: 'bank', last4: '3344', isSavings: true, balance: 5000000 },
      { id: 'cd', name: '신한카드', type: 'card', last4: '1234' },
    ],
    transactions: [
      { id: 1, date: '2026-09-02', amount: 10000, memo: 'a', accountId: 'cd' },
      { id: 2, date: '2026-09-03', amount: 7000, memo: 'b' },
    ],
  });
  const a = L.assetSummary(state, L.getPeriod('2026-09-10', 1));
  assert.equal(a.total, 6000000);
  assert.equal(a.savings, 5000000);
  assert.equal(a.cards[0].spent, 10000);
  assert.equal(a.unlinkedSpent, 7000);
});

