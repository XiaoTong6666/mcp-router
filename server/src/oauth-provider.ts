import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { SqliteOAuthClientsStore, SqliteOAuthStore } from './oauth-store.ts';

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedResourceUrls?: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function safeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function authorizationForm(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join('\n');
  const error = params.error ? `<p class="error">${htmlEscape(params.error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect MCP Router</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    main { max-width: 460px; margin: 12vh auto; padding: 30px; background: #111827; border: 1px solid #334155; border-radius: 16px; }
    p { line-height: 1.5; color: #cbd5e1; }
    dl { padding: 14px; background: #020617; border-radius: 10px; }
    dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
    dd { margin: 4px 0 12px; word-break: break-word; }
    input { box-sizing: border-box; width: 100%; padding: 12px; border-radius: 9px; border: 1px solid #475569; background: #020617; color: #e2e8f0; }
    button { margin-top: 16px; width: 100%; border: 0; border-radius: 9px; padding: 12px; font-weight: 700; cursor: pointer; }
    .error { color: #fecaca; background: #7f1d1d; padding: 10px; border-radius: 9px; }
    .warning { color: #fde68a; }
  </style>
</head>
<body>
<main>
  <h1>Connect MCP Router</h1>
  <p class="warning">Approve only if you intentionally started this connection from a trusted MCP client.</p>
  ${error}
  <dl>
    <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
    <dt>Scope</dt><dd>${htmlEscape(params.scopes.join(' '))}</dd>
    <dt>Resource</dt><dd>${htmlEscape(params.resource?.href ?? 'MCP Router')}</dd>
  </dl>
  <form method="post">
    ${hiddenFields}
    <label for="owner_token">Owner password</label>
    <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Authorize MCP Router</button>
  </form>
</main>
</body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly allowedResourceUrls: Set<string>;
  private readonly config: OAuthConfig;

  constructor(
    config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
  ) {
    this.config = config;
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.allowedResourceUrls = new Set(
      (config.allowedResourceUrls ?? []).map((url) => resourceUrlFromServerUrl(url).href),
    );
    this.oauthStore = new SqliteOAuthStore(stateDir);
    this.clientsStore = new SqliteOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!params.resource || !this.isResourceAllowed(params.resource)) {
      throw new InvalidRequestError('Invalid or missing OAuth resource');
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError('Requested scope is not supported');
    }

    if (res.req.method !== 'POST') {
      res.status(200).type('html').send(
        authorizationForm({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? '');
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401).type('html').send(
        authorizationForm({
          error: 'The owner password was not accepted.',
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state !== undefined) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.validCodeRecord(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && (!record.params.resource || !sameResource(resource, record.params.resource))) {
      throw new InvalidGrantError('Invalid resource');
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const recordedResource = record.resource ? new URL(record.resource) : undefined;
    if (!recordedResource || !this.isResourceAllowed(recordedResource)) {
      throw new InvalidGrantError('Invalid resource');
    }
    if (resource && !sameResource(resource, recordedResource)) {
      throw new InvalidGrantError('Invalid resource');
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError('Refresh token cannot grant requested scopes');
    }

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? recordedResource,
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  isResourceAllowed(resource: URL): boolean {
    return (
      checkResourceAllowed({
        requestedResource: resource,
        configuredResource: this.resourceServerUrl,
      }) || this.allowedResourceUrls.has(resourceUrlFromServerUrl(resource).href)
    );
  }

  close(): void {
    this.oauthStore.close();
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: now + this.config.accessTokenTtlSeconds,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: now + this.config.refreshTokenTtlSeconds,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: params.scopes?.join(' '),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function sameResource(left: URL, right: URL): boolean {
  return resourceUrlFromServerUrl(left).href === resourceUrlFromServerUrl(right).href;
}
