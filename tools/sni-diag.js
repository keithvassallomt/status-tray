#!/usr/bin/env -S gjs -m
//
// Session bus walker for investigating missing StatusNotifierItem exports.
// Read-only: it introspects, it never calls a method that changes anything.
//
// Usage:
//   gjs -m tools/sni-diag.js                 # uncapped walk (the honest answer)
//   gjs -m tools/sni-diag.js --capped        # mirror the extension's caps
//   gjs -m tools/sni-diag.js --depth 4 --calls 16 --timeout 3000
//   gjs -m tools/sni-diag.js --json out.json # machine-readable, for diffing runs
//
// Why this exists in this form: the previous version had two defects that made
// its output untrustworthy. Both are fixed here.
//
//   1. It had one "no item" bucket that conflated "the walk completed and there
//      is genuinely nothing here" with "the walk blew up and we have no idea".
//      Those are opposite findings. They are now separate buckets, and an
//      errored walk prints the error that ended it.
//
//   2. It walked with the same caps as the extension (depth 4, 24 calls), so it
//      could not be used to test whether those caps are what hides an item.
//      A capped walk that finds nothing is now reported as TRUNCATED, not as
//      "no item", because a truncated walk has not answered the question.
//
// The distinction that matters for issue #28: only CLEAN proves absence.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const SNI_INTERFACE = 'org.kde.StatusNotifierItem';
const DEFAULT_ITEM_PATH = '/StatusNotifierItem';

// Defaults are deliberately uncapped. The extension's caps are opt-in via
// --capped so that the two runs can be compared directly.
const EXTENSION_DEPTH = 4;
const EXTENSION_CALLS = 16;

function parseArgs(argv) {
    const opts = {
        depth: 64,
        calls: 100000,
        timeout: 5000,
        json: null,
        verbose: false,
        capped: false,
        probeAll: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
        case '--capped':
            opts.capped = true;
            opts.depth = EXTENSION_DEPTH;
            opts.calls = EXTENSION_CALLS;
            break;
        case '--depth':
            opts.depth = parseInt(argv[++i], 10);
            break;
        case '--calls':
            opts.calls = parseInt(argv[++i], 10);
            break;
        case '--timeout':
            opts.timeout = parseInt(argv[++i], 10);
            break;
        case '--json':
            opts.json = argv[++i];
            break;
        case '--probe-all':
            opts.probeAll = true;
            break;
        case '--verbose':
        case '-v':
            opts.verbose = true;
            break;
        case '--help':
        case '-h':
            print(`Usage: gjs -m tools/sni-diag.js [options]

  --capped          use the extension's caps (depth ${EXTENSION_DEPTH}, ${EXTENSION_CALLS} calls)
  --depth N         max introspection depth (default 64)
  --calls N         max introspect calls per connection (default 100000)
  --timeout MS      per-call timeout (default 5000)
  --json FILE       also write the full result as JSON
  --probe-all       property-probe every path, not just likely ones
  --verbose         print every path walked
`);
            System.exit(0);
            break;
        default:
            printerr(`Unknown argument: ${arg}`);
            System.exit(2);
        }
    }

    return opts;
}

const opts = parseArgs(ARGV);
const bus = Gio.DBus.session;
const ownName = bus.get_unique_name();

function busCall(name, path, iface, method, params, replyType) {
    return bus.call(name, path, iface, method, params,
        new GLib.VariantType(replyType),
        Gio.DBusCallFlags.NONE, opts.timeout, null);
}

// Distinguishing "this connection is silent" from "this connection said no" is
// the whole point of the rewrite, so classify precisely rather than by message
// substring where a typed match is available.
function classifyError(e) {
    if (e instanceof Gio.DBusError || e.domain === Gio.DBusError.quark?.()) {
        // fall through to the matches() checks below
    }

    const is = code => {
        try {
            return e.matches(Gio.DBusError, code);
        } catch {
            return false;
        }
    };

    if (is(Gio.DBusError.NO_REPLY))
        return 'no-reply';
    if (is(Gio.DBusError.TIMEOUT) || is(Gio.DBusError.TIMED_OUT))
        return 'timeout';
    if (is(Gio.DBusError.SERVICE_UNKNOWN))
        return 'service-unknown';
    if (is(Gio.DBusError.NAME_HAS_NO_OWNER))
        return 'no-owner';
    if (is(Gio.DBusError.UNKNOWN_OBJECT) || is(Gio.DBusError.UNKNOWN_METHOD) ||
        is(Gio.DBusError.UNKNOWN_INTERFACE))
        return 'not-introspectable';
    if (is(Gio.DBusError.ACCESS_DENIED))
        return 'access-denied';

    try {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
            return 'timeout';
    } catch {
        // not a GIO error, fall through
    }

    // GDBusNodeInfo.new_for_xml() throws on malformed introspection XML. That
    // is the service's fault, not ours, and it is not silence.
    if (/markup|XML|parse/i.test(e.message ?? ''))
        return 'bad-xml';

    return 'other';
}

const SILENT = new Set(['timeout', 'no-reply']);

// An object can serve org.kde.StatusNotifierItem without naming it in its
// Introspect reply. Asking for a property is the only reliable test, so fall
// back to it wherever the interface list did not settle the question.
//
// Probing every path would double the call count on services with large trees
// for no gain, so probe where a hidden item can actually be: the canonical
// path, anything named after the interface, and nodes that advertise nothing
// at all, which is the Chromium signature.
async function isHiddenItem(busName, objectPath, nodeInfo) {
    const worthProbing = opts.probeAll ||
        objectPath === DEFAULT_ITEM_PATH ||
        /StatusNotifierItem/i.test(objectPath) ||
        nodeInfo.interfaces.length === 0;

    if (!worthProbing)
        return false;

    try {
        await busCall(busName, objectPath, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [SNI_INTERFACE, 'Id']), '(v)');
        return true;
    } catch {
        return false;
    }
}

// Walks one connection's object tree. Returns every path exporting an SNI, plus
// enough bookkeeping to say honestly why the walk ended where it did.
async function walkConnection(busName) {
    const state = {
        paths: [],
        calls: 0,
        maxDepth: 0,
        hiddenFound: false,    // found an item Introspect did not advertise
        truncated: false,      // hit --depth or --calls; result is inconclusive
        truncatedAt: [],       // the paths we refused to descend into
        rootError: null,       // error classification at path '/'
        rootErrorMsg: null,
        errors: [],            // non-root errors, for --verbose
        visited: new Set(),
    };

    async function walk(objectPath, depth) {
        if (depth > opts.depth || state.calls >= opts.calls) {
            state.truncated = true;
            if (state.truncatedAt.length < 12)
                state.truncatedAt.push(`${objectPath} (depth ${depth})`);
            return;
        }

        // Services with cyclic or self-referential node listings exist; without
        // this a cap is the only thing that stops the walk, which defeats the
        // point of running uncapped.
        if (state.visited.has(objectPath))
            return;
        state.visited.add(objectPath);

        state.calls++;
        state.maxDepth = Math.max(state.maxDepth, depth);

        let nodeInfo;
        try {
            const result = await busCall(busName, objectPath,
                'org.freedesktop.DBus.Introspectable', 'Introspect', null, '(s)');
            const [xml] = result.deep_unpack();
            nodeInfo = Gio.DBusNodeInfo.new_for_xml(xml);
        } catch (e) {
            const kind = classifyError(e);
            if (depth === 0) {
                state.rootError = kind;
                state.rootErrorMsg = Gio.DBusError.strip_remote_error
                    ? Gio.DBusError.strip_remote_error(e).message ?? e.message
                    : e.message;
            } else {
                state.errors.push(`${objectPath}: ${kind}`);
            }
            return;
        }

        if (opts.verbose)
            print(`    walk ${busName} ${objectPath} (depth ${depth})`);

        if (nodeInfo.interfaces.some(i => i.name === SNI_INTERFACE)) {
            state.paths.push({path: objectPath, how: 'advertised'});
        } else if (await isHiddenItem(busName, objectPath, nodeInfo)) {
            // Chromium/Electron export a working item whose Introspect reply
            // lists no interfaces at all. Trusting the interface list means
            // walking straight past Discord, Slack and every other Electron
            // app — which is exactly the class of app that uses a non-default
            // path and therefore needs the walk in the first place.
            state.paths.push({path: objectPath, how: 'hidden'});
            state.hiddenFound = true;
        }

        const prefix = objectPath === '/' ? '' : objectPath;
        for (const node of nodeInfo.nodes) {
            if (!node.path)
                continue;
            const childPath = node.path.startsWith('/')
                ? node.path
                : `${prefix}/${node.path}`;
            await walk(childPath, depth + 1);
        }
    }

    await walk('/', 0);
    return state;
}

// The extension probes this exact path before it walks, so record it separately:
// an item here is found by every sweep regardless of caps.
async function probeDefaultPath(busName) {
    // Mirrors the extension's _checkForSNI: a Properties.Get, not an
    // introspection. This is the robust test, and the asymmetry between it and
    // the interface-list test used by the walk is the point of this tool.
    try {
        await busCall(busName, DEFAULT_ITEM_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [SNI_INTERFACE, 'Id']), '(v)');
        return true;
    } catch {
        return false;
    }
}

async function processIdOf(busName) {
    try {
        const result = await busCall('org.freedesktop.DBus',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [busName]), '(u)');
        return result.deep_unpack()[0];
    } catch {
        return null;
    }
}

function procInfo(pid) {
    if (pid === null)
        return {comm: '?', cmdline: '?'};

    const read = path => {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return null;
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    };

    const comm = (read(`/proc/${pid}/comm`) ?? '?').trim();
    const raw = read(`/proc/${pid}/cmdline`) ?? '';
    const cmdline = raw.replaceAll('\0', ' ').trim() || comm;
    return {comm, cmdline: cmdline.slice(0, 120)};
}

async function main() {
    print('='.repeat(78));
    print('StatusNotifierItem session bus diagnostic');
    print(`caps: depth=${opts.depth} calls=${opts.calls} timeout=${opts.timeout}ms` +
        (opts.capped ? '  [MIRRORING EXTENSION CAPS]' : '  [uncapped]'));
    print(`date: ${new Date().toISOString()}`);
    print('='.repeat(78));

    const [names] = (await busCall('org.freedesktop.DBus',
        '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'ListNames', null, '(as)')).deep_unpack();

    // Well-known names are the useful label for a connection, and an app holding
    // org.kde.StatusNotifierItem-PID-ID while exporting nothing is itself a
    // finding, so map them onto their owning connection rather than skipping.
    const wellKnownByOwner = new Map();
    await Promise.allSettled(names
        .filter(n => !n.startsWith(':'))
        .map(async n => {
            try {
                const result = await busCall('org.freedesktop.DBus',
                    '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'GetNameOwner', new GLib.Variant('(s)', [n]), '(s)');
                const [owner] = result.deep_unpack();
                if (!wellKnownByOwner.has(owner))
                    wellKnownByOwner.set(owner, []);
                wellKnownByOwner.get(owner).push(n);
            } catch {
                // Name vanished between ListNames and here. Nothing to record.
            }
        }));

    const unique = names.filter(n => n.startsWith(':') && n !== ownName).sort(
        (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

    print(`\n${unique.length} connections to probe ` +
        `(${names.length - unique.length - 1} well-known names)\n`);

    const results = await Promise.all(unique.map(async busName => {
        const pid = await processIdOf(busName);
        const {comm, cmdline} = procInfo(pid);
        const directHit = await probeDefaultPath(busName);
        const walk = await walkConnection(busName);
        return {
            busName, pid, comm, cmdline, directHit, walk,
            wellKnown: wellKnownByOwner.get(busName) ?? [],
        };
    }));

    // Four buckets. The third and fourth used to be one, which is the defect
    // this rewrite exists to fix.
    const withItems = [];
    const silent = [];
    const errored = [];
    const truncated = [];
    const clean = [];

    for (const r of results) {
        if (r.walk.paths.length > 0 || r.directHit)
            withItems.push(r);
        else if (r.walk.rootError && SILENT.has(r.walk.rootError))
            silent.push(r);
        else if (r.walk.rootError)
            errored.push(r);
        else if (r.walk.truncated)
            truncated.push(r);
        else
            clean.push(r);
    }

    const label = r => {
        const wk = r.wellKnown.length
            ? `  [${r.wellKnown.slice(0, 3).join(', ')}` +
              `${r.wellKnown.length > 3 ? `, +${r.wellKnown.length - 3}` : ''}]`
            : '';
        return `${r.busName} pid=${r.pid ?? '?'} ${r.comm}${wk}`;
    };

    print('-'.repeat(78));
    print(`ITEMS FOUND (${withItems.length})`);
    print('-'.repeat(78));
    if (!withItems.length)
        print('  none');
    for (const r of withItems) {
        print(`  ${label(r)}`);
        print(`      ${r.cmdline}`);
        if (r.directHit)
            print(`      item at ${DEFAULT_ITEM_PATH}  (direct probe: found)`);
        for (const {path: p, how} of r.walk.paths) {
            if (p === DEFAULT_ITEM_PATH && r.directHit)
                continue;
            const note = how === 'hidden'
                ? 'HIDDEN — Introspect advertises no interfaces'
                : 'advertised in Introspect';
            print(`      item at ${p}  (depth ${p.split('/').length - 1}, ${note})`);
        }
    }

    print('');
    print('-'.repeat(78));
    print(`TRUNCATED — walk hit the caps, NO ITEM BUT INCONCLUSIVE (${truncated.length})`);
    print('-'.repeat(78));
    if (!truncated.length) {
        print('  none');
    } else {
        print('  These connections were not fully explored. If the extension is');
        print('  missing an item, it is missing it here. Re-run uncapped.');
        print('');
    }
    for (const r of truncated) {
        print(`  ${label(r)}`);
        print(`      ${r.cmdline}`);
        print(`      ${r.walk.calls} calls, max depth ${r.walk.maxDepth}, gave up at:`);
        for (const p of r.walk.truncatedAt)
            print(`        ${p}`);
    }

    print('');
    print('-'.repeat(78));
    print(`NO ITEM — walk completed cleanly, genuinely absent (${clean.length})`);
    print('-'.repeat(78));
    if (!clean.length)
        print('  none');
    for (const r of clean)
        print(`  ${label(r)}  (${r.walk.calls} calls, max depth ${r.walk.maxDepth})`);

    print('');
    print('-'.repeat(78));
    print(`NO ITEM — walk errored, result unknown (${errored.length})`);
    print('-'.repeat(78));
    if (!errored.length)
        print('  none');
    for (const r of errored) {
        print(`  ${label(r)}`);
        print(`      ${r.walk.rootError}: ${r.walk.rootErrorMsg}`);
    }

    print('');
    print('-'.repeat(78));
    print(`SILENT — never answered (${silent.length})`);
    print('-'.repeat(78));
    print('  Normal in bulk. A connection that ignores Introspect is not a');
    print('  suspect by itself; plenty of working apps have one.');
    if (!silent.length)
        print('  none');
    for (const r of silent)
        print(`  ${label(r)}  (${r.walk.rootError})`);

    print('');
    print('='.repeat(78));
    print(`SUMMARY: ${withItems.length} with items, ${truncated.length} truncated, ` +
        `${clean.length} clean-empty, ${errored.length} errored, ${silent.length} silent`);
    if (truncated.length && opts.capped)
        print('WARNING: truncated walks present. This run cannot prove absence.');
    print('='.repeat(78));

    if (opts.json) {
        const payload = {
            date: new Date().toISOString(),
            opts: {depth: opts.depth, calls: opts.calls, timeout: opts.timeout},
            connections: results.map(r => ({
                busName: r.busName,
                pid: r.pid,
                comm: r.comm,
                cmdline: r.cmdline,
                wellKnown: r.wellKnown,
                directHit: r.directHit,
                itemPaths: r.walk.paths,
                hiddenFound: r.walk.hiddenFound,
                calls: r.walk.calls,
                maxDepth: r.walk.maxDepth,
                truncated: r.walk.truncated,
                truncatedAt: r.walk.truncatedAt,
                rootError: r.walk.rootError,
                rootErrorMsg: r.walk.rootErrorMsg,
            })),
        };
        GLib.file_set_contents(opts.json, JSON.stringify(payload, null, 2));
        print(`\nJSON written to ${opts.json}`);
    }
}

const loop = new GLib.MainLoop(null, false);
main()
    .catch(e => {
        printerr(`diagnostic failed: ${e.message}`);
        printerr(e.stack);
    })
    .finally(() => loop.quit());
loop.run();
