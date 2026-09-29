import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs, readFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { railMode } from '../src/stripeLink.js';
import {
  decideProposal,
  getBudget,
  getDataDir,
  getReceipts,
  listProposals,
  proposePurchase,
  refundReceipt,
  resetStoreForTests,
  setBudget,
  setDataDirForTests,
} from '../src/store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName?: string;
};

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'rail-smoke', version: '0.0.0' },
  },
};
const initializedNotification = { jsonrpc: '2.0', method: 'notifications/initialized' };

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
}

interface RpcMessage {
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: ListedTool[];
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  error?: { message?: string };
}

const expectedTools: Record<
  string,
  { title: string; annotations: Required<ToolAnnotations>; descriptionIncludes: string[] }
> = {
  set_budget: {
    title: 'Set budget',
    annotations: {
      title: 'Set budget',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['does not spend money', 'approve a card'],
  },
  get_budget: {
    title: 'Get budget',
    annotations: {
      title: 'Get budget',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['does not change the ledger'],
  },
  propose_purchase: {
    title: 'Propose purchase',
    annotations: {
      title: 'Propose purchase',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    descriptionIncludes: ['pending purchase intent only', 'moves no money', 'later human approval'],
  },
  list_proposals: {
    title: 'List proposals',
    annotations: {
      title: 'List proposals',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['does not approve'],
  },
  decide_proposal: {
    title: 'Decide proposal',
    annotations: {
      title: 'Decide proposal',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['human should confirm', 'decision=approve settles'],
  },
  get_receipts: {
    title: 'Get receipts',
    annotations: {
      title: 'Get receipts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['does not refund'],
  },
  refund_receipt: {
    title: 'Refund receipt',
    annotations: {
      title: 'Refund receipt',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    descriptionIncludes: ['reverse a settled', 'human should confirm'],
  },
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function forceDryRun(): void {
  // Stay in dry-run even when the parent process has live gates set.
  // Smoke never assigns RAIL_MODE=live and never turns a charge gate on.
  process.env.RAIL_MODE = 'dry_run';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RAIL_LIVE;
  delete process.env.RAIL_ALLOW_LIVE_CHARGE;
  delete process.env.LINK_ACCESS_TOKEN;
  if (railMode() !== 'dry_run') {
    throw new Error('FAIL: smoke entered live mode');
  }
}

async function fingerprint(dir: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'MISSING';
    throw err;
  }
  const parts: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      parts.push(`${entry.name}/${await fingerprint(full)}`);
    } else {
      parts.push(`${entry.name}:${await fs.readFile(full)}`);
    }
  }
  return parts.join('\n');
}

function dryRunChildEnv(options: { home?: string; dataDir?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RAIL_MODE: 'dry_run',
  };
  delete env.STRIPE_SECRET_KEY;
  delete env.RAIL_LIVE;
  delete env.RAIL_ALLOW_LIVE_CHARGE;
  delete env.LINK_ACCESS_TOKEN;
  if (options.home) {
    env.HOME = options.home;
    env.USERPROFILE = options.home;
  }
  if (options.dataDir) env.RAIL_DATA_DIR = options.dataDir;
  else delete env.RAIL_DATA_DIR;
  return env;
}

function parseRpcLines(lines: string[]): RpcMessage[] {
  const messages: RpcMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as RpcMessage);
    } catch {
      // Server stdout can include non-JSON lines; ignore them.
    }
  }
  return messages;
}

async function rpcOverStdio(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  requests: unknown[];
  untilId: number;
}): Promise<{ stderr: string; messages: RpcMessage[] }> {
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, [path.join(repoRoot, 'src', 'index.ts')], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', (err) => {
    stderr += String(err);
  });

  const lines: string[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => lines.push(line));

  for (const request of options.requests) {
    child.stdin.write(JSON.stringify(request) + '\n');
  }

  const started = Date.now();
  try {
    while (Date.now() - started < 10000) {
      const messages = parseRpcLines(lines);
      if (messages.some((msg) => msg.id === options.untilId) && stderr.includes('mode=dry_run')) {
        return { stderr, messages };
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`FAIL: stdio id ${options.untilId} timed out. stderr=${stderr}`);
  } finally {
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed
    }
    child.kill('SIGTERM');
    rl.close();
  }
}

function assertDryRunStderr(stderr: string): void {
  assert(stderr.includes('mode=dry_run'), 'stdio server stayed in dry-run');
  assert(!stderr.includes('mode=live'), 'stdio server did not report live mode');
}

function assertServerIdentity(messages: RpcMessage[]): void {
  const init = messages.find((msg) => msg.id === 1);
  assert(init && !init.error, `initialize failed: ${init?.error?.message ?? 'no response'}`);
  assert(init.result?.serverInfo?.name === 'rail', 'server name');
  assert(
    init.result?.serverInfo?.version === packageJson.version,
    `server version ${String(init.result?.serverInfo?.version)} is package.json ${packageJson.version}`,
  );
}

async function listToolsOverStdio(dataDir: string): Promise<ListedTool[]> {
  const { stderr, messages } = await rpcOverStdio({
    cwd: repoRoot,
    env: dryRunChildEnv({ dataDir }),
    untilId: 2,
    requests: [
      initializeRequest,
      initializedNotification,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ],
  });
  assertDryRunStderr(stderr);
  assertServerIdentity(messages);
  const listed = messages.find((msg) => msg.id === 2 && Array.isArray(msg.result?.tools));
  assert(listed?.result?.tools, 'tools/list result');
  return listed.result.tools;
}

function toolPayload(messages: RpcMessage[], id: number): { ok?: boolean; error?: string; budget?: { amount_usd?: string } } {
  const msg = messages.find((entry) => entry.id === id);
  assert(msg, `missing rpc id ${id}`);
  assert(!msg.error, `rpc ${id} error: ${msg.error?.message ?? 'unknown'}`);
  assert(msg.result?.isError !== true, `tool ${id} isError`);
  const text = msg.result?.content?.find((part) => part.type === 'text')?.text;
  assert(text, `tool ${id} missing text`);
  const parsed = JSON.parse(text) as { ok?: boolean; error?: string; budget?: { amount_usd?: string } };
  assert(parsed.ok === true, `tool ${id} not ok: ${parsed.error ?? text}`);
  return parsed;
}

async function absent(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return false;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw err;
  }
}

/** Launch from `/` with HOME pointed at a temp dir so the real ledger stays untouched. */
async function assertLaunchFromRoot(): Promise<void> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-home-'));
  const explicit = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-explicit-'));
  const home2 = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-home-'));
  const rootData = '/data';
  const beforeRootData = await fingerprint(rootData);
  try {
    console.log('\n11) set_budget with cwd / and no RAIL_DATA_DIR');
    const defaultSession = await rpcOverStdio({
      cwd: '/',
      env: dryRunChildEnv({ home }),
      untilId: 2,
      requests: [
        initializeRequest,
        initializedNotification,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'set_budget', arguments: { amount_usd: 5, note: 'cwd-root' } },
        },
      ],
    });
    assertDryRunStderr(defaultSession.stderr);
    assertServerIdentity(defaultSession.messages);
    const payload = toolPayload(defaultSession.messages, 2);
    assert(payload.budget?.amount_usd === '5.00', 'budget written from /');
    const ledger = path.join(home, '.rail', 'budget.json');
    const budgetRaw = await fs.readFile(ledger, 'utf8');
    assert(budgetRaw.includes('"amount_cents": 500'), `ledger landed in ${path.dirname(ledger)}`);
    assert(await absent(path.join(explicit, 'budget.json')), 'default launch did not use RAIL_DATA_DIR');
    assert(await fingerprint(rootData) === beforeRootData, '/data unchanged after default launch');
    console.log(`ledger written under temp HOME: ${path.dirname(ledger)}`);

    console.log('\n12) RAIL_DATA_DIR wins when cwd is /');
    const explicitSession = await rpcOverStdio({
      cwd: '/',
      env: dryRunChildEnv({ home: home2, dataDir: explicit }),
      untilId: 2,
      requests: [
        initializeRequest,
        initializedNotification,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'set_budget', arguments: { amount_usd: 7, note: 'explicit' } },
        },
      ],
    });
    assertDryRunStderr(explicitSession.stderr);
    assertServerIdentity(explicitSession.messages);
    const wrote = toolPayload(explicitSession.messages, 2);
    assert(wrote.budget?.amount_usd === '7.00', 'budget written via RAIL_DATA_DIR');
    const explicitBudget = await fs.readFile(path.join(explicit, 'budget.json'), 'utf8');
    assert(explicitBudget.includes('"amount_cents": 700'), 'ledger landed in RAIL_DATA_DIR');
    assert(await absent(path.join(home2, '.rail')), 'explicit RAIL_DATA_DIR did not fall back to ~/.rail');
    assert(await fingerprint(rootData) === beforeRootData, '/data unchanged after explicit launch');
    console.log(`explicit ledger: ${explicit}`);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(home2, { recursive: true, force: true });
    await fs.rm(explicit, { recursive: true, force: true });
  }
}

function assertToolList(tools: ListedTool[]): void {
  const names = tools.map((tool) => tool.name);
  assert(
    names.length === Object.keys(expectedTools).length &&
      Object.keys(expectedTools).every((name) => names.includes(name)),
    `tools/list names ${names.join(', ')}`,
  );

  for (const tool of tools) {
    const expected = expectedTools[tool.name];
    assert(expected, `unexpected tool ${tool.name}`);
    assert(tool.title === expected.title, `${tool.name} title`);
    assert(tool.annotations, `${tool.name} annotations missing`);
    assert(
      JSON.stringify(tool.annotations) === JSON.stringify(expected.annotations),
      `${tool.name} annotations ${JSON.stringify(tool.annotations)}`,
    );
    for (const phrase of expected.descriptionIncludes) {
      assert(
        tool.description?.toLowerCase().includes(phrase.toLowerCase()),
        `${tool.name} description missing "${phrase}"`,
      );
    }
    console.log(
      `${tool.name}: title=${tool.title} annotations=${JSON.stringify(tool.annotations)}`,
    );
  }
}

async function runSmoke(networkCalls: () => number) {
  forceDryRun();
  await resetStoreForTests();
  assert(getDataDir() !== path.resolve(process.cwd(), 'data'), 'smoke dir is not ./data');

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
  assert(networkCalls() === 0, 'dry-run made no network calls');
  forceDryRun();

  console.log('\n10) tools/list annotations');
  const tools = await listToolsOverStdio(getDataDir());
  assertToolList(tools);
  forceDryRun();

  await assertLaunchFromRoot();
  forceDryRun();

  console.log('\nSMOKE OK');
}

async function main() {
  assert(packageJson.name === 'rail-mcp', 'package name');
  assert(packageJson.mcpName === 'io.github.tstockham96/rail-mcp', 'mcpName');

  const cwdData = path.resolve(process.cwd(), 'data');
  const userLedger = path.join(os.homedir(), '.rail');
  const inheritedDataDir = process.env.RAIL_DATA_DIR?.trim()
    ? path.resolve(process.env.RAIL_DATA_DIR.trim())
    : undefined;
  const beforeCwd = await fingerprint(cwdData);
  const beforeUser = await fingerprint(userLedger);
  const beforeInherited =
    inheritedDataDir && inheritedDataDir !== cwdData && inheritedDataDir !== userLedger
      ? await fingerprint(inheritedDataDir)
      : undefined;

  forceDryRun();

  delete process.env.RAIL_DATA_DIR;
  assert(
    getDataDir() === userLedger,
    `default ledger is ~/.rail (got ${getDataDir()})`,
  );
  const explicitProbe = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-env-probe-'));
  process.env.RAIL_DATA_DIR = explicitProbe;
  assert(getDataDir() === explicitProbe, 'RAIL_DATA_DIR overrides ~/.rail');
  await fs.rm(explicitProbe, { recursive: true, force: true });
  delete process.env.RAIL_DATA_DIR;

  let refusedUserLedger = false;
  try {
    setDataDirForTests(userLedger);
  } catch (err: unknown) {
    refusedUserLedger = err instanceof Error && err.message.includes('refused');
  }
  assert(refusedUserLedger, 'setDataDirForTests refuses ~/.rail');

  const sentinel = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-env-sentinel-'));
  const smokeDir = await fs.mkdtemp(path.join(tmpdir(), 'rail-mcp-smoke-'));
  await fs.writeFile(path.join(sentinel, 'KEEP'), 'do-not-touch\n', 'utf8');
  const beforeSentinel = await fingerprint(sentinel);

  // Even when RAIL_DATA_DIR is set, the ledger override must win.
  process.env.RAIL_DATA_DIR = sentinel;
  setDataDirForTests(smokeDir);
  assert(getDataDir() === smokeDir, 'ledger pinned to throwaway dir');
  assert(getDataDir() !== sentinel, 'ledger is not the RAIL_DATA_DIR sentinel');
  assert(getDataDir() !== cwdData, 'ledger is not ./data');
  assert(getDataDir() !== userLedger, 'ledger is not ~/.rail');

  let networkCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('smoke: network is forbidden');
  }) as typeof fetch;

  let runError: unknown;
  try {
    await runSmoke(() => networkCalls);
    if (networkCalls !== 0) {
      throw new Error(`FAIL: smoke made ${networkCalls} network call(s)`);
    }
    forceDryRun();
  } catch (err) {
    runError = err;
  } finally {
    globalThis.fetch = previousFetch;
    forceDryRun();
    await fs.rm(smokeDir, { recursive: true, force: true });
  }

  const afterCwd = await fingerprint(cwdData);
  const afterUser = await fingerprint(userLedger);
  const afterSentinel = await fingerprint(sentinel);
  const afterInherited =
    inheritedDataDir && inheritedDataDir !== cwdData && inheritedDataDir !== userLedger
      ? await fingerprint(inheritedDataDir)
      : undefined;
  await fs.rm(sentinel, { recursive: true, force: true });

  const isolationProblems: string[] = [];
  if (afterCwd !== beforeCwd) isolationProblems.push(`./data changed (${cwdData})`);
  if (afterUser !== beforeUser) isolationProblems.push(`~/.rail changed (${userLedger})`);
  if (afterSentinel !== beforeSentinel) {
    isolationProblems.push(`RAIL_DATA_DIR sentinel changed (${sentinel})`);
  }
  if (beforeInherited !== undefined && afterInherited !== beforeInherited) {
    isolationProblems.push(`inherited RAIL_DATA_DIR changed (${inheritedDataDir})`);
  }
  let smokeGone = false;
  try {
    await fs.stat(smokeDir);
  } catch (err: unknown) {
    smokeGone = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  if (!smokeGone) isolationProblems.push(`throwaway dir still exists (${smokeDir})`);

  console.log(`\nledger isolation: throwaway ${smokeDir} removed`);
  console.log(`./data unchanged (${beforeCwd === 'MISSING' ? 'absent' : cwdData})`);
  console.log(`~/.rail unchanged (${beforeUser === 'MISSING' ? 'absent' : userLedger})`);
  console.log(`RAIL_DATA_DIR sentinel unchanged (${sentinel})`);
  if (inheritedDataDir && inheritedDataDir !== cwdData) {
    console.log(`inherited RAIL_DATA_DIR unchanged (${inheritedDataDir})`);
  }

  if (isolationProblems.length > 0) {
    const isolationError = new Error(`FAIL: ${isolationProblems.join('; ')}`);
    if (runError) {
      throw new Error(`${isolationError.message}\n${runError instanceof Error ? runError.stack : runError}`);
    }
    throw isolationError;
  }
  if (runError) throw runError;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
