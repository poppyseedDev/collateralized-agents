#!/bin/zsh
# Example hook: trade a Proof of Agent position through a running Hummingbot Gateway.
# Sells part of the principal into USDC on Orca, holds, and buys it all back so the
# position is in SOL again before the runner settles.
#
# Env from the runner: POA_PRINCIPAL_SOL, POA_SETTLE_BY, POA_WALLET, POA_PAPER
# Config (env): GATEWAY_URL, GATEWAY_NETWORK (solana-devnet | solana-mainnet-beta),
#               POOL (Orca whirlpool), SOL_MINT, USDC_MINT, TRADE_SHARE (0-1), HOLD_SECS
set -euo pipefail
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:15888}"
GATEWAY_NETWORK="${GATEWAY_NETWORK:-solana-devnet}"
POOL="${POOL:-2WUgXbAmhquXMLhqqUthztDaVYnG8Mmp57CkXNb5ym9G}"
SOL_MINT="${SOL_MINT:-So11111111111111111111111111111111111111112}"
USDC_MINT="${USDC_MINT:-BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k}"
TRADE_SHARE="${TRADE_SHARE:-0.5}"
HOLD_SECS="${HOLD_SECS:-60}"

log() { echo "[hummingbot-hook] $*"; }
# Values reach python through the environment, never spliced into its source or into JSON.
py() { python3 -c "$1"; }
# sell <amount> of <tokenIn> for <tokenOut>. Always SELL with the input token as base:
# the Gateway's BUY side takes the amount of the *output* token, which is easy to get wrong.
sell() { # tokenIn tokenOut amount
  local body
  body=$(T_IN="$1" T_OUT="$2" AMOUNT="$3" py 'import json,os
print(json.dumps({"chainNetwork": os.environ["GATEWAY_NETWORK"], "connector": "orca", "walletAddress": os.environ["POA_WALLET"],
  "baseToken": os.environ["T_IN"], "quoteToken": os.environ["T_OUT"], "amount": float(os.environ["AMOUNT"]),
  "side": "SELL", "poolAddress": os.environ["POOL"], "slippagePct": 2}))')
  curl -sS -X POST "$GATEWAY_URL/trading/clmm/execute-swap" -H 'content-type: application/json' -d "$body"
}
usdc_balance() {
  local body
  body=$(py 'import json,os
print(json.dumps({"network": os.environ["GATEWAY_NETWORK"].removeprefix("solana-"), "address": os.environ["POA_WALLET"], "tokens": [os.environ["USDC_MINT"]]}))')
  curl -sS -X POST "$GATEWAY_URL/chains/solana/balances" -H 'content-type: application/json' -d "$body" \
    | py 'import sys,json; b=json.load(sys.stdin)["balances"]; print(next(iter(b.values()), 0))'
}
export GATEWAY_NETWORK POA_WALLET POOL USDC_MINT
USDC_BEFORE=$(usdc_balance)   # only what this position buys gets sold back
unwind() {
  local u
  u=$(BAL="$(usdc_balance)" BEFORE="$USDC_BEFORE" py 'import os; print(max(0.0, round(float(os.environ["BAL"]) - float(os.environ["BEFORE"]), 6)))')
  if U="$u" py 'import os,sys; sys.exit(0 if float(os.environ["U"]) > 0.000001 else 1)'; then
    log "selling $u USDC back into SOL"
    sell "$USDC_MINT" "$SOL_MINT" "$u" | head -c 300; echo
  fi
}
trap 'log "asked to stop, unwinding"; unwind; exit 0' TERM INT

if [ "${POA_PAPER:-0}" = "1" ]; then log "paper mode: not trading"; exit 0; fi

SELL=$(P="$POA_PRINCIPAL_SOL" S="$TRADE_SHARE" py 'import os; print(round(float(os.environ["P"]) * float(os.environ["S"]), 4))')
log "selling $SELL of $POA_PRINCIPAL_SOL SOL into USDC on $POOL"
sell "$SOL_MINT" "$USDC_MINT" "$SELL" | head -c 300; echo

# hold until HOLD_SECS or 90s before the runner's settle time, whichever is first
until_ts=$(( $(date +%s) + HOLD_SECS ))
[ "$until_ts" -gt $(( POA_SETTLE_BY - 90 )) ] && until_ts=$(( POA_SETTLE_BY - 90 ))
while [ "$(date +%s)" -lt "$until_ts" ]; do sleep 5; done

unwind
log "done"
