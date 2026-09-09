# The timetable & the day log

Two connected features: a recurring **weekly timetable** that admins edit in DevTools, and a
**day log** — for each school day, which of that day's lessons actually happened and what
happened in them, with photos or scans of the paper notes and links to the digital ones.

The whole point is the join: a lesson can point at the `.tex` notes that cover the same
material, and a note can tell you which lessons it was covered in. Neither side is required —
a day can be paper-only, and a note can have no lessons at all.

---

## 1 · The timetable (DevTools → **Timetable**)

One document, edited live and saved whole. Five sections:

1. **Setup** — a display name (EN + HU), which weekdays you have lessons on, whether the week
   alternates (**A / B**) and which Monday starts week A, the school-year window, and a
   *members only* switch that hides the timetable and its calendar from signed-out visitors.
2. **Periods** — the rows of the grid. A label (`1`, `2`, `0.`, whatever) plus optional start
   and end times. Drag the ⠿ handle to reorder; removing a period that still has lessons asks
   first and takes those lessons with it.
3. **Subjects** — name (EN + HU), a short form for the grid, a colour used everywhere the
   subject appears, default teacher and room, and optionally a **notes folder**: link a subject
   to a folder in `Data/` / `DataHU/` and that folder is one click away when you log a lesson.
4. **The week** — the grid itself. Click an empty cell to place a lesson, click a lesson to
   edit or remove it. Each placement can override the room/teacher, carry a short note shown in
   the cell, and (when the A/B cycle is on) be restricted to week A or week B.
5. **Holidays & special dates** — date *ranges* with a kind (holiday, break, no school, exam
   period, event) and a bilingual label. They tint the public calendar and are called out in
   the day editor when you log a date that falls inside one.

**Save timetable** writes it; **Discard changes** reloads the saved copy.

> Slots are validated on save. A slot whose weekday, period or subject does not resolve is
> **dropped**, not quietly remapped — otherwise deleting a period would invent a phantom
> Monday-period-1 lesson that then seeded every day you logged.

---

## 2 · Logging a day (DevTools → **Days** → **Add day**)

Pick a date. The editor loads that date's lessons **from the timetable** (respecting the A/B
week and telling you if the date falls in a holiday), and shows each one with a checkbox.

- **Tick a lesson** to say it happened; it expands into an editor.
- **Kind** — lesson, test, exam, lab, presentation, trip, substitution, self-study, cancelled.
- **What happened** — the main free-text field, plus **topics** (comma separated) and
  **homework**. A *highlight* switch makes the lesson stand out on the public day.
- **Digital notes covering this** — a picker over the real note tree (EN or HU). If the subject
  has a notes folder, its path is shown as a hint. Zero, one or many; a day with no digital
  notes at all is a perfectly normal day.
- **Files & scans of paper notes** — drag and drop, or click to choose. Images, PDF, audio,
  video and plain-text formats are accepted (25 MB each by default). Each file gets a caption
  and a **SCAN / FILE** toggle — images default to *scan*, since that is what a photo of a page
  usually is.
- **+ Add something not on the timetable** creates an ad-hoc entry (a trip, a replacement
  lesson) with its own name, time and colour.

The day itself takes an optional title and "how the day went" summary (both bilingual) and a
**members only** switch. Changing the date re-seeds the editor for that date, asking first if
you have unsaved text.

There is **one record per calendar date** — saving a second entry for a date that already has
one is refused rather than silently creating a duplicate.

---

## 3 · What visitors see (site → **Days**)

Three views over the same data, plus a full-day view:

- **Feed** — day cards newest first, each listing its lessons with the text, topics, homework,
  note links and a thumbnail gallery of the files. Search covers everything written in a day;
  **With files** narrows to days that have attachments; the subject chips filter by subject.
  Paged with **Show more**.
- **Calendar** — a month grid. Logged days show their title and a colour bar per subject, plus
  a `◈n` marker when files are attached. Holidays are tinted, non-teaching days are drawn
  faintly, today is outlined. Clicking a logged day opens it.
- **Timetable** — the weekly grid for a real week, with prev/next/this-week navigation. Where a
  lesson was logged, the cell carries what happened plus small pins (`◈` files, `≡` linked
  notes, and the kind when it isn't a plain lesson) and is clickable. Holidays fill the cells
  they cover.

**A day in full** opens as an overlay: title, summary, every lesson, and — quietly, at the
bottom — the lessons that were on the timetable that day but were never written up, so the day
still reads as a whole. ← / → step to the previous/next logged day, Escape closes.
Every day is deep-linkable as `#day=YYYY-MM-DD`, which works on a cold load too.

Clicking an attachment opens it in the existing media viewer (images, video, audio), the PDF
viewer, or downloads it — under its real filename, not the storage id.

### The other direction

Open a note whose material was covered in class and the viewer gains a **"Covered in N lessons"**
button (both the PDF viewer and the source viewer). It opens a small list of those lessons —
date, period, what happened — and clicking one jumps to that day.

Everything on the page is bilingual and re-renders in place when you flip EN/HU, including
subject names (a subject can have a Hungarian name) and the open day view.

### Days are referenceable

`day` joins `note` / `article` / `log` / `url` as a reference kind, so a day is a first-class
thing you can link to anywhere the app already accepts references — chat messages, note
discussions and changelog entries. The reference picker (the ↗ button in every composer, and
DevTools → Changelog) gains a **Day** tab listing the logged days; picking one inserts
`[label](ki://day/2026-09-07)`, and clicking that link anywhere opens the day.

---

## 4 · Storage & endpoints

Two git-ignored JSON stores next to `server.js`, plus an upload directory:

| Path | What |
|---|---|
| `timetable.json` | the single timetable document |
| `days.json` | `{ version, days: [...] }`, newest first, capped at 5000 days |
| `Uploads/days/<dayId>/<attachmentId><ext>` | day attachments |

Each logged lesson stores a **snapshot** of its subject name, colour, period label and times
alongside the ids. An archived day therefore still reads correctly years later even if the
timetable is rewritten — while the ids keep the live link for anything that wants it.

**Public / read**

- `GET /api/timetable` — the timetable (or `{restricted:true, timetable:null}` when it is
  members-only and you are not signed in)
- `GET /api/days` — the feed. `from`, `to`, `subject`, `q`, `files=1`, `limit`, `offset`
- `GET /api/days/index` — one compact row per logged day (counts + subject colours), for the calendar
- `GET /api/day?date=|id=` — one day plus that date's timetable plan
- `GET /api/note/days?path=&lang=` — the lessons a given note was covered in
- `GET /uploads/days/<dayId>/<attId><ext>` — an attachment (`?download=1` to force a download)

**Admin**

- `POST /api/admin/timetable` — save the whole document
- `GET  /api/admin/days` — the day index for the DevTools list
- `GET  /api/admin/day?date=|id=` — a day plus its plan, including members-only days
- `POST /api/admin/day` — create or update a day
- `POST /api/admin/day/delete` — delete a day *and its files*
- `POST /api/admin/day/upload?day=&name=&kind=` — the request body **is** the file (no
  multipart parser needed; the server has no dependencies)

### Access control

- A day is **public** unless marked *members only*, in which case it disappears from the feed,
  the calendar index, the single-day endpoint **and** its attachments — all server-side. An
  anonymous request for a members-only day gets the same answer as a request for a date that
  was never logged, so the existence of the day is not leaked.
- Note links inside a day are pruned per viewer with the same `canViewNote` check the rest of
  the site uses, so a lesson never advertises a note you are not allowed to see.
- Uploads are admin-only, extension-allowlisted, and size-capped (`DAY_UPLOAD_MAX`, default
  25 MB). `.svg` and `.html` are **not** allowed: they execute script when served from our own
  origin, and these files are rendered inline.
- `timetable.json`, `days.json` and the whole `Uploads/` tree are unreachable over the static
  route (case-insensitively — see the audit note below).

### Housekeeping

Files uploaded for a day that was never saved would otherwise sit on disk forever. A sweep runs
20 s after start-up and every 6 h, deleting attachment folders with no matching day that are
older than 24 h — so an edit in progress is never touched.

---

## 5 · Configuration

| Env var | Default | What |
|---|---|---|
| `DAY_UPLOAD_MAX` | `26214400` (25 MB) | maximum size of a single day attachment |

`.gitignore` now also covers `timetable.json`, `days.json` and `Uploads/`. Scans of your own
paper notes are real content, not secrets — but they are personal, can be large, and a day may
be members-only, so they stay out of a public repository by default. **Back up `days.json` and
`Uploads/` together** if you want the day log preserved.

---

## 6 · Validation

`node Tests/run.js` — **294 assertions, all passing** (was 197, then 252). New coverage: timetable save
and normalisation (invalid slots dropped, colours normalised, admin-only), A/B week parity in
both directions, period ordering, holidays, the upload endpoint (accept, reject `.svg`, reject
anonymous, reject a traversal day id), day save/update/duplicate-date/delete, feed filtering
(text, subject, files, date range), the calendar index, the note→days reverse link, attachment
serving and filename-preserving download, members-only gating for days *and* the timetable from
both an anonymous and a signed-in viewer, and the static-route guards.

The whole page was also exercised in a browser: feed / calendar / timetable views, day detail,
deep links, EN↔HU switching, mobile layout, and the note-viewer "covered in class" round trip.
