/**
 * The replay horizon: how far back a knowledge time may go, per family (ADR-035, ARCHITECTURE §12).
 *
 * Retention is a profile, not a promise of an unbounded archive, and what the product owes its
 * users is a **stated** horizon rather than a silent one. The rule ADR-035 sets is specific:
 *
 * > After the window a replay must report *"outside the indexed window"*, never an empty result.
 *
 * An empty result there would be the system saying nothing happened when what it means is that it
 * no longer remembers — the same class of error as an outage rendered as reassurance, arriving
 * through the retention policy instead of through a feed.
 *
 * Every number below is a retention figure that exists elsewhere in the design; none is chosen
 * here. Where a family's horizon depends on the *content* — earthquakes below M4.5 are dropped
 * while M ≥ 4.5 is kept forever — the horizon is the conservative one, because a horizon a user
 * can rely on is the one that holds for everything the card might show.
 */

import { HAZARD_FAMILIES, type HazardFamily, type ReplayHorizon } from '@geonerva/domain';

/** Retention windows, in days, for the parts of the store each family reads. */
const WINDOW_DAYS: Readonly<Record<'lean' | 'standard', Readonly<Record<HazardFamily, number>>>> = {
  /*
   * Lean (Supabase Free, the v1 choice — owner decision Q2):
   *  - earthquakes below M4.5 are pruned after 30 days (ADR-035);
   *  - fire detections live in daily partitions dropped at 72 hours (ARCHITECTURE §12);
   *  - GDACS families are normalized facts, kept forever, but the backfill reaches five years.
   */
  lean: {
    EARTHQUAKES: 30,
    FIRE_ACTIVITY: 3,
    FLOODS: 5 * 365,
    CYCLONES: 5 * 365,
    WEATHER_ALERTS: 30,
    OTHER: 5 * 365,
  },
  /** Standard (≥ 8 GB): 2 years of small-earthquake history, 30 days of detections. */
  standard: {
    EARTHQUAKES: 2 * 365,
    FIRE_ACTIVITY: 30,
    FLOODS: 5 * 365,
    CYCLONES: 5 * 365,
    WEATHER_ALERTS: 2 * 365,
    OTHER: 5 * 365,
  },
};

const NOTES: Readonly<Record<HazardFamily, string>> = {
  EARTHQUAKES:
    'Earthquakes of M4.5 and above are kept indefinitely; smaller ones are dropped after this window, so a replay from before it shows only the larger events.',
  FIRE_ACTIVITY:
    'Thermal detections are kept for a short window only; a replay from before it cannot show fire activity.',
  FLOODS: 'Flood records reach back about five years.',
  CYCLONES: 'Cyclone records reach back about five years.',
  WEATHER_ALERTS: 'No weather-warning source is enabled, so there is nothing to replay.',
  OTHER: 'Volcano and drought records reach back about five years.',
};

/**
 * The horizon as of a given knowledge time.
 *
 * It is computed from `asOf` rather than from the wall clock so that the value is a property of
 * the response rather than of the moment it was built: two builds of the same snapshot must agree
 * on everything, and a horizon that crept forward between them would change the content hash for
 * no reason a reader could see.
 */
export function replayHorizonFor(profile: 'lean' | 'standard', asOf: Date): ReplayHorizon {
  const windows = WINDOW_DAYS[profile];
  const byFamily = {} as Record<
    HazardFamily,
    { readonly earliestAsOf: string; readonly note: string }
  >;
  for (const family of HAZARD_FAMILIES) {
    const earliest = new Date(asOf.getTime() - windows[family] * 24 * 60 * 60 * 1000);
    byFamily[family] = { earliestAsOf: earliest.toISOString(), note: NOTES[family] };
  }
  return { profile, byFamily };
}
