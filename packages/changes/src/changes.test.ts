/**
 * The snapshot diff.
 *
 * The tests that matter are the ones where a wrong answer is *reassuring*. A change engine that
 * reports an outage as a page of resolved hazards, or a three-day-old earthquake as new, is worse
 * than one that reports nothing — so those cases come first and the threshold arithmetic second.
 */

import { describe, expect, it } from 'vitest';

import type {
  FamilyCard,
  HazardFamily,
  LocationSnapshotView,
  SubjectSummary,
} from '@geonerva/domain';

import {
  IMPORTANCE_BASE,
  LEVEL_WEIGHT,
  MATERIALITY,
  MAX_HEADLINE,
  RECENCY_WEIGHT,
  diffSnapshots,
} from './index.ts';

const FROM = new Date('2026-09-20T00:00:00.000Z');
const TO = new Date('2026-09-21T00:00:00.000Z');
const WINDOW = { fromAsOf: FROM, toAsOf: TO };

const FAMILIES: readonly HazardFamily[] = [
  'EARTHQUAKES',
  'FIRE_ACTIVITY',
  'FLOODS',
  'CYCLONES',
  'WEATHER_ALERTS',
  'OTHER',
];

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
        { code: 'AVAILABILITY_OK', text: 'Reporting earthquakes.', params: {}, evidenceIds: [] },
      ],
    },
    sourceHealth: [],
    caveats: [],
    ...overrides,
  };
}

function subject(overrides: Partial<SubjectSummary> = {}): SubjectSummary {
  const magnitude = 5.4;
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
        value: { kind: 'number', value: magnitude, unit: null, decimals: 1 },
        evidenceIds: ['EV:OBS:1'],
      },
      {
        code: 'DEPTH',
        label: 'Depth',
        value: { kind: 'number', value: 10, unit: 'km', decimals: 0 },
        evidenceIds: ['EV:OBS:1'],
      },
    ],
    relevance: {
      level: 'MODERATE',
      reasons: [{ code: 'BAND', text: 'M5.4 at 20 km.', params: {}, evidenceIds: ['EV:OBS:1'] }],
      authoritativeBasis: null,
      caveats: [],
      evidenceIds: ['EV:OBS:1'],
      modelVersion: 'eq-1',
    },
    agreement: null,
    evidenceIds: ['EV:OBS:1', 'EV:COR:1'],
    href: '/event/EQ-26-AAAAAA',
    ...overrides,
  };
}

/** A snapshot with one family overridden and every other family available and empty. */
function snapshot(
  family: HazardFamily,
  overrides: Partial<FamilyCard>,
  engineVersion = 'eng-1',
): LocationSnapshotView {
  const families = {} as Record<HazardFamily, FamilyCard>;
  for (const each of FAMILIES) families[each] = card({ family: each });
  families[family] = card({ family, ...overrides });

  return {
    asOf: TO.toISOString(),
    engineVersion,
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

describe('an outage is never reported as good news', () => {
  it('does not resolve the items of a family that became unavailable', () => {
    /*
     * The worst output this engine could produce. When availability drops, `items` is empty by
     * invariant I11 — not because the hazards ended. Emitting `EVENT_RESOLVED` for each of them
     * would turn a source outage into a page full of resolved hazards.
     */
    const before = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });
    const after = snapshot('EARTHQUAKES', {
      availability: 'UNAVAILABLE',
      items: [],
      itemsTotal: 0,
    });

    const result = diffSnapshots(before, after, WINDOW);
    expect(result.all.map((signal) => signal.type)).not.toContain('EVENT_RESOLVED');
    expect(result.all.map((signal) => signal.type)).toContain('SOURCE_STALE');
  });

  it('makes an outage a HEADLINE when the family had a HIGH item', () => {
    /*
     * §10.4's hard rule. Losing sight of a family that was showing something serious is the most
     * important thing on the page, not a footnote — the user was relying on it a moment ago.
     */
    const before = snapshot('EARTHQUAKES', {
      items: [subject({ relevance: { ...subject().relevance, level: 'HIGH' } })],
      itemsTotal: 1,
    });
    const after = snapshot('EARTHQUAKES', { availability: 'UNAVAILABLE' });

    const [signal] = diffSnapshots(before, after, WINDOW).headline;
    expect(signal?.type).toBe('SOURCE_STALE');
    expect(signal?.importance).toBe(IMPORTANCE_BASE.SOURCE_STALE + LEVEL_WEIGHT.HIGH);
  });

  it('reports a new hazard that arrived while the family was unavailable', () => {
    /*
     * The change a briefing most needs to carry, and the one the first version of this engine
     * dropped. Both sides had to be AVAILABLE for any per-subject signal, so a family that was
     * UNAVAILABLE at the earlier knowledge time — common, since a source goes STALE an hour after
     * its last success — produced only SOURCE_RECOVERED on recovery. A new CRITICAL flood arriving
     * in that window was invisible to the diff, the copy and the AI packet, and the change section
     * read as pure good news.
     */
    const critical = subject({
      family: 'FLOODS',
      title: 'Flood',
      relevance: { ...subject().relevance, level: 'CRITICAL' },
    });
    const result = diffSnapshots(
      snapshot('FLOODS', { availability: 'UNAVAILABLE' }),
      snapshot('FLOODS', { items: [critical], itemsTotal: 1 }),
      WINDOW,
    );

    const types = result.all.map((signal) => signal.type);
    expect(types).toContain('SOURCE_RECOVERED');
    expect(types).toContain('NEW_EVENT');
    // And the new CRITICAL hazard, not the recovery, is what leads the section.
    expect(result.headline[0]?.type).toBe('NEW_EVENT');

    /*
     * A recovery carries no prose detail. The card's reasons are present-tense descriptions of a
     * state, and `before`'s reason describes one that has just ended — "GeoNerva ... cannot report
     * on them yet" under a headline saying it can report again (QA round 2, M-4). The reason code
     * stays for whoever reads the signal rather than the sentence.
     */
    const recovered = result.all.find((signal) => signal.type === 'SOURCE_RECOVERED');
    expect(recovered?.title).toContain('again');
    expect(recovered?.detail).toBeNull();
  });

  it('claims no departures for a family it could not see before', () => {
    // Nothing can depart from a list that never existed.
    const result = diffSnapshots(
      snapshot('FLOODS', { availability: 'UNAVAILABLE' }),
      snapshot('FLOODS', {}),
      WINDOW,
    );
    expect(result.all.map((signal) => signal.type)).toEqual(['SOURCE_RECOVERED']);
  });

  it('reports recovery when a family becomes available again', () => {
    const before = snapshot('EARTHQUAKES', { availability: 'UNAVAILABLE' });
    const after = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });

    const types = diffSnapshots(before, after, WINDOW).all.map((signal) => signal.type);
    expect(types).toContain('SOURCE_RECOVERED');
  });

  it('says nothing about a family that was never covered and still is not', () => {
    // A configuration property that did not change is not a change.
    const before = snapshot('WEATHER_ALERTS', { availability: 'NOT_COVERED' });
    const after = snapshot('WEATHER_ALERTS', { availability: 'NOT_COVERED' });
    expect(diffSnapshots(before, after, WINDOW).all).toEqual([]);
  });
});

describe('a new subject', () => {
  it('is NEW_EVENT when it happened inside the window', () => {
    const before = snapshot('EARTHQUAKES', {});
    const after = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });

    const [signal] = diffSnapshots(before, after, WINDOW).all;
    expect(signal?.type).toBe('NEW_EVENT');
    expect(signal?.lateReport).toBe(false);
    expect(signal?.title).toBe('M5.4 earthquake');
  });

  it('is flagged as a late report when it happened before the window', () => {
    /*
     * §10.2's distinction. An event that *happened* three days ago but was only *reported* inside
     * the window is new knowledge, not a new event — and calling it "new" would misdate it.
     */
    const item = subject({ observedAt: '2026-09-17T12:00:00.000Z' });
    const before = snapshot('EARTHQUAKES', {});
    const after = snapshot('EARTHQUAKES', { items: [item], itemsTotal: 1 });

    const [signal] = diffSnapshots(before, after, WINDOW).all;
    expect(signal?.type).toBe('NEW_EVENT');
    expect(signal?.lateReport).toBe(true);
    expect(signal?.title).toContain('newly reported');
  });

  it('carries the evidence of the state it describes', () => {
    const before = snapshot('EARTHQUAKES', {});
    const after = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });
    const [signal] = diffSnapshots(before, after, WINDOW).all;
    expect(signal?.evidenceIds).toContain('EV:OBS:1');
    expect(signal?.evidenceIds).toContain('EV:COR:1');
  });
});

describe('a departed subject', () => {
  it('never claims a hazard ended just because it left the list', () => {
    /*
     * §10.2 defines EVENT_RESOLVED as a lifecycle transition — GDACS `iscurrent=false`, a cluster
     * going INACTIVE, an alert expiring — and a diff of two snapshots can see none of those. It can
     * only see that an item left the list, which also happens when the recency window slides past
     * it, when the display cap pushes it out, when it leaves the search radius, or when the
     * relevance model declines it.
     *
     * An earlier version of this engine asserted resolution for every family except earthquakes.
     * That test asserted the defect; this one asserts the rule.
     */
    for (const family of ['EARTHQUAKES', 'FLOODS', 'CYCLONES', 'OTHER'] as const) {
      const item = subject({
        subjectRef: `CE:XX-26-AAAAAA`,
        family,
        title: 'Hazard',
      });
      const [signal] = diffSnapshots(
        snapshot(family, { items: [item], itemsTotal: 1 }),
        snapshot(family, {}),
        WINDOW,
      ).all;

      expect(signal?.suppressionReason).toBe('AGED_OUT');
      expect(signal?.prominence).toBe('SUPPRESSED');
      expect(signal?.title).toContain('no longer listed');
      expect(signal?.title).not.toContain('no longer active');
      expect(signal?.detail).toContain('cannot tell');
    }
  });

  it('does not headline a CRITICAL subject that merely aged out of the window', () => {
    /*
     * The worst case of the old behaviour. A CRITICAL flood observed just inside the earlier
     * snapshot's window and just outside the later one's produced EVENT_RESOLVED, which §10.4's
     * hard rule promoted to HEADLINE — so the briefing's lead sentence announced that a flood
     * which was still active was over.
     */
    const critical = subject({
      family: 'FLOODS',
      title: 'Flood',
      relevance: { ...subject().relevance, level: 'CRITICAL' },
    });
    const result = diffSnapshots(
      snapshot('FLOODS', { items: [critical], itemsTotal: 1 }),
      snapshot('FLOODS', {}),
      WINDOW,
    );

    expect(result.headline).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
  });
});

describe('a revision', () => {
  const pair = (beforeItem: SubjectSummary, afterItem: SubjectSummary) =>
    diffSnapshots(
      snapshot('EARTHQUAKES', { items: [beforeItem], itemsTotal: 1 }),
      snapshot('EARTHQUAKES', { items: [afterItem], itemsTotal: 1 }),
      WINDOW,
    );

  function withMagnitude(value: number): SubjectSummary {
    const base = subject();
    return {
      ...base,
      facts: base.facts.map((fact) =>
        fact.code === 'MAGNITUDE'
          ? { ...fact, value: { kind: 'number', value, unit: null, decimals: 1 } }
          : fact,
      ),
    };
  }

  it('is EVENT_UPDATED at the materiality threshold, compared at the stored precision', () => {
    /*
     * §10.2 says "|ΔM| ≥ 0.2" and the boundary is inclusive. The pair is chosen so the float
     * subtraction lands *below* the threshold — `3.3 − 3.1` is 0.19999999999999973 — because that
     * is the direction that silently suppresses a real revision, and magnitudes are stored as
     * `numeric(_, 2)`, so the difference between these two stored values is exactly 0.2.
     *
     * 170 of the 581 magnitude pairs two hundredths apart in the M3.0–M8.8 range subtract to less
     * than 0.2 in IEEE-754, so this is not a curiosity at the edge of the range: without the
     * rounding, roughly a third of revisions that moved a magnitude by exactly the material amount
     * were reported as noise.
     */
    expect(Math.abs(3.3 - 3.1)).toBeLessThan(MATERIALITY.magnitude);

    const result = pair(withMagnitude(3.1), withMagnitude(3.3));
    const [signal] = result.all;
    expect(signal?.type).toBe('EVENT_UPDATED');
    expect(signal?.suppressionReason).toBeNull();
    expect(signal?.facets.map((facet) => facet.label)).toContain('Magnitude');
  });

  it('is suppressed as immaterial just below the threshold', () => {
    /*
     * Returned, not dropped: "show N minor changes" has to be an honest count, so a sub-threshold
     * revision is reported with the reason it was filtered.
     */
    const result = pair(withMagnitude(5.4), withMagnitude(5.5));
    const [signal] = result.all;
    expect(signal?.suppressionReason).toBe('IMMATERIAL');
    expect(result.suppressed).toHaveLength(1);
    expect(result.listed).toEqual([]);
  });

  it('produces no signal at all when nothing differs', () => {
    // A provider restamping a record without changing it is not a change GeoNerva believes in.
    expect(pair(subject(), subject()).all).toEqual([]);
  });

  it('names the most consequential change, not the first one detected', () => {
    /*
     * §10.3 groups; the type it reports drives the importance, so taking whichever change was
     * detected first would understate the group. Here the detection order is relevance (weight 15)
     * then conflict (weight 20), so the first and the most consequential differ.
     */
    const agreement = {
      level: 'AGREE' as const,
      nSources: 2,
      nIndependentSources: 2,
      reasons: [],
      comparisons: [],
    };
    const before = subject({ agreement, relevance: { ...subject().relevance, level: 'LOW' } });
    const after = subject({
      agreement: { ...agreement, level: 'CONFLICT' },
      relevance: { ...subject().relevance, level: 'MODERATE' },
    });

    const result = pair(before, after);
    expect(result.all).toHaveLength(1);
    expect(result.all[0]?.facets.map((facet) => facet.label).sort()).toEqual([
      'Relevance',
      'Source agreement',
    ]);
    expect(result.all[0]?.type).toBe('SOURCE_CONFLICT');
  });

  it('groups several changes about one subject into one signal', () => {
    /*
     * §10.3's grouping rule. A revision that also escalated the alert and raised the relevance is
     * one thing that happened, not three — and the signal's type is the most consequential of
     * them, because taking the least would understate an escalation.
     */
    const before = subject({
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
    });
    const after = subject({
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Red' },
      distanceKm: 5,
      relevance: { ...subject().relevance, level: 'HIGH' },
    });

    const result = pair(before, after);
    expect(result.all).toHaveLength(1);
    expect(result.all[0]?.type).toBe('EVENT_ESCALATED');
    expect(result.all[0]?.facets.map((facet) => facet.label).sort()).toEqual([
      'Alert level',
      'Distance',
      'Relevance',
    ]);
  });

  it('does not compare severities across schemes', () => {
    /*
     * GDACS `Orange` and PAGER `orange` are not the same statement. A scheme change is a
     * provenance change, and reporting it as an escalation would compare two scales — the one
     * thing `ProviderSeverity` exists to prevent.
     */
    const before = subject({ providerSeverity: { scheme: 'PAGER', value: 'green' } });
    const after = subject({ providerSeverity: { scheme: 'GDACS_ALERT', value: 'Red' } });

    const types = pair(before, after).all.map((signal) => signal.type);
    expect(types).not.toContain('EVENT_ESCALATED');
  });

  it('reports a new conflict between sources', () => {
    const agreement = {
      level: 'AGREE' as const,
      nSources: 2,
      nIndependentSources: 2,
      reasons: [],
      comparisons: [],
    };
    const before = subject({ agreement });
    const after = subject({ agreement: { ...agreement, level: 'CONFLICT' } });

    const [signal] = pair(before, after).all;
    expect(signal?.type).toBe('SOURCE_CONFLICT');
    expect(signal?.reasonCodes).toContain('SOURCES_DISAGREE');
  });
});

describe('prominence', () => {
  it('holds a subject that is LOW in both states to at most DETAIL', () => {
    /*
     * §10.4's hard rule. A routine revision to a distant small earthquake must not reach the top
     * of the page, however the arithmetic scored it.
     */
    const low = { ...subject().relevance, level: 'LOW' as const };
    const before = subject({
      relevance: low,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
    });
    /*
     * An escalation *and* a material distance move, so the arithmetic reaches LISTED on its own
     * (30 base + 0 level + 5 delta + 8 recency = 43, past the 40 band). Without the hard rule this
     * would sit in the main list; with it, it is DETAIL. A case that scored below 40 anyway would
     * pass whether or not the rule existed.
     */
    const after = subject({
      relevance: low,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Red' },
      distanceKm: subject().distanceKm + MATERIALITY.epicentreKm,
    });

    const [signal] = diffSnapshots(
      snapshot('EARTHQUAKES', { items: [before], itemsTotal: 1 }),
      snapshot('EARTHQUAKES', { items: [after], itemsTotal: 1 }),
      WINDOW,
    ).all;
    expect(signal?.type).toBe('EVENT_ESCALATED');
    expect(signal?.importance).toBeGreaterThanOrEqual(40);
    expect(signal?.prominence).toBe('DETAIL');
  });

  it('leaves a new HIGH event at LISTED, which is what the documented weights give', () => {
    /*
     * Worth pinning because it is mildly surprising, and because it is *derived* rather than
     * chosen: §10.4 gives `NEW_EVENT` a base of 25 and `HIGH` a level weight of 35, so the total
     * reaches at most 70 and only for an event at the very end of the window. HEADLINE is
     * therefore reserved for CRITICAL, escalations, and outages over a HIGH family — which is the
     * document's design, not this engine's opinion, and this test fails if either constant is
     * retuned without revisiting the bands.
     */
    const before = snapshot('EARTHQUAKES', {});
    const after = snapshot('EARTHQUAKES', {
      items: [subject({ relevance: { ...subject().relevance, level: 'HIGH' } })],
      itemsTotal: 1,
    });

    const [signal] = diffSnapshots(before, after, WINDOW).all;
    expect(signal?.importance).toBeLessThanOrEqual(
      IMPORTANCE_BASE.NEW_EVENT + LEVEL_WEIGHT.HIGH + RECENCY_WEIGHT.max,
    );
    expect(signal?.prominence).toBe('LISTED');
  });

  it('makes anything involving CRITICAL a HEADLINE, whatever it scored', () => {
    const critical = { ...subject().relevance, level: 'CRITICAL' as const };
    const before = subject();
    const after = subject({ relevance: critical });

    const [signal] = diffSnapshots(
      snapshot('EARTHQUAKES', { items: [before], itemsTotal: 1 }),
      snapshot('EARTHQUAKES', { items: [after], itemsTotal: 1 }),
      WINDOW,
    ).headline;
    expect(signal?.prominence).toBe('HEADLINE');
  });

  it('demotes past the headline cap rather than dropping', () => {
    /*
     * §10.4 caps headlines at three. A fourth headline-worthy change is still a real change, and
     * hiding it to keep the list tidy is the one thing this section cannot do.
     */
    const items = Array.from({ length: MAX_HEADLINE + 2 }, (_, index) =>
      subject({
        subjectRef: `CE:EQ-26-${String(index).padStart(6, 'A')}`,
        publicId: `EQ-26-${String(index).padStart(6, 'A')}`,
        relevance: { ...subject().relevance, level: 'CRITICAL' },
      }),
    );
    const result = diffSnapshots(
      snapshot('EARTHQUAKES', {}),
      snapshot('EARTHQUAKES', { items, itemsTotal: items.length }),
      WINDOW,
    );

    expect(result.headline).toHaveLength(MAX_HEADLINE);
    expect(result.headline.length + result.listed.length).toBe(items.length);
    expect(result.all).toHaveLength(items.length);
  });
});

describe('determinism', () => {
  it('produces the same result for the same pair of snapshots', () => {
    const before = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });
    const after = snapshot('EARTHQUAKES', {
      items: [subject({ relevance: { ...subject().relevance, level: 'HIGH' } })],
      itemsTotal: 1,
    });
    expect(diffSnapshots(before, after, WINDOW)).toEqual(diffSnapshots(before, after, WINDOW));
  });

  it('orders equally important signals totally, not by input order', () => {
    /*
     * Two identical-scoring signals must have one order, or the briefing's change list reorders
     * between two builds of the same snapshots — the same determinism the snapshot hash protects.
     */
    const a = subject({ subjectRef: 'CE:EQ-26-AAAAAA', publicId: 'EQ-26-AAAAAA' });
    const z = subject({ subjectRef: 'CE:EQ-26-ZZZZZZ', publicId: 'EQ-26-ZZZZZZ' });
    const forward = diffSnapshots(
      snapshot('EARTHQUAKES', {}),
      snapshot('EARTHQUAKES', { items: [a, z], itemsTotal: 2 }),
      WINDOW,
    );
    const reversed = diffSnapshots(
      snapshot('EARTHQUAKES', {}),
      snapshot('EARTHQUAKES', { items: [z, a], itemsTotal: 2 }),
      WINDOW,
    );
    expect(reversed.all.map((signal) => signal.subjectRef)).toEqual(
      forward.all.map((signal) => signal.subjectRef),
    );
  });

  it('refuses to diff snapshots from different engine versions', () => {
    /*
     * §4.14: snapshots of different engine versions are never diffed; the earlier one is
     * recomputed under the current engine. Comparing them would attribute a rule change to the
     * world.
     */
    const before = snapshot('EARTHQUAKES', {}, 'eng-1');
    const after = snapshot('EARTHQUAKES', {}, 'eng-2');
    expect(() => diffSnapshots(before, after, WINDOW)).toThrow(/different engine versions/);
  });

  it('reports nothing for two identical snapshots', () => {
    const only = snapshot('EARTHQUAKES', { items: [subject()], itemsTotal: 1 });
    expect(diffSnapshots(only, only, WINDOW).all).toEqual([]);
  });
});
