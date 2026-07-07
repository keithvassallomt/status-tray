# Configurable Icon Size — Design

**Date:** 2026-07-07
**Status:** Approved, ready for implementation plan

## Summary

Let users choose the size of tray icons in the top bar. Today the size is
hardcoded to 16px throughout the render paths. This adds an "Icon Size" dropdown
to the Appearance section of preferences offering seven values (14–20px), with
the panel updating live so the icons themselves act as the preview.

## Goals

- Add a single `Adw.ComboRow` "Icon Size" control to the Appearance group.
- Seven contiguous presets from 14px to 20px (default 16px = current behaviour).
- Main panel tray icons scale to the chosen size.
- The overflow button's live preview scales proportionally so it stays visually
  matched to the tray icons.
- Changing the setting updates the panel immediately (no re-enable needed).

## Non-goals

- Dropdown submenu icons (inside the overflow menu) stay fixed at 16px — a
  separate context where large icons look out of place.
- No free-form/custom pixel entry; presets only.
- No per-app size overrides.

## User-facing behaviour

New row in **Preferences → General → Appearance**, directly after "Icon Style":

> **Icon Size** — The size of icons in the top bar

Dropdown entries (label ↔ stored px):

| px | Label                    |
|----|--------------------------|
| 14 | Smallest                 |
| 15 | Smaller                  |
| 16 | Standard (default)       |
| 17 | Slightly larger          |
| 18 | Larger                   |
| 19 | Big                      |
| 20 | Enormous                 |

The tone is deliberately playful; labels are used verbatim.

## Design

### 1. Setting / storage

Add a gsettings key to
`src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`:

```xml
<key name="icon-size" type="i">
  <default>16</default>
  <range min="14" max="20"/>
  <summary>Tray icon size</summary>
  <description>Size in pixels of tray icons shown in the top bar. Range: 14-20.</description>
</key>
```

Rationale for integer px over an enum: every render call site already accepts a
numeric `iconSize`, so an int threads through with no mapping layer, and the
contiguous 14–20 range makes the prefs index arithmetic trivial. The schema
`<range>` guards against out-of-band values.

Schemas must be recompiled (`glib-compile-schemas`) as part of the normal build;
noted so the plan includes it.

### 2. Preferences UI (`src/prefs.js`)

In the `Appearance` group (currently ends after `iconModeRow`, ~line 1581), add
an `Adw.ComboRow` mirroring the existing "Icon Style" pattern:

- Title "Icon Size", subtitle "The size of icons in the top bar".
- `Gtk.StringList` with the seven labels above, in order.
- Load: `selectedIndex = clamp(get_int('icon-size'), 14, 20) - 14`, falling back
  to `2` (Standard) if the value is somehow outside range.
- On `notify::selected`: `set_int('icon-size', 14 + selectedIndex)`.

No custom preview widget — the live panel is the preview.

### 3. Main panel icons (`src/extension.js`, `TrayItem`)

Add a helper on `TrayItem`:

```js
_configuredIconSize() {
    const size = this._settings.get_int('icon-size');
    return (size >= 14 && size <= 20) ? size : 16;
}
```

Thread it into the main tray-icon size path (default parameter expressions can
reference `this` in instance methods):

- `_applySymbolicStyle(targetIcon = this._icon, iconSize = this._configuredIconSize(), forceMode = null)` — line ~1193. This is `TrayItem`'s own style pass; all its no-argument callers render the main panel icon, so they scale.
- The pixbuf path `const scaledSize = 16 * scaleFactor;` (line ~1374, inside `TrayItem`) becomes `this._configuredIconSize() * scaleFactor`.

**Do not** change the `iconSize = 16` default on `_applyTrayItemIcon` (line
~2032). That method belongs to `OverflowButton`, and its default is hit only by
`_applyRowIcon` → the overflow **submenu** row icons, which are explicitly out of
scope (stay 16px). Its other callers (halo, dynamic preview) already pass an
explicit scaled size and override the default.

The `stTheme.lookup_icon(iconName, 16, 0)` call (line ~1119) is a resolution hint
for which icon variant to load; it may optionally use the configured size for
crispness at 20px, but this is a minor refinement, not required for correctness.
Pixmap-source selection (line ~158) and the source-dimension validity check
(line ~1322) are unrelated to display size and stay as-is.

### 4. Overflow button — proportional scaling (`src/extension.js`, `OverflowButton`)

The dynamic preview is drawn on a fixed 18px canvas with hardcoded glyph sizes
(solo 16 / grid 11 / stack 13) and hardcoded x/y positions tuned for 16px tray
icons. To keep the overflow button matched to the tray icons, scale the whole
mosaic by:

```js
const r = this._configuredIconSize() / 16;   // OverflowButton reads its own _settings
```

Apply `r` (rounded to int, min 1) to:

- `OVERFLOW_PREVIEW_SIZE` (canvas 18px → `Math.round(18 * r)`).
- The three preview icon-size constants (16 / 11 / 13).
- The x/y/size values returned by `_getPreviewPositions`.
- The halo margin/inset scale with `r` too so the outline stays proportional.

Implementation approach: convert the module-level `OVERFLOW_PREVIEW_*` constants
into a per-render computation (a helper that takes the base size and returns the
scaled canvas size, positions, and glyph sizes), so the existing structure is
preserved and only the numbers scale. `OverflowButton` needs a
`_configuredIconSize()` helper equivalent to `TrayItem`'s (both classes already
hold `this._settings`).

The **static** overflow glyph sizes via panel CSS (`system-status-icon`) and
needs no change. The **solo** dynamic preview (single overflowed icon) should
size to the configured value so a one-icon overflow button visually equals a
real tray icon.

### 5. Live update (`src/extension.js`, `enable()`)

Add to the `connectObject` block (~line 2617):

```js
'changed::icon-size', () => {
    debug('icon-size setting changed');
    this._refreshIconStyles();
    this._applyOverflow();
},
```

`_refreshIconStyles()` re-applies `_applySymbolicStyle` to every tray item
(picking up the new size via the default param), and `_applyOverflow()` rebuilds
the overflow button with the new ratio.

### 6. Documentation

- `docs/status-tray.md`: document the new Icon Size setting in the Appearance
  section.
- `changelog.md`: add an entry under a new minor version (next after 1.11),
  in the existing Keep a Changelog format.

## Testing / verification

- Recompile schemas, install, restart the shell session (or nested session).
- Confirm the dropdown shows all seven labels and defaults to Standard.
- Set each of 14 / 16 / 20 and confirm main tray icons resize live without a
  re-enable.
- With overflow enabled and 2–4 hidden icons, confirm the overflow preview
  scales with the setting and the solo preview matches a real tray icon.
- Confirm submenu icons in the overflow dropdown stay at 16px.
- Confirm 20px icons sit within the standard panel height without resizing the
  bar, in both symbolic and original modes, light and dark.

## Risks / notes

- At 20px the grid/stack overflow glyphs grow noticeably; rounding is applied and
  the result eyeballed during verification. If a scaled mosaic looks cramped, the
  position ratios can be hand-tuned without changing the public behaviour.
- Panel row height is GNOME-controlled; 14–20px stays within the standard bar.
