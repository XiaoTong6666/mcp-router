import { useStore } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { FormField } from '@/components/form-field';
import { PasswordInput } from '@/components/password-input';
import { setToken, useNeedsAuth } from '@/lib/auth';

/**
 * Renders its children normally; when any API call has come back 401 it swaps
 * in a token-entry screen. Submitting stores the token in localStorage and
 * refetches everything.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const needsAuth = useNeedsAuth();

  if (!needsAuth) {
    return children;
  }
  return <TokenForm />;
}

function TokenForm() {
  const queryClient = useQueryClient();
  const form = useAppForm({
    defaultValues: { token: '' },
    onSubmit: ({ value, formApi }) => {
      const token = value.token.trim();
      if (!token) {
        return;
      }
      setToken(token);
      formApi.reset();
      queryClient.invalidateQueries();
    },
  });
  const empty = useStore(form.store, (state) => !state.values.token.trim());

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <CardLayout
        className="w-full max-w-sm"
        icon={<KeyRoundIcon />}
        title="Authentication required"
        description={
          <>
            Enter the router token (from <code>MCP_ROUTER_TOKEN</code> or <code>settings.json</code>).
          </>
        }
        content={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
            className="flex flex-col gap-4"
          >
            <form.Field name="token">
              {(field) => (
                <FormField
                  label="Token"
                  control={
                    <PasswordInput
                      id="token"
                      autoFocus
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="Bearer token"
                      showLabel="Show token"
                      hideLabel="Hide token"
                    />
                  }
                />
              )}
            </form.Field>
            <form.AppForm>
              <form.SubmitButton disabled={empty} pendingLabel="Unlocking…">
                Unlock
              </form.SubmitButton>
            </form.AppForm>
          </form>
        }
      />
    </div>
  );
}
