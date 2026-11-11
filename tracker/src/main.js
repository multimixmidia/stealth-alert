import { registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const BASE = 'https://stealth-alert.onrender.com';
const ENDPOINT = BASE + '/api/v1/security/stealth-alert';
const ACCOUNT = 'familia';
const ANTIFURTO_APK = 'https://github.com/multimixmidia/stealth-alert/releases/download/app-latest/app-debug.apk';
const $ = id => document.getElementById(id);

let member = loadMember();
let count = 0, watcherId = null, lastLoc = null, started = false;

function loadMember(){ try { return JSON.parse(localStorage.getItem('member')); } catch(_){ return null; } }
function saveMember(m){ try { localStorage.setItem('member', JSON.stringify(m)); } catch(_){} }

/* ---------- Cadastro automatico ----------
   Registra no servidor e guarda o token DO APARELHO devolvido pelo servidor. */
async function register(){
  const r = await fetch(BASE + '/api/v1/register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ account: ACCOUNT, device_id: member.id, name: member.name, auth_token: member.token || null })
  });
  if (r.status === 401) throw new Error('Servidor recusou o cadastro deste aparelho');
  if (!r.ok) throw new Error('Cadastro falhou (HTTP ' + r.status + ')');
  const d = await r.json();
  if (d.token) { member.token = d.token; saveMember(member); }
}
async function ensureRegistered(){ if (!member.token) await register(); }

async function battery(){ try { if (navigator.getBattery) return Math.round((await navigator.getBattery()).level*100); } catch(_){} return null; }

async function send(loc){
  try {
    await ensureRegistered();
    const bat = await battery();
    const r = await fetch(ENDPOINT, {
      method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({
        device_id: member.id, auth_token: member.token, status:'LOCATION_UPDATE', battery_level: bat,
        location: {
          latitude: loc.latitude, longitude: loc.longitude,
          accuracy_m: Math.round(loc.accuracy || 0),
          timestamp: new Date(loc.time || Date.now()).toISOString()
        }
      })
    });
    if (!r.ok) throw new Error('servidor HTTP ' + r.status);
    count++;
    $('count').textContent = count;
    $('last').textContent = loc.latitude.toFixed(5) + ', ' + loc.longitude.toFixed(5);
    $('upd').textContent = new Date().toLocaleTimeString('pt-BR');
    $('err').textContent = '';
  } catch(e){ $('err').textContent = 'Falha no envio: ' + e.message; }
}

// Leitura fresca sob demanda (plugin oficial)
async function freshFix(){
  try {
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy:true, timeout:9000, maximumAge:0 });
    const loc = { latitude:p.coords.latitude, longitude:p.coords.longitude, accuracy:p.coords.accuracy, time:p.timestamp };
    lastLoc = loc; return loc;
  } catch(_){ return null; }
}

/* ---------- Rastreio: inicia sozinho, sem botoes ---------- */
async function startTracking(){
  if (started || !member) return;
  started = true;
  $('status').textContent = 'Iniciando...';
  try { await ensureRegistered(); } catch(e){ $('err').textContent = e.message; }

  const first = await freshFix();   // posicao imediata
  if (first) send(first);

  try {
    watcherId = await BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Rastreamento ativo', backgroundTitle: 'Multimix',
      requestPermissions: true, stale: false, distanceFilter: 20
    }, (location, error) => {
      if (error){
        if (error.code === 'NOT_AUTHORIZED') $('err').textContent = 'Permissao negada. Ative "Permitir o tempo todo".';
        $('status').textContent = 'Erro: ' + error.code; return;
      }
      $('status').textContent = 'Rastreando em segundo plano';
      if (location){ lastLoc = location; send(location); }
    });
  } catch(e){
    started = false;
    $('status').textContent = 'Falha ao iniciar';
    $('err').textContent = e.message;
    return;
  }
  pollLocate();
}

// Responde ao "Localizar agora" do painel da familia
async function pollLocate(){
  if (!member) return;
  try {
    const r = await fetch(BASE + '/api/v1/locate-check?id=' + encodeURIComponent(member.id), { cache:'no-store' });
    const d = await r.json();
    if (d.locate){
      const loc = await freshFix();
      if (loc) send(loc); else if (lastLoc) send(lastLoc);
    }
  } catch(_){}
  setTimeout(pollLocate, 8000);
}

/* ---------- Abas ---------- */
function showTab(name){
  document.querySelectorAll('.tab').forEach(s => s.hidden = s.id !== 'tab-' + name);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'familia' && !$('frameFamilia').src)
    $('frameFamilia').src = BASE + '/familia.html?account=' + ACCOUNT;
}

function showSetup(){
  $('setup').hidden = false;
  $('cadastrado').hidden = true;
}
function showCadastrado(){
  $('setup').hidden = true;
  $('cadastrado').hidden = false;
  $('who').textContent = member.name;
  $('novoNome').value = member.name;
}

/* ---------- Inicio ---------- */
function init(){
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('linkAntifurto').href = ANTIFURTO_APK;

  $('btnEntrar').onclick = () => {
    const name = ($('nome').value || '').trim();
    if (!name){ $('setupErr').textContent = 'Digite seu nome.'; return; }
    member = { id: 'FAM-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), name, account: ACCOUNT, token: null };
    saveMember(member);
    showCadastrado();
    showTab('posicao');
    startTracking();
  };

  $('btnRenomear').onclick = async () => {
    const name = ($('novoNome').value || '').trim();
    if (!name){ $('cadMsg').textContent = 'Digite um nome.'; return; }
    member.name = name; saveMember(member);
    $('who').textContent = name;
    try { await register(); $('cadMsg').textContent = 'Nome atualizado.'; }
    catch(e){ $('cadMsg').textContent = e.message; }
  };

  if (member && member.id){
    showCadastrado();
    showTab('posicao');
    startTracking();          // sem Parar/Iniciar: ja comeca ao abrir
  } else {
    showSetup();
    showTab('cadastro');
  }
}
init();
