import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedRedirectUri } from "../oauth";

const LAN = "http://192.168.1.10:3000/api/auth/callback";

describe("isAllowedRedirectUri dev override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects non-loopback http by default", () => {
    vi.stubEnv("AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS", "");
    expect(isAllowedRedirectUri(LAN)).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
  });

  it("allows it only with the flag outside production", () => {
    vi.stubEnv("AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS", "1");
    vi.stubEnv("NODE_ENV", "test");
    expect(isAllowedRedirectUri(LAN)).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedRedirectUri(LAN)).toBe(false);
  });
});
