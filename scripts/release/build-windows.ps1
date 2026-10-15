[CmdletBinding()]
param(
    [ValidateSet('x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu')]
    [string]$Target = 'x86_64-pc-windows-msvc',
    [string]$Output = 'build/windows-release',
    [string]$Payload = '',
    [switch]$SkipBuild,
    [switch]$SkipPackage,
    # The release workflow signs the staged payload, then packages with -SkipBuild -Signed.
    [switch]$Signed
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $repoRoot
try {
    if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw 'Run this script on native Windows.' }
    if ($SkipBuild -and $SkipPackage) { throw 'Choose a build, a package, or both.' }
    if ($SkipBuild -and [string]::IsNullOrWhiteSpace($Payload)) {
        throw '-SkipBuild requires -Payload with Lightwell.exe and bin\lightwell.exe already staged.'
    }

    $versionToml = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'Cargo.toml')
    if ($versionToml -notmatch '(?m)^version = "([0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?)"') {
        throw 'Could not read the workspace version from Cargo.toml.'
    }
    $Version = $Matches[1]

    if ([string]::IsNullOrWhiteSpace($Payload)) {
        $Payload = Join-Path $Output 'payload'
    }
    $payloadPath = if ([System.IO.Path]::IsPathRooted($Payload)) { $Payload } else { Join-Path $repoRoot $Payload }
    $outputPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $repoRoot $Output }

    if (-not $SkipBuild) {
        if (Test-Path -LiteralPath $outputPath) { throw "Output already exists: $Output" }
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }

        $targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repoRoot 'target' }
        $binDir = Join-Path $targetRoot "$Target\release"
        # custom-protocol embeds dist/ and serves it from tauri://. Without it the
        # window loads devUrl (the Vite dev server) and shows a connection error.
        cargo build --locked --release --target $Target -p lightwell-app --features tauri/custom-protocol
        if ($LASTEXITCODE -ne 0) { throw 'Lightwell GUI build failed.' }
        New-Item -ItemType Directory -Force -Path (Join-Path $payloadPath 'bin') | Out-Null
        Copy-Item -Force -LiteralPath (Join-Path $binDir 'lightwell.exe') -Destination (Join-Path $payloadPath 'Lightwell.exe')
        cargo build --locked --release --target $Target -p lightwell-cli
        if ($LASTEXITCODE -ne 0) { throw 'Lightwell CLI build failed.' }
        Copy-Item -Force -LiteralPath (Join-Path $binDir 'lightwell.exe') -Destination (Join-Path $payloadPath 'bin\lightwell.exe')
    }

    if ($SkipPackage) {
        Write-Host "Windows binaries staged in $payloadPath"
        return
    }

    $gui = Join-Path $payloadPath 'Lightwell.exe'
    $cli = Join-Path $payloadPath 'bin\lightwell.exe'
    if (-not (Test-Path -LiteralPath $gui) -or -not (Test-Path -LiteralPath $cli)) {
        throw 'Payload must contain Lightwell.exe and bin\lightwell.exe.'
    }
    $guiHash = (Get-FileHash -LiteralPath $gui -Algorithm SHA256).Hash
    $cliHash = (Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash
    if ($guiHash -eq $cliHash) { throw 'GUI and CLI binaries are identical.' }

    Copy-Item -Force -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $payloadPath 'LICENSE')
    Set-Content -LiteralPath (Join-Path $payloadPath 'VERSION') -Value $Version -Encoding ascii

    if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
        dotnet tool install --global wix --version 5.0.2
        if ($LASTEXITCODE -ne 0) { throw 'WiX installation failed.' }
        $env:PATH = "$(Join-Path $env:USERPROFILE '.dotnet\tools');$env:PATH"
    }

    New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
    $msi = Join-Path $outputPath "lightwell-$Version-x64.msi"
    python (Join-Path $repoRoot 'scripts\release\windows_msi.py') --payload $payloadPath --version $Version --out $msi
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }

    if (-not $Signed) {
        Write-Host 'Windows code signing skipped: Azure Artifact Signing settings are absent.'
    }
    Write-Host "Windows package: $msi"
} finally {
    Pop-Location
}
