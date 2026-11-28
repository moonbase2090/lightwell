# Native MSI update

Run for every batched Windows release proof. A build or a fresh install alone does not cover this path.

## Preconditions

- Use a clean Windows x64 VM, a normal user account and Git on PATH.
- Choose the preceding signed release and the release being verified. The latter must be published and selected by the production `latest.json` endpoint.
- Keep this VM and its synthetic workspace separate from daily use. Use the installed app throughout the check.

## Install the preceding release

In PowerShell, set the two versions for the release under test. These example values exercise 0.1.34 to 0.1.35:

```powershell
$ErrorActionPreference = 'Stop'
$PreviousVersion = '0.1.34'
$ReleaseVersion = '0.1.35'
$ProofRoot = Join-Path ([IO.Path]::GetTempPath()) ('lightwell-msi-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $ProofRoot | Out-Null
$AssetName = "Lightwell_${PreviousVersion}_x64.msi"
$BaselineMsi = Join-Path $ProofRoot $AssetName
$ReleaseUrl = "https://github.com/moonbase2090/lightwell/releases/download/v$PreviousVersion"
Invoke-WebRequest "$ReleaseUrl/$AssetName" -OutFile $BaselineMsi
Invoke-WebRequest "$ReleaseUrl/SHA256SUMS" -OutFile (Join-Path $ProofRoot 'SHA256SUMS')
$HashLine = @(Get-Content (Join-Path $ProofRoot 'SHA256SUMS') | Where-Object { $_.EndsWith("  $AssetName") })
if ($HashLine.Count -ne 1) { throw 'Expected exactly one MSI checksum.' }
if ((Get-FileHash $BaselineMsi -Algorithm SHA256).Hash -ne ($HashLine[0] -split '\s+')[0]) { throw 'MSI checksum mismatch.' }
if ((Get-AuthenticodeSignature $BaselineMsi).Status -ne 'Valid') { throw 'MSI signature is not valid.' }
$Latest = Invoke-RestMethod 'https://github.com/moonbase2090/lightwell/releases/latest/download/latest.json'
if ($PreviousVersion -eq $ReleaseVersion -or $Latest.version -ne $ReleaseVersion) { throw 'Choose distinct versions ending at the published update.' }
$MsiLog = Join-Path $ProofRoot 'baseline-install.log'
$Install = Start-Process msiexec.exe -ArgumentList @('/i', "`"$BaselineMsi`"", '/passive', '/norestart', '/l*v', "`"$MsiLog`"") -Wait -PassThru
if ($Install.ExitCode -notin @(0, 3010)) { throw "Baseline install failed: $($Install.ExitCode)" }
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\Lightwell'
$Cli = Join-Path $InstallRoot 'bin\lightwell.exe'
if ((& $Cli --version) -ne "lightwell $PreviousVersion") { throw 'Baseline CLI version mismatch.' }
$Workspace = Join-Path $ProofRoot 'workspace'
New-Item -ItemType Directory -Path (Join-Path $Workspace 'src') | Out-Null
Set-Content (Join-Path $Workspace 'Cargo.toml') "[package]`nname = `"msi-update-fixture`"`nversion = `"0.0.0`"`nedition = `"2021`""
Set-Content (Join-Path $Workspace 'src\lib.rs') 'pub fn sample() -> u8 { 7 }'
git -C $Workspace init
if ($LASTEXITCODE -ne 0) { throw 'Fixture repository initialization failed.' }
```

If installation reports 3010, reboot the VM and restore the variables before continuing.

## Prepare state and install through the app

1. Confirm `$Workspace` contains the small Cargo project created above.
2. Open the installed app from its Start menu shortcut and open that workspace. If an update offer appears early, choose **Not now**.
3. Set the theme to **Light**. Add a project note with the literal text `Native MSI update proof.`. Close and reopen the app; confirm the theme, recent workspace and note are still present.
4. Save a screenshot showing the workspace and note. Close the app before recording the baseline hashes:

   ```powershell
   $NotesFile = Join-Path $Workspace '.lightwell\notes.json'
   $NotesHash = (Get-FileHash $NotesFile -Algorithm SHA256).Hash
   $GuiHash = (Get-FileHash (Join-Path $InstallRoot 'Lightwell.exe') -Algorithm SHA256).Hash
   @{ notes = $NotesHash; gui = $GuiHash; previous = $PreviousVersion; target = $ReleaseVersion } |
       ConvertTo-Json | Set-Content (Join-Path $ProofRoot 'before-update.json')
   ```

5. Reopen the app. In Settings, select **Check now**. Require an **Update available** dialog naming `$ReleaseVersion` and an **Install update** button. Save a screenshot of the offer.
6. Select **Install update** and complete any installer prompts. Require installation to finish and the app to relaunch. Record an error or missing relaunch as a failure. Installing the target MSI manually does not pass this step.

## Check the installed result

Run in the same PowerShell session after the app relaunches:

```powershell
$InstalledVersion = Get-Content (Join-Path $InstallRoot 'VERSION') -Raw
$RegisteredVersion = (Get-ItemProperty 'HKCU:\Software\Moonbase2090\Lightwell').FullVersion
$CliVersion = & $Cli --version
if ($InstalledVersion.Trim() -ne $ReleaseVersion) { throw 'Installed VERSION mismatch.' }
if ($RegisteredVersion -ne $ReleaseVersion) { throw 'Registered version mismatch.' }
if ($CliVersion -ne "lightwell $ReleaseVersion") { throw 'Updated CLI version mismatch.' }
if ((Get-FileHash $NotesFile -Algorithm SHA256).Hash -ne $NotesHash) { throw 'Project notes changed during update.' }
if ((Get-FileHash (Join-Path $InstallRoot 'Lightwell.exe') -Algorithm SHA256).Hash -eq $GuiHash) { throw 'GUI payload was not replaced.' }
foreach ($Binary in @((Join-Path $InstallRoot 'Lightwell.exe'), $Cli)) {
    if ((Get-AuthenticodeSignature $Binary).Status -ne 'Valid') { throw 'Installed executable signature is not valid.' }
}
"Native MSI package checks passed: $PreviousVersion -> $ReleaseVersion; $CliVersion; project notes unchanged." |
    Tee-Object (Join-Path $ProofRoot 'result.txt')
```

Confirm in the relaunched app that the **Light** theme, recent workspace and exact project note remain. Open the workspace and inspect a source block. In Settings, select **Check now** again and require **Lightwell is up to date.** Save a screenshot of the resulting app state.

The check passes only when both the command assertions and these UI observations pass. An interrupted update, lost state, manual replacement install or version mismatch is a failure to report before releasing.

## Evidence and cleanup

Keep the version pair, release links, MSI hash and signature status, `before-update.json`, `result.txt`, baseline installer log, any updater/installer error, and the before/offer/after screenshots. Record the final UI observations and whether the app relaunched. Scrub user names, machine paths and other private details before posting proof.

Stop and delete only the VM created for this run after retaining the evidence. Include this check's result in the batched Windows release proof; leave it pending when native Windows was unavailable.
