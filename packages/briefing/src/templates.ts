/**
 * Deterministic briefing copy (ARCHITECTURE §11: "the deterministic templated copy *is* the
 * product's language").
 *
 * `AI_MODE=disabled` is the default and a first-class mode, so this is not a fallback in the sense
 * of a degraded path — it is what the product says. Every sentence here is a function of the
 * snapshot and the change set, which is what makes a briefing reproducible and what makes the AI
 * layer optional rather than load-bearing.
 *
 * ### The four distinctions that must survive into prose
 *
 * The availability model spends a great deal of effort keeping these apart, and prose is where
 * they are easiest to collapse:
 *
 * | State | What the copy must say |
 * |---|---|
 * | Nothing relevant found | "No …ations to report", attributed to what was checked |
 * | Source unavailable | "GeoNerva cannot say", naming the family |
 * | Source stale/degraded | The items, **with** the lateness stated |
 * | Partial coverage | The items, **with** the gap named |
 *
 * And the sentence this file exists to never write:
 *
 * > **"No relevant hazards were found" must never become "you are safe."**
 *
 * The first is a statement about GeoNerva's data. The second is a statement about the world, and a
 * reader acts on it. `scanLexicon` enforces this mechanically — the templates are tested against
 * the same scanner that gates model output, so the prohibition is not merely a convention in this
 * module's head.
 */

import {
  HAZARD_FAMILIES,
  type BriefingCopy,
  type ChangeWindow,
  type FamilyCard,
  type HazardFamily,
  type LocationRef,
  type LocationSnapshotView,
} from '@geonerva/domain';

import { familyWords } from './coverage.ts';

/** Bumped whenever a sentence changes, so cached copy can be told apart from current copy. */
export const TEMPLATE_VERSION = 'tpl-1';

export interface CopyInput {
  readonly location: LocationRef;
  readonly snapshot: LocationSnapshotView;
  readonly window: ChangeWindow;
  /** Counts by prominence, from the change engine. Not the signals themselves — copy is summary. */
  readonly changes: {
    readonly headline: readonly { readonly title: string; readonly detail: string | null }[];
    readonly listedCount: number;
    readonly suppressedCount: number;
  };
}

/** Builds the whole copy block. Pure, and stable for a given snapshot and change set. */
export function buildCopy(input: CopyInput): BriefingCopy {
  const byFamily = {} as Record<HazardFamily, readonly string[]>;
  for (const family of HAZARD_FAMILIES) {
    byFamily[family] = familySentences(input.snapshot.families[family]);
  }

  return {
    headline: headlineSentence(input),
    summary: summarySentences(input),
    byFamily,
    caveats: caveatSentences(input.snapshot),
    templateVersion: TEMPLATE_VERSION,
  };
}

/**
 * The single sentence at the top.
 *
 * It follows `overall.headlineCode`, which the snapshot already decided — restating the decision
 * here in different words would be a second headline rule, and the two would eventually disagree
 * about the same snapshot.
 */
function headlineSentence(input: CopyInput): string {
  const { overall } = input.snapshot;
  const place = input.location.label;

  switch (overall.headlineCode) {
    case 'OFFICIAL_ALERT_AFFECTING_AREA':
      return `An official alert covers ${place}.`;
    case 'HIGH_RELEVANCE_PRESENT':
      return `There is activity near ${place} worth your attention.`;
    case 'DATA_UNAVAILABLE':
      /*
       * Named families, not a generic apology. "Some data is unavailable" tells a reader nothing
       * they can act on; "GeoNerva cannot currently report on earthquakes" tells them which
       * question is unanswered and lets them go elsewhere for it.
       */
      return overall.unavailableFamilies.length === 0
        ? `GeoNerva cannot currently report on part of what it tracks near ${place}.`
        : `GeoNerva cannot currently report on ${list(overall.unavailableFamilies.map(familyWords))} near ${place}.`;
    case 'NO_HIGH_RELEVANCE_ITEMS':
      /*
       * The careful one. "Nothing needs your attention" is a statement about what GeoNerva
       * *checked*, and the summary immediately below says what that was — never "you are safe",
       * which is a claim about the world.
       */
      return `Nothing GeoNerva is tracking near ${place} currently needs your attention.`;
  }
}

/**
 * The paragraph under the headline: what was found, what changed, and what could not be seen.
 *
 * Ordered so that the qualifications arrive **before** the reassurance. A reader who stops after
 * two sentences should have been told about the outage, not told that things look quiet and then
 * told, three sentences later, that a feed was down.
 */
function summarySentences(input: CopyInput): readonly string[] {
  const { snapshot } = input;
  const sentences: string[] = [];

  const unavailable = HAZARD_FAMILIES.filter(
    (family) => snapshot.families[family].availability === 'UNAVAILABLE',
  );
  const notCovered = HAZARD_FAMILIES.filter(
    (family) => snapshot.families[family].availability === 'NOT_COVERED',
  );

  if (unavailable.length > 0) {
    sentences.push(
      `GeoNerva cannot describe ${list(unavailable.map(familyWords))} here at the moment, so treat the absence of ${unavailable.length === 1 ? 'that' : 'those'} as unknown rather than as quiet.`,
    );
  }

  const withItems = HAZARD_FAMILIES.filter((family) => snapshot.families[family].items.length > 0);
  if (withItems.length > 0) {
    const parts = withItems.map((family) => {
      const card = snapshot.families[family];
      const count = card.itemsTotal;
      /*
       * "at least" when the read was capped. `itemsTotal` is the number behind the card, and the
       * snapshot caps its query — so on a busy location the figure is a floor, and printing a
       * floor as a total is the same class of overstatement as rendering an unknown as a zero.
       */
      const prefix = card.truncated ? 'at least ' : '';
      return `${prefix}${String(count)} ${familyWords(family)} item${count === 1 ? '' : 's'}`;
    });
    sentences.push(`GeoNerva is currently tracking ${list(parts)} near this location.`);
  } else if (unavailable.length === 0) {
    /*
     * The only place a zero is stated, and it is stated as *what was checked* rather than as a
     * property of the place. Invariant I11 has already guaranteed that every family reaching here
     * is one a usable source looked at.
     */
    const checked = HAZARD_FAMILIES.filter(
      (family) => snapshot.families[family].availability === 'AVAILABLE',
    );
    sentences.push(
      `The ${list(checked.map(familyWords))} sources GeoNerva checked reported nothing relevant near this location.`,
    );
  }

  if (notCovered.length > 0) {
    sentences.push(
      `${capitalize(list(notCovered.map(familyWords)))} ${notCovered.length === 1 ? 'is' : 'are'} not covered here, so GeoNerva would not have seen ${notCovered.length === 1 ? 'it' : 'them'} either way.`,
    );
  }

  sentences.push(changeSentence(input));
  return sentences;
}

/** What changed in the window, or the honest statement that nothing did. */
function changeSentence(input: CopyInput): string {
  const { changes, window } = input;
  const windowWords = windowLabel(window);

  if (changes.headline.length === 0 && changes.listedCount === 0) {
    /*
     * §10.4's own sentence, plus the suppressed count. "Nothing changed" with a hidden pile of
     * filtered signals behind it would make the filtering invisible, which is the thing the
     * suppression reasons exist to prevent.
     */
    return changes.suppressedCount === 0
      ? `Nothing meaningful changed ${windowWords}.`
      : `Nothing meaningful changed ${windowWords}; ${String(changes.suppressedCount)} minor change${changes.suppressedCount === 1 ? '' : 's'} ${changes.suppressedCount === 1 ? 'was' : 'were'} filtered out.`;
  }

  const lead = changes.headline[0];
  if (lead === undefined) {
    return `${String(changes.listedCount)} change${changes.listedCount === 1 ? '' : 's'} ${windowWords}.`;
  }
  const others = changes.headline.length - 1 + changes.listedCount;
  return others === 0
    ? `${lead.title} ${windowWords}.`
    : `${lead.title}, and ${String(others)} other change${others === 1 ? '' : 's'} ${windowWords}.`;
}

/**
 * Per-family sentences.
 *
 * The distinctions from the header are made here, one family at a time, because this is what the
 * UI renders inside each card and it is where a collapsed distinction would be read.
 */
function familySentences(card: FamilyCard): readonly string[] {
  const words = familyWords(card.family);
  const sentences: string[] = [];

  switch (card.availability) {
    case 'NOT_COVERED':
      sentences.push(card.coverage.note ?? `GeoNerva has no source for ${words} at this location.`);
      return sentences;
    case 'UNAVAILABLE':
      /*
       * The card's own reason, verbatim. The availability model already produced the sentence that
       * distinguishes an outage from a never-successful source from an un-run derivation from a
       * knowledge time past the retention horizon; rewriting it here would flatten four different
       * situations into one apology.
       */
      sentences.push(
        card.dataConfidence.reasons[0]?.text ??
          `GeoNerva cannot currently report on ${words} here.`,
      );
      return sentences;
    case 'AVAILABLE':
      break;
  }

  if (card.items.length === 0) {
    sentences.push(`No ${words} to report here.`);
  } else {
    const top = card.items[0];
    if (top !== undefined) {
      sentences.push(`${top.title}, about ${top.distanceKm.toFixed(0)} km away.`);
    }
    if (card.itemsTotal > 1) {
      sentences.push(
        card.truncated
          ? `At least ${String(card.itemsTotal)} ${words} items, of which ${String(card.items.length)} are listed.`
          : `${String(card.itemsTotal)} ${words} items in total.`,
      );
    }
  }

  for (const caveat of card.caveats) sentences.push(caveat);
  return sentences;
}

/**
 * Caveats that apply to the whole briefing.
 *
 * Deduplicated across families but never summarized: §9.2's thermal caveat and a provider's
 * completeness note are the provider's or the model's own wording, and a shortened version would
 * be GeoNerva's paraphrase of someone else's limitation.
 */
function caveatSentences(snapshot: LocationSnapshotView): readonly string[] {
  const caveats = new Set<string>();
  for (const family of HAZARD_FAMILIES) {
    for (const caveat of snapshot.families[family].caveats) caveats.add(caveat);
    for (const item of snapshot.families[family].items) {
      for (const caveat of item.relevance.caveats) caveats.add(caveat);
    }
  }
  /*
   * Sorted, so the same snapshot produces the same order. A `Set` preserves insertion order, which
   * follows family iteration and would therefore be stable anyway — but the copy block is hashed
   * as part of the response, and relying on that indirectly is how an ordering guarantee quietly
   * stops being one.
   */
  return [...caveats].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function windowLabel(window: ChangeWindow): string {
  switch (window) {
    case '6h':
      return 'in the last 6 hours';
    case '24h':
      return 'in the last 24 hours';
    case '7d':
      return 'in the last 7 days';
    case 'since':
      return 'since your last visit';
  }
}

/** "a", "a and b", "a, b and c" — Oxford-free, which is the house style in the docs. */
function list(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} and ${items[items.length - 1] ?? ''}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}
