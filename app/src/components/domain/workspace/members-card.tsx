import type { WorkspaceMember, WorkspaceStatus } from '@mcp-router/shared';
import { toast } from 'sonner';
import { CardLayout } from '@/components/card-layout';
import { ServerStateBadge } from '@/components/domain/server/state-badge';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useServers, useUpdateWorkspace } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

/** Which overrides a member carries, for the "overrides" hint badges. */
function overrideLabels(member: WorkspaceMember): string[] {
  const labels: string[] = [];
  if (member.env && Object.keys(member.env).length > 0) {
    labels.push('env');
  }
  if (member.args && member.args.length > 0) {
    labels.push('args');
  }
  if (member.headers && Object.keys(member.headers).length > 0) {
    labels.push('headers');
  }
  if (member.url) {
    labels.push('url');
  }
  return labels;
}

export function MembersCard({ workspace }: { workspace: WorkspaceStatus }) {
  const { data: servers } = useServers();
  const update = useUpdateWorkspace();

  const memberEntries = Object.entries(workspace.members);

  const toggle = (name: string, member: WorkspaceMember, on: boolean) => {
    // members is a full replacement on update — resend the whole map with this
    // one member's enabled flag flipped, preserving every override.
    const members: Record<string, WorkspaceMember> = {
      ...workspace.members,
      [name]: { ...member, enabled: on },
    };
    update.mutate(
      { slug: workspace.slug, members },
      {
        onSuccess: () => toast.success(`${on ? 'Enabled' : 'Disabled'} ${name} in ${workspace.name}`),
        onError: toastApiError,
      },
    );
  };

  return (
    <CardLayout
      title="Servers"
      description="The servers this workspace exposes. Disable one to drop it from the aggregate without removing its overrides. Edit the workspace to change membership or per-workspace parameters."
      empty={<p className="text-sm text-muted-foreground">This workspace has no servers yet. Edit it to add some.</p>}
      content={
        memberEntries.length > 0 ? (
          <ul className="flex flex-col divide-y">
            {memberEntries.map(([name, member]) => {
              const server = servers?.find((s) => s.config.name === name);
              const enabled = member.enabled ?? true;
              const overrides = overrideLabels(member);
              const isStdio = server?.config.transport.type === 'stdio';
              return (
                <li key={name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Switch
                    checked={enabled}
                    disabled={update.isPending}
                    aria-label={`Enable ${name} in workspace`}
                    onCheckedChange={(on) => toggle(name, member, on)}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{server?.config.displayName || name}</span>
                    {server?.config.displayName && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{name}</span>
                    )}
                    {!server && <span className="ml-2 text-xs text-destructive">not installed</span>}
                    {overrides.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {overrides.map((label) => (
                          <Badge key={label} variant="secondary" className="text-[10px]">
                            {label}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </div>
                  {server && <Badge variant="outline">{isStdio ? 'stdio' : 'http'}</Badge>}
                  {server && <ServerStateBadge state={server.state} lastError={server.lastError} />}
                </li>
              );
            })}
          </ul>
        ) : null
      }
    />
  );
}
