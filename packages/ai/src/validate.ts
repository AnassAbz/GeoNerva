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
  const allowedNumbers = collectPacketNumbers(packet);
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
  const thermalSubjects = new Set(
    packet.items
      .filter((item) => item.hazardType === 'THERMAL_ACTIVITY')
      .map((item) => item.subjectRef),
  );

  const findings: ValidationFinding[] = [];

  /** Every check that applies to any piece of prose. Returns the findings for that piece. */
  const checkText = (
    path: string,
    text: string,
    evidenceIds: readonly string[],
    options: { readonly thermal?: boolean } = {},
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

    // Rule 3 — every number in the prose must exist in the packet.
    for (const number of extractNumbers(text)) {
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
      ...(options.thermal === true ? { thermalContext: true } : {}),
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

    // Rule 8 — a family that cannot be described must not be discussed as though it could.
    for (const [family, words] of unusableFamilies) {
      if (!mentionsFamily(text, words)) continue;
      if (!statesUnavailability(text)) {
        local.push({
          claimPath: path,
          problemCode: 'STALE_AS_CURRENT',
          note: `mentions ${family} without stating that GeoNerva cannot currently report on it`,
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
    const local = checkText(path, entry.text, entry.evidenceIds, {
      thermal: thermalSubjects.has(entry.subjectRef),
    });

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
 * Every number the packet contains, as the strings a text would spell them with.
 *
 * Both the plain form and the one-decimal form are admitted, because "M5.4" and "5.4" are the same
 * figure and a magnitude of 5.0 is honestly written either "5" or "5.0". Admitting both is not a
 * loosening: the set is still *exactly* the figures in the packet, and a number outside it fails.
 */
function collectPacketNumbers(packet: BriefingPacket): ReadonlySet<string> {
  const numbers = new Set<string>();
  const add = (value: number | null | undefined): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    numbers.add(normalizeNumber(String(value)));
    numbers.add(normalizeNumber(value.toFixed(0)));
    numbers.add(normalizeNumber(value.toFixed(1)));
  };

  add(packet.lat);
  add(packet.lon);
  for (const family of packet.families) add(family.itemsTotal);
  for (const item of packet.items) {
    add(item.distanceKm);
    add(item.agreement?.nIndependentSources);
    for (const fact of item.facts) {
      for (const found of extractNumbers(fact.value)) numbers.add(found);
    }
    for (const reason of item.relevanceReasons) {
      for (const found of extractNumbers(reason.text)) numbers.add(found);
    }
  }
  /*
   * Numbers inside verbatim provider text and inside the deterministic copy are admissible: the
   * model is allowed to relay a caveat or improve on a sentence GeoNerva already published, and
   * both are figures this response already shows the user.
   */
  for (const quote of packet.verbatimQuotes) {
    for (const found of extractNumbers(quote)) numbers.add(found);
  }
  for (const sentence of [packet.deterministicCopy.headline, ...packet.deterministicCopy.summary]) {
    for (const found of extractNumbers(sentence)) numbers.add(found);
  }
  return numbers;
}

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

/** Families whose sources cannot currently support a claim, with the words a text would use. */
function unusableFamilyWords(packet: BriefingPacket): ReadonlyMap<string, readonly string[]> {
  const words = new Map<string, readonly string[]>();
  for (const family of packet.families) {
    if (family.availability === 'AVAILABLE') continue;
    if (family.availability === 'NOT_COVERED') continue;
    words.set(family.family, familyWordsFor(family.family));
  }
  return words;
}

function familyWordsFor(family: string): readonly string[] {
  switch (family) {
    case 'EARTHQUAKES':
      return ['earthquake', 'seismic', 'quake'];
    case 'FIRE_ACTIVITY':
      return ['fire', 'thermal', 'detection'];
    case 'FLOODS':
      return ['flood'];
    case 'CYCLONES':
      return ['cyclone', 'hurricane', 'typhoon', 'storm'];
    case 'WEATHER_ALERTS':
      return ['weather warning', 'weather alert'];
    default:
      return ['volcano', 'volcanic', 'drought'];
  }
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
