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
const VERSION = "2.6.0"; // marcador pra confirmar deploy no Render via /health — v2.6.0: detector de socket zumbi
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

// v2.5.9: rastreamento de ACKS das mensagens ENVIADAS — fecha o buraco
// "ok:true não garante entrega". O sendMessage resolve cedo; o status real
// chega depois via messages.update: 1=pending, 2=servidor aceitou,
// 3=entregue no aparelho do destinatário, 4=lido, 0=erro.
const outboundAcks = [];
const ACK_LABELS = { 0: "erro", 1: "pendente", 2: "servidor-aceitou", 3: "entregue", 4: "lido", 5: "reproduzido" };
function registrarOutbound(info) {
  const registro = { at: new Date().toISOString(), statusLabel: ACK_LABELS[info.status] || String(info.status ?? "-"), ...info };
  outboundAcks.unshift(registro);
  if (outboundAcks.length > 50) outboundAcks.pop();
  return registro;
}

// v2.6.0: DETECÇÃO DE SOCKET ZUMBI — a causa raiz dos envios silenciosamente
// perdidos (lote 16:58 do 17/09: só o 1º de 10 saiu; reenvio 20:49-20:59:
// 12/12 presos em status=1). Sintoma: o WS está "aberto", o sendMessage
// resolve SEM erro, mas o servidor WhatsApp nunca manda o ACK — nada chega
// ao destinatário e o dono não vê nada no próprio aparelho.
// Regra: mensagem enviada DEVE receber SERVER_ACK (status 2) em segundos.
// Pendente há mais de ZUMBI_SEG não é "entrega lenta", é socket morto.
const ZUMBI_SEG = 75;
function contarPendentesZumbis(minSeg = ZUMBI_SEG) {
  const corte = Date.now() - minSeg * 1000;
  return outboundAcks.filter((o) => o.status === 1 && new Date(o.at).getTime() < corte).length;
}
function matarZumbi(motivo) {
  const n = contarPendentesZumbis(30); // marca só os realmente abandonados
  for (const o of outboundAcks) {
    if (o.status === 1 && new Date(o.at).getTime() < Date.now() - 30 * 1000) {
      o.status = 0;
      o.statusLabel = "erro-zumbi";
    }
  }
  console.log(`[WA] ZUMBI: ${motivo} — matando socket (${n} msgs órfãs marcadas como erro-zumbi)`);
  if (sock) {
    try { sock.end(new Error("zumbi: " + motivo)); } catch {}
    // o handler de connection.update(close) faz sock=null e reconecta em 3s
  }
}

// State
let sock = null;
let connectionStatus = "disconnected";
let currentQR = null;
let messagesToday = { count: 0, date: "" };
const DAILY_LIMIT = 30;
// v2.5.0: trava contra conexões concorrentes (2 sockets = comportamento errático)
let isConnecting = false;
// v2.5.3: durante SIGTERM (deploy/restart) nenhuma reconexão deve nascer —
// um socket fantasma do container antigo rouba a sessão do novo container
// (440 connectionReplaced)
let shuttingDown = false;

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

// v2.5.7: diagnóstico de decrypt — toda pre-key CONSULTADA e AUSENTE no store
// é registrada aqui. Se um peer cifra com preKeyId que não temos (bundle
// cacheado de device antigo), a ID exata aparece — fecha o mistério do
// "Invalid PreKey ID".
const preKeyMisses = [];
function registrarPreKeyMiss(id, ts) {
  preKeyMisses.unshift({ id: String(id), at: new Date(ts || Date.now()).toISOString() });
  if (preKeyMisses.length > 25) preKeyMisses.pop();
}

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
        // v2.5.8 — FIX DA CAUSA RAIZ: o contrato do Baileys 7 (rc14) exige get()
        // FLAT ({ [id]: value }) — ver lib/Types/Auth.d.ts e use-multi-file-auth-state.js.
        // O formato antigo aninhado ({ [type]: { [id]: value } }) fazia o
        // addTransactionCapability engolir o valor (Object.assign(ctx.cache[type],
        // fetched) criava chave dupla "pre-key.pre-key") => loadPreKey/loadSession
        // SEMPRE vazios => "Invalid PreKey ID" / "No session record" para TODO
        // remetente, com hook de miss calado (a chave existia — só não era lida).
        // O SET continua aninhado (idem oficial).
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readFile(`${type}-${id}.json`);
            if (type === "pre-key" && value == null) {
              registrarPreKeyMiss(id);
              console.log(`[DIAG] pre-key FALTANTE consultada: id=${id} (peer cifrou com pre-key que não existe no store)`);
            }
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value; // v2.5.8: FLAT (antes: data[type][id] — shape legacy que o rc14 não lê)
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
  shuttingDown = true; // v2.5.3: congela TODAS as reconexões a partir daqui
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
    // v2.5.3 — CAUSA RAIZ do flapping 440 connectionReplaced: se sobrou um
    // socket antigo em QUALQUER estado (status != connected passa pela guarda
    // de cima), ele é encerrado aqui. Dois sockets vivos com a mesma sessão
    // brigam no servidor do WhatsApp e se substituem em loop infinito.
    if (sock) {
      const velho = sock;
      sock = null; // vira órfão imediatamente: seus handlers viram no-op pelo stale-guard
      try { velho.end(new Error("substituido-por-nova-conexao")); } catch {}
    }

    // v2.4.0: auth state apoiado no banco — sessão sobrevive a deploy/restart
    const { state, saveCreds } = await useDbAuthState();

    const esteSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["Clodoaldo Admin", "Chrome", "1.0.0"],
      defaultQueryTimeoutMs: 60000,
    });
    sock = esteSock;

    esteSock.ev.on("creds.update", saveCreds);

    esteSock.ev.on("connection.update", (update) => {
      // v2.5.3: evento de socket órfão (já substituído/anulado) — ignora.
      // Sem isso o órfão derruba o estado global e agenda reconexões fantasmas.
      if (sock !== esteSock) return;

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

        if (shuttingDown) {
          // v2.5.3: container morrendo (deploy) — reconexão congelada, o novo
          // container assume a sessão. Reconectar aqui geraria socket fantasma.
          console.log("[WA] Close durante shutdown — reconexão congelada");
        } else if (shouldReconnect) {
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
          sock.uploadPreKeys(50)
            .then(async () => {
              // v2.5.5: pre-keys novas vão pro banco IMEDIATAMENTE (sem esperar
              // o flush de 2s). Se o container morrer no handoff de um deploy,
              // as chaves privadas já estão persistidas — a sessão restaurada
              // decifra as mensagens. (Causa raiz dos erros "Invalid PreKey
              // ID" / "No session record" de 17/09: uploads concorrentes de
              // containers com blobs divergentes durante o flapping 440.)
              try { await flushAuthNow(); } catch {}
              console.log("[WA] Pool de pre-keys renovado e JÁ PERSISTIDO no banco");
            })
            .catch((e) =>
              console.error("[WA] Renovação de pre-keys falhou:", e.message)
            );
        }
      }
    });

    esteSock.ev.on("messages.upsert", async (m) => {
      if (sock !== esteSock) return; // v2.5.3: socket órfão não processa mensagens
      try {
        const msgs = m.messages || [];
        for (const msg of msgs) {
          // v2.5.4: mensagens SEM msg.message (stub) são notificações de protocolo
          // OU mensagens que FALHARAM na descriptografia (LID/sessão/pre-key).
          // Antes elas eram descartadas ANTES do registro — cegueza total no
          // diagnóstico ("a msg chegou mas não decifrou" parecia "não chegou").
          const stubType = msg.messageStubType;
          const stubParams = (msg.messageStubParameters || []).join(";").slice(0, 90);
          if (!msg.message) {
            registrarMsg({
              from: (msg.key?.remoteJid || "?").replace(/@s\.whatsapp\.net$/, "(j)").replace(/@lid$/, "(lid)"),
              fromMe: !!msg.key?.fromMe,
              text: `(stub ${stubType ?? "?"} ${stubParams})`,
              skip: "stub-sem-conteudo",
            });
            console.log(`[WA] Stub message from ${msg.key?.remoteJid} type=${stubType} params=${stubParams}`);
            continue;
          }

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

    // v2.5.9: atualiza o status de entrega das mensagens que ENVIAMOS
    // (ack 2 = servidor WhatsApp aceitou; 3 = entregue no destinatário)
    esteSock.ev.on("messages.update", (updates) => {
      if (sock !== esteSock) return;
      for (const u of updates) {
        const alvo = outboundAcks.find((o) => o.id === u.key?.id);
        if (alvo && typeof u.update?.status === "number") {
          alvo.status = u.update.status;
          alvo.statusLabel = ACK_LABELS[u.update.status] || String(u.update.status);
          alvo.ackAt = new Date().toISOString();
        }
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
  // v2.6.0: recusa enviar em socket zumbi (mensagens anteriores >75s sem ack).
  // Mata a conexão morta (reconecta em 3s) e NÃO conta no limite diário —
  // antes, as mensagens órfãs queimavam o dailyLimit sem nunca sair.
  if (contarPendentesZumbis() >= 2) {
    matarZumbi("/send recusou em conexão zumbi");
    return { ok: false, reconectando: true, error: "Socket zumbi detectado (mensagens sem ack do servidor). Reconectando — reenvie em ~40s." };
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

    const enviada = await sock.sendMessage(jid, { text });
    messagesToday.count++;
    // v2.5.9: registra para rastrear o ack real (servidor/entrega/leitura)
    registrarOutbound({
      id: enviada?.key?.id || "?",
      to: jid,
      text: (text || "").slice(0, 40),
      status: 1,
    });
    console.log(`[WA] Sent to ${jid} (${messagesToday.count}/${DAILY_LIMIT}) id=${enviada?.key?.id}`);
    return { ok: true, id: enviada?.key?.id };
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
    outboundAcks, // v2.5.9: status real de entrega das mensagens enviadas
    user: sock?.user || null, // v2.5.4: identidade (id/lid/name) como o servidor vê
  });
});

app.post("/connect", authMiddleware, async (req, res) => {
  const result = await connectWhatsApp();
  res.json(result);
});

// GET /diag — diagnóstico criptográfico (v2.5.6). Mostra o estado REAL do
// Signal no mesmo store usado pelo decrypt: pre-keys locais, pre-keys que o
// SERVIDOR tem, sessões por-peer, mapeamentos LID e signed pre-key. Fecho
// diagnóstico dos erros "Invalid PreKey ID" / "No session record".
app.get("/diag", authMiddleware, async (req, res) => {
  try {
    const nomes = [...authFiles.keys()];
    const preKeyIds = nomes
      .filter((n) => n.startsWith("pre-key-"))
      .map((n) => parseInt(n.slice("pre-key-".length), 10))
      .sort((a, b) => a - b);
    const sessionJids = nomes
      .filter((n) => n.startsWith("session-"))
      .map((n) => n.slice("session-".length, -".json".length));
    const lidMappings = nomes.filter((n) => n.startsWith("lid-mapping-"));
    const senderKeys = nomes.filter((n) => n.startsWith("sender-key-"));

    let credsObj = null;
    try {
      credsObj = JSON.parse(authFiles.get("creds.json") || "null", BufferJSON.reviver);
    } catch {}

    // Contagem de pre-keys no servidor do WhatsApp (IQ encrypt/count)
    let preKeysOnServer = null;
    if (sock && connectionStatus === "connected") {
      try {
        const result = await sock.query({
          tag: "iq",
          attrs: { xmlns: "encrypt", type: "get", to: "s.whatsapp.net" },
          content: [{ tag: "count", attrs: {} }],
        });
        const c = (result?.content || []).find((x) => x.tag === "count");
        preKeysOnServer = c ? +c.attrs.value : null;
      } catch (e) {
        preKeysOnServer = `erro: ${e.message}`;
      }
    }

    res.json({
      version: VERSION,
      status: connectionStatus,
      me: credsObj?.me || null,
      nextPreKeyId: credsObj?.nextPreKeyId ?? null,
      signedPreKeyId: credsObj?.signedPreKey?.keyId ?? null,
      preKeysLocal: {
        count: preKeyIds.length,
        min: preKeyIds[0] ?? null,
        max: preKeyIds[preKeyIds.length - 1] ?? null,
      },
      preKeysOnServer,
      sessions: {
        count: sessionJids.length,
        jids: sessionJids.slice(0, 30),
      },
      lidMappings: { count: lidMappings.length, sample: lidMappings.slice(0, 10) },
      senderKeys: { count: senderKeys.length, sample: senderKeys.slice(0, 5) },
      preKeyMisses,
      authFilesTotal: authFiles.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  if (shuttingDown) return; // v2.5.3: nada de reconexão durante shutdown
  // v2.5.3: em qr_ready existe um socket VIVO aguardando o scan — o watchdog
  // não pode substituí-lo (invalidava o QR a cada 60s durante o scan)
  if (connectionStatus === "qr_ready") return;
  if (connectionStatus !== "connected" && !isConnecting) {
    console.log("[WA] Watchdog: status", connectionStatus, "— tentando reconectar");
    connectWhatsApp().catch(() => {});
  }
}, 60 * 1000);

// v2.6.0: Sweeper de zumbis — a cada 30s, se ≥2 mensagens outbound estão
// pendentes há >75s, a conexão está morta por dentro. Mata e renasce.
// Isso cura sozinho o cenário "conectado mas o fio está cortado" — que hoje
// exige que alguém perceba a falha e reenvie manualmente.
setInterval(() => {
  if (shuttingDown) return;
  if (connectionStatus !== "connected") return;
  if (contarPendentesZumbis() >= 2) {
    matarZumbi("sweeper: msgs pendentes >75s sem SERVER_ACK");
  }
}, 30 * 1000);
