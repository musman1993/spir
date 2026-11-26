// SPIR API - modular monolith (ADR-001). Each module owns its routes and tables;
// modules talk through exported functions, not each other's private SQL.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { Services } from './config.js';
import type { Principal } from './providers/auth.js';
import { ApiError } from './lib/errors.js';
import { verifyLocal } from './providers/storage.js';
import { catalogRoutes } from './modules/catalog.js';
import { productRoutes } from './modules/products.js';
import { traceabilityRoutes } from './modules/traceability.js';
import { qrRoutes } from './modules/qr.js';
import { validationRoutes } from './modules/validation.js';
import { auditRoutes } from './modules/audit.js';
import { importRoutes } from './modules/importer.js';
import { portalRoutes } from './modules/portal.js';

export type AppEnv = {
  Variables: {
    services: Services;
    principal: Principal | null;
    cid: string;
  };
};

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();
  const { allowedOrigins } = services.config;

  app.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.includes('*') ? origin || '*' : allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
      exposeHeaders: ['X-Correlation-Id', 'Content-Disposition'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.use('*', async (c, next) => {
    const cid = c.req.header('x-correlation-id')?.slice(0, 64) || randomUUID();
    c.set('cid', cid);
    c.set('services', services);
    c.set('principal', await services.auth.authenticate(c.req.raw));
    await next();
    c.header('X-Correlation-Id', cid);
    // Authenticated business data must not be cached by browsers or proxies (spec 14.4).
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    const cid = c.get('cid');
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details, correlationId: cid } }, err.status);
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'The request is not valid.', details, correlationId: cid } }, 422);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON.', correlationId: cid } }, 400);
    }
    const pgCode = (err as any)?.code;
    if (pgCode === '23505') {
      return c.json({ error: { code: 'DUPLICATE', message: 'A record with the same identifier already exists.', correlationId: cid } }, 409);
    }
    console.error(`[${cid}]`, err);
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', correlationId: cid } }, 500);
  });

  app.get('/', (c) => c.json({ service: 'SPIR API', docs: 'api/openapi.yaml in the repository', health: '/api/v1/health' }));
  app.get('/api/v1/health', async (c) => {
    await services.db.query('SELECT 1');
    return c.json({ ok: true, storage: services.storage.kind, authMode: services.auth.mode, time: new Date().toISOString() });
  });

  // Files served by the local-disk / memory storage adapters (signed, expiring links only).
  app.get('/api/v1/files', async (c) => {
    const key = c.req.query('key') ?? '';
    const exp = Number(c.req.query('exp'));
    const sig = c.req.query('sig') ?? '';
    if (!verifyLocal(services.config.fileSigningSecret, key, exp, sig)) throw new ApiError(403, 'LINK_EXPIRED', 'This file link is invalid or has expired.');
    const obj = await services.storage.get(key);
    if (!obj) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    return new Response(Buffer.from(obj.bytes), { headers: { 'Content-Type': obj.contentType, 'Cache-Control': 'private, no-store' } });
  });

  const v1 = new Hono<AppEnv>();
  v1.route('/', catalogRoutes());
  v1.route('/', productRoutes());
  v1.route('/', traceabilityRoutes());
  v1.route('/', portalRoutes());
  v1.route('/', qrRoutes());
  v1.route('/', validationRoutes());
  v1.route('/', auditRoutes());
  v1.route('/', importRoutes());
  app.route('/api/v1', v1);

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}`, correlationId: c.get('cid') } }, 404));
  return app;
}

/** Turn a storage URL into an absolute one (local adapters return API-relative paths). */
export function absoluteUrl(c: { req: { url: string; header: (n: string) => string | undefined } }, url: string) {
  if (!url.startsWith('/')) return url;
  // Behind Codespaces / proxies, trust the forwarded host so links work from the browser.
  const fwdHost = c.req.header('x-forwarded-host');
  const fwdProto = c.req.header('x-forwarded-proto');
  const base = fwdHost ? `${fwdProto ?? 'https'}://${fwdHost}` : c.req.url;
  return new URL(url, base).toString();
}
