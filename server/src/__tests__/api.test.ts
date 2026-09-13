import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverConfigSchema } from '@mcp-router/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { ConfigStore } from '../config/store.ts';
import { ECHO_INSTRUCTIONS } from '../gateway/__tests__/fixtures/echo-instructions.ts';
import { GatewayManager, workspaceInstanceKey } from '../gateway/manager.ts';
import { SERVER_VERSION } from '../version.ts';

describe('REST API', () => {
  let dataDir: string;
  let store: ConfigStore;
  let manager: GatewayManager;
  let token: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    delete process.env.MCP_ROUTER_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-router-api-'));
    store = new ConfigStore(dataDir);
    await store.init();
    token = store.getSettings().authToken as string;
    manager = new GatewayManager(() => store.getSettings());
    await manager.reconcile(store.getServers());
    app = buildApp({ store, manager, appDistDir: path.join(dataDir, 'no-such-dist') });
  });

  afterEach(async () => {
    await manager.stopAll();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  it('requires auth on /api and /mcp', async () => {
    expect((await request(app).get('/api/status')).status).toBe(401);
    expect((await request(app).post('/mcp').send({})).status).toBe(401);
  });

  it('reports router status', async () => {
    const res = await authed(request(app).get('/api/status'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: SERVER_VERSION, serverCount: 0, runningCount: 0, authEnabled: true });
  });

  it('manages registries with validation and conflict handling', async () => {
    const list = await authed(request(app).get('/api/registries'));
    expect(list.body).toEqual([{ name: 'official', url: 'https://registry.modelcontextprotocol.io' }]);

    const bad = await authed(request(app).post('/api/registries')).send({ name: 'x', url: 'not-a-url' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Validation failed');

    const created = await authed(request(app).post('/api/registries')).send({ name: 'mine', url: 'https://r.example' });
    expect(created.status).toBe(201);

    const dup = await authed(request(app).post('/api/registries')).send({ name: 'mine', url: 'https://r.example' });
    expect(dup.status).toBe(409);

    const removed = await authed(request(app).delete('/api/registries/mine'));
    expect(removed.status).toBe(204);
    expect((await authed(request(app).delete('/api/registries/mine'))).status).toBe(404);
  });

  it('installs a remote server, updates it and deletes it', async () => {
    const install = await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
      env: { KEY: 'v1' },
    });
    expect(install.status).toBe(201);
    expect(install.body.state).toBe('stopped');
    expect(install.body.config.name).toBe('hosted');

    const conflict = await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });
    expect(conflict.status).toBe(409);

    const patched = await authed(request(app).patch('/api/servers/hosted')).send({
      env: { KEY: 'v2' },
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.config.env.KEY).toBe('v2');
    expect(patched.body.config.enabled).toBe(false);
    expect(store.getServer('hosted')?.env.KEY).toBe('v2');

    // Disabled servers 404 on their MCP route.
    const mcp = await authed(request(app).post('/mcp/hosted')).send({});
    expect(mcp.status).toBe(404);

    const deleted = await authed(request(app).delete('/api/servers/hosted'));
    expect(deleted.status).toBe(204);
    expect((await authed(request(app).get('/api/servers/hosted'))).status).toBe(404);
  });

  it('serves and clears in-memory activity for a known server', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    const empty = await authed(request(app).get('/api/servers/hosted/activity'));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ entries: [] });

    // Records surface newest-first via the manager (the proxy path is covered elsewhere).
    manager.recordActivity('hosted', {
      at: new Date().toISOString(),
      via: 'direct',
      method: 'tools/call',
      target: 'echo',
      ok: true,
      durationMs: 3,
      params: { name: 'echo' },
      result: { ok: true },
    });

    const listed = await authed(request(app).get('/api/servers/hosted/activity'));
    expect(listed.body.entries).toHaveLength(1);
    expect(listed.body.entries[0]).toMatchObject({ method: 'tools/call', target: 'echo', ok: true });
    expect(typeof listed.body.entries[0].id).toBe('number');

    const cleared = await authed(request(app).delete('/api/servers/hosted/activity'));
    expect(cleared.status).toBe(204);
    expect((await authed(request(app).get('/api/servers/hosted/activity'))).body.entries).toEqual([]);

    expect((await authed(request(app).get('/api/servers/nope/activity'))).status).toBe(404);
  });

  it('validates tool-call requests before connecting', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    expect((await authed(request(app).post('/api/servers/nope/tools/call')).send({ name: 't' })).status).toBe(404);

    const bad = await authed(request(app).post('/api/servers/hosted/tools/call')).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Validation failed');
  });

  it('passes a connect failure and its backoff through with distinct statuses', async () => {
    // Written straight to the store: POST /api/servers installs, and this one
    // is a hand-written child that only has to fail.
    await store.saveServer(
      serverConfigSchema.parse({
        name: 'boom',
        source: { type: 'npm', package: 'none' },
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['-e', "console.error('ModuleNotFoundError: no module named x'); process.exit(1)"],
        },
      }),
    );
    await manager.reconcile(store.getServers());

    // A tried-and-failed connect is a 502 carrying the child's own stderr; the
    // next one, still inside the crash backoff, is a 503 — the route must not
    // collapse the two, because "try again later" and "it is broken" are
    // different answers.
    const failed = await authed(request(app).get('/api/servers/boom/tools'));
    expect(failed.status).toBe(502);
    expect(failed.body.detail).toContain('ModuleNotFoundError: no module named x');

    const backedOff = await authed(request(app).get('/api/servers/boom/tools'));
    expect(backedOff.status).toBe(503);
    expect(backedOff.body.error).toMatch(/backed off/);
  });

  it('lists resources and prompts from a connected server', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    vi.spyOn(manager, 'getClient').mockResolvedValue({
      listResources: async () => ({ resources: [{ uri: 'file:///a.txt', name: 'A' }] }),
      listResourceTemplates: async () => ({
        resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'Files' }],
      }),
      listPrompts: async () => ({ prompts: [{ name: 'greet', description: 'Say hi' }] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub of the downstream client
    } as any);

    const resources = await authed(request(app).get('/api/servers/hosted/resources'));
    expect(resources.status).toBe(200);
    expect(resources.body.resources).toEqual([{ uri: 'file:///a.txt', name: 'A' }]);
    expect(resources.body.resourceTemplates).toEqual([{ uriTemplate: 'file:///{path}', name: 'Files' }]);

    const prompts = await authed(request(app).get('/api/servers/hosted/prompts'));
    expect(prompts.status).toBe(200);
    expect(prompts.body.prompts).toEqual([{ name: 'greet', description: 'Say hi' }]);
  });

  it('returns empty lists when the downstream lacks resources/prompts', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    const unsupported = () =>
      Promise.reject(new Error('Server does not support resources (required for resources/list)'));
    vi.spyOn(manager, 'getClient').mockResolvedValue({
      listResources: unsupported,
      listResourceTemplates: unsupported,
      listPrompts: unsupported,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub of the downstream client
    } as any);

    const resources = await authed(request(app).get('/api/servers/hosted/resources'));
    expect(resources.status).toBe(200);
    expect(resources.body).toEqual({ resources: [], resourceTemplates: [] });

    const prompts = await authed(request(app).get('/api/servers/hosted/prompts'));
    expect(prompts.status).toBe(200);
    expect(prompts.body).toEqual({ prompts: [] });

    expect((await authed(request(app).get('/api/servers/nope/resources'))).status).toBe(404);
    expect((await authed(request(app).get('/api/servers/nope/prompts'))).status).toBe(404);
  });

  it('reads a resource and gets a prompt from the UI, recording both to activity', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({ contents: [{ uri, text: 'hello' }] }));
    const getPrompt = vi.fn(
      async ({ name, arguments: args }: { name: string; arguments?: Record<string, string> }) => ({
        description: `prompt ${name}`,
        messages: [{ role: 'user', content: { type: 'text', text: args?.topic ?? '' } }],
      }),
    );
    vi.spyOn(manager, 'getClient').mockResolvedValue({
      readResource,
      getPrompt,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub of the downstream client
    } as any);

    const read = await authed(request(app).post('/api/servers/hosted/resources/read')).send({ uri: 'file:///a.txt' });
    expect(read.status).toBe(200);
    expect(read.body.contents[0]).toMatchObject({ uri: 'file:///a.txt', text: 'hello' });
    expect(readResource).toHaveBeenCalledWith({ uri: 'file:///a.txt' });

    const got = await authed(request(app).post('/api/servers/hosted/prompts/get')).send({
      name: 'greet',
      arguments: { topic: 'weather' },
    });
    expect(got.status).toBe(200);
    expect(got.body.description).toBe('prompt greet');
    expect(getPrompt).toHaveBeenCalledWith({ name: 'greet', arguments: { topic: 'weather' } });

    // Both UI invocations land in the activity log, newest first.
    const activity = await authed(request(app).get('/api/servers/hosted/activity'));
    expect(activity.body.entries.map((e: { method: string }) => e.method)).toEqual(['prompts/get', 'resources/read']);
    expect(activity.body.entries.every((e: { via: string; ok: boolean }) => e.via === 'ui' && e.ok)).toBe(true);
  });

  it('validates resource-read and prompt-get requests, and 404s unknown servers', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    expect((await authed(request(app).post('/api/servers/hosted/resources/read')).send({})).status).toBe(400);
    expect((await authed(request(app).post('/api/servers/hosted/prompts/get')).send({})).status).toBe(400);
    expect((await authed(request(app).post('/api/servers/nope/resources/read')).send({ uri: 'x' })).status).toBe(404);
    expect((await authed(request(app).post('/api/servers/nope/prompts/get')).send({ name: 'x' })).status).toBe(404);
  });

  it('updates the idle timeout via PATCH /api/settings and persists it', async () => {
    const before = await authed(request(app).get('/api/status'));
    expect(before.body.idleTimeoutMs).toBe(5 * 60 * 1000);

    const bad = await authed(request(app).patch('/api/settings')).send({ idleTimeoutMs: -1 });
    expect(bad.status).toBe(400);

    const patched = await authed(request(app).patch('/api/settings')).send({ idleTimeoutMs: 120_000 });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ idleTimeoutMs: 120_000 });
    expect(store.getSettings().idleTimeoutMs).toBe(120_000);
    // The token must survive a settings merge.
    expect(store.getSettings().authToken).toBe(token);

    const after = await authed(request(app).get('/api/status'));
    expect(after.body.idleTimeoutMs).toBe(120_000);
  });

  it('404s for unknown servers and registries', async () => {
    expect((await authed(request(app).get('/api/servers/nope'))).status).toBe(404);
    expect((await authed(request(app).get('/api/registries/nope/servers'))).status).toBe(404);
    expect((await authed(request(app).post('/mcp/nope')).send({})).status).toBe(404);
  });

  it('manages workspaces: auto-slug, member validation, rename, and endpoint gating', async () => {
    await authed(request(app).post('/api/servers')).send({
      name: 'hosted',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: {} },
    });

    // Members must reference existing servers.
    const badMember = await authed(request(app).post('/api/workspaces')).send({
      name: 'Acme',
      members: { ghost: {} },
    });
    expect(badMember.status).toBe(400);

    // Slug is derived from the name; response carries the derived endpoint path.
    const created = await authed(request(app).post('/api/workspaces')).send({
      name: 'Acme Backend',
      members: { hosted: { headers: { 'X-Env': 'prod' } } },
    });
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe('acme-backend');
    expect(created.body.path).toBe('/mcp/w/acme-backend');
    expect(store.getWorkspace('acme-backend')?.members.hosted?.headers).toEqual({ 'X-Env': 'prod' });

    const dup = await authed(request(app).post('/api/workspaces')).send({ name: 'Acme Backend' });
    expect(dup.status).toBe(409);

    const list = await authed(request(app).get('/api/workspaces'));
    expect(list.body).toHaveLength(1);

    // The workspace endpoint is reachable while enabled...
    expect((await authed(request(app).post('/mcp/w/acme-backend')).send({})).status).not.toBe(404);

    // Renaming re-derives the slug (and moves the URL); the old slug is gone.
    const renamed = await authed(request(app).patch('/api/workspaces/acme-backend')).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.slug).toBe('renamed');
    expect(store.getWorkspace('acme-backend')).toBeUndefined();
    expect(store.getWorkspace('renamed')).toBeDefined();

    // Disabling 404s the endpoint without deleting the workspace.
    await authed(request(app).patch('/api/workspaces/renamed')).send({ enabled: false });
    expect((await authed(request(app).post('/mcp/w/renamed')).send({})).status).toBe(404);
    expect(store.getWorkspace('renamed')?.enabled).toBe(false);

    const deleted = await authed(request(app).delete('/api/workspaces/renamed'));
    expect(deleted.status).toBe(204);
    expect((await authed(request(app).get('/api/workspaces/renamed'))).status).toBe(404);
  });
});

describe('MCP session lifecycle', () => {
  let dataDir: string;
  let store: ConfigStore;
  let manager: GatewayManager;
  let token: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    delete process.env.MCP_ROUTER_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-router-session-'));
    store = new ConfigStore(dataDir);
    await store.init();
    token = store.getSettings().authToken as string;
    manager = new GatewayManager(() => store.getSettings());
    await manager.reconcile(store.getServers());
    app = buildApp({ store, manager, appDistDir: path.join(dataDir, 'no-such-dist') });
  });

  afterEach(async () => {
    await manager.stopAll();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const asEventStream = (req: request.Test) => req.set('Accept', 'application/json, text/event-stream');

  it('completes a full stateful session over HTTP via a real MCP client', async () => {
    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      // connect() runs the full initialize handshake against a minted session.
      await client.connect(transport);
      expect(transport.sessionId).toBeTruthy();
      // The aggregate advertises the full capability set now.
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {},
      });
      // No servers installed → the aggregate lists nothing, over the same session.
      expect((await client.listTools()).tools).toEqual([]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("serves a downstream server's own instructions, 1:1 and merged into the aggregate", async () => {
    await store.saveServer(
      serverConfigSchema.parse({
        name: 'echo',
        source: { type: 'npm', package: 'none' },
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(import.meta.dirname, '../gateway/__tests__/fixtures/echo-server.ts')],
        },
      }),
    );
    await manager.reconcile(store.getServers(), store.getWorkspaces());

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    const open = async (endpoint: string) => {
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${endpoint}`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };

    const direct = await open('/mcp/echo');
    const aggregate = await open('/mcp');
    try {
      // /mcp/echo connects the child during its own initialize, so the very first
      // session on a cold router already carries the server's guidance.
      expect(direct.getInstructions()).toBe(ECHO_INSTRUCTIONS);

      // The aggregate reads what has already been said rather than spawning every
      // member to ask — which the session above is what made available.
      expect(aggregate.getInstructions()).toContain('## echo');
      expect(aggregate.getInstructions()).toContain(ECHO_INSTRUCTIONS);
      // ...along with the one thing no member can know: its names are prefixed here.
      expect(aggregate.getInstructions()).toContain('`<server>__`');

      // The same connect settles what this endpoint declares. The fixture serves
      // tools and nothing else, so a client is not invited to ask it for resources
      // or to subscribe to them.
      expect(direct.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
      // The aggregate has not connected anything to ask, so it keeps the union of
      // what any member might support.
      expect(aggregate.getServerCapabilities()).toMatchObject({
        resources: { subscribe: true, listChanged: true },
      });
    } finally {
      await Promise.all([direct.close(), aggregate.close()]);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('rejects a non-initialize request that carries no session id', async () => {
    const res = await asEventStream(authed(request(app).post('/mcp'))).send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.status).toBe(400);
  });

  it('404s a request bearing an unknown or expired session id', async () => {
    const res = await asEventStream(authed(request(app).post('/mcp')))
      .set('mcp-session-id', 'does-not-exist')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(404);
  });

  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  };

  /** Mint a session over HTTP and return its id from the response header. */
  const initSession = async (): Promise<string> => {
    const res = await asEventStream(authed(request(app).post('/mcp'))).send(initBody);
    expect(res.status).toBe(200);
    const id = res.headers['mcp-session-id'];
    expect(id).toBeTruthy();
    return id as string;
  };

  /** A follow-up call on a session; 200 while live, 404 once the router has reclaimed it. */
  const listWithSession = (id: string) =>
    asEventStream(authed(request(app).post('/mcp')))
      .set('mcp-session-id', id)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  it('picks up a workspace member added after the session was initialized', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Unreachable on purpose: the fan-out can't connect, and records that failure
    // under the member's workspace instance — which is the observable proving the
    // member was in the session's member set at all.
    await store.saveServer({
      name: 'unreachable',
      source: { type: 'remote' },
      transport: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp', headers: {} },
      enabled: true,
      env: {},
      envMeta: {},
    });
    await store.saveWorkspace({ name: 'Later', slug: 'later', enabled: true, members: {} });
    await manager.reconcile(store.getServers(), store.getWorkspaces());

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/w/later`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toEqual([]);
      expect(manager.getActivity(workspaceInstanceKey('later', 'unreachable'))).toEqual([]);

      // Add the member mid-session, as an edit through the UI or the config file would.
      await store.saveWorkspace({
        name: 'Later',
        slug: 'later',
        enabled: true,
        members: { unreachable: { enabled: true } },
      });
      await manager.reconcile(store.getServers(), store.getWorkspaces());

      expect((await client.listTools()).tools).toEqual([]);
      expect(manager.getActivity(workspaceInstanceKey('later', 'unreachable'))).toMatchObject([
        { method: 'tools/list', via: 'aggregate', ok: false },
      ]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('reclaims a session left idle past the configured TTL', async () => {
    await store.updateSettings({ sessionIdleTimeoutMs: 60_000 });
    // Freeze only Date (not timers, so supertest's async still runs) to drive idleness deterministically.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const id = await initSession();
      expect((await listWithSession(id)).status).toBe(200);
      // Jump past the TTL; the next request's opportunistic sweep reclaims the idle session.
      vi.setSystemTime(Date.now() + 61_000);
      expect((await listWithSession(id)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the least-recently-active session when the cap is reached', async () => {
    await store.updateSettings({ maxSessions: 1 });
    const first = await initSession();
    // Initializing a second session while at the cap evicts the first.
    const second = await initSession();
    expect((await listWithSession(first)).status).toBe(404);
    expect((await listWithSession(second)).status).toBe(200);
  });
});
