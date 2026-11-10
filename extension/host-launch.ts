import { spawn, type ChildProcess } from "node:child_process";

export interface HostLaunchOptions {
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class HostLauncher {
  private children = new Map<string, ChildProcess>();
  private options: HostLaunchOptions;

  constructor(options: HostLaunchOptions = {}) {
    this.options = options;
  }

  async start(sessionId: string, cwd: string, name: string): Promise<void> {
    if (this.children.has(sessionId)) return;
    const child = spawn(this.options.command || process.env.PI_INBOX_LAUNCH_COMMAND || "pi-bolt", [
      ...(this.options.prefixArgs || []),
      "--mode", "rpc",
      "--session-id", sessionId,
      "--name", name
    ], {
      cwd,
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

  async close(): Promise<void> {
    await Promise.all([...this.children.keys()].map((sessionId) => this.stop(sessionId)));
  }
}
