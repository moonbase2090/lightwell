#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Render the 1x and 2x Finder backgrounds from the checked-in SVG source."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/release/dmg-background.svg"
OUTPUTS = (
    (400, 600, ROOT / "scripts/release/dmg-background.png"),
    (800, 1200, ROOT / "scripts/release/dmg-background@2x.png"),
)


for height, width, output in OUTPUTS:
    subprocess.run(
        [
            "sips",
            "--setProperty",
            "format",
            "png",
            "--resampleHeightWidth",
            str(height),
            str(width),
            str(SOURCE),
            "--out",
            str(output),
        ],
        check=True,
    )
