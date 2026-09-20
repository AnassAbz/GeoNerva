#!/usr/bin/env node
/**
 * GeoNerva worker entry point (docs/ARCHITECTURE.md §2, §4).
 *
 * Runs directly on Node 24 via native type stripping (ADR-026).
 */
import { checkConfig } from './cli/check-config.ts';
import { runSource } from './cli/run-source.ts';
import { startWorker } from './cli/start.ts';
import { describeUnexpectedError } from './cli/unexpected-error.ts';

const USAGE = `Usage: geonerva-worker <command>

Commands:
  check-config   Validate the worker environment and print a redacted summary
  run            Poll one source once (run --help for options)
  start          Poll every enabled source on its schedule until SIGTERM
  help           Show this message`;

/**
 * Cancels in-flight work on SIGTERM.
 *
 * The signal reaches the HTTP client and the run closes as ABORTED, which is a statement about
 * GeoNerva rather than about the provider and is excluded from source health (ADR-032). Without
 * it a deploy would leave a RUNNING row behind, blocking that product until its lease expired.
 */
function shutdownSignal(): AbortSignal {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      controller.abort(new DOMException(`received ${signal}`, 'AbortError'));
    });
  }
  return controller.signal;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'check-config':
      return checkConfig(process.env);
    case 'run':
      return await runSource(rest, process.env, shutdownSignal());
    case 'start':
      return await startWorker(rest, process.env, shutdownSignal());
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(describeUnexpectedError(error));
  process.exitCode = 70; // EX_SOFTWARE
}
