import { ShareGate } from "@/components/share-gate-client";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareGate token={token} />;
}
