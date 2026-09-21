/**
 * `docs/openapi.json` is current.
 *
 * The document is generated, so the only thing that can go wrong is the committed copy drifting
 * from the generator — a frozen read model changes, the schemas follow it, and the published API
 * description quietly describes the old shape. This test is what turns that into a failing build
 * rather than a client bug report.
 *
 * It is deliberately not a snapshot test. A snapshot would be updated by the same command that
 * regenerates the document, so the two would agree while both being wrong; this compares the file
 * against the generator's live output.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OPENAPI_PATH, renderOpenApiDocument } from './generate-openapi.ts';

describe('docs/openapi.json', () => {
  it('matches what the generator produces', () => {
    const committed = readFileSync(OPENAPI_PATH, 'utf8');
    expect(committed).toBe(renderOpenApiDocument());
  });

  it('is valid JSON describing an OpenAPI 3.1 document', () => {
    const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).length).toBeGreaterThan(5);
  });

  /* The version the document claims is the release it describes, not a constant in the script. */
  it('carries the version from package.json', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
    const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      info: { version: string };
    };
    expect(document.info.version).toBe(manifest.version ?? '0.0.0');
  });

  /* A published API description is a place a secret could reach by accident. */
  it('carries no connection string, key or host', () => {
    const raw = readFileSync(OPENAPI_PATH, 'utf8');
    expect(raw).not.toContain('postgres');
    expect(raw).not.toContain('RATE_LIMIT_SECRET');
    expect(raw).not.toContain('54320');
    expect(raw).not.toMatch(/[A-Za-z0-9]{40,}/u);
  });
});
