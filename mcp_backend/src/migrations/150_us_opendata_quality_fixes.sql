-- US Open Data quality fixes: indexes, normalization, new columns, enrichment tracking

-- ── Tables first (needed on local/fresh installs) ──────────────────

-- OSHA enforcement table
CREATE TABLE IF NOT EXISTS us_osha_enforcement (
    employer_id TEXT PRIMARY KEY,
    employer_name TEXT,
    city TEXT, state TEXT, zip5 TEXT,
    naics_code TEXT, naics_description TEXT, parent_name TEXT,
    citation_count INTEGER, inspection_count INTEGER,
    penalties_initial_total NUMERIC, penalties_current_total NUMERIC,
    willful_count INTEGER, repeat_count INTEGER, serious_count INTEGER,
    other_count INTEGER, severe_count INTEGER,
    earliest_citation DATE, latest_citation DATE,
    max_gravity INTEGER,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_osha_enf_name_fts ON us_osha_enforcement USING gin(to_tsvector('simple', employer_name));
CREATE INDEX IF NOT EXISTS idx_us_osha_enf_state ON us_osha_enforcement(state);
CREATE INDEX IF NOT EXISTS idx_us_osha_enf_naics ON us_osha_enforcement(naics_code);
CREATE INDEX IF NOT EXISTS idx_us_osha_enf_penalties ON us_osha_enforcement(penalties_current_total);

-- SEC filers table
CREATE TABLE IF NOT EXISTS us_sec_filers (
    cik TEXT PRIMARY KEY,
    entity_name TEXT, entity_type TEXT, sic TEXT, sic_description TEXT,
    ticker TEXT, exchanges TEXT, ein TEXT, state_of_incorporation TEXT,
    fiscal_year_end TEXT, filing_count INTEGER, category TEXT,
    phone TEXT, state TEXT, city TEXT, zip TEXT,
    insider_transaction_count INTEGER,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_sec_name_fts ON us_sec_filers USING gin(to_tsvector('simple', entity_name));
CREATE INDEX IF NOT EXISTS idx_us_sec_ticker ON us_sec_filers(ticker);
CREATE INDEX IF NOT EXISTS idx_us_sec_sic ON us_sec_filers(sic);
CREATE INDEX IF NOT EXISTS idx_us_sec_ein ON us_sec_filers(ein) WHERE ein IS NOT NULL;

-- Court opinions table
CREATE TABLE IF NOT EXISTS us_court_opinions (
    id TEXT PRIMARY KEY,
    source TEXT,
    created_at TIMESTAMPTZ,
    url TEXT,
    author TEXT,
    text_preview TEXT,
    full_text TEXT,
    text_length INTEGER,
    reporter_series TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_court_opinions_fts ON us_court_opinions USING gin(to_tsvector('english', text_preview));
CREATE INDEX IF NOT EXISTS idx_us_court_opinions_length ON us_court_opinions(text_length);
CREATE INDEX IF NOT EXISTS idx_us_court_opinions_reporter ON us_court_opinions(reporter_series);

-- ── Fixes (run after tables exist) ─────────────────────────────────
-- Tables opensanctions_entities / us_cfpb_complaints / us_fec_candidates were
-- created outside migrations (importer-managed), so each fix is guarded with
-- to_regclass() — on a fresh database the block is skipped.

-- 1. OpenSanctions: FTS index on name
DO $$ BEGIN
  IF to_regclass('opensanctions_entities') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_opensanctions_name_fts ON opensanctions_entities USING gin(to_tsvector('simple', name));
  END IF;
END $$;

-- 2. Court opinions: reporter_series column + populate
ALTER TABLE us_court_opinions ADD COLUMN IF NOT EXISTS reporter_series TEXT;
DROP INDEX IF EXISTS idx_us_court_opinions_created;
UPDATE us_court_opinions SET reporter_series = split_part(id, '/', 1) WHERE reporter_series IS NULL;

-- 3. CFPB: normalized product taxonomy
DO $$ BEGIN
  IF to_regclass('us_cfpb_complaints') IS NOT NULL THEN
    ALTER TABLE us_cfpb_complaints ADD COLUMN IF NOT EXISTS product_normalized TEXT;
    UPDATE us_cfpb_complaints SET product_normalized = CASE
        WHEN product IN ('Credit reporting, credit repair services, or other personal consumer reports',
                         'Credit reporting or other personal consumer reports')
            THEN 'Credit reporting'
        WHEN product IN ('Credit card or prepaid card', 'Credit card', 'Prepaid card')
            THEN 'Credit card / prepaid'
        WHEN product IN ('Payday loan, title loan, personal loan, or advance',
                         'Payday loan, title loan, or personal loan', 'Payday loan')
            THEN 'Payday / personal loan'
        WHEN product IN ('Money transfer, virtual currency, or money service',
                         'Money transfers', 'Virtual currency')
            THEN 'Money transfer / crypto'
        WHEN product IN ('Checking or savings account', 'Bank account or service')
            THEN 'Bank account'
        ELSE product
    END
    WHERE product_normalized IS NULL;
    CREATE INDEX IF NOT EXISTS idx_us_cfpb_product_norm ON us_cfpb_complaints(product_normalized);
  END IF;
END $$;

-- 4. FEC candidates: fix garbled election years
DO $$ BEGIN
  IF to_regclass('us_fec_candidates') IS NOT NULL THEN
    UPDATE us_fec_candidates SET election_year = NULL WHERE election_year > 2030;
  END IF;
END $$;

-- 5. OFAC standalone: deprecate in catalog
UPDATE import_source_catalog SET enabled = false WHERE name = 'us_ofac_sdn';
