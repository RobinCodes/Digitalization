# Hosting & operations

What the site needs from a host, what to do before and after a deploy, and how the
five pre-hosting features work: **backups**, **password reset**, **search inside
notes**, **quick logging from the timetable**, and the **public-facing pages**
(metadata, `robots.txt`, 404, no-JavaScript).

---

## 1 · What the server needs

Node 18 or newer and nothing else — there are no dependencies and no `package.json`
to install. Everything is one process:

```
node server.js
```

It speaks **plain HTTP**. Put a reverse proxy in front for TLS, and then set
`TRUSTED_PROXIES` to the proxy's address:

```
PORT=3000 TRUSTED_PROXIES=127.0.0.1 node server.js
```

That one variable matters more than it looks. Without it the server sees only the
proxy's IP, so:

- every visitor shares one rate-limit budget — one person fumbling a password can
  lock out everybody;
- `X-Forwarded-Proto` is ignored, so `Strict-Transport-Security` is never sent and
  the session cookie never gets its `Secure` flag.

`pdflatex` is optional but wanted: without it, notes with no cached PDF cannot be
opened. The server prints whether it found one at start-up.

Run it under something that restarts it — systemd, pm2, a container policy. There
is no state to warm up beyond the PDF cache, which rebuilds itself in the
background.

### Sessions and restarts

Sessions live in memory, so **every restart signs everyone out**. That is a
deliberate trade — no session store to secure, and signing in again is cheap — but
it means a deploy is visible to whoever is reading at the time. Nothing is lost.

---

## 2 · Backups — the thing that actually matters

The repository does **not** hold your running state. These are all git-ignored:

| File / directory | What you lose without it |
|---|---|
| `days.json` | every logged day |
| `Uploads/` | every scan and photo attached to a lesson, and every donation awaiting review |
| `donations.json` | every donated note and what was decided about it |
| `timetable.json` | the weekly schedule |
| `chats.json` | every conversation |
| `note-discussions.json` | every per-note thread |
| `users.json`, `admins.json` | every account |
| `grants.json` | who was granted access to which locked note |
| `blocked.json`, `settings.json` | block lists, per-account preferences |
| `changelog.json` | the changelog |

**DevTools → Accounts → Back up** downloads the lot as a `.zip`:

- **Download state & uploads** — the JSON stores plus `Uploads/`. This is the one
  to take regularly.
- **Download everything** — also `Data/`, `DataHU/`, `Articles/`, `ArticlesHU/`,
  which are normally in git already. Useful as a single self-contained snapshot.

The archive contains a `README-restore.txt` saying where each file goes back.
**Restoring**: stop the server, copy `state/*.json` next to `server.js`, copy
`Uploads/` into the `Website` folder, start it again. The directory names matter —
attachments are looked up as `Uploads/days/<dayId>/<attId><ext>`, and staged
donations as `Uploads/donations/<donationId>/<itemId><ext>`.

> Donations still waiting for an audit are somebody else's unpublished work and exist
> nowhere else — losing the disk before you review them loses them for good. They are
> in the regular **state & uploads** backup. See `donations.md`.

> The zip contains `admins.json` and `users.json`, which hold salted scrypt password
> hashes. Not plaintext, but keep the file where you would keep a password-manager
> export.

**Take one before every deploy, move or upgrade.** The endpoint is
`GET /api/admin/export` (admin only; `?what=all` for the full scope), so a cron job
with `curl` and a saved admin token works just as well as the button.

---

## 3 · Password reset

There is no mail server, so the flow is deliberately human, and every step is
designed so that a stranger poking at it learns nothing and costs nobody anything.

1. **The member asks.** Sign-in panel → *Forgotten your password?* → username.
2. **Every admin gets a card** in their chat: "*name* asked for a password reset."
3. **An admin issues a link** from that card. It is copied to the clipboard.
4. **The admin passes it on** by whatever channel they already use for that person.
5. **The link opens the site** with a *Set a new password* panel. Choosing one signs
   the member in and signs out every other device.

### Why it cannot be used as a weapon

| Concern | What stops it |
|---|---|
| Working out which usernames exist | The reply is byte-identical whether or not the account exists |
| Spamming admins with requests | 3 requests per hour per IP; one pending request per account; one hour's cooldown per account; 20 pending across the whole site |
| Writing something nasty into an admin's inbox | The requester supplies **no free text at all** — only a username that must already exist |
| Guessing a link | 32 random bytes, single use, 30-minute expiry, and issuing a new one retires the old |
| Using a stolen link later | It is consumed on first use and the token never touches disk |
| Keeping the old password working | Completing a reset revokes every other session for that account |

Admin passwords are **not** resettable this way — use `node make-admin.js <user>
<password>`, which is the only path to an admin credential.

| Env var | Default | What |
|---|---|---|
| `PW_RESET_TTL_MS` | `1800000` (30 min) | how long an issued link lives |
| `PW_RESET_COOLDOWN_MS` | `3600000` (1 h) | minimum gap between requests for one account |

---

## 4 · Search inside the notes

The grid's search matches a note's *metadata* — filename, display name, tags,
authors, path, description. `GET /api/search?q=…&lang=…` matches what is *in* the
notes, and the results appear underneath the grid as **Found inside notes**, with
the phrase marked in a line of context and a `n×` badge for the number of hits.

- Only notes the caller may open are returned — the check is the same `canViewNote`
  the rest of the site uses, so a match never hints at a note you cannot read.
- `data.txt` is never searched: it is folder metadata, not content.
- `.tex`, `.md`, `.txt` and `.bib` are searched; files over 512 KB are skipped.
- Note text is memoised on `(mtime, size)`, so repeat searches re-read nothing and
  an edit is picked up immediately.

| Env var | Default | What |
|---|---|---|
| `SEARCH_MAX_FILES` | `4000` | files examined per query |
| `SEARCH_MAX_HITS` | `200` | results returned before the answer is marked truncated |

---

## 5 · Logging a lesson from the timetable

The full day editor (DevTools → Days) is for writing a day up properly. This is for
the other case: you are looking at this week's grid, the page you just filled is in
your hand, and you want it filed against that lesson now.

Signed in as an admin, **site → Days → Timetable** puts a small `+` on every lesson
cell (`✎` where something is already logged). It opens a panel with:

- **What happened**, homework, and the lesson kind;
- **Scans & files** — drag and drop, or click; each file gets a caption and a
  SCAN/FILE toggle;
- **Digital notes covering this** — a search over the real note tree, biased toward
  the subject's own notes folder if it has one.

Saving upserts that one lesson into the date's record, creating the day if it does
not exist. The digital note is **optional** — a lesson with only a photo of the page
is a perfectly good record, and that is the normal case.

Emptying a lesson removes it; emptying the last lesson of a day removes the day.

**Endpoints** (admin; both accept the DevTools token *or* an admin site session,
because this is reached from the site rather than from DevTools):

- `GET /api/admin/day/draftid?date=` — the day's id, or a fresh one to upload against
- `POST /api/admin/day/lesson` — upsert one lesson into a day

A draft id that is never saved leaves an upload folder behind; the existing 24-hour
sweep collects it.

---

## 6 · The public-facing pages

- **Metadata.** `index.html` carries a description, a keyword list
  (*Knowledge Index*, *Digitalization*, *SzigNotes* and the subject terms in both
  languages), Open Graph and Twitter card tags, and a theme colour, so a link
  pasted into a chat app renders as a proper card.
- **`/robots.txt`.** Crawlers may index the archive but not `/api/`, `/devtools`,
  `/uploads/`, `/data/` or `/music/`. Set `SITE_ORIGIN` to have a `Sitemap:` line
  emitted too.
- **404.** Unknown addresses get a styled page in the site's own typeface rather
  than bare text, with the address that missed and a way back. Unknown `/api/`
  paths still answer JSON, so clients are unaffected. `404.html` must be deployed
  next to `server.js` — without it the server falls back to plain text.
- **No JavaScript.** A `<noscript>` page explains why the archive needs scripting
  (notes are typeset in the browser), states that nothing is tracked, and gives
  per-browser instructions — plus a link to the article pages, which are plain HTML
  and read fine without it.

---

## 7 · Every environment variable

| Variable | Default | What |
|---|---|---|
| `PORT` | `3000` | listen port |
| `TRUSTED_PROXIES` | *(none)* | comma-separated proxy IPs whose `X-Forwarded-*` headers are believed |
| `SITE_ORIGIN` | *(none)* | absolute origin, used for the `Sitemap:` line in `robots.txt` |
| `CORS_ORIGIN` | *(none)* | one origin to expose the API to; unset means same-origin only |
| `HSTS_MAX_AGE` | `15552000` | HSTS lifetime in seconds, sent only over HTTPS; `0` disables |
| `COMPILE_CONCURRENCY` | `2` | simultaneous `pdflatex` runs |
| `COMPILE_QUEUE_MAX` | `24` | requests allowed to wait for a compile slot before 503 |
| `PRECOMPILE_TIMEOUT_MS` | `180000` | watchdog on one background `pdflatex` run |
| `DAY_UPLOAD_MAX` | `26214400` | maximum size of one day attachment |
| `EXPORT_MAX_BYTES` | `2147483648` | ceiling on a backup archive |
| `SEARCH_MAX_FILES` | `4000` | files examined per content search |
| `SEARCH_MAX_HITS` | `200` | results per content search |
| `PW_RESET_TTL_MS` | `1800000` | password-reset link lifetime |
| `PW_RESET_COOLDOWN_MS` | `3600000` | gap between reset requests for one account |
| `TEXMFHOME`, `openin_any`, `openout_any` | | passed to `pdflatex`; the defaults keep it from reading outside its temp directory |

---

## 8 · Going live — the short list

1. `node make-admin.js <you> <a long password>`.
2. Reverse proxy with TLS in front; set `TRUSTED_PROXIES`.
3. Run under a process manager.
4. Confirm `pdflatex` was found in the start-up banner.
5. Open `/robots.txt`, a missing URL, and the site itself, and check they look right.
6. **Take a backup**, and put a reminder in the calendar to take another.
7. `node Tests/run.js` — 370 assertions; all should pass against your own copy.
