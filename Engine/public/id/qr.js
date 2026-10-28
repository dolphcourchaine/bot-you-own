// ============================================================================
//  QR CODE — draws the square an authenticator app scans. No libraries.
//
//  Why write our own: the only thing we ever encode is a short "otpauth://"
//  link (under ~200 characters), and pulling in a 30 KB library for that is
//  more code to trust than the 300 lines below. This is the real QR standard
//  (ISO 18004), just trimmed to what we need:
//
//    • byte mode only (any text, UTF-8)
//    • error-correction level M by default (a quarter of the square can be
//      smudged and it still scans); L is available if a text is too long for M
//    • versions 1–10 (21×21 up to 57×57 modules) — plenty for an otpauth link
//    • proper Reed-Solomon error-correction codewords
//    • all 8 mask patterns tried, scored by the standard four penalty rules,
//      best one kept — so phones lock on quickly
//    • format info, and version info for versions 7 and up
//
//  Use in a page:
//    window.qrMatrix(text)            → boolean[][] (true = dark module)
//    window.drawQr(canvas, text, { scale: 4, margin: 4 })
//                                     → sizes the canvas and paints it
//  The same file loads in node (module.exports = { qrMatrix }) so the tests
//  can check the maths without a browser.
// ============================================================================
(function () {
  "use strict";

  // ---- per-version tables (index = version, 0 unused) ---------------------
  const EC_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  };
  const NUM_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  };
  const LEVEL_BITS = { L: 1, M: 0 };   // the two bits that go into the format info
  const MAX_VERSION = 10;

  // How many modules are free for data+EC once the fixed patterns are placed.
  function rawDataModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (ver, level) => Math.floor(rawDataModules(ver) / 8) - EC_PER_BLOCK[level][ver] * NUM_BLOCKS[level][ver];

  // ---- step 1: text → bit stream (byte mode) -----------------------------
  function textToBytes(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    const out = [];   // hand-rolled UTF-8 for very old browsers
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }

  function buildCodewords(bytes, ver, level) {
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4);                                   // mode indicator: byte
    push(bytes.length, ver <= 9 ? 8 : 16);        // character count
    for (const b of bytes) push(b, 8);
    const capacity = dataCodewords(ver, level) * 8;
    push(0, Math.min(4, capacity - bits.length));  // terminator
    while (bits.length % 8) bits.push(0);          // pad to a byte boundary
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);   // alternate 11101100 / 00010001
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    return words;
  }

  // ---- step 2: Reed-Solomon error correction ----------------------------
  // Arithmetic in GF(2^8) with the QR polynomial 0x11D.
  function gfMul(a, b) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((b >>> i) & 1) * a;
    }
    return z & 255;
  }
  function rsGenerator(degree) {
    let poly = [1];
    let root = 1;
    for (let i = 0; i < degree; i++) {
      // multiply the running polynomial by (x + root); coefficients are highest power first
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                       // the "x ·" term shifts everything up one power
        next[j + 1] ^= gfMul(poly[j], root);      // the "root ·" term stays put
      }
      poly = next;
      root = gfMul(root, 2);
    }
    return poly;   // highest degree first, leading coefficient 1
  }
  function rsRemainder(data, gen) {
    const rem = new Array(gen.length - 1).fill(0);
    for (const b of data) {
      const factor = b ^ rem.shift();
      rem.push(0);
      for (let i = 0; i < rem.length; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return rem;
  }

  // Split into blocks, add EC to each, then interleave the way the spec wants.
  function addErrorCorrection(data, ver, level) {
    const numBlocks = NUM_BLOCKS[level][ver], ecLen = EC_PER_BLOCK[level][ver];
    const total = Math.floor(rawDataModules(ver) / 8);
    const shortBlocks = numBlocks - (total % numBlocks);
    const shortLen = Math.floor(total / numBlocks) - ecLen;
    const gen = rsGenerator(ecLen);
    const blocks = [];
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const len = shortLen + (i < shortBlocks ? 0 : 1);
      const chunk = data.slice(k, k + len); k += len;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, gen) });
    }
    const out = [];
    const longest = shortLen + 1;
    for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  // ---- step 3: the grid ---------------------------------------------------
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const count = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const pos = [6];
    for (let i = 0, p = ver * 4 + 10; i < count - 1; i++, p -= step) pos.push(p);
    return pos.sort((a, b) => a - b);
  }

  function makeGrid(ver) {
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));   // true = not a data module
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = dark; fixed[y][x] = true; } };

    // Finder patterns (the three big squares) with their light separators.
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // Timing patterns: the dotted lines between the finders.
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // Alignment patterns (small squares), skipping the ones that would overlap finders.
    const ap = alignmentPositions(ver);
    for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    // Reserve the format-info strips (filled in later) and the dark module.
    writeFormat(modules, fixed, size, "M", 0);   // placeholder — real values come after masking
    if (ver >= 7) writeVersion(modules, fixed, size, ver);
    return { size, modules, fixed };
  }

  function writeFormat(modules, fixed, size, level, mask) {
    const data = (LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);   // the "dark module" — always dark
  }

  function writeVersion(modules, fixed, size, ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      modules[b][a] = dark; fixed[b][a] = true;
      modules[a][b] = dark; fixed[a][b] = true;
    }
  }

  // Data goes in a zigzag: two columns at a time, from the bottom-right,
  // up one pair then down the next, skipping the vertical timing column.
  function placeData(grid, codewords) {
    const { size, modules, fixed } = grid;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fixed[y][x] && i < total) {
            modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  // ---- step 4: masks, and the penalty score that picks the best one -------
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(grid, mask) {
    const { size, modules, fixed } = grid;
    const fn = MASKS[mask];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && fn(x, y)) modules[y][x] = !modules[y][x];
  }

  // The four penalty rules from the standard. Lower is better.
  function penalty(modules, size) {
    let score = 0;
    // Rule 1: runs of 5+ same-colour modules in a row/column.
    // Rule 3: anything that looks like a finder pattern (dark 1:1:3:1:1 with
    //         4 light modules on a side) — it confuses the scanner.
    const scanLine = (get) => {
      const runs = [];   // [{ dark, len }] for this line
      for (let i = 0; i < size; i++) {
        const cur = get(i);
        if (runs.length && runs[runs.length - 1].dark === cur) runs[runs.length - 1].len++;
        else runs.push({ dark: cur, len: 1 });
      }
      for (const r of runs) if (r.len >= 5) score += 3 + (r.len - 5);
      for (let k = 0; k + 4 < runs.length; k++) {
        const [a, b, c, d, e] = runs.slice(k, k + 5);
        const looksLikeFinder = a.dark && !b.dark && c.dark && !d.dark && e.dark && a.len === b.len && a.len === d.len && a.len === e.len && c.len === 3 * a.len;
        if (!looksLikeFinder) continue;
        if (k === 0 || runs[k - 1].len >= 4) score += 40;                     // light on the left (or the edge)
        if (k + 5 === runs.length || runs[k + 5].len >= 4) score += 40;       // light on the right (or the edge)
      }
    };
    for (let y = 0; y < size; y++) scanLine((x) => modules[y][x]);
    for (let x = 0; x < size; x++) scanLine((y) => modules[y][x]);
    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
    // Rule 4: how far the dark proportion strays from 50%.
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
    score += k * 10;
    return score;
  }

  // ---- put it together ----------------------------------------------------
  function qrMatrix(text, opts) {
    const wanted = (opts && opts.level) || "M";
    const bytes = textToBytes(String(text));
    // Smallest version that fits at the wanted level; if nothing fits at M, try L.
    let ver = 0, level = wanted;
    for (const lv of wanted === "M" ? ["M", "L"] : ["L"]) {
      for (let v = 1; v <= MAX_VERSION; v++) {
        const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
        if (needBits <= dataCodewords(v, lv) * 8) { ver = v; level = lv; break; }
      }
      if (ver) break;
    }
    if (!ver) throw new Error("text too long for a QR code up to version " + MAX_VERSION);

    const codewords = addErrorCorrection(buildCodewords(bytes, ver, level), ver, level);
    let best = null;
    const forced = opts && Number.isInteger(opts.mask) ? opts.mask : -1;   // tests can pin a mask
    for (let mask = 0; mask < 8; mask++) {
      if (forced >= 0 && mask !== forced) continue;
      const grid = makeGrid(ver);
      placeData(grid, codewords);
      writeFormat(grid.modules, grid.fixed, grid.size, level, mask);
      applyMask(grid, mask);
      const score = penalty(grid.modules, grid.size);
      if (!best || score < best.score) best = { score, modules: grid.modules, mask };
    }
    return best.modules;
  }

  function drawQr(canvas, text, opts) {
    const scale = (opts && opts.scale) || 4, margin = opts && opts.margin != null ? opts.margin : 4;
    const m = qrMatrix(text, opts);
    const px = (m.length + margin * 2) * scale;
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    return canvas;
  }

  if (typeof window !== "undefined") { window.qrMatrix = qrMatrix; window.drawQr = drawQr; }
  if (typeof module !== "undefined") module.exports = { qrMatrix, drawQr };
})();
