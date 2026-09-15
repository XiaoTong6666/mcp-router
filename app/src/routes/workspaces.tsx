import type { WorkspaceStatus } from '@mcp-router/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { LayersIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { CopyButton } from '@/components/domain/copy-button';
import { WorkspaceDialog } from '@/components/domain/workspace/workspace-dialog';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDeleteWorkspace, useWorkspaces } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
});

/** create → the New button; edit → a specific workspace; null → closed. */
type DialogState = { mode: 'create' } | { mode: 'edit'; workspace: WorkspaceStatus } | null;

function WorkspacesPage() {
  const workspaces = useWorkspaces();
  const { data } = workspaces;
  const remove = useDeleteWorkspace();
  const [dialog, setDialog] = useState<DialogState>(null);

  return (
    <PageLayout
      title="Workspaces"
      description="Custom aggregates: expose a chosen subset of servers at their own URL, with optional per-workspace parameter overrides."
      action={
        <Button onClick={() => setDialog({ mode: 'create' })}>
          <PlusIcon /> New workspace
        </Button>
      }
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <QueryState
            query={workspaces}
            what="workspaces"
            count={data?.length ?? 0}
            empty={
              <CardLayout
                icon={<LayersIcon />}
                title="No workspaces yet"
                description="Create a workspace to expose a tailored aggregate endpoint for a specific client or workspace."
                content={
                  <Button onClick={() => setDialog({ mode: 'create' })}>
                    <PlusIcon /> New workspace
                  </Button>
                }
              />
            }
          />

          {data && data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Servers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((workspace) => {
                  const memberCount = Object.values(workspace.members).filter((m) => m.enabled ?? true).length;
                  return (
                    <TableRow key={workspace.slug}>
                      <TableCell className="font-medium">
                        <Link to="/workspaces/$slug" params={{ slug: workspace.slug }} className="hover:underline">
                          {workspace.name}
                        </Link>
                        {workspace.description && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {workspace.description}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                          {workspace.path}
                          <CopyButton
                            text={`${window.location.origin}${workspace.path}`}
                            label={`Copy URL for ${workspace.path}`}
                          />
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {memberCount} {memberCount === 1 ? 'server' : 'servers'}
                      </TableCell>
                      <TableCell>
                        {workspace.enabled ? (
                          <Badge variant="outline">Enabled</Badge>
                        ) : (
                          <Badge variant="secondary">Disabled</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <ActionButton
                          variant="ghost"
                          size="icon-sm"
                          label={`Edit ${workspace.name}`}
                          onClick={() => setDialog({ mode: 'edit', workspace })}
                        >
                          <PencilIcon />
                        </ActionButton>
                        <ConfirmButton
                          variant="ghost"
                          size="icon-sm"
                          label={`Delete ${workspace.name}`}
                          title={`Delete workspace ${workspace.name}?`}
                          description={`The workspace's endpoint (${workspace.path}) stops responding. The underlying servers and their global configuration are not affected.`}
                          onConfirm={() =>
                            remove.mutate(workspace.slug, {
                              onSuccess: () => toast.success(`Deleted workspace ${workspace.name}`),
                              onError: toastApiError,
                            })
                          }
                        >
                          <Trash2Icon className="text-destructive" />
                        </ConfirmButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {dialog && (
            <WorkspaceDialog
              key={dialog.mode === 'edit' ? dialog.workspace.slug : 'new'}
              open
              onOpenChange={(open) => !open && setDialog(null)}
              workspace={dialog.mode === 'edit' ? dialog.workspace : undefined}
            />
          )}
        </div>
      }
    />
  );
}
