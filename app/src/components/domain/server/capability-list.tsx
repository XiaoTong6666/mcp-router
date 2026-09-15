import type { UseMutationResult } from '@tanstack/react-query';
import { ChevronRightIcon, Loader2Icon, PlayIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { QueryError } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toastApiError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DataBlock } from './json-view';

interface CapabilityListProps {
  title: string;
  description: string;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  /** What failed to load, for the error card, e.g. "resources". */
  what: string;
  /** Number of items; 0 renders the empty state. */
  count: number;
  emptyText: string;
  children: ReactNode;
}

/**
 * Shared card shell for a downstream capability listing (tools, resources,
 * prompts): connecting skeleton, retryable error, empty state, else the caller's
 * list. A failed background refetch shows the error banner above the last-loaded
 * list rather than blanking it.
 */
export function CapabilityList({
  title,
  description,
  isPending,
  error,
  refetch,
  what,
  count,
  emptyText,
  children,
}: CapabilityListProps) {
  return (
    <CardLayout
      title={title}
      description={description}
      content={
        <>
          {isPending && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">Connecting to the server — this may take a moment…</p>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          )}
          {error && <QueryError error={error} onRetry={refetch} what={what} />}
          {!isPending && !error && count === 0 && <p className="text-sm text-muted-foreground">{emptyText}</p>}
          {!isPending && count > 0 && <ul className="flex flex-col divide-y">{children}</ul>}
        </>
      }
    />
  );
}

/**
 * Shared collapsible row for one capability (tool, resource, prompt): a chevron
 * toggle with a caller-supplied header, revealing the caller's body (inputs, a
 * {@link RunButton}, and a {@link ResultBlock}) when expanded.
 */
export function CapabilityRow({ header, children }: { header: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 text-left">
        <ChevronRightIcon
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0">{header}</span>
      </button>
      {open && <div className="mt-2 ml-6 flex flex-col gap-3">{children}</div>}
    </li>
  );
}

/** Shared run/read/get action button: shows a spinner while pending, a play icon otherwise. */
export function RunButton({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div>
      <Button size="sm" variant="outline" disabled={pending || disabled} onClick={onClick}>
        {pending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} {label}
      </Button>
    </div>
  );
}

/**
 * Shared run/read/get state for a capability row: holds the last result, clears
 * it before each invocation, and toasts errors. Callers supply the mutation
 * (call/read/get) and pass their built variables to `run`.
 */
export function useCapabilityRun<TData, TVariables>(mutation: UseMutationResult<TData, Error, TVariables>) {
  const [result, setResult] = useState<TData | null>(null);
  const run = (variables: TVariables) => {
    setResult(null);
    mutation.mutate(variables, { onSuccess: setResult, onError: toastApiError });
  };
  return { result, run, pending: mutation.isPending };
}

/** Shared JSON result panel for a run/read/get invocation, with a Text/JSON toggle. */
export function ResultBlock({ result, isError, label }: { result: unknown; isError?: boolean; label?: string }) {
  return <DataBlock value={result} isError={isError} label={label ?? (isError ? 'Returned an error' : 'Result')} />;
}
