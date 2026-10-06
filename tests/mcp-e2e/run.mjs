/**
 * MCP e2e acceptance harness.
 *
 * Drives the unmodified @apify/actors-mcp-server over stdio against a running
 * Crawlee Cloud stack and checks every tool the MCP parity epic (#106) relies
 * on. See README.md for the stack prerequisites.
 *
 *   E2E_API_URL=http://localhost:3000 E2E_TOKEN=cp_xxx node run.mjs
 *
 * Exit code is non-zero when a check fails that is not listed in
 * expected-failures.json, or when a listed check passes (the list must shrink).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startProxy } from './proxy.mjs';

// Pinned on purpose: the server releases often. Bump deliberately, in its own PR.
const MCP_SERVER_PACKAGE = '@apify/actors-mcp-server@0.17.3';
const ACTOR_NAME = 'echo-scraper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(HERE, '.out');
const FIXTURE_DIR = path.join(HERE, 'fixture-actor');
const CLI_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

const PUSH_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 3 * 60_000; // first `npx -y` downloads the server
const TOOL_TIMEOUT_MS = 2 * 60_000;
const RUN_TOOL_TIMEOUT_MS = 5 * 60_000; // call-actor / actor tool wait on a real container
const RUN_WAIT_MS = 5 * 60_000;
const ABORT_WAIT_MS = 60_000;
const API_TIMEOUT_MS = 15_000;
const POLL_LIMIT = 100;

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

// Inputs. CALL_INPUT also seeds the storage/run read checks, so its expectations
// (4 items, OUTPUT.query) hold whichever path produced the run.
const CALL_INPUT = { query: 'e2e-call', maxItems: 4, sleepSecs: 3 };
const TOOL_INPUT = { query: 'e2e-tool', maxItems: 2, sleepSecs: 0 };
const ABORT_INPUT = { query: 'e2e-abort', maxItems: 1, sleepSecs: 300 };

/** Canonical check names, in execution order. */
const CHECKS = [
  'tools-list',
  'search-actors',
  'fetch-actor-details',
  'get-actor-list',
  'call-actor',
  'poll-count',
  'actor-tool',
  'get-actor-run',
  'get-actor-run-list',
  'get-actor-run-log',
  'get-dataset',
  'get-dataset-items',
  'get-dataset-schema',
  'get-dataset-list',
  'get-key-value-store',
  'get-key-value-store-keys',
  'get-key-value-store-record',
  'get-key-value-store-list',
  'abort-actor-run',
];

const API_URL = (process.env.E2E_API_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.E2E_TOKEN ?? '';

/** name -> { ok: boolean, reason: string } */
const results = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CheckFailure extends Error {}

function assert(cond, message) {
  if (!cond) throw new CheckFailure(message);
}

function oneLine(value, max = 300) {
  const text = String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors actorNameToToolName() in @apify/actors-mcp-server (tools/actor_tool_naming.js). */
function actorToolName(actorFullName) {
  const MAX = 64;
  const HASH = 4;
  const slash = actorFullName.indexOf('/');
  const username = actorFullName.slice(0, slash).replace(/\./g, '-dot-');
  const name = actorFullName.slice(slash + 1);
  const full = `${username}--${name}`;
  if (full.length <= MAX) return full;
  const hash = createHash('sha256').update(actorFullName).digest('hex').slice(0, HASH);
  return `${full.slice(0, MAX - HASH - 1)}-${hash}`;
}

/** Direct REST call to the API (bypasses the proxy, so it never affects poll-count). */
async function api(method, urlPath, body) {
  let res;
  try {
    res = await fetch(`${API_URL}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `${method} ${API_URL}${urlPath}: ${err.cause?.code ?? err.cause?.message ?? err.message}`
    );
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status} ${oneLine(text, 200)}`);
  }
  return json?.data ?? json;
}

/** Poll until the run's status is in `statuses`; throws on timeout or API error. */
async function waitForRunStatus(runId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await api('GET', `/v2/actor-runs/${encodeURIComponent(runId)}`);
    if (statuses.has(run?.status)) return run;
    await sleep(2000);
  }
  throw new Error(
    `run ${runId} not ${[...statuses].join('/')} after ${timeoutMs / 1000}s (status ${run?.status})`
  );
}

function waitForRunViaApi(runId, timeoutMs) {
  return waitForRunStatus(runId, TERMINAL, timeoutMs);
}

/**
 * Non-terminal runs created since `sinceMs`, excluding `knownIds`. Used to find
 * a run that call-actor started before it errored, so it can be aborted.
 */
async function findNewActiveRuns(sinceMs, knownIds) {
  // 5 s of slack for clock skew between the harness and the API host.
  const since = new Date(sinceMs - 5000).toISOString();
  const list = await api('GET', `/v2/actor-runs?since=${encodeURIComponent(since)}&limit=200`);
  return (list?.items ?? [])
    .filter((r) => !TERMINAL.has(r.status) && !knownIds.has(r.id))
    .map((r) => r.id);
}

/**
 * Start a run through the REST API, not MCP. Used as a fallback so the read
 * checks still exercise their tools when call-actor itself is broken. Sends
 * the wrapped `{ input }` body, which the API accepts on every version.
 */
async function startRunViaApi(input) {
  return api('POST', `/v2/acts/${encodeURIComponent(ACTOR_NAME)}/runs`, { input });
}

function runCommand(cmd, args, { cwd, env, timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: 'w' });
    // Own process group (POSIX), so a timeout also kills grandchildren such as
    // the `docker build` that `crc push` spawns, not just the CLI itself.
    const group = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: group,
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const kill = () => {
      try {
        if (group) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    // A detached group no longer receives the terminal's Ctrl-C, so forward it.
    const onSigint = () => {
      kill();
      process.exit(130);
    };
    process.once('SIGINT', onSigint);
    const timer = setTimeout(kill, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
      out.end();
    };
    child.on('error', (err) => {
      done();
      resolve({ code: -1, error: err.message });
    });
    child.on('close', (code, signal) => {
      done();
      resolve({ code: code ?? -1, error: signal ? `killed by ${signal}` : undefined });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

let client;
let proxy;

async function connectMcp(tools) {
  // Clean environment: the server reads options from unprefixed env vars
  // (TOOLS, ACTORS, UI_MODE, ...) and APIFY_IS_AT_HOME forces api.apify.com,
  // so the parent environment must not leak through. The SDK adds only its
  // safe defaults (HOME, LOGNAME, PATH, SHELL, TERM, USER).
  const env = {
    APIFY_API_BASE_URL: proxy.url,
    APIFY_TOKEN: TOKEN,
    TELEMETRY_ENABLED: 'false',
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  };
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', MCP_SERVER_PACKAGE, '--tools', tools],
    env,
    stderr: 'pipe',
  });
  const stderrLog = fs.createWriteStream(path.join(OUT_DIR, 'mcp-server.log'), { flags: 'a' });
  stderrLog.write(`--- ${new Date().toISOString()} --tools ${tools}\n`);
  transport.stderr?.pipe(stderrLog);

  const c = new Client({ name: 'crawlee-cloud-mcp-e2e', version: '0.0.0' });
  try {
    await c.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    await c.close().catch(() => {});
    throw err;
  }
  return c;
}

/** Call a tool; throws on transport errors and on `isError` results. Returns structuredContent. */
async function tool(name, args, timeoutMs = TOOL_TIMEOUT_MS) {
  if (!client) throw new CheckFailure('MCP client not connected');
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs,
  });
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
  if (result.isError) throw new CheckFailure(`tool error: ${oneLine(text)}`);
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckFailure(`no structuredContent in result: ${oneLine(text)}`);
  }
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

async function check(name, fn) {
  if (results.has(name)) return;
  try {
    const reason = await fn();
    results.set(name, { ok: true, reason: reason ?? 'ok' });
  } catch (err) {
    results.set(name, { ok: false, reason: oneLine(err) });
  }
}

function failRemaining(reason) {
  for (const name of CHECKS) {
    if (!results.has(name)) results.set(name, { ok: false, reason });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ctx = {
  username: undefined,
  actorFullName: undefined,
  toolName: undefined,
  actorToolLoaded: false,
  callRun: undefined, // structuredContent of the waiting call-actor
  seed: undefined, // { runId, datasetId, kvId, source }
  seedError: undefined,
  abortRunId: undefined,
  orphanRunIds: [], // runs call-actor started before erroring; aborted in cleanup()
};

async function setup() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(path.join(OUT_DIR, 'mcp-server.log'), { force: true });

  // 1. Username for the per-actor tool. Until #110 this is the user's email.
  const me = await api('GET', '/v2/users/me');
  assert(
    me?.username && me.username !== 'anonymous',
    `GET /v2/users/me returned no username (is E2E_TOKEN valid?)`
  );
  ctx.username = me.username;
  ctx.actorFullName = `${ctx.username}/${ACTOR_NAME}`;
  ctx.toolName = actorToolName(ctx.actorFullName);
  console.log(`user: ${ctx.username}  actor: ${ctx.actorFullName}  tool: ${ctx.toolName}`);

  // 2. Push the fixture with the built CLI. CRAWLEE_CLOUD_REGISTRY_URL='' keeps a
  //    registryUrl in the user's profile from triggering a `docker push`; env vars
  //    take precedence over the profile, so the user config is never touched.
  if (process.env.E2E_SKIP_PUSH === '1') {
    console.log('E2E_SKIP_PUSH=1: reusing the already pushed fixture actor');
  } else {
    await pushFixture();
  }

  // 3. Logging proxy between the MCP server and the API.
  proxy = await startProxy({ target: API_URL, logFile: path.join(OUT_DIR, 'http.log') });

  // 4. MCP server. If an email-shaped `--tools user@host/echo-scraper` keeps the
  //    server from starting, retry without the per-actor tool so the other
  //    checks still run.
  const baseTools = 'actors,runs,storage,get-actor-list';
  try {
    client = await connectMcp(`${baseTools},${ctx.actorFullName}`);
    ctx.actorToolLoaded = true;
  } catch (err) {
    console.log(`MCP server failed to start with the per-actor tool: ${oneLine(err)}`);
    console.log('retrying without it ...');
    client = await connectMcp(baseTools);
  }
}

async function pushFixture() {
  if (!fs.existsSync(CLI_BIN)) {
    throw new Error(`${path.relative(REPO_ROOT, CLI_BIN)} not found; run \`npm run build\` first`);
  }
  console.log('pushing fixture actor (docker build) ...');
  const push = await runCommand(process.execPath, [CLI_BIN, 'push'], {
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      CRAWLEE_CLOUD_API_URL: API_URL,
      CRAWLEE_CLOUD_TOKEN: TOKEN,
      CRAWLEE_CLOUD_REGISTRY_URL: '',
      CRAWLEE_CLOUD_NO_FEEDBACK_NOTE: '1',
    },
    timeoutMs: PUSH_TIMEOUT_MS,
    logFile: path.join(OUT_DIR, 'push.log'),
  });
  if (push.code !== 0) {
    throw new Error(
      `crc push failed (exit ${push.code}${push.error ? `, ${push.error}` : ''}); see .out/push.log`
    );
  }
}

function seedFromRun(run, source) {
  assert(
    run.defaultDatasetId && run.defaultKeyValueStoreId,
    `run ${run.id} has no default storage ids`
  );
  return {
    runId: run.id,
    datasetId: run.defaultDatasetId,
    kvId: run.defaultKeyValueStoreId,
    source,
  };
}

/**
 * Run for the read checks. Tries, in order: the waiting call-actor's result,
 * call-actor's run awaited via REST, then a REST-started run. Any failure falls
 * through to the next source, and ctx.seed is only set once a seed is complete,
 * so a broken call-actor never leaves the read checks with undefined ids.
 */
async function getSeed() {
  if (ctx.seed) return ctx.seed;
  if (ctx.seedError) throw new CheckFailure(ctx.seedError);
  const problems = [];

  if (ctx.callRun?.status === 'SUCCEEDED') {
    const datasetId = ctx.callRun.storages?.datasets?.default?.id;
    const kvId = ctx.callRun.storages?.keyValueStores?.default?.id;
    if (datasetId && kvId) {
      ctx.seed = { runId: ctx.callRun.runId, datasetId, kvId, source: 'call-actor' };
      return ctx.seed;
    }
    problems.push('call-actor returned no storage ids');
  }

  if (ctx.callRun?.runId) {
    try {
      const run = await waitForRunViaApi(ctx.callRun.runId, RUN_WAIT_MS);
      assert(run.status === 'SUCCEEDED', `call-actor run ${run.id} ended ${run.status}`);
      ctx.seed = seedFromRun(run, 'call-actor run, awaited via REST');
      return ctx.seed;
    } catch (err) {
      problems.push(oneLine(err, 150));
    }
  }

  try {
    const started = await startRunViaApi(CALL_INPUT);
    const run = await waitForRunViaApi(started.id, RUN_WAIT_MS);
    assert(run.status === 'SUCCEEDED', `REST fallback run ${run.id} ended ${run.status}`);
    ctx.seed = seedFromRun(run, 'REST fallback run');
    return ctx.seed;
  } catch (err) {
    problems.push(oneLine(err, 150));
  }

  ctx.seedError = `no seed run: ${problems.join('; ')}`;
  throw new CheckFailure(ctx.seedError);
}

async function runChecks() {
  await check('tools-list', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert(ctx.actorToolLoaded, 'server only started without the per-actor tool');
    const actorTool = tools.find((t) => t.name === ctx.toolName);
    const similar = names.filter((n) => n.endsWith(`--${ACTOR_NAME}`) || n.includes(ACTOR_NAME));
    assert(
      actorTool,
      `${ctx.toolName} not listed${similar.length ? ` (similar: ${similar.join(', ')})` : ''}`
    );
    const required = actorTool.inputSchema?.required ?? [];
    assert(required.includes('query'), `query not required (required: [${required.join(', ')}])`);
    return `${tools.length} tools, ${ctx.toolName} requires query`;
  });

  await check('search-actors', async () => {
    const sc = await tool('search-actors', { keywords: ACTOR_NAME, limit: 5 });
    const found = (sc.actors ?? []).find(
      (a) => a.fullName === ctx.actorFullName || a.fullName?.endsWith(`/${ACTOR_NAME}`)
    );
    assert(found, `${ACTOR_NAME} not in results (count ${sc.count ?? 0})`);
    return `found ${found.fullName}`;
  });

  await check('fetch-actor-details', async () => {
    const sc = await tool('fetch-actor-details', {
      actor: ctx.actorFullName,
      output: { description: true, inputSchema: true },
    });
    const schema = sc.inputSchema ?? {};
    assert(schema.properties?.query, 'input schema has no query property');
    assert((schema.required ?? []).includes('query'), 'query not required in input schema');
    return 'input schema with required query';
  });

  await check('get-actor-list', async () => {
    const sc = await tool('get-actor-list', { limit: 20 });
    const found = (sc.items ?? []).find((a) => a.name === ACTOR_NAME);
    assert(found, `${ACTOR_NAME} not in ${sc.items?.length ?? 0} listed actors`);
    return `found ${found.fullName}`;
  });

  // Waiting call-actor, observed by the proxy for the poll-count assertion.
  const pollWindowStart = proxy.requests.length;
  await check('call-actor', async () => {
    const sc = await tool(
      'call-actor',
      { actor: ctx.actorFullName, input: CALL_INPUT, waitSecs: 45 },
      RUN_TOOL_TIMEOUT_MS
    );
    ctx.callRun = sc;
    assert(sc.status === 'SUCCEEDED', `run ${sc.runId} status ${sc.status} (expected SUCCEEDED)`);
    const itemCount = sc.storages?.datasets?.default?.itemCount;
    assert(
      itemCount === CALL_INPUT.maxItems,
      `itemCount ${itemCount} (expected ${CALL_INPUT.maxItems})`
    );
    return `run ${sc.runId} SUCCEEDED with ${itemCount} items`;
  });
  const pollWindow = proxy.requests.slice(pollWindowStart);

  await check('poll-count', async () => {
    const runId = ctx.callRun?.runId;
    assert(runId, 'inconclusive: call-actor did not return a run');
    const polls = pollWindow.filter(
      (r) => r.method === 'GET' && r.path.split('?')[0] === `/v2/actor-runs/${runId}`
    ).length;
    assert(polls > 0, 'inconclusive: no GET /v2/actor-runs/:id seen during call-actor');
    assert(
      polls < POLL_LIMIT,
      `${polls} GET /v2/actor-runs/${runId} requests (limit ${POLL_LIMIT})`
    );
    return `${polls} GET /v2/actor-runs/:id requests`;
  });

  await check('actor-tool', async () => {
    assert(ctx.actorToolLoaded, 'per-actor tool not loaded');
    const sc = await tool(ctx.toolName, { ...TOOL_INPUT, waitSecs: 45 }, RUN_TOOL_TIMEOUT_MS);
    assert(sc.status === 'SUCCEEDED', `run ${sc.runId} status ${sc.status} (expected SUCCEEDED)`);
    const itemCount = sc.storages?.datasets?.default?.itemCount;
    assert(
      itemCount === TOOL_INPUT.maxItems,
      `itemCount ${itemCount} (expected ${TOOL_INPUT.maxItems})`
    );
    return `run ${sc.runId} SUCCEEDED with ${itemCount} items`;
  });

  await check('get-actor-run', async () => {
    const seed = await getSeed();
    const sc = await tool('get-actor-run', { runId: seed.runId, waitSecs: 0 });
    assert(sc.runId === seed.runId, `runId ${sc.runId} (expected ${seed.runId})`);
    assert(sc.status === 'SUCCEEDED', `status ${sc.status}`);
    const datasetId = sc.storages?.datasets?.default?.id;
    assert(datasetId === seed.datasetId, `dataset ${datasetId} (expected ${seed.datasetId})`);
    return `SUCCEEDED (${seed.source})`;
  });

  await check('get-actor-run-list', async () => {
    const seed = await getSeed();
    const sc = await tool('get-actor-run-list', { limit: 10, desc: true });
    const found = (sc.items ?? []).find((r) => r.id === seed.runId);
    assert(found, `run ${seed.runId} not in ${sc.items?.length ?? 0} newest runs`);
    return `run listed (${sc.total} total)`;
  });

  await check('get-actor-run-log', async () => {
    const seed = await getSeed();
    const sc = await tool('get-actor-run-log', { runId: seed.runId, lines: 50 });
    const log = typeof sc.log === 'string' ? sc.log : '';
    assert(log.includes('echo-scraper:'), `log lacks the fixture's output (${log.length} chars)`);
    return `${log.split('\n').length} lines`;
  });

  await check('get-dataset', async () => {
    const seed = await getSeed();
    const sc = await tool('get-dataset', { datasetId: seed.datasetId });
    assert(sc.id === seed.datasetId, `id ${sc.id} (expected ${seed.datasetId})`);
    assert(
      sc.itemCount === CALL_INPUT.maxItems,
      `itemCount ${sc.itemCount} (expected ${CALL_INPUT.maxItems})`
    );
    return `${sc.itemCount} items`;
  });

  await check('get-dataset-items', async () => {
    const seed = await getSeed();
    const sc = await tool('get-dataset-items', {
      datasetId: seed.datasetId,
      limit: 2,
      fields: 'title',
    });
    const items = sc.items ?? [];
    assert(items.length === 2, `${items.length} items (expected 2)`);
    const extra = [...new Set(items.flatMap((i) => Object.keys(i)))].filter((k) => k !== 'title');
    assert(
      items.every((i) => typeof i.title === 'string'),
      'items missing title'
    );
    assert(extra.length === 0, `fields projection ignored, got extra keys: ${extra.join(', ')}`);
    return '2 items, title only';
  });

  await check('get-dataset-schema', async () => {
    const seed = await getSeed();
    const sc = await tool('get-dataset-schema', { datasetId: seed.datasetId });
    const props = Object.keys(sc.schema?.items?.properties ?? sc.schema?.properties ?? {});
    const missing = ['rank', 'title', 'price'].filter((k) => !props.includes(k));
    assert(missing.length === 0, `schema missing ${missing.join(', ')} (has ${props.join(', ')})`);
    return `fields ${props.join(', ')}`;
  });

  await check('get-dataset-list', async () => {
    const seed = await getSeed();
    const sc = await tool('get-dataset-list', { limit: 20, desc: true, unnamed: true });
    const found = (sc.items ?? []).find((d) => d.id === seed.datasetId);
    assert(found, `dataset ${seed.datasetId} not in ${sc.items?.length ?? 0} newest datasets`);
    return `dataset listed (${sc.total} total)`;
  });

  await check('get-key-value-store', async () => {
    const seed = await getSeed();
    const sc = await tool('get-key-value-store', { keyValueStoreId: seed.kvId });
    assert(sc.id === seed.kvId, `id ${sc.id} (expected ${seed.kvId})`);
    return 'store found';
  });

  await check('get-key-value-store-keys', async () => {
    const seed = await getSeed();
    const sc = await tool('get-key-value-store-keys', { keyValueStoreId: seed.kvId });
    const keys = (sc.items ?? []).map((k) => k.key);
    assert(keys.includes('OUTPUT'), `OUTPUT not in keys [${keys.join(', ')}]`);
    return `keys ${keys.join(', ')}`;
  });

  await check('get-key-value-store-record', async () => {
    const seed = await getSeed();
    const sc = await tool('get-key-value-store-record', {
      keyValueStoreId: seed.kvId,
      recordKey: 'OUTPUT',
    });
    let value = sc.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        // leave as string; the assertion below reports it
      }
    }
    assert(
      value?.query === CALL_INPUT.query,
      `OUTPUT value ${oneLine(JSON.stringify(value), 120)}`
    );
    return `OUTPUT ${JSON.stringify(value)}`;
  });

  await check('get-key-value-store-list', async () => {
    const seed = await getSeed();
    const sc = await tool('get-key-value-store-list', { limit: 10, desc: true, unnamed: true });
    const found = (sc.items ?? []).find((s) => s.id === seed.kvId);
    assert(found, `store ${seed.kvId} not in ${sc.items?.length ?? 0} newest stores`);
    return `store listed (${sc.total} total)`;
  });

  await check('abort-actor-run', async () => {
    let via = 'call-actor waitSecs:0';
    const callStartedAt = Date.now();
    try {
      const started = await tool(
        'call-actor',
        { actor: ctx.actorFullName, input: ABORT_INPUT, waitSecs: 0 },
        RUN_TOOL_TIMEOUT_MS
      );
      ctx.abortRunId = started.runId;
    } catch (err) {
      via = `REST fallback (call-actor failed: ${oneLine(err, 80)})`;
      // call-actor may have created the 300 s run before erroring. Remember it
      // so cleanup() aborts it instead of leaving it to hold a runner slot.
      const known = new Set([ctx.seed?.runId, ctx.callRun?.runId].filter(Boolean));
      ctx.orphanRunIds = await findNewActiveRuns(callStartedAt, known).catch(() => []);
      const run = await startRunViaApi(ABORT_INPUT);
      ctx.abortRunId = run.id;
    }
    assert(ctx.abortRunId, 'no run to abort');
    // Abort a RUNNING run. Aborting before a runner claims it (READY) is a
    // separate gap (#113); racing the runner here would make this check flaky.
    await waitForRunStatus(ctx.abortRunId, new Set(['RUNNING', ...TERMINAL]), ABORT_WAIT_MS);
    const sc = await tool('abort-actor-run', { runId: ctx.abortRunId });
    assert(
      sc.status === 'ABORTING' || sc.status === 'ABORTED',
      `abort returned status ${sc.status}`
    );
    const run = await waitForRunViaApi(ctx.abortRunId, ABORT_WAIT_MS);
    assert(run.status === 'ABORTED', `run ended ${run.status} (expected ABORTED)`);
    return `ABORTED via ${via}`;
  });
}

async function cleanup() {
  // Don't leave the 300 s abort fixture running if abort-actor-run failed.
  const leftovers = [...ctx.orphanRunIds];
  if (ctx.abortRunId && results.get('abort-actor-run')?.ok !== true) leftovers.push(ctx.abortRunId);
  for (const runId of leftovers) {
    await api('POST', `/v2/actor-runs/${encodeURIComponent(runId)}/abort`).catch(() => {});
  }
  await client?.close().catch(() => {});
  await proxy?.close().catch(() => {});
}

function readExpectedFailures() {
  const file = path.join(HERE, 'expected-failures.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) {
    throw new Error('expected-failures.json must be an array of check names');
  }
  return new Set(list);
}

function report(expected) {
  let unexpected = 0;
  let passed = 0;
  let failed = 0;
  let expectedFailed = 0;

  console.log('');
  for (const name of CHECKS) {
    const { ok, reason } = results.get(name);
    const listed = expected.has(name);
    if (ok) passed++;
    else failed++;
    if (ok && listed) {
      unexpected++;
      console.log(
        `PASS  ${name} - ${reason} - unexpectedly passed, remove from expected-failures.json`
      );
    } else if (ok) {
      console.log(`PASS  ${name} - ${reason}`);
    } else if (listed) {
      expectedFailed++;
      console.log(`FAIL  ${name} (expected) - ${reason}`);
    } else {
      unexpected++;
      console.log(`FAIL  ${name} - ${reason}`);
    }
  }

  const unknown = [...expected].filter((n) => !CHECKS.includes(n));
  for (const name of unknown) {
    unexpected++;
    console.log(`ERROR expected-failures.json lists unknown check "${name}"`);
  }

  console.log('');
  console.log(
    `${passed} passed, ${failed} failed (${expectedFailed} expected), ` +
      `${unexpected} unexpected; proxy log: ${path.relative(process.cwd(), path.join(OUT_DIR, 'http.log'))}`
  );
  return unexpected === 0 ? 0 : 1;
}

async function main() {
  if (!API_URL || !TOKEN) {
    console.error('Set E2E_API_URL (e.g. http://localhost:3000) and E2E_TOKEN (a cp_ API key).');
    return 2;
  }
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    console.error(
      `Node 22+ required (the MCP server exits on older Node); have ${process.version}`
    );
    return 2;
  }
  const expected = readExpectedFailures();

  try {
    await setup();
    await runChecks();
  } catch (err) {
    console.log(`setup failed: ${oneLine(err)}`);
    failRemaining(`setup failed: ${oneLine(err, 150)}`);
  } finally {
    await cleanup();
  }
  return report(expected);
}

process.exitCode = await main();
