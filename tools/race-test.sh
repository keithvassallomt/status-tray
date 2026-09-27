#!/bin/bash
#
# Reproduces the issue #28 race mid-session, without needing a reboot.
#
# The cold-boot failure is just "the app looked for org.kde.StatusNotifierWatcher
# before anyone owned it". Disabling the extension drops that name, so launching
# the app with the extension disabled puts it in exactly the failed state. Then
# the extension goes back and we record whether the app ever comes back.
#
# Usage: race-test.sh <label> <procname> <launch command...>
#   e.g. race-test.sh kpxc-native keepassxc keepassxc
#        race-test.sh discord Discord flatpak run --user com.discordapp.Discord
set -u

REPO=/home/keith/LocalCode/keithvassallomt/status-tray
OUT="$HOME/sni-race-tests/$(date +%Y%m%d-%H%M%S)-$1"
mkdir -p "$OUT"
LABEL="$1"; shift
PROCNAME="$1"; shift

say() { echo; echo "##### $LABEL: $* #####"; }

items() {
    timeout 15 gdbus call --session --dest org.kde.StatusNotifierWatcher \
        --object-path /StatusNotifierWatcher \
        --method org.freedesktop.DBus.Properties.Get \
        org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>&1
}

# pgrep -x only, never pgrep -f: an -f pattern matches this script's own
# command line and kills the harness along with the target.
stop_app() {
    local pids
    pids=$(pgrep -x "$PROCNAME" || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null
    sleep 5
    pids=$(pgrep -x "$PROCNAME" || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    sleep 2
}

say "stopping app"
stop_app
pgrep -x "$PROCNAME" >/dev/null && echo "WARNING: still running" || echo "stopped"

say "items registered before the test"
items | tee "$OUT/before.txt"

dbus-monitor --session > "$OUT/bus.log" 2>&1 &
MON=$!
sleep 1

say "dropping the watcher name"
gnome-extensions disable status-tray@keithvassallo.com
sleep 3
timeout 10 gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner org.kde.StatusNotifierWatcher 2>&1 | head -2

say "launching into the race"
nohup "$@" > "$OUT/app.log" 2>&1 &
sleep 45
pgrep -x "$PROCNAME" >/dev/null && echo "app is running" || echo "app NOT running"

say "does the app watch for the watcher name?"
grep -A1 "member=AddMatch" "$OUT/bus.log" \
    | grep "StatusNotifierWatcher" | head -3
echo "(matches found: $(grep -A1 'member=AddMatch' "$OUT/bus.log" | grep -c 'StatusNotifierWatcher'))"

say "uncapped bus walk while FAILED"
timeout 400 gjs -m "$REPO/tools/sni-diag.js" --json "$OUT/failed.json" \
    > "$OUT/failed.txt" 2>&1
sed -n '/ITEMS FOUND/,/^$/p' "$OUT/failed.txt"

say "restoring the watcher name"
gnome-extensions enable status-tray@keithvassallo.com
sleep 20

say "registrations seen after the name came back"
grep -A2 "member=RegisterStatusNotifierItem" "$OUT/bus.log" | tail -20

say "items registered after recovery window"
items | tee "$OUT/after.txt"

say "uncapped bus walk after recovery"
timeout 400 gjs -m "$REPO/tools/sni-diag.js" --json "$OUT/after.json" \
    > "$OUT/after-diag.txt" 2>&1
sed -n '/ITEMS FOUND/,/^$/p' "$OUT/after-diag.txt"

kill $MON 2>/dev/null
say "done — artifacts in $OUT"
