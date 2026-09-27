#!/bin/bash
#
# Post-boot evidence capture for issue #28.
#
# Runs from an autostart entry, waits for the login storm to settle, then
# records everything section 5.1 and 5.2 of the handover asks for. Writes one
# timestamped directory per boot so runs can be diffed against each other.
set -u

REPO=/home/keith/LocalCode/keithvassallomt/status-tray
OUT="$HOME/sni-boot-captures/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# The last sweep in SNI_RESCAN_DELAYS_MS fires at 60s. Capture after it, so a
# missing icon here is a settled result and not a sweep we did not wait for.
sleep 100

{
    echo "boot id: $(cat /proc/sys/kernel/random/boot_id)"
    echo "captured: $(date -Is)"
    echo "uptime: $(uptime -p)"
    echo "shell: $(gnome-shell --version)"
    echo "session: $XDG_SESSION_TYPE"
} > "$OUT/00-context.txt"

# 5.1 — the actual enable order, straight from loadExtension's own debug line.
# Timestamped, because position only matters via the delay it causes: what the
# race actually turns on is when the watcher name is claimed.
journalctl -b 0 -o short-precise _COMM=gnome-shell -p debug 2>/dev/null \
    | grep "Loading extension" | sed 's/fedora gnome-shell\[[0-9]*\]: //' \
    | cat -n > "$OUT/01-load-order.txt"

{
    echo "--- the number that decides the race ---"
    journalctl -b 0 -o short-precise 2>/dev/null \
        | grep -E "Acquired bus name: org.kde.StatusNotifierWatcher" \
        | sed 's/fedora gnome-shell\[[0-9]*\]: //' | head -1
    echo "--- shell start ---"
    pid=$(pgrep -x gnome-shell | head -1)
    [ -n "$pid" ] && stat -c %y "/proc/$pid" | cut -d. -f1-2
    echo "--- session-modes declared? ---"
    grep -A3 "session-modes" "$HOME/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com/metadata.json" 2>/dev/null || echo "none"
} > "$OUT/01b-name-timing.txt"

# Paired import+init timing for both extensions, from the shell's own state
# transitions. Paired is the point: absolute import time swings by an order of
# magnitude with boot contention (measured 81 ms to 761 ms on this machine), so
# only a same-boot ratio says anything about the code. Appended across boots.
python3 - >> "$HOME/sni-boot-captures/import-timings.tsv" <<'PYIMPORT'
import re, subprocess, os, datetime

def journal():
    return subprocess.run(
        ["journalctl", "-b", "0", "-o", "short-precise"],
        capture_output=True, text=True).stdout.splitlines()

UUIDS = {
    "status-tray@keithvassallo.com": "status-tray",
    "appindicatorsupport@rgcjonas.gmail.com": "appindicator",
}

def ts(line):
    m = re.match(r"\w+ \d+ (\d+):(\d+):(\d+)\.(\d+)", line)
    if not m:
        return None
    h, mi, se, us = (int(x) for x in m.groups())
    return h * 3600 + mi * 60 + se + us / 1e6

start, result = {}, {}
for line in journal():
    for uuid, short in UUIDS.items():
        if f"Loading extension {uuid}" in line:
            start[short] = ts(line)
        elif f"state of extension {uuid} to INACTIVE" in line and short in start:
            t = ts(line)
            if t is not None and start[short] is not None:
                result[short] = (t - start[short]) * 1000

path = os.path.expanduser("~/sni-boot-captures/import-timings.tsv")
if not os.path.exists(path) or os.path.getsize(path) == 0:
    print("date\tstatus_tray_ms\tappindicator_ms\tratio")
st = result.get("status-tray")
ai = result.get("appindicator")
ratio = f"{st/ai:.2f}" if st and ai else ""
print(f"{datetime.datetime.now().isoformat(timespec='seconds')}\t"
      f"{st:.1f}" if st else "\t", end="")
print(f"\t{ai:.1f}\t{ratio}" if ai else "\t\t")
PYIMPORT

# The gsetting, to confirm for the record that it is not the determinant.
gsettings get org.gnome.shell enabled-extensions \
    | tr ',' '\n' > "$OUT/02-enabled-gsetting.txt"

# Readdir order of both datadirs, which is what actually decides position.
{
    echo "--- user dir (enumerated first) ---"
    ls -U "$HOME/.local/share/gnome-shell/extensions/" 2>/dev/null
    echo "--- system dir ---"
    ls -U /usr/share/gnome-shell/extensions/ 2>/dev/null
} > "$OUT/03-readdir-order.txt"

# 5.2 — the extension's own debug log for this boot.
journalctl -b 0 -o cat 2>/dev/null | grep -i "StatusTray" > "$OUT/04-statustray-log.txt"

# Who registered, and when, relative to the shell coming up.
journalctl -b 0 -o short-precise 2>/dev/null \
    | grep -iE "RegisterStatusNotifierItem|Acquired bus name|StatusNotifierWatcher" \
    > "$OUT/05-registrations.txt"

# Start times: did the apps beat the shell to the bus?
{
    echo "PID  START                COMMAND"
    for p in gnome-shell keepassxc Discord dropbox; do
        for pid in $(pgrep -x "$p" 2>/dev/null); do
            printf '%-7s %-20s %s\n' "$pid" \
                "$(stat -c %y /proc/$pid 2>/dev/null | cut -d. -f1)" "$p"
        done
    done
} > "$OUT/06-start-times.txt"

# The authoritative list of what the tray actually has.
timeout 15 gdbus call --session --dest org.kde.StatusNotifierWatcher \
    --object-path /StatusNotifierWatcher \
    --method org.freedesktop.DBus.Properties.Get \
    org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems \
    > "$OUT/07-registered-items.txt" 2>&1

# Full uncapped bus state, including items whose Introspect hides the interface.
timeout 400 gjs -m "$REPO/tools/sni-diag.js" \
    --json "$OUT/08-diag.json" > "$OUT/08-diag.txt" 2>&1

ln -sfn "$OUT" "$HOME/sni-boot-captures/latest"
echo "capture complete: $OUT" > "$OUT/DONE"
