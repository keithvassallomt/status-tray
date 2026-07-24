# Configurable Icon Interaction — Design

**Issue:** [#19](https://github.com/keithvassallomt/status-tray/issues/19) — *[feature request] open app on double click*

**Date:** 2026-07-24

## Summary

Today every click on a tray icon toggles the app's DBusMenu — the extension
never invokes the SNI `Activate` method, so there is no way to raise an app's
window from its tray icon. This feature adds a configurable left-click action,
plus fixed right-click (menu) and middle-click (`SecondaryActivate`) behaviour,
so users can open the app window instead of, or in addition to, the menu.

## User-facing behaviour

A new **"Icon interaction"** control (an `Adw.ComboRow`) is added to the prefs,
and the enclosing group is renamed **"Appearance" → "Appearance & Behaviour"**.
The combo offers three modes:

| Mode (label) | Left click | Double left-click | Right click | Middle click |
|---|---|---|---|---|
| Left click to show the menu (default) | Menu | — | Menu | SecondaryActivate |
| Left click to open app, right-click to show the menu | Activate | — | Menu | SecondaryActivate |
| Double-click to open the app, single-click to show the menu | Menu (delayed) | Activate | Menu | SecondaryActivate |

- **Right-click always shows the menu**, in every mode.
- **Middle-click always calls `SecondaryActivate`**, in every mode — it is
  orthogonal to the left-click mode, and middle-click did nothing before, so it
  is purely additive.
- The default mode (`menu`) reproduces the current behaviour exactly, so
  existing users see no change on upgrade.

**Known intrinsic tradeoff (double-click mode only):** the single-click menu
opens after the system double-click interval elapses (typically ~250–400 ms),
because a single click cannot be confirmed until the double-click window has
passed without a second press. This affects only the double-click mode; the
other two are instant.

## Setting

New GSettings key in
`src/schemas/org.gnome.shell.extensions.status-tray.gschema.xml`, mirroring the
`overflow-icon-style` `<choices>` enum:

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

Default `menu` preserves current behaviour. No live re-render is needed beyond
reading the key at click time, but a `changed::click-action` handler is not
required — the value is read fresh on each event, so changes take effect
immediately without any refresh wiring.

## Interaction implementation

All logic lives in `TrayItem`. `PanelMenu.Button` (the parent) overrides
`vfunc_event` to toggle its menu on any `BUTTON_PRESS`; `TrayItem` overrides
`vfunc_event` to take over button dispatch and delegate everything else to
`super.vfunc_event(event)`.

```js
vfunc_event(event) {
    if (event.type() !== Clutter.EventType.BUTTON_PRESS)
        return super.vfunc_event(event);

    const button = event.get_button();

    // Right click: menu, in every mode.
    if (button === Clutter.BUTTON_SECONDARY) {
        this.menu.toggle();
        return Clutter.EVENT_STOP;
    }

    // Middle click: secondary activate, in every mode.
    if (button === Clutter.BUTTON_MIDDLE) {
        this._secondaryActivate();
        return Clutter.EVENT_STOP;
    }

    if (button !== Clutter.BUTTON_PRIMARY)
        return super.vfunc_event(event);

    const mode = this._settings.get_string('click-action');

    // Default mode: identical to current behaviour — let the parent toggle.
    if (mode === 'menu')
        return super.vfunc_event(event);

    if (mode === 'activate') {
        this._primaryActivate();
        return Clutter.EVENT_STOP;
    }

    // mode === 'activate-double'
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
```

Notes:
- `Clutter.BUTTON_PRIMARY`/`MIDDLE`/`SECONDARY` are `1`/`2`/`3`.
- `event.get_click_count()` is Clutter's own double/triple-click counter, so we
  reuse the system's timing and position tolerance; the timer only exists to
  delay the single-click menu until a double-click can be ruled out.
- `this.menu.toggle()` reuses the existing lazy menu-load path
  (`open-state-changed` → `_loadMenu()`), so no menu-population code changes.
- **Touch and keyboard are intentionally not intercepted** — they fall through
  to `super.vfunc_event`, which shows the menu. This keeps the icon
  keyboard-accessible and avoids double-tap disambiguation. Documented as a
  scope boundary.

### Timer lifecycle (EGO rule: remove all main-loop sources)

- `this._clickTimeoutId = 0` is initialised in `_init`.
- A small helper clears it on demand:

```js
_clearClickTimeout() {
    if (this._clickTimeoutId) {
        GLib.source_remove(this._clickTimeoutId);
        this._clickTimeoutId = 0;
    }
}
```

- `destroy()` calls `this._clearClickTimeout()` before `super.destroy()`.

## Activation and fallback

The extension already builds a `Gio.DBusProxy` for
`org.kde.StatusNotifierItem`. Method calls follow the codebase's existing idiom
(`Gio.DBus.session.call(...)` + `call_finish` in a try/catch, as in
`_activateMenuItem`), invoked asynchronously so the shell thread never blocks.

Screen coordinates for the SNI methods come from the icon's transformed
position (stage coordinates ≈ screen coordinates for a panel button), rounded to
integers because the D-Bus args are `i`.

```js
_iconCoords() {
    const [x, y] = this.get_transformed_position();
    return [Math.round(x), Math.round(y)];
}

_primaryActivate() {
    // Menu-only apps advertise ItemIsMenu; honour it up front.
    const isMenu = this._proxy?.get_cached_property('ItemIsMenu')?.deep_unpack() ?? false;
    if (isMenu) {
        this.menu.toggle();
        return;
    }
    this._callSNIMethod('Activate', () => this.menu.toggle());
}

_secondaryActivate() {
    // Middle click has no expected fallback — a menu pop would be surprising.
    this._callSNIMethod('SecondaryActivate', null);
}

_callSNIMethod(method, onError) {
    const [x, y] = this._iconCoords();
    Gio.DBus.session.call(
        this._busName, this._objectPath, 'org.kde.StatusNotifierItem',
        method, new GLib.Variant('(ii)', [x, y]), null,
        Gio.DBusCallFlags.NONE, -1, this._cancellable,
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

Two fallback triggers for the primary path, both resolving to "show the menu":
1. **`ItemIsMenu === true`** — detected up front from the cached property.
2. **`Activate` errors** — the app declares the method but the call fails.

An app whose `Activate` succeeds but does nothing is indistinguishable from
success and is the app's own bug — nothing to fall back on.

### Interface XML

`ItemIsMenu` is **already** declared in the embedded SNI interface XML (right
after the `Menu` property), so the proxy already caches it and no XML change is
needed. `_primaryActivate` reads it directly.

## Preferences UI

In `src/prefs.js`, rename the appearance group title to
**"Appearance & Behaviour"** and add an `Adw.ComboRow` after the padding row,
following the existing "Icon Style" combo (`icon-mode`) pattern: build a
`Gtk.StringList` of the three labels, set `selected` from the current
`click-action`, and on `notify::selected` write the matching enum value back.

- Index → value map: `0 → 'menu'`, `1 → 'activate'`, `2 → 'activate-double'`.
- Labels: the three from the interaction table above.

## Scope (YAGNI)

Out of scope:
- Touch double-tap and keyboard double-activate (touch/keyboard show the menu).
- Per-app interaction overrides.
- Scroll-to-`Scroll` forwarding.
- Interaction changes to the overflow submenu rows — this covers panel icons only.

## Testing / verification

Manual verification in a nested GNOME Shell session (pure GJS, no unit harness):

1. Default (`menu`): behaviour identical to current release — left and right
   click both show the menu.
2. `activate` with Slack or Teams-for-Linux: left click raises the window;
   right click shows the menu; middle click triggers the app's secondary action.
3. `activate-double`: single left click shows the menu after the double-click
   delay; double click raises the window; right click shows the menu instantly.
4. An app with no working `Activate` (or one advertising `ItemIsMenu`): the
   primary action shows the menu instead of hanging or doing nothing.
5. Switch modes while running — the next click uses the new mode with no
   restart.
6. Toggle the extension off in `activate-double` mode with a click timer
   pending; confirm no leftover GLib source (no warning, clean disable).
