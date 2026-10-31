import { describe, expect, it } from 'vitest';
import {
  NEVER_PUSHED,
  PUSH_CREDENTIAL_HELPER,
  PUSH_OPTIONS,
  PUSH_REMOTE,
  createPushGuard,
} from '../../../src/adapters/vcs/push-guard.ts';
import type { PushGuard, PushGuardRules } from '../../../src/adapters/vcs/push-guard.ts';
import { PushRejectedError } from '../../../src/core/domain/errors.ts';

const SAFE_PREFIX = [
  '--git-dir=C:\\ws\\git',
  '--work-tree=C:\\ws\\tree',
  '-c',
  'core.hooksPath=C:\\ws\\.empty-hooks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'credential.helper=',
];

const DEFAULT_RULES: PushGuardRules = { baseBranch: 'main', branchPrefix: 'agent' };
const guard = createPushGuard(DEFAULT_RULES);

const validArgv = (branch = 'agent/002-T10', g: PushGuard = guard): string[] => [...SAFE_PREFIX, ...g.pushArguments(branch)];

function rejection(run: () => unknown): PushRejectedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PushRejectedError);
    return error as PushRejectedError;
  }
  throw new Error('expected a PushRejectedError');
}

const tail = (...rest: string[]): string[] => [
  ...SAFE_PREFIX,
  '-c',
  `credential.helper=${PUSH_CREDENTIAL_HELPER}`,
  'push',
  ...rest,
];

const refspec = (branch: string): string => `refs/heads/${branch}:refs/heads/${branch}`;

// Every combination of the two prefixes and the two bases the task names.
const COMBINATIONS: readonly PushGuardRules[] = [
  { baseBranch: 'main', branchPrefix: 'agent' },
  { baseBranch: 'develop', branchPrefix: 'agent' },
  { baseBranch: 'main', branchPrefix: 'feature' },
  { baseBranch: 'develop', branchPrefix: 'feature' },
];

const OWN_BRANCHES: Readonly<Record<string, readonly string[]>> = {
  agent: ['agent/002-T01', 'agent/014-spec', 'agent/014-plan', 'agent/hire-analyst', 'agent/project-web', 'agent/a_b.c'],
  feature: ['feature/agent-002-T01', 'feature/agent-014-spec', 'feature/agent-014-plan', 'feature/agent-x'],
};

const OTHER_PREFIX: Readonly<Record<string, string>> = { agent: 'feature', feature: 'agent' };

describe.each(COMBINATIONS)('createPushGuard(%o)', (rules) => {
  const g = createPushGuard(rules);
  const own = OWN_BRANCHES[rules.branchPrefix] ?? [];
  const foreign = OWN_BRANCHES[OTHER_PREFIX[rules.branchPrefix] ?? ''] ?? [];
  const namespace = rules.branchPrefix === 'agent' ? 'agent/' : `${rules.branchPrefix}/agent-`;

  it.each(own)('allows %s with exact arguments and accepts the full argument list', (branch) => {
    expect(g.pushArguments(branch)).toEqual([
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--no-verify',
      '--no-follow-tags',
      '--no-signed',
      '--recurse-submodules=no',
      'origin',
      refspec(branch),
    ]);
    expect(() => g.assertSafePush(validArgv(branch, g))).not.toThrow();
  });

  it.each(foreign)('refuses %s, a branch of the other prefix, in pushArguments and in argv', (branch) => {
    expect(rejection(() => g.pushArguments(branch)).message).toContain(`only branches under ${namespace}`);
    expect(rejection(() => g.assertSafePush(tail('origin', refspec(branch)))).message).toContain(
      `must be under refs/heads/${namespace}`,
    );
  });

  it.each([
    ['feature/login', `only branches under ${namespace}`],
    ['feature/agent-', `only branches under ${namespace}`],
    ['feature/agent-x/y', rules.branchPrefix === 'feature' ? 'exactly one segment may follow feature/' : `only branches under ${namespace}`],
    ['agent/x/y', rules.branchPrefix === 'agent' ? 'exactly one segment may follow agent/' : `only branches under ${namespace}`],
    ['agent/002-T01/extra', rules.branchPrefix === 'agent' ? 'exactly one segment may follow agent/' : `only branches under ${namespace}`],
    [`${rules.branchPrefix}/`, 'invalid segment'],
    [rules.branchPrefix, `only branches under ${namespace}`],
    ['refs/heads/agent/002-T01', `only branches under ${namespace}`],
  ])('refuses %j', (branch, reason) => {
    expect(rejection(() => g.pushArguments(branch)).message).toContain(reason);
  });

  it('refuses a human branch under the prefix in the final argument list', () => {
    expect(rejection(() => g.assertSafePush(tail('origin', refspec('feature/login')))).message).toContain(
      `must be under refs/heads/${namespace}`,
    );
    expect(rejection(() => g.assertSafePush(tail('origin', refspec('feature/agent-')))).message).toMatch(
      rules.branchPrefix === 'feature' ? /only branches under feature\/agent-/ : /must be under refs\/heads\/agent\//,
    );
    expect(rejection(() => g.assertSafePush(tail('origin', refspec(`${namespace}x/y`)))).message).toContain('exactly one segment');
  });

  it.each([...NEVER_PUSHED, rules.baseBranch])('never pushes %s, short, full or as a refspec', (name) => {
    const own0 = own[0] ?? '';
    expect(rejection(() => g.pushArguments(name)).message).toContain(`${name} is never pushed`);
    expect(rejection(() => g.pushArguments(`refs/heads/${name}`)).message).toContain(`${name} is never pushed`);
    expect(rejection(() => g.assertSafePush(tail('origin', `refs/heads/${own0}:refs/heads/${name}`))).message).toContain(
      `${name} is never pushed`,
    );
    expect(rejection(() => g.assertSafePush(tail('origin', `refs/heads/${own0}:${name}`))).message).toContain(
      `${name} is never pushed`,
    );
    expect(rejection(() => g.assertSafePush(tail('origin', `refs/heads/${name}:refs/heads/${name}`))).message).toContain(
      `${name} is never pushed`,
    );
  });

  it('refuses forced refspecs, every force option, a delete and two refspecs', () => {
    const ref = refspec(own[0] ?? '');
    const dest = `refs/heads/${own[0] ?? ''}`;
    const cases: [string[], string][] = [
      [tail('origin', `+${ref}`), 'forced (+) refspecs'],
      [tail('--force', 'origin', ref), 'force pushes are never allowed'],
      [tail('-f', 'origin', ref), 'force pushes are never allowed'],
      [tail('-uf', 'origin', ref), 'force pushes are never allowed'],
      [tail('--force-with-lease', 'origin', ref), 'force pushes are never allowed'],
      [tail(`--force-with-lease=${dest}`, 'origin', ref), 'force pushes are never allowed'],
      [tail('--force-if-includes', 'origin', ref), 'force pushes are never allowed'],
      [tail('origin', `:${dest}`), 'deleting a remote branch'],
      [tail('--delete', 'origin', dest), 'not allowed'],
      [tail('-d', 'origin', dest), 'not allowed'],
      [tail('origin', ref, ref), 'exactly one refspec'],
    ];
    for (const [argv, reason] of cases) expect(rejection(() => g.assertSafePush(argv)).message).toContain(reason);
    expect(rejection(() => g.pushArguments(`+${own[0] ?? ''}`)).message).toContain('forced (+)');
  });
});

describe('createPushGuard rules', () => {
  it.each([
    ['reserved prefix main', { baseBranch: 'trunk', branchPrefix: 'main' }, 'must not be one of'],
    ['reserved prefix master', { baseBranch: 'trunk', branchPrefix: 'master' }, 'must not be one of'],
    ['reserved prefix develop', { baseBranch: 'main', branchPrefix: 'develop' }, 'must not be one of'],
    ['reserved prefix head', { baseBranch: 'main', branchPrefix: 'head' }, 'must not be one of'],
    ['reserved prefix refs', { baseBranch: 'main', branchPrefix: 'refs' }, 'must not be one of'],
    ['reserved prefix origin', { baseBranch: 'main', branchPrefix: 'origin' }, 'must not be one of'],
    ['uppercase prefix', { baseBranch: 'main', branchPrefix: 'Feature' }, 'one lowercase segment'],
    ['two-segment prefix', { baseBranch: 'main', branchPrefix: 'feature/x' }, 'one lowercase segment'],
    ['empty prefix', { baseBranch: 'main', branchPrefix: '' }, 'one lowercase segment'],
    ['prefix over 32 characters', { baseBranch: 'main', branchPrefix: `a${'b'.repeat(32)}` }, 'one lowercase segment'],
    ['prefix starting with a digit', { baseBranch: 'main', branchPrefix: '1feature' }, 'one lowercase segment'],
    ['base under agent/', { baseBranch: 'agent/main', branchPrefix: 'agent' }, 'must not be under agent/'],
    ['base under agent/ with another prefix', { baseBranch: 'agent/x', branchPrefix: 'feature' }, 'must not be under agent/'],
    ['base with an agent- segment', { baseBranch: 'feature/agent-x', branchPrefix: 'feature' }, 'segment starting with "agent-"'],
    ['base equal to the prefix', { baseBranch: 'feature', branchPrefix: 'feature' }, 'must differ from the branchPrefix'],
    ['base equal to the default prefix', { baseBranch: 'agent', branchPrefix: 'agent' }, 'must differ from the branchPrefix'],
    ['base over 100 characters', { baseBranch: 'b'.repeat(101), branchPrefix: 'agent' }, '1 to 100 characters'],
    ['empty base', { baseBranch: '', branchPrefix: 'agent' }, '1 to 100 characters'],
    ['base with ..', { baseBranch: 'release..1', branchPrefix: 'agent' }, 'plain branch name'],
    ['base ending in .lock', { baseBranch: 'main.lock', branchPrefix: 'agent' }, 'plain branch name'],
    ['base with an empty segment', { baseBranch: 'release//1', branchPrefix: 'agent' }, 'plain branch name'],
    ['base with a refspec', { baseBranch: 'main:main', branchPrefix: 'agent' }, 'plain branch name'],
    ['base starting with -', { baseBranch: '-main', branchPrefix: 'agent' }, 'plain branch name'],
  ])('refuses %s at creation', (_label, rules, reason) => {
    const error = rejection(() => createPushGuard(rules));
    expect(error.message).toContain(reason);
  });

  it('refuses missing or non-string rules at creation', () => {
    rejection(() => createPushGuard(undefined as unknown as PushGuardRules));
    rejection(() => createPushGuard(null as unknown as PushGuardRules));
    rejection(() => createPushGuard({ branchPrefix: 'agent' } as unknown as PushGuardRules));
    rejection(() => createPushGuard({ baseBranch: 'main' } as unknown as PushGuardRules));
    rejection(() => createPushGuard({ baseBranch: ['main'], branchPrefix: 'agent' } as unknown as PushGuardRules));
  });

  it('never echoes the invalid value', () => {
    const error = rejection(() => createPushGuard({ baseBranch: 'agent/secretish-name', branchPrefix: 'agent' }));
    expect(error.message).not.toContain('secretish');
  });

  it('accepts a base of several segments and refuses it as a destination', () => {
    const g = createPushGuard({ baseBranch: 'release/v1.0', branchPrefix: 'feature' });
    expect(rejection(() => g.pushArguments('release/v1.0')).message).toContain('release/v1.0 is never pushed');
    expect(() => g.pushArguments('feature/agent-001-T01')).not.toThrow();
  });

  it('refuses the bound base branch explicitly, and only that guard does', () => {
    const trunk = createPushGuard({ baseBranch: 'trunk', branchPrefix: 'agent' });
    expect(rejection(() => trunk.pushArguments('trunk')).message).toContain('trunk is never pushed');
    expect(rejection(() => guard.pushArguments('trunk')).message).toContain('only branches under agent/');
  });

  it('returns a frozen guard whose rules cannot change afterwards', () => {
    const rules = { baseBranch: 'develop', branchPrefix: 'feature' };
    const g = createPushGuard(rules);
    expect(Object.isFrozen(g)).toBe(true);
    expect(() => {
      (g as { pushArguments: unknown }).pushArguments = () => [];
    }).toThrow(TypeError);
    rules.branchPrefix = 'agent';
    rules.baseBranch = 'main';
    expect(() => g.pushArguments('feature/agent-002-T01')).not.toThrow();
    expect(rejection(() => g.pushArguments('agent/002-T01')).message).toContain('only branches under feature/agent-');
    expect(rejection(() => g.pushArguments('develop')).message).toContain('develop is never pushed');
  });

  it('reads each rule once', () => {
    let reads = 0;
    const rules = {
      baseBranch: 'main',
      get branchPrefix(): string {
        reads += 1;
        return reads === 1 ? 'agent' : 'feature';
      },
    };
    const g = createPushGuard(rules);
    expect(reads).toBe(1);
    expect(() => g.pushArguments('agent/002-T01')).not.toThrow();
  });
});

describe('pushArguments (default rules)', () => {
  it('exposes the fixed constants', () => {
    expect(PUSH_CREDENTIAL_HELPER).toBe('!gh auth git-credential');
    expect(PUSH_REMOTE).toBe('origin');
    expect(PUSH_OPTIONS).toEqual(['--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no']);
    expect(NEVER_PUSHED).toEqual(['main', 'master', 'develop']);
  });

  it.each([
    ['main', 'main is never pushed'],
    ['refs/heads/main', 'main is never pushed'],
    ['master', 'master is never pushed'],
    ['develop', 'develop is never pushed'],
    ['', 'empty'],
    ['feature/x', 'only branches under agent/'],
    ['refs/heads/agent/x', 'only branches under agent/'],
    ['agent', 'only branches under agent/'],
    ['agent/', 'invalid segment'],
    ['agent//x', 'exactly one segment'],
    ['agent/../main', 'exactly one segment'],
    ['agent/x..y', 'invalid segment'],
    ['agent/x.lock', 'invalid segment'],
    ['agent/x.', 'invalid segment'],
    ['agent/.x', 'invalid segment'],
    ['agent/a b', 'invalid segment'],
    ['agent/x@{1}', 'invalid segment'],
    ['agent/x~1', 'invalid segment'],
    ['agent/x^', 'invalid segment'],
    ['agent/x\\y', 'invalid segment'],
    ['+agent/x', 'forced (+)'],
    ['-f', 'looks like an option'],
    ['--force', 'looks like an option'],
    ['agent/x:refs/heads/main', 'refspec'],
    [':refs/heads/agent/x', 'refspec'],
    [`agent/${'x'.repeat(200)}`, 'longer than 200'],
  ])('rejects %j', (branch, reason) => {
    expect(rejection(() => guard.pushArguments(branch)).message).toContain(reason);
  });
});

describe('assertSafePush (default rules)', () => {
  it('accepts the safe prefix followed by pushArguments', () => {
    expect(() => guard.assertSafePush(validArgv())).not.toThrow();
    expect(() => guard.assertSafePush(validArgv('agent/hire-analyst'))).not.toThrow();
  });

  const ref = 'refs/heads/agent/002-T10';

  it.each([
    ['--force', tail('--force', 'origin', `${ref}:${ref}`), 'force pushes are never allowed'],
    ['-f', tail('-f', 'origin', `${ref}:${ref}`), 'force pushes are never allowed'],
    ['-uf', tail('-uf', 'origin', `${ref}:${ref}`), 'force pushes are never allowed'],
    ['--force-with-lease', tail('--force-with-lease', 'origin', `${ref}:${ref}`), 'force pushes are never allowed'],
    [
      '--force-with-lease=<ref>',
      tail(`--force-with-lease=${ref}`, 'origin', `${ref}:${ref}`),
      'force pushes are never allowed',
    ],
    ['--force-if-includes', tail('--force-if-includes', 'origin', `${ref}:${ref}`), 'force pushes are never allowed'],
    ['--mirror', tail('--mirror', 'origin'), 'not allowed'],
    ['--all', tail('--all', 'origin'), 'not allowed'],
    ['--tags', tail('--tags', 'origin', `${ref}:${ref}`), 'not allowed'],
    ['--follow-tags', tail('--follow-tags', 'origin', `${ref}:${ref}`), 'not allowed'],
    ['--delete', tail('--delete', 'origin', ref), 'not allowed'],
    ['-d', tail('-d', 'origin', ref), 'not allowed'],
    ['--prune', tail('--prune', 'origin', `${ref}:${ref}`), 'not allowed'],
    ['--receive-pack', tail('--receive-pack=evil', 'origin', `${ref}:${ref}`), 'not allowed'],
    ['+ refspec', tail('origin', `+${ref}:${ref}`), 'forced (+) refspecs'],
    ['delete refspec', tail('origin', `:${ref}`), 'deleting a remote branch'],
    ['main destination', tail('origin', `${ref}:refs/heads/main`), 'main is never pushed'],
    ['short main destination', tail('origin', `${ref}:main`), 'main is never pushed'],
    ['refspec without destination', tail('origin', ref), '<ref>:<ref>'],
    ['tag destination', tail('origin', 'refs/tags/v1:refs/tags/v1'), 'must be under refs/heads/agent/'],
    ['other branch destination', tail('origin', 'refs/heads/x:refs/heads/x'), 'must be under refs/heads/agent/'],
    ['source differs', tail('origin', `refs/heads/main:${ref}`), 'must be the same'],
    ['invalid agent ref', tail('origin', 'refs/heads/agent/x..y:refs/heads/agent/x..y'), 'invalid segment'],
    ['two segments', tail('origin', 'refs/heads/agent/../x:refs/heads/agent/../x'), 'exactly one segment'],
    ['two refspecs', tail('origin', `${ref}:${ref}`, `${ref}:${ref}`), 'exactly one refspec'],
    ['remote URL', tail('https://github.com/evil/repo', `${ref}:${ref}`), 'remote must be origin'],
    ['no refspec', tail('origin'), 'a refspec is required'],
    ['no remote', tail(), 'remote must be origin'],
  ])('rejects %s', (_label, argv, reason) => {
    expect(rejection(() => guard.assertSafePush(argv)).message).toContain(reason);
  });

  it.each([
    ['not a push', SAFE_PREFIX, 'not a git push'],
    [
      'an extra -c setting',
      ['-c', 'core.sshCommand=evil', ...validArgv()],
      'setting "core.sshCommand" is not allowed',
    ],
    ['remote config', ['-c', 'remote.origin.url=x', ...validArgv()], 'not allowed'],
    ['a -c without key=value', ['-c', 'core.hooksPath', ...validArgv()], 'not allowed'],
    ['a dangling -c', ['--git-dir=x', '-c'], 'not a git push'],
    ['an unknown global option', ['--exec-path=C:\\evil', ...validArgv()], 'global option'],
    ['fsmonitor turned on', validArgv().map((a) => (a === 'core.fsmonitor=false' ? 'core.fsmonitor=true' : a)), 'not allowed'],
    ['autocrlf turned on', validArgv().map((a) => (a === 'core.autocrlf=false' ? 'core.autocrlf=true' : a)), 'not allowed'],
    ['an empty hooks path', validArgv().map((a) => (a.startsWith('core.hooksPath=') ? 'core.hooksPath=' : a)), 'not allowed'],
    ['another helper', validArgv().map((a) => (a === `credential.helper=${PUSH_CREDENTIAL_HELPER}` ? 'credential.helper=store' : a)), 'not allowed'],
  ])('rejects %s', (_label, argv, reason) => {
    expect(rejection(() => guard.assertSafePush(argv)).message).toContain(reason);
  });

  it('requires every safe setting and both paths', () => {
    const without = (predicate: (arg: string) => boolean): string[] => {
      const argv = validArgv();
      const at = argv.findIndex(predicate);
      // Remove a `-c key=value` pair, or a single `--x=` option.
      argv.splice(argv[at - 1] === '-c' ? at - 1 : at, argv[at - 1] === '-c' ? 2 : 1);
      return argv;
    };
    const check = (argv: string[]): string => rejection(() => guard.assertSafePush(argv)).message;
    expect(check(without((a) => a.startsWith('--git-dir=')))).toContain('--git-dir is missing');
    expect(check(without((a) => a.startsWith('--work-tree=')))).toContain('--work-tree is missing');
    expect(check(without((a) => a.startsWith('core.hooksPath=')))).toContain('core.hooksPath is missing');
    expect(check(without((a) => a === 'core.fsmonitor=false'))).toContain('core.fsmonitor is missing');
    expect(check(without((a) => a === 'core.autocrlf=false'))).toContain('core.autocrlf is missing');
    expect(check(without((a) => a === 'credential.helper='))).toContain('must be reset before');
    expect(check(without((a) => a === `credential.helper=${PUSH_CREDENTIAL_HELPER}`))).toContain('must be exactly');
    expect(check(['--git-dir=', ...validArgv().slice(1)])).toContain('has no value');
  });

  it('rejects a helper list reset after the push helper', () => {
    const argv = [...SAFE_PREFIX.slice(0, -2), '-c', `credential.helper=${PUSH_CREDENTIAL_HELPER}`, '-c', 'credential.helper=', 'push'];
    expect(rejection(() => guard.assertSafePush([...argv, 'origin', 'refs/heads/agent/x:refs/heads/agent/x'])).message).toMatch(
      /reset (before|after)/,
    );
  });

  it('never puts a token in the argument list it accepts', () => {
    expect(validArgv().join(' ')).not.toMatch(/gh[pousr]_|github_pat_/);
  });
});

describe('push-guard module', () => {
  it('imports nothing from core except the error type, and nothing from the branch or registration code', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../src/adapters/vcs/push-guard.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
    expect(imports).toEqual(['../../core/domain/errors.ts']);
    expect(source).toMatch(/^import \{ PushRejectedError \} from '\.\.\/\.\.\/core\/domain\/errors\.ts';$/m);
  });
});
