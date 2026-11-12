/**
 * ============================================================
 * API v2 - contas, familia e contatos de alerta
 * ------------------------------------------------------------
 * Login/senha ficam no Supabase Auth (a senha nunca passa pelo
 * nosso banco: so o hash, guardado pelo Supabase).
 *
 * POST   /api/v2/signup            cria conta (+ perfil e familia)
 * POST   /api/v2/login             entra com e-mail e senha
 * POST   /api/v2/refresh           renova a sessao
 * GET    /api/v2/me                perfil + contatos + convites
 * PUT    /api/v2/me                edita nome/celular
 * POST   /api/v2/device            liga o aparelho a conta (token do aparelho)
 * GET    /api/v2/contacts          contatos de alerta (ate 5)
 * POST   /api/v2/contacts
 * PUT    /api/v2/contacts/:id
 * DELETE /api/v2/contacts/:id
 * GET    /api/v2/family            membros da familia + ultima posicao
 * PUT    /api/v2/family/:device_id edita membro
 * DELETE /api/v2/family/:device_id remove membro
 * POST   /api/v2/telegram/webhook  bot: /start CODIGO ativa o contato
 * ============================================================
 */
'use strict';

const crypto = require('crypto');

const MAX_CONTACTS = 5;
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE  = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DEVICE_RE = /^FAM-[a-z0-9]{6,24}$/;

module.exports = function mountV2(app, d) {
  const enc = encodeURIComponent;
  const hmac = (s) => crypto.createHmac('sha256', d.TOKEN_SECRET).update(String(s)).digest();
  const TG_SECRET = hmac('telegram-webhook').toString('hex').slice(0, 40);
  let botUsername = null;

  /* ---------- utilidades ---------- */
  const clean = (v, max) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
  const cleanPhone = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 15);
  const fail = (res, code, msg) => res.status(code).json({ ok: false, msg });

  // Codigo de convite da familia = id da familia (compactado) + assinatura do servidor
  function familyCode(familyId) {
    const raw = Buffer.from(familyId.replace(/-/g, ''), 'hex').toString('base64url');
    return raw + hmac('family:' + familyId).toString('base64url').slice(0, 8);
  }
  function parseFamilyCode(code) {
    const c = String(code || '').trim();
    if (!/^[A-Za-z0-9_-]{30}$/.test(c)) return null;
    const hex = Buffer.from(c.slice(0, 22), 'base64url').toString('hex');
    if (hex.length !== 32) return null;
    const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    return familyCode(id) === c ? id : null;
  }

  // Limite simples de tentativas por IP (contra forca bruta em login/cadastro)
  const hits = new Map();
  function limited(req, key, max) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const k = key + '|' + ip, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < 60000);
    arr.push(now); hits.set(k, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > max;
  }

  /* ---------- Supabase Auth (GoTrue) ---------- */
  async function auth(path, { method = 'GET', body, bearer } = {}) {
    const r = await fetch(d.SUPABASE_URL + '/auth/v1/' + path, {
      method,
      headers: {
        apikey: d.SUPABASE_KEY,
        Authorization: 'Bearer ' + (bearer || d.SUPABASE_KEY),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await r.text();
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json: json || {} };
  }
  const sessionOut = (j) => ({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000
  });

  /* ---------- banco ---------- */
  const one = async (q) => { const rows = await d.sb(q); return rows && rows.length ? rows[0] : null; };
  const getProfile = (userId) => one('sa_profiles?user_id=eq.' + enc(userId) + '&select=user_id,family_id,name,phone');
  const patch = (q, body) => d.sb(q, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const insert = (table, body) => d.sb(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const del = (q) => d.sb(q, { method: 'DELETE' });

  function contactOut(c) {
    return {
      id: c.id, name: c.name, phone: c.phone || '',
      active: Boolean(c.telegram_chat_id),
      invite_link: botUsername ? 'https://t.me/' + botUsername + '?start=' + c.invite_code : null
    };
  }
  const listContacts = async (userId) =>
    (await d.sb('contacts?owner=eq.' + enc(userId) + '&select=id,name,phone,invite_code,telegram_chat_id&order=created_at.asc') || []);

  /* ---------- guardas ---------- */
  function needDb(req, res, next) {
    if (!d.isDbReady()) return fail(res, 503, 'Banco de dados indisponivel. Tente de novo em instantes.');
    next();
  }
  const tokenCache = new Map(); // access_token -> { user_id, until }
  async function needUser(req, res, next) {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m) return fail(res, 401, 'Sessao ausente');
      const tok = m[1];
      let c = tokenCache.get(tok);
      if (!c || c.until < Date.now()) {
        const r = await auth('user', { bearer: tok });
        if (!r.ok || !r.json.id) { tokenCache.delete(tok); return fail(res, 401, 'Sessao expirada'); }
        c = { user_id: r.json.id, until: Date.now() + 60000 };
        if (tokenCache.size > 2000) tokenCache.clear();
        tokenCache.set(tok, c);
      }
      const profile = await getProfile(c.user_id);
      if (!profile) return fail(res, 401, 'Perfil nao encontrado');
      req.profile = profile;
      next();
    } catch (e) { console.error('[v2 auth]', e.message); fail(res, 500, 'Erro interno'); }
  }
  const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error('[v2]', req.path, e.message); fail(res, 500, 'Erro interno'); });

  /* ============================================================
     CONTA
     ============================================================ */
  app.post('/api/v2/signup', needDb, wrap(async (req, res) => {
    if (limited(req, 'signup', 5)) return fail(res, 429, 'Muitas tentativas. Aguarde um minuto.');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = clean(b.name, 40), phone = cleanPhone(b.phone);
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'E-mail invalido');
    if (password.length < 8 || password.length > 72) return fail(res, 400, 'A senha precisa ter de 8 a 72 caracteres');
    if (!name) return fail(res, 400, 'Informe seu nome');
    if (phone.length < 10) return fail(res, 400, 'Informe o celular com DDD');

    let familyId = crypto.randomUUID();
    if (b.family_code) {
      familyId = parseFamilyCode(b.family_code);
      if (!familyId) return fail(res, 400, 'Codigo da familia invalido');
    }

    const cr = await auth('admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    if (!cr.ok || !cr.json.id) {
      const code = cr.json.error_code || '';
      if (cr.status === 422 || /exist|registered/i.test(code + ' ' + (cr.json.msg || '')))
        return fail(res, 409, 'Este e-mail ja tem cadastro. Use Entrar.');
      console.error('[v2 signup]', cr.status, JSON.stringify(cr.json).slice(0, 200));
      return fail(res, 500, 'Nao foi possivel criar a conta');
    }
    const userId = cr.json.id;
    try {
      await insert('sa_profiles', { user_id: userId, family_id: familyId, name, phone });
    } catch (e) {
      await auth('admin/users/' + enc(userId), { method: 'DELETE' }).catch(() => {});
      throw e;
    }
    const lg = await auth('token?grant_type=password', { method: 'POST', body: { email, password } });
    if (!lg.ok) return fail(res, 500, 'Conta criada. Use Entrar.');
    res.json({ ok: true, session: sessionOut(lg.json) });
  }));

  app.post('/api/v2/login', needDb, wrap(async (req, res) => {
    if (limited(req, 'login', 10)) return fail(res, 429, 'Muitas tentativas. Aguarde um minuto.');
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    if (!EMAIL_RE.test(email) || !password) return fail(res, 400, 'Informe e-mail e senha');
    const lg = await auth('token?grant_type=password', { method: 'POST', body: { email, password } });
    if (!lg.ok || !lg.json.access_token) return fail(res, 401, 'E-mail ou senha incorretos');
    res.json({ ok: true, session: sessionOut(lg.json) });
  }));

  app.post('/api/v2/refresh', needDb, wrap(async (req, res) => {
    const rt = String((req.body || {}).refresh_token || '');
    if (!rt) return fail(res, 400, 'Sessao ausente');
    const lg = await auth('token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt } });
    if (!lg.ok || !lg.json.access_token) return fail(res, 401, 'Sessao expirada');
    res.json({ ok: true, session: sessionOut(lg.json) });
  }));

  app.get('/api/v2/me', needDb, needUser, wrap(async (req, res) => {
    const p = req.profile;
    res.json({
      ok: true,
      profile: { name: p.name, phone: p.phone || '', family_id: p.family_id },
      family_code: familyCode(p.family_id),
      contacts: (await listContacts(p.user_id)).map(contactOut),
      max_contacts: MAX_CONTACTS,
      telegram_ready: Boolean(botUsername)
    });
  }));

  app.put('/api/v2/me', needDb, needUser, wrap(async (req, res) => {
    const name = clean((req.body || {}).name, 40), phone = cleanPhone((req.body || {}).phone);
    if (!name) return fail(res, 400, 'Informe seu nome');
    if (phone.length < 10) return fail(res, 400, 'Informe o celular com DDD');
    await patch('sa_profiles?user_id=eq.' + enc(req.profile.user_id), { name, phone });
    // mantem o nome dos aparelhos da pessoa igual ao do perfil
    await patch('members?user_id=eq.' + enc(req.profile.user_id), { name, phone, updated_at: new Date().toISOString() });
    d.forgetMembers();
    res.json({ ok: true });
  }));

  /* ============================================================
     APARELHO: liga o aparelho a conta e devolve o token dele
     ============================================================ */
  app.post('/api/v2/device', needDb, needUser, wrap(async (req, res) => {
    const id = String((req.body || {}).device_id || '');
    if (!DEVICE_RE.test(id)) return fail(res, 400, 'Aparelho invalido');
    const p = req.profile;
    const row = await one('members?device_id=eq.' + enc(id) + '&select=device_id,user_id');
    if (row && row.user_id && row.user_id !== p.user_id) return fail(res, 409, 'Este aparelho pertence a outra conta');
    await d.sb('members', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ device_id: id, account: p.family_id, name: p.name, phone: p.phone || null,
                             user_id: p.user_id, updated_at: new Date().toISOString() })
    });
    d.forgetMembers();
    res.json({ ok: true, token: d.issueToken(id), family_id: p.family_id });
  }));

  /* ============================================================
     CONTATOS DE ALERTA (ate 5)
     ============================================================ */
  app.get('/api/v2/contacts', needDb, needUser, wrap(async (req, res) => {
    res.json({ ok: true, contacts: (await listContacts(req.profile.user_id)).map(contactOut) });
  }));

  app.post('/api/v2/contacts', needDb, needUser, wrap(async (req, res) => {
    const name = clean((req.body || {}).name, 40), phone = cleanPhone((req.body || {}).phone);
    if (!name) return fail(res, 400, 'Informe o nome do contato');
    if (phone.length < 10) return fail(res, 400, 'Informe o celular do contato com DDD');
    const cur = await listContacts(req.profile.user_id);
    if (cur.length >= MAX_CONTACTS) return fail(res, 400, 'Limite de ' + MAX_CONTACTS + ' contatos');
    const rows = await insert('contacts', {
      family_id: req.profile.family_id, owner: req.profile.user_id, name, phone,
      invite_code: crypto.randomBytes(12).toString('base64url')
    });
    res.json({ ok: true, contact: contactOut(rows[0]) });
  }));

  app.put('/api/v2/contacts/:id', needDb, needUser, wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 400, 'Contato invalido');
    const name = clean((req.body || {}).name, 40), phone = cleanPhone((req.body || {}).phone);
    if (!name) return fail(res, 400, 'Informe o nome do contato');
    if (phone.length < 10) return fail(res, 400, 'Informe o celular do contato com DDD');
    const rows = await patch('contacts?id=eq.' + enc(req.params.id) + '&owner=eq.' + enc(req.profile.user_id), { name, phone });
    if (!rows || !rows.length) return fail(res, 404, 'Contato nao encontrado');
    res.json({ ok: true, contact: contactOut(rows[0]) });
  }));

  app.delete('/api/v2/contacts/:id', needDb, needUser, wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 400, 'Contato invalido');
    await del('contacts?id=eq.' + enc(req.params.id) + '&owner=eq.' + enc(req.profile.user_id));
    res.json({ ok: true });
  }));

  /* ============================================================
     FAMILIA
     ============================================================ */
  const familyRow = (req) => one('members?device_id=eq.' + enc(req.params.device_id) +
    '&account=eq.' + enc(req.profile.family_id) + '&select=device_id,user_id');

  app.get('/api/v2/family', needDb, needUser, wrap(async (req, res) => {
    const rows = await d.sb('members?account=eq.' + enc(req.profile.family_id) +
      '&select=device_id,name,phone,user_id&order=name.asc') || [];
    const out = [];
    for (const m of rows) {
      const fixes = await d.getFixes(m.device_id);
      const last = fixes.length ? fixes[fixes.length - 1] : null;
      out.push({ device_id: m.device_id, name: m.name, phone: m.phone || '',
                 me: m.user_id === req.profile.user_id,
                 last: last ? { lat: last.lat, lng: last.lng, ts: last.ts, battery: last.battery } : null });
    }
    res.json({ ok: true, family_id: req.profile.family_id, members: out });
  }));

  app.put('/api/v2/family/:device_id', needDb, needUser, wrap(async (req, res) => {
    const name = clean((req.body || {}).name, 40), phone = cleanPhone((req.body || {}).phone);
    if (!name) return fail(res, 400, 'Informe o nome');
    const row = await familyRow(req);
    if (!row) return fail(res, 404, 'Membro nao encontrado');
    await patch('members?device_id=eq.' + enc(row.device_id), { name, phone: phone || null, updated_at: new Date().toISOString() });
    if (row.user_id) await patch('sa_profiles?user_id=eq.' + enc(row.user_id), phone ? { name, phone } : { name });
    d.forgetMembers();
    res.json({ ok: true });
  }));

  app.delete('/api/v2/family/:device_id', needDb, needUser, wrap(async (req, res) => {
    const row = await familyRow(req);
    if (!row) return fail(res, 404, 'Membro nao encontrado');
    if (row.user_id === req.profile.user_id) return fail(res, 400, 'Voce nao pode excluir o proprio aparelho');
    await del('members?device_id=eq.' + enc(row.device_id));
    await del('positions?device_id=eq.' + enc(row.device_id));
    // a pessoa removida sai da familia (passa a ter uma familia propria)
    if (row.user_id) await patch('sa_profiles?user_id=eq.' + enc(row.user_id), { family_id: crypto.randomUUID() });
    d.forgetMembers(row.device_id);
    res.json({ ok: true });
  }));

  /* ============================================================
     TELEGRAM: o contato toca no link, aperta Iniciar e fica ativo
     ============================================================ */
  async function tg(method, body) {
    const r = await fetch('https://api.telegram.org/bot' + d.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    return r.json().catch(() => ({}));
  }

  app.post('/api/v2/telegram/webhook', wrap(async (req, res) => {
    const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (got.length !== TG_SECRET.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TG_SECRET)))
      return res.sendStatus(401);
    res.sendStatus(200);
    const msg = (req.body || {}).message;
    if (!msg || !msg.chat || typeof msg.text !== 'string' || !d.isDbReady()) return;
    const chatId = String(msg.chat.id);
    const say = (text) => tg('sendMessage', { chat_id: chatId, text }).catch(() => {});
    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(msg.text.trim());
    if (start) {
      const c = await one('contacts?invite_code=eq.' + enc(start[1]) + '&select=id,owner');
      if (!c) return say('Convite nao encontrado. Peca um novo link para quem te convidou.');
      await patch('contacts?id=eq.' + enc(c.id), { telegram_chat_id: chatId, accepted_at: new Date().toISOString() });
      const owner = await getProfile(c.owner);
      return say('Pronto! Voce vai receber aqui os alertas de seguranca de ' + ((owner && owner.name) || 'quem te convidou') +
                 '.\nPara parar de receber, envie /sair');
    }
    if (/^\/sair\b/.test(msg.text.trim())) {
      await patch('contacts?telegram_chat_id=eq.' + enc(chatId), { telegram_chat_id: null, accepted_at: null });
      return say('Voce nao recebera mais alertas por aqui.');
    }
    if (/^\/start\b/.test(msg.text.trim()))
      return say('Para receber alertas, abra o link de convite que a pessoa te enviou.');
  }));

  async function initTelegram() {
    if (!d.TELEGRAM_BOT_TOKEN) { console.log('[v2] Telegram OFF (sem token)'); return; }
    try {
      const me = await tg('getMe');
      if (me.ok) botUsername = me.result.username;
      if (/^https:\/\//.test(d.BASE_URL)) {
        const wh = await tg('setWebhook', { url: d.BASE_URL + '/api/v2/telegram/webhook', secret_token: TG_SECRET, allowed_updates: ['message'] });
        console.log('[v2] Telegram @' + botUsername + ' webhook: ' + (wh.ok ? 'OK' : JSON.stringify(wh).slice(0, 120)));
      }
    } catch (e) { console.error('[v2] Telegram init', e.message); }
  }

  /* ---------- usado pelo pipeline de alerta do server.js ---------- */
  // Devolve os chats do Telegram dos contatos de quem e dono do aparelho
  async function alertChats(deviceId) {
    if (!d.isDbReady()) return [];
    try {
      const m = await one('members?device_id=eq.' + enc(deviceId) + '&select=user_id,name');
      if (!m || !m.user_id) return [];
      const cs = await d.sb('contacts?owner=eq.' + enc(m.user_id) + '&telegram_chat_id=not.is.null&select=name,telegram_chat_id') || [];
      return cs.map(c => ({ name: c.name, telegram_chat_id: c.telegram_chat_id, owner_name: m.name }));
    } catch (e) { console.error('[v2 alertChats]', e.message); return []; }
  }

  return { initTelegram, alertChats, botUsername: () => botUsername };
};
