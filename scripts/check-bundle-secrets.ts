/**
 * `pnpm build:canary` — builds the web app with a unique canary marker in every secret
 * environment variable, then fails if any marker appears in the public client bundles or in
 * prerendered HTML/RSC output. This is the backstop behind the lint rules in eslint.config.js
 * (docs/SECURITY.md C2; docs/reviews/security-p1.md F-1/N-3): it catches every inlining channel,
 * including ones lint cannot see (constant folding, config plugins, future Next.js behaviour).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every variable that must never reach a browser. `SECRET_ENV_VARS` lives in packages/config
 * next to the schemas that declare them, and a test there fails if a new secret-looking
 * variable is added without being listed (docs/reviews/security-p1.md R-3).
 */
import { SECRET_ENV_VARS } from '@geonerva/config';

export { SECRET_ENV_VARS };

/** A marker unique to one variable, e.g. `geonerva-rate-limit-secret-c4n4ry7f3a9e`. */
export function canaryMarker(name: string): string {
  return `geonerva-${name.toLowerCase().replaceAll('_', '-')}-c4n4ry7f3a9e`;
}

/** The value injected at build time; URLs keep their shape so validating code still runs. */
export function canaryValue(name: string): string {
  const marker = canaryMarker(name);
  return name.startsWith('DATABASE_URL')
    ? `postgresql://canary:${marker}@canary.invalid/db`
    : marker;
}

/**
 * Encodings a value can pass through on its way into a page (R-2). Deliberate obfuscation
 * (hashing, chunking, character arithmetic) is out of reach of any scanner; these cover the
 * transformations that happen by accident, such as JSON or base64 embedding.
 */
export function markerEncodings(marker: string): string[] {
  const base64 = Buffer.from(marker, 'utf8').toString('base64');
  // Deduplicated: for markers without URL-special characters, several encodings coincide.
  return [
    ...new Set([
      marker,
      base64,
      base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''), // base64url
      encodeURIComponent(marker),
      Buffer.from(marker, 'utf8').toString('hex'),
    ]),
  ];
}

/**
 * Everything the server can send to a browser: client chunks, and prerendered payloads
 * anywhere under `server/` — including `server/pages/404.html` and `500.html` (R-1).
 * Server-side JS chunks are excluded on purpose: they stay on the server, and runtime
 * secret exposure through an API response is reviewed with the API layer in P8.
 */
const PUBLIC_OUTPUT: readonly { dir: string; include: (file: string) => boolean }[] = [
  { dir: 'static', include: () => true },
  { dir: 'server', include: (file) => /\.(html|rsc|body|meta|txt|xml)$/.test(file) },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Returns one message per (file, marker) occurrence in public build output. */
export function findCanaries(nextDir: string, markers: readonly string[]): string[] {
  const leaks: string[] = [];
  const needles = markers.flatMap((marker) =>
    markerEncodings(marker).map((encoded) => ({ marker, encoded })),
  );
  for (const { dir, include } of PUBLIC_OUTPUT) {
    const root = join(nextDir, dir);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of walk(root)) {
      if (!include(file)) continue;
      const content = readFileSync(file, 'latin1');
      for (const { marker, encoded } of needles) {
        if (!content.includes(encoded)) continue;
        const how = encoded === marker ? '' : ' (encoded)';
        leaks.push(`${relative(nextDir, file)}: ${marker}${how}`);
      }
    }
  }
  return leaks;
}

function main(): number {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const canaryEnv = Object.fromEntries(SECRET_ENV_VARS.map((name) => [name, canaryValue(name)]));

  console.log(`Building the web app with canaries in ${SECRET_ENV_VARS.length} secret variables…`);
  // Invoke the Next CLI directly: no shell, no .cmd shim, identical to `next build`.
  const webDir = join(repoRoot, 'apps', 'web');
  const nextCli = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next');
  const build = spawnSync(process.execPath, [nextCli, 'build'], {
    cwd: webDir,
    env: { ...process.env, ...canaryEnv, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    console.error('✗ build failed');
    return build.status ?? 1;
  }

  const leaks = findCanaries(
    join(repoRoot, 'apps', 'web', '.next'),
    SECRET_ENV_VARS.map(canaryMarker),
  );
  if (leaks.length > 0) {
    console.error('✗ secret canaries found in public build output:');
    for (const leak of leaks) console.error(`  - ${leak}`);
    return 1;
  }
  console.log('✓ no secret canary in client bundles or prerendered output');
  return 0;
}

if (import.meta.main) process.exitCode = main();
