// components.conf parsing: the approved list. Any error rejects the whole file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DIST, DIGEST, MANIFEST, PINNED, setupHome } from "./helpers.mjs";

const env = setupHome();
after(env.cleanup);
const { loadManifest, ManifestError, PINNED_IMAGE } = await import(`${DIST}/components.js`);

/** Load a manifest text; returns the Manifest or the error message. */
function load(text) {
  writeFileSync(env.manifestPath, text);
  try {
    return loadManifest();
  } catch (err) {
    assert.ok(err instanceof ManifestError, `expected ManifestError, got ${err}`);
    return err.message;
  } finally {
    writeFileSync(env.manifestPath, MANIFEST);
  }
}

test("parses tools, versions, flags and images", () => {
  const m = load(MANIFEST);
  assert.deepEqual(
    m.tools.map((t) => t.name),
    ["fake", "other", "ghost"],
  );
  const other = m.tools.find((t) => t.name === "other");
  assert.deepEqual(other.root, ["libexec", "."]);
  assert.deepEqual(other.bin, ["sbin", "bin"]);
  assert.equal(other.check, "other");
  assert.deepEqual(m.tools[0].homeEnv, ["FAKE_HOME"]);
  assert.deepEqual(m.tools[0].root, ["."], "root defaults to the version folder");
  assert.deepEqual(m.tools[0].bin, ["bin"], "bin defaults to bin");

  const def = m.versions.find((v) => v.tool === "fake" && v.isDefault);
  assert.equal(def.version, "1.2.3");
  assert.equal(m.versions.find((v) => v.tool === "other").docker, PINNED);
  assert.equal(m.images.fwd, `alpine/socat:1@sha256:${"b".repeat(64)}`);
});

test("comments and blank lines are ignored, including trailing comments", () => {
  const m = load("# c\n\n@tool t dir=T   # the tool\nt 1.0 default # yes\n");
  assert.equal(m.versions[0].version, "1.0");
  assert.equal(m.versions[0].isDefault, true);
});

test("autoload and onpath flags", () => {
  const m = load("@tool t dir=T\nt 1 autoload\n@tool u dir=U\nu 2 onpath\n");
  assert.equal(m.versions[0].autoload, true);
  assert.equal(m.versions[1].onPath, true);
});

const invalid = {
  "unknown directive": ["@frobnicate x\n", /line 1: unknown directive @frobnicate/],
  "version before its @tool": ["t 1.0\n@tool t dir=T\n", /version for undefined tool "t"/],
  "@tool without dir": ["@tool t\n", /@tool t needs dir=/],
  "unknown @tool key": ["@tool t dir=T colour=red\n", /unknown @tool key "colour=red"/],
  "duplicate @tool": ["@tool t dir=T\n@tool t dir=U\n", /duplicate @tool t/],
  "duplicate version": ["@tool t dir=T\nt 1\nt 1\n", /duplicate t 1/],
  "unknown flag": ["@tool t dir=T\nt 1 sometimes\n", /unknown flag "sometimes"/],
  "two defaults": ["@tool t dir=T\nt 1 default\nt 2 default\n", /second default for t/],
  "two autoloads": ["@tool t dir=T\nt 1 autoload\nt 2 autoload\n", /second autoload for t/],
  "autoload and onpath": ["@tool t dir=T\nt 1 autoload\nt 2 onpath\n", /autoload and onpath are exclusive/],
  "tag-only docker image": ["@tool t dir=T\nt 1 docker=node:22\n", /must be pinned by digest/],
  "short digest": ["@tool t dir=T\nt 1 docker=node@sha256:abc\n", /must be pinned by digest/],
  "unpinned @image": ["@image fwd alpine/socat:latest\n", /@image fwd must be pinned by digest/],
  "@image without ref": ["@image fwd\n", /@image needs a name and an image/],
};
for (const [name, [text, re]] of Object.entries(invalid)) {
  test(`rejects: ${name}`, () => {
    const r = load(text);
    assert.equal(typeof r, "string", "expected the manifest to be rejected");
    assert.match(r, re);
  });
}

test("one bad line rejects the whole file and reports every error", () => {
  const r = load("@tool t dir=T\nt 1 default\nt 2 bogus\n@nope\n");
  assert.equal(typeof r, "string");
  assert.match(r, /line 3: unknown flag "bogus"/);
  assert.match(r, /line 4: unknown directive @nope/);
});

test("missing manifest explains how to deploy it", () => {
  const saved = process.env.COMPONENTS_MANIFEST;
  process.env.COMPONENTS_MANIFEST = `${env.home}/nope.conf`;
  try {
    assert.throws(() => loadManifest(), (e) => e instanceof ManifestError && /not found.*install_copy\.sh deploy/.test(e.message));
  } finally {
    process.env.COMPONENTS_MANIFEST = saved;
  }
});

test("PINNED_IMAGE accepts only full sha256 digests", () => {
  assert.ok(PINNED_IMAGE.test(`node:22@sha256:${DIGEST}`));
  assert.ok(PINNED_IMAGE.test(`node@sha256:${DIGEST}`));
  assert.ok(!PINNED_IMAGE.test("node:22"));
  assert.ok(!PINNED_IMAGE.test(`node:22@sha256:${DIGEST.slice(1)}`));
  assert.ok(!PINNED_IMAGE.test(`node:22@sha256:${DIGEST.toUpperCase()}`));
});
