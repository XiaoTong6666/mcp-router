import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { errorMiddleware } from './api/error-middleware.ts';
import { createApiRouter } from './api/router.ts';
import { authDisabledByEnv, createAuthMiddleware, createOriginMiddleware } from './auth.ts';
import type { ConfigStore } from './config/store.ts';
import type { GatewayManager } from './gateway/manager.ts';
import { createMcpRouter } from './gateway/routes.ts';
import { createOAuthMcpMiddleware, createOAuthRuntime, installOAuthRoutes } from './oauth-runtime.ts';
import { RegistryClient } from './registry/client.ts';

export interface AppDeps {
  store: ConfigStore;
  manager: GatewayManager;
  registryClient?: RegistryClient;
  /** Override for tests; defaults to <repo>/app/dist. */
  appDistDir?: string;
}

/** Build the Express app (separate from listen() so tests can drive it with supertest). */
export function buildApp(deps: AppDeps): express.Express {
  const { store, manager } = deps;
  const registryClient = deps.registryClient ?? new RegistryClient();
  const app = express();
  app.disable('x-powered-by');
  // OAuth endpoints use express-rate-limit. Trust only loopback reverse proxies
  // (for example local Nginx/cloudflared) so forwarded client IPs work without
  // letting direct LAN/Internet peers spoof X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '4mb' }));

  const adminAuth = createAuthMiddleware(() => {
    const settings = store.getSettings();
    return {
      enabled: settings.authEnabled && !authDisabledByEnv(),
      token: process.env.MCP_ROUTER_TOKEN ?? settings.authToken,
    };
  });

  // Origin check first so a DNS-rebound browser request is rejected regardless of the bearer token
  // (which it cannot read anyway) — the one guard that still applies when SECURE_LOCAL_NET drops auth.
  const originGuard = createOriginMiddleware(() => store.getSettings().allowedOrigins);
  const oauth = createOAuthRuntime(store);
  if (oauth) {
    installOAuthRoutes(app, store, oauth);
    app.locals.oauthRuntime = oauth;
  }
  const mcpAuth =
    oauth && !authDisabledByEnv()
      ? createOAuthMcpMiddleware(oauth)
      : createAuthMiddleware(() => {
          const settings = store.getSettings();
          return {
            enabled: settings.authEnabled && !authDisabledByEnv(),
            token: process.env.MCP_ROUTER_TOKEN ?? settings.authToken,
          };
        });

  app.use('/api', adminAuth, createApiRouter({ store, manager, registryClient, dataDir: store.dataDir }));
  app.use('/mcp', originGuard, mcpAuth, createMcpRouter({ store, manager }));

  // Production: serve the built web UI with an SPA fallback for non-API GETs.
  const appDist = deps.appDistDir ?? path.resolve(import.meta.dirname, '../../app/dist');
  if (existsSync(appDist)) {
    app.use(express.static(appDist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
        res.sendFile(path.join(appDist, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use(errorMiddleware);
  return app;
}
