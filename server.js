const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const fs        = require("fs");
const path      = require("path");
const { createClient } = require("@supabase/supabase-js");

// ── Variáveis de ambiente ───────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS  = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const NOTIFY_NO_TRADE    = (process.env.NOTIFY_NO_TRADE || "false") === "true";
const JOURNAL_PATH       = process.env.JOURNAL_PATH || "./trade_journal.jsonl";
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;

// Apex Risk Guard config (global defaults, can be overridden per instrument)
const APEX_MAX_DAILY_SIGNALS = parseInt(process.env.APEX_MAX_DAILY_SIGNALS || "10", 10);
const APEX_DAILY_LOSS_LIMIT  = parseFloat(process.env.APEX_DAILY_LOSS_LIMIT || "150"); // points

// ── Multi-Instrument Configuration ──────────────────────────────────────────
// Default instrument configs. Override via INSTRUMENT_CONFIG env var (JSON).
const DEFAULT_INSTRUMENTS = {
  MNQ: {
    name: "Micro E-mini Nasdaq 100",
    tickSize: 0.25,
    pointValue: 0.50,       // $ per point per contract
    maxRiskPts: 60,
    defaultRR: { min: 1.5, max: 3.0 },
    maxEntryDistance: 20,    // max pts from current_price
    sessions: ["14:30", "15:30", "16:30", "14:45", "15:45", "16:45"],
    maxDailySignals: APEX_MAX_DAILY_SIGNALS,
    dailyLossLimit: APEX_DAILY_LOSS_LIMIT,
  },
  MES: {
    name: "Micro E-mini S&P 500",
    tickSize: 0.25,
    pointValue: 1.25,
    maxRiskPts: 20,
    defaultRR: { min: 1.5, max: 3.0 },
    maxEntryDistance: 8,
    sessions: ["14:30", "15:30", "16:30", "14:45", "15:45", "16:45"],
    maxDailySignals: APEX_MAX_DAILY_SIGNALS,
    dailyLossLimit: APEX_DAILY_LOSS_LIMIT,
  },
  NQ: {
    name: "E-mini Nasdaq 100",
    tickSize: 0.25,
    pointValue: 5.00,
    maxRiskPts: 60,
    defaultRR: { min: 1.5, max: 3.0 },
    maxEntryDistance: 20,
    sessions: ["14:30", "15:30", "16:30", "14:45", "15:45", "16:45"],
    maxDailySignals: Math.max(1, Math.floor(APEX_MAX_DAILY_SIGNALS / 2)),
    dailyLossLimit: APEX_DAILY_LOSS_LIMIT,
  },
  ES: {
    name: "E-mini S&P 500",
    tickSize: 0.25,
    pointValue: 12.50,
    maxRiskPts: 20,
    defaultRR: { min: 1.5, max: 3.0 },
    maxEntryDistance: 8,
    sessions: ["14:30", "15:30", "16:30", "14:45", "15:45", "16:45"],
    maxDailySignals: Math.max(1, Math.floor(APEX_MAX_DAILY_SIGNALS / 2)),
    dailyLossLimit: APEX_DAILY_LOSS_LIMIT,
  },
};

// Merge user overrides from env var
let INSTRUMENTS = { ...DEFAULT_INSTRUMENTS };
if (process.env.INSTRUMENT_CONFIG) {
  try {
    const overrides = JSON.parse(process.env.INSTRUMENT_CONFIG);
    for (const [key, cfg] of Object.entries(overrides)) {
      INSTRUMENTS[key.toUpperCase()] = { ...DEFAULT_INSTRUMENTS[key.toUpperCase()], ...cfg };
    }
    log("INFO", "STARTUP", `Instrument config loaded: ${Object.keys(INSTRUMENTS).join(", ")}`);
  } catch (err) {
    log("WARN", "STARTUP", "Failed to parse INSTRUMENT_CONFIG env var — using defaults", { error: err.message });
  }
}

const DEFAULT_INSTRUMENT = process.env.DEFAULT_INSTRUMENT || "MNQ";

function getInstrumentConfig(instrument) {
  const key = (instrument || DEFAULT_INSTRUMENT).toUpperCase();
  return INSTRUMENTS[key] || null;
}

// ── Position Sizing Engine ──────────────────────────────────────────────────
const ACCOUNT_BALANCE       = parseFloat(process.env.ACCOUNT_BALANCE || "0");       // 0 = unknown
const RISK_PER_TRADE_PCT    = parseFloat(process.env.RISK_PER_TRADE_PCT || "0.5");  // % of balance per trade
const APEX_SCALE_THRESHOLD  = parseFloat(process.env.APEX_SCALE_THRESHOLD || "70"); // % of daily loss limit to start scaling down

function calculatePositionSize(signal, instrument) {
  const cfg = getInstrumentConfig(instrument);
  if (!cfg || ACCOUNT_BALANCE <= 0 || typeof signal.risk_pts !== "number" || signal.risk_pts <= 0) {
    return { contracts: 1, method: "default", reason: "Balance unknown or risk_pts unavailable" };
  }

  // Max $ risk per trade = balance * risk%
  const maxRiskDollars = ACCOUNT_BALANCE * (RISK_PER_TRADE_PCT / 100);

  // $ risk per contract = risk_pts * pointValue
  const riskPerContract = signal.risk_pts * cfg.pointValue;
  if (riskPerContract <= 0) {
    return { contracts: 1, method: "default", reason: "Invalid risk per contract" };
  }

  // Base contracts from risk budget
  let contracts = Math.floor(maxRiskDollars / riskPerContract);

  // Confidence adjustment: HIGH=100%, MEDIUM=75%, LOW=50%
  const confKey = (signal.confidence || "").toUpperCase();
  const confMultiplier = { HIGH: 1.0, MEDIUM: 0.75, LOW: 0.5 }[confKey] || 0.75;
  contracts = Math.floor(contracts * confMultiplier);

  // Apex compliance: scale down when approaching daily loss limit
  const dailyRisk = getDailyRisk(instrument);
  const lossLimit = cfg.dailyLossLimit;
  if (lossLimit > 0 && dailyRisk.totalRiskPts > 0) {
    const usedPct = (dailyRisk.totalRiskPts / lossLimit) * 100;
    if (usedPct >= APEX_SCALE_THRESHOLD) {
      // Linear scale-down: at threshold = 100%, at limit = 25%
      const remaining = Math.max(0, 100 - usedPct);
      const total = 100 - APEX_SCALE_THRESHOLD;
      const scaleFactor = total > 0 ? Math.max(0.25, remaining / total) : 0.25;
      contracts = Math.max(1, Math.floor(contracts * scaleFactor));
    }
  }

  // Minimum 1 contract
  contracts = Math.max(1, contracts);

  return {
    contracts,
    method: "risk_based",
    maxRiskDollars: parseFloat(maxRiskDollars.toFixed(2)),
    riskPerContract: parseFloat(riskPerContract.toFixed(2)),
    confidenceMultiplier: confMultiplier,
    reason: `${RISK_PER_TRADE_PCT}% of $${ACCOUNT_BALANCE} = $${maxRiskDollars.toFixed(2)} max risk, ${confKey} confidence`,
  };
}

// News Event Filter config
const NEWS_FILTER_ENABLED      = (process.env.NEWS_FILTER_ENABLED || "true") !== "false";
const NEWS_SUPPRESS_WINDOW_MIN = parseInt(process.env.NEWS_SUPPRESS_WINDOW_MIN || "15", 10);
const NEWS_SUPPRESS_MODE       = process.env.NEWS_SUPPRESS_MODE || "block"; // "block" | "warn"

if (!ANTHROPIC_API_KEY) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "FATAL", msg: "ANTHROPIC_API_KEY não definida" }));
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
  log("WARN", "STARTUP", "TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos — alertas Telegram desativados");
}

// ── Supabase (persistent journal) ─────────────────────────────────────────
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  log("INFO", "STARTUP", "Supabase configured — journal will persist to PostgreSQL");
} else {
  log("WARN", "STARTUP", "SUPABASE_URL/SUPABASE_KEY not set — journal falls back to local JSONL (ephemeral on Railway)");
}

// ── Logging estruturado ────────────────────────────────────────────────────
function log(level, component, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, component, msg, ...extra };
  (level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log)(JSON.stringify(entry));
}

// ── Global state ──────────────────────────────────────────────────────────
let lastError = null;

// ── Apex Risk Guard — per-instrument daily risk state ─────────────────────
const dailyRiskByInstrument = {};  // keyed by instrument symbol

function getETDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getDailyRisk(instrument) {
  const key = (instrument || DEFAULT_INSTRUMENT).toUpperCase();
  if (!dailyRiskByInstrument[key]) {
    dailyRiskByInstrument[key] = {
      date: null, signalCount: 0, totalRiskPts: 0,
      halted: false, signals: [], _alertSent: false,
    };
  }
  return dailyRiskByInstrument[key];
}

function resetDailyRiskIfNewDay(instrument) {
  const dailyRisk = getDailyRisk(instrument);
  const today = getETDate();
  if (dailyRisk.date !== today) {
    dailyRisk.date = today;
    dailyRisk.signalCount = 0;
    dailyRisk.totalRiskPts = 0;
    dailyRisk.halted = false;
    dailyRisk.signals = [];
    dailyRisk._alertSent = false;
    log("INFO", "RISK_GUARD", `Daily risk state reset for ${today}`, { instrument });
  }
  return dailyRisk;
}

function checkDailyRiskLimit(instrument) {
  const dailyRisk = resetDailyRiskIfNewDay(instrument);
  const cfg = getInstrumentConfig(instrument);
  const maxSignals = cfg ? cfg.maxDailySignals : APEX_MAX_DAILY_SIGNALS;
  const lossLimit = cfg ? cfg.dailyLossLimit : APEX_DAILY_LOSS_LIMIT;

  if (dailyRisk.signalCount >= maxSignals) {
    return { blocked: true, reason: `Daily signal limit reached (${dailyRisk.signalCount}/${maxSignals})` };
  }
  if (dailyRisk.totalRiskPts >= lossLimit) {
    return { blocked: true, reason: `Daily risk exposure limit reached (${dailyRisk.totalRiskPts.toFixed(1)}/${lossLimit} pts)` };
  }
  return { blocked: false };
}

function recordSignalRisk(signal, instrument) {
  const dailyRisk = resetDailyRiskIfNewDay(instrument);
  const cfg = getInstrumentConfig(instrument);
  const maxSignals = cfg ? cfg.maxDailySignals : APEX_MAX_DAILY_SIGNALS;
  const lossLimit = cfg ? cfg.dailyLossLimit : APEX_DAILY_LOSS_LIMIT;

  dailyRisk.signalCount++;
  dailyRisk.totalRiskPts += typeof signal.risk_pts === "number" ? signal.risk_pts : 0;
  dailyRisk.signals.push({
    ts: new Date().toISOString(),
    signal: signal.signal,
    risk_pts: signal.risk_pts,
    entry: signal.entry,
    instrument: (instrument || DEFAULT_INSTRUMENT).toUpperCase(),
  });
  if (dailyRisk.signalCount >= maxSignals || dailyRisk.totalRiskPts >= lossLimit) {
    dailyRisk.halted = true;
    log("WARN", "RISK_GUARD", "Daily limit reached — halting signals", {
      instrument, signalCount: dailyRisk.signalCount, totalRiskPts: dailyRisk.totalRiskPts,
    });
  }
}

// ── News Event Filter — suppress signals near high-impact economic events ─
const newsCache = {
  date: null,     // YYYY-MM-DD when cache was last refreshed
  events: [],     // [{ time: Date, title: string, currency: string, impact: string }]
  fetching: false,
};

// Static recurring high-impact USD events (known schedule patterns)
// These serve as fallback when the live feed is unavailable
function getStaticHighImpactEvents(dateStr) {
  const events = [];
  const d = new Date(dateStr + "T00:00:00-05:00"); // ET
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon...
  const dayOfMonth = d.getDate();

  // NFP — first Friday of month
  if (dayOfWeek === 5 && dayOfMonth <= 7) {
    events.push({ time: new Date(dateStr + "T08:30:00-05:00"), title: "Non-Farm Payrolls", currency: "USD", impact: "high" });
    events.push({ time: new Date(dateStr + "T08:30:00-05:00"), title: "Unemployment Rate", currency: "USD", impact: "high" });
  }

  // CPI — typically second Tuesday or Wednesday of month
  if ((dayOfWeek === 2 || dayOfWeek === 3) && dayOfMonth >= 10 && dayOfMonth <= 14) {
    events.push({ time: new Date(dateStr + "T08:30:00-05:00"), title: "CPI (estimated)", currency: "USD", impact: "high" });
  }

  // FOMC — 8 meetings/year, typically Tue-Wed, announcement at 14:00 ET
  // We use a broad heuristic: 3rd week of Jan, Mar, May, Jun, Jul, Sep, Nov, Dec
  const month = d.getMonth(); // 0-indexed
  const fomcMonths = [0, 2, 4, 5, 6, 8, 10, 11];
  if (fomcMonths.includes(month) && dayOfWeek === 3 && dayOfMonth >= 15 && dayOfMonth <= 22) {
    events.push({ time: new Date(dateStr + "T14:00:00-05:00"), title: "FOMC Rate Decision (estimated)", currency: "USD", impact: "high" });
  }

  return events;
}

async function fetchEconomicCalendar() {
  const today = getETDate();
  if (newsCache.date === today && newsCache.events.length > 0) return newsCache.events;
  if (newsCache.fetching) return newsCache.events; // avoid concurrent fetches

  newsCache.fetching = true;
  try {
    // Use Forex Factory's week calendar page via a lightweight JSON proxy
    // Fallback: novalabs or static list
    const url = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;
    const res = await fetchWithTimeout(url, {}, 8000);

    if (!res.ok) {
      log("WARN", "NEWS_FILTER", `Calendar API returned ${res.status} — using static fallback`);
      newsCache.events = getStaticHighImpactEvents(today);
      newsCache.date = today;
      return newsCache.events;
    }

    const data = await res.json();
    // Filter to high-impact USD events for today
    const todayEvents = [];
    for (const ev of data) {
      if (ev.impact !== "High") continue;
      if (ev.country !== "USD") continue;

      // Parse date — format: "YYYY-MM-DDT08:30:00-04:00" or similar
      const eventDate = new Date(ev.date);
      const eventDateStr = eventDate.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

      // Include events for today and tomorrow (to catch overnight/pre-market)
      const tomorrow = new Date(today + "T00:00:00-05:00");
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

      if (eventDateStr === today || eventDateStr === tomorrowStr) {
        todayEvents.push({
          time: eventDate,
          title: ev.title,
          currency: ev.country,
          impact: ev.impact.toLowerCase(),
        });
      }
    }

    if (todayEvents.length > 0) {
      newsCache.events = todayEvents;
      log("INFO", "NEWS_FILTER", `Loaded ${todayEvents.length} high-impact events for ${today}`, {
        events: todayEvents.map(e => `${e.title} @ ${e.time.toISOString()}`),
      });
    } else {
      // No high-impact events from feed — merge with static as safety net
      newsCache.events = getStaticHighImpactEvents(today);
      log("INFO", "NEWS_FILTER", `No high-impact events from feed for ${today}, static fallback: ${newsCache.events.length} events`);
    }

    newsCache.date = today;
    return newsCache.events;
  } catch (err) {
    log("WARN", "NEWS_FILTER", "Failed to fetch economic calendar — using static fallback", { error: err.message });
    newsCache.events = getStaticHighImpactEvents(today);
    newsCache.date = today;
    return newsCache.events;
  } finally {
    newsCache.fetching = false;
  }
}

function checkNewsFilter(events) {
  if (!events || events.length === 0) return { blocked: false };

  const now = Date.now();
  const windowMs = NEWS_SUPPRESS_WINDOW_MIN * 60 * 1000;

  for (const ev of events) {
    const eventTime = ev.time instanceof Date ? ev.time.getTime() : new Date(ev.time).getTime();
    const diff = Math.abs(now - eventTime);
    if (diff <= windowMs) {
      const minutesAway = Math.round(diff / 60000);
      const direction = now < eventTime ? "in" : "ago";
      return {
        blocked: true,
        event: ev.title,
        detail: `${ev.title} (${ev.currency}) — ${minutesAway}min ${direction}`,
      };
    }
  }

  return { blocked: false };
}

// Pre-warm the cache on startup
if (NEWS_FILTER_ENABLED) fetchEconomicCalendar().catch(() => {});

// Refresh cache daily at 00:05 ET
setInterval(() => {
  const today = getETDate();
  if (newsCache.date !== today) {
    fetchEconomicCalendar().catch(() => {});
  }
}, 5 * 60 * 1000);

// ── Rate Limiting ──────────────────────────────────────────────────────────
const rateStore = new Map();
const RATE_LIMIT     = 10;
const RATE_WINDOW    = 60 * 1000;
const RATE_MAX_KEYS  = 10000; // protecção contra IP spoofing massivo

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = rateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    if (!entry && rateStore.size >= RATE_MAX_KEYS) return false; // reject se store cheia
    rateStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateStore.entries()) {
    if (now > e.resetAt) rateStore.delete(ip);
  }
}, 5 * 60 * 1000);

// ── Deduplicação ───────────────────────────────────────────────────────────
const dedupStore = new Map();
const DEDUP_TTL  = 5 * 60 * 1000;

function hashPayload(body) {
  const key = `${body.session ?? ""}|${body.current_price ?? ""}|${body.suggested_entry ?? ""}|${body.suggested_sl ?? ""}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h << 5) + h) ^ key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function isDuplicate(hash) {
  const now = Date.now();
  if (dedupStore.has(hash)) return true;
  dedupStore.set(hash, now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [h, ts] of dedupStore.entries()) {
    if (now - ts > DEDUP_TTL) dedupStore.delete(h);
  }
}, 5 * 60 * 1000);

// ── Validação estrutural de candle OHLC ────────────────────────────────────
function isValidCandle(c) {
  return c !== null && typeof c === "object"
    && typeof c.o === "number" && typeof c.h === "number"
    && typeof c.l === "number" && typeof c.c === "number"
    && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c)
    && c.h >= c.l
    && c.h >= c.o && c.h >= c.c
    && c.l <= c.o && c.l <= c.c;
}

// ── Retry helper com backoff exponencial ───────────────────────────────────
async function withRetry(fn, { maxRetries = 2, baseDelay = 1000, label = "operation" } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        log("ERROR", "RETRY", `${label} falhou após ${maxRetries + 1} tentativas`, { error: err.message });
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      log("WARN", "RETRY", `${label} tentativa ${attempt + 1} falhou, retry em ${delay}ms`, { error: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Fetch com timeout (AbortController cancela o fetch real) ───────────────
function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── Journal — persists to Supabase with JSONL fallback ────────────────────
function journalSignalToFile(entry) {
  fs.appendFile(JOURNAL_PATH, JSON.stringify(entry) + "\n", (err) => {
    if (err) log("WARN", "JOURNAL", "Erro ao gravar journal local", { error: err.message });
  });
}

async function journalSignal(payload, signal, telegramResult, instrument) {
  const inst = (instrument || DEFAULT_INSTRUMENT).toUpperCase();
  const entry = {
    ts: new Date().toISOString(),
    instrument: inst,
    session: payload.session,
    price: payload.current_price,
    signal: signal.signal,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    risk_pts: signal.risk_pts,
    confidence: signal.confidence,
    reason: signal.reason,
    mtf: payload.mtf || null,
    telegram_ok: telegramResult?.ok ?? null,
  };

  // Determine trade status: actual trades are 'open', NO_TRADE signals are 'skipped'
  const tradeStatus = signal.signal !== "NO_TRADE" ? "open" : "skipped";

  if (supabase) {
    const row = {
      ts: entry.ts,
      instrument: inst,
      session: entry.session,
      price: entry.price,
      signal: entry.signal,
      entry: entry.entry,
      sl: entry.sl,
      tp: entry.tp,
      risk_pts: entry.risk_pts,
      confidence: entry.confidence,
      reason: entry.reason,
      mtf: entry.mtf,
      telegram_ok: entry.telegram_ok,
      status: tradeStatus,
    };
    let { error } = await supabase.from("signals").insert(row);
    // Graceful fallback if instrument column not yet added (migration 003)
    if (error && error.message && error.message.includes("instrument")) {
      log("WARN", "JOURNAL", "instrument column missing — retrying without it (run migration 003)", { error: error.message });
      const { instrument: _omit, ...rowNoInst } = row;
      ({ error } = await supabase.from("signals").insert(rowNoInst));
    }
    if (error) {
      log("ERROR", "JOURNAL", "Supabase insert failed — falling back to JSONL", { error: error.message });
      journalSignalToFile(entry);
    } else {
      log("INFO", "JOURNAL", "Signal persisted to Supabase");
    }
  } else {
    journalSignalToFile(entry);
  }
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1); // confia no primeiro proxy (Railway/Render)

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "DENY");
  res.setHeader("X-XSS-Protection",        "1; mode=block");
  res.setHeader("Referrer-Policy",         "no-referrer");
  next();
});

app.use(cors({ origin: ["https://www.tradingview.com", "https://tradingview.com"] }));
app.use(express.json({ limit: "10kb" }));

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── ICT Strategy prompt — NOVO PAPEL: análise contextual ──────────────────
// O Pine Script v3 já valida todas as regras mecanicamente.
// O Claude analisa o CONTEXTO que o Pine não pode avaliar:
// - Coerência do setup (os dados fazem sentido juntos?)
// - Qualidade do displacement
// - Risco elevado em condições de mercado adversas
// - Ajuste fino dos níveis se encontrar inconsistência
const STRATEGY_PROMPT = `És um analista expert em scalping para CME futures (1 minuto). O instrumento específico é indicado no campo "instrument" dos dados.

O sinal que recebes foi gerado pelo indicador v4 baseado em:
- Momentum pullback reversal (blackcat1402 weighted price oscillator)
- SMA trend alignment (SMA3 > SMA10 > SMA20 para bullish, inverso para bearish)
- Confirmação com vela direcional
- MTF 1D trend alignment
- Swing points para SL placement

O TEU PAPEL é avaliar a QUALIDADE contextual:

1. COERÊNCIA:
   - Entry/SL/TP fazem sentido vs current_price?
   - O risco em pontos é razoável para scalping (< 30 pts ideal, < 50 aceitável)?
   - R:R está próximo de 2:1?

2. QUALIDADE DAS VELAS:
   - As 3 velas mostram momentum real ou hesitação/dojis?
   - Volume suporta o movimento?

3. MOMENTUM & BIAS:
   - "momentum": 0-100 (< 30 oversold, > 70 overbought)
   - "institutional_bias": SMA alignment direction
   - "ob_bias": ICT Order Block bias (contexto adicional)
   - Se momentum e institutional_bias concordam com a direcção = HIGH confidence
   - Se discordam parcialmente = MEDIUM
   - Se contradizem = LOW ou NO_TRADE

4. CONDIÇÕES PARA REJEIÇÃO (NO_TRADE):
   - Entry > 15 pts longe do current_price
   - Risco > 50 pontos
   - Velas com corpos < 20% do range (indecisão)
   - momentum em zona extrema contra a direcção (LONG com mom > 90, SHORT com mom < 10)

DADOS:
- "candles_1m": últimas 3 velas [{ o, h, l, c, v }]
- "ob_bias": "BULLISH"/"BEARISH"/"NONE" (ICT Order Block context)
- "swings": [{ type, price }]
- "mtf": { "1d", "4h" } — "BULL"/"BEAR"/"NEUTRAL"
- "momentum": 0-100
- "institutional_bias": "BULLISH"/"BEARISH"/"NEUTRAL"
- "session", "current_price", "suggested_entry", "suggested_sl", "tp", "risk_pts"

Responde APENAS com JSON válido. Sem markdown.

{
  "signal": "LONG" | "SHORT" | "NO_TRADE",
  "reason": "explicação breve em português (max 140 chars)",
  "entry": number | null,
  "sl": number | null,
  "tp": number | null,
  "risk_pts": number | null,
  "rr": 2.0,
  "ob_bias": "BULLISH" | "BEARISH" | "NONE",
  "mtf_aligned": true | false,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "no_trade_reason": "string se NO_TRADE, senão null"
}`;

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(signal, isNoTrade = false, instrument) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    log("WARN", "TELEGRAM", "Telegram desativado — credenciais não configuradas");
    return { ok: false, reason: "telegram_not_configured" };
  }

  const inst = (instrument || DEFAULT_INSTRUMENT).toUpperCase();

  let msg;
  if (isNoTrade) {
    msg =
      `⚪ NO TRADE — ${inst}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📊 Sessão: ${signal.session || "—"}\n` +
      `💬 ${signal.reason || signal.no_trade_reason || "Setup rejeitado"}`;
  } else {
    const dir      = signal.signal === "LONG" ? "▲ LONG" : "▼ SHORT";
    const emoji    = signal.signal === "LONG" ? "🟢" : "🔴";
    const confKey  = (signal.confidence || "").toUpperCase();
    const conf     = { HIGH: "🔥 Alta", MEDIUM: "⚡ Média", LOW: "⚠️ Baixa" }[confKey] || "❓ Desconhecida";
    const risk     = typeof signal.risk_pts === "number" ? `${signal.risk_pts.toFixed(2)} pts` : "—";

    msg =
      `${emoji} TRADE ALERT — ${inst}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `Direção: ${dir}\n` +
      `Confiança: ${conf}\n\n` +
      `🎯 Entry:  ${typeof signal.entry  === "number" ? signal.entry.toFixed(2)  : "—"}\n` +
      `✅ TP:     ${typeof signal.tp     === "number" ? signal.tp.toFixed(2)     : "—"}\n` +
      `❌ SL:     ${typeof signal.sl     === "number" ? signal.sl.toFixed(2)     : "—"}\n\n` +
      `📊 R/R: 1:2  |  Risco: ${risk}\n` +
      `📦 Contratos: ${signal.contracts || 1}\n` +
      `🔍 OB: ${signal.broken_ob_direction || "—"}  |  FVG: ${signal.fvg_touched || "—"}\n` +
      `📈 MTF: ${signal.mtf_aligned ? "✓ Alinhado" : "✗ Desalinhado"}\n\n` +
      `💬 ${signal.reason || "Sem razão fornecida"}`;
  }

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map(async (chatId) => {
      const res = await fetchWithTimeout(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ chat_id: chatId, text: msg }),
        },
        10000
      );
      const data = await res.json();
      if (!data.ok) log("WARN", "TELEGRAM", `Falhou para ${chatId}`, { description: data.description });
      return { chatId, ...data };
    })
  );

  const sent = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  log("INFO", "TELEGRAM", `Enviado para ${sent}/${TELEGRAM_CHAT_IDS.length} utilizadores`);
  return { ok: sent > 0, sent, total: TELEGRAM_CHAT_IDS.length };
}

// ── Validação do signal — instrument-aware ───────────────────────────────
function validateSignal(signal, payload, instrument) {
  if (!signal || !["LONG", "SHORT", "NO_TRADE"].includes(signal.signal))
    return { valid: false, reason: `signal inválido: ${signal?.signal}` };

  const cfg = getInstrumentConfig(instrument);
  const maxRisk = cfg ? cfg.maxRiskPts : 60;
  const rrRange = cfg ? cfg.defaultRR : { min: 1.5, max: 3.0 };
  const maxEntryDist = cfg ? cfg.maxEntryDistance : 20;

  if (signal.signal !== "NO_TRADE") {
    if (typeof signal.entry !== "number" || typeof signal.sl !== "number" || typeof signal.tp !== "number")
      return { valid: false, reason: `${signal.signal} sem entry/sl/tp numéricos` };

    // SL do lado correto
    if (signal.signal === "LONG"  && signal.sl >= signal.entry)
      return { valid: false, reason: "LONG com SL >= entry" };
    if (signal.signal === "SHORT" && signal.sl <= signal.entry)
      return { valid: false, reason: "SHORT com SL <= entry" };

    // TP do lado correto
    if (signal.signal === "LONG"  && signal.tp <= signal.entry)
      return { valid: false, reason: "LONG com TP <= entry" };
    if (signal.signal === "SHORT" && signal.tp >= signal.entry)
      return { valid: false, reason: "SHORT com TP >= entry" };

    // R:R sanity
    const risk   = Math.abs(signal.entry - signal.sl);
    const reward = Math.abs(signal.tp - signal.entry);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr < rrRange.min || rr > rrRange.max)
        return { valid: false, reason: `R:R fora do range: ${rr.toFixed(2)} (esperado ${rrRange.min}-${rrRange.max})` };
    }

    // Risk em pontos
    if (typeof signal.risk_pts === "number" && signal.risk_pts > maxRisk)
      return { valid: false, reason: `Risco ${signal.risk_pts.toFixed(1)} pts > ${maxRisk} max` };

    // Entry deve estar perto do current_price
    if (typeof payload.current_price === "number") {
      const diff = Math.abs(signal.entry - payload.current_price);
      if (diff > maxEntryDist)
        return { valid: false, reason: `Entry ${diff.toFixed(1)} pts longe do preço atual (max ${maxEntryDist})` };
    }
  }
  return { valid: true };
}

// ── Webhook endpoint ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {

  // 1. Rate limiting
  const clientIp = req.ip || "unknown";
  if (!checkRateLimit(clientIp)) {
    log("WARN", "WEBHOOK", "Rate limit excedido", { ip: clientIp });
    return res.status(429).json({ error: "rate_limit_exceeded" });
  }

  // 2. Autenticação (timing-safe para prevenir timing attacks)
  if (WEBHOOK_SECRET) {
    const provided = req.headers["x-webhook-secret"] || req.body?.webhook_secret || "";
    const secretBuf   = Buffer.from(WEBHOOK_SECRET, "utf8");
    const providedBuf = Buffer.from(String(provided), "utf8");
    if (secretBuf.length !== providedBuf.length || !crypto.timingSafeEqual(secretBuf, providedBuf)) {
      log("WARN", "WEBHOOK", "Secret inválido rejeitado", { ip: clientIp });
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const {
    candles_1m, broken_ob, fvgs, swings, mtf,
    session, current_price, suggested_entry, suggested_sl, tp, risk_pts,
    momentum, institutional_bias,
    instrument: rawInstrument,
  } = req.body;

  // Resolve instrument (default: MNQ for backward compat)
  const instrument = (rawInstrument || DEFAULT_INSTRUMENT).toUpperCase();
  const instrumentCfg = getInstrumentConfig(instrument);
  if (!instrumentCfg) {
    return res.status(400).json({ error: `Unknown instrument: ${instrument}. Supported: ${Object.keys(INSTRUMENTS).join(", ")}` });
  }

  // 3. Validação de campos obrigatórios
  if (!session || typeof current_price !== "number")
    return res.status(400).json({ error: "session e current_price são obrigatórios" });

  if (!instrumentCfg.sessions.includes(session))
    return res.status(400).json({ error: `session inválida para ${instrument}: ${session}` });

  if (!Array.isArray(candles_1m) || candles_1m.length < 1)
    return res.status(400).json({ error: "candles_1m deve ser array com >= 1 vela" });

  // 4. Validação estrutural dos candles
  const invalidCandle = candles_1m.find(c => !isValidCandle(c));
  if (invalidCandle)
    return res.status(400).json({ error: "candle inválido: OHLC inconsistente", candle: invalidCandle });

  // 5. Deduplicação
  const payloadHash = hashPayload(req.body);
  if (isDuplicate(payloadHash)) {
    log("WARN", "WEBHOOK", "Payload duplicado ignorado", { hash: payloadHash, session });
    return res.status(200).json({ ok: true, signal: null, duplicate: true });
  }

  log("INFO", "WEBHOOK", "Sinal recebido", {
    session, price: current_price,
    ob: broken_ob?.type || "none",
    mtf: mtf || "not_provided",
    ip: clientIp,
  });

  // 6. Apex Risk Guard — check daily limits (per instrument)
  const riskCheck = checkDailyRiskLimit(instrument);
  if (riskCheck.blocked) {
    log("WARN", "RISK_GUARD", "Signal blocked by daily risk limit", { reason: riskCheck.reason, instrument });
    const blockedSignal = {
      signal: "NO_TRADE",
      reason: `🛑 Apex Risk Guard: ${riskCheck.reason}`,
      no_trade_reason: "daily_risk_limit",
      entry: null, sl: null, tp: null, risk_pts: null,
      confidence: "LOW", mtf_aligned: false,
      instrument,
    };
    const dailyRisk = getDailyRisk(instrument);
    if (!dailyRisk._alertSent) {
      dailyRisk._alertSent = true;
      sendHealthAlert(
        `🛑 APEX RISK GUARD — Daily Limit Reached (${instrument})\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `📊 ${riskCheck.reason}\n` +
        `🔒 All ${instrument} signals blocked until midnight ET\n` +
        `🕐 ${new Date().toISOString()}`
      ).catch(() => {});
    }
    journalSignal(req.body, blockedSignal, null, instrument);
    return res.json({ ok: true, signal: blockedSignal, risk_blocked: true, instrument });
  }

  // 7. News Event Filter — suppress signals near high-impact economic events
  const newsEvents = NEWS_FILTER_ENABLED ? await fetchEconomicCalendar() : [];
  const newsCheck = checkNewsFilter(newsEvents);
  if (newsCheck.blocked) {
    log("WARN", "NEWS_FILTER", "Signal suppressed due to high-impact news event", {
      event: newsCheck.event, detail: newsCheck.detail, session,
    });
    const newsBlockedSignal = {
      signal: "NO_TRADE",
      reason: `📰 News Filter: ${newsCheck.detail}`,
      no_trade_reason: "news_event_suppressed",
      entry: null, sl: null, tp: null, risk_pts: null,
      confidence: "LOW", mtf_aligned: false,
    };

    if (NEWS_SUPPRESS_MODE === "block") {
      // Send Telegram alert about suppression
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS.length > 0) {
        sendHealthAlert(
          `📰 NEWS FILTER — Signal Suppressed\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `📊 Session: ${session}\n` +
          `⚠️ ${newsCheck.detail}\n` +
          `🔒 Window: ±${NEWS_SUPPRESS_WINDOW_MIN}min\n` +
          `🕐 ${new Date().toISOString()}`
        ).catch(() => {});
      }
      journalSignal(req.body, newsBlockedSignal, null, instrument);
      return res.json({ ok: true, signal: newsBlockedSignal, news_blocked: true, instrument });
    }
    // warn mode — continue processing but flag it (newsCheck available downstream)
    log("INFO", "NEWS_FILTER", "News event detected — warn mode, continuing signal processing");
  }

  try {
    const payload = JSON.stringify({
      instrument, instrument_name: instrumentCfg.name,
      candles_1m, broken_ob, fvgs, swings, mtf,
      momentum, institutional_bias,
      session, current_price, suggested_entry, suggested_sl, tp, risk_pts,
    });

    // Chamada ao Claude COM retry
    const message = await withRetry(
      () => anthropic.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 600,
        system:     STRATEGY_PROMPT,
        messages:   [{ role: "user", content: `Analisa este setup e retorna o signal:\n${payload}` }],
      }, { timeout: 15000 }),
      { maxRetries: 2, baseDelay: 1000, label: "Claude API" }
    );

    const raw = message.content[0].text.trim();
    log("INFO", "CLAUDE", "Resposta recebida", { preview: raw.substring(0, 150) });

    let signal;
    try {
      signal = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      signal = match
        ? JSON.parse(match[0])
        : { signal: "NO_TRADE", reason: "Erro ao processar resposta do AI", no_trade_reason: "parse_error" };
    }

    const validation = validateSignal(signal, req.body, instrument);
    if (!validation.valid) {
      log("WARN", "VALIDAÇÃO", "Signal rejeitado", { reason: validation.reason });
      signal = {
        signal: "NO_TRADE", reason: `Signal rejeitado: ${validation.reason}`,
        entry: null, sl: null, tp: null, risk_pts: null,
        rr: null, broken_ob_direction: "NONE", fvg_touched: "NONE",
        confidence: "LOW", no_trade_reason: validation.reason,
        mtf_aligned: false,
      };
    }

    // Filtrar sinais com confiança LOW — não enviar alerta
    if (signal.signal !== "NO_TRADE" && (signal.confidence || "").toUpperCase() === "LOW") {
      log("INFO", "FILTER", "Signal com confiança LOW filtrado — não enviado", {
        signal: signal.signal, reason: signal.reason, confidence: signal.confidence,
      });
      signal = {
        signal: "NO_TRADE", reason: `Confiança LOW — signal ${signal.signal} filtrado`,
        entry: null, sl: null, tp: null, risk_pts: null,
        rr: null, broken_ob_direction: signal.broken_ob_direction || "NONE",
        fvg_touched: signal.fvg_touched || "NONE",
        confidence: "LOW", no_trade_reason: "low_confidence_filtered",
        mtf_aligned: signal.mtf_aligned || false,
      };
    }

    // Position sizing for active trades
    let sizing = null;
    if (signal.signal !== "NO_TRADE") {
      sizing = calculatePositionSize(signal, instrument);
      signal.contracts = sizing.contracts;
      signal.sizing = sizing;
    }

    let telegramResult = null;
    if (signal.signal !== "NO_TRADE") {
      // Record risk before sending — Apex Risk Guard (per instrument)
      recordSignalRisk(signal, instrument);
      try {
        telegramResult = await sendTelegram(signal, false, instrument);
      } catch (err) {
        log("ERROR", "TELEGRAM", "Erro ao enviar trade alert", { error: err.message });
        telegramResult = { ok: false, error: "telegram_send_failed" };
      }
    } else if (NOTIFY_NO_TRADE) {
      // Notificação opcional de NO_TRADE para debugging
      try {
        signal.session = session; // attach session for the message
        telegramResult = await sendTelegram(signal, true, instrument);
      } catch (err) {
        log("WARN", "TELEGRAM", "Erro ao enviar NO_TRADE notification", { error: err.message });
      }
    }

    // Journal — grava todos os sinais (trade e no_trade)
    journalSignal(req.body, signal, telegramResult, instrument);

    res.json({ ok: true, signal, telegram: telegramResult, instrument });

  } catch (err) {
    log("ERROR", "WEBHOOK", "Erro interno", { error: err.message });
    res.status(500).json({ error: "Erro interno ao processar signal" });
  }
});

// ── Trade Outcome Tracker — close trades + stats ─────────────────────────

// Close a trade by signal ID
app.post("/close-trade", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Trade tracking requires Supabase" });

  const { signal_id, close_price, closed_by } = req.body;

  if (!signal_id || typeof close_price !== "number")
    return res.status(400).json({ error: "signal_id (number) and close_price (number) are required" });

  const validClosedBy = ["tp", "sl", "manual", "timeout"];
  const closeReason = validClosedBy.includes(closed_by) ? closed_by : "manual";

  // Fetch the open trade
  const { data: trade, error: fetchErr } = await supabase
    .from("signals")
    .select("id, signal, entry, sl, tp, status")
    .eq("id", signal_id)
    .single();

  if (fetchErr || !trade)
    return res.status(404).json({ error: `Trade ${signal_id} not found` });

  if (trade.status !== "open")
    return res.status(409).json({ error: `Trade ${signal_id} is already ${trade.status}` });

  // Calculate P&L in points
  let pnl_pts = null;
  if (typeof trade.entry === "number") {
    pnl_pts = trade.signal === "LONG"
      ? close_price - trade.entry
      : trade.entry - close_price;
    pnl_pts = parseFloat(pnl_pts.toFixed(2));
  }

  const close_ts = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("signals")
    .update({ status: "closed", close_price, close_ts, pnl_pts, closed_by: closeReason })
    .eq("id", signal_id);

  if (updateErr) {
    log("ERROR", "TRADE_TRACKER", "Failed to close trade", { error: updateErr.message });
    return res.status(500).json({ error: "Failed to close trade" });
  }

  log("INFO", "TRADE_TRACKER", `Trade ${signal_id} closed`, { pnl_pts, closed_by: closeReason });
  res.json({ ok: true, trade: { id: signal_id, pnl_pts, close_price, closed_by: closeReason, close_ts } });
});

// List open trades
app.get("/open-trades", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Trade tracking requires Supabase" });

  const { data, error } = await supabase
    .from("signals")
    .select("id, ts, session, signal, entry, sl, tp, risk_pts, confidence")
    .eq("status", "open")
    .order("ts", { ascending: false });

  if (error) {
    log("ERROR", "TRADE_TRACKER", "Failed to fetch open trades", { error: error.message });
    return res.status(500).json({ error: "Failed to fetch open trades" });
  }

  res.json({ count: data.length, trades: data });
});

// Performance stats for closed trades
app.get("/stats", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Trade tracking requires Supabase" });

  const { data, error } = await supabase
    .from("signals")
    .select("signal, entry, sl, tp, close_price, pnl_pts, closed_by")
    .eq("status", "closed")
    .neq("closed_by", "unknown");

  if (error) {
    log("ERROR", "TRADE_TRACKER", "Failed to fetch stats", { error: error.message });
    return res.status(500).json({ error: "Failed to fetch stats" });
  }

  if (data.length === 0) {
    return res.json({
      total_trades: 0,
      wins: 0,
      losses: 0,
      win_rate: null,
      avg_pnl_pts: null,
      avg_rr: null,
      profit_factor: null,
      by_closed_by: {},
    });
  }

  let wins = 0, losses = 0, totalPnl = 0, totalRR = 0, grossProfit = 0, grossLoss = 0;
  const byClosedBy = {};

  for (const t of data) {
    const pnl = t.pnl_pts ?? 0;
    totalPnl += pnl;

    if (pnl > 0) { wins++; grossProfit += pnl; }
    else { losses++; grossLoss += Math.abs(pnl); }

    // Actual R:R
    if (typeof t.entry === "number" && typeof t.sl === "number") {
      const risk = Math.abs(t.entry - t.sl);
      if (risk > 0) totalRR += pnl / risk;
    }

    const cb = t.closed_by || "unknown";
    byClosedBy[cb] = (byClosedBy[cb] || 0) + 1;
  }

  const total = data.length;
  res.json({
    total_trades: total,
    wins,
    losses,
    win_rate: parseFloat((wins / total * 100).toFixed(1)),
    avg_pnl_pts: parseFloat((totalPnl / total).toFixed(2)),
    avg_rr: parseFloat((totalRR / total).toFixed(2)),
    profit_factor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : 0,
    total_pnl_pts: parseFloat(totalPnl.toFixed(2)),
    by_closed_by: byClosedBy,
  });
});

// ── Adaptive Strategy — session stats ────────────────────────────────────
app.get("/stats/sessions", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Session stats require Supabase" });

  const instrument = (req.query.instrument || "").toUpperCase() || null;
  const days = parseInt(req.query.days || "30", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const selectCols = "session, signal, pnl_pts, closed_by, confidence, risk_pts, entry, sl";
  let query = supabase
    .from("signals")
    .select(selectCols)
    .eq("status", "closed")
    .neq("closed_by", "unknown")
    .gte("close_ts", since.toISOString());

  let { data, error } = await query;
  if (error) return res.status(500).json({ error: "Failed to fetch session stats" });

  const sessions = {};
  for (const t of data) {
    const sess = t.session || "unknown";
    if (!sessions[sess]) sessions[sess] = { trades: 0, wins: 0, losses: 0, pnl: 0, avgRisk: 0, totalRisk: 0 };
    const s = sessions[sess];
    const pnl = t.pnl_pts ?? 0;
    s.trades++;
    s.pnl += pnl;
    s.totalRisk += typeof t.risk_pts === "number" ? t.risk_pts : 0;
    if (pnl > 0) s.wins++;
    else s.losses++;
  }

  const result = {};
  for (const [sess, s] of Object.entries(sessions)) {
    result[sess] = {
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      win_rate: parseFloat((s.wins / s.trades * 100).toFixed(1)),
      total_pnl_pts: parseFloat(s.pnl.toFixed(2)),
      avg_pnl_pts: parseFloat((s.pnl / s.trades).toFixed(2)),
      avg_risk_pts: parseFloat((s.totalRisk / s.trades).toFixed(2)),
    };
  }

  res.json({ period_days: days, instrument: instrument || "all", sessions: result });
});

// ── Adaptive Strategy — parameter analysis ──────────────────────────────
app.get("/stats/parameters", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Parameter stats require Supabase" });

  const instrument = (req.query.instrument || "").toUpperCase() || null;
  const days = parseInt(req.query.days || "30", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);

  let query = supabase
    .from("signals")
    .select("signal, pnl_pts, confidence, risk_pts, entry, sl, tp, close_price, closed_by")
    .eq("status", "closed")
    .neq("closed_by", "unknown")
    .gte("close_ts", since.toISOString());

  let { data, error } = await query;
  if (error) return res.status(500).json({ error: "Failed to fetch parameter stats" });

  if (data.length < 20) {
    return res.json({
      period_days: days,
      instrument: instrument || "all",
      total_trades: data.length,
      message: "Need at least 20 closed trades for meaningful analysis",
    });
  }

  // By confidence level
  const byConfidence = {};
  // By R:R buckets
  const byRR = { "1.5-2.0": { trades: 0, wins: 0, pnl: 0 }, "2.0-2.5": { trades: 0, wins: 0, pnl: 0 }, "2.5-3.0": { trades: 0, wins: 0, pnl: 0 } };
  // By risk size buckets
  const byRisk = { "0-15": { trades: 0, wins: 0, pnl: 0 }, "15-30": { trades: 0, wins: 0, pnl: 0 }, "30-50": { trades: 0, wins: 0, pnl: 0 }, "50+": { trades: 0, wins: 0, pnl: 0 } };
  // By direction
  const byDirection = { LONG: { trades: 0, wins: 0, pnl: 0 }, SHORT: { trades: 0, wins: 0, pnl: 0 } };

  for (const t of data) {
    const pnl = t.pnl_pts ?? 0;
    const isWin = pnl > 0;

    // Confidence
    const conf = (t.confidence || "UNKNOWN").toUpperCase();
    if (!byConfidence[conf]) byConfidence[conf] = { trades: 0, wins: 0, pnl: 0 };
    byConfidence[conf].trades++;
    if (isWin) byConfidence[conf].wins++;
    byConfidence[conf].pnl += pnl;

    // R:R bucket
    if (typeof t.entry === "number" && typeof t.sl === "number" && typeof t.tp === "number") {
      const risk = Math.abs(t.entry - t.sl);
      const reward = Math.abs(t.tp - t.entry);
      if (risk > 0) {
        const rr = reward / risk;
        const bucket = rr < 2.0 ? "1.5-2.0" : rr < 2.5 ? "2.0-2.5" : "2.5-3.0";
        if (byRR[bucket]) {
          byRR[bucket].trades++;
          if (isWin) byRR[bucket].wins++;
          byRR[bucket].pnl += pnl;
        }
      }
    }

    // Risk bucket
    const riskPts = typeof t.risk_pts === "number" ? t.risk_pts : 0;
    const riskBucket = riskPts < 15 ? "0-15" : riskPts < 30 ? "15-30" : riskPts < 50 ? "30-50" : "50+";
    byRisk[riskBucket].trades++;
    if (isWin) byRisk[riskBucket].wins++;
    byRisk[riskBucket].pnl += pnl;

    // Direction
    if (byDirection[t.signal]) {
      byDirection[t.signal].trades++;
      if (isWin) byDirection[t.signal].wins++;
      byDirection[t.signal].pnl += pnl;
    }
  }

  // Format buckets
  const format = (obj) => {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v.trades === 0) continue;
      result[k] = {
        trades: v.trades,
        wins: v.wins,
        win_rate: parseFloat((v.wins / v.trades * 100).toFixed(1)),
        total_pnl_pts: parseFloat(v.pnl.toFixed(2)),
        avg_pnl_pts: parseFloat((v.pnl / v.trades).toFixed(2)),
      };
    }
    return result;
  };

  res.json({
    period_days: days,
    instrument: instrument || "all",
    total_trades: data.length,
    by_confidence: format(byConfidence),
    by_rr_range: format(byRR),
    by_risk_pts: format(byRisk),
    by_direction: format(byDirection),
  });
});

// ── Adaptive Strategy — tuning recommendations ─────────────────────────
app.get("/tune", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Tuning requires Supabase" });

  const instrument = (req.query.instrument || "").toUpperCase() || null;
  const days = parseInt(req.query.days || "30", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);

  let query = supabase
    .from("signals")
    .select("session, signal, pnl_pts, confidence, risk_pts, entry, sl, tp, closed_by")
    .eq("status", "closed")
    .neq("closed_by", "unknown")
    .gte("close_ts", since.toISOString());

  let { data, error } = await query;
  if (error) return res.status(500).json({ error: "Failed to fetch data for tuning" });

  if (data.length < 20) {
    return res.json({
      period_days: days,
      total_trades: data.length,
      message: "Need at least 20 closed trades for tuning recommendations",
      recommendations: [],
    });
  }

  const recommendations = [];

  // 1. Best/worst sessions
  const sessionStats = {};
  for (const t of data) {
    const sess = t.session || "unknown";
    if (!sessionStats[sess]) sessionStats[sess] = { trades: 0, wins: 0, pnl: 0 };
    sessionStats[sess].trades++;
    if ((t.pnl_pts ?? 0) > 0) sessionStats[sess].wins++;
    sessionStats[sess].pnl += t.pnl_pts ?? 0;
  }

  const sessEntries = Object.entries(sessionStats).filter(([, s]) => s.trades >= 5);
  if (sessEntries.length > 1) {
    sessEntries.sort((a, b) => (b[1].pnl / b[1].trades) - (a[1].pnl / a[1].trades));
    const best = sessEntries[0];
    const worst = sessEntries[sessEntries.length - 1];
    if (worst[1].pnl < 0) {
      recommendations.push({
        type: "session",
        action: "consider_disabling",
        session: worst[0],
        reason: `Session ${worst[0]} has negative P&L (${worst[1].pnl.toFixed(2)} pts over ${worst[1].trades} trades)`,
        suggested_env: `# Consider removing ${worst[0]} from session list`,
      });
    }
    recommendations.push({
      type: "session",
      action: "best_performing",
      session: best[0],
      reason: `Session ${best[0]} has best avg P&L (${(best[1].pnl / best[1].trades).toFixed(2)} pts/trade, ${best[1].trades} trades)`,
    });
  }

  // 2. Confidence filter effectiveness
  const confStats = {};
  for (const t of data) {
    const conf = (t.confidence || "UNKNOWN").toUpperCase();
    if (!confStats[conf]) confStats[conf] = { trades: 0, wins: 0, pnl: 0 };
    confStats[conf].trades++;
    if ((t.pnl_pts ?? 0) > 0) confStats[conf].wins++;
    confStats[conf].pnl += t.pnl_pts ?? 0;
  }

  if (confStats.MEDIUM && confStats.MEDIUM.trades >= 5 && confStats.MEDIUM.pnl < 0) {
    recommendations.push({
      type: "confidence",
      action: "tighten_filter",
      reason: `MEDIUM confidence trades have negative P&L (${confStats.MEDIUM.pnl.toFixed(2)} pts) — consider filtering to HIGH only`,
    });
  }

  // 3. Risk sizing
  const avgWinRisk = [];
  const avgLossRisk = [];
  for (const t of data) {
    if (typeof t.risk_pts !== "number") continue;
    if ((t.pnl_pts ?? 0) > 0) avgWinRisk.push(t.risk_pts);
    else avgLossRisk.push(t.risk_pts);
  }

  if (avgWinRisk.length >= 5 && avgLossRisk.length >= 5) {
    const avgW = avgWinRisk.reduce((a, b) => a + b, 0) / avgWinRisk.length;
    const avgL = avgLossRisk.reduce((a, b) => a + b, 0) / avgLossRisk.length;
    if (avgL > avgW * 1.3) {
      recommendations.push({
        type: "risk",
        action: "reduce_max_risk",
        reason: `Losing trades have higher avg risk (${avgL.toFixed(1)} pts) than winners (${avgW.toFixed(1)} pts) — consider lowering max risk`,
        suggested_value: Math.ceil(avgW * 1.2),
      });
    }
  }

  res.json({
    period_days: days,
    instrument: instrument || "all",
    total_trades: data.length,
    recommendations,
    note: "These are suggestions based on historical data. Review before applying.",
  });
});

// ── Weekly Performance Dashboard ──────────────────────────────────────────

async function generateWeeklyReport(weeksBack = 0) {
  if (!supabase) return { error: "Weekly reports require Supabase" };

  // Calculate week boundaries (Mon 00:00 ET to Sun 23:59 ET)
  const todayStr = getETDate(); // "YYYY-MM-DD" string in ET
  const today = new Date(todayStr + "T00:00:00");
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() - mondayOffset + 6 - weeksBack * 7);
  weekEnd.setHours(23, 59, 59, 999);

  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);
  weekStart.setHours(0, 0, 0, 0);

  // Query closed trades for the week
  const { data: trades, error } = await supabase
    .from("signals")
    .select("signal, entry, sl, tp, close_price, pnl_pts, closed_by, ts, close_ts, confidence, session")
    .eq("status", "closed")
    .neq("closed_by", "unknown")
    .gte("close_ts", weekStart.toISOString())
    .lte("close_ts", weekEnd.toISOString())
    .order("close_ts", { ascending: true });

  if (error) {
    log("ERROR", "REPORT", "Failed to fetch weekly trades", { error: error.message });
    return { error: "Failed to fetch weekly data" };
  }

  // Query total signals (including NO_TRADE/skipped) for the week
  const { count: totalSignals } = await supabase
    .from("signals")
    .select("id", { count: "exact", head: true })
    .gte("ts", weekStart.toISOString())
    .lte("ts", weekEnd.toISOString());

  let wins = 0, losses = 0, totalPnl = 0, totalRR = 0;
  let grossProfit = 0, grossLoss = 0;
  const bySession = {};
  const byClosedBy = {};
  let bestTrade = null, worstTrade = null;

  for (const t of trades) {
    const pnl = t.pnl_pts ?? 0;
    totalPnl += pnl;

    if (pnl > 0) { wins++; grossProfit += pnl; }
    else { losses++; grossLoss += Math.abs(pnl); }

    if (typeof t.entry === "number" && typeof t.sl === "number") {
      const risk = Math.abs(t.entry - t.sl);
      if (risk > 0) totalRR += pnl / risk;
    }

    const sess = t.session || "unknown";
    if (!bySession[sess]) bySession[sess] = { trades: 0, pnl: 0, wins: 0 };
    bySession[sess].trades++;
    bySession[sess].pnl += pnl;
    if (pnl > 0) bySession[sess].wins++;

    const cb = t.closed_by || "unknown";
    byClosedBy[cb] = (byClosedBy[cb] || 0) + 1;

    if (!bestTrade || pnl > bestTrade.pnl) bestTrade = { pnl, signal: t.signal, session: sess };
    if (!worstTrade || pnl < worstTrade.pnl) worstTrade = { pnl, signal: t.signal, session: sess };
  }

  const total = trades.length;
  const winRate = total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : null;
  const avgPnl = total > 0 ? parseFloat((totalPnl / total).toFixed(2)) : null;
  const avgRR = total > 0 ? parseFloat((totalRR / total).toFixed(2)) : null;
  const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0);

  const weekLabel = `${weekStart.toISOString().slice(0, 10)} → ${weekEnd.toISOString().slice(0, 10)}`;

  return {
    week: weekLabel,
    week_start: weekStart.toISOString(),
    week_end: weekEnd.toISOString(),
    total_signals: totalSignals || 0,
    total_trades: total,
    wins,
    losses,
    win_rate: winRate,
    total_pnl_pts: parseFloat(totalPnl.toFixed(2)),
    avg_pnl_pts: avgPnl,
    avg_rr: avgRR,
    profit_factor: profitFactor,
    by_session: bySession,
    by_closed_by: byClosedBy,
    best_trade: bestTrade,
    worst_trade: worstTrade,
  };
}

function formatWeeklyReportTelegram(report) {
  if (report.error) return `❌ Report Error: ${report.error}`;

  const targetPts = 20; // approximate 1% weekly target in MNQ points
  const vsTarget = report.total_pnl_pts >= targetPts ? "✅ ON TARGET" : "⚠️ BELOW TARGET";

  let msg =
    `📊 WEEKLY PERFORMANCE — MasterSignal\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 ${report.week}\n\n` +
    `📈 Summary\n` +
    `  Signals generated: ${report.total_signals}\n` +
    `  Trades closed: ${report.total_trades}\n` +
    `  Wins: ${report.wins}  |  Losses: ${report.losses}\n` +
    `  Win rate: ${report.win_rate !== null ? report.win_rate + "%" : "N/A"}\n\n` +
    `💰 P&L\n` +
    `  Total: ${report.total_pnl_pts} pts\n` +
    `  Avg per trade: ${report.avg_pnl_pts ?? "N/A"} pts\n` +
    `  Avg R:R: ${report.avg_rr ?? "N/A"}\n` +
    `  Profit factor: ${report.profit_factor === Infinity ? "∞" : (report.profit_factor ?? "N/A")}\n\n` +
    `🎯 vs 1% Target: ${vsTarget}\n`;

  if (report.best_trade) {
    msg += `\n🏆 Best: ${report.best_trade.pnl > 0 ? "+" : ""}${report.best_trade.pnl} pts (${report.best_trade.signal}, ${report.best_trade.session})`;
  }
  if (report.worst_trade) {
    msg += `\n📉 Worst: ${report.worst_trade.pnl > 0 ? "+" : ""}${report.worst_trade.pnl} pts (${report.worst_trade.signal}, ${report.worst_trade.session})`;
  }

  // Session breakdown
  const sessions = Object.entries(report.by_session);
  if (sessions.length > 0) {
    msg += `\n\n📋 By Session`;
    for (const [sess, data] of sessions) {
      msg += `\n  ${sess}: ${data.trades} trades, ${data.pnl > 0 ? "+" : ""}${parseFloat(data.pnl.toFixed(2))} pts (${data.wins}W)`;
    }
  }

  // Close method breakdown
  const closeMethods = Object.entries(report.by_closed_by);
  if (closeMethods.length > 0) {
    msg += `\n\n🔒 Close Methods`;
    for (const [method, count] of closeMethods) {
      msg += `\n  ${method}: ${count}`;
    }
  }

  return msg;
}

async function sendWeeklyReportTelegram(weeksBack = 0) {
  const report = await generateWeeklyReport(weeksBack);
  if (report.error) {
    log("WARN", "REPORT", "Report generation failed", { error: report.error });
    return { ok: false, error: report.error };
  }

  const msg = formatWeeklyReportTelegram(report);

  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    log("WARN", "REPORT", "Telegram not configured — report generated but not sent");
    return { ok: false, reason: "telegram_not_configured", report };
  }

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map(async (chatId) => {
      const res = await fetchWithTimeout(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: msg }),
        },
        10000
      );
      const data = await res.json();
      if (!data.ok) log("WARN", "REPORT", `Telegram send failed for ${chatId}`, { description: data.description });
      return { chatId, ...data };
    })
  );

  const sent = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  log("INFO", "REPORT", `Weekly report sent to ${sent}/${TELEGRAM_CHAT_IDS.length} users`);
  return { ok: sent > 0, sent, total: TELEGRAM_CHAT_IDS.length, report };
}

// On-demand weekly report endpoint
app.get("/report/weekly", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Weekly reports require Supabase" });

  const weeksBack = parseInt(req.query.weeks_back || "0", 10);
  const sendTg = req.query.send !== "false"; // send Telegram by default

  if (sendTg) {
    const result = await sendWeeklyReportTelegram(weeksBack);
    res.json(result);
  } else {
    const report = await generateWeeklyReport(weeksBack);
    res.json(report);
  }
});

// ── Position Sizing status endpoint ──────────────────────────────────────
app.get("/sizing-status", (req, res) => {
  const inst = (req.query.instrument || DEFAULT_INSTRUMENT).toUpperCase();
  const cfg = getInstrumentConfig(inst);
  if (!cfg) return res.status(400).json({ error: `Unknown instrument: ${inst}` });

  const dailyRisk = resetDailyRiskIfNewDay(inst);
  const usedPct = cfg.dailyLossLimit > 0 ? parseFloat(((dailyRisk.totalRiskPts / cfg.dailyLossLimit) * 100).toFixed(1)) : 0;
  const scaling = usedPct >= APEX_SCALE_THRESHOLD ? "active" : "inactive";

  res.json({
    instrument: inst,
    account_balance: ACCOUNT_BALANCE || null,
    risk_per_trade_pct: RISK_PER_TRADE_PCT,
    apex_scale_threshold_pct: APEX_SCALE_THRESHOLD,
    point_value: cfg.pointValue,
    daily_risk_used_pct: usedPct,
    scaling_status: scaling,
    example_sizing: ACCOUNT_BALANCE > 0 ? {
      at_10pts_risk_HIGH: calculatePositionSize({ risk_pts: 10, confidence: "HIGH" }, inst),
      at_20pts_risk_MEDIUM: calculatePositionSize({ risk_pts: 20, confidence: "MEDIUM" }, inst),
      at_30pts_risk_LOW: calculatePositionSize({ risk_pts: 30, confidence: "LOW" }, inst),
    } : "Set ACCOUNT_BALANCE env var for sizing calculations",
  });
});

// ── Instruments endpoint ──────────────────────────────────────────────────
app.get("/instruments", (req, res) => {
  const result = {};
  for (const [key, cfg] of Object.entries(INSTRUMENTS)) {
    result[key] = {
      name: cfg.name,
      tickSize: cfg.tickSize,
      pointValue: cfg.pointValue,
      maxRiskPts: cfg.maxRiskPts,
      rrRange: cfg.defaultRR,
      maxEntryDistance: cfg.maxEntryDistance,
      sessions: cfg.sessions,
      maxDailySignals: cfg.maxDailySignals,
      dailyLossLimit: cfg.dailyLossLimit,
    };
  }
  res.json({ default: DEFAULT_INSTRUMENT, instruments: result });
});

// ── Health endpoint ────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    status:       "online",
    version:      "v5",
    strategy:     "ICT 1m — OB break + FVG touch, R/R 1:2, volume + MTF",
    instruments:  Object.keys(INSTRUMENTS),
    default_instrument: DEFAULT_INSTRUMENT,
    telegram:     TELEGRAM_BOT_TOKEN ? `configured (${TELEGRAM_CHAT_IDS.length} users)` : "not_configured",
    webhook_auth: WEBHOOK_SECRET ? "enabled" : "disabled",
    journal:      supabase ? "supabase (persistent)" : `jsonl: ${JOURNAL_PATH} (ephemeral)`,
    news_filter:  NEWS_FILTER_ENABLED ? `${NEWS_SUPPRESS_MODE} (±${NEWS_SUPPRESS_WINDOW_MIN}min)` : "disabled",
    notify_no_trade: NOTIFY_NO_TRADE,
    uptime_s:     Math.floor(process.uptime()),
    last_error:   lastError,
  })
);

// ── Risk status endpoint (per-instrument) ────────────────────────────────
app.get("/risk-status", (req, res) => {
  const requestedInstrument = req.query.instrument;

  if (requestedInstrument) {
    // Single instrument view
    const inst = requestedInstrument.toUpperCase();
    const cfg = getInstrumentConfig(inst);
    if (!cfg) return res.status(400).json({ error: `Unknown instrument: ${inst}` });
    const dailyRisk = resetDailyRiskIfNewDay(inst);
    return res.json({
      instrument: inst,
      date: dailyRisk.date,
      signals_today: dailyRisk.signalCount,
      max_daily_signals: cfg.maxDailySignals,
      total_risk_pts: dailyRisk.totalRiskPts,
      daily_loss_limit_pts: cfg.dailyLossLimit,
      halted: dailyRisk.halted,
      remaining_signals: Math.max(0, cfg.maxDailySignals - dailyRisk.signalCount),
      remaining_risk_pts: Math.max(0, cfg.dailyLossLimit - dailyRisk.totalRiskPts),
      signals: dailyRisk.signals,
    });
  }

  // All instruments overview
  const byInstrument = {};
  for (const inst of Object.keys(INSTRUMENTS)) {
    const dailyRisk = resetDailyRiskIfNewDay(inst);
    const cfg = INSTRUMENTS[inst];
    byInstrument[inst] = {
      date: dailyRisk.date,
      signals_today: dailyRisk.signalCount,
      max_daily_signals: cfg.maxDailySignals,
      total_risk_pts: dailyRisk.totalRiskPts,
      daily_loss_limit_pts: cfg.dailyLossLimit,
      halted: dailyRisk.halted,
      remaining_signals: Math.max(0, cfg.maxDailySignals - dailyRisk.signalCount),
      remaining_risk_pts: Math.max(0, cfg.dailyLossLimit - dailyRisk.totalRiskPts),
    };
  }
  res.json({ instruments: byInstrument });
});

// ── News filter status endpoint ───────────────────────────────────────────
app.get("/news-status", async (req, res) => {
  const events = NEWS_FILTER_ENABLED ? await fetchEconomicCalendar() : [];
  const check = checkNewsFilter(events);
  res.json({
    enabled: NEWS_FILTER_ENABLED,
    mode: NEWS_SUPPRESS_MODE,
    window_min: NEWS_SUPPRESS_WINDOW_MIN,
    cached_date: newsCache.date,
    events_today: events.map(e => ({
      title: e.title,
      time: e.time instanceof Date ? e.time.toISOString() : e.time,
      currency: e.currency,
      impact: e.impact,
    })),
    currently_blocked: check.blocked,
    blocking_event: check.blocked ? check.detail : null,
  });
});

// ── Journal viewer (últimos N sinais) ─────────────────────────────────────
app.get("/journal", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

  // Try Supabase first
  if (supabase) {
    const { data, error, count } = await supabase
      .from("signals")
      .select("*", { count: "exact" })
      .order("ts", { ascending: false })
      .limit(limit);

    if (!error) {
      return res.json({
        source: "supabase",
        total: count,
        showing: data.length,
        entries: data.reverse(), // chronological order (oldest first)
      });
    }
    log("WARN", "JOURNAL", "Supabase query failed — falling back to JSONL", { error: error.message });
  }

  // Fallback: read from local JSONL
  let fd;
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return res.json({ source: "jsonl", entries: [] });

    const stat = fs.statSync(JOURNAL_PATH);
    const MAX_READ = 1024 * 1024;
    const readSize = Math.min(stat.size, MAX_READ);
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(JOURNAL_PATH, "r");
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    fd = undefined;

    const lines = buf.toString("utf8").trim().split("\n").filter(Boolean);
    const entries = lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ source: "jsonl", total: stat.size < MAX_READ ? lines.length : "~" + lines.length, showing: entries.length, entries });
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    res.status(500).json({ error: "Erro ao ler journal" });
  }
});

// ── Operational health alert helper ────────────────────────────────────────
async function sendHealthAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) return;
  await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map((chatId) =>
      fetchWithTimeout(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
        10000
      ).catch(() => {})
    )
  );
}

// ── Arranque + graceful shutdown ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, () => {
  log("INFO", "STARTUP", `Server v5 running on port ${PORT}`, { instruments: Object.keys(INSTRUMENTS) });
  sendHealthAlert(
    `✅ Server online — MasterSignal Server v5\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🔌 Port: ${PORT}\n` +
    `📊 Instruments: ${Object.keys(INSTRUMENTS).join(", ")}\n` +
    `📦 Journal: ${supabase ? "Supabase (persistent)" : "JSONL (ephemeral)"}\n` +
    `🕐 ${new Date().toISOString()}`
  );
});

// ── Crash handlers — alert via Telegram before dying ──────────────────────
process.on("uncaughtException", async (err) => {
  lastError = { message: err.message, stack: err.stack, ts: new Date().toISOString() };
  log("FATAL", "PROCESS", "uncaughtException", { error: err.message, stack: err.stack });
  await sendHealthAlert(
    `🔴 CRASH — MasterSignal Server\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💥 uncaughtException\n` +
    `❌ ${err.message}\n` +
    `🕐 ${new Date().toISOString()}`
  ).catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  lastError = { message: msg, ts: new Date().toISOString() };
  log("FATAL", "PROCESS", "unhandledRejection", { error: msg });
  await sendHealthAlert(
    `🟠 UNHANDLED REJECTION — MasterSignal Server\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `⚠️ ${msg}\n` +
    `🕐 ${new Date().toISOString()}`
  ).catch(() => {});
  process.exit(1);
});

function gracefulShutdown(signal) {
  log("INFO", "SHUTDOWN", `${signal} recebido — a encerrar...`);
  server.close(() => process.exit(0));
  setTimeout(() => {
    log("WARN", "SHUTDOWN", "Forçando encerramento após timeout");
    process.exit(1);
  }, 10000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
