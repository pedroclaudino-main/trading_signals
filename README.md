# MNQ ICT Scalper — Setup Guide

Sistema completo de alertas ICT para CME_MINI:MNQH2026 com análise por Claude AI.

---

## Arquitetura

TradingView (Pine Script) → Webhook Server (Railway) → Claude AI → Telegram (iPhone)

---

## PASSO 1 — Deploy no Railway.app

1. Cria conta em https://railway.app (gratuito)
2. Clica "New Project" → "Deploy from GitHub"
   - Faz upload desta pasta como repositório GitHub, OU
   - Usa "Deploy from local" com o Railway CLI
3. Adiciona a variável de ambiente:
   - Nome: `ANTHROPIC_API_KEY`
   - Valor: a tua API key de https://console.anthropic.com
4. Railway dá-te uma URL pública tipo: `https://mnq-trader-production.up.railway.app`
5. Copia essa URL — vais precisar no Pine Script

### Alternativa rápida com Railway CLI:
```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set ANTHROPIC_API_KEY=sk-ant-...
```

---

## PASSO 2 — Telegram Bot

1. Abre Telegram → procura @BotFather
2. Envia `/newbot` → segue instruções → copia o **Bot Token**
3. Procura @userinfobot → envia qualquer mensagem → copia o **Chat ID**
4. Procura o teu novo bot → clica **Start**

---

## PASSO 3 — Pine Script no TradingView

1. Abre TradingView → Chart do MNQ (CME_MINI:MNQH2026)
2. Pine Editor → cola o conteúdo de `mnq_ict_scalper.pine`
3. Edita as 3 primeiras linhas:
   ```
   WEBHOOK_URL = "https://SEU-PROJETO.railway.app/webhook"
   BOT_TOKEN   = "1234567890:ABCdef..."
   CHAT_ID     = "123456789"
   ```
4. Clica "Add to chart"
5. Cria um Alert:
   - Condition: "MNQ ICT Scalper — Webhook Alerts"
   - Alert actions: ✅ Webhook URL → cola a tua URL do Railway + `/webhook`
   - Expiration: Open-ended
   - Message: deixa vazio (o Pine Script gera o payload automaticamente)

---

## PASSO 4 — Timeframes recomendados

Usa o script em **1 minuto** para entradas e define o alerta nesse timeframe.
O script deteta OBs e FVGs no 1m e 5m automaticamente.

Para a análise top-down (1D, 4H, 1H, 15m), o Claude AI recebe os dados do 1m
e aplica o bias que tens configurado manualmente — podes adicionar inputs extras
ao Pine Script para enviar também os closes dos HTFs se quiseres mais precisão.

---

## Janelas de trading (hora de Lisboa)

| Janela | Horário Lisboa | Equivalente NY |
|--------|---------------|----------------|
| 1      | 14:45 – 15:15 | 09:45 – 10:15  |
| 2      | 15:45 – 16:15 | 10:45 – 11:15  |
| 3      | 16:45 – 17:15 | 11:45 – 12:15  |

**Atenção:** Em horário de verão (WEST = UTC+1) as janelas no TradingView
já estão em UTC, por isso o Pine Script usa hora de Lisboa diretamente.

---

## Estrutura da mensagem recebida no iPhone

```
🟢 TRADE ALERT — MNQ
━━━━━━━━━━━━━━━━━
📌 CME_MINI:MNQH2026
Direção: ▲ LONG
Confiança: 🔥 Alta

🎯 Entry:  19850.25
✅ TP1:    19920.00
✅ TP2:    19975.00
❌ SL:     19790.00

📊 R/R: 1 : 2.33
📈 Bias 1D: BULLISH | 4H: BULLISH

💬 Preço fechou em OB bullish com FVG acima como alvo
```

---

## Testar manualmente

Podes testar o servidor sem o TradingView com este comando:

```bash
curl -X POST https://SEU-PROJETO.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "bot_token": "SEU_BOT_TOKEN",
    "chat_id": "SEU_CHAT_ID",
    "session": "15:45",
    "current_price": 19850.25,
    "candles": [
      {"tf":"1m","o":19840,"h":19860,"l":19835,"c":19852},
      {"tf":"prev","o":19860,"h":19875,"l":19838,"c":19841}
    ],
    "order_blocks": [
      {"tf":"1m","type":"bullish","high":19855,"low":19838}
    ],
    "fvgs": [
      {"tf":"1m","type":"bullish","top":19910,"bottom":19895}
    ]
  }'
```
