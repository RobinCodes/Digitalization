# Discussions & references

Three additions to the Knowledge Index frontend, plus a small backend store. File encoding
preserved (CRLF), bilingual EN/HU, and the strict shell CSP is intact (the inline script still
carries exactly one nonce placeholder and re-validates).

## 1. Styled message input (Reference modal)

The free-text message box in the note-reference dialog was an unstyled `<textarea>`. It's now a
proper field: wrapped in a labelled `Message` row to match the `Send to` control above it, with a
rounded surface, comfortable padding, and an accent focus ring (`.disc-textarea`).

## 2. "Reference this note" + a real Discussion panel

The old **Discuss** button was renamed to **Reference this note** — which is what it always did:
open a dialog to send a direct message that links the note to another user. (Unchanged behaviour,
honest label.) It appears on both the PDF viewer toolbar and the code viewer.

Next to it is a new **Discussion** button. It opens a slide-in panel docked to the right of the
note — a shared, threaded discussion attached to that specific note (not a private DM). Anyone who
can view the note sees the same thread; you post inline, messages show author + timestamp, and you
can delete your own. References inside discussion messages render as clickable links too.

**Backend.** A new `note-discussions.json` store (gitignored), keyed by `lang:path`, with three
endpoints under `/api/note/discussion` (GET / POST / `…/delete`). All three:

- require a signed-in session (401 otherwise), and
- require `canViewNote(...)` to pass for that note (403 otherwise) — so discussion visibility
  exactly tracks who can see the note. A members-only or whitelist note's discussion is closed to
  everyone else.

Posts are capped at 8000 chars and a thread keeps its last 500 messages; deletes are author-only;
writes are atomic (temp-file + rename), matching the rest of the hardened state files.

## 3. Reference picker in the composer

A new **reference** button sits to the left of the message input (in both the chat composer and
the discussion composer). Clicking it opens a small picker:

1. Pick a kind — **Note**, **Article**, **Log**, or **Link**.
2. For Note / Article / Log you get a searchable list (notes from the current tree, articles from
   `/api/articles`, log entries from the changelog). For Link you enter a label + URL.

Selecting an item inserts a `[label](ki://kind/target?lang=xx)` token at your cursor. These are the
same tokens the app already renders elsewhere, so they show up as clickable links in the sent
message and jump to the note / article / changelog entry / external URL when clicked. (External
links stay restricted to `http(s)` by the existing `navigateToRef` guard.)

## 4. Connection status, offline outbox & presence

Messaging is now honest about connectivity (applies to both the chat composer and the note
**Discussion** panel).

- **Connection state.** A `NET` layer tracks `navigator.onLine` plus the `online`/`offline`
  events, and confirms real reachability with a lightweight `GET /api/presence` ping (on focus,
  on reconnect, and periodically). When you're offline a banner appears under the header:
  *"You are offline — messages will be sent when you reconnect."*
- **Exact send status.** Each message you send renders immediately with its state: **Sending…**
  (animated), **Sent** (it appears as a normal delivered bubble), or **Not sent — will retry**
  with a manual **Retry** button.
- **Per-device outbox (not per-session).** Unsent messages are persisted to
  `localStorage` under `ki_outbox_<user>`, so they survive a reload or browser restart. A retry
  runs on reconnect, on window focus, and every 20 s; on success the item is removed. Retries are
  **bounded**: transient failures back off exponentially (20 s → … → 5 min) and give up after 8
  attempts, while permanent rejections (4xx — unknown recipient, deleted conversation, expired
  session) fail fast and stop immediately instead of hammering the server forever. Given-up
  messages stay visible as **Not sent** with a manual **Retry** that revives them.
- **Presence.** `server.js` keeps an in-memory last-seen map (`touchPresence`) updated on every
  authenticated chat hit and on the `/api/presence` heartbeat; `/api/chat/list` and
  `/api/chat/messages` now include a `presence` map. A 1:1 conversation header shows the other
  person as **online**, **last seen …**, or **offline**. Because presence is heartbeat-driven,
  when *this* user loses their connection their heartbeats stop and the other party sees them go
  offline automatically — no explicit "I went offline" message is needed (which couldn't be sent
  anyway).

`GET /api/presence?users=a,b` touches the caller's last-seen and returns, for each requested
user, how many ms ago they were last seen (or `null` = never). It also works anonymously, so it
doubles as the client's reachability ping.

## Notes

- Hungarian strings are a solid first pass — tweak in the `T.hu` block if you want.
- Because the shell markup changed, it's worth loading the page once in a browser to confirm the
  inline script runs clean under the nonce CSP (it does in checks here: 20/20 live + 6/6 token
  round-trip + syntax).