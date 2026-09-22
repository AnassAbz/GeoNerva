/**
 * `GET /api/v1/places/suggest` — type-ahead from the local GeoNames table (ARCHITECTURE §13.1,
 * ADR-013). Nothing here calls a provider: a keystroke never leaves the server.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { parseLimit, parseQuery, rejectUnknownParams } from '../../../../../lib/server/params.ts';
import {
  DEFAULT_SUGGESTIONS,
  MAX_SUGGESTIONS,
  getPlaceSuggestions,
} from '../../../../../lib/server/places.ts';

const ALLOWED = ['q', 'limit'] as const;

export const GET = apiRoute(
  async ({ search }) => {
    rejectUnknownParams(search, ALLOWED);
    const query = parseQuery(search);
    const limit = parseLimit(search, { max: MAX_SUGGESTIONS, fallback: DEFAULT_SUGGESTIONS });
    const response = await getPlaceSuggestions(database().db, { query, limit });
    return jsonResponse(response, { cacheControl: CACHE_POLICIES.places });
  },
  { name: 'places-suggest', rateLimit: 'default' },
);
