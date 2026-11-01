#!/usr/bin/env bash
# Runs one example live on Base Sepolia with a testnet key read from a file (never printed).
# usage: examples/run-live.sh <key-file> <example file>    e.g. examples/run-live.sh ~/my-base-sepolia-test-key.txt examples/langchain_py.py
set -euo pipefail
cd "$(dirname "$0")/.."
key_file="$1"; ex="$2"
export AGENTCOIN_PRIVATE_KEY="$(tr -d '[:space:]' < "$key_file")"
export AGENTCOIN_ORIGIN=agentcoin
case "$ex" in
  *.py) exec python/.venv/bin/python "$ex" ;;
  *.ts) exec node "$ex" ;;
esac
