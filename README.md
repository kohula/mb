# M&B sheet

Mass and balance + navlog + briefing sheet generator (C172 / C152). Fill in the form, then press **Print / save as PDF** (A4 landscape, 2 pages). Hosted with GitHub Pages: `index.html` is the whole app.

## Settings

The **Settings** tab holds everything that is not about one flight, saved in the browser:

- **Personal**: your weight, average passenger weight, bags per person (lbs or kg). Used when "1 person" or "2 people" is selected; "Manual" lets you type every station yourself.
- **Fuel**: round lengths and fuel per round (add your own), reserve rounds, fuel burn and final reserve for the endurance line.
- **Club and airfield**: club name printed on the sheets, home airfield, weather station, runways (for the crosswind check), max crosswind, navlog frequencies, logo.
- **Fleet**: aircraft call signs, basic empty weight, arm and moment.
- **Share or reset**: export / import the settings as a file.

### Using it for your own club

1. Fork or copy this repository and turn on GitHub Pages (Settings > Pages > Deploy from branch > `main`).
2. Open the site, set everything up in the Settings tab, press **Export settings** and commit the downloaded file as `config.json` (replacing this one). Everyone who opens your site then starts from your club's setup; their own Settings changes stay in their browser.
3. Add every airfield you want NOTAMs for to `lookupIcaos` in `config.json`.

## NOTAM, METAR and TAF

Browsers are not allowed to call the official NOTAM and weather services directly, so:

- **`.github/workflows/briefing.yml`** runs every 30 minutes and fetches METAR and TAF (aviationweather.gov); NOTAMs are fetched once a day (`notamRefreshHours` in `config.json`, default 24) or whenever you press **Run workflow**. It covers `home`, `wxIcao` and `lookupIcaos` from `config.json` and commits the results to `data/ICAO.json`. The page reads those files first. In a fork, open the **Actions** tab and enable workflows once; you can run it by hand with **Run workflow**.
- **NOTAMs need a free [autorouter.aero](https://www.autorouter.aero) account** (European NOTAMs). Register, then in the repository go to Settings > Secrets and variables > Actions and add two repository secrets: `AUTOROUTER_USER` (the account e-mail) and `AUTOROUTER_PASS` (its password). The FAA services are tried as a fallback but block GitHub's servers.
- METAR and TAF also come live from public CORS-enabled sources (metar.vatsim.net, datamask.org, metars.eu).
- `worker.js` is an optional Cloudflare Worker for your own lookup server (see the comments at the top); put its URL in Settings > NOTAM and weather lookup.

Always check NOTAMs against official AIS before flight.
