import type { Slide } from "./types";

// Keep the original public API while loading each PowerPoint capability on demand.
export async function exportPptx(title: string, slides: Slide[]): Promise<{ blob: Blob; warnings: string[] }> {
  const module = await import("./pptxExport");
  return module.exportPptx(title, slides);
}

export async function importPptx(file: File): Promise<{ slides: Slide[]; warnings: string[] }> {
  const module = await import("./pptxImport");
  return module.importPptx(file);
}
