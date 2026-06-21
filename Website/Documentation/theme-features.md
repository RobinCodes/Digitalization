# Theme features

Additions to the Knowledge Index frontend (in `index.html` and `devtools.html`, with server-side
persistence support in `server.js`). The theme model is `dark / light / custom`; **dark and light
are unchanged**. **Teal is no longer a standalone theme — it lives as a preset inside Custom.**
(Teal is purely an opt-in preset now — it is never auto-applied; a legacy `teal` selection simply falls back to the Custom/Amethyst default.)

The **default theme is now Custom (Amethyst preset)** for new visitors, and the Custom theme
studio is always shown under Appearance — so the full set of presets is visible the moment you
open Settings.

**DevTools now shares the same themes.** `devtools.html` uses the same theme engine and the same `ki_theme` / `ki_custom_theme` storage as the main app, so whatever theme you pick in one applies in the other. Its theme switch offers Dark / Light / Custom, and a compact preset strip appears under the header when Custom is active (defaulting to Amethyst). Legacy DevTools-only theme selections are carried over once.

## 1. Powerful custom themes

The **Custom** theme (Settings → Appearance → Custom) is now a full theme studio rather than
just two accent swatches.

- **Four colour controls:** Accent, Highlight, **Background**, and **Text**.
- **Derived palette:** from your Background + Text, the app computes the surface shades
  (`--bg2/3/4`), secondary/tertiary text, and borders automatically — light or dark is detected
  from the background's luminance, so the UI stays coherent whatever base you pick.
- **Radiant glow:** a toggle that paints a soft radial-gradient backdrop (its colour is its own
  picker). Fixed to the viewport, it shows through the blurred header.
- **12 presets**, several radiant: Gold, **Teal**, Aurora, Sunset, Amethyst, Rose, Nordic,
  Emerald, Crimson, Mono, Daylight, Sky. Click one to load it as your current custom theme; the
  active preset is highlighted. **Amethyst is the default** (what a fresh install and the
  right-click action use); Teal is one of the presets here rather than a separate theme.

## 2. Right-click the theme button → your saved theme

- **Right-click** the header theme button (or the mobile / PDF theme buttons) to instantly apply
  your **right-click theme**. By default this applies the **Amethyst** preset; save a theme and
  mark it as the right-click target to override that default.
- **Save themes:** name the current custom theme and hit Save. Saved themes are listed with
  **Apply**, **Right-click** (designate this one as the right-click target — tap again to clear),
  and **Delete**.
- Left-click still does the normal light/dark flip — nothing about that changed.

## 3. Cursor themes

Right below the theme presets (Settings → Appearance) is a **Cursor themes** studio that
restyles the custom JS cursor (the dot + ring that replaces the OS pointer).

- **13 presets**, from minimalist to flashy: **Theme** (follows the active accent), **Cream**
  and **Onyx** (cream / black minimalist pointers — a soft, *tailless and rounded* teardrop),
  **Pulsar**, Halo, Neon, Comet, Rainbow, Bubble, Ember, Mint, Minimal, Loop. Each preset card
  shows a live preview.
- **Pulsar** is the showcase **and the default cursor** for new visitors (alongside the Amethyst
  theme): a radiant blue rounded cursor with a **magnetic Leap** behaviour. It eases a glowing
  ring onto whatever focusable element is under the pointer (using the browser's own hit-testing
  via `elementFromPoint` + `closest`), wrapping buttons/links so they're easier to aim at and
  hover; clicking triggers a smooth spring "leap" pop as the ring lands on the target.
- **Personalise any part:** *Primary* and *Accent* colour pickers, a **Shape** selector
  (Dot + ring / Dot / Ring / **Round** / Arrow), an **Animation** selector (None / Pulse / Spin /
  Breathe / Rainbow / Trail / **Leap (magnetic)**), and a **Glow** toggle (luminous halo).
  Rainbow cycles hue every frame; Trail leaves a fading comet tail on movement; Leap is the
  magnetic snap-and-pop used by Pulsar (works on any Round/blob cursor).
- **Save cursors** with a name and re-apply or delete them, exactly like saved themes.
- The cursor is driven by `--cur-*` CSS variables and `cur-<kind>` / `cur-anim-<anim>` body
  classes; the engine lives next to the existing cursor JS and reuses the theme colour helpers.
  Bilingual EN/HU labels are in the `T` blocks.

## Storage & sync

LocalStorage keys: `ki_custom_theme` (current custom theme, JSON), `ki_saved_themes` (array,
JSON), `ki_rclick_theme` (saved-theme id, or empty = latest custom). The legacy
`ki_custom_accent` / `ki_custom_accent2` keys are migrated automatically and kept mirrored for
back-compat. Cursor themes add `ki_cursor` (current cursor, JSON) and `ki_cursor_saved` (array,
JSON).

These now sync to your account like other settings: `cleanSettings()` in `server.js` was
extended to accept `theme:'custom'`, `customTheme`, `savedThemes`, and `rclickTheme`, each with a
strict type check and length cap (4 KB / 64 KB / 64 chars) — consistent with the rest of the
hardened settings whitelist. The cursor keys (`cursor`, `cursorSaved`) are whitelisted the same
way (1 KB / 64 KB caps). (Previously even the old custom accent never synced, because the
whitelist dropped it.)

## 4. Custom, cursor-friendly form controls

Native form controls (`<input type="color">`, `<input type="date">`, `<select>`) summon the OS
picker/cursor, which breaks the app's custom cursor. They're replaced by themed, in-page controls
(all `cursor:none`), each of which mirrors a hidden native element and re-dispatches its
`input`/`change` event, so existing logic is untouched:

- **Custom HSV colour picker** — every theme colour (Accent / Highlight / Background / Text /
  Radiant) and the cursor colours (Primary / Accent) now open a popover with a saturation–value
  square, a hue strip, a live preview, and a hex field. Built on the existing colour helpers
  (`_h2`, `_2h`, `_rgb2hsv`/`_hsv2rgb`).
- **Custom dropdowns** — the cursor **Shape** and **Animation** selectors (and the timeline
  **Show** basis) use the same dropdown pattern as the main-page sort filter.
- **Custom date picker** — see [[dates-and-timelines]] (the timeline From/To inputs).

## 5. Interface motion & loading

- **Tab transitions** — switching top-nav pages plays a refined `pageEnter` reveal (a soft
  blur-and-rise that settles), honouring `prefers-reduced-motion`.
- **PDF loading** — the viewer overlay now fades (instead of snapping) and shows an **elite ring
  loader**: a determinate progress circle with a live percentage while a PDF *downloads*
  (streamed via `fetch` + `ReadableStream` against `Content-Length`), falling back to an
  indeterminate spin while LaTeX compiles or the document parses. The first rendered page does a
  blur-scale **reveal**, and page-to-page changes use a gentle blur rather than a hard opacity dip.
- **Cursor leap** — the Pulsar magnetic ring now interpolates its corner radius, so it stays a
  rounded rectangle while shrinking and only *converges* to a circle at the end (no snap-to-round
  on un-hover). See [[theme-features]] → Cursor themes.
- **Scrollbars** — native scrollbars are hidden everywhere (browsers force the OS arrow cursor
  over them and ignore `cursor:none`), and the main view gets a themed, `cursor:none` **overlay
  scrollbar** instead that tracks scroll position and is draggable.

## Notes

- Bilingual: all new labels have EN + HU strings; the Hungarian wording is a reasonable first
  pass — adjust to taste in the `T.hu` block.
- File encoding preserved (CRLF, matching the rest of the core files).