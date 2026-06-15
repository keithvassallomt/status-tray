# Overflow button icon — three modes

**Date:** 2026-06-15
**Status:** Approved for implementation

## Problem

The overflow button's dynamic preview inherits the global `icon-mode`. In
symbolic mode every preview icon is recoloured to one flat colour, so the
overlapping silhouettes merge into an indistinct blob — the individual hidden
icons can't be told apart.

## Goal

Replace the current two-way `overflow-icon-style` (`dynamic`/`static`) with a
three-way choice that decouples the preview's colour treatment from the global
`icon-mode`, and make the always-legible option the default.

## Setting

`overflow-icon-style` becomes a 3-value enum. Naming mirrors the global
`icon-mode` (`symbolic` / `original`).

| Value | UI label | Behaviour |
|---|---|---|
| `static` | Static icon | Bundled glyph (`status-tray.svg` / `-symbolic.svg`). **New default.** |
| `dynamic-original` | Dynamic preview (colour) | Preview in the apps' natural colours, always — independent of `icon-mode`. Existing overlapping layout, no halo. |
| `dynamic-symbolic` | Dynamic preview (monochrome) | Preview recoloured monochrome, always. Existing overlapping layout **plus a halo knockout** so silhouettes stay legible. |

- Schema `<choices>` lists the three values; `<default>` flips to `'static'`.

## Migration

- **Never-set users:** GSettings returns the new default `static`. No code.
- **Legacy `'dynamic'` (explicitly stored):** `_getOverflowIconStyle()` maps it
  to follow the current `icon-mode` — `symbolic` → `dynamic-symbolic`, otherwise
  `dynamic-original`. This preserves prior appearance. Coercion happens on read;
  the stored value is not rewritten.
- Any unrecognised value coerces to `static` (safe default).

## Rendering

### Decoupling colour from `icon-mode`
`_applySymbolicStyle(targetIcon, iconSize)` gains an optional third parameter
`forceMode`:

```
_applySymbolicStyle(targetIcon = this._icon, iconSize = 16, forceMode = null)
```

- When `forceMode` is `null` (panel rows, menu rows) the method reads the global
  `icon-mode` exactly as today — fully backward compatible.
- The overflow preview passes `'original'` or `'symbolic'` to force the
  treatment regardless of the global setting.

### Layout
Both dynamic variants keep the existing `_getPreviewPositions` overlapping
layout. No geometry change.

### Halo (monochrome variant only)
In `_buildDynamicIcon`, when the variant is `dynamic-symbolic`, each position
renders **two** actors:

1. **Halo** `St.Icon` — same icon source, enlarged by a small fixed margin
   (~2px total) and offset by half that, recoloured to a contrasting
   "panel background" colour.
2. **Glyph** `St.Icon` on top — normal monochrome treatment via
   `_applySymbolicStyle(icon, size, 'symbolic')`.

Actors are added **per icon, back-to-front** (halo, glyph, halo, glyph, …) so
each icon's halo carves a gap into the icon beneath it.

The `dynamic-original` variant renders a single actor per position (as today),
no halo.

### Halo colour
Derived from `isDarkMode()` (already present): dark mode → light icons → a
near-opaque dark halo; light mode → the inverse. Avoids fragile theme-node
reads while still tracking light/dark.

### Known limitation — pixmap icons
Recolour-via-`color` works cleanly for true symbolic and themed named icons.
Pixmap-backed icons (Electron/Flatpak) are not flatly recolourable, so their
halo is best-effort (an enlarged copy tinted via a colorize effect). In
monochrome mode these icons are desaturated rather than flat-white, so the
merge problem is milder for them. Documented in code; not over-engineered.

## Touch points

- `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` — 3 choices,
  default `static`.
- `src/extension.js`:
  - `_getOverflowIconStyle()` — return one of the three values; map legacy
    `dynamic`; coerce unknown → `static`.
  - `updateOverflowIcon()` — branch on the three values.
  - `_buildDynamicIcon()` — accept the variant; build halo actors for the
    monochrome case.
  - `_applySymbolicStyle()` — add `forceMode` parameter.
- `src/prefs.js` — ComboRow third entry; selected-index ↔ value mapping for
  three values (replacing the current binary mapping).
- `README.md`, `docs/status-tray.md`, `changelog.md`.

## Testing (manual — repo has no test harness)

- Each of the three `overflow-icon-style` values.
- 1 / 2 / 3 / 4 overflowed icon counts.
- Global `icon-mode` symbolic vs original — confirm the preview no longer
  follows it (colour stays colour, mono stays mono).
- A pixmap-heavy app (Electron/Flatpak) in the monochrome preview.
- Light vs dark theme — confirm the halo contrasts in both.
- `./validate.sh` reports clean (0 findings).

## Out of scope

- Changing the overlapping layout geometry.
- Adding halos to the colour variant.
- Any change to panel/menu-row icon rendering beyond the optional
  `forceMode` parameter (which is a no-op when omitted).
