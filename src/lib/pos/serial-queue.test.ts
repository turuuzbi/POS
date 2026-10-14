import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./serial-queue";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("serial queue", () => {
  it("never starts a job before the previous one finished, and keeps the order", async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const first = deferred<void>();
    const a = queue.run(async () => {
      log.push("a start");
      await first.promise;
      log.push("a end");
      return "a";
    });
    const b = queue.run(async () => {
      log.push("b start");
      return "b";
    });
    await Promise.resolve();
    expect(log).toEqual(["a start"]);
    expect(queue.pending).toBe(2);
    first.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(log).toEqual(["a start", "a end", "b start"]);
    expect(queue.pending).toBe(0);
  });

  it("runs later jobs after a failed one and still reports the failure", async () => {
    const queue = createSerialQueue();
    const bad = queue.run(async () => {
      throw new Error("boom");
    });
    const good = queue.run(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
    expect(queue.pending).toBe(0);
  });
});
