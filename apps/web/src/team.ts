import { ApiError, api } from "./api.js";
import { teamMemberControlState } from "./team-helpers.js";

type Role = "ADMIN" | "EDITOR" | "VIEWER";
type Project = { id: string; role: Role };
type Member = {
  user_id: string;
  username: string;
  display_name: string | null;
  role: Role;
  revision: number;
  created_at: string;
};
type Invitation = {
  id: string;
  invitee_user_id: string;
  username: string;
  role: Role;
  issued_at: string;
  expires_at: string;
};
type InboxInvitation = {
  id: string;
  project_id: string;
  project_name: string;
  role: Role;
  expires_at: string;
  inviter_username: string;
};

function errorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "The team service is unavailable.";
  if (cause.status === 409) return "This changed elsewhere. Reloaded the current team.";
  if (cause.status === 403) return "Your current role cannot make that change.";
  return "The team change could not be completed.";
}

function action(label: string, className = "text-action"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

export function mountTeam(
  container: HTMLElement,
  project: Project,
  currentUserId: string,
  options: { onCountChange(count: number): void; onUnauthorized(): void },
): () => void {
  let active = true;
  let controller = new AbortController();

  const load = async (): Promise<void> => {
    controller.abort();
    controller = new AbortController();
    container.innerHTML = `<section class="team-view reveal" aria-labelledby="team-title">
      <div class="project-heading"><p class="kicker">Direct access / current</p><h1 id="team-title">Project team</h1></div>
      <p class="team-status" role="status">Loading current membership...</p>
    </section>`;
    try {
      const reply = await api<{ members: Member[]; invitations: Invitation[]; canManage: boolean }>(
        `/projects/${encodeURIComponent(project.id)}/team`,
        { signal: controller.signal },
      );
      if (!active) return;
      render(reply.members, reply.invitations, reply.canManage);
    } catch (cause) {
      if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
      if (cause instanceof ApiError && cause.status === 401) return options.onUnauthorized();
      container.innerHTML = `<section class="team-view"><h1>Project team</h1><p class="form-error" role="alert">Team membership could not be loaded.</p></section>`;
    }
  };

  const mutate = async (work: () => Promise<unknown>, status: HTMLElement): Promise<void> => {
    status.textContent = "Saving current membership...";
    try {
      await work();
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return options.onUnauthorized();
      status.textContent = errorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409)
        window.setTimeout(() => void load(), 900);
    }
  };

  const render = (members: Member[], invitations: Invitation[], canManage: boolean): void => {
    options.onCountChange(members.length);
    container.innerHTML = "";
    const section = document.createElement("section");
    section.className = "team-view reveal";
    section.setAttribute("aria-labelledby", "team-title");
    section.innerHTML = `<div class="project-heading"><p class="kicker">Direct access / current</p><div class="title-row"><h1 id="team-title">Project team</h1><span class="role">${canManage ? "ADMIN CONTROLS" : "READ ONLY"}</span></div><p class="project-description">Roles are checked from D1 on every project request. Workspace access alone is never enough.</p></div>`;
    const status = document.createElement("p");
    status.className = "team-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.append(status);

    if (canManage) {
      const invite = document.createElement("form");
      invite.className = "team-invite panel";
      invite.innerHTML = `<div><p class="kicker">Invite known GitHub identity</p><h2>Extend the table</h2></div><label>GitHub username<input name="username" maxlength="39" pattern="[A-Za-z0-9-]+" autocomplete="off" required></label><label>Role<select name="role"><option>VIEWER</option><option>EDITOR</option><option>ADMIN</option></select></label><button class="primary-action" type="submit">Issue invite</button>`;
      invite.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(invite);
        void mutate(
          () =>
            api(`/projects/${encodeURIComponent(project.id)}/team`, {
              method: "POST",
              body: JSON.stringify({ username: data.get("username"), role: data.get("role") }),
            }),
          status,
        );
      });
      section.append(invite);
    }

    const pending = document.createElement("section");
    pending.className = "team-block panel";
    pending.innerHTML = `<div class="section-heading"><div><p class="kicker">Unclaimed</p><h2>Pending invitations</h2></div><span>${invitations.length} open</span></div>`;
    const pendingList = document.createElement("div");
    pendingList.className = "team-list";
    if (invitations.length === 0)
      pendingList.innerHTML = `<p class="empty-copy">No pending invitations.</p>`;
    for (const invitation of invitations) {
      const row = document.createElement("article");
      row.className = "team-row";
      const identity = document.createElement("div");
      identity.innerHTML = `<strong></strong><span></span>`;
      const identityName = identity.querySelector("strong");
      const identityMeta = identity.querySelector("span");
      if (identityName) identityName.textContent = `@${invitation.username}`;
      if (identityMeta)
        identityMeta.textContent = `${invitation.role} / expires ${new Date(invitation.expires_at).toLocaleDateString()}`;
      row.append(identity);
      if (canManage) {
        const revoke = action("Revoke");
        revoke.addEventListener("click", () => {
          void mutate(
            () =>
              api(
                `/projects/${encodeURIComponent(project.id)}/team/invitations/${encodeURIComponent(invitation.id)}`,
                {
                  method: "DELETE",
                  body: JSON.stringify({}),
                },
              ),
            status,
          );
        });
        row.append(revoke);
      }
      pendingList.append(row);
    }
    pending.append(pendingList);
    section.append(pending);

    const memberBlock = document.createElement("section");
    memberBlock.className = "team-block panel";
    memberBlock.innerHTML = `<div class="section-heading"><div><p class="kicker">Authorization boundary</p><h2>Members</h2></div><span>${members.length} direct</span></div>`;
    const memberList = document.createElement("div");
    memberList.className = "team-list";
    const adminCount = members.filter((member) => member.role === "ADMIN").length;
    for (const member of members) {
      const row = document.createElement("article");
      row.className = "team-row";
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = member.display_name || `@${member.username}`;
      const meta = document.createElement("span");
      meta.textContent = `@${member.username} / joined ${new Date(member.created_at).toLocaleDateString()}`;
      identity.append(name, meta);
      row.append(identity);
      const controlState = teamMemberControlState(
        member.role,
        adminCount,
        member.user_id === currentUserId,
        canManage,
      );
      if (controlState.showControls) {
        const controls = document.createElement("div");
        controls.className = "team-controls";
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Role for ${member.username}`);
        for (const value of ["ADMIN", "EDITOR", "VIEWER"] as Role[]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          option.selected = value === member.role;
          select.append(option);
        }
        select.disabled = controlState.disableRole;
        select.addEventListener("change", () => {
          const nextRole = select.value as Role;
          select.disabled = true;
          void mutate(
            () =>
              api(
                `/projects/${encodeURIComponent(project.id)}/team/members/${encodeURIComponent(member.user_id)}`,
                {
                  method: "PATCH",
                  body: JSON.stringify({
                    role: nextRole,
                    expectedRole: member.role,
                    expectedRevision: member.revision,
                  }),
                },
              ),
            status,
          );
        });
        const remove = action("Remove");
        remove.disabled = controlState.disableRemoval;
        remove.addEventListener("click", () => {
          void mutate(
            () =>
              api(
                `/projects/${encodeURIComponent(project.id)}/team/members/${encodeURIComponent(member.user_id)}`,
                {
                  method: "DELETE",
                  body: JSON.stringify({
                    expectedRole: member.role,
                    expectedRevision: member.revision,
                  }),
                },
              ),
            status,
          );
        });
        controls.append(select, remove);
        row.append(controls);
      } else {
        const badge = document.createElement("span");
        badge.className = "role";
        badge.textContent = member.role;
        row.append(badge);
      }
      memberList.append(row);
    }
    memberBlock.append(memberList);
    section.append(memberBlock);
    container.append(section);
  };

  void load();
  return () => {
    active = false;
    controller.abort();
  };
}

export async function mountInvitationInbox(
  container: HTMLElement,
  onAccepted: () => Promise<void>,
): Promise<void> {
  try {
    const reply = await api<{ invitations: InboxInvitation[] }>("/invitations");
    container.innerHTML = "";
    if (reply.invitations.length === 0) return;
    const title = document.createElement("p");
    title.className = "nav-heading team-inbox-title";
    title.textContent = "Invitations";
    container.append(title);
    for (const invitation of reply.invitations) {
      const card = document.createElement("article");
      card.className = "invite-card";
      const copy = document.createElement("p");
      copy.textContent = `${invitation.project_name} / ${invitation.role} from @${invitation.inviter_username}`;
      const accept = action("Accept", "workspace-action");
      accept.addEventListener("click", async () => {
        accept.disabled = true;
        try {
          await api(`/invitations/${encodeURIComponent(invitation.id)}/accept`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          await onAccepted();
        } catch {
          copy.textContent = "This invitation is no longer available.";
        }
      });
      card.append(copy, accept);
      container.append(card);
    }
  } catch {
    container.textContent = "Invitations unavailable.";
  }
}
