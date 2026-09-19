/**
 * @geonerva/geocoding — place search behind a provider interface (ADR-013, ADR-028).
 *
 * The only package the web app may use to reach an external host (Nominatim). It depends on
 * @geonerva/http for the host allowlist, timeouts and size caps, and never on provider adapters.
 */
export {};
