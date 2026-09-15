import { useStore } from '@tanstack/react-form';
import { createFileRoute } from '@tanstack/react-router';
import { RotateCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { PageLayout } from '@/components/page-layout';
import { QueryError } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useReloadConfig, useRouterStatus, useUpdateSettings } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

/** Inline editor for the default idle timeout, entered in minutes. */
function IdleTimeoutEditor({ currentMs }: { currentMs: number }) {
  const update = useUpdateSettings();
  const form = useAppForm({
    defaultValues: { minutes: String(currentMs / 60_000) },
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync({ idleTimeoutMs: Math.round(Number(value.minutes) * 60_000) });
        toast.success('Idle timeout saved', { description: 'Applies from each server’s next use.' });
      } catch (error) {
        toastApiError(error);
      }
    },
  });
  const minutes = Number(useStore(form.store, (state) => state.values.minutes));
  const valid = Number.isFinite(minutes) && minutes > 0;
  const changed = valid && Math.round(minutes * 60_000) !== currentMs;

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <form.Field name="minutes">
        {(field) => (
          <Input
            value={field.state.value}
            inputMode="decimal"
            aria-label="Idle timeout in minutes"
            aria-invalid={!valid}
            className="h-8 w-20 tabular-nums"
            onBlur={field.handleBlur}
            onChange={(event) => field.handleChange(event.target.value)}
          />
        )}
      </form.Field>
      <span className="text-muted-foreground">minutes</span>
      <form.AppForm>
        <form.SubmitButton size="sm" variant="outline" disabled={!changed}>
          Save
        </form.SubmitButton>
      </form.AppForm>
    </form>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function SettingsPage() {
  const status = useRouterStatus();
  const { data } = status;
  const reload = useReloadConfig();
  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

  const handleReload = () => {
    reload.mutate(undefined, {
      onSuccess: () => toast.success('Configuration reloaded', { description: 'Running servers were reconciled.' }),
      onError: toastApiError,
    });
  };

  return (
    <PageLayout
      title="Settings"
      description="Router status and configuration."
      width="prose"
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <CardLayout
            title="Router"
            loading={status.isPending}
            contentClassName="flex flex-col gap-3"
            content={
              status.error ? (
                <QueryError error={status.error} onRetry={() => status.refetch()} what="status" />
              ) : (
                data && (
                  <>
                    <Row label="Version">{data.version}</Row>
                    <Row label="Uptime">{formatUptime(data.uptimeSeconds)}</Row>
                    <Row label="Port">{port}</Row>
                    <Row label="Servers">
                      {data.runningCount}/{data.serverCount} running
                    </Row>
                    <Row label="Idle timeout">
                      <IdleTimeoutEditor key={data.idleTimeoutMs} currentMs={data.idleTimeoutMs} />
                    </Row>
                    <Row label="Auth">
                      {data.authEnabled ? (
                        <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          enabled
                        </Badge>
                      ) : (
                        <Badge variant="secondary">disabled</Badge>
                      )}
                    </Row>
                    <p className="text-xs text-muted-foreground">
                      The bearer token is set via the <code>MCP_ROUTER_TOKEN</code> environment variable or{' '}
                      <code>settings.json</code>; it protects <code>/api/*</code> and <code>/mcp*</code>.
                    </p>
                  </>
                )
              )
            }
          />

          <CardLayout
            title="Configuration files"
            description={
              <>
                All configuration lives in flat, hand-editable JSON files under <code>DATA_DIR/config</code>:
              </>
            }
            contentClassName="flex flex-col gap-4"
            content={
              <>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                  {`config/
├── settings.json        # port, auth token, auth enabled, idle timeout
├── registries.json      # { registries: [{ name, url }] }
└── servers/
    └── <name>.json      # one file per installed server`}
                </pre>
                <p className="text-sm text-muted-foreground">
                  Files are watched for changes automatically. After hand-editing you can also trigger an explicit
                  reload — it re-reads everything from disk and reconciles running servers.
                </p>
                <div>
                  <Button disabled={reload.isPending} onClick={handleReload}>
                    <RotateCwIcon /> {reload.isPending ? 'Reloading…' : 'Reload config'}
                  </Button>
                </div>
              </>
            }
          />
        </div>
      }
    />
  );
}
