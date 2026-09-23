#!/usr/bin/env node
'use strict';

// Push, end to end on the wire.
//
// Tests/run.js covers the HTTP surface — subscribing, the store, what the service
// worker is told. This covers the part that only fails in production: the actual
// POST to a push service. It stands up a real HTTPS listener with a self-signed
// cert and starts the server with NODE_EXTRA_CA_CERTS, so nothing here is short-
// circuited by a TLS bypass, and then verifies the VAPID signature against the
// key the server publishes. If those two ever disagreed, every push would be
// rejected and no other test would notice.
//
// Needs openssl to make the cert. Skips cleanly (exit 0) where there isn't one.

const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const SRC = path.resolve(__dirname, '..');
const PORT = 3700 + Math.floor(Math.random() * 200), PUSH_PORT = PORT + 1;

try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); }
catch {
  console.log('  \x1b[33m–\x1b[0m openssl not found — skipping the push wire test.');
  process.exit(0);
}
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pushw_'));
const SITE = path.join(T, 'site');
fs.mkdirSync(SITE, { recursive: true });
for (const f of ['server.js', 'devtools.html', 'template.html', '404.html', 'sw.js']) fs.copyFileSync(path.join(SRC, f), path.join(SITE, f));
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('testpass', salt, 32).toString('hex');
fs.writeFileSync(path.join(SITE, 'admins.json'), JSON.stringify([{ username: 'admin', salt, hash }], null, 2));
const us = crypto.randomBytes(16).toString('hex');
const uh = crypto.scryptSync('memberpass1', us, 32).toString('hex');
const us2 = crypto.randomBytes(16).toString('hex');
const uh2 = crypto.scryptSync('memberpass1', us2, 32).toString('hex');
fs.writeFileSync(path.join(SITE, 'users.json'), JSON.stringify([
  { username: 'alice', salt: us, hash: uh }, { username: 'bob', salt: us2, hash: uh2 }], null, 2));
fs.mkdirSync(path.join(T, 'Data'), { recursive: true });

// Self-signed cert for localhost.
const key = path.join(T, 'k.pem'), cert = path.join(T, 'c.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hits = [];
const pushSrv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (q, r) => {
  let n = 0; q.on('data', c => n += c.length);
  q.on('end', () => { hits.push({ url: q.url, headers: q.headers, bodyBytes: n }); r.writeHead(201); r.end(); });
});

function req(method, p, { body, cookie, token } = {}) {
  return new Promise((resolve, reject) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    if (cookie) h['Cookie'] = cookie;
    if (token) h['X-Admin-Token'] = token;
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b, headers: res.headers }); });
    });
    rq.on('error', reject); if (d) rq.write(d); rq.end();
  });
}
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  \x1b[32mok \x1b[0m ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (d ? '  → ' + d : '')); } };

(async () => {
  await new Promise(r => pushSrv.listen(PUSH_PORT, '127.0.0.1', r));
  const srv = spawn('node', [path.join(SITE, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_EXTRA_CA_CERTS: cert, PUSH_SUBJECT: 'mailto:robin@example.org' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 80; i++) { try { const r = await req('GET', '/api/me'); if (r.status) break; } catch {} await sleep(100); }

  try {
    let r = await req('GET', '/api/push/key');
    const appKey = r.json.key;
    const aliceCk = (((await req('POST', '/api/login', { body: { username: 'alice', password: 'memberpass1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];
    const bobCk   = (((await req('POST', '/api/login', { body: { username: 'bob',   password: 'memberpass1' } })).headers['set-cookie'] || [''])[0] || '').split(';')[0];

    const endpoint = 'https://localhost:' + PUSH_PORT + '/push/alice-device';
    r = await req('POST', '/api/push/subscribe', { cookie: aliceCk, body: { endpoint, keys: { p256dh: 'p', auth: 'a' }, ua: 'probe' } });
    ok('alice subscribed a device', r.json && r.json.ok === true, JSON.stringify(r.json));

    // bob messages alice → the server should POST to the endpoint above.
    hits.length = 0;
    r = await req('POST', '/api/chat/send', { cookie: bobCk, body: { to: 'alice', body: 'are you there' } });
    ok('bob sent a message', r.json && r.json.ok === true, JSON.stringify(r.json));
    for (let i = 0; i < 60 && !hits.length; i++) await sleep(50);
    ok('the push service received a POST', hits.length === 1, 'hits=' + hits.length);

    if (hits.length) {
      const h = hits[0];
      ok('to the subscription path', h.url === '/push/alice-device', h.url);
      ok('with an empty body — no message text leaves the server', h.bodyBytes === 0, String(h.bodyBytes));
      ok('and a TTL', !!h.headers.ttl, JSON.stringify(h.headers.ttl));
      const auth = h.headers.authorization || '';
      ok('carrying a VAPID Authorization header', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(auth), auth.slice(0, 60));
      const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth);
      if (m) {
        const [, h64, p64, s64, k64] = m;
        ok('the k= parameter is the key the server publishes', k64 === appKey);
        const head = JSON.parse(Buffer.from(h64, 'base64url').toString());
        const payload = JSON.parse(Buffer.from(p64, 'base64url').toString());
        ok('the JWT header says ES256', head.alg === 'ES256' && head.typ === 'JWT', JSON.stringify(head));
        ok('aud is the push service origin', payload.aud === 'https://localhost:' + PUSH_PORT, payload.aud);
        ok('sub is the configured contact', payload.sub === 'mailto:robin@example.org', payload.sub);
        const life = payload.exp - Math.floor(Date.now() / 1000);
        ok('exp is in the future and within the 24h RFC 8292 limit', life > 0 && life <= 86400, String(life));
        // The real proof: the signature verifies against the published key.
        const raw = Buffer.from(appKey, 'base64url');
        const pub = crypto.createPublicKey({ format: 'jwk', key: {
          kty: 'EC', crv: 'P-256',
          x: raw.slice(1, 33).toString('base64url'), y: raw.slice(33, 65).toString('base64url') } });
        const good = crypto.verify('sha256', Buffer.from(h64 + '.' + p64),
          { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url'));
        ok('the signature verifies against the published key', good);
      }
    }

    // A dead subscription must be pruned, not retried forever.
    hits.length = 0;
    pushSrv.removeAllListeners('request');
    pushSrv.on('request', (q, r2) => { let n = 0; q.on('data', c => n += c.length); q.on('end', () => { hits.push({ url: q.url }); r2.writeHead(410); r2.end(); }); });
    await req('POST', '/api/chat/send', { cookie: bobCk, body: { to: 'alice', body: 'still there?' } });
    for (let i = 0; i < 60 && !hits.length; i++) await sleep(50);
    ok('a second push was attempted', hits.length >= 1, 'hits=' + hits.length);
    await sleep(400);
    const subs = JSON.parse(fs.readFileSync(path.join(SITE, 'push-subs.json'), 'utf8'));
    ok('a 410 Gone prunes the subscription', !subs.alice || !subs.alice.length, JSON.stringify(subs));

    // The sender is never pushed for their own message.
    const bobEp = 'https://localhost:' + PUSH_PORT + '/push/bob-device';
    await req('POST', '/api/push/subscribe', { cookie: bobCk, body: { endpoint: bobEp, keys: {} } });
    hits.length = 0;
    pushSrv.removeAllListeners('request');
    pushSrv.on('request', (q, r2) => { let n = 0; q.on('data', c => n += c.length); q.on('end', () => { hits.push({ url: q.url }); r2.writeHead(201); r2.end(); }); });
    await req('POST', '/api/chat/send', { cookie: bobCk, body: { to: 'alice', body: 'one more' } });
    await sleep(700);
    ok('bob is not pushed for his own message', hits.every(x => x.url !== '/push/bob-device'), JSON.stringify(hits.map(x => x.url)));
  } catch (e) {
    console.error('fatal:', e.message);
    if (log) console.error(log.slice(-1200));
  } finally {
    srv.kill('SIGTERM'); pushSrv.close(); await sleep(250);
    fs.rmSync(T, { recursive: true, force: true });
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
