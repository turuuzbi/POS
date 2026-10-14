/**
 * Runs async jobs one after another, in the order they were submitted. A
 * scanner can send the next code while the previous lookup is still in
 * flight; every code must be resolved, and in scan order (so the cart lines
 * come out in the order the items were scanned). A failing job never blocks
 * the ones behind it.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    /** Jobs queued or running. */
    get pending() {
      return pending;
    },
    run<T>(job: () => Promise<T>): Promise<T> {
      pending++;
      const result = tail.then(job);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pending--;
      });
    },
  };
}
