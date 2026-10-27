import { test } from "bun:test";
import { browserAvailable, runBrowserFixture } from "./browser";

test.skipIf(!browserAvailable)("share links can be created, copied, revoked, and opened through sign-up on the invited branch", async () => {
  await runBrowserFixture("sharing.tsx", "PASS: share links and invitation routing");
}, 20000);
