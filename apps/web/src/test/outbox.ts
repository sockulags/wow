// What a test's fake connection was sent. `until` settles once what was sent meets the test's
// condition, so a test waits for that event and not for time.
export interface Outbox<T> {
  readonly sent: T[];
  readonly record: (item: T) => void;
  readonly until: (done: (sent: readonly T[]) => boolean) => Promise<void>;
}

export function outbox<T>(): Outbox<T> {
  const sent: T[] = [];
  let waiting: { readonly done: (sent: readonly T[]) => boolean; readonly settle: () => void }[] =
    [];
  return {
    sent,
    record(item) {
      sent.push(item);
      const met = waiting.filter((entry) => entry.done(sent));
      waiting = waiting.filter((entry) => !met.includes(entry));
      for (const entry of met) entry.settle();
    },
    until(done) {
      if (done(sent)) return Promise.resolve();
      return new Promise((settle) => waiting.push({ done, settle }));
    },
  };
}
