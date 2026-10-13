import { describe, expect, it } from "vitest";
import { emailKey, throttleNetwork, throttleSource, UNKNOWN_SOURCE } from "./throttle";

describe("throttleSource", () => {
  it("keeps IPv4 addresses", () => {
    expect(throttleSource("203.0.113.7")).toBe("203.0.113.7");
    expect(throttleSource(" 198.51.100.1 ")).toBe("198.51.100.1");
  });

  it("groups IPv6 by /64 so one subscriber can't rotate through addresses", () => {
    const a = throttleSource("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = throttleSource("2001:db8:1234:5678::1");
    expect(a).toBe("2001:db8:1234:5678::/64");
    expect(b).toBe(a);
    expect(throttleSource("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(throttleSource("::1")).toBe("0:0:0:0::/64");
    expect(throttleSource("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(throttleSource("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it.each([null, undefined, "", "not-an-ip", "1.2.3.4, 5.6.7.8", "x".repeat(4000), "999.1.1.1"])(
    "maps %j to the unknown bucket (bounded key size)",
    (value) => {
      expect(throttleSource(value)).toBe(UNKNOWN_SOURCE);
    },
  );
});

describe("throttleNetwork", () => {
  it("groups IPv6 by /48", () => {
    expect(throttleNetwork("2001:db8:77:1::1")).toBe("2001:db8:77::/48");
    expect(throttleNetwork("2001:db8:77:ffff:1:2:3:4")).toBe("2001:db8:77::/48");
    expect(throttleNetwork("2001:db8::1")).toBe("2001:db8:0::/48");
  });

  it.each([null, "203.0.113.7", "::ffff:203.0.113.7", "not-an-ip", "x".repeat(100)])(
    "has no network bucket for %j",
    (value) => {
      expect(throttleNetwork(value)).toBeNull();
    },
  );
});

describe("emailKey", () => {
  it("normalises case and whitespace and hides the address", () => {
    expect(emailKey(" Owner@Shop.MN ")).toBe(emailKey("owner@shop.mn"));
    expect(emailKey("owner@shop.mn")).not.toContain("owner");
    expect(emailKey("a@shop.mn")).not.toBe(emailKey("b@shop.mn"));
  });
});
