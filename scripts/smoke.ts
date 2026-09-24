import { LIVE_MODE_NOT_ENABLED } from '../src/stripeLink.js';
import {
  decideProposal,
  getBudget,
  getReceipts,
  listProposals,
  proposePurchase,
  refundReceipt,
  resetStoreForTests,
  setBudget,
} from '../src/store.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main() {
  process.env.RAIL_MODE = 'dry_run';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RAIL_LIVE;
  delete process.env.RAIL_ALLOW_LIVE_CHARGE;
  delete process.env.LINK_ACCESS_TOKEN;

  let networkCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('smoke: network is forbidden');
  }) as typeof fetch;

  try {
    await runSmoke(() => networkCalls);
    if (networkCalls !== 0) {
      throw new Error(`FAIL: smoke made ${networkCalls} network call(s)`);
    }
  } finally {
    globalThis.fetch = previousFetch;
    process.env.RAIL_MODE = 'dry_run';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.RAIL_LIVE;
    delete process.env.RAIL_ALLOW_LIVE_CHARGE;
    delete process.env.LINK_ACCESS_TOKEN;
  }
}

async function runSmoke(networkCalls: () => number) {
  await resetStoreForTests();

  console.log('1) set_budget 50');
  const b1 = await setBudget({ amount_usd: 50, note: 'smoke' });
  console.log(JSON.stringify(b1, null, 2));
  assert(b1.ok && b1.budget?.amount_usd === '50.00', 'budget 50');
  assert(b1.remaining_usd === '50.00', 'remaining 50');

  console.log('\n2) propose_purchase 12');
  const p = await proposePurchase({
    merchant: 'Acme Widgets',
    amount_usd: 12,
    rationale: 'smoke test',
    sku: 'W-1',
  });
  console.log(JSON.stringify(p, null, 2));
  assert(p.ok && p.proposal, 'proposal created');
  assert(p.proposal!.over_budget === false, 'not over budget');
  assert(p.proposal!.status === 'pending', 'pending');
  const proposalId = p.proposal!.id;

  console.log('\n3) get_budget (open proposals = 1, spent still 0)');
  const b2 = await getBudget();
  console.log(JSON.stringify(b2, null, 2));
  assert(b2.open_proposals === 1, 'one open proposal');
  assert(b2.spent_usd === '0.00', 'not spent yet');
  assert(b2.remaining_usd === '50.00', 'remaining unchanged');

  console.log('\n4) decide_proposal approve');
  const d = await decideProposal({
    proposal_id: proposalId,
    decision: 'approve',
    note: 'ok for smoke',
  });
  console.log(JSON.stringify(d, null, 2));
  assert(d.ok && d.decision === 'approve', 'approved');
  assert(d.receipt?.status === 'settled_dry_run', 'dry-run receipt');
  assert(d.remaining_usd === '38.00', 'remaining 38');
  assert(
    typeof d.receipt?.settlement_ref === 'string' && d.receipt.settlement_ref.startsWith('lsrq_dry_'),
    'settlement_ref after approve',
  );
  const receiptId = d.receipt!.id;
  const settlementRef = d.receipt!.settlement_ref;

  console.log('\n5) refuse double-decide');
  const d2 = await decideProposal({ proposal_id: proposalId, decision: 'reject' });
  console.log(JSON.stringify(d2, null, 2));
  assert(!d2.ok, 'double-decide refused');

  console.log('\n6) get_receipts shows one');
  const r = await getReceipts({ limit: 10 });
  console.log(JSON.stringify(r, null, 2));
  assert(r.count === 1, 'one receipt');
  assert(r.receipts[0]!.id === receiptId, 'same receipt id');
  assert(r.receipts[0]!.settlement_ref === settlementRef, 'ledger settlement_ref');

  console.log('\n7) list_proposals approved');
  const lp = await listProposals({ status: 'approved' });
  console.log(JSON.stringify(lp, null, 2));
  assert(lp.count === 1 && lp.proposals[0]!.id === proposalId, 'approved listed');

  console.log('\n8) refund_receipt restores budget');
  const rf = await refundReceipt({ receipt_id: receiptId, reason: 'smoke refund' });
  console.log(JSON.stringify(rf, null, 2));
  assert(rf.ok && rf.receipt?.status === 'refunded', 'refunded');
  assert(rf.remaining_usd === '50.00', 'budget restored to 50');

  console.log('\n9) get_budget after refund');
  const b3 = await getBudget();
  console.log(JSON.stringify(b3, null, 2));
  assert(b3.spent_usd === '0.00', 'spent zero after refund');
  assert(b3.remaining_usd === '50.00', 'remaining 50 after refund');

  console.log('\n10) live mode cannot settle without explicit gates');
  const pLive = await proposePurchase({ merchant: 'No Charge Inc', amount_usd: 1 });
  assert(pLive.ok && pLive.proposal, 'live-gate proposal');
  const liveProposalId = pLive.proposal!.id;
  const callsBeforeLive = networkCalls();

  process.env.RAIL_MODE = 'live';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RAIL_LIVE;
  delete process.env.RAIL_ALLOW_LIVE_CHARGE;

  const noKeys = await decideProposal({ proposal_id: liveProposalId, decision: 'approve' });
  assert(!noKeys.ok, 'live without keys refused');
  if (!noKeys.ok) assert(noKeys.error === LIVE_MODE_NOT_ENABLED, 'exact live-not-enabled error');

  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  const keyOnly = await decideProposal({ proposal_id: liveProposalId, decision: 'approve' });
  assert(!keyOnly.ok, 'secret key alone refused');
  if (!keyOnly.ok) assert(keyOnly.error === LIVE_MODE_NOT_ENABLED, 'key without RAIL_LIVE');

  delete process.env.STRIPE_SECRET_KEY;
  process.env.RAIL_LIVE = '1';
  const flagOnly = await decideProposal({ proposal_id: liveProposalId, decision: 'approve' });
  assert(!flagOnly.ok, 'RAIL_LIVE alone refused');
  if (!flagOnly.ok) assert(flagOnly.error === LIVE_MODE_NOT_ENABLED, 'flag without key');

  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.RAIL_LIVE = '1';
  delete process.env.RAIL_ALLOW_LIVE_CHARGE;
  const gated = await decideProposal({ proposal_id: liveProposalId, decision: 'approve' });
  assert(!gated.ok, 'keys set but charge still blocked');
  if (!gated.ok) {
    assert(gated.error.includes('No request was sent'), 'scaffold does not send');
    assert(gated.error !== LIVE_MODE_NOT_ENABLED, 'gates recognized');
  }

  process.env.RAIL_ALLOW_LIVE_CHARGE = '1';
  const allowed = await decideProposal({ proposal_id: liveProposalId, decision: 'approve' });
  assert(!allowed.ok, 'ALLOW flag still does not settle');
  if (!allowed.ok) assert(allowed.error.includes('No charge was made'), 'no charge was made');

  assert(networkCalls() === callsBeforeLive, 'live gates made no network calls');

  process.env.RAIL_MODE = 'dry_run';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RAIL_LIVE;
  delete process.env.RAIL_ALLOW_LIVE_CHARGE;

  const pending = await listProposals({ status: 'pending' });
  assert(
    pending.proposals.some((p) => p.id === liveProposalId),
    'failed live approve left the proposal pending',
  );
  const afterLive = await getReceipts({ limit: 10 });
  assert(afterLive.count === 1, 'live path wrote no receipt');
  assert(afterLive.receipts[0]!.settlement_ref === settlementRef, 'original settlement_ref unchanged');

  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
