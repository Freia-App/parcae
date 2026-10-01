/**
 * App-level pin for runtime CORS: `createApp({ isTrustedOrigin })` must
 * reach both the HTTP CORS middleware and the Socket.IO handshake. The
 * backend's server-cors unit tests drive `createServer_` directly; this is
 * the test that exercises the app.ts wiring, with a real socket.io-client
 * over both polling and WebSocket transports.
 */
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { io as socketIo } from 'socket.io-client';
import { createApp } from '@parcae/backend';
import type { ParcaeApp } from '@parcae/backend';
import { Document } from './models/document';
import {
  createPostgresTestDatabase,
  describePostgres,
} from './postgres-test';

const STATIC_ORIGIN = 'https://app.example.com';
const CLINIC_ORIGIN = 'https://portal.clinic.example';
const STRANGER_ORIGIN = 'https://evil.example';
const BROKEN_ORIGIN = 'https://broken.example';

const TEST_ENV = [
  'DATABASE_URL',
  'ENSURE_SCHEMA',
  'NODE_ENV',
  'REDIS_URL',
  'RUN_CRONS',
  'RUN_JOBS',
  'TRUSTED_ORIGINS',
] as const;

const reservePort = async (): Promise<number> => {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve an integration-test port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
};

describePostgres('createApp runtime CORS origins', () => {
  const previousEnv = new Map<string, string | undefined>();
  const testsRoot = fileURLToPath(new URL('.', import.meta.url));
  // Stands in for the app's verified-domain store, which changes after boot.
  const verified = new Set<string>();
  const asked: string[] = [];
  let app: ParcaeApp;
  let baseUrl: string;
  let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>;

  /** The Access-Control-Allow-Origin a plain GET gets back, or null. */
  const httpAllowOrigin = async (origin: string): Promise<string | null> => {
    const response = await fetch(`${baseUrl}/v1/health`, {
      headers: { origin },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    return response.headers.get('access-control-allow-origin');
  };

  /** The Access-Control-Allow-Origin an OPTIONS preflight gets back, or null. */
  const preflightAllowOrigin = async (
    origin: string,
  ): Promise<string | null> => {
    const response = await fetch(`${baseUrl}/v1/documents`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(204);
    if (response.headers.get('access-control-allow-origin') !== null) {
      expect(response.headers.get('access-control-allow-credentials')).toBe(
        'true',
      );
    }
    return response.headers.get('access-control-allow-origin');
  };

  /** Whether a real Socket.IO client presenting `origin` gets connected. */
  const socketConnects = (
    origin: string,
    transport: 'polling' | 'websocket',
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = socketIo(baseUrl, {
        path: '/ws',
        transports: [transport],
        extraHeaders: { origin },
        reconnection: false,
        timeout: 5_000,
      });
      socket.once('connect', () => {
        socket.disconnect();
        resolve(true);
      });
      socket.once('connect_error', () => {
        socket.disconnect();
        resolve(false);
      });
    });

  /** Every transport's answer for one origin, so a drift shows in one diff. */
  const decisions = async (origin: string) => {
    const http = await httpAllowOrigin(origin);
    const preflight = await preflightAllowOrigin(origin);
    return {
      http: http === null ? null : http === origin ? 'echoed' : http,
      preflight:
        preflight === null ? null : preflight === origin ? 'echoed' : preflight,
      polling: await socketConnects(origin, 'polling'),
      websocket: await socketConnects(origin, 'websocket'),
    };
  };

  const ALLOWED = {
    http: 'echoed',
    preflight: 'echoed',
    polling: true,
    websocket: true,
  };
  const DENIED = { http: null, preflight: null, polling: false, websocket: false };

  beforeAll(async () => {
    for (const key of TEST_ENV) previousEnv.set(key, process.env[key]);
    database = await createPostgresTestDatabase();
    process.env.DATABASE_URL = database.url;
    process.env.ENSURE_SCHEMA = 'true';
    process.env.NODE_ENV = 'test';
    process.env.RUN_CRONS = 'false';
    process.env.RUN_JOBS = 'false';
    process.env.TRUSTED_ORIGINS = STATIC_ORIGIN;
    delete process.env.REDIS_URL;

    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = createApp({
      models: [Document],
      modelsPath: 'models',
      root: testsRoot,
      isTrustedOrigin: async (origin) => {
        asked.push(origin);
        if (origin === BROKEN_ORIGIN) throw new Error('domain lookup failed');
        return verified.has(origin);
      },
    });
    await app.start({ port });
  });

  afterAll(async () => {
    if (app) await app.stop();
    if (database) await database.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('allows the static TRUSTED_ORIGINS list without asking the callback', async () => {
    asked.length = 0;

    expect(await decisions(STATIC_ORIGIN)).toEqual(ALLOWED);
    expect(asked).toEqual([]);
  });

  it('denies an origin the callback does not trust, on every transport', async () => {
    expect(await decisions(STRANGER_ORIGIN)).toEqual(DENIED);
  });

  it('trusts an origin verified after boot, on every transport', async () => {
    expect(await decisions(CLINIC_ORIGIN)).toEqual(DENIED);

    verified.add(CLINIC_ORIGIN);

    expect(await decisions(CLINIC_ORIGIN)).toEqual(ALLOWED);
    expect(asked).toContain(CLINIC_ORIGIN);
  });

  it('denies, and keeps serving, when the callback throws', async () => {
    expect(await decisions(BROKEN_ORIGIN)).toEqual(DENIED);
    expect(await decisions(STATIC_ORIGIN)).toEqual(ALLOWED);
  });
});
