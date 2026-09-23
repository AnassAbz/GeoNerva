/**
 * The facts of the fixture world, shared by every mock read model: the earthquake, the fire
 * activity cluster and the flood event near Marrakech, and the evidence behind them.
 *
 *  - **EQ-26-7K3F9Q** — an M4.7 earthquake 142 km east of Marrakech. USGS reports Mww 4.7
 *    (reviewed, revised from mb 4.6), EMSC reports mb 4.6, and GDACS republishes the USGS
 *    solution. Agreement: minor differences, two independent sources out of three.
 *  - **FR-26-4HX2MB** — a fire activity cluster (VIIRS thermal detections) 39 km south-west.
 *  - **FL-26-9QW3TD** — a GDACS flood event (modelled area) in Souss-Massa, 171 km away.
 */

import type {
  Agreement,
  EvidenceItem,
  Fact,
  RelevanceAssessment,
  SubjectSummary,
} from '@geonerva/domain';

import { PRODUCT, RUN, hex64 } from './common.ts';

// ---------------------------------------------------------------------------------------------
// Evidence IDs.
// ---------------------------------------------------------------------------------------------

export const EV = {
  usgsV1: 'EV:OBS:90198',
  usgsV2: 'EV:OBS:90211',
  emscV1: 'EV:OBS:90204',
  gdacsEq: 'EV:OBS:90215',
  gdacsFlood: 'EV:OBS:88410',
  usgsOlder: 'EV:OBS:89877',
  corUsgs: 'EV:COR:5521',
  corEmsc: 'EV:COR:5522',
  corGdacs: 'EV:COR:5523',
  fcv1: 'EV:FCV:7740',
  fcv2: 'EV:FCV:7764',
  fcv3: 'EV:FCV:7781',
  fds3: 'EV:FDS:7781:14',
  relEq: `EV:REL:${hex64('rel-eq')}`,
  relFire: `EV:REL:${hex64('rel-fire')}`,
  relFlood: `EV:REL:${hex64('rel-flood')}`,
  basEq7: `EV:BAS:${hex64('bas-eq-7d')}`,
  basEq30: `EV:BAS:${hex64('bas-eq-30d')}`,
  basFire: `EV:BAS:${hex64('bas-fire-trend')}`,
  basFireCoverage: `EV:BAS:${hex64('bas-fire-trend-coverage')}`,
  basFlood: `EV:BAS:${hex64('bas-gdacs-floods')}`,
  basCyclone: `EV:BAS:${hex64('bas-gdacs-cyclones')}`,
  basOther: `EV:BAS:${hex64('bas-gdacs-other')}`,
  chgEqNew: `EV:CHG:${hex64('chg-eq-new')}`,
  chgFireGrew: `EV:CHG:${hex64('chg-fire-grew')}`,
  chgFloodUpdated: `EV:CHG:${hex64('chg-flood-updated')}`,
  chgEqSmall: `EV:CHG:${hex64('chg-eq-small')}`,
  chgEqFar: `EV:CHG:${hex64('chg-eq-far')}`,
  chgFireFlare: `EV:CHG:${hex64('chg-fire-flare')}`,
  chgFirmsStale: `EV:CHG:${hex64('chg-firms-stale')}`,
  chgEqOlder: `EV:CHG:${hex64('chg-eq-older')}`,
  runUsgs: `EV:RUN:${RUN.usgs}`,
  runEmsc: `EV:RUN:${RUN.emsc}`,
  runGdacs: `EV:RUN:${RUN.gdacs}`,
  runFirms: `EV:RUN:${RUN.firms}`,
  runFirmsFailed: `EV:RUN:${RUN.firmsFailed}`,
} as const;

// ---------------------------------------------------------------------------------------------
// Times.
// ---------------------------------------------------------------------------------------------

export const T = {
  eqObserved: '2026-09-22T11:47:12.000Z',
  emscIngested: '2026-09-22T11:55:31.000Z',
  usgsV1Ingested: '2026-09-22T11:58:40.000Z',
  gdacsEqIngested: '2026-09-22T12:20:10.000Z',
  usgsV2Ingested: '2026-09-22T12:41:05.000Z',
  usgsV2Updated: '2026-09-22T12:38:51.000Z',
  fireFirst: '2026-09-21T02:05:00.000Z',
  fireLast: '2026-09-22T02:14:00.000Z',
  fcv1: '2026-09-21T05:30:00.000Z',
  fcv2: '2026-09-21T14:10:00.000Z',
  fcv3: '2026-09-22T05:20:00.000Z',
  floodObserved: '2026-09-20T06:00:00.000Z',
  floodIngested: '2026-09-20T07:12:00.000Z',
  floodUpdated: '2026-09-22T06:40:00.000Z',
  olderEqObserved: '2026-09-17T21:08:44.000Z',
  olderEqIngested: '2026-09-17T21:26:02.000Z',
} as const;

export const EQ_PUBLIC_ID = 'EQ-26-7K3F9Q';
export const FIRE_PUBLIC_ID = 'FR-26-4HX2MB';
export const FLOOD_PUBLIC_ID = 'FL-26-9QW3TD';

// ---------------------------------------------------------------------------------------------
// The evidence registry: every item any fixture may cite.
// ---------------------------------------------------------------------------------------------

function derived(id: string, summary: string, ingestedAt: string): EvidenceItem {
  const kind = id.slice(3, 6) as EvidenceItem['kind'];
  return {
    id,
    kind,
    summary,
    sourceId: null,
    productId: null,
    observedAt: null,
    ingestedAt,
    url: null,
    resolvable: false,
  };
}

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb';
const EMSC_URL = 'https://www.seismicportal.eu/eventdetails.html?unid=20260922_0000187';
const GDACS_EQ_URL = 'https://www.gdacs.org/report.aspx?eventid=1498833&eventtype=EQ';
const GDACS_FL_URL = 'https://www.gdacs.org/report.aspx?eventid=1103921&eventtype=FL';

/** The registry, keyed by evidence id. `asOf` stamps the content-addressed derivations. */
export function evidenceRegistry(asOf: string): ReadonlyMap<string, EvidenceItem> {
  const items: EvidenceItem[] = [
    {
      id: EV.usgsV1,
      kind: 'OBS',
      summary: 'USGS ComCat version 1 of us7000tikb, mb 4.6 at 10 km depth.',
      sourceId: 'usgs',
      productId: PRODUCT.usgsComcat,
      observedAt: T.eqObserved,
      ingestedAt: T.usgsV1Ingested,
      url: USGS_URL,
      resolvable: true,
    },
    {
      id: EV.usgsV2,
      kind: 'OBS',
      summary: 'USGS ComCat version 2 of us7000tikb, Mww 4.7 at 10 km depth (reviewed).',
      sourceId: 'usgs',
      productId: PRODUCT.usgsComcat,
      observedAt: T.eqObserved,
      ingestedAt: T.usgsV2Ingested,
      url: USGS_URL,
      resolvable: true,
    },
    {
      id: EV.emscV1,
      kind: 'OBS',
      summary: 'EMSC version 1 of 20260922_0000187, mb 4.6 at 12 km depth.',
      sourceId: 'emsc',
      productId: PRODUCT.emscRts,
      observedAt: '2026-09-22T11:47:10.000Z',
      ingestedAt: T.emscIngested,
      url: EMSC_URL,
      resolvable: true,
    },
    {
      id: EV.gdacsEq,
      kind: 'OBS',
      summary: 'GDACS earthquake episode 1 of event 1498833, M4.7 (restates the USGS solution).',
      sourceId: 'gdacs',
      productId: PRODUCT.gdacsEq,
      observedAt: T.eqObserved,
      ingestedAt: T.gdacsEqIngested,
      url: GDACS_EQ_URL,
      resolvable: true,
    },
    {
      id: EV.gdacsFlood,
      kind: 'OBS',
      summary: 'GDACS flood episode 3 of event 1103921, Green alert, modelled area in Souss-Massa.',
      sourceId: 'gdacs',
      productId: PRODUCT.gdacsFl,
      observedAt: T.floodObserved,
      ingestedAt: T.floodUpdated,
      url: GDACS_FL_URL,
      resolvable: true,
    },
    {
      id: EV.usgsOlder,
      kind: 'OBS',
      summary: 'USGS ComCat version 1 of us7000tia2, mb 3.4 at 14 km depth.',
      sourceId: 'usgs',
      productId: PRODUCT.usgsComcat,
      observedAt: T.olderEqObserved,
      ingestedAt: T.olderEqIngested,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tia2',
      resolvable: true,
    },
    {
      id: EV.corUsgs,
      kind: 'COR',
      summary: 'USGS us7000tikb is the primary record of EQ-26-7K3F9Q.',
      sourceId: 'usgs',
      productId: PRODUCT.usgsComcat,
      observedAt: null,
      ingestedAt: T.usgsV1Ingested,
      url: null,
      resolvable: true,
    },
    {
      id: EV.corEmsc,
      kind: 'COR',
      summary:
        'EMSC 20260922_0000187 linked to EQ-26-7K3F9Q: 2 s apart, 6 km apart, magnitude 0.1 apart.',
      sourceId: 'emsc',
      productId: PRODUCT.emscRts,
      observedAt: null,
      ingestedAt: T.usgsV1Ingested,
      url: null,
      resolvable: true,
    },
    {
      id: EV.corGdacs,
      kind: 'COR',
      summary: 'GDACS event 1498833 linked to EQ-26-7K3F9Q by its USGS identity reference.',
      sourceId: 'gdacs',
      productId: PRODUCT.gdacsEq,
      observedAt: null,
      ingestedAt: T.gdacsEqIngested,
      url: null,
      resolvable: true,
    },
    {
      id: EV.fcv1,
      kind: 'FCV',
      summary: 'Fire activity cluster FR-26-4HX2MB, version 1: 6 detections from 1 overpass.',
      sourceId: 'firms',
      productId: null,
      observedAt: T.fireFirst,
      ingestedAt: T.fcv1,
      url: null,
      resolvable: true,
    },
    {
      id: EV.fcv2,
      kind: 'FCV',
      summary: 'Fire activity cluster FR-26-4HX2MB, version 2: 9 detections from 2 overpasses.',
      sourceId: 'firms',
      productId: null,
      observedAt: '2026-09-21T12:48:00.000Z',
      ingestedAt: T.fcv2,
      url: null,
      resolvable: true,
    },
    {
      id: EV.fcv3,
      kind: 'FCV',
      summary: 'Fire activity cluster FR-26-4HX2MB, version 3: 14 detections from 3 overpasses.',
      sourceId: 'firms',
      productId: null,
      observedAt: T.fireLast,
      ingestedAt: T.fcv3,
      url: null,
      resolvable: true,
    },
    {
      id: EV.fds3,
      kind: 'FDS',
      summary: 'The 14 VIIRS thermal detections behind cluster FR-26-4HX2MB, version 3.',
      sourceId: 'firms',
      productId: null,
      observedAt: T.fireLast,
      ingestedAt: T.fcv3,
      url: null,
      resolvable: false,
    },
    derived(
      EV.relEq,
      'Earthquake relevance for Marrakech: MODERATE (M4.7, 142 km, 10 km deep).',
      asOf,
    ),
    derived(
      EV.relFire,
      'Fire activity relevance for Marrakech: LOW (nearest detection 37 km).',
      asOf,
    ),
    derived(EV.relFlood, 'Flood relevance for Marrakech: LOW (modelled area 171 km away).', asOf),
    derived(EV.basEq7, 'Earthquake count baseline, 150 km, 7-day windows since 2021.', asOf),
    derived(EV.basEq30, 'Earthquake count baseline, 150 km, 30-day windows.', asOf),
    derived(EV.basFire, 'Fire activity trend, 100 km, 7 days against 28 days.', asOf),
    derived(EV.basFireCoverage, 'Fire activity trend, 100 km: satellite coverage gaps.', asOf),
    derived(EV.basFlood, 'GDACS flood-event context, 300 km, since 2021.', asOf),
    derived(EV.basCyclone, 'GDACS tropical-cyclone context, 300 km.', asOf),
    derived(EV.basOther, 'GDACS volcano and drought context, 300 km.', asOf),
    derived(EV.chgEqNew, 'Change: new M4.7 earthquake 142 km east.', asOf),
    derived(EV.chgFireGrew, 'Change: fire activity cluster grew from 9 to 14 detections.', asOf),
    derived(EV.chgFloodUpdated, 'Change: GDACS flood event updated (episode 3).', asOf),
    derived(EV.chgEqSmall, 'Change: new M2.8 earthquake 118 km south (below materiality).', asOf),
    derived(EV.chgEqFar, 'Change: new M3.9 earthquake 1,210 km north-east (low relevance).', asOf),
    derived(EV.chgFireFlare, 'Change: 1 thermal detection at a known industrial site.', asOf),
    derived(EV.chgFirmsStale, 'Change: NASA FIRMS became stale.', asOf),
    derived(EV.chgEqOlder, 'Change: new M3.4 earthquake 96 km south.', asOf),
    {
      id: EV.runUsgs,
      kind: 'RUN',
      summary: 'USGS scheduled poll, succeeded: 212 received, 1 new version.',
      sourceId: 'usgs',
      productId: PRODUCT.usgsComcat,
      observedAt: null,
      ingestedAt: '2026-09-22T13:02:00.000Z',
      url: null,
      resolvable: true,
    },
    {
      id: EV.runEmsc,
      kind: 'RUN',
      summary: 'EMSC scheduled poll, succeeded: 188 received, 0 new versions.',
      sourceId: 'emsc',
      productId: PRODUCT.emscRts,
      observedAt: null,
      ingestedAt: '2026-09-22T13:01:00.000Z',
      url: null,
      resolvable: true,
    },
    {
      id: EV.runGdacs,
      kind: 'RUN',
      summary: 'GDACS scheduled poll, succeeded: 64 received, 0 new versions.',
      sourceId: 'gdacs',
      productId: null,
      observedAt: null,
      ingestedAt: '2026-09-22T12:57:00.000Z',
      url: null,
      resolvable: true,
    },
    {
      id: EV.runFirms,
      kind: 'RUN',
      summary: 'NASA FIRMS scheduled poll, succeeded: 18,410 detections received.',
      sourceId: 'firms',
      productId: PRODUCT.firmsNoaa21,
      observedAt: null,
      ingestedAt: '2026-09-22T12:44:00.000Z',
      url: null,
      resolvable: true,
    },
    {
      id: EV.runFirmsFailed,
      kind: 'RUN',
      summary: 'NASA FIRMS scheduled poll, failed: HTTP 5xx from the provider.',
      sourceId: 'firms',
      productId: PRODUCT.firmsNoaa21,
      observedAt: null,
      ingestedAt: '2026-09-22T12:44:00.000Z',
      url: null,
      resolvable: true,
    },
  ];
  return new Map(items.map((item) => [item.id, item]));
}

// ---------------------------------------------------------------------------------------------
// Subjects as they appear in family cards.
// ---------------------------------------------------------------------------------------------

/*
 * The codes and labels below are `factsOf`'s, verbatim (packages/briefing/src/snapshot.ts).
 *
 * They used to be `'magnitude'`, `'magnitude_type'`, `'depth'` and `'alert_level'` — a vocabulary
 * no builder has ever emitted. The component suite is rendered against this file, so the whole of
 * it was green against a shape the API does not produce, and two HIGH findings of QA round 2
 * (H-1, H-2) were things the existing tests asserted were correct. `fixtures.test.ts` now parses
 * every fixture through the frozen schema **and** checks every code against the builders' own
 * lists, so the next divergence fails there instead of shipping.
 *
 * There is no magnitude-type fact and no magnitude-type comparison, because there is none in the
 * product. H-3's fix changed that: `snapshot.ts` now emits a `MAGNITUDE_TYPE` comparison, so this
 * file carries one again — with the numeric spread withheld, which is what the engine does when
 * the scales differ.
 */
const magnitude = (value: number, evidenceId: string): Fact => ({
  code: 'MAGNITUDE',
  label: 'Magnitude',
  value: { kind: 'number', value, unit: null, decimals: 1 },
  evidenceIds: [evidenceId],
});
const depth = (value: number, evidenceId: string): Fact => ({
  code: 'DEPTH',
  label: 'Depth',
  value: { kind: 'number', value, unit: 'km', decimals: 0 },
  evidenceIds: [evidenceId],
});
const observedAt = (value: string, evidenceId: string): Fact => ({
  code: 'OBSERVED_AT',
  label: 'Reported',
  value: { kind: 'timestamp', value },
  evidenceIds: [evidenceId],
});
const gdacsSeverity = (evidenceId: string): Fact => ({
  code: 'SEVERITY',
  label: 'Alert level',
  value: { kind: 'severity', severity: { scheme: 'GDACS_ALERT', value: 'Green' } },
  evidenceIds: [evidenceId],
});

export const EQ_FACTS = {
  usgs: [magnitude(4.7, EV.usgsV2), depth(10, EV.usgsV2), observedAt(T.eqObserved, EV.usgsV2)],
  emsc: [magnitude(4.6, EV.emscV1), depth(12, EV.emscV1), observedAt(T.eqObserved, EV.emscV1)],
  gdacs: [
    magnitude(4.7, EV.gdacsEq),
    depth(10, EV.gdacsEq),
    gdacsSeverity(EV.gdacsEq),
    observedAt(T.eqObserved, EV.gdacsEq),
  ],
} as const satisfies Record<string, readonly Fact[]>;

export const EQ_AGREEMENT: Agreement = {
  level: 'MINOR_DIFFERENCES',
  nSources: 3,
  nIndependentSources: 2,
  reasons: [
    {
      code: 'MAGNITUDE_WITHIN_TYPE_SPREAD',
      text: 'USGS (Mww 4.7) and EMSC (mb 4.6) differ by 0.1 in magnitude, which is usual between magnitude types.',
      params: { spread: 0.1, usgs: 4.7, emsc: 4.6 },
      evidenceIds: [EV.usgsV2, EV.emscV1],
    },
    {
      code: 'DERIVED_COPY_EXCLUDED',
      text: '2 independent sources (GDACS republishes USGS).',
      params: { nSources: 3, nIndependentSources: 2 },
      evidenceIds: [EV.corGdacs],
    },
  ],
  comparisons: [
    {
      code: 'MAGNITUDE',
      label: 'Magnitude',
      values: [
        {
          sourceId: 'usgs',
          contributor: 'us',
          value: { kind: 'number', value: 4.7, unit: null, decimals: 1 },
          evidenceId: EV.usgsV2,
        },
        {
          sourceId: 'emsc',
          contributor: 'EMSC',
          value: { kind: 'number', value: 4.6, unit: null, decimals: 1 },
          evidenceId: EV.emscV1,
        },
      ],
      /*
       * No spread, because the two values are not on one scale: USGS publishes `mww` and EMSC
       * publishes `mb` for this event, and `assessAgreement` withholds the difference between
       * different magnitude types rather than reporting it as a discrepancy (H-3). The mock used
       * to carry `0.1` here, which is what a reader saw described as near-agreement.
       */
      spread: null,
      isConflict: false,
    },
    {
      code: 'MAGNITUDE_TYPE',
      label: 'Magnitude type',
      values: [
        {
          sourceId: 'usgs',
          contributor: 'us',
          value: { kind: 'text', value: 'mww' },
          evidenceId: EV.usgsV2,
        },
        {
          sourceId: 'emsc',
          contributor: 'EMSC',
          value: { kind: 'text', value: 'mb' },
          evidenceId: EV.emscV1,
        },
      ],
      /* Two scales are not a dispute between the agencies; they measured different quantities. */
      spread: null,
      isConflict: false,
    },
    {
      code: 'DEPTH',
      label: 'Depth',
      values: [
        {
          sourceId: 'usgs',
          contributor: 'us',
          value: { kind: 'number', value: 10, unit: 'km', decimals: 0 },
          evidenceId: EV.usgsV2,
        },
        {
          sourceId: 'emsc',
          contributor: 'EMSC',
          value: { kind: 'number', value: 12, unit: 'km', decimals: 0 },
          evidenceId: EV.emscV1,
        },
      ],
      spread: { kind: 'number', value: 2, unit: 'km', decimals: 0 },
      isConflict: false,
    },
  ],
};

export const EQ_RELEVANCE: RelevanceAssessment = {
  level: 'MODERATE',
  reasons: [
    {
      code: 'EQ_DISTANCE_MAGNITUDE',
      text: 'An M4.7 earthquake 142 km away at 10 km depth falls in the moderate band of the earthquake distance–magnitude table.',
      params: { magnitude: 4.7, hypocentralDistanceKm: 142.6, depthKm: 10 },
      evidenceIds: [EV.usgsV2],
    },
    {
      code: 'EQ_TWO_SOURCES',
      text: 'Reported by 2 independent sources (USGS and EMSC).',
      params: { nIndependentSources: 2 },
      evidenceIds: [EV.corEmsc],
    },
    {
      code: 'NOT_CRITICAL_WITHOUT_AUTHORITY',
      text: 'An official alert would be needed to call this critical, and GeoNerva does not hold one.',
      params: {},
      evidenceIds: [],
    },
  ],
  authoritativeBasis: null,
  caveats: [],
  evidenceIds: [EV.relEq],
  modelVersion: 'rel-eq-1',
};

export const THERMAL_CAVEAT =
  'Satellite thermal detections can include non-vegetation heat sources (e.g. gas flares, industrial sites, volcanoes). They are not confirmed wildfires.';

export const FIRE_RELEVANCE: RelevanceAssessment = {
  level: 'LOW',
  reasons: [
    {
      code: 'FIRE_NEAREST_DETECTION',
      text: 'The nearest thermal detection is 37 km away, beyond the 10 km and 25 km bands.',
      params: { nearestDetectionKm: 37.2 },
      evidenceIds: [EV.fds3],
    },
    {
      code: 'FIRE_OVERPASSES',
      text: 'Seen on 2 satellite overpasses in the last 24 hours.',
      params: { distinctOverpasses24h: 2 },
      evidenceIds: [EV.fcv3],
    },
  ],
  authoritativeBasis: null,
  caveats: [THERMAL_CAVEAT],
  evidenceIds: [EV.relFire],
  modelVersion: 'rel-fire-1',
};

export const FLOOD_RELEVANCE: RelevanceAssessment = {
  level: 'LOW',
  reasons: [
    {
      code: 'FLOOD_AREA_DISTANCE',
      text: 'The GDACS flood-event area (modelled) lies 171 km from this location.',
      params: { distanceKm: 171.4 },
      evidenceIds: [EV.gdacsFlood],
    },
    {
      code: 'FLOOD_ALERT_GREEN',
      text: 'GDACS rates this flood event Green.',
      params: { alertLevel: 'Green' },
      evidenceIds: [EV.gdacsFlood],
    },
  ],
  authoritativeBasis: null,
  caveats: ['GDACS flood areas are modelled, not observed flood extents.'],
  evidenceIds: [EV.relFlood],
  modelVersion: 'rel-flood-1',
};

export const EQ_SUMMARY: SubjectSummary = {
  subjectRef: `CE:${EQ_PUBLIC_ID}`,
  hazardType: 'EARTHQUAKE',
  family: 'EARTHQUAKES',
  publicId: EQ_PUBLIC_ID,
  title: 'M4.7 · 49 km S of Azilal, Morocco',
  observedAt: T.eqObserved,
  lifecycleStatus: 'UPDATED',
  providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
  distanceKm: 142.3,
  hypocentralDistanceKm: 142.6,
  facts: EQ_FACTS.usgs,
  relevance: EQ_RELEVANCE,
  agreement: EQ_AGREEMENT,
  evidenceIds: [EV.usgsV2, EV.emscV1, EV.gdacsEq, EV.relEq],
  href: `/event/${EQ_PUBLIC_ID}`,
};

export const OLDER_EQ_SUMMARY: SubjectSummary = {
  subjectRef: 'CE:EQ-26-3MZ8QA',
  hazardType: 'EARTHQUAKE',
  family: 'EARTHQUAKES',
  publicId: 'EQ-26-3MZ8QA',
  title: 'M3.4 · 12 km NE of Taroudant, Morocco',
  observedAt: T.olderEqObserved,
  lifecycleStatus: 'ACTIVE',
  providerSeverity: null,
  distanceKm: 96.1,
  hypocentralDistanceKm: 97.1,
  facts: [
    magnitude(3.4, EV.usgsOlder),
    depth(14, EV.usgsOlder),
    observedAt(T.olderEqObserved, EV.usgsOlder),
  ],
  relevance: {
    level: 'LOW',
    reasons: [
      {
        code: 'EQ_DISTANCE_MAGNITUDE',
        text: 'An M3.4 earthquake 96 km away falls in the low band of the earthquake distance–magnitude table.',
        params: { magnitude: 3.4, hypocentralDistanceKm: 97.1 },
        evidenceIds: [EV.usgsOlder],
      },
    ],
    authoritativeBasis: null,
    caveats: [],
    evidenceIds: [EV.usgsOlder],
    modelVersion: 'rel-eq-1',
  },
  agreement: {
    level: 'SINGLE_SOURCE',
    nSources: 1,
    nIndependentSources: 1,
    reasons: [
      {
        code: 'SINGLE_SOURCE',
        text: 'Only USGS has reported this earthquake so far.',
        params: {},
        evidenceIds: [EV.usgsOlder],
      },
    ],
    comparisons: [],
  },
  evidenceIds: [EV.usgsOlder],
  href: '/event/EQ-26-3MZ8QA',
};

export const FIRE_SUMMARY: SubjectSummary = {
  subjectRef: `FC:${FIRE_PUBLIC_ID}`,
  hazardType: 'THERMAL_ACTIVITY',
  family: 'FIRE_ACTIVITY',
  publicId: FIRE_PUBLIC_ID,
  title: 'Fire activity cluster · 39 km SW of Marrakech',
  observedAt: T.fireLast,
  lifecycleStatus: 'ACTIVE',
  providerSeverity: null,
  distanceKm: 38.9,
  hypocentralDistanceKm: null,
  /* `buildFireSubject`'s five facts, in its order, with its codes and its labels. */
  facts: [
    {
      code: 'DETECTIONS_24H',
      label: 'Detections in the last 24 hours',
      value: { kind: 'count', value: 8 },
      evidenceIds: [EV.fcv3],
    },
    {
      code: 'DETECTIONS_TOTAL',
      label: 'Detections in total',
      value: { kind: 'count', value: 14 },
      evidenceIds: [EV.fcv3],
    },
    {
      code: 'OVERPASSES_24H',
      label: 'Satellite overpasses in the last 24 hours',
      value: { kind: 'count', value: 2 },
      evidenceIds: [EV.fcv3],
    },
    {
      code: 'FRP_SUM_24H',
      label: 'Fire radiative power, last 24 hours',
      value: { kind: 'number', value: 41.7, unit: 'MW', decimals: 0 },
      evidenceIds: [EV.fcv3],
    },
    {
      code: 'LAST_DETECTED_AT',
      label: 'Most recent detection',
      value: { kind: 'timestamp', value: T.fireLast },
      evidenceIds: [EV.fcv3],
    },
  ],
  relevance: FIRE_RELEVANCE,
  agreement: null,
  evidenceIds: [EV.fcv3, EV.fds3, EV.relFire],
  href: `/fire/${FIRE_PUBLIC_ID}`,
};

export const FLOOD_SUMMARY: SubjectSummary = {
  subjectRef: `CE:${FLOOD_PUBLIC_ID}`,
  hazardType: 'FLOOD',
  family: 'FLOODS',
  publicId: FLOOD_PUBLIC_ID,
  title: 'GDACS flood event · Souss-Massa, Morocco',
  observedAt: T.floodObserved,
  lifecycleStatus: 'UPDATED',
  providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
  distanceKm: 171.4,
  hypocentralDistanceKm: null,
  facts: [gdacsSeverity(EV.gdacsFlood), observedAt(T.floodObserved, EV.gdacsFlood)],
  relevance: FLOOD_RELEVANCE,
  agreement: {
    level: 'SINGLE_SOURCE',
    nSources: 1,
    nIndependentSources: 1,
    reasons: [
      {
        code: 'SINGLE_SOURCE',
        text: 'GDACS is the only source for flood events.',
        params: {},
        evidenceIds: [EV.gdacsFlood],
      },
    ],
    comparisons: [],
  },
  evidenceIds: [EV.gdacsFlood, EV.relFlood],
  href: `/event/${FLOOD_PUBLIC_ID}`,
};

/** The epicentre, the cluster centroid and the flood area, for the map and the detail pages. */
export const GEOMETRY = {
  eqEpicentre: { lat: 31.52, lon: -6.49 },
  fireCentroid: { lat: 31.4, lon: -8.3 },
  fireHull: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-8.318, 31.389],
        [-8.281, 31.386],
        [-8.276, 31.412],
        [-8.304, 31.418],
        [-8.318, 31.389],
      ],
    ],
  },
  floodArea: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-9.62, 30.18],
        [-8.71, 30.12],
        [-8.52, 30.55],
        [-9.05, 30.84],
        [-9.58, 30.66],
        [-9.62, 30.18],
      ],
    ],
  },
} as const;
