// Version matching, on-disk health, and the env a selection produces.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DIST, setupHome } from "./helpers.mjs";

const env = setupHome();
after(env.cleanup);
const c = await import(`${DIST}/components.js`);
const m = c.loadManifest();
const fake = c.findTool(m, "fake");
const other = c.findTool(m, "other");
const ghost = c.findTool(m, "ghost");
const resolve = (q) => c.resolveVersion(m, fake, q).version;

test("empty query → manifest default", () => {
  assert.equal(resolve(""), "1.2.3");
  assert.equal(resolve(undefined), "1.2.3");
});

test("exact match wins over prefixes", () => {
  assert.equal(resolve("1.2.3"), "1.2.3");
  assert.equal(resolve("25.0.1"), "25.0.1");
});

test("unique prefix on a segment boundary", () => {
  assert.equal(resolve("25"), "25.0.1");
  assert.equal(resolve("25.0"), "25.0.1");
  assert.equal(resolve("1.2.10"), "1.2.10");
});

test("'2' never matches 25: boundary is . or -", () => {
  assert.equal(resolve("2"), "2.0.0-rc-1");
  assert.equal(resolve("2.0.0"), "2.0.0-rc-1", "a - boundary counts too");
});

test("ambiguous prefix is refused, listing the candidates", () => {
  assert.throws(() => resolve("1.2"), /"1.2" is ambiguous for fake: 1.2.3, 1.2.10/);
  assert.throws(() => resolve("1"), /ambiguous/);
});

test("unapproved versions are refused, listing what is approved", () => {
  assert.throws(() => resolve("1.2.1"), /fake 1.2.1 is not approved\. Approved: 1.2.3, 1.2.10, 2.0.0-rc-1, 25.0.1/);
  assert.throws(() => resolve("3.0"), /not approved/, "on disk but not in the manifest");
});

test("no default → error", () => {
  const m2 = { ...m, versions: m.versions.map((v) => ({ ...v, isDefault: false })) };
  assert.throws(() => c.resolveVersion(m2, fake, ""), /No default fake version/);
});

test("versions sort numerically", () => {
  assert.deepEqual(
    c.versionsOf(m, fake).map((v) => v.version),
    ["1.2.3", "1.2.10", "2.0.0-rc-1", "25.0.1"],
  );
  assert.ok(c.compareVersions("9.3", "10.0") < 0);
});

test("findTool: by name or Components dir, case-insensitive", () => {
  assert.equal(c.findTool(m, "FAKE"), fake);
  assert.equal(c.findTool(m, "Other"), other);
  assert.equal(c.findTool(m, "nope"), undefined);
});

test("locate: home and bin dir, with root/bin alternatives", () => {
  assert.deepEqual(c.locate(fake, "1.2.3"), {
    home: join(env.components, "Fake", "1.2.3"),
    binDir: join(env.components, "Fake", "1.2.3", "bin"),
  });
  assert.deepEqual(c.locate(other, "1.0"), {
    home: join(env.components, "Other", "1.0", "libexec"),
    binDir: join(env.components, "Other", "1.0", "libexec", "sbin"),
  });
});

test("locate: explains what is wrong", () => {
  assert.match(c.locate(fake, "2.0.0-rc-1").problem, /missing on disk/);
  assert.match(c.locate(ghost, "9.9").problem, /missing on disk/);
});

test("unlistedOnDisk: healthy folders that aren't approved", () => {
  assert.deepEqual(c.unlistedOnDisk(m, fake), ["3.0"]);
  assert.deepEqual(c.unlistedOnDisk(m, ghost), []);
});

test("envFor: PATH entries, home vars and the selection", () => {
  const e = c.envFor(m, { fake: "25", other: "" });
  assert.deepEqual(e.path, [
    join(env.components, "Fake", "25.0.1", "bin"),
    join(env.components, "Other", "1.0", "libexec", "sbin"),
  ]);
  assert.deepEqual(e.vars, [["FAKE_HOME", join(env.components, "Fake", "25.0.1")]]);
  assert.deepEqual(e.selected, [
    { tool: "fake", version: "25.0.1" },
    { tool: "other", version: "1.0" },
  ]);
});

test("envFor: unknown tool, unapproved or missing version", () => {
  assert.throws(() => c.envFor(m, { nope: "" }), /Unknown component "nope"\. Available: fake, other, ghost/);
  assert.throws(() => c.envFor(m, { fake: "3.0" }), /not approved/);
  assert.throws(() => c.envFor(m, { fake: "2" }), /fake 2.0.0-rc-1: missing on disk/);
});
