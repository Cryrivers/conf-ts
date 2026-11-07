import type { Compiled, ExpressionOptions } from './types';

const CAPACITY = 1000;

/** A string-keyed map that drops its least recently used entry when full. */
class LruCache<Value> {
  private readonly entries = new Map<string, Value>();

  get(key: string): Value | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-inserting moves it to the end of iteration order.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Value): void {
    if (this.entries.size >= CAPACITY) {
      // The first key in iteration order is the least recently used.
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, value);
  }
}

/** Whether `a.b` should short-circuit on null/undefined like `a?.b`. */
export const isOptionalMemberAccess = (options?: ExpressionOptions): boolean =>
  options?.optionalMemberAccess === true || options?.loose === true;

/**
 * Functions built for expression sources: a 1,000-entry LRU cache per option
 * mode, keyed by the source itself so a hit needs no new key string.
 */
export class ExpressionCache {
  private readonly strict = new LruCache<Compiled>();
  private readonly loose = new LruCache<Compiled>();

  for(optionalMemberAccess: boolean): LruCache<Compiled> {
    return optionalMemberAccess ? this.loose : this.strict;
  }
}
