# Configurable Icon Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Icon Size" dropdown to preferences (14–20px, default 16) that scales the main tray icons and the overflow button's live preview, updating the panel immediately.

**Architecture:** A new integer gsettings key `icon-size` (range 14–20, default 16) is read inline at the render sites in `extension.js`, exactly as the existing `icon-mode` key is. `prefs.js` gains an `Adw.ComboRow` mirroring the existing "Icon Style" row. Live updates are handled by a new `_refreshIconSizes()` that resizes each item's icon (CSS for themed icons, `set_size` for content/pixmap icons) and rebuilds the overflow button.

**Tech Stack:** GJS (GNOME Shell 45+ ESM), libadwaita/GTK4 (prefs process only), GSettings.

## Global Constraints

Copied verbatim from `~/LocalCode/docs/antislop.md` and `~/LocalCode/docs/ext_rev.md` — every task must satisfy these:

- **Smallest correct change.** Change only the lines the task requires; preserve existing comments and behaviour. (antislop 4)
- **Match the project's style.** Read settings inline (`this._settings.get_int(...)`) as the codebase does for `icon-mode`; do not introduce a getter helper. No new comments except where they record a constraint the code can't express, matching existing density. (antislop 10, 40)
- **Process separation.** `Gtk`/`Adw`/`Gdk` only in `prefs.js`; `St`/`Clutter`/`Meta`/`Shell` only in `extension.js`. (ext_rev 10, 11)
- **No duplicated blocks.** The overflow scale factor and the render-site reads follow the existing single-source patterns. (ext_rev 24)
- **No `gschemas.compiled` in git.** It is gitignored and stripped by `validate.sh`; never `git add` it. (ext_rev 25, antislop 46)
- **Logging:** use the existing `debug()` wrapper only, at parity with surrounding code; no new user-visible logging. (ext_rev 18, 19)
- **Verify before done:** run `./validate.sh` (shexli, the EGO gate) and exercise the feature in a running shell; report honestly. (antislop 37, 38; ext_rev 33)
- **One logical change per commit.** (antislop 45)

**Preset map (single source of truth):** stored px `= 14 + comboIndex`; comboIndex `= px − 14`. Seven entries, index 0→6:

| idx | px | Label            |
|-----|----|------------------|
| 0   | 14 | Smallest         |
| 1   | 15 | Smaller          |
| 2   | 16 | Standard         |
| 3   | 17 | Slightly larger  |
| 4   | 18 | Larger           |
| 5   | 19 | Big              |
| 6   | 20 | Enormous         |

The schema `<range min="14" max="20"/>` guarantees reads are in-range, so no clamping is needed at read sites.

---

### Task 1: Add the `icon-size` gsettings key

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`

**Interfaces:**
- Produces: gsettings key `icon-size` (type `i`, default `16`, range 14–20), read by Tasks 2–5.

- [ ] **Step 1: Add the key**

Insert directly after the `icon-mode` key block (currently ends at the `</key>` on line 15), matching the surrounding indentation and summary/description style:

```xml
    <key name="icon-size" type="i">
      <default>16</default>
      <range min="14" max="20"/>
      <summary>Tray icon size</summary>
      <description>Size in pixels of tray icons shown in the top bar. Range: 14-20.</description>
    </key>
```

- [ ] **Step 2: Compile the schema and verify it is valid**

Run: `glib-compile-schemas --strict src/schemas && echo OK`
Expected: prints `OK` with no warnings. (This writes `src/schemas/gschemas.compiled` — a build artifact; do not commit it.)

- [ ] **Step 3: Verify the key reads its default**

Run:
```bash
GSETTINGS_SCHEMA_DIR=src/schemas gsettings get org.gnome.shell.extensions.status-tray icon-size
```
Expected: `16`

- [ ] **Step 4: Commit** (schema source only)

```bash
git add src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml
git commit -m "Add icon-size gsettings key (14-20px, default 16)"
```

---

### Task 2: Add the Icon Size dropdown to preferences

**Files:**
- Modify: `src/prefs.js` (Appearance group, after `appearanceGroup.add(iconModeRow);` — currently line 1581)

**Interfaces:**
- Consumes: gsettings key `icon-size` from Task 1.
- Produces: user-facing control writing `icon-size` as `14 + selectedIndex`.

- [ ] **Step 1: Add the ComboRow**

Immediately after `appearanceGroup.add(iconModeRow);` (line 1581), insert a row that mirrors the existing `iconModeRow` pattern (StringList + `notify::selected`). The labels are the approved playful set; the default is conveyed by pre-selection, so no literal "(default)" text:

```javascript
        const iconSizeRow = new Adw.ComboRow({
            title: 'Icon Size',
            subtitle: 'The size of icons in the top bar',
        });

        const iconSizeModel = new Gtk.StringList();
        for (const label of ['Smallest', 'Smaller', 'Standard', 'Slightly larger', 'Larger', 'Big', 'Enormous'])
            iconSizeModel.append(label);
        iconSizeRow.set_model(iconSizeModel);

        // Stored px maps to index as px - 14 (schema range guarantees 14-20).
        iconSizeRow.set_selected(this._settings.get_int('icon-size') - 14);

        iconSizeRow.connect('notify::selected', () => {
            this._settings.set_int('icon-size', 14 + iconSizeRow.get_selected());
        });

        appearanceGroup.add(iconSizeRow);
```

- [ ] **Step 2: Verify prefs parse cleanly**

Run: `gjs -c "import('./src/prefs.js').then(() => print('OK')).catch(e => { print(e.message); imports.system.exit(1); })"` if `gjs` is available; otherwise `node --check` is not valid for GJS ESM — instead rely on Step 3's live check.
Expected: no syntax error. (A parse failure here surfaces as a thrown error.)

- [ ] **Step 3: Verify in the running prefs window**

Run: `./install.sh` then open preferences:
```bash
gnome-extensions prefs status-tray@keithvassallo.com
```
Expected: Under **Appearance**, a new "Icon Size" row appears below "Icon Style", showing "Standard" selected, with the seven labels in the dropdown. Selecting a value and reopening prefs shows the choice persisted.

- [ ] **Step 4: Run the EGO quality gate**

Run: `./validate.sh`
Expected: shexli reports no new findings. (Requires network for the shexli venv; if unavailable, note it and rely on live verification.)

- [ ] **Step 5: Commit**

```bash
git add src/prefs.js
git commit -m "Prefs: add Icon Size dropdown to Appearance"
```

---

### Task 3: Render main panel icons at the configured size

**Files:**
- Modify: `src/extension.js` — `TrayItem._applySymbolicStyle` default param (line 1193); `_setIconFromPixmap` scaled size (line 1374)

**Interfaces:**
- Consumes: gsettings key `icon-size`.
- Produces: main panel icons rendered at the configured px. Both call sites read `this._settings.get_int('icon-size')` inline (TrayItem holds `this._settings`, set in `_init`).

- [ ] **Step 1: Default the style size to the configured size**

Change the signature on line 1193 from:

```javascript
    _applySymbolicStyle(targetIcon = this._icon, iconSize = 16, forceMode = null) {
```

to:

```javascript
    _applySymbolicStyle(targetIcon = this._icon, iconSize = this._settings.get_int('icon-size'), forceMode = null) {
```

Callers that pass an explicit size (the overflow preview via `_applyTrayItemIcon` at line 2080) are unaffected — they override the default.

- [ ] **Step 2: Scale the pixmap-content size**

Change line 1374 from:

```javascript
                const scaledSize = 16 * scaleFactor;
```

to:

```javascript
                const scaledSize = this._settings.get_int('icon-size') * scaleFactor;
```

- [ ] **Step 3: Verify themed and pixmap icons render at the new size**

Run `./install.sh`, restart the shell (Task 3 verification block below), set `icon-size` to 20, then start fresh apps that produce a tray icon:
```bash
GSETTINGS_SCHEMA_DIR=$HOME/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com/schemas \
  gsettings set org.gnome.shell.extensions.status-tray icon-size 20
```
Expected: newly-appearing tray icons (both a themed/symbolic app and a pixmap app such as an Electron client) render visibly larger than at 16. (Live resize of already-shown icons is Task 5; here we only confirm fresh renders honour the setting.)

- [ ] **Step 4: Run the EGO quality gate**

Run: `./validate.sh`
Expected: no new findings.

- [ ] **Step 5: Commit**

```bash
git add src/extension.js
git commit -m "Render tray icons at the configured icon-size"
```

---

### Task 4: Scale the overflow button preview proportionally

**Files:**
- Modify: `src/extension.js` — `OverflowButton._buildDynamicIcon` (lines 1892–1945)

**Interfaces:**
- Consumes: gsettings key `icon-size`; module constants `OVERFLOW_PREVIEW_SIZE` (18), `OVERFLOW_PREVIEW_HALO_MARGIN` (4), `OVERFLOW_PREVIEW_HALO_INSET` (2); `_getPreviewPositions(count)` returning base `{x, y, size}` at 16px baseline.
- Produces: overflow preview scaled by `scale = get_int('icon-size') / 16`, keeping the button matched to the tray icons. `_getPreviewPositions` stays the untouched base-layout source; scaling is applied at use.

- [ ] **Step 1: Compute the scale and scale the canvas**

At the top of `_buildDynamicIcon`, after the method opens, add the scale factor and apply it to the canvas dimensions. Change the preview construction (lines 1892–1901) from:

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
```

to:

```javascript
    _buildDynamicIcon(style) {
        // Preview mosaic tracks the tray icon size: base geometry is tuned for
        // 16px, so scale every dimension by the configured size over 16.
        const scale = this._settings.get_int('icon-size') / 16;
        const canvas = Math.round(OVERFLOW_PREVIEW_SIZE * scale);
        const preview = new St.Widget({
            style_class: 'system-status-icon status-tray-overflow-preview',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: canvas,
            height: canvas,
            layout_manager: new Clutter.FixedLayout(),
        });
        preview.set_size(canvas, canvas);
```

- [ ] **Step 2: Scale the per-icon geometry and halo**

In the `for` loop (lines 1910–1941), scale the position, glyph size, and halo. Change from:

```javascript
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
```

to:

```javascript
        for (let i = 0; i < items.length; i++) {
            const base = positions[i];
            const x = Math.round(base.x * scale);
            const y = Math.round(base.y * scale);
            const size = Math.round(base.size * scale);

            // Halo first (drawn behind), then glyph — done per icon so each
            // icon's halo carves a gap into the icon beneath it. Only icons
            // recolourable via `color` (symbolic/named) get a halo; pixmap
            // icons aren't flatly recolourable and are already desaturated in
            // monochrome mode, so the merge is milder for them.
            const src = items[i]._icon;
            const recolourable = !!(src && (src.get_gicon() || src.icon_name));
            if (withHalo && recolourable) {
                const haloSize = size + Math.round(OVERFLOW_PREVIEW_HALO_MARGIN * scale);
                const inset = Math.round(OVERFLOW_PREVIEW_HALO_INSET * scale);
                const halo = new St.Icon({
                    style_class: 'status-tray-overflow-preview-icon',
                });
                halo.set_position(x - inset, y - inset);
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
```

- [ ] **Step 3: Verify the overflow preview scales**

`./install.sh`, restart shell, enable overflow with a low inline limit so 2–4 icons overflow, and set `icon-size` to 14 then 20. Expected: the overflow button's preview mosaic shrinks at 14 and grows at 20, staying proportionate; a single overflowed icon (solo) matches the size of a real tray icon.

- [ ] **Step 4: Run the EGO quality gate**

Run: `./validate.sh`
Expected: no new findings.

- [ ] **Step 5: Commit**

```bash
git add src/extension.js
git commit -m "Scale overflow preview with icon-size"
```

---

### Task 5: Live update on icon-size change

**Files:**
- Modify: `src/extension.js` — add `TrayItem._applyIconSize()`; add `StatusTray._refreshIconSizes()`; add `changed::icon-size` to the `connectObject` block (line 2617)

**Interfaces:**
- Consumes: gsettings key `icon-size`; existing `_applySymbolicStyle()`, `_applyOverflow()`, `this._items` (Map of TrayItems), `this._icon`.
- Produces: `_refreshIconSizes()` — resizes every item's icon in place and rebuilds the overflow button.

Rationale for `set_size` on content icons: `_applySymbolicStyle` only sets `icon-size` CSS, which does not resize a content/pixmap-backed `St.Icon` (its geometry is the explicit `width`/`height` set in `_setIconFromPixmap`). A blanket `_updateIcon()` rebuild is avoided deliberately — see the stale-IconThemePath comment in `_refreshIcons`. So content icons are resized with `set_size` (no icon re-lookup), themed icons via the CSS that `_applySymbolicStyle` already applies.

- [ ] **Step 1: Add `_applyIconSize` to TrayItem**

Add this method to the `TrayItem` class, directly after `_applySymbolicStyle` (i.e. after line 1288), matching surrounding style:

```javascript
    _applyIconSize() {
        // Content/pixmap icons size via explicit width/height, which icon-size
        // CSS won't change; resize the actor directly without re-looking-up the
        // icon (see _refreshIcons' stale-path note). Themed icons resize via
        // the icon-size CSS that _applySymbolicStyle sets.
        if (this._icon.content) {
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const scaledSize = this._settings.get_int('icon-size') * scaleFactor;
            this._icon.set_size(scaledSize, scaledSize);
        }
        this._applySymbolicStyle();
    }
```

- [ ] **Step 2: Add `_refreshIconSizes` to the extension class**

Add this method directly after `_refreshIconStyles()` (which ends at line 2836), matching the sibling `_refresh*` methods:

```javascript
    _refreshIconSizes() {
        for (const [, item] of this._items) {
            item._applyIconSize();
        }
        this._applyOverflow();
    }
```

- [ ] **Step 3: Wire the signal**

In the `this._settings.connectObject(...)` block, add a handler after the `changed::icon-mode` entry (which ends at line 2625), matching the existing entries' shape:

```javascript
            'changed::icon-size', () => {
                debug('icon-size setting changed');
                this._refreshIconSizes();
            },
```

- [ ] **Step 4: Verify live resize for both icon types**

`./install.sh`, restart shell, with several tray icons already visible (include a themed app and a pixmap/Electron app), open prefs and change Icon Size across Smallest → Standard → Enormous.
Expected: already-visible icons — themed *and* pixmap — resize immediately without needing the app to redraw or the extension to be re-enabled; the overflow button (if present) rescales too.

- [ ] **Step 5: Verify disable/enable leaves no residue**

Run: `gnome-extensions disable status-tray@keithvassallo.com && gnome-extensions enable status-tray@keithvassallo.com`
Expected: no errors in `journalctl --user -b -o cat /usr/bin/gnome-shell | tail`; icons return at the configured size. (Confirms the new signal handler is covered by the existing `disconnectObject(this)` in `disable()` — no new teardown needed, per ext_rev 3.)

- [ ] **Step 6: Run the EGO quality gate**

Run: `./validate.sh`
Expected: no new findings.

- [ ] **Step 7: Commit**

```bash
git add src/extension.js
git commit -m "Live-update tray and overflow icons on icon-size change"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/status-tray.md` (Appearance/settings section)
- Modify: `changelog.md` (under `## [Unreleased]`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the setting in the user docs**

Read `docs/status-tray.md` first to match its structure and tone (antislop 44). Add a short entry for the Icon Size setting in the same place the "Icon Style" / Appearance settings are described — one or two sentences: what it does, the default (Standard = 16px), and that the panel updates live. Do not invent a new section if an Appearance/Settings section already exists.

- [ ] **Step 2: Add a changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Added
- Icon Size setting under Appearance: choose from seven sizes (14–20px, default 16px). Main tray icons and the overflow button preview resize live to match.
```

Match the existing changelog voice (descriptive, no marketing language).

- [ ] **Step 3: Commit**

```bash
git add docs/status-tray.md changelog.md
git commit -m "Docs: document Icon Size setting"
```

---

## Self-Review

**Spec coverage:**
- Setting/storage → Task 1. ✓
- Prefs ComboRow (7 labels, load/save mapping) → Task 2. ✓
- Main panel icons scale → Task 3. ✓
- Overflow button scales proportionally → Task 4. ✓
- Live update → Task 5. ✓ (content-aware, corrects spec §5 which called both `_refreshIconStyles` + `_applyOverflow`; `_refreshIconSizes` handles both and also resizes pixmap icons).
- Submenu icons stay at 16 → guaranteed: no task changes `_applyTrayItemIcon`'s `iconSize = 16` default (its only default-hitting caller is `_applyRowIcon`). ✓
- Docs → Task 6. ✓

**Refinements vs. the committed spec** (driven by antislop.md / ext_rev.md, both read after the spec was written):
- Dropped the `_configuredIconSize()` helper; read `icon-size` inline like the existing `icon-mode` reads (ext_rev 24, antislop 10).
- Live update uses a content-aware `_refreshIconSizes()` (spec's `_refreshIconStyles()` alone would not resize pixmap icons; a blanket `_updateIcon()` is unsafe per the code's own note).
- Dropdown labels are words only (default shown by pre-selection), consistent with the user's original UI mock which carried no px in the control.

**Placeholder scan:** none — every code step shows the exact before/after.

**Type/name consistency:** `_applyIconSize` (TrayItem), `_refreshIconSizes` (extension), key `icon-size`, `scale = get_int / 16`, index map `± 14` used consistently across tasks.

**Open copy question for the user:** the dropdown omits literal "(default)" and any px numbers (Standard is simply pre-selected). Flagged at handoff; trivially reversible if the user wants px shown.
