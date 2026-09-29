// index.html 에 css/js 를 모두 넣어 파일 하나로 동작하는 budget-app.html 을 만든다.
// 휴대폰·태블릿에서 파일 하나만 열어도 디자인과 기능이 깨지지 않게 하기 위함.
// 사용: node scripts/build-standalone.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function build() {
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}</style>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const js = read(src);
    if (js.includes('</script')) throw new Error(`${src} 에 </script 가 있어 인라인할 수 없습니다.`);
    return `<script>\n${js}</script>`;
  });
  return html;
}

module.exports = { build };

if (require.main === module) {
  fs.writeFileSync(path.join(root, 'budget-app.html'), build());
  console.log('budget-app.html 을 만들었습니다.');
}
