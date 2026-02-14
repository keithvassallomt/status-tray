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
- **Live updates**: All settings changes apply immediately without restart

### Supported GNOME Versions

- GNOME 45, 46, 47, 48, 49

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
│   ├── extension.js          # Main extension code (~2270 lines)
│   │   ├── TrayItem          # Individual tray icon component
│   │   ├── StatusNotifierWatcher  # D-Bus service implementation
│   │   └── StatusTrayExtension    # Main controller
│   │
│   ├── prefs.js              # Settings UI (~1750 lines)
│   │   ├── AppRow            # Individual app settings row
│   │   ├── IconPickerDialog  # Icon selection dialog
│   │   ├── IconEffectDialog  # Effect customization dialog
│   │   └── StatusTrayPreferences  # Main preferences window
│   │
│   ├── metadata.json         # Extension metadata
│   ├── stylesheet.css        # Panel icon styling
│   └── schemas/
│       ├── org.gnome.shell.extensions.status-tray.gschema.xml
│       └── gschemas.compiled
│
├── docs/
│   └── status-tray.md        # This file
│
├── dev/
│   └── plan.md               # Implementation roadmap
│
├── install.sh                # Installation script
├── changelog.md              # Release notes
└── README.md                 # User documentation
```

---

## Core Components

### TrayItem (`extension.js`, lines 166-1240)

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
| `_cancellable` | Gio.Cancellable | For cancelling async operations |

#### Key Methods

| Method | Description |
|--------|-------------|
| `_initProxy()` | Initialize D-Bus proxy with interface info |
| `_updateIcon()` | Fetch and display icon from SNI |
| `_resolveAppId()` | Determine stable app ID from ToolTip/IconThemePath/SNI Id |
| `_setIcon(iconName)` | Set icon by theme name |
| `_setIconFromPixmap(pixmapData)` | Set icon from ARGB pixel data |
| `_replaceIcon(iconNameOrPath)` | Destroy and recreate St.Icon widget (used for overrides) |
| `_applySymbolicStyle()` | Apply Clutter effects for symbolic mode |
| `_clearIconExcept(activeSource)` | Clear inactive icon sources (content/gicon/icon_name) |
| `_loadMenu()` | Fetch menu via DBusMenu and display |
| `_activateMenuItem(itemId)` | Send click event to menu item |
| `destroy()` | Clean up all resources and subscriptions |

#### Icon Loading Priority

1. Check `icon-overrides` setting for custom icon (uses `_replaceIcon()` to
   create a fresh `St.Icon`, avoiding stale state from previous pixmap rendering)
2. If override is fallback-only, store it and continue
3. Try `IconName` property from SNI proxy cache
4. If no IconName, use fallback override if set
5. Try `IconPixmap` property (ARGB pixel data via `St.ImageContent`)
6. Direct D-Bus fetch of `IconThemePath` → `IconName` → `IconPixmap`
7. For Flatpak apps: try app ID as icon name (e.g. `org.ferdium.Ferdium`)
8. Look up in system icon theme via `findIconInTheme()`
9. Fallback to `image-loading-symbolic` placeholder

---

### StatusNotifierWatcher (`extension.js`, lines 1248-1549)

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

### StatusTrayExtension (`extension.js`, lines 1557-1833)

Main extension controller. Extends `Extension.Extension`.

#### Lifecycle Methods

| Method | Description |
|--------|-------------|
| `enable()` | Start watcher, load settings, create items |
| `disable()` | Destroy all items, stop watcher |
| `_refreshItems()` | Recreate items (after settings change) |
| `_reorderItems()` | Update panel positions based on app-order |

#### Settings Handlers

```javascript
// Setting change handlers
'changed::disabled-apps'         → _refreshItems()
'changed::icon-mode'            → _refreshIconStyles()
'changed::icon-overrides'       → _refreshIcons()  // only updates affected items
'changed::icon-effect-overrides' → _refreshIconStyles()
'changed::app-order'            → _reorderItems()
```

**Note**: `_refreshIcons()` only calls `_updateIcon()` on items that have an
active override or were previously showing one (override just removed). This
prevents stale `IconThemePath` lookups from corrupting unrelated icons,
especially for Electron/Flatpak apps with temporary directories.

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
**Symbolic icons** (names ending in `-symbolic`) are excluded from desaturation
and brightness/contrast effects, since `St.Icon` already recolours them to
match the panel theme via `-st-icon-style: symbolic`. Tint is still applied
if configured.

```javascript
_applySymbolicStyle() {
    const isSymbolicIcon = iconName?.endsWith('-symbolic');

    // Symbolic icons: St.Icon handles recolouring via CSS.
    // Only apply effects to full-colour (pixmap/raster) icons.
    if (!isSymbolicIcon) {
        // 1. Desaturation (grayscale conversion)
        this._icon.add_effect(new Clutter.DesaturateEffect({
            factor: desaturation  // 0.0 - 1.0
        }));

        // 2. Brightness/Contrast adjustment
        const bc = new Clutter.BrightnessContrastEffect();
        bc.set_brightness(brightness);  // -1.0 to 1.0
        bc.set_contrast(contrast);      // 0.0 to 2.0
        this._icon.add_effect(bc);
    }

    // 3. Optional tint (colorize) — applied to all icon types
    if (useTint) {
        this._icon.add_effect(new Clutter.ColorizeEffect({ tint: color }));
    }
}
```

### Dark Mode Detection

```javascript
_isDarkMode() {
    const settings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
    return settings.get_string('color-scheme') === 'prefer-dark';
}
```

Default effect parameters adapt based on light/dark mode.

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
| `app-order` | `as` | `[]` | Custom app ordering |
| `icon-overrides` | `a{ss}` | `{}` | App ID → icon name/path |
| `icon-fallback-overrides` | `as` | `[]` | App IDs where override is fallback-only |
| `icon-effect-overrides` | `a{ss}` | `{}` | App ID → JSON effect config |

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
└── Adw.PreferencesPage
    └── Adw.PreferencesGroup
        ├── Icon Mode Row (Adw.ActionRow + Gtk.ComboBoxText)
        └── App Rows List (Gtk.ListBox)
            ├── AppRow (Gtk.ListBoxRow)
            │   ├── Drag Handle
            │   ├── Icon Preview
            │   ├── App Name Label
            │   ├── Enable/Disable Switch
            │   ├── Icon Picker Button → IconPickerDialog
            │   └── Effect Tuner Button → IconEffectDialog
            ├── AppRow
            └── ...
```

### AppRow (`prefs.js`, lines 62-589)

Each row represents a discovered tray application.

```javascript
// Key functionality
- Fetches app info from SNI (Title, Id, IconName)
- Drag-and-drop reordering via GtkDragSource/GtkDropTarget
- Icon picker opens IconPickerDialog
- Effect tuner opens IconEffectDialog
- Enable switch updates disabled-apps setting
```

### IconPickerDialog (`prefs.js`, lines 594-906)

Modal dialog for selecting custom icons.

```javascript
// Features
- Searchable grid of system icons
- Preview of current selection
- "Choose File..." button for custom icons
- "Reset to Default" button
- Saves to icon-overrides setting
```

### IconEffectDialog (`prefs.js`, lines 913-1459)

Modal dialog for customizing icon effects.

```javascript
// Features
- Sliders: desaturation, brightness, contrast
- Color picker for optional tint
- Live preview with effect simulation
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

For Electron apps that set `IconThemePath`:

```javascript
_findIconInThemePath(iconName, themePath) {
    const patterns = [
        `${themePath}/${iconName}.png`,
        `${themePath}/${iconName}.svg`,
        `${themePath}/hicolor/22x22/apps/${iconName}.png`,
        `${themePath}/hicolor/24x24/apps/${iconName}.png`,
        `${themePath}/hicolor/scalable/apps/${iconName}.svg`,
    ];

    for (const pattern of patterns) {
        if (GLib.file_test(pattern, GLib.FileTest.EXISTS)) {
            return pattern;
        }
    }
    return null;
}
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

```javascript
// IconThemePath may be inaccessible from outside sandbox
try {
    const iconPath = this._findIconInThemePath(iconName, themePath);
    if (iconPath) {
        this._setIconFromPath(iconPath);
        return;
    }
} catch (e) {
    // Permission denied - fall back to IconPixmap
    console.debug(`Cannot access ${themePath}, using IconPixmap`);
}
```

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
- [ ] Test symbolic and original icon modes
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
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Preferences imports (prefs.js)
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
```

---

## Version History

See [changelog.md](../changelog.md) for detailed release notes.
