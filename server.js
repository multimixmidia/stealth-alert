/**
 * SERVIDOR DE CONTINGENCIA - Stealth Alert (POC)
 * POST /api/v1/security/stealth-alert
 * Valida JSON + token, responde 200 e roda pipeline assincrono:
 * log (JSONL) + link Maps + mensagem ao contato de emergencia.
 * Requer Node.js 18+.
 */
'use strict';
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

/* ---------- CONFIG ---------- */
const PORT     = process.env.PORT || 3000;
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'stealth-alerts.jsonl');

// device_id -> token (producao: banco + hash)
const DEVICE_TOKENS = { 'DEV-ANDROID-0001': 'tok_demo_9f8e7d6c5b4a' };

// device_id -> contato de emergencia
const EMERGENCY_CONTACTS = {
  'DEV-ANDROID-0001': {
    name: 'Contato Familiar',
    phone: '+5500000000000',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || null
  }
};
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const VALID_STATUS = new Set(['DURESS_LOGIN', 'PIX_ATTEMPT', 'LOCATION_UPDATE']);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/* ---------- APP ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname, { index: 'fake_bank.html' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- VALIDACAO ---------- */
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function isValidToken(id, tok) {
  const exp = DEVICE_TOKENS[id];
  return Boolean(exp) && safeEqual(exp, tok);
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'body invalido';
  for (const k of ['device_id','auth_token','status','battery_level','location'])
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

/* ---------- ENDPOINT ---------- */
app.post('/api/v1/security/stealth-alert', (req, res) => {
  const p = req.body;
  const err = validatePayload(p);
  if (err) { console.warn('[REJEITADO] ' + err); return res.status(400).json({ ok: false }); }
  if (!isValidToken(p.device_id, p.auth_token)) {
    console.warn('[AUTH FALHOU] device_id=' + p.device_id);
    return res.status(401).json({ ok: false });
  }
  res.status(200).json({ ok: true });                // resposta imediata
  setImmediate(() => processAlert(p).catch(e => console.error('[PIPELINE ERRO]', e.message)));
});

/* ---------- PIPELINE ---------- */
async function processAlert(p) {
  const event = {
    received_at: new Date().toISOString(),
    device_id: p.device_id,
    status: p.status,
    battery_level: p.battery_level,
    location: p.location,
    maps_link: buildMapsLink(p.location)
  };
  logToConsole(event);
  await fs.promises.appendFile(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
  const msg = buildEmergencyMessage(event);
  if (msg) await dispatchMessage(msg);
}

function buildMapsLink(loc) {
  if (!loc || loc.latitude === null || loc.longitude === null) return null;
  return 'https://www.google.com/maps?q=' + loc.latitude + ',' + loc.longitude;
}

function logToConsole(e) {
  console.log('\n================ STEALTH ALERT ================');
  console.log('Recebido : ' + e.received_at);
  console.log('Device   : ' + e.device_id);
  console.log('Status   : ' + e.status);
  console.log('Bateria  : ' + (e.battery_level ?? 'n/d') + '%');
  console.log('GPS em   : ' + e.location.timestamp);
  console.log('Coords   : ' + (e.location.latitude ?? 'n/d') + ', ' + (e.location.longitude ?? 'n/d') +
              (e.location.accuracy_m ? ' (+-' + e.location.accuracy_m + 'm)' : ''));
  console.log('Maps     : ' + (e.maps_link ?? 'localizacao indisponivel'));
  console.log('===============================================');
}

function buildEmergencyMessage(ev) {
  const c = EMERGENCY_CONTACTS[ev.device_id];
  if (!c) { console.warn('[SEM CONTATO] ' + ev.device_id); return null; }
  const motivo = {
    DURESS_LOGIN: 'Senha de coacao utilizada',
    PIX_ATTEMPT: 'Tentativa de Pix no ambiente isca',
    LOCATION_UPDATE: 'Atualizacao de localizacao'
  }[ev.status];
  const text =
    'ALERTA DE SEGURANCA\n' + motivo + '.\n' +
    'Horario: ' + new Date(ev.location.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '\n' +
    'Bateria: ' + (ev.battery_level ?? 'n/d') + '%\n' +
    'Local: ' + (ev.maps_link ?? 'indisponivel');
  return { to: c, channel: TELEGRAM_BOT_TOKEN && c.telegram_chat_id ? 'telegram' : 'simulated', text };
}

async function dispatchMessage(m) {
  if (m.channel === 'telegram') {
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: m.to.telegram_chat_id, text: m.text })
    });
    console.log('[MENSAGERIA] Telegram -> ' + m.to.name + ': HTTP ' + r.status);
    return;
  }
  console.log('[MENSAGERIA SIMULADA] -> ' + m.to.name + ' (' + m.to.phone + ')\n' + m.text);
}

app.listen(PORT, () => {
  console.log('Servidor ativo: http://localhost:' + PORT);
  console.log('Log: ' + LOG_FILE);
});