/**
 * `GET /api/v1/sources/status` (ARCHITECTURE §13.1, §14).
 *
 * The endpoint behind `/data-status`, and the one a free external uptime monitor may poll. It takes
 * `as_of` for the same reason a briefing does: health is derived rather than stored (ADR-022), so
 * asking what GeoNerva knew about a source at 12:10 is the same query at a different knowledge
 * time.
 *
 * The horizon guard that `/briefing` applies is deliberately **not** applied here. A knowledge time
 * older than the retention profile can answer for still has a true answer for this endpoint —
 * "GeoNerva committed no runs that long ago and therefore knew nothing" is a fact about the
 * sources, not a gap in a hazard assessment — and refusing it would hide the very boundary the
 * page exists to show.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { parseAsOf, rejectUnknownParams } from '../../../../../lib/server/params.ts';
import { getSourceStatus } from '../../../../../lib/server/services.ts';

const ALLOWED = ['as_of'] as const;

export const GET = apiRoute(
  async ({ search, now }) => {
    rejectUnknownParams(search, ALLOWED);
    const asOf = parseAsOf(search, now);

    const status = await getSourceStatus(database().db, { asOf, now });

    /*
     * A fixed sixty seconds, from §13.1 — not the replay split `/briefing` uses.
     *
     * A replay of this endpoint *is* immutable in principle, but the response also carries the
     * source *catalogue*, which is reference data updated in place and therefore not immutable at
     * any knowledge time. Caching a replay for a day would pin a retired product's description
     * for a day. Sixty seconds is correct for both cases, and being right matters more here than
     * the cache hit does.
     */
    return jsonResponse(status, { cacheControl: CACHE_POLICIES.sourcesStatus });
  },
  { name: 'sources-status' },
);
