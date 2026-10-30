// Layering test of plan 002 section 4.1 and ADR 0017. It parses every import under `src/` and fails
// the build on any violation of the dependency rule. The rules and the import scanner live in
// test/architecture/layering.ts and have their own table-driven tests.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLayering, readSourceTree } from './architecture/layering.ts';
import type { Violation } from './architecture/layering.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(repoRoot, 'src');
const fixtureSrc = (name: string): string => join(repoRoot, 'test', 'fixtures', 'architecture', name, 'src');

describe('src/ layering', () => {
  it.each(['core', 'ports', 'adapters', 'cli'])('has the src/%s folder', (layer) => {
    const folder = join(srcRoot, layer);
    expect(existsSync(folder) && statSync(folder).isDirectory()).toBe(true);
  });

  it('scans the real source tree', () => {
    const paths = readSourceTree(srcRoot).map((file) => file.path);
    expect(paths).toContain('cli/main.ts');
  });

  it('has no layering violation', () => {
    expect(checkLayering(readSourceTree(srcRoot))).toEqual([]);
  });
});

describe('architecture fixtures', () => {
  it('fails on the deliberately bad fixture with exactly these violations', () => {
    const expected: Violation[] = [
      { file: 'adapters/store/sqlite/store.ts', line: 3, specifier: '../../../cli/main.ts', rule: 'adapter-imports-cli' },
      {
        file: 'adapters/vcs/git/push.ts',
        line: 3,
        specifier: '../../store/sqlite/store.ts',
        rule: 'adapter-imports-another-adapter',
      },
      { file: 'core/dag/select.ts', line: 3, specifier: 'node:fs', rule: 'core-imports-outside-core-and-ports' },
      {
        file: 'core/dag/select.ts',
        line: 4,
        specifier: '../../adapters/store/sqlite/store.ts',
        rule: 'core-imports-outside-core-and-ports',
      },
      { file: 'core/dag/select.ts', line: 10, specifier: null, rule: 'non-literal-dynamic-import' },
      { file: 'ports/store-port.ts', line: 3, specifier: '../core/dag/select.ts', rule: 'ports-imports-outside-core-domain' },
      { file: 'shared/util.ts', line: 1, specifier: null, rule: 'file-outside-layers' },
    ];
    expect(checkLayering(readSourceTree(fixtureSrc('bad')))).toEqual(expected);
  });

  it('passes on the good fixture, which uses every allowed kind of import', () => {
    const files = readSourceTree(fixtureSrc('good'));
    expect(files).toHaveLength(6);
    expect(checkLayering(files)).toEqual([]);
  });
});
