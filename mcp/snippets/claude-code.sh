# Hosted endpoint, no wallet (place_order returns unsigned payment data):
AGENTCOIN_URL="${AGENTCOIN_URL:-https://agentcoinhq.com}"   # default service URL
claude mcp add --transport http agentcoin "$AGENTCOIN_URL/mcp"
# Local server with a testnet wallet:
claude mcp add agentcoin-wallet -e AGENTCOIN_PRIVATE_KEY=0x<testnet key> -e AGENTCOIN_MAX_PAYMENT=50000 -- node /ABSOLUTE/PATH/agentcoin-public/mcp/dist/bin.js
