import type { ReactNode } from 'react';

/** Label/value row for the key facts on a detail or settings card. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
