import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  decideProposal,
  getBudget,
  getReceipts,
  listProposals,
  proposePurchase,
  refundReceipt,
  setBudget,
} from './store.js';

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function createServer() {
  const server = new McpServer({
    name: 'rail',
    version: '0.1.0',
  });

  server.registerTool(
    'set_budget',
    {
      description:
        'Overwrite the active agent spend budget. Returns current budget and remaining after prior settled spends.',
      inputSchema: z.object({
        amount_usd: z.number().describe('Budget amount in USD'),
        currency: z.string().optional().describe('Currency code; default USD'),
        note: z.string().optional().describe('Optional note for this budget'),
      }),
    },
    async (args) => {
      const result = await setBudget(args);
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'get_budget',
    {
      description:
        'Return active budget, spent, remaining, and count of open (pending) proposals.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await getBudget();
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'propose_purchase',
    {
      description:
        'Create a pending purchase proposal on behalf of the human. Does not spend. Flags over_budget if amount exceeds remaining.',
      inputSchema: z.object({
        merchant: z.string().describe('Merchant or seller name'),
        amount_usd: z.number().describe('Purchase amount in USD'),
        url: z.string().optional().describe('Product or checkout URL'),
        rationale: z.string().optional().describe('Why the agent wants this'),
        sku: z.string().optional().describe('SKU or product identifier'),
      }),
    },
    async (args) => {
      const result = await proposePurchase(args);
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'list_proposals',
    {
      description: 'List purchase proposals filtered by status (default: pending).',
      inputSchema: z.object({
        status: z
          .enum(['pending', 'approved', 'rejected', 'all'])
          .optional()
          .describe("Filter: pending (default), approved, rejected, or all"),
      }),
    },
    async (args) => {
      const result = await listProposals(args);
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'decide_proposal',
    {
      description:
        'Approve or reject a pending proposal. Approve in dry_run creates a settled_dry_run receipt and decrements remaining budget. Refuse double-decide.',
      inputSchema: z.object({
        proposal_id: z.string().describe('Proposal id (prop_…)'),
        decision: z.enum(['approve', 'reject']).describe('approve or reject'),
        note: z.string().optional().describe('Optional decision note'),
      }),
    },
    async (args) => {
      const result = await decideProposal(args);
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'get_receipts',
    {
      description: 'List receipts newest first (dry-run settlements and refunds).',
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe('Max receipts to return'),
      }),
    },
    async (args) => {
      const result = await getReceipts(args);
      return jsonResult(result, !result.ok);
    },
  );

  server.registerTool(
    'refund_receipt',
    {
      description:
        'Mark a settled dry-run receipt as refunded and restore budget. Dry-run only.',
      inputSchema: z.object({
        receipt_id: z.string().describe('Receipt id (rcpt_…)'),
        reason: z.string().optional().describe('Refund reason'),
      }),
    },
    async (args) => {
      const result = await refundReceipt(args);
      return jsonResult(result, !result.ok);
    },
  );

  return server;
}

const handle = serveStdio(() => createServer());

console.error('rail-mcp listening on stdio (mode=dry_run)');

process.on('SIGINT', () => {
  void handle.close();
});
process.on('SIGTERM', () => {
  void handle.close();
});
