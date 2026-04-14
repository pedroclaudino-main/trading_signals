# MasterSignal v4 — Setup Guide

Sistema completo de alertas ICT para CME_MINI:MNQ com análise contextual por Claude AI.

---

## O que mudou na v3

### Pine Script (master_signal.pine / backtest)
- **MTF corrigido**: trend agora usa close do timeframe correto (não close 1m)
- **MTF OB com momentum**: OBs nos HTFs verificam força da vela (não apenas cor)
- **MTF FVG limitado**: apenas 3 barras lookback (não 5+)
- **Filtro de volume**: OB break e FVG touch exigem volume > SMA20 × 1.2
- **Rejeição forte**: close deve SAIR do FVG (não apenas fechar bullish/bearish)
- **Historial de 2 OBs**: guarda primary + secondary (não perde OBs relevantes)
- **Limite por sessão**: max 1 sinal por janela (configurável)
- **FVG min absoluto**: 2 pontos mínimo além do filtro × ATR
- **Swing lookback**: default 3 (mais reativo para scalping)
- **Payload com MTF**: envia estado de cada TF ao servidor
- **Payload com volume**: cada candle inclui volume

### Backtest
- **process_orders_on_close=false**: fills mais realistas
- **Win counting corrigido**: deteta novos trades fechados corretamente
- **Max trades diários**: controlo de risco intraday (default: 3)
- **Profit Factor**: nova métrica na tabela de stats

### Server (server.js)
- **Claude com novo papel**: análise contextual (não re-validação redundante)
- **Recebe dados MTF**: pode verificar alinhamento real
- **Retry com backoff**: 2 retries na API do Claude
- **Telegram com timeout**: 10s timeout em cada envio
- **Validação melhorada**: verifica TP, R:R, proximidade ao preço, risk max
- **Journal automático**: cada signal gravado em trade_journal.jsonl
- **NO_TRADE notifications**: opção para receber alertas de rejeição
- **Endpoint /journal**: consultar histórico via HTTP

---

## Arquitetura

TradingView (Pine Script v3) → Webhook Server (Railway) → Claude AI (contexto) → Telegram (iPhone)

---

## PASSO 1 — Deploy no Railway.app

1. Cria conta em https://railway.app
2. "New Project" → "Deploy from GitHub"
3. Variáveis de ambiente:
   - `ANTHROPIC_API_KEY` — obrigatório
   - `TELEGRAM_BOT_TOKEN` — obrigatório
   - `TELEGRAM_CHAT_ID` — obrigatório (pode ser múltiplos: `id1,id2`)
   - `WEBHOOK_SECRET` — recomendado
   - `NOTIFY_NO_TRADE` — `true` para debug, `false` em produção
4. Railway dá URL pública: `https://xxx.up.railway.app`

---

## PASSO 2 — Telegram Bot

1. @BotFather → `/newbot` → copia Bot Token
2. @userinfobot → copia Chat ID
3. Abre o bot → Start

---

## PASSO 3 — Pine Script no TradingView

1. Chart do MNQ → Pine Editor → cola `master_signal.pine`
2. Edita WEBHOOK_URL e WEBHOOK_SECRET
3. Add to chart (timeframe 1 minuto)
4. Cria Alert → Webhook URL → expiration open-ended

---

## PASSO 4 — Verificar journal

```bash
# Últimos 20 sinais
curl https://SEU-PROJETO.railway.app/journal?limit=20

# Health check
curl https://SEU-PROJETO.railway.app/
```

---

## Weekly Performance Reports

Automated P&L reports delivered via Telegram. Reports include trade count, win rate, total P&L, profit factor, session breakdown, best/worst trades, and comparison against the 1% weekly return target.

```bash
# Generate + send current week's report via Telegram
curl https://SEU-PROJETO.railway.app/report/weekly

# Get report data without sending Telegram
curl https://SEU-PROJETO.railway.app/report/weekly?send=false

# Get last week's report
curl https://SEU-PROJETO.railway.app/report/weekly?weeks_back=1
```

---

## Janelas de trading (hora de Lisboa)

| Janela | Horário Lisboa | Equivalente NY |
|--------|---------------|----------------|
| 1      | 14:45 – 15:15 | 09:45 – 10:15  |
| 2      | 15:45 – 16:15 | 10:45 – 11:15  |
| 3      | 16:45 – 17:15 | 11:45 – 12:15  |

---

## Testar manualmente

```bash
curl -X POST https://SEU-PROJETO.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_secret": "SEU_SECRET",
    "session": "15:45",
    "current_price": 19850.25,
    "candles_1m": [
      {"o":19840,"h":19860,"l":19835,"c":19852,"v":1250},
      {"o":19860,"h":19875,"l":19838,"c":19841,"v":980},
      {"o":19835,"h":19845,"l":19830,"c":19840,"v":1100}
    ],
    "broken_ob": {"type":"bullish","high":19855,"low":19838},
    "fvgs": [{"type":"bullish","top":19910,"bottom":19895,"after_ob_break":true}],
    "swings": [{"type":"low","price":19820},{"type":"high","price":19880}],
    "mtf": {"1d":"BULL","4h":"BULL","1h":"BULL_OK","15m":"BULL_OK","5m":"BULL_OK"},
    "suggested_entry": 19850.25,
    "suggested_sl": 19820.00,
    "tp": 19910.50,
    "risk_pts": 30.25
  }'
```
