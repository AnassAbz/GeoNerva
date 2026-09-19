/**
 * `node packages/db/src/migrator/cli.ts <command>` — the migration CLI.
 *
 * ```text
 *   up       apply every pending migration (default)
 *   status   report applied / pending / changed migrations; exit 1 if anything is pending or dirty
 * ```
 *
 * Connection string resolution, in order: `--url`, `DATABASE_URL_MIGRATE`, `DATABASE_URL_WORKER`.
 * The web URL is deliberately **not** consulted: it points at a transaction pooler with a
 * read-only role, and migrations are a worker-side operation (docs/ARCHITECTURE.md §2, §15).
 *
 * Output goes through `process.stdout` rather than `console`, because `no-console` is an error
 * outside operational scripts and this file lives inside a package.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertConnectionUrlPolicy, describeConnectionTarget } from '../connection-url.ts';
import { migrateUp, migrationStatus } from './runner.ts';

const COMMANDS = ['up', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeError(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface ParsedArgs {
  readonly command: Command;
  readonly url: string | undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: Command = 'up';
  let url: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--url') {
      url = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
      continue;
    }
    if ((COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { command, url };
}

export function resolveMigrationUrl(
  env: Readonly<Record<string, string | undefined>>,
  explicit?: string,
): string {
  const url = explicit ?? env['DATABASE_URL_MIGRATE'] ?? env['DATABASE_URL_WORKER'];
  if (url === undefined || url === '') {
    throw new Error(
      'no database URL: pass --url, or set DATABASE_URL_MIGRATE or DATABASE_URL_WORKER',
    );
  }
  return url;
}

async function main(): Promise<number> {
  const { command, url: explicitUrl } = parseArgs(process.argv.slice(2));
  const url = resolveMigrationUrl(process.env, explicitUrl);
  const variableName = explicitUrl === undefined ? 'DATABASE_URL_WORKER' : '--url';

  assertConnectionUrlPolicy(url, { nodeEnv: process.env['NODE_ENV'], variableName });

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  write(`database: ${describeConnectionTarget(url, variableName)}`);

  try {
    if (command === 'status') {
      const status = await migrationStatus(client);
      for (const entry of status.entries) {
        const applied = entry.appliedAt === null ? '' : ` (${entry.appliedAt.toISOString()})`;
        write(`  ${entry.state.padEnd(18)} ${entry.version} ${entry.name}${applied}`);
      }
      write(`${status.appliedCount} applied, ${status.pendingCount} pending`);
      if (status.isDirty) {
        writeError('the database and this checkout disagree about applied migrations');
        return 2;
      }
      return status.pendingCount === 0 ? 0 : 1;
    }

    const result = await migrateUp(client);
    if (result.applied.length === 0) {
      write(`nothing to do (${result.alreadyApplied} migrations already applied)`);
      return 0;
    }
    for (const applied of result.applied) {
      write(`  applied ${applied.version} ${applied.name} in ${applied.executionMs} ms`);
    }
    write(`applied ${result.applied.length} migration(s)`);
    return 0;
  } finally {
    await client.end();
  }
}

/** True when this file is the entry point, rather than an import from a test. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main().catch((error: unknown) => {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  });
}
