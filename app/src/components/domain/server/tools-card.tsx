import { useState } from 'react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import type { CapabilityScope, ServerTool } from '@/lib/api';
import { useCallTool, useCapabilityTools } from '@/lib/queries';
import { CapabilityList, CapabilityRow, ResultBlock, RunButton, useCapabilityRun } from './capability-list';

/** Prefill the args editor from the tool's input schema: one key per property. */
function argsTemplate(inputSchema: unknown): string {
  const properties = (inputSchema as { properties?: Record<string, { type?: string; default?: unknown }> } | undefined)
    ?.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return '{}';
  }
  const template: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    template[key] =
      prop.default ??
      (prop.type === 'number' || prop.type === 'integer'
        ? 0
        : prop.type === 'boolean'
          ? false
          : prop.type === 'array'
            ? []
            : prop.type === 'object'
              ? {}
              : '');
  }
  return JSON.stringify(template, null, 2);
}

function ToolRow({ scope, tool }: { scope: CapabilityScope; tool: ServerTool }) {
  const schemaSig = JSON.stringify(tool.inputSchema);
  const [seededSig, setSeededSig] = useState(schemaSig);
  const [argsText, setArgsText] = useState(() => argsTemplate(tool.inputSchema));
  const call = useCallTool(scope);
  const { result, run, pending } = useCapabilityRun(call);

  // A refetch that genuinely changes this tool's schema re-seeds the args editor
  // in place (rather than remounting the row), so the last result stays visible.
  if (schemaSig !== seededSig) {
    setSeededSig(schemaSig);
    setArgsText(argsTemplate(tool.inputSchema));
  }

  const submit = () => {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argsText.trim() || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments must be a JSON object');
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      toast.error(`Invalid arguments: ${error instanceof Error ? error.message : 'not valid JSON'}`);
      return;
    }
    run({ name: tool.name, arguments: args });
  };

  return (
    <CapabilityRow
      header={
        <>
          <span className="font-mono text-sm">{tool.name}</span>
          {tool.description && <p className="text-sm text-muted-foreground">{tool.description}</p>}
        </>
      }
    >
      <Textarea
        value={argsText}
        rows={Math.min(10, Math.max(3, argsText.split('\n').length))}
        className="font-mono text-xs"
        aria-label={`Arguments for ${tool.name}`}
        onChange={(event) => setArgsText(event.target.value)}
      />
      <RunButton label="Run" pending={pending} onClick={submit} />
      {result && (
        <ResultBlock
          result={result}
          isError={result.isError}
          label={result.isError ? 'Tool returned an error' : 'Result'}
        />
      )}
    </CapabilityRow>
  );
}

export function ToolsCard({ scope }: { scope: CapabilityScope }) {
  const { data, isPending, error, refetch } = useCapabilityTools(scope);
  const tools = data?.tools ?? [];
  const description =
    scope.kind === 'workspace'
      ? 'Tools exposed by the workspace aggregate, `<server>__`-namespaced, with per-workspace overrides applied. Expand one to run it with JSON arguments — runs show up in the Activity tab.'
      : 'Tools reported by the downstream server. Expand one to run it with JSON arguments — runs show up in the Activity tab.';

  return (
    <CapabilityList
      title="Tools"
      description={description}
      isPending={isPending}
      error={error}
      refetch={refetch}
      what="tools"
      count={tools.length}
      emptyText="No tools reported."
    >
      {tools.map((tool) => (
        <ToolRow key={tool.name} scope={scope} tool={tool} />
      ))}
    </CapabilityList>
  );
}
