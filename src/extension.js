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

const DEBUG = false;
const FALLBACK_ICON_NAME = 'image-loading-symbolic';
const PIXMAPS_FORMAT = Cogl.PixelFormat.ARGB_8888;

function debug(msg) {
    if (DEBUG) {
        console.log(`[StatusTray] ${msg}`);
    }
}

// Cached theme inheritance chain — resolved once, cleared in disable().
let _themeChainCache = null;

// Resolve the full theme inheritance chain by reading Inherits= from
// each theme's index.theme.  Returns a deduped ordered list of theme names.
// Result is cached so index.theme files are only read once per session.
function _resolveThemeChain(themeName, iconDirs) {
    if (_themeChainCache)
        return _themeChainCache;

    const visited = new Set();
    const chain = [];
    const queue = [themeName];

    while (queue.length > 0) {
        const name = queue.shift();
        if (visited.has(name))
            continue;
        visited.add(name);
        chain.push(name);

        for (const baseDir of iconDirs) {
            const indexPath = `${baseDir}/${name}/index.theme`;
            if (!GLib.file_test(indexPath, GLib.FileTest.EXISTS))
                continue;
            try {
                const [ok, contents] = GLib.file_get_contents(indexPath);
                if (!ok) continue;
                const text = new TextDecoder().decode(contents);
                const match = text.match(/^Inherits\s*=\s*(.+)$/m);
                if (match) {
                    const parents = match[1].split(',').map(s => s.trim()).filter(s => s);
                    for (const p of parents) {
                        if (!visited.has(p))
                            queue.push(p);
                    }
                }
            } catch (e) {
                // ignore unreadable index files
            }
            break; // found this theme's index, no need to check other dirs
        }
    }

    // Always include hicolor as ultimate fallback
    if (!visited.has('hicolor'))
        chain.push('hicolor');

    _themeChainCache = chain;
    return chain;
}

function findIconInTheme(iconName) {
    try {
        const themeName = St.Settings.get().gtk_icon_theme;
        const dataDirs = GLib.get_system_data_dirs();

        const iconDirs = dataDirs.map(d => `${d}/icons`);
        iconDirs.push('/var/lib/flatpak/exports/share/icons');
        iconDirs.push(`${GLib.get_home_dir()}/.local/share/icons`);

        const themes = _resolveThemeChain(themeName, iconDirs);
        const categories = ['apps', 'status', 'legacy', 'devices', 'actions'];
        const subdirs = [];
        for (const cat of categories) {
            subdirs.push(`scalable/${cat}`);
            subdirs.push(`symbolic/${cat}`);
            for (const sz of ['48x48', '32x32', '24x24', '22x22', '16x16'])
                subdirs.push(`${sz}/${cat}`);
        }
        const exts = ['.svg', '.png'];
        // Also try the -symbolic variant as a fallback for standard icon names
        const names = [iconName];
        if (!iconName.endsWith('-symbolic'))
            names.push(`${iconName}-symbolic`);

        for (const name of names) {
            for (const baseDir of iconDirs) {
                for (const theme of themes) {
                    for (const subdir of subdirs) {
                        for (const ext of exts) {
                            const path = `${baseDir}/${theme}/${subdir}/${name}${ext}`;
                            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                                return path;
                        }
                    }
                }
            }
        }

        return null;
    } catch (e) {
        debug(`Error checking icon existence: ${e.message}`);
        return null;
    }
}

// SNI D-Bus interface XML — helps Gio.DBusProxy handle broken implementations
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
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
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

const WATCHER_BUS_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_OBJECT_PATH = '/StatusNotifierWatcher';
const DEFAULT_ITEM_OBJECT_PATH = '/StatusNotifierItem';

const BUS_ADDRESS_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;

let _sniInterfaceInfo = null;
function getSNIInterfaceInfo() {
    if (!_sniInterfaceInfo) {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(SNI_INTERFACE_XML);
        _sniInterfaceInfo = nodeInfo.lookup_interface('org.kde.StatusNotifierItem');
    }
    return _sniInterfaceInfo;
}

let _interfaceSettings = null;

function isDarkMode() {
    try {
        if (!_interfaceSettings) {
            _interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        }
        const colorScheme = _interfaceSettings.get_string('color-scheme');
        return colorScheme === 'prefer-dark';
    } catch (e) {
        // Fallback: assume dark mode (most common)
        return true;
    }
}

// "_File" -> "File", "__File" -> "_File"
function stripMnemonics(label) {
    if (!label) return '';
    return label.replace(/__/g, '\x00').replace(/_/g, '').replace(/\x00/g, '_');
}

// e.g. "/run/user/1000/app/org.ferdium.Ferdium/..." -> "org.ferdium.Ferdium"
function extractFlatpakAppId(iconThemePath) {
    if (!iconThemePath) return null;
    const match = iconThemePath.match(/\/run\/user\/\d+\/app\/([^/]+)/);
    return match ? match[1] : null;
}

const TrayItem = GObject.registerClass({
    Signals: {
        'appid-resolved': { param_types: [GObject.TYPE_STRING] },
    },
}, class TrayItem extends PanelMenu.Button {
    _init(busName, objectPath, settings) {
        const itemId = this._extractId(busName, objectPath);
        super._init(0.0, `StatusTray-${itemId}`);

        this._busName = busName;
        this._objectPath = objectPath;
        this._menuPath = null;
        this._iconThemePath = null;
        this._settings = settings;
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();

        // Preliminary ID; updated later with SNI Id/ToolTip when available
        this._appId = this._extractId(busName, objectPath);

        this._signalIds = [];

        this._tempFilePath = null;
        this._fallbackOverrideIcon = null;

        this._icon = new St.Icon({
            style_class: 'system-status-icon status-tray-icon',
            icon_name: FALLBACK_ICON_NAME,
        });
        this.add_child(this._icon);

        this.add_style_class_name('status-tray-button');

        this._initProxy();

        // GNOME Shell won't open an empty menu, so add a placeholder
        this._loadingItem = new PopupMenu.PopupMenuItem('Loading...', {
            reactive: false,
            style_class: 'popup-inactive-menu-item',
        });
        this.menu.addMenuItem(this._loadingItem);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            debug(`Menu open-state-changed: isOpen=${isOpen}, busName=${this._busName}`);
            if (isOpen) {
                this._loadMenu();
            }
        });

        debug(`Created TrayItem for ${busName} at ${objectPath}`);
    }

    _extractId(busName, objectPath) {
        const pathParts = objectPath.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
            const lastPart = pathParts[pathParts.length - 1];
            if (lastPart !== 'StatusNotifierItem' && lastPart !== 'item') {
                return lastPart;
            }
        }
        return busName;
    }

    async _initProxy() {
        try {
            this._proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: this._busName,
                g_object_path: this._objectPath,
                g_interface_name: 'org.kde.StatusNotifierItem',
                g_interface_info: getSNIInterfaceInfo(),
                g_flags: Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            });

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

            this._proxy.connect('g-properties-changed', (proxy, changed, invalidated) => {
                const props = Object.keys(changed.deep_unpack());
                debug(`Properties changed for ${this._busName}: ${props.join(', ')}`);

                if (props.some(p => p.startsWith('Icon'))) {
                    this._updateIcon();
                }
            });

            this._fetchPropertiesFromProxy();
            this._subscribeToSignals();

        } catch (e) {
            debug(`Failed to initialize proxy for ${this._busName}: ${e.message}`);
            this._connectToSNIFallback();
        }
    }

    _fetchPropertiesFromProxy() {
        const iconThemePath = this._proxy.get_cached_property('IconThemePath');
        if (iconThemePath) {
            this._iconThemePath = iconThemePath.deep_unpack();
            debug(`Got IconThemePath from proxy: ${this._iconThemePath}`);
        }

        const menuPath = this._proxy.get_cached_property('Menu');
        if (menuPath) {
            this._menuPath = menuPath.deep_unpack();
            debug(`Got Menu path from proxy: ${this._menuPath}`);
        }

        // Resolve app ID using priority order:
        // 1. ToolTip title (best for Electron apps)
        // 2. Flatpak app ID from IconThemePath
        // 3. SNI Id (if not generic chrome_status_icon_*)
        // 4. Keep existing fallback from object path
        this._resolveAppId();

        this._updateIcon();
    }

    _resolveAppId() {
        const oldAppId = this._appId;
        let newAppId = null;

        // Try ToolTip title first (most reliable for Electron apps)
        const toolTipVariant = this._proxy.get_cached_property('ToolTip');
        if (toolTipVariant) {
            try {
                const toolTip = toolTipVariant.deep_unpack();
                // ToolTip is (sa(iiay)ss): icon_name, icon_pixmap, title, description
                if (toolTip && toolTip.length >= 3 && toolTip[2] && toolTip[2].length > 0) {
                    newAppId = toolTip[2];
                    debug(`Got app ID from ToolTip title: ${newAppId}`);
                }
            } catch (e) {
                debug(`Failed to parse ToolTip: ${e.message}`);
            }
        }

        // Try Flatpak app ID from IconThemePath
        if (!newAppId && this._iconThemePath) {
            const flatpakId = extractFlatpakAppId(this._iconThemePath);
            if (flatpakId) {
                newAppId = flatpakId;
                debug(`Got app ID from Flatpak IconThemePath: ${newAppId}`);
            }
        }

        // Try SNI Id (but skip generic chrome_status_icon_* names)
        if (!newAppId) {
            const idVariant = this._proxy.get_cached_property('Id');
            if (idVariant) {
                const sniId = idVariant.deep_unpack();
                if (sniId && sniId.length > 0 && !sniId.startsWith(':') && !sniId.startsWith('chrome_status_icon_')) {
                    newAppId = sniId;
                    debug(`Got app ID from SNI Id: ${newAppId}`);
                }
            }
        }

        if (newAppId && newAppId !== oldAppId) {
            this._appId = newAppId;
            debug(`Updated appId from ${oldAppId} to ${this._appId}`);
            this.emit('appid-resolved', this._appId);
        }
    }

    _updateIcon() {
        debug(`_updateIcon called for ${this._busName}`);

        this._fallbackOverrideIcon = null;
        if (this._settings) {
            try {
                const overrides = this._settings.get_value('icon-overrides').deep_unpack();
                if (overrides[this._appId]) {
                    const overrideIcon = overrides[this._appId];
                    let isFallbackOnly = false;
                    try {
                        const fallbackApps = this._settings.get_strv('icon-fallback-overrides');
                        isFallbackOnly = fallbackApps.includes(this._appId);
                    } catch (e) {
                        // Key may not exist in older schema versions
                    }

                    if (isFallbackOnly) {
                        this._fallbackOverrideIcon = overrideIcon;
                        debug(`Fallback override stored for ${this._appId}: ${overrideIcon}`);
                    } else {
                        debug(`Using icon override for ${this._appId}: ${overrideIcon}`);
                        this._replaceIcon(overrideIcon);
                        this._applySymbolicStyle();
                        return;
                    }
                }
            } catch (e) {
                debug(`Failed to check icon overrides: ${e.message}`);
            }
        }

        if (!this._proxy) {
            if (this._fallbackOverrideIcon) {
                debug(`No proxy, using fallback override for ${this._appId}`);
                this._setIcon(this._fallbackOverrideIcon);
                return;
            }
            debug(`No proxy available for ${this._busName}, skipping icon update`);
            return;
        }

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

        // No IconName available - use fallback override if set
        if (this._fallbackOverrideIcon) {
            debug(`No IconName, using fallback override for ${this._appId}`);
            this._setIcon(this._fallbackOverrideIcon);
            return;
        }

        const iconPixmapVariant = this._proxy.get_cached_property('IconPixmap');
        if (iconPixmapVariant) {
            debug(`Got IconPixmap from proxy, processing...`);
            this._setIconFromPixmap(iconPixmapVariant);
            return;
        }

        debug(`No cached icon properties for ${this._busName}, trying direct fetch`);
        this._fetchIconDirect();
    }

    _fetchIconDirect() {
        const bus = Gio.DBus.session;

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
                    } else if (this._fallbackOverrideIcon) {
                        debug(`No IconName (direct), using fallback override for ${this._appId}`);
                        this._setIcon(this._fallbackOverrideIcon);
                    } else {
                        debug(`IconName is empty for ${this._busName}, trying IconPixmap`);
                        this._fetchIconPixmapDirect();
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get IconName: ${e}`);
                    }
                    if (this._fallbackOverrideIcon) {
                        this._setIcon(this._fallbackOverrideIcon);
                    } else {
                        this._fetchIconPixmapDirect();
                    }
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
                        debug(`No IconPixmap available, falling back for: ${iconName}`);
                        this._setIconFromThemeFile(iconName);
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`IconPixmap failed for sandboxed app: ${e.message}`);
                        debug(`Falling back for: ${iconName}`);
                        this._setIconFromThemeFile(iconName);
                    }
                }
            }
        );
    }

    _subscribeToSignals() {
        const bus = Gio.DBus.session;

        const newIconId = bus.signal_subscribe(
            this._busName,
            'org.kde.StatusNotifierItem',
            'NewIcon',
            this._objectPath,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                debug(`NewIcon signal for ${this._busName}`);
                // Refetch icon directly from D-Bus rather than invalidating
                // the proxy cache first — invalidating causes _updateIcon to
                // see empty cache and take the slow async path, which creates
                // a visible blank frame between the old and new icon.
                this._fetchIconDirect();
            }
        );
        this._signalIds.push(newIconId);

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

    _connectToSNIFallback() {
        debug(`Using fallback D-Bus calls for ${this._busName}`);
        this._fetchIdDirect();
        this._fetchIconDirect();
        this._fetchMenuPathDirect();
        this._subscribeToSignals();
    }

    _fetchIdDirect() {
        const bus = Gio.DBus.session;

        // Fetch ToolTip first (highest priority for Electron apps)
        bus.call(
            this._busName,
            this._objectPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'ToolTip']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [variant] = reply.deep_unpack();
                    const toolTip = variant.deep_unpack();
                    // ToolTip is (sa(iiay)ss): icon_name, icon_pixmap, title, description
                    if (toolTip && toolTip.length >= 3 && toolTip[2] && toolTip[2].length > 0) {
                        const oldAppId = this._appId;
                        this._appId = toolTip[2];
                        debug(`Updated appId from ${oldAppId} to ${this._appId} (from ToolTip, fallback)`);
                        this.emit('appid-resolved', this._appId);
                        return; // ToolTip found, no need to try other sources
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get ToolTip (fallback): ${e.message}`);
                    }
                }
                // ToolTip not available, try IconThemePath for Flatpak ID
                this._fetchIdFromIconThemePathDirect();
            }
        );
    }

    _fetchIdFromIconThemePathDirect() {
        const bus = Gio.DBus.session;

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
                    const iconThemePath = variant.deep_unpack();
                    if (iconThemePath) {
                        this._iconThemePath = iconThemePath;
                        const flatpakId = extractFlatpakAppId(iconThemePath);
                        if (flatpakId) {
                            const oldAppId = this._appId;
                            this._appId = flatpakId;
                            debug(`Updated appId from ${oldAppId} to ${this._appId} (from Flatpak path, fallback)`);
                            this.emit('appid-resolved', this._appId);
                            return;
                        }
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get IconThemePath (fallback): ${e.message}`);
                    }
                }
                // No Flatpak ID, try SNI Id as last resort
                this._fetchSniIdDirect();
            }
        );
    }

    _fetchSniIdDirect() {
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
                    if (sniId && sniId.length > 0 && !sniId.startsWith(':') && !sniId.startsWith('chrome_status_icon_')) {
                        const oldAppId = this._appId;
                        this._appId = sniId;
                        debug(`Updated appId from ${oldAppId} to ${this._appId} (from SNI Id, fallback)`);
                        this.emit('appid-resolved', this._appId);
                    }
                } catch (e) {
                    if (!e.message?.includes('CANCELLED')) {
                        debug(`Failed to get SNI Id: ${e.message}`);
                    }
                }
            }
        );
    }

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

        if (iconName.startsWith('/')) {
            const file = Gio.File.new_for_path(iconName);
            if (file.query_exists(null)) {
                debug(`Using absolute icon path: ${iconName}`);
                const gicon = new Gio.FileIcon({ file });
                this._icon.set_gicon(gicon);
                this._clearIconExcept('gicon');
                this._applySymbolicStyle();
                return;
            } else {
                debug(`Absolute icon path doesn't exist: ${iconName}`);
            }
        }

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
                    this._clearIconExcept('gicon');
                    this._applySymbolicStyle();
                    return;
                }
            }
            debug(`No icon file found in IconThemePath: ${this._iconThemePath}`);

            // Try Flatpak app ID as icon name before falling to pixmap
            const flatpakId = extractFlatpakAppId(this._iconThemePath);
            const flatpakIconPath = flatpakId ? findIconInTheme(flatpakId) : null;
            if (flatpakIconPath) {
                debug(`Using Flatpak app icon: ${flatpakId} (${flatpakIconPath})`);
                const file = Gio.File.new_for_path(flatpakIconPath);
                this._icon.set_gicon(new Gio.FileIcon({ file }));
                this._clearIconExcept('gicon');
                this._applySymbolicStyle();
                return;
            }

            debug(`IconThemePath inaccessible (possibly sandboxed), trying IconPixmap`);
            this._fetchIconPixmapWithFallback(iconName);
            return;
        }

        const iconPath = findIconInTheme(iconName);
        if (iconPath) {
            debug(`Using icon file from theme: ${iconPath}`);
            const file = Gio.File.new_for_path(iconPath);
            this._icon.set_gicon(new Gio.FileIcon({ file }));
            this._clearIconExcept('gicon');
            this._applySymbolicStyle();
        } else {
            // Let St.Icon / GTK resolve the icon via the full theme engine
            // (handles inheritance, legacy dirs, symbolic fallbacks, etc.)
            debug(`Using GTK icon resolution for: ${iconName}`);
            this._icon.set_icon_name(iconName);
            this._clearIconExcept('icon_name');
            this._applySymbolicStyle();
        }
    }

    // Clear icon properties that are NOT the active rendering source.
    // This prevents ghost artifacts from previous icon modes without
    // causing a blank frame by clearing the active source first.
    _clearIconExcept(activeSource) {
        if (activeSource !== 'content') {
            this._icon.content = null;
            this._icon.content_gravity = Clutter.ContentGravity.CENTER;
        }
        if (activeSource !== 'gicon')
            this._icon.gicon = null;
        if (activeSource !== 'icon_name')
            this._icon.icon_name = null;
        if (activeSource === 'icon_name')
            this._icon.set_size(-1, -1);
    }

    // Destroy and recreate the St.Icon widget to guarantee a clean state.
    // Necessary when switching from pixmap (St.ImageContent) to a named icon,
    // as residual widget state can prevent the new icon from rendering.
    _replaceIcon(iconNameOrPath) {
        this.remove_child(this._icon);
        if (iconNameOrPath.startsWith('/')) {
            const file = Gio.File.new_for_path(iconNameOrPath);
            this._icon = new St.Icon({
                style_class: 'system-status-icon status-tray-icon',
                gicon: new Gio.FileIcon({ file }),
            });
        } else {
            this._icon = new St.Icon({
                style_class: 'system-status-icon status-tray-icon',
                icon_name: iconNameOrPath,
            });
        }
        this.add_child(this._icon);
    }

    // Last-resort icon setter: tries to load the icon file directly from
    // the theme directory, bypassing the GTK icon theme engine.  Falls back
    // to set_icon_name() if the file isn't found on disk.
    _setIconFromThemeFile(iconName) {
        const iconPath = findIconInTheme(iconName);
        if (iconPath) {
            debug(`Fallback: using icon file from theme: ${iconPath}`);
            const file = Gio.File.new_for_path(iconPath);
            this._icon.set_gicon(new Gio.FileIcon({ file }));
            this._clearIconExcept('gicon');
        } else {
            debug(`Fallback: icon ${iconName} not found on disk, using icon_name`);
            this._icon.set_icon_name(iconName);
            this._clearIconExcept('icon_name');
        }
        this._applySymbolicStyle();
    }

    _applySymbolicStyle() {
        const iconName = this._icon.icon_name;
        const isSymbolicIcon = iconName && iconName.endsWith('-symbolic');
        // Only force regular style when we loaded a file via gicon — this
        // prevents St from re-interpreting the raster/SVG as symbolic.
        // When using icon_name (GTK theme lookup), let St.Icon decide so it
        // can fall back to -symbolic variants for icons like battery-full.
        const usingGicon = this._icon.gicon != null;
        let iconStyleCss;
        if (isSymbolicIcon)
            iconStyleCss = ' -st-icon-style: symbolic;';
        else if (usingGicon)
            iconStyleCss = ' -st-icon-style: regular;';
        else
            iconStyleCss = '';

        const iconMode = this._settings?.get_string('icon-mode') ?? 'symbolic';
        if (iconMode !== 'symbolic') {
            this._icon.clear_effects();
            this._icon.set_style(`icon-size: 16px;${iconStyleCss}`);
            return;
        }

        const dark = isDarkMode();

        let desaturation = 1.0;
        let brightness = dark ? 0.5 : -0.5;
        let contrast = 0.6;
        let useTint = false;
        let tintColor = [1.0, 1.0, 1.0];  // White default

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

        this._icon.clear_effects();

        // Symbolic icons (e.g. shield-symbolic) are already monochrome and
        // get recoloured by St.Icon to match the panel theme.  Desaturation
        // and brightness/contrast effects are designed for full-colour icons
        // and will make symbolic icons invisible.  Tint is still useful so
        // we only skip desaturate + brightness/contrast here.
        if (!isSymbolicIcon) {
            if (desaturation > 0) {
                const desaturate = new Clutter.DesaturateEffect({ factor: desaturation });
                this._icon.add_effect_with_name('desaturate', desaturate);
            }

            const bc = new Clutter.BrightnessContrastEffect();
            bc.set_contrast_full(contrast, contrast, contrast);
            bc.set_brightness_full(brightness, brightness, brightness);
            this._icon.add_effect_with_name('brightness', bc);
        }

        if (useTint && tintColor) {
            try {
                let color;
                if (Cogl.Color.prototype.init_from_4f) {
                    color = new Cogl.Color();
                    color.init_from_4f(tintColor[0], tintColor[1], tintColor[2], 1.0);
                } else {
                    color = Clutter.Color.new(
                        Math.round(tintColor[0] * 255),
                        Math.round(tintColor[1] * 255),
                        Math.round(tintColor[2] * 255),
                        255
                    );
                }
                const colorize = new Clutter.ColorizeEffect();
                colorize.set_tint(color);
                this._icon.add_effect_with_name('tint', colorize);
            } catch (e) {
                debug(`Failed to apply tint effect: ${e.message}`);
            }
        }

        this._icon.set_style(`icon-size: 16px;${iconStyleCss}`);
    }

    _setIconFromPixmap(pixmapVariant) {
        try {
            let pixmaps;
            if (pixmapVariant instanceof GLib.Variant) {
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
                pixmaps = pixmapVariant;
                if (!pixmaps || pixmaps.length === 0) {
                    debug(`No IconPixmap data for ${this._busName}`);
                    return;
                }
            }

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

            try {
                const imageContent = new St.ImageContent({
                    preferred_width: width,
                    preferred_height: height,
                });

                let pixelBytes;
                if (pixelData instanceof GLib.Bytes) {
                    pixelBytes = pixelData;
                } else if (pixelData.get_data_as_bytes) {
                    pixelBytes = pixelData.get_data_as_bytes();
                } else {
                    pixelBytes = GLib.Bytes.new(pixelData);
                }

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

                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const scaledSize = 16 * scaleFactor;

                this._icon.set({
                    content: imageContent,
                    width: scaledSize,
                    height: scaledSize,
                    content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                });

                this._clearIconExcept('content');

                this._applySymbolicStyle();
                debug(`Set IconPixmap via St.ImageContent for ${this._busName}`);
                return;

            } catch (stError) {
                debug(`St.ImageContent failed, falling back to temp file: ${stError.message}`);
            }

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

            this._tempFilePath = tempPath;

            const file = Gio.File.new_for_path(tempPath);
            const gicon = new Gio.FileIcon({ file });
            this._icon.set_gicon(gicon);
            this._clearIconExcept('gicon');
            this._applySymbolicStyle();

            debug(`IconPixmap saved to ${tempPath} (fallback)`);

        } catch (e) {
            debug(`Failed to set IconPixmap: ${e.message}`);
        }
    }

    // IconPixmap ARGB (big-endian) -> GdkPixbuf RGBA
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

    _loadMenu() {
        debug(`_loadMenu called for ${this._busName}, menuPath=${this._menuPath}`);

        if (!this._menuPath) {
            debug(`No menu path for ${this._busName}`);
            return;
        }

        this.menu.removeAll();
        const loadingItem = new PopupMenu.PopupMenuItem('Loading...', {
            reactive: false,
            style_class: 'popup-inactive-menu-item',
        });
        this.menu.addMenuItem(loadingItem);

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
                    this.menu.removeAll();
                    this._buildMenuFromLayout(layout);
                } catch (e) {
                    debug(`Failed to get menu layout: ${e}`);
                }
            }
        );
    }

    _buildMenuFromLayout(layout) {
        const [rootId, rootProps, children] = layout;

        if (!children || children.length === 0) {
            debug('Menu has no items');
            return;
        }

        this._lastMenuItemType = null;

        for (const childVariant of children) {
            const child = childVariant.deep_unpack();
            this._addMenuItem(child);
        }
    }

    _addMenuItem(item) {
        const [itemId, properties, children] = item;

        const rawLabel = properties['label']?.deep_unpack() || '';
        const label = stripMnemonics(rawLabel);
        const visible = properties['visible']?.deep_unpack() ?? true;
        const enabled = properties['enabled']?.deep_unpack() ?? true;
        const type = properties['type']?.deep_unpack() || '';
        const childrenDisplay = properties['children-display']?.deep_unpack() || '';

        if (!visible) {
            debug(`Skipping invisible item: ${label} (id=${itemId})`);
            return;
        }

        if (label === '' && itemId === 0) {
            if (children && children.length > 0) {
                for (const childVariant of children) {
                    const child = childVariant.deep_unpack();
                    this._addMenuItem(child);
                }
            }
            return;
        }

        if (type === 'separator' || label === '') {
            if (this._lastMenuItemType === 'separator') {
                debug(`Skipping consecutive separator (id=${itemId})`);
                return;
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._lastMenuItemType = 'separator';
            return;
        }

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

        const menuItem = new PopupMenu.PopupMenuItem(label);
        if (!enabled) {
            menuItem.setSensitive(false);
        }

        menuItem.connect('activate', () => {
            this._activateMenuItem(itemId, label);
        });

        this.menu.addMenuItem(menuItem);
        this._lastMenuItemType = 'item';

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
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        const bus = Gio.DBus.session;
        for (const signalId of this._signalIds)
            bus.signal_unsubscribe(signalId);
        this._signalIds = [];

        this._proxy = null;

        if (this._tempFilePath) {
            try {
                const file = Gio.File.new_for_path(this._tempFilePath);
                file.delete(null);
            } catch (e) {
                // Ignore cleanup errors - file may not exist or already deleted
            }
            this._tempFilePath = null;
        }

        debug(`Destroyed TrayItem for ${this._busName}`);
        super.destroy();
    }
});

class StatusNotifierWatcher {
    constructor(extension) {
        this._extension = extension;
        this._items = new Map();
        this._nameOwnerChangedIds = new Map();
        this._cancellable = new Gio.Cancellable();
        this._healthCheckTimeoutId = 0;
        this._pendingDelayIds = new Set();

        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(SNW_INTERFACE_XML);
        const ifaceInfo = nodeInfo.lookup_interface('org.kde.StatusNotifierWatcher');

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(ifaceInfo, this);

        try {
            this._dbusImpl.export(Gio.DBus.session, WATCHER_OBJECT_PATH);
            debug('StatusNotifierWatcher exported on D-Bus');
        } catch (e) {
            debug(`Failed to export StatusNotifierWatcher: ${e.message}`);
        }

        this._ownNameId = Gio.DBus.session.own_name(
            WATCHER_BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => {
                debug(`Acquired bus name: ${WATCHER_BUS_NAME}`);
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

        this._seekExistingItems();

        // Schedule a delayed health check for items discovered above.
        // After suspend/resume, GNOME Shell disables and re-enables extensions,
        // so this constructor runs fresh each time. Stale Flatpak xdg-dbus-proxy
        // zombies often respond to initial property queries but break within
        // seconds — the delay gives them time to fail before we test.
        // At normal login this is harmless: all items pass the check.
        this._healthCheckTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
            this._healthCheckTimeoutId = 0;
            this._healthCheckAllItems();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Find apps that registered before we claimed the watcher name
    async _seekExistingItems() {
        try {
            const bus = Gio.DBus.session;

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

            for (const name of names) {
                if (name.startsWith(':')) {
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

    _delay(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._pendingDelayIds.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._pendingDelayIds.add(id);
        });
    }

    // After suspend/resume, Flatpak xdg-dbus-proxy zombies keep their bus name
    // alive but stop responding. We detect these and kill them so
    // NameOwnerChanged fires and cleans up normally.
    async _healthCheckAllItems() {
        // Delay to let D-Bus settle after resume
        await this._delay(5000);

        const bus = Gio.DBus.session;
        const staleItems = [];

        for (const [uniqueId, itemInfo] of this._items) {
            const isStale = await this._isItemStale(bus, itemInfo);
            if (isStale) {
                debug(`Health check failed for ${uniqueId}`);
                staleItems.push({uniqueId, busName: itemInfo.busName});
            } else {
                debug(`Health check passed: ${uniqueId}`);
            }
        }

        for (const {uniqueId, busName} of staleItems) {
            const killed = await this._tryKillStaleProxy(busName);
            if (!killed) {
                // Non-Flatpak or couldn't kill — unregister directly
                debug(`Direct unregister for stale item: ${uniqueId}`);
                this._unregisterItem(uniqueId);
            }
            // If killed, NameOwnerChanged will fire and clean up for us
        }

        if (staleItems.length > 0) {
            debug(`Handled ${staleItems.length} stale item(s) after resume`);
            // Wait for NameOwnerChanged from killed proxies before re-scanning
            await this._delay(2000);
        }

        // Re-scan for apps that may have re-registered with new bus names
        this._seekExistingItems();
    }

    // Two-phase check: GetAll on SNI properties + GetLayout on menu.
    // Catches "half-alive" proxies where properties work but menu is broken.
    async _isItemStale(bus, itemInfo) {
        try {
            const propsResult = await new Promise((resolve, reject) => {
                bus.call(
                    itemInfo.busName,
                    itemInfo.objectPath,
                    'org.freedesktop.DBus.Properties',
                    'GetAll',
                    new GLib.Variant('(s)', ['org.kde.StatusNotifierItem']),
                    new GLib.VariantType('(a{sv})'),
                    Gio.DBusCallFlags.NONE,
                    5000,
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

            const props = propsResult.deep_unpack()[0];
            const menuVariant = props['Menu'];
            if (menuVariant) {
                const menuPath = menuVariant.deep_unpack();
                debug(`Probing menu at ${itemInfo.busName} ${menuPath}`);
                await new Promise((resolve, reject) => {
                    bus.call(
                        itemInfo.busName,
                        menuPath,
                        'com.canonical.dbusmenu',
                        'GetLayout',
                        new GLib.Variant('(iias)', [0, 0, []]),
                        new GLib.VariantType('(u(ia{sv}av))'),
                        Gio.DBusCallFlags.NONE,
                        5000,
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
            }

            return false;
        } catch (e) {
            debug(`Stale check failed for ${itemInfo.busName}: ${e.message}`);
            return true;
        }
    }

    async _tryKillStaleProxy(busName) {
        try {
            const bus = Gio.DBus.session;

            const pidResult = await new Promise((resolve, reject) => {
                bus.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'GetConnectionUnixProcessID',
                    new GLib.Variant('(s)', [busName]),
                    new GLib.VariantType('(u)'),
                    Gio.DBusCallFlags.NONE,
                    2000,
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

            const [pid] = pidResult.deep_unpack();
            if (!pid) return false;

            const cgroupFile = Gio.File.new_for_path(`/proc/${pid}/cgroup`);
            const [contents] = await cgroupFile.load_contents_async(this._cancellable);

            const cgroupText = new TextDecoder().decode(contents);
            if (!cgroupText.includes('app-flatpak-')) {
                debug(`Stale item ${busName} (PID ${pid}) is not a Flatpak proxy`);
                return false;
            }

            // Killing the zombie proxy makes the bus name vanish,
            // triggering NameOwnerChanged cleanup.
            debug(`Killing stale Flatpak proxy ${busName} (PID ${pid})`);
            GLib.spawn_command_line_async(`kill ${pid}`);
            return true;
        } catch (e) {
            debug(`Failed to check/kill stale proxy ${busName}: ${e.message}`);
            return false;
        }
    }

    async _checkForSNI(busName, objectPath) {
        const bus = Gio.DBus.session;

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

            const uniqueId = `${busName}${objectPath}`;
            if (!this._items.has(uniqueId)) {
                debug(`Found existing SNI: ${uniqueId}`);
                this._registerItemInternal(busName, objectPath);
            }
        } catch (e) {
        }
    }

    async RegisterStatusNotifierItemAsync(params, invocation) {
        const [service] = params;
        let busName, objectPath;

        debug(`RegisterStatusNotifierItem called with: ${service}`);

        if (service.charAt(0) === '/') {
            busName = invocation.get_sender();
            objectPath = service;
        } else if (BUS_ADDRESS_REGEX.test(service)) {
            busName = await this._resolveNameOwner(service, invocation);
            objectPath = DEFAULT_ITEM_OBJECT_PATH;
        } else {
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

    async _resolveNameOwner(service, invocation) {
        try {
            const bus = Gio.DBus.session;
            const result = await new Promise((resolve, reject) => {
                bus.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'GetNameOwner',
                    new GLib.Variant('(s)', [service]),
                    new GLib.VariantType('(s)'),
                    Gio.DBusCallFlags.NONE,
                    1000,
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
            const [owner] = result.deep_unpack();
            return owner || invocation.get_sender();
        } catch (e) {
            debug(`Failed to resolve name owner for ${service}: ${e.message}`);
            return invocation.get_sender();
        }
    }

    getItemInfo(uniqueId) {
        const itemInfo = this._items.get(uniqueId);
        if (!itemInfo) return null;
        return {
            busName: itemInfo.busName,
            objectPath: itemInfo.objectPath,
            appId: itemInfo.appId,
        };
    }

    _registerItemInternal(busName, objectPath) {
        const uniqueId = `${busName}${objectPath}`;

        if (this._items.has(uniqueId)) {
            debug(`Item already registered: ${uniqueId}`);
            return;
        }

        this._items.set(uniqueId, { busName, objectPath, appId: null });

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

        try {
            this._dbusImpl.emit_signal('StatusNotifierItemRegistered',
                new GLib.Variant('(s)', [uniqueId]));
        } catch (e) {
            debug(`Failed to emit StatusNotifierItemRegistered: ${e.message}`);
        }

        this._extension._onItemRegistered(uniqueId, busName, objectPath);
    }

    _unregisterItem(uniqueId) {
        if (!this._items.has(uniqueId)) {
            return;
        }

        this._items.delete(uniqueId);

        const signalId = this._nameOwnerChangedIds.get(uniqueId);
        if (signalId) {
            Gio.DBus.session.signal_unsubscribe(signalId);
            this._nameOwnerChangedIds.delete(uniqueId);
        }

        try {
            this._dbusImpl.emit_signal('StatusNotifierItemUnregistered',
                new GLib.Variant('(s)', [uniqueId]));
        } catch (e) {
            debug(`Failed to emit StatusNotifierItemUnregistered: ${e.message}`);
        }

        this._extension._onItemUnregistered(uniqueId);
    }

    // Remove tracking without triggering unregister — used when GNOME Shell
    // externally disposes a TrayItem (e.g. during suspend).
    _removeItemTracking(uniqueId) {
        this._items.delete(uniqueId);

        const signalId = this._nameOwnerChangedIds.get(uniqueId);
        if (signalId) {
            Gio.DBus.session.signal_unsubscribe(signalId);
            this._nameOwnerChangedIds.delete(uniqueId);
        }

        debug(`Removed tracking for externally destroyed item: ${uniqueId}`);
    }

    updateItemAppId(uniqueId, appId) {
        const itemInfo = this._items.get(uniqueId);
        if (itemInfo) {
            itemInfo.appId = appId;
            debug(`Watcher: updated appId for ${uniqueId} to ${appId}`);
        }
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_dbus_error(
            'org.freedesktop.DBus.Error.NotSupported',
            'Registering additional notification hosts is not supported'
        );
    }

    get RegisteredStatusNotifierItems() {
        return Array.from(this._items.keys());
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    destroy() {
        debug('Destroying StatusNotifierWatcher');

        this._cancellable.cancel();

        if (this._healthCheckTimeoutId) {
            GLib.source_remove(this._healthCheckTimeoutId);
            this._healthCheckTimeoutId = 0;
        }

        for (const id of this._pendingDelayIds)
            GLib.source_remove(id);
        this._pendingDelayIds.clear();

        try {
            this._dbusImpl.emit_signal('StatusNotifierHostUnregistered', null);
        } catch (e) {
        }

        for (const signalId of this._nameOwnerChangedIds.values())
            Gio.DBus.session.signal_unsubscribe(signalId);
        this._nameOwnerChangedIds.clear();

        if (this._ownNameId) {
            Gio.DBus.session.unown_name(this._ownNameId);
            this._ownNameId = 0;
        }

        this._dbusImpl.unexport();

        this._items.clear();
    }
}

export default class StatusTrayExtension extends Extension {
    enable() {
        debug('Extension enabling...');

        this._settings = this.getSettings();

        this._items = new Map();

        this._reorderTimeoutId = null;

        this._settings.connectObject(
            'changed::disabled-apps', () => {
                debug('disabled-apps setting changed');
                this._refreshItems();
            },
            'changed::icon-mode', () => {
                debug('icon-mode setting changed');
                this._refreshIconStyles();
            },
            'changed::icon-overrides', () => {
                debug('icon-overrides setting changed');
                this._refreshIcons();
            },
            'changed::icon-effect-overrides', () => {
                debug('icon-effect-overrides setting changed');
                this._refreshIconStyles();
            },
            'changed::icon-fallback-overrides', () => {
                debug('icon-fallback-overrides setting changed');
                this._refreshIcons();
            },
            'changed::app-order', () => {
                debug('app-order setting changed');
                this._reorderItems();
            },
            this
        );

        this._watcher = new StatusNotifierWatcher(this);

        debug('Extension enabled');
    }

    disable() {
        debug('Extension disabling...');

        if (this._watcher) {
            this._watcher.destroy();
            this._watcher = null;
        }

        if (this._reorderTimeoutId) {
            GLib.source_remove(this._reorderTimeoutId);
            this._reorderTimeoutId = null;
        }

        this._settings.disconnectObject(this);
        this._settings = null;

        for (const [key, item] of this._items) {
            item._destroyedInternally = true;
            item.destroy();
        }
        this._items.clear();

        _sniInterfaceInfo = null;
        _interfaceSettings = null;
        _themeChainCache = null;

        debug('Extension disabled');
    }

    _onItemRegistered(uniqueId, busName, objectPath) {
        debug(`Item registered: ${uniqueId}`);

        const disabledApps = this._settings.get_strv('disabled-apps');
        const extractedAppId = this._extractAppId(uniqueId);

        const itemInfo = this._watcher?.getItemInfo(uniqueId);
        const storedAppId = itemInfo?.appId;

        if (disabledApps.includes(extractedAppId)) {
            debug(`Skipping disabled app: ${extractedAppId}`);
            return;
        }
        if (storedAppId && disabledApps.includes(storedAppId)) {
            debug(`Skipping disabled app (stored): ${storedAppId}`);
            return;
        }

        if (this._items.has(uniqueId)) {
            debug(`Item already exists: ${uniqueId}`);
            return;
        }

        const trayItem = new TrayItem(busName, objectPath, this._settings);
        this._items.set(uniqueId, trayItem);

        trayItem.connect('appid-resolved', (item, resolvedAppId) => {
            if (this._watcher)
                this._watcher.updateItemAppId(uniqueId, resolvedAppId);
            this._refreshItems();
        });

        // Detect when GNOME Shell externally disposes the TrayItem (e.g. during
        // suspend/resume). Clean up our references so we don't later try to
        // call methods on a disposed GObject. Internal destroys (from our own
        // code) set _destroyedInternally first so we can skip them here.
        trayItem.connect('destroy', () => {
            if (!trayItem._destroyedInternally && this._items.has(uniqueId)) {
                debug(`TrayItem externally destroyed: ${uniqueId}`);
                this._items.delete(uniqueId);
                if (this._watcher)
                    this._watcher._removeItemTracking(uniqueId);
            }
        });

        const appId = storedAppId || extractedAppId;
        const position = this._calculatePosition(appId);

        Main.panel.addToStatusArea(`StatusTray-${uniqueId}`, trayItem, position, 'right');
        debug(`Added TrayItem: ${uniqueId} at position ${position}`);
    }

    _onItemUnregistered(uniqueId) {
        debug(`Item unregistered: ${uniqueId}`);

        const trayItem = this._items.get(uniqueId);
        if (!trayItem) {
            // Already cleaned up (e.g. by the destroy signal handler)
            debug(`Item ${uniqueId} already removed`);
            return;
        }

        this._items.delete(uniqueId);
        trayItem._destroyedInternally = true;
        trayItem.destroy();
        debug(`Removed TrayItem: ${uniqueId}`);
    }

    _refreshItems() {
        const disabledApps = this._settings.get_strv('disabled-apps');

        for (const [key, item] of this._items) {
            const appId = item._appId;
            if (disabledApps.includes(appId)) {
                debug(`Removing disabled item: ${appId}`);
                if (this._watcher) {
                    this._watcher.updateItemAppId(key, appId);
                }
                item._destroyedInternally = true;
                item.destroy();
                this._items.delete(key);
            }
        }

        let itemsAdded = false;
        if (this._watcher) {
            for (const uniqueId of this._watcher.RegisteredStatusNotifierItems) {
                if (!this._items.has(uniqueId)) {
                    const itemInfo = this._watcher.getItemInfo(uniqueId);
                    if (itemInfo) {
                        this._onItemRegistered(uniqueId, itemInfo.busName, itemInfo.objectPath);
                        itemsAdded = true;
                    }
                }
            }
        }

        if (itemsAdded)
            this._scheduleReorder();
    }

    _refreshIconStyles() {
        for (const [key, item] of this._items) {
            item._applySymbolicStyle();
        }
    }

    _refreshIcons() {
        for (const [key, item] of this._items) {
            item._updateIcon();
        }
    }

    _scheduleReorder() {
        if (this._reorderTimeoutId)
            GLib.source_remove(this._reorderTimeoutId);

        this._reorderTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._reorderTimeoutId = null;
            this._reorderItems();
            return GLib.SOURCE_REMOVE;
        });
    }

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
     * LOWER positions appear further LEFT in the panel box (index 0 = leftmost)
     * HIGHER positions appear further RIGHT (closer to edge)
     * We use position 0 to place tray icons at the leftmost position in the right box
     */
    _calculatePosition(appId) {
        // If appId is a bus name (starts with :), don't use app-order positioning
        // Bus names are ephemeral and shouldn't be used for ordering
        if (appId.startsWith(':')) {
            return 0;
        }

        const appOrder = this._settings.get_strv('app-order');

        // Filter out bus names from app-order when calculating position
        // Only count real app IDs (not :1.xxx style bus names)
        const validOrder = appOrder.filter(id => !id.startsWith(':'));
        const orderIndex = validOrder.indexOf(appId);

        if (orderIndex === -1) {
            // Items not in app-order get position 0 (leftmost in right box)
            return 0;
        }

        // Items at the start of app-order (index 0) should appear leftmost (position 0)
        // Items at the end should appear rightmost (higher position index)
        return orderIndex;
    }

    /**
     * Reorder tray items in the panel based on current app-order setting.
     * Repositions existing widgets in the panel box rather than destroying
     * and recreating them, which avoids a visible flash of all icons.
     */
    _reorderItems() {
        if (!this._watcher) return;

        debug('_reorderItems called');

        const appOrder = this._settings.get_strv('app-order');

        // Build desired order from current items
        const entries = [];
        for (const [uniqueId, trayItem] of this._items) {
            entries.push({ uniqueId, trayItem, appId: trayItem._appId });
        }

        entries.sort((a, b) => {
            const aIndex = appOrder.indexOf(a.appId);
            const bIndex = appOrder.indexOf(b.appId);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return 0;
        });

        // Check if the order actually changed
        const currentOrder = Array.from(this._items.keys());
        const desiredOrder = entries.map(e => e.uniqueId);
        if (currentOrder.length === desiredOrder.length &&
            currentOrder.every((id, i) => id === desiredOrder[i])) {
            debug('_reorderItems: order unchanged, skipping');
            return;
        }

        // Reposition existing widgets within the panel box
        const rightBox = Main.panel._rightBox;
        for (let i = 0; i < entries.length; i++) {
            const { trayItem } = entries[i];
            const container = trayItem.container || trayItem;
            if (container.get_parent() === rightBox) {
                rightBox.set_child_at_index(container, i);
            }
        }

        // Rebuild the Map in the new order
        const reordered = new Map();
        for (const { uniqueId, trayItem } of entries) {
            reordered.set(uniqueId, trayItem);
        }
        this._items = reordered;

        debug(`Reordered ${entries.length} items without recreation`);
    }
}
