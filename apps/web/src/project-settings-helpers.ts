export function canManageProjectSettings(role: "ADMIN" | "EDITOR" | "VIEWER"): boolean {
  return role === "ADMIN";
}

export type ProjectSettingsDraft = {
  name: string;
  slug: string;
  description: string;
};

export type ProjectSettingsErrors = Partial<Record<keyof ProjectSettingsDraft, string>>;

export function validateProjectSettings(draft: ProjectSettingsDraft): ProjectSettingsErrors {
  const errors: ProjectSettingsErrors = {};
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  if (!name) errors.name = "Enter a project name.";
  else if (name.length > 100) errors.name = "Use 100 characters or fewer.";
  if (!slug) errors.slug = "Enter a project slug.";
  else if (slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    errors.slug = "Use lowercase letters, numbers, and single hyphens.";
  }
  if (draft.description.trim().length > 500) {
    errors.description = "Use 500 characters or fewer.";
  }
  return errors;
}
