import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

export class HostLaunchCoordinator {
  constructor({ store, agents, sessionAgents }) {
    this.store = store;
    this.agents = agents;
    this.sessionAgents = sessionAgents;
    this.pending = new Map();
    this.requests = new Map();
    this.idempotency = new Map();
    this.waiters = new Map();
    this.capable = new WeakSet();
  }

  async hello(host, message, socket) {
    const agents = Array.isArray(message.launch?.agents) ? message.launch.agents.filter((agent) => agent === "pi") : [];
    if (agents.length) this.capable.add(socket);
    else this.capable.delete(socket);
    host.launch = agents.length ? { agents, home: typeof message.launch.home === "string" ? message.launch.home : "/" } : null;
    await this.store.persist();
  }

  async closed(host, socket) {
    if (!this.capable.has(socket)) return;
    const capable = [...(this.agents.get(host.id) || [])].some((candidate) => this.capable.has(candidate) && candidate.readyState === WebSocket.OPEN);
    if (!capable && host.launch) {
      host.launch = null;
      await this.store.persist();
    }
  }

  result(message) {
    const request = this.requests.get(message.requestId);
    if (!request) return;
    this.requests.delete(message.requestId);
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message);
    else request.reject(new Error(message.error || "Launch failed"));
  }

  hasPending(hostId, sessionId) {
    return [...this.pending.values()].some((launch) => launch.hostId === hostId && launch.sessionId === sessionId);
  }

  async onSessionUpsert(session) {
    const pending = [...this.pending.values()].find((launch) => launch.hostId === session.hostId && launch.sessionId === session.sessionId);
    if (pending) {
      await this.store.updateVirtualSession(session.key, { launch: pending.launch, launchStoppedAt: null });
      this.pending.delete(pending.launch.id);
    }
    const waiters = this.waiters.get(session.key);
    if (!waiters) return;
    this.waiters.delete(session.key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(session);
    }
  }

  requestHost(hostId, message) {
    const socket = [...(this.agents.get(hostId) || [])].find((candidate) => this.capable.has(candidate) && candidate.readyState === WebSocket.OPEN);
    if (!socket) return Promise.reject(new Error("Host is offline"));
    const waiter = deferred();
    const timeout = setTimeout(() => {
      this.requests.delete(message.requestId);
      waiter.reject(new Error("Launch request timed out"));
    }, 15_000);
    timeout.unref();
    this.requests.set(message.requestId, { ...waiter, timeout });
    socket.send(JSON.stringify(message));
    return waiter.promise;
  }

  waitForSession(key) {
    const waiter = deferred();
    const waiters = this.waiters.get(key) || new Set();
    const record = { ...waiter, timeout: undefined };
    waiters.add(record);
    this.waiters.set(key, waiters);
    record.timeout = setTimeout(() => {
      waiters.delete(record);
      if (!waiters.size) this.waiters.delete(key);
      waiter.reject(new Error("Launched session did not connect"));
    }, 15_000);
    record.timeout.unref();
    return waiter.promise;
  }

  async start({ machine, project, body }) {
    const key = body.idempotency_key;
    const existing = this.idempotency.get(key);
    if (existing) return { ...await existing, replayed: true };
    const promise = this.performStart({ machine, project, body });
    this.idempotency.set(key, promise);
    if (this.idempotency.size > 256) this.idempotency.delete(this.idempotency.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      this.idempotency.delete(key);
      throw error;
    }
  }

  async performStart({ machine, project, body }) {
    const hostId = machine.hostId;
    const sessionId = randomUUID();
    const launch = {
      id: `lch_${randomUUID()}`,
      agent: "pi",
      session_ref: sessionId,
      session: sessionId,
      folder: project.root,
      scratch: false,
      started_at: new Date().toISOString()
    };
    const pending = { hostId, sessionId, launch, cwd: project.root, name: body.thread_name || project.name };
    this.pending.set(launch.id, pending);
    const registered = this.waitForSession(`${hostId}:${sessionId}`);
    registered.catch(() => undefined);
    try {
      await this.requestHost(hostId, { type: "launch_start", requestId: randomUUID(), launchId: launch.id, sessionId, cwd: pending.cwd, name: pending.name });
      const session = await registered;
      return { session, launch, replayed: false };
    } catch (error) {
      this.pending.delete(launch.id);
      throw error;
    }
  }

  async stop(session) {
    const launch = session.launch;
    await this.requestHost(session.hostId, { type: "launch_stop", requestId: randomUUID(), launchId: launch.id, sessionId: session.sessionId });
    await this.store.updateVirtualSession(session.key, { launchStoppedAt: new Date().toISOString() });
    return launch;
  }

  async ensureOnline(session) {
    if (!session?.launch) return;
    if (!session.launchStoppedAt && session.online && this.sessionAgents.has(session.key)) return;
    if (this.hasPending(session.hostId, session.sessionId)) return this.waitForSession(session.key);
    const pending = { hostId: session.hostId, sessionId: session.sessionId, launch: session.launch, cwd: session.launch.folder, name: session.name };
    this.pending.set(session.launch.id, pending);
    const registered = this.waitForSession(session.key);
    registered.catch(() => undefined);
    try {
      await this.requestHost(session.hostId, { type: "launch_start", requestId: randomUUID(), launchId: session.launch.id, sessionId: session.sessionId, cwd: pending.cwd, name: pending.name });
      await registered;
    } catch (error) {
      this.pending.delete(session.launch.id);
      throw error;
    }
  }
}
