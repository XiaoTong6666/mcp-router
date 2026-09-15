import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';

/** Icon button that copies `text` to the clipboard, flashing a check on success. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <ActionButton variant="ghost" size="icon-sm" label={label} className={className} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </ActionButton>
  );
}
