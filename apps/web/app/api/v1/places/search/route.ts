/**
 * `GET /api/v1/places/search` — submit-time geocoding through Nominatim, cached for 30 days and
 * held to one provider request per second across the deployment (ARCHITECTURE §13.1, §13.4).
 *
 * The per-caller limit is §13.4's 10 a minute, and it **fails closed**: if the counter cannot be
 * written, the request is refused rather than allowed through to a provider that bans abusers.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { parseQuery, rejectUnknownParams } from '../../../../../lib/server/params.ts';
import { searchPlaces } from '../../../../../lib/server/places.ts';

const ALLOWED = ['q'] as const;

export const GET = apiRoute(
  async ({ search, now, request }) => {
    rejectUnknownParams(search, ALLOWED);
    const query = parseQuery(search);
    const response = await searchPlaces(database().db, { query, now, headers: request.headers });
    return jsonResponse(response, { cacheControl: CACHE_POLICIES.places });
  },
  { name: 'places-search', rateLimit: 'placesSearch', failClosed: true },
);
