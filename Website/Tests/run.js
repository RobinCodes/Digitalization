#!/usr/bin/env node
'use strict';

// Isolated end-to-end tests for the Digitalization server.
// Spins up server.js in a throwaway directory with sample Data/DataHU,
// exercises the admin API + a couple of regression endpoints, then exits.

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const crypto  = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');        // the website project dir
const PORT = 3400 + Math.floor(Math.random() * 400);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
}

// ── build throwaway fixture ───────────────────────────────────────────────────
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dtest_'));
const SITE = path.join(T, 'site');
fs.mkdirSync(SITE, { recursive: true });
for (const f of ['server.js', 'devtools.html', 'template.html', '404.html', 'sw.js']) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
fs.writeFileSync(path.join(SITE, 'changelog.json'), '[]');

// seeded admin: admin / testpass
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('testpass', salt, 32).toString('hex');
fs.writeFileSync(path.join(SITE, 'admins.json'), JSON.stringify([{ username: 'admin', salt, hash }], null, 2));

// Data (EN) + DataHU as siblings of the site dir
const DATA = path.join(T, 'Data'), DATAHU = path.join(T, 'DataHU');
fs.mkdirSync(path.join(DATA, 'STEM', 'Mathematics'), { recursive: true });
fs.mkdirSync(path.join(DATAHU, 'STEM', 'Mathematics'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'STEM', 'Mathematics', 'Applied Algebra {Algebra}.tex'),
  '\\documentclass{article}\\begin{document}Hello\\end{document}');
fs.writeFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'),
  '[Applied Algebra]\ntags: algebra, rings\nauthors: Robin\ndate: 2025-01-01\nalt-hu: Alkalmazott Algebra\n');
fs.writeFileSync(path.join(DATAHU, 'STEM', 'Mathematics', 'Alkalmazott Algebra {Algebra}.tex'),
  '\\documentclass{article}\\begin{document}Szia\\end{document}');
fs.writeFileSync(path.join(DATAHU, 'STEM', 'Mathematics', 'data.txt'),
  '[Alkalmazott Algebra]\ntags: algebra\nauthors: Robin\n');

// HU-only note (no EN counterpart) — must appear in HU/both, never in pure EN
fs.writeFileSync(path.join(DATAHU, 'STEM', 'Mathematics', 'Csak Magyar {x}.tex'),
  '\\documentclass{article}\\begin{document}csak\\end{document}');
fs.appendFileSync(path.join(DATAHU, 'STEM', 'Mathematics', 'data.txt'),
  '\n[Csak Magyar]\ntags: magyar\n');
// HU-only folder — must NOT appear in pure EN mode (the reported bug)
fs.mkdirSync(path.join(DATAHU, 'Irodalom'), { recursive: true });
fs.writeFileSync(path.join(DATAHU, 'Irodalom', 'Vers.tex'),
  '\\documentclass{article}\\begin{document}vers\\end{document}');
// EN-only folder — must NOT appear in pure HU mode
fs.mkdirSync(path.join(DATA, 'STEM', 'Physics'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'STEM', 'Physics', 'Mechanics {P}.tex'),
  '\\documentclass{article}\\begin{document}mech\\end{document}');

// ── tiny HTTP client ──────────────────────────────────────────────────────────
function req(method, p, { token, body, authToken, cookie, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['X-Admin-Token'] = token;
    if (authToken) headers['X-Auth-Token'] = authToken;
    if (cookie) headers['Cookie'] = cookie;
    // Anything a proxy would add in front of the app, X-Forwarded-* above all.
    Object.assign(headers, extra || {});
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: buf, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
// Like req(), but keeps the response as a Buffer — the backup export is a zip and
// decoding it as a string would corrupt every byte over 0x7F.
function reqBuf(method, p, { token, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['X-Admin-Token'] = token;
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      const bufs = []; res.on('data', c => bufs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(bufs), headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}
// Raw-body POST (the day-attachment upload endpoint takes the file as the body).
function reqRaw(method, p, buf, { token, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length };
    if (token) headers['X-Admin-Token'] = token;
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, body: out, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.write(buf); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── run ───────────────────────────────────────────────────────────────────────
(async () => {
  // A stand-in for the admin's Discord/Slack/Telegram endpoint, so the webhook is
  // exercised for real rather than mocked. It has to be listening before the server
  // starts, because the server reads ADMIN_WEBHOOK_URL once at load.
  const HOOK_PORT = PORT + 1;
  const hookHits = [];
  const hookSrv = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} hookHits.push({ path: q.url, json: j, raw: b }); r.writeHead(204); r.end(); });
  });
  await new Promise(r => hookSrv.listen(HOOK_PORT, '127.0.0.1', r));
  const waitForHook = async n => { for (let i = 0; i < 60 && hookHits.length < n; i++) await sleep(50); return hookHits.length >= n; };

  const srv = spawn('node', [path.join(SITE, 'server.js')], {
    env: { ...process.env, PORT: String(PORT),
           ADMIN_WEBHOOK_URL: 'http://127.0.0.1:' + HOOK_PORT + '/hook',
           ADMIN_WEBHOOK_FORMAT: 'json',
           // Short enough that two back-to-back events still collapse, but not so long
           // that an unrelated earlier test poisons a later assertion.
           ADMIN_WEBHOOK_DEDUPE_MS: '1200',
           // Production runs behind Caddy on loopback, so the suite does too —
           // otherwise nothing here ever exercises the X-Forwarded-* path.
           TRUSTED_PROXIES: '127.0.0.1',
           SITE_ORIGIN: 'https://notes.example' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  srv.stdout.on('data', d => serverLog += d);
  srv.stderr.on('data', d => serverLog += d);

  // wait for listen
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await req('GET', '/api/admin/me'); if (r.status) { up = true; break; } } catch {}
    await sleep(100);
  }

  try {
    if (!up) { ok('server starts', false, 'no response on :' + PORT + '\n' + serverLog); throw new Error('server down'); }
    ok('server starts', true);

    // auth
    let r = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong' } });
    ok('login rejects bad password', r.status === 401 && r.json && r.json.ok === false);

    r = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'testpass' } });
    ok('login accepts correct password', r.status === 200 && r.json && r.json.ok === true && !!r.json.token, JSON.stringify(r.json));
    const token = r.json && r.json.token;

    r = await req('GET', '/api/admin/me', { token });
    ok('me returns session + hasDualLang', r.json && r.json.ok === true && r.json.hasDualLang === true);

    r = await req('GET', '/api/admin/me');
    ok('me without token is not ok', r.json && r.json.ok === false);

    // browse
    r = await req('GET', '/api/admin/browse?lang=en', { token });
    ok('browse root needs no missing flag', r.json && r.json.ok === true && !r.json.missing);
    ok('browse root lists STEM folder', r.json && r.json.items.some(i => i.type === 'folder' && i.name === 'STEM'));

    r = await req('GET', '/api/admin/browse?lang=en');
    ok('browse without token → 401', r.status === 401);

    r = await req('GET', '/api/admin/browse?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    const algebra = r.json.items.find(i => i.name.startsWith('Applied Algebra'));
    ok('browse subfolder finds the note', !!algebra);
    ok('note display name strips {tags}', algebra && algebra.display === 'Applied Algebra', algebra && algebra.display);
    ok('note metadata parsed (tags+altHu)', algebra && algebra.tags.includes('algebra') && algebra.altHu === 'Alkalmazott Algebra',
       algebra && JSON.stringify({ tags: algebra.tags, altHu: algebra.altHu }));
    ok('note marked editable', algebra && algebra.editable === true);

    // path traversal
    r = await req('GET', '/api/admin/browse?lang=en&dir=' + encodeURIComponent('../../'), { token });
    ok('path traversal is blocked/contained', r.status === 403 || (r.json && (r.json.ok === false || Array.isArray(r.json.items))));

    // create a new note + metadata
    r = await req('POST', '/api/admin/note', { token, body: {
      lang: 'en', dir: 'STEM/Mathematics', filename: 'Groups {GT}.tex',
      content: '\\section{Groups}', meta: { tags: ['groups', 'algebra'], authors: ['Robin'], date: '2026-02-02', important: true, description: 'On groups', altHu: 'Csoportok' },
    }});
    ok('create note succeeds', r.json && r.json.ok === true, JSON.stringify(r.json));
    ok('created file exists on disk', fs.existsSync(path.join(DATA, 'STEM', 'Mathematics', 'Groups {GT}.tex')));

    r = await req('GET', '/api/admin/browse?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    const groups = r.json.items.find(i => i.name.startsWith('Groups'));
    ok('new note appears with metadata', groups && groups.important === true && groups.tags.includes('groups') && groups.altHu === 'Csoportok',
       groups && JSON.stringify(groups));

    // data.txt round-trip
    r = await req('GET', '/api/admin/datatxt?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    ok('datatxt GET returns sections', r.json && r.json.sections && Object.keys(r.json.sections).length >= 2);
    const sections = r.json.sections;
    sections['Applied Algebra'].description = 'Round trip test';
    r = await req('POST', '/api/admin/datatxt', { token, body: { lang: 'en', dir: 'STEM/Mathematics', sections } });
    ok('datatxt POST succeeds', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/datatxt?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    ok('datatxt round-trips edited field', r.json.sections['Applied Algebra'] && r.json.sections['Applied Algebra'].description === 'Round trip test',
       r.json.sections['Applied Algebra'] && r.json.sections['Applied Algebra'].description);
    ok('datatxt preserves important=true as boolean-ish', r.json.sections['Groups'] && r.json.sections['Groups'].important === 'true');

    // HU side (counterpart source)
    r = await req('GET', '/api/admin/browse?lang=hu&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    ok('HU browse finds Hungarian note', r.json.items.some(i => i.display === 'Alkalmazott Algebra'));

    // delete
    r = await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Groups {GT}.tex' } });
    ok('delete note succeeds', r.json && r.json.ok === true);
    ok('deleted file is gone', !fs.existsSync(path.join(DATA, 'STEM', 'Mathematics', 'Groups {GT}.tex')));
    r = await req('GET', '/api/admin/datatxt?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    ok('deleted note metadata removed', !r.json.sections['Groups']);

    // changelog gating
    r = await req('POST', '/api/changelog/add', { body: { title: 'Should fail' } });
    ok('changelog add without token → 401', r.status === 401);
    r = await req('POST', '/api/changelog/add', { token, body: { title: 'Added DevTools', type: 'website', body: 'TLDR', important: true } });
    ok('changelog add with token succeeds', r.json && r.json.ok === true);
    const clId = r.json.id;
    r = await req('GET', '/api/changelog');
    ok('changelog GET is public + shows entry', r.status === 200 && Array.isArray(r.json) && r.json.some(e => e.title === 'Added DevTools'));
    r = await req('POST', '/api/changelog/delete', { token, body: { id: clId } });
    ok('changelog delete with token succeeds', r.json && r.json.ok === true);

    // devtools page + regression
    r = await req('GET', '/devtools');
    ok('/devtools serves the admin page', r.status === 200 && /DevTools/.test(r.body) && /id="loginView"/.test(r.body));
    r = await req('GET', '/api/tree?mat_lang=en');
    ok('public /api/tree still works (regression)', r.status === 200 && r.json && r.json.type === 'folder');
    ok('public tree reports dual-language', r.json && r.json.hasDualLang === true);

    // ── viewer accounts ─────────────────────────────────────────────────────
    r = await req('POST', '/api/admin/users', { token, body: { username: 'reader', password: 'readpass' } });
    ok('admin creates viewer account', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/users', { token });
    ok('viewer account listed', r.json && Array.isArray(r.json.users) && r.json.users.includes('reader'));
    r = await req('POST', '/api/admin/users', { token, body: { username: 'reader', password: 'readpass2' } });
    ok('re-adding a viewer updates its password (not 409)', r.status === 200 && r.json && r.json.ok === true && r.json.updated === true);
    r = await req('POST', '/api/login', { body: { username: 'reader', password: 'readpass2' } });
    ok('updated viewer password works at login', r.json && r.json.ok === true);
    await req('POST', '/api/admin/users', { token, body: { username: 'reader', password: 'readpass' } }); // restore for downstream
    r = await req('GET', '/api/admin/users');
    ok('user list needs admin token (401)', r.status === 401);

    // ── site sign-in ────────────────────────────────────────────────────────
    r = await req('POST', '/api/login', { body: { username: 'reader', password: 'readpass' } });
    ok('site login (viewer) succeeds + role user', r.status === 200 && r.json && r.json.ok === true && r.json.role === 'user');
    const authCookie = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
    ok('site login sets ki_auth cookie', /ki_auth=/.test(authCookie));
    const authTok = authCookie.split('=')[1] || '';
    r = await req('POST', '/api/login', { body: { username: 'reader', password: 'nope' } });
    ok('site login bad password → 401', r.status === 401);
    r = await req('GET', '/api/me', { cookie: authCookie });
    ok('me (cookie) returns viewer', r.json && r.json.ok === true && r.json.username === 'reader' && r.json.role === 'user');
    r = await req('GET', '/api/me');
    ok('me anonymous not ok', r.json && r.json.ok === false);
    // a viewer token must NOT unlock the admin surface
    r = await req('GET', '/api/admin/browse?lang=en', { token: authTok });
    ok('viewer token rejected by admin endpoint', r.status === 401);

    // ── member-only note visibility ──────────────────────────────────────────
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Secret Lemma {S}.tex',
      content: '\\documentclass{article}\\begin{document}secret\\end{document}',
      meta: { tags: ['secret'], visibility: 'members' } } });
    ok('member-only note created', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/browse?lang=en&dir=' + encodeURIComponent('STEM/Mathematics'), { token });
    ok('admin browse shows members visibility', r.json.items.some(i => i.display === 'Secret Lemma' && i.canSee === 'members' && i.canRead === 'members'));
    const secretTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    ok('data.txt stores visibility: members', /\[Secret Lemma\][\s\S]*?visibility: members/.test(secretTxt));

    function findNote(node, part) {
      if (!node) return null;
      if (node.type === 'file') return (node.name || '').includes(part) ? node : null;
      for (const c of (node.children || [])) { const f = findNote(c, part); if (f) return f; }
      return null;
    }
    const secretPath = encodeURIComponent('STEM/Mathematics/Secret Lemma {S}.tex');
    const publicPath = encodeURIComponent('STEM/Mathematics/Applied Algebra {Algebra}.tex');

    // tree: hidden for anon, shown for signed-in
    r = await req('GET', '/api/tree?mat_lang=en');
    ok('anonymous tree hides member-only note', !findNote(r.json, 'Secret Lemma') && r.json.loggedIn === false);
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: authCookie });
    ok('viewer tree shows member-only note', !!findNote(r.json, 'Secret Lemma') && r.json.loggedIn === true);
    r = await req('GET', '/api/tree?mat_lang=en');
    ok('public note still visible to anon', !!findNote(r.json, 'Applied Algebra'));

    // /api/file content gating
    r = await req('GET', '/api/file?lang=en&path=' + secretPath);
    ok('anon /api/file on member note → 403', r.status === 403);
    r = await req('GET', '/api/file?lang=en&path=' + secretPath, { cookie: authCookie });
    ok('viewer /api/file on member note → 200', r.status === 200);
    r = await req('GET', '/api/file?lang=en&path=' + secretPath, { authToken: authTok });
    ok('X-Auth-Token also unlocks /api/file', r.status === 200);
    r = await req('GET', '/api/file?lang=en&path=' + publicPath);
    ok('anon /api/file on public note → 200', r.status === 200);

    // /data download gating
    r = await req('GET', '/data/' + secretPath + '?download=1');
    ok('anon /data on member note → 403', r.status === 403);
    r = await req('GET', '/data/' + secretPath + '?download=1', { cookie: authCookie });
    ok('viewer /data on member note → 200', r.status === 200);

    // site logout
    r = await req('POST', '/api/logout', { cookie: authCookie });
    ok('site logout succeeds', r.json && r.json.ok === true);
    r = await req('GET', '/api/me', { cookie: authCookie });
    ok('site session invalid after logout', r.json && r.json.ok === false);
    r = await req('GET', '/api/file?lang=en&path=' + secretPath, { cookie: authCookie });
    ok('member note locked again after logout', r.status === 403);

    // cleanup the fixtures we added
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Secret Lemma {S}.tex' } });
    r = await req('POST', '/api/admin/users/delete', { token, body: { username: 'reader' } });
    ok('viewer account removed', r.json && r.json.ok === true);

    // ── equal EN/HU: solo trees ──────────────────────────────────────────────
    function findNode2(node, part) {
      if (!node) return null;
      if (node.type === 'file') return (node.name || '').includes(part) ? node : null;
      for (const c of (node.children || [])) { const f = findNode2(c, part); if (f) return f; }
      return null;
    }
    function findFolder2(node, name) {
      if (!node) return null;
      if (node.type === 'folder' && node.name === name) return node;
      for (const c of (node.children || [])) { const f = findFolder2(c, name); if (f) return f; }
      return null;
    }
    // pure EN: only Data — no HU-only note, no HU-only folder
    r = await req('GET', '/api/tree?mat_lang=en');
    ok('pure EN excludes HU-only note', !findNode2(r.json, 'Csak Magyar'));
    ok('pure EN excludes HU-only folder (Irodalom)', !findFolder2(r.json, 'Irodalom'));
    ok('pure EN includes EN-only folder (Physics)', !!findFolder2(r.json, 'Physics'));
    ok('pure EN tags note as lang=en', (findNode2(r.json, 'Applied Algebra') || {}).lang === 'en');
    // pure HU: only DataHU — no EN-only folder, shows HU-only content
    r = await req('GET', '/api/tree?mat_lang=hu');
    ok('pure HU includes HU-only note', !!findNode2(r.json, 'Csak Magyar'));
    ok('pure HU includes HU-only folder (Irodalom)', !!findFolder2(r.json, 'Irodalom'));
    ok('pure HU excludes EN-only folder (Physics)', !findFolder2(r.json, 'Physics'));
    const huNode = findNode2(r.json, 'Alkalmazott Algebra');
    ok('pure HU tags note as lang=hu', huNode && huNode.lang === 'hu');
    ok('pure HU note knows its EN counterpart', huNode && huNode.enAvailable === true && !!huNode.enPath);
    const huOnly = findNode2(r.json, 'Csak Magyar');
    ok('HU-only note has no EN counterpart', huOnly && huOnly.enAvailable === false);
    // both: union
    r = await req('GET', '/api/tree?mat_lang=both');
    ok('both mode shows HU-only and EN-only folders', !!findFolder2(r.json, 'Irodalom') && !!findFolder2(r.json, 'Physics'));

    // ── whitelist on a member-only note ──────────────────────────────────────
    await req('POST', '/api/admin/users', { token, body: { username: 'alice', password: 'alicepass' } });
    await req('POST', '/api/admin/users', { token, body: { username: 'bob', password: 'bobpass123' } });
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'VIP Notes {v}.tex',
      content: '\\documentclass{article}\\begin{document}vip\\end{document}',
      meta: { visibility: 'members', allow: 'alice' } } });
    ok('whitelisted note created', r.json && r.json.ok === true);
    const vipTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    ok('data.txt stores allow list', /\[VIP Notes\][\s\S]*?allow: alice/.test(vipTxt));
    const vipPath = encodeURIComponent('STEM/Mathematics/VIP Notes {v}.tex');
    // alice (whitelisted)
    let ca = ((await req('POST', '/api/login', { body: { username: 'alice', password: 'alicepass' } })).headers['set-cookie'] || [])[0].split(';')[0];
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: ca });
    ok('whitelisted user sees note in tree', !!findNode2(r.json, 'VIP Notes'));
    r = await req('GET', '/api/file?lang=en&path=' + vipPath, { cookie: ca });
    ok('whitelisted user can open note', r.status === 200);
    // bob (not whitelisted)
    let cb = ((await req('POST', '/api/login', { body: { username: 'bob', password: 'bobpass123' } })).headers['set-cookie'] || [])[0].split(';')[0];
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: cb });
    ok('non-whitelisted user does NOT see note in tree', !findNode2(r.json, 'VIP Notes'));
    r = await req('GET', '/api/file?lang=en&path=' + vipPath, { cookie: cb });
    ok('non-whitelisted user cannot open note (403)', r.status === 403);
    // anon
    r = await req('GET', '/api/file?lang=en&path=' + vipPath);
    ok('anon cannot open whitelisted note (403)', r.status === 403);
    // admin (via site login with admin creds) bypasses whitelist
    let cadmin = ((await req('POST', '/api/login', { body: { username: 'admin', password: 'testpass' } })).headers['set-cookie'] || [])[0].split(';')[0];
    r = await req('GET', '/api/file?lang=en&path=' + vipPath, { cookie: cadmin });
    ok('admin bypasses whitelist', r.status === 200);
    // cleanup
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'VIP Notes {v}.tex' } });

    // ── request-to-read tier (visible but locked) + access requests + messages ─
    const lpRaw = 'STEM/Mathematics/Locked Paper {L}.tex', lp = encodeURIComponent(lpRaw);
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Locked Paper {L}.tex',
      content: '\\documentclass{article}\\begin{document}locked\\end{document}',
      meta: { visibility: 'request', allow: 'alice' } } });
    ok('request-tier note created', r.json && r.json.ok === true);
    const lockTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    ok('data.txt stores visibility: request', /\[Locked Paper\][\s\S]*?visibility: request/.test(lockTxt));
    // visible-but-locked in the tree for everyone
    r = await req('GET', '/api/tree?mat_lang=en');
    let ln = findNode2(r.json, 'Locked Paper');
    ok('anon SEES the locked note in the tree', !!ln && ln.canRead === 'whitelist' && ln.canSee === 'all');
    ok('locked note flagged locked for anon', !!ln && ln.locked === true);
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: cb });
    ln = findNode2(r.json, 'Locked Paper');
    ok('locked for a non-owner user', !!ln && ln.locked === true);
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: ca });
    ln = findNode2(r.json, 'Locked Paper');
    ok('NOT locked for the owner', !!ln && ln.locked === false);
    // content gating
    r = await req('GET', '/api/file?lang=en&path=' + lp);
    ok('anon cannot open locked content (403)', r.status === 403);
    r = await req('GET', '/api/file?lang=en&path=' + lp, { cookie: cb });
    ok('non-owner cannot open locked content (403)', r.status === 403);
    r = await req('GET', '/api/file?lang=en&path=' + lp, { cookie: ca });
    ok('owner can open locked content', r.status === 200);
    r = await req('GET', '/api/file?lang=en&path=' + lp, { cookie: cadmin });
    ok('admin can open locked content', r.status === 200);
    // access info + request (delivered through chat DMs)
    r = await req('GET', '/api/access/info?lang=en&path=' + lp, { cookie: cb });
    ok('access info: applicable, not granted, recipient is owner', r.json && r.json.applicable === true && r.json.granted === false && r.json.recipients.includes('alice'));
    r = await req('POST', '/api/access/request', { cookie: cb, body: { path: lpRaw, lang: 'en', body: 'May I read this?' } });
    ok('access request sent', r.json && r.json.status === 'requested' && r.json.recipients.includes('alice'));
    r = await req('POST', '/api/access/request', { cookie: cb, body: { path: lpRaw, lang: 'en' } });
    ok('duplicate request is deduped (pending)', r.json && r.json.status === 'pending');
    r = await req('GET', '/api/access/info?lang=en&path=' + lp, { cookie: cb });
    ok('access info now shows pending', r.json && r.json.pending === true);
    // owner sees the request inside a DM from the requester, and accepts
    r = await req('GET', '/api/chat/list', { cookie: ca });
    let dmWithBob = (r.json.conversations || []).find(c => c.type === 'dm' && c.title === 'bob');
    ok('owner has a DM from the requester with unread', !!dmWithBob && dmWithBob.unread >= 1);
    r = await req('GET', '/api/chat/messages?id=' + dmWithBob.id, { cookie: ca });
    const areq = (r.json.messages || []).find(m => m.kind === 'access-request' && m.note && m.note.path === lpRaw && m.status === 'pending');
    ok('DM contains the pending access request', !!areq && areq.from === 'bob');
    r = await req('POST', '/api/access/respond', { cookie: ca, body: { id: areq.id, decision: 'accept', reason: 'Sure, go ahead.' } });
    ok('owner accepted the request', r.json && r.json.ok === true);
    r = await req('GET', '/api/file?lang=en&path=' + lp, { cookie: cb });
    ok('granted user can now open the note', r.status === 200);
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: cb });
    ln = findNode2(r.json, 'Locked Paper');
    ok('note no longer locked for granted user', !!ln && ln.locked === false);
    r = await req('GET', '/api/chat/list', { cookie: cb });
    let dmWithAlice = (r.json.conversations || []).find(c => c.type === 'dm' && c.title === 'alice');
    r = await req('GET', '/api/chat/messages?id=' + dmWithAlice.id, { cookie: cb });
    const ares = (r.json.messages || []).find(m => m.kind === 'access-result' && m.note && m.note.path === lpRaw);
    ok('requester received an accept result with reason', !!ares && ares.decision === 'accepted' && /go ahead/.test(ares.reason));
    // decline path on a second note
    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Locked Two {L2}.tex', content: '\\documentclass{article}\\begin{document}two\\end{document}',
      meta: { visibility: 'request', allow: 'alice' } } });
    const l2 = encodeURIComponent('STEM/Mathematics/Locked Two {L2}.tex');
    await req('POST', '/api/access/request', { cookie: cb, body: { path: 'STEM/Mathematics/Locked Two {L2}.tex', lang: 'en' } });
    r = await req('GET', '/api/chat/messages?id=' + dmWithBob.id, { cookie: ca });
    const areq2 = (r.json.messages || []).find(m => m.kind === 'access-request' && m.note && m.note.path === 'STEM/Mathematics/Locked Two {L2}.tex' && m.status === 'pending');
    r = await req('POST', '/api/access/respond', { cookie: ca, body: { id: areq2.id, decision: 'decline', reason: 'Not yet.' } });
    ok('owner declined the second request', r.json && r.json.ok === true);
    r = await req('GET', '/api/file?lang=en&path=' + l2, { cookie: cb });
    ok('declined user still cannot open (403)', r.status === 403);
    // chat DMs: send / read / unread / validation
    r = await req('POST', '/api/chat/send', { cookie: cb, body: { to: 'alice', body: 'Thanks! See [the paper](ki://note/' + encodeURIComponent(lpRaw) + '?lang=en).' } });
    ok('chat DM message sent', r.json && r.json.ok === true);
    const convId = r.json.id;
    r = await req('GET', '/api/chat/messages?id=' + convId, { cookie: ca });
    const txt = (r.json.messages || []).find(m => m.kind === 'text' && m.from === 'bob' && /ki:\/\/note\//.test(m.body));
    ok('recipient sees the text message with a reference token', !!txt);
    r = await req('GET', '/api/chat/unread', { cookie: ca });
    const before = r.json.unread;
    ok('unread count is positive before reading', before >= 1);
    await req('POST', '/api/chat/read', { cookie: ca, body: { id: convId } });
    r = await req('GET', '/api/chat/unread', { cookie: ca });
    ok('marking the conversation read lowers unread', r.json.unread < before);
    r = await req('POST', '/api/chat/send', { cookie: ca, body: { id: convId, body: 'Replying now', replyTo: txt.id } });
    ok('reply message sent', r.json && r.json.ok === true);
    r = await req('GET', '/api/chat/messages?id=' + convId, { cookie: ca });
    const rep = (r.json.messages || []).find(m => m.body === 'Replying now');
    ok('reply carries replyTo + author + snapshot', !!rep && rep.replyTo === txt.id && rep.replyFrom === 'bob' && /ki:\/\/note\//.test(rep.replyText));
    r = await req('POST', '/api/chat/send', { cookie: cb, body: { to: 'nobody-xyz', body: 'hi' } });
    ok('chat to unknown recipient rejected (400)', r.status === 400);
    r = await req('POST', '/api/chat/send', { cookie: cb, body: { to: 'bob', body: 'self' } });
    ok('cannot DM yourself (400)', r.status === 400);
    r = await req('GET', '/api/chat/list');
    ok('chat requires login (401)', r.status === 401);
    r = await req('GET', '/api/chat/unread');
    ok('chat unread without login returns 0', r.json && r.json.ok === false && r.json.unread === 0);
    // group chats: users list, create, send, membership, gating, addMembers
    r = await req('GET', '/api/chat/users', { cookie: ca });
    ok('chat users excludes self, includes others', r.json && Array.isArray(r.json.users) && !r.json.users.includes('alice') && r.json.users.includes('bob'));
    r = await req('POST', '/api/chat/group', { cookie: ca, body: { title: 'Study Group', participants: ['bob'] } });
    ok('group chat created', r.json && r.json.ok === true);
    const gid = r.json.id;
    r = await req('POST', '/api/chat/group', { cookie: ca, body: { title: 'Lonely', participants: [] } });
    ok('group with no other members rejected (400)', r.status === 400);
    r = await req('POST', '/api/chat/send', { cookie: ca, body: { id: gid, body: 'Welcome to the group' } });
    ok('message sent to group', r.json && r.json.ok === true);
    r = await req('GET', '/api/chat/list', { cookie: cb });
    const grp = (r.json.conversations || []).find(c => c.id === gid);
    ok('group member sees the group with unread', !!grp && grp.type === 'group' && grp.title === 'Study Group' && grp.unread >= 1);
    r = await req('GET', '/api/chat/messages?id=' + gid, { cookie: cadmin });
    ok('non-member cannot read a group (404)', r.status === 404);
    r = await req('POST', '/api/chat/send', { cookie: cadmin, body: { id: gid, body: 'intrude' } });
    ok('non-member cannot post to a group (404)', r.status === 404);
    r = await req('POST', '/api/chat/addMembers', { cookie: ca, body: { id: gid, participants: ['admin'] } });
    ok('member added to the group', r.json && r.json.ok === true && (r.json.added || []).includes('admin'));
    r = await req('GET', '/api/chat/messages?id=' + gid, { cookie: cadmin });
    ok('newly added member can now read the group', r.status === 200 && (r.json.messages || []).some(m => m.kind === 'system' && /added admin/.test(m.body)));

    // ── new access model: separate visibility + readability + owners ─────────
    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Gated A {GA}.tex', content: 'A',
      meta: { canSee: 'all', canRead: 'whitelist', readRequests: true, owners: 'alice' } } });
    const gaTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    ok('data.txt stores can-read + owners (new model)', /\[Gated A\][\s\S]*?can-read: whitelist/.test(gaTxt) && /\[Gated A\][\s\S]*?owners: alice/.test(gaTxt));
    const gaEnc = encodeURIComponent('STEM/Mathematics/Gated A {GA}.tex');
    r = await req('GET', '/api/file?lang=en&path=' + gaEnc, { cookie: ca });
    ok('owner can read a readability-whitelist note', r.status === 200);
    r = await req('GET', '/api/file?lang=en&path=' + gaEnc, { cookie: cb });
    ok('non-owner cannot read it (403)', r.status === 403);
    r = await req('GET', '/api/access/info?lang=en&path=' + gaEnc, { cookie: cb });
    ok('read-request applicable for the non-owner', r.json && r.json.applicable === true && r.json.granted === false);
    r = await req('GET', '/api/tree?mat_lang=en');
    let gaNode = findNode2(r.json, 'Gated A');
    ok('visibility=all note is visible to anon but locked + requestable', !!gaNode && gaNode.locked === true && gaNode.canRequest === true);

    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Hidden B {HB}.tex', content: 'B',
      meta: { canSee: 'whitelist', canRead: 'whitelist', seeAllow: 'alice', readAllow: 'alice' } } });
    const hbEnc = encodeURIComponent('STEM/Mathematics/Hidden B {HB}.tex');
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: ca });
    ok('see-whitelisted user sees the hidden note', !!findNode2(r.json, 'Hidden B'));
    r = await req('GET', '/api/tree?mat_lang=en', { cookie: cb });
    ok('non-listed user does NOT see the hidden note', !findNode2(r.json, 'Hidden B'));
    r = await req('GET', '/api/tree?mat_lang=en');
    ok('anon does NOT see the hidden note', !findNode2(r.json, 'Hidden B'));
    r = await req('GET', '/api/file?lang=en&path=' + hbEnc, { cookie: cb });
    ok('non-listed user cannot open the hidden note (403)', r.status === 403);
    r = await req('GET', '/api/file?lang=en&path=' + hbEnc, { cookie: ca });
    ok('listed user can open the hidden note', r.status === 200);

    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Members C {MC}.tex', content: 'C',
      meta: { canSee: 'all', canRead: 'members' } } });
    const mcEnc = encodeURIComponent('STEM/Mathematics/Members C {MC}.tex');
    r = await req('GET', '/api/file?lang=en&path=' + mcEnc);
    ok('anon cannot read a members-readable note (403)', r.status === 403);
    r = await req('GET', '/api/file?lang=en&path=' + mcEnc, { cookie: cb });
    ok('any signed-in member can read a members-readable note', r.status === 200);

    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Gated A {GA}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Hidden B {HB}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Members C {MC}.tex' } });

    // cleanup request-tier notes
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Locked Paper {L}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Locked Two {L2}.tex' } });

    // ── folder counterpart linking ───────────────────────────────────────────
    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'LinkTest/Alpha', filename: 'A1 {A1}.tex', content: 'a' } });
    await req('POST', '/api/admin/note', { token, body: { lang: 'hu', dir: 'LinkTest/Alfa', filename: 'A1hu {A1H}.tex', content: 'a' } });
    r = await req('GET', '/api/tree?mat_lang=both');
    let lt = findFolder2(r.json, 'LinkTest');
    ok('before link: HU folder Alfa shown separately', !!lt && (lt.children || []).some(c => c.name === 'Alfa'));
    r = await req('POST', '/api/admin/folder/meta', { token, body: { lang: 'en', dir: 'LinkTest/Alpha', altHu: 'Alfa' } });
    ok('folder counterpart link saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/tree?mat_lang=both');
    lt = findFolder2(r.json, 'LinkTest');
    const _alpha = (lt.children || []).find(c => c.name === 'Alpha');
    ok('linked HU folder no longer shown separately', !!lt && !(lt.children || []).some(c => c.name === 'Alfa'));
    ok('linked folder merges the HU-only note as a child', !!_alpha && (_alpha.children || []).some(c => c.huName === 'A1hu {A1H}.tex'));
    r = await req('GET', '/api/admin/browse?lang=en&dir=LinkTest', { token });
    ok('admin browse exposes folder link on the child row', r.status === 200 && (r.json.items || []).some(i => i.name === 'Alpha' && i.altHu === 'Alfa'));
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'LinkTest/Alpha', filename: 'A1 {A1}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'hu', dir: 'LinkTest/Alfa', filename: 'A1hu {A1H}.tex' } });

    // ── note-linked chat references ──────────────────────────────────────────
    r = await req('POST', '/api/chat/send', { cookie: cb, body: { to: 'alice', body: 'See this part', noteRef: { path: 'STEM/Mathematics/Applied Algebra {Algebra}.tex', lang: 'en', label: 'the lemma', from: 10, to: 42 } } });
    ok('chat with a note reference sent', r.json && r.json.ok === true);
    const _nrConv = r.json.id;
    r = await req('GET', '/api/chat/messages?id=' + _nrConv, { cookie: ca });
    const _nrMsg = (r.json.messages || []).find(m => m.noteRef && m.noteRef.label === 'the lemma');
    ok('recipient receives the note reference with char range', !!_nrMsg && _nrMsg.noteRef.path === 'STEM/Mathematics/Applied Algebra {Algebra}.tex' && _nrMsg.noteRef.from === 10 && _nrMsg.noteRef.to === 42);

    // ── site-side note management (owners + collaborators) ────────────────────
    await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Owned Note {OWN}.tex', content: 'body',
      meta: { canSee: 'all', canRead: 'whitelist', readRequests: true, owners: 'alice' } } });
    const _ownPath = 'STEM/Mathematics/Owned Note {OWN}.tex';
    r = await req('GET', '/api/mynotes', { cookie: ca });
    ok('owner sees the note in My Notes (primary)', r.json && (r.json.notes || []).some(n => n.path === _ownPath && n.primary === true));
    r = await req('GET', '/api/mynotes', { cookie: cb });
    ok('non-owner does not see it in My Notes', r.json && !(r.json.notes || []).some(n => n.path === _ownPath));
    r = await req('POST', '/api/note/manage', { cookie: ca, body: { path: _ownPath, lang: 'en', patch: { tags: ['managed'], canSee: 'all', canRead: 'whitelist', readRequests: true, owners: ['alice', 'bob'] } } });
    ok('primary owner can edit + add a collaborator', r.json && r.json.ok === true);
    r = await req('GET', '/api/mynotes', { cookie: cb });
    ok('collaborator now sees the note (not primary)', r.json && (r.json.notes || []).some(n => n.path === _ownPath && n.primary === false));
    r = await req('POST', '/api/note/manage', { cookie: cb, body: { path: _ownPath, lang: 'en', patch: { owners: ['bob'] } } });
    ok('collaborator cannot remove the primary owner (403)', r.status === 403);
    r = await req('POST', '/api/note/manage', { cookie: cb, body: { path: _ownPath, lang: 'en', patch: { owners: ['alice', 'bob', 'admin'] } } });
    ok('collaborator may add another owner', r.json && r.json.ok === true);
    r = await req('POST', '/api/note/manage', { cookie: cb, body: { path: _ownPath, lang: 'en', patch: { owners: ['alice', 'admin'] } } });
    ok('collaborator may leave (remove only self)', r.json && r.json.ok === true);
    r = await req('GET', '/api/mynotes', { cookie: cb });
    ok('after leaving, not in collaborator My Notes', r.json && !(r.json.notes || []).some(n => n.path === _ownPath));
    r = await req('POST', '/api/note/manage', { cookie: cb, body: { path: _ownPath, lang: 'en', patch: { owners: ['bob'] } } });
    ok('ex-collaborator can no longer manage (403)', r.status === 403);
    r = await req('POST', '/api/note/manage', { cookie: cadmin, body: { path: _ownPath, lang: 'en', patch: { tags: ['admintag'] } } });
    ok('admin can always manage a note', r.json && r.json.ok === true);
    const _ownTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    ok('manage persisted metadata + owners to data.txt', /\[Owned Note\][\s\S]*?owners:/.test(_ownTxt) && /\[Owned Note\][\s\S]*?can-read: whitelist/.test(_ownTxt));
    ok('note body untouched by management', fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'Owned Note {OWN}.tex'), 'utf8') === 'body');
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Owned Note {OWN}.tex' } });

    // ── public registration + password change ────────────────────────────────
    r = await req('POST', '/api/register', { body: { username: 'newbie', password: 'short' } });
    ok('register rejects short password (400)', r.status === 400);
    r = await req('POST', '/api/register', { body: { username: 'a b', password: 'longenough1' } });
    ok('register rejects bad username (400)', r.status === 400);
    r = await req('POST', '/api/register', { body: { username: 'newbie', password: 'longenough1' } });
    ok('public register succeeds + auto-login', r.status === 200 && r.json && r.json.ok === true && r.json.role === 'user');
    const newbieCookie = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
    ok('register sets session cookie', /ki_auth=/.test(newbieCookie));
    r = await req('POST', '/api/register', { body: { username: 'newbie', password: 'longenough1' } });
    ok('register rejects duplicate (409)', r.status === 409);
    r = await req('POST', '/api/register', { body: { username: 'admin', password: 'longenough1' } });
    ok('register cannot shadow an admin name (409)', r.status === 409);
    // change password
    r = await req('POST', '/api/account/password', { cookie: newbieCookie, body: { oldPassword: 'wrong', newPassword: 'brandnew123' } });
    ok('password change rejects wrong current (403)', r.status === 403);
    r = await req('POST', '/api/account/password', { cookie: newbieCookie, body: { oldPassword: 'longenough1', newPassword: 'brandnew123' } });
    ok('password change succeeds', r.json && r.json.ok === true);
    r = await req('POST', '/api/login', { body: { username: 'newbie', password: 'longenough1' } });
    ok('old password no longer works (401)', r.status === 401);
    r = await req('POST', '/api/login', { body: { username: 'newbie', password: 'brandnew123' } });
    ok('new password works', r.status === 200 && r.json && r.json.ok === true);
    r = await req('POST', '/api/account/password', { body: { oldPassword: 'x', newPassword: 'brandnew123' } });
    ok('password change requires sign-in (401)', r.status === 401);

    // ── security: sensitive files are not served ─────────────────────────────
    for (const f of ['admins.json', 'users.json', 'server.js', 'make-user.js']) {
      r = await req('GET', '/' + f);
      ok('static server hides ' + f + ' (404)', r.status === 404);
    }
    r = await req('GET', '/data/' + encodeURIComponent('STEM/Mathematics/data.txt'));
    ok('data.txt not served via /data (404)', r.status === 404);
    r = await req('GET', '/');
    ok('security headers present (CSP + nosniff)', !!r.headers['content-security-policy'] && r.headers['x-content-type-options'] === 'nosniff');

    // tidy up registered/whitelist accounts
    for (const u of ['alice', 'bob', 'newbie']) await req('POST', '/api/admin/users/delete', { token, body: { username: u } });

    // ── articles: create / list / serve / folder / validate / delete ─────────
    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'test-article.html', mode:'template',
      meta: { title:'Test Article', date:'2025-03-04', description:'A test piece.', tags:['math','demo'] },
      body:'<h2>Section One</h2><p>Body text.</p>' } });
    ok('article (template) saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/articles?lang=en');
    const ta = (Array.isArray(r.json)?r.json:[]).find(a => a.file === 'test-article.html');
    ok('template article listed w/ parsed metadata', !!ta && ta.title === 'Test Article' && ta.date === '2025-03-04' && (ta.tags||[]).includes('demo'));
    r = await req('GET', '/articles/test-article.html');
    ok('template article served as full styled HTML',
      r.status === 200 && /katex/i.test(r.body) && /<h1 class="title">Test Article<\/h1>/.test(r.body)
      && /Section One/.test(r.body) && !/Els\u0151 szakasz/.test(r.body));

    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'raw.html', mode:'raw',
      content:'<!doctype html><html><head><title>Raw One</title><meta data-date="2025-02-02"><meta data-tags="x,y"></head><body>raw body</body></html>' } });
    ok('article (raw HTML) saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/articles?lang=en');
    ok('raw article listed by its <title>', (Array.isArray(r.json)?r.json:[]).some(a => a.file==='raw.html' && a.title==='Raw One'));

    await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'proj/index.html', mode:'raw',
      content:'<!doctype html><title>Proj Home</title><meta data-date="2025-05-05"><body>home</body>' } });
    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'proj/app.js', mode:'raw', content:'console.log(1)' } });
    ok('folder-article asset (.js) saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/articles?lang=en');
    ok('folder-article listed via index.html', (Array.isArray(r.json)?r.json:[]).some(a => a.file==='proj/index.html' && a.kind==='folder'));
    r = await req('GET', '/articles/proj/app.js');
    ok('folder-article asset served', r.status === 200 && /console\.log/.test(r.body));
    r = await req('GET', '/api/admin/article/list?lang=en', { token });
    const folderItem = (r.json && r.json.items || []).find(i => i.kind==='folder' && i.path==='proj');
    ok('admin list shows folder + its files', !!folderItem && folderItem.files.includes('proj/index.html') && folderItem.files.includes('proj/app.js'));

    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'evil.php', mode:'raw', content:'x' } });
    ok('article save rejects bad extension (400)', r.status === 400);
    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'../escape.html', mode:'raw', content:'x' } });
    ok('article save rejects traversal (400)', r.status === 400);
    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'.secret/index.html', mode:'raw', content:'x' } });
    ok('article save rejects dotfile segment (400)', r.status === 400);
    r = await req('POST', '/api/admin/article/save', { body: { lang:'en', target:'anon.html', mode:'raw', content:'x' } });
    ok('article save requires admin (401)', r.status === 401);

    r = await req('POST', '/api/admin/article/delete', { token, body: { lang:'en', path:'raw.html' } });
    ok('article file deleted', r.json && r.json.ok === true);
    r = await req('GET', '/api/articles?lang=en');
    ok('deleted article no longer listed', !(Array.isArray(r.json)?r.json:[]).some(a => a.file==='raw.html'));
    r = await req('POST', '/api/admin/article/delete', { token, body: { lang:'en', path:'proj' } });
    ok('article folder deleted (recursive)', r.json && r.json.ok === true);
    r = await req('GET', '/articles/proj/app.js');
    ok('deleted folder asset gone (404)', r.status === 404);
    await req('POST', '/api/admin/article/delete', { token, body: { lang:'en', path:'test-article.html' } });

    // Magic Editor styling is self-contained: a template article is fully styled even
    // when template.html is missing on disk (embedded fallback in the server).
    fs.unlinkSync(path.join(SITE, 'template.html'));
    r = await req('POST', '/api/admin/article/save', { token, body: { lang:'en', target:'fallback.html', mode:'template',
      meta: { title:'Fallback Art', date:'2025-06-06', description:'Intro.', tags:['t'] }, body:'<h2>Body Here</h2>' } });
    ok('template save works without template.html on disk', r.json && r.json.ok === true);
    r = await req('GET', '/articles/fallback.html');
    ok('embedded fallback still fully styles the article',
      r.status === 200 && /<style>/.test(r.body) && /katex/i.test(r.body) && /--accent:/.test(r.body)
      && /<h1 class="title">Fallback Art<\/h1>/.test(r.body) && /Body Here/.test(r.body));
    await req('POST', '/api/admin/article/delete', { token, body: { lang:'en', path:'fallback.html' } });

    // ── changelog: main reference + inline reference token persist ───────────
    r = await req('POST', '/api/changelog/add', { token, body: { title:'Linked entry', type:'note',
      body:'See [the note](ki://note/STEM%2FMathematics%2FApplied%20Algebra%20%7BAlgebra%7D.tex?lang=en).',
      ref: { kind:'note', target:'STEM/Mathematics/Applied Algebra {Algebra}.tex', lang:'en', label:'Applied Algebra' } } });
    ok('changelog entry with reference added', r.json && r.json.ok === true);
    r = await req('GET', '/api/changelog');
    const le = (Array.isArray(r.json)?r.json:[]).find(e => e.title==='Linked entry');
    ok('changelog main reference persisted', !!le && le.ref && le.ref.kind==='note' && le.ref.target.includes('Applied Algebra'));
    ok('changelog inline reference token persisted', !!le && /ki:\/\/note\//.test(le.body || ''));
    if (le) await req('POST', '/api/changelog/delete', { token, body: { id: le.id } });

    // ── per-account settings ─────────────────────────────────────────────────
    r = await req('GET', '/api/settings');
    ok('settings GET requires login (401)', r.status === 401);
    r = await req('POST', '/api/settings', { body: { theme: 'teal' } });
    ok('settings POST requires login (401)', r.status === 401);
    const lr = await req('POST', '/api/login', { body: { username: 'admin', password: 'testpass' } });
    const setCk = ((lr.headers['set-cookie'] || [])[0] || '').split(';')[0];
    ok('settings login (site session) works', lr.json && lr.json.ok === true && /ki_auth=/.test(setCk));
    r = await req('GET', '/api/settings', { cookie: setCk });
    ok('account starts with empty settings', r.json && r.json.ok === true && Object.keys(r.json.settings).length === 0);
    r = await req('POST', '/api/settings', { cookie: setCk, body: { theme: 'teal', lang: 'hu', matLang: 'both', sectionBy: 'subject', sectionOrder: '["STEM"]', childOrders: '{}', bogus: 'x' } });
    ok('settings saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/settings', { cookie: setCk });
    ok('settings persisted + unknown keys dropped', r.json && r.json.settings.theme === 'teal' && r.json.settings.lang === 'hu' && r.json.settings.matLang === 'both' && r.json.settings.sectionBy === 'subject' && r.json.settings.bogus === undefined);
    r = await req('POST', '/api/settings', { cookie: setCk, body: { theme: 'rainbow', lang: 'xx' } });
    r = await req('GET', '/api/settings', { cookie: setCk });
    ok('invalid settings values rejected', r.json && r.json.settings.theme === undefined && r.json.settings.lang === undefined);

    // A plain viewer account, so members-only gating is tested without admin powers.
    await req('POST', '/api/admin/users', { token, body: { username: 'dayreader', password: 'dayreader1' } });
    const memberCk = (((await req('POST', '/api/login', { body: { username: 'dayreader', password: 'dayreader1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];

    // ── timetable + day log ──────────────────────────────────────────────────
    const TT_DOC = {
      settings: {
        visibility: 'all', title: 'Class 10.B', days: [1, 2, 3, 4, 5], weekCycle: 2, cycleAnchor: '2026-09-01',
        startDate: '2026-09-01', endDate: '2027-06-15',
        periods: [
          { id: 'p1', label: '1', start: '08:00', end: '08:45' },
          { id: 'p2', label: '2', start: '08:55', end: '09:40' },
          { id: 'p3', label: '3', start: '09:50', end: '10:35' },
        ],
      },
      subjects: [
        { id: 'math', name: 'Mathematics', nameHu: 'Matematika', short: 'Math', color: '#4A90D9', teacher: 'Kovacs', room: '204', folder: 'STEM/Mathematics', folderLang: 'en' },
        { id: 'hist', name: 'History', nameHu: 'Tortenelem', color: 'not-a-colour' },
      ],
      slots: [
        { id: 's1', day: 1, periodId: 'p1', subjectId: 'math', week: 0 },
        { id: 's2', day: 1, periodId: 'p2', subjectId: 'hist', week: 0 },
        { id: 's3', day: 1, periodId: 'p3', subjectId: 'math', week: 1 },
        { id: 'bad1', day: 9, periodId: 'p1', subjectId: 'math', week: 0 },      // bad weekday
        { id: 'bad2', day: 2, periodId: 'nope', subjectId: 'math', week: 0 },    // unknown period
        { id: 'bad3', day: 2, periodId: 'p1', subjectId: 'ghost', week: 0 },     // unknown subject
      ],
      events: [{ id: 'e1', from: '2026-10-23', to: '2026-10-25', kind: 'holiday', label: 'Autumn break', labelHu: 'Oszi szunet' }],
    };

    r = await req('POST', '/api/admin/timetable', { body: { timetable: TT_DOC } });
    ok('timetable save requires admin (401)', r.status === 401);

    r = await req('POST', '/api/admin/timetable', { token, body: { timetable: TT_DOC } });
    ok('timetable saved', r.status === 200 && r.json && r.json.ok === true);
    ok('timetable drops invalid slots', r.json && r.json.timetable.slots.length === 3,
       r.json && JSON.stringify(r.json.timetable.slots.map(s => s.id)));
    ok('timetable normalises colours', r.json && r.json.timetable.subjects[0].color === '#4a90d9' && r.json.timetable.subjects[1].color === '#8b8fa3');

    r = await req('GET', '/api/timetable');
    ok('timetable readable anonymously', r.status === 200 && r.json.ok === true && r.json.timetable.settings.title === 'Class 10.B');

    // Week parity: anchor 2026-09-01 → its Monday (08-31) is week A, so 09-07 is B.
    r = await req('GET', '/api/admin/day?date=2026-09-07', { token });
    ok('plan: week B skips the week-A-only slot', r.json && r.json.plan.week === 1 && r.json.plan.lessons.length === 2);
    ok('plan: lessons come back in period order', r.json && r.json.plan.lessons.map(l => l.periodLabel).join(',') === '1,2');
    r = await req('GET', '/api/admin/day?date=2026-09-14', { token });
    ok('plan: week A includes the week-A-only slot', r.json && r.json.plan.week === 0 && r.json.plan.lessons.length === 3);
    r = await req('GET', '/api/admin/day?date=2026-09-12', { token });
    ok('plan: Saturday has no lessons', r.json && r.json.plan.lessons.length === 0);
    r = await req('GET', '/api/admin/day?date=2026-10-24', { token });
    ok('plan: a holiday date reports its event', r.json && r.json.plan.events.length === 1 && r.json.plan.events[0].label === 'Autumn break');

    // Upload an attachment before the day exists — files are adopted on save.
    const DAY_ID = 'testday001';
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let upl = await reqRaw('POST', '/api/admin/day/upload?day=' + DAY_ID + '&name=' + encodeURIComponent('page 1.png') + '&kind=scan', PNG, { token });
    ok('day attachment uploads', upl.status === 200 && upl.json && upl.json.ok === true && /^\/uploads\/days\//.test(upl.json.url));
    const att = upl.json && upl.json.attachment;
    ok('attachment records name + kind', att && att.name === 'page 1.png' && att.kind === 'scan' && att.ext === '.png' && att.size === PNG.length);

    upl = await reqRaw('POST', '/api/admin/day/upload?day=' + DAY_ID + '&name=evil.svg', Buffer.from('<svg onload="x"/>'), { token });
    ok('upload rejects a scriptable type (.svg)', upl.status === 400);
    upl = await reqRaw('POST', '/api/admin/day/upload?day=' + DAY_ID + '&name=a.png', PNG);
    ok('upload requires admin (401)', upl.status === 401);
    upl = await reqRaw('POST', '/api/admin/day/upload?day=../escape&name=a.png', PNG, { token });
    ok('upload rejects a traversal day id (400)', upl.status === 400);

    const DAY = {
      id: DAY_ID, date: '2026-09-07', title: 'First real Monday', summary: 'Two tests announced.',
      visibility: 'all',
      lessons: [
        { slotId: 's1', subjectId: 'math', subject: 'Mathematics', subjectHu: 'Matematika', color: '#4a90d9',
          periodId: 'p1', periodLabel: '1', start: '08:00', end: '08:45', room: '204', teacher: 'Kovacs',
          kind: 'lesson', what: 'Quadratic equations, completing the square.', homework: 'Ex. 12-18',
          topics: ['quadratics', 'completing the square'],
          notes: [{ path: 'STEM/Mathematics/Applied Algebra {Algebra}.tex', lang: 'en', label: 'Applied Algebra' }],
          attachments: [att] },
        { slotId: 's2', subjectId: 'hist', subject: 'History', periodId: 'p2', kind: 'nonsense', what: 'Surprise test.' },
      ],
    };
    r = await req('POST', '/api/admin/day', { body: { day: DAY } });
    ok('day save requires admin (401)', r.status === 401);
    r = await req('POST', '/api/admin/day', { token, body: { day: { date: 'yesterday' } } });
    ok('day save rejects a bad date (400)', r.status === 400);
    r = await req('POST', '/api/admin/day', { token, body: { day: DAY } });
    ok('day saved', r.status === 200 && r.json && r.json.ok === true);
    ok('day records the week parity', r.json && r.json.day.week === 1);
    ok('day normalises an unknown lesson kind', r.json && r.json.day.lessons[1].kind === 'lesson');
    ok('day stamps the author', r.json && r.json.day.createdBy === 'admin' && r.json.day.updatedBy === 'admin');

    r = await req('POST', '/api/admin/day', { token, body: { day: { id: 'otherid001', date: '2026-09-07', lessons: [] } } });
    ok('a second entry for the same date is refused (409)', r.status === 409);

    r = await req('GET', '/api/days');
    ok('day feed is public', r.status === 200 && r.json.ok === true && r.json.total === 1 && r.json.days[0].title === 'First real Monday');
    r = await req('GET', '/api/days?q=quadratic');
    ok('day feed searches lesson text', r.json && r.json.total === 1);
    r = await req('GET', '/api/days?q=nothinghere');
    ok('day feed search misses cleanly', r.json && r.json.total === 0);
    r = await req('GET', '/api/days?subject=hist');
    ok('day feed filters by subject', r.json && r.json.total === 1);
    r = await req('GET', '/api/days?subject=chem');
    ok('day feed subject filter excludes', r.json && r.json.total === 0);
    r = await req('GET', '/api/days?files=1');
    ok('day feed filters to days with files', r.json && r.json.total === 1);
    r = await req('GET', '/api/days?from=2026-09-08');
    ok('day feed honours a date range', r.json && r.json.total === 0);

    r = await req('GET', '/api/days/index');
    ok('day index summarises counts', r.json && r.json.index.length === 1 && r.json.index[0].counts.files === 1 && r.json.index[0].counts.scans === 1 && r.json.index[0].counts.notes === 1);
    ok('day index carries subject colours', r.json && r.json.index[0].subjects.length === 2);

    r = await req('GET', '/api/day?date=2026-09-07');
    ok('single day returns the log and the plan', r.json && r.json.day && r.json.plan && r.json.plan.lessons.length === 2);
    r = await req('GET', '/api/day?date=2026-09-21');
    ok('an unlogged date still returns its plan', r.json && r.json.ok === true && r.json.day === null && r.json.plan.lessons.length > 0);

    r = await req('GET', '/api/note/days?path=' + encodeURIComponent('STEM/Mathematics/Applied Algebra {Algebra}.tex') + '&lang=en');
    ok('note → days reverse link works', r.json && r.json.days.length === 1 && r.json.days[0].date === '2026-09-07');
    r = await req('GET', '/api/note/days?path=' + encodeURIComponent('STEM/Physics/Mechanics {P}.tex') + '&lang=en');
    ok('note → days is empty for an uncovered note', r.json && r.json.days.length === 0);

    // attachment serving
    r = await req('GET', ('/uploads/days/' + DAY_ID + '/' + att.id + att.ext));
    ok('public day attachment is served', r.status === 200);
    r = await req('GET', ('/uploads/days/' + DAY_ID + '/' + att.id + att.ext) + '?download=1');
    ok('attachment download keeps its real filename', /filename="page%201.png"/.test(r.headers['content-disposition'] || ''));
    r = await req('GET', '/uploads/days/' + DAY_ID + '/deadbeefdeadbeefdeadbeef.png');
    ok('unknown attachment id → 404', r.status === 404);

    // members-only day
    r = await req('POST', '/api/admin/day', { token, body: { day: {
      id: 'secretday01', date: '2026-09-08', title: 'Private', visibility: 'members',
      lessons: [{ subject: 'Chemistry', what: 'members only', attachments: [] }] } } });
    ok('members-only day saved', r.json && r.json.ok === true);
    r = await req('GET', '/api/days');
    ok('anonymous feed hides a members-only day', r.json && r.json.days.every(d => d.date !== '2026-09-08'));
    r = await req('GET', '/api/day?date=2026-09-08');
    ok('anonymous day detail hides a members-only day', r.json && r.json.day === null);
    r = await req('GET', '/api/days/index');
    ok('anonymous index hides a members-only day', r.json && r.json.index.every(d => d.date !== '2026-09-08'));
    r = await req('GET', '/api/days', { cookie: memberCk });
    ok('a signed-in member sees the members-only day', r.json && r.json.days.some(d => d.date === '2026-09-08'));

    // members-only timetable
    r = await req('POST', '/api/admin/timetable', { token, body: { timetable: { ...TT_DOC, settings: { ...TT_DOC.settings, visibility: 'members' } } } });
    r = await req('GET', '/api/timetable');
    ok('members-only timetable is withheld anonymously', r.json && r.json.restricted === true && r.json.timetable === null);
    r = await req('GET', '/api/timetable', { cookie: memberCk });
    ok('members-only timetable opens for a member', r.json && r.json.timetable && r.json.timetable.slots.length === 3);
    await req('POST', '/api/admin/timetable', { token, body: { timetable: TT_DOC } });

    // static routes must never expose the stores or the upload dir
    for (const p of ['/days.json', '/timetable.json', '/DAYS.JSON', '/note-discussions.json', '/ADMINS.JSON']) {
      r = await req('GET', p);
      ok('static server hides ' + p + ' (404)', r.status === 404, 'got ' + r.status);
    }

    // data.txt is metadata, not a note
    r = await req('GET', '/api/file?path=' + encodeURIComponent('STEM/Mathematics/data.txt'));
    ok('/api/file refuses data.txt (404)', r.status === 404);

    // ══ September 2026 audit — regressions ═══════════════════════════════════
    // Each block below pins a defect found in the second audit pass. See
    // Documentation/audit-2026-09.md.

    // Fresh accounts: alice/bob were deleted earlier, and a note's owners must
    // resolve to live accounts for the request flow to name them.
    await req('POST', '/api/admin/users', { token, body: { username: 'owner1', password: 'owner1pass' } });
    await req('POST', '/api/admin/users', { token, body: { username: 'stranger', password: 'strangerpw' } });
    const ownerCk    = (((await req('POST', '/api/login', { body: { username: 'owner1', password: 'owner1pass' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    const strangerCk = (((await req('POST', '/api/login', { body: { username: 'stranger', password: 'strangerpw' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    ok('audit fixtures signed in', /ki_auth=/.test(ownerCk) && /ki_auth=/.test(strangerCk));

    // ── the precompile surface must not leak or be a free job queue ──────────
    // A restricted note the stranger may not see. autoPrecompile walks the whole
    // archive at start-up and files every note under its full path in preStatus;
    // that map used to be served to anyone.
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Hidden Draft {H}.tex',
      content: '\\documentclass{article}\\begin{document}hidden\\end{document}',
      meta: { canSee: 'whitelist', canRead: 'whitelist', seeAllow: 'owner1', readAllow: 'owner1', owners: 'owner1' } } });
    ok('hidden note created for the precompile checks', r.json && r.json.ok === true);
    const hiddenRel = 'STEM/Mathematics/Hidden Draft {H}.tex';
    r = await req('GET', '/api/file?lang=en&path=' + encodeURIComponent(hiddenRel), { cookie: strangerCk });
    ok('the hidden note really is hidden from the stranger (403)', r.status === 403, 'got ' + r.status);

    r = await req('POST', '/api/precompile/folder', { token, body: { folderPath: '', lang: 'en' } });
    ok('precompile/folder answers an admin', r.status === 200 && r.json && typeof r.json.queued === 'number', JSON.stringify(r.json));

    r = await req('GET', '/api/precompile/status');
    ok('anonymous precompile status still reports queue + running',
      r.status === 200 && r.json && typeof r.json.queue === 'number' && typeof r.json.running === 'boolean', JSON.stringify(r.json));
    ok('anonymous precompile status withholds the per-note map', r.json && r.json.status === undefined, JSON.stringify(r.json));
    r = await req('GET', '/api/precompile/status', { token });
    ok('admin precompile status still carries the per-note map', r.json && r.json.status && typeof r.json.status === 'object');

    // The public "Compile all now" button may only queue what the caller can open.
    r = await req('POST', '/api/precompile/folder', { body: { folderPath: 'STEM/Mathematics', lang: 'en' } });
    ok('anonymous precompile/folder is still allowed', r.status === 200 && r.json && typeof r.json.queued === 'number');
    r = await req('GET', '/api/precompile/status', { token });
    const anonQueued = Object.keys((r.json && r.json.status) || {});
    ok('anonymous precompile never queues a note the caller cannot see',
      !anonQueued.some(k => k === 'en:' + hiddenRel && ['queued', 'compiling'].includes(r.json.status[k].state)),
      JSON.stringify(anonQueued.filter(k => k.includes('Hidden Draft'))));

    // ── /api/access/info must not name a hidden note's owners ────────────────
    // The stranger is signed in but on no list for the hidden note, so they may not
    // even know it exists — let alone who owns it.
    r = await req('GET', '/api/access/info?lang=en&path=' + encodeURIComponent(hiddenRel), { cookie: strangerCk });
    ok('access/info reports a hidden note as not applicable', r.json && r.json.ok === true && r.json.applicable === false && r.json.granted === false);
    ok('access/info withholds the owners of a note the caller cannot see',
      r.json && Array.isArray(r.json.recipients) && r.json.recipients.length === 0, JSON.stringify(r.json));

    // A request-tier note *is* visible to everyone, so naming its owners is the
    // whole point of the card — that must keep working.
    const askRel = 'STEM/Mathematics/Ask First {A}.tex';
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Ask First {A}.tex',
      content: '\\documentclass{article}\\begin{document}ask\\end{document}',
      meta: { canSee: 'all', canRead: 'whitelist', readRequests: true, owners: 'owner1' } } });
    ok('request-tier note created', r.json && r.json.ok === true);
    r = await req('GET', '/api/access/info?lang=en&path=' + encodeURIComponent(askRel), { cookie: strangerCk });
    ok('access/info still names the owners when a request is actually possible',
      r.json && r.json.applicable === true && (r.json.recipients || []).includes('owner1'), JSON.stringify(r.json));

    // ── an access request needs the see gate, not just the read gate ─────────
    r = await req('POST', '/api/access/request', { cookie: strangerCk, body: { lang: 'en', path: hiddenRel } });
    ok('access/request refuses a note the caller cannot see', r.status === 400 && r.json && r.json.ok === false, JSON.stringify(r.json));
    r = await req('POST', '/api/access/request', { cookie: strangerCk, body: { lang: 'en', path: askRel } });
    ok('access/request still works on a note the caller can see',
      r.status === 200 && r.json && r.json.status === 'requested', JSON.stringify(r.json));

    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Ask First {A}.tex' } });

    // ── account rules apply wherever an account is created ───────────────────
    r = await req('POST', '/api/admin/users', { token, body: { username: '<img src=x onerror=alert(1)>', password: 'longenough1' } });
    ok('admin cannot create a user whose name is markup', r.status === 400 && r.json && r.json.ok === false, JSON.stringify(r.json));
    r = await req('POST', '/api/admin/users', { token, body: { username: 'ok', password: 'longenough1' } });
    ok('admin cannot create a too-short username', r.status === 400);
    r = await req('POST', '/api/admin/users', { token, body: { username: 'shortpw', password: 'abc' } });
    ok('admin cannot create an account with a weak password', r.status === 400);
    r = await req('GET', '/api/admin/users', { token });
    ok('none of the refused accounts were written',
      !(r.json.users || []).some(u => /[<>]/.test(u) || u === 'ok' || u === 'shortpw'), JSON.stringify(r.json.users));

    // ── a members-only day answers like a day that was never logged ──────────
    // 403 vs 404 is an existence oracle: the status alone would confirm the day.
    r = await req('GET', '/uploads/days/secretday01/' + 'a'.repeat(24) + '.png');
    ok('members-only day attachment 404s anonymously (no existence oracle)', r.status === 404, 'got ' + r.status);
    r = await req('GET', '/uploads/days/nosuchday999/' + 'a'.repeat(24) + '.png');
    ok('an unknown day id answers identically', r.status === 404, 'got ' + r.status);

    // ── data.txt can never gain a section from a value a member controls ─────
    // A note owner may edit their own note's metadata. A newline in a value would
    // otherwise open a second [Section] and rewrite a neighbouring note's access —
    // here, the hidden note that sits in the same folder.
    const injRel = 'STEM/Mathematics/Owned Note {O}.tex';
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Owned Note {O}.tex',
      content: '\\documentclass{article}\\begin{document}owned\\end{document}',
      meta: { canSee: 'all', canRead: 'all', owners: 'owner1' } } });
    ok('owned note created', r.json && r.json.ok === true);
    r = await req('POST', '/api/note/manage', { cookie: ownerCk, body: { lang: 'en', path: injRel,
      patch: { description: 'one\ntwo\n[Hidden Draft]\ncan-see: all\ncan-read: all' } } });
    ok('note/manage accepts the edit', r.json && r.json.ok === true, JSON.stringify(r.json));
    const injTxt = fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8');
    const injSections = injTxt.split(/\r?\n/).filter(L => /^\[.+\]$/.test(L.trim())).map(L => L.trim());
    ok('no duplicate section was injected',
      injSections.length === new Set(injSections).size, JSON.stringify(injSections));
    ok('the newlines were flattened into the one value',
      /^description: one two \[Hidden Draft\] can-see: all can-read: all$/m.test(injTxt), JSON.stringify(injTxt.slice(-500)));
    r = await req('GET', '/api/file?lang=en&path=' + encodeURIComponent(hiddenRel), { cookie: strangerCk });
    ok('the neighbouring note kept its restriction', r.status === 403, 'got ' + r.status);
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Owned Note {O}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Hidden Draft {H}.tex' } });

    // ── a session must not outlive the account or the password behind it ─────
    // The token store is the only thing between a removed account and the site;
    // deleting the row in users.json does nothing to a browser already holding a
    // token, so an ex-member stayed signed in for up to eight hours.
    await req('POST', '/api/admin/users', { token, body: { username: 'expired1', password: 'expiredpw1' } });
    const expCk = (((await req('POST', '/api/login', { body: { username: 'expired1', password: 'expiredpw1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    r = await req('GET', '/api/me', { cookie: expCk });
    ok('the doomed account is signed in', r.json && r.json.ok === true && r.json.username === 'expired1');
    r = await req('POST', '/api/admin/users/delete', { token, body: { username: 'expired1' } });
    ok('deleting the account reports the sessions it ended', r.json && r.json.ok === true && r.json.revoked >= 1, JSON.stringify(r.json));
    r = await req('GET', '/api/me', { cookie: expCk });
    ok('a deleted account is signed out immediately', r.json && r.json.ok === false, JSON.stringify(r.json));
    r = await req('GET', '/api/chat/list', { cookie: expCk });
    ok('and its token no longer opens the member API', r.status === 401, 'got ' + r.status);

    // An admin resetting a password is usually locking someone out.
    await req('POST', '/api/admin/users', { token, body: { username: 'resetme1', password: 'resetmepw1' } });
    const resetCk = (((await req('POST', '/api/login', { body: { username: 'resetme1', password: 'resetmepw1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    await req('POST', '/api/admin/users', { token, body: { username: 'resetme1', password: 'brandnewpw2' } });
    r = await req('GET', '/api/me', { cookie: resetCk });
    ok('an admin password reset ends the old sessions', r.json && r.json.ok === false, JSON.stringify(r.json));

    // Changing your own password signs out your other devices but not this one.
    const selfA = (((await req('POST', '/api/login', { body: { username: 'resetme1', password: 'brandnewpw2' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    const selfB = (((await req('POST', '/api/login', { body: { username: 'resetme1', password: 'brandnewpw2' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    ok('two sessions for the same account differ', selfA !== selfB);
    r = await req('POST', '/api/account/password', { cookie: selfB, body: { oldPassword: 'brandnewpw2', newPassword: 'thirdpassw3' } });
    ok('self-service password change succeeds', r.json && r.json.ok === true, JSON.stringify(r.json));
    r = await req('GET', '/api/me', { cookie: selfB });
    ok('the tab that changed it stays signed in', r.json && r.json.ok === true && r.json.username === 'resetme1');
    r = await req('GET', '/api/me', { cookie: selfA });
    ok('the other device is signed out', r.json && r.json.ok === false, JSON.stringify(r.json));
    await req('POST', '/api/admin/users/delete', { token, body: { username: 'resetme1' } });

    // ══ Pre-hosting features ═════════════════════════════════════════════════

    // ── Backup export ────────────────────────────────────────────────────────
    r = await req('GET', '/api/admin/export');
    ok('export needs an admin token (401)', r.status === 401, 'got ' + r.status);
    const zipRes = await reqBuf('GET', '/api/admin/export', { token });
    ok('export returns a zip', zipRes.status === 200 && /zip/.test(zipRes.headers['content-type'] || ''), zipRes.headers['content-type']);
    ok('export names the file by date', /filename="digitalization-backup-\d{4}-\d{2}-\d{2}/.test(zipRes.headers['content-disposition'] || ''), zipRes.headers['content-disposition']);
    const zbuf = zipRes.buf;
    ok('the zip has a local file header', zbuf.length > 100 && zbuf.readUInt32LE(0) === 0x04034b50, 'magic=' + (zbuf.length > 4 ? zbuf.readUInt32LE(0).toString(16) : 'n/a'));
    ok('the zip has an end-of-central-directory record', zbuf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) > 0);
    const zipNames = [];
    { // read the central directory rather than trusting the local headers
      let p = zbuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      while (p > 0 && zbuf.readUInt32LE(p) === 0x02014b50) {
        const nlen = zbuf.readUInt16LE(p + 28), elen = zbuf.readUInt16LE(p + 30), clen = zbuf.readUInt16LE(p + 32);
        zipNames.push(zbuf.slice(p + 46, p + 46 + nlen).toString('utf8'));
        p += 46 + nlen + elen + clen;
      }
    }
    ok('the zip carries the state files', zipNames.includes('state/admins.json') && zipNames.includes('state/days.json'), JSON.stringify(zipNames.slice(0, 12)));
    ok('the zip carries a restore note', zipNames.includes('README-restore.txt'), JSON.stringify(zipNames));
    ok('a state-only export leaves the note tree out', !zipNames.some(n => n.startsWith('Data/')), JSON.stringify(zipNames.filter(n => n.startsWith('Data'))));
    const zipAll = await reqBuf('GET', '/api/admin/export?what=all', { token });
    ok('what=all is larger than the state-only export', zipAll.buf.length > zbuf.length, zipAll.buf.length + ' vs ' + zbuf.length);

    // ── Password reset ───────────────────────────────────────────────────────
    await req('POST', '/api/admin/users', { token, body: { username: 'lockedout', password: 'lockedpw01' } });
    r = await req('POST', '/api/password-reset/request', { body: { username: 'lockedout' } });
    ok('a reset request is accepted', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json));
    r = await req('POST', '/api/password-reset/request', { body: { username: 'definitely-not-a-user' } });
    ok('an unknown username answers identically (no oracle)', r.status === 200 && r.json && r.json.ok === true && r.json.sent === true, JSON.stringify(r.json));

    // The card reaches the admin's chat, from the member, with no attacker text.
    r = await req('GET', '/api/chat/list', { cookie: cadmin });
    const pwConvo = (r.json.conversations || []).find(c => (c.participants || []).some(p => String(p).toLowerCase() === 'lockedout'));
    ok('the request lands in the admin chat list', !!pwConvo, JSON.stringify((r.json.conversations || []).map(c => c.participants)));
    r = await req('GET', '/api/chat/messages?id=' + encodeURIComponent(pwConvo ? pwConvo.id : ''), { cookie: cadmin });
    const pwCard = ((r.json && r.json.messages) || []).find(m => m.kind === 'password-reset');
    ok('the card is a password-reset card, pending', !!pwCard && pwCard.status === 'pending', JSON.stringify(pwCard));
    ok('the card carries no free text from the requester', !!pwCard && !pwCard.body, JSON.stringify(pwCard));

    r = await req('POST', '/api/admin/password-reset/issue', { body: { username: 'lockedout' } });
    ok('issuing a link needs admin (401)', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/admin/password-reset/issue', { token, body: { username: 'nobody-here' } });
    ok('issuing for an unknown account is refused (404)', r.status === 404);
    r = await req('POST', '/api/admin/password-reset/issue', { token, body: { username: 'lockedout' } });
    ok('an admin can issue a one-time link', r.json && r.json.ok === true && /^\/#reset=[0-9a-f]{64}$/.test(r.json.path || ''), JSON.stringify(r.json));
    const resetTok = (r.json.path || '').split('=')[1];
    // A site session whose role is admin works too — the card lives in chat, not DevTools.
    r = await req('POST', '/api/admin/password-reset/issue', { cookie: cadmin, body: { username: 'lockedout' } });
    ok('an admin site session can issue it as well', r.json && r.json.ok === true && !!r.json.path, JSON.stringify(r.json));
    const resetTok2 = (r.json.path || '').split('=')[1];
    ok('issuing again retires the previous link', resetTok2 !== resetTok);

    r = await req('POST', '/api/password-reset/complete', { body: { token: resetTok, newPassword: 'whatever12' } });
    ok('the retired link no longer works', r.status === 400 && r.json && r.json.ok === false, JSON.stringify(r.json));
    r = await req('POST', '/api/password-reset/complete', { body: { token: 'f'.repeat(64), newPassword: 'whatever12' } });
    ok('a made-up token is refused', r.status === 400);
    r = await req('POST', '/api/password-reset/complete', { body: { token: resetTok2, newPassword: 'sh' } });
    ok('a short new password is refused', r.status === 400 && /8 characters/.test((r.json && r.json.error) || ''), JSON.stringify(r.json));

    // A live session for that account, to prove the reset ends it.
    const staleCk = (((await req('POST', '/api/login', { body: { username: 'lockedout', password: 'lockedpw01' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    r = await req('POST', '/api/password-reset/complete', { body: { token: resetTok2, newPassword: 'freshpass99' } });
    ok('the link sets the new password and signs in', r.status === 200 && r.json && r.json.ok === true && r.json.username === 'lockedout', JSON.stringify(r.json));
    const freshCk = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
    ok('completing the reset returns a session cookie', /ki_auth=/.test(freshCk));
    r = await req('GET', '/api/me', { cookie: freshCk });
    ok('that session is live', r.json && r.json.ok === true && r.json.username === 'lockedout');
    r = await req('GET', '/api/me', { cookie: staleCk });
    ok('the reset signed the old session out', r.json && r.json.ok === false, JSON.stringify(r.json));
    r = await req('POST', '/api/password-reset/complete', { body: { token: resetTok2, newPassword: 'anotherpw11' } });
    ok('the link cannot be used twice', r.status === 400, 'got ' + r.status);
    r = await req('POST', '/api/login', { body: { username: 'lockedout', password: 'freshpass99' } });
    ok('the new password works at sign-in', r.status === 200 && r.json && r.json.ok === true);
    r = await req('GET', '/api/chat/messages?id=' + encodeURIComponent(pwConvo ? pwConvo.id : ''), { cookie: cadmin });
    const pwDone = ((r.json && r.json.messages) || []).find(m => m.kind === 'password-reset');
    ok('the card closes once the link is used', !!pwDone && pwDone.status === 'done', JSON.stringify(pwDone));
    await req('POST', '/api/admin/users/delete', { token, body: { username: 'lockedout' } });

    // ── Search inside note bodies ────────────────────────────────────────────
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Findable {F}.tex',
      content: '\\documentclass{article}\\begin{document}\nThe zorbulon identity is a curiosity.\nzorbulon again.\n\\end{document}',
      meta: { canSee: 'all', canRead: 'all' } } });
    ok('searchable note created', r.json && r.json.ok === true);
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Hidden Findable {G}.tex',
      content: '\\documentclass{article}\\begin{document}zorbulon in a private note\\end{document}',
      meta: { canSee: 'whitelist', canRead: 'whitelist', seeAllow: 'owner1', readAllow: 'owner1', owners: 'owner1' } } });
    ok('restricted searchable note created', r.json && r.json.ok === true);

    r = await req('GET', '/api/search?q=zorbulon&lang=en');
    ok('search finds the phrase inside a note', r.json && r.json.ok === true && r.json.results.some(x => x.display === 'Findable'), JSON.stringify(r.json && r.json.results));
    const hit = ((r.json && r.json.results) || []).find(x => x.display === 'Findable');
    ok('the hit carries a snippet with the phrase', hit && /zorbulon/i.test(hit.snippet), hit && hit.snippet);
    ok('the hit counts every occurrence', hit && hit.hits === 2, hit && String(hit.hits));
    ok('the hit reports its folder and line', hit && hit.folder === 'STEM/Mathematics' && hit.line >= 1, JSON.stringify(hit));
    ok('search hides a restricted note from an anonymous caller',
      !((r.json && r.json.results) || []).some(x => x.display === 'Hidden Findable'), JSON.stringify((r.json.results || []).map(x => x.display)));
    r = await req('GET', '/api/search?q=zorbulon&lang=en', { cookie: ownerCk });
    ok('search shows the restricted note to its owner',
      ((r.json && r.json.results) || []).some(x => x.display === 'Hidden Findable'), JSON.stringify((r.json.results || []).map(x => x.display)));
    r = await req('GET', '/api/search?q=z');
    ok('a one-character query is ignored', r.json && r.json.ok === true && r.json.results.length === 0);
    r = await req('GET', '/api/search?q=' + encodeURIComponent('definitely-not-in-any-note-xyzzy'));
    ok('a miss returns cleanly', r.json && r.json.ok === true && r.json.results.length === 0);
    r = await req('GET', '/api/search?q=' + encodeURIComponent('see-allow'));
    ok('search never reads data.txt', r.json && r.json.results.every(x => x.name !== 'data.txt'), JSON.stringify(r.json.results));
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Findable {F}.tex' } });
    await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: 'Hidden Findable {G}.tex' } });

    // ── Logging one lesson straight from the timetable ───────────────────────
    r = await req('GET', '/api/admin/day/draftid?date=2026-09-21');
    ok('draftid needs admin (401)', r.status === 401);
    r = await req('GET', '/api/admin/day/draftid?date=not-a-date', { token });
    ok('draftid rejects a bad date (400)', r.status === 400);
    r = await req('GET', '/api/admin/day/draftid?date=2026-09-21', { token });
    ok('draftid hands out an id for an unlogged date', r.json && r.json.ok === true && !!r.json.id && r.json.exists === false, JSON.stringify(r.json));
    const draftId = r.json.id;

    r = await req('POST', '/api/admin/day/lesson', { body: { date: '2026-09-21', slotId: 's1' } });
    ok('quick log needs admin (401)', r.status === 401);
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: 'nope', slotId: 's1' } });
    ok('quick log rejects a bad date (400)', r.status === 400);

    // 2026-09-21 is a Monday, and slotA is Monday period 1 in the fixture timetable.
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: '2026-09-21', dayId: draftId, slotId: 's1',
      lesson: { what: 'Filled two pages by hand.', homework: 'finish the sheet', kind: 'lesson' } } });
    ok('quick log creates the day and the lesson', r.json && r.json.ok === true && r.json.day && r.json.day.lessons.length === 1, JSON.stringify(r.json));
    const qlDay = r.json.day;
    ok('quick log snapshots the subject from the timetable', qlDay.lessons[0].subject === 'Mathematics' && qlDay.lessons[0].color, JSON.stringify(qlDay.lessons[0]));
    ok('quick log snapshots the period label and time', qlDay.lessons[0].periodLabel === '1' && qlDay.lessons[0].start === '08:00', JSON.stringify(qlDay.lessons[0]));
    ok('quick log stamps the week parity', qlDay.week === 0 || qlDay.week === 1, String(qlDay.week));
    ok('quick log records the author', qlDay.updatedBy === 'admin' && qlDay.createdBy === 'admin', JSON.stringify({ c: qlDay.createdBy, u: qlDay.updatedBy }));

    r = await req('GET', '/api/admin/day/draftid?date=2026-09-21', { token });
    ok('draftid now returns the saved day', r.json && r.json.exists === true && r.json.id === qlDay.id, JSON.stringify(r.json));

    // A second save updates the same lesson instead of duplicating it.
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: '2026-09-21', dayId: qlDay.id, slotId: 's1',
      lesson: { what: 'Corrected: filled three pages.', kind: 'test' } } });
    ok('a second save updates rather than duplicates', r.json && r.json.day.lessons.length === 1, JSON.stringify(r.json.day && r.json.day.lessons));
    ok('the update took the new text and kind', r.json.day.lessons[0].what === 'Corrected: filled three pages.' && r.json.day.lessons[0].kind === 'test', JSON.stringify(r.json.day.lessons[0]));

    // A second lesson on the same day sits alongside the first, in period order.
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: '2026-09-21', dayId: qlDay.id, slotId: 's2',
      lesson: { what: 'Second period.' } } });
    ok('another lesson is added to the same day', r.json && r.json.day.lessons.length === 2, JSON.stringify(r.json.day.lessons.map(l => l.periodLabel)));
    ok('lessons stay in period order', r.json.day.lessons[0].periodLabel === '1' && r.json.day.lessons[1].periodLabel === '2',
       JSON.stringify(r.json.day.lessons.map(l => l.periodLabel)));

    // It is public straight away, like any other logged day.
    r = await req('GET', '/api/day?date=2026-09-21');
    ok('the quick-logged day is publicly readable', r.json && r.json.day && r.json.day.lessons.length === 2);

    // Emptying a lesson removes it; emptying the day removes the day.
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: '2026-09-21', dayId: qlDay.id, slotId: 's2',
      lesson: { what: '', homework: '', kind: 'lesson', topics: [], notes: [], attachments: [] } } });
    ok('an emptied lesson is dropped', r.json && r.json.day && r.json.day.lessons.length === 1, JSON.stringify(r.json.day && r.json.day.lessons));
    r = await req('POST', '/api/admin/day/lesson', { token, body: { date: '2026-09-21', dayId: qlDay.id, slotId: 's1',
      lesson: { what: '', homework: '', kind: 'lesson', topics: [], notes: [], attachments: [] } } });
    ok('a day emptied of every lesson is removed', r.json && r.json.ok === true && r.json.removed === true, JSON.stringify(r.json));
    r = await req('GET', '/api/day?date=2026-09-21');
    ok('and it is gone from the public day endpoint', r.json && r.json.day === null, JSON.stringify(r.json && r.json.day));

    // The whole point of quick logging is that it happens from the site's own
    // timetable grid, where there is no DevTools header token — only the admin's
    // site cookie. A plain member's cookie must still be refused.
    r = await req('GET', '/api/admin/day/draftid?date=2026-09-28', { cookie: cadmin });
    ok('draftid accepts an admin site session', r.status === 200 && r.json && r.json.ok === true, 'got ' + r.status);
    r = await req('GET', '/api/admin/day/draftid?date=2026-09-28', { cookie: ownerCk });
    ok('draftid refuses a plain member session', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/admin/day/lesson', { cookie: ownerCk, body: { date: '2026-09-28', slotId: 's1', lesson: { what: 'nope' } } });
    ok('quick log refuses a plain member session', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/admin/day/lesson', { cookie: cadmin, body: { date: '2026-09-28', slotId: 's1', lesson: { what: 'Logged from the grid.' } } });
    ok('quick log accepts an admin site session', r.json && r.json.ok === true && r.json.day.lessons.length === 1, JSON.stringify(r.json));
    ok('it records the site admin as the author', r.json.day.updatedBy === 'admin', r.json.day.updatedBy);
    r = await reqRaw('POST', '/api/admin/day/upload?day=' + encodeURIComponent(r.json.day.id) + '&name=grid.png&kind=scan',
      Buffer.from('89504e470d0a1a0a', 'hex'), { cookie: cadmin });
    ok('an attachment uploads on an admin site session', r.json && r.json.ok === true, JSON.stringify(r.json));
    r = await reqRaw('POST', '/api/admin/day/upload?day=someday&name=grid.png&kind=scan', Buffer.from('89504e470d0a1a0a', 'hex'), { cookie: ownerCk });
    ok('a plain member cannot upload', r.status === 401, 'got ' + r.status);

    // A file uploaded against a day that has not been saved yet is the draft state
    // the quick-log panel sits in. The admin must be able to see it (or the preview
    // of the scan they just dropped is broken); nobody else may.
    const draft2 = (await req('GET', '/api/admin/day/draftid?date=2026-09-29', { cookie: cadmin })).json.id;
    r = await reqRaw('POST', '/api/admin/day/upload?day=' + encodeURIComponent(draft2) + '&name=draft.png&kind=scan',
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), { cookie: cadmin });
    ok('an upload against an unsaved day is accepted', r.json && r.json.ok === true, JSON.stringify(r.json));
    const draftUrl = r.json && r.json.url;
    r = await req('GET', draftUrl, { cookie: cadmin });
    ok('the admin can preview it before saving', r.status === 200, 'got ' + r.status);
    r = await req('GET', draftUrl);
    ok('nobody else can (404)', r.status === 404, 'got ' + r.status);
    await req('POST', '/api/admin/day/delete', { token, body: { date: '2026-09-28' } });

    // ── robots.txt and the 404 page ──────────────────────────────────────────
    r = await req('GET', '/robots.txt');
    ok('robots.txt is served', r.status === 200 && /^User-agent: \*/m.test(r.body), r.body.slice(0, 80));
    ok('robots.txt keeps crawlers out of the API and uploads',
      /Disallow: \/api\//.test(r.body) && /Disallow: \/uploads\//.test(r.body) && /Disallow: \/devtools/.test(r.body), r.body);

    r = await req('GET', '/this-page-does-not-exist');
    ok('an unknown page returns 404', r.status === 404, 'got ' + r.status);
    ok('and it is the styled page, not bare text', /text\/html/.test(r.headers['content-type'] || '') && /404/.test(r.body), r.headers['content-type']);
    ok('the 404 page asks not to be indexed', /name="robots" content="noindex"/.test(r.body));
    r = await req('GET', '/api/definitely-not-a-route');
    ok('an unknown API path still answers JSON', /json/.test(r.headers['content-type'] || '') && r.status === 404, r.headers['content-type']);
    r = await req('GET', '/admins.json');
    ok('a protected file gets the 404 page too, not a hint', r.status === 404);

    // ── HSTS is emitted on HTTPS only ────────────────────────────────────────
    r = await req('GET', '/api/me');
    ok('no HSTS over plain HTTP', !r.headers['strict-transport-security'], r.headers['strict-transport-security']);
    // The other half: a trusted proxy reporting HTTPS must switch it on. This
    // client connects over IPv4 to a dual-stack listener, so the server sees
    // ::ffff:127.0.0.1 — the exact shape that silently disabled HSTS, the cookie's
    // Secure flag and per-IP rate limiting on the real server.
    r = await req('GET', '/api/me', { headers: { 'X-Forwarded-Proto': 'https' } });
    ok('HSTS once a trusted proxy reports HTTPS',
      /max-age=\d+/.test(r.headers['strict-transport-security'] || ''), r.headers['strict-transport-security']);
    ok('the other security headers are always present',
      r.headers['x-content-type-options'] === 'nosniff' && !!r.headers['content-security-policy'] && !!r.headers['x-frame-options']);
    const shellRes = await req('GET', '/devtools');
    ok('shell CSP is nonce-based, not unsafe-inline',
      /script-src 'self' 'nonce-[^']+'/.test(shellRes.headers['content-security-policy'] || '') &&
      !/script-src[^;]*unsafe-inline/.test(shellRes.headers['content-security-policy'] || ''),
      shellRes.headers['content-security-policy']);

    // ── the compile endpoint is bounded ──────────────────────────────────────
    // 90 requests per 5 minutes per IP; a cache miss forks two real pdflatex runs.
    let compileStatuses = new Set();
    for (let i = 0; i < 95; i++) {
      const cr = await req('POST', '/api/compile', { body: { path: 'STEM/Mathematics/nope-' + i + '.tex', lang: 'en' } });
      compileStatuses.add(cr.status);
      if (cr.status === 429) break;
    }
    ok('/api/compile rate-limits a burst', compileStatuses.has(429), [...compileStatuses].join(','));

    // ── the admin console cannot be brute-forced ─────────────────────────────
    // Its own bucket, so this cannot lock the site sign-in used by later tests.
    let adminLast = null;
    for (let i = 0; i < 25; i++) {
      adminLast = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'guess' + i } });
      if (adminLast.status === 429) break;
    }
    ok('/api/admin/login rate-limits a brute-force run', adminLast.status === 429, 'got ' + adminLast.status);
    r = await req('POST', '/api/login', { body: { username: 'owner1', password: 'owner1pass' } });
    ok('the site sign-in keeps its own budget', r.status === 200 && r.json && r.json.ok === true, 'got ' + r.status);
    // the existing admin token is unaffected by the lockout
    r = await req('GET', '/api/admin/me', { token });
    ok('an established admin session survives the lockout', r.json && r.json.ok === true);


    // ── note donations ───────────────────────────────────────────────────────
    // A member offers material; an admin audits it. The rules worth pinning down
    // are the containment ones: a submission is not part of the archive, it is
    // readable by nobody but its donor and the admins, and only an admin can turn
    // one into a note.
    r = await req('POST', '/api/donate/draft', {});
    ok('donations need a session', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/donate/draft', { cookie: ownerCk });
    const donId = r.json && r.json.donation && r.json.donation.id;
    ok('a member opens a draft', r.json && r.json.ok === true && !!donId, r.body.slice(0, 160));
    r = await req('POST', '/api/donate/draft', { cookie: ownerCk });
    ok('the draft is reused, not multiplied', r.json && r.json.donation && r.json.donation.id === donId);

    r = await reqRaw('POST', '/api/donate/upload?id=' + donId + '&name=x.svg', Buffer.from('<svg/>'), { cookie: ownerCk });
    ok('a scriptable file type is refused', r.status === 400, 'got ' + r.status);
    r = await reqRaw('POST', '/api/donate/upload?id=' + donId + '&name=figure.png', Buffer.from('PNGDATA'), { cookie: ownerCk });
    const donPng = r.json && r.json.item && r.json.item.id;
    ok('an image is staged', r.json && r.json.ok === true && !!donPng, r.body.slice(0, 160));
    r = await reqRaw('POST', '/api/donate/upload?id=' + donId + '&name=sneak.png', Buffer.from('X'), { cookie: strangerCk });
    ok('another member cannot upload into it', r.status === 404, 'got ' + r.status);

    // An empty donation is refused — but "empty" means no text *and* no files, so
    // this needs a draft with nothing staged in it. A scan on its own is a perfectly
    // good donation, which is why owner1's draft (which holds the figure) is not it.
    r = await req('POST', '/api/donate/draft', { cookie: strangerCk });
    const emptyDraft = r.json && r.json.donation && r.json.donation.id;
    r = await req('POST', '/api/donate/submit', { cookie: strangerCk, body: { id: emptyDraft, title: 'Nothing here' } });
    ok('a donation with neither text nor files is refused', r.status === 400, 'got ' + r.status + ' ' + r.body.slice(0, 80));
    r = await req('POST', '/api/donate/submit', { cookie: strangerCk, body: { id: emptyDraft, title: '', text: 'x' } });
    ok('a donation with no title is refused', r.status === 400, 'got ' + r.status);

    r = await req('POST', '/api/donate/submit', { cookie: ownerCk, body: {
      id: donId, title: 'Donated  {Tag} /Thermo', textExt: '.tex',
      text: '\\documentclass{article}\\begin{document}Donated\\end{document}',
      message: 'from the test', lang: 'en', suggestPath: '../../etc/passwd' } });
    ok('the donation is submitted', r.json && r.json.ok === true && r.json.donation.status === 'pending', r.body.slice(0, 200));
    const donTex = (r.json.donation.items || []).find(i => i.ext === '.tex');
    ok('the typed body became a staged .tex', !!donTex, JSON.stringify(r.json.donation.items));
    ok('braces and slashes never reach the filename', donTex && !/[{}/\\]/.test(donTex.name), donTex && donTex.name);
    ok('a suggested path cannot climb out of the archive', !/\.\.\//.test(r.json.donation.suggestPath), r.json.donation.suggestPath);

    // Staged files are readable by the donor and admins only — 404 to anyone else,
    // so the status code alone never confirms a submission exists.
    r = await req('GET', '/uploads/donations/' + donId + '/' + donPng + '.png');
    ok('a staged file is invisible to an anonymous visitor', r.status === 404, 'got ' + r.status);
    r = await req('GET', '/uploads/donations/' + donId + '/' + donPng + '.png', { cookie: strangerCk });
    ok('and to another member', r.status === 404, 'got ' + r.status);
    r = await req('GET', '/uploads/donations/' + donId + '/' + donPng + '.png', { cookie: ownerCk });
    ok('but the donor can read their own', r.status === 200, 'got ' + r.status);
    r = await req('GET', '/donations.json');
    ok('donations.json is not served statically', r.status === 404, 'got ' + r.status);
    r = await req('GET', '/DONATIONS.JSON');
    ok('nor is it served under a different case', r.status === 404, 'got ' + r.status);

    r = await req('GET', '/api/admin/donations', { cookie: ownerCk });
    ok('a member cannot read the review queue', r.status === 401, 'got ' + r.status);
    r = await req('GET', '/api/admin/donations', { token });
    ok('an admin sees the pending donation', r.json && r.json.ok === true && r.json.pending === 1, r.body.slice(0, 200));
    r = await req('GET', '/api/admin/donation/text?id=' + donId + '&item=' + donTex.id, { token });
    ok('an admin can read the source before deciding', r.json && r.json.ok === true && /Donated/.test(r.json.text));
    r = await req('GET', '/api/admin/donation/text?id=' + donId + '&item=' + donTex.id, { cookie: ownerCk });
    ok('the donor cannot read it through the admin route', r.status === 401, 'got ' + r.status);

    r = await req('POST', '/api/admin/donation/accept', { cookie: ownerCk, body: { id: donId, item: donTex.id, lang: 'en', dir: '' } });
    ok('a member cannot accept their own donation', r.status === 401, 'got ' + r.status);
    // safePath sanitises rather than rejects, so a climbing dir is contained; the
    // path that comes back must describe where the file really went.
    r = await req('POST', '/api/admin/donation/accept', { token, body: {
      id: donId, item: donTex.id, lang: 'en', dir: 'STEM/Mathematics/', filename: 'Donated Thermodynamics',
      extras: [donPng], meta: { tags: ['thermo'], description: 'A donated note' } } });
    ok('the admin accepts it', r.json && r.json.ok === true, r.body.slice(0, 240));
    ok('a trailing slash in the folder is tolerated', r.json && r.json.path === 'STEM/Mathematics/Donated Thermodynamics.tex', r.json && r.json.path);
    ok('the attached figure travels with it', r.json && (r.json.written || []).length === 2, JSON.stringify(r.json && r.json.written));
    ok('the note is really on disk', fs.existsSync(path.join(DATA, 'STEM', 'Mathematics', 'Donated Thermodynamics.tex')));
    ok('the donor is credited as an author',
      /authors:[^\n]*owner1/.test(fs.readFileSync(path.join(DATA, 'STEM', 'Mathematics', 'data.txt'), 'utf8')));
    ok('the staging folder is cleared on accept', !fs.existsSync(path.join(SITE, 'Uploads', 'donations', donId)));
    r = await req('GET', '/uploads/donations/' + donId + '/' + donPng + '.png', { cookie: ownerCk });
    ok('and the staged copy is gone', r.status === 404, 'got ' + r.status);
    r = await req('POST', '/api/admin/donation/accept', { token, body: { id: donId, item: donTex.id, lang: 'en', dir: '' } });
    ok('a decided donation cannot be accepted again', r.status === 400, 'got ' + r.status);
    r = await req('GET', '/api/donate/mine', { cookie: ownerCk });
    const mine = (r.json.donations || []).find(x => x.id === donId);
    ok('the donor is shown where it landed', mine && mine.status === 'accepted' && mine.result.path === 'STEM/Mathematics/Donated Thermodynamics.tex', JSON.stringify(mine));
    r = await req('GET', '/api/tree?lang=en&mat_lang=en');
    ok('the accepted note appears in the public tree', /Donated Thermodynamics/.test(r.body));

    // Decline deletes the work rather than keeping it indefinitely.
    r = await req('POST', '/api/donate/draft', { cookie: ownerCk });
    const donId2 = r.json.donation.id;
    r = await req('POST', '/api/donate/submit', { cookie: ownerCk, body: { id: donId2, title: 'Second', text: 'plain', textExt: '.md' } });
    ok('a second donation is submitted', r.json && r.json.ok === true, r.body.slice(0, 160));
    r = await req('POST', '/api/admin/donation/decline', { cookie: ownerCk, body: { id: donId2, reason: 'no' } });
    ok('a member cannot decline', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/admin/donation/decline', { token, body: { id: donId2, reason: 'Already covered.' } });
    ok('the admin declines it', r.json && r.json.ok === true);
    ok('a declined submission is deleted from disk', !fs.existsSync(path.join(SITE, 'Uploads', 'donations', donId2)));
    r = await req('GET', '/api/donate/mine', { cookie: ownerCk });
    const dec = (r.json.donations || []).find(x => x.id === donId2);
    ok('the donor is told why', dec && dec.status === 'declined' && dec.reason === 'Already covered.', JSON.stringify(dec));

    // Withdrawal is the donor's own escape hatch, and only theirs.
    r = await req('POST', '/api/donate/draft', { cookie: ownerCk });
    const donId3 = r.json.donation.id;
    await req('POST', '/api/donate/submit', { cookie: ownerCk, body: { id: donId3, title: 'Third', text: 'x', textExt: '.txt' } });
    r = await req('POST', '/api/donate/withdraw', { cookie: strangerCk, body: { id: donId3 } });
    ok('another member cannot withdraw it', r.status === 404, 'got ' + r.status);
    r = await req('POST', '/api/donate/withdraw', { cookie: ownerCk, body: { id: donId3 } });
    ok('the donor withdraws it', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/donations', { token });
    ok('the queue drains back to empty', r.json && r.json.pending === 0, 'pending=' + (r.json && r.json.pending));

    // deleting a day removes its files
    r = await req('POST', '/api/admin/day/delete', { token, body: { id: 'secretday01' } });
    ok('day deleted', r.json && r.json.ok === true);
    r = await req('POST', '/api/admin/day/delete', { token, body: { id: DAY_ID } });
    ok('day with attachments deleted', r.json && r.json.ok === true);
    r = await req('GET', ('/uploads/days/' + DAY_ID + '/' + att.id + att.ext));
    ok('its attachment is gone (404)', r.status === 404);
    r = await req('GET', '/api/days');
    ok('feed is empty again', r.json && r.json.total === 0);

    // ══ Reaching people who are not looking at the site ══════════════════════

    // ── VAPID ────────────────────────────────────────────────────────────────
    // If the served application server key and the private key on disk ever
    // disagreed, every push would be rejected and nothing else would tell us.
    r = await req('GET', '/api/push/key');
    ok('the VAPID public key is served', r.status === 200 && r.json && r.json.ok === true && typeof r.json.key === 'string', JSON.stringify(r.json));
    const appKey = (r.json && r.json.key) || '';
    ok('it is base64url, no padding', /^[A-Za-z0-9_-]+$/.test(appKey), appKey.slice(0, 20));
    const appKeyBuf = Buffer.from(appKey, 'base64url');
    ok('it is an uncompressed P-256 point (65 bytes, 0x04)', appKeyBuf.length === 65 && appKeyBuf[0] === 4, appKeyBuf.length + ' bytes, first=' + appKeyBuf[0]);
    ok('vapid.json was written', fs.existsSync(path.join(SITE, 'vapid.json')));
    {
      const v = JSON.parse(fs.readFileSync(path.join(SITE, 'vapid.json'), 'utf8'));
      ok('it holds a P-256 private JWK', v.privateJwk && v.privateJwk.crv === 'P-256' && !!v.privateJwk.d, JSON.stringify(v.privateJwk && v.privateJwk.crv));
      const x = Buffer.from(v.privateJwk.x, 'base64url'), y = Buffer.from(v.privateJwk.y, 'base64url');
      ok('the served key is that private key\'s public half',
        Buffer.compare(appKeyBuf, Buffer.concat([Buffer.from([4]), x, y])) === 0);
      // The whole point of storing it: a restart must not invalidate every device.
      ok('the key is stable across reads', JSON.parse(fs.readFileSync(path.join(SITE, 'vapid.json'), 'utf8')).publicKey === v.publicKey);
      // And it must be a signing key a push service would actually accept.
      const priv = crypto.createPrivateKey({ key: v.privateJwk, format: 'jwk' });
      const sig = crypto.sign('sha256', Buffer.from('probe'), { key: priv, dsaEncoding: 'ieee-p1363' });
      ok('it produces a 64-byte ES256 signature (JWS form, not DER)', sig.length === 64, String(sig.length));
      const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.privateJwk.x, y: v.privateJwk.y }, format: 'jwk' });
      ok('and the signature verifies against the published key',
        crypto.verify('sha256', Buffer.from('probe'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig));
    }

    // ── Subscriptions ────────────────────────────────────────────────────────
    const SUB_A = 'https://push.example/sub/aaaa';
    const SUB_B = 'https://push.example/sub/bbbb';
    r = await req('POST', '/api/push/subscribe', { body: { endpoint: SUB_A, keys: { p256dh: 'x', auth: 'y' } } });
    ok('subscribing needs a session (401)', r.status === 401, 'got ' + r.status);
    r = await req('POST', '/api/push/subscribe', { cookie: ownerCk, body: { endpoint: 'http://push.example/insecure', keys: {} } });
    ok('a plaintext endpoint is refused', r.status === 400, 'got ' + r.status);
    r = await req('POST', '/api/push/subscribe', { cookie: ownerCk, body: { endpoint: 'not-a-url', keys: {} } });
    ok('a malformed endpoint is refused', r.status === 400, 'got ' + r.status);
    r = await req('POST', '/api/push/subscribe', { cookie: ownerCk, body: { endpoint: SUB_A, keys: { p256dh: 'x', auth: 'y' }, ua: 'test' } });
    ok('a member can subscribe a device', r.json && r.json.ok === true && r.json.devices === 1, JSON.stringify(r.json));
    r = await req('POST', '/api/push/subscribe', { cookie: ownerCk, body: { endpoint: SUB_A, keys: {} } });
    ok('re-subscribing the same endpoint does not duplicate it', r.json && r.json.devices === 1, JSON.stringify(r.json));
    r = await req('POST', '/api/push/subscribe', { cookie: ownerCk, body: { endpoint: SUB_B, keys: {} } });
    ok('a second device is added', r.json && r.json.devices === 2, JSON.stringify(r.json));
    {
      const subs = JSON.parse(fs.readFileSync(path.join(SITE, 'push-subs.json'), 'utf8'));
      ok('the store is keyed by the lowercased account', Array.isArray(subs.owner1) && subs.owner1.length === 2, JSON.stringify(Object.keys(subs)));
    }
    // A browser profile that signs into a different account must stop waking the first.
    r = await req('POST', '/api/push/subscribe', { cookie: strangerCk, body: { endpoint: SUB_A, keys: {} } });
    ok('an endpoint moving to another account is taken off the first', r.json && r.json.ok === true && r.json.devices === 1, JSON.stringify(r.json));
    {
      const subs = JSON.parse(fs.readFileSync(path.join(SITE, 'push-subs.json'), 'utf8'));
      ok('the original owner keeps only their other device',
        subs.owner1.length === 1 && subs.owner1[0].endpoint === SUB_B, JSON.stringify(subs.owner1));
      ok('and the endpoint now belongs to the new account',
        subs.stranger.length === 1 && subs.stranger[0].endpoint === SUB_A, JSON.stringify(subs.stranger));
    }
    // Unsubscribe only ever touches your own rows.
    r = await req('POST', '/api/push/unsubscribe', { cookie: ownerCk, body: { endpoint: SUB_A } });
    ok('unsubscribing someone else\'s endpoint is a no-op', r.json && r.json.ok === true);
    {
      const subs = JSON.parse(fs.readFileSync(path.join(SITE, 'push-subs.json'), 'utf8'));
      ok('their subscription survived', subs.stranger && subs.stranger.length === 1, JSON.stringify(subs.stranger));
    }
    r = await req('POST', '/api/push/unsubscribe', { cookie: ownerCk, body: { endpoint: SUB_B } });
    ok('unsubscribing your own endpoint works', r.json && r.json.ok === true);
    {
      const subs = JSON.parse(fs.readFileSync(path.join(SITE, 'push-subs.json'), 'utf8'));
      ok('an account with no devices left is dropped from the store', !subs.owner1, JSON.stringify(Object.keys(subs)));
    }

    // ── What the service worker is told ──────────────────────────────────────
    r = await req('GET', '/api/notify/pending');
    ok('pending needs a session (401)', r.status === 401, 'got ' + r.status);
    await req('POST', '/api/chat/send', { cookie: strangerCk, body: { to: 'owner1', body: 'ping for the worker' } });
    r = await req('GET', '/api/notify/pending', { cookie: ownerCk });
    ok('pending reports the unread count', r.json && r.json.ok === true && r.json.unread >= 1, JSON.stringify(r.json));
    ok('and one ready-made notification per conversation',
      r.json && r.json.items.length >= 1 && r.json.items[0].title === 'stranger', JSON.stringify(r.json.items));
    ok('carrying a tag the page can dedupe against', /^ki-chat-/.test((r.json.items[0] || {}).tag || ''), JSON.stringify(r.json.items[0]));
    r = await req('GET', '/api/notify/pending', { cookie: strangerCk });
    ok('the sender is not told about their own message', r.json && r.json.ok === true && r.json.unread === 0, JSON.stringify(r.json));

    // ── The admin webhook ────────────────────────────────────────────────────
    // It fires on the things that need somebody to act, and on nothing else.
    hookHits.length = 0;
    await req('POST', '/api/chat/send', { cookie: strangerCk, body: { to: 'owner1', body: 'ordinary chatter' } });
    await sleep(400);
    ok('ordinary chat does NOT reach the webhook', hookHits.length === 0, JSON.stringify(hookHits.map(h => h.json && h.json.event)));

    // An access request is the everyday case: somebody is blocked until a human
    // looks. It also carries a label, which is what the detail setting governs.
    hookHits.length = 0;
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Webhook Probe {W}.tex',
      content: '\\documentclass{article}\\begin{document}w\\end{document}',
      meta: { canSee: 'all', canRead: 'whitelist', readRequests: true, owners: 'owner1' } } });
    ok('a request-tier note for the webhook check exists', r.json && r.json.ok === true);
    r = await req('POST', '/api/access/request', { cookie: strangerCk, body: { lang: 'en', path: 'STEM/Mathematics/Webhook Probe {W}.tex' } });
    ok('the access request is posted', r.json && r.json.status === 'requested', JSON.stringify(r.json));
    ok('and reaches the webhook', await waitForHook(1), JSON.stringify(hookHits));
    {
      const h = hookHits[0];
      ok('it posts to the configured path', h.path === '/hook', h.path);
      ok('the generic format carries event, actor and time',
        h.json && /access/.test(h.json.event || '') && h.json.actor === 'stranger' && !!h.json.at, JSON.stringify(h.json));
      ok('and the site link from SITE_ORIGIN', h.json && h.json.url === 'https://notes.example/', JSON.stringify(h.json && h.json.url));
      ok('but not the note label, at the default detail level',
        !/Webhook Probe/.test(h.raw || ''), h.raw);
    }

    // Repeats inside a minute collapse — one person retrying is not ten pings.
    hookHits.length = 0;
    r = await req('POST', '/api/admin/note', { token, body: { lang: 'en', dir: 'STEM/Mathematics',
      filename: 'Webhook Probe 2 {W}.tex',
      content: '\\documentclass{article}\\begin{document}w\\end{document}',
      meta: { canSee: 'all', canRead: 'whitelist', readRequests: true, owners: 'owner1' } } });
    r = await req('POST', '/api/access/request', { cookie: strangerCk, body: { lang: 'en', path: 'STEM/Mathematics/Webhook Probe 2 {W}.tex' } });
    ok('a second request of the same kind is accepted by the site', r.json && r.json.status === 'requested', JSON.stringify(r.json));
    await sleep(500);
    ok('but is not sent to the webhook twice inside a minute', hookHits.length === 0, JSON.stringify(hookHits.map(h => h.json && h.json.event)));

    // A password reset is the case that most needs a human, so it must fire — and
    // it is a different event kind, so the collapse above must not swallow it.
    hookHits.length = 0;
    await req('POST', '/api/password-reset/request', { body: { username: 'owner1' } });
    ok('a password reset request reaches the webhook', await waitForHook(1), JSON.stringify(hookHits));
    ok('described as a reset', hookHits[0] && /password reset/i.test(hookHits[0].json.event || ''), JSON.stringify(hookHits[0] && hookHits[0].json));

    for (const f of ['Webhook Probe {W}.tex', 'Webhook Probe 2 {W}.tex'])
      await req('POST', '/api/admin/note/delete', { token, body: { lang: 'en', dir: 'STEM/Mathematics', filename: f } });

    // ── The new state files are treated like every other secret ──────────────
    for (const p of ['/vapid.json', '/VAPID.JSON', '/push-subs.json', '/Push-Subs.json']) {
      r = await req('GET', p);
      ok('static server hides ' + p, r.status === 404, 'got ' + r.status);
    }
    {
      const zr = await reqBuf('GET', '/api/admin/export', { token });
      const names = [];
      let q = zr.buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      while (q > 0 && zr.buf.readUInt32LE(q) === 0x02014b50) {
        const nlen = zr.buf.readUInt16LE(q + 28), elen = zr.buf.readUInt16LE(q + 30), clen = zr.buf.readUInt16LE(q + 32);
        names.push(zr.buf.slice(q + 46, q + 46 + nlen).toString('utf8'));
        q += 46 + nlen + elen + clen;
      }
      ok('a backup carries the VAPID key, so notifications survive a restore',
        names.includes('state/vapid.json'), JSON.stringify(names.filter(n => /vapid|push/.test(n))));
      ok('and the subscription store', names.includes('state/push-subs.json'), JSON.stringify(names));
    }

    // ── The service worker itself ────────────────────────────────────────────
    r = await req('GET', '/sw.js');
    ok('sw.js is served from the root scope', r.status === 200, 'got ' + r.status);
    ok('as JavaScript', /javascript/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    ok('and it listens for push', /addEventListener\('push'/.test(r.body));
    ok('it caches nothing — an access-checked archive must not be served stale',
      !/caches\.(open|match)/.test(r.body));

    // logout invalidates
    r = await req('POST', '/api/admin/logout', { token });
    ok('logout succeeds', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/browse?lang=en', { token });
    ok('token invalid after logout', r.status === 401);

  } catch (e) {
    console.error('\n  fatal:', e.message);
  } finally {
    srv.kill('SIGTERM');
    try { hookSrv.close(); } catch {}
    await sleep(150);
    fs.rmSync(T, { recursive: true, force: true });
    console.log('\n  ' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
    if (fail) { console.log('  failed: \n   - ' + failures.join('\n   - ')); process.exit(1); }
    process.exit(0);
  }
})();