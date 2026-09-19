import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { ConfigStore } from './config/store.ts';
import { SingleUserOAuthProvider } from './oauth-provider.ts';

export interface OAuthRuntime {
  provider: SingleUserOAuthProvider;
  bearerAuth: RequestHandler;
  publicBaseUrl: URL;
  resourceServerUrl: URL;
  resourceMetadataUrl: string;
  oauthMetadata: ReturnType<typeof createOAuthMetadata>;
  close(): void;
}

function publicBaseUrl(store: ConfigStore): URL {
  const settings = store.getSettings();
  const configured = process.env.MCP_ROUTER_PUBLIC_BASE_URL ?? settings.publicBaseUrl;
  if (configured) {
    return new URL(configured);
  }

  const host = process.env.HOST ?? settings.host ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? settings.port);
  const hostname = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formattedHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return new URL(`http://${formattedHost}:${port}`);
}

export function createOAuthRuntime(store: ConfigStore): OAuthRuntime | null {
  const settings = store.getSettings();
  if (!settings.oauth.enabled) {
    return null;
  }

  const ownerToken = store.getOAuthOwnerToken();
  if (!ownerToken) {
    throw new Error('OAuth is enabled but no owner password is configured');
  }

  const baseUrl = publicBaseUrl(store);
  const mcpUrl = new URL('/mcp', baseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const provider = new SingleUserOAuthProvider(
    {
      ownerToken,
      accessTokenTtlSeconds: settings.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: settings.oauth.refreshTokenTtlSeconds,
      scopes: settings.oauth.scopes,
      allowedRedirectHosts: settings.oauth.allowedRedirectHosts,
      allowedResourceUrls: settings.oauth.allowedResourceUrls,
    },
    resourceServerUrl,
    path.join(store.dataDir, 'oauth'),
  );

  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl: baseUrl,
    baseUrl,
    scopesSupported: settings.oauth.scopes,
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const bearerAuth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [settings.oauth.scopes[0] ?? 'mcp-router'],
    resourceMetadataUrl,
  });

  return {
    provider,
    bearerAuth,
    publicBaseUrl: baseUrl,
    resourceServerUrl,
    resourceMetadataUrl,
    oauthMetadata,
    close: () => provider.close(),
  };
}

export function installOAuthRoutes(app: Express, store: ConfigStore, runtime: OAuthRuntime): void {
  const settings = store.getSettings();
  app.use(
    mcpAuthRouter({
      provider: runtime.provider,
      issuerUrl: runtime.publicBaseUrl,
      baseUrl: runtime.publicBaseUrl,
      resourceServerUrl: runtime.resourceServerUrl,
      scopesSupported: settings.oauth.scopes,
      resourceName: 'MCP Router',
    }),
  );

  // Keep the same compatibility aliases that DevSpace exposes. Some clients
  // probe origin-level metadata even when the protected MCP resource is /mcp.
  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json(runtime.oauthMetadata);
  });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json({
      resource: runtime.resourceServerUrl.href,
      authorization_servers: [runtime.oauthMetadata.issuer],
      scopes_supported: settings.oauth.scopes,
      resource_name: 'MCP Router',
    });
  });

  // Gemini-compatible DCR alias retained from DevSpace; the standard /register
  // endpoint remains provided by mcpAuthRouter.
  app.post(
    '/',
    clientRegistrationHandler({
      clientsStore: runtime.provider.clientsStore,
    }),
  );
}

export function createOAuthMcpMiddleware(runtime: OAuthRuntime): RequestHandler {
  return async (req, res, next) => {
    await new Promise<void>((resolve, reject) => {
      runtime.bearerAuth(req, res, (error?: unknown) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    if (res.headersSent) {
      return;
    }

    const tokenResource = req.auth?.resource;
    const requestResource = new URL(req.originalUrl.split('?')[0] ?? '/mcp', runtime.publicBaseUrl);
    if (
      !tokenResource ||
      !runtime.provider.isResourceAllowed(tokenResource) ||
      !checkResourceAllowed({
        requestedResource: requestResource,
        configuredResource: tokenResource,
      })
    ) {
      res.set(
        'WWW-Authenticate',
        `Bearer error="invalid_token", error_description="Invalid OAuth resource", resource_metadata="${runtime.resourceMetadataUrl}"`,
      );
      res.status(401).json({ error: 'invalid_token', error_description: 'Invalid OAuth resource' });
      return;
    }
    next();
  };
}
