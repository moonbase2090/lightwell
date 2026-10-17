$ErrorActionPreference = 'Stop'
Set-Location (git rev-parse --show-toplevel)
git config core.hooksPath .githooks
Write-Host 'Installed git hooks from .githooks (core.hooksPath).'
