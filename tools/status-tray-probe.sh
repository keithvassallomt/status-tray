#!/bin/bash
#
# status-tray-probe.sh — one-shot data collection for status-tray issue #28.
#
# You run one command and reboot twice. It captures a Status Tray boot and an
# AppIndicator boot, checks its own output for gaps, restores every setting it
# touched, and leaves a single file to attach to the issue.
#
#   ./status-tray-probe.sh start     # sets up, then tells you to reboot
#   (reboot)                         # captures boot 1, flips to the other arm
#   (reboot)                         # captures boot 2, restores, bundles
#   ./status-tray-probe.sh status    # where am I / what's next
#   ./status-tray-probe.sh revert    # abort and undo everything, any time
#
# It changes four things and puts all four back: which of the two extensions is
# enabled, the disabled-extensions list, a G_MESSAGES_DEBUG drop-in (needed to
# make gnome-shell log its extension load order), and DEBUG=true in the Status
# Tray source if it's installed. It reads the session bus but never writes to it.

set -u

STATE="$HOME/.status-tray-probe"
RESULT="$HOME/status-tray-probe-results.tar.gz"
ENVFILE="$HOME/.config/environment.d/99-status-tray-probe.conf"
AUTOSTART="$HOME/.config/autostart/status-tray-probe.desktop"
EXTDIR="$HOME/.local/share/gnome-shell/extensions"
ST_UUID="status-tray@keithvassallo.com"
AI_UUID="appindicatorsupport@rgcjonas.gmail.com"
SELF="$(readlink -f "$0")"

# The last rescan in Status Tray 1.20 fires at 60s. Capture after that, so a
# missing icon is a settled result rather than a sweep we didn't wait for.
SETTLE_SECONDS="${PROBE_SETTLE:-100}"

say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "----------------------------------------------------------------------"; }

notify() {
    command -v notify-send >/dev/null 2>&1 && \
        notify-send -u critical "Status Tray probe" "$1" 2>/dev/null
    printf '%s\n' "$1" > "$STATE/LATEST-MESSAGE.txt"
}

# ---------------------------------------------------------------- diagnostic

write_diag() {
    cat > "$STATE/sni-diag.js" <<'EOFJS'
#!/usr/bin/env -S gjs -m
// Read-only session bus walk. Reports every connection, whether it exports a
// StatusNotifierItem, and — crucially — distinguishes "walked it, found
// nothing" from "the walk errored" and from "never answered". Only the first
// of those proves absence.
//
// It also property-probes, not just introspects: Chromium and Electron serve
// org.kde.StatusNotifierItem from objects whose Introspect reply lists no
// interfaces at all, so an interface-list check walks straight past Discord.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const SNI = 'org.kde.StatusNotifierItem';
const DEFAULT_PATH = '/StatusNotifierItem';
const TIMEOUT = 5000;
const MAX_DEPTH = 64;
const MAX_CALLS = 100000;

const bus = Gio.DBus.session;
const ownName = bus.get_unique_name();

function call(name, path, iface, method, params, reply) {
    return bus.call(name, path, iface, method, params,
        new GLib.VariantType(reply), Gio.DBusCallFlags.NONE, TIMEOUT, null);
}

function classify(e) {
    const is = c => { try { return e.matches(Gio.DBusError, c); } catch { return false; } };
    if (is(Gio.DBusError.NO_REPLY)) return 'no-reply';
    if (is(Gio.DBusError.TIMEOUT) || is(Gio.DBusError.TIMED_OUT)) return 'timeout';
    if (is(Gio.DBusError.SERVICE_UNKNOWN)) return 'service-unknown';
    if (is(Gio.DBusError.UNKNOWN_OBJECT) || is(Gio.DBusError.UNKNOWN_METHOD) ||
        is(Gio.DBusError.UNKNOWN_INTERFACE)) return 'not-introspectable';
    if (is(Gio.DBusError.ACCESS_DENIED)) return 'access-denied';
    try { if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) return 'timeout'; } catch {}
    if (/markup|XML|parse/i.test(e.message ?? '')) return 'bad-xml';
    return 'other';
}
const SILENT = new Set(['timeout', 'no-reply']);

async function serves(name, path) {
    try {
        await call(name, path, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [SNI, 'Id']), '(v)');
        return true;
    } catch { return false; }
}

async function walk(name) {
    const st = {paths: [], calls: 0, depth: 0, truncated: false,
                rootError: null, rootMsg: null, seen: new Set()};
    async function go(path, depth) {
        if (depth > MAX_DEPTH || st.calls >= MAX_CALLS) { st.truncated = true; return; }
        if (st.seen.has(path)) return;
        st.seen.add(path);
        st.calls++;
        st.depth = Math.max(st.depth, depth);
        let info;
        try {
            const [xml] = (await call(name, path,
                'org.freedesktop.DBus.Introspectable', 'Introspect', null, '(s)')).deep_unpack();
            info = Gio.DBusNodeInfo.new_for_xml(xml);
        } catch (e) {
            if (depth === 0) { st.rootError = classify(e); st.rootMsg = e.message; }
            return;
        }
        if (info.interfaces.some(i => i.name === SNI)) {
            st.paths.push({path, how: 'advertised'});
        } else if (info.interfaces.length === 0 || path === DEFAULT_PATH ||
                   path.includes('StatusNotifierItem')) {
            st.calls++;
            if (await serves(name, path)) st.paths.push({path, how: 'HIDDEN'});
        }
        const prefix = path === '/' ? '' : path;
        for (const n of info.nodes) {
            if (!n.path) continue;
            await go(n.path.startsWith('/') ? n.path : `${prefix}/${n.path}`, depth + 1);
        }
    }
    await go('/', 0);
    return st;
}

async function pidOf(name) {
    try {
        return (await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [name]), '(u)')).deep_unpack()[0];
    } catch { return null; }
}

function proc(pid) {
    if (pid === null) return {comm: '?', cmd: '?', unit: ''};
    const rd = p => { try { const [ok, b] = GLib.file_get_contents(p);
        return ok ? new TextDecoder().decode(b) : ''; } catch { return ''; } };
    const unit = (rd(`/proc/${pid}/cgroup`).match(/app-flatpak-[^/\n]*/) || [''])[0];
    return {comm: (rd(`/proc/${pid}/comm`) || '?').trim(),
            cmd: (rd(`/proc/${pid}/cmdline`).replaceAll('\0', ' ').trim() || '?').slice(0, 140),
            unit};
}

const loop = new GLib.MainLoop(null, false);
(async () => {
    print('='.repeat(70));
    print(`SNI bus diagnostic  ${new Date().toISOString()}`);
    print(`uncapped walk, property-probe fallback, ${TIMEOUT}ms timeout`);
    print('='.repeat(70));

    const [names] = (await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', null, '(as)')).deep_unpack();

    const wk = new Map();
    await Promise.allSettled(names.filter(n => !n.startsWith(':')).map(async n => {
        try {
            const [o] = (await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetNameOwner',
                new GLib.Variant('(s)', [n]), '(s)')).deep_unpack();
            if (!wk.has(o)) wk.set(o, []);
            wk.get(o).push(n);
        } catch {}
    }));

    const uniq = names.filter(n => n.startsWith(':') && n !== ownName)
        .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    print(`\n${uniq.length} connections probed\n`);

    const res = await Promise.all(uniq.map(async n => {
        const pid = await pidOf(n);
        const p = proc(pid);
        const direct = await serves(n, DEFAULT_PATH);
        const w = await walk(n);
        return {n, pid, ...p, direct, w, wk: wk.get(n) ?? []};
    }));

    const items = [], silent = [], errored = [], clean = [];
    for (const r of res) {
        if (r.w.paths.length || r.direct) items.push(r);
        else if (r.w.rootError && SILENT.has(r.w.rootError)) silent.push(r);
        else if (r.w.rootError) errored.push(r);
        else clean.push(r);
    }
    const lbl = r => `${r.n} pid=${r.pid ?? '?'} ${r.comm}` +
        (r.unit ? ` [${r.unit}]` : '') +
        (r.wk.length ? ` {${r.wk.slice(0, 2).join(', ')}}` : '');

    hr2(`ITEMS FOUND (${items.length})`);
    for (const r of items) {
        print(`  ${lbl(r)}`);
        print(`      ${r.cmd}`);
        if (r.direct) print(`      item at ${DEFAULT_PATH} (direct property probe)`);
        for (const {path, how} of r.w.paths)
            if (!(path === DEFAULT_PATH && r.direct)) print(`      item at ${path} (${how})`);
    }
    if (!items.length) print('  none');

    hr2(`NO ITEM — walk completed cleanly, genuinely absent (${clean.length})`);
    for (const r of clean) print(`  ${lbl(r)}  (${r.w.calls} calls, depth ${r.w.depth})`);
    if (!clean.length) print('  none');

    hr2(`NO ITEM — walk errored, INCONCLUSIVE (${errored.length})`);
    for (const r of errored) print(`  ${lbl(r)}\n      ${r.w.rootError}: ${r.w.rootMsg}`);
    if (!errored.length) print('  none');

    hr2(`SILENT — never answered (${silent.length})`);
    print('  Normal in bulk; plenty of working apps have a silent connection.');
    for (const r of silent) print(`  ${lbl(r)}  (${r.w.rootError})`);

    print('');
    print('='.repeat(70));
    print(`SUMMARY: ${items.length} with items, ${clean.length} clean-empty, ` +
          `${errored.length} errored, ${silent.length} silent`);
    print('='.repeat(70));
})().catch(e => { printerr(`diagnostic failed: ${e.message}`); printerr(e.stack); })
   .finally(() => loop.quit());

function hr2(t) { print(''); print('-'.repeat(70)); print(t); print('-'.repeat(70)); }
loop.run();
EOFJS
}

# ---------------------------------------------------------------- analysis

write_analyzer() {
    cat > "$STATE/analyze.py" <<'EOFPY'
"""Turn the journal into the table that actually answers issue #28.

For every extension: when it started loading, how long its module import took,
how long enable() took, and therefore when the watcher name could first have
been claimed. Import time is the interesting column — it swings with boot
contention, and that is the whole question.
"""
import re, subprocess, sys, os, time

OUT = sys.argv[1]

def journal(*extra):
    return subprocess.run(["journalctl", "-b", "0", "-o", "short-precise", *extra],
                          capture_output=True, text=True).stdout.splitlines()

def ts(line):
    m = re.match(r"\w+\s+\d+\s+(\d+):(\d+):(\d+)\.(\d+)", line)
    if not m:
        return None
    h, mi, s, us = m.groups()
    return int(h)*3600 + int(mi)*60 + int(s) + int(us)/1e6

# Seconds-since-midnight of the gnome-shell process itself. The journal's
# "GNOME Shell started at" line is logged ~2s AFTER the process starts, which
# makes extensions appear to load before the shell exists.
def shell_start_clock():
    try:
        pid = subprocess.run(["pgrep", "-x", "gnome-shell"],
                             capture_output=True, text=True).stdout.split()[0]
        st = os.stat(f"/proc/{pid}").st_ctime
        lt = time.localtime(st)
        return lt.tm_hour*3600 + lt.tm_min*60 + lt.tm_sec + (st - int(st))
    except Exception:
        return None

shell_start = shell_start_clock()

# Everything must fall inside the startup window. Without this, an extension
# toggled later in the session pairs its boot-time "Loading extension" line
# with a state change minutes later and reports a nonsense import time.
WINDOW = 120.0
def in_window(t):
    return t is not None and shell_start is not None and 0 <= t - shell_start <= WINDOW

lines = journal()
debug_lines = journal("-p", "debug", "_COMM=gnome-shell")

load, inactive, active = {}, {}, {}
for l in debug_lines:
    m = re.search(r"Loading extension (\S+)", l)
    if m and m.group(1) not in load and in_window(ts(l)):
        load[m.group(1)] = ts(l)
for l in lines:
    m = re.search(r"state of extension (\S+) to (INACTIVE|ACTIVE)\b", l)
    if m:
        uuid, st_, t = m.group(1), m.group(2), ts(l)
        if not in_window(t):
            continue
        tgt = inactive if st_ == "INACTIVE" else active
        if uuid not in tgt:
            tgt[uuid] = t

name_claim = None
for l in lines:
    if "Acquired bus name: org.kde.StatusNotifierWatcher" in l and in_window(ts(l)):
        name_claim = ts(l); break

rows = []
for uuid, t in sorted(load.items(), key=lambda kv: kv[1] or 0):
    imp = (inactive[uuid] - t) * 1000 if uuid in inactive and t else None
    ena = (active[uuid] - inactive[uuid]) * 1000 if uuid in inactive and uuid in active else None
    rows.append((uuid, t, imp, ena))

with open(OUT, "w") as f:
    w = f.write
    w("EXTENSION LOAD TIMELINE\n")
    w("=" * 100 + "\n")
    if shell_start is None:
        w("!! could not determine gnome-shell start time\n")
    w(f"{'#':>3}  {'+s from shell':>13}  {'import ms':>9}  {'enable ms':>9}  extension\n")
    w("-" * 100 + "\n")
    for i, (uuid, t, imp, ena) in enumerate(rows, 1):
        rel = f"{t - shell_start:+.3f}" if (shell_start and t) else "?"
        w(f"{i:>3}  {rel:>13}  "
          f"{(f'{imp:.1f}' if imp is not None else '-'):>9}  "
          f"{(f'{ena:.1f}' if ena is not None else '-'):>9}  {uuid}\n")
    w("\n")
    if not rows:
        w("!! NO 'Loading extension' LINES FOUND — G_MESSAGES_DEBUG did not take\n"
          "!! effect. This boot's load order is unusable; re-run the probe.\n\n")

    w("WATCHER NAME\n")
    w("-" * 100 + "\n")
    if name_claim and shell_start:
        w(f"org.kde.StatusNotifierWatcher claimed at {name_claim - shell_start:+.3f}s "
          f"(from Status Tray debug log)\n")
    else:
        w("No 'Acquired bus name' line (expected on the AppIndicator boot, or if\n"
          "Status Tray DEBUG was off). Falling back to extension ACTIVE times:\n")
        for uuid in ("status-tray@keithvassallo.com",
                     "appindicatorsupport@rgcjonas.gmail.com"):
            if uuid in active and shell_start:
                w(f"  {uuid} reached ACTIVE at {active[uuid] - shell_start:+.3f}s\n")
    w("\nAPP START TIMES (relative to shell start)\n")
    w("-" * 100 + "\n")
    for name in ("keepassxc", "Discord", "dropbox", "Ferdium", "remmina"):
        try:
            pids = subprocess.run(["pgrep", "-x", name], capture_output=True,
                                  text=True).stdout.split()
        except Exception:
            pids = []
        for pid in pids[:2]:
            try:
                st = os.stat(f"/proc/{pid}").st_ctime
                lt = time.localtime(st)
                clock = lt.tm_hour*3600 + lt.tm_min*60 + lt.tm_sec + (st - int(st))
                rel = f"{clock - shell_start:+.3f}s" if shell_start else "?"
                w(f"  {name:<12} pid={pid:<8} started {rel} relative to shell\n")
            except Exception:
                w(f"  {name:<12} pid={pid:<8} (start time unavailable)\n")
        if not pids:
            w(f"  {name:<12} NOT RUNNING\n")
EOFPY
}

# ---------------------------------------------------------------- config I/O

save_config() {
    mkdir -p "$STATE"
    gsettings get org.gnome.shell enabled-extensions  > "$STATE/orig-enabled.txt"
    gsettings get org.gnome.shell disabled-extensions > "$STATE/orig-disabled.txt"
    [ -f "$ENVFILE" ] && cp "$ENVFILE" "$STATE/orig-envfile" || rm -f "$STATE/orig-envfile"
    if [ -f "$EXTDIR/$ST_UUID/extension.js" ]; then
        grep -q '^const DEBUG = false;' "$EXTDIR/$ST_UUID/extension.js" \
            && echo yes > "$STATE/debug-was-false" || rm -f "$STATE/debug-was-false"
    fi
}

set_arm() {
    # $1 = st | ai. Both UUIDs go in enabled-extensions; the other is pushed
    # onto disabled-extensions, which overrides it. Using the disabled list
    # rather than removing entries keeps his original ordering intact.
    local keep drop
    if [ "$1" = "st" ]; then keep="$ST_UUID"; drop="$AI_UUID";
    else keep="$AI_UUID"; drop="$ST_UUID"; fi

    python3 - "$keep" "$drop" <<'EOFSET'
import ast, subprocess, sys
keep, drop = sys.argv[1], sys.argv[2]
def get(k):
    out = subprocess.run(["gsettings","get","org.gnome.shell",k],
                         capture_output=True, text=True).stdout.strip()
    if out.startswith("@as"): out = out[3:].strip()
    try: return ast.literal_eval(out)
    except Exception: return []
def setk(k, v):
    subprocess.run(["gsettings","set","org.gnome.shell",k,str(v)], check=False)
en = get("enabled-extensions")
if keep not in en: en.append(keep)
if drop not in en: en.append(drop)
setk("enabled-extensions", en)
setk("disabled-extensions", [drop])
EOFSET
    echo "$1" > "$STATE/arm"
}

enable_debug_logging() {
    mkdir -p "$HOME/.config/environment.d"
    # Scoped to gnome-shell's log domain; G_MESSAGES_DEBUG=all would bury the
    # journal under every other session service.
    printf 'G_MESSAGES_DEBUG=GNOME Shell\n' > "$ENVFILE"
    local js="$EXTDIR/$ST_UUID/extension.js"
    [ -f "$js" ] && sed -i 's/^const DEBUG = false;/const DEBUG = true;/' "$js"
}

restore_all() {
    [ -f "$STATE/orig-enabled.txt" ] && \
        gsettings set org.gnome.shell enabled-extensions "$(cat "$STATE/orig-enabled.txt")"
    [ -f "$STATE/orig-disabled.txt" ] && \
        gsettings set org.gnome.shell disabled-extensions "$(cat "$STATE/orig-disabled.txt")"
    if [ -f "$STATE/orig-envfile" ]; then cp "$STATE/orig-envfile" "$ENVFILE"; else rm -f "$ENVFILE"; fi
    local js="$EXTDIR/$ST_UUID/extension.js"
    [ -f "$STATE/debug-was-false" ] && [ -f "$js" ] && \
        sed -i 's/^const DEBUG = true;/const DEBUG = false;/' "$js"
    rm -f "$AUTOSTART"
}

# ---------------------------------------------------------------- capture

do_capture() {
    local arm; arm="$(cat "$STATE/arm" 2>/dev/null || echo st)"
    local dir="$STATE/boot-$arm"
    rm -rf "$dir"; mkdir -p "$dir"

    sleep "$SETTLE_SECONDS"

    {
        echo "arm:        $arm  ($([ "$arm" = st ] && echo 'Status Tray' || echo AppIndicator))"
        echo "captured:   $(date -Is)"
        echo "boot id:    $(cat /proc/sys/kernel/random/boot_id)"
        echo "shell:      $(gnome-shell --version 2>&1)"
        echo "session:    ${XDG_SESSION_TYPE:-?}  ${XDG_CURRENT_DESKTOP:-?}"
        echo "os:         $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}")"
        echo "kernel:     $(uname -r)"
        echo "st version: $(gnome-extensions info "$ST_UUID" 2>/dev/null | grep -i version || echo 'not installed')"
        echo "ai version: $(gnome-extensions info "$AI_UUID" 2>/dev/null | grep -i version || echo 'not installed')"
    } > "$dir/00-system.txt"

    {
        echo "--- enabled-extensions (membership, NOT load order) ---"
        gsettings get org.gnome.shell enabled-extensions | tr ',' '\n'
        echo; echo "--- disabled-extensions (overrides the above) ---"
        gsettings get org.gnome.shell disabled-extensions | tr ',' '\n'
        echo; echo "--- extension states ---"
        gnome-extensions list 2>/dev/null | while read -r u; do
            printf '%-55s %s\n' "$u" "$(gnome-extensions info "$u" 2>/dev/null | grep -i '^  State' | sed 's/.*: //')"
        done
        echo; echo "--- readdir order, user dir (enumerated FIRST) ---"
        ls -U "$EXTDIR" 2>/dev/null
        echo; echo "--- readdir order, system dir ---"
        ls -U /usr/share/gnome-shell/extensions 2>/dev/null
        echo; echo "--- session-modes declared (length decides the sort) ---"
        for d in "$EXTDIR"/*/ /usr/share/gnome-shell/extensions/*/; do
            [ -f "$d/metadata.json" ] || continue
            python3 -c "
import json,sys
try:
    m=json.load(open('$d/metadata.json')).get('session-modes')
    print(f\"{len(m) if m else 1}  {'$d'.rstrip('/').split('/')[-1]}  {m or '[user] (default)'}\")
except Exception: pass" 2>/dev/null
        done | sort -rn
    } > "$dir/01-config.txt"

    python3 "$STATE/analyze.py" "$dir/02-timeline.txt" 2>"$dir/02-timeline.err"

    journalctl -b 0 -o short-precise 2>/dev/null \
        | grep -iE "StatusTray|appindicator" > "$dir/03-extension-log.txt"

    journalctl -b 0 -o short-precise 2>/dev/null \
        | grep -iE "RegisterStatusNotifierItem|StatusNotifierWatcher|Acquired bus name" \
        > "$dir/04-registrations.txt"

    for _try in 1 2 3 4 5; do
        timeout 20 gdbus call --session --dest org.kde.StatusNotifierWatcher \
            --object-path /StatusNotifierWatcher \
            --method org.freedesktop.DBus.Properties.Get \
            org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems \
            > "$dir/05-registered-items.txt" 2>&1
        grep -q "^(<\[" "$dir/05-registered-items.txt" && break
        sleep 3
    done
    {
        echo "--- watcher name owner ---"
        timeout 10 gdbus call --session --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.GetConnectionUnixProcessID \
            org.kde.StatusNotifierWatcher 2>&1
    } >> "$dir/05-registered-items.txt"

    timeout 420 gjs -m "$STATE/sni-diag.js" > "$dir/06-diag.txt" 2>&1

    {
        echo "--- processes ---"
        ps -eo pid,lstart,comm,args 2>/dev/null \
            | grep -iE "keepassxc|discord|dropbox|gnome-shell|xdg-dbus-proxy" \
            | grep -v grep
        echo; echo "--- autostart entries (a delay wrapper here invalidates the test) ---"
        for f in "$HOME/.config/autostart"/*.desktop /etc/xdg/autostart/*.desktop; do
            [ -f "$f" ] || continue
            printf '%s\n' "$f"
            grep -E '^(Name|Exec|Hidden|X-GNOME-Autostart)' "$f" | sed 's/^/    /'
        done
    } > "$dir/07-apps.txt" 2>&1

    # Self-check. Anything failing here means the boot is unusable, and it is
    # far better to say so now than to have the data argued over later.
    {
        echo "VALIDATION"
        echo "=========="
        n_load=$(grep -cE '^ *[0-9]+ ' "$dir/02-timeline.txt" 2>/dev/null); n_load=${n_load:-0}
        [ "$n_load" -gt 0 ] \
            && echo "PASS  load order captured ($n_load extensions)" \
            || echo "FAIL  no load order — G_MESSAGES_DEBUG did not take effect"
        [ -s "$dir/06-diag.txt" ] && grep -q "SUMMARY" "$dir/06-diag.txt" \
            && echo "PASS  bus diagnostic completed" \
            || echo "FAIL  bus diagnostic did not complete"
        if grep -q "^(<\[" "$dir/05-registered-items.txt" 2>/dev/null; then
            echo "PASS  watcher answered ($(grep -o "@/\|', '" "$dir/05-registered-items.txt" | wc -l) items)"
        else
            echo "FAIL  watcher did not answer — no tray host owned the name"
        fi
        for a in keepassxc Discord dropbox; do
            pgrep -x "$a" >/dev/null && echo "PASS  $a is running" \
                                     || echo "WARN  $a is NOT running — was it started?"
        done
        if [ "$arm" = st ]; then
            grep -q "StatusTray" "$dir/03-extension-log.txt" 2>/dev/null \
                && echo "PASS  Status Tray debug logging on" \
                || echo "WARN  no StatusTray debug lines (DEBUG may be off)"
        fi
        if grep -E '^ +Exec=' "$dir/07-apps.txt" | grep -qiE 'sleep|wait|delay'; then
            echo "WARN  an autostart entry mentions sleep/wait-for/delay — if you are"
            echo "      still making apps wait for the bus, this boot is INVALID"
        else
            echo "PASS  no obvious startup delay wrapper"
        fi
    } > "$dir/08-validation.txt" 2>&1

    if [ "$arm" = st ]; then
        set_arm ai
        notify "Boot 1 of 2 captured (Status Tray). Please REBOOT again now."
    else
        restore_all
        rm -f "$RESULT"
        tar -czf "$RESULT" -C "$STATE" boot-st boot-ai 2>/dev/null
        echo done > "$STATE/COMPLETE"
        notify "All done. Attach ~/status-tray-probe-results.tar.gz to issue #28. Settings restored — log out and back in to return to your normal tray extension."
    fi
}

# ---------------------------------------------------------------- commands

cmd_start() {
    for t in gjs python3 gsettings gnome-extensions journalctl gdbus tar; do
        command -v "$t" >/dev/null 2>&1 || { say "Missing required tool: $t"; exit 1; }
    done
    [ -d "$EXTDIR/$AI_UUID" ] || say "NOTE: AppIndicator not found in $EXTDIR — install it first, or boot 2 will be empty."

    mkdir -p "$STATE"
    rm -rf "$STATE/boot-st" "$STATE/boot-ai" "$STATE/COMPLETE"
    save_config
    write_diag
    write_analyzer
    enable_debug_logging
    set_arm st

    cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Status Tray probe
Exec=$SELF capture
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF

    hr
    say "Set up. Status Tray will be the active tray extension on the next boot."
    hr
    say ""
    say "IMPORTANT — before you reboot:"
    say "  * If you are still making your startup apps wait for the bus,"
    say "    turn that off. Otherwise this measures the workaround, not the bug."
    say "  * Make sure KeePassXC, Discord and Dropbox are all set to start on login."
    say "  * Don't toggle any extension on or off between now and rebooting."
    say ""
    say "Then:"
    say "  1. Reboot. Wait ~2 minutes after logging in for the notification."
    say "  2. Reboot again when it tells you to."
    say "  3. Attach ~/status-tray-probe-results.tar.gz to the issue."
    say ""
    say "Everything is restored automatically at the end."
    say "To abort at any point:  $SELF revert"
    hr
}

cmd_status() {
    if [ -f "$STATE/COMPLETE" ]; then
        hr; say "COMPLETE. Attach this file to issue #28:"; say "  $RESULT"; hr
        [ -f "$RESULT" ] && ls -lh "$RESULT"
        return
    fi
    [ -d "$STATE" ] || { say "Not set up yet. Run:  $SELF start"; return; }
    local arm; arm="$(cat "$STATE/arm" 2>/dev/null || echo '?')"
    hr
    say "In progress."
    [ -d "$STATE/boot-st" ] && say "  boot 1 (Status Tray):  captured" \
                            || say "  boot 1 (Status Tray):  pending"
    [ -d "$STATE/boot-ai" ] && say "  boot 2 (AppIndicator): captured" \
                            || say "  boot 2 (AppIndicator): pending"
    say ""
    say "Next arm on reboot: $([ "$arm" = st ] && echo 'Status Tray' || echo AppIndicator)"
    say "Reboot, then wait ~2 minutes."
    hr
    for d in "$STATE"/boot-*; do
        [ -f "$d/08-validation.txt" ] || continue
        say ""; say "$(basename "$d"):"; sed 's/^/  /' "$d/08-validation.txt"
    done
}

cmd_revert() {
    restore_all
    rm -rf "$STATE"
    hr; say "Reverted. Extension settings, debug logging and DEBUG flag restored."
    say "Log out and back in for the extension changes to take effect."; hr
}

case "${1:-status}" in
    start)   cmd_start ;;
    capture) do_capture ;;
    status)  cmd_status ;;
    revert)  cmd_revert ;;
    *) say "Usage: $0 {start|status|revert}"; exit 1 ;;
esac
