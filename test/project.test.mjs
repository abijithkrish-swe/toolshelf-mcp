// What counts as a project folder (cwd for run), .toolsrc parsing, proxy rules.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DIST, makeProject, put, setupHome } from "./helpers.mjs";

const env = setupHome();
after(env.cleanup);
const s = await import(`${DIST}/sandbox.js`);
const { readToolsrc } = await import(`${DIST}/toolsrc.js`);
const home = env.home;

test("a folder with a marker is a project; ~ is expanded", () => {
  const app = makeProject(home, "app");
  assert.equal(s.validateProject(app), app);
  assert.equal(s.validateProject("~/Projects/app"), app);
});

test("a marker in a parent counts (subfolder of a repo)", () => {
  const repo = makeProject(home, "repo", ".git");
  const sub = join(repo, "packages", "core");
  mkdirSync(sub, { recursive: true });
  assert.equal(s.validateProject(sub), sub);
});

test("every marker type is recognised", () => {
  for (const marker of [".toolshelf", "pom.xml", "build.gradle.kts", "Cargo.toml", "go.mod", "pyproject.toml", "Makefile"]) {
    const p = makeProject(home, `m-${marker.replace(/\W/g, "")}`, marker);
    assert.equal(s.validateProject(p), p, marker);
  }
});

test("refuses folders that aren't projects", () => {
  mkdirSync(join(home, "Projects", "notes"), { recursive: true });
  assert.throws(() => s.validateProject(join(home, "Projects", "notes")), /doesn't look like a project.*\.toolshelf/s);
  assert.throws(() => s.validateProject(join(home, "Projects")), /too broad/);
  assert.throws(() => s.validateProject("~"), /must be a project folder inside/);
  assert.throws(() => s.validateProject("/usr"), /must be a project folder inside/);
  assert.throws(() => s.validateProject(join(home, "Projects", "nope")), /cwd does not exist/);
  put(join(home, "Projects", "file.txt"), "x");
  assert.throws(() => s.validateProject(join(home, "Projects", "file.txt")), /not a directory/);
});

test("markers in ~ or ~/<folder> never make everything below a project", () => {
  put(join(home, "Makefile"), "");
  put(join(home, "Work", "Makefile"), "");
  mkdirSync(join(home, "Work", "loose"), { recursive: true });
  assert.throws(() => s.validateProject(join(home, "Work", "loose")), /doesn't look like a project/);
  // two levels below $HOME is the highest a marker may be
  put(join(home, "Work", "repo", ".git"), "");
  mkdirSync(join(home, "Work", "repo", "a", "b"), { recursive: true });
  assert.equal(s.validateProject(join(home, "Work", "repo", "a", "b")), join(home, "Work", "repo", "a", "b"));
});

test("private folders are never projects, even with a marker", () => {
  for (const dir of [".ssh/x", ".config/x", "Library/x", "Components/x", ".claude/x"]) {
    const p = join(home, dir);
    put(join(p, "package.json"), "{}");
    assert.throws(() => s.validateProject(p), /never a project folder/, dir);
  }
});

test("symlinks are resolved before checking", () => {
  put(join(home, ".config", "sneaky", "package.json"), "{}");
  mkdirSync(join(home, "Projects", "links"), { recursive: true });
  symlinkSync(join(home, ".config", "sneaky"), join(home, "Projects", "links", "sneaky"));
  assert.throws(() => s.validateProject(join(home, "Projects", "links", "sneaky")), /never a project folder/);
});

test(".toolsrc: tool keys, empty values skipped, shell-only and unknown keys", () => {
  const p = makeProject(home, "rc");
  put(join(p, ".toolsrc"), [
    "# pinned",
    "JDK=17",
    "MAVEN=3.9   # comment",
    "NODE=",
    "MYSQL_DEFAULT_VER=8.0.43",
    "PATH_PREPEND=/x",
    "EXPORT=FOO=bar",
    "COLOUR=blue",
    "",
  ].join("\n"));
  const rc = readToolsrc(p);
  assert.deepEqual(rc.tools, { jdk: "17", maven: "3.9", mysql: "8.0.43" });
  assert.deepEqual(rc.shellOnly, ["PATH_PREPEND", "EXPORT"]);
  assert.deepEqual(rc.unknown, ["COLOUR"]);
  assert.equal(readToolsrc(makeProject(home, "norc")), undefined);
});

test("proxy must be on localhost", () => {
  const saved = process.env.TOOLSHELF_PROXY;
  try {
    process.env.TOOLSHELF_PROXY = "http://127.0.0.1:3128";
    assert.deepEqual(s.proxyFromEnv(), { url: "http://127.0.0.1:3128", host: "127.0.0.1", port: "3128" });
    process.env.TOOLSHELF_PROXY = "http://proxy.example.com:8080";
    assert.throws(() => s.proxyFromEnv(), /must be on localhost/);
    process.env.TOOLSHELF_PROXY = "not a url";
    assert.throws(() => s.proxyFromEnv(), /invalid proxy URL/);
  } finally {
    process.env.TOOLSHELF_PROXY = saved;
  }
});
