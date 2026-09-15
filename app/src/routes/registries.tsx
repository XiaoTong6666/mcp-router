import { createRegistryRequestSchema } from '@mcp-router/shared';
import { createFileRoute } from '@tanstack/react-router';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { InputField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCreateRegistry, useDeleteRegistry, useRegistries } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/registries')({
  component: RegistriesPage,
});

/** First issue message for one field of the create-registry schema, checked against the trimmed value. */
function registryFieldError(field: 'name' | 'url', value: string): string | undefined {
  const result = createRegistryRequestSchema.shape[field].safeParse(value.trim());
  return result.success ? undefined : result.error.issues[0]?.message;
}

function AddRegistryForm() {
  const create = useCreateRegistry();
  const form = useAppForm({
    defaultValues: { name: '', url: '' },
    onSubmit: async ({ value, formApi }) => {
      const body = createRegistryRequestSchema.parse({ name: value.name.trim(), url: value.url.trim() });
      try {
        await create.mutateAsync(body);
        toast.success(`Added registry ${body.name}`);
        formApi.reset();
      } catch (error) {
        toastApiError(error);
      }
    },
  });

  return (
    <CardLayout
      title="Add registry"
      description="Any service implementing the MCP registry API (GET /v0/servers)."
      content={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
          className="flex flex-wrap items-start gap-4"
        >
          <InputField
            form={form}
            name="name"
            label="Name"
            placeholder="my-registry"
            className="w-48"
            validators={{ onSubmit: ({ value }) => registryFieldError('name', value) }}
          />
          <InputField
            form={form}
            name="url"
            label="URL"
            placeholder="https://registry.example.com"
            className="min-w-64 flex-1"
            validators={{ onSubmit: ({ value }) => registryFieldError('url', value) }}
          />
          <form.AppForm>
            <form.SubmitButton className="mt-[1.375rem]" pendingLabel="Adding…">
              <PlusIcon /> Add
            </form.SubmitButton>
          </form.AppForm>
        </form>
      }
    />
  );
}

function RegistriesPage() {
  const registries = useRegistries();
  const { data } = registries;
  const remove = useDeleteRegistry();

  return (
    <PageLayout
      title="Registries"
      description="Sources to browse and install MCP servers from."
      content={
        <div className="flex flex-col gap-6 py-4 md:py-6">
          <QueryState query={registries} what="registries" count={data ? 1 : 0} />

          {data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No registries configured.
                    </TableCell>
                  </TableRow>
                )}
                {data.map((registry) => (
                  <TableRow key={registry.name}>
                    <TableCell className="font-medium">{registry.name}</TableCell>
                    <TableCell className="text-muted-foreground">{registry.url}</TableCell>
                    <TableCell className="text-right">
                      <ConfirmButton
                        variant="ghost"
                        size="icon-sm"
                        label={`Delete ${registry.name}`}
                        title={`Delete registry ${registry.name}?`}
                        description={
                          <>
                            Installed servers are not affected; you just won't be able to browse this registry anymore.
                            {registry.name === 'official' &&
                              " Note: 'official' is the default registry seeded on first run."}
                          </>
                        }
                        onConfirm={() =>
                          remove.mutate(registry.name, {
                            onSuccess: () => toast.success(`Deleted registry ${registry.name}`),
                            onError: toastApiError,
                          })
                        }
                      >
                        <Trash2Icon className="text-destructive" />
                      </ConfirmButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <AddRegistryForm />
        </div>
      }
    />
  );
}
