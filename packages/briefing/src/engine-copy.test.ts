/**
 * The copy the pure engines compose, scanned against the banned lexicon (ARCHITECTURE §11.4
 * rule 5) — QA round 2, L-7.
 *
 * `packages/relevance` and `packages/changes` author `Reason.text`, the change titles and the
 * mandated caveats, and until this file nothing scanned a word of it: `apps/web/lib/view/copy.ts`
 * has a scan that deliberately excludes read-model text, and `templates.test.ts` covers only the
 * deterministic templates. So the sentences on every hazard card — the ones a reader actually
 * acts on — were the only reader-facing strings in the product with no terminology gate.
 *
 * ### Why the scan lives here
 *
 * Because the lexicon lives here and those packages may not reach it.
 * `.dependency-cruiser.cjs` allows `relevance` and `changes` `domain` and `geo` only, and that
 * rule has **no test-file exemption** — its `from` is the whole package path — so a test in
 * `packages/relevance` importing `packages/briefing` fails `pnpm depcruise` rather than merely
 * looking wrong. `briefing` is the one package permitted to depend on all three engines, and
 * `history-copy.test.ts` already scans `baselines` from here for exactly this reason. Between the
 * two files the three packages L-7 names are covered; L-7's claim that `baselines` was scanned by
 * nothing was the one part of the finding that was already false when it was written
 * (`history-copy.test.ts` predates it), so this file covers `relevance` and `changes` and leaves
 * the baselines scan where it is rather than writing a second one.
 *
 * ### The one place the rules have to be read carefully
 *
 * `THERMAL_AS_WILDFIRE` is not exemptible by a verbatim quote, and it should not be — calling a
 * thermal detection a wildfire is a category error whoever wrote the words. But four sentences on
 * a `THERMAL_ACTIVITY` card legitimately contain the word, and the lexicon's own docstring is what
 * permits them: two **denials** (§9.2's mandatory caveat, "They are not confirmed wildfires", and
 * the gas-flare cap's "rather than a wildfire"), and two references to an official GDACS
 * `WILDFIRE_EVENT`, which is a burnt-area event rather than a pixel. They are pinned below **by
 * their exact text**, so the rules stay enforced for every other sentence and a fifth one cannot
 * be added without this test failing. Those are the sentences L-7 says "a future edit will get
 * wrong with no test to stop it".
 */

import { describe, expect, it } from 'vitest';

import {
  CHANGE_TYPES,
  type FamilyCard,
  type HazardFamily,
  type LocationSnapshotView,
  type SubjectSummary,
} from '@geonerva/domain';

import { changeTitleFor, diffSnapshots } from '@geonerva/changes';
import {
  FLOOD_MODELLED_AREA_CAVEAT,
  THERMAL_DETECTION_CAVEAT,
  assessCyclone,
  assessEarthquake,
  assessFire,
  assessFlood,
  assessVolcano,
  type Assessment,
  type CycloneInput,
  type EarthquakeInput,
  type FireInput,
  type FloodInput,
  type VolcanoInput,
} from '@geonerva/relevance';

import { isLexiconClean, scanLexicon } from './lexicon.ts';

/** Every sentence an assessment puts in front of a reader. */
function textsOf(assessment: Assessment | null): string[] {
  if (assessment === null) return [];
  return [...assessment.reasons.map((entry) => entry.text), ...assessment.caveats];
}

function expectClean(
  texts: readonly string[],
  options: Parameters<typeof isLexiconClean>[1],
): void {
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(scanLexicon(text, options), text).toStrictEqual([]);
  }
}

describe('relevance copy: earthquakes', () => {
  function quake(overrides: Partial<EarthquakeInput> = {}): EarthquakeInput {
    return {
      location: { lat: 31.63, lon: -7.99 },
      epicentre: { lat: 31.7, lon: -8.1 },
      epicentralDistanceKm: 20,
      magnitude: 5.4,
      depthKm: 10,
      providerStatus: 'reviewed',
      severityScheme: null,
      severityValue: null,
      feltReports: null,
      tsunamiFlag: false,
      agreementLevel: null,
      corroborated: true,
      ...overrides,
    };
  }

  it('is clean for every reason and caveat the model can produce', () => {
    const all = [
      ...textsOf(assessEarthquake(quake())),
      // Every optional branch: deep focus, an unreviewed solution, felt reports, the USGS
      // tsunami flag, a source conflict and a single-source event.
      ...textsOf(assessEarthquake(quake({ depthKm: 400 }))),
      ...textsOf(assessEarthquake(quake({ providerStatus: 'automatic' }))),
      ...textsOf(assessEarthquake(quake({ feltReports: 4200 }))),
      ...textsOf(assessEarthquake(quake({ tsunamiFlag: true }))),
      ...textsOf(assessEarthquake(quake({ agreementLevel: 'CONFLICT' }))),
      ...textsOf(assessEarthquake(quake({ corroborated: false }))),
      ...textsOf(
        assessEarthquake(
          quake({ severityScheme: 'PAGER', severityValue: 'orange', magnitude: 6.8 }),
        ),
      ),
      ...textsOf(assessEarthquake(quake({ magnitude: 3.2, epicentralDistanceKm: 140 }))),
    ];
    /*
     * The USGS tsunami sentence quotes the provider's documentation verbatim — *"does not indicate
     * if a tsunami actually did or will exist"* — and it is passed as a quote rather than assumed
     * innocent, so that the exemption is exercised here too. It happens not to need it today;
     * relying on that would make the next USGS wording change a lexicon failure.
     */
    expectClean(all, {
      verbatimQuotes: ['the flag "does not indicate if a tsunami actually did or will exist"'],
    });
  });

  it('never says an earthquake is due, imminent or predicted', () => {
    // The class this model is closest to: a reader wants the next one, and §9.1 answers about the
    // one that happened. Seismicity words that would cross the line, as a live check of the scan.
    for (const banned of [
      'A larger earthquake is imminent here.',
      'This region is overdue for a major earthquake.',
      'GeoNerva predicts a magnitude 6 within the week.',
    ]) {
      expect(isLexiconClean(banned)).toBe(false);
    }
  });
});

describe('relevance copy: fire activity', () => {
  function fire(overrides: Partial<FireInput> = {}): FireInput {
    return {
      nearestDetectionKm: 5,
      state: 'ACTIVE',
      n24h: 8,
      nTotal: 30,
      overpasses24h: 2,
      nPrevious24h: 6,
      frpSum24h: 42.5,
      hoursSinceLastDetection: 3,
      summaryAgeHours: 0.5,
      officialAlertNearby: false,
      relatedGdacsEventId: null,
      persistentHeatSource: false,
      ...overrides,
    };
  }

  /**
   * The four sentences a `THERMAL_ACTIVITY` card may put the word "wildfire" in, verbatim.
   *
   * Two **deny** it — §9.2's mandatory caveat and the gas-flare cap — and two describe a GDACS
   * `WILDFIRE_EVENT`, an official burnt-area event, which is a different thing from a pixel and
   * which `lexicon.ts`'s own docstring permits the word for. Nothing else.
   */
  const WILDFIRE_SENTENCES: readonly string[] = [
    THERMAL_DETECTION_CAVEAT,
    'GDACS has published a wildfire event for this area.',
    'An official GDACS wildfire alert area covers this location within 10 km.',
    'This location has been detected repeatedly over a long period, which is characteristic of a gas flare or industrial heat source rather than a wildfire.',
  ];

  const everyText = (): string[] => [
    ...textsOf(assessFire(fire())),
    // Each distance basis writes its own sentence.
    ...textsOf(assessFire(fire({ distanceBasis: 'CLUSTER_AREA' }))),
    ...textsOf(assessFire(fire({ nearestDetectionKm: 0, distanceBasis: 'CLUSTER_AREA' }))),
    ...textsOf(assessFire(fire({ nearestDetectionKm: 0.4, distanceBasis: 'CLUSTER_AREA' }))),
    ...textsOf(assessFire(fire({ distanceBasis: 'CLUSTER_CENTRE' }))),
    // Singular, no FRP, growth, a related GDACS event, the flare cap, an official alert area.
    ...textsOf(assessFire(fire({ n24h: 1, overpasses24h: 1 }))),
    ...textsOf(assessFire(fire({ frpSum24h: null }))),
    ...textsOf(assessFire(fire({ n24h: 20, nPrevious24h: 4 }))),
    ...textsOf(assessFire(fire({ relatedGdacsEventId: 'WF:1023' }))),
    ...textsOf(assessFire(fire({ persistentHeatSource: true }))),
    ...textsOf(assessFire(fire({ officialAlertNearby: true }))),
    ...textsOf(assessFire(fire({ state: 'COOLING', hoursSinceLastDetection: 40 }))),
    // Both halves of the staleness sentence (QA round 2, M-2).
    ...textsOf(assessFire(fire({ nearestDetectionKm: 1, summaryAgeHours: 8 }))),
    ...textsOf(assessFire(fire({ nearestDetectionKm: 1, summaryAgeHours: null }))),
  ];

  it('is clean for every reason and caveat, in thermal context', () => {
    const all = everyText();
    // The mandated caveat is among them, so the allowance below is exercised, not assumed.
    expect(all).toContain(THERMAL_DETECTION_CAVEAT);
    for (const text of all) {
      if (WILDFIRE_SENTENCES.includes(text)) continue;
      expect(scanLexicon(text, { thermalContext: true }), text).toStrictEqual([]);
    }
  });

  it('puts the word "wildfire" only in the sentences the rules allow', () => {
    const offending = everyText().filter(
      (text) =>
        scanLexicon(text, { thermalContext: true }).some(
          (hit) => hit.lexiconClass === 'THERMAL_AS_WILDFIRE',
        ) && !WILDFIRE_SENTENCES.includes(text),
    );
    expect(offending).toStrictEqual([]);
    // And the allowance is a list of sentences, not of substrings: a quote cannot excuse this
    // class, so a newly composed sentence around the same words is still a failure.
    expect(
      isLexiconClean('The wildfire is 5 km from this location.', {
        thermalContext: true,
        verbatimQuotes: WILDFIRE_SENTENCES,
      }),
    ).toBe(false);
  });

  it('keeps every sentence clean outside thermal context too', () => {
    // Everything but the wildfire class, which is the only one that depends on the subject.
    for (const text of everyText()) {
      expect(scanLexicon(text), text).toStrictEqual([]);
    }
  });
});

describe('relevance copy: the GDACS families', () => {
  function flood(overrides: Partial<FloodInput> = {}): FloodInput {
    return {
      alertLevel: 'Orange',
      insideArea: true,
      distanceToAreaKm: 0,
      centroidDistanceKm: 30,
      hasAreaGeometry: true,
      ...overrides,
    };
  }

  function cyclone(overrides: Partial<CycloneInput> = {}): CycloneInput {
    return {
      alertLevel: 'Orange',
      insideWind120: true,
      insideWind90: true,
      insideWind60: true,
      insideUncertaintyCone: true,
      trackDistanceKm: 40,
      isForecastGeometry: false,
      forecastIssuedAt: null,
      forecastAgency: 'JTWC via GDACS',
      ...overrides,
    };
  }

  function volcano(overrides: Partial<VolcanoInput> = {}): VolcanoInput {
    return { alertLevel: 'Orange', distanceKm: 40, alertTextVerbatim: null, ...overrides };
  }

  it('is clean for every flood branch, including the mandated caveat', () => {
    const all = [
      ...textsOf(assessFlood(flood())),
      ...textsOf(assessFlood(flood({ insideArea: false, distanceToAreaKm: 8 }))),
      ...textsOf(
        assessFlood(flood({ hasAreaGeometry: false, distanceToAreaKm: null, insideArea: false })),
      ),
      ...textsOf(
        assessFlood(
          flood({
            hasAreaGeometry: false,
            distanceToAreaKm: null,
            insideArea: false,
            centroidDistanceKm: 300,
          }),
        ),
      ),
    ];
    expect(all).toContain(FLOOD_MODELLED_AREA_CAVEAT);
    expectClean(all, {});
  });

  it('is clean for every cyclone branch, forecast and observed', () => {
    /*
     * The family where §11.4's own exemption exists, because a cyclone track *is* a forecast. The
     * model's own wording still has to pass unaided — GeoNerva composed it — and it does: it says
     * "this is a forecast position, issued …, from …" and attributes it, rather than saying what
     * the storm will do.
     */
    const all = [
      ...textsOf(assessCyclone(cyclone())),
      ...textsOf(assessCyclone(cyclone({ insideWind120: false }))),
      ...textsOf(assessCyclone(cyclone({ insideWind120: false, insideWind90: false }))),
      ...textsOf(
        assessCyclone(cyclone({ insideWind120: false, insideWind90: false, insideWind60: false })),
      ),
      ...textsOf(
        assessCyclone(
          cyclone({
            insideWind120: false,
            insideWind90: false,
            insideWind60: false,
            insideUncertaintyCone: false,
          }),
        ),
      ),
      ...textsOf(
        assessCyclone(
          cyclone({
            isForecastGeometry: true,
            forecastIssuedAt: '2026-09-22T06:00:00.000Z',
          }),
        ),
      ),
      ...textsOf(assessCyclone(cyclone({ isForecastGeometry: true, forecastAgency: null }))),
    ];
    expectClean(all, {});
  });

  it('is clean for volcanoes, and relays a provider statement without composing one', () => {
    expectClean(
      [
        ...textsOf(assessVolcano(volcano())),
        ...textsOf(assessVolcano(volcano({ distanceKm: 250 }))),
      ],
      {},
    );

    /*
     * `PROVIDER_STATEMENT` is GDACS's own wording, passed through untouched. Forecast language in
     * it is §11.4's documented exemption, and this is the one place in `relevance` where the
     * exemption is load-bearing rather than decorative.
     */
    const official = 'Ash emission is expected to hit flight levels within 24 hours.';
    const relayed = textsOf(assessVolcano(volcano({ alertTextVerbatim: official })));
    expect(relayed).toContain(official);
    expectClean(relayed, { verbatimQuotes: [official] });
    // Without the quote it is a hit, so the relay is what excuses it and not the sentence itself.
    expect(isLexiconClean(official)).toBe(false);
    // And a safety claim in a provider's words is still refused: that class is never exemptible.
    expect(
      isLexiconClean('The area around the volcano is safe.', {
        verbatimQuotes: ['The area around the volcano is safe.'],
      }),
    ).toBe(false);
  });
});

describe('change copy: every title the classifier can write', () => {
  const FROM = new Date('2026-09-20T00:00:00.000Z');
  const TO = new Date('2026-09-21T00:00:00.000Z');
  const FAMILIES: readonly HazardFamily[] = [
    'EARTHQUAKES',
    'FIRE_ACTIVITY',
    'FLOODS',
    'CYCLONES',
    'WEATHER_ALERTS',
    'OTHER',
  ];

  function subject(overrides: Partial<SubjectSummary> = {}): SubjectSummary {
    return {
      subjectRef: 'CE:EQ-26-AAAAAA',
      hazardType: 'EARTHQUAKE',
      family: 'EARTHQUAKES',
      publicId: 'EQ-26-AAAAAA',
      title: 'M5.4 earthquake',
      observedAt: '2026-09-20T18:00:00.000Z',
      lifecycleStatus: 'ACTIVE',
      providerSeverity: null,
      distanceKm: 20,
      hypocentralDistanceKm: 22,
      facts: [
        {
          code: 'MAGNITUDE',
          label: 'Magnitude',
          value: { kind: 'number', value: 5.4, unit: null, decimals: 1 },
          evidenceIds: ['EV:OBS:1'],
        },
      ],
      relevance: {
        level: 'MODERATE',
        reasons: [],
        authoritativeBasis: null,
        caveats: [],
        evidenceIds: ['EV:OBS:1'],
        modelVersion: 'eq-1',
      },
      agreement: null,
      evidenceIds: ['EV:OBS:1'],
      href: '/event/EQ-26-AAAAAA',
      ...overrides,
    };
  }

  function card(overrides: Partial<FamilyCard> = {}): FamilyCard {
    return {
      family: 'EARTHQUAKES',
      availability: 'AVAILABLE',
      coverage: { level: 'COVERED', note: null },
      items: [],
      truncated: false,
      itemsTotal: 0,
      metrics: [],
      dataConfidence: {
        level: 'MEDIUM',
        reasons: [
          {
            code: 'DERIVATION_LAGGING',
            text: 'GeoNerva has the underlying data but has not finished processing it, so it cannot report on them yet.',
            params: {},
            evidenceIds: [],
          },
        ],
      },
      sourceHealth: [],
      caveats: [],
      ...overrides,
    };
  }

  function snapshot(family: HazardFamily, overrides: Partial<FamilyCard>): LocationSnapshotView {
    const families = {} as Record<HazardFamily, FamilyCard>;
    for (const each of FAMILIES) families[each] = card({ family: each });
    families[family] = card({ family, ...overrides });
    return {
      asOf: TO.toISOString(),
      engineVersion: 'eng-1',
      generatedAt: TO.toISOString(),
      sourceHealth: [],
      families,
      overall: {
        headlineCode: 'NO_HIGH_RELEVANCE_ITEMS',
        headlineRelevance: null,
        headlineText: 'Nothing here currently needs your attention.',
        coverageStatement: 'All hazard types GeoNerva tracks are covered here.',
        unavailableFamilies: [],
        notCoveredFamilies: [],
        reasons: [],
        evidenceIds: [],
      },
      contentSha256: 'a'.repeat(64),
    };
  }

  it('is clean for all fifteen change types, reachable or not', () => {
    /*
     * Driven through `changeTitleFor` rather than through `diffSnapshots`, because the
     * `ACTIVITY_*` types have their wording written and no way to produce it yet — which makes
     * them precisely the rows a scan must not skip. The subject title is the neutral one a real
     * card carries; the words being scanned are the engine's suffixes.
     */
    const item = subject();
    const titles = CHANGE_TYPES.map((type) => changeTitleFor(type, item));
    expect(titles).toHaveLength(15);
    expectClean(titles, { thermalContext: true });
  });

  it('is clean for the titles, details and facet labels of a real diff', () => {
    const quiet = diffSnapshots(
      snapshot('FIRE_ACTIVITY', { availability: 'AVAILABLE', items: [subject()] }),
      snapshot('FIRE_ACTIVITY', { availability: 'UNAVAILABLE', items: [] }),
      { fromAsOf: FROM, toAsOf: TO },
    );
    const recovered = diffSnapshots(
      snapshot('FIRE_ACTIVITY', { availability: 'UNAVAILABLE', items: [] }),
      snapshot('FIRE_ACTIVITY', { availability: 'AVAILABLE', items: [subject()] }),
      { fromAsOf: FROM, toAsOf: TO },
    );
    const revised = diffSnapshots(
      snapshot('EARTHQUAKES', { availability: 'AVAILABLE', items: [subject()] }),
      snapshot('EARTHQUAKES', {
        availability: 'AVAILABLE',
        items: [
          subject({
            facts: [
              {
                code: 'MAGNITUDE',
                label: 'Magnitude',
                value: { kind: 'number', value: 6.1, unit: null, decimals: 1 },
                evidenceIds: ['EV:OBS:2'],
              },
            ],
            relevance: {
              level: 'HIGH',
              reasons: [],
              authoritativeBasis: null,
              caveats: [],
              evidenceIds: ['EV:OBS:2'],
              modelVersion: 'eq-1',
            },
          }),
        ],
      }),
      { fromAsOf: FROM, toAsOf: TO },
    );

    const texts = [quiet, recovered, revised].flatMap((result) =>
      result.all.flatMap((signal) => [
        signal.title,
        ...(signal.detail === null ? [] : [signal.detail]),
        ...signal.facets.map((facet) => facet.label),
      ]),
    );
    // The family-availability titles and the outage detail are in here, so this is not an
    // assertion about an empty list.
    expect(texts).toContain('GeoNerva can no longer report on fire activity here');
    expect(texts).toContain('GeoNerva can report on fire activity here again');
    expectClean(texts, { thermalContext: true });
  });
});
