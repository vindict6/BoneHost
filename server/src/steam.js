import { env } from './config.js';

/**
 * Accepts any of:
 *   76561198012345678
 *   https://steamcommunity.com/profiles/76561198012345678
 *   https://steamcommunity.com/id/somevanityname
 *   somevanityname            (falls back to vanity resolution)
 * Returns { steamid64, persona } or throws with a human-readable message.
 */
export async function resolveSteamId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a Steam profile link or SteamID64.');

  const idMatch = raw.match(/(?:^|\/profiles\/)(7656119\d{10})\/?$/);
  if (idMatch) return finish(idMatch[1]);

  const vanityMatch = raw.match(/\/id\/([A-Za-z0-9_-]+)\/?/) || raw.match(/^([A-Za-z0-9_-]{2,32})$/);
  if (!vanityMatch) throw new Error('That does not look like a Steam profile link or SteamID64.');

  if (!env.steamApiKey) {
    throw new Error('Vanity URLs need the STEAM_API_KEY set on the panel. Paste the SteamID64 or the /profiles/ link instead.');
  }
  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${env.steamApiKey}&vanityurl=${encodeURIComponent(vanityMatch[1])}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Steam API is unreachable right now. Try the SteamID64 directly.');
  const j = await r.json();
  if (j.response?.success !== 1) throw new Error('Steam could not find that vanity URL.');
  return finish(j.response.steamid);

  async function finish(steamid64) {
    let persona = '';
    if (env.steamApiKey) {
      try {
        const r2 = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.steamApiKey}&steamids=${steamid64}`);
        const j2 = await r2.json();
        persona = j2.response?.players?.[0]?.personaname || '';
      } catch { /* cosmetic only */ }
    }
    return { steamid64, persona };
  }
}
