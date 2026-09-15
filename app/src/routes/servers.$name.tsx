import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, PencilIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { ConnectCard } from '@/components/domain/connect-card';
import { CopyButton } from '@/components/domain/copy-button';
import { DetailRow } from '@/components/domain/detail-row';
import { ActivityCard } from '@/components/domain/server/activity-card';
import { AddServerDialog } from '@/components/domain/server/add-server-dialog';
import { EnvEditor } from '@/components/domain/server/env-editor';
import { PromptsCard } from '@/components/domain/server/prompts-card';
import { ResourcesCard } from '@/components/domain/server/resources-card';
import { ServerStateBadge } from '@/components/domain/server/state-badge';
import { ToolsCard } from '@/components/domain/server/tools-card';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelativeTime, formatSource } from '@/lib/format';
import { useDeleteServer, useRestartServer, useServer, useUpdateServer } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/servers/$name')({
  component: ServerDetailPage,
});

function ServerDetailPage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const query = useServer(name);
  const { data: server } = query;
  const update = useUpdateServer();
  const restart = useRestartServer();
  const remove = useDeleteServer();
  const [editOpen, setEditOpen] = useState(false);

  const endpointUrl = `${window.location.origin}/mcp/${name}`;

  const handleDelete = () => {
    remove.mutate(name, {
      onSuccess: () => {
        toast.success(`Deleted ${name}`);
        navigate({ to: '/' });
      },
      onError: toastApiError,
    });
  };

  const handleRestart = () => {
    restart.mutate(name, {
      onSuccess: () => toast.success(`Restarted ${name}`),
      onError: toastApiError,
    });
  };

  const handleSaveEnv = (env: Record<string, string>) => {
    update.mutate(
      { name, env },
      {
        onSuccess: () => {
          toast.success('Environment saved', {
            description: 'Restart the server for changes to take effect.',
            action: { label: 'Restart', onClick: handleRestart },
          });
        },
        onError: toastApiError,
      },
    );
  };

  return (
    <PageLayout
      icon={
        <ActionButton asChild variant="ghost" size="icon-sm" label="Back to servers" tooltip={false}>
          <Link to="/">
            <ArrowLeftIcon />
          </Link>
        </ActionButton>
      }
      title={server?.config.displayName ?? name}
      description={server?.config.description}
      loading={query.isPending}
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <QueryState query={query} what="server" count={server ? 1 : 0} rows={1} />
          {server && (
            <>
              <CardLayout
                title="Overview"
                action={
                  <span className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                      <PencilIcon /> Edit
                    </Button>
                    <Button variant="outline" size="sm" disabled={restart.isPending} onClick={handleRestart}>
                      <RotateCwIcon /> Restart
                    </Button>
                    <ConfirmButton
                      variant="outline"
                      size="sm"
                      label={`Delete ${name}`}
                      tooltip={false}
                      disabled={remove.isPending}
                      title={`Delete ${name}?`}
                      description="This stops the server, deletes its config file, and removes its install directory. This cannot be undone."
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
                    <DetailRow label="State">
                      <ServerStateBadge state={server.state} lastError={server.lastError} />
                    </DetailRow>
                    <DetailRow label="Source">
                      <span className="break-all">{formatSource(server.config.source)}</span>
                    </DetailRow>
                    <DetailRow label="Transport">
                      <span className="break-all">
                        {server.config.transport.type === 'stdio'
                          ? `stdio — ${server.config.transport.command} ${server.config.transport.args.join(' ')}`.trim()
                          : `streamable-http — ${server.config.transport.url}`}
                      </span>
                    </DetailRow>
                    <DetailRow label="Enabled">
                      <Switch
                        checked={server.config.enabled}
                        disabled={update.isPending}
                        aria-label={`Enable ${name}`}
                        onCheckedChange={(enabled) =>
                          update.mutate(
                            { name, enabled },
                            {
                              onSuccess: () => toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${name}`),
                              onError: toastApiError,
                            },
                          )
                        }
                      />
                    </DetailRow>
                    {server.pid !== undefined && (
                      <DetailRow label="PID">
                        <span className="tabular-nums">{server.pid}</span>
                      </DetailRow>
                    )}
                    {server.startedAt && (
                      <DetailRow label="Started">
                        <span title={new Date(server.startedAt).toLocaleString()}>
                          {formatRelativeTime(server.startedAt)}
                        </span>
                      </DetailRow>
                    )}
                    {server.state === 'error' && server.lastError && (
                      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                        <p className="font-medium">Last error</p>
                        <p className="break-words whitespace-pre-wrap">{server.lastError}</p>
                      </div>
                    )}
                  </>
                }
              />

              {server.config.transport.type === 'stdio' && (
                <CardLayout
                  title="Environment variables"
                  description="Passed to the server process. Secret values are masked; changes take effect after a restart."
                  content={
                    <EnvEditor
                      key={name}
                      env={server.config.env}
                      envMeta={server.config.envMeta}
                      onSave={handleSaveEnv}
                      saving={update.isPending}
                    />
                  }
                />
              )}

              <Tabs defaultValue="tools">
                <TabsList>
                  <TabsTrigger value="tools">Tools</TabsTrigger>
                  <TabsTrigger value="resources">Resources</TabsTrigger>
                  <TabsTrigger value="prompts">Prompts</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="connect">Connect</TabsTrigger>
                </TabsList>
                <TabsContent value="tools">
                  <ToolsCard scope={{ kind: 'server', name }} />
                </TabsContent>
                <TabsContent value="resources">
                  <ResourcesCard scope={{ kind: 'server', name }} />
                </TabsContent>
                <TabsContent value="prompts">
                  <PromptsCard scope={{ kind: 'server', name }} />
                </TabsContent>
                <TabsContent value="activity">
                  <ActivityCard scope={{ kind: 'server', name }} />
                </TabsContent>
                <TabsContent value="connect">
                  <ConnectCard
                    endpoint={endpointUrl}
                    label={name}
                    description={`Point an MCP client directly at ${name} (tools keep their original names).`}
                  />
                </TabsContent>
              </Tabs>

              {editOpen && <AddServerDialog key={name} open server={server} onOpenChange={setEditOpen} />}
            </>
          )}
        </div>
      }
    />
  );
}
