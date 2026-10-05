#!/usr/bin/env bash
set -euo pipefail

environment="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lightwell-zigbuild"
python3 -m venv --clear "$environment"
"$environment/bin/python" -m pip install --disable-pip-version-check \
  'cargo-zigbuild==0.23.4' \
  'ziglang==0.14.1'

cat > "$environment/bin/zig" <<EOF
#!/usr/bin/env bash
exec "$environment/bin/python" -m ziglang "\$@"
EOF
chmod +x "$environment/bin/zig"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$environment/bin" >> "$GITHUB_PATH"
fi

export PATH="$environment/bin:$PATH"
export CARGO_ZIGBUILD_ZIG_PATH=zig
zig version
cargo-zigbuild --version
