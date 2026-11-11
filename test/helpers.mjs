// Test fixture: a throwaway $HOME with its own manifest, components, blocklist
// and state, so tests never read or write the real ones.
//
// Call setupHome() BEFORE importing anything from dist/: paths and the
// components root are read from the environment when a module loads. Each
// test file runs in its own process (node --test), so the env stays per-file.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

export const DIGEST = "a".repeat(64);
export const PINNED = `example/img:1@sha256:${DIGEST}`;

export const MANIFEST = `# test manifest
@tool fake  dir=Fake check=fake home=FAKE_HOME
fake 1.2.3 default
fake 1.2.10
fake 2.0.0-rc-1
fake 25.0.1
@tool other dir=Other root=libexec|. bin=sbin|bin check=other
other 1.0 default docker=${PINNED}
@tool ghost dir=Ghost check=ghost
ghost 9.9 default
@image fwd alpine/socat:1@sha256:${"b".repeat(64)}
`;

export const BLOCKLIST = `# test blocklist
(^|[;&|(\\s])brew\\s+install ## Homebrew changes system tools
npm\\s+(i|install)\\s+(-g|--global) ## global package installs
`;

export const AGENTS_MD = "# Test rules\n\n1. Do the test thing.\n2. Do not do the other thing.\n";

/** Write a file, creating parent dirs. */
export function put(path, content = "", mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
}

/**
 * Create the fake home and point the env at it. Installs on disk:
 *   Fake 1.2.3, 1.2.10, 25.0.1 (2.0.0-rc-1 is approved but missing), and an
 *   unlisted 3.0 folder; Other 1.0 with the libexec/sbin layout. Ghost: nothing.
 */
export function setupHome({ manifest = MANIFEST, blocklist = BLOCKLIST } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "toolshelf-test-")));
  const components = join(home, "Components");
  const fakeBin = (v) =>
    put(join(components, "Fake", v, "bin", "fake"), `#!/bin/sh\necho "fake ${v} $*"\n`, 0o755);
  for (const v of ["1.2.3", "1.2.10", "25.0.1", "3.0"]) fakeBin(v);
  put(join(components, "Other", "1.0", "libexec", "sbin", "other"), "#!/bin/sh\necho other\n", 0o755);

  put(join(home, ".config", "components", "components.conf"), manifest);
  put(join(home, ".config", "agents", "blocklist.txt"), blocklist);
  put(join(home, ".config", "agents", "AGENTS.md"), AGENTS_MD);

  Object.assign(process.env, {
    HOME: home,
    COMPONENTS: components,
    COMPONENTS_MANIFEST: join(home, ".config", "components", "components.conf"),
    TOOLSHELF_BLOCKLIST: join(home, ".config", "agents", "blocklist.txt"),
    TOOLSHELF_STATE: join(home, ".local", "state", "toolshelf"),
    TOOLSHELF_CACHE: join(home, ".cache", "toolshelf"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TOOLSHELF_PROXY: "http://127.0.0.1:3128",
  });
  return {
    home,
    components,
    manifestPath: process.env.COMPONENTS_MANIFEST,
    state: process.env.TOOLSHELF_STATE,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A project folder under the fake home: ~/Projects/<name> with a marker. */
export function makeProject(home, name = "app", marker = "package.json") {
  const dir = join(home, "Projects", name);
  put(join(dir, marker), marker === "package.json" ? "{}\n" : "");
  return dir;
}

/** Running inside toolshelf's own sandbox: sandbox-exec can't nest there. */
export const IN_SANDBOX = Boolean(process.env.TOOLSHELF_SANDBOX);
