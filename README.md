# WhatsApp Connection Service

Serviço gratuito que mantém conexão WhatsApp 24/7 via Baileys (deployado no Render.com free tier).

## Uso rápido (dono)

- **Ver/escanear o QR**: `https://clodoaldo-whatsapp.onrender.com/qr?key=clodoaldo-whatsapp-secret-2026`
  - A página mostra o QR e atualiza sozinha. Ao conectar, fica verde "✅ conectado".
  - Alternativa: painel do site → https://clodoaldo.vercel.app/admin/whatsapp → botão **Conectar**.
- **Conectar de novo** (se desconectar): basta abrir o link `/qr` acima — ele religa e gera QR sozinho.
- O serviço se **conecta sozinho ao ligar** (boot) e o workflow **Keep-alive ping** (GitHub Actions, a cada 5 min) impede que o Render o ponha pra dormir.

> ⚠️ O plano free do Render tem disco efêmero: se o serviço dormir ou for redeployado, o `auth_state` se perde e o QR precisa ser escaneado de novo (1 min pelo link `/qr`). Por isso o keep-alive é importante.
>
> ⚠️ O GitHub pode desativar o workflow agendado após 60 dias sem commits no repo — se o WhatsApp desconectar sozinho, reative em Actions.

## Endpoints

- `GET /health` — health check (com `version`)
- `GET /qr?key=...` — página pra escanear o QR no navegador
- `GET /status` (header `x-api-key`) — status + QR como data URL
- `POST /connect` (auth) — iniciar conexão
- `POST /disconnect` (auth) — desconectar e limpar auth
- `POST /send` (auth) — enviar mensagem `{ phone, text }` (limite **10/dia** de envios frios — plano seguro; `{ resposta: true }` = reply do menu, cota separada de 150/dia)
- `POST /onwhatsapp` (auth) — valida números e devolve JID canônico (não envia nada)

## Plano seguro (v2.7.0) — prospecção automática

O bot roda um **pacer** interno: a cada ciclo ele PUXA 1 item da fila de
prospecção do site (`/api/whatsapp/pull`) e envia respeitando:

- **Teto de 10 envios frios/dia** (compartilhado com o `/send` manual)
- **Intervalo de 10-13 min** entre cada envio (sorteado — nunca rajada)
- **Janela humana 09:00-19:00 BRT** (nenhum envio de madrugada/noite)
- A Vercel valida pausado / modo auto / limite / intervalo e entrega o item;
  o bot reporta o desfecho de volta (enviado / erro / retentar)
- Estado do pacer visível em `GET /status` (campo `pacer`)

## Configuração (Render)

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**:
  - `WHATSAPP_API_KEY` = `clodoaldo-whatsapp-secret-2026` (tem esse default no código)
  - `WEBHOOK_URL` = `https://clodoaldo.vercel.app/api/whatsapp/webhook` (default)

As mensagens recebidas são encaminhadas pro site (Vercel), que responde com o menu automático (Task 30).
