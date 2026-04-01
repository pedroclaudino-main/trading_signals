const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

// ── Validação de variáveis de ambiente ao arrancar ─────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(id => id.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // shared secret para autenticar webhooks

if (!ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY não definida. Servidor não pode arrancar.");
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
  console.warn("WARN: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos — alertas Telegram desativados.");
}

const app = express();

// ── CORS restrito + body size limit ────────────────────────────────────────
app.use(cors({ origin: ["https://www.tradingview.com", "https://tradingview.com"] }));
app.use(express.json({ limit: "10kb" }));

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── ICT Strategy prompt (alinhado com lógica real do Pine Script) ──────────
const STRATEGY_PROMPT = `És um analista expert em ICT (Inner Circle Trader) scalping para CME_MINI:MNQ (Micro E-mini Nasdaq-100).

REGRAS EXACTAS DA ESTRATÉGIA — segue com precisão:

1. TIMEFRAME: Toda a análise de estrutura é feita no gráfico de 1 MINUTO.

2. JANELAS DE TRADING (hora de Lisboa WET/WEST):
   - 14:45–15:15 | 15:45–16:15 | 16:45–17:15
   - Fora destas janelas → NO_TRADE imediatamente.

3. DEFINIÇÃO DE BIAS — OB BREAK:
   - Um OB bullish é quebrado quando o preço fecha ACIMA do OB high com momentum → bias bullish.
   - Um OB bearish é quebrado quando o preço fecha ABAIXO do OB low com momentum → bias bearish.
   - O OB quebrado define o bias direcional para a sessão.
   - O momentum é medido por: vela de break > 1.5× o range do OB.

4. ENTRY TRIGGER — FVG TOUCH:
   - Após o bias ser estabelecido pelo OB quebrado, esperar que o preço TOQUE um Fair Value Gap (FVG) alinhado com essa direção.
   - Bias bullish → apenas FVGs bullish → entrada LONG no limite inferior (bottom) do FVG.
   - Bias bearish → apenas FVGs bearish → entrada SHORT no limite superior (top) do FVG.
   - O FVG expira após 20 barras sem toque.
   - Apenas um sinal por FVG (após toque, FVG é invalidado).

5. STOP LOSS:
   - Swing LOW mais recente no 1m (para longs) ou swing HIGH (para shorts), confirmado com lookback de 5 barras.
   - Arredondado ao tick de 0.25 pts (tamanho mínimo do MNQ).

6. TAKE PROFIT — R/R fixo 1:2:
   - LONG:  TP = Entry + (Entry - SL) × 2
   - SHORT: TP = Entry - (SL - Entry) × 2
   - TP único, sem trailing.

7. Condições NO_TRADE:
   - Fora das janelas de trading
   - Sem OB break claro no 1m
   - FVG não alinhado com a direção do OB quebrado
   - Risco > 60 pontos
   - Estrutura ambígua ou conflituante

DADOS RECEBIDOS:
- "candles_1m": array das últimas 3 velas de 1m [{ o, h, l, c }]
- "broken_ob": o OB que foi quebrado { type:"bullish"|"bearish", high, low }
- "fvgs": FVGs detetados [{ type:"bullish"|"bearish", top, bottom, after_ob_break:true }]
- "swings": swing points recentes [{ type:"high"|"low", price }]
- "session": janela ativa ("14:45"|"15:45"|"16:45")
- "current_price": preço atual
- "suggested_entry": entry pré-calculado pelo indicador (limite do FVG, arredondado a 0.25)
- "suggested_sl": SL pré-calculado (swing point, arredondado a 0.25)
- "tp": TP pré-calculado (R/R 1:2)
- "risk_pts": risco em pontos

TAREFA: Valida o setup com base nas regras acima. Podes usar os valores pré-calculados (suggested_entry, suggested_sl, tp) como referência ou ajustar se encontrares erro na lógica. Responde APENAS com JSON válido. Sem markdown, sem comentários.

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
  "no_trade_reason": "string se NO_TRADE, senão null"
}`;

// ── Telegram sender (envia para todos os chat IDs configurados) ────────────
async function sendTelegram(signal) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    console.warn("Telegram desativado — credenciais não configuradas.");
    return { ok: false, reason: "telegram_not_configured" };
  }

  const dir = signal.signal === "LONG" ? "▲ LONG" : "▼ SHORT";
  const emoji = signal.signal === "LONG" ? "🟢" : "🔴";
  const confKey = (signal.confidence || "").toUpperCase();
  const conf = { HIGH: "🔥 Alta", MEDIUM: "⚡ Média", LOW: "⚠️ Baixa" }[confKey] || "❓ Desconhecida";
  const risk = typeof signal.risk_pts === "number" ? `${signal.risk_pts.toFixed(2)} pts` : "—";

  const msg =
    `${emoji} TRADE ALERT — MNQ\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📌 CME_MINI:MNQ\n` +
    `Direção: ${dir}\n` +
    `Confiança: ${conf}\n\n` +
    `🎯 Entry:  ${typeof signal.entry === "number" ? signal.entry.toFixed(2) : "—"}\n` +
    `✅ TP:     ${typeof signal.tp === "number" ? signal.tp.toFixed(2) : "—"}\n` +
    `❌ SL:     ${typeof signal.sl === "number" ? signal.sl.toFixed(2) : "—"}\n\n` +
    `📊 R/R: 1:2  |  Risco: ${risk}\n` +
    `🔍 OB partido: ${signal.broken_ob_direction || "—"}  |  FVG: ${signal.fvg_touched || "—"}\n\n` +
    `💬 ${signal.reason || "Sem razão fornecida"}`;

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map(async (chatId) => {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: msg }),
        }
      );
      const data = await res.json();
      if (!data.ok) console.warn(`[TELEGRAM] Falhou para ${chatId}: ${data.description}`);
      return { chatId, ...data };
    })
  );

  const sent = results.filter(r => r.status === "fulfilled" && r.value.ok).length;
  console.log(`[TELEGRAM] Enviado para ${sent}/${TELEGRAM_CHAT_IDS.length} utilizadores`);
  return { ok: sent > 0, sent, total: TELEGRAM_CHAT_IDS.length, details: results.map(r => r.value || r.reason?.message) };
}

// ── Validação do signal retornado pelo Claude ──────────────────────────────
function validateSignal(signal) {
  const validSignals = ["LONG", "SHORT", "NO_TRADE"];
  if (!signal || !validSignals.includes(signal.signal)) {
    return { valid: false, reason: `signal inválido: ${signal?.signal}` };
  }
  if (signal.signal !== "NO_TRADE") {
    if (typeof signal.entry !== "number" || typeof signal.sl !== "number" || typeof signal.tp !== "number") {
      return { valid: false, reason: `${signal.signal} sem entry/sl/tp numéricos` };
    }
  }
  return { valid: true };
}

// ── Webhook endpoint ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Autenticação via shared secret
  if (WEBHOOK_SECRET) {
    const provided = req.headers["x-webhook-secret"] || req.body?.webhook_secret;
    if (provided !== WEBHOOK_SECRET) {
      console.warn("Webhook rejeitado — secret inválido.");
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const {
    candles_1m,       // últimas 3 velas 1m: [{ o, h, l, c }]
    broken_ob,        // OB quebrado: { type:"bullish"|"bearish", high, low }
    fvgs,             // FVGs detetados: [{ type, top, bottom, after_ob_break }]
    swings,           // swing points: [{ type:"high"|"low", price }]
    session,          // "14:45" | "15:45" | "16:45"
    current_price,    // preço atual
    suggested_entry,  // entry pré-calculado pelo Pine
    suggested_sl,     // SL pré-calculado pelo Pine
    tp,               // TP pré-calculado pelo Pine
    risk_pts,         // risco em pontos
  } = req.body;

  // Validação básica de campos obrigatórios
  if (!session || typeof current_price !== "number") {
    return res.status(400).json({ error: "session e current_price são obrigatórios" });
  }

  const validSessions = ["14:45", "15:45", "16:45"];
  if (!validSessions.includes(session)) {
    return res.status(400).json({ error: `session inválida: ${session}` });
  }

  if (!Array.isArray(candles_1m) || candles_1m.length < 1) {
    return res.status(400).json({ error: "candles_1m deve ser um array com pelo menos 1 vela" });
  }

  console.log(`[WEBHOOK] Sessão ${session} | Preço ${current_price} | OB: ${broken_ob?.type || "none"}`);

  try {
    const payload = JSON.stringify({
      candles_1m, broken_ob, fvgs, swings, session, current_price,
      suggested_entry, suggested_sl, tp, risk_pts,
    });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: STRATEGY_PROMPT,
      messages: [{ role: "user", content: `Analisa estes dados de mercado 1m e retorna o signal:\n${payload}` }],
    }, { timeout: 15000 });

    const raw = message.content[0].text.trim();
    console.log(`[CLAUDE] Resposta: ${raw.substring(0, 200)}`);

    let signal;
    try {
      signal = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      signal = match
        ? JSON.parse(match[0])
        : { signal: "NO_TRADE", reason: "Erro ao processar resposta do AI", no_trade_reason: "parse error" };
    }

    // Validar signal do Claude
    const validation = validateSignal(signal);
    if (!validation.valid) {
      console.warn(`[VALIDAÇÃO] Signal inválido: ${validation.reason}`);
      signal = {
        signal: "NO_TRADE",
        reason: `Signal rejeitado: ${validation.reason}`,
        entry: null, sl: null, tp: null, risk_pts: null,
        rr: null, broken_ob_direction: "NONE", fvg_touched: "NONE",
        confidence: "LOW", no_trade_reason: validation.reason,
      };
    }

    // Telegram — isolado para não afetar a resposta ao cliente
    let telegramResult = null;
    if (signal.signal !== "NO_TRADE") {
      try {
        telegramResult = await sendTelegram(signal);
        console.log(`[TELEGRAM] Enviado: ${telegramResult?.ok ? "OK" : "FALHOU"}`);
      } catch (telegramErr) {
        console.error(`[TELEGRAM] Erro: ${telegramErr.message}`);
        telegramResult = { ok: false, error: "telegram_send_failed" };
      }
    }

    res.json({ ok: true, signal, telegram: telegramResult });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    // Não expor detalhes internos ao cliente
    res.status(500).json({ error: "Erro interno ao processar signal" });
  }
});

// ── Health endpoint ────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    status: "online",
    strategy: "ICT 1m — OB break + FVG touch, R/R 1:2",
    telegram: TELEGRAM_BOT_TOKEN ? `configured (${TELEGRAM_CHAT_IDS.length} users)` : "not_configured",
    webhook_auth: WEBHOOK_SECRET ? "enabled" : "disabled",
  })
);

// ── Arranque + graceful shutdown ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.on("SIGTERM", () => {
  console.log("SIGTERM recebido — a encerrar servidor...");
  server.close(() => process.exit(0));
});
