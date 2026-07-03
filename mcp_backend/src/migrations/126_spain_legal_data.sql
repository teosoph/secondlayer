-- Migration 126: Spanish legal open data — align existing tables + add missing columns/indexes
-- Tables were created manually on prod (no CREATE migration exists), so every section is
-- guarded with to_regclass(): on a fresh database (local/dev) the tables are absent and the
-- section is skipped — otherwise this migration aborts the whole migration run.

-- ═══════════════════════════════════════════════════════════════
-- 1. BOE — add missing columns (full_text_xml, analysis_json, url_html_consolidada)
-- Existing schema uses: id (serial), boe_id, title, metadata (jsonb)
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_boe_legislation') IS NOT NULL THEN
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS full_text_xml TEXT;
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS analysis_json JSONB;
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS url_html_consolidada TEXT;
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS diario TEXT;
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS diario_numero TEXT;
    ALTER TABLE spain_boe_legislation ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_spain_boe_rango ON spain_boe_legislation(rango);
    CREATE INDEX IF NOT EXISTS idx_spain_boe_fecha_pub ON spain_boe_legislation(fecha_publicacion);
    CREATE INDEX IF NOT EXISTS idx_spain_boe_estado ON spain_boe_legislation(estado_consolidacion);
    CREATE INDEX IF NOT EXISTS idx_spain_boe_ambito ON spain_boe_legislation(ambito);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spain_boe_boe_id ON spain_boe_legislation(boe_id);

    CREATE INDEX IF NOT EXISTS idx_spain_boe_fts ON spain_boe_legislation
        USING gin(to_tsvector('spanish', COALESCE(title, '') || ' ' || COALESCE(full_text, '')));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 2. EUR-Lex — already matches, ensure indexes
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_eurlex_legislation') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_eurlex_type ON spain_eurlex_legislation(doc_type);
    CREATE INDEX IF NOT EXISTS idx_spain_eurlex_date ON spain_eurlex_legislation(doc_date);
    CREATE INDEX IF NOT EXISTS idx_spain_eurlex_force ON spain_eurlex_legislation(in_force);

    CREATE INDEX IF NOT EXISTS idx_spain_eurlex_fts ON spain_eurlex_legislation
        USING gin(to_tsvector('spanish', COALESCE(title, '') || ' ' || COALESCE(full_text, '')));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. Tribunal Constitucional — actual columns are tipo/fecha (not tipo_resolucion/fecha_registro)
-- Indexes idx_tc_tipo and idx_tc_fecha already exist; create idempotent aliases.
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_tribunal_constitucional') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_tc_tipo ON spain_tribunal_constitucional(tipo);
    CREATE INDEX IF NOT EXISTS idx_spain_tc_fecha ON spain_tribunal_constitucional(fecha);

    CREATE INDEX IF NOT EXISTS idx_spain_tc_fts ON spain_tribunal_constitucional
        USING gin(to_tsvector('spanish', COALESCE(full_text, '')));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 4. BORME Section C — already matches, ensure indexes
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_borme_section_c') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_borme_fecha ON spain_borme_section_c(fecha_publicacion);
    CREATE INDEX IF NOT EXISTS idx_spain_borme_tipo ON spain_borme_section_c(tipo_anuncio);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 5. Consejo de Estado — already matches, ensure indexes
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_consejo_estado') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_ce_fecha ON spain_consejo_estado(fecha_aprobacion);
    CREATE INDEX IF NOT EXISTS idx_spain_ce_procedencia ON spain_consejo_estado(procedencia);

    CREATE INDEX IF NOT EXISTS idx_spain_ce_fts ON spain_consejo_estado
        USING gin(to_tsvector('spanish', COALESCE(full_text, '')));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 6. AEAT — already matches, ensure indexes
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_aeat_consultas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_aeat_fecha ON spain_aeat_consultas(fecha);
    CREATE INDEX IF NOT EXISTS idx_spain_aeat_impuesto ON spain_aeat_consultas(impuesto);

    CREATE INDEX IF NOT EXISTS idx_spain_aeat_fts ON spain_aeat_consultas
        USING gin(to_tsvector('spanish', COALESCE(cuestion, '') || ' ' || COALESCE(contestacion, '')));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 7. Fiscalía — already matches, ensure indexes
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF to_regclass('spain_fiscalia') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_spain_fiscalia_tipo ON spain_fiscalia(tipo);
    CREATE INDEX IF NOT EXISTS idx_spain_fiscalia_fecha ON spain_fiscalia(fecha);

    CREATE INDEX IF NOT EXISTS idx_spain_fiscalia_fts ON spain_fiscalia
        USING gin(to_tsvector('spanish', COALESCE(titulo, '') || ' ' || COALESCE(full_text, '')));
  END IF;
END $$;
