import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { PackageInstallCard } from '@/components/domain/browse/package-install-card';
import { RegistryServerCard } from '@/components/domain/browse/server-card';
import { OptionSelect } from '@/components/option-select';
import { PageLayout } from '@/components/page-layout';
import { QueryError } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRegistries, useRegistrySearch } from '@/lib/queries';

export const Route = createFileRoute('/browse')({
  component: BrowsePage,
});

export function RegistrySearch({ onInstalled }: { onInstalled: (name: string) => void }) {
  const registriesQuery = useRegistries();
  const { data: registries, isPending: registriesPending, error: registriesError } = registriesQuery;
  const [selectedRegistry, setSelectedRegistry] = useState<string>();
  const [searchInput, setSearchInput] = useState('');
  // Only committed on submit (Enter or the Search button) to avoid a registry
  // hit on every keystroke.
  const [search, setSearch] = useState('');

  const registry =
    selectedRegistry ?? registries?.find((r) => r.name === 'official')?.name ?? registries?.[0]?.name ?? '';

  const results = useRegistrySearch(registry, search);
  const servers = results.data?.pages.flatMap((page) => page.servers) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <OptionSelect
          className="w-48"
          aria-label="Registry"
          options={(registries ?? []).map((r) => ({ value: r.name, label: r.name }))}
          value={registry}
          onValueChange={setSelectedRegistry}
          disabled={registriesPending}
          placeholder={registriesPending ? 'Loading…' : 'Registry'}
        />
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <div className="relative flex-1">
            <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              value={searchInput}
              placeholder="Search servers…"
              className="pl-8"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={!registry}>
            Search
          </Button>
        </form>
      </div>

      {registriesError && (
        <QueryError error={registriesError} onRetry={() => registriesQuery.refetch()} what="registries" />
      )}

      {results.isPending && registry && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      )}

      {results.error && <QueryError error={results.error} onRetry={() => results.refetch()} what="search results" />}

      {results.data && servers.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No servers found.</p>
      )}

      {servers.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {servers.map((entry) => (
              <RegistryServerCard
                key={entry.server.name}
                registry={registry}
                server={entry.server}
                onInstalled={onInstalled}
              />
            ))}
          </div>
          {results.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>
                {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BrowsePage() {
  const navigate = useNavigate();
  const handleInstalled = (name: string) => {
    navigate({ to: '/servers/$name', params: { name } });
  };

  return (
    <PageLayout
      title="Browse"
      description="Install MCP servers from a registry, or straight from npm or PyPI."
      content={
        <Tabs defaultValue="registry" className="py-4 md:py-6">
          <TabsList>
            <TabsTrigger value="registry">From registry</TabsTrigger>
            <TabsTrigger value="npm">From npm</TabsTrigger>
            <TabsTrigger value="pypi">From PyPI</TabsTrigger>
          </TabsList>
          <TabsContent value="registry" className="pt-4">
            <RegistrySearch onInstalled={handleInstalled} />
          </TabsContent>
          <TabsContent value="npm" className="pt-4">
            <PackageInstallCard ecosystem="npm" onInstalled={handleInstalled} />
          </TabsContent>
          <TabsContent value="pypi" className="pt-4">
            <PackageInstallCard ecosystem="pypi" onInstalled={handleInstalled} />
          </TabsContent>
        </Tabs>
      }
    />
  );
}
