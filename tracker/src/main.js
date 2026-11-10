import { registerPlugin } from '@capacitor/core';
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const SERVER = 'https://stealth-alert.onrender.com/api/v1/security/stealth-alert';
const DEVICE_ID = 'DEV-ANDROID-0001';
const AUTH_TOKEN = 'tok_demo_9f8e7d6c5b4a';
const $ = id => document.getElementById(id);
let count = 0, watcherId = null;

async function send(loc){
  try{
    let battery = null;
    try { if (navigator.getBattery) battery = Math.round((await navigator.getBattery()).level*100); } catch(_){}
    await fetch(SERVER, {
      method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({
        device_id: DEVICE_ID, auth_token: AUTH_TOKEN, status:'LOCATION_UPDATE', battery_level: battery,
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
  }catch(e){ $('err').textContent = 'Falha no envio: ' + e.message; }
}

async function start(){
  if (watcherId) return;
  $('status').textContent = 'Iniciando…';
  try{
    watcherId = await BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Rastreamento ativo',
      backgroundTitle: 'Multimix Rastreio',
      requestPermissions: true,
      stale: false,
      distanceFilter: 15
    }, (location, error) => {
      if (error) {
        if (error.code === 'NOT_AUTHORIZED') $('err').textContent = 'Permissão negada. Ative "Permitir sempre" na localização.';
        $('status').textContent = 'Erro: ' + error.code;
        return;
      }
      $('status').textContent = 'Rastreando em segundo plano';
      if (location) send(location);
    });
  }catch(e){ $('status').textContent='Falha ao iniciar'; $('err').textContent=e.message; }
}

async function stop(){
  if (watcherId){ await BackgroundGeolocation.removeWatcher({ id: watcherId }); watcherId = null; }
  $('status').textContent = 'Parado';
}

$('btnStart').onclick = start;
$('btnStop').onclick = stop;
start();
