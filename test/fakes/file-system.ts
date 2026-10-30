// Fake FileSystemPort: an in-memory tree with `/` separators.

import { createHash } from 'node:crypto';
import type { FileStat, FileSystemPort } from '../../src/ports/file-system.ts';
import { FAKE_START_TIME } from './clock.ts';
import { CallLog, Responses } from './recorder.ts';

export class FakeFileSystem implements FileSystemPort {
  readonly log: CallLog;
  readonly responses = new Responses<FileSystemPort>();
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  /** Modification times; files and directories without an entry report FAKE_START_TIME. */
  readonly modifiedAt = new Map<string, string>();

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  join(...segments: string[]): string {
    this.log.record('fs', 'join', segments);
    return this.responses.answer('join', segments, () => normalize(segments.join('/')));
  }

  async readText(path: string): Promise<string | undefined> {
    this.log.record('fs', 'readText', [path]);
    return this.responses.answer('readText', [path], () => this.files.get(normalize(path)));
  }

  async writeText(path: string, content: string): Promise<void> {
    this.log.record('fs', 'writeText', [path, content]);
    this.responses.answer('writeText', [path, content], () => {
      const file = normalize(path);
      this.#addParents(file);
      this.files.set(file, content);
    });
  }

  async exists(path: string): Promise<boolean> {
    this.log.record('fs', 'exists', [path]);
    return this.responses.answer('exists', [path], () => {
      const target = normalize(path);
      return this.files.has(target) || this.directories.has(target);
    });
  }

  async makeDir(path: string): Promise<void> {
    this.log.record('fs', 'makeDir', [path]);
    this.responses.answer('makeDir', [path], () => {
      const directory = normalize(path);
      this.#addParents(directory);
      this.directories.add(directory);
    });
  }

  async remove(path: string): Promise<void> {
    this.log.record('fs', 'remove', [path]);
    this.responses.answer('remove', [path], () => {
      const target = normalize(path);
      const inside = (entry: string): boolean => entry === target || entry.startsWith(`${target}/`);
      for (const file of [...this.files.keys()]) if (inside(file)) this.files.delete(file);
      for (const directory of [...this.directories]) if (inside(directory)) this.directories.delete(directory);
    });
  }

  async list(path: string): Promise<readonly string[]> {
    this.log.record('fs', 'list', [path]);
    return this.responses.answer('list', [path], () => {
      const prefix = `${normalize(path)}/`;
      const names = new Set<string>();
      for (const entry of [...this.files.keys(), ...this.directories]) {
        if (entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0] ?? '');
      }
      return [...names].filter((name) => name !== '').sort();
    });
  }

  async stat(path: string): Promise<FileStat | undefined> {
    this.log.record('fs', 'stat', [path]);
    return this.responses.answer('stat', [path], (): FileStat | undefined => {
      const target = normalize(path);
      const modifiedAt = this.modifiedAt.get(target) ?? FAKE_START_TIME;
      if (this.files.has(target)) return { kind: 'file', modifiedAt };
      if (this.directories.has(target)) return { kind: 'directory', modifiedAt };
      return undefined;
    });
  }

  async hashFiles(root: string, paths: readonly string[]): Promise<string> {
    this.log.record('fs', 'hashFiles', [root, paths]);
    return this.responses.answer('hashFiles', [root, paths], () => {
      const hash = createHash('sha256');
      for (const path of [...paths].sort()) {
        const content = this.files.get(normalize(`${root}/${path}`));
        hash.update(`${path}\u0000${content === undefined ? '-' : `+${content}`}\u0000`);
      }
      return hash.digest('hex');
    });
  }

  #addParents(path: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (parent !== '') this.directories.add(parent);
    }
  }
}

function normalize(path: string): string {
  const collapsed = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}
