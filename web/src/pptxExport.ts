import PptxGenJS from "pptxgenjs";
import type { Slide } from "./types";
import { normalizeImageCrop } from "./imageCrop";
import { isBold, isItalic } from "./textFormatting";

const CANVAS_W = 1920;

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

