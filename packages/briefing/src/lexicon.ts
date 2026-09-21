/**
 * The banned lexicon (ARCHITECTURE §11.4, rule 5).
 *
 * Four classes of sentence GeoNerva must never produce, whoever wrote it:
 *
 *  - **Prediction.** "will occur", "likely to strike", "probability of". GeoNerva reports what has
 *    happened and how much attention it deserves. It does not forecast earthquakes, and no amount
 *    of hedging makes a sentence that does so acceptable.
 *  - **Safety.** "safe", "no risk", "nothing to worry about". This is the inverse of the
 *    availability lie and it is worse: "no relevant hazards were found" is a statement about
 *    GeoNerva's data, and "you are safe" is a statement about the world that GeoNerva is not
 *    entitled to make. A reader acts on the second.
 *  - **"wildfire" for a thermal detection.** VIIRS detects heat, not fire. A gas flare, a steel
 *    mill and a burning forest are the same pixel to the sensor, and §9.2's mandatory caveat says
 *    so — calling one a wildfire in the next sentence contradicts the caveat on the same card.
 *  - **"real-time".** Nothing here is real-time. Polling intervals are minutes to hours and the
 *    product says so everywhere else; the phrase promises a property the architecture does not
 *    have.
 *
 * ### Why this lives in `briefing` and is used twice
 *
 * §11.4 makes this a rule of the **AI validator**. But the deterministic templates are the
 * product's language when `AI_MODE=disabled`, which is the default — so the same prohibitions
 * apply to them, and a second implementation for the other caller would be exactly the duplicated
 * rule this codebase keeps refusing to write. One scanner, two callers: the templates are tested
 * against it, and the validator gates model output with it.
 */

/** One class of prohibited language. */
export const LEXICON_CLASSES = [
  'PREDICTION',
  'SAFETY',
  'THERMAL_AS_WILDFIRE',
  'REAL_TIME',
] as const;
export type LexiconClass = (typeof LEXICON_CLASSES)[number];

export interface LexiconHit {
  readonly lexiconClass: LexiconClass;
  /** The phrase as it was matched, lowercased. */
  readonly phrase: string;
  /** Where in the scanned text it started, so a caller can quote the surrounding sentence. */
  readonly index: number;
}

export interface LexiconOptions {
  /**
   * True when the text is about a `THERMAL_ACTIVITY` subject, which makes "wildfire" prohibited.
   *
   * Defaulting to `false` is deliberate: a briefing that legitimately discusses a GDACS
   * `WILDFIRE_EVENT` — an official burnt-area event — may use the word, and banning it everywhere
   * would make the honest sentence unsayable.
   */
  readonly thermalContext?: boolean;
  /**
   * Text GeoNerva is **relaying verbatim** rather than composing: provider caveats, coverage
   * notes, disclaimers, and official forecast wording.
   *
   * §11.4 grants this for prediction language — "unless quoting an official forecast field" —
   * because a cyclone track *is* a forecast and refusing to relay the issuing agency's words
   * would suppress the most actionable thing on the card. It applies to every class for the same
   * reason, which a real provider forced: FIRMS's own coverage note reads *"Near-real-time
   * detections arrive about three hours after the satellite overpass"*. That sentence **denies** a
   * real-time promise, and it is the provider's wording — scanning it as though GeoNerva had
   * written "real-time" would make the honest caveat unsayable and push the code toward
   * paraphrasing someone else's limitation.
   *
   * The exemption is narrow in two ways, and the second matters more than the first.
   *
   * **By match:** a hit is excused only when a supplied quote contains the phrase *and* that quote
   * appears verbatim in the scanned text, so it cannot launder a sentence GeoNerva wrote itself.
   *
   * **By class:** it applies **only** to `PREDICTION` and `REAL_TIME` — see `EXEMPTIBLE_CLASSES`.
   * A `SAFETY` claim or a thermal detection called a wildfire is never excusable, whoever wrote
   * the words.
   */
  readonly verbatimQuotes?: readonly string[];
}

/**
 * The classes a verbatim quote may excuse, and the two that it may never.
 *
 * `PREDICTION` is §11.4's own exemption: a cyclone track *is* a forecast and the issuing agency's
 * wording is the most actionable thing on the card. `REAL_TIME` was forced by FIRMS, whose
 * coverage note reads "Near-real-time detections arrive about three hours after the satellite
 * overpass" — a sentence that denies the very promise the class exists to forbid.
 *
 * `SAFETY` and `THERMAL_AS_WILDFIRE` are **never** exemptible, and excluding them is the point of
 * having a list at all:
 *
 *  - No provider caveat, disclaimer or forecast has a legitimate need to assert that the reader is
 *    safe. Allowing the exemption to reach this class would mean a string in a database column —
 *    or, if that column is ever populated from a provider feed, a string a provider controls —
 *    could excuse "you are safe" in generated text. That is the single most expensive sentence
 *    this system can emit, and no wording of a quote should be able to license it.
 *  - Calling a thermal detection a wildfire is a category error regardless of authorship. VIIRS
 *    detects heat; §9.2's mandatory caveat says so on the same card.
 *
 * Generalising the exemption to every class was the first implementation, and narrowing it is a
 * deliberate correction rather than an oversight being tidied: the broad version made a
 * configuration value into a security boundary.
 */
export const EXEMPTIBLE_CLASSES: ReadonlySet<LexiconClass> = new Set<LexiconClass>([
  'PREDICTION',
  'REAL_TIME',
]);

/**
 * Prohibited wording per class, in two forms.
 *
 * `phrases` are matched as **substrings** on a normalized copy, because hyphenation and spacing
 * vary and the failure mode is the phrase appearing at all: "real-time", "real time" and
 * "realtime" are the same promise.
 *
 * `words` are matched on **word boundaries**, because a bare word is the dangerous case and a
 * substring test on one is unusable. §11.4 rule 5 lists the safety class as `"safe", "no risk",
 * "nothing to worry"` — a bare `safe`. An earlier version of this file carried only multi-word
 * phrases, so *"Conditions near Marrakech appear safe"* passed every rule and could be published:
 * the one sentence this module exists to prevent, emittable because the list happened to contain
 * "you are safe" and not "safe". Boundaries keep "safety" and "unsafe" legal, which matters —
 * "follow your local authorities for safety information" is a sentence GeoNerva should be able to
 * write.
 */
const PHRASES: Readonly<Record<LexiconClass, readonly string[]>> = {
  PREDICTION: [
    'will occur',
    'will happen',
    'will strike',
    'will hit',
    'likely to strike',
    'likely to occur',
    'likely to hit',
    'probability of',
    'expected to hit',
    'expected to strike',
    'forecast to strike',
    'due for',
  ],
  SAFETY: [
    'you are safe',
    'you should be safe',
    'it is safe',
    'perfectly safe',
    'completely safe',
    'no risk',
    'zero risk',
    'not at risk',
    'nothing to worry',
    'no danger',
    'no threat',
    'no cause for concern',
    'no reason for concern',
    'nothing of concern',
    'nothing to be concerned',
    'you are fine',
    'you will be fine',
    'all clear',
    'out of danger',
    'not in danger',
    'little danger',
    'little risk',
    'low risk',
    'minimal risk',
    'no immediate',
    'nothing alarming',
  ],
  THERMAL_AS_WILDFIRE: ['wild fire', 'forest fire'],
  REAL_TIME: ['real-time', 'real time', 'realtime', 'live feed'],
};

/** Single words, matched on word boundaries. See the note on `PHRASES`. */
const WORDS: Readonly<Record<LexiconClass, readonly string[]>> = {
  PREDICTION: ['predict', 'predicts', 'prediction', 'imminent', 'overdue'],
  SAFETY: ['safe', 'harmless', 'reassuring'],
  THERMAL_AS_WILDFIRE: ['wildfire', 'wildfires', 'bushfire', 'bushfires'],
  REAL_TIME: [],
};

/**
 * Scans text for prohibited language.
 *
 * Normalization collapses whitespace and lowercases, and it replaces the typographic apostrophe
 * with the ASCII one, so that a phrase cannot be smuggled past by the punctuation a word
 * processor chose. It deliberately does **not** strip accents or collapse letters: doing so would
 * start matching innocent words, and the honest way to catch adversarial spellings is the
 * structured validation around this scanner rather than a cleverer regex.
 */
export function scanLexicon(text: string, options: LexiconOptions = {}): LexiconHit[] {
  const normalized = normalize(text);

  /*
   * The exemption is **position-sensitive**, which the first implementation was not.
   *
   * It used to ask whether the text contained an exempt quote *somewhere*, and then excused every
   * occurrence of the phrase in the whole text. So relaying FIRMS's "Near-real-time detections
   * arrive about three hours after the satellite overpass" excused a *second*, fabricated sentence
   * — "GeoNerva provides real-time coverage" — in the same paragraph, which is exactly the
   * laundering the doc comment claimed was impossible. Spans are computed first, and a hit is
   * excused only when its own index falls inside one.
   */
  const spans: { readonly start: number; readonly end: number; readonly quote: string }[] = [];
  for (const raw of options.verbatimQuotes ?? []) {
    const quote = normalize(raw);
    if (quote === '') continue;
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(quote, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + quote.length, quote });
      from = at + quote.length;
    }
  }

  const hits: LexiconHit[] = [];
  for (const lexiconClass of LEXICON_CLASSES) {
    if (lexiconClass === 'THERMAL_AS_WILDFIRE' && options.thermalContext !== true) continue;

    for (const { phrase, index } of occurrences(normalized, lexiconClass)) {
      const exempt =
        EXEMPTIBLE_CLASSES.has(lexiconClass) &&
        spans.some(
          (span) =>
            index >= span.start && index + phrase.length <= span.end && span.quote.includes(phrase),
        );
      if (!exempt) hits.push({ lexiconClass, phrase, index });
    }
  }

  return hits.sort((left, right) => left.index - right.index || compare(left.phrase, right.phrase));
}

/** Every prohibited phrase and word occurrence of one class, with its position. */
function occurrences(
  normalized: string,
  lexiconClass: LexiconClass,
): { readonly phrase: string; readonly index: number }[] {
  const found: { phrase: string; index: number }[] = [];

  for (const phrase of PHRASES[lexiconClass]) {
    let from = 0;
    for (;;) {
      const index = normalized.indexOf(phrase, from);
      if (index === -1) break;
      found.push({ phrase, index });
      from = index + phrase.length;
    }
  }

  for (const word of WORDS[lexiconClass]) {
    /*
     * Boundaries by inspection rather than by a constructed `RegExp`: the word list is source
     * code, but building a pattern from a string is the habit that eventually meets a value from
     * configuration, and a regex metacharacter there is an injection.
     */
    let from = 0;
    for (;;) {
      const index = normalized.indexOf(word, from);
      if (index === -1) break;
      from = index + word.length;
      if (isWordBounded(normalized, index, word.length)) found.push({ phrase: word, index });
    }
  }

  return found;
}

function isWordBounded(text: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : (text[index - 1] ?? '');
  const after = text[index + length] ?? '';
  const isLetter = (character: string): boolean => /[\p{L}\p{N}]/u.test(character);
  return !isLetter(before) && !isLetter(after);
}

/** Lowercased, apostrophe-folded, whitespace-collapsed. Positions are indices into this form. */
function normalize(text: string): string {
  return text.toLowerCase().replaceAll('\u2019', "'").replace(/\s+/gu, ' ');
}

/** Convenience for the templates' own tests and for the validator's gate. */
export function isLexiconClean(text: string, options: LexiconOptions = {}): boolean {
  return scanLexicon(text, options).length === 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
