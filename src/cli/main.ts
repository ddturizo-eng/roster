// Composition root of the roster CLI. Commands are added by later tasks of spec 002;
// until then every invocation prints usage and exits 0.

const USAGE = `roster: local orchestration of agent specialists

Usage:
  roster <command> [options]

No commands are available yet.
`;

function main(_argv: readonly string[]): number {
  process.stdout.write(USAGE);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
