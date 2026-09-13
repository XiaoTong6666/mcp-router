// Re-exported by the pool so this file can type the field without reaching into the SDK's
// module layout, which the pool pins through its peer dependency anyway.
import type { ServerCapabilities } from '@cubicecho/agent-mcp-pool';
import type { ActivityEntry } from '@mcp-router/shared';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { errorDetailMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';
import { emptyOnMissing } from './capability.ts';
import { collectFrom } from './fan-out.ts';
import { namespaceName, splitNamespacedName } from './naming.ts';
import { listAllPrompts, listAllResources, listAllResourceTemplates, listAllTools } from './pagination.ts';

/**
 * What an endpoint advertises when it cannot know what is behind it: everything
 * this proxy is able to relay. `listChanged` and `subscribe` are relayed from the
 * downstream servers over a stateful session; completions/logging are forwarded
 * request/response.
 *
 * Right for an aggregate, whose members are deliberately not connected while a
 * client initializes — the union is the honest answer when any member might
 * support any of it. On a 1:1 endpoint it is the fallback for a downstream that
 * would not connect, where claiming everything is the safer error: a client that
 * asks and gets an empty list has lost a round trip, one told a surface does not
 * exist has lost the surface.
 */
const PROXY_CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: true },
  logging: {},
  completions: {},
};

/**
 * What a 1:1 endpoint advertises: what the downstream itself declared, narrowed to
 * the surfaces this proxy relays.
 *
 * Nothing is renamed or synthesized on this endpoint, so its capabilities are the
 * downstream's own for the same reason its `instructions` are. A proxy that claims
 * a capability the server behind it lacks makes a question the handshake exists to
 * answer unanswerable: `resources.subscribe` was claimed unconditionally, so a
 * client learned that a server cannot subscribe from the failure of a subscribe it
 * was invited to send. `listChanged` is mirrored rather than asserted because this
 * endpoint only ever relays such a notification — it never originates one.
 *
 * @param downstream The server's declared capabilities, as of its last connect.
 *   Absent when it has never connected — see {@link PROXY_CAPABILITIES}.
 */
export function proxyCapabilities(downstream?: ServerCapabilities): ServerCapabilities {
  if (!downstream) {
    return PROXY_CAPABILITIES;
  }
  return {
    ...(downstream.tools && { tools: { listChanged: downstream.tools.listChanged === true } }),
    ...(downstream.resources && {
      resources: {
        subscribe: downstream.resources.subscribe === true,
        listChanged: downstream.resources.listChanged === true,
      },
    }),
    ...(downstream.prompts && { prompts: { listChanged: downstream.prompts.listChanged === true } }),
    ...(downstream.logging && { logging: {} }),
    ...(downstream.completions && { completions: {} }),
  };
}

/** Empty completion result used when a downstream server has no completions capability. */
const EMPTY_COMPLETION = { completion: { values: [], total: 0, hasMore: false } };

/**
 * Head of the aggregate's instructions, explaining the one thing that is true of
 * this endpoint and of no server behind it: the names are prefixed. Without it a
 * member's own guidance ("call `resolve-library-id` first") names tools the
 * client was never offered.
 */
const AGGREGATE_INSTRUCTIONS_PREAMBLE =
  'This endpoint merges several MCP servers. Every tool name, prompt name and resource URI is ' +
  "prefixed with `<server>__`. Each section below is one server's own instructions; read the " +
  "names in it as carrying that section's prefix.";

/**
 * The aggregate's `instructions`: every member's own, under a heading naming the
 * server whose prefix they belong to. Servers with nothing to say are left out
 * entirely, and if none of them has anything the whole field is absent rather
 * than a lone preamble explaining a scheme with no content under it.
 *
 * @param members `[server name, its instructions]` in the order they should read.
 */
export function mergeInstructions(members: [name: string, instructions: string | undefined][]): string | undefined {
  const sections = members
    .filter((member): member is [string, string] => Boolean(member[1]?.trim()))
    .map(([name, text]) => `## ${name}\n\n${text.trim()}`);
  if (sections.length === 0) {
    return undefined;
  }
  return [AGGREGATE_INSTRUCTIONS_PREAMBLE, ...sections].join('\n\n');
}

/** Propagate a downstream failure as a proper MCP error. */
function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) {
    return err;
  }
  return new McpError(ErrorCode.InternalError, errorDetailMessage(err));
}

/** A tool call that resolves with `isError: true` is a downstream failure, not a success. */
export function toolCallFailed(result: unknown): boolean {
  return Boolean((result as CallToolResult | undefined)?.isError);
}

/** Best-effort error message for a tool call that resolved with `isError: true`. */
export function toolErrorText(result: unknown): string {
  const content = (result as CallToolResult).content;
  const text = Array.isArray(content)
    ? content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
    : '';
  return text || 'Tool reported an error (isError: true)';
}

export interface ProxyDeps {
  getClient: (name: string) => Promise<Client>;
  recordToolCount: (name: string, count: number) => void;
  recordActivity: (name: string, entry: Omit<ActivityEntry, 'id'>) => void;
}

interface TrackContext {
  via: ActivityEntry['via'];
  method: string;
  target?: string;
  params?: unknown;
  /**
   * Skip recording successes. List ops arrive on every client (re)connect and
   * list_changed, so recording their routine successes would flood the bounded
   * per-server log and evict the targeted tool/resource/prompt calls the
   * Activity tab exists to show. Failures always record.
   */
  failuresOnly?: boolean;
}

/**
 * Run a downstream call, recording its params + result/error and timing to the
 * server's activity log. Records both outcomes, converts a raw downstream
 * failure into a proper MCP error, and always re-raises.
 */
async function track<T>(deps: ProxyDeps, name: string, ctx: TrackContext, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    // tools/call resolves (does not throw) for tool-level errors, flagging them
    // via `isError` on the result — so success/failure can't be inferred from
    // throw-vs-return alone. Derived here, once, so no call site can forget it.
    const failed = ctx.method === 'tools/call' && toolCallFailed(result);
    if (ctx.failuresOnly && !failed) {
      return result;
    }
    deps.recordActivity(name, {
      at: new Date().toISOString(),
      via: ctx.via,
      method: ctx.method,
      target: ctx.target,
      ok: !failed,
      durationMs: Date.now() - startedAt,
      params: ctx.params,
      result,
      error: failed ? toolErrorText(result) : undefined,
    });
    return result;
  } catch (err) {
    deps.recordActivity(name, {
      at: new Date().toISOString(),
      via: ctx.via,
      method: ctx.method,
      target: ctx.target,
      ok: false,
      durationMs: Date.now() - startedAt,
      params: ctx.params,
      error: errorDetailMessage(err),
    });
    throw toMcpError(err);
  }
}

/**
 * What a 1:1 endpoint re-emits from the downstream's own initialize result. Both
 * travel nowhere else, so both are read from a connection rather than from config.
 */
export interface DownstreamIdentity {
  /**
   * The downstream's own instructions, forwarded unchanged — nothing is renamed on
   * this endpoint, so its guidance is true of it as written. Absent when the server
   * has none, or has not connected yet.
   */
  instructions?: string;
  /**
   * What the downstream declared it supports. Absent when it has not connected, in
   * which case the endpoint advertises everything it is able to relay instead.
   */
  capabilities?: ServerCapabilities;
}

/**
 * MCP server proxying a single downstream server 1:1 (used for /mcp/:name).
 *
 * @param downstream The server's own instructions and capabilities, as of its last
 *   connect. Empty for a server that has never connected in this process.
 */
export function createProxyServer(name: string, deps: ProxyDeps, downstream: DownstreamIdentity = {}): Server {
  const advertised = proxyCapabilities(downstream.capabilities);
  const server = new Server(
    { name: `mcp-router/${name}`, version: SERVER_VERSION },
    { capabilities: advertised, instructions: downstream.instructions },
  );
  const client = () => deps.getClient(name);

  // A handler per surface this endpoint declares, and none for a surface it does
  // not. The SDK enforces the pairing — `setRequestHandler` refuses a method the
  // server's own capabilities do not cover — and it is the honest answer either
  // way: a client that asks a tools-only server for resources should hear "no
  // such method", which is true, rather than an empty list, which reads as a
  // server that has resources and happens to have none right now.
  if (advertised.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (req) =>
      track(deps, name, { via: 'direct', method: 'tools/list', params: req.params, failuresOnly: true }, async () => {
        // A missing capability is a definitive "has no tools" — clear any count
        // from a previous incarnation; any other failure propagates, and track()
        // converts it to an MCP error.
        const result = await emptyOnMissing(async () => (await client()).listTools(req.params));
        deps.recordToolCount(name, result?.tools.length ?? 0);
        return result ?? { tools: [] };
      }),
    );

    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'tools/call', target: req.params.name, params: req.params },
        async () => (await (await client()).callTool(req.params)) as CallToolResult,
      ),
    );
  }

  if (advertised.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'resources/list', params: req.params, failuresOnly: true },
        async () => {
          return (await emptyOnMissing(async () => (await client()).listResources(req.params))) ?? { resources: [] };
        },
      ),
    );

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'resources/templates/list', params: req.params, failuresOnly: true },
        async () => {
          return (
            (await emptyOnMissing(async () => (await client()).listResourceTemplates(req.params))) ?? {
              resourceTemplates: [],
            }
          );
        },
      ),
    );

    server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      track(deps, name, { via: 'direct', method: 'resources/read', target: req.params.uri, params: req.params }, () =>
        client().then((c) => c.readResource(req.params)),
      ),
    );
  }

  // Only where the downstream said it can: a subscribe to a server that cannot
  // is a request that exists to fail.
  if (advertised.resources?.subscribe) {
    server.setRequestHandler(SubscribeRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'resources/subscribe', target: req.params.uri, params: req.params },
        () => client().then((c) => c.subscribeResource(req.params)),
      ),
    );

    server.setRequestHandler(UnsubscribeRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'resources/unsubscribe', target: req.params.uri, params: req.params },
        () => client().then((c) => c.unsubscribeResource(req.params)),
      ),
    );
  }

  if (advertised.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      track(deps, name, { via: 'direct', method: 'prompts/list', params: req.params, failuresOnly: true }, async () => {
        return (await emptyOnMissing(async () => (await client()).listPrompts(req.params))) ?? { prompts: [] };
      }),
    );

    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      track(deps, name, { via: 'direct', method: 'prompts/get', target: req.params.name, params: req.params }, () =>
        client().then((c) => c.getPrompt(req.params)),
      ),
    );
  }

  if (advertised.completions) {
    // Completions fire per keystroke; like list ops, only their failures are recorded.
    server.setRequestHandler(CompleteRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'completion/complete', params: req.params, failuresOnly: true },
        async () => {
          return (await emptyOnMissing(async () => (await client()).complete(req.params))) ?? EMPTY_COMPLETION;
        },
      ),
    );
  }

  if (advertised.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (req) =>
      track(
        deps,
        name,
        { via: 'direct', method: 'logging/setLevel', target: req.params.level, params: req.params },
        async () => {
          await emptyOnMissing(async () => (await client()).setLoggingLevel(req.params.level));
          return {};
        },
      ),
    );
  }

  return server;
}

export interface AggregateDeps extends ProxyDeps {
  /** Names of all enabled servers at request time. */
  serverNames: () => string[];
}

/**
 * MCP server merging all enabled downstream servers (used for /mcp).
 * Tool/prompt names and resource URIs are prefixed `<server>__`; calls strip
 * the prefix and route to the owning client. Downstream servers that fail to
 * connect (or lack a capability) are skipped, not fatal.
 *
 * @param instructions The merged member instructions — see `mergeInstructions`.
 *   Fixed for the life of the session, because `instructions` travels only in
 *   the initialize result.
 */
export function createAggregateServer(deps: AggregateDeps, instructions?: string): Server {
  const server = new Server(
    { name: 'mcp-router', version: SERVER_VERSION },
    // The union: an aggregate never connects its members while a client is
    // initializing, so what any of them might support is the honest answer.
    { capabilities: PROXY_CAPABILITIES, instructions },
  );

  // Aggregate list ops fan out to every enabled server on each client
  // (re)connect and list_changed; see collectFrom for what that does and does
  // not record.
  const collect = <T>(method: string, fn: (client: Client, name: string) => Promise<T[]>): Promise<T[]> =>
    collectFrom(deps.serverNames(), method, deps, fn);

  const route = (full: string, kind: string) => {
    const split = splitNamespacedName(full, deps.serverNames());
    if (!split) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown ${kind} "${full}" (expected <server>__<name>)`);
    }
    return split;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await collect('tools/list', async (client, name) => {
      // A missing capability is a definitive "has no tools" — clear any count
      // from a previous incarnation; any other failure lets collect() skip the
      // server and record why.
      const all = await emptyOnMissing(() => listAllTools(client));
      deps.recordToolCount(name, all?.length ?? 0);
      return (all ?? []).map((tool) => ({ ...tool, name: namespaceName(name, tool.name) }));
    });
    return { tools };
  });

  // Routing runs before track(): a name that resolves to no known server is a
  // caller argument error with no server to attribute it to (the same shape as
  // hitting /mcp/<unknown>, which also 404s unrecorded). Once resolved, every
  // outcome — including downstream failures — is recorded under that server.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { serverName, name } = route(req.params.name, 'tool');
    const params = { ...req.params, name };
    return track(
      deps,
      serverName,
      { via: 'aggregate', method: 'tools/call', target: name, params },
      async () => (await (await deps.getClient(serverName)).callTool(params)) as CallToolResult,
    );
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await collect('resources/list', async (client, name) => {
      const all = await listAllResources(client);
      return all.map((resource) => ({
        ...resource,
        uri: namespaceName(name, resource.uri),
        name: namespaceName(name, resource.name),
      }));
    });
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const resourceTemplates = await collect('resources/templates/list', async (client, name) => {
      const all = await listAllResourceTemplates(client);
      // Namespace the URI template so a read of an expanded URI routes back to
      // this server, mirroring how plain resources namespace their `uri`.
      return all.map((template) => ({
        ...template,
        uriTemplate: namespaceName(name, template.uriTemplate),
        name: namespaceName(name, template.name),
      }));
    });
    return { resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { serverName, name: uri } = route(req.params.uri, 'resource');
    const params = { ...req.params, uri };
    return track(deps, serverName, { via: 'aggregate', method: 'resources/read', target: uri, params }, () =>
      deps.getClient(serverName).then((client) => client.readResource(params)),
    );
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = await collect('prompts/list', async (client, name) => {
      const all = await listAllPrompts(client);
      return all.map((prompt) => ({ ...prompt, name: namespaceName(name, prompt.name) }));
    });
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { serverName, name } = route(req.params.name, 'prompt');
    const params = { ...req.params, name };
    return track(deps, serverName, { via: 'aggregate', method: 'prompts/get', target: name, params }, () =>
      deps.getClient(serverName).then((client) => client.getPrompt(params)),
    );
  });

  // The completion ref is namespaced like the prompt/resource it points at
  // (`<server>__<name>` for prompts, `<server>__<uri>` for resources); strip it
  // to route, then hand the downstream its own un-prefixed ref.
  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    const ref = req.params.ref;
    const full = ref.type === 'ref/prompt' ? ref.name : ref.uri;
    const { serverName, name } = route(full, 'completion ref');
    const strippedRef = ref.type === 'ref/prompt' ? { ...ref, name } : { ...ref, uri: name };
    const params = { ...req.params, ref: strippedRef };
    return track(
      deps,
      serverName,
      { via: 'aggregate', method: 'completion/complete', target: full, params, failuresOnly: true },
      async () => {
        return (
          (await emptyOnMissing(async () => (await deps.getClient(serverName)).complete(params))) ?? EMPTY_COMPLETION
        );
      },
    );
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const { serverName, name: uri } = route(req.params.uri, 'resource');
    const params = { ...req.params, uri };
    return track(deps, serverName, { via: 'aggregate', method: 'resources/subscribe', target: uri, params }, () =>
      deps.getClient(serverName).then((client) => client.subscribeResource(params)),
    );
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const { serverName, name: uri } = route(req.params.uri, 'resource');
    const params = { ...req.params, uri };
    return track(deps, serverName, { via: 'aggregate', method: 'resources/unsubscribe', target: uri, params }, () =>
      deps.getClient(serverName).then((client) => client.unsubscribeResource(params)),
    );
  });

  // setLevel has no ref, so it applies to the whole connection: fan the level
  // out to every member (best-effort — capability-less members are skipped).
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    await collect('logging/setLevel', async (client) => {
      await client.setLoggingLevel(req.params.level);
      return [];
    });
    return {};
  });

  return server;
}
