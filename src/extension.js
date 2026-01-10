/**
 * Status Tray - Automatic system tray for StatusNotifierItem apps
 *
 * This extension automatically discovers and displays tray icons for any app
 * that uses the StatusNotifierItem (SNI) protocol with DBusMenu.
 *
 * Key D-Bus interfaces used:
 * - org.kde.StatusNotifierWatcher: Tracks registered tray items
 * - org.kde.StatusNotifierItem: Individual tray item properties (icon, tooltip, etc.)
 * - com.canonical.dbusmenu: Menu structure and actions
 *
 * Based on learnings from Status Kitchen (https://github.com/keithvassallomt/status-kitchen)
 * and AppIndicator extension (for robust D-Bus proxy handling)
 */

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

// Debug logging - set to true during development
const DEBUG = true;

// Fallback icon when icon loading fails
const FALLBACK_ICON_NAME = 'image-loading-symbolic';

// Pixel format for IconPixmap - ARGB in network byte order
const PIXMAPS_FORMAT = Cogl.PixelFormat.ARGB_8888;

function debug(msg) {
    if (DEBUG) {
        console.log(`[StatusTray] ${msg}`);
    }
}

/**
 * StatusNotifierItem D-Bus interface XML
 * Based on KDE's SNI spec - defines the expected interface structure
 * This helps Gio.DBusProxy handle broken implementations more gracefully
 */
const SNI_INTERFACE_XML = `
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/>
      <arg name="orientation" type="s" direction="in"/>
    </method>
  </interface>
</node>
`;

/**
 * StatusNotifierWatcher D-Bus interface XML
 * This is the service that apps register their tray icons with
 */
const SNW_INTERFACE_XML = `
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg name="service" type="s" direction="in"/>
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
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>
`;

// Bus name and object path for the watcher
const WATCHER_BUS_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_OBJECT_PATH = '/StatusNotifierWatcher';
const DEFAULT_ITEM_OBJECT_PATH = '/StatusNotifierItem';

// Regex for D-Bus bus names
const BUS_ADDRESS_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;

// Parse the interface XML once
let _sniInterfaceInfo = null;
function getSNIInterfaceInfo() {
    if (!_sniInterfaceInfo) {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(SNI_INTERFACE_XML);
        _sniInterfaceInfo = nodeInfo.lookup_interface('org.kde.StatusNotifierItem');
    }
    return _sniInterfaceInfo;
}

function isDarkMode() {
    try {
        const settings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        const colorScheme = settings.get_string('color-scheme');
        return colorScheme === 'prefer-dark';
    } catch (e) {
        // Fallback: assume dark mode (most common)
        return true;
    }
}

/**
 * Strip GTK mnemonic underscores from labels
 * "_File" -> "File", "__File" -> "_File"
 */
function stripMnemonics(label) {
    if (!label) return '';
    // Replace single underscore before a character with nothing
    // But preserve double underscores as single underscore
    return label.replace(/__/g, '\x00').replace(/_/g, '').replace(/\x00/g, '_');
}

/**
 * TrayItem - A panel button representing a single StatusNotifierItem
 *
 * Each TrayItem connects to one SNI service and:
 * 1. Displays its icon in the panel
 * 2. Fetches its menu via DBusMenu when clicked
 * 3. Handles menu item activation
 *
 * Uses Gio.DBusProxy with interface info for more robust property handling,
 * especially for apps with non-standard SNI implementations.
 */
const TrayItem = GObject.registerClass(
class TrayItem extends PanelMenu.Button {
    _init(busName, objectPath, settings) {
        // Extract a readable ID from the bus name or path for accessibility
        const itemId = this._extractId(busName, objectPath);
        super._init(0.0, `StatusTray-${itemId}`);

        this._busName = busName;
        this._objectPath = objectPath;
        this._menuPath = null;  // Will be fetched from SNI Menu property
        this._iconName = null;
        this._iconThemePath = null;
        this._settings = settings;
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();

        // Extract app ID for icon override lookups
        // This is a preliminary ID; will be updated with SNI Id property when available
        this._appId = this._extractId(busName, objectPath);

        // Signal subscription IDs for cleanup
        this._signalIds = [];

        // Create icon widget with fallback
        this._icon = new St.Icon({
            style_class: 'system-status-icon status-tray-icon',
            fallback_icon_name: FALLBACK_ICON_NAME,
        });
        this.add_child(this._icon);

        // Set a temporary icon while we fetch the real one
        this._icon.set_icon_name(FALLBACK_ICON_NAME);

        // Add our style class
        this.add_style_class_name('status-tray-button');

        // Connect to the SNI using a proxy (more robust for quirky apps)
        this._initProxy();

        // Add a placeholder item so the menu isn't empty
        // (GNOME Shell won't open an empty menu)
        this._loadingItem = new PopupMenu.PopupMenuItem('Loading...', {
            reactive: false,
            style_class: 'popup-inactive-menu-item',
        });
        this.menu.addMenuItem(this._loadingItem);

        // Set up menu open handler to fetch fresh menu items
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            debug(`Menu open-state-changed: isOpen=${isOpen}, busName=${this._busName}`);
            if (isOpen) {
                this._loadMenu();
            }
        });

        debug(`Created TrayItem for ${busName} at ${objectPath}`);
    }

    _extractId(busName, objectPath) {
        // Try to get a human-readable ID from the SNI
        // Usually the object path contains something meaningful
        const pathParts = objectPath.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
            const lastPart = pathParts[pathParts.length - 1];
            // Skip generic names that don't identify the app
            if (lastPart !== 'StatusNotifierItem' && lastPart !== 'item') {
                return lastPart;
            }
        }
        // Fall back to bus name
        return busName;
    }

    /**
     * Initialize the D-Bus proxy for the SNI
     * Using Gio.DBusProxy with interface info provides better compatibility
     * with apps that have non-standard implementations
     */
    async _initProxy() {
        try {
            // Create proxy with interface info for better compatibility
            this._proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: this._busName,
                g_object_path: this._objectPath,
                g_interface_name: 'org.kde.StatusNotifierItem',
                g_interface_info: getSNIInterfaceInfo(),
                g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            });

            // Initialize the proxy asynchronously
            await new Promise((resolve, reject) => {
                this._proxy.init_async(GLib.PRIORITY_DEFAULT, this._cancellable, (proxy, result) => {
                    try {
                        proxy.init_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            debug(`Proxy initialized for ${this._busName}`);

            // Connect to property changes
            this._proxy.connect('g-properties-changed', (proxy, changed, invalidated) => {
                const props = Object.keys(changed.deep_unpack());
                debug(`Properties changed for ${this._busName}: ${props.join(', ')}`);

                if (props.some(p => p.startsWith('Icon'))) {
                    this._updateIcon();
                }
            });

            // Now fetch properties
            this._fetchPropertiesFromProxy();
            this._subscribeToSignals();

        } catch (e) {
            debug(`Failed to initialize proxy for ${this._busName}: ${e.message}`);
            // Fall back to direct D-Bus calls
            this._connectToSNIFallback();
        }
    }

    /**
     * Fetch properties using the proxy's cached values or direct calls
     */
    _fetchPropertiesFromProxy() {
        // Get SNI Id property for stable app identification
        // This is more reliable than bus name which changes on each app restart
        const idVariant = this._proxy.get_cached_property('Id');
        if (idVariant) {
            const sniId = idVariant.deep_unpack();
            if (sniId && sniId.length > 0 && !sniId.startsWith(':')) {
                const oldAppId = this._appId;
                this._appId = sniId;
                debug(`Updated appId from ${oldAppId} to ${this._appId} (from SNI Id)`);
            }
        }

        // Get IconThemePath
        const iconThemePath = this._proxy.get_cached_property('IconThemePath');
        if (iconThemePath) {
            this._iconThemePath = iconThemePath.deep_unpack();
            debug(`Got IconThemePath from proxy: ${this._iconThemePath}`);
        }

        // Get Menu path
        const menuPath = this._proxy.get_cached_property('Menu');
        if (menuPath) {
            this._menuPath = menuPath.deep_unpack();
            debug(`Got Menu path from proxy: ${this._menuPath}`);
        }

        // Update the icon
        this._updateIcon();
    }

    /**
     * Update icon from proxy cached properties
     */
    _updateIcon() {
        debug(`_updateIcon called for ${this._busName}`);

        // Check for icon override first
        if (this._settings) {
            try {
                const overrides = this._settings.get_value('icon-overrides').deep_unpack();
                if (overrides[this._appId]) {
                    const overrideIcon = overrides[this._appId];
                    debug(`Using icon override for ${this._appId}: ${overrideIcon}`);
                    this._setIcon(overrideIcon);
                    return;
                }
            } catch (e) {
                debug(`Failed to check icon overrides: ${e.message}`);
            }
        }

        if (!this._proxy) {
            debug(`No proxy available for ${this._busName}, skipping icon update`);
            return;
        }

        // Try IconName first
        const iconNameVariant = this._proxy.get_cached_property('IconName');
        debug(`IconName variant: ${iconNameVariant}`);
        if (iconNameVariant) {
            const iconName = iconNameVariant.deep_unpack();
            debug(`Unpacked IconName: "${iconName}"`);
            if (iconName && iconName.length > 0) {
                debug(`Got IconName from proxy: ${iconName}, calling _setIcon`);
                try {
                    this._setIcon(iconName);
                } catch (e) {
                    debug(`Error in _setIcon: ${e.message}\n${e.stack}`);
                }
                return;
            }
        }

        // Try IconPixmap
        const iconPixmapVariant = this._proxy.get_cached_property('IconPixmap');
        if (iconPixmapVariant) {
            debug(`Got IconPixmap from proxy, processing...`);
            this._setIconFromPixmap(iconPixmapVariant);
            return;
        }

        // If proxy doesn't have cached properties, try direct fetch
        debug(`No cached icon properties for ${this._busName}, trying direct fetch`);
        this._fetchIconDirect();
    }

    /**
     * Fetch icon directly via D-Bus call (fallback)
     */
    _fetchIconDirect() {
        const bus = Gio.DBus.session;

        // First get IconThemePath (for Electron apps)
        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'IconThemePath']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    this._iconThemePath = variant.deep_unpack();
                    if (this._iconThemePath) {
                        debug(`Got IconThemePath (direct): ${this._iconThemePath}`);
                    }
                } catch (e) {
                    // IconThemePath is optional
                    if (!e.message?.includes('No such property') &&
                        !e.message?.includes('CANCELLED')) {
                        debug(`IconThemePath fetch issue: ${e.message}`);
                    }
                }

                // Now fetch IconName
                this._fetchIconNameDirect();
            }
        );
    }

    _fetchIconNameDirect() {
        const bus = Gio.DBus.session;

        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'IconName']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    const iconName = variant.deep_unpack();

                    if (iconName && iconName.length > 0) {
                        debug(`Got IconName (direct): ${iconName}`);
                        this._setIcon(iconName);
                    } else {
                        debug(`IconName is empty for ${this._busName}, trying IconPixmap`);
                        this._fetchIconPixmapDirect();
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get IconName: ${e}`);
                    }
                    this._fetchIconPixmapDirect();
                }
            }
        );
    }

    _fetchIconPixmapDirect() {
        const bus = Gio.DBus.session;

        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'IconPixmap']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    this._setIconFromPixmap(variant);
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get IconPixmap: ${e}`);
                    }
                }
            }
        );
    }

    /**
     * Try to fetch IconPixmap, with fallback to system icon theme lookup
     * Used when IconThemePath is inaccessible (e.g., Flatpak sandboxed apps)
     */
    _fetchIconPixmapWithFallback(iconName) {
        const bus = Gio.DBus.session;

        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'IconPixmap']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    const pixmaps = variant.deep_unpack();

                    if (pixmaps && pixmaps.length > 0) {
                        debug(`Got IconPixmap for sandboxed app`);
                        this._setIconFromPixmap(variant);
                    } else {
                        // No pixmap data, fall back to system theme
                        debug(`No IconPixmap available, using system theme for: ${iconName}`);
                        this._icon.set_icon_name(iconName);
                        this._applySymbolicStyle();
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`IconPixmap failed for sandboxed app: ${e.message}`);
                        // Fall back to system theme lookup
                        debug(`Falling back to system theme for: ${iconName}`);
                        this._icon.set_icon_name(iconName);
                        this._applySymbolicStyle();
                    }
                }
            }
        );
    }

    /**
     * Subscribe to SNI signals for icon/status updates
     */
    _subscribeToSignals() {
        const bus = Gio.DBus.session;

        // Subscribe to NewIcon signal
        const newIconId = bus.signal_subscribe(
            this._busName,
            'org.kde.StatusNotifierItem',
            'NewIcon',
            this._objectPath,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                debug(`NewIcon signal for ${this._busName}`);
                // Invalidate cached property and refetch
                if (this._proxy) {
                    this._proxy.set_cached_property('IconName', null);
                    this._proxy.set_cached_property('IconPixmap', null);
                }
                this._updateIcon();
            }
        );
        this._signalIds.push(newIconId);

        // Subscribe to NewStatus signal
        const newStatusId = bus.signal_subscribe(
            this._busName,
            'org.kde.StatusNotifierItem',
            'NewStatus',
            this._objectPath,
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [status] = params.deep_unpack();
                debug(`NewStatus signal for ${this._busName}: ${status}`);
            }
        );
        this._signalIds.push(newStatusId);

        // Watch for bus name disappearing
        const nameWatchId = bus.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            this._busName,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (newOwner === '') {
                    debug(`Bus name ${this._busName} disappeared`);
                }
            }
        );
        this._signalIds.push(nameWatchId);
    }

    /**
     * Fallback to direct D-Bus calls when proxy initialization fails
     */
    _connectToSNIFallback() {
        debug(`Using fallback D-Bus calls for ${this._busName}`);
        this._fetchIdDirect();
        this._fetchIconDirect();
        this._fetchMenuPathDirect();
        this._subscribeToSignals();
    }

    /**
     * Fetch SNI Id property directly via D-Bus (for fallback mode)
     * Updates _appId with stable identifier
     */
    _fetchIdDirect() {
        const bus = Gio.DBus.session;

        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'Id']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    const sniId = variant.deep_unpack();
                    if (sniId && sniId.length > 0 && !sniId.startsWith(':')) {
                        const oldAppId = this._appId;
                        this._appId = sniId;
                        debug(`Updated appId from ${oldAppId} to ${this._appId} (from SNI Id, fallback)`);
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get SNI Id: ${e.message}`);
                    }
                }
            }
        );
    }

    /**
     * Fetch menu path directly via D-Bus (for fallback mode)
     */
    _fetchMenuPathDirect() {
        const bus = Gio.DBus.session;

        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'Menu']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    const menuPath = variant.deep_unpack();

                    if (typeof menuPath === 'string') {
                        this._menuPath = menuPath;
                    } else if (menuPath && menuPath.toString) {
                        this._menuPath = menuPath.toString();
                    }

                    debug(`Got Menu path (direct): ${this._menuPath}`);
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get Menu path: ${e}`);
                    }
                    this._menuPath = '/MenuBar';
                }
            }
        );
    }

    _setIcon(iconName) {
        debug(`_setIcon called with: ${iconName}, themePath: ${this._iconThemePath}`);

        // Clear any previous content (from St.ImageContent)
        this._icon.content = null;

        // Check if it's already a file path
        if (iconName.startsWith('/')) {
            const file = Gio.File.new_for_path(iconName);
            if (file.query_exists(null)) {
                debug(`Using absolute icon path: ${iconName}`);
                const gicon = new Gio.FileIcon({ file });
                this._icon.set_gicon(gicon);
                this._applySymbolicStyle();
                return;
            } else {
                debug(`Absolute icon path doesn't exist: ${iconName}`);
            }
        }

        // For Electron/Chromium apps, check IconThemePath for the actual file
        if (this._iconThemePath && this._iconThemePath.length > 0) {
            const possiblePaths = [
                `${this._iconThemePath}/${iconName}.png`,
                `${this._iconThemePath}/${iconName}.svg`,
                `${this._iconThemePath}/hicolor/22x22/apps/${iconName}.png`,
                `${this._iconThemePath}/hicolor/24x24/apps/${iconName}.png`,
                `${this._iconThemePath}/hicolor/32x32/apps/${iconName}.png`,
            ];

            for (const path of possiblePaths) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    debug(`Found icon file at: ${path}`);
                    const gicon = new Gio.FileIcon({ file });
                    this._icon.set_gicon(gicon);
                    this._applySymbolicStyle();
                    return;
                }
            }
            debug(`No icon file found in IconThemePath: ${this._iconThemePath}`);

            // IconThemePath exists but icon file not found
            // This often happens with Flatpak apps where the path is inside the sandbox
            // Try fetching IconPixmap as fallback, then fall back to system theme
            debug(`IconThemePath inaccessible (possibly sandboxed), trying IconPixmap`);
            this._fetchIconPixmapWithFallback(iconName);
            return;
        }

        // Fallback: use icon name directly (system theme lookup)
        debug(`Using system icon theme lookup for: ${iconName}`);
        this._icon.set_icon_name(iconName);
        this._applySymbolicStyle();
    }

    /**
     * Apply symbolic (monochrome) styling to the icon
     * Uses Clutter effects to desaturate and adjust brightness
     * Based on Status Kitchen's implementation in src/generator/mod.rs
     * Supports per-app effect customization via icon-effect-overrides setting
     */
    _applySymbolicStyle() {
        // Check settings for icon mode
        const iconMode = this._settings?.get_string('icon-mode') ?? 'symbolic';
        if (iconMode !== 'symbolic') {
            // Original mode - remove any effects and return
            this._icon.clear_effects();
            this._icon.set_style('icon-size: 16px;');
            return;
        }

        const dark = isDarkMode();

        // Default effect values
        let desaturation = 1.0;
        let brightness = dark ? 0.5 : -0.5;
        let contrast = 0.6;
        let useTint = false;
        let tintColor = [1.0, 1.0, 1.0];  // White default

        // Check for per-app effect overrides
        try {
            const effectOverrides = this._settings?.get_value('icon-effect-overrides')?.deep_unpack() ?? {};
            const overrideJson = effectOverrides[this._appId];
            if (overrideJson) {
                const override = JSON.parse(overrideJson);
                if (override.desaturation !== undefined) desaturation = override.desaturation;
                if (override.brightness !== undefined) brightness = override.brightness;
                if (override.contrast !== undefined) contrast = override.contrast;
                if (override.useTint !== undefined) useTint = override.useTint;
                if (override.tintColor !== undefined) tintColor = override.tintColor;
            }
        } catch (e) {
            debug(`Failed to parse effect override for ${this._appId}: ${e.message}`);
        }

        // Remove any existing effects first
        this._icon.clear_effects();

        // Step 1: Desaturate to grayscale (if desaturation > 0)
        if (desaturation > 0) {
            const desaturate = new Clutter.DesaturateEffect({ factor: desaturation });
            this._icon.add_effect_with_name('desaturate', desaturate);
        }

        // Step 2: Adjust brightness/contrast
        const bc = new Clutter.BrightnessContrastEffect();
        bc.set_contrast_full(contrast, contrast, contrast);
        bc.set_brightness_full(brightness, brightness, brightness);
        this._icon.add_effect_with_name('brightness', bc);

        // Step 3: Optional tint colour using Clutter.ColorizeEffect
        if (useTint && tintColor) {
            try {
                const colorize = new Clutter.ColorizeEffect({
                    tint: Clutter.Color.new(
                        Math.round(tintColor[0] * 255),
                        Math.round(tintColor[1] * 255),
                        Math.round(tintColor[2] * 255),
                        255
                    ),
                });
                this._icon.add_effect_with_name('tint', colorize);
            } catch (e) {
                debug(`Failed to apply tint effect: ${e.message}`);
            }
        }

        this._icon.set_style('icon-size: 16px;');
    }

    /**
     * Set icon from IconPixmap variant data
     * Uses St.ImageContent for direct ARGB rendering (like AppIndicator does)
     * This is more efficient than saving to temp files
     */
    _setIconFromPixmap(pixmapVariant) {
        try {
            // Handle both array format (from deep_unpack) and GVariant format (from proxy)
            let pixmaps;
            if (pixmapVariant instanceof GLib.Variant) {
                // Need to iterate through the variant array
                const numChildren = pixmapVariant.n_children();
                if (numChildren === 0) {
                    debug(`Empty IconPixmap for ${this._busName}`);
                    return;
                }

                pixmaps = [];
                for (let i = 0; i < numChildren; i++) {
                    const child = pixmapVariant.get_child_value(i);
                    const width = child.get_child_value(0).get_int32();
                    const height = child.get_child_value(1).get_int32();
                    const data = child.get_child_value(2).get_data_as_bytes();
                    pixmaps.push({ width, height, data });
                }
            } else {
                // Already unpacked array
                pixmaps = pixmapVariant;
                if (!pixmaps || pixmaps.length === 0) {
                    debug(`No IconPixmap data for ${this._busName}`);
                    return;
                }
            }

            // Pick the best size - prefer something close to 22-32px for panel
            let bestPixmap = pixmaps[0];
            let bestSize = bestPixmap.width ?? bestPixmap[0];
            const targetSize = 22;

            for (const pixmap of pixmaps) {
                const width = pixmap.width ?? pixmap[0];
                if (width >= 16 && width <= 48) {
                    if (Math.abs(width - targetSize) < Math.abs(bestSize - targetSize)) {
                        bestPixmap = pixmap;
                        bestSize = width;
                    }
                }
            }

            const width = bestPixmap.width ?? bestPixmap[0];
            const height = bestPixmap.height ?? bestPixmap[1];
            const pixelData = bestPixmap.data ?? bestPixmap[2];
            const rowStride = width * 4;

            debug(`Using IconPixmap ${width}x${height} for ${this._busName}`);

            // Try using St.ImageContent with ARGB format (like AppIndicator)
            try {
                const imageContent = new St.ImageContent({
                    preferred_width: width,
                    preferred_height: height,
                });

                // Get pixel bytes - handle both GLib.Bytes and Uint8Array
                let pixelBytes;
                if (pixelData instanceof GLib.Bytes) {
                    pixelBytes = pixelData;
                } else if (pixelData.get_data_as_bytes) {
                    pixelBytes = pixelData.get_data_as_bytes();
                } else {
                    pixelBytes = GLib.Bytes.new(pixelData);
                }

                // Use set_bytes with ARGB format (no conversion needed!)
                // Check if we need to pass cogl context (GNOME 48+)
                const mutterBackend = global.stage?.context?.get_backend?.();
                if (imageContent.set_bytes.length === 6 && mutterBackend?.get_cogl_context) {
                    imageContent.set_bytes(
                        mutterBackend.get_cogl_context(),
                        pixelBytes,
                        PIXMAPS_FORMAT,
                        width,
                        height,
                        rowStride
                    );
                } else {
                    imageContent.set_bytes(
                        pixelBytes,
                        PIXMAPS_FORMAT,
                        width,
                        height,
                        rowStride
                    );
                }

                // Apply to icon using content
                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const scaledSize = 16 * scaleFactor;

                this._icon.set({
                    content: imageContent,
                    width: scaledSize,
                    height: scaledSize,
                    content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                });

                // Clear any previous gicon
                this._icon.gicon = null;

                this._applySymbolicStyle();
                debug(`Set IconPixmap via St.ImageContent for ${this._busName}`);
                return;

            } catch (stError) {
                debug(`St.ImageContent failed, falling back to temp file: ${stError.message}`);
            }

            // Fallback: Convert to RGBA and save as temp PNG file
            const pixelDataArray = pixelData instanceof GLib.Bytes
                ? new Uint8Array(pixelData.get_data())
                : (pixelData.get_data_as_bytes
                    ? new Uint8Array(pixelData.get_data_as_bytes().get_data())
                    : pixelData);

            const rgbaData = this._argbToRgba(pixelDataArray, width, height);

            const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                rgbaData,
                GdkPixbuf.Colorspace.RGB,
                true,
                8,
                width,
                height,
                rowStride
            );

            const tempPath = GLib.build_filenamev([
                GLib.get_tmp_dir(),
                `status-tray-${this._busName.replace(/[^a-zA-Z0-9]/g, '_')}.png`
            ]);
            pixbuf.savev(tempPath, 'png', [], []);

            const file = Gio.File.new_for_path(tempPath);
            const gicon = new Gio.FileIcon({ file });
            this._icon.set_gicon(gicon);
            this._icon.content = null;  // Clear any St.ImageContent
            this._applySymbolicStyle();

            debug(`IconPixmap saved to ${tempPath} (fallback)`);

        } catch (e) {
            debug(`Failed to set IconPixmap: ${e.message}`);
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

    _loadMenu() {
        debug(`_loadMenu called for ${this._busName}, menuPath=${this._menuPath}`);

        if (!this._menuPath) {
            debug(`No menu path for ${this._busName}`);
            return;
        }

        // Clear existing menu items (except the title if we want one)
        this.menu.removeAll();

        const bus = Gio.DBus.session;

        // IMPORTANT: Call AboutToShow first to trigger visibility updates
        // Without this, items like "Pause sync" and "Resume sync" may both show
        // See dev/discovermenu.md for details
        debug(`Calling AboutToShow on ${this._busName} ${this._menuPath}`);
        bus.call(
            this._busName,
            this._menuPath,
            'com.canonical.dbusmenu',
            'AboutToShow',
            new GLib.Variant('(i)', [0]),
            new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                    debug(`AboutToShow succeeded for ${this._busName}`);
                } catch (e) {
                    debug(`AboutToShow failed (may be ok): ${e}`);
                }

                // Now fetch the layout
                this._fetchMenuLayout();
            }
        );
    }

    _fetchMenuLayout() {
        debug(`_fetchMenuLayout called for ${this._busName}`);
        const bus = Gio.DBus.session;

        // GetLayout(parentId, recursionDepth, propertyNames) -> (revision, layout)
        // parentId: 0 = root
        // recursionDepth: -1 = all
        // propertyNames: empty array = all properties
        debug(`Calling GetLayout on ${this._busName} ${this._menuPath}`);
        bus.call(
            this._busName,
            this._menuPath,
            'com.canonical.dbusmenu',
            'GetLayout',
            new GLib.Variant('(iias)', [0, -1, []]),
            new GLib.VariantType('(u(ia{sv}av))'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [revision, layout] = reply.deep_unpack();
                    debug(`Got menu layout, revision ${revision}`);
                    this._buildMenuFromLayout(layout);
                } catch (e) {
                    debug(`Failed to get menu layout: ${e}`);
                }
            }
        );
    }

    _buildMenuFromLayout(layout) {
        // layout is (ia{sv}av) = (id, properties, children)
        const [rootId, rootProps, children] = layout;

        // Process children of the root item
        if (!children || children.length === 0) {
            debug('Menu has no items');
            return;
        }

        // Track last item type to avoid consecutive separators
        this._lastMenuItemType = null;

        for (const childVariant of children) {
            const child = childVariant.deep_unpack();
            this._addMenuItem(child);
        }
    }

    _addMenuItem(item) {
        const [itemId, properties, children] = item;

        // Extract properties
        const rawLabel = properties['label']?.deep_unpack() || '';
        const label = stripMnemonics(rawLabel);
        const visible = properties['visible']?.deep_unpack() ?? true;
        const enabled = properties['enabled']?.deep_unpack() ?? true;
        const type = properties['type']?.deep_unpack() || '';
        const childrenDisplay = properties['children-display']?.deep_unpack() || '';

        // Skip invisible items
        if (!visible) {
            debug(`Skipping invisible item: ${label} (id=${itemId})`);
            return;
        }

        // Skip root-level container items (but process their children)
        if (label === '' && itemId === 0) {
            if (children && children.length > 0) {
                for (const childVariant of children) {
                    const child = childVariant.deep_unpack();
                    this._addMenuItem(child);
                }
            }
            return;
        }

        // Handle separators - skip consecutive ones
        if (type === 'separator' || label === '') {
            if (this._lastMenuItemType === 'separator') {
                debug(`Skipping consecutive separator (id=${itemId})`);
                return;
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._lastMenuItemType = 'separator';
            return;
        }

        // Handle submenus
        if (childrenDisplay === 'submenu' && children && children.length > 0) {
            const subMenu = new PopupMenu.PopupSubMenuMenuItem(label);
            if (!enabled) {
                subMenu.setSensitive(false);
            }

            for (const childVariant of children) {
                const child = childVariant.deep_unpack();
                this._addSubMenuItem(subMenu.menu, child);
            }

            this.menu.addMenuItem(subMenu);
            this._lastMenuItemType = 'submenu';
            return;
        }

        // Regular menu item
        const menuItem = new PopupMenu.PopupMenuItem(label);
        if (!enabled) {
            menuItem.setSensitive(false);
        }

        // Connect activation handler
        menuItem.connect('activate', () => {
            this._activateMenuItem(itemId, label);
        });

        this.menu.addMenuItem(menuItem);
        this._lastMenuItemType = 'item';

        // Process children if any (even if not a submenu - some apps nest items)
        if (children && children.length > 0) {
            for (const childVariant of children) {
                const child = childVariant.deep_unpack();
                this._addMenuItem(child);
            }
        }
    }

    _addSubMenuItem(submenu, item) {
        const [itemId, properties, children] = item;

        const rawLabel = properties['label']?.deep_unpack() || '';
        const label = stripMnemonics(rawLabel);
        const visible = properties['visible']?.deep_unpack() ?? true;
        const enabled = properties['enabled']?.deep_unpack() ?? true;
        const type = properties['type']?.deep_unpack() || '';

        if (!visible) return;

        if (type === 'separator' || label === '') {
            submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        const menuItem = new PopupMenu.PopupMenuItem(label);
        if (!enabled) {
            menuItem.setSensitive(false);
        }

        menuItem.connect('activate', () => {
            this._activateMenuItem(itemId, label);
        });

        submenu.addMenuItem(menuItem);
    }

    _activateMenuItem(itemId, label) {
        debug(`Activating menu item: ${label} (id=${itemId})`);

        const bus = Gio.DBus.session;

        // DBusMenu Event call: Event(id, event_type, data, timestamp)
        bus.call(
            this._busName,
            this._menuPath,
            'com.canonical.dbusmenu',
            'Event',
            new GLib.Variant('(isvu)', [itemId, 'clicked', new GLib.Variant('i', 0), 0]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                    debug(`Menu item activated successfully`);
                } catch (e) {
                    debug(`Failed to activate menu item: ${e}`);
                }
            }
        );
    }

    destroy() {
        // Cancel any pending async operations
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        // Clean up signal subscriptions
        const bus = Gio.DBus.session;
        for (const signalId of this._signalIds) {
            try {
                bus.signal_unsubscribe(signalId);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        this._signalIds = [];

        // Clean up proxy
        if (this._proxy) {
            this._proxy = null;
        }

        debug(`Destroyed TrayItem for ${this._busName}`);
        super.destroy();
    }
});

/**
 * StatusNotifierWatcher - Implements the org.kde.StatusNotifierWatcher D-Bus interface
 *
 * This allows apps to register their tray icons with us directly,
 * making the extension independent of any external daemon.
 */
class StatusNotifierWatcher {
    constructor(extension) {
        this._extension = extension;
        this._items = new Map();  // uniqueId -> { busName, objectPath }
        this._nameOwnerChangedIds = new Map();  // busName -> signalId
        this._cancellable = new Gio.Cancellable();

        // Parse interface XML
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(SNW_INTERFACE_XML);
        const ifaceInfo = nodeInfo.lookup_interface('org.kde.StatusNotifierWatcher');

        // Create the D-Bus implementation object
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(ifaceInfo, this);

        try {
            this._dbusImpl.export(Gio.DBus.session, WATCHER_OBJECT_PATH);
            debug('StatusNotifierWatcher exported on D-Bus');
        } catch (e) {
            debug(`Failed to export StatusNotifierWatcher: ${e.message}`);
        }

        // Own the bus name
        this._ownNameId = Gio.DBus.session.own_name(
            WATCHER_BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => {
                debug(`Acquired bus name: ${WATCHER_BUS_NAME}`);
                // Emit host registered signal so apps know we're ready
                try {
                    this._dbusImpl.emit_signal('StatusNotifierHostRegistered', null);
                } catch (e) {
                    debug(`Failed to emit StatusNotifierHostRegistered: ${e.message}`);
                }
            },
            () => {
                debug(`Lost bus name: ${WATCHER_BUS_NAME}`);
            }
        );

        // Look for any items that registered before we started
        this._seekExistingItems();
    }

    /**
     * Scan the bus for any StatusNotifierItem objects that exist
     * This handles apps that registered before we claimed the watcher name
     */
    async _seekExistingItems() {
        try {
            const bus = Gio.DBus.session;

            // Get list of all names on the bus
            const result = await new Promise((resolve, reject) => {
                bus.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'ListNames',
                    null,
                    new GLib.VariantType('(as)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    this._cancellable,
                    (conn, res) => {
                        try {
                            resolve(conn.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            const [names] = result.deep_unpack();

            // Check each name for StatusNotifierItem interface
            for (const name of names) {
                if (name.startsWith(':')) {
                    // Check if this connection has a /StatusNotifierItem object
                    try {
                        await this._checkForSNI(name, DEFAULT_ITEM_OBJECT_PATH);
                    } catch (e) {
                        // Ignore - not all connections have SNI
                    }
                }
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                debug(`Error seeking existing items: ${e.message}`);
            }
        }
    }

    async _checkForSNI(busName, objectPath) {
        const bus = Gio.DBus.session;

        // Try to get the IconName property - if it works, there's an SNI there
        try {
            await new Promise((resolve, reject) => {
                bus.call(
                    busName,
                    objectPath,
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'Id']),
                    new GLib.VariantType('(v)'),
                    Gio.DBusCallFlags.NONE,
                    1000,  // Short timeout
                    this._cancellable,
                    (conn, res) => {
                        try {
                            conn.call_finish(res);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // If we got here, there's an SNI at this path
            const uniqueId = `${busName}${objectPath}`;
            if (!this._items.has(uniqueId)) {
                debug(`Found existing SNI: ${uniqueId}`);
                this._registerItemInternal(busName, objectPath);
            }
        } catch (e) {
            // No SNI here, that's fine
        }
    }

    /**
     * D-Bus method: RegisterStatusNotifierItem
     * Called by apps when they want to register a tray icon
     */
    RegisterStatusNotifierItemAsync(params, invocation) {
        const [service] = params;
        let busName, objectPath;

        debug(`RegisterStatusNotifierItem called with: ${service}`);

        if (service.charAt(0) === '/') {
            // It's a path - use the sender's bus name
            busName = invocation.get_sender();
            objectPath = service;
        } else if (BUS_ADDRESS_REGEX.test(service)) {
            // It's a well-known bus name - need to resolve to unique name
            busName = invocation.get_sender();  // Use sender for now
            objectPath = DEFAULT_ITEM_OBJECT_PATH;
        } else {
            // Assume it's a unique bus name
            busName = service;
            objectPath = DEFAULT_ITEM_OBJECT_PATH;
        }

        debug(`Registering item: busName=${busName}, objectPath=${objectPath}`);

        try {
            this._registerItemInternal(busName, objectPath);
            invocation.return_value(null);
        } catch (e) {
            debug(`Failed to register item: ${e.message}`);
            invocation.return_dbus_error('org.gnome.gjs.JSError.ValueError', e.message);
        }
    }

    _registerItemInternal(busName, objectPath) {
        const uniqueId = `${busName}${objectPath}`;

        if (this._items.has(uniqueId)) {
            debug(`Item already registered: ${uniqueId}`);
            return;
        }

        this._items.set(uniqueId, { busName, objectPath });

        // Watch for the bus name to disappear
        const signalId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            busName,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (newOwner === '') {
                    debug(`Bus name ${name} disappeared, unregistering item`);
                    this._unregisterItem(uniqueId);
                }
            }
        );
        this._nameOwnerChangedIds.set(uniqueId, signalId);

        // Emit signal
        try {
            this._dbusImpl.emit_signal('StatusNotifierItemRegistered',
                new GLib.Variant('(s)', [uniqueId]));
        } catch (e) {
            debug(`Failed to emit StatusNotifierItemRegistered: ${e.message}`);
        }

        // Notify the extension
        this._extension._onItemRegistered(uniqueId, busName, objectPath);
    }

    _unregisterItem(uniqueId) {
        if (!this._items.has(uniqueId)) {
            return;
        }

        this._items.delete(uniqueId);

        // Unsubscribe from name owner changes
        const signalId = this._nameOwnerChangedIds.get(uniqueId);
        if (signalId) {
            Gio.DBus.session.signal_unsubscribe(signalId);
            this._nameOwnerChangedIds.delete(uniqueId);
        }

        // Emit signal
        try {
            this._dbusImpl.emit_signal('StatusNotifierItemUnregistered',
                new GLib.Variant('(s)', [uniqueId]));
        } catch (e) {
            debug(`Failed to emit StatusNotifierItemUnregistered: ${e.message}`);
        }

        // Notify the extension
        this._extension._onItemUnregistered(uniqueId);
    }

    /**
     * D-Bus method: RegisterStatusNotifierHost
     * We don't support additional hosts
     */
    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_dbus_error(
            'org.freedesktop.DBus.Error.NotSupported',
            'Registering additional notification hosts is not supported'
        );
    }

    /**
     * D-Bus property: RegisteredStatusNotifierItems
     */
    get RegisteredStatusNotifierItems() {
        return Array.from(this._items.keys());
    }

    /**
     * D-Bus property: IsStatusNotifierHostRegistered
     */
    get IsStatusNotifierHostRegistered() {
        return true;
    }

    /**
     * D-Bus property: ProtocolVersion
     */
    get ProtocolVersion() {
        return 0;
    }

    destroy() {
        debug('Destroying StatusNotifierWatcher');

        this._cancellable.cancel();

        // Emit host unregistered signal
        try {
            this._dbusImpl.emit_signal('StatusNotifierHostUnregistered', null);
        } catch (e) {
            // Ignore
        }

        // Unsubscribe from all name owner changes
        for (const signalId of this._nameOwnerChangedIds.values()) {
            try {
                Gio.DBus.session.signal_unsubscribe(signalId);
            } catch (e) {
                // Ignore
            }
        }
        this._nameOwnerChangedIds.clear();

        // Release bus name
        if (this._ownNameId) {
            Gio.DBus.session.unown_name(this._ownNameId);
            this._ownNameId = 0;
        }

        // Unexport D-Bus object
        try {
            this._dbusImpl.unexport();
        } catch (e) {
            // Ignore
        }

        this._items.clear();
    }
}

/**
 * StatusTrayExtension - Main extension class
 *
 * Provides its own StatusNotifierWatcher and creates
 * TrayItem instances for each registered item.
 */
export default class StatusTrayExtension extends Extension {
    enable() {
        debug('Extension enabling...');

        // Load settings
        this._settings = this.getSettings();

        // Map of uniqueId -> TrayItem
        this._items = new Map();

        // GSettings signal connection IDs
        this._settingsConnections = [];

        // Connect to settings changes
        this._settingsConnections.push(
            this._settings.connect('changed::disabled-apps', () => {
                debug('disabled-apps setting changed');
                this._refreshItems();
            })
        );

        this._settingsConnections.push(
            this._settings.connect('changed::icon-mode', () => {
                debug('icon-mode setting changed');
                this._refreshIconStyles();
            })
        );

        this._settingsConnections.push(
            this._settings.connect('changed::icon-overrides', () => {
                debug('icon-overrides setting changed');
                this._refreshIcons();
            })
        );

        this._settingsConnections.push(
            this._settings.connect('changed::icon-effect-overrides', () => {
                debug('icon-effect-overrides setting changed');
                this._refreshIconStyles();
            })
        );

        this._settingsConnections.push(
            this._settings.connect('changed::app-order', () => {
                debug('app-order setting changed');
                this._reorderItems();
            })
        );

        // Create our own StatusNotifierWatcher
        // This makes the extension independent of any external daemon
        this._watcher = new StatusNotifierWatcher(this);

        debug('Extension enabled');
    }

    disable() {
        debug('Extension disabling...');

        // Destroy the watcher first (this will trigger unregistration of items)
        if (this._watcher) {
            this._watcher.destroy();
            this._watcher = null;
        }

        // Disconnect settings signals
        for (const id of this._settingsConnections) {
            this._settings.disconnect(id);
        }
        this._settingsConnections = [];
        this._settings = null;

        // Destroy all TrayItems
        for (const [key, item] of this._items) {
            item.destroy();
        }
        this._items.clear();

        debug('Extension disabled');
    }

    /**
     * Called by the watcher when an item is registered
     */
    _onItemRegistered(uniqueId, busName, objectPath) {
        debug(`Item registered: ${uniqueId}`);

        // Check if disabled in settings
        const disabledApps = this._settings.get_strv('disabled-apps');
        const appId = this._extractAppId(uniqueId);
        if (disabledApps.includes(appId)) {
            debug(`Skipping disabled app: ${appId}`);
            return;
        }

        // Check if we already have this item
        if (this._items.has(uniqueId)) {
            debug(`Item already exists: ${uniqueId}`);
            return;
        }

        // Create a TrayItem for it
        const trayItem = new TrayItem(busName, objectPath, this._settings);
        this._items.set(uniqueId, trayItem);

        // Determine position based on app-order setting
        const position = this._calculatePosition(appId);

        // Add to panel
        Main.panel.addToStatusArea(`StatusTray-${uniqueId}`, trayItem, position, 'right');
        debug(`Added TrayItem: ${uniqueId} at position ${position}`);
    }

    /**
     * Called by the watcher when an item is unregistered
     */
    _onItemUnregistered(uniqueId) {
        debug(`Item unregistered: ${uniqueId}`);

        const trayItem = this._items.get(uniqueId);
        if (trayItem) {
            trayItem.destroy();
            this._items.delete(uniqueId);
            debug(`Removed TrayItem: ${uniqueId}`);
        }
    }

    /**
     * Refresh all items based on current disabled-apps setting
     */
    _refreshItems() {
        const disabledApps = this._settings.get_strv('disabled-apps');

        // Remove items that are now disabled
        for (const [key, item] of this._items) {
            const appId = this._extractAppId(key);
            if (disabledApps.includes(appId)) {
                debug(`Removing disabled item: ${appId}`);
                item.destroy();
                this._items.delete(key);
            }
        }

        // Re-add items that are now enabled (from watcher's list)
        if (this._watcher) {
            for (const uniqueId of this._watcher.RegisteredStatusNotifierItems) {
                if (!this._items.has(uniqueId)) {
                    const itemInfo = this._watcher._items.get(uniqueId);
                    if (itemInfo) {
                        this._onItemRegistered(uniqueId, itemInfo.busName, itemInfo.objectPath);
                    }
                }
            }
        }
    }

    /**
     * Refresh icon styles on all items (when icon-mode changes)
     */
    _refreshIconStyles() {
        for (const [key, item] of this._items) {
            item._applySymbolicStyle();
        }
    }

    /**
     * Refresh icons on all items (when icon-overrides changes)
     */
    _refreshIcons() {
        for (const [key, item] of this._items) {
            item._updateIcon();
        }
    }

    /**
     * Extract app ID from item key for settings matching
     */
    _extractAppId(key) {
        // Key format: "busName/objectPath" or "busName"
        // Try to get meaningful ID from object path
        const slashIndex = key.indexOf('/');
        if (slashIndex > 0) {
            const objectPath = key.substring(slashIndex);
            const pathParts = objectPath.split('/').filter(p => p.length > 0);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                if (lastPart !== 'StatusNotifierItem' && lastPart !== 'item') {
                    return lastPart;
                }
            }
        }
        // Fallback to bus name portion
        return slashIndex > 0 ? key.substring(0, slashIndex) : key;
    }

    /**
     * Calculate the panel position for a tray item based on app-order setting
     * Lower positions appear further right in the panel (closer to system icons)
     * Items not in app-order get position 0 (rightmost among Status Tray icons)
     */
    _calculatePosition(appId) {
        const appOrder = this._settings.get_strv('app-order');

        // If appOrder is empty or app is not in the list, use position 0
        const orderIndex = appOrder.indexOf(appId);
        if (orderIndex === -1) {
            return 0;
        }

        // Items at the start of app-order (index 0) should appear leftmost (higher position)
        // Items at the end should appear rightmost (lower position)
        // We reverse the index so first item in list gets highest position
        return appOrder.length - orderIndex;
    }

    /**
     * Reorder all tray items based on current app-order setting
     * Must destroy and recreate items because PanelMenu.Button can't be re-added
     */
    _reorderItems() {
        if (!this._watcher) return;

        debug('_reorderItems called');

        // Collect info from existing items (use their resolved _appId)
        const itemsInfo = [];
        for (const [uniqueId, trayItem] of this._items) {
            const itemData = this._watcher._items.get(uniqueId);
            if (itemData) {
                itemsInfo.push({
                    uniqueId,
                    busName: itemData.busName,
                    objectPath: itemData.objectPath,
                    appId: trayItem._appId,  // Use resolved appId from TrayItem
                });
            }
        }

        // Destroy all current items
        for (const [key, item] of this._items) {
            item.destroy();
        }
        this._items.clear();

        // Sort by app-order using the resolved appIds
        const appOrder = this._settings.get_strv('app-order');
        itemsInfo.sort((a, b) => {
            const aIndex = appOrder.indexOf(a.appId);
            const bIndex = appOrder.indexOf(b.appId);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return 0;
        });

        // Re-create items in sorted order
        // Higher position = further left, so first item gets highest position
        const disabledApps = this._settings.get_strv('disabled-apps');
        const totalItems = itemsInfo.length;

        for (let i = 0; i < itemsInfo.length; i++) {
            const { uniqueId, busName, objectPath, appId } = itemsInfo[i];

            // Skip disabled apps
            if (disabledApps.includes(appId)) {
                continue;
            }

            const trayItem = new TrayItem(busName, objectPath, this._settings);
            this._items.set(uniqueId, trayItem);

            const position = totalItems - i;
            Main.panel.addToStatusArea(`StatusTray-${uniqueId}`, trayItem, position, 'right');
            debug(`Reordered TrayItem: ${appId} at position ${position}`);
        }
    }
}
