/**
 * `AttributionRow` → `Attribution`.
 *
 * Its own module because two unrelated responses need it — the data-status page and every evidence
 * detail — and because the mapping is not optional: several providers' terms require the
 * attribution text and the disclaimer **verbatim**, which is why both are columns rather than
 * something a UI composes. A second copy of this function is a second chance to paraphrase a
 * licence.
 */

import type { Attribution } from '@geonerva/domain';

import type { AttributionRow } from './db.ts';

export function toAttribution(row: AttributionRow): Attribution {
  return {
    sourceId: row.source_id,
    name: row.name,
    homepage: row.homepage,
    licence: row.licence,
    attributionText: row.attribution_text,
    termsUrl: row.terms_url,
    disclaimer: row.disclaimer,
  };
}
