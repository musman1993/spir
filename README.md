# SPIR: Supplier Product Information Registry (proof of concept)

SPIR is a company-owned registry for **supplier product identity, manufacturing traceability and certificates**,
built from *SPIR Architecture & Requirements Specification v1.1*. This PoC uses cast valve bodies and fictional suppliers.

What it does, in one line per role:

| Who | What they do in SPIR |
|---|---|
| Supplier contributor | Registers products and manufacturing records (heats, batches, serials), uploads MTC/CoC, submits for approval |
| Company reviewer | Sees a diff of every submission, approves or rejects with a reason. Approval publishes it and activates its QR label |
| QR user | Scans a QR label, signs in, and sees **only the latest approved** record and its certificates |
| Label inspector | Photographs an existing supplier sticker. OCR reads it, and SPIR shows a field-by-field validation matrix against the approved record |
| Registry admin / auditor | Manages QR labels and configuration, and reads the append-only audit trail |

## How it is put together

```
GitHub Pages (React web app, public static files - no secrets)
      |  HTTPS + X-SPIR-User header (demo sign-in)
      v
Neon Function "spirapi"  (Node 24, Hono, one modular monolith)
      |-- Neon Postgres   schema "spir": products, versions, heats/batches, QR tokens, validation runs, audit
      '-- Neon Object Storage  private bucket "spir": certificates + label photos (5-minute signed links only)
```

* **OCR runs in the browser** (Tesseract.js in a Web Worker). The server does field extraction, record
  matching and comparison, so the OCR engine can be swapped without touching the business rules.
* **Interfaces from day one:** `api/src/providers/` (database, storage, auth) and `web/src/devices/`
  (camera, barcode, OCR, USB/Bluetooth keyboard-wedge scanner).
* **Business invariants enforced by the database:** approved versions can't be edited (trigger), one
  approved and one open version per record (unique indexes), the audit trail is append-only (trigger), and
  only one active QR per record.

## Run it in your Codespace

### Option A: quickest demo, no Neon needed (data resets on restart)

```bash
npm install
npm run dev:memory
```

Open the **Ports** tab and click the globe icon next to port **5173**. Pick a person on the sign-in screen.

### Option B: against your Neon database

1. **Create your `.env` file** (the Codespace already copied it from `.env.example`):
   ```bash
   code .env
   ```
   Fill in:
   * `DATABASE_URL`: Neon console > your SPIR project > **Connect** > copy the connection string.
     *Reset the database password first if you ever pasted it somewhere public.*
   * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: Neon console > **Credentials** (Object Storage).
     Leave them empty to keep files on local disk while testing.
   * `QR_TOKEN_KEY`: generate one and paste it in:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
     Keep this value. The deployed API must use the same one (step 3) or seeded QR labels can't be re-printed.

2. **Create the tables and load the demo data**:
   ```bash
   npm run db:setup      # migrations + seed/spir_seed.csv
   npm run dev           # API on 8787, web app on 5173
   ```
   To start over later: `npm run db:reset` (it asks before deleting anything).

3. **Deploy the API to Neon Functions** (one time, from the Codespace):
   ```bash
   neon login            # opens a browser tab to sign in
   neon link             # choose the SPIR project, branch "production"
   npm run deploy:api    # = neon deploy --env .env
   neon functions get spirapi   # shows the public API URL
   ```

4. **Publish the web app to GitHub Pages**:
   * GitHub repo > **Settings > Pages** > Source: **GitHub Actions**.
   * **Settings > Secrets and variables > Actions > Variables**: add `SPIR_API_URL` = the URL from step 3.
   * Push to `main` (or run the *Deploy web app* workflow). The site appears at `https://<you>.github.io/spir/`.
   * Redeploy the API with `ALLOWED_ORIGINS=https://<you>.github.io` and `PUBLIC_APP_URL=https://<you>.github.io/spir` in `.env`.

   Optional, for automatic API deploys on every push: connect the repo in Neon console > **Integrations > GitHub**
   (this creates `NEON_API_KEY`), then add the secrets/variables listed at the top of `.github/workflows/deploy-api.yml`.

## Editing the demo data

Everything comes from **`seed/spir_seed.csv`**, one row per version of a manufacturing record. Open it in
Excel or the Codespace CSV viewer. The full guide is in [`seed/README.md`](seed/README.md). The short version:

* `supplier_ref`, `product_ref`, `traceability_ref` are **your** linking keys. SPIR creates the official IDs.
* Repeat a `traceability_ref` on a later row to create a **newer version** (e.g. `APPROVED` then `PENDING`).
* Lists use `|`: `HT-77813|HT-77814`. Documents use `TYPE:file.pdf`.
* Add a new column and it becomes a new **attribute** automatically. No code change needed.

After editing: `npm run db:reset`.

## Trying the label check

`seed/labels/` holds five demo sticker photos, each showing a different outcome:

| Photo | Expected result | Why |
|---|---|---|
| `fcf-trc1-correct.png` | Pass | Everything matches |
| `fcf-trc1-wrong-heat.png` | Fail | Heat HT-77819 vs approved HT-77812 |
| `fcf-trc3-serial-only-in-pending-version.png` | Fail | SN-10042 exists only in a *pending* version. Checks always compare with the approved one |
| `nhg-trc1-german-tag.png` | Needs review | German field names are understood, but OCR was unsure of the heat number |
| `dac-trc1-angled-blurry.png` | Needs review | Blurred photo, low confidence on the material grade |

Sign in as **Priya Nair (Label inspector)** > *Check a product label* > *Upload photo* > *Read the label* >
*Compare with the registry*. On the result page, click a row to see where it was read, then press *Review*
to correct an OCR misread or raise a discrepancy. **Nothing on this page ever changes registry data.**

When your real sticker photos arrive, the label profile (`api/db/migrations/003_label_profile_v2.sql`) gets a
new version with their field words and calibrated confidence thresholds, and the photos join the test corpus in
`api/test/fixtures/`.

## Tests

```bash
npm test
```

41 tests run the whole API against an in-process Postgres with the real seed CSV. They cover supplier isolation,
approval and supersede rules, QR tokens (401/403/404/410, rotation), signed downloads, the 9 field results, the
overall status policy and a golden corpus of **real Tesseract output** from the demo photos.

## Security notes for this PoC

* **Demo sign-in is not authentication.** Anyone with the API URL can act as any demo user. Use fictional data
  only. Production replaces `createDemoHeaderAuth` with company SSO (OIDC / Neon Managed Auth); the rest is unchanged.
* GitHub Pages sites are public. The web build holds no secrets, only the API URL.
* QR codes contain only a random 256-bit token. It's stored hashed for lookup and AES-GCM encrypted for re-printing.
* The database and bucket credentials exist only in `.env` (git-ignored) and Neon's own injected variables.

## Not in this PoC yet (next steps)

* **X12 832/841** intake and 997/999 acknowledgments (spec section 10). The canonical model and `source = 'EDI'`
  are ready for the adapter.
* Real sign-in (company SSO), supplier user administration, multi-level approval.
* Offline capture queue, edge connector for fixed cameras, malware scanning of uploads.
* Admin screens to edit attribute definitions and label profiles (currently changed through migrations).

## Where things are

| Path | What |
|---|---|
| `api/src/domain/` | Pure label-validation engine: normalization, extraction, comparison, overall policy |
| `api/src/modules/` | Products, traceability, workflow, QR, validation, audit |
| `api/db/migrations/` | Schema and reference data (attributes, label profiles) |
| `api/openapi.yaml` | API contract |
| `web/src/pages/` | Screens. `web/src/devices/` holds the camera / scanner / OCR adapters |
| `seed/` | Demo CSV, label photos, optional real certificate files (`seed/documents/`) |
| `docs/decisions.md` | Architecture decisions taken for this PoC |
