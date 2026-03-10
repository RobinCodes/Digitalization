#!/usr/bin/env node
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const os    = require('os');
const { spawnSync, execSync } = require('child_process');

const PORT       = process.env.PORT || 3000;
const __WEBSITE  = __dirname;
const __DATA     = path.resolve(__dirname, '..', 'Data');
const __ARTICLES = path.join(__dirname, 'Articles');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.tex': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.bib': 'text/plain; charset=utf-8',
  '.sty': 'text/plain; charset=utf-8', '.cls': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePath(base, relPath) {
  const norm = path.normalize(decodeURIComponent(relPath)).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(base, norm);
  if (!full.startsWith(path.normalize(base) + path.sep) && full !== path.normalize(base))
    throw new Error('Path traversal blocked');
  return full;
}

function buildTree(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .map(e => {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const children = buildTree(path.join(dir, e.name), childRel);
        return { name: e.name, type: 'folder', path: childRel, children, count: children.length };
      }
      const ext = path.extname(e.name).toLowerCase();
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
      return { name: e.name, type: 'file', ext, path: childRel, size };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
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

function serveFile(res, fullPath, forceDownload = false) {
  const ext  = path.extname(fullPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let data;
  try { data = fs.readFileSync(fullPath); }
  catch { res.writeHead(404); res.end('Not Found'); return; }
  const headers = {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (forceDownload)
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(fullPath))}"`;
  res.writeHead(200, headers);
  res.end(data);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDirSync(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Find pdflatex ─────────────────────────────────────────────────────────────
function findPdflatex() {
  // Try common locations first, then fall back to PATH search
  const candidates = [
    '/usr/bin/pdflatex',
    '/usr/local/bin/pdflatex',
    '/usr/texbin/pdflatex',
    '/Library/TeX/texbin/pdflatex',          // macOS MacTeX
    '/usr/local/texlive/2023/bin/x86_64-linux/pdflatex',
    '/usr/local/texlive/2024/bin/x86_64-linux/pdflatex',
    'C:\\texlive\\2023\\bin\\win32\\pdflatex.exe',
    'C:\\texlive\\2024\\bin\\win32\\pdflatex.exe',
    'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
    'C:\\Users\\Robin\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // Fall back to PATH
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pdflatex'], { timeout: 5000 });
    if (which.status === 0 && which.stdout) {
      const found = which.stdout.toString().trim().split('\n')[0].trim();
      if (found && fs.existsSync(found)) return found;
    }
  } catch {}
  return 'pdflatex'; // last resort — rely on PATH
}

const PDFLATEX = findPdflatex();

// ── Collect best log text from a spawnSync result + log file ──────────────────
function collectLog(r1, r2, tmpDir, texBase) {
  const parts = [];

  // 1. In-memory stdout from both runs
  for (const r of [r1, r2]) {
    if (r && r.stdout) parts.push(r.stdout.toString());
    if (r && r.stderr) parts.push(r.stderr.toString());
    if (r && r.error)  parts.push('SpawnError: ' + r.error.message);
  }

  // 2. The .log file pdflatex writes to disk — most complete source of truth
  const logFile = path.join(tmpDir, texBase + '.log');
  try {
    if (fs.existsSync(logFile)) {
      const logContent = fs.readFileSync(logFile, 'utf8');
      // Extract only the relevant error section to keep it readable
      const lines = logContent.split('\n');
      const errorLines = [];
      let inError = false;
      for (const line of lines) {
        if (/^!|^l\.\d+|^Error|LaTeX Error|Emergency stop/.test(line)) {
          inError = true;
        }
        if (inError) {
          errorLines.push(line);
          if (errorLines.length > 80) { errorLines.push('…(log truncated)'); break; }
        }
      }
      if (errorLines.length > 0) {
        parts.push('\n──── pdflatex log excerpt ────\n' + errorLines.join('\n'));
      } else {
        // No error found in log — include tail which usually has useful info
        parts.push('\n──── pdflatex log (tail) ────\n' + lines.slice(-40).join('\n'));
      }
    }
  } catch {}

  return parts.join('\n').trim();
}

// ── LaTeX Compile Endpoint ────────────────────────────────────────────────────
function handleCompile(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    let filePath;
    try { filePath = JSON.parse(body).path; }
    catch { res.writeHead(400); return res.end('Bad JSON'); }
    if (!filePath || typeof filePath !== 'string') {
      res.writeHead(400); return res.end('Missing or invalid path');
    }

    // Resolve and validate path
    let fullTex;
    try { fullTex = safePath(__DATA, filePath); }
    catch (e) { res.writeHead(403); return res.end('Forbidden: ' + e.message); }

    if (!fs.existsSync(fullTex)) {
      return sendJSON(res, {
        success: false,
        log: `File not found:\n  ${fullTex}\n\nCheck that the file exists in your Data/ folder.`
      });
    }

    // Verify pdflatex is accessible
    const checkPdf = spawnSync(PDFLATEX, ['--version'], { timeout: 8000 });
    if (checkPdf.status !== 0 && !checkPdf.stdout) {
      return sendJSON(res, {
        success: false,
        log: `pdflatex not found at: ${PDFLATEX}\n\n` +
             `Please install TeX Live or MiKTeX:\n` +
             `  Ubuntu/Debian : sudo apt-get install texlive-full\n` +
             `  macOS         : brew install --cask mactex\n` +
             `  Windows       : https://miktex.org/download`
      });
    }

    const texName   = path.basename(fullTex);
    const texBase   = texName.replace(/\.tex$/i, '');
    const sourceDir = path.dirname(fullTex);
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'ki_'));

    try {
      // Copy the entire source folder so \input{} and .bib files resolve
      copyDirSync(sourceDir, tmpDir);

      const args = [
        '-interaction=nonstopmode',
        '-file-line-error',    // cleaner error format: file:line: error
        texName,
      ];
      // NOTE: deliberately NOT using -halt-on-error so we get the full log
      // even when there are errors, making diagnosis easier.

      const spawnOpts = {
        cwd: tmpDir,
        env: {
          ...process.env,
          TEXMFHOME: process.env.TEXMFHOME || '/usr/share/texmf',
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
        timeout: 120_000,          // 2 minutes — generous for big documents
        maxBuffer: 32 * 1024 * 1024,
      };

      const r1 = spawnSync(PDFLATEX, args, spawnOpts);
      const r2 = spawnSync(PDFLATEX, args, spawnOpts); // second pass: ToC, refs, hyperlinks

      const pdfPath = path.join(tmpDir, texBase + '.pdf');
      const pdfExists = fs.existsSync(pdfPath);

      // Success: PDF was produced AND second run exited cleanly
      if (pdfExists && (r2.status === 0 || r2.status === null && !r2.error)) {
        const pdfData = fs.readFileSync(pdfPath);
        rmDirSync(tmpDir);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfData.length),
          'Content-Disposition': `inline; filename="${encodeURIComponent(texBase)}.pdf"`,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        return res.end(pdfData);
      }

      // Partial success: PDF exists but exit code was non-zero (warnings/recoverable errors)
      // Still serve the PDF — LaTeX often exits non-zero but produces a valid output
      if (pdfExists) {
        const pdfData = fs.readFileSync(pdfPath);
        rmDirSync(tmpDir);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfData.length),
          'Content-Disposition': `inline; filename="${encodeURIComponent(texBase)}.pdf"`,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'X-Compile-Warnings': 'true',
        });
        return res.end(pdfData);
      }

      // Failure: no PDF produced
      const log = collectLog(r1, r2, tmpDir, texBase);
      rmDirSync(tmpDir);

      const statusMsg = r2.status === null
        ? `pdflatex was killed (timeout or signal)\n\n`
        : `pdflatex exited with code ${r2.status}\n\n`;

      return sendJSON(res, {
        success: false,
        log: statusMsg + (log || 'No output captured. Check that pdflatex is installed and the .tex file is valid.')
      });

    } catch (err) {
      rmDirSync(tmpDir);
      return sendJSON(res, {
        success: false,
        log: `Internal server error: ${err.message}\n${err.stack || ''}`
      });
    }
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (pathname === '/api/compile' && req.method === 'POST') return handleCompile(req, res);

  if (pathname === '/api/tree') {
    const dataDir = (query.lang === 'hu')
      ? path.resolve(__WEBSITE, '..', 'DataHU')
      : __DATA;
    const children = buildTree(dataDir);
    return sendJSON(res, { name: dataDir, type: 'folder', path: '', children, count: children.length });
  }

  if (pathname === '/api/articles') {
    const articlesDir = (query.lang === 'hu')
      ? path.join(__WEBSITE, 'ArticlesHU')
      : __ARTICLES;
    let files = [];
    try { files = fs.readdirSync(articlesDir); } catch {}
    const articles = files.filter(f => f.endsWith('.html')).map(f => {
      let title = f.replace('.html','').replace(/[-_]/g,' ');
      let date = null, description = '', tags = [];
      try {
        const raw = fs.readFileSync(path.join(articlesDir, f), 'utf8');
        const t  = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
        const d  = raw.match(/data-date="([^"]+)"/);
        const ds = raw.match(/data-description="([^"]+)"/);
        const tg = raw.match(/data-tags="([^"]+)"/);
        if (t)  title       = t[1];
        if (d)  date        = d[1];
        if (ds) description = ds[1];
        if (tg) tags        = tg[1].split(',').map(s => s.trim());
      } catch {}
      return { file: f, title, date, description, tags };
    }).sort((a, b) => (b.date||'').localeCompare(a.date||''));
    return sendJSON(res, articles);
  }

  if (pathname === '/api/file') {
    if (!query.path) { res.writeHead(400); return res.end('Missing path'); }
    let full;
    try { full = safePath(__DATA, query.path); }
    catch { res.writeHead(403); return res.end('Forbidden'); }
    let content;
    try { content = fs.readFileSync(full, 'utf8'); }
    catch { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(content);
  }

  if (pathname.startsWith('/data/')) {
    // Support ?lang=hu to serve from DataHU
    const dataDir = (query.lang === 'hu')
      ? path.resolve(__WEBSITE, '..', 'DataHU')
      : __DATA;
    let full;
    try { full = safePath(dataDir, pathname.slice(6)); }
    catch { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, full, !!query.download);
  }

  if (pathname.startsWith('/articles/')) {
    const articleFile = pathname.slice(10);
    // Try language-specific dir first
    let full;
    if (query.lang === 'hu') {
      const huDir = path.join(__WEBSITE, 'ArticlesHU');
      try { full = safePath(huDir, articleFile); if (!fs.existsSync(full)) full = null; } catch { full = null; }
    }
    if (!full) {
      try { full = safePath(__ARTICLES, articleFile); }
      catch { res.writeHead(403); return res.end('Forbidden'); }
    }
    return serveFile(res, full);
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let full;
  try { full = safePath(__WEBSITE, rel); }
  catch { res.writeHead(403); return res.end('Forbidden'); }
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch {}
  return serveFile(res, full);
});

server.listen(PORT, () => {
  const pdflatexOk = (() => {
    try { return spawnSync(PDFLATEX, ['--version'], { timeout: 5000 }).status === 0; }
    catch { return false; }
  })();
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║  ✦  Knowledge Index Server             ║`);
  console.log(`  ║  ➜  http://localhost:${PORT}            ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Data dir  : ${__DATA}`);
  console.log(`  Articles  : ${__ARTICLES}`);
  console.log(`  pdflatex  : ${PDFLATEX} ${pdflatexOk ? '✓' : '✗ NOT FOUND'}\n`);
  if (!pdflatexOk) {
    console.warn(`  ⚠  pdflatex not found — LaTeX compilation will fail.`);
    console.warn(`     Install TeX Live:  sudo apt-get install texlive-full\n`);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n  ✗ Port ${PORT} in use. Try: PORT=3001 node server.js\n`);
  else console.error(err);
  process.exit(1);
});