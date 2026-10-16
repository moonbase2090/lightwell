#!/bin/sh
# Pack a signed Lightwell.app into the archive the updater downloads.
# Usage: pack-macos-update.sh APP_PATH OUT_TAR_GZ
set -eu

app=$1
out=$2
parent=$(dirname "$app")
name=$(basename "$app")
tar -C "$parent" -czf "$out" "$name"
