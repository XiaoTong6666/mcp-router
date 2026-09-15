import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { ConnectCard } from '@/components/domain/connect-card';
import { CopyButton } from '@/components/domain/copy-button';
import { DetailRow } from '@/components/domain/detail-row';
import { ActivityCard } from '@/components/domain/server/activity-card';
import { PromptsCard } from '@/components/domain/server/prompts-card';
import { ResourcesCard } from '@/components/domain/server/resources-card';
import { ToolsCard } from '@/components/domain/server/tools-card';
import { MembersCard } from '@/components/domain/workspace/members-card';
import { WorkspaceDialog } from '@/components/domain/workspace/workspace-dialog';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDeleteWorkspace, useUpdateWorkspace, useWorkspace } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/workspaces_/$slug')({
  component: WorkspaceDetailPage,
});

function WorkspaceDetailPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const query = useWorkspace(slug);
  const { data: workspace } = query;
  const update = useUpdateWorkspace();
  const remove = useDeleteWorkspace();
  const [editOpen, setEditOpen] = useState(false);

  const endpointUrl = `${window.location.origin}/mcp/w/${slug}`;
  const scope = { kind: 'workspace', slug } as const;

  const handleDelete = () => {
    remove.mutate(slug, {
      onSuccess: () => {
        toast.success(`Deleted workspace ${workspace?.name ?? slug}`);
        navigate({ to: '/workspaces' });
      },
      onError: toastApiError,
    });
  };

  return (
    <PageLayout
      icon={
        <ActionButton asChild variant="ghost" size="icon-sm" label="Back to workspaces" tooltip={false}>
          <Link to="/workspaces">
            <ArrowLeftIcon />
          </Link>
        </ActionButton>
      }
      title={workspace?.name ?? slug}
      description={workspace?.description}
      loading={query.isPending}
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <QueryState query={query} what="workspace" count={workspace ? 1 : 0} rows={1} />
          {workspace && (
            <>
              <CardLayout
                title="Overview"
                action={
                  <span className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                      <PencilIcon /> Edit
                    </Button>
                    <ConfirmButton
                      variant="outline"
                      size="sm"
                      label={`Delete ${workspace.name}`}
                      tooltip={false}
                      disabled={remove.isPending}
                      title={`Delete workspace ${workspace.name}?`}
                      description={`The workspace's endpoint (${workspace.path}) stops responding. The underlying servers and their global configuration are not affected.`}
                      onConfirm={handleDelete}
                    >
                      <Trash2Icon className="text-destructive" /> Delete
                    </ConfirmButton>
                  </span>
                }
                contentClassName="flex flex-col gap-3"
                content={
                  <>
                    <DetailRow label="Endpoint">
                      <span className="flex items-center gap-1">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">{endpointUrl}</code>
                        <CopyButton text={endpointUrl} label="Copy endpoint URL" />
                      </span>
                    </DetailRow>
                    <DetailRow label="Status">
                      {workspace.enabled ? (
                        <Badge variant="outline">Enabled</Badge>
                      ) : (
                        <Badge variant="secondary">Disabled</Badge>
                      )}
                    </DetailRow>
                    <DetailRow label="Enabled">
                      <Switch
                        checked={workspace.enabled}
                        disabled={update.isPending}
                        aria-label={`Enable workspace ${slug}`}
                        onCheckedChange={(enabled) =>
                          update.mutate(
                            { slug, enabled },
                            {
                              onSuccess: () => toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${workspace.name}`),
                              onError: toastApiError,
                            },
                          )
                        }
                      />
                    </DetailRow>
                  </>
                }
              />

              <MembersCard workspace={workspace} />

              <Tabs defaultValue="tools">
                <TabsList>
                  <TabsTrigger value="tools">Tools</TabsTrigger>
                  <TabsTrigger value="resources">Resources</TabsTrigger>
                  <TabsTrigger value="prompts">Prompts</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="connect">Connect</TabsTrigger>
                </TabsList>
                <TabsContent value="tools">
                  <ToolsCard scope={scope} />
                </TabsContent>
                <TabsContent value="resources">
                  <ResourcesCard scope={scope} />
                </TabsContent>
                <TabsContent value="prompts">
                  <PromptsCard scope={scope} />
                </TabsContent>
                <TabsContent value="activity">
                  <ActivityCard scope={scope} />
                </TabsContent>
                <TabsContent value="connect">
                  <ConnectCard
                    endpoint={endpointUrl}
                    label={slug}
                    description={`Point an MCP client at this workspace's aggregate endpoint (tools are <server>__-namespaced).`}
                  />
                </TabsContent>
              </Tabs>

              {editOpen && <WorkspaceDialog key={slug} open workspace={workspace} onOpenChange={setEditOpen} />}
            </>
          )}
        </div>
      }
    />
  );
}
