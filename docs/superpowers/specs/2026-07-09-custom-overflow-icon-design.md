# Custom overflow button icon — design

## Summary

Let users set a custom icon for the overflow button (the button that collapses
extra tray icons). In the extension preferences, the existing **Overflow button
icon** dropdown gains a fourth option, **Custom icon**. Selecting it reveals a
dedicated row with an icon picker (the same picker used for custom tray icons)
and a preview. The chosen icon is rendered as the overflow button glyph.

## Goals

- Add "Custom icon" as a mutually-exclusive overflow icon style.
- Reuse the existing `IconPickerDialog` (theme icon browser + "Choose File…")
  so users can pick a theme icon name or an arbitrary image file.
- Render the custom icon WYSIWYG, respecting the configured icon size.
- Never present a broken/empty overflow button — fall back to the bundled glyph
  when no valid custom icon is set.

## Non-goals

- No change to the existing static / dynamic-preview behaviors.
- No per-app or fallback/lock/effect semantics for the overflow icon (those are
  concepts specific to per-app tray icons).
- No forced symbolic recoloring of custom icons (see Rendering below).

## Data model (GSettings)

File: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`

1. Extend the `overflow-icon-style` enum choices to add `custom`:
   `static`, `dynamic-original`, `dynamic-symbolic`, `custom`.
2. Add a new key:
   - `overflow-custom-icon` — type `s`, default `''`.
   - Value is **either a theme icon name or an absolute file path**,
     distinguished by the leading-`/` heuristic already used throughout the
     codebase for `icon-overrides`. This keeps storage identical to custom tray
     icons.

`custom` is a fourth, mutually-exclusive style. When selected, the overflow
button always shows the custom icon and never falls back to the dynamic mosaic —
mirroring how `static` behaves today.

## Rendering (extension)

File: `src/extension.js`, `OverflowButton` class.

- `updateOverflowIcon()` gains a branch: when the style is `custom`, call a new
  `_buildCustomIcon()` instead of the static/dynamic dispatch.
- `_buildCustomIcon()`:
  - Reads `overflow-custom-icon`.
  - If the value is an absolute path (`startsWith('/')`), builds a
    `Gio.FileIcon` after a `query_exists` check; otherwise builds an `St.Icon`
    with `icon_name`.
  - Applies the same inline `icon-size: {N}px` style used by
    `_buildStaticIcon()`, so icon-size live-scaling works for free.
  - **Fallback:** if `overflow-custom-icon` is blank, or is a path that does not
    exist, returns `_buildStaticIcon()` (the bundled glyph). The overflow button
    is therefore never empty or broken.
- Add a `changed::overflow-custom-icon` watcher alongside the existing overflow
  watchers (near `src/extension.js:2676-2686`) that calls `updateOverflowIcon()`
  for live updates.

### Symbolic behavior

The custom icon renders WYSIWYG. Unlike the bundled static glyph — which swaps
`status-tray.svg` ↔ `status-tray-symbolic.svg` based on `icon-mode` — a custom
icon is shown exactly as chosen: a symbolic *icon name* follows the theme color
naturally, and a colored file stays colored. No forced recoloring in symbolic
mode. This is the expected behavior for a user-chosen "custom" icon.

## Preferences UI

File: `src/prefs.js`, overflow preferences group (around line 1645).

- Append `'Custom icon'` to the `overflowIconModel` StringList and `'custom'` to
  the `overflowIconValues` array (keeping index alignment).
- Add a **reveal row** directly below the ComboRow: an `Adw.ActionRow` titled
  "Custom overflow icon" containing:
  - a small `Gtk.Image` preview,
  - an icon-picker `Gtk.Button` that opens the slimmed `IconPickerDialog`,
  - a reset/clear button that sets `overflow-custom-icon` to `''`.
- The reveal row's `visible` is bound to
  `(overflow-enabled && overflow-icon-style === 'custom')`. This is recomputed
  from both:
  - the `overflow-enabled` switch handler (which already toggles sensitivity of
    the count and combo rows), and
  - the ComboRow `notify::selected` handler.
- The row's preview must use path-vs-name rendering (Gio.FileIcon for paths,
  `set_from_icon_name` for names) rather than a bare `set_from_icon_name`, so
  file-path previews display correctly.

## Reusing IconPickerDialog (approach A)

`IconPickerDialog` (`src/prefs.js:606+`) is currently coupled to per-app
`icon-overrides`: it takes an `appId`, writes `icon-overrides[appId]`, and shows
fallback/lock/effect controls that are meaningless for the overflow button.

**Chosen approach: parameterize the dialog.** Introduce a lightweight "target"
abstraction so the dialog reads/writes through a getter/setter (or a
`{ simple: true, settingsKey: 'overflow-custom-icon' }` mode) instead of
hardcoding `icon-overrides[appId]`. In simple mode:

- reads/writes `overflow-custom-icon`,
- hides the fallback / lock / effect rows,
- reuses the icon grid, search, category dropdown, and "Choose File…"
  unchanged.

This is the smallest change that keeps a single icon browser to maintain.
(Rejected alternatives: extracting the browser core into a shared widget —
larger refactor than this feature warrants; duplicating a slim picker — forks
the icon-browsing code and risks maintenance drift.)

## Edge cases

- Custom selected but nothing picked → bundled static glyph (Rendering fallback).
- Reset button clears `overflow-custom-icon` → fallback glyph.
- Custom icon path deleted on disk after selection → `query_exists` fails →
  fallback glyph.
- Switching away from and back to `custom` preserves the stored
  `overflow-custom-icon` value (it is independent of the style key).

## Documentation

- Document the new setting in `docs/status-tray.md`.
- Add a changelog entry.

## Files touched

- `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` — enum +
  new key.
- `src/extension.js` — `_buildCustomIcon()`, `updateOverflowIcon()` branch,
  settings watcher.
- `src/prefs.js` — ComboRow entry, reveal row, `IconPickerDialog` simple mode.
- `docs/status-tray.md`, changelog — documentation.
