#!/bin/bash
#
# Tests section 2.4 of the handover: the reporter says appindicator recovers
# KeePassXC where Status Tray does not.
#
# Run this with the target app ALREADY in the failed state (started while no
# watcher existed). It hands the watcher name to appindicator instead of Status
# Tray and reports whether appindicator finds anything Status Tray did not.
# Only one extension can own the name, so they are swapped, never both up.
set -u

REPO=/home/keith/LocalCode/keithvassallomt/status-tray
OUT="$HOME/sni-race-tests/$(date +%Y%m%d-%H%M%S)-appindicator-ab"
mkdir -p "$OUT"

say() { echo; echo "##### $* #####"; }

items() {
    timeout 15 gdbus call --session --dest org.kde.StatusNotifierWatcher \
        --object-path /StatusNotifierWatcher \
        --method org.freedesktop.DBus.Properties.Get \
        org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>&1
}

owner() {
    timeout 10 gdbus call --session --dest org.freedesktop.DBus \
        --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID \
        org.kde.StatusNotifierWatcher 2>&1
}

say "target app state going in"
pgrep -ax keepassxc || echo "keepassxc NOT running"

say "baseline: Status Tray owns the watcher"
items | tee "$OUT/statustray-items.txt"

dbus-monitor --session > "$OUT/bus.log" 2>&1 &
MON=$!
sleep 1

say "swapping: status-tray off, appindicator on"
gnome-extensions disable status-tray@keithvassallo.com
sleep 3
gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
# appindicator's recovery sweep fires 2s after it builds its watcher; give it
# far longer than that so a slow busAnalyzer subprocess is not mistaken for a
# negative result.
sleep 45

say "watcher owner now (should be gnome-shell, via appindicator)"
owner
gnome-extensions info appindicatorsupport@rgcjonas.gmail.com | grep -i state

say "APPINDICATOR's registered items"
items | tee "$OUT/appindicator-items.txt"

say "did keepassxc register or start exporting under appindicator?"
grep -A2 "member=RegisterStatusNotifierItem" "$OUT/bus.log" | tail -25

timeout 400 gjs -m "$REPO/tools/sni-diag.js" --json "$OUT/appind.json" \
    > "$OUT/appind-diag.txt" 2>&1
sed -n '/ITEMS FOUND/,/^$/p' "$OUT/appind-diag.txt"

say "restoring: appindicator off, status-tray on"
gnome-extensions disable appindicatorsupport@rgcjonas.gmail.com
sleep 3
gnome-extensions enable status-tray@keithvassallo.com
sleep 15
items | tee "$OUT/restored-items.txt"

kill $MON 2>/dev/null
say "done — artifacts in $OUT"
