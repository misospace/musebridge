#!/usr/bin/env bash
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
cd "$top"

status=0
while IFS= read -r -d '' file; do
  if [ -L "$file" ] || [ ! -f "$file" ] || [ ! -s "$file" ]; then
    continue
  fi
  # Binary detection must read the whole file: a NUL byte anywhere in it marks the
  # file binary, so a matcher that exits on the first hit would misclassify a file
  # whose NUL byte sits after the first line.
  nul_bytes="$(LC_ALL=C tr -dc '\000' < "$file" | LC_ALL=C wc -c)"
  if [ "$nul_bytes" -gt 0 ]; then
    continue
  fi
  if [ -n "$(tail -c 1 -- "$file")" ]; then
    printf 'trailing newline missing: %s\n' "$file"
    status=1
  fi
done < <(git ls-files -z)

if [ "$status" -ne 0 ]; then
  printf '%s\n' 'error: fix the files above so each ends with a trailing newline' >&2
fi
exit "$status"
