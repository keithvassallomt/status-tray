# Changelog

All notable changes to Status Tray will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- "Ignore App Status Icons" option for icon overrides. When enabled, the chosen icon stays in place regardless of status changes from the app (e.g. Surfshark connected/disconnected, Firewall Applet zone changes). Thanks to [@somePaulo](https://github.com/somePaulo) for the suggestion.
- Menu checkmark and radio button support. Toggle states in app menus are now rendered correctly. Thanks to [@somePaulo](https://github.com/somePaulo) for the report.

### Fixed
- Fixed disabled apps reappearing after logout/reboot due to async app ID resolution. Thanks to [@noahajac](https://github.com/noahajac) for the contribution.
- Fixed app order and enable status not persisting in preferences when app IDs resolve asynchronously. Thanks to [@noahajac](https://github.com/noahajac) for the contribution.
- Fixed symbolic icon overrides rendering invisible (black on black) instead of being recoloured to match the panel theme. Thanks to [@somePaulo](https://github.com/somePaulo) for the report.
- Fixed changing an icon override for one app corrupting icons of other apps (especially Electron/Flatpak apps) due to stale IconThemePath lookups.
- Fixed app ID resolution using volatile tooltip text instead of stable SNI Id, causing icon overrides to not persist across sessions for apps like Nextcloud and Firewall Applet.
- Fixed preferences dialog being too small for the new options.
- Fixed app subtitle in preferences overflowing with long tooltip text; now truncated to one line.

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
