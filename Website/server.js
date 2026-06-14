#!/usr/bin/env node
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const os     = require('os');
const crypto = require('crypto');
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

fs.mkdirSync(__CACHE, { recursive: true });

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
function safePath(base, relPath) {
  const norm = path.normalize(decodeURIComponent(relPath)).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(base, norm);
  if (!full.startsWith(path.normalize(base) + path.sep) && full !== path.normalize(base))
    throw new Error('Path traversal blocked');
  return full;
}

// Never expose server source, credential files, dotfiles (.git, .pdf-cache), or tests
// over HTTP — important once the repo is public on GitHub.
const PROTECTED_FILES = new Set(['admins.json', 'users.json', 'server.js',
  'make-admin.js', 'make-user.js', 'package.json', 'package-lock.json']);
function isProtectedStatic(rel) {
  const parts = String(rel).split('/').filter(Boolean);
  if (parts.some(p => p.startsWith('.'))) return true;        // .git, .pdf-cache, dotfiles
  if (parts[0] === 'tests' || parts[0] === 'node_modules') return true;
  return PROTECTED_FILES.has(parts[parts.length - 1] || '');
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, req, fullPath, forceDownload = false) {
  const ext  = path.extname(fullPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let stat;
  try { stat = fs.statSync(fullPath); }
  catch { res.writeHead(404); res.end('Not Found'); return; }

  const headers = {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  if (forceDownload)
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(fullPath))}"`;

  const rangeHeader = req && req.headers && req.headers.range;
  if (rangeHeader && !forceDownload) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunk = end - start + 1;
    headers['Content-Range']  = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = String(chunk);
    res.writeHead(206, headers);
    fs.createReadStream(fullPath, { start, end }).pipe(res);
    return;
  }
  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(fullPath).pipe(res);
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
function parseDataTxt(dir) {
  const filePath = path.join(dir, 'data.txt');
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

function findMeta(fileName, sections) {
  const dl = stripDisplayName(fileName).toLowerCase();
  for (const [key, val] of Object.entries(sections)) {
    if (stripDisplayName(key + '.x').replace(/\.x$/, '').toLowerCase() === dl) return val;
  }
  return null;
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
    important:   meta.important  === 'true',
    description: meta.description || null,
    altHu:       meta.alt_hu      || null,
    altEn:       meta.alt_en      || null,
    visibility:  meta.visibility === 'members' ? 'members' : 'public',
    whitelist:   meta.allow ? meta.allow.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [],
  };
}

// ── Single-dir tree ────────────────────────────────────────────────────────────
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
function buildMergedTree(enDir, huDir, rel = '') {
  let enEntries, huEntries;
  try { enEntries = fs.readdirSync(enDir, { withFileTypes: true }); } catch { enEntries = []; }
  try { huEntries = fs.readdirSync(huDir, { withFileTypes: true }); } catch { huEntries = []; }

  const enSecs = parseDataTxt(enDir);
  const huSecs = parseDataTxt(huDir);
  const result = [];
  const huMatched = new Set();
  const enFolderNames = new Set(enEntries.filter(e => e.isDirectory()).map(e => e.name));

  function findByDisplay(entries, displayName) {
    const dl = displayName.toLowerCase();
    return entries.find(e => e.isFile && e.isFile() && stripDisplayName(e.name).toLowerCase() === dl);
  }

  // EN (primary) entries
  for (const e of enEntries) {
    if (e.name === 'data.txt') continue;
    const childRelEn = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = buildMergedTree(path.join(enDir, e.name), path.join(huDir, e.name), childRelEn);
      let mtime = null;
      try { mtime = fs.statSync(path.join(enDir, e.name)).mtime.toISOString(); } catch {}
      result.push({ name: e.name, type: 'folder', path: childRelEn, children, count: children.length, mtime });
      continue;
    }
    const meta = findMeta(e.name, enSecs) || {};
    const huM  = meta.alt_hu ? findByDisplay(huEntries, meta.alt_hu) : null
              || findByDisplay(huEntries, stripDisplayName(e.name));
    if (huM) huMatched.add(huM.name);
    const huRelPath = huM ? (rel ? `${rel}/${huM.name}` : huM.name) : null;
    const m = fileMeta(enDir, e.name, enSecs);
    if (huM) { const hv = findMeta(huM.name, huSecs) || {}; if (hv.visibility === 'members') m.visibility = 'members'; }
    result.push({ ...m, name: e.name, path: childRelEn,
      enAvailable: true, huAvailable: !!huM,
      enPath: childRelEn, huPath: huRelPath,
      enName: e.name, huName: huM ? huM.name : null });
  }

  // HU-only entries (not in primary dir)
  for (const e of huEntries) {
    if (e.name === 'data.txt') continue;
    if (e.isDirectory()) {
      if (enFolderNames.has(e.name)) continue;
      const childRelHu = rel ? `${rel}/${e.name}` : e.name;
      const children = buildMergedTree(path.join(enDir, e.name), path.join(huDir, e.name), childRelHu);
      let mtime = null;
      try { mtime = fs.statSync(path.join(huDir, e.name)).mtime.toISOString(); } catch {}
      result.push({ name: e.name, type: 'folder', path: childRelHu, children, count: children.length, mtime });
      continue;
    }
    if (!e.isFile || !e.isFile()) continue;
    if (huMatched.has(e.name)) continue;
    const childRelHu = rel ? `${rel}/${e.name}` : e.name;
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
  if (!node || node.visibility !== 'members') return true;
  if (!viewer || !viewer.username) return false;
  const wl = node.whitelist;
  if (!wl || !wl.length) return true;
  if (viewer.role === 'admin') return true;
  return wl.includes(String(viewer.username).toLowerCase());
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
function noteVisibility(relPath, lang) {
  const isMembers = (base, rel) => {
    try {
      const full = safePath(base, rel);
      const meta = findMeta(path.basename(full), parseDataTxt(path.dirname(full))) || {};
      return meta.visibility === 'members';
    } catch { return false; }
  };
  const huPrimary = (lang === 'hu' && HAS_DUAL_LANG);
  const base = huPrimary ? __DATA_HU : __DATA;
  if (isMembers(base, relPath)) return 'members';
  if (HAS_DUAL_LANG) {
    const other = huPrimary ? __DATA : __DATA_HU;
    try {
      const baseFull = safePath(base, relPath);
      const relDir   = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      const otherDir = safePath(other, relDir);
      const display  = stripDisplayName(path.basename(baseFull)).toLowerCase();
      let ents = []; try { ents = fs.readdirSync(otherDir); } catch {}
      const match = ents.find(n => stripDisplayName(n).toLowerCase() === display);
      if (match && (findMeta(match, parseDataTxt(otherDir)) || {}).visibility === 'members') return 'members';
    } catch {}
  }
  return 'public';
}
// Whitelist (lowercased usernames) declared on a note's own data.txt.
function noteWhitelist(relPath, lang) {
  try {
    const base = (lang === 'hu' && HAS_DUAL_LANG) ? __DATA_HU : __DATA;
    const full = safePath(base, relPath);
    const meta = findMeta(path.basename(full), parseDataTxt(path.dirname(full))) || {};
    return meta.allow ? meta.allow.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : [];
  } catch { return []; }
}
// Authoritative content-access check used by /api/file, /data and /api/compile.
function canViewNote(req, relPath, lang) {
  if (noteVisibility(relPath, lang) !== 'members') return true;
  const s = siteSession(req);
  if (!s) return false;
  if (s.role === 'admin') return true;
  const wl = noteWhitelist(relPath, lang);
  if (!wl.length) return true;
  return wl.includes(String(s.username).toLowerCase());
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
      out.push({ name: e.name, type: 'folder', path: childRel, children, count: children.length, mtime });
      continue;
    }
    const m    = fileMeta(primaryDir, e.name, secs);
    const meta = findMeta(e.name, secs) || {};
    let counter = null;
    if (otherExists) {
      const altKey    = (primaryLang === 'en' ? meta.alt_hu : meta.alt_en);
      const myDisplay = stripDisplayName(e.name).toLowerCase();
      const want      = (altKey || stripDisplayName(e.name)).toLowerCase();
      // forward: this note names its counterpart, or an identical display name exists
      counter = otherEntries.find(o => o.isFile && o.isFile() && stripDisplayName(o.name).toLowerCase() === want)
             || otherEntries.find(o => o.isFile && o.isFile() && stripDisplayName(o.name).toLowerCase() === myDisplay);
      // reverse: a note in the other dir names THIS note via its alt key
      if (!counter) {
        for (const o of otherEntries) {
          if (!(o.isFile && o.isFile())) continue;
          const om = findMeta(o.name, otherSecs) || {};
          const back = (primaryLang === 'hu') ? om.alt_hu : om.alt_en;
          if (back && back.toLowerCase() === myDisplay) { counter = o; break; }
        }
      }
    }
    const counterRel = counter ? (rel ? `${rel}/${counter.name}` : counter.name) : null;
    if (counter) { const cm = findMeta(counter.name, otherSecs) || {}; if (cm.visibility === 'members') m.visibility = 'members'; }
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

// ── On-demand compile (synchronous — runs in request handler) ─────────────────
function compileTexSync(fullTex, texPath, lang) {
  const texName = path.basename(fullTex);
  const texBase = texName.replace(/\.tex$/i, '');
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ki_'));
  try {
    copyDirSync(path.dirname(fullTex), tmpDir);
    const args = ['-interaction=nonstopmode', '-file-line-error', texName];
    const opts = {
      cwd: tmpDir,
      env: { ...process.env,
        TEXMFHOME: process.env.TEXMFHOME || '/usr/share/texmf',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    };
    const r1 = spawnSync(PDFLATEX, args, opts);
    const r2 = spawnSync(PDFLATEX, args, opts);
    const pdfPath = path.join(tmpDir, texBase + '.pdf');
    if (fs.existsSync(pdfPath)) {
      const data = fs.readFileSync(pdfPath);
      savePdfCache(texPath, lang, data);
      rmDirSync(tmpDir);
      return { success: true, data, warnings: r2.status !== 0 };
    }
    const parts = [];
    for (const r of [r1, r2]) {
      if (r && r.stdout) parts.push(r.stdout.toString());
      if (r && r.stderr) parts.push(r.stderr.toString());
    }
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
    rmDirSync(tmpDir);
    return { success: false, log: (r2.status === null ? 'pdflatex killed\n\n' : `exit ${r2.status}\n\n`) + parts.join('\n').trim() };
  } catch (err) { rmDirSync(tmpDir); return { success: false, log: `Error: ${err.message}` }; }
}

// ── Background precompile queue (non-blocking via async child processes) ───────
const preQueue   = [];
const preStatus  = {};
let   preRunning = false;

function enqueuePrecompile(texPath, lang) {
  const key = `${lang}:${texPath}`;
  if (preStatus[key] && ['queued', 'compiling'].includes(preStatus[key].state)) return;
  preStatus[key] = { state: 'queued', ts: Date.now() };
  preQueue.push({ texPath, lang });
  schedulePreQueue();
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
  };
  const args = ['-interaction=nonstopmode', '-file-line-error', texName];

  function onDone(exitOk) {
    const pdfPath = path.join(tmpDir, texBase + '.pdf');
    if (fs.existsSync(pdfPath)) {
      try { savePdfCache(texPath, lang, fs.readFileSync(pdfPath)); } catch {}
      preStatus[key] = { state: 'done', ts: Date.now() };
    } else {
      preStatus[key] = { state: 'error', msg: 'no pdf', ts: Date.now() };
    }
    rmDirSync(tmpDir);
    preRunning = false;
    schedulePreQueue();
  }

  const c1 = spawn(PDFLATEX, args, { cwd: tmpDir, env });
  c1.on('error', () => { preStatus[key] = { state: 'error', msg: 'spawn failed', ts: Date.now() }; rmDirSync(tmpDir); preRunning = false; schedulePreQueue(); });
  c1.on('close', () => {
    const c2 = spawn(PDFLATEX, args, { cwd: tmpDir, env });
    c2.on('error', () => { onDone(false); });
    c2.on('close', () => { onDone(true); });
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
  let body = '';
  req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
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
      return sendJSON(res, { success: false, log: `File not found:\n  ${fullTex}` });

    // Cache hit
    if (isCacheValid(filePath, lang, fullTex)) {
      const cached = loadPdfCache(filePath, lang);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf', 'Content-Length': String(cached.length),
          'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(filePath, '.tex'))}.pdf"`,
          'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-From-Cache': 'true',
        });
        return res.end(cached);
      }
    }

    const chk = spawnSync(PDFLATEX, ['--version'], { timeout: 8000 });
    if (chk.status !== 0 && !chk.stdout)
      return sendJSON(res, { success: false, log: `pdflatex not found at: ${PDFLATEX}\nInstall TeX Live: sudo apt-get install texlive-full` });

    const result = compileTexSync(fullTex, filePath, lang);
    if (result.success) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': String(result.data.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(filePath, '.tex'))}.pdf"`,
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        'X-Compile-Warnings': result.warnings ? 'true' : 'false',
      });
      return res.end(result.data);
    }
    return sendJSON(res, { success: false, log: result.log });
  });
}

// ── Changelog ─────────────────────────────────────────────────────────────────
function readChangelog()  { try { return JSON.parse(fs.readFileSync(__CHANGELOG, 'utf8')); } catch { return []; } }
function writeChangelog(e){ fs.writeFileSync(__CHANGELOG, JSON.stringify(e, null, 2), 'utf8'); }

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
function saveUsers(list) { fs.writeFileSync(__USERS, JSON.stringify(list, null, 2) + '\n', 'utf8'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}
// Constant-time credential check against a list of { username, salt, hash }
function verifyAgainst(records, username, password) {
  if (!username || !password) return null;
  const rec = (records || []).find(a =>
    a && a.username && String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!rec || !rec.salt || !rec.hash) return null;
  let derived;
  try { derived = crypto.scryptSync(String(password), rec.salt, 32); }
  catch { return null; }
  let stored;
  try { stored = Buffer.from(rec.hash, 'hex'); } catch { return null; }
  if (derived.length !== stored.length) return null;
  return crypto.timingSafeEqual(derived, stored) ? rec : null;
}
function verifyAdmin(username, password) { return verifyAgainst(loadAdmins(), username, password); }
function verifyUser(username, password)  { return verifyAgainst(loadUsers(),  username, password); }

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
// Site session — cookie first (so <img>/<video>/downloads carry it), then header
function siteSession(req) {
  return getSession((req.headers && req.headers['x-auth-token']) || '')
      || getSession(parseCookies(req)[SITE_COOKIE] || '');
}
function isLoggedIn(req) { return !!siteSession(req); }
function reqIsHttps(req) {
  return (req.headers && req.headers['x-forwarded-proto'] === 'https')
      || !!(req.socket && req.socket.encrypted) || !!(req.connection && req.connection.encrypted);
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
  const xf = ((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateOk(req, bucket, limit, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  let r = RL.get(key);
  if (!r || r.reset < now) { r = { count: 0, reset: now + windowMs }; RL.set(key, r); }
  r.count++;
  return r.count <= limit;
}

// ── data.txt serialization (DevTools authoring) ───────────────────────────────
const DATA_TXT_HEADER =
  '# Managed by Digitalization DevTools.\n' +
  '# Each [Section] header is a note display name (filename without extension or {tags}).\n' +
  '# Keys: tags, authors, date, important, visibility (public|members), description, alt-hu, alt-en\n';

function serializeDataTxt(sections) {
  let out = DATA_TXT_HEADER + '\n';
  for (const [name, meta] of Object.entries(sections || {})) {
    if (!name || !meta) continue;
    out += `[${name}]\n`;
    const order   = ['tags', 'authors', 'date', 'important', 'visibility', 'allow', 'description', 'alt_hu', 'alt_en'];
    const keyName = { alt_hu: 'alt-hu', alt_en: 'alt-en' };
    for (const k of order) {
      let v = meta[k];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) v = v.join(', ');
      if (k === 'important') { if (v === true || v === 'true') v = 'true'; else continue; }
      if (k === 'visibility') { if (v === 'members') v = 'members'; else continue; }
      if (k === 'allow') { if (v && String(v).trim()) v = String(v).trim(); else continue; }
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
      out.push({ type: 'folder', name: e.name, path: childRel, display: stripDisplayName(e.name), count });
    } else {
      const m = fileMeta(dir, e.name, secs);
      out.push({ type: 'file', name: e.name, path: childRel, display: stripDisplayName(e.name),
        ext: path.extname(e.name).toLowerCase(), size: m.size,
        tags: m.tags, authors: m.authors, date: m.date, important: m.important,
        description: m.description, altHu: m.altHu, altEn: m.altEn, visibility: m.visibility, whitelist: m.whitelist,
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
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob:",
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "connect-src 'self' https://cdnjs.cloudflare.com",
    "frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'",
  ].join('; '));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (pathname === '/devtools' || pathname === '/devtools/')
    return serveFile(res, req, path.join(__WEBSITE, 'devtools.html'));

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
    return sendJSON(res, { name: 'root', type: 'folder', path: '', children, count: children.length, hasDualLang: HAS_DUAL_LANG, loggedIn: !!_viewer });
  }

  // Articles
  if (pathname === '/api/articles') {
    const articlesDir = (query.lang === 'hu' && fs.existsSync(__ARTICLES_HU)) ? __ARTICLES_HU : __ARTICLES;
    let files = []; try { files = fs.readdirSync(articlesDir); } catch {}
    const articles = files.filter(f => f.endsWith('.html')).map(f => {
      let title = f.replace('.html','').replace(/[-_]/g,' '), date = null, description = '', tags = [];
      try {
        const raw = fs.readFileSync(path.join(articlesDir, f), 'utf8');
        const tm = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
        const dm = raw.match(/data-date="([^"]+)"/), ds = raw.match(/data-description="([^"]+)"/), tg = raw.match(/data-tags="([^"]+)"/);
        if (tm) title = tm[1]; if (dm) date = dm[1]; if (ds) description = ds[1];
        if (tg) tags = tg[1].split(',').map(s => s.trim());
      } catch {}
      return { file: f, title, date, description, tags };
    }).sort((a, b) => (b.date||'').localeCompare(a.date||''));
    return sendJSON(res, articles);
  }

  // File source
  if (pathname === '/api/file') {
    if (!query.path) { res.writeHead(400); return res.end('Missing path'); }
    const fileDir = (query.lang === 'hu' && HAS_DUAL_LANG) ? __DATA_HU : __DATA;
    let full; try { full = safePath(fileDir, query.path); } catch { res.writeHead(403); return res.end('Forbidden'); }
    if (!canViewNote(req, query.path, query.lang)) { res.writeHead(403); return res.end('Sign-in required'); }
    let content; try { content = fs.readFileSync(full, 'utf8'); } catch { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(content);
  }

  // Precompile start
  if (pathname === '/api/precompile/start' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const { paths, lang } = JSON.parse(body); if (!Array.isArray(paths)) { res.writeHead(400); return res.end('paths must be array'); }
        for (const p of paths) enqueuePrecompile(p, lang || 'en'); sendJSON(res, { queued: paths.length });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // Precompile folder
  if (pathname === '/api/precompile/folder' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { folderPath, lang } = JSON.parse(body); const l = lang || 'en';
        const dataDir = l === 'hu' ? __DATA_HU : __DATA;
        if (!fs.existsSync(dataDir)) return sendJSON(res, { queued: 0 });
        let fullFolder; try { fullFolder = safePath(dataDir, folderPath || ''); } catch { res.writeHead(403); return res.end('Forbidden'); }
        let count = 0;
        function walk(dir, rel) {
          let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
            if (path.extname(e.name).toLowerCase() === '.tex') { enqueuePrecompile(rel ? `${rel}/${e.name}` : e.name, l); count++; }
          }
        }
        walk(fullFolder, folderPath || '');
        sendJSON(res, { queued: count });
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // Precompile status
  if (pathname === '/api/precompile/status')
    return sendJSON(res, { queue: preQueue.length, running: preRunning, status: preStatus });

  // Changelog
  if (pathname === '/api/changelog' && req.method === 'GET') return sendJSON(res, readChangelog());
  if (pathname === '/api/changelog/add' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; });
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
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const { id } = JSON.parse(body); writeChangelog(readChangelog().filter(e => e.id !== id)); sendJSON(res, { ok: true }); }
      catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // ── Admin: auth ─────────────────────────────────────────────────────────────
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let u, p;
      try { const j = JSON.parse(body); u = j.username; p = j.password; }
      catch { res.writeHead(400); return res.end('Bad JSON'); }
      const rec = verifyAdmin(u, p);
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
        fs.writeFileSync(path.join(full, 'data.txt'), serializeDataTxt(j.sections || {}), 'utf8');
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
        const secs    = parseDataTxt(folderFull);
        const display = stripDisplayName(filename);
        // drop any prior section that maps to the same display name
        for (const k of Object.keys(secs))
          if (stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase()) delete secs[k];
        secs[display] = {
          tags: j.meta.tags, authors: j.meta.authors, date: j.meta.date,
          important: j.meta.important, description: j.meta.description,
          alt_hu: j.meta.altHu, alt_en: j.meta.altEn,
          visibility: j.meta.visibility,
          allow: j.meta.allow,
        };
        try { fs.writeFileSync(path.join(folderFull, 'data.txt'), serializeDataTxt(secs), 'utf8'); } catch {}
      }
      return sendJSON(res, { ok: true, path: (j.dir ? j.dir + '/' : '') + filename });
    });
    return;
  }

  // ── Admin: delete a note + its metadata ─────────────────────────────────────
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
      const secs    = parseDataTxt(folderFull);
      const display = stripDisplayName(j.filename || '');
      for (const k of Object.keys(secs))
        if (stripDisplayName(k + '.x').replace(/\.x$/, '').toLowerCase() === display.toLowerCase()) delete secs[k];
      try { fs.writeFileSync(path.join(folderFull, 'data.txt'), serializeDataTxt(secs), 'utf8'); } catch {}
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Site sign-in (viewer accounts; also accepts admin credentials) ──────────
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!rateOk(req, 'login', 20, 10 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let u, p;
      try { const j = JSON.parse(body); u = j.username; p = j.password; }
      catch { res.writeHead(400); return res.end('Bad JSON'); }
      let rec = verifyUser(u, p), role = 'user';
      if (!rec) { rec = verifyAdmin(u, p); role = 'admin'; }
      if (!rec) return sendJSON(res, { ok: false, error: 'invalid credentials' }, 401);
      const token = createSession(rec.username, role);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, token), 'Access-Control-Allow-Origin': '*' });
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie(req), 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── Public: register a viewer account ───────────────────────────────────────
  if (pathname === '/api/register' && req.method === 'POST') {
    if (!rateOk(req, 'register', 5, 60 * 60 * 1000)) return sendJSON(res, { ok: false, error: 'Too many sign-up attempts. Try again later.' }, 429);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const username = String(j.username || '').trim();
      const password = String(j.password || '');
      if (username.length < 3 || username.length > 32 || !/^[A-Za-z0-9_.-]+$/.test(username))
        return sendJSON(res, { ok: false, error: 'Username must be 3-32 chars: letters, numbers, dot, underscore, hyphen.' }, 400);
      if (password.length < 8)
        return sendJSON(res, { ok: false, error: 'Password must be at least 8 characters.' }, 400);
      const list = loadUsers();
      if (list.some(u => u.username.toLowerCase() === username.toLowerCase())
        || loadAdmins().some(a => a.username.toLowerCase() === username.toLowerCase()))
        return sendJSON(res, { ok: false, error: 'That username is taken.' }, 409);
      list.push({ username, ...hashPassword(password) });
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      const token = createSession(username, 'user');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, token), 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, username, role: 'user' }));
    });
    return;
  }
  // ── Signed-in user: change own password ─────────────────────────────────────
  if (pathname === '/api/account/password' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'Not signed in.' }, 401);
    if (s.role !== 'user') return sendJSON(res, { ok: false, error: 'Admin passwords are managed with make-admin.js.' }, 400);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const oldp = String(j.oldPassword || ''), newp = String(j.newPassword || '');
      if (newp.length < 8) return sendJSON(res, { ok: false, error: 'New password must be at least 8 characters.' }, 400);
      if (!verifyUser(s.username, oldp)) return sendJSON(res, { ok: false, error: 'Current password is incorrect.' }, 403);
      const list = loadUsers();
      const i = list.findIndex(u => u.username.toLowerCase() === s.username.toLowerCase());
      if (i < 0) return sendJSON(res, { ok: false, error: 'Account not found.' }, 404);
      list[i] = { username: list[i].username, ...hashPassword(newp) };
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
  }

  // ── Admin: manage viewer accounts ───────────────────────────────────────────
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return sendJSON(res, { ok: true, users: loadUsers().map(u => u.username) });
  }
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const username = String(j.username || '').trim();
      const password = String(j.password || '');
      if (!username || !password) return sendJSON(res, { ok: false, error: 'username and password required' }, 400);
      const list = loadUsers();
      if (list.some(u => u.username.toLowerCase() === username.toLowerCase()))
        return sendJSON(res, { ok: false, error: 'user already exists' }, 409);
      list.push({ username, ...hashPassword(password) });
      try { saveUsers(list); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true, username });
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
      return sendJSON(res, { ok: true });
    });
    return;
  }
  // Music
  if (pathname === '/api/music/list') return sendJSON(res, listMusic());
  if (pathname.startsWith('/music/')) {
    if (!fs.existsSync(__MUSIC)) { res.writeHead(404); return res.end('Not Found'); }
    let full; try { full = safePath(__MUSIC, pathname.slice(7)); } catch { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, req, full);
  }

  // Data files
  if (pathname.startsWith('/data/')) {
    const useHu = query.lang === 'hu' && HAS_DUAL_LANG;
    const dataDir = useHu ? __DATA_HU : __DATA;
    const _dataRel = pathname.slice(6);
    if (/(^|\/)data\.txt$/i.test(decodeURIComponent(_dataRel))) { res.writeHead(404); return res.end('Not Found'); }
    let full; try { full = safePath(dataDir, _dataRel); } catch { res.writeHead(403); return res.end('Forbidden'); }
    if (!canViewNote(req, _dataRel, query.lang)) { res.writeHead(403); return res.end('Sign-in required'); }
    return serveFile(res, req, full, !!query.download);
  }

  // Article pages
  if (pathname.startsWith('/articles/')) {
    const articleFile = pathname.slice(10); let full = null;
    if (query.lang === 'hu' && fs.existsSync(__ARTICLES_HU)) {
      try { const p = safePath(__ARTICLES_HU, articleFile); if (fs.existsSync(p)) full = p; } catch {}
    }
    if (!full) { try { full = safePath(__ARTICLES, articleFile); } catch { res.writeHead(403); return res.end('Forbidden'); } }
    return serveFile(res, req, full);
  }

  // Static files
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (isProtectedStatic(decodeURIComponent(rel))) { res.writeHead(404); return res.end('Not Found'); }
  let full; try { full = safePath(__WEBSITE, rel); } catch { res.writeHead(403); return res.end('Forbidden'); }
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch {}
  return serveFile(res, req, full);
});

// ── Startup ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const pdflatexOk = (() => { try { return spawnSync(PDFLATEX, ['--version'], { timeout: 5000 }).status === 0; } catch { return false; } })();
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