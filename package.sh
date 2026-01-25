#!/bin/bash
#
# Package script for Status Tray GNOME extension
# Creates a zip file ready for submission to extensions.gnome.org
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
UUID="status-tray@keithvassallo.com"
OUTPUT_FILE="$SCRIPT_DIR/$UUID.zip"

echo "Packaging Status Tray extension..."

# Remove old package if exists
if [ -f "$OUTPUT_FILE" ]; then
    echo "Removing old package..."
    rm "$OUTPUT_FILE"
fi

# Change to src directory
cd "$SRC_DIR"

# Create zip with only necessary files
# Explicitly exclude compiled schemas and any other unnecessary files
zip -r "$OUTPUT_FILE" \
    extension.js \
    prefs.js \
    metadata.json \
    stylesheet.css \
    schemas/*.gschema.xml \
    --exclude "schemas/gschemas.compiled" \
    --exclude "*.pyc" \
    --exclude "__pycache__/*" \
    --exclude ".DS_Store" \
    --exclude "*.swp" \
    --exclude "*~"

echo ""
echo "Package created: $OUTPUT_FILE"
echo ""
echo "Contents:"
unzip -l "$OUTPUT_FILE"
