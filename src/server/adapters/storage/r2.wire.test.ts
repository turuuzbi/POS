import http from "node:http";
import { it, expect } from "vitest";
import { createR2Storage } from "./r2";
it("uploads with a Content-Length, never chunked (R2 answers 411 otherwise)", async () => {
  let seen: http.IncomingHttpHeaders = {};
  const srv = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.statusCode = req.headers["content-length"] ? 200 : 411;
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;
  const s = createR2Storage({
    accountId: "a",
    accessKeyId: "k",
    secretAccessKey: "s",
    bucket: "pos",
    publicUrl: "https://x.example",
    endpoint: `http://127.0.0.1:${port}`,
  });
  const r = await s
    .put(
      "products/0190a3c2-1b2c-7d3e-8f40-123456789abc.png",
      Uint8Array.from([1, 2, 3, 4]),
      "image/png",
    )
    .then(
      () => "ok",
      (e) => String(e),
    );
  srv.close();
  expect(r).toBe("ok");
  expect(seen["content-length"]).toBe("4");
  expect(seen["transfer-encoding"]).toBeUndefined();
});
