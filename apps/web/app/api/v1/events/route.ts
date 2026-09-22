/**
 * `GET /api/v1/events` — map features for a viewport (ARCHITECTURE §7.5, §13.1).
 *
 * A thin adapter, like every route here. The viewport rules live in `parseViewport`, the horizon
 * rule in `getEvents`, and the features in `@geonerva/briefing`'s `buildMapFeatures`.
 *
 * The cache policy is §13.1's fixed two minutes at every knowledge time, not the briefing's replay
 * split. §13.1 gives this endpoint no replay row, and two minutes is correct for both cases —
 * a replayed map is a cheap query, and being wrong about immutability is the error that cost the
 * evidence endpoint a HIGH finding.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../lib/server/cache.ts';
import { database } from '../../../../lib/server/db.ts';
import { apiRoute } from '../../../../lib/server/handler.ts';
import {
  parseAsOf,
  parseFamilies,
  parseViewport,
  rejectUnknownParams,
} from '../../../../lib/server/params.ts';
import { getEvents } from '../../../../lib/server/services.ts';

/** §13.1's parameters for this endpoint: `bbox`, `zoom`, `families[]`, `as_of?`. */
const ALLOWED = ['bbox', 'zoom', 'families', 'as_of'] as const;

export const GET = apiRoute(
  async ({ search, now }) => {
    rejectUnknownParams(search, ALLOWED);

    const viewport = parseViewport(search);
    const families = parseFamilies(search);
    const asOf = parseAsOf(search, now);

    const response = await getEvents(database().db, { viewport, families, asOf, now });

    return jsonResponse(response, { cacheControl: CACHE_POLICIES.events });
  },
  { name: 'events', rateLimit: 'default' },
);
