/**
 * `GET /api/v1/events/{publicId}` — one canonical event, fully explained (ARCHITECTURE §13.1).
 *
 * §13.1's parameters are `as_of?` and `lat?,lon?`; a location adds relevance and distance and is
 * held to the same two-decimal rule as the briefing's. A merged id answers with a permanent
 * redirect to its survivor, carrying the caller's query so a replay stays a replay; everything
 * else about the event is `buildEventDetail`'s.
 */

import { CACHE_POLICIES, jsonResponse, redirectResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import {
  parseAsOf,
  parseLocation,
  parsePublicId,
  rejectUnknownParams,
} from '../../../../../lib/server/params.ts';
import { lastPathSegment } from '../../../../../lib/server/path.ts';
import { ApiProblemError } from '../../../../../lib/server/problem.ts';
import { getEventDetail } from '../../../../../lib/server/services.ts';

const ALLOWED = ['as_of', 'lat', 'lon'] as const;

export const GET = apiRoute(
  async ({ search, now, url }) => {
    rejectUnknownParams(search, ALLOWED);

    const raw = lastPathSegment(url);
    if (raw === null) {
      throw new ApiProblemError({
        code: 'VALIDATION_FAILED',
        detail: 'The event identifier is not decodable.',
        invalidParams: [{ name: 'publicId', reason: 'must be a GeoNerva public id' }],
      });
    }
    const publicId = parsePublicId(raw, 'canonical_event');
    const asOf = parseAsOf(search, now);
    // Only `lat`/`lon` are allowed here, so `parseLocation` can only take its coordinate branch.
    const location = search.has('lat') || search.has('lon') ? parseLocation(search) : null;

    const outcome = await getEventDetail(database().db, { publicId, asOf, now, location });
    if (outcome.kind === 'redirect') {
      return redirectResponse(
        `/api/v1/events/${outcome.publicId}${url.search}`,
        CACHE_POLICIES.eventDetail,
      );
    }
    return jsonResponse(outcome.detail, { cacheControl: CACHE_POLICIES.eventDetail });
  },
  { name: 'event-detail', rateLimit: 'default' },
);
