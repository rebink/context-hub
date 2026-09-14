import { ApiError, api } from "./api.js";
import {
  type ProjectSettingsDraft,
  type ProjectSettingsErrors,
  validateProjectSettings,
} from "./project-settings-helpers.js";

export type SettingsProject = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  settings_revision: number;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  member_count: number;
  artifact_count: number;
};

type Hooks = {
  onUnauthorized: () => void;
  onUpdated: (project: SettingsProject) => void;
};

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(
  form: HTMLFormElement,
  labelText: string,
  name: keyof ProjectSettingsDraft,
  control: HTMLInputElement | HTMLTextAreaElement,
): void {
  const label = node("label", undefined, labelText);
  control.id = `project-settings-${name}`;
  control.name = name;
  label.htmlFor = control.id;
  const error = node("p", "field-error");
  error.dataset.settingsError = name;
  error.id = `${control.id}-error`;
  error.setAttribute("aria-live", "polite");
  control.setAttribute("aria-describedby", error.id);
  form.append(label, control, error);
}

function draft(form: HTMLFormElement): ProjectSettingsDraft {
  const data = new FormData(form);
  return {
    name: String(data.get("name") ?? ""),
    slug: String(data.get("slug") ?? ""),
    description: String(data.get("description") ?? ""),
  };
}

function showErrors(form: HTMLFormElement, errors: ProjectSettingsErrors): void {
  form.querySelectorAll<HTMLElement>("[data-settings-error]").forEach((message) => {
    const key = message.dataset.settingsError as keyof ProjectSettingsDraft;
    message.textContent = errors[key] ?? "";
    const control = form.elements.namedItem(key);
    if (control instanceof HTMLElement) {
      if (errors[key]) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  });
}

export function mountProjectSettings(
  container: HTMLElement,
  project: SettingsProject,
  hooks: Hooks,
): () => void {
  let controller = new AbortController();
  const section = node("section", "settings-view reveal");
  const heading = node("div", "settings-heading");
  heading.append(
    node("p", "kicker", "Project administration / revision fenced"),
    node("h1", undefined, "Settings"),
    node(
      "p",
      "settings-intro",
      "Project identity settings live in D1. Repository bindings, ownership, access, and security configuration are managed elsewhere.",
    ),
  );
  section.append(heading);

  if (project.role !== "ADMIN") {
    section.append(
      node(
        "p",
        "read-only-note settings-read-only",
        "Only a current project administrator can change these settings.",
      ),
    );
    container.replaceChildren(section);
    return () => controller.abort();
  }

  const form = node("form", "settings-form");
  const name = node("input");
  name.required = true;
  name.maxLength = 100;
  name.value = project.name;
  field(form, "Project name", "name", name);
  const slug = node("input");
  slug.required = true;
  slug.maxLength = 63;
  slug.pattern = "[a-z0-9]+(-[a-z0-9]+)*";
  slug.value = project.slug;
  field(form, "Project slug", "slug", slug);
  const description = node("textarea");
  description.maxLength = 500;
  description.rows = 6;
  description.value = project.description ?? "";
  field(form, "Description", "description", description);
  const status = node("p", "form-status");
  status.setAttribute("aria-live", "polite");
  const actions = node("div", "settings-actions");
  const submit = node("button", "primary-action", "Save settings");
  submit.type = "submit";
  actions.append(node("span", "revision-label", `Revision ${project.settings_revision}`), submit);
  form.append(status, actions);
  section.append(form);
  container.replaceChildren(section);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = draft(form);
    const errors = validateProjectSettings(value);
    showErrors(form, errors);
    if (Object.keys(errors).length > 0) return;
    submit.disabled = true;
    status.textContent = "Saving settings...";
    controller.abort();
    controller = new AbortController();
    try {
      const reply = await api<{ project: SettingsProject; unchanged: boolean }>(
        `/projects/${project.id}`,
        {
          method: "PATCH",
          signal: controller.signal,
          body: JSON.stringify({
            name: value.name,
            slug: value.slug,
            description: value.description,
            expectedRevision: project.settings_revision,
          }),
        },
      );
      Object.assign(project, reply.project);
      status.textContent = reply.unchanged
        ? "No settings changed. Your revision is still current."
        : `Settings saved at revision ${reply.project.settings_revision}.`;
      const revisionLabel = actions.querySelector<HTMLElement>(".revision-label");
      if (revisionLabel) revisionLabel.textContent = `Revision ${reply.project.settings_revision}`;
      hooks.onUpdated(reply.project);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) hooks.onUnauthorized();
      else if (error instanceof ApiError && error.status === 409) {
        status.textContent = `A newer settings revision${error.currentRevision ? ` (${error.currentRevision})` : ""} exists. Your draft is preserved; reload before saving again.`;
      } else if (error instanceof ApiError && error.status === 403) {
        status.textContent = "Your administrator access changed. The draft is preserved.";
      } else {
        status.textContent = "Settings could not be saved. Your draft is preserved.";
      }
    } finally {
      if (!controller.signal.aborted) submit.disabled = false;
    }
  });

  return () => controller.abort();
}
