# Changelog

All notable changes to Status Tray will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0] - 2026-09-24

### Changed
- Preferences are now split across three pages, Apps, Appearance and Behaviour, instead of one long page. Apps opens first, since the app list is what most people open the window for, and it no longer sits below every other setting. Appearance holds icon style, size, padding and panel position; Behaviour holds the click action, the keyboard shortcut and overflow. Several settings were renamed to suit their new homes: Icon Size is now Size, Icon interaction is now Click action, and the overflow rows are now Enable overflow and Button icon. How settings are stored has not changed, so existing configurations carry over untouched.
- About has moved out of the settings list and into the header bar's main menu, where it opens a standard About dialog with the version, licence, website and a link for reporting issues.
- The preferences window now fits its contents instead of opening at a fixed 890 × 900. It is 640 pixels wide: content is capped at 600 either way, and any narrower than about 600 would push the page switcher down to the bottom of the window. Its height follows the number of tray apps, with room for every app row, never less than the tallest settings page and never more than 85% of the smallest monitor. Apps that start or quit while the window is open scroll the list rather than resizing the window.

### Removed
- GNOME 45 is no longer listed as supported. Preferences have never opened there: they are built on `Adw.Dialog`, which arrived in libadwaita 1.5 with GNOME 46, so on GNOME 45 the window failed as soon as it loaded. extensions.gnome.org will keep offering 1.19, the last release to list it, to GNOME 45.

### Fixed
- The sweep that looks for apps which registered before the extension was enabled no longer misses items sitting anywhere other than `/StatusNotifierItem`. It now walks a connection's object tree when nothing is at the default path, which is how apps built on libayatana-appindicator, whose items sit at `/org/ayatana/NotificationItem/<id>`, are found. The sweep also probes every connection in parallel with a three-second timeout, rather than one at a time with a one-second timeout, so a single unresponsive service can no longer stall the whole pass. Two further sweeps run at five and thirty seconds for apps that are still starting up, and the watcher now claims its bus name as the first thing the extension does on enable, rather than after the settings, signal handlers and keyboard shortcut are wired up.
  - None of this helps an app that responds to a missing tray by tearing its item down, which is what Discord, Dropbox and KeePassXC appear to do on a cold boot. Nothing is left on the bus for the sweep to find, so no tray extension can recover them and restarting the app remains the only fix. That case is still open in #28. Thanks to [@MatthewFallon](https://github.com/MatthewFallon) for the report and for a great deal of patient testing.
- The first group in preferences had shown no heading since 1.14. Its title, Appearance & Behaviour, contained a bare ampersand, which libadwaita parses as broken markup and replaces with nothing, so only the description beneath it appeared. That group is gone in the new layout, and none of the new titles use the character.

## [1.19] - 2026-09-18

### Added
- Panel position setting under Appearance & Behaviour: choose whether the tray sits in the left, centre or right section of the top bar. Right is the default and matches previous behaviour. Changing it moves the icons immediately and the overflow button follows them. In the left and centre sections the tray is placed after whatever already lives there, so the Activities button and the clock keep their places. Finer control than the three sections — an exact slot relative to other extensions' indicators — is not offered; that belongs to a panel-management extension. Thanks to [@hopsayer](https://github.com/hopsayer) for the request (#26).

### Changed
- Confirmed GNOME 51 compatibility and updated manifest.

### Fixed
- Tray icons now appear for apps that register themselves as `<bus name>/<object path>` in a single string. Slack — and, most likely, other Electron apps — passes something like `org.freedesktop.StatusNotifierItem-4-1/StatusNotifierItem/1` to `RegisterStatusNotifierItem`, and the whole string was taken as the bus name, so the tray sat waiting on a connection that doesn't exist and left a blank "…" slot whose menu never got past "Loading…". A D-Bus bus name can never contain a `/`, so a slash anywhere but the first character is now treated as the split between the bus name and the item's object path. Thanks to [@osmianski](https://github.com/osmianski) for the fix (#27).
  - Note: the Flatpak build of Slack also needs permission to own its tray bus name before any tray can see it at all — `flatpak override --user --own-name='org.freedesktop.*' com.slack.Slack`.

## [1.18] - 2026-09-14

### Fixed
- Tray icons now follow your configured app order straight after login. `app-order` was only re-applied when the setting itself changed, so on a fresh shell icons came up in whatever order the apps happened to register in and only sorted themselves out once you opened preferences and touched something. The order is now re-applied when an item registers and again when its App ID resolves, which for plenty of apps — Electron ones especially — only happens after the icon is already in the panel. Thanks to [@BNKPI](https://github.com/BNKPI) for the fix (#25).
- The overflow button no longer wedges itself in between visible tray icons. Its panel slot was worked out from the number of visible items, while the reordering pass gives a slot to every item it manages, passive ones included — so a single passive app in the tray was enough to leave the button sitting one place to the left of where it belongs. Only affected setups with Overflow enabled.
- Overflow menu rows no longer pile up duplicate icon-update handlers. Every time the overflow set was rebuilt, items that were still in it got reconnected to their `display-changed` signal without being disconnected first, so a long-running session with Overflow enabled did steadily more redundant work each time one of those icons changed. No visible symptom was reported for this one; it turned up while reviewing the app-order fix above.

## [1.17] - 2026-08-28

### Fixed
- Per-app icon overrides no longer get dropped the next time the app changes its own icon. The `NewIcon` handler refetched the app's icon straight from D-Bus without re-checking the override, so any app that swaps icons at runtime — Dropbox does it on every sync state change — reverted to its own icon within seconds of the override being applied. Overrides are now re-checked on that path (and applied when the app ID resolves late on the no-proxy fallback path, where they previously never applied at all). Thanks to [@neuromante](https://github.com/neuromante) for the report (#24).
- Icons supplied through an app's own `IconThemePath` are now found wherever they live in that directory. The search only covered the theme root and `hicolor/{22x22,24x24,32x32}/apps/`, so apps that ship their icons under another category or size — Dropbox uses `hicolor/16x16/status/` — fell through to the pixmap fallback and, with no `IconPixmap` on offer, left a blank panel slot. The same size/category matrix as the host icon theme search is now used (#24).

## [1.16] - 2026-08-20

### Fixed
- Tray icons no longer show a blank panel slot when an app advertises an `IconName` that isn't present in the host icon theme. Telegram Desktop (`org.telegram.desktop-symbolic`) and Flameshot both do this while supplying a perfectly good `IconPixmap`; the icon name was passed to `set_icon_name` anyway, which claimed the slot and drew nothing. Unresolvable names now fall back to the app's own pixmap, and only drop back to `set_icon_name` if there is no usable pixmap either. Thanks to [@michaelbrylevskii](https://github.com/michaelbrylevskii) for the fix (#23).
  - Note: a few icon names that our lookup misses would still have rendered through `set_icon_name` via theme inheritance or a symbolic variant. Those now show the app's bitmap instead, so with Icon Style set to Symbolic they appear as a desaturated bitmap rather than a themed glyph. Setting a per-app icon override restores a themed icon.

## [1.15] - 2026-08-07

### Added
- Open Menu Shortcut setting under Appearance & Behaviour: an optional keyboard shortcut that opens the leftmost tray icon's menu and moves key focus into it, so the tray is reachable without a pointer. Left and Right then move between the open tray menus, and pressing the shortcut again closes the menu. When every icon is collapsed into the overflow button, the shortcut opens that instead. No shortcut is bound by default, the combination must include a modifier, and clashes with shortcuts used elsewhere are not detected. Thanks to [@weierophinney](https://github.com/weierophinney) for the request (#22).

### Fixed
- Menus no longer flash a "Loading..." placeholder every time they are opened. Reopening a menu previously cleared it and showed the placeholder while the `AboutToShow`/`GetLayout` D-Bus round-trip completed, causing two relayouts and visible flicker — especially on high-refresh-rate displays. The existing items now stay on screen and are swapped only once the new layout arrives. Thanks to [@adavidys](https://github.com/adavidys) for the fix (#21).

## [1.14] - 2026-07-25

### Added
- Icon interaction setting under Appearance & Behaviour: choose what a left click does — show the menu (default), open the app window (menu on right click), or open the app window on double click (menu on single click). Right click always shows the menu and middle click triggers the app's secondary action. Apps that expose no working activate action fall back to showing the menu. Thanks to [@zamszowy](https://github.com/zamszowy) for the request (#19).
- Padding between icons setting under Appearance: a slider from 0px to 20px (default 4px) controlling the gap between adjacent tray icons. The value is the total gap between two icons; both the inline tray icons and the overflow button re-space live. Thanks to [@zamszowy](https://github.com/zamszowy) for the request (#20).

## [1.13] - 2026-07-12

### Fixed
- Fixed the per-app icon effect preview showing a broken "image-missing" glyph for apps whose `IconName` is an absolute file path rather than a themed icon name (e.g. Rustdesk, which publishes `/run/user/<uid>/tray-icon/*.png`). The Effect Settings dialog passed the path straight to `Gtk.IconTheme.lookup_icon`, which treats it as a theme name and returns the missing-icon paintable. `_setIconFromName` now detects absolute paths and loads the file directly into the preview pixbuf, mirroring the main icon-list preview, so effects render against the real icon.
- Lowered the default brightness applied when recolouring pixmap/full-colour icons for symbolic (monochrome) mode in dark themes from `+0.50` to `-0.25`. The previous value over-brightened recoloured icons and washed them out; the new default keeps them legible. Light mode is unchanged (`-0.5`). The default is kept in sync between the live tray (`extension.js`) and the effect dialog (`prefs.js`).

## [1.12] - 2026-07-10

### Added
- Icon Size setting under Appearance: a slider from 14px to 20px (default 16px). Main tray icons and the overflow button resize live to match.
- Overflow button icon now offers a fourth mode — Custom icon. Selecting it reveals a Custom overflow icon row; click Choose… to pick a theme icon or an image file (PNG/SVG), rendered as-is at the configured icon size. Falls back to the bundled overflow glyph if no icon is chosen or the chosen file is missing.

## [1.11] - 2026-06-15

### Added
- Overflow button can show a live preview of hidden tray icons in place of the bundled glyph. Thanks to [@krissedout](https://github.com/krissedout) for the dynamic preview feature.
- Overflow button icon now offers three modes — Static icon (default), Dynamic preview (colour), and Dynamic preview (monochrome). The dynamic previews show up to four hidden tray icons and set their colour treatment independently of the global Icon Style, and the monochrome preview adds a separating outline so overlapping icons stay legible.

## [1.10] - 2026-05-23

### Changed
- Inline icon limit can now be set as low as `0`, collapsing every tray item into the overflow menu (Windows-style). Previously the minimum was `1`, which always forced at least one icon to stay inline. Thanks to [@krissedout](https://github.com/krissedout) for the suggestion and patch.
- Tray popup menus are now centered under the icon that opened them, matching the behavior of the AppIndicator/KStatusNotifierItem Support extension. Previously the menu aligned with the icon's left edge. Thanks to [@The-Best-Codes](https://github.com/The-Best-Codes) for the report (#14).

## [1.9] - 2026-05-13

### Added
- Menu items now render `icon-name` and `icon-data` properties from the DBusMenu specification. Apps that publish per-item icons (e.g. those using libdbusmenu-glib/qt with explicit icon properties) will see them rendered next to each menu entry, including on submenu headers. `icon-data` is decoded as PNG bytes via `Gio.BytesIcon`; `icon-name` is resolved through the system icon theme.

### Fixed
- Overflow menu rows now respect the global Icon Style setting and per-app icon effect overrides (desaturation, brightness/contrast, tint). Previously the rows mirrored only the raw icon source, so an app set to symbolic in the panel would still render full-colour in the overflow popup. `_applySymbolicStyle` now accepts a target icon and is invoked on each row's `St.Icon` after the source is mirrored, reusing the same effect pipeline as the panel.
- Fixed overflow menu icons disappearing and randomly re-appearing for pixmap-backed apps (Electron/Flatpak and `IconPixmap`-fallback clients). Menu rows now mirror the tray icon's `Clutter.Content` when `gicon` and `icon_name` are both null, and reset every potential icon source before each refresh so switching branches (e.g. pixmap → named) no longer leaves stale state behind. Thanks to [@W1zardK1ng](https://github.com/W1zardK1ng) for the report.
- Fixed the most recently registered app's overflow row remaining stuck on the loading placeholder until the next app registered. The initial async icon load wasn't emitting `display-changed`, so the overflow button never refreshed; the signal is now emitted from every icon-style update path.
- Fixed duplicate tray icons for apps like Cloudflare's `warp-taskbar` that register via the spec-canonical `org.kde.StatusNotifierItem-PID-ID` well-known name. The watcher's bus-address discriminator regex now accepts hyphens (per the D-Bus name grammar), so both the proactive scan and `RegisterStatusNotifierItem` resolve to the same unique connection name and the existing dedup catches the second registration. Thanks to [@rncoll7](https://github.com/rncoll7) for the report and fix.

## [1.8] - 2026-05-04

### Fixed
- Fixed tray icons going blank for apps whose `IconName` resolves to a FreeDesktop category outside the previously-searched set (e.g. `folder-remote-symbolic` in `places/`). The icon theme search now covers `places`, `mimetypes`, `emotes`, `categories`, `emblems`, `ui`, and the `applications` alias in addition to the existing categories.
- Fixed the GTK fall-through path silently rendering nothing when the manual theme walk missed an icon. The fall-through now resolves via `St.IconTheme.lookup_icon` and routes through the working `gicon` path; the bare `set_icon_name` call is now a true last resort.
- Fixed Ubuntu's update-notifier icons (and other SNI clients that sit at `Status='Passive'` between events) being shown in the tray. Per the StatusNotifierItem spec, Passive items are now hidden until the app transitions to Active or NeedsAttention. Overflow slot accounting ignores Passive items so they don't push real icons into the overflow popup.

## [1.7] - 2026-04-20

### Added
- Optional panel overflow. When enabled from preferences, any tray icons beyond a user-chosen inline limit collapse into a single overflow button at the right end of the tray. Each collapsed app is accessible as an inline submenu that lazily loads the app's own menu on first open, with live updates to the row's icon and title. The overflow button ships its own symbolic and full-colour glyphs that track the global Icon Style setting. Disabled by default.

### Changed
- Icon customization dialog no longer closes when an icon is picked (grid, "Choose File...", or "Reset to Default"). The dialog stays open so fallback/lock/title-alias switches remain reachable in the same visit; dismiss via the titlebar close button when finished. Selections continue to save to GSettings as they are made.
- Preferences About row now uses the bundled Status Tray icon instead of the generic `preferences-system-symbolic` glyph.

## [1.6] - 2026-04-17

### Added
- Opt-in "Match by App Name" toggle in icon customization for apps (e.g. Karing) that randomize their SNI Id on every launch. When enabled, per-app settings are keyed by the app's display name instead of the unstable process-derived ID, so custom icons and other preferences persist across app restarts. Thanks to [@paveleremin](https://github.com/paveleremin) for the report.

### Changed
- Tightened horizontal padding on tray icons so multiple icons group compactly, matching the density of the native GNOME panel icons and the AppIndicator extension. Thanks to [@paveleremin](https://github.com/paveleremin) for the suggestion.

### Fixed
- Title-alias resolution now re-runs when an app's `Title` or `ToolTip` properties arrive after the initial D-Bus proxy init (common for Electron-style apps). Previously, apps that populated `Title` slightly late would keep their unstable SNI Id as the settings key after a restart until the extension itself was reloaded.
- Per-app settings migration when the appId changes now covers all keyed settings (icon overrides, icon effect overrides, fallback list, lock list) instead of only `app-order` and `disabled-apps`.
- Effect Settings dialog preview now matches the actual tray icon. The preview's contrast formula now uses Clutter's `tan((c+1)·π/4)` mapping instead of treating the slider value as a direct multiplier, and the tint formula uses luminance weights to match `Clutter.ColorizeEffect`. Symbolic icons also correctly skip desaturation/brightness/contrast in the preview, matching tray behaviour.
- Icon picker's "Current Icon" preview now shows the actual icon the app is displaying (including pixmap-backed icons from Electron/Flatpak apps) instead of falling back to a generic placeholder when the icon name can't be looked up in the GTK theme.

### Changed
- Icon theme inheritance is now resolved asynchronously at startup instead of via synchronous file reads, in line with GNOME extension review guidelines.
- Tray item menu and D-Bus proxy signals are now explicitly disconnected, and the watcher's exported D-Bus object reference released, on disable. Improves hygiene around suspend/resume and re-enable cycles.

## [1.5] - 2026-03-18

### Changed
- Confirmed GNOME 50 compatibility and updated manifest.

## [1.4] - 2026-03-12

### Fixed
- Fixed panel item identifiers containing ephemeral D-Bus bus names (e.g. `StatusTray-:1.770/org/ayatana/NotificationItem/steam`), causing extensions like Top Bar Organizer to lose saved icon positions on every app restart or reboot. Panel items now use stable app-derived identifiers (e.g. `StatusTray-steam`).
- Fixed icon overrides lost after suspend/resume for non-Flatpak Electron apps (e.g. Element). Dynamic ToolTip titles like "Element | Room Name" are now normalized to a stable base name so overrides persist across state changes. Thanks to [@3Lord3](https://github.com/3Lord3) for the report.

## [1.3] - 2026-02-20

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
- Fixed old icon widget not being destroyed when replacing with an override, leaking Clutter effects.
- Deduplicated menu toggle ornament code into shared helper.

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
