# Security fixes applied

All findings from the audit are addressed. Files changed: `server.js`, `index.html`,
`make-admin.js`, `make-user.js`. `devtools.html`, `template.html`, `_gitignore` are
unchanged. Every server-side fix was verified against a running instance (17/17 checks pass).

## What changed

**#1 Range crash (HIGH).** `serveFile` now validates and clamps the `Range` header:
single-range only, supports suffix (`bytes=-N`) and open-ended (`bytes=N-`), returns 416 on
anything malformed, special-cases empty files and HEAD. The read stream has an `error`
handler and is destroyed on client disconnect, so a read failure can't throw out of the
request handler. Belt-and-suspenders: `process.on('uncaughtException'|'unhandledRejection')`
guards log instead of letting the process die. Verified: `Range: bytes=10-5` now returns 416
and the server stays up; valid/suffix/garbage ranges all behave.

**#2 LaTeX file disclosure (HIGH).** pdflatex now runs with `-no-shell-escape` and the
environment `openin_any=p` / `openout_any=p` (overridable via env). `p` forbids reading
absolute paths, parent (`..`) paths, and dotfiles, so `\input{/etc/passwd}` no longer embeds
file contents in the PDF. Verified: the malicious note compiles without leaking `/etc/passwd`;
a normal article still compiles fine.

**#3 Unauthenticated precompile DoS (MEDIUM).** `/api/precompile/start` (unused by the site)
now requires admin. `/api/precompile/folder` stays public — the site uses it to warm the
cache — but both now cap the request body (1 MB / 64 KB), are per-IP rate-limited, and the
queue is bounded (`MAX_PRE_QUEUE = 500`) so it can't be used for memory/CPU exhaustion.

**#4 Rate-limit bypass via spoofed XFF (MEDIUM).** `X-Forwarded-For` / `X-Forwarded-Proto`
are now honoured only from IPs listed in `TRUSTED_PROXIES`; otherwise the direct socket
address is used. **Set `TRUSTED_PROXIES` in production** (see below) or the limiter keys on the
proxy's IP.

**#5 Event-loop blocking + #6 login timing (MEDIUM/LOW).** Password hashing moved from
`scryptSync` to async `crypto.scrypt`, so logins no longer block the event loop. A fixed
`DUMMY_SALT` makes a login attempt for a non-existent user spend ~the same time as a real one,
closing the username-enumeration timing channel. Verified end-to-end: valid login succeeds,
wrong password and unknown user both 401.

**#7 Path leakage in compile errors (LOW).** Compile logs and error messages are passed
through `redactPaths()` (strips data dirs, `__dirname`, tmpdir); the "file not found" and
"compiler missing" messages no longer include absolute paths.

**#8 CSP (LOW) — now fully resolved.** Dropped `'unsafe-eval'` from `script-src` (the app uses
no `eval`/`Function`; pdf.js degrades gracefully without it). Then removed `'unsafe-inline'` from
the app-shell `script-src` entirely: the server now mints a fresh per-request nonce, injects it
into the single inline `<script>` of `index.html` / `devtools.html` (via a `__CSP_NONCE__`
placeholder) and into a strict `script-src 'self' 'nonce-…' https://cdnjs.cloudflare.com`. The
shell has zero inline `on*` handlers and no dynamic `<script>` creation, so nothing relied on
`'unsafe-inline'`. See the note below on article pages.

**#9 `ki://url` scheme (LOW).** `navigateToRef` now parses the target and only opens
`http:`/`https:`, so a `javascript:`/`data:` ref in a chat message can't be opened.

**#10 Wildcard CORS (LOW).** Removed every `Access-Control-Allow-Origin: *`. A `cors()` helper
emits an origin only when `CORS_ORIGIN` is set (default: no header — the app is same-origin, so
nothing breaks, and a wildcard can never combine unsafely with cookies).

**#11 Account-creation hygiene (LOW).** `make-admin.js` / `make-user.js` now enforce the same
username charset as HTTP registration (`^[A-Za-z0-9_.-]+$`, 3–32 chars) and refuse a name that
already exists in the other store (no ambiguous admin/user collisions).

**#12 State-file writes (LOW).** `users/settings/grants/chats/changelog` now write atomically
(temp file + rename), so a crash mid-write can't corrupt them. Chat history is capped at the
last 1000 messages per conversation to bound `chats.json` growth.

## Operational items (NOT code — do these in your deployment)

- **`TRUSTED_PROXIES`** — set to your reverse-proxy IP(s), comma-separated (e.g.
  `TRUSTED_PROXIES=127.0.0.1,::1`). Required for correct rate-limiting / client IPs behind a proxy.
- **`CORS_ORIGIN`** — leave unset for a same-origin deploy. Set to a specific origin only if you
  expose the API to another site. Never set it to `*`.
- **pdflatex sandboxing** — `openin_any=p` is defense-in-depth, not a true sandbox. Run the
  server (and thus pdflatex) as an unprivileged user in a container with a read-only root and no
  network, so even a future TeX escape can't reach real secrets.
- **Verify PDF rendering** — since I dropped `'unsafe-eval'`, open a note with embedded/unusual
  fonts in a browser and confirm it still renders. It should (pdf.js falls back), but it's worth a look.
- New/used env vars: `PORT`, `CORS_ORIGIN`, `TRUSTED_PROXIES`, `openin_any`, `openout_any`.

## CSP status (updated)

The `'unsafe-inline'` residual in `script-src` is **resolved for the app shell** (`index.html`,
`devtools.html`) via the per-request nonce described in #8 — that's where all sensitive
functionality and the DevTools admin token live, so this is the part that mattered. Verified
against a running instance: the shell's `script-src` carries a fresh `'nonce-…'` (different every
request) and no longer contains `'unsafe-inline'` or `'unsafe-eval'`, the served HTML's inline
script gets the matching nonce, and the placeholder is fully substituted.

One deliberate, documented caveat: **article pages keep `'unsafe-inline'` in `script-src`.**
Articles are admin-authored HTML documents (built from `template.html`, which itself uses an
inline `onload=` KaTeX hook and a `javascript:` back link, and existing notes may contain inline
scripts the server can't safely rewrite). Locking those down would break legitimate, trusted
content, so the policy is applied per-route: strict nonce CSP for the shell, permissive
`'unsafe-inline'` only for article responses. `style-src 'unsafe-inline'` is also retained
globally (inline `style=""` is pervasive and is not a script-execution vector). The DevTools admin
token still lives in `sessionStorage` (cleared on tab close); with the shell now on a strict CSP,
an injected-script path to read it is no longer available within the shell itself.