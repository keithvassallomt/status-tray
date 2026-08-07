# Keyboard Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-configurable keyboard shortcut (unbound by default) that opens the leftmost tray menu and gives it key focus, so the tray is reachable without a pointer (#22).

**Architecture:** A new `toggle-menu` GSettings key of type `as` is registered with `Main.wm.addKeybinding()` in `enable()` and removed with `Main.wm.removeKeybinding()` in `disable()`. The handler picks the leftmost visible non-passive `TrayItem` — falling back to the `OverflowButton` when every item is overflowed — and calls a new `toggleMenuWithKeyFocus()` method on it, which mirrors what GNOME Shell's own `Panel._toggleMenu()` does: `menu.toggle()` followed by `menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)`. Because `TrayItem` menus are rebuilt after an async DBusMenu round-trip that destroys the focused item, `TrayItem` arms a `_focusOnOpen` flag that re-runs `navigate_focus()` once the real layout lands. Left/Right navigation between the resulting menus already works — `PanelMenu.Button._onMenuKeyPress()` provides it. A prefs `Adw.ActionRow` with a `Gtk.ShortcutLabel` opens an `Adw.Dialog` that captures a key combination and writes the key.

**Tech Stack:** Pure GJS GNOME Shell extension (GObject/St/Clutter, `PanelMenu.Button`), GSettings/GSchema, Adwaita/Gtk4 prefs. No npm, no bundler.

## Global Constraints

- **No automated behavioural test harness exists** (pure GJS). "Verify" steps use `glib-compile-schemas` for schema validity, `./validate.sh` (shexli static analysis — the same check as EGO submission) for JS, and a manual nested-shell run for behaviour. Do **not** invent a unit-test framework.
- Setting `toggle-menu`, type `as`, default `[]` (unbound). Shipping a bound default is not acceptable — any value we pick collides with someone's setup, and EGO reviewers reject extensions that grab keys uninvited. An empty list disables the binding, which is Mutter's documented behaviour for `meta_display_add_keybinding()`.
- **No `changed::toggle-menu` handler and no Settings Handlers doc entry.** `meta_prefs_add_keybinding()` connects to the settings `changed` signal itself, so the binding tracks the key live. Adding our own handler would be dead code.
- Every API used here is verified against GNOME Shell 45.0 and 50.0 (`js/ui/panel.js`, `js/ui/panelMenu.js`, `js/ui/windowManager.js`), Mutter 50.0 (`src/core/keybindings.c`, `src/core/prefs.c`), and the installed GTK4/Adwaita GIRs. Do not substitute an API that has not been checked the same way.
- `Meta` and `Shell` are imported in `extension.js` only; `Gtk`, `Gdk` and `Adw` in `prefs.js` only. Mixing the two sets is an automatic EGO rejection.
- `Main.panel._toggleMenu()` is private Shell API. Do **not** call it — the two lines it contains are reproduced directly instead.
- Add no `debug()` calls beyond the ones this plan specifies (none). The journal is for errors, and leftover debug output is grounds for rejection.
- No try/catch is added anywhere in this change. Nothing on these paths throws.
- Do not use `Adw.AlertDialog` (libadwaita 1.5+, absent on GNOME 45/46) or `Adw.MessageDialog` (deprecated since 1.6). `Adw.Dialog` is what the existing `IconPickerDialog` and `IconEffectDialog` use — follow that.

---

### Task 1: Add the `toggle-menu` GSettings key

**Files:**
- Modify: `src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml` (after the `click-action` key)

**Interfaces:**
- Consumes: nothing.
- Produces: GSettings key `toggle-menu` (type `as`, default `[]`), read by Mutter via `Main.wm.addKeybinding()` and written by prefs via `set_strv()`.

- [ ] **Step 1: Add the key**

Insert immediately after the closing `</key>` of the `click-action` key, before the `app-order` key:

```xml
    <key name="toggle-menu" type="as">
      <default>[]</default>
      <summary>Shortcut to open the tray menu</summary>
      <description>Keyboard shortcut that opens the leftmost tray icon's menu and moves key focus into it, so the tray can be reached without a pointer. Left and Right then move between the open menus. An empty list means no shortcut is bound.</description>
    </key>
```

- [ ] **Step 2: Verify the schema compiles**

```bash
glib-compile-schemas --strict --dry-run src/schemas/
```

Expect no output. Then confirm the key reads back as an empty array:

```bash
glib-compile-schemas src/schemas/ && \
  GSETTINGS_SCHEMA_DIR=src/schemas gsettings get org.gnome.shell.extensions.status-tray toggle-menu
```

Expect `@as []`. Remove the compiled artifact afterwards (`rm -f src/schemas/gschemas.compiled`) — `validate.sh` flags it as an unnecessary shipped file.

---

### Task 2: Add keyboard-focus menu toggling to `TrayItem` and `OverflowButton`

**Files:**
- Modify: `src/extension.js` (`TrayItem._init`, `TrayItem._fetchMenuLayout`, new `TrayItem.toggleMenuWithKeyFocus`, new `OverflowButton.toggleMenuWithKeyFocus`)

**Interfaces:**
- Consumes: `St.DirectionType`, `PopupMenu.PopupMenu.actor`, both already available.
- Produces: `toggleMenuWithKeyFocus()` on both panel-button classes.

- [ ] **Step 1: Initialise the re-focus flag in `TrayItem._init`**

`this.menu.addMenuItem(this._loadingItem);` is followed by the `open-state-changed` connection. Add the flag before that connection and clear it when the menu closes, so an aborted open can't leave it armed:

```javascript
        this._focusOnOpen = false;

        this._menuOpenStateId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            debug(`Menu open-state-changed: isOpen=${isOpen}, busName=${this._busName}`);
            if (isOpen)
                this._loadMenu();
            else
                this._focusOnOpen = false;
        });
```

The `debug()` line and the `_loadMenu()` call are existing code — only the surrounding structure changes.

- [ ] **Step 2: Re-focus after the layout swap in `_fetchMenuLayout`**

`_fetchMenuLayout` calls `targetMenu.removeAll()` and rebuilds, which destroys whatever `navigate_focus()` picked when the menu opened. In the `GetLayout` reply callback, immediately after `this._buildMenuFromLayout(layout, targetMenu);`:

```javascript
                    if (this._focusOnOpen && targetMenu === this.menu) {
                        this._focusOnOpen = false;
                        this.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
                    }
```

The `targetMenu === this.menu` test matters: `_loadMenu()` is also called with an `OverflowButton` submenu as `targetMenu`, and that path must not steal focus.

- [ ] **Step 3: Add `TrayItem.toggleMenuWithKeyFocus()`**

Place it after `_clearClickTimeout()` and before `_iconCoords()`:

```javascript
    toggleMenuWithKeyFocus() {
        // The DBusMenu round-trip in _loadMenu replaces every item, destroying
        // whatever is focused here; _fetchMenuLayout focuses again once the
        // real layout arrives.
        this._focusOnOpen = !this.menu.isOpen;
        this.menu.toggle();
        if (this.menu.isOpen)
            this.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }
```

Focusing here as well as after the rebuild is deliberate, not redundant: it puts focus on the placeholder so Escape and Left/Right work during the round-trip.

- [ ] **Step 4: Add `OverflowButton.toggleMenuWithKeyFocus()`**

Place it after `setOverflowedItems()`:

```javascript
    toggleMenuWithKeyFocus() {
        this.menu.toggle();
        if (this.menu.isOpen)
            this.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }
```

No re-focus flag here — `setOverflowedItems()` populates the top-level rows synchronously, so they already exist when the menu opens. Only each row's submenu loads lazily, and that happens on user action.

---

### Task 3: Register the keybinding

**Files:**
- Modify: `src/extension.js` (imports, `StatusTrayExtension.enable`, `StatusTrayExtension.disable`, new `_keyboardTarget`)

**Interfaces:**
- Consumes: `toggle-menu` GSettings key from Task 1; `toggleMenuWithKeyFocus()` from Task 2.
- Produces: nothing further.

- [ ] **Step 1: Add the `Meta` and `Shell` imports**

The `gi://` import block is alphabetical. Insert between `GObject` and `St`:

```javascript
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
```

- [ ] **Step 2: Add `_keyboardTarget()` to `StatusTrayExtension`**

Place it directly above `_calculatePosition()`:

```javascript
    _keyboardTarget() {
        for (const trayItem of this._items.values()) {
            if (trayItem._isPassive)
                continue;
            const container = trayItem.container || trayItem;
            if (container.visible)
                return trayItem;
        }
        return this._overflowButton;
    }
```

`this._items` is kept in panel order by `_reorderItems()`, so the first match is the leftmost icon. When `overflow-inline-count` is `0` every item is hidden by `_applyOverflow()` and the loop falls through to the overflow button, which is then the only visible tray element. The `_isPassive` skip and the `trayItem.container || trayItem` fallback both match `_applyOverflow()`.

- [ ] **Step 3: Register the binding in `enable()`**

After the `this._settings.connectObject(...)` block and before `this._watcher = new StatusNotifierWatcher(this);`:

```javascript
        Main.wm.addKeybinding(
            'toggle-menu',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._keyboardTarget()?.toggleMenuWithKeyFocus()
        );
```

The flags and action modes match what GNOME Shell uses for its own `toggle-message-tray` and `toggle-quick-settings` bindings. `POPUP` is required for the toggle to close the menu: without it the shortcut is swallowed while a popup menu holds the grab.

- [ ] **Step 4: Remove the binding in `disable()`**

As the first statement of `disable()`, after the opening `debug()` call and before the watcher teardown:

```javascript
        Main.wm.removeKeybinding('toggle-menu');
```

It must run before `this._settings = null`, and removing it first stops the shortcut firing into a half-torn-down extension.

- [ ] **Step 5: Verify**

```bash
./validate.sh
```

Then install and restart the shell (`./install.sh`; on Wayland, log out and back in), set a shortcut with `gsettings`, and check the behaviour:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com/schemas \
  set org.gnome.shell.extensions.status-tray toggle-menu "['<Super><Alt>t']"
```

Confirm, with at least two tray apps running:
- the shortcut opens the leftmost tray menu with its first item focused;
- Down/Up move within the menu, Left/Right move to the adjacent tray menus, Escape closes;
- pressing the shortcut again while the menu is open closes it;
- the focused item survives the `Loading...` swap on a slow app (Steam is the usual worst case);
- with `overflow-enabled true` and `overflow-inline-count 0`, the shortcut opens the overflow menu;
- with no tray apps running, the shortcut does nothing and logs nothing;
- clearing the key back to `[]` unbinds it without needing a shell restart;
- disabling the extension releases the shortcut (the key does nothing afterwards).

---

### Task 4: Add the prefs shortcut row

**Files:**
- Modify: `src/prefs.js` (new `ShortcutDialog` class, new row in `fillPreferencesWindow`)

**Interfaces:**
- Consumes: `toggle-menu` GSettings key from Task 1.
- Produces: `ShortcutDialog`, emitting `shortcut-selected(string)` — an accelerator name, or `''` to unbind.

- [ ] **Step 1: Add the `ShortcutDialog` class**

Place it after `IconEffectDialog`, following that class's registration shape:

```javascript
const ShortcutDialog = GObject.registerClass({
    Signals: {
        'shortcut-selected': { param_types: [GObject.TYPE_STRING] },
    },
}, class ShortcutDialog extends Adw.Dialog {
    _init() {
        super._init({
            title: 'Set Shortcut',
            content_width: 400,
            content_height: 220,
        });

        this.set_child(new Adw.StatusPage({
            title: 'Press a key combination',
            description: 'Press Esc to cancel, or Backspace to remove the shortcut.',
        }));

        // Capture phase, so the dialog sees the key before any focused widget
        // consumes it.
        const controller = new Gtk.EventControllerKey();
        controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) =>
            this._onKeyPressed(keyval, state));
        this.add_controller(controller);
    }

    _onKeyPressed(keyval, state) {
        const mods = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Escape && mods === 0) {
            this.close();
            return Gdk.EVENT_STOP;
        }

        if (keyval === Gdk.KEY_BackSpace && mods === 0) {
            this.emit('shortcut-selected', '');
            this.close();
            return Gdk.EVENT_STOP;
        }

        // Modifier-only presses and unusable combinations land here; swallow
        // them and keep waiting rather than closing on a half-typed shortcut.
        // accelerator_valid accepts an unmodified letter, which once bound
        // would swallow that key desktop-wide, so a modifier is required too.
        if (mods === 0 || !Gtk.accelerator_valid(keyval, mods))
            return Gdk.EVENT_STOP;

        this.emit('shortcut-selected', Gtk.accelerator_name(keyval, mods));
        this.close();
        return Gdk.EVENT_STOP;
    }
});
```

- [ ] **Step 2: Add the row to the Appearance & Behaviour group**

In `fillPreferencesWindow`, after the `clickActionRow` is added to `appearanceGroup`:

```javascript
        const shortcutRow = new Adw.ActionRow({
            title: 'Open Menu Shortcut',
            subtitle: 'Opens the leftmost tray menu and focuses it. Left and Right move between menus. Not checked against shortcuts used elsewhere.',
            activatable: true,
        });

        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        shortcutRow.add_suffix(shortcutLabel);

        const syncShortcutLabel = () => {
            shortcutLabel.accelerator = this._settings.get_strv('toggle-menu')[0] ?? '';
        };
        syncShortcutLabel();

        shortcutRow.connect('activated', () => {
            const dialog = new ShortcutDialog();
            dialog.connect('shortcut-selected', (_dialog, accel) => {
                this._settings.set_strv('toggle-menu', accel ? [accel] : []);
                syncShortcutLabel();
            });
            dialog.present(this._window);
        });
        appearanceGroup.add(shortcutRow);
```

The subtitle states the lack of conflict checking because GTK gives no API to detect a clash with a system or third-party shortcut; a collision silently loses, and the user needs to know that.

`Gtk.ShortcutLabel` shows `disabled_text` whenever `accelerator` is empty, so the unbound state needs no extra branch.

- [ ] **Step 3: Do not extend `_cleanup()`**

Nothing added here holds a process-level resource. The dialog is destroyed on close and owns its controller; the row and its signals are owned by the preferences window. Do not add teardown for them.

- [ ] **Step 4: Verify**

```bash
./validate.sh
```

Then open the preferences (`gnome-extensions prefs status-tray@keithvassallo.com`) and confirm:
- the row shows "Disabled" on a fresh profile;
- clicking it opens the capture dialog; a combination is accepted and rendered in the row;
- Esc cancels without changing the setting;
- Backspace clears it back to "Disabled" and writes `[]`;
- pressing only Ctrl or only Shift does nothing until a real key follows;
- the value round-trips through `gsettings get`;
- the new shortcut takes effect without restarting the shell.

---

### Task 5: Update documentation and metadata

**Files:**
- Modify: `changelog.md`, `README.md`, `docs/status-tray.md`, `src/metadata.json`

**Interfaces:**
- Consumes: the behaviour implemented in Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Changelog**

Under `## [Unreleased]`, add an `### Added` section **above** the existing `### Fixed` section:

```markdown
### Added
- Open Menu Shortcut setting under Appearance & Behaviour: an optional keyboard shortcut that opens the leftmost tray icon's menu and moves key focus into it, so the tray is reachable without a pointer. Left and Right then move between the open tray menus, and pressing the shortcut again closes the menu. When every icon is collapsed into the overflow button, the shortcut opens that instead. No shortcut is bound by default, and clashes with shortcuts used elsewhere are not detected. Thanks to [@weierophinney](https://github.com/weierophinney) for the request (#22).
```

- [ ] **Step 2: README feature list**

Add to the `## Features` list, after the "Configurable Click Action" bullet:

```markdown
- **Keyboard Shortcut** - Optionally open and focus the tray menu without a pointer
```

- [ ] **Step 3: Developer docs — schema table**

In `docs/status-tray.md`, add a row to the GSettings Schema table after `click-action`:

```markdown
| `toggle-menu` | `as` | `[]` | Keyboard shortcut that opens the leftmost visible tray menu and focuses it, falling back to the overflow button when every item is overflowed; empty means unbound |
```

- [ ] **Step 4: Developer docs — lifecycle table**

In the StatusTrayExtension Lifecycle Methods table, add after `_applyOverflow()`:

```markdown
| `_keyboardTarget()` | Leftmost visible non-passive item, or the overflow button, for the `toggle-menu` shortcut |
```

Update the `enable()` and `disable()` descriptions to mention registering and removing the keybinding. Add **no** entry to the Settings Handlers block — see the global constraints.

- [ ] **Step 5: Bump `version-name`**

In `src/metadata.json`, set `"version-name": "1.15"`. Leave `version` alone; EGO manages it.

- [ ] **Step 6: Final validation**

```bash
./validate.sh
```

Expect a clean run. Confirm `git status` shows only the five source/doc files this plan touches and no `gschemas.compiled`.
