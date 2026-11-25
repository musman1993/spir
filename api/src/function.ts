// Neon Functions entry point. Neon injects DATABASE_URL and AWS_* (Object Storage) at runtime.
// Services are created once per isolate and reused across requests.
import { createApp } from './app.js';
import { createServicesFromEnv } from './config.js';

let appPromise: Promise<ReturnType<typeof createApp>> | null = null;
const getApp = () => (appPromise ??= createServicesFromEnv(process.env).then(createApp));

const handler = {
  async fetch(request: Request) {
    try {
      const app = await getApp();
      return app.fetch(request);
    } catch (e) {
      appPromise = null; // allow a retry on the next request
      console.error('[spir] startup failed', e);
      return new Response(JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'API could not start; check function logs.' } }), {
        status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};

export default handler;
