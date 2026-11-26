-- Identification model from real receiving labels (supplier shipping label + company receiving label).
--
-- Mandatory: part number (the COMPANY's item number), purchase order number + PO line, heat number,
--            quantity, pattern number, supplier.
-- Optional:  radiographic test (RT) number, part description, material, design revision, country of origin.
--
-- Old valve-casting attributes are DEPRECATED, not deleted: history and earlier validation runs
-- keep their meaning (spec 7.6). Changed rules for kept attributes get a new definition version.
SET LOCAL search_path TO spir, public;

-- The company part number ("Item" on the receiving label, "Part No" on supplier labels).
ALTER TABLE product_identifier DROP CONSTRAINT IF EXISTS product_identifier_id_type_check;
ALTER TABLE product_identifier ADD CONSTRAINT product_identifier_id_type_check
  CHECK (id_type IN ('COMPANY_PART_NUMBER','SUPPLIER_PART_NUMBER','MANUFACTURER_PART_NUMBER','OTHER'));

INSERT INTO product_category (code, name, description) VALUES
  ('VALVE_COMPONENT', 'Valve component', 'Valve parts and trim: bodies, bonnets, plugs, cages, seats, stems');

-- Retire everything from 002 that is not part of the new identification model.
UPDATE attribute_definition SET status = 'DEPRECATED'
 WHERE attribute_key IN ('supplier_part_number','manufacturer_part_number','body_material_grade','pressure_class',
                         'nominal_size','end_connection','design_standard','casting_foundry','pour_date',
                         'manufacturing_date','tensile_strength_mpa','yield_strength_mpa','hardness_hb',
                         'heat_number','batch_number','serial_number','country_of_origin');

-- comparison_rule.method (see api/src/domain/normalize.ts):
--   identifier | code | date | decimal | country  (as before)
--   integer  : whole number; "LINE 4", "#4", "04" all mean 4
--   quantity : "02/02 No's" = piece 2 of a quantity of 2, so the quantity is the SECOND number; "10 EA" = 10
--   name     : company names; case, punctuation and legal suffixes normalised (Private Limited = Pvt Ltd)
--   text     : free text; whitespace/punctuation ignored, MATCH when one is a prefix of the other
--              (labels truncate long descriptions) or similarity >= 0.85
-- comparison_rule.source: attr | identifier:<TYPE> | heats | batches | serials | supplier | product_name
INSERT INTO attribute_definition
  (attribute_key, version, label, scope, data_type, unit, category_code, required, allowed_values, comparison_rule, critical, label_checked, display_order, description)
VALUES
  ('part_number', 1, 'Part number', 'PRODUCT', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier","source":"identifier:COMPANY_PART_NUMBER"}', true, true, 10,
   'Company item number, as on the purchase order ("Item" / "Part No" on labels)'),
  ('supplier_name', 1, 'Supplier', 'PRODUCT', 'TEXT', NULL, NULL, true, NULL,
   '{"method":"name","source":"supplier"}', true, true, 11,
   'Supplier legal name as printed on its shipping label'),
  ('part_description', 1, 'Part description', 'PRODUCT', 'TEXT', NULL, NULL, false, NULL,
   '{"method":"text","source":"product_name"}', false, true, 12, NULL),
  ('design_revision', 1, 'Design revision', 'PRODUCT', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier"}', false, true, 13, 'Drawing / design revision, e.g. "Rev:E"'),
  ('material', 1, 'Material', 'PRODUCT', 'TEXT', NULL, NULL, false, NULL,
   '{"method":"identifier"}', false, true, 14, NULL),
  ('supplier_part_number', 2, 'Supplier part number', 'PRODUCT', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"identifier:SUPPLIER_PART_NUMBER"}', false, false, 15, 'Optional: the supplier''s own number'),

  ('purchase_order_number', 1, 'Purchase order number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier"}', true, true, 20, NULL),
  ('po_line_number', 1, 'PO line number', 'TRACEABILITY', 'INTEGER', NULL, NULL, true, NULL,
   '{"method":"integer"}', true, true, 21, NULL),
  ('quantity', 1, 'Quantity', 'TRACEABILITY', 'INTEGER', 'pcs', NULL, true, NULL,
   '{"method":"quantity"}', true, true, 22, 'Quantity shipped on this PO line. "02/02" on a label = piece 2 of 2'),
  ('heat_number', 2, 'Heat number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier","source":"heats"}', true, true, 23, NULL),
  ('pattern_number', 1, 'Pattern number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier"}', false, true, 24, 'Casting pattern / mould number. Mandatory in the registry; often not printed on shipping labels'),
  ('radiographic_test_number', 1, 'Radiographic test (RT) number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier"}', false, true, 25, 'RT report reference, when radiography was required'),
  ('country_of_origin', 2, 'Country of origin', 'TRACEABILITY', 'COUNTRY', NULL, NULL, false, NULL,
   '{"method":"country","aliases":{"UAE":"AE","UNITED ARAB EMIRATES":"AE","GERMANY":"DE","DEUTSCHLAND":"DE","INDIA":"IN","CHINA":"CN","ITALY":"IT","USA":"US","UNITED STATES":"US","MADE IN UAE":"AE","MADE IN GERMANY":"DE","MADE IN INDIA":"IN","MADE IN CHINA":"CN"}}', false, true, 26, NULL),
  ('batch_number', 2, 'Batch / lot number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"batches"}', false, false, 30, NULL),
  ('serial_number', 2, 'Serial number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"serials"}', false, false, 31, NULL),
  ('manufacturing_date', 2, 'Manufacturing date', 'TRACEABILITY', 'DATE', NULL, NULL, false, NULL,
   '{"method":"date"}', false, false, 32, NULL);

-- One profile for both label types seen at receiving: the supplier's shipping label
-- ("Name of the Supplier", "Part No ... Rev:E", "PO No ... LINE 4", "QTY 02/02 No's", "Heat No")
-- and the company receiving label ("Item", "Purchase Order #", "Line #", "Qty", "Description", barcodes).
--   aliases         : words that introduce the field (matched with 1 OCR error tolerance when >= 4 letters)
--   pattern         : what the value looks like
--   patternFallback : also search the whole text for the pattern when no alias is found
--   fallbackPattern : a different shape to search the whole text for (e.g. "MADE IN ...")
--   barcodePattern  : a bare barcode value of this exact shape is assigned to the field
-- Calibrate thresholds on original-resolution photos (chat-app copies are too compressed).
INSERT INTO label_profile (profile_key, version, name, config) VALUES
('RECEIVING_LABELS', 1, 'Receiving: supplier shipping label + company receiving label', '{
  "language": "eng",
  "dateFormats": ["DD-MMM-YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "YYYY-MM-DD", "DD-MM-YYYY"],
  "defaultConfidenceThreshold": 0.60,
  "fields": {
    "part_number":           {"aliases": ["ITEM", "PART NO", "PART NUMBER", "PART #", "P/N", "ITEM NO"],
                              "pattern": "[0-9]{1,2}[A-Z][0-9A-Z]{6,10}", "patternFallback": true,
                              "barcodePattern": "^[0-9]{1,2}[A-Z][0-9A-Z]{6,10}$", "confidenceThreshold": 0.60},
    "design_revision":       {"aliases": ["REV", "REVISION", "DWG REV"], "pattern": "[A-Z0-9]{1,2}", "patternFallback": false},
    "supplier_name":         {"aliases": ["NAME OF THE SUPPLIER", "SUPPLIER NAME", "SUPPLIER", "VENDOR NAME", "VENDOR", "MANUFACTURER"],
                              "patternFallback": false, "confidenceThreshold": 0.50},
    "part_description":      {"aliases": ["PART DESCRIPTION", "DESCRIPTION", "DESC"], "patternFallback": false, "confidenceThreshold": 0.40},
    "material":              {"aliases": ["MATERIAL", "MOC", "MATERIAL GRADE", "GRADE"], "patternFallback": false},
    "purchase_order_number": {"aliases": ["PURCHASE ORDER #", "PURCHASE ORDER NO", "PURCHASE ORDER", "PO NO", "PO NUMBER", "P.O. NO", "PO #", "PO"],
                              "pattern": "[0-9]{10}", "patternFallback": true, "barcodePattern": "^[0-9]{10}$"},
    "po_line_number":        {"aliases": ["LINE #", "LINE NO", "PO LINE", "LINE"], "pattern": "[0-9]{1,3}", "patternFallback": false},
    "quantity":              {"aliases": ["QTY", "QUANTITY", "QTY."], "pattern": "[0-9]{1,5}( ?/ ?[0-9]{1,5})?", "patternFallback": false},
    "heat_number":           {"aliases": ["HEAT NO", "HEAT NUMBER", "HEAT #", "HT NO", "HEAT", "CAST NO"],
                              "pattern": "[A-Z0-9]{1,8}(-[A-Z0-9]{1,8})?", "patternFallback": false, "confidenceThreshold": 0.50},
    "pattern_number":        {"aliases": ["PATTERN NO", "PATTERN NUMBER", "PATTERN #", "PATT NO", "PTN NO"], "pattern": "[A-Z0-9][A-Z0-9-]{1,20}", "patternFallback": false},
    "radiographic_test_number": {"aliases": ["RT NO", "RT REPORT NO", "RT REPORT", "RT REF", "RADIOGRAPHY NO", "RADIOGRAPHIC TEST"], "pattern": "[A-Z0-9][A-Z0-9/-]{2,20}", "patternFallback": false},
    "country_of_origin":     {"aliases": ["COUNTRY OF ORIGIN", "COO", "ORIGIN"], "fallbackPattern": "MADE IN [A-Z ]+"}
  }
}');

UPDATE label_profile SET status = 'DEPRECATED' WHERE profile_key = 'GENERIC_VALVE_CASTING';

-- Radiographic test reports are their own evidence type.
ALTER TABLE document DROP CONSTRAINT IF EXISTS document_doc_type_check;
ALTER TABLE document ADD CONSTRAINT document_doc_type_check
  CHECK (doc_type IN ('MTC','COC','RT_REPORT','INSPECTION_REPORT','DRAWING','OTHER'));
