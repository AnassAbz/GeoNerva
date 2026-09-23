/**
 * The words the UI writes itself (docs/PRODUCT.md §7).
 *
 * Everything a read model supplies — headlines, reasons, interpretations, caveats — is rendered
 * verbatim and is the API's responsibility. What is here is the frame around it: labels, empty
 * states, affordances. `copy.test.ts` scans these strings, and every string literal in the UI's
 * source, with the repository's lexicon scanner plus the §7 phrases the scanner does not cover.
 *
 * ### Why this file imports the engines' configuration
 *
 * `COPY.methodology` is the one block here that carries *numbers*, and PRODUCT §6.9's page is only
 * worth publishing if those numbers are the ones the engine uses. So every threshold below is
 * interpolated from the exported constant the code reads — `EARTHQUAKE_BASELINE`, `FIRE_TREND`,
 * `DECISION`, the relevance bands — and there is no literal number in the methodology copy. Change
 * a constant and the page changes with it; a number typed in here would be a claim about behaviour
 * rather than a report of it, which is the drift the page exists to prevent.
 *
 * Two kinds of sentence deliberately do **not** live here, and are rendered in
 * `app/methodology/sections.tsx` straight from their exported constants instead: the mandated
 * caveats (`THERMAL_DETECTION_CAVEAT`, `FLOOD_MODELLED_AREA_CAVEAT`, `EARTHQUAKE_ELEVATED_CAVEAT`,
 * `AFTERSHOCK_CAVEAT`). They must appear verbatim, they are the engine's words rather than the
 * UI's — the rule at the top of this comment — and `copy.test.ts` would rightly reject two of them
 * if they were copied in here, because "not confirmed wildfires" and "a larger earthquake will
 * occur" are exactly the phrasings its scanner forbids the UI to author.
 */

import {
  BASELINE_METHOD_VERSION,
  EARTHQUAKE_BASELINE,
  FIRE_TREND,
  GDACS_CONTEXT,
  RETENTION_FLOOR_MAGNITUDE,
} from '@geonerva/baselines';
import {
  ACTIVITY_ABS_MIN,
  ACTIVITY_RELATIVE_FRACTION,
  MATERIALITY,
  MAX_HEADLINE,
  PROMINENCE_BANDS,
} from '@geonerva/changes';
import {
  AGREEMENT_THRESHOLDS,
  CANDIDATE_WINDOW,
  CONFIDENCE_BOUNDS,
  CROSS_FAMILY_MAGNITUDE_WEIGHT,
  DECISION,
  EARTHQUAKE_ALGORITHM_VERSION,
  HYSTERESIS_MISFIT,
  IDENTITY_REF_CONFIDENCE,
  IDENTITY_REF_PENDING_HOURS,
  MAGNITUDE_VETO,
  MISFIT_SCALES,
} from '@geonerva/correlation';
import { FIRE_GRID, LIVE_PAYLOAD_RETENTION_DAYS } from '@geonerva/domain';
import {
  AUTHORITATIVE_ALERT_RADIUS_KM,
  CYCLONE_MODEL_VERSION,
  CYCLONE_TRACK_KM,
  DEEP_FOCUS_KM,
  EARTHQUAKE_BANDS,
  EARTHQUAKE_MODEL_VERSION,
  FELT_REPORTS_THRESHOLD,
  FIRE_ACTIVE_HOURS,
  FIRE_COOLING_HOURS,
  FIRE_GROWTH_FLOOR,
  FIRE_HIGH_DETECTIONS_24H,
  FIRE_HIGH_OVERPASSES_24H,
  FIRE_SUMMARY_VOUCHABLE_HOURS,
  FIRE_MID_KM,
  FIRE_MODEL_VERSION,
  FIRE_NEAR_KM,
  FIRE_OFFICIAL_ALERT_KM,
  FIRE_OUTER_KM,
  FLOOD_CENTROID_ONLY_KM,
  FLOOD_MODEL_VERSION,
  FLOOD_NEAR_AREA_KM,
  FLOOD_OUTER_KM,
  VOLCANO_MODEL_VERSION,
  VOLCANO_NEAR_KM,
  VOLCANO_OUTER_KM,
} from '@geonerva/relevance';

/*
 * Formatters for the methodology copy. They exist so that a threshold reaches the page as the
 * constant's own value: `km(FIRE_TREND.radiusKm)` cannot disagree with `FIRE_TREND.radiusKm`, and
 * a search for a digit in the methodology block returns nothing.
 */

function num(value: number): string {
  return String(value);
}

function dec(value: number): string {
  return value.toFixed(1);
}

function dec2(value: number): string {
  return value.toFixed(2);
}

function km(value: number): string {
  return `${String(value)} km`;
}

/** A grid cell's size. Degrees, not kilometres: a cell narrows towards the poles. */
function degrees(value: number): string {
  return `${String(value)}°`;
}

function metresAsKm(metres: number): string {
  return km(metres / 1000);
}

function secs(value: number): string {
  return `${String(value)} s`;
}

function hours(value: number): string {
  return `${String(value)} h`;
}

function days(value: number): string {
  return `${String(value)} days`;
}

function pct(fraction: number): string {
  return `${String(Math.round(fraction * 100))} %`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 91st … */
export function ordinal(value: number): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : mod10 === 1
        ? 'st'
        : mod10 === 2
          ? 'nd'
          : mod10 === 3
            ? 'rd'
            : 'th';
  return `${String(value)}${suffix}`;
}

export const COPY = {
  product: {
    name: 'GeoNerva',
    tagline: 'Understand what’s changing around you.',
    description:
      'Open-source, explainable natural-hazard intelligence for the places you care about. Near-real-time; each source’s delay is shown.',
    notWarning:
      'GeoNerva is a situational-awareness tool, not an emergency-warning system. Follow official warnings and local authorities.',
  },
  nav: {
    skip: 'Skip to main content',
    home: 'GeoNerva home',
    dataStatus: 'Data status',
    methodology: 'Methodology',
  },
  home: {
    searchLabel: 'Search for a place',
    searchPlaceholder: 'City, place name or coordinates',
    searchSubmit: 'Show briefing',
    noMatch: 'No matching place in the local list.',
    searchTooShort: 'Type at least two characters.',
    /* Shown while the type-ahead cannot be reached; submitting still calls the geocoder. */
    suggestUnavailable: 'Suggestions are unavailable right now. Choose Show briefing to search.',
    searching: 'Searching…',
    searchNoResult: 'No place found for that search.',
    searchChoose: (count: number) => `${String(count)} places found. Choose one.`,
    searchFailed: 'Place search is unavailable right now. Try again in a moment.',
    /* Coordinate entry. The pair is already rounded by the time it reaches this sentence. */
    coordinateOption: (point: string) => `Go to ${point}`,
    coordinateRounded: 'Coordinates are rounded to two decimals, about 1 km, before they are used.',
    coordinateOutOfRange:
      'A latitude must be between −90 and 90, and a longitude between −180 and 180.',
    coordinateSexagesimal: 'Enter coordinates as decimal degrees, for example 31.63, -8.00.',
    /* "Use my location": an explicit click, and a plain sentence whenever it cannot answer. */
    useMyLocation: 'Use my location',
    locating: 'Finding your location…',
    locationDenied: 'Location permission was declined. Type a place name or coordinates instead.',
    locationUnavailable:
      'Your location could not be determined. Type a place name or coordinates instead.',
    locationTimedOut:
      'Finding your location took too long. Type a place name or coordinates instead.',
    locationUnsupported:
      'This browser does not offer a location. Type a place name or coordinates instead.',
    tryLabel: 'Try:',
    howTitle: 'How it works',
    howSteps: [
      'GeoNerva reads public sources — USGS, EMSC, GDACS and NASA FIRMS — and keeps every version it has seen.',
      'It links duplicate earthquake reports, groups satellite thermal detections into fire activity clusters, and compares recent activity with each place’s own history.',
      'Every statement shows where it came from, how fresh it is, and what GeoNerva cannot see.',
    ],
    methodologyLink: 'Read the methodology',
  },
  header: {
    dataAsOf: 'Data as of',
    localTime: 'Local time',
    windowLabel: 'Compare with',
  },
  replay: {
    prefix: 'Replay — showing what GeoNerva knew at',
    suffix: 'Information that arrived later is hidden.',
    exit: 'Return to the present',
  },
  situation: {
    title: 'Situation',
    degraded: 'Some data is currently unavailable.',
    confidence: 'Data confidence',
    confidenceWhy: 'Why this confidence?',
  },
  changes: {
    title: 'What changed',
    showSuppressed: (count: number) =>
      `Show ${String(count)} minor change${count === 1 ? '' : 's'}`,
    hideSuppressed: 'Hide minor changes',
    lateReport: 'Reported late',
    suppressedBecause: 'Filtered out:',
  },
  suppression: {
    IMMATERIAL: 'below the materiality threshold',
    AGED_OUT: 'older than the window',
    LOW_RELEVANCE_BOTH: 'low relevance before and after',
    HYSTERESIS: 'too small a change to report again',
    FAMILY_NOT_COVERED: 'hazard type not covered here',
    GROUPED: 'grouped with a related change',
  },
  card: {
    status: 'Status',
    change: 'Change',
    context: 'Context',
    relevance: 'Relevance',
    sources: 'Sources',
    data: 'Data',
    confidence: 'Confidence',
    noChange: 'No listed change in this window.',
    changeCount: (count: number, window: string) =>
      `${String(count)} change${count === 1 ? '' : 's'} in the last ${window}`,
    /*
     * The verb is a parameter, and `familySubject` in `lib/view/families.ts` supplies it.
     *
     * This read `${familyLabel} are …` unconditionally, so the fire card said "Fire activity are
     * not covered for this location." The same class of mistake reaches the briefing's own
     * sentences, where the verb is chosen from how many families are being listed rather than
     * from the grammatical number of the label: "Weather warnings is not covered here" (QA round
     * 2, L-3). A family's number is a property of the family, so it is recorded with the family.
     */
    notCovered: (subject: string, verb: string) =>
      `${subject} ${verb} not covered for this location.`,
    insufficientHistory: 'Not enough history to establish a baseline.',
    /*
     * The sentence for a card that was handed **no** metric, which is a different fact from a
     * metric that refused.
     *
     * `insufficientHistory` is PRODUCT §7's sanctioned copy for the case where GeoNerva's record
     * really is thin, and it is a claim about GeoNerva's own coverage. Rendering it because a
     * builder supplied nothing said that claim on every card of every page while `/history`
     * answered the same question from 259 reference windows (QA round 2, H-1). What is true when
     * there is no metric is only that none arrived, so that is what this says.
     */
    noBaseline:
      'No historical comparison was computed for this card. It is not a statement about how much history GeoNerva holds here.',
    noItems: 'None reported by the sources checked.',
    percentile: (value: number) => `${ordinal(value)} percentile`,
    agreement: 'Agreement',
    independent: (n: number, total: number) =>
      total > n
        ? `${String(n)} independent of ${String(total)} sources`
        : `${String(n)} independent source${n === 1 ? '' : 's'}`,
    showMore: 'Show details',
    showLess: 'Hide details',
    open: 'Open',
    km: 'away',
    /*
     * What the kilometre figure beside an item is measured to, at the place the figure is shown.
     *
     * One earthquake read 143.9 km at one knowledge time and 148.3 km eight hours earlier,
     * because the canonical centroid moved from EMSC's epicentre to USGS's when the USGS solution
     * became reviewed. The event page says which source's values it is showing and by how much the
     * epicentres differ; the card printed "144 km away" with nothing (QA round 2, L-5). The basis
     * phrase comes from `FAMILY_META[family].distanceBasis`, because every family measures to
     * something different.
     */
    distanceBasis: (basis: string) => `Measured ${basis}.`,
    /*
     * The second half of L-5, and the part a reader needs in order to trust a number that changed.
     *
     * Which source's position is canonical is not in the `/api/v1` contract — `SubjectSummary`
     * carries `distanceKm` and `hypocentralDistanceKm` and no attribution for either — so this
     * says what the response does support: that more than one source placed the item, and that
     * the distance follows whichever solution GeoNerva currently prefers.
     */
    distanceMayMove:
      'More than one source published a position for this item. The distance follows the solution GeoNerva currently prefers, so it can change when a source revises its own.',
  },
  agreement: {
    SINGLE_SOURCE: 'single source',
    DERIVED_ONLY: 'derived copies only',
    AGREE: 'sources agree',
    MINOR_DIFFERENCES: 'minor differences',
    CONFLICT: 'sources conflict',
  },
  derived: {
    tag: 'Derived',
    tagTitle: 'Computed by GeoNerva from the evidence, not reported by a provider',
    why: 'Why?',
    reasons: 'Reasons',
    caveats: 'Caveats',
    model: 'Model',
    close: 'Close',
  },
  evidence: {
    open: 'Evidence',
    openCount: (count: number) => `Evidence (${String(count)})`,
    title: 'Evidence',
    close: 'Close evidence',
    observed: 'Observed',
    ingested: 'Learned by GeoNerva',
    viewOriginal: 'View original',
    derivation: 'GeoNerva derivation',
    missing: 'This evidence item is not in the response’s manifest.',
    kinds: {
      OBS: 'Observation',
      FCV: 'Fire activity cluster',
      FDS: 'Detection set',
      RUN: 'Health run',
      COR: 'Correlation',
      BAS: 'Baseline',
      REL: 'Relevance',
      CHG: 'Change',
    },
  },
  map: {
    title: 'Map',
    /*
     * Beside a layer the map cannot speak for. A family with no source drew the same empty
     * viewport as a quiet one, which is the shape PRODUCT §7 forbids (QA round 2, H-4).
     */
    cannotSay: {
      NOT_COVERED: '(not covered here)',
      UNAVAILABLE: '(cannot be shown now)',
    },
    layers: 'Map layers',
    legend: 'Legend',
    open: 'Open map',
    close: 'Close map',
    location: 'Selected location',
    rings: 'Analysis radius rings',
    webglMissing:
      'The map needs WebGL2, which this browser does not provide. Everything on the map is also in the Nearby list below.',
    loading: 'Loading map…',
    basemapFailed:
      'The basemap could not be loaded. Hazard layers may be incomplete; the Nearby list below has every item.',
    listLink: 'Go to the Nearby list',
    canvasLabel: (place: string) =>
      `Map of hazards near ${place}. The same items are listed in the Nearby table.`,
    legendItems: {
      eq: 'Earthquake — circle, sized by magnitude',
      fire: 'Fire activity cluster — triangle',
      flood: 'GDACS flood-event area (modelled) — hatched',
      cycloneObserved: 'Cyclone track, observed — solid line',
      cycloneForecast: 'Cyclone track, forecast — dashed line',
      other: 'Volcano or drought — diamond',
      critical: 'Critical relevance — red outline',
      location: 'Selected location — pin',
      ring: 'Analysis radius — dotted ring',
    },
  },
  nearby: {
    title: 'Nearby',
    caption: 'Assessed items near this location. Select a column heading to sort.',
    item: 'Item',
    type: 'Type',
    distance: 'Distance',
    relevance: 'Relevance',
    time: 'Time',
    sources: 'Sources',
    empty: 'Nothing assessed near this location in the sources that are available.',
    /*
     * The table's half of QA round 2's L-5. A column of bare kilometre figures invites the reader
     * to compare distances measured to different kinds of thing — an epicentre, the nearest pixel
     * of a thermal cluster, the edge of a modelled area — so each cell names its own basis and
     * this sentence says the figure can move when the preferred solution does.
     */
    distanceNote:
      'Each distance is measured from the position GeoNerva currently treats as canonical for that item, named under the figure. Where sources place an item differently, the figure changes when the preferred solution changes.',
    sortAscending: 'sorted ascending',
    sortDescending: 'sorted descending',
  },
  history: {
    title: 'Historical context',
    chartLabel: (label: string) => `${label}: chart`,
    missingPoints: 'Gaps in the chart:',
    referenceBand: 'Typical range (25th–75th percentile)',
    /*
     * What replaces the band when the band has no width.
     *
     * With `p25` and `p75` both 1 the shaded rectangle collapsed to a hairline, and the legend
     * still called it "Typical range (25th–75th percentile)" — a range that is not a range, drawn
     * as one (QA round 2, M-1). Half the reference windows at the same value is a real and common
     * result for a sparse count, and the honest rendering of it is a level rather than a band.
     */
    referenceLevel: (value: string) =>
      `Typical level: ${value}. The 25th and 75th percentiles are both ${value} here, so there is no range to draw.`,
    p90: '90th percentile',
    /*
     * The bridge between this chart and the cards above it (QA round 2, L-8).
     *
     * "Not enough satellite coverage in the last five weeks to compare fire activity here" sat on
     * the same page as a live cluster of 14 thermal detections. The two statements are not a
     * contradiction — `FIRE_TREND`'s window ends two days back, because ADR-040 counts a day only
     * once it is final, so no date is described both ways — but nothing said so. `lastDay` is in
     * the metric's own `params`, and this is the sentence that spends it.
     */
    windowEnds: (lastDay: string) =>
      `This comparison covers whole days up to and including ${lastDay}. A day is counted only once GeoNerva holds every hour of it, so anything the satellites have seen since is not in this chart — it is on the cards above, which count the individual detections rather than these daily totals.`,
    current: 'Current window',
    methodology: 'How this is computed',
    status: {
      OK: 'Compared with this place’s history',
      RARE_ACTIVITY: 'Rare here — no percentile is given',
      INSUFFICIENT_HISTORY: 'Not enough history to establish a baseline.',
      INSUFFICIENT_COVERAGE: 'Not enough data coverage to compare',
      NOT_APPLICABLE: 'No comparison applies here',
    },
  },
  sources: {
    title: 'Sources & evidence',
    status: 'Status',
    lastPoll: 'Last successful poll',
    newest: 'Newest observation',
    expectedCadence: (duration: string) => `expected every ${duration}`,
    expectedLatency: (duration: string) => `expected ≤ ${duration}`,
    lastError: 'Last error',
    none: 'None',
    never: 'Never',
    attribution: 'Attribution',
    licence: 'Licence',
    coverage: 'Coverage',
    disclaimer: 'Provider disclaimer',
    runs: 'Recent polls',
    runsSummary: (ok: number, total: number) =>
      `${String(ok)} of ${String(total)} polls succeeded in the last 24 h`,
    noRuns: 'No polls in the last 24 h',
    evidenceList: 'Evidence for this briefing',
  },
  dataStatus: {
    title: 'Data status',
    intro:
      'Health of every source GeoNerva reads, judged against each source’s own expected cadence and latency. Near-real-time; each source’s delay is shown.',
    worker: 'Ingestion worker',
    workerLastSeen: 'Last heartbeat',
    workerUnknown: 'GeoNerva cannot state the worker’s liveness at this time.',
    dataQuality: 'Data-quality checks',
    /*
     * Empty means "GeoNerva reports no data-quality checks", never "all checks pass". The service
     * layer says exactly that in its own header and the page then rendered a bare heading over an
     * empty list, which reads as a green light with nothing behind it (QA round 2, M-3). The
     * worker does not compute TESTING §7's invariants yet; when it does, the rows replace this.
     */
    noDataQuality:
      'GeoNerva does not yet run automated data-quality checks, so there is nothing to report here. An empty list is not a statement that every check passed.',
    products: 'Products',
    disabled: 'Not enabled yet',
  },
  event: {
    keyFacts: 'Key facts, per source',
    perSource: 'Per-source values',
    field: 'Field',
    spread: 'Spread',
    notReported: 'Not reported',
    relevanceTitle: 'Relevance for',
    noPlace: 'Open this event from a place to see its relevance there.',
    timeline: 'Timeline of versions',
    sourceUpdated: 'Source updated',
    correlation: 'Why these reports are one event',
    possibleMatches: 'Possibly the same event (not merged)',
    geometry: 'Where',
    officialLinks: 'Official links',
    derivedCopy: 'Derived copy',
    independent: 'Independent',
    contributor: 'Contributor',
    status: 'Status',
    active: 'Active',
    inactive: 'Inactive',
    backToPlace: 'Back to the briefing',
  },
  fire: {
    title: 'Fire activity cluster',
    status: {
      ACTIVE: 'Active — thermal detection in the last 24 h',
      COOLING: 'Cooling — last thermal detection 24–72 h ago',
      INACTIVE: 'Inactive — no thermal detection for over 72 h',
      MERGED: 'Merged into another cluster',
    },
    summary: 'Cluster summary',
    /*
     * The window ends when the summary was computed, not now.
     *
     * These read "last 24 h" and printed figures from whenever the worker last clustered — 7 h 46
     * min before the knowledge time in the seeded scenario, by which point three of the eight
     * detections had fallen out of the window and the honest count was five. The chart directly
     * below said five for today and nine for yesterday, so the page contradicted itself (QA round
     * 2, M-2). A live request recounts the window; a replay cannot, because the raw detections
     * are pruned at 72 h and a recount would report less fire than GeoNerva reported at the
     * time (membership itself is knowable as of a time since ADR-039). Either way the page says
     * which 24 hours these are.
     */
    detections24h: 'Thermal detections',
    overpasses: 'Satellite overpasses',
    window24h: (at: string) => `Counted over the 24 hours to ${at}`,
    total: 'Thermal detections in the cluster',
    firstLast: 'First and last detection',
    frp: 'Fire radiative power',
    sensors: 'Sensors',
    versions: 'Summary versions',
    byDay: 'Thermal detections per day',
    noCoverage: 'No satellite coverage that day',
    sample: 'Sample of thermal detections',
    sampleNote: (shown: number, total: number) =>
      `${String(shown)} of ${String(total)} detections shown.`,
    nearestDetection: 'Nearest detection',
  },
  methodology: {
    title: 'Methodology',
    intro:
      'How GeoNerva turns public hazard data into a briefing, and what it does not do. Every threshold on this page is rendered from the same configuration the engine reads, so the page cannot describe behaviour the code does not have.',
    sections: {
      sources: 'Sources, their delays and their limits',
      correlation: 'Earthquake correlation',
      relevance: 'Relevance',
      baselines: 'Historical baselines',
      fireTrend: 'Fire activity trend',
      gdacs: 'GDACS event context',
      changes: 'What Changed',
      notDo: 'What GeoNerva does not do',
      disclaimers: 'Disclaimers and attribution',
    },
    caveatHeading: 'Stated on every card it applies to',
    sources: {
      intro:
        'GeoNerva reads public sources and keeps every version it has seen. Each source is polled on its own schedule and judged against that schedule, never against one global expectation. Near-real-time; each source’s delay is shown.',
      cadence: 'Polled every',
      latency: 'Data expected within',
      coverage: 'Coverage',
      licence: 'Licence',
      noLatency: 'No data-latency expectation is recorded for this source.',
      noCoverage: 'No coverage limits are recorded for this source.',
      limitsHeading: 'The three limits that shape everything else',
      completeness: `Earthquake catalogues are not complete at every magnitude. GeoNerva estimates each region’s magnitude of completeness (Mc) over ${km(EARTHQUAKE_BASELINE.mcReferenceRadiusKm)} and ${num(EARTHQUAKE_BASELINE.referenceYears)} years, and uses M ${dec(EARTHQUAKE_BASELINE.mcFallback)} when there are fewer than ${num(EARTHQUAKE_BASELINE.mcMinimumEvents)} events to estimate from. Counts below Mc are not comparable between places.`,
      retention: `Every version of every record is kept, with the time GeoNerva learned it. Raw provider payload bodies are kept for ${num(LIVE_PAYLOAD_RETENTION_DAYS.lean)} days on the profile this deployment runs; the derived facts outlive them.`,
    },
    correlation: {
      intro:
        'USGS, EMSC and GDACS each publish their own solution for the same earthquake. GeoNerva decides whether two reports describe one event from a misfit — a weighted distance in time, space and magnitude — and from whether the best candidate is clearly better than the runner-up. Being close is not by itself evidence of identity; being closer to each other than to anything else is.',
      rules: [
        {
          label: 'Candidates considered at all',
          value: `within ${secs(CANDIDATE_WINDOW.maxDeltaSeconds)} and ${metresAsKm(CANDIDATE_WINDOW.maxDistanceMeters)}`,
        },
        {
          label: 'Unit scales of the misfit',
          value: `${secs(MISFIT_SCALES.timeSeconds)}, ${metresAsKm(MISFIT_SCALES.distanceMeters)}, ${dec(MISFIT_SCALES.magnitude)} of magnitude — a term of one means one unit scale away`,
        },
        {
          label: 'One event',
          value: `misfit at or below ${dec(DECISION.matchMisfit)}, with the runner-up at least ${dec(DECISION.uniquenessGap)} worse`,
        },
        {
          label: 'Possibly one event, never merged',
          value: `misfit at or below ${dec(DECISION.possibleMisfit)} without that gap — stored as a candidate and listed, because merging two events that might be one cannot be undone`,
        },
        {
          label: 'Magnitude veto',
          value: `a magnitude difference above ${dec(MAGNITUDE_VETO)} rules a match out, unless one source is republishing the other’s own solution`,
        },
        {
          label: 'Different magnitude types',
          value: `the magnitude term keeps ${pct(CROSS_FAMILY_MAGNITUDE_WEIGHT)} of its weight, because a moment magnitude and a body-wave magnitude measure different things`,
        },
        {
          label: 'Keeping a link across a revision',
          value: `a revised solution still within a misfit of ${dec(HYSTERESIS_MISFIT)} stays linked, so links do not flap as solutions are refined`,
        },
        {
          label: 'Confidence reported for a match',
          value: `between ${dec2(CONFIDENCE_BOUNDS.min)} and ${dec2(CONFIDENCE_BOUNDS.max)}, and never certainty — a deterministic rule is still a judgement`,
        },
        {
          label: 'A provider’s own cross-reference',
          value: `confidence ${dec2(IDENTITY_REF_CONFIDENCE)}; unresolved for more than ${hours(IDENTITY_REF_PENDING_HOURS)} it falls back to the misfit`,
        },
        { label: 'Algorithm version', value: EARTHQUAKE_ALGORITHM_VERSION },
      ],
      agreementHeading: 'When two independent sources describe one event',
      agreementRules: [
        {
          label: 'Sources agree',
          value: `magnitudes within ${dec(AGREEMENT_THRESHOLDS.agree.magnitude)}, epicentres within ${km(AGREEMENT_THRESHOLDS.agree.locationKm)} and depths within ${km(AGREEMENT_THRESHOLDS.agree.depthKm)}`,
        },
        {
          label: 'Minor differences',
          value: `magnitudes within ${dec(AGREEMENT_THRESHOLDS.minor.magnitude)} and epicentres within ${km(AGREEMENT_THRESHOLDS.minor.locationKm)}`,
        },
        { label: 'Sources conflict', value: 'anything wider, and the card says so' },
      ],
      independence:
        'Corroboration counts independent solutions, decided by which agency computed them. A source republishing another’s solution is a derived copy and is labelled as one; it never adds to the count.',
    },
    relevance: {
      intro:
        'Relevance answers one question: how much attention does this deserve for this place? It is not a likelihood of harm and must not be read as one. GeoNerva has a magnitude, a distance, and whether an authority issued an alert.',
      criticalNote: `GeoNerva’s own heuristics stop at High, whatever the magnitude and however close it is. Critical is reachable only from an official impact alert within ${km(AUTHORITATIVE_ALERT_RADIUS_KM)} of the epicentre, and only with the citation that proves one was issued.`,
      eqHeading: 'Earthquakes',
      eqIntro:
        'First match wins, on hypocentral distance — the slant distance through the earth, so an event directly below a place is as far away as it is deep.',
      eqBands: EARTHQUAKE_BANDS.map((band) => ({
        level: band.level,
        condition: `M ${dec(band.minMagnitude)} or greater within ${km(band.maxDistanceKm)}`,
      })),
      eqFloor: 'Anything else inside the search radius is Low.',
      eqExtra: [
        `A hypocentre ${km(DEEP_FOCUS_KM)} deep or deeper demotes the level once, and never below Low.`,
        `Felt reports are stated from ${num(FELT_REPORTS_THRESHOLD)} upwards, and never change the level.`,
        'An automatic, unreviewed solution is labelled as one. The USGS tsunami flag is relayed in the provider’s own wording and never changes the level.',
      ],
      fireHeading: 'Fire activity',
      fireRules: [
        {
          label: 'Distance',
          value: `measured to the nearest thermal detection in the cluster; nothing beyond ${km(FIRE_OUTER_KM)} is assessed`,
        },
        {
          label: 'Cluster state',
          value: `active with a detection in the last ${hours(FIRE_ACTIVE_HOURS)}, cooling from ${num(FIRE_ACTIVE_HOURS)} to ${hours(FIRE_COOLING_HOURS)}, and beyond that history rather than activity`,
        },
        {
          label: 'High',
          value: `within ${km(FIRE_NEAR_KM)} and active, with either ${num(FIRE_HIGH_DETECTIONS_24H)} detections or ${num(FIRE_HIGH_OVERPASSES_24H)} distinct satellite overpasses in ${hours(FIRE_ACTIVE_HOURS)} — two independent looks are much stronger than five pixels from one pass — and only while the summary those counts come from is current, within ${hours(FIRE_SUMMARY_VOUCHABLE_HOURS)}, because they are a rolling window computed when GeoNerva last clustered rather than at the moment you are reading`,
        },
        {
          label: 'Moderate',
          value: `within ${km(FIRE_MID_KM)} and active, or within ${km(FIRE_NEAR_KM)} and cooling`,
        },
        {
          label: 'Growing',
          value: `both halves, or neither: at least double the previous ${hours(FIRE_ACTIVE_HOURS)} and at least ${num(FIRE_GROWTH_FLOOR)} detections`,
        },
        {
          label: 'Critical',
          value: `only from an official GDACS fire-event alert area covering the location within ${km(FIRE_OFFICIAL_ALERT_KM)}`,
        },
        {
          label: 'A persistent heat source',
          value:
            'a place detected repeatedly over months is characteristic of a gas flare or an industrial site, and is capped at Low',
        },
      ],
      gdacsHeading: 'Floods, cyclones, volcanoes',
      gdacsRules: [
        {
          label: 'Floods',
          value: `inside GDACS’s modelled flood-event area, within ${km(FLOOD_NEAR_AREA_KM)} of it, or — when no area geometry was published — within ${km(FLOOD_CENTROID_ONLY_KM)} of its centroid. Nothing beyond ${km(FLOOD_OUTER_KM)} is assessed, and GDACS’s own alert level then sets the band.`,
        },
        {
          label: 'Cyclones',
          value: `the nested wind buffers GDACS publishes, strongest first, then its uncertainty cone, out to ${km(CYCLONE_TRACK_KM)} of the track. A forecast buffer is labelled as a forecast, with the issuing agency named.`,
        },
        {
          label: 'Volcanoes',
          value: `within ${km(VOLCANO_NEAR_KM)}, and Low out to ${km(VOLCANO_OUTER_KM)}. Ash dispersion is not modelled, so there is no plume to be inside of.`,
        },
      ],
      versionsHeading: 'Model versions',
      versions: [
        EARTHQUAKE_MODEL_VERSION,
        FIRE_MODEL_VERSION,
        FLOOD_MODEL_VERSION,
        CYCLONE_MODEL_VERSION,
        VOLCANO_MODEL_VERSION,
      ].join(', '),
    },
    eqBaseline: {
      intro:
        'How many earthquakes of M ≥ Mc there have been within the radius in the trailing window, against every comparable window in this place’s own history.',
      rules: [
        {
          label: 'Magnitude of completeness (Mc)',
          value: `a maximum-curvature estimate with a +${dec(EARTHQUAKE_BASELINE.mcCorrection)} correction on bins of ${dec(EARTHQUAKE_BASELINE.mcBinWidth)} magnitude, over ${km(EARTHQUAKE_BASELINE.mcReferenceRadiusKm)}; it needs ${num(EARTHQUAKE_BASELINE.mcMinimumEvents)} events above the candidate and otherwise falls back to M ${dec(EARTHQUAKE_BASELINE.mcFallback)}`,
        },
        {
          label: 'Radius',
          value: `${EARTHQUAKE_BASELINE.radiiKm.map(num).join(' / ')} km, with ${km(EARTHQUAKE_BASELINE.defaultRadiusKm)} the default`,
        },
        {
          label: 'Window',
          value: `${EARTHQUAKE_BASELINE.windowsDays.map(days).join(' and ')}; the ${days(EARTHQUAKE_BASELINE.primaryWindowDays)} window is the one reported first`,
        },
        {
          label: 'Reference period',
          value: `${num(EARTHQUAKE_BASELINE.referenceYears)} years, or the whole catalogue where it is shorter`,
        },
        {
          label: 'Compared at all',
          value: `at least ${num(EARTHQUAKE_BASELINE.minimumWindows)} reference windows and ${num(EARTHQUAKE_BASELINE.minimumEvents)} reference events. With the windows but not the events, GeoNerva states how rare any activity is here and gives no percentile. With neither, it says there is not enough history.`,
        },
        {
          label: 'Above typical',
          value: `at or above the ${ordinal(EARTHQUAKE_BASELINE.abovePercentile)} percentile and at least ${num(EARTHQUAKE_BASELINE.aboveMinimumObserved)} events observed`,
        },
        {
          label: 'Well above typical',
          value: `at or above the ${ordinal(EARTHQUAKE_BASELINE.wellAbovePercentile)} percentile and at least ${num(EARTHQUAKE_BASELINE.wellAboveMinimumObserved)} events observed`,
        },
        {
          label: 'Ratio to the baseline',
          value: `shown only when the reference mean is at least ${num(EARTHQUAKE_BASELINE.ratioMinimumMean)} event per window, so a mean of a tenth cannot produce a multiple out of three events`,
        },
        {
          label: 'Largest recent',
          value: `the largest magnitude within the radius in the last ${days(EARTHQUAKE_BASELINE.largestRecentDays)}`,
        },
        {
          label: 'Sequence context',
          value: `stated when an event of M ≥ Mc + ${dec(EARTHQUAKE_BASELINE.sequenceMagnitudeAboveMc)} occurred within the radius in the last ${days(EARTHQUAKE_BASELINE.sequenceDays)}`,
        },
        { label: 'Method version', value: BASELINE_METHOD_VERSION },
      ],
      noLowBand:
        'There is no band below typical. A quiet period is not a reportable signal, and a thin catalogue is reported as thin rather than as quiet.',
      retentionFloor: `Where the reference period reaches back past the retention of smaller events, Mc is floored at M ${dec(RETENTION_FLOOR_MAGNITUDE)}: a claim about smaller events that old would not be supported by what GeoNerva still holds.`,
    },
    fireTrend: {
      intro: `Satellite thermal detections within ${km(FIRE_TREND.radiusKm)} over the last ${days(FIRE_TREND.recentDays)}, against the ${days(FIRE_TREND.previousDays)} before them, as a mean per covered day.`,
      rules: [
        {
          label: 'Compared',
          value: `the last ${days(FIRE_TREND.recentDays)} against the previous ${days(FIRE_TREND.previousDays)}, within ${km(FIRE_TREND.radiusKm)}`,
        },
        {
          label: 'Per covered day',
          value: `the mean is taken over the days GeoNerva actually read every hour of, not over calendar days`,
        },
        {
          label: 'The trend moves at all',
          value: `only when the two daily means differ by at least ${pct(FIRE_TREND.minimumRelativeChange)} and by at least ${num(FIRE_TREND.minimumAbsolutePerDay)} detections a day. Both, so a rise from one detection to three is not reported as fire activity trebling.`,
        },
        {
          label: 'Otherwise',
          value:
            'the trend is reported as stable, and a direction is never stated without both conditions met',
        },
        {
          label: 'Too little coverage',
          value:
            'with no covered day in either period there is no mean, and GeoNerva says it cannot compare rather than computing a trend from nothing',
        },
        {
          label: 'Sensors',
          value:
            'only the satellite feeds active across the whole comparison are used, so a sensor added or retired part-way through cannot manufacture a trend',
        },
        { label: 'Method version', value: BASELINE_METHOD_VERSION },
      ],
      limitationsHeading: 'Two limitations, stated plainly',
      limitations: [
        'A day GeoNerva did not read every hour of is excluded from both means rather than counted as zero. Detection counts depend on satellite overpasses, cloud and view angle as much as on fire, so an unread hour leaves a day GeoNerva cannot speak for — and treating it as a quiet day is the single error this rule exists to prevent. The same holds for a day whose detections are no longer held.',
        `Detections are counted on a ${degrees(FIRE_GRID.degrees)} grid, and a cell counts when its centre lies within ${km(FIRE_TREND.radiusKm)}. The edge of that circle is therefore approximate by up to half a cell. What makes that acceptable is that the comparison is one place against its own past, through the same cells on both sides.`,
      ],
      trendWording:
        'This is a trend and GeoNerva words it as one: a direction of change in what the satellites saw. It is not a judgement about how this place usually behaves, and it is not a forecast.',
    },
    gdacsContext: {
      intro: `How many GDACS events of the same kind there have been within ${km(GDACS_CONTEXT.radiusKm)} in the last ${num(GDACS_CONTEXT.years)} years.`,
      rules: [
        {
          label: 'Radius and span',
          value: `${km(GDACS_CONTEXT.radiusKm)}, ${num(GDACS_CONTEXT.years)} years`,
        },
        { label: 'What it is', value: 'a count and a sentence — context, and never an anomaly' },
        {
          label: 'No percentile',
          value:
            'these counts are far too sparse for a distribution, so there is no percentile and no band',
        },
        {
          label: 'A shorter record',
          value:
            'where GeoNerva’s unbroken GDACS record begins later than the full span, the sentence gives that date instead of claiming the span',
        },
      ],
    },
    changesMethod: {
      intro:
        'Two snapshots of the same place, diffed. A change is listed when it is material, and its prominence is scored from what kind of change it is, the higher of its two relevance levels, how far past the threshold it moved, and how recently.',
      rules: [
        {
          label: 'A revision is material at',
          value: `a magnitude shift of ${dec(MATERIALITY.magnitude)}, an epicentre shift of ${km(MATERIALITY.epicentreKm)}, a depth shift of ${km(MATERIALITY.depthKm)}, or an area change of ${pct(MATERIALITY.areaFraction)}`,
        },
        {
          label: 'An activity change is material at',
          value: `a band change, or a shift of at least ${pct(ACTIVITY_RELATIVE_FRACTION)} that is also at least ${num(ACTIVITY_ABS_MIN.earthquakeCount)} earthquakes, ${num(ACTIVITY_ABS_MIN.fireClusters)} fire activity clusters or ${num(ACTIVITY_ABS_MIN.fireDetections)} thermal detections`,
        },
        {
          label: 'Prominence',
          value: `headline from ${num(PROMINENCE_BANDS.headline)}, listed from ${num(PROMINENCE_BANDS.listed)}, detail from ${num(PROMINENCE_BANDS.detail)}`,
        },
        { label: 'Headlines shown', value: `at most ${num(MAX_HEADLINE)}` },
      ],
      suppressed:
        'Everything filtered out is still counted, can be shown on request, and carries the reason it was filtered. A report that arrived late is marked as late rather than backdated.',
    },
    notDoItems: [
      'It does not forecast earthquakes or give probabilities.',
      'It does not replace official warnings or local authorities.',
      'It does not call a satellite thermal detection a confirmed fire.',
      'It does not collapse hazards into a single score.',
      'It does not fill a gap in the data with a zero.',
      'It does not tell you what to do.',
    ],
    disclaimersIntro:
      'Each provider’s own licence, attribution and disclaimer, shown in the provider’s wording.',
  },
  notFound: {
    title: 'Not found',
    body: 'GeoNerva has no page at this address.',
    home: 'Go to the home page',
  },
  /**
   * What a route's skeleton announces while its data is being read.
   *
   * One sentence per route, naming the subject rather than the mechanism: a reader who cannot see
   * the grey shapes learns which page is arriving, and nothing here states a value.
   */
  loading: {
    briefing: 'Loading the briefing for this place…',
    event: 'Loading this event…',
    fire: 'Loading this fire activity cluster…',
    dataStatus: 'Loading the health of every source…',
  },
  /**
   * What a failed boundary says (PRODUCT §7).
   *
   * Two rules shape every sentence here. **A failure is GeoNerva's, and is said to be GeoNerva's**
   * — never the reader's doing, and never a bare "something went wrong", which tells a reader
   * nothing they can act on. **A failure is not an absence**: §6.7's distinction between "no data"
   * and "no hazard" is exactly what a blank page destroys, so each body says what the blankness
   * does *not* mean before it offers the retry.
   *
   * `retention*` is the one block that is not an error at all. `AS_OF_BEFORE_HORIZON` means the
   * records for that instant were not kept that long (ADR-035), which is a fact about retention;
   * wording it as a fault, or rendering it as a 404, would tell the reader something untrue about
   * both GeoNerva and the past.
   */
  failure: {
    retry: 'Try again',
    home: 'Go to the home page',
    dataStatusLink: 'See the health of every source',
    pageTitle: 'This page could not be loaded',
    pageBody:
      'GeoNerva could not build this page just now. The fault is on GeoNerva’s side. Try again in a moment.',
    briefingTitle: 'This briefing could not be loaded',
    briefingBody:
      'GeoNerva could not assemble the briefing for this place just now. The fault is on GeoNerva’s side; this is not an absence of hazard data and must not be read as a quiet place. Try again in a moment.',
    eventTitle: 'This event could not be loaded',
    eventBody:
      'GeoNerva could not read this event just now. The fault is on GeoNerva’s side, and it is not a statement that the sources stopped reporting the event. Try again in a moment.',
    fireTitle: 'This fire activity cluster could not be loaded',
    fireBody:
      'GeoNerva could not read this fire activity cluster just now. The fault is on GeoNerva’s side, and it is not a statement about what the satellites detected. Try again in a moment.',
    dataStatusTitle: 'The data status could not be loaded',
    dataStatusBody:
      'GeoNerva could not read the health of its own sources just now. Until this page loads, treat every source’s freshness as unknown rather than current. Try again in a moment.',
    retentionTitle: 'That time is outside what GeoNerva still holds',
    retentionBody:
      'GeoNerva did not keep the records that far back, so it cannot show what it knew at that moment. That is a limit on how long data is kept — not a gap in what happened, and not a mistake in what you asked for.',
    retentionExit: 'Return to the present',
  },
  families: {
    unavailableTitle: 'Data unavailable',
    notCoveredTitle: 'Not covered',
  },
  relevance: {
    label: 'Relevance',
  },
} as const;
