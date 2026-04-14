-- Create the signals table for persistent trade journal
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS signals (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session     TEXT,
  price       DOUBLE PRECISION,
  signal      TEXT NOT NULL,
  entry       DOUBLE PRECISION,
  sl          DOUBLE PRECISION,
  tp          DOUBLE PRECISION,
  risk_pts    DOUBLE PRECISION,
  confidence  TEXT,
  reason      TEXT,
  mtf         JSONB,
  telegram_ok BOOLEAN
);

-- Index for querying recent signals by time
CREATE INDEX idx_signals_ts ON signals (ts DESC);

-- Index for filtering by session
CREATE INDEX idx_signals_session ON signals (session);

-- Row Level Security: allow service key full access
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service key full access" ON signals
  FOR ALL
  USING (true)
  WITH CHECK (true);
