# SPECS.md — MCP Router

An MCP gateway/router: install MCP servers from registries or npm, run them
locally (stdio) or point at remote ones (streamable HTTP), and re-expose every
one of them over streamable HTTP — per-server routes, one merged aggregate, and
per-**workspace** custom aggregates. Managed through a React web UI and
hand-editable flat config files.

## Decisions (locked)

| Question | Decision |
| --- | --- |
| Exposure | Per-server routes `/mcp/<name>` **and** aggregate `/mcp` with namespaced tools (`<server>__<tool>`) **and** per-workspace custom aggregates `/mcp/w/<slug>` |
| Workspaces | Custom aggregates: a named subset of servers at `/mcp/w/<slug>` (slug auto-derived from name); per-member `env`/`args`/`headers`/`url` overrides; each member runs as an isolated downstream instance (key `w:<slug>:<server>`), so a workspace scope is fully independent of a server's global enabled state; effective enabled = `workspace.enabled && member.enabled` |
| Auth | Single bearer token (env `MCP_ROUTER_TOKEN` or generated into `settings.json` on first run); protects `/api/*` and `/mcp*`; can be disabled via `authEnabled: false` or the `SECURE_LOCAL_NET=true` env var (trusted-network escape hatch, overrides settings) |
| stdio lifecycle | Lazy spawn on first request, kept warm, killed after idle timeout (default 5 min, per-server override) |
| Secrets | Plaintext values in the JSON config files, written with mode 0600 |
| Config | Flat files under `DATA_DIR/config`; watched for changes (chokidar) + explicit `POST /api/reload` |
| First registry | `https://registry.modelcontextprotocol.io` (API `GET /v0/servers`, server.json schema 2025-12-11), seeded as `official` |
| Stack | TypeScript everywhere, npm workspaces (`shared`, `server`, `app`), Express 5, MCP TS SDK, React 19 + Vite + Tailwind + shadcn/ui + TanStack Router/Query, Biome, Vitest |
| Server runtime | Node ≥22.18 type stripping in dev (`node --watch src/index.ts`), `tsc` build (`rewriteRelativeImportExtensions`) for prod/Docker |
| Deploy | Single Docker image: build app + server, Express serves `app/dist` statically; `docker-compose.yml` with a `data/` volume |
| Shared agent packages | **`@cubicecho/agent-mcp-pool` adopted.** `gateway/manager.ts` is an adapter over its `McpPool`; `gateway/naming.ts` stays local. `@cubicecho/agent-core` is an OpenAI-compatible agent loop and this repo makes no LLM calls — still out, see below |

## Layout & contracts

```
mcp-router/
├── shared/          # zod schemas + types (DONE — the contract, see shared/src/)
│   ├── config.ts    #   settings.json / registries.json / servers/<name>.json / workspaces/<slug>.json schemas
│   ├── registry.ts  #   MCP registry API response schemas
│   └── api.ts       #   REST DTOs (/api/*)
├── server/          # Express + MCP SDK backend        [Track A]
├── app/             # Vite + React + shadcn web UI     [Track B]
├── Dockerfile, docker-compose.yml, README.md           [Track C]
└── data/            # runtime, gitignored: config/, servers/<name>/ (npm prefixes), logs
```

### Flat config files (`DATA_DIR/config`, default `./data/config`)

- `settings.json` — port, authToken, authEnabled, default idleTimeoutMs,
  connectTimeoutMs, session TTL/cap
- `registries.json` — `{ registries: [{ name, url }] }`, seeded with `official`
- `servers/<name>.json` — one file per installed server (`serverConfigSchema`):
  name, enabled, source (registry | npm | pypi | remote), transport (stdio
  command/args | streamable-http url/headers), env (plaintext), envMeta (UI hints
  from the registry), idleTimeoutMs. npm packages install into
  `servers/<name>/` and run as `node <bin>`; pypi packages run as `uvx <pkg>`
  (uv resolves/caches on spawn, no install dir)
- `workspaces/<slug>.json` — one file per workspace (`workspaceConfigSchema`): name,
  slug (matches the filename), enabled, description, `members` — a map of server
  name → `{ enabled, env?, args?, headers?, url? }`. Overrides merge over the
  base server config (`env`/`headers` shallow-merged, `args`/`url` replaced) for
  that workspace's instance only; `url` re-points a remote member's
  streamable-http endpoint (e.g. to scope a shared upstream to a workspace path);
  members whose server no longer exists are skipped

### Management REST API (`/api`, bearer auth)

| Method & path | Purpose |
| --- | --- |
| `GET /api/status` | RouterStatus |
| `GET /api/registries` / `POST` / `DELETE /api/registries/:name` | manage registries |
| `GET /api/registries/:name/servers?search=&cursor=&limit=` | proxy search of the registry (`RegistryListResponse`) |
| `GET /api/registries/:name/servers/:serverName` | registry entry detail (latest version) |
| `GET /api/servers` | `ServerStatus[]` (config + runtime state) |
| `POST /api/servers` | install (`InstallRequest`: from registry entry, raw npm package, or remote URL) |
| `GET /api/servers/:name` | single `ServerStatus` |
| `PATCH /api/servers/:name` | `UpdateServerRequest` (env, enabled, transport, …) → persists to its JSON file |
| `DELETE /api/servers/:name` | stop, delete config file, remove `data/servers/<name>` install dir |
| `POST /api/servers/:name/restart` | kill + respawn (used after env edits) |
| `GET /api/servers/:name/tools` | connect (spawning if needed) and list downstream tools |
| `GET /api/servers/:name/resources` | connect and list downstream resources + resource templates (empty when unsupported) |
| `POST /api/servers/:name/resources/read` | read one resource by URI from the UI (`ResourceReadRequest`); recorded to activity as via 'ui' |
| `GET /api/servers/:name/prompts` | connect and list downstream prompts (empty when unsupported) |
| `POST /api/servers/:name/prompts/get` | get one prompt with arguments from the UI (`PromptGetRequest`); recorded to activity as via 'ui' |
| `GET /api/servers/:name/activity` / `DELETE` | in-memory log of proxied calls (`ActivityResponse`) for the Activity tab; DELETE clears it |
| `GET /api/workspaces` | `WorkspaceStatus[]` (config + derived endpoint `path`) |
| `POST /api/workspaces` | create (`CreateWorkspaceRequest`); slug auto-derived from name, 409 on collision, 400 if a member references a missing server |
| `GET /api/workspaces/:slug` | single `WorkspaceStatus` |
| `PATCH /api/workspaces/:slug` | `UpdateWorkspaceRequest` (name, enabled, description, members); a name change re-derives the slug and moves the file/endpoint |
| `DELETE /api/workspaces/:slug` | delete the workspace file (underlying servers untouched) |
| `POST /api/reload` | re-read all config from disk, reconcile running processes |

Errors: non-2xx with `{ error, detail? }`. Validation via the shared zod schemas.

### MCP endpoints (streamable HTTP, bearer auth)

- `POST/GET/DELETE /mcp/<name>` — proxy to that server: tools, resources,
  resource templates, prompts, completions, logging, and resource subscriptions
  forwarded 1:1; downstream `list_changed` / `resources/updated` / log
  notifications relayed back
- `POST/GET/DELETE /mcp` — aggregate: merges all *enabled* servers; tools,
  resources, resource templates, and prompts namespaced `<server>__`; calls,
  completions, and subscriptions strip the prefix and route to the owning
  downstream client; `logging/setLevel` fans out to every member; relayed
  notifications are re-namespaced
- `POST/GET/DELETE /mcp/w/<slug>` — a workspace's custom aggregate: same
  `<server>__` namespacing, but only over that workspace's enabled members, each
  served by its own isolated (override-applied) downstream instance
- **`instructions` forwarded.** A 1:1 endpoint serves the downstream's own
  `instructions` verbatim; an aggregate serves a merged document — a preamble
  naming the `<server>__` prefix, then one `## <server>` section per member that
  has any. `instructions` travels only in the initialize result, so a 1:1
  session connects before it constructs its proxy `Server` (a spawn that
  endpoint was going to pay anyway); an aggregate never does, and reads only
  what its members have already said in this process
- **`capabilities` forwarded too, on the 1:1 endpoint.** It rides the same
  initialize result and the same connect, so it costs nothing more: `/mcp/<name>`
  declares what the downstream declared, narrowed to the surfaces this proxy
  relays, and registers a request handler for exactly those. A tools-only server
  is a tools-only endpoint — asking it for resources is `MethodNotFound`, which
  is true, rather than an empty list, which reads as a server that has resources
  and happens to have none. `resources.subscribe` is the one that mattered most:
  it was claimed unconditionally, so a client was invited to send a subscribe
  that only its own failure would answer. `listChanged` is mirrored rather than
  asserted, since this endpoint relays such a notification and never originates
  one. A downstream that would not connect falls back to the full set — claiming
  too much costs a client one empty round trip, claiming too little costs it the
  surface. An aggregate keeps the union: its members are deliberately not
  connected while a client initializes, so what any of them might support is the
  only honest answer
- **Stateful sessions:** `initialize` mints an `Mcp-Session-Id` reused across the
  session's requests and its GET SSE stream (which carries relayed
  notifications); a non-initialize request with no session id → 400, an
  unknown/expired session id → 404
- Reverse-direction capabilities (sampling / elicitation / roots) are **not**
  offered downstream — see Phase 4 F7 for the shared-client blocker
- Disabled servers 404. Disabled or unknown workspaces 404. Auth failures 401
  before any MCP handling.

---

## How the `@cubicecho/agent-*` packages are used

Reviewed 2026-09-06, re-reviewed 2026-09-08 against `agent-core@2.2.4` and
`agent-mcp-pool@2.5.0`.

**`@cubicecho/agent-core` — wrong layer, still closed.** It is the
endpoint-agnostic half of an OpenAI-compatible agent loop: capability
negotiation, schema compatibility, on-demand tool loading, streamed turns, a
run-event bus, retry, and a pooled `OpenAI` client — with `openai` as a required
peer dependency. The 2.x API reshuffled that surface but did not change what it
is for. This repo is a gateway; it makes no model calls and has no run to
instrument, so there is nothing for any of it to attach to. The one module with
a plausible home — `schema-compat`'s `sanitizeTools`/`relaxTools`, to normalize
downstream tool schemas at the aggregate endpoint — is a *client* concern: a
gateway should forward a server's schema faithfully and let the consumer decide
what its inference endpoint will accept. Reopen only if the router grows an
agent of its own.

**`@cubicecho/agent-mcp-pool` — adopted, pool and all.** Every objection raised
in the first two reviews is now closed upstream: lazy connect with idle reap
([#8](https://github.com/cubicecho/agent-mcp-pool/issues/8)), a raw `Client` via
`client(id)` ([#9](https://github.com/cubicecho/agent-mcp-pool/issues/9)), stdio
`cwd` plus a notification relay
([#10](https://github.com/cubicecho/agent-mcp-pool/issues/10)), a discriminated
`McpPoolError` carrying `retryAt` and the child's stderr
([#50](https://github.com/cubicecho/agent-mcp-pool/issues/50)), `pid` and
`startedAt` on `state()` ([#49](https://github.com/cubicecho/agent-mcp-pool/issues/49)),
a paginated `tools/list` drain ([#47](https://github.com/cubicecho/agent-mcp-pool/issues/47)),
`openai` off the dependency tree ([#48](https://github.com/cubicecho/agent-mcp-pool/issues/48)),
and — the last one, shipped in `2.1.0` — `indexTools: false`
([#56](https://github.com/cubicecho/agent-mcp-pool/issues/56)), which skips the
tool-list drain on connect. That drain was the blocker: this repo proxies
`tools/list` straight through from the client that asked and never reads the
index, so indexing put a full paginated listing in front of every cold
user-facing request and held a second copy of every tool.

`gateway/manager.ts` is now a thin adapter, and owns only what the pool does not
model:

- **Instance keys.** The pool is keyed by a flat `id`, so a workspace member is
  registered under `w:<slug>:<server>` with its overrides already resolved. That
  is what makes a member an instance independent of the global server, and it is
  what `isWorkspaceKey` filters back out of the base-server views.
- **Config translation.** `toPoolConfig` flattens this repo's discriminated-union
  `ServerConfig` into the pool's row and resolves `idleTimeoutMs` per row —
  `config.idleTimeoutMs ?? settings.idleTimeoutMs` for a stdio child, and `0`
  ("never reap") for a remote connection, which costs nothing to hold open. It is
  resolved at reconcile rather than passed to the pool once, because the global
  default is a setting an operator can edit while the router is running.
- **Router-only bookkeeping.** Tool counts, call counts, last-called timestamps
  and the activity ring live in `meta` and `activity`; the pool tracks
  connections, not usage.
- **HTTP mapping.** `McpPoolError` codes become statuses: `unknown-server` and
  `disabled` → 404, `backoff` → 503, anything else → 502 with the child's stderr
  as `detail`. `api/calls.ts` passes an `HttpError` through untouched so a route
  cannot flatten the 503 back into a 502.

Two behaviours changed with the adoption, both accepted:

- **`reconcile()` is async.** `pool.sync()` is queued, so every caller now awaits
  it — a route that writes config and then reads status has to, or it reads the
  state from before its own write.
- **Remote servers share the crash backoff.** It used to apply to stdio children
  only; the pool applies it to every entry. An unreachable remote server now
  answers 503 for `crashBackoffMs` after a failed connect instead of redialling
  on every request, which is the better behaviour anyway.

**`2.2.0` closed [#58](https://github.com/cubicecho/agent-mcp-pool/issues/58)**,
which asked for a `stop(id)` and for `reconnect` to be pinned down against a
lazy pool. Both landed, and `restart(name)` is now `stop` + `getClient` rather
than `reconnect`: `stop` leaves the row idle with its `error`/`failedAt`
cleared, so the `getClient` *is* the dial and a restart that fails answers 502
carrying the child's stderr. `reconnect` dials the child itself, which lands a
failed restart inside the backoff it started a millisecond earlier — the next
request would answer 503 "crashed recently", naming a crash the operator just
asked to be retried. Clearing that backoff is what pressing Restart on a
crash-looping server is *for*. Delete still needs neither: it reconciles (which
closes the child) before removing the install directory.

**`connectTimeoutMs` is a router setting now.** A child that spawns and then
never speaks used to hold its request open forever — the MCP SDK's own 60s
applies to the `initialize` *request*, which such a child never gets far enough
to answer. `settings.connectTimeoutMs` (default 60s, generous because a first
`uvx`/`npx` spawn may resolve and download a package before it says anything)
resolves per row in `toPoolConfig` beside `idleTimeoutMs`, and a wedged child
now fails the request that woke it. It was constructor-only when it landed,
which meant a restart to change it; `2.4.0` closed
[#62](https://github.com/cubicecho/agent-mcp-pool/issues/62)/[#64](https://github.com/cubicecho/agent-mcp-pool/issues/64)
and the pool re-reads it on every reconcile, applying it at the next connect —
an edited timeout is no reason to bounce a running child.

**`2.3.0` closed [#60](https://github.com/cubicecho/agent-mcp-pool/issues/60)**,
the hardcoded `clientInfo.version` of `0.1.0`. The pool now takes a
`clientVersion` beside its `clientName`, and the router passes `SERVER_VERSION`
— so `clientInfo`, which is the whole of what a dialled server learns about its
caller and the only thing it can log or gate on, is now true in both halves
rather than one. A manager test calls a fixture tool that reads
`getClientVersion()` back out of the child.

**Nothing is left open upstream from this adoption.** The last one,
[#63](https://github.com/cubicecho/agent-mcp-pool/issues/63) — `sync()` or
`reconnect()` with no `configs`, on a pool built without `load()`, silently
closing and forgetting every server — is fixed in `2.4.1` (a reconcile with
neither now throws). It never bit this repo, which always passes `configs`; it
was a trap for the next caller.

Four releases since, none of which changes an interface this repo holds.
`2.4.2` closed [#66](https://github.com/cubicecho/agent-mcp-pool/issues/66) —
the exported standalone `probe` dropped the row's `connectTimeoutMs` that
`2.4.0` widened `McpConnection` to carry — and `2.4.3` closed
[#67](https://github.com/cubicecho/agent-mcp-pool/issues/67), where the timeout
bounded each *request* rather than the connect, so a paginated `tools/list` on
a cold connect multiplied it by the page count. A `requestBudget` countdown is
now shared by `initialize` and every page, and the exported `listAllTools`
reads its `timeout` as the budget for the whole walk.

Neither reached the router, for the same two reasons. It calls no probe of
either kind — "Test connection" goes through `manager.getClient`, so it is
dialled by the pool on the row's own patience — and `indexTools: false` means
there was no `tools/list` drain on a connect to multiply. `connectTimeoutMs`
here bounds spawn plus `initialize` and nothing else, which is what the setting
claims, and after `2.4.3` that is what it would bound even with the drain on.
The paginated walk the router *does* do is its own `gateway/pagination.ts`, on a
proxied request rather than on a connect, so the pool's export is not in that
path either. `2.4.4`'s fix to `resultText` — embedded resources and resource
links reaching a model as `[resource content]` — is likewise out of reach: that
helper flattens a tool result into a string for an agent loop, and this repo
forwards `CallToolResult` untouched.

**`2.5.0` puts `instructions` and `capabilities` on `state()`**
([#70](https://github.com/cubicecho/agent-mcp-pool/issues/70)), so a consumer
can read either without `client()` dialling an idle server to hand back a whole
client for one field. The router keeps reading both off the client in
`getClient`, because it already holds one there and because it needs them to
outlive the connection: `state()` clears them when a child is reaped, by design,
while the aggregate's merged `instructions` is built from whatever its members
have *ever* said in this process. What the release is used for here is the
`ServerCapabilities` re-export, which lets `proxy.ts` and `manager.ts` type the
field without reaching into the SDK's module layout.

The capability half of it is what prompted the endpoint change above. The pool's
`Client` is constructed without `enforceStrictCapabilities`, so the SDK sends a
request for a surface the server never declared and lets it come back
`MethodNotFound` — which `emptyOnMissing` then turns into an empty list. That is
the right behaviour for a *call*, and the wrong thing to build a *handshake* on:
the proxy was declaring five surfaces for every server regardless of what stood
behind it. Reading `getServerCapabilities()` at the one connect the 1:1 endpoint
already makes for `instructions` costs nothing and makes the declaration true.

**Nothing is open on `agent-mcp-pool`, and nothing this repo can reach is open
on `agent-core`.** That package moved `2.2.2` → `2.2.4` over the same window:
token counting per content part, a produced latch read off what a chunk carried,
a refused temperature told from a refused value, model names in negotiation
notices. Its one open issue,
[#61](https://github.com/cubicecho/agent-core/issues/61), is a `side-task.ts`
latch that turns the no-thinking hints off after any unrecognised 400. All of it
is inside the run loop this repo does not have, so the "wrong layer" finding
above is unchanged by it.

**Namespacing stays here regardless.** The pool truncates `<slug>__<tool>` to 64
characters for OpenAI's function-name limit and resolves by whole-string lookup,
while `gateway/naming.ts` splits names a *foreign* MCP client invented,
longest-prefix-first, and applies the same scheme to resource URIs and prompt
names. Unifying on the truncation corrupts resource URIs. Full adoption of the
pool leaves `naming.ts` untouched, as predicted.

## Work items

`[ ]` open · `[x]` done · Tracks A/B/C are parallel; items within a track are ordered.

### Phase 0 — Foundation (done inline)

- [x] 0.1 npm workspace root: `package.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`
- [x] 0.2 `shared/` package: config-file schemas, registry API schemas, REST DTOs
- [x] 0.3 SPECS.md, AGENTS.md, initial commit

### Track A — Server (`server/`)

- [x] A1 Package scaffold: `server/package.json` (deps: express@5, @modelcontextprotocol/sdk, zod, chokidar), `tsconfig.json` (emits to `dist/`, `rewriteRelativeImportExtensions`), `src/index.ts` entry
- [x] A2 Config store (`src/config/`): load/validate/write `settings.json`, `registries.json`, `servers/*.json` via shared schemas; atomic writes (tmp+rename, mode 0600); seed defaults on first run (official registry, generated auth token → log it once); chokidar watcher (debounced) emitting typed change events; `reload()` for the API
- [x] A3 Auth middleware: bearer check for `/api` and `/mcp`; constant-time compare; skipped when `authEnabled: false`; `GET /api/status` reports authEnabled
- [x] A4 Registry client (`src/registry/`): fetch + zod-parse `GET {url}/v0/servers` (search, cursor, version=latest) and single-server detail; per-registry base URL; friendly errors for unreachable/invalid registries
- [x] A5 Installer (`src/installer/`): `npm install --prefix data/servers/<name> <pkg>@<ver>` via execFile (no shell); derive stdio transport: resolve installed package `bin` → `node <binPath>` (+ registry runtimeArguments/packageArguments where value is fixed); map registry `environmentVariables` → `envMeta`; build `ServerConfig` from an `InstallRequest` for all three source types; uninstall = rm install dir
- [x] A6 Process/connection manager (`src/gateway/manager.ts`): per-server downstream MCP `Client` — stdio: lazy spawn (`StdioClientTransport`, env = process env allowlist + config env), idle timer, restart-on-crash backoff, capture stderr tail for `lastError`; remote: `StreamableHTTPClientTransport` with headers; expose `getClient(name)`, `status(name)`, `stop(name)`, `reconcile(configs)` for reload
- [x] A7 Per-server MCP endpoint (`src/gateway/route.ts`): `StreamableHTTPServerTransport` per session at `/mcp/:name`; proxy tools/resources/prompts list + call/read/get to the downstream client; propagate downstream errors as MCP errors
- [x] A8 Aggregate MCP endpoint (`/mcp`): merged capability lists with `<server>__` prefix; route calls by prefix; skip (and log) servers that fail to connect rather than failing the whole list
- [x] A9 Management REST API (`src/api/`): all routes from the table above, zod-validated, wired to config store + installer + manager; JSON error envelope
- [x] A10 Static serving: in production serve `app/dist` with SPA fallback (exclude `/api`, `/mcp`); dev uses Vite proxy
- [x] A11 Server tests (Vitest): config store round-trip + validation, auth middleware, installer transport derivation (mock execFile), registry client parsing (fixture from the real API), aggregate namespacing/routing logic

### Track B — Web UI (`app/`)

- [x] B1 Package scaffold: Vite + React 19 + TS, Tailwind, shadcn/ui (`components.json`, `src/components/ui/`), TanStack Router (file-based, `src/routes/`) + TanStack Query; `@/` alias; dev proxy `/api` + `/mcp` → `localhost:3001`
- [x] B2 API client (`src/lib/api.ts`): typed fetch wrapper using `@mcp-router/shared` DTOs; bearer token from localStorage; 401 → token prompt screen (token entry stored locally)
- [x] B3 Layout: sidebar nav (Servers, Browse, Registries, Settings), header with router status (running/total from `GET /api/status`), toast feedback (sonner)
- [x] B4 Servers page (`/`): list installed servers — state badge (stopped/starting/running/error), transport type, tool count; enable/disable toggle; restart + delete (confirm dialog) actions
- [x] B5 Server detail (`/servers/$name`): config overview incl. endpoint URL with copy button; **env var editor** — table of vars from `envMeta` ∪ `env`, secret values masked with reveal, add/remove arbitrary vars; save → PATCH then offer restart; show `lastError` when state is error; tools list (from `GET /api/servers/:name/tools`)
- [x] B6 Browse/install page (`/browse`): registry picker, search box (debounced), cursor-paginated results; install dialog: local name (prefilled, validated against `serverNameSchema`), package/remote selector when multiple, required env vars (from `environmentVariables`, secrets masked) → `POST /api/servers`
- [x] B7 Direct npm install (on `/browse`): "Install from npm" form — package name, version (default latest), local name, env vars → `InstallRequest` with `source.type: 'npm'`
- [x] B8 Registries page (`/registries`): list/add/remove registries (`createRegistryRequestSchema` validation); official registry undeletable-by-default hint
- [x] B9 Settings page (`/settings`): show auth status + port; **Reload config** button (`POST /api/reload`) with result toast; link to config dir docs
- [x] B10 UI tests: api-client 401 handling, env editor add/edit/mask behavior, install dialog validation (Vitest + Testing Library)

### Track C — Deploy & docs

- [x] C1 `Dockerfile`: multi-stage — `npm ci` + build shared/server/app → slim `node:22` runtime with `server/dist`, `app/dist`, production node_modules; `ENV DATA_DIR=/data`, `VOLUME /data`, `EXPOSE 3000`; needs npm available at runtime (installer shells out to it)
- [x] C2 `docker-compose.yml`: single service, `./data:/data` bind mount, `MCP_ROUTER_TOKEN` via env/`.env`, restart policy, healthcheck on `/api/status`
- [x] C3 `README.md`: what it is, quickstart (docker compose + bare node), config file reference with examples, API + MCP endpoint reference, how to point Claude/other clients at `/mcp` and `/mcp/<name>`, security notes (plaintext secrets, bearer token)

### Phase 3 — Workspaces (custom aggregates)

- [x] P1 Shared contract: `workspaceMemberSchema` / `workspaceConfigSchema` +
  `slugify()` in `shared/src/config.ts`; `workspaceStatusSchema` (adds `path`),
  `createWorkspaceRequestSchema`, `updateWorkspaceRequestSchema` in `shared/src/api.ts`
- [x] P2 Config store: load/validate/write `workspaces/<slug>.json` (keyed by
  slug, warn on slug/filename mismatch); `getWorkspaces`/`getWorkspace`/`saveWorkspace`/
  `deleteWorkspace`; workspaces included in the reload snapshot
- [x] P3 Gateway manager: instances keyed by explicit key (base = name,
  workspace = `w:<slug>:<server>`); `resolveMemberConfig` merges overrides;
  `reconcile(configs, workspaces)` builds workspace instances; `getClientForWorkspace`;
  base-only views (`statusAll`/`enabledNames`/`runningCount`) exclude workspace keys
- [x] P4 Workspace MCP endpoint `/mcp/w/:slug` (reuses `createAggregateServer` with
  workspace-scoped `getClient`/`serverNames`); 404 on disabled/unknown workspace
- [x] P5 REST API: `/api/workspaces` CRUD (auto-slug, collision + member-exists
  validation, rename-re-slugs); every `reconcile` call now passes workspaces
- [x] P6 Web UI: Workspaces nav item + `/workspaces` list route (URL + copy, server
  count, enabled badge, edit/delete); `WorkspaceDialog` (name→slug preview, member
  toggles, per-member override editors, ConnectCard in edit mode)
- [x] P7 Tests: manager workspace-instance behavior (overrides, isolation from
  global disable, drop-on-remove); API auto-slug/validation/rename/gating

### Phase 4 — Full MCP proxy (complete protocol passthrough)

The gateway now proxies the request/response core **and** the streaming half of
the protocol (F1–F6): completions, resource subscriptions, logging, and
downstream→client change/resource/log notifications ride a stateful session.
The one remaining gap (F7, reverse-direction sampling/elicitation/roots) is
blocked by the shared-downstream-client architecture and is documented below.

- [x] F1 Aggregate resource templates: `createAggregateServer` fans out
  `resources/templates/list` and namespaces `uriTemplate` + `name` (was
  hardcoded `[]`), matching the per-server endpoint; test in `proxy.test.ts`
- [x] F2 Completions (`completion/complete`): `CompleteRequestSchema` handlers on
  both proxy servers; per-server forwards 1:1 via `client.complete()`; aggregate
  strips the `<server>__` prefix off the `ref` (prompt name or resource `uri`) and
  routes to the owning client; degrades to an empty `completion.values` when the
  downstream lacks the capability. Recorded failures-only (fires per keystroke)
- [x] F3 **Stateful sessions (foundational).** `gateway/routes.ts` now runs the
  exposed `StreamableHTTPServerTransport` session-backed (`sessionIdGenerator` →
  `randomUUID`): the `initialize` request mints a session kept in a
  `Map<sessionId, transport>`, reused across the session's `POST`/`GET`(SSE)/
  `DELETE` and torn down on transport close. Non-initialize requests without a
  session `400`; unknown/expired session ids `404`. Downstream client lifecycle
  (lazy spawn, idle timeout) unchanged. Real-client end-to-end test in `api.test.ts`
- [x] F4 Change notifications: `PROXY_CAPABILITIES` advertises `listChanged: true`
  for tools / resources / prompts. `GatewayManager` exposes a notification bus
  (`onNotification`) fed by each downstream client's `fallbackNotificationHandler`
  (re-installed on every reconnect, so it survives respawns); each session
  subscribes and relays `notifications/{tools,resources,prompts}/list_changed` to
  its client (aggregate/workspace sessions relay for any member)
- [x] F5 Resource subscriptions: advertises `resources: { subscribe: true }`;
  `resources/subscribe` + `resources/unsubscribe` handlers forward to the downstream
  client (aggregate strips the `<server>__` URI prefix); downstream
  `notifications/resources/updated` is relayed to the subscribing session with the
  URI re-namespaced on the aggregate/workspace path (`namespaceNotification`)
- [x] F6 Logging passthrough: advertises the `logging` capability; `logging/setLevel`
  forwards to the downstream client (per-server) or fans out to every member
  (aggregate); downstream `notifications/message` is relayed over the same bus as F4
- [ ] F7 Reverse-direction (server→client) capabilities — **blocked by the
  shared-client model.** Sampling / elicitation / roots require forwarding a
  *downstream→router* request out to a specific *upstream* MCP client. But one
  downstream `Client` is shared across all sessions (lazy-spawned, idle-killed), and
  an incoming server→client request carries no correlation to whichever upstream
  session's tool call provoked it — so the router cannot attribute it to a session.
  Doing this soundly requires **per-session (or per-request) downstream instances**
  instead of the shared client, a larger architecture change. Until then the router
  advertises none of these to downstream servers (they degrade gracefully). Track as
  its own phase: (a) key downstream instances by session, (b) offer `sampling`/
  `elicitation`/`roots` on the downstream `Client`, (c) forward each request to the
  session's upstream client and its response back, (d) gate behind config since it
  exposes the host client's LLM/user to downstream servers
- [x] F8 Tests + docs: unit tests for each handler's forward + namespace-strip +
  capability-degrade path (`proxy.test.ts`), `namespaceNotification`
  (`notifications.test.ts`), and a real-MCP-client session-lifecycle test plus
  400/404 session-guard tests (`api.test.ts`); MCP-endpoints section of this file
  and `README.md` updated. Live notification-relay against
  `@modelcontextprotocol/server-everything` remains a manual e2e smoke (needs a
  spawned downstream that emits them)
- [x] F9 `instructions` passthrough: `createProxyServer`/`createAggregateServer`
  take an `instructions` string for `ServerOptions`; `manager` caches each
  downstream's `getInstructions()` on every `getClient` and clears it with the
  config it was read under; `mergeInstructions` builds the aggregate document
  (preamble + `## <server>` sections, members with nothing to say skipped,
  `undefined` when none have any); `routes.ts` connects before building a 1:1
  proxy `Server` and reads the cache without connecting for the aggregates.
  Covered by unit tests in `proxy.test.ts`/`manager.test.ts` and an end-to-end
  test in `api.test.ts` driving real `StreamableHTTPClientTransport` clients

### Phase 2 — Integration (after tracks merge)

- [x] I1 `npm run check` (biome + tsc all packages) and `npm test` green
- [x] I2 End-to-end smoke: install a real server from the official registry (e.g. `@modelcontextprotocol/server-everything`), set an env var in the UI, connect an MCP client to `/mcp/<name>` and `/mcp`, call a tool through both
- [x] I3 Config reload smoke: hand-edit a server JSON, `POST /api/reload`, verify reconcile
- [x] I4 Docker smoke: `docker compose up`, repeat I2 against the container

### Phase 5 — MCP transport hardening (spec compliance)

Gaps found reviewing `/mcp*` against the Streamable HTTP transport spec. The SDK
(`@modelcontextprotocol/sdk` 1.29, `StreamableHTTPServerTransport`) already
covers most of it: crypto session ids, `MCP-Protocol-Version` validation (400 on
unsupported), `Accept`-header checks, 400/404 session guards, GET SSE for relayed
notifications, DELETE termination. These are the remaining items.

- [x] H1 **Session leak — idle eviction + cap.** `sessions` in
  `gateway/routes.ts` only dropped an entry when the client sent `DELETE` (the
  SDK fires `onclose`/`onsessionclosed` *only* on DELETE — a GET-stream abort or
  a client that just disappears never closes the session), so a long-running
  gateway accumulated dead sessions (each holding a proxy `Server` + notification
  subscription) unbounded. Now each session carries a `lastActivity` clock bumped
  on every request; an opportunistic `sweepIdle()` on each request reclaims
  sessions idle past `settings.sessionIdleTimeoutMs` (default 30 min), and
  `enforceCap()` evicts the least-recently-active down to `settings.maxSessions`
  (default 1000) before minting a new one. No background timer (nothing to tear
  down). Covered by fake-clock idle-reclaim and cap-eviction tests in `api.test.ts`.
- [x] H2 **Origin validation / DNS-rebinding protection.** `createOriginMiddleware`
  (`auth.ts`) now fronts `/mcp` (before auth, so it applies even when
  `SECURE_LOCAL_NET` drops auth): requests with no `Origin` (native clients) or a
  loopback origin pass, plus any `settings.allowedOrigins`; a foreign origin — what
  a DNS-rebound browser page carries — gets 403. A `HOST` env / `settings.host`
  lets operators bind `127.0.0.1` (default still binds all interfaces for
  Docker/LAN). Covered by `isLoopbackOrigin` + middleware tests in `auth.test.ts`;
  README settings block updated. Spec: servers SHOULD validate `Origin` and SHOULD
  bind localhost when local.
- [x] H3 **SSE resumability (`EventStore` / `Last-Event-ID`).** Done — each
  session's transport now gets a per-session `BoundedEventStore`
  (`gateway/event-store.ts`): an insertion-ordered map capped at 256 events
  (oldest evicted first) so memory stays bounded across long-lived sessions.
  Event ids are `${streamId}_${zero-padded monotonic counter}`, so a single
  forward pass replays exactly the same-stream events after the `Last-Event-ID`
  anchor; a missing/aged-out anchor degrades gracefully to "nothing to replay".
  The SDK drives priming/replay on GET streams for protocol `>= 2025-11-25`.
  Covered by `gateway/__tests__/event-store.test.ts` (replay ordering,
  cross-stream isolation, cap eviction, stream-id lookup). Spec: client MAY
  resume a broken stream via `Last-Event-ID`; server SHOULD support it.
