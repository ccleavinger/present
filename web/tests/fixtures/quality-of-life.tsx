import { render } from "solid-js/web";
import JSZip from "jszip";
import { api } from "../../src/api";
import { clipboardImages } from "../../src/clipboard";
import { Editor } from "../../src/components/Editor";
import { ImportPptxModal } from "../../src/components/ImportPptxModal";
import { exportPptx, importPptx } from "../../src/pptx";
import type { Slide } from "../../src/types";

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) { if (predicate()) return; await wait(20); }
  throw new Error(message);
}
const key = (name: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const formatKey = (name: string, target: EventTarget = document.body, meta = false) => {
  const event = new KeyboardEvent("keydown", { key: name, ctrlKey: !meta, metaKey: meta, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

async function verify() {
  const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8;
  canvas.getContext("2d")!.fillRect(0, 0, 12, 8);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
  const file = new File([blob], "clipboard.png", { type: "image/png" });
  const bytes = new DataTransfer(); bytes.items.add(file); bytes.setData("text/html", '<img src="https://example.test/ignored.png">');
  check(clipboardImages(bytes).files.length === 1 && clipboardImages(bytes).sources.length === 0, "native clipboard image bytes must take priority over HTML");
  const osFile = new DataTransfer(); osFile.items.add(new File([blob], "screenshot.png"));
  check(clipboardImages(osFile).files[0]?.type === "image/png", "OS image files without MIME metadata were ignored");
  const html = new DataTransfer(); html.setData("text/html", '<img src="https://example.test/picture.png"><img src="javascript:alert(1)">');
  check(clipboardImages(html).sources.join() === "https://example.test/picture.png", "web image markup was not extracted safely");

  const user = { id: "user", username: "sam", displayName: "Sam" };
  const slides: Record<string, Slide> = Object.fromEntries(["s1", "s2"].map((id, index) => [id, { id, version: 1, name: `Slide ${index + 1}`, background: "white", elements: {} }]));
  const detail = { id: "deck", deck: { version: 1, title: "Demo", width: 1920, height: 1080, slides: ["s1", "s2"], tokens: {} }, slides: Object.values(slides).map((slide, index) => ({ id: slide.id, name: slide.name, background: slide.background, index, elementCount: 0 })), currentBranch: "main", branches: [{ name: "main", isCurrent: true, commitId: "head", summary: "Initial", time: 0 }], dirty: false };
  let uploads = 0, loggedOut = false;
  Object.assign(api, {
    createSession: async () => ({ id: "session", deckId: "deck", branch: "main", openedAt: 0 }),
    getDeck: async () => structuredClone(detail),
    getSlide: async (_deck: string, id: string) => ({ slide: structuredClone(slides[id]), notes: "", assets: [] }),
    collaboration: async () => ({ owner: user, members: [] }),
    commits: async () => [], deckTemplateBundle: async () => null, slideTemplates: async () => [], comments: async () => [],
    updateLocks: async (_deck: string, _branch: string, ids: string[]) => ({ acquired: ids, blocked: [] }),
    connectPresence: () => Object.assign(new EventTarget(), { readyState: 0, bufferedAmount: 0, send() {}, close() {} }),
    closeSession: async () => null,
    uploadAsset: async (_deck: string, _slide: string, image: File) => {
      uploads++; check(image.type === "image/png", "pasted image lost its MIME type");
      await wait(80);
      const encoded = btoa(String.fromCharCode(...new Uint8Array(await image.arrayBuffer())));
      return { name: image.name, url: `data:${image.type};base64,${encoded}` };
    },
    writeSlide: async (_deck: string, id: string, slide: Slide) => { slides[id] = structuredClone(slide); return { slide: structuredClone(slide), notes: "", assets: [] }; },
  });
  const stage = document.getElementById("stage")!;
  const disposeEditor = render(() => <Editor deckId="deck" activeDemoUser={user} onBack={() => {}} onSignOut={() => { loggedOut = true; }} />, stage);
  const currentSlide = () => document.querySelector<HTMLInputElement>('.inspector input[type="text"]')?.value;
  await until(() => currentSlide() === "Slide 1" && document.querySelector('.toolbar'), "editor failed to load");
  const topButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".topbar button"));
  check(topButtons.filter((item) => item.getAttribute("aria-label") === "Timeline").length === 1 && !document.querySelector(".topbar .branch-control") && !topButtons.some((item) => ["Branches", "Merge branches", "Version timeline"].includes(item.textContent?.trim() ?? "")), "branch and history controls were not condensed into one Timeline button");
  const buildButtons = topButtons.filter((item) => item.textContent?.trim() === "Build");
  check(buildButtons.length === 1 && !topButtons.some((item) => ["Agent", "Build / scripting"].includes(item.textContent?.trim() ?? "")), "agent and script tools were not condensed into one Build button");
  buildButtons[0].click();
  await until(() => document.querySelector<HTMLTextAreaElement>("#agent-request"), "Build did not open the agent panel");
  check(document.querySelectorAll('[aria-modal="true"]').length === 1, "Build opened nested modals");
  const task = document.querySelector<HTMLTextAreaElement>("#agent-request")!;
  task.value = "Create a clear summary slide"; task.dispatchEvent(new Event("input", { bubbles: true }));
  const buildTab = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((item) => item.textContent === name)!;
  buildTab("Script").click();
  const scriptFile = new DataTransfer(); scriptFile.items.add(new File(['api.log("keep this draft");'], "draft.js", { type: "text/javascript" }));
  document.querySelector(".script-editor")!.dispatchEvent(new DragEvent("drop", { dataTransfer: scriptFile, bubbles: true, cancelable: true }));
  await until(() => document.querySelector(".cm-content")?.textContent?.includes("keep this draft"), "script draft could not be loaded in Build");
  const codeEditor = document.querySelector(".cm-content");
  buildTab("API reference").click();
  check(document.getElementById("build-panel-API-reference")?.style.display === "block", "Build API reference did not open");
  buildTab("Agent").click();
  check(task.value === "Create a clear summary slide", "switching tabs lost the agent request");
  key("ArrowRight", buildTab("Agent"));
  check(buildTab("Script").getAttribute("aria-selected") === "true" && document.querySelector(".cm-content") === codeEditor && codeEditor?.textContent?.includes("keep this draft"), "switching tabs lost the script draft or keyboard tab navigation failed");
  Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-foot button")).find((item) => item.textContent?.trim() === "Close")!.click();
  check(!document.querySelector('[aria-modal="true"]'), "Build did not close as one modal");
  key("ArrowRight"); await until(() => currentSlide() === "Slide 2", "right arrow did not change slides");
  key("ArrowRight"); await wait(20); check(currentSlide() === "Slide 2", "last-slide navigation exceeded the slide list");
  const titleInput = document.querySelector<HTMLInputElement>(".deck-title-input")!;
  key("ArrowLeft", titleInput); await wait(20); check(currentSlide() === "Slide 2", "arrow inside a text input changed slides");

  const paste = new ClipboardEvent("paste", { clipboardData: bytes, bubbles: true, cancelable: true });
  document.body.dispatchEvent(paste);
  check(paste.defaultPrevented, "editor did not handle the native image paste");
  key("ArrowLeft"); await until(() => currentSlide() === "Slide 1", "left arrow did not change slides");
  await until(() => Object.values(slides.s2.elements).some((element) => element.type === "image"), "pasted image was not saved on its original slide after navigation");
  check(uploads === 1 && Object.keys(slides.s1.elements).length === 0, "clipboard image was duplicated or inserted into the wrong slide");
  key("ArrowDown"); await until(() => currentSlide() === "Slide 2", "down arrow did not change slides");
  key("ArrowUp"); await until(() => currentSlide() === "Slide 1", "up arrow did not change slides");

  const inputPaste = new ClipboardEvent("paste", { clipboardData: bytes, bubbles: true, cancelable: true });
  titleInput.dispatchEvent(inputPaste);
  check(!inputPaste.defaultPrevented && uploads === 1, "paste into a text input was intercepted by the slide editor");
  const richImage = new DataTransfer(); richImage.setData("text/html", `<img src="${canvas.toDataURL()}">`);
  document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: richImage, bubbles: true, cancelable: true }));
  await until(() => document.querySelector('.stage-panel .slide-element.kind-image'), "HTML clipboard image was not inserted on the stage");
  check(uploads === 2, "HTML clipboard image was not uploaded as an asset");

  const firstImage = document.querySelector<HTMLImageElement>('.stage-panel .slide-element.kind-image img')!;
  const firstImageSource = firstImage.src;
  canvas.getContext("2d")!.fillStyle = "red"; canvas.getContext("2d")!.fillRect(0, 0, 12, 8);
  const nextImage = new DataTransfer(); nextImage.setData("text/html", `<img src="${canvas.toDataURL()}">`);
  document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: nextImage, bubbles: true, cancelable: true }));
  await until(() => document.querySelectorAll('.stage-panel .slide-element.kind-image').length === 2, "a second image could not be pasted on the same slide");
  const imageObject = Array.from(document.querySelectorAll<HTMLElement>('.stage-panel .slide-element.kind-image')).at(-1)!;
  const secondImage = imageObject.querySelector("img")!;
  check(secondImage.src !== firstImageSource && firstImage.src === firstImageSource, "pasting image 2 reused or changed image 1");

  imageObject.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(() => document.querySelector('[aria-label="Crop zoom"]'), "double-clicking an image did not open cropping");
  const zoom = document.querySelector<HTMLInputElement>('[aria-label="Crop zoom"]')!;
  zoom.value = "2"; zoom.dispatchEvent(new Event("input", { bubbles: true }));
  const frame = document.querySelector<HTMLElement>(".image-crop-frame")!;
  key("ArrowLeft", frame);
  const bounds = frame.getBoundingClientRect();
  frame.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, button: 0, clientX: bounds.left + 50, clientY: bounds.top + 50, bubbles: true }));
  frame.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: bounds.left + 90, clientY: bounds.top + 60, bubbles: true }));
  frame.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, bubbles: true }));
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label)!;
  button("Apply crop").click();
  await until(() => !document.querySelector('[aria-modal="true"]'), "crop editor did not close after applying");
  check(secondImage.style.width === "200%" && imageObject.querySelector<HTMLElement>(".image-viewport")?.style.overflow === "hidden", "crop was not rendered through a clipped image viewport");
  const imageId = imageObject.dataset.elementId!;
  await until(() => slides.s1.elements[imageId]?.imageCrop, "crop was not persisted by autosave");
  const savedCrop = JSON.stringify(slides.s1.elements[imageId].imageCrop);
  const savedSource = slides.s1.elements[imageId].src;
  check(savedSource === secondImage.src, "cropping changed the original image source");
  imageObject.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(() => document.querySelector('[aria-label="Crop zoom"]'), "existing crop could not be reopened");
  const draftZoom = document.querySelector<HTMLInputElement>('[aria-label="Crop zoom"]')!;
  draftZoom.value = "3"; draftZoom.dispatchEvent(new Event("input", { bubbles: true }));
  button("Cancel").click();
  check(secondImage.style.width === "200%" && JSON.stringify(slides.s1.elements[imageId].imageCrop) === savedCrop, "cancel changed the saved crop");
  button("Reset crop").click();
  check(secondImage.style.width === "100%", "reset did not restore the original image");
  formatKey("z");
  await until(() => secondImage.style.width === "200%" && currentSlide() === "Slide 1", "undo did not restore the crop");

  document.querySelector<HTMLButtonElement>('[title="Add text (T)"]')!.click();
  await until(() => document.querySelector(".inspector .type-badge")?.textContent === "text", "new object was not selected");
  const object = document.querySelector<HTMLElement>('.stage-panel .slide-element.kind-text')!;
  const left = Number.parseFloat(object.style.left);
  key("ArrowRight");
  check(Number.parseFloat(object.style.left) === left + 1, "arrow did not nudge the selected object");
  const text = object.querySelector<HTMLElement>(".text-box")!;
  check(formatKey("b").defaultPrevented && text.style.fontWeight === "400", "Ctrl+B did not toggle the selected text box");
  formatKey("b", document.body, true); check(text.style.fontWeight === "700", "Cmd+B did not enable bold");
  formatKey("i"); check(text.style.fontStyle === "italic", "Ctrl+I did not enable italics");
  text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(() => text.isContentEditable, "text could not be edited");
  const selection = window.getSelection()!, range = document.createRange();
  range.setStart(text.firstChild!, 0); range.setEnd(text.firstChild!, 3); selection.removeAllRanges(); selection.addRange(range);
  formatKey("i", text);
  check(text.style.fontStyle === "normal" && selection.toString() === "New", "formatting while typing lost the text selection");
  formatKey("i", text, true);
  check(text.style.fontStyle === "italic" && !text.querySelector("b,i,strong,em"), "formatting inserted untracked rich markup");
  const font = document.querySelector<HTMLSelectElement>('[aria-label="Text font"]')!;
  font.value = "Georgia"; font.dispatchEvent(new Event("change", { bubbles: true }));
  check(text.style.fontFamily === "Georgia", "font selection did not update the text box");
  document.querySelector<HTMLButtonElement>('[aria-label="Align center"]')!.click();
  check(getComputedStyle(text).textAlign === "center" && document.querySelector('[aria-label="Align center"]')?.getAttribute("aria-pressed") === "true", "center alignment did not update the text box");
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  check(getComputedStyle(text).textAlign === "left", "left alignment keyboard shortcut did not work while editing");
  document.querySelector<HTMLButtonElement>('[aria-label="Align right"]')!.click();
  check(getComputedStyle(text).textAlign === "right", "right alignment did not update the text box");
  const titleShortcut = formatKey("b", titleInput);
  check(!titleShortcut.defaultPrevented && text.style.fontWeight === "700", "text shortcuts interfered with the deck title input");

  const profile = document.querySelector<HTMLDetailsElement>(".dropdown-root:has(.profile-trigger)")!;
  profile.querySelector<HTMLElement>("summary")!.click();
  check(profile.open && !loggedOut, "profile pill did not open its account menu");
  key("Escape", profile.querySelector("summary")!);
  check(!profile.open, "Escape did not close the account menu");
  key("ArrowDown", profile.querySelector("summary")!);
  check(profile.open && document.activeElement?.textContent === "Log out", "account menu could not be opened with the keyboard");
  profile.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
  await until(() => loggedOut, "Log out did not flush and sign out");
  check(!profile.open, "account menu stayed open after choosing an action");
  disposeEditor();

  const exported = await exportPptx("Formatted slide", [slides.s1]);
  const roundtrip = await importPptx(new File([exported.blob], "formatted.pptx"));
  const exportedElements = Object.values(roundtrip.slides[0].elements);
  const exportedText = exportedElements.find((element) => element.type === "text")!;
  check(exportedText.style.fontFamily === "Georgia" && exportedText.style.fontWeight === 700 && exportedText.style.fontStyle === "italic", "PowerPoint export lost font, bold, or italic formatting");
  check(exportedText.style.align === "right", "PowerPoint export or import lost text alignment");
  const exportedImage = exportedElements.find((element) => element.type === "image" && element.imageCrop)!;
  check(exportedImage?.imageCrop && Math.abs(exportedImage.imageCrop.w - 0.5) < 0.001, "PowerPoint export lost the image crop");

  // Reordered PowerPoint slides must follow presentation.xml, not filenames.
  const p = "http://schemas.openxmlformats.org/presentationml/2006/main", a = "http://schemas.openxmlformats.org/drawingml/2006/main", r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", rel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="2" r:id="second"/><p:sldId id="1" r:id="first"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${rel}"><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>`);
  for (const number of [1, 2]) zip.file(`ppt/slides/slide${number}.xml`, `<p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>SLIDE ${number}</a:t></a:r></a:p></p:txBody></p:sp>${number === 2 ? '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic>' : ''}</p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/_rels/slide2.xml.rels", `<Relationships xmlns="${rel}"><Relationship Id="image" Target="../media/image.png"/></Relationships>`);
  zip.file("ppt/media/image.png", await blob.arrayBuffer());
  const powerpoint = new File([await zip.generateAsync({ type: "uint8array" })], "Imported example.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  let created = "", importedBundle: any;
  api.createDeck = async (title, _id, _templateId, bundle) => {
    check(title === "Imported example", "import did not derive a deck title from the file");
    importedBundle = bundle;
    return { ...detail, id: "imported" };
  };
  const disposeImport = render(() => <ImportPptxModal onClose={() => {}} onCreated={(id) => { created = id; }} />, stage);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const selected = new DataTransfer(); selected.items.add(powerpoint); input.files = selected.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => document.querySelectorAll(".print-preview-grid article").length === 2, "PowerPoint import did not show a deck preview");
  const createButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Create deck")!;
  check(!createButton.disabled, "imported slides could not be used to create a deck");
  createButton.click(); await until(() => created === "imported", "PowerPoint import did not create a new deck");
  check(importedBundle.kind === "pptx" && importedBundle.initialSlides.length === 2, "deck creation did not receive the imported slides");
  const imported = Object.values(importedBundle.initialSlides[0].elements) as any[];
  check(imported.some((element) => element.text === "SLIDE 2"), "PowerPoint presentation order was lost");
  check(imported.some((element) => element.src?.startsWith("data:image/png;base64,")), "embedded PowerPoint images lost their MIME type");
  disposeImport();
}

verify().then(() => { document.getElementById("result")!.textContent = "PASS: editor quality of life"; })
  .catch((error) => { document.getElementById("result")!.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; });
