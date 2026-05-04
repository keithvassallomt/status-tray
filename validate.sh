#!/bin/bash
#
# Validate script for Status Tray GNOME extension
# Runs shexli static analysis against src/ — same check as EGO submission,
# but without producing a zip first.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
VENV_DIR="$SCRIPT_DIR/.shexli-venv"

# shexli requires Python >= 3.12; pick the newest available interpreter
# rather than relying on the system `python3` symlink, which on some
# distros (e.g. Ubuntu 22.04) still points at 3.10.
PYTHON=""
for candidate in python3.14 python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        version=$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
        major=${version%%.*}
        minor=${version#*.}
        if [ "$major" -ge 3 ] && [ "$minor" -ge 12 ]; then
            PYTHON="$candidate"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "ERROR: shexli requires Python 3.12 or newer, none found on PATH." >&2
    echo "Install python3.12+ (e.g. 'sudo apt install python3.13-venv') and retry." >&2
    exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating shexli venv at $VENV_DIR (using $PYTHON)..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
. "$VENV_DIR/bin/activate"
pip install -q -U shexli

echo "Running shexli static analysis on $SRC_DIR..."
shexli "$SRC_DIR"

deactivate
