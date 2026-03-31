const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── ICT Strategy prompt ────────────────────────────────────────────────────
const STRATEGY_PROMPT = `You are an expert ICT (Inner Circle Trader) scalping analyst for CME_MINI:MNQH2026 (Micro E-mini Nasdaq-100).

EXACT STRATEGY RULES — follow precisely:

1. TIMEFRAME: All structure analysis is done on the 1 MINUTE chart only.

2. TRADING WINDOWS (Lisbon time WET/WEST):
   - 14:45–15:15 | 15:45–16:15 | 16:45–17:15
   - Outside these windows → NO_TRADE immediately.

3. BIAS DEFINITION — OB BREAK:
   - A bullish OB is broken when price trades ABOVE the OB high with momentum → bullish bias.
   - A bearish OB is broken when price trades BELOW the OB low with momentum → bearish bias.
   - The broken OB defines the directional bias for the session.

4. ENTRY TRIGGER — FVG TOUCH:
   - After bias is established by the broken OB, wait for price to TOUCH (not necessarily close inside) a Fair Value Gap (FVG) aligned with that broken OB direction.
   - Bullish bias → only bullish FVGs → LONG entry.
   - Bearish bias → only bearish FVGs → SHORT entry.
   - Entry is at MARKET PRICE the moment price touches the FVG edge.
   - The FVG must have been created AFTER the OB break.

5. STOP LOSS:
   - Most recent swing LOW on 1m (for longs) or swing HIGH (for shorts) prior to entry.
   - Use the exact wick extreme of that swing.

6. TAKE PROFIT — FIXED R/R 1:2:
   - LONG:  TP = Entry + (Entry - SL) × 2
   - SHORT: TP = Entry - (SL - Entry) × 2
   - Single TP only.

7. NO_TRADE conditions:
   - Outside trading windows
   - No clear OB break on 1m
   - FVG not aligned with broken OB direction
   - FVG was created before the OB break
   - Risk > 60 points
   - Ambiguous or conflicting structure

Respond ONLY with valid JSON. No markdown, no commentary.

{
  "signal": "LONG" | "SHORT" | "NO_TRADE",
  "reason": "explicação breve em português (max 140 chars)",
  "entry": number | null,
  "sl": number | null,
  "tp": number | null,
  "risk_pts": number | null,
  "rr": 2.0,
  "broken_ob_direction": "BULLISH" | "BEARISH" | "NONE",
  "fvg_touched": "BULLISH" | "BEARISH" | "NONE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "no_trade_reason": "string if NO_TRADE, else null"
}`;

// ── Telegram sender ────────────────────────────────────────────────────────
async function sendTelegram(botToken, chatId, signal) {
  const dir   = signal.signal === "LONG" ? "▲ LONG" : "▼ SHORT";
  const emoji = signal.signal === "LONG" ? "🟢" : "🔴";
  const conf  = { HIGH: "🔥 Alta", MEDIUM: "⚡ Média", LOW: "⚠️ Baixa" }[signal.confidence] || "";
  const risk  = signal.risk_pts ? `${signal.risk_pts.toFixed(2)} pts` : "—";

  const msg =
    `${emoji} TRADE ALERT — MNQ\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📌 CME_MINI:MNQH2026\n` +
    `Direção: ${dir}\n` +
    `Confiança: ${conf}\n\n` +
    `🎯 Entry:  ${signal.entry?.toFixed(2) ?? "—"}\n` +
    `✅ TP:     ${signal.tp?.toFixed(2) ?? "—"}\n` +
    `❌ SL:     ${signal.sl?.toFixed(2) ?? "—"}\n\n` +
    `📊 R/R: 1:2  |  Risco: ${risk}\n` +
    `🔍 OB partido: ${signal.broken_ob_direction}  |  FVG: ${signal.fvg_touched}\n\n` +
    `💬 ${signal.reason}`;

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    }
  );
  return res.json();
}

// ── Webhook endpoint ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const {
    bot_token,
    chat_id,
    candles,       // recent 1m candles: [{ o, h, l, c, time }]
    order_blocks,  // detected OBs: [{ type:"bullish"|"bearish", high, low, broken:bool }]
    fvgs,          // detected FVGs: [{ type:"bullish"|"bearish", top, bottom, after_ob_break:bool }]
    swing_points,  // recent swings: [{ type:"high"|"low", price, time }]
    broken_ob,     // the OB that was just broken: { type, high, low } | null
    session,       // "14:45" | "15:45" | "16:45"
    current_price,
  } = req.body;

  if (!bot_token || !chat_id) {
    return res.status(400).json({ error: "bot_token and chat_id required" });
  }

  try {
    const payload = JSON.stringify({
      candles, order_blocks, fvgs, swing_points, broken_ob, session, current_price,
    });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: STRATEGY_PROMPT,
      messages: [{ role: "user", content: `Analyze this 1m market data and return the trade signal:\n${payload}` }],
    });

    const raw = message.content[0].text.trim();
    let signal;
    try {
      signal = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      signal = match
        ? JSON.parse(match[0])
        : { signal: "NO_TRADE", reason: "Erro ao processar resposta do AI", no_trade_reason: "parse error" };
    }

    let telegramResult = null;
    if (signal.signal !== "NO_TRADE") {
      telegramResult = await sendTelegram(bot_token, chat_id, signal);
    }

    res.json({ ok: true, signal, telegram: telegramResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) =>
  res.json({ status: "MNQ Trade Server online", strategy: "ICT 1m — OB break + FVG touch, R/R 1:2" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
