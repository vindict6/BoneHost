# BoneHost

Private CS2 server hosting for you and your friends. A dark, DatHost-style panel that provisions Dockerized CS2 servers on your Ryzen 7950X, pins them to dedicated CPU threads, gives every server an SFTP slot, keeps Metamod/CounterStrikeSharp/plugins updated on a schedule each subscriber controls, and bills upfront over **Venmo / Cash App** — zero payment-processor cut, automatic delinquent shutoff, every transaction in an append-only ledger.

```
├── config.json            # host resources, pricing, addons, defaults — the one file you tune
├── docker-compose.yml     # panel + MariaDB (for CS2-SimpleAdmin databases)
├── .env.example           # secrets template → copy to .env on the server
├── .github/workflows/     # push-to-main deploy over SSH
├── server/                # Node 22 panel: API, billing, scheduler, Docker orchestration
├── web/                   # dashboard SPA (no build step)
└── images/cs2/            # the CS2 game-server image (steamcmd + addon installer)
```

---

## 1 · Prepare the Debian server (one time)

```bash
# as root on your Trixie box
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh          # Docker Engine + compose plugin

mkdir -p /opt/bonehost /srv/bonehost
git clone git@github.com:YOU/bonehost.git /opt/bonehost
cd /opt/bonehost
cp .env.example .env && nano .env               # fill in everything (next section)
```

`/srv/bonehost` holds all state: `bonehost.sqlite`, `servers/<id>/` (game files), and `ledger/` (JSONL payment records). Back this directory up.

## 2 · Fill in `.env`

| Var | What |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Your admin login, seeded on **first boot only**. Change the password afterwards from the Account page. |
| `MARIADB_ROOT_PASSWORD` | Anything strong — internal only. |
| `BTCPAY_*` | **Leave commented out.** Only needed if you ever switch `billing.provider` to `"btcpay"` (see §4). |
| `STEAM_API_KEY` | Optional — needed only to resolve **vanity** profile links (`/id/name`). Direct SteamID64s and `/profiles/…` links work without it. Get one at steamcommunity.com/dev/apikey. |
| `ADMIN_IP_ALLOWLIST` | Optional but recommended: comma-separated IPs/CIDRs allowed to hit `/api/admin/*`, e.g. `203.0.113.7,10.0.0.0/8`. |

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

## 5 · Deploy via GitHub Action

Repo → Settings → Secrets and variables → Actions:

- `DEPLOY_HOST` — server IP/hostname
- `DEPLOY_USER` — a user in the `docker` group
- `DEPLOY_SSH_KEY` — private key whose public half is in that user's `authorized_keys`

Push to `main`. The action SSHes in, resets `/opt/bonehost` to `origin/main`, builds the `bonehost/cs2:latest` game image, and `docker compose up -d --build`s the panel. First CS2 image build downloads steamcmd only — the ~35 GB game download happens per-server on first boot into that server's own volume.

## 6 · Reverse proxy + TLS

Put the panel behind HTTPS (the session cookie and your friends' payments deserve it). Caddy makes it two lines:

```
bonehost.org {
    reverse_proxy 127.0.0.1:8080
}
```

Open in your firewall: `443` (panel), `2022` (SFTP), and UDP `27015–27114` (game servers).

## 7 · Day-to-day

**You (admin):**
- **Admin → Overview**: live thread map + memory bar, whole fleet with suspend/unsuspend/comp-days/delete, users, invite minting. Every action is audited (Admin → Audit log).
- **Admin → Ledger**: every transaction with user, server, plan, amount, period, status, provider, and timestamps — plus **Confirm / Void** buttons for open invoices and one-click CSV export. Every lifecycle event (created, declared, settled, voided) is additionally appended to monthly JSONL files in `/srv/bonehost/ledger/`.
- Admin protections: registration is **invite-only**, admin accounts can't be disabled from the panel, `/api/admin/*` can be IP-allowlisted, sessions are httpOnly+SameSite=strict JWT cookies, all mutations require JSON content-type (CSRF), login is rate-limited.

**Your friends:**
1. Redeem your invite code → account.
2. **New server** wizard: name, slots (live pricing), map/mode, GSLT (link + instructions inline — App 730), plugin toggles (Metamod, CS#, FakeRcon, SimpleAdmin on by default), admins via Steam profile links or SteamID64s, monthly/yearly pick → invoice opens with a code and Venmo/Cash App buttons. Server is provisioned instantly and **starts itself the moment you confirm the payment landed**.
3. Per-server tabs: live console + RCON, settings & custom cvars (apply now or on next restart), admin management, **Updates** (weekly schedule with day/hour + independent or bundled Metamod/CS# pushes, or "update now"), SFTP credentials, billing with full transaction history, delete.
4. Persistent custom config: `cs2/game/csgo/cfg/custom.cfg` over SFTP — exec'd after the panel config, survives every update.

## 8 · Maintenance

- **Backups**: `/srv/bonehost/bonehost.sqlite*` + `/srv/bonehost/ledger/` (tiny), and optionally `servers/*/game/csgo/cfg` + addons. The 35 GB game files are re-downloadable; don't bother backing them up.
- **Deleted servers** keep their files for 30 days (soft delete). Purge with a monthly cron:
  ```bash
  # /etc/cron.monthly/bonehost-purge
  find /srv/bonehost/servers -maxdepth 1 -name '*.deleted-*' -mtime +30 -exec rm -rf {} +
  ```
- **Panel updates**: push to `main`. **Game/addon updates**: subscribers' schedules handle it, or run a pass from any server's Updates tab.

## 9 · Troubleshooting

| Symptom | Check |
|---|---|
| Server won't start after payment | GSLT valid? `docker logs bonehost-cs2-<id>` — first boot downloads ~35 GB. |
| Web console says RCON failed | FakeRcon repo slug in `config.json` (see §3), then run an addon update pass. |
| Vanity Steam links won't resolve | Set `STEAM_API_KEY`, or use the `/profiles/…` URL / raw SteamID64. |
| Payment sent but server still locked | Confirm the invoice in Admin → Ledger — settlement is your tap. |
| Payer forgot the invoice code in the note | Match by amount + timing, then Confirm; the code is convenience, not a requirement. |
| "Sign in required" loops | Panel must be served over HTTPS (or same origin) so the session cookie sticks. |
