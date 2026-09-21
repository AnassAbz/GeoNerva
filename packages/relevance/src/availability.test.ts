/**
 * Availability, which is the rule that decides whether GeoNerva says "nothing is happening here"
 * or "we cannot tell you what is happening here".
 *
 * Every test in this file is a case where the two could be confused, because that confusion is
 * the product's worst failure mode: it converts an outage into reassurance, and it does so in a
 * sentence that looks identical to the true one.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveAvailability,
  resolveDataConfidence,
  highestRelevance,
  type DerivationStateInput,
  type SourceAvailabilityInput,
} from './index.ts';

const fresh = (sourceId: string, productId: number | null = 1): SourceAvailabilityInput => ({
  sourceId,
  productId,
  status: 'FRESH',
  hasEverSucceeded: true,
});
const withStatus = (
  sourceId: string,
  status: SourceAvailabilityInput['status'],
): SourceAvailabilityInput => ({ sourceId, productId: 1, status, hasEverSucceeded: true });
const neverRan = (sourceId: string): SourceAvailabilityInput => ({
  sourceId,
  productId: 1,
  status: 'UNAVAILABLE',
  hasEverSucceeded: false,
});

describe('an empty result decides nothing on its own', () => {
  it('reports a quiet, healthy, covered family as AVAILABLE with nothing to report', () => {
    // The only case where a zero may be shown: a working source looked and saw nothing.
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('usgs'), fresh('emsc')],
      itemCount: 0,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('NOTHING_TO_REPORT');
    expect(verdict.mayRenderZero).toBe(true);
  });

  it('reports the same empty result as UNAVAILABLE when the sources are stale', () => {
    /*
     * Identical `itemCount`, opposite meaning. This is the whole reason availability is not
     * `items.length === 0`: the query returns zero rows either way, and one of those zeros is an
     * observation while the other is an outage.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [withStatus('usgs', 'STALE'), withStatus('emsc', 'UNAVAILABLE')],
      itemCount: 0,
    });
    expect(verdict.availability).toBe('UNAVAILABLE');
    expect(verdict.reason).toBe('ALL_SOURCES_UNUSABLE');
    expect(verdict.mayRenderZero).toBe(false);
    expect(verdict.unusableSources).toStrictEqual(['usgs/1', 'emsc/1']);
  });

  it('reports the same empty result as NOT_COVERED where no source reaches', () => {
    /*
     * Weather warnings in Morocco. ECCC is Canada-only and NWS is US-only, so there is nothing to
     * be stale — and telling a user in Marrakech that "the weather-warning feed is down" would
     * describe a feed that was never going to cover them.
     */
    const verdict = resolveAvailability({ coverage: 'NOT_COVERED', sources: [], itemCount: 0 });
    expect(verdict.availability).toBe('NOT_COVERED');
    expect(verdict.reason).toBe('NOT_COVERED_HERE');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('distinguishes a source that broke from one that never worked', () => {
    // An outage and a misconfiguration need different sentences, and only one of them will fix
    // itself.
    expect(
      resolveAvailability({ coverage: 'COVERED', sources: [neverRan('firms')], itemCount: 0 })
        .reason,
    ).toBe('NEVER_SUCCEEDED');
    expect(
      resolveAvailability({
        coverage: 'COVERED',
        sources: [withStatus('firms', 'STALE')],
        itemCount: 0,
      }).reason,
    ).toBe('ALL_SOURCES_UNUSABLE');
  });
});

describe('coverage is checked before health', () => {
  it('prefers NOT_COVERED when the coverage table and the source list disagree', () => {
    /*
     * A coverage table claiming `COVERED` with no source configured is a misconfiguration, and
     * the stricter reading is the honest one. Showing "nothing is happening" on the strength of a
     * table nobody has checked against the source set is exactly the reassurance that must not be
     * manufactured.
     */
    const verdict = resolveAvailability({ coverage: 'COVERED', sources: [], itemCount: 0 });
    expect(verdict.availability).toBe('NOT_COVERED');
  });

  it('does not describe an uncovered family as stale', () => {
    const verdict = resolveAvailability({
      coverage: 'NOT_COVERED',
      sources: [withStatus('eccc', 'UNAVAILABLE')],
      itemCount: 0,
    });
    expect(verdict.availability).toBe('NOT_COVERED');
    expect(verdict.reason).toBe('NOT_COVERED_HERE');
  });
});

describe('DEGRADED is graded, not withheld', () => {
  it('still shows data when a source is merely late', () => {
    /*
     * `DEGRADED` means the last poll is older than the policy would like but inside its stale
     * threshold. Refusing to show a 20-minute-old earthquake catalogue because the next poll is a
     * few minutes late would make the product unusable for a reason nobody cares about — so it is
     * available, and the lateness is reported through confidence instead.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [withStatus('usgs', 'DEGRADED')],
      itemCount: 3,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.mayRenderZero).toBe(true);
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [withStatus('usgs', 'DEGRADED')],
        corroborated: false,
      }),
    ).toBe('MEDIUM');
  });
});

describe('a partial outage across several sources', () => {
  it('shows what the surviving source saw, and names the one that is missing', () => {
    /*
     * Two earthquake sources, one down. The survivor genuinely observed no earthquakes, so
     * refusing to say so would hide a real observation — and saying it without naming the missing
     * source would overstate it. Both: the count stands, and the caveat travels with it.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('usgs'), withStatus('emsc', 'STALE')],
      itemCount: 0,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('SOME_SOURCES_UNUSABLE');
    expect(verdict.mayRenderZero).toBe(true);
    expect(verdict.unusableSources).toStrictEqual(['emsc/1']);
  });
});

describe('partial coverage is its own axis', () => {
  it('stays AVAILABLE and says why the absence is qualified', () => {
    /*
     * "Earthquake coverage here is complete only from about M4.5." The family is available and
     * the data is real; what is incomplete is what an *absence* means, which is a different
     * statement from either "nothing happened" or "we cannot tell".
     */
    const verdict = resolveAvailability({
      coverage: 'PARTIAL',
      sources: [fresh('usgs')],
      itemCount: 0,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('PARTIAL_COVERAGE');
    expect(verdict.mayRenderZero).toBe(true);
  });

  it('grades partial coverage as LOW confidence even when every source is fresh', () => {
    // Because what is uncertain is not the recency of the data, it is the meaning of its absence.
    expect(
      resolveDataConfidence({
        coverage: 'PARTIAL',
        sources: [fresh('usgs'), fresh('emsc')],
        corroborated: true,
      }),
    ).toBe('LOW');
  });
});

describe('data confidence', () => {
  it('requires everything at once for HIGH', () => {
    // Full coverage, every source fresh, and two independent sources agreeing. A deliberately
    // high bar: it is the grade that says "you can act on this".
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [fresh('usgs'), fresh('emsc')],
        corroborated: true,
      }),
    ).toBe('HIGH');
  });

  it('is MEDIUM for a corroborated, fully covered family whose sources are merely late', () => {
    /*
     * The case that pins the `DEGRADED` term in the HIGH rule. Everything else here qualifies for
     * HIGH — full coverage, two independent sources, both agreeing — so the *only* thing keeping
     * it at MEDIUM is that they are late.
     *
     * Mutation testing found this gap: replacing `anyDegraded` with a constant `false` passed the
     * whole suite, because every other test either had no degraded source or was already
     * disqualified from HIGH for a different reason. A term no test can move is a term that is
     * not really there.
     */
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [withStatus('usgs', 'DEGRADED'), withStatus('emsc', 'DEGRADED')],
        corroborated: true,
      }),
    ).toBe('MEDIUM');

    // And with the same sources fresh, it is HIGH — so the difference really is the lateness.
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [fresh('usgs'), fresh('emsc')],
        corroborated: true,
      }),
    ).toBe('HIGH');
  });

  it('is MEDIUM for a single healthy source with nothing to corroborate it', () => {
    /*
     * The common case, and it must not read as HIGH. One source agreeing with itself is not
     * corroboration — which is the whole reason EMSC exists and the reason a GDACS earthquake
     * carries `derivedFrom: usgs` rather than counting as a second opinion.
     */
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [fresh('usgs')],
        corroborated: false,
      }),
    ).toBe('MEDIUM');
  });

  it('is LOW when nothing usable is behind the card', () => {
    expect(
      resolveDataConfidence({
        coverage: 'COVERED',
        sources: [withStatus('usgs', 'STALE')],
        corroborated: false,
      }),
    ).toBe('LOW');
    expect(resolveDataConfidence({ coverage: 'COVERED', sources: [], corroborated: false })).toBe(
      'LOW',
    );
  });
});

describe('highestRelevance', () => {
  it('ranks by attention rather than alphabetically', () => {
    // `CRITICAL` > `HIGH` > `MODERATE` > `LOW`; a string comparison would put CRITICAL below LOW.
    expect(highestRelevance(['LOW', 'CRITICAL', 'MODERATE'])).toBe('CRITICAL');
    expect(highestRelevance(['LOW', 'MODERATE'])).toBe('MODERATE');
    expect(highestRelevance(['HIGH', 'HIGH'])).toBe('HIGH');
  });

  it('has no answer for an empty set, rather than a default', () => {
    /*
     * `null`, not `LOW`. "Nothing was assessed" and "everything assessed was low" are different
     * facts, and `SnapshotOverall.headlineRelevance` is typed nullable for exactly this reason.
     */
    expect(highestRelevance([])).toBeNull();
  });
});

describe('a family whose items are derived, not ingested', () => {
  /*
   * The live defect this was written against: 235,707 FIRMS detections were ingested and the
   * clustering derivation had never run, so the as-of read returned zero fire clusters while
   * every source was healthy and the coverage was complete. Without this axis the model reports
   * AVAILABLE / NOTHING_TO_REPORT, and the product tells a user next to a wildfire that there is
   * nothing to report.
   */
  const ingestedAt = new Date('2026-09-20T12:00:00Z');
  const derivation = (overrides: Partial<DerivationStateInput> = {}): DerivationStateInput => ({
    kind: 'CLUSTERING',
    lastSucceededAt: new Date('2026-09-20T12:30:00Z'),
    newestInputAt: ingestedAt,
    ...overrides,
  });

  it('is UNAVAILABLE when the derivation has never run over data that exists', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('firms')],
      itemCount: 0,
      derivation: derivation({ lastSucceededAt: null }),
    });
    expect(verdict.availability).toBe('UNAVAILABLE');
    expect(verdict.reason).toBe('DERIVATION_NOT_RUN');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('is unchanged when the derivation has never run and there is no data to derive from', () => {
    // Nothing was ingested, so nothing failed to be derived. This is an ordinary quiet family.
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('firms')],
      itemCount: 0,
      derivation: derivation({ lastSucceededAt: null, newestInputAt: null }),
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('NOTHING_TO_REPORT');
    expect(verdict.mayRenderZero).toBe(true);
  });

  it('shows the items a stale derivation produced, but refuses to render its zero', () => {
    /*
     * Behind is not wrong. The clusters it did produce are real and withholding them would be the
     * worse error — but "0 active fires" from a derivation that has not seen the last six hours of
     * detections is a claim about a world it never looked at.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('firms')],
      itemCount: 3,
      derivation: derivation({
        lastSucceededAt: new Date(ingestedAt.getTime() - 60_000),
        newestInputAt: ingestedAt,
      }),
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('DERIVATION_STALE');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('is an ordinary AVAILABLE family when the derivation is current', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('firms')],
      itemCount: 2,
      derivation: derivation(),
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('OK');
  });

  it('treats a derivation that ran at exactly the newest input as current', () => {
    // The boundary is `<`, not `<=`: a derivation that read the newest fact is not behind it.
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('firms')],
      itemCount: 0,
      derivation: derivation({ lastSucceededAt: ingestedAt, newestInputAt: ingestedAt }),
    });
    expect(verdict.reason).toBe('NOTHING_TO_REPORT');
    expect(verdict.mayRenderZero).toBe(true);
  });

  it('names the source outage rather than the derivation when both are broken', () => {
    /*
     * A derivation cannot run over data that was never ingested, so when every source is down the
     * outage is the cause and the un-run derivation is its symptom. Reporting DERIVATION_NOT_RUN
     * here would point an operator at GeoNerva's own pipeline for a provider failure.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [withStatus('firms', 'UNAVAILABLE')],
      itemCount: 0,
      derivation: derivation({ lastSucceededAt: null }),
    });
    expect(verdict.availability).toBe('UNAVAILABLE');
    expect(verdict.reason).toBe('ALL_SOURCES_UNUSABLE');
  });

  it('leaves families without a derivation exactly as they were', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('usgs')],
      itemCount: 0,
    });
    expect(verdict.reason).toBe('NOTHING_TO_REPORT');
    expect(verdict.mayRenderZero).toBe(true);
  });
});

describe('a knowledge time beyond the replay horizon', () => {
  /*
   * ADR-035: "After the window a replay must report *outside the indexed window*, never an empty
   * result. An empty list here would be the system saying nothing happened when what it means is
   * that it no longer remembers."
   */
  it('is UNAVAILABLE, not a quiet family', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('usgs')],
      itemCount: 0,
      beyondReplayHorizon: true,
    });
    expect(verdict.availability).toBe('UNAVAILABLE');
    expect(verdict.reason).toBe('BEYOND_REPLAY_HORIZON');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('still reports a place with no source as NOT_COVERED', () => {
    // A place with no source cannot have a *forgotten* one; coverage is the more specific answer.
    const verdict = resolveAvailability({
      coverage: 'NOT_COVERED',
      sources: [],
      itemCount: 0,
      beyondReplayHorizon: true,
    });
    expect(verdict.reason).toBe('NOT_COVERED_HERE');
  });
});

describe('subjects that could not be assessed', () => {
  it('refuses to render a zero beside hazards it cannot describe', () => {
    /*
     * A GDACS drought alert covering this place, with no drought model written. The card must not
     * say "no volcanoes and droughts to report": GeoNerva is holding one and has nothing to say
     * about it, which is a different sentence.
     */
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('gdacs')],
      itemCount: 0,
      unassessedCount: 1,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.reason).toBe('SUBJECTS_NOT_ASSESSED');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('still shows the items that were assessed', () => {
    // Withholding real assessments because a sibling could not be assessed would be worse.
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('gdacs')],
      itemCount: 3,
      unassessedCount: 1,
    });
    expect(verdict.availability).toBe('AVAILABLE');
    expect(verdict.mayRenderZero).toBe(false);
  });

  it('leaves a family with nothing unassessed exactly as it was', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [fresh('usgs')],
      itemCount: 0,
      unassessedCount: 0,
    });
    expect(verdict.reason).toBe('NOTHING_TO_REPORT');
    expect(verdict.mayRenderZero).toBe(true);
  });

  it('reports an outage rather than an unassessed subject when the sources are down', () => {
    const verdict = resolveAvailability({
      coverage: 'COVERED',
      sources: [withStatus('gdacs', 'UNAVAILABLE')],
      itemCount: 0,
      unassessedCount: 1,
    });
    expect(verdict.reason).toBe('ALL_SOURCES_UNUSABLE');
  });
});
