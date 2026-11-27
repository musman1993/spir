# Architecture decisions (PoC)

Short records of decisions made while building the PoC, mapped to the spec's ADR list (section 5.2).

| # | Decision | Why | Revisit when |
|---|---|---|---|
| ADR-001 | One Neon Function (`spirapi`) holds all modules: a modular monolith | Spec recommends it; modules only call each other's exported functions | A module needs independent scaling, release or security boundary |
| ADR-003 | Identity, lifecycle and relationships are relational. Attribute **values** are JSONB, governed by `attribute_definition` | Spec 7.5. New attributes need no schema change; GIN indexes exist | A JSONB field becomes a frequent filter: promote it to a column |
| ADR-005/006/009 | Product ID, Traceability ID and QR token are separate. Token = 256-bit random, stored as SHA-256 hash + AES-GCM ciphertext | Lookup without storing the plain token; authorised re-printing; rotation keeps the Traceability ID | Printing moves to a label service: drop the ciphertext and print only at issue time |
| ADR-007/008 | Versions: DRAFT, PENDING, APPROVED, REJECTED, SUPERSEDED. One approved + one open version per record, enforced by partial unique indexes. Approved content immutable by trigger | Spec 9. Invariants hold even if application code is wrong | Withdrawal / multi-level approval are added |
| ADR-010 | Heats and batches are separate entities scoped by supplier, linked many-to-many **per traceability version** | Spec 6.4. A version change can change the heat set without rewriting history | Batch-heat proportions become governed data |
| ADR-011 | Browser device adapters: getUserMedia camera, ZXing barcodes, keyboard-wedge scanner detection by key timing | No drivers to install. Each adapter sits behind an interface | A device needs a vendor SDK: add an edge connector adapter |
| ADR-012 | OCR (Tesseract.js) in the browser. Extraction, matching and comparison on the server, versioned (`compare-v1/overall-v1/resolver-v1`) and pinned to approved versions | Server rules are auditable and engine-independent. Raw OCR is never overwritten | Accuracy on real labels is too low: switch the OCR adapter to a server/managed engine |
| new | Label profiles are versioned data. v2 was calibrated on real Tesseract output (`S/N` read as `SIN`; poorly calibrated confidence for hyphenated codes) | Spec 11A.17: thresholds must be measured, not guessed | Real supplier photos arrive: profile v3 + golden corpus |
| new | Demo header auth behind `AuthProvider` | User chose a role switcher for the demo | Before any real data: OIDC / Neon Managed Auth |
| new | All SQL is schema-qualified (`spir.*`); migrations use `SET LOCAL` | Neon's pooled connections don't reliably keep session settings | - |
| new | Overall status policy `overall-v1`: any critical mismatch = FAIL; any unconfirmed critical field = NEEDS_REVIEW; non-critical issues = PASS_WITH_WARNINGS | Spec 11A.8: a critical exception can't be hidden by many matches | Quality owners approve a severity model |
| new | Identification model from real receiving labels: part number (company item), PO + line, heat, quantity, pattern number, supplier are mandatory; RT, description, material, revision, country optional. A product = one company part number from one supplier; a record = one shipment on a PO line | The user's real labels and receiving process | - |
| new | `compare-v2`: exact read of a 5+ character identifier is a MATCH even at low engine confidence; impossible characters, cut-off reads and lost slashes go to REVIEW_REQUIRED | Measured on real Tesseract output: correct heat reads scored 21-36%; false FAILs came from `DH-55%0` and `1212` | Quality owners review; recalibrate on a larger real corpus |
| new | `overall-v2`: a non-critical field simply not printed on the label is not a warning | Most labels don't carry pattern, RT or material | - |
| new | `resolver-v2`: part number + (PO or heat), or PO + (heat or PO line) | PO + line is how receiving identifies an order line; names never used | Several shipments per PO line become common: require heat too |
| new | Label check crops and upscales in the browser; barcodes scanned in strips; OCR-tolerant field labels | Full-frame real photos were unreadable; cropping made them readable | Move to server-side OCR if accuracy stays low |
| new | Real samples live in git-ignored `seed/local/` and `api/test/fixtures/local/` | Real POs/part numbers/supplier names must not enter a public repo | - |
| new | Open mode (`AUTH_MODE=open`, default): no sign-in, one generic `operator` who may do everything. Role code kept, switched off | User: "kill all the actors" until the supplier module exists | Before any shared or public deployment: SSO |
| new | CSV import in the app: all-or-nothing with per-row errors; a changed row = new approved version of the same record; QR tokens never replaced by an import | Printed labels must stay valid while data is corrected | Supplier module takes over data entry |

## QR labels for phone cameras (v0.3)
- **Problem:** phone cameras didn't detect the codes. Causes found: small images scaled down with `image-rendering: pixelated`, a 1-module border, and long links (Codespace address + 43-character token).
- **Tokens:** now 16 characters of Crockford base32 (80 random bits). Only the SHA-256 is stored, and lookups are rate limited. Old 43-character tokens still resolve.
- **Error correction:** the strongest level (H, Q, then M) that doesn't make the code bigger than M would. Bigger squares help a phone more than spare correction does.
- **Logo:** sits in a cut-out in the middle that lines up with the grid, at 20% of the width or less (about 4% of the area). Every code is decoded with ZXing right after it's drawn; if that fails, the logo is shrunk, then dropped.
- **Border:** 2 modules inside the image, plus the label's white padding, for at least 4 in total.
- **Test (Codespace-length links, 32 mm code, blurred, noisy, tilted capture, zxing-cpp):** with 150 px across the code, the old codes decoded 13/20 and the new codes with the logo 20/20. 8-per-sheet labels (54 mm code) decoded in every condition tested.
- **Sheets:** A4 8/14/21 per sheet, laid out in real millimetres using `@page sheet { size: A4; margin: 0 }`, with a start position and a printer offset.

## Cozy glass visual system (v0.4)
- Approved from the design mockups: a deep-blue glass rail (`rgba(0,75,141,.92)`, blur 18px) over a warm mist canvas (`#F4F6F9`) with faint amber (`#F79428` at 8%) and sky-cyan (`#87E5FF` at 12%) washes. Cards, tables and panels are frosted white (`rgba(255,255,255,.78)`, blur 14px, `1px solid rgba(0,164,210,.22)`, 18px radius).
- Tokens: `#004B8D` for primary buttons and table/card headers; `#00A4D2` for active borders, focus and QR indicators; APPROVED `#00AA7E`/`#62BB46`; PENDING `#F79428`; DRAFT `#FFCF22`; warm callouts `#8A4B05`; REJECTED/errors `#D31245`; historical/superseded `#959797`.
- Accessibility: brand colours too light for small text on white (cyan, green, amber, yellow, grey) colour the dot, border or wash, and a darker shade of the same hue carries the words (for example links are `#00739A`), so text stays at 4.5:1 or better.
- Type: Figtree for the interface, IBM Plex Mono for identifiers.
- Printing drops blur and tints so labels and records print on plain white. Browsers without `backdrop-filter` get near-opaque cards.

## Two portals, two accounts (v0.5)
- **Supplier portal** (`/#/supplier`) and **company portal** (`/#/company`) at separate addresses, each with its own
  sign-in. Both use `admin` / `admin` for now (fixed, by request). The supplier account (`supplier-admin`) belongs to
  one supplier, set in its **profile**; the company account (`company-admin`) sees every supplier.
- Sessions: HMAC-signed tokens (12 hours) sent as `Authorization: Bearer`. The web app keeps one token per portal
  and picks it from the address, so the two sessions never mix in one browser.
- **No approval step for now:** a saved shipment (form or CSV) is live at once; a change adds a new version and
  supersedes the previous one, under the same QR code. Part number, PO and line identify a shipment and can't change
  in an edit. The form goes through the CSV import engine, so both follow identical rules.
- **QR scans are open to anyone** (by request): `/qr/:token` and `/qr/:token/documents/:code` need no sign-in, are
  rate limited per address, and a token only opens its own record's certificates. Label printing, replacement and
  revocation are supplier-only.
- The company portal has the scanner, shipment search and the label check (OCR). The audit API stays (company only)
  without a screen.
- Removed from the app: role switcher, supplier contributor / reviewer / inspector / QR user / auditor roles, review
  queue and approval workflow, open mode. Kept on the branch `archive/roles-and-review` for when RBAC returns.
  Old user rows stay in the database, inactive, because historical versions and audit events point at them.

## Decisions of 27 November 2026 (recorded in the documentation, not yet built)

| ID | Decision | Reason |
|---|---|---|
| Scan access | Every QR scan needs a company sign-in (details and certificates). Replaces "QR scans open to anyone" from v0.5. Phase 1. | Shipment data and certificates are company and supplier information |
| Approval | Proposed: a PO match check compares supplier data with the purchase order and raises an alarm on differences, instead of manual approval. Open questions in SPIR-SCP-001. | People look at exceptions only; receiving already checks every shipment |
| QR address | GitHub Pages for now; company address before full roll-out; leave a redirect page if it moves | No company domain yet |
| Ownership | Product owner and credential rotation: M. Usman. Sponsor and scan access: Quality manager. Shared sign-in / SSO: IT | Every risk needs an owner |
