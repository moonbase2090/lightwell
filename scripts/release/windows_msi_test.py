"""Checks for the per-user Lightwell MSI. These do not install the package."""

import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import windows_msi

ROOT = Path(__file__).resolve().parents[2]
WXS = (ROOT / "scripts/release/lightwell.wxs").read_text(encoding="utf-8")
BUILD = (ROOT / "scripts/release/build-windows.ps1").read_text(encoding="utf-8")
CI = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
RELEASE = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")


class WindowsMsiTest(unittest.TestCase):
    def test_upgrade_code_is_stable(self):
        expected = str(uuid.uuid5(uuid.NAMESPACE_URL, windows_msi.UPGRADE_NAME))
        self.assertEqual(windows_msi.UPGRADE_CODE, "40aaa682-0263-59c1-879b-5958c9008bb4")
        self.assertEqual(windows_msi.UPGRADE_CODE, expected)
        self.assertIn(f'UpgradeCode="{expected}"', WXS)

    def test_product_version_orders_a_release_after_its_candidate(self):
        self.assertEqual(windows_msi.msi_product_version("0.1.3-rc.1"), "0.1.3001")
        self.assertEqual(windows_msi.msi_product_version("0.1.3"), "0.1.3999")
        self.assertLess(
            windows_msi.msi_product_version("0.1.3-rc.2"),
            windows_msi.msi_product_version("0.1.3"),
        )

    def test_product_version_rejects_a_patch_the_encoding_cannot_store(self):
        with self.assertRaises(ValueError):
            windows_msi.msi_product_version("0.1.65")

    def test_gui_and_cli_use_different_directories(self):
        self.assertIn('Id="LightwellGui" Guid="ee6a3411-a1f0-5173-acc9-a05773a7070f" Directory="INSTALLFOLDER"', WXS)
        self.assertIn('Id="LightwellCli" Guid="b79faeab-9227-5cf4-850b-6e7aef8fe038" Directory="BINFOLDER"', WXS)
        self.assertIn('Name="Lightwell.exe"', WXS)
        self.assertIn('Name="lightwell.exe"', WXS)
        self.assertIn('Directory Id="BINFOLDER" Name="bin"', WXS)
        self.assertIn('Target="[INSTALLFOLDER]Lightwell.exe"', WXS)

    def test_path_edit_is_on_unless_declined(self):
        self.assertIn('Id="ADDTOPATH" Secure="yes" Value="1"', WXS)
        self.assertIn('Condition="ADDTOPATH = &quot;1&quot;"', WXS)
        self.assertIn('Scope="perUser"', WXS)

    def test_signing_is_skipped_when_azure_settings_are_absent(self):
        self.assertFalse(windows_msi.signing_enabled({}))
        present = {name: "set" for name in windows_msi.SIGNING_ENV}
        self.assertTrue(windows_msi.signing_enabled(present))
        present["AZURE_CLIENT_ID"] = "  "
        self.assertFalse(windows_msi.signing_enabled(present))
        self.assertIn(windows_msi.SIGNING_SKIPPED, BUILD)
        self.assertIn("python scripts/release/windows_msi_test.py", CI)

    def test_release_workflow_calls_the_tested_signing_decision(self):
        step = _workflow_step(
            RELEASE, "Decide whether Artifact Signing is configured"
        )
        self.assertIn("python scripts/release/signing_decision.py", step)
        self.assertNotIn("IsNullOrWhiteSpace", step)
        self.assertNotIn("GetEnvironmentVariable", step)

    def test_signing_decision_script_reports_complete_absent_and_blank(self):
        script = ROOT / "scripts/release/signing_decision.py"
        for settings, expected in [
            ({name: "set" for name in windows_msi.SIGNING_ENV}, "enabled=True"),
            ({}, "enabled=False"),
            (
                {
                    name: ("  " if name == "AZURE_CLIENT_ID" else "set")
                    for name in windows_msi.SIGNING_ENV
                },
                "enabled=False",
            ),
        ]:
            with self.subTest(settings=settings):
                self.assertEqual(_run_signing_decision(script, settings), expected)

    def test_signing_decision_script_fails_without_github_output(self):
        script = ROOT / "scripts/release/signing_decision.py"
        env = {
            key: value
            for key, value in os.environ.items()
            if key != "GITHUB_OUTPUT"
        }
        for name in windows_msi.SIGNING_ENV:
            env.pop(name, None)
        completed = subprocess.run(
            [sys.executable, str(script)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)


def _workflow_step(workflow: str, name: str) -> str:
    """Return the raw text of the named workflow step."""
    marker = f"- name: {name}"
    start = workflow.find(marker)
    if start < 0:
        raise AssertionError(f"workflow has no step named {name!r}")
    block_start = workflow.rfind("\n", 0, start) + 1
    lines = workflow[block_start:].splitlines(keepends=True)
    indent = len(lines[0]) - len(lines[0].lstrip())
    collected = []
    for line in lines[1:]:
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            leading = len(line) - len(line.lstrip())
            if leading <= indent:
                break
        collected.append(line)
    return "".join([lines[0], *collected])


def _run_signing_decision(script: Path, settings: dict) -> str:
    """Run the decision script with the given Azure settings; return its output line."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key != "GITHUB_OUTPUT"
    }
    for name in windows_msi.SIGNING_ENV:
        env.pop(name, None)
    env.update(settings)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "github_output.txt"
        env["GITHUB_OUTPUT"] = str(output)
        subprocess.run(
            [sys.executable, str(script)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            check=True,
        )
        return output.read_text(encoding="utf-8").strip()


if __name__ == "__main__":
    unittest.main()
