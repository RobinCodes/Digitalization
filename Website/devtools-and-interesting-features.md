# Knowledge Index — DevTools, Accounts & Member-Only Notes

This document covers everything added in this round of work, on top of your existing
single-file site (`index.html`) + dependency-free Node server (`server.js`).

Everything below is implemented, syntax-checked, and exercised by an automated
end-to-end test suite (95 assertions, all passing) plus a live smoke test against the
real server.

---

## 1. What shipped

| Area | What it is |
|------|------------|
| **DevTools** (`/devtools`) | Standalone, password-protected authoring page. Manage notes, changelog, and now **viewer accounts**. |
| **Member-only notes** | Any note can be marked *members only*. It then disappears for anonymous visitors and is enforced server-side, not just hidden in the UI. |
| **Account system** | Site visitors can sign in. Signed-in members see member-only notes; everyone else does not. |
| **Theme** | OS theme detection kept, with a light fallback, plus a third **Teal** theme. (Confirmed direction.) |
| **Story** | Rewritten as a new bilingual essay — *the world is beautiful; knowledge is becoming a currency; the dystopia at the door; an archive as a refusal.* |
| **Changelog** | The public "Add entry" button was removed (confirmed). Changelog editing now lives only in DevTools. |

---

## 2. DevTools (`/devtools`)

Open `http://localhost:<port>/devtools` and sign in with an **admin** account.

A default admin is seeded: **`admin` / `changeme`** — change it immediately:

```bash
node make-admin.js <username> <password>
```

Three tabs:

- **Notes** — browse the archive exactly as it appears live; create, edit and delete
  text notes (`.tex .md .txt .bib .sty .cls`); set tags, authors, date, description,
  *important*, the new *members only* toggle, and the cross-language counterpart.
- **Changelog** — write the short TL;DR entries that appear on the public Log page.
- **Accounts** — create and remove viewer accounts (see below).

---

## 3. Member-only notes

### Marking a note
In **DevTools → Notes**, open a note and turn on **"Members only — hide from visitors
who aren't signed in."** Save. The note row shows a `members` chip, and the note's
`data.txt` records:

```
[Applied Algebra]
visibility: members
...
```

`visibility: public` is the default and is simply omitted from `data.txt`.

### How it's enforced (server-side)
Hiding is not cosmetic. For anyone **not** signed in, the server:

- **`/api/tree`** — omits member-only notes entirely and prunes folders left empty.
- **`/api/file`** — returns **403** for a member-only note's source.
- **`/data/...`** — returns **403** for the file/download (covers images, PDFs, media).
- **`/api/compile`** — refuses to render the PDF (`403`, "signed-in members only").

In dual-language mode, marking **either** language version members-only protects the
note in **both** languages (the tree merges the flag, and the file/download/compile
checks also look at the same-folder counterpart). Tip: to keep `data.txt` tidy, set the
flag on both language versions when you have a counterpart.

---

## 4. Accounts

There are two kinds of accounts, kept in separate files and never mixed:

- **Admins** — `admins.json`. Reach DevTools. Created with `node make-admin.js`.
- **Viewers** — `users.json`. Sign in on the public site to read member-only notes.
  **Cannot** reach DevTools.

A viewer token can never be used to access an admin endpoint (the server checks the
session *role*, not just its validity — this is covered by a regression test).

### Creating viewer accounts
Either from **DevTools → Accounts**, or from the command line:

```bash
node make-user.js <username> <password>
```

Passwords are stored only as a random salt + scrypt hash, never in plain text.
Re-adding an existing username updates its password.

> `users.json` is intentionally **not** shipped — there are no default viewer
> credentials. The site handles its absence gracefully (no one can sign in as a viewer
> until you create an account).

### Signing in (site)
A **Sign in** control sits in the header (and in the mobile menu). It opens a small
modal; on success the visitor's name replaces the label and a green dot appears. The
session is a `HttpOnly`, `SameSite=Lax` cookie (`ki_auth`, 8-hour lifetime), so it is
sent automatically with page fetches, image/PDF/media requests, and downloads — which
is why member-only media works without any extra wiring. Sign-out clears it.

New site endpoints: `POST /api/login`, `GET /api/me`, `POST /api/logout`, and the
admin-gated `GET/POST /api/admin/users` + `POST /api/admin/users/delete`.

---

## 5. Theme

OS theme detection with a **light** fallback is unchanged. The header toggle now cycles
**dark → light → teal**, and Settings has a matching third "Teal" / "Türkiz" button. The
chosen theme is remembered per device.

---

## 6. Story

The Story page is a new bilingual (EN/HU) essay in four movements:

1. *On the beauty of the world* — the plain astonishment that the world is both
   beautiful and legible.
2. *Knowledge becomes a currency* — how copying-cost fell toward zero and how AI turns
   compressed understanding into the medium of exchange.
3. *The dystopia at the door* — the failure modes: enclosure, opacity, dependence,
   surveillance, the atrophy of independent judgement.
4. *An archive is a refusal* — the response: open, checkable, human-held knowledge; use
   the machines but keep the capacity to reason without them.

It reuses the existing `story-section` / `story-pull` styling, so it themes correctly in
dark, light and teal.

---

## 7. Running it

```bash
# from the site directory (Data/ and DataHU/ live one level up, as before)
node server.js                 # serves the site + /devtools

# tests (spins up a throwaway server in a temp dir, then exits)
node tests/run.js              # 95 assertions
```

The startup banner now also prints a **Users** line alongside **Admins** so you can see
at a glance whether any viewer accounts exist.

---

## 8. Notes & recommendations

- **Change the default admin password** (`admin` / `changeme`) right away with
  `node make-admin.js`.
- **Production / HTTPS:** the session cookie is `HttpOnly` + `SameSite=Lax` but not
  `Secure`, so it also works over plain HTTP for local use. If you deploy over HTTPS,
  consider adding `Secure` to the cookie (one line in `server.js`, in the `/api/login`
  and `/api/logout` `Set-Cookie` strings).
- **One thing worth a quick eyeball in a real browser:** the earlier full-document PDF
  zoom fix (CSS `min-width`/`max-content` on the canvas wrap) was verified structurally
  but not visually — open a long PDF, switch to full-document mode, and confirm the zoom
  feels right.
- Per-device settings (theme, language, layout) are still stored in `localStorage`; they
  are **not** tied to an account. If you ever want settings to follow a viewer across
  devices, that would be a separate, larger change — happy to scope it.


---

## 9. Round 2 — equal EN/HU, in-viewer language switch, whitelists, accounts & hardening

This round implements eight requested changes. All are syntax-checked and covered by the
test suite (now **95 assertions**).

### 1 · PDF re-renders on theme change
Switching theme while a PDF is open now re-renders the document immediately, so the page
itself (not just the chrome) adopts the light/dark treatment. In full-document mode every
page re-renders; in single-page mode the current page does.

### 2 · The standard theme button is light/dark only
The header toggle (and its mobile + in-viewer twins) now flips **light ⇄ dark** only.
**Teal** is selectable solely from **Settings → Theme** (still a three-way segmented control).

### 3 · Switch material language *inside* the PDF viewer
The viewer's **EN / HU** buttons now switch the **document's** language — they recompile the
counterpart `.tex` — independently of the interface language. The button for a language is
shown active for the open document and disabled (with a tooltip) when this note has no
counterpart in that language.

### 4 · English and Hungarian are equal
- **Pure EN shows only `Data`; pure HU shows only `DataHU`.** Each is built as its own
  self-contained tree (`buildSoloTree`), so HU-only folders no longer leak into English mode
  (and vice-versa). **Both** mode still shows the merged, bilingual view.
- **Clicking a Hungarian note opens it directly.** Each note now carries an explicit
  `lang`, and the open logic uses it instead of assuming English is primary.
- The redundant right-click **"Open HU version"** no longer appears while you are already
  viewing the Hungarian version; the alternate-language option shows only when a real
  counterpart exists in the *other* language. Counterparts link both ways now (an EN note's
  `alt-hu`, or the reverse), so the link works even when display names differ.

### 5 · DevTools light mode + real three-way switch
DevTools gained a full **light theme**, and the single "Theme" button is now a proper
**Dark / Light / Teal** segmented switch that both looks and behaves like a three-way control.

### 6 · Theme-adaptive date picker in DevTools
The native `<input type="date">` on both the changelog and the note editor is replaced by a
custom, **theme-aware** calendar popover (Monday-first, month nav, *Today* / *Clear*). It
writes the same `YYYY-MM-DD` value, so nothing downstream changed.

### 7 · Whitelists, public accounts, password change, reveal-eye
- **Whitelist.** A members-only note can name specific usernames (DevTools → editor →
  *Whitelist*, stored as `allow:` in `data.txt`). Only those users (plus admins) can see or
  open it; everyone else — including other signed-in members — cannot. Enforced server-side
  on the tree, file, data and compile routes.
- **Public registration.** Anyone can create a viewer account from the sign-in dialog
  (**Create an account**). Usernames are 3–32 chars (`A–Z a–z 0–9 . _ -`); passwords ≥ 8.
  Registration auto-signs-in and is rate-limited.
- **Change password.** Signed-in viewers can change their own password from the dialog.
  (Admin passwords are still managed with `make-admin.js`.)
- **Reveal-eye** buttons sit inside every password field (site + DevTools).
- **No iOS auto-focus.** The sign-in dialog no longer auto-focuses on touch devices, so iOS
  won't pop the keyboard or zoom; password fields use a 16px font to prevent zoom-on-focus.

### 8 · Maximal security (safe to publish on GitHub)
- **Sensitive files are never served.** `admins.json`, `users.json`, `server.js`,
  `make-admin.js`, `make-user.js`, `package*.json`, any dotfile path (`.git`, `.pdf-cache`),
  and `tests/` all return **404** over HTTP. `data.txt` is no longer reachable via `/data`.
- **Security headers on every response:** `Content-Security-Policy` (locked to `self` +
  cdnjs + Google Fonts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`.
- **Cookies** are `HttpOnly` + `SameSite=Lax`, and gain `Secure` automatically when served
  over HTTPS (direct TLS or behind a proxy via `X-Forwarded-Proto`).
- **Rate limiting** (in-memory, per-IP): sign-in 20 / 10 min, registration 5 / hour.
- **No secrets in the repo.** `admins.json` / `users.json` are git-ignored (see `.gitignore`)
  and ship only as empty `*.example.json` seeds. Passwords are stored as random-salt +
  scrypt hashes, never plain text.

> **Before first DevTools use,** create your admin account:
> ```bash
> node make-admin.js <username> <password>
> ```
> The public site and account registration work without it; only the `/devtools` authoring
> page needs an admin.

### Where the files go (reminder)
A parent folder holds the **site folder** (these files — `server.js`, `index.html`, …) as a
**sibling** of your content folders:

```
my-archive/
├─ digitalization/        ← the site folder (run `node server.js` from in here)
│   ├─ server.js  index.html  devtools.html  template.html
│   ├─ make-admin.js  make-user.js
│   ├─ admins.json  users.json        (created locally; git-ignored)
│   └─ .pdf-cache/  tests/
├─ Data/                  ← English notes (required)
├─ DataHU/                ← Hungarian notes (optional → enables dual-language)
└─ Music/                 ← optional
```

The bundled `sample-data/` contains a ready-made `Data/` + `DataHU/`; move them up to sit
beside the site folder to try dual-language mode.

### Browser-verification caveats
- The CSP could not be browser-verified in this environment. If a PDF or web-font ever fails
  to load, the CSP origin list (in `server.js`, search `Content-Security-Policy`) is the first
  place to adjust.
- The in-viewer EN/HU switch only offers the other language when a counterpart exists.
- Per-device settings (theme, language, layout) remain in `localStorage`, not tied to an account.


---

## Articles & changelog references (this round)

Two additions: clickable references in the changelog, and a full **Create an article** flow in DevTools.

### Changelog: main reference + inline references

Each changelog entry can now carry a **main reference** and **inline references** inside its details.

- **Main reference** — in the Changelog tab there is a *Main reference* row (Choose… / None).
  Pick a **note**, an **article**, **another log entry**, or a **URL**. On the public **Log**
  page the whole entry becomes clickable and shows a small "→ label" hint; clicking it jumps to
  the target (opens the note viewer, navigates to the article, scrolls to and flashes the other
  log entry, or opens the URL in a new tab).
- **Inline references** — the "↗ Insert reference into details" button opens the same picker and
  drops a link token at the cursor. Tokens look like `[label](ki://kind/target?lang=xx)` and render
  as inline links on the Log (each jumps the same way). `kind` is `note` / `article` / `log` / `url`;
  `target` is URL-encoded; `lang` is appended only for notes/articles.

No data migration is needed — the changelog stays free-form JSON; entries simply gain an optional
`ref` object and may contain reference tokens in `body`. Old entries render unchanged.

### Create an article (DevTools → Articles tab)

A new **Articles** tab lists every article (standalone `.html` files **and** project folders) for the
language you're editing, each with **Edit / View / Delete**. "New article" offers two methods:

- **Paste HTML** — give it a name, paste a complete HTML document, save. Stored verbatim as
  `Articles/<name>.html` (or `ArticlesHU/…`). Editing a standalone file reopens it here, so it
  round-trips exactly.
- **✨ Magic Editor** —
  - *Template builder*: fill Title / Date / Description / Tags and a Body. A toolbar inserts
    template-styled blocks (H2, paragraph, math block, definition, theorem, proof, blockquote, code)
    and references. On save the server fills `template.html` with your content, so the result matches
    the template exactly (KaTeX, light/dark theme, the same boxes).
  - *Project folder*: flip **"As a folder"** to host a whole project. The article is saved as
    `<slug>/index.html` and a file manager appears to add/edit/delete additional files
    (CSS, JS, JSON, SVG, …). Folder articles appear on the public Articles page via their `index.html`,
    and their assets are served from `/articles/<slug>/…`.

### New server endpoints (all admin-only)

- `GET  /api/admin/article/list?lang=` — files + folders (with each folder's file list and parsed metadata)
- `GET  /api/admin/article/read?lang=&path=` — raw contents of one article file
- `POST /api/admin/article/save` — body `{lang, target, mode, html|content, meta, body}`;
  `mode:"template"` fills `template.html`, otherwise the content is written verbatim
- `POST /api/admin/article/delete` — deletes a file or (recursively) a folder
- `GET  /api/articles` now also lists folder articles (any sub-folder containing `index.html`)

### Security

Article authoring is **admin-only** and confined to the `Articles` / `ArticlesHU` directories
(`safePath` traversal guard). Every path segment must match `[A-Za-z0-9 ._-]+` with no leading dot,
the final extension must be on an allowlist (`.html .htm .css .js .mjs .md .txt .json .svg .csv .xml
.webmanifest`), and writes are capped at 4 MB. Article HTML is authored by a trusted admin and served
verbatim under `/articles/` — the usual CMS trust model. `template.html` gained two invisible markers
(`<!-- ARTICLE-BODY-START/END -->`) that delimit the region the template builder replaces.

### Tests

The suite is now **115 assertions** (`node tests/run.js`). New coverage: template-mode save (served
HTML keeps the template chrome and replaces the body), raw-HTML save, folder articles (index + asset
served, admin list shows the folder's files), validation (bad extension / traversal / dotfile / anon
all rejected), file + recursive folder delete, and changelog `ref` + inline-token round-tripping.


---

## Fixes: light-mode header, device-language defaults, per-account settings

**DevTools light mode now restyles the header.** The sticky header had a hard-coded dark
background with only a teal override; a `body.theme-light header` rule was added so the bar
matches the light palette (everything else in the header already used theme variables).

**Default language follows the device (interface *and* material).** This was already the
behaviour and is unchanged: the interface language is `navigator.language` (Hungarian if the
browser locale starts with `hu`, otherwise English), and the material language follows it on
first visit. A saved per-account preference, or a previous per-device choice, always takes
precedence over the device default.

**Settings are saved per-account when signed in, otherwise per-device.** Theme, interface
language, material language, section ordering and the section grouping mode now sync to the
signed-in account; signed-out visitors keep using `localStorage` exactly as before.

- New endpoints (site session required): `GET /api/settings` returns the current user's saved
  settings; `POST /api/settings` stores them. Values are validated against an allowlist
  (`lang`, `matLang`, `theme`, `sectionBy`, `sectionOrder`, `childOrders`) and unknown keys are
  dropped; the body is capped at 128 KB. Settings live in `settings.json`, keyed by username
  (works for viewer and admin accounts alike); the file is git-ignored and never served statically.
- On the site, every change to a synced preference is pushed (debounced) when signed in;
  on sign-in (and page load while authenticated) the account's settings are pulled and applied;
  registering a new account seeds it with the current device settings. The change is captured
  centrally by wrapping `localStorage.setItem`, so all existing preference writes participate
  without per-setting plumbing.

The suite is now **122 assertions**: added coverage for `GET`/`POST /api/settings` requiring a
session (401), an empty-on-first-use account, a save→reload round-trip, unknown-key stripping,
and rejection of invalid values.


---

## Request-to-read notes + per-user messages

### A third visibility tier: "Request to read"

Notes can now be **public**, **members only**, or **request to read**. A request-to-read note is
**visible in the folder** (it shows on the card with an X-shaped chain badge) but its **content is
locked** until the author approves a request. Set it in DevTools via the new three-way *Visibility*
control on the note editor; the whitelist field becomes **Owners** — the usernames who receive the
read-requests and can grant access (blank = any admin).

- In `data.txt` this is `visibility: request`; `allow` carries the owner usernames.
- The note stays in the tree for everyone (`canSeeNode`), and each request-tier node is annotated
  `locked: true/false` for the current viewer. Content endpoints (`/api/file`, `/data`, compile)
  return 403 unless the viewer is an admin, an owner, or has been **granted** access.
- Grants are stored in `grants.json` (git-ignored), keyed by username.

### Asking for access

Tapping a locked card opens a small **"May I read it?"** dialog that names the author(s) the
request will go to and offers an optional message. Sending it places a request in each owner's
message panel. The owner sees **Accept / Decline** with a reason box; accepting writes the grant
(so the requester can open the note) and sends the requester a result message; declining just sends
the result. Duplicate pending requests are de-duplicated.

### Message panels (text only)

Every signed-in user has a **message panel**. There are no push notifications — a small **bell**
appears in the header **only when there are unread messages** (it's also reachable any time from the
account menu → *Open messages*). The panel has an Inbox/Sent toggle, opening a message marks it read,
and supports **reply**, **delete**, and composing a **new message** to any user. Messages are
**text only** (no images, no calls) and may embed **references** to notes via the *+ Note reference*
picker; reference tokens render as clickable links that jump to the note, exactly like the changelog
references.

New endpoints (all require a site session): `GET /api/messages`, `GET /api/messages/unread`,
`POST /api/messages/send`, `POST /api/messages/read`, `POST /api/messages/delete`,
`GET /api/access/info`, `POST /api/access/request`, `POST /api/access/respond`. Messages live in
`messages.json` (git-ignored). Bodies are capped and recipients are validated against real accounts.

The suite is now **150 assertions**, covering the locked-but-visible tier, content gating for
anon/owner/granted/admin, the full request → accept/decline → grant flow (with de-duplication), and
the message send / list / unread / mark-read / delete / validation paths.

> Note: the message-panel and request dialog UI is in English; the rest of the site remains fully
> bilingual. The folder file manager for the Magic Editor and these panels were kept English to stay
> compact — they can be localized later via the existing i18n dictionaries.