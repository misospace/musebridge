#!/usr/bin/env bash
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
cd "$top"

status=0
while IFS= read -r -d '' file; do
  if [ -L "$file" ] || [ ! -f "$file" ] || [ ! -s "$file" ]; then
    continue
  fi
  if ! grep -Iq -- '' "$file"; then
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
