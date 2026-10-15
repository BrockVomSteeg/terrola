import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Text tripwires, not proofs: the unit tier cannot render React or decode an image.
// They fail when a known client bug is put back: a photo sent with its metadata, the
// whole map lost to one failed tile, a delete that looks like it worked when it did
// not. The real behaviour is checked in a browser by the e2e tier.

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

const admin = read("components", "Map", "AdminPanel.tsx");
const canvas = read("components", "Map", "MapCanvas.tsx");
const card = read("components", "Map", "LocationCard.tsx");
const reframe = read("components", "Map", "ReframeOverlay.tsx");
const gate = read("components", "UI", "PasswordGate.tsx");
const client = read("lib", "api-client.ts");

/** The text of a top level function, from its signature to the closing brace. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`${signature} was not found`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`the end of ${signature} was not found`);
  return source.slice(start, end + 2);
}

/** The text from a marker up to the next marker, for code inside a component. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`${from} was not found`);
  const end = source.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`${to} was not found after ${from}`);
  return source.slice(start, end);
}

test.describe("a photo is always re-encoded before upload", () => {
  const compress = body(admin, "async function compressImage(");

  test("compressImage has no path that returns the original file", () => {
    expect(compress).not.toMatch(/return\s+file\s*;/);
    // No size shortcut that skips the canvas.
    expect(compress).not.toMatch(/file\.size\s*</);
    // Every failure refuses the photo.
    expect(compress).toContain('throw new Error("PHOTO_UNREADABLE")');
    expect(compress).toContain("if (!blob || blob.size === 0) throw new Error(\"PHOTO_UNREADABLE\")");
  });

  test("a failed re-encode refuses the upload instead of sending the original", () => {
    const picker = between(admin, "compressed = await compressImage(file);", "if (editingId)");
    expect(picker).not.toMatch(/compressed\s*=\s*file/);
    expect(picker).toContain("return;");
  });

  test("the file picker does not offer HEIC, which the code refuses", () => {
    const accept = /accept="([^"]+)"/.exec(admin);
    expect(accept?.[1]).toBe("image/jpeg,image/png,image/webp");
  });
});

test.describe("the map", () => {
  const options = between(canvas, "new mapboxgl.Map({", "});");

  test("sends no performance metrics (SPEC R12)", () => {
    expect(options).toContain("performanceMetricsCollection: false");
  });

  test("shows the error screen only for a fatal start failure", () => {
    const handler = between(canvas, 'map.on("error"', "// Update cluster markers");
    expect(handler).toContain("status === 401 || status === 403");
    expect(handler).toContain("!styleReady");
    expect(handler).toContain("if (authRefused || startFailed)");
    // Not every error: the old handler set the error screen unconditionally.
    expect(handler).not.toMatch(/map\.on\("error",\s*\(\)\s*=>\s*\{\s*setMapError\(true\)/);
  });

  test("a poll clears a waiting re-arm timer first, so only one chain runs", () => {
    const poll = between(canvas, "const poll = async () => {", "lastPollAt = Date.now();");
    expect(poll).toMatch(/if \(timer\) \{\s*clearTimeout\(timer\);\s*timer = null;/);
  });
});

test.describe("a delete", () => {
  test("in the panel counts only when the server says yes", () => {
    const request = body(admin, "async function requestLocationDelete(");
    expect(request).toContain("return res.ok;");
    const send = between(admin, "async function sendDelete(", "function handleSoftDelete(");
    expect(send).toContain("if (ok) {");
    expect(send).toContain("showToast(");
  });

  test("in the panel sends an earlier pending delete instead of dropping it", () => {
    const soft = between(admin, "function handleSoftDelete(", "function handleUndoDelete(");
    expect(soft).toContain("if (earlier && earlier.id !== loc.id) void sendDelete(earlier);");
  });

  test("closing the panel inside the undo window sends the delete", () => {
    const cleanup = between(admin, "setReauthReloadSuppressed(false);", "}, []);");
    expect(cleanup).toContain("requestLocationDelete(pendingDelete.id)");
  });

  test("from the card sends an earlier pending delete, and a failure brings the pin back", () => {
    const soft = between(canvas, "const handleSoftDeleteFromCard", "const handleUndoCardDelete");
    expect(soft).toContain("if (earlier && earlier.id !== loc.id) void sendCardDelete(earlier);");
    const send = between(canvas, "const sendCardDelete", "const handleSoftDeleteFromCard");
    expect(send).toContain("[loc, ...prev]");
    expect(send).toContain("setCardNotice(");
  });
});

test.describe("messages", () => {
  test("the password gate tells a wrong password from a wait or a server problem", () => {
    expect(gate).toContain("res.status === 401");
    expect(gate).toContain("res.status === 429");
    expect(gate).toContain("Wrong password.");
    expect(gate).toContain("Wait a few minutes");
    expect(gate).toContain("can't check the password right now");
    // Every failure puts the cursor back in the field.
    const fail = between(gate, "function fail(", "async function submit(");
    expect(fail).toContain("inputRef.current?.focus();");
    // The 401, 429, other and network branches all go through fail().
    expect(between(gate, "async function submit(", "function onKeyDown(").match(/fail\(/g)?.length).toBe(4);
  });

  test("a 403 from the read only demo says so, not CSRF", () => {
    expect(client).toContain('body?.error === "demo_read_only"');
    expect(client).toContain("This demo is read only.");
  });

  test("a failed reframe save shows a message in the editor", () => {
    expect(card).toContain('setReframeError("Couldn\'t save the framing. Try again.")');
    expect(card).toContain("error={reframeError}");
    expect(reframe).toContain('role="alert"');
  });
});

test.describe("Escape", () => {
  test("closes the place card unless the lightbox or the reframe editor is open", () => {
    const handler = between(card, "const handleKey = (e: KeyboardEvent) => {", "};");
    expect(handler).toContain('e.key !== "Escape"');
    expect(handler).toContain("selectedPhotoIndex !== null || reframePhotoUrl");
    expect(handler).toContain("onClose();");
  });

  test("closes the reframe editor and stops there, so the card stays open", () => {
    const handler = between(reframe, "const handleKey = (e: KeyboardEvent) => {", "};");
    expect(handler).toContain('e.key !== "Escape"');
    expect(handler).toContain("e.stopPropagation();");
    expect(reframe).toContain('window.addEventListener("keydown", handleKey, true)');
  });
});
