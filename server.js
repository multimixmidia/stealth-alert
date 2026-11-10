/**
 * ============================================================
 * SERVIDOR DE CONTINGENCIA - Stealth Alert (v2)
 * ------------------------------------------------------------
 * POST /api/v1/security/stealth-alert  -> recebe alertas da isca
 * POST /api/v1/security/disarm         -> desarma (senha do dono)
 * GET  /desarmar                       -> pagina simples de desarme
 *
 * Canais de alerta (ativos se as variaveis existirem):
 *  - Telegram : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *  - WhatsApp : WHATSAPP_PHONE + CALLMEBOT_APIKEY (CallMeBot)
 * Outras variaveis:
 *  - DISARM_PIN : senha de desarme (padrao 4321 so para teste)
 *  - PORT       : definida automaticamente pelo Render
 * Requer Node.js 18+.
 * ============================================================
 */
'use strict';

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

/* ============================================================
   CONFIG
   ============================================================ */
const PORT     = process.env.PORT || 3000;
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'stealth-alerts.jsonl');

const DISARM_PIN = process.env.DISARM_PIN || '4321';
const BASE_URL   = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT)).replace(/\/$/, '');
const TRACK_KEY  = process.env.TRACK_KEY || null;   // opcional: protege o link de acompanhamento

// device_id -> trilha de posicoes em memoria (ultimas N)
const tracks = new Map();
const MAX_FIXES = 300;

// device_id -> token (producao: banco de dados + hash)
const DEVICE_TOKENS = { 'DEV-ANDROID-0001': 'tok_demo_9f8e7d6c5b4a' };
const SHARED_TOKEN = process.env.SHARED_TOKEN || 'tok_demo_9f8e7d6c5b4a'; // prototipo: token unico p/ membros

// device_id -> contato de emergencia (dados vem das variaveis de ambiente)
const EMERGENCY_CONTACTS = {
  'DEV-ANDROID-0001': {
    name: 'Contato Familiar',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || null,
    whatsapp_phone:   process.env.WHATSAPP_PHONE || null,
    callmebot_apikey: process.env.CALLMEBOT_APIKEY || null
  }
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;

const VALID_STATUS = new Set(['DURESS_LOGIN', 'PIX_ATTEMPT', 'LOCATION_UPDATE']);

// Estado em memoria por aparelho: 'ALERT' (em perigo) | 'SAFE' (desarmado)
// Producao: guardar em banco (o Render gratis reinicia e zera a memoria).
const deviceState = new Map();

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/* ============================================================
   APP
   ============================================================ */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname, { index: 'fake_bank.html' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ============================================================
   VALIDACAO
   ============================================================ */
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function isValidToken(id, tok) {
  if (typeof tok === 'string' && safeEqual(SHARED_TOKEN, tok)) return true; // token compartilhado
  const exp = DEVICE_TOKENS[id];
  return Boolean(exp) && safeEqual(exp, tok);
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'body invalido';
  for (const k of ['device_id', 'auth_token', 'status', 'battery_level', 'location'])
    if (!(k in p)) return 'campo ausente: ' + k;
  if (typeof p.device_id !== 'string' || !p.device_id) return 'device_id invalido';
  if (typeof p.auth_token !== 'string' || !p.auth_token) return 'auth_token invalido';
  if (!VALID_STATUS.has(p.status)) return 'status invalido';
  if (p.battery_level !== null && (!isNum(p.battery_level) || p.battery_level < 0 || p.battery_level > 100))
    return 'battery_level invalido';
  const l = p.location;
  if (!l || typeof l !== 'object') return 'location invalido';
  if (!('latitude' in l) || !('longitude' in l) || !('timestamp' in l)) return 'location incompleto';
  if (l.latitude !== null && (!isNum(l.latitude) || Math.abs(l.latitude) > 90)) return 'latitude invalida';
  if (l.longitude !== null && (!isNum(l.longitude) || Math.abs(l.longitude) > 180)) return 'longitude invalida';
  if (Number.isNaN(Date.parse(l.timestamp))) return 'timestamp invalido';
  return null;
}

/* ============================================================
   ENDPOINT: ALERTA SILENCIOSO
   ============================================================ */
app.post('/api/v1/security/stealth-alert', (req, res) => {
  const p = req.body;
  const err = validatePayload(p);
  if (err) { console.warn('[REJEITADO] ' + err); return res.status(400).json({ ok: false }); }
  if (!isValidToken(p.device_id, p.auth_token)) {
    console.warn('[AUTH FALHOU] device_id=' + p.device_id);
    return res.status(401).json({ ok: false });
  }
  res.status(200).json({ ok: true }); // resposta imediata
  setImmediate(() => processAlert(p).catch(e => console.error('[PIPELINE ERRO]', e.message)));
});

/* ============================================================
   ENDPOINT: DESARME (usado pelo dono, ja em seguranca)
   ============================================================ */
app.post('/api/v1/security/disarm', async (req, res) => {
  const { device_id, auth_token, disarm_pin } = req.body || {};
  if (!device_id || !auth_token || !disarm_pin)
    return res.status(400).json({ ok: false, msg: 'Dados incompletos' });
  if (!isValidToken(device_id, auth_token) || !safeEqual(DISARM_PIN, disarm_pin)) {
    console.warn('[DESARME NEGADO] device_id=' + device_id);
    return res.status(401).json({ ok: false, msg: 'Senha incorreta' });
  }

  deviceState.set(device_id, 'SAFE');
  const event = { received_at: new Date().toISOString(), device_id, status: 'DISARMED' };
  console.log('\n[DESARMADO] ' + device_id + ' em ' + event.received_at);
  await fs.promises.appendFile(LOG_FILE, JSON.stringify(event) + '\n', 'utf8').catch(() => {});

  res.json({ ok: true, msg: 'Modo antifurto desativado' });

  const c = EMERGENCY_CONTACTS[device_id];
  if (c) dispatchAll(c, 'SITUACAO NORMALIZADA\nO dono desativou o modo antifurto.\nHorario: ' + fmtTime(event.received_at))
    .catch(e => console.error('[MENSAGERIA ERRO]', e.message));
});

/* Pagina simples de desarme (o dono abre de qualquer celular) */
app.get('/desarmar', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Desarmar</title>
<style>body{font-family:Roboto,sans-serif;background:#111;color:#fff;display:flex;min-height:100vh;
align-items:center;justify-content:center;margin:0;padding:16px}
.box{width:100%;max-width:340px}h1{font-size:20px}input,button{width:100%;padding:14px;margin-top:12px;
border-radius:10px;border:1px solid #444;font-size:16px;box-sizing:border-box}input{background:#222;color:#fff}
button{background:#2e7d32;color:#fff;border:none;font-weight:600}#msg{margin-top:14px}</style></head>
<body><div class="box"><h1>Desativar modo antifurto</h1>
<input id="pin" type="password" inputmode="numeric" placeholder="Senha de desarme">
<button id="go">Desativar</button><div id="msg"></div></div>
<script>
document.getElementById('go').onclick = async () => {
  const msg = document.getElementById('msg');
  msg.textContent = 'Enviando...';
  try {
    const r = await fetch('/api/v1/security/disarm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'DEV-ANDROID-0001', auth_token: 'tok_demo_9f8e7d6c5b4a',
                             disarm_pin: document.getElementById('pin').value })
    });
    const j = await r.json();
    msg.textContent = j.msg || (j.ok ? 'OK' : 'Erro');
  } catch (e) { msg.textContent = 'Falha de conexao'; }
};
</script></body></html>`);
});

/* Rota de verificacao de versao (para confirmar deploy) */
app.get('/version', (req, res) => {
  res.json({ version: 'v3-location-skip', deployed_at: new Date().toISOString() });
});

/* ============================================================
   ENDPOINT: TRILHA (pagina de acompanhamento ao vivo)
   ============================================================ */
app.get('/api/v1/track', (req, res) => {
  const id = req.query.id;
  if (TRACK_KEY && req.query.k !== TRACK_KEY) return res.status(401).json({ ok: false });
  res.json({ ok: true, device_id: id, state: deviceState.get(id) || 'ALERT', fixes: tracks.get(id) || [] });
});

/* ============================================================
   MEMBROS (familia) + "Localizar agora"
   ============================================================ */
const members = new Map();     // account -> Map(id -> { name })
const locateReq = new Set();   // device_ids que pediram posicao agora

// Cadastra/atualiza um membro de uma conta
app.post('/api/v1/register', (req, res) => {
  const { account, device_id, name } = req.body || {};
  if (!account || !device_id) return res.status(400).json({ ok: false });
  if (!members.has(account)) members.set(account, new Map());
  members.get(account).set(device_id, { name: (name || device_id).slice(0, 40) });
  console.log('[MEMBRO] ' + account + ' <- ' + device_id + ' (' + name + ')');
  res.json({ ok: true });
});

// Lista membros + ultima posicao de cada um
app.get('/api/v1/members', (req, res) => {
  const account = req.query.account;
  const m = members.get(account) || new Map();
  const list = [...m.entries()].map(([id, info]) => {
    const fixes = tracks.get(id) || [];
    return { id, name: info.name, last: fixes.length ? fixes[fixes.length - 1] : null, fixes };
  });
  res.json({ ok: true, account, members: list });
});

// Painel pede uma posicao fresca de um aparelho
app.post('/api/v1/locate', (req, res) => {
  const { device_id } = req.body || {};
  if (!device_id) return res.status(400).json({ ok: false });
  locateReq.add(device_id);
  res.json({ ok: true });
});

// O app de rastreio pergunta se ha pedido pendente (e limpa)
app.get('/api/v1/locate-check', (req, res) => {
  const id = req.query.id;
  const want = locateReq.has(id);
  if (want) locateReq.delete(id);
  res.json({ ok: true, locate: want });
});

/* ============================================================
   PIPELINE
   ============================================================ */
async function processAlert(p) {
  // Novo login de coacao reativa o modo alerta
  if (p.status === 'DURESS_LOGIN') deviceState.set(p.device_id, 'ALERT');
  const state = deviceState.get(p.device_id) || 'ALERT';

  const event = {
    received_at: new Date().toISOString(),
    device_id: p.device_id,
    status: p.status,
    state,
    battery_level: p.battery_level,
    location: p.location,
    maps_link: buildMapsLink(p.location)
  };
  logToConsole(event);
  pushFix(p.device_id, {
    lat: p.location.latitude, lng: p.location.longitude,
    acc: p.location.accuracy_m ?? null, battery: p.battery_level,
    ts: event.received_at, status: p.status, state
  });
  await fs.promises.appendFile(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');

  // Rastreio continuo (familia/empresa): so alimenta o painel, nao avisa contato
  if (p.status === 'LOCATION_UPDATE') return;

  // Desarmado: so registra, nao avisa o contato
  if (state === 'SAFE') { console.log('[DESARMADO] alerta registrado sem envio'); return; }

  const c = EMERGENCY_CONTACTS[p.device_id];
  if (!c) { console.warn('[SEM CONTATO] ' + p.device_id); return; }
  await dispatchAll(c, buildText(event));
}

function buildMapsLink(loc) {
  if (!loc || loc.latitude === null || loc.longitude === null) return null;
  return 'https://www.google.com/maps?q=' + loc.latitude + ',' + loc.longitude;
}

function pushFix(id, fix) {
  if (!tracks.has(id)) tracks.set(id, []);
  const arr = tracks.get(id);
  arr.push(fix);
  if (arr.length > MAX_FIXES) arr.splice(0, arr.length - MAX_FIXES);
}
function trackLink(id) {
  return BASE_URL + '/acompanhar.html?id=' + encodeURIComponent(id) +
         (TRACK_KEY ? '&k=' + encodeURIComponent(TRACK_KEY) : '');
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function buildText(ev) {
  const motivo = {
    DURESS_LOGIN: 'Senha de coacao utilizada',
    PIX_ATTEMPT: 'Tentativa de Pix no ambiente isca',
    LOCATION_UPDATE: 'Atualizacao de localizacao'
  }[ev.status];
  return 'ALERTA DE SEGURANCA\n' + motivo + '.\n' +
         'Horario: ' + fmtTime(ev.location.timestamp) + '\n' +
         'Bateria: ' + (ev.battery_level ?? 'n/d') + '%\n' +
         'Acompanhar ao vivo: ' + trackLink(ev.device_id) + '\n' +
         'Local agora: ' + (ev.maps_link ?? 'indisponivel');
}

function logToConsole(e) {
  console.log('\n================ STEALTH ALERT ================');
  console.log('Recebido : ' + e.received_at);
  console.log('Device   : ' + e.device_id + '  [' + e.state + ']');
  console.log('Status   : ' + e.status);
  console.log('Bateria  : ' + (e.battery_level ?? 'n/d') + '%');
  console.log('GPS em   : ' + e.location.timestamp);
  console.log('Coords   : ' + (e.location.latitude ?? 'n/d') + ', ' + (e.location.longitude ?? 'n/d') +
              (e.location.accuracy_m ? ' (+-' + e.location.accuracy_m + 'm)' : ''));
  console.log('Maps     : ' + (e.maps_link ?? 'localizacao indisponivel'));
  console.log('===============================================');
}

/* ============================================================
   MENSAGERIA: envia em paralelo por todos os canais configurados
   ============================================================ */
async function dispatchAll(contact, text) {
  const jobs = [];
  if (TELEGRAM_BOT_TOKEN && contact.telegram_chat_id) jobs.push(sendTelegram(contact, text));
  if (contact.whatsapp_phone && contact.callmebot_apikey) jobs.push(sendWhatsApp(contact, text));

  if (jobs.length === 0) {
    console.log('[MENSAGERIA SIMULADA] -> ' + contact.name + '\n' + text);
    return;
  }
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status === 'rejected') console.error('[MENSAGERIA ERRO]', r.reason.message); });
}

async function sendTelegram(c, text) {
  const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c.telegram_chat_id, text })
  });
  console.log('[TELEGRAM] -> ' + c.name + ': HTTP ' + r.status);
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ' ' + await r.text());
}

async function sendWhatsApp(c, text) {
  const url = 'https://api.callmebot.com/whatsapp.php' +
    '?phone=' + encodeURIComponent(c.whatsapp_phone) +
    '&text=' + encodeURIComponent(text) +
    '&apikey=' + encodeURIComponent(c.callmebot_apikey);
  const r = await fetch(url);
  console.log('[WHATSAPP] -> ' + c.name + ': HTTP ' + r.status);
  if (!r.ok) throw new Error('WhatsApp HTTP ' + r.status);
}

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, () => {
  console.log('Servidor ativo na porta ' + PORT);
  console.log('Telegram: ' + (TELEGRAM_BOT_TOKEN ? 'ON' : 'OFF') +
              ' | WhatsApp: ' + (process.env.CALLMEBOT_APIKEY ? 'ON' : 'OFF'));
});
