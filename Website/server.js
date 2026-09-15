#!/usr/bin/env node
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const os     = require('os');
const crypto = require('crypto');
const zlib   = require('zlib');
const { spawnSync, spawn } = require('child_process');

const PORT          = process.env.PORT || 3000;
const __WEBSITE     = __dirname;
const __DATA        = path.resolve(__dirname, '..', 'Data');
const __DATA_HU     = path.resolve(__dirname, '..', 'DataHU');
const __ARTICLES    = path.join(__dirname, 'Articles');
const __ARTICLES_HU = path.join(__dirname, 'ArticlesHU');
const __MUSIC       = path.resolve(__dirname, '..', 'Music');
const __CACHE       = path.join(__dirname, '.pdf-cache');
const __CHANGELOG   = path.join(__dirname, 'changelog.json');
const __ADMINS      = path.join(__dirname, 'admins.json');
const __USERS       = path.join(__dirname, 'users.json');
const __SETTINGS    = path.join(__dirname, 'settings.json');
const __GRANTS      = path.join(__dirname, 'grants.json');
const __CHATS       = path.join(__dirname, 'chats.json');
const __NOTE_DISCUSS = path.join(__dirname, 'note-discussions.json');
const __BLOCKED     = path.join(__dirname, 'blocked.json');
const __DONATIONS   = path.join(__dirname, 'donations.json');

fs.mkdirSync(__CACHE, { recursive: true });

// Last-resort guards: a single bad request must never take the whole server down.
process.on('uncaughtException', err => { console.error('uncaughtException:', (err && err.stack) || err); });
process.on('unhandledRejection', err => { console.error('unhandledRejection:', (err && err.stack) || err); });

// Whether both language data dirs exist — determines if bilingual features activate
const HAS_DUAL_LANG = fs.existsSync(__DATA) && fs.existsSync(__DATA_HU);

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript',     '.json':'application/json',
  '.png':'image/png',   '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif',   '.webp':'image/webp', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.pdf':'application/pdf',
  '.tex':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.bib':'text/plain; charset=utf-8',
  '.sty':'text/plain; charset=utf-8', '.cls':'text/plain; charset=utf-8',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
  '.zip':'application/zip',
  '.mp3':'audio/mpeg',  '.ogg':'audio/ogg',  '.wav':'audio/wav',
  '.flac':'audio/flac', '.m4a':'audio/mp4',  '.aac':'audio/aac',
  '.mp4':'video/mp4',   '.webm':'video/webm', '.mkv':'video/x-matroska',
  '.mov':'video/quicktime', '.avi':'video/x-msvideo',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
// Percent-decode a URL *path* fragment. Query values arrive already decoded from
// url.parse(..., true), so only pathname-derived strings go through this.
function decPath(p) { try { return decodeURIComponent(String(p)); } catch { return String(p); } }
// `relPath` must already be decoded. safePath used to decode internally, which
// double-decoded query values — so a real filename containing '%' (e.g. "100%.tex")
// either resolved to the wrong file or threw URIError and 403'd.
function safePath(base, relPath) {
  const norm = path.normalize(String(relPath)).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(base, norm);
  if (!full.startsWith(path.normalize(base) + path.sep) && full !== path.normalize(base))
    throw new Error('Path traversal blocked');
  return full;
}

// Never expose server source, credential files, dotfiles (.git, .pdf-cache), or tests
// over HTTP — important once the repo is public on GitHub.
const PROTECTED_FILES = new Set(['admins.json', 'users.json', 'settings.json', 'grants.json', 'chats.json', 'blocked.json',
  'timetable.json', 'days.json', 'note-discussions.json', 'changelog.json', 'donations.json', 'server.js',
  'make-admin.js', 'make-user.js', 'package.json', 'package-lock.json']);
// Compared case-insensitively: Windows/macOS filesystems are case-insensitive, so a
// request for /ADMINS.JSON would otherwise walk straight past this guard and serve
// the credential store. Uploads/ is likewise never static — day attachments are
// access-checked by the /uploads/days/ route, which a cased URL could sidestep.
function isProtectedStatic(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.some(p => p.startsWith('.'))) return true;        // .git, .pdf-cache, dotfiles
  const first = (parts[0] || '').toLowerCase();
  if (first === 'tests' || first === 'node_modules' || first === 'uploads') return true;
  return PROTECTED_FILES.has((parts[parts.length - 1] || '').toLowerCase());
}

// Optional CORS. Set CORS_ORIGIN to a specific origin to expose the API cross-site.
// Default ('') sends no Access-Control-Allow-Origin — the app is same-origin, so
// nothing breaks, and we never echo a wildcard (which would be unsafe with cookies).
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
// Strict-Transport-Security lifetime in seconds, sent only on HTTPS requests.
// Default 180 days; set HSTS_MAX_AGE=0 to disable.
const HSTS_MAX_AGE = (() => { const v = process.env.HSTS_MAX_AGE; return v === undefined ? 15552000 : Math.max(0, Number(v) || 0); })();
function cors(headers = {}) {
  if (CORS_ORIGIN) { headers['Access-Control-Allow-Origin'] = CORS_ORIGIN; headers['Vary'] = headers['Vary'] ? headers['Vary'] + ', Origin' : 'Origin'; }
  return headers;
}
function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, cors({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }));
  res.end(body);
}

// A missing page should look like part of the site, not like a crashed process.
// Falls back to plain text if 404.html is absent, and never wastes a rendered page
// on an API path (those callers want JSON) or a HEAD request.
function notFoundPage(res, req, pathname) {
  if (String(pathname || '').startsWith('/api/')) {
    return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
  }
  let html = null;
  try { html = fs.readFileSync(path.join(__WEBSITE, '404.html'), 'utf8'); } catch {}
  if (!html) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
  html = html.split('__CSP_NONCE__').join(res._cspNonce || '');
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(404, cors({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) }));
  return res.end(req && req.method === 'HEAD' ? undefined : buf);
}

// Serve an app-shell HTML page with a per-request CSP nonce substituted in.
function serveHtmlShell(res, req, fullPath) {
  let html;
  try { html = fs.readFileSync(fullPath, 'utf8'); }
  catch { res.writeHead(404); return res.end('Not Found'); }
  const nonce = res._cspNonce || '';
  html = html.split('__CSP_NONCE__').join(nonce);
  const buf = Buffer.from(html, 'utf8');
  const headers = cors({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) });
  if (req && req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(buf);
}

function serveFile(res, req, fullPath, forceDownload = false) {
  const ext  = path.extname(fullPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let stat;
  try { stat = fs.statSync(fullPath); }
  catch { res.writeHead(404); res.end('Not Found'); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }

  const headers = cors({
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  });
  // forceDownload may be `true` (use the on-disk name) or a string (use that name —
  // day attachments are stored under a random id but should download as "scan.jpg").
  if (forceDownload) {
    const dlName = (typeof forceDownload === 'string' && forceDownload) ? forceDownload : path.basename(fullPath);
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(dlName)}"`;
  }

  // Stream a byte range with an error handler so a read failure can never throw
  // out of the request handler and crash the process.
  function pipeRange(statusCode, start, end) {
    let stream;
    try { stream = fs.createReadStream(fullPath, { start, end }); }
    catch { try { if (!res.headersSent) res.writeHead(500); } catch {} try { res.end(); } catch {} return; }
    stream.on('error', () => { try { if (!res.headersSent) res.writeHead(500); } catch {} try { res.end(); } catch {} });
    res.on('close', () => stream.destroy());
    res.writeHead(statusCode, headers);
    stream.pipe(res);
  }

  const size = stat.size;
  if (size === 0) { headers['Content-Length'] = '0'; res.writeHead(200, headers); return res.end(); }
  if (req && req.method === 'HEAD') { headers['Content-Length'] = String(size); res.writeHead(200, headers); return res.end(); }

  const rangeHeader = req && req.headers && req.headers.range;
  if (rangeHeader && !forceDownload && /^bytes=/.test(rangeHeader)) {
    const spec = rangeHeader.replace(/^bytes=/, '').trim();
    const bad  = () => { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); };
    if (spec.indexOf(',') !== -1) return bad();          // multi-range unsupported
    const m = /^(\d*)-(\d*)$/.exec(spec);
    if (!m || (m[1] === '' && m[2] === '')) return bad();
    let start, end;
    if (m[1] === '') {                                   // suffix: last N bytes
      const n = parseInt(m[2], 10);
      if (!Number.isFinite(n) || n <= 0) return bad();
      start = Math.max(0, size - n); end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end   = m[2] === '' ? size - 1 : parseInt(m[2], 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return bad();
    if (end >= size) end = size - 1;
    headers['Content-Range']  = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return pipeRange(206, start, end);
  }
  headers['Content-Length'] = String(size);
  pipeRange(200, 0, size - 1);
}

// ── Minimal ZIP writer (no dependencies) ──────────────────────────────────────
// Enough of the format to produce a normal .zip: one local header + deflated data
// per entry, then a central directory, then the end-of-central-directory record.
// Entries are streamed to the response one file at a time, so a large Uploads/
// tree never sits in memory whole — only the file currently being deflated does.
const _CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
// DOS date/time, as the format wants them.
function _dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
           time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}
function createZipWriter(out) {
  const entries = [];
  let offset = 0;
  const push = buf => { out.write(buf); offset += buf.length; };
  return {
    // `name` uses forward slashes; `data` is a Buffer.
    add(name, data, mtime) {
      const nameBuf = Buffer.from(String(name).replace(/\\/g, '/'), 'utf8');
      const crc = crc32(data);
      let method = 8, body;
      try { body = zlib.deflateRawSync(data, { level: 6 }); } catch { method = 0; body = data; }
      if (body.length >= data.length) { method = 0; body = data; }   // storing is smaller for already-compressed files
      const { date, time } = _dosTime(mtime instanceof Date && !isNaN(mtime) ? mtime : new Date());
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);            // version needed
      local.writeUInt16LE(0x0800, 6);        // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      entries.push({ nameBuf, crc, csize: body.length, size: data.length, method, time, date, offset });
      push(local); push(nameBuf); push(body);
    },
    finish() {
      const start = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameBuf.length, 28);
        // 30..41 (extra len, comment len, disk, attrs) stay zero — Buffer.alloc did that.
        c.writeUInt32LE(e.offset, 42);          // relative offset of the local header
        push(c); push(e.nameBuf);
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(offset - start, 12);
      eocd.writeUInt32LE(start, 16);
      push(eocd);
      return entries.length;
    },
  };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDirSync(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── data.txt parser ───────────────────────────────────────────────────────────
// Parsed data.txt files are memoised on (path, mtime, size). /api/tree walks every
// note and each note's access check re-reads its folder's data.txt (plus its
// counterpart's), so an archive of N notes used to cost O(N) synchronous file reads
// on every single tree request. The cache is invalidated automatically whenever the
// file's mtime or size changes, so DevTools edits are still picked up immediately.
const _dtCache = new Map();       // absolute data.txt path -> { key, sections }
const _DT_CACHE_MAX = 4000;
function parseDataTxt(dir) {
  const filePath = path.join(dir, 'data.txt');
  let key = '';
  try { const st = fs.statSync(filePath); key = st.mtimeMs + ':' + st.size; } catch { key = 'none'; }
  const hit = _dtCache.get(filePath);
  if (hit && hit.key === key) return hit.sections;
  const sections = _parseDataTxtUncached(filePath);
  if (_dtCache.size > _DT_CACHE_MAX) _dtCache.clear();
  _dtCache.set(filePath, { key, sections });
  return sections;
}
// Drop a folder's memoised data.txt right after we rewrite it, so a save is visible
// even if the filesystem reports the same mtime (coarse timers on some platforms).
function invalidateDataTxt(dir) { _dtCache.delete(path.join(dir, 'data.txt')); }
// Read-modify-write paths need their own copy — the cached object is shared with
// every reader, so mutating it in place would corrupt the cache for everyone else.
function parseDataTxtMutable(dir) {
  const src = parseDataTxt(dir), out = {};
  for (const [k, v] of Object.entries(src)) out[k] = { ...v };
  return out;
}
// Write data.txt atomically and refresh the memo in one place.
function writeDataTxt(dir, sections) {
  writeFileAtomic(path.join(dir, 'data.txt'), serializeDataTxt(sections));
  invalidateDataTxt(dir);
}
function _parseDataTxtUncached(filePath) {
  const sections = {};
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const sm = t.match(/^\[(.+)\]$/);
      if (sm) { current = sm[1].trim(); sections[current] = {}; continue; }
      if (current) {
        const ci = t.indexOf(':');
        if (ci > 0) {
          const k = t.slice(0, ci).trim().toLowerCase().replace(/-/g, '_');
          sections[current][k] = t.slice(ci + 1).trim();
        }
      }
    }
  } catch {}
  return sections;
}

function stripDisplayName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/\s*\{[^}]*\}/g, '').trim();
}

// Normalised comparison key for matching names across the two language dirs.
// NFC-folds first so accented names compare equal whether stored decomposed
// (NFD, common on macOS) or precomposed (NFC, common on Windows) -- a mismatch
// otherwise silently breaks folder links, so a linked EN/HU subject pair would
// wrongly render as two sections instead of one.
function nkey(s) { return String(s == null ? '' : s).normalize('NFC').toLowerCase(); }

function findMeta(fileName, sections) {
  const dl = stripDisplayName(fileName).toLowerCase();
  for (const [key, val] of Object.entries(sections)) {
    if (stripDisplayName(key + '.x').replace(/\.x$/, '').toLowerCase() === dl) return val;
  }
  return null;
}

// ── Access model: visibility + readability gates, owners, request flow ──────
function _csvLc(v) { return v ? String(v).split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : []; }
function deriveAccess(meta) {
  meta = meta || {};
  const norm = v => (v === 'members' || v === 'whitelist') ? v : 'all';
  const hasNew = ['can_see', 'can_read', 'read_requests', 'see_allow', 'read_allow', 'owners'].some(k => k in meta);
  if (hasNew) {
    return {
      canSee: norm(meta.can_see), canRead: norm(meta.can_read),
      readRequests: meta.read_requests === 'true',
      seeWhitelist: _csvLc(meta.see_allow), readWhitelist: _csvLc(meta.read_allow),
      owners: _csvLc(meta.owners),
    };
  }
  const vis = (meta.visibility === 'members' || meta.visibility === 'request') ? meta.visibility : 'public';
  const allow = _csvLc(meta.allow);
  if (vis === 'public') return { canSee: 'all', canRead: 'all', readRequests: false, seeWhitelist: [], readWhitelist: [], owners: [] };
  if (vis === 'members') return allow.length
    ? { canSee: 'whitelist', canRead: 'whitelist', readRequests: false, seeWhitelist: allow, readWhitelist: allow, owners: [] }
    : { canSee: 'members', canRead: 'members', readRequests: false, seeWhitelist: [], readWhitelist: [], owners: [] };
  return { canSee: 'all', canRead: 'whitelist', readRequests: true, seeWhitelist: [], readWhitelist: [], owners: allow };
}
function mergeAccess(a, b) {
  const rank = { all: 0, members: 1, whitelist: 2 };
  const pick = (x, y) => (rank[x] >= rank[y] ? x : y);
  const uniq = (...ls) => [...new Set([].concat(...ls))];
  return {
    canSee: pick(a.canSee, b.canSee), canRead: pick(a.canRead, b.canRead),
    readRequests: !!(a.readRequests || b.readRequests),
    seeWhitelist: uniq(a.seeWhitelist, b.seeWhitelist),
    readWhitelist: uniq(a.readWhitelist, b.readWhitelist),
    owners: uniq(a.owners, b.owners),
  };
}
function fileMeta(dir, name, sections) {
  const ext  = path.extname(name).toLowerCase();
  const meta = findMeta(name, sections) || {};
  let size = 0, mtime = null;
  try { const st = fs.statSync(path.join(dir, name)); size = st.size; mtime = st.mtime.toISOString(); } catch {}
  return {
    type: 'file', ext, size, mtime,
    tags:        meta.tags    ? meta.tags.split(',').map(s => s.trim()).filter(Boolean)    : [],
    authors:     meta.authors ? meta.authors.split(',').map(s => s.trim()).filter(Boolean) : [],
    date:        meta.date        || null,
    materialStart: meta.material_start || null,
    materialEnd:   meta.material_end   || null,
    updated:       meta.updated        || null,
    important:   meta.important  === 'true',
    description: meta.description || null,
    altHu:       meta.alt_hu      || null,
    altEn:       meta.alt_en      || null,
    ...deriveAccess(meta),
  };
}

// ── Note text, memoised for full-text search ──────────────────────────────────
// /api/search reads every note body, so without a cache a search costs one full
// read of the archive. Keyed on (mtime, size) like data.txt, and capped by total
// bytes rather than entry count so one enormous note cannot own the whole cache.
const SEARCHABLE_EXTS = new Set(['.tex', '.md', '.txt', '.bib']);
const SEARCH_MAX_FILES = Number(process.env.SEARCH_MAX_FILES) || 4000;
const SEARCH_MAX_HITS  = Number(process.env.SEARCH_MAX_HITS) || 200;
const NOTE_TEXT_MAX    = 512 * 1024;                 // don't search or cache a huge file
const _noteTextCache = new Map();                    // abs path -> { key, text }
let _noteTextBytes = 0;
function readNoteText(abs) {
  let st; try { st = fs.statSync(abs); } catch { return ''; }
  if (!st.isFile() || st.size > NOTE_TEXT_MAX) return '';
  const key = st.mtimeMs + ':' + st.size;
  const hit = _noteTextCache.get(abs);
  if (hit && hit.key === key) return hit.text;
  let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  if (_noteTextBytes > 48 * 1024 * 1024) { _noteTextCache.clear(); _noteTextBytes = 0; }
  if (hit) _noteTextBytes -= hit.text.length;
  _noteTextCache.set(abs, { key, text }); _noteTextBytes += text.length;
  return text;
}

// ── Single-dir tree ────────────────────────────────────────────────────────────
// A folder's own counterpart link lives in its data.txt under a [__folder__] section.
function folderMeta(dir) { return parseDataTxt(dir)['__folder__'] || {}; }

function buildTree(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const secs = parseDataTxt(dir);
  return entries
    .filter(e => e.name !== 'data.txt')
    .map(e => {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const children = buildTree(path.join(dir, e.name), childRel);
        let mtime = null;
        try { mtime = fs.statSync(path.join(dir, e.name)).mtime.toISOString(); } catch {}
        return { name: e.name, type: 'folder', path: childRel, children, count: children.length, mtime };
      }
      const m = fileMeta(dir, e.name, secs);
      return { ...m, name: e.name, path: childRel,
        enAvailable: true, huAvailable: false, enPath: childRel, huPath: null, enName: e.name, huName: null };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

// ── Dual-language merged tree ─────────────────────────────────────────────────
// enDir = primary dir, huDir = secondary dir.
function buildMergedTree(enDir, huDir, relEn = '', relHu = relEn) {
  let enEntries, huEntries;
  try { enEntries = fs.readdirSync(enDir, { withFileTypes: true }); } catch { enEntries = []; }
  try { huEntries = fs.readdirSync(huDir, { withFileTypes: true }); } catch { huEntries = []; }

  const enSecs = parseDataTxt(enDir);
  const huSecs = parseDataTxt(huDir);
  const result = [];
  const huMatched = new Set();
  const huFolderMatched = new Set();
  const enFolderNames = new Set(enEntries.filter(e => e.isDirectory()).map(e => e.name));

  function findByDisplay(entries, displayName) {
    const dl = nkey(stripDisplayName(displayName));
    return entries.find(e => e.isFile && e.isFile() && nkey(stripDisplayName(e.name)) === dl);
  }
  const joinRel = (base, name) => base ? `${base}/${name}` : name;

  // EN (primary) entries
  for (const e of enEntries) {
    if (e.name === 'data.txt') continue;
    const childRelEn = joinRel(relEn, e.name);
    if (e.isDirectory()) {
      const fm = folderMeta(path.join(enDir, e.name));
      let huName = e.name;
      if (fm.alt_hu) { const _want = nkey(stripDisplayName(fm.alt_hu)); const mm = huEntries.find(h => h.isDirectory() && nkey(stripDisplayName(h.name)) === _want); if (mm) huName = mm.name; }
      else if (!huEntries.some(h => h.isDirectory() && nkey(h.name) === nkey(e.name))) { const _en = nkey(e.name); const rev = huEntries.find(h => h.isDirectory() && nkey((folderMeta(path.join(huDir, h.name)).alt_en || '').trim()) === _en); if (rev) huName = rev.name; }
      huFolderMatched.add(huName);
      const huExists = huEntries.some(h => h.isDirectory() && h.name === huName); // a real HU counterpart folder
      const children = buildMergedTree(path.join(enDir, e.name), path.join(huDir, huName), childRelEn, joinRel(relHu, huName));
      let mtime = null;
      try { mtime = fs.statSync(path.join(enDir, e.name)).mtime.toISOString(); } catch {}
      result.push({ name: e.name, type: 'folder', path: childRelEn, children, count: children.length, mtime, altHu: fm.alt_hu || null, altEn: fm.alt_en || null,
        enName: e.name, huName: huExists ? huName : null, enPath: childRelEn, huPath: huExists ? joinRel(relHu, huName) : null });
      continue;
    }
    const meta = findMeta(e.name, enSecs) || {};
    const huM  = meta.alt_hu ? findByDisplay(huEntries, meta.alt_hu) : null
              || findByDisplay(huEntries, stripDisplayName(e.name));
    if (huM) huMatched.add(huM.name);
    const huRelPath = huM ? joinRel(relHu, huM.name) : null;
    const m = fileMeta(enDir, e.name, enSecs);
    if (huM) Object.assign(m, mergeAccess(m, deriveAccess(findMeta(huM.name, huSecs) || {})));
    result.push({ ...m, name: e.name, path: childRelEn,
      enAvailable: true, huAvailable: !!huM,
      enPath: childRelEn, huPath: huRelPath,
      enName: e.name, huName: huM ? huM.name : null });
  }

  // HU-only entries (not in primary dir)
  for (const e of huEntries) {
    if (e.name === 'data.txt') continue;
    if (e.isDirectory()) {
      if (enFolderNames.has(e.name) || huFolderMatched.has(e.name)) continue;
      const childRelHu = joinRel(relHu, e.name);
      const fm = folderMeta(path.join(huDir, e.name));
      const children = buildMergedTree(path.join(enDir, e.name), path.join(huDir, e.name), joinRel(relEn, e.name), childRelHu);
      let mtime = null;
      try { mtime = fs.statSync(path.join(huDir, e.name)).mtime.toISOString(); } catch {}
      result.push({ name: e.name, type: 'folder', path: childRelHu, children, count: children.length, mtime, altHu: fm.alt_hu || null, altEn: fm.alt_en || null,
        enName: null, huName: e.name, enPath: null, huPath: childRelHu });
      continue;
    }
    if (!e.isFile || !e.isFile()) continue;
    if (huMatched.has(e.name)) continue;
    const childRelHu = joinRel(relHu, e.name);
    const m = fileMeta(huDir, e.name, huSecs);
    result.push({ ...m, name: e.name, path: childRelHu,
      enAvailable: false, huAvailable: true,
      enPath: null, huPath: childRelHu,
      enName: null, huName: e.name });
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
  });
}

// Recursively swap EN↔HU for HU-primary display
function deepRemapHu(items) {
  return items.map(item => {
    if (item.type === 'folder') return { ...item, children: deepRemapHu(item.children || []) };
    return {
      ...item,
      enAvailable: item.huAvailable,  huAvailable: item.enAvailable,
      enPath:      item.huPath,        huPath:      item.enPath,
      enName:      item.huName,        huName:      item.enName,
      path:        item.huPath  || item.enPath  || item.path,
      name:        item.huName  || item.enName  || item.name,
    };
  });
}

// ── Member-only visibility ─────────────────────────────────────────────────────
// Drop member-only notes for anonymous visitors; prune folders left empty.
// Whether a viewer ({username, role} or null) may see a note node.
// public → everyone; members → signed-in; members + whitelist → only listed users (admins always).
function canSeeNode(node, viewer) {
  const cs = (node && node.canSee) || 'all';
  if (cs === 'all') return true;
  if (!viewer || !viewer.username) return false;
  if (viewer.role === 'admin') return true;
  if (cs === 'members') return true;
  const u = String(viewer.username).toLowerCase();
  return (node.seeWhitelist || []).includes(u) || (node.owners || []).includes(u);
}
// Mark request-to-read notes the viewer cannot currently open (for the locked card UI).
function annotateLocks(items, req, matLang) {
  for (const it of items || []) {
    if (it.type === 'folder') { annotateLocks(it.children || [], req, matLang); continue; }
    it.locked = !canViewNote(req, it.path, it.lang || matLang);
    it.canRequest = !!(it.locked && it.canRead === 'whitelist' && it.readRequests);
  }
}
// Drop notes the viewer may not see; prune folders left empty.
function filterTreeForVisibility(items, viewer) {
  const out = [];
  for (const it of items) {
    if (it.type === 'folder') {
      const kids = filterTreeForVisibility(it.children || [], viewer);
      if (kids.length) out.push({ ...it, children: kids, count: kids.length });
    } else if (canSeeNode(it, viewer)) {
      out.push(it);
    }
  }
  return out;
}
// Effective visibility of one note from disk (its own data.txt, plus its
// same-folder counterpart in dual-language mode — either being members wins).
// Effective access for a note, merged across its own data.txt + counterpart.
function noteAccess(relPath, lang) {
  const accOf = (base, rel) => {
    try { const full = safePath(base, rel); return deriveAccess(findMeta(path.basename(full), parseDataTxt(path.dirname(full))) || {}); }
    catch { return deriveAccess({}); }
  };
  const huPrimary = (lang === 'hu' && HAS_DUAL_LANG);
  const base = huPrimary ? __DATA_HU : __DATA;
  let acc = accOf(base, relPath);
  if (HAS_DUAL_LANG) {
    const other = huPrimary ? __DATA : __DATA_HU;
    try {
      const baseFull = safePath(base, relPath);
      const relDir   = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      const otherDir = safePath(other, relDir);
      const display  = stripDisplayName(path.basename(baseFull)).toLowerCase();
      let ents = []; try { ents = fs.readdirSync(otherDir); } catch {}
      const match = ents.find(n => stripDisplayName(n).toLowerCase() === display);
      if (match) acc = mergeAccess(acc, accOf(otherDir, match));
    } catch {}
  }
  return acc;
}
function noteOwners(relPath, lang) { return noteAccess(relPath, lang).owners; }
// Notes a member owns/collaborates on (their username appears in a note's own `owners`).
function walkOwnedNotes(member) {
  const meLc = String(member).toLowerCase();
  const out = [];
  const langs = [['en', __DATA]];
  if (HAS_DUAL_LANG) langs.push(['hu', __DATA_HU]);
  for (const [lang, baseDir] of langs) {
    (function walk(dir, rel) {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const secs = parseDataTxt(dir);
      for (const f of ents) {
        if (!f.isFile() || f.name === 'data.txt') continue;
        const own = deriveAccess(findMeta(f.name, secs) || {}).owners;
        if (!own.includes(meLc)) continue;
        const relPath = rel ? `${rel}/${f.name}` : f.name;
        const acc = noteAccess(relPath, lang);
        const meta = findMeta(f.name, secs) || {};
        out.push({
          lang, path: relPath, name: f.name, display: stripDisplayName(f.name),
          folder: rel || '',
          tags: meta.tags ? meta.tags.split(',').map(x => x.trim()).filter(Boolean) : [],
          authors: meta.authors ? meta.authors.split(',').map(x => x.trim()).filter(Boolean) : [],
          date: meta.date || null, description: meta.description || null, important: meta.important === 'true',
          materialStart: meta.material_start || null, materialEnd: meta.material_end || null, updated: meta.updated || null,
          mtime: (function(){ try { return fs.statSync(path.join(dir, f.name)).mtime.toISOString(); } catch { return null; } })(),
          canSee: acc.canSee, canRead: acc.canRead, readRequests: acc.readRequests,
          seeWhitelist: acc.seeWhitelist, readWhitelist: acc.readWhitelist, owners: acc.owners,
          primary: acc.owners[0] === meLc,
        });
      }
      for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    })(baseDir, '');
  }
  return out;
}
// Authoritative content-access check used by /api/file, /data and /api/compile.
function passSeeGate(acc, s) {
  if (acc.canSee === 'all') return true;
  if (!s) return false;
  if (s.role === 'admin') return true;
  if (acc.canSee === 'members') return true;
  const u = String(s.username).toLowerCase();
  return acc.seeWhitelist.includes(u) || acc.owners.includes(u);
}
function canViewNote(req, relPath, lang) {
  const acc = noteAccess(relPath, lang);
  const s = siteSession(req);
  if (!passSeeGate(acc, s)) return false;
  if (acc.canRead === 'all') return true;
  if (!s) return false;
  if (s.role === 'admin') return true;
  if (acc.canRead === 'members') return true;
  const u = String(s.username).toLowerCase();
  if (acc.readWhitelist.includes(u) || acc.owners.includes(u)) return true;
  return hasGrant(s.username, lang, relPath);
}

// ── Single-language ("solo") tree ─────────────────────────────────────────────
// Walks ONE directory as a self-contained tree so EN and HU are independent and
// equal — pure EN shows only Data, pure HU shows only DataHU. Each note is still
// linked to its counterpart (when one exists) so the viewer can offer a switch.
function buildSoloTree(primaryDir, otherDir, primaryLang, rel = '') {
  let entries;
  try { entries = fs.readdirSync(primaryDir, { withFileTypes: true }); } catch { return []; }
  const secs = parseDataTxt(primaryDir);
  const otherExists = otherDir && fs.existsSync(otherDir);
  let otherEntries = [];
  if (otherExists) { try { otherEntries = fs.readdirSync(otherDir, { withFileTypes: true }); } catch {} }
  const otherSecs = otherExists ? parseDataTxt(otherDir) : {};
  const out = [];
  for (const e of entries) {
    if (e.name === 'data.txt') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = buildSoloTree(path.join(primaryDir, e.name),
                                     otherExists ? path.join(otherDir, e.name) : null,
                                     primaryLang, childRel);
      let mtime = null; try { mtime = fs.statSync(path.join(primaryDir, e.name)).mtime.toISOString(); } catch {}
      const _fm = folderMeta(path.join(primaryDir, e.name));
      out.push({ name: e.name, type: 'folder', path: childRel, children, count: children.length, mtime, altHu: _fm.alt_hu || null, altEn: _fm.alt_en || null });
      continue;
    }
    const m    = fileMeta(primaryDir, e.name, secs);
    const meta = findMeta(e.name, secs) || {};
    let counter = null;
    if (otherExists) {
      const altKey    = (primaryLang === 'en' ? meta.alt_hu : meta.alt_en);
      const myDisplay = nkey(stripDisplayName(e.name));
      const want      = nkey(stripDisplayName(altKey || e.name));
      // forward: this note names its counterpart, or an identical display name exists
      counter = otherEntries.find(o => o.isFile && o.isFile() && nkey(stripDisplayName(o.name)) === want)
             || otherEntries.find(o => o.isFile && o.isFile() && nkey(stripDisplayName(o.name)) === myDisplay);
      // reverse: a note in the other dir names THIS note via its alt key
      if (!counter) {
        for (const o of otherEntries) {
          if (!(o.isFile && o.isFile())) continue;
          const om = findMeta(o.name, otherSecs) || {};
          const back = (primaryLang === 'hu') ? om.alt_hu : om.alt_en;
          if (back && nkey(stripDisplayName(back)) === myDisplay) { counter = o; break; }
        }
      }
    }
    const counterRel = counter ? (rel ? `${rel}/${counter.name}` : counter.name) : null;
    if (counter) Object.assign(m, mergeAccess(m, deriveAccess(findMeta(counter.name, otherSecs) || {})));
    const node = { ...m, name: e.name, path: childRel, lang: primaryLang };
    if (primaryLang === 'en') {
      node.enAvailable = true;       node.enPath = childRel;   node.enName = e.name;
      node.huAvailable = !!counter;  node.huPath = counterRel; node.huName = counter ? counter.name : null;
    } else {
      node.huAvailable = true;       node.huPath = childRel;   node.huName = e.name;
      node.enAvailable = !!counter;  node.enPath = counterRel; node.enName = counter ? counter.name : null;
    }
    out.push(node);
  }
  out.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1)
    : (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })));
  return out;
}
// Recursively find a note file in `dir` whose stripped display name matches `displayLc`
// (NFC-folded, lowercased). Used as a permissive counterpart resolver for the viewer's
// EN/HU switch, so a linked note opens its other-language file even when the folder
// chain isn't fully paired in the merged tree.
function findFileByDisplay(dir, displayLc, relBase = '') {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name === 'data.txt') continue;
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) { const f = findFileByDisplay(path.join(dir, e.name), displayLc, rel); if (f) return f; }
    else if (e.isFile() && nkey(stripDisplayName(e.name)) === displayLc) return { path: rel, name: e.name };
  }
  return null;
}
// ── PDF cache ─────────────────────────────────────────────────────────────────
function cacheKey(texPath, lang) {
  return crypto.createHash('md5').update(`${lang}:${texPath}`).digest('hex');
}
function cachedPdfPath(texPath, lang) { return path.join(__CACHE, cacheKey(texPath, lang) + '.pdf'); }
function isCacheValid(texPath, lang, fullTexPath) {
  const cp = cachedPdfPath(texPath, lang);
  if (!fs.existsSync(cp)) return false;
  try { return fs.statSync(cp).mtimeMs > fs.statSync(fullTexPath).mtimeMs; } catch { return false; }
}
function savePdfCache(texPath, lang, data) {
  try { fs.writeFileSync(cachedPdfPath(texPath, lang), data); } catch {}
}
function loadPdfCache(texPath, lang) {
  try { return fs.readFileSync(cachedPdfPath(texPath, lang)); } catch { return null; }
}

// ── pdflatex ──────────────────────────────────────────────────────────────────
function findPdflatex() {
  const candidates = [
    '/usr/bin/pdflatex', '/usr/local/bin/pdflatex', '/usr/texbin/pdflatex',
    '/Library/TeX/texbin/pdflatex',
    '/usr/local/texlive/2023/bin/x86_64-linux/pdflatex',
    '/usr/local/texlive/2024/bin/x86_64-linux/pdflatex',
    'C:\\texlive\\2023\\bin\\win32\\pdflatex.exe',
    'C:\\texlive\\2024\\bin\\win32\\pdflatex.exe',
    'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
    'C:\\Users\\Robin\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  try {
    const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pdflatex'], { timeout: 5000 });
    if (w.status === 0 && w.stdout) {
      const f = w.stdout.toString().trim().split('\n')[0].trim();
      if (f && fs.existsSync(f)) return f;
    }
  } catch {}
  return 'pdflatex';
}
const PDFLATEX = findPdflatex();
// Probed once, at start-up. Every compile request used to re-run `pdflatex --version`
// synchronously, which stalled the event loop for no reason.
const PDFLATEX_OK = (() => { try { const r = spawnSync(PDFLATEX, ['--version'], { timeout: 8000 }); return r.status === 0 || !!r.stdout; } catch { return false; } })();

// ── On-demand compile ─────────────────────────────────────────────────────────
// Strip server-side absolute paths out of anything we return to the client.
function redactPaths(str) {
  let out = String(str == null ? '' : str);
  for (const p of [__DATA, __DATA_HU, __ARTICLES, __ARTICLES_HU, __dirname, os.tmpdir()]) {
    if (p) { try { out = out.split(p).join('\u2026'); } catch {} }
  }
  return out;
}
// Run pdflatex once, without blocking the event loop.
// This used to be spawnSync: a single on-demand compile froze the whole server for
// as long as LaTeX took (up to 2 × 120 s), so one visitor opening an uncached note
// stalled every other request — page loads, chat, everything. Now the request
// handler awaits a child process instead, and concurrent compiles are queued.
function runPdflatexOnce(args, opts) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(PDFLATEX, args, opts); }
    catch (e) { return resolve({ status: null, out: '', err: String(e && e.message || e), spawnFailed: true }); }
    let out = '', err = '', size = 0, done = false;
    const CAP = 4 * 1024 * 1024;         // don't buffer a runaway log into memory
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ status: null, out, err, timedOut: true }); },
      Math.max(5000, Number(opts.timeout) || 120000));
    child.stdout && child.stdout.on('data', d => { if (size < CAP) { out += d; size += d.length; } });
    child.stderr && child.stderr.on('data', d => { if (size < CAP) { err += d; size += d.length; } });
    child.on('error', e => finish({ status: null, out, err: String(e && e.message || e), spawnFailed: true }));
    child.on('close', code => finish({ status: code, out, err }));
  });
}
// Bound how many LaTeX runs happen at once — each is a real process with real
// memory, and the queue keeps a burst of readers from forking the machine to death.
const COMPILE_MAX = Math.max(1, Number(process.env.COMPILE_CONCURRENCY) || 2);
// The queue in front of those slots is bounded too. Without a cap a burst of
// readers parks an unbounded number of pending requests (each holding a socket and
// a promise) waiting for a slot that is minutes away; refusing fast is kinder than
// timing out slowly.
const COMPILE_QUEUE_MAX = Math.max(4, Number(process.env.COMPILE_QUEUE_MAX) || 24);
let _compileActive = 0;
const _compileWaiters = [];
function acquireCompileSlot() {
  if (_compileActive < COMPILE_MAX) { _compileActive++; return Promise.resolve(); }
  if (_compileWaiters.length >= COMPILE_QUEUE_MAX) return Promise.reject(new Error('compile queue full'));
  return new Promise(r => _compileWaiters.push(r));
}
function releaseCompileSlot() {
  const next = _compileWaiters.shift();
  if (next) next(); else _compileActive--;
}

// `cache` is off for donation previews: a submission under review is not part of
// the archive, so its render must never be written into the archive's PDF cache
// (nor evict anything from it) — and it must not survive a decline.
async function compileTex(fullTex, texPath, lang, { cache = true } = {}) {
  const texName = path.basename(fullTex);
  const texBase = texName.replace(/\.tex$/i, '');
  // Acquire before the try: a refusal here must not run the finally, which would
  // release a slot that was never taken.
  try { await acquireCompileSlot(); }
  catch { return { success: false, busy: true, log: 'The server is compiling too many notes right now. Please try again in a moment.' }; }
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki_'));
    copyDirSync(path.dirname(fullTex), tmpDir);
    const args = ['-no-shell-escape', '-interaction=nonstopmode', '-file-line-error', texName];
    const opts = {
      cwd: tmpDir,
      env: { ...process.env,
        TEXMFHOME: process.env.TEXMFHOME || '/usr/share/texmf',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        openin_any: process.env.openin_any || 'p', openout_any: process.env.openout_any || 'p',  // no reads of absolute/parent/dotfile paths
      },
      timeout: 120_000,
    };
    const r1 = await runPdflatexOnce(args, opts);
    const r2 = await runPdflatexOnce(args, opts);   // second pass resolves refs/ToC
    const pdfPath = path.join(tmpDir, texBase + '.pdf');
    if (fs.existsSync(pdfPath)) {
      const data = fs.readFileSync(pdfPath);
      if (cache) savePdfCache(texPath, lang, data);
      return { success: true, data, warnings: r2.status !== 0 };
    }
    const parts = [];
    for (const r of [r1, r2]) { if (r && r.out) parts.push(r.out); if (r && r.err) parts.push(r.err); }
    try {
      const logFile = path.join(tmpDir, texBase + '.log');
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n');
        const errLines = []; let inErr = false;
        for (const line of lines) {
          if (/^!|^l\.\d+|^Error|LaTeX Error|Emergency stop/.test(line)) inErr = true;
          if (inErr) { errLines.push(line); if (errLines.length > 80) { errLines.push('…(truncated)'); break; } }
        }
        parts.push('\n──── log ────\n' + (errLines.length ? errLines : lines.slice(-40)).join('\n'));
      }
    } catch {}
    const head = r2.timedOut ? 'pdflatex timed out\n\n'
               : r2.spawnFailed ? 'pdflatex could not be started\n\n'
               : (r2.status === null ? 'pdflatex killed\n\n' : `exit ${r2.status}\n\n`);
    return { success: false, log: head + redactPaths(parts.join('\n').trim()) };
  } catch (err) {
    return { success: false, log: redactPaths('Error: ' + err.message) };
  } finally {
    if (tmpDir) rmDirSync(tmpDir);
    releaseCompileSlot();
  }
}

// ── Background precompile queue (non-blocking via async child processes) ───────
const preQueue   = [];
const preStatus  = {};
let   preRunning = false;

const MAX_PRE_QUEUE = 500;   // bound the backlog so it can't be used for resource exhaustion
// A single background run gets this long before it is killed. Without it a wedged
// pdflatex would stop the queue permanently (see runNextPrecompile).
const PRE_TIMEOUT_MS = Math.max(10000, Number(process.env.PRECOMPILE_TIMEOUT_MS) || 180000);
function enqueuePrecompile(texPath, lang) {
  const key = `${lang}:${texPath}`;
  if (preStatus[key] && ['queued', 'compiling'].includes(preStatus[key].state)) return false;
  if (preQueue.length >= MAX_PRE_QUEUE) return false;
  preStatus[key] = { state: 'queued', ts: Date.now() };
  preQueue.push({ texPath, lang });
  schedulePreQueue();
  return true;
}

function schedulePreQueue() {
  if (!preRunning && preQueue.length > 0) setImmediate(runNextPrecompile);
}

function runNextPrecompile() {
  if (preQueue.length === 0) { preRunning = false; return; }
  preRunning = true;
  const { texPath, lang } = preQueue.shift();
  const key     = `${lang}:${texPath}`;
  const dataDir = lang === 'hu' ? __DATA_HU : __DATA;

  let fullTex;
  try { fullTex = safePath(dataDir, texPath); }
  catch { preStatus[key] = { state: 'error', msg: 'bad path', ts: Date.now() }; preRunning = false; schedulePreQueue(); return; }

  if (!fs.existsSync(fullTex)) {
    preStatus[key] = { state: 'error', msg: 'not found', ts: Date.now() };
    preRunning = false; schedulePreQueue(); return;
  }
  if (isCacheValid(texPath, lang, fullTex)) {
    preStatus[key] = { state: 'skipped', ts: Date.now() };
    preRunning = false; schedulePreQueue(); return;
  }

  preStatus[key] = { state: 'compiling', ts: Date.now() };
  const texName = path.basename(fullTex);
  const texBase = texName.replace(/\.tex$/i, '');
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ki_pre_'));
  try { copyDirSync(path.dirname(fullTex), tmpDir); } catch {}

  const env  = { ...process.env,
    TEXMFHOME: process.env.TEXMFHOME || '/usr/share/texmf',
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        openin_any: process.env.openin_any || 'p', openout_any: process.env.openout_any || 'p',  // no reads of absolute/parent/dotfile paths
  };
  const args = ['-no-shell-escape', '-interaction=nonstopmode', '-file-line-error', texName];

  let settled = false;
  function onDone(msg) {
    if (settled) return; settled = true;
    const pdfPath = path.join(tmpDir, texBase + '.pdf');
    if (!msg && fs.existsSync(pdfPath)) {
      try { savePdfCache(texPath, lang, fs.readFileSync(pdfPath)); } catch {}
      preStatus[key] = { state: 'done', ts: Date.now() };
    } else {
      preStatus[key] = { state: 'error', msg: msg || 'no pdf', ts: Date.now() };
    }
    rmDirSync(tmpDir);
    preRunning = false;
    schedulePreQueue();
  }

  // stdio:'ignore' is not a detail — it is what keeps this queue alive. With the
  // default 'pipe' Node creates pipes nobody ever reads, so as soon as pdflatex
  // writes more than the OS pipe buffer (64 KB on Linux, far less on Windows —
  // routine for a multi-page document) the child blocks on write forever, and
  // `preRunning` stays true, wedging *all* background precompilation for the
  // lifetime of the process. We only ever look at whether the .pdf appeared, so
  // there is nothing to read. The watchdog covers a genuinely stuck LaTeX run.
  let alive = null;
  const watchdog = setTimeout(() => { try { alive && alive.kill('SIGKILL'); } catch {} onDone('timed out'); }, PRE_TIMEOUT_MS);
  const finish = m => { clearTimeout(watchdog); onDone(m); };
  const c1 = alive = spawn(PDFLATEX, args, { cwd: tmpDir, env, stdio: 'ignore' });
  c1.on('error', () => finish('spawn failed'));
  c1.on('close', () => {
    if (settled) return;
    const c2 = alive = spawn(PDFLATEX, args, { cwd: tmpDir, env, stdio: 'ignore' });   // second pass resolves refs/ToC
    c2.on('error', () => finish('spawn failed'));
    c2.on('close', () => finish(null));
  });
}

function autoPrecompile(dataDir, lang) {
  if (!fs.existsSync(dataDir)) return;
  function walk(dir, rel) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
      if (path.extname(e.name).toLowerCase() === '.tex')
        enqueuePrecompile(rel ? `${rel}/${e.name}` : e.name, lang);
    }
  }
  walk(dataDir, '');
}

// ── Compile request handler ───────────────────────────────────────────────────
function handleCompile(req, res) {
  // A cache miss forks two real pdflatex processes, so an unauthenticated burst is
  // the cheapest way to load the machine. Cache hits are answered before the queue
  // is touched, so a normal reader browsing an already-compiled archive never
  // approaches this ceiling.
  if (!rateOk(req, 'compile', 90, 5 * 60 * 1000)) return sendJSON(res, { success: false, log: 'Too many compile requests — try again in a few minutes.' }, 429);
  let body = '';
  req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
  req.on('end', async () => {
    let filePath, lang;
    try { const p = JSON.parse(body); filePath = p.path; lang = p.lang; }
    catch { res.writeHead(400); return res.end('Bad JSON'); }
    if (!filePath || typeof filePath !== 'string') { res.writeHead(400); return res.end('Missing path'); }
    if (!canViewNote(req, filePath, lang))
      return sendJSON(res, { success: false, log: 'This note is available to signed-in members only.' }, 403);

    const dataDir = (lang === 'hu' && HAS_DUAL_LANG) ? __DATA_HU : __DATA;
    let fullTex;
    try { fullTex = safePath(dataDir, filePath); }
    catch { res.writeHead(403); return res.end('Forbidden'); }

    if (!fs.existsSync(fullTex))
      return sendJSON(res, { success: false, log: `File not found: ${path.basename(String(filePath))}` });

    // Cache hit
    if (isCacheValid(filePath, lang, fullTex)) {
      const cached = loadPdfCache(filePath, lang);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf', 'Content-Length': String(cached.length),
          'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(filePath, '.tex'))}.pdf"`,
          'Cache-Control': 'no-store', 'X-From-Cache': 'true',
        });
        return res.end(cached);
      }
    }

    // Availability was probed once at start-up; re-running `pdflatex --version`
    // synchronously on every single compile request was another event-loop stall.
    if (!PDFLATEX_OK)
      return sendJSON(res, { success: false, log: 'The PDF compiler is not available on the server.' });

    let result;
    try { result = await compileTex(fullTex, filePath, lang); }
    catch (e) { return sendJSON(res, { success: false, log: redactPaths('Compile failed: ' + (e && e.message || e)) }, 500); }
    if (result.busy) return sendJSON(res, { success: false, log: result.log }, 503);
    if (result.success) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': String(result.data.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(filePath, '.tex'))}.pdf"`,
        'Cache-Control': 'no-store',
        'X-Compile-Warnings': result.warnings ? 'true' : 'false',
      });
      return res.end(result.data);
    }
    return sendJSON(res, { success: false, log: result.log });
  });
}

// ── Changelog ─────────────────────────────────────────────────────────────────
function readChangelog()  { try { return JSON.parse(fs.readFileSync(__CHANGELOG, 'utf8')); } catch { return []; } }
function writeChangelog(e){ writeFileAtomic(__CHANGELOG, JSON.stringify(e, null, 2)); }

// ── Articles ─────────────────────────────────────────────────────────────────
// Files served publicly under /articles/. Authoring is admin-only and confined to
// the Articles / ArticlesHU directories with a safe extension allowlist.
const ARTICLE_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.md', '.txt', '.json', '.svg', '.csv', '.xml', '.webmanifest']);
function htmlAttr(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function htmlText(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function articlesDirFor(lang, create) {
  const dir = (lang === 'hu') ? __ARTICLES_HU : __ARTICLES;
  if (create && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
  return dir;
}
function articleMetaFromHtml(raw, fallbackTitle) {
  let title = fallbackTitle, date = null, description = '', tags = [];
  try {
    const tm = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
    const dm = raw.match(/data-date="([^"]+)"/), ds = raw.match(/data-description="([^"]+)"/), tg = raw.match(/data-tags="([^"]+)"/);
    if (tm) title = tm[1].trim(); if (dm) date = dm[1]; if (ds) description = ds[1];
    if (tg) tags = tg[1].split(',').map(x => x.trim()).filter(Boolean);
  } catch {}
  return { title, date, description, tags };
}
function walkArticleFolder(absDir, rel) {
  const out = [];
  let ents = []; try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkArticleFolder(path.join(absDir, e.name), r));
    else out.push(r);
  }
  return out;
}
// Fill template.html with article metadata + body so generated articles match it exactly.
const ARTICLE_TEMPLATE_B64 = "PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8IS0tDQogIOKVlOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVlw0KICDilZEgIEFSVElDTEUgVEVNUExBVEUgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilZENCiAg4pWRICBEdXBsaWNhdGUgdGhpcyBmaWxlIGFuZCBmaWxsIGluIHlvdXIgY29udGVudC4gICAgICAgICAgICAgICAgICAg4pWRDQogIOKVkSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIOKVkQ0KICDilZEgIFVwZGF0ZSB0aGUgbWV0YWRhdGEgZmllbGRzIGJlbG93OiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDilZENCiAg4pWRICAgIDx0aXRsZT4gICAgICAg4oCUIHNob3duIGluIHRoZSBOb3RlcyBwYWdlIGNhcmQgdGl0bGUgICAgICAgICAgICDilZENCiAg4pWRICAgIGRhdGEtZGF0ZSAgICAg4oCUIElTTyBkYXRlLCBlLmcuIDIwMjQtMTEtMDMgICAgICAgICAgICAgICAgICAgICDilZENCiAg4pWRICAgIGRhdGEtZGVzY3JpcHRpb24g4oCUIHNob3J0IGJsdXJiIHNob3duIGluIHRoZSBjYXJkICAgICAgICAgICAgICDilZENCiAg4pWRICAgIGRhdGEtdGFncyAgICAg4oCUIGNvbW1hLXNlcGFyYXRlZCB0YWdzICAgICAgICAgICAgICAgICAgICAgICAgICDilZENCiAg4pWa4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWdDQotLT4NCjxoZWFkPg0KICA8bWV0YSBjaGFyc2V0PSJVVEYtOCI+DQogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MS4wIj4NCg0KICA8IS0tIOKUgOKUgCBNZXRhZGF0YSAocmVhZCBieSB0aGUgc2VydmVyIGZvciB0aGUgTm90ZXMgcGFnZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIC0tPg0KICA8dGl0bGU+QXJ0aWNsZSBUaXRsZSBIZXJlPC90aXRsZT4NCiAgPG1ldGEgZGF0YS1kYXRlPSIyMDI0LTAxLTAxIj4NCiAgPG1ldGEgZGF0YS1kZXNjcmlwdGlvbj0iQSBzaG9ydCBkZXNjcmlwdGlvbiBvZiB3aGF0IHRoaXMgYXJ0aWNsZSBjb3ZlcnMuIj4NCiAgPG1ldGEgZGF0YS10YWdzPSJtYXRoZW1hdGljcywgYW5hbHlzaXMiPg0KDQogIDwhLS0gQXBwbHkgc3RvcmVkIHRoZW1lIGJlZm9yZSBmaXJzdCBwYWludCB0byBwcmV2ZW50IGZsYXNoIC0tPg0KICA8c2NyaXB0Pg0KICAgIChmdW5jdGlvbigpew0KICAgICAgdmFyIHQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgna2lfdGhlbWUnKTsNCiAgICAgIGlmICghdCkgdCA9IHdpbmRvdy5tYXRjaE1lZGlhICYmIHdpbmRvdy5tYXRjaE1lZGlhKCcocHJlZmVycy1jb2xvci1zY2hlbWU6IGxpZ2h0KScpLm1hdGNoZXMgPyAnbGlnaHQnIDogJ2RhcmsnOw0KICAgICAgaWYgKHQgPT09ICdsaWdodCcpIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGFzc0xpc3QuYWRkKCdsaWdodCcpOw0KICAgIH0pKCk7DQogIDwvc2NyaXB0Pg0KDQogIDxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+DQogIDxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9Q29ybW9yYW50K0dhcmFtb25kOml0YWwsd2dodEAwLDQwMDswLDUwMDswLDYwMDsxLDQwMDsxLDYwMCZmYW1pbHk9U3luZTp3Z2h0QDQwMDs1MDA7NjAwJmZhbWlseT1KZXRCcmFpbnMrTW9ubzp3Z2h0QDMwMDs0MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPg0KDQogIDwhLS0gS2FUZVggZm9yIG1hdGggcmVuZGVyaW5nIC0tPg0KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL0thVGVYLzAuMTYuOS9rYXRleC5taW4uY3NzIj4NCiAgPHNjcmlwdCBkZWZlciBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL0thVGVYLzAuMTYuOS9rYXRleC5taW4uanMiPjwvc2NyaXB0Pg0KICA8c2NyaXB0IGRlZmVyIHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvS2FUZVgvMC4xNi45L2NvbnRyaWIvYXV0by1yZW5kZXIubWluLmpzIg0KICAgIG9ubG9hZD0icmVuZGVyTWF0aEluRWxlbWVudChkb2N1bWVudC5ib2R5LCB7DQogICAgICBkZWxpbWl0ZXJzOiBbDQogICAgICAgIHtsZWZ0OiAnJCQnLCByaWdodDogJyQkJywgZGlzcGxheTogdHJ1ZX0sDQogICAgICAgIHtsZWZ0OiAnJCcsIHJpZ2h0OiAnJCcsIGRpc3BsYXk6IGZhbHNlfSwNCiAgICAgICAge2xlZnQ6ICdcXFxcKCcsIHJpZ2h0OiAnXFxcXCknLCBkaXNwbGF5OiBmYWxzZX0sDQogICAgICAgIHtsZWZ0OiAnXFxcXFsnLCByaWdodDogJ1xcXFxdJywgZGlzcGxheTogdHJ1ZX0NCiAgICAgIF0NCiAgICB9KSI+PC9zY3JpcHQ+DQoNCiAgPHN0eWxlPg0KICAgIDpyb290IHsNCiAgICAgIC0tYmc6ICAgICAgIzA3MDcwYTsNCiAgICAgIC0tYmcyOiAgICAgIzBkMGQxMTsNCiAgICAgIC0tYmczOiAgICAgIzEzMTMxYTsNCiAgICAgIC0tYm9yZGVyOiAgcmdiYSgyNTUsMjU1LDI1NSwwLjA3KTsNCiAgICAgIC0tdGV4dDogICAgI2UwZGJkMDsNCiAgICAgIC0tdGV4dDI6ICAgIzdlN2E3MjsNCiAgICAgIC0tdGV4dDM6ICAgIzNlM2MzODsNCiAgICAgIC0tYWNjZW50OiAgI2M0YTEzYzsNCiAgICAgIC0tYWNjZW50MjogI2U4Yzk2YTsNCiAgICAgIC0tZm9udC1kaXNwbGF5OiAnQ29ybW9yYW50IEdhcmFtb25kJywgR2VvcmdpYSwgc2VyaWY7DQogICAgICAtLWZvbnQtdWk6ICAgICAgJ1N5bmUnLCBzYW5zLXNlcmlmOw0KICAgICAgLS1mb250LW1vbm86ICAgICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsNCiAgICB9DQogICAgLyog4pSA4pSAIExpZ2h0IHRoZW1lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLw0KICAgIGh0bWwubGlnaHQgew0KICAgICAgLS1iZzogICAgICAjZjVmMGU4Ow0KICAgICAgLS1iZzI6ICAgICAjZWNlNmRhOw0KICAgICAgLS1iZzM6ICAgICAjZTJkYmQwOw0KICAgICAgLS1ib3JkZXI6ICByZ2JhKDgwLDYwLDIwLDAuMTMpOw0KICAgICAgLS10ZXh0OiAgICAjMWExNjBlOw0KICAgICAgLS10ZXh0MjogICAjNmI2MDU0Ow0KICAgICAgLS10ZXh0MzogICAjYTA5NTg1Ow0KICAgICAgLS1hY2NlbnQ6ICAjOGE2ODE4Ow0KICAgICAgLS1hY2NlbnQyOiAjYjg4YzJhOw0KICAgIH0NCiAgICBodG1sLmxpZ2h0IGJvZHkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7IGNvbG9yOiB2YXIoLS10ZXh0KTsgfQ0KICAgIGh0bWwubGlnaHQgLnRvcC1iYXIgew0KICAgICAgYmFja2dyb3VuZDogcmdiYSgyNDUsMjQwLDIzMiwwLjkyKTsNCiAgICAgIGJvcmRlci1ib3R0b20tY29sb3I6IHJnYmEoODAsNjAsMjAsMC4xMyk7DQogICAgfQ0KICAgIGh0bWwubGlnaHQgOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnMik7IH0NCiAgICBodG1sLmxpZ2h0IDo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1iZzMpOyB9DQogICAgaHRtbC5saWdodCBjb2RlIHsgYmFja2dyb3VuZDogdmFyKC0tYmczKTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXIpOyBjb2xvcjogIzVhN2E5YTsgfQ0KICAgIGh0bWwubGlnaHQgcHJlICB7IGJhY2tncm91bmQ6IHZhcigtLWJnMikgIWltcG9ydGFudDsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXIpOyB9DQogICAgaHRtbC5saWdodCAubWF0aC1ibG9jayB7IGJhY2tncm91bmQ6IHZhcigtLWJnMik7IGJvcmRlci1jb2xvcjogdmFyKC0tYm9yZGVyKTsgfQ0KICAgIGh0bWwubGlnaHQgLmRlZi1ib3ggICAgIHsgYmFja2dyb3VuZDogdmFyKC0tYmcyKTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXIpOyB9DQogICAgaHRtbC5saWdodCAudGhlb3JlbS1ib3ggeyBiYWNrZ3JvdW5kOiB2YXIoLS1iZzIpOyBib3JkZXItY29sb3I6IHJnYmEoMTM4LDEwNCwyNCwwLjMpOyB9DQogICAgKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQ0KICAgIDo6LXdlYmtpdC1zY3JvbGxiYXIgeyB3aWR0aDogNXB4OyB9DQogICAgOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnMik7IH0NCiAgICA6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogIzFhMWEyMzsgYm9yZGVyLXJhZGl1czogOTlweDsgfQ0KICAgIDo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyB9DQoNCiAgICBib2R5IHsNCiAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJnKTsgY29sb3I6IHZhcigtLXRleHQpOw0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtZGlzcGxheSk7IGZvbnQtc2l6ZTogMTlweDsgbGluZS1oZWlnaHQ6IDEuODU7DQogICAgICAtd2Via2l0LWZvbnQtc21vb3RoaW5nOiBhbnRpYWxpYXNlZDsNCiAgICB9DQogICAgOjpzZWxlY3Rpb24geyBiYWNrZ3JvdW5kOiByZ2JhKDE5NiwxNjEsNjAsMC4xNSk7IGNvbG9yOiB2YXIoLS1hY2NlbnQyKTsgfQ0KDQogICAgLyog4pSA4pSAIFRvcCBiYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgLnRvcC1iYXIgew0KICAgICAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOyB6LWluZGV4OiAxMDA7DQogICAgICBoZWlnaHQ6IDUycHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogICAgICBwYWRkaW5nOiAwIDQwcHg7IGdhcDogMTZweDsNCiAgICAgIGJhY2tncm91bmQ6IHJnYmEoNyw3LDEwLDAuOSk7DQogICAgICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMTZweCk7DQogICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgICB9DQogICAgLmJhY2stYnRuIHsNCiAgICAgIGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsNCiAgICAgIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250LXVpKTsgZm9udC1zaXplOiAxMnB4OyBmb250LXdlaWdodDogNTAwOw0KICAgICAgbGV0dGVyLXNwYWNpbmc6IDAuMDhlbTsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsNCiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0Mik7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsNCiAgICAgIHBhZGRpbmc6IDVweCAxMnB4OyBib3JkZXItcmFkaXVzOiA2cHg7DQogICAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOw0KICAgICAgdHJhbnNpdGlvbjogY29sb3IgMC4ycywgYm9yZGVyLWNvbG9yIDAuMnMsIGJhY2tncm91bmQgMC4yczsNCiAgICB9DQogICAgLmJhY2stYnRuOmhvdmVyIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGJvcmRlci1jb2xvcjogcmdiYSgxOTYsMTYxLDYwLDAuMyk7IGJhY2tncm91bmQ6IHJnYmEoMTk2LDE2MSw2MCwwLjA1KTsgfQ0KICAgIC5iYXItdGl0bGUgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtdWkpOyBmb250LXNpemU6IDEzcHg7IGNvbG9yOiB2YXIoLS10ZXh0Myk7DQogICAgICBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsNCiAgICB9DQoNCiAgICAvKiDilIDilIAgQXJ0aWNsZSBsYXlvdXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgYXJ0aWNsZSB7DQogICAgICBtYXgtd2lkdGg6IDY4MHB4OyBtYXJnaW46IDAgYXV0bzsNCiAgICAgIHBhZGRpbmc6IDcycHggNDBweCAxMjBweDsNCiAgICB9DQoNCiAgICAvKiDilIDilIAgSGVhZGVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLw0KICAgIC5hcnRpY2xlLW1ldGEgew0KICAgICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxMnB4Ow0KICAgICAgbWFyZ2luLWJvdHRvbTogMzJweDsNCiAgICB9DQogICAgLmFydGljbGUtZGF0ZSB7DQogICAgICBmb250LWZhbWlseTogdmFyKC0tZm9udC1tb25vKTsgZm9udC1zaXplOiAxMXB4Ow0KICAgICAgbGV0dGVyLXNwYWNpbmc6IDAuMTZlbTsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsNCiAgICAgIGNvbG9yOiB2YXIoLS1hY2NlbnQpOw0KICAgIH0NCiAgICAuYXJ0aWNsZS10YWcgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtbW9ubyk7IGZvbnQtc2l6ZTogOXB4Ow0KICAgICAgbGV0dGVyLXNwYWNpbmc6IDAuMTJlbTsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsNCiAgICAgIHBhZGRpbmc6IDJweCA4cHg7IGJvcmRlci1yYWRpdXM6IDRweDsNCiAgICAgIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7DQogICAgICBjb2xvcjogdmFyKC0tdGV4dDMpOw0KICAgIH0NCiAgICBoMS50aXRsZSB7DQogICAgICBmb250LWZhbWlseTogdmFyKC0tZm9udC1kaXNwbGF5KTsgZm9udC1zaXplOiBjbGFtcCgzNnB4LCA1dncsIDU4cHgpOw0KICAgICAgZm9udC13ZWlnaHQ6IDQwMDsgbGluZS1oZWlnaHQ6IDEuMDU7IGxldHRlci1zcGFjaW5nOiAtMC4wMWVtOw0KICAgICAgbWFyZ2luLWJvdHRvbTogMjBweDsgY29sb3I6IHZhcigtLXRleHQpOw0KICAgIH0NCiAgICBoMS50aXRsZSBlbSB7IGZvbnQtc3R5bGU6IGl0YWxpYzsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0NCiAgICAuYXJ0aWNsZS1pbnRybyB7DQogICAgICBmb250LXNpemU6IDIwcHg7IGNvbG9yOiB2YXIoLS10ZXh0Mik7IGxpbmUtaGVpZ2h0OiAxLjc7DQogICAgICBtYXJnaW4tYm90dG9tOiA1NnB4OyBwYWRkaW5nLWJvdHRvbTogNDBweDsNCiAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOw0KICAgIH0NCg0KICAgIC8qIOKUgOKUgCBUeXBvZ3JhcGh5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLw0KICAgIHAgeyBtYXJnaW4tYm90dG9tOiAxLjRlbTsgfQ0KICAgIHA6bGFzdC1jaGlsZCB7IG1hcmdpbi1ib3R0b206IDA7IH0NCg0KICAgIGgyIHsNCiAgICAgIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250LWRpc3BsYXkpOyBmb250LXNpemU6IDI4cHg7IGZvbnQtd2VpZ2h0OiA1MDA7DQogICAgICBmb250LXN0eWxlOiBpdGFsaWM7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOw0KICAgICAgbWFyZ2luOiA0OHB4IDAgMThweDsgcGFkZGluZy1ib3R0b206IDEycHg7DQogICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgICB9DQogICAgaDMgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtdWkpOyBmb250LXNpemU6IDE0cHg7IGZvbnQtd2VpZ2h0OiA2MDA7DQogICAgICBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOw0KICAgICAgY29sb3I6IHZhcigtLXRleHQyKTsgbWFyZ2luOiAzMnB4IDAgMTJweDsNCiAgICB9DQogICAgaDQgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtZGlzcGxheSk7IGZvbnQtc2l6ZTogMjBweDsgZm9udC1zdHlsZTogaXRhbGljOw0KICAgICAgY29sb3I6IHZhcigtLXRleHQpOyBtYXJnaW46IDI0cHggMCAxMHB4Ow0KICAgIH0NCg0KICAgIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgZm9udC13ZWlnaHQ6IDYwMDsgfQ0KICAgIGVtICAgICB7IGZvbnQtc3R5bGU6IGl0YWxpYzsgfQ0KICAgIGEgICAgICB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB0ZXh0LWRlY29yYXRpb246IHVuZGVybGluZTsgdGV4dC11bmRlcmxpbmUtb2Zmc2V0OiAzcHg7IHRleHQtZGVjb3JhdGlvbi1jb2xvcjogcmdiYSgxOTYsMTYxLDYwLDAuNCk7IH0NCiAgICBhOmhvdmVyIHsgdGV4dC1kZWNvcmF0aW9uLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQoNCiAgICAvKiDilIDilIAgTWF0aCBibG9ja3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgLm1hdGgtYmxvY2sgew0KICAgICAgcGFkZGluZzogMjRweCAyOHB4OyBtYXJnaW46IDMycHggMDsNCiAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJnMik7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogICAgICBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWFjY2VudCk7DQogICAgICBib3JkZXItcmFkaXVzOiAwIDhweCA4cHggMDsNCiAgICAgIG92ZXJmbG93LXg6IGF1dG87DQogICAgfQ0KICAgIC5rYXRleC1kaXNwbGF5IHsgbWFyZ2luOiAwICFpbXBvcnRhbnQ7IH0NCiAgICAua2F0ZXggeyBmb250LXNpemU6IDEuMDVlbSAhaW1wb3J0YW50OyB9DQoNCiAgICAvKiDilIDilIAgQmxvY2txdW90ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCiAgICBibG9ja3F1b3RlIHsNCiAgICAgIGJvcmRlci1sZWZ0OiAycHggc29saWQgdmFyKC0tYWNjZW50KTsNCiAgICAgIHBhZGRpbmc6IDEwcHggMCAxMHB4IDI0cHg7IG1hcmdpbjogMzJweCAwOw0KICAgICAgZm9udC1zdHlsZTogaXRhbGljOyBjb2xvcjogdmFyKC0tdGV4dDIpOyBmb250LXNpemU6IDIxcHg7DQogICAgICBsaW5lLWhlaWdodDogMS42Ow0KICAgIH0NCg0KICAgIC8qIOKUgOKUgCBDb2RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLw0KICAgIGNvZGUgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtbW9ubyk7IGZvbnQtc2l6ZTogMC43OGVtOw0KICAgICAgYmFja2dyb3VuZDogdmFyKC0tYmczKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgICAgIHBhZGRpbmc6IDJweCA3cHg7IGJvcmRlci1yYWRpdXM6IDVweDsgY29sb3I6ICM4ZGM4ZWY7DQogICAgfQ0KICAgIHByZSB7DQogICAgICBtYXJnaW46IDI4cHggMDsgYm9yZGVyLXJhZGl1czogMTBweDsNCiAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJnMikgIWltcG9ydGFudDsNCiAgICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogICAgICBvdmVyZmxvdy14OiBhdXRvOw0KICAgIH0NCiAgICBwcmUgY29kZSB7DQogICAgICBkaXNwbGF5OiBibG9jazsgcGFkZGluZzogMjBweCAyMnB4Ow0KICAgICAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQgIWltcG9ydGFudDsgYm9yZGVyOiBub25lOw0KICAgICAgZm9udC1zaXplOiAxM3B4OyBsaW5lLWhlaWdodDogMS42NTsNCiAgICB9DQoNCiAgICAvKiDilIDilIAgRGVmaW5pdGlvbiBib3gg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgLmRlZi1ib3ggew0KICAgICAgcGFkZGluZzogMjBweCAyMnB4OyBtYXJnaW46IDI4cHggMDsNCiAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJnMik7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogICAgICBib3JkZXItcmFkaXVzOiA4cHg7DQogICAgfQ0KICAgIC5kZWYtYm94IC5kZWYtbGFiZWwgew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtbW9ubyk7IGZvbnQtc2l6ZTogMTBweDsgbGV0dGVyLXNwYWNpbmc6IDAuMTZlbTsNCiAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBtYXJnaW4tYm90dG9tOiA4cHg7DQogICAgICBkaXNwbGF5OiBibG9jazsNCiAgICB9DQogICAgLmRlZi1ib3ggcCB7IG1hcmdpbi1ib3R0b206IDA7IH0NCg0KICAgIC8qIOKUgOKUgCBUaGVvcmVtL1Byb29mIGJveCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCiAgICAudGhlb3JlbS1ib3ggew0KICAgICAgcGFkZGluZzogMjBweCAyMnB4OyBtYXJnaW46IDI4cHggMDsNCiAgICAgIGJhY2tncm91bmQ6IHJnYmEoMTk2LDE2MSw2MCwwLjA0KTsNCiAgICAgIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMTk2LDE2MSw2MCwwLjIpOw0KICAgICAgYm9yZGVyLXJhZGl1czogOHB4Ow0KICAgIH0NCiAgICAudGhlb3JlbS1ib3ggLnRobS1sYWJlbCB7DQogICAgICBmb250LWZhbWlseTogdmFyKC0tZm9udC1tb25vKTsgZm9udC1zaXplOiAxMHB4OyBsZXR0ZXItc3BhY2luZzogMC4xNmVtOw0KICAgICAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgY29sb3I6IHZhcigtLWFjY2VudCk7IG1hcmdpbi1ib3R0b206IDEwcHg7DQogICAgICBkaXNwbGF5OiBibG9jazsNCiAgICB9DQogICAgLnByb29mLWJveCB7DQogICAgICBwYWRkaW5nOiAyMHB4IDIycHg7IG1hcmdpbjogMTJweCAwIDI4cHg7DQogICAgICBib3JkZXItbGVmdDogMnB4IHNvbGlkIHZhcigtLXRleHQzKTsgcGFkZGluZy1sZWZ0OiAyMHB4Ow0KICAgIH0NCiAgICAucHJvb2YtYm94IC5wcm9vZi1sYWJlbCB7DQogICAgICBmb250LWZhbWlseTogdmFyKC0tZm9udC1tb25vKTsgZm9udC1zaXplOiAxMHB4OyBsZXR0ZXItc3BhY2luZzogMC4xMmVtOw0KICAgICAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgY29sb3I6IHZhcigtLXRleHQzKTsgbWFyZ2luLWJvdHRvbTogOHB4Ow0KICAgICAgZGlzcGxheTogYmxvY2s7DQogICAgfQ0KICAgIC5xZWQgew0KICAgICAgZmxvYXQ6IHJpZ2h0OyBmb250LXNpemU6IDE0cHg7IGNvbG9yOiB2YXIoLS10ZXh0Myk7DQogICAgICBsaW5lLWhlaWdodDogMTsNCiAgICB9DQoNCiAgICAvKiDilIDilIAgRm9vdG5vdGUgc3R5bGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgLmZvb3Rub3RlcyB7DQogICAgICBtYXJnaW4tdG9wOiA3MnB4OyBwYWRkaW5nLXRvcDogMjhweDsNCiAgICAgIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOw0KICAgICAgZm9udC1zaXplOiAxNHB4OyBjb2xvcjogdmFyKC0tdGV4dDIpOw0KICAgIH0NCiAgICAuZm9vdG5vdGVzIG9sIHsgcGFkZGluZy1sZWZ0OiAyMHB4OyB9DQogICAgLmZvb3Rub3RlcyBsaSB7IG1hcmdpbi1ib3R0b206IDhweDsgfQ0KDQogICAgLyog4pSA4pSAIEZpZ3VyZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCiAgICBmaWd1cmUgew0KICAgICAgbWFyZ2luOiAzNnB4IDA7IHRleHQtYWxpZ246IGNlbnRlcjsNCiAgICB9DQogICAgZmlndXJlIGltZyB7DQogICAgICBtYXgtd2lkdGg6IDEwMCU7IGJvcmRlci1yYWRpdXM6IDhweDsNCiAgICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogICAgfQ0KICAgIGZpZ2NhcHRpb24gew0KICAgICAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtdWkpOyBmb250LXNpemU6IDEycHg7DQogICAgICBjb2xvcjogdmFyKC0tdGV4dDMpOyBtYXJnaW4tdG9wOiAxMHB4Ow0KICAgICAgbGV0dGVyLXNwYWNpbmc6IDAuMDRlbTsNCiAgICB9DQoNCiAgICAvKiDilIDilIAgVGFibGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQogICAgdGFibGUgeyB3aWR0aDogMTAwJTsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgbWFyZ2luOiAyOHB4IDA7IGZvbnQtc2l6ZTogMTVweDsgfQ0KICAgIHRoIHsgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQtdWkpOyBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA2MDA7IGxldHRlci1zcGFjaW5nOiAwLjFlbTsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgY29sb3I6IHZhcigtLXRleHQyKTsgcGFkZGluZzogMTBweCAxNHB4OyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLW1kKTsgdGV4dC1hbGlnbjogbGVmdDsgfQ0KICAgIHRkIHsgcGFkZGluZzogMTBweCAxNHB4OyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgY29sb3I6IHZhcigtLXRleHQpOyB9DQogICAgdHI6aG92ZXIgdGQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1iZzIpOyB9DQoNCiAgICAvKiDilIDilIAgQ3VzdG9tIGN1cnNvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCiAgICBodG1sIHsgY3Vyc29yOiBub25lOyB9DQogICAgYm9keSB7IGN1cnNvcjogbm9uZTsgfQ0KICAgIGEsIGJ1dHRvbiB7IGN1cnNvcjogbm9uZTsgfQ0KICAgICNjdXItZG90IHsNCiAgICAgIHBvc2l0aW9uOiBmaXhlZDsgei1pbmRleDogOTk5OTk7DQogICAgICB3aWR0aDogNnB4OyBoZWlnaHQ6IDZweDsgYm9yZGVyLXJhZGl1czogNTAlOw0KICAgICAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsNCiAgICAgIHBvaW50ZXItZXZlbnRzOiBub25lOw0KICAgICAgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwtNTAlKTsNCiAgICAgIHRyYW5zaXRpb246IHdpZHRoIC4ycywgaGVpZ2h0IC4ycywgYmFja2dyb3VuZCAuMnMsIG9wYWNpdHkgLjJzOw0KICAgIH0NCiAgICAjY3VyLXJpbmcgew0KICAgICAgcG9zaXRpb246IGZpeGVkOyB6LWluZGV4OiA5OTk5ODsNCiAgICAgIHdpZHRoOiAzMHB4OyBoZWlnaHQ6IDMwcHg7IGJvcmRlci1yYWRpdXM6IDUwJTsNCiAgICAgIGJvcmRlcjogMS41cHggc29saWQgcmdiYSgxOTYsMTYxLDYwLC40NSk7DQogICAgICBwb2ludGVyLWV2ZW50czogbm9uZTsNCiAgICAgIHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsLTUwJSk7DQogICAgICB3aWxsLWNoYW5nZTogdHJhbnNmb3JtOw0KICAgIH0NCiAgICBib2R5LmMtaG92ZXIgI2N1ci1kb3QgIHsgd2lkdGg6IDRweDsgaGVpZ2h0OiA0cHg7IGJhY2tncm91bmQ6ICNlOGM5NmE7IH0NCiAgICBib2R5LmMtaG92ZXIgI2N1ci1yaW5nIHsgd2lkdGg6IDQ0cHg7IGhlaWdodDogNDRweDsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQogICAgYm9keS5jLWNsaWNrICNjdXItZG90ICB7IHdpZHRoOiA5cHg7IGhlaWdodDogOXB4OyB9DQogICAgYm9keS5jLWNsaWNrICNjdXItcmluZyB7IHdpZHRoOiAyMHB4OyBoZWlnaHQ6IDIwcHg7IH0NCiAgICAuY3VyLXJpcHBsZSB7DQogICAgICBwb3NpdGlvbjogZml4ZWQ7IHotaW5kZXg6IDk5OTk3OyBwb2ludGVyLWV2ZW50czogbm9uZTsgYm9yZGVyLXJhZGl1czogNTAlOw0KICAgICAgYm9yZGVyOiAxLjVweCBzb2xpZCByZ2JhKDE5NiwxNjEsNjAsLjU1KTsNCiAgICAgIHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsLTUwJSkgc2NhbGUoMCk7DQogICAgICBhbmltYXRpb246IGNSaXBwbGUgLjZzIGVhc2UgZm9yd2FyZHM7DQogICAgfQ0KICAgIEBrZXlmcmFtZXMgY1JpcHBsZSB7DQogICAgICBmcm9tIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwtNTAlKSBzY2FsZSgwKTsgb3BhY2l0eToxOyB3aWR0aDoxMHB4OyBoZWlnaHQ6MTBweDsgfQ0KICAgICAgdG8gICB7IHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsLTUwJSkgc2NhbGUoMSk7IG9wYWNpdHk6MDsgd2lkdGg6ODBweDsgaGVpZ2h0OjgwcHg7IH0NCiAgICB9DQoNCiAgICBAbWVkaWEgKG1heC13aWR0aDogNjQwcHgpIHsNCiAgICAgIC50b3AtYmFyIHsgcGFkZGluZzogMCAyMHB4OyB9DQogICAgICBhcnRpY2xlIHsgcGFkZGluZzogNDhweCAyMHB4IDgwcHg7IH0NCiAgICAgIGgxLnRpdGxlIHsgZm9udC1zaXplOiAzMnB4OyB9DQogICAgICAjY3VyLWRvdCwgI2N1ci1yaW5nIHsgZGlzcGxheTogbm9uZTsgfQ0KICAgICAgaHRtbCwgYm9keSwgYSwgYnV0dG9uIHsgY3Vyc29yOiBhdXRvOyB9DQogICAgfQ0KICA8L3N0eWxlPg0KPC9oZWFkPg0KPGJvZHk+DQogIDxkaXYgaWQ9ImN1ci1kb3QiPjwvZGl2Pg0KICA8ZGl2IGlkPSJjdXItcmluZyI+PC9kaXY+DQoNCiAgPGRpdiBjbGFzcz0idG9wLWJhciI+DQogIDxhIGNsYXNzPSJiYWNrLWJ0biIgaHJlZj0iamF2YXNjcmlwdDpoaXN0b3J5LmJhY2soKSI+4oaQIFZpc3N6YTwvYT4NCiAgPHNwYW4gY2xhc3M9ImJhci10aXRsZSI+Q2lrayBjw61tZSBpZGU8L3NwYW4+DQo8L2Rpdj4NCg0KPGFydGljbGU+DQoNCiAgPCEtLSDilIDilIAgQXJ0aWNsZSBIZWFkZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIC0tPg0KICA8ZGl2IGNsYXNzPSJhcnRpY2xlLW1ldGEiPg0KICAgIDxzcGFuIGNsYXNzPSJhcnRpY2xlLWRhdGUiPjIwMjQuIGphbnXDoXIgMS48L3NwYW4+DQogICAgPHNwYW4gY2xhc3M9ImFydGljbGUtdGFnIj5tYXRlbWF0aWthPC9zcGFuPg0KICAgIDxzcGFuIGNsYXNzPSJhcnRpY2xlLXRhZyI+YW5hbMOtemlzPC9zcGFuPg0KICA8L2Rpdj4NCg0KICA8aDEgY2xhc3M9InRpdGxlIj5DaWtrIDxlbT5jw61tZTwvZW0+IGlkZTwvaDE+DQoNCiAgPHAgY2xhc3M9ImFydGljbGUtaW50cm8iPg0KICAgIEVneSByw7Z2aWQgYmV2ZXpldMWRIGJla2V6ZMOpcywgYW1lbHkgbWVnYWRqYSBheiBvbHZhc8OzbmFrLCBtaXLFkWwgc3rDs2wgZXogYSBjaWtrLg0KICAgIE1hcmFkam9uIHTDtm3DtnIg4oCUIGVneXTFkWwgaMOhcm9tIG1vbmRhdGlnLiBFeiBhIHN6w7Z2ZWcgYSBOb3RlcyBvbGRhbCBrw6FydHnDoWrDoW4gaXMgbWVnamVsZW5pay4NCiAgPC9wPg0KDQogIDwhLS0g4pSA4pSAIEJvZHkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIC0tPg0KDQogIDwhLS0gQVJUSUNMRS1CT0RZLVNUQVJUIC0tPg0KICA8aDI+RWxzxZEgc3pha2FzejwvaDI+DQoNCiAgPHA+DQogICAgRXogYSB0w7ZyenNzesO2dmVnIGVneWlrIGJla2V6ZMOpc2UuIEEgbWF0ZW1hdGlrw6F0IGxlaGV0IHNvcm9uIGJlbMO8bCDDrXJuaTogJGVee2lccGl9ICsgMSA9IDAkLA0KICAgIHZhZ3kgYXogYWzDoWJiaSBrw7xsw7ZuIGJsb2trYmFuLg0KICA8L3A+DQoNCiAgPGRpdiBjbGFzcz0ibWF0aC1ibG9jayI+DQogICAgJCRcaW50X3stXGluZnR5fV57XGluZnR5fSBlXnsteF4yfVwsIGR4ID0gXHNxcnR7XHBpfSQkDQogIDwvZGl2Pg0KDQogIDxwPg0KICAgIEZvbHl0YXNkIGl0dCBheiDDrXLDoXN0LiBIYXN6bsOhbGogPHN0cm9uZz5mw6lsa8O2dsOpcnQ8L3N0cm9uZz4gYSBraWVtZWzDqXNoZXogw6lzIDxlbT5kxZFsdCBiZXTFsXQ8L2VtPg0KICAgIGEgbWF0ZW1hdGlrYWkga2lmZWplesOpc2VraGV6IHZhZ3kgY8OtbWVraGV6Lg0KICA8L3A+DQoNCiAgPGRpdiBjbGFzcz0iZGVmLWJveCI+DQogICAgPHNwYW4gY2xhc3M9ImRlZi1sYWJlbCI+RGVmaW7DrWNpw7MgMS4xPC9zcGFuPg0KICAgIDxwPg0KICAgICAgRWd5ICRmOiBcbWF0aGJie1J9IFx0byBcbWF0aGJie1J9JCBmw7xnZ3bDqW55dCBha2tvciBtb25kdW5rIDxzdHJvbmc+Zm9seXRvbm9zbmFrIGF6ICRhJCBwb250YmFuPC9zdHJvbmc+LA0KICAgICAgaGEgbWluZGVuICRcdmFyZXBzaWxvbiA+IDAkLWhveiBsw6l0ZXppayBvbHlhbiAkXGRlbHRhID4gMCQsIGhvZ3kNCiAgICAgICR8eCAtIGF8IDwgXGRlbHRhIFxSaWdodGFycm93IHxmKHgpIC0gZihhKXwgPCBcdmFyZXBzaWxvbiQuDQogICAgPC9wPg0KICA8L2Rpdj4NCg0KICA8aDI+TcOhc29kaWsgc3pha2FzejwvaDI+DQoNCiAgPGRpdiBjbGFzcz0idGhlb3JlbS1ib3giPg0KICAgIDxzcGFuIGNsYXNzPSJ0aG0tbGFiZWwiPlTDqXRlbCAyLjEg4oCUIMONcmQgw6F0IGEgdMOpdGVsIG5ldsOpcmU8L3NwYW4+DQogICAgPHA+DQogICAgICDDjXJkIGlkZSBhIHTDqXRlbHQuIFDDqWxkw6F1bDogaGEgJGYkIGZvbHl0b25vcyBheiAkW2EsIGJdJCBpbnRlcnZhbGx1bW9uLCBha2tvciAkZiQgZmVsdmVzemkNCiAgICAgIGEgbWF4aW11bcOhdCDDqXMgbWluaW11bcOhdCBheiAkW2EsIGJdJCBpbnRlcnZhbGx1bW9uLg0KICAgIDwvcD4NCiAgPC9kaXY+DQoNCiAgPGRpdiBjbGFzcz0icHJvb2YtYm94Ij4NCiAgICA8c3BhbiBjbGFzcz0icHJvb2YtbGFiZWwiPkJpem9uecOtdMOhczwvc3Bhbj4NCiAgICA8cD4NCiAgICAgIMONcmQgaWRlIGEgYml6b255w610w6FzdC4gU3rDvGtzw6lnIHN6ZXJpbnQgaGFzem7DoWxqIGvDvGzDtm4ga2llbWVsdCBrw6lwbGV0ZWtldDoNCiAgICAgICQkXHN1bV97bj0xfV57XGluZnR5fSBcZnJhY3sxfXtuXjJ9ID0gXGZyYWN7XHBpXjJ9ezZ9JCQNCiAgICA8L3A+DQogICAgPHA+Rm9seXRhc2QgYSBiaXpvbnnDrXTDoXN0Li4uIDxzcGFuIGNsYXNzPSJxZWQiPuKWoTwvc3Bhbj48L3A+DQogIDwvZGl2Pg0KDQogIDxoMj5KZWd5emV0ZWsgw6lzIGhpdmF0a296w6Fzb2s8L2gyPg0KDQogIDxwPkFkZCBpZGUgYSBoaXZhdGtvesOhc29rYXQsIHRvdsOhYmJpIG9sdmFzbcOhbnlva2F0IHZhZ3kga8O2c3rDtm5ldG55aWx2w6Fuw610w6Fzb2thdC48L3A+DQoNCiAgPGJsb2NrcXVvdGU+DQogICAgRWd5IHN6w6lwIGVyZWRtw6lueSBvbHlhbiwgYW1lbHlldCBuZW0gbGVoZXRldHQgdm9sbmEgZWd5c3plcsWxYmJlbiBtZWdmb2dhbG1hem5pLg0KICA8L2Jsb2NrcXVvdGU+DQoNCiAgPGRpdiBjbGFzcz0iZm9vdG5vdGVzIj4NCiAgICA8b2w+DQogICAgICA8bGk+SWRlIGtlcsO8bCBheiBlbHPFkSBsw6FiamVneXpldCB2YWd5IGhpdmF0a296w6FzLjwvbGk+DQogICAgICA8bGk+SWRlIGtlcsO8bCBhIG3DoXNvZGlrIGzDoWJqZWd5emV0IHZhZ3kgaGl2YXRrb3rDoXMuPC9saT4NCiAgICA8L29sPg0KICA8L2Rpdj4NCg0KICA8IS0tIEFSVElDTEUtQk9EWS1FTkQgLS0+DQo8L2FydGljbGU+DQogIDxzY3JpcHQ+DQogICgoKSA9PiB7DQogICAgY29uc3QgZG90ICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXItZG90Jyk7DQogICAgY29uc3QgcmluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXItcmluZycpOw0KICAgIGxldCBteD0tMjAwLG15PS0yMDAscng9LTIwMCxyeT0tMjAwOw0KICAgIGNvbnN0IExFUlA9MC4xMywgbGVycD0oYSxiLHQpPT5hKyhiLWEpKnQ7DQogICAgY29uc3QgYiA9IGRvY3VtZW50LmJvZHk7DQoNCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCBlID0+IHsgbXg9ZS5jbGllbnRYOyBteT1lLmNsaWVudFk7IH0pOw0KICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIGUgPT4gew0KICAgICAgYi5jbGFzc0xpc3QuYWRkKCdjLWNsaWNrJyk7DQogICAgICBjb25zdCByPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyByLmNsYXNzTmFtZT0nY3VyLXJpcHBsZSc7DQogICAgICByLnN0eWxlLmxlZnQ9ZS5jbGllbnRYKydweCc7IHIuc3R5bGUudG9wPWUuY2xpZW50WSsncHgnOw0KICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChyKTsNCiAgICAgIHIuYWRkRXZlbnRMaXN0ZW5lcignYW5pbWF0aW9uZW5kJywoKT0+ci5yZW1vdmUoKSk7DQogICAgfSk7DQogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2V1cCcsICAgICgpID0+IGIuY2xhc3NMaXN0LnJlbW92ZSgnYy1jbGljaycpKTsNCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4geyBkb3Quc3R5bGUub3BhY2l0eT0nMCc7IHJpbmcuc3R5bGUub3BhY2l0eT0nMCc7IH0pOw0KICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7IGRvdC5zdHlsZS5vcGFjaXR5PScxJzsgcmluZy5zdHlsZS5vcGFjaXR5PScxJzsgfSk7DQoNCiAgICBjb25zdCBIUyA9ICdhLGJ1dHRvbiwuYmFjay1idG4sW2RhdGEtaG92ZXJdJzsNCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW92ZXInLCBlID0+IHsgaWYoZS50YXJnZXQuY2xvc2VzdChIUykpIGIuY2xhc3NMaXN0LmFkZCgnYy1ob3ZlcicpOyB9KTsNCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW91dCcsICBlID0+IHsgaWYoZS50YXJnZXQuY2xvc2VzdChIUykpIGIuY2xhc3NMaXN0LnJlbW92ZSgnYy1ob3ZlcicpOyB9KTsNCg0KICAgIChmdW5jdGlvbiBhbmltKCkgew0KICAgICAgZG90LnN0eWxlLmxlZnQgPW14KydweCc7IGRvdC5zdHlsZS50b3AgPW15KydweCc7DQogICAgICByeD1sZXJwKHJ4LG14LExFUlApOyAgICByeT1sZXJwKHJ5LG15LExFUlApOw0KICAgICAgcmluZy5zdHlsZS5sZWZ0PXJ4KydweCc7IHJpbmcuc3R5bGUudG9wPXJ5KydweCc7DQogICAgICByaW5nLnN0eWxlLnRyYW5zaXRpb249J25vbmUnOw0KICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGFuaW0pOw0KICAgIH0pKCk7DQogIH0pKCk7DQogIDwvc2NyaXB0Pg0KPC9ib2R5Pg0KPC9odG1sPg==";
function buildArticleFromTemplate(meta, bodyHtml, lang) {
  const title = meta.title || 'Untitled';
  const date  = meta.date || '';
  const desc  = meta.description || '';
  const tags  = (meta.tags || []).filter(Boolean);
  let tpl = null;
  for (const cand of [path.join(__dirname, 'template.html'), path.join(process.cwd(), 'template.html')]) {
    try { tpl = fs.readFileSync(cand, 'utf8'); break; } catch {}
  }
  if (tpl == null) { try { tpl = Buffer.from(ARTICLE_TEMPLATE_B64, 'base64').toString('utf8'); } catch { tpl = null; } }
  if (!tpl) {
    return '<!DOCTYPE html><html lang="' + (lang === 'hu' ? 'hu' : 'en') + '"><head><meta charset="UTF-8">'
      + '<title>' + htmlText(title) + '</title><meta data-date="' + htmlAttr(date) + '">'
      + '<meta data-description="' + htmlAttr(desc) + '"><meta data-tags="' + htmlAttr(tags.join(', ')) + '">'
      + '</head><body><article><h1 class="title">' + htmlText(title) + '</h1>' + (bodyHtml || '') + '</article></body></html>';
  }
  const metaHtml = (date ? '<span class="article-date">' + htmlText(date) + '</span>' : '')
    + tags.map(tt => '<span class="article-tag">' + htmlText(tt) + '</span>').join('');
  tpl = tpl.replace(/<title[^>]*>[\s\S]*?<\/title>/i, '<title>' + htmlText(title) + '</title>');
  tpl = tpl.replace(/(<meta\s+data-date=")[^"]*(")/i, '$1' + htmlAttr(date) + '$2');
  tpl = tpl.replace(/(<meta\s+data-description=")[^"]*(")/i, '$1' + htmlAttr(desc) + '$2');
  tpl = tpl.replace(/(<meta\s+data-tags=")[^"]*(")/i, '$1' + htmlAttr(tags.join(', ')) + '$2');
  tpl = tpl.replace(/<html\s+lang="[^"]*"/i, '<html lang="' + (lang === 'hu' ? 'hu' : 'en') + '"');
  tpl = tpl.replace(/(<span class="bar-title">)[\s\S]*?(<\/span>)/i, '$1' + htmlText(title) + '$2');
  tpl = tpl.replace(/(<a class="back-btn"[^>]*>)[\s\S]*?(<\/a>)/i, '$1' + (lang === 'hu' ? '\u2190 Vissza' : '\u2190 Back') + '$2');
  tpl = tpl.replace(/(<h1 class="title">)[\s\S]*?(<\/h1>)/i, '$1' + htmlText(title) + '$2');
  tpl = tpl.replace(/(<div class="article-meta">)[\s\S]*?(<\/div>)/i, '$1' + metaHtml + '$2');
  tpl = tpl.replace(/(<p class="article-intro">)[\s\S]*?(<\/p>)/i, '$1' + htmlText(desc) + '$2');
  if (/<!-- ARTICLE-BODY-START -->/.test(tpl)) {
    tpl = tpl.replace(/<!-- ARTICLE-BODY-START -->[\s\S]*?<!-- ARTICLE-BODY-END -->/,
      '<!-- ARTICLE-BODY-START -->\n' + (bodyHtml || '') + '\n  <!-- ARTICLE-BODY-END -->');
  } else {
    tpl = tpl.replace(/(<\/article>)/i, (bodyHtml || '') + '\n$1');
  }
  return tpl;
}

// ── Admin auth (scrypt + in-memory sessions) ──────────────────────────────────
// Admins live in admins.json:  [{ "username": "...", "salt": "<hex>", "hash": "<hex>" }]
// Create/seed entries with:  node make-admin.js <username> <password>
function loadAdmins() {
  try {
    const raw = JSON.parse(fs.readFileSync(__ADMINS, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.admins)) return raw.admins;
    return [];
  } catch { return []; }
}
// Site viewer accounts live in users.json (same shape as admins.json).
// Seed with:  node make-user.js <username> <password>
function loadUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(__USERS, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.users)) return raw.users;
    return [];
  } catch { return []; }
}
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}
function saveUsers(list) { writeFileAtomic(__USERS, JSON.stringify(list, null, 2) + '\n'); }
// Per-account UI settings (theme, language, layout) keyed by username.
function loadSettings() { try { const o = JSON.parse(fs.readFileSync(__SETTINGS, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function saveSettings(o) { writeFileAtomic(__SETTINGS, JSON.stringify(o, null, 2) + '\n'); }
function cleanSettings(j) {
  const out = {};
  if (j && typeof j === 'object') {
    if (j.lang === 'en' || j.lang === 'hu') out.lang = j.lang;
    if (j.matLang === 'en' || j.matLang === 'hu' || j.matLang === 'both') out.matLang = j.matLang;
    if (j.theme === 'dark' || j.theme === 'light' || j.theme === 'teal' || j.theme === 'custom') out.theme = j.theme;
    if (typeof j.customAccent  === 'string' && j.customAccent.length  <= 32)    out.customAccent  = j.customAccent;
    if (typeof j.customAccent2 === 'string' && j.customAccent2.length <= 32)    out.customAccent2 = j.customAccent2;
    if (typeof j.customTheme   === 'string' && j.customTheme.length   <= 4096)  out.customTheme   = j.customTheme;
    if (typeof j.savedThemes   === 'string' && j.savedThemes.length   <= 65536) out.savedThemes   = j.savedThemes;
    if (typeof j.rclickTheme   === 'string' && j.rclickTheme.length   <= 64)    out.rclickTheme   = j.rclickTheme;
    if (typeof j.cursor        === 'string' && j.cursor.length        <= 1024)  out.cursor        = j.cursor;
    if (typeof j.cursorSaved   === 'string' && j.cursorSaved.length   <= 65536) out.cursorSaved   = j.cursorSaved;
    if (j.sectionBy === 'type' || j.sectionBy === 'subject') out.sectionBy = j.sectionBy;
    if (typeof j.sectionOrder === 'string' && j.sectionOrder.length <= 8192) out.sectionOrder = j.sectionOrder;
    if (typeof j.childOrders === 'string' && j.childOrders.length <= 65536) out.childOrders = j.childOrders;
  }
  return out;
}
// ── Access grants (who may read which request-to-read note) ───────────────────
// grants.json is consulted once per note while annotating /api/tree, so it is
// memoised on (mtime, size) like data.txt rather than re-read N times per request.
let _grantsCache = null;
function loadGrants() {
  let key = 'none';
  try { const st = fs.statSync(__GRANTS); key = st.mtimeMs + ':' + st.size; } catch {}
  if (_grantsCache && _grantsCache.key === key) return _grantsCache.data;
  let data = {};
  try { const o = JSON.parse(fs.readFileSync(__GRANTS, 'utf8')); if (o && typeof o === 'object' && !Array.isArray(o)) data = o; } catch {}
  _grantsCache = { key, data };
  return data;
}
function saveGrants(o) { writeFileAtomic(__GRANTS, JSON.stringify(o, null, 2) + '\n'); _grantsCache = null; }
function grantKey(lang, relPath) { return (lang === 'hu' ? 'hu' : 'en') + ':' + relPath; }
function hasGrant(username, lang, relPath) { const g = loadGrants()[String(username).toLowerCase()]; return Array.isArray(g) && g.includes(grantKey(lang, relPath)); }
function addGrant(username, lang, relPath) { const all = loadGrants(); const u = String(username).toLowerCase(); const k = grantKey(lang, relPath); if (!Array.isArray(all[u])) all[u] = []; if (!all[u].includes(k)) { all[u].push(k); saveGrants(all); } }
function resolveUsername(name) {
  const n = String(name || '').toLowerCase();
  const u = loadUsers().find(x => String(x.username).toLowerCase() === n); if (u) return u.username;
  const a = loadAdmins().find(x => String(x.username).toLowerCase() === n); if (a) return a.username;
  return null;
}
// Who receives a read-request for a note: its `allow` owners, else all admins.
function requestRecipients(relPath, lang) {
  const owners = noteOwners(relPath, lang).map(resolveUsername).filter(Boolean);
  if (owners.length) return [...new Set(owners)];
  return loadAdmins().map(a => a.username);
}
// ── Chat conversations (DMs + group chats; text only) ─────────────────────────
function loadChats() { try { const o = JSON.parse(fs.readFileSync(__CHATS, 'utf8')); return (o && Array.isArray(o.conversations)) ? o : { conversations: [] }; } catch { return { conversations: [] }; } }
function saveChats(o) { writeFileAtomic(__CHATS, JSON.stringify(o, null, 2) + '\n'); }
function loadNoteDiscuss() { try { const o = JSON.parse(fs.readFileSync(__NOTE_DISCUSS, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function saveNoteDiscuss(o) { writeFileAtomic(__NOTE_DISCUSS, JSON.stringify(o, null, 2) + '\n'); }
function noteDiscussKey(p, lang) { return (lang === 'hu' ? 'hu' : 'en') + ':' + String(p); }
function chatParticipant(c, name) { const n = String(name).toLowerCase(); return (c.participants || []).some(p => String(p).toLowerCase() === n); }
function chatUnread(c, name) { const n = String(name).toLowerCase(); const last = (c.reads && c.reads[n]) || ''; return (c.messages || []).filter(m => String(m.from).toLowerCase() !== n && (m.date || '') > last).length; }
function findDM(chats, a, b) { const A = String(a).toLowerCase(), B = String(b).toLowerCase(); return chats.conversations.find(c => c.type === 'dm' && (c.participants || []).length === 2 && c.participants.map(x => String(x).toLowerCase()).includes(A) && c.participants.map(x => String(x).toLowerCase()).includes(B)); }
function ensureDM(chats, a, b) { let c = findDM(chats, a, b); if (!c) { c = { id: crypto.randomUUID(), type: 'dm', title: '', participants: [a, b], createdBy: a, created: new Date().toISOString(), messages: [], reads: {} }; chats.conversations.push(c); } return c; }
function chatTitleFor(c, me) { if (c.type === 'group') return c.title || 'Group'; const other = (c.participants || []).find(p => String(p).toLowerCase() !== String(me).toLowerCase()); return other || 'Direct message'; }
function chatPreview(m) { if (!m) return ''; if (m.deleted) return ''; if (m.kind === 'donation') return '\uD83D\uDCE5 ' + ((m.donation && m.donation.title) || 'donated note'); if (m.kind === 'donation-result') return 'donation ' + (m.decision || ''); if (m.kind === 'access-request') return '\uD83D\uDD12 ' + ((m.note && m.note.label) || 'access request'); if (m.kind === 'access-result') return 'access ' + (m.decision || ''); if (m.noteRef && !String(m.body || '').trim()) return '\uD83D\uDCC4 ' + (m.noteRef.label || 'note'); return m.body || ''; }

// Role/permission model for group conversations. Back-compat: a conversation with no
// `roles` map treats its createdBy as 'owner' and every other participant as 'member'.
// Roles: owner > admin > member > readonly. DMs have no roles (both peers are equal).
function chatRole(c, name) {
  const n = String(name).toLowerCase();
  if (!chatParticipant(c, name)) return null;
  if (c.type !== 'group') return 'member';
  const r = c.roles && c.roles[n];
  if (r === 'owner' || r === 'admin' || r === 'member' || r === 'readonly') return r;
  return (String(c.createdBy || '').toLowerCase() === n) ? 'owner' : 'member';
}
function chatCan(c, name, perm) {
  const role = chatRole(c, name);
  if (!role) return false;
  if (c.type !== 'group') { return perm === 'read' || perm === 'write'; } // DMs: read+write only
  switch (perm) {
    case 'read':           return true;
    case 'write':          return role !== 'readonly';
    case 'manageMessages': return role === 'owner' || role === 'admin';
    case 'manageMembers':  return role === 'owner' || role === 'admin';
    case 'setRole':        return role === 'owner';
    case 'deleteConv':     return role === 'owner';
    default:               return false;
  }
}
// Per-user "hidden" (deleted-for-me) and "archived" sets live on the conversation.
function chatHiddenFor(c, name) { const n = String(name).toLowerCase(); return Array.isArray(c.deletedBy) && c.deletedBy.map(x => String(x).toLowerCase()).includes(n); }
function chatArchivedFor(c, name) { const n = String(name).toLowerCase(); return Array.isArray(c.archivedBy) && c.archivedBy.map(x => String(x).toLowerCase()).includes(n); }
function _unhide(c, name) { const n = String(name).toLowerCase(); if (Array.isArray(c.deletedBy)) c.deletedBy = c.deletedBy.filter(x => String(x).toLowerCase() !== n); }

// Per-user block list (blocked.json: { userLc: [blockedUserLc, \u2026] }). Blocking is
// mutual in effect \u2014 a DM between A and B is closed if either blocked the other.
function loadBlocked() { try { const o = JSON.parse(fs.readFileSync(__BLOCKED, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
function saveBlocked(o) { writeFileAtomic(__BLOCKED, JSON.stringify(o, null, 2) + '\n'); }
function blockedSet(map, name) { const a = map[String(name).toLowerCase()]; return new Set(Array.isArray(a) ? a.map(x => String(x).toLowerCase()) : []); }
function isBlockedBetween(map, a, b) { return blockedSet(map, a).has(String(b).toLowerCase()) || blockedSet(map, b).has(String(a).toLowerCase()); }

// Presence: in-memory last-seen heartbeats. A user is "online" while their
// heartbeats keep arriving; when they lose their connection the heartbeats stop,
// so other participants automatically see them drop offline.
const _presence = new Map(); // username(lowercased) -> last-seen epoch ms (ephemeral; lost on restart)
function touchPresence(name) { if (name) _presence.set(String(name).toLowerCase(), Date.now()); }
function lastSeenAgo(name, now) { const t = _presence.get(String(name).toLowerCase()); return t ? ((now || Date.now()) - t) : null; }
function presenceFor(names, now) { const out = {}; for (const p of names || []) { const k = String(p).toLowerCase(); if (!(k in out)) out[k] = lastSeenAgo(p, now); } return out; }
// Evict long-stale entries so the Map can't grow without bound over a long uptime
// (a missing entry already reads as "offline", so old rows carry no information).
setInterval(() => { const cutoff = Date.now() - 24 * 3600 * 1000; for (const [k, t] of _presence) if (t < cutoff) _presence.delete(k); }, 3600 * 1000).unref?.();
// ══ Timetable & day log ═══════════════════════════════════════════════════════
// Two stores, both git-ignored runtime state:
//   timetable.json — the recurring weekly schedule (periods, subjects, slots) that
//                    admins edit in DevTools. One document; small.
//   days.json      — the day log: for a given calendar date, which of that day's
//                    lessons happened and what happened in them. Each lesson may
//                    carry free text, topics, homework, links to digital notes and
//                    uploaded files (typically photographed/scanned paper notes).
// Each logged lesson keeps a *snapshot* of its subject name / colour / time, so an
// archived day still reads correctly years later even if the timetable is rewritten.

const __TIMETABLE = path.join(__dirname, 'timetable.json');
const __DAYS      = path.join(__dirname, 'days.json');
const __UPLOADS   = path.join(__dirname, 'Uploads');
const __DAY_FILES = path.join(__UPLOADS, 'days');

const DAY_MAX          = 5000;                                        // ~27 school years
const DAY_LESSON_MAX   = 30;
const ATTACH_MAX_BYTES = Number(process.env.DAY_UPLOAD_MAX || 25 * 1024 * 1024);
const ATTACH_PER_LESSON = 40;
// Deliberately no .svg / .html / .htm: those execute script when served from our
// own origin, and these files are rendered inline in the day feed.
const ATTACH_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff', '.heic', '.heif',
  '.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.mp3', '.m4a', '.ogg', '.wav', '.mp4', '.webm', '.mov']);
const INLINE_EXTS  = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.pdf', '.txt', '.md', '.csv',
  '.mp3', '.m4a', '.ogg', '.wav', '.mp4', '.webm']);
const IMAGE_EXTS   = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);

// ── small validators ─────────────────────────────────────────────────────────
function _str(v, max) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').slice(0, max || 200).trim(); }
function _multi(v, max) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').slice(0, max || 2000); }
function _id(v) { const s = String(v == null ? '' : v); return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : ''; }
function _newId() { return crypto.randomBytes(9).toString('base64url'); }
function _idOrNew(v) { return _id(v) || _newId(); }
function _hex(v, fallback) { const s = String(v == null ? '' : v).trim(); return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : fallback; }
function isDate(v) {
  const s = String(v == null ? '' : v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function _date(v) { return isDate(v) ? String(v) : ''; }
function _time(v) { const s = String(v == null ? '' : v).trim(); return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : ''; }
function _int(v, lo, hi, fallback) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback; }
function _list(v) { return Array.isArray(v) ? v : []; }
function _lang(v) { return v === 'hu' ? 'hu' : 'en'; }

// ISO weekday 1..7 (Mon..Sun) for a YYYY-MM-DD string, computed in UTC so it can
// never drift with the server's local timezone.
function isoDow(dateStr) { const d = new Date(dateStr + 'T00:00:00Z'); const g = d.getUTCDay(); return g === 0 ? 7 : g; }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (isoDow(dateStr) - 1));
  return d.toISOString().slice(0, 10);
}
// 0 = week A, 1 = week B. Meaningless (always 0) when weekCycle is 1.
function weekParity(dateStr, settings) {
  const cycle = _int(settings && settings.weekCycle, 1, 4, 1);
  if (cycle < 2 || !isDate(dateStr)) return 0;
  const anchor = _date(settings && settings.cycleAnchor) || '2024-09-02';
  const a = Date.parse(mondayOf(anchor) + 'T00:00:00Z');
  const b = Date.parse(mondayOf(dateStr) + 'T00:00:00Z');
  const weeks = Math.round((b - a) / (7 * 86400000));
  return ((weeks % cycle) + cycle) % cycle;
}

// ── timetable ────────────────────────────────────────────────────────────────
function normTimetable(raw) {
  const t = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const s = (t.settings && typeof t.settings === 'object') ? t.settings : {};
  const days = [...new Set(_list(s.days).map(d => _int(d, 1, 7, 0)).filter(Boolean))].sort((a, b) => a - b);
  const periods = _list(s.periods).slice(0, 24).map((p, i) => ({
    id: _idOrNew(p && p.id),
    label: _str(p && p.label, 24) || String(i + 1),
    start: _time(p && p.start),
    end: _time(p && p.end),
  }));
  const seenP = new Set();
  const periodsU = periods.filter(p => !seenP.has(p.id) && seenP.add(p.id));
  const subjects = _list(t.subjects).slice(0, 120).map(x => ({
    id: _idOrNew(x && x.id),
    name:   _str(x && x.name, 80) || 'Subject',
    nameHu: _str(x && x.nameHu, 80),
    short:  _str(x && x.short, 12),
    color:  _hex(x && x.color, '#8b8fa3'),
    teacher: _str(x && x.teacher, 80),
    room:    _str(x && x.room, 40),
    // Optional link to a folder of digital notes for this subject.
    folder:  _str(x && x.folder, 512),
    folderLang: _lang(x && x.folderLang),
  }));
  const subjIds = new Set(subjects.map(x => x.id));
  const periodIds = new Set(periodsU.map(p => p.id));
  // A slot whose weekday, period or subject does not resolve is dropped, not
  // coerced: silently remapping it to Monday/period 1 would invent a lesson that
  // nobody put there, and that ghost then seeds every day logged for that weekday.
  const slots = _list(t.slots).slice(0, 600).map(x => ({
    id: _idOrNew(x && x.id),
    day: _int(x && x.day, 1, 7, 0),
    periodId: periodIds.has(_id(x && x.periodId)) ? _id(x.periodId) : '',
    subjectId: subjIds.has(_id(x && x.subjectId)) ? _id(x.subjectId) : '',
    room: _str(x && x.room, 40),
    teacher: _str(x && x.teacher, 80),
    week: _int(x && x.week, 0, 4, 0),          // 0 = every week, 1 = A, 2 = B …
    note: _str(x && x.note, 160),
  })).filter(x => x.day && x.subjectId && x.periodId);
  const events = _list(t.events).slice(0, 400).map(x => ({
    id: _idOrNew(x && x.id),
    from: _date(x && (x.from || x.date)),
    to:   _date(x && x.to) || _date(x && (x.from || x.date)),
    kind: ['holiday', 'break', 'exam', 'event', 'noSchool'].includes(x && x.kind) ? x.kind : 'event',
    label:   _str(x && x.label, 120),
    labelHu: _str(x && x.labelHu, 120),
  })).filter(x => x.from).map(x => (x.to < x.from ? { ...x, to: x.from } : x));
  return {
    version: 1,
    updated: (t.updated && typeof t.updated === 'string') ? t.updated : null,
    settings: {
      visibility: t.settings && t.settings.visibility === 'members' ? 'members' : 'all',
      title:   _str(s.title, 80),
      titleHu: _str(s.titleHu, 80),
      days: days.length ? days : [1, 2, 3, 4, 5],
      weekCycle: _int(s.weekCycle, 1, 4, 1),
      cycleAnchor: _date(s.cycleAnchor),
      startDate: _date(s.startDate),
      endDate: _date(s.endDate),
      periods: periodsU.length ? periodsU : [],
    },
    subjects, slots, events,
  };
}
let _ttCache = null;
function loadTimetable() {
  let key = 'none';
  try { const st = fs.statSync(__TIMETABLE); key = st.mtimeMs + ':' + st.size; } catch {}
  if (_ttCache && _ttCache.key === key) return _ttCache.data;
  let raw = null; try { raw = JSON.parse(fs.readFileSync(__TIMETABLE, 'utf8')); } catch {}
  const data = normTimetable(raw);
  _ttCache = { key, data };
  return data;
}
function saveTimetable(t) {
  const norm = normTimetable(t);
  norm.updated = new Date().toISOString();
  writeFileAtomic(__TIMETABLE, JSON.stringify(norm, null, 2) + '\n');
  _ttCache = null;
  return norm;
}

// Lessons scheduled for one date, in period order, with holidays applied.
function planForDate(dateStr, tt) {
  const t = tt || loadTimetable();
  if (!isDate(dateStr)) return { date: '', dow: 0, week: 0, events: [], lessons: [] };
  const dow = isoDow(dateStr);
  const parity = weekParity(dateStr, t.settings);
  const events = t.events.filter(e => e.from <= dateStr && dateStr <= e.to);
  const byId = new Map(t.subjects.map(s => [s.id, s]));
  const periodIdx = new Map(t.settings.periods.map((p, i) => [p.id, i]));
  // With no A/B cycle configured, a slot's week tag is meaningless — show every
  // slot, or turning the cycle off would silently hide all the week-B lessons.
  const cycled = _int(t.settings.weekCycle, 1, 4, 1) > 1;
  const lessons = t.slots
    .filter(sl => sl.day === dow && (!cycled || sl.week === 0 || sl.week === parity + 1))
    .map(sl => {
      const subj = byId.get(sl.subjectId) || null;
      const per = t.settings.periods.find(p => p.id === sl.periodId) || null;
      return {
        slotId: sl.id,
        subjectId: sl.subjectId,
        subject:   subj ? subj.name : '',
        subjectHu: subj ? subj.nameHu : '',
        color:     subj ? subj.color : '#8b8fa3',
        folder:     subj ? subj.folder : '',
        folderLang: subj ? subj.folderLang : 'en',
        periodId: sl.periodId,
        periodLabel: per ? per.label : '',
        start: per ? per.start : '',
        end:   per ? per.end : '',
        room:    sl.room    || (subj ? subj.room : ''),
        teacher: sl.teacher || (subj ? subj.teacher : ''),
        note: sl.note,
      };
    })
    .sort((a, b) => (periodIdx.get(a.periodId) ?? 99) - (periodIdx.get(b.periodId) ?? 99));
  return { date: dateStr, dow, week: parity, events, lessons };
}

// ── day log ──────────────────────────────────────────────────────────────────
const LESSON_KINDS = ['lesson', 'test', 'exam', 'lab', 'presentation', 'trip', 'substitution', 'selfstudy', 'cancelled'];

function normAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const id = _id(a.id); if (!id) return null;
  const name = _str(a.name, 200) || 'file';
  const ext = path.extname(name).toLowerCase();
  return {
    id, name,
    ext: ATTACH_EXTS.has(ext) ? ext : '',
    mime: _str(a.mime, 120),
    size: _int(a.size, 0, 5 * 1024 * 1024 * 1024, 0),
    kind: a.kind === 'scan' ? 'scan' : 'file',
    caption: _str(a.caption, 240),
    added: _str(a.added, 40),
  };
}
function normNoteRef(n) {
  if (!n || typeof n !== 'object') return null;
  const p = _str(n.path, 512); if (!p) return null;
  return { path: p, lang: _lang(n.lang), label: _str(n.label, 200) };
}
function normLesson(l) {
  const o = (l && typeof l === 'object') ? l : {};
  return {
    id: _idOrNew(o.id),
    slotId: _id(o.slotId),
    subjectId: _id(o.subjectId),
    subject:   _str(o.subject, 80),
    subjectHu: _str(o.subjectHu, 80),
    color: _hex(o.color, '#8b8fa3'),
    periodId: _id(o.periodId),
    periodLabel: _str(o.periodLabel, 24),
    start: _time(o.start),
    end: _time(o.end),
    room: _str(o.room, 40),
    teacher: _str(o.teacher, 80),
    kind: LESSON_KINDS.includes(o.kind) ? o.kind : 'lesson',
    what: _multi(o.what, 8000),
    homework: _multi(o.homework, 2000),
    topics: _list(o.topics).slice(0, 24).map(x => _str(x, 120)).filter(Boolean),
    important: !!o.important,
    notes: _list(o.notes).slice(0, 30).map(normNoteRef).filter(Boolean),
    attachments: _list(o.attachments).slice(0, ATTACH_PER_LESSON).map(normAttachment).filter(Boolean),
  };
}
function normDay(d, prev) {
  const o = (d && typeof d === 'object') ? d : {};
  const now = new Date().toISOString();
  return {
    id: _idOrNew(o.id),
    date: _date(o.date),
    title:   _str(o.title, 160),
    titleHu: _str(o.titleHu, 160),
    summary:   _multi(o.summary, 4000),
    summaryHu: _multi(o.summaryHu, 4000),
    visibility: o.visibility === 'members' ? 'members' : 'all',
    week: _int(o.week, 0, 3, 0),
    lessons: _list(o.lessons).slice(0, DAY_LESSON_MAX).map(normLesson),
    createdBy: _str((prev && prev.createdBy) || o.createdBy, 64),
    created:   _str((prev && prev.created) || o.created, 40) || now,
    updatedBy: _str(o.updatedBy, 64),
    updated:   now,
  };
}
let _daysCache = null;
function loadDays() {
  let key = 'none';
  try { const st = fs.statSync(__DAYS); key = st.mtimeMs + ':' + st.size; } catch {}
  if (_daysCache && _daysCache.key === key) return _daysCache.data;
  let data = [];
  try {
    const o = JSON.parse(fs.readFileSync(__DAYS, 'utf8'));
    const arr = Array.isArray(o) ? o : (o && Array.isArray(o.days) ? o.days : []);
    data = arr.map(d => normDay(d, d)).filter(d => d.date);
  } catch {}
  data.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  _daysCache = { key, data };
  return data;
}
function saveDays(list) {
  const arr = (Array.isArray(list) ? list : []).filter(d => d && d.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, DAY_MAX);
  writeFileAtomic(__DAYS, JSON.stringify({ version: 1, days: arr }, null, 2) + '\n');
  _daysCache = null;
  return arr;
}
function findDayByDate(list, date) { return (list || []).find(d => d.date === date) || null; }

// A day is visible to everyone unless it is marked members-only.
function canSeeDay(day, session) {
  if (!day) return false;
  if (day.visibility !== 'members') return true;
  return !!session;
}
// Note links inside a day are pruned per viewer: a lesson must never advertise the
// existence of a note the viewer isn't allowed to see.
function publicDay(day, req) {
  const out = { ...day, lessons: (day.lessons || []).map(l => ({
    ...l,
    notes: (l.notes || []).filter(n => { try { return canViewNote(req, n.path, n.lang); } catch { return false; } }),
  })) };
  return out;
}
function daySearchText(d) {
  const parts = [d.title, d.titleHu, d.summary, d.summaryHu];
  for (const l of d.lessons || []) parts.push(l.subject, l.subjectHu, l.what, l.homework, l.teacher, l.room, (l.topics || []).join(' '),
    (l.attachments || []).map(a => a.name + ' ' + a.caption).join(' '), (l.notes || []).map(n => n.label).join(' '));
  return parts.join(' \n ').toLowerCase();
}
function dayCounts(d) {
  let files = 0, scans = 0, notes = 0;
  for (const l of d.lessons || []) {
    for (const a of l.attachments || []) { files++; if (a.kind === 'scan') scans++; }
    notes += (l.notes || []).length;
  }
  return { lessons: (d.lessons || []).length, files, scans, notes };
}

// ── day attachments on disk ──────────────────────────────────────────────────
function dayFileDir(dayId) { return path.join(__DAY_FILES, dayId); }
function attachmentPath(dayId, attId, ext) { return path.join(dayFileDir(dayId), attId + (ext || '')); }
function findAttachment(day, attId) {
  for (const l of day.lessons || []) for (const a of l.attachments || []) if (a.id === attId) return a;
  return null;
}
function deleteAttachmentFile(dayId, att) {
  if (!_id(dayId) || !att || !_id(att.id)) return;
  try { fs.rmSync(attachmentPath(dayId, att.id, att.ext), { force: true }); } catch {}
}
// Files uploaded for a day that was never saved (the admin closed the dialog) would
// otherwise sit on disk forever. Sweep folders with no matching day once an hour,
// but only when they are older than a day so an in-progress edit is never touched.
function sweepOrphanDayFiles() {
  let dirs; try { dirs = fs.readdirSync(__DAY_FILES, { withFileTypes: true }); } catch { return 0; }
  const known = new Set(loadDays().map(d => d.id));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  for (const e of dirs) {
    if (!e.isDirectory() || known.has(e.name)) continue;
    let st; try { st = fs.statSync(path.join(__DAY_FILES, e.name)); } catch { continue; }
    if (st.mtimeMs > cutoff) continue;
    rmDirSync(path.join(__DAY_FILES, e.name)); removed++;
  }
  return removed;
}


// ── Note donations: member submissions awaiting an admin's audit ──────────────
// Anyone signed in may offer a note — LaTeX source, Markdown/plain text, a PDF, or
// a photographed page. Nothing a donor sends is part of the archive: it is staged
// under Uploads/donations/<id>/ and referenced from donations.json until an admin
// accepts it, at which point exactly one staged file is moved into Data/DataHU and
// gets a data.txt section. A decline deletes the staging folder outright.
//
// Two rules the rest of this section exists to enforce:
//   · a pending submission is readable by its donor and by admins, and by nobody
//     else — it is unreviewed content from an account we cannot vouch for, so it
//     must never be reachable from the public tree, the search index, or a URL a
//     stranger can guess;
//   · a donor can never choose where their file lands. They may *suggest* a folder
//     and a language; the admin picks the real destination at accept time.
const __DONATION_FILES = path.join(__UPLOADS, 'donations');

const DONATE_MAX_PENDING_USER  = Number(process.env.DONATE_MAX_PENDING_USER)  || 5;
const DONATE_MAX_PENDING_TOTAL = Number(process.env.DONATE_MAX_PENDING_TOTAL) || 300;
const DONATE_MAX_RECORDS       = 4000;                 // decided donations are kept for the log, but not forever
const DONATE_MAX_ITEMS         = 12;
const DONATE_TEXT_MAX          = 512 * 1024;           // matches NOTE_TEXT_MAX — bigger than any real note
const DONATE_MAX_BYTES         = Number(process.env.DONATE_UPLOAD_MAX) || 25 * 1024 * 1024;
// Text kinds a donor may write in the browser. `.sty`/`.cls` are deliberately absent:
// they are pulled in automatically by any .tex compiled in the same directory, so
// accepting one is a far bigger decision than accepting a note and should be a
// deliberate admin action in DevTools, not a side effect of an audit.
const DONATE_TEXT_EXTS = new Set(['.tex', '.md', '.txt', '.bib']);
// Uploadable kinds. No .svg/.html/.htm — those execute script from our own origin,
// the same reason the day-attachment list excludes them.
const DONATE_FILE_EXTS = new Set(['.tex', '.md', '.txt', '.bib', '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const DONATE_ALL_EXTS  = new Set([...DONATE_TEXT_EXTS, ...DONATE_FILE_EXTS]);
const DONATE_STATUSES  = ['draft', 'pending', 'accepted', 'declined', 'withdrawn'];

// Turn any donor-supplied label into a filename base that is safe on every
// filesystem we deploy to. Slashes, control characters, the Windows-reserved
// punctuation and leading dots all go; `{...}` goes too because the archive reads
// braces in a filename as the note's tag list, and a donor should not be able to
// write tags by naming their file.
function safeNoteBase(name) {
  const b = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 120)
    .trim();
  return b || 'Donated note';
}
// Write a donation's staged files into `destDir` under their *original* names.
// Staging stores them as <itemId><ext> — safe and guessable-proof for serving, but
// useless to pdflatex, which resolves \includegraphics by the name written in the
// source. Returns itemId -> written filename.
function materializeDonation(d, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const used = new Set();
  const map = new Map();
  for (const it of d.items || []) {
    const ext = it.ext || '';
    let base = safeNoteBase(path.basename(it.name, ext));
    let fname = base + ext, n = 2;
    while (used.has(fname.toLowerCase())) { fname = base + '-' + (n++) + ext; }
    used.add(fname.toLowerCase());
    try {
      fs.copyFileSync(donationItemPath(d.id, it.id, ext), path.join(destDir, fname));
      map.set(it.id, fname);
    } catch {}
  }
  return map;
}
// rename() fails across filesystems, and Uploads/ may well sit on a different mount
// from Data/ — copy-then-unlink is the portable move.
function moveFileSync(src, dest) {
  try { fs.renameSync(src, dest); return; }
  catch (e) { if (e && e.code !== 'EXDEV') throw e; }
  fs.copyFileSync(src, dest);
  try { fs.rmSync(src, { force: true }); } catch {}
}

function donationDir(id) { return path.join(__DONATION_FILES, id); }
function donationItemPath(id, itemId, ext) { return path.join(donationDir(id), itemId + (ext || '')); }

function normDonationItem(a) {
  if (!a || typeof a !== 'object') return null;
  const id = _id(a.id); if (!id) return null;
  const name = _str(a.name, 200) || 'file';
  const ext = String(a.ext || path.extname(name)).toLowerCase();
  if (!DONATE_ALL_EXTS.has(ext)) return null;
  return {
    id, name, ext,
    mime: MIME[ext] || 'application/octet-stream',
    size: _int(a.size, 0, 5 * 1024 * 1024 * 1024, 0),
    // 'text' was typed into the browser editor, 'scan' is a photographed page,
    // 'file' is anything else uploaded. Only the label differs — all three are
    // ordinary files on disk under the donation's staging folder.
    kind: a.kind === 'text' ? 'text' : (a.kind === 'scan' ? 'scan' : 'file'),
    added: _str(a.added, 40),
  };
}

function normDonation(d) {
  if (!d || typeof d !== 'object') return null;
  const id = _id(d.id); if (!id) return null;
  const from = _str(d.from, 32); if (!from) return null;
  const items = _list(d.items).slice(0, DONATE_MAX_ITEMS).map(normDonationItem).filter(Boolean);
  const status = DONATE_STATUSES.includes(d.status) ? d.status : 'draft';
  return {
    id, from, status,
    created: _str(d.created, 40),
    title:   _str(d.title, 160),
    message: _multi(d.message, 4000),
    // The donor's *suggestions*. `lang` may be blank — "I don't know" is a valid
    // answer and the admin fills it in.
    lang:       (d.lang === 'en' || d.lang === 'hu') ? d.lang : '',
    suggestPath: _str(d.suggestPath, 512),
    // Snapshot of the timetable subject the donation came from, so the queue still
    // reads correctly after the timetable is rewritten — same reasoning as a
    // logged lesson keeping its own subject name.
    subjectId:   _id(d.subjectId),
    subjectName: _str(d.subjectName, 80),
    subjectHu:   _str(d.subjectHu, 80),
    items,
    decided:   _str(d.decided, 40),
    decidedBy: _str(d.decidedBy, 32),
    reason:    _multi(d.reason, 2000),
    result:    (d.result && typeof d.result === 'object' && _str(d.result.path, 512))
      ? { path: _str(d.result.path, 512), lang: _lang(d.result.lang) } : null,
  };
}

function loadDonations() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(__DONATIONS, 'utf8')); } catch {}
  const list = (raw && Array.isArray(raw.donations)) ? raw.donations : (Array.isArray(raw) ? raw : []);
  return list.map(normDonation).filter(Boolean);
}
function saveDonations(list) {
  // Newest first, and the decided tail is trimmed so an old archive cannot grow
  // the file without bound. Pending records are never trimmed — they are work.
  const sorted = list.slice().sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const pending = sorted.filter(d => d.status === 'pending' || d.status === 'draft');
  const rest    = sorted.filter(d => d.status !== 'pending' && d.status !== 'draft');
  const keep    = [...pending, ...rest.slice(0, Math.max(0, DONATE_MAX_RECORDS - pending.length))];
  for (const d of rest.slice(Math.max(0, DONATE_MAX_RECORDS - pending.length))) {
    try { rmDirSync(donationDir(d.id)); } catch {}
  }
  writeFileAtomic(__DONATIONS, JSON.stringify({ donations: keep }, null, 2) + '\n');
  return keep;
}
function findDonation(list, id) { const i = _id(id); return i ? (list.find(d => d.id === i) || null) : null; }
function donationItem(d, itemId) { const i = _id(itemId); return (d && i) ? ((d.items || []).find(x => x.id === i) || null) : null; }
function isDonationOwner(d, s) { return !!(d && s && String(d.from).toLowerCase() === String(s.username).toLowerCase()); }
// A donation is readable by its donor and by any admin — nobody else, at any status.
function canSeeDonation(d, req) {
  if (!d) return false;
  if (adminActor(req)) return true;
  return isDonationOwner(d, siteSession(req));
}
// What a donor is allowed to learn about their own submission. Deliberately does
// not echo the reviewing admin's name — the decision is the site's, not a person's.
function publicDonation(d) {
  return {
    id: d.id, status: d.status, created: d.created, title: d.title, message: d.message,
    lang: d.lang, suggestPath: d.suggestPath, subjectId: d.subjectId,
    subjectName: d.subjectName, subjectHu: d.subjectHu,
    items: (d.items || []).map(i => ({ id: i.id, name: i.name, ext: i.ext, size: i.size, kind: i.kind })),
    decided: d.decided, reason: d.reason, result: d.result,
  };
}
function countPending(list, userLc) {
  return list.filter(d => d.status === 'pending' && (!userLc || String(d.from).toLowerCase() === userLc)).length;
}
// A draft that was never submitted leaves a staging folder behind, exactly like an
// unsaved day does. Same 24-hour rule, so an upload in progress is never collected.
function sweepOrphanDonationFiles() {
  let dirs; try { dirs = fs.readdirSync(__DONATION_FILES, { withFileTypes: true }); } catch { return 0; }
  const list = loadDonations();
  const live = new Set(list.filter(d => d.status !== 'declined' && d.status !== 'withdrawn').map(d => d.id));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  for (const e of dirs) {
    if (!e.isDirectory() || live.has(e.name)) continue;
    let st; try { st = fs.statSync(path.join(__DONATION_FILES, e.name)); } catch { continue; }
    if (st.mtimeMs > cutoff) continue;
    rmDirSync(path.join(__DONATION_FILES, e.name)); removed++;
  }
  // Drafts are only half-real: they exist so an upload has somewhere to go before
  // the donor presses Submit. One that is a day old was abandoned.
  const staleDrafts = list.filter(d => d.status === 'draft' && Date.parse(d.created || '') < cutoff);
  if (staleDrafts.length) {
    const ids = new Set(staleDrafts.map(d => d.id));
    for (const id of ids) { try { rmDirSync(donationDir(id)); } catch {} }
    saveDonations(list.filter(d => !ids.has(d.id)));
    removed += ids.size;
  }
  return removed;
}

// Post a card into every admin's inbox, the way an access request reaches a note's
// owners. The chat store is the site's only notification channel — there is no mail
// server — so a donation that does not land here is a donation nobody hears about.
function postDonationCard(donation) {
  const admins = loadAdmins().map(a => a.username).filter(u => String(u).toLowerCase() !== String(donation.from).toLowerCase());
  if (!admins.length) return;
  const chats = loadChats();
  const now = new Date().toISOString();
  for (const to of admins) {
    const c = ensureDM(chats, donation.from, to);
    c.messages.push({
      id: crypto.randomUUID(), from: donation.from, kind: 'donation', status: 'pending',
      donation: { id: donation.id, title: donation.title, items: (donation.items || []).length,
        subject: donation.subjectName || '' },
      body: donation.message || '', date: now,
    });
    c.reads = c.reads || {};
    c.reads[String(donation.from).toLowerCase()] = now;
  }
  try { saveChats(chats); } catch {}
}
// Close out every pending card for a donation and tell the donor what happened.
// Each admin holds their own copy of the card, so all of them are settled at once —
// otherwise the other admins keep looking at a decision that was already made.
function settleDonationCards(donation, decision, reason, actor) {
  const chats = loadChats();
  const now = new Date().toISOString();
  const fromLc = String(donation.from).toLowerCase();
  let touched = false, told = false;
  for (const c of chats.conversations) {
    if (!chatParticipant(c, donation.from)) continue;
    for (const m of c.messages || []) {
      if (m.kind !== 'donation' || m.status !== 'pending') continue;
      if (!m.donation || m.donation.id !== donation.id) continue;
      m.status = decision; touched = true;
      // Only the conversation with the deciding admin gets the result card, so the
      // donor is told once rather than once per admin.
      if (!told && decision !== 'withdrawn' && chatParticipant(c, actor)) {
        c.messages.push({
          id: crypto.randomUUID(), from: actor, kind: 'donation-result', decision,
          donation: { id: donation.id, title: donation.title },
          note: donation.result ? { path: donation.result.path, lang: donation.result.lang, label: stripDisplayName(path.basename(donation.result.path)) } : null,
          reason: reason || '', body: reason || '', date: now,
        });
        told = true;
      }
    }
  }
  if (touched) { try { saveChats(chats); } catch {} }
}

// Account-name and password rules, shared by public sign-up and admin user
// creation so an account can never exist that one of them would have refused.
// Mirrors make-admin.js / make-user.js.
const USERNAME_RE  = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;

// Password-reset state. Both maps are memory-only on purpose: a token that dies
// with the process is a token that cannot be stolen off disk, and the durable half
// of the flow (the request card) lives in chats.json anyway.
const PW_RESET_TOKENS   = new Map();               // token -> { userLc, username, expires }
const PW_RESET_ASKED    = new Map();               // usernameLc -> last request time
const PW_RESET_TTL      = Math.max(60000, Number(process.env.PW_RESET_TTL_MS) || 30 * 60 * 1000);
const PW_RESET_COOLDOWN = Math.max(60000, Number(process.env.PW_RESET_COOLDOWN_MS) || 60 * 60 * 1000);
const PW_RESET_MAX_PENDING = 20;                   // stops mass enumeration filling admin inboxes

// A fixed dummy salt so a login attempt for a non-existent user still spends
// ~the same time hashing — closes the username-enumeration timing side channel.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
function scryptAsync(password, salt, len) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, len, (err, dk) => err ? reject(err) : resolve(dk));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk   = await scryptAsync(String(password), salt, 32);
  return { salt, hash: dk.toString('hex') };
}
// Constant-time credential check against a list of { username, salt, hash }.
// Runs scrypt even on a miss (against DUMMY_SALT) to avoid timing enumeration.
async function verifyAgainst(records, username, password) {
  const rec = (records || []).find(a =>
    a && a.username && String(a.username).toLowerCase() === String(username || '').toLowerCase());
  const salt = (rec && rec.salt) ? rec.salt : DUMMY_SALT;
  let derived;
  try { derived = await scryptAsync(String(password || ''), salt, 32); }
  catch { return null; }
  if (!rec || !rec.salt || !rec.hash || !username || !password) return null;
  let stored;
  try { stored = Buffer.from(rec.hash, 'hex'); } catch { return null; }
  if (derived.length !== stored.length) return null;
  return crypto.timingSafeEqual(derived, stored) ? rec : null;
}
async function verifyAdmin(username, password) { return verifyAgainst(loadAdmins(), username, password); }
async function verifyUser(username, password)  { return verifyAgainst(loadUsers(),  username, password); }

// ── Sessions ──────────────────────────────────────────────────────────────────
// One token store for both surfaces; each session carries a role.
//   role 'admin' → DevTools authoring (sent via the X-Admin-Token header)
//   any role      → site sign-in for member-only notes (cookie or X-Auth-Token)
const SESSIONS    = new Map();              // token -> { username, role, expires }
const SESSION_TTL = 8 * 60 * 60 * 1000;     // 8 hours
function createSession(username, role = 'admin') {
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(token, { username, role, expires: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { SESSIONS.delete(token); return null; }
  return s;
}
// Drop every live session for an account (optionally sparing one token).
// Sessions are the only thing standing between a removed account and the site:
// deleting the row in users.json does nothing to a browser that already holds a
// token, so without this a deleted member stays signed in for up to eight hours,
// still reading members-only notes and posting in chats. Same for a password
// change — the point of changing it is to lock out whoever else had the old one.
function revokeSessions(username, exceptToken) {
  const n = String(username || '').toLowerCase();
  if (!n) return 0;
  let gone = 0;
  for (const [tok, s] of SESSIONS) {
    if (tok === exceptToken) continue;
    if (s && String(s.username).toLowerCase() === n) { SESSIONS.delete(tok); gone++; }
  }
  return gone;
}
function parseCookies(req) {
  const out = {};
  const raw = (req.headers && req.headers.cookie) || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} }
  });
  return out;
}
const SITE_COOKIE = 'ki_auth';
// DevTools admin session (header only; must be an admin role)
function sessionUser(req) {
  const s = getSession((req.headers && req.headers['x-admin-token']) || '');
  return s && s.role === 'admin' ? s.username : null;
}
function requireAdmin(req, res) {
  const u = sessionUser(req);
  if (!u) { sendJSON(res, { ok: false, error: 'unauthorized' }, 401); return null; }
  return u;
}
// Admin identity from *either* credential: the DevTools header token, or a site
// session whose role is admin. Used by the handful of admin actions that are
// reached from the site rather than from DevTools — logging a lesson off the
// timetable grid, issuing a password-reset link from a chat card — where forcing
// the operator to go and open DevTools would simply mean the job never gets done.
// It is the same account either way; only the transport differs, and the site
// cookie is HttpOnly + SameSite=Lax so these POSTs are not reachable cross-site.
function adminActor(req) {
  const viaHeader = sessionUser(req);
  if (viaHeader) return viaHeader;
  const s = siteSession(req);
  return (s && s.role === 'admin') ? s.username : null;
}
function requireAdminEither(req, res) {
  const u = adminActor(req);
  if (!u) { sendJSON(res, { ok: false, error: 'unauthorized' }, 401); return null; }
  return u;
}
// Site session — cookie first (so <img>/<video>/downloads carry it), then header
function siteSession(req) {
  return getSession((req.headers && req.headers['x-auth-token']) || '')
      || getSession(parseCookies(req)[SITE_COOKIE] || '');
}
function isLoggedIn(req) { return !!siteSession(req); }
// X-Forwarded-* are only trusted from configured proxy IPs (env TRUSTED_PROXIES,
// comma-separated). Otherwise a client could spoof them to bypass rate limits.
const TRUSTED_PROXIES = new Set((process.env.TRUSTED_PROXIES || '').split(',').map(x => x.trim()).filter(Boolean));
function directIp(req) {
  return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '';
}
function reqIsHttps(req) {
  if (TRUSTED_PROXIES.has(directIp(req)) && req.headers && req.headers['x-forwarded-proto'] === 'https') return true;
  return !!(req.socket && req.socket.encrypted) || !!(req.connection && req.connection.encrypted);
}
function setCookie(req, token) {
  return `${SITE_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax; HttpOnly`
       + (reqIsHttps(req) ? '; Secure' : '');
}
function clearCookie(req) {
  return `${SITE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`
       + (reqIsHttps(req) ? '; Secure' : '');
}
// Tiny in-memory rate limiter to blunt brute-force / abuse on auth endpoints.
const RL = new Map();
function clientIp(req) {
  const direct = directIp(req) || 'unknown';
  if (TRUSTED_PROXIES.has(direct)) {
    const xf = ((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return direct;
}
function rateOk(req, bucket, limit, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  let r = RL.get(key);
  if (!r || r.reset < now) { r = { count: 0, reset: now + windowMs }; RL.set(key, r); }
  r.count++;
  return r.count <= limit;
}
// Neither map ever shrank on its own: expired sessions were only dropped when the
// same token was presented again, and every distinct client IP left a permanent
// rate-limit entry. On a long-running server both grew without bound.
setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of SESSIONS) if (!s || s.expires < now) SESSIONS.delete(tok);
  for (const [k, r] of RL) if (!r || r.reset < now) RL.delete(k);
  for (const [tok, v] of PW_RESET_TOKENS) if (!v || v.expires < now) PW_RESET_TOKENS.delete(tok);
  for (const [u, t] of _presence) if (now - t > 24 * 60 * 60 * 1000) _presence.delete(u);
}, 10 * 60 * 1000).unref();

// ── data.txt serialization (DevTools authoring) ───────────────────────────────
const DATA_TXT_HEADER =
  '# Managed by Digitalization DevTools.\n' +
  '# Each [Section] header is a note display name (filename without extension or {tags}).\n' +
  '# Keys: tags, authors, date, material-start, material-end, updated, important, visibility (public|members|request), allow, description, alt-hu, alt-en\n' +
  '#   visibility=request: note is visible but content is locked; allow = owner usernames who receive read-requests.\n';

function serializeDataTxt(sections) {
  let out = DATA_TXT_HEADER + '\n';
  for (const [name, meta] of Object.entries(sections || {})) {
    if (!name || !meta) continue;
    // Values already have their newlines flattened below; do the same for the
    // section header (and drop the bracket that closes it) so no field a caller
    // controls can ever open a second [Section] and rewrite a neighbouring note's
    // access rules. Nothing legitimate puts a newline or a ']' in a display name.
    const secName = String(name).replace(/[\r\n\]]/g, ' ').trim();
    if (!secName) continue;
    out += `[${secName}]\n`;
    const order   = ['tags', 'authors', 'date', 'material_start', 'material_end', 'updated', 'important', 'visibility', 'allow', 'can_see', 'can_read', 'read_requests', 'see_allow', 'read_allow', 'owners', 'description', 'alt_hu', 'alt_en'];
    const keyName = { material_start: 'material-start', material_end: 'material-end', alt_hu: 'alt-hu', alt_en: 'alt-en', can_see: 'can-see', can_read: 'can-read', read_requests: 'read-requests', see_allow: 'see-allow', read_allow: 'read-allow' };
    for (const k of order) {
      let v = meta[k];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) v = v.join(', ');
      if (k === 'important' || k === 'read_requests') { if (v === true || v === 'true') v = 'true'; else continue; }
      if (k === 'visibility') { if (v !== 'members' && v !== 'request') continue; }
      if (k === 'can_see' || k === 'can_read') { if (v !== 'members' && v !== 'whitelist') continue; }
      if (k === 'allow' || k === 'see_allow' || k === 'read_allow' || k === 'owners') { if (v && String(v).trim()) v = String(v).trim(); else continue; }
      out += `${keyName[k] || k}: ${String(v).replace(/\r?\n/g, ' ').trim()}\n`;
    }
    out += '\n';
  }
  return out;
}

function adminDataDir(lang) { return lang === 'hu' ? __DATA_HU : __DATA; }

// Lightweight tree (folders + text-note files) for the DevTools browser / picker
const TEXT_NOTE_EXTS = new Set(['.tex', '.md', '.txt', '.bib', '.sty', '.cls']);
function adminBrowse(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const secs = parseDataTxt(dir);
  const out = [];
  for (const e of entries) {
    if (e.name === 'data.txt') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      let count = 0;
      try { count = fs.readdirSync(path.join(dir, e.name)).filter(n => n !== 'data.txt').length; } catch {}
      const _fm = folderMeta(path.join(dir, e.name));
      out.push({ type: 'folder', name: e.name, path: childRel, display: stripDisplayName(e.name), count, altHu: _fm.alt_hu || null, altEn: _fm.alt_en || null });
    } else {
      const m = fileMeta(dir, e.name, secs);
      out.push({ type: 'file', name: e.name, path: childRel, display: stripDisplayName(e.name),
        ext: path.extname(e.name).toLowerCase(), size: m.size,
        tags: m.tags, authors: m.authors, date: m.date, important: m.important,
        description: m.description, altHu: m.altHu, altEn: m.altEn, canSee: m.canSee, canRead: m.canRead, readRequests: m.readRequests, seeWhitelist: m.seeWhitelist, readWhitelist: m.readWhitelist, owners: m.owners,
        editable: TEXT_NOTE_EXTS.has(path.extname(e.name).toLowerCase()) });
    }
  }
  out.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1)
    : a.name.localeCompare(b.name, undefined, { numeric: true })));
  return out;
}


// ── Music ─────────────────────────────────────────────────────────────────────
function listMusic() {
  if (!fs.existsSync(__MUSIC)) return [];
  const exts = new Set(['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac']);
  const result = [];
  function walk(dir, rel) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
      if (exts.has(path.extname(e.name).toLowerCase())) {
        let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
        result.push({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, ext: path.extname(e.name), size });
      }
    }
  }
  walk(__MUSIC, '');
  return result;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  // Security headers on every response (defense-in-depth for a public repo).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS only once the connection actually is HTTPS (direct TLS, or a trusted
  // proxy saying so). Sending it over plain HTTP would pin a local/dev host to a
  // scheme it cannot serve. Set HSTS_MAX_AGE=0 to opt out entirely.
  if (reqIsHttps(req) && HSTS_MAX_AGE > 0)
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
  // Per-request nonce: the app shell (index.html / devtools.html) uses a strict
  // nonce-based script-src with NO 'unsafe-inline'; article pages keep 'unsafe-inline'
  // because they are admin-authored documents that may carry inline scripts/handlers.
  const _cspNonce = crypto.randomBytes(16).toString('base64');
  res._cspNonce = _cspNonce;
  let _cspPath = '/';
  try { _cspPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { _cspPath = (req.url || '/').split('?')[0]; }
  // The 404 page cannot be listed here — it is served *as* whatever address missed,
  // so its path is never known in advance. It carries one tiny inline script, which
  // `notFoundPage` stamps with this same nonce, so it runs under either policy.
  const _cspShell = (_cspPath === '/' || _cspPath === '/index.html' || _cspPath === '/devtools' || _cspPath === '/devtools/' || _cspPath === '/devtools.html');
  const _scriptSrc = _cspShell
    ? `script-src 'self' 'nonce-${_cspNonce}' https://cdnjs.cloudflare.com`
    : "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com";
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    _scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob:",
    // frame-src would otherwise fall back to default-src ('self'), which blocks the
    // blob: URL the donation review builds to show a freshly compiled preview. The
    // blob is created by our own script from our own response, so this admits
    // nothing a script could not already reach.
    "frame-src 'self' blob:",
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "connect-src 'self' https://cdnjs.cloudflare.com",
    "frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'",
  ].join('; '));

  if (req.method === 'OPTIONS') {
    if (CORS_ORIGIN) res.writeHead(204, cors({ 'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token, X-Admin-Token' }));
    else res.writeHead(204);
    return res.end();
  }

  if (pathname === '/devtools' || pathname === '/devtools/')
    return serveHtmlShell(res, req, path.join(__WEBSITE, 'devtools.html'));

  // Crawlers: index the public archive, but never the API, the admin console, the
  // raw note files or the day-log uploads — those are access-checked per request
  // and have no business in a search index even when they happen to be public.
  if (pathname === '/robots.txt') {
    const lines = ['User-agent: *'];
    for (const d of ['/api/', '/devtools', '/uploads/', '/data/', '/music/']) lines.push('Disallow: ' + d);
    lines.push('Allow: /');
    if (process.env.SITE_ORIGIN) lines.push('', 'Sitemap: ' + String(process.env.SITE_ORIGIN).replace(/\/+$/, '') + '/sitemap.xml');
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    res.writeHead(200, cors({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) }));
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  if (pathname === '/api/compile' && req.method === 'POST') return handleCompile(req, res);

  // Tree
  if (pathname === '/api/tree') {
    const matLang = query.mat_lang || 'en';
    let children;
    if (!HAS_DUAL_LANG) {
      // Single data dir — always serve from __DATA regardless of matLang
      children = buildSoloTree(__DATA, null, 'en');
    } else if (matLang === 'hu') {
      children = buildSoloTree(__DATA_HU, __DATA, 'hu');
    } else if (matLang === 'both') {
      children = buildMergedTree(__DATA, __DATA_HU);
    } else {
      children = buildSoloTree(__DATA, __DATA_HU, 'en');
    }
    const _viewer = siteSession(req);
    children = filterTreeForVisibility(children, _viewer);
    annotateLocks(children, req, matLang);
    return sendJSON(res, { name: 'root', type: 'folder', path: '', children, count: children.length, hasDualLang: HAS_DUAL_LANG, loggedIn: !!_viewer });
  }

  // Resolve a note's other-language counterpart for the PDF viewer's EN/HU switch.
  // Tries the same relative path in the other dir, then a permissive same-display-name
  // search — so the switch works even when the tree didn't pair the note's folder chain.
  if (pathname === '/api/note/counterpart') {
    const lang = query.lang === 'hu' ? 'hu' : 'en';
    const p = String(query.path || '');
    if (!p || !HAS_DUAL_LANG) return sendJSON(res, { ok: true, none: true });
    const otherDir = lang === 'en' ? __DATA_HU : __DATA;
    const otherLang = lang === 'en' ? 'hu' : 'en';
    let found = null;
    try { const full = safePath(otherDir, p); if (fs.existsSync(full) && fs.statSync(full).isFile()) found = { path: p.replace(/\\/g, '/'), name: path.basename(p) }; } catch {}
    if (!found) { try { found = findFileByDisplay(otherDir, nkey(stripDisplayName(path.basename(p)))); } catch {} }
    if (!found) return sendJSON(res, { ok: true, none: true });
    // Respect visibility: don't reveal a counterpart the viewer can't see.
    if (!canViewNote(req, found.path, otherLang)) return sendJSON(res, { ok: true, none: true });
    return sendJSON(res, { ok: true, lang: otherLang, path: found.path, name: found.name });
  }

  // Articles
  if (pathname === '/api/articles') {
    const articlesDir = (query.lang === 'hu' && fs.existsSync(__ARTICLES_HU)) ? __ARTICLES_HU : __ARTICLES;
    const out = [];
    let entries = []; try { entries = fs.readdirSync(articlesDir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isFile() && /\.html?$/i.test(e.name)) {
        let raw = ''; try { raw = fs.readFileSync(path.join(articlesDir, e.name), 'utf8'); } catch {}
        out.push({ file: e.name, kind: 'file', ...articleMetaFromHtml(raw, e.name.replace(/\.html?$/i, '').replace(/[-_]/g, ' ')) });
      } else if (e.isDirectory()) {
        const idx = path.join(articlesDir, e.name, 'index.html');
        if (fs.existsSync(idx)) {
          let raw = ''; try { raw = fs.readFileSync(idx, 'utf8'); } catch {}
          out.push({ file: e.name + '/index.html', kind: 'folder', folder: e.name, ...articleMetaFromHtml(raw, e.name.replace(/[-_]/g, ' ')) });
        }
      }
    }
    out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return sendJSON(res, out);
  }

  // File source
  if (pathname === '/api/file') {
    if (!query.path) { res.writeHead(400); return res.end('Missing path'); }
    // data.txt is folder *metadata* (whitelists, owner usernames, per-note access) and
    // must never be readable as a note — /data/ already blocks it, this route did not.
    if (/(^|\/)data\.txt$/i.test(String(query.path))) { res.writeHead(404); return res.end('Not Found'); }
    const fileDir = (query.lang === 'hu' && HAS_DUAL_LANG) ? __DATA_HU : __DATA;
    let full; try { full = safePath(fileDir, query.path); } catch { res.writeHead(403); return res.end('Forbidden'); }
    if (!canViewNote(req, query.path, query.lang)) { res.writeHead(403); return res.end('Sign-in required'); }
    let content; try { content = fs.readFileSync(full, 'utf8'); } catch { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(content);
  }

  // ── Search inside the notes themselves ──────────────────────────────────────
  // The grid's own search covers filename, tags, authors, path and description —
  // everything *about* a note but nothing *in* it, which is backwards for an
  // archive you search by remembering a theorem rather than a filename.
  // Results are filtered by canViewNote, so a match never reveals a note you
  // cannot open, and the snippet is drawn from a file you are allowed to read.
  if (pathname === '/api/search' && req.method === 'GET') {
    const q = String(query.q || '').trim();
    if (q.length < 2) return sendJSON(res, { ok: true, q, results: [], truncated: false });
    if (!rateOk(req, 'search', 120, 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many searches.' }, 429);
    const needle = q.toLowerCase().slice(0, 120);
    const wantLang = query.lang === 'hu' ? 'hu' : (query.lang === 'both' ? 'both' : 'en');
    const langs = [];
    if (wantLang === 'both') { langs.push(['en', __DATA]); if (HAS_DUAL_LANG) langs.push(['hu', __DATA_HU]); }
    else if (wantLang === 'hu' && HAS_DUAL_LANG) langs.push(['hu', __DATA_HU]);
    else langs.push(['en', __DATA]);

    const results = [];
    let scanned = 0, truncated = false;
    outer:
    for (const [lang, baseDir] of langs) {
      const stack = [[baseDir, '']];
      while (stack.length) {
        const [dir, rel] = stack.pop();
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) { stack.push([path.join(dir, e.name), childRel]); continue; }
          if (e.name === 'data.txt') continue;
          if (!SEARCHABLE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
          if (results.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) { truncated = true; break outer; }
          scanned++;
          const text = readNoteText(path.join(dir, e.name));
          if (!text) continue;
          const at = text.toLowerCase().indexOf(needle);
          if (at < 0) continue;
          if (!canViewNote(req, childRel, lang)) continue;      // never hint at a note you cannot open
          // Count matches and cut a readable snippet around the first one.
          let hits = 0, from = 0;
          for (;;) { const k = text.toLowerCase().indexOf(needle, from); if (k < 0 || hits >= 999) break; hits++; from = k + needle.length; }
          const s = Math.max(0, at - 60), en = Math.min(text.length, at + needle.length + 90);
          const snippet = (s > 0 ? '…' : '') + text.slice(s, en).replace(/\s+/g, ' ').trim() + (en < text.length ? '…' : '');
          const line = text.slice(0, at).split('\n').length;
          results.push({ path: childRel, name: e.name, display: stripDisplayName(e.name), lang,
            folder: rel || '', snippet, line, hits, ext: path.extname(e.name).toLowerCase() });
        }
      }
    }
    results.sort((a, b) => (b.hits - a.hits) || a.display.localeCompare(b.display, undefined, { numeric: true }));
    return sendJSON(res, { ok: true, q, results, truncated });
  }

  // Precompile start
  if (pathname === '/api/precompile/start' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    if (!rateOk(req, 'precompile', 60, 5 * 60 * 1000)) return sendJSON(res, { error: 'Too many requests.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      try { const { paths, lang } = JSON.parse(body); if (!Array.isArray(paths)) { res.writeHead(400); return res.end('paths must be array'); }
        let q = 0; for (const p of paths) { if (typeof p === 'string' && enqueuePrecompile(p, lang || 'en')) q++; } sendJSON(res, { queued: q });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // Precompile folder — public (the Settings panel's "Compile all now" warms the
  // cache for the visitor), but it may only ever queue notes that visitor is
  // actually allowed to open. Queuing every note in the archive would both fork a
  // pdflatex run per private note and turn an anonymous POST into an expensive,
  // repeatable job; the rate limit is tight because one call can enqueue hundreds.
  if (pathname === '/api/precompile/folder' && req.method === 'POST') {
    if (!rateOk(req, 'precompile', 10, 5 * 60 * 1000)) return sendJSON(res, { error: 'Too many requests.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const { folderPath, lang } = JSON.parse(body); const l = lang === 'hu' ? 'hu' : 'en';
        const dataDir = l === 'hu' ? __DATA_HU : __DATA;
        if (!fs.existsSync(dataDir)) return sendJSON(res, { queued: 0 });
        let fullFolder; try { fullFolder = safePath(dataDir, folderPath || ''); } catch { res.writeHead(403); return res.end('Forbidden'); }
        let count = 0;
        function walk(dir, rel) {
          let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
            if (path.extname(e.name).toLowerCase() !== '.tex') continue;
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (!canViewNote(req, relPath, l)) continue;
            if (enqueuePrecompile(relPath, l)) count++;
          }
        }
        walk(fullFolder, folderPath || '');
        sendJSON(res, { queued: count });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // Precompile status. The per-note map is admin-only: its keys are the full paths
  // of every note the background pass has touched, which for an anonymous caller
  // would list members-only and whitelist-restricted notes that /api/tree is at
  // pains to hide. The Settings panel only ever reads `queue` and `running`.
  if (pathname === '/api/precompile/status') {
    const out = { queue: preQueue.length, running: preRunning };
    if (sessionUser(req)) out.status = preStatus;
    return sendJSON(res, out);
  }

  // Changelog
  if (pathname === '/api/changelog' && req.method === 'GET') return sendJSON(res, readChangelog());
  if (pathname === '/api/changelog/add' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 262144) req.destroy(); });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body); if (!entry.title) { res.writeHead(400); return res.end('title required'); }
        entry.id = crypto.randomUUID(); entry.date = entry.date || new Date().toISOString().slice(0,10);
        const log = readChangelog(); log.unshift(entry); writeChangelog(log);
        sendJSON(res, { ok: true, id: entry.id });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }
  if (pathname === '/api/changelog/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try { const { id } = JSON.parse(body); writeChangelog(readChangelog().filter(e => e.id !== id)); sendJSON(res, { ok: true }); }
      catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // ── Admin: articles (create / edit / delete) ───────────────────────────────
  if (pathname === '/api/admin/article/list' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const lang = query.lang === 'hu' ? 'hu' : 'en';
    const dir = (lang === 'hu') ? __ARTICLES_HU : __ARTICLES;
    const items = [];
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isFile() && /\.html?$/i.test(e.name)) {
        let raw = ''; try { raw = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch {}
        items.push({ kind: 'file', path: e.name, ...articleMetaFromHtml(raw, e.name) });
      } else if (e.isDirectory()) {
        const files = walkArticleFolder(path.join(dir, e.name), e.name);
        const idx = files.find(f => /(^|\/)index\.html$/i.test(f));
        let meta = { title: e.name, date: null, description: '', tags: [] };
        if (idx) { let raw = ''; try { raw = fs.readFileSync(path.join(dir, idx), 'utf8'); } catch {} meta = articleMetaFromHtml(raw, e.name); }
        items.push({ kind: 'folder', path: e.name, hasIndex: !!idx, files, ...meta });
      }
    }
    return sendJSON(res, { ok: true, lang, exists: fs.existsSync(dir), items });
  }
  if (pathname === '/api/admin/article/read' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const lang = query.lang === 'hu' ? 'hu' : 'en';
    const dir = (lang === 'hu') ? __ARTICLES_HU : __ARTICLES;
    let full; try { full = safePath(dir, query.path || ''); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
    let content = ''; try { content = fs.readFileSync(full, 'utf8'); } catch { return sendJSON(res, { ok: false, error: 'not found' }, 404); }
    return sendJSON(res, { ok: true, content });
  }
  if (pathname === '/api/admin/article/save' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 4194304) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      const dir = articlesDirFor(lang, true);
      const target = String(j.target || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (!target) return sendJSON(res, { ok: false, error: 'Missing target path.' }, 400);
      const segs = target.split('/').filter(Boolean);
      if (segs.some(g => g === '.' || g === '..' || g.startsWith('.') || !/^[A-Za-z0-9 ._-]+$/.test(g)))
        return sendJSON(res, { ok: false, error: 'Names may use letters, numbers, spaces, dot, dash, underscore (no leading dot).' }, 400);
      const ext = (target.match(/\.[^.\/]+$/) || [''])[0].toLowerCase();
      if (!ARTICLE_EXTS.has(ext)) return sendJSON(res, { ok: false, error: 'File type not allowed: ' + (ext || '(none)') }, 400);
      let full; try { full = safePath(dir, target); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      let outHtml;
      if (j.mode === 'template') outHtml = buildArticleFromTemplate(j.meta || {}, j.body || '', lang);
      else outHtml = String(j.content != null ? j.content : (j.html || ''));
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, outHtml, 'utf8');
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, file: target });
    });
    return;
  }
  if (pathname === '/api/admin/article/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      const dir = (lang === 'hu') ? __ARTICLES_HU : __ARTICLES;
      let full; try { full = safePath(dir, String(j.path || '')); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      if (full === path.normalize(dir)) return sendJSON(res, { ok: false, error: 'refusing to delete the articles root' }, 400);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
        else fs.unlinkSync(full);
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Admin: auth ─────────────────────────────────────────────────────────────
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    // This is the highest-value credential on the server and it had no brute-force
    // limit at all, while /api/login (which also accepts admin credentials) did —
    // so an attacker could simply guess here instead. Its own bucket, not the
    // 'login' one: sharing would let a member fumbling their password lock the
    // owner out of DevTools, and 20 admin guesses per 10 minutes already ends
    // brute force as an attack.
    if (!rateOk(req, 'adminlogin', 20, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let u, p;
      try { const j = JSON.parse(body); u = j.username; p = j.password; }
      catch { res.writeHead(400); return res.end('Bad JSON'); }
      const rec = await verifyAdmin(u, p);
      if (!rec) return sendJSON(res, { ok: false, error: 'invalid credentials' }, 401);
      const token = createSession(rec.username);
      return sendJSON(res, { ok: true, token, username: rec.username });
    });
    return;
  }
  if (pathname === '/api/admin/me' && req.method === 'GET') {
    const u = sessionUser(req);
    return sendJSON(res, { ok: !!u, username: u || null, hasDualLang: HAS_DUAL_LANG });
  }
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    SESSIONS.delete((req.headers && req.headers['x-admin-token']) || '');
    return sendJSON(res, { ok: true });
  }

  // ── Admin: browse a language's data tree (folders + text notes) ─────────────
  if (pathname === '/api/admin/browse' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const lang = query.lang === 'hu' ? 'hu' : 'en';
    const base = adminDataDir(lang);
    if (!fs.existsSync(base))
      return sendJSON(res, { ok: true, lang, dir: query.dir || '', items: [], missing: true });
    let full; try { full = safePath(base, query.dir || ''); }
    catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
    return sendJSON(res, { ok: true, lang, dir: query.dir || '', items: adminBrowse(full, query.dir || '') });
  }

  // ── Admin: read / write a folder's data.txt ─────────────────────────────────
  if (pathname === '/api/admin/datatxt' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const lang = query.lang === 'hu' ? 'hu' : 'en';
    let full; try { full = safePath(adminDataDir(lang), query.dir || ''); }
    catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
    let raw = ''; try { raw = fs.readFileSync(path.join(full, 'data.txt'), 'utf8'); } catch {}
    return sendJSON(res, { ok: true, lang, dir: query.dir || '', sections: parseDataTxt(full), raw });
  }
  if (pathname === '/api/admin/datatxt' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      let full; try { full = safePath(adminDataDir(lang), j.dir || ''); }
      catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try {
        fs.mkdirSync(full, { recursive: true });
        writeDataTxt(full, j.sections || {});
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Admin: create / overwrite a text note + merge its metadata ──────────────
  if (pathname === '/api/admin/note' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8 * 1048576) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      const base = adminDataDir(lang);
      let filename = String(j.filename || '').trim();
      if (!filename) return sendJSON(res, { ok: false, error: 'filename required' }, 400);
      if (/[\\/]/.test(filename)) return sendJSON(res, { ok: false, error: 'filename cannot contain slashes' }, 400);
      if (!path.extname(filename)) filename += '.tex';
      const ext = path.extname(filename).toLowerCase();
      if (!TEXT_NOTE_EXTS.has(ext)) return sendJSON(res, { ok: false, error: 'unsupported note type ' + ext }, 400);
      let folderFull, fileFull;
      try { folderFull = safePath(base, j.dir || ''); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try { fileFull = safePath(folderFull, filename); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try {
        fs.mkdirSync(folderFull, { recursive: true });
        if (typeof j.content === 'string') fs.writeFileSync(fileFull, j.content, 'utf8');
        else if (!fs.existsSync(fileFull)) fs.writeFileSync(fileFull, '', 'utf8');
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      if (j.meta) {
        const secs    = parseDataTxtMutable(folderFull);
        const display = stripDisplayName(filename);
        // drop any prior section that maps to the same display name
        for (const k of Object.keys(secs))
          if (stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase()) delete secs[k];
        const _m = j.meta;
        const _useNew = ['canSee', 'canRead', 'readRequests', 'seeAllow', 'readAllow', 'owners'].some(k => k in _m);
        const sec = {
          tags: _m.tags, authors: _m.authors, date: _m.date,
          important: _m.important, description: _m.description,
          alt_hu: _m.altHu, alt_en: _m.altEn,
        };
        if (_useNew) {
          sec.can_see = (_m.canSee === 'members' || _m.canSee === 'whitelist') ? _m.canSee : 'all';
          sec.can_read = (_m.canRead === 'members' || _m.canRead === 'whitelist') ? _m.canRead : 'all';
          sec.read_requests = _m.readRequests ? 'true' : '';
          sec.see_allow = _m.seeAllow || '';
          sec.read_allow = _m.readAllow || '';
          sec.owners = _m.owners || '';
        } else {
          sec.visibility = _m.visibility;
          sec.allow = _m.allow;
        }
        secs[display] = sec;
        try { writeDataTxt(folderFull, secs); } catch {}
      }
      return sendJSON(res, { ok: true, path: (j.dir ? j.dir + '/' : '') + filename });
    });
    return;
  }

  // ── Admin: delete a note + its metadata ─────────────────────────────────────
  if (pathname === '/api/admin/folder/meta' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      let folderFull;
      try { folderFull = safePath(adminDataDir(lang), j.dir || ''); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      if (!fs.existsSync(folderFull)) return sendJSON(res, { ok: false, error: 'folder not found' }, 404);
      const secs = parseDataTxtMutable(folderFull);
      const altHu = String(j.altHu || '').trim(), altEn = String(j.altEn || '').trim();
      if (altHu || altEn) secs['__folder__'] = { alt_hu: altHu, alt_en: altEn };
      else delete secs['__folder__'];
      try { writeDataTxt(folderFull, secs); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/admin/note/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      const base = adminDataDir(lang);
      let folderFull, fileFull;
      try { folderFull = safePath(base, j.dir || ''); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try { fileFull = safePath(folderFull, j.filename || ''); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try { if (fs.existsSync(fileFull) && fs.statSync(fileFull).isFile()) fs.rmSync(fileFull); }
      catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const secs    = parseDataTxtMutable(folderFull);
      const display = stripDisplayName(j.filename || '');
      for (const k of Object.keys(secs))
        if (stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase()) delete secs[k];
      try { writeDataTxt(folderFull, secs); } catch {}
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Site sign-in (viewer accounts; also accepts admin credentials) ──────────
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!rateOk(req, 'login', 20, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let u, p;
      try { const j = JSON.parse(body); u = j.username; p = j.password; }
      catch { res.writeHead(400); return res.end('Bad JSON'); }
      let rec = await verifyUser(u, p), role = 'user';
      if (!rec) { rec = await verifyAdmin(u, p); role = 'admin'; }
      if (!rec) return sendJSON(res, { ok: false, error: 'invalid credentials' }, 401);
      const token = createSession(rec.username, role);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, token) });
      return res.end(JSON.stringify({ ok: true, username: rec.username, role }));
    });
    return;
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    const s = siteSession(req);
    return sendJSON(res, { ok: !!s, username: s ? s.username : null, role: s ? s.role : null });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const s = siteSession(req);
    if (s) for (const [tok, v] of SESSIONS) if (v === s) SESSIONS.delete(tok);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie(req) });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── Per-account settings (signed-in users; the site falls back to localStorage) ──
  if (pathname === '/api/settings' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const all = loadSettings();
    return sendJSON(res, { ok: true, settings: all[s.username] || {} });
  }
  if (pathname === '/api/settings' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 131072) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const all = loadSettings();
      all[s.username] = cleanSettings(j);
      try { saveSettings(all); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Messages (text only) ────────────────────────────────────────────────────
  // ── Chat: conversations (DMs + group chats), text only ───────────────────────
  if (pathname === '/api/chat/users' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const me = String(s.username).toLowerCase();
    const seen = new Set(), users = [];
    for (const u of [...loadAdmins(), ...loadUsers()]) {
      const k = String(u.username).toLowerCase();
      if (k === me || seen.has(k)) continue;
      seen.add(k); users.push(u.username);
    }
    users.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return sendJSON(res, { ok: true, users });
  }
  if (pathname === '/api/chat/unread' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, unread: 0 });
    const me = s.username; let unread = 0;
    for (const c of loadChats().conversations) if (chatParticipant(c, me)) unread += chatUnread(c, me);
    return sendJSON(res, { ok: true, unread });
  }
  // Presence heartbeat + lookup. Touches the caller's last-seen and returns how
  // long ago each requested user was last seen (ms), or null if never. Doubles as
  // a lightweight reachability ping for the client's connection indicator.
  if (pathname === '/api/presence' && req.method === 'GET') {
    const s = siteSession(req);
    if (s) touchPresence(s.username);
    const now = Date.now();
    const want = String(query.users || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 50);
    return sendJSON(res, { ok: true, now, me: s ? s.username : null, users: presenceFor(want, now) });
  }
  if (pathname === '/api/chat/list' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const me = s.username, meLc = String(me).toLowerCase(), out = []; touchPresence(me);
    const everyone = new Set();
    const blk = loadBlocked();
    for (const c of loadChats().conversations) {
      if (!chatParticipant(c, me)) continue;
      if (chatHiddenFor(c, me)) continue;            // deleted-for-me
      const last = (c.messages || [])[c.messages.length - 1] || null;
      (c.participants || []).forEach(p => everyone.add(p));
      const other = (c.type !== 'group') ? ((c.participants || []).find(p => String(p).toLowerCase() !== meLc) || null) : null;
      out.push({ id: c.id, type: c.type, title: chatTitleFor(c, me), participants: c.participants || [],
        unread: chatUnread(c, me), last: last ? { from: last.from, body: chatPreview(last), date: last.date, kind: last.kind } : null,
        lastDate: last ? last.date : c.created,
        role: chatRole(c, me), archived: chatArchivedFor(c, me),
        blocked: other ? isBlockedBetween(blk, me, other) : false });
    }
    out.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
    const now = Date.now();
    return sendJSON(res, { ok: true, me, conversations: out, presence: presenceFor([...everyone], now), now, myBlocked: [...blockedSet(blk, me)] });
  }
  if (pathname === '/api/chat/messages' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const me = s.username, c = loadChats().conversations.find(x => x.id === query.id);
    if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
    touchPresence(me);
    const now = Date.now();
    const rolesMap = {}; for (const p of (c.participants || [])) rolesMap[p] = chatRole(c, p);
    return sendJSON(res, { ok: true, id: c.id, type: c.type, title: chatTitleFor(c, me), participants: c.participants || [], createdBy: c.createdBy, roles: rolesMap, myRole: chatRole(c, me), archived: chatArchivedFor(c, me), messages: c.messages || [], presence: presenceFor(c.participants || [], now), now });
  }
  // ── Site-side note management: a member's own notes ─────────────────────────
  if (pathname === '/api/mynotes' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    return sendJSON(res, { ok: true, notes: walkOwnedNotes(s.username) });
  }
  if (pathname === '/api/note/manage' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en';
      const relPath = String(j.path || '');
      const meLc = String(s.username).toLowerCase();
      const isAdmin = s.role === 'admin';
      const acc = noteAccess(relPath, lang);
      const owners = acc.owners.slice();
      if (!isAdmin && !owners.includes(meLc)) return sendJSON(res, { ok: false, error: 'You do not manage this note.' }, 403);
      const primary = owners[0] || null;
      const isPrimary = isAdmin || primary === meLc;
      const p = j.patch || {};
      let folderFull, fileName;
      try {
        const full = safePath(adminDataDir(lang), relPath);
        folderFull = path.dirname(full); fileName = path.basename(full);
        if (!fs.existsSync(full)) return sendJSON(res, { ok: false, error: 'note not found' }, 404);
      } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      const secs = parseDataTxtMutable(folderFull);
      const display = stripDisplayName(fileName);
      let key = Object.keys(secs).find(k => stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase());
      if (!key) key = display;
      const sec = { ...(secs[key] || {}) };
      // owners: collaborators may only add others and remove themselves; primary stays primary
      const toLc = v => Array.isArray(v) ? v.map(x => String(x).trim().toLowerCase()).filter(Boolean)
                      : (typeof v === 'string' ? _csvLc(v) : null);
      let newOwners = toLc(p.owners); if (newOwners == null) newOwners = owners.slice();
      newOwners = [...new Set(newOwners)];
      if (!isPrimary) {
        for (const r of owners.filter(o => o !== meLc)) if (!newOwners.includes(r))
          return sendJSON(res, { ok: false, error: 'Only the primary owner can remove other owners.' }, 403);
        if (primary && newOwners.includes(primary)) newOwners = [primary, ...newOwners.filter(o => o !== primary)];
      }
      if ('tags' in p)        sec.tags        = Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || '');
      if ('authors' in p)     sec.authors     = Array.isArray(p.authors) ? p.authors.join(', ') : String(p.authors || '');
      if ('date' in p)        sec.date        = String(p.date || '');
      if ('materialStart' in p) sec.material_start = String(p.materialStart || '');
      if ('materialEnd' in p)   sec.material_end   = String(p.materialEnd || '');
      if ('updated' in p)       sec.updated        = String(p.updated || '');
      if ('description' in p) sec.description  = String(p.description || '');
      if ('important' in p)   sec.important    = p.important ? 'true' : '';
      if (['canSee', 'canRead', 'readRequests', 'seeAllow', 'readAllow'].some(k => k in p)) {
        const canSee  = (p.canSee === 'members' || p.canSee === 'whitelist') ? p.canSee : 'all';
        const canRead = (p.canRead === 'members' || p.canRead === 'whitelist') ? p.canRead : 'all';
        delete sec.visibility; delete sec.allow;
        sec.can_see = canSee; sec.can_read = canRead;
        sec.read_requests = p.readRequests ? 'true' : '';
        sec.see_allow  = canSee === 'whitelist' ? (Array.isArray(p.seeAllow) ? p.seeAllow.join(', ') : String(p.seeAllow || '')) : '';
        sec.read_allow = canRead === 'whitelist' ? (Array.isArray(p.readAllow) ? p.readAllow.join(', ') : String(p.readAllow || '')) : '';
      }
      sec.owners = newOwners.join(', ');
      secs[key] = sec;
      try { writeDataTxt(folderFull, secs); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  // ── Per-note discussion: a shared thread attached to a note (feature) ───────
  // Readable/postable only by signed-in users who can view the note.
  if (pathname === '/api/note/discussion' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const p = query.path, lang = query.lang === 'hu' ? 'hu' : 'en';
    if (!p) return sendJSON(res, { ok: false, error: 'Missing path.' }, 400);
    if (!canViewNote(req, p, lang)) return sendJSON(res, { ok: false, error: 'No access to this note.' }, 403);
    const all = loadNoteDiscuss();
    return sendJSON(res, { ok: true, messages: all[noteDiscussKey(p, lang)] || [] });
  }
  if (pathname === '/api/note/discussion' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const p = j.path, lang = j.lang === 'hu' ? 'hu' : 'en';
      if (!p) return sendJSON(res, { ok: false, error: 'Missing path.' }, 400);
      if (!canViewNote(req, p, lang)) return sendJSON(res, { ok: false, error: 'No access to this note.' }, 403);
      let text = String(j.body || '').trim();
      if (!text) return sendJSON(res, { ok: false, error: 'Message is empty.' }, 400);
      if (text.length > 8000) text = text.slice(0, 8000);
      const all = loadNoteDiscuss(), key = noteDiscussKey(p, lang);
      const thread = Array.isArray(all[key]) ? all[key] : (all[key] = []);
      const msg = { id: crypto.randomUUID(), from: s.username, body: text, date: new Date().toISOString() };
      thread.push(msg);
      if (thread.length > 500) all[key] = thread.slice(-500);
      try { saveNoteDiscuss(all); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, message: msg });
    });
    return;
  }
  if (pathname === '/api/note/discussion/delete' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const p = j.path, lang = j.lang === 'hu' ? 'hu' : 'en', id = String(j.id || '');
      if (!p || !id) return sendJSON(res, { ok: false, error: 'Missing path or id.' }, 400);
      const all = loadNoteDiscuss(), key = noteDiscussKey(p, lang);
      const thread = Array.isArray(all[key]) ? all[key] : [];
      const m = thread.find(x => x.id === id);
      if (!m) return sendJSON(res, { ok: false, error: 'Message not found.' }, 404);
      if (String(m.from).toLowerCase() !== String(s.username).toLowerCase()) return sendJSON(res, { ok: false, error: 'You can only delete your own messages.' }, 403);
      all[key] = thread.filter(x => x.id !== id);
      try { saveNoteDiscuss(all); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  if (pathname === '/api/chat/send' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      let text = String(j.body || '').trim();
      const hasNoteRef = j.noteRef && typeof j.noteRef === 'object' && j.noteRef.path;
      if (!text && !hasNoteRef) return sendJSON(res, { ok: false, error: 'Message is empty.' }, 400);
      if (text.length > 8000) text = text.slice(0, 8000);
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(); touchPresence(me);
      const blk = loadBlocked();
      let c;
      if (j.id) {
        c = chats.conversations.find(x => x.id === j.id);
        if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'Conversation not found.' }, 404);
        if (c.type !== 'group') { const other = (c.participants || []).find(p => String(p).toLowerCase() !== meLc); if (other && isBlockedBetween(blk, me, other)) return sendJSON(res, { ok: false, error: 'You can no longer message this person.' }, 403); }
      } else {
        const to = resolveUsername(j.to);
        if (!to) return sendJSON(res, { ok: false, error: 'Unknown recipient.' }, 400);
        if (String(to).toLowerCase() === meLc) return sendJSON(res, { ok: false, error: 'You cannot message yourself.' }, 400);
        if (isBlockedBetween(blk, me, to)) return sendJSON(res, { ok: false, error: 'You can no longer message this person.' }, 403);
        c = ensureDM(chats, me, to);
      }
      if (!chatCan(c, me, 'write')) return sendJSON(res, { ok: false, error: 'You do not have permission to post here.' }, 403);
      const msg = { id: crypto.randomUUID(), from: me, body: text, date: new Date().toISOString(), kind: 'text' };
      if (j.replyTo) { const src = (c.messages || []).find(m => m.id === j.replyTo); if (src) { msg.replyTo = src.id; msg.replyFrom = src.from; msg.replyText = (src.kind === 'text' ? (src.body || '') : chatPreview(src)).slice(0, 160); } }
      if (j.noteRef && typeof j.noteRef === 'object' && j.noteRef.path) {
        const nr = j.noteRef;
        const ref = { path: String(nr.path).slice(0, 512), lang: nr.lang === 'hu' ? 'hu' : 'en', label: String(nr.label || '').slice(0, 240) };
        if (Number.isFinite(nr.from) && Number.isFinite(nr.to)) { ref.from = Math.max(0, nr.from | 0); ref.to = Math.max(ref.from, nr.to | 0); }
        msg.noteRef = ref;
      }
      c.messages.push(msg);
      if (c.messages.length > 1000) c.messages = c.messages.slice(-1000);
      if (c.type !== 'group' && Array.isArray(c.deletedBy) && c.deletedBy.length) c.deletedBy = []; // new activity un-hides a deleted-for-me DM
      c.reads = c.reads || {}; c.reads[meLc] = msg.date;
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, id: c.id });
    });
    return;
  }
  if (pathname === '/api/chat/group' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const title = String(j.title || '').trim().slice(0, 80);
      if (!title) return sendJSON(res, { ok: false, error: 'The group needs a name.' }, 400);
      const me = s.username, set = new Map(); set.set(String(me).toLowerCase(), me);
      for (const nm of (Array.isArray(j.participants) ? j.participants : [])) { const r = resolveUsername(nm); if (r) set.set(String(r).toLowerCase(), r); }
      if (set.size < 2) return sendJSON(res, { ok: false, error: 'Add at least one other member.' }, 400);
      const chats = loadChats(), now = new Date().toISOString();
      const c = { id: crypto.randomUUID(), type: 'group', title, participants: [...set.values()], createdBy: me, created: now,
        roles: { [String(me).toLowerCase()]: 'owner' },
        messages: [{ id: crypto.randomUUID(), from: me, kind: 'system', body: 'created the group', date: now }], reads: {} };
      chats.conversations.push(c);
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, id: c.id });
    });
    return;
  }
  if (pathname === '/api/chat/addMembers' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      if (c.type !== 'group') return sendJSON(res, { ok: false, error: 'Not a group chat.' }, 400);
      if (!chatCan(c, me, 'manageMembers')) return sendJSON(res, { ok: false, error: 'You do not have permission to add members.' }, 403);
      const have = new Set((c.participants || []).map(p => String(p).toLowerCase())), added = [];
      c.roles = c.roles || {};
      for (const nm of (Array.isArray(j.participants) ? j.participants : [])) { const r = resolveUsername(nm); if (r && !have.has(String(r).toLowerCase())) { c.participants.push(r); have.add(String(r).toLowerCase()); c.roles[String(r).toLowerCase()] = 'member'; added.push(r); } }
      if (added.length) {
        c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'system', body: 'added ' + added.join(', '), date: new Date().toISOString() });
        try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      }
      return sendJSON(res, { ok: true, added });
    });
    return;
  }
  if (pathname === '/api/chat/read' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      c.reads = c.reads || {}; c.reads[String(me).toLowerCase()] = new Date().toISOString();
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  // ── Chat management: leave / delete / archive / message edit+delete / roles / block ──
  if (pathname === '/api/chat/leave' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      if (c.type !== 'group') return sendJSON(res, { ok: false, error: 'You can only leave group chats.' }, 400);
      const wasOwner = chatRole(c, me) === 'owner';
      c.participants = (c.participants || []).filter(p => String(p).toLowerCase() !== meLc);
      if (c.roles) delete c.roles[meLc];
      if (!c.participants.length) { chats.conversations = chats.conversations.filter(x => x.id !== c.id); }
      else {
        if (wasOwner && !c.participants.some(p => chatRole(c, p) === 'owner')) {
          let heir = null;
          if (j.heir) { const h = resolveUsername(j.heir); if (h && c.participants.some(p => String(p).toLowerCase() === String(h).toLowerCase())) heir = h; }
          if (!heir) heir = c.participants[0];   // longest-standing remaining member
          c.roles = c.roles || {}; c.roles[String(heir).toLowerCase()] = 'owner';
          c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'system', body: 'left · ' + heir + ' is now the owner', date: new Date().toISOString() });
        } else {
          c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'system', body: 'left the group', date: new Date().toISOString() });
        }
      }
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/chat/delete' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      if (c.type === 'group') {
        if (!chatCan(c, me, 'deleteConv')) return sendJSON(res, { ok: false, error: 'Only the group owner can delete it.' }, 403);
        chats.conversations = chats.conversations.filter(x => x.id !== c.id);     // purge for everyone
      } else if (j.everyone) {
        chats.conversations = chats.conversations.filter(x => x.id !== c.id);     // DM: delete for both participants
      } else {
        c.deletedBy = Array.isArray(c.deletedBy) ? c.deletedBy : [];              // DM: hide for me only
        if (!c.deletedBy.map(x => String(x).toLowerCase()).includes(meLc)) c.deletedBy.push(me);
        if ((c.participants || []).every(p => c.deletedBy.map(x => String(x).toLowerCase()).includes(String(p).toLowerCase()))) chats.conversations = chats.conversations.filter(x => x.id !== c.id);
      }
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/chat/archive' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      c.archivedBy = Array.isArray(c.archivedBy) ? c.archivedBy : [];
      const has = c.archivedBy.map(x => String(x).toLowerCase()).includes(meLc);
      const want = (j.archive === undefined) ? !has : !!j.archive;
      if (want && !has) c.archivedBy.push(me);
      else if (!want && has) c.archivedBy = c.archivedBy.filter(x => String(x).toLowerCase() !== meLc);
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, archived: want });
    });
    return;
  }
  if (pathname === '/api/chat/message/delete' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      const m = (c.messages || []).find(x => x.id === j.mid);
      if (!m) return sendJSON(res, { ok: false, error: 'Message not found.' }, 404);
      if (m.kind === 'system') return sendJSON(res, { ok: false, error: 'System messages cannot be deleted.' }, 400);
      const mine = String(m.from).toLowerCase() === meLc;
      if (!mine && !chatCan(c, me, 'manageMessages')) return sendJSON(res, { ok: false, error: 'You can only delete your own messages.' }, 403);
      m.deleted = true; m.deletedBy = me; m.body = ''; delete m.noteRef;
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/chat/message/edit' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      const m = (c.messages || []).find(x => x.id === j.mid);
      if (!m) return sendJSON(res, { ok: false, error: 'Message not found.' }, 404);
      if (String(m.from).toLowerCase() !== meLc) return sendJSON(res, { ok: false, error: 'You can only edit your own messages.' }, 403);
      if (m.kind !== 'text' || m.deleted) return sendJSON(res, { ok: false, error: 'This message cannot be edited.' }, 400);
      let text = String(j.body || '').trim();
      if (!text) return sendJSON(res, { ok: false, error: 'Message is empty.' }, 400);
      if (text.length > 8000) text = text.slice(0, 8000);
      m.body = text; m.edited = true; m.editedAt = new Date().toISOString();
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, message: m });
    });
    return;
  }
  if (pathname === '/api/chat/setRole' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      if (c.type !== 'group') return sendJSON(res, { ok: false, error: 'Roles apply to group chats only.' }, 400);
      if (!chatCan(c, me, 'setRole')) return sendJSON(res, { ok: false, error: 'Only the owner can change roles.' }, 403);
      const target = resolveUsername(j.target); const tLc = target ? String(target).toLowerCase() : '';
      if (!target || !chatParticipant(c, target)) return sendJSON(res, { ok: false, error: 'That person is not in this group.' }, 400);
      if (tLc === meLc) return sendJSON(res, { ok: false, error: 'You cannot change your own role.' }, 400);
      const role = j.role;
      if (!['owner', 'admin', 'member', 'readonly'].includes(role)) return sendJSON(res, { ok: false, error: 'Unknown role.' }, 400);
      c.roles = c.roles || {};
      if (role === 'owner') {
        for (const p of (c.participants || [])) if (chatRole(c, p) === 'owner') c.roles[String(p).toLowerCase()] = 'admin';
        c.roles[tLc] = 'owner';
      } else { c.roles[tLc] = role; }
      c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'system', body: 'set ' + target + ' as ' + role, date: new Date().toISOString() });
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/chat/removeMember' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats(), c = chats.conversations.find(x => x.id === j.id);
      if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      if (c.type !== 'group') return sendJSON(res, { ok: false, error: 'Group chats only.' }, 400);
      if (!chatCan(c, me, 'manageMembers')) return sendJSON(res, { ok: false, error: 'You do not have permission to remove members.' }, 403);
      const target = resolveUsername(j.target); const tLc = target ? String(target).toLowerCase() : '';
      if (!target || !chatParticipant(c, target)) return sendJSON(res, { ok: false, error: 'That person is not in this group.' }, 400);
      if (tLc === meLc) return sendJSON(res, { ok: false, error: 'Use Leave to remove yourself.' }, 400);
      const tRole = chatRole(c, target);
      if (tRole === 'owner') return sendJSON(res, { ok: false, error: 'You cannot remove the owner.' }, 403);
      if (tRole === 'admin' && chatRole(c, me) !== 'owner') return sendJSON(res, { ok: false, error: 'Only the owner can remove an admin.' }, 403);
      c.participants = (c.participants || []).filter(p => String(p).toLowerCase() !== tLc);
      if (c.roles) delete c.roles[tLc];
      c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'system', body: 'removed ' + target, date: new Date().toISOString() });
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  if (pathname === '/api/chat/block' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase();
      const target = resolveUsername(j.username);
      if (!target) return sendJSON(res, { ok: false, error: 'Unknown user.' }, 400);
      const tLc = String(target).toLowerCase();
      if (tLc === meLc) return sendJSON(res, { ok: false, error: 'You cannot block yourself.' }, 400);
      const map = loadBlocked();
      const cur = Array.isArray(map[meLc]) ? map[meLc].map(x => String(x).toLowerCase()) : [];
      const has = cur.includes(tLc);
      const want = (j.block === undefined) ? !has : !!j.block;
      let next = cur.filter(x => x !== tLc);
      if (want) next.push(tLc);
      if (next.length) map[meLc] = next; else delete map[meLc];
      try { saveBlocked(map); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, blocked: want });
    });
    return;
  }

  // ── Access requests for request-to-read notes (delivered as chat DMs) ─────────
  if (pathname === '/api/access/info' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const lang = query.lang === 'hu' ? 'hu' : 'en', p = query.path || '';
    const _acc = noteAccess(p, lang);
    const granted = canViewNote(req, p, lang);
    const applicable = !granted && _acc.canRead === 'whitelist' && _acc.readRequests && passSeeGate(_acc, s);
    const meLc = String(s.username).toLowerCase();
    const pending = loadChats().conversations.some(c => chatParticipant(c, s.username) && (c.messages || []).some(m => m.kind === 'access-request' && String(m.from).toLowerCase() === meLc && m.status === 'pending' && m.note && m.note.path === p && m.note.lang === lang));
    // Only name the owners to someone who may actually send them a request. This
    // used to answer for *any* path, so a signed-in visitor could read back the
    // owner list of a note they are not even allowed to know exists — the same
    // disclosure the data.txt guard on /api/file was added to close.
    const recipients = (applicable || pending) ? requestRecipients(p, lang) : [];
    return sendJSON(res, { ok: true, applicable, granted, pending, recipients });
  }
  if (pathname === '/api/access/request' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en', p = String(j.path || '');
      const _acc = noteAccess(p, lang);
      if (!(_acc.canRead === 'whitelist' && _acc.readRequests)) return sendJSON(res, { ok: false, error: 'This note does not require a request.' }, 400);
      // You may only ask for a note you are allowed to *see*. Without this a member
      // outside the see-whitelist could post a request card naming a hidden note,
      // which both leaks its path to its owners and hands the sender its label.
      if (!passSeeGate(_acc, s)) return sendJSON(res, { ok: false, error: 'This note does not require a request.' }, 400);
      if (canViewNote(req, p, lang)) return sendJSON(res, { ok: true, status: 'granted' });
      const recipients = requestRecipients(p, lang);
      if (!recipients.length) return sendJSON(res, { ok: false, error: 'No one can grant access to this note.' }, 400);
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats();
      const note = { path: p, lang, label: stripDisplayName(path.basename(p)) };
      const extra = String(j.body || '').slice(0, 2000), now = new Date().toISOString();
      let posted = 0, already = false;
      for (const to of recipients) {
        if (String(to).toLowerCase() === meLc) continue;
        const c = ensureDM(chats, me, to);
        if ((c.messages || []).some(m => m.kind === 'access-request' && String(m.from).toLowerCase() === meLc && m.status === 'pending' && m.note && m.note.path === p && m.note.lang === lang)) { already = true; continue; }
        c.messages.push({ id: crypto.randomUUID(), from: me, kind: 'access-request', status: 'pending', note, body: extra, date: now });
        c.reads = c.reads || {}; c.reads[meLc] = now;
        posted++;
      }
      if (!posted) return sendJSON(res, { ok: true, status: already ? 'pending' : 'requested', recipients });
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, status: 'requested', recipients });
    });
    return;
  }
  if (pathname === '/api/access/respond' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats();
      let target = null, convo = null;
      for (const c of chats.conversations) {
        if (!chatParticipant(c, me)) continue;
        const m = (c.messages || []).find(x => x.id === j.id && x.kind === 'access-request' && x.status === 'pending');
        if (m) { target = m; convo = c; break; }
      }
      if (!target) return sendJSON(res, { ok: false, error: 'Request not found.' }, 404);
      if (String(target.from).toLowerCase() === meLc) return sendJSON(res, { ok: false, error: 'You cannot respond to your own request.' }, 400);
      // Re-check the right to grant at response time, not just at request time: the
      // note's owners may have changed since the request card was delivered, and
      // being in the conversation is not by itself authority over the note.
      const _canGrant = s.role === 'admin' ||
        requestRecipients(target.note.path, target.note.lang).some(u => String(u).toLowerCase() === meLc);
      if (!_canGrant) return sendJSON(res, { ok: false, error: 'You no longer manage this note.' }, 403);
      const accept = j.decision === 'accept', reason = String(j.reason || '').slice(0, 2000);
      target.status = accept ? 'accepted' : 'declined';
      if (accept) addGrant(target.from, target.note.lang, target.note.path);
      convo.messages.push({ id: crypto.randomUUID(), from: me, kind: 'access-result', decision: accept ? 'accepted' : 'declined', reason, note: target.note, body: reason, date: new Date().toISOString() });
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Password reset: ask an admin, admin hands back a one-time link ──────────
  // There is no mail server, so the flow is deliberately human: a locked-out member
  // asks, every admin gets a card in their chat, and an admin issues a single-use
  // link they pass on however they normally reach that person.
  //
  // The abuse surface is the *request* step, which anyone can reach signed out, so
  // it is fenced four ways: a hard IP rate limit, one pending request per account,
  // an hour's cooldown per account even after one is resolved, and a global cap on
  // pending requests. The requester supplies no free text at all — only a username
  // that must already exist — so there is nothing to write into an admin's inbox.
  if (pathname === '/api/password-reset/request' && req.method === 'POST') {
    if (!rateOk(req, 'pwreset', 3, 60 * 60 * 1000)) return sendJSON(res, { ok: true, sent: true }, 200);
    let body = ''; req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      // The reply never varies: telling the caller whether an account exists would
      // turn this into a username oracle.
      const done = () => sendJSON(res, { ok: true, sent: true });
      const nameLc = String(j.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(nameLc)) return done();
      const real = loadUsers().find(u => String(u.username).toLowerCase() === nameLc);
      if (!real) return done();                                  // admins reset their own with make-admin.js
      const now = Date.now();
      const last = PW_RESET_ASKED.get(nameLc) || 0;
      if (now - last < PW_RESET_COOLDOWN) return done();
      if (PW_RESET_ASKED.size > 200) for (const [k, t] of PW_RESET_ASKED) if (now - t > PW_RESET_COOLDOWN) PW_RESET_ASKED.delete(k);

      const chats = loadChats();
      const pendingTotal = chats.conversations.reduce((n, c) =>
        n + (c.messages || []).filter(m => m.kind === 'password-reset' && m.status === 'pending').length, 0);
      if (pendingTotal >= PW_RESET_MAX_PENDING) return done();

      const admins = loadAdmins().map(a => a.username);
      if (!admins.length) return done();
      const when = new Date().toISOString();
      let posted = 0;
      for (const to of admins) {
        const c = ensureDM(chats, real.username, to);
        if ((c.messages || []).some(m => m.kind === 'password-reset' && m.status === 'pending')) continue;
        c.messages.push({ id: crypto.randomUUID(), from: real.username, kind: 'password-reset', status: 'pending', date: when });
        posted++;
      }
      PW_RESET_ASKED.set(nameLc, now);
      if (posted) { try { saveChats(chats); } catch {} }
      return done();
    });
    return;
  }
  // Admin issues the one-time link. Nothing is emailed — the admin copies it and
  // gives it to the person by whatever channel they already trust.
  if (pathname === '/api/admin/password-reset/issue' && req.method === 'POST') {
    // Either credential: the request card lands in the admin's *chat*, on the site,
    // and making them open DevTools to answer it would guarantee it sits unread.
    const _actor = requireAdminEither(req, res); if (!_actor) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const nameLc = String(j.username || '').trim().toLowerCase();
      const real = loadUsers().find(u => String(u.username).toLowerCase() === nameLc);
      if (!real) return sendJSON(res, { ok: false, error: 'No such member account.' }, 404);
      // One live token per account: issuing a new link retires the old one.
      for (const [tok, v] of PW_RESET_TOKENS) if (v.userLc === nameLc) PW_RESET_TOKENS.delete(tok);
      const tokenValue = crypto.randomBytes(32).toString('hex');
      PW_RESET_TOKENS.set(tokenValue, { userLc: nameLc, username: real.username, expires: Date.now() + PW_RESET_TTL });
      // Mark the request answered wherever it is showing.
      const chats = loadChats(); let touched = false;
      for (const c of chats.conversations)
        for (const m of (c.messages || []))
          if (m.kind === 'password-reset' && m.status === 'pending' && String(m.from).toLowerCase() === nameLc) { m.status = 'issued'; m.issuedBy = _actor; touched = true; }
      if (touched) { try { saveChats(chats); } catch {} }
      return sendJSON(res, { ok: true, username: real.username, path: '/#reset=' + tokenValue,
        expiresInMinutes: Math.round(PW_RESET_TTL / 60000) });
    });
    return;
  }
  // The link itself. Single use, short-lived, and it signs every other session out.
  if (pathname === '/api/password-reset/complete' && req.method === 'POST') {
    if (!rateOk(req, 'pwresetdo', 20, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const tok = String(j.token || '');
      const rec = PW_RESET_TOKENS.get(tok);
      if (!rec || rec.expires < Date.now()) { PW_RESET_TOKENS.delete(tok); return sendJSON(res, { ok: false, error: 'This link has expired. Ask for a new one.' }, 400); }
      const newp = String(j.newPassword || '');
      if (newp.length < MIN_PASSWORD) return sendJSON(res, { ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters.' }, 400);
      const list = loadUsers();
      const i = list.findIndex(u => String(u.username).toLowerCase() === rec.userLc);
      if (i < 0) { PW_RESET_TOKENS.delete(tok); return sendJSON(res, { ok: false, error: 'That account no longer exists.' }, 404); }
      list[i] = { username: list[i].username, ...(await hashPassword(newp)) };
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      PW_RESET_TOKENS.delete(tok);                       // single use
      PW_RESET_ASKED.delete(rec.userLc);                 // they are back in; clear the cooldown
      revokeSessions(rec.username);                      // whoever else had the old password is out
      // Close the card so the admin can see it was used.
      const chats = loadChats(); let touched = false;
      for (const c of chats.conversations)
        for (const m of (c.messages || []))
          if (m.kind === 'password-reset' && m.status === 'issued' && String(m.from).toLowerCase() === rec.userLc) { m.status = 'done'; touched = true; }
      if (touched) { try { saveChats(chats); } catch {} }
      const fresh = createSession(list[i].username, 'user');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, fresh) });
      return res.end(JSON.stringify({ ok: true, username: list[i].username, role: 'user' }));
    });
    return;
  }

  // ── Public: register a viewer account ───────────────────────────────────────
  if (pathname === '/api/register' && req.method === 'POST') {
    if (!rateOk(req, 'register', 5, 60 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many sign-up attempts. Try again later.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const username = String(j.username || '').trim();
      const password = String(j.password || '');
      if (!USERNAME_RE.test(username))
        return sendJSON(res, { ok: false, error: 'Username must be 3-32 chars: letters, numbers, dot, underscore, hyphen.' }, 400);
      if (password.length < MIN_PASSWORD)
        return sendJSON(res, { ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters.' }, 400);
      const list = loadUsers();
      if (list.some(u => u.username.toLowerCase() === username.toLowerCase())
        || loadAdmins().some(a => a.username.toLowerCase() === username.toLowerCase()))
        return sendJSON(res, { ok: false, error: 'That username is taken.' }, 409);
      list.push({ username, ...(await hashPassword(password)) });
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const token = createSession(username, 'user');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, token) });
      return res.end(JSON.stringify({ ok: true, username, role: 'user' }));
    });
    return;
  }
  // ── Signed-in user: change own password ─────────────────────────────────────
  if (pathname === '/api/account/password' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'Not signed in.' }, 401);
    if (s.role !== 'user') return sendJSON(res, { ok: false, error: 'Admin passwords are managed with make-admin.js.' }, 400);
    // Each call runs scrypt twice; rate-limited so a signed-in account cannot use
    // it as a CPU tap, and so a borrowed session cannot grind at the old password.
    if (!rateOk(req, 'pwchange', 10, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const oldp = String(j.oldPassword || ''), newp = String(j.newPassword || '');
      if (newp.length < 8) return sendJSON(res, { ok: false, error: 'New password must be at least 8 characters.' }, 400);
      if (!(await verifyUser(s.username, oldp))) return sendJSON(res, { ok: false, error: 'Current password is incorrect.' }, 403);
      const list = loadUsers();
      const i = list.findIndex(u => u.username.toLowerCase() === s.username.toLowerCase());
      if (i < 0) return sendJSON(res, { ok: false, error: 'Account not found.' }, 404);
      list[i] = { username: list[i].username, ...(await hashPassword(newp)) };
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      // Sign out everywhere else. If the reason for changing the password is that
      // someone else had it, leaving their session alive changes nothing. The
      // caller's own token is spared so they are not logged out of this tab.
      const _tok = (req.headers && req.headers['x-auth-token']) || parseCookies(req)[SITE_COOKIE] || '';
      const revoked = revokeSessions(s.username, _tok);
      return sendJSON(res, { ok: true, revoked });
    });
    return;
  }

  // ── Admin: back up everything the repository does not hold ──────────────────
  // days.json, chats.json, users.json, grants.json and the Uploads/ tree are all
  // git-ignored runtime state: lose the disk and you lose every logged day, every
  // scan of a paper note and every conversation, with nothing to restore from.
  // This streams the lot as a .zip so a backup is one click.
  //   ?what=state (default) — the JSON stores + Uploads/
  //   ?what=all             — also Data/, DataHU/, Articles/ (normally in git)
  if (pathname === '/api/admin/export' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!requireAdmin(req, res)) return;
    const withNotes = query.what === 'all';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = `digitalization-backup-${stamp}.zip`;
    res.writeHead(200, cors({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    }));
    if (req.method === 'HEAD') return res.end();

    const zip = createZipWriter(res);
    let files = 0, bytes = 0, skipped = [];
    const EXPORT_MAX = Number(process.env.EXPORT_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
    const addFile = (abs, rel) => {
      if (bytes >= EXPORT_MAX) { skipped.push(rel); return; }
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (!st.isFile()) return;
      let data; try { data = fs.readFileSync(abs); } catch { skipped.push(rel); return; }
      zip.add(rel, data, st.mtime); files++; bytes += st.size;
    };
    const addDir = (absDir, relBase) => {
      let ents; try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = path.join(absDir, e.name), rel = relBase + '/' + e.name;
        if (e.isDirectory()) addDir(abs, rel); else addFile(abs, rel);
      }
    };
    try {
      for (const f of ['admins.json', 'users.json', 'settings.json', 'grants.json', 'chats.json',
                       'blocked.json', 'note-discussions.json', 'changelog.json', 'timetable.json', 'days.json',
                       'donations.json'])
        addFile(path.join(__WEBSITE, f), 'state/' + f);
      addDir(__DAY_FILES, 'Uploads/days');
      // Submissions still awaiting review are somebody else's unpublished work and
      // exist nowhere else — losing the disk before an audit would lose them.
      addDir(__DONATION_FILES, 'Uploads/donations');
      if (withNotes) {
        addDir(__DATA, 'Data');
        if (HAS_DUAL_LANG) addDir(__DATA_HU, 'DataHU');
        addDir(__ARTICLES, 'Articles');
        addDir(__ARTICLES_HU, 'ArticlesHU');
      }
      // A short manifest so a future you knows what this archive is and how to use it.
      const manifest = [
        'Digitalization backup',
        'taken: ' + new Date().toISOString(),
        'scope: ' + (withNotes ? 'state + notes + articles' : 'state + uploads'),
        'files: ' + files,
        'bytes: ' + bytes,
        skipped.length ? 'skipped (unreadable or over EXPORT_MAX_BYTES): ' + skipped.length : '',
        '',
        'To restore: stop the server, copy state/*.json next to server.js, and copy',
        'Uploads/ back into the Website folder. The two directories must keep their',
        'names — day attachments are looked up as Uploads/days/<dayId>/<attId><ext>.',
        '',
        'state/admins.json and state/users.json hold salted scrypt password hashes.',
        'Keep this file somewhere you would keep a password manager export.',
      ].filter(x => x !== undefined).join('\n') + '\n';
      zip.add('README-restore.txt', Buffer.from(manifest, 'utf8'), new Date());
      zip.finish();
    } catch (e) {
      console.error('export failed:', (e && e.stack) || e);
    }
    return res.end();
  }

  // ── Admin: manage viewer accounts ───────────────────────────────────────────
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return sendJSON(res, { ok: true, users: loadUsers().map(u => u.username) });
  }
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const username = String(j.username || '').trim();
      const password = String(j.password || '');
      if (!username || !password) return sendJSON(res, { ok: false, error: 'username and password required' }, 400);
      // Same rules as public sign-up and make-user.js. This route accepted anything,
      // so an admin could mint an account whose name is markup — and that name is
      // then echoed into every other member's chat list, participant picker and
      // note-owner field. Constrain it at the one place that creates it.
      if (!USERNAME_RE.test(username))
        return sendJSON(res, { ok: false, error: 'Username must be 3-32 chars: letters, numbers, dot, underscore, hyphen.' }, 400);
      if (password.length < MIN_PASSWORD)
        return sendJSON(res, { ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters.' }, 400);
      if (loadAdmins().some(a => a.username.toLowerCase() === username.toLowerCase()))
        return sendJSON(res, { ok: false, error: 'That name belongs to an admin account.' }, 409);
      const list = loadUsers();
      const i = list.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
      let updated = false;
      if (i >= 0) { list[i] = { username: list[i].username, ...(await hashPassword(password)) }; updated = true; }
      else list.push({ username, ...(await hashPassword(password)) });
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      // An admin resetting a password is usually locking someone out; leaving their
      // old sessions alive would defeat it.
      if (updated) revokeSessions(username);
      return sendJSON(res, { ok: true, username, updated });
    });
    return;
  }
  if (pathname === '/api/admin/users/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const username = String(j.username || '').trim().toLowerCase();
      const list = loadUsers().filter(u => u.username.toLowerCase() !== username);
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const revoked = revokeSessions(username);   // removing the account must end the access
      return sendJSON(res, { ok: true, revoked });
    });
    return;
  }
  // Music
  // ── Timetable: public read, admin write ────────────────────────────────────
  if (pathname === '/api/timetable' && req.method === 'GET') {
    const t = loadTimetable();
    const s = siteSession(req);
    if (t.settings.visibility === 'members' && !s)
      return sendJSON(res, { ok: true, restricted: true, timetable: null });
    return sendJSON(res, { ok: true, timetable: t, today: new Date().toISOString().slice(0, 10) });
  }
  if (pathname === '/api/admin/timetable' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      try { return sendJSON(res, { ok: true, timetable: saveTimetable(j && j.timetable ? j.timetable : j) }); }
      catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // ── Day log: what actually happened, per calendar day ──────────────────────
  // Compact index for the calendar / heat map: one row per logged day.
  if (pathname === '/api/days/index' && req.method === 'GET') {
    const s = siteSession(req);
    const rows = loadDays().filter(d => canSeeDay(d, s)).map(d => {
      const seen = new Map();
      for (const l of d.lessons || []) {
        const k = l.subjectId || l.subject || l.id;
        if (!seen.has(k)) seen.set(k, { id: l.subjectId, name: l.subject, nameHu: l.subjectHu, color: l.color });
      }
      return { id: d.id, date: d.date, title: d.title, titleHu: d.titleHu, visibility: d.visibility,
        counts: dayCounts(d), subjects: [...seen.values()].slice(0, 12) };
    });
    return sendJSON(res, { ok: true, index: rows, today: new Date().toISOString().slice(0, 10) });
  }
  // Feed: full day records, newest first, filterable.
  if (pathname === '/api/days' && req.method === 'GET') {
    const s = siteSession(req);
    const from = _date(query.from), to = _date(query.to);
    const subject = _id(query.subject);
    const q = String(query.q || '').trim().toLowerCase().slice(0, 120);
    const onlyFiles = query.files === '1';
    const limit  = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 40));
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    let list = loadDays().filter(d => canSeeDay(d, s));
    if (from) list = list.filter(d => d.date >= from);
    if (to)   list = list.filter(d => d.date <= to);
    if (subject) list = list.filter(d => (d.lessons || []).some(l => l.subjectId === subject));
    if (onlyFiles) list = list.filter(d => dayCounts(d).files > 0);
    if (q) list = list.filter(d => daySearchText(d).includes(q));
    const total = list.length;
    const page = list.slice(offset, offset + limit).map(d => publicDay(d, req));
    return sendJSON(res, { ok: true, days: page, total, offset, limit });
  }
  // One day: the log (if any) plus what the timetable had scheduled for that date.
  if (pathname === '/api/day' && req.method === 'GET') {
    const s = siteSession(req);
    const tt = loadTimetable();
    const ttVisible = !(tt.settings.visibility === 'members' && !s);
    let day = null;
    if (query.id) { const d = loadDays().find(x => x.id === String(query.id)); if (d && canSeeDay(d, s)) day = publicDay(d, req); }
    else if (isDate(query.date)) { const d = findDayByDate(loadDays(), query.date); if (d && canSeeDay(d, s)) day = publicDay(d, req); }
    const date = day ? day.date : _date(query.date);
    const plan = (date && ttVisible) ? planForDate(date, tt) : null;
    if (!day && !date) return sendJSON(res, { ok: false, error: 'Unknown day.' }, 404);
    return sendJSON(res, { ok: true, date, day, plan });
  }
  // Days on which a given digital note was covered — powers the note viewer's
  // "covered in class on …" link, i.e. the association between paper and digital.
  if (pathname === '/api/note/days' && req.method === 'GET') {
    const s = siteSession(req);
    const p = String(query.path || ''), lang = _lang(query.lang);
    if (!p) return sendJSON(res, { ok: true, days: [] });
    if (!canViewNote(req, p, lang)) return sendJSON(res, { ok: true, days: [] });
    const out = [];
    for (const d of loadDays()) {
      if (!canSeeDay(d, s)) continue;
      for (const l of d.lessons || []) {
        if (!(l.notes || []).some(n => n.path === p && n.lang === lang)) continue;
        out.push({ dayId: d.id, date: d.date, lessonId: l.id, subject: l.subject, subjectHu: l.subjectHu,
          color: l.color, kind: l.kind, periodLabel: l.periodLabel, start: l.start,
          what: String(l.what || '').slice(0, 240), files: (l.attachments || []).length });
      }
    }
    return sendJSON(res, { ok: true, days: out.slice(0, 200) });
  }

  // ── Day log: admin authoring ───────────────────────────────────────────────
  if (pathname === '/api/admin/days' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const rows = loadDays().map(d => ({ id: d.id, date: d.date, title: d.title, titleHu: d.titleHu,
      visibility: d.visibility, counts: dayCounts(d), updated: d.updated, updatedBy: d.updatedBy }));
    return sendJSON(res, { ok: true, days: rows });
  }
  if (pathname === '/api/admin/day' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const list = loadDays();
    let day = null;
    if (query.id) day = list.find(x => x.id === String(query.id)) || null;
    else if (isDate(query.date)) day = findDayByDate(list, query.date);
    const date = day ? day.date : _date(query.date);
    return sendJSON(res, { ok: true, date, day, plan: date ? planForDate(date) : null });
  }
  if (pathname === '/api/admin/day' && req.method === 'POST') {
    const who = requireAdmin(req, res); if (!who) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 4 * 1048576) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const incoming = (j && j.day) ? j.day : j;
      if (!isDate(incoming && incoming.date)) return sendJSON(res, { ok: false, error: 'A valid date (YYYY-MM-DD) is required.' }, 400);
      const list = loadDays().slice();
      // One record per calendar date: an existing day for that date is updated,
      // even if the client sent a fresh id (double-submit safety).
      let idx = list.findIndex(d => d.id === _id(incoming.id) && _id(incoming.id));
      if (idx < 0) idx = list.findIndex(d => d.date === incoming.date);
      const prev = idx >= 0 ? list[idx] : null;
      if (prev && _id(incoming.id) && prev.id !== _id(incoming.id))
        return sendJSON(res, { ok: false, error: 'Another entry already covers that date.' }, 409);
      const day = normDay({ ...incoming, id: prev ? prev.id : incoming.id, updatedBy: who }, prev);
      day.week = weekParity(day.date, loadTimetable().settings);
      if (!prev) day.createdBy = who;
      // Attachments that were removed from the record lose their files too.
      if (prev) {
        const keep = new Set();
        for (const l of day.lessons) for (const a of l.attachments) keep.add(a.id);
        for (const l of prev.lessons || []) for (const a of l.attachments || []) if (!keep.has(a.id)) deleteAttachmentFile(prev.id, a);
      }
      if (idx >= 0) list[idx] = day; else list.push(day);
      try { saveDays(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, day });
    });
    return;
  }
  // ── Logging a single lesson straight from the timetable ────────────────────
  // The full day editor is the right tool for writing a day up properly. This pair
  // is for the other case: you are looking at this week's grid, you have a photo of
  // the page you just filled, and you want it attached to that lesson now. The
  // digital note is optional — the point is that the resource for that class exists.
  //
  // Uploads need a day id before the day is saved, so this hands one out: the
  // existing day's id for that date, or a fresh one. A draft id that is never saved
  // leaves an orphan upload folder, which the 24-hour sweep already collects.
  if (pathname === '/api/admin/day/draftid' && req.method === 'GET') {
    if (!requireAdminEither(req, res)) return;
    const date = _date(query.date);
    if (!date) return sendJSON(res, { ok: false, error: 'A valid date (YYYY-MM-DD) is required.' }, 400);
    const existing = findDayByDate(loadDays(), date);
    return sendJSON(res, { ok: true, date, id: existing ? existing.id : _newId(), exists: !!existing });
  }
  if (pathname === '/api/admin/day/lesson' && req.method === 'POST') {
    const who = requireAdminEither(req, res); if (!who) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const date = _date(j.date);
      if (!date) return sendJSON(res, { ok: false, error: 'A valid date (YYYY-MM-DD) is required.' }, 400);
      const list = loadDays().slice();
      let idx = list.findIndex(d => d.date === date);
      let day = idx >= 0 ? { ...list[idx], lessons: (list[idx].lessons || []).slice() } : null;
      if (!day) {
        const wantId = _id(j.dayId);
        day = normDay({ id: wantId || _newId(), date, visibility: j.visibility === 'members' ? 'members' : 'all', lessons: [] }, null);
        day.createdBy = who;
      }
      // Fill the lesson's identity from the timetable so an archived day still reads
      // correctly years later, exactly as the full editor does.
      const tt = loadTimetable();
      const slot = (tt.slots || []).find(s => s.id === _id(j.slotId)) || null;
      const subj = slot ? (tt.subjects || []).find(x => x.id === slot.subjectId) : null;
      const per  = slot ? (tt.settings.periods || []).find(p => p.id === slot.periodId) : null;

      const incoming = (j.lesson && typeof j.lesson === 'object') ? j.lesson : {};
      // Match an existing entry by slot, else by subject+period, so a second save
      // updates the lesson instead of duplicating it.
      let li = day.lessons.findIndex(l =>
        (slot && l.slotId && l.slotId === slot.id) ||
        (slot && !l.slotId && l.subjectId === slot.subjectId && l.periodId === slot.periodId) ||
        (!slot && _id(incoming.id) && l.id === _id(incoming.id)));
      const prevLesson = li >= 0 ? day.lessons[li] : null;

      const merged = normLesson({
        ...(prevLesson || {}),
        ...incoming,
        id: prevLesson ? prevLesson.id : _idOrNew(incoming.id),
        slotId:      slot ? slot.id : (prevLesson ? prevLesson.slotId : ''),
        subjectId:   slot ? slot.subjectId : (incoming.subjectId || (prevLesson && prevLesson.subjectId)),
        subject:     subj ? subj.name   : (incoming.subject   || (prevLesson && prevLesson.subject)),
        subjectHu:   subj ? subj.nameHu : (incoming.subjectHu || (prevLesson && prevLesson.subjectHu)),
        color:       subj ? subj.color  : (incoming.color     || (prevLesson && prevLesson.color)),
        periodId:    slot ? slot.periodId : (prevLesson && prevLesson.periodId),
        periodLabel: per  ? per.label : (incoming.periodLabel || (prevLesson && prevLesson.periodLabel)),
        start:       per  ? per.start : (incoming.start || (prevLesson && prevLesson.start)),
        end:         per  ? per.end   : (incoming.end   || (prevLesson && prevLesson.end)),
        room:        incoming.room    != null ? incoming.room    : (slot ? (slot.room    || (subj && subj.room))    : (prevLesson && prevLesson.room)),
        teacher:     incoming.teacher != null ? incoming.teacher : (slot ? (slot.teacher || (subj && subj.teacher)) : (prevLesson && prevLesson.teacher)),
      });

      // Attachments dropped from the lesson lose their files, as in the full editor.
      if (prevLesson) {
        const keep = new Set(merged.attachments.map(a => a.id));
        for (const a of prevLesson.attachments || []) if (!keep.has(a.id)) deleteAttachmentFile(day.id, a);
      }
      // Nothing written and nothing attached means "remove this entry".
      const isEmpty = !merged.what.trim() && !merged.homework.trim() && !merged.topics.length
                   && !merged.attachments.length && !merged.notes.length && merged.kind === 'lesson' && !merged.important;
      if (isEmpty && li >= 0) day.lessons.splice(li, 1);
      else if (li >= 0) day.lessons[li] = merged;
      else if (!isEmpty) day.lessons.push(merged);

      // Keep the day in timetable order so it reads like the day it was.
      const order = new Map((tt.settings.periods || []).map((p, i) => [p.id, i]));
      day.lessons.sort((a, b) => (order.get(a.periodId) ?? 99) - (order.get(b.periodId) ?? 99));

      if (typeof j.visibility === 'string') day.visibility = j.visibility === 'members' ? 'members' : 'all';
      day.updatedBy = who;
      day.week = weekParity(date, tt.settings);
      const saved = normDay(day, idx >= 0 ? list[idx] : null);
      saved.id = day.id;

      // A day emptied of every lesson and with nothing else written is deleted
      // rather than left as a blank card in the feed.
      const blank = !saved.lessons.length && !saved.title && !saved.titleHu && !saved.summary.trim() && !saved.summaryHu.trim();
      let out = list;
      if (blank && idx >= 0) { try { rmDirSync(dayFileDir(saved.id)); } catch {} out = list.filter((_, k) => k !== idx); }
      else if (blank) out = list;
      else if (idx >= 0) { out = list.slice(); out[idx] = saved; }
      else { out = list.concat([saved]); }
      try { saveDays(out); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, day: blank ? null : saved, removed: blank });
    });
    return;
  }
  if (pathname === '/api/admin/day/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDays();
      const day = list.find(d => d.id === String(j.id || '')) || (isDate(j.date) ? findDayByDate(list, j.date) : null);
      if (!day) return sendJSON(res, { ok: false, error: 'not found' }, 404);
      try { rmDirSync(dayFileDir(day.id)); } catch {}
      try { saveDays(list.filter(d => d !== day)); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }
  // Raw-body upload: the whole request body is the file. Avoids a multipart parser
  // (this server has no dependencies) and streams straight from the file input.
  //   POST /api/admin/day/upload?day=<dayId>&name=<filename>&kind=scan|file
  if (pathname === '/api/admin/day/upload' && req.method === 'POST') {
    if (!requireAdminEither(req, res)) return;
    if (!rateOk(req, 'dayupload', 300, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many uploads. Try again shortly.' }, 429);
    const dayId = _id(query.day);
    if (!dayId) return sendJSON(res, { ok: false, error: 'Missing day id.' }, 400);
    const rawName = String(query.name || 'file');
    const name = _str(path.basename(rawName.replace(/[\\/]/g, '_')), 200) || 'file';
    const ext = path.extname(name).toLowerCase();
    if (!ATTACH_EXTS.has(ext))
      return sendJSON(res, { ok: false, error: 'That file type is not allowed (' + (ext || 'no extension') + ').' }, 400);
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declared) && declared > ATTACH_MAX_BYTES)
      return sendJSON(res, { ok: false, error: 'File is too large (max ' + Math.round(ATTACH_MAX_BYTES / 1048576) + ' MB).' }, 413);
    const chunks = []; let total = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      total += c.length;
      if (total > ATTACH_MAX_BYTES) {
        // Answer before hanging up. Cutting the socket without a status left the
        // uploader looking at a network error instead of "file is too large".
        aborted = true; chunks.length = 0;
        try { sendJSON(res, { ok: false, error: 'File is too large (max ' + Math.round(ATTACH_MAX_BYTES / 1048576) + ' MB).' }, 413); } catch {}
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on('aborted', () => { aborted = true; });
    req.on('end', () => {
      if (aborted) return;
      if (!total) return sendJSON(res, { ok: false, error: 'Empty file.' }, 400);
      const attId = crypto.randomBytes(12).toString('hex');
      try {
        fs.mkdirSync(dayFileDir(dayId), { recursive: true });
        fs.writeFileSync(attachmentPath(dayId, attId, ext), Buffer.concat(chunks));
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const att = {
        id: attId, name, ext, size: total,
        mime: MIME[ext] || 'application/octet-stream',
        kind: query.kind === 'scan' ? 'scan' : 'file',
        caption: '', added: new Date().toISOString(),
      };
      return sendJSON(res, { ok: true, attachment: att, url: '/uploads/days/' + dayId + '/' + attId + ext });
    });
    return;
  }
  // Serve a day attachment. Visibility follows the day it belongs to; files that do
  // not yet belong to a saved day are admin-only (they are still being uploaded).
  if (pathname.toLowerCase().startsWith('/uploads/days/')) {
    const parts = decPath(pathname.slice('/uploads/days/'.length)).split('/').filter(Boolean);
    if (parts.length !== 2) { res.writeHead(404); return res.end('Not Found'); }
    const dayId = _id(parts[0]);
    const ext = path.extname(parts[1]).toLowerCase();
    const attId = path.basename(parts[1], ext);
    if (!dayId || !/^[0-9a-f]{24}$/.test(attId) || !ATTACH_EXTS.has(ext)) { res.writeHead(404); return res.end('Not Found'); }
    const day = loadDays().find(d => d.id === dayId) || null;
    // A file uploaded against a day that is not saved yet is only visible to an
    // admin — that is the draft state the quick-log panel is in while you are still
    // filling it in, so it must accept a site session too or the thumbnail of the
    // scan you just dropped is broken until you press Save.
    if (!day) { if (!adminActor(req)) { res.writeHead(404); return res.end('Not Found'); } }
    // 404, not 403: a members-only day must answer exactly like a date that was
    // never logged, or the status code alone confirms the day exists — the same
    // rule /api/day and /api/days/index already follow.
    else if (!canSeeDay(day, siteSession(req))) { res.writeHead(404); return res.end('Not Found'); }
    const att = day ? findAttachment(day, attId) : null;
    if (day && !att) { res.writeHead(404); return res.end('Not Found'); }
    const full = attachmentPath(dayId, attId, ext);
    const forceDl = query.download === '1' || !INLINE_EXTS.has(ext);
    if (att && !forceDl) res.setHeader('X-Attachment-Name', encodeURIComponent(att.name));
    return serveFile(res, req, full, forceDl ? (att ? att.name : true) : false);
  }

  // ── Note donations: a member offers a note, an admin audits it ─────────────
  // The donor's half. Every route here requires a signed-in session and only ever
  // touches that caller's own submission: there is no path through this block that
  // reads, alters or even confirms the existence of somebody else's donation.
  //
  // Flow: draft (gives uploads somewhere to live) → upload* → submit → the admin
  // half below decides. A donor may withdraw while it is still pending.

  // One open draft per account. Handing back the existing one rather than minting a
  // new id is what caps drafts at one per person — otherwise a loop over this route
  // is a free way to litter donations.json and the uploads directory.
  if (pathname === '/api/donate/draft' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    if (!rateOk(req, 'donate', 60, 60 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many donation actions. Try again later.' }, 429);
    const list = loadDonations();
    const meLc = String(s.username).toLowerCase();
    if (countPending(list, meLc) >= DONATE_MAX_PENDING_USER)
      return sendJSON(res, { ok: false, error: 'You already have ' + DONATE_MAX_PENDING_USER + ' donations waiting for review. Please wait for those first.' }, 429);
    if (countPending(list, null) >= DONATE_MAX_PENDING_TOTAL)
      return sendJSON(res, { ok: false, error: 'The review queue is full right now. Please try again later.' }, 503);
    let d = list.find(x => x.status === 'draft' && String(x.from).toLowerCase() === meLc) || null;
    if (!d) {
      d = normDonation({ id: _newId(), from: s.username, status: 'draft', created: new Date().toISOString(), items: [] });
      list.push(d);
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
    }
    return sendJSON(res, { ok: true, donation: publicDonation(d), limits: { maxItems: DONATE_MAX_ITEMS, maxBytes: DONATE_MAX_BYTES, textMax: DONATE_TEXT_MAX, exts: [...DONATE_FILE_EXTS] } });
  }

  // Raw-body upload into the caller's own draft, mirroring the day-attachment
  // route: the whole request body is the file, so there is no multipart parser.
  if (pathname === '/api/donate/upload' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    if (!rateOk(req, 'donateup', 120, 60 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many uploads. Try again shortly.' }, 429);
    const list = loadDonations();
    const d = findDonation(list, query.id);
    // 404 rather than 403 for a donation that is not the caller's: the status code
    // alone must not confirm that some other member's submission exists.
    if (!d || !isDonationOwner(d, s)) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
    if (d.status !== 'draft') return sendJSON(res, { ok: false, error: 'This donation has already been submitted.' }, 400);
    if ((d.items || []).length >= DONATE_MAX_ITEMS)
      return sendJSON(res, { ok: false, error: 'A donation can carry at most ' + DONATE_MAX_ITEMS + ' files.' }, 400);
    const name = _str(path.basename(String(query.name || 'file').replace(/[\\/]/g, '_')), 200) || 'file';
    const ext = path.extname(name).toLowerCase();
    if (!DONATE_FILE_EXTS.has(ext))
      return sendJSON(res, { ok: false, error: 'That file type is not accepted (' + (ext || 'no extension') + ').' }, 400);
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declared) && declared > DONATE_MAX_BYTES)
      return sendJSON(res, { ok: false, error: 'File is too large (max ' + Math.round(DONATE_MAX_BYTES / 1048576) + ' MB).' }, 413);
    const chunks = []; let total = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      total += c.length;
      if (total > DONATE_MAX_BYTES) {
        aborted = true; chunks.length = 0;
        try { sendJSON(res, { ok: false, error: 'File is too large (max ' + Math.round(DONATE_MAX_BYTES / 1048576) + ' MB).' }, 413); } catch {}
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on('aborted', () => { aborted = true; });
    req.on('end', () => {
      if (aborted) return;
      if (!total) return sendJSON(res, { ok: false, error: 'Empty file.' }, 400);
      // Re-read: the record may have changed while the body was in flight.
      const fresh = loadDonations();
      const cur = findDonation(fresh, d.id);
      if (!cur || !isDonationOwner(cur, s) || cur.status !== 'draft') return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if ((cur.items || []).length >= DONATE_MAX_ITEMS)
        return sendJSON(res, { ok: false, error: 'A donation can carry at most ' + DONATE_MAX_ITEMS + ' files.' }, 400);
      const itemId = crypto.randomBytes(12).toString('hex');
      try {
        fs.mkdirSync(donationDir(cur.id), { recursive: true });
        fs.writeFileSync(donationItemPath(cur.id, itemId, ext), Buffer.concat(chunks));
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const item = normDonationItem({ id: itemId, name, ext, size: total,
        kind: query.kind === 'scan' ? 'scan' : 'file', added: new Date().toISOString() });
      cur.items.push(item);
      try { saveDonations(fresh); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, item });
    });
    return;
  }

  if (pathname === '/api/donate/item/delete' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDonations();
      const d = findDonation(list, j.id);
      if (!d || !isDonationOwner(d, s)) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if (d.status !== 'draft') return sendJSON(res, { ok: false, error: 'This donation has already been submitted.' }, 400);
      const it = donationItem(d, j.item);
      if (!it) return sendJSON(res, { ok: false, error: 'File not found.' }, 404);
      try { fs.rmSync(donationItemPath(d.id, it.id, it.ext), { force: true }); } catch {}
      d.items = d.items.filter(x => x.id !== it.id);
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, donation: publicDonation(d) });
    });
    return;
  }

  // Submit: freezes the draft, writes the typed body (if any) as one more staged
  // file, and posts the review card to every admin.
  if (pathname === '/api/donate/submit' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    if (!rateOk(req, 'donate', 60, 60 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many donation actions. Try again later.' }, 429);
    // The typed note body dominates the request size, so the ceiling is the text
    // cap plus room for the metadata around it.
    let body = ''; req.on('data', c => { body += c; if (body.length > DONATE_TEXT_MAX + 32768) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDonations();
      const d = findDonation(list, j.id);
      if (!d || !isDonationOwner(d, s)) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if (d.status !== 'draft') return sendJSON(res, { ok: false, error: 'This donation has already been submitted.' }, 400);
      const meLc = String(s.username).toLowerCase();
      if (countPending(list, meLc) >= DONATE_MAX_PENDING_USER)
        return sendJSON(res, { ok: false, error: 'You already have ' + DONATE_MAX_PENDING_USER + ' donations waiting for review.' }, 429);
      if (countPending(list, null) >= DONATE_MAX_PENDING_TOTAL)
        return sendJSON(res, { ok: false, error: 'The review queue is full right now. Please try again later.' }, 503);

      const title = _str(j.title, 160);
      if (!title) return sendJSON(res, { ok: false, error: 'Give the note a title.' }, 400);

      // The typed body, if there is one.
      const text = typeof j.text === 'string' ? j.text : '';
      if (text.length > DONATE_TEXT_MAX)
        return sendJSON(res, { ok: false, error: 'That note is too long (max ' + Math.round(DONATE_TEXT_MAX / 1024) + ' KB).' }, 413);
      let textExt = String(j.textExt || '.tex').toLowerCase();
      if (!textExt.startsWith('.')) textExt = '.' + textExt;
      if (text.trim() && !DONATE_TEXT_EXTS.has(textExt))
        return sendJSON(res, { ok: false, error: 'Unsupported note type ' + textExt + '.' }, 400);
      if (text.trim() && (d.items || []).length >= DONATE_MAX_ITEMS)
        return sendJSON(res, { ok: false, error: 'A donation can carry at most ' + DONATE_MAX_ITEMS + ' files.' }, 400);
      if (!text.trim() && !(d.items || []).length)
        return sendJSON(res, { ok: false, error: 'Write a note or attach at least one file.' }, 400);

      if (text.trim()) {
        const itemId = crypto.randomBytes(12).toString('hex');
        const fname = safeNoteBase(title) + textExt;
        try {
          fs.mkdirSync(donationDir(d.id), { recursive: true });
          fs.writeFileSync(donationItemPath(d.id, itemId, textExt), text, 'utf8');
        } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
        d.items.push(normDonationItem({ id: itemId, name: fname, ext: textExt,
          size: Buffer.byteLength(text, 'utf8'), kind: 'text', added: new Date().toISOString() }));
      }

      d.title   = title;
      d.message = _multi(j.message, 4000);
      d.lang    = (j.lang === 'en' || j.lang === 'hu') ? j.lang : '';
      // A suggestion only. It is shown to the admin next to the folder picker and
      // is never used to resolve a path, so it needs no traversal guard — but it is
      // still normalised so it cannot be read as an absolute or parent path.
      d.suggestPath = _str(String(j.suggestPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.+/g, '.'), 512);
      d.subjectId   = _id(j.subjectId);
      d.subjectName = _str(j.subjectName, 80);
      d.subjectHu   = _str(j.subjectHu, 80);
      d.status  = 'pending';
      d.created = new Date().toISOString();
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      try { postDonationCard(d); } catch {}
      return sendJSON(res, { ok: true, donation: publicDonation(d) });
    });
    return;
  }

  if (pathname === '/api/donate/mine' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const meLc = String(s.username).toLowerCase();
    const mine = loadDonations().filter(d => String(d.from).toLowerCase() === meLc).map(publicDonation);
    return sendJSON(res, { ok: true, donations: mine });
  }

  if (pathname === '/api/donate/withdraw' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDonations();
      const d = findDonation(list, j.id);
      if (!d || !isDonationOwner(d, s)) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if (d.status !== 'pending' && d.status !== 'draft')
        return sendJSON(res, { ok: false, error: 'That donation has already been reviewed.' }, 400);
      const wasPending = d.status === 'pending';
      d.status = 'withdrawn';
      d.decided = new Date().toISOString();
      d.items = [];
      try { rmDirSync(donationDir(d.id)); } catch {}
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      if (wasPending) { try { settleDonationCards(d, 'withdrawn', '', s.username); } catch {} }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Note donations: the admin's half ───────────────────────────────────────
  // Reachable with either credential (the DevTools header token or an admin site
  // session), like the other admin actions that are triggered from the site — an
  // admin should be able to decline a submission straight from the chat card.

  if (pathname === '/api/admin/donations' && req.method === 'GET') {
    if (!requireAdminEither(req, res)) return;
    const want = String(query.status || '').trim();
    let list = loadDonations().filter(d => d.status !== 'draft');
    if (DONATE_STATUSES.includes(want)) list = list.filter(d => d.status === want);
    // Pending first: the queue is a to-do list, not a history.
    list.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1)
      || String(b.created || '').localeCompare(String(a.created || '')));
    return sendJSON(res, {
      ok: true,
      pending: countPending(loadDonations(), null),
      donations: list.map(d => ({ ...publicDonation(d), from: d.from, decidedBy: d.decidedBy })),
    });
  }

  // The source of one text item, so the reviewer can read (and correct) it before
  // it becomes a note. Binary items are fetched from /uploads/donations/ instead.
  if (pathname === '/api/admin/donation/text' && req.method === 'GET') {
    if (!requireAdminEither(req, res)) return;
    const d = findDonation(loadDonations(), query.id);
    if (!d) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
    const it = donationItem(d, query.item);
    if (!it) return sendJSON(res, { ok: false, error: 'File not found.' }, 404);
    if (!DONATE_TEXT_EXTS.has(it.ext)) return sendJSON(res, { ok: false, error: 'Not a text file.' }, 400);
    let text = '';
    try { text = fs.readFileSync(donationItemPath(d.id, it.id, it.ext), 'utf8'); }
    catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
    return sendJSON(res, { ok: true, item: it, text: text.slice(0, DONATE_TEXT_MAX) });
  }

  // Render a donated .tex so the reviewer sees the note rather than its source.
  //
  // This is the one place the server runs a stranger's LaTeX, so it is worth being
  // explicit about what holds it: the same sandbox every archive note compiles in —
  // -no-shell-escape (no \write18), openin_any/openout_any=p (no reads or writes
  // outside the job's own directory, no dotfiles, no absolute or parent paths), a
  // copy into a throwaway temp dir that is deleted afterwards, a hard 120-second
  // kill, and the global concurrency limiter. The render is never cached, so a
  // declined submission leaves nothing behind. It is admin-triggered only: a donor
  // cannot make the server compile their own submission.
  if (pathname === '/api/admin/donation/compile' && req.method === 'POST') {
    if (!requireAdminEither(req, res)) return;
    if (!rateOk(req, 'doncompile', 60, 10 * 60 * 1000)) return sendJSON(res, { success: false, log: 'Too many preview builds — try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const d = findDonation(loadDonations(), j.id);
      if (!d) return sendJSON(res, { success: false, log: 'Donation not found.' }, 404);
      const it = donationItem(d, j.item);
      if (!it || it.ext !== '.tex') return sendJSON(res, { success: false, log: 'Not a LaTeX file.' }, 400);
      if (!PDFLATEX_OK) return sendJSON(res, { success: false, log: 'The PDF compiler is not available on the server.' });
      // Stage under the original names first: pdflatex resolves \includegraphics by
      // the name written in the source, and staging stores files by item id.
      let work = null, result;
      try {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'kidon_'));
        const map = materializeDonation(d, work);
        const fname = map.get(it.id);
        if (!fname) return sendJSON(res, { success: false, log: 'That file is missing from the server.' }, 404);
        result = await compileTex(path.join(work, fname), 'donation/' + d.id, 'en', { cache: false });
      } catch (e) {
        return sendJSON(res, { success: false, log: redactPaths('Compile failed: ' + (e && e.message || e)) }, 500);
      } finally { if (work) { try { rmDirSync(work); } catch {} } }
      if (result.busy) return sendJSON(res, { success: false, log: result.log }, 503);
      if (!result.success) return sendJSON(res, { success: false, log: result.log });
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': String(result.data.length),
        'Content-Disposition': 'inline; filename="' + encodeURIComponent(path.basename(it.name, '.tex')) + '.pdf"',
        'Cache-Control': 'no-store',
      });
      return res.end(result.data);
    });
    return;
  }

  // Accept: one staged file becomes a note in the archive, optionally with its
  // figures alongside. Everything the note ends up being — where it lives, what it
  // is called, its metadata, who can read it — is decided here by the admin, never
  // by the donor.
  if (pathname === '/api/admin/donation/accept' && req.method === 'POST') {
    const actor = requireAdminEither(req, res); if (!actor) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > DONATE_TEXT_MAX + 32768) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDonations();
      const d = findDonation(list, j.id);
      if (!d) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if (d.status !== 'pending') return sendJSON(res, { ok: false, error: 'That donation has already been reviewed.' }, 400);
      const it = donationItem(d, j.item);
      if (!it) return sendJSON(res, { ok: false, error: 'Choose which file becomes the note.' }, 400);

      const lang = _lang(j.lang);
      const base = adminDataDir(lang);
      // The extension is the file's own. A .pdf cannot be filed as a .tex, and
      // letting the reviewer retype it is just a way to create a note that the
      // viewer will try to compile and fail on.
      const nameBase = safeNoteBase(j.filename ? String(j.filename).replace(/\.[^.]*$/, '') : path.basename(it.name, it.ext));
      const filename = nameBase + it.ext;
      // Trailing slashes are stripped before resolving: safePath compares against
      // `normalize(base) + sep`, so a base that already ends in a separator can
      // never match itself and the second call would 403 on a perfectly ordinary
      // folder. Callers routinely send "STEM/".
      const dir = String(j.dir || '').replace(/[\\/]+$/, '');
      let folderFull, fileFull;
      try { folderFull = safePath(base, dir); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      try { fileFull = safePath(folderFull, filename); } catch { return sendJSON(res, { ok: false, error: 'forbidden' }, 403); }
      if (fs.existsSync(fileFull) && !j.overwrite)
        return sendJSON(res, { ok: false, error: 'A note called "' + filename + '" is already there. Rename it, or confirm the overwrite.', exists: true }, 409);

      const srcPath = donationItemPath(d.id, it.id, it.ext);
      if (!fs.existsSync(srcPath)) return sendJSON(res, { ok: false, error: 'That file is missing from the server.' }, 404);

      // Extra staged files (a .tex’s figures, say) travel with it under their own
      // names, into the same folder.
      const extras = _list(j.extras).map(x => _id(x)).filter(Boolean);
      const written = [];
      try {
        fs.mkdirSync(folderFull, { recursive: true });
        // A reviewer’s corrections to a text note are written instead of the raw
        // submission — the audit is allowed to fix things, not only to say yes.
        if (typeof j.content === 'string' && DONATE_TEXT_EXTS.has(it.ext)) {
          if (j.content.length > DONATE_TEXT_MAX) return sendJSON(res, { ok: false, error: 'That note is too long.' }, 413);
          fs.writeFileSync(fileFull, j.content, 'utf8');
          try { fs.rmSync(srcPath, { force: true }); } catch {}
        } else {
          moveFileSync(srcPath, fileFull);
        }
        written.push(filename);
        const used = new Set([filename.toLowerCase()]);
        for (const exId of extras) {
          if (exId === it.id) continue;
          const ex = donationItem(d, exId); if (!ex) continue;
          let exBase = safeNoteBase(path.basename(ex.name, ex.ext));
          let exName = exBase + ex.ext, n = 2;
          while (used.has(exName.toLowerCase())) exName = exBase + '-' + (n++) + ex.ext;
          let exFull; try { exFull = safePath(folderFull, exName); } catch { continue; }
          if (fs.existsSync(exFull)) continue;
          try { moveFileSync(donationItemPath(d.id, ex.id, ex.ext), exFull); used.add(exName.toLowerCase()); written.push(exName); } catch {}
        }
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }

      // Metadata. The donor is credited in `authors` unless the reviewer turned that
      // off; `owners` is left empty on purpose, so the note is managed by admins —
      // accepting a donation transfers the note, not the account's rights over it.
      const m = (j.meta && typeof j.meta === 'object') ? j.meta : {};
      let authors = Array.isArray(m.authors) ? m.authors.map(x => String(x).trim()).filter(Boolean)
                  : String(m.authors || '').split(',').map(x => x.trim()).filter(Boolean);
      if (j.credit !== false && !authors.some(a => a.toLowerCase() === String(d.from).toLowerCase())) authors.push(d.from);
      const secs = parseDataTxtMutable(folderFull);
      const display = stripDisplayName(filename);
      for (const k of Object.keys(secs))
        if (stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase()) delete secs[k];
      secs[display] = {
        tags: Array.isArray(m.tags) ? m.tags.join(', ') : String(m.tags || ''),
        authors: authors.join(', '),
        date: _str(m.date, 40) || new Date().toISOString().slice(0, 10),
        description: _multi(m.description, 2000),
        important: m.important ? 'true' : '',
        can_see:  (m.canSee === 'members' || m.canSee === 'whitelist') ? m.canSee : 'all',
        can_read: (m.canRead === 'members' || m.canRead === 'whitelist') ? m.canRead : 'all',
        read_requests: m.readRequests ? 'true' : '',
        see_allow:  m.canSee === 'whitelist' ? _str(Array.isArray(m.seeAllow) ? m.seeAllow.join(', ') : m.seeAllow, 512) : '',
        read_allow: m.canRead === 'whitelist' ? _str(Array.isArray(m.readAllow) ? m.readAllow.join(', ') : m.readAllow, 512) : '',
        alt_hu: _str(m.altHu, 200), alt_en: _str(m.altEn, 200),
      };
      try { writeDataTxt(folderFull, secs); } catch {}

      // Derive the stored path from the *resolved* folder, never from the raw `dir`
      // the reviewer sent. safePath sanitises rather than rejects (a leading `../`
      // is stripped, `./` and trailing slashes are normalised away), so echoing the
      // input back would record a path that does not describe where the file
      // actually is — and that path is what the donor is shown and what the
      // "open the note" link resolves.
      const relPath = path.relative(base, fileFull).split(path.sep).join('/');
      d.status = 'accepted';
      d.decided = new Date().toISOString();
      d.decidedBy = actor;
      d.reason = _multi(j.reason, 2000);
      d.result = { path: relPath, lang };
      d.items = [];
      try { rmDirSync(donationDir(d.id)); } catch {}
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      try { settleDonationCards(d, 'accepted', d.reason, actor); } catch {}
      return sendJSON(res, { ok: true, path: relPath, lang, written });
    });
    return;
  }

  if (pathname === '/api/admin/donation/decline' && req.method === 'POST') {
    const actor = requireAdminEither(req, res); if (!actor) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const list = loadDonations();
      const d = findDonation(list, j.id);
      if (!d) return sendJSON(res, { ok: false, error: 'Donation not found.' }, 404);
      if (d.status !== 'pending') return sendJSON(res, { ok: false, error: 'That donation has already been reviewed.' }, 400);
      d.status = 'declined';
      d.decided = new Date().toISOString();
      d.decidedBy = actor;
      d.reason = _multi(j.reason, 2000);
      d.items = [];
      // A declined submission is deleted, not kept: we asked for it, it was not
      // taken, and holding somebody's unpublished work indefinitely is not ours
      // to do. The record of the decision stays.
      try { rmDirSync(donationDir(d.id)); } catch {}
      try { saveDonations(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      try { settleDonationCards(d, 'declined', d.reason, actor); } catch {}
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // Serve one staged file, to its donor or to an admin. 404 for everyone else —
  // the same rule the day attachments follow, so the status code alone never
  // confirms that a given submission exists.
  if (pathname.toLowerCase().startsWith('/uploads/donations/')) {
    const parts = decPath(pathname.slice('/uploads/donations/'.length)).split('/').filter(Boolean);
    if (parts.length !== 2) { res.writeHead(404); return res.end('Not Found'); }
    const donId = _id(parts[0]);
    const ext = path.extname(parts[1]).toLowerCase();
    const itemId = path.basename(parts[1], ext);
    if (!donId || !/^[0-9a-f]{24}$/.test(itemId) || !DONATE_ALL_EXTS.has(ext)) { res.writeHead(404); return res.end('Not Found'); }
    const d = findDonation(loadDonations(), donId);
    if (!d || !canSeeDonation(d, req)) { res.writeHead(404); return res.end('Not Found'); }
    const it = donationItem(d, itemId);
    if (!it || it.ext !== ext) { res.writeHead(404); return res.end('Not Found'); }
    // Unreviewed content from an account nobody has vouched for: everything that is
    // not an image or a PDF is handed over as a download rather than rendered in the
    // page, and the name comes from our own record, not from the URL.
    const forceDl = query.download === '1' || !(ext === '.pdf' || IMAGE_EXTS.has(ext));
    return serveFile(res, req, donationItemPath(d.id, it.id, it.ext), forceDl ? it.name : false);
  }

  if (pathname === '/api/music/list') return sendJSON(res, listMusic());
  if (pathname.startsWith('/music/')) {
    if (!fs.existsSync(__MUSIC)) { res.writeHead(404); return res.end('Not Found'); }
    let full; try { full = safePath(__MUSIC, decPath(pathname.slice(7))); } catch { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, req, full);
  }

  // Data files
  if (pathname.startsWith('/data/')) {
    const useHu = query.lang === 'hu' && HAS_DUAL_LANG;
    const dataDir = useHu ? __DATA_HU : __DATA;
    // Decode once, here: safePath, canViewNote and the grant key must all agree on
    // the same (decoded) relative path, or a granted note stays 403 for its grantee.
    const _dataRel = decPath(pathname.slice(6));
    if (/(^|\/)data\.txt$/i.test(_dataRel)) { res.writeHead(404); return res.end('Not Found'); }
    let full; try { full = safePath(dataDir, _dataRel); } catch { res.writeHead(403); return res.end('Forbidden'); }
    if (!canViewNote(req, _dataRel, query.lang)) { res.writeHead(403); return res.end('Sign-in required'); }
    return serveFile(res, req, full, !!query.download);
  }

  // Article pages
  if (pathname.startsWith('/articles/')) {
    const articleFile = decPath(pathname.slice(10)); let full = null;
    if (query.lang === 'hu' && fs.existsSync(__ARTICLES_HU)) {
      try { const p = safePath(__ARTICLES_HU, articleFile); if (fs.existsSync(p)) full = p; } catch {}
    }
    if (!full) { try { full = safePath(__ARTICLES, articleFile); } catch { res.writeHead(403); return res.end('Forbidden'); } }
    return serveFile(res, req, full);
  }

  // Static files
  const rel = decPath(pathname === '/' ? 'index.html' : pathname.slice(1));
  if (isProtectedStatic(rel)) return notFoundPage(res, req, pathname);
  let full; try { full = safePath(__WEBSITE, rel); } catch { res.writeHead(403); return res.end('Forbidden'); }
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch {}
  if (full === path.join(__WEBSITE, 'index.html')) return serveHtmlShell(res, req, full);
  try { if (!fs.statSync(full).isFile()) throw 0; } catch { return notFoundPage(res, req, pathname); }
  return serveFile(res, req, full);
});

// ── Startup ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const pdflatexOk = PDFLATEX_OK;
  console.log(`\n  ╔════════════════════════════════════════╗`);
  console.log(`  ║  ✦  Knowledge Index Server              ║`);
  console.log(`  ║  ➜  http://localhost:${PORT}             ║`);
  console.log(`  ╚════════════════════════════════════════╝\n`);
  console.log(`  Data (EN)  : ${__DATA}${fs.existsSync(__DATA) ? ' ✓' : ' ✗ MISSING'}`);
  console.log(`  Data (HU)  : ${__DATA_HU}${fs.existsSync(__DATA_HU) ? ' ✓' : ' (not present — single-language mode)'}`);
  console.log(`  Dual-lang  : ${HAS_DUAL_LANG}`);
  console.log(`  Music      : ${__MUSIC}${fs.existsSync(__MUSIC) ? ' ✓' : ' (not present)'}`);
  console.log(`  PDF Cache  : ${__CACHE}`);
  console.log(`  Admins     : ${__ADMINS}${fs.existsSync(__ADMINS) ? ' ✓ (' + loadAdmins().length + ')' : ' ✗ (run: node make-admin.js <user> <pass>)'}`);
  console.log(`  Users      : ${__USERS}${fs.existsSync(__USERS) ? ' ✓ (' + loadUsers().length + ')' : ' (none — run: node make-user.js <user> <pass>)'}`);
  console.log(`  pdflatex   : ${PDFLATEX} ${pdflatexOk ? '✓' : '✗ NOT FOUND'}\n`);
  if (!pdflatexOk) console.warn(`  ⚠  pdflatex missing — install TeX Live: sudo apt-get install texlive-full\n`);
  if (!fs.existsSync(__DATA)) console.warn(`  ⚠  Data dir missing: ${__DATA} — create it and add .tex files.\n`);
  // Day-attachment store + a periodic sweep of files whose day was never saved.
  try { fs.mkdirSync(__DAY_FILES, { recursive: true }); } catch {}
  setTimeout(() => { try { sweepOrphanDayFiles(); } catch {} }, 20000).unref?.();
  setInterval(() => { try { sweepOrphanDayFiles(); } catch {} }, 6 * 3600 * 1000).unref?.();
  // Donation staging needs the same collector: a draft nobody submitted leaves a
  // folder behind exactly the way an unsaved day does.
  setTimeout(() => { try { sweepOrphanDonationFiles(); } catch {} }, 25000).unref?.();
  setInterval(() => { try { sweepOrphanDonationFiles(); } catch {} }, 6 * 3600 * 1000).unref?.();
  // Non-blocking background precompilation
  setTimeout(() => {
    if (pdflatexOk && fs.existsSync(__DATA)) {
      console.log('  ⟳  Background precompilation starting…');
      autoPrecompile(__DATA, 'en');
      if (HAS_DUAL_LANG) autoPrecompile(__DATA_HU, 'hu');
    }
  }, 3000);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n  ✗ Port ${PORT} in use. Try: PORT=3001 node server.js\n`);
  else console.error(err);
  process.exit(1);
});