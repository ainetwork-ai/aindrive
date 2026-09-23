import { afterEach, describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "../oauth";

const LAN = "http://192.168.1.10:3000/api/auth/callback";

describe("isAllowedRedirectUri dev override", () => {
  const saved = { node: process.env.NODE_ENV, flag: process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS };
  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.flag === undefined) delete process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS;
    else process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS = saved.flag;
  });

  it("rejects non-loopback http by default", () => {
    delete process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS;
    expect(isAllowedRedirectUri(LAN)).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
  });

  it("allows it only with the flag outside production", () => {
    process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS = "1";
    process.env.NODE_ENV = "test";
    expect(isAllowedRedirectUri(LAN)).toBe(true);
    process.env.NODE_ENV = "production";
    expect(isAllowedRedirectUri(LAN)).toBe(false);
  });
});
