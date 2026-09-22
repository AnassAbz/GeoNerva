/**
 * The last segment of a request path, decoded — or `null` when it is not decodable.
 *
 * Shared by every route that takes an identifier in its path. `decodeURIComponent` throws
 * `URIError` on a malformed escape — `%ZZ`, or a truncated `%E0%A4%A` — and an unhandled throw
 * became a 500 with an error-level log line: a one-byte, caller-triggerable 5xx for what is
 * plainly a bad request. Handlers take the segment from the URL rather than from Next's params
 * object, so they are testable by constructing a `Request` alone.
 */
export function lastPathSegment(url: URL): string | null {
  const segment = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
