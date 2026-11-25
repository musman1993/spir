// Neon backend-as-code for SPIR.
// `neon deploy --env .env` applies this to the linked branch:
//   - the private "spir" bucket (Object Storage)
//   - the "spirapi" function (the whole backend API, a modular monolith)
// Neon injects DATABASE_URL and the AWS_* storage credentials automatically,
// so no database or storage secret is ever written here.
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    spir: { access: "private" },
  },
  functions: {
    spirapi: {
      name: "SPIR API",
      source: "./api/src/function.ts",
      env: {
        // Key used to encrypt QR tokens at rest (base64, 32 bytes). Must match the
        // value used when seeding, otherwise seeded QR labels cannot be re-printed.
        QR_TOKEN_KEY: { value: process.env.QR_TOKEN_KEY, required: true },
        // Comma-separated browser origins allowed to call the API (GitHub Pages, Codespaces).
        ALLOWED_ORIGINS: { value: process.env.ALLOWED_ORIGINS ?? "*", required: true },
        // Public base URL of the web app; printed into QR codes.
        PUBLIC_APP_URL: { value: process.env.PUBLIC_APP_URL ?? "", required: false },
        SPIR_BUCKET: process.env.SPIR_BUCKET ?? "spir",
        AUTH_MODE: process.env.AUTH_MODE ?? "demo",
      },
      dev: { port: 8787 },
    },
  },
});
