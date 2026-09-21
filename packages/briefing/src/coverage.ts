/**
 * Family coverage for one place: what GeoNerva can and cannot say here, before any data is read.
 *
 * Coverage is the first of the three axes availability resolves from, and it is the one that is
 * true regardless of how the polling went. A weather-warning card in Marrakech is `NOT_COVERED`
 * because ECCC is Canada-only; that is a fact about the source set, and rendering it as "no
 * warnings" would be a claim GeoNerva is not entitled to make.
 *
 * The rule is derived from configuration — hazard types on products, the coverage polygon on the
 * source — and never from a hard-coded list of source ids (ARCHITECTURE §3, rule 4). Adding a
 * European flood source would change these cards without a line of code here.
 *
 * ### A completeness caveat is not partial coverage [P6 review]
 *
 * These are two different facts and an earlier version of this file conflated them. Every seeded
 * source carries a `coverage_note` — USGS's "complete only from about M4.5 outside the United
 * States", EMSC's denser European network — and treating any note as `PARTIAL` made **every
 * family at every location on Earth** permanently partial. That is not a harmless
 * over-cautiousness: `resolveAvailability` reports `PARTIAL_COVERAGE` before it can ever reach
 * `NOTHING_TO_REPORT` or `OK`, and `resolveDataConfidence` returns `LOW` unconditionally for
 * partial coverage — so `MEDIUM` and `HIGH` became unreachable and the `corroborated` input, which
 * the whole independent-source count exists to feed, could no longer change any outcome.
 *
 * `PARTIAL` now means what the name says: **some of this family is covered here and some is not**,
 * which is a property of the hazard types and the coverage polygons. A provider's caveat about the
 * completeness of its own catalogue is a **caveat**: it travels with the card, it is always
 * rendered, and it does not silence three other axes.
 */

import {
  HAZARD_TYPES_BY_FAMILY,
  HAZARD_FAMILIES,
  type CoverageLevel,
  type FamilyCoverage,
  type HazardFamily,
} from '@geonerva/domain';
import type { ProductCoverageRow } from '@geonerva/db/asof';

/** One product that feeds a family here, after coverage has been resolved. */
export interface FamilySource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly productId: number;
  readonly productCode: string;
}

export interface FamilyCoverageResult {
  readonly coverage: FamilyCoverage;
  /** Products that cover this place for this family. Empty when nothing does. */
  readonly sources: readonly FamilySource[];
  /** Products for this family that exist but do not reach here, so a note can name the gap. */
  readonly outOfAreaSources: readonly FamilySource[];
  /**
   * The contributing providers' own completeness caveats, verbatim.
   *
   * Rendered on the card, never summarized: the limitation belongs to the provider, and
   * paraphrasing it would put GeoNerva's words on their caveat.
   */
  readonly notes: readonly string[];
  /** Hazard types in this family that no product covers here. Empty means the family is whole. */
  readonly uncoveredHazardTypes: readonly string[];
}

/**
 * Resolves coverage for every family at one place.
 *
 * A product counts only when it is enabled, its source is enabled, it is not retired, and its
 * coverage reaches the point. A disabled product is not a coverage gap the user caused and not
 * one they can do anything about — but it is still a gap, and saying "covered" because a row
 * exists in a table would make the card claim a source that is not running.
 */
export function resolveCoverage(
  rows: readonly ProductCoverageRow[],
  asOf: Date,
): Readonly<Record<HazardFamily, FamilyCoverageResult>> {
  const byFamily = {} as Record<HazardFamily, FamilyCoverageResult>;

  for (const family of HAZARD_FAMILIES) {
    const hazardTypes = HAZARD_TYPES_BY_FAMILY[family];
    const wanted = new Set<string>(hazardTypes);
    const forFamily = rows.filter((row) =>
      row.hazard_types.some((hazardType) => wanted.has(hazardType)),
    );
    const usable = forFamily.filter((row) => isOperating(row, asOf));
    const here = usable.filter((row) => row.covers_point);
    const elsewhere = usable.filter((row) => !row.covers_point);

    /*
     * A hazard type with no product covering this place is a real gap in the family, and it is
     * what `PARTIAL` is for. `OTHER` holds volcanoes, droughts, tsunamis and a catch-all; GDACS
     * covers the first two and nothing covers the rest, so a card claiming to report "volcanoes
     * and droughts" must not also imply it would have told you about a tsunami.
     */
    const covered = new Set(here.flatMap((row) => row.hazard_types));
    const uncoveredHazardTypes = hazardTypes.filter((hazardType) => !covered.has(hazardType));
    const notes = [...new Set(here.map((row) => row.coverage_note).filter(isPresent))].sort();

    byFamily[family] = {
      coverage: coverageOf(family, here, elsewhere, uncoveredHazardTypes),
      sources: here.map(sourceOf),
      outOfAreaSources: elsewhere.map(sourceOf),
      notes,
      uncoveredHazardTypes,
    };
  }

  return byFamily;
}

/**
 * Whether a product was operating at the knowledge time.
 *
 * `active_from` is why this takes `asOf` at all: NOAA-21 launched in 2023, so a replay of 2020
 * that counted it as covering fire activity would report a satellite that was not in orbit — and
 * would then render the resulting emptiness as an observation.
 */
function isOperating(row: ProductCoverageRow, asOf: Date): boolean {
  if (!row.source_enabled || !row.product_enabled || row.product_status === 'RETIRED') return false;
  if (row.active_from !== null && row.active_from.getTime() > asOf.getTime()) return false;
  if (row.active_to !== null && row.active_to.getTime() < asOf.getTime()) return false;
  return true;
}

function sourceOf(row: ProductCoverageRow): FamilySource {
  return {
    sourceId: row.source_id,
    sourceName: row.source_name,
    productId: row.product_id,
    productCode: row.product_code,
  };
}

/**
 * The coverage level and the sentence that must accompany anything less than full coverage.
 *
 * `PARTIAL` is not a lesser `COVERED`: it changes what an *absence* means, which is why the note
 * is mandatory. "No earthquakes reported" from a catalogue that is only complete above M4.5 is a
 * different statement from the same sentence in a densely instrumented region, and the user has
 * no way to tell them apart unless the card says so.
 */
function coverageOf(
  family: HazardFamily,
  here: readonly ProductCoverageRow[],
  elsewhere: readonly ProductCoverageRow[],
  uncoveredHazardTypes: readonly string[],
): FamilyCoverage {
  if (here.length === 0) {
    return {
      level: 'NOT_COVERED' satisfies CoverageLevel,
      note:
        elsewhere.length === 0
          ? `GeoNerva has no source for ${familyWords(family)}.`
          : `The ${familyWords(family)} source GeoNerva uses does not cover this area.`,
    };
  }

  if (uncoveredHazardTypes.length > 0) {
    return {
      level: 'PARTIAL' satisfies CoverageLevel,
      note: `Part of this category is not covered here: ${uncoveredHazardTypes
        .map((hazardType) => hazardType.toLowerCase().replaceAll('_', ' '))
        .sort()
        .join(', ')}.`,
    };
  }

  return { level: 'COVERED' satisfies CoverageLevel, note: null };
}

function isPresent(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

/** The family, in the words the card uses. */
export function familyWords(family: HazardFamily): string {
  switch (family) {
    case 'EARTHQUAKES':
      return 'earthquakes';
    case 'FIRE_ACTIVITY':
      return 'fire activity';
    case 'FLOODS':
      return 'floods';
    case 'CYCLONES':
      return 'tropical cyclones';
    case 'WEATHER_ALERTS':
      return 'weather warnings';
    case 'OTHER':
      return 'volcanoes and droughts';
  }
}
