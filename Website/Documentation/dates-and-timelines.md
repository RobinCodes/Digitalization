# Note dates & the learning timeline

Two features, both driven off three new per-note date fields.

## 1. Per-note date fields

Every note now carries three optional dates, edited in **Manage note** (My notes → a note),
stored in that folder's `data.txt` under the note's section:

| Field | data.txt key | Meaning |
|---|---|---|
| Material start date | `material-start` | when you started learning the material |
| Material end date | `material-end` | when you finished |
| Updated date | `updated` | when the note was last revised |

- All three are plain `YYYY-MM-DD` values and use native date pickers.
- **Updated** defaults to the `.tex` file's *last-modified* time. The field is pre-filled
  from it when you open Manage note (if you haven't set one explicitly), and the
  **Auto from file** button re-fills it from the file's current modified time on demand.
  Saving it empty means "just track the file's modified time"; saving a value pins a
  manual override.
- Clearing a field removes the key from `data.txt` entirely (no empty keys are written).
- The dates ride along on every `/api/tree` item (`materialStart`, `materialEnd`,
  `updated`, plus the file's `mtime`), so anything client-side — including the timeline —
  can read them without extra requests.

Storage/serialization, the manage endpoint, and the manage modal were all extended; the
round-trip (save → `data.txt` → tree read-back, including the mtime fallback and
key-clearing) is covered by tests.

## 2. The learning timeline

A new **Timeline** entry in the top nav (and the mobile drawer) opens a full-screen view
that plots your materials against time.

**Date basis** (the *Show* dropdown) — pick which date(s) to lay out:
- **Material period** — each note is drawn as a horizontal **Gantt bar** from its start
  date to its end date, with the material's name labelled just above the bar. (Exactly the
  "up at A, across to B, name above the line" picture.) Notes missing either end of the
  range are simply omitted from this view.
- **Material start / Material end / Updated date** — each note becomes a single diamond
  marker at that date, with the name beside it.

**Subject filter** — the left sidebar lists your top-level subject folders (e.g. STEM,
Humane) and the subfolders inside them, each with a checkbox. Unchecking a subject hides
all its materials; unchecking a single subfolder hides just that one. Top-level subjects
carry a colour dot matching their bars.

**Range & zoom**
- **From / To** date inputs bound the visible window; they auto-default to the data's own
  span (with a little padding) and refit when you switch basis.
- **Fit** scales everything to the viewport; **+ / −** zoom in and out (the axis switches
  between monthly and yearly ticks automatically as you zoom).
- A dashed accent line marks **today** when it falls inside the window.

**Reading it**
- Bars and markers are coloured by top-level subject.
- Overlapping items are packed into stacked lanes so nothing collides (label width is taken
  into account, so names don't run into each other).
- Hovering shows the name, subject and date(s); **clicking opens the note** (the timeline
  closes and jumps straight to it).
- A live count of shown materials sits next to the title.

It reads straight from the already-loaded note tree (loading it on demand if you jump
in cold), so it reflects whatever dates you've set on your notes. Hungarian strings are in
place for the whole view.

### Validation
- Date round-trip (save → data.txt → tree, mtime fallback, key clearing): 5/5
- Timeline core (date scaling, lane packing, axis ticks): 8/8
- Timeline data layer (gather, updated→mtime fallback, all four bases, subject/subfolder
  filtering, extent, folder tree): 9/9
- App regression (per-request nonce CSP, settings, security): 20/20
- Live serve (markup present, nonce substituted, dated notes + folder hierarchy in tree): 7/7

Everything renders under the strict per-request nonce CSP. Worth opening in a browser once
to confirm the visual lands the way you want, then tuning colours/lane height to taste.