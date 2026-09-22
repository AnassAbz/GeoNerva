/**
 * Serves MapLibre GL JS v6's worker, and the shared chunk it imports, from this origin.
 *
 * MapLibre v6 is ESM-only and locates its worker relative to its own module URL. Next.js bundles
 * the library, which moves that URL, so the map calls `setWorkerUrl('/maplibre/maplibre-gl-worker.mjs')`
 * instead. The two files are read from the installed package and **prerendered at build time**
 * (`force-static` + `generateStaticParams`), so there is no runtime file access, no generated file
 * in the repository, and the served worker always matches the installed library.
 *
 * Only these two names exist; anything else is a 404 (`dynamicParams = false`).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const;

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams(): { file: string }[] {
  return FILES.map((file) => ({ file }));
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await context.params;
  const name = FILES.find((candidate) => candidate === file);
  if (name === undefined) return new Response('Not found', { status: 404 });
  // Resolved from the app directory (the build's working directory): bundlers rewrite
  // `require.resolve` into a module id, which is not a path.
  const dist = join(process.cwd(), 'node_modules', 'maplibre-gl', 'dist');
  const body = await readFile(join(dist, name), 'utf8');
  return new Response(body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  });
}
