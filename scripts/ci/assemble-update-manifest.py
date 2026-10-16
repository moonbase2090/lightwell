#!/usr/bin/env python3
"""Build the Tauri updater latest.json from signed release assets."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--notes", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--repo", default="moonbase2090/lightwell")
    parser.add_argument("--asset", nargs=3, action="append", metavar=("PLATFORM", "FILE", "SIG"), required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    notes = args.notes.read_text(encoding="utf-8").strip()
    platforms: dict[str, dict[str, str]] = {}
    for platform, filename, signature_path in args.asset:
        signature_file = Path(signature_path)
        if not signature_file.is_file():
            continue
        signature = signature_file.read_text(encoding="utf-8").strip()
        if signature == "":
            continue
        platforms[platform] = {
            "signature": signature,
            "url": f"https://github.com/{args.repo}/releases/download/{args.tag}/{filename}",
        }
    if not platforms:
        return
    manifest = {
        "version": args.version,
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    args.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
