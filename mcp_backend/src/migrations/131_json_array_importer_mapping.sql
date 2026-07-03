-- Migration 131: wire json_array importer to actual upserts
--
-- Background: runJsonArrayImport previously just downloaded JSON and
-- reported "completed" without writing to target_table. We now store a
-- column-level mapping (+ unique_key) inside source_config so the
-- importer can upsert generically. Tables get unique indexes on the
-- natural keys declared in unique_key.
--
-- Scope: the three daily sources that were demonstrably stale —
--   mvs_missing_persons, mvs_wanted_vehicles, nazk_corruption.

-- ── Unique indexes backing ON CONFLICT ──────────────────────────────────
-- Tables opendata_* were created outside migrations (manual/prod-only), so each
-- index is guarded — on a fresh database the statement is skipped.
DO $$ BEGIN
  IF to_regclass('opendata_missing_persons') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS opendata_missing_persons_source_id_uniq
      ON opendata_missing_persons(source_id);
  END IF;
  IF to_regclass('opendata_wanted_vehicles') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS opendata_wanted_vehicles_natural_uniq
      ON opendata_wanted_vehicles(vehicle_number, body_number);
  END IF;
  IF to_regclass('opendata_corruption') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS opendata_corruption_record_id_uniq
      ON opendata_corruption(record_id);
  END IF;
END $$;

-- ── mvs_missing_persons ────────────────────────────────────────────────
UPDATE import_source_catalog
SET source_config = jsonb_build_object(
      'format',     'json',
      'unique_key', jsonb_build_array('source_id'),
      'mapping', jsonb_build_object(
        'source_id',     'ID',
        'ovd',           'OVD',
        'category',      'CATEGORY',
        'first_name_u',  'FIRST_NAME_U',
        'last_name_u',   'LAST_NAME_U',
        'middle_name_u', 'MIDDLE_NAME_U',
        'first_name_r',  'FIRST_NAME_R',
        'last_name_r',   'LAST_NAME_R',
        'middle_name_r', 'MIDDLE_NAME_R',
        'first_name_e',  'FIRST_NAME_E',
        'last_name_e',   'LAST_NAME_E',
        'middle_name_e', 'MIDDLE_NAME_E',
        'birth_date',    'BIRTH_DATE',
        'sex',           'SEX',
        'lost_date',     'LOST_DATE',
        'lost_place',    'LOST_PLACE',
        'article_crim',  'ARTICLE_CRIM',
        'restraint',     'RESTRAINT',
        'contact',       'CONTACT',
        'photo_id',      'PHOTO_ID'
      )
    )
WHERE name = 'mvs_missing_persons';

-- ── mvs_wanted_vehicles ────────────────────────────────────────────────
UPDATE import_source_catalog
SET source_config = jsonb_build_object(
      'format',     'json',
      'unique_key', jsonb_build_array('vehicle_number', 'body_number'),
      'mapping', jsonb_build_object(
        'brand_model',          'brandmodel',
        'car_type',             'cartype',
        'color',                'color',
        'vehicle_number',       'vehiclenumber',
        'body_number',          'bodynumber',
        'chassis_number',       'chassisnumber',
        'engine_number',        'enginenumber',
        'illegal_seizure_date', 'illegalseizuredate',
        'organ_unit',           'organunit',
        'insert_date',          'insertdate'
      )
    )
WHERE name = 'mvs_wanted_vehicles';

-- ── nazk_corruption ────────────────────────────────────────────────────
-- Fix the target (was opendata_corruption_register, which doesn't exist)
-- and switch to the live NAZK API (the 2023 snapshot URL was stale).
UPDATE import_source_catalog
SET source_url   = 'https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData',
    target_table = 'opendata_corruption',
    source_config = jsonb_build_object(
      'format',     'json',
      'unique_key', jsonb_build_array('record_id'),
      'mapping', jsonb_build_object(
        'record_id',         'id',
        'punishment_type',   'punishmentType.name',
        'entity_type',       'entityType.name',
        'last_name',         'indLastNameOnOffenseMoment',
        'first_name',        'indFirstNameOnOffenseMoment',
        'patronymic',        'indPatronymicOnOffenseMoment',
        'offense_name',      'offenseName',
        'punishment',        'punishment',
        'court_case_number', 'courtCaseNumber',
        'sentence_date',     'sentenceDate',
        'court_name',        'courtName',
        'codex_articles',    'codexArticles'
      )
    )
WHERE name = 'nazk_corruption';
