/**
 * The Content-Security-Policy (security finding F-5, docs/SECURITY.md §6).
 *
 * F-5 requires `default-src 'self'` and a script policy with no `unsafe-inline`, on every page
 * that renders provider text. Next.js emits two inline `<script>` blocks into every document —
 * the bootstrap `(self.__next_f=self.__next_f||[]).push([0])` and the RSC flight payload
 * `self.__next_f.push([1,"…"])` — so the policy has to authorise those two without opening the
 * door to injected `<script>` tags. Three mechanisms exist; this module uses a per-request nonce
 * with `'strict-dynamic'`. Why the other two were rejected, measured on this app at Next 16.3.5:
 *
 * **Hashes — rejected.** The second inline script is the flight payload, and its bytes are the
 * page's rendered data. Its hash therefore differs per route and changes whenever page content
 * changes, so it cannot be a constant in `next.config.ts`, whose `headers()` is evaluated before
 * any HTML exists. Worse, the four pages that render provider text (`/place/[slug]`,
 * `/event/[publicId]`, `/fire/[publicId]`, `/data-status`) are server-rendered on demand, so
 * their payload is not even build-time deterministic — there is no hash to publish. Next's only
 * hash-emitting feature, `experimental.sri`, does not help either: it is implemented solely in
 * `dist/build/webpack-config.js` (`SubresourceIntegrityPlugin`) while this app builds with
 * Turbopack, and it adds `integrity` to external `<script src>` tags, never to an inline script.
 *
 * **A nonce over statically prerendered HTML — rejected, and it is why `app/layout.tsx` sets
 * `force-dynamic`.** A nonce has to be in the document, and prerendered HTML is written at build
 * time when there is no request. Measured: with `proxy.ts` setting the nonce, `next build` still
 * reported `/`, `/methodology` and `/_not-found` as `○ (Static)`, and the served `/` carried two
 * nonce-less inline `<script>` tags against a freshly generated header nonce — every script on
 * the page blocked, i.e. a blank page. The proxy alone does not opt a route out of prerendering,
 * so the root layout does it explicitly. The cost is that those three routes lose CDN-cacheable
 * HTML; they render no provider text and no per-request data, and the four routes that do render
 * provider text were already `ƒ (Dynamic)`, so nothing that was cached stops being cached.
 *
 * `'self'` stays in `script-src` as the CSP Level 2 fallback: browsers that do not implement
 * `'strict-dynamic'` ignore it as an unknown source expression and fall back to `'self'` plus the
 * nonce. Browsers that do implement it ignore `'self'` and require the nonce.
 *
 * No `unsafe-eval`, and MapLibre does not need one: the `eval` in its bundled worker is only the
 * `importScriptInWorkers` plugin loader, which this app never calls. Adding a MapLibre plugin
 * through that API later would need this policy revisited rather than widened.
 *
 * `style-src` keeps `'unsafe-inline'`: React writes the `style` props in `components/map/*` and
 * `components/{change-item,history-chart}.tsx` as inline `style` attributes, which
 * `style-src-attr` inherits from `style-src`. F-5 restricts scripts only, and docs/SECURITY.md §6
 * already specifies this value. No web font is loaded from a third party (no `next/font`, no
 * `fonts.googleapis.com`), so `font-src` needs nothing beyond `'self'`.
 *
 * Pure: the caller (`proxy.ts`) generates the nonce and supplies the map origin.
 */

/** A CSP nonce: 122 random bits, and a valid `base64-value` per CSP3 (hyphens are in the grammar). */
export function generateNonce(): string {
  return crypto.randomUUID();
}

export interface CspInput {
  /** The basemap origin, already parsed by `parseMapStyleUrl` (finding F-16). */
  readonly mapOrigin: string;
  /** The per-request nonce, which Next.js reads back off the request's own CSP header. */
  readonly nonce: string;
}

export function buildContentSecurityPolicy({ mapOrigin, nonce }: CspInput): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'strict-dynamic' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    `connect-src 'self' ${mapOrigin}`,
    `img-src 'self' data: blob: ${mapOrigin}`,
    "worker-src 'self' blob:",
  ].join('; ');
}
