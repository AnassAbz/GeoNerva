/**
 * `GET /api/v1/fire-clusters/{publicId}` — one area of thermal activity (ARCHITECTURE §13.1).
 *
 * §13.1 gives this endpoint `as_of?` and nothing else, so it takes no location and serves no
 * relevance, although `FireClusterDetail` can carry one; a location parameter is refused like any
 * other unknown one rather than accepted beyond the specification. A merged id redirects to its
 * survivor, as an event's does.
 */

import { CACHE_POLICIES, jsonResponse, redirectResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { parseAsOf, parsePublicId, rejectUnknownParams } from '../../../../../lib/server/params.ts';
import { lastPathSegment } from '../../../../../lib/server/path.ts';
import { ApiProblemError } from '../../../../../lib/server/problem.ts';
import { getFireClusterDetail } from '../../../../../lib/server/services.ts';

const ALLOWED = ['as_of'] as const;

export const GET = apiRoute(
  async ({ search, now, url }) => {
    rejectUnknownParams(search, ALLOWED);

    const raw = lastPathSegment(url);
    if (raw === null) {
      throw new ApiProblemError({
        code: 'VALIDATION_FAILED',
        detail: 'The fire cluster identifier is not decodable.',
        invalidParams: [{ name: 'publicId', reason: 'must be a GeoNerva public id' }],
      });
    }
    const publicId = parsePublicId(raw, 'fire_cluster');
    const asOf = parseAsOf(search, now);

    const outcome = await getFireClusterDetail(database().db, {
      publicId,
      asOf,
      now,
      location: null,
    });
    if (outcome.kind === 'redirect') {
      return redirectResponse(
        `/api/v1/fire-clusters/${outcome.publicId}${url.search}`,
        CACHE_POLICIES.fireCluster,
      );
    }
    return jsonResponse(outcome.detail, { cacheControl: CACHE_POLICIES.fireCluster });
  },
  { name: 'fire-cluster-detail', rateLimit: 'default' },
);
