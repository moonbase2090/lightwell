#!/usr/bin/env bash
# Print a docker --platform value when MACHINE cannot run on HOST.
# Prints nothing when the container platform already matches the host.
set -euo pipefail

usage() {
  printf 'Usage: docker-platform.sh (--machine MACHINE | --objdump-file FILE | --objdump-stdin | --readelf-stdin) --host HOST\n' >&2
  exit 2
}

machine=""
host=""
objdump_file=""
objdump_stdin=0
readelf_stdin=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --machine) machine="${2:?}"; shift 2 ;;
    --host) host="${2:?}"; shift 2 ;;
    --objdump-file) objdump_file="${2:?}"; shift 2 ;;
    --objdump-stdin) objdump_stdin=1; shift ;;
    --readelf-stdin) readelf_stdin=1; shift ;;
    *) usage ;;
  esac
done

if [[ "$readelf_stdin" -eq 1 || "$objdump_stdin" -eq 1 ]]; then
  objdump_file="$(mktemp)"
  trap 'rm -f "$objdump_file"' EXIT
  cat > "$objdump_file"
fi

if [[ "$readelf_stdin" -eq 1 ]]; then
  line="$(grep -m1 'Machine:' "$objdump_file" || true)"
  case "$line" in
    *AArch64*|*aarch64*) machine="aarch64" ;;
    *"Advanced Micro Devices X86-64"*|*X86-64*|*x86-64*) machine="i386:x86-64" ;;
    *"<unknown>: 0xb7"*|*"<unknown>: 183"*) machine="aarch64" ;;
  esac
  if [[ -z "$machine" ]]; then
    printf 'readelf output has no recognized machine\n' >&2
    exit 1
  fi
fi

if [[ "$readelf_stdin" -eq 0 && -n "$objdump_file" ]]; then
  format_line="$(grep -m1 'file format ' "$objdump_file" || true)"
  case "$format_line" in
    *elf64-littleaarch64*|*elf64-aarch64*) machine="aarch64" ;;
    *elf64-x86-64*) machine="i386:x86-64" ;;
  esac
  if [[ -z "$machine" ]]; then
    line="$(grep -m1 '^architecture:' "$objdump_file" || true)"
    machine="${line#architecture: }"
    machine="${machine%%,*}"
    machine="${machine#"${machine%%[![:space:]]*}"}"
    machine="${machine%"${machine##*[![:space:]]}"}"
    if [[ "$machine" == "UNKNOWN!" || "$machine" == "architecture:" ]]; then
      machine=""
    fi
  fi
  if [[ -z "$machine" ]]; then
    printf 'objdump output has no recognized architecture\n' >&2
    exit 1
  fi
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
