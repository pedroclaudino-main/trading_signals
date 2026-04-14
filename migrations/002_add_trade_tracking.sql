-- Add trade outcome tracking columns to signals table
-- Run this in your Supabase SQL Editor after 001_create_signals_table.sql

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS close_price DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS close_ts    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pnl_pts     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS closed_by   TEXT;  -- 'tp', 'sl', 'manual', 'timeout'

-- Mark all existing signals (pre-tracking) as closed with unknown outcome
UPDATE signals SET status = 'closed', closed_by = 'unknown' WHERE signal != 'NO_TRADE' AND status = 'open';
UPDATE signals SET status = 'skipped' WHERE signal = 'NO_TRADE';

-- Index for querying open trades
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals (status) WHERE status = 'open';

-- Index for stats queries on closed trades
CREATE INDEX IF NOT EXISTS idx_signals_closed ON signals (status, signal) WHERE status = 'closed';
