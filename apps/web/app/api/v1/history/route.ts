/**
 * `GET /api/v1/history` (ARCHITECTURE §8, §13.1).
 *
 * Baseline metrics and the series behind the charts. Cached for an hour when it answers for the
 * present: a baseline over ten years does not move in sixty minutes, and the current window's
 * count is the only part that can.
 *
 * **`as_of` is accepted**, though §13.1 does not list it. It shipped an `asOfContext` with a
 * replay horizon it could not honour, and the `/place?as_of=` page replayed its historical section
 * through this same service — so the page could ask a question the API refused, and no client
 * could reproduce a page GeoNerva serves (QA round 2, L-1). A replayed answer is immutable, so it
 * takes the replay cache policy rather than the one-hour one.
 */

import {
  CACHE_POLICIES,
  briefingCacheControl,
  isImmutableReplay,
  jsonResponse,
} from '../../../../lib/server/cache.ts';
import { database } from '../../../../lib/server/db.ts';
import { apiRoute } from '../../../../lib/server/handler.ts';
import {
  parseAsOf,
  parseHistory,
  parseLocation,
  rejectUnknownParams,
} from '../../../../lib/server/params.ts';
import { getHistory } from '../../../../lib/server/services.ts';

const ALLOWED = ['place', 'lat', 'lon', 'family', 'metric', 'radius_km', 'as_of'] as const;

export const GET = apiRoute(
  async ({ search, now }) => {
    rejectUnknownParams(search, ALLOWED);
    const location = parseLocation(search);
    const history = parseHistory(search);
    const asOf = parseAsOf(search, now);

    const response = await getHistory(database().db, { location, history, now, asOf });

    /*
     * A replayed answer is immutable and a live one is not, and the same helper the briefing route
     * uses decides which — so two endpoints cannot disagree about when a knowledge time is old
     * enough to cache for a day.
     */
    return jsonResponse(response, {
      cacheControl: isImmutableReplay(asOf, now)
        ? briefingCacheControl(asOf, now)
        : CACHE_POLICIES.history,
    });
  },
  { name: 'history', rateLimit: 'default' },
);
