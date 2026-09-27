#!/bin/bash
#
# Measures how long org.kde.StatusNotifierWatcher has no owner during the rapid
# disable/enable churn GNOME puts an extension through on a session-mode change.
#
# A real lock produces five cycles in ~215ms (observed). This reproduces that
# shape by toggling directly, so the window can be measured without locking the
# session. Any app that starts inside the window gets ServiceUnknown and, as
# this investigation established, is then lost permanently.
set -u

OUT="$HOME/sni-race-tests/$(date +%Y%m%d-%H%M%S)-churn"
mkdir -p "$OUT"
CYCLES=${1:-5}

echo "Monitoring NameOwnerChanged for the watcher name..."
# Unfiltered, then grepped. A custom match rule for this broadcast silently
# matches nothing under dbus-monitor, which reads as "the name never dropped"
# and is the opposite of the truth.
dbus-monitor --session > "$OUT/name-changes.log" 2>&1 &
MON=$!
sleep 1

echo "Churning the extension $CYCLES times, as a lock does..."
for i in $(seq "$CYCLES"); do
    gnome-extensions disable status-tray@keithvassallo.com
    gnome-extensions enable status-tray@keithvassallo.com
done

sleep 10
kill $MON 2>/dev/null
sleep 1

echo
echo "=== NameOwnerChanged transitions ==="
# Each signal carries name, old owner, new owner. An empty new owner is a gap
# opening; the next non-empty one closes it.
python3 - "$OUT/name-changes.log" <<'PY'
import re, sys

# Line-based: an unfiltered dump contains the text "signal " inside match-rule
# strings too, so splitting on it shreds the records.
events = []
lines = open(sys.argv[1], errors="replace").read().splitlines()
for i, line in enumerate(lines):
    if "member=NameOwnerChanged" not in line:
        continue
    m = re.search(r"time=(\d+\.\d+)", line)
    if not m:
        continue
    args = []
    for follow in lines[i + 1:i + 6]:
        s = re.match(r'\s*string "([^"]*)"\s*$', follow)
        if not s:
            break
        args.append(s.group(1))
    if len(args) >= 3 and args[0] == "org.kde.StatusNotifierWatcher":
        events.append((float(m.group(1)), args[1], args[2]))

if not events:
    print("no transitions for the watcher name")
    sys.exit()

first = events[0][0]
gap_start = None
total = 0.0
for t, old, new in events:
    rel = (t - first) * 1000
    if new:
        label = f"ACQUIRED by {new}"
        if gap_start is not None:
            gap = (t - gap_start) * 1000
            total += gap
            label += f"   <-- unowned for {gap:.0f} ms"
            gap_start = None
    else:
        label = f"RELEASED (was {old})"
        gap_start = t
    print(f"  +{rel:8.1f} ms  {label}")

print()
print(f"TOTAL TIME WITH NO WATCHER ON THE BUS: {total:.0f} ms")
if gap_start is not None:
    print("  (still unowned when capture ended)")
PY

echo
echo "=== final state ==="
gnome-extensions info status-tray@keithvassallo.com | grep -i state
timeout 10 gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner org.kde.StatusNotifierWatcher 2>&1
echo "artifacts: $OUT"
