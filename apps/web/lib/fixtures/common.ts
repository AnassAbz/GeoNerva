/**
 * Shared building blocks for the P9a mock read models.
 *
 * These fixtures stand in for the P8 service layer until P9b wires the pages to it. They are
 * **not** a second implementation of the briefing: every value here is written by hand to look
 * like what `packages/briefing` produces, and `fixtures.test.ts` validates every one of them
 * against the frozen runtime schemas in `@geonerva/domain`, so a mock cannot drift from the
 * contract without a failing test.
 *
 * The world they describe is Marrakech on 22 September 2026 at 13:06 UTC.
 */

import {
  READ_MODEL_SCHEMA_VERSION,
  citedEvidenceIds,
  type AsOfContext,
  type Attribution,
  type EvidenceItem,
  type FreshnessPolicyView,
  type LocationRef,
  type ReplayHorizon,
  type SourceHealthView,
} from '@geonerva/domain';

/** Re-exported so that no fixture ever writes the version literally (ADR-038 bumps it). */
export const SCHEMA_VERSION = READ_MODEL_SCHEMA_VERSION;

/** The fixture clock. */
export const FIXTURE_NOW = '2026-09-22T13:06:00.000Z';

export const MARRAKECH_SLUG = 'marrakech-ma-2542997';

export const MARRAKECH: LocationRef = {
  key: 'p:2542997',
  label: 'Marrakech, Morocco',
  lat: 31.63,
  lon: -7.99,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakesh-Safi',
};

/** `iso` minus a number of minutes, in the contract's millisecond ISO form. */
export function minutesBefore(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

/**
 * A deterministic 64-character lowercase hex string for content-addressed evidence IDs. Not a
 * hash of anything — the fixtures only need IDs of the right shape that are stable across runs.
 */
export function hex64(seed: string): string {
  let out = '';
  let state = 2166136261;
  for (let round = 0; out.length < 64; round += 1) {
    for (const char of `${seed}:${String(round)}`) {
      state ^= char.charCodeAt(0);
      state = Math.imul(state, 16777619) >>> 0;
    }
    out += state.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

// ---------------------------------------------------------------------------------------------
// Sources: attribution and freshness policies, as seeded by migration 0008.
// ---------------------------------------------------------------------------------------------

export const POLICY = {
  usgs: {
    pollIntervalS: 300,
    fetchFreshWithinS: 1200,
    fetchStaleAfterS: 3600,
    unavailableAfterS: 86400,
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  emsc: {
    pollIntervalS: 300,
    fetchFreshWithinS: 1200,
    fetchStaleAfterS: 3600,
    unavailableAfterS: 86400,
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  gdacs: {
    pollIntervalS: 600,
    fetchFreshWithinS: 2400,
    fetchStaleAfterS: 7200,
    unavailableAfterS: 86400,
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  firms: {
    pollIntervalS: 1800,
    fetchFreshWithinS: 5400,
    fetchStaleAfterS: 10800,
    unavailableAfterS: 86400,
    dataCurrentWithinS: 21600,
    dataStaleAfterS: 43200,
    quietIsNormal: false,
  },
  eccc: {
    pollIntervalS: 300,
    fetchFreshWithinS: 1200,
    fetchStaleAfterS: 3600,
    unavailableAfterS: 86400,
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
} as const satisfies Record<string, FreshnessPolicyView>;

export type FixtureSourceId = keyof typeof POLICY;

/** Product ids in seeding order (migration 0008). */
export const PRODUCT = {
  usgsComcat: 1,
  emscRts: 2,
  gdacsEq: 3,
  gdacsFl: 4,
  gdacsTc: 5,
  gdacsWf: 6,
  gdacsVo: 7,
  gdacsDr: 8,
  firmsNoaa20: 9,
  firmsNoaa21: 10,
  ecccAlerts: 11,
} as const;

export const ATTRIBUTION: Readonly<Record<FixtureSourceId, Attribution>> = {
  usgs: {
    sourceId: 'usgs',
    name: 'U.S. Geological Survey — Earthquake Hazards Program',
    homepage: 'https://earthquake.usgs.gov/',
    licence: 'U.S. Public Domain',
    attributionText:
      'U.S. Geological Survey, Earthquake Hazards Program, ANSS Comprehensive Catalog (ComCat), doi:10.5066/F7MS3QZH',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    disclaimer:
      'Contributed (non-USGS network) content may be copyrighted; contributing networks are named in the evidence.',
  },
  emsc: {
    sourceId: 'emsc',
    name: 'European-Mediterranean Seismological Centre (EMSC/CSEM)',
    homepage: 'https://www.emsc-csem.org',
    licence: 'CC BY 4.0',
    attributionText: 'Credit: EMSC/CSEM, https://www.emsc-csem.org',
    termsUrl: 'https://www.emsc-csem.org/Menu/disclaimer.php',
    disclaimer: 'No warranty. Consult national authorities for decisions that matter.',
  },
  gdacs: {
    sourceId: 'gdacs',
    name: 'Global Disaster Alert and Coordination System (GDACS)',
    homepage: 'https://www.gdacs.org',
    licence: 'CC BY 4.0 (European Union)',
    attributionText: 'GDACS, European Union (CC BY 4.0)',
    termsUrl: 'https://www.gdacs.org/About/termofuse.aspx',
    disclaimer:
      'GDACS alerts are impact estimates provided "as is", with no guarantee of completeness or timeliness, and should not be used for decision making without prior confirmation. They are not a substitute for national authorities.',
  },
  firms: {
    sourceId: 'firms',
    name: 'NASA FIRMS — Fire Information for Resource Management System',
    homepage: 'https://firms.modaps.eosdis.nasa.gov/',
    licence: 'NASA open data',
    attributionText:
      "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS).",
    termsUrl:
      'https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-and-information-policy',
    disclaimer:
      'Thermal detections are satellite observations of heat, provided "as is". They can include gas flares, industrial sites and volcanoes, and they are not confirmed wildfires.',
  },
  eccc: {
    sourceId: 'eccc',
    name: 'Environment and Climate Change Canada — Meteorological Service of Canada',
    homepage: 'https://eccc-msc.github.io/open-data/',
    licence: 'ECCC Data Servers End-use Licence v2.1.1',
    attributionText: 'Data Source: Environment and Climate Change Canada',
    termsUrl: 'https://eccc-msc.github.io/open-data/licence/readme_en/',
    disclaimer:
      'Alerts must be reproduced without alteration of their content or intent. ECCC is not the only Canadian alerting authority; this covers ECCC weather alerts only.',
  },
};

export function attributionFor(...sources: FixtureSourceId[]): readonly Attribution[] {
  return sources.map((source) => ATTRIBUTION[source]);
}

// ---------------------------------------------------------------------------------------------
// Runs and health.
// ---------------------------------------------------------------------------------------------

/** Ingestion-run ids used as health evidence. Lowercase UUIDs, as the evidence grammar demands. */
export const RUN = {
  usgs: '0b6f1c52-3d1e-4f7a-9a41-5c2d7e8f9a01',
  emsc: '1c7a2d63-4e2f-4a8b-8b52-6d3e8f9a0b12',
  gdacs: '2d8b3e74-5f3a-4b9c-9c63-7e4f9a0b1c23',
  firms: '3e9c4f85-6a4b-4cad-8d74-8f5a0b1c2d34',
  firmsFailed: '4fad5096-7b5c-4dbe-9e85-9a6b1c2d3e45',
  eccc: '5abe61a7-8c6d-4ecf-8f96-ab7c2d3e4f56',
} as const;

export interface HealthOptions {
  readonly sourceId: FixtureSourceId;
  readonly productId?: number | null;
  readonly status: SourceHealthView['status'];
  readonly reasons: SourceHealthView['reasons'];
  readonly asOf: string;
  /** Minutes before `asOf`, or `null` for never. */
  readonly lastSuccessMinutesAgo: number | null;
  readonly lastAttemptMinutesAgo?: number | null;
  readonly newestObservedMinutesAgo: number | null;
  readonly consecutiveFailures?: number;
  readonly lastErrorClass?: SourceHealthView['lastErrorClass'];
  readonly runId: string | null;
}

export function health(options: HealthOptions): SourceHealthView {
  const at = (minutes: number | null | undefined): string | null =>
    minutes === null || minutes === undefined ? null : minutesBefore(options.asOf, minutes);
  return {
    sourceId: options.sourceId,
    productId: options.productId ?? null,
    status: options.status,
    lastAttemptAt: at(options.lastAttemptMinutesAgo ?? options.lastSuccessMinutesAgo),
    lastSuccessAt: at(options.lastSuccessMinutesAgo),
    newestObservedAt: at(options.newestObservedMinutesAgo),
    consecutiveFailures: options.consecutiveFailures ?? 0,
    lastErrorClass: options.lastErrorClass ?? null,
    reasons: options.reasons,
    expected: POLICY[options.sourceId],
    evidenceId: options.runId === null ? null : `EV:RUN:${options.runId}`,
  };
}

// ---------------------------------------------------------------------------------------------
// As-of context.
// ---------------------------------------------------------------------------------------------

export function replayHorizon(asOf: string): ReplayHorizon {
  const thirtyDays = minutesBefore(asOf, 30 * 24 * 60);
  const ninetyDays = minutesBefore(asOf, 90 * 24 * 60);
  const note30 =
    'The lean retention profile keeps 30 days of revisions for this family; replay cannot go further back.';
  const note90 =
    'The lean retention profile keeps 90 days of revisions for this family; replay cannot go further back.';
  return {
    profile: 'lean',
    byFamily: {
      EARTHQUAKES: { earliestAsOf: thirtyDays, note: note30 },
      FIRE_ACTIVITY: { earliestAsOf: thirtyDays, note: note30 },
      FLOODS: { earliestAsOf: ninetyDays, note: note90 },
      CYCLONES: { earliestAsOf: ninetyDays, note: note90 },
      WEATHER_ALERTS: { earliestAsOf: thirtyDays, note: note30 },
      OTHER: { earliestAsOf: ninetyDays, note: note90 },
    },
  };
}

export function asOfContext(
  asOf: string,
  isReplay: boolean,
  cutoffMinutesAgo: Partial<Record<FixtureSourceId, number | null>> = {},
): AsOfContext {
  const cutoff = (source: FixtureSourceId, fallback: number): string | null => {
    const minutes = source in cutoffMinutesAgo ? cutoffMinutesAgo[source] : fallback;
    return minutes === null || minutes === undefined ? null : minutesBefore(asOf, minutes);
  };
  return {
    asOf,
    isReplay,
    replayHorizon: replayHorizon(asOf),
    sourceCutoffs: {
      usgs: cutoff('usgs', 4),
      emsc: cutoff('emsc', 5),
      gdacs: cutoff('gdacs', 9),
      firms: cutoff('firms', 22),
      // ECCC is seeded disabled (P1): it has never committed a run, so it has no cutoff.
      eccc: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence manifests.
// ---------------------------------------------------------------------------------------------

/**
 * Builds the evidence manifest of a response from the IDs it actually cites, using the same
 * walk the contract's I9 refinement uses. A cited ID that the registry does not know is a fixture
 * bug, and throws rather than producing a response the schema would reject later.
 */
export function manifestFor(
  response: unknown,
  registry: ReadonlyMap<string, EvidenceItem>,
): readonly EvidenceItem[] {
  const ids = [...citedEvidenceIds(response)].sort();
  return ids.map((id) => {
    const item = registry.get(id);
    if (item === undefined) throw new Error(`fixture cites ${id}, which no registry entry defines`);
    return item;
  });
}
