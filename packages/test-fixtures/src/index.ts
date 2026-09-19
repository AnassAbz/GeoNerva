/**
 * @geonerva/test-fixtures — captured provider payloads, builders and scenario datasets.
 *
 * Fixtures are byte-exact captures under `sources/<source>/`, each described by a
 * `MANIFEST.json` (URL, capture time, sha256, trimming notes, `synthetic` flag).
 * `scripts/capture-fixtures/verify-manifests.mjs` re-hashes them in CI.
 *
 * Only tests may import this package (enforced by `.dependency-cruiser.cjs`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_SOURCES = [
  'usgs',
  'emsc',
  'gdacs',
  'firms',
  'eccc',
  'nominatim',
  'correlation',
  'coverage',
] as const;
export type FixtureSource = (typeof FIXTURE_SOURCES)[number];

export interface FixtureManifestEntry {
  readonly file: string;
  readonly url?: string;
  readonly captured_at?: string;
  readonly sha256: string;
  readonly bytes?: number;
  readonly http_status?: number;
  readonly content_type?: string;
  readonly notes?: string;
  readonly synthetic?: boolean;
  readonly derived_from?: string;
  readonly expect_parse_error?: boolean;
}

const sourcesRoot = new URL('../sources/', import.meta.url);

/** Absolute path of a fixture, for tests that need a path (streaming, CSV parsers). */
export function fixturePath(source: FixtureSource, file: string): string {
  return fileURLToPath(new URL(`${source}/${file}`, sourcesRoot));
}

/** Raw bytes, for adapters whose `parse` takes a body as captured. */
export function readFixtureBytes(source: FixtureSource, file: string): Buffer {
  return readFileSync(fixturePath(source, file));
}

/** Fixture as UTF-8 text. */
export function readFixtureText(source: FixtureSource, file: string): string {
  return readFileSync(fixturePath(source, file), 'utf8');
}

/**
 * Fixture parsed as JSON. Returns `unknown` on purpose: a fixture is untrusted captured data,
 * so the caller either validates it with a schema or asserts the shape it is testing.
 */
export function readFixtureJson(source: FixtureSource, file: string): unknown {
  return JSON.parse(readFixtureText(source, file));
}

/** The manifest entries for one source, keyed by file name. */
export function readManifest(source: FixtureSource): Map<string, FixtureManifestEntry> {
  const entries = readFixtureJson(source, 'MANIFEST.json') as
    { fixtures?: FixtureManifestEntry[] } | FixtureManifestEntry[];
  const list = Array.isArray(entries) ? entries : (entries.fixtures ?? []);
  return new Map(list.map((entry) => [entry.file, entry]));
}
