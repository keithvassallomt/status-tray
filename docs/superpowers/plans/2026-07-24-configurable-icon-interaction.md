# Configurable Icon Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable left-click action (show menu / activate / double-click activate) for tray icons, with fixed right-click (menu) and middle-click (SecondaryActivate) behaviour and a graceful menu fallback for apps without a working Activate.

**Architecture:** A new `click-action` enum GSettings key drives an overridden `vfunc_event` on `TrayItem` that dispatches per mouse button and mode. Primary/secondary activation call the SNI `Activate`/`SecondaryActivate` D-Bus methods asynchronously via the codebase's existing `Gio.DBus.session.call` idiom; a per-item GLib timer disambiguates single vs double click in double-click mode. A prefs `Adw.ComboRow` writes the key.

**Tech Stack:** Pure GJS GNOME Shell extension (GObject/St/Clutter, `PanelMenu.Button`), GSettings/GSchema, Adwaita/Gtk4 prefs. No npm, no bundler.

## Global Constraints

- **No automated behavioural test harness exists** (pure GJS). "Verify" steps use `glib-compile-schemas` for schema validity, `./validate.sh` (shexli static analysis — the same check as EGO submission) for JS, and a manual nested-shell run for behaviour. Do **not** invent a unit-test framework.
- Follow existing patterns verbatim — `overflow-icon-style` is the reference for the enum + prefs ComboRow (including the long-label factory); `_activateMenuItem` is the reference for the D-Bus call idiom.
- Setting `click-action`, type `s`, `<choices>` `menu`|`activate`|`activate-double`, default `menu`. Default `menu` reproduces current behaviour exactly.
- The setting value is read fresh on each click event — there is **no** `changed::click-action` handler and **no** Settings Handlers doc entry. Do not add either.
- Right-click always toggles the menu; middle-click always calls `SecondaryActivate`; both in every mode.
- Primary activation falls back to the menu when `ItemIsMenu` is true or `Activate` errors. Middle-click has no fallback (does nothing on error).
- Touch and keyboard are not intercepted — they fall through to `super.vfunc_event` (menu).
- All D-Bus calls are async (`Gio.DBus.session.call`); never a `_sync` variant. The double-click GLib timer is stored per-item and removed in `destroy()` and when it fires.

---

### Task 1: Add the `click-action` GSettings key

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` (after the `icon-padding` key)

**Interfaces:**
- Consumes: nothing.
- Produces: GSettings key `click-action` (type `s`, default `'menu'`), read via `settings.get_string('click-action')`.

- [ ] **Step 1: Add the key**

Insert immediately after the closing `</key>` of the `icon-padding` key, before the `app-order` key:

```xml
    <key name="click-action" type="s">
      <choices>
        <choice value="menu"/>
        <choice value="activate"/>
        <choice value="activate-double"/>
      </choices>
      <default>'menu'</default>
      <summary>Tray icon click action</summary>
      <description>What a left click on a tray icon does. 'menu' shows the app menu (default). 'activate' opens the app window on left click and shows the menu on right click. 'activate-double' opens the app window on double click and shows the menu on single click. Right click always shows the menu; middle click always triggers the app's secondary action.</description>
    </key>
```

- [ ] **Step 2: Verify the schema compiles**

Run: `glib-compile-schemas --strict --dry-run src/schemas/`
Expected: no output, exit status 0.

- [ ] **Step 3: Commit**

```bash
git add src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml
git commit -m "Add click-action GSettings key (#19)"
```

---

### Task 2: Implement click dispatch and activation in `TrayItem`

**Files:**
- Modify: `src/extension.js` — SNI interface XML (`SNI_INTERFACE_XML`, ~line 207), `TrayItem._init` (~line 350), new methods before `TrayItem.destroy()` (~line 1785), and `destroy()` cleanup (~line 1786).

**Interfaces:**
- Consumes: `click-action` key from Task 1; existing `this._settings`, `this._proxy`, `this._busName`, `this._objectPath`, `this._cancellable`, `this.menu`; `Clutter`, `GLib`, `Gio` (already imported).
- Produces: overridden `vfunc_event(event)`; helpers `_clearClickTimeout()`, `_iconCoords()`, `_callSNIMethod(method, onError)`, `_primaryActivate()`, `_secondaryActivate()`; instance field `this._clickTimeoutId`.

- [ ] **Step 1: Confirm `ItemIsMenu` is already in the SNI interface XML**

`ItemIsMenu` is already declared in `SNI_INTERFACE_XML` (right after the `Menu`
property), so the proxy already caches it. No XML change is needed — verify the
line is present and do not add a duplicate. `_primaryActivate` (Step 3) reads
`get_cached_property('ItemIsMenu')`, which works against the existing
declaration.

- [ ] **Step 2: Initialise the click-timer field in `_init`**

In `TrayItem._init`, add the field right after the cancellable is created:

```javascript
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._clickTimeoutId = 0;
```

- [ ] **Step 3: Add the event override and activation helpers**

Insert this block immediately before `TrayItem`'s `destroy()` method (the one whose body starts `if (this._cancellable) {`), after `_activateMenuItem`'s closing brace:

```javascript
    vfunc_event(event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS)
            return super.vfunc_event(event);

        const button = event.get_button();

        if (button === Clutter.BUTTON_SECONDARY) {
            this.menu.toggle();
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_MIDDLE) {
            this._secondaryActivate();
            return Clutter.EVENT_STOP;
        }

        if (button !== Clutter.BUTTON_PRIMARY)
            return super.vfunc_event(event);

        const mode = this._settings.get_string('click-action');

        if (mode === 'menu')
            return super.vfunc_event(event);

        if (mode === 'activate') {
            this._primaryActivate();
            return Clutter.EVENT_STOP;
        }

        // 'activate-double': open on double click, menu on single click. The
        // single-click menu waits out the double-click interval so a second
        // press can cancel it.
        if (event.get_click_count() >= 2) {
            this._clearClickTimeout();
            this._primaryActivate();
        } else if (!this._clickTimeoutId) {
            const delay = Clutter.Settings.get_default().double_click_time;
            this._clickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._clickTimeoutId = 0;
                this.menu.toggle();
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_STOP;
    }

    _clearClickTimeout() {
        if (this._clickTimeoutId) {
            GLib.source_remove(this._clickTimeoutId);
            this._clickTimeoutId = 0;
        }
    }

    _iconCoords() {
        const [x, y] = this.get_transformed_position();
        return [Math.round(x), Math.round(y)];
    }

    _primaryActivate() {
        const isMenu = this._proxy?.get_cached_property('ItemIsMenu')?.deep_unpack() ?? false;
        if (isMenu) {
            this.menu.toggle();
            return;
        }
        this._callSNIMethod('Activate', () => this.menu.toggle());
    }

    _secondaryActivate() {
        this._callSNIMethod('SecondaryActivate', null);
    }

    _callSNIMethod(method, onError) {
        const [x, y] = this._iconCoords();
        Gio.DBus.session.call(
            this._busName,
            this._objectPath,
            'org.kde.StatusNotifierItem',
            method,
            new GLib.Variant('(ii)', [x, y]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                } catch (e) {
                    debug(`${method} failed for ${this._busName}: ${e}`);
                    if (onError)
                        onError();
                }
            }
        );
    }

```

- [ ] **Step 4: Clear the timer in `destroy()`**

In `TrayItem.destroy()`, add the timer cleanup right after the cancellable block:

```javascript
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        this._clearClickTimeout();

```

- [ ] **Step 5: Static-verify the JS**

Run: `./validate.sh`
Expected: shexli reports no errors on `src/` (exit status 0). If it fails only because it cannot reach the network to update shexli, note that and run `node --check src/extension.js` as a fallback syntax check.

- [ ] **Step 6: Behavioural check (manual — deferred to human)**

This requires a live GNOME session and cannot run headless. Note it as deferred. When run:

```bash
./install.sh
dbus-run-session -- gnome-shell --nested --wayland
```

With Slack or Teams-for-Linux running, for each `click-action` value set via `gsettings set org.gnome.shell.extensions.status-tray click-action <value>`:
- `menu`: left and right click both show the menu (matches current release).
- `activate`: left click raises the window; right click shows the menu; middle click triggers the app's secondary action.
- `activate-double`: single left click shows the menu after the double-click delay; double click raises the window; right click shows the menu instantly.
Then confirm an app with no working `Activate` (or one advertising `ItemIsMenu`) shows the menu instead of hanging, and that toggling the extension off with a pending timer produces no leftover-source warning.

- [ ] **Step 7: Commit**

```bash
git add src/extension.js
git commit -m "Add configurable click dispatch and SNI activation to tray items (#19)"
```

---

### Task 3: Add the prefs control and rename the group

**Files:**
- Modify: `src/prefs.js` — the appearance group title/description (lines 1611-1614) and a new `Adw.ComboRow` after the padding row (after `appearanceGroup.add(iconPaddingRow);`).

**Interfaces:**
- Consumes: `click-action` key; in-scope locals `appearanceGroup`, `this._settings`; imported `Adw`, `Gtk`.
- Produces: nothing consumed by other tasks (UI leaf).

- [ ] **Step 1: Rename the group to "Appearance & Behaviour"**

Change the `appearanceGroup` definition (lines 1611-1614):

```javascript
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance & Behaviour',
            description: 'Control how tray icons look and behave in the panel',
        });
```

- [ ] **Step 2: Add the "Icon interaction" combo**

Insert this block immediately after `appearanceGroup.add(iconPaddingRow);` (added in the #20 padding work). It follows the `overflow-icon-style` ComboRow pattern, including the non-ellipsising factory, because the labels are long:

```javascript

        const clickActionRow = new Adw.ComboRow({
            title: 'Icon interaction',
            subtitle: 'What clicking a tray icon does',
        });
        const clickActionModel = new Gtk.StringList();
        clickActionModel.append('Left click to show the menu (default)');
        clickActionModel.append('Left click to open app, right-click to show the menu');
        clickActionModel.append('Double-click to open the app, single-click to show the menu');
        clickActionRow.set_model(clickActionModel);

        // Adw.ComboRow's default factory ellipsizes long labels; a plain
        // Gtk.Label doesn't, so the row and popup size to the full text.
        const clickActionFactory = new Gtk.SignalListItemFactory();
        clickActionFactory.connect('setup', (_factory, item) => {
            item.set_child(new Gtk.Label({ xalign: 0 }));
        });
        clickActionFactory.connect('bind', (_factory, item) => {
            item.get_child().set_label(item.get_item().get_string());
        });
        clickActionRow.set_factory(clickActionFactory);

        const clickActionValues = ['menu', 'activate', 'activate-double'];
        const currentClickAction = this._settings.get_string('click-action');
        const clickActionIndex = clickActionValues.indexOf(currentClickAction);
        clickActionRow.set_selected(clickActionIndex < 0 ? 0 : clickActionIndex);

        clickActionRow.connect('notify::selected', () => {
            const selected = clickActionRow.get_selected();
            this._settings.set_string('click-action', clickActionValues[selected] ?? 'menu');
        });
        appearanceGroup.add(clickActionRow);
```

- [ ] **Step 3: Static-verify the JS**

Run: `./validate.sh`
Expected: shexli reports no errors on `src/` (exit status 0).

- [ ] **Step 4: Behavioural check (manual — deferred to human)**

Run: `./install.sh && gnome-extensions prefs status-tray@keithvassallo.com`
Expected: the group is titled "Appearance & Behaviour" and shows an "Icon interaction" row whose combo lists the three full-length labels (no truncation); selecting each writes the matching `click-action` value and persists across reopening prefs.

- [ ] **Step 5: Commit**

```bash
git add src/prefs.js
git commit -m "Add 'Icon interaction' control and rename Appearance group (#19)"
```

---

### Task 4: Documentation and changelog

**Files:**
- Modify: `docs/status-tray.md` — GSettings schema table (~line 596) and Preferences UI tree (~line 651).
- Modify: `changelog.md` — the existing `## [Unreleased]` section (added in the #20 work).

**Interfaces:**
- Consumes: names finalized in Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Add the schema-table row**

In `docs/status-tray.md`, add a row to the GSettings schema table immediately after the `icon-padding` row:

```markdown
| `click-action` | `s` | `'menu'` | Left-click behaviour: `'menu'` shows the app menu (default), `'activate'` opens the app window (menu on right click), `'activate-double'` opens the window on double click (menu on single click). Right click always shows the menu; middle click triggers `SecondaryActivate` |
```

- [ ] **Step 2: Add the prefs-tree entry**

In the Preferences UI component tree, add the interaction row after the padding row under the "Appearance" group, and update the group label to match the rename:

```
    ├── Adw.PreferencesGroup ("Appearance & Behaviour")
    │   ├── Icon Style (Adw.ComboRow) → icon-mode
    │   ├── Icon Size (Adw.ActionRow + Gtk.Scale) → icon-size
    │   ├── Padding between icons (Adw.ActionRow + Gtk.Scale) → icon-padding
    │   └── Icon interaction (Adw.ComboRow) → click-action
```

- [ ] **Step 3: Add the changelog entry**

In `changelog.md`, add a bullet under the existing `## [Unreleased]` / `### Added` section (created by the #20 work):

```markdown
- Icon interaction setting under Appearance & Behaviour: choose what a left click does — show the menu (default), open the app window (menu on right click), or open the app window on double click (menu on single click). Right click always shows the menu and middle click triggers the app's secondary action. Apps that expose no working activate action fall back to showing the menu. Thanks to [@zamszowy](https://github.com/zamszowy) for the request (#19).
```

- [ ] **Step 4: Verify nothing in `src/` regressed**

Run: `./validate.sh`
Expected: exit status 0 (docs are not scanned by shexli; this confirms the source is still clean).

- [ ] **Step 5: Commit**

```bash
git add docs/status-tray.md changelog.md
git commit -m "Document click-action setting (#19)"
```

---

## Self-Review

**Spec coverage:**
- `click-action` enum key (type/choices/default) → Task 1. ✓
- Button matrix (left by mode, right = menu, middle = SecondaryActivate) → Task 2 Step 3 `vfunc_event`. ✓
- Double-click timer + system double-click interval → Task 2 Step 3. ✓
- Timer lifecycle (init, clear-on-fire, clear-in-destroy) → Task 2 Steps 2, 3, 4. ✓
- `Activate`/`SecondaryActivate` async via existing idiom, coords from icon position → Task 2 Step 3. ✓
- Fallbacks: `ItemIsMenu` up front + `Activate` error → menu; middle-click no fallback → Task 2 Step 3. ✓
- `ItemIsMenu` read from the (pre-existing) interface XML → Task 2 Steps 1, 3. ✓
- Touch/keyboard fall through to menu → Task 2 Step 3 (only `BUTTON_PRESS` intercepted). ✓
- No `changed::click-action` handler → Global Constraints; no task adds one. ✓
- Prefs ComboRow with long-label factory + group rename → Task 3. ✓
- Docs (schema table, prefs tree) + changelog → Task 4. ✓
- Out-of-scope items (touch double-tap, per-app overrides, Scroll, overflow rows) → no tasks, correctly omitted. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every verify step shows the exact command and expected result. ✓

**Type consistency:** `click-action` (key), `_clickTimeoutId`, `_clearClickTimeout`, `_iconCoords`, `_callSNIMethod(method, onError)`, `_primaryActivate`, `_secondaryActivate`, and the `clickActionValues = ['menu','activate','activate-double']` index↔value map are used identically across Tasks 1-4. The enum values match between schema (Task 1), the `mode ===` checks (Task 2), and the prefs values array (Task 3). ✓
