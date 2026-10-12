#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "verify doctor: node is missing" >&2
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 22 ]]; then
  echo "verify doctor: Node.js 22+ required (found $(node -v))" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "verify doctor: npm is missing" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "verify doctor: cargo is missing" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm ci
fi

cargo build -p lightwell-cli --locked
echo "verify doctor: ok"
