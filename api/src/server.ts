// Local / Codespaces development server: `npm run dev:api` (reads ../.env).
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createServicesFromEnv } from './config.js';

const services = await createServicesFromEnv(process.env);
const app = createApp(services);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`SPIR API listening on http://localhost:${port}  (storage: ${services.storage.kind}, portals: supplier + company, admin/admin)`);
});
