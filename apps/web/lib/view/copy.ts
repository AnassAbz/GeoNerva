/**
 * The words the UI writes itself (docs/PRODUCT.md §7).
 *
 * Everything a read model supplies — headlines, reasons, interpretations, caveats — is rendered
 * verbatim and is the API's responsibility. What is here is the frame around it: labels, empty
 * states, affordances. `copy.test.ts` scans these strings, and every string literal in the UI's
 * source, with the repository's lexicon scanner plus the §7 phrases the scanner does not cover.
 */

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
    searchPlaceholder: 'City or place name',
    searchSubmit: 'Show briefing',
    noMatch: 'No matching place in the local list.',
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
    notCovered: (familyLabel: string) => `${familyLabel} are not covered for this location.`,
    insufficientHistory: 'Not enough history to establish a baseline.',
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
    sortAscending: 'sorted ascending',
    sortDescending: 'sorted descending',
  },
  history: {
    title: 'Historical context',
    chartLabel: (label: string) => `${label}: chart`,
    missingPoints: 'Gaps in the chart:',
    referenceBand: 'Typical range (25th–75th percentile)',
    p90: '90th percentile',
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
    detections24h: 'Thermal detections, last 24 h',
    overpasses: 'Satellite overpasses, last 24 h',
    total: 'Thermal detections in the cluster',
    firstLast: 'First and last detection',
    frp: 'Fire radiative power, last 24 h',
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
      'How GeoNerva turns public hazard data into a briefing, and what it does not do. Thresholds on this page are rendered from the same configuration the code uses.',
    sections: {
      sources: 'Sources, their delays and their limits',
      correlation: 'Earthquake correlation',
      relevance: 'Relevance',
      baselines: 'Historical baselines',
      changes: 'What Changed',
      notDo: 'What GeoNerva does not do',
      disclaimers: 'Disclaimers and attribution',
    },
    pending:
      'The thresholds and tables for this section are rendered from the configuration the code uses, and are published with the next release of this page.',
    notDoItems: [
      'It does not forecast earthquakes or give probabilities.',
      'It does not replace official warnings or local authorities.',
      'It does not call a satellite thermal detection a confirmed fire.',
      'It does not collapse hazards into a single score.',
    ],
  },
  notFound: {
    title: 'Not found',
    body: 'GeoNerva has no page at this address.',
    home: 'Go to the home page',
  },
  families: {
    unavailableTitle: 'Data unavailable',
    notCoveredTitle: 'Not covered',
  },
  relevance: {
    label: 'Relevance',
  },
} as const;
