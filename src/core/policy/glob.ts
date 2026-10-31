// Glob matcher for protected paths and allowed paths (ADR 0025). No dependencies.
//
// Paths use forward slashes and are relative to the repository root. Matching is case-sensitive.
// A pattern is split on `/`. A segment `**` matches zero or more whole segments. Inside any other
// segment `*` matches any run of characters except `/`. Every other character is literal; there is
// no `?`, no character class and no escaping.

/** True when `pattern` is a usable glob: non-empty segments, `**` only as a whole segment. */
export function isValidGlob(pattern: string): boolean {
  if (pattern === '' || pattern.startsWith('/') || pattern.includes('\\')) {
    return false;
  }
  return pattern.split('/').every((segment) => segment !== '' && (segment === '**' || !segment.includes('**')));
}

function matchSegment(pattern: string, text: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) {
    return pattern === text;
  }
  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) {
    return false;
  }
  let position = first.length;
  const end = text.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = text.indexOf(middle, position);
    if (found === -1 || found + middle.length > end) {
      return false;
    }
    position = found + middle.length;
  }
  return true;
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return path.length === 0;
  }
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip += 1) {
      if (matchSegments(rest, path.slice(skip))) {
        return true;
      }
    }
    return false;
  }
  const [first, ...others] = path;
  return first !== undefined && matchSegment(head, first) && matchSegments(rest, others);
}

/** True when `path` matches the whole `pattern`. An invalid pattern matches nothing. */
export function globMatch(pattern: string, path: string): boolean {
  if (!isValidGlob(pattern)) {
    return false;
  }
  return matchSegments(pattern.split('/'), path.split('/'));
}
