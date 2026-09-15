import {
  type InstallRequest,
  type RegistryKeyValueInput,
  type RegistryServer,
  serverNameSchema,
} from '@mcp-router/shared';
import { useStore } from '@tanstack/react-form';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { type KeyValueRow, KeyValueRows, rowsToRecord } from '@/components/domain/key-value-rows';
import { FormField } from '@/components/form-field';
import { OptionSelect } from '@/components/option-select';
import { Button } from '@/components/ui/button';
import { suggestLocalName } from '@/lib/format';
import { useInstallServer } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

const FORM_ID = 'install-server-form';

interface PackageOption {
  selector: string;
  label: string;
  envVars: RegistryKeyValueInput[];
}

function buildOptions(server: RegistryServer): PackageOption[] {
  const packages = (server.packages ?? []).map((pkg, index) => ({
    selector: String(index),
    label: `${pkg.registryType}: ${pkg.identifier}${pkg.version ? `@${pkg.version}` : ''}`,
    envVars: pkg.environmentVariables ?? [],
  }));
  const remotes = (server.remotes ?? []).map((remote, index) => ({
    selector: `remote:${index}`,
    label: `${remote.type}: ${remote.url}`,
    envVars: [],
  }));
  return [...packages, ...remotes];
}

/** Default: the first npm package, else the first package, else the first remote ('' when there is nothing). */
function defaultSelector(server: RegistryServer): string {
  const packages = server.packages ?? [];
  const npmIndex = packages.findIndex((pkg) => pkg.registryType === 'npm');
  if (npmIndex >= 0) {
    return String(npmIndex);
  }
  if (packages.length > 0) {
    return '0';
  }
  if ((server.remotes ?? []).length > 0) {
    return 'remote:0';
  }
  return '';
}

/** One value per declared env var, in declaration order, prefilled from the registry's value or default. */
function defaultEnvValues(envVars: RegistryKeyValueInput[]): string[] {
  return envVars.map((envVar) => envVar.value ?? envVar.default ?? '');
}

function nameError(value: string): string | undefined {
  const result = serverNameSchema.safeParse(value);
  return result.success ? undefined : (result.error.issues[0]?.message ?? 'Invalid name');
}

interface InstallDialogProps {
  registry: string;
  server: RegistryServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (name: string) => void;
}

export function InstallDialog({ registry, server, open, onOpenChange, onInstalled }: InstallDialogProps) {
  const install = useInstallServer();
  const options = useMemo(() => buildOptions(server), [server]);
  const initialSelector = defaultSelector(server);

  const form = useAppForm({
    defaultValues: {
      name: suggestLocalName(server.name),
      selector: initialSelector,
      envValues: defaultEnvValues(options.find((option) => option.selector === initialSelector)?.envVars ?? []),
      customRows: [] as KeyValueRow[],
    },
    onSubmit: async ({ value }) => {
      const envVars = options.find((option) => option.selector === value.selector)?.envVars ?? [];
      const env: Record<string, string> = {};
      envVars.forEach((envVar, index) => {
        const envValue = value.envValues[index];
        if (envValue) {
          env[envVar.name] = envValue;
        }
      });
      Object.assign(env, rowsToRecord(value.customRows, { skipEmptyValues: true }));
      const body: InstallRequest = {
        name: serverNameSchema.parse(value.name),
        source: { type: 'registry', registry, serverName: server.name, version: server.version },
        packageSelector: value.selector || undefined,
        env,
        enabled: true,
      };
      try {
        const status = await install.mutateAsync(body);
        toast.success(`Installed ${status.config.name}`);
        onOpenChange(false);
        onInstalled?.(status.config.name);
      } catch (error) {
        toastApiError(error);
      }
    },
  });

  const name = useStore(form.store, (state) => state.values.name);
  const selector = useStore(form.store, (state) => state.values.selector);
  const selected = options.find((option) => option.selector === selector);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Install ${server.title ?? server.name}`}
      description={server.description}
      footerActions={(close) => (
        <>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.SubmitButton form={FORM_ID} pendingLabel="Installing…">
              Install
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
          <InputField
            form={form}
            name="name"
            label="Local name"
            description={`Route segment for this server: /mcp/${nameError(name) ? '…' : name}`}
            validators={{ onChange: ({ value }) => nameError(value) }}
          />

          {options.length > 1 && (
            <FormField
              label="Package"
              control={
                <OptionSelect
                  options={options.map((option) => ({ value: option.selector, label: option.label }))}
                  value={selector}
                  placeholder="Select a package"
                  onValueChange={(value) => {
                    form.setFieldValue('selector', value);
                    const option = options.find((candidate) => candidate.selector === value);
                    form.setFieldValue('envValues', defaultEnvValues(option?.envVars ?? []));
                  }}
                />
              }
            />
          )}

          {selected && selected.envVars.length > 0 && (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-3 text-sm font-medium">Environment variables</legend>
              {selected.envVars.map((envVar, index) => (
                <InputField
                  key={`${selector}:${envVar.name}`}
                  form={form}
                  name={`envValues[${index}]`}
                  label={envVar.name}
                  labelClassName="font-mono text-xs"
                  required={envVar.isRequired}
                  description={envVar.description}
                  type={envVar.isSecret ? 'password' : 'text'}
                  placeholder={envVar.placeholder}
                />
              ))}
            </fieldset>
          )}

          <form.Field name="customRows">
            {(field) => (
              <KeyValueRows
                legend="Additional environment variables"
                rows={field.state.value}
                onChange={field.handleChange}
                keyLabel="Variable name"
                unnamed="new variable"
                addLabel="Add env var"
              />
            )}
          </form.Field>
        </form>
      }
    />
  );
}
