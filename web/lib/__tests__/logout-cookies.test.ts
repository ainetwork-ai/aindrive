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
    const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(clearCookie).toHaveBeenCalledOnce();
    expect(clearWalletCookie).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("switch account: goes to sign-in and back to the drive", async () => {
    const res = await POST(new Request("http://localhost/api/auth/logout?next=%2Fd%2Fabc", { method: "POST" }));
    expect(res.headers.get("Location")).toBe("/login?next=%2Fd%2Fabc");
    const evil = await POST(new Request("http://localhost/api/auth/logout?next=https%3A%2F%2Fevil.example", { method: "POST" }));
    expect(evil.headers.get("Location")).toBe("/");
  });
});
