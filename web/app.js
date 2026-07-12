/* BoneHost SPA — no build step, no dependencies. */
'use strict';

/* ── tiny helpers ─────────────────────────────────────────────────────── */
const $ = sel => document.querySelector(sel);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = state.meta?.currency || 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format((cents || 0) / 100);
const dt = ms => ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const dOnly = ms => ms ? new Date(ms).toLocaleDateString([], { dateStyle: 'medium' }) : '—';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 4800);
}

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: {}, ...opts };
  if (opts.method && opts.method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body ?? {});
  }
  const r = await fetch(`/api${path}`, init);
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
}

function copy(text, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(label, 'ok'), () => toast('Copy failed — select it manually.', 'err'));
}

function confirmModal(title, body, yesLabel = 'Confirm', danger = true) {
  return new Promise(resolve => {
    const veil = document.createElement('div');
    veil.className = 'modal-veil';
    veil.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p class="mut small" style="margin:0 0 18px">${esc(body)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-y>${esc(yesLabel)}</button></div></div>`;
    document.body.appendChild(veil);
    veil.querySelector('[data-x]').onclick = () => { veil.remove(); resolve(false); };
    veil.querySelector('[data-y]').onclick = () => { veil.remove(); resolve(true); };
    veil.onclick = e => { if (e.target === veil) { veil.remove(); resolve(false); } };
  });
}

/* ── state & boot ─────────────────────────────────────────────────────── */
const state = { me: null, notices: [], meta: null, poll: null };

function stopPoll() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

async function boot() {
  try { state.meta = await api('/meta'); } catch { /* panel still answers */ }
  try {
    const me = await api('/auth/me');
    state.me = me.user; state.notices = me.notices || [];
  } catch { state.me = null; }
  route();
}

window.addEventListener('hashchange', route);

function nav(hash) { location.hash = hash; }

function route() {
  stopPoll();
  const h = location.hash.replace(/^#/, '') || '/servers';
  if (!state.me) {
    if (h === '/register') return renderRegister();
    return renderLogin();
  }
  const m = h.match(/^\/servers\/([a-z0-9-]+)(?:\/(\w+))?/);
  if (m) return renderServer(m[1], m[2] || 'overview');
  switch (h) {
    case '/new': return renderWizard();
    case '/billing': return renderBilling();
    case '/account': return renderAccount();
    case '/admin': return renderAdmin('overview');
    case '/admin/ledger': return renderAdmin('ledger');
    case '/admin/audit': return renderAdmin('audit');
    default: return renderDashboard();
  }
}

/* ── shell ────────────────────────────────────────────────────────────── */
function shell(active, inner) {
  const unread = state.notices.filter(n => !n.read).length;
  const isAdmin = state.me?.role === 'admin';
  app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="side-logo"><b>BONE</b><span>HOST</span></div>
      <a class="nav-a ${active === 'servers' ? 'on' : ''}" href="#/servers"><span class="nv">▣</span>Servers</a>
      <a class="nav-a ${active === 'new' ? 'on' : ''}" href="#/new"><span class="nv">＋</span>New server</a>
      <a class="nav-a ${active === 'billing' ? 'on' : ''}" href="#/billing"><span class="nv">◈</span>Billing</a>
      <a class="nav-a ${active === 'account' ? 'on' : ''}" href="#/account"><span class="nv">◉</span>Account${unread ? '<span class="badge-dot"></span>' : ''}</a>
      ${isAdmin ? `<a class="nav-a ${active === 'admin' ? 'on' : ''}" href="#/admin"><span class="nv">⌘</span>Admin</a>` : ''}
      <div class="side-foot">
        <div class="side-user" title="${esc(state.me.email)}">${esc(state.me.email)}</div>
        <button class="side-out" id="logout">Sign out</button>
      </div>
    </aside>
    <main class="main">${inner}</main>
  </div>`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); state.me = null; nav('/login'); route(); };
}

/* ── auth ─────────────────────────────────────────────────────────────── */
function authFrame(inner) {
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo"><b>BONE</b><span>HOST</span></div>
    <div class="auth-tag">private cs2 hosting · ${esc((state.meta?.nodes || [])[0]?.public_host || 'bonehost.org')}</div>
    ${inner}</div></div>`;
}

function renderLogin() {
  authFrame(`
    <form id="f">
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
      <button class="btn primary wide" type="submit">Sign in</button>
    </form>
    <div class="auth-switch">Have an invite? <a id="to-reg">Create an account</a></div>`);
  $('#to-reg').onclick = () => { nav('/register'); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      await boot(); nav('/servers');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function renderRegister() {
  authFrame(`
    <form id="f">
      <div class="field"><label>Invite code</label><input name="invite" required placeholder="From your host" autocomplete="off"></div>
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
        <div class="hint">At least 10 characters.</div></div>
      <button class="btn primary wide" type="submit">Create account</button>
    </form>
    <div class="auth-switch">Already registered? <a id="to-log">Sign in</a></div>`);
  $('#to-log').onclick = () => { nav('/login'); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/auth/register', { method: 'POST', body: { invite: f.get('invite'), email: f.get('email'), password: f.get('password') } });
      await boot(); nav('/servers');
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ── dashboard ────────────────────────────────────────────────────────── */
function statusPill(s, state_) {
  if (s.status === 'suspended') return `<span class="pill bad">suspended</span>`;
  if (state_?.running || s.status === 'running') return `<span class="pill run">running</span>`;
  return `<span class="pill stop">stopped</span>`;
}

async function renderDashboard() {
  shell('servers', `<div class="page-head"><div><h1>Servers</h1>
    <div class="sub">Your CS2 fleet${(state.meta?.nodes || []).length > 1 ? ` across ${state.meta.nodes.length} nodes` : ''}.</div></div>
    <a class="btn primary" href="#/new">＋ New server</a></div>
    <div id="list"><div class="empty">Loading…</div></div>`);
  const draw = async () => {
    let servers;
    try { servers = await api('/servers'); } catch (e) { toast(e.message, 'err'); return; }
    if (!servers.length) {
      $('#list').innerHTML = `<div class="empty">No servers yet.<br><br><a class="btn primary" href="#/new">Spin up your first server</a></div>`;
      return;
    }
    $('#list').innerHTML = `<div class="srv-grid">` + servers.map(s => `
      <a class="srv-card" href="#/servers/${s.id}">
        <div class="spread"><div class="srv-name">${esc(s.name)}</div>${statusPill(s)}</div>
        <div class="srv-meta">
          <div class="kv"><div class="k">Address</div><div class="v">${esc(s.public_host || '?')}:${s.game_port}</div></div>
          <div class="kv"><div class="k">Slots</div><div class="v">${s.slots}</div></div>
          <div class="kv"><div class="k">Map</div><div class="v">${esc(s.map)}</div></div>
          <div class="kv"><div class="k">CPU · RAM</div><div class="v">${esc(s.cpuset)} · ${s.memory_mb} MB</div></div>
        </div>
        ${s.suspended_reason ? `<div class="hint" style="color:var(--bad);margin-top:10px">Suspended: ${esc(s.suspended_reason)}</div>` : ''}
      </a>`).join('') + `</div>`;
  };
  await draw();
  state.poll = setInterval(draw, 20000);
}

/* ── server detail ────────────────────────────────────────────────────── */
const TABS = [
  ['overview', 'Overview'], ['console', 'Console'], ['settings', 'Settings'], ['admins', 'Admins'],
  ['updates', 'Updates'], ['files', 'Files & SSH'], ['billing', 'Billing'], ['danger', 'Danger'],
];

async function renderServer(id, tab) {
  shell('servers', `<div id="srv"><div class="empty">Loading server…</div></div>`);
  let d;
  const load = async () => { d = await api(`/servers/${id}`); };
  try { await load(); } catch (e) {
    $('#srv').innerHTML = `<div class="empty">${esc(e.message)}<br><br><a class="btn" href="#/servers">Back to servers</a></div>`;
    return;
  }

  const draw = () => {
    const s = d.server, st = d.state, sub = d.subscription;
    const paid = sub && sub.paid_until > Date.now();
    $('#srv').innerHTML = `
    <div class="page-head">
      <div><div class="row" style="gap:12px"><h1>${esc(s.name)}</h1>${statusPill(s, st)}</div>
        <div class="sub mono">${esc(d.connect)} <button class="btn sm" id="cp-connect" style="margin-left:8px">copy</button></div></div>
      <div class="row">
        <button class="btn ok" id="b-start" ${st.running ? 'disabled' : ''}>Start</button>
        <button class="btn" id="b-restart" ${!st.running ? 'disabled' : ''}>Restart</button>
        <button class="btn danger" id="b-stop" ${!st.running ? 'disabled' : ''}>Stop</button>
      </div>
    </div>
    ${s.status === 'suspended' ? `<div class="notice bad">This server is suspended${s.suspended_reason ? ` — ${esc(s.suspended_reason)}` : ''}. ${s.suspended_reason === 'past_due' ? 'Settle the open invoice on the Billing tab and it restarts automatically.' : ''}</div>` : ''}
    ${!paid && s.status !== 'suspended' ? `<div class="notice warn">No active paid period. Head to the <a href="#/servers/${id}/billing">Billing tab</a> to pay the invoice — the server can start once it settles.</div>` : ''}
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tabbody"></div>`;

    $('#cp-connect').onclick = () => copy(d.connect, 'Connect string copied');
    document.querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; history.replaceState(null, '', `#/servers/${id}/${tab}`); draw(); });

    const act = async (verb) => {
      try { await api(`/servers/${id}/${verb}`, { method: 'POST' }); toast(`Server ${verb} sent.`, 'ok'); await load(); draw(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#b-start').onclick = () => act('start');
    $('#b-stop').onclick = () => act('stop');
    $('#b-restart').onclick = () => act('restart');

    ({ overview: tabOverview, console: tabConsole, settings: tabSettings, admins: tabAdmins,
       updates: tabUpdates, files: tabFiles, billing: tabBilling, danger: tabDanger }[tab] || tabOverview)();
  };

  /* — overview — */
  function tabOverview() {
    const s = d.server, st = d.state, sub = d.subscription;
    $('#tabbody').innerHTML = `
    <div class="stat-tiles">
      <div class="tile"><div class="tk">CPU</div><div class="tv">${st.stats ? st.stats.cpu_pct + '<small> %</small>' : '—'}</div></div>
      <div class="tile"><div class="tk">Memory</div><div class="tv">${st.stats ? `${st.stats.mem_mb}<small> / ${st.stats.mem_limit_mb} MB</small>` : '—'}</div></div>
      <div class="tile"><div class="tk">Node · Threads</div><div class="tv" style="font-size:13px">${esc(s.node_id)} · ${esc(s.cpuset)}</div></div>
      <div class="tile"><div class="tk">Port</div><div class="tv">${s.game_port}</div></div>
      <div class="tile"><div class="tk">Slots</div><div class="tv">${s.slots}</div></div>
      <div class="tile"><div class="tk">Paid until</div><div class="tv" style="font-size:13px">${sub ? dOnly(sub.paid_until) : '—'}</div></div>
    </div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><h3>Game</h3>
        <table><tr><td class="mut">Map</td><td class="mono">${esc(s.map)}</td></tr>
        <tr><td class="mut">Mode</td><td class="mono">${modeName(s.game_type, s.game_mode)}</td></tr>
        <tr><td class="mut">Join password</td><td class="mono">${s.sv_password_set ? 'set' : 'none'}</td></tr>
        <tr><td class="mut">GSLT</td><td class="mono">${s.gslt_set ? 'configured' : '<span style="color:var(--warn)">missing</span>'}</td></tr>
        <tr><td class="mut">Started</td><td class="mono">${st.running && st.started_at ? dt(Date.parse(st.started_at)) : '—'}</td></tr></table>
      </div>
      <div class="card"><h3>Stack</h3>
        <table>
        <tr><td class="mut">Metamod</td><td>${s.install_metamod ? '<span class="pill run">on</span>' : '<span class="pill stop">off</span>'}</td></tr>
        <tr><td class="mut">CounterStrikeSharp</td><td>${s.install_cssharp ? '<span class="pill run">on</span>' : '<span class="pill stop">off</span>'}</td></tr>
        <tr><td class="mut">FakeRcon</td><td>${s.install_fakercon ? '<span class="pill run">on</span>' : '<span class="pill stop">off</span>'}</td></tr>
        <tr><td class="mut">CS2-SimpleAdmin</td><td>${s.install_simpleadmin ? '<span class="pill run">on</span>' : '<span class="pill stop">off</span>'}</td></tr></table>
        <div class="hint">Toggle these on the Settings tab. Addon versions update on the Updates tab.</div>
      </div>
    </div>`;
  }

  /* — console — */
  function tabConsole() {
    $('#tabbody').innerHTML = `
    <div class="card">
      <div class="spread"><h3>Live console</h3>
        <div class="row"><label class="check" style="margin:0"><input type="checkbox" id="follow" checked> Follow</label>
        <button class="btn sm" id="refresh">Refresh</button></div></div>
      <div class="console" id="con">loading logs…</div>
      <div class="row" style="margin-top:12px">
        <input id="rcon-in" class="mono" placeholder="rcon command — e.g. status, changelevel de_mirage, say hello" style="flex:1">
        <button class="btn primary" id="rcon-go">Send</button>
      </div>
      <div class="hint">Commands run through the server's RCON (FakeRcon). Everything is logged to the audit trail.</div>
    </div>`;
    const con = $('#con');
    const pull = async () => {
      try {
        const { logs } = await api(`/servers/${id}/logs?lines=300`);
        const atEnd = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
        con.textContent = logs || '(no output yet — is the server running?)';
        if ($('#follow')?.checked && atEnd) con.scrollTop = con.scrollHeight;
      } catch (e) { con.textContent = e.message; }
    };
    pull(); con.scrollTop = con.scrollHeight;
    state.poll = setInterval(pull, 6000);
    $('#refresh').onclick = pull;
    const send = async () => {
      const cmd = $('#rcon-in').value.trim();
      if (!cmd) return;
      $('#rcon-in').value = '';
      const inEl = document.createElement('div'); inEl.className = 'rc-in'; inEl.textContent = `> ${cmd}`;
      con.appendChild(inEl);
      try {
        const { output } = await api(`/servers/${id}/rcon`, { method: 'POST', body: { command: cmd } });
        const o = document.createElement('div'); o.className = 'rc-out'; o.textContent = output; con.appendChild(o);
      } catch (e) { const o = document.createElement('div'); o.className = 'rc-out'; o.style.color = 'var(--bad)'; o.textContent = e.message; con.appendChild(o); }
      con.scrollTop = con.scrollHeight;
    };
    $('#rcon-go').onclick = send;
    $('#rcon-in').onkeydown = e => { if (e.key === 'Enter') send(); };
  }

  /* — settings — */
  function tabSettings() {
    const s = d.server;
    const ov = Object.entries(s.cfg_overrides || {}).map(([k, v]) => `${k} ${v}`).join('\n');
    $('#tabbody').innerHTML = `
    <div class="grid2">
      <div class="card"><h3>Game settings</h3>
        <div class="field"><label>Server name</label><input id="st-name" value="${esc(s.name)}"></div>
        <div class="field"><label>Map</label><input id="st-map" value="${esc(s.map)}" class="mono"></div>
        <div class="field"><label>Mode</label>${modeSelect('st-mode', s.game_type, s.game_mode)}</div>
        <div class="field"><label>Join password <span class="faint">(blank = public)</span></label><input id="st-pass" placeholder="${s.sv_password_set ? '•••••• (set — type to replace, clear to remove)' : 'none'}"></div>
        <div class="field"><label>GSLT</label><input id="st-gslt" class="mono" placeholder="${s.gslt_set ? 'configured — paste to replace' : 'paste token'}">
          <div class="hint">Tokens: <a href="https://steamcommunity.com/dev/managegameservers" target="_blank" rel="noopener">steamcommunity.com/dev/managegameservers</a> (App 730)</div></div>
      </div>
      <div class="card"><h3>Config overrides</h3>
        <div class="field"><label>Custom cvars <span class="faint">(one per line: <span class="mono">cvar value</span>)</span></label>
        <textarea id="st-cvars" spellcheck="false" placeholder="mp_roundtime 1.92&#10;mp_freezetime 15">${esc(ov)}</textarea>
        <div class="hint">Layered over the BoneHost default config. Anything else goes in <span class="mono">cs2/game/csgo/cfg/custom.cfg</span> via SFTP — it survives updates.</div></div>
        <h3 style="margin-top:20px">Plugins</h3>
        ${plugToggle('st-mm', 'Metamod:Source', 'Required for everything below.', s.install_metamod)}
        ${plugToggle('st-css', 'CounterStrikeSharp', 'Plugin runtime (needs Metamod).', s.install_cssharp)}
        ${plugToggle('st-frc', 'FakeRcon', 'Restores RCON — powers the Console tab.', s.install_fakercon)}
        ${plugToggle('st-sa', 'CS2-SimpleAdmin', 'In-game admin: kick/ban/mute (needs CS#).', s.install_simpleadmin)}
      </div>
    </div>
    <div class="card"><div class="spread">
      <label class="check" style="margin:0"><input type="checkbox" id="st-apply" checked> Apply now <span class="d">Recreates the container (~1 min downtime). Unchecked: saved for next restart.</span></label>
      <button class="btn primary" id="st-save">Save settings</button></div></div>`;
    wirePluginDeps('st');
    $('#st-save').onclick = async () => {
      const cvars = {};
      for (const line of $('#st-cvars').value.split('\n')) {
        const t = line.trim(); if (!t) continue;
        const i = t.search(/\s/); if (i < 1) { toast(`Cvar line needs a value: "${t}"`, 'err'); return; }
        cvars[t.slice(0, i)] = t.slice(i + 1).trim();
      }
      const [game_type, game_mode] = $('#st-mode').value.split(',').map(Number);
      const body = {
        name: $('#st-name').value, map: $('#st-map').value, game_type, game_mode,
        cfg_overrides: cvars, apply_now: $('#st-apply').checked,
        install_metamod: $('#st-mm').checked, install_cssharp: $('#st-css').checked,
        install_fakercon: $('#st-frc').checked, install_simpleadmin: $('#st-sa').checked,
      };
      if ($('#st-pass').value !== '') body.sv_password = $('#st-pass').value === '-' ? '' : $('#st-pass').value;
      if ($('#st-gslt').value.trim()) body.gslt = $('#st-gslt').value.trim();
      try {
        const r = await api(`/servers/${id}/settings`, { method: 'PATCH', body });
        toast(r.applied ? 'Saved — container is recreating.' : 'Saved — applies on next restart.', 'ok');
        await load(); draw();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* — admins — */
  function tabAdmins() {
    $('#tabbody').innerHTML = `
    <div class="card"><h3>Server admins</h3>
      <p class="mut small" style="margin-top:0">Paste a Steam profile link (<span class="mono">steamcommunity.com/id/…</span> or <span class="mono">/profiles/…</span>) or a SteamID64. Admins land in CounterStrikeSharp + SimpleAdmin on the next map change or restart.</p>
      <div class="row" style="align-items:flex-end">
        <div style="flex:2;min-width:220px"><label>Steam profile / ID</label><input id="ad-in" class="mono" placeholder="https://steamcommunity.com/id/yourfriend"></div>
        <div style="flex:1;min-width:140px"><label>Flags</label><input id="ad-flags" class="mono" value="@css/generic"></div>
        <button class="btn primary" id="ad-add">Add admin</button>
      </div>
      <div class="hint">Common flags: <span class="mono">@css/generic</span>, <span class="mono">@css/kick</span>, <span class="mono">@css/ban</span>, <span class="mono">@css/root</span> (full access).</div>
      <hr>
      <div class="tbl-wrap"><table id="ad-tbl">
        <tr><th>Name</th><th>SteamID64</th><th>Flags</th><th></th></tr>
        ${d.admins.map(a => `<tr>
          <td>${esc(a.label || '—')}</td><td class="mono">${esc(a.steamid64)}</td><td class="mono">${esc(a.flags)}</td>
          <td style="text-align:right"><button class="btn sm danger" data-rm="${esc(a.steamid64)}">Remove</button></td></tr>`).join('') ||
          '<tr><td colspan="4" class="mut">No admins yet.</td></tr>'}
      </table></div>
    </div>`;
    $('#ad-add').onclick = async () => {
      const input = $('#ad-in').value.trim();
      if (!input) return toast('Paste a Steam link or ID first.', 'err');
      try {
        const r = await api(`/servers/${id}/admins`, { method: 'POST', body: { input, flags: $('#ad-flags').value } });
        toast(`Added ${r.persona || r.steamid64}. ${r.note}`, 'ok'); await load(); draw();
      } catch (e) { toast(e.message, 'err'); }
    };
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
      try { await api(`/servers/${id}/admins/${b.dataset.rm}`, { method: 'DELETE' }); toast('Admin removed.', 'ok'); await load(); draw(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  /* — updates — */
  function tabUpdates() {
    const sc = d.schedule || {};
    $('#tabbody').innerHTML = `
    <div class="grid2">
      <div class="card"><h3>Automatic updates</h3>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="up-en" ${sc.enabled ? 'checked' : ''}>
          Enable scheduled updates <span class="d">Weekly SteamCMD pass at your chosen time (${esc(state.meta?.timezone || 'server time')}). The server restarts during the pass.</span></label>
        <div class="grid2">
          <div class="field"><label>Day</label><select id="up-day">${DAYS.map((n, i) => `<option value="${i}" ${sc.day_of_week === i ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div class="field"><label>Hour</label><select id="up-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${sc.hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div>
        </div>
        <label class="check"><input type="checkbox" id="up-mm" ${sc.include_metamod ? 'checked' : ''}> Include Metamod updates <span class="d">Pull the latest Metamod build with each scheduled pass.</span></label>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="up-css" ${sc.include_cssharp ? 'checked' : ''}> Include CounterStrikeSharp updates</label>
        <button class="btn primary" id="up-save" style="margin-top:16px">Save schedule</button>
      </div>
      <div class="card"><h3>Update now</h3>
        <div id="ver" class="mut small">Checking latest versions…</div>
        <hr>
        <label class="check"><input type="checkbox" id="now-mm"> Update Metamod</label>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="now-css"> Update CounterStrikeSharp</label>
        <div class="hint" style="margin-top:10px">Every manual pass validates CS2 game files via SteamCMD. Tick the boxes to push addon updates in the same pass — or run them alone as an independent addon push.</div>
        <button class="btn primary" id="now-go" style="margin-top:14px">Run update pass</button>
      </div>
    </div>`;
    api(`/servers/${id}/updates/latest`).then(v => {
      $('#ver').innerHTML = `<table>
        <tr><td class="mut">Metamod latest</td><td class="mono">${esc(v.metamod || 'unreachable')}</td></tr>
        <tr><td class="mut">CounterStrikeSharp latest</td><td class="mono">${v.cssharp ? `${esc(v.cssharp.tag)} <span class="faint">(${dOnly(Date.parse(v.cssharp.published_at))})</span>` : 'unreachable'}</td></tr></table>`;
    }).catch(() => { $('#ver').textContent = 'Version check failed.'; });
    $('#up-save').onclick = async () => {
      try {
        await api(`/servers/${id}/updates/schedule`, { method: 'PUT', body: {
          enabled: $('#up-en').checked, day_of_week: +$('#up-day').value, hour: +$('#up-hour').value,
          include_metamod: $('#up-mm').checked, include_cssharp: $('#up-css').checked } });
        toast('Update schedule saved.', 'ok'); await load();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#now-go').onclick = async () => {
      if (!await confirmModal('Run update pass?', 'The server restarts and is unavailable for a few minutes while SteamCMD validates.', 'Update now', false)) return;
      try {
        const r = await api(`/servers/${id}/updates/run`, { method: 'POST', body: { metamod: $('#now-mm').checked, cssharp: $('#now-css').checked } });
        toast(r.note, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* — files — */
  function tabFiles() {
    const a = d.access;
    const sshCmd = `ssh -p ${a.port} ${a.user}@${a.host}`;
    const sftpCmd = `sftp -P ${a.port} ${a.user}@${a.host}`;
    $('#tabbody').innerHTML = `
    <div class="grid2">
      <div class="card"><h3>SSH & SFTP — your own shell</h3>
        <p class="mut small" style="margin-top:0">Every server ships its own SSH daemon <b>inside the container</b> — you get a real shell and full file access to your server, completely walled off from the host machine and everyone else's servers.</p>
        <div class="grid2">
          <div class="field"><label>Host</label><div class="secret"><code>${esc(a.host)}</code><button class="btn sm" data-c="${esc(a.host)}">copy</button></div></div>
          <div class="field"><label>Port</label><div class="secret"><code>${a.port}</code><button class="btn sm" data-c="${a.port}">copy</button></div></div>
          <div class="field"><label>User</label><div class="secret"><code>${esc(a.user)}</code><button class="btn sm" data-c="${esc(a.user)}">copy</button></div></div>
          <div class="field"><label>Password</label><div class="secret"><code id="ssh-pw">••••••••••••</code><button class="btn sm" id="pw-show">show</button><button class="btn sm" data-c="${esc(a.password)}">copy</button></div></div>
        </div>
        <div class="field"><label>Terminal</label><div class="secret"><code>${esc(sshCmd)}</code><button class="btn sm" data-c="${esc(sshCmd)}">copy</button></div></div>
        <div class="field"><label>SFTP (or point FileZilla / WinSCP at the same creds)</label><div class="secret"><code>${esc(sftpCmd)}</code><button class="btn sm" data-c="${esc(sftpCmd)}">copy</button></div></div>
        <div class="hint">Game files live in <span class="mono">${esc(a.data_path)}</span>. Persistent config: <span class="mono">~/cs2data/panel-cfg/custom.cfg</span> — exec'd after the panel config and survives every update. The host key fingerprint stays stable across updates.</div>
      </div>
      <div class="card"><h3>SSH public key <span class="faint">(optional)</span></h3>
        <p class="mut small" style="margin-top:0">Paste a public key to log in without the password. Applied on the next restart or update pass.</p>
        <div class="field"><textarea id="ssh-key" spellcheck="false" placeholder="ssh-ed25519 AAAA... you@laptop" style="min-height:80px">${a.pubkey_set ? '' : ''}</textarea>
        ${a.pubkey_set ? '<div class="hint" style="color:var(--ok)">A key is currently installed. Save a new one to replace it, or save empty to remove it.</div>' : '<div class="hint">No key installed — password login only.</div>'}</div>
        <button class="btn primary" id="ssh-key-save">Save key</button>
      </div>
    </div>`;
    let shown = false;
    $('#pw-show').onclick = e => { shown = !shown; $('#ssh-pw').textContent = shown ? a.password : '••••••••••••'; e.target.textContent = shown ? 'hide' : 'show'; };
    document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => copy(b.dataset.c));
    $('#ssh-key-save').onclick = async () => {
      try {
        await api(`/servers/${id}/settings`, { method: 'PATCH', body: { ssh_pubkey: $('#ssh-key').value } });
        toast($('#ssh-key').value.trim() ? 'Key saved — applies on next restart.' : 'Key removed — applies on next restart.', 'ok');
        await load(); draw();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* — billing — */
  function tabBilling() {
    const sub = d.subscription, s = d.server;
    const paid = sub && sub.paid_until > Date.now();
    const manual = (state.meta?.payment?.provider || 'manual') === 'manual';
    const openTx = (d.transactions || []).find(t => ['open', 'new', 'processing'].includes(t.status));
    const pc = manual && openTx ? payCard(openTx, id, async () => { await load(); draw(); }) : null;
    $('#tabbody').innerHTML = `${pc ? pc.html : ''}
    <div class="grid2">
      <div class="card"><h3>Subscription</h3>
        <table>
          <tr><td class="mut">Plan</td><td>${sub ? `<b>${esc(sub.plan)}</b> · ${money(sub.price_cents)} / ${sub.plan === 'yearly' ? 'year' : 'month'}` : '—'}</td></tr>
          <tr><td class="mut">Status</td><td>${sub ? subPill(sub, s) : '—'}</td></tr>
          <tr><td class="mut">Paid until</td><td class="mono">${sub ? dt(sub.paid_until) : '—'}</td></tr>
          <tr><td class="mut">Grace period</td><td class="mono">${state.meta?.grace_days ?? 3} days past due, then automatic suspension</td></tr>
        </table>
        <div class="row" style="margin-top:16px">
          <button class="btn primary" id="pay-now">${paid ? 'Pay next period early' : 'Pay now'}</button>
          <button class="btn" id="plan-swap">${sub?.plan === 'yearly' ? 'Switch to monthly' : 'Switch to yearly'}</button>
        </div>
        <div class="hint">Payments go person-to-person (Venmo / Cash App) — no processor cut. Yearly bills ${state.meta?.yearly_months_charged ?? 10} months for 12. Plan changes take effect at your next renewal; paid time always carries over.</div>
      </div>
      <div class="card"><h3>How renewal works</h3>
        <p class="mut small" style="margin-top:0">An invoice opens ~7 days before your paid period ends and appears here and in your notices, with a unique code. Pay it on Venmo or Cash App with the code in the note; the host confirms when it lands and your paid-until date extends a full period. Miss it and the server suspends automatically after the grace window — paying the invoice restores and restarts it. The same clock governs monthly and yearly plans.</p>
      </div>
    </div>
    <div class="card"><h3>Transactions</h3>
      <div class="tbl-wrap"><table>
        <tr><th>Invoice</th><th>Plan</th><th>Amount</th><th>Period</th><th>Status</th><th>Created</th><th>Settled</th></tr>
        ${(d.transactions || []).map(t => `<tr>
          <td class="mono">${t.checkout_url ? `<a href="${esc(t.checkout_url)}" target="_blank" rel="noopener">${esc(t.invoice_id?.slice(0, 10))}…</a>` : esc(t.invoice_id || '—')}</td>
          <td class="mono">${esc(t.plan)}</td><td class="mono">${money(t.amount_cents, t.currency)}</td>
          <td class="mono small">${dOnly(t.period_start)} → ${dOnly(t.period_end)}</td>
          <td>${txPill(t.status)}</td><td class="mono small">${dt(t.created_at)}</td><td class="mono small">${t.settled_at ? dt(t.settled_at) : '—'}</td></tr>`).join('') ||
          '<tr><td colspan="7" class="mut">No transactions yet.</td></tr>'}
      </table></div>
    </div>`;
    $('#pay-now').onclick = async () => {
      try {
        const inv = await api(`/servers/${id}/billing/invoice`, { method: 'POST' });
        if (inv.checkout_url) { window.open(inv.checkout_url, '_blank'); toast('Invoice opened in a new tab.', 'ok'); }
        else toast(`Invoice ${inv.invoice_id} created — payment instructions above.`, 'ok');
        await load(); draw();
      } catch (e) { toast(e.message, 'err'); }
    };
    if (pc) pc.wire();
    $('#plan-swap').onclick = async () => {
      const next = sub?.plan === 'yearly' ? 'monthly' : 'yearly';
      if (!await confirmModal(`Switch to ${next}?`, 'Takes effect at your next renewal. Your current paid time carries over unchanged.', 'Switch plan', false)) return;
      try { await api(`/servers/${id}/billing/plan`, { method: 'POST', body: { plan: next } }); toast(`Plan set to ${next}.`, 'ok'); await load(); draw(); }
      catch (e) { toast(e.message, 'err'); }
    };
  }

  /* — danger — */
  function tabDanger() {
    $('#tabbody').innerHTML = `
    <div class="card" style="border-color:rgba(239,106,106,.3)"><h3 style="color:var(--bad)">Delete server</h3>
      <p class="mut small" style="margin-top:0">Stops and removes the container and cancels billing. Files are kept on disk for 30 days in case you change your mind — ask the host to restore.</p>
      <button class="btn danger" id="del">Delete this server</button></div>`;
    $('#del').onclick = async () => {
      if (!await confirmModal(`Delete ${d.server.name}?`, 'The container is removed and the subscription canceled. Files are retained for 30 days.', 'Delete server')) return;
      try { await api(`/servers/${id}`, { method: 'DELETE' }); toast('Server deleted.', 'ok'); nav('/servers'); }
      catch (e) { toast(e.message, 'err'); }
    };
  }

  draw();
  // background state refresh (skip while console tab drives its own poll)
  if (tab !== 'console') state.poll = setInterval(async () => { try { await load(); } catch { } }, 15000);
}

function subPill(sub, s) {
  if (s.status === 'suspended' && s.suspended_reason === 'past_due') return '<span class="pill bad">suspended</span>';
  if (sub.paid_until > Date.now()) return '<span class="pill run">active</span>';
  if (sub.status === 'past_due') return '<span class="pill warn">past due</span>';
  return '<span class="pill warn">payment pending</span>';
}
function txPill(st) {
  if (st === 'settled') return '<span class="pill run">settled</span>';
  if (st === 'open' || st === 'new') return '<span class="pill warn">awaiting payment</span>';
  if (st === 'processing') return '<span class="pill warn">sent — confirming</span>';
  if (st === 'expired' || st === 'invalid' || st === 'void') return `<span class="pill bad">${st}</span>`;
  return `<span class="pill stop">${esc(st)}</span>`;
}

/* Venmo / Cash App deep links for a manual invoice. */
function payLinks(tx) {
  const p = state.meta?.payment || {};
  const amt = (tx.amount_cents / 100).toFixed(2);
  const out = [];
  if (p.venmo) out.push({ name: 'Venmo', url: `https://venmo.com/${encodeURIComponent(p.venmo)}?txn=pay&amount=${amt}&note=${encodeURIComponent(tx.invoice_id)}`, prefills: true });
  if (p.cashapp) out.push({ name: 'Cash App', url: `https://cash.app/$${encodeURIComponent(p.cashapp)}/${amt}`, prefills: false });
  return out;
}

function payCard(tx, serverId, afterChange) {
  const links = payLinks(tx);
  const waiting = tx.status === 'processing';
  return {
    html: `<div class="card" style="border-color:rgba(230,180,85,.35)">
      <div class="spread"><h3 style="margin:0">${waiting ? 'Payment sent — waiting for confirmation' : 'Pay this invoice'}</h3>${txPill(tx.status)}</div>
      <div class="price-box" style="margin:14px 0">
        <div><div class="faint small">AMOUNT DUE</div><div class="price-big">${money(tx.amount_cents, tx.currency)}</div></div>
        <div><div class="faint small">INVOICE CODE — put this in the payment note</div>
          <div class="secret" style="margin-top:4px"><code style="font-size:15px;letter-spacing:.06em">${esc(tx.invoice_id)}</code>
          <button class="btn sm" id="pc-copy">copy</button></div></div>
      </div>
      ${waiting
        ? `<p class="mut small" style="margin:0">The host has been pinged and will confirm as soon as the payment shows up — your paid-until date extends the moment they do. Suspended servers restart automatically.</p>`
        : `<div class="row">${links.map((l, i) => `<a class="btn ${i === 0 ? 'primary' : ''}" href="${l.url}" target="_blank" rel="noopener">Pay with ${l.name}</a>`).join('')}
           <button class="btn ok" id="pc-sent">I've sent it</button></div>
           <div class="hint" style="margin-top:10px">${links.some(l => !l.prefills) ? 'Cash App doesn\u2019t prefill notes — paste the invoice code into the \u201cFor\u201d field yourself. ' : ''}${esc(state.meta?.payment?.note || '')} Once you tap \u201cI've sent it\u201d the host gets a notification to confirm.</div>`}
    </div>`,
    wire() {
      const c = $('#pc-copy'); if (c) c.onclick = () => copy(tx.invoice_id, 'Invoice code copied');
      const b = $('#pc-sent'); if (b) b.onclick = async () => {
        try { await api(`/servers/${serverId}/billing/declare`, { method: 'POST' }); toast('Marked as sent — the host has been notified.', 'ok'); await afterChange(); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  };
}

const MODES = [
  ['0,1', 'Competitive'], ['0,0', 'Casual'], ['0,2', 'Wingman'],
  ['1,2', 'Deathmatch'], ['1,0', 'Arms Race'], ['1,1', 'Demolition'], ['3,0', 'Custom'],
];
const modeName = (t, m) => (MODES.find(([v]) => v === `${t},${m}`)?.[1]) || `game_type ${t} / game_mode ${m}`;
const modeSelect = (id, t, m) =>
  `<select id="${id}">${MODES.map(([v, n]) => `<option value="${v}" ${v === `${t},${m}` ? 'selected' : ''}>${n}</option>`).join('')}</select>`;

const plugToggle = (id, name, desc, on) =>
  `<label class="check" style="margin-bottom:9px"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${name} <span class="d">${desc}</span></label>`;

function wirePluginDeps(prefix) {
  const mm = $(`#${prefix}-mm`), css = $(`#${prefix}-css`), frc = $(`#${prefix}-frc`), sa = $(`#${prefix}-sa`);
  const sync = () => {
    if (!mm.checked) { css.checked = frc.checked = sa.checked = false; }
    if (!css.checked) { frc.checked = sa.checked = false; }
  };
  mm.onchange = sync; css.onchange = sync;
  const up = el => el.onchange = () => { if (el.checked) { mm.checked = true; css.checked = true; } };
  up(frc); up(sa);
}

/* ── wizard ───────────────────────────────────────────────────────────── */
function renderWizard() {
  shell('new', `<div class="page-head"><div><h1>New server</h1>
    <div class="sub">Four steps — live in minutes once the first invoice settles.</div></div></div>
    <div style="max-width:720px"><div class="wiz-steps" id="wsteps"></div><div id="wbody"></div></div>`);

  const w = {
    name: '', slots: 10, gslt: '', map: state.meta?.default_map || 'de_dust2', mode: '0,1', sv_password: '',
    install_metamod: true, install_cssharp: true, install_fakercon: true, install_simpleadmin: true,
    admins: [], plan: 'monthly',
  };
  let step = 0, pricing = null;

  const steps = () => { $('#wsteps').innerHTML = [0, 1, 2, 3].map(i => `<div class="wiz-step ${i <= step ? 'on' : ''}"></div>`).join(''); };

  const stepBasics = () => `
    <div class="card"><h2>Basics</h2>
      <div class="field"><label>Server name</label><input id="w-name" value="${esc(w.name)}" placeholder="Friday Night Frags" maxlength="60"></div>
      <div class="field"><label>Player slots — <b id="w-slots-n">${w.slots}</b></label>
        <input type="range" id="w-slots" min="2" max="64" value="${w.slots}">
        <div class="hint">Pricing is per slot: ${money(state.meta?.per_slot_cents ?? 2000)}/slot/month.</div></div>
      <div class="grid2">
        <div class="field"><label>Starting map</label><input id="w-map" class="mono" value="${esc(w.map)}"></div>
        <div class="field"><label>Mode</label>${modeSelect('w-mode', ...w.mode.split(',').map(Number))}</div>
      </div>
      <div class="field"><label>Join password <span class="faint">(optional)</span></label><input id="w-pass" value="${esc(w.sv_password)}" placeholder="Leave blank for public"></div>
      <div class="field"><label>Game Server Login Token (GSLT)</label><input id="w-gslt" class="mono" value="${esc(w.gslt)}" placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX">
        <div class="hint">Required by Valve for internet-visible servers. Create one free at
        <a href="https://steamcommunity.com/dev/managegameservers" target="_blank" rel="noopener">steamcommunity.com/dev/managegameservers</a> — App ID <span class="mono">730</span>.</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="w-next">Continue</button></div>
    </div>`;

  const stepPlugins = () => `
    <div class="card"><h2>Plugins</h2>
      <p class="mut small" style="margin-top:0">The standard BoneHost stack — installed and kept up to date automatically. Leave these on unless you know you don't want them.</p>
      ${plugToggle('w-mm', 'Metamod:Source', 'The base modding layer. Required for everything below.', w.install_metamod)}
      ${plugToggle('w-css', 'CounterStrikeSharp', 'The plugin runtime most CS2 plugins target.', w.install_cssharp)}
      ${plugToggle('w-frc', 'FakeRcon', 'Restores RCON so the web console and tools work.', w.install_fakercon)}
      ${plugToggle('w-sa', 'CS2-SimpleAdmin', 'In-game !kick, !ban, !mute for your admins. Gets its own database automatically.', w.install_simpleadmin)}
      <div class="row" style="justify-content:space-between;margin-top:16px"><button class="btn" id="w-back">Back</button><button class="btn primary" id="w-next">Continue</button></div>
    </div>`;

  const stepAdmins = () => `
    <div class="card"><h2>Admins</h2>
      <p class="mut small" style="margin-top:0">Who gets in-game admin? Paste Steam profile links or SteamID64s — we resolve them for you. You can always add more later.</p>
      <div class="row" style="align-items:flex-end">
        <div style="flex:1;min-width:240px"><label>Steam profile / ID</label><input id="w-adin" class="mono" placeholder="https://steamcommunity.com/id/yourfriend"></div>
        <button class="btn" id="w-adres">Add</button>
      </div>
      <div id="w-adlist" style="margin-top:14px">${w.admins.map(adminChip).join('') || '<span class="faint small">No admins added yet — that\u2019s fine.</span>'}</div>
      <div class="row" style="justify-content:space-between;margin-top:18px"><button class="btn" id="w-back">Back</button><button class="btn primary" id="w-next">Continue</button></div>
    </div>`;

  const adminChip = (a, i) => `<span class="chip">${esc(a.persona || a.label || a.input)} <span class="faint">${esc(a.steamid64 || '')}</span><button data-adrm="${i}">×</button></span>`;

  const stepPlan = () => `
    <div class="card"><h2>Plan & review</h2>
      <div class="plan-pick">
        <div class="plan-opt ${w.plan === 'monthly' ? 'on' : ''}" data-plan="monthly">
          <div class="pn">Monthly</div><div class="pp">${pricing ? money(pricing.monthly_cents) + ' / month' : '…'}</div></div>
        <div class="plan-opt ${w.plan === 'yearly' ? 'on' : ''}" data-plan="yearly">
          <div class="pn">Yearly <span class="save-tag">${12 - (state.meta?.yearly_months_charged ?? 10)} MONTHS FREE</span></div>
          <div class="pp">${pricing ? money(pricing.yearly_cents) + ' / year' : '…'}</div></div>
      </div>
      <div class="price-box" style="margin-top:16px">
        <div><div class="faint small">DUE TODAY</div>
          <div class="price-big" id="w-price">${pricing ? money(w.plan === 'yearly' ? pricing.yearly_cents : pricing.monthly_cents) : '…'}
          <small>/ ${w.plan === 'yearly' ? 'year' : 'month'}</small></div></div>
        <div class="small mut" style="max-width:280px">${esc(w.name || 'Server')} · ${w.slots} slots · ${modeName(...w.mode.split(',').map(Number))} on ${esc(w.map)}<br>
          ${w.admins.length} admin${w.admins.length === 1 ? '' : 's'} · plugins: ${['install_metamod', 'install_cssharp', 'install_fakercon', 'install_simpleadmin'].filter(k => w[k]).length}/4</div>
      </div>
      <div class="hint" style="margin-top:12px">Payment is upfront, person-to-person via Venmo or Cash App — no processor fees. Your invoice comes with a unique code; the server is provisioned immediately and starts the moment the host confirms the payment landed. Renewals arrive ~7 days before each period ends; unpaid servers suspend automatically after a ${state.meta?.grace_days ?? 3}-day grace window.</div>
      <div class="row" style="justify-content:space-between;margin-top:18px"><button class="btn" id="w-back">Back</button>
        <button class="btn primary" id="w-go">Create server & get invoice</button></div>
    </div>`;

  async function refreshPricing() {
    try { pricing = await api(`/servers/pricing?slots=${w.slots}`); } catch { pricing = null; }
  }

  const grab = () => {
    if (step === 0) {
      w.name = $('#w-name').value.trim(); w.slots = +$('#w-slots').value; w.map = $('#w-map').value.trim();
      w.mode = $('#w-mode').value; w.sv_password = $('#w-pass').value; w.gslt = $('#w-gslt').value.trim();
    } else if (step === 1) {
      w.install_metamod = $('#w-mm').checked; w.install_cssharp = $('#w-css').checked;
      w.install_fakercon = $('#w-frc').checked; w.install_simpleadmin = $('#w-sa').checked;
    }
  };

  async function draw() {
    steps();
    if (step === 3) await refreshPricing();
    $('#wbody').innerHTML = [stepBasics, stepPlugins, stepAdmins, stepPlan][step]();
    const back = $('#w-back'); if (back) back.onclick = () => { grab(); step--; draw(); };

    if (step === 0) {
      $('#w-slots').oninput = e => { $('#w-slots-n').textContent = e.target.value; };
      $('#w-next').onclick = () => {
        grab();
        if (!w.name) return toast('Give the server a name.', 'err');
        if (!w.gslt) return toast('A GSLT token is required — the link below the field takes 30 seconds.', 'err');
        step = 1; draw();
      };
    }
    if (step === 1) { wirePluginDeps('w'); $('#w-next').onclick = () => { grab(); step = 2; draw(); }; }
    if (step === 2) {
      const addAdmin = async () => {
        const input = $('#w-adin').value.trim(); if (!input) return;
        $('#w-adres').disabled = true;
        try {
          const r = await api('/servers/resolve-steam', { method: 'POST', body: { input } });
          if (w.admins.some(a => a.steamid64 === r.steamid64)) toast('Already on the list.', 'err');
          else { w.admins.push({ input, steamid64: r.steamid64, persona: r.persona }); toast(`Resolved ${r.persona || r.steamid64}.`, 'ok'); }
          $('#w-adin').value = ''; draw();
        } catch (e) { toast(e.message, 'err'); }
        finally { const b = $('#w-adres'); if (b) b.disabled = false; }
      };
      $('#w-adres').onclick = addAdmin;
      $('#w-adin').onkeydown = e => { if (e.key === 'Enter') addAdmin(); };
      document.querySelectorAll('[data-adrm]').forEach(b => b.onclick = () => { w.admins.splice(+b.dataset.adrm, 1); draw(); });
      $('#w-next').onclick = () => { step = 3; draw(); };
    }
    if (step === 3) {
      document.querySelectorAll('.plan-opt').forEach(p => p.onclick = () => { w.plan = p.dataset.plan; draw(); });
      $('#w-go').onclick = async () => {
        $('#w-go').disabled = true; $('#w-go').textContent = 'Provisioning…';
        const [game_type, game_mode] = w.mode.split(',').map(Number);
        try {
          const r = await api('/servers', { method: 'POST', body: {
            name: w.name, slots: w.slots, gslt: w.gslt, map: w.map, game_type, game_mode,
            sv_password: w.sv_password, plan: w.plan,
            install_metamod: w.install_metamod, install_cssharp: w.install_cssharp,
            install_fakercon: w.install_fakercon, install_simpleadmin: w.install_simpleadmin,
            admins: w.admins.map(a => ({ input: a.input, label: a.persona })),
          } });
          if (r.invoice?.checkout_url) { window.open(r.invoice.checkout_url, '_blank'); toast('Server created — invoice opened in a new tab.', 'ok'); }
          else if (r.invoice) toast(`Server created — invoice ${r.invoice.invoice_id}. Payment instructions are on the Billing tab.`, 'ok');
          else if (r.billing_note) toast(`Server created. Billing note: ${r.billing_note}`, 'err');
          else toast('Server created.', 'ok');
          nav(`/servers/${r.server.id}/billing`);
        } catch (e) {
          toast(e.message, 'err');
          $('#w-go').disabled = false; $('#w-go').textContent = 'Create server & get invoice';
        }
      };
    }
  }
  draw();
}

/* ── billing overview ─────────────────────────────────────────────────── */
async function renderBilling() {
  shell('billing', `<div class="page-head"><div><h1>Billing</h1>
    <div class="sub">Every payment, per server — person-to-person, zero processor cut.</div></div></div>
    <div id="bl"><div class="empty">Loading…</div></div>`);
  let servers;
  try { servers = await api('/servers'); } catch (e) { return toast(e.message, 'err'); }
  // Admins see the whole fleet on GET /servers; personal billing shows only their own.
  // Fleet-wide money lives under Admin › Ledger.
  const rows = state.me.role === 'admin' ? servers.filter(s => s.owner_id === state.me.id) : servers;
  if (!rows.length) { $('#bl').innerHTML = `<div class="empty">No servers — nothing to bill. <br><br><a class="btn primary" href="#/new">Create one</a></div>`; return; }
  const details = await Promise.all(rows.map(s => api(`/servers/${s.id}`).catch(() => null)));
  $('#bl').innerHTML = details.filter(Boolean).map(d => {
    const s = d.server, sub = d.subscription;
    return `<div class="card"><div class="spread">
      <div><h3 style="margin:0"><a href="#/servers/${s.id}/billing">${esc(s.name)}</a></h3>
        <div class="small mut" style="margin-top:4px">${sub ? `${esc(sub.plan)} · ${money(sub.price_cents)} · paid until <span class="mono">${dOnly(sub.paid_until)}</span>` : 'no subscription'}</div></div>
      ${sub ? subPill(sub, s) : ''}</div>
      ${(d.transactions || []).length ? `<hr><div class="tbl-wrap"><table>
        <tr><th>Invoice</th><th>Amount</th><th>Period</th><th>Status</th><th>Settled</th></tr>
        ${d.transactions.slice(0, 5).map(t => `<tr>
          <td class="mono">${t.checkout_url ? `<a href="${esc(t.checkout_url)}" target="_blank" rel="noopener">${esc((t.invoice_id || '').slice(0, 10))}…</a>` : esc(t.invoice_id || '—')}</td>
          <td class="mono">${money(t.amount_cents, t.currency)}</td>
          <td class="mono small">${dOnly(t.period_start)} → ${dOnly(t.period_end)}</td>
          <td>${txPill(t.status)}</td><td class="mono small">${t.settled_at ? dt(t.settled_at) : '—'}</td></tr>`).join('')}
      </table></div>` : ''}</div>`;
  }).join('');
}

/* ── account ──────────────────────────────────────────────────────────── */
async function renderAccount() {
  shell('account', `<div class="page-head"><div><h1>Account</h1><div class="sub">${esc(state.me.email)} · ${esc(state.me.role)}</div></div></div>
  <div class="grid2">
    <div class="card"><h3>Notices</h3><div id="ntc">${state.notices.length ? state.notices.map(n =>
      `<div class="notice ${/suspend|past_due|expired/.test(n.kind) ? 'bad' : /renewal|due/.test(n.kind) ? 'warn' : ''}">${esc(n.body)}<div class="t">${esc(n.kind)} · ${dt(n.ts)}</div></div>`).join('') :
      '<div class="mut small">Nothing yet — renewal reminders and billing events show up here.</div>'}</div>
      ${state.notices.some(n => !n.read) ? '<button class="btn sm" id="mark-read" style="margin-top:8px">Mark all read</button>' : ''}</div>
    <div class="card"><h3>Change password</h3>
      <div class="field"><label>Current password</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input id="pw-new" type="password" minlength="10" autocomplete="new-password">
        <div class="hint">At least 10 characters.</div></div>
      <button class="btn primary" id="pw-go">Update password</button></div>
  </div>`);
  const mr = $('#mark-read');
  if (mr) mr.onclick = async () => { await api('/auth/notices/read', { method: 'POST' }); state.notices.forEach(n => n.read = 1); renderAccount(); };
  $('#pw-go').onclick = async () => {
    try {
      await api('/auth/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
      toast('Password updated.', 'ok'); $('#pw-cur').value = $('#pw-new').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ── admin ────────────────────────────────────────────────────────────── */
async function renderAdmin(sub) {
  if (state.me?.role !== 'admin') return nav('/servers');
  shell('admin', `<div class="page-head"><div><h1>Admin</h1><div class="sub">Host control — every action here is audited.</div></div></div>
  <div class="tabs">
    <button class="tab ${sub === 'overview' ? 'on' : ''}" data-t="">Overview</button>
    <button class="tab ${sub === 'ledger' ? 'on' : ''}" data-t="/ledger">Ledger</button>
    <button class="tab ${sub === 'audit' ? 'on' : ''}" data-t="/audit">Audit log</button>
  </div><div id="abody"><div class="empty">Loading…</div></div>`);
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => nav(`/admin${b.dataset.t}`));

  if (sub === 'ledger') {
    let txs; try { txs = await api('/admin/transactions'); } catch (e) { return toast(e.message, 'err'); }
    $('#abody').innerHTML = `<div class="card"><div class="spread"><h3>All transactions (${txs.length})</h3>
      <a class="btn sm" href="/api/admin/transactions.csv">Export CSV</a></div>
      <div class="tbl-wrap"><table>
      <tr><th>#</th><th>User</th><th>Server</th><th>Invoice</th><th>Plan</th><th>Amount</th><th>Period</th><th>Status</th><th>Settled</th><th></th></tr>
      ${txs.map(t => `<tr><td class="mono">${t.id}</td><td class="small">${esc(t.email)}</td><td class="mono small">${esc(t.server_id)}</td>
        <td class="mono small">${esc(t.invoice_id || '')}</td><td class="mono">${esc(t.plan)}</td>
        <td class="mono">${money(t.amount_cents, t.currency)}</td>
        <td class="mono small">${dOnly(t.period_start)} → ${dOnly(t.period_end)}</td>
        <td>${txPill(t.status)}</td><td class="mono small">${t.settled_at ? dt(t.settled_at) : '—'}</td>
        <td style="text-align:right;white-space:nowrap">${['open', 'new', 'processing'].includes(t.status)
          ? `<button class="btn sm ok" data-tx="${t.id}" data-txa="confirm">Confirm</button>
             <button class="btn sm danger" data-tx="${t.id}" data-txa="void">Void</button>` : ''}</td></tr>`).join('') ||
        '<tr><td colspan="10" class="mut">Empty ledger.</td></tr>'}
      </table></div>
      <div class="hint">Open invoices settle when you hit <b>Confirm</b> after the Venmo/Cash App payment lands — that extends the payer's period and auto-restarts suspended servers. The append-only JSONL ledger with full event payloads lives in <span class="mono">/srv/bonehost/ledger/</span> on the host.</div></div>`;
    document.querySelectorAll('[data-tx]').forEach(b => b.onclick = async () => {
      const a = b.dataset.txa;
      if (a === 'confirm' && !await confirmModal('Confirm payment received?', 'Did the money actually land in Venmo/Cash App? This extends the paid period and restarts suspended servers.', 'Payment received', false)) return;
      if (a === 'void' && !await confirmModal('Void invoice?', 'Marks the invoice void. A fresh one can be created afterwards.')) return;
      try { await api(`/admin/transactions/${b.dataset.tx}/${a}`, { method: 'POST' }); toast(a === 'confirm' ? 'Settled — period extended.' : 'Invoice voided.', 'ok'); renderAdmin('ledger'); }
      catch (e) { toast(e.message, 'err'); }
    });
    return;
  }

  if (sub === 'audit') {
    let rows; try { rows = await api('/admin/audit'); } catch (e) { return toast(e.message, 'err'); }
    $('#abody').innerHTML = `<div class="card"><h3>Audit log</h3><div class="tbl-wrap"><table>
      <tr><th>When</th><th>Who</th><th>IP</th><th>Action</th><th>Target</th><th class="mono">Detail</th></tr>
      ${rows.map(a => `<tr><td class="mono small">${dt(a.ts)}</td><td class="small">${esc(a.email || 'system')}</td>
        <td class="mono small">${esc(a.ip || '')}</td><td class="mono small">${esc(a.action)}</td>
        <td class="mono small">${esc(a.target || '')}</td><td class="mono small" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.detail || '')}">${esc(a.detail || '')}</td></tr>`).join('')}
      </table></div></div>`;
    return;
  }

  /* overview */
  let ov; try { ov = await api('/admin/overview'); } catch (e) { return toast(e.message, 'err'); }
  const nodeCard = nd => {
    const memPct = Math.round(100 * nd.memory.allocated_mb / nd.memory.budget_mb);
    const usedSet = new Set(nd.cpu.used);
    const maxT = Math.max(...nd.cpu.pool, 0) + 1;
    const h = nd.health || {};
    return `<div class="card">
      <div class="spread"><h3 style="margin:0">${esc(nd.name || nd.id)}</h3>
        ${h.ok ? '<span class="pill run">agent healthy</span>' : '<span class="pill bad">agent unreachable</span>'}</div>
      <div class="small mut mono" style="margin:4px 0 12px">${esc(nd.public_host)} · ${esc(nd.agent_url)}${h.servers_running != null ? ` · ${h.servers_running} container${h.servers_running === 1 ? '' : 's'} up` : ''}</div>
      ${!h.ok && h.error ? `<div class="notice bad" style="margin-bottom:12px">${esc(h.error)}</div>` : ''}
      <div class="threadmap">${Array.from({ length: maxT }, (_, t) => {
        const inPool = nd.cpu.pool.includes(t);
        return `<div class="th ${usedSet.has(t) ? 'used' : ''} ${inPool ? '' : 'rsv'}" title="${inPool ? (usedSet.has(t) ? 'allocated' : 'free') : 'reserved for node OS'}">${t}</div>`;
      }).join('')}</div>
      <div class="hint">Bright = allocated · dim = reserved for the node's OS/agent/DB. ${nd.cpu.free.length} of ${nd.cpu.pool.length} pool threads free.</div>
      <div class="spread small mono" style="margin-top:12px"><span>${(nd.memory.allocated_mb / 1024).toFixed(1)} GB allocated</span><span>${(nd.memory.budget_mb / 1024).toFixed(1)} GB budget</span></div>
      <div class="bar" style="margin-top:6px"><i style="width:${Math.min(memPct, 100)}%"></i></div>
    </div>`;
  };
  $('#abody').innerHTML = `
  <div class="${ov.nodes.length > 1 ? 'grid2' : ''}">${ov.nodes.map(nodeCard).join('')}</div>
  <div class="card" style="margin-top:16px"><div class="spread">
    <div class="small mut">Latest upstream: Metamod <span class="mono">${esc(ov.versions?.metamod || '?')}</span> · CS# <span class="mono">${esc(ov.versions?.cssharp?.tag || '?')}</span></div>
    <span class="small faint">Select servers below to start, stop, update, or broadcast an RCON command across the fleet.</span></div></div>
  <div class="card"><div class="spread"><h3 style="margin:0">Fleet</h3><span class="small mut" id="fl-count"></span></div>
    <div class="row" style="margin:12px 0;padding:10px;background:var(--bg-inset);border:1px solid var(--line);border-radius:9px">
      <button class="btn sm ok" data-fleet="start">Start</button>
      <button class="btn sm" data-fleet="restart">Restart</button>
      <button class="btn sm danger" data-fleet="stop">Stop</button>
      <span style="width:1px;height:22px;background:var(--line-strong)"></span>
      <label class="check" style="margin:0"><input type="checkbox" id="fl-mm"> +Metamod</label>
      <label class="check" style="margin:0"><input type="checkbox" id="fl-css"> +CS#</label>
      <button class="btn sm primary" data-fleet="update">Run update pass</button>
      <span style="width:1px;height:22px;background:var(--line-strong)"></span>
      <input id="fl-rcon" class="mono" placeholder="broadcast rcon — e.g. say Updating in 5 min" style="flex:1;min-width:220px;padding:5px 10px;font-size:12.5px">
      <button class="btn sm" data-fleet="rcon">Send to selected</button>
    </div>
    <div id="fl-results"></div>
    <div class="tbl-wrap"><table>
    <tr><th style="width:28px"><input type="checkbox" id="fl-all"></th><th>Server</th><th>Owner</th><th>Node</th><th>Threads</th><th>RAM</th><th>Port</th><th>Status</th><th>Paid until</th><th></th></tr>
    ${ov.servers.map(s => {
      const u = ov.users.find(x => x.id === s.owner_id);
      return `<tr><td><input type="checkbox" class="fl-pick" value="${s.id}"></td><td><a href="#/servers/${s.id}">${esc(s.name)}</a></td><td class="small">${esc(u?.email || s.owner_id)}</td>
      <td class="mono small">${esc(s.node_id)}</td><td class="mono small">${esc(s.cpuset)}</td><td class="mono small">${s.memory_mb}</td><td class="mono">${s.game_port}</td>
      <td>${statusPill(s, s.state)}</td>
      <td class="mono small">${s.subscription ? dOnly(s.subscription.paid_until) : '—'}</td>
      <td style="text-align:right;white-space:nowrap">
        ${s.status === 'suspended'
          ? `<button class="btn sm ok" data-a="unsuspend" data-id="${s.id}">Unsuspend</button>`
          : `<button class="btn sm" data-a="suspend" data-id="${s.id}">Suspend</button>`}
        <button class="btn sm" data-a="comp" data-id="${s.id}">Comp</button>
        <button class="btn sm danger" data-a="del" data-id="${s.id}" data-n="${esc(s.name)}">Delete</button></td></tr>`;
    }).join('') || '<tr><td colspan="10" class="mut">No servers.</td></tr>'}
  </table></div></div>
  <div class="grid2">
    <div class="card"><h3>Users</h3><div class="tbl-wrap"><table>
      <tr><th>Email</th><th>Role</th><th>Since</th><th></th></tr>
      ${ov.users.map(u => `<tr><td>${esc(u.email)}</td><td class="mono small">${esc(u.role)}${u.disabled ? ' · <span style="color:var(--bad)">disabled</span>' : ''}</td>
        <td class="mono small">${dOnly(u.created_at)}</td>
        <td style="text-align:right">${u.role !== 'admin' ? `<button class="btn sm ${u.disabled ? 'ok' : 'danger'}" data-u="${u.id}" data-dis="${u.disabled ? 0 : 1}">${u.disabled ? 'Enable' : 'Disable'}</button>` : ''}</td></tr>`).join('')}
    </table></div></div>
    <div class="card"><h3>Invites</h3>
      <button class="btn primary sm" id="mint">Mint invite code</button>
      <div class="tbl-wrap" style="margin-top:12px"><table>
        <tr><th>Code</th><th>Status</th><th>Created</th></tr>
        ${ov.invites.map(i => `<tr><td class="mono">${esc(i.code)} <button class="btn sm" data-c="${esc(i.code)}">copy</button></td>
          <td>${i.used_by ? `<span class="pill stop">used</span>` : '<span class="pill run">open</span>'}</td>
          <td class="mono small">${dOnly(i.created_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">None yet.</td></tr>'}
      </table></div></div>
  </div>`;

  const picks = () => [...document.querySelectorAll('.fl-pick:checked')].map(x => x.value);
  const updateCount = () => { $('#fl-count').textContent = picks().length ? `${picks().length} selected` : ''; };
  $('#fl-all').onchange = e => { document.querySelectorAll('.fl-pick').forEach(x => x.checked = e.target.checked); updateCount(); };
  document.querySelectorAll('.fl-pick').forEach(x => x.onchange = updateCount);
  document.querySelectorAll('[data-fleet]').forEach(b => b.onclick = async () => {
    const action = b.dataset.fleet;
    const ids = picks();
    if (!ids.length) return toast('Select at least one server first (checkboxes on the left).', 'err');
    const body = { action, server_ids: ids };
    if (action === 'update') body.opts = { metamod: $('#fl-mm').checked, cssharp: $('#fl-css').checked };
    if (action === 'rcon') {
      body.command = $('#fl-rcon').value.trim();
      if (!body.command) return toast('Type the RCON command to broadcast.', 'err');
    }
    const labels = { start: 'Start', stop: 'Stop', restart: 'Restart', update: 'Run an update pass on', rcon: 'Broadcast to' };
    if (action !== 'rcon' && !await confirmModal(`${labels[action]} ${ids.length} server${ids.length > 1 ? 's' : ''}?`,
      action === 'update' ? 'Each server restarts and validates via SteamCMD — a few minutes of downtime per server.' : 'Applies to every selected server.',
      labels[action], action === 'stop')) return;
    b.disabled = true;
    try {
      const r = await api('/admin/fleet', { method: 'POST', body });
      const okN = r.results.filter(x => x.ok).length;
      toast(`${action}: ${okN}/${r.results.length} succeeded.`, okN === r.results.length ? 'ok' : 'err');
      $('#fl-results').innerHTML = `<div class="card" style="margin-bottom:12px;padding:14px"><div class="spread"><h3 style="margin:0;font-size:13px">Results — ${esc(action)}</h3><button class="btn sm" id="fl-clear">dismiss</button></div>
        <div class="tbl-wrap" style="margin-top:8px"><table>${r.results.map(x =>
          `<tr><td class="mono small">${esc(x.id)}</td><td>${x.ok ? '<span class="pill run">ok</span>' : '<span class="pill bad">failed</span>'}</td><td class="mono small" style="white-space:pre-wrap">${esc(x.detail)}</td></tr>`).join('')}</table></div></div>`;
      $('#fl-clear').onclick = () => { $('#fl-results').innerHTML = ''; };
      if (action !== 'rcon') setTimeout(() => renderAdmin('overview'), 400);
    } catch (e) { toast(e.message, 'err'); }
    finally { b.disabled = false; }
  });
  $('#mint').onclick = async () => {
    try { const { code } = await api('/admin/invites', { method: 'POST' }); copy(code, `Invite ${code} copied`); renderAdmin('overview'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => copy(b.dataset.c, 'Invite copied'));
  document.querySelectorAll('[data-u]').forEach(b => b.onclick = async () => {
    try { await api(`/admin/users/${b.dataset.u}/disable`, { method: 'POST', body: { disabled: b.dataset.dis === '1' } }); renderAdmin('overview'); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id, a = b.dataset.a;
    try {
      if (a === 'suspend') {
        if (!await confirmModal('Suspend server?', 'Stops the container and blocks the owner from starting it until unsuspended.')) return;
        await api(`/admin/servers/${id}/suspend`, { method: 'POST', body: { reason: 'admin' } });
      } else if (a === 'unsuspend') {
        await api(`/admin/servers/${id}/unsuspend`, { method: 'POST', body: { start: true } });
      } else if (a === 'comp') {
        const days = parseInt(prompt('Comp how many free days?', '7'), 10);
        if (!days) return;
        await api(`/admin/servers/${id}/comp`, { method: 'POST', body: { days } });
      } else if (a === 'del') {
        if (!await confirmModal(`Delete ${b.dataset.n}?`, 'Removes the container and cancels billing. Files retained 30 days.')) return;
        await api(`/admin/servers/${id}`, { method: 'DELETE' });
      }
      toast('Done.', 'ok'); renderAdmin('overview');
    } catch (e) { toast(e.message, 'err'); }
  });
}

boot();
