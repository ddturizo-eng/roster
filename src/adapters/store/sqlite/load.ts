// Loads `node:sqlite` without the global ExperimentalWarning.
//
// Why: in Node 24 `node:sqlite` can print "ExperimentalWarning: SQLite is an experimental feature"
// the first time it is loaded, which would pollute every CLI command's output (some Node 24 builds no
// longer print it). How: the module is loaded with a synchronous `require` while `process.emitWarning`
// is wrapped to drop only warnings of type ExperimentalWarning that mention SQLite; the original
// function is restored in `finally`. Every other warning, and every warning emitted after the load,
// is untouched. Nothing here uses `--no-warnings` or `NODE_NO_WARNINGS`, which are global.

import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

const require = createRequire(import.meta.url);

function warningType(args: readonly unknown[]): string | undefined {
  const [, second] = args;
  if (typeof second === 'string') return second;
  if (typeof second === 'object' && second !== null && 'type' in second) return String(second.type);
  const [first] = args;
  return first instanceof Error ? first.name : undefined;
}

function warningText(args: readonly unknown[]): string {
  const [first] = args;
  return first instanceof Error ? first.message : String(first);
}

let cached: typeof NodeSqlite | undefined;

export function loadSqlite(): typeof NodeSqlite {
  if (cached !== undefined) return cached;
  const original = process.emitWarning;
  process.emitWarning = ((...args: unknown[]) => {
    if (warningType(args) === 'ExperimentalWarning' && /sqlite/i.test(warningText(args))) return;
    return (original as (...rest: unknown[]) => void).apply(process, args);
  }) as typeof process.emitWarning;
  try {
    cached = require('node:sqlite') as typeof NodeSqlite;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}
