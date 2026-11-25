# Demo data: `spir_seed.csv`

One row = one **version** of one **manufacturing (traceability) record**. Edit it in Excel or any CSV editor,
save as CSV (UTF-8), then run `npm run db:reset`.

## Columns

| Column | Required | What to put |
|---|---|---|
| `supplier_ref` | yes | Your short key for the supplier, e.g. `FCF`. Rows with the same key are the same supplier. A demo login `supplier-fcf` is created for it |
| `supplier_name`, `supplier_country` | name yes | Legal name and 2-letter country code |
| `product_ref` | yes | Your key for the product. The **first** row with a given key defines the product |
| `product_name`, `category`, `description` | name, category yes | `category` must be `VALVE_BODY_CAST` (add more in a migration) |
| `product_status` | no | `APPROVED` (default), `PENDING`, `DRAFT` or `REJECTED` for the product's first version |
| `supplier_part_number` | yes | Exactly as printed on the supplier's label |
| `manufacturer_part_number` | no | |
| `body_material_grade` | product attribute | One of `A216-WCB`, `A351-CF8M`, `A352-LCC`, `A217-WC6`, `A536-65-45-12` |
| `pressure_class` | product attribute | `CL150`, `CL300`, `CL600`, `CL800` ... |
| `nominal_size`, `end_connection`, `design_standard` | product attribute | e.g. `2IN`, `RF`, `ASME B16.34` |
| `traceability_ref` | yes | Your key for the manufacturing record. **Repeat it on a later row to create a newer version** |
| `approval_status` | no | `APPROVED` (default), `PENDING`, `DRAFT` or `REJECTED` |
| `heat_numbers`, `batch_numbers`, `serial_numbers` | heat or batch for submit | Separate several with `\|`, e.g. `HT-77813\|HT-77814` |
| `casting_foundry`, `pour_date`, `manufacturing_date`, `country_of_origin` | attributes | Dates as `YYYY-MM-DD` |
| `tensile_strength_mpa`, `yield_strength_mpa`, `hardness_hb` | attributes | Numbers |
| `documents` | no | `TYPE:filename`, several with `\|`. TYPE = `MTC`, `COC`, `INSPECTION_REPORT`, `DRAWING`, `OTHER`. Put real files in `seed/documents/`; missing ones get a generated demo PDF. `revB` in the name sets revision B |
| `review_comment` | no | Reviewer's comment (shown to the supplier for `REJECTED`) |

## Useful patterns

* **Pending update on a published record:** two rows with the same `traceability_ref`: first `APPROVED`, then `PENDING`.
  QR scans keep showing the approved one until a reviewer approves the update.
* **Rejected submission:** `approval_status = REJECTED` with a `review_comment`.
* **New attribute:** add a column, e.g. `test_pressure_bar`. It's registered as a manufacturing attribute
  automatically and shows up in the forms and record pages.

## Label photos (`seed/labels/`)

Synthetic sticker photos for trying the label check. See the table in the main README for what each one shows.
