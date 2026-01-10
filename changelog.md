# Changelog

All notable changes to Status Tray will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial project planning (`plan.md`)
- This changelog (because apparently some of us need to be told to document things)
- Core extension structure (`metadata.json`, `extension.js`, `stylesheet.css`)
- `TrayItem` class - panel button for individual StatusNotifierItem apps
- **Built-in StatusNotifierWatcher** - Extension provides its own `org.kde.StatusNotifierWatcher` D-Bus service
  - Apps register tray icons directly with the extension (no external daemon required)
  - Handles `RegisterStatusNotifierItem` method calls from apps
  - Emits `StatusNotifierItemRegistered`/`Unregistered` signals
  - Scans the bus on startup to find pre-existing SNI objects (handles race conditions)
  - Automatically unregisters items when their bus name disappears
- Icon loading from SNI properties (`IconName`, `IconThemePath`) with Electron app support
- DBusMenu integration with proper `AboutToShow` + `GetLayout` pattern (learned this the hard way in Status Kitchen)
- Menu item activation via `com.canonical.dbusmenu.Event`
- Submenu support for nested menu structures
- Visibility filtering (items with `visible: false` are skipped)
- Automatic cleanup on app disconnect
- Symbolic icon styling using Clutter effects (desaturate + brightness/contrast)
  - Ported directly from Status Kitchen's `_applySymbolicStyle()` method
  - Adapts to light/dark mode automatically

- **Phase 3: Settings UI** (libadwaita prefs panel)
  - GSettings schema (`org.gnome.shell.extensions.status-tray`)
  - `prefs.js` with libadwaita widgets for GNOME 45+
  - Icon mode selector: "Symbolic (monochrome)" vs "Original (colored)"
  - Per-app enable/disable toggles - apps appear in settings after registering a tray icon
  - Live settings updates - icon mode and app visibility react immediately without restart
  - About section with version and source link
  - Install script now compiles schemas automatically

- **Phase 4.2: Settings UI Enhancements**
  - **Better app names** - Fetches `Title` and `Id` from SNI properties for human-readable display
    - Strips status suffixes (e.g., "Nextcloud - Synced" becomes "Nextcloud")
    - Falls back to cleaned-up object path if SNI properties unavailable
    - Shows technical ID as subtitle for reference
  - **Icon override button** - Click the icon in each app row to customize it
    - `IconPickerDialog` with searchable grid of common system icons
    - "Choose File..." button for custom PNG/SVG icons
    - "Reset to Default" to remove override
    - New `icon-overrides` GSettings key stores app ID to icon name/path mapping
    - Extension respects overrides and updates icons live
  - **Live discovery refresh** - Settings UI updates dynamically when apps register/unregister
    - Subscribes to `StatusNotifierItemRegistered`/`Unregistered` D-Bus signals
    - Adds/removes app rows in real-time without reopening settings
    - Properly cleans up signal subscriptions when window closes
  - **Per-icon effect customization** - Tune symbolic effect parameters on a per-app basis
    - New "tune" button beside each app's icon in settings (🎨 preferences-color-symbolic)
    - `IconEffectDialog` with sliders for desaturation, brightness, and contrast
    - Optional tint colour picker to force icons to a specific colour
    - Live CSS-based preview shows effect changes in real-time
    - New `icon-effect-overrides` GSettings key stores per-app JSON effect parameters
    - Extension applies per-app overrides in `_applySymbolicStyle()`
    - Icons update immediately when settings change
  - **Drag-and-drop icon reordering** (Phase 4.2.4)
    - Drag handle on each app row in preferences for visual indication
    - Drag any app row and drop it onto another to reorder
    - Uses GTK4 `GtkDragSource` and `GtkDropTarget` for native drag-and-drop
    - New `app-order` GSettings key persists custom ordering
    - Extension calculates panel positions based on the order setting
    - Icons in the tray update position immediately when order changes
    - Newly discovered apps are added to the end of the order list

### Fixed
- Menu not opening on click - GNOME Shell won't open an empty PopupMenu, so we now add a "Loading..." placeholder during init (just like Status Kitchen builds its menu in `_buildMenu()` during init)
- **Preferences icon display** - Icons in the app list now display correctly for all apps
  - Fixed GTK4 API: changed `set_icon_name()` to `set_from_icon_name()`
  - Added fallback to `IconPixmap` when `IconName` isn't in the system icon theme
  - Properly checks if icon exists in theme before using it
- **Electron app names** - Apps like Bitwarden now show their actual name instead of "Chrome Status Icon 1"
  - Fetches `ToolTip` property which Electron apps populate correctly
  - Priority order: Title > ToolTip title > Id (skipping generic chrome_status_icon_N)
- **Icon override sync** - Custom icons set in preferences now apply to the actual tray icons
  - Fixed appId mismatch between prefs and extension (both now skip generic "StatusNotifierItem" path names)
- **IconPixmap support** - Apps like Bitwarden that provide raw pixel data instead of icon names now display correctly
  - Converts ARGB (network byte order) to RGBA for GdkPixbuf
  - Picks best icon size (closest to 24px) from available pixmaps
  - Falls back gracefully if neither IconName nor IconPixmap works
- **Mnemonic stripping** - Menu labels like `_Preferences` now display as "Preferences" (strips GTK keyboard accelerator markers)
- **Consecutive separator deduplication** - Apps that send multiple separators in a row (like Remmina) now only show one
- **Empty IconName fallback** - Apps that return an empty IconName now correctly fall back to IconPixmap
- **Better icon fetch logging** - Added debug messages for diagnosing apps with broken SNI implementations (e.g., Kando)

### Improved
- **Gio.DBusProxy-based SNI handling** - Rewrote property fetching to use `Gio.DBusProxy` with `Gio.DBusInterfaceInfo`
  - More robust handling of apps with non-standard SNI implementations
  - Uses `GET_INVALIDATED_PROPERTIES` flag for automatic property updates
  - Provides predefined interface schema for better compatibility
  - Falls back to direct D-Bus calls if proxy initialization fails
- **St.ImageContent for IconPixmap** - Improved pixmap icon rendering using `St.ImageContent.set_bytes()`
  - Directly renders ARGB pixel data without format conversion overhead
  - Falls back to temp PNG file approach if St.ImageContent fails
  - Based on AppIndicator extension's approach for better compatibility
- **Fallback icon support** - Uses `image-loading-symbolic` as fallback while icons load or if loading fails
- **Proper async cleanup** - Cancel pending operations and clean up proxy on destroy

### Technical Notes
- Based heavily on Status Kitchen's `src/generator/mod.rs` extension template
- Follows `dev/discovermenu.md` for DBusMenu protocol handling
- Uses GNOME 45+ ES module syntax
- All D-Bus calls are async to avoid blocking the shell
- Icon recoloring uses `Clutter.DesaturateEffect` and `Clutter.BrightnessContrastEffect`
