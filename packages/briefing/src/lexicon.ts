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
   * The exemption is deliberately narrow: a hit is excused only when a supplied quote contains
   * the phrase **and** that quote appears verbatim in the scanned text. It cannot launder a
   * sentence GeoNerva wrote itself, and for model output it can only ever cover strings the
   * validator already knows came from the packet.
   */
  readonly verbatimQuotes?: readonly string[];
}

/**
 * Phrases per class.
 *
 * Matched as substrings on a normalized copy of the text. Substrings rather than word boundaries
 * because the failure mode is a phrase appearing at all, and hyphenation and punctuation vary:
 * "real-time", "real time" and "realtime" are the same promise.
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
    'predict',
    'prediction',
    'imminent',
    'due for',
    'overdue',
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
    'no cause for concern',
    'no reason for concern',
    'all clear',
  ],
  THERMAL_AS_WILDFIRE: ['wildfire', 'wild fire', 'forest fire', 'bushfire'],
  REAL_TIME: ['real-time', 'real time', 'realtime', 'live feed'],
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
  const normalized = text.toLowerCase().replaceAll('’', "'").replace(/\s+/gu, ' ');
  const exemptions = (options.verbatimQuotes ?? []).map((quote) =>
    quote.toLowerCase().replaceAll('’', "'").replace(/\s+/gu, ' '),
  );

  const hits: LexiconHit[] = [];
  for (const lexiconClass of LEXICON_CLASSES) {
    if (lexiconClass === 'THERMAL_AS_WILDFIRE' && options.thermalContext !== true) continue;

    for (const phrase of PHRASES[lexiconClass]) {
      let from = 0;
      for (;;) {
        const index = normalized.indexOf(phrase, from);
        if (index === -1) break;
        from = index + phrase.length;
        /*
         * A phrase inside relayed verbatim text is allowed, and only there. The check is that some
         * supplied quote contains the phrase *and* appears in the scanned text — so relaying a
         * provider's wording is fine while writing the same words outside a quote is not.
         */
        const exempt = exemptions.some(
          (quote) => quote.includes(phrase) && normalized.includes(quote),
        );
        if (!exempt) hits.push({ lexiconClass, phrase, index });
      }
    }
  }

  return hits.sort((left, right) => left.index - right.index || compare(left.phrase, right.phrase));
}

/** Convenience for the templates' own tests and for the validator's gate. */
export function isLexiconClean(text: string, options: LexiconOptions = {}): boolean {
  return scanLexicon(text, options).length === 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
