// Reads the fixed policy from `origin/main` of the Roster repo (plan 002 section 6), never from a
// working copy. `parsePolicy` (T08) validates it.

import { PolicyError } from '../core/policy/errors.ts';
import { parsePolicy } from '../core/policy/policy.ts';
import type { Policy } from '../core/policy/policy.ts';
import type { VcsPort } from '../ports/vcs.ts';

export const POLICY_REF = 'origin/main';
export const POLICY_FILES = ['policies/mvp.json', 'policies/protected-paths.json'] as const;

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as unknown;
  } catch {
    throw new PolicyError([`${file} is not valid JSON`]);
  }
}

/** Throws PolicyError when a file is missing at `origin/main`, is not JSON, or breaks the policy rules. */
export async function loadPolicy(vcs: VcsPort, rosterRepoPath: string): Promise<Policy> {
  const commit = await vcs.resolveRef(rosterRepoPath, POLICY_REF);
  const contents: unknown[] = [];
  for (const file of POLICY_FILES) {
    const text = await vcs.showFile(rosterRepoPath, commit, file);
    if (text === null) throw new PolicyError([`${file} is missing at ${POLICY_REF}`]);
    contents.push(parseJson(text, file));
  }
  return parsePolicy(contents[0], contents[1]);
}
