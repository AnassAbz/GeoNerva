/**
 * `GET /api/v1/history` (ARCHITECTURE §8, §13.1).
 *
 * Baseline metrics and the series behind the charts. No `as_of` — §13.1 lists none — so the answer
 * is for the present and cached for an hour: a baseline over ten years does not move in sixty
 * minutes, and the current window's count is the only part that can.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../lib/server/cache.ts';
import { database } from '../../../../lib/server/db.ts';
import { apiRoute } from '../../../../lib/server/handler.ts';
import { parseHistory, parseLocation, rejectUnknownParams } from '../../../../lib/server/params.ts';
import { getHistory } from '../../../../lib/server/services.ts';

const ALLOWED = ['place', 'lat', 'lon', 'family', 'metric', 'radius_km'] as const;

export const GET = apiRoute(
  async ({ search, now }) => {
    rejectUnknownParams(search, ALLOWED);
    const location = parseLocation(search);
    const history = parseHistory(search);

    const response = await getHistory(database().db, { location, history, now });

    return jsonResponse(response, { cacheControl: CACHE_POLICIES.history });
  },
  { name: 'history', rateLimit: 'default' },
);
