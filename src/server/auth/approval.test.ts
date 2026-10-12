import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_SECONDS, signApproval, verifyApproval } from "./approval";

const claims = {
  approverId: "0193b7c4-0000-7000-8000-000000000001",
  permission: "pos.void" as const,
  scope: "sale:0193b7c4-0000-7000-8000-0000000000aa",
  deviceId: "0193b7c4-0000-7000-8000-0000000000d1",
};
const expected = { permission: claims.permission, scope: claims.scope, deviceId: claims.deviceId };
const now = new Date("2026-03-01T10:00:00Z");

describe("approval tokens", () => {
  it("verifies an authentic, unexpired, matching token", () => {
    const token = signApproval(claims, now);
    expect(verifyApproval(token, expected, now)).toMatchObject(claims);
  });

  it("expires after the TTL", () => {
    const token = signApproval(claims, now);
    const later = new Date(now.getTime() + APPROVAL_TTL_SECONDS * 1000);
    expect(verifyApproval(token, expected, later)).toBeNull();
  });

  it("is bound to permission, scope and device", () => {
    const token = signApproval(claims, now);
    expect(
      verifyApproval(token, { ...expected, permission: "pos.refund.approve" }, now),
    ).toBeNull();
    expect(verifyApproval(token, { ...expected, scope: "sale:other" }, now)).toBeNull();
    expect(
      verifyApproval(token, { ...expected, deviceId: "0193b7c4-0000-7000-8000-0000000000d2" }, now),
    ).toBeNull();
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signApproval(claims, now);
    const [body, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        permission: "pos.refund.approve",
      }),
    ).toString("base64url");
    expect(
      verifyApproval(
        `${forged}.${signature}`,
        { ...expected, permission: "pos.refund.approve" },
        now,
      ),
    ).toBeNull();
    expect(verifyApproval(`${body}.${signature.slice(0, -2)}xx`, expected, now)).toBeNull();
    expect(verifyApproval(`${body}`, expected, now)).toBeNull();
    expect(verifyApproval(`${token}.extra`, expected, now)).toBeNull();
    expect(verifyApproval("garbage", expected, now)).toBeNull();
  });
});
