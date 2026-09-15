import type { CreateWorkspaceRequest, ServerStatus, WorkspaceMember, WorkspaceStatus } from '@mcp-router/shared';
import { slugify } from '@mcp-router/shared';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DialogLayout } from '@/components/dialog-layout';
import { ConnectCard } from '@/components/domain/connect-card';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useCreateWorkspace, useServers, useUpdateWorkspace } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

/** Per-server override text held while editing; parsed into a WorkspaceMember on submit. */
interface OverrideText {
  env: string;
  args: string;
  headers: string;
  url: string;
}

const emptyOverride = (): OverrideText => ({ env: '', args: '', headers: '', url: '' });

const recordToLines = (record?: Record<string, string>): string =>
  Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const linesToRecord = (text: string): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key) {
      record[key] = trimmed.slice(eq + 1).trim();
    }
  }
  return record;
};

const FORM_ID = 'workspace-form';

const textToArgs = (text: string): string[] => text.split('\n').filter((line) => line.trim().length > 0);

interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing workspace; omitted when creating. */
  workspace?: WorkspaceStatus;
}

export function WorkspaceDialog({ open, onOpenChange, workspace }: WorkspaceDialogProps) {
  const isEdit = workspace !== undefined;
  const { data: servers } = useServers();
  const create = useCreateWorkspace();
  const update = useUpdateWorkspace();

  const [name, setName] = useState(workspace?.name ?? '');
  const [enabled, setEnabled] = useState(workspace?.enabled ?? true);
  const [description, setDescription] = useState(workspace?.description ?? '');
  const [members, setMembers] = useState<Set<string>>(
    () => new Set(Object.keys(workspace?.members ?? {}).filter((key) => workspace?.members[key]?.enabled ?? true)),
  );
  const [overrides, setOverrides] = useState<Record<string, OverrideText>>(() => {
    const initial: Record<string, OverrideText> = {};
    for (const [server, member] of Object.entries(workspace?.members ?? {})) {
      initial[server] = {
        env: recordToLines(member.env),
        args: (member.args ?? []).join('\n'),
        headers: recordToLines(member.headers),
        url: member.url ?? '',
      };
    }
    return initial;
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  // Auto-slug: renaming re-derives the URL. In edit mode the URL only moves once
  // the name actually changes, so show the stored slug until then.
  const slug = isEdit && name === workspace.name ? workspace.slug : slugify(name);
  const slugValid = slug.length > 0;

  const toggleMember = (server: string, on: boolean) => {
    setMembers((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(server);
      } else {
        next.delete(server);
        setExpanded((cur) => (cur === server ? null : cur));
      }
      return next;
    });
    if (on) {
      // Seed the URL override for remote members with the base URL so "extending"
      // it (e.g. appending a workspace path) is just editing the tail. Unchanged
      // values are dropped on submit, so this never persists a redundant override.
      const config = servers?.find((s) => s.config.name === server)?.config;
      if (config?.transport.type === 'streamable-http') {
        const baseUrl = config.transport.url;
        setOverrides((prev) =>
          prev[server]?.url ? prev : { ...prev, [server]: { ...emptyOverride(), ...prev[server], url: baseUrl } },
        );
      }
    }
  };

  const setOverride = (server: string, patch: Partial<OverrideText>) => {
    setOverrides((prev) => ({ ...prev, [server]: { ...emptyOverride(), ...prev[server], ...patch } }));
  };

  const buildMembers = (): Record<string, WorkspaceMember> => {
    const result: Record<string, WorkspaceMember> = {};
    for (const server of servers ?? []) {
      const serverName = server.config.name;
      if (!members.has(serverName)) {
        continue;
      }
      const ov = overrides[serverName] ?? emptyOverride();
      const member: WorkspaceMember = { enabled: true };
      if (server.config.transport.type === 'stdio') {
        const env = linesToRecord(ov.env);
        if (Object.keys(env).length > 0) {
          member.env = env;
        }
        const args = textToArgs(ov.args);
        if (args.length > 0) {
          member.args = args;
        }
      } else {
        const headers = linesToRecord(ov.headers);
        if (Object.keys(headers).length > 0) {
          member.headers = headers;
        }
        // Only persist a URL override when it actually differs from the base URL.
        const url = ov.url.trim();
        if (server.config.transport.type === 'streamable-http' && url && url !== server.config.transport.url) {
          member.url = url;
        }
      }
      result[serverName] = member;
    }
    return result;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !slugValid) {
      toast.error('Enter a workspace name that produces a valid URL slug');
      return;
    }
    const body: CreateWorkspaceRequest = {
      name: trimmedName,
      enabled,
      description: description.trim() || undefined,
      members: buildMembers(),
    };
    if (isEdit) {
      update.mutate(
        { slug: workspace.slug, ...body },
        {
          onSuccess: (updated) => {
            toast.success(`Saved workspace ${updated.name}`);
            onOpenChange(false);
          },
          onError: toastApiError,
        },
      );
    } else {
      create.mutate(body, {
        onSuccess: (created) => {
          toast.success(`Created workspace ${created.name}`);
          onOpenChange(false);
        },
        onError: toastApiError,
      });
    }
  };

  const pending = create.isPending || update.isPending;
  const endpoint = useMemo(() => `${window.location.origin}/mcp/w/${workspace?.slug ?? ''}`, [workspace?.slug]);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={isEdit ? `Edit ${workspace.name}` : 'New workspace'}
      description="A workspace exposes a custom aggregate of the servers you choose at its own URL, with optional per-workspace parameter overrides. Each server runs isolated per workspace, independent of its global enabled state."
      footerActions={(close) => (
        <>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={pending || !slugValid}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create workspace'}
          </Button>
        </>
      )}
      content={
        <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FormField
            label="Workspace name"
            descriptionClassName="font-mono"
            description={
              <>
                {slugValid ? `/mcp/w/${slug}` : 'Enter a name to generate the URL'}
                {isEdit && slugValid && slug !== workspace.slug && ' — renaming moves the URL'}
              </>
            }
            control={
              <Input value={name} placeholder="Acme backend" onChange={(event) => setName(event.target.value)} />
            }
          />

          <FormField
            label="Description (optional)"
            control={
              <Input
                value={description}
                placeholder="What this workspace is for"
                onChange={(event) => setDescription(event.target.value)}
              />
            }
          />

          <FormField
            orientation="horizontal"
            label="Enabled"
            description="When off, the workspace's endpoint returns 404 without deleting it."
            control={<Switch checked={enabled} onCheckedChange={setEnabled} />}
          />

          <FormField
            asGroup
            label="Servers"
            description="Choose which servers this workspace exposes. Expand a server to override its parameters for this workspace only."
            control={
              <div className="divide-y rounded-md border">
                {(servers ?? []).length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No servers installed yet.</p>
                )}
                {(servers ?? []).map((server) => (
                  <MemberRow
                    key={server.config.name}
                    server={server}
                    included={members.has(server.config.name)}
                    expanded={expanded === server.config.name}
                    override={overrides[server.config.name] ?? emptyOverride()}
                    onToggle={(on) => toggleMember(server.config.name, on)}
                    onExpandToggle={() =>
                      setExpanded((cur) => (cur === server.config.name ? null : server.config.name))
                    }
                    onOverrideChange={(patch) => setOverride(server.config.name, patch)}
                  />
                ))}
              </div>
            }
          />

          {isEdit && enabled && (
            <ConnectCard
              endpoint={endpoint}
              label={workspace.slug}
              description="Point an MCP client at this workspace's aggregate endpoint."
            />
          )}
        </form>
      }
    />
  );
}

interface MemberRowProps {
  server: ServerStatus;
  included: boolean;
  expanded: boolean;
  override: OverrideText;
  onToggle: (on: boolean) => void;
  onExpandToggle: () => void;
  onOverrideChange: (patch: Partial<OverrideText>) => void;
}

function MemberRow({
  server,
  included,
  expanded,
  override,
  onToggle,
  onExpandToggle,
  onOverrideChange,
}: MemberRowProps) {
  const isStdio = server.config.transport.type === 'stdio';
  const name = server.config.name;
  const baseUrl = server.config.transport.type === 'streamable-http' ? server.config.transport.url : undefined;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-3">
        <Switch checked={included} onCheckedChange={onToggle} aria-label={`Include ${name}`} />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{server.config.displayName || name}</span>
          {server.config.displayName && <span className="ml-2 text-xs text-muted-foreground">{name}</span>}
        </div>
        <Badge variant="outline">{isStdio ? 'stdio' : 'http'}</Badge>
        {included && (
          <Button type="button" variant="ghost" size="sm" onClick={onExpandToggle}>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Overrides
          </Button>
        )}
      </div>

      {included && expanded && (
        <div className="flex flex-col gap-3 pl-11">
          {isStdio ? (
            <>
              <FormField
                label="Env overrides (KEY=VALUE per line)"
                labelClassName="text-xs"
                description="Merged over the server's env; workspace values win."
                control={
                  <Textarea
                    rows={3}
                    className="resize-y font-mono text-xs"
                    placeholder={'API_KEY=workspace-specific-value'}
                    value={override.env}
                    onChange={(event) => onOverrideChange({ env: event.target.value })}
                  />
                }
              />
              <FormField
                label="Arguments (one per line)"
                labelClassName="text-xs"
                description="Replaces the server's args entirely when set."
                control={
                  <Textarea
                    rows={3}
                    className="resize-y font-mono text-xs"
                    placeholder={'leave blank to use the server defaults'}
                    value={override.args}
                    onChange={(event) => onOverrideChange({ args: event.target.value })}
                  />
                }
              />
            </>
          ) : (
            <>
              <FormField
                label="URL override"
                labelClassName="text-xs"
                description="Replaces the server's URL for this workspace — e.g. append a path to scope a shared upstream. Leave as the base URL to inherit it."
                control={
                  <Input
                    className="font-mono text-xs"
                    placeholder={baseUrl ?? 'https://example.com/mcp'}
                    value={override.url}
                    onChange={(event) => onOverrideChange({ url: event.target.value })}
                  />
                }
              />
              <FormField
                label="Header overrides (KEY=VALUE per line)"
                labelClassName="text-xs"
                description="Merged over the server's request headers."
                control={
                  <Textarea
                    rows={3}
                    className="resize-y font-mono text-xs"
                    placeholder={'Authorization=Bearer workspace-token'}
                    value={override.headers}
                    onChange={(event) => onOverrideChange({ headers: event.target.value })}
                  />
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
