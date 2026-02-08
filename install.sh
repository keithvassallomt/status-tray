#!/bin/bash
#
# Status Tray Extension - Install Script
#
# Installs the extension to ~/.local/share/gnome-shell/extensions/
# For development, this creates a symlink so changes are reflected immediately
# (after restarting GNOME Shell with Alt+F2 -> r on X11, or logout/login on Wayland)
#

set -e

EXTENSION_UUID="status-tray@keithvassallo.com"
EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"
SRC_DIR="$(cd "$(dirname "$0")/src" && pwd)"
TARGET_DIR="$EXTENSIONS_DIR/$EXTENSION_UUID"
SCHEMA_DIR="$SRC_DIR/schemas"

echo "Status Tray Extension Installer"
echo "================================"
echo ""
echo "Source: $SRC_DIR"
echo "Target: $TARGET_DIR"
echo ""

# Compile GSettings schemas
if [ -d "$SCHEMA_DIR" ]; then
    echo "Compiling GSettings schemas..."
    glib-compile-schemas "$SCHEMA_DIR"
    if [ $? -eq 0 ]; then
        echo "  ✓ Schemas compiled successfully"
    else
        echo "  ✗ Schema compilation failed!"
        exit 1
    fi
    echo ""
fi

# Create extensions directory if it doesn't exist
mkdir -p "$EXTENSIONS_DIR"

# Remove existing installation (symlink or directory)
if [ -L "$TARGET_DIR" ]; then
    echo "Removing existing symlink..."
    rm "$TARGET_DIR"
elif [ -d "$TARGET_DIR" ]; then
    echo "Removing existing directory..."
    rm -rf "$TARGET_DIR"
fi

# Check if --symlink flag was passed
if [ "$1" == "--symlink" ]; then
    echo "Installing (symlink mode for development)..."
    ln -s "$SRC_DIR" "$TARGET_DIR"
else
    echo "Installing (copy mode)..."
    cp -r "$SRC_DIR" "$TARGET_DIR"
fi

echo ""
echo "Installation complete!"
echo ""
echo "To enable the extension:"
echo "  gnome-extensions enable $EXTENSION_UUID"
echo ""
echo "To restart GNOME Shell:"
echo "  - X11: Alt+F2 -> type 'r' -> Enter"
echo "  - Wayland: Log out and log back in"
echo ""
echo "To open settings:"
echo "  gnome-extensions prefs $EXTENSION_UUID"
echo ""
echo "To view logs:"
echo "  journalctl -f -o cat /usr/bin/gnome-shell"
echo ""
