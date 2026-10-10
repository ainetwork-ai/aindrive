import { notFound, redirect } from "next/navigation";
import { resolveGitSlug } from "@/lib/git-slug";

/** `/<org>/git` with no repo: the drive itself (the repo pages live under [...rest]). */
export default async function DriveBySlugRoot({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) notFound();
  redirect(`/d/${driveId}`);
}
