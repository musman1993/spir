# SPIR: Supplier Product Information Registry (proof of concept)

SPIR is a company-owned registry for **supplier product identity, manufacturing traceability and certificates**,
built from *SPIR Architecture & Requirements Specification v1.1*. This PoC uses valve components and fictional suppliers.

**How a part is identified** (from real receiving labels):

| Mandatory | Optional |
|---|---|
| Part number (company item number), purchase order number + PO line, heat number, quantity, pattern number, supplier | Radiographic test (RT) number, part description, material, design revision, country of origin |

A product is one company part number from one supplier. Each **shipment** against a PO line is a separate
record with its own versions, certificates and QR label.

## How it works right now (open mode)

There is **no sign-in and there are no roles** for now. Everyone is a generic "operator". The supplier portal
and approval workflow are still in the code, switched off, ready to become the supplier module later.

1. **Import CSV:** one row per shipment (part number, PO + line, quantity, heats, pattern number, supplier...).
   SPIR creates a shipment record and **a QR code for each new row**.
2. **QR labels:** print them as a sheet, download PNGs for a label printer, or export the links as CSV.
3. **Scan a QR code** with a phone camera, webcam or handheld scanner to see the shipment's details and certificates.

**Updating:** change the CSV and import it again. A changed row adds a new version to the same record, and **its
printed QR code keeps working and shows the new data**. Identical rows are skipped. If any row is missing a mandatory
field, nothing is imported and every problem is listed by row. A shipment is identified by supplier + part number +
PO + line.

> **Open mode means no access control.** Anyone who can reach the app can read and change the data. Keep real data on
> a private address. A Codespace with **private** ports is ideal, because GitHub asks for your login. Don't publish real
> data to a public GitHub Pages URL in this mode. To bring back the role switcher, set `AUTH_MODE=demo`.

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

### Option A: quickest, no Neon needed (data resets on restart)

```bash
npm install
npm run dev:empty     # empty registry: import your own CSV
# or
npm run dev:memory    # with the demo data (+ your private seed/local/*.csv)
```

Open the **Ports** tab and click the globe icon next to port **5173**. Go to **Import CSV**.

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
* **Real data goes in `seed/local/*.csv`** (git-ignored, loaded after the demo file). Never put real POs in the main CSV: the repo is public.
* Add a new column and it becomes a new **attribute** automatically. No code change needed.

After editing: `npm run db:reset`.

## Trying the label check

`seed/labels/` holds six demo photos in the layouts of the real labels (fictional data):

| Photo | Expected result | Why |
|---|---|---|
| `supplier-label-fcf-t001-correct.png` | Pass | Every field checks out |
| `supplier-label-fcf-t001-wrong-quantity.png` | Fail | Quantity `01/05` = 5, approved 3 |
| `supplier-label-fcf-t003-quantity-only-in-pending-version.png` | Fail | Quantity 3 exists only in a *pending* update. Checks always compare with the approved version |
| `receiving-label-fcf-t002.png` | Needs review | Part number and PO come from the barcodes, but this label type carries no supplier or heat |
| `supplier-label-dac-t001-angled-blurry.png` | Needs review | OCR read the heat as `DH-55%0` and lost the slash in `12/12`. Flagged, not failed |
| `supplier-label-nhg-t001-with-rt-and-pattern.png` | Pass with warnings | Pattern and RT numbers checked; description read with low confidence |

Go to *Check a product label* > *Upload photo* > **drag a box around the label** >
*Read the label* > *Compare with the registry*. Click a row to see where it was read; press *Review* to correct a misread.
**Nothing on this page ever changes registry data.**

### Getting good results on real labels

Tested on three real receiving photos (kept private). What decides success:

1. **Crop to the label.** On the full photo Tesseract read almost nothing (26-35% confidence). Cropped and enlarged, it read
   the supplier, part number, PO, heat and country correctly.
2. **Use the camera's original resolution.** Photos forwarded through chat apps are 450-800 px wide, which is too small for the barcodes
   (only a tight crop of one barcode decoded). A phone camera's original photo is 4000+ px.
3. **Avoid glare from plastic wrap and stamps over the text.** These made two of the three real photos unreadable.
4. Hand-ticked fields (pen marks over "02/02") are read with low confidence and go to review. That's intended.

How the matching copes with OCR damage, without ever guessing a match:
* Field names with OCR errors are still recognised ("artNe" = Part No, "PONe" = PO No, "Qry" = QTY), but only when the value follows directly.
* Part numbers and 10-digit POs are also found by their shape; bare barcodes are assigned to a field by shape.
* A read with impossible characters (`DH-55%0`), a cut-off read (`DH-55`) or a quantity with a lost slash (`1212`) goes to **review**, not fail.
* An exact read of a long identifier counts as a match even when Tesseract's confidence is low (it's poorly calibrated for codes).
  Short values (quantity, line, revision) still need a human when confidence is low.
* A record is matched by part number + (PO or heat), or PO + (heat or PO line). Names and descriptions are never used for matching.

To add your real photos to the test suite privately, see `api/test/private-corpus.test.ts`.

## Tests

```bash
npm test
```

61 tests run the whole API against an in-process Postgres with the real seed CSV. They cover supplier isolation,
approval and supersede rules, QR tokens (401/403/404/410, rotation), signed downloads, the field results, the
overall status policy, CSV import (create, update under the same QR, reject with row errors), and a golden corpus of **real Tesseract + ZXing output** from the demo photos. A private corpus of real
label photos runs only where its git-ignored files exist.

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
