# Configurable Padding Between Tray Icons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-configurable "Padding between icons" setting that controls the gap between adjacent tray icons in the GNOME panel.

**Architecture:** A new integer GSettings key `icon-padding` (the total gap in px). At runtime each tray button (both `TrayItem` and `OverflowButton`) sets its own `-natural-hpadding`/`-minimum-hpadding` to `icon-padding / 2` via inline `set_style()`, overriding the stylesheet default. A `changed::icon-padding` handler re-applies the style live. A `Gtk.Scale` in prefs writes the key. This mirrors the existing `icon-size` wiring end-to-end.

**Tech Stack:** Pure GJS GNOME Shell extension (GObject/St/Clutter, Adwaita/Gtk4 for prefs), GSettings/GSchema. No npm, no bundler.

## Global Constraints

- **No automated behavioral test harness exists** (pure GJS). "Verify" steps use: `glib-compile-schemas` for schema validity, `./validate.sh` (shexli static analysis — the same check as EGO submission) for JS, and a manual nested-shell run for behavior. Do **not** invent a unit-test framework.
- Follow existing patterns verbatim — the `icon-size` setting is the reference implementation for every layer.
- The setting value is the **total gap** between two adjacent icons; per-side padding is `value / 2` (may be fractional, e.g. `2.5px`).
- Default `4`, range `0–20`. Default `4` = 2px/side, preserving current appearance exactly.
- Inline `set_style()` on a button replaces its whole inline style string; neither `TrayItem` nor `OverflowButton` sets inline style on the button actor itself elsewhere (only on child `St.Icon`s), so there is nothing to preserve.
- Do not touch `stylesheet.css`; its 2px default remains the pre-inline fallback and matches the `4` default, avoiding any un-padded flash on load.

---

### Task 1: Add the `icon-padding` GSettings key

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` (after the `icon-size` key, ends line 22)

**Interfaces:**
- Consumes: nothing.
- Produces: GSettings key `icon-padding` (type `i`, default `4`, range `0–20`), read via `settings.get_int('icon-padding')` and the `changed::icon-padding` signal.

- [ ] **Step 1: Add the key to the schema**

Insert immediately after the closing `</key>` of the `icon-size` key (line 22), before the `app-order` key:

```xml
    <key name="icon-padding" type="i">
      <default>4</default>
      <range min="0" max="20"/>
      <summary>Padding between tray icons</summary>
      <description>Gap in pixels between adjacent tray icons in the panel. Applied as half this value of horizontal padding on each side of every icon. Range: 0-20.</description>
    </key>
```

- [ ] **Step 2: Verify the schema compiles**

Run: `glib-compile-schemas --strict --dry-run src/schemas/`
Expected: no output, exit status 0 (any schema error prints to stderr and exits non-zero).

- [ ] **Step 3: Commit**

```bash
git add src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml
git commit -m "Add icon-padding GSettings key (#20)"
```

---

### Task 2: Apply padding at runtime in the shell

**Files:**
- Modify: `src/extension.js` — `TrayItem._init` (~line 362), add `TrayItem._applyPadding()` (near `_applyIconSize`, ~line 1290), `OverflowButton._init` (~line 1829), add `OverflowButton._applyPadding()`, add `StatusTrayExtension._refreshPadding()` (after `_refreshIconSizes`, ~line 2903), and the `connectObject` block (after the `changed::icon-size` handler, ~line 2681).

**Interfaces:**
- Consumes: `icon-padding` key from Task 1; `this._settings` (present on `TrayItem`, `OverflowButton`, and the extension); `this._items` (Map of TrayItems) and `this._overflowButton` on the extension.
- Produces: `TrayItem._applyPadding()`, `OverflowButton._applyPadding()`, `StatusTrayExtension._refreshPadding()`.

- [ ] **Step 1: Add `_applyPadding()` to `TrayItem`**

Add this method to the `TrayItem` class, directly above `_applyIconSize()` (currently at line 1290):

```javascript
    _applyPadding() {
        const pad = this._settings.get_int('icon-padding') / 2;
        this.set_style(`-natural-hpadding: ${pad}px; -minimum-hpadding: ${pad}px;`);
    }

```

- [ ] **Step 2: Call it when a `TrayItem` is created**

In `TrayItem._init`, immediately after the existing `this.add_style_class_name('status-tray-button');` (line 362), add the `_applyPadding()` call:

```javascript
        this.add_style_class_name('status-tray-button');
        this._applyPadding();
```

- [ ] **Step 3: Add `_applyPadding()` to `OverflowButton` and call it in `_init`**

In `OverflowButton._init`, after the two `add_style_class_name` calls (lines 1828–1829), add the call:

```javascript
        this.add_style_class_name('status-tray-button');
        this.add_style_class_name('status-tray-overflow-button');
        this._applyPadding();
```

Then add the method to the `OverflowButton` class (e.g. directly below `_init`, before `updateOverflowIcon`):

```javascript
    _applyPadding() {
        const pad = this._settings.get_int('icon-padding') / 2;
        this.set_style(`-natural-hpadding: ${pad}px; -minimum-hpadding: ${pad}px;`);
    }

```

- [ ] **Step 4: Add `_refreshPadding()` to the extension**

In `StatusTrayExtension`, add this method immediately after `_refreshIconSizes()` (which ends at line 2903):

```javascript
    _refreshPadding() {
        for (const [, item] of this._items)
            item._applyPadding();
        if (this._overflowButton)
            this._overflowButton._applyPadding();
    }

```

(Note: unlike `_refreshIconSizes`, this does **not** call `_applyOverflow()` — padding never changes overflow membership, and `_applyOverflow`/`updateOverflowIcon` only touch the overflow icon, not the button's own style, so the overflow button is repadded directly here.)

- [ ] **Step 5: Wire the `changed::icon-padding` signal**

In `enable()`'s `this._settings.connectObject(...)` block, add this handler immediately after the `changed::icon-size` handler (which ends at line 2681):

```javascript
            'changed::icon-padding', () => {
                debug('icon-padding setting changed');
                this._refreshPadding();
            },
```

- [ ] **Step 6: Static-verify the JS**

Run: `./validate.sh`
Expected: shexli runs and reports no errors on `src/` (exit status 0). This parses the JS and catches syntax errors and common extension mistakes.

- [ ] **Step 7: Behavioral check (manual)**

Install and run a nested shell:

```bash
./install.sh
dbus-run-session -- gnome-shell --nested --wayland
```

In the nested session, enable the extension, run a couple of SNI tray apps, then via a second terminal set values and confirm the panel gap changes live:

```bash
gsettings set org.gnome.shell.extensions.status-tray icon-padding 0    # icons flush
gsettings set org.gnome.shell.extensions.status-tray icon-padding 20   # wide gaps
gsettings set org.gnome.shell.extensions.status-tray icon-padding 5    # 2.5px/side, no breakage
gsettings reset org.gnome.shell.extensions.status-tray icon-padding    # back to 4 = today's look
```

Expected: the inter-icon gap changes immediately with each set, including the overflow button when overflow is enabled; `reset` (value 4) is visually identical to the current release.

- [ ] **Step 8: Commit**

```bash
git add src/extension.js
git commit -m "Apply configurable padding to tray and overflow buttons (#20)"
```

---

### Task 3: Add the prefs control

**Files:**
- Modify: `src/prefs.js` — Appearance group, after the `iconSizeRow` block (which ends `appearanceGroup.add(iconSizeRow);` at line 1681), before the `overflowGroup` (line 1683).

**Interfaces:**
- Consumes: `icon-padding` key; in-scope locals `appearanceGroup`, `this._settings`; imported `Adw`, `Gtk`.
- Produces: nothing consumed by other tasks (UI leaf).

- [ ] **Step 1: Add the padding row**

Insert this block immediately after `appearanceGroup.add(iconSizeRow);` (line 1681):

```javascript

        const iconPaddingRow = new Adw.ActionRow({
            title: 'Padding between icons',
            subtitle: 'Gap in pixels between adjacent tray icons',
        });

        const iconPaddingBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const iconPaddingScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 1,
                value: this._settings.get_int('icon-padding'),
            }),
            draw_value: false,
            round_digits: 0,
            hexpand: true,
            width_request: 160,
        });
        iconPaddingScale.add_mark(4, Gtk.PositionType.BOTTOM, 'Default');

        const iconPaddingValue = new Gtk.Label({
            label: `${this._settings.get_int('icon-padding')} px`,
            width_chars: 5,
            xalign: 0,
        });

        iconPaddingScale.connect('value-changed', () => {
            const px = Math.round(iconPaddingScale.get_value());
            iconPaddingValue.set_label(`${px} px`);
            if (this._settings.get_int('icon-padding') !== px)
                this._settings.set_int('icon-padding', px);
        });

        iconPaddingBox.append(iconPaddingScale);
        iconPaddingBox.append(iconPaddingValue);
        iconPaddingRow.add_suffix(iconPaddingBox);
        appearanceGroup.add(iconPaddingRow);
```

- [ ] **Step 2: Static-verify the JS**

Run: `./validate.sh`
Expected: shexli reports no errors on `src/` (exit status 0).

- [ ] **Step 3: Behavioral check (manual)**

Run: `./install.sh && gnome-extensions prefs status-tray@keithvassallo.com`
(Substitute the actual UUID from `src/metadata.json` if different.)
Expected: the Appearance group shows a "Padding between icons" row with a slider (0–20, "Default" mark at 4) and a live "N px" label; dragging it changes the gap in the panel in real time and the value persists across reopening prefs.

- [ ] **Step 4: Commit**

```bash
git add src/prefs.js
git commit -m "Add 'Padding between icons' control to prefs (#20)"
```

---

### Task 4: Documentation and changelog

**Files:**
- Modify: `docs/status-tray.md` — Settings Handlers block (lines 268–280).
- Modify: `changelog.md` — new section at the top (after the intro, before `## [1.13]` at line 7).

**Interfaces:**
- Consumes: names finalized in Task 2 (`_refreshPadding`).
- Produces: nothing.

- [ ] **Step 1: Document the settings handler**

In `docs/status-tray.md`, add a line to the Settings Handlers code block, immediately after the `'changed::icon-size'` line (line 272):

```javascript
'changed::icon-padding'            → _refreshPadding()
```

- [ ] **Step 2: Add a changelog entry**

In `changelog.md`, insert a new section between the intro (ends line 5) and `## [1.13] - 2026-07-12` (line 7):

```markdown
## [Unreleased]

### Added
- Padding between icons setting under Appearance: a slider from 0px to 20px (default 4px) controlling the gap between adjacent tray icons. The value is the total gap between two icons; both the inline tray icons and the overflow button re-space live. Thanks to [@zamszowy](https://github.com/zamszowy) for the request (#20).

```

- [ ] **Step 3: Verify docs still validate**

Run: `./validate.sh`
Expected: exit status 0 (docs are not scanned by shexli, but this confirms nothing in `src/` regressed; it is the project's single validation gate).

- [ ] **Step 4: Commit**

```bash
git add docs/status-tray.md changelog.md
git commit -m "Document icon-padding setting (#20)"
```

---

## Self-Review

**Spec coverage:**
- Setting `icon-padding` (type/default/range) → Task 1. ✓
- Apply as `gap/2` per side on each TrayItem via inline `set_style` → Task 2 Steps 1–2. ✓
- Overflow button participates → Task 2 Step 3. ✓
- Live update via `changed::icon-padding` → `_refreshPadding()` → Task 2 Steps 4–5. ✓
- Prefs control "Padding between icons" / subtitle → Task 3. ✓
- Stylesheet left as-is (fallback) → Global Constraints; no task modifies it. ✓
- Fractional per-side (odd values) → covered by verification Task 2 Step 7 (value 5). ✓
- Edge behaviour is documented as expected (no code needed). ✓
- Out-of-scope items (per-app, vertical, separate edge control) → no tasks, correctly omitted. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every verify step shows the exact command and expected result. ✓

**Type consistency:** `_applyPadding()` (both classes), `_refreshPadding()`, and key name `icon-padding` are used identically across Tasks 1–4; the per-side formula `get_int('icon-padding') / 2` is identical in both `_applyPadding` bodies. ✓
