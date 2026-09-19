// GDACS fixtures (TESTING.md §3) + V2 evidence.
//
// Usage: node scripts/capture-fixtures/capture-gdacs.mjs main
//
// Event/episode IDs were chosen on 2026-09-19 from live data and are pinned for reproducibility.

import { captureUrl, politeFetch, saveFixture } from './lib.mjs';

const SOURCE = 'gdacs';
const G = 'https://www.gdacs.org/gdacsapi/api';

const EQ_NEIC = 1567022; // Reykjanes Ridge M5.2, source NEIC
const EQ_PRICO = 1566821; // Puerto Rico M4.8, source PRICO RS, sourceid pr2026261000 (USGS ids ,pt26261050,us7000tiar,pr2026261000,)
const FL_POLY = 1104173; // Honduras flood, ep 1: Point_Centroid + Poly_Affected + Poly_Global (57 KB)
const TC = [1001323, 2]; // SIX-26 ep 2: tracks, per-time buffers, cones (~220 KB)
const TC_EPISODES = [1001305, 20, 21]; // SAUDEL-26: episode 20 Green -> episode 21 Orange
const WF = [1032243, 1];
const VO = [1000148, 1]; // Krakatau, Orange
const FL_SCAN_LIMIT = 15; // how many FL events to scan for a centroid-only geometry

/** Keep the RSS channel header and up to `perType` items per gdacs:eventtype, byte-exact. */
function trimRss(xml, perType) {
  const firstItem = xml.indexOf('<item>');
  const lastItemEnd = xml.lastIndexOf('</item>') + '</item>'.length;
  const head = xml.slice(0, firstItem);
  const tail = xml.slice(lastItemEnd);
  const items = [];
  const re = /<item>[\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml))) items.push(m[0]);
  // Separator between consecutive items as it appears in the original.
  const secondStart = xml.indexOf('<item>', firstItem + 1);
  const firstEnd = xml.indexOf('</item>', firstItem) + '</item>'.length;
  const sep = secondStart > 0 ? xml.slice(firstEnd, secondStart) : '';
  const counts = {};
  const kept = items.filter((it) => {
    const t = /<gdacs:eventtype>([^<]*)<\/gdacs:eventtype>/.exec(it)?.[1] ?? '?';
    counts[t] = (counts[t] ?? 0) + 1;
    return counts[t] <= perType;
  });
  return { text: head + kept.join(sep) + tail, kept: kept.length, total: items.length, counts };
}

async function main() {
  console.log('GDACS main');
  // RSS (full feed is ~1.2 MB -> trimmed per hazard type).
  const rss = await politeFetch('https://www.gdacs.org/xml/rss.xml');
  const t = trimRss(rss.body.toString('utf8'), 8);
  await saveFixture(SOURCE, 'rss.xml', t.text, {
    url: 'https://www.gdacs.org/xml/rss.xml',
    http_status: rss.status,
    content_type: rss.contentType,
    notes: `TRIMMED: channel header + first 8 <item>s per gdacs:eventtype (${t.kept}/${t.total} items; type counts in full feed ${JSON.stringify(t.counts)}). Items are byte-exact. Full feed was ${rss.body.length} bytes.`,
  });

  await captureUrl(
    SOURCE,
    'geteventdata-eq-neic.json',
    `${G}/events/geteventdata?eventtype=EQ&eventid=${EQ_NEIC}`,
    {
      notes:
        'EQ event data with properties.sourceid = USGS id (source NEIC). sourceid is empty in list/RSS.',
    },
  );
  await captureUrl(
    SOURCE,
    'geteventdata-eq-prico.json',
    `${G}/events/geteventdata?eventtype=EQ&eventid=${EQ_PRICO}`,
    {
      notes:
        'EQ from source "PRICO RS" whose sourceid pr2026261000 is the current USGS preferred id; USGS ids also contain us7000tiar and pt26261050 (see usgs/fdsn-eventid-by-alias.geojson).',
    },
  );

  await captureUrl(
    SOURCE,
    'getgeometry-fl-affected-global.json',
    `${G}/polygons/getgeometry?eventtype=FL&eventid=${FL_POLY}&episodeid=1`,
    {
      notes:
        'Flood geometry: Point_Centroid + Poly_Affected ("Affected area") + Poly_Global ("Global area").',
    },
  );

  // Find a centroid-only flood (no Poly_Affected). Scan the current FL list.
  const list = await politeFetch(
    `${G}/events/geteventlist/SEARCH?eventlist=FL&alertlevel=green;orange;red&fromDate=2026-06-01&toDate=2026-09-19&pageSize=100&pageNumber=1`,
  );
  const fl = JSON.parse(list.body.toString('utf8')).features;
  let found = null;
  let scanned = 0;
  for (const f of fl.slice(0, FL_SCAN_LIMIT * 3)) {
    if (scanned >= FL_SCAN_LIMIT) break;
    const { eventid, episodeid } = f.properties;
    if (eventid === FL_POLY) continue;
    scanned++;
    const url = `${G}/polygons/getgeometry?eventtype=FL&eventid=${eventid}&episodeid=${episodeid}`;
    const r = await politeFetch(url);
    if (r.status !== 200 || r.body.length > 400_000) continue;
    const classes = JSON.parse(r.body.toString('utf8')).features.map((x) => x.properties.Class);
    if (!classes.includes('Poly_Affected')) {
      found = { r, url, classes };
      break;
    }
  }
  if (found) {
    await saveFixture(SOURCE, 'getgeometry-fl-centroid-only.json', found.r.body, {
      url: found.url,
      http_status: found.r.status,
      content_type: found.r.contentType,
      notes: `Real flood geometry without Poly_Affected (classes: ${found.classes.join(',')}).`,
    });
  } else {
    console.log(
      `  no centroid-only flood among ${scanned} scanned; derive-drift.mjs creates a synthetic one`,
    );
  }

  await captureUrl(
    SOURCE,
    'getgeometry-tc.json',
    `${G}/polygons/getgeometry?eventtype=TC&eventid=${TC[0]}&episodeid=${TC[1]}`,
    {
      notes:
        'Tropical cyclone geometry: centroid, advisory position polygons, Poly_Green/Orange/Red per forecast time + cumulative, track LineStrings (TD/TS/HU), Poly_Cones.',
    },
  );
  await captureUrl(
    SOURCE,
    'geteventdata-tc.json',
    `${G}/events/geteventdata?eventtype=TC&eventid=${TC[0]}`,
    { notes: 'TC event data (same event as getgeometry-tc.json).' },
  );
  for (const ep of TC_EPISODES.slice(1)) {
    await captureUrl(
      SOURCE,
      `getepisodedata-tc-ep${ep}.json`,
      `${G}/events/getepisodedata?eventtype=TC&eventid=${TC_EPISODES[0]}&episodeid=${ep}`,
      {
        notes: `SAUDEL-26 episode ${ep}. Episode 20 episodealertlevel Green, episode 21 Orange (Green->Orange change). NB: datemodified/severitydata are identical across episodes in getepisodedata — only episode fields vary.`,
      },
    );
  }
  await captureUrl(
    SOURCE,
    'getgeometry-wf.json',
    `${G}/polygons/getgeometry?eventtype=WF&eventid=${WF[0]}&episodeid=${WF[1]}`,
    { notes: 'Wildfire (GWIS) geometry: centroid + Poly_area.' },
  );
  await captureUrl(
    SOURCE,
    'geteventdata-wf.json',
    `${G}/events/geteventdata?eventtype=WF&eventid=${WF[0]}`,
    { notes: 'Wildfire event data.' },
  );
  await captureUrl(
    SOURCE,
    'getgeometry-vo.json',
    `${G}/polygons/getgeometry?eventtype=VO&eventid=${VO[0]}&episodeid=${VO[1]}`,
    { notes: 'Volcano geometry: centroid, 30 km circle, ash cones OBS/FCST.' },
  );
  await captureUrl(
    SOURCE,
    'geteventdata-vo.json',
    `${G}/events/geteventdata?eventtype=VO&eventid=${VO[0]}`,
    { notes: 'Volcano event data (Orange).' },
  );

  await captureUrl(
    SOURCE,
    'geteventlist-search-eq.json',
    `${G}/events/geteventlist/SEARCH?eventlist=EQ&alertlevel=green;orange;red&fromDate=2026-09-18&toDate=2026-09-19&pageSize=100&pageNumber=1`,
    {
      notes: 'SEARCH list, fixed 2-day window. sourceid is empty in list items.',
    },
  );
  await captureUrl(
    SOURCE,
    'geteventlist-search-eq-no-alertlevel.txt',
    `${G}/events/geteventlist/SEARCH?eventlist=EQ&fromDate=2026-09-18&toDate=2026-09-19&pageSize=100&pageNumber=1`,
    {
      notes:
        'EQ SEARCH without alertlevel — previously observed to return HTTP 204 (empty but suspicious).',
    },
  );
  await captureUrl(
    SOURCE,
    'swagger.json',
    'https://www.gdacs.org/gdacsapi/swagger/v1/swagger.json',
    { notes: 'API description, for schema pinning.' },
  );
  await v2();
}

// V2 evidence: `latest` with and without alertlevel, paging.
async function v2() {
  const since = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 19);
  const all = 'eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=green;orange;red&pageSize=100';
  await captureUrl(
    SOURCE,
    'geteventlist-latest-no-alertlevel.json',
    `${G}/events/geteventlist/latest?datemodified=${since}`,
    {
      notes:
        'V2: latest?datemodified=now-6h WITHOUT eventlist/alertlevel: only a handful of events (Green events are excluded by default, like the SEARCH 204 case).',
    },
  );
  await captureUrl(
    SOURCE,
    'geteventlist-latest-p1.json',
    `${G}/events/geteventlist/latest?${all}&datemodified=${since}&pageNumber=1`,
    {
      notes:
        'V2: latest with all event types + alertlevel=green;orange;red, datemodified=now-6h, page 1 (max 100, ordered by todate desc per swagger).',
    },
  );
  await captureUrl(
    SOURCE,
    'geteventlist-latest-p2.json',
    `${G}/events/geteventlist/latest?${all}&datemodified=${since}&pageNumber=2`,
    {
      notes: 'V2: page 2 of the same query (404 when past the last page).',
    },
  );
}

const cmd = process.argv[2];
if (cmd === 'main') await main();
else if (cmd === 'v2') await v2();
else {
  console.error('usage: capture-gdacs.mjs main | v2');
  process.exit(2);
}
