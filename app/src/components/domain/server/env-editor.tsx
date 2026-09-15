import type { EnvVarMeta } from '@mcp-router/shared';
import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { ActionButton } from '@/components/action-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface EnvRow {
  id: number;
  key: string;
  value: string;
  /** New rows have an editable key and no registry metadata. */
  isNew: boolean;
}

interface EnvEditorProps {
  env: Record<string, string>;
  envMeta: Record<string, EnvVarMeta>;
  onSave: (env: Record<string, string>) => void;
  saving?: boolean;
}

let nextRowId = 0;

function buildRows(env: Record<string, string>, envMeta: Record<string, EnvVarMeta>): EnvRow[] {
  const keys = [...new Set([...Object.keys(envMeta), ...Object.keys(env)])];
  return keys.map((key) => ({ id: nextRowId++, key, value: env[key] ?? '', isNew: false }));
}

/**
 * Table of env vars: the union of the config's `envMeta` (registry hints) and
 * `env` (actual values). Secret vars render masked with a reveal toggle;
 * arbitrary key/value rows can be added and removed. Save emits the resulting
 * env record (rows with an empty key or value are dropped).
 */
export function EnvEditor({ env, envMeta, onSave, saving = false }: EnvEditorProps) {
  const [rows, setRows] = useState<EnvRow[]>(() => buildRows(env, envMeta));
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());

  const updateRow = (id: number, patch: Partial<Pick<EnvRow, 'key' | 'value'>>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: number) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const addRow = () => {
    setRows((current) => [...current, { id: nextRowId++, key: '', value: '', isNew: true }]);
  };

  const toggleReveal = (id: number) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSave = () => {
    const result: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key && row.value) {
        result[key] = row.value;
      }
    }
    onSave(result);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No environment variables configured.</p>}
      {rows.map((row) => {
        const meta = row.isNew ? undefined : envMeta[row.key];
        const isSecret = meta?.isSecret === true;
        const isRevealed = revealed.has(row.id);
        return (
          <div key={row.id} className="flex items-start gap-2">
            <div className="w-2/5 min-w-0">
              {row.isNew ? (
                <Input
                  value={row.key}
                  placeholder="KEY"
                  aria-label="Variable name"
                  className="font-mono"
                  onChange={(event) => updateRow(row.id, { key: event.target.value })}
                />
              ) : (
                <div className="pt-1.5">
                  <span className="font-mono text-sm">
                    {row.key}
                    {meta?.isRequired && (
                      <span className="ml-0.5 text-destructive" title="Required">
                        *
                      </span>
                    )}
                  </span>
                  {meta?.description && <p className="text-xs text-muted-foreground">{meta.description}</p>}
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <Input
                type={isSecret && !isRevealed ? 'password' : 'text'}
                value={row.value}
                placeholder={meta?.placeholder ?? meta?.default ?? 'value'}
                aria-label={`Value for ${row.key || 'new variable'}`}
                className="font-mono"
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
              />
              {isSecret && (
                <ActionButton
                  variant="ghost"
                  size="icon-sm"
                  label={isRevealed ? `Hide ${row.key}` : `Reveal ${row.key}`}
                  onClick={() => toggleReveal(row.id)}
                >
                  {isRevealed ? <EyeOffIcon /> : <EyeIcon />}
                </ActionButton>
              )}
              {(row.isNew || meta === undefined) && (
                <ActionButton
                  variant="ghost"
                  size="icon-sm"
                  label={`Remove ${row.key || 'new variable'}`}
                  onClick={() => removeRow(row.id)}
                >
                  <XIcon />
                </ActionButton>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <PlusIcon /> Add variable
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
