"""Checks for the per-user Lightwell MSI. These do not install the package."""

import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import windows_msi

ROOT = Path(__file__).resolve().parents[2]
WXS = (ROOT / "scripts/release/lightwell.wxs").read_text(encoding="utf-8")
BUILD = (ROOT / "scripts/release/build-windows.ps1").read_text(encoding="utf-8")
CI = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")


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


if __name__ == "__main__":
    unittest.main()
