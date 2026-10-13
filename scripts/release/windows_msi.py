"""Per-user Lightwell MSI version mapping and WiX build.

MSI ProductVersion has three numeric fields, each at most 65535, and cannot
store a semver prerelease. Patch numbers through 64 are encoded as
``patch * 1000 + slot``. A stable release uses slot 999. ``X.Y.Z-rc.N`` uses
slot N (1 through 998). That orders ``0.1.3-rc.1`` (0.1.3001) before
``0.1.3`` (0.1.3999).
"""

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

UPGRADE_NAMESPACE = uuid.NAMESPACE_URL
UPGRADE_NAME = "https://github.com/moonbase2090/lightwell#windows-msi-upgrade-code"
# Stable for the life of the product. A new value would install beside the old one.
UPGRADE_CODE = str(uuid.uuid5(UPGRADE_NAMESPACE, UPGRADE_NAME))

SIGNING_ENV = (
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE",
)
SIGNING_SKIPPED = (
    "Windows code signing skipped: Azure Artifact Signing settings are absent."
)
_RC = re.compile(r"^rc\.(0|[1-9][0-9]*)$")
_MSI_FIELD_MAX = 65535
_PATCH_MAX = 64


def msi_product_version(version: str) -> str:
    """Return the numeric MSI ProductVersion for a release version."""
    full = version.strip().split("+", 1)[0]
    if not full:
        raise ValueError("MSI packaging requires a version")
    base, separator, prerelease = full.partition("-")
    parts = base.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise ValueError("MSI packaging accepts X.Y.Z or X.Y.Z-rc.N only")
    major, minor, patch = (int(part) for part in parts)
    if major > _MSI_FIELD_MAX or minor > _MSI_FIELD_MAX:
        raise ValueError("MSI product version field exceeds 65535")
    if patch > _PATCH_MAX:
        raise ValueError(
            f"MSI product version cannot encode patch {patch}; the maximum is {_PATCH_MAX}"
        )
    if separator == "":
        slot = 999
    else:
        match = _RC.fullmatch(prerelease)
        if match is None:
            raise ValueError("MSI packaging accepts X.Y.Z or X.Y.Z-rc.N only")
        slot = int(match.group(1))
        if slot < 1 or slot > 998:
            raise ValueError("release candidate number must be 1 through 998")
    third = patch * 1000 + slot
    if third > _MSI_FIELD_MAX:
        raise ValueError("MSI product version field exceeds 65535")
    return f"{major}.{minor}.{third}"


def signing_enabled(env: dict[str, str] | None = None) -> bool:
    """True only when every Artifact Signing setting is present and non-blank."""
    source = os.environ if env is None else env
    return all(str(source.get(name, "")).strip() for name in SIGNING_ENV)


def build_msi(payload: Path, repo: Path, version: str, out_msi: Path) -> None:
    """Compile lightwell.wxs. WiX's directory check only succeeds on Windows."""
    gui = payload / "Lightwell.exe"
    cli = payload / "bin" / "lightwell.exe"
    if not gui.is_file() or not cli.is_file():
        raise ValueError("payload must contain Lightwell.exe and bin/lightwell.exe")
    if _digest(gui) == _digest(cli):
        raise ValueError("GUI and CLI binaries are identical")
    product_version = msi_product_version(version)
    wix = _wix_command()
    out_msi.parent.mkdir(parents=True, exist_ok=True)
    command = [
        wix,
        "build",
        str(repo / "scripts/release/lightwell.wxs"),
        "-arch",
        "x64",
        "-d",
        f"ProductVersion={product_version}",
        "-d",
        f"SourceVersion={version}",
        "-d",
        f"Payload={payload}",
        "-d",
        f"Repo={repo}",
        "-o",
        str(out_msi),
    ]
    _run_wix(command, out_msi.with_suffix(".wix-build.log"))
    _run_wix([wix, "msi", "validate", str(out_msi)], out_msi.with_suffix(".wix-validate.log"))
    _write_checksum(out_msi)


def _wix_command() -> str:
    found = shutil.which("wix")
    if found:
        return found
    candidate = Path.home() / ".dotnet" / "tools" / "wix.exe"
    if candidate.is_file():
        return str(candidate)
    raise RuntimeError(
        "WiX 5.0.2 is not installed. Run: dotnet tool install --global wix --version 5.0.2"
    )


def _run_wix(command: list[str], log_path: Path) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(command[:3])} failed\n{result.stdout}\n{result.stderr}")


def _write_checksum(out_msi: Path) -> None:
    checksums = out_msi.with_name("SHA256SUMS-windows")
    checksums.write_text(f"{_digest(out_msi)}  {out_msi.name}\n", encoding="utf-8")


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    build_msi(args.payload.resolve(), repo, args.version, args.out.resolve())


if __name__ == "__main__":
    main()
