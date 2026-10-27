export const ELEMENT_CLIPBOARD_TYPE = "application/x-present-element+json";

function imageFile(file: File | null): File | undefined {
  if (!file) return;
  if (file.type.startsWith("image/")) return file;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const type = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp" } as Record<string, string>)[extension];
  if (type) return new File([file], file.name, { type, lastModified: file.lastModified });
}

/** Prefer native image bytes; browser Copy Image may instead supply HTML. */
export function clipboardImages(data: DataTransfer): { files: File[]; sources: string[] } {
  const files = Array.from(data.files).map(imageFile).filter((file): file is File => !!file);
  if (!files.length) for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = imageFile(item.getAsFile());
    if (file) files.push(file);
  }
  if (files.length) return { files, sources: [] };
  const sources = new Set<string>();
  const add = (value: string | null) => {
    if (!value) return;
    try {
      const url = new URL(value.trim());
      if (["http:", "https:"].includes(url.protocol) || /^data:image\//i.test(url.href)) sources.add(url.href);
    } catch { /* A relative source without its original page cannot be resolved. */ }
  };
  const html = data.getData("text/html");
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = doc.querySelector("base[href]")?.getAttribute("href");
    for (const image of Array.from(doc.querySelectorAll("img"))) {
      const src = image.getAttribute("src");
      try { add(src && base ? new URL(src, base).href : src); } catch { /* Ignore malformed image sources. */ }
    }
  }
  if (!sources.size) {
    const uri = data.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#"));
    const text = uri ?? data.getData("text/plain").trim();
    if (/^data:image\//i.test(text) || /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)(?:[?#].*)?$/i.test(text)) add(text);
  }
  return { files: [], sources: [...sources] };
}

export function slideArrowDirection(key: string): -1 | 1 | undefined {
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
}
