# Note donations

Members can offer notes; an admin audits every one before anything reaches the archive.
Bilingual EN/HU, the strict shell CSP is intact, and the suite covers the flow
(`node Tests/run.js`, now **410 assertions**).

The archive used to be admin-authored only. This opens the door without opening the
archive: a donation is staged outside `Data/`, is invisible to everyone but its donor
and the admins, and becomes a note only when an admin says where it goes and presses
Accept.

---

## What a donor can send

Four kinds, mirroring what the archive already knows how to display:

- **LaTeX** — typed into the panel, or uploaded as a `.tex`.
- **Markdown / plain text** — `.md`, `.txt`, `.bib`, typed or uploaded.
- **PDFs** — a finished document.
- **Scans and photos** — `.png`, `.jpg`, `.webp`, `.heic` and the rest of the image
  list, for photographed paper notes.

A donation may carry up to 12 files, 25 MB each (`DONATE_UPLOAD_MAX`), with a typed
body of up to 512 KB. One file becomes the note; the others can travel with it into
the same folder, which is how a `.tex` keeps its figures.

Two extensions are deliberately **not** accepted. `.svg`, `.html` and `.htm` execute
script from our own origin — the same reason the day-attachment list excludes them.
`.sty` and `.cls` are pulled in automatically by any `.tex` compiled beside them, so
accepting one is a much larger decision than accepting a note and stays a deliberate
admin action in DevTools.

## Where the donate button lives

Three entry points, and the difference between them is how much the donor has to say:

1. **A timetable cell** (Days → Timetable). The cell knows its subject, and a subject
   already carries a `folder` / `folderLang` link to its notes. So the panel opens
   with the subject attached and the destination pre-filled — the donor picks
   neither. This is the path the feature was designed around.
2. **A lesson card** on a logged day. Same thing, resolved from the lesson's subject.
3. **Account panel → My donations → Donate a note.** No subject, because nothing
   here knows one.

A donor may always clear the subject, and may always type a suggested folder by hand.
Both are *suggestions*: the admin picks the real destination at review time. Donating
with neither a subject nor a folder hint is allowed but asks for confirmation first —
filing it then costs a reviewer real work, so it is a choice rather than an accident.

## What the admin sees

A **Donations** tab in DevTools, with a count badge that is refreshed on sign-in so a
submission that arrived overnight announces itself. Each review sheet offers:

- the donor, the subject, their message and their suggestions;
- every staged file, with a radio to pick the note and checkboxes for what travels
  with it;
- a preview — the PDF or image inline, the source in an editable box, and for a
  `.tex` a **Build a PDF preview** button;
- the destination: language, a folder browser (the same `/api/admin/browse` the Notes
  tab walks), file name, metadata, and the access controls;
- **Accept** or **Decline**, either way with a reply the donor sees.

Corrections typed into the source box are what gets saved — an audit is allowed to
fix things, not only to say yes.

## Ownership

An accepted note is **admin-managed**, and the donor is credited in `authors`
(a toggle in the review sheet, on by default). `owners` is left empty, so the note
falls to the admins the way any un-owned note does. Accepting a donation transfers
the note, not the donor's rights over it — a donor cannot later edit the archive
through `/api/note/manage`.

## Backend

A new `donations.json` store (gitignored, on the protected-static list, and in the
backup export) plus staging under `Uploads/donations/<id>/`. Files are stored as
`<itemId><ext>`, never under donor-supplied names.

Donor routes, all requiring a signed-in session and all scoped to that caller's own
submission — there is no path through them that reads, alters or even confirms the
existence of anyone else's:

| Route | Does |
| --- | --- |
| `POST /api/donate/draft` | Opens (or returns) the caller's one draft |
| `POST /api/donate/upload` | Raw-body upload into that draft |
| `POST /api/donate/item/delete` | Unstage a file before submitting |
| `POST /api/donate/submit` | Freeze it, write the typed body, notify the admins |
| `GET /api/donate/mine` | The caller's own submissions and their outcomes |
| `POST /api/donate/withdraw` | Cancel a pending one; the files are deleted |

Admin routes (`requireAdminEither`, so a decline works straight from a chat card):
`GET /api/admin/donations`, `GET /api/admin/donation/text`,
`POST /api/admin/donation/compile`, `.../accept`, `.../decline`.

Notification rides the existing chat store, which is the site's only channel — there
is no mail server. Submitting posts a `donation` card into a DM with every admin;
deciding settles all of those cards at once and posts one `donation-result` card back
to the donor, so the other admins stop looking at a decision already made.

## The containment rules

Four things this feature is built to guarantee, each covered by the suite:

**A submission is not in the archive.** It is staged under `Uploads/`, which is never
served statically. Only `/uploads/donations/<id>/<item><ext>` serves it, and only to
the donor or an admin — everyone else gets **404, not 403**, so the status code alone
never confirms a submission exists. That is the rule the day attachments already
follow. Anything that is not an image or a PDF is handed over as a download rather
than rendered in the page, with the filename taken from our own record, not the URL.

**A donor never chooses a path.** `suggestPath` is shown next to the folder picker and
is never used to resolve anything. The destination comes from the admin, through
`safePath`, and the path recorded afterwards is derived from the *resolved* folder
rather than the submitted string — `safePath` sanitises rather than rejects, so
echoing the input back would record a path that does not describe where the file
actually is, and that path is what the donor is shown.

**Donor text never becomes structure.** `safeNoteBase()` strips slashes, control
characters, Windows-reserved punctuation, leading dots — and braces, because the
archive reads `{...}` in a filename as the note's tag list, so a donor could
otherwise write their own tags by naming their file.

**Nothing accumulates.** Declining and withdrawing delete the staged files outright:
we asked for the work, it was not taken, and holding somebody's unpublished note
indefinitely is not ours to do. The decision record stays. Abandoned drafts are swept
after 24 hours, like unsaved days.

## Running a stranger's LaTeX

The preview build is the one place the server compiles LaTeX that nobody has vouched
for. It runs in the sandbox every archive note already compiles in:

- `-no-shell-escape` — no `\write18`, so no shell from inside the document;
- `openin_any=p` / `openout_any=p` — no reads or writes outside the job's own
  directory, no dotfiles, no absolute or parent paths;
- a copy into a throwaway temp directory, deleted afterwards;
- a hard 120-second kill and the global concurrency limiter;
- **admin-triggered only** — a donor cannot make the server compile their own
  submission — and rate-limited on top.

The render is never cached (`compileTex(..., { cache: false })`), so a declined
submission leaves no PDF behind and a preview can never be mistaken for, or evict,
an archive note's cached render.

The residual risk is CPU: a deliberately pathological document can burn up to the
timeout. That is bounded by the timeout, the concurrency limiter and the rate limit,
and it costs an admin an explicit click to start.

## Abuse limits

Five pending donations per account, 300 site-wide, one open draft per account
(`/api/donate/draft` hands back the existing one rather than minting another, which
is what caps drafts at one). IP rate limits on the draft/submit path, the upload path
and the preview build. Every cap is an environment variable:
`DONATE_MAX_PENDING_USER`, `DONATE_MAX_PENDING_TOTAL`, `DONATE_UPLOAD_MAX`.

## Note on the chat card

A donor can delete their own donation card from the chat the same way they can
already delete an access-request card. This hides the notification but not the work:
`donations.json` is the queue's source of truth and the DevTools tab reads that, not
the chat. The card is a doorbell, not the record.
