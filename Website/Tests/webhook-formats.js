#!/usr/bin/env node
'use strict';

// Every webhook payload shape, against a real listener.
//
// Tests/run.js covers the generic JSON format and the collapse behaviour. This
// covers the three service-specific shapes an admin is actually likely to point at,
// because a wrong field name fails silently — the POST succeeds and nothing shows
// up in the channel. It also pins the mass-mention defusing: the fixture note is
// literally titled "@everyone look", so a regression here would ping a whole
// Discord server every time somebody asked for access to it.
//
// Starts the server once per format, since the webhook config is read at load.

const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const SRC = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  \x1b[32mok \x1b[0m ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (d ? '  → ' + d : '')); } };

function mkSite(T) {
  const SITE = path.join(T, 'site');
  fs.mkdirSync(SITE, { recursive: true });
  for (const f of ['server.js', 'devtools.html', 'template.html', '404.html', 'sw.js']) fs.copyFileSync(path.join(SRC, f), path.join(SITE, f));
  const s1 = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(SITE, 'admins.json'), JSON.stringify([{ username: 'admin', salt: s1, hash: crypto.scryptSync('testpass', s1, 32).toString('hex') }]));
  const s2 = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(SITE, 'users.json'), JSON.stringify([{ username: 'asker', salt: s2, hash: crypto.scryptSync('askerpass1', s2, 32).toString('hex') }]));
  // A note whose *label* contains a mass-mention, to prove it cannot ping a server.
  const d = path.join(T, 'Data', 'Sub');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '@everyone look {X}.tex'), '\\documentclass{article}\\begin{document}x\\end{document}');
  fs.writeFileSync(path.join(d, 'data.txt'),
    '[@everyone look]\ncan-see: all\ncan-read: whitelist\nread-requests: true\nowners: admin\n');
  return SITE;
}
function reqTo(PORT, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const dd = body !== undefined ? JSON.stringify(body) : null;
    const h = {}; if (dd) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(dd); }
    if (cookie) h['Cookie'] = cookie;
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b, headers: res.headers }); });
    });
    rq.on('error', reject); if (dd) rq.write(dd); rq.end();
  });
}

async function run(format, detail, chatId, check) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hookf_'));
  const SITE = mkSite(T);
  const PORT = 3800 + Math.floor(Math.random() * 150), HOOK = PORT + 1;
  const hits = [];
  const hookSrv = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} hits.push({ path: q.url, json: j, raw: b }); r.writeHead(204); r.end(); });
  });
  await new Promise(r => hookSrv.listen(HOOK, '127.0.0.1', r));
  const env = { ...process.env, PORT: String(PORT), SITE_ORIGIN: 'https://notes.example',
                ADMIN_WEBHOOK_URL: 'http://127.0.0.1:' + HOOK + '/hook', ADMIN_WEBHOOK_FORMAT: format };
  if (detail) env.ADMIN_WEBHOOK_DETAIL = detail;
  if (chatId) env.ADMIN_WEBHOOK_CHAT_ID = chatId;
  const srv = spawn('node', [path.join(SITE, 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 80; i++) { try { const r = await reqTo(PORT, 'GET', '/api/me'); if (r.status) break; } catch {} await sleep(100); }
  try {
    const ck = (((await reqTo(PORT, 'POST', '/api/login', { body: { username: 'asker', password: 'askerpass1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    await reqTo(PORT, 'POST', '/api/access/request', { cookie: ck, body: { lang: 'en', path: 'Sub/@everyone look {X}.tex' } });
    for (let i = 0; i < 60 && !hits.length; i++) await sleep(50);
    check(hits);
  } finally {
    srv.kill('SIGTERM'); hookSrv.close(); await sleep(200);
    fs.rmSync(T, { recursive: true, force: true });
  }
}

(async () => {
  console.log('discord:');
  await run('discord', 'full', '', hits => {
    ok('a payload arrived', hits.length === 1, 'hits=' + hits.length);
    const j = hits[0] && hits[0].json;
    ok('uses the content field', j && typeof j.content === 'string', JSON.stringify(j));
    ok('suppresses all mentions', j && j.allowed_mentions && Array.isArray(j.allowed_mentions.parse) && j.allowed_mentions.parse.length === 0, JSON.stringify(j && j.allowed_mentions));
    ok('and the label is included at detail=full', j && /look/.test(j.content), j && j.content);
    ok('but @everyone in it is defused', j && !/(^|[^\u200b])@everyone/.test(j.content), JSON.stringify(j && j.content));
  });
  console.log('slack:');
  await run('slack', '', '', hits => {
    ok('a payload arrived', hits.length === 1, 'hits=' + hits.length);
    const j = hits[0] && hits[0].json;
    ok('uses the text field', j && typeof j.text === 'string' && !('content' in j), JSON.stringify(j));
    ok('names the site and the actor', j && /Knowledge Index/.test(j.text) && /asker/.test(j.text), j && j.text);
    ok('and omits the label at the default detail', j && !/look/.test(j.text), j && j.text);
  });
  console.log('telegram:');
  await run('telegram', '', '-1001234567890', hits => {
    ok('a payload arrived', hits.length === 1, 'hits=' + hits.length);
    const j = hits[0] && hits[0].json;
    ok('carries chat_id from the env', j && j.chat_id === '-1001234567890', JSON.stringify(j && j.chat_id));
    ok('and text', j && typeof j.text === 'string', JSON.stringify(j));
    ok('with previews off', j && j.disable_web_page_preview === true, JSON.stringify(j && j.disable_web_page_preview));
  });
  console.log('no webhook configured:');
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hookf_'));
    const SITE = mkSite(T);
    const PORT = 3960 + Math.floor(Math.random() * 30);
    const srv = spawn('node', [path.join(SITE, 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
    for (let i = 0; i < 80; i++) { try { const r = await reqTo(PORT, 'GET', '/api/me'); if (r.status) break; } catch {} await sleep(100); }
    const ck = (((await reqTo(PORT, 'POST', '/api/login', { body: { username: 'asker', password: 'askerpass1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    const r = await reqTo(PORT, 'POST', '/api/access/request', { cookie: ck, body: { lang: 'en', path: 'Sub/@everyone look {X}.tex' } });
    ok('the site works normally with no webhook set', r.json && r.json.status === 'requested', JSON.stringify(r.json));
    srv.kill('SIGTERM'); await sleep(200); fs.rmSync(T, { recursive: true, force: true });
  }
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
