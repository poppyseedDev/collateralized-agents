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
# sell <amount> of <tokenIn> for <tokenOut>. Always SELL with the input token as base:
# the Gateway's BUY side takes the amount of the *output* token, which is easy to get wrong.
sell() { # tokenIn tokenOut amount
  curl -sS -X POST "$GATEWAY_URL/trading/clmm/execute-swap" -H 'content-type: application/json' \
    -d "{\"chainNetwork\":\"$GATEWAY_NETWORK\",\"connector\":\"orca\",\"walletAddress\":\"$POA_WALLET\",\"baseToken\":\"$1\",\"quoteToken\":\"$2\",\"amount\":$3,\"side\":\"SELL\",\"poolAddress\":\"$POOL\",\"slippagePct\":2}"
}
usdc_balance() {
  curl -sS -X POST "$GATEWAY_URL/chains/solana/balances" -H 'content-type: application/json' \
    -d "{\"network\":\"${GATEWAY_NETWORK#solana-}\",\"address\":\"$POA_WALLET\",\"tokens\":[\"$USDC_MINT\"]}" \
    | python3 -c 'import sys,json; b=json.load(sys.stdin)["balances"]; print(next(iter(b.values()), 0))'
}
USDC_BEFORE=$(usdc_balance)   # only what this position buys gets sold back
unwind() {
  local u; u=$(python3 -c "print(max(0.0, round(float('$(usdc_balance)') - float('$USDC_BEFORE'), 6)))")
  if python3 -c "import sys; sys.exit(0 if float('$u') > 0.000001 else 1)"; then
    log "selling $u USDC back into SOL"
    sell "$USDC_MINT" "$SOL_MINT" "$u" | head -c 300; echo
  fi
}
trap 'log "asked to stop, unwinding"; unwind; exit 0' TERM INT

if [ "${POA_PAPER:-0}" = "1" ]; then log "paper mode: not trading"; exit 0; fi

SELL=$(python3 -c "print(round(float('$POA_PRINCIPAL_SOL') * float('$TRADE_SHARE'), 4))")
log "selling $SELL of $POA_PRINCIPAL_SOL SOL into USDC on $POOL"
sell "$SOL_MINT" "$USDC_MINT" "$SELL" | head -c 300; echo

# hold until HOLD_SECS or 90s before the runner's settle time, whichever is first
until_ts=$(( $(date +%s) + HOLD_SECS ))
[ "$until_ts" -gt $(( POA_SETTLE_BY - 90 )) ] && until_ts=$(( POA_SETTLE_BY - 90 ))
while [ "$(date +%s)" -lt "$until_ts" ]; do sleep 5; done

unwind
log "done"
