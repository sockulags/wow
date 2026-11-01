// A push-driven async iterable: the SDK's streaming input mode reads user messages from it while
// the adapter pushes one per turn. The session lives as long as the queue stays open.
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiting: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) throw new Error('The queue has ended');
    const next = this.#waiting.shift();
    if (next) next({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#ended = true;
    for (const next of this.#waiting.splice(0)) next({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift() as T, done: false });
        }
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
