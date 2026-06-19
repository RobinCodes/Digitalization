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

## Storage & sync

LocalStorage keys: `ki_custom_theme` (current custom theme, JSON), `ki_saved_themes` (array,
JSON), `ki_rclick_theme` (saved-theme id, or empty = latest custom). The legacy
`ki_custom_accent` / `ki_custom_accent2` keys are migrated automatically and kept mirrored for
back-compat.

These now sync to your account like other settings: `cleanSettings()` in `server.js` was
extended to accept `theme:'custom'`, `customTheme`, `savedThemes`, and `rclickTheme`, each with a
strict type check and length cap (4 KB / 64 KB / 64 chars) — consistent with the rest of the
hardened settings whitelist. (Previously even the old custom accent never synced, because the
whitelist dropped it.)

## Notes

- Bilingual: all new labels have EN + HU strings; the Hungarian wording is a reasonable first
  pass — adjust to taste in the `T.hu` block.
- File encoding preserved (CRLF, matching the rest of the core files).