/**
 * `GET /api/v1/evidence/{id}` (ARCHITECTURE §13.1).
 *
 * §13.1 caches this "immutable", which is true for a good reason rather than as an optimisation:
 * every primary evidence kind points at an append-only row that cannot change once written. An
 * observation version, a correlation link, an ingestion run and a fire-cluster version are all
 * facts about a moment, so the answer for a given id at a given knowledge time is fixed forever.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import {
  MAX_EVIDENCE_ID_LENGTH,
  parseAsOf,
  rejectUnknownParams,
} from '../../../../../lib/server/params.ts';
import { ApiProblemError } from '../../../../../lib/server/problem.ts';
import { getEvidence } from '../../../../../lib/server/services.ts';

const ALLOWED = ['as_of'] as const;

export const GET = apiRoute(
  async ({ search, now, url }) => {
    rejectUnknownParams(search, ALLOWED);
    const asOf = parseAsOf(search, now);

    /*
     * The id is taken from the path rather than from Next's params object, so this handler is
     * testable by constructing a `Request` alone. It is length-capped before `getEvidence` parses
     * it, because the id reaches a `LIKE`-free but still parameterised query and an unbounded path
     * segment is an unbounded cache key.
     */
    const raw = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    if (raw === '' || raw.length > MAX_EVIDENCE_ID_LENGTH) {
      throw new ApiProblemError({
        code: 'VALIDATION_FAILED',
        detail: 'The evidence identifier is missing or too long.',
        invalidParams: [
          { name: 'id', reason: `must be 1 to ${String(MAX_EVIDENCE_ID_LENGTH)} characters` },
        ],
      });
    }

    const { item } = await getEvidence(database().db, { id: raw, asOf, now });
    return jsonResponse(item, { cacheControl: CACHE_POLICIES.evidence });
  },
  { name: 'evidence' },
);
