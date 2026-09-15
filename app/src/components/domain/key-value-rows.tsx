import { PlusIcon, XIcon } from 'lucide-react';
import { ActionButton } from '@/components/action-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface KeyValueRow {
  key: string;
  value: string;
}

export const recordToRows = (record: Record<string, string>): KeyValueRow[] =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

/** Rows with a (trimmed) key, as a record. Pass `skipEmptyValues` to also drop rows with no value. */
export function rowsToRecord(rows: KeyValueRow[], { skipEmptyValues = false } = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim() && (row.value || !skipEmptyValues)) {
      result[row.key.trim()] = row.value;
    }
  }
  return result;
}

interface KeyValueRowsProps {
  legend: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  /** Accessible name of each key input. */
  keyLabel: string;
  /** What an unnamed row is called in its value/remove labels, e.g. "new variable". */
  unnamed: string;
  addLabel: string;
  /** Hide the legend while there are no rows. */
  hideLegendWhenEmpty?: boolean;
}

/** Editable list of key/value pairs (env vars, headers), held by the caller — typically one form field. */
export function KeyValueRows({
  legend,
  rows,
  onChange,
  keyPlaceholder = 'KEY',
  keyLabel,
  unnamed,
  addLabel,
  hideLegendWhenEmpty = false,
}: KeyValueRowsProps) {
  const patch = (index: number, next: Partial<KeyValueRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));

  return (
    <div className="flex flex-col gap-2">
      {(rows.length > 0 || !hideLegendWhenEmpty) && <Label>{legend}</Label>}
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={keyLabel}
            className="w-2/5 font-mono"
            onChange={(event) => patch(index, { key: event.target.value })}
          />
          <Input
            value={row.value}
            placeholder="value"
            aria-label={`Value for ${row.key || unnamed}`}
            className="flex-1 font-mono"
            onChange={(event) => patch(index, { value: event.target.value })}
          />
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            label={`Remove ${row.key || unnamed}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <XIcon />
          </ActionButton>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <PlusIcon /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
