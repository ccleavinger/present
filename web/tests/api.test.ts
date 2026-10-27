import { afterEach, expect, test } from "bun:test";
import { ApiError, api } from "../src/api";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

function installTimers(immediate = false) {
  let cleared = false;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      if (immediate) queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => { cleared = true; },
  } as unknown as Window & typeof globalThis;
  return () => cleared;
}

test("a stalled request fails with an actionable timeout and clears its timer", async () => {
  const wasCleared = installTimers(true);
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })) as typeof fetch;
  try {
    await api.listDecks();
    throw new Error("Expected a timeout");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(408);
    expect((error as Error).message).toContain("changes are still pending");
  }
  expect(wasCleared()).toBe(true);
});

test("lock conflicts preserve the server message and are distinguishable from timeouts", async () => {
  const wasCleared = installTimers();
  globalThis.fetch = (async () => Response.json({ error: "el_footer belongs to another editor" }, { status: 409 })) as typeof fetch;
  await expect(api.updateLocks("deck", "main", ["el_footer"])).rejects.toMatchObject({
    status: 409, message: "el_footer belongs to another editor",
  });
  expect(wasCleared()).toBe(true);
});

test("slide and notes are sent together in one save request", async () => {
  installTimers();
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls += 1;
    expect(String(url)).toBe("/api/decks/deck/slides/slide?sessionId=session");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      sessionId: "session", notes: "Speaker notes", slide: { id: "slide" },
    });
    return Response.json({});
  }) as typeof fetch;
  await api.writeSlide("deck", "slide", { id: "slide", name: "Title", background: "white", elements: {}, version: 1 }, "session", "Speaker notes");
  expect(calls).toBe(1);
});

test("two clipboard images with the same filename receive distinct asset URLs and retain their bytes", async () => {
  installTimers();
  const uploads: File[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    uploads.push(file);
    return Response.json({ name: file.name, url: `/assets/${file.name}` });
  }) as typeof fetch;
  const first = await api.uploadAsset("deck", "slide", new File(["first image"], "image.png", { type: "image/png" }));
  const second = await api.uploadAsset("deck", "slide", new File(["second image"], "image.png", { type: "image/png" }));
  expect(first.url).not.toBe(second.url);
  expect(uploads[0].name).toEndWith(".png");
  expect(uploads[1].name).toEndWith(".png");
  expect(await uploads[0].text()).toBe("first image");
  expect(await uploads[1].text()).toBe("second image");
});

test("history requests preserve branch names and pagination cursors", async () => {
  installTimers();
  const urls: URL[] = [];
  globalThis.fetch = (async (path: string) => {
    urls.push(new URL(path, "http://present.test"));
    return Response.json({ commits: [], nextCursor: null });
  }) as typeof fetch;
  await api.history("deck", "feature/slides", "older-commit");
  await api.commitSnapshot("deck", "feature/slides", "snapshot-id");
  expect(urls[0].pathname).toBe("/api/decks/deck/history");
  expect(urls[0].searchParams.get("branch")).toBe("feature/slides");
  expect(urls[0].searchParams.get("before")).toBe("older-commit");
  expect(urls[1].pathname).toBe("/api/decks/deck/history/snapshot-id");
  expect(urls[1].searchParams.get("branch")).toBe("feature/slides");
});

test("restoring identifies the selected version and the expected current head", async () => {
  installTimers();
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    const url = new URL(path, "http://present.test");
    expect(url.pathname).toBe("/api/decks/deck/history/old-version/restore");
    expect(url.searchParams.get("branch")).toBe("main");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ expectedHead: "current-head" });
    return Response.json({ id: "restore-commit" });
  }) as typeof fetch;
  expect(await api.restoreCommit("deck", "main", "old-version", "current-head")).toMatchObject({ id: "restore-commit" });
});
