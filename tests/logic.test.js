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
    settings: { startDay: 25, ratioBase: 'afterFixed' },
    categories: cats,
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
