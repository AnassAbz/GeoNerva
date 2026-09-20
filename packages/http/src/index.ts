/**
 * @geonerva/http — the hardened outbound HTTP client (ADR-028).
 *
 * Only provider adapters, the ingestion pipeline and the geocoder may import this package, and
 * only this package may reach the network primitives. Both rules are enforced by
 * `.dependency-cruiser.cjs` and by the `no-restricted-globals` rule in `eslint.config.js`.
 */
export { DEFAULT_RETRY_POLICY, HttpClient, isPrivateAddress, parseRetryAfter } from './client.ts';
export type { GetOptions, HttpClientOptions, HttpResponse, RetryPolicy } from './client.ts';

export {
  FETCH_ERROR_CLASSES,
  SourceFetchError,
  classifyStatus,
  classifyTransportError,
  isTransient,
} from './errors.ts';
export type { FetchErrorClass, FetchErrorContext } from './errors.ts';
