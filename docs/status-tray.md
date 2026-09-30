# Status Tray - Developer Documentation

This document provides comprehensive technical documentation for developers and AI agents working with the Status Tray GNOME Shell extension.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Core Components](#core-components)
- [D-Bus Integration](#d-bus-integration)
- [Icon Handling](#icon-handling)
- [Menu System](#menu-system)
- [Settings System](#settings-system)
- [Preferences UI](#preferences-ui)
- [Installation & Development](#installation--development)
- [Key Algorithms](#key-algorithms)
- [Edge Cases & Robustness](#edge-cases--robustness)
- [Contributing Guidelines](#contributing-guidelines)

---

## Overview

**Status Tray** is a GNOME Shell extension that provides system tray functionality for applications using the StatusNotifierItem (SNI) protocol. Unlike solutions that rely on external daemons, Status Tray implements its own `org.kde.StatusNotifierWatcher` D-Bus service, making it completely self-contained.

### Key Features

- **Self-contained architecture**: No external daemon required
- **SNI auto-discovery**: Automatically finds and displays tray icons
- **DBusMenu integration**: Full support for dynamic application menus
- **Dual icon modes**: Symbolic (monochrome) or original (colored) icons
- **Extensive customization**: Per-app icon overrides, effects, and ordering
- **Panel overflow**: Optional collapse of excess tray icons into a single overflow button
- **Live updates**: All settings changes apply immediately without restart

### Supported GNOME Versions

- GNOME 46, 47, 48, 49, 50, 51

### Extension Metadata

| Property | Value |
|----------|-------|
| UUID | `status-tray@keithvassallo.com` |
| Schema ID | `org.gnome.shell.extensions.status-tray` |
| Repository | https://github.com/keithvassallomt/status-tray |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GNOME Shell Panel                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                               │
│  │TrayItem │ │TrayItem │ │TrayItem │  ← PanelMenu.Button instances │
│  └────┬────┘ └────┬────┘ └────┬────┘                               │
└───────┼──────────┼──────────┼──────────────────────────────────────┘
        │          │          │
        ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    StatusTrayExtension                              │
│  - Manages TrayItem lifecycle                                       │
│  - Handles settings via GSettings                                   │
│  - Controls panel positioning                                       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   StatusNotifierWatcher                             │
│  - D-Bus service: org.kde.StatusNotifierWatcher                     │
│  - Handles app registration                                         │
│  - Tracks active items                                              │
│  - Scans for existing SNI objects on startup                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        D-Bus Session Bus                            │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   App 1 (SNI)    │  │   App 2 (SNI)    │  │   App 3 (SNI)    │  │
│  │   + DBusMenu     │  │   + DBusMenu     │  │   + DBusMenu     │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Registration**: Apps call `RegisterStatusNotifierItem` on the watcher
2. **Discovery**: Watcher emits `StatusNotifierItemRegistered` signal
3. **Creation**: Extension creates `TrayItem` for each registered app
4. **Display**: TrayItem connects to app's SNI, fetches icon, renders in panel
5. **Interaction**: User clicks → menu fetched via DBusMenu → action sent back

---

## Project Structure

```
Status Tray/
├── src/
│   ├── extension.js          # Main extension code
│   │   ├── TrayItem          # Individual tray icon component
│   │   ├── OverflowButton    # Panel overflow button and submenu host
│   │   ├── StatusNotifierWatcher  # D-Bus service implementation
│   │   └── StatusTrayExtension    # Main controller
│   │
│   ├── prefs.js              # Settings UI
│   │   ├── AppRow            # Individual app settings row
│   │   ├── IconPickerDialog  # Icon selection window
│   │   ├── IconEffectDialog  # Effect customization window
│   │   └── StatusTrayPreferences  # Main preferences window
│   │
│   ├── iconLookup.js         # Icon file search shared by extension.js and
│   │                         # prefs.js (Gio/GLib only, loaded in both processes)
│   │
│   ├── metadata.json         # Extension metadata
│   ├── stylesheet.css        # Panel icon styling
│   ├── icons/
│   │   ├── status-tray.svg            # Full-colour overflow glyph
│   │   └── status-tray-symbolic.svg   # Symbolic overflow glyph
│   └── schemas/
│       ├── org.gnome.shell.extensions.status-tray.gschema.xml
│       └── gschemas.compiled
│
├── docs/
│   └── status-tray.md        # This file
│
├── dev/
│   ├── compliance.md         # GNOME EGO review checklist
│   └── preview-icon.js       # GJS tool for previewing bundled icons
│
├── install.sh                # Installation script
├── package.sh                # Packaging script for extensions.gnome.org
├── changelog.md              # Release notes
└── README.md                 # User documentation
```

---

## Core Components

### TrayItem (`extension.js`)

Represents a single tray icon in the panel. Extends `PanelMenu.Button`.

#### Constructor Parameters

```javascript
new TrayItem(
  busName,      // D-Bus service name (e.g., ':1.234' or 'org.app.Name')
  objectPath,   // SNI object path (e.g., '/StatusNotifierItem')
  settings,     // Gio.Settings instance
  panelBox      // Panel container for positioning
)
```

#### Key Properties

| Property | Type | Description |
|----------|------|-------------|
| `_busName` | String | D-Bus bus name of the app |
| `_objectPath` | String | D-Bus object path of SNI |
| `_proxy` | Gio.DBusProxy | Proxy to SNI interface |
| `_appId` | String | Stable app identifier for settings |
| `_settings` | Gio.Settings | Extension settings reference |
| `_icon` | St.Icon | The displayed icon widget |
| `_flatpakAppPath` | String | Host location of a Flatpak app's `/app`, or null (see *Sandboxed App Support*) |
| `_cancellable` | Gio.Cancellable | For cancelling async operations |

#### Key Methods

| Method | Description |
|--------|-------------|
| `_initProxy()` | Initialize D-Bus proxy with interface info |
| `_updateIcon()` | Fetch and display icon from SNI |
| `_resolveAppId()` | Determine stable app ID from ToolTip/IconThemePath/SNI Id |
| `_setIcon(iconName)` | Set icon by name, via the shared `resolveIconFile()` search |
| `_setIconFromPixmap(pixmapData)` | Set icon from ARGB pixel data, as an `St.ImageContent` gicon |
| `_resolveFlatpakAppPath()` | Find a Flatpak app's `/app` on the host; redo the icon if it was waiting on it |
| `_replaceIcon(iconNameOrPath)` | Destroy and recreate St.Icon widget (used for overrides) |
| `_applySymbolicStyle(targetIcon, iconSize, forceMode)` | Apply Clutter effects for symbolic mode; `forceMode` overrides the global `icon-mode` (used by the overflow preview) |
| `vfunc_style_changed()` | Re-apply the effects when the panel's text colour changes |
| `_clearIconExcept(activeSource)` | Clear inactive icon sources (gicon/icon_name) |
| `_loadMenu()` | Fetch menu via DBusMenu and display |
| `_activateMenuItem(itemId)` | Send click event to menu item |
| `destroy()` | Clean up all resources and subscriptions |

#### Icon Loading Priority

1. Check `icon-overrides` setting for custom icon (uses `_replaceIcon()` to
   create a fresh `St.Icon`, avoiding stale state from previous pixmap rendering)
2. If override is fallback-only, store it and continue
3. Try `IconName` property from SNI proxy cache
4. If no IconName, use fallback override if set
5. Try `IconPixmap` property (ARGB pixel data, handed to `St.Icon` as an
   `St.ImageContent` gicon so it is sized and padded like a themed icon)
6. Direct D-Bus fetch of `IconThemePath` → `IconName` → `IconPixmap`
7. Search for the icon file with `resolveIconFile()` (`iconLookup.js`, shared
   with preferences): an absolute path; the app's `IconThemePath`, with a
   Flatpak sandbox's `/app` mapped to the host; for Flatpak apps, the app ID as
   icon name (e.g. `org.ferdium.Ferdium`); otherwise the host icon theme via
   `findIconInTheme()`, which searches the user's icon folders first and goes
   theme by theme, as GNOME does, so a user's own copy of an icon wins (#29)
8. Ask `St.IconTheme`, then fall back to `IconPixmap`
9. Fallback to `image-loading-symbolic` placeholder

---

### StatusNotifierWatcher (`extension.js`)

Implements the D-Bus service that applications use to register tray icons.

#### D-Bus Interface

```xml
<interface name="org.kde.StatusNotifierWatcher">
  <method name="RegisterStatusNotifierItem">
    <arg type="s" direction="in" name="service"/>
  </method>
  <method name="RegisterStatusNotifierHost">
    <arg type="s" direction="in" name="service"/>
  </method>
  <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
  <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
  <property name="ProtocolVersion" type="i" access="read"/>
  <signal name="StatusNotifierItemRegistered">
    <arg type="s"/>
  </signal>
  <signal name="StatusNotifierItemUnregistered">
    <arg type="s"/>
  </signal>
</interface>
```

#### Key Methods

| Method | Description |
|--------|-------------|
| `export()` | Export D-Bus interface and acquire bus name |
| `unexport()` | Release bus name and unexport interface |
| `RegisterStatusNotifierItem(service)` | Handle app registration |
| `_scanExistingItems()` | Find SNI objects already on the bus |
| `_onNameOwnerChanged()` | Clean up when app exits |

#### Registration Flow

```javascript
// App calls (pseudo-code):
dbus.call('org.kde.StatusNotifierWatcher',
          '/StatusNotifierWatcher',
          'RegisterStatusNotifierItem',
          [':1.234'])  // or 'org.app.Name'

// Watcher responds by:
// 1. Adding to _items registry
// 2. Emitting StatusNotifierItemRegistered signal
// 3. Watching for app exit via NameOwnerChanged
```

---

### StatusTrayExtension (`extension.js`)

Main extension controller. Extends `Extension.Extension`.

#### Lifecycle Methods

| Method | Description |
|--------|-------------|
| `enable()` | Start watcher, load settings, create items, register the `toggle-menu` keybinding |
| `disable()` | Remove the keybinding, destroy all items and the overflow button, stop watcher |
| `_refreshItems()` | Recreate items (after settings change) |
| `_reorderItems()` | Update panel positions based on app-order |
| `_applyOverflow()` | Show/hide inline items and (re)build the overflow button |
| `_keyboardTarget()` | Leftmost visible non-passive item, or the overflow button, for the `toggle-menu` shortcut |

#### Settings Handlers

```javascript
// Setting change handlers
'changed::disabled-apps'           → _refreshItems()
'changed::icon-mode'               → _refreshIconStyles()
'changed::icon-size'               → _refreshIconSizes()
'changed::icon-padding'            → _refreshPadding()
'changed::icon-overrides'          → _refreshIcons()  // only updates affected items
'changed::icon-effect-overrides'   → _refreshIconStyles()
'changed::icon-fallback-overrides' → _refreshIcons()
'changed::app-order'               → _reorderItems()
'changed::title-aliases'           → _refreshItems() (+ re-resolve each appId)
'changed::overflow-enabled'        → _applyOverflow()
'changed::overflow-inline-count'   → _applyOverflow()
```

**Note**: `_refreshIcons()` only calls `_updateIcon()` on items that have an
active override or were previously showing one (override just removed). This
prevents stale `IconThemePath` lookups from corrupting unrelated icons,
especially for Electron/Flatpak apps with temporary directories.

**Note**: `_refreshIconSizes()` resizes each `TrayItem`'s panel icon (via
`_applyIconSize()`) and, through the trailing `_applyOverflow()` call, the
overflow button's dynamic preview mosaic, so both track `icon-size` live.
Submenu icons inside the overflow dropdown are unaffected — `_applyRowIcon()`
always renders them at the fixed default of 16px.

Every lifecycle path that changes the set of inline items
(`_onItemRegistered`, `_onItemUnregistered`, `_refreshItems`, `_refreshIcons`,
`_refreshIconStyles`, `_reorderItems`, and the external-destroy handler)
calls `_applyOverflow()` at the end to keep the overflow button's contents
and position in sync.

---

### OverflowButton (`extension.js`)

A `PanelMenu.Button` that holds the tray's overflow items. Created on demand
by `StatusTrayExtension._applyOverflow()` when `overflow-enabled` is `true`
and the number of active `TrayItem`s exceeds `overflow-inline-count`.

#### Responsibilities

- Renders one of four ways depending on `overflow-icon-style`: a bundled glyph
  (`icons/status-tray.svg` / `icons/status-tray-symbolic.svg`, following the
  current `icon-mode`), a colour preview of up to four overflowed tray icons,
  a monochrome preview of them with a panel-background halo behind each glyph so
  overlapping silhouettes separate, or a user-chosen custom icon
  (`overflow-custom-icon`) rendered as-is at `icon-size`. The dynamic previews
  set their own colour treatment independently of `icon-mode`; the custom icon
  falls back to the bundled glyph if unset or the referenced file is missing.
- Builds one `PopupMenu.PopupSubMenuMenuItem` per overflowed `TrayItem`,
  labelled with the app's display name and prefixed with a clone of that
  `TrayItem`'s gicon.
- Each row's submenu is seeded with a "Loading..." placeholder and is
  lazily populated on first open by invoking the source `TrayItem`'s
  DBusMenu fetch against the submenu (see *Menu System* below).
- Listens to each overflowed `TrayItem`'s `display-changed` signal and
  refreshes the row's label, icon, and cached menu contents live.
- Re-applies its rows and preview from `vfunc_style_changed()` when the
  panel's text colour changes. Overflowed `TrayItem`s are hidden, and St
  doesn't restyle hidden widgets, so they can't do it themselves.

#### Interaction with TrayItem

`TrayItem` exposes its menu-build logic generically:

```javascript
// TrayItem methods
_loadMenu(targetMenu = this.menu)
_fetchMenuLayout(targetMenu = this.menu)
_buildMenuFromLayout(layout, targetMenu = this.menu)
_addMenuItem(item, targetMenu = this.menu)
```

In normal (inline) use, `targetMenu` defaults to `this.menu` — the TrayItem's
own panel menu. In the overflow case, `OverflowButton` passes the row's
`PopupSubMenu` as the target so the DBusMenu tree renders there instead.

`TrayItem` emits a lightweight `display-changed` signal after its SNI
properties change (Title/ToolTip re-resolution, icon updates), which
`OverflowButton` uses to keep rows in sync without full rebuilds.

#### Nested-submenu caveat

Each `PopupSubMenuMenuItem` constructed by `_addMenuItem` has its
`_getTopMenu()` overridden to return the immediate containing menu rather
than the panel top menu. This scopes the "only one submenu open at a time"
rule locally; without it, opening an app's own submenu (e.g. NordVPN's
`Settings`) inside an overflow row would trigger the top menu to close the
outer breadcrumb. See `_addMenuItem` in `extension.js` for details.

---

## D-Bus Integration

### Interfaces Consumed

#### org.kde.StatusNotifierItem

Used to communicate with tray applications.

```javascript
// Key properties
IconName        // String: theme icon name
IconPixmap      // Array of (width, height, pixels[])
IconThemePath   // String: custom icon search path
Menu            // ObjectPath: path to DBusMenu
Title           // String: tooltip text
Id              // String: app identifier

// Key signals
NewIcon         // Icon changed
NewStatus       // Status changed (Passive/Active/NeedsAttention)
NewTitle        // Tooltip text changed

// Key methods
Activate(x, y)  // Primary click action
ContextMenu(x, y)  // Right-click (rarely used, prefer DBusMenu)
```

#### com.canonical.dbusmenu

Used for fetching and interacting with application menus.

```javascript
// Key methods
AboutToShow(parentId)
  → needsUpdate: Boolean

GetLayout(parentId, recursionDepth, propertyNames)
  → (revision: UInt32, layout: (id, properties, children[]))

Event(itemId, eventType, data, timestamp)
  // eventType is typically 'clicked'
```

### Proxy Creation Pattern

```javascript
// Create proxy with interface info for better compatibility
const INTERFACE_XML = `<node>...</node>`;
const ifaceInfo = Gio.DBusInterfaceInfo.new_for_xml(INTERFACE_XML);

const proxy = new Gio.DBusProxy({
    g_connection: Gio.DBus.session,
    g_name: busName,
    g_object_path: objectPath,
    g_interface_name: 'org.kde.StatusNotifierItem',
    g_interface_info: ifaceInfo,
    g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES
});

await proxy.init_async(GLib.PRIORITY_DEFAULT, cancellable);
```

---

## Icon Handling

### Pixel Format Conversion

SNI uses ARGB in network byte order (big-endian):
```
Memory: [A₀, R₀, G₀, B₀, A₁, R₁, G₁, B₁, ...]
```

GdkPixbuf expects RGBA:
```
Memory: [R₀, G₀, B₀, A₀, R₁, G₁, B₁, A₁, ...]
```

#### Conversion Algorithm (`_argbToRgba`)

```javascript
_argbToRgba(argbData) {
    const pixelCount = argbData.length / 4;
    const rgba = new Uint8Array(argbData.length);

    for (let i = 0; i < pixelCount; i++) {
        const srcOffset = i * 4;
        const dstOffset = i * 4;

        // ARGB → RGBA
        rgba[dstOffset]     = argbData[srcOffset + 1]; // R
        rgba[dstOffset + 1] = argbData[srcOffset + 2]; // G
        rgba[dstOffset + 2] = argbData[srcOffset + 3]; // B
        rgba[dstOffset + 3] = argbData[srcOffset];     // A
    }

    return rgba;
}
```

### Symbolic Style Effects

The symbolic mode uses Clutter effects to make full-colour icons monochrome.
**Symbolic icons** (names ending in `-symbolic`, or files named
`*-symbolic.svg`, `*-symbolic-ltr.svg`, `*-symbolic-rtl.svg` or
`*.symbolic.png`) get no effects: `St.Icon` already paints them in the style's
`color`, the panel's text colour. A tint is applied to them by setting that
`color` instead.

Clutter runs the most recently added effect first, so `_applySymbolicStyle()`
builds the list in the order the effects should run and adds it in reverse:

```javascript
// Full-colour icons, in running order:
effects.push(['desaturate', new Clutter.DesaturateEffect({ factor: desaturation })]);  // 0.0 - 1.0

const bc = new Clutter.BrightnessContrastEffect();
bc.set_brightness_full(brightness, brightness, brightness);  // -1.0 to 1.0
bc.set_contrast_full(contrast, contrast, contrast);          // 0.0 to 2.0
effects.push(['brightness', bc]);

if (!dark)          // light panel: invert, landing the glyph on the text colour or tint
    effects.push(['light-panel', new LightPanelEffect(tint ?? panelTextColour)]);
else if (tint)      // dark panel: optional tint
    effects.push(['tint', makeTintEffect(tint)]);

targetIcon.clear_effects();
for (const [name, effect] of effects.reverse())
    targetIcon.add_effect_with_name(name, effect);
```

Desaturation and brightness/contrast leave a light glyph on dark
surroundings, which suits a dark panel. They cannot make a light pixel darker
than a dark one, so on a light panel `LightPanelEffect` (a `Shell.GLSLEffect`,
or a `Clutter.ShaderEffect` on GNOME 51, which removed `Shell.GLSLEffect`)
inverts lightness on premultiplied colour: the glyph comes out in the panel's
text colour and transparent pixels stay transparent. The same default values
(desaturation 1.0, brightness −0.25, contrast 0.6) therefore suit both panels.

### Light and Dark Panels

Whether the panel is dark is read from the text colour the shell theme gives a
panel button, not from `org.gnome.desktop.interface color-scheme`. GNOME only
loads its light shell stylesheet for `'prefer-light'`, so `'default'` keeps a
dark top bar, and GNOME Classic and custom themes set their own panel colours.

```javascript
function readPanelDark(button) {
    const fg = readPanelForeground(button);   // null while off the stage
    if (!fg)
        return null;
    return 0.299 * fg[0] + 0.587 * fg[1] + 0.114 * fg[2] > 0.5;
}
```

`TrayItem` and `OverflowButton` override `vfunc_style_changed()`: when a
stylesheet swap or the overview changes the panel's text colour, they re-apply
their effects. The result is published to the internal `panel-dark` key, which
preferences reads (it runs outside the shell and can't see its theme) and
which serves as a fallback before a button is on the stage. The overview gives
the panel light text over its dark backdrop, so the key is not written while
the panel has the `overview` pseudo-class.

---

## Menu System

### Menu Loading Flow

```javascript
async _loadMenu() {
    // 1. Get menu object path from SNI
    const menuPath = this._proxy.Menu;

    // 2. Call AboutToShow to trigger visibility updates
    await this._callDBusMethod(this._busName, menuPath,
        'com.canonical.dbusmenu', 'AboutToShow', new GLib.Variant('(i)', [0]));

    // 3. Fetch full menu layout
    const layout = await this._callDBusMethod(this._busName, menuPath,
        'com.canonical.dbusmenu', 'GetLayout',
        new GLib.Variant('(iias)', [0, -1, []]));

    // 4. Parse and build PopupMenu items
    this._buildMenu(layout);
}
```

### Menu Layout Structure

```javascript
// GetLayout returns: (revision, (id, properties, children))
// Example structure:
{
    id: 0,
    properties: {},
    children: [
        {
            id: 1,
            properties: {
                'label': 'Open Window',
                'enabled': true,
                'visible': true
            },
            children: []
        },
        {
            id: 2,
            properties: {
                'type': 'separator'
            },
            children: []
        },
        {
            id: 3,
            properties: {
                'label': 'Submenu',
                'children-display': 'submenu'
            },
            children: [...]
        }
    ]
}
```

### Menu Item Activation

```javascript
_activateMenuItem(itemId) {
    const menuPath = this._proxy.Menu;

    // Send 'clicked' event to the item
    this._callDBusMethod(this._busName, menuPath,
        'com.canonical.dbusmenu', 'Event',
        new GLib.Variant('(isvu)', [
            itemId,      // Item ID
            'clicked',   // Event type
            new GLib.Variant('i', 0),  // Data
            0            // Timestamp
        ]));
}
```

---

## Settings System

### GSettings Schema

**Schema ID**: `org.gnome.shell.extensions.status-tray`
**Path**: `/org/gnome/shell/extensions/status-tray/`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `disabled-apps` | `as` | `[]` | App IDs to hide |
| `icon-mode` | `s` | `'symbolic'` | `'symbolic'` or `'original'` |
| `icon-size` | `i` | `16` | Size in pixels of tray icons shown in the top bar and the overflow button's dynamic preview; range 14-20 |
| `icon-padding` | `i` | `4` | Gap in pixels between adjacent tray icons; applied as half this value of horizontal padding per side to each tray button and the overflow button; range 0-20 |
| `click-action` | `s` | `'menu'` | Left-click behaviour: `'menu'` shows the app menu (default), `'activate'` opens the app window (menu on right click), `'activate-double'` opens the window on double click (menu on single click). Right click always shows the menu; middle click triggers `SecondaryActivate` |
| `toggle-menu` | `as` | `[]` | Keyboard shortcut that opens the leftmost visible tray menu and focuses it, falling back to the overflow button when every item is overflowed; empty means unbound |
| `app-order` | `as` | `[]` | Custom app ordering |
| `icon-overrides` | `a{ss}` | `{}` | App ID → icon name/path |
| `icon-fallback-overrides` | `as` | `[]` | App IDs where override is fallback-only |
| `icon-lock-overrides` | `as` | `[]` | App IDs whose override ignores app-side icon changes |
| `icon-effect-overrides` | `a{ss}` | `{}` | App ID → JSON effect config |
| `title-aliases` | `a{ss}` | `{}` | Display name → stable app ID (for apps that randomize SNI IDs) |
| `overflow-enabled` | `b` | `false` | Enable the panel overflow button |
| `overflow-inline-count` | `i` | `3` | Inline icon limit before items spill into the overflow menu; `0` keeps every tray item in overflow |
| `overflow-icon-style` | `s` | `'static'` | `'static'` uses the bundled tray glyph; `'dynamic-original'` previews up to four hidden icons in colour; `'dynamic-symbolic'` previews them in monochrome with a separating outline; `'custom'` uses the icon set in `overflow-custom-icon` |
| `overflow-custom-icon` | `s` | `''` | Theme icon name or absolute file path for the overflow button when `overflow-icon-style` is `'custom'`; falls back to the bundled glyph when empty or the file is missing |
| `panel-dark` | `b` | `true` | Internal: whether the top bar is dark, written by the extension from the panel's text colour (see *Light and Dark Panels*) for preferences to read; not meant to be set by hand |

### Effect Override Format

```javascript
// Stored as JSON string in icon-effect-overrides
{
    "desaturation": 1.0,        // 0.0 - 1.0
    "brightness": 0.5,          // -1.0 to 1.0
    "contrast": 0.6,            // 0.0 to 2.0
    "useTint": false,           // boolean
    "tintColor": [1.0, 1.0, 1.0]  // RGB, each 0.0 - 1.0
}
```

### Settings Access

```javascript
// In extension
const settings = this.getSettings();

// Read
const disabledApps = settings.get_strv('disabled-apps');
const iconMode = settings.get_string('icon-mode');

// Write
settings.set_strv('disabled-apps', ['app1', 'app2']);

// Listen for changes
settings.connect('changed::icon-mode', () => {
    this._refreshIconStyles();
});
```

---

## Preferences UI

### Component Hierarchy

```
StatusTrayPreferences (Adw.PreferencesWindow)
├── Header bar
│   └── Main menu (Gtk.MenuButton) → About Status Tray (Adw.AboutDialog)
│       (packed into the window's private AdwHeaderBar, found by walking the
│       widget tree; if it can't be found, an About row goes on Appearance)
│
├── Adw.PreferencesPage ("Apps")            ← opens first
│   └── Adw.PreferencesGroup ("Tray Apps")
│       └── App Rows List
│           ├── AppRow (Adw.ActionRow)
│           │   ├── Drag Handle
│           │   ├── Icon Button (shows the icon) → IconPickerDialog
│           │   ├── App Name / App ID
│           │   ├── Effect Tuner Button → IconEffectDialog
│           │   └── Enable/Disable Switch → disabled-apps
│           ├── AppRow
│           └── ...
│
├── Adw.PreferencesPage ("Appearance")
│   ├── Adw.PreferencesGroup ("Icons")
│   │   ├── Icon style (Adw.ComboRow) → icon-mode
│   │   ├── Size (Adw.ActionRow + Gtk.Scale) → icon-size
│   │   └── Padding between icons (Adw.ActionRow + Gtk.Scale) → icon-padding
│   └── Adw.PreferencesGroup ("Placement")
│       └── Panel position (Adw.ComboRow) → panel-position
│
└── Adw.PreferencesPage ("Behaviour")
    ├── Adw.PreferencesGroup ("Interaction")
    │   ├── Click action (Adw.ComboRow) → click-action
    │   └── Open menu shortcut (Adw.ActionRow) → toggle-menu
    └── Adw.PreferencesGroup ("Overflow")
        ├── Enable overflow (Adw.SwitchRow) → overflow-enabled
        ├── Button icon (Adw.ComboRow) → overflow-icon-style
        ├── Custom overflow icon (Adw.ActionRow) → overflow-custom-icon
        │   (visible only when overflow-icon-style is 'custom'; "Choose…"
        │   opens the icon picker for a theme icon or image file)
        └── Inline icon limit (Adw.SpinRow) → overflow-inline-count
```

### Window Size

`fillPreferencesWindow` sizes the window once, straight after the synchronous
`_populateAppsGroup()`, from the number of app rows. `_preferredHeight()` adds
the header bar, page margins, group header and rows using constants measured on
libadwaita 1.9 at the default text scale (46, 48, 57, then 54 for the first row
and 55 for each after). The result is clamped between `MIN_PREFS_HEIGHT` (573,
the Behaviour page with the custom icon row showing) and 85% of the smallest
monitor. Width is fixed at 640: `AdwPreferencesPage` caps content at 600, and at
600 or below `AdwPreferencesWindow` moves the page switcher into a bottom bar.
Rows added later scroll rather than resize the window. If a label change makes a
row wrap onto an extra line, re-measure and update the constants. The icon
picker and effect dialogs are separate windows, so this height doesn't limit
them.

### AppRow (`prefs.js`)

Each row represents a discovered tray application.

```javascript
// Key functionality
- Fetches app info from SNI (Title, Id, IconName, IconThemePath)
- Resolves its icon in the same order as TrayItem, through the shared
  resolveIconFile(), and keeps the result (this._iconSource) for the effect
  dialog
- Drag-and-drop reordering via GtkDragSource/GtkDropTarget
- Icon picker opens IconPickerDialog
- Effect tuner opens IconEffectDialog
- Enable switch updates disabled-apps setting
```

### IconPickerDialog (`prefs.js`)

Modal `Adw.Window`, transient for the preferences window, for selecting
custom icons and tuning per-app override flags. It is a separate window rather
than an `Adw.Dialog` so it sizes to its own content instead of being clipped to
the preferences window. Stays open across selections so multiple settings can
be adjusted in one visit; close it (titlebar button or Esc) when done.

```javascript
// Features
- Searchable grid of system icons
- Preview of current selection
- "Choose File..." button for custom icons
- "Use as Fallback Only" switch → icon-fallback-overrides
- "Ignore App Status Icons" switch → icon-lock-overrides
- "Match by App Name" switch → title-aliases
- "Reset to Default" button
- All changes write straight to GSettings as they're made
```

### IconEffectDialog (`prefs.js`)

Modal `Adw.Window`, transient for the preferences window, for customizing
icon effects.

```javascript
// Features
- Sliders: desaturation, brightness, contrast
- Color picker for optional tint
- Live preview of the icon the AppRow resolved, on a top-bar-coloured
  backdrop (panel-dark), computed with the same maths and effect order as
  the tray's Clutter effects, including the light-panel inversion
- Reset to defaults button
- Saves to icon-effect-overrides as JSON
```

### Drag-and-Drop Implementation

```javascript
// Source setup
const dragSource = new Gtk.DragSource();
dragSource.set_actions(Gdk.DragAction.MOVE);
dragSource.connect('prepare', (source, x, y) => {
    _draggedRow = this;  // Module-level variable
    return Gdk.ContentProvider.new_for_value(this);
});

// Target setup
const dropTarget = new Gtk.DropTarget();
dropTarget.set_gtypes([AppRow]);
dropTarget.connect('drop', (target, value, x, y) => {
    // Reorder rows and update app-order setting
});
```

---

## Installation & Development

### Installation Script (`install.sh`)

```bash
# Compile schemas
glib-compile-schemas src/schemas/

# Development: symlink for hot reload
ln -sf "$(pwd)/src" \
    "$HOME/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com"

# Production: copy files
cp -r src/* \
    "$HOME/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com/"
```

### Development Workflow

1. Make changes to source files
2. Restart GNOME Shell:
   - X11: `Alt+F2` → `r` → Enter
   - Wayland: Log out and back in
3. Check logs: `journalctl -f -o cat /usr/bin/gnome-shell`

### Debugging

```bash
# View extension logs
journalctl -f -o cat /usr/bin/gnome-shell 2>&1 | grep -i status-tray

# Check D-Bus activity
dbus-monitor "interface='org.kde.StatusNotifierWatcher'"

# List registered items
gdbus call --session \
    --dest org.kde.StatusNotifierWatcher \
    --object-path /StatusNotifierWatcher \
    --method org.freedesktop.DBus.Properties.Get \
    org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems
```

### Testing Applications

Known compatible apps for testing:
- **Nextcloud** - Good baseline, standard SNI
- **Discord** - Electron app, uses IconThemePath
- **Slack** - Electron app
- **Bitwarden** - Electron app
- **Dropbox** - Traditional tray app
- **Telegram** - Qt app, complex menus

---

## Key Algorithms

### App ID Determination

The extension needs stable app IDs for settings persistence. The initial ID
is extracted from the bus name/object path, then `_resolveAppId()` upgrades
it asynchronously using a priority chain:

```javascript
_resolveAppId() {
    // Priority order:
    // 1. ToolTip title (best for Electron apps, e.g. "Bitwarden")
    // 2. Flatpak app ID from IconThemePath (e.g. "org.ferdium.Ferdium")
    // 3. SNI Id (if not generic like "chrome_status_icon_N")
    // 4. Keep initial fallback from object path / bus name

    // When resolved, emits 'appid-resolved' signal which triggers
    // _refreshItems() to re-check disabled state and reorder.
}
```

### Panel Position Calculation

```javascript
_getPosition(appId) {
    const order = this._settings.get_strv('app-order');
    const index = order.indexOf(appId);

    if (index === -1) {
        // New app: add to end of order
        order.push(appId);
        this._settings.set_strv('app-order', order);
        return order.length - 1;
    }

    return index;
}
```

### Icon Theme Path Search

`findIconInThemePath()` in `iconLookup.js` searches an app-supplied
`IconThemePath`. Apps point it at anything from a flat directory of PNGs to
the root of a full theme tree, so it tries the directory itself and then every
size/category subdirectory the host-theme search uses, both directly and under
`hicolor/`:

```javascript
const prefixes = [''];
for (const subdir of _iconThemeSubdirs()) {   // scalable/apps, 48x48/status, ...
    prefixes.push(`${subdir}/`);
    prefixes.push(`hicolor/${subdir}/`);
}
// then ${themePath}/${prefix}${iconName}.png / .svg, first match wins
```

---

## Edge Cases & Robustness

### Race Condition Handling

Apps may register before the extension fully loads:

```javascript
// In StatusNotifierWatcher
async _scanExistingItems() {
    // Query the bus for all names
    const names = await this._connection.call(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'ListNames',
        null, null,
        Gio.DBusCallFlags.NONE,
        -1, null
    );

    // Check each for SNI interface
    for (const name of names) {
        if (await this._hasStatusNotifierItem(name)) {
            this._registerItem(name);
        }
    }
}
```

### Cleanup on App Exit

```javascript
// Subscribe to NameOwnerChanged signal
this._connection.signal_subscribe(
    'org.freedesktop.DBus',
    'org.freedesktop.DBus',
    'NameOwnerChanged',
    '/org/freedesktop/DBus',
    null,
    Gio.DBusSignalFlags.NONE,
    (conn, sender, path, iface, signal, params) => {
        const [name, oldOwner, newOwner] = params.deep_unpack();
        if (newOwner === '' && this._items.has(name)) {
            // App exited, clean up
            this._unregisterItem(name);
        }
    }
);
```

### Sandboxed App Support (Flatpak)

A Flatpak app reports `IconThemePath` (or an absolute `IconName`) as it sees
it inside its sandbox. Paths under `/run/user/<uid>/app/<id>` or
`~/.var/app/<id>` are readable from the host as they are. Paths under `/app`
are not: `/app` is the app's deploy directory, whose host location the
sandbox's `/.flatpak-info` records as `[Instance] app-path`.

```javascript
// iconLookup.js: for the item's D-Bus connection
const [pid] = /* org.freedesktop.DBus.GetConnectionUnixProcessID(busName) */;
const info = `/proc/${pid}/root/.flatpak-info`;   // how the portals identify apps too
return keyFile.get_string('Instance', 'app-path'); // null if not a Flatpak app
```

The connection can belong to the app's `xdg-dbus-proxy` rather than the app,
but the proxy's sandbox carries the same file. `resolveIconFile()` maps `/app`
paths onto `app-path`. When nothing is found, the tray tries the app ID as an
icon name and then falls back to `IconPixmap`.

### Async Operation Cancellation

```javascript
class TrayItem {
    constructor() {
        this._cancellable = new Gio.Cancellable();
    }

    async _updateIcon() {
        try {
            // Pass cancellable to all async operations
            const result = await this._proxy.call(
                'Get', ...,
                this._cancellable
            );
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return;  // Expected during destroy
            }
            throw e;
        }
    }

    destroy() {
        this._cancellable.cancel();
        super.destroy();
    }
}
```

---

## Contributing Guidelines

### Code Style

- Use ES6+ features (async/await, destructuring, arrow functions)
- Prefix private methods with underscore: `_privateMethod()`
- Use `const` by default, `let` when reassignment needed
- Document complex logic with inline comments

### Signal Connection Pattern

```javascript
// Always store connection IDs for cleanup
this._signalIds = [];
this._signalIds.push(
    this._settings.connect('changed::icon-mode', () => {
        this._refreshIconStyles();
    })
);

// In destroy()
for (const id of this._signalIds) {
    this._settings.disconnect(id);
}
```

### Error Handling

```javascript
// Log errors with context
try {
    await this._updateIcon();
} catch (e) {
    console.error(`[StatusTray] Failed to update icon for ${this._appId}:`, e);
    // Set fallback icon instead of crashing
    this._setIcon('image-loading-symbolic');
}
```

### Testing Checklist

Before submitting changes:

- [ ] Test with multiple apps (Electron + Qt + GTK)
- [ ] Test symbolic and original icon modes, on a dark and a light top bar
      (`color-scheme` `'default'` and `'prefer-light'`)
- [ ] Test drag-and-drop reordering
- [ ] Test icon override functionality
- [ ] Verify cleanup on extension disable
- [ ] Check for memory leaks with long uptime
- [ ] Test on both X11 and Wayland

---

## Appendix: Import Reference

```javascript
// Extension imports (extension.js)
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ... } from './iconLookup.js';

// Preferences imports (prefs.js)
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { ... } from './iconLookup.js';

// Shared module (iconLookup.js): Gio and GLib only, since it loads in both
// processes
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
```

---

## Version History

See [changelog.md](../changelog.md) for detailed release notes.
