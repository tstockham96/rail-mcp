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
  const receiptId = d.receipt!.id;

  console.log('\n5) refuse double-decide');
  const d2 = await decideProposal({ proposal_id: proposalId, decision: 'reject' });
  console.log(JSON.stringify(d2, null, 2));
  assert(!d2.ok, 'double-decide refused');

  console.log('\n6) get_receipts shows one');
  const r = await getReceipts({ limit: 10 });
  console.log(JSON.stringify(r, null, 2));
  assert(r.count === 1, 'one receipt');
  assert(r.receipts[0]!.id === receiptId, 'same receipt id');

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

  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
