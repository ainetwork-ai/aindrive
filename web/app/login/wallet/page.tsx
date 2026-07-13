import { redirect } from "next/navigation";

// Wallet sign-in used to live on its own route; it's now a prominent option on
// the unified /login page. This redirect keeps any existing deep links working
// (e.g. the free-share login gate) and preserves the `next` destination.
export default async function WalletLoginRedirect({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
}
