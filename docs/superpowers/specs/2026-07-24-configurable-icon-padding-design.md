# Configurable Padding Between Tray Icons — Design

**Issue:** [#20](https://github.com/keithvassallomt/status-tray/issues/20) — *[feature request] configurable width between the icons*

**Date:** 2026-07-24

## Summary

Add a user-configurable setting controlling the gap between adjacent tray
icons in the panel. Today the gap is fixed by the stylesheet's
`-natural-hpadding: 2px` on `.status-tray-button` (2px per side → a 4px gap
between two icons). This feature exposes that gap as a preference.

## User-facing behaviour

- New prefs control labelled **"Padding between icons"**, subtitle
  *"Gap in pixels between adjacent tray icons."*
- The setting value **is the total gap between two adjacent icons**. Setting
  it to `5` produces a 5px gap between two neighbouring icons.
- Internally the value is applied as `gap / 2` per side, so odd values like
  `5` become `2.5px` per side.
- Live update: changing the value re-styles the tray immediately, with no
  need to disable/re-enable the extension.

## Setting

New GSettings key in
`src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`:

```xml
<key name="icon-padding" type="i">
  <default>4</default>
  <range min="0" max="20"/>
  <summary>Padding between tray icons</summary>
  <description>Gap in pixels between adjacent tray icons in the panel. Applied as half this value of horizontal padding on each side of every icon. Range: 0-20.</description>
</key>
```

- **Default `4`** preserves the current appearance exactly (2px per side).
- **Range `0–20`**.
- Type `i` (integer). Per-side value is computed as `value / 2` at apply
  time and may be fractional (e.g. `2.5px`); St accepts fractional lengths.

## Implementation

Follows the existing `icon-size` wiring pattern end-to-end.

### extension.js

1. **Apply per item.** Each `TrayItem` is a `PanelMenu.Button` (an
   `St.Button`). Apply padding via inline style on the button itself:

   ```js
   const pad = this._settings.get_int('icon-padding') / 2;
   this.set_style(`-natural-hpadding: ${pad}px; -minimum-hpadding: ${pad}px;`);
   ```

   This runs once when the item is created (alongside the initial icon setup)
   and again from the refresh path below. The button's own `set_style` is not
   used anywhere else, so there is nothing to clobber.

2. **Refresh method.** Add `_refreshPadding()` on the extension, mirroring
   `_refreshIconSizes()`:

   ```js
   _refreshPadding() {
       for (const [, item] of this._items)
           item._applyPadding();
       this._applyOverflow();
   }
   ```

   (Item-side logic lives in a small `_applyPadding()` method on `TrayItem`
   for parity with `_applyIconSize()`.)

3. **Signal wiring.** Add to the `connectObject` block in `enable()`:

   ```js
   'changed::icon-padding', () => {
       debug('icon-padding setting changed');
       this._refreshPadding();
   },
   ```

### Overflow button

`OverflowButton` also carries the `.status-tray-button` class. Apply the same
per-side padding to it in its render/update path so it stays visually
consistent with the inline icons. `_refreshPadding()` calls `_applyOverflow()`
so the overflow button picks up changes on the same live-update path.

### stylesheet.css

The existing `.panel-button.status-tray-button` rule keeps
`padding-left: 0; padding-right: 0;`. Its `-natural-hpadding`/
`-minimum-hpadding` values become the fallback default only; the inline style
set from the setting overrides them at runtime. Leave the CSS as-is (default
2px per side still matches the `4` gap default) so there is no flash of
un-padded icons before the inline style applies.

### prefs.js

Add a control next to the existing `icon-size` control, using the same
`Adjustment` + `SpinRow` (or scale) pattern:

- Adjustment: lower `0`, upper `20`, step `1`.
- Bind to the `icon-padding` key.
- Title: **"Padding between icons"**; subtitle: *"Gap in pixels between
  adjacent tray icons."*

## Edge behaviour (expected, not a bug)

Because padding sits on both sides of every button, the outermost icons also
get `gap/2` of padding on their outer edge (against the panel edge or a
neighbouring extension). This is identical to how the fixed 2px padding
behaves today and is the intended, standard result.

## Testing / verification

Manual verification in a nested GNOME Shell session (the project's normal
workflow — pure GJS, no unit harness):

1. Fresh install with no stored value → icons look identical to current
   release (4px gap).
2. Set padding to `0` → icons sit flush.
3. Set padding to `20` → wide, even gaps.
4. Set an odd value (`5`) → gap looks correct; no visual breakage from the
   `2.5px` per-side value.
5. Change the value while the extension is running → tray re-spaces live,
   including the overflow button when overflow is enabled.

## Out of scope (YAGNI)

- Per-app padding overrides.
- Vertical padding / panel height adjustments.
- Separate control over outer-edge padding vs. inter-icon padding.
