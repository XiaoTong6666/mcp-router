import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import type { ConfigStore } from '../config/store.ts';
import { BoundedEventStore } from './event-store.ts';
import type { GatewayManager } from './manager.ts';
import { workspaceInstanceKey } from './manager.ts';
import { enabledMembers } from './members.ts';
import { namespaceNotification, pushNotification } from './notifications.ts';
import { createAggregateServer, createProxyServer, type DownstreamIdentity, mergeInstructions } from './proxy.ts';

export interface McpRouterDeps {
  store: ConfigStore;
  manager: GatewayManager;
}

/** Wire a session's proxy Server to relay downstream notifications; returns an unsubscribe. */
type WireRelay = (server: Server) => () => void;

/**
 * Streamable-HTTP MCP endpoints in stateful mode: the initialize request mints
 * a session (its own proxy Server + transport), kept in a map and reused across
 * the session's subsequent POST/GET(SSE)/DELETE requests. A long-lived session
 * is what lets downstream notifications (list_changed, resources/updated, log
 * messages) reach the client over its GET SSE stream.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  const { store, manager } = deps;
  const router = Router();
  /** Live sessions by MCP session id, with a last-touched clock for idle reclamation. */
  interface Session {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
  }
  const sessions = new Map<string, Session>();

  const sessionId = (req: Request): string | undefined => {
    const raw = req.headers['mcp-session-id'];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  /** Drop and close a session, removing it from the map up front so a racing request can't reuse it. */
  const drop = (id: string): void => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }
    sessions.delete(id);
    // close() chains our onclose (which unwires the notification relay); the map delete above
    // makes its own sessions.delete a harmless no-op.
    void session.transport.close();
  };

  /**
   * Reclaim sessions idle past the configured TTL. Run opportunistically on every request
   * rather than on a timer, so there is no background handle to tear down (important for tests
   * and clean shutdown). Idleness is measured from the last request on the session — a client
   * holding only a quiet GET SSE stream is eventually reclaimed and re-initializes on its next call.
   */
  const sweepIdle = (): void => {
    const ttl = store.getSettings().sessionIdleTimeoutMs;
    const cutoff = Date.now() - ttl;
    for (const [id, session] of sessions) {
      if (session.lastActivity < cutoff) {
        drop(id);
      }
    }
  };

  /** Evict least-recently-active sessions until there is room below the cap for one more. */
  const enforceCap = (): void => {
    const max = store.getSettings().maxSessions;
    const overflow = sessions.size - max + 1; // +1 leaves room for the incoming session
    if (overflow <= 0) {
      return;
    }
    const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    for (const [id] of oldestFirst.slice(0, overflow)) {
      drop(id);
    }
  };

  /** Route a request that carries a session id to its existing transport. Returns false if there is none. */
  const resume = async (req: Request, res: Response): Promise<boolean> => {
    sweepIdle();
    const id = sessionId(req);
    if (!id) {
      return false;
    }
    const session = sessions.get(id);
    if (!session) {
      res.status(404).json({ error: `Unknown or expired MCP session "${id}"` });
      return true;
    }
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return true;
  };

  /**
   * Start a new session for an initialize request; anything else without a session id is a 400.
   *
   * `buildServer` may be async because a proxy Server's `instructions` are the downstream's own,
   * and reading them can mean connecting first. It runs after the initialize check, so a
   * malformed request never spawns anything.
   */
  const start = async (
    req: Request,
    res: Response,
    buildServer: () => Server | Promise<Server>,
    wire: WireRelay,
  ): Promise<void> => {
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ error: 'Missing or expired mcp-session-id' });
      return;
    }
    enforceCap();
    const server = await buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      // Per-session bounded buffer so a client whose GET SSE stream drops can reconnect
      // with Last-Event-ID and replay missed notifications; reclaimed with the session.
      eventStore: new BoundedEventStore(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastActivity: Date.now() });
      },
    });
    const unwire = wire(server);
    // Set before connect(): the SDK chains our onclose ahead of its own teardown.
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
      unwire();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const proxyDeps = {
    getClient: (name: string) => manager.getClient(name),
    recordToolCount: (name: string, count: number) => manager.recordToolCount(name, count),
    recordActivity: (name: string, entry: Parameters<GatewayManager['recordActivity']>[1]) =>
      manager.recordActivity(name, entry),
  };

  /**
   * What a 1:1 session re-emits from the downstream's own handshake, connecting first to get it.
   *
   * `instructions` and `capabilities` travel only in the initialize result, so this is the one
   * chance to have them — and this endpoint is a client that asked for exactly this server, so
   * the spawn it costs is one the session was going to pay anyway. A downstream that will not
   * connect still gets its session, and falls back to advertising everything the proxy can
   * relay: the failure belongs on the first request that needs the server, where it carries its
   * own status and the child's stderr, not on initialize.
   */
  const proxyIdentity = async (name: string): Promise<DownstreamIdentity> => {
    await manager.getClient(name).catch(() => {});
    return { instructions: manager.instructions(name), capabilities: manager.capabilities(name) };
  };

  /**
   * The merged instructions for an aggregate session, from whatever its members have already
   * said. Never connects: spawning every member to write a preamble the session may never act
   * on is the trade this endpoint exists to avoid, so a member not yet spawned in this process
   * contributes nothing and is picked up by the next session to initialize after it wakes.
   *
   * @param members Instance keys to read, each with the name it is exposed under (they differ
   *   for a workspace, whose members are keyed `w:<slug>:<server>`).
   */
  const aggregateInstructions = (members: [name: string, key: string][]): string | undefined =>
    mergeInstructions(members.map(([name, key]) => [name, manager.instructions(key)]));

  router.all('/', async (req, res) => {
    if (await resume(req, res)) {
      return;
    }
    const serverNames = () => manager.enabledNames();
    await start(
      req,
      res,
      () =>
        createAggregateServer(
          { ...proxyDeps, serverNames },
          aggregateInstructions(serverNames().map((name) => [name, name])),
        ),
      (server) =>
        manager.onNotification((key, notification) => {
          // enabledNames() lists only base keys, so workspace instances never match here.
          if (serverNames().includes(key)) {
            pushNotification(server, namespaceNotification(notification, key));
          }
        }),
    );
  });

  // Custom aggregate for a workspace: only its enabled members that still exist, run
  // as workspace-scoped downstream instances. Registered before '/:name' so the two
  // path segments never fall through to the per-server route.
  router.all('/w/:slug', async (req, res) => {
    if (await resume(req, res)) {
      return;
    }
    const slug = req.params.slug;
    const workspace = store.getWorkspace(slug);
    if (!workspace || !workspace.enabled) {
      res.status(404).json({ error: `Unknown workspace "${slug}"` });
      return;
    }
    // Re-read the workspace on every call rather than closing over the snapshot
    // taken at initialize: a session outlives config edits, so a member added,
    // removed or disabled afterwards must be reflected on the next tools/list.
    // A workspace deleted or disabled mid-session simply exposes nothing.
    const memberNames = (): string[] => {
      const current = store.getWorkspace(slug);
      return current?.enabled ? enabledMembers(current, store) : [];
    };
    const workspaceDeps = {
      getClient: (name: string) => manager.getClientForWorkspace(slug, name),
      recordToolCount: (name: string, count: number) =>
        manager.recordToolCount(workspaceInstanceKey(slug, name), count),
      // Activity is logged under the workspace-scoped instance key so it surfaces in
      // the workspace's own Activity view, isolated from the base server's log.
      recordActivity: (name: string, entry: Parameters<GatewayManager['recordActivity']>[1]) =>
        manager.recordActivity(workspaceInstanceKey(slug, name), entry),
      serverNames: memberNames,
    };
    await start(
      req,
      res,
      () =>
        createAggregateServer(
          workspaceDeps,
          aggregateInstructions(memberNames().map((name) => [name, workspaceInstanceKey(slug, name)])),
        ),
      (server) =>
        manager.onNotification((key, notification) => {
          // Downstream notifications arrive under the workspace instance key.
          for (const name of memberNames()) {
            if (key === workspaceInstanceKey(slug, name)) {
              pushNotification(server, namespaceNotification(notification, name));
              return;
            }
          }
        }),
    );
  });

  router.all('/:name', async (req, res) => {
    if (await resume(req, res)) {
      return;
    }
    const name = req.params.name;
    const config = store.getServer(name);
    if (!config || !config.enabled) {
      res.status(404).json({ error: `Unknown server "${name}"` });
      return;
    }
    await start(
      req,
      res,
      async () => createProxyServer(name, proxyDeps, await proxyIdentity(name)),
      // 1:1 endpoint: no namespacing, forward the owning server's notifications as-is.
      (server) =>
        manager.onNotification((key, notification) => {
          if (key === name) {
            pushNotification(server, notification);
          }
        }),
    );
  });

  return router;
}
