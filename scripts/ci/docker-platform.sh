#!/usr/bin/env bash
# Print a docker --platform value when MACHINE cannot run on HOST.
# Prints nothing when the container platform already matches the host.
set -euo pipefail

usage() {
  printf 'Usage: docker-platform.sh (--machine MACHINE | --objdump-file FILE | --objdump-stdin) --host HOST\n' >&2
  exit 2
}

machine=""
host=""
objdump_file=""
objdump_stdin=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --machine) machine="${2:?}"; shift 2 ;;
    --host) host="${2:?}"; shift 2 ;;
    --objdump-file) objdump_file="${2:?}"; shift 2 ;;
    --objdump-stdin) objdump_stdin=1; shift ;;
    *) usage ;;
  esac
done

if [[ "$objdump_stdin" -eq 1 ]]; then
  objdump_file="$(mktemp)"
  trap 'rm -f "$objdump_file"' EXIT
  cat > "$objdump_file"
fi

if [[ -n "$objdump_file" ]]; then
  line="$(grep -m1 '^architecture:' "$objdump_file" || true)"
  if [[ -z "$line" ]]; then
    printf 'objdump output has no architecture line\n' >&2
    exit 1
  fi
  machine="${line#architecture: }"
  machine="${machine%%,*}"
  machine="${machine#"${machine%%[![:space:]]*}"}"
  machine="${machine%"${machine##*[![:space:]]}"}"
fi

if [[ -z "$machine" || -z "$host" ]]; then
  usage
fi

case "$machine" in
  aarch64)
    if [[ "$host" != "aarch64" && "$host" != "arm64" ]]; then
      printf 'linux/arm64\n'
    fi
    ;;
  x86-64|i386:x86-64)
    if [[ "$host" != "x86_64" ]]; then
      printf 'linux/amd64\n'
    fi
    ;;
  *)
    printf 'unsupported architecture: %s\n' "$machine" >&2
    exit 1
    ;;
esac
