import type { ActivityEntry } from '@mcp-router/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../errors.ts';
import {
  type AggregateDeps,
  createAggregateServer,
  createProxyServer,
  mergeInstructions,
  type ProxyDeps,
  proxyCapabilities,
} from '../proxy.ts';

type RecordedActivity = ActivityEntry & { name: string };

/** Link the given gateway Server to a real in-memory MCP Client. */
async function connect(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const connectProxy = (deps: ProxyDeps) => connect(createProxyServer('demo', deps));
const connectAggregate = (deps: AggregateDeps) => connect(createAggregateServer(deps));

function collector() {
  const activity: RecordedActivity[] = [];
  const record = (name: string, entry: Omit<ActivityEntry, 'id'>) => {
    activity.push({ ...entry, id: activity.length + 1, name });
  };
  return { activity, record };
}

/** Minimal ProxyDeps over a stubbed downstream client; override pieces per test. */
function stubDeps(fakeClient: unknown, overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    getClient: async () => fakeClient as Client,
    recordToolCount: () => {},
    recordActivity: () => {},
    ...overrides,
  };
}

describe('proxy activity recording', () => {
  it('records successful calls but not routine list successes', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      listTools: async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      callTool: async (params: { arguments?: { msg?: string } }) => ({
        content: [{ type: 'text', text: `echo:${params.arguments?.msg}` }],
      }),
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient, { recordActivity: record }));

    await client.listTools();
    await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    await close();

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      name: 'demo',
      method: 'tools/call',
      target: 'echo',
      via: 'direct',
      ok: true,
    });
    expect(activity[0]?.result).toMatchObject({ content: [{ type: 'text', text: 'echo:hi' }] });
    expect(typeof activity[0]?.durationMs).toBe('number');
  });

  it('surfaces HttpError detail (e.g. a stderr tail) in the recorded error', async () => {
    const { activity, record } = collector();
    const deps = stubDeps(null, {
      recordActivity: record,
      getClient: async () => {
        throw new HttpError(502, 'Failed to connect to server "demo"', 'Traceback: ModuleNotFoundError: mcp');
      },
    });
    const { client, close } = await connectProxy(deps);

    await expect(client.callTool({ name: 'echo' })).rejects.toThrow(/ModuleNotFoundError/);
    await close();

    expect(activity).toHaveLength(1);
    expect(activity[0]?.error).toContain('ModuleNotFoundError');
  });

  it('records a failed direct list', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      listTools: async () => {
        throw new Error('connection reset');
      },
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient, { recordActivity: record }));

    await expect(client.listTools()).rejects.toThrow();
    await close();

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ method: 'tools/list', ok: false });
    expect(activity[0]?.error).toContain('connection reset');
  });

  it('records a failed tool call with its error message', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      callTool: async () => {
        throw new Error('downstream boom');
      },
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient, { recordActivity: record }));

    await expect(client.callTool({ name: 'broken' })).rejects.toThrow();
    await close();

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ method: 'tools/call', target: 'broken', ok: false });
    expect(activity[0]?.error).toContain('downstream boom');
  });

  it('records a tool call that resolves with isError as a failure', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient, { recordActivity: record }));

    const result = await client.callTool({ name: 'echo', arguments: {} });
    await close();

    // The isError result must still reach the client unmodified.
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ method: 'tools/call', target: 'echo', ok: false });
    expect(activity[0]?.error).toContain('boom');
  });

  it('serves a capability-less list as an empty result, resetting the tool count, without recording it', async () => {
    const { activity, record } = collector();
    const toolCounts: Record<string, number> = {};
    const fakeClient = {
      listTools: async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'no tools here');
      },
    };
    const deps = stubDeps(fakeClient, {
      recordActivity: record,
      recordToolCount: (name, count) => {
        toolCounts[name] = count;
      },
    });
    const { client, close } = await connectProxy(deps);

    const result = await client.listTools();
    await close();

    expect(result.tools).toEqual([]);
    expect(toolCounts.demo).toBe(0);
    expect(activity).toEqual([]);
  });
});

describe('aggregate activity recording', () => {
  it('records a routed tools/call under the owning server and honors isError', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      callTool: async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
    };
    const deps: AggregateDeps = { ...stubDeps(fakeClient, { recordActivity: record }), serverNames: () => ['alpha'] };
    const { client, close } = await connectAggregate(deps);

    await client.callTool({ name: 'alpha__echo', arguments: {} });
    await close();

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      name: 'alpha',
      method: 'tools/call',
      target: 'echo',
      via: 'aggregate',
      ok: false,
    });
    expect(activity[0]?.error).toContain('nope');
  });

  it('does not record routine aggregate list fan-outs', async () => {
    const { activity, record } = collector();
    const fakeClient = {
      listTools: async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
    };
    const deps: AggregateDeps = {
      ...stubDeps(fakeClient, { recordActivity: record }),
      serverNames: () => ['alpha', 'beta'],
    };
    const { client, close } = await connectAggregate(deps);

    const result = await client.listTools();
    await close();

    expect(result.tools.map((t) => t.name).sort()).toEqual(['alpha__echo', 'beta__echo']);
    expect(activity).toEqual([]);
  });

  it('merges and namespaces resource templates across servers', async () => {
    const fakeClient = {
      listResourceTemplates: async () => ({
        resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'Files' }],
      }),
    };
    const deps: AggregateDeps = {
      ...stubDeps(fakeClient),
      serverNames: () => ['alpha', 'beta'],
    };
    const { client, close } = await connectAggregate(deps);

    const result = await client.listResourceTemplates();
    await close();

    expect(result.resourceTemplates).toEqual([
      { uriTemplate: 'alpha__file:///{path}', name: 'alpha__Files' },
      { uriTemplate: 'beta__file:///{path}', name: 'beta__Files' },
    ]);
  });

  it('drains every page of a paginating downstream list', async () => {
    const { activity, record } = collector();
    const toolCounts: Record<string, number> = {};
    const fakeClient = {
      listTools: async (params?: { cursor?: string }) =>
        params?.cursor === 'page2'
          ? { tools: [{ name: 'two', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'page2' },
    };
    const deps: AggregateDeps = {
      ...stubDeps(fakeClient, {
        recordActivity: record,
        recordToolCount: (name, count) => {
          toolCounts[name] = count;
        },
      }),
      serverNames: () => ['alpha'],
    };
    const { client, close } = await connectAggregate(deps);

    const result = await client.listTools();
    await close();

    expect(result.tools.map((t) => t.name)).toEqual(['alpha__one', 'alpha__two']);
    expect(toolCounts.alpha).toBe(2);
    expect(activity).toEqual([]);
  });

  it('records a server that errors during the aggregate list fan-out, and still serves the rest', async () => {
    const { activity, record } = collector();
    const goodClient = {
      listTools: async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
    };
    const badClient = {
      listTools: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const deps: AggregateDeps = {
      ...stubDeps(null, {
        recordActivity: record,
        getClient: async (name) => (name === 'bad' ? badClient : goodClient) as Client,
      }),
      serverNames: () => ['bad', 'good'],
    };
    const { client, close } = await connectAggregate(deps);

    const result = await client.listTools();
    await close();

    expect(result.tools.map((t) => t.name)).toEqual(['good__echo']);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ name: 'bad', method: 'tools/list', via: 'aggregate', ok: false });
    expect(activity[0]?.error).toContain('ECONNREFUSED');
  });
});

describe('completions passthrough', () => {
  it('forwards a completion request on the per-server endpoint', async () => {
    const fakeClient = {
      complete: async (params: { ref: { name: string } }) => ({
        completion: { values: [`${params.ref.name}:done`] },
      }),
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient));

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'greet' },
      argument: { name: 'who', value: 'a' },
    });
    await close();

    expect(result.completion.values).toEqual(['greet:done']);
  });

  it('returns empty values when the downstream lacks the completions capability', async () => {
    const fakeClient = {
      complete: async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'no completions');
      },
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient));

    const result = await client.complete({
      ref: { type: 'ref/resource', uri: 'file:///x' },
      argument: { name: 'p', value: '' },
    });
    await close();

    expect(result.completion.values).toEqual([]);
  });

  it('strips the namespace off a completion ref and routes to the owning server', async () => {
    let seenRef: unknown;
    const fakeClient = {
      complete: async (params: { ref: unknown }) => {
        seenRef = params.ref;
        return { completion: { values: ['ok'] } };
      },
    };
    const deps: AggregateDeps = { ...stubDeps(fakeClient), serverNames: () => ['alpha', 'beta'] };
    const { client, close } = await connectAggregate(deps);

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'alpha__greet' },
      argument: { name: 'who', value: '' },
    });
    await close();

    expect(seenRef).toEqual({ type: 'ref/prompt', name: 'greet' });
    expect(result.completion.values).toEqual(['ok']);
  });
});

describe('resource subscriptions', () => {
  it('forwards subscribe and unsubscribe on the per-server endpoint', async () => {
    const calls: Array<[string, string]> = [];
    const fakeClient = {
      subscribeResource: async (p: { uri: string }) => {
        calls.push(['sub', p.uri]);
        return {};
      },
      unsubscribeResource: async (p: { uri: string }) => {
        calls.push(['unsub', p.uri]);
        return {};
      },
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient));

    await client.subscribeResource({ uri: 'file:///x' });
    await client.unsubscribeResource({ uri: 'file:///x' });
    await close();

    expect(calls).toEqual([
      ['sub', 'file:///x'],
      ['unsub', 'file:///x'],
    ]);
  });

  it('strips the namespace off a subscribed resource uri on the aggregate', async () => {
    let seen: string | undefined;
    const fakeClient = {
      subscribeResource: async (p: { uri: string }) => {
        seen = p.uri;
        return {};
      },
    };
    const deps: AggregateDeps = { ...stubDeps(fakeClient), serverNames: () => ['alpha'] };
    const { client, close } = await connectAggregate(deps);

    await client.subscribeResource({ uri: 'alpha__file:///x' });
    await close();

    expect(seen).toBe('file:///x');
  });
});

describe('logging passthrough', () => {
  it('forwards logging/setLevel on the per-server endpoint', async () => {
    let level: string | undefined;
    const fakeClient = {
      setLoggingLevel: async (l: string) => {
        level = l;
      },
    };
    const { client, close } = await connectProxy(stubDeps(fakeClient));

    await client.setLoggingLevel('debug');
    await close();

    expect(level).toBe('debug');
  });

  it('fans logging/setLevel out to every member on the aggregate', async () => {
    const levels: Record<string, string> = {};
    const deps: AggregateDeps = {
      ...stubDeps(null, {
        getClient: async (name) =>
          ({
            setLoggingLevel: async (l: string) => {
              levels[name] = l;
            },
          }) as unknown as Client,
      }),
      serverNames: () => ['alpha', 'beta'],
    };
    const { client, close } = await connectAggregate(deps);

    await client.setLoggingLevel('warning');
    await close();

    expect(levels).toEqual({ alpha: 'warning', beta: 'warning' });
  });
});

describe('capabilities', () => {
  it("advertises the downstream's own declared surfaces on a 1:1 endpoint", async () => {
    const server = createProxyServer('demo', stubDeps({}), {
      capabilities: { tools: { listChanged: true } },
    });
    const { client, close } = await connect(server);
    // A tools-only server behind the proxy is a tools-only endpoint in front of it.
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    await close();
  });

  it('does not claim subscribe for a downstream that cannot subscribe', () => {
    // The sharp one: claimed unconditionally before, so a client was invited to
    // send a `resources/subscribe` that only the failure would answer.
    expect(proxyCapabilities({ resources: { listChanged: true } })).toEqual({
      resources: { subscribe: false, listChanged: true },
    });
    expect(proxyCapabilities({ resources: { subscribe: true } })).toEqual({
      resources: { subscribe: true, listChanged: false },
    });
  });

  it('answers "no such method" for a surface the downstream does not have', async () => {
    const { client, close } = await connect(createProxyServer('demo', stubDeps({}), { capabilities: { tools: {} } }));
    // Not an empty list: that reads as a server which has resources and happens
    // to have none, which is a different and untrue answer.
    await expect(client.listResources()).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await close();
  });

  it('advertises everything it can relay for a downstream that has not connected', async () => {
    const { client, close } = await connectProxy(stubDeps({}));
    // Claiming too much costs a client one empty round trip; claiming too little
    // costs it the surface, so an unknown downstream gets the generous answer.
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
      completions: {},
    });
    await close();
  });

  it('keeps the union on the aggregate, whose members are not connected yet', async () => {
    const { client, close } = await connectAggregate({ ...stubDeps({}), serverNames: () => ['git'] });
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
      completions: {},
    });
    await close();
  });
});

describe('instructions', () => {
  it("forwards a single downstream server's instructions unchanged", async () => {
    const server = createProxyServer('demo', stubDeps({}), { instructions: 'Prefer this over a web search.' });
    const { client, close } = await connect(server);
    // Nothing is renamed on the 1:1 endpoint, so there is nothing to rewrite.
    expect(client.getInstructions()).toBe('Prefer this over a web search.');
    await close();
  });

  it('has no instructions when the downstream has none', async () => {
    const { client, close } = await connectProxy(stubDeps({}));
    expect(client.getInstructions()).toBeUndefined();
    await close();
  });

  it('merges the aggregate members under headings, behind a note about the prefix', async () => {
    const merged = mergeInstructions([
      ['context7', 'Use this whenever the user asks about a library.'],
      ['quiet', undefined],
      ['blank', '   '],
      ['git', 'Call `git_status` before staging.'],
    ]);
    // The prefix note has to come first: every name in the sections below is
    // offered to the client with a `<server>__` on the front of it.
    expect(merged).toMatch(/^This endpoint merges several MCP servers\./);
    expect(merged).toContain('`<server>__`');
    expect(merged).toContain('## context7\n\nUse this whenever the user asks about a library.');
    expect(merged).toContain('## git\n\nCall `git_status` before staging.');
    // Servers with nothing to say get no heading at all, rather than an empty one.
    expect(merged).not.toContain('## quiet');
    expect(merged).not.toContain('## blank');
  });

  it('leaves the aggregate without instructions when no member has any', () => {
    expect(mergeInstructions([])).toBeUndefined();
    expect(
      mergeInstructions([
        ['a', undefined],
        ['b', ''],
      ]),
    ).toBeUndefined();
  });

  it('serves the merged instructions on the aggregate endpoint', async () => {
    const deps: AggregateDeps = { ...stubDeps({}), serverNames: () => ['git'] };
    const merged = mergeInstructions([['git', 'Call `git_status` before staging.']]);
    const { client, close } = await connect(createAggregateServer(deps, merged));
    expect(client.getInstructions()).toBe(merged);
    await close();
  });
});
