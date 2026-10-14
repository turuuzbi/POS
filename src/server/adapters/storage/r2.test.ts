import { afterEach, describe, expect, it, vi } from "vitest";
import { createR2Storage, r2ConfigFromEnv } from "./r2";

const CONFIG = {
  accountId: "acc123",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  bucket: "pos-images",
  publicUrl: "https://img.example.com",
};
const KEY = "products/0190a3c2-1b2c-7d3e-8f40-123456789abc.png";

afterEach(() => vi.unstubAllGlobals());

describe("r2 config", () => {
  it("needs every variable", () => {
    expect(r2ConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    const env = {
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
      R2_BUCKET: "d",
      R2_PUBLIC_URL: "https://img.example.com/",
    } as unknown as NodeJS.ProcessEnv;
    expect(r2ConfigFromEnv(env)?.publicUrl).toBe("https://img.example.com");
    expect(r2ConfigFromEnv({ ...env, R2_BUCKET: "" })).toBeNull();
    expect(() => r2ConfigFromEnv({ ...env, R2_PUBLIC_URL: "http://x" })).toThrow();
  });
});

describe("r2 storage", () => {
  it("puts a signed object and returns its public URL", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const url = await createR2Storage(CONFIG).put(KEY, Uint8Array.from([1, 2]), "image/png");
    expect(url).toBe(`https://img.example.com/${KEY}`);
    const [requestUrl, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("PUT");
    expect(requestUrl).toBe(`https://acc123.r2.cloudflarestorage.com/pos-images/${KEY}`);
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 .*\/auto\/s3\//);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("content-length")).toBe("2");
  });

  it("surfaces upload failures and rejects bad keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const storage = createR2Storage(CONFIG);
    await expect(storage.put(KEY, new Uint8Array(1), "image/png")).rejects.toThrow("403");
    await expect(storage.put("../x.png", new Uint8Array(1), "image/png")).rejects.toThrow(
      RangeError,
    );
  });

  it("deletes only its own objects, tolerating missing ones", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = createR2Storage(CONFIG);
    await storage.delete(`https://img.example.com/${KEY}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![0] as Request).method).toBe("DELETE");
    await storage.delete(`https://evil.example/${KEY}`);
    await storage.delete("https://img.example.com/products/..%2Fx.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
