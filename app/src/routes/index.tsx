import { createFileRoute, Link } from '@tanstack/react-router';
import { CompassIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { ConnectCard } from '@/components/domain/connect-card';
import { AddServerDialog } from '@/components/domain/server/add-server-dialog';
import { ServerList } from '@/components/domain/server/list';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useServers } from '@/lib/queries';

export const Route = createFileRoute('/')({
  component: ServersPage,
});

function ServersPage() {
  const servers = useServers();
  const { data } = servers;
  const [addOpen, setAddOpen] = useState(false);

  return (
    <PageLayout
      title="Servers"
      description="Installed MCP servers and their runtime state."
      action={
        <Button onClick={() => setAddOpen(true)}>
          <PlusIcon /> Add server
        </Button>
      }
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <QueryState
            query={servers}
            what="servers"
            count={data?.length ?? 0}
            empty={
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                  <p className="text-sm text-muted-foreground">No servers installed yet.</p>
                  <div className="flex gap-2">
                    <Button onClick={() => setAddOpen(true)}>
                      <PlusIcon /> Add server
                    </Button>
                    <Button variant="outline" asChild>
                      <Link to="/browse">
                        <CompassIcon /> Browse registries
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            }
          />

          {data && data.length > 0 && (
            <>
              <ServerList servers={data} />
              <ConnectCard
                endpoint={`${window.location.origin}/mcp`}
                label="mcp-router"
                description="Point an MCP client at the aggregate endpoint to get every enabled server's tools, namespaced as <server>__<tool>."
              />
            </>
          )}

          {addOpen && <AddServerDialog open onOpenChange={setAddOpen} />}
        </div>
      }
    />
  );
}
