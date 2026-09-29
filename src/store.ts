import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createSpendRequest, railMode, type RailMode } from './stripeLink.js';

let dataDirOverride: string | undefined;

function envDataDir(): string | undefined {
  const override = process.env.RAIL_DATA_DIR?.trim();
  return override ? path.resolve(override) : undefined;
}

/**
 * Per-user ledger. Independent of the process working directory, so a host
 * that launches the server from `/` does not try to create `/data`.
 */
function defaultDataDir(): string {
  return path.join(os.homedir(), '.rail');
}

/**
 * Ledger directory.
 * `setDataDirForTests` wins when a test has pinned a throwaway dir.
 * Otherwise `RAIL_DATA_DIR`, or `~/.rail` under the user home directory.
 */
export function getDataDir(): string {
  if (dataDirOverride) return dataDirOverride;
  return envDataDir() ?? defaultDataDir();
}

/**
 * Pin the ledger at a throwaway directory for tests.
 * Refuses `~/.rail`, `./data`, and `RAIL_DATA_DIR` so a test cannot write the real ledger.
 */
export function setDataDirForTests(dir: string): void {
  const resolved = path.resolve(dir);
  const cwdData = path.resolve(process.cwd(), 'data');
  const fromEnv = envDataDir();
  const userDefault = defaultDataDir();
  if (resolved === cwdData || resolved === fromEnv || resolved === userDefault) {
    throw new Error(
      'setDataDirForTests refused: directory must not be ~/.rail, ./data, or RAIL_DATA_DIR',
    );
  }
  dataDirOverride = resolved;
}

export type Mode = RailMode;

function mode(): Mode {
  return railMode();
}

export interface Budget {
  amount_cents: number;
  currency: string;
  note?: string;
  updated_at: string;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  url?: string;
  rationale?: string;
  sku?: string;
  status: ProposalStatus;
  over_budget: boolean;
  decide_note?: string;
  created_at: string;
  decided_at?: string;
}

export type ReceiptStatus = 'settled_dry_run' | 'link_pending_human' | 'refunded';

export interface Receipt {
  id: string;
  proposal_id: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  status: ReceiptStatus;
  mode: Mode;
  /** Link spend-request id from the settlement seam (fake in dry_run). */
  settlement_ref: string;
  created_at: string;
  refunded_at?: string;
  refund_reason?: string;
}

interface ProposalsFile {
  proposals: Proposal[];
}

interface ReceiptsFile {
  receipts: Receipt[];
}

function usd(cents: number): string {
  return (cents / 100).toFixed(2);
}

function toCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function newId(prefix: 'prop' | 'rcpt'): string {
  return `${prefix}_${nanoid(12)}`;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  await ensureDataDir();
  const p = path.join(getDataDir(), file);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const p = path.join(getDataDir(), file);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
}

async function loadBudget(): Promise<Budget | null> {
  return readJson<Budget | null>('budget.json', null);
}

async function loadProposals(): Promise<Proposal[]> {
  const f = await readJson<ProposalsFile>('proposals.json', { proposals: [] });
  return f.proposals;
}

async function loadReceipts(): Promise<Receipt[]> {
  const f = await readJson<ReceiptsFile>('receipts.json', { receipts: [] });
  return f.receipts;
}

function spentCents(receipts: Receipt[]): number {
  return receipts
    .filter((r) => r.status === 'settled_dry_run')
    .reduce((sum, r) => sum + r.amount_cents, 0);
}

function remainingCents(budget: Budget | null, receipts: Receipt[]): number | null {
  if (!budget) return null;
  return budget.amount_cents - spentCents(receipts);
}

function publicBudget(budget: Budget | null, receipts: Receipt[], openProposals: number) {
  if (!budget) {
    return {
      ok: true as const,
      mode: mode(),
      budget: null,
      spent_usd: '0.00',
      remaining_usd: null,
      open_proposals: openProposals,
    };
  }
  const spent = spentCents(receipts);
  const remaining = budget.amount_cents - spent;
  return {
    ok: true as const,
    mode: mode(),
    budget: {
      amount_usd: usd(budget.amount_cents),
      currency: budget.currency,
      note: budget.note ?? null,
      updated_at: budget.updated_at,
    },
    spent_usd: usd(spent),
    remaining_usd: usd(remaining),
    open_proposals: openProposals,
  };
}

export async function setBudget(args: {
  amount_usd: number;
  currency?: string;
  note?: string;
}) {
  if (!Number.isFinite(args.amount_usd) || args.amount_usd < 0) {
    return { ok: false as const, error: 'amount_usd must be a non-negative number' };
  }
  const budget: Budget = {
    amount_cents: toCents(args.amount_usd),
    currency: args.currency ?? 'USD',
    note: args.note,
    updated_at: new Date().toISOString(),
  };
  await writeJson('budget.json', budget);
  const receipts = await loadReceipts();
  const proposals = await loadProposals();
  const open = proposals.filter((p) => p.status === 'pending').length;
  return publicBudget(budget, receipts, open);
}

export async function getBudget() {
  const budget = await loadBudget();
  const receipts = await loadReceipts();
  const proposals = await loadProposals();
  const open = proposals.filter((p) => p.status === 'pending').length;
  return publicBudget(budget, receipts, open);
}

export async function proposePurchase(args: {
  merchant: string;
  amount_usd: number;
  url?: string;
  rationale?: string;
  sku?: string;
}) {
  if (!args.merchant?.trim()) {
    return { ok: false as const, error: 'merchant is required' };
  }
  if (!Number.isFinite(args.amount_usd) || args.amount_usd <= 0) {
    return { ok: false as const, error: 'amount_usd must be a positive number' };
  }

  const amount_cents = toCents(args.amount_usd);
  const budget = await loadBudget();
  const receipts = await loadReceipts();
  const remaining = remainingCents(budget, receipts);
  const over_budget = remaining === null ? false : amount_cents > remaining;

  const proposal: Proposal = {
    id: newId('prop'),
    merchant: args.merchant.trim(),
    amount_cents,
    currency: budget?.currency ?? 'USD',
    url: args.url,
    rationale: args.rationale,
    sku: args.sku,
    status: 'pending',
    over_budget,
    created_at: new Date().toISOString(),
  };

  const proposals = await loadProposals();
  proposals.push(proposal);
  await writeJson('proposals.json', { proposals });

  return {
    ok: true as const,
    mode: mode(),
    proposal: {
      id: proposal.id,
      merchant: proposal.merchant,
      amount_usd: usd(proposal.amount_cents),
      currency: proposal.currency,
      url: proposal.url ?? null,
      rationale: proposal.rationale ?? null,
      sku: proposal.sku ?? null,
      status: proposal.status,
      over_budget: proposal.over_budget,
      created_at: proposal.created_at,
    },
    remaining_usd: remaining === null ? null : usd(remaining),
  };
}

export async function listProposals(args: {
  status?: 'pending' | 'approved' | 'rejected' | 'all';
} = {}) {
  const status = args.status ?? 'pending';
  const proposals = await loadProposals();
  const filtered =
    status === 'all' ? proposals : proposals.filter((p) => p.status === status);

  return {
    ok: true as const,
    mode: mode(),
    status_filter: status,
    count: filtered.length,
    proposals: filtered.map((p) => ({
      id: p.id,
      merchant: p.merchant,
      amount_usd: usd(p.amount_cents),
      currency: p.currency,
      url: p.url ?? null,
      rationale: p.rationale ?? null,
      sku: p.sku ?? null,
      status: p.status,
      over_budget: p.over_budget,
      decide_note: p.decide_note ?? null,
      created_at: p.created_at,
      decided_at: p.decided_at ?? null,
    })),
  };
}

export async function decideProposal(args: {
  proposal_id: string;
  decision: 'approve' | 'reject';
  note?: string;
}) {
  const proposals = await loadProposals();
  const idx = proposals.findIndex((p) => p.id === args.proposal_id);
  if (idx < 0) {
    return { ok: false as const, error: `proposal not found: ${args.proposal_id}` };
  }
  const proposal = proposals[idx]!;
  if (proposal.status !== 'pending') {
    return {
      ok: false as const,
      error: `proposal already decided as ${proposal.status}`,
      proposal_id: proposal.id,
      status: proposal.status,
    };
  }

  if (args.decision === 'reject') {
    proposal.status = 'rejected';
    proposal.decide_note = args.note;
    proposal.decided_at = new Date().toISOString();
    proposals[idx] = proposal;
    await writeJson('proposals.json', { proposals });
    return {
      ok: true as const,
      mode: mode(),
      decision: 'reject' as const,
      proposal: {
        id: proposal.id,
        status: proposal.status,
        decided_at: proposal.decided_at,
        decide_note: proposal.decide_note ?? null,
      },
      receipt: null,
    };
  }

  // Approve: proposal is still pending. over_budget stays advisory.
  // Settlement goes through the Link seam (dry_run does not touch the network).
  let spend;
  try {
    spend = await createSpendRequest({
      merchant: proposal.merchant,
      amountCents: proposal.amount_cents,
      currency: proposal.currency,
      proposalId: proposal.id,
      url: proposal.url,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'createSpendRequest failed';
    return { ok: false as const, error: message };
  }

  const dryRun = mode() === 'dry_run';
  if (dryRun && spend.status !== 'dry_run_pending_human') {
    return {
      ok: false as const,
      error: 'dry_run spend request missing dry_run_pending_human — receipt not written',
    };
  }
  if (!dryRun && spend.status !== 'live_pending_human') {
    return {
      ok: false as const,
      error: 'live spend request was not accepted — receipt not written',
    };
  }

  const receipt: Receipt = {
    id: newId('rcpt'),
    proposal_id: proposal.id,
    merchant: proposal.merchant,
    amount_cents: proposal.amount_cents,
    currency: proposal.currency,
    // Dry-run ledger settlement only. A live Link request is still awaiting
    // the human in Link and does not decrement budget.
    status: dryRun ? 'settled_dry_run' : 'link_pending_human',
    mode: dryRun ? 'dry_run' : 'live',
    settlement_ref: spend.settlement_ref,
    created_at: new Date().toISOString(),
  };

  proposal.status = 'approved';
  proposal.decide_note = args.note;
  proposal.decided_at = receipt.created_at;
  proposals[idx] = proposal;

  const receipts = await loadReceipts();
  receipts.push(receipt);

  await writeJson('proposals.json', { proposals });
  await writeJson('receipts.json', { receipts });

  const budget = await loadBudget();
  const remaining = remainingCents(budget, receipts);

  return {
    ok: true as const,
    mode: mode(),
    decision: 'approve' as const,
    proposal: {
      id: proposal.id,
      status: proposal.status,
      decided_at: proposal.decided_at,
      decide_note: proposal.decide_note ?? null,
    },
    receipt: {
      id: receipt.id,
      proposal_id: receipt.proposal_id,
      merchant: receipt.merchant,
      amount_usd: usd(receipt.amount_cents),
      currency: receipt.currency,
      status: receipt.status,
      mode: receipt.mode,
      settlement_ref: receipt.settlement_ref,
      created_at: receipt.created_at,
    },
    remaining_usd: remaining === null ? null : usd(remaining),
  };
}

export async function getReceipts(args: { limit?: number } = {}) {
  const limit = args.limit ?? 50;
  const receipts = await loadReceipts();
  const sorted = [...receipts].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  const slice = sorted.slice(0, Math.max(0, limit));

  return {
    ok: true as const,
    mode: mode(),
    count: slice.length,
    receipts: slice.map((r) => ({
      id: r.id,
      proposal_id: r.proposal_id,
      merchant: r.merchant,
      amount_usd: usd(r.amount_cents),
      currency: r.currency,
      status: r.status,
      mode: r.mode,
      settlement_ref: r.settlement_ref,
      created_at: r.created_at,
      refunded_at: r.refunded_at ?? null,
      refund_reason: r.refund_reason ?? null,
    })),
  };
}

export async function refundReceipt(args: { receipt_id: string; reason?: string }) {
  const receipts = await loadReceipts();
  const idx = receipts.findIndex((r) => r.id === args.receipt_id);
  if (idx < 0) {
    return { ok: false as const, error: `receipt not found: ${args.receipt_id}` };
  }
  const receipt = receipts[idx]!;
  if (receipt.status === 'refunded') {
    return {
      ok: false as const,
      error: 'receipt already refunded',
      receipt_id: receipt.id,
    };
  }
  if (receipt.status !== 'settled_dry_run') {
    return {
      ok: false as const,
      error: `cannot refund receipt in status ${receipt.status}`,
      receipt_id: receipt.id,
    };
  }
  if (mode() !== 'dry_run') {
    return { ok: false as const, error: `unsupported mode: ${mode()}` };
  }

  // Live Link reversals are not wired. Dry-run refunds only restore the local ledger.
  receipt.status = 'refunded';
  receipt.refunded_at = new Date().toISOString();
  receipt.refund_reason = args.reason;
  receipts[idx] = receipt;
  await writeJson('receipts.json', { receipts });

  const budget = await loadBudget();
  const remaining = remainingCents(budget, receipts);

  return {
    ok: true as const,
    mode: mode(),
    receipt: {
      id: receipt.id,
      proposal_id: receipt.proposal_id,
      merchant: receipt.merchant,
      amount_usd: usd(receipt.amount_cents),
      currency: receipt.currency,
      status: receipt.status,
      refunded_at: receipt.refunded_at,
      refund_reason: receipt.refund_reason ?? null,
    },
    remaining_usd: remaining === null ? null : usd(remaining),
  };
}

/** Wipe ledger files in the test directory. Refuses to run against the real ledger. */
export async function resetStoreForTests(): Promise<void> {
  if (!dataDirOverride) {
    throw new Error(
      'resetStoreForTests refused: call setDataDirForTests with a throwaway directory first',
    );
  }
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  for (const file of ['budget.json', 'proposals.json', 'receipts.json']) {
    try {
      await fs.unlink(path.join(dir, file));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
}
