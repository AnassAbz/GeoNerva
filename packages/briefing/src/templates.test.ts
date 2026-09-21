/**
 * Deterministic copy, and the sentence it must never write.
 *
 * `AI_MODE=disabled` is the default, so this is the product's language rather than a degraded
 * path. The tests are organised around the four distinctions the availability model works to keep
 * apart, because prose is where they are easiest to collapse — and around one prohibition that is
 * checked mechanically over every state rather than argued about per sentence.
 */

import { describe, expect, it } from 'vitest';

import {
  HAZARD_FAMILIES,
  type FamilyCard,
  type HazardFamily,
  type LocationRef,
  type LocationSnapshotView,
  type SubjectSummary,
} from '@geonerva/domain';

import {
  EXEMPTIBLE_CLASSES,
  LEXICON_CLASSES,
  buildCopy,
  scanLexicon,
  type CopyInput,
} from './index.ts';

const MARRAKECH: LocationRef = {
  key: 'p:2542997',
  label: 'Marrakech',
  lat: 31.63,
  lon: -7.98,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
};

const NO_CHANGES: CopyInput['changes'] = { headline: [], listedCount: 0, suppressedCount: 0 };

function card(family: HazardFamily, overrides: Partial<FamilyCard> = {}): FamilyCard {
  return {
    family,
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
          code: 'AVAILABILITY_NOTHING_TO_REPORT',
          text: 'No earthquakes to report here.',
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
    facts: [],
    relevance: {
      level: 'MODERATE',
      reasons: [],
      authoritativeBasis: null,
      caveats: [],
      evidenceIds: [],
      modelVersion: 'eq-1',
    },
    agreement: null,
    evidenceIds: ['EV:OBS:1'],
    href: '/events/EQ-26-AAAAAA',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<Record<HazardFamily, Partial<FamilyCard>>> = {},
  overall: Partial<LocationSnapshotView['overall']> = {},
): LocationSnapshotView {
  const families = {} as Record<HazardFamily, FamilyCard>;
  for (const family of HAZARD_FAMILIES) {
    families[family] = card(family, overrides[family] ?? {});
  }
  return {
    asOf: '2026-09-21T00:00:00.000Z',
    engineVersion: 'eng-1',
    generatedAt: '2026-09-21T00:00:05.000Z',
    sourceHealth: [],
    families,
    overall: {
      headlineCode: 'NO_HIGH_RELEVANCE_ITEMS',
      headlineRelevance: null,
      headlineText: 'Nothing here currently needs your attention.',
      coverageStatement: 'All covered.',
      unavailableFamilies: [],
      notCoveredFamilies: [],
      reasons: [],
      evidenceIds: [],
      ...overall,
    },
    contentSha256: 'a'.repeat(64),
  };
}

const copyFor = (snap: LocationSnapshotView, changes: CopyInput['changes'] = NO_CHANGES) =>
  buildCopy({ location: MARRAKECH, snapshot: snap, window: '24h', changes });

/** Every sentence in a copy block, for the whole-output checks. */
function allText(copy: ReturnType<typeof buildCopy>): string {
  return [
    copy.headline,
    ...copy.summary,
    ...Object.values(copy.byFamily).flat(),
    ...copy.caveats,
  ].join(' ');
}

describe('"nothing found" is never "you are safe"', () => {
  it('describes a quiet location as what GeoNerva checked, not as a safe place', () => {
    /*
     * The sentence this module exists to never write. "No relevant hazards were found" is a
     * statement about GeoNerva's data; "you are safe" is a statement about the world, and a reader
     * acts on the second.
     */
    const copy = copyFor(snapshot());
    expect(copy.headline).toBe(
      'Nothing GeoNerva is tracking near Marrakech currently needs your attention.',
    );
    expect(copy.summary.join(' ')).toContain('sources GeoNerva checked reported nothing relevant');
    expect(scanLexicon(allText(copy))).toEqual([]);
  });

  it('is free of prohibited language in every state the snapshot can be in', () => {
    /*
     * Checked mechanically across the state space rather than argued sentence by sentence, and
     * with the *same* scanner that gates model output — so the templates cannot drift into
     * language the AI layer would be rejected for.
     */
    const states: LocationSnapshotView[] = [
      snapshot(),
      snapshot({ EARTHQUAKES: { items: [subject()], itemsTotal: 1 } }),
      snapshot(
        { EARTHQUAKES: { availability: 'UNAVAILABLE' } },
        { headlineCode: 'DATA_UNAVAILABLE', unavailableFamilies: ['EARTHQUAKES'] },
      ),
      snapshot(
        {
          WEATHER_ALERTS: {
            availability: 'NOT_COVERED',
            coverage: { level: 'NOT_COVERED', note: 'No source.' },
          },
        },
        { notCoveredFamilies: ['WEATHER_ALERTS'] },
      ),
      snapshot(
        {
          EARTHQUAKES: {
            items: [subject({ relevance: { ...subject().relevance, level: 'HIGH' } })],
            itemsTotal: 1,
          },
        },
        { headlineCode: 'HIGH_RELEVANCE_PRESENT', headlineRelevance: 'HIGH' },
      ),
      snapshot(
        {},
        { headlineCode: 'OFFICIAL_ALERT_AFFECTING_AREA', headlineRelevance: 'CRITICAL' },
      ),
    ];

    for (const state of states) {
      const hits = scanLexicon(allText(copyFor(state)));
      expect(hits, `state produced: ${JSON.stringify(hits)}`).toEqual([]);
    }
  });

  it('does not call a thermal detection a wildfire', () => {
    // §9.2: VIIRS detects heat, not fire, and the caveat on the same card says so.
    const thermal = subject({
      hazardType: 'THERMAL_ACTIVITY',
      family: 'FIRE_ACTIVITY',
      subjectRef: 'FC:FR-26-AAAAAA',
      publicId: 'FR-26-AAAAAA',
      title: 'Fire activity',
      relevance: {
        ...subject().relevance,
        caveats: ['Satellite thermal detections are not confirmed wildfires.'],
      },
    });
    const copy = copyFor(snapshot({ FIRE_ACTIVITY: { items: [thermal], itemsTotal: 1 } }));

    /*
     * The *caveat* contains the word, which is correct and required — it is the sentence that says
     * a detection is not a wildfire. What must not appear is GeoNerva describing the subject as
     * one, so the check excludes the mandated caveat and scans everything else.
     */
    const withoutCaveats = [copy.headline, ...copy.summary, ...copy.byFamily.FIRE_ACTIVITY]
      .filter((sentence) => !sentence.includes('not confirmed wildfires'))
      .join(' ');
    expect(scanLexicon(withoutCaveats, { thermalContext: true })).toEqual([]);
  });
});

describe('the four distinctions survive into prose', () => {
  it('says GeoNerva cannot tell, and names the family, when a source is unavailable', () => {
    const copy = copyFor(
      snapshot(
        { EARTHQUAKES: { availability: 'UNAVAILABLE' } },
        { headlineCode: 'DATA_UNAVAILABLE', unavailableFamilies: ['EARTHQUAKES'] },
      ),
    );
    expect(copy.headline).toContain('cannot currently report on earthquakes');
    expect(copy.summary[0]).toContain('unknown rather than as quiet');
  });

  it('puts the qualification before the reassurance', () => {
    /*
     * A reader who stops after one sentence must have been told about the outage. Telling them
     * things look quiet first and mentioning the dead feed three sentences later is how a true
     * briefing reads as a false one.
     */
    const copy = copyFor(
      snapshot(
        { FLOODS: { availability: 'UNAVAILABLE' } },
        { headlineCode: 'DATA_UNAVAILABLE', unavailableFamilies: ['FLOODS'] },
      ),
    );
    expect(copy.summary[0]).toContain('cannot describe floods');
  });

  it('distinguishes not-covered from nothing-found', () => {
    const copy = copyFor(
      snapshot(
        {
          WEATHER_ALERTS: {
            availability: 'NOT_COVERED',
            coverage: {
              level: 'NOT_COVERED',
              note: 'GeoNerva has no source for weather warnings.',
            },
          },
        },
        { notCoveredFamilies: ['WEATHER_ALERTS'] },
      ),
    );
    expect(copy.byFamily.WEATHER_ALERTS[0]).toBe('GeoNerva has no source for weather warnings.');
    expect(copy.summary.join(' ')).toContain('would not have seen');
  });

  it('carries a partial-coverage caveat rather than silently qualifying the count', () => {
    const note = 'Earthquake coverage here is complete only from about M4.5.';
    const copy = copyFor(
      snapshot({
        EARTHQUAKES: {
          coverage: { level: 'PARTIAL', note },
          caveats: [note],
          items: [subject()],
          itemsTotal: 1,
        },
      }),
    );
    expect(copy.caveats).toContain(note);
    expect(copy.byFamily.EARTHQUAKES).toContain(note);
  });

  it('uses the card’s own reason for an unavailable family, not a generic apology', () => {
    /*
     * Four different situations produce `UNAVAILABLE` — an outage, a source that never succeeded,
     * an un-run derivation, and a knowledge time past the retention horizon. The availability
     * model already wrote the sentence that tells them apart; rewriting it here would flatten all
     * four into one.
     */
    const text = 'GeoNerva has the underlying data but has not finished processing it.';
    const copy = copyFor(
      snapshot({
        FIRE_ACTIVITY: {
          availability: 'UNAVAILABLE',
          dataConfidence: {
            level: 'LOW',
            reasons: [
              { code: 'AVAILABILITY_DERIVATION_NOT_RUN', text, params: {}, evidenceIds: [] },
            ],
          },
        },
      }),
    );
    expect(copy.byFamily.FIRE_ACTIVITY).toEqual([text]);
  });
});

describe('the change sentence', () => {
  it('states the suppressed count rather than hiding the filtering', () => {
    const copy = copyFor(snapshot(), { headline: [], listedCount: 0, suppressedCount: 4 });
    expect(copy.summary.at(-1)).toBe(
      'Nothing meaningful changed in the last 24 hours; 4 minor changes were filtered out.',
    );
  });

  it('says nothing changed plainly when nothing was filtered either', () => {
    expect(copyFor(snapshot()).summary.at(-1)).toBe(
      'Nothing meaningful changed in the last 24 hours.',
    );
  });

  it('leads with the most important change and counts the rest', () => {
    const copy = copyFor(snapshot(), {
      headline: [{ title: 'M5.4 earthquake', detail: null }],
      listedCount: 2,
      suppressedCount: 1,
    });
    expect(copy.summary.at(-1)).toBe('M5.4 earthquake, and 2 other changes in the last 24 hours.');
  });

  it('uses the singular for one other change', () => {
    const copy = copyFor(snapshot(), {
      headline: [{ title: 'M5.4 earthquake', detail: null }],
      listedCount: 1,
      suppressedCount: 0,
    });
    expect(copy.summary.at(-1)).toContain('1 other change in');
  });
});

describe('determinism', () => {
  it('produces identical copy for the same snapshot', () => {
    const snap = snapshot({ EARTHQUAKES: { items: [subject()], itemsTotal: 1 } });
    expect(copyFor(snap)).toEqual(copyFor(snap));
  });

  it('orders caveats stably regardless of which family contributed them', () => {
    const snap = snapshot({
      EARTHQUAKES: { caveats: ['Zebra caveat.', 'Alpha caveat.'] },
      FLOODS: { caveats: ['Middle caveat.'] },
    });
    expect(copyFor(snap).caveats).toEqual(['Alpha caveat.', 'Middle caveat.', 'Zebra caveat.']);
  });

  it('covers every family, so a card can never be missing its copy', () => {
    const copy = copyFor(snapshot());
    for (const family of HAZARD_FAMILIES) {
      expect(copy.byFamily[family].length).toBeGreaterThan(0);
    }
  });
});

describe('the lexicon scanner itself', () => {
  it('catches every class it defines', () => {
    const samples: Readonly<Record<string, string>> = {
      PREDICTION: 'A larger quake will occur here soon.',
      SAFETY: 'You are safe in this area.',
      THERMAL_AS_WILDFIRE: 'A wildfire is burning nearby.',
      REAL_TIME: 'This is a real-time view.',
    };
    for (const lexiconClass of LEXICON_CLASSES) {
      const text = samples[lexiconClass] ?? '';
      const hits = scanLexicon(text, { thermalContext: true });
      expect(hits.map((hit) => hit.lexiconClass)).toContain(lexiconClass);
    }
  });

  it('allows "wildfire" outside a thermal context', () => {
    // A GDACS burnt-area event is an official wildfire event; the word is correct there.
    expect(scanLexicon('An official wildfire event is active.')).toEqual([]);
    expect(
      scanLexicon('An official wildfire event is active.', { thermalContext: true }),
    ).toHaveLength(1);
  });

  it('allows prediction wording only inside relayed verbatim text', () => {
    /*
     * §11.4's exemption. A cyclone track *is* a forecast, and refusing to relay the issuing
     * agency's words would suppress the most actionable thing on the card — but the exemption is
     * by exact substring of a supplied quote, so the same words written by GeoNerva are still
     * rejected.
     */
    const quote = 'the centre is expected to hit the coast on Tuesday';
    expect(scanLexicon(`JTWC says: "${quote}".`, { verbatimQuotes: [quote] })).toEqual([]);
    expect(scanLexicon('The centre is expected to hit the coast on Tuesday.')).toHaveLength(1);
  });

  it('never lets a quote excuse a safety claim, however it is worded', () => {
    /*
     * The narrowing that matters. `verbatimQuotes` is assembled from database columns — coverage
     * notes and disclaimers — and if such a column were ever populated from a provider feed, a
     * broad exemption would let a string a provider controls license "you are safe" in generated
     * text. No caveat, disclaimer or forecast has a legitimate need to assert the reader's safety,
     * so `SAFETY` is not exemptible at all.
     */
    const hostile = 'According to the bulletin, you are safe and there is no danger here.';
    expect(
      scanLexicon(hostile, { verbatimQuotes: [hostile] }).map((hit) => hit.lexiconClass),
    ).toEqual(['SAFETY', 'SAFETY']);
    expect(EXEMPTIBLE_CLASSES.has('SAFETY')).toBe(false);
    expect(EXEMPTIBLE_CLASSES.has('THERMAL_AS_WILDFIRE')).toBe(false);
  });

  it('never lets a quote excuse calling a thermal detection a wildfire', () => {
    // A category error regardless of authorship: VIIRS detects heat, not fire.
    const quote = 'A wildfire is burning in the area.';
    expect(scanLexicon(quote, { verbatimQuotes: [quote], thermalContext: true })).toHaveLength(1);
  });

  it('allows a provider caveat that denies a real-time promise', () => {
    /*
     * A real provider forced this. FIRMS's own coverage note reads "Near-real-time detections
     * arrive about three hours after the satellite overpass" — a sentence that *denies* real-time
     * and is the provider's wording. Scanning it as though GeoNerva had written "real-time" would
     * make the honest caveat unsayable and push the code toward paraphrasing someone else's
     * limitation.
     */
    const note =
      'Global. Near-real-time detections arrive about three hours after the satellite overpass.';
    expect(scanLexicon(note)).toHaveLength(1);
    expect(scanLexicon(note, { verbatimQuotes: [note] })).toEqual([]);
    // And it still cannot launder GeoNerva's own sentence.
    expect(
      scanLexicon('GeoNerva gives you a real-time view.', { verbatimQuotes: [note] }),
    ).toHaveLength(1);
  });

  it('is not fooled by a typographic apostrophe or by spacing', () => {
    expect(scanLexicon('There’s nothing to worry about.')).toHaveLength(1);
    expect(scanLexicon('This  is   a  real   time  view.')).toHaveLength(1);
  });

  it('reports hits in document order', () => {
    const hits = scanLexicon('You are safe, and nothing will occur.');
    expect(hits.map((hit) => hit.lexiconClass)).toEqual(['SAFETY', 'PREDICTION']);
  });
});
