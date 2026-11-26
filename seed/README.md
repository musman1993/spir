# Demo data: `spir_seed.csv`

One row = one **version** of one **shipment record**: a quantity of one part shipped against one PO line.
Edit it in Excel or any CSV editor, save as CSV (UTF-8), then run `npm run db:reset`.

Real data (real POs, part numbers, supplier names) goes in **`seed/local/*.csv`**, which git ignores.
Those files are loaded after the main CSV, using the same columns.

## Columns

**Mandatory** fields are the ones a label check relies on. A record can't be submitted without them.

| Column | Required | What to put |
|---|---|---|
| `supplier_ref` | yes | Your short key for the supplier, e.g. `FCF`. A demo login `supplier-fcf` is created for it |
| `supplier_name` | **mandatory** | Legal name as printed on the supplier's shipping label. "Private Limited" and "Pvt Ltd" are treated as the same |
| `supplier_country` | no | 2-letter code |
| `product_ref` | yes | Your key for the product. The **first** row with a given key defines the product |
| `part_number` | **mandatory** | The **company** item number ("Item" on the receiving label, "Part No" on the supplier label) |
| `design_revision` | optional | e.g. `E` for "Rev:E" |
| `part_description` | yes | As on the purchase order, e.g. `"PLUG,BAL ~ 7 ORF,1L7500"`. Put it in quotes if it contains commas |
| `material` | optional | e.g. `ASTM A216 WCB` |
| `category` | yes | `VALVE_COMPONENT` |
| `product_status` | no | `APPROVED` (default), `PENDING`, `DRAFT` or `REJECTED` for the product's first version |
| `supplier_part_number` | optional | The supplier's own number, if different |
| `traceability_ref` | yes | Your key for the shipment record. **Repeat it on a later row to create a newer version** |
| `approval_status` | no | `APPROVED` (default), `PENDING`, `DRAFT` or `REJECTED` |
| `purchase_order_number` | **mandatory** | 10 digits, e.g. `7700104512` |
| `po_line_number` | **mandatory** | e.g. `4` for "LINE 4" |
| `quantity` | **mandatory** | Pieces on this PO line. A label showing `02/02` means piece 2 of a quantity of **2** |
| `heat_numbers` | **mandatory** | Separate several with `\|`, e.g. `HT-77813\|HT-77814` |
| `pattern_number` | **mandatory** | Casting pattern / mould number |
| `radiographic_test_number` | optional | RT report reference |
| `country_of_origin` | optional | 2-letter code (`IN`, `AE`, `DE` ...) |
| `documents` | no | `TYPE:filename`, several with `\|`. TYPE = `MTC`, `COC`, `RT_REPORT`, `INSPECTION_REPORT`, `DRAWING`, `OTHER`. Put real files in `seed/documents/`; missing ones get a generated demo PDF |
| `review_comment` | no | Reviewer's comment (shown to the supplier for `REJECTED`) |
| `batch_numbers`, `serial_numbers` | optional | Kept for parts that carry them |

Old valve-casting columns (`body_material_grade`, `pressure_class`, `nominal_size` ...) are retired. The loader
stops with a clear message if it sees one.

## Useful patterns

* **Pending update on a published record:** two rows with the same `traceability_ref`: first `APPROVED`, then `PENDING`
  (the demo uses this for a corrected quantity). QR scans and label checks keep using the approved one.
* **Rejected submission:** `approval_status = REJECTED` with a `review_comment`.
* **New attribute:** add a column, e.g. `test_pressure_bar`. It's registered automatically as a shipment attribute.

## Label photos (`seed/labels/`)

Synthetic labels with fictional data, in the same layouts as the real supplier and receiving labels.
See the main README for what each one demonstrates.
