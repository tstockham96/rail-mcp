# Rail MCP

**Rail** is an agent spend-and-settle layer: agents buy on a human's behalf under an explicit budget, with a propose→approve gate and a receipts/refunds ledger. It is **not** a marketplace, storefront, or outreach tool — just the money path between an agent and a human's approval. This week-1 wedge is **dry-run only** (no real money, no Stripe yet).

## Install (Cursor)

Add to your Cursor MCP config (e.g. `~/.cursor/mcp.json` or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "rail": {
      "command": "npx",
      "args": ["tsx", "/workspace/rail-mcp/src/index.ts"],
      "env": {
        "RAIL_MODE": "dry_run"
      }
    }
  }
}
```

Or with an absolute `node`+`tsx` path after `npm install` in this directory:

```json
{
  "mcpServers": {
    "rail": {
      "command": "/workspace/rail-mcp/node_modules/.bin/tsx",
      "args": ["/workspace/rail-mcp/src/index.ts"],
      "cwd": "/workspace/rail-mcp",
      "env": {
        "RAIL_MODE": "dry_run"
      }
    }
  }
}
```

Replace `/workspace/rail-mcp` with your local clone path.

## Setup

```bash
cd /workspace/rail-mcp
npm install
npm start          # stdio MCP server
npm run smoke      # ledger smoke test (no MCP client)
```

State lives in `./data/` (`budget.json`, `proposals.json`, `receipts.json`) — gitignored.

## Tools

| Tool | Purpose |
|------|---------|
| `set_budget` | Overwrite active budget (`amount_usd`, optional `currency`, `note`) |
| `get_budget` | Budget, spent, remaining, open proposals count |
| `propose_purchase` | Create pending proposal; flags `over_budget` if needed; does **not** spend |
| `list_proposals` | Filter by `pending` (default) / `approved` / `rejected` / `all` |
| `decide_proposal` | `approve` → dry-run receipt + decrement remaining; `reject` → no spend; no double-decide |
| `get_receipts` | Newest first |
| `refund_receipt` | Mark refunded, restore budget (dry-run) |

Mode is hardcoded via `RAIL_MODE=dry_run`. Money is stored as integer cents; tools display USD with 2 decimals. IDs: `prop_…`, `rcpt_…`.

## Dogfood walkthrough

1. `set_budget` → `{ "amount_usd": 50, "note": "week1" }`
2. `propose_purchase` → `{ "merchant": "Acme", "amount_usd": 12, "rationale": "need widgets" }`
3. `get_budget` → remaining still `50.00`, `open_proposals: 1`
4. `decide_proposal` → `{ "proposal_id": "prop_…", "decision": "approve" }`
5. `get_receipts` → one `settled_dry_run` receipt; remaining `38.00`
6. Optional: `refund_receipt` → budget restored

## Explicit non-goals (this wedge)

- No marketplace UI
- No outreach / messaging
- No real charges — dry-run settlement only
- Stripe Link credentials/settle is a later seam (`// TODO: stripe link` in code)

## License

Private / local use.
