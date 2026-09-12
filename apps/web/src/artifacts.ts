import { ApiError, api } from "./api.js";
import {
  ARTIFACT_TYPES,
  type ArtifactType,
  CONTENT_TYPES,
  type FieldErrors,
  type UploadDraft,
  validateUpload,
} from "./artifact-validation.js";

export type ArtifactProject = {
  id: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  artifact_count: number;
};

type Artifact = {
  id: string;
  projectId: string;
  type: ArtifactType;
  name: string;
  description: string | null;
  currentVersion: number;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type Version = {
  artifactId: string;
  version: number;
  checksum: string;
  contentType: string;
  byteSize: number;
  sourceCommitSha: string | null;
  changeNote: string | null;
  createdBy: string;
  createdAt: string;
};

type Hooks = {
  onUnauthorized: () => void;
  onCountChange: (count: number) => void;
};

const PAGE_SIZE = 25;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown, context: "read" | "create" | "publish"): string {
  if (!(error instanceof ApiError)) return "The request failed. Try again.";
  if (error.code === "STORAGE_INTEGRITY_ERROR") {
    return "Content verification failed. No unverified content is shown.";
  }
  if (error.status === 400) return "The server rejected the submitted values. Review every field.";
  if (error.status === 403) return "Your project access is read-only. Publishing is not permitted.";
  if (error.status === 404) return "This artifact is no longer available.";
  if (error.status === 413) return "The content is larger than the 1 MiB upload limit.";
  if (error.status === 409) {
    return context === "publish"
      ? `A newer version exists${error.currentVersion ? ` (v${error.currentVersion})` : ""}. Review it before publishing.`
      : "The artifact changed before this request completed.";
  }
  return "The control plane could not complete the request. Try again.";
}

function labeledValue(label: string, value: string): HTMLElement {
  const item = element("div", "detail-field");
  item.append(element("dt", undefined, label), element("dd", undefined, value));
  return item;
}

function draftFrom(form: HTMLFormElement): UploadDraft {
  const data = new FormData(form);
  return {
    name: String(data.get("name") ?? ""),
    type: String(data.get("type") ?? ""),
    description: String(data.get("description") ?? ""),
    contentType: String(data.get("contentType") ?? ""),
    content: String(data.get("content") ?? ""),
    sourceCommitSha: String(data.get("sourceCommitSha") ?? ""),
    changeNote: String(data.get("changeNote") ?? ""),
  };
}

function showFieldErrors(form: HTMLFormElement, errors: FieldErrors): void {
  form.querySelectorAll<HTMLElement>("[data-field-error]").forEach((node) => {
    const name = node.dataset.fieldError ?? "";
    const message = errors[name] ?? "";
    node.textContent = message;
    const control = form.elements.namedItem(name);
    if (control instanceof HTMLElement) {
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  });
  const first = Object.keys(errors)[0];
  const control = first ? form.elements.namedItem(first) : null;
  if (control instanceof HTMLElement) control.focus();
}

function appendUploadFields(form: HTMLFormElement, includeMetadata: boolean): void {
  const add = (labelText: string, name: string, control: HTMLElement) => {
    const label = element("label", undefined, labelText);
    label.htmlFor = `${form.dataset.kind}-${name}`;
    control.id = label.htmlFor;
    control.setAttribute("name", name);
    const error = element("p", "field-error");
    error.id = `${control.id}-error`;
    error.dataset.fieldError = name;
    error.setAttribute("aria-live", "polite");
    control.setAttribute("aria-describedby", error.id);
    form.append(label, control, error);
  };
  if (includeMetadata) {
    const name = element("input");
    name.required = true;
    name.maxLength = 200;
    add("Name", "name", name);
    const type = element("select");
    for (const value of ARTIFACT_TYPES) {
      const option = element("option", undefined, value);
      option.value = value;
      type.append(option);
    }
    add("Type", "type", type);
    const description = element("textarea");
    description.maxLength = 2000;
    description.rows = 3;
    add("Description", "description", description);
  }
  const contentType = element("select");
  for (const value of CONTENT_TYPES) {
    const option = element("option", undefined, value);
    option.value = value;
    contentType.append(option);
  }
  add("Content type", "contentType", contentType);
  const content = element("textarea", "content-input");
  content.rows = 12;
  add("Content (UTF-8 text, maximum 1 MiB)", "content", content);
  const sha = element("input");
  sha.maxLength = 64;
  sha.pattern = "[0-9a-fA-F]{7,64}";
  add("Source commit SHA (optional)", "sourceCommitSha", sha);
  const note = element("textarea");
  note.maxLength = 500;
  note.rows = 3;
  add("Change note (optional)", "changeNote", note);
}

export function mountArtifacts(
  container: HTMLElement,
  project: ArtifactProject,
  hooks: Hooks,
): () => void {
  let category: ArtifactType | "" = "";
  let artifacts: Artifact[] = [];
  let nextCursor: string | null = null;
  let selected: Artifact | null = null;
  let versions: Version[] = [];
  let versionCursor: string | null = null;
  let selectedVersion = 0;
  let requestGeneration = 0;
  let controller = new AbortController();
  const canMutate = project.role !== "VIEWER";

  container.replaceChildren();
  const shell = element("section", "artifacts-view reveal");
  const header = element("div", "artifact-header");
  const heading = element("div");
  heading.append(
    element("p", "kicker", "Project context / immutable"),
    element("h1", undefined, "Artifacts"),
  );
  header.append(heading);
  if (canMutate) header.append(button("New artifact", "primary-action", () => openCreate()));
  else header.append(element("p", "read-only-note", "Viewer access / read-only"));

  const categories = element("div", "category-strip");
  categories.setAttribute("aria-label", "Artifact categories");
  const listStatus = element("div", "list-status");
  listStatus.setAttribute("aria-live", "polite");
  const list = element("div", "artifact-list");
  const more = button("Load more", "secondary-action", () => void loadList(true));
  more.hidden = true;
  shell.append(header, categories, listStatus, list, more);
  container.append(shell);

  const createDialog = uploadDialog("create", "Create artifact", "Publish artifact", true);
  const publishDialog = uploadDialog("publish", "Publish new version", "Publish version", false);
  container.append(createDialog, publishDialog);

  for (const item of [
    { value: "", label: "All" },
    ...ARTIFACT_TYPES.map((value) => ({ value, label: value })),
  ]) {
    const categoryButton = button(item.label, "category-button", () => {
      category = item.value as ArtifactType | "";
      selected = null;
      renderCategories();
      void loadList(false);
    });
    categoryButton.dataset.category = item.value;
    categories.append(categoryButton);
  }
  renderCategories();
  void loadList(false);

  function button(label: string, className: string, action: () => void): HTMLButtonElement {
    const control = element("button", className, label);
    control.type = "button";
    control.addEventListener("click", action);
    return control;
  }

  function uploadDialog(
    kind: "create" | "publish",
    title: string,
    submitLabel: string,
    includeMetadata: boolean,
  ): HTMLDialogElement {
    const dialog = element("dialog", "artifact-dialog");
    dialog.setAttribute("aria-labelledby", `${kind}-artifact-title`);
    const form = element("form", "dialog-form upload-form");
    form.dataset.kind = kind;
    const formHeader = element("div", "dialog-heading");
    const h2 = element("h2", undefined, title);
    h2.id = `${kind}-artifact-title`;
    formHeader.append(
      h2,
      button("Close", "text-action", () => dialog.close()),
    );
    form.append(formHeader);
    appendUploadFields(form, includeMetadata);
    const conflict = element("div", "conflict-panel");
    conflict.hidden = true;
    conflict.setAttribute("data-conflict", "");
    const formError = element("p", "form-error");
    formError.dataset.formError = "";
    formError.setAttribute("aria-live", "polite");
    const submit = element("button", "primary-action", submitLabel);
    submit.type = "submit";
    form.append(conflict, formError, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitUpload(form, includeMetadata);
    });
    dialog.addEventListener("close", () => {
      if (kind === "create") form.reset();
      formError.textContent = "";
      showFieldErrors(form, {});
    });
    dialog.append(form);
    return dialog;
  }

  function renderCategories(): void {
    categories.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      const active = control.dataset.category === category;
      control.classList.toggle("category-button--active", active);
      control.setAttribute("aria-pressed", String(active));
    });
  }

  async function loadList(
    append: boolean,
    loadingMessage = "Loading artifacts...",
  ): Promise<boolean> {
    const generation = ++requestGeneration;
    controller.abort();
    controller = new AbortController();
    if (!append) {
      artifacts = [];
      list.replaceChildren();
      listStatus.textContent = loadingMessage;
    }
    more.disabled = true;
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (category) query.set("type", category);
      if (append && nextCursor) query.set("cursor", nextCursor);
      const reply = await api<{ artifacts: Artifact[]; nextCursor: string | null }>(
        `/projects/${project.id}/artifacts?${query}`,
        { signal: controller.signal },
      );
      if (generation !== requestGeneration) return false;
      artifacts = append ? [...artifacts, ...reply.artifacts] : reply.artifacts;
      nextCursor = reply.nextCursor;
      renderList();
      return true;
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration) return false;
      handleAuth(error);
      listStatus.replaceChildren(
        element("span", undefined, errorMessage(error, "read")),
        button("Retry", "text-action", () => void loadList(append)),
      );
      return false;
    } finally {
      if (generation === requestGeneration) more.disabled = false;
    }
  }

  function renderList(): void {
    list.replaceChildren();
    if (artifacts.length === 0) {
      listStatus.textContent = category
        ? `No ${category} artifacts match this filter.`
        : canMutate
          ? "No artifacts yet. Publish the first source-backed context."
          : "No artifacts are available in this project.";
      more.hidden = true;
      return;
    }
    listStatus.textContent = `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} loaded.`;
    for (const artifact of artifacts) {
      const row = button("", "artifact-row", () => void openDetail(artifact));
      row.removeAttribute("aria-label");
      const top = element("span", "artifact-row-top");
      top.append(
        element("strong", undefined, artifact.name),
        element("span", "artifact-type", artifact.type),
      );
      const description = element(
        "span",
        "artifact-row-description",
        artifact.description ?? "No description.",
      );
      const meta = element(
        "span",
        "artifact-row-meta",
        `${artifact.status} / v${artifact.currentVersion} / updated ${dateTime(artifact.updatedAt)}`,
      );
      row.append(top, description, meta);
      list.append(row);
    }
    more.hidden = !nextCursor;
  }

  async function openDetail(artifact: Artifact): Promise<void> {
    selected = artifact;
    selectedVersion = artifact.currentVersion;
    versions = [];
    versionCursor = null;
    const generation = ++requestGeneration;
    controller.abort();
    controller = new AbortController();
    renderDetailLoading();
    try {
      const [metadata, content, history] = await Promise.all([
        api<{ artifact: Artifact }>(`/projects/${project.id}/artifacts/${artifact.id}`, {
          signal: controller.signal,
        }),
        api<{ version: Version; content: string }>(
          `/projects/${project.id}/artifacts/${artifact.id}/versions/${artifact.currentVersion}`,
          { signal: controller.signal },
        ),
        api<{ versions: Version[]; nextCursor: string | null }>(
          `/projects/${project.id}/artifacts/${artifact.id}/versions?limit=${PAGE_SIZE}`,
          { signal: controller.signal },
        ),
      ]);
      if (generation !== requestGeneration || selected?.id !== artifact.id) return;
      if (
        metadata.artifact.currentVersion !== content.version.version ||
        history.versions[0]?.version !== metadata.artifact.currentVersion
      ) {
        await openDetail(metadata.artifact);
        return;
      }
      selected = metadata.artifact;
      selectedVersion = metadata.artifact.currentVersion;
      versions = history.versions;
      versionCursor = history.nextCursor;
      renderDetail(content.version, content.content, false);
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration) return;
      handleDetailError(error);
    }
  }

  function renderDetailLoading(): void {
    shell.replaceChildren(
      button("Back to artifacts", "back-action", backToList),
      element("p", "detail-loading", "Loading verified artifact content..."),
    );
  }

  function renderDetail(version: Version, content: string, historical: boolean): void {
    if (!selected) return;
    shell.replaceChildren();
    const detailHeader = element("div", "detail-header");
    const title = element("div");
    title.append(
      button("Back to artifacts", "back-action", backToList),
      element("p", "kicker", `${selected.type} / ${selected.status.toLowerCase()}`),
      element("h1", undefined, selected.name),
      element("p", "project-description", selected.description ?? "No description."),
    );
    detailHeader.append(title);
    if (canMutate && !historical) {
      detailHeader.append(button("Publish new version", "primary-action", openPublish));
    } else if (historical) {
      detailHeader.append(element("p", "read-only-note", "Historical version / read-only"));
    }
    const metadata = element("dl", "detail-grid");
    metadata.append(
      labeledValue("Version", `v${version.version}${historical ? " (historical)" : " (current)"}`),
      labeledValue("Checksum", version.checksum),
      labeledValue("Content type", version.contentType),
      labeledValue("Byte size", `${version.byteSize.toLocaleString()} bytes`),
      labeledValue("Source commit", version.sourceCommitSha ?? "Not supplied"),
      labeledValue("Change note", version.changeNote ?? "Not supplied"),
      labeledValue("Creator", version.createdBy),
      labeledValue("Created", dateTime(version.createdAt)),
    );
    const contentHeading = element("h2", "section-title", "Verified content");
    const pre = element("pre", "artifact-content");
    const code = element("code", undefined, content);
    pre.append(code);
    const historyHeading = element("div", "history-heading");
    historyHeading.append(element("h2", "section-title", "Version history"));
    const historyList = element("div", "history-list");
    shell.append(detailHeader, metadata, contentHeading, pre, historyHeading, historyList);
    renderHistory(historyList);
  }

  function renderHistory(target: HTMLElement): void {
    target.replaceChildren();
    for (const version of versions) {
      const active = version.version === selectedVersion;
      const item = button("", `history-row${active ? " history-row--active" : ""}`, () => {
        void selectHistorical(version.version);
      });
      item.setAttribute("aria-current", active ? "true" : "false");
      item.append(
        element("strong", undefined, `v${version.version}`),
        element("span", undefined, version.changeNote ?? "No change note"),
        element("time", undefined, dateTime(version.createdAt)),
      );
      target.append(item);
    }
    if (versionCursor) {
      target.append(
        button("Load older versions", "secondary-action", () => void loadVersions(target)),
      );
    }
  }

  async function loadVersions(target: HTMLElement): Promise<void> {
    if (!selected || !versionCursor) return;
    const artifactId = selected.id;
    const requestedCursor = versionCursor;
    const generation = requestGeneration;
    const signal = controller.signal;
    try {
      const reply = await api<{ versions: Version[]; nextCursor: string | null }>(
        `/projects/${project.id}/artifacts/${artifactId}/versions?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(requestedCursor)}`,
        { signal },
      );
      if (
        selected?.id !== artifactId ||
        versionCursor !== requestedCursor ||
        generation !== requestGeneration
      )
        return;
      versions.push(...reply.versions);
      versionCursor = reply.nextCursor;
      renderHistory(target);
    } catch (error) {
      if (
        signal.aborted ||
        generation !== requestGeneration ||
        selected?.id !== artifactId ||
        versionCursor !== requestedCursor
      )
        return;
      handleDetailError(error);
    }
  }

  async function selectHistorical(versionNumber: number): Promise<void> {
    if (!selected || versionNumber === selectedVersion) return;
    const artifactId = selected.id;
    const generation = ++requestGeneration;
    controller.abort();
    controller = new AbortController();
    const pre = shell.querySelector<HTMLElement>(".artifact-content");
    if (pre) pre.textContent = "Loading verified version...";
    try {
      const reply = await api<{ version: Version; content: string }>(
        `/projects/${project.id}/artifacts/${artifactId}/versions/${versionNumber}`,
        { signal: controller.signal },
      );
      if (generation !== requestGeneration || selected?.id !== artifactId) return;
      selectedVersion = versionNumber;
      renderDetail(reply.version, reply.content, versionNumber !== selected.currentVersion);
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration) return;
      handleDetailError(error);
    }
  }

  function openCreate(): void {
    createDialog.showModal();
  }

  function openPublish(): void {
    if (!selected) return;
    const form = publishDialog.querySelector<HTMLFormElement>("form");
    form?.reset();
    const conflict = form?.querySelector<HTMLElement>("[data-conflict]");
    if (conflict) conflict.hidden = true;
    const submit = form?.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.textContent = "Publish version";
    publishDialog.dataset.expectedVersion = String(selected.currentVersion);
    publishDialog.showModal();
  }

  async function submitUpload(form: HTMLFormElement, includeMetadata: boolean): Promise<void> {
    const draft = draftFrom(form);
    const errors = validateUpload(draft, includeMetadata);
    showFieldErrors(form, errors);
    const formError = form.querySelector<HTMLElement>("[data-form-error]");
    if (formError) formError.textContent = "";
    if (Object.keys(errors).length > 0) return;
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    const generation = requestGeneration;
    const artifactAtSubmit = selected;
    const body: Record<string, unknown> = {
      contentType: draft.contentType,
      content: draft.content,
      sourceCommitSha: draft.sourceCommitSha,
      changeNote: draft.changeNote,
    };
    if (includeMetadata) {
      body.name = draft.name;
      body.type = draft.type;
      body.description = draft.description;
    } else {
      body.expectedVersion = Number(publishDialog.dataset.expectedVersion);
    }
    try {
      if (includeMetadata) {
        const reply = await api<{ artifact: Artifact }>(`/projects/${project.id}/artifacts`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        createDialog.close();
        await refreshArtifactCount();
        if (generation !== requestGeneration || !container.isConnected) return;
        if (!(await loadList(false))) return;
        await openDetail(reply.artifact);
      } else if (artifactAtSubmit) {
        await api(`/projects/${project.id}/artifacts/${artifactAtSubmit.id}/versions`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (
          generation !== requestGeneration ||
          selected?.id !== artifactAtSubmit.id ||
          !container.isConnected
        )
          return;
        publishDialog.close();
        await openDetail({
          ...artifactAtSubmit,
          currentVersion: artifactAtSubmit.currentVersion + 1,
        });
      }
    } catch (error) {
      handleAuth(error);
      if (
        generation !== requestGeneration ||
        (!includeMetadata && selected?.id !== artifactAtSubmit?.id) ||
        !container.isConnected
      )
        return;
      if (!includeMetadata && error instanceof ApiError && error.status === 409) {
        showConflict(form, error.currentVersion);
      }
      if (formError)
        formError.textContent = errorMessage(error, includeMetadata ? "create" : "publish");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function refreshArtifactCount(): Promise<void> {
    try {
      const reply = await api<{ project: ArtifactProject }>(`/projects/${project.id}`);
      project.artifact_count = reply.project.artifact_count;
      hooks.onCountChange(project.artifact_count);
    } catch (error) {
      handleAuth(error);
    }
  }

  function showConflict(form: HTMLFormElement, currentVersion?: number): void {
    const conflict = form.querySelector<HTMLElement>("[data-conflict]");
    if (!conflict) return;
    conflict.hidden = false;
    conflict.replaceChildren(
      element(
        "p",
        undefined,
        `Current server version: v${currentVersion ?? "unknown"}. Your draft is preserved.`,
      ),
      button("Review latest", "secondary-action", () => void reviewLatest(form)),
    );
  }

  async function reviewLatest(form: HTMLFormElement): Promise<void> {
    if (!selected) return;
    const artifactId = selected.id;
    const generation = ++requestGeneration;
    controller.abort();
    controller = new AbortController();
    const formError = form.querySelector<HTMLElement>("[data-form-error]");
    try {
      const metadata = await api<{ artifact: Artifact }>(
        `/projects/${project.id}/artifacts/${artifactId}`,
        { signal: controller.signal },
      );
      const latestVersion = metadata.artifact.currentVersion;
      const [content, history] = await Promise.all([
        api<{ version: Version; content: string }>(
          `/projects/${project.id}/artifacts/${artifactId}/versions/${latestVersion}`,
          { signal: controller.signal },
        ),
        api<{ versions: Version[]; nextCursor: string | null }>(
          `/projects/${project.id}/artifacts/${artifactId}/versions?limit=${PAGE_SIZE}`,
          { signal: controller.signal },
        ),
      ]);
      if (generation !== requestGeneration || selected?.id !== artifactId) return;
      if (
        content.version.version !== latestVersion ||
        history.versions[0]?.version !== latestVersion
      ) {
        showConflict(form, history.versions[0]?.version ?? latestVersion);
        if (formError)
          formError.textContent = "The artifact changed again. Review latest once more.";
        return;
      }
      selected = metadata.artifact;
      selectedVersion = latestVersion;
      versions = history.versions;
      versionCursor = history.nextCursor;
      renderDetail(content.version, content.content, false);
      publishDialog.dataset.expectedVersion = String(latestVersion);
      const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
      if (submit) submit.textContent = "Publish after review";
      const conflict = form.querySelector<HTMLElement>("[data-conflict]");
      if (conflict) {
        const preview = element("div", "conflict-preview");
        preview.append(
          element(
            "p",
            undefined,
            `Reviewed v${latestVersion}. Your draft is unchanged; publish only when ready.`,
          ),
          element(
            "p",
            "conflict-meta",
            `${content.version.contentType} / ${content.version.byteSize.toLocaleString()} bytes / ${content.version.checksum}`,
          ),
          element(
            "p",
            "conflict-meta",
            `History: ${history.versions.map((version) => `v${version.version}`).join(", ")}`,
          ),
        );
        const latestContent = element("pre", "conflict-content");
        latestContent.append(element("code", undefined, content.content));
        preview.append(latestContent);
        conflict.replaceChildren(preview);
      }
      if (formError) formError.textContent = "Latest metadata, content, and history loaded.";
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration) return;
      handleDetailError(error);
      if (formError) formError.textContent = errorMessage(error, "read");
    }
  }

  function handleAuth(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) hooks.onUnauthorized();
  }

  function handleDetailError(error: unknown): void {
    handleAuth(error);
    if (error instanceof ApiError && error.status === 404) {
      selected = null;
      backToList();
      void loadList(false, "The artifact is no longer available. Refreshing the list...").then(
        (loaded) => {
          if (loaded && container.isConnected && !selected) {
            listStatus.textContent = "The artifact is no longer available. The list was refreshed.";
          }
        },
      );
      return;
    }
    shell.replaceChildren(
      button("Back to artifacts", "back-action", backToList),
      element("p", "detail-error", errorMessage(error, "read")),
      button("Retry", "secondary-action", () => selected && void openDetail(selected)),
    );
  }

  function backToList(): void {
    ++requestGeneration;
    controller.abort();
    selected = null;
    shell.replaceChildren(header, categories, listStatus, list, more);
    renderCategories();
    renderList();
  }

  return () => {
    ++requestGeneration;
    controller.abort();
  };
}
