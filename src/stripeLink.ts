import { nanoid } from 'nanoid';

/**
 * Stripe Link settlement seam.
 *
 * Rail is the spend-and-settle layer: it owns budget, policy, and receipts.
 * Link would supply one-time payment credentials after a human approves a
 * spend request. This module does not issue cards (no Stripe Issuing card
 * create) and does not call the network in the default dry-run mode.
 *
 * Docs the live call shape points at:
 * - Link CLI / spend requests: https://docs.stripe.com/agentic-commerce/link-cli
 * - link-cli `spend-request create`: https://github.com/stripe/link-cli
 * - Issuing for agents (Link's underlying rails — do not reissue cards here):
 *   https://docs.stripe.com/issuing/agents
 */

export type RailMode = 'dry_run' | 'live';

export const LIVE_MODE_NOT_ENABLED =
  'live mode not enabled — set keys and get explicit human approval';

export interface CreateSpendRequestInput {
  merchant: string;
  amountCents: number;
  currency: string;
  proposalId: string;
  url?: string;
}

export type SpendRequestStatus = 'dry_run_pending_human' | 'live_pending_human';

export interface SpendRequest {
  /** Link spend-request id. Dry-run ids are local fakes (`lsrq_dry_…`). */
  id: string;
  status: SpendRequestStatus;
  /** Copied onto the Rail receipt. Same value as `id` in dry_run. */
  settlement_ref: string;
}

/** Link `POST /spend_requests` body. Built for review; not sent by default. */
export interface LinkSpendRequestCall {
  method: 'POST';
  url: 'https://api.link.com/spend_requests';
  body: {
    merchant_name: string;
    merchant_url: string | null;
    amount: number;
    currency: string;
    context: string;
    request_approval: true;
    metadata: { rail_proposal_id: string };
  };
}

export function railMode(): RailMode {
  return process.env.RAIL_MODE === 'live' ? 'live' : 'dry_run';
}

function requireLiveGates(): void {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || process.env.RAIL_LIVE !== '1') {
    throw new Error(LIVE_MODE_NOT_ENABLED);
  }
}

/**
 * Call shape for a Link spend request. Rail does not create Issuing cards.
 * Auth on a real call would be `Authorization: Bearer $LINK_ACCESS_TOKEN`
 * (Link OAuth), not a Stripe secret key used as a card issuer.
 *
 * link-cli equivalent:
 *   link-cli spend-request create \
 *     --merchant-name "<merchant>" \
 *     --merchant-url "<url>" \
 *     --amount <amountCents> \
 *     --currency <currency> \
 *     --context "<context>" \
 *     --request-approval
 */
export function scaffoldLinkSpendRequest(
  input: CreateSpendRequestInput,
): LinkSpendRequestCall {
  const context = [
    `Rail proposal ${input.proposalId} requested ${input.amountCents} cents ${input.currency}`,
    `at ${input.merchant}.`,
    input.url ? `Checkout URL: ${input.url}.` : 'No checkout URL was provided.',
    'Rail keeps the budget, the policy decision, and the receipt.',
    'Link would release a one-time credential only after the human approves this spend request.',
  ].join(' ');

  return {
    method: 'POST',
    url: 'https://api.link.com/spend_requests',
    body: {
      merchant_name: input.merchant,
      merchant_url: input.url ?? null,
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      context,
      request_approval: true,
      metadata: { rail_proposal_id: input.proposalId },
    },
  };
}

function linkSpendRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * POST the scaffolded Link spend request.
 * Reachable only when RAIL_ALLOW_LIVE_CHARGE=1 and LINK_ACCESS_TOKEN is set.
 * STRIPE_SECRET_KEY is never sent. This does not call Stripe Issuing.
 *
 * https://docs.stripe.com/agentic-commerce/link-cli
 * https://github.com/stripe/link-cli
 * https://docs.stripe.com/issuing/agents
 */
async function postLinkSpendRequest(call: LinkSpendRequestCall): Promise<SpendRequest> {
  const linkToken = process.env.LINK_ACCESS_TOKEN?.trim();
  if (!linkToken) {
    throw new Error(
      `live Link spend request scaffolded but not sent (${call.method} ${call.url}). No charge was made.`,
    );
  }

  // link-cli: `spend-request create --request-approval` → POST /spend_requests
  const response = await fetch(call.url, {
    method: call.method,
    headers: {
      Authorization: `Bearer ${linkToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(call.body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Link spend request failed (${response.status}). No Rail receipt was settled.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Link spend request returned non-JSON. No Rail receipt was settled.');
  }

  const id = linkSpendRequestId(parsed);
  if (!id) {
    throw new Error('Link spend request response missing id. No Rail receipt was settled.');
  }

  return {
    id,
    status: 'live_pending_human',
    settlement_ref: id,
  };
}

/**
 * Create a Link spend request.
 *
 * - `RAIL_MODE=dry_run` (default): fake id, status `dry_run_pending_human`, no network.
 * - `RAIL_MODE=live` without both `STRIPE_SECRET_KEY` and `RAIL_LIVE=1`: throws
 *   `LIVE_MODE_NOT_ENABLED`.
 * - Live with those gates: scaffold only. No HTTP unless `RAIL_ALLOW_LIVE_CHARGE=1`
 *   and `LINK_ACCESS_TOKEN` are both set. The Stripe secret is a gate, not a card issuer.
 */
export async function createSpendRequest(
  input: CreateSpendRequestInput,
): Promise<SpendRequest> {
  if (railMode() !== 'live') {
    const id = `lsrq_dry_${nanoid(12)}`;
    return {
      id,
      status: 'dry_run_pending_human',
      settlement_ref: id,
    };
  }

  requireLiveGates();

  const call = scaffoldLinkSpendRequest(input);

  if (process.env.RAIL_ALLOW_LIVE_CHARGE !== '1') {
    throw new Error(
      `live charge blocked — set RAIL_ALLOW_LIVE_CHARGE=1 only after Thomas explicitly enables live spend. No request was sent (${call.method} ${call.url}).`,
    );
  }

  return postLinkSpendRequest(call);
}
