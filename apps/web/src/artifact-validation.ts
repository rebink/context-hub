export const ARTIFACT_TYPES = [
  "architecture",
  "adr",
  "api-contract",
  "coding-convention",
  "domain-knowledge",
  "glossary",
  "database-schema",
  "runbook",
  "deployment-guide",
  "ownership",
  "security-rule",
  "product-requirement",
  "custom",
] as const;

export const CONTENT_TYPES = [
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml",
  "text/yaml",
  "application/x-yaml",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type FieldErrors = Record<string, string>;

export type UploadDraft = {
  name?: string;
  type?: string;
  description?: string;
  contentType: string;
  content: string;
  sourceCommitSha: string;
  changeNote: string;
};

export function validateUpload(draft: UploadDraft, includeArtifactFields: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (includeArtifactFields) {
    const name = draft.name?.trim() ?? "";
    if (!name) errors.name = "Name is required.";
    else if (name.length > 200) errors.name = "Name must be 200 characters or fewer.";
    if (!ARTIFACT_TYPES.includes(draft.type as ArtifactType)) {
      errors.type = "Choose a canonical artifact type.";
    }
    if ((draft.description?.trim().length ?? 0) > 2000) {
      errors.description = "Description must be 2,000 characters or fewer.";
    }
  }
  const normalizedType = draft.contentType.toLowerCase().replace(/\s+/g, "");
  const [mediaType, ...parameters] = normalizedType.split(";");
  if (
    !CONTENT_TYPES.includes(mediaType as (typeof CONTENT_TYPES)[number]) ||
    parameters.some((parameter) => parameter !== "charset=utf-8")
  ) {
    errors.contentType = "Choose an accepted UTF-8 text content type.";
  }
  if (new TextEncoder().encode(draft.content).byteLength > 1024 * 1024) {
    errors.content = "Content must be 1 MiB or smaller when UTF-8 encoded.";
  } else if (mediaType === "application/json") {
    try {
      JSON.parse(draft.content);
    } catch {
      errors.content = "Content declared as JSON must parse as JSON.";
    }
  }
  const sha = draft.sourceCommitSha.trim();
  if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) {
    errors.sourceCommitSha = "Source commit must be 7-64 hexadecimal characters.";
  }
  if (draft.changeNote.trim().length > 500) {
    errors.changeNote = "Change note must be 500 characters or fewer.";
  }
  return errors;
}
