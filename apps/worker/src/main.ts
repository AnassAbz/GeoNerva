#!/usr/bin/env node
/**
 * GeoNerva worker entry point (docs/ARCHITECTURE.md §2, §4).
 *
 * Runs directly on Node 24 via native type stripping (ADR-026). Ingestion commands
 * (`start`, `run --source`, `backfill`) are added in phase P3.
 */
import { checkConfig } from './cli/check-config.ts';

const USAGE = `Usage: geonerva-worker <command>

Commands:
  check-config   Validate the worker environment and print a redacted summary
  help           Show this message`;

function main(argv: readonly string[]): number {
  const [command] = argv;
  switch (command) {
    case 'check-config':
      return checkConfig(process.env);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
