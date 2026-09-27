import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    extractFlatpakAppId,
    findIconInTheme,
    isSymbolicIconFileName,
    precomputeThemeChain,
    readFlatpakAppPath,
    resetThemeChain,
    resolveIconFile,
} from './iconLookup.js';

const DEBUG = false;
function debug(msg) {
    if (DEBUG)
        console.log(`[StatusTray/prefs] ${msg}`);
}

// GTK4 DnD with custom GObject types is unreliable, so we track the dragged
// row at module level as a workaround.
let _draggedRow = null;

// The effect preview sits on the stock GNOME top bar colour for the panel's
// current light/dark state, so the chosen settings read as they will in the
// panel rather than against this window's background.
const EFFECT_PREVIEW_CSS = `
.status-tray-effect-preview { padding: 12px; border-radius: 12px; }
.status-tray-effect-preview.panel-dark { background-color: #000000; }
.status-tray-effect-preview.panel-light { background-color: #fafafb; }
`;

// Window size, from libadwaita 1.9 metrics at the default text scale. The
// width must stay above 600: at or below that, AdwPreferencesWindow moves its
// page switcher out of the header bar into a bar along the bottom.
const PREFS_WIDTH = 640;
const HEADER_BAR_HEIGHT = 46;
const PAGE_MARGINS = 48;
const GROUP_HEADER_HEIGHT = 57;
const FIRST_ROW_HEIGHT = 54;
const ROW_HEIGHT = 55;
// The tallest fixed page: Behaviour with the custom overflow icon row showing.
const MIN_PREFS_HEIGHT = 573;

// AdwPreferencesWindow offers no API for adding header bar widgets, so the
// main menu is packed into its private AdwHeaderBar. There is exactly one.
function findHeaderBar(widget) {
    if (widget instanceof Adw.HeaderBar)
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findHeaderBar(child);
        if (found)
            return found;
    }
    return null;
}

function cleanAppName(name) {
    if (!name) return null;

    let cleaned = name
        .replace(/\s*[-–—]\s*(Synced|Syncing|Paused|Error|Offline|Online|Connected|Disconnected).*$/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();

    cleaned = cleaned
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return cleaned || null;
}

// Normalize a ToolTip title for use as a stable app ID.
// Strips dynamic suffixes like " | Room Name" or " — Channel" that
// Electron apps (e.g. Element) append based on current state.
function normalizeToolTipId(toolTipTitle) {
    for (const sep of [' | ', ' — ', ' - ']) {
        const idx = toolTipTitle.indexOf(sep);
        if (idx > 0) {
            toolTipTitle = toolTipTitle.substring(0, idx);
            break;
        }
    }
    // Strip trailing bracketed/parenthesised counts e.g. "Element [1]", "App (3)"
    toolTipTitle = toolTipTitle.replace(/\s*[\[(]\d+[\])]\s*$/, '').trim();
    return toolTipTitle;
}

// The host icon theme, as the shell reads it (St.Settings' gtk-icon-theme is
// this same setting), for the icon search shared with the tray.
function getIconThemeName() {
    return new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' }).get_string('icon-theme');
}

// Move per-app settings entries from an old appId key to a new one across
// every keyed setting (list or dict). No-op if the old key is absent.
function migrateAppIdAcrossSettings(settings, oldId, newId) {
    if (!oldId || !newId || oldId === newId)
        return;

    const moveInStrv = (key) => {
        const list = settings.get_strv(key);
        const oldIdx = list.indexOf(oldId);
        const hasNew = list.includes(newId);
        if (oldIdx === -1 && !hasNew)
            return;
        if (hasNew && oldIdx !== -1)
            list.splice(oldIdx, 1);
        else if (oldIdx !== -1)
            list[oldIdx] = newId;
        settings.set_strv(key, list);
    };

    const moveInDict = (key) => {
        const dict = settings.get_value(key).deep_unpack();
        if (!(oldId in dict))
            return;
        if (!(newId in dict))
            dict[newId] = dict[oldId];
        delete dict[oldId];
        settings.set_value(key, new GLib.Variant('a{ss}', dict));
    };

    moveInStrv('app-order');
    moveInStrv('disabled-apps');
    moveInStrv('icon-fallback-overrides');
    moveInStrv('icon-lock-overrides');
    moveInDict('icon-overrides');
    moveInDict('icon-effect-overrides');
}

const AppRow = GObject.registerClass(
class AppRow extends Adw.ActionRow {
    _init(appId, busName, objectPath, settings, window, onReorder, rebuildAppsGroup) {
        super._init({
            title: appId,  // Will be updated async with display name
            subtitle: appId,
            subtitle_lines: 1,
        });

        this._appId = appId;
        this._busName = busName;
        this._objectPath = objectPath;
        this._settings = settings;
        this._window = window;
        this._onReorder = onReorder;
        this._rebuildAppsGroup = rebuildAppsGroup;
        this._displayName = appId;
        this._currentIconName = null;
        this._iconThemePath = null;
        this._iconSource = null;
        this._flatpakAppPath = null;

        this._dragHandle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            pixel_size: 16,
            css_classes: ['dim-label'],
            tooltip_text: 'Drag to reorder',
        });
        this.add_prefix(this._dragHandle);

        this._iconButton = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: 'Change icon',
        });
        this._iconImage = new Gtk.Image({
            icon_name: 'application-x-executable-symbolic',
            pixel_size: 24,
        });
        this._iconButton.set_child(this._iconImage);
        this._iconButton.connect('clicked', () => this._openIconPicker());
        this.add_prefix(this._iconButton);

        this._switch = new Gtk.Switch({
            active: true,
            valign: Gtk.Align.CENTER,
        });

        const disabledApps = this._settings.get_strv('disabled-apps');
        this._switch.set_active(!disabledApps.includes(appId));

        this._switch.connect('notify::active', () => {
            this._onToggled();
        });

        this._tuneButton = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: 'Customize icon effect',
        });
        this._tuneButton.set_child(new Gtk.Image({
            icon_name: 'preferences-color-symbolic',
            pixel_size: 16,
        }));
        this._tuneButton.connect('clicked', () => this._openEffectDialog());

        this.add_suffix(this._tuneButton);
        this.add_suffix(this._switch);
        this.set_activatable_widget(this._switch);

        this._setupDragAndDrop();
        this._fetchAppInfo();
    }

    _setupDragAndDrop() {
        debug(`[DnD] Setting up for ${this._appId}`);

        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.MOVE,
        });

        dragSource.connect('prepare', (_source, x, y) => {
            debug(`[DnD] prepare for ${this._appId} at (${x}, ${y})`);
            _draggedRow = this;
            const provider = Gdk.ContentProvider.new_for_value('app-row-drag');
            debug(`[DnD] ContentProvider created: ${provider}`);
            return provider;
        });

        dragSource.connect('drag-begin', (source, _drag) => {
            debug(`[DnD] drag-begin for ${this._appId}`);
            const paintable = new Gtk.WidgetPaintable({ widget: this });
            source.set_icon(paintable, 0, 0);
            this.add_css_class('drag-active');
        });

        dragSource.connect('drag-end', (_source, _drag, deleteData) => {
            debug(`[DnD] drag-end for ${this._appId}, deleteData=${deleteData}`);
            this.remove_css_class('drag-active');
            _draggedRow = null;
        });

        dragSource.connect('drag-cancel', (_source, _drag, reason) => {
            debug(`[DnD] drag-cancel for ${this._appId}, reason=${reason}`);
            return false;
        });

        this.add_controller(dragSource);

        debug(`[DnD] Creating DropTarget for ${this._appId}`);
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);

        dropTarget.connect('accept', (_target, _drop) => {
            const dominated = _draggedRow && _draggedRow !== this;
            debug(`[DnD] accept on ${this._appId}: _draggedRow=${_draggedRow?._appId}, dominated=${dominated}`);
            return dominated;
        });

        dropTarget.connect('enter', (_target, x, y) => {
            debug(`[DnD] enter on ${this._appId} at (${x}, ${y})`);
            this.add_css_class('drop-target');
            return Gdk.DragAction.MOVE;
        });

        dropTarget.connect('leave', (_target) => {
            debug(`[DnD] leave on ${this._appId}`);
            this.remove_css_class('drop-target');
        });

        dropTarget.connect('drop', (_target, value, _x, _y) => {
            debug(`[DnD] DROP on ${this._appId}! value="${value}", type=${typeof value}`);
            debug(`[DnD] _draggedRow=${_draggedRow?._appId}`);

            const sourceRow = _draggedRow;
            if (!sourceRow) {
                debug(`[DnD] No sourceRow, rejecting`);
                return false;
            }
            if (sourceRow === this) {
                debug(`[DnD] Dropped on self, rejecting`);
                return false;
            }

            const droppedAppId = sourceRow._appId;
            debug(`[DnD] SUCCESS: Dropped ${droppedAppId} onto ${this._appId}`);

            if (this._onReorder) {
                this._onReorder(droppedAppId, this._appId);
            }

            return true;
        });

        this.add_controller(dropTarget);
        debug(`[DnD] Setup complete for ${this._appId}`);
    }

    get appId() {
        return this._appId;
    }

    async _fetchAppInfo() {
        if (!this._busName || !this._objectPath) {
            debug(`No bus info for ${this._appId}, skipping SNI fetch`);
            return;
        }

        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

        try {
            const [idReply, titleReply, iconNameReply, iconThemePathReply, toolTipReply, flatpakAppPath] = await Promise.all([
                this._dbusGetProperty(this._bus, 'Id'),
                this._dbusGetProperty(this._bus, 'Title'),
                this._dbusGetProperty(this._bus, 'IconName'),
                this._dbusGetProperty(this._bus, 'IconThemePath'),
                this._dbusGetProperty(this._bus, 'ToolTip'),
                readFlatpakAppPath(this._busName),
            ]);
            // Host location of a Flatpak app's /app, for icon paths it names
            // inside its sandbox.
            this._flatpakAppPath = flatpakAppPath;

            const id = idReply ? idReply.deep_unpack() : null;
            const title = titleReply ? titleReply.deep_unpack() : null;
            const iconName = iconNameReply ? iconNameReply.deep_unpack() : null;
            this._iconThemePath = iconThemePathReply ? iconThemePathReply.deep_unpack() : null;

            // Extract tooltip title - ToolTip is (sa(iiay)ss): icon_name, icon_pixmap, title, description
            let toolTipTitle = null;
            if (toolTipReply) {
                try {
                    const toolTip = toolTipReply.deep_unpack();
                    // toolTip is [icon_name, icon_pixmap_array, title, description]
                    if (toolTip && toolTip.length >= 3 && toolTip[2]) {
                        toolTipTitle = toolTip[2];
                    }
                } catch (e) {
                    debug(`Failed to parse ToolTip: ${e.message}`);
                }
            }

            // Resolve app ID using priority order (same as extension.js):
            // 1. SNI Id (stable across sessions, unless generic chrome_status_icon_*)
            // 2. Flatpak app ID from IconThemePath
            // 3. ToolTip title (fallback for Electron apps with generic SNI Ids)
            // 4. Keep existing fallback from object path
            const oldAppId = this._appId;
            let newAppId = null;

            if (id && id.length > 0 && !id.startsWith(':') && !id.startsWith('chrome_status_icon_')) {
                newAppId = id;
                debug(`Got app ID from SNI Id: ${newAppId}`);
            } else if (this._iconThemePath) {
                const flatpakId = extractFlatpakAppId(this._iconThemePath);
                if (flatpakId) {
                    newAppId = flatpakId;
                    debug(`Got app ID from Flatpak IconThemePath: ${newAppId}`);
                }
            }

            if (!newAppId && toolTipTitle && toolTipTitle.length > 0) {
                newAppId = normalizeToolTipId(toolTipTitle);
                debug(`Got app ID from ToolTip title: ${newAppId}`);
            }

            // Determine the tentative display name early so we can consult
            // the title-aliases map; an alias hit supersedes the SNI-derived ID.
            let tentativeDisplayName = null;
            if (title && title.length > 0)
                tentativeDisplayName = cleanAppName(title);
            else if (toolTipTitle && toolTipTitle.length > 0)
                tentativeDisplayName = cleanAppName(normalizeToolTipId(toolTipTitle));
            else if (id && id.length > 0 && !id.startsWith('chrome_status_icon_'))
                tentativeDisplayName = cleanAppName(id);

            if (tentativeDisplayName) {
                const aliases = this._settings.get_value('title-aliases').deep_unpack();
                if (aliases[tentativeDisplayName]) {
                    newAppId = aliases[tentativeDisplayName];
                    debug(`Using title alias for "${tentativeDisplayName}": ${newAppId}`);
                }
            }

            if (newAppId && newAppId !== oldAppId) {
                migrateAppIdAcrossSettings(this._settings, oldAppId, newAppId);
                this._appId = newAppId;
                this.set_subtitle(newAppId);
                const disabledApps = this._settings.get_strv('disabled-apps');
                this._switch.set_active(!disabledApps.includes(this._appId));
                this._rebuildAppsGroup();
                debug(`Updated appId from ${oldAppId} to ${this._appId}`);
            }

            // Display name priority: Title > ToolTip title > Id
            if (title && title.length > 0) {
                this._displayName = cleanAppName(title) || this._appId;
            } else if (toolTipTitle && toolTipTitle.length > 0) {
                this._displayName = cleanAppName(toolTipTitle) || this._appId;
            } else if (id && id.length > 0) {
                // Fall back to Id (but skip generic chrome_status_icon_N names)
                if (!id.startsWith('chrome_status_icon_')) {
                    this._displayName = cleanAppName(id) || this._appId;
                }
            }

            this.set_title(this._displayName);
            debug(`Display name for ${this._appId}: ${this._displayName}`);

            if (iconName && iconName.length > 0) {
                this._currentIconName = iconName;
            }

            this._updateIcon();

        } catch (e) {
            debug(`Failed to fetch app info for ${this._appId}: ${e.message}`);
        }
    }

    // Resolve the icon the way the tray does (TrayItem._updateIcon and
    // _setIcon), sharing its file search through iconLookup.js, so the list
    // shows what the panel shows. The effect dialog previews whatever this
    // settles on (this._iconSource) instead of looking the icon up again.
    _updateIcon() {
        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        const overrideIcon = overrides[this._appId];
        const fallbackOnly = !!overrideIcon &&
            this._settings.get_strv('icon-fallback-overrides').includes(this._appId);

        if (overrideIcon && !fallbackOnly) {
            if (overrideIcon.startsWith('/'))
                this._setIconFromPath(overrideIcon);
            else
                this._setIconSource({ iconName: overrideIcon });
            return;
        }

        // A fallback-only override stands in when the app gives no IconName.
        const iconName = this._currentIconName || (fallbackOnly ? overrideIcon : null);
        if (!iconName) {
            this._fetchIconPixmap(null, true);
            return;
        }

        const path = resolveIconFile(iconName, this._iconThemePath, getIconThemeName(),
            this._flatpakAppPath);
        if (path) {
            this._setIconFromPath(path);
            return;
        }

        // An IconThemePath the search couldn't use is usually a sandboxed
        // app's; like the tray, try its pixmap next, then the host theme.
        if (this._iconThemePath) {
            this._fetchIconPixmap(iconName, false);
            return;
        }

        if (this._getIconTheme().has_icon(iconName)) {
            this._setIconSource({ iconName });
            return;
        }

        debug(`Icon ${iconName} not in theme, trying IconPixmap`);
        this._fetchIconPixmap(iconName, true);
    }

    _getIconTheme() {
        return Gtk.IconTheme.get_for_display(this._iconButton.get_display());
    }

    // Show the app's IconPixmap. Without a usable one, fall back as the tray
    // does: the host theme by name (unless the caller already searched it),
    // then a generic icon.
    async _fetchIconPixmap(iconName, skipThemeSearch) {
        const pixmaps = await this._fetchValidPixmaps();
        if (pixmaps.length > 0) {
            try {
                let bestPixmap = pixmaps[0];
                let bestSize = bestPixmap[0];
                const targetSize = 24;

                for (const pixmap of pixmaps) {
                    const width = pixmap[0];
                    if (width >= 16 && width <= 48) {
                        if (Math.abs(width - targetSize) < Math.abs(bestSize - targetSize)) {
                            bestPixmap = pixmap;
                            bestSize = width;
                        }
                    }
                }

                const [width, height, pixelData] = bestPixmap;
                debug(`Using IconPixmap ${width}x${height} for ${this._appId}`);

                const rgbaData = this._argbToRgba(pixelData, width, height);
                const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                    rgbaData,
                    GdkPixbuf.Colorspace.RGB,
                    true,  // has_alpha
                    8,     // bits_per_sample
                    width,
                    height,
                    width * 4  // rowstride
                );

                const tempPath = GLib.build_filenamev([
                    GLib.get_tmp_dir(),
                    `status-tray-prefs-${this._appId.replace(/[^a-zA-Z0-9]/g, '_')}.png`,
                ]);
                pixbuf.savev(tempPath, 'png', [], []);

                // Keep every size for the effect dialog's larger preview.
                this._setIconFromPath(tempPath, pixmaps);
                return;
            } catch (e) {
                debug(`Failed to use IconPixmap for ${this._appId}: ${e.message}`);
            }
        }

        const path = iconName && !skipThemeSearch
            ? findIconInTheme(iconName, getIconThemeName())
            : null;
        if (path) {
            this._setIconFromPath(path);
            return;
        }
        if (iconName && this._getIconTheme().has_icon(iconName)) {
            this._setIconSource({ iconName });
            return;
        }
        this._setIconSource({ iconName: 'application-x-executable-symbolic' });
    }

    // Some apps return empty 0x0 pixmaps, or no IconPixmap property at all.
    async _fetchValidPixmaps() {
        if (!this._bus || !this._busName || !this._objectPath)
            return [];
        const reply = await this._dbusGetProperty(this._bus, 'IconPixmap');
        const pixmaps = reply ? reply.deep_unpack() : [];
        return pixmaps.filter(p => p[0] > 0 && p[1] > 0 && p[2].length > 0);
    }

    // IconPixmap uses big-endian ARGB, GdkPixbuf wants RGBA
    _argbToRgba(argbData, width, height) {
        const pixels = width * height;
        const rgba = new Uint8Array(pixels * 4);

        for (let i = 0; i < pixels; i++) {
            const srcOffset = i * 4;
            const dstOffset = i * 4;

            const a = argbData[srcOffset];
            const r = argbData[srcOffset + 1];
            const g = argbData[srcOffset + 2];
            const b = argbData[srcOffset + 3];

            rgba[dstOffset] = r;
            rgba[dstOffset + 1] = g;
            rgba[dstOffset + 2] = b;
            rgba[dstOffset + 3] = a;
        }

        return GLib.Bytes.new(rgba);
    }

    _setIconFromPath(path, pixmaps = null) {
        if (Gio.File.new_for_path(path).query_exists(null))
            this._setIconSource({ path, pixmaps });
        else
            this._setIconSource({ iconName: 'application-x-executable-symbolic' });
    }

    // What the row shows, kept for the effect dialog: a file `path` (with the
    // app's `pixmaps` when the file is one written from them), or a themed
    // `iconName`.
    _setIconSource(source) {
        this._iconSource = source;
        if (source.path)
            this._iconImage.set_from_gicon(Gio.FileIcon.new(Gio.File.new_for_path(source.path)));
        else
            this._iconImage.set_from_icon_name(source.iconName);
    }

    _dbusGetProperty(bus, propertyName) {
        return new Promise((resolve, _reject) => {
            bus.call(
                this._busName,
                this._objectPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', propertyName]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                1000,  // 1 second timeout
                null,
                (conn, result) => {
                    try {
                        const reply = conn.call_finish(result);
                        const [variant] = reply.deep_unpack();
                        resolve(variant);
                    } catch (e) {
                        resolve(null);
                    }
                }
            );
        });
    }

    _onToggled() {
        const disabledApps = this._settings.get_strv('disabled-apps');
        const isEnabled = this._switch.get_active();

        if (isEnabled) {
            const index = disabledApps.indexOf(this._appId);
            if (index > -1) {
                disabledApps.splice(index, 1);
            }
        } else {
            if (!disabledApps.includes(this._appId)) {
                disabledApps.push(this._appId);
            }
        }

        this._settings.set_strv('disabled-apps', disabledApps);
    }

    _openIconPicker() {
        const dialog = new IconPickerDialog(
            this._appId,
            this._displayName,
            this._currentIconName,
            this._iconImage.gicon,
            this._settings,
            this._window
        );
        dialog.connect('icon-selected', (_dlg, _iconName) => {
            this._updateIcon();
        });
        dialog.present();
    }

    _openEffectDialog() {
        const dialog = new IconEffectDialog(
            this._appId,
            this._displayName,
            this._iconSource,
            this._settings,
            this._window
        );
        dialog.present();
    }
});

// The icon picker and effect dialogs are separate windows rather than
// Adw.Dialogs, which live inside the preferences window and get clipped when
// their content is taller than it. As transient, modal windows they size to
// their own content and sit over the preferences window. Escape closes them,
// as it did when they were Adw.Dialogs.
function addEscapeToClose(window) {
    const controller = new Gtk.ShortcutController();
    controller.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
        action: Gtk.NamedAction.new('window.close'),
    }));
    window.add_controller(controller);
}

const IconPickerDialog = GObject.registerClass({
    Signals: {
        'icon-selected': { param_types: [GObject.TYPE_STRING] },
    },
}, class IconPickerDialog extends Adw.Window {
    _init(appId, displayName, currentIconName, currentIconGicon, settings, parentWindow, options = null) {
        const simpleKey = options?.simpleKey ?? null;
        super._init({
            title: options?.title ?? `Icon for ${displayName}`,
            modal: true,
            transient_for: parentWindow,
            default_width: 450,
            default_height: 700,
        });
        addEscapeToClose(this);

        this._appId = appId;
        this._displayName = displayName;
        this._settings = settings;
        this._currentIconName = currentIconName;
        this._currentIconGicon = currentIconGicon;
        this._simpleKey = simpleKey;
        this._allIcons = [];  // Cache of discovered icons

        const toolbarView = new Adw.ToolbarView();
        this.set_content(toolbarView);

        toolbarView.add_top_bar(new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        }));

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        toolbarView.set_content(content);

        const previewGroup = new Adw.PreferencesGroup({
            title: 'Current Icon',
        });
        content.append(previewGroup);

        const currentOverride = simpleKey
            ? (settings.get_string(simpleKey) || null)
            : (settings.get_value('icon-overrides').deep_unpack()[appId] || null);

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

        if (!simpleKey) {
            const fallbackApps = settings.get_strv('icon-fallback-overrides');
            this._fallbackRow = new Adw.SwitchRow({
                title: 'Use as Fallback Only',
                subtitle: 'Only apply when the app sends a low-quality icon or no icon',
            });
            this._fallbackRow.set_active(fallbackApps.includes(appId));
            previewGroup.add(this._fallbackRow);

            this._fallbackRow.connect('notify::active', () => {
                const apps = this._settings.get_strv('icon-fallback-overrides');
                const index = apps.indexOf(this._appId);
                if (this._fallbackRow.get_active() && index === -1) {
                    apps.push(this._appId);
                } else if (!this._fallbackRow.get_active() && index > -1) {
                    apps.splice(index, 1);
                }
                this._settings.set_strv('icon-fallback-overrides', apps);

                // Lock is incompatible with fallback — disable it when fallback is on
                if (this._fallbackRow.get_active()) {
                    this._lockRow.set_active(false);
                    this._lockRow.set_sensitive(false);
                } else {
                    this._lockRow.set_sensitive(true);
                }
            });

            const lockApps = settings.get_strv('icon-lock-overrides');
            this._lockRow = new Adw.SwitchRow({
                title: 'Ignore App Status Icons',
                subtitle: 'Keep the chosen icon even when the app changes its status icon',
            });
            this._lockRow.set_active(lockApps.includes(appId));
            // Disable lock when fallback is active
            if (this._fallbackRow.get_active())
                this._lockRow.set_sensitive(false);
            previewGroup.add(this._lockRow);

            this._lockRow.connect('notify::active', () => {
                const apps = this._settings.get_strv('icon-lock-overrides');
                const index = apps.indexOf(this._appId);
                if (this._lockRow.get_active() && index === -1) {
                    apps.push(this._appId);
                } else if (!this._lockRow.get_active() && index > -1) {
                    apps.splice(index, 1);
                }
                this._settings.set_strv('icon-lock-overrides', apps);
            });

            const aliases = settings.get_value('title-aliases').deep_unpack();
            this._aliasRow = new Adw.SwitchRow({
                title: 'Match by App Name',
                subtitle: `Identify this app as "${displayName}" instead of its process ID. Enable for apps that randomize their ID on every launch.`,
            });
            this._aliasRow.set_active(aliases[displayName] !== undefined);
            previewGroup.add(this._aliasRow);

            this._aliasRow.connect('notify::active', () => {
                const map = this._settings.get_value('title-aliases').deep_unpack();
                if (this._aliasRow.get_active()) {
                    if (map[this._displayName] === undefined) {
                        map[this._displayName] = this._displayName;
                        this._settings.set_value('title-aliases', new GLib.Variant('a{ss}', map));
                    }
                    if (this._appId !== this._displayName) {
                        migrateAppIdAcrossSettings(this._settings, this._appId, this._displayName);
                        this._appId = this._displayName;
                    }
                } else {
                    if (map[this._displayName] !== undefined) {
                        delete map[this._displayName];
                        this._settings.set_value('title-aliases', new GLib.Variant('a{ss}', map));
                    }
                }
            });
        }

        const filterBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        content.append(filterBox);

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search icons...',
            hexpand: true,
        });
        filterBox.append(searchEntry);

        const categoryModel = new Gtk.StringList();
        categoryModel.append('Symbolic');
        categoryModel.append('Applications');
        categoryModel.append('All');

        this._categoryDropdown = new Gtk.DropDown({
            model: categoryModel,
            selected: 0,
        });
        filterBox.append(this._categoryDropdown);

        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vexpand: true,
            min_content_height: 250,
        });
        content.append(scrolled);

        this._iconGrid = new Gtk.FlowBox({
            homogeneous: true,
            max_children_per_line: 8,
            min_children_per_line: 5,
            selection_mode: Gtk.SelectionMode.SINGLE,
            row_spacing: 4,
            column_spacing: 4,
        });
        scrolled.set_child(this._iconGrid);

        this._loadAllIcons();
        this._searchEntry = searchEntry;
        this._populateIconGrid('', 0);

        searchEntry.connect('search-changed', () => {
            this._populateIconGrid(searchEntry.get_text(), this._categoryDropdown.selected);
        });

        this._categoryDropdown.connect('notify::selected', () => {
            this._populateIconGrid(searchEntry.get_text(), this._categoryDropdown.selected);
        });

        this._iconGrid.connect('child-activated', (_grid, child) => {
            const image = child.get_child();
            const iconName = image._iconName;
            if (iconName) {
                this._selectIcon(iconName);
            }
        });

        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 12,
            halign: Gtk.Align.END,
        });
        content.append(buttonBox);

        const fileButton = new Gtk.Button({
            label: 'Choose File...',
        });
        fileButton.connect('clicked', () => this._chooseFile());
        buttonBox.append(fileButton);

        const resetButton = new Gtk.Button({
            label: 'Reset to Default',
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            this._clearOverride();
        });
        buttonBox.append(resetButton);
    }

    _getIconDisplayName(iconPath) {
        if (iconPath.startsWith('/')) {
            const parts = iconPath.split('/');
            return parts[parts.length - 1];
        }
        return iconPath;
    }

    _loadAllIcons() {
        try {
            const iconTheme = Gtk.IconTheme.get_for_display(this.get_display());

            this._allIcons = iconTheme.get_icon_names();
            debug(`Loaded ${this._allIcons.length} icons from theme`);

            this._allIcons.sort((a, b) => a.localeCompare(b));

        } catch (e) {
            debug(`Failed to load icons from theme: ${e.message}`);
            this._allIcons = [];
        }
    }

    // category: 0=Symbolic, 1=Applications, 2=All
    _populateIconGrid(filter, category = 0) {
        let child = this._iconGrid.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._iconGrid.remove(child);
            child = next;
        }

        const lowerFilter = filter.toLowerCase();
        let filteredIcons;

        let categoryFiltered;
        switch (category) {
            case 0: // Symbolic icons
                categoryFiltered = this._allIcons.filter(name => name.endsWith('-symbolic'));
                break;
            case 1: // Application icons
                categoryFiltered = this._allIcons.filter(name => {
                    if (name.endsWith('-symbolic')) return false;
                    // App icons use reverse-DNS naming or simple names
                    if (name.startsWith('com.') || name.startsWith('org.') ||
                        name.startsWith('io.') || name.startsWith('net.')) {
                        return true;
                    }
                    // Include tray-specific icons
                    if (name.includes('-tray')) return true;
                    // Simple names without dashes (e.g., "bitwarden", "nextcloud")
                    if (!name.includes('-')) return true;
                    return false;
                });
                break;
            case 2: // All icons
            default:
                categoryFiltered = this._allIcons;
                break;
        }

        if (filter.length === 0) {
            if (category === 0) {
                // Symbolic: show common system icons by default
                const priorityIcons = [
                    'network-', 'cloud-', 'mail-', 'user-', 'folder-',
                    'emblem-', 'dialog-', 'preferences-', 'system-',
                    'audio-', 'battery-', 'bluetooth-', 'weather-',
                    'media-', 'document-', 'edit-', 'application-',
                ];
                filteredIcons = categoryFiltered.filter(name =>
                    priorityIcons.some(p => name.startsWith(p))
                );
            } else {
                // Applications/All: show first N icons
                filteredIcons = categoryFiltered;
            }
            filteredIcons = filteredIcons.slice(0, 150);
        } else if (filter.length < 2) {
            // Very short filter - don't search yet
            filteredIcons = [];
        } else {
            // Search within category
            filteredIcons = categoryFiltered.filter(name =>
                name.toLowerCase().includes(lowerFilter)
            );
            filteredIcons = filteredIcons.slice(0, 150);
        }

        for (const iconName of filteredIcons) {
            const image = new Gtk.Image({
                icon_name: iconName,
                pixel_size: 24,
            });
            image._iconName = iconName;
            image.set_tooltip_text(iconName);

            const flowChild = new Gtk.FlowBoxChild();
            flowChild.set_child(image);
            this._iconGrid.append(flowChild);
        }

        if (filteredIcons.length === 0) {
            let message;
            if (filter.length > 0 && filter.length < 2) {
                message = 'Type at least 2 characters to search.';
            } else if (filter.length >= 2) {
                message = 'No icons found. Try a different search term.';
            } else {
                message = 'No icons available in this category.';
            }
            const label = new Gtk.Label({
                label: message,
                css_classes: ['dim-label'],
            });
            const flowChild = new Gtk.FlowBoxChild({
                selectable: false,
            });
            flowChild.set_child(label);
            this._iconGrid.append(flowChild);
        }
    }

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

    _chooseFile() {
        const dialog = new Gtk.FileDialog({
            title: 'Choose Icon',
            modal: true,
        });

        const filter = new Gtk.FileFilter();
        filter.set_name('Images');
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/svg+xml');

        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);
        dialog.set_filters(filters);

        dialog.open(this, null, (dlg, result) => {
            try {
                const file = dlg.open_finish(result);
                if (file) {
                    const path = file.get_path();
                    this._selectIcon(path);
                }
            } catch (e) {
                // User cancelled
            }
        });
    }

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
});

const IconEffectDialog = GObject.registerClass({
    Signals: {
        'effect-applied': {},
    },
}, class IconEffectDialog extends Adw.Window {
    _init(appId, displayName, iconSource, settings, parentWindow) {
        super._init({
            title: `Effect Settings for ${displayName}`,
            modal: true,
            transient_for: parentWindow,
            default_width: 400,
            default_height: 520,
        });
        addEscapeToClose(this);

        this._appId = appId;
        this._settings = settings;

        // The preview's backdrop colours, for as long as this dialog is open.
        this._cssProvider = new Gtk.CssProvider();
        this._cssProvider.load_from_string(EFFECT_PREVIEW_CSS);
        Gtk.StyleContext.add_provider_for_display(this.get_display(),
            this._cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._loadCurrentValues();

        const toolbarView = new Adw.ToolbarView();
        this.set_content(toolbarView);

        toolbarView.add_top_bar(new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        }));

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });
        toolbarView.set_content(content);

        const previewFrame = new Gtk.Frame({
            halign: Gtk.Align.CENTER,
            css_classes: ['status-tray-effect-preview',
                this._settings.get_boolean('panel-dark') ? 'panel-dark' : 'panel-light'],
        });
        content.append(previewFrame);

        this._previewImage = new Gtk.Image({
            pixel_size: 64,
            icon_name: 'image-loading-symbolic',  // Placeholder while loading
        });
        previewFrame.set_child(this._previewImage);

        this._originalPixbuf = null;

        const slidersGroup = new Adw.PreferencesGroup({
            title: 'Effect Parameters',
        });
        content.append(slidersGroup);

        this._desaturationRow = this._createSliderRow(
            'Desaturation',
            'Amount of colour removed (0 = full colour, 1 = grayscale)',
            0, 1, 0.05, this._desaturation
        );
        this._desaturationRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._desaturationRow);

        this._brightnessRow = this._createSliderRow(
            'Brightness',
            'Lighten or darken the icon',
            -1, 1, 0.05, this._brightness
        );
        this._brightnessRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._brightnessRow);

        this._contrastRow = this._createSliderRow(
            'Contrast',
            'Increase or decrease contrast',
            0, 2, 0.05, this._contrast
        );
        this._contrastRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._contrastRow);

        const tintGroup = new Adw.PreferencesGroup({
            title: 'Tint Colour',
        });
        content.append(tintGroup);

        const tintRow = new Adw.ActionRow({
            title: 'Custom Tint',
            subtitle: 'Apply a colour tint to the icon',
        });

        this._tintSwitch = new Gtk.Switch({
            active: this._useTint,
            valign: Gtk.Align.CENTER,
        });
        this._tintSwitch.connect('notify::active', () => {
            this._colorButton.set_sensitive(this._tintSwitch.get_active());
            this._updatePreview();
        });

        this._colorButton = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
            use_alpha: false,
        });
        const rgba = new Gdk.RGBA();
        rgba.red = this._tintColor[0];
        rgba.green = this._tintColor[1];
        rgba.blue = this._tintColor[2];
        rgba.alpha = 1.0;
        this._colorButton.set_rgba(rgba);
        this._colorButton.set_sensitive(this._useTint);
        this._colorButton.connect('color-set', () => this._updatePreview());

        tintRow.add_suffix(this._colorButton);
        tintRow.add_suffix(this._tintSwitch);
        tintGroup.add(tintRow);

        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 16,
            halign: Gtk.Align.END,
        });
        content.append(buttonBox);

        const resetButton = new Gtk.Button({
            label: 'Reset to Default',
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => this._resetToDefault());
        buttonBox.append(resetButton);

        const cancelButton = new Gtk.Button({
            label: 'Cancel',
        });
        cancelButton.connect('clicked', () => this.close());
        buttonBox.append(cancelButton);

        const applyButton = new Gtk.Button({
            label: 'Apply',
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => this._applyChanges());
        buttonBox.append(applyButton);

        // Last: rendering the preview reads the sliders and tint row above.
        this._loadPreviewSource(iconSource);
    }

    vfunc_close_request() {
        Gtk.StyleContext.remove_provider_for_display(this.get_display(), this._cssProvider);
        return super.vfunc_close_request();
    }

    _loadCurrentValues() {
        // Defaults - these match what extension.js uses in _applySymbolicStyle,
        // the same for a light or dark top bar
        this._desaturation = 1.0;
        this._brightness = -0.25;
        this._contrast = 0.6;
        this._useTint = false;
        this._tintColor = [1.0, 1.0, 1.0];

        try {
            const overrides = this._settings.get_value('icon-effect-overrides').deep_unpack();
            const overrideJson = overrides[this._appId];
            if (overrideJson) {
                const override = JSON.parse(overrideJson);
                if (override.desaturation !== undefined) this._desaturation = override.desaturation;
                if (override.brightness !== undefined) this._brightness = override.brightness;
                if (override.contrast !== undefined) this._contrast = override.contrast;
                if (override.useTint !== undefined) this._useTint = override.useTint;
                if (override.tintColor !== undefined) this._tintColor = override.tintColor;
            }
        } catch (e) {
            debug(`Failed to load effect override: ${e.message}`);
        }
    }

    // Preview the icon the app list row settled on, which it resolves the
    // same way the tray does, rather than looking it up again here.
    _loadPreviewSource(source) {
        try {
            if (source?.pixmaps) {
                this._setIconFromPixmap(source.pixmaps);
                return;
            }
            if (source?.path) {
                this._isSymbolicIcon = isSymbolicIconFileName(GLib.path_get_basename(source.path));
                this._setPreviewFromFile(source.path);
                return;
            }

            // A themed name the row found in the GTK icon theme. Use its
            // file so the effects can be applied to the pixels.
            const iconName = source?.iconName ?? 'application-x-executable-symbolic';
            this._isSymbolicIcon = iconName.endsWith('-symbolic');
            const paintable = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
                .lookup_icon(iconName, null, 64, 1, Gtk.TextDirection.NONE, 0);
            const path = paintable.get_file()?.get_path();
            if (path) {
                this._setPreviewFromFile(path);
                return;
            }
            this._previewImage.set_from_icon_name(iconName);
        } catch (e) {
            debug(`IconEffectDialog: Failed to load preview icon: ${e.message}`);
            this._previewImage.set_from_icon_name('application-x-executable-symbolic');
        }
    }

    _setIconFromPixmap(pixmaps) {
        this._isSymbolicIcon = false;
        let bestPixmap = pixmaps[0];
        let bestSize = bestPixmap[0];
        const targetSize = 64;

        for (const pixmap of pixmaps) {
            const width = pixmap[0];
            if (Math.abs(width - targetSize) < Math.abs(bestSize - targetSize)) {
                bestPixmap = pixmap;
                bestSize = width;
            }
        }

        const width = bestPixmap[0];
        const height = bestPixmap[1];
        const pixelData = bestPixmap[2];

        debug(`IconEffectDialog: Using IconPixmap ${width}x${height}`);

        const rgbaData = this._argbToRgba(pixelData, width, height);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            rgbaData,
            GdkPixbuf.Colorspace.RGB,
            true,
            8,
            width,
            height,
            width * 4
        );

        this._originalPixbuf = pixbuf;
        this._updatePreview();
    }

    _setPreviewFromFile(path) {
        this._originalPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 64, 64);
        this._updatePreview();
    }

    _argbToRgba(argbData, width, height) {
        const pixels = width * height;
        const rgba = new Uint8Array(pixels * 4);

        for (let i = 0; i < pixels; i++) {
            const srcOffset = i * 4;
            const dstOffset = i * 4;

            const a = argbData[srcOffset];
            const r = argbData[srcOffset + 1];
            const g = argbData[srcOffset + 2];
            const b = argbData[srcOffset + 3];

            rgba[dstOffset] = r;
            rgba[dstOffset + 1] = g;
            rgba[dstOffset + 2] = b;
            rgba[dstOffset + 3] = a;
        }

        return GLib.Bytes.new(rgba);
    }

    _createSliderRow(title, subtitle, min, max, step, initialValue) {
        const row = new Adw.ActionRow({
            title: title,
            subtitle: subtitle,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const slider = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                value: initialValue,
            }),
            draw_value: false,
            hexpand: true,
            width_request: 150,
        });

        const label = new Gtk.Label({
            label: initialValue.toFixed(2),
            width_chars: 5,
        });

        slider.connect('value-changed', () => {
            label.set_label(slider.get_value().toFixed(2));
        });

        box.append(slider);
        box.append(label);
        row.add_suffix(box);

        row._slider = slider;
        row._label = label;

        return row;
    }

    _updatePreview() {
        if (!this._originalPixbuf) {
            return;
        }

        const desaturation = this._desaturationRow._slider.get_value();
        const brightness = this._brightnessRow._slider.get_value();
        const contrast = this._contrastRow._slider.get_value();
        const useTint = this._tintSwitch.get_active();
        const tintRgba = this._colorButton.get_rgba();

        debug(`IconEffectDialog: Applying effects - desat=${desaturation}, bright=${brightness}, contrast=${contrast}, tint=${useTint}`);

        const srcPixbuf = this._originalPixbuf;
        const width = srcPixbuf.get_width();
        const height = srcPixbuf.get_height();
        const rowstride = srcPixbuf.get_rowstride();
        const hasAlpha = srcPixbuf.get_has_alpha();
        const nChannels = srcPixbuf.get_n_channels();
        const srcPixels = srcPixbuf.get_pixels();

        const newPixels = new Uint8Array(srcPixels.length);

        // Mirror the tray's effect chain so the preview matches the panel
        // icon. Clutter's shaders, in the order the tray runs them:
        //   DesaturateEffect:         rgb = mix(rgb, luminance, factor)
        //   BrightnessContrastEffect: rgb = rgb * M + O, where M = 1 + b and
        //                             O = 0 for b < 0, else M = 1 - b and O = b;
        //                             then rgb = (rgb - 0.5) * C + 0.5, where
        //                             C = tan((contrast + 1) * π/4)
        //   then, on a dark panel, ColorizeEffect (tint): rgb = luminance * tint
        //   or, on a light panel, LightPanelEffect:
        //                             rgb += 1 - luminance * (2 - glyph), where
        //                             glyph is the tint or the panel's text colour
        // Each effect renders to an 8-bit buffer, so values clamp in between.
        // Symbolic icons skip all of that: St paints them in the panel's text
        // colour, or the tint. Panel colours are stock GNOME's, for the
        // light/dark state the extension published.
        const panelDark = this._settings.get_boolean('panel-dark');
        const tint = useTint ? [tintRgba.red, tintRgba.green, tintRgba.blue] : null;
        const panelText = panelDark ? [0xff, 0xff, 0xff] : [0x22, 0x22, 0x26];
        const glyph = tint ? tint.map(c => c * 255) : panelText;
        const contrastClamped = Math.max(-1, Math.min(0.9999, contrast));
        const contrastFactor = Math.tan((contrastClamped + 1) * Math.PI / 4);
        const brightnessMultiplier = brightness < 0 ? 1 + brightness : 1 - brightness;
        const brightnessOffset = brightness < 0 ? 0 : brightness * 255;
        const clamp = v => Math.max(0, Math.min(255, v));
        const adjust = v => clamp(
            (v * brightnessMultiplier + brightnessOffset - 127.5) * contrastFactor + 127.5);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = y * rowstride + x * nChannels;

                let r = srcPixels[offset];
                let g = srcPixels[offset + 1];
                let b = srcPixels[offset + 2];
                const a = hasAlpha ? srcPixels[offset + 3] : 255;

                if (this._isSymbolicIcon) {
                    [r, g, b] = glyph;
                } else {
                    if (desaturation > 0) {
                        const L = 0.299 * r + 0.587 * g + 0.114 * b;
                        r = r + (L - r) * desaturation;
                        g = g + (L - g) * desaturation;
                        b = b + (L - b) * desaturation;
                    }

                    r = adjust(r);
                    g = adjust(g);
                    b = adjust(b);

                    if (!panelDark) {
                        const L = 0.299 * r + 0.587 * g + 0.114 * b;
                        r = r + 255 - L * (2 - glyph[0] / 255);
                        g = g + 255 - L * (2 - glyph[1] / 255);
                        b = b + 255 - L * (2 - glyph[2] / 255);
                    } else if (tint) {
                        const L = 0.299 * r + 0.587 * g + 0.114 * b;
                        r = L * tint[0];
                        g = L * tint[1];
                        b = L * tint[2];
                    }
                }

                newPixels[offset] = Math.max(0, Math.min(255, Math.round(r)));
                newPixels[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
                newPixels[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
                if (hasAlpha) {
                    newPixels[offset + 3] = a;
                }
            }
        }

        const newPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            GLib.Bytes.new(newPixels),
            GdkPixbuf.Colorspace.RGB,
            hasAlpha,
            8,
            width,
            height,
            rowstride
        );

        this._previewImage.set_from_pixbuf(newPixbuf);
    }

    _applyChanges() {
        const desaturation = this._desaturationRow._slider.get_value();
        const brightness = this._brightnessRow._slider.get_value();
        const contrast = this._contrastRow._slider.get_value();
        const useTint = this._tintSwitch.get_active();
        const tintRgba = this._colorButton.get_rgba();
        const tintColor = [tintRgba.red, tintRgba.green, tintRgba.blue];

        const override = {
            desaturation,
            brightness,
            contrast,
            useTint,
            tintColor,
        };

        const overrides = this._settings.get_value('icon-effect-overrides').deep_unpack();
        overrides[this._appId] = JSON.stringify(override);
        this._settings.set_value('icon-effect-overrides', new GLib.Variant('a{ss}', overrides));

        debug(`Saved effect override for ${this._appId}: ${JSON.stringify(override)}`);

        this.emit('effect-applied');
        this.close();
    }

    _resetToDefault() {
        const overrides = this._settings.get_value('icon-effect-overrides').deep_unpack();
        delete overrides[this._appId];
        this._settings.set_value('icon-effect-overrides', new GLib.Variant('a{ss}', overrides));

        debug(`Removed effect override for ${this._appId}`);

        this.emit('effect-applied');
        this.close();
    }
});

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

export default class StatusTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();

        // Resolve the icon theme's inheritance chain for the shared icon
        // search, as the extension does on enable.
        precomputeThemeChain(getIconThemeName()).catch(e => {
            debug(`Theme chain precompute failed: ${e.message}`);
        });

        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._signalIds = [];
        this._appRows = new Map();  // appId -> AppRow

        // Pages appear in the switcher in the order added. Apps comes first
        // because it is what most people open this window for.
        const appsPage = new Adw.PreferencesPage({
            title: 'Apps',
            icon_name: 'view-app-grid-symbolic',
        });
        window.add(appsPage);

        const appearancePage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(appearancePage);

        const behaviourPage = new Adw.PreferencesPage({
            title: 'Behaviour',
            icon_name: 'input-mouse-symbolic',
        });
        window.add(behaviourPage);

        const iconsGroup = new Adw.PreferencesGroup({
            title: 'Icons',
            description: 'How tray icons are drawn in the top bar',
        });
        appearancePage.add(iconsGroup);

        const iconModeRow = new Adw.ComboRow({
            title: 'Icon style',
            subtitle: 'How tray icons are displayed',
        });

        const iconModeModel = new Gtk.StringList();
        iconModeModel.append('Symbolic (monochrome)');
        iconModeModel.append('Original (colored)');
        iconModeRow.set_model(iconModeModel);

        const currentMode = this._settings.get_string('icon-mode');
        iconModeRow.set_selected(currentMode === 'symbolic' ? 0 : 1);

        iconModeRow.connect('notify::selected', () => {
            const selected = iconModeRow.get_selected();
            this._settings.set_string('icon-mode', selected === 0 ? 'symbolic' : 'original');
        });

        iconsGroup.add(iconModeRow);

        const iconSizeRow = new Adw.ActionRow({
            title: 'Size',
            subtitle: 'The size of icons in the top bar',
        });

        const iconSizeBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const iconSizeScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 14,
                upper: 20,
                step_increment: 1,
                page_increment: 1,
                value: this._settings.get_int('icon-size'),
            }),
            draw_value: false,
            round_digits: 0,
            hexpand: true,
            width_request: 160,
        });
        // Anchor the default at 16, which isn't the range midpoint (17).
        iconSizeScale.add_mark(16, Gtk.PositionType.BOTTOM, 'Default');

        const iconSizeValue = new Gtk.Label({
            label: `${this._settings.get_int('icon-size')} px`,
            width_chars: 5,
            xalign: 0,
        });

        iconSizeScale.connect('value-changed', () => {
            const px = Math.round(iconSizeScale.get_value());
            iconSizeValue.set_label(`${px} px`);
            if (this._settings.get_int('icon-size') !== px)
                this._settings.set_int('icon-size', px);
        });

        iconSizeBox.append(iconSizeScale);
        iconSizeBox.append(iconSizeValue);
        iconSizeRow.add_suffix(iconSizeBox);
        iconsGroup.add(iconSizeRow);

        const iconPaddingRow = new Adw.ActionRow({
            title: 'Padding between icons',
            subtitle: 'Gap in pixels between adjacent tray icons',
        });

        const iconPaddingBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const iconPaddingScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 1,
                value: this._settings.get_int('icon-padding'),
            }),
            draw_value: false,
            round_digits: 0,
            hexpand: true,
            width_request: 160,
        });
        iconPaddingScale.add_mark(4, Gtk.PositionType.BOTTOM, 'Default');

        const iconPaddingValue = new Gtk.Label({
            label: `${this._settings.get_int('icon-padding')} px`,
            width_chars: 5,
            xalign: 0,
        });

        iconPaddingScale.connect('value-changed', () => {
            const px = Math.round(iconPaddingScale.get_value());
            iconPaddingValue.set_label(`${px} px`);
            if (this._settings.get_int('icon-padding') !== px)
                this._settings.set_int('icon-padding', px);
        });

        iconPaddingBox.append(iconPaddingScale);
        iconPaddingBox.append(iconPaddingValue);
        iconPaddingRow.add_suffix(iconPaddingBox);
        iconsGroup.add(iconPaddingRow);

        const interactionGroup = new Adw.PreferencesGroup({
            title: 'Interaction',
            description: 'What happens when you reach for a tray icon',
        });
        behaviourPage.add(interactionGroup);

        const clickActionRow = new Adw.ComboRow({
            title: 'Click action',
            subtitle: 'Right click always shows the menu',
        });
        const clickActionModel = new Gtk.StringList();
        clickActionModel.append('Click for menu (default)');
        clickActionModel.append('Left click to open, Right click for menu');
        clickActionModel.append('Double-click to open, Click for menu');
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
        interactionGroup.add(clickActionRow);

        const placementGroup = new Adw.PreferencesGroup({
            title: 'Placement',
            description: 'Which part of the top bar holds the tray',
        });
        appearancePage.add(placementGroup);

        const panelPositionRow = new Adw.ComboRow({
            title: 'Panel position',
            subtitle: 'Which top bar box holds the tray icons',
        });
        const panelPositionModel = new Gtk.StringList();
        panelPositionModel.append('Left');
        panelPositionModel.append('Centre');
        panelPositionModel.append('Right');
        panelPositionRow.set_model(panelPositionModel);

        const panelPositionFactory = new Gtk.SignalListItemFactory();
        panelPositionFactory.connect('setup', (_factory, item) => {
            item.set_child(new Gtk.Label({ xalign: 0 }));
        });
        panelPositionFactory.connect('bind', (_factory, item) => {
            item.get_child().set_label(item.get_item().get_string());
        });
        panelPositionRow.set_factory(panelPositionFactory);

        const panelPositionValues = ['left', 'center', 'right'];
        const currentPanelPosition = this._settings.get_string('panel-position');
        const panelPositionIndex = panelPositionValues.indexOf(currentPanelPosition);
        const panelPositionDefault = panelPositionValues.indexOf('right');
        panelPositionRow.set_selected(panelPositionIndex < 0 ? panelPositionDefault : panelPositionIndex);

        panelPositionRow.connect('notify::selected', () => {
            const selected = panelPositionRow.get_selected();
            this._settings.set_string('panel-position', panelPositionValues[selected] ?? 'right');
        });
        placementGroup.add(panelPositionRow);

        // GTK offers no way to detect a clash with a system or third-party
        // shortcut, so the subtitle says so rather than pretending to check.
        const shortcutRow = new Adw.ActionRow({
            title: 'Open menu shortcut',
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
        interactionGroup.add(shortcutRow);

        const overflowGroup = new Adw.PreferencesGroup({
            title: 'Overflow',
            description: 'Collapse extra tray icons into a single button',
        });
        behaviourPage.add(overflowGroup);

        const overflowEnabledRow = new Adw.SwitchRow({
            title: 'Enable overflow',
            subtitle: 'Extra icons collapse into one button',
            active: this._settings.get_boolean('overflow-enabled'),
        });
        overflowEnabledRow.connect('notify::active', () => {
            this._settings.set_boolean('overflow-enabled', overflowEnabledRow.get_active());
        });
        overflowGroup.add(overflowEnabledRow);

        const overflowIconRow = new Adw.ComboRow({
            title: 'Button icon',
            subtitle: 'Standard icon, a live preview, or your own',
            sensitive: overflowEnabledRow.get_active(),
        });
        const overflowIconModel = new Gtk.StringList();
        overflowIconModel.append('Static icon');
        overflowIconModel.append('Dynamic preview (colour)');
        overflowIconModel.append('Dynamic preview (monochrome)');
        overflowIconModel.append('Custom icon');
        overflowIconRow.set_model(overflowIconModel);

        // Adw.ComboRow's default factory ellipsizes both the selected value and
        // the popup rows, truncating these longer labels. A plain Gtk.Label
        // doesn't ellipsize, so the popup sizes to the full text.
        const overflowIconFactory = new Gtk.SignalListItemFactory();
        overflowIconFactory.connect('setup', (_factory, item) => {
            item.set_child(new Gtk.Label({ xalign: 0 }));
        });
        overflowIconFactory.connect('bind', (_factory, item) => {
            item.get_child().set_label(item.get_item().get_string());
        });
        overflowIconRow.set_factory(overflowIconFactory);

        // ComboRow index ↔ stored value. Index order matches the appended rows.
        const overflowIconValues = ['static', 'dynamic-original', 'dynamic-symbolic', 'custom'];
        const currentOverflowIconStyle = this._settings.get_string('overflow-icon-style');
        let currentIndex = overflowIconValues.indexOf(currentOverflowIconStyle);
        if (currentIndex < 0) {
            // Legacy 'dynamic' followed icon-mode; anything else falls back to Static.
            currentIndex = currentOverflowIconStyle === 'dynamic'
                ? (this._settings.get_string('icon-mode') === 'symbolic' ? 2 : 1)
                : 0;
        }
        overflowIconRow.set_selected(currentIndex);

        overflowIconRow.connect('notify::selected', () => {
            const selected = overflowIconRow.get_selected();
            this._settings.set_string('overflow-icon-style', overflowIconValues[selected] ?? 'static');
            updateOverflowCustomVisibility();
        });
        overflowGroup.add(overflowIconRow);

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
            dialog.present();
        });

        const overflowCountRow = new Adw.SpinRow({
            title: 'Inline icon limit',
            subtitle: 'How many icons stay in the panel',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 1,
                value: this._settings.get_int('overflow-inline-count'),
            }),
            sensitive: overflowEnabledRow.get_active(),
        });
        overflowCountRow.connect('notify::value', () => {
            this._settings.set_int('overflow-inline-count', overflowCountRow.get_value());
        });
        overflowEnabledRow.connect('notify::active', () => {
            overflowCountRow.set_sensitive(overflowEnabledRow.get_active());
            overflowIconRow.set_sensitive(overflowEnabledRow.get_active());
            updateOverflowCustomVisibility();
        });
        overflowGroup.add(overflowCountRow);

        this._appsGroup = new Adw.PreferencesGroup({
            title: 'Tray Apps',
            description: 'Drag to reorder. Click the icon to customize. Toggle to show or hide.',
        });

        const resetOrderButton = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            tooltip_text: 'Reset icon order',
            css_classes: ['flat'],
        });
        resetOrderButton.connect('clicked', () => {
            this._settings.set_strv('app-order', []);
            this._rebuildAppsGroup();
        });
        this._appsGroup.set_header_suffix(resetOrderButton);

        appsPage.add(this._appsGroup);

        this._infoRow = new Adw.ActionRow({
            title: 'No apps detected yet',
            subtitle: 'Start an app with tray support (like Nextcloud, Discord, Slack) and it will appear here',
        });
        this._infoRow.add_prefix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            pixel_size: 24,
        }));

        this._populateAppsGroup();
        this._subscribeToSignals();

        // Sized once from the apps found above. Apps that start or quit later
        // scroll the list rather than resizing the window under the user.
        window.set_default_size(PREFS_WIDTH, this._preferredHeight(this._appRows.size));

        this._addAboutEntry(window, appearancePage);

        window.connect('close-request', () => {
            this._cleanup();
            return false;
        });
    }

    _preferredHeight(appCount) {
        const listHeight = appCount > 0
            ? FIRST_ROW_HEIGHT + ROW_HEIGHT * (appCount - 1)
            : 0;
        const wanted = HEADER_BAR_HEIGHT + PAGE_MARGINS + GROUP_HEADER_HEIGHT + listHeight;

        // The window's monitor is unknown until it maps, so cap against the
        // smallest one. GTK 4 has no work-area API; 85% leaves room for the
        // top bar.
        let ceiling = Infinity;
        const monitors = this._window.get_display().get_monitors();
        for (let i = 0; i < monitors.get_n_items(); i++)
            ceiling = Math.min(ceiling, monitors.get_item(i).get_geometry().height);

        return Math.max(MIN_PREFS_HEIGHT, Math.min(wanted, Math.round(ceiling * 0.85)));
    }

    _addAboutEntry(window, fallbackPage) {
        const actions = new Gio.SimpleActionGroup();
        const aboutAction = new Gio.SimpleAction({ name: 'about' });
        aboutAction.connect('activate', () => this._showAbout());
        actions.add_action(aboutAction);
        window.insert_action_group('status-tray', actions);

        const headerBar = findHeaderBar(window);
        if (headerBar) {
            const menu = new Gio.Menu();
            menu.append('About Status Tray', 'status-tray.about');
            headerBar.pack_end(new Gtk.MenuButton({
                icon_name: 'open-menu-symbolic',
                menu_model: menu,
                primary: true,
                tooltip_text: 'Main Menu',
            }));
            return;
        }

        // A future libadwaita might restructure the window so the header bar
        // can't be found. Keep About reachable from a row rather than losing it.
        const aboutGroup = new Adw.PreferencesGroup();
        const aboutRow = new Adw.ActionRow({
            title: 'About Status Tray',
            activatable: true,
            action_name: 'status-tray.about',
        });
        aboutRow.add_suffix(new Gtk.Image({
            icon_name: 'go-next-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        aboutGroup.add(aboutRow);
        fallbackPage.add(aboutGroup);
    }

    _showAbout() {
        // The app icon ships as a file, and AdwAboutDialog only takes a name.
        const iconsDir = GLib.build_filenamev([this.path, 'icons']);
        const iconTheme = Gtk.IconTheme.get_for_display(this._window.get_display());
        if (!(iconTheme.get_search_path() ?? []).includes(iconsDir))
            iconTheme.add_search_path(iconsDir);

        new Adw.AboutDialog({
            application_name: this.metadata.name,
            application_icon: 'status-tray',
            developer_name: 'Keith Vassallo',
            version: this.metadata['version-name'] ?? `${this.metadata.version}`,
            comments: 'Automatic system tray for StatusNotifierItem apps',
            website: this.metadata.url,
            issue_url: `${this.metadata.url}/issues`,
            license_type: Gtk.License.GPL_3_0_ONLY,
        }).present(this._window);
    }

    _subscribeToSignals() {
        const registeredId = this._bus.signal_subscribe(
            'org.kde.StatusNotifierWatcher',
            'org.kde.StatusNotifierWatcher',
            'StatusNotifierItemRegistered',
            '/StatusNotifierWatcher',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [itemId] = params.deep_unpack();
                debug(`SNI registered: ${itemId}`);
                this._onAppRegistered(itemId);
            }
        );
        this._signalIds.push(registeredId);

        const unregisteredId = this._bus.signal_subscribe(
            'org.kde.StatusNotifierWatcher',
            'org.kde.StatusNotifierWatcher',
            'StatusNotifierItemUnregistered',
            '/StatusNotifierWatcher',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [itemId] = params.deep_unpack();
                debug(`SNI unregistered: ${itemId}`);
                this._onAppUnregistered(itemId);
            }
        );
        this._signalIds.push(unregisteredId);

        debug('Subscribed to StatusNotifierWatcher signals');
    }

    _onAppRegistered(itemId) {
        const { appId, busName, objectPath } = this._parseItemId(itemId);

        if (this._appRows.has(appId)) {
            debug(`App ${appId} already in list, skipping`);
            return;
        }

        if (this._appRows.size === 0) {
            this._appsGroup.remove(this._infoRow);
        }

        const row = new AppRow(
            appId, busName, objectPath, this._settings, this._window,
            (draggedId, targetId) => this._handleReorder(draggedId, targetId),
            () => this._rebuildAppsGroup()
        );
        this._appRows.set(appId, row);
        this._appsGroup.add(row);

        this._ensureInAppOrder(appId);

        debug(`Added app row for ${appId}`);
    }

    _onAppUnregistered(itemId) {
        const { appId } = this._parseItemId(itemId);

        const row = this._appRows.get(appId);
        if (row) {
            this._appsGroup.remove(row);
            this._appRows.delete(appId);
            debug(`Removed app row for ${appId}`);

            if (this._appRows.size === 0) {
                this._appsGroup.add(this._infoRow);
            }
        }
    }

    _parseItemId(itemId) {
        // Parse SNI item format: "busName/objectPath" or "busName"
        let busName, objectPath;

        const firstSlash = itemId.indexOf('/');
        if (firstSlash > 0) {
            busName = itemId.substring(0, firstSlash);
            objectPath = itemId.substring(firstSlash);
        } else {
            busName = itemId;
            objectPath = '/StatusNotifierItem';
        }

        const appId = this._extractAppId(itemId);

        return { appId, busName, objectPath };
    }

    _populateAppsGroup() {
        const appIds = new Map();

        try {
            const reply = this._bus.call_sync(
                'org.kde.StatusNotifierWatcher',
                '/StatusNotifierWatcher',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );

            const [variant] = reply.deep_unpack();
            const items = variant.deep_unpack();

            for (const item of items) {
                const { appId, busName, objectPath } = this._parseItemId(item);
                appIds.set(appId, { busName, objectPath });
            }
        } catch (e) {
            debug(`Failed to get registered SNI items: ${e.message}`);
        }

        if (appIds.size === 0) {
            this._appsGroup.add(this._infoRow);
        } else {
            const appOrder = this._settings.get_strv('app-order');
            const sortedApps = Array.from(appIds.keys()).sort((a, b) => {
                const aIndex = appOrder.indexOf(a);
                const bIndex = appOrder.indexOf(b);
                if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
                if (aIndex !== -1) return -1;
                if (bIndex !== -1) return 1;
                return a.toLowerCase().localeCompare(b.toLowerCase());
            });

            for (const appId of sortedApps) {
                const { busName, objectPath } = appIds.get(appId);
                const row = new AppRow(
                    appId, busName, objectPath, this._settings, this._window,
                    (draggedId, targetId) => this._handleReorder(draggedId, targetId),
                    () => this._rebuildAppsGroup()
                );
                this._appRows.set(appId, row);
                this._appsGroup.add(row);

                this._ensureInAppOrder(appId);
            }
        }
    }

    // Format: ":1.xxx/objectPath" or ":1.xxx" or "org.app.Name/path"
    _extractAppId(item) {
        let objectPath;

        if (item.startsWith(':')) {
            const firstSlash = item.indexOf('/');
            if (firstSlash > 0) {
                objectPath = item.substring(firstSlash);
            } else {
                objectPath = '/StatusNotifierItem';
            }
        } else {
            const firstSlash = item.indexOf('/');
            if (firstSlash > 0) {
                objectPath = item.substring(firstSlash);
            } else {
                objectPath = '/StatusNotifierItem';
            }
        }

        // Try to get a nice name from the object path
        // e.g., "/org/ayatana/NotificationItem/nextcloud" -> "nextcloud"
        const pathParts = objectPath.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
            const lastPart = pathParts[pathParts.length - 1];
            if (lastPart !== 'StatusNotifierItem' && lastPart !== 'item') {
                return lastPart;
            }
        }

        const firstSlash = item.indexOf('/');
        return firstSlash > 0 ? item.substring(0, firstSlash) : item;
    }

    _ensureInAppOrder(appId) {
        const appOrder = this._settings.get_strv('app-order');
        if (!appOrder.includes(appId)) {
            appOrder.push(appId);
            this._settings.set_strv('app-order', appOrder);
            debug(`Added ${appId} to app-order`);
        }
    }

    _handleReorder(draggedId, targetId) {
        debug(`Reordering: moving ${draggedId} to position of ${targetId}`);

        const appOrder = this._settings.get_strv('app-order');

        if (!appOrder.includes(draggedId)) {
            appOrder.push(draggedId);
        }
        if (!appOrder.includes(targetId)) {
            appOrder.push(targetId);
        }

        const draggedIndex = appOrder.indexOf(draggedId);
        appOrder.splice(draggedIndex, 1);

        const newTargetIndex = appOrder.indexOf(targetId);
        appOrder.splice(newTargetIndex, 0, draggedId);

        this._settings.set_strv('app-order', appOrder);

        debug(`New app-order: ${appOrder.join(', ')}`);

        this._rebuildAppsGroup();
    }

    _rebuildAppsGroup() {
        const appOrder = this._settings.get_strv('app-order');

        const rows = Array.from(this._appRows.values());
        rows.sort((a, b) => {
            const aIndex = appOrder.indexOf(a._appId);
            const bIndex = appOrder.indexOf(b._appId);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return a._appId.toLowerCase().localeCompare(b._appId.toLowerCase());
        });

        for (const row of rows) {
            this._appsGroup.remove(row);
        }

        for (const row of rows) {
            this._appsGroup.add(row);
        }

        debug(`Rebuilt apps group with order: ${rows.map(r => r._appId).join(', ')}`);
    }

    _cleanup() {
        debug('Cleaning up preferences window');

        resetThemeChain();

        for (const signalId of this._signalIds)
            this._bus.signal_unsubscribe(signalId);

        this._signalIds = null;
        this._appRows = null;
        this._appsGroup = null;
        this._infoRow = null;
        this._bus = null;
        this._settings = null;
        this._window = null;

        _draggedRow = null;
    }
}
