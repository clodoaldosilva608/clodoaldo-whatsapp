# WhatsApp Connection Service

Serviço gratuito que mantém conexão WhatsApp 24/7 via Baileys.

## Deploy no Render.com (gratuito)

1. Crie conta em https://render.com
2. New → Web Service → Connect a repository
3. Upload este diretório para um repo GitHub
4. Configurações:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**:
     - `WHATSAPP_API_KEY` = `clodoaldo-whatsapp-secret-2026`
     - `WEBHOOK_URL` = `https://clodoaldo.vercel.app/api/whatsapp/webhook`
5. Deploy

Após deploy, a URL será algo como `https://clodoaldo-whatsapp.onrender.com`

## Endpoints

- `GET /health` — health check
- `GET /status` — status + QR code
- `POST /connect` — iniciar conexão
- `POST /send` — enviar mensagem
- `POST /disconnect` — desconectar
