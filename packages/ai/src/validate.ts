/**
 * The deterministic validator — **the actual gate** (ARCHITECTURE §11.4).
 *
 * Structured outputs make the response schema-valid by construction, and the Skeptic gives a
 * second opinion. Neither is the gate. A schema-valid document can still say something false, and
 * a second model is still a model; the thing that decides what reaches a user is this file, which
 * compares the output against the packet using rules that do not involve a model at all.
 *
 * §11.4's eight rules, implemented in order:
 *
 *  1. **Schema-valid** — `schema.ts`, re-checked with Zod rather than assumed from the transport.
 *  2. **Every `evidenceId` exists in the packet's manifest.** This also enforces *scope*: the
 *     manifest is the response's own evidence, so a citation outside it is either invented or
 *     about another location.
 *  3. **Every number in any text field must match a value in the packet.** The strictest rule and
 *     the one that does the most work: a model cannot invent a magnitude, a distance or a count
 *     without the number appearing in prose, and prose is scannable.
 *  4. **Echoed relevance levels must equal the deterministic ones.** The model explains a level;
 *     it does not set one.
 *  5. **Banned lexicon**, through the same scanner the deterministic templates are held to.
 *  6. **Timestamps mentioned must be ≤ `asOf`.** A briefing may not describe the future.
 *  7. **Official alert text is not paraphrased** — referenced by id and name only.
 *  8. **A family whose sources are STALE/UNAVAILABLE must be described as such** if it is
 *     mentioned at all. This is the availability lie arriving through generated prose, and it is
 *     the reason this rule exists rather than being left to the lexicon.
 *
 * ### Outcomes
 *
 * Failing *claims* are removed and the rest stands (`REPAIRED`). If the **summary** fails, or more
 * than 30 % of claims fail, the whole output is `REJECTED` and the deterministic template is used.
 * That asymmetry is deliberate: the summary is the one piece a reader cannot skip, so it is
 * all-or-nothing, while a single bad observation among six is a repair.
 */

import { scanLexicon, type LexiconHit } from '@geonerva/briefing';
import type { AiValidationStatus, RelevanceLevel } from '@geonerva/domain';

import type { BriefingPacket } from './packet.ts';
import { PROBLEM_CODES, type InterpreterOutput, type ProblemCode } from './schema.ts';

/** §11.4: more than this fraction of failing claims rejects the whole output. */
export const MAX_FAILED_CLAIM_FRACTION = 0.3;

/** §11.2: the summary is capped at 80 words. */
export const MAX_SUMMARY_WORDS = 80;

export interface ValidationFinding {
  /** Where in the output, e.g. `keyObservations[2]` or `summary`. */
  readonly claimPath: string;
  readonly problemCode: ProblemCode;
  /** Short and safe: never the offending model text, never provider text. */
  readonly note: string;
}

export interface ValidationResult {
  readonly status: AiValidationStatus;
  /** The output with failing claims removed. `null` when the status is `REJECTED`. */
  readonly repaired: InterpreterOutput | null;
  readonly findings: readonly ValidationFinding[];
  /** Every evidence id the surviving output cites, for invariant I12. */
  readonly evidenceIds: readonly string[];
}

/**
 * Validates one Interpreter output against the packet it was generated from.
 *
 * Pure: the packet and the output go in, a verdict comes out. No clock, no network, no model —
 * which is what makes the gate testable against hostile input rather than hopeful about it.
 */
export function validateInterpreterOutput(
  packet: BriefingPacket,
  output: InterpreterOutput,
): ValidationResult {
  const manifest = new Set(packet.evidenceManifest.map((entry) => entry.id));
  const levelBySubject = new Map<string, RelevanceLevel>(
    packet.items.map((item) => [item.subjectRef, item.relevanceLevel]),
  );
  const reasonsBySubject = new Map<string, ReadonlySet<string>>(
    packet.items.map((item) => [
      item.subjectRef,
      new Set(item.relevanceReasons.map((reason) => reason.code)),
    ]),
  );
  const changeIds = new Set(packet.changes.map((change) => change.id));
  const asOf = Date.parse(packet.asOf);
  const unusableFamilies = unusableFamilyWords(packet);
  /*
   * Whether the packet holds a thermal subject at all, which is what makes "wildfire" prohibited
   * anywhere in the output.
   *
   * `thermalContext` used to be passed only for `relevanceExplanations`, so the *summary* — the
   * one piece a reader cannot skip — could say "A wildfire is burning 12 km from Marrakech" while
   * §9.2's mandatory caveat sat on the same card saying VIIRS detects heat, not fire.
   */
  const hasThermalSubject = packet.items.some((item) => item.hazardType === 'THERMAL_ACTIVITY');

  const findings: ValidationFinding[] = [];

  /** Every check that applies to any piece of prose. Returns the findings for that piece. */
  const checkText = (
    path: string,
    text: string,
    evidenceIds: readonly string[],
  ): ValidationFinding[] => {
    const local: ValidationFinding[] = [];

    // Rule 2 — citations must exist in the manifest.
    for (const id of evidenceIds) {
      if (!manifest.has(id)) {
        local.push({
          claimPath: path,
          problemCode: 'UNSUPPORTED_CLAIM',
          note: 'cites an evidence id that is not in this response’s manifest',
        });
      }
    }

    // Rule 3 — every number in the prose must exist in what this claim cites.
    const allowedNumbers = allowedNumbersFor(packet, evidenceIds);
    for (const number of [...extractNumbers(text), ...extractWordNumerals(text)]) {
      if (!allowedNumbers.has(number)) {
        local.push({
          claimPath: path,
          problemCode: 'NUMBER_MISMATCH',
          note: 'contains a number that does not appear in the evidence',
        });
      }
    }

    // Rule 5 — banned lexicon, with the packet's verbatim quotes excused.
    for (const hit of scanLexicon(text, {
      verbatimQuotes: packet.verbatimQuotes,
      ...(hasThermalSubject ? { thermalContext: true } : {}),
    })) {
      local.push({
        claimPath: path,
        problemCode: lexiconProblem(hit),
        note: `uses prohibited ${hit.lexiconClass.toLowerCase().replaceAll('_', ' ')} language`,
      });
    }

    // Rule 6 — no timestamp after the knowledge time.
    for (const stamp of extractTimestamps(text)) {
      if (Number.isFinite(asOf) && stamp > asOf) {
        local.push({
          claimPath: path,
          problemCode: 'UNSUPPORTED_CLAIM',
          note: 'mentions a time after the knowledge time of this briefing',
        });
      }
    }

    // Rule 7 — an official alert may be referenced, never paraphrased.
    if (mentionsAlertProse(text)) {
      local.push({
        claimPath: path,
        problemCode: 'ALERT_PARAPHRASED',
        note: 'appears to paraphrase official alert wording',
      });
    }

    /*
     * Rule 8 — a family whose sources cannot fully support a claim must not be discussed as though
     * they could, and the caveat has to be about **that family**.
     *
     * Two holes are closed here. The first: `statesUnavailability` used to be asked of the whole
     * text, so "Flood data is unavailable. There are no earthquakes near Marrakech." satisfied the
     * rule for *earthquakes* on the strength of a sentence about floods — the availability lie,
     * arriving through generated prose, which is the failure this rule exists for. The caveat must
     * now sit in the same sentence as the family it excuses.
     *
     * The second: only `UNAVAILABLE` families were policed, while the availability model keeps a
     * family `AVAILABLE` with reason `SOME_SOURCES_UNUSABLE` when one of two sources is down. The
     * deterministic card says "Some sources for earthquakes could not be read: usgs"; the AI path
     * said nothing, and was therefore *less* honest than the templates it is meant to improve on,
     * in the commonest degraded state there is.
     */
    for (const [family, words] of unusableFamilies) {
      const mentioning = sentencesMentioning(text, words);
      if (mentioning.length === 0) continue;
      if (!mentioning.some(statesUnavailability)) {
        local.push({
          claimPath: path,
          problemCode: 'STALE_AS_CURRENT',
          note: `mentions ${family} without stating in the same sentence that GeoNerva cannot fully report on it`,
        });
      }
    }

    return local;
  };

  /*
   * Claims first, then the summary. The order matters only for reporting — the counts below treat
   * them separately, because the summary's failure is fatal and a claim's is not.
   */
  const keptObservations: InterpreterOutput['keyObservations'] = [];
  let claimTotal = 0;
  let claimFailed = 0;

  output.keyObservations.forEach((observation, index) => {
    const path = `keyObservations[${String(index)}]`;
    claimTotal += 1;
    const local = checkText(path, observation.claim, observation.evidenceIds);
    if (local.length === 0) keptObservations.push(observation);
    else {
      claimFailed += 1;
      findings.push(...local);
    }
  });

  const keptChanges: InterpreterOutput['changeNarrative'] = [];
  const narratedSignals = new Set<string>();
  output.changeNarrative.forEach((entry, index) => {
    const path = `changeNarrative[${String(index)}]`;
    claimTotal += 1;
    const local = checkText(path, entry.text, entry.evidenceIds);
    /*
     * A narrative about a signal the packet does not contain is an invented change — which is the
     * one thing §11.2 forbids the Change Analyst outright, and it cannot be repaired into
     * correctness.
     */
    if (!changeIds.has(entry.signalId)) {
      local.push({
        claimPath: path,
        problemCode: 'UNSUPPORTED_CLAIM',
        note: 'describes a change signal that is not in the packet',
      });
    }
    /*
     * One narrative per signal. §11.2 says "one per signal, same order", and nothing enforced it —
     * a model could emit two contradictory sentences about the same change and both would be
     * joined into the section.
     */
    if (narratedSignals.has(entry.signalId)) {
      local.push({
        claimPath: path,
        problemCode: 'UNSUPPORTED_CLAIM',
        note: 'describes a change signal that another claim already narrated',
      });
    }
    narratedSignals.add(entry.signalId);
    if (local.length === 0) keptChanges.push(entry);
    else {
      claimFailed += 1;
      findings.push(...local);
    }
  });

  const keptExplanations: InterpreterOutput['relevanceExplanations'] = [];
  output.relevanceExplanations.forEach((entry, index) => {
    const path = `relevanceExplanations[${String(index)}]`;
    claimTotal += 1;
    const local = checkText(path, entry.text, entry.evidenceIds);

    // Rule 4 — the level is echoed, not chosen.
    const expected = levelBySubject.get(entry.subjectRef);
    if (expected === undefined) {
      local.push({
        claimPath: path,
        problemCode: 'UNSUPPORTED_CLAIM',
        note: 'explains a subject that is not in the packet',
      });
    } else if (expected !== entry.level) {
      local.push({
        claimPath: path,
        problemCode: 'EXAGGERATION',
        note: 'reports a relevance level that differs from the deterministic one',
      });
    }

    /*
     * Reason codes must be a subset of the subject's own. §11.2 forbids "adding reasons not in
     * `reasons[]`", and an added reason is an explanation of something that was never assessed.
     */
    const allowed = reasonsBySubject.get(entry.subjectRef) ?? new Set<string>();
    for (const code of entry.reasonCodes) {
      if (!allowed.has(code)) {
        local.push({
          claimPath: path,
          problemCode: 'UNSUPPORTED_CLAIM',
          note: 'cites a relevance reason the assessment does not contain',
        });
      }
    }

    if (local.length === 0) keptExplanations.push(entry);
    else {
      claimFailed += 1;
      findings.push(...local);
    }
  });

  /*
   * The summary, which is all-or-nothing. A reader cannot skip it, so a summary that fails any
   * rule rejects the whole output rather than being quietly dropped — a briefing whose summary
   * vanished would read as an incomplete page rather than as a fallback.
   */
  const summaryFindings = checkText('summary', output.summary.text, output.summary.evidenceIds);
  if (countWords(output.summary.text) > MAX_SUMMARY_WORDS) {
    summaryFindings.push({
      claimPath: 'summary',
      problemCode: 'EXAGGERATION',
      note: `summary exceeds ${String(MAX_SUMMARY_WORDS)} words`,
    });
  }
  /*
   * §11.2: the Composer may not omit a stale or unavailable source that affects a relevant family.
   * The other rules catch a summary that *mentions* such a family wrongly; this catches one that
   * stays silent about it, which is the more tempting failure.
   */
  if (unusableFamilies.size > 0 && !statesUnavailability(output.summary.text)) {
    summaryFindings.push({
      claimPath: 'summary',
      problemCode: 'STALE_AS_CURRENT',
      note: 'omits that GeoNerva cannot currently report on at least one family',
    });
  }
  findings.push(...summaryFindings);

  if (summaryFindings.length > 0) {
    return { status: 'REJECTED', repaired: null, findings, evidenceIds: [] };
  }

  const failedFraction = claimTotal === 0 ? 0 : claimFailed / claimTotal;
  if (failedFraction > MAX_FAILED_CLAIM_FRACTION) {
    return { status: 'REJECTED', repaired: null, findings, evidenceIds: [] };
  }

  const repaired: InterpreterOutput = {
    keyObservations: keptObservations,
    changeNarrative: keptChanges,
    relevanceExplanations: keptExplanations,
    summary: output.summary,
  };

  const evidenceIds = [
    ...new Set([
      ...keptObservations.flatMap((entry) => entry.evidenceIds),
      ...keptChanges.flatMap((entry) => entry.evidenceIds),
      ...keptExplanations.flatMap((entry) => entry.evidenceIds),
      ...output.summary.evidenceIds,
    ]),
  ].sort(compare);

  return {
    status: claimFailed === 0 ? 'PASSED' : 'REPAIRED',
    repaired,
    findings,
    evidenceIds,
  };
}

/**
 * The numbers a claim may use, **scoped to what it cites**.
 *
 * §11.4 rule 3 requires a number to equal "a value in the packet **at a referenced path**". The
 * first implementation built one flat set over the whole packet, which licensed any figure that
 * collided with an unrelated value:
 *
 *  - a claim could take a magnitude from one item and a distance from another and assert them of
 *    the same event — "an M6.1 earthquake struck 8 km from Marrakech", where the 6.1 belongs to a
 *    distant event and the 8 to a small nearby one;
 *  - `lat = 31.63` admitted the string "32" through `toFixed(0)`, so a coordinate licensed a
 *    detection count.
 *
 * The set is now assembled from the **items and changes the claim actually cites**, plus the
 * genuinely global figures (the window phrasing in the deterministic copy, and provider caveats
 * the claim is relaying). Coordinates are excluded entirely: no honest sentence needs to state the
 * location's own latitude, and admitting them was pure surface area.
 */
function allowedNumbersFor(
  packet: BriefingPacket,
  citedEvidenceIds: readonly string[],
): ReadonlySet<string> {
  const cited = new Set(citedEvidenceIds);
  const numbers = new Set<string>();
  const add = (value: number | null | undefined): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    numbers.add(normalizeNumber(String(value)));
    numbers.add(normalizeNumber(value.toFixed(0)));
    numbers.add(normalizeNumber(value.toFixed(1)));
  };

  for (const item of packet.items) {
    if (!item.evidenceIds.some((id) => cited.has(id))) continue;
    add(item.distanceKm);
    add(item.agreement?.nIndependentSources);
    for (const fact of item.facts)
      for (const found of extractNumbers(fact.value)) numbers.add(found);
    for (const reason of item.relevanceReasons) {
      for (const found of extractNumbers(reason.text)) numbers.add(found);
    }
  }

  /*
   * A family's own total is admissible when the claim cites something from that family, so "3 of
   * the 7 earthquakes" is sayable while a count lifted from an unrelated card is not.
   */
  const citedFamilies = new Set(
    packet.items
      .filter((item) => item.evidenceIds.some((id) => cited.has(id)))
      .map((item) => item.family),
  );
  for (const family of packet.families) {
    if (citedFamilies.has(family.family)) add(family.itemsTotal);
  }

  /*
   * A cited change's before/after values. §11.2 gives the Change Analyst those values, so "revised
   * from 5.1 to 5.4" has to be sayable — and the *before* number exists nowhere else in the
   * packet.
   */
  for (const change of packet.changes) {
    if (!change.evidenceIds.some((id) => cited.has(id)) && !cited.has(change.id)) continue;
    for (const facet of change.facets) {
      for (const value of [facet.before, facet.after]) {
        if (value === null) continue;
        for (const found of extractNumbers(value)) numbers.add(found);
      }
    }
  }

  /*
   * Global figures: the window phrasing GeoNerva already published, and provider caveats the claim
   * may relay verbatim. Both are numbers this response shows the user regardless of citation.
   */
  for (const sentence of [packet.deterministicCopy.headline, ...packet.deterministicCopy.summary]) {
    for (const found of extractNumbers(sentence)) numbers.add(found);
  }
  for (const quote of packet.verbatimQuotes) {
    for (const found of extractNumbers(quote)) numbers.add(found);
  }
  return numbers;
}

/**
 * Quantities written as words.
 *
 * Rule 3 calls itself the strictest rule, and it was blind to "six earthquakes" and "a dozen
 * detections" — a fabricated count spelled out was invisible. A numeral-only extractor made the
 * rule's own docstring false, so a word numeral in a claim is treated as a number that has to be
 * justified like any other. The list is deliberately short: these are the forms a summary actually
 * uses, and an unlisted one is not silently permitted — it simply is not *detected*, which is the
 * honest limit and is recorded in the gate report.
 */
const WORD_NUMERALS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
  thousand: 1000,
};

/**
 * Numbers in a piece of text.
 *
 * Deliberately crude and deliberately *inclusive*: anything that looks like a figure is extracted
 * and must be justified. A cleverer extractor that skipped "hard" cases would be a hole, because
 * the rule's value is that the model cannot state a quantity without it being checked. Years
 * inside an ISO timestamp are excluded, since rule 6 checks those as times instead.
 */
export function extractNumbers(text: string): string[] {
  const withoutTimestamps = text.replaceAll(
    /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/gu,
    ' ',
  );
  const matches = withoutTimestamps.match(/-?\d+(?:[.,]\d+)?/gu) ?? [];
  return matches.map(normalizeNumber);
}

/** Word numerals in a text, as the canonical number strings rule 3 compares against. */
export function extractWordNumerals(text: string): string[] {
  const found: string[] = [];
  for (const [word, value] of Object.entries(WORD_NUMERALS)) {
    const pattern = new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'giu');
    if (pattern.test(text.toLowerCase())) found.push(normalizeNumber(String(value)));
  }
  return found;
}

/** `5,4` and `5.40` and `5.4` are the same figure; `0.5` and `.5` are too. */
function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(',', '.');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return cleaned;
  // Trailing-zero-insensitive, sign-preserving canonical form.
  return String(parsed);
}

/** ISO-8601 timestamps mentioned in prose, as epoch milliseconds. */
export function extractTimestamps(text: string): number[] {
  const matches =
    text.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/gu) ?? [];
  return matches
    .map((raw) => Date.parse(raw.replace(' ', 'T')))
    .filter((value) => Number.isFinite(value));
}

/**
 * Families whose sources cannot currently support an unqualified claim.
 *
 * `UNAVAILABLE` is the obvious case. `AVAILABLE` with a **degraded reason** is the one that was
 * missed: the availability model keeps a family available when one of several sources is down, and
 * the card carries the caveat naming it. `NOT_COVERED` is excluded because a family nothing covers
 * cannot be described as stale, and the copy says so on its own axis.
 */
const DEGRADED_REASONS: ReadonlySet<string> = new Set([
  'AVAILABILITY_SOME_SOURCES_UNUSABLE',
  'AVAILABILITY_DERIVATION_STALE',
  'AVAILABILITY_SUBJECTS_NOT_ASSESSED',
  'SOME_SOURCES_UNUSABLE',
  'DERIVATION_STALE',
  'SUBJECTS_NOT_ASSESSED',
]);

function unusableFamilyWords(packet: BriefingPacket): ReadonlyMap<string, readonly string[]> {
  const words = new Map<string, readonly string[]>();
  for (const family of packet.families) {
    if (family.availability === 'NOT_COVERED') continue;
    const degraded =
      family.availabilityReasonCode !== null && DEGRADED_REASONS.has(family.availabilityReasonCode);
    if (family.availability === 'AVAILABLE' && !degraded) continue;
    words.set(family.family, familyWordsFor(family.family));
  }
  return words;
}

/** The sentences of `text` that mention any of `words`. Rule 8 is asked of each one. */
function sentencesMentioning(text: string, words: readonly string[]): string[] {
  return text.split(/(?<=[.!?;])\s+/u).filter((sentence) => mentionsFamily(sentence, words));
}

/**
 * The words a text would use for a family.
 *
 * A total map rather than a `switch` with a `default`: the old default returned the volcano and
 * drought words for *any* unlisted family, so an unavailable `OTHER` discussed as "a tsunami"
 * escaped the rule entirely. `storm` is deliberately absent from `CYCLONES` — it appears in honest
 * prose about unrelated weather and would false-reject.
 */
const FAMILY_WORDS: Readonly<Record<string, readonly string[]>> = {
  EARTHQUAKES: ['earthquake', 'seismic', 'quake', 'aftershock'],
  FIRE_ACTIVITY: ['fire', 'thermal', 'detection', 'burning'],
  FLOODS: ['flood', 'flooding'],
  CYCLONES: ['cyclone', 'hurricane', 'typhoon'],
  WEATHER_ALERTS: ['weather warning', 'weather alert', 'official alert', 'official warning'],
  OTHER: ['volcano', 'volcanic', 'drought', 'tsunami'],
};

function familyWordsFor(family: string): readonly string[] {
  return FAMILY_WORDS[family] ?? [];
}

function mentionsFamily(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

/**
 * Whether the text says GeoNerva cannot report, in any of the forms the templates use.
 *
 * A phrase list rather than a model call, and intentionally generous: the rule is meant to catch
 * prose that talks about a dead family as though it were live, not to police how the limitation is
 * worded. A false *accept* here is caught by the Skeptic and by the other seven rules; a false
 * reject would make honest output unusable.
 */
function statesUnavailability(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    'cannot',
    "can't",
    'unavailable',
    'not available',
    'unknown',
    'no data',
    'stale',
    'out of date',
    'not covered',
    'has not finished',
    'still processing',
    'outside the',
  ].some((phrase) => lower.includes(phrase));
}

/**
 * Whether the text reads like a paraphrase of an official alert.
 *
 * §11.4 rule 7 allows referencing an alert by id and name, and forbids restating its wording. The
 * heuristic is the imperative voice an alert uses — "residents should evacuate" — because that is
 * both the form a paraphrase takes and the form GeoNerva must never generate: it is emergency
 * instruction, which is the authority's to give.
 */
function mentionsAlertProse(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    'should evacuate',
    'must evacuate',
    'evacuate immediately',
    'seek shelter',
    'take shelter',
    'residents are advised',
    'residents should',
    'you should leave',
    'avoid the area',
  ].some((phrase) => lower.includes(phrase));
}

function lexiconProblem(hit: LexiconHit): ProblemCode {
  switch (hit.lexiconClass) {
    case 'PREDICTION':
      return 'PREDICTION_LANGUAGE';
    case 'SAFETY':
      return 'SAFETY_CLAIM';
    case 'THERMAL_AS_WILDFIRE':
      return 'THERMAL_AS_WILDFIRE';
    case 'REAL_TIME':
      return 'EXAGGERATION';
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export { PROBLEM_CODES };
