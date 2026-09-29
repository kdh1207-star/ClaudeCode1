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

test('문자 인식(AI 없이): 여러 줄 카드 문자, 결제 아닌 문자는 무시', () => {
  const sms = '[Web발신]\n신한카드(1234)승인\n홍*동\n12,000원(일시불)\n09/28 13:45\n스타벅스 강남점\n누적1,234,567원';
  assert.deepEqual(
    (({ date, amount, memo }) => ({ date, amount, memo }))(L.parseSmsFallback(sms, '2026-09-29')),
    { date: '2026-09-28', amount: 12000, memo: '스타벅스 강남점' }
  );
  assert.equal(L.parseSmsFallback('[Web발신] 인증번호 [123456]을 입력하세요', '2026-09-29'), null);
  assert.equal(L.parseSmsFallback('홍길동님 급여 3,000,000원 입금', '2026-09-29'), null);
  assert.equal(L.parseSmsFallback('KB국민카드 승인취소 15,000원 쿠팡', '2026-09-29').amount, -15000);
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

test('AI 문자 응답 읽기', () => {
  const categories = [{ id: 'food', name: '식비' }];
  assert.deepEqual(
    L.readSmsResponse({ is_expense: true, is_cancel: false, date: '2026-09-28', amount: 12000, merchant: '김밥천국', categoryId: 'food' }, categories, '2026-09-29'),
    { date: '2026-09-28', amount: 12000, memo: '김밥천국', categoryId: 'food' }
  );
  assert.equal(L.readSmsResponse({ is_expense: false }, categories, '2026-09-29'), null);
  const cancel = L.readSmsResponse({ is_expense: true, is_cancel: true, date: '28일', amount: 5000, merchant: '', categoryId: 'none' }, categories, '2026-09-29');
  assert.deepEqual(cancel, { date: '2026-09-29', amount: -5000, memo: '(내용 없음)', categoryId: null });
});
