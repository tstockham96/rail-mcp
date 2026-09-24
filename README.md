# Rail MCP

**Rail** is an agent spend-and-settle layer: agents buy on a human's behalf under an explicit budget, with a propose→approve gate and a receipts/refunds ledger. It is **not** a marketplace, storefront, or outreach tool. Rail wraps Stripe Link for credentials and owns budget, policy, and receipts. It does not issue cards. Default mode is **dry-run** (no network, no charges).

## Install

Works in Cursor, Claude Desktop, and any other stdio MCP host. Requires Node.js 20+. The published package runs compiled JavaScript (`dist/`); end users do not need `tsx`.

```json
{
  "mcpServers": {
    "rail": {
      "command": "npx",
      "args": ["-y", "@rail-mcp/server"]
    }
  }
}
```

`RAIL_MODE` defaults to `dry_run`. Never put Stripe or Link secrets (`STRIPE_SECRET_KEY`, `LINK_ACCESS_TOKEN`, or live-spend flags) in this shared snippet. Real charges stay off unless those gates are set on purpose, outside the shared config. See [Stripe Link seam](#stripe-link-seam).

**Grok Bot:** add a custom MCP via `npx -y @rail-mcp/server`.

**Cursor:** one-click install from the deeplink below ([install links](https://cursor.com/docs/mcp/install-links)). The `config` value is the base64 of `{"command":"npx","args":["-y","@rail-mcp/server"]}`.

[Install Rail in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=rail&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkByYWlsLW1jcC9zZXJ2ZXIiXX0=)

```
cursor://anysphere.cursor-deeplink/mcp/install?name=rail&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkByYWlsLW1jcC9zZXJ2ZXIiXX0=
```

Ledger files (`budget.json`, `proposals.json`, `receipts.json`) are written to `./data` under the process working directory, or to `RAIL_DATA_DIR` when that is set. They are local state, not part of the npm package.

### Local checkout

`tsx` is a dev dependency for dogfood in this repo. `npm run smoke` runs the TypeScript sources directly and does not need a build. `npm start` compiles first, then runs `dist/index.js` (the same file the `rail-mcp` bin points at).

```bash
npm install
npm start          # tsc → dist/, then stdio MCP server
npm run dev        # tsx watch src/index.ts
npm run smoke      # ledger smoke test (no MCP client, dry-run, no network)
```

## Tools

| Tool | Purpose |
|------|---------|
| `set_budget` | Overwrite active budget (`amount_usd`, optional `currency`, `note`) |
| `get_budget` | Budget, spent, remaining, open proposals count |
| `propose_purchase` | Create pending proposal; flags `over_budget` if needed; does **not** spend |
| `list_proposals` | Filter by `pending` (default) / `approved` / `rejected` / `all` |
| `decide_proposal` | `approve` → dry-run receipt (`settled_dry_run` + `settlement_ref`) and decrement remaining; `reject` → no spend; no double-decide |
| `get_receipts` | Newest first |
| `refund_receipt` | Mark refunded, restore budget (dry-run) |

Mode defaults to `RAIL_MODE=dry_run`. Money is stored as integer cents; tools display USD with 2 decimals. IDs: `prop_…`, `rcpt_…`, dry-run Link refs `lsrq_dry_…` on `settlement_ref`.

## Dogfood walkthrough

1. `set_budget` → `{ "amount_usd": 50, "note": "week1" }`
2. `propose_purchase` → `{ "merchant": "Acme", "amount_usd": 12, "rationale": "need widgets" }`
3. `get_budget` → remaining still `50.00`, `open_proposals: 1`
4. `decide_proposal` → `{ "proposal_id": "prop_…", "decision": "approve" }`
5. `get_receipts` → one `settled_dry_run` receipt with `settlement_ref`; remaining `38.00`
6. Optional: `refund_receipt` → budget restored

## Stripe Link seam

Rail asks Link for a one-time credential. Rail still decides budget and policy and writes the receipt. This seam does not issue cards and does not render UI.

- **`RAIL_MODE=dry_run`** (default, including when unset): `createSpendRequest` returns a fake Link spend-request id and status `dry_run_pending_human`. No Stripe or Link HTTP. Approve stores that id as `settlement_ref` on a `settled_dry_run` receipt and decrements remaining budget.
- **`RAIL_MODE=live` without gates:** throws `live mode not enabled — set keys and get explicit human approval` unless **both** `STRIPE_SECRET_KEY` and `RAIL_LIVE=1` are set. The proposal stays pending and no receipt is written.
- **Live with those two gates:** the `POST https://api.link.com/spend_requests` body is scaffolded only (see `src/stripeLink.ts`). Nothing is sent unless `RAIL_ALLOW_LIVE_CHARGE=1`.
- **`RAIL_ALLOW_LIVE_CHARGE=1`:** the only branch allowed to call Link, and only if `LINK_ACCESS_TOKEN` is also set. `STRIPE_SECRET_KEY` is a presence gate and is never sent. There is no Stripe Issuing card create. Docs: [Link CLI](https://docs.stripe.com/agentic-commerce/link-cli), [link-cli](https://github.com/stripe/link-cli), [Issuing for agents](https://docs.stripe.com/issuing/agents).
- **Thomas has to explicitly enable live spend** by setting those env vars on purpose. A posted Link request is stored as `link_pending_human` and does not decrement the dry-run budget. CI and `npm run smoke` stay on dry-run and do not charge.

| Env | Role |
|-----|------|
| `RAIL_MODE` | `dry_run` (default) or `live` |
| `RAIL_DATA_DIR` | Ledger directory. Default is `./data` from the process working directory |
| `STRIPE_SECRET_KEY` | Required for live. Not used to issue cards or as a Link bearer token |
| `RAIL_LIVE=1` | Explicit live approval alongside the secret key |
| `RAIL_ALLOW_LIVE_CHARGE=1` | Additional gate before any Link HTTP |
| `LINK_ACCESS_TOKEN` | Link OAuth token. Required before the scaffolded POST actually runs |

## Explicit non-goals (this wedge)

- No marketplace UI
- No outreach / messaging
- No card issuing
- No real charges in dry-run, CI, or smoke

## License

Install from npm as `@rail-mcp/server`. No license file is included in 0.1.0. Publishing the package does not make this GitHub repository public.
