# Three-way Overflow Button Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-way `overflow-icon-style` (`dynamic`/`static`) with three modes — Static icon (new default), Dynamic preview (colour), Dynamic preview (monochrome) — decoupling the preview's colour treatment from the global `icon-mode` and adding a halo knockout so the monochrome preview stays legible.

**Architecture:** The overflow button reads a 3-value enum. The dynamic preview keeps its existing overlapping layout but forces its colour treatment (`original`/`symbolic`) via a new optional parameter on the shared `_applySymbolicStyle` helper instead of inheriting the global `icon-mode`. The monochrome variant additionally draws, per icon and back-to-front, a panel-background-coloured "halo" actor behind each recolourable glyph so overlapping silhouettes separate.

**Tech Stack:** GJS (GNOME Shell 45+), St / Clutter / Gio / GLib, GSettings (gschema XML), Adwaita/Gtk in prefs. No test framework — verification is `node --input-type=module --check` for JS syntax, `./validate.sh` (shexli static analysis) for lint, and a manual logout/login checklist.

**Reference spec:** `docs/superpowers/specs/2026-06-15-overflow-icon-modes-design.md`

---

## File Structure

- `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` — enum choices + default.
- `src/extension.js` — `_applySymbolicStyle` (forceMode param), `OverflowButton._getOverflowIconStyle` / `updateOverflowIcon` / `_buildDynamicIcon` / new `_haloColor`, `_applyTrayItemIcon` (forceMode passthrough), new halo constants.
- `src/prefs.js` — ComboRow with three entries + index↔value mapping.
- `README.md`, `docs/status-tray.md`, `changelog.md` — user/dev docs.

A note for the implementer on the existing code (you have zero context): `OverflowButton` is a `PanelMenu.Button` subclass near the bottom of `src/extension.js`. `TrayItem` (a `St.BoxLayout`-ish actor higher up) owns the real panel icon in `this._icon` (always an `St.Icon`) and the styling routine `_applySymbolicStyle`. The overflow preview clones each overflowed `TrayItem`'s icon into small `St.Icon`s via `_applyTrayItemIcon`, which in turn calls the owning `TrayItem._applySymbolicStyle` to mirror the panel's look. `isDarkMode()` is a module-level helper already defined in the file.

---

## Task 1: Schema — three choices, default `static`

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` (the `overflow-icon-style` key)

- [ ] **Step 1: Replace the key definition**

Find the current key:

```xml
    <key name="overflow-icon-style" type="s">
      <choices>
        <choice value="dynamic"/>
        <choice value="static"/>
      </choices>
      <default>'dynamic'</default>
      <summary>Overflow icon style</summary>
      <description>How to render the overflow button in the panel. 'dynamic' previews up to four hidden tray icons; 'static' uses the bundled tray glyph.</description>
    </key>
```

Replace it with:

```xml
    <key name="overflow-icon-style" type="s">
      <choices>
        <choice value="static"/>
        <choice value="dynamic-original"/>
        <choice value="dynamic-symbolic"/>
      </choices>
      <default>'static'</default>
      <summary>Overflow icon style</summary>
      <description>How to render the overflow button in the panel. 'static' uses the bundled tray glyph; 'dynamic-original' previews up to four hidden tray icons in their original colours; 'dynamic-symbolic' previews them recoloured to monochrome with a separating outline.</description>
    </key>
```

- [ ] **Step 2: Verify the schema compiles**

Run: `glib-compile-schemas --strict --dry-run src/schemas`
Expected: no output, exit code 0. (A bad `<choices>`/`<default>` mismatch would error here.)

- [ ] **Step 3: Commit**

```bash
git add src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml
git commit -m "Overflow icon: three-value schema, default static"
```

---

## Task 2: `_applySymbolicStyle` — optional forceMode parameter

**Files:**
- Modify: `src/extension.js` (the `TrayItem._applySymbolicStyle` method, around line 1188)

This makes the colour treatment overridable without changing any existing caller.

- [ ] **Step 1: Add the parameter to the signature**

Find:

```javascript
    _applySymbolicStyle(targetIcon = this._icon, iconSize = 16) {
```

Replace with:

```javascript
    _applySymbolicStyle(targetIcon = this._icon, iconSize = 16, forceMode = null) {
```

- [ ] **Step 2: Use forceMode when resolving the mode**

Find (inside that method):

```javascript
        const iconMode = this._settings?.get_string('icon-mode') ?? 'symbolic';
```

Replace with:

```javascript
        // forceMode lets the overflow preview pick 'symbolic'/'original'
        // explicitly; everything else inherits the global icon-mode.
        const iconMode = forceMode ?? this._settings?.get_string('icon-mode') ?? 'symbolic';
```

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < src/extension.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/extension.js
git commit -m "TrayItem: allow forcing icon mode in _applySymbolicStyle"
```

---

## Task 3: `_applyTrayItemIcon` — pass forceMode through

**Files:**
- Modify: `src/extension.js` (the `OverflowButton._applyTrayItemIcon` method, around line 1980)

- [ ] **Step 1: Add the parameter to the signature**

Find:

```javascript
    _applyTrayItemIcon(targetIcon, trayItem, iconSize = 16) {
```

Replace with:

```javascript
    _applyTrayItemIcon(targetIcon, trayItem, iconSize = 16, forceMode = null) {
```

- [ ] **Step 2: Forward it to `_applySymbolicStyle`**

Find:

```javascript
        trayItem._applySymbolicStyle(targetIcon, iconSize);
```

Replace with:

```javascript
        trayItem._applySymbolicStyle(targetIcon, iconSize, forceMode);
```

(The other caller, `_applyRowIcon`, calls `_applyTrayItemIcon(subItem.icon, trayItem)` with no `iconSize`/`forceMode`; it keeps inheriting the global mode — correct, leave it.)

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < src/extension.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/extension.js
git commit -m "OverflowButton: thread forceMode through _applyTrayItemIcon"
```

---

## Task 4: Halo constants + `_haloColor` helper

**Files:**
- Modify: `src/extension.js` (constants block near the top ~line 30; add a method to `OverflowButton`)

- [ ] **Step 1: Add the halo constants**

Find:

```javascript
const OVERFLOW_PREVIEW_GRID_ICON_SIZE = 11;
const OVERFLOW_PREVIEW_STACK_ICON_SIZE = 13;
```

Add directly below:

```javascript
// Monochrome preview halo: the background-coloured outline drawn behind each
// glyph so overlapping silhouettes separate. The halo actor is this many px
// larger than its glyph, inset by half that to stay centred.
const OVERFLOW_PREVIEW_HALO_MARGIN = 4;
const OVERFLOW_PREVIEW_HALO_INSET = 2;
```

- [ ] **Step 2: Add the `_haloColor` method to `OverflowButton`**

Insert this method just above `_buildDynamicIcon` (around line 1865, after `_buildStaticIcon`'s closing brace):

```javascript
    // Contrasting colour for the monochrome-preview halo. In dark mode the
    // glyphs are light, so the halo is dark (≈ panel background) and vice
    // versa. Tracks light/dark without fragile theme-node reads.
    _haloColor() {
        return isDarkMode()
            ? 'rgba(46, 52, 54, 0.95)'
            : 'rgba(245, 245, 245, 0.95)';
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < src/extension.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/extension.js
git commit -m "OverflowButton: add halo constants and _haloColor helper"
```

---

## Task 5: `_getOverflowIconStyle` — three values + legacy migration

**Files:**
- Modify: `src/extension.js` (the `OverflowButton._getOverflowIconStyle` method, around line 1848)

- [ ] **Step 1: Replace the method**

Find:

```javascript
    _getOverflowIconStyle() {
        const style = this._settings?.get_string('overflow-icon-style') ?? 'dynamic';
        return style === 'static' ? 'static' : 'dynamic';
    }
```

Replace with:

```javascript
    _getOverflowIconStyle() {
        const style = this._settings?.get_string('overflow-icon-style') ?? 'static';
        if (style === 'static' || style === 'dynamic-original' || style === 'dynamic-symbolic')
            return style;
        // Legacy 'dynamic' followed the global icon-mode; preserve that mapping
        // so users who explicitly chose it keep the same appearance.
        if (style === 'dynamic') {
            const iconMode = this._settings?.get_string('icon-mode') ?? 'symbolic';
            return iconMode === 'symbolic' ? 'dynamic-symbolic' : 'dynamic-original';
        }
        return 'static';
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --input-type=module --check < src/extension.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/extension.js
git commit -m "OverflowButton: resolve three-value style with legacy migration"
```

---

## Task 6: `updateOverflowIcon` + `_buildDynamicIcon` — branch on the three values and build the halo

**Files:**
- Modify: `src/extension.js` (`OverflowButton.updateOverflowIcon` ~line 1818 and `_buildDynamicIcon` ~line 1866)

- [ ] **Step 1: Branch `updateOverflowIcon` on the resolved style**

Find:

```javascript
        if (this._getOverflowIconStyle() === 'dynamic' && this._overflowedItems.length > 0) {
            this._setIconActor(this._buildDynamicIcon());
            return;
        }

        this._setIconActor(this._buildStaticIcon());
```

Replace with:

```javascript
        const style = this._getOverflowIconStyle();
        if (style !== 'static' && this._overflowedItems.length > 0) {
            this._setIconActor(this._buildDynamicIcon(style));
            return;
        }

        this._setIconActor(this._buildStaticIcon());
```

- [ ] **Step 2: Replace `_buildDynamicIcon` to accept the style and draw halos**

Find the whole method:

```javascript
    _buildDynamicIcon() {
        const preview = new St.Widget({
            style_class: 'system-status-icon status-tray-overflow-preview',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: OVERFLOW_PREVIEW_SIZE,
            height: OVERFLOW_PREVIEW_SIZE,
            layout_manager: new Clutter.FixedLayout(),
        });
        preview.set_size(OVERFLOW_PREVIEW_SIZE, OVERFLOW_PREVIEW_SIZE);

        const items = this._overflowedItems.slice(0, OVERFLOW_PREVIEW_LIMIT);
        const positions = this._getPreviewPositions(items.length);

        for (let i = 0; i < items.length; i++) {
            const { x, y, size } = positions[i];
            const icon = new St.Icon({
                style_class: 'status-tray-overflow-preview-icon',
            });
            icon.set_position(x, y);
            icon.set_size(size, size);
            this._applyTrayItemIcon(icon, items[i], size);
            preview.add_child(icon);
        }

        return preview;
    }
```

Replace with:

```javascript
    _buildDynamicIcon(style) {
        const preview = new St.Widget({
            style_class: 'system-status-icon status-tray-overflow-preview',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: OVERFLOW_PREVIEW_SIZE,
            height: OVERFLOW_PREVIEW_SIZE,
            layout_manager: new Clutter.FixedLayout(),
        });
        preview.set_size(OVERFLOW_PREVIEW_SIZE, OVERFLOW_PREVIEW_SIZE);

        const items = this._overflowedItems.slice(0, OVERFLOW_PREVIEW_LIMIT);
        const positions = this._getPreviewPositions(items.length);
        const forceMode = style === 'dynamic-symbolic' ? 'symbolic' : 'original';
        const withHalo = style === 'dynamic-symbolic';

        for (let i = 0; i < items.length; i++) {
            const { x, y, size } = positions[i];

            // Halo first (drawn behind), then glyph — done per icon so each
            // icon's halo carves a gap into the icon beneath it. Only icons
            // recolourable via `color` (symbolic/named) get a halo; pixmap
            // icons aren't flatly recolourable and are already desaturated in
            // monochrome mode, so the merge is milder for them.
            const src = items[i]._icon;
            const recolourable = !!(src && (src.get_gicon() || src.icon_name));
            if (withHalo && recolourable) {
                const haloSize = size + OVERFLOW_PREVIEW_HALO_MARGIN;
                const halo = new St.Icon({
                    style_class: 'status-tray-overflow-preview-icon',
                });
                halo.set_position(x - OVERFLOW_PREVIEW_HALO_INSET, y - OVERFLOW_PREVIEW_HALO_INSET);
                halo.set_size(haloSize, haloSize);
                this._applyTrayItemIcon(halo, items[i], haloSize, 'symbolic');
                // Flatten to a solid silhouette in the halo colour: drop the
                // effects/recolour _applyTrayItemIcon added and force `color`.
                halo.clear_effects();
                halo.set_style(`icon-size: ${haloSize}px; -st-icon-style: symbolic; color: ${this._haloColor()};`);
                preview.add_child(halo);
            }

            const icon = new St.Icon({
                style_class: 'status-tray-overflow-preview-icon',
            });
            icon.set_position(x, y);
            icon.set_size(size, size);
            this._applyTrayItemIcon(icon, items[i], size, forceMode);
            preview.add_child(icon);
        }

        return preview;
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < src/extension.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Lint**

Run: `./validate.sh`
Expected: `shexli: clean (0 findings, 0 errors, 0 warnings)`.

- [ ] **Step 5: Commit**

```bash
git add src/extension.js
git commit -m "OverflowButton: three preview modes with monochrome halo"
```

---

## Task 7: Preferences — three-entry ComboRow

**Files:**
- Modify: `src/prefs.js` (the overflow ComboRow block, around line 1599)

- [ ] **Step 1: Replace the model + selection + handler**

Find:

```javascript
        const overflowIconModel = new Gtk.StringList();
        overflowIconModel.append('Dynamic preview');
        overflowIconModel.append('Static icon');
        overflowIconRow.set_model(overflowIconModel);

        const currentOverflowIconStyle = this._settings.get_string('overflow-icon-style');
        overflowIconRow.set_selected(currentOverflowIconStyle === 'static' ? 1 : 0);

        overflowIconRow.connect('notify::selected', () => {
            const selected = overflowIconRow.get_selected();
            this._settings.set_string('overflow-icon-style', selected === 1 ? 'static' : 'dynamic');
        });
```

Replace with:

```javascript
        const overflowIconModel = new Gtk.StringList();
        overflowIconModel.append('Static icon');
        overflowIconModel.append('Dynamic preview (colour)');
        overflowIconModel.append('Dynamic preview (monochrome)');
        overflowIconRow.set_model(overflowIconModel);

        // ComboRow index ↔ stored value. Index order matches the appended rows.
        const overflowIconValues = ['static', 'dynamic-original', 'dynamic-symbolic'];
        const currentOverflowIconStyle = this._settings.get_string('overflow-icon-style');
        let currentIndex = overflowIconValues.indexOf(currentOverflowIconStyle);
        if (currentIndex < 0) {
            // Legacy 'dynamic' followed icon-mode; anything else falls back to Static.
            currentIndex = currentOverflowIconStyle === 'dynamic'
                ? (this._settings.get_string('icon-mode') === 'symbolic' ? 2 : 1)
                : 0;
        }
        overflowIconRow.set_selected(currentIndex);

        overflowIconRow.connect('notify::selected', () => {
            const selected = overflowIconRow.get_selected();
            this._settings.set_string('overflow-icon-style', overflowIconValues[selected] ?? 'static');
        });
```

- [ ] **Step 2: Update the row subtitle (optional clarity)**

Find:

```javascript
            subtitle: 'Preview hidden icons or use the standard tray icon',
```

Replace with:

```javascript
            subtitle: 'Use the standard tray icon, or preview hidden icons in colour or monochrome',
```

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < src/prefs.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Lint**

Run: `./validate.sh`
Expected: `shexli: clean (0 findings, 0 errors, 0 warnings)`.

- [ ] **Step 5: Commit**

```bash
git add src/prefs.js
git commit -m "Prefs: three-entry overflow icon ComboRow"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`, `docs/status-tray.md`, `changelog.md`

- [ ] **Step 1: README — overflow bullet**

Find:

```markdown
- **Overflow button icon** - Show a dynamic preview of up to 4 hidden icons or
  keep the static tray glyph
```

Replace with:

```markdown
- **Overflow button icon** - Keep the static tray glyph (default), or show a
  dynamic preview of up to 4 hidden icons in colour or in monochrome
```

- [ ] **Step 2: README — Icon Style note**

Find:

```markdown
The overflow button honours the global Icon Style setting for both the static
glyph and dynamic previews.
```

Replace with:

```markdown
The static glyph honours the global Icon Style setting. The dynamic previews
set their own colour treatment (colour or monochrome) independently of it; the
monochrome preview adds a separating outline so overlapping icons stay legible.
```

- [ ] **Step 3: docs/status-tray.md — schema table row**

Find:

```markdown
| `overflow-icon-style` | `s` | `'dynamic'` | `'dynamic'` previews up to four hidden icons; `'static'` uses the bundled tray glyph |
```

Replace with:

```markdown
| `overflow-icon-style` | `s` | `'static'` | `'static'` uses the bundled tray glyph; `'dynamic-original'` previews up to four hidden icons in colour; `'dynamic-symbolic'` previews them in monochrome with a separating outline |
```

- [ ] **Step 4: docs/status-tray.md — Responsibilities bullet**

Find:

```markdown
- Renders either a dynamic preview of up to four overflowed tray icons or one
  of two bundled glyphs (`icons/status-tray.svg` or
  `icons/status-tray-symbolic.svg`) depending on `overflow-icon-style` and
  the current `icon-mode`.
```

Replace with:

```markdown
- Renders one of three ways depending on `overflow-icon-style`: a bundled glyph
  (`icons/status-tray.svg` / `icons/status-tray-symbolic.svg`, following the
  current `icon-mode`), a colour preview of up to four overflowed tray icons, or
  a monochrome preview of them with a panel-background halo behind each glyph so
  overlapping silhouettes separate. The dynamic previews set their own colour
  treatment independently of `icon-mode`.
```

- [ ] **Step 5: docs/status-tray.md — `_applySymbolicStyle` signature in the method table**

Find:

```markdown
| `_applySymbolicStyle(targetIcon, iconSize)` | Apply Clutter effects for symbolic mode |
```

Replace with:

```markdown
| `_applySymbolicStyle(targetIcon, iconSize, forceMode)` | Apply Clutter effects for symbolic mode; `forceMode` overrides the global `icon-mode` (used by the overflow preview) |
```

- [ ] **Step 6: docs/status-tray.md — prefs tree label**

Find:

```markdown
    │   ├── Overflow button icon (Adw.ComboRow)  → overflow-icon-style
```

Confirm it is still accurate (label unchanged, still maps to `overflow-icon-style`). No edit needed if the line already reads this way; otherwise align it to the above.

- [ ] **Step 7: changelog — update the Unreleased entry**

Find the current Unreleased Added entry:

```markdown
- Overflow button icons can now use a dynamic preview that shows up to four hidden tray icons. Preferences include a Static option for users who prefer the bundled tray glyph. Thanks to [@krissedout](https://github.com/krissedout) for the entire feature! 
```

Replace with:

```markdown
- Overflow button icon now offers three modes: Static icon (default), Dynamic preview (colour), and Dynamic preview (monochrome). The dynamic previews show up to four hidden tray icons and set their own colour treatment independently of the global Icon Style; the monochrome preview adds a separating outline so overlapping icons stay legible. Thanks to [@krissedout](https://github.com/krissedout) for the original dynamic preview feature.
```

- [ ] **Step 8: Commit**

```bash
git add README.md docs/status-tray.md changelog.md
git commit -m "Docs: three-way overflow button icon"
```

---

## Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Lint clean**

Run: `./validate.sh`
Expected: `shexli: clean (0 findings, 0 errors, 0 warnings)`.

- [ ] **Step 2: Install the dev build**

Run: `./install.sh`
Expected: "Schemas compiled successfully" and "Installation complete!".

- [ ] **Step 3: Clean the stray compiled artifact** (so the tree stays tidy)

Run: `rm -f src/schemas/gschemas.compiled`
Expected: no output. (validate.sh also removes it, but do it explicitly here.)

- [ ] **Step 4: Manual test checklist** (requires logout/login on Wayland)

Log out and back in, then verify:

- Prefs (`gnome-extensions prefs status-tray@keithvassallo.com`) shows three options: **Static icon**, **Dynamic preview (colour)**, **Dynamic preview (monochrome)**; default on a fresh profile is **Static icon**.
- **Static** → bundled glyph, and it still follows global Icon Style (symbolic/original).
- **Dynamic preview (colour)** → overlapping preview in natural colours, *unchanged* when the global Icon Style is toggled symbolic↔original.
- **Dynamic preview (monochrome)** → overlapping preview, monochrome, with visible separation between icons; *unchanged* when global Icon Style is toggled.
- Cycle 1 / 2 / 3 / 4 overflowed icons in each dynamic mode — separation holds at every count.
- A pixmap-heavy app (Electron/Flatpak) in monochrome mode renders without error (its icons may lack a halo — expected).
- Light theme and dark theme: the monochrome halo contrasts in both.
- An existing profile that had explicitly set the old `dynamic` value still shows a dynamic preview (matching its `icon-mode`), not Static.

- [ ] **Step 5: No further commit** — all code/doc commits already landed in Tasks 1–8.

---

## Self-Review (completed by plan author)

- **Spec coverage:** schema+default (T1), forceMode decoupling (T2/T3), halo constants/colour (T4), three-value resolve + legacy migration (T5), three-mode branch + halo build (T6), prefs three-entry + index/value + legacy (T7), docs incl. README/status-tray/changelog (T8), validate + manual matrix incl. pixmap/theme/legacy (T9). All spec sections mapped.
- **Placeholder scan:** none — every code step shows full find/replace content.
- **Type/name consistency:** `forceMode` param name consistent across `_applySymbolicStyle`/`_applyTrayItemIcon`; values `static`/`dynamic-original`/`dynamic-symbolic` consistent across schema, `_getOverflowIconStyle`, `_buildDynamicIcon`, and prefs `overflowIconValues`; constants `OVERFLOW_PREVIEW_HALO_MARGIN`/`_INSET` and `_haloColor()` used exactly as defined.
