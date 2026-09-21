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
 */

import {
  HAZARD_TYPES_BY_FAMILY,
  HAZARD_FAMILIES,
  type CoverageLevel,
  type FamilyCoverage,
  type HazardFamily,
} from '@geonerva/domain';
import type { ProductCoverageRow } from '@geonerva/db';

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
): Readonly<Record<HazardFamily, FamilyCoverageResult>> {
  const byFamily = {} as Record<HazardFamily, FamilyCoverageResult>;

  for (const family of HAZARD_FAMILIES) {
    const hazardTypes = new Set<string>(HAZARD_TYPES_BY_FAMILY[family]);
    const forFamily = rows.filter((row) =>
      row.hazard_types.some((hazardType) => hazardTypes.has(hazardType)),
    );
    const usable = forFamily.filter(
      (row) => row.source_enabled && row.product_enabled && row.product_status !== 'RETIRED',
    );
    const here = usable.filter((row) => row.covers_point);
    const elsewhere = usable.filter((row) => !row.covers_point);

    byFamily[family] = {
      coverage: coverageOf(family, here, elsewhere),
      sources: here.map(sourceOf),
      outOfAreaSources: elsewhere.map(sourceOf),
    };
  }

  return byFamily;
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

  /*
   * A completeness caveat on any contributing source makes the family `PARTIAL`.
   *
   * The note is the provider's own wording from `sources.coverage_note` — "complete only from
   * about M4.5 outside the United States" — rather than a summary of it, because the limitation
   * belongs to the provider and paraphrasing it would put GeoNerva's words on their caveat.
   */
  const notes = [...new Set(here.map((row) => row.coverage_note).filter(isPresent))].sort();
  if (notes.length > 0) {
    return { level: 'PARTIAL' satisfies CoverageLevel, note: notes.join(' ') };
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
