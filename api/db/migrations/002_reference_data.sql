-- Reference data: product categories, governed attribute definitions and a starter label profile.
-- Edit via new migrations (or the admin API later); never rename an attribute_key in place (spec 7.6).
SET LOCAL search_path TO spir, public;

INSERT INTO product_category (code, name, description) VALUES
  ('VALVE_BODY_CAST', 'Cast valve body', 'Cast or investment-cast valve bodies (globe, gate, ball, check, butterfly)');

-- comparison_rule.method:
--   identifier : exact after trim + uppercase only (hyphens, slashes, leading zeros stay significant)
--   code       : governed code; observed value mapped through "aliases" first
--   date       : parsed with the label profile's date formats, compared as ISO date
--   decimal    : numeric compare with explicit "tolerance" in "unit"
--   country    : ISO-3166 alpha-2 (aliases map names to codes)
-- comparison_rule.source tells the validator where the approved value lives:
--   attr (default) | identifier:<TYPE> | heats | batches | serials
INSERT INTO attribute_definition
  (attribute_key, version, label, scope, data_type, unit, category_code, required, allowed_values, comparison_rule, critical, label_checked, display_order)
VALUES
  ('supplier_part_number', 1, 'Supplier part number', 'PRODUCT', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier","source":"identifier:SUPPLIER_PART_NUMBER"}', true, true, 10),
  ('manufacturer_part_number', 1, 'Manufacturer part number', 'PRODUCT', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"identifier:MANUFACTURER_PART_NUMBER"}', false, true, 11),
  ('body_material_grade', 1, 'Body material grade', 'PRODUCT', 'CODE', NULL, 'VALVE_BODY_CAST', true,
   '["A216-WCB","A351-CF8M","A352-LCC","A217-WC6","A536-65-45-12"]',
   '{"method":"code","aliases":{"WCB":"A216-WCB","A216 WCB":"A216-WCB","A216WCB":"A216-WCB","ASTM A216 WCB":"A216-WCB","A216 GR WCB":"A216-WCB","ASTM A216 GR WCB":"A216-WCB",
      "CF8M":"A351-CF8M","A351 CF8M":"A351-CF8M","ASTM A351 CF8M":"A351-CF8M","A351 GR CF8M":"A351-CF8M",
      "LCC":"A352-LCC","A352 LCC":"A352-LCC","ASTM A352 LCC":"A352-LCC",
      "WC6":"A217-WC6","A217 WC6":"A217-WC6","ASTM A217 WC6":"A217-WC6",
      "65-45-12":"A536-65-45-12","A536 65-45-12":"A536-65-45-12","ASTM A536 65-45-12":"A536-65-45-12"}}', true, true, 20),
  ('pressure_class', 1, 'Pressure class', 'PRODUCT', 'CODE', NULL, 'VALVE_BODY_CAST', true,
   '["CL150","CL300","CL600","CL800","CL900","CL1500","CL2500"]',
   '{"method":"code","aliases":{"150":"CL150","300":"CL300","600":"CL600","800":"CL800","900":"CL900","1500":"CL1500","2500":"CL2500",
      "CLASS 150":"CL150","CLASS 300":"CL300","CLASS 600":"CL600","CLASS 800":"CL800","CL 150":"CL150","CL 300":"CL300","CL 600":"CL600","CL 800":"CL800",
      "150#":"CL150","300#":"CL300","600#":"CL600","800#":"CL800","150LB":"CL150","300LB":"CL300","600LB":"CL600","800LB":"CL800"}}', true, true, 21),
  ('nominal_size', 1, 'Nominal size', 'PRODUCT', 'CODE', NULL, 'VALVE_BODY_CAST', true, NULL,
   '{"method":"code","aliases":{"1\"":"1IN","2\"":"2IN","3\"":"3IN","4\"":"4IN","6\"":"6IN","8\"":"8IN","1 IN":"1IN","2 IN":"2IN","3 IN":"3IN","4 IN":"4IN","6 IN":"6IN","8 IN":"8IN",
      "NPS 1":"1IN","NPS 2":"2IN","NPS 3":"3IN","NPS 4":"4IN","NPS 6":"6IN","NPS 8":"8IN","DN25":"1IN","DN50":"2IN","DN80":"3IN","DN100":"4IN","DN150":"6IN","DN200":"8IN"}}', true, true, 22),
  ('end_connection', 1, 'End connection', 'PRODUCT', 'CODE', NULL, 'VALVE_BODY_CAST', false,
   '["RF","RTJ","BW","SW","NPT","WAFER"]', '{"method":"code","aliases":{"RAISED FACE":"RF","BUTT WELD":"BW","SOCKET WELD":"SW"}}', false, false, 23),
  ('design_standard', 1, 'Design standard', 'PRODUCT', 'TEXT', NULL, 'VALVE_BODY_CAST', false, NULL,
   '{"method":"identifier"}', false, false, 24),

  ('heat_number', 1, 'Heat number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, true, NULL,
   '{"method":"identifier","source":"heats"}', true, true, 30),
  ('batch_number', 1, 'Batch / lot number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"batches"}', true, true, 31),
  ('serial_number', 1, 'Serial number', 'TRACEABILITY', 'IDENTIFIER', NULL, NULL, false, NULL,
   '{"method":"identifier","source":"serials"}', true, true, 32),
  ('casting_foundry', 1, 'Casting foundry', 'TRACEABILITY', 'TEXT', NULL, NULL, false, NULL,
   '{"method":"identifier"}', false, false, 40),
  ('pour_date', 1, 'Pour date', 'TRACEABILITY', 'DATE', NULL, NULL, false, NULL,
   '{"method":"date"}', false, false, 41),
  ('manufacturing_date', 1, 'Manufacturing date', 'TRACEABILITY', 'DATE', NULL, NULL, true, NULL,
   '{"method":"date"}', false, true, 42),
  ('country_of_origin', 1, 'Country of origin', 'TRACEABILITY', 'COUNTRY', NULL, NULL, false, NULL,
   '{"method":"country","aliases":{"UAE":"AE","UNITED ARAB EMIRATES":"AE","GERMANY":"DE","DEUTSCHLAND":"DE","INDIA":"IN","MADE IN UAE":"AE","MADE IN GERMANY":"DE","MADE IN INDIA":"IN"}}', false, true, 43),
  ('tensile_strength_mpa', 1, 'Tensile strength', 'TRACEABILITY', 'DECIMAL', 'MPa', NULL, false, NULL,
   '{"method":"decimal","tolerance":0,"unit":"MPa"}', false, false, 50),
  ('yield_strength_mpa', 1, 'Yield strength', 'TRACEABILITY', 'DECIMAL', 'MPa', NULL, false, NULL,
   '{"method":"decimal","tolerance":0,"unit":"MPa"}', false, false, 51),
  ('hardness_hb', 1, 'Hardness', 'TRACEABILITY', 'DECIMAL', 'HB', NULL, false, NULL,
   '{"method":"decimal","tolerance":0,"unit":"HB"}', false, false, 52);

-- Starter generic label profile. Tune aliases/patterns once real sticker photos are available.
-- For each field the extractor looks for "<alias><separator><value>" on a line, then falls back to
-- the value "pattern" anywhere in the text (only if "patternFallback" is true).
INSERT INTO label_profile (profile_key, version, name, config) VALUES
('GENERIC_VALVE_CASTING', 1, 'Generic valve casting sticker / tag', '{
  "language": "eng",
  "dateFormats": ["YYYY-MM-DD", "DD/MM/YYYY", "DD.MM.YYYY", "DD-MM-YYYY", "YYYY/MM/DD"],
  "defaultConfidenceThreshold": 0.80,
  "fields": {
    "supplier_part_number":     {"aliases": ["SUPPLIER PART NO", "PART NO", "PART NUMBER", "P/N", "PN", "ITEM NO", "ART NO", "ARTIKEL"], "pattern": "[A-Z]{2,4}-[A-Z]{2}-[0-9]{3,4}-[0-9]{3}", "patternFallback": true},
    "manufacturer_part_number": {"aliases": ["MFR PART NO", "MFG P/N", "MFR P/N", "MPN", "MODEL"], "pattern": "[A-Z]{2,3}-[A-Z0-9]{2,4}-[0-9]{3,4}", "patternFallback": false},
    "heat_number":              {"aliases": ["HEAT NO", "HEAT NUMBER", "HEAT", "HT NO", "H/N", "CAST NO", "SCHMELZE", "MELT NO"], "pattern": "[A-Z]{1,3}-?[0-9A-Z]{4,6}", "patternFallback": false, "confidenceThreshold": 0.85},
    "batch_number":             {"aliases": ["BATCH NO", "BATCH", "LOT NO", "LOT", "CHARGE"], "pattern": "[A-Z]{1,2}-[0-9]{2,4}-?[0-9]{3,4}", "patternFallback": false},
    "serial_number":            {"aliases": ["SERIAL NO", "SERIAL", "S/N", "SN NO"], "pattern": "[A-Z]{2}-[0-9]{4,5}", "patternFallback": false, "confidenceThreshold": 0.85},
    "body_material_grade":      {"aliases": ["MATERIAL", "BODY MATERIAL", "MAT", "GRADE", "WERKSTOFF"], "pattern": "(ASTM )?A[0-9]{3}( GR)? ?[A-Z0-9-]{2,9}", "patternFallback": false},
    "pressure_class":           {"aliases": ["CLASS", "PRESSURE CLASS", "RATING", "CL"], "pattern": "(CL ?)?[0-9]{3,4}(#|LB)?", "patternFallback": false},
    "nominal_size":             {"aliases": ["SIZE", "NPS", "NOMINAL SIZE", "DN"], "pattern": "[0-9]{1,2} ?(IN|\")|DN[0-9]{2,3}", "patternFallback": false},
    "manufacturing_date":       {"aliases": ["MFG DATE", "MFD", "DATE OF MFG", "MANUFACTURING DATE", "DATE", "HERSTELLDATUM"], "pattern": "[0-9]{2,4}[-/.][0-9]{2}[-/.][0-9]{2,4}", "patternFallback": true},
    "country_of_origin":        {"aliases": ["COUNTRY OF ORIGIN", "ORIGIN", "COO"], "pattern": "MADE IN [A-Z ]+", "patternFallback": true}
  }
}');
