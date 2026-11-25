-- Label profile GENERIC_VALVE_CASTING v2 - first calibration against real Tesseract.js output.
--
-- Evidence: 5 synthetic sticker photos in seed/labels/ run through Tesseract.js 7 (eng, best_int).
--  * Tesseract consistently reads the printed "S/N" as "SIN" (and sometimes "5/N"): added as aliases.
--  * Tesseract's word confidence is poorly calibrated for hyphenated codes: correctly read heat
--    numbers scored 41-74%, short tokens such as "2" in "2 IN" scored 43%. v1 thresholds (80-85%)
--    flagged almost every correct read. v2 lowers them. This never turns an unequal value into a
--    MATCH (FR-OCR-017) - it only decides whether a read is trusted enough to decide the result.
--  * None of the sticker types carry the manufacturer part number, so v2 stops looking for it
--    (it is reported as NOT_CHECKED instead of MISSING_ON_LABEL).
-- RECALIBRATE on real supplier photos before relying on these values (spec 11A.17 g, k).
-- v1 is kept (DEPRECATED) so earlier validation runs stay interpretable (spec 7.6, FR-OCR-016).
SET LOCAL search_path TO spir, public;

INSERT INTO label_profile (profile_key, version, name, config)
SELECT profile_key, 2, name,
       jsonb_set(
         jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(config #- '{fields,manufacturer_part_number}',
                 '{fields,serial_number}', (config->'fields'->'serial_number')
                    || '{"aliases": ["SERIAL NO", "SERIAL", "S/N", "SIN", "5/N", "S/NO", "SN NO"], "confidenceThreshold": 0.65}'::jsonb),
               '{fields,heat_number,confidenceThreshold}', '0.55'::jsonb),
             '{fields,nominal_size}', (config->'fields'->'nominal_size') || '{"confidenceThreshold": 0.40}'::jsonb),
           '{fields,supplier_part_number}', (config->'fields'->'supplier_part_number') || '{"confidenceThreshold": 0.65}'::jsonb),
         '{defaultConfidenceThreshold}', '0.65'::jsonb)
  FROM label_profile WHERE profile_key = 'GENERIC_VALVE_CASTING' AND version = 1;

UPDATE label_profile SET status = 'DEPRECATED' WHERE profile_key = 'GENERIC_VALVE_CASTING' AND version = 1;
