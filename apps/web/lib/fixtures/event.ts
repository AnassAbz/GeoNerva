/**
 * `EventDetail` for EQ-26-7K3F9Q, with and without a place (relevance exists only when the
 * request names one), plus the flood event for a second hazard type.
 */

import type { EventDetail } from '@geonerva/domain';

import { FIXTURE_NOW, SCHEMA_VERSION, asOfContext, attributionFor, manifestFor } from './common.ts';
import {
  EQ_AGREEMENT,
  EQ_FACTS,
  EQ_PUBLIC_ID,
  EQ_RELEVANCE,
  EV,
  FLOOD_PUBLIC_ID,
  FLOOD_RELEVANCE,
  FLOOD_SUMMARY,
  GEOMETRY,
  T,
  evidenceRegistry,
} from './world.ts';

export interface EventFixtureOptions {
  /** True when the caller arrived from a place page, so relevance is computed for it. */
  readonly withPlace?: boolean;
}

export function earthquakeDetail(options: EventFixtureOptions = {}): EventDetail {
  const withPlace = options.withPlace ?? true;
  const asOf = FIXTURE_NOW;
  const detail: EventDetail = {
    schemaVersion: SCHEMA_VERSION,
    publicId: EQ_PUBLIC_ID,
    subjectRef: `CE:${EQ_PUBLIC_ID}`,
    hazardType: 'EARTHQUAKE',
    family: 'EARTHQUAKES',
    asOfContext: asOfContext(asOf, false),
    createdAt: T.emscIngested,
    headline: {
      title: 'M4.7 earthquake · 49 km S of Azilal, Morocco',
      observedAt: T.eqObserved,
      lifecycleStatus: 'UPDATED',
      isActive: true,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
      preferredSourceId: 'usgs',
      preferenceReason: {
        code: 'PREFERRED_REVIEWED',
        text: 'Headline value from USGS (reviewed).',
        params: { sourceId: 'usgs', status: 'reviewed' },
        evidenceIds: [EV.usgsV2],
      },
      centroid: GEOMETRY.eqEpicentre,
      /*
       * `factsOf`'s facts and nothing else. The two extra entries here — `origin_time`, which is
       * `OBSERVED_AT` under another name, and `tsunami_flag`, which is a hazard *attribute* in a
       * JSONB column and has never been a fact — are the drift QA round 2 §4 describes.
       *
       * Dropping `tsunami_flag` makes `app/event/[publicId]/page.tsx:100` render no tsunami row,
       * which is what it already does against the real API: no builder emits that code. That
       * lookup is a third instance of this bug and is reported rather than fixed here, because
       * the `page.tsx` files are another agent's this round.
       */
      facts: [...EQ_FACTS.usgs],
      evidenceIds: [EV.usgsV2],
    },
    observations: [
      {
        sourceId: 'usgs',
        sourceName: 'USGS',
        productCode: 'comcat',
        contributor: 'us',
        relation: 'PRIMARY',
        matchKind: 'SEED',
        isDerivedCopy: false,
        primaryKey: 'us7000tikb',
        aliases: [],
        versionId: '90211',
        versionSeq: 2,
        observedAt: T.eqObserved,
        validFrom: null,
        validTo: null,
        sourceUpdatedAt: T.usgsV2Updated,
        ingestedAt: T.usgsV2Ingested,
        lifecycleStatus: 'UPDATED',
        providerSeverity: { scheme: 'PAGER', value: 'green' },
        providerStatus: 'reviewed',
        title: 'M 4.7 - 49 km S of Azilal, Morocco',
        sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
        facts: EQ_FACTS.usgs,
        evidenceId: EV.usgsV2,
      },
      {
        sourceId: 'emsc',
        sourceName: 'EMSC',
        productCode: 'rts',
        contributor: 'EMSC',
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        isDerivedCopy: false,
        primaryKey: '20260922_0000187',
        aliases: [],
        versionId: '90204',
        versionSeq: 1,
        observedAt: '2026-09-22T11:47:10.000Z',
        validFrom: null,
        validTo: null,
        sourceUpdatedAt: '2026-09-22T11:54:02.000Z',
        ingestedAt: T.emscIngested,
        lifecycleStatus: 'ACTIVE',
        providerSeverity: null,
        providerStatus: null,
        title: 'MOROCCO',
        sourceUrl: 'https://www.seismicportal.eu/eventdetails.html?unid=20260922_0000187',
        facts: EQ_FACTS.emsc,
        evidenceId: EV.emscV1,
      },
      {
        sourceId: 'gdacs',
        sourceName: 'GDACS',
        productCode: 'EQ',
        contributor: 'us',
        relation: 'DERIVED_COPY',
        matchKind: 'IDENTITY_REF',
        isDerivedCopy: true,
        primaryKey: 'EQ:1498833',
        aliases: ['us7000tikb'],
        versionId: '90215',
        versionSeq: 1,
        observedAt: T.eqObserved,
        validFrom: T.eqObserved,
        validTo: null,
        sourceUpdatedAt: '2026-09-22T12:12:00.000Z',
        ingestedAt: T.gdacsEqIngested,
        lifecycleStatus: 'ACTIVE',
        providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
        providerStatus: null,
        title: 'Green earthquake alert (Magnitude 4.7M, Depth:10km) in Morocco',
        sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1498833&eventtype=EQ',
        facts: EQ_FACTS.gdacs,
        evidenceId: EV.gdacsEq,
      },
    ],
    agreement: EQ_AGREEMENT,
    timeline: [
      {
        versionId: '90211',
        versionSeq: 2,
        sourceId: 'usgs',
        ingestedAt: T.usgsV2Ingested,
        observedAt: T.eqObserved,
        sourceUpdatedAt: T.usgsV2Updated,
        lifecycleStatus: 'UPDATED',
        /*
         * `describeRevision`'s own sentence, field names and change codes
         * (packages/briefing/src/timeline.ts). This read "from mb 4.6 to Mww 4.7", with
         * `changedFields: ['magnitude', 'magnitude_type', 'review_status']` and a
         * `magnitude_type` change — three field names the revision describer has never produced,
         * for a quantity it does not track. `apps/web/e2e/dashboard.spec.ts:88` asserts the real
         * sentence against the database; this now says the same thing.
         */
        summary: 'USGS revised the magnitude from M4.6 to M4.7 and marked it reviewed.',
        changedFields: ['magnitude', 'providerStatus'],
        changes: [
          {
            code: 'MAGNITUDE',
            label: 'Magnitude',
            before: { kind: 'number', value: 4.6, unit: null, decimals: 1 },
            after: { kind: 'number', value: 4.7, unit: null, decimals: 1 },
          },
          {
            code: 'PROVIDER_STATUS',
            label: 'Review status',
            before: { kind: 'text', value: 'automatic' },
            after: { kind: 'text', value: 'reviewed' },
          },
        ],
        evidenceId: EV.usgsV2,
      },
      {
        versionId: '90215',
        versionSeq: 1,
        sourceId: 'gdacs',
        ingestedAt: T.gdacsEqIngested,
        observedAt: T.eqObserved,
        sourceUpdatedAt: '2026-09-22T12:12:00.000Z',
        lifecycleStatus: 'ACTIVE',
        summary: 'GDACS published a Green earthquake alert restating the USGS solution.',
        changedFields: [],
        changes: [],
        evidenceId: EV.gdacsEq,
      },
      {
        versionId: '90198',
        versionSeq: 1,
        sourceId: 'usgs',
        ingestedAt: T.usgsV1Ingested,
        observedAt: T.eqObserved,
        sourceUpdatedAt: '2026-09-22T11:56:30.000Z',
        lifecycleStatus: 'ACTIVE',
        summary: 'USGS first reported an mb 4.6 earthquake at 10 km depth.',
        changedFields: [],
        changes: [],
        evidenceId: EV.usgsV1,
      },
      {
        versionId: '90204',
        versionSeq: 1,
        sourceId: 'emsc',
        ingestedAt: T.emscIngested,
        observedAt: '2026-09-22T11:47:10.000Z',
        sourceUpdatedAt: '2026-09-22T11:54:02.000Z',
        lifecycleStatus: 'ACTIVE',
        summary: 'EMSC first reported an mb 4.6 earthquake at 12 km depth.',
        changedFields: [],
        changes: [],
        evidenceId: EV.emscV1,
      },
    ],
    correlation: {
      algorithmVersion: 'corr-eq-3',
      decisions: [
        {
          linkId: '5521',
          sourceId: 'usgs',
          primaryKey: 'us7000tikb',
          relation: 'PRIMARY',
          matchKind: 'SEED',
          confidence: null,
          reasons: [
            {
              code: 'PRIMARY_RECORD',
              text: 'The USGS record opened this event: it has no identity reference to an earlier one.',
              params: {},
              evidenceIds: [EV.usgsV1],
            },
          ],
          linkedAt: T.usgsV1Ingested,
          unlinkedAt: null,
          unlinkReason: null,
          evidenceId: EV.corUsgs,
        },
        {
          linkId: '5522',
          sourceId: 'emsc',
          primaryKey: '20260922_0000187',
          relation: 'SAME_EVENT',
          matchKind: 'SPATIOTEMPORAL',
          confidence: 0.97,
          reasons: [
            {
              code: 'TIME_MISFIT',
              text: 'Origin times 2 s apart (threshold 16 s).',
              params: { seconds: 2, threshold: 16 },
              evidenceIds: [EV.emscV1, EV.usgsV1],
            },
            {
              code: 'DISTANCE_MISFIT',
              text: 'Epicentres 6 km apart (threshold 100 km).',
              params: { km: 6, threshold: 100 },
              evidenceIds: [EV.emscV1, EV.usgsV1],
            },
            {
              code: 'MAGNITUDE_MISFIT',
              text: 'Magnitudes 0.0 apart at the time of linking (threshold 0.5).',
              params: { spread: 0, threshold: 0.5 },
              evidenceIds: [EV.emscV1, EV.usgsV1],
            },
          ],
          linkedAt: T.usgsV1Ingested,
          unlinkedAt: null,
          unlinkReason: null,
          evidenceId: EV.corEmsc,
        },
        {
          linkId: '5523',
          sourceId: 'gdacs',
          primaryKey: 'EQ:1498833',
          relation: 'DERIVED_COPY',
          matchKind: 'IDENTITY_REF',
          confidence: null,
          reasons: [
            {
              code: 'IDENTITY_REFERENCE',
              text: 'GDACS names the USGS event us7000tikb as its source, so the two are linked by identity and GDACS is not counted as independent.',
              params: { reference: 'us7000tikb' },
              evidenceIds: [EV.gdacsEq],
            },
          ],
          linkedAt: T.gdacsEqIngested,
          unlinkedAt: null,
          unlinkReason: null,
          evidenceId: EV.corGdacs,
        },
      ],
      possibleMatches: [
        {
          otherPublicId: null,
          sourceId: 'emsc',
          primaryKey: '20260922_0000191',
          score: 0.41,
          reasons: [
            {
              code: 'TIME_MISFIT',
              text: 'An M2.6 EMSC record 94 s later and 18 km away scored below the linking threshold; it is shown here rather than merged.',
              params: { seconds: 94, km: 18 },
              evidenceIds: [],
            },
          ],
          evaluatedAt: '2026-09-22T12:02:10.000Z',
        },
      ],
      agreementLevel: 'MINOR_DIFFERENCES',
    },
    geometries: [
      {
        role: 'region',
        kind: 'EPICENTER',
        geometry: {
          type: 'Point',
          coordinates: [GEOMETRY.eqEpicentre.lon, GEOMETRY.eqEpicentre.lat],
        },
        validAt: null,
        isForecast: false,
        evidenceIds: [EV.usgsV2],
      },
    ],
    relevance: withPlace ? EQ_RELEVANCE : null,
    distanceKm: withPlace ? 142.3 : null,
    hypocentralDistanceKm: withPlace ? 142.6 : null,
    mergedIntoPublicId: null,
    mergedAt: null,
    supersededPublicIds: [],
    relatedEvents: [],
    evidenceManifest: [],
    attribution: attributionFor('usgs', 'emsc', 'gdacs'),
  };
  return { ...detail, evidenceManifest: manifestFor(detail, evidenceRegistry(asOf)) };
}

export function floodDetail(options: EventFixtureOptions = {}): EventDetail {
  const withPlace = options.withPlace ?? true;
  const asOf = FIXTURE_NOW;
  const detail: EventDetail = {
    schemaVersion: SCHEMA_VERSION,
    publicId: FLOOD_PUBLIC_ID,
    subjectRef: `CE:${FLOOD_PUBLIC_ID}`,
    hazardType: 'FLOOD',
    family: 'FLOODS',
    asOfContext: asOfContext(asOf, false),
    createdAt: T.floodIngested,
    headline: {
      title: 'GDACS flood event · Souss-Massa, Morocco',
      observedAt: T.floodObserved,
      lifecycleStatus: 'UPDATED',
      isActive: true,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
      preferredSourceId: 'gdacs',
      preferenceReason: {
        code: 'ONLY_SOURCE',
        text: 'GDACS is the only source for this flood event.',
        params: {},
        evidenceIds: [EV.gdacsFlood],
      },
      centroid: { lat: 30.46, lon: -9.1 },
      facts: FLOOD_SUMMARY.facts,
      evidenceIds: [EV.gdacsFlood],
    },
    observations: [
      {
        sourceId: 'gdacs',
        sourceName: 'GDACS',
        productCode: 'FL',
        contributor: null,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        isDerivedCopy: false,
        primaryKey: 'FL:1103921',
        aliases: [],
        versionId: '88410',
        versionSeq: 3,
        observedAt: T.floodObserved,
        validFrom: T.floodObserved,
        validTo: null,
        sourceUpdatedAt: T.floodUpdated,
        ingestedAt: T.floodUpdated,
        lifecycleStatus: 'UPDATED',
        providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
        providerStatus: null,
        title: 'Green flood alert in Morocco',
        sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1103921&eventtype=FL',
        facts: FLOOD_SUMMARY.facts,
        evidenceId: EV.gdacsFlood,
      },
    ],
    agreement: FLOOD_SUMMARY.agreement ?? EQ_AGREEMENT,
    timeline: [
      {
        versionId: '88410',
        versionSeq: 3,
        sourceId: 'gdacs',
        ingestedAt: T.floodUpdated,
        observedAt: T.floodObserved,
        sourceUpdatedAt: T.floodUpdated,
        lifecycleStatus: 'UPDATED',
        /*
         * `describeRevision`'s sentence for exactly this case. GDACS raising its episode number
         * changes nothing the read model shows, and the describer says so in those words; the
         * fixture instead invented a `changedFields: ['episode']` — a field name it has never
         * produced — with an empty `changes` array beside it.
         */
        summary: 'GDACS updated its record without changing the values GeoNerva shows.',
        changedFields: [],
        changes: [],
        evidenceId: EV.gdacsFlood,
      },
    ],
    correlation: {
      algorithmVersion: 'corr-gdacs-1',
      decisions: [],
      possibleMatches: [],
      agreementLevel: 'SINGLE_SOURCE',
    },
    geometries: [
      {
        role: 'affected_area',
        kind: 'MODEL_AREA',
        geometry: GEOMETRY.floodArea,
        validAt: null,
        isForecast: false,
        evidenceIds: [EV.gdacsFlood],
      },
    ],
    relevance: withPlace ? FLOOD_RELEVANCE : null,
    distanceKm: withPlace ? 171.4 : null,
    hypocentralDistanceKm: null,
    mergedIntoPublicId: null,
    mergedAt: null,
    supersededPublicIds: [],
    relatedEvents: [],
    evidenceManifest: [],
    attribution: attributionFor('gdacs'),
  };
  return { ...detail, evidenceManifest: manifestFor(detail, evidenceRegistry(asOf)) };
}
