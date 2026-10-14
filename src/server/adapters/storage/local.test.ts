import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyFromLocalUrl, localStorage } from "./local";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pos-uploads-"));
  process.env.UPLOAD_DIR = dir;
});
afterAll(async () => {
  delete process.env.UPLOAD_DIR;
  await rm(dir, { recursive: true, force: true });
});

const KEY = "products/0190a3c2-1b2c-7d3e-8f40-123456789abc.png";

describe("local storage", () => {
  it("round-trips a file and deletes it", async () => {
    const url = await localStorage.put(KEY, Uint8Array.from([1, 2, 3]), "image/png");
    expect(url).toBe(`/api/uploads/${KEY}`);
    const file = await localStorage.read(KEY);
    expect(file?.contentType).toBe("image/png");
    expect([...file!.body]).toEqual([1, 2, 3]);
    await localStorage.delete(url);
    expect(await localStorage.read(KEY)).toBeNull();
    await localStorage.delete(url); // idempotent
  });

  it("refuses traversal and unknown keys", async () => {
    for (const bad of [
      "../etc/passwd",
      "products/../../x.png",
      "products/not-a-uuid.png",
      "products/0190a3c2-1b2c-7d3e-8f40-123456789abc.svg",
      "/abs/0190a3c2-1b2c-7d3e-8f40-123456789abc.png",
    ]) {
      expect(await localStorage.read(bad)).toBeNull();
      await expect(localStorage.put(bad, new Uint8Array(1), "image/png")).rejects.toThrow(
        RangeError,
      );
    }
  });

  it("only treats our own URLs as local", async () => {
    expect(keyFromLocalUrl(`/api/uploads/${KEY}`)).toBe(KEY);
    expect(keyFromLocalUrl("https://evil.example/x.png")).toBeNull();
    expect(keyFromLocalUrl("/api/uploads/../secret.png")).toBeNull();
    await localStorage.delete("https://evil.example/x.png"); // ignored
  });
});
