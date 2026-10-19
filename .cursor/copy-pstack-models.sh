#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="${root}/.cursor/rules/pstack-models.mdc"

if [[ ! -f "${src}" ]]; then
  echo "pstack model rule missing: ${src}" >&2
  exit 1
fi

mkdir -p "${HOME}/.cursor/rules"
cp "${src}" "${HOME}/.cursor/rules/pstack-models.mdc"
