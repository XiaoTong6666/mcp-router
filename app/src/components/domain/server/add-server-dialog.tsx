import { type InstallRequest, type ServerStatus, serverNameSchema } from '@mcp-router/shared';
import { useStore } from '@tanstack/react-form';
import { useState } from 'react';
import { toast } from 'sonner';
import { InputField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { KeyValueRows, recordToRows, rowsToRecord } from '@/components/domain/key-value-rows';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useInstallServer, useUpdateServer } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

const FORM_ID = 'add-server-form';

type Mode = 'stdio' | 'http';

function nameError(value: string): string | undefined {
  const result = serverNameSchema.safeParse(value);
  return !value || result.success ? undefined : (result.error.issues[0]?.message ?? 'Invalid name');
}

function urlError(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  try {
    new URL(value.trim());
    return undefined;
  } catch {
    return 'Enter a valid URL';
  }
}

/** Parse a pasted JSON config into a single stdio server entry. Accepts:
 *  - a bare `{ command, args, env }` object,
 *  - a named entry `{ "my-server": { command, args } }`,
 *  - a `claude_desktop_config.json` wrapper `{ mcpServers: { "my-server": {...} } }`
 *    (or a `servers` wrapper).
 *  When several servers are present, the first is used and `extraCount` reports
 *  how many were skipped. Trailing commas (a common copy-paste artifact) are tolerated. */
function parseJsonConfig(text: string): {
  name?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  extraCount: number;
} {
  // Tolerate trailing commas before a closing brace/bracket.
  const cleaned = text.replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  // Unwrap a `mcpServers` / `servers` wrapper if present.
  const wrapper = parsed.mcpServers ?? parsed.servers;
  const map = wrapper && typeof wrapper === 'object' ? (wrapper as Record<string, unknown>) : parsed;

  let name: string | undefined;
  let entry: Record<string, unknown>;
  let extraCount = 0;
  if (typeof map.command === 'string') {
    // A bare `{ command, args, env }` config.
    entry = map;
  } else {
    // A name -> config map; use the first entry.
    const keys = Object.keys(map);
    const first = keys[0];
    if (!first) {
      throw new Error('No server entries found');
    }
    name = first;
    extraCount = keys.length - 1;
    const value = map[first];
    if (!value || typeof value !== 'object') {
      throw new Error(`Entry "${first}" is not an object`);
    }
    entry = value as Record<string, unknown>;
  }

  const command = entry.command;
  if (typeof command !== 'string' || !command) {
    throw new Error('Config has no "command" string');
  }
  const args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [];
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === 'object') {
    for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }
  return { name, command, args, env, extraCount };
}

export function AddServerDialog({
  open,
  onOpenChange,
  onSaved,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (name: string) => void;
  /** When provided, the dialog edits this server (prefilled) instead of creating one. */
  server?: ServerStatus;
}) {
  const install = useInstallServer();
  const update = useUpdateServer();
  const isEdit = server !== undefined;
  const transport = server?.config.transport;
  const [jsonText, setJsonText] = useState('');

  const form = useAppForm({
    defaultValues: {
      mode: (transport?.type === 'streamable-http' ? 'http' : 'stdio') as Mode,
      name: server?.config.name ?? '',
      // stdio fields
      command: transport?.type === 'stdio' ? transport.command : '',
      argsText: transport?.type === 'stdio' ? transport.args.join('\n') : '',
      cwd: transport?.type === 'stdio' ? (transport.cwd ?? '') : '',
      envRows: recordToRows(server?.config.env ?? {}),
      // http fields
      url: transport?.type === 'streamable-http' ? transport.url : '',
      headerRows: recordToRows(transport?.type === 'streamable-http' ? transport.headers : {}),
    },
    onSubmit: async ({ value }) => {
      const built =
        value.mode === 'stdio'
          ? {
              type: 'stdio' as const,
              command: value.command.trim(),
              args: value.argsText
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
              cwd: value.cwd.trim() || undefined,
            }
          : { type: 'streamable-http' as const, url: value.url.trim(), headers: rowsToRecord(value.headerRows) };
      // A streamable-http server has no child env.
      const env = value.mode === 'stdio' ? rowsToRecord(value.envRows) : {};

      try {
        if (isEdit) {
          // Name is the immutable route/dir key, so it is not part of the update.
          await update.mutateAsync({
            name: server.config.name,
            transport: built,
            ...(value.mode === 'stdio' ? { env } : {}),
          });
          toast.success(`Updated ${server.config.name}`);
          onOpenChange(false);
          onSaved?.(server.config.name);
          return;
        }
        const body: InstallRequest = {
          name: serverNameSchema.parse(value.name),
          source: { type: 'remote' },
          transport: built,
          env,
          enabled: true,
        };
        const status = await install.mutateAsync(body);
        toast.success(`Added ${status.config.name}`);
        onOpenChange(false);
        onSaved?.(status.config.name);
      } catch (error) {
        toastApiError(error);
      }
    },
  });

  const values = useStore(form.store, (state) => state.values);
  const routeName = serverNameSchema.safeParse(values.name).success ? values.name : '…';
  const ready =
    serverNameSchema.safeParse(values.name).success &&
    (values.mode === 'stdio'
      ? values.command.trim().length > 0
      : values.url.trim().length > 0 && !urlError(values.url));

  const setMode = (mode: Mode) => {
    form.setFieldValue('mode', mode);
    // The URL's error only counts on the HTTP tab; re-run it so leaving that tab clears it.
    form.validateField('url', 'change');
  };

  const applyJson = () => {
    try {
      const config = parseJsonConfig(jsonText);
      setMode('stdio');
      form.setFieldValue('command', config.command);
      form.setFieldValue('argsText', config.args.join('\n'));
      form.setFieldValue('envRows', recordToRows(config.env));
      if (config.name && !form.getFieldValue('name')) {
        const suggested = serverNameSchema.safeParse(config.name);
        if (suggested.success) {
          form.setFieldValue('name', suggested.data);
        }
      }
      if (config.extraCount > 0) {
        toast.success(
          `Applied "${config.name}". Ignored ${config.extraCount} other ${
            config.extraCount === 1 ? 'server' : 'servers'
          } in the paste — add ${config.extraCount === 1 ? 'it' : 'them'} one at a time.`,
        );
      } else {
        toast.success('Config applied — fields filled in below');
      }
    } catch (error) {
      toast.error(`Could not parse config: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={isEdit ? `Edit ${server.config.name}` : 'Add a server'}
      description={
        isEdit
          ? 'Change how this server is run or proxied. Saving restarts it if the transport or environment changed.'
          : 'Configure an MCP server manually — a local command to run, or an existing HTTP server to route through. Nothing is downloaded from a registry.'
      }
      footerActions={(close) => (
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.SubmitButton form={FORM_ID} disabled={!ready} pendingLabel={isEdit ? 'Saving…' : 'Adding…'}>
              {isEdit ? 'Save changes' : 'Add server'}
            </form.SubmitButton>
          </form.AppForm>
        </>
      )}
      content={
        <form
          id={FORM_ID}
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          {!isEdit && (
            <FormField
              className="rounded-lg border border-dashed bg-muted/40 p-3"
              label="Paste a config"
              action={
                <Button type="button" variant="outline" size="sm" disabled={!jsonText.trim()} onClick={applyJson}>
                  Apply config
                </Button>
              }
              description={
                <>
                  Paste a full <code className="font-mono">claude_desktop_config.json</code> block (
                  <code className="font-mono">mcpServers</code> wrapper), a single named{' '}
                  <code className="font-mono">{'{ "name": { command, args } }'}</code> entry, or a bare{' '}
                  <code className="font-mono">{'{ command, args, env }'}</code> object. Fills in the fields below; the
                  first server is used if several are present.
                </>
              }
              control={
                <Textarea
                  value={jsonText}
                  rows={10}
                  className="resize-y font-mono text-xs"
                  placeholder={
                    '{\n  "mcpServers": {\n    "sequentialthinking": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]\n    }\n  }\n}'
                  }
                  onChange={(event) => setJsonText(event.target.value)}
                />
              }
            />
          )}

          <InputField
            form={form}
            name="name"
            label="Local name"
            placeholder="my-server"
            disabled={isEdit}
            description={`${isEdit ? 'The name is fixed once a server exists. ' : ''}Route segment for this server: /mcp/${routeName}`}
            validators={{ onChange: ({ value }) => nameError(value) }}
          />

          <Tabs value={values.mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList className="w-full">
              <TabsTrigger value="stdio" className="flex-1">
                Command (stdio)
              </TabsTrigger>
              <TabsTrigger value="http" className="flex-1">
                HTTP (streamable)
              </TabsTrigger>
            </TabsList>

            <TabsContent value="stdio" className="flex flex-col gap-4 pt-2">
              <InputField form={form} name="command" label="Command" placeholder="npx" />
              <TextareaField
                form={form}
                name="argsText"
                label="Arguments (one per line)"
                rows={3}
                placeholder={'-y\nsome-mcp-server'}
              />
              <InputField form={form} name="cwd" label="Working directory (optional)" placeholder="/absolute/path" />
              <form.Field name="envRows">
                {(field) => (
                  <KeyValueRows
                    legend="Environment variables"
                    keyPlaceholder="API_KEY"
                    keyLabel="Environment variables name"
                    unnamed="new entry"
                    addLabel="Add variable"
                    rows={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            </TabsContent>

            <TabsContent value="http" className="flex flex-col gap-4 pt-2">
              <InputField
                form={form}
                name="url"
                label="Server URL"
                placeholder="http://localhost:8080/mcp"
                description={`Requests to /mcp/${routeName} are proxied to this streamable-HTTP server.`}
                validators={{
                  onChange: ({ value, fieldApi }) =>
                    fieldApi.form.getFieldValue('mode') === 'http' ? urlError(value) : undefined,
                }}
              />
              <form.Field name="headerRows">
                {(field) => (
                  <KeyValueRows
                    legend="Headers"
                    keyPlaceholder="Authorization"
                    keyLabel="Headers name"
                    unnamed="new entry"
                    addLabel="Add header"
                    rows={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            </TabsContent>
          </Tabs>
        </form>
      }
    />
  );
}
