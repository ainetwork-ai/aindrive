// Pure guard for member-row mutations on /api/drives/[driveId]/members/[memberId].
// The creator (drives.owner_id) is the final authority and must always retain a
// row — even another owner (co-owner, D2) cannot remove it. Kept pure so the
// rule is unit-tested without a DB; the route supplies the two ids.

export function canRemoveMember(args: {
  memberUserId: string;
  driveOwnerId: string;
}): boolean {
  return args.memberUserId !== args.driveOwnerId;
}
