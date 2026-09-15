import { listAllTools } from '@cubicecho/agent-mcp-pool';
import type { ServerConfig, ServerStatus } from '@mcp-router/shared';
import {
  activityResponseSchema,
  installRequestSchema,
  promptGetRequestSchema,
  resourceReadRequestSchema,
  toolCallRequestSchema,
  updateServerRequestSchema,
} from '@mcp-router/shared';
import { Router } from 'express';
import { errorMessage, HttpError } from '../../errors.ts';
import { emptyOnMissing } from '../../gateway/capability.ts';
import { listAllPrompts, listAllResources, listAllResourceTemplates } from '../../gateway/pagination.ts';
import { toolCallFailed, toolErrorText } from '../../gateway/proxy.ts';
import { buildServerConfig, deriveServerName, uninstall } from '../../installer/installer.ts';
import { connect, runUiCall } from '../calls.ts';
import type { ApiDeps } from '../deps.ts';

/** Installed-server CRUD plus its capability listings and test calls, mounted at /api/servers. */
export function createServerRoutes({ store, manager, registryClient, dataDir }: ApiDeps): Router {
  const router = Router();

  const installerDeps = {
    dataDir,
    registryClient,
    getRegistry: (name: string) => store.getRegistry(name),
  };

  const requireStatus = (name: string): ServerStatus => {
    const status = manager.status(name);
    if (!status || !store.getServer(name)) {
      throw new HttpError(404, `Unknown server "${name}"`);
    }
    return status;
  };

  // Connect (spawning if needed) for a listing/call endpoint. A missing server

  router.get('/', (_req, res) => {
    res.json(manager.statusAll());
  });

  router.post('/', async (req, res) => {
    const request = installRequestSchema.parse(req.body);
    const name =
      request.name ??
      (request.source.type === 'registry'
        ? deriveServerName(request.source.serverName)
        : request.source.type === 'npm'
          ? deriveServerName(request.source.package)
          : undefined);
    if (!name) {
      throw new HttpError(400, 'A "name" is required when installing a remote server');
    }
    if (store.getServer(name)) {
      throw new HttpError(409, `Server "${name}" already exists`);
    }
    const config = await buildServerConfig({ ...request, name }, installerDeps);
    await store.saveServer(config);
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    res.status(201).json(requireStatus(config.name));
  });

  router.get('/:name', (req, res) => {
    res.json(requireStatus(req.params.name));
  });

  router.patch('/:name', async (req, res) => {
    const name = req.params.name;
    const existing = store.getServer(name);
    if (!existing) {
      throw new HttpError(404, `Unknown server "${name}"`);
    }
    // The request schema is a plain object, so an omitted field is an absent key
    // (never an explicit undefined) and spreads as "leave it alone". Only
    // idleTimeoutMs needs a hand: null means "clear the override", not "set null".
    const { idleTimeoutMs, ...fields } = updateServerRequestSchema.parse(req.body);
    const next: ServerConfig = { ...existing, ...fields };
    if (idleTimeoutMs === null) {
      delete next.idleTimeoutMs;
    } else if (idleTimeoutMs !== undefined) {
      next.idleTimeoutMs = idleTimeoutMs;
    }
    await store.saveServer(next);
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    res.json(requireStatus(name));
  });

  router.delete('/:name', async (req, res) => {
    const name = req.params.name;
    if (!store.getServer(name)) {
      throw new HttpError(404, `Unknown server "${name}"`);
    }
    await store.deleteServer(name);
    // Before the uninstall, not after: the reconcile is what closes the child,
    // and removing its install directory out from under a live process is how a
    // half-deleted server with a file still open happens.
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    await uninstall(dataDir, name);
    res.status(204).end();
  });

  router.post('/:name/restart', async (req, res) => {
    const name = req.params.name;
    if (!store.getServer(name)) {
      throw new HttpError(404, `Unknown server "${name}"`);
    }
    await manager.restart(name);
    res.json(requireStatus(name));
  });

  // Every listing drains all pages (listAll*), so a downstream that paginates
  // doesn't silently lose items — or, for tools, report a wrong count — past
  // page 1.
  router.get('/:name/tools', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const client = await connect(manager, name);
    const tools = await listAllTools(client);
    manager.recordToolCount(name, tools.length);
    res.json({ tools });
  });

  // A downstream that lacks resources/prompts answers "method not found" (or our
  // client refuses to send). That's not an error for a listing endpoint — it's an
  // empty list, so the UI shows "none reported" rather than a failure.
  router.get('/:name/resources', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const client = await connect(manager, name);
    const [resources, templates] = await Promise.all([
      emptyOnMissing(() => listAllResources(client)),
      // Templates are a supplementary sub-listing: a genuine failure here must not
      // discard a successful resources list, so it is best-effort (missing → null
      // via emptyOnMissing; any other error → warn + null) rather than fatal to the
      // whole endpoint.
      emptyOnMissing(() => listAllResourceTemplates(client)).catch((cause: unknown) => {
        console.warn(`Listing resource templates for "${name}" failed: ${errorMessage(cause)}`);
        return null;
      }),
    ]);
    res.json({
      resources: resources ?? [],
      resourceTemplates: templates ?? [],
    });
  });

  router.get('/:name/prompts', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const client = await connect(manager, name);
    const prompts = await emptyOnMissing(() => listAllPrompts(client));
    res.json({ prompts: prompts ?? [] });
  });

  // Run one tool from the UI. Recorded to the activity log like proxied calls,
  // under via 'ui'. A tool that resolves with `isError: true` is logged not-ok.
  router.post('/:name/tools/call', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const body = toolCallRequestSchema.parse(req.body);
    const result = await runUiCall(
      manager,
      name,
      {
        method: 'tools/call',
        target: body.name,
        params: body,
        failLabel: `Tool "${body.name}" failed`,
        detectFailure: (r) => (toolCallFailed(r) ? toolErrorText(r) : null),
      },
      (client) => client.callTool({ name: body.name, arguments: body.arguments }),
    );
    res.json(result);
  });

  // Read one resource by URI from the UI. Works for a static resource's URI or a
  // concrete URI the caller expanded from a resource template.
  router.post('/:name/resources/read', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const body = resourceReadRequestSchema.parse(req.body);
    const result = await runUiCall(
      manager,
      name,
      { method: 'resources/read', target: body.uri, params: body, failLabel: `Resource "${body.uri}" failed to read` },
      (client) => client.readResource({ uri: body.uri }),
    );
    res.json(result);
  });

  // Get one prompt (with its arguments) from the UI.
  router.post('/:name/prompts/get', async (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    const body = promptGetRequestSchema.parse(req.body);
    const result = await runUiCall(
      manager,
      name,
      { method: 'prompts/get', target: body.name, params: body, failLabel: `Prompt "${body.name}" failed` },
      (client) => client.getPrompt({ name: body.name, arguments: body.arguments }),
    );
    res.json(result);
  });

  router.get('/:name/activity', (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    res.json(activityResponseSchema.parse({ entries: manager.getActivity(name) }));
  });

  router.delete('/:name/activity', (req, res) => {
    const name = req.params.name;
    requireStatus(name);
    manager.clearActivity(name);
    res.status(204).end();
  });

  return router;
}
