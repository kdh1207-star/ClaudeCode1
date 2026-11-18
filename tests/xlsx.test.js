// 비밀번호가 걸린 엑셀 풀기 (fixtures 는 msoffcrypto-tool 로 만든 Agile 파일과 같은 방식으로 만든 Standard 파일, 비밀번호 990101)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../js/xlsx.js');
const X = globalThis.BudgetXlsx;

const fixture = (n) => {
  const b = fs.readFileSync(path.join(__dirname, 'fixtures', n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};
const plain = Buffer.from(fixture('plain.xlsx'));

for (const name of ['locked-agile.xlsx', 'locked-standard.xlsx']) {
  test(`잠긴 엑셀 풀기: ${name}`, async () => {
    const buf = fixture(name);
    assert.equal(await X.decryptOffice(buf, 'wrong'), null);
    assert.ok(Buffer.from(await X.decryptOffice(buf, '990101')).equals(plain));
  });
}

test('잠긴 엑셀: 저장된 비밀번호를 차례로 시도하고, 다 틀리면 물어본다', async () => {
  const buf = fixture('locked-agile.xlsx');
  const used = [];
  const out = await X.unlockOffice(buf, { passwords: ['1111', '990101'], onPassword: (pw, asked) => used.push([pw, asked]) });
  assert.ok(Buffer.from(out).equals(plain));
  assert.deepEqual(used, [['990101', false]]);

  const asked = [];
  const out2 = await X.unlockOffice(buf, {
    passwords: ['1111'],
    askPassword: async (wrong) => (asked.push(wrong), '990101'),
    onPassword: (pw, a) => used.push([pw, a]),
  });
  assert.ok(Buffer.from(out2).equals(plain));
  assert.deepEqual(asked, [true]);
  assert.deepEqual(used[1], ['990101', true]);

  await assert.rejects(X.unlockOffice(buf, { passwords: [] }), (e) => e.code === 'password');
  await assert.rejects(X.unlockOffice(buf, { passwords: ['1'], askPassword: async () => null }), /맞지 않아요/);
});
