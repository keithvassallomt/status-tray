/**
 * Icon file lookup shared by the tray (extension.js) and preferences
 * (prefs.js), so the panel, the app list and the effect preview all find an
 * app's icon in the same places. Gio and GLib only: this module is loaded
 * both inside the shell and in the preferences process, so it must not
 * import St, Clutter, Meta or Shell, nor Gtk, Gdk or Adw.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Cached theme inheritance chain — resolved once per process, and cleared by
// resetThemeChain() when the extension is disabled.
let _themeChainCache = null;
let _themeChainPromise = null;

function _loadContentsAsync(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                resolve(f.load_contents_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// The icon theme base directories searched, in order.
function _iconBaseDirs() {
    const dataDirs = GLib.get_system_data_dirs();
    const iconDirs = dataDirs.map(d => `${d}/icons`);
    iconDirs.push('/var/lib/flatpak/exports/share/icons');
    iconDirs.push(`${GLib.get_home_dir()}/.local/share/icons`);
    return iconDirs;
}

// Resolve the full theme inheritance chain by reading Inherits= from each
// theme's index.theme. Async — results cached in _themeChainCache. Callers
// that need the chain synchronously use _getThemeChain() which returns the
// cache or a minimal fallback if precompute hasn't finished.
export async function precomputeThemeChain(themeName) {
    if (_themeChainCache)
        return _themeChainCache;
    if (_themeChainPromise)
        return _themeChainPromise;

    const iconDirs = _iconBaseDirs();
    _themeChainPromise = (async () => {
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
                    const file = Gio.File.new_for_path(indexPath);
                    const [ok, contents] = await _loadContentsAsync(file);
                    if (!ok) break;
                    const text = new TextDecoder().decode(contents);
                    const match = text.match(/^Inherits\s*=\s*(.+)$/m);
                    if (match) {
                        const parents = match[1].split(',').map(s => s.trim()).filter(s => s);
                        for (const p of parents) {
                            if (!visited.has(p))
                                queue.push(p);
                        }
                    }
                } catch (_e) {
                    // ignore unreadable index files
                }
                break;
            }
        }

        if (!visited.has('hicolor'))
            chain.push('hicolor');

        _themeChainCache = chain;
        _themeChainPromise = null;
        return chain;
    })();

    return _themeChainPromise;
}

export function resetThemeChain() {
    _themeChainCache = null;
    _themeChainPromise = null;
}

function _getThemeChain(themeName) {
    if (_themeChainCache)
        return _themeChainCache;
    // Precompute hasn't finished — return a minimal chain so the caller can
    // still attempt a direct lookup. Subsequent icon refreshes will use the
    // full cache once it's ready.
    return themeName === 'hicolor' ? ['hicolor'] : [themeName, 'hicolor'];
}

// The size/category subdirectories of an FDO icon theme, most specific
// first. Shared by the host-theme search and the app-supplied
// IconThemePath search so both cover the same ground.
function _iconThemeSubdirs() {
    const categories = [
        'apps', 'applications',
        'status',
        'devices',
        'actions',
        'places',
        'mimetypes',
        'emotes',
        'categories',
        'emblems',
        'ui',
        'legacy',
    ];
    const subdirs = [];
    for (const cat of categories) {
        subdirs.push(`scalable/${cat}`);
        subdirs.push(`symbolic/${cat}`);
        for (const sz of ['48x48', '32x32', '24x24', '22x22', '16x16'])
            subdirs.push(`${sz}/${cat}`);
    }
    return subdirs;
}

// Search an app-supplied IconThemePath for `iconName`. Apps point this at
// anything from a flat directory of PNGs to the root of a full theme tree,
// and their icons are not always under `apps` — Dropbox files its sync
// status icons elsewhere in the tree — so cover the same category/size
// matrix the host-theme search uses. A complete miss costs well under a
// millisecond and only runs when an icon changes.
export function findIconInThemePath(themePath, iconName) {
    if (!themePath || themePath.length === 0)
        return null;

    const exts = ['.png', '.svg'];
    const prefixes = [''];
    for (const subdir of _iconThemeSubdirs()) {
        prefixes.push(`${subdir}/`);
        prefixes.push(`hicolor/${subdir}/`);
    }

    for (const prefix of prefixes) {
        for (const ext of exts) {
            const path = `${themePath}/${prefix}${iconName}${ext}`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                return path;
        }
    }

    return null;
}

// `themeName` is the host icon theme: St.Settings' gtk-icon-theme in the
// shell, org.gnome.desktop.interface icon-theme in preferences (the same
// setting).
export function findIconInTheme(iconName, themeName) {
    const iconDirs = _iconBaseDirs();

    const themes = _getThemeChain(themeName);
    const subdirs = _iconThemeSubdirs();
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
}

// e.g. "/run/user/1000/app/org.ferdium.Ferdium/..." -> "org.ferdium.Ferdium"
export function extractFlatpakAppId(iconThemePath) {
    if (!iconThemePath) return null;
    const match = iconThemePath.match(/\/run\/user\/\d+\/app\/([^/]+)/);
    return match ? match[1] : null;
}

// The icon file for an SNI IconName, searched in the order the tray always
// has: the name itself when it's an absolute path to a file that exists;
// then, if the app supplies an IconThemePath, that directory followed by the
// Flatpak app's own exported icon; otherwise the host icon theme. Null when
// none of those has it. Callers follow a miss with their own toolkit's
// theme lookup and the IconPixmap fallback, which this module can't do.
export function resolveIconFile(iconName, iconThemePath, themeName) {
    if (iconName.startsWith('/') && Gio.File.new_for_path(iconName).query_exists(null))
        return iconName;

    if (iconThemePath && iconThemePath.length > 0) {
        const themePathIcon = findIconInThemePath(iconThemePath, iconName);
        if (themePathIcon)
            return themePathIcon;

        // Try Flatpak app ID as icon name before falling to pixmap
        const flatpakId = extractFlatpakAppId(iconThemePath);
        return flatpakId ? findIconInTheme(flatpakId, themeName) : null;
    }

    return findIconInTheme(iconName, themeName);
}

// St (like GTK) recolours an icon file to the theme's foreground colour
// whenever its name marks it symbolic, even when it's loaded as a
// Gio.FileIcon with -st-icon-style: regular.
export function isSymbolicIconFileName(name) {
    return /-symbolic(-ltr|-rtl)?\.svg$|\.symbolic\.png$/.test(name);
}
