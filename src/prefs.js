/**
 * Status Tray - Preferences UI
 *
 * GNOME 45+ libadwaita-based settings panel.
 * Allows users to:
 * - Toggle icon mode (symbolic/original)
 * - Enable/disable specific apps from the tray
 * - Override icons per-app
 * - Live updates when apps register/unregister
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Debug logging
const DEBUG = false;
function debug(msg) {
    if (DEBUG)
        console.log(`[StatusTray/prefs] ${msg}`);
}

// Module-level variable to track the currently dragged row
// GTK4 DnD with custom GObject types is unreliable, so we use this workaround
let _draggedRow = null;

/**
 * Clean up an app name for display
 * - Strips status suffixes (e.g., "Nextcloud - Synced" -> "Nextcloud")
 * - Capitalizes first letter
 * - Converts underscores/hyphens to spaces
 */
function cleanAppName(name) {
    if (!name) return null;

    // Strip common status suffixes
    let cleaned = name
        .replace(/\s*[-–—]\s*(Synced|Syncing|Paused|Error|Offline|Online|Connected|Disconnected).*$/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '')  // Remove trailing parenthetical
        .trim();

    // Convert underscores and hyphens to spaces, then capitalize words
    cleaned = cleaned
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return cleaned || null;
}

/**
 * Extract Flatpak app ID from IconThemePath
 * Flatpak apps have paths like: /run/user/1000/app/org.ferdium.Ferdium/.org.chromium.Chromium.xxx
 * Returns the app ID (e.g., "org.ferdium.Ferdium") or null if not a Flatpak path
 */
function extractFlatpakAppId(iconThemePath) {
    if (!iconThemePath) return null;
    const match = iconThemePath.match(/\/run\/user\/\d+\/app\/([^/]+)/);
    return match ? match[1] : null;
}

/**
 * AppRow - A row representing a single tray app with enable/disable toggle
 * and icon override button. Supports drag-and-drop reordering.
 */
const AppRow = GObject.registerClass(
class AppRow extends Adw.ActionRow {
    _init(appId, busName, objectPath, settings, window, onReorder) {
        super._init({
            title: appId,  // Will be updated async with display name
            subtitle: appId,
        });

        this._appId = appId;
        this._busName = busName;
        this._objectPath = objectPath;
        this._settings = settings;
        this._window = window;
        this._onReorder = onReorder;  // Callback for reorder events
        this._displayName = appId;  // Track for dialog title
        this._currentIconName = null;  // The app's actual icon (for reset)
        this._iconThemePath = null;  // For Electron apps
        this._resolvedIconSource = null;  // The actual icon path/name used for display (for effect dialog)

        // Drag handle (prefix) - visual indicator that row is draggable
        this._dragHandle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            pixel_size: 16,
            css_classes: ['dim-label'],
            tooltip_text: 'Drag to reorder',
        });
        this.add_prefix(this._dragHandle);

        // Icon button (prefix) - shows current icon, clickable for override
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

        // Create toggle switch (suffix)
        this._switch = new Gtk.Switch({
            active: true,
            valign: Gtk.Align.CENTER,
        });

        // Check if this app is disabled
        const disabledApps = this._settings.get_strv('disabled-apps');
        this._switch.set_active(!disabledApps.includes(appId));

        // Connect switch toggle
        this._switch.connect('notify::active', () => {
            this._onToggled();
        });

        // Effect tune button (suffix, left of switch) - opens effect customization dialog
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

        // Set up drag-and-drop
        this._setupDragAndDrop();

        // Fetch display name and icon asynchronously
        this._fetchAppInfo();
    }

    /**
     * Set up drag source and drop target for reordering
     * Uses a module-level variable to pass the dragged row reference
     * (GTK4 DnD with custom GObject types from GJS is unreliable)
     */
    _setupDragAndDrop() {
        debug(`[DnD] Setting up for ${this._appId}`);

        // Create drag source
        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.MOVE,
        });

        dragSource.connect('prepare', (source, x, y) => {
            debug(`[DnD] prepare for ${this._appId} at (${x}, ${y})`);
            _draggedRow = this;
            const provider = Gdk.ContentProvider.new_for_value('app-row-drag');
            debug(`[DnD] ContentProvider created: ${provider}`);
            return provider;
        });

        dragSource.connect('drag-begin', (source, drag) => {
            debug(`[DnD] drag-begin for ${this._appId}`);
            const paintable = new Gtk.WidgetPaintable({ widget: this });
            source.set_icon(paintable, 0, 0);
            this.add_css_class('drag-active');
        });

        dragSource.connect('drag-end', (source, drag, deleteData) => {
            debug(`[DnD] drag-end for ${this._appId}, deleteData=${deleteData}`);
            this.remove_css_class('drag-active');
            _draggedRow = null;
        });

        dragSource.connect('drag-cancel', (source, drag, reason) => {
            debug(`[DnD] drag-cancel for ${this._appId}, reason=${reason}`);
            return false;
        });

        this.add_controller(dragSource);

        // Create drop target that accepts strings
        debug(`[DnD] Creating DropTarget for ${this._appId}`);
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);

        dropTarget.connect('accept', (target, drop) => {
            const dominated = _draggedRow && _draggedRow !== this;
            debug(`[DnD] accept on ${this._appId}: _draggedRow=${_draggedRow?._appId}, dominated=${dominated}`);
            return dominated;
        });

        dropTarget.connect('enter', (target, x, y) => {
            debug(`[DnD] enter on ${this._appId} at (${x}, ${y})`);
            this.add_css_class('drop-target');
            return Gdk.DragAction.MOVE;
        });

        dropTarget.connect('leave', (target) => {
            debug(`[DnD] leave on ${this._appId}`);
            this.remove_css_class('drop-target');
        });

        dropTarget.connect('drop', (target, value, x, y) => {
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

    /**
     * Fetch Id, Title, IconName, IconThemePath, and IconPixmap from the SNI
     * This mirrors what extension.js does for displaying tray icons
     */
    async _fetchAppInfo() {
        if (!this._busName || !this._objectPath) {
            debug(`No bus info for ${this._appId}, skipping SNI fetch`);
            return;
        }

        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

        try {
            // Fetch all properties we need in parallel
            const [idReply, titleReply, iconNameReply, iconThemePathReply, toolTipReply] = await Promise.all([
                this._dbusGetProperty(this._bus, 'Id'),
                this._dbusGetProperty(this._bus, 'Title'),
                this._dbusGetProperty(this._bus, 'IconName'),
                this._dbusGetProperty(this._bus, 'IconThemePath'),
                this._dbusGetProperty(this._bus, 'ToolTip'),
            ]);

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
            // 1. ToolTip title (best for Electron apps like Ferdium, Bitwarden)
            // 2. Flatpak app ID from IconThemePath
            // 3. SNI Id (if not generic chrome_status_icon_*)
            // 4. Keep existing fallback from object path
            const oldAppId = this._appId;
            let newAppId = null;

            if (toolTipTitle && toolTipTitle.length > 0) {
                newAppId = toolTipTitle;
                debug(`Got app ID from ToolTip title: ${newAppId}`);
            } else if (this._iconThemePath) {
                const flatpakId = extractFlatpakAppId(this._iconThemePath);
                if (flatpakId) {
                    newAppId = flatpakId;
                    debug(`Got app ID from Flatpak IconThemePath: ${newAppId}`);
                }
            }

            if (!newAppId && id && id.length > 0 && !id.startsWith(':') && !id.startsWith('chrome_status_icon_')) {
                newAppId = id;
                debug(`Got app ID from SNI Id: ${newAppId}`);
            }

            if (newAppId && newAppId !== oldAppId) {
                this._appId = newAppId;
                this.set_subtitle(newAppId);  // Update subtitle to show stable ID
                debug(`Updated appId from ${oldAppId} to ${this._appId}`);
            }

            // Determine display name
            // Priority: Title > ToolTip title > Id
            // (Electron apps often have empty Title but good ToolTip)
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

            // Update UI with display name
            // Always set title since initial value may have been ephemeral bus name
            this.set_title(this._displayName);
            debug(`Display name for ${this._appId}: ${this._displayName}`);

            // Store the app's actual icon name for reset functionality
            if (iconName && iconName.length > 0) {
                this._currentIconName = iconName;
            }

            // Update icon - check for override first, then use app icon
            this._updateIcon();

        } catch (e) {
            debug(`Failed to fetch app info for ${this._appId}: ${e.message}`);
        }
    }

    /**
     * Update the icon display - respects overrides, handles IconThemePath
     * Mirrors the logic from extension.js TrayItem._setIcon()
     */
    _updateIcon() {
        // Check for icon override first
        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        const overrideIcon = overrides[this._appId];

        if (overrideIcon) {
            // Use override
            if (overrideIcon.startsWith('/')) {
                // File path
                this._setIconFromPath(overrideIcon);
            } else {
                this._iconImage.set_from_icon_name(overrideIcon);
                this._resolvedIconSource = overrideIcon;
            }
            return;
        }

        // No override - use app's icon
        if (!this._currentIconName) {
            // No icon name - try IconPixmap
            this._fetchIconPixmap();
            return;
        }

        // Check if it's already a file path
        if (this._currentIconName.startsWith('/')) {
            this._setIconFromPath(this._currentIconName);
            return;
        }

        // For Electron/Chromium apps, check IconThemePath for the actual file
        if (this._iconThemePath && this._iconThemePath.length > 0) {
            const possiblePaths = [
                `${this._iconThemePath}/${this._currentIconName}.png`,
                `${this._iconThemePath}/${this._currentIconName}.svg`,
                `${this._iconThemePath}/hicolor/22x22/apps/${this._currentIconName}.png`,
                `${this._iconThemePath}/hicolor/24x24/apps/${this._currentIconName}.png`,
                `${this._iconThemePath}/hicolor/32x32/apps/${this._currentIconName}.png`,
            ];

            for (const path of possiblePaths) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    debug(`Found icon file at: ${path}`);
                    this._setIconFromPath(path);
                    return;
                }
            }
        }

        // Check if icon exists in the current theme before using it
        // Try to get display from button, fall back to default display
        let iconTheme;
        try {
            const display = this._iconButton.get_display();
            if (display) {
                iconTheme = Gtk.IconTheme.get_for_display(display);
            }
        } catch (e) {
            // Widget not yet realized
        }

        if (!iconTheme) {
            // Fall back to default display
            const defaultDisplay = Gdk.Display.get_default();
            if (defaultDisplay) {
                iconTheme = Gtk.IconTheme.get_for_display(defaultDisplay);
            }
        }

        if (iconTheme && iconTheme.has_icon(this._currentIconName)) {
            this._iconImage.set_from_icon_name(this._currentIconName);
            this._resolvedIconSource = this._currentIconName;
            return;
        }

        // Icon name not found in theme - try IconPixmap as fallback
        debug(`Icon ${this._currentIconName} not in theme, trying IconPixmap`);
        this._fetchIconPixmap();
    }

    /**
     * Fetch IconPixmap from the SNI and display it
     * This is used when IconName isn't available or isn't in the theme
     */
    async _fetchIconPixmap() {
        if (!this._bus || !this._busName || !this._objectPath) {
            this._iconImage.set_from_icon_name('application-x-executable-symbolic');
            return;
        }

        try {
            const pixmapReply = await this._dbusGetProperty(this._bus, 'IconPixmap');
            if (!pixmapReply) {
                debug(`No IconPixmap for ${this._appId}`);
                this._iconImage.set_from_icon_name('application-x-executable-symbolic');
                return;
            }

            const pixmaps = pixmapReply.deep_unpack();
            if (!pixmaps || pixmaps.length === 0) {
                debug(`Empty IconPixmap for ${this._appId}`);
                this._iconImage.set_from_icon_name('application-x-executable-symbolic');
                return;
            }

            // Pick the best size - prefer something close to 24px
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

            const width = bestPixmap[0];
            const height = bestPixmap[1];
            const pixelData = bestPixmap[2];

            debug(`Using IconPixmap ${width}x${height} for ${this._appId}`);

            // Convert ARGB to RGBA and create a pixbuf
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

            // Save to temp file and use as icon
            const tempPath = GLib.build_filenamev([
                GLib.get_tmp_dir(),
                `status-tray-prefs-${this._appId.replace(/[^a-zA-Z0-9]/g, '_')}.png`
            ]);
            pixbuf.savev(tempPath, 'png', [], []);

            this._setIconFromPath(tempPath);

        } catch (e) {
            debug(`Failed to fetch IconPixmap for ${this._appId}: ${e.message}`);
            this._iconImage.set_from_icon_name('application-x-executable-symbolic');
        }
    }

    /**
     * Convert ARGB pixel data (network byte order) to RGBA
     * IconPixmap uses big-endian ARGB: each pixel is [A, R, G, B]
     * GdkPixbuf wants RGBA: each pixel is [R, G, B, A]
     */
    _argbToRgba(argbData, width, height) {
        const pixels = width * height;
        const rgba = new Uint8Array(pixels * 4);

        for (let i = 0; i < pixels; i++) {
            const srcOffset = i * 4;
            const dstOffset = i * 4;

            // ARGB (big-endian) -> RGBA
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

    _setIconFromPath(path) {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null)) {
            const gicon = Gio.FileIcon.new(file);
            this._iconImage.set_from_gicon(gicon);
            this._resolvedIconSource = path;  // Track for effect dialog
        } else {
            this._iconImage.set_from_icon_name('application-x-executable-symbolic');
            this._resolvedIconSource = null;
        }
    }

    _dbusGetProperty(bus, propertyName) {
        return new Promise((resolve, reject) => {
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
                        resolve(null);  // Property not available, that's ok
                    }
                }
            );
        });
    }

    _onToggled() {
        const disabledApps = this._settings.get_strv('disabled-apps');
        const isEnabled = this._switch.get_active();

        if (isEnabled) {
            // Remove from disabled list
            const index = disabledApps.indexOf(this._appId);
            if (index > -1) {
                disabledApps.splice(index, 1);
            }
        } else {
            // Add to disabled list
            if (!disabledApps.includes(this._appId)) {
                disabledApps.push(this._appId);
            }
        }

        this._settings.set_strv('disabled-apps', disabledApps);
    }

    _openIconPicker() {
        // Pass the display name for the dialog title
        const dialog = new IconPickerDialog(
            this._appId,
            this._displayName,
            this._currentIconName,
            this._settings,
            this._window
        );
        dialog.connect('icon-selected', (dlg, iconName) => {
            // Update our icon display (iconName may be null for reset)
            this._updateIcon();
        });
        dialog.present(this._window);
    }

    _openEffectDialog() {
        // Pass bus info so the dialog can fetch the icon fresh from D-Bus
        const dialog = new IconEffectDialog(
            this._appId,
            this._displayName,
            this._busName,
            this._objectPath,
            this._settings,
            this._window
        );
        dialog.present(this._window);
    }
});

/**
 * IconPickerDialog - Dialog for selecting an icon override
 */
const IconPickerDialog = GObject.registerClass({
    Signals: {
        'icon-selected': { param_types: [GObject.TYPE_STRING] },
    },
}, class IconPickerDialog extends Adw.Dialog {
    _init(appId, displayName, currentIconName, settings, parentWindow) {
        super._init({
            title: `Icon for ${displayName}`,
            content_width: 450,
            content_height: 550,
        });

        this._appId = appId;
        this._settings = settings;
        this._currentIconName = currentIconName;
        this._parentWindow = parentWindow;
        this._allIcons = [];  // Cache of discovered icons

        // Main content with toolbar view for proper header
        const toolbarView = new Adw.ToolbarView();
        this.set_child(toolbarView);

        // Header bar
        const headerBar = new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        });
        toolbarView.add_top_bar(headerBar);

        // Content box
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        toolbarView.set_content(content);

        // Current icon preview
        const previewGroup = new Adw.PreferencesGroup({
            title: 'Current Icon',
        });
        content.append(previewGroup);

        const overrides = settings.get_value('icon-overrides').deep_unpack();
        const currentOverride = overrides[appId] || null;

        this._previewImage = new Gtk.Image({
            icon_name: currentOverride || currentIconName || 'application-x-executable-symbolic',
            pixel_size: 48,
        });

        const previewRow = new Adw.ActionRow({
            title: currentOverride ? this._getIconDisplayName(currentOverride) : 'Default',
            subtitle: currentOverride ? 'Custom override' : 'Using app-provided icon',
        });
        previewRow.add_prefix(this._previewImage);
        previewGroup.add(previewRow);
        this._previewRow = previewRow;

        // Search and filter row
        const filterBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        content.append(filterBox);

        // Search entry
        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search icons...',
            hexpand: true,
        });
        filterBox.append(searchEntry);

        // Category dropdown
        const categoryModel = new Gtk.StringList();
        categoryModel.append('Symbolic');
        categoryModel.append('Applications');
        categoryModel.append('All');

        this._categoryDropdown = new Gtk.DropDown({
            model: categoryModel,
            selected: 0,
        });
        filterBox.append(this._categoryDropdown);

        // Scrolled window for icon grid
        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vexpand: true,
            min_content_height: 250,
        });
        content.append(scrolled);

        // Icon grid
        this._iconGrid = new Gtk.FlowBox({
            homogeneous: true,
            max_children_per_line: 8,
            min_children_per_line: 5,
            selection_mode: Gtk.SelectionMode.SINGLE,
            row_spacing: 4,
            column_spacing: 4,
        });
        scrolled.set_child(this._iconGrid);

        // Load all icons from the theme
        this._loadAllIcons();

        // Store search entry reference for use in callbacks
        this._searchEntry = searchEntry;

        // Populate with initial icons
        this._populateIconGrid('', 0);

        // Connect search
        searchEntry.connect('search-changed', () => {
            this._populateIconGrid(searchEntry.get_text(), this._categoryDropdown.selected);
        });

        // Connect category dropdown
        this._categoryDropdown.connect('notify::selected', () => {
            this._populateIconGrid(searchEntry.get_text(), this._categoryDropdown.selected);
        });

        // Handle icon selection
        this._iconGrid.connect('child-activated', (grid, child) => {
            const image = child.get_child();
            const iconName = image._iconName;
            if (iconName) {
                this._selectIcon(iconName);
            }
        });

        // Buttons row
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 12,
            halign: Gtk.Align.END,
        });
        content.append(buttonBox);

        // Custom file button
        const fileButton = new Gtk.Button({
            label: 'Choose File...',
        });
        fileButton.connect('clicked', () => this._chooseFile());
        buttonBox.append(fileButton);

        // Reset button
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
            // Extract filename from path
            const parts = iconPath.split('/');
            return parts[parts.length - 1];
        }
        return iconPath;
    }

    /**
     * Load all available icons from the icon theme
     */
    _loadAllIcons() {
        try {
            const iconTheme = Gtk.IconTheme.get_for_display(this.get_display());

            // Get all icon names from the theme
            // This returns thousands of icons - we'll filter in _populateIconGrid
            this._allIcons = iconTheme.get_icon_names();
            debug(`Loaded ${this._allIcons.length} icons from theme`);

            // Sort alphabetically
            this._allIcons.sort((a, b) => a.localeCompare(b));

        } catch (e) {
            debug(`Failed to load icons from theme: ${e.message}`);
            this._allIcons = [];
        }
    }

    /**
     * Populate the icon grid based on search filter and category
     * @param {string} filter - Search filter text
     * @param {number} category - 0=Symbolic, 1=Applications, 2=All
     */
    _populateIconGrid(filter, category = 0) {
        // Clear existing children
        let child = this._iconGrid.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._iconGrid.remove(child);
            child = next;
        }

        const lowerFilter = filter.toLowerCase();
        let filteredIcons;

        // Apply category filter first
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

        // Apply search filter
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

        // Add icons to grid
        for (const iconName of filteredIcons) {
            const image = new Gtk.Image({
                icon_name: iconName,
                pixel_size: 24,
            });
            // Store icon name on the image for retrieval
            image._iconName = iconName;

            // Tooltip with full icon name
            image.set_tooltip_text(iconName);

            const flowChild = new Gtk.FlowBoxChild();
            flowChild.set_child(image);
            this._iconGrid.append(flowChild);
        }

        // Show message if no results
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

    _selectIcon(iconName) {
        // Save override
        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        overrides[this._appId] = iconName;
        this._settings.set_value('icon-overrides', new GLib.Variant('a{ss}', overrides));

        // Update preview
        this._previewImage.set_from_icon_name(iconName);
        this._previewRow.set_title(this._getIconDisplayName(iconName));
        this._previewRow.set_subtitle('Custom override');

        // Emit signal and close
        this.emit('icon-selected', iconName);
        this.close();
    }

    _chooseFile() {
        const dialog = new Gtk.FileDialog({
            title: 'Choose Icon',
            modal: true,
        });

        // File filter for images
        const filter = new Gtk.FileFilter();
        filter.set_name('Images');
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/svg+xml');

        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);
        dialog.set_filters(filters);

        dialog.open(this._parentWindow, null, (dlg, result) => {
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
        // Remove override
        const overrides = this._settings.get_value('icon-overrides').deep_unpack();
        delete overrides[this._appId];
        this._settings.set_value('icon-overrides', new GLib.Variant('a{ss}', overrides));

        // Update preview to show app's default icon
        const defaultIcon = this._currentIconName || 'application-x-executable-symbolic';
        this._previewImage.set_from_icon_name(defaultIcon);
        this._previewRow.set_title('Default');
        this._previewRow.set_subtitle('Using app-provided icon');

        // Emit signal (null means reset) and close
        this.emit('icon-selected', '');
        this.close();
    }
});

/**
 * IconEffectDialog - Dialog for customizing per-icon symbolic effect parameters
 * Allows users to tweak desaturation, brightness, contrast, and optional tint colour
 * Fetches icon fresh from D-Bus to show current state (including any dynamic overlays)
 */
const IconEffectDialog = GObject.registerClass({
    Signals: {
        'effect-applied': {},
    },
}, class IconEffectDialog extends Adw.Dialog {
    _init(appId, displayName, busName, objectPath, settings, parentWindow) {
        super._init({
            title: `Effect Settings for ${displayName}`,
            content_width: 400,
            content_height: 520,
        });

        this._appId = appId;
        this._busName = busName;
        this._objectPath = objectPath || '/StatusNotifierItem';
        this._settings = settings;
        this._parentWindow = parentWindow;

        // Load current override values or defaults
        this._loadCurrentValues();

        // Main content with toolbar view
        const toolbarView = new Adw.ToolbarView();
        this.set_child(toolbarView);

        // Header bar
        const headerBar = new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        });
        toolbarView.add_top_bar(headerBar);

        // Content box
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });
        toolbarView.set_content(content);

        // Preview section
        const previewFrame = new Gtk.Frame({
            halign: Gtk.Align.CENTER,
        });
        content.append(previewFrame);

        this._previewImage = new Gtk.Image({
            pixel_size: 64,
            icon_name: 'image-loading-symbolic',  // Placeholder while loading
        });
        previewFrame.set_child(this._previewImage);

        // Store original pixbuf for effect processing
        this._originalPixbuf = null;

        // Fetch icon fresh from D-Bus
        this._fetchIconFromDbus();

        // Sliders group
        const slidersGroup = new Adw.PreferencesGroup({
            title: 'Effect Parameters',
        });
        content.append(slidersGroup);

        // Desaturation slider (0-1)
        this._desaturationRow = this._createSliderRow(
            'Desaturation',
            'Amount of colour removed (0 = full colour, 1 = grayscale)',
            0, 1, 0.05, this._desaturation
        );
        this._desaturationRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._desaturationRow);

        // Brightness slider (-1 to 1)
        this._brightnessRow = this._createSliderRow(
            'Brightness',
            'Lighten or darken the icon',
            -1, 1, 0.05, this._brightness
        );
        this._brightnessRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._brightnessRow);

        // Contrast slider (0-2)
        this._contrastRow = this._createSliderRow(
            'Contrast',
            'Increase or decrease contrast',
            0, 2, 0.05, this._contrast
        );
        this._contrastRow._slider.connect('value-changed', () => this._updatePreview());
        slidersGroup.add(this._contrastRow);

        // Tint section
        const tintGroup = new Adw.PreferencesGroup({
            title: 'Tint Colour',
        });
        content.append(tintGroup);

        // Tint enable row with colour button
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

        // Colour button
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

        // Buttons row
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 16,
            halign: Gtk.Align.END,
        });
        content.append(buttonBox);

        // Reset button
        const resetButton = new Gtk.Button({
            label: 'Reset to Default',
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => this._resetToDefault());
        buttonBox.append(resetButton);

        // Cancel button
        const cancelButton = new Gtk.Button({
            label: 'Cancel',
        });
        cancelButton.connect('clicked', () => this.close());
        buttonBox.append(cancelButton);

        // Apply button
        const applyButton = new Gtk.Button({
            label: 'Apply',
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => this._applyChanges());
        buttonBox.append(applyButton);

        // Initial preview update
        this._updatePreview();
    }

    _loadCurrentValues() {
        // Detect if we're in dark mode to match tray defaults
        const styleManager = Adw.StyleManager.get_default();
        const isDark = styleManager.get_dark();

        // Defaults - these match what extension.js uses in _applySymbolicStyle
        this._desaturation = 1.0;
        this._brightness = isDark ? 0.5 : -0.5;  // Match tray: lighten in dark mode, darken in light mode
        this._contrast = 0.6;
        this._useTint = false;
        this._tintColor = [1.0, 1.0, 1.0];

        // Load from settings
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

    /**
     * Fetch the icon fresh from D-Bus to show current state
     * This ensures we see the actual icon including any dynamic overlays
     */
    async _fetchIconFromDbus() {
        if (!this._busName) {
            debug(`No bus name for effect dialog, using fallback icon`);
            this._previewImage.set_from_icon_name('application-x-executable-symbolic');
            return;
        }

        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

        try {
            // First try IconPixmap (what Electron apps use)
            const pixmapReply = await this._dbusGetProperty(bus, 'IconPixmap');
            if (pixmapReply) {
                const pixmaps = pixmapReply.deep_unpack();
                // Check that we have valid pixmap data (some apps return empty 0x0 pixmaps)
                const validPixmaps = pixmaps?.filter(p => p[0] > 0 && p[1] > 0 && p[2]?.length > 0);
                if (validPixmaps && validPixmaps.length > 0) {
                    debug(`IconEffectDialog: Got IconPixmap with ${validPixmaps.length} valid sizes for ${this._appId}`);
                    this._setIconFromPixmap(validPixmaps);
                    return;
                }
            }

            // Fall back to IconName
            const iconNameReply = await this._dbusGetProperty(bus, 'IconName');
            if (iconNameReply) {
                const iconName = iconNameReply.deep_unpack();
                if (iconName && iconName.length > 0) {
                    debug(`IconEffectDialog: Got IconName "${iconName}" for ${this._appId}`);
                    this._setIconFromName(iconName);
                    return;
                }
            }

            debug(`IconEffectDialog: No icon found for ${this._appId}`);
            this._setIconFromName('application-x-executable-symbolic');

        } catch (e) {
            debug(`IconEffectDialog: Failed to fetch icon: ${e.message}`);
            this._previewImage.set_from_icon_name('application-x-executable-symbolic');
        }
    }

    _dbusGetProperty(bus, propertyName) {
        return new Promise((resolve, reject) => {
            bus.call(
                this._busName,
                this._objectPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', propertyName]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                1000,
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

    /**
     * Set preview icon from IconPixmap data
     */
    _setIconFromPixmap(pixmaps) {
        // Pick the best size - prefer something close to 64px for the preview
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

        // Convert ARGB to RGBA and create a pixbuf
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

        // Store original and update preview with effects
        this._originalPixbuf = pixbuf;
        this._updatePreview();
    }

    /**
     * Set preview icon from icon name (load as pixbuf from theme)
     */
    _setIconFromName(iconName) {
        try {
            const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
            const iconPaintable = iconTheme.lookup_icon(
                iconName,
                null,  // fallbacks
                64,    // size
                1,     // scale
                Gtk.TextDirection.NONE,
                Gtk.IconLookupFlags.FORCE_REGULAR
            );

            if (iconPaintable) {
                const file = iconPaintable.get_file();
                if (file) {
                    const path = file.get_path();
                    if (path) {
                        this._originalPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 64, 64);
                        this._updatePreview();
                        return;
                    }
                }
            }
        } catch (e) {
            debug(`IconEffectDialog: Failed to load icon from theme: ${e.message}`);
        }

        // Fallback - just show the icon without effects
        this._previewImage.set_from_icon_name(iconName);
    }

    /**
     * Convert ARGB pixel data (network byte order) to RGBA
     */
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

        // Store slider reference on the row for easy access
        row._slider = slider;
        row._label = label;

        return row;
    }

    _updatePreview() {
        // If no original pixbuf yet, nothing to do
        if (!this._originalPixbuf) {
            return;
        }

        // Get current slider values
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

        // Create new pixel data array
        const newPixels = new Uint8Array(srcPixels.length);

        // Process each pixel
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = y * rowstride + x * nChannels;

                let r = srcPixels[offset];
                let g = srcPixels[offset + 1];
                let b = srcPixels[offset + 2];
                const a = hasAlpha ? srcPixels[offset + 3] : 255;

                // Step 1: Desaturate (convert to grayscale)
                if (desaturation > 0) {
                    // Use luminance formula for perceptual grayscale
                    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                    r = r + (gray - r) * desaturation;
                    g = g + (gray - g) * desaturation;
                    b = b + (gray - b) * desaturation;
                }

                // Step 2: Apply brightness (-1 to 1 maps to -255 to +255)
                const brightnessOffset = brightness * 255;
                r = r + brightnessOffset;
                g = g + brightnessOffset;
                b = b + brightnessOffset;

                // Step 3: Apply contrast (0-2, where 1 is neutral)
                // Contrast formula: ((value - 128) * contrast) + 128
                const contrastFactor = contrast;
                r = (r - 128) * contrastFactor + 128;
                g = (g - 128) * contrastFactor + 128;
                b = (b - 128) * contrastFactor + 128;

                // Step 4: Apply tint (colorize effect)
                if (useTint) {
                    // Colorize: multiply grayscale by tint colour
                    const gray = (r + g + b) / 3;
                    r = gray * tintRgba.red;
                    g = gray * tintRgba.green;
                    b = gray * tintRgba.blue;
                }

                // Clamp values to 0-255 and store
                newPixels[offset] = Math.max(0, Math.min(255, Math.round(r)));
                newPixels[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
                newPixels[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
                if (hasAlpha) {
                    newPixels[offset + 3] = a;
                }
            }
        }

        // Create new pixbuf from modified data
        const newPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            GLib.Bytes.new(newPixels),
            GdkPixbuf.Colorspace.RGB,
            hasAlpha,
            8,
            width,
            height,
            rowstride
        );

        // Set the modified pixbuf as the preview image
        this._previewImage.set_from_pixbuf(newPixbuf);
    }

    _applyChanges() {
        // Get final values
        const desaturation = this._desaturationRow._slider.get_value();
        const brightness = this._brightnessRow._slider.get_value();
        const contrast = this._contrastRow._slider.get_value();
        const useTint = this._tintSwitch.get_active();
        const tintRgba = this._colorButton.get_rgba();
        const tintColor = [tintRgba.red, tintRgba.green, tintRgba.blue];

        // Create override object
        const override = {
            desaturation,
            brightness,
            contrast,
            useTint,
            tintColor,
        };

        // Save to settings
        const overrides = this._settings.get_value('icon-effect-overrides').deep_unpack();
        overrides[this._appId] = JSON.stringify(override);
        this._settings.set_value('icon-effect-overrides', new GLib.Variant('a{ss}', overrides));

        debug(`Saved effect override for ${this._appId}: ${JSON.stringify(override)}`);

        this.emit('effect-applied');
        this.close();
    }

    _resetToDefault() {
        // Remove override from settings
        const overrides = this._settings.get_value('icon-effect-overrides').deep_unpack();
        delete overrides[this._appId];
        this._settings.set_value('icon-effect-overrides', new GLib.Variant('a{ss}', overrides));

        debug(`Removed effect override for ${this._appId}`);

        this.emit('effect-applied');
        this.close();
    }
});

export default class StatusTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._signalIds = [];
        this._appRows = new Map();  // appId -> AppRow

        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ═══════════════════════════════════════════════════════════════
        // Appearance Group
        // ═══════════════════════════════════════════════════════════════
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Control how tray icons look in the panel',
        });
        page.add(appearanceGroup);

        // Icon Mode row
        const iconModeRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'How tray icons are displayed',
        });

        // Create string list model for combo
        const iconModeModel = new Gtk.StringList();
        iconModeModel.append('Symbolic (monochrome)');
        iconModeModel.append('Original (colored)');
        iconModeRow.set_model(iconModeModel);

        // Set current value
        const currentMode = this._settings.get_string('icon-mode');
        iconModeRow.set_selected(currentMode === 'symbolic' ? 0 : 1);

        // Connect change handler
        iconModeRow.connect('notify::selected', () => {
            const selected = iconModeRow.get_selected();
            this._settings.set_string('icon-mode', selected === 0 ? 'symbolic' : 'original');
        });

        appearanceGroup.add(iconModeRow);

        // ═══════════════════════════════════════════════════════════════
        // Apps Group
        // ═══════════════════════════════════════════════════════════════
        this._appsGroup = new Adw.PreferencesGroup({
            title: 'Tray Apps',
            description: 'Drag to reorder. Click the icon to customize. Toggle to show/hide.',
        });
        page.add(this._appsGroup);

        // Info row when no apps are detected
        this._infoRow = new Adw.ActionRow({
            title: 'No apps detected yet',
            subtitle: 'Start an app with tray support (like Nextcloud, Discord, Slack) and it will appear here',
        });
        this._infoRow.add_prefix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            pixel_size: 24,
        }));

        // Populate initial apps
        this._populateAppsGroup();

        // Subscribe to SNI registration signals for live updates
        this._subscribeToSignals();

        // ═══════════════════════════════════════════════════════════════
        // About Group
        // ═══════════════════════════════════════════════════════════════
        const aboutGroup = new Adw.PreferencesGroup({
            title: 'About',
        });
        page.add(aboutGroup);

        const aboutRow = new Adw.ActionRow({
            title: 'Status Tray',
            subtitle: 'Automatic system tray for StatusNotifierItem apps',
        });
        const aboutIcon = new Gtk.Image({
            icon_name: 'preferences-system-symbolic',
            pixel_size: 48,
        });
        aboutRow.add_prefix(aboutIcon);
        aboutGroup.add(aboutRow);

        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? `${this.metadata.version}`,
        });
        aboutGroup.add(versionRow);

        const linkRow = new Adw.ActionRow({
            title: 'Source Code',
            subtitle: this.metadata.url,
            activatable: true,
        });
        linkRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        linkRow.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri(this.metadata.url, null);
        });
        aboutGroup.add(linkRow);

        // Cleanup on window close
        window.connect('close-request', () => {
            this._cleanup();
            return false;  // Allow window to close
        });
    }

    _subscribeToSignals() {
        // Subscribe to item registered signal
        const registeredId = this._bus.signal_subscribe(
            'org.kde.StatusNotifierWatcher',
            'org.kde.StatusNotifierWatcher',
            'StatusNotifierItemRegistered',
            '/StatusNotifierWatcher',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [itemId] = params.deep_unpack();
                debug(`SNI registered: ${itemId}`);
                this._onAppRegistered(itemId);
            }
        );
        this._signalIds.push(registeredId);

        // Subscribe to item unregistered signal
        const unregisteredId = this._bus.signal_subscribe(
            'org.kde.StatusNotifierWatcher',
            'org.kde.StatusNotifierWatcher',
            'StatusNotifierItemUnregistered',
            '/StatusNotifierWatcher',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
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

        // Remove "no apps" placeholder if present
        if (this._appRows.size === 0) {
            this._appsGroup.remove(this._infoRow);
        }

        // Create and add new row with reorder callback
        const row = new AppRow(
            appId, busName, objectPath, this._settings, this._window,
            (draggedId, targetId) => this._handleReorder(draggedId, targetId)
        );
        this._appRows.set(appId, row);
        this._appsGroup.add(row);

        // Add to app-order if not already present
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

            // Show placeholder if no apps left
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
        const appIds = new Map();  // appId -> { busName, objectPath }

        // Get currently registered SNI items - these are the apps we can actually
        // fetch icons and info for. We only show apps that are currently running.
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

        // Populate the group
        if (appIds.size === 0) {
            this._appsGroup.add(this._infoRow);
        } else {
            // Sort apps based on app-order setting, with unordered apps at the end
            const appOrder = this._settings.get_strv('app-order');
            const sortedApps = Array.from(appIds.keys()).sort((a, b) => {
                const aIndex = appOrder.indexOf(a);
                const bIndex = appOrder.indexOf(b);

                // Both in order list: sort by position
                if (aIndex !== -1 && bIndex !== -1) {
                    return aIndex - bIndex;
                }
                // Only a is in order list: a comes first
                if (aIndex !== -1) return -1;
                // Only b is in order list: b comes first
                if (bIndex !== -1) return 1;
                // Neither in order list: sort alphabetically
                return a.toLowerCase().localeCompare(b.toLowerCase());
            });

            for (const appId of sortedApps) {
                const { busName, objectPath } = appIds.get(appId);
                const row = new AppRow(
                    appId, busName, objectPath, this._settings, this._window,
                    (draggedId, targetId) => this._handleReorder(draggedId, targetId)
                );
                this._appRows.set(appId, row);
                this._appsGroup.add(row);

                // Ensure app is in the app-order list
                this._ensureInAppOrder(appId);
            }
        }
    }

    _extractAppId(item) {
        // Parse SNI item format to get a meaningful app ID
        // Format: ":1.xxx/objectPath" or ":1.xxx" or "org.app.Name/path"

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
            // Skip generic names
            if (lastPart !== 'StatusNotifierItem' && lastPart !== 'item') {
                return lastPart;
            }
        }

        // Fall back to bus name portion
        const firstSlash = item.indexOf('/');
        return firstSlash > 0 ? item.substring(0, firstSlash) : item;
    }

    /**
     * Ensure an app ID is in the app-order list
     * Adds it to the end if not present
     */
    _ensureInAppOrder(appId) {
        const appOrder = this._settings.get_strv('app-order');
        if (!appOrder.includes(appId)) {
            appOrder.push(appId);
            this._settings.set_strv('app-order', appOrder);
            debug(`Added ${appId} to app-order`);
        }
    }

    /**
     * Handle reordering when an app is dragged and dropped
     * @param {string} draggedId - The app ID that was dragged
     * @param {string} targetId - The app ID that was dropped onto
     */
    _handleReorder(draggedId, targetId) {
        debug(`Reordering: moving ${draggedId} to position of ${targetId}`);

        const appOrder = this._settings.get_strv('app-order');

        // Ensure both apps are in the order list
        if (!appOrder.includes(draggedId)) {
            appOrder.push(draggedId);
        }
        if (!appOrder.includes(targetId)) {
            appOrder.push(targetId);
        }

        // Find positions
        const draggedIndex = appOrder.indexOf(draggedId);
        const targetIndex = appOrder.indexOf(targetId);

        // Remove dragged item from its current position
        appOrder.splice(draggedIndex, 1);

        // Find new target index (it may have shifted after removal)
        const newTargetIndex = appOrder.indexOf(targetId);

        // Insert dragged item at target position
        appOrder.splice(newTargetIndex, 0, draggedId);

        // Save the new order
        this._settings.set_strv('app-order', appOrder);

        debug(`New app-order: ${appOrder.join(', ')}`);

        // Rebuild the UI to reflect new order
        this._rebuildAppsGroup();
    }

    /**
     * Rebuild the apps group to reflect current app-order
     * Reuses existing rows to preserve their state (resolved names, icons, etc.)
     */
    _rebuildAppsGroup() {
        const appOrder = this._settings.get_strv('app-order');

        // Get rows sorted by app-order
        // Use the row's current _appId (which may have been updated by _fetchAppInfo)
        const rows = Array.from(this._appRows.values());
        rows.sort((a, b) => {
            const aIndex = appOrder.indexOf(a._appId);
            const bIndex = appOrder.indexOf(b._appId);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return a._appId.toLowerCase().localeCompare(b._appId.toLowerCase());
        });

        // Remove all rows from the group (but don't destroy them)
        for (const row of rows) {
            this._appsGroup.remove(row);
        }

        // Re-add rows in sorted order
        for (const row of rows) {
            this._appsGroup.add(row);
        }

        debug(`Rebuilt apps group with order: ${rows.map(r => r._appId).join(', ')}`);
    }

    _cleanup() {
        debug('Cleaning up preferences window');

        // Unsubscribe from D-Bus signals
        for (const signalId of this._signalIds)
            this._bus.signal_unsubscribe(signalId);

        // Nullify all properties
        this._signalIds = null;
        this._appRows = null;
        this._appsGroup = null;
        this._infoRow = null;
        this._bus = null;
        this._settings = null;
        this._window = null;

        // Clean up module-level state
        _draggedRow = null;
    }
}
