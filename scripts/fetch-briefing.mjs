// Fetches METAR, TAF and NOTAMs for the airfields in config.json and writes data/ICAO.json.
// Run by .github/workflows/briefing.yml every 30 minutes; the page reads these files, so no
// browser ever has to call the (CORS-blocked) official services. Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('config.json', 'utf8'));
const icaos = [...new Set([cfg.home, cfg.wxIcao, ...(cfg.lookupIcaos || [])]
  .filter(Boolean).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9]{4}$/.test(s)))];
const UA = { 'user-agent': 'mb-sheet-briefing/1.0 (+GitHub Actions)' };

async function get(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.text();
}
const decode = h => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// autorouter.aero (European NOTAMs from EAD). Needs a free autorouter account; its e-mail and password
// are read from the AUTOROUTER_USER and AUTOROUTER_PASS repository secrets.
let arToken = null;
async function autorouterNotams(icao) {
  const user = process.env.AUTOROUTER_USER, pass = process.env.AUTOROUTER_PASS;
  if (!user || !pass) throw new Error('AUTOROUTER_USER / AUTOROUTER_PASS secrets not set');
  if (!arToken) {
    const t = JSON.parse(await get('https://api.autorouter.aero/v1.0/oauth2/token', { method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: user, client_secret: pass }) }));
    if (!t.access_token) throw new Error('autorouter login failed');
    arToken = t.access_token;
  }
  const rows = [];
  for (let offset = 0, page = 0; page < 10; page++) {
    const q = new URLSearchParams({ itemas: JSON.stringify([icao]), offset: String(offset), limit: '100' });
    const j = JSON.parse(await get('https://api.autorouter.aero/v1.0/notam?' + q, { headers: { authorization: 'Bearer ' + arToken } }));
    const list = Array.isArray(j) ? j : (j.rows || []);
    rows.push(...list); offset += list.length;
    if (!list.length || Array.isArray(j) || offset >= (j.total || 0)) break;
  }
  const now = Date.now() / 1000;
  return rows.filter(n => !n.endvalidity || n.endvalidity > now).map(formatNotam).filter(Boolean);
}
const ymd = s => { const d = new Date(s * 1000); const p = n => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()); };
function formatNotam(n) {
  if (!n || typeof n !== 'object') return String(n || '');
  if (!n.iteme) return String(n.raw || n.text || n.message || '').trim();
  const id = n.series != null && n.number != null ? `${n.series}${String(n.number).padStart(4, '0')}/${String(n.year ?? '').slice(-2)} NOTAM${n.type || 'N'}` : '';
  const a = Array.isArray(n.itema) ? n.itema.join(' ') : (n.itema || '');
  const b = n.startvalidity ? ymd(n.startvalidity) : '';
  const c = n.endvalidity ? ymd(n.endvalidity) + (n.estimation ? ' EST' : '') : 'PERM';
  return [id, `A) ${a} B) ${b} C) ${c}`, n.itemd ? `D) ${n.itemd}` : '', `E) ${n.iteme}`,
    n.itemf || n.itemg ? `F) ${n.itemf || ''} G) ${n.itemg || ''}` : ''].filter(Boolean).join('\n');
}

// FAA NOTAM Search (international NOTAMs in ICAO format, with Q) line and validity)
async function faaNotams(icao) {
  const out = [];
  for (let offset = 0, page = 0; page < 20; page++) {
    const body = new URLSearchParams({ searchType: '0', designatorsForLocation: icao, offset: String(offset),
      notamsOnly: 'false', radius: '10', sortColumns: '5 false', sortDirection: 'true' });
    const j = JSON.parse(await get('https://notams.aim.faa.gov/notamSearch/search', { method: 'POST', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    if (j.error) throw new Error('FAA: ' + j.error);
    const list = j.notamList || [];
    out.push(...list.map(n => String(n.icaoMessage || n.traditionalMessageFrom4thWord || n.traditionalMessage || '').trim()));
    offset += list.length;
    if (!list.length || offset >= (j.totalNotamCount || 0)) break;
  }
  return out.filter(Boolean);
}
// older FAA DINS page, used when NOTAM Search does not answer
async function dinsNotams(icao) {
  const html = await get(`https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=Raw&retrieveLocId=${icao}&actionType=notamRetrievalByICAOs&submit=View+NOTAMs`);
  if (!/dinsQueryWeb|NOTAM/i.test(html)) throw new Error('DINS: unexpected answer');
  return [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => decode(m[1].replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
}

// runways with true headings from OurAirports, same shape the page uses: { ends: [{ n, hdg }], ids: ['09/27'] }
const csvLine = l => { const f = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; } else cur += c; }
  f.push(cur.replace(/\r$/, '')); return f; };
let oaCsv = null;
async function runways(icao) {
  oaCsv ??= await get('https://davidmegginson.github.io/ourairports-data/runways.csv');
  const ends = [], ids = [];
  for (const line of oaCsv.split('\n')) {
    if (!line.includes(`,"${icao}",`)) continue;
    const f = csvLine(line); if (f[2] !== icao || f[7] === '1') continue;
    const pair = [];
    for (const [id, h] of [[f[8], f[12]], [f[14], f[18]]]) {
      const n = String(id || '').trim().toUpperCase(); if (!/^\d{1,2}[LRC]?$/.test(n)) continue;
      const hdg = h !== '' && isFinite(+h) ? +h : parseInt(n, 10) * 10;
      pair.push(n); ends.push({ n, hdg: Math.round(hdg) % 360 });
    }
    if (pair.length) ids.push(pair.join('/'));
  }
  return { ends, ids };
}

await mkdir('data', { recursive: true });
let failures = 0;
for (const icao of icaos) {
  const file = `data/${icao}.json`;
  let prev = {};
  try { prev = JSON.parse(await readFile(file, 'utf8')); } catch {}
  const now = new Date().toISOString();
  const d = { ...prev, icao };
  try {
    const [m, t] = await Promise.all([
      get(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw`),
      get(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw`)]);
    d.metar = m.trim(); d.taf = t.trim().replace(/[ \t]*\n[ \t]*/g, '\n'); d.wxUpdated = now;
  } catch (e) { failures++; console.error(icao, 'weather:', e.message); }
  try { d.runways = await runways(icao); } catch (e) { console.error(icao, 'runways:', e.message); }
  let list = null;
  for (const [name, fn] of [['autorouter.aero', autorouterNotams], ['FAA NOTAM Search', faaNotams], ['FAA DINS', dinsNotams]]) {
    try { list = await fn(icao); d.notamSource = name; break; } catch (e) { console.error(icao, name + ':', e.message); }
  }
  if (list) { d.notam = list.join('\n\n'); d.notamOk = true; d.notamUpdated = now; }
  else failures++;
  console.log(icao, `runways ${d.runways ? d.runways.ids.join(' ') || 'none' : '-'}, metar ${d.metar ? 'ok' : '-'}, taf ${d.taf ? 'ok' : '-'}, notams ${list ? list.length + ' via ' + d.notamSource : 'failed'}`);
  await writeFile(file, JSON.stringify(d, null, 1) + '\n');
}
if (failures === icaos.length * 2) process.exit(1);
