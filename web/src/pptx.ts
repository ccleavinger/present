import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import type { Slide, SlideElement } from "./types";
import { normalizeImageCrop } from "./imageCrop";
import { isBold, isItalic } from "./textFormatting";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const EMU_PER_INCH = 914400;
const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

const safeColor = (value: string | undefined, fallback: string) => /^#[\da-f]{6}$/i.test(value ?? "") ? value!.slice(1) : fallback;
const cssNum = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const dataUrl = async (src: string): Promise<string> => {
  if (src.startsWith("data:")) return src;
  const response = await fetch(src, { headers: { "X-Present-User": localStorage.getItem("present.activeDemoUserId") ?? "" } });
  if (!response.ok) throw new Error(`Could not load image for export (${response.status}).`);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not encode an image for PowerPoint export."));
    reader.readAsDataURL(blob);
  });
};

export async function exportPptx(title: string, slides: Slide[]): Promise<{ blob: Blob; warnings: string[] }> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Present";
  pptx.subject = "Presentation exported from Present";
  pptx.title = title;
  const warnings: string[] = [];
  const scale = 13.333333 / CANVAS_W;
  for (const source of slides) {
    const target = pptx.addSlide();
    target.background = { color: safeColor(source.background, "FFF6E9") };
    for (const element of Object.values(source.elements).sort((a, b) => a.z - b.z)) {
      const box = { x: element.x * scale, y: element.y * scale, w: element.w * scale, h: element.h * scale, rotate: element.rotation ?? 0, transparency: Math.round((1 - (element.opacity ?? 1)) * 100) };
      if (element.type === "text") {
        const style = element.style ?? {};
        const family = String(style.fontFamily ?? "Arial").split(",")[0].trim().replace(/^["']|["']$/g, "");
        target.addText(element.text ?? "", {
          ...box,
          fontFace: ({ "sans-serif": "Arial", serif: "Times New Roman", monospace: "Courier New" } as Record<string, string>)[family] ?? family,
          fontSize: cssNum(style.fontSize, 48) * 0.75,
          bold: isBold(element),
          italic: isItalic(element),
          color: safeColor(String(style.color ?? "#3d2a20"), "3D2A20"),
          align: style.align === "center" || style.align === "right" ? style.align : "left",
          valign: "middle",
          breakLine: false,
          margin: 0,
        });
      } else if (["rect", "ellipse", "triangle", "diamond", "star", "arrow", "callout"].includes(element.type)) {
        const shape = element.type === "ellipse" ? pptx.ShapeType.ellipse
          : element.type === "triangle" ? pptx.ShapeType.triangle
            : element.type === "diamond" ? pptx.ShapeType.diamond
              : element.type === "star" ? pptx.ShapeType.star5
                : element.type === "arrow" ? pptx.ShapeType.leftRightArrow
                  : element.type === "callout" ? pptx.ShapeType.wedgeRoundRectCallout : pptx.ShapeType.rect;
        target.addShape(shape, {
          ...box,
          rectRadius: element.shapeParams?.cornerRadius ? element.shapeParams.cornerRadius * scale : undefined,
          fill: { color: safeColor(element.fill, "FFB9A5") },
          line: { color: safeColor(element.stroke, safeColor(element.fill, "FFB9A5")), width: (element.strokeWidth ?? 1) * scale * 72, transparency: element.stroke ? 0 : 100 },
        });
      } else if (element.type === "line") {
        target.addShape(pptx.ShapeType.line, { ...box, line: { color: safeColor(element.stroke ?? element.fill, "3D2A20"), width: (element.strokeWidth ?? 2) * scale * 72 } });
      } else if (element.type === "image" && element.src) {
        const crop = normalizeImageCrop(element.imageCrop);
        try { target.addImage({ data: await dataUrl(element.src), ...box, ...(crop ? {
          w: box.w / crop.w, h: box.h / crop.h,
          sizing: { type: "crop" as const, w: box.w, h: box.h, x: crop.x * box.w / crop.w, y: crop.y * box.h / crop.h },
        } : {}) }); }
        catch { warnings.push(`Image on “${source.name}” could not be embedded.`); }
      } else if (element.type === "custom") {
        const commands = element.renderData ?? [];
        if (commands.length > 4000) warnings.push(`Custom object on “${source.name}” exceeded the export drawing limit.`);
        else for (const command of commands) {
          const commandBox = { x: box.x + command.x / 1000 * box.w, y: box.y + command.y / 1000 * box.h, w: command.w / 1000 * box.w, h: command.h / 1000 * box.h };
          if (command.type === "rect" || command.type === "circle") target.addShape(command.type === "circle" ? pptx.ShapeType.ellipse : pptx.ShapeType.rect, { ...commandBox, fill: { color: safeColor(command.fill, "000000") }, line: { color: safeColor(command.stroke, safeColor(command.fill, "000000")), width: (command.strokeWidth ?? 0) * scale * 72, transparency: command.stroke ? 0 : 100 } });
          else if (command.type === "line") target.addShape(pptx.ShapeType.line, { ...commandBox, line: { color: safeColor(command.stroke ?? command.fill, "000000"), width: (command.strokeWidth ?? 2) * scale * 72 } });
          else if (command.type === "text") target.addText(command.text ?? "", { ...commandBox, fontSize: command.h * scale * 0.75, color: safeColor(command.fill, "000000"), margin: 0 });
        }
      }
    }
    if (source.animations?.length) warnings.push(`Object animations on “${source.name}” are not included in the PowerPoint export.`);
    if (source.transition && source.transition.effect !== "none") warnings.push(`The ${source.transition.effect} slide transition on “${source.name}” is not included in the PowerPoint export.`);
  }
  return { blob: await pptx.write({ outputType: "blob" }) as Blob, warnings: [...new Set(warnings)] };
}

function first(parent: Element | Document, namespace: string, localName: string): Element | null {
  return parent.getElementsByTagNameNS(namespace, localName).item(0);
}

function textOf(parent: Element, namespace: string, localName: string): string {
  return Array.from(parent.getElementsByTagNameNS(namespace, localName)).map((node) => node.textContent ?? "").join("\n").trim();
}

function colorOf(parent: Element, namespace: string, localName: string): string | undefined {
  const block = first(parent, namespace, localName);
  const color = block && (first(block, NS.a, "srgbClr") ?? first(block, NS.a, "schemeClr"));
  const value = color?.getAttribute("val");
  return value && /^[\da-f]{6}$/i.test(value) ? `#${value}` : undefined;
}

function resolveTarget(base: string, target: string): string {
  const parts = target.startsWith("/") ? target.split("/") : [...base.split("/").slice(0, -1), ...target.split("/")];
  const clean: string[] = [];
  for (const part of parts) { if (!part || part === ".") continue; if (part === "..") clean.pop(); else clean.push(part); }
  return clean.join("/");
}

export async function importPptx(file: File): Promise<{ slides: Slide[]; warnings: string[] }> {
  if (file.size > 100 * 1024 * 1024) throw new Error("PowerPoint files must be 100 MiB or smaller.");
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
  let slideFiles = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  if (zip.file("ppt/presentation.xml") && zip.file("ppt/_rels/presentation.xml.rels")) {
    const presentation = new DOMParser().parseFromString(await zip.file("ppt/presentation.xml")!.async("text"), "application/xml");
    const relationships = new DOMParser().parseFromString(await zip.file("ppt/_rels/presentation.xml.rels")!.async("text"), "application/xml");
    const targets = new Map(Array.from(relationships.getElementsByTagNameNS(NS.rel, "Relationship")).filter((node) => node.getAttribute("TargetMode") !== "External").map((node) => [node.getAttribute("Id"), node.getAttribute("Target")]));
    const ordered = Array.from(presentation.getElementsByTagNameNS(NS.p, "sldId")).map((node) => {
      const target = targets.get(node.getAttributeNS(NS.r, "id"));
      return target ? resolveTarget("ppt/presentation.xml", target) : "";
    });
    if (ordered.length && ordered.every((path) => !!zip.file(path))) slideFiles = ordered;
  }
  if (!slideFiles.length || slideFiles.length > 200) throw new Error("The file has no slides or exceeds the 200-slide import limit.");
  const warnings: string[] = [];
  const slides: Slide[] = [];
  let imageCharacters = 0;
  for (let slideIndex = 0; slideIndex < slideFiles.length; slideIndex += 1) {
    const path = slideFiles[slideIndex];
    const xmlText = await zip.file(path)!.async("text");
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error(`Could not read slide ${slideIndex + 1}.`);
    const slide: Slide = { version: 1, id: `pptx_${crypto.randomUUID().slice(0, 8)}`, name: `Slide ${slideIndex + 1}`, background: "#ffffff", elements: {} };
    const shapeNodes = Array.from(xml.getElementsByTagNameNS(NS.p, "sp"));
    let z = 0;
    for (const node of shapeNodes) {
      const transform = first(node, NS.a, "xfrm");
      const off = transform && first(transform, NS.a, "off");
      const ext = transform && first(transform, NS.a, "ext");
      if (!off || !ext) continue;
      const x = Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const y = Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const w = Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const h = Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const text = textOf(node, NS.a, "t");
      const geometry = first(node, NS.a, "prstGeom")?.getAttribute("prst") ?? "rect";
      const fill = colorOf(node, NS.a, "solidFill");
      const lineColor = colorOf(node, NS.a, "ln");
      const id = `pptx_element_${slideIndex}_${z}`;
      const styleNode = first(node, NS.a, "rPr") ?? first(node, NS.a, "defRPr");
      const fontSize = Number(styleNode?.getAttribute("sz") ?? 3600) / 100 * 4 / 3;
      const fontColor = styleNode ? colorOf(styleNode, NS.a, "solidFill") : undefined;
      if (text) {
        const fontFamily = first(styleNode ?? node, NS.a, "latin")?.getAttribute("typeface") ?? undefined;
        const alignment = first(node, NS.a, "pPr")?.getAttribute("algn");
        slide.elements[id] = { id, type: "text", x, y, w, h, rotation: 0, z: z++, text, style: { fontSize, fontFamily, color: fontColor ?? "#3d2a20", fontWeight: ["1", "true"].includes(styleNode?.getAttribute("b") ?? "") ? 700 : 400, fontStyle: ["1", "true"].includes(styleNode?.getAttribute("i") ?? "") ? "italic" : "normal", align: alignment === "ctr" ? "center" : alignment === "r" ? "right" : "left", lineHeight: 1.2 } };
      } else {
        const type = geometry === "ellipse" ? "ellipse" : geometry === "triangle" ? "triangle" : geometry === "diamond" ? "diamond" : geometry.startsWith("star") ? "star" : geometry.toLowerCase().includes("arrow") ? "arrow" : geometry.toLowerCase().includes("callout") ? "callout" : geometry === "line" ? "line" : "rect";
        if (type === "rect" && !["rect", "roundRect", "round1Rect"].includes(geometry)) warnings.push(`Slide ${slideIndex + 1} contains an unsupported shape (${geometry}); it was imported as a rectangle.`);
        slide.elements[id] = { id, type, x, y, w, h, rotation: 0, z: z++, fill: fill ?? "#ffffff", stroke: lineColor, style: {}, shapeParams: geometry.startsWith("star") ? { points: Number(geometry.match(/\d+/)?.[0] ?? 5) } : undefined };
      }
    }
    const relationPath = path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relationXml = zip.file(relationPath) ? new DOMParser().parseFromString(await zip.file(relationPath)!.async("text"), "application/xml") : null;
    const relations = new Map<string, string>();
    Array.from(relationXml?.getElementsByTagNameNS(NS.rel, "Relationship") ?? []).forEach((relation) => relations.set(relation.getAttribute("Id") ?? "", relation.getAttribute("Target") ?? ""));
    const picNodes = Array.from(xml.getElementsByTagNameNS(NS.p, "pic"));
    for (const pic of picNodes) {
      const transform = first(pic, NS.a, "xfrm");
      const off = transform && first(transform, NS.a, "off");
      const ext = transform && first(transform, NS.a, "ext");
      const blip = first(pic, NS.a, "blip");
      const relId = blip?.getAttributeNS(NS.r, "embed") ?? "";
      const target = relations.get(relId);
      if (!off || !ext || !target) { warnings.push(`An image on slide ${slideIndex + 1} could not be imported.`); continue; }
      const assetPath = resolveTarget(path, target);
      const asset = zip.file(assetPath);
      if (!asset) { warnings.push(`An image on slide ${slideIndex + 1} is missing from the PowerPoint file.`); continue; }
      const extension = assetPath.split(".").at(-1)?.toLowerCase() ?? "";
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff" } as Record<string, string>)[extension];
      if (!mime) { warnings.push(`An image on slide ${slideIndex + 1} uses an unsupported format (${extension}) and was omitted.`); continue; }
      const encoded = await asset.async("base64");
      imageCharacters += encoded.length;
      if (imageCharacters > 90 * 1024 * 1024) throw new Error("The embedded PowerPoint images exceed the import size limit. Reduce large or repeated images and try again.");
      const src = `data:${mime};base64,${encoded}`;
      const x = Number(off.getAttribute("x") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const y = Number(off.getAttribute("y") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const w = Number(ext.getAttribute("cx") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const h = Number(ext.getAttribute("cy") ?? 0) / EMU_PER_INCH * (CANVAS_W / 13.333333);
      const id = `pptx_image_${slideIndex}_${z}`;
      const sourceRect = first(pic, NS.a, "srcRect");
      const inset = (side: string) => Number(sourceRect?.getAttribute(side) ?? 0) / 100000;
      const imageCrop = sourceRect && ["l", "r", "t", "b"].some((side) => inset(side) > 0) ? normalizeImageCrop({ x: inset("l"), y: inset("t"), w: 1 - inset("l") - inset("r"), h: 1 - inset("t") - inset("b") }) : undefined;
      slide.elements[id] = { id, type: "image", x, y, w, h, rotation: 0, z: z++, src, imageCrop, style: { fit: "contain" } };
    }
    slides.push(slide);
  }
  return { slides, warnings: [...new Set(warnings)] };
}
