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
const { DisconnectReason, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(process.cwd(), "auth_state");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://clodoaldo.vercel.app/api/whatsapp/webhook";
const API_KEY = process.env.WHATSAPP_API_KEY || "clodoaldo-whatsapp-secret-2026";

// State
let sock = null;
let connectionStatus = "disconnected";
let currentQR = null;
let messagesToday = { count: 0, date: "" };
const DAILY_LIMIT = 30;

// Create auth dir
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

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

  connectionStatus = "connecting";

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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
        console.log("[WA] QR Code generated, waiting for scan");
      }

      if (connection === "close") {
        currentQR = null;
        connectionStatus = "disconnected";
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

        if (shouldReconnect) {
          console.log("[WA] Connection closed, reconnecting in 3s...");
          setTimeout(() => connectWhatsApp(), 3000);
        } else {
          console.log("[WA] Logged out, clearing auth");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
        }
      } else if (connection === "open") {
        currentQR = null;
        connectionStatus = "connected";
        console.log("[WA] Connected successfully!");
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

          if (!text) continue;

          const phone = from.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
          const messageData = {
            from: phone,
            text,
            timestamp: typeof timestamp === "number" ? timestamp * 1000 : Date.now(),
            fromMe,
          };

          console.log(`[WA] Message ${fromMe ? "sent" : "received"} from ${phone}: ${text.slice(0, 80)}`);

          // Forward to main site webhook
          if (!fromMe) {
            try {
              await fetch(WEBHOOK_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": API_KEY,
                },
                body: JSON.stringify(messageData),
              });
              console.log("[WA] Webhook sent to main site");
            } catch (e) {
              console.error("[WA] Webhook error:", e.message);
            }
          }
        }
      } catch (e) {
        console.error("[WA] Message processing error:", e.message);
      }
    });

    return { status: "connecting" };
  } catch (e) {
    console.error("[WA] Connection error:", e.message);
    connectionStatus = "disconnected";
    return { status: "error", error: e.message };
  }
}

async function sendWhatsAppMessage(phone, text) {
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
    let jid = phone.replace(/\D/g, "");
    if (!jid.endsWith("@s.whatsapp.net")) jid += "@s.whatsapp.net";

    await sock.sendMessage(jid, { text });
    messagesToday.count++;
    console.log(`[WA] Sent to ${phone} (${messagesToday.count}/${DAILY_LIMIT})`);
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
    console.log("[WA] Disconnected and auth cleared");
  }
  return { ok: true };
}

// === ROUTES ===

app.get("/health", (req, res) => {
  res.json({ ok: true, status: connectionStatus, uptime: process.uptime() });
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
  const { phone, text } = req.body;
  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: "Missing phone or text" });
  }
  const result = await sendWhatsAppMessage(phone, text);
  res.json(result);
});

// Start server
app.listen(PORT, () => {
  console.log(`[WA] Server running on port ${PORT}`);
  // Auto-connect if auth exists
  const authFiles = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR) : [];
  if (authFiles.length > 0) {
    console.log("[WA] Auth files found, auto-connecting...");
    connectWhatsApp();
  } else {
    console.log("[WA] No auth files, waiting for /connect");
  }
});

// Keep-alive: ping self every 5 minutes to prevent Render free tier sleep
setInterval(async () => {
  try {
    await fetch(`http://localhost:${PORT}/health`);
    console.log("[WA] Keep-alive ping sent");
  } catch {}
}, 5 * 60 * 1000);
