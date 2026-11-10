// Real sandboxed runs (macOS sandbox-exec). These prove the isolation claims:
// writes, secrets, env, network, temp dir, timeout, output tail and logs.
// Skipped when already inside a toolshelf sandbox, where sandbox-exec can't nest.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DIST, IN_SANDBOX, makeProject, put, setupHome } from "./helpers.mjs";

const skip = IN_SANDBOX ? "sandbox-exec can't run inside toolshelf's own sandbox; run npm test from a terminal" : false;

const env = setupHome();
after(env.cleanup);
const { loadManifest } = await import(`${DIST}/components.js`);
const s = await import(`${DIST}/sandbox.js`);
const m = loadManifest();
const project = makeProject(env.home, "app");
put(join(env.home, ".ssh", "id_test"), "PRIVATE KEY\n");
put(join(env.home, ".config", "secrets", "vault.store"), "VAULT\n");

process.env.PARENT_SECRET = "hunter2";

const run = (command, extra = {}) =>
  s.runSandboxed(m, { tools: { fake: "25" }, command, cwd: project, timeoutSec: 20, tailChars: 8192, ...extra });

test("runs with the approved tool on PATH and its home var", { skip }, async () => {
  const r = await run('fake hello && echo "home=$FAKE_HOME"');
  assert.equal(r.exitCode, 0, r.tail);
  assert.match(r.tail, /fake 25\.0\.1 hello/);
  assert.match(r.tail, new RegExp(`home=${join(env.components, "Fake", "25.0.1")}`));
  assert.deepEqual(r.selected, [{ tool: "fake", version: "25.0.1" }]);
});

test("the environment is rebuilt, not inherited", { skip }, async () => {
  const r = await run('echo "secret=[$PARENT_SECRET] sandbox=$TOOLSHELF_SANDBOX path=$PATH"');
  assert.match(r.tail, /secret=\[\] sandbox=1/);
  assert.doesNotMatch(r.tail, /homebrew|\.local\/bin/, "only component bins + system dirs on PATH");
});

test("writes: the project yes; home, /tmp no", { skip }, async () => {
  const r = await run(
    "echo ok > built.txt && echo built; " +
      'echo x > "$HOME/outside.txt" 2>&1 || echo home-denied; ' +
      "echo x > /tmp/toolshelf-test-$$ 2>&1 || echo tmp-denied",
  );
  assert.match(r.tail, /built/);
  assert.equal(readFileSync(join(project, "built.txt"), "utf-8"), "ok\n");
  assert.match(r.tail, /home-denied/);
  assert.match(r.tail, /tmp-denied/);
  assert.ok(!existsSync(join(env.home, "outside.txt")));
  assert.equal(s.sandboxDenied(r.logPath), true);
});

test("$TMPDIR is private to the run and removed afterwards", { skip }, async () => {
  const r = await run('echo data > "$TMPDIR/scratch" && cat "$TMPDIR/scratch" && echo "$TMPDIR" > tmpdir.txt');
  assert.equal(r.exitCode, 0, r.tail);
  assert.match(r.tail, /data/);
  const tmp = readFileSync(join(project, "tmpdir.txt"), "utf-8").trim();
  assert.ok(tmp.startsWith(join(env.home, ".cache", "toolshelf", "tmp")), tmp);
  assert.ok(!existsSync(tmp), "per-run tmp is deleted");
  assert.equal(s.sandboxDenied(r.logPath), false);
});

test("secrets are unreadable", { skip }, async () => {
  const r = await run("cat ~/.ssh/id_test 2>&1; cat ~/.config/secrets/vault.store 2>&1; ls ~/.ssh 2>&1; true");
  assert.doesNotMatch(r.tail, /PRIVATE KEY|VAULT/, "contents never leak");
  assert.match(r.tail, /\.ssh\/id_test: Operation not permitted/);
  assert.match(r.tail, /vault\.store: Operation not permitted/);
  assert.match(r.tail, /ls: .*\.ssh: Operation not permitted/, "not even listable");
});

test("network: localhost TCP allowed, unix sockets denied", { skip }, async (t) => {
  const tcp = createServer((c) => c.end("pong\n"));
  await new Promise((res) => tcp.listen(0, "127.0.0.1", res));
  const sock = join(project, "s.sock");
  const unix = createServer((c) => c.end("unix-pong\n"));
  await new Promise((res) => unix.listen(sock, res));
  t.after(() => { tcp.close(); unix.close(); });

  const port = tcp.address().port;
  const r = await run(`/usr/bin/nc -w 2 127.0.0.1 ${port} </dev/null; /usr/bin/nc -w 2 -U ${sock} </dev/null 2>&1 || echo unix-denied`);
  assert.match(r.tail, /pong/);
  assert.doesNotMatch(r.tail, /unix-pong/);
  assert.match(r.tail, /unix-denied/);
});

test("the generated profile denies network and writes by default", { skip }, async () => {
  const r = await run("true");
  const profile = readFileSync(r.logPath.replace(/\.log$/, ".sb"), "utf-8");
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.ok(profile.includes(`(subpath "${project}")`));
  assert.ok(profile.includes(`(subpath "${join(env.home, ".ssh")}")`));
});

test("exit codes and the log (header + footer, flushed on return)", { skip }, async () => {
  const r = await run("echo to-log; exit 3");
  assert.equal(r.exitCode, 3);
  const log = readFileSync(r.logPath, "utf-8");
  assert.match(log, /^# toolshelf run \S+ \(sandbox\)\n# cwd: .*\n# tools: fake 25\.0\.1\n# command: echo to-log; exit 3\n/);
  assert.match(log, /to-log/);
  assert.match(log, /\n# exit: 3 after \d+ ms\n$/);
});

test("timeout kills the whole process group, and no later command starts", { skip }, async () => {
  const started = Date.now();
  // Regression: zsh used to run `echo never` after its foreground sleep got TERM.
  const r = await run("sleep 30 & sleep 30; echo never; touch ran-after-timeout", { timeoutSec: 1 });
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!existsSync(join(project, "ran-after-timeout")), "a command after the timeout ran");
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "returned soon after the timeout");
  assert.doesNotMatch(r.tail, /never/);
  assert.match(readFileSync(r.logPath, "utf-8"), /# exit: \S+ \(timed out\)/);
});

test("output is cut to the last tailChars, starting at a whole line", { skip }, async () => {
  const r = await run("for i in $(seq 1 5000); do echo line-$i; done", { tailChars: 1024 });
  assert.equal(r.truncated, true);
  assert.ok(r.tail.length <= 1024);
  assert.match(r.tail, /^line-\d+\n/);
  assert.match(r.tail, /line-5000\n$/);
  assert.match(readFileSync(r.logPath, "utf-8"), /line-1\n/, "the log keeps everything");
});

test("refuses unapproved tools and non-projects before running anything", { skip }, async () => {
  await assert.rejects(run("true", { tools: { fake: "3.0" } }), /not approved/);
  await assert.rejects(run("true", { cwd: env.home }), /must be a project folder/);
});
