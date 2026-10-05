import type {
  EditorSettings,
  EditorTemplatePreset,
  MapSourceDocument,
  MapSourceEntry,
  SourceFileDocument,
} from "../map-source.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMapSourceEntry(value: unknown): MapSourceEntry {
  if (
    !isRecord(value)
    || !("id" in value)
    || typeof value.id !== "string"
    || !("label" in value)
    || typeof value.label !== "string"
  ) {
    throw new Error("The desktop app returned an invalid workspace entry.");
  }

  return { id: value.id, label: value.label };
}

export function parseMapSourceEntries(value: unknown): readonly MapSourceEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("The desktop app returned an invalid recent workspaces list.");
  }

  return value.map((entry: unknown) => parseMapSourceEntry(entry));
}

export function parseMapSourceDocument(value: unknown): MapSourceDocument {
  if (
    !isRecord(value)
    || !("facts" in value)
    || !("annotations" in value)
  ) {
    throw new Error("The desktop app returned an invalid workspace map.");
  }

  return { facts: value.facts, annotations: value.annotations };
}

export function parseWorkspaceMapUpdate(value: unknown): {
  readonly workspaceId: string;
  readonly document: MapSourceDocument;
} {
  if (
    !isRecord(value)
    || !("workspaceId" in value)
    || typeof value.workspaceId !== "string"
    || !("document" in value)
  ) {
    throw new Error("The desktop app returned an invalid workspace map update.");
  }

  return {
    workspaceId: value.workspaceId,
    document: parseMapSourceDocument(value.document),
  };
}

export function parseSourceFileDocument(value: unknown): SourceFileDocument {
  if (
    !isRecord(value)
    || typeof value.path !== "string"
    || typeof value.content !== "string"
    || !Number.isInteger(value.line)
    || typeof value.line !== "number"
    || value.line < 1
    || !Number.isInteger(value.column)
    || typeof value.column !== "number"
    || value.column < 1
  ) {
    throw new Error("The desktop app returned an invalid source file.");
  }

  return {
    path: value.path,
    content: value.content,
    line: value.line,
    column: value.column,
  };
}

export function parseEditorSettings(value: unknown): EditorSettings {
  if (
    !isRecord(value)
    || !(value.commandTemplate === null || typeof value.commandTemplate === "string")
  ) {
    throw new Error("The desktop app returned invalid editor settings.");
  }

  return { commandTemplate: value.commandTemplate };
}

export function parseEditorTemplatePresets(value: unknown): readonly EditorTemplatePreset[] {
  if (!Array.isArray(value)) {
    throw new Error("The desktop app returned invalid editor presets.");
  }

  return value.map((preset: unknown) => {
    if (
      !isRecord(preset)
      || typeof preset.name !== "string"
      || typeof preset.template !== "string"
    ) {
      throw new Error("The desktop app returned an invalid editor preset.");
    }
    return { name: preset.name, template: preset.template };
  });
}
