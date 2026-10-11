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

artifact_format() {
  local base="$1"
  local lower
  lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  if [[ "$base" == "SHA256SUMS" ]]; then
    printf 'text\n'
    return 0
  fi
  case "$lower" in
    *.deb) printf 'deb\n' ;;
    *.zip) printf 'zip\n' ;;
    *.tar.gz | *.tgz | *.tar.bz2 | *.tbz2 | *.tar.xz | *.txz | *.tar.zst | *.tar | *.gz | *.bz2 | *.xz | *.zst | *.7z | *.rar | *.dmg | *.pkg | *.iso | *.jar | *.apk | *.ipa | *.nupkg)
      printf 'unsupported\n'
      ;;
    *) printf 'strings\n' ;;
  esac
}

record_text() {
  local display="$1"
  local source="$2"
  if [[ "$display" == "$source" ]]; then
    scan_text_file "$source"
    return 0
  fi
  local isolated old_hits hit
  isolated="$(mktemp)"
  old_hits="$hits"
  hits="$isolated"
  scan_text_file "$source"
  hits="$old_hits"
  if [[ -s "$isolated" ]]; then
    while IFS= read -r hit; do
      printf '%s:%s\n' "$display" "${hit#"$source:"}" >>"$hits"
    done <"$isolated"
  fi
  rm -f "$isolated"
}

record_strings() {
  local display="$1"
  local source="$2"
  if ! command -v strings >/dev/null 2>&1; then
    echo "check-release-text: strings is required to scan artifacts" >&2
    fail=1
    return 0
  fi
  local strings_file
  strings_file="$(mktemp "$tmp/strings.XXXXXX")"
  if ! strings -a -n 6 "$source" >"$strings_file"; then
    echo "check-release-text: strings failed for $display" >&2
    fail=1
    rm -f "$strings_file"
    return 0
  fi
  record_text "$display" "$strings_file"
  rm -f "$strings_file"
}

unpack_deb() {
  local file="$1"
  local dest="$2"
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$file" "$dest"
    return
  fi
  if ! command -v ar >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo "check-release-text: dpkg-deb or ar and tar are required to unpack a deb" >&2
    return 1
  fi
  local stage data candidate
  stage="$(mktemp -d "$tmp/ar.XXXXXX")"
  (cd "$stage" && ar x "$file") || return 1
  data=""
  for candidate in "$stage"/data.tar*; do
    [[ -f "$candidate" ]] || continue
    data="$candidate"
    break
  done
  if [[ -z "$data" ]]; then
    echo "check-release-text: deb has no data archive" >&2
    return 1
  fi
  tar -xf "$data" -C "$dest"
}

unpack_and_scan() {
  local display="$1"
  local file="$2"
  local kind="$3"
  local dest inner rel found=0
  dest="$(mktemp -d "$tmp/unpack.XXXXXX")"
  case "$kind" in
    deb)
      if ! unpack_deb "$file" "$dest"; then
        echo "check-release-text: could not unpack deb: $display" >&2
        fail=1
        return 0
      fi
      ;;
    zip)
      if ! command -v unzip >/dev/null 2>&1; then
        echo "check-release-text: unzip is required to scan zip artifacts" >&2
        fail=1
        return 0
      fi
      if ! unzip -q "$file" -d "$dest"; then
        echo "check-release-text: could not unpack zip: $display" >&2
        fail=1
        return 0
      fi
      ;;
    *)
      echo "check-release-text: unsupported artifact format: $display" >&2
      fail=1
      return 0
      ;;
  esac
  while IFS= read -r inner; do
    found=1
    rel="${inner#"$dest"/}"
    scan_artifact "$inner" "$display:$rel"
  done < <(find "$dest" -type f)
  if [[ "$found" -eq 0 ]]; then
    echo "check-release-text: archive has no files: $display" >&2
    fail=1
  fi
}

scan_artifact() {
  local file="$1"
  local display="${2:-$1}"
  if [[ ! -f "$file" ]]; then
    echo "check-release-text: artifact is missing: $display" >&2
    fail=1
    return 0
  fi
  local format
  format="$(artifact_format "$(basename "$file")")"
  case "$format" in
    text) record_text "$display" "$file" ;;
    deb) unpack_and_scan "$display" "$file" deb ;;
    zip) unpack_and_scan "$display" "$file" zip ;;
    unsupported)
      echo "check-release-text: unsupported artifact format: $display" >&2
      fail=1
      ;;
    strings) record_strings "$display" "$file" ;;
    *)
      echo "check-release-text: unsupported artifact format: $display" >&2
      fail=1
      ;;
  esac
}

scan_artifact_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    local file found=0
    while IFS= read -r file; do
      found=1
      scan_artifact "$file" "$file"
    done < <(find "$path" -type f)
    if [[ "$found" -eq 0 ]]; then
      echo "check-release-text: artifact directory is empty: $path" >&2
      fail=1
    fi
  elif [[ -f "$path" ]]; then
    scan_artifact "$path" "$path"
  else
    echo "check-release-text: artifact is missing: $path" >&2
    fail=1
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
