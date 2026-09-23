/**
 * Presentation metadata per hazard family: display label, the order cards appear in, and the
 * shape + pattern + colour the map and legend use (docs/PRODUCT.md §6.2, §6.5).
 */

import { EARTHQUAKE_BASELINE, FIRE_TREND, GDACS_CONTEXT } from '@geonerva/baselines';
import { FAMILY_GRAMMAR, type HazardFamily } from '@geonerva/domain';

import { PALETTE } from './palette.ts';

export type FamilyShape = 'circle' | 'triangle' | 'square' | 'diamond' | 'hexagon' | 'bar';
export type FamilyPattern = 'solid' | 'hatched' | 'dashed' | 'dotted';

export interface FamilyMeta {
  readonly label: string;
  /** Lower-case words for use inside a sentence. */
  readonly words: string;
  /**
   * True when `words` takes a plural verb.
   *
   * "Earthquakes **are** not covered here" and "Fire activity **is** not covered here" are both
   * right, and a sentence builder cannot tell which from the label. Choosing the verb from the
   * *number of families* in the sentence instead produced "Weather warnings is not covered here"
   * (QA round 2, L-3), so the grammatical number is recorded here beside the words it belongs to.
   */

  /**
   * The countable noun for **one** of the things this family lists, singular and plural.
   *
   * `words` names the family; this names an item of it. The two are not interchangeable, and
   * treating them as one is L-3: the situation strip pluralised the family label and suffixed
   * "items" — "5 earthquakes items, 1 fire activity item and 1 floods item". A count needs a noun
   * that can be counted, which is this one: "5 earthquakes", "1 fire activity cluster",
   * "1 flood event".
   */

  /** What cannot be confirmed absent when the family's source is unavailable. */
  readonly absenceNoun: string;
  /**
   * What the distance printed beside an item of this family is measured **to**: a phrase short
   * enough to sit in a table cell, and one that completes "Measured …".
   *
   * Every family measures to something different — an epicentre, the nearest thermal detection in
   * a cluster, the edge of a modelled area — and the number alone does not say which (QA round 2,
   * L-5). `/methodology` publishes the same rules from the relevance configuration; this is that
   * fact at the place the number is shown. Which *source's* position an earthquake's epicentre is
   * cannot be stated from the contract, so `COPY.card.distanceMayMove` says only what the
   * response supports.
   */
  readonly distanceBasis: string;
  readonly color: string;
  /** Tailwind colour token (see globals.css). */
  readonly token: 'eq' | 'fire' | 'flood' | 'cyclone' | 'other' | 'weather';
  readonly shape: FamilyShape;
  readonly pattern: FamilyPattern;
  /** True when the family is drawn on the map. Weather alerts have no v1 source. */
  readonly mapped: boolean;
}

/** Card order on the dashboard (PRODUCT §6.2 row 4). */
export const FAMILY_ORDER: readonly HazardFamily[] = [
  'EARTHQUAKES',
  'FIRE_ACTIVITY',
  'FLOODS',
  'CYCLONES',
  'OTHER',
  'WEATHER_ALERTS',
];

export const FAMILY_META: Readonly<Record<HazardFamily, FamilyMeta>> = {
  EARTHQUAKES: {
    label: 'Earthquakes',
    words: 'earthquakes',
    absenceNoun: 'earthquakes',
    distanceBasis: 'to the epicentre',
    color: PALETTE.eq,
    token: 'eq',
    shape: 'circle',
    pattern: 'solid',
    mapped: true,
  },
  FIRE_ACTIVITY: {
    label: 'Fire activity',
    words: 'fire activity',
    absenceNoun: 'thermal detections',
    distanceBasis: 'to the nearest thermal detection',
    color: PALETTE.fire,
    token: 'fire',
    shape: 'triangle',
    pattern: 'solid',
    mapped: true,
  },
  FLOODS: {
    label: 'Floods',
    words: 'floods',
    absenceNoun: 'flood events',
    distanceBasis: 'to the flood area GDACS modelled',
    color: PALETTE.flood,
    token: 'flood',
    shape: 'square',
    pattern: 'hatched',
    mapped: true,
  },
  CYCLONES: {
    label: 'Cyclones',
    words: 'tropical cyclones',
    absenceNoun: 'tropical cyclones',
    distanceBasis: 'to the cyclone track',
    color: PALETTE.cyclone,
    token: 'cyclone',
    shape: 'hexagon',
    pattern: 'dashed',
    mapped: true,
  },
  OTHER: {
    label: 'Volcanoes & other',
    words: 'volcanoes and droughts',
    absenceNoun: 'volcano or drought events',
    distanceBasis: 'to the event location',
    color: PALETTE.other,
    token: 'other',
    shape: 'diamond',
    pattern: 'dotted',
    mapped: true,
  },
  WEATHER_ALERTS: {
    label: 'Weather alerts',
    words: 'weather warnings',
    absenceNoun: 'weather warnings',
    distanceBasis: 'to the warning area',
    color: PALETTE.weather,
    token: 'weather',
    shape: 'bar',
    pattern: 'solid',
    mapped: false,
  },
};

/**
 * The family as the subject of a sentence, with a verb that agrees with it.
 *
 * The verb comes from the family's own grammatical number, never from how many families a
 * sentence happens to mention — which is the bug behind "Weather warnings is not covered here"
 * (QA round 2, L-3). Every sentence the UI writes about one family goes through here, so there is
 * one place the agreement can be wrong and one place to fix it.
 */
export function familySubject(family: HazardFamily): {
  readonly subject: string;
  readonly verb: 'is' | 'are';
} {
  /*
   * The grammar comes from `@geonerva/domain`, not from a table here. `packages/briefing` writes
   * the read model's sentences and this file writes the UI's, and a second copy of the vocabulary
   * is how "Fire activity are not covered" got published in the first place (QA round 2, L-3).
   */
  const grammar = FAMILY_GRAMMAR[family];
  return {
    subject: grammar.words.charAt(0).toUpperCase() + grammar.words.slice(1),
    verb: grammar.plural ? 'are' : 'is',
  };
}

/** Families drawn on the map, in card order. */
export const MAPPED_FAMILIES: readonly HazardFamily[] = FAMILY_ORDER.filter(
  (family) => FAMILY_META[family].mapped,
);

/**
 * Radius rings drawn around the location, per family, in km: the radius each family's context is
 * computed over.
 *
 * Every value is the exported constant the engine itself uses, so a ring on the map and the
 * radius `/methodology` states are the same number by construction rather than by agreement. The
 * three GDACS families share `GDACS_CONTEXT.radiusKm` because that is the one radius their context
 * metric is counted over (ARCHITECTURE §8.3).
 */
export const FAMILY_RING_KM: Readonly<Partial<Record<HazardFamily, number>>> = {
  EARTHQUAKES: EARTHQUAKE_BASELINE.defaultRadiusKm,
  FIRE_ACTIVITY: FIRE_TREND.radiusKm,
  FLOODS: GDACS_CONTEXT.radiusKm,
  CYCLONES: GDACS_CONTEXT.radiusKm,
  OTHER: GDACS_CONTEXT.radiusKm,
};
