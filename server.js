/**
 * WhatsApp Connection Service — runs 24/7 on Render.com (free tier).
 *
 * Endpoints:
 * GET  /status        — connection status + QR code (as data URL)
 * POST /connect       — start connection / generate QR
 * POST /disconnect    — logout and clear auth
 * POST /send          — send message { phone, text }
 * GET  /health        — health check for Render
 *
 * Incoming messages are forwarded to the main site via webhook:
 * POST https://clodoaldo.vercel.app/api/whatsapp/webhook
 */

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, BufferJSON, initAuthCreds, proto } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const VERSION = "2.5.2"; // marcador pra confirmar deploy no Render via /health
const AUTH_DIR = path.join(process.cwd(), "auth_state");
// Fonte única de verdade (v2.2.0): URL e chave FIXADAS no código — nunca mais
// dependem de variável de ambiente no dashboard (elimina encaminhamento quebrado
// por env errada). Visíveis em /status pra conferência.
const WEBHOOK_URL = "https://clodoaldo.vercel.app/api/whatsapp/webhook";
const API_KEY = "clodoaldo-whatsapp-secret-2026";

// Diagnóstico (v2.2.0): últimas mensagens que o Baileys ENXERGOU — inclusive
// as ignoradas (do próprio número, grupo, antiga, sem texto). Responde de vez
// a pergunta "a mensagem chegou ao robô?".
const lastMessages = [];
function registrarMsg(info) {
  const registro = { at: new Date().toISOString(), ...info };
  lastMessages.unshift(registro);
  if (lastMessages.length > 10) lastMessages.pop();
  return registro;
}

// Diagnóstico (v2.5.2): histórico de eventos de conexão — responde remotamente
// (sem acesso ao dashboard do Render) o porquê de quedas/flapping.
const connEvents = [];
function registrarConn(evento, extra) {
  const registro = { at: new Date().toISOString(), event: evento, ...(extra || {}) };
  connEvents.unshift(registro);
  if (connEvents.length > 15) connEvents.pop();
  return registro;
}

// State
let sock = null;
let connectionStatus = "disconnected";
let currentQR = null;
let messagesToday = { count: 0, date: "" };
const DAILY_LIMIT = 30;
// v2.5.0: trava contra conexões concorrentes (2 sockets = comportamento errático)
let isConnecting = false;

// ============================================================
// Persistência da SESSÃO (v2.4.0)
// O auth_state do Baileys (creds.json, session-*.json, pre-key-*.json...)
// é guardado no site principal (Vercel → banco MEUCORRE, tabela
// clodoaldo_wa_auth) via /api/whatsapp/auth-state com a MESMA API key do
// webhook. Assim deploy/restart do Render NÃO desloga o WhatsApp — sem
// reescanear QR a cada atualização.
// ============================================================
const AUTH_SYNC_URL = "https://clodoaldo.vercel.app/api/whatsapp/auth-state";

const authFiles = new Map();      // nome do arquivo → conteúdo (JSON string)
const authDirty = new Set();      // pendentes de gravação
const authTombstones = new Set(); // marcados pra REMOÇÃO
let authFlushTimer = null;

async function authSyncGet() {
  const resp = await fetch(AUTH_SYNC_URL, { headers: { "x-api-key": API_KEY } });
  if (!resp.ok) throw new Error(`GET ${resp.status}`);
  const data = await resp.json();
  return data.files || {};
}

async function authSyncPut(files) {
  const resp = await fetch(AUTH_SYNC_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ files }),
  });
  if (!resp.ok) throw new Error(`PUT ${resp.status}`);
}

async function authSyncClear() {
  authFiles.clear(); authDirty.clear(); authTombstones.clear();
  if (authFlushTimer) { clearTimeout(authFlushTimer); authFlushTimer = null; }
  try {
    const resp = await fetch(AUTH_SYNC_URL, { method: "DELETE", headers: { "x-api-key": API_KEY } });
    console.log(`[WA] auth-sync: sessão apagada do banco (HTTP ${resp.status})`);
  } catch (e) {
    console.error("[WA] auth-sync: falha ao apagar sessão do banco:", e.message);
  }
}

function agendarFlush(ms = 2000) {
  if (authFlushTimer) return;
  authFlushTimer = setTimeout(async () => {
    authFlushTimer = null;
    await flushAuthNow();
  }, ms);
}

async function flushAuthNow() {
  if (!authDirty.size) return;
  const batch = {};
  for (const name of authDirty) {
    batch[name] = authTombstones.has(name) ? null : authFiles.get(name) ?? null;
  }
  authDirty.clear();
  for (const name of Object.keys(batch)) authTombstones.delete(name);
  try {
    await authSyncPut(batch);
    console.log(`[WA] auth-sync: ${Object.keys(batch).length} arquivo(s) salvos no banco`);
  } catch (e) {
    console.error("[WA] auth-sync: PUT falhou (reagendando):", e.message);
    for (const name of Object.keys(batch)) {
      if (batch[name] === null) authTombstones.add(name);
      else authFiles.set(name, batch[name]);
      authDirty.add(name);
    }
    agendarFlush(8000);
  }
}

/** Auth state do Baileys apoiado no banco (interface idêntica à useMultiFileAuthState). */
async function useDbAuthState() {
  authFiles.clear(); authDirty.clear(); authTombstones.clear();
  try {
    const files = await authSyncGet();
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === "string") authFiles.set(name, content);
    }
    console.log(`[WA] auth-sync: ${authFiles.size} arquivo(s) de sessão carregados do banco`);
  } catch (e) {
    console.log(`[WA] auth-sync: sem sessão salva (${e.message}) — segue fluxo do QR`);
  }

  const readFile = (name) => {
    const raw = authFiles.get(name);
    if (raw == null) return null;
    try { return JSON.parse(raw, BufferJSON.reviver); } catch { return null; }
  };
  const writeFile = (name, data) => {
    authFiles.set(name, JSON.stringify(data, BufferJSON.replacer));
    authTombstones.delete(name);
    authDirty.add(name);
    agendarFlush();
  };
  const removeFile = (name) => {
    if (authFiles.has(name)) authFiles.delete(name);
    authTombstones.add(name);
    authDirty.add(name);
    agendarFlush();
  };

  const savedCreds = readFile("creds.json");
  const creds = savedCreds || initAuthCreds();
  if (savedCreds) console.log("[WA] auth-sync: creds.json encontrada — reconectando SEM QR");

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readFile(`${type}-${id}.json`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[type] = data[type] || {};
            data[type][id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              if (value) writeFile(file, value);
              else removeFile(file);
            }
          }
        },
      },
    },
    saveCreds: () => writeFile("creds.json", creds),
  };
}

// Create auth dir
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Resiliência (v2.1.0): um erro do Baileys NUNCA derruba o processo.
// Reconexões ficam por conta do handler de connection.update.
process.on("uncaughtException", (err) => {
  console.error("[WA] uncaughtException (processo mantido vivo):", err?.message || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[WA] unhandledRejection (processo mantido vivo):", err?.message || err);
});

// v2.5.1: encerramento GRACIOSO — o Render manda SIGTERM a cada deploy/restart.
// Sem isso, chaves de sessão geradas nos últimos 2s (janela do flush) morriam
// com o container e a sessão restaurada no boot seguinte ficava incompleta.
process.on("SIGTERM", () => {
  console.log("[WA] SIGTERM recebido — salvando sessão e fechando conexão...");
  (async () => {
    try { await flushAuthNow(); } catch {}
    try { if (sock) sock.end(new Error("deploy-restart")); } catch {}
    // 1s pro WS mandar o frame de close e o flush terminar
    setTimeout(() => process.exit(0), 1000);
  })();
});

// Auth middleware
function authMiddleware(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function connectWhatsApp() {
  if (sock && connectionStatus === "connected") {
    return { status: "already_connected" };
  }
  if (isConnecting) {
    return { status: "connecting" };
  }

  isConnecting = true;
  connectionStatus = "connecting";

  try {
    // v2.4.0: auth state apoiado no banco — sessão sobrevive a deploy/restart
    const { state, saveCreds } = await useDbAuthState();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["Clodoaldo Admin", "Chrome", "1.0.0"],
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = "qr_ready";
        registrarConn("qr");
        console.log("[WA] QR Code generated, waiting for scan");
      }

      if (connection === "close") {
        currentQR = null;
        connectionStatus = "disconnected";
        // Salva qualquer key pendente ANTES de perder o socket
        flushAuthNow().catch(() => {});
        sock = null; // libera o socket morto (permite self-healing)
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // v2.5.2: motivo da queda vai para o histórico visível em /status
        registrarConn("close", {
          reason: statusCode,
          reasonName: DisconnectReason[statusCode] || "?",
          erro: lastDisconnect?.error?.message ? String(lastDisconnect.error.message).slice(0, 140) : null,
        });

        // v2.5.0: log do motivo da queda (diagnóstico de flapping)
        console.log(
          `[WA] Connection closed. reason=${statusCode} (${DisconnectReason[statusCode] || "?"}) | reconnect=${shouldReconnect}`
        );

        if (shouldReconnect) {
          setTimeout(() => connectWhatsApp().catch(() => {}), 3000);
        } else {
          console.log("[WA] Logged out, limpando sessão (disco + banco) e gerando QR novo em 3s...");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
          authSyncClear(); // v2.4.0: apaga também a sessão do banco
          // Logo após logout já oferece QR novo — sem precisar acessar /qr
          setTimeout(() => connectWhatsApp().catch(() => {}), 3000);
        }
      } else if (connection === "open") {
        currentQR = null;
        connectionStatus = "connected";
        registrarConn("open");
        console.log("[WA] Connected successfully!");
        // v2.5.1: renova o pool de pre-keys do servidor a cada conexão.
        // O WhatsApp cifra as mensagens de ENTRADA com uma pre-key do nosso
        // dispositivo; se o container antigo morreu sem salvar as últimas
        // (SIGTERM do deploy), a sessão restaurada ficava sem a chave privada
        // e a mensagem chegava indecifrável (robô mandava, mas não recebia).
        // Re-carregar garante que só existam no pool chaves que nós temos.
        if (sock && typeof sock.uploadPreKeys === "function") {
          sock.uploadPreKeys(50).catch((e) =>
            console.error("[WA] Renovação de pre-keys falhou:", e.message)
          );
        }
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msgs = m.messages || [];
        for (const msg of msgs) {
          if (!msg.message) continue;

          const from = msg.key.remoteJid || "";
          const fromMe = msg.key.fromMe || false;
          const timestamp = msg.messageTimestamp || Date.now();

          let text = "";
          if (msg.message.conversation) text = msg.message.conversation;
          else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
          else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;

          // Motivo de ignorar (registrado pra diagnóstico): grupo/status,
          // mensagem do próprio número (fromMe — anti-loop), antiga (>5min,
          // rajada ao acordar) ou sem texto (áudio/sticker/foto sem legenda).
          // v2.3.0: JIDs @lid (usuário REAL com privacidade ativada — comum em
          // quem clica em anúncio) NÃO são mais descartados. Só descartamos
          // grupos (@g.us), status/broadcast e canais (@newsletter).
          let skip = "";
          const ehGrupo = from.endsWith("@g.us");
          const ehStatus =
            from === "status@broadcast" ||
            from.endsWith("@broadcast") ||
            from.endsWith("@newsletter");
          if (ehGrupo || ehStatus) skip = "grupo-ou-status";
          else if (fromMe) skip = "fromMe-proprio-numero";
          else {
            const tsMs = typeof timestamp === "number" ? timestamp * 1000 : Date.now();
            if (Date.now() - tsMs > 5 * 60 * 1000) skip = "mensagem-antiga";
          }
          if (!skip && !text) skip = "sem-texto";

          const phone = from
            .replace(/@s\.whatsapp\.net$/, "")
            .replace(/@g\.us$/, "")
            .replace(/@lid$/, "");
          const registro = registrarMsg({
            from: from.endsWith("@lid") ? `${phone} (lid)` : phone,
            fromMe,
            text: (text || "(sem texto)").slice(0, 60),
            skip: skip || "processada",
          });

          console.log(`[WA] Message ${fromMe ? "sent" : "received"} from ${phone}${from.endsWith("@lid") ? " [LID]" : ""}${skip ? ` [ignorada: ${skip}]` : ""}: ${(text || "(sem texto)").slice(0, 80)}`);

          if (skip) continue;

          const messageData = {
            from: phone,
            jid: from, // v2.3.0: JID original preservado (resposta p/ @lid)
            text,
            timestamp: typeof timestamp === "number" ? timestamp * 1000 : Date.now(),
            fromMe,
          };

          // Forward to main site webhook (v2.2.0: confere resposta HTTP e tenta 2x)
          let encaminhado = { ok: false, status: "erro" };
          for (let tentativa = 1; tentativa <= 2; tentativa++) {
            try {
              const resp = await fetch(WEBHOOK_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": API_KEY,
                },
                body: JSON.stringify(messageData),
              });
              const corpo = await resp.text().catch(() => "");
              console.log(`[WA] Webhook resp ${resp.status} (tentativa ${tentativa}): ${corpo.slice(0, 120)}`);
              encaminhado = { ok: resp.ok, status: resp.status };
              if (resp.ok || resp.status < 500) break;
            } catch (e) {
              console.error(`[WA] Webhook erro (tentativa ${tentativa}):`, e.message);
              encaminhado = { ok: false, status: "erro-rede" };
            }
            if (tentativa === 1) await new Promise((r) => setTimeout(r, 1500));
          }
          registro.encaminhado = encaminhado.ok;
          registro.respostaWebhook = encaminhado.status;
        }
      } catch (e) {
        console.error("[WA] Message processing error:", e.message);
      }
    });

    return { status: "connecting" };
  } catch (e) {
    console.error("[WA] Connection error:", e.message);
    connectionStatus = "disconnected";
    // v2.5.0: a cadeia de reconexão NUNCA morre — se a tentativa falhar
    // (ex.: banco indisponível ao carregar a sessão), tenta de novo em 10s.
    setTimeout(() => connectWhatsApp().catch(() => {}), 10000);
    return { status: "error", error: e.message };
  } finally {
    isConnecting = false;
  }
}

async function sendWhatsAppMessage(phone, text, jidOriginal) {
  if (!sock || connectionStatus !== "connected") {
    return { ok: false, error: "WhatsApp not connected" };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (messagesToday.date !== today) {
    messagesToday = { count: 0, date: today };
  }
  if (messagesToday.count >= DAILY_LIMIT) {
    return { ok: false, error: `Daily limit of ${DAILY_LIMIT} messages reached` };
  }

  try {
    // v2.3.0: se veio o JID original da conversa (@lid ou @s.whatsapp.net),
    // usamos ele direto — é a forma correta de responder a usuários com
    // privacidade ativada (LID). Sem JID válido, monta a partir dos dígitos.
    let jid;
    if (
      typeof jidOriginal === "string" &&
      (jidOriginal.endsWith("@lid") || jidOriginal.endsWith("@s.whatsapp.net"))
    ) {
      jid = jidOriginal;
    } else {
      jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";
    }

    await sock.sendMessage(jid, { text });
    messagesToday.count++;
    console.log(`[WA] Sent to ${jid} (${messagesToday.count}/${DAILY_LIMIT})`);
    return { ok: true };
  } catch (e) {
    console.error("[WA] Send error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function disconnectWhatsApp() {
  if (sock) {
    try { await sock.logout(); } catch {}
    sock = null;
    connectionStatus = "disconnected";
    currentQR = null;
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    await authSyncClear(); // v2.4.0: sessão também sai do banco
    console.log("[WA] Disconnected and auth cleared");
  }
  return { ok: true };
}

// === ROUTES ===

app.get("/", (req, res) => {
  res.json({ ok: true, service: "clodoaldo-whatsapp", version: VERSION, status: connectionStatus });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, version: VERSION, status: connectionStatus, uptime: process.uptime() });
});

// Página amigável pra escanear o QR no navegador (sem login, protegida pela key)
app.get("/qr", async (req, res) => {
  const key = String(req.query.key || "");
  if (key !== API_KEY) {
    return res.status(401).send(
      "<h1 style='font-family:sans-serif'>401 — Chave inválida</h1>" +
      "<p style='font-family:sans-serif'>Use o link completo com ?key=...</p>"
    );
  }

  // Self-healing: se caiu por logout, religa pra gerar QR novo
  if (connectionStatus === "disconnected" && !sock) {
    connectWhatsApp();
  }

  let qrImg = null;
  if (currentQR) {
    try {
      qrImg = await QRCode.toDataURL(currentQR, { width: 320, margin: 2 });
    } catch {}
  }

  const refresh = connectionStatus === "connected" ? "" : '<meta http-equiv="refresh" content="5">';

  let corpo = "";
  if (connectionStatus === "connected") {
    corpo = `
      <div style="background:#dcfce7;border:1px solid #86efac;color:#166534;padding:24px 32px;border-radius:16px;text-align:center">
        <h1 style="margin:0 0 8px">✅ WhatsApp conectado!</h1>
        <p style="margin:0">Tudo certo — pode fechar esta página. O bot responde sozinho pelo menu automático.</p>
      </div>`;
  } else if (qrImg) {
    corpo = `
      <h2 style="color:#111">Escaneie este QR Code</h2>
      <img src="${qrImg}" alt="QR Code WhatsApp" width="320" height="320" style="border-radius:12px;border:1px solid #e5e5e5" />
      <ol style="text-align:left;max-width:340px;margin:16px auto;color:#444;line-height:1.6">
        <li>Abra o <strong>WhatsApp</strong> no seu celular</li>
        <li>Toque em <strong>Configurações → Dispositivos conectados</strong></li>
        <li>Toque em <strong>Conectar dispositivo</strong></li>
        <li>Aponte a câmera pra este QR</li>
      </ol>
      <p style="color:#888;font-size:13px">A página atualiza sozinha a cada 5s. Se o QR expirar, um novo aparece aqui.</p>`;
  } else {
    corpo = `
      <h2 style="color:#111">Gerando QR Code…</h2>
      <p style="color:#666">Aguarde alguns segundos — a página atualiza sozinha.</p>
      <p style="color:#aaa;font-size:13px">Status atual: ${connectionStatus}</p>`;
  }

  res.send(`<!doctype html>
<html lang="pt-BR"><head>
  <meta charset="utf-8">
  ${refresh}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp — Conexão</title>
</head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fafafa;margin:0;padding:32px 16px;text-align:center">
  ${corpo}
</body></html>`);
});

app.get("/status", authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (messagesToday.date !== today) {
    messagesToday = { count: 0, date: today };
  }

  let qrDataUrl = null;
  if (currentQR) {
    try {
      qrDataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    } catch {}
  }

  res.json({
    status: connectionStatus,
    qr: qrDataUrl,
    messagesToday: messagesToday.count,
    dailyLimit: DAILY_LIMIT,
    version: VERSION,
    webhookUrl: WEBHOOK_URL,
    lastMessages,
    connEvents,
  });
});

app.post("/connect", authMiddleware, async (req, res) => {
  const result = await connectWhatsApp();
  res.json(result);
});

app.post("/disconnect", authMiddleware, async (req, res) => {
  const result = await disconnectWhatsApp();
  res.json(result);
});

app.post("/send", authMiddleware, async (req, res) => {
  const { phone, text, jid } = req.body;
  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: "Missing phone or text" });
  }
  const result = await sendWhatsAppMessage(phone, text, jid);
  res.json(result);
});

// Start server
app.listen(PORT, () => {
  console.log(`[WA] Server running on port ${PORT} (v${VERSION}) | webhook → ${WEBHOOK_URL}`);
  // Auto-connect SEMPRE no boot: com auth reconecta sozinho;
  // sem auth já gera o QR (aparece em /qr e no admin sem ninguém clicar)
  console.log("[WA] Auto-connecting on boot...");
  connectWhatsApp();
});

// Keep-alive: ping self every 5 minutes to prevent Render free tier sleep
setInterval(async () => {
  try {
    await fetch(`http://localhost:${PORT}/health`);
    console.log("[WA] Keep-alive ping sent");
  } catch {}
}, 5 * 60 * 1000);

// v2.5.0: Watchdog — rede de segurança da reconexão. A cada 60s, se a conexão
// não estiver saudável e ninguém estiver conectando, tenta de novo. Garante
// que NENHUM furo na cadeia de reconexão deixe o robô mudo sem ninguém notar.
setInterval(() => {
  if (connectionStatus !== "connected" && !isConnecting) {
    console.log("[WA] Watchdog: status", connectionStatus, "— tentando reconectar");
    connectWhatsApp().catch(() => {});
  }
}, 60 * 1000);
