const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const fs        = require("fs");
const path      = require("path");

// ── Variáveis de ambiente ───────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS  = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const NOTIFY_NO_TRADE    = (process.env.NOTIFY_NO_TRADE || "false") === "true";
const JOURNAL_PATH       = process.env.JOURNAL_PATH || "./trade_journal.jsonl";

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

// ── Journal — grava cada sinal num ficheiro JSONL (async) ──────────────────
function journalSignal(payload, signal, telegramResult) {
  const entry = {
    ts: new Date().toISOString(),
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
  fs.appendFile(JOURNAL_PATH, JSON.stringify(entry) + "\n", (err) => {
    if (err) log("WARN", "JOURNAL", "Erro ao gravar journal", { error: err.message });
  });
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
const STRATEGY_PROMPT = `És um analista expert em ICT (Inner Circle Trader) scalping para CME_MINI:MNQ.

O sinal que recebes já foi validado mecanicamente pelo indicador Pine Script:
- OB break com displacement confirmado
- FVG touch após o break
- Rejeição na vela de toque (close saiu do FVG)
- Volume acima da média no break e no toque
- MTF alinhado em todos os timeframes

O TEU PAPEL é fazer análise contextual que o código não consegue:

1. COERÊNCIA DO SETUP:
   - Os valores de entry/sl/tp fazem sentido face ao current_price?
   - O OB e o FVG são coerentes (FVG dentro da zona esperada após o OB)?
   - O risco em pontos é razoável para o movimento observado?

2. QUALIDADE:
   - As 3 velas mostram momentum real ou hesitação?
   - O spread entre OB e FVG sugere força institucional ou micro-movimento?
   - O risco vs a distância entry-OB sugere SL apertado demais ou largo demais?

3. MTF CONTEXT:
   - Os dados MTF estão todos alinhados? Se algum está NEUTRAL ou apenas TREND (sem FVG+OB), reduzir confiança.
   - mtf.1d e mtf.4h são os mais importantes — se não estão BULL/BEAR, confiança = LOW.

4. CONDIÇÕES PARA REJEIÇÃO (NO_TRADE):
   - Entry muito longe do current_price (> 10 pontos de diferença)
   - Risco > 50 pontos (setup largo demais para scalping)
   - MTF com 2+ timeframes NEUTRAL
   - Velas mostram indecisão (dojis, corpos < 30% do range)

DADOS:
- "candles_1m": últimas 3 velas [{ o, h, l, c, v }]
- "broken_ob": { type, high, low }
- "fvgs": [{ type, top, bottom, after_ob_break }]
- "swings": [{ type, price }]
- "mtf": { "1d", "4h", "1h", "15m", "5m" } — cada um "BULL"/"BEAR"/"NEUTRAL"/"BULL_OK"/"BEAR_OK"/"BULL_TREND"/"BEAR_TREND"
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
  "broken_ob_direction": "BULLISH" | "BEARISH" | "NONE",
  "fvg_touched": "BULLISH" | "BEARISH" | "NONE",
  "mtf_aligned": true | false,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "no_trade_reason": "string se NO_TRADE, senão null"
}`;

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(signal, isNoTrade = false) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    log("WARN", "TELEGRAM", "Telegram desativado — credenciais não configuradas");
    return { ok: false, reason: "telegram_not_configured" };
  }

  let msg;
  if (isNoTrade) {
    msg =
      `⚪ NO TRADE — MNQ\n` +
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
      `${emoji} TRADE ALERT — MNQ\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `Direção: ${dir}\n` +
      `Confiança: ${conf}\n\n` +
      `🎯 Entry:  ${typeof signal.entry  === "number" ? signal.entry.toFixed(2)  : "—"}\n` +
      `✅ TP:     ${typeof signal.tp     === "number" ? signal.tp.toFixed(2)     : "—"}\n` +
      `❌ SL:     ${typeof signal.sl     === "number" ? signal.sl.toFixed(2)     : "—"}\n\n` +
      `📊 R/R: 1:2  |  Risco: ${risk}\n` +
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

// ── Validação do signal — MELHORADA ───────────────────────────────────────
function validateSignal(signal, payload) {
  if (!signal || !["LONG", "SHORT", "NO_TRADE"].includes(signal.signal))
    return { valid: false, reason: `signal inválido: ${signal?.signal}` };

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

    // R:R sanity — deve estar entre 1.5 e 3.0 (target 2.0)
    const risk   = Math.abs(signal.entry - signal.sl);
    const reward = Math.abs(signal.tp - signal.entry);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr < 1.5 || rr > 3.0)
        return { valid: false, reason: `R:R fora do range: ${rr.toFixed(2)} (esperado 1.5-3.0)` };
    }

    // Risk em pontos não deve exceder 60
    if (typeof signal.risk_pts === "number" && signal.risk_pts > 60)
      return { valid: false, reason: `Risco ${signal.risk_pts.toFixed(1)} pts > 60 max` };

    // Entry deve estar perto do current_price (dentro de 20 pontos)
    if (typeof payload.current_price === "number") {
      const diff = Math.abs(signal.entry - payload.current_price);
      if (diff > 20)
        return { valid: false, reason: `Entry ${diff.toFixed(1)} pts longe do preço atual` };
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
  } = req.body;

  // 3. Validação de campos obrigatórios
  if (!session || typeof current_price !== "number")
    return res.status(400).json({ error: "session e current_price são obrigatórios" });

  if (!["14:45", "15:45", "16:45"].includes(session))
    return res.status(400).json({ error: `session inválida: ${session}` });

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

  try {
    const payload = JSON.stringify({
      candles_1m, broken_ob, fvgs, swings, mtf,
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

    const validation = validateSignal(signal, req.body);
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

    let telegramResult = null;
    if (signal.signal !== "NO_TRADE") {
      try {
        telegramResult = await sendTelegram(signal);
      } catch (err) {
        log("ERROR", "TELEGRAM", "Erro ao enviar trade alert", { error: err.message });
        telegramResult = { ok: false, error: "telegram_send_failed" };
      }
    } else if (NOTIFY_NO_TRADE) {
      // Notificação opcional de NO_TRADE para debugging
      try {
        signal.session = session; // attach session for the message
        telegramResult = await sendTelegram(signal, true);
      } catch (err) {
        log("WARN", "TELEGRAM", "Erro ao enviar NO_TRADE notification", { error: err.message });
      }
    }

    // Journal — grava todos os sinais (trade e no_trade)
    journalSignal(req.body, signal, telegramResult);

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
    version:      "v3",
    strategy:     "ICT 1m — OB break + FVG touch, R/R 1:2, volume + MTF",
    telegram:     TELEGRAM_BOT_TOKEN ? `configured (${TELEGRAM_CHAT_IDS.length} users)` : "not_configured",
    webhook_auth: WEBHOOK_SECRET ? "enabled" : "disabled",
    journal:      JOURNAL_PATH,
    notify_no_trade: NOTIFY_NO_TRADE,
    uptime_s:     Math.floor(process.uptime()),
  })
);

// ── Journal viewer (últimos N sinais — leitura parcial para ficheiros grandes)
app.get("/journal", (req, res) => {
  let fd;
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    if (!fs.existsSync(JOURNAL_PATH)) return res.json({ entries: [] });

    const stat = fs.statSync(JOURNAL_PATH);
    // Para ficheiros pequenos (<1MB), ler tudo; para grandes, ler só o final
    const MAX_READ = 1024 * 1024; // 1MB
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
    res.json({ total: stat.size < MAX_READ ? lines.length : "~" + lines.length, showing: entries.length, entries });
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    res.status(500).json({ error: "Erro ao ler journal" });
  }
});

// ── Arranque + graceful shutdown ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, () =>
  log("INFO", "STARTUP", `Server v3 running on port ${PORT}`)
);

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
