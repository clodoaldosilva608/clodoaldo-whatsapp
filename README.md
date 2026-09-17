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
- `POST /send` (auth) — enviar mensagem `{ phone, text }` (limite 30/dia)

## Configuração (Render)

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**:
  - `WHATSAPP_API_KEY` = `clodoaldo-whatsapp-secret-2026` (tem esse default no código)
  - `WEBHOOK_URL` = `https://clodoaldo.vercel.app/api/whatsapp/webhook` (default)

As mensagens recebidas são encaminhadas pro site (Vercel), que responde com o menu automático (Task 30).
