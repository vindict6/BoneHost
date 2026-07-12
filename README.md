# BoneHost

Private CS2 server hosting for you and your friends, split into a **head unit** and **game nodes**:

```
                     Cloudflare DNS (bonehost.org)
                                 │
    bonehost.org (proxied ☁)     │      play.bonehost.org (DNS-only, DDNS-updated)
                │                │                 │  players + subscriber SSH
 ┌──────────────▼─────────┐      │      ┌──────────▼──────────────────────────────┐
 │  MINI PC — head unit   │      │      │  RYZEN 7950X — game node "ryzen"        │
 │  panel :8080           │      │      │  agent :9090 → bound to TAILSCALE IP    │
 │  web UI · API · SQLite │      │      │  CS2 containers, each with ITS OWN sshd │
 │  billing · schedulers  │      │      │  MariaDB · game files                   │
 └───────────┬────────────┘      │      └──────────▲──────────────────────────────┘
             │      T A I L S C A L E              │
             └──── agent API · host SSH · CI ──────┘
   UFW (auto-applied on deploy):
     node:  tailnet = everything · public = 27015–29000 tcp+udp ONLY
     panel: tailnet = everything · public = 80/443 (or nothing with a CF Tunnel)
                                        ... add "zeus", "hades", ... the same way
```

The panel never touches Docker or game files — it drives each node through a small authenticated **agent**. Nodes are stateless (all state lives in the panel's SQLite), so scaling is: add a block to `config.json`, set one token, deploy the agent stack on the new box. The allocator automatically places new servers on the node with the most free capacity, each server pinned to SMT sibling pairs with fixed memory, per-node SFTP, subscriber-scheduled Metamod/CS#/plugin updates, and upfront **Venmo / Cash App** billing — zero processor cut, automatic delinquent shutoff, append-only ledger.

```
├── config.json                # panel + NODE REGISTRY (resources, pricing, addons)
├── docker-compose.panel.yml   # head unit stack (mini PC)
├── docker-compose.node.yml    # game node stack (agent + MariaDB)
├── .env.example               # secrets template for both machines
├── .github/workflows/         # Tailscale-native deploys: push-to-main or pick a target
├── scripts/                    # UFW policies, auto-applied on every deploy
├── server/                    # the panel: API, billing, schedulers, node client
├── agent/                     # the node agent: Docker, files, SFTP, RCON proxy
├── web/                       # dashboard SPA (no build step)
└── images/cs2/                # the CS2 game-server image (built on each node)
```

---

## 1 · Prepare both machines (one time)

Same base on each — the mini PC **and** the 7950X:

```bash
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh          # Docker Engine + compose plugin
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up   # join your tailnet
git clone git@github.com:YOU/bonehost.git /opt/bonehost
cd /opt/bonehost && cp .env.example .env && nano .env
```

Give the deploy user the docker group and one sudoers line so CI can apply the firewall (`visudo`):

```
deploy ALL=(root) NOPASSWD: /opt/bonehost/scripts/firewall-node.sh, /opt/bonehost/scripts/firewall-panel.sh
```

Then per role:

```bash
# mini PC (head unit): panel state — sqlite + payment ledgers. BACK THIS UP.
mkdir -p /srv/bonehost-panel

# 7950X (game node): game files, per-server data, MariaDB
mkdir -p /srv/bonehost
```

Each machine's `.env` only needs its own half: the mini PC uses the panel vars + `NODE_TOKEN_RYZEN`; the node needs `AGENT_TOKEN` (same value), `MARIADB_ROOT_PASSWORD`, and `TAILSCALE_IP` (`tailscale ip -4`) — the compose file binds the agent to that address exclusively, so it's unreachable from the internet by construction, not just by firewall.

## 2 · Fill in `.env`

| Var | Machine | What |
|---|---|---|
| `JWT_SECRET` | mini PC | `openssl rand -hex 32` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | mini PC | Your admin login, seeded on **first boot only**. Change it afterwards from the Account page. |
| `NODE_TOKEN_RYZEN` | mini PC | `openssl rand -hex 32` — one `NODE_TOKEN_<ID>` per node in `config.json`. |
| `AGENT_TOKEN` | 7950X | The **same value** as the panel's token for this node. The agent refuses to start without one. |
| `MARIADB_ROOT_PASSWORD` | both | The agent uses it to provision per-server SimpleAdmin DBs on its local MariaDB. |
| `STEAM_API_KEY` | mini PC | Optional — only for resolving **vanity** profile links (`/id/name`). SteamID64s and `/profiles/…` links work without it. |
| `ADMIN_IP_ALLOWLIST` | mini PC | Optional: comma-separated IPs/CIDRs allowed to hit `/api/admin/*`. |
| `BTCPAY_*` | mini PC | Leave commented out unless you switch to the BTCPay provider (§4). |

## 3 · Tune `config.json`

- **`network.public_host`** / **`panel.url`** — preset to `bonehost.org`. Point an A record at the box (and, if you like, a `panel.` subdomain — the game servers and the panel can share the apex).
- **`cpu.pool`** — threads the allocator may hand to game servers (default `4–31`, keeping `0–3,16–19` for the OS/panel). Each server gets `threads_per_server` (default 4) as **SMT sibling pairs** (`N` + `N+16`), pinned via cpuset so servers never fight each other.
- **`memory`** — total, host reserve, and MB per server (default 8192). Allocation refuses new servers past the budget.
- **`billing`** — `2000`¢/slot/month default; yearly charges `yearly_months_charged` (10 = two months free). `grace_days` past due before automatic suspension.
- **`updates.scheduler_timezone`** — subscribers pick day/hour in this zone.
- **`billing.manual`** — your `venmo_username` and/or `cashapp_cashtag` (see §4). Not secrets, so they live here rather than `.env`.
- **`addons`** — release sources. ⚠️ **Verify the FakeRcon repo slug** (`plugins[].repo`) against the plugin's current GitHub home before first deploy; plugin repos move. A wrong slug is non-fatal — the installer logs and skips it — but you want RCON working since the web console rides on it.

## 4 · Payments — Venmo / Cash App (the no-cut rail)

Setup is one edit: put your handle(s) in `config.json`:

```json
"billing": {
  "provider": "manual",
  "manual": {
    "venmo_username": "your-venmo-username",
    "cashapp_cashtag": "YourCashtag",
    "note": "Put the invoice code in the payment note so payments match up fast."
  }
}
```

**Why it works this way.** Venmo and Cash App don't expose APIs or webhooks for personal accounts, so no software can *detect* a friend-to-friend payment automatically. (Processors that can — Stripe, Square, PayPal Business — take ~2.9% + 30¢ of every payment.) BoneHost therefore automates everything **around** the payment and leaves you exactly one tap:

1. The panel opens an invoice with a unique code (e.g. `BH-NQEF3V`) — on the wizard, on the Billing tab, and again automatically ~7 days before every renewal. You get a notice the moment any invoice opens.
2. The payer's Billing tab shows the amount, the code, and one-tap **Pay with Venmo** (amount + note prefilled) / **Pay with Cash App** (amount prefilled; the code goes in the "For" field) buttons, plus an **"I've sent it"** button that flips the invoice to *processing* and pings you.
3. Your phone buzzes with the Venmo/Cash App notification → **Admin → Ledger → Confirm**. That single tap settles the transaction, extends `paid_until` a full period, writes the ledger, and — if the server was suspended for non-payment — un-suspends and **restarts it automatically**.

Delinquency needs no taps at all: the hourly billing pass marks subscriptions past due at `paid_until`, then stops and suspends the server after the grace window. Monthly and yearly run on the same clock, so yearly delinquency works identically. Mistaken or abandoned invoices get a **Void** button.

<details><summary><b>Optional: fully-automated settlement with BTCPay Server</b></summary>

If you ever want zero-touch settlement without a processor cut, self-hosted BTCPay Server is wired in: set `billing.provider` to `"btcpay"`, deploy BTCPay (https://docs.btcpayserver.org/Docker/), create a store + Greenfield API key (`cancreateinvoice`, `canviewinvoices`), point a webhook at `https://bonehost.org/api/billing/webhook` with a secret, and fill the `BTCPAY_*` vars in `.env`. Webhooks are HMAC-verified; settle/expire/invalid events flow through the same engine, including auto-restart on payment.
</details>

## 5 · Deploy — over your tailnet, per-target, firewall included

The workflow joins each GitHub runner to **your tailnet** as an ephemeral node, SSHes to the machines' MagicDNS names, deploys, and re-applies the UFW policy. No public SSH anywhere, works behind CGNAT, nothing to port-forward.

**One-time setup:**
1. Tailscale admin → **Access controls**: add `"tag:ci": ["autogroup:admin"]` under `tagOwners`.
2. Tailscale admin → **OAuth clients** → new client, scope `auth_keys`, tag `tag:ci` → repo secrets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`.
3. Per machine: `PANEL_TS_HOST` / `PANEL_USER` / `PANEL_SSH_KEY` and `NODE_RYZEN_TS_HOST` / `NODE_RYZEN_USER` / `NODE_RYZEN_SSH_KEY`. The `*_TS_HOST` values are MagicDNS names (`minipc`, `ryzen`). Users need the docker group + the sudoers line from §1.

**Deploying:**
- **Push to `main`** → both machines deploy in parallel, firewalls re-applied.
- **Actions → Deploy BoneHost → Run workflow** → pick `everything`, `panel-only`, or `node-ryzen-only` for a one-machine deploy.

The node job also rebuilds `bonehost/cs2:latest`; the ~35 GB CS2 download still happens per-server on first boot.

## 6 · Cloudflare, DDNS, and the wire between the machines

**Two DNS records, two different Cloudflare modes:**

| Record | Points at | Cloudflare proxy | Why |
|---|---|---|---|
| `bonehost.org` | mini PC | **Proxied ☁ (orange)** | The panel is plain HTTPS — Cloudflare gives you TLS, caching, and hides the mini PC's IP. A **Cloudflare Tunnel** (`cloudflared` container on the mini PC) is even better: zero inbound ports on the head unit. |
| `play.bonehost.org` | 7950X | **DNS-only (grey)** | Game traffic is UDP and SFTP is raw TCP — the Cloudflare proxy can't carry either. Your in-house DDNS container should update **this** record via the Cloudflare API whenever your WAN IP moves. Players resolve it directly. |

On the mini PC, terminate TLS with Caddy (skip if you use a Tunnel):

```
bonehost.org {
    reverse_proxy 127.0.0.1:8080
}
```

**Firewall — applied automatically on every deploy** (`scripts/firewall-node.sh` / `firewall-panel.sh`, idempotent):

| Machine | Tailnet (`tailscale0`) | Public internet |
|---|---|---|
| Game node | everything (host SSH, agent 9090) | **27015–29000 tcp+udp only** — game ports + per-container subscriber SSH |
| Head unit | everything (host SSH) | 80/443, or **nothing** with `PANEL_PUBLIC_HTTP=0` + a Cloudflare Tunnel |

Two defense-in-depth details worth knowing: ① Docker-published ports bypass UFW via Docker's own iptables chain, which is why `docker-compose.node.yml` binds the agent to `${TAILSCALE_IP}` **exclusively** — the agent is off the internet by construction, with the token as a second lock and UFW as a third. ② The only ports game containers ever publish sit inside 27015–29000 (`game_port_range` + `ssh_port_range` in `config.json`), so the Docker bypass can never expose more than the policy already allows.

## 7 · Subscriber SSH — a shell in *their* box, not yours

Every game container runs its **own hardened sshd** (password + optional key, `AllowUsers steam`, no forwarding, sftp built in) on a dedicated port from 28000–29000. Subscribers land inside their container: full access to their game files at `~/cs2data`, real tools, zero visibility of the host, the agent, or anyone else's server. Host keys persist in the data volume so fingerprints never change across updates.

The dashboard's **Files & SSH** tab hands them everything: host/port/user/password with copy buttons, ready-to-paste `ssh -p …` and `sftp -P …` commands (FileZilla/WinSCP work with the same creds), and a field to install an **SSH public key** — validated by the panel, shipped to the node, applied on the next restart. Compromised password? It's scoped to one container that can be recreated in a minute.

## 7½ · Day-to-day

**You (admin):**
- **Admin → Overview**: a card per node — agent health, live thread map, memory bar — plus the **fleet command bar**: check any set of servers (or select-all) and Start / Stop / Restart the batch, run an **update pass** across them (optionally bundling Metamod / CounterStrikeSharp — your custom-update support in two clicks: tick the boxes, select the fleet, go), or **broadcast an RCON command** to every selected server (`say Maintenance in 5 minutes`, push a cvar, `changelevel`…). Per-server results stream back into a table; everything is audited. Per-server suspend/unsuspend/comp-days/delete, users, and invite minting live on the same page, and as admin you can open any server's full detail view — console, settings, updates — exactly like the owner sees it.
- **Admin → Ledger**: every transaction with user, server, plan, amount, period, status, provider, and timestamps — plus **Confirm / Void** buttons for open invoices and one-click CSV export. Every lifecycle event (created, declared, settled, voided) is additionally appended to monthly JSONL files in `/srv/bonehost/ledger/`.
- Admin protections: registration is **invite-only**, admin accounts can't be disabled from the panel, `/api/admin/*` can be IP-allowlisted, sessions are httpOnly+SameSite=strict JWT cookies, all mutations require JSON content-type (CSRF), login is rate-limited.

**Your friends:**
1. Redeem your invite code → account.
2. **New server** wizard: name, slots (live pricing), map/mode, GSLT (link + instructions inline — App 730), plugin toggles (Metamod, CS#, FakeRcon, SimpleAdmin on by default), admins via Steam profile links or SteamID64s, monthly/yearly pick → invoice opens with a code and Venmo/Cash App buttons. Server is provisioned instantly and **starts itself the moment you confirm the payment landed**.
3. Per-server tabs: live console + RCON, settings & custom cvars (apply now or on next restart), admin management, **Updates** (weekly schedule with day/hour + independent or bundled Metamod/CS# pushes, or "update now"), SFTP credentials, billing with full transaction history, delete.
4. Persistent custom config: `cs2/game/csgo/cfg/custom.cfg` over SFTP — exec'd after the panel config, survives every update.

## 8 · Maintenance

- **Backups**: on the **mini PC**, `/srv/bonehost-panel/` (SQLite + payment ledgers — tiny, this is the crown jewels). Nodes are rebuildable: game files re-download, configs re-push from the panel on the next apply.
- **Deleted servers** keep their files 30 days on their node. Monthly cron **on each node**:
  ```bash
  # /etc/cron.monthly/bonehost-purge
  find /srv/bonehost/servers -maxdepth 1 -name '*.deleted-*' -mtime +30 -exec rm -rf {} +
  ```
- **Updates**: push to `main` — both machines redeploy. Game/addon updates run on subscribers' schedules or from any server's Updates tab.

## 9 · Troubleshooting

| Symptom | Check |
|---|---|
| Server won't start after payment | GSLT valid? On the **node**: `docker logs bonehost-cs2-<id>` — first boot downloads ~35 GB. |
| "Node unreachable" in the panel | Agent up on the node (`docker logs bonehost-agent`)? `agent_url` right? Firewall allows the mini PC to :9090? Tokens match? |
| Friends can't connect but panel works | `play.bonehost.org` must be **grey-cloud** (DNS-only) and your DDNS container must be updating it — proxied records silently eat game UDP. |
| Web console says RCON failed | FakeRcon repo slug in `config.json` (see §3), then run an addon update pass. |
| Vanity Steam links won't resolve | Set `STEAM_API_KEY`, or use the `/profiles/…` URL / raw SteamID64. |
| Payment sent but server still locked | Confirm the invoice in Admin → Ledger — settlement is your tap. |
| Payer forgot the invoice code in the note | Match by amount + timing, then Confirm; the code is convenience, not a requirement. |
| Subscriber can't SSH in | Server running? (sshd lives inside the container.) Right port from Files & SSH? `play.bonehost.org` resolving (grey-cloud + DDNS)? |
| GitHub deploy can't reach a machine | Runner joined the tailnet (`tag:ci` in ACL tagOwners, OAuth secrets set)? `*_TS_HOST` MagicDNS name right? |
| "Sign in required" loops | Panel must be served over HTTPS (or same origin) so the session cookie sticks. |
