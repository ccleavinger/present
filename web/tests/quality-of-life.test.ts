import { test } from "bun:test";
import { browserAvailable, runBrowserFixture } from "./browser";

test.skipIf(!browserAvailable)("clipboard images, slide arrows, account menus, and PowerPoint deck creation work in the browser", async () => {
  await runBrowserFixture("quality-of-life.tsx", "PASS: editor quality of life");
}, 20000);
