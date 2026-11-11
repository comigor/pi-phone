import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { realpath, rm } from "node:fs/promises";
import { cloneRepository, listFolders, makeScratch, parseGitRepo, prepareFolder, type GitRepo } from "./host-folders.js";

export interface HostLaunchOptions {
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  scratchRoot?: string;
}

export interface LaunchPreparation {
  arbitrary?: boolean;
  create?: boolean;
  scratch?: boolean;
  clone?: { url: string; branch?: string };
}
export class HostLauncher {
  private children = new Map<string, ChildProcess>();
  private options: HostLaunchOptions;
  private home: string;
  private scratchRoot: string;

  constructor(options: HostLaunchOptions = {}) {
    this.options = options;
    this.home = options.home || os.homedir();
    this.scratchRoot = options.scratchRoot || path.join(this.home, ".pi", "agent", "pi-inbox", "scratch");
  }
  async start(sessionId: string, cwd: string, name: string, preparation: LaunchPreparation = {}): Promise<{ cwd: string; scratch: boolean; clone?: { url: string; state: "cloned" } }> {
    if (this.children.has(sessionId)) return { cwd, scratch: preparation.scratch === true };
    let folder = cwd;
    let cloned: { url: string; state: "cloned" } | undefined;
    if (preparation.scratch) folder = await makeScratch(this.scratchRoot, name);
    else if (preparation.clone) {
      const repo = parseGitRepo(preparation.clone.url);
      if (!repo) throw Object.assign(new Error("Not a git repo's URL."), { code: "validation_error" });
      if (preparation.clone.branch && repo.branch !== preparation.clone.branch) repo.branch = preparation.clone.branch;
      const parent = await prepareFolder(this.home, path.dirname(cwd), false);
      folder = path.join(parent, path.basename(cwd));
      await cloneRepository(repo as GitRepo, folder);
      cloned = { url: repo.url, state: "cloned" };
    } else if (preparation.arbitrary || preparation.create) {
      folder = await prepareFolder(this.home, cwd, preparation.create === true);
      const listing = await listFolders(this.home, folder);
      if (listing.start === false) throw Object.assign(new Error(`Pick a folder inside ${listing.path}. Nothing was sent.`), { code: "folder_unavailable" });
    }
    const child = spawn(this.options.command || process.env.PI_INBOX_LAUNCH_COMMAND || "pi-bolt", [
      ...(this.options.prefixArgs || []),
      "--mode", "rpc",
      "--session-id", sessionId,
      "--name", name
    ], {
      cwd: folder,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "ignore", "pipe"]
    });
    this.children.set(sessionId, child);
    child.once("exit", () => this.children.delete(sessionId));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.children.delete(sessionId);
        reject(error);
      });
    });
    return { cwd: folder, scratch: preparation.scratch === true, ...(cloned ? { clone: cloned } : {}) };
  }

  async stop(sessionId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child) return;
    this.children.delete(sessionId);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  async delete(sessionId: string, folder: string, scratch: boolean): Promise<{ scratch_removed: boolean }> {
    await this.stop(sessionId);
    if (!scratch) return { scratch_removed: false };
    try {
      const root = await realpath(this.scratchRoot);
      const candidate = await realpath(folder);
      if (path.dirname(candidate) !== root) return { scratch_removed: false };
      await rm(candidate, { recursive: true, force: false });
      return { scratch_removed: true };
    } catch {
      return { scratch_removed: false };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.children.keys()].map((sessionId) => this.stop(sessionId)));
  }
}
