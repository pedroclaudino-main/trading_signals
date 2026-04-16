-- Add instrument column for multi-instrument support (Phase 3)
-- Run this in your Supabase SQL Editor after 002_add_trade_tracking.sql

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS instrument TEXT DEFAULT 'MNQ';

-- Backfill existing signals (all pre-Phase 3 signals were MNQ)
UPDATE signals SET instrument = 'MNQ' WHERE instrument IS NULL;

-- Index for instrument-filtered queries
CREATE INDEX IF NOT EXISTS idx_signals_instrument ON signals (instrument);
