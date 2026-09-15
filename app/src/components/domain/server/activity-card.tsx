import type { ActivityEntry } from '@mcp-router/shared';
import { ChevronRightIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CardLayout } from '@/components/card-layout';
import { OptionSelect } from '@/components/option-select';
import { QueryError } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CapabilityScope } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useCapabilityActivity, useClearActivity } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DataBlock } from './json-view';

function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.params !== undefined || entry.result !== undefined || entry.error !== undefined;

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
      >
        <ChevronRightIcon
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
            !hasDetail && 'invisible',
          )}
        />
        <span className="font-mono text-sm">{entry.method}</span>
        {entry.target && <span className="truncate font-mono text-xs text-muted-foreground">{entry.target}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant={entry.ok ? 'secondary' : 'destructive'}>{entry.ok ? 'ok' : 'error'}</Badge>
          {entry.via !== 'direct' && <Badge variant="outline">{entry.via}</Badge>}
          <span className="text-xs text-muted-foreground tabular-nums">{entry.durationMs}ms</span>
          <span className="text-xs text-muted-foreground tabular-nums" title={formatAbsoluteTime(entry.at)}>
            {formatRelativeTime(entry.at)}
          </span>
        </span>
      </button>
      {open && hasDetail && (
        <div className="mt-2 ml-6 flex flex-col gap-2">
          {entry.error && (
            <div>
              <p className="text-xs font-medium text-destructive">Error</p>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{entry.error}</pre>
            </div>
          )}
          {entry.params !== undefined && <DataBlock value={entry.params} label="Request" />}
          {entry.result !== undefined && <DataBlock value={entry.result} label="Response" />}
        </div>
      )}
    </li>
  );
}

export function ActivityCard({ scope }: { scope: CapabilityScope }) {
  const { data, isPending, error, refetch, isRefetching } = useCapabilityActivity(scope);
  const clear = useClearActivity(scope);
  const [outcome, setOutcome] = useState<'all' | 'ok' | 'error'>('all');
  const [method, setMethod] = useState('all');

  const entries = data?.entries ?? [];
  const methods = [...new Set(entries.map((entry) => entry.method))].sort();
  const filtered = entries.filter(
    (entry) => (outcome === 'all' || (outcome === 'ok') === entry.ok) && (method === 'all' || entry.method === method),
  );
  const endpoint = scope.kind === 'server' ? `/mcp/${scope.name}` : `/mcp/w/${scope.slug}`;

  const handleClear = () => {
    clear.mutate(undefined, {
      onSuccess: () => toast.success('Activity cleared'),
      onError: toastApiError,
    });
  };

  return (
    <CardLayout
      title="Activity"
      action={
        <span className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={isRefetching} onClick={() => refetch()}>
            <RotateCwIcon /> Refresh
          </Button>
          <Button variant="outline" size="sm" disabled={clear.isPending || entries.length === 0} onClick={handleClear}>
            <Trash2Icon /> Clear
          </Button>
        </span>
      }
      description={
        scope.kind === 'server'
          ? 'Recent MCP calls proxied to this server (kept in memory; the newest 200 are retained).'
          : "Recent MCP calls proxied through this workspace's members (kept in memory; the newest 200 per member are retained)."
      }
      loading={isPending}
      content={
        <>
          {error && <QueryError error={error} onRetry={() => refetch()} what="activity" />}
          {data && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No activity yet. Calls made through <code className="font-mono">{endpoint}</code>
              {scope.kind === 'server' && (
                <>
                  {' '}
                  or the aggregate <code className="font-mono">/mcp</code> endpoint
                </>
              )}{' '}
              will appear here.
            </p>
          )}
          {entries.length > 0 && (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <OptionSelect
                  data-size="sm"
                  className="w-28"
                  aria-label="Filter by outcome"
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'ok', label: 'OK' },
                    { value: 'error', label: 'Errors' },
                  ]}
                  value={outcome}
                  onValueChange={(value) => setOutcome(value as typeof outcome)}
                />
                <OptionSelect
                  data-size="sm"
                  className="w-52"
                  aria-label="Filter by method"
                  options={[
                    { value: 'all', label: 'All methods' },
                    ...methods.map((value) => ({ value, label: value })),
                  ]}
                  value={method}
                  onValueChange={setMethod}
                />
              </div>
              {filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground">No entries match the current filters.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {filtered.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      }
    />
  );
}
