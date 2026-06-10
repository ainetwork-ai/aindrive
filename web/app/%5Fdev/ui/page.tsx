import { notFound } from "next/navigation";
import { Gallery } from "./Gallery";

// Dev-only design-system gallery: every primitive in all variants. Hidden in
// production (the prerender guard returns 404 so the route never ships).
export const dynamic = "force-static";

export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}
