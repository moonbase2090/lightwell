#!/usr/bin/env bash
# Fail when public release text contains private infrastructure markers.
# Output is file:line only. Matched text and denylist terms are not printed.
#
# Release text is the repository text, --extra files (notes, title, tag
# message), each --artifact's file name, and plain-text artifacts such as
# SHA256SUMS. Binary and archive contents are scanned only with --deep:
# compressed bytes, CI runner paths, and strings in bundled third-party
# libraries match the generic patterns without being our text.
set -euo pipefail

# A Windows Store alias can be named python3 and still exit without running
# Python. Probe the interpreter, then fall back to python or the py launcher.
python_runs() {
  "$@" -c 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1
}
if ! python_runs python3; then
  if python_runs python; then
    python3() { python "$@"; }
  elif python_runs py -3; then
    python3() { py -3 "$@"; }
  else
    echo "check-release-text: Python 3 is required" >&2
    exit 1
  fi
fi

usage() {
  echo "usage: check-release-text.sh [--root DIR] [--extra FILE] [--artifact PATH] [--deep]" >&2
}

root=""
extras=()
artifacts=()
deep=0
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
    --deep)
      deep=1
      shift
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
  '\b[A-Za-z0-9-]+\.local($|[^/A-Za-z0-9_.-])'
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

# Windows default host names are upper case; a case-insensitive match would
# flag ordinary words such as icon names ("preferences-desktop-font").
scan_case_sensitive() {
  local file="$1"
  local pattern="$2"
  local out code=0 line
  out="$(grep -n -E -I -- "$pattern" "$file" 2>/dev/null)" || code=$?
  if [[ "$code" -gt 1 ]]; then
    echo "check-release-text: invalid pattern" >&2
    fail=1
    return 0
  fi
  [[ -n "$out" ]] || return 0
  while IFS= read -r line; do
    report_line "$file" "${line%%:*}"
  done <<<"$out"
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
  scan_case_sensitive "$file" 'DESKTOP-[A-Z0-9]{4,}'
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

sniff_format() {
  local file="$1"
  local head
  head="$(od -An -tx1 -N 8 "$file" 2>/dev/null | tr -d ' \n')"
  case "$head" in
    504b0304* | 504b0506* | 504b0708*) printf 'zip\n'; return 0 ;;
    213c617263683e0a*) printf 'deb\n'; return 0 ;;
    1f8b*) printf 'gzip\n'; return 0 ;;
    425a68*) printf 'bzip2\n'; return 0 ;;
    fd377a585a00*) printf 'xz\n'; return 0 ;;
    28b52ffd*) printf 'zstd\n'; return 0 ;;
    377abcaf271c* | 52617221* | 78617221*) printf 'unsupported\n'; return 0 ;;
  esac
  if [[ "$(od -An -c -j 257 -N 5 "$file" 2>/dev/null | tr -d ' \n')" == "ustar" ]]; then
    printf 'tar\n'
    return 0
  fi
  return 1
}

artifact_format() {
  local file="$1"
  local base lower sniffed
  base="$(basename "$file")"
  lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  if sniffed="$(sniff_format "$file")"; then
    printf '%s\n' "$sniffed"
    return 0
  fi
  if [[ "$base" == "SHA256SUMS" ]]; then
    printf 'text\n'
    return 0
  fi
  case "$lower" in
    *.deb) printf 'deb\n' ;;
    *.zip) printf 'zip\n' ;;
    *.dmg) printf 'dmg\n' ;;
    *.tar.gz | *.tgz | *.tar.bz2 | *.tbz2 | *.tar.xz | *.txz | *.tar.zst | *.tar | *.gz | *.bz2 | *.xz | *.zst | *.7z | *.rar | *.pkg | *.iso | *.jar | *.apk | *.ipa | *.nupkg)
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

# GNU strings -a -n 6: whole-file runs of at least six printable ASCII bytes.
extract_strings() {
  local source="$1"
  local output="$2"
  if command -v strings >/dev/null 2>&1; then
    strings -a -n 6 "$source" >"$output"
    return $?
  fi
  python3 - "$source" "$output" <<'PY'
import sys

source, output = sys.argv[1:]
data = open(source, "rb").read()
minimum = 6
run = bytearray()
with open(output, "wb") as handle:
    def flush():
        if len(run) >= minimum:
            handle.write(run + b"\n")
        run.clear()

    for byte in data:
        if 32 <= byte <= 126:
            run.append(byte)
        else:
            flush()
    flush()
PY
}

record_strings() {
  local display="$1"
  local source="$2"
  local strings_file
  strings_file="$(mktemp "$tmp/strings.XXXXXX")"
  if ! extract_strings "$source" "$strings_file"; then
    echo "check-release-text: strings failed for $display" >&2
    fail=1
    rm -f "$strings_file"
    return 0
  fi
  record_text "$display" "$strings_file"
  rm -f "$strings_file"
}

extract_ar() {
  local archive="$1"
  local dest="$2"
  if command -v ar >/dev/null 2>&1; then
    (cd "$dest" && ar x "$archive")
    return $?
  fi
  python3 - "$archive" "$dest" <<'PY'
import os
import sys

archive, dest = sys.argv[1:]
data = open(archive, "rb").read()
magic = b"!<arch>\n"
if not data.startswith(magic):
    raise SystemExit("not an ar archive")
offset = len(magic)
root = os.path.realpath(dest)
while offset + 60 <= len(data):
    header = data[offset : offset + 60]
    if header[58:60] != b"`\n":
        raise SystemExit("bad ar header")
    name = header[:16].decode("ascii", "replace").strip()
    size = int(header[48:58].decode("ascii").strip() or "0")
    offset += 60
    body = data[offset : offset + size]
    offset += size + (size % 2)
    if name in {"/", "//", "/SYM64/"} or not name:
        continue
    if name.startswith("#1/"):
        name_len = int(name[3:])
        name = body[:name_len].split(b"\x00", 1)[0].decode("utf-8", "replace")
        body = body[name_len:]
    name = name.rstrip("/")
    parts = name.replace("\\", "/").split("/")
    if name.startswith("/") or ".." in parts or parts == [""]:
        raise SystemExit("refusing ar member " + name)
    target = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([root, target]) != root:
        raise SystemExit("refusing ar member " + name)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(body)
if offset < len(data) and data[offset:].strip(b"\n"):
    raise SystemExit("truncated ar archive")
PY
}

unpack_deb() {
  local file="$1"
  local dest="$2"
  local abs
  abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  if ! extract_ar "$abs" "$dest"; then
    echo "check-release-text: ar is required to unpack a deb" >&2
    return 1
  fi
  local has_control=0 has_data=0 candidate
  for candidate in "$dest"/control.tar*; do [[ -f "$candidate" ]] && has_control=1; done
  for candidate in "$dest"/data.tar*; do [[ -f "$candidate" ]] && has_data=1; done
  if [[ "$has_control" -eq 0 || "$has_data" -eq 0 ]]; then
    echo "check-release-text: deb is missing its control or data archive" >&2
    return 1
  fi
}

# A drag-to-install DMG holds an absolute Applications symlink. 7-Zip skips
# it with a "Dangerous link path was ignored" error and exits 2. That skip is
# what we want (never follow it out of the temp dir), so only that error is
# tolerated; any other error still fails the scan.
run_7z_dmg() {
  local tool="$1"
  local file="$2"
  local dest="$3"
  local out rc=0
  out="$("$tool" x -y "-o$dest" "$file" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  local errors
  errors="$(printf '%s\n' "$out" | grep -E '^ERROR:' || true)"
  if [ "$rc" -eq 2 ] && [ -n "$errors" ] &&
    ! printf '%s\n' "$errors" | grep -qvE '^ERROR: Dangerous link path was ignored : [^:]+ : /Applications$'; then
    return 0
  fi
  printf '%s\n' "$out" >&2
  return "$rc"
}

unpack_dmg() {
  local file="$1"
  local dest="$2"
  if command -v 7z >/dev/null 2>&1; then
    run_7z_dmg 7z "$file" "$dest"
    return $?
  fi
  if command -v 7za >/dev/null 2>&1; then
    run_7z_dmg 7za "$file" "$dest"
    return $?
  fi
  return 1
}

decompress_one() {
  local kind="$1"
  local file="$2"
  local out="$3"
  case "$kind" in
    gzip) command -v gzip >/dev/null 2>&1 && gzip -dc "$file" >"$out" ;;
    bzip2) command -v bzip2 >/dev/null 2>&1 && bzip2 -dc "$file" >"$out" ;;
    xz) command -v xz >/dev/null 2>&1 && xz -dc "$file" >"$out" ;;
    zstd) command -v zstd >/dev/null 2>&1 && zstd -dcq "$file" >"$out" ;;
    *) return 1 ;;
  esac
}

unpack_and_scan() {
  local display="$1"
  local file="$2"
  local kind="$3"
  local dest inner rel found=0 tar_links=""
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
    tar)
      # Read link targets from the archive. Creating those symlinks fails on
      # Windows when the process cannot create them, which would hide the target.
      tar_links="$(mktemp "$tmp/tarlinks.XXXXXX")"
      if ! python3 - "$file" "$tar_links" <<'PY'
import sys
import tarfile

source, output = sys.argv[1:]
with tarfile.open(source) as archive, open(output, "w", encoding="utf-8", newline="\n") as handle:
    for member in archive:
        if member.issym() or member.islnk():
            handle.write(member.name + "\n")
            handle.write((member.linkname or "") + "\n")
PY
      then
        echo "check-release-text: could not read tar link targets: $display" >&2
        fail=1
        return 0
      fi
      if ! python3 - "$file" "$dest" <<'PY'
import os
import sys
import tarfile

source, dest = sys.argv[1:]
root = os.path.realpath(dest)
with tarfile.open(source) as archive:
    for member in archive:
        if not member.isreg():
            continue
        parts = member.name.split("/")
        if member.name.startswith("/") or ".." in parts:
            raise SystemExit("refusing tar path " + member.name)
        target = os.path.realpath(os.path.join(root, *parts))
        if os.path.commonpath([root, target]) != root:
            raise SystemExit("refusing tar path " + member.name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        extracted = archive.extractfile(member)
        if extracted is None:
            continue
        with open(target, "wb") as handle:
            handle.write(extracted.read())
PY
      then
        echo "check-release-text: could not unpack tar: $display" >&2
        fail=1
        return 0
      fi
      ;;
    dmg)
      if ! unpack_dmg "$file" "$dest"; then
        record_strings "$display" "$file"
        return 0
      fi
      ;;
    gzip | bzip2 | xz | zstd)
      if ! decompress_one "$kind" "$file" "$dest/decompressed"; then
        echo "check-release-text: could not decompress $kind: $display" >&2
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
  # Entry names, symlink targets and ZIP comments can carry text too.
  local meta link
  meta="$(mktemp "$tmp/meta.XXXXXX")"
  if [[ -n "$tar_links" && -f "$tar_links" ]]; then
    cat "$tar_links" >>"$meta"
    rm -f "$tar_links"
  fi
  if [[ "$kind" == zip ]]; then
    if ! python3 - "$file" >>"$meta" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    print(archive.comment.decode("utf-8", "replace"))
    for info in archive.infolist():
        print(info.filename)
        print(info.comment.decode("utf-8", "replace"))
PY
    then
      echo "check-release-text: could not read zip metadata: $display" >&2
      fail=1
    fi
  fi
  while IFS= read -r inner; do
    rel="${inner#"$dest"/}"
    printf '%s\n' "$rel" >>"$meta"
    if [[ -L "$inner" ]]; then
      if ! link="$(readlink "$inner")"; then
        echo "check-release-text: could not read symlink: $display:$rel" >&2
        fail=1
        continue
      fi
      printf '%s\n' "$link" >>"$meta"
    fi
  done < <(find "$dest" -mindepth 1)
  record_text "$display (names)" "$meta"
  rm -f "$meta"
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
  format="$(artifact_format "$file")"
  case "$format" in
    text) record_text "$display" "$file" ;;
    deb | zip | tar | dmg | gzip | bzip2 | xz | zstd) unpack_and_scan "$display" "$file" "$format" ;;
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

# Without --deep: asset names, and contents only of text assets. Names are
# recorded one per line under "<dir> (asset names)", so a hit prints a line
# number rather than the name itself.
scan_artifacts_shallow() {
  local display="$1"
  shift
  local names file
  names="$(mktemp "$tmp/names.XXXXXX")"
  for file in "$@"; do
    basename "$file" >>"$names"
  done
  record_text "$display (asset names)" "$names"
  rm -f "$names"
  for file in "$@"; do
    if [[ "$(artifact_format "$file")" == text ]]; then
      record_text "$file" "$file"
    fi
  done
}

scan_artifact_path() {
  local path="$1"
  if [[ "$deep" -eq 0 ]]; then
    local file
    if [[ -d "$path" ]]; then
      local files=()
      while IFS= read -r file; do
        files+=("$file")
      done < <(find "$path" -type f | LC_ALL=C sort)
      if [[ ${#files[@]} -eq 0 ]]; then
        echo "check-release-text: artifact directory is empty: $path" >&2
        fail=1
      else
        scan_artifacts_shallow "$path" "${files[@]}"
      fi
    elif [[ -f "$path" ]]; then
      scan_artifacts_shallow "$(dirname "$path")" "$path"
    else
      echo "check-release-text: artifact is missing: $path" >&2
      fail=1
    fi
    return 0
  fi
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
