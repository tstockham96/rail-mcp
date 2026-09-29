#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { railMode } from './stripeLink.js';
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

interface ToolRisk {
  title: string;
  description: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Spec defaults are the risky case. Set every hint explicitly. */
function risk(input: ToolRisk) {
  const annotations = {
    title: input.title,
    readOnlyHint: input.readOnlyHint,
    destructiveHint: input.destructiveHint,
    idempotentHint: input.idempotentHint,
    openWorldHint: input.openWorldHint,
  };
  return {
    title: input.title,
    description: input.description,
    annotations,
  };
}

function packageVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error(`rail-mcp: missing version in ${pkgPath}`);
  }
  return parsed.version;
}

const serverVersion = packageVersion();

function createServer() {
  const server = new McpServer({
    name: 'rail',
    version: serverVersion,
  });

  server.registerTool(
    'set_budget',
    {
      ...risk({
        title: 'Set budget',
        description:
          'Overwrite the local spend budget. Changes the ledger limit only. Does not spend money, approve a card, settle a purchase, or contact Stripe or Link. Passing the same amount again does not add to the budget.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
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
      ...risk({
        title: 'Get budget',
        description:
          'Read the active budget, amount spent, amount remaining, and the count of pending proposals. Does not change the ledger, spend money, or contact Stripe or Link.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
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
      ...risk({
        title: 'Propose purchase',
        description:
          'Record a pending purchase intent only. Moves no money, creates no receipt, approves no card, and does not contact Stripe or Link. Needs a later human approval via decide_proposal before anything settles. When a budget exists and the amount is above what remains, the proposal is stored with over_budget set and still spends nothing.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      }),
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
      ...risk({
        title: 'List proposals',
        description:
          'Read purchase proposals filtered by status: pending (default), approved, rejected, or all. Does not approve, reject, spend money, or contact Stripe or Link.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
      inputSchema: z.object({
        status: z
          .enum(['pending', 'approved', 'rejected', 'all'])
          .optional()
          .describe('Filter: pending (default), approved, rejected, or all'),
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
      ...risk({
        title: 'Decide proposal',
        description:
          'Approve or reject one pending proposal. This is the step a human should confirm. decision=approve settles the purchase: in the default dry-run mode it writes a settled_dry_run receipt, stamps a fake settlement ref (lsrq_dry_…), and decrements the remaining budget, without calling the network. decision=reject spends nothing and writes no receipt. The proposal can be decided only once; repeating the call does not settle again. Live charging stays off unless separate live gates are set on purpose.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      }),
      inputSchema: z.object({
        proposal_id: z.string().describe('Proposal id (prop_…)'),
        decision: z.enum(['approve', 'reject']).describe('approve settles; reject spends nothing'),
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
      ...risk({
        title: 'Get receipts',
        description:
          'Read receipts, newest first, including dry-run settlements and refunds. Does not refund, spend money, or contact Stripe or Link.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
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
      ...risk({
        title: 'Refund receipt',
        description:
          'Reverse a settled dry-run receipt and restore that amount to the remaining budget. This is the step a human should confirm. Does not contact Stripe or Link. A receipt can be refunded only once; repeating the call does not refund again. Refuses receipts that are not settled_dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      }),
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

console.error(`rail-mcp listening on stdio (mode=${railMode()})`);

process.on('SIGINT', () => {
  void handle.close();
});
process.on('SIGTERM', () => {
  void handle.close();
});
