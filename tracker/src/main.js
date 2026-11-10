import { registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const BASE = 'https://stealth-alert.onrender.com';
const ENDPOINT = BASE + '/api/v1/security/stealth-alert';
const AUTH_TOKEN = 'tok_demo_9f8e7d6c5b4a';
const ACCOUNT = 'familia';
const $ = id => document.getElementById(id);

let member = loadMember();
let count = 0, watcherId = null, lastLoc = null;

function loadMember(){ try { return JSON.parse(localStorage.getItem('member')); } catch(_){ return null; } }
function saveMember(m){ try { localStorage.setItem('member', JSON.stringify(m)); } catch(_){} }

async function register(){
  try {
    await fetch(BASE + '/api/v1/register', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ account: ACCOUNT, device_id: member.id, name: member.name })
    });
  } catch(_){}
}

async function battery(){ try { if (navigator.getBattery) return Math.round((await navigator.getBattery()).level*100); } catch(_){} return null; }

async function send(loc){
  try {
    const bat = await battery();
    await fetch(ENDPOINT, {
      method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({
        device_id: member.id, auth_token: AUTH_TOKEN, status:'LOCATION_UPDATE', battery_level: bat,
        location: {
          latitude: loc.latitude, longitude: loc.longitude,
          accuracy_m: Math.round(loc.accuracy || 0),
          timestamp: new Date(loc.time || Date.now()).toISOString()
        }
      })
    });
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

async function start(){
  if (watcherId) return;
  $('status').textContent = 'Iniciando…';
  await register();
  // posicao imediata ao iniciar (nao espera movimento)
  const first = await freshFix();
  if (first) send(first);
  try {
    watcherId = await BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Rastreamento ativo', backgroundTitle: 'Multimix Rastreio',
      requestPermissions: true, stale: false, distanceFilter: 20
    }, (location, error) => {
      if (error){
        if (error.code === 'NOT_AUTHORIZED') $('err').textContent = 'Permissão negada. Ative "Permitir sempre".';
        $('status').textContent = 'Erro: ' + error.code; return;
      }
      $('status').textContent = 'Rastreando em segundo plano';
      if (location){ lastLoc = location; send(location); }
    });
    pollLocate();
  } catch(e){ $('status').textContent = 'Falha ao iniciar'; $('err').textContent = e.message; }
}

async function stop(){
  if (watcherId){ await BackgroundGeolocation.removeWatcher({ id: watcherId }); watcherId = null; }
  $('status').textContent = 'Parado';
}

// Responde ao "Localizar agora" do painel
async function pollLocate(){
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

/* ---------- UI: setup vs status ---------- */
function showStatus(){
  $('setup').style.display = 'none';
  $('panel').style.display = 'block';
  $('who').textContent = member.name;
  $('btnStart').onclick = start;
  $('btnStop').onclick = stop;
  start();
}
function showSetup(){
  $('setup').style.display = 'block';
  $('panel').style.display = 'none';
  $('btnEntrar').onclick = () => {
    const name = ($('nome').value || '').trim();
    if (!name){ $('setupErr').textContent = 'Digite seu nome.'; return; }
    member = { id: 'FAM-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), name, account: ACCOUNT };
    saveMember(member);
    showStatus();
  };
}

if (member && member.id) showStatus(); else showSetup();
