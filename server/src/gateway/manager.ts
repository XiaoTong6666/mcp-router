import { isDeepStrictEqual } from 'node:util';
import {
  type McpConnection,
  McpPool,
  McpPoolError,
  type McpServerConfig,
  type McpServerState,
  type McpStatus,
  MINIMAL_CHILD_ENV,
  type ServerCapabilities,
} from '@cubicecho/agent-mcp-pool';
import type {
  ActivityEntry,
  ServerConfig,
  ServerRuntimeState,
  ServerStatus,
  SettingsFile,
  WorkspaceConfig,
  WorkspaceMember,
} from '@mcp-router/shared';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { HttpError } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';

const CRASH_BACKOFF_MS = 5_000;
/** Max activity entries kept per server (in-memory ring buffer). */
const ACTIVITY_LIMIT = 200;
/** Serialized params/result (and error/target strings) larger than this are truncated before storing. */
const ACTIVITY_VALUE_CHARS = 8_000;

/** Cap a string at `max` chars (never splitting a surrogate pair), appending a truncation marker. */
function truncateString(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  // A high surrogate at the cut point would leave an unpaired half; cut before it.
  const last = value.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${value.slice(0, end)}… [truncated, ${value.length} chars]`;
}

/**
 * Snapshot a recorded params/result into a bounded, detached value.
 *
 * Never retains a reference to the caller's value: a small payload is returned
 * as a fresh structural clone (so it can't pin memory or alias later mutations
 * into the log, yet keeps its shape — the schema's `unknown` stays truthful and
 * the UI can pretty-print it), and an over-large one collapses to a truncation
 * marker string. Serialization is compact so the size budget isn't spent on
 * indentation.
 */
function snapshotValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  if (serialized === undefined) {
    return undefined; // functions / symbols serialize to nothing
  }
  if (serialized.length > ACTIVITY_VALUE_CHARS) {
    return truncateString(serialized, ACTIVITY_VALUE_CHARS);
  }
  return JSON.parse(serialized);
}

/**
 * What the router keeps per managed instance, beside what the pool holds.
 *
 * The pool's own `state()` row is the connection: status, pid, start time, the
 * last error. None of this is — `config` is this repo's discriminated-union
 * shape rather than the flat row the pool was handed, and the call bookkeeping
 * is counted from proxied traffic the pool never sees.
 */
interface ServerMeta {
  config: ServerConfig;
  /** Tool count from the last proxied `tools/list`; cleared when the connection is restarted. */
  toolCount?: number;
  /**
   * The downstream's own `instructions`, as of the last connect.
   *
   * Kept because it is only ever knowable from a live connection — it arrives in
   * the initialize result and nowhere else — while the proxy `Server` that has to
   * re-emit it is constructed when a client initializes, which for the aggregate
   * is long before most of its members have been spawned. Cleared with the config
   * it was read under; a server whose command or env changed is a different
   * server, and stale guidance is worse than none.
   */
  instructions?: string;
  /**
   * What the downstream declared it supports, as of the last connect.
   *
   * Kept for the same reason and on the same terms as `instructions`: it arrives
   * in the initialize result and nowhere else, while the 1:1 proxy `Server` that
   * has to re-declare it is constructed per client session. Cleared with the
   * config it was read under — a server whose command changed may well answer a
   * different set of methods.
   */
  capabilities?: ServerCapabilities;
  /** Count of proxied calls recorded via recordActivity this process (reset on restart). */
  callCount: number;
  /** ISO timestamp of the most recent recorded call. */
  lastCalledAt?: string;
}

/** Map key for a server instance scoped to a workspace. Contains ':' so it never collides with a base server name. */
export function workspaceInstanceKey(slug: string, serverName: string): string {
  return `w:${slug}:${serverName}`;
}

/** True for a workspace-scoped instance key (base keys are plain server names, which cannot contain ':'). */
function isWorkspaceKey(key: string): boolean {
  return key.includes(':');
}

/**
 * Effective downstream config for a server as used by a workspace: the base
 * server config with per-workspace overrides applied. `env`/`headers` merge over
 * the base (workspace wins); `args` replaces the base stdio args and `url` replaces
 * the base streamable-http URL. The config keeps the base server's `name` so
 * aggregate tool namespacing is unaffected; its `enabled` reflects both the
 * workspace and the member being on.
 */
export function resolveMemberConfig(
  base: ServerConfig,
  member: WorkspaceMember,
  workspace: WorkspaceConfig,
): ServerConfig {
  let transport = base.transport;
  if (transport.type === 'stdio' && member.args) {
    transport = { ...transport, args: member.args };
  } else if (transport.type === 'streamable-http' && (member.headers || member.url)) {
    transport = {
      ...transport,
      url: member.url ?? transport.url,
      headers: member.headers ? { ...transport.headers, ...member.headers } : transport.headers,
    };
  }
  return {
    ...base,
    enabled: workspace.enabled && (member.enabled ?? true),
    transport,
    env: member.env ? { ...base.env, ...member.env } : base.env,
  };
}

/**
 * The connection half of a server config as the pool wants it: one flat row
 * rather than this repo's discriminated union.
 */
export function toConnection(config: ServerConfig): McpConnection {
  const { transport } = config;
  return {
    transport: transport.type === 'stdio' ? 'stdio' : 'http',
    command: transport.type === 'stdio' ? transport.command : '',
    args: transport.type === 'stdio' ? transport.args : null,
    cwd: transport.type === 'stdio' ? transport.cwd : null,
    env: config.env,
    url: transport.type === 'streamable-http' ? transport.url : '',
    headers: transport.type === 'streamable-http' ? transport.headers : null,
  };
}

/**
 * One managed instance as a pool row.
 *
 * The instance key is the row's id — a base server's name, or `w:<slug>:<server>`
 * — so a workspace member is an entry of its own with its own child, independent
 * of the base server's. `slug` is left unset and never read: the pool indexes no
 * tools here (see `indexTools` below) and `gateway/naming.ts` owns namespacing.
 */
function toPoolConfig(key: string, config: ServerConfig, settings: SettingsFile): McpServerConfig {
  const stdio = config.transport.type === 'stdio';
  return {
    id: key,
    label: config.displayName ?? config.name,
    enabled: config.enabled,
    ...toConnection(config),
    // After the spread, not before: `connectTimeoutMs` is a field of `McpConnection`
    // as of pool 2.4.0, so a `toConnection` that ever fills it in would otherwise win
    // over the setting resolved here without anything failing to compile.
    //
    // Only a stdio child is worth reaping — it is a process holding memory. A
    // remote connection costs nothing to keep, and 0 is the pool's "never reap".
    // Resolved per row rather than passed to the pool once, because the global
    // default is a setting an operator can edit while the router is running.
    idleTimeoutMs: stdio ? (config.idleTimeoutMs ?? settings.idleTimeoutMs) : 0,
    // Same reason, and the pool re-reads it on every reconcile: bounds spawn plus the
    // MCP initialize handshake, so a server that starts and then never speaks fails the
    // request that woke it instead of holding it open forever. (The SDK's own 60s applies
    // to the initialize *request*, which such a server never gets far enough to answer.)
    connectTimeoutMs: settings.connectTimeoutMs,
  };
}

/**
 * True when two configs differ in a way that restarts the downstream connection.
 *
 * Mirrors the pool's own `sameConnection` — which decides the restart — for the
 * one piece of derived state the router keeps across a reconcile: a tool count
 * read from the old child is not true of a new one.
 */
export function needsRestart(a: ServerConfig, b: ServerConfig): boolean {
  return !isDeepStrictEqual(
    { transport: a.transport, env: a.env, enabled: a.enabled },
    { transport: b.transport, env: b.env, enabled: b.enabled },
  );
}

/** How the pool's connection status reads on this API. `disabled` and `idle` are both "no child, nothing wrong". */
const RUNTIME_STATE: Record<McpStatus, ServerRuntimeState> = {
  disabled: 'stopped',
  idle: 'stopped',
  connecting: 'starting',
  ready: 'running',
  error: 'error',
};

/**
 * One downstream MCP client per managed instance, over `@cubicecho/agent-mcp-pool`.
 *
 * The pool owns the lifecycle — reconciling rows against live children, lazy
 * spawn on first use, idle reap, crash backoff, and the notification relay. What
 * stays here is what the pool has no view of: this repo's config shape, the
 * workspace-scoped instance keys, the proxied-call activity log, and the HTTP
 * status codes the router answers a refusal with.
 */
export class GatewayManager {
  private readonly pool: McpPool;
  private readonly getSettings: () => SettingsFile;
  private readonly meta = new Map<string, ServerMeta>();
  /** In-memory per-server ring buffer of proxied calls, for the Activity tab. */
  private readonly activity = new Map<string, ActivityEntry[]>();
  private activitySeq = 0;

  constructor(getSettings: () => SettingsFile) {
    this.getSettings = getSettings;
    this.pool = new McpPool({
      clientName: 'mcp-router',
      // The other half of `clientInfo`, which is the whole of what a dialled server
      // learns about its caller. The pool used to fill this in with a constant
      // `0.1.0` (upstream agent-mcp-pool#60, fixed in 2.3.0), so downstream logs
      // named a version of nothing beside a name that was ours.
      clientVersion: SERVER_VERSION,
      // Spawn on the first request that needs a server rather than at boot: the
      // router carries dozens of installed servers, most idle most of the time.
      lazy: true,
      // The router proxies `tools/list` through from the client that asked and
      // never reads the pool's index, so draining it on every cold connect would
      // be a round trip per page in front of a user-facing request, for nobody.
      indexTools: false,
      // A stdio child gets this allowlist plus the server's own env, never the
      // router's full process.env — an MCP server is third-party code.
      childEnv: MINIMAL_CHILD_ENV,
      crashBackoffMs: CRASH_BACKOFF_MS,
    });
  }

  /**
   * Sync managed instances with the given server + workspace configs: drop removed,
   * restart changed/disabled, add new. Base servers are keyed by name; each
   * workspace member that references an existing server gets its own isolated
   * downstream instance keyed `w:<slug>:<server>` with per-workspace overrides
   * applied, so a workspace can run a server independently of its global state.
   *
   * Awaiting it is what makes a write visible to the read that follows — the pool
   * serializes reconciles behind whatever it is already doing.
   */
  async reconcile(configs: ServerConfig[], workspaces: WorkspaceConfig[] = []): Promise<void> {
    const byName = new Map(configs.map((c) => [c.name, c]));
    const desired = new Map<string, ServerConfig>(byName);
    for (const workspace of workspaces) {
      for (const [serverName, member] of Object.entries(workspace.members)) {
        const base = byName.get(serverName);
        if (!base) {
          continue; // member references a server that no longer exists
        }
        desired.set(workspaceInstanceKey(workspace.slug, serverName), resolveMemberConfig(base, member, workspace));
      }
    }
    for (const [key, meta] of this.meta) {
      const next = desired.get(key);
      if (!next) {
        this.meta.delete(key);
        this.activity.delete(key);
        continue;
      }
      if (needsRestart(meta.config, next)) {
        // The pool is about to replace the child; a count, an instructions string
        // and a capability set read from the old one stop being true at the same
        // moment.
        meta.toolCount = undefined;
        meta.instructions = undefined;
        meta.capabilities = undefined;
      }
      meta.config = next;
    }
    for (const [key, config] of desired) {
      if (!this.meta.has(key)) {
        this.meta.set(key, { config, callCount: 0 });
      }
    }
    const settings = this.getSettings();
    await this.pool.sync([...desired].map(([key, config]) => toPoolConfig(key, config, settings)));
  }

  /**
   * Connect (spawning if needed) and return the downstream client for the given
   * instance key. Resets the idle timer. For base servers the key is the server
   * name; for workspace-scoped instances use {@link getClientForWorkspace}.
   */
  async getClient(name: string): Promise<Client> {
    let client: Client;
    try {
      client = await this.pool.client(name);
    } catch (cause) {
      this.fail(name, cause);
    }
    const meta = this.meta.get(name);
    if (meta) {
      // Read on every use rather than only on the connects: the SDK kept these
      // from the initialize result, so they are field accesses, and there is no
      // event to hang them off — the pool reaps and respawns children on its own,
      // and each respawn is a fresh handshake that may say something new.
      meta.instructions = client.getInstructions();
      meta.capabilities = client.getServerCapabilities();
    }
    return client;
  }

  /**
   * The downstream's `instructions` as of its last connect, if it has ever
   * connected in this process.
   *
   * Deliberately does not connect: the aggregate endpoint asks this for every
   * member while a client is initializing, and spawning a dozen children to
   * write a preamble the session may never act on is not a trade worth making.
   * The 1:1 endpoint, which has exactly one server and is certain to use it,
   * connects first and then asks.
   */
  instructions(name: string): string | undefined {
    return this.meta.get(name)?.instructions;
  }

  /**
   * The downstream's declared capabilities as of its last connect, if it has ever
   * connected in this process. Deliberately does not connect, for the same reason
   * {@link instructions} does not.
   */
  capabilities(name: string): ServerCapabilities | undefined {
    return this.meta.get(name)?.capabilities;
  }

  /** Connect (spawning if needed) and return the workspace-scoped client for a server. */
  getClientForWorkspace(slug: string, serverName: string): Promise<Client> {
    return this.getClient(workspaceInstanceKey(slug, serverName));
  }

  /**
   * Drop an instance's connection and dial it again.
   *
   * `stop` rather than `reconnect`, though both close the child: `stop` leaves
   * the row idle with its `error`/`failedAt` cleared, so the `getClient` below is
   * the dial, and a restart that fails reports as a 502 carrying the child's
   * stderr. `reconnect` dials the child itself (pool 2.2.0), which lands a failed
   * restart inside a backoff it started a millisecond earlier — the same call
   * would then answer 503 "crashed recently", naming a crash the operator just
   * asked to be retried. Clearing that backoff is what pressing Restart on a
   * crash-looping server is for.
   */
  async restart(name: string): Promise<Client> {
    await this.pool.stop(name);
    return this.getClient(name);
  }

  /**
   * Re-throw one of the pool's refusals as the status this API answers it with.
   *
   * The wording stays the router's own: these strings are part of the REST
   * contract and are read by the UI, while the pool's are written for an agent.
   * `backoff` and `connect-failed` are the pair worth keeping apart — the first
   * means the pool declined to dial, the second that it dialled and could not.
   */
  private fail(key: string, cause: unknown): never {
    if (!(cause instanceof McpPoolError)) {
      throw cause;
    }
    const name = this.meta.get(key)?.config.name ?? key;
    switch (cause.code) {
      case 'unknown-server':
        throw new HttpError(404, `Unknown server "${key}"`, undefined, { cause });
      case 'disabled':
        throw new HttpError(404, `Server "${key}" is disabled`, undefined, { cause });
      case 'backoff':
        throw new HttpError(503, `Server "${name}" crashed recently; retrying is backed off`, cause.detail, { cause });
      default:
        throw new HttpError(502, `Failed to connect to server "${name}"`, cause.detail, { cause });
    }
  }

  /** The pool's connection rows by instance key. Secrets are left out: nothing here reads the row's config. */
  private connectionState(): Map<string, McpServerState> {
    return new Map(this.pool.state().map((row) => [row.id, row]));
  }

  status(name: string): ServerStatus | undefined {
    const meta = this.meta.get(name);
    return meta ? toStatus(meta, this.connectionState().get(name)) : undefined;
  }

  statusAll(): ServerStatus[] {
    const state = this.connectionState();
    // Only base servers are exposed as "servers"; workspace-scoped instances are an internal detail.
    return [...this.meta]
      .filter(([key]) => !isWorkspaceKey(key))
      .map(([key, meta]) => toStatus(meta, state.get(key)))
      .sort((a, b) => a.config.name.localeCompare(b.config.name));
  }

  runningCount(): number {
    return this.pool.state().filter((row) => !isWorkspaceKey(row.id) && row.status === 'ready').length;
  }

  /**
   * Subscribe to downstream server→client notifications. The listener is called
   * with the instance key (base server name, or `w:<slug>:<server>` for a
   * workspace instance) and the raw notification. Returns an unsubscribe function.
   * Used by MCP sessions to relay list_changed / resources/updated / log
   * messages to their upstream client; survives downstream respawns because the
   * pool re-installs the handler on every connect.
   */
  onNotification(listener: (key: string, notification: Notification) => void): () => void {
    return this.pool.onNotification(listener);
  }

  recordToolCount(name: string, count: number): void {
    const meta = this.meta.get(name);
    if (meta) {
      meta.toolCount = count;
    }
  }

  /** Append a proxied call to the server's in-memory activity log (bounded, newest last). */
  recordActivity(name: string, entry: Omit<ActivityEntry, 'id'>): void {
    // Only log for a currently-managed server: an in-flight call that completes
    // after the server was removed (reconcile drops it from both maps) must not
    // resurrect a stray activity entry that then leaks forever. A call that
    // completes right after a Clear legitimately re-populates the log — the
    // server still exists, so that is new activity, not a leak.
    const meta = this.meta.get(name);
    if (!meta) {
      return;
    }
    meta.callCount += 1;
    meta.lastCalledAt = entry.at;
    const log = this.activity.get(name) ?? [];
    log.push({
      ...entry,
      id: ++this.activitySeq,
      // Bound every payload-bearing field, not just params/result: error messages
      // and targets (e.g. data: URIs) can embed arbitrarily large payloads too.
      target: entry.target === undefined ? undefined : truncateString(entry.target, ACTIVITY_VALUE_CHARS),
      error: entry.error === undefined ? undefined : truncateString(entry.error, ACTIVITY_VALUE_CHARS),
      params: snapshotValue(entry.params),
      result: snapshotValue(entry.result),
    });
    if (log.length > ACTIVITY_LIMIT) {
      log.splice(0, log.length - ACTIVITY_LIMIT);
    }
    this.activity.set(name, log);
  }

  /** Recorded activity for a server, newest first (at most ACTIVITY_LIMIT). */
  getActivity(name: string): ActivityEntry[] {
    return [...(this.activity.get(name) ?? [])].reverse();
  }

  clearActivity(name: string): void {
    this.activity.delete(name);
  }

  /** Names of all enabled base servers (for the global aggregate endpoint). */
  enabledNames(): string[] {
    return [...this.meta]
      .filter(([key, meta]) => !isWorkspaceKey(key) && meta.config.enabled)
      .map(([, meta]) => meta.config.name)
      .sort();
  }

  /** Close every downstream client / kill every child process. The manager stays usable. */
  async stopAll(): Promise<void> {
    await this.pool.shutdown();
  }
}

function toStatus(meta: ServerMeta, state: McpServerState | undefined): ServerStatus {
  return {
    config: meta.config,
    state: state ? RUNTIME_STATE[state.status] : 'stopped',
    pid: state?.pid,
    startedAt: state?.startedAt,
    // The pool reports "no error" as an empty string; this API reports it as absent.
    lastError: state?.error || undefined,
    toolCount: meta.toolCount,
    callCount: meta.callCount,
    lastCalledAt: meta.lastCalledAt,
  };
}
