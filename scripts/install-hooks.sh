#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
printf '%s\n' "Installed git hooks from .githooks (core.hooksPath)."
