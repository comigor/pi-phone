import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cloneRepository, cloneTarget, listFolders, parseGitRepo, prepareFolder } from "../extension/host-folders.js";
import { HostLauncher } from "../extension/host-launch.ts";

const exec = promisify(execFile);

test("host folder browsing and creation preserve official path boundaries", async (t) => {
  const home = await mkdtemp(path.join(os.homedir(), "pi-inbox-folders-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "Projects"));
  await mkdir(path.join(home, ".private"));

  const root = await listFolders(home, "~");
  assert.equal(root.path, "~");
  assert.equal(root.exists, true);
  assert.equal(root.start, false);
  assert.deepEqual(root.folders, ["Projects"]);
  assert.equal(root.writable, true);

  const projects = await listFolders(home, "~/Projects");
  assert.equal(projects.start, undefined);
  assert.equal(projects.path, "~/Projects");

  const missing = await listFolders(home, "~/Projects/new-client");
  assert.equal(missing.exists, false);
  assert.equal(missing.state, "missing");
  assert.equal(missing.nearest.path, "~/Projects");

  const created = await prepareFolder(home, "~/Projects/new-client", true);
  assert.equal(created, await (await import("node:fs/promises")).realpath(path.join(home, "Projects", "new-client")));
  await access(created);
  await assert.rejects(prepareFolder(home, "~/Projects/a/b", true), (error) => error.code === "folder_missing");
  await assert.rejects(listFolders(home, "~/.private"), (error) => error.code === "hidden");
  await assert.rejects(listFolders(home, "Projects"), (error) => error.code === "outside");
  await assert.rejects(listFolders(home, "/etc"), (error) => error.code === "system");
});

test("Git URLs and clone destinations are safe and reusable", async (t) => {
  const home = await mkdtemp(path.join(os.homedir(), "pi-inbox-clone-target-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const into = path.join(home, "Projects");
  await mkdir(into);
  assert.deepEqual(parseGitRepo("github.com/acme/widget/tree/main"), {
    host: "github.com", slug: "acme/widget", repo: "widget", url: "https://github.com/acme/widget.git", branch: "main"
  });
  assert.deepEqual(parseGitRepo("https://github.com/acme/widget/issues/12"), {
    host: "github.com", slug: "acme/widget", repo: "widget", url: "https://github.com/acme/widget.git"
  });
  assert.deepEqual(parseGitRepo("https://gitlab.com/acme/tools/widget/-/tree/main"), {
    host: "gitlab.com", slug: "acme/tools/widget", repo: "widget", url: "https://gitlab.com/acme/tools/widget.git", branch: "main"
  });
  assert.equal(parseGitRepo("https://github.com/acme/-evil.git"), null);
  assert.equal(parseGitRepo("file:///tmp/repository"), null);

  const target = await cloneTarget(home, "https://github.com/acme/widget.git", "~/Projects");
  assert.equal(target.path, "~/Projects/widget");
  assert.equal(target.state, "clone");
  assert.equal(target.name, "widget");
  assert.equal(target.intoReal, into);

  await mkdir(target.real);
  await exec("git", ["init", "--quiet", target.real]);
  await exec("git", ["-C", target.real, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  const already = await cloneTarget(home, "https://github.com/acme/widget.git", "~/Projects");
  assert.equal(already.state, "already");
  assert.equal(already.real, target.real);
  const other = await cloneTarget(home, "https://github.com/acme/other.git", "~/Projects");
  assert.equal(other.path, "~/Projects/other");
});

test("real git clone creates the requested checkout", async (t) => {
  const home = await mkdtemp(path.join(os.homedir(), "pi-inbox-real-clone-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = path.join(home, "source");
  const target = path.join(home, "checkout");
  await mkdir(source);
  await exec("git", ["init", "--quiet", source]);
  await exec("git", ["-C", source, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", source, "config", "user.name", "Pi Inbox Test"]);
  await writeFile(path.join(source, "README.md"), "real clone\n");
  await exec("git", ["-C", source, "add", "README.md"]);
  await exec("git", ["-C", source, "commit", "--quiet", "-m", "initial"]);
  await cloneRepository({ host: "local", slug: "local/source", repo: "source", url: source }, target);
  assert.equal(await readFile(path.join(target, "README.md"), "utf8"), "real clone\n");
});

test("host launcher creates one-level folders and scratch directories", async (t) => {
  const home = await mkdtemp(path.join(os.homedir(), "pi-inbox-prepare-"));
  const projects = path.join(home, "Projects");
  await mkdir(projects);
  const script = path.join(home, "fake-pi.mjs");
  const log = path.join(home, "launches.jsonl");
  await writeFile(script, `
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.FAKE_LAUNCH_LOG, JSON.stringify({ cwd: process.cwd() }) + "\\n");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    setInterval(() => {}, 1000).unref();
  `);
  const launcher = new HostLauncher({ command: process.execPath, prefixArgs: [script], env: { FAKE_LAUNCH_LOG: log }, home, scratchRoot: path.join(home, "scratch") });
  t.after(async () => {
    await launcher.close();
    await rm(home, { recursive: true, force: true });
  });
  await assert.rejects(launcher.start("home-session", home, "Home", { arbitrary: true }), (error) => error.code === "folder_unavailable");
  const created = await launcher.start("created-session", path.join(projects, "New Client"), "New Client", { arbitrary: true, create: true });
  await access(created.cwd);
  assert.equal(created.scratch, false);
  const scratch = await launcher.start("scratch-session", "", "Scratch investigation", { scratch: true });
  await access(scratch.cwd);
  assert.equal(scratch.scratch, true);
  assert.equal(path.basename(scratch.cwd), "scratch-investigation");
  const lines = await new Promise(async (resolve, reject) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const content = await readFile(log, "utf8");
        if (content.trim().split("\n").length === 2) return resolve(content);
      } catch {}
      if (Date.now() > deadline) return reject(new Error("launches not written"));
      await new Promise((done) => setTimeout(done, 25));
    }
  });
  const launches = lines.trim().split("\n").map(JSON.parse);
  assert.deepEqual(new Set(launches.map((launch) => launch.cwd)), new Set([created.cwd, scratch.cwd]));
});
