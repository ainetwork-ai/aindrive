import { describe, it, expect, vi, beforeEach } from "vitest";

const clearCookie = vi.fn(async () => {});
const clearWalletCookie = vi.fn(async () => {});

vi.mock("@/lib/session", () => ({ clearCookie }));
vi.mock("@/lib/wallet", () => ({ clearWalletCookie }));

const { POST } = await import("../../app/api/auth/logout/route.js");

describe("logout", () => {
  beforeEach(() => {
    clearCookie.mockClear();
    clearWalletCookie.mockClear();
  });

  it("clears BOTH the session and wallet cookies", async () => {
    const res = await POST();
    expect(clearCookie).toHaveBeenCalledOnce();
    expect(clearWalletCookie).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });
});
