// 배포용 파일을 만든다.
//  - budget-app.html        : css/js 를 모두 넣어 파일 하나로 동작하는 앱 (휴대폰·태블릿에서 파일 하나만 열어도 됨)
//  - apps-script/Code.gs    : 구글 Apps Script 에 붙여넣을 파일 하나 (공통 로직 + 서버 + 화면)
// 사용: npm run build
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function buildHtml() {
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}</style>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const js = read(src);
    if (js.includes('</script')) throw new Error(`${src} 에 </script 가 있어 인라인할 수 없습니다.`);
    return `<script>\n${js}</script>`;
  });
  return html;
}

// 구글 Apps Script 에 붙여넣을 파일 하나: 공통 로직 + 서버 + 화면(문자열)
function buildCodeGs(html = buildHtml()) {
  return [
    '// 자동 생성 파일 (npm run build). 직접 고치지 말고 js/logic.js, server/server.js 를 고치세요.',
    '// 구글 Apps Script 의 Code.gs 에 이 파일 전체를 붙여넣으면 됩니다.',
    read('js/logic.js'),
    read('server/server.js'),
    `var INDEX_HTML = ${JSON.stringify(html)};`,
    '',
  ].join('\n');
}

function outputs() {
  const html = buildHtml();
  return {
    'budget-app.html': html,
    'apps-script/Code.gs': buildCodeGs(html),
  };
}

module.exports = { buildHtml, buildCodeGs, outputs };

if (require.main === module) {
  fs.mkdirSync(path.join(root, 'apps-script'), { recursive: true });
  for (const [file, content] of Object.entries(outputs())) {
    fs.writeFileSync(path.join(root, file), content);
    console.log(`만듦: ${file}`);
  }
}
