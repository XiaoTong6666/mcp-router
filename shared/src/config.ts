import { z } from 'zod';

/**
 * Schemas for the flat config files stored under DATA_DIR/config.
 * These files are hand-editable; parsing is always lenient on unknown keys
 * so user additions survive round-trips.
 */

/** A server name doubles as its route segment (/mcp/<name>) and its install dir. */
export const serverNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase alphanumerics, dots, dashes, underscores; must start alphanumeric');

// --- registries.json ---

export const registrySchema = z
  .object({
    /** Unique short name, e.g. "official" */
    name: serverNameSchema,
    /** Base URL of an MCP-registry-API-compatible service, e.g. https://registry.modelcontextprotocol.io */
    url: z.string().url(),
  })
  .passthrough();

export const registriesFileSchema = z
  .object({
    registries: z.array(registrySchema).default([]),
  })
  .passthrough();

export type Registry = z.infer<typeof registrySchema>;
export type RegistriesFile = z.infer<typeof registriesFileSchema>;

export const DEFAULT_REGISTRY: Registry = {
  name: 'official',
  url: 'https://registry.modelcontextprotocol.io',
};

// --- settings.json ---

export const settingsFileSchema = z
  .object({
    /** HTTP port. Env PORT wins over this. */
    port: z.number().int().positive().default(3000),
    /** Bearer token for the management API and MCP endpoints. Env MCP_ROUTER_TOKEN wins.
     *  Generated on first run when auth is enabled and no token exists. */
    authToken: z.string().nullable().default(null),
    /** Disable to allow unauthenticated access (trusted networks only). */
    authEnabled: z.boolean().default(true),
    /** Network interface to bind. Env HOST wins. Unset binds all interfaces (needed for Docker/LAN
     *  exposure); set to 127.0.0.1 to restrict to localhost. */
    host: z.string().optional(),
    /** Extra browser Origins allowed to reach /mcp, for DNS-rebinding protection. Loopback origins
     *  are always allowed and native MCP clients send no Origin; add browser-based clients here. */
    allowedOrigins: z.array(z.string()).default([]),
    /** Default idle shutdown for stdio child processes (per-server override wins). */
    idleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),
    /** Idle lifetime of an MCP streamable-HTTP session before the router reclaims it.
     *  Sessions normally end on a client DELETE; this bounds ones abandoned without one
     *  (a client that drops its stream and never returns), counted from its last request or
     *  from when its GET SSE stream closed; a session holding that stream open is never
     *  reclaimed. Reclaimed sessions 404 on the next request — which the MCP SDK's client does
     *  not recover from on its own, hence the exemption. */
    sessionIdleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    /** Hard cap on concurrent live MCP sessions; the least-recently-active are evicted past it. */
    maxSessions: z.number().int().positive().default(1000),
    /** How long a downstream connect — spawn plus the MCP initialize handshake — may take before
     *  the router gives up and reports the server as failed. Bounds a child that starts and then
     *  never speaks; the MCP SDK's own 60s applies to the initialize *request*, which such a child
     *  never gets far enough to answer. Generous by default because a first `uvx`/`npx` spawn may
     *  resolve and download the package before it says anything. Like `idleTimeoutMs` it is
     *  re-read on every reconcile, and applies at the next connect — an edited timeout is no
     *  reason to bounce a running child. */
    connectTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60 * 1000),
  })
  .passthrough();

export type SettingsFile = z.infer<typeof settingsFileSchema>;

// --- servers/<name>.json ---

export const serverSourceSchema = z.discriminatedUnion('type', [
  /** Installed from a configured registry. */
  z.object({
    type: z.literal('registry'),
    /** Name of the registry in registries.json */
    registry: z.string(),
    /** Registry server name, e.g. "io.github.owner/repo" */
    serverName: z.string(),
    version: z.string().optional(),
  }),
  /** Installed directly from npm, no registry involved. */
  z.object({
    type: z.literal('npm'),
    package: z.string(),
    version: z.string().optional(),
  }),
  /** A PyPI package run via `uvx`, no registry involved. */
  z.object({
    type: z.literal('pypi'),
    package: z.string(),
    version: z.string().optional(),
  }),
  /** A remote streamable-http/sse server we merely proxy to. Nothing installed. */
  z.object({
    type: z.literal('remote'),
  }),
]);

export const serverTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    /** Executable, e.g. "node" or an absolute bin path. */
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
  }),
]);

/** UI metadata for one env var, sourced from the registry's environmentVariables. */
export const envVarMetaSchema = z
  .object({
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
    choices: z.array(z.string()).optional(),
  })
  .passthrough();

export const serverConfigSchema = z
  .object({
    name: serverNameSchema,
    displayName: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    source: serverSourceSchema,
    transport: serverTransportSchema,
    /** Env vars passed to the child process (stdio) or sent as headers is NOT done here —
     *  headers for remote servers live on the transport. Values are plaintext. */
    env: z.record(z.string()).default({}),
    /** Describes known env vars for UI rendering; keys are env var names. */
    envMeta: z.record(envVarMetaSchema).default({}),
    /** Override the global stdio idle shutdown. */
    idleTimeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

export type ServerSource = z.infer<typeof serverSourceSchema>;
export type ServerTransport = z.infer<typeof serverTransportSchema>;
export type EnvVarMeta = z.infer<typeof envVarMetaSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;

// --- workspaces/<slug>.json ---

/**
 * A server's participation in a workspace, with optional per-workspace parameter
 * overrides. When any override is set the server runs as its own downstream
 * process for that workspace (keyed separately from the shared base instance);
 * with no overrides it still runs isolated under the workspace. Merge semantics:
 * `env` and `headers` are merged over the base server's values (workspace keys
 * win); `args` and `url` replace the base value entirely when present.
 */
export const workspaceMemberSchema = z
  .object({
    /** Include this server in the workspace aggregate. Absent members are not in the workspace. */
    enabled: z.boolean().default(true),
    /** Env vars merged over the base server's env (stdio children). */
    env: z.record(z.string()).optional(),
    /** Replaces the base server's stdio args entirely when set. */
    args: z.array(z.string()).optional(),
    /** Headers merged over the base server's headers (remote streamable-http). */
    headers: z.record(z.string()).optional(),
    /** Replaces the base server's streamable-http URL entirely when set (remote members) —
     *  e.g. to scope a shared upstream to a workspace-specific path. */
    url: z.string().url().optional(),
  })
  .passthrough();

/** A named custom aggregate exposing a chosen subset of servers at /mcp/w/<slug>. */
export const workspaceConfigSchema = z
  .object({
    /** Human-facing display name. */
    name: z.string().min(1).max(100),
    /** URL slug — the route segment at /mcp/w/<slug>, also the config filename. */
    slug: serverNameSchema,
    /** Disable to 404 the workspace's endpoint without deleting it. */
    enabled: z.boolean().default(true),
    description: z.string().optional(),
    /** Members keyed by base server name. Only listed servers are in the workspace. */
    members: z.record(workspaceMemberSchema).default({}),
  })
  .passthrough();

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/** Derive a URL slug (a valid serverNameSchema value) from a display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-') // non-slug chars → single dash
    .replace(/^[^a-z0-9]+/, '') // must start alphanumeric
    .replace(/[-.]+$/, '') // no trailing dash/dot
    .slice(0, 64);
}
