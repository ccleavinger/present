import { expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";

const chromium = Bun.which("chromium") ?? Bun.which("chromium-browser") ?? Bun.which("google-chrome");
export const browserAvailable = !!chromium && Bun.spawnSync([chromium, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export async function runBrowserFixture(fixture: string, expected: string) {
  const directory = await mkdtemp(join(tmpdir(), "present-browser-check-"));
  try {
    const bundle = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixtures", fixture)],
      target: "browser",
      format: "iife",
      // Bun emits Browserify's optional require fallback without a declaration.
      // Keep that fallback undefined, as it is in an ordinary browser.
      banner: "var __require;",
      conditions: ["browser"],
      plugins: [{
        name: "solid-browser-fixture",
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, ({ path }) => ({ path, namespace: "unused-worker" }));
          builder.onLoad({ filter: /.*/, namespace: "unused-worker" }, () => ({ contents: "export default class { constructor() { throw new Error('Unexpected worker in browser fixture'); } }", loader: "js" }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await readFile(path, "utf8"), {
              filename: path,
              babelrc: false,
              configFile: false,
              parserOpts: { plugins: ["typescript", "jsx"] },
              presets: [[solid, { generate: "dom" }]],
            });
            return { contents: result!.code!, loader: "ts" };
          });
        },
      }],
    });

    expect(bundle.success).toBe(true);
    const source = await bundle.outputs[0].text();
    const html = join(directory, "index.html");
    const reportErrors = `window.addEventListener("error",e=>document.getElementById("result").textContent="ERROR: "+(e.error?.stack??e.message));window.addEventListener("unhandledrejection",e=>document.getElementById("result").textContent="ERROR: "+e.reason);`;
    await writeFile(html, `<!doctype html><div id="stage" style="position:relative;width:1920px;height:1080px"></div><pre id="result">PENDING</pre><script>${reportErrors}</script><script>${source.replaceAll("</script", "<\\/script")}</script>`);
    const browser = Bun.spawn([
      chromium!, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-background-networking", `--user-data-dir=${join(directory, "profile")}`,
      "--dump-dom", "--virtual-time-budget=10000", `file://${html}`,
    ], { stdout: "pipe", stderr: "pipe" });
    const [dom, errors, exitCode] = await Promise.all([
      new Response(browser.stdout).text(), new Response(browser.stderr).text(), browser.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Chromium exited ${exitCode}: ${errors}`);
    const result = dom.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
    if (result !== expected) await writeFile(join(tmpdir(), "present-browser-last.js"), source);
    expect(result).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
