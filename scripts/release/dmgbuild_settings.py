# SPDX-License-Identifier: MIT
"""Build the drag-to-install Lightwell disk image."""

from pathlib import Path


ROOT = Path(defines["root"]).resolve()  # noqa: F821
APP = Path(defines["app"]).resolve()  # noqa: F821
APP_NAME = APP.name

if APP_NAME != "Lightwell.app" or not APP.is_dir():
    raise SystemExit(f"expected an existing Lightwell.app, got: {APP}")

volume_name = "Lightwell"
format = "UDZO"
files = [(str(APP), APP_NAME)]
symlinks = {"Applications": "/Applications"}

background = str(ROOT / "scripts/release/dmg-background.png")
window_rect = ((0, 0), (600, 400))
show_toolbar = False
show_sidebar = False
show_status_bar = False
show_pathbar = False
default_view = "icon-view"
show_icon_preview = False
icon_size = 128
text_size = 14
icon_locations = {
    APP_NAME: (120, 200),
    "Applications": (480, 200),
}
