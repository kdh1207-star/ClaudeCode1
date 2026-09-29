const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { outputs, buildHtml } = require('../scripts/build-standalone.js');

test('생성 파일이 최신 소스와 같다 (npm run build 로 갱신)', () => {
  for (const [file, content] of Object.entries(outputs())) {
    const current = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(current, content, `${file} 이 최신이 아닙니다`);
  }
});

test('budget-app.html 은 외부 css/js 파일을 참조하지 않는다', () => {
  const html = buildHtml();
  assert.doesNotMatch(html, /<link rel="stylesheet"/);
  assert.doesNotMatch(html, /<script src=/);
  assert.match(html, /\/\*__SERVER_CONFIG__\*\//);
});
