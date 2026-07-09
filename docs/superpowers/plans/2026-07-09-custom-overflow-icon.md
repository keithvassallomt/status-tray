# Custom Overflow Button Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set a custom icon (theme icon name or image file) for the panel overflow button, selected via a new "Custom icon" option in the extension preferences.

**Architecture:** Add a `custom` value to the existing `overflow-icon-style` enum plus a new `overflow-custom-icon` string key. The extension's `OverflowButton` renders the custom icon (falling back to the bundled glyph when unset/missing). Prefs adds a "Custom icon" dropdown entry and a reveal row whose picker button opens the existing `IconPickerDialog` in a new parameterized "simple" mode.

**Tech Stack:** GJS (GNOME Shell 45–50), GObject, St/Clutter (extension), GTK4/Adwaita (prefs), GSettings/GVariant.

## Global Constraints

- Pure GJS — no npm, no bundler, no transpile step. Edit `src/` files directly.
- **This project has no unit-test harness.** Verification per task = (1) static analysis via `./validate.sh` (shexli, the same check EGO runs) must pass clean, and (2) a described manual smoke test. There is no pytest/jest; do not invent one.
- Schema changes must compile: `glib-compile-schemas --strict --dry-run src/schemas/` must exit 0.
- Custom-icon storage convention matches `icon-overrides`: a single string that is **either a theme icon name or an absolute file path**, distinguished by a leading `/`.
- Follow existing code style in each file (4-space indent, existing quoting, `debug(...)` for logging in extension.js).
- The custom icon is rendered **WYSIWYG** — no forced symbolic recoloring.
- `custom` is a fourth, mutually-exclusive overflow style: when selected it always shows the custom icon and never the dynamic mosaic.

---

## File Structure

- `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` — add `custom` enum choice + `overflow-custom-icon` key. (Task 1)
- `src/extension.js` — `OverflowButton._buildCustomIcon()`, `updateOverflowIcon()` branch, `_getOverflowIconStyle()` whitelist, new settings watcher. (Task 2)
- `src/prefs.js` — `IconPickerDialog` simple mode (Task 3); overflow-group dropdown entry + reveal row (Task 4).
- `docs/status-tray.md`, `docs/changelog.md` — documentation. (Task 5)

Tasks are ordered so each builds on the last: schema → extension rendering → dialog plumbing → prefs UI → docs. Task 4 depends on Task 3's `IconPickerDialog` simple-mode signature.

---

## Task 1: Schema — add `custom` style + `overflow-custom-icon` key

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml:72-81` (enum) and after line 81 (new key)

**Interfaces:**
- Consumes: nothing.
- Produces: GSettings key `overflow-custom-icon` (type `s`, default `''`); `overflow-icon-style` now accepts `'custom'`.

- [ ] **Step 1: Add the `custom` choice and the new key**

In `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`, replace the `overflow-icon-style` key block (lines 72-81) with the version below (adds the `custom` choice and extends the description), and add the new `overflow-custom-icon` key immediately after it:

```xml
    <key name="overflow-icon-style" type="s">
      <choices>
        <choice value="static"/>
        <choice value="dynamic-original"/>
        <choice value="dynamic-symbolic"/>
        <choice value="custom"/>
      </choices>
      <default>'static'</default>
      <summary>Overflow icon style</summary>
      <description>How to render the overflow button in the panel. 'static' uses the bundled tray glyph; 'dynamic-original' previews up to four hidden tray icons in their original colours; 'dynamic-symbolic' previews them recoloured to monochrome with a separating outline; 'custom' uses the icon set in overflow-custom-icon.</description>
    </key>

    <key name="overflow-custom-icon" type="s">
      <default>''</default>
      <summary>Custom overflow icon</summary>
      <description>Icon for the overflow button when overflow-icon-style is 'custom'. Either a theme icon name or an absolute file path (a leading '/' selects file mode). When empty or pointing at a missing file, the bundled glyph is used instead.</description>
    </key>
```

- [ ] **Step 2: Verify the schema compiles**

Run: `glib-compile-schemas --strict --dry-run src/schemas/`
Expected: no output, exit code 0. (Any typo in the XML prints an error and exits non-zero.)

- [ ] **Step 3: Run static analysis**

Run: `./validate.sh`
Expected: shexli completes with no errors (schema build artifact is auto-removed by the script).

- [ ] **Step 4: Commit**

```bash
git add src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml
git commit -m "Overflow: add 'custom' icon style and overflow-custom-icon key"
```

---

## Task 2: Extension — render the custom overflow icon

**Files:**
- Modify: `src/extension.js` — `OverflowButton.updateOverflowIcon()` (1838-1851), `_getOverflowIconStyle()` (1869-1880), add `_buildCustomIcon()` (after `_buildStaticIcon()` at 1895), settings watcher (after 2687)

**Interfaces:**
- Consumes: `this._settings` (`overflow-custom-icon`, `overflow-icon-style`, `icon-size`, `icon-mode`); existing `this._buildStaticIcon()`, `this._setIconActor(actor)`, `this._buildDynamicIcon(style)`.
- Produces: `_buildCustomIcon()` returning an `St.Icon`; `updateOverflowIcon()` handles `'custom'`.

- [ ] **Step 1: Whitelist `'custom'` in `_getOverflowIconStyle()`**

In `src/extension.js`, in `_getOverflowIconStyle()` (line 1871), replace the whitelist condition so `'custom'` is returned as-is instead of falling through to `'static'`:

```js
        if (style === 'static' || style === 'dynamic-original' ||
            style === 'dynamic-symbolic' || style === 'custom')
            return style;
```

- [ ] **Step 2: Branch `updateOverflowIcon()` for custom**

Replace the body of `updateOverflowIcon()` (lines 1844-1850, after the `_iconUpdateSourceId` guard) with:

```js
        const style = this._getOverflowIconStyle();
        if (style === 'custom') {
            this._setIconActor(this._buildCustomIcon());
            return;
        }
        if (style !== 'static' && this._overflowedItems.length > 0) {
            this._setIconActor(this._buildDynamicIcon(style));
            return;
        }

        this._setIconActor(this._buildStaticIcon());
```

The custom branch comes **before** the `style !== 'static'` dynamic branch, so custom never falls into the mosaic path.

- [ ] **Step 3: Add `_buildCustomIcon()`**

Insert this method immediately after `_buildStaticIcon()` (after line 1895):

```js
    _buildCustomIcon() {
        const value = this._settings.get_string('overflow-custom-icon');
        if (!value)
            return this._buildStaticIcon();

        const sizeStyle = `icon-size: ${this._settings.get_int('icon-size')}px;`;
        if (value.startsWith('/')) {
            const file = Gio.File.new_for_path(value);
            if (!file.query_exists(null)) {
                debug(`Custom overflow icon path missing: ${value}`);
                return this._buildStaticIcon();
            }
            return new St.Icon({
                style_class: 'system-status-icon status-tray-icon',
                style: sizeStyle,
                gicon: new Gio.FileIcon({ file }),
            });
        }
        return new St.Icon({
            style_class: 'system-status-icon status-tray-icon',
            style: sizeStyle,
            icon_name: value,
        });
    }
```

- [ ] **Step 4: Watch `overflow-custom-icon` for live updates**

In the settings-watcher block, immediately after the `'changed::overflow-icon-style'` handler (ends line 2687), add:

```js
            'changed::overflow-custom-icon', () => {
                debug('overflow-custom-icon setting changed');
                this._applyOverflow();
            },
```

`_applyOverflow()` calls `updateOverflowIcon()` on the existing button (extension.js:3060), so the glyph refreshes live.

- [ ] **Step 5: Run static analysis**

Run: `./validate.sh`
Expected: no errors.

- [ ] **Step 6: Manual smoke test**

```bash
./install.sh
```
Then reload GNOME Shell (Xorg: Alt+F2 → `r` → Enter; Wayland: log out/in). Enable the extension, then:

```bash
gsettings set org.gnome.shell.extensions.status-tray overflow-enabled true
gsettings set org.gnome.shell.extensions.status-tray overflow-inline-count 0
gsettings set org.gnome.shell.extensions.status-tray overflow-icon-style custom
gsettings set org.gnome.shell.extensions.status-tray overflow-custom-icon 'firefox'
```
Expected: with at least one tray app running, the overflow button shows the `firefox` theme icon. Then:
```bash
gsettings set org.gnome.shell.extensions.status-tray overflow-custom-icon ''
```
Expected: the overflow button falls back to the bundled glyph (no empty/broken button).

- [ ] **Step 7: Commit**

```bash
git add src/extension.js
git commit -m "Overflow: render custom overflow icon with bundled-glyph fallback"
```

---

## Task 3: Prefs — `IconPickerDialog` simple mode

**Files:**
- Modify: `src/prefs.js` — `IconPickerDialog._init` (611-835), `_selectIcon` (960-976), `_clearOverride` (1006-1037)

**Interfaces:**
- Consumes: existing `IconPickerDialog` internals (`_previewImage`, `_previewRow`, `_iconGrid`, `_selectIcon`, `_clearOverride`, `Signals: icon-selected`).
- Produces: `IconPickerDialog` accepts an optional 7th positional arg `options` = `{ simpleKey, title }`. When `simpleKey` is set, the dialog reads/writes `settings.get_string(simpleKey)` / `set_string(simpleKey, …)` instead of `icon-overrides[appId]`, and omits the per-app fallback/lock/alias rows.

- [ ] **Step 1: Accept and store the `options` arg; set title**

Change the `_init` signature (line 611) and the `super._init` title. Replace lines 611-624 with:

```js
    _init(appId, displayName, currentIconName, currentIconGicon, settings, parentWindow, options = null) {
        const simpleKey = options?.simpleKey ?? null;
        super._init({
            title: options?.title ?? `Icon for ${displayName}`,
            content_width: 450,
            content_height: 700,
        });

        this._appId = appId;
        this._displayName = displayName;
        this._settings = settings;
        this._currentIconName = currentIconName;
        this._currentIconGicon = currentIconGicon;
        this._parentWindow = parentWindow;
        this._simpleKey = simpleKey;
        this._allIcons = [];  // Cache of discovered icons
```

- [ ] **Step 2: Add a path-aware preview helper**

Add this method just before `_selectIcon` (before line 960). It sets a `Gtk.Image` from a stored value that may be a name or an absolute path:

```js
    _setPreviewFromValue(value) {
        if (value && value.startsWith('/')) {
            this._previewImage.set_from_gicon(
                new Gio.FileIcon({ file: Gio.File.new_for_path(value) }));
        } else if (value) {
            this._previewImage.set_from_icon_name(value);
        } else {
            this._previewImage.set_from_icon_name('application-x-executable-symbolic');
        }
    }
```

- [ ] **Step 3: Build the preview from the simple key when in simple mode**

Replace the current-override preview block (lines 649-674) so simple mode reads its own key and skips the "Custom override" wording. Replace lines 649-674 with:

```js
        const overrides = settings.get_value('icon-overrides').deep_unpack();
        const currentOverride = simpleKey
            ? (settings.get_string(simpleKey) || null)
            : (overrides[appId] || null);

        this._previewImage = new Gtk.Image({
            pixel_size: 48,
        });
        if (currentOverride) {
            this._setPreviewFromValue(currentOverride);
        } else if (currentIconGicon) {
            // Mirror what's rendered on the AppRow — handles file-backed
            // icons (IconPixmap via temp file, custom path overrides) that
            // can't be resolved by name.
            this._previewImage.set_from_gicon(currentIconGicon);
        } else if (currentIconName) {
            this._previewImage.set_from_icon_name(currentIconName);
        } else {
            this._previewImage.set_from_icon_name('application-x-executable-symbolic');
        }

        const previewRow = new Adw.ActionRow({
            title: currentOverride ? this._getIconDisplayName(currentOverride) : 'Default',
            subtitle: currentOverride
                ? (simpleKey ? 'Custom icon' : 'Custom override')
                : (simpleKey ? 'Using the default glyph' : 'Using app-provided icon'),
        });
        previewRow.add_prefix(this._previewImage);
        previewGroup.add(previewRow);
        this._previewRow = previewRow;
```

Note: `_setPreviewFromValue` is defined in Step 2 but used here; that is fine — it is a method on the class, resolved at call time, not at definition order.

- [ ] **Step 4: Skip the per-app fallback/lock/alias rows in simple mode**

Wrap the fallback/lock/alias row construction (the block from line 676 `const fallbackApps = ...` through line 750, the end of the `_aliasRow` handler) in `if (!simpleKey) { ... }`. Concretely, insert `if (!simpleKey) {` before line 676 and its closing `}` after line 750 (after the `_aliasRow` `connect` block's closing `});`).

Because `_selectIcon` and `_clearOverride` reference `this._fallbackRow` / `this._lockRow`, guard those references in the next steps rather than creating the rows.

- [ ] **Step 5: Branch `_selectIcon` for simple mode**

Replace `_selectIcon` (lines 960-976) with:

```js
    _selectIcon(iconName) {
        if (this._simpleKey) {
            this._settings.set_string(this._simpleKey, iconName);
            this._setPreviewFromValue(iconName);
            this._previewRow.set_title(this._getIconDisplayName(iconName));
            this._previewRow.set_subtitle('Custom icon');
            this.emit('icon-selected', iconName);
            return;
        }

        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        overrides[this._appId] = iconName;
        this._settings.set_value('icon-overrides', new GLib.Variant('a{ss}', overrides));

        this._previewImage.set_from_icon_name(iconName);
        this._previewRow.set_title(this._getIconDisplayName(iconName));
        this._previewRow.set_subtitle('Custom override');

        // Re-expose the per-override switches in case the user just hit Reset;
        // they're hidden by _clearOverride and need to come back when a new
        // override is chosen.
        this._fallbackRow.set_visible(true);
        this._lockRow.set_visible(true);

        this.emit('icon-selected', iconName);
    }
```

(The simple branch also fixes the file-path preview: `_setPreviewFromValue` handles the leading-`/` case, unlike the app branch's bare `set_from_icon_name`.)

- [ ] **Step 6: Branch `_clearOverride` for simple mode**

Replace `_clearOverride` (lines 1006-1037) with:

```js
    _clearOverride() {
        if (this._simpleKey) {
            this._settings.set_string(this._simpleKey, '');
            this._setPreviewFromValue('');
            this._previewRow.set_title('Default');
            this._previewRow.set_subtitle('Using the default glyph');
            this.emit('icon-selected', '');
            return;
        }

        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        delete overrides[this._appId];
        this._settings.set_value('icon-overrides', new GLib.Variant('a{ss}', overrides));

        const fallbackApps = this._settings.get_strv('icon-fallback-overrides');
        const index = fallbackApps.indexOf(this._appId);
        if (index > -1) {
            fallbackApps.splice(index, 1);
            this._settings.set_strv('icon-fallback-overrides', fallbackApps);
        }

        this._fallbackRow.set_active(false);
        this._fallbackRow.set_visible(false);

        const lockApps = this._settings.get_strv('icon-lock-overrides');
        const lockIndex = lockApps.indexOf(this._appId);
        if (lockIndex > -1) {
            lockApps.splice(lockIndex, 1);
            this._settings.set_strv('icon-lock-overrides', lockApps);
        }

        this._lockRow.set_active(false);
        this._lockRow.set_visible(false);

        const defaultIcon = this._currentIconName || 'application-x-executable-symbolic';
        this._previewImage.set_from_icon_name(defaultIcon);
        this._previewRow.set_title('Default');
        this._previewRow.set_subtitle('Using app-provided icon');

        this.emit('icon-selected', '');
    }
```

- [ ] **Step 7: Run static analysis**

Run: `./validate.sh`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/prefs.js
git commit -m "Prefs: add simple mode to IconPickerDialog for non-per-app keys"
```

---

## Task 4: Prefs — "Custom icon" dropdown entry + reveal row

**Files:**
- Modify: `src/prefs.js` — overflow group in `fillPreferencesWindow` (1645-1705)

**Interfaces:**
- Consumes: `IconPickerDialog(appId, displayName, currentIconName, currentIconGicon, settings, parentWindow, options)` with `options = { simpleKey: 'overflow-custom-icon', title: 'Custom overflow icon' }` (from Task 3); `this._settings`, `this._window`.
- Produces: user-facing UI. No new exported symbols.

- [ ] **Step 1: Add the "Custom icon" entry to the dropdown**

In the overflow model construction (lines 1650-1653), append a fourth entry. After line 1653 (`overflowIconModel.append('Dynamic preview (monochrome)');`) add:

```js
        overflowIconModel.append('Custom icon');
```

Then extend the value array (line 1669) to include `'custom'`:

```js
        const overflowIconValues = ['static', 'dynamic-original', 'dynamic-symbolic', 'custom'];
```

- [ ] **Step 2: Build the reveal row after the dropdown**

Immediately after `overflowGroup.add(overflowIconRow);` (line 1684), insert the reveal row, its preview, and the visibility/preview helpers:

```js
        const overflowCustomRow = new Adw.ActionRow({
            title: 'Custom overflow icon',
            subtitle: 'Using the default overflow glyph',
        });
        const overflowCustomPreview = new Gtk.Image({ pixel_size: 24 });
        overflowCustomRow.add_prefix(overflowCustomPreview);

        const overflowCustomButton = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        overflowCustomRow.add_suffix(overflowCustomButton);
        overflowCustomRow.set_activatable_widget(overflowCustomButton);
        overflowGroup.add(overflowCustomRow);

        const refreshOverflowCustomPreview = () => {
            const value = this._settings.get_string('overflow-custom-icon');
            if (!value) {
                overflowCustomPreview.set_from_icon_name('image-x-generic-symbolic');
                overflowCustomRow.set_subtitle('Using the default overflow glyph');
                return;
            }
            if (value.startsWith('/')) {
                overflowCustomPreview.set_from_gicon(
                    new Gio.FileIcon({ file: Gio.File.new_for_path(value) }));
            } else {
                overflowCustomPreview.set_from_icon_name(value);
            }
            overflowCustomRow.set_subtitle(value);
        };

        const updateOverflowCustomVisibility = () => {
            const isCustom =
                this._settings.get_string('overflow-icon-style') === 'custom';
            overflowCustomRow.set_visible(overflowEnabledRow.get_active() && isCustom);
        };

        refreshOverflowCustomPreview();
        updateOverflowCustomVisibility();

        overflowCustomButton.connect('clicked', () => {
            const dialog = new IconPickerDialog(
                null, 'Overflow Button', '', overflowCustomPreview.get_gicon(),
                this._settings, this._window,
                { simpleKey: 'overflow-custom-icon', title: 'Custom overflow icon' }
            );
            dialog.connect('icon-selected', () => refreshOverflowCustomPreview());
            dialog.present(this._window);
        });
```

- [ ] **Step 3: Recompute visibility when the style changes**

In the existing `overflowIconRow.connect('notify::selected', ...)` handler (lines 1680-1683), add a call to `updateOverflowCustomVisibility()` after the `set_string`. Replace the handler body with:

```js
        overflowIconRow.connect('notify::selected', () => {
            const selected = overflowIconRow.get_selected();
            this._settings.set_string('overflow-icon-style', overflowIconValues[selected] ?? 'static');
            updateOverflowCustomVisibility();
        });
```

- [ ] **Step 4: Recompute visibility when overflow is toggled**

In the second `overflowEnabledRow.connect('notify::active', ...)` handler (lines 1701-1704, the one that toggles sensitivity), add `updateOverflowCustomVisibility()`. Replace that handler with:

```js
        overflowEnabledRow.connect('notify::active', () => {
            overflowCountRow.set_sensitive(overflowEnabledRow.get_active());
            overflowIconRow.set_sensitive(overflowEnabledRow.get_active());
            updateOverflowCustomVisibility();
        });
```

Note: `overflowCountRow` is referenced here and is created just below at line 1686; this handler is defined at 1701 (after the row exists), so ordering is unchanged and valid. `updateOverflowCustomVisibility` and `overflowCountRow` are both in the same function scope.

- [ ] **Step 5: Run static analysis**

Run: `./validate.sh`
Expected: no errors.

- [ ] **Step 6: Manual smoke test**

```bash
./install.sh
```
Reload the shell, then open the extension preferences (`gnome-extensions prefs status-tray@keithvassallo` or via the Extensions app). In the **Panel Overflow** group:
- Enable overflow. The "Overflow button icon" dropdown now lists **Custom icon** as a fourth option.
- With Static/Dynamic selected, the "Custom overflow icon" row is hidden.
- Select **Custom icon** → the "Custom overflow icon" row appears. Click **Choose…** → the icon picker opens with **no** Fallback/Lock/Match-by-name rows, just the icon grid, search, "Choose File…", and "Reset to Default".
- Pick a theme icon → the row preview updates and (with a tray app overflowing) the panel overflow button shows it.
- Click **Choose File…**, pick a PNG/SVG → the row preview and panel button show the file.
- **Reset to Default** in the dialog → row shows "Using the default overflow glyph" and the panel button reverts to the bundled glyph.
- Disable overflow → the custom row hides.

- [ ] **Step 7: Commit**

```bash
git add src/prefs.js
git commit -m "Prefs: add Custom icon option and picker row for overflow button"
```

---

## Task 5: Documentation

**Files:**
- Modify: `docs/status-tray.md` (overflow section), `docs/changelog.md`

**Interfaces:** none.

- [ ] **Step 1: Locate the overflow docs**

Run: `grep -n -i "overflow" docs/status-tray.md`
Expected: the section describing the overflow button icon styles. Read that section to match its wording and format.

- [ ] **Step 2: Document the Custom icon option**

In `docs/status-tray.md`, in the overflow-button-icon description, add a sentence for the new option, matching the surrounding style. Use this content (adapt phrasing to the existing list format):

> **Custom icon** — use an icon you choose for the overflow button. Selecting this reveals a *Custom overflow icon* row; click **Choose…** to pick a theme icon or an image file (PNG/SVG). The icon is shown as-is at the configured icon size. If no icon is chosen (or the chosen file is missing), the default overflow glyph is used.

- [ ] **Step 3: Add a changelog entry**

In `docs/changelog.md`, add an entry under the current unreleased/next-version heading (match the file's existing format), e.g.:

```markdown
- Overflow button: added a **Custom icon** option to set your own icon (theme icon or image file) for the overflow button.
```

- [ ] **Step 4: Run static analysis**

Run: `./validate.sh`
Expected: no errors (docs are outside `src/`, but run it to confirm nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add docs/status-tray.md docs/changelog.md
git commit -m "Docs: document custom overflow button icon"
```

---

## Notes for the implementer

- **Line numbers drift.** After Task 2's insertions, later line references in `src/extension.js` shift; after Task 3's edits, Task 4's references in `src/prefs.js` shift. Anchor edits on the quoted code, not the raw line numbers.
- **`Gio` / `GLib` / `Adw` / `Gtk` imports** already exist at the top of both `src/extension.js` and `src/prefs.js`; no new imports are needed (`Gio.FileIcon`, `Gio.File`, `GLib.Variant`, `Gtk.Image`, `Gtk.Button` are all already used in these files).
- **`get_gicon()` may return null** when the preview shows an icon-name rather than a gicon — that is fine; `IconPickerDialog` treats a null `currentIconGicon` correctly (it falls through to `currentIconName` / default).
- **No behavior change for existing styles** — Static and both Dynamic modes must render exactly as before; only the new `custom` branch and the new prefs row are additive.
