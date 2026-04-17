#!/usr/bin/env node
/**
 * MasterSignal v4 — Automated Backtest Engine
 *
 * Reimplements the Pine Script strategy logic in Node.js.
 * Accepts 1-minute OHLCV CSV data (TradingView export format).
 *
 * Usage:
 *   node backtest.js <csv-file> [options]
 *   npm run backtest -- <csv-file> [options]
 *
 * Options:
 *   --instrument MNQ|MES|NQ|ES   (default: MNQ)
 *   --capital 100000              (default: 100000)
 *   --contracts 1                 (default: 1)
 *   --max-risk 50                 (default: 50 pts)
 *   --max-daily 4                 (default: 4 trades/day)
 *   --max-session 2              (default: 2 signals/session)
 *   --commission 0.62            (default: $0.62/contract round-trip)
 *   --slippage 0.25              (default: 1 tick = 0.25 pts)
 *   --json                        Output JSON instead of text
 *
 * CSV format (TradingView export):
 *   time,open,high,low,close,volume
 *   2026-01-02T14:30:00,21000.25,21005.50,...
 */

const fs = require("fs");
const path = require("path");

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
let csvFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] || "true";
    i++;
  } else if (!csvFile) {
    csvFile = args[i];
  }
}

if (!csvFile) {
  console.error("Usage: node backtest.js <csv-file> [--instrument MNQ] [--capital 100000] [--json]");
  console.error("\nCSV must have columns: time, open, high, low, close, volume");
  console.error("Export from TradingView: Chart → Export Chart Data");
  process.exit(1);
}

const CONFIG = {
  instrument:   (flags.instrument || "MNQ").toUpperCase(),
  capital:      parseFloat(flags.capital || "100000"),
  contracts:    parseInt(flags.contracts || "1", 10),
  maxRiskPts:   parseFloat(flags["max-risk"] || "50"),
  maxDaily:     parseInt(flags["max-daily"] || "4", 10),
  maxSession:   parseInt(flags["max-session"] || "2", 10),
  commission:   parseFloat(flags.commission || "0.62"),
  slippage:     parseFloat(flags.slippage || "0.25"),
  outputJson:   flags.json === "true" || flags.json === true,
  // Strategy params (matching Pine defaults)
  swingLookback:  3,
  atrLen:         14,
  momPullback:    40.0,
  momOverbought:  60.0,
  momLookback:    5,
  mtfEmaLen:      20,
  maxSwingAge:    80,
};

// Instrument tick sizes for rounding
const TICK_SIZE = { MNQ: 0.25, MES: 0.25, NQ: 0.25, ES: 0.25 };
const POINT_VALUE = { MNQ: 0.50, MES: 1.25, NQ: 5.00, ES: 12.50 };

function roundTick(x) {
  const ts = TICK_SIZE[CONFIG.instrument] || 0.25;
  return Math.round(x / ts) * ts;
}

// ── Parse CSV ───────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const lines = raw.split("\n");
  const header = lines[0].toLowerCase().replace(/\r/g, "");
  const cols = header.split(",").map(c => c.trim());

  const timeIdx = cols.findIndex(c => c === "time" || c === "date" || c === "datetime" || c === "timestamp");
  const openIdx = cols.findIndex(c => c === "open" || c === "o");
  const highIdx = cols.findIndex(c => c === "high" || c === "h");
  const lowIdx  = cols.findIndex(c => c === "low" || c === "l");
  const closeIdx = cols.findIndex(c => c === "close" || c === "c");
  const volIdx  = cols.findIndex(c => c === "volume" || c === "vol" || c === "v");

  if (timeIdx < 0 || openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
    console.error("CSV must have columns: time/date, open, high, low, close. Got:", cols.join(", "));
    process.exit(1);
  }

  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].replace(/\r/g, "").split(",");
    if (row.length < 5) continue;
    const time = new Date(row[timeIdx].trim());
    if (isNaN(time.getTime())) continue;
    bars.push({
      time,
      o: parseFloat(row[openIdx]),
      h: parseFloat(row[highIdx]),
      l: parseFloat(row[lowIdx]),
      c: parseFloat(row[closeIdx]),
      v: volIdx >= 0 ? parseFloat(row[volIdx]) || 0 : 0,
    });
  }

  bars.sort((a, b) => a.time - b.time);
  return bars;
}

// ── Session detection (14:30-17:30 Europe/Lisbon = ET-adjusted) ─────────
function getSessionInfo(time) {
  // Convert to Lisbon time
  const lisbon = new Date(time.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const h = lisbon.getHours();
  const m = lisbon.getMinutes();
  const totalMin = h * 60 + m;

  const inSession = totalMin >= 870 && totalMin < 1050; // 14:30-17:30
  let sessionLabel = "N/A";
  if (totalMin >= 870 && totalMin < 930) sessionLabel = "14:30";
  else if (totalMin >= 930 && totalMin < 990) sessionLabel = "15:30";
  else if (totalMin >= 990 && totalMin < 1050) sessionLabel = "16:30";

  const dateStr = `${lisbon.getFullYear()}-${String(lisbon.getMonth()+1).padStart(2,"0")}-${String(lisbon.getDate()).padStart(2,"0")}`;
  return { inSession, sessionLabel, dateStr };
}

// ── Technical Indicators ────────────────────────────────────────────────────
function calcSMA(data, period, idx) {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += data[i].c;
  return sum / period;
}

function calcEMA(values, period) {
  const ema = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let started = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    if (!started) { ema[i] = values[i]; started = true; }
    else ema[i] = values[i] * k + ema[i-1] * (1 - k);
  }
  return ema;
}

function calcATR(data, period) {
  const atr = new Array(data.length).fill(null);
  for (let i = 1; i < data.length; i++) {
    const tr = Math.max(
      data[i].h - data[i].l,
      Math.abs(data[i].h - data[i-1].c),
      Math.abs(data[i].l - data[i-1].c)
    );
    if (i < period) {
      // Simple average for initial period
      let sum = tr;
      for (let j = Math.max(1, i - period + 1); j < i; j++) {
        sum += Math.max(data[j].h - data[j].l, Math.abs(data[j].h - data[j-1].c), Math.abs(data[j].l - data[j-1].c));
      }
      atr[i] = sum / Math.min(i, period);
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

// Momentum oscillator (blackcat1402 weighted price)
function calcMomentum(data) {
  const wp = data.map(b => (2.0 * b.c + b.h + b.l + b.o) / 5.0);
  const mom = new Array(data.length).fill(50);

  for (let i = 0; i < data.length; i++) {
    const hiStart = Math.max(0, i - 24);
    const loStart = Math.max(0, i - 10);
    let wpHigh = -Infinity, wpLow = Infinity;
    for (let j = hiStart; j <= i; j++) wpHigh = Math.max(wpHigh, wp[j]);
    for (let j = loStart; j <= i; j++) wpLow = Math.min(wpLow, wp[j]);
    mom[i] = wpHigh !== wpLow ? ((wp[i] - wpLow) / (wpHigh - wpLow)) * 100 : 50;
  }

  // EMA smoothing (period 5)
  return calcEMA(mom, 5);
}

// Pivot highs/lows (swing detection)
function findSwings(data, lookback) {
  const swingHighs = new Array(data.length).fill(null);
  const swingLows = new Array(data.length).fill(null);

  for (let i = lookback; i < data.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i].h < data[i-j].h || data[i].h < data[i+j].h) isHigh = false;
      if (data[i].l > data[i-j].l || data[i].l > data[i+j].l) isLow = false;
    }
    if (isHigh) swingHighs[i] = data[i].h;
    if (isLow) swingLows[i] = data[i].l;
  }

  return { swingHighs, swingLows };
}

// Daily EMA for MTF filter (aggregate bars to daily)
function calcDailyEMA(data, emaLen) {
  // Group bars by date, get daily close
  const dailyMap = new Map();
  for (const bar of data) {
    const ds = bar.time.toISOString().slice(0, 10);
    dailyMap.set(ds, bar.c);
  }
  const dates = [...dailyMap.keys()].sort();
  const closes = dates.map(d => dailyMap.get(d));
  const ema = calcEMA(closes, emaLen);

  // Map back: for each date, is close > ema?
  const dailyBull = new Map();
  const dailyBear = new Map();
  for (let i = 0; i < dates.length; i++) {
    if (ema[i] === null) continue;
    dailyBull.set(dates[i], closes[i] > ema[i]);
    dailyBear.set(dates[i], closes[i] < ema[i]);
  }
  return { dailyBull, dailyBear };
}

// ── Backtest Engine ─────────────────────────────────────────────────────────
function runBacktest(bars) {
  const momentum = calcMomentum(bars);
  const { swingHighs, swingLows } = findSwings(bars, CONFIG.swingLookback);
  const { dailyBull, dailyBear } = calcDailyEMA(bars, CONFIG.mtfEmaLen);

  // Track last known swing points
  let lastSwingHigh = null, lastSwingLow = null;
  let swingHighBarIdx = null, swingLowBarIdx = null;

  // State
  let dailyTrades = 0;
  let signalsThisSession = 0;
  let prevInSession = false;
  let prevDate = null;

  // Position tracking
  let position = null; // { direction, entry, sl, tp, contracts, bar, session, date }
  const trades = [];

  // Equity tracking
  let equity = CONFIG.capital;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [];

  for (let i = Math.max(25, CONFIG.swingLookback + 1); i < bars.length; i++) {
    const bar = bars[i];
    const { inSession, sessionLabel, dateStr } = getSessionInfo(bar.time);

    // New day reset
    if (dateStr !== prevDate) {
      dailyTrades = 0;
      prevDate = dateStr;
    }

    // Session start reset
    if (inSession && !prevInSession) {
      signalsThisSession = 0;
    }

    // End of session: close open position
    if (!inSession && prevInSession && position) {
      const pnl = position.direction === "LONG"
        ? (bar.c - position.entry)
        : (position.entry - bar.c);
      const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
      equity += dollarPnl;
      trades.push({
        ...position,
        exit: bar.c,
        exitTime: bar.time,
        pnl_pts: parseFloat(pnl.toFixed(2)),
        pnl_dollars: parseFloat(dollarPnl.toFixed(2)),
        closedBy: "session_end",
        barsHeld: i - position.barIdx,
      });
      position = null;
    }

    prevInSession = inSession;

    // Check if open position hits TP or SL
    if (position) {
      let closed = false;
      if (position.direction === "LONG") {
        if (bar.l <= position.sl - CONFIG.slippage) {
          // SL hit
          const exitPrice = position.sl - CONFIG.slippage;
          const pnl = exitPrice - position.entry;
          const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
          equity += dollarPnl;
          trades.push({ ...position, exit: exitPrice, exitTime: bar.time, pnl_pts: parseFloat(pnl.toFixed(2)), pnl_dollars: parseFloat(dollarPnl.toFixed(2)), closedBy: "sl", barsHeld: i - position.barIdx });
          position = null; closed = true;
        } else if (bar.h >= position.tp) {
          const exitPrice = position.tp;
          const pnl = exitPrice - position.entry;
          const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
          equity += dollarPnl;
          trades.push({ ...position, exit: exitPrice, exitTime: bar.time, pnl_pts: parseFloat(pnl.toFixed(2)), pnl_dollars: parseFloat(dollarPnl.toFixed(2)), closedBy: "tp", barsHeld: i - position.barIdx });
          position = null; closed = true;
        }
      } else { // SHORT
        if (bar.h >= position.sl + CONFIG.slippage) {
          const exitPrice = position.sl + CONFIG.slippage;
          const pnl = position.entry - exitPrice;
          const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
          equity += dollarPnl;
          trades.push({ ...position, exit: exitPrice, exitTime: bar.time, pnl_pts: parseFloat(pnl.toFixed(2)), pnl_dollars: parseFloat(dollarPnl.toFixed(2)), closedBy: "sl", barsHeld: i - position.barIdx });
          position = null; closed = true;
        } else if (bar.l <= position.tp) {
          const exitPrice = position.tp;
          const pnl = position.entry - exitPrice;
          const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
          equity += dollarPnl;
          trades.push({ ...position, exit: exitPrice, exitTime: bar.time, pnl_pts: parseFloat(pnl.toFixed(2)), pnl_dollars: parseFloat(dollarPnl.toFixed(2)), closedBy: "tp", barsHeld: i - position.barIdx });
          position = null; closed = true;
        }
      }
    }

    // Track equity
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity - equity;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    equityCurve.push({ time: bar.time, equity });

    // Skip signal generation if not in session or already have a position
    if (!inSession || position) continue;

    // Update swing points
    // Swings are detected with lookback offset, so check at i - lookback
    const swIdx = i - CONFIG.swingLookback;
    if (swIdx >= 0 && swingHighs[swIdx] !== null) {
      lastSwingHigh = swingHighs[swIdx];
      swingHighBarIdx = swIdx;
    }
    if (swIdx >= 0 && swingLows[swIdx] !== null) {
      lastSwingLow = swingLows[swIdx];
      swingLowBarIdx = swIdx;
    }

    // Expire old swings
    if (swingHighBarIdx !== null && (i - swingHighBarIdx) > CONFIG.maxSwingAge) lastSwingHigh = null;
    if (swingLowBarIdx !== null && (i - swingLowBarIdx) > CONFIG.maxSwingAge) lastSwingLow = null;

    // SMA trend
    const sma3 = calcSMA(bars, 3, i);
    const sma10 = calcSMA(bars, 10, i);
    const sma20 = calcSMA(bars, 20, i);
    if (!sma3 || !sma10 || !sma20) continue;

    const instBullish = sma3 > sma10 && sma10 > sma20;
    const instBearish = sma3 < sma10 && sma10 < sma20;

    // Momentum conditions
    const mom = momentum[i];
    if (mom === null) continue;

    // Check momentum was low/high in lookback window
    let momWasLow = false, momWasHigh = false;
    for (let j = Math.max(0, i - CONFIG.momLookback); j <= i; j++) {
      if (momentum[j] !== null && momentum[j] < CONFIG.momPullback) momWasLow = true;
      if (momentum[j] !== null && momentum[j] > CONFIG.momOverbought) momWasHigh = true;
    }

    // Momentum rising/falling
    const momRising = i >= 2 && momentum[i] > momentum[i-1] && momentum[i] > momentum[i-2];
    const momFalling = i >= 2 && momentum[i] < momentum[i-1] && momentum[i] < momentum[i-2];

    // MTF filter (daily EMA)
    const dayStr = bar.time.toISOString().slice(0, 10);
    const mtfBullOK = dailyBull.get(dayStr) !== false; // default true if no data
    const mtfBearOK = dailyBear.get(dayStr) !== false;

    // Candle direction
    const bullishCandle = bar.c > bar.o;
    const bearishCandle = bar.c < bar.o;

    // Signal generation
    let longSignal = instBullish && momWasLow && momRising && bullishCandle && lastSwingLow !== null && mtfBullOK;
    let shortSignal = instBearish && momWasHigh && momFalling && bearishCandle && lastSwingHigh !== null && mtfBearOK;

    // Conflict resolution
    if (longSignal && shortSignal) { longSignal = false; shortSignal = false; }

    // Session signal cap
    if (longSignal && signalsThisSession >= CONFIG.maxSession) longSignal = false;
    if (shortSignal && signalsThisSession >= CONFIG.maxSession) shortSignal = false;

    // Daily trade cap
    const canTrade = dailyTrades < CONFIG.maxDaily;
    if (!canTrade) { longSignal = false; shortSignal = false; }

    if (longSignal) {
      const entry = roundTick(bar.c + CONFIG.slippage);
      const sl = roundTick(lastSwingLow);
      const risk = entry - sl;
      const tp = roundTick(entry + risk * 2.0);

      if (risk > 0 && risk <= CONFIG.maxRiskPts) {
        position = {
          direction: "LONG", entry, sl, tp,
          contracts: CONFIG.contracts,
          entryTime: bar.time, session: sessionLabel, date: dateStr,
          risk_pts: parseFloat(risk.toFixed(2)),
          barIdx: i,
        };
        signalsThisSession++;
        dailyTrades++;
      }
    }

    if (!position && shortSignal) {
      const entry = roundTick(bar.c - CONFIG.slippage);
      const sl = roundTick(lastSwingHigh);
      const risk = sl - entry;
      const tp = roundTick(entry - risk * 2.0);

      if (risk > 0 && risk <= CONFIG.maxRiskPts) {
        position = {
          direction: "SHORT", entry, sl, tp,
          contracts: CONFIG.contracts,
          entryTime: bar.time, session: sessionLabel, date: dateStr,
          risk_pts: parseFloat(risk.toFixed(2)),
          barIdx: i,
        };
        signalsThisSession++;
        dailyTrades++;
      }
    }
  }

  // Close any remaining position at last bar
  if (position && bars.length > 0) {
    const lastBar = bars[bars.length - 1];
    const pnl = position.direction === "LONG"
      ? (lastBar.c - position.entry)
      : (position.entry - lastBar.c);
    const dollarPnl = pnl * (POINT_VALUE[CONFIG.instrument] || 0.5) * CONFIG.contracts - CONFIG.commission;
    equity += dollarPnl;
    trades.push({
      ...position, exit: lastBar.c, exitTime: lastBar.time,
      pnl_pts: parseFloat(pnl.toFixed(2)), pnl_dollars: parseFloat(dollarPnl.toFixed(2)),
      closedBy: "end_of_data", barsHeld: bars.length - 1 - position.barIdx,
    });
  }

  return { trades, equity, maxDrawdown, equityCurve };
}

// ── Report Generation ───────────────────────────────────────────────────────
function generateReport(result, bars) {
  const { trades, equity, maxDrawdown } = result;
  const total = trades.length;

  if (total === 0) {
    return {
      summary: "No trades generated. Check if CSV data covers the correct session times (14:30-17:30 Europe/Lisbon).",
      trades: [],
    };
  }

  const wins = trades.filter(t => t.pnl_pts > 0);
  const losses = trades.filter(t => t.pnl_pts <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl_dollars, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_dollars, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl_dollars, 0);
  const totalPnlPts = trades.reduce((s, t) => s + t.pnl_pts, 0);

  // Consecutive losses
  let maxConsecLoss = 0, consecLoss = 0;
  for (const t of trades) {
    if (t.pnl_pts <= 0) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }

  // By session
  const bySession = {};
  for (const t of trades) {
    if (!bySession[t.session]) bySession[t.session] = { trades: 0, wins: 0, pnl: 0, pnlPts: 0 };
    bySession[t.session].trades++;
    if (t.pnl_pts > 0) bySession[t.session].wins++;
    bySession[t.session].pnl += t.pnl_dollars;
    bySession[t.session].pnlPts += t.pnl_pts;
  }

  // By close method
  const byClose = {};
  for (const t of trades) {
    byClose[t.closedBy] = (byClose[t.closedBy] || 0) + 1;
  }

  // By direction
  const longs = trades.filter(t => t.direction === "LONG");
  const shorts = trades.filter(t => t.direction === "SHORT");

  // Average bars held
  const avgBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0) / total;

  // Weekly P&L
  const weeklyPnl = {};
  for (const t of trades) {
    const d = new Date(t.exitTime || t.entryTime);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay() + 1);
    const weekKey = weekStart.toISOString().slice(0, 10);
    weeklyPnl[weekKey] = (weeklyPnl[weekKey] || 0) + t.pnl_dollars;
  }

  const dateRange = `${bars[0].time.toISOString().slice(0, 10)} → ${bars[bars.length-1].time.toISOString().slice(0, 10)}`;

  const report = {
    instrument: CONFIG.instrument,
    period: dateRange,
    bars_analyzed: bars.length,
    initial_capital: CONFIG.capital,
    final_equity: parseFloat(equity.toFixed(2)),
    net_profit: parseFloat(totalPnl.toFixed(2)),
    net_profit_pct: parseFloat(((equity - CONFIG.capital) / CONFIG.capital * 100).toFixed(2)),
    total_pnl_pts: parseFloat(totalPnlPts.toFixed(2)),
    total_trades: total,
    wins: wins.length,
    losses: losses.length,
    win_rate: parseFloat((wins.length / total * 100).toFixed(1)),
    avg_win_pts: wins.length > 0 ? parseFloat((wins.reduce((s, t) => s + t.pnl_pts, 0) / wins.length).toFixed(2)) : 0,
    avg_loss_pts: losses.length > 0 ? parseFloat((losses.reduce((s, t) => s + t.pnl_pts, 0) / losses.length).toFixed(2)) : 0,
    avg_win_dollars: wins.length > 0 ? parseFloat((grossProfit / wins.length).toFixed(2)) : 0,
    avg_loss_dollars: losses.length > 0 ? parseFloat((-grossLoss / losses.length).toFixed(2)) : 0,
    profit_factor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0),
    max_drawdown: parseFloat(maxDrawdown.toFixed(2)),
    max_drawdown_pct: parseFloat((maxDrawdown / CONFIG.capital * 100).toFixed(2)),
    max_consecutive_losses: maxConsecLoss,
    avg_bars_held: parseFloat(avgBarsHeld.toFixed(1)),
    commission_per_trade: CONFIG.commission,
    slippage_pts: CONFIG.slippage,
    by_direction: {
      LONG: { trades: longs.length, wins: longs.filter(t => t.pnl_pts > 0).length, pnl: parseFloat(longs.reduce((s, t) => s + t.pnl_dollars, 0).toFixed(2)) },
      SHORT: { trades: shorts.length, wins: shorts.filter(t => t.pnl_pts > 0).length, pnl: parseFloat(shorts.reduce((s, t) => s + t.pnl_dollars, 0).toFixed(2)) },
    },
    by_session: Object.fromEntries(
      Object.entries(bySession).map(([k, v]) => [k, {
        trades: v.trades,
        wins: v.wins,
        win_rate: parseFloat((v.wins / v.trades * 100).toFixed(1)),
        pnl: parseFloat(v.pnl.toFixed(2)),
        pnl_pts: parseFloat(v.pnlPts.toFixed(2)),
      }])
    ),
    by_close_method: byClose,
    weekly_pnl: Object.fromEntries(
      Object.entries(weeklyPnl).map(([k, v]) => [k, parseFloat(v.toFixed(2))])
    ),
    // Apex compliance check
    apex_compliance: {
      max_daily_loss_ok: maxDrawdown < CONFIG.capital * 0.03, // 3% max daily
      trailing_drawdown_ok: maxDrawdown < CONFIG.capital * 0.06, // 6% trailing
      profit_target_1pct_weekly: Object.values(weeklyPnl).filter(v => v >= CONFIG.capital * 0.01).length,
      total_weeks: Object.keys(weeklyPnl).length,
    },
  };

  return report;
}

function formatTextReport(report) {
  if (report.summary) return report.summary;

  let out = "";
  out += `\n${"═".repeat(60)}\n`;
  out += `  MASTERSIGNAL v4 BACKTEST REPORT\n`;
  out += `${"═".repeat(60)}\n`;
  out += `  Instrument: ${report.instrument}\n`;
  out += `  Period: ${report.period}\n`;
  out += `  Bars analyzed: ${report.bars_analyzed.toLocaleString()}\n`;
  out += `  Config: ${CONFIG.contracts} contract(s), $${CONFIG.commission} commission, ${CONFIG.slippage} tick slippage\n`;
  out += `${"─".repeat(60)}\n`;
  out += `\n  PERFORMANCE SUMMARY\n`;
  out += `  ${"─".repeat(40)}\n`;
  out += `  Initial Capital:    $${report.initial_capital.toLocaleString()}\n`;
  out += `  Final Equity:       $${report.final_equity.toLocaleString()}\n`;
  out += `  Net Profit:         $${report.net_profit.toLocaleString()} (${report.net_profit_pct}%)\n`;
  out += `  Net Profit (pts):   ${report.total_pnl_pts} pts\n`;
  out += `\n  TRADE STATISTICS\n`;
  out += `  ${"─".repeat(40)}\n`;
  out += `  Total Trades:       ${report.total_trades}\n`;
  out += `  Wins:               ${report.wins} (${report.win_rate}%)\n`;
  out += `  Losses:             ${report.losses}\n`;
  out += `  Avg Win:            ${report.avg_win_pts} pts ($${report.avg_win_dollars})\n`;
  out += `  Avg Loss:           ${report.avg_loss_pts} pts ($${report.avg_loss_dollars})\n`;
  out += `  Profit Factor:      ${report.profit_factor}\n`;
  out += `  Max Drawdown:       $${report.max_drawdown.toLocaleString()} (${report.max_drawdown_pct}%)\n`;
  out += `  Max Consec Losses:  ${report.max_consecutive_losses}\n`;
  out += `  Avg Bars Held:      ${report.avg_bars_held}\n`;

  out += `\n  BY DIRECTION\n`;
  out += `  ${"─".repeat(40)}\n`;
  for (const [dir, d] of Object.entries(report.by_direction)) {
    const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : "0";
    out += `  ${dir.padEnd(8)} ${String(d.trades).padStart(4)} trades  ${String(d.wins).padStart(3)} wins (${wr}%)  $${d.pnl.toFixed(2)}\n`;
  }

  out += `\n  BY SESSION\n`;
  out += `  ${"─".repeat(40)}\n`;
  for (const [sess, s] of Object.entries(report.by_session)) {
    out += `  ${sess.padEnd(8)} ${String(s.trades).padStart(4)} trades  ${s.win_rate}% WR  ${s.pnl_pts} pts  $${s.pnl.toFixed(2)}\n`;
  }

  out += `\n  BY CLOSE METHOD\n`;
  out += `  ${"─".repeat(40)}\n`;
  for (const [method, count] of Object.entries(report.by_close_method)) {
    out += `  ${method.padEnd(15)} ${count}\n`;
  }

  out += `\n  WEEKLY P&L\n`;
  out += `  ${"─".repeat(40)}\n`;
  for (const [week, pnl] of Object.entries(report.weekly_pnl)) {
    const bar = pnl >= 0 ? "█".repeat(Math.min(20, Math.floor(pnl / 10))) : "░".repeat(Math.min(20, Math.floor(Math.abs(pnl) / 10)));
    out += `  ${week}  ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2).padStart(10)}  ${bar}\n`;
  }

  out += `\n  APEX COMPLIANCE\n`;
  out += `  ${"─".repeat(40)}\n`;
  const ac = report.apex_compliance;
  out += `  Max Daily Loss (<3%):    ${ac.max_daily_loss_ok ? "PASS" : "FAIL"}\n`;
  out += `  Trailing Drawdown (<6%): ${ac.trailing_drawdown_ok ? "PASS" : "FAIL"}\n`;
  out += `  Weeks >= 1% target:      ${ac.profit_target_1pct_weekly} / ${ac.total_weeks}\n`;
  out += `\n${"═".repeat(60)}\n`;

  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log(`Loading ${csvFile}...`);
const bars = parseCSV(csvFile);
console.log(`Parsed ${bars.length} bars (${bars[0]?.time.toISOString().slice(0,10)} → ${bars[bars.length-1]?.time.toISOString().slice(0,10)})`);
console.log(`Running backtest: ${CONFIG.instrument}, $${CONFIG.capital} capital, ${CONFIG.contracts} contracts...\n`);

const result = runBacktest(bars);
const report = generateReport(result, bars);

if (CONFIG.outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatTextReport(report));
}

// Save JSON report to file
const reportPath = path.join(path.dirname(csvFile), `backtest_report_${CONFIG.instrument}_${new Date().toISOString().slice(0,10)}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nJSON report saved to: ${reportPath}`);
