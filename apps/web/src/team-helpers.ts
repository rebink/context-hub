export type TeamRole = "ADMIN" | "EDITOR" | "VIEWER";

export function teamMemberControlState(
  role: TeamRole,
  adminCount: number,
  isCurrentUser: boolean,
  canManage: boolean,
): { showControls: boolean; disableRole: boolean; disableRemoval: boolean } {
  const showControls = canManage && !isCurrentUser;
  const finalAdmin = role === "ADMIN" && adminCount === 1;
  return {
    showControls,
    disableRole: !showControls || finalAdmin,
    disableRemoval: !showControls || finalAdmin,
  };
}
