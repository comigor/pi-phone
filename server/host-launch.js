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
    this.deleting = new Map();
    this.waiters = new Map();
    this.capable = new WeakSet();
    this.creationCapable = new WeakSet();
    this.skillsCapable = new WeakSet();
  }

  async hello(host, message, socket) {
    const agents = Array.isArray(message.launch?.agents) ? message.launch.agents.filter((agent) => agent === "pi") : [];
    if (agents.length) this.capable.add(socket);
    else this.capable.delete(socket);
    if (agents.length && message.launch.creation === 1) this.creationCapable.add(socket);
    else this.creationCapable.delete(socket);
    if (message.skills === 1) this.skillsCapable.add(socket);
    else this.skillsCapable.delete(socket);
    host.skills = message.skills === 1 ? 1 : 0;
    host.launch = agents.length ? { agents, home: typeof message.launch.home === "string" ? message.launch.home : "/", creation: message.launch.creation === 1 ? 1 : 0 } : null;
    await this.store.persist();
  }

  async closed(host, socket) {
    if (!this.capable.has(socket)) return;
    const open = [...(this.agents.get(host.id) || [])].filter((candidate) => candidate.readyState === WebSocket.OPEN);
    const capable = open.some((candidate) => this.capable.has(candidate));
    const creation = open.some((candidate) => this.creationCapable.has(candidate));
    const skills = open.some((candidate) => this.skillsCapable.has(candidate));
    host.skills = skills ? 1 : 0;
    if (!capable && host.launch) host.launch = null;
    else if (host.launch) host.launch = { ...host.launch, creation: creation ? 1 : 0 };
    await this.store.persist();
  }

  result(message) {
    const request = this.requests.get(message.requestId);
    if (!request) return;
    this.requests.delete(message.requestId);
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message);
    else {
      const error = new Error(message.error || "Launch failed");
      error.code = message.code;
      request.reject(error);
    }
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

  requestHost(hostId, message, { timeoutMs = 15_000, creation = false, skills = false } = {}) {
    const socket = [...(this.agents.get(hostId) || [])].find((candidate) => this.capable.has(candidate) && (!creation || this.creationCapable.has(candidate)) && (!skills || this.skillsCapable.has(candidate)) && candidate.readyState === WebSocket.OPEN);
    if (!socket) return Promise.reject(new Error(creation ? "Host launch creation is unavailable" : skills ? "Host skills are unavailable" : "Host is offline"));
    const waiter = deferred();
    const timeout = setTimeout(() => {
      this.requests.delete(message.requestId);
      waiter.reject(new Error("Launch request timed out"));
    }, timeoutMs);
    timeout.unref();
    this.requests.set(message.requestId, { ...waiter, timeout });
    socket.send(JSON.stringify(message));
    return waiter.promise;
  }

  async listSkills(hostId) {
    const result = await this.requestHost(hostId, { type: "skill_list", requestId: randomUUID() }, { skills: true });
    return result.skills;
  }

  async readSkillContent(hostId, name) {
    const result = await this.requestHost(hostId, { type: "skill_content", requestId: randomUUID(), name }, { skills: true });
    return result.skill;
  }

  async listFolders(hostId, path) {
    const result = await this.requestHost(hostId, { type: "folder_list", requestId: randomUUID(), path }, { creation: true });
    return result.listing;
  }

  async cloneCheck(hostId, url) {
    const result = await this.requestHost(hostId, { type: "clone_check", requestId: randomUUID(), url }, { creation: true, timeoutMs: 12_000 });
    return { reach: result.reach };
  }

  async cloneTarget(hostId, url, into) {
    const result = await this.requestHost(hostId, { type: "clone_target", requestId: randomUUID(), url, ...(into ? { into } : {}) }, { creation: true });
    return result.target;
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
    const scopedKey = `${machine.hostId}:${body.idempotency_key}`;
    const existing = this.idempotency.get(scopedKey);
    if (existing) return { ...await existing, replayed: true };
    const persisted = this.store.getLaunchIdempotency(machine.hostId, body.idempotency_key);
    if (persisted) {
      const session = this.store.getSession(persisted.sessionKey);
      if (session?.launch?.id === persisted.launchId) return { session, launch: session.launch, replayed: true };
    }
    const promise = this.performStart({ machine, project, body });
    this.idempotency.set(scopedKey, promise);
    if (this.idempotency.size > 256) this.idempotency.delete(this.idempotency.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      this.idempotency.delete(scopedKey);
      throw error;
    }
  }

  async performStart({ machine, project, body }) {
    const hostId = machine.hostId;
    const target = body.to.launch;
    const sessionId = randomUUID();
    let folder = project.root;
    let scratch = target.scratch === true;
    let arbitrary = false;
    let clone;
    let cloneUrl;
    const creation = scratch || typeof target.folder === "string";
    if (scratch) folder = "";
    else if (typeof target.folder === "string") {
      arbitrary = true;
      if (target.clone && typeof target.clone === "object") {
        const checked = await this.cloneTarget(hostId, target.clone.url, target.folder);
        folder = checked.real;
        cloneUrl = checked.repo.url;
        arbitrary = checked.state === "already";
        if (checked.state === "clone") clone = { url: checked.repo.url, ...(checked.repo.branch ? { branch: checked.repo.branch } : {}) };
      }
    }
    const launch = {
      id: `lch_${randomUUID()}`,
      agent: "pi",
      session_ref: sessionId,
      session: sessionId,
      folder,
      scratch,
      ...(target.create === true ? { made_folder: true } : {}),
      ...(cloneUrl ? { clone: { url: cloneUrl, state: "cloned" } } : {}),
      started_at: new Date().toISOString()
    };
    const pending = { hostId, sessionId, launch, cwd: folder, name: body.thread_name || project.name };
    this.pending.set(launch.id, pending);
    const registered = this.waitForSession(`${hostId}:${sessionId}`);
    registered.catch(() => undefined);
    try {
      const started = await this.requestHost(hostId, {
        type: "launch_start", requestId: randomUUID(), launchId: launch.id, sessionId,
        cwd: pending.cwd, name: pending.name, arbitrary, create: target.create === true, scratch, ...(clone ? { clone } : {})
      }, { creation, timeoutMs: clone ? 120_000 : 15_000 });
      launch.folder = started.cwd || folder;
      launch.scratch = started.scratch === true || scratch;
      if (started.clone) launch.clone = started.clone;
      pending.cwd = launch.folder;
      const session = await registered;
      await this.store.updateVirtualSession(session.key, { launch, launchStoppedAt: null });
      await this.store.recordLaunchIdempotency({ hostId, key: body.idempotency_key, sessionKey: session.key, launchId: launch.id });
      return { session, launch, replayed: false };
    } catch (error) {
      this.pending.delete(launch.id);
      throw error;
    }
  }

  async stop(session) {
    const launch = session.launch;
    if (launch.deleted_at) return launch;
    await this.requestHost(session.hostId, { type: "launch_stop", requestId: randomUUID(), launchId: launch.id, sessionId: session.sessionId });
    await this.store.updateVirtualSession(session.key, { launchStoppedAt: new Date().toISOString() });
    return launch;
  }

  async retry(session) {
    if (session.launch.deleted_at) throw Object.assign(new Error("That launch was deleted."), { code: "launch_not_found" });
    if (session.online && !session.launchStoppedAt && !session.launch.error) throw Object.assign(new Error("That launch did not fail."), { code: "validation_error" });
    await this.store.updateVirtualSession(session.key, { launch: { ...session.launch, error: null } });
    await this.ensureOnline(session);
    return session.launch;
  }

  async trust(session) {
    if (session.launch.deleted_at) throw Object.assign(new Error("That launch was deleted."), { code: "launch_not_found" });
    const retry = session.launch.untrusted === true;
    await this.store.updateVirtualSession(session.key, { launch: { ...session.launch, trusted_at: new Date().toISOString(), untrusted: false, error: null } });
    if (retry) await this.ensureOnline(session);
    return session.launch;
  }

  async delete(session) {
    if (session.launch.deleted_at) return {};
    const existing = this.deleting.get(session.launch.id);
    if (existing) return existing;
    const promise = (async () => {
      const result = await this.requestHost(session.hostId, { type: "launch_delete", requestId: randomUUID(), launchId: session.launch.id, sessionId: session.sessionId, cwd: session.launch.folder, scratch: session.launch.scratch === true });
      const launch = { ...session.launch, deleted_at: new Date().toISOString() };
      await this.store.updateVirtualSession(session.key, { launch, launchStoppedAt: new Date().toISOString() });
      return session.launch.scratch ? { scratch_removed: result.scratch_removed } : {};
    })();
    this.deleting.set(session.launch.id, promise);
    try {
      return await promise;
    } finally {
      this.deleting.delete(session.launch.id);
    }
  }

  async ensureOnline(session) {
    if (!session?.launch) return;
    if (session.launch.deleted_at) throw Object.assign(new Error("That launch was deleted."), { code: "launch_not_found" });
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
