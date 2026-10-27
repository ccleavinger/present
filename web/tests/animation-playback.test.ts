import { test } from "bun:test";
import { browserAvailable, runBrowserFixture } from "./browser";

test.skipIf(!browserAvailable)("presentation objects reveal, exit, re-enter, and reset without remounting", async () => {
  await runBrowserFixture("animation-playback.tsx", "PASS: object animation playback");
}, 20000);
