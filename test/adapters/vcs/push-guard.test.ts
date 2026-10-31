import { describe, expect, it } from 'vitest';
import {
  AGENT_REF_PREFIX,
  PUSH_CREDENTIAL_HELPER,
  PUSH_OPTIONS,
  agentRef,
  assertSafePush,
  pushArguments,
  pushGuard,
} from '../../../src/adapters/vcs/push-guard.ts';
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

const validArgv = (branch = 'agent/002-T10'): string[] => [...SAFE_PREFIX, ...pushArguments(branch)];

function rejection(run: () => unknown): PushRejectedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PushRejectedError);
    return error as PushRejectedError;
  }
  throw new Error('expected a PushRejectedError');
}

describe('agentRef', () => {
  it.each([
    ['agent/002-T10', 'refs/heads/agent/002-T10'],
    ['agent/002-spec', 'refs/heads/agent/002-spec'],
    ['agent/hire-code-reviewer', 'refs/heads/agent/hire-code-reviewer'],
    ['agent/project-roster', 'refs/heads/agent/project-roster'],
    ['agent/a/b_c.d', 'refs/heads/agent/a/b_c.d'],
  ])('accepts %s', (branch, ref) => {
    expect(agentRef(branch)).toBe(ref);
  });

  it.each([
    ['main', 'main is never pushed'],
    ['refs/heads/main', 'main is never pushed'],
    ['', 'empty'],
    ['feature/x', 'only branches under agent/'],
    ['refs/heads/agent/x', 'only branches under agent/'],
    ['agent', 'only branches under agent/'],
    ['agent/', 'invalid segment'],
    ['agent//x', 'invalid segment'],
    ['agent/../main', 'invalid segment'],
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
    const error = rejection(() => agentRef(branch));
    expect(error.message).toContain(reason);
  });
});

describe('pushArguments', () => {
  it('returns the credential helper for this command, the fixed options, origin and one ref:ref refspec', () => {
    expect(pushArguments('agent/002-T10')).toEqual([
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--no-verify',
      '--no-follow-tags',
      '--no-signed',
      '--recurse-submodules=no',
      'origin',
      'refs/heads/agent/002-T10:refs/heads/agent/002-T10',
    ]);
    expect(PUSH_CREDENTIAL_HELPER).toBe('!gh auth git-credential');
    expect(AGENT_REF_PREFIX).toBe('refs/heads/agent/');
    expect(PUSH_OPTIONS).toEqual(['--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no']);
  });

  it('refuses main before building anything', () => {
    rejection(() => pushArguments('main'));
  });

  it('is what the exported guard object exposes', () => {
    expect(pushGuard.pushArguments).toBe(pushArguments);
    expect(pushGuard.assertSafePush).toBe(assertSafePush);
  });
});

describe('assertSafePush', () => {
  it('accepts the safe prefix followed by pushArguments', () => {
    expect(() => assertSafePush(validArgv())).not.toThrow();
    expect(() => assertSafePush(validArgv('agent/hire-analyst'))).not.toThrow();
  });

  const tail = (...rest: string[]): string[] => [
    ...SAFE_PREFIX,
    '-c',
    `credential.helper=${PUSH_CREDENTIAL_HELPER}`,
    'push',
    ...rest,
  ];
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
    ['invalid agent ref', tail('origin', 'refs/heads/agent/../x:refs/heads/agent/../x'), 'invalid segment'],
    ['two refspecs', tail('origin', `${ref}:${ref}`, `${ref}:${ref}`), 'exactly one refspec'],
    ['remote URL', tail('https://github.com/evil/repo', `${ref}:${ref}`), 'remote must be origin'],
    ['no refspec', tail('origin'), 'a refspec is required'],
    ['no remote', tail(), 'remote must be origin'],
  ])('rejects %s', (_label, argv, reason) => {
    expect(rejection(() => assertSafePush(argv)).message).toContain(reason);
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
    expect(rejection(() => assertSafePush(argv)).message).toContain(reason);
  });

  it('requires every safe setting and both paths', () => {
    const without = (predicate: (arg: string) => boolean): string[] => {
      const argv = validArgv();
      const at = argv.findIndex(predicate);
      // Remove a `-c key=value` pair, or a single `--x=` option.
      argv.splice(argv[at - 1] === '-c' ? at - 1 : at, argv[at - 1] === '-c' ? 2 : 1);
      return argv;
    };
    expect(rejection(() => assertSafePush(without((a) => a.startsWith('--git-dir=')))).message).toContain('--git-dir is missing');
    expect(rejection(() => assertSafePush(without((a) => a.startsWith('--work-tree=')))).message).toContain('--work-tree is missing');
    expect(rejection(() => assertSafePush(without((a) => a.startsWith('core.hooksPath=')))).message).toContain('core.hooksPath is missing');
    expect(rejection(() => assertSafePush(without((a) => a === 'core.fsmonitor=false'))).message).toContain('core.fsmonitor is missing');
    expect(rejection(() => assertSafePush(without((a) => a === 'core.autocrlf=false'))).message).toContain('core.autocrlf is missing');
    expect(rejection(() => assertSafePush(without((a) => a === 'credential.helper='))).message).toContain('must be reset before');
    expect(
      rejection(() => assertSafePush(without((a) => a === `credential.helper=${PUSH_CREDENTIAL_HELPER}`))).message,
    ).toContain('must be exactly');
    expect(rejection(() => assertSafePush(['--git-dir=', ...validArgv().slice(1)])).message).toContain('has no value');
  });

  it('rejects a helper list reset after the push helper', () => {
    const argv = [...SAFE_PREFIX.slice(0, -2), '-c', `credential.helper=${PUSH_CREDENTIAL_HELPER}`, '-c', 'credential.helper=', 'push'];
    expect(rejection(() => assertSafePush([...argv, 'origin', 'refs/heads/agent/x:refs/heads/agent/x'])).message).toMatch(
      /reset (before|after)/,
    );
  });

  it('never puts a token in the argument list it accepts', () => {
    expect(validArgv().join(' ')).not.toMatch(/gh[pousr]_|github_pat_/);
  });
});
