import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RegistriesFile, Registry, ServerConfig, SettingsFile, WorkspaceConfig } from '@mcp-router/shared';
import {
  DEFAULT_REGISTRY,
  registriesFileSchema,
  serverConfigSchema,
  settingsFileSchema,
  workspaceConfigSchema,
} from '@mcp-router/shared';
import { type FSWatcher, watch } from 'chokidar';
import { authDisabledByEnv } from '../auth.ts';
import { errorMessage, HttpError } from '../errors.ts';

export interface ConfigState {
  settings: SettingsFile;
  registries: Registry[];
  servers: ServerConfig[];
  workspaces: WorkspaceConfig[];
}

interface OAuthSecretsFile {
  ownerToken: string;
}

const WATCH_DEBOUNCE_MS = 300;

/**
 * Owns the flat config files under DATA_DIR/config: settings.json,
 * registries.json and servers/<name>.json. All writes are atomic
 * (tmp file + chmod 0600 + rename). Emits a typed 'change' event when
 * the files change on disk (debounced chokidar watcher).
 */
export class ConfigStore extends EventEmitter<{ change: [ConfigState] }> {
  readonly dataDir: string;
  readonly configDir: string;
  readonly serversDir: string;
  readonly workspacesDir: string;
  readonly oauthSecretsFile: string;

  private settings: SettingsFile = settingsFileSchema.parse({});
  private registries: Registry[] = [];
  private servers = new Map<string, ServerConfig>();
  private workspaces = new Map<string, WorkspaceConfig>();
  private oauthOwnerToken: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    this.configDir = path.join(dataDir, 'config');
    this.serversDir = path.join(this.configDir, 'servers');
    this.workspacesDir = path.join(this.configDir, 'workspaces');
    this.oauthSecretsFile = path.join(this.configDir, 'oauth.json');
  }

  /** Create directories, seed defaults on first run and load everything. */
  async init(): Promise<void> {
    await mkdir(this.serversDir, { recursive: true });
    await mkdir(this.workspacesDir, { recursive: true });
    await this.loadAll();
  }

  /** Re-read every config file from disk and return the new state. */
  async reload(): Promise<ConfigState> {
    await this.loadAll();
    return this.snapshot();
  }

  /** Start watching the config dir; emits 'change' (debounced) after reloading. */
  startWatching(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = watch(this.configDir, { ignoreInitial: true, depth: 2 });
    this.watcher.on('all', () => {
      if (this.watchDebounce) {
        clearTimeout(this.watchDebounce);
      }
      this.watchDebounce = setTimeout(() => {
        this.watchDebounce = null;
        this.reload()
          .then((state) => this.emit('change', state))
          .catch((err: unknown) => {
            console.error(`Config reload after file change failed: ${errorMessage(err)}`);
          });
      }, WATCH_DEBOUNCE_MS);
    });
  }

  async close(): Promise<void> {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  snapshot(): ConfigState {
    return {
      settings: this.settings,
      registries: this.registries,
      servers: this.getServers(),
      workspaces: this.getWorkspaces(),
    };
  }

  getSettings(): SettingsFile {
    return this.settings;
  }

  getOAuthOwnerToken(): string | null {
    return this.oauthOwnerToken;
  }

  getRegistries(): Registry[] {
    return this.registries;
  }

  getRegistry(name: string): Registry | undefined {
    return this.registries.find((r) => r.name === name);
  }

  getServers(): ServerConfig[] {
    return [...this.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getServer(name: string): ServerConfig | undefined {
    return this.servers.get(name);
  }

  /** Merge a partial settings update, persist settings.json, and apply it in memory. */
  async updateSettings(patch: Partial<SettingsFile>): Promise<SettingsFile> {
    const next = settingsFileSchema.parse({ ...this.settings, ...patch });
    await this.writeJsonAtomic(path.join(this.configDir, 'settings.json'), next);
    this.settings = next;
    if (next.oauth.enabled && !this.oauthOwnerToken) {
      this.oauthOwnerToken = await this.resolveOAuthOwnerToken();
    } else if (!next.oauth.enabled) {
      this.oauthOwnerToken = null;
    }
    return next;
  }

  async addRegistry(registry: Registry): Promise<void> {
    if (this.getRegistry(registry.name)) {
      throw new HttpError(409, `Registry "${registry.name}" already exists`);
    }
    this.registries = [...this.registries, registry];
    await this.writeRegistries();
  }

  async removeRegistry(name: string): Promise<void> {
    if (!this.getRegistry(name)) {
      throw new HttpError(404, `Unknown registry "${name}"`);
    }
    this.registries = this.registries.filter((r) => r.name !== name);
    await this.writeRegistries();
  }

  async saveServer(config: ServerConfig): Promise<ServerConfig> {
    const parsed = serverConfigSchema.parse(config);
    this.servers.set(parsed.name, parsed);
    await this.writeJsonAtomic(this.serverFile(parsed.name), parsed);
    return parsed;
  }

  async deleteServer(name: string): Promise<void> {
    this.servers.delete(name);
    await rm(this.serverFile(name), { force: true });
  }

  getWorkspaces(): WorkspaceConfig[] {
    return [...this.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getWorkspace(slug: string): WorkspaceConfig | undefined {
    return this.workspaces.get(slug);
  }

  async saveWorkspace(config: WorkspaceConfig): Promise<WorkspaceConfig> {
    const parsed = workspaceConfigSchema.parse(config);
    this.workspaces.set(parsed.slug, parsed);
    await this.writeJsonAtomic(this.workspaceFile(parsed.slug), parsed);
    return parsed;
  }

  async deleteWorkspace(slug: string): Promise<void> {
    this.workspaces.delete(slug);
    await rm(this.workspaceFile(slug), { force: true });
  }

  private async writeRegistries(): Promise<void> {
    const file: RegistriesFile = { registries: this.registries };
    await this.writeJsonAtomic(path.join(this.configDir, 'registries.json'), file);
  }

  private serverFile(name: string): string {
    return path.join(this.serversDir, `${name}.json`);
  }

  private workspaceFile(slug: string): string {
    return path.join(this.workspacesDir, `${slug}.json`);
  }

  private async loadAll(): Promise<void> {
    this.settings = await this.loadSettings();
    this.oauthOwnerToken = this.settings.oauth.enabled ? await this.resolveOAuthOwnerToken() : null;
    this.registries = await this.loadRegistries();
    this.servers = await this.loadServers();
    this.workspaces = await this.loadWorkspaces();
  }

  private async loadSettings(): Promise<SettingsFile> {
    const file = path.join(this.configDir, 'settings.json');
    let settings: SettingsFile;
    let dirty = false;
    if (existsSync(file)) {
      settings = this.parseFile(file, await readFile(file, 'utf8'), settingsFileSchema.parse.bind(settingsFileSchema));
    } else {
      settings = settingsFileSchema.parse({});
      dirty = true;
    }
    if (settings.authEnabled && !authDisabledByEnv() && !settings.authToken && !process.env.MCP_ROUTER_TOKEN) {
      settings.authToken = randomBytes(32).toString('hex');
      dirty = true;
      console.log(`Generated auth token (persisted to ${file})`);
    }
    if (dirty) {
      await this.writeJsonAtomic(file, settings);
    }
    return settings;
  }

  private async resolveOAuthOwnerToken(): Promise<string> {
    const fromEnv = process.env.MCP_ROUTER_OAUTH_OWNER_TOKEN;
    if (fromEnv !== undefined) {
      if (fromEnv.length < 16) {
        throw new Error('MCP_ROUTER_OAUTH_OWNER_TOKEN must be at least 16 characters long');
      }
      return fromEnv;
    }
    return this.loadOAuthOwnerToken();
  }

  private async loadOAuthOwnerToken(): Promise<string> {
    if (existsSync(this.oauthSecretsFile)) {
      const parsed = this.parseFile(
        this.oauthSecretsFile,
        await readFile(this.oauthSecretsFile, 'utf8'),
        (value: unknown): OAuthSecretsFile => {
          if (
            typeof value !== 'object' ||
            value === null ||
            typeof (value as { ownerToken?: unknown }).ownerToken !== 'string' ||
            (value as { ownerToken: string }).ownerToken.length < 16
          ) {
            throw new Error('ownerToken must be a string at least 16 characters long');
          }
          return { ownerToken: (value as { ownerToken: string }).ownerToken };
        },
      );
      return parsed.ownerToken;
    }

    const ownerToken = randomBytes(32).toString('base64url');
    await this.writeJsonAtomic(this.oauthSecretsFile, { ownerToken } satisfies OAuthSecretsFile);
    console.log(`Generated OAuth owner password (persisted to ${this.oauthSecretsFile})`);
    return ownerToken;
  }

  private async loadRegistries(): Promise<Registry[]> {
    const file = path.join(this.configDir, 'registries.json');
    if (!existsSync(file)) {
      const seeded: RegistriesFile = { registries: [DEFAULT_REGISTRY] };
      await this.writeJsonAtomic(file, seeded);
      return seeded.registries;
    }
    const parsed = this.parseFile(
      file,
      await readFile(file, 'utf8'),
      registriesFileSchema.parse.bind(registriesFileSchema),
    );
    return parsed.registries;
  }

  private async loadServers(): Promise<Map<string, ServerConfig>> {
    const servers = new Map<string, ServerConfig>();
    const files = (await readdir(this.serversDir)).filter((f) => f.endsWith('.json'));
    for (const file of files.sort()) {
      const fullPath = path.join(this.serversDir, file);
      try {
        const config = this.parseFile(
          fullPath,
          await readFile(fullPath, 'utf8'),
          serverConfigSchema.parse.bind(serverConfigSchema),
        );
        if (`${config.name}.json` !== file) {
          console.warn(`Server config ${fullPath} has name "${config.name}" that does not match its filename`);
        }
        servers.set(config.name, config);
      } catch (err) {
        // A single broken (hand-edited) server file must not take the router down; report and skip it.
        console.error(`Ignoring invalid server config ${fullPath}: ${errorMessage(err)}`);
      }
    }
    return servers;
  }

  private async loadWorkspaces(): Promise<Map<string, WorkspaceConfig>> {
    const workspaces = new Map<string, WorkspaceConfig>();
    const files = (await readdir(this.workspacesDir)).filter((f) => f.endsWith('.json'));
    for (const file of files.sort()) {
      const fullPath = path.join(this.workspacesDir, file);
      try {
        const config = this.parseFile(
          fullPath,
          await readFile(fullPath, 'utf8'),
          workspaceConfigSchema.parse.bind(workspaceConfigSchema),
        );
        if (`${config.slug}.json` !== file) {
          console.warn(`Workspace config ${fullPath} has slug "${config.slug}" that does not match its filename`);
        }
        workspaces.set(config.slug, config);
      } catch (err) {
        // A single broken (hand-edited) workspace file must not take the router down; report and skip it.
        console.error(`Ignoring invalid workspace config ${fullPath}: ${errorMessage(err)}`);
      }
    }
    return workspaces;
  }

  private parseFile<T>(file: string, raw: string, parse: (value: unknown) => T): T {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`${file} is not valid JSON: ${errorMessage(cause)}`, { cause });
    }
    try {
      return parse(json);
    } catch (cause) {
      throw new Error(`${file} failed validation: ${errorMessage(cause)}`, { cause });
    }
  }

  /** Atomic write: tmp file in the same dir, chmod 0600, rename over the target. */
  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }
}
