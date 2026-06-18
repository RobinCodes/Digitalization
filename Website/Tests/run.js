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
for (const f of ['server.js', 'devtools.html', 'template.html']) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
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
function req(method, p, { token, body, authToken, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['X-Admin-Token'] = token;
    if (authToken) headers['X-Auth-Token'] = authToken;
    if (cookie) headers['Cookie'] = cookie;
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── run ───────────────────────────────────────────────────────────────────────
(async () => {
  const srv = spawn('node', [path.join(SITE, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
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

    // logout invalidates
    r = await req('POST', '/api/admin/logout', { token });
    ok('logout succeeds', r.json && r.json.ok === true);
    r = await req('GET', '/api/admin/browse?lang=en', { token });
    ok('token invalid after logout', r.status === 401);

  } catch (e) {
    console.error('\n  fatal:', e.message);
  } finally {
    srv.kill('SIGTERM');
    await sleep(150);
    fs.rmSync(T, { recursive: true, force: true });
    console.log('\n  ' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
    if (fail) { console.log('  failed: \n   - ' + failures.join('\n   - ')); process.exit(1); }
    process.exit(0);
  }
})();