import { test } from "bun:test";
import { browserAvailable, runBrowserFixture } from "./browser";

test.skipIf(!browserAvailable)("Timeline groups branch management, history, restores, and merges with safe branch context", async () => {
  await runBrowserFixture("timeline-workspace.tsx", "PASS: unified timeline workspace");
}, 20000);
