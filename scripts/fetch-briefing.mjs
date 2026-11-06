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
  let list = null;
  for (const [name, fn] of [['FAA NOTAM Search', faaNotams], ['FAA DINS', dinsNotams]]) {
    try { list = await fn(icao); d.notamSource = name; break; } catch (e) { console.error(icao, name + ':', e.message); }
  }
  if (list) { d.notam = list.join('\n\n'); d.notamOk = true; d.notamUpdated = now; }
  else failures++;
  console.log(icao, `metar ${d.metar ? 'ok' : '-'}, taf ${d.taf ? 'ok' : '-'}, notams ${list ? list.length + ' via ' + d.notamSource : 'failed'}`);
  await writeFile(file, JSON.stringify(d, null, 1) + '\n');
}
if (failures === icaos.length * 2) process.exit(1);
