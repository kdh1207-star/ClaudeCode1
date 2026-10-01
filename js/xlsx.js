/* 엑셀(.xlsx) 첫 번째 시트를 2차원 배열로 읽는다. 외부 라이브러리 없이 브라우저 기능만 쓴다.
 * .xlsx 는 zip 안에 XML 이 든 파일이라, zip 을 풀고(DecompressionStream) XML 을 읽는다(DOMParser).
 */
(function (root) {
  'use strict';

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw fail('unsupported', '이 브라우저는 엑셀 파일을 풀 수 없어요. 최신 크롬·사파리를 쓰거나, 엑셀에서 CSV 로 저장해 올려 주세요.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // zip 안의 파일 목록 → { 이름: async () => 내용(Uint8Array) }
  function readZipDirectory(buf) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw fail('format', '엑셀 파일 구조를 읽지 못했어요.');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = {};
    const decoder = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      files[name] = async () => {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + compSize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw fail('format', '지원하지 않는 압축 방식이에요.');
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  async function readXml(files, name) {
    if (!files[name]) return null;
    const text = new TextDecoder().decode(await files[name]());
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  const tags = (node, name) => Array.from(node.getElementsByTagName(name));

  function columnIndex(ref) {
    const letters = String(ref || '').match(/^[A-Z]+/);
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // 첫 번째 시트의 경로 (workbook.xml 의 첫 sheet → 관계 파일에서 실제 경로)
  async function firstSheetPath(files) {
    const wb = await readXml(files, 'xl/workbook.xml');
    const rels = await readXml(files, 'xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const sheet = tags(wb, 'sheet')[0];
      const rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = tags(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const target = rel.getAttribute('Target').replace(/^\//, '');
        return target.startsWith('xl/') ? target : `xl/${target}`;
      }
    }
    return Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  }

  async function readXlsx(arrayBuffer) {
    const head = new Uint8Array(arrayBuffer.slice(0, 4));
    // D0 CF 11 E0: 비밀번호가 걸린 엑셀이거나 옛날 .xls 형식
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
      throw fail('encrypted', '비밀번호가 걸린 엑셀(또는 옛날 .xls) 파일이에요. 엑셀이나 구글 시트에서 열어 비밀번호 없이 .xlsx 또는 CSV 로 다시 저장한 뒤 올려 주세요.');
    }
    if (!(head[0] === 0x50 && head[1] === 0x4b)) throw fail('format', '엑셀(.xlsx) 파일이 아니에요.');

    const files = readZipDirectory(arrayBuffer);
    const shared = [];
    const sst = await readXml(files, 'xl/sharedStrings.xml');
    if (sst) {
      for (const si of tags(sst, 'si')) {
        // 읽는 법 표시(rPh) 안의 글자는 빼고 합친다
        shared.push(tags(si, 't').filter((t) => !(t.parentNode && t.parentNode.nodeName === 'rPh')).map((t) => t.textContent).join(''));
      }
    }
    const path = await firstSheetPath(files);
    const sheet = path && (await readXml(files, path));
    if (!sheet) throw fail('format', '시트를 찾지 못했어요.');

    const rows = [];
    for (const row of tags(sheet, 'row')) {
      const r = Number(row.getAttribute('r')) - 1;
      const out = [];
      tags(row, 'c').forEach((c, i) => {
        const col = c.getAttribute('r') ? columnIndex(c.getAttribute('r')) : i;
        const type = c.getAttribute('t');
        const v = tags(c, 'v')[0];
        let value = '';
        if (type === 's') value = shared[Number(v && v.textContent)] || '';
        else if (type === 'inlineStr') value = tags(c, 't').map((t) => t.textContent).join('');
        else if (type === 'str' || type === 'b' || type === 'e') value = v ? v.textContent : '';
        else if (v) value = Number(v.textContent);
        out[col] = value;
      });
      rows[r >= 0 ? r : rows.length] = out;
    }
    return Array.from(rows, (r) => Array.from(r || [], (c) => (c === undefined ? '' : c)));
  }

  // 파일 하나를 읽어 2차원 배열로. CSV 는 글자 그대로(한글 엑셀 CSV 는 EUC-KR 인 경우가 많아 같이 시도)
  async function readTableFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isZipOrOle = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);
    if (isZipOrOle || /\.xlsx?$/i.test(file.name)) return readXlsx(buf);
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) {
      try {
        text = new TextDecoder('euc-kr').decode(buf);
      } catch (e) {
        /* utf-8 그대로 */
      }
    }
    return root.BudgetLogic.parseCSV(text);
  }

  root.BudgetXlsx = { readXlsx, readTableFile };
})(typeof globalThis !== 'undefined' ? globalThis : this);
