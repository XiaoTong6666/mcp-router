import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    return true;
  }
  return allowedHosts.includes(parsed.hostname);
}

function migrate(sqlite: DatabaseSync): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

export class SqliteOAuthStore {
  private readonly sqlite: DatabaseSync;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const databasePath = path.join(stateDir, 'oauth.sqlite');
    this.sqlite = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.sqlite.exec('pragma journal_mode = WAL');
    this.sqlite.exec('pragma synchronous = NORMAL');
    this.sqlite.exec('pragma busy_timeout = 5000');
    this.sqlite.exec('pragma foreign_keys = ON');
    migrate(this.sqlite);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.sqlite.prepare('select client_json from oauth_clients where client_id = ?').get(clientId) as
      | { client_json: string }
      | undefined;
    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError('Client redirect_uri is not allowed for this MCP Router server');
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `mcp-router-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'none',
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
    };

    this.sqlite
      .prepare('insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)')
      .run(registered.client_id, JSON.stringify(registered), now);
    return registered;
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    this.sqlite.exec('begin immediate');
    try {
      if (consumedRefreshTokenHash) {
        const result = this.sqlite
          .prepare('delete from oauth_refresh_tokens where token_hash = ?')
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) {
          this.sqlite.exec('rollback');
          return false;
        }
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      this.sqlite.exec('commit');
      return true;
    } catch (error) {
      this.sqlite.exec('rollback');
      throw error;
    }
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.sqlite
      .prepare(
        'select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?',
      )
      .get(tokenHash) as
      | { client_id: string; scopes_json: string; expires_at: number; resource: string | null }
      | undefined;
    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.sqlite
      .prepare(
        'select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?',
      )
      .get(tokenHash) as
      | { client_id: string; scopes_json: string; expires_at: number; resource: string | null }
      | undefined;
    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.sqlite.prepare('delete from oauth_access_tokens where token_hash = ?').run(tokenHash);
  }

  deleteRefreshToken(tokenHash: string): void {
    this.sqlite.prepare('delete from oauth_refresh_tokens where token_hash = ?').run(tokenHash);
  }

  close(): void {
    this.sqlite.close();
  }

  private saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(tokenHash, record.clientId, JSON.stringify(record.scopes), record.expiresAt, record.resource ?? null);
  }

  private saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(tokenHash, record.clientId, JSON.stringify(record.scopes), record.expiresAt, record.resource ?? null);
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.sqlite.prepare('delete from oauth_access_tokens where expires_at < ?').run(nowSeconds);
    this.sqlite.prepare('delete from oauth_refresh_tokens where expires_at < ?').run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly store: SqliteOAuthStore;
  private readonly allowedRedirectHosts: string[];

  constructor(
    store: SqliteOAuthStore,
    allowedRedirectHosts: string[],
  ) {
    this.store = store;
    this.allowedRedirectHosts = allowedRedirectHosts;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}
