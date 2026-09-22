/**
 * `pnpm geonames:import <path/to/cities15000.txt>` — loads GeoNames populated places into
 * `places`, which type-ahead reads (ADR-013).
 *
 * The file is read from **disk**. This script never downloads it: fetching from GeoNames is a call
 * to an external provider, and an operator makes that call deliberately — the file is published at
 * `https://download.geonames.org/export/dump/cities15000.zip` under CC BY 4.0, and the attribution
 * GeoNerva shows for place search names it.
 *
 * Exit codes are the contract a deployment script relies on: `0` when every line loaded, `2` when
 * some lines were refused (they are listed; the valid ones are still loaded), `1` on anything else.
 */

import { readFileSync } from 'node:fs';

import { createDatabase, upsertPlaces, workerPoolOptions } from '@geonerva/db';

import { parseGeonames } from './lib/geonames.ts';

async function main(argv: readonly string[]): Promise<number> {
  const path = argv[0];
  if (path === undefined) {
    console.error('usage: pnpm geonames:import <path/to/cities15000.txt>');
    return 1;
  }

  const { places, rejected } = parseGeonames(readFileSync(path, 'utf8'));
  for (const entry of rejected.slice(0, 20)) {
    console.error(`line ${String(entry.line)}: ${entry.reason}`);
  }
  if (rejected.length > 20) console.error(`… and ${String(rejected.length - 20)} more`);

  /*
   * The worker's role and URL, not the web's: `places` is written only by the ingestion side, and
   * the web role holds `SELECT` on it and nothing more.
   */
  const handle = createDatabase({
    ...workerPoolOptions(process.env['DATABASE_URL_WORKER'] ?? '', process.env['NODE_ENV']),
    applicationName: 'geonerva-geonames-import',
  });
  try {
    const written = await upsertPlaces(handle.db, places);
    console.log(
      `✓ ${String(places.length)} places parsed, ${String(written)} written, ${String(rejected.length)} lines refused`,
    );
  } finally {
    await handle.close();
  }
  return rejected.length === 0 ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
