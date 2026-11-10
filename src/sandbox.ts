import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import { envFor, findTool, locate, versionsOf, type Manifest } from "./components.js";
import { CACHE_ROOT, HOME, STATE_ROOT } from "./paths.js";

// ---------------------------------------------------------------------------
// Sandbox mode for `run`: macOS sandbox-exec with a generated profile.
//   writes  — project dir + sandbox-only caches (CACHE_ROOT) + a private tmp
//   network — localhost only, which includes the zero-trust proxy
//   reads   — everything except secrets and private app data
//   env     — minimal: approved component paths, proxy, cache locations
// ---------------------------------------------------------------------------

export class RunError extends Error {}

export interface RunRequest {
  tools: Record<string, string>;
  command: string;
  cwd: string;
  timeoutSec: number;
  /** Characters of output returned (the full log is always on disk) */
  tailChars: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  tail: string;
  truncated: boolean;
  logPath: string;
  selected: { tool: string; version: string }[];
}

// Default output returned to the agent: ~8 KB (≈2k tokens). The full log is on disk.
export const DEFAULT_TAIL_KB = 8;

// Under $HOME, never usable as a project dir (or inside one of these).
const FORBIDDEN_PROJECT_ROOTS = [
  ".ssh", ".gnupg", ".aws", ".config", ".local", ".cache", ".claude", ".docker",
  "Library", "Components", "Applications",
];

// A project dir (or a parent) must contain one of these.
const PROJECT_MARKERS = [
  ".git", ".toolshelf", ".toolsrc", "package.json", "pom.xml", "build.gradle",
  "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "build.xml",
  "Cargo.toml", "go.mod", "pyproject.toml", "Makefile",
];

// Never readable from a run: credentials, history, private app data.
const SECRET_PATHS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud",
  ".config/secrets", ".config/gh", ".config/docker", ".config/npm",
  ".config/claude-personal", ".claude", ".claude.json", ".netrc", ".git-credentials",
  ".npmrc", ".m2/settings.xml", ".m2/settings-security.xml",
  ".local/share/gradle/gradle.properties", ".local/share/cargo/credentials.toml",
  ".zshcache", ".zsh_history", ".bash_history", "Library",
];

// ---------------------------------------------------------------------------
// Project dir
// ---------------------------------------------------------------------------

/** Resolve and validate the project dir: a real dir at least two levels under $HOME. */
export function validateProject(cwd: string): string {
  const expanded = cwd === "~" ? HOME : cwd.startsWith("~/") ? join(HOME, cwd.slice(2)) : cwd;
  let dir: string;
  try {
    dir = realpathSync(expanded);
  } catch {
    throw new RunError(`cwd does not exist: ${cwd}`);
  }
  if (!statSync(dir).isDirectory()) throw new RunError(`cwd is not a directory: ${dir}`);

  const rel = relative(HOME, dir);
  if (rel.startsWith("..") || rel === "" || rel.startsWith(sep)) {
    throw new RunError(`cwd must be a project folder inside ${HOME}, got ${dir}`);
  }
  const parts = rel.split(sep);
  if (parts.length < 2) {
    throw new RunError(`cwd is too broad (${dir}); use the project folder itself`);
  }
  if (FORBIDDEN_PROJECT_ROOTS.includes(parts[0])) {
    throw new RunError(`cwd ${dir} is inside ~/${parts[0]}, which is never a project folder`);
  }
  // A folder of projects (e.g. ~/Projects/Personal) is not a project: require a
  // marker in cwd or a parent, looking no higher than two levels below $HOME.
  for (let n = parts.length; n >= 2; n--) {
    const candidate = join(HOME, ...parts.slice(0, n));
    if (PROJECT_MARKERS.some((m) => existsSync(join(candidate, m)))) return dir;
  }
  throw new RunError(
    `${dir} doesn't look like a project (none of ${PROJECT_MARKERS.join(", ")} in it or a ` +
      `parent). Use the project folder itself; add an empty .toolshelf file to mark anything else.`,
  );
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

interface Proxy {
  url: string;
  host: string;
  port: string;
}

function proxyFromEnv(): Proxy {
  const raw =
    process.env.TOOLSHELF_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY ||
    "http://127.0.0.1:3128";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RunError(`invalid proxy URL: ${raw}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new RunError(`proxy must be on localhost for the sandbox, got ${raw}`);
  }
  return { url: `http://${u.hostname}:${u.port || "80"}`, host: u.hostname, port: u.port || "80" };
}

// ---------------------------------------------------------------------------
// Sandbox-only caches, configured to go through the proxy
// ---------------------------------------------------------------------------

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  writeFileSync(path, content);
}

function prepareCaches(m: Manifest, proxy: Proxy) {
  const dirs = {
    m2: join(CACHE_ROOT, "m2"),
    gradle: join(CACHE_ROOT, "gradle"),
    npm: join(CACHE_ROOT, "npm"),
    cargo: join(CACHE_ROOT, "cargo"),
    gopath: join(CACHE_ROOT, "go"),
    gocache: join(CACHE_ROOT, "go-build"),
    tmp: join(CACHE_ROOT, "tmp"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs.m2, "repository"), { recursive: true });

  // Maven: proxy + sandbox local repo (Maven ignores JVM proxy properties)
  writeIfChanged(
    join(dirs.m2, "settings.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by toolshelf-mcp for sandboxed runs. Do not edit. -->
<settings>
  <localRepository>${join(dirs.m2, "repository")}</localRepository>
  <proxies>
    <proxy><id>zt-https</id><active>true</active><protocol>https</protocol>
      <host>${proxy.host}</host><port>${proxy.port}</port><nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy>
    <proxy><id>zt-http</id><active>true</active><protocol>http</protocol>
      <host>${proxy.host}</host><port>${proxy.port}</port><nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy>
  </proxies>
</settings>
`,
  );

  // Gradle: proxy, no daemon (a daemon would outlive this run's sandbox),
  // toolchains limited to approved JDKs
  const jdk = findTool(m, "jdk");
  const jdkHomes = jdk
    ? versionsOf(m, jdk)
        .map((v) => locate(jdk, v.version))
        .flatMap((l) => ("problem" in l ? [] : [l.home]))
    : [];
  writeIfChanged(
    join(dirs.gradle, "gradle.properties"),
    [
      "# Generated by toolshelf-mcp for sandboxed runs. Do not edit.",
      "org.gradle.daemon=false",
      "kotlin.compiler.execution.strategy=in-process",
      "org.gradle.java.installations.auto-download=false",
      "org.gradle.java.installations.auto-detect=false",
      `org.gradle.java.installations.paths=${jdkHomes.join(",")}`,
      ...["http", "https"].flatMap((p) => [
        `systemProp.${p}.proxyHost=${proxy.host}`,
        `systemProp.${p}.proxyPort=${proxy.port}`,
        `systemProp.${p}.nonProxyHosts=localhost|127.0.0.1`,
      ]),
      "",
    ].join("\n"),
  );

  return dirs;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function buildEnv(
  m: Manifest,
  tools: Record<string, string>,
  proxy: Proxy,
  caches: ReturnType<typeof prepareCaches>,
  tmp: string,
) {
  const comp = envFor(m, tools);
  const env: Record<string, string> = {
    HOME,
    USER: process.env.USER || "",
    LOGNAME: process.env.LOGNAME || process.env.USER || "",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    TMPDIR: tmp,
    PATH: [...comp.path, ...SYSTEM_PATH].join(":"),
    // proxy (curl, npm, cargo, go honour these)
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    no_proxy: "localhost,127.0.0.1,::1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    // caches
    GRADLE_USER_HOME: caches.gradle,
    MAVEN_ARGS: `-s ${join(caches.m2, "settings.xml")}`,
    // Java on macOS ignores TMPDIR (uses the per-user /var/folders temp, which
    // the sandbox doesn't allow); point Maven's and Gradle's JVMs at our tmp.
    MAVEN_OPTS: `-Djava.io.tmpdir=${tmp}`,
    GRADLE_OPTS: `-Djava.io.tmpdir=${tmp}`,
    npm_config_cache: caches.npm,
    npm_config_userconfig: "/dev/null",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    CARGO_HOME: caches.cargo,
    CARGO_HTTP_PROXY: proxy.url,
    GOPATH: caches.gopath,
    GOCACHE: caches.gocache,
    GOFLAGS: "-modcacherw",
    GOTOOLCHAIN: "local",
    GOENV: "off",
    TOOLSHELF_SANDBOX: "1",
  };
  for (const [k, v] of comp.vars) env[k] = v;
  return { env, selected: comp.selected };
}

// ---------------------------------------------------------------------------
// Sandbox profile
// ---------------------------------------------------------------------------

const sbq = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function buildProfile(project: string): string {
  const secrets = SECRET_PATHS.map((p) => join(HOME, p));
  return `(version 1)
; Generated by toolshelf-mcp for one sandboxed run.
(allow default)

; Writes: the project, sandbox-only caches (incl. this run's tmp), device files
(deny file-write*)
(allow file-write*
  (subpath ${sbq(project)})
  (subpath ${sbq(CACHE_ROOT)})
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")
  (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))

; Reads: never credentials, shell history or private app data
(deny file-read*
${secrets.map((p) => `  (subpath ${sbq(p)})`).join("\n")})

; Network: localhost only — the zero-trust proxy and local test servers.
; No DNS, no direct internet, no unix sockets (e.g. the Docker socket).
(deny network*)
(allow network* (remote ip "localhost:*") (local ip "localhost:*"))
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function runSandboxed(m: Manifest, req: RunRequest): Promise<RunResult> {
  const project = validateProject(req.cwd);
  const proxy = proxyFromEnv();
  const caches = prepareCaches(m, proxy);
  const tmp = mkdtempSync(join(caches.tmp, "run-"));
  const { env, selected } = buildEnv(m, req.tools, proxy, caches, tmp);

  const runsDir = join(STATE_ROOT, "runs");
  mkdirSync(runsDir, { recursive: true });
  const id = runId();
  const profilePath = join(runsDir, `${id}.sb`);
  const logPath = join(runsDir, `${id}.log`);
  writeFileSync(profilePath, buildProfile(project));

  const log = createWriteStream(logPath);
  log.write(
    `# toolshelf run ${id}\n# cwd: ${project}\n# tools: ${
      selected.map((s) => `${s.tool} ${s.version}`).join(", ") || "(none)"
    }\n# command: ${req.command}\n\n`,
  );

  const started = Date.now();
  let tail = "";
  let truncated = false;
  let timedOut = false;

  const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, "/bin/zsh", "-f", "-c", req.command], {
    cwd: project,
    env,
    detached: true, // own process group, so a timeout kills the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onData = (chunk: Buffer) => {
    log.write(chunk);
    tail += chunk.toString("utf-8");
    if (tail.length > req.tailChars * 2) {
      tail = tail.slice(-req.tailChars);
      truncated = true;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
  }, req.timeoutSec * 1000);

  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, sig) => resolve([code, sig]));
  }).finally(() => clearTimeout(timer));

  const durationMs = Date.now() - started;
  log.end(`\n# exit: ${exitCode ?? signal}${timedOut ? " (timed out)" : ""} after ${durationMs} ms\n`);
  rmSync(tmp, { recursive: true, force: true });

  if (tail.length > req.tailChars) {
    tail = tail.slice(-req.tailChars);
    truncated = true;
  }
  // Start at a whole line when the cut landed mid-line
  if (truncated) {
    const nl = tail.indexOf("\n");
    if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
  }
  return { exitCode, signal, timedOut, durationMs, tail, truncated, logPath, selected };
}
