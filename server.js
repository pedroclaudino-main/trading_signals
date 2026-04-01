const express   = require("express");
const cors      = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

// ── Variáveis de ambiente ───────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS  = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;

if (!ANTHROPIC_API_KEY) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "FATAL", msg: "ANTHROPIC_API_KEY não definida" }));
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
  log("WARN", "STARTUP", "TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos — alertas Telegram desativados");
}

// ── Logging estruturado ────────────────────────────────────────────────────
function log(level, component, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, component, msg, ...extra };
  (level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log)(JSON.stringify(entry));
}

// ── Rate Limiting (sem dependências externas) ──────────────────────────────
// 10 req/min por IP. Protege contra replay attacks e custos descontrolados.
const rateStore = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT  = 10;
const RATE_WINDOW = 60 * 1000; // 1 minuto

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = rateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Limpeza periódica do rateStore (evita memory leak em sessões longas)
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateStore.entries()) {
    if (now > e.resetAt) rateStore.delete(ip);
  }
}, 5 * 60 * 1000);

// ── Deduplicação de payloads ───────────────────────────────────────────────
// TradingView pode reenviar o mesmo webhook em caso de timeout/retry.
// Um hash leve do payload (session + price + entry) previne processar 2x.
const dedupStore = new Map(); // hash -> timestamp
const DEDUP_TTL  = 5 * 60 * 1000; // 5 minutos

function hashPayload(body) {
  const key = `${body.session}|${body.current_price}|${body.suggested_entry}|${body.suggested_sl}`;
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

// ── Validação estrutural de candle OHLC ───────────────────────────────────
function isValidCandle(c) {
  return c !== null && typeof c === "object"
    && typeof c.o === "number" && typeof c.h === "number"
    && typeof c.l === "number" && typeof c.c === "number"
    && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c)
    && c.h >= c.l
    && c.h >= c.o && c.h >= c.c
    && c.l <= c.o && c.l <= c.c;
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "DENY");
  res.setHeader("X-XSS-Protection",        "1; mode=block");
  res.setHeader("Referrer-Policy",         "no-referrer");
  next();
});

// CORS: apenas necessário para o health endpoint (browser).
// Webhooks TradingView são server-to-server, CORS não os afeta.
app.use(cors({ origin: ["https://www.tradingview.com", "https://tradingview.com"] }));
app.use(express.json({ limit: "10kb" }));

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── ICT Strategy prompt ────────────────────────────────────────────────────
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
   - O momentum é medido por: vela de break > 1.5× o range do OB e corpo >= 60% do range (deslocamento).

4. ENTRY TRIGGER — FVG TOUCH:
   - Após o bias ser estabelecido pelo OB quebrado, esperar que o preço TOQUE um Fair Value Gap (FVG) alinhado com essa direção.
   - O FVG deve ter sido formado APÓS o OB break (não antes).
   - Bias bullish → apenas FVGs bullish → entrada LONG no limite inferior (bottom) do FVG.
   - Bias bearish → apenas FVGs bearish → entrada SHORT no limite superior (top) do FVG.
   - O FVG expira após 20 barras sem toque.
   - Apenas um sinal por FVG (após toque, FVG é invalidado).
   - A vela de toque deve FECHAR na direção do bias (confirmação de rejeição).

5. STOP LOSS:
   - Swing LOW mais recente no 1m (para longs) ou swing HIGH (para shorts), confirmado com lookback de 5 barras.
   - Arredondado ao tick de 0.25 pts (tamanho mínimo do MNQ).

6. TAKE PROFIT — R/R fixo 1:2:
   - LONG:  TP = Entry + (Entry - SL) × 2
   - SHORT: TP = Entry - (SL - Entry) × 2
   - TP único, sem trailing.

7. Condições NO_TRADE:
   - Fora das janelas de trading
   - Sem OB break claro no 1m com deslocamento
   - FVG anterior ao OB break
   - FVG não alinhado com a direção do OB quebrado
   - Vela de toque não fecha na direção do bias
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

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(signal) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    log("WARN", "TELEGRAM", "Telegram desativado — credenciais não configuradas");
    return { ok: false, reason: "telegram_not_configured" };
  }

  const dir      = signal.signal === "LONG" ? "▲ LONG" : "▼ SHORT";
  const emoji    = signal.signal === "LONG" ? "🟢" : "🔴";
  const confKey  = (signal.confidence || "").toUpperCase();
  const conf     = { HIGH: "🔥 Alta", MEDIUM: "⚡ Média", LOW: "⚠️ Baixa" }[confKey] || "❓ Desconhecida";
  const risk     = typeof signal.risk_pts === "number" ? `${signal.risk_pts.toFixed(2)} pts` : "—";

  const msg =
    `${emoji} TRADE ALERT — MNQ\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📌 CME_MINI:MNQ\n` +
    `Direção: ${dir}\n` +
    `Confiança: ${conf}\n\n` +
    `🎯 Entry:  ${typeof signal.entry  === "number" ? signal.entry.toFixed(2)  : "—"}\n` +
    `✅ TP:     ${typeof signal.tp     === "number" ? signal.tp.toFixed(2)     : "—"}\n` +
    `❌ SL:     ${typeof signal.sl     === "number" ? signal.sl.toFixed(2)     : "—"}\n\n` +
    `📊 R/R: 1:2  |  Risco: ${risk}\n` +
    `🔍 OB partido: ${signal.broken_ob_direction || "—"}  |  FVG: ${signal.fvg_touched || "—"}\n\n` +
    `💬 ${signal.reason || "Sem razão fornecida"}`;

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map(async (chatId) => {
      const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ chat_id: chatId, text: msg }),
      });
      const data = await res.json();
      if (!data.ok) log("WARN", "TELEGRAM", `Falhou para ${chatId}`, { description: data.description });
      return { chatId, ...data };
    })
  );

  const sent = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
  log("INFO", "TELEGRAM", `Enviado para ${sent}/${TELEGRAM_CHAT_IDS.length} utilizadores`);
  return { ok: sent > 0, sent, total: TELEGRAM_CHAT_IDS.length };
}

// ── Validação do signal retornado pelo Claude ──────────────────────────────
function validateSignal(signal) {
  if (!signal || !["LONG", "SHORT", "NO_TRADE"].includes(signal.signal))
    return { valid: false, reason: `signal inválido: ${signal?.signal}` };

  if (signal.signal !== "NO_TRADE") {
    if (typeof signal.entry !== "number" || typeof signal.sl !== "number" || typeof signal.tp !== "number")
      return { valid: false, reason: `${signal.signal} sem entry/sl/tp numéricos` };

    // Sanity check: SL do lado correto
    if (signal.signal === "LONG"  && signal.sl >= signal.entry)
      return { valid: false, reason: "LONG com SL >= entry" };
    if (signal.signal === "SHORT" && signal.sl <= signal.entry)
      return { valid: false, reason: "SHORT com SL <= entry" };
  }
  return { valid: true };
}

// ── Webhook endpoint ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {

  // 1. Rate limiting
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    log("WARN", "WEBHOOK", "Rate limit excedido", { ip: clientIp });
    return res.status(429).json({ error: "rate_limit_exceeded" });
  }

  // 2. Autenticação via shared secret
  if (WEBHOOK_SECRET) {
    const provided = req.headers["x-webhook-secret"] || req.body?.webhook_secret;
    if (provided !== WEBHOOK_SECRET) {
      log("WARN", "WEBHOOK", "Secret inválido rejeitado", { ip: clientIp });
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const {
    candles_1m, broken_ob, fvgs, swings,
    session, current_price, suggested_entry, suggested_sl, tp, risk_pts,
  } = req.body;

  // 3. Validação de campos obrigatórios
  if (!session || typeof current_price !== "number")
    return res.status(400).json({ error: "session e current_price são obrigatórios" });

  if (!["14:45", "15:45", "16:45"].includes(session))
    return res.status(400).json({ error: `session inválida: ${session}` });

  if (!Array.isArray(candles_1m) || candles_1m.length < 1)
    return res.status(400).json({ error: "candles_1m deve ser array com >= 1 vela" });

  // 4. Validação estrutural dos candles (nova)
  const invalidCandle = candles_1m.find(c => !isValidCandle(c));
  if (invalidCandle)
    return res.status(400).json({ error: "candle inválido: OHLC inconsistente", candle: invalidCandle });

  // 5. Deduplicação (nova) — previne processar o mesmo sinal 2×
  const payloadHash = hashPayload(req.body);
  if (isDuplicate(payloadHash)) {
    log("WARN", "WEBHOOK", "Payload duplicado ignorado", { hash: payloadHash, session });
    return res.status(200).json({ ok: true, signal: null, duplicate: true });
  }

  log("INFO", "WEBHOOK", "Sinal recebido", { session, price: current_price, ob: broken_ob?.type || "none", ip: clientIp });

  try {
    const payload = JSON.stringify({
      candles_1m, broken_ob, fvgs, swings,
      session, current_price, suggested_entry, suggested_sl, tp, risk_pts,
    });

    const message = await anthropic.messages.create({
      model:    "claude-sonnet-4-6",
      max_tokens: 600,
      system:   STRATEGY_PROMPT,
      messages: [{ role: "user", content: `Analisa estes dados de mercado 1m e retorna o signal:\n${payload}` }],
    }, { timeout: 15000 });

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

    const validation = validateSignal(signal);
    if (!validation.valid) {
      log("WARN", "VALIDAÇÃO", "Signal rejeitado", { reason: validation.reason });
      signal = {
        signal: "NO_TRADE", reason: `Signal rejeitado: ${validation.reason}`,
        entry: null, sl: null, tp: null, risk_pts: null,
        rr: null, broken_ob_direction: "NONE", fvg_touched: "NONE",
        confidence: "LOW", no_trade_reason: validation.reason,
      };
    }

    let telegramResult = null;
    if (signal.signal !== "NO_TRADE") {
      try {
        telegramResult = await sendTelegram(signal);
      } catch (err) {
        log("ERROR", "TELEGRAM", "Erro ao enviar", { error: err.message });
        telegramResult = { ok: false, error: "telegram_send_failed" };
      }
    }

    res.json({ ok: true, signal, telegram: telegramResult });

  } catch (err) {
    log("ERROR", "WEBHOOK", "Erro interno", { error: err.message });
    res.status(500).json({ error: "Erro interno ao processar signal" });
  }
});

// ── Health endpoint ────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    status:       "online",
    strategy:     "ICT 1m — OB break + FVG touch, R/R 1:2",
    telegram:     TELEGRAM_BOT_TOKEN ? `configured (${TELEGRAM_CHAT_IDS.length} users)` : "not_configured",
    webhook_auth: WEBHOOK_SECRET ? "enabled" : "disabled",
    uptime_s:     Math.floor(process.uptime()),
  })
);

// ── Arranque + graceful shutdown ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, () =>
  log("INFO", "STARTUP", `Server running on port ${PORT}`)
);

process.on("SIGTERM", () => {
  log("INFO", "SHUTDOWN", "SIGTERM recebido — a encerrar...");
  server.close(() => process.exit(0));
});
