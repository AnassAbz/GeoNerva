/**
 * The errors an operator can actually act on, told apart from the ones that must stay withheld.
 *
 * `describeUnexpectedError` withholds messages because the worker's errors routinely carry
 * connection strings (F-2). That is right for an unknown throw and wrong for the two failures a
 * deployment hits most: a misconfigured environment, and a database URL the production policy
 * refuses. Both are raised deliberately, both name a *variable* and a rule rather than a value,
 * and both are useless when withheld — which is what running this container first showed:
 *
 *     ✗ unexpected DatabaseUrlError; details withheld because they may contain secrets
 *
 * restarting every few seconds, with nothing to tell the operator that the URL needed
 * `sslmode=verify-full`. The message it was withholding was
 * `DATABASE_URL_WORKER: must require TLS in production: add sslmode=verify-full (host db.example.com)`,
 * which contains no credential and is exactly the sentence that ends the incident.
 *
 * So these two are shown, by type, and everything else stays withheld by default. The allowance is
 * a whitelist and not a heuristic on purpose: an error is shown because its class promises a safe
 * message, never because its text happens to look harmless.
 */

import { ConfigError } from '@geonerva/config';
import { DatabaseUrlError } from '@geonerva/db';

/**
 * The message to show, or `null` when the error is not one of the two safe kinds and must go
 * through `describeUnexpectedError` instead.
 */
export function describeStartupError(error: unknown): string | null {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof DatabaseUrlError) return error.message;
  return null;
}

/** `EX_CONFIG`-ish: the environment is wrong, not the code. Matches what the CLIs already return. */
export const STARTUP_EXIT_CODE = 1;
