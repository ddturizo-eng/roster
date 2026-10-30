// FileSystemPort: host files for the core (workspace `in`/`out` files, logs, retention), so `core`
// imports no Node built-in. Paths are host paths; build them with `join`.

export interface FileStat {
  readonly kind: 'file' | 'directory';
  /** ISO 8601 UTC. */
  readonly modifiedAt: string;
}

export interface FileSystemPort {
  /** Joins path segments with the host separator. */
  join(...segments: string[]): string;
  /** File content as UTF-8, or undefined when the file does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** Writes UTF-8 content, creating parent directories. */
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Creates a directory and its parents; no error when it exists. */
  makeDir(path: string): Promise<void>;
  /** Removes a file or a directory tree; no error when it does not exist. */
  remove(path: string): Promise<void>;
  /** Entry names of a directory, sorted. */
  list(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<FileStat | undefined>;
  /**
   * SHA-256 hex digest over the given files under `root` (dependency manifests, ADR 0024). It
   * depends only on each path, its presence and its content; the order of `paths` does not matter.
   */
  hashFiles(root: string, paths: readonly string[]): Promise<string>;
}
