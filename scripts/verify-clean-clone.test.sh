#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/scripts"
cp scripts/verify-clean-clone.sh "$scratch/scripts/"
mkdir "$scratch/backend"
expect_usage_error() {
  local expected=$1
  shift
  local status=0 output
  output=$(bash "$scratch/scripts/verify-clean-clone.sh" "$@" 2>&1) || status=$?
  [[ "$status" == 2 && "$output" == *"$expected"* ]] || {
    echo "Unexpected status $status: $output" >&2
    exit 1
  }
}
expect_usage_error 'Usage:' --production
expect_usage_error 'at most one option' --testnet-smoke extra
touch "$scratch/backend/.env.local"
expect_usage_error 'backend/.env.local'
expect_usage_error 'backend/.env.local' --testnet-smoke
