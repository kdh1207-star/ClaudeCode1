// 배포용 파일을 만든다.
//  - budget-app.html        : css/js 를 모두 넣어 파일 하나로 동작하는 앱 (휴대폰·태블릿에서 파일 하나만 열어도 됨)
//  - apps-script/Code.gs    : 구글 Apps Script 에 붙여넣을 파일 하나 (공통 로직 + 서버 + 화면)
// 사용: npm run build
const fs = require('fs');
const path = require('path');

const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// pack: 기능 코드를 base64 로 감싸 넣는다 (구글 웹 앱용). 전달 중에 글자가 바뀌어도 코드가 깨지지 않는다.
// 앱 버전: 소스 내용으로 만든 짧은 해시. 설정 화면 맨 아래에 보여서, 폰에 새 버전이 반영됐는지 확인할 수 있다.
function buildId() {
  const h = crypto.createHash('sha256');
  for (const f of ['index.html', 'css/style.css', 'js/logic.js', 'js/charts.js', 'js/xlsx.js', 'js/store.js', 'js/app.js', 'server/server.js']) h.update(read(f));
  return h.digest('hex').slice(0, 7);
}

function buildHtml({ pack = false } = {}) {
  let html = read('index.html').replace('__BUILD_ID__', buildId());
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}</style>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const js = read(src);
    if (pack) return `<script>__budgetRun(${JSON.stringify(src)}, "${Buffer.from(js, 'utf8').toString('base64')}");</script>`;
    if (js.includes('</script')) throw new Error(`${src} 에 </script 가 있어 인라인할 수 없습니다.`);
    return `<script>\n${js}</script>`;
  });
  return html;
}

// 구글 Apps Script 에 붙여넣을 파일 하나: 공통 로직 + 서버 + 화면(문자열)
function buildCodeGs(html = buildHtml({ pack: true })) {
  return [
    '// 자동 생성 파일 (npm run build). 직접 고치지 말고 js/logic.js, server/server.js 를 고치세요.',
    '// 구글 Apps Script 의 Code.gs 에 이 파일 전체를 붙여넣으면 됩니다.',
    '/** @OnlyCurrentDoc */ // 이 코드가 붙은 시트 하나만 읽고 쓰도록 권한을 좁힌다 (내 다른 시트에는 접근 권한 없음)',
    read('js/logic.js'),
    read('server/server.js'),
    `var INDEX_HTML = ${JSON.stringify(html)};`,
    '',
  ].join('\n');
}

// 설치형 웹앱(PWA): GitHub Pages(docs/)에서 화면을 주고, 데이터는 Apps Script 서버와 주고받는다
function buildPwaHtml() {
  return buildHtml()
    .replace('<meta name="theme-color" content="#f4f4f1">', [
      '<meta name="theme-color" content="#f4f4f1">',
      '  <link rel="manifest" href="manifest.webmanifest">',
      '  <link rel="icon" href="icon-192.png">',
      '  <link rel="apple-touch-icon" href="icon-192.png">',
      '  <meta name="apple-mobile-web-app-capable" content="yes">',
      '  <meta name="mobile-web-app-capable" content="yes">',
      '  <meta name="apple-mobile-web-app-title" content="가계부">',
    ].join('\n'))
    .replace('</body>', '<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});</script>\n</body>');
}

function outputs() {
  return {
    'budget-app.html': buildHtml(),
    'docs/index.html': buildPwaHtml(),
    'apps-script/Code.gs': buildCodeGs(),
  };
}

module.exports = { buildHtml, buildCodeGs, outputs, buildId };

if (require.main === module) {
  fs.mkdirSync(path.join(root, 'apps-script'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const [file, content] of Object.entries(outputs())) {
    fs.writeFileSync(path.join(root, file), content);
    console.log(`만듦: ${file}`);
  }
  console.log(`앱 버전: ${buildId()}`);
}
