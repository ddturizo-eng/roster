// Shared call recording and response scripting for the port fakes.
//
// Every fake records each call as `{ port, method, args }` in a CallLog. Fakes built with the same
// CallLog share one ordered list, so orchestrator tests can assert the exact order of side effects
// across ports (`log.names()` -> ['store.startExecution', 'vcs.createWorkspace', ...]).
//
// Responses are scripted per method:
// - `queue(method, ...values)` returns each value once, in order (FIFO);
// - `queueError(method, error)` throws (or rejects, for async methods) once, in queue order;
// - `setDefault(method, handler)` answers every call once the queue is empty.
// With nothing scripted, the fake uses its own default behavior.

export interface RecordedCall {
  readonly port: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export class CallLog {
  readonly calls: RecordedCall[] = [];

  record(port: string, method: string, args: readonly unknown[]): void {
    this.calls.push({ port, method, args: snapshot(args) as readonly unknown[] });
  }

  /** `port.method` of every call, in order. */
  names(): string[] {
    return this.calls.map((call) => `${call.port}.${call.method}`);
  }

  /** Calls of one port, in order. */
  of(port: string): RecordedCall[] {
    return this.calls.filter((call) => call.port === port);
  }

  clear(): void {
    this.calls.length = 0;
  }
}

/** Deep copy of plain data, so later mutation by the caller does not change the record. */
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value instanceof Set) return new Set([...value].map(snapshot));
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
  }
  return value;
}

type AnyFunction = (...args: never[]) => unknown;

/** Names of the function-valued members of `P`. */
export type MethodName<P> = {
  [K in keyof P]-?: P[K] extends AnyFunction ? K : never;
}[keyof P] &
  string;

type MethodArgs<P, K extends MethodName<P>> = P[K] extends (...args: infer A) => unknown ? A : never;

/** The value a method yields: the awaited value for async methods. */
export type MethodValue<P, K extends MethodName<P>> = P[K] extends (...args: never[]) => infer R ? Awaited<R> : never;

type Scripted = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly error: Error };

export class Responses<P> {
  readonly #queues = new Map<string, Scripted[]>();
  readonly #defaults = new Map<string, (...args: never[]) => unknown>();

  queue<K extends MethodName<P>>(method: K, ...values: MethodValue<P, K>[]): this {
    const queue = this.#queue(method);
    for (const value of values) queue.push({ kind: 'value', value });
    return this;
  }

  queueError<K extends MethodName<P>>(method: K, error: Error): this {
    this.#queue(method).push({ kind: 'error', error });
    return this;
  }

  setDefault<K extends MethodName<P>>(method: K, handler: (...args: MethodArgs<P, K>) => MethodValue<P, K>): this {
    this.#defaults.set(method, handler as (...args: never[]) => unknown);
    return this;
  }

  /** Scripted answer of a call, or `fallback()` when nothing is scripted. Throws scripted errors. */
  answer<K extends MethodName<P>>(
    method: K,
    args: MethodArgs<P, K>,
    fallback: () => NoInfer<MethodValue<P, K>>,
  ): MethodValue<P, K> {
    const next = this.#queues.get(method)?.shift();
    if (next?.kind === 'error') throw next.error;
    if (next?.kind === 'value') return next.value as MethodValue<P, K>;
    const handler = this.#defaults.get(method) as ((...args: MethodArgs<P, K>) => MethodValue<P, K>) | undefined;
    return handler === undefined ? fallback() : handler(...args);
  }

  /** Number of scripted answers not used yet. */
  pending(method: MethodName<P>): number {
    return this.#queues.get(method)?.length ?? 0;
  }

  #queue(method: string): Scripted[] {
    let queue = this.#queues.get(method);
    if (queue === undefined) {
      queue = [];
      this.#queues.set(method, queue);
    }
    return queue;
  }
}
