import { useState } from 'react';
import { Input } from '@/components/ui/input';
import type { CapabilityScope, ServerResource, ServerResourceTemplate } from '@/lib/api';
import { useCapabilityResources, useReadResource } from '@/lib/queries';
import { CapabilityList, CapabilityRow, ResultBlock, RunButton, useCapabilityRun } from './capability-list';

/** A resource (concrete URI) or a template (an RFC 6570 URI to fill in). */
interface ResourceRowData {
  label: string;
  /** Prefill for the URI field: the concrete URI, or the template to edit. */
  uri: string;
  /** True when `uri` is a template with `{placeholders}` to replace before reading. */
  isTemplate: boolean;
  description?: string;
  mimeType?: string;
}

function ResourceRow({ scope, data }: { scope: CapabilityScope; data: ResourceRowData }) {
  const [uri, setUri] = useState(data.uri);
  const read = useReadResource(scope);
  const { result, run, pending } = useCapabilityRun(read);

  return (
    <CapabilityRow
      header={
        <>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm">{data.label}</span>
            {data.isTemplate && <span className="text-xs text-muted-foreground">template</span>}
            {data.mimeType && <span className="text-xs text-muted-foreground">{data.mimeType}</span>}
          </span>
          {data.label !== data.uri && (
            <span className="block font-mono text-xs break-all text-muted-foreground">{data.uri}</span>
          )}
          {data.description && <p className="text-sm text-muted-foreground">{data.description}</p>}
        </>
      }
    >
      <Input
        value={uri}
        className="font-mono text-xs"
        aria-label={`URI to read for ${data.label}`}
        onChange={(event) => setUri(event.target.value)}
      />
      {data.isTemplate && (
        <p className="text-xs text-muted-foreground">Replace the {'{placeholders}'} with concrete values.</p>
      )}
      <RunButton
        label="Read"
        pending={pending}
        disabled={uri.trim().length === 0}
        onClick={() => run({ uri: uri.trim() })}
      />
      {result && <ResultBlock result={result} />}
    </CapabilityRow>
  );
}

function toRow(resource: ServerResource): ResourceRowData {
  return {
    label: resource.name ?? resource.uri,
    uri: resource.uri,
    isTemplate: false,
    description: resource.description,
    mimeType: resource.mimeType,
  };
}

function templateToRow(template: ServerResourceTemplate): ResourceRowData {
  return {
    label: template.name ?? template.uriTemplate,
    uri: template.uriTemplate,
    isTemplate: true,
    description: template.description,
    mimeType: template.mimeType,
  };
}

export function ResourcesCard({ scope }: { scope: CapabilityScope }) {
  const { data, isPending, error, refetch } = useCapabilityResources(scope);
  const rows = [...(data?.resources ?? []).map(toRow), ...(data?.resourceTemplates ?? []).map(templateToRow)];
  const description =
    scope.kind === 'workspace'
      ? 'Resources and resource templates exposed by the workspace aggregate, `<server>__`-namespaced. Expand one to read it — reads show up in the Activity tab.'
      : 'Resources and resource templates exposed by the downstream server. Expand one to read it — reads show up in the Activity tab.';

  return (
    <CapabilityList
      title="Resources"
      description={description}
      isPending={isPending}
      error={error}
      refetch={refetch}
      what="resources"
      count={rows.length}
      emptyText="No resources reported."
    >
      {rows.map((row) => (
        <ResourceRow key={`${row.isTemplate ? 'tpl' : 'res'}:${row.uri}`} scope={scope} data={row} />
      ))}
    </CapabilityList>
  );
}
