import path from 'node:path';
import type { ActivityEntry } from '@mcp-router/shared';
import { serverConfigSchema, settingsFileSchema, workspaceConfigSchema } from '@mcp-router/shared';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../version.ts';
import { GatewayManager, workspaceInstanceKey } from '../manager.ts';
import { ECHO_INSTRUCTIONS } from './fixtures/echo-instructions.ts';

const settings = settingsFileSchema.parse({});
const remoteConfig = (name: string) =>
  serverConfigSchema.parse({
    name,
    source: { type: 'remote' },
    transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
  });

async function newManager(names: string[]): Promise<GatewayManager> {
  const manager = new GatewayManager(() => settings);
  await manager.reconcile(names.map(remoteConfig));
  return manager;
}

const baseEntry: Omit<ActivityEntry, 'id'> = {
  at: '2026-01-01T00:00:00.000Z',
  via: 'direct',
  method: 'tools/call',
  ok: true,
  durationMs: 1,
};

describe('GatewayManager activity log', () => {
  it('stores a detached clone of result, immune to later mutation of the caller value', async () => {
    const manager = await newManager(['a']);
    const result = { text: 'hi', nested: { count: 1 } };
    manager.recordActivity('a', { ...baseEntry, result });
    result.text = 'MUTATED';
    result.nested.count = 99;
    expect(manager.getActivity('a')[0]?.result).toEqual({ text: 'hi', nested: { count: 1 } });
  });

  it('drops activity for a server that is not currently managed', async () => {
    const manager = await newManager(['a']);
    manager.recordActivity('ghost', { ...baseEntry });
    expect(manager.getActivity('ghost')).toEqual([]);
    expect(manager.getActivity('a')).toEqual([]);
  });

  it('counts recorded calls and stamps the last-called time on the status', async () => {
    const manager = await newManager(['a']);
    expect(manager.status('a')?.callCount).toBe(0);
    expect(manager.status('a')?.lastCalledAt).toBeUndefined();

    manager.recordActivity('a', { ...baseEntry, at: '2026-01-01T00:00:00.000Z' });
    manager.recordActivity('a', { ...baseEntry, at: '2026-01-01T00:05:00.000Z' });

    expect(manager.status('a')?.callCount).toBe(2);
    expect(manager.status('a')?.lastCalledAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('does not count activity for an unmanaged server', async () => {
    const manager = await newManager(['a']);
    manager.recordActivity('ghost', { ...baseEntry });
    expect(manager.status('ghost')).toBeUndefined();
    expect(manager.status('a')?.callCount).toBe(0);
  });

  it('bounds the log to the newest 200 entries, newest first', async () => {
    const manager = await newManager(['a']);
    for (let i = 0; i < 250; i += 1) {
      manager.recordActivity('a', { ...baseEntry, target: `t${i}` });
    }
    const log = manager.getActivity('a');
    expect(log).toHaveLength(200);
    expect(log[0]?.target).toBe('t249');
    expect(log[199]?.target).toBe('t50');
  });

  it('truncates an over-large payload to a marker string', async () => {
    const manager = await newManager(['a']);
    manager.recordActivity('a', { ...baseEntry, result: { big: 'x'.repeat(20_000) } });
    const stored = manager.getActivity('a')[0]?.result;
    expect(typeof stored).toBe('string');
    expect(stored).toContain('[truncated');
  });

  it('bounds over-large error and target strings too', async () => {
    const manager = await newManager(['a']);
    manager.recordActivity('a', {
      ...baseEntry,
      ok: false,
      target: `data:application/octet-stream;base64,${'A'.repeat(20_000)}`,
      error: `downstream failed: ${'x'.repeat(20_000)}`,
    });
    const entry = manager.getActivity('a')[0];
    expect(entry?.error?.length).toBeLessThan(9_000);
    expect(entry?.error).toContain('[truncated');
    expect(entry?.target?.length).toBeLessThan(9_000);
    expect(entry?.target).toContain('[truncated');
  });

  it('never truncates in the middle of a surrogate pair', async () => {
    const manager = await newManager(['a']);
    // Serialized form is `{"big":"…"}` — the 8-char prefix puts the emoji's high
    // surrogate exactly at the truncation index.
    manager.recordActivity('a', { ...baseEntry, result: { big: `${'x'.repeat(7_991)}😀${'y'.repeat(100)}` } });
    const stored = manager.getActivity('a')[0]?.result;
    expect(typeof stored).toBe('string');
    // No high surrogate left without its low half.
    expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('GatewayManager workspaces', () => {
  const stdioConfig = (name: string) =>
    serverConfigSchema.parse({
      name,
      source: { type: 'npm', package: `pkg-${name}` },
      transport: { type: 'stdio', command: 'node', args: ['base.js'] },
      env: { BASE: '1', SHARED: 'base' },
    });

  const workspace = (members: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    workspaceConfigSchema.parse({ name: 'Acme', slug: 'acme', members, ...extra });

  it('creates a workspace-scoped instance with per-member overrides applied', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile(
      [stdioConfig('gh')],
      [workspace({ gh: { env: { SHARED: 'override', EXTRA: 'x' }, args: ['custom.js'] } })],
    );

    const status = manager.status(workspaceInstanceKey('acme', 'gh'));
    expect(status).toBeDefined();
    // Keeps the base name (for tool namespacing) but with overrides merged in.
    expect(status?.config.name).toBe('gh');
    expect(status?.config.env).toEqual({ BASE: '1', SHARED: 'override', EXTRA: 'x' });
    expect(status?.config.transport).toMatchObject({ type: 'stdio', args: ['custom.js'] });
  });

  it('overrides a remote member URL while merging headers over the base', async () => {
    const manager = new GatewayManager(() => settings);
    const remote = serverConfigSchema.parse({
      name: 'api',
      source: { type: 'remote' },
      transport: {
        type: 'streamable-http',
        url: 'http://localhost:1001/mcp',
        headers: { 'X-Base': 'base' },
      },
    });
    await manager.reconcile(
      [remote],
      [
        workspace({
          api: { url: 'http://localhost:1001/mcp/w/something', headers: { Authorization: 'Bearer scoped' } },
        }),
      ],
    );

    const transport = manager.status(workspaceInstanceKey('acme', 'api'))?.config.transport;
    expect(transport).toMatchObject({
      type: 'streamable-http',
      url: 'http://localhost:1001/mcp/w/something',
      headers: { 'X-Base': 'base', Authorization: 'Bearer scoped' },
    });
  });

  it('leaves a remote member URL untouched when no url override is set', async () => {
    const manager = new GatewayManager(() => settings);
    const remote = serverConfigSchema.parse({
      name: 'api',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'http://localhost:1001/mcp' },
    });
    await manager.reconcile([remote], [workspace({ api: {} })]);

    expect(manager.status(workspaceInstanceKey('acme', 'api'))?.config.transport).toMatchObject({
      url: 'http://localhost:1001/mcp',
    });
  });

  it('keeps workspace instances out of the base server views (statusAll / enabledNames)', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([stdioConfig('gh')], [workspace({ gh: {} })]);

    expect(manager.enabledNames()).toEqual(['gh']);
    expect(manager.statusAll().map((s) => s.config.name)).toEqual(['gh']);
  });

  it('runs a workspace member even when its base server is globally disabled (independent scope)', async () => {
    const manager = new GatewayManager(() => settings);
    const disabledBase = serverConfigSchema.parse({ ...stdioConfig('gh'), enabled: false });
    await manager.reconcile([disabledBase], [workspace({ gh: {} })]);

    // The base server is off globally...
    expect(manager.enabledNames()).toEqual([]);
    // ...but its workspace-scoped instance is enabled and connectable.
    expect(manager.status(workspaceInstanceKey('acme', 'gh'))?.config.enabled).toBe(true);
  });

  it('disables a workspace instance when the workspace itself is disabled', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([stdioConfig('gh')], [workspace({ gh: {} }, { enabled: false })]);

    expect(manager.status(workspaceInstanceKey('acme', 'gh'))?.config.enabled).toBe(false);
  });

  it('drops workspace instances whose base server no longer exists', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([stdioConfig('gh')], [workspace({ gh: {}, ghost: {} })]);

    expect(manager.status(workspaceInstanceKey('acme', 'gh'))).toBeDefined();
    expect(manager.status(workspaceInstanceKey('acme', 'ghost'))).toBeUndefined();
  });

  it('removes a workspace instance when the workspace is removed on a later reconcile', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([stdioConfig('gh')], [workspace({ gh: {} })]);
    expect(manager.status(workspaceInstanceKey('acme', 'gh'))).toBeDefined();

    await manager.reconcile([stdioConfig('gh')], []);
    expect(manager.status(workspaceInstanceKey('acme', 'gh'))).toBeUndefined();
    // The base server survives.
    expect(manager.status('gh')).toBeDefined();
  });
});

describe('GatewayManager stdio failures', () => {
  const crashingConfig = (name: string, script: string) =>
    serverConfigSchema.parse({
      name,
      source: { type: 'npm', package: 'none' },
      transport: { type: 'stdio', command: process.execPath, args: ['-e', script] },
    });

  it("reports the child's stderr rather than the transport's own close message", async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([
      crashingConfig('boom', "console.error('ModuleNotFoundError: no module named x'); process.exit(1)"),
    ]);

    await expect(manager.getClient('boom')).rejects.toThrow(/Failed to connect to server "boom"/);
    const status = manager.status('boom');
    expect(status?.state).toBe('error');
    // The point of piping stderr: "MCP error -32000: Connection closed" explains nothing.
    expect(status?.lastError).toContain('ModuleNotFoundError: no module named x');
    await manager.stopAll();
  });

  it('clears a standing backoff on restart, so the retry dials and reports why it failed', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([crashingConfig('boom', "console.error('nope'); process.exit(1)")]);

    // First use dials and fails: 502, carrying what the child said.
    await expect(manager.getClient('boom')).rejects.toMatchObject({ status: 502, detail: /nope/ });
    // Inside the backoff window an ordinary use is refused without dialling at all.
    await expect(manager.getClient('boom')).rejects.toMatchObject({ status: 503 });
    // Restart is an explicit "try it again now", so it dials through the backoff
    // and answers with the failure rather than with the backoff it just cleared.
    await expect(manager.restart('boom')).rejects.toMatchObject({ status: 502, detail: /nope/ });
    await manager.stopAll();
  });

  it('gives up on a child that spawns and never speaks, instead of waiting on it forever', async () => {
    // Small enough that a hang fails the test by timing out rather than by passing slowly.
    const impatient = settingsFileSchema.parse({ connectTimeoutMs: 300 });
    const manager = new GatewayManager(() => impatient);
    // Holds the event loop open and says nothing: no stdout, no exit, no stderr.
    // The SDK's own 60s bounds the initialize *request*, which this never answers.
    await manager.reconcile([crashingConfig('wedged', 'setInterval(() => {}, 1_000)')]);

    const startedAt = Date.now();
    await expect(manager.getClient('wedged')).rejects.toThrow(/Failed to connect to server "wedged"/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(manager.status('wedged')?.state).toBe('error');
    await manager.stopAll();
  });

  it('honours an edited connect timeout on the next reconcile, without a restart', async () => {
    // Starts patient, so a manager that captured the timeout at construction would sit on
    // the default 60s below and fail this test by timing out rather than by asserting.
    let current = settings;
    const manager = new GatewayManager(() => current);
    await manager.reconcile([crashingConfig('wedged', 'setInterval(() => {}, 1_000)')]);

    // The operator edits settings.json and the config watcher reconciles. The row is
    // re-read, so the new patience applies at the next connect.
    current = settingsFileSchema.parse({ connectTimeoutMs: 300 });
    await manager.reconcile([crashingConfig('wedged', 'setInterval(() => {}, 1_000)')]);

    const startedAt = Date.now();
    await expect(manager.getClient('wedged')).rejects.toThrow(/Failed to connect to server "wedged"/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await manager.stopAll();
  });

  it('backs off a second connect after a crash, without spawning again', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([crashingConfig('flaky', 'process.exit(1)')]);

    await expect(manager.getClient('flaky')).rejects.toThrow();
    await expect(manager.getClient('flaky')).rejects.toThrow(/crashed recently; retrying is backed off/);
    await manager.stopAll();
  });
});

describe('GatewayManager lifecycle over the pool', () => {
  const echoServer = path.join(import.meta.dirname, 'fixtures/echo-server.ts');
  const echoConfig = (name: string, overrides: Record<string, unknown> = {}) =>
    serverConfigSchema.parse({
      name,
      source: { type: 'npm', package: 'none' },
      transport: { type: 'stdio', command: process.execPath, args: [echoServer] },
      ...overrides,
    });

  it('registers a server without spawning it, and spawns on the first use', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    try {
      // Registered, but lazily: no child yet, and nothing is wrong with that.
      expect(manager.status('echo')).toMatchObject({ state: 'stopped', pid: undefined });
      expect(manager.runningCount()).toBe(0);

      const client = await manager.getClient('echo');
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['pid', 'caller']);

      const status = manager.status('echo');
      expect(status?.state).toBe('running');
      expect(status?.pid).toBeGreaterThan(0);
      expect(status?.startedAt).toBeTruthy();
      expect(manager.runningCount()).toBe(1);
    } finally {
      await manager.stopAll();
    }
  });

  it('restart replaces the child with a new process', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    try {
      await manager.getClient('echo');
      const before = manager.status('echo')?.pid;

      await manager.restart('echo');
      const after = manager.status('echo')?.pid;

      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(0);
      expect(after).not.toBe(before);
      expect(manager.status('echo')?.state).toBe('running');
    } finally {
      await manager.stopAll();
    }
  });

  it('introduces the router to the downstream by its own name and version', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    try {
      const client = await manager.getClient('echo');
      const result = await client.callTool({ name: 'caller', arguments: {} });

      // `clientInfo` is the whole of what a dialled server learns about its caller, and it
      // ends up in that server's own logs — so both halves have to be true. The pool used to
      // fill the version in with a constant `0.1.0` (upstream agent-mcp-pool#60).
      expect(result).toMatchObject({
        content: [{ type: 'text', text: `mcp-router ${SERVER_VERSION}` }],
      });
    } finally {
      await manager.stopAll();
    }
  });

  it("remembers the downstream's instructions and capabilities, and forgets them on an edit", async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    try {
      // Nothing has handshaken yet, and both arrive nowhere but in the initialize
      // result — so there is nothing to know and it does not go and find out.
      expect(manager.instructions('echo')).toBeUndefined();
      expect(manager.capabilities('echo')).toBeUndefined();
      expect(manager.status('echo')?.state).toBe('stopped');

      await manager.getClient('echo');
      expect(manager.instructions('echo')).toBe(ECHO_INSTRUCTIONS);
      // The fixture registers tools and nothing else, so that is what the 1:1
      // endpoint in front of it has to declare.
      expect(manager.capabilities('echo')).toMatchObject({ tools: expect.anything() });
      expect(manager.capabilities('echo')?.resources).toBeUndefined();

      // A changed command is a different server; its old guidance and its old
      // method list are not evidence about the new one.
      await manager.reconcile([echoConfig('echo', { env: { CHANGED: '1' } })]);
      expect(manager.instructions('echo')).toBeUndefined();
      expect(manager.capabilities('echo')).toBeUndefined();
    } finally {
      await manager.stopAll();
    }
  });

  it('closes the child when the server is disabled, and drops it from the aggregate', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    try {
      await manager.getClient('echo');
      expect(manager.enabledNames()).toEqual(['echo']);

      await manager.reconcile([echoConfig('echo', { enabled: false })]);

      expect(manager.status('echo')).toMatchObject({ state: 'stopped', pid: undefined });
      expect(manager.enabledNames()).toEqual([]);
      await expect(manager.getClient('echo')).rejects.toMatchObject({
        status: 404,
        message: 'Server "echo" is disabled',
      });
    } finally {
      await manager.stopAll();
    }
  });

  it('404s an instance key nothing is configured for', async () => {
    const manager = new GatewayManager(() => settings);
    await manager.reconcile([echoConfig('echo')]);
    await expect(manager.getClient('ghost')).rejects.toMatchObject({
      status: 404,
      message: 'Unknown server "ghost"',
    });
    await manager.stopAll();
  });

  it('gives a workspace member its own child, independent of the base server', async () => {
    const manager = new GatewayManager(() => settings);
    const workspace = workspaceConfigSchema.parse({
      name: 'Acme',
      slug: 'acme',
      members: { echo: {} },
    });
    await manager.reconcile([echoConfig('echo')], [workspace]);
    try {
      await manager.getClient('echo');
      await manager.getClientForWorkspace('acme', 'echo');

      const base = manager.status('echo')?.pid;
      const scoped = manager.status(workspaceInstanceKey('acme', 'echo'))?.pid;
      expect(base).toBeGreaterThan(0);
      expect(scoped).toBeGreaterThan(0);
      expect(scoped).not.toBe(base);
      // Two children, but only the base server is a "server" to the API.
      expect(manager.runningCount()).toBe(1);
      expect(manager.statusAll().map((s) => s.config.name)).toEqual(['echo']);
    } finally {
      await manager.stopAll();
    }
  });
});
