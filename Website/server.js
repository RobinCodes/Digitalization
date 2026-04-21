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
  try {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (pathname === '/api/compile' && req.method === 'POST') return handleCompile(req, res);

  // Tree
  if (pathname === '/api/tree') {
    const matLang = query.mat_lang || 'en';
    let children;
    if (!HAS_DUAL_LANG) {
      // Single data dir — always serve from __DATA regardless of matLang
      children = buildTree(__DATA);
    } else if (matLang === 'hu') {
      children = deepRemapHu(buildMergedTree(__DATA_HU, __DATA));
    } else if (matLang === 'both') {
      children = buildMergedTree(__DATA, __DATA_HU);
    } else {
      children = buildMergedTree(__DATA, __DATA_HU);
    }
    return sendJSON(res, { name: 'root', type: 'folder', path: '', children, count: children.length, hasDualLang: HAS_DUAL_LANG });
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
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const { id } = JSON.parse(body); writeChangelog(readChangelog().filter(e => e.id !== id)); sendJSON(res, { ok: true }); }
      catch { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
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
    let full; try { full = safePath(dataDir, pathname.slice(6)); } catch { res.writeHead(403); return res.end('Forbidden'); }
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
  let full; try { full = safePath(__WEBSITE, rel); } catch { res.writeHead(403); return res.end('Forbidden'); }
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch {}
  return serveFile(res, req, full);
  } catch (err) {
    console.error('[server] Unhandled request error:', err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
      }
    } catch (_) {}
  }
});

// ── Process-level error guards (keep server alive on unexpected throws) ───────
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
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