import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

const exec = promisify(execFile);

export class PlannotatorRuntime {
  constructor(options) {
    this.binary = options.binary || "plannotator";
    this.dataDir = options.dataDir;
    this.virtualAddress = options.virtualAddress;
    this.extraEnv = options.env || {};
  }

  env() {
    return {
      ...process.env,
      PLANNOTATOR_DATA_DIR: this.dataDir,
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_MACHINE_NAME: "Pi Relay",
      ...this.extraEnv
    };
  }

  async run(args, options = {}) {
    return exec(this.binary, args, { env: this.env(), timeout: options.timeout || 30_000, maxBuffer: 4 * 1024 * 1024 });
  }

  async start() {
    await this.run(["inbox", "--background"]);
    const { stdout } = await this.run(["inbox", "status", "--json"]);
    let status;
    try {
      status = JSON.parse(stdout);
      this.url = new URL(status.url);
      const healthResponse = await fetch(new URL("/api/inbox/health", this.url), { signal: AbortSignal.timeout(10_000) });
      if (!healthResponse.ok) throw new Error("Plannotator health check failed");
      this.serverSession = (await healthResponse.json()).serverSession;
    } catch {
      throw new Error("Plannotator returned an invalid status response");
    }
    return this;
  }

  async link(code) {
    const id = new URLSearchParams(code.split("?")[1]).get("id");
    if (id) {
      const { stdout } = await this.run(["inbox", "link", "--list"]);
      if (stdout.includes(id)) return;
    }
    await this.run(["inbox", "link", code, "--address", this.virtualAddress, "--one-way"], { timeout: 45_000 });
  }

  async stop() {
    await this.run(["inbox", "stop"]).catch(() => undefined);
  }

  proxy(request, response) {
    if (!this.url) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Plannotator is not ready" }));
      return;
    }
    const target = new URL(request.url, this.url);
    const headers = { ...request.headers, host: target.host, "accept-encoding": "identity" };
    const acceptsGzip = /\bgzip\b/.test(String(request.headers["accept-encoding"] || ""));
    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
      "x-real-ip",
      "tailscale-user-login",
      "tailscale-user-name",
      "tailscale-user-profile-pic",
      "tailscale-headers-info",
      "tailscale-funnel-request"
    ]) delete headers[name];
    if (headers.origin) headers.origin = this.url.origin;
    if (headers.referer) headers.referer = this.url.origin;
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: request.method, headers }, (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers["content-type"] || "");
      const compressible = /^(application\/(json|javascript)|text\/(?!event-stream)|image\/svg\+xml)/.test(contentType);
      if (acceptsGzip && compressible && !upstreamResponse.headers["content-encoding"] && !upstreamResponse.headers.range) {
        const responseHeaders = { ...upstreamResponse.headers, "content-encoding": "gzip", vary: [upstreamResponse.headers.vary, "Accept-Encoding"].filter(Boolean).join(", ") };
        delete responseHeaders["content-length"];
        delete responseHeaders.etag;
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(createGzip()).pipe(response);
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
    request.pipe(upstream);
  }
}
