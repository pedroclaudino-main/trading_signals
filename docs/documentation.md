# MasterSignal v5 — System Documentation

## 1. Overview

MasterSignal is an automated forex/futures signal ecosystem that generates, validates, and delivers high-probability trading signals via Telegram. It targets sustainable 1% weekly returns while strictly adhering to prop firm (Apex Trader Funding) risk parameters.

The system combines TradingView Pine Script indicators with a Node.js webhook server that uses Claude AI for contextual signal analysis, dynamic position sizing, and multi-instrument risk management.

**Current version:** 5.0.0
**Primary instruments:** CME Micro E-mini Nasdaq 100 (MNQ), Micro E-mini S&P 500 (MES), E-mini Nasdaq 100 (NQ), E-mini S&P 500 (ES)

---

## 2. System Architecture

```
TradingView (Pine Script v4)
        │
        │  Webhook (JSON payload)
        ▼
  ┌─────────────────────────────────────────────┐
  │           Node.js Webhook Server             │
  │              (Railway.app)                   │
  │                                              │
  │  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
  │  │ Webhook  │→ │ Validate │→ │ News      │  │
  │  │ Receiver │  │ & Dedup  │  │ Filter    │  │
  │  └──────────┘  └──────────┘  └─────┬─────┘  │
  │                                    │         │
  │  ┌──────────┐  ┌──────────┐  ┌─────▼─────┐  │
  │  │ Position │← │ Signal   │← │ Claude AI │  │
  │  │ Sizing   │  │ Validate │  │ Analysis  │  │
  │  └────┬─────┘  └──────────┘  └───────────┘  │
  │       │                                      │
  │  ┌────▼─────┐  ┌──────────┐  ┌───────────┐  │
  │  │ Apex     │→ │ Telegram │→ │ Supabase  │  │
  │  │ Risk     │  │ Delivery │  │ Journal   │  │
  │  │ Guard    │  │          │  │           │  │
  │  └──────────┘  └──────────┘  └───────────┘  │
  └─────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
   Telegram Bot                  PostgreSQL DB
   (iPhone alerts)              (Supabase signals table)
```

### Data Flow (End-to-End)

1. **Pine Script** on TradingView detects momentum pullback setups on 1-minute charts and fires a webhook with candle data, order blocks, FVGs, swing points, and multi-timeframe trend state.
2. **Webhook Server** receives the payload, authenticates via secret, deduplicates, and rate-limits.
3. **News Event Filter** checks for high-impact economic events (FOMC, NFP, CPI) and blocks signals within a configurable window.
4. **Claude AI** performs contextual analysis — evaluating candle quality, momentum alignment, and setup coherence — returning a signal decision with confidence level.
5. **Signal Validation** enforces structural rules: SL/TP direction, R:R range, risk limits, entry proximity.
6. **Apex Risk Guard** checks per-instrument daily signal counts and loss exposure against prop firm limits.
7. **Position Sizing Engine** calculates contract count based on account balance, risk percentage, confidence, and Apex compliance scaling.
8. **Telegram Delivery** sends formatted alerts to configured chat IDs with entry, SL, TP, contract count, and reasoning.
9. **Journal** persists the signal to Supabase PostgreSQL (with JSONL fallback) for analytics and weekly reporting.

---

## 3. Core Components

### 3.1 Pine Script Indicator (`master_signal.pine`)

**Strategy:** Momentum pullback reversal with SMA trend alignment.

- **Momentum detection:** blackcat1402 weighted price oscillator identifies overbought/oversold conditions
- **Trend confirmation:** SMA3 > SMA10 > SMA20 alignment for bullish (inverse for bearish)
- **Entry trigger:** Directional confirmation candle after pullback reversal
- **Multi-timeframe validation:** 1D trend alignment required before signal emission
- **Swing points:** Used for stop-loss placement at recent swing high/low
- **Session windows:** Limits signals to configured trading sessions (default: NY open hours)
- **Max signals per session:** Configurable limit to prevent overtrading

The Pine Script sends a JSON webhook payload containing:
- `candles_1m` — last 3 one-minute OHLCV candles
- `broken_ob` — ICT Order Block data (type, high, low)
- `fvgs` — Fair Value Gaps detected
- `swings` — recent swing highs/lows
- `mtf` — multi-timeframe trend state (`{1d, 4h, 1h, 15m, 5m}`)
- `suggested_entry`, `suggested_sl`, `tp`, `risk_pts` — proposed trade levels
- `momentum`, `institutional_bias` — indicator state
- `session`, `current_price`, `instrument`

### 3.2 Backtest Script (`master_signal_backtest.pine`)

Mirror of the live indicator with backtesting additions:
- `process_orders_on_close=false` for realistic fill simulation
- Accurate win/loss counting from closed trades
- Max daily trade limit enforcement
- Performance statistics table (win rate, profit factor, total P&L)

### 3.3 Webhook Server (`server.js`)

Express.js server (single-file) that processes TradingView webhooks and orchestrates the full signal pipeline.

**Key middleware:**
- Security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- CORS restricted to TradingView origins
- JSON body parser with 10KB limit
- Trust proxy (Railway/Render)

**Authentication:**
- Webhook secret compared via `crypto.timingSafeEqual` to prevent timing attacks
- Secret accepted from `x-webhook-secret` header or `webhook_secret` body field

**Deduplication:**
- Hash-based dedup (session + price + entry + SL) with 5-minute TTL
- Prevents duplicate signals from TradingView alert re-fires

**Rate Limiting:**
- 10 requests per IP per 60-second window
- In-memory store with max 10,000 keys (DoS protection)

### 3.4 Claude AI Analysis

Uses Anthropic SDK (`@anthropic-ai/sdk`) with `claude-sonnet` model.

**Role:** Contextual analysis layer — the Pine Script handles mechanical rule validation; Claude evaluates setup quality and coherence.

**Evaluation criteria:**
1. **Coherence** — do entry/SL/TP make sense vs. current price? Is risk reasonable for scalping?
2. **Candle quality** — real momentum vs. doji/hesitation candles? Volume support?
3. **Momentum & bias alignment** — momentum oscillator + SMA alignment + OB bias agreement determines confidence (HIGH/MEDIUM/LOW/NO_TRADE)
4. **Rejection conditions** — entry > 15pts from price, risk > 50pts, indecision candles, extreme momentum against direction

**Output:** Structured JSON with signal direction, entry/SL/TP levels, confidence, R:R, and reasoning.

**Retry policy:** 2 retries with exponential backoff (1s, 2s, 4s).

### 3.5 News Event Filter

Automatically suppresses signals near high-impact economic events to avoid slippage and risk spikes.

**Data source:** Forex Factory economic calendar via `nfs.faireconomy.media` JSON feed.
**Fallback:** Static heuristic for known recurring events (NFP first Friday, CPI mid-month, FOMC 3rd week).

**Configuration:**
| Variable | Default | Description |
|---|---|---|
| `NEWS_FILTER_ENABLED` | `true` | Enable/disable the filter |
| `NEWS_SUPPRESS_WINDOW_MIN` | `15` | Minutes before/after event to suppress |
| `NEWS_SUPPRESS_MODE` | `block` | `block` (reject) or `warn` (flag but continue) |

**Behavior:**
- Cache refreshes daily (with 5-minute interval checks)
- Pre-warms cache on server startup
- Suppressed signals logged with reason `news_event_suppressed`
- Telegram alert sent when a signal is blocked by the filter

### 3.6 Apex Risk Guard

Per-instrument daily risk management enforcing prop firm (Apex Trader Funding) compliance.

**Tracked state (resets at midnight ET):**
- `signalCount` — number of signals sent today per instrument
- `totalRiskPts` — cumulative risk points exposed today per instrument
- `halted` — whether the instrument is halted for the day

**Configuration:**
| Variable | Default | Description |
|---|---|---|
| `APEX_MAX_DAILY_SIGNALS` | `10` | Max signals per day (per instrument) |
| `APEX_DAILY_LOSS_LIMIT` | `150` | Max cumulative risk points per day |

**Rules:**
- Blocks new signals when daily count or risk exposure limit is reached
- Full-size instruments (NQ, ES) get half the daily signal limit
- Sends a Telegram alert when daily limits are hit

### 3.7 Position Sizing Engine

Dynamic contract calculation based on account balance and trade risk.

**Formula:**
1. Base contracts = `(balance x risk%) / (risk_pts x pointValue)`
2. Confidence adjustment: HIGH = 100%, MEDIUM = 75%, LOW = 50%
3. Apex scaling: linear scale-down when daily risk exceeds threshold (100% at threshold, 25% at limit)
4. Floor: minimum 1 contract always

**Configuration:**
| Variable | Default | Description |
|---|---|---|
| `ACCOUNT_BALANCE` | `0` (fixed 1 contract) | Funded account balance in USD |
| `RISK_PER_TRADE_PCT` | `0.5` | Max risk per trade as % of balance |
| `APEX_SCALE_THRESHOLD` | `70` | % of daily loss limit to start scaling down |

### 3.8 Multi-Instrument Support

Supports four CME futures instruments, each with independent risk parameters:

| Instrument | Name | Tick Size | Point Value | Max Risk (pts) | Default R:R |
|---|---|---|---|---|---|
| MNQ | Micro E-mini Nasdaq 100 | 0.25 | $0.50 | 60 | 1.5 - 3.0 |
| MES | Micro E-mini S&P 500 | 0.25 | $1.25 | 20 | 1.5 - 3.0 |
| NQ | E-mini Nasdaq 100 | 0.25 | $5.00 | 60 | 1.5 - 3.0 |
| ES | E-mini S&P 500 | 0.25 | $12.50 | 20 | 1.5 - 3.0 |

Each instrument maintains independent daily risk state (signal counts, loss exposure, halt status). Instrument configs can be overridden via the `INSTRUMENT_CONFIG` env var (JSON).

### 3.9 Trade Outcome Tracker

Enables tracking open positions and closing them with actual exit prices for P&L calculation.

**Workflow:**
1. When a LONG/SHORT signal is persisted, it gets `status: 'open'` in the database
2. Close a trade via `POST /close-trade` with `{signal_id, close_price, closed_by}`
3. P&L is calculated automatically based on direction and close price
4. `closed_by` values: `tp` (take profit), `sl` (stop loss), `manual`, `timeout`

### 3.10 Weekly Performance Reports

Automated P&L reports delivered via Telegram, analyzing closed trades over a week period.

**Report includes:**
- Trade count, win rate, total P&L (points)
- Profit factor
- Session breakdown (which sessions perform best)
- Best and worst trades
- Comparison against 1% weekly return target

### 3.11 Adaptive Strategy Analytics

Statistical analysis of historical trade data to identify optimal parameters.

**Endpoints:**
- `/stats/sessions` — per-session win rate, P&L, and trade count
- `/stats/parameters` — R:R distribution, risk sizing, confidence breakdown, direction analysis
- `/tune` — automated recommendations for session filters, confidence thresholds, and risk limits (requires 20+ closed trades)

---

## 4. Technologies

| Component | Technology | Purpose |
|---|---|---|
| Signal indicator | TradingView Pine Script v6 | On-chart momentum pullback detection |
| Server runtime | Node.js >= 18 | Webhook processing and API |
| Web framework | Express.js 4.x | HTTP routing and middleware |
| AI analysis | Anthropic Claude API (`@anthropic-ai/sdk`) | Contextual signal quality evaluation |
| Database | Supabase (PostgreSQL) | Persistent trade journal and analytics |
| Messaging | Telegram Bot API | Real-time signal delivery to mobile |
| Hosting | Railway.app | Server deployment with auto-scaling |
| Local fallback | JSONL file (`trade_journal.jsonl`) | Ephemeral journal when Supabase unavailable |

---

## 5. API Endpoints

### Signal Pipeline

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhook` | Main entry — receives TradingView alerts, runs full pipeline |

### Trade Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/close-trade` | Close an open trade with exit price and reason |
| `GET` | `/open-trades` | List all currently open positions |

### Analytics & Reporting

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/stats` | Overall trade statistics (win rate, P&L, count) |
| `GET` | `/stats/sessions` | Per-session performance breakdown |
| `GET` | `/stats/parameters` | R:R, risk, confidence, and direction analysis |
| `GET` | `/tune` | Automated strategy tuning recommendations |
| `GET` | `/report/weekly` | Generate weekly performance report (optionally sends via Telegram) |

### Monitoring & Configuration

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check — server status, uptime, last error |
| `GET` | `/journal` | Query signal history (supports `?limit=N`) |
| `GET` | `/risk-status` | Daily risk state per instrument (supports `?instrument=X`) |
| `GET` | `/news-status` | Today's high-impact economic events and filter status |
| `GET` | `/instruments` | List all configured instruments and their parameters |
| `GET` | `/sizing-status` | Current position sizing parameters and example calculations |

---

## 6. Database Schema

### `signals` table (Supabase PostgreSQL)

| Column | Type | Description |
|---|---|---|
| `id` | BIGINT (auto) | Primary key |
| `ts` | TIMESTAMPTZ | Signal timestamp |
| `instrument` | TEXT | Trading instrument (default: 'MNQ') |
| `session` | TEXT | Trading session identifier |
| `price` | DOUBLE PRECISION | Current market price at signal time |
| `signal` | TEXT | Direction: LONG, SHORT, or NO_TRADE |
| `entry` | DOUBLE PRECISION | Entry price |
| `sl` | DOUBLE PRECISION | Stop loss price |
| `tp` | DOUBLE PRECISION | Take profit price |
| `risk_pts` | DOUBLE PRECISION | Risk in points |
| `confidence` | TEXT | AI confidence: HIGH, MEDIUM, LOW |
| `reason` | TEXT | AI reasoning for the signal |
| `mtf` | JSONB | Multi-timeframe alignment data |
| `telegram_ok` | BOOLEAN | Whether Telegram delivery succeeded |
| `status` | TEXT | Trade status: open, closed, skipped |
| `close_price` | DOUBLE PRECISION | Exit price (when closed) |
| `close_ts` | TIMESTAMPTZ | Close timestamp |
| `pnl_pts` | DOUBLE PRECISION | Profit/loss in points |
| `closed_by` | TEXT | Close method: tp, sl, manual, timeout |

### Migrations

Migrations are located in `/migrations/` and should be run sequentially in the Supabase SQL Editor:

1. `001_create_signals_table.sql` — base signals table with RLS
2. `002_add_trade_tracking.sql` — adds trade lifecycle columns (status, close_price, pnl_pts)
3. `003_add_instrument_column.sql` — adds multi-instrument support

---

## 7. Configuration Reference

All configuration is via environment variables. See `env.example` for a complete template.

### Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude AI analysis |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Comma-separated Telegram chat IDs for alert delivery |

### Recommended

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SECRET` | — | Shared secret for webhook authentication |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port (Railway sets automatically) |
| `NOTIFY_NO_TRADE` | `false` | Send Telegram alerts for rejected signals |
| `JOURNAL_PATH` | `./trade_journal.jsonl` | Local journal file path |
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_KEY` | — | Supabase service role key |
| `APEX_MAX_DAILY_SIGNALS` | `10` | Max signals per instrument per day |
| `APEX_DAILY_LOSS_LIMIT` | `150` | Max daily risk exposure in points |
| `NEWS_FILTER_ENABLED` | `true` | Enable news event filter |
| `NEWS_SUPPRESS_WINDOW_MIN` | `15` | Suppress window around events (minutes) |
| `NEWS_SUPPRESS_MODE` | `block` | `block` or `warn` |
| `ACCOUNT_BALANCE` | `0` | Account balance for position sizing (0 = 1 contract fixed) |
| `RISK_PER_TRADE_PCT` | `0.5` | Risk per trade as % of balance |
| `APEX_SCALE_THRESHOLD` | `70` | % of loss limit to trigger scaling |
| `DEFAULT_INSTRUMENT` | `MNQ` | Default instrument when not specified |
| `INSTRUMENT_CONFIG` | — | JSON override for instrument parameters |

---

## 8. Deployment

### Railway.app (Production)

1. Connect GitHub repository to Railway
2. Railway auto-detects Node.js and runs `npm start`
3. Set all required environment variables in Railway dashboard
4. Railway provides a public URL: `https://xxx.up.railway.app`
5. Use this URL as the webhook target in TradingView alerts

### Local Development

```bash
npm install
cp env.example .env
# Fill in .env with your API keys
node server.js
```

The server starts on `PORT` (default 3000) and logs structured JSON to stdout.

---

## 9. Trading Sessions

The system operates within configured trading windows aligned with New York market hours:

| Window | Lisbon Time | New York Time |
|---|---|---|
| 1 | 14:45 - 15:15 | 09:45 - 10:15 |
| 2 | 15:45 - 16:15 | 10:45 - 11:15 |
| 3 | 16:45 - 17:15 | 11:45 - 12:15 |

Signals outside these windows are suppressed by the Pine Script indicator.

---

## 10. Version History

| Version | Key Changes |
|---|---|
| v1 | Initial ICT scalping signals with FVG/OB detection |
| v2 | Multi-timeframe validation, volume filters, session limits |
| v3 | Claude AI contextual analysis, structured logging, journal system |
| v4 | Supabase persistence, Apex Risk Guard, news filter, trade tracking, weekly reports |
| v5 | Multi-instrument support, position sizing engine, adaptive strategy analytics |
