import { expect, test } from "bun:test";
import { deckHash, parseRoute, sameRoute, shareLinkUrl } from "../src/routes";

test("share invitations retain the deck and token independently of account sign-in", () => {
  expect(parseRoute("#/share/demo/abc123")).toEqual({ view: "share", id: "demo", token: "abc123" });
  expect(sameRoute(parseRoute("#/share/demo/abc123"), parseRoute("#/share/demo/other"))).toBe(false);
});

test("opening a share link targets the invited branch even when another branch is preferred", () => {
  const target = deckHash("demo", "feature/shared slides");
  expect(parseRoute(target)).toEqual({ view: "editor", id: "demo", branch: "feature/shared slides" });
  expect(sameRoute(parseRoute(target), parseRoute(deckHash("demo", "main")))).toBe(false);
  expect(sameRoute(parseRoute(target), parseRoute(target))).toBe(true);
});

test("copied links preserve deployments under a subpath and replace the editor route", () => {
  expect(shareLinkUrl("demo", "token", "https://slides.example/app/#/deck/old?branch=main")).toBe("https://slides.example/app/#/share/demo/token");
  expect(parseRoute("#/share/%invalid/token")).toEqual({ view: "list" });
});
