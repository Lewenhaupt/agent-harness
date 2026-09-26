#!/usr/bin/env bash
# belayd-direnv-setup — idempotently ensure direnv's config has a [whitelist]
# prefix array containing the requested prefixes, without destroying anything
# else in the file.
#
# A whitelisted prefix makes direnv trust every .envrc beneath it
# *content-independently*: treat each prefix as a standing arbitrary-code-
# execution grant. Keep the list as narrow as possible.
#
# Never fails the unit: malformed input warns on stderr and exits 0.
#
# Parser limitations (no full TOML engine is available in the runtime env):
# this is a handmade parser for the single shape we care about — a
# `prefix = [...]` array inside a `[whitelist]` table, in either single-line
# or multi-line form. It is quote-aware: `[`, `]`, `,` and `#` inside TOML
# basic ("...") or literal ('...') strings are data, and `\"`/`\\` escapes
# are honoured in basic strings. It tolerates `#` comments on the table header
# line, on array lines, and after the closing `]`, and interior whitespace in
# the table brackets (`[ whitelist ]`). The table header line is preserved
# verbatim; only prefix entries are rewritten.
#
# The parser is deliberately conservative: any shape it cannot model leaves
# the file untouched and warns. Shapes rejected as malformed (exit 3):
#   * a nested array or inline table inside the prefix array body
#     (`[ ["/a"], "/b"]`, `[{p = "/a"}]`) — would otherwise be rewritten
#     into invalid TOML;
#   * non-whitespace between `=` and the array, or trailing tokens after the
#     closing `]`;
#   * a multi-line or single-line array that never closes, or a line that
#     ends inside a string (basic/literal strings cannot span lines);
#   * an unrecognized `[` line while inside `[whitelist]` (e.g. a quoted table
#     key containing `]`).
# Shapes rejected as unsupported (exit 5, also left untouched), because they
# already define the whitelist table/prefix in a form that appending a new
# `[whitelist]`/`prefix` key would duplicate:
#   * a quoted table key equal to whitelist (`["whitelist"]`);
#   * an array of tables named whitelist (`[[whitelist]]`, `[[whitelist.x]]`);
#   * a top-level `whitelist` key/dotted key/inline table (`whitelist = ...`,
#     `whitelist.prefix = ...`);
#   * a quoted or dotted `prefix` key inside `[whitelist]` (`"prefix" = ...`,
#     `prefix.x = ...`);
#   * more than one `[whitelist]` table header.
set -u

toml="${XDG_CONFIG_HOME:-$HOME/.config}/direnv/direnv.toml"
prefixes=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --toml)
      [ "$#" -ge 2 ] || { printf 'belayd-direnv-setup: --toml needs a value\n' >&2; exit 2; }
      toml="$2"
      shift 2
      ;;
    --toml=*)
      toml="${1#--toml=}"
      shift
      ;;
    --prefix)
      [ "$#" -ge 2 ] || { printf 'belayd-direnv-setup: --prefix needs a value\n' >&2; exit 2; }
      prefixes+=("$2")
      shift 2
      ;;
    --prefix=*)
      prefixes+=("${1#--prefix=}")
      shift
      ;;
    *)
      printf 'belayd-direnv-setup: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [ "${#prefixes[@]}" -eq 0 ]; then
  exit 0
fi

work="$(mktemp -d)" || { printf 'belayd-direnv-setup: cannot create temp dir\n' >&2; exit 0; }
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# Pass 1: collect existing prefixes inside the [whitelist] table, one per line.
# Multi-line `prefix = [...]` arrays are folded together; the table header may
# carry a trailing comment. A non-array value, an array that never closes, or a
# duplicated `prefix` key marks the file malformed and it is left untouched.
cat > "$work/collect.awk" <<'AWK'
# TOML string-aware scanning. We only accept `prefix = [ ... ]` whose entries
# are TOML basic ("...", honouring `\"`/`\\` escapes) or literal ('...', no
# escapes) strings. Structural `[`/`]`/`,`/`#` inside a string are data, not
# syntax, so index()-style byte matching corrupts files like
# `prefix = ["/home/x/[bracket]/git"]`. Basic/literal strings cannot span
# lines, so a line that ends inside one is malformed.
function structural_index(s, start, target,   i, n, c, state) {
  n = length(s)
  state = ""
  for (i = start; i <= n; i++) {
    c = substr(s, i, 1)
    if (state == "\"") {
      if (c == "\\") { i++; continue }
      if (c == "\"") state = ""
      continue
    }
    if (state == "'") {
      if (c == "'") state = ""
      continue
    }
    if (c == "\"") { state = "\""; continue }
    if (c == "'") { state = "'"; continue }
    if (c == target) return i
    # A `#` outside a string opens a comment running to end of line, so any
    # structural character it contains (e.g. `]`) is text, not syntax. The
    # target check above still returns the `#` itself when that is what the
    # caller is looking for.
    if (c == "#") {
      while (i <= n && substr(s, i, 1) != "\n") i++
      continue
    }
  }
  return 0
}
function header_name(line,   s) {
  s = line
  sub(/^[[:space:]]*\[/, "", s)
  sub(/\][[:space:]]*(#.*)?$/, "", s)
  # TOML allows whitespace inside the brackets (`[ whitelist ]`); collapse it
  # so the same table is recognized however it is spaced.
  gsub(/[[:space:]]/, "", s)
  return s
}
function strip_quotes(s) {
  if (s ~ /^".*"$/) {
    s = substr(s, 2, length(s) - 2)
    gsub(/\\"/, "\"", s)
    gsub(/\\\\/, "\\", s)
    return s
  }
  if (s ~ /^'.*'$/) return substr(s, 2, length(s) - 2)
  return s
}
# The key a table header names, independent of quoting/whitespace. Used only to
# detect a whitelist table written in a shape the parser does not model (a
# quoted key), never to treat it as the supported table.
function norm_key(name,   s) {
  s = strip_quotes(name)
  gsub(/[[:space:]]/, "", s)
  return s
}
function emit_token(tok) {
  sub(/^[[:space:]]+/, "", tok)
  sub(/[[:space:]]+$/, "", tok)
  if (tok != "") print tok
}
function emit(text,   i, n, c, state, cur, tail) {
  n = length(text)
  state = ""
  cur = ""
  for (i = 2; i <= n; i++) {          # text[1] is the opening "["
    c = substr(text, i, 1)
    if (state == "\"") {
      if (c == "\\") {
        i++
        c = substr(text, i, 1)
        if (c == "\"" || c == "\\") cur = cur c
        else cur = cur "\\" c
        continue
      }
      if (c == "\"") { state = ""; continue }
      cur = cur c
      continue
    }
    if (state == "'") {
      if (c == "'") { state = ""; continue }
      cur = cur c
      continue
    }
    if (c == "\"") { state = "\""; continue }
    if (c == "'") { state = "'"; continue }
    if (c == "#") {
      while (i <= n && substr(text, i, 1) != "\n") i++
      continue
    }
    if (c == ",") { emit_token(cur); cur = ""; continue }
    if (c == "]") {
      # The array's own closer. Only whitespace or a trailing comment may
      # follow it; a second structural token means the value is not the simple
      # array shape this parser models, so bail rather than corrupt it.
      tail = substr(text, i + 1)
      sub(/^[[:space:]]*/, "", tail)
      if (tail != "" && substr(tail, 1, 1) != "#") malformed = 1
      emit_token(cur)
      return
    }
    # A structural bracket/brace inside the array body is a nested array or an
    # inline table. Rewriting such a value would produce invalid TOML.
    if (c == "[" || c == "{" || c == "}") { malformed = 1; continue }
    cur = cur c
  }
  # EOF without a structural "]": an unterminated array or string.
  malformed = 1
}
BEGIN { inwl = 0; collecting = 0; assigns = 0; malformed = 0; dup = 0; arr = ""; wl_tables = 0; tables_seen = 0; unsupported = 0 }
$0 ~ /^[[:space:]]*\[[^]]+\][[:space:]]*(#.*)?$/ {
  if (collecting) { malformed = 1; collecting = 0 }
  tables_seen++
  name = header_name($0)
  if (name == "whitelist") {
    wl_tables++
    inwl = 1
  } else {
    # A quoted key naming whitelist is the same table in a shape we cannot
    # merge; flag it so a second [whitelist] table is never appended.
    if (norm_key(name) == "whitelist") unsupported = 1
    inwl = 0
  }
  next
}
collecting {
  arr = arr "\n" $0
  if (structural_index($0, 1, "]") > 0) { collecting = 0; emit(arr) }
  next
}
# Array-of-tables named whitelist defines the table in an unsupported shape.
$0 ~ /^[[:space:]]*\[\[[[:space:]]*whitelist([[:space:]]*\.[^]]*)?[[:space:]]*\]\]/ { unsupported = 1; next }
# A top-level dotted/direct `whitelist` key creates the table in a shape we do
# not model; appending [whitelist] afterwards would duplicate the definition.
tables_seen == 0 && !inwl && $0 ~ /^[[:space:]]*whitelist[[:space:]]*(\.|=)/ { unsupported = 1; next }
# Inside the whitelist table, a quoted or dotted `prefix` key means the key we
# would insert already exists in a shape we cannot merge.
inwl && ($0 ~ /^[[:space:]]*"prefix"[[:space:]]*=/ || $0 ~ /^[[:space:]]*'prefix'[[:space:]]*=/ || $0 ~ /^[[:space:]]*prefix[[:space:]]*\./) { unsupported = 1; next }
inwl && $0 ~ /^[[:space:]]*prefix[[:space:]]*=/ {
  assigns++
  if (assigns > 1) { dup = 1; next }
  eq = index($0, "=")
  rest = substr($0, eq + 1)
  oi = structural_index(rest, 1, "[")
  if (oi == 0) { malformed = 1; next }
  # Only whitespace may sit between `=` and the array opening `[`.
  lead = substr(rest, 1, oi - 1)
  gsub(/[[:space:]]/, "", lead)
  if (lead != "") malformed = 1
  arr = substr(rest, oi)
  if (structural_index(arr, 1, "]") == 0) { collecting = 1 } else { emit(arr) }
  next
}
# Any other line opening `[` while inside [whitelist] might be a new table or a
# quoted key we cannot parse; be conservative rather than corrupt the file.
inwl && $0 ~ /^[[:space:]]*\[/ { malformed = 1 }
END {
  if (collecting) malformed = 1
  if (wl_tables > 1) unsupported = 1
  if (malformed) exit 3
  if (dup) exit 4
  if (unsupported) exit 5
}
AWK

has_whitelist_table=0
if grep -Eq '^[[:space:]]*\[[[:space:]]*whitelist[[:space:]]*\][[:space:]]*(#.*)?$' "$toml" 2>/dev/null; then
  has_whitelist_table=1
fi

existing_raw=""
if [ -e "$toml" ] && [ -s "$toml" ]; then
  existing_raw="$(awk -f "$work/collect.awk" "$toml")"
  rc=$?
  if [ "$rc" = "3" ]; then
    printf 'belayd-direnv-setup: %s has a malformed [whitelist] prefix entry; leaving it untouched\n' "$toml" >&2
    exit 0
  fi
  if [ "$rc" = "4" ]; then
    printf 'belayd-direnv-setup: %s declares more than one [whitelist] prefix key; leaving it untouched\n' "$toml" >&2
    exit 0
  fi
  if [ "$rc" = "5" ]; then
    printf 'belayd-direnv-setup: %s defines [whitelist] in an unsupported shape; leaving it untouched\n' "$toml" >&2
    exit 0
  fi
  if [ "$rc" != "0" ]; then
    printf 'belayd-direnv-setup: could not parse %s; leaving it untouched\n' "$toml" >&2
    exit 0
  fi
fi

existing=()
if [ -n "$existing_raw" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    dup=0
    for e in ${existing[@]+"${existing[@]}"}; do
      if [ "$e" = "$p" ]; then dup=1; break; fi
    done
    [ "$dup" = 1 ] || existing+=("$p")
  done <<< "$existing_raw"
fi

missing=()
for p in "${prefixes[@]}"; do
  found=0
  for e in ${existing[@]+"${existing[@]}"}; do
    if [ "$e" = "$p" ]; then found=1; break; fi
  done
  for m in ${missing[@]+"${missing[@]}"}; do
    if [ "$m" = "$p" ]; then found=1; break; fi
  done
  [ "$found" = 1 ] || missing+=("$p")
done

# Idempotent: every requested prefix already present, nothing to write.
if [ "${#missing[@]}" -eq 0 ]; then
  exit 0
fi

toml_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# The full generated array line, used only when creating a brand-new file or
# appending a new [whitelist] table.
all=(${existing[@]+"${existing[@]}"} ${missing[@]+"${missing[@]}"})
line="prefix = ["
first=1
for p in ${all[@]+"${all[@]}"}; do
  if [ "$first" = 1 ]; then first=0; else line="$line, "; fi
  line="$line$(toml_quote "$p")"
done
line="$line]"

# Pass 2 needs only the missing entries (existing ones stay in place).
: > "$work/missing.txt"
for p in "${missing[@]}"; do
  printf '%s\n' "$p" >> "$work/missing.txt"
done

# Missing file: create it with a short header explaining the caveat.
if [ ! -e "$toml" ] || [ ! -s "$toml" ]; then
  mkdir -p "$(dirname "$toml")"
  {
    printf '# Managed by belayd-direnv-setup. Each whitelisted prefix grants\n'
    printf '# arbitrary code execution for every .envrc beneath it.\n'
    printf '[whitelist]\n'
    printf '%s\n' "$line"
  } > "$work/out.toml"
  tmp="$(mktemp "$(dirname "$toml")/.direnv.toml.XXXXXX")" || exit 0
  cp "$work/out.toml" "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$toml"
  exit 0
fi

if [ "$has_whitelist_table" = 1 ]; then
  # Insert the missing entries into the existing array in place, so existing
  # entries and the file's formatting survive untouched. When the table has no
  # prefix key yet, merge.awk inserts a fresh `prefix = [...]` line.
  cat > "$work/merge.awk" <<'AWK'
# TOML string-aware scanning, mirroring collect.awk: only `]`, `,` and `#`
# outside a basic ("...", with `\"`/`\\` escapes) or literal ('...') string
# are structural, so a quoted path containing `]`/`#`/`,` does not corrupt the
# rewritten array.
function structural_index(s, start, target,   i, n, c, state) {
  n = length(s)
  state = ""
  for (i = start; i <= n; i++) {
    c = substr(s, i, 1)
    if (state == "\"") {
      if (c == "\\") { i++; continue }
      if (c == "\"") state = ""
      continue
    }
    if (state == "'") {
      if (c == "'") state = ""
      continue
    }
    if (c == "\"") { state = "\""; continue }
    if (c == "'") { state = "'"; continue }
    if (c == target) return i
    # Mirror collect.awk: a `#` outside a string comments out the rest of the
    # line, so a `]` inside a comment does not close the array.
    if (c == "#") {
      while (i <= n && substr(s, i, 1) != "\n") i++
      continue
    }
  }
  return 0
}
function comment_index(s) {
  return structural_index(s, 1, "#")
}
function header_name(line,   s) {
  s = line
  sub(/^[[:space:]]*\[/, "", s)
  sub(/\][[:space:]]*(#.*)?$/, "", s)
  # TOML allows whitespace inside the brackets (`[ whitelist ]`); collapse it
  # so the same table is recognized however it is spaced.
  gsub(/[[:space:]]/, "", s)
  return s
}
function toml_quote(s) {
  gsub(/\\/, "\\\\", s)
  gsub(/"/, "\\\"", s)
  return "\"" s "\""
}
function joined(   s, i) {
  s = ""
  for (i = 1; i <= nmiss; i++) {
    if (i > 1) s = s ", "
    s = s toml_quote(missing[i])
  }
  return s
}
# Append \r to a generated line when the source uses CRLF, so inserted lines
# match the file instead of introducing a bare \n ending. Existing lines are
# printed verbatim and keep whatever ending they already carry.
function eol(s) {
  if (crlf) return s "\r"
  return s
}
# Insert a trailing comma while keeping a CR at end-of-line in place, so a
# CRLF file is not turned into a mixed-ending one.
function with_comma(s, h,   cr, body) {
  cr = ""
  if (crlf && s ~ /\r$/) { cr = "\r"; s = substr(s, 1, length(s) - 1) }
  if (h > 0) body = substr(s, 1, h - 1) "," substr(s, h)
  else body = s ","
  return body cr
}
BEGIN {
  nmiss = 0
  while ((getline p < missingfile) > 0) {
    if (p != "") { nmiss++; missing[nmiss] = p }
  }
  close(missingfile)

  nlines = 0
  while ((getline l) > 0) { nlines++; lines[nlines] = l }
  close("")

  # Detect the file's dominant line ending from the first line so generated
  # entries can match it.
  crlf = (nlines > 0 && lines[1] ~ /\r$/)

  wl_start = 0
  for (i = 1; i <= nlines; i++) {
    if (lines[i] ~ /^[[:space:]]*\[[^]]+\][[:space:]]*(#.*)?$/ && header_name(lines[i]) == "whitelist") {
      wl_start = i
      break
    }
  }
  if (wl_start == 0) {
    for (i = 1; i <= nlines; i++) print lines[i]
    exit
  }
  wl_end = nlines
  for (i = wl_start + 1; i <= nlines; i++) {
    if (lines[i] ~ /^[[:space:]]*\[[^]]+\][[:space:]]*(#.*)?$/) { wl_end = i - 1; break }
  }

  prefix_start = 0
  prefix_end = 0
  for (i = wl_start + 1; i <= wl_end; i++) {
    if (lines[i] ~ /^[[:space:]]*prefix[[:space:]]*=/) {
      prefix_start = i
      if (structural_index(lines[i], 1, "]") > 0) {
        prefix_end = i
      } else {
        j = i
        while (j < wl_end && structural_index(lines[j], 1, "]") == 0) j++
        prefix_end = j
      }
      break
    }
  }

  if (prefix_start == 0) {
    # No prefix key yet: insert one right after the table header.
    idx = 0
    for (i = 1; i <= nlines; i++) {
      out[++idx] = lines[i]
      if (i == wl_start) out[++idx] = eol("prefix = [" joined() "]")
    }
    for (i = 1; i <= idx; i++) print out[i]
    exit
  }

  if (prefix_start == prefix_end) {
    line = lines[prefix_start]
    eq = index(line, "=")
    ci = eq + structural_index(substr(line, eq + 1), 1, "]")
    before = substr(line, 1, ci - 1)
    after = substr(line, ci + 1)
    trimmed = before
    sub(/[[:space:]]+$/, "", trimmed)
    sep = ", "
    if (trimmed ~ /[,\[]$/) sep = ""
    lines[prefix_start] = before sep joined() "]" after
  } else {
    last = 0
    for (i = prefix_end - 1; i > prefix_start; i--) {
      t = lines[i]
      sub(/^[[:space:]]*/, "", t)
      if (t == "" || t ~ /^#/) continue
      last = i
      break
    }
    indent = "  "
    if (last > 0) {
      indent = lines[last]
      sub(/[^[:space:]].*$/, "", indent)
      # A trailing comma is optional TOML; add one before appending entries.
      # A quoted path may contain `#`, so locate the real comment start.
      t = lines[last]
      h = comment_index(t)
      noComment = t
      if (h > 0) noComment = substr(t, 1, h - 1)
      if (noComment !~ /,[[:space:]]*$/) {
        lines[last] = with_comma(t, h)
      }
    }
    idx = 0
    for (i = 1; i <= nlines; i++) {
      if (i == prefix_end) {
        for (m = 1; m <= nmiss; m++) out[++idx] = eol(indent toml_quote(missing[m]) ",")
      }
      out[++idx] = lines[i]
    }
    for (i = 1; i <= idx; i++) print out[i]
    exit
  }

  for (i = 1; i <= nlines; i++) print lines[i]
}
AWK
  awk -v missingfile="$work/missing.txt" -f "$work/merge.awk" "$toml" > "$work/out.toml"
else
  # No [whitelist] table yet: append one at the end, preserving all existing
  # lines.
  cp "$toml" "$work/out.toml"
  {
    printf '\n[whitelist]\n'
    printf '%s\n' "$line"
  } >> "$work/out.toml"
fi

if cmp -s "$toml" "$work/out.toml"; then
  exit 0
fi

mode="$(stat -c '%a' "$toml")"
tmp="$(mktemp "$(dirname "$toml")/.direnv.toml.XXXXXX")" || exit 0
cp "$work/out.toml" "$tmp"
chmod "$mode" "$tmp"
mv -f "$tmp" "$toml"
