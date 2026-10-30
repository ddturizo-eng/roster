import { describe, expect, it } from 'vitest';
import { checkLayering, layerOf, scanImports } from './layering.ts';
import type { ImportRef, RuleId } from './layering.ts';

describe('scanImports', () => {
  const cases: ReadonlyArray<{ name: string; source: string; expected: ImportRef[] }> = [
    { name: 'no imports', source: 'export const a = 1;\n', expected: [] },
    {
      name: 'default import',
      source: "import a from './a.ts';",
      expected: [{ specifier: './a.ts', line: 1, kind: 'static' }],
    },
    {
      name: 'named import over several lines with double quotes',
      source: 'import {\n  a,\n  b as c,\n} from "../b.ts"\n',
      expected: [{ specifier: '../b.ts', line: 4, kind: 'static' }],
    },
    {
      name: 'type-only import',
      source: "import type { T } from './t.ts';",
      expected: [{ specifier: './t.ts', line: 1, kind: 'static' }],
    },
    {
      name: 'inline type specifier',
      source: "import { type T, value } from './t.ts';",
      expected: [{ specifier: './t.ts', line: 1, kind: 'static' }],
    },
    {
      name: 'namespace import',
      source: "import * as fs from 'node:fs';",
      expected: [{ specifier: 'node:fs', line: 1, kind: 'static' }],
    },
    {
      name: 'default and named import',
      source: "import d, { n } from 'pkg';",
      expected: [{ specifier: 'pkg', line: 1, kind: 'static' }],
    },
    {
      name: 'side-effect import',
      source: "import './polyfill.ts';",
      expected: [{ specifier: './polyfill.ts', line: 1, kind: 'side-effect' }],
    },
    {
      name: 'import equals require',
      source: "import fs = require('node:fs');",
      expected: [{ specifier: 'node:fs', line: 1, kind: 'require' }],
    },
    {
      name: 'export star',
      source: "export * from './a.ts';",
      expected: [{ specifier: './a.ts', line: 1, kind: 're-export' }],
    },
    {
      name: 'export star as namespace',
      source: "export * as a from './a.ts';",
      expected: [{ specifier: './a.ts', line: 1, kind: 're-export' }],
    },
    {
      name: 'named re-export',
      source: "export { a, b as c } from './a.ts';",
      expected: [{ specifier: './a.ts', line: 1, kind: 're-export' }],
    },
    {
      name: 'type-only re-export',
      source: "export type { T } from './t.ts';",
      expected: [{ specifier: './t.ts', line: 1, kind: 're-export' }],
    },
    {
      name: 'local export list is not an import',
      source: "const a = 1;\nexport { a };\nconst from = 'x';\n",
      expected: [],
    },
    {
      name: 'local export list without semicolon followed by an import',
      source: "const a = 1;\nexport { a }\nimport b from './b.ts'\n",
      expected: [{ specifier: './b.ts', line: 3, kind: 'static' }],
    },
    {
      name: 'dynamic import with a literal',
      source: "const m = await import('./m.ts');",
      expected: [{ specifier: './m.ts', line: 1, kind: 'dynamic' }],
    },
    {
      name: 'dynamic import with options',
      source: "const m = await import('./m.json', { with: { type: 'json' } });",
      expected: [{ specifier: './m.json', line: 1, kind: 'dynamic' }],
    },
    {
      name: 'dynamic import with a variable',
      source: 'const m = await import(name);',
      expected: [{ specifier: null, line: 1, kind: 'dynamic' }],
    },
    {
      name: 'dynamic import with a concatenation',
      source: "const m = await import('./' + name);",
      expected: [{ specifier: null, line: 1, kind: 'dynamic' }],
    },
    {
      name: 'dynamic import with a template literal',
      source: 'const m = await import(`./${name}.ts`);',
      expected: [{ specifier: null, line: 1, kind: 'dynamic' }],
    },
    {
      name: 'import type in a type position',
      source: "type S = import('../ports/store.ts').StorePort;",
      expected: [{ specifier: '../ports/store.ts', line: 1, kind: 'dynamic' }],
    },
    {
      name: 'import.meta is not an import',
      source: "const url = new URL('.', import.meta.url);",
      expected: [],
    },
    {
      name: 'property named import is not an import',
      source: "loader.import('./x.ts'); const o = { import: 'y' };",
      expected: [],
    },
    {
      name: 'line comment',
      source: "// import a from './a.ts';\nexport {};\n",
      expected: [],
    },
    {
      name: 'block comment keeps line numbers',
      source: "/*\nimport a from './a.ts';\n*/\nimport b from './b.ts';\n",
      expected: [{ specifier: './b.ts', line: 4, kind: 'static' }],
    },
    {
      name: 'import text inside a string',
      source: "const s = \"import a from './a.ts'\";",
      expected: [],
    },
    {
      name: 'import text inside a template',
      source: "const s = `import a from './a.ts'`;",
      expected: [],
    },
    {
      name: 'dynamic import inside a template expression',
      source: "const s = `${await import('./a.ts')} and { ${'}'} }`;\nimport b from './b.ts';",
      expected: [
        { specifier: './a.ts', line: 1, kind: 'dynamic' },
        { specifier: './b.ts', line: 2, kind: 'static' },
      ],
    },
    {
      name: 'nested template literals',
      source: "const s = `a ${`b ${c} d`} e import x from './x.ts'`;\nimport y from './y.ts';",
      expected: [{ specifier: './y.ts', line: 2, kind: 'static' }],
    },
    {
      name: 'regular expression with quotes and slashes',
      source: "const r = /import a from '[^/]'/g;\nimport b from './b.ts';",
      expected: [{ specifier: './b.ts', line: 2, kind: 'static' }],
    },
    {
      name: 'regular expression after return',
      source: "function f() { return /'/.test(x); }\nimport b from './b.ts';",
      expected: [{ specifier: './b.ts', line: 2, kind: 'static' }],
    },
    {
      name: 'division is not a regular expression',
      source: "const half = total / 2; const q = a / b / c;\nimport b from './b.ts';",
      expected: [{ specifier: './b.ts', line: 2, kind: 'static' }],
    },
    {
      name: 'escaped quote in a string',
      source: "const s = 'it\\'s'; import a from './a.ts';",
      expected: [{ specifier: './a.ts', line: 1, kind: 'static' }],
    },
    {
      name: 'CRLF line endings',
      source: "// first\r\nimport a from './a.ts';\r\nimport b from './b.ts';\r\n",
      expected: [
        { specifier: './a.ts', line: 2, kind: 'static' },
        { specifier: './b.ts', line: 3, kind: 'static' },
      ],
    },
  ];

  it.each(cases)('$name', ({ source, expected }) => {
    expect(scanImports(source)).toEqual(expected);
  });
});

describe('layerOf', () => {
  const cases: ReadonlyArray<{ path: string; expected: string | undefined }> = [
    { path: 'core/dag/select.ts', expected: 'core' },
    { path: 'ports/store-port.ts', expected: 'ports' },
    { path: 'adapters/store/sqlite/store.ts', expected: 'adapters' },
    { path: 'cli/main.ts', expected: 'cli' },
    { path: 'core.ts', expected: undefined },
    { path: 'shared/util.ts', expected: undefined },
    { path: 'index.ts', expected: undefined },
  ];

  it.each(cases)('$path is in $expected', ({ path, expected }) => {
    expect(layerOf(path)).toBe(expected);
  });
});

describe('checkLayering', () => {
  // One importing file per case; `rule` is the expected violation, or null when the import is allowed.
  const cases: ReadonlyArray<{ from: string; specifier: string; rule: RuleId | null }> = [
    // core imports only core and ports.
    { from: 'core/dag/select.ts', specifier: './cycle.ts', rule: null },
    { from: 'core/dag/select.ts', specifier: '../domain/task.ts', rule: null },
    { from: 'core/dag/select.ts', specifier: '../../ports/store-port.ts', rule: null },
    { from: 'core/dag/select.ts', specifier: '../../adapters/store/sqlite/store.ts', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: '../../cli/main.ts', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: '../../shared/util.ts', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: '../../../test/fakes/store.ts', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: 'node:fs', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: 'node:path', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: 'fs', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: 'some-package', rule: 'core-imports-outside-core-and-ports' },
    { from: 'core/dag/select.ts', specifier: '../../core-extra/x.ts', rule: 'core-imports-outside-core-and-ports' },
    // ports imports only core/domain.
    { from: 'ports/store-port.ts', specifier: '../core/domain/task.ts', rule: null },
    { from: 'ports/store-port.ts', specifier: '../core/domain', rule: null },
    { from: 'ports/store-port.ts', specifier: '../core/dag/select.ts', rule: 'ports-imports-outside-core-domain' },
    { from: 'ports/store-port.ts', specifier: '../core/domain-extra/x.ts', rule: 'ports-imports-outside-core-domain' },
    { from: 'ports/store-port.ts', specifier: './clock-port.ts', rule: 'ports-imports-outside-core-domain' },
    { from: 'ports/store-port.ts', specifier: '../adapters/store/sqlite/store.ts', rule: 'ports-imports-outside-core-domain' },
    { from: 'ports/store-port.ts', specifier: '../cli/main.ts', rule: 'ports-imports-outside-core-domain' },
    { from: 'ports/store-port.ts', specifier: 'node:fs', rule: 'ports-imports-outside-core-domain' },
    // an adapter never imports another adapter or cli.
    { from: 'adapters/store/sqlite/store.ts', specifier: './schema.ts', rule: null },
    { from: 'adapters/store/sqlite/store.ts', specifier: './migrations/001.ts', rule: null },
    { from: 'adapters/store/sqlite/store.ts', specifier: '../../../ports/store-port.ts', rule: null },
    { from: 'adapters/store/sqlite/store.ts', specifier: '../../../core/domain/task.ts', rule: null },
    { from: 'adapters/store/sqlite/store.ts', specifier: 'node:sqlite', rule: null },
    { from: 'adapters/store/sqlite/store.ts', specifier: '../../vcs/git/git.ts', rule: 'adapter-imports-another-adapter' },
    { from: 'adapters/runtime/claude-code/run.ts', specifier: '../other/run.ts', rule: 'adapter-imports-another-adapter' },
    { from: 'adapters/store/sqlite/store.ts', specifier: '../../../cli/main.ts', rule: 'adapter-imports-cli' },
    { from: 'adapters/store/sqlite/store.ts', specifier: '../../../cli/config.ts', rule: 'adapter-imports-cli' },
    // cli imports every layer.
    { from: 'cli/main.ts', specifier: '../core/dag/select.ts', rule: null },
    { from: 'cli/main.ts', specifier: '../ports/store-port.ts', rule: null },
    { from: 'cli/main.ts', specifier: '../adapters/store/sqlite/store.ts', rule: null },
    { from: 'cli/main.ts', specifier: 'node:process', rule: null },
  ];

  it.each(cases)('$from importing $specifier breaks $rule', ({ from, specifier, rule }) => {
    const source = `// header\nimport { x } from '${specifier}';\n`;
    const expected = rule === null ? [] : [{ file: from, line: 2, specifier, rule }];
    expect(checkLayering([{ path: from, source }])).toEqual(expected);
  });

  it.each(['core/dag/select.ts', 'ports/store-port.ts', 'adapters/store/sqlite/store.ts'])(
    'rejects a non-literal dynamic import in %s',
    (path) => {
      const source = 'export const load = (name: string) => import(name);\n';
      expect(checkLayering([{ path, source }])).toEqual([
        { file: path, line: 1, specifier: null, rule: 'non-literal-dynamic-import' },
      ]);
    },
  );

  it('allows a non-literal dynamic import in cli', () => {
    const source = 'export const load = (name: string) => import(name);\n';
    expect(checkLayering([{ path: 'cli/main.ts', source }])).toEqual([]);
  });

  it('rejects a source file outside the four layers', () => {
    expect(checkLayering([{ path: 'index.ts', source: 'export {};\n' }])).toEqual([
      { file: 'index.ts', line: 1, specifier: null, rule: 'file-outside-layers' },
    ]);
  });

  it('reports every violation of a file in source order', () => {
    const source = [
      "import { readFileSync } from 'node:fs';",
      "import type { Task } from '../domain/task.ts';",
      "export * from '../../adapters/store/sqlite/store.ts';",
      "const m = await import('../../cli/main.ts');",
    ].join('\n');
    expect(checkLayering([{ path: 'core/dag/select.ts', source }])).toEqual([
      { file: 'core/dag/select.ts', line: 1, specifier: 'node:fs', rule: 'core-imports-outside-core-and-ports' },
      {
        file: 'core/dag/select.ts',
        line: 3,
        specifier: '../../adapters/store/sqlite/store.ts',
        rule: 'core-imports-outside-core-and-ports',
      },
      { file: 'core/dag/select.ts', line: 4, specifier: '../../cli/main.ts', rule: 'core-imports-outside-core-and-ports' },
    ]);
  });
});
