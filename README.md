# Antifurto Hubmix + Multimix Rastreio

Projeto do SaaS Multimix. Um motor de localização que atende **três produtos**:

1. **Antifurto** — senha de coação abre um banco falso (decoy) com saldo baixo e erros simulados, enquanto o backend rastreia o aparelho e avisa um contato.
2. **Rastreio familiar** — localização contínua entre familiares, estilo Life360.
3. **Força de trabalho (B2B)** — rastrear vendedores/entregadores (planejado).

---

## Onde fica cada coisa

| Recurso | Endereço |
|---|---|
| Código-fonte (GitHub) | https://github.com/multimixmidia/stealth-alert |
| Servidor / páginas (Render) | https://stealth-alert.onrender.com |
| Painel do Render | https://dashboard.render.com/web/srv-dbp3somc6qcc73a9gdrg |
| Banco de dados (Supabase) | projeto `pvdzlmmwxoorovsbztoe` |

### Apps para instalar (GitHub Releases)
| App | Link |
|---|---|
| Antifurto (Originali) | https://github.com/multimixmidia/stealth-alert/releases/download/app-latest/antifurto.apk |
| Rastreio família | https://github.com/multimixmidia/stealth-alert/releases/download/tracker-latest/multimix.apk |

> APKs de teste (debug). A assinatura muda a cada build, então para atualizar pode ser preciso desinstalar o anterior.

### Páginas web (servidas pelo backend)
| Página | URL |
|---|---|
| Decoy (banco falso) | `/fake_bank.html` |
| Configurar decoy | `/config.html` |
| Vitrine das 3 marcas fictícias | `/bancos.html` |
| Painel antifurto (ao vivo) | `/acompanhar.html?id=DEV-ANDROID-0001` |
| Painel família | `/familia.html?account=familia` |
| Desarmar antifurto | `/desarmar` |
| Verificar versão/banco | `/version` |
| Diagnóstico do banco | `/dbcheck` |

---

## Estrutura do repositório

```
server.js            Backend Node/Express (API + serve as páginas)
fake_bank.html       Decoy antifurto (lê config do localStorage)
config.html          Configuração do decoy (banco, cor, logo, saldo, senhas)
bancos.html          Vitrine das 3 identidades fictícias (Originali, Nevo, Vexa)
acompanhar.html      Painel ao vivo do antifurto (mapa + status)
familia.html         Painel da família (membros no mapa + "Localizar agora")
package.json         Dependências do servidor (express)

app/                 App Android ANTIFURTO (Capacitor) — carrega o decoy do Render
tracker/             App Android RASTREIO FAMÍLIA (Capacitor + background geolocation)

.github/workflows/
  android.yml          Build do APK do antifurto -> Release "app-latest"
  tracker-android.yml  Build do APK do rastreio   -> Release "tracker-latest"
```

---

## Variáveis de ambiente (no Render)

| Variável | Para quê |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase (sem `/rest/v1` no final) |
| `SUPABASE_KEY` | chave **service_role** do **mesmo** projeto |
| `TELEGRAM_BOT_TOKEN` | bot do Telegram que envia o alerta |
| `TELEGRAM_CHAT_ID` | chat que recebe o alerta no Telegram |
| `WHATSAPP_PHONE` | número que recebe o alerta no WhatsApp (via CallMeBot) |
| `CALLMEBOT_APIKEY` | apikey do CallMeBot |
| `DISARM_PIN` | senha de desarme do antifurto |

> Regra de ouro do Supabase: **URL e chave sempre do mesmo projeto**.

---

## Banco de dados (Supabase)

```sql
create table if not exists members (
  device_id text primary key,
  account text not null,
  name text not null,
  updated_at timestamptz default now()
);
create table if not exists positions (
  id bigserial primary key,
  device_id text not null,
  lat double precision,
  lng double precision,
  acc integer,
  battery integer,
  status text,
  ts timestamptz,
  created_at timestamptz default now()
);
create index if not exists positions_device_idx on positions (device_id, created_at desc);
```

O servidor grava **sempre na memória e no banco**; se o banco falhar, cai para a memória e os painéis continuam funcionando (ver `/dbcheck` para o erro exato).

---

## Deploy

- Backend: Render faz deploy do `main`. Se o auto-deploy falhar, use **Manual Deploy → Deploy latest commit** e confira em `/version`.
- APKs: ao dar push em `app/**` ou `tracker/**`, o GitHub Actions compila e publica o APK como Release.

---

## API (principais rotas)

| Método | Rota | Função |
|---|---|---|
| POST | `/api/v1/security/stealth-alert` | recebe posição/alerta do app |
| POST | `/api/v1/security/disarm` | desarma o antifurto (senha) |
| GET  | `/api/v1/track?id=` | trilha de um aparelho |
| POST | `/api/v1/register` | cadastra membro da família |
| GET  | `/api/v1/members?account=` | lista membros + posições |
| POST | `/api/v1/locate` | pede posição fresca de um aparelho |
| GET  | `/api/v1/locate-check?id=` | app verifica pedido de "localizar agora" |

---

## Contas, família e contatos (API v2 — `v2.js`)

Login e senha ficam no **Supabase Auth** (só o hash da senha é guardado). Tabelas novas: `sa_profiles` e `contacts`; `members` ganhou `user_id` e `phone`.

| Método | Rota | Função |
|---|---|---|
| POST | `/api/v2/signup` · `/login` · `/refresh` | criar conta, entrar, renovar sessão |
| GET/PUT | `/api/v2/me` | perfil, contatos e código da família |
| POST | `/api/v2/device` | liga o aparelho à conta e devolve o token dele |
| GET/POST/PUT/DELETE | `/api/v2/contacts` | até 5 contatos de alerta |
| GET/PUT/DELETE | `/api/v2/family` | membros da família (editar/excluir) |
| POST | `/api/v2/telegram/webhook` | o contato ativa o alerta com `/start CODIGO` no bot |

O alerta de coação de um aparelho ligado a uma conta vai para os contatos ativos (Telegram) do dono.

---

## Próximos passos
1. **Unificar o app** — cadastro + minha posição + mapa da família em abas; cadastro automático (sem Parar/Iniciar).
2. **Bloqueio falso ao desligar** (antifurto).
3. **Modo empresa** (B2B) + relatórios.
4. **LGPD** — consentimento e retenção.

Documentação completa: ver os docs do projeto no Claude (`arquitetura-antifurto.md`, `modulo-rastreamento-comercial.md`).
