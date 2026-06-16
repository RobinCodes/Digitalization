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
const __SETTINGS    = path.join(__dirname, 'settings.json');
const __GRANTS      = path.join(__dirname, 'grants.json');
const __CHATS       = path.join(__dirname, 'chats.json');

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
const PROTECTED_FILES = new Set(['admins.json', 'users.json', 'settings.json', 'grants.json', 'chats.json', 'server.js',
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
    visibility:  (meta.visibility === 'members' || meta.visibility === 'request') ? meta.visibility : 'public',
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
    if (huM) { const hv = findMeta(huM.name, huSecs) || {}; if (hv.visibility === 'members') m.visibility = 'members'; else if (hv.visibility === 'request' && m.visibility !== 'members') m.visibility = 'request'; }
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
// Mark request-to-read notes the viewer cannot currently open (for the locked card UI).
function annotateLocks(items, req, matLang) {
  for (const it of items || []) {
    if (it.type === 'folder') annotateLocks(it.children || [], req, matLang);
    else if (it.visibility === 'request') it.locked = !canViewNote(req, it.path, it.lang || matLang);
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
function noteVisibility(relPath, lang) {
  const visOf = (base, rel) => {
    try {
      const full = safePath(base, rel);
      const v = (findMeta(path.basename(full), parseDataTxt(path.dirname(full))) || {}).visibility;
      return (v === 'members' || v === 'request') ? v : 'public';
    } catch { return 'public'; }
  };
  const huPrimary = (lang === 'hu' && HAS_DUAL_LANG);
  const base = huPrimary ? __DATA_HU : __DATA;
  let vis = visOf(base, relPath);
  if (vis !== 'members' && HAS_DUAL_LANG) {
    const other = huPrimary ? __DATA : __DATA_HU;
    try {
      const baseFull = safePath(base, relPath);
      const relDir   = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      const otherDir = safePath(other, relDir);
      const display  = stripDisplayName(path.basename(baseFull)).toLowerCase();
      let ents = []; try { ents = fs.readdirSync(otherDir); } catch {}
      const match = ents.find(n => stripDisplayName(n).toLowerCase() === display);
      if (match) { const ov = visOf(otherDir, match); if (ov === 'members') return 'members'; if (ov === 'request') vis = 'request'; }
    } catch {}
  }
  return vis;
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
  const vis = noteVisibility(relPath, lang);
  if (vis === 'public') return true;
  const s = siteSession(req);
  if (!s) return false;
  if (s.role === 'admin') return true;
  if (vis === 'request') {
    const owners = noteWhitelist(relPath, lang);
    if (owners.includes(String(s.username).toLowerCase())) return true;
    return hasGrant(s.username, lang, relPath);
  }
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
    if (counter) { const cm = findMeta(counter.name, otherSecs) || {}; if (cm.visibility === 'members') m.visibility = 'members'; else if (cm.visibility === 'request' && m.visibility !== 'members') m.visibility = 'request'; }
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
function saveUsers(list) { fs.writeFileSync(__USERS, JSON.stringify(list, null, 2) + '\n', 'utf8'); }
// Per-account UI settings (theme, language, layout) keyed by username.
function loadSettings() { try { const o = JSON.parse(fs.readFileSync(__SETTINGS, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function saveSettings(o) { fs.writeFileSync(__SETTINGS, JSON.stringify(o, null, 2) + '\n', 'utf8'); }
function cleanSettings(j) {
  const out = {};
  if (j && typeof j === 'object') {
    if (j.lang === 'en' || j.lang === 'hu') out.lang = j.lang;
    if (j.matLang === 'en' || j.matLang === 'hu' || j.matLang === 'both') out.matLang = j.matLang;
    if (j.theme === 'dark' || j.theme === 'light' || j.theme === 'teal') out.theme = j.theme;
    if (j.sectionBy === 'type' || j.sectionBy === 'subject') out.sectionBy = j.sectionBy;
    if (typeof j.sectionOrder === 'string' && j.sectionOrder.length <= 8192) out.sectionOrder = j.sectionOrder;
    if (typeof j.childOrders === 'string' && j.childOrders.length <= 65536) out.childOrders = j.childOrders;
  }
  return out;
}
// ── Access grants (who may read which request-to-read note) ───────────────────
function loadGrants() { try { const o = JSON.parse(fs.readFileSync(__GRANTS, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function saveGrants(o) { fs.writeFileSync(__GRANTS, JSON.stringify(o, null, 2) + '\n', 'utf8'); }
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
  const owners = noteWhitelist(relPath, lang).map(resolveUsername).filter(Boolean);
  if (owners.length) return [...new Set(owners)];
  return loadAdmins().map(a => a.username);
}
// ── Chat conversations (DMs + group chats; text only) ─────────────────────────
function loadChats() { try { const o = JSON.parse(fs.readFileSync(__CHATS, 'utf8')); return (o && Array.isArray(o.conversations)) ? o : { conversations: [] }; } catch { return { conversations: [] }; } }
function saveChats(o) { fs.writeFileSync(__CHATS, JSON.stringify(o, null, 2) + '\n', 'utf8'); }
function chatParticipant(c, name) { const n = String(name).toLowerCase(); return (c.participants || []).some(p => String(p).toLowerCase() === n); }
function chatUnread(c, name) { const n = String(name).toLowerCase(); const last = (c.reads && c.reads[n]) || ''; return (c.messages || []).filter(m => String(m.from).toLowerCase() !== n && (m.date || '') > last).length; }
function findDM(chats, a, b) { const A = String(a).toLowerCase(), B = String(b).toLowerCase(); return chats.conversations.find(c => c.type === 'dm' && (c.participants || []).length === 2 && c.participants.map(x => String(x).toLowerCase()).includes(A) && c.participants.map(x => String(x).toLowerCase()).includes(B)); }
function ensureDM(chats, a, b) { let c = findDM(chats, a, b); if (!c) { c = { id: crypto.randomUUID(), type: 'dm', title: '', participants: [a, b], createdBy: a, created: new Date().toISOString(), messages: [], reads: {} }; chats.conversations.push(c); } return c; }
function chatTitleFor(c, me) { if (c.type === 'group') return c.title || 'Group'; const other = (c.participants || []).find(p => String(p).toLowerCase() !== String(me).toLowerCase()); return other || 'Direct message'; }
function chatPreview(m) { if (!m) return ''; if (m.kind === 'access-request') return '\uD83D\uDD12 ' + ((m.note && m.note.label) || 'access request'); if (m.kind === 'access-result') return 'access ' + (m.decision || ''); return m.body || ''; }
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
  '# Keys: tags, authors, date, important, visibility (public|members|request), allow, description, alt-hu, alt-en\n' +
  '#   visibility=request: note is visible but content is locked; allow = owner usernames who receive read-requests.\n';

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
      if (k === 'visibility') { if (v !== 'members' && v !== 'request') continue; }
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
    annotateLocks(children, req, matLang);
    return sendJSON(res, { name: 'root', type: 'folder', path: '', children, count: children.length, hasDualLang: HAS_DUAL_LANG, loggedIn: !!_viewer });
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
  if (pathname === '/api/chat/list' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const me = s.username, out = [];
    for (const c of loadChats().conversations) {
      if (!chatParticipant(c, me)) continue;
      const last = (c.messages || [])[c.messages.length - 1] || null;
      out.push({ id: c.id, type: c.type, title: chatTitleFor(c, me), participants: c.participants || [],
        unread: chatUnread(c, me), last: last ? { from: last.from, body: chatPreview(last), date: last.date, kind: last.kind } : null,
        lastDate: last ? last.date : c.created });
    }
    out.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
    return sendJSON(res, { ok: true, me, conversations: out });
  }
  if (pathname === '/api/chat/messages' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const me = s.username, c = loadChats().conversations.find(x => x.id === query.id);
    if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'not found' }, 404);
    return sendJSON(res, { ok: true, id: c.id, type: c.type, title: chatTitleFor(c, me), participants: c.participants || [], createdBy: c.createdBy, messages: c.messages || [] });
  }
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      let text = String(j.body || '').trim();
      if (!text) return sendJSON(res, { ok: false, error: 'Message is empty.' }, 400);
      if (text.length > 8000) text = text.slice(0, 8000);
      const me = s.username, meLc = String(me).toLowerCase(), chats = loadChats();
      let c;
      if (j.id) {
        c = chats.conversations.find(x => x.id === j.id);
        if (!c || !chatParticipant(c, me)) return sendJSON(res, { ok: false, error: 'Conversation not found.' }, 404);
      } else {
        const to = resolveUsername(j.to);
        if (!to) return sendJSON(res, { ok: false, error: 'Unknown recipient.' }, 400);
        if (String(to).toLowerCase() === meLc) return sendJSON(res, { ok: false, error: 'You cannot message yourself.' }, 400);
        c = ensureDM(chats, me, to);
      }
      const msg = { id: crypto.randomUUID(), from: me, body: text, date: new Date().toISOString(), kind: 'text' };
      c.messages.push(msg);
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
      const have = new Set((c.participants || []).map(p => String(p).toLowerCase())), added = [];
      for (const nm of (Array.isArray(j.participants) ? j.participants : [])) { const r = resolveUsername(nm); if (r && !have.has(String(r).toLowerCase())) { c.participants.push(r); have.add(String(r).toLowerCase()); added.push(r); } }
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

  // ── Access requests for request-to-read notes (delivered as chat DMs) ─────────
  if (pathname === '/api/access/info' && req.method === 'GET') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    const lang = query.lang === 'hu' ? 'hu' : 'en', p = query.path || '';
    if (noteVisibility(p, lang) !== 'request') return sendJSON(res, { ok: true, applicable: false });
    const meLc = String(s.username).toLowerCase();
    const pending = loadChats().conversations.some(c => chatParticipant(c, s.username) && (c.messages || []).some(m => m.kind === 'access-request' && String(m.from).toLowerCase() === meLc && m.status === 'pending' && m.note && m.note.path === p && m.note.lang === lang));
    return sendJSON(res, { ok: true, applicable: true, granted: canViewNote(req, p, lang), pending, recipients: requestRecipients(p, lang) });
  }
  if (pathname === '/api/access/request' && req.method === 'POST') {
    const s = siteSession(req);
    if (!s) return sendJSON(res, { ok: false, error: 'unauthorized' }, 401);
    let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const lang = j.lang === 'hu' ? 'hu' : 'en', p = String(j.path || '');
      if (noteVisibility(p, lang) !== 'request') return sendJSON(res, { ok: false, error: 'This note does not require a request.' }, 400);
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
      const accept = j.decision === 'accept', reason = String(j.reason || '').slice(0, 2000);
      target.status = accept ? 'accepted' : 'declined';
      if (accept) addGrant(target.from, target.note.lang, target.note.path);
      convo.messages.push({ id: crypto.randomUUID(), from: me, kind: 'access-result', decision: accept ? 'accepted' : 'declined', reason, note: target.note, body: reason, date: new Date().toISOString() });
      try { saveChats(chats); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
      return sendJSON(res, { ok: true });
    });
    return;
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