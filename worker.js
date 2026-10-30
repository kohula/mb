// Optional lookup server for the Fly-Coop M&B sheet (Cloudflare Worker, free plan is enough).
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Hello World > paste this file > Deploy.
// Then paste the worker URL (e.g. https://mb-lookup.yourname.workers.dev/) into
// "Lookup settings > Own lookup server URL" in the app.
// Usage: GET /?type=metar|taf|notam&icao=LHBP   -> plain text, CORS enabled.
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' };
const UA = { 'user-agent': 'flycoop-mb-sheet/1.0' };
const decode = h => h.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
function parseNotams(html) {
  let blocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => decode(m[1].replace(/<[^>]+>/g,'')).trim()).filter(Boolean);
  if (!blocks.length) {
    const plain = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi,'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'')).replace(/\r/g,'');
    blocks = (plain.match(/^!?[A-Z]{4}\s+\d{2}\/\d{3}[\s\S]*?(?=^!?[A-Z]{4}\s+\d{2}\/\d{3}|$(?![\s\S]))/gm) || []).map(x => x.trim());
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n');
}
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const type = u.searchParams.get('type');
    const icao = (u.searchParams.get('icao') || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) return new Response('bad icao', { status: 400, headers: CORS });
    try {
      if (type === 'metar' || type === 'taf') {
        const r = await fetch(`https://aviationweather.gov/api/data/${type}?ids=${icao}&format=raw`, { headers: UA });
        return new Response((await r.text()).trim(), { status: r.ok ? 200 : 502, headers: CORS });
      }
      if (type === 'notam') {
        const r = await fetch(`https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=Raw&retrieveLocId=${icao}&actionType=notamRetrievalByICAOs&submit=View+NOTAMs`, { headers: UA });
        return new Response(parseNotams(await r.text()), { status: r.ok ? 200 : 502, headers: CORS });
      }
      return new Response('type must be metar, taf or notam', { status: 400, headers: CORS });
    } catch (e) {
      return new Response('upstream error', { status: 502, headers: CORS });
    }
  }
};
