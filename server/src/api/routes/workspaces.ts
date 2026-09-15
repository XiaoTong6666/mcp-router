import { listAllTools } from '@cubicecho/agent-mcp-pool';
import type { WorkspaceConfig, WorkspaceStatus } from '@mcp-router/shared';
import {
  activityResponseSchema,
  createWorkspaceRequestSchema,
  promptGetRequestSchema,
  resourceReadRequestSchema,
  serverNameSchema,
  slugify,
  toolCallRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceConfigSchema,
} from '@mcp-router/shared';
import { Router } from 'express';
import { HttpError } from '../../errors.ts';
import { emptyOnMissing } from '../../gateway/capability.ts';
import { collectFrom } from '../../gateway/fan-out.ts';
import { workspaceInstanceKey } from '../../gateway/manager.ts';
import { enabledMembers, existingMembers } from '../../gateway/members.ts';
import { namespaceName, splitNamespacedName } from '../../gateway/naming.ts';
import { listAllPrompts, listAllResources, listAllResourceTemplates } from '../../gateway/pagination.ts';
import { toolCallFailed, toolErrorText } from '../../gateway/proxy.ts';
import { type DownstreamClient, runUiCall, type UiCallContext } from '../calls.ts';
import type { ApiDeps } from '../deps.ts';

/** Workspace CRUD plus the aggregate's capability listings and test calls, mounted at /api/workspaces. */
export function createWorkspaceRoutes({ store, manager }: ApiDeps): Router {
  const router = Router();

  const workspacePath = (slug: string): string => `/mcp/w/${slug}`;
  const toWorkspaceStatus = (workspace: WorkspaceConfig): WorkspaceStatus => ({
    ...workspace,
    path: workspacePath(workspace.slug),
  });

  const requireWorkspace = (slug: string): WorkspaceConfig => {
    const workspace = store.getWorkspace(slug);
    if (!workspace) {
      throw new HttpError(404, `Unknown workspace "${slug}"`);
    }
    return workspace;
  };

  /** Every member must reference a server that currently exists. */
  const assertMembersExist = (members: Record<string, unknown> | undefined): void => {
    for (const name of Object.keys(members ?? {})) {
      if (!store.getServer(name)) {
        throw new HttpError(400, `Unknown server "${name}" in workspace members`);
      }
    }
  };

  const requireValidSlug = (slug: string): string => {
    const parsed = serverNameSchema.safeParse(slug);
    if (!parsed.success) {
      throw new HttpError(400, `Invalid workspace slug "${slug}"`, 'derive a name that yields a valid URL slug');
    }
    return parsed.data;
  };

  router.get('/', (_req, res) => {
    res.json(store.getWorkspaces().map(toWorkspaceStatus));
  });

  router.post('/', async (req, res) => {
    const request = createWorkspaceRequestSchema.parse(req.body);
    const slug = requireValidSlug(request.slug ?? slugify(request.name));
    if (store.getWorkspace(slug)) {
      throw new HttpError(409, `Workspace "${slug}" already exists`);
    }
    assertMembersExist(request.members);
    const config = workspaceConfigSchema.parse({
      name: request.name,
      slug,
      enabled: request.enabled ?? true,
      description: request.description,
      members: request.members ?? {},
    });
    await store.saveWorkspace(config);
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    res.status(201).json(toWorkspaceStatus(config));
  });

  router.get('/:slug', (req, res) => {
    res.json(toWorkspaceStatus(requireWorkspace(req.params.slug)));
  });

  router.patch('/:slug', async (req, res) => {
    const existing = requireWorkspace(req.params.slug);
    const update = updateWorkspaceRequestSchema.parse(req.body);
    assertMembersExist(update.members);
    // Auto-slug: renaming re-derives the slug (and thus the URL). Keep the old
    // slug when the name is unchanged so member-only edits never move the URL.
    const name = update.name ?? existing.name;
    const slug = update.name !== undefined ? requireValidSlug(slugify(name)) : existing.slug;
    if (slug !== existing.slug && store.getWorkspace(slug)) {
      throw new HttpError(409, `Workspace "${slug}" already exists`);
    }
    const next = workspaceConfigSchema.parse({
      ...existing,
      name,
      slug,
      enabled: update.enabled ?? existing.enabled,
      description: update.description !== undefined ? update.description : existing.description,
      members: update.members ?? existing.members,
    });
    await store.saveWorkspace(next);
    if (slug !== existing.slug) {
      await store.deleteWorkspace(existing.slug);
    }
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    res.json(toWorkspaceStatus(next));
  });

  router.delete('/:slug', async (req, res) => {
    requireWorkspace(req.params.slug);
    await store.deleteWorkspace(req.params.slug);
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    res.status(204).end();
  });

  // --- workspace capabilities (tools/resources/prompts + activity) ---
  //
  // These mirror the per-server capability endpoints but run against each
  // member's workspace-scoped downstream instance (so per-workspace param overrides
  // apply), and present tools/resources/prompts exactly as the /mcp/w/:slug
  // aggregate does — `<server>__`-namespaced. Test calls route by that namespace
  // back to the owning member and record activity under its workspace instance key.

  // Fan a listing out over a workspace's enabled members, exactly as the
  // /mcp/w/:slug aggregate does — same skip-and-record rules (see collectFrom),
  // but against each member's workspace-scoped instance.
  const workspaceCollect = <T>(
    workspace: WorkspaceConfig,
    method: string,
    fn: (client: DownstreamClient, name: string) => Promise<T[]>,
  ): Promise<T[]> =>
    collectFrom(
      enabledMembers(workspace, store),
      method,
      {
        getClient: (name) => manager.getClientForWorkspace(workspace.slug, name),
        recordActivity: (name, entry) => manager.recordActivity(workspaceInstanceKey(workspace.slug, name), entry),
      },
      fn,
      (name) => `member "${name}" of workspace "${workspace.slug}"`,
    );

  // Run one workspace tool/resource/prompt call from the UI: resolve the namespaced
  // name to a member, then invoke + record activity against its workspace instance
  // key (reusing runUiCall, whose `name` is any managed instance key).
  const runWorkspaceUiCall = async (
    workspace: WorkspaceConfig,
    full: string,
    kind: string,
    ctx: Omit<UiCallContext, 'target'>,
    run: (client: DownstreamClient, name: string) => Promise<unknown>,
  ): Promise<unknown> => {
    const split = splitNamespacedName(full, enabledMembers(workspace, store));
    if (!split) {
      throw new HttpError(400, `Unknown ${kind} "${full}" (expected <server>__<name>)`);
    }
    const key = workspaceInstanceKey(workspace.slug, split.serverName);
    return runUiCall(manager, key, { ...ctx, target: split.name }, (client) => run(client, split.name));
  };

  router.get('/:slug/tools', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const tools = await workspaceCollect(workspace, 'tools/list', async (client, name) => {
      const all = await listAllTools(client);
      manager.recordToolCount(workspaceInstanceKey(workspace.slug, name), all.length);
      return all.map((tool) => ({ ...tool, name: namespaceName(name, tool.name) }));
    });
    res.json({ tools });
  });

  router.get('/:slug/resources', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const [resources, resourceTemplates] = await Promise.all([
      workspaceCollect(workspace, 'resources/list', async (client, name) => {
        const all = await emptyOnMissing(() => listAllResources(client));
        return (all ?? []).map((resource) => ({
          ...resource,
          uri: namespaceName(name, resource.uri),
          name: resource.name === undefined ? undefined : namespaceName(name, resource.name),
        }));
      }),
      workspaceCollect(workspace, 'resources/templates/list', async (client, name) => {
        const all = await emptyOnMissing(() => listAllResourceTemplates(client));
        return (all ?? []).map((template) => ({
          ...template,
          uriTemplate: namespaceName(name, template.uriTemplate),
          name: template.name === undefined ? undefined : namespaceName(name, template.name),
        }));
      }),
    ]);
    res.json({ resources, resourceTemplates });
  });

  router.get('/:slug/prompts', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const prompts = await workspaceCollect(workspace, 'prompts/list', async (client, name) => {
      const all = await emptyOnMissing(() => listAllPrompts(client));
      return (all ?? []).map((prompt) => ({ ...prompt, name: namespaceName(name, prompt.name) }));
    });
    res.json({ prompts });
  });

  router.post('/:slug/tools/call', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const body = toolCallRequestSchema.parse(req.body);
    const result = await runWorkspaceUiCall(
      workspace,
      body.name,
      'tool',
      {
        method: 'tools/call',
        params: body,
        failLabel: `Tool "${body.name}" failed`,
        detectFailure: (r) => (toolCallFailed(r) ? toolErrorText(r) : null),
      },
      (client, name) => client.callTool({ name, arguments: body.arguments }),
    );
    res.json(result);
  });

  router.post('/:slug/resources/read', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const body = resourceReadRequestSchema.parse(req.body);
    const result = await runWorkspaceUiCall(
      workspace,
      body.uri,
      'resource',
      { method: 'resources/read', params: body, failLabel: `Resource "${body.uri}" failed to read` },
      (client, uri) => client.readResource({ uri }),
    );
    res.json(result);
  });

  router.post('/:slug/prompts/get', async (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const body = promptGetRequestSchema.parse(req.body);
    const result = await runWorkspaceUiCall(
      workspace,
      body.name,
      'prompt',
      { method: 'prompts/get', params: body, failLabel: `Prompt "${body.name}" failed` },
      (client, name) => client.getPrompt({ name, arguments: body.arguments }),
    );
    res.json(result);
  });

  // Workspace activity merges every member instance's log, newest first. Ids are
  // monotonic per process, so a descending id sort orders across members.
  router.get('/:slug/activity', (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    const entries = existingMembers(workspace, store)
      .flatMap((name) => manager.getActivity(workspaceInstanceKey(workspace.slug, name)))
      .sort((a, b) => b.id - a.id);
    res.json(activityResponseSchema.parse({ entries }));
  });

  router.delete('/:slug/activity', (req, res) => {
    const workspace = requireWorkspace(req.params.slug);
    for (const name of existingMembers(workspace, store)) {
      manager.clearActivity(workspaceInstanceKey(workspace.slug, name));
    }
    res.status(204).end();
  });

  return router;
}
