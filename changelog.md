# Changelog

All notable changes to Status Tray will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2] - 2026-02-09

### Fixed
- Fixed icons going blank when an app updates its icon to a standard system icon name. The icon theme search now correctly follows theme inheritance and covers all icon categories.

## [1.1] - 2026-02-07

### Added
- "Use as Fallback Only" option for icon overrides. When enabled, the custom icon is only used when the app sends a low-quality pixbuf or no icon at all — the app's own named icon is preserved when available. Useful for apps like NextCloud that normally provide good icons but occasionally fall back to ugly pixbufs.
- Flatpak icon resilience: when a Flatpak app's temporary `IconThemePath` is unavailable, the extension now tries the Flatpak app ID (e.g. `org.ferdium.Ferdium`) as a fallback icon name. Also added `/var/lib/flatpak/exports/share/icons` to the icon theme search paths so Flatpak-exported icons are discoverable.

### Fixed
- Fixed icon tint effect not applying on GNOME 48+.
- Fixed stale/broken tray icons after suspend/resume. The extension now runs a health check on startup that detects and removes ghost icons left behind by apps (especially Flatpak apps) that didn't survive sleep properly.
- Fixed certain icons having a '...' icon background. 

## [1.0] - 2026-01-25

### Added
- Initial release completed
