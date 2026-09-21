/**
 * `pnpm openapi` — writes `docs/openapi.json` from the response schemas.
 *
 * The document is a build artifact that happens to be committed. Committing it is what makes it
 * reviewable: a change to a frozen read model shows up as a diff in the API description, in the
 * same commit, rather than being discovered by a client. `scripts/generate-openapi.test.ts`
 * fails when the committed file is not what the generator produces, so it cannot go stale
 * silently.
 *
 * The version is taken from the root `package.json`, not from a constant here, so the document and
 * the release it describes cannot disagree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from '../apps/web/lib/server/contracts.ts';

export const OPENAPI_PATH = join(import.meta.dirname, '..', 'docs', 'openapi.json');

/** The document as it should be on disk: two-space JSON with a trailing newline, like every file. */
export function renderOpenApiDocument(): string {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version?: string };

  return `${JSON.stringify(
    buildOpenApiDocument({ version: manifest.version ?? '0.0.0' }),
    null,
    2,
  )}\n`;
}

function main(): number {
  const rendered = renderOpenApiDocument();
  let existing = '';
  try {
    existing = readFileSync(OPENAPI_PATH, 'utf8');
  } catch {
    /* First run: there is nothing to compare against. */
  }

  if (existing === rendered) {
    console.log('✓ docs/openapi.json is up to date');
    return 0;
  }

  writeFileSync(OPENAPI_PATH, rendered, 'utf8');
  console.log(`✓ wrote docs/openapi.json (${String(rendered.length)} bytes)`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main());
}
