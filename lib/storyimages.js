// Story images: dependency-free PNG renderer for the illustrative evidence images of the closed-loop demo
// (tolerance charts, trend charts, bar charts, before/after comparisons, annotated component photo, record cards,
// closed-loop diagram). These are diagrams, not photographs; every image carries a small "illustrative" footer.
const zlib = require('zlib');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* ---------- 5x7 bitmap font (upper case technical lettering) ---------- */

const GLYPHS = {
    A: '.###./#...#/#...#/#####/#...#/#...#/#...#', B: '####./#...#/#...#/####./#...#/#...#/####.', C: '.###./#...#/#..../#..../#..../#...#/.###.',
    D: '####./#...#/#...#/#...#/#...#/#...#/####.', E: '#####/#..../#..../####./#..../#..../#####', F: '#####/#..../#..../####./#..../#..../#....',
    G: '.###./#...#/#..../#.###/#...#/#...#/.###.', H: '#...#/#...#/#...#/#####/#...#/#...#/#...#', I: '.###./..#../..#../..#../..#../..#../.###.',
    J: '..###/...#./...#./...#./...#./#..#./.##..', K: '#...#/#..#./#.#../##.../#.#../#..#./#...#', L: '#..../#..../#..../#..../#..../#..../#####',
    M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#', N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#', O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
    P: '####./#...#/#...#/####./#..../#..../#....', Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', R: '####./#...#/#...#/####./#.#../#..#./#...#',
    S: '.####/#..../#..../.###./....#/....#/####.', T: '#####/..#../..#../..#../..#../..#../..#..', U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
    V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..', W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
    Y: '#...#/#...#/.#.#./..#../..#../..#../..#..', Z: '#####/....#/...#./..#../.#.../#..../#####',
    0: '.###./#...#/#..##/#.#.#/##..#/#...#/.###.', 1: '..#../.##../..#../..#../..#../..#../.###.', 2: '.###./#...#/....#/...#./..#../.#.../#####',
    3: '.###./#...#/....#/..##./....#/#...#/.###.', 4: '...#./..##./.#.#./#..#./#####/...#./...#.', 5: '#####/#..../####./....#/....#/#...#/.###.',
    6: '..##./.#.../#..../####./#...#/#...#/.###.', 7: '#####/....#/...#./..#../.#.../.#.../.#...', 8: '.###./#...#/#...#/.###./#...#/#...#/.###.',
    9: '.###./#...#/#...#/.####/....#/...#./.##..',
    ' ': '...../...../...../...../...../...../.....', '.': '...../...../...../...../...../.##../.##..', ',': '...../...../...../...../.##../..#../.#...',
    ':': '...../.##../.##../...../.##../.##../.....', ';': '...../.##../.##../...../.##../..#../.#...', '-': '...../...../...../#####/...../...../.....',
    '+': '...../..#../..#../#####/..#../..#../.....', '/': '....#/....#/...#./..#../.#.../#..../#....', '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
    ')': '.#.../..#../...#./...#./...#./..#../.#...', '%': '##..#/##..#/...#./..#../.#.../#..##/#..##', '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
    '=': '...../#####/...../#####/...../...../.....', '<': '...#./..#../.#.../#..../.#.../..#../...#.', '>': '.#.../..#../...#./....#/...#./..#../.#...',
    '_': '...../...../...../...../...../...../#####', "'": '..#../..#../.#.../...../...../...../.....', '"': '.#.#./.#.#./.#.#./...../...../...../.....',
    '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#', '!': '..#../..#../..#../..#../..#../...../..#..', '?': '.###./#...#/....#/...#./..#../...../..#..',
    '*': '...../#.#.#/.###./#####/.###./#.#.#/.....', '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.', ']': '.###./...#./...#./...#./...#./...#./.###.',
    '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.', '^': '..#../.#.#./#...#/...../...../...../.....'
};
const GLYPH_ROWS = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.split('/').map((r) => r.split('').map((c) => c === '#'))]));
const CHAR_MAP = { '±': '+/-', '°': ' DEG', '×': 'X', 'µ': 'U', 'μ': 'U', 'Ø': 'O', '⌀': 'O', '–': '-', '—': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '→': '>', '…': '...', '≤': '<=', '≥': '>=', '·': '.' };
const prep = (s) => String(s ?? '').replace(/[±°×µμØ⌀–—’‘“”→…≤≥·]/g, (c) => CHAR_MAP[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?').toUpperCase();

/* ---------- PNG encode / decode ---------- */

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buf) {
    if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null; const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
        else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (depth !== 8 || interlace || ![0, 2, 3, 4, 6].includes(ctype)) return null;
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const v = raw[y * (stride + 1) + 1 + x];
            const a = x >= ch ? px[y * stride + x - ch] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
            let r;
            if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
            else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
            px[y * stride + x] = r & 255;
        }
    }
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        let r, g, b, a = 255;
        if (ctype === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
        else if (ctype === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
        else if (ctype === 0) { r = g = b = px[i]; }
        else if (ctype === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
        else { const k = px[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
    }
    return { w, h, rgba: out };
}
// PNG decodes natively. JPEG is converted with the macOS "sips" tool when available; otherwise the photo is skipped.
function decodeImage(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8 && process.platform === 'darwin') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-img-'));
        try {
            fs.writeFileSync(path.join(dir, 'in.jpg'), buf);
            execFileSync('sips', ['-s', 'format', 'png', path.join(dir, 'in.jpg'), '--out', path.join(dir, 'out.png')], { stdio: 'ignore' });
            return decodePng(fs.readFileSync(path.join(dir, 'out.png')));
        } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    return null;
}
const sniff = (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? { type: 'image/png', ext: 'png' } : buf[0] === 0xff && buf[1] === 0xd8 ? { type: 'image/jpeg', ext: 'jpg' } : null);

/* ---------- canvas (2x supersampled) ---------- */

const hex = (c) => {
    if (Array.isArray(c)) return c;
    const h = c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};
const C = { bg: '#f4f6f8', panel: '#ffffff', ink: '#1f2933', mute: '#697586', line: '#cbd2d9', accent: '#0b6bcb', pass: '#2f9e44', fail: '#d92d20', warn: '#f08c00', band: '#d3f0da', dark: '#102a43' };

class Canvas {
    constructor(w, h, bg = C.bg) {
        this.w = w; this.h = h; this.S = 2; this.W = w * 2; this.H = h * 2; this.d = Buffer.alloc(this.W * this.H * 4);
        this.rect(0, 0, w, h, bg);
    }
    _px(x, y, c, a = 1) {
        if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
        const i = (y * this.W + x) * 4, d = this.d;
        if (a >= 1) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; return; }
        d[i] = d[i] * (1 - a) + c[0] * a; d[i + 1] = d[i + 1] * (1 - a) + c[1] * a; d[i + 2] = d[i + 2] * (1 - a) + c[2] * a; d[i + 3] = 255;
    }
    rect(x, y, w, h, color, a = 1) {
        const c = hex(color), S = this.S;
        for (let yy = Math.round(y * S); yy < Math.round((y + h) * S); yy++) for (let xx = Math.round(x * S); xx < Math.round((x + w) * S); xx++) this._px(xx, yy, c, a);
    }
    frame(x, y, w, h, color, th = 1) { this.rect(x, y, w, th, color); this.rect(x, y + h - th, w, th, color); this.rect(x, y, th, h, color); this.rect(x + w - th, y, th, h, color); }
    disc(cx, cy, r, color, a = 1, inner = 0) {
        const c = hex(color), S = this.S, R = r * S, Rin = inner * S;
        for (let y = Math.floor(cy * S - R); y <= cy * S + R; y++) for (let x = Math.floor(cx * S - R); x <= cx * S + R; x++) {
            const dd = Math.hypot(x + 0.5 - cx * S, y + 0.5 - cy * S); if (dd <= R && dd >= Rin) this._px(x, y, c, a);
        }
    }
    ring(cx, cy, r, color, th = 3) { this.disc(cx, cy, r + th / 2, color, 1, r - th / 2); }
    line(x1, y1, x2, y2, color, th = 2, dash = 0) {
        const len = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(len * 2);
        for (let i = 0; i <= n; i++) {
            if (dash && Math.floor((i / 2) / dash) % 2 === 1) continue;
            const t = i / n; this.disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, th / 2, color);
        }
    }
    arrow(x1, y1, x2, y2, color, th = 3, dash = 0) {
        this.line(x1, y1, x2, y2, color, th, dash);
        const ang = Math.atan2(y2 - y1, x2 - x1), s = 12;
        this.poly([[x2, y2], [x2 - s * Math.cos(ang - 0.45), y2 - s * Math.sin(ang - 0.45)], [x2 - s * Math.cos(ang + 0.45), y2 - s * Math.sin(ang + 0.45)]], color);
    }
    poly(pts, color, a = 1) {
        const S = this.S, c = hex(color), P = pts.map(([x, y]) => [x * S, y * S]);
        const ys = P.map((p) => p[1]);
        for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
            const xs = [];
            for (let i = 0; i < P.length; i++) {
                const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
                if ((y + 0.5 >= Math.min(y1, y2)) && (y + 0.5 < Math.max(y1, y2))) xs.push(x1 + ((y + 0.5 - y1) / (y2 - y1)) * (x2 - x1));
            }
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this._px(x, y, c, a);
        }
    }
    textWidth(str, size) { return prep(str).length * 6 * size - size; }
    text(str, x, y, { size = 3, color = C.ink, align = 'left' } = {}) {
        const s = prep(str), S = this.S, px = Math.max(1, Math.round(size * S)), c = hex(color);
        const w = (s.length * 6 - 1) * px;
        let cx = Math.round(x * S) - (align === 'center' ? Math.round(w / 2) : align === 'right' ? w : 0);
        const cy = Math.round(y * S);
        for (const ch of s) {
            const g = GLYPH_ROWS[ch] || GLYPH_ROWS['?'];
            for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q]) for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) this._px(cx + q * px + xx, cy + r * px + yy, c);
            cx += 6 * px;
        }
    }
    wrap(str, size, maxW) {
        const out = []; let cur = '';
        for (const word of prep(str).split(/\s+/).filter(Boolean)) {
            const t = cur ? `${cur} ${word}` : word;
            if (this.textWidth(t, size) > maxW && cur) { out.push(cur); cur = word; } else cur = t;
        }
        if (cur) out.push(cur);
        return out;
    }
    para(str, x, y, { size = 3, color = C.ink, maxW = 600, gap = 1.6, max = 99 } = {}) {
        const lines = this.wrap(str, size, maxW).slice(0, max);
        lines.forEach((l, i) => this.text(l, x, y + i * 7 * size * gap, { size, color }));
        return lines.length * 7 * size * gap;
    }
    image(img, x, y, w, h) {
        const S = this.S, x0 = Math.round(x * S), y0 = Math.round(y * S), W = Math.round(w * S), H = Math.round(h * S);
        for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
            const sx = Math.min(img.w - 1, (xx / W) * img.w), sy = Math.min(img.h - 1, (yy / H) * img.h);
            const ix = Math.floor(sx), iy = Math.floor(sy), i = (iy * img.w + ix) * 4;
            const a = img.rgba[i + 3] / 255;
            this._px(x0 + xx, y0 + yy, [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]], a);
        }
    }
    png() {
        const out = Buffer.alloc(this.w * this.h * 4), S = this.S;
        for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
            let r = 0, g = 0, b = 0;
            for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const i = ((y * S + dy) * this.W + x * S + dx) * 4; r += this.d[i]; g += this.d[i + 1]; b += this.d[i + 2]; }
            const o = (y * this.w + x) * 4, n = S * S; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
        }
        return encodePng(this.w, this.h, out);
    }
}

/* ---------- layouts ---------- */

const W = 1280, H = 720;
function frame(spec, accent = C.accent) {
    const cv = new Canvas(W, H);
    cv.rect(0, 0, W, 92, accent);
    const badgeW = spec.badge ? cv.textWidth(spec.badge.text, 3) + 36 + 24 : 0;
    let ts = 4; while (ts > 2 && cv.textWidth(spec.title || '', ts) > W - 80 - badgeW) ts -= 0.5;
    cv.text(spec.title || '', 40, ts === 4 ? 22 : 26, { size: ts, color: '#ffffff' });
    if (spec.subtitle) cv.text(spec.subtitle, 40, 62, { size: 2, color: '#e6eef7' });
    if (spec.badge) {
        const bw = cv.textWidth(spec.badge.text, 3) + 36;
        cv.rect(W - 40 - bw, 24, bw, 44, '#ffffff'); cv.rect(W - 38 - bw, 26, bw - 4, 40, spec.badge.color || C.fail);
        cv.text(spec.badge.text, W - 40 - bw / 2, 36, { size: 3, color: '#ffffff', align: 'center' });
    }
    cv.rect(0, H - 34, W, 34, '#e4e7eb');
    cv.text(spec.footer || 'ILLUSTRATIVE DEMO IMAGE - GENERATED FOR THE CLOSED-LOOP STORY', 40, H - 24, { size: 2, color: C.mute });
    return cv;
}
const fmt = (n, dp = 2) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(dp)).toString() : String(n));
const status = (r) => (r.actual >= r.nominal - r.lo - 1e-9 && r.actual <= r.nominal + r.hi + 1e-9 ? 'PASS' : 'FAIL');

function measurementChart(spec) {
    const rows = spec.rows || [];
    if (!rows.length) throw new Error('measurement-chart needs rows (or source "inspection" with qip.grid and qi.results)');
    const fails = rows.filter((r) => status(r) === 'FAIL').length;
    const cv = frame({ subtitle: spec.subtitle, ...spec, badge: spec.badge === false ? null : { text: fails ? `${fails} OUT OF TOLERANCE` : 'ALL IN TOLERANCE', color: fails ? C.fail : C.pass } }, C.dark);
    const top = 120, rowH = Math.min(78, (H - 34 - top - 30) / rows.length), tx0 = 400, tx1 = 900;
    cv.text('CHARACTERISTIC', 40, top - 22, { size: 2, color: C.mute }); cv.text('TOLERANCE BAND AND MEASURED VALUE', tx0, top - 22, { size: 2, color: C.mute }); cv.text('ACTUAL / RESULT', 940, top - 22, { size: 2, color: C.mute });
    rows.forEach((r, i) => {
        const y = top + i * rowH, cy = y + rowH / 2, t = Math.max(r.lo, r.hi, 1e-9), lo = r.nominal - 3 * t, span = 6 * t;
        const X = (v) => tx0 + ((Math.min(Math.max(v, lo), lo + span) - lo) / span) * (tx1 - tx0), ok = status(r) === 'PASS', col = ok ? C.pass : C.fail;
        cv.rect(30, y + 4, W - 60, rowH - 8, i % 2 ? '#eef1f4' : '#ffffff');
        const lab = cv.wrap(r.label, 2, 340); cv.text(lab[0] || '', 40, cy - (lab.length > 1 ? 16 : 7), { size: 2 }); if (lab[1]) cv.text(lab[1], 40, cy + 3, { size: 2 });
        cv.rect(tx0, cy - 2, tx1 - tx0, 4, C.line);
        cv.rect(X(r.nominal - r.lo), cy - 14, X(r.nominal + r.hi) - X(r.nominal - r.lo), 28, C.band);
        cv.line(X(r.nominal), cy - 20, X(r.nominal), cy + 20, C.mute, 2);
        cv.disc(X(r.actual), cy, 11, col); cv.ring(X(r.actual), cy, 15, col, 2);
        cv.text(`${fmt(r.actual, 3)} ${r.unit || ''}`, 940, cy - 7, { size: 2.5 });
        cv.rect(1110, cy - 15, 130, 30, col); cv.text(ok ? 'PASS' : 'FAIL', 1175, cy - 7, { size: 2.5, color: '#fff', align: 'center' });
    });
    return cv;
}

function trendChart(spec) {
    const pts = spec.points || [];
    if (pts.length < 3) throw new Error('trend-chart needs at least 3 points');
    const cv = frame(spec, C.dark), x0 = 130, x1 = 1230, y0 = 150, y1 = 610;
    const vals = [...pts, spec.usl, spec.lsl, spec.nominal].filter((v) => Number.isFinite(v));
    let mn = Math.min(...vals), mx = Math.max(...vals); const pad = (mx - mn) * 0.12 || 1; mn -= pad; mx += pad;
    const Y = (v) => y1 - ((v - mn) / (mx - mn)) * (y1 - y0), X = (i) => x0 + (i / (pts.length - 1)) * (x1 - x0);
    cv.rect(x0, y0, x1 - x0, y1 - y0, '#ffffff'); cv.frame(x0, y0, x1 - x0, y1 - y0, C.line);
    for (let k = 0; k <= 4; k++) { const v = mn + ((mx - mn) * k) / 4; cv.line(x0, Y(v), x1, Y(v), '#e4e7eb', 1); cv.text(fmt(v, 3), x0 - 12, Y(v) - 6, { size: 2, color: C.mute, align: 'right' }); }
    const lim = (v, label, col, dash) => { if (!Number.isFinite(v)) return; cv.line(x0, Y(v), x1, Y(v), col, 2, dash); cv.text(`${label} ${fmt(v, 3)}`, x1 - 8, Y(v) - 20, { size: 2, color: col, align: 'right' }); };
    lim(spec.usl, 'UPPER LIMIT', C.fail, 8); lim(spec.lsl, 'LOWER LIMIT', C.fail, 8); lim(spec.nominal, 'NOMINAL', C.mute, 0);
    const bad = (v) => (Number.isFinite(spec.usl) && v > spec.usl) || (Number.isFinite(spec.lsl) && v < spec.lsl);
    for (let i = 0; i < pts.length - 1; i++) cv.line(X(i), Y(pts[i]), X(i + 1), Y(pts[i + 1]), C.accent, 3);
    const labels = spec.labels || pts.map((_, i) => String(i + 1));
    pts.forEach((v, i) => {
        cv.disc(X(i), Y(v), 8, bad(v) ? C.fail : C.accent);
        if (pts.length <= 16 || i % Math.ceil(pts.length / 12) === 0) cv.text(labels[i] || '', X(i), y1 + 14, { size: 2, color: C.mute, align: 'center' });
    });
    if (spec.xLabel) cv.text(spec.xLabel, (x0 + x1) / 2, y1 + 44, { size: 2, color: C.mute, align: 'center' });
    if (spec.unit) cv.text(`UNIT: ${spec.unit}`, x0, y0 - 24, { size: 2, color: C.mute });
    return cv;
}

function barChart(spec) {
    const bars = spec.bars || [];
    if (!bars.length) throw new Error('bar-chart needs bars');
    const cv = frame(spec), x0 = 90, x1 = 1230, y0 = 150, y1 = 560, max = Math.max(...bars.map((b) => b.value)) * 1.15 || 1;
    const bw = Math.min(160, ((x1 - x0) / bars.length) * 0.6), colors = [C.accent, '#1c7ed6', C.warn, C.pass, '#7048e8', C.fail];
    cv.line(x0, y1, x1, y1, C.mute, 2);
    bars.forEach((b, i) => {
        const cx = x0 + ((i + 0.5) * (x1 - x0)) / bars.length, h = (b.value / max) * (y1 - y0);
        cv.rect(cx - bw / 2, y1 - h, bw, h, b.color || colors[i % colors.length]);
        cv.text(`${spec.prefix || ''}${Number(b.value).toLocaleString('en-US')}${spec.suffix || ''}`, cx, y1 - h - 26, { size: 2.5, align: 'center' });
        cv.wrap(b.label, 2, (x1 - x0) / bars.length - 16).slice(0, 3).forEach((l, k) => cv.text(l, cx, y1 + 14 + k * 20, { size: 2, color: C.mute, align: 'center' }));
    });
    if (spec.total) cv.text(`TOTAL ${spec.prefix || ''}${Number(spec.total).toLocaleString('en-US')}${spec.suffix || ''}`, x1, 118, { size: 3, align: 'right', color: C.accent });
    return cv;
}

function comparison(spec) {
    const rows = spec.rows || [];
    if (!rows.length) throw new Error('comparison needs rows');
    const cv = frame(spec), top = 150, rowH = Math.min(100, (H - 34 - top - 20) / rows.length), x0 = 430, wmax = 640;
    cv.rect(x0, 112, 22, 14, C.fail); cv.text(spec.beforeLabel || 'CURRENT', x0 + 32, 112, { size: 2 });
    cv.rect(x0 + 260, 112, 22, 14, C.pass); cv.text(spec.afterLabel || 'PROPOSED', x0 + 292, 112, { size: 2 });
    rows.forEach((r, i) => {
        const y = top + i * rowH, m = Math.max(Math.abs(r.before), Math.abs(r.after)) * 1.1 || 1;
        cv.rect(30, y, W - 60, rowH - 10, i % 2 ? '#eef1f4' : '#ffffff');
        cv.wrap(r.label, 2.5, 370).slice(0, 2).forEach((l, k) => cv.text(l, 44, y + 14 + k * 24, { size: 2.5 }));
        const bar = (v, yy, col) => { cv.rect(x0, yy, Math.max(4, (Math.abs(v) / m) * wmax), 22, col); cv.text(`${fmt(v, 3)} ${r.unit || ''}`, x0 + Math.max(4, (Math.abs(v) / m) * wmax) + 12, yy + 3, { size: 2 }); };
        bar(r.before, y + 10, C.fail); bar(r.after, y + 40, C.pass);
    });
    return cv;
}

function callout(spec, data) {
    const cv = frame(spec, spec.accent || C.dark), bx = 40, by = 116, bw = 740, bh = 550;
    cv.rect(bx, by, bw, bh, '#ffffff'); cv.frame(bx, by, bw, bh, C.line, 2);
    let fx = bx, fy = by, fw = bw, fh = bh;
    if (data.photo) {
        const k = Math.min(bw / data.photo.w, bh / data.photo.h); fw = data.photo.w * k; fh = data.photo.h * k; fx = bx + (bw - fw) / 2; fy = by + (bh - fh) / 2;
        cv.image(data.photo, fx, fy, fw, fh);
    } else { cv.text('NO COMPONENT IMAGE AVAILABLE', bx + bw / 2, by + bh / 2 - 8, { size: 3, color: C.line, align: 'center' }); }
    const list = spec.callouts || [];
    list.forEach((c, i) => {
        const col = c.color || C.fail, px = fx + c.x * fw, py = fy + c.y * fh, r = c.radius || 34;
        cv.ring(px, py, r, col, 5); cv.disc(px + r * 0.72, py - r * 0.72, 15, col); cv.text(String(i + 1), px + r * 0.72, py - r * 0.72 - 8, { size: 2.5, color: '#fff', align: 'center' });
    });
    let y = by + 6; cv.text(spec.legendTitle || 'MARKED AREAS', 810, y, { size: 2.5, color: C.mute }); y += 44;
    list.forEach((c, i) => {
        const col = c.color || C.fail; cv.disc(830, y + 12, 15, col); cv.text(String(i + 1), 830, y + 4, { size: 2.5, color: '#fff', align: 'center' });
        y += cv.para(c.label, 862, y, { size: 2.5, maxW: 370, max: 4 }) + 26;
    });
    return cv;
}

function card(spec) {
    const cv = frame(spec, spec.accent || C.accent);
    cv.rect(40, 120, W - 80, H - 34 - 120 - 24, '#ffffff'); cv.frame(40, 120, W - 80, H - 34 - 120 - 24, C.line, 2);
    let y = 150;
    for (const l of spec.lines || []) {
        const head = /^##\s*/.test(l);
        if (head) { cv.text(l.replace(/^##\s*/, ''), 72, y, { size: 3, color: spec.accent || C.accent }); y += 48; continue; }
        cv.disc(80, y + 12, 5, spec.accent || C.accent);
        y += cv.para(l, 104, y, { size: 2.8, maxW: W - 220, max: 3 }) + 16;
        if (y > H - 100) break;
    }
    return cv;
}

function closedLoop(spec, data) {
    const cv = frame({ title: spec.title || 'CLOSED LOOP FROM INSPECTION TO DESIGN CHANGE', subtitle: spec.subtitle }, C.dark);
    const nodes = [['qip', 'QUALITY INSPECTION PLAN'], ['qi', 'QUALITY INSPECTION'], ['nc', 'NON CONFORMANCE'], ['capa', 'CAPA'], ['cr', 'CHANGE REQUEST'], ['co', 'CHANGE ORDER']];
    const pos = [[80, 160], [470, 160], [860, 160], [860, 440], [470, 440], [80, 440]], w = 340, h = 150;
    nodes.forEach(([k, label], i) => {
        const [x, y] = pos[i], rec = data.records?.[k] || {}, on = spec.highlight === k;
        cv.rect(x, y, w, h, '#ffffff'); cv.frame(x, y, w, h, on ? C.fail : C.accent, on ? 5 : 3);
        cv.text(label, x + w / 2, y + 24, { size: 2, color: C.mute, align: 'center' });
        cv.text(rec.number || '-', x + w / 2, y + 62, { size: 4, color: C.dark, align: 'center' });
        cv.text(rec.state || '', x + w / 2, y + 114, { size: 2, color: C.accent, align: 'center' });
    });
    cv.arrow(420, 235, 466, 235, C.accent, 4); cv.arrow(810, 235, 856, 235, C.accent, 4); cv.arrow(1030, 312, 1030, 436, C.accent, 4);
    cv.arrow(856, 515, 814, 515, C.accent, 4); cv.arrow(466, 515, 424, 515, C.accent, 4);
    cv.line(250, 436, 250, 400, C.warn, 4, 6); cv.line(250, 400, 250, 318, C.warn, 4, 6); cv.arrow(250, 330, 250, 312, C.warn, 4);
    cv.text('DESIGN CHANGE UPDATES THE NEXT INSPECTION PLAN', 640, 372, { size: 2.5, color: C.warn, align: 'center' });
    return cv;
}

const TYPES = { 'measurement-chart': measurementChart, 'trend-chart': trendChart, 'bar-chart': barChart, comparison, callout, card, 'closed-loop': closedLoop };

// data: { rows (for source:"inspection"), photo (decoded component photo or null), records (for closed-loop) }
function render(spec, data = {}) {
    const fn = TYPES[spec?.type];
    if (!fn) throw new Error(`unknown image type "${spec?.type}" (types: ${Object.keys(TYPES).join(', ')})`);
    const s = { ...spec };
    if (s.type === 'measurement-chart' && s.source === 'inspection') s.rows = data.rows;
    return fn(s, data).png();
}

module.exports = { render, decodeImage, decodePng, encodePng, sniff, TYPES, Canvas };
