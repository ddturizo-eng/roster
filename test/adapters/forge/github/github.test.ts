import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubInputError, MAX_BODY_LENGTH, apiArgs, createGitHubForge } from '../../../../src/adapters/forge/github/index.ts';
import type { GhCall, GhOutput, GhRunner, GitHubForge } from '../../../../src/adapters/forge/github/index.ts';
import { ExternalCommandError, NotFoundError, SecretMissingError } from '../../../../src/core/domain/errors.ts';

// The GitHub adapter against a stubbed gh runner: every test asserts the exact argument lists, the
// complete environment and stdin of each call, and that the token never appears outside `GH_TOKEN`.

const FAKE_TOKEN = 'github_pat_FAKE0123456789abcdefFAKE0123456789ab';
const PARENT_TOKEN = 'ghp_PARENTshouldNEVERreachGH000000000000';
const REPO = 'octo/roster';
const BRANCH = 'agent/002-T11';
const HEADERS = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
const PARENT_ENV = {
  PATH: 'C:\\Windows\\system32',
  SYSTEMROOT: 'C:\\Windows',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  GH_TOKEN: PARENT_TOKEN,
  GITHUB_TOKEN: PARENT_TOKEN,
  GH_HOST: 'evil.example',
  GH_CONFIG_DIR: 'C:\\Users\\u\\AppData\\Roaming\\GitHub CLI',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (json: unknown): GhOutput => ({ exitCode: 0, stdout: JSON.stringify(json), stderr: '' });
const httpError = (status: number, message: string): GhOutput => ({
  exitCode: 1,
  stdout: JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest', status: String(status) }),
  stderr: `gh: ${message} (HTTP ${status})\n`,
});
const pr = (number: number, head = BRANCH, base = 'main', state = 'open'): Record<string, unknown> => ({
  number,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  state,
  head: { ref: head, repo: { full_name: REPO } },
  base: { ref: base },
});

interface Harness {
  readonly forge: GitHubForge;
  readonly calls: GhCall[];
  readonly configDir: string;
  tokenReads: number;
}

function harness(responses: (GhOutput | Error)[], token: () => Promise<string> = async () => FAKE_TOKEN): Harness {
  const base = mkdtempSync(join(tmpdir(), 'roster-gh-'));
  dirs.push(base);
  const configDir = join(base, 'gh');
  const calls: GhCall[] = [];
  const runner: GhRunner = async (call) => {
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected gh call');
    if (next instanceof Error) throw next;
    return next;
  };
  const h: Harness = {
    calls,
    configDir,
    tokenReads: 0,
    forge: createGitHubForge({
      token: async () => {
        h.tokenReads += 1;
        return token();
      },
      configDir,
      runner,
      env: PARENT_ENV,
    }),
  };
  return h;
}

function expectedEnv(configDir: string): Record<string, string> {
  return {
    PATH: 'C:\\Windows\\system32',
    SYSTEMROOT: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    GH_CONFIG_DIR: configDir,
    GH_TOKEN: FAKE_TOKEN,
  };
}

/** Every call: exact environment, trusted cwd, token only in `GH_TOKEN`, nothing secret in stdin. */
function expectSafeCalls(h: Harness): void {
  for (const call of h.calls) {
    expect(call.env).toEqual(expectedEnv(h.configDir));
    expect(call.cwd).toBe(h.configDir);
    for (const arg of call.args) {
      expect(arg).not.toContain(FAKE_TOKEN);
      expect(arg).not.toContain(PARENT_TOKEN);
    }
    expect(call.input ?? '').not.toContain(FAKE_TOKEN);
  }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(FAKE_TOKEN);
  return error as Error;
}

const createArgs = ['api', '--hostname', 'github.com', '--method', 'POST', ...HEADERS, `repos/${REPO}/pulls`, '--input', '-'];

describe('apiArgs', () => {
  it('builds a GET with query fields and a POST that reads its body from stdin', () => {
    expect(apiArgs('GET', 'repos/a/b/pulls', { state: 'open' })).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      ...HEADERS,
      'repos/a/b/pulls',
      '-f',
      'state=open',
    ]);
    expect(apiArgs('POST', 'repos/a/b/pulls', {}, true)).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      ...HEADERS,
      'repos/a/b/pulls',
      '--input',
      '-',
    ]);
  });
});

const listArgsFor = (branch: string, base: string): string[] => [
  'api',
  '--hostname',
  'github.com',
  '--method',
  'GET',
  ...HEADERS,
  `repos/${REPO}/pulls`,
  '-f',
  'state=open',
  '-f',
  `head=octo:${branch}`,
  '-f',
  `base=${base}`,
];

const listArgs = listArgsFor(BRANCH, 'main');

describe('ensurePr', () => {
  const request = {
    repo: REPO,
    branch: BRANCH,
    base: 'main',
    title: '002-T11: GitHub adapter through gh',
    body: 'Summary\n\n--repo evil `$(rm -rf /)`',
  };

  it('reuses the open PR of the branch against main', async () => {
    const h = harness([ok([pr(7, 'agent/other'), pr(8, BRANCH, 'develop'), pr(9)])]);
    expect(await h.forge.ensurePr(request)).toEqual({ number: 9, url: `https://github.com/${REPO}/pull/9` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgs]);
    expect(h.calls[0]?.input).toBeUndefined();
    expectSafeCalls(h);
  });

  it('creates a PR against main with title and body on stdin, never in an argument', async () => {
    const h = harness([ok([]), { exitCode: 0, stdout: JSON.stringify(pr(12)), stderr: '' }]);
    expect(await h.forge.ensurePr(request)).toEqual({ number: 12, url: `https://github.com/${REPO}/pull/12` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgs, createArgs]);
    expect(JSON.parse(h.calls[1]?.input ?? '')).toEqual({ title: request.title, head: BRANCH, base: 'main', body: request.body });
    for (const call of h.calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain('Summary');
        expect(arg).not.toContain('GitHub adapter');
      }
    }
    expectSafeCalls(h);
    expect(existsSync(h.configDir)).toBe(true);
  });

  it('creates a PR into develop from a prefixed agent branch, then reuses it', async () => {
    const branch = 'feature/agent-002-T44';
    const gitflow = { ...request, branch, base: 'develop' };
    const created = harness([ok([]), ok(pr(21, branch, 'develop'))]);
    expect(await created.forge.ensurePr(gitflow)).toEqual({ number: 21, url: `https://github.com/${REPO}/pull/21` });
    expect(created.calls.map((call) => call.args)).toEqual([listArgsFor(branch, 'develop'), createArgs]);
    expect(JSON.parse(created.calls[1]?.input ?? '')).toEqual({ title: request.title, head: branch, base: 'develop', body: request.body });
    expectSafeCalls(created);

    const reused = harness([ok([pr(20, branch, 'main'), pr(21, branch, 'develop')])]);
    expect(await reused.forge.ensurePr(gitflow)).toEqual({ number: 21, url: `https://github.com/${REPO}/pull/21` });
    expect(reused.calls.map((call) => call.args)).toEqual([listArgsFor(branch, 'develop')]);
    expectSafeCalls(reused);
  });

  it('does not reuse an open PR from the same branch into another base', async () => {
    const develop = { ...request, base: 'develop' };
    const h = harness([ok([pr(30, BRANCH, 'main')]), ok(pr(31, BRANCH, 'develop'))]);
    expect(await h.forge.ensurePr(develop)).toEqual({ number: 31, url: `https://github.com/${REPO}/pull/31` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgsFor(BRANCH, 'develop'), createArgs]);
    expect(JSON.parse(h.calls[1]?.input ?? '')).toMatchObject({ head: BRANCH, base: 'develop' });
  });

  it('does not reuse an open PR into the same base from another head', async () => {
    const h = harness([ok([pr(40, 'feature/agent-002-T11', 'main')]), ok(pr(41))]);
    expect(await h.forge.ensurePr(request)).toEqual({ number: 41, url: `https://github.com/${REPO}/pull/41` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgs, createArgs]);
  });

  it('returns the PR that appeared between the lookup and the create (422)', async () => {
    const h = harness([ok([]), httpError(422, 'Validation Failed'), ok([pr(13)])]);
    expect(await h.forge.ensurePr(request)).toEqual({ number: 13, url: `https://github.com/${REPO}/pull/13` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgs, createArgs, listArgs]);
    expectSafeCalls(h);
  });

  it('maps a 422 with no PR to ExternalCommandError with the API message', async () => {
    const h = harness([ok([]), httpError(422, 'Validation Failed'), ok([])]);
    const error = await failure(h.forge.ensurePr(request));
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect(error.message).toBe('gh failed (exit 1): create PR: HTTP 422: Validation Failed');
  });

  it('redacts the token from any error text gh prints', async () => {
    const h = harness([{ exitCode: 1, stdout: '', stderr: `error: bad credentials ${FAKE_TOKEN}\n` }]);
    const error = await failure(h.forge.ensurePr(request));
    expect(error.message).toBe('gh failed (exit 1): list PRs: error: bad credentials [REDACTED]');
  });

  it('names the HTTP status of a failed lookup', async () => {
    const h = harness([httpError(401, 'Bad credentials')]);
    const error = await failure(h.forge.ensurePr(request));
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect(error.message).toBe('gh failed (exit 1): list PRs: HTTP 401: Bad credentials');
  });

  it('rejects a response that is not JSON or has no PR URL', async () => {
    const notJson = harness([{ exitCode: 0, stdout: '<html>', stderr: '' }]);
    expect((await failure(notJson.forge.ensurePr(request))).message).toBe('gh failed (exit 0): list PRs: unexpected response (not JSON)');
    const badUrl = harness([ok([]), ok({ number: 3, html_url: 'https://evil.example/pull/3' })]);
    expect((await failure(badUrl.forge.ensurePr(request))).message).toBe('gh failed (exit 0): create PR: unexpected response (no PR URL)');
  });

  it.each([
    ['agent/002-T44', 'main'],
    ['agent/hire-analyst', 'main'],
    ['agent/project-web', 'main'],
    ['agent/agent-x', 'develop'],
    ['feature/agent-002-T44', 'develop'],
    ['fix_1/agent-014-spec', 'release/2026.10'],
    ['ab-c/agent-x', 'develop'],
  ])('accepts the agent branch %s into %s', async (branch, base) => {
    const h = harness([ok([pr(50, branch, base)])]);
    expect(await h.forge.ensurePr({ ...request, branch, base })).toEqual({ number: 50, url: `https://github.com/${REPO}/pull/50` });
    expect(h.calls.map((call) => call.args)).toEqual([listArgsFor(branch, base)]);
  });

  it.each([
    [{ repo: 'octo' }, 'repo'],
    [{ repo: 'octo/roster/extra' }, 'repo'],
    [{ repo: '-octo/roster' }, 'repo'],
    [{ repo: 'octo/..' }, 'repo'],
    [{ repo: 'octo/{owner}' }, 'repo'],
    [{ branch: '' }, 'branch'],
    [{ branch: 'main' }, 'branch'],
    [{ branch: 'master' }, 'branch'],
    [{ branch: 'develop' }, 'branch'],
    [{ branch: 'agent/x', base: 'agent/x' }, 'branch'],
    [{ branch: 'agent' }, 'branch'],
    [{ branch: 'agent/' }, 'branch'],
    [{ branch: 'agent/a/b' }, 'branch'],
    [{ branch: 'agent/../main' }, 'branch'],
    [{ branch: 'agent/-x' }, 'branch'],
    [{ branch: 'agent/x.lock' }, 'branch'],
    [{ branch: 'agent/x.' }, 'branch'],
    [{ branch: `agent/${'x'.repeat(250)}` }, 'branch'],
    [{ branch: 'feature/x' }, 'branch'],
    [{ branch: 'feature/login' }, 'branch'],
    [{ branch: 'feature/agent-' }, 'branch'],
    [{ branch: 'feature/agent-a/b' }, 'branch'],
    [{ branch: 'feature/sub/agent-x' }, 'branch'],
    [{ branch: 'feature/agent-x.lock' }, 'branch'],
    [{ branch: 'Feature/agent-x' }, 'branch'],
    [{ branch: '1fix/agent-x' }, 'branch'],
    [{ branch: `${'p'.repeat(33)}/agent-x` }, 'branch'],
    [{ branch: 'main/agent-x' }, 'branch'],
    [{ branch: 'master/agent-x' }, 'branch'],
    [{ branch: 'develop/agent-x' }, 'branch'],
    [{ branch: 'head/agent-x' }, 'branch'],
    [{ branch: 'refs/agent-x' }, 'branch'],
    [{ branch: 'origin/agent-x' }, 'branch'],
    [{ base: '' }, 'base'],
    [{ base: 'x'.repeat(101) }, 'base'],
    [{ base: 'develop/' }, 'base'],
    [{ base: '/develop' }, 'base'],
    [{ base: 'release/../main' }, 'base'],
    [{ base: 'release..1' }, 'base'],
    [{ base: 'main.lock' }, 'base'],
    [{ base: 'main.' }, 'base'],
    [{ base: '-main' }, 'base'],
    [{ base: 'refs heads' }, 'base'],
    [{ base: 'main?x=1' }, 'base'],
    [{ base: 'ma%2Fin' }, 'base'],
    [{ title: '' }, 'PR title'],
    [{ title: 'line\nbreak' }, 'PR title'],
    [{ title: 'x'.repeat(257) }, 'PR title'],
    [{ body: 'x'.repeat(MAX_BODY_LENGTH + 1) }, 'PR body'],
    [{ body: 'nul\0' }, 'PR body'],
  ])('refuses %o before running gh', async (change, field) => {
    const h = harness([]);
    const error = await failure(h.forge.ensurePr({ ...request, ...change }));
    expect(error).toBeInstanceOf(GitHubInputError);
    expect((error as GitHubInputError).field).toBe(field);
    expect(h.calls).toEqual([]);
  });
});

describe('prState', () => {
  const viewArgs = ['api', '--hostname', 'github.com', '--method', 'GET', ...HEADERS, `repos/${REPO}/pulls/5`];

  it('returns open', async () => {
    const h = harness([ok({ ...pr(5), merged_at: null })]);
    expect(await h.forge.prState(REPO, 5)).toEqual({ state: 'open' });
    expect(h.calls.map((call) => call.args)).toEqual([viewArgs]);
    expectSafeCalls(h);
  });

  it('returns merged with mergedAt', async () => {
    const h = harness([ok({ ...pr(5, BRANCH, 'main', 'closed'), merged_at: '2026-10-30T21:04:05Z' })]);
    expect(await h.forge.prState(REPO, 5)).toEqual({ state: 'merged', mergedAt: '2026-10-30T21:04:05Z' });
  });

  it('returns closed when closed without a merge', async () => {
    const h = harness([ok({ ...pr(5, BRANCH, 'main', 'closed'), merged_at: null })]);
    expect(await h.forge.prState(REPO, 5)).toEqual({ state: 'closed' });
  });

  it('maps 404 to NotFoundError', async () => {
    const h = harness([httpError(404, 'Not Found')]);
    const error = await failure(h.forge.prState(REPO, 5));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe('pull request not found: octo/roster#5');
  });

  it('maps other HTTP errors to ExternalCommandError', async () => {
    const h = harness([httpError(502, 'Bad Gateway')]);
    const error = await failure(h.forge.prState(REPO, 5));
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect(error.message).toBe('gh failed (exit 1): read PR: HTTP 502: Bad Gateway');
  });

  it.each([
    [{ state: 'draft', merged_at: null }, 'unknown PR state'],
    [{ state: 'closed', merged_at: 'yesterday' }, 'invalid merged_at'],
    [[], 'not an object'],
  ])('rejects the unexpected response %o', async (json, what) => {
    const h = harness([ok(json)]);
    expect((await failure(h.forge.prState(REPO, 5))).message).toBe(`gh failed (exit 0): read PR: unexpected response (${what})`);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses PR number %s', async (number) => {
    const h = harness([]);
    expect(await failure(h.forge.prState(REPO, number))).toBeInstanceOf(GitHubInputError);
    expect(h.calls).toEqual([]);
  });
});

describe('branchProtection', () => {
  const branchArgs = (branch: string): string[] => ['api', '--hostname', 'github.com', '--method', 'GET', ...HEADERS, `repos/${REPO}/branches/${branch}`];
  const rulesArgs = (branch: string): string[] => [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    ...HEADERS,
    `repos/${REPO}/rules/branches/${branch}`,
  ];
  const classicArgs = (branch: string): string[] => [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    ...HEADERS,
    `repos/${REPO}/branches/${branch}/protection`,
  ];
  const exists = (name: string): GhOutput => ok({ name, protected: true, commit: { sha: 'abc' } });
  const rule = (type: string): Record<string, unknown> => ({ type, ruleset_source_type: 'Repository', ruleset_id: 1 });
  const classic = (prReviews: boolean, allowForcePushes: boolean): Record<string, unknown> => ({
    url: `https://api.github.com/repos/${REPO}/branches/main/protection`,
    ...(prReviews ? { required_pull_request_reviews: { required_approving_review_count: 0 } } : {}),
    allow_force_pushes: { enabled: allowForcePushes },
    enforce_admins: { enabled: true },
  });
  const noAdmin = httpError(403, 'Resource not accessible by personal access token');

  it('reads the branch, then rulesets, then classic protection', async () => {
    const h = harness([exists('main'), ok([]), ok(classic(true, false))]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'known', prRequired: true, forcePushBlocked: true });
    expect(h.calls.map((call) => call.args)).toEqual([branchArgs('main'), rulesArgs('main'), classicArgs('main')]);
    expectSafeCalls(h);
  });

  it('reports a protected develop branch', async () => {
    const h = harness([exists('develop'), ok([rule('pull_request'), rule('non_fast_forward')]), ok(classic(true, false))]);
    expect(await h.forge.branchProtection(REPO, 'develop')).toEqual({ state: 'known', prRequired: true, forcePushBlocked: true });
    expect(h.calls.map((call) => call.args)).toEqual([branchArgs('develop'), rulesArgs('develop'), classicArgs('develop')]);
    expectSafeCalls(h);
  });

  it('reads a base branch whose name has a slash', async () => {
    const h = harness([exists('release/2026.10'), ok([]), httpError(404, 'Branch not protected')]);
    expect(await h.forge.branchProtection(REPO, 'release/2026.10')).toEqual({ state: 'known', prRequired: false, forcePushBlocked: false });
    expect(h.calls.map((call) => call.args)).toEqual([
      branchArgs('release/2026.10'),
      rulesArgs('release/2026.10'),
      classicArgs('release/2026.10'),
    ]);
  });

  it('is missing on a 404 from the branches endpoint and reads nothing else', async () => {
    const h = harness([httpError(404, 'Branch not found')]);
    expect(await h.forge.branchProtection(REPO, 'develop')).toEqual({ state: 'missing' });
    expect(h.calls.map((call) => call.args)).toEqual([branchArgs('develop')]);
    expectSafeCalls(h);
  });

  it('is missing when GitHub answers for another branch (a renamed branch redirects)', async () => {
    const h = harness([exists('trunk')]);
    expect(await h.forge.branchProtection(REPO, 'master')).toEqual({ state: 'missing' });
    expect(h.calls).toHaveLength(1);
  });

  it('is unknown without Administration read when rulesets do not decide both flags', async () => {
    const h = harness([exists('develop'), ok([rule('deletion')]), noAdmin]);
    expect(await h.forge.branchProtection(REPO, 'develop')).toEqual({ state: 'unknown' });
  });

  it('is unknown without Administration read on a private repo (404 that is not "Branch not protected")', async () => {
    const h = harness([exists('main'), ok([rule('pull_request')]), httpError(404, 'Not Found')]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'unknown' });
  });

  it('is known from rulesets alone when they require PRs and block force pushes', async () => {
    const h = harness([exists('main'), ok([rule('pull_request'), rule('non_fast_forward'), rule('deletion')]), noAdmin]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'known', prRequired: true, forcePushBlocked: true });
  });

  it('reports an unprotected branch as known and unprotected', async () => {
    const h = harness([exists('develop'), ok([]), httpError(404, 'Branch not protected')]);
    expect(await h.forge.branchProtection(REPO, 'develop')).toEqual({ state: 'known', prRequired: false, forcePushBlocked: false });
  });

  it('reports classic protection that allows force pushes and needs no PR', async () => {
    const h = harness([exists('main'), ok([]), ok(classic(false, true))]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'known', prRequired: false, forcePushBlocked: false });
  });

  it('combines a ruleset PR rule with classic force-push blocking', async () => {
    const h = harness([exists('main'), ok([rule('pull_request')]), ok(classic(false, false))]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'known', prRequired: true, forcePushBlocked: true });
  });

  it('is unknown when neither protection source can be read', async () => {
    const h = harness([exists('main'), httpError(404, 'Not Found'), noAdmin]);
    expect(await h.forge.branchProtection(REPO, 'main')).toEqual({ state: 'unknown' });
  });

  it('throws on other errors instead of guessing', async () => {
    const branchDown = harness([httpError(401, 'Bad credentials')]);
    expect((await failure(branchDown.forge.branchProtection(REPO, 'main'))).message).toBe(
      'gh failed (exit 1): read branch: HTTP 401: Bad credentials',
    );
    const noName = harness([ok({ protected: true })]);
    expect((await failure(noName.forge.branchProtection(REPO, 'main'))).message).toBe(
      'gh failed (exit 0): read branch: unexpected response (no branch name)',
    );
    const rulesDown = harness([exists('main'), httpError(500, 'Server Error')]);
    expect(await failure(rulesDown.forge.branchProtection(REPO, 'main'))).toBeInstanceOf(ExternalCommandError);
    const classicDown = harness([exists('main'), ok([]), httpError(401, 'Bad credentials')]);
    expect((await failure(classicDown.forge.branchProtection(REPO, 'main'))).message).toBe(
      'gh failed (exit 1): read branch protection: HTTP 401: Bad credentials',
    );
    const malformed = harness([exists('main'), ok([]), ok({ url: 'x' })]);
    expect((await failure(malformed.forge.branchProtection(REPO, 'main'))).message).toBe(
      'gh failed (exit 0): read branch protection: unexpected response (no allow_force_pushes)',
    );
  });

  it.each(['', 'develop/', '../main', 'main/../x', 'main.lock', '-x', 'a b', 'main?x=1', 'x'.repeat(101)])(
    'refuses the branch %j before running gh',
    async (branch) => {
      const h = harness([]);
      const error = await failure(h.forge.branchProtection(REPO, branch));
      expect(error).toBeInstanceOf(GitHubInputError);
      expect((error as GitHubInputError).field).toBe('branch');
      expect(h.calls).toEqual([]);
    },
  );

  it('refuses an invalid repo before running gh', async () => {
    const h = harness([]);
    expect(await failure(h.forge.branchProtection('octo', 'main'))).toBeInstanceOf(GitHubInputError);
    expect(h.calls).toEqual([]);
  });
});

describe('canRead', () => {
  const repoArgs = ['api', '--hostname', 'github.com', '--method', 'GET', ...HEADERS, `repos/${REPO}`];

  it('is true when the repository is readable', async () => {
    const h = harness([ok({ full_name: REPO, private: true })]);
    expect(await h.forge.canRead(REPO)).toBe(true);
    expect(h.calls.map((call) => call.args)).toEqual([repoArgs]);
    expectSafeCalls(h);
  });

  it.each([403, 404])('is false on HTTP %i', async (status) => {
    const h = harness([httpError(status, 'Not Found')]);
    expect(await h.forge.canRead(REPO)).toBe(false);
  });

  it('throws on a bad token instead of reporting "cannot read"', async () => {
    const h = harness([httpError(401, 'Bad credentials')]);
    expect((await failure(h.forge.canRead(REPO))).message).toBe('gh failed (exit 1): read repository: HTTP 401: Bad credentials');
  });
});

describe('token handling', () => {
  it('reads the token once, on the first gh call', async () => {
    const h = harness([ok({ full_name: REPO }), ok({ full_name: REPO })]);
    expect(h.tokenReads).toBe(0);
    await h.forge.canRead(REPO);
    await h.forge.canRead(REPO);
    expect(h.tokenReads).toBe(1);
  });

  it('propagates SecretMissingError and never runs gh without a token', async () => {
    const h = harness([], async () => {
      throw new SecretMissingError('github-token', 'roster auth set github');
    });
    expect(await failure(h.forge.canRead(REPO))).toBeInstanceOf(SecretMissingError);
    expect(h.calls).toEqual([]);
  });

  it('refuses a token with whitespace without echoing it', async () => {
    const bad = `${FAKE_TOKEN} --hostname evil.example`;
    const h = harness([], async () => bad);
    const error = await failure(h.forge.canRead(REPO));
    expect(error).toBeInstanceOf(GitHubInputError);
    expect(error.message).not.toContain('evil');
    expect(h.calls).toEqual([]);
  });

  it('wraps a runner failure and redacts the token from it', async () => {
    const h = harness([new ExternalCommandError('gh', null, `could not run (${FAKE_TOKEN})`)]);
    const error = await failure(h.forge.canRead(REPO));
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect(error.message).toBe('gh failed (exit none): read repository: gh failed (exit none): could not run ([REDACTED])');
  });

  it('hides the text of an unknown runner failure', async () => {
    const h = harness([new Error(`spawn failed ${FAKE_TOKEN}`)]);
    const error = await failure(h.forge.canRead(REPO));
    expect(error.message).toBe('gh failed (exit none): read repository: could not run');
  });
});

describe('construction', () => {
  it('requires an absolute config directory and a token source', () => {
    expect(() => createGitHubForge({ token: async () => FAKE_TOKEN, configDir: 'relative\\gh' })).toThrow(GitHubInputError);
    expect(() => createGitHubForge({ configDir: 'C:\\gh' } as never)).toThrow(GitHubInputError);
  });
});
