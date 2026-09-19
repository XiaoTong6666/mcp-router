import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { ConfigStore } from '../config/store.ts';
import { GatewayManager } from '../gateway/manager.ts';

interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

describe('OAuth MCP authentication', () => {
  let dataDir: string;
  let store: ConfigStore;
  let manager: GatewayManager;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-router-oauth-'));
    store = new ConfigStore(dataDir);
    await store.init();
    await store.updateSettings({
      publicBaseUrl: 'http://127.0.0.1:3000',
      oauth: {
        ...store.getSettings().oauth,
        enabled: true,
      },
    });
    await store.saveWorkspace({
      name: 'ChatGPT',
      slug: 'chatgpt',
      enabled: true,
      members: {},
    });
    manager = new GatewayManager(() => store.getSettings());
    await manager.reconcile(store.getServers(), store.getWorkspaces());
    app = buildApp({ store, manager, appDistDir: path.join(dataDir, 'no-ui') });
  });

  afterEach(async () => {
    (app.locals.oauthRuntime as { close?: () => void } | undefined)?.close?.();
    await manager.stopAll();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('publishes OAuth authorization and protected-resource metadata', async () => {
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: 'http://127.0.0.1:3000/',
      authorization_endpoint: 'http://127.0.0.1:3000/authorize',
      token_endpoint: 'http://127.0.0.1:3000/token',
      registration_endpoint: 'http://127.0.0.1:3000/register',
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    });

    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body).toMatchObject({
      resource: 'http://127.0.0.1:3000/mcp',
      authorization_servers: ['http://127.0.0.1:3000/'],
      resource_name: 'MCP Router',
    });

    const originAlias = await request(app).get('/.well-known/oauth-protected-resource');
    expect(originAlias.status).toBe(200);
    expect(originAlias.body.resource).toBe('http://127.0.0.1:3000/mcp');
  });

  it('returns a discoverable OAuth challenge from MCP routes', async () => {
    const res = await request(app).post('/mcp/w/chatgpt').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('rejects dynamic registration to a redirect host outside the allowlist', async () => {
    const res = await request(app)
      .post('/register')
      .send({
        client_name: 'evil',
        redirect_uris: ['https://evil.example/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    expect(res.status).toBe(400);
  });

  it('completes DCR + PKCE authorization + refresh and scopes the token to its MCP resource', async () => {
    const redirectUri = 'https://chatgpt.com/oauth/callback';
    const resource = 'http://127.0.0.1:3000/mcp/w/chatgpt';
    const verifier = 'mcp-router-oauth-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const registered = await request(app)
      .post('/register')
      .send({
        client_name: 'ChatGPT test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    expect(registered.status).toBe(201);
    const clientId = registered.body.client_id as string;
    expect(clientId).toMatch(/^mcp-router-/);

    const authorizeParams = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp-router',
      state: 'state-1',
      resource,
    };
    const approval = await request(app).get('/authorize').query(authorizeParams);
    expect(approval.status).toBe(200);
    expect(approval.text).toContain('Owner password');

    const ownerToken = store.getOAuthOwnerToken();
    expect(ownerToken).toBeTruthy();
    const approved = await request(app)
      .post('/authorize')
      .type('form')
      .send({ ...authorizeParams, owner_token: ownerToken });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.location as string);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('state-1');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      });
    expect(token.status).toBe(200);
    const first = token.body as TokenPair;
    expect(first.token_type).toBe('bearer');
    expect(first.access_token).toBeTruthy();
    expect(first.refresh_token).toBeTruthy();

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'oauth-test', version: '1.0.0' },
      },
    };
    const mcp = await request(app)
      .post('/mcp/w/chatgpt')
      .set('Authorization', `Bearer ${first.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);
    expect(mcp.status).toBe(200);
    expect(mcp.headers['mcp-session-id']).toBeTruthy();

    // A token minted specifically for /mcp/w/chatgpt must not widen itself to /mcp.
    const wider = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${first.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);
    expect(wider.status).toBe(401);

    const refreshed = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: first.refresh_token,
        resource,
      });
    expect(refreshed.status).toBe(200);
    const second = refreshed.body as TokenPair;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Refresh tokens are one-time rotated, matching DevSpace's transactional store.
    const replay = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: first.refresh_token,
        resource,
      });
    expect(replay.status).toBe(400);
  });
});
