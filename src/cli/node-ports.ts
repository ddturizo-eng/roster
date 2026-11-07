// Node implementations of the two small ports no adapter owns: the system clock and the host file
// system. They live in the composition root because they carry no policy, only Node built-ins.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClockPort } from '../ports/clock.ts';
import type { FileStat, FileSystemPort } from '../ports/file-system.ts';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Whether a process is alive, by the signal-0 probe. EPERM means it exists but is not ours. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export function createSystemClock(): ClockPort {
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Content of `path`, or undefined when it does not exist. */
async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EISDIR') return undefined;
    throw error;
  }
}

export function createNodeFileSystem(): FileSystemPort {
  return {
    join: (...segments) => join(...segments),
    async readText(path) {
      return (await readIfPresent(path))?.toString('utf8');
    },
    async writeText(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    async exists(path) {
      return (await stat(path).catch(() => undefined)) !== undefined;
    },
    async makeDir(path) {
      await mkdir(path, { recursive: true });
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async list(path) {
      try {
        return (await readdir(path)).sort();
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    async stat(path): Promise<FileStat | undefined> {
      const info = await stat(path).catch(() => undefined);
      if (info === undefined) return undefined;
      return { kind: info.isDirectory() ? 'directory' : 'file', modifiedAt: info.mtime.toISOString() };
    },
    async hashFiles(root, paths) {
      const hash = createHash('sha256');
      for (const path of [...new Set(paths)].sort()) {
        const content = await readIfPresent(join(root, ...path.split('/')));
        hash.update(`${path}\0${content === undefined ? 'absent' : 'present'}\0`);
        if (content !== undefined) hash.update(content);
        hash.update('\0');
      }
      return hash.digest('hex');
    },
  };
}
