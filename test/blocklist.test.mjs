// Blocklist loading (fail closed), matching, and the blocked-attempt log.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BLOCKLIST, DIST, setupHome } from "./helpers.mjs";

const env = setupHome();
after(env.cleanup);
const b = await import(`${DIST}/blocklist.js`);
const listPath = process.env.TOOLSHELF_BLOCKLIST;
// Built so this file never contains the blocked phrases literally.
const BREW = ["br", "ew"].join("") + " install";

test("loads rules with reasons; comments and blank lines ignored", () => {
  const rules = b.loadBlocklist();
  assert.equal(rules.length, 2);
  assert.equal(rules[0].reason, "Homebrew changes system tools");
  assert.equal(rules[0].line, 2);
});

test("a line without ## gets a default reason", () => {
  writeFileSync(listPath, "forbidden\n");
  try {
    assert.equal(b.loadBlocklist()[0].reason, "blocked by policy");
  } finally {
    writeFileSync(listPath, BLOCKLIST);
  }
});

test("matches anywhere in a compound command, first rule wins", () => {
  const rules = b.loadBlocklist();
  assert.equal(b.matchBlocklist(rules, `${BREW} jq`)?.line, 2);
  assert.equal(b.matchBlocklist(rules, `echo hi && ${BREW} jq`)?.line, 2);
  assert.equal(b.matchBlocklist(rules, "npm i -g typescript")?.line, 3);
  assert.equal(b.matchBlocklist(rules, "npm i typescript"), undefined, "project installs are fine");
  assert.equal(b.matchBlocklist(rules, "echo homebrew"), undefined);
});

test("fails closed: a missing list refuses", () => {
  rmSync(listPath);
  try {
    assert.throws(() => b.loadBlocklist(), (e) => e instanceof b.BlocklistError && /refusing to run commands/.test(e.message));
  } finally {
    writeFileSync(listPath, BLOCKLIST);
  }
});

test("fails closed: an invalid regex refuses, naming the line", () => {
  writeFileSync(listPath, "# ok\nfine ## ok\n([unclosed ## bad\n");
  try {
    assert.throws(() => b.loadBlocklist(), /Invalid blocklist .*\n\s+line 3:/);
  } finally {
    writeFileSync(listPath, BLOCKLIST);
  }
});

test("recordBlocked appends one JSON line per block, same shape as guard.sh", () => {
  const rules = b.loadBlocklist();
  const cmd = `echo hi && ${BREW} jq`;
  b.recordBlocked(b.matchBlocklist(rules, cmd), cmd, "/some/project");
  b.recordBlocked(b.matchBlocklist(rules, "npm i -g x"), "npm i -g x", "/p2");

  assert.equal(b.BLOCKED_LOG, `${env.state}/blocked.jsonl`);
  const lines = readFileSync(b.BLOCKED_LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["command", "cwd", "match", "reason", "source", "ts"]);
  assert.equal(lines[0].source, "run");
  assert.equal(lines[0].reason, "Homebrew changes system tools");
  assert.equal(lines[0].match.trim(), BREW);
  assert.equal(lines[0].cwd, "/some/project");
  assert.match(lines[0].ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(lines[1].cwd, "/p2");
});

test("recordBlocked truncates long commands and never throws", () => {
  rmSync(b.BLOCKED_LOG, { force: true });
  const rules = b.loadBlocklist();
  const long = `${BREW} ` + "x".repeat(5000);
  b.recordBlocked(b.matchBlocklist(rules, long), long, "/p");
  assert.equal(JSON.parse(readFileSync(b.BLOCKED_LOG, "utf-8")).command.length, 2000);

  // An unwritable state dir (a file in its place) is ignored, not thrown.
  rmSync(env.state, { recursive: true, force: true });
  writeFileSync(env.state, "not a dir");
  try {
    assert.doesNotThrow(() => b.recordBlocked(rules[0], long, "/p"));
  } finally {
    rmSync(env.state, { force: true });
  }
  assert.ok(!existsSync(b.BLOCKED_LOG));
});
