/**
 * Presentation metadata per hazard family: display label, the order cards appear in, and the
 * shape + pattern + colour the map and legend use (docs/PRODUCT.md §6.2, §6.5).
 */

import { EARTHQUAKE_BASELINE, FIRE_TREND, GDACS_CONTEXT } from '@geonerva/baselines';
import type { HazardFamily } from '@geonerva/domain';

import { PALETTE } from './palette.ts';

export type FamilyShape = 'circle' | 'triangle' | 'square' | 'diamond' | 'hexagon' | 'bar';
export type FamilyPattern = 'solid' | 'hatched' | 'dashed' | 'dotted';

export interface FamilyMeta {
  readonly label: string;
  /** Lower-case words for use inside a sentence. */
  readonly words: string;
  /** What cannot be confirmed absent when the family's source is unavailable. */
  readonly absenceNoun: string;
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
    color: PALETTE.weather,
    token: 'weather',
    shape: 'bar',
    pattern: 'solid',
    mapped: false,
  },
};

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
