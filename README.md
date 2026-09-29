# Rail MCP

Rail is a budget, approval and receipt layer that agents call when they buy something on a human's behalf, dry-run by default, wrapping Stripe Link for settlement rather than issuing cards.

It is not a marketplace, storefront, or outreach tool. Rail owns the budget, the approval gate, and the receipt ledger.

## Quickstart

Requires Node.js 20+. Run the published package with `npx -y rail-mcp`. Default mode is dry-run: no network and no charges.

**Claude Desktop** and any other host that takes an `mcpServers` block:

```json
{
  "mcpServers": {
    "rail": {
      "command": "npx",
      "args": ["-y", "rail-mcp"]
    }
  }
}
```

**Cursor:** one-click install ([install links](https://cursor.com/docs/mcp/install-links)). The `config` value is the base64 of `{"command":"npx","args":["-y","rail-mcp"]}`.

[Install Rail in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=rail&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJhaWwtbWNwIl19)

```
cursor://anysphere.cursor-deeplink/mcp/install?name=rail&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJhaWwtbWNwIl19
```

**Grok Bot:** add a custom MCP with `npx -y rail-mcp`.

Do not put Stripe or Link secrets (`STRIPE_SECRET_KEY`, `LINK_ACCESS_TOKEN`, or live-spend flags) in this shared snippet. Real charges stay off unless those gates are set on purpose, outside the shared config. See [Stripe Link seam](#stripe-link-seam).

Ledger files (`budget.json`, `proposals.json`, `receipts.json`) are written to `./data` under the process working directory, or to `RAIL_DATA_DIR` when that is set. They are local state, not part of the npm package.

## Example

Set a budget, propose a purchase, have a human approve it, then read the receipt. Dry-run moves no money off the machine.

1. `set_budget` → `{ "amount_usd": 50, "note": "week1" }`
2. `propose_purchase` → `{ "merchant": "Acme", "amount_usd": 12, "rationale": "need widgets" }`
3. `get_budget` still shows remaining `50.00` and `open_proposals: 1`. The proposal is pending until a human decides.
4. `decide_proposal` → `{ "proposal_id": "prop_…", "decision": "approve" }`
5. `get_receipts` returns one `settled_dry_run` receipt with a `settlement_ref`. Remaining budget is `38.00`.

Rejecting spends nothing. `refund_receipt` reverses a dry-run settlement and restores the budget.

## Tools

| Tool | Purpose |
|------|---------|
| `set_budget` | Overwrite the local budget limit. Moves no money |
| `get_budget` | Read budget, spent, remaining, open proposals count |
| `propose_purchase` | Record a pending intent only. Moves no money. Needs a later human approval |
| `list_proposals` | Read proposals by `pending` (default) / `approved` / `rejected` / `all` |
| `decide_proposal` | Human confirmation step. `approve` settles (dry-run receipt + `settlement_ref`, remaining decremented). `reject` spends nothing. No double-decide |
| `get_receipts` | Read receipts, newest first |
| `refund_receipt` | Human confirmation step. Reverse a dry-run settlement and restore budget |

## Permission model

Proposing a purchase is cheap. Settling one is not. An agent may record intent without moving money. The human should confirm the call that settles a purchase or reverses a receipt.

Hosts should read `title`, `description`, and `annotations` from `tools/list`. Every hint is set explicitly. The spec defaults (`readOnlyHint` false, `destructiveHint` true, `openWorldHint` true) would otherwise treat every tool as a destructive open-world write. Rail's ledger is local. Default mode is dry-run: no network and no charge.

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Host should |
|------|--------------|-----------------|----------------|---------------|-------------|
| `set_budget` | false | false | true | false | Allow. Overwrites the local limit only. The same arguments do not stack or spend |
| `get_budget` | true | false | true | false | Allow. Read-only |
| `propose_purchase` | false | false | false | false | Allow. Adds one pending intent and spends nothing. Each call creates a new proposal |
| `list_proposals` | true | false | true | false | Allow. Read-only |
| `decide_proposal` | false | true | true | false | Confirm with the human. `approve` settles and decrements remaining budget. A repeat does not settle again |
| `get_receipts` | true | false | true | false | Allow. Read-only |
| `refund_receipt` | false | true | true | false | Confirm with the human. Reverses a dry-run settlement and restores budget. A repeat does not refund again |

`destructiveHint` is the confirmation signal, and it is true only for `decide_proposal` and `refund_receipt`. `openWorldHint` is false on every tool: dry-run never leaves the ledger, and live Link stays behind separate environment gates. Annotations are hints for the host. They do not themselves move money.

Mode defaults to `RAIL_MODE=dry_run`. Money is stored as integer cents; tools display USD with 2 decimals. IDs: `prop_…`, `rcpt_…`, dry-run Link refs `lsrq_dry_…` on `settlement_ref`.

## Local checkout

`tsx` is a dev dependency for dogfood in this repo. `npm run smoke` runs the TypeScript sources directly and does not need a build. `npm start` compiles first, then runs `dist/index.js` (the same file the `rail-mcp` bin points at).

```bash
npm install
npm start          # tsc → dist/, then stdio MCP server
npm run dev        # tsx watch src/index.ts
npm run smoke      # dry-run ledger smoke test; throwaway dir only (never ./data or RAIL_DATA_DIR)
```

`npm run smoke` forces `RAIL_MODE=dry_run`, never enables live charge gates, and writes the ledger only under a temporary directory it creates and deletes. `./data` and `RAIL_DATA_DIR` are left untouched even when `RAIL_DATA_DIR` is set in the environment.

## Stripe Link seam

Rail asks Link for a one-time credential. Rail still decides budget and policy and writes the receipt. This seam does not issue cards and does not render UI.

- **`RAIL_MODE=dry_run`** (default, including when unset): `createSpendRequest` returns a fake Link spend-request id and status `dry_run_pending_human`. No Stripe or Link HTTP. Approve stores that id as `settlement_ref` on a `settled_dry_run` receipt and decrements remaining budget.
- **`RAIL_MODE=live` without gates:** throws `live mode not enabled — set keys and get explicit human approval` unless **both** `STRIPE_SECRET_KEY` and `RAIL_LIVE=1` are set. The proposal stays pending and no receipt is written.
- **Live with those two gates:** the `POST https://api.link.com/spend_requests` body is scaffolded only (see `src/stripeLink.ts`). Nothing is sent unless `RAIL_ALLOW_LIVE_CHARGE=1`.
- **`RAIL_ALLOW_LIVE_CHARGE=1`:** the only branch allowed to call Link, and only if `LINK_ACCESS_TOKEN` is also set. `STRIPE_SECRET_KEY` is a presence gate and is never sent. There is no Stripe Issuing card create. Docs: [Link CLI](https://docs.stripe.com/agentic-commerce/link-cli), [link-cli](https://github.com/stripe/link-cli), [Issuing for agents](https://docs.stripe.com/issuing/agents).
- Live spend stays off until those env vars are set on purpose. A posted Link request is stored as `link_pending_human` and does not decrement the dry-run budget. CI and `npm run smoke` stay on dry-run and do not charge.

| Env | Role |
|-----|------|
| `RAIL_MODE` | `dry_run` (default) or `live` |
| `RAIL_DATA_DIR` | Ledger directory. Default is `./data` from the process working directory |
| `STRIPE_SECRET_KEY` | Required for live. Not used to issue cards or as a Link bearer token |
| `RAIL_LIVE=1` | Explicit live approval alongside the secret key |
| `RAIL_ALLOW_LIVE_CHARGE=1` | Additional gate before any Link HTTP |
| `LINK_ACCESS_TOKEN` | Link OAuth token. Required before the scaffolded POST actually runs |

## Explicit non-goals

- No marketplace UI
- No outreach / messaging
- No card issuing
- No real charges in dry-run, CI, or smoke

## License

[MIT](LICENSE). Copyright 2026 Thomas Stockham.
