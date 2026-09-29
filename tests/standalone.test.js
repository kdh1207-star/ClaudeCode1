const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { build } = require('../scripts/build-standalone.js');

test('budget-app.html 이 최신 소스와 같다 (npm run build 로 갱신)', () => {
  const current = fs.readFileSync(path.join(__dirname, '..', 'budget-app.html'), 'utf8');
  assert.equal(current, build());
});

test('budget-app.html 은 외부 css/js 파일을 참조하지 않는다', () => {
  const html = build();
  assert.doesNotMatch(html, /<link rel="stylesheet"/);
  assert.doesNotMatch(html, /<script src=/);
});
