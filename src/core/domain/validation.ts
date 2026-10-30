// Small hand-written validation toolkit used by the result validators (ADR 0017: no schema library).
//
// Validators never throw on bad input. They collect issues with a JSON path (`$`, `$.summary`,
// `$.questions[1].text`) and either return the typed value or the full list of issues. Messages
// describe the rule that failed and never echo the offending value, which is untrusted.

export type IssueCode =
  | 'invalid_json'
  | 'required'
  | 'type'
  | 'enum'
  | 'empty'
  | 'too_long'
  | 'too_many'
  | 'pattern'
  | 'duplicate'
  | 'range';

export interface ValidationIssue {
  /** JSON path of the offending value, for example `$.questions[0].text`. */
  readonly path: string;
  readonly code: IssueCode;
  readonly message: string;
}

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export function childPath(parent: string, key: string): string {
  return `${parent}.${key}`;
}

export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface StringRule {
  readonly maxLength: number;
  /** Rejects strings that are empty or only whitespace. */
  readonly nonEmpty: boolean;
  readonly pattern?: RegExp;
}

/** Collects issues while reading an untrusted JSON value. */
export class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, code: IssueCode, message: string): void {
    this.issues.push({ path, code, message });
  }

  /** Reads a property; `null` counts as absent for optional properties. */
  private property(object: Readonly<Record<string, unknown>>, key: string): unknown {
    return Object.hasOwn(object, key) ? object[key] : undefined;
  }

  /** Returns true when the property is present (not undefined and not null). */
  has(object: Readonly<Record<string, unknown>>, key: string): boolean {
    const value = this.property(object, key);
    return value !== undefined && value !== null;
  }

  checkString(value: unknown, path: string, rule: StringRule): string | undefined {
    if (typeof value !== 'string') {
      this.add(path, 'type', 'must be a string');
      return undefined;
    }
    if (rule.nonEmpty && value.trim() === '') {
      this.add(path, 'empty', 'must not be empty');
      return undefined;
    }
    if (value.length > rule.maxLength) {
      this.add(path, 'too_long', `must be at most ${rule.maxLength} characters`);
      return undefined;
    }
    if (rule.pattern !== undefined && !rule.pattern.test(value)) {
      this.add(path, 'pattern', `must match ${String(rule.pattern)}`);
      return undefined;
    }
    return value;
  }

  requiredString(
    object: Readonly<Record<string, unknown>>,
    key: string,
    parent: string,
    rule: StringRule,
  ): string | undefined {
    const path = childPath(parent, key);
    if (!this.has(object, key)) {
      this.add(path, 'required', 'is required');
      return undefined;
    }
    return this.checkString(this.property(object, key), path, rule);
  }

  optionalString(
    object: Readonly<Record<string, unknown>>,
    key: string,
    parent: string,
    rule: StringRule,
  ): string | undefined {
    if (!this.has(object, key)) return undefined;
    return this.checkString(this.property(object, key), childPath(parent, key), rule);
  }

  requiredEnum<T extends string>(
    object: Readonly<Record<string, unknown>>,
    key: string,
    parent: string,
    values: readonly T[],
  ): T | undefined {
    const path = childPath(parent, key);
    if (!this.has(object, key)) {
      this.add(path, 'required', 'is required');
      return undefined;
    }
    const value = this.property(object, key);
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
      this.add(path, 'enum', `must be one of: ${values.join(', ')}`);
      return undefined;
    }
    return value as T;
  }

  requiredBoolean(object: Readonly<Record<string, unknown>>, key: string, parent: string): boolean | undefined {
    const path = childPath(parent, key);
    if (!this.has(object, key)) {
      this.add(path, 'required', 'is required');
      return undefined;
    }
    const value = this.property(object, key);
    if (typeof value !== 'boolean') {
      this.add(path, 'type', 'must be a boolean');
      return undefined;
    }
    return value;
  }

  optionalPositiveInteger(
    object: Readonly<Record<string, unknown>>,
    key: string,
    parent: string,
  ): number | undefined {
    if (!this.has(object, key)) return undefined;
    const path = childPath(parent, key);
    const value = this.property(object, key);
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.add(path, 'type', 'must be an integer');
      return undefined;
    }
    if (value < 1) {
      this.add(path, 'range', 'must be at least 1');
      return undefined;
    }
    return value;
  }

  /**
   * Reads an array property. Returns undefined when it is absent (reporting `required` only when
   * `required` is true) or invalid; otherwise the elements, to be checked by the caller.
   */
  array(
    object: Readonly<Record<string, unknown>>,
    key: string,
    parent: string,
    options: { readonly required: boolean; readonly maxItems: number },
  ): readonly unknown[] | undefined {
    const path = childPath(parent, key);
    if (!this.has(object, key)) {
      if (options.required) this.add(path, 'required', 'is required');
      return undefined;
    }
    const value = this.property(object, key);
    if (!Array.isArray(value)) {
      this.add(path, 'type', 'must be an array');
      return undefined;
    }
    if (value.length > options.maxItems) {
      this.add(path, 'too_many', `must have at most ${options.maxItems} items`);
      return undefined;
    }
    return value;
  }

  /** Checks that a value is a JSON object, reporting a type issue at `path` otherwise. */
  object(value: unknown, path: string): Readonly<Record<string, unknown>> | undefined {
    if (!isRecord(value)) {
      this.add(path, 'type', 'must be an object');
      return undefined;
    }
    return value;
  }

  /** The collected issues as a failed validation; call it only after an issue was added. */
  fail(): { readonly ok: false; readonly errors: readonly ValidationIssue[] } {
    return { ok: false, errors: this.issues };
  }

  /** The built value when no issue was collected; otherwise every issue. */
  result<T>(build: () => T): Validation<T> {
    if (this.issues.length > 0) return { ok: false, errors: this.issues };
    return { ok: true, value: build() };
  }
}
