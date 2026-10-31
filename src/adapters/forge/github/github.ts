// GitHub adapter (ForgePort, plan 002 sections 4.3, 7.1, 7.8 and 8 step 10, ADR 0026, ADR 0029).
//
// Every call is `gh api` against the REST API of github.com, run through `execFile` with an argument
// array (runner.ts). Using `gh api` instead of `gh pr create` or `gh pr view` keeps gh away from git
// entirely: it never inspects a work tree, a remote or a local branch, so no untrusted repository
// content can influence what gh does. The child runs in a directory owned by Roster that is also its
// `GH_CONFIG_DIR`, so the human's own gh login, aliases and settings never apply.
//
// The fine-grained token of ADR 0029 reaches only the gh child, as `GH_TOKEN` in its environment. It
// is never an argument, never written to disk by Roster, and every error text is redacted. A PR body
// is untrusted free text (ADR 0026 point 5): it travels to gh on stdin inside a JSON request body
// (`--input -`), never as an argument. Roster never merges.

import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ExternalCommandError, NotFoundError, RosterError } from '../../../core/domain/errors.ts';
import type { ForgePort, MainProtection, PrState, PullRequestRef, PullRequestRequest } from '../../../ports/forge.ts';
import { GitHubInputError } from './errors.ts';
import { execFileGhRunner, ghEnv } from './runner.ts';
import type { GhCall, GhRunner } from './runner.ts';

export interface GitHubForgeOptions {
  /**
   * Returns the GitHub token (`SecretsPort.get('github-token')` in the composition root). Called on
   * the first gh call, not at construction; a successful value is reused for the adapter's lifetime.
   */
  readonly token: () => Promise<string>;
  /**
   * Directory owned by Roster, outside every workspace: gh's `GH_CONFIG_DIR` and the child's working
   * directory. Created when missing. For example `%LOCALAPPDATA%\Roster\gh`.
   */
  readonly configDir: string;
  /** Defaults to `execFileGhRunner()`. Tests pass a stub. */
  readonly runner?: GhRunner;
  /** Environment the allowlist is taken from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The only base branch Roster opens PRs against (plan 002 section 6: `defaultBranch` is `main`). */
export const BASE_BRANCH = 'main';
/** GitHub's limit for a PR body, in characters. */
export const MAX_BODY_LENGTH = 65_536;
export const MAX_TITLE_LENGTH = 256;

const API_HEADERS = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;
const HTTP_STATUS = /\(HTTP (\d{3})\)/g;

/** Arguments of one `gh api` call. GET fields become query parameters (`-f`, never `-F`). */
export function apiArgs(
  method: 'GET' | 'POST',
  path: string,
  fields: Readonly<Record<string, string>> = {},
  stdinBody = false,
): string[] {
  const args = ['api', '--hostname', 'github.com', '--method', method, ...API_HEADERS, path];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  if (stdinBody) args.push('--input', '-');
  return args;
}

function checkRepo(repo: string): void {
  if (typeof repo !== 'string') throw new GitHubInputError('repo', 'must be <owner>/<repo>');
  const parts = repo.split('/');
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO_NAME.test(name) || name === '.' || name === '..') {
    throw new GitHubInputError('repo', 'must be <owner>/<repo>');
  }
}

/** Roster only opens PRs from branches the push guard allows: plain names under `agent/`. */
function checkBranch(branch: string): void {
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > 250) {
    throw new GitHubInputError('branch', 'must be 1 to 250 characters');
  }
  if (!branch.startsWith('agent/')) throw new GitHubInputError('branch', 'must start with agent/');
  for (const segment of branch.split('/')) {
    if (!BRANCH_SEGMENT.test(segment) || segment.includes('..') || segment.endsWith('.lock') || segment.endsWith('.')) {
      throw new GitHubInputError('branch', 'is not a plain branch name');
    }
  }
}

function checkNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0) throw new GitHubInputError('PR number', 'must be a positive integer');
}

function checkTitle(title: string): void {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new GitHubInputError('PR title', `must be 1 to ${MAX_TITLE_LENGTH} characters`);
  }
  if (CONTROL.test(title)) throw new GitHubInputError('PR title', 'must not contain control characters');
}

function checkBody(body: string): void {
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) {
    throw new GitHubInputError('PR body', `must be at most ${MAX_BODY_LENGTH} characters`);
  }
  if (body.includes('\0')) throw new GitHubInputError('PR body', 'must not contain NUL');
}

function checkToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new GitHubInputError('GitHub token', 'is empty or has whitespace or control characters');
  }
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[REDACTED]');
}

/** One line of external text for an error message: redacted, control characters removed, capped. */
function clean(text: string, secret: string): string {
  const line = redact(text, secret)
    .split(/\r?\n/)
    .map((part) => part.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
    .filter((part) => part.length > 0)
    .at(-1) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type ApiResult =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly exitCode: number; readonly status: number | null; readonly message: string };

class UnexpectedResponseError extends ExternalCommandError {
  constructor(label: string, what: string) {
    super('gh', 0, `${label}: unexpected response (${what})`);
  }
}

function parsePrRef(label: string, json: unknown): PullRequestRef {
  if (!isRecord(json)) throw new UnexpectedResponseError(label, 'not an object');
  const { number, html_url: url } = json;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new UnexpectedResponseError(label, 'no PR number');
  }
  if (typeof url !== 'string' || !PR_URL.test(url)) throw new UnexpectedResponseError(label, 'no PR URL');
  return { number, url };
}

function refOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value['ref'] === 'string' ? value['ref'] : undefined;
}

/** A protection flag: true when a known source says so, false only when every source is known and says no. */
function decide(...sources: readonly (boolean | null)[]): boolean | null {
  if (sources.some((source) => source === true)) return true;
  return sources.every((source) => source === false) ? false : null;
}

export class GitHubForge implements ForgePort {
  readonly #tokenSource: () => Promise<string>;
  readonly #configDir: string;
  readonly #runner: GhRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  #token: string | undefined;

  constructor(options: GitHubForgeOptions) {
    if (typeof options.token !== 'function') throw new GitHubInputError('token source', 'is required');
    if (typeof options.configDir !== 'string' || !isAbsolute(options.configDir)) {
      throw new GitHubInputError('gh config directory', 'must be an absolute path');
    }
    this.#tokenSource = options.token;
    this.#configDir = options.configDir;
    this.#runner = options.runner ?? execFileGhRunner();
    this.#env = options.env ?? process.env;
  }

  async ensurePr(request: PullRequestRequest): Promise<PullRequestRef> {
    checkRepo(request.repo);
    checkBranch(request.branch);
    checkTitle(request.title);
    checkBody(request.body);
    const existing = await this.#findOpenPr(request.repo, request.branch);
    if (existing !== null) return existing;

    const label = 'create PR';
    const payload = JSON.stringify({ title: request.title, head: request.branch, base: BASE_BRANCH, body: request.body });
    const created = await this.#api(label, apiArgs('POST', `repos/${request.repo}/pulls`, {}, true), payload);
    if (created.ok) return parsePrRef(label, created.json);
    // 422: a PR for this head and base appeared since the lookup (or GitHub refused the request).
    if (created.status === 422) {
      const raced = await this.#findOpenPr(request.repo, request.branch);
      if (raced !== null) return raced;
    }
    throw this.#failure(label, created);
  }

  async prState(repo: string, number: number): Promise<PrState> {
    checkRepo(repo);
    checkNumber(number);
    const label = 'read PR';
    const result = await this.#api(label, apiArgs('GET', `repos/${repo}/pulls/${number}`));
    if (!result.ok) {
      if (result.status === 404) throw new NotFoundError('pull request', `${repo}#${number}`);
      throw this.#failure(label, result);
    }
    const json = result.json;
    if (!isRecord(json)) throw new UnexpectedResponseError(label, 'not an object');
    const { state, merged_at: mergedAt } = json;
    if (state === 'open') return { state: 'open' };
    if (state !== 'closed') throw new UnexpectedResponseError(label, 'unknown PR state');
    if (mergedAt === null || mergedAt === undefined) return { state: 'closed' };
    if (typeof mergedAt !== 'string' || !ISO_UTC.test(mergedAt)) throw new UnexpectedResponseError(label, 'invalid merged_at');
    return { state: 'merged', mergedAt };
  }

  /**
   * Combines the branch rules of rulesets (readable with Metadata read) and classic branch protection
   * (readable only with Administration read). A flag is reported only when it is decided: true when
   * either source enforces it, false when both sources are readable and neither does. Anything else
   * is `unknown`, which is what a token without Administration read gets unless rulesets alone
   * already require PRs and block force pushes.
   */
  async mainProtection(repo: string): Promise<MainProtection> {
    checkRepo(repo);
    const rules = await this.#rulesetRules(repo);
    const classic = await this.#classicProtection(repo);
    const prRequired = decide(rules === null ? null : rules.has('pull_request'), classic === null ? null : classic.prRequired);
    const forcePushBlocked = decide(
      rules === null ? null : rules.has('non_fast_forward'),
      classic === null ? null : classic.forcePushBlocked,
    );
    if (prRequired === null || forcePushBlocked === null) return { known: false };
    return { known: true, prRequired, forcePushBlocked };
  }

  async canRead(repo: string): Promise<boolean> {
    checkRepo(repo);
    const label = 'read repository';
    const result = await this.#api(label, apiArgs('GET', `repos/${repo}`));
    if (result.ok) {
      if (!isRecord(result.json) || typeof result.json['full_name'] !== 'string') {
        throw new UnexpectedResponseError(label, 'no repository');
      }
      return true;
    }
    if (result.status === 403 || result.status === 404) return false;
    throw this.#failure(label, result);
  }

  async #findOpenPr(repo: string, branch: string): Promise<PullRequestRef | null> {
    const label = 'list PRs';
    const owner = repo.split('/')[0] as string;
    const fields = { state: 'open', head: `${owner}:${branch}`, base: BASE_BRANCH };
    const result = await this.#api(label, apiArgs('GET', `repos/${repo}/pulls`, fields));
    if (!result.ok) throw this.#failure(label, result);
    if (!Array.isArray(result.json)) throw new UnexpectedResponseError(label, 'not a list');
    const match = result.json.find(
      (pr: unknown) => isRecord(pr) && pr['state'] === 'open' && refOf(pr['head']) === branch && refOf(pr['base']) === BASE_BRANCH,
    );
    return match === undefined ? null : parsePrRef(label, match);
  }

  /** Types of the active ruleset rules of `main`, or null when they cannot be read. */
  async #rulesetRules(repo: string): Promise<Set<string> | null> {
    const label = 'read branch rules';
    const result = await this.#api(label, apiArgs('GET', `repos/${repo}/rules/branches/${BASE_BRANCH}`));
    if (!result.ok) {
      if (result.status === 403 || result.status === 404) return null;
      throw this.#failure(label, result);
    }
    if (!Array.isArray(result.json)) throw new UnexpectedResponseError(label, 'not a list');
    const types = new Set<string>();
    for (const rule of result.json) {
      if (isRecord(rule) && typeof rule['type'] === 'string') types.add(rule['type']);
    }
    return types;
  }

  /** Classic protection of `main`; both flags false when it is not protected; null when unreadable. */
  async #classicProtection(repo: string): Promise<{ prRequired: boolean; forcePushBlocked: boolean } | null> {
    const label = 'read branch protection';
    const result = await this.#api(label, apiArgs('GET', `repos/${repo}/branches/${BASE_BRANCH}/protection`));
    if (!result.ok) {
      if (result.status === 404 && result.message === 'Branch not protected') return { prRequired: false, forcePushBlocked: false };
      // Without Administration read GitHub answers 403 (or 404 on private repos).
      if (result.status === 403 || result.status === 404) return null;
      throw this.#failure(label, result);
    }
    const json = result.json;
    if (!isRecord(json)) throw new UnexpectedResponseError(label, 'not an object');
    const forcePushes = json['allow_force_pushes'];
    if (!isRecord(forcePushes) || typeof forcePushes['enabled'] !== 'boolean') {
      throw new UnexpectedResponseError(label, 'no allow_force_pushes');
    }
    return { prRequired: isRecord(json['required_pull_request_reviews']), forcePushBlocked: !forcePushes['enabled'] };
  }

  async #currentToken(): Promise<string> {
    if (this.#token !== undefined) return this.#token;
    const token = await this.#tokenSource();
    checkToken(token);
    this.#token = token;
    return token;
  }

  /** Runs one `gh api` call. Resolves with the parsed body, or with the HTTP status and message. */
  async #api(label: string, args: readonly string[], input?: string): Promise<ApiResult> {
    const token = await this.#currentToken();
    mkdirSync(this.#configDir, { recursive: true });
    const base: GhCall = { args, env: ghEnv(this.#env, this.#configDir, token), cwd: this.#configDir };
    let output;
    try {
      output = await this.#runner(input === undefined ? base : { ...base, input });
    } catch (error) {
      if (error instanceof RosterError) throw new ExternalCommandError('gh', null, `${label}: ${clean(error.message, token)}`);
      throw new ExternalCommandError('gh', null, `${label}: could not run`);
    }
    if (output.exitCode === 0) {
      const json = parseJson(output.stdout);
      if (json === undefined) throw new UnexpectedResponseError(label, 'not JSON');
      return { ok: true, json };
    }
    const statuses = [...output.stderr.matchAll(HTTP_STATUS)];
    const statusText = statuses.at(-1)?.[1];
    const body = parseJson(output.stdout);
    const apiMessage = isRecord(body) && typeof body['message'] === 'string' ? clean(body['message'], token) : '';
    const message = apiMessage.length > 0 ? apiMessage : clean(output.stderr, token) || 'no error output';
    return { ok: false, exitCode: output.exitCode, status: statusText === undefined ? null : Number(statusText), message };
  }

  #failure(label: string, result: { readonly exitCode: number; readonly status: number | null; readonly message: string }): ExternalCommandError {
    const status = result.status === null ? '' : `HTTP ${result.status}: `;
    return new ExternalCommandError('gh', result.exitCode, `${label}: ${status}${result.message}`);
  }
}

/** Builds the ForgePort. The composition root passes `token: () => secrets.get('github-token')`. */
export function createGitHubForge(options: GitHubForgeOptions): GitHubForge {
  return new GitHubForge(options);
}
