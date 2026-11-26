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
