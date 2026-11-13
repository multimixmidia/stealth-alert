import { registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

/* global L, __TEST_BASE__ */
const BASE = (typeof __TEST_BASE__ !== 'undefined') ? __TEST_BASE__ : 'https://stealth-alert.onrender.com';
const ENDPOINT = BASE + '/api/v1/security/stealth-alert';
const REL = 'https://github.com/multimixmidia/stealth-alert/releases/download/';
const APP_APK = REL + 'tracker-latest/multimix.apk';      // este app
const ANTIFURTO_APK = REL + 'app-latest/antifurto.apk';    // banco falso em formato de app
const CONFIG_URL = BASE + '/config.html';
const $ = id => document.getElementById(id);

/* ---------- estado guardado no aparelho ---------- */
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(_){ return null; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(_){} },
  del(k){ try { localStorage.removeItem(k); } catch(_){} }
};
let session = store.get('session');   // { access_token, refresh_token, expires_at }
let device  = store.get('device');    // { id, token }
let me = null;                        // { profile, contacts, family_code, ... }
let count = 0, watcherId = null, lastLoc = null, started = false, famTimer = null, currentTab = null;

/* ---------- utilidades ---------- */
const digits = s => String(s || '').replace(/\D/g, '');
function fmtPhone(p){ const d = digits(p); return d.length === 11 ? '(' + d.slice(0,2) + ') ' + d.slice(2,7) + '-' + d.slice(7) : d; }
function waNumber(p){ const d = digits(p); return d.length <= 11 ? '55' + d : d; }
function ago(iso){
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'há ' + s + 's'; if (s < 3600) return 'há ' + Math.round(s/60) + ' min'; return 'há ' + Math.round(s/3600) + ' h';
}
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
let toastTimer = null;
function toast(t){ const b = $('toast'); b.textContent = t; b.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { b.hidden = true; }, 3000); }
function openExternal(url){ window.open(url, '_blank'); }
async function copy(text){
  try { await navigator.clipboard.writeText(text); toast('Copiado'); }
  catch(_){
    const t = el('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast('Copiado'); } catch(e){ toast('Não foi possível copiar'); }
    t.remove();
  }
}
const whats = (text, phone) => openExternal('https://wa.me/' + (phone ? waNumber(phone) : '') + '?text=' + encodeURIComponent(text));

/* ---------- API com sessão ---------- */
async function refreshSession(){
  if (!session || !session.refresh_token) return false;
  try {
    const r = await fetch(BASE + '/api/v2/refresh', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) return false;
    session = (await r.json()).session; store.set('session', session);
    return true;
  } catch(_){ return false; }
}
async function api(method, path, body, retry = true){
  if (session && session.expires_at - Date.now() < 60000 && retry) await refreshSession();
  const r = await fetch(BASE + path, {
    method, cache: 'no-store',
    headers: { 'Content-Type':'application/json', ...(session ? { Authorization: 'Bearer ' + session.access_token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 && session && retry){
    if (await refreshSession()) return api(method, path, body, false);
    logout(); throw new Error('Sessão expirada. Entre de novo.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.msg || ('Erro ' + r.status));
  return d;
}

/* ============================================================
   ENTRAR / CRIAR CONTA
   ============================================================ */
let signupMode = false;
function setAuthMode(signup){
  signupMode = signup;
  $('authTitle').textContent = signup ? 'Criar conta' : 'Entrar';
  $('btnAuth').textContent = signup ? 'Criar conta' : 'Entrar';
  $('btnSwitch').textContent = signup ? 'Já tem conta? Entrar' : 'Não tem conta? Criar conta';
  $('signupOnly').hidden = !signup; $('signupOnly2').hidden = !signup;
  $('aSenha').autocomplete = signup ? 'new-password' : 'current-password';
  $('authErr').textContent = '';
}
async function doAuth(){
  const email = $('aEmail').value.trim(), password = $('aSenha').value;
  const body = { email, password };
  if (signupMode){
    body.name = $('aNome').value.trim(); body.phone = digits($('aFone').value);
    const code = $('aCodigo').value.trim(); if (code) body.family_code = code;
    if (!body.name){ $('authErr').textContent = 'Informe seu nome.'; return; }
    if (body.phone.length < 10){ $('authErr').textContent = 'Informe o celular com DDD.'; return; }
    if (password.length < 8){ $('authErr').textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
  }
  if (!email || !password){ $('authErr').textContent = 'Informe e-mail e senha.'; return; }
  $('btnAuth').disabled = true; $('authErr').textContent = 'Conectando… (pode levar até 1 minuto na primeira vez)';
  try {
    const d = await api('POST', signupMode ? '/api/v2/signup' : '/api/v2/login', body);
    session = d.session; store.set('session', session);
    $('aSenha').value = ''; $('authErr').textContent = '';
    await enterApp(true);
  } catch(e){ $('authErr').textContent = e.message === 'Failed to fetch' ? 'Sem conexão com o servidor.' : e.message; }
  $('btnAuth').disabled = false;
}
function logout(){
  if (watcherId){ BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => {}); watcherId = null; }
  started = false; clearInterval(famTimer); famTimer = null;
  session = null; device = null; me = null; count = 0;
  store.del('session'); store.del('device');
  $('app').hidden = true; $('auth').hidden = false; setAuthMode(false);
}

/* ============================================================
   CADASTRO AUTOMÁTICO DO APARELHO + RASTREIO (sem Iniciar/Parar)
   ============================================================ */
async function linkDevice(){
  if (!device || !device.id) device = { id: 'FAM-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), token: null };
  const d = await api('POST', '/api/v2/device', { device_id: device.id });
  device.token = d.token; store.set('device', device);
}
async function battery(){ try { if (navigator.getBattery) return Math.round((await navigator.getBattery()).level * 100); } catch(_){} return null; }

async function send(loc, retry = true){
  try {
    if (!device || !device.token) await linkDevice();
    const r = await fetch(ENDPOINT, {
      method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({
        device_id: device.id, auth_token: device.token, status:'LOCATION_UPDATE', battery_level: await battery(),
        location: { latitude: loc.latitude, longitude: loc.longitude, accuracy_m: Math.round(loc.accuracy || 0),
                    timestamp: new Date(loc.time || Date.now()).toISOString() }
      })
    });
    if (r.status === 401 && retry){ device.token = null; return send(loc, false); }
    if (!r.ok) throw new Error('servidor HTTP ' + r.status);
    count++;
    $('count').textContent = count;
    $('last').textContent = loc.latitude.toFixed(5) + ', ' + loc.longitude.toFixed(5);
    $('upd').textContent = new Date().toLocaleTimeString('pt-BR');
    $('err').textContent = '';
  } catch(e){ $('err').textContent = 'Falha no envio: ' + e.message; }
}
async function freshFix(){
  try {
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy:true, timeout:9000, maximumAge:0 });
    lastLoc = { latitude:p.coords.latitude, longitude:p.coords.longitude, accuracy:p.coords.accuracy, time:p.timestamp };
    return lastLoc;
  } catch(_){ return null; }
}
async function startTracking(){
  if (started || !session) return;
  started = true;
  $('status').textContent = 'Iniciando…';
  const first = await freshFix();
  if (first) send(first);
  try {
    watcherId = await BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Rastreamento ativo', backgroundTitle: 'Multimix',
      requestPermissions: true, stale: false, distanceFilter: 20
    }, (location, error) => {
      if (error){
        if (error.code === 'NOT_AUTHORIZED') $('err').textContent = 'Permissão negada. Ative "Permitir o tempo todo".';
        $('status').textContent = 'Erro: ' + error.code; return;
      }
      $('status').textContent = 'Rastreando em segundo plano';
      if (location){ lastLoc = location; send(location); }
    });
  } catch(e){
    started = false;
    $('status').textContent = 'Falha ao iniciar'; $('err').textContent = e.message;
    return;
  }
  pollLocate();
}
// Responde ao "Localizar agora" pedido por um familiar
async function pollLocate(){
  if (!session || !device) return;
  try {
    const r = await fetch(BASE + '/api/v1/locate-check?id=' + encodeURIComponent(device.id), { cache:'no-store' });
    if ((await r.json()).locate){ const loc = await freshFix(); if (loc) send(loc); else if (lastLoc) send(lastLoc); }
  } catch(_){}
  setTimeout(pollLocate, 8000);
}

/* ============================================================
   BOTÃO DE EMERGÊNCIA (pânico) — envia o alerta aos contatos
   ============================================================ */
async function panicSend(retry = true){
  if (!device || !device.token) { try { await linkDevice(); } catch(_){ return false; } }
  const loc = await freshFix() || lastLoc;
  try {
    const r = await fetch(ENDPOINT, {
      method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({
        device_id: device.id, auth_token: device.token, status:'PANIC', battery_level: await battery(),
        location: loc
          ? { latitude: loc.latitude, longitude: loc.longitude, accuracy_m: Math.round(loc.accuracy || 0), timestamp: new Date(loc.time || Date.now()).toISOString() }
          : { latitude: null, longitude: null, timestamp: new Date().toISOString() }
      })
    });
    if (r.status === 401 && retry){ device.token = null; return panicSend(false); }
    return r.ok;
  } catch(_){ return false; }
}
function setupPanic(){
  const b = $('btnPanic'); if (!b) return;
  const label = 'Segure 3s para enviar alerta';
  let timer = null, firing = false;
  const cancel = () => { if (timer){ clearInterval(timer); timer = null; if (!firing) b.textContent = label; } };
  const start = (e) => {
    e.preventDefault(); if (firing || timer) return;
    let left = 3; b.textContent = 'Mantenha pressionado… ' + left;
    timer = setInterval(() => {
      left--;
      if (left > 0){ b.textContent = 'Mantenha pressionado… ' + left; }
      else { clearInterval(timer); timer = null; fire(); }
    }, 1000);
  };
  async function fire(){
    firing = true; b.disabled = true; b.textContent = 'Enviando alerta…'; $('panicMsg').textContent = '';
    const ok = await panicSend();
    b.disabled = false; firing = false; b.textContent = label;
    $('panicMsg').style.color = ok ? 'var(--ok)' : 'var(--bad)';
    $('panicMsg').textContent = ok ? 'Alerta enviado aos seus contatos.' : 'Falha ao enviar. Tente de novo.';
    toast(ok ? 'Alerta de emergência enviado' : 'Falha ao enviar o alerta');
  }
  ['pointerdown','touchstart'].forEach(ev => b.addEventListener(ev, start));
  ['pointerup','pointerleave','pointercancel','touchend','touchcancel'].forEach(ev => b.addEventListener(ev, cancel));
}

/* ============================================================
   JANELA DE EDIÇÃO (contato ou familiar)
   ============================================================ */
function editDialog(title, name, phone, onSave){
  $('mTitle').textContent = title; $('mNome').value = name || ''; $('mFone').value = fmtPhone(phone); $('mErr').textContent = '';
  $('modal').hidden = false;
  $('mCancel').onclick = () => { $('modal').hidden = true; };
  $('mOk').onclick = async () => {
    const n = $('mNome').value.trim(), p = digits($('mFone').value);
    if (!n){ $('mErr').textContent = 'Informe o nome.'; return; }
    $('mOk').disabled = true;
    try { await onSave(n, p); $('modal').hidden = true; } catch(e){ $('mErr').textContent = e.message; }
    $('mOk').disabled = false;
  };
}

/* ============================================================
   ABA CADASTRO
   ============================================================ */
function inviteText(c){
  return 'Olá, ' + c.name + '! ' + me.profile.name + ' te cadastrou para receber alertas de segurança. ' +
         'Para ativar, abra este link e toque em INICIAR no Telegram: ' + c.invite_link;
}
function familyText(){
  return 'Entre na família de ' + me.profile.name + ' no Multimix (mapa da família e alerta de segurança).\n' +
         '1) Instale o app: ' + APP_APK + '\n2) Toque em "Criar conta" e use o código da família: ' + me.family_code;
}
function renderContacts(){
  const list = me.contacts || [], box = $('cList');
  box.textContent = '';
  $('cCount').textContent = '(' + list.length + ' de ' + me.max_contacts + ')';
  $('cForm').hidden = list.length >= me.max_contacts;
  if (!list.length) box.appendChild(el('div', 'note', 'Nenhum contato ainda. Cadastre quem deve ser avisado.'));
  list.forEach(c => {
    const it = el('div', 'item');
    const nm = el('div', 'nm', c.name);
    nm.appendChild(el('span', 'chip ' + (c.active ? 'on' : 'wait'), c.active ? 'Ativo' : 'Aguardando aceitar'));
    it.appendChild(nm);
    it.appendChild(el('div', 'sub', fmtPhone(c.phone)));
    const row = el('div', 'row2');
    if (!c.active){
      const b1 = el('button', 'green', 'Enviar convite');
      b1.onclick = () => c.invite_link ? whats(inviteText(c), c.phone) : toast('Telegram ainda não configurado no servidor');
      const b2 = el('button', '', 'Copiar link');
      b2.onclick = () => c.invite_link ? copy(inviteText(c)) : toast('Telegram ainda não configurado no servidor');
      row.appendChild(b1); row.appendChild(b2);
    }
    const b3 = el('button', '', 'Editar');
    b3.onclick = () => editDialog('Editar contato', c.name, c.phone, async (name, phone) => {
      await api('PUT', '/api/v2/contacts/' + c.id, { name, phone }); await loadMe();
    });
    const b4 = el('button', 'danger', 'Excluir');
    b4.onclick = async () => {
      if (!confirm('Excluir o contato ' + c.name + '? Ele deixa de receber seus alertas.')) return;
      try { await api('DELETE', '/api/v2/contacts/' + c.id); await loadMe(); } catch(e){ $('cMsg').textContent = e.message; }
    };
    row.appendChild(b3); row.appendChild(b4);
    it.appendChild(row); box.appendChild(it);
  });
}
async function loadMe(){
  me = await api('GET', '/api/v2/me');
  $('pNome').value = me.profile.name; $('pFone').value = fmtPhone(me.profile.phone);
  $('famCode').textContent = me.family_code;
  renderContacts();
  updatePanicHint();
}
function updatePanicHint(){
  const h = $('panicHint'); if (!h || !me) return;
  const active = (me.contacts || []).filter(c => c.active).length;
  if (active) { h.textContent = ''; }
  else { h.style.color = 'var(--warn)'; h.textContent = 'Nenhum contato ativo ainda. Cadastre e ative contatos na aba Cadastro para que o alerta chegue a alguém.'; }
}
async function saveProfile(){
  $('perfilMsg').textContent = '';
  try {
    await api('PUT', '/api/v2/me', { name: $('pNome').value.trim(), phone: digits($('pFone').value) });
    await loadMe(); toast('Dados salvos');
  } catch(e){ $('perfilMsg').textContent = e.message; }
}
async function addContact(){
  $('cMsg').textContent = '';
  try {
    await api('POST', '/api/v2/contacts', { name: $('cNome').value.trim(), phone: digits($('cFone').value) });
    $('cNome').value = ''; $('cFone').value = '';
    await loadMe(); toast('Contato adicionado. Envie o convite para ativar.');
  } catch(e){ $('cMsg').textContent = e.message; }
}

/* ============================================================
   ABA FAMÍLIA (mapa + lista com editar/excluir)
   ============================================================ */
const COLORS = ['#2f9e6f', '#3b82f6', '#e0a13a', '#c2577a', '#8b6fd6', '#3ab7c2'];
let map = null; const markers = {}; let centered = false;
function initMap(){
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl:true }).setView([-15.78, -47.92], 4);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom:19, attribution:'Tiles © Esri' }).addTo(map);
}
async function fetchMembers(){ return (await api('GET', '/api/v2/family')).members || []; }

// "Localizar agora" tambem serve de teste: se o aparelho responde, esta ligado e com internet;
// se nao responde em ~30s, esta offline ou desligado -> usar o localizador da marca.
async function locate(id, btn){
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Solicitando…';
  let before = null;
  try { const m = (await fetchMembers()).find(x => x.device_id === id); before = m && m.last && m.last.ts; } catch(_){}
  try { await fetch(BASE + '/api/v1/locate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ device_id:id }) }); } catch(_){}
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 32000){
    await new Promise(r => setTimeout(r, 5000));
    try { const m = (await fetchMembers()).find(x => x.device_id === id); if (m && m.last && m.last.ts !== before){ ok = true; break; } } catch(_){}
  }
  btn.disabled = false; btn.textContent = old;
  toast(ok ? 'Posição atualizada ✓' : 'Sem resposta — aparelho offline ou desligado. Use o localizador da marca abaixo.');
  loadFamily();
}
function renderFamily(list){
  const box = $('fList'); box.textContent = '';
  if (!list.length) box.appendChild(el('div', 'note', 'Ninguém no mapa ainda.'));
  const bounds = [], seen = {};
  list.forEach((m, i) => {
    const color = COLORS[i % COLORS.length];
    const it = el('div', 'item');
    it.appendChild(el('div', 'nm', m.name + (m.me ? ' (você)' : '')));
    it.appendChild(el('div', 'sub', (m.phone ? fmtPhone(m.phone) + ' · ' : '') +
      (m.last ? ago(m.last.ts) + (m.last.battery != null ? ' · bateria ' + m.last.battery + '%' : '') : 'sem posição ainda')));
    const row = el('div', 'row2');
    const b1 = el('button', 'green', 'Localizar agora'); b1.onclick = () => locate(m.device_id, b1);
    const b2 = el('button', '', 'Editar');
    b2.onclick = () => editDialog('Editar ' + m.name, m.name, m.phone, async (name, phone) => {
      await api('PUT', '/api/v2/family/' + m.device_id, { name, phone }); await loadFamily(); if (m.me) await loadMe();
    });
    row.appendChild(b1); row.appendChild(b2);
    if (!m.me){
      const b3 = el('button', 'danger', 'Excluir');
      b3.onclick = async () => {
        if (!confirm('Excluir ' + m.name + ' da família? Ele sai do mapa e o histórico de posições dele é apagado.')) return;
        try { await api('DELETE', '/api/v2/family/' + m.device_id); await loadFamily(); } catch(e){ $('fMsg').textContent = e.message; }
      };
      row.appendChild(b3);
    }
    it.appendChild(row); box.appendChild(it);

    if (map && m.last && typeof m.last.lat === 'number'){
      const ll = [m.last.lat, m.last.lng]; bounds.push(ll); seen[m.device_id] = true;
      if (!markers[m.device_id])
        markers[m.device_id] = L.circleMarker(ll, { radius:9, color:'#fff', weight:3, fillColor:color, fillOpacity:1 }).addTo(map)
          .bindTooltip(m.name, { permanent:true, direction:'top', offset:[0,-6] });
      else markers[m.device_id].setLatLng(ll).setTooltipContent(m.name);
    }
  });
  Object.keys(markers).forEach(id => { if (!seen[id]){ markers[id].remove(); delete markers[id]; } });
  if (map && bounds.length && !centered){ try { map.fitBounds(bounds, { padding:[40,40], maxZoom:16 }); centered = true; } catch(_){} }
}
async function loadFamily(){
  try { renderFamily(await fetchMembers()); $('fMsg').textContent = ''; }
  catch(e){ $('fMsg').textContent = e.message; }
}

/* ============================================================
   ABAS
   ============================================================ */
function showTab(name){
  currentTab = name;
  document.querySelectorAll('.tab').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  clearInterval(famTimer); famTimer = null;
  if (name === 'familia'){
    try { initMap(); if (map) setTimeout(() => map.invalidateSize(), 50); } catch(_){}
    loadFamily(); famTimer = setInterval(loadFamily, 8000);
  }
  window.scrollTo(0, 0);
}
function antifurtoText(){
  return 'Proteção antifurto Multimix\n1) Configure o banco falso e coloque na tela inicial: ' + CONFIG_URL +
         '\n2) Opcional: app antifurto para instalar: ' + ANTIFURTO_APK;
}

async function enterApp(fresh){
  $('auth').hidden = true; $('app').hidden = false;
  showTab('posicao');
  $('status').textContent = 'Conectando…';
  try {
    await linkDevice();          // cadastro automático do aparelho
    await loadMe();
    if (fresh && !(me.contacts || []).length) showTab('cadastro');
  } catch(e){
    if (!session) return;        // sessão caiu: já voltou para a tela de entrada
    if (/outra conta/.test(e.message)){ device = null; store.del('device'); }   // aparelho era de outra conta: gera um novo
    $('err').textContent = e.message === 'Failed to fetch' ? 'Sem conexão com o servidor. Tentando de novo…' : e.message;
    setTimeout(() => { if (session && !me) enterApp(fresh); }, 15000);
    return;
  }
  startTracking();
}

/* ============================================================
   ACHAR O CELULAR DESLIGADO / SEM INTERNET
   Cada marca tem o seu recurso de fabrica; aqui detectamos o
   aparelho e levamos o cliente ao lugar certo de ativar.
   ============================================================ */
// Tira o modelo do user-agent (ex.: "Android 14; SM-A556E Build/..." -> "SM-A556E")
function deviceModel(ua){
  if (/iPhone/i.test(ua)) return 'iPhone';
  const m = /Android[\s\d.]+;\s*([^;)]+?)(?:\s+Build\/|\s*[;)])/i.exec(ua);
  if (!m) return '';
  return m[1].replace(/\s*Build.*$/i, '').trim();
}

function renderOffline(){
  const ua = navigator.userAgent || '';
  const isiOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSamsung = /samsung|SM-[A-Z0-9]+|GT-[A-Z0-9]+|Galaxy/i.test(ua);
  const isXiaomi  = /xiaomi|redmi|poco|mi\s/i.test(ua);
  const isMoto    = /moto|motorola/i.test(ua);
  const model = deviceModel(ua);

  let title, steps, btnTxt, href, note;
  if (isiOS){
    title = 'Achar o iPhone desligado ou sem internet';
    steps = ['Abra Ajustes e toque no seu nome, depois em "Buscar".',
             'Ligue "Buscar iPhone", "Rede do app Buscar" e "Enviar Última Localização".',
             'Confirme a compatibilidade: segure o botão lateral. Se a tela de desligar mostrar "iPhone localizável após desligar", seu aparelho acha até desligado.'];
    btnTxt = null;
    note = 'Do iPhone 11 em diante, ele é achado por algumas horas mesmo desligado ou em modo avião.';
  } else if (isSamsung){
    title = 'Achar o celular desligado ou sem internet (Samsung)';
    steps = ['Abra o app "Samsung Find" (ou SmartThings Find).',
             'Toque em Mais opções (⋮) → Configurações.',
             'Ligue "Busca off-line" para este aparelho (dá para proteger com um PIN de 6 dígitos).',
             'Confirme a compatibilidade: se nessa tela houver a opção de achar "mesmo desligado", seu modelo faz isso; senão, acha só sem internet, com o aparelho ligado.'];
    btnTxt = 'Abrir o Samsung Find'; href = 'https://findmymobile.samsung.com';
    note = 'Com a Busca off-line ligada, outros Galaxy por perto ajudam a localizar mesmo sem sinal.';
  } else {
    const marca = isXiaomi ? 'Xiaomi' : isMoto ? 'Motorola' : 'Android';
    title = 'Achar o celular desligado ou sem internet (' + marca + ')';
    steps = ['Abra o app "Buscar Meu Dispositivo" (Find Hub) do Google — já vem instalado.',
             'Entre com a conta Google deste celular e ligue "Buscar meu dispositivo".',
             'Em Rede do Buscar, escolha "com rede em todas as áreas".',
             'Confirme a compatibilidade: se aparecer a opção de localizar "mesmo desligado", seu modelo faz isso; senão, acha só sem internet, com o aparelho ligado.'];
    btnTxt = 'Abrir o Buscar do Google'; href = 'https://www.google.com/android/find';
    note = isXiaomi
      ? 'A Xiaomi também tem o "Encontrar dispositivo" na conta Mi — vale ligar os dois.'
      : 'A rede do Google acha o celular por aparelhos Android por perto, mesmo sem internet.';
  }

  $('offModel').textContent = model ? ('Seu aparelho: ' + model) : '';
  $('offTitle').textContent = title;
  const ol = $('offSteps'); ol.textContent = '';
  steps.forEach(s => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
  const btn = $('btnOffline');
  if (btnTxt){ btn.textContent = btnTxt; btn.href = href; btn.hidden = false; }
  else btn.hidden = true;
  $('offNote').textContent = note;
}

function init(){
  document.querySelectorAll('nav button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
  $('btnAuth').onclick = doAuth;
  $('btnSwitch').onclick = () => setAuthMode(!signupMode);
  $('btnPerfil').onclick = saveProfile;
  $('btnAddContato').onclick = addContact;
  $('btnFamZap').onclick = () => { if (me) whats(familyText()); };
  $('btnFamCopy').onclick = () => { if (me) copy(familyText()); };
  $('btnSair').onclick = () => { if (confirm('Sair da conta? O rastreio deste aparelho para até você entrar de novo.')) logout(); };
  $('lnkConfig').href = CONFIG_URL;
  $('lnkApk').href = ANTIFURTO_APK;
  $('btnAntiZap').onclick = () => whats(antifurtoText());
  $('btnAntiCopy').onclick = () => copy(antifurtoText());

  renderOffline();
  setupPanic();

  if (session && session.access_token) enterApp(false);
  else { $('auth').hidden = false; setAuthMode(false); }
}
init();
