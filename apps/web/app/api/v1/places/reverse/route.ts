/**
 * `GET /api/v1/places/reverse` — a label for a rounded coordinate (ARCHITECTURE §13.1).
 *
 * The coordinate must arrive already rounded to two decimals, as for a briefing: a precise
 * position in this URL would be a person's location in a CDN key and a platform log (ADR-015).
 * A cache miss calls Nominatim under the same global ceiling as `/places/search`.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { parseLocation, rejectUnknownParams } from '../../../../../lib/server/params.ts';
import { reversePlace } from '../../../../../lib/server/places.ts';

const ALLOWED = ['lat', 'lon'] as const;

export const GET = apiRoute(
  async ({ search, now, request }) => {
    rejectUnknownParams(search, ALLOWED);
    // `place` is not allowed here, so `parseLocation` can only take its coordinate branch.
    const location = parseLocation(search);
    if (location.kind !== 'coordinates') throw new Error('unreachable: reverse takes coordinates');
    const response = await reversePlace(database().db, {
      lat: location.lat,
      lon: location.lon,
      now,
      headers: request.headers,
    });
    return jsonResponse(response, { cacheControl: CACHE_POLICIES.places });
  },
  { name: 'places-reverse', rateLimit: 'default' },
);
