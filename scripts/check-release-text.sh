#!/usr/bin/env bash
# Fail when public release text contains private infrastructure markers.
# Output is file:line only. Matched text and denylist terms are not printed.
set -euo pipefail

usage() {
  echo "usage: check-release-text.sh [--root DIR] [--extra FILE] [--artifact PATH]" >&2
}

root=""
extras=()
artifacts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      root="${2:-}"
      shift 2
      ;;
    --extra)
      extras+=("${2:-}")
      shift 2
      ;;
    --artifact)
      artifacts+=("${2:-}")
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$root" ]]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
fi

allow_email="322824348+mb2090@users.noreply.github.com"
# Generic patterns only. Case-insensitive except where the expression already is.
# A home-directory marker must not treat the word Home inside prose as a path.
generic_patterns=(
  'DESKTOP-[A-Z0-9]+'
  '[A-Za-z0-9-]+\.local\b'
  '/Users/'
  '(^|[^A-Za-z0-9])/home/[a-z]'
  'C:\\Users'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}'
  '\b(10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)\b'
)
email_pattern='[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}'

hits="$(mktemp)"
tmp="$(mktemp -d)"
trap 'rm -f "$hits"; rm -rf "$tmp"' EXIT
fail=0

report_line() {
  printf '%s:%s\n' "$1" "$2" >>"$hits"
  fail=1
}

scan_pattern() {
  local file="$1"
  local pattern="$2"
  local out code=0
  out="$(grep -n -E -I -i -- "$pattern" "$file" 2>/dev/null)" || code=$?
  if [[ "$code" -eq 1 ]]; then
    return 0
  fi
  if [[ "$code" -ne 0 ]]; then
    echo "check-release-text: invalid pattern" >&2
    fail=1
    return 0
  fi
  local hit lineno
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    lineno="${hit%%:*}"
    if [[ "$lineno" =~ ^[0-9]+$ ]]; then
      report_line "$file" "$lineno"
    fi
  done <<<"$out"
}

scan_emails() {
  local file="$1"
  local out code=0
  out="$(grep -n -E -o -I -- "$email_pattern" "$file" 2>/dev/null)" || code=$?
  if [[ "$code" -eq 1 ]]; then
    return 0
  fi
  if [[ "$code" -ne 0 ]]; then
    echo "check-release-text: invalid pattern" >&2
    fail=1
    return 0
  fi
  local hit lineno match
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    lineno="${hit%%:*}"
    match="${hit#*:}"
    if [[ "$lineno" =~ ^[0-9]+$ && "$match" != "$allow_email" ]]; then
      report_line "$file" "$lineno"
    fi
  done <<<"$out"
}

scan_text_file() {
  local file="$1"
  local pattern
  [[ -f "$file" ]] || return 0
  for pattern in "${generic_patterns[@]}"; do
    scan_pattern "$file" "$pattern"
  done
  scan_emails "$file"
  if [[ "${#denylist[@]}" -gt 0 ]]; then
    for pattern in "${denylist[@]}"; do
      scan_pattern "$file" "$pattern"
    done
  fi
}

load_denylist() {
  denylist=()
  local source line
  local file="${RELEASE_DENYLIST_FILE:-${HOME:-}/.config/moonbase/release-denylist.txt}"
  if [[ -n "$file" && -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -n "$line" ]] || continue
      denylist+=("$line")
    done <"$file"
  fi
  if [[ -n "${RELEASE_DENYLIST:-}" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -n "$line" ]] || continue
      denylist+=("$line")
    done <<<"${RELEASE_DENYLIST}"
  fi
}

collect_text_files() {
  text_files=()
  local path
  shopt -s nullglob
  for path in "$root"/CHANGELOG.md "$root"/CHANGELOG*.md "$root"/README* "$root"/release-notes*; do
    [[ -f "$path" ]] || continue
    text_files+=("$path")
  done
  shopt -u nullglob
  if [[ -d "$root/docs" ]]; then
    while IFS= read -r path; do
      case "$path" in
        *.md | *.markdown | *.txt | *.rst | *.html)
          text_files+=("$path")
          ;;
      esac
    done < <(find "$root/docs" -type f)
  fi
  for path in "${extras[@]}"; do
    [[ -n "$path" && -f "$path" ]] || continue
    text_files+=("$path")
  done
}

scan_artifact() {
  local file="$1"
  local strings_file="$tmp/strings"
  [[ -f "$file" ]] || return 0
  if ! command -v strings >/dev/null 2>&1; then
    echo "check-release-text: strings is required to scan artifacts" >&2
    fail=1
    return 0
  fi
  strings -a -n 6 "$file" >"$strings_file" 2>/dev/null || true
  local isolated old_hits
  isolated="$(mktemp)"
  old_hits="$hits"
  hits="$isolated"
  scan_text_file "$strings_file"
  hits="$old_hits"
  if [[ -s "$isolated" ]]; then
    local hit
    while IFS= read -r hit; do
      printf '%s:%s\n' "$file" "${hit#"$strings_file:"}" >>"$hits"
    done <"$isolated"
  fi
  rm -f "$isolated"
}

scan_artifact_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    local file
    while IFS= read -r file; do
      scan_artifact "$file"
    done < <(find "$path" -type f)
  else
    scan_artifact "$path"
  fi
}

load_denylist
collect_text_files
for path in "${text_files[@]}"; do
  scan_text_file "$path"
done
for path in "${artifacts[@]}"; do
  [[ -n "$path" ]] || continue
  scan_artifact_path "$path"
done

if [[ -s "$hits" ]]; then
  sort -u "$hits"
fi
if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
exit 0
