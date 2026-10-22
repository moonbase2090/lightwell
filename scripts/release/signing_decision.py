"""Write the Artifact Signing decision for the release workflow.

Reads the Azure Artifact Signing settings from the environment and appends
``enabled=True`` or ``enabled=False`` to ``$GITHUB_OUTPUT``. The release
workflow calls this instead of duplicating the check, so the tested
``windows_msi.signing_enabled`` helper is the production decision.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import windows_msi


def main() -> int:
    output = os.environ.get("GITHUB_OUTPUT")
    if not output:
        print("GITHUB_OUTPUT is not set", file=sys.stderr)
        return 1
    enabled = windows_msi.signing_enabled()
    with open(output, "a", encoding="utf-8") as handle:
        handle.write(f"enabled={enabled}\n")
    if enabled:
        print("Windows code signing is enabled.")
    else:
        print(
            "Windows code signing skipped: "
            "Azure Artifact Signing settings are absent."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
