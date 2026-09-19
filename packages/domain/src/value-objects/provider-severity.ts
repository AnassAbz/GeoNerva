/**
 * Provider severity (docs/DOMAIN_MODEL.md §1.4, §4.7).
 *
 * Provider semantics are **preserved, never translated**. A GDACS `Orange` stays `Orange` with
 * scheme `GDACS_ALERT`; it is never converted to a number, to a PAGER colour, or to GeoNerva's own
 * relevance level. The only thing GeoNerva derives is an *ordering within one scheme*, which is
 * what "escalated" and "de-escalated" mean in `What Changed?` (docs/ARCHITECTURE.md §10.2).
 */

import { z } from 'zod';

import { SEVERITY_SCHEMES, type SeverityScheme } from '../enums.ts';

/** A severity exactly as the provider expressed it, tagged with the scheme it belongs to. */
export interface ProviderSeverity {
  readonly scheme: SeverityScheme;
  /** The provider's verbatim value, e.g. `"Orange"`, `"yellow"`, `"Severe"`. */
  readonly value: string;
}

/**
 * Ordered values per scheme, lowest severity first. Comparison is only ever defined **within** a
 * scheme. Values are compared case-insensitively because providers are inconsistent about case
 * (`Orange` in GDACS event resources, `orange` in USGS PAGER).
 */
const SCHEME_ORDER: Readonly<Record<SeverityScheme, readonly string[]>> = {
  GDACS_ALERT: ['green', 'orange', 'red'],
  PAGER: ['green', 'yellow', 'orange', 'red'],
  ECCC_RISK_COLOUR: ['yellow', 'orange', 'red'],
  CAP_SEVERITY: ['unknown', 'minor', 'moderate', 'severe', 'extreme'],
};

export const providerSeveritySchema = z.object({
  scheme: z.enum(SEVERITY_SCHEMES),
  value: z.string().trim().min(1).max(64),
});

/**
 * Rank of a severity within its own scheme (0 = lowest), or `null` when the provider used a value
 * GeoNerva has not seen. An unknown value is never guessed at: callers must treat `null` as
 * "not comparable" and say so.
 */
export function providerSeverityRank(severity: ProviderSeverity): number | null {
  const order = SCHEME_ORDER[severity.scheme];
  const index = order.indexOf(severity.value.trim().toLowerCase());
  return index === -1 ? null : index;
}

/**
 * Compares two severities of the **same** scheme. Returns a negative number when `a` is less
 * severe, `0` when equal, a positive number when more severe, and `null` when the comparison is
 * undefined (different schemes, or a value outside the known order).
 */
export function compareProviderSeverity(a: ProviderSeverity, b: ProviderSeverity): number | null {
  if (a.scheme !== b.scheme) return null;
  const rankA = providerSeverityRank(a);
  const rankB = providerSeverityRank(b);
  if (rankA === null || rankB === null) return null;
  return rankA - rankB;
}

/** True when the value sits at or above `Orange`-equivalent severity in its own scheme. */
export function isElevatedSeverity(severity: ProviderSeverity): boolean {
  const rank = providerSeverityRank(severity);
  if (rank === null) return false;
  const order = SCHEME_ORDER[severity.scheme];
  const orangeIndex = order.indexOf(severity.scheme === 'CAP_SEVERITY' ? 'severe' : 'orange');
  return orangeIndex !== -1 && rank >= orangeIndex;
}

/** The known values of a scheme, lowest first. Exposed so tests can enumerate boundaries. */
export function severityScaleOf(scheme: SeverityScheme): readonly string[] {
  return SCHEME_ORDER[scheme];
}
