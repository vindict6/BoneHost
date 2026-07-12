import cron from 'node-cron';
import { cfg } from './config.js';
import { db, audit } from './db.js';
import { recreateServer } from './nodes.js';

/**
 * The update pass is delivered by container recreation: the CS2 image's
 * entrypoint validates/updates the game via steamcmd on boot, then (when
 * FORCE_ADDON_UPDATE=1) refreshes Metamod / CounterStrikeSharp / plugins to
 * the latest published builds. Subscribers choose whether addons ride along
 * with the scheduled game pass or get pushed independently.
 */

export async function latestVersions() {
  const out = { metamod: null, cssharp: null, checked_at: Date.now() };
  try {
    const r = await fetch(cfg.addons.metamod.latest_index, { signal: AbortSignal.timeout(8000) });
    if (r.ok) out.metamod = (await r.text()).trim(); // e.g. mmsource-2.0.0-git1350-linux.tar.gz
  } catch { /* surfaced as null in the UI */ }
  try {
    const r = await fetch(`https://api.github.com/repos/${cfg.addons.counterstrikesharp.repo}/releases/latest`, {
      headers: { 'User-Agent': 'BoneHost-panel' }, signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      out.cssharp = { tag: j.tag_name, published_at: j.published_at };
    }
  } catch { /* surfaced as null in the UI */ }
  return out;
}

/**
 * opts.metamod / opts.cssharp: refresh those addons during this pass.
 * opts.gameOnly implied when both are false — steamcmd validates CS2 only.
 */
export async function runUpdatePass(server, opts, actorId = null) {
  const extraEnv = [
    `FORCE_ADDON_UPDATE=${(opts.metamod || opts.cssharp) ? '1' : '0'}`,
    `ADDON_UPDATE_METAMOD=${opts.metamod ? '1' : '0'}`,
    `ADDON_UPDATE_CSSHARP=${opts.cssharp ? '1' : '0'}`,
  ];
  await recreateServer(server, extraEnv); // agent rebuilds the container; entrypoint updates on boot
  db.prepare(`UPDATE update_schedules SET last_run=? WHERE server_id=?`).run(Date.now(), server.id);
  audit(actorId, null, 'server.update_pass', server.id, { metamod: !!opts.metamod, cssharp: !!opts.cssharp });
}

export function startUpdateScheduler() {
  // Top of every hour, panel timezone from config.json.
  cron.schedule('0 * * * *', async () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: cfg.updates.scheduler_timezone }));
    const rows = db.prepare(`
      SELECT u.enabled, u.day_of_week, u.hour, u.include_metamod, u.include_cssharp, u.last_run, s.*
      FROM update_schedules u JOIN servers s ON s.id = u.server_id
      WHERE u.enabled=1 AND s.status IN ('running','stopped')
    `).all();
    for (const r of rows) {
      if (r.day_of_week !== now.getDay() || r.hour !== now.getHours()) continue;
      if (r.last_run && Date.now() - r.last_run < 50 * 60 * 1000) continue; // no double-fire
      try {
        await runUpdatePass(r, { metamod: !!r.include_metamod, cssharp: !!r.include_cssharp });
        console.log(`[updates] scheduled pass completed for ${r.id}`);
      } catch (e) {
        console.error(`[updates] pass failed for ${r.id}: ${e.message}`);
      }
    }
  }, { timezone: cfg.updates.scheduler_timezone });
}
