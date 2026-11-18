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

  // ---------- 비밀번호가 걸린 엑셀 풀기 ----------
  // 암호 걸린 .xlsx 는 OLE(복합 문서) 안에 EncryptionInfo(암호 정보)와 EncryptedPackage(암호화된 .xlsx)가 들어 있다.
  // 엑셀 2010 이후 방식(Agile)과 2007 방식(Standard, AES)을 브라우저 암호 기능(WebCrypto)으로 푼다.

  const subtle = () => {
    const c = root.crypto && root.crypto.subtle;
    if (!c) throw fail('unsupported', '이 브라우저에서는 잠긴 파일을 풀 수 없어요. 최신 크롬·사파리로 열어 주세요.');
    return c;
  };

  const isOle = (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

  // OLE 복합 문서에서 스트림 꺼내기 → { 이름: Uint8Array }
  function readOle(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const secSize = 1 << view.getUint16(0x1e, true);
    const miniSize = 1 << view.getUint16(0x20, true);
    const cutoff = view.getUint32(0x38, true);
    const sector = (n) => bytes.subarray(512 + n * secSize, 512 + (n + 1) * secSize);
    const u32 = (arr, i) => (arr[i] | (arr[i + 1] << 8) | (arr[i + 2] << 16) | (arr[i + 3] << 24)) >>> 0;
    const END = 0xfffffffe;

    // FAT 위치 목록(DIFAT): 헤더의 109개 + 이어지는 DIFAT 섹터
    const fatSectors = [];
    for (let i = 0; i < 109; i++) fatSectors.push(view.getUint32(0x4c + i * 4, true));
    let difat = view.getUint32(0x44, true);
    for (let k = 0; k < view.getUint32(0x48, true) && difat < END; k++) {
      const s = sector(difat);
      for (let i = 0; i < secSize / 4 - 1; i++) fatSectors.push(u32(s, i * 4) >>> 0);
      difat = u32(s, secSize - 4) >>> 0;
    }
    const fat = [];
    for (const f of fatSectors.slice(0, view.getUint32(0x2c, true))) {
      const s = sector(f);
      for (let i = 0; i < secSize; i += 4) fat.push(u32(s, i) >>> 0);
    }
    const chain = (start, table) => {
      const out = [];
      for (let n = start, guard = 0; n < END && guard < table.length + 1; n = table[n], guard++) out.push(n);
      return out;
    };
    const readChain = (start, size) => {
      const out = new Uint8Array(chain(start, fat).length * secSize);
      chain(start, fat).forEach((n, i) => out.set(sector(n), i * secSize));
      return out.subarray(0, size);
    };

    const dir = readChain(view.getUint32(0x30, true), Infinity);
    const entries = [];
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const len = dir[p + 0x40] | (dir[p + 0x41] << 8);
      let name = '';
      for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(dir[p + i] | (dir[p + i + 1] << 8));
      entries.push({ name, type: dir[p + 0x42], start: u32(dir, p + 0x74) >>> 0, size: u32(dir, p + 0x78) >>> 0 });
    }
    const rootEntry = entries[0];
    const miniStream = rootEntry ? readChain(rootEntry.start, rootEntry.size) : new Uint8Array(0);
    const miniFat = [];
    const mf = readChain(view.getUint32(0x3c, true), view.getUint32(0x40, true) * secSize);
    for (let i = 0; i < mf.length; i += 4) miniFat.push(u32(mf, i) >>> 0);

    const streams = {};
    for (const e of entries) {
      if (e.type !== 2) continue;
      if (e.size < cutoff) {
        const out = new Uint8Array(chain(e.start, miniFat).length * miniSize);
        chain(e.start, miniFat).forEach((n, i) => out.set(miniStream.subarray(n * miniSize, (n + 1) * miniSize), i * miniSize));
        streams[e.name] = out.subarray(0, e.size);
      } else streams[e.name] = readChain(e.start, e.size);
    }
    return streams;
  }

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const utf16 = (s) => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      out[i * 2] = s.charCodeAt(i) & 255;
      out[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    return out;
  };
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const hash = async (alg, data) => new Uint8Array(await subtle().digest(alg, data));
  const HASHES = { SHA1: 'SHA-1', 'SHA-1': 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' };

  // 패딩 없는 AES-CBC 풀기 (WebCrypto 는 PKCS#7 패딩을 요구해서, 패딩 블록 하나를 만들어 붙인다)
  async function aesCbcRaw(keyBytes, iv, data) {
    const key = await subtle().importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
    const last = data.length >= 16 ? data.subarray(data.length - 16) : iv;
    const pad = new Uint8Array(16).fill(16);
    const extra = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: last }, key, pad)).subarray(0, 16);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, concat(data, extra)));
  }

  // AES-ECB 풀기 = CBC 로 푼 뒤 앞 블록(첫 블록은 0)을 다시 XOR
  async function aesEcbRaw(keyBytes, data) {
    const out = await aesCbcRaw(keyBytes, new Uint8Array(16), data);
    for (let i = 16; i < out.length; i++) out[i] ^= data[i - 16];
    return out;
  }

  const fit = (h, n, fill) => {
    if (h.length >= n) return h.slice(0, n);
    const out = new Uint8Array(n).fill(fill);
    out.set(h);
    return out;
  };

  // 비밀번호를 10만 번 해시하는 부분은 WebCrypto 를 매번 부르면 느려서(수 초) 직접 계산한다
  const K512 = [
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
    0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
    0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
    0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
    0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
    0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
    0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
    0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
    0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
    0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
    0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
    0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
    0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
  ];
  const H512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];

  // 메시지 패딩 후 블록 단위로 넘긴다 (blockBytes 64 또는 128, 길이 칸 8 또는 16바이트)
  function padBlocks(msg, blockBytes) {
    const lenBytes = blockBytes === 128 ? 16 : 8;
    const total = Math.ceil((msg.length + 1 + lenBytes) / blockBytes) * blockBytes;
    const out = new Uint8Array(total);
    out.set(msg);
    out[msg.length] = 0x80;
    const bits = msg.length * 8;
    out[total - 4] = bits >>> 24;
    out[total - 3] = (bits >>> 16) & 255;
    out[total - 2] = (bits >>> 8) & 255;
    out[total - 1] = bits & 255;
    return out;
  }

  function sha512(msg) {
    const m = padBlocks(msg, 128);
    const h = H512.slice();
    const w = new Int32Array(160);
    for (let off = 0; off < m.length; off += 128) {
      for (let i = 0; i < 32; i++) w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      for (let i = 16; i < 80; i++) {
        const xh = w[(i - 15) * 2], xl = w[(i - 15) * 2 + 1];
        const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
        const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
        const yh = w[(i - 2) * 2], yl = w[(i - 2) * 2 + 1];
        const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
        const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
        let lo = (s0l >>> 0) + (s1l >>> 0) + (w[(i - 7) * 2 + 1] >>> 0) + (w[(i - 16) * 2 + 1] >>> 0);
        const hi = s0h + s1h + w[(i - 7) * 2] + w[(i - 16) * 2] + Math.floor(lo / 0x100000000);
        w[i * 2] = hi;
        w[i * 2 + 1] = lo;
      }
      let [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl] = h;
      for (let i = 0; i < 80; i++) {
        const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
        const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
        const chh = (eh & fh) ^ (~eh & gh);
        const chl = (el & fl) ^ (~el & gl);
        let t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[i * 2 + 1] + (w[i * 2 + 1] >>> 0);
        const t1h = hh + S1h + chh + K512[i * 2] + w[i * 2] + Math.floor(t1l / 0x100000000);
        t1l >>>= 0;
        const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
        const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
        const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
        const mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
        let t2l = (S0l >>> 0) + (mjl >>> 0);
        const t2h = S0h + mjh + Math.floor(t2l / 0x100000000);
        t2l >>>= 0;
        hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
        let nl = (dl >>> 0) + t1l;
        eh = (dh + t1h + Math.floor(nl / 0x100000000)) | 0; el = nl | 0;
        dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
        nl = t1l + t2l;
        ah = (t1h + t2h + Math.floor(nl / 0x100000000)) | 0; al = nl | 0;
      }
      const add = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
      for (let i = 0; i < 16; i += 2) {
        const lo = (h[i + 1] >>> 0) + (add[i + 1] >>> 0);
        h[i] = (h[i] + add[i] + Math.floor(lo / 0x100000000)) | 0;
        h[i + 1] = lo | 0;
      }
    }
    const out = new Uint8Array(64);
    h.forEach((x, i) => {
      out[i * 4] = x >>> 24; out[i * 4 + 1] = (x >>> 16) & 255; out[i * 4 + 2] = (x >>> 8) & 255; out[i * 4 + 3] = x & 255;
    });
    return out;
  }

  function sha1(msg) {
    const m = padBlocks(msg, 64);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Int32Array(80);
    for (let off = 0; off < m.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new Uint8Array(20);
    [h0, h1, h2, h3, h4].forEach((x, i) => {
      out[i * 4] = x >>> 24; out[i * 4 + 1] = (x >>> 16) & 255; out[i * 4 + 2] = (x >>> 8) & 255; out[i * 4 + 3] = x & 255;
    });
    return out;
  }

  const SYNC_HASH = { 'SHA-512': sha512, 'SHA-1': sha1 };

  async function spin(alg, salt, password, count) {
    const fast = SYNC_HASH[alg];
    if (fast) {
      let h = fast(concat(salt, utf16(password)));
      const buf = new Uint8Array(4 + h.length);
      for (let i = 0; i < count; i++) {
        buf[0] = i & 255; buf[1] = (i >>> 8) & 255; buf[2] = (i >>> 16) & 255; buf[3] = i >>> 24;
        buf.set(h, 4);
        h = fast(buf);
      }
      return h;
    }
    let h = await hash(alg, concat(salt, utf16(password)));
    const buf = new Uint8Array(4 + h.length);
    for (let i = 0; i < count; i++) {
      buf.set(le32(i), 0);
      buf.set(h, 4);
      h = await hash(alg, buf);
    }
    return h;
  }

  // 암호 정보 XML 에서 태그 속성 읽기 (DOMParser 없이도 되게 정규식으로)
  function xmlAttrs(xml, tag) {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>`));
    if (!m) return null;
    const out = {};
    for (const a of m[1].matchAll(/([\w:]+)="([^"]*)"/g)) out[a[1]] = a[2];
    return out;
  }

  function agileParams(info) {
    const xml = new TextDecoder().decode(info.subarray(8));
    const keyData = xmlAttrs(xml, 'keyData');
    const enc = xmlAttrs(xml, 'encryptedKey');
    if (!keyData || !enc || !enc.spinCount) throw fail('format', '잠긴 파일의 암호 정보를 읽지 못했어요.');
    const a = (n, k) => n[k];
    return {
      data: { salt: b64(a(keyData, 'saltValue')), blockSize: Number(a(keyData, 'blockSize')), hash: HASHES[a(keyData, 'hashAlgorithm')] },
      key: {
        spin: Number(a(enc, 'spinCount')),
        salt: b64(a(enc, 'saltValue')),
        hash: HASHES[a(enc, 'hashAlgorithm')],
        keyBytes: Number(a(enc, 'keyBits')) / 8,
        verifierInput: b64(a(enc, 'encryptedVerifierHashInput')),
        verifierValue: b64(a(enc, 'encryptedVerifierHashValue')),
        keyValue: b64(a(enc, 'encryptedKeyValue')),
      },
    };
  }

  async function agileDecrypt(info, pkg, password) {
    const p = agileParams(info);
    if (!p.key.hash || !p.data.hash) throw fail('format', '지원하지 않는 암호 방식이에요.');
    const k = p.key;
    const h = await spin(k.hash, k.salt, password, k.spin);
    const blockKey = async (block) => fit(await hash(k.hash, concat(h, new Uint8Array(block))), k.keyBytes, 0x36);
    const input = await aesCbcRaw(await blockKey([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]), k.salt, k.verifierInput);
    const value = await aesCbcRaw(await blockKey([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]), k.salt, k.verifierValue);
    const expect = await hash(k.hash, input.subarray(0, k.salt.length));
    if (!same(expect, value.subarray(0, expect.length))) return null;
    const secret = (await aesCbcRaw(await blockKey([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]), k.salt, k.keyValue)).subarray(0, k.keyBytes);

    const size = new DataView(pkg.buffer, pkg.byteOffset).getUint32(0, true);
    const body = pkg.subarray(8);
    const out = new Uint8Array(body.length);
    for (let i = 0, seg = 0; i < body.length; i += 4096, seg++) {
      const iv = fit(await hash(p.data.hash, concat(p.data.salt, le32(seg))), p.data.blockSize, 0x36);
      out.set(await aesCbcRaw(secret, iv, body.subarray(i, Math.min(i + 4096, body.length))), i);
    }
    return out.subarray(0, size);
  }

  async function standardDecrypt(info, pkg, password) {
    const v = new DataView(info.buffer, info.byteOffset, info.byteLength);
    const headerSize = v.getUint32(8, true);
    const algId = v.getUint32(12 + 8, true);
    const keyBits = v.getUint32(12 + 16, true) || 128;
    if (![0x660e, 0x660f, 0x6610].includes(algId)) throw fail('format', '지원하지 않는 옛날 암호 방식이에요. 엑셀에서 비밀번호를 풀어 저장한 뒤 올려 주세요.');
    let p = 12 + headerSize;
    const saltSize = v.getUint32(p, true);
    const salt = info.subarray(p + 4, p + 4 + saltSize);
    p += 4 + saltSize;
    const encVerifier = info.subarray(p, p + 16);
    const encVerifierHash = info.subarray(p + 20, p + 20 + 32);

    let h = await spin('SHA-1', salt, password, 50000);
    h = await hash('SHA-1', concat(h, le32(0)));
    const xor = (b) => fit(h, 64, 0).map((x) => x ^ b);
    const key = concat(await hash('SHA-1', xor(0x36)), await hash('SHA-1', xor(0x5c))).subarray(0, keyBits / 8);
    const verifier = await aesEcbRaw(key, encVerifier);
    const verifierHash = await aesEcbRaw(key, encVerifierHash);
    if (!same(await hash('SHA-1', verifier), verifierHash.subarray(0, 20))) return null;
    const size = new DataView(pkg.buffer, pkg.byteOffset).getUint32(0, true);
    const body = pkg.subarray(8, 8 + Math.floor((pkg.length - 8) / 16) * 16);
    return (await aesEcbRaw(key, body)).subarray(0, size);
  }

  // 잠긴 엑셀을 비밀번호로 푼다. 맞는 비밀번호가 없으면 null
  async function decryptOffice(buf, password) {
    const s = readOle(buf);
    const info = s.EncryptionInfo;
    const pkg = s.EncryptedPackage;
    if (!info || !pkg) {
      throw fail('format', s.Workbook || s.Book
        ? '옛날 엑셀(.xls) 형식이라 읽지 못해요. 엑셀이나 구글 시트에서 열어 .xlsx 또는 CSV 로 저장한 뒤 올려 주세요.'
        : '엑셀 파일 구조를 읽지 못했어요.');
    }
    const major = info[0] | (info[1] << 8);
    const minor = info[2] | (info[3] << 8);
    if (major === 4 && minor === 4) return agileDecrypt(info, pkg, password);
    if ((major === 3 || major === 4) && minor === 2) return standardDecrypt(info, pkg, password);
    throw fail('format', '지원하지 않는 암호 방식이에요. 엑셀에서 비밀번호를 풀어 저장한 뒤 올려 주세요.');
  }

  // 저장해 둔 비밀번호를 차례로 시도하고, 다 틀리면 물어본다.
  // opts: { passwords: [..], askPassword: async (wrong) => 문자열 | null, onPassword: (pw) => void }
  async function unlockOffice(buf, opts = {}) {
    const tried = new Set();
    for (const pw of opts.passwords || []) {
      if (!pw || tried.has(pw)) continue;
      tried.add(pw);
      const out = await decryptOffice(buf, pw);
      if (out) {
        if (opts.onPassword) opts.onPassword(pw, false);
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      }
    }
    for (let attempt = 0; opts.askPassword && attempt < 5; attempt++) {
      const pw = await opts.askPassword(tried.size > 0);
      if (pw === null || pw === undefined) break;
      if (!pw || tried.has(pw)) continue;
      tried.add(pw);
      const out = await decryptOffice(buf, pw);
      if (out) {
        if (opts.onPassword) opts.onPassword(pw, true);
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      }
    }
    throw fail('password', tried.size ? '파일 비밀번호가 맞지 않아요. 가져오기 화면의 파일 비밀번호를 확인해 주세요.' : '비밀번호가 걸린 파일이에요. 가져오기 화면에 파일 비밀번호를 넣어 주세요.');
  }

  async function readXlsx(arrayBuffer, opts = {}) {
    let head = new Uint8Array(arrayBuffer.slice(0, 4));
    // D0 CF 11 E0: 비밀번호가 걸린 엑셀(또는 옛날 .xls). 비밀번호로 풀어서 읽는다
    if (isOle(head)) {
      arrayBuffer = await unlockOffice(arrayBuffer, opts);
      head = new Uint8Array(arrayBuffer.slice(0, 4));
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
  async function readTableFile(file, opts = {}) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isZipOrOle = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);
    if (isZipOrOle || /\.xlsx?$/i.test(file.name)) return readXlsx(buf, opts);
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

  root.BudgetXlsx = { readXlsx, readTableFile, decryptOffice, unlockOffice };
})(typeof globalThis !== 'undefined' ? globalThis : this);
