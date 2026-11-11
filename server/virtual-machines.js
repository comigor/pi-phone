import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paginateSearchAnswer, searchVirtualSessions } from "./search.js";
import { isVisibleMessage } from "./visible-messages.js";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const ID_CACHE = new Map();

function id(prefix, ...parts) {
  const key = `${prefix}\0${parts.join("\0")}`;
  const cached = ID_CACHE.get(key);
  if (cached) return cached;
  const digest = createHash("sha256").update(parts.join("\0")).digest();
  let value = "";
  for (let index = 0; index < 26; index++) value += ID_ALPHABET[digest[index] & 31];
  const result = `${prefix}_${value}`;
  if (ID_CACHE.size >= 50_000) ID_CACHE.clear();
  ID_CACHE.set(key, result);
  return result;
}

function activityAt(session) {
  return session.visibleUpdatedAt || session.updatedAt;
}

function hasThreadContent(session) {
  return Boolean(session.messages?.some(isVisibleMessage) || session.remoteReplies?.length);
}
function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function sendSerialized(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function sendBytes(response, status, bytes, contentType) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "no-store",
    "content-security-policy": "sandbox",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

async function bodyJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request too large");
  }
  try {
    const value = body ? JSON.parse(body) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function bodyBytes(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new Error("upload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sniffMimeType(data, fallback) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return fallback || "application/octet-stream";
}

function projectFor(session) {
  return {
    id: id("prj", session.cwd || session.key),
    name: session.name || path.basename(session.cwd || "") || session.sessionId,
    root: session.cwd || "/"
  };
}

function messageId(session, message, index) {
  return id("msg", session.key, message.id || `message-${index}`);
}

function attachmentFor(session, message, attachment, index, messageIndex = index) {
  const data = attachment.data ? Buffer.from(attachment.data, "base64") : Buffer.alloc(0);
  const mimeType = sniffMimeType(data, attachment.mimeType || attachment.mime_type);
  const name = attachment.name || `image-${index + 1}.png`;
  const sha256 = createHash("sha256").update(data).digest("hex");
  const sentAt = message.createdAt || session.updatedAt;
  return {
    id: id("att", session.key, message.id, attachment.name || `image-${index}`, index),
    path: attachment.path || name,
    named_path: attachment.named_path || null,
    name,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    size: data.length,
    data,
    mimeType,
    media_type: mimeType,
    sent_sha256: sha256,
    sent_at: sentAt,
    sent_mtime: sentAt,
    message_id: messageId(session, message, messageIndex),
    current: { sha256, size: data.length, mtime: sentAt },
    changed_since_sent: false,
    unavailable: null
  };
}

function matchesPersistedReply(message, reply) {
  if (message.role !== "user" || typeof message.text !== "string") return false;
  if (message.text === reply.text) return true;
  const attachments = reply.attachments || [];
  if (!attachments.length) return false;
  const expectedImages = attachments.filter((item) => item.mimeType?.startsWith("image/"));
  const expectedFiles = attachments.length - expectedImages.length;
  const textMatches = (expectedImages.length > 0 && message.text.startsWith(`${reply.text}\n\n[Image:`)) ||
    (expectedFiles > 0 && message.text.startsWith(`${reply.text}\n\nAttached files:\n`));
  if (!textMatches) return false;
  const images = message.images || [];
  return images.length === expectedImages.length;
}

export class VirtualMachines {
  constructor(options) {
    this.store = options.store;
    this.deliverReply = options.deliverReply;
    this.stopSession = options.stopSession;
    this.startLaunch = options.startLaunch;
    this.stopLaunch = options.stopLaunch;
    this.retryLaunch = options.retryLaunch;
    this.trustLaunch = options.trustLaunch;
    this.deleteLaunch = options.deleteLaunch;
    this.listFolders = options.listFolders;
    this.cloneCheck = options.cloneCheck;
    this.cloneTarget = options.cloneTarget;
    this.linkMachine = options.linkMachine;
    this.publicAddress = options.publicAddress;
    this.file = path.join(options.dataDir, "virtual-machines.json");
    this.uploadsDir = path.join(options.dataDir, "uploads");
    this.drafts = options.drafts;
    this.machines = new Map();
    this.streams = new Map();
    this.linkRetries = new Map();
    this.uploads = new Map();
    this.threadCache = new Map();
    this.messageCache = new WeakMap();
    this.changeBatches = new Map();
    this.writeQueue = Promise.resolve();
    this.batches = new Map();
    this.replyFlushes = new Map();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      for (const machine of saved.machines || []) this.machines.set(machine.hostId, machine);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(this.uploadsDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.uploadsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const upload = JSON.parse(await readFile(path.join(this.uploadsDir, name), "utf8"));
        this.uploads.set(upload.upload_id, { ...upload, data: Buffer.from(upload.data, "base64") });
      } catch {
      }
    }
  }

  persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => writeFile(this.file, JSON.stringify({ machines: [...this.machines.values()] }, null, 2), { mode: 0o600 }));
    return this.writeQueue;
  }

  persistUpload(upload) {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => writeFile(path.join(this.uploadsDir, `${upload.upload_id}.json`), JSON.stringify({ ...upload, data: upload.data.toString("base64") }), { mode: 0o600 }));
    return this.writeQueue;
  }

  offer(host) {
    let machine = this.machines.get(host.id);
    if (!machine) {
      machine = {
        hostId: host.id,
        inboxId: id("ibx", host.id),
        name: host.name || host.id,
        token: `tok_${randomBytes(32).toString("base64url")}`,
        cursor: 0
      };
      this.machines.set(host.id, machine);
    }
    machine.name = host.name || machine.name;
    if (!machine.secret || !machine.expiresAt || Date.parse(machine.expiresAt) < Date.now()) {
      machine.secret = randomBytes(24).toString("base64url");
      machine.code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
      machine.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    }
    const params = new URLSearchParams({ v: "1", id: machine.inboxId, name: machine.name, secret: machine.secret, code: machine.code });
    if (this.publicAddress) params.set("tailnet", this.publicAddress);
    return { machine, link: `plannotator://link?${params}` };
  }

  async ensureLinked(host) {
    const existing = this.machines.get(host.id);
    if (!this.linkMachine || !host.paired || !host.online || existing?.linkedAt) return Boolean(existing?.linkedAt);
    const offered = this.offer(host);
    await this.persist();
    try {
      await this.linkMachine(offered.link);
      offered.machine.linkedAt = new Date().toISOString();
      clearTimeout(this.linkRetries.get(host.id));
      this.linkRetries.delete(host.id);
      await this.persist();
      return true;
    } catch {
      if (!this.linkRetries.has(host.id)) {
        const retry = setTimeout(() => {
          this.linkRetries.delete(host.id);
          const current = this.store.getHost(host.id);
          if (current) void this.ensureLinked(current);
        }, 5_000);
        retry.unref();
        this.linkRetries.set(host.id, retry);
      }
      return false;
    }
  }

  async pair(request, response) {
    const body = await bodyJson(request);
    if (body.platform !== "machine") return send(response, 422, { code: "validation_error", error: "platform must be machine" });
    const machine = [...this.machines.values()].find((item) =>
      (body.secret && item.secret === body.secret) || (body.code && item.code === body.code)
    );
    if (!machine || Date.parse(machine.expiresAt) < Date.now()) return send(response, 403, { code: "pairing_code_wrong", error: "Pairing code expired or invalid" });
    machine.secret = undefined;
    machine.code = undefined;
    machine.expiresAt = undefined;
    await this.persist();
    return send(response, 201, { token: machine.token, computer: { name: machine.name } });
  }

  authenticated(request) {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    return [...this.machines.values()].find((machine) => machine.token === token);
  }

  sessions(machine) {
    return this.store.state.sessions.filter((session) => session.hostId === machine.hostId && hasThreadContent(session));
  }

  hasProject(projectId) {
    return this.store.state.sessions.some((session) => hasThreadContent(session) && projectFor(session).id === projectId);
  }

  search(machine, url, paginate = true) {
    const answer = searchVirtualSessions(this.sessions(machine), url.searchParams, {
      projectFor,
      row: (session) => this.row(session),
      messagesFor: (session) => this.messagesFor(session)
    });
    return paginate ? paginateSearchAnswer(answer, url.searchParams) : answer;
  }

  searchAll(url) {
    return [...this.machines.values()].map((machine) => this.search(machine, url, false));
  }

  notificationTarget(item) {
    const session = this.store.getSession(item.sessionKey);
    const machine = this.machines.get(item.hostId);
    if (!session || !machine) return null;
    const messages = this.sourceMessagesFor(session);
    let assistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") {
        assistantIndex = index;
        break;
      }
    }
    return {
      machine: machine.inboxId,
      thread: id("msg", session.key),
      message: assistantIndex >= 0 ? messageId(session, messages[assistantIndex], assistantIndex) : null
    };
  }

  listAll() {
    return [...this.machines.values()].map((machine) => ({ machine: machine.inboxId, model: this.list(machine) }));
  }

  session(machine, threadId) {
    return this.sessions(machine).find((session) => id("msg", session.key) === threadId);
  }

  findThread(threadId, machineId) {
    return this.store.state.sessions.find((session) => hasThreadContent(session) && id("msg", session.key) === threadId && (!machineId || this.machines.get(session.hostId)?.inboxId === machineId));
  }

  virtualMessage(session, message, index) {
    const project = projectFor(session);
    const mid = messageId(session, message, index);
    const attachments = (message.attachments || message.images || []).map((item, attachmentIndex) => attachmentFor(session, message, item, attachmentIndex, index));
    return {
      id: mid,
      project_id: project.id,
      thread_id: id("msg", session.key),
      reply_to: null,
      author: message.role === "user"
        ? { kind: "person" }
        : { kind: "agent", host: "pi", session: session.sessionId, name: "Pi" },
      subject: message.role === "user" ? null : (session.name || "Pi session"),
      subject_question: null,
      body: message.text || (attachments.length ? `![${attachments[0].name}](${attachments[0].name})` : ""),
      created_at: message.createdAt || session.updatedAt,
      resolved_at: session.resolvedAt || null,
      idempotency_key: message.requestId || null,
      thread_name: null,
      base_path: session.cwd,
      seq: index + 1,
      ...(index === 0 ? { person_seen_seq: session.seenThroughSeq ?? null } : {}),
      ...(index === 0 && session.launch ? { launch: session.launch } : {}),
      ack: session.acks?.[mid] || null,
      ...(attachments.length ? { attachments: attachments.map(({ data: _data, mimeType, ...attachment }) => ({ ...attachment, mime_type: mimeType })) } : {})
    };
  }

  cachedVirtualMessage(session, message, index) {
    const mid = messageId(session, message, index);
    const key = JSON.stringify([mid, index, session.sessionId, session.name, session.cwd, session.resolvedAt, message.createdAt || session.updatedAt, session.acks?.[mid] || null, index === 0 ? session.seenThroughSeq ?? null : null]);
    const cached = this.messageCache.get(message);
    if (cached?.key === key) return cached.value;
    const value = this.virtualMessage(session, message, index);
    this.messageCache.set(message, { key, value });
    return value;
  }

  controlMessage(session) {
    const running = session.status === "running" || session.status === "waiting";
    return {
      id: id("msg", session.key, "stop-control"),
      project_id: projectFor(session).id,
      thread_id: id("msg", session.key),
      reply_to: null,
      author: { kind: "agent", host: "pi", session: session.sessionId, name: "Pi" },
      subject: "Session controls",
      body: running ? ":::question\nThe agent is running.\n\n- [ ] Stop agent\n:::" : "The agent is idle.",
      created_at: activityAt(session),
      resolved_at: null,
      idempotency_key: null,
      thread_name: null,
      base_path: session.cwd,
      seq: 0,
      questions: [{ key: "q-stop", q: "The agent is running.", state: running ? "open" : "closed", choices: [{ label: "Stop agent" }], answer: running ? null : "Stop agent" }]
    };
  }

  sourceMessagesFor(session) {
    const unmatchedReplies = [...(session.remoteReplies || [])];
    const messages = session.messages.filter(isVisibleMessage).map((message) => {
      const index = unmatchedReplies.findIndex((reply) => matchesPersistedReply(message, reply));
      return index >= 0 ? unmatchedReplies.splice(index, 1)[0] : message;
    });
    messages.push(...unmatchedReplies);
    return messages;
  }

  messagesFor(session) {
    const messages = this.sourceMessagesFor(session);
    const result = messages.map((message, index) => this.cachedVirtualMessage(session, message, index));
    if (session.status === "running" || session.status === "waiting" || session.stopRequestedAt) result.push(this.controlMessage(session));
    return result;
  }

  lastMessage(session, messages = this.sourceMessagesFor(session)) {
    if (session.status === "running" || session.status === "waiting" || session.stopRequestedAt) return this.controlMessage(session);
    const last = messages.at(-1);
    return last ? this.cachedVirtualMessage(session, last, messages.length - 1) : this.controlMessage(session);
  }

  lookBoundary(session, messages = this.sourceMessagesFor(session)) {
    let boundary = session.seenThroughSeq ?? 0;
    for (const [index, message] of messages.entries()) {
      if (message.role === "user") boundary = Math.max(boundary, index + 1);
    }
    return boundary;
  }

  unseenCount(session, messages = this.sourceMessagesFor(session)) {
    const boundary = this.lookBoundary(session, messages);
    return messages.filter((message, index) => message.role !== "user" && index + 1 > boundary).length;
  }

  row(session) {
    const project = projectFor(session);
    const sourceMessages = this.sourceMessagesFor(session);
    const last = this.lastMessage(session, sourceMessages);
    const messageCount = sourceMessages.length + (session.status === "running" || session.status === "waiting" || session.stopRequestedAt ? 1 : 0);
    const waiting = session.status !== "running";
    const unseen = this.unseenCount(session, sourceMessages);
    return {
      thread_id: id("msg", session.key),
      project_id: project.id,
      subject: session.name || project.name,
      author: { kind: "agent", host: "pi", session: session.sessionId, name: "Pi" },
      created_at: session.createdAt || session.updatedAt,
      last_at: activityAt(session),
      last_author: last?.author.kind || "agent",
      message_count: messageCount,
      resolved_at: session.resolvedAt || null,
      questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
      waiting_on_person: waiting,
      unsent: null,
      delivery: null,
      agent_after_archive: Boolean(session.agentAfterArchive),
      back_from_archive: Boolean(session.backFromArchive),
      read_at: session.readAt || null,
      ack: null,
      project: { id: project.id, name: project.name },
      thread_name: null,
      answered_not_sent: false,
      reask_pending: false,
      waiting_since: waiting ? activityAt(session) : null,
      unseen,
      sent: null,
      guide: false,
      last_agent_at: activityAt(session),
      section: waiting ? "waiting" : "sent",
      unread: !session.readAt || unseen > 0
    };
  }

  run(session) {
    if (!session.launch || session.launch.deleted_at) return null;
    const stopped = Boolean(session.launchStoppedAt) || !session.online;
    const failed = Boolean(session.launch.error);
    return {
      state: failed ? "failed" : stopped ? "stopped" : session.status === "running" ? "working" : "waiting_answer",
      launch_id: session.launch.id,
      agent: "pi",
      project: projectFor(session).name,
      folder: session.launch.folder,
      since: session.launchStoppedAt || activityAt(session),
      again: failed || stopped,
      stopped_by_person: Boolean(session.launchStoppedAt),
      cause: session.launch.error?.text || null,
      untrusted: session.launch.untrusted === true,
      attach_command: null
    };
  }

  thread(session) {
    const project = projectFor(session);
    return {
      serverSession: id("srv", session.hostId),
      cursor: session.virtualCursor || 0,
      thread: {
        thread_id: id("msg", session.key),
        project: { ...project, key: project.id, created_at: session.createdAt || session.updatedAt, repo: null },
        subject: session.name || project.name,
        thread_name: null,
        resolved_at: session.resolvedAt || null,
        messages: this.messagesFor(session),
        archive_seq: null
      },
      row: this.row(session),
      run: this.run(session)
    };
  }

  projectRows(sessions) {
    const projects = new Map();
    for (const session of sessions) {
      const project = projectFor(session);
      const current = projects.get(project.id) || { ...project, key: project.id, created_at: session.createdAt || session.updatedAt, threads: 0, unread: 0, listed: 0, archived: 0 };
      current.threads += 1;
      if (session.resolvedAt) current.archived += 1;
      else {
        current.listed += 1;
        if (!session.readAt) current.unread += 1;
      }
      projects.set(project.id, current);
    }
    return [...projects.values()];
  }

  archived(machine, url, paginate = true) {
    const project = url.searchParams.get("project") || null;
    const archived = this.sessions(machine).filter((session) => session.resolvedAt && (!project || projectFor(session).id === project));
    const rows = archived.map((session) => ({ ...this.row(session), machine: machine.inboxId })).sort((left, right) => right.last_at.localeCompare(left.last_at));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    return {
      serverSession: id("srv", machine.hostId), cursor: machine.cursor || 0, project,
      projects: this.projectRows(this.sessions(machine).filter((session) => session.resolvedAt)).map((item) => ({ id: item.id, name: item.name, archived: item.archived })),
      total: rows.length, offset, limit, threads: paginate ? rows.slice(offset, offset + limit) : rows
    };
  }

  archivedAll(url) {
    return [...this.machines.values()].map((machine) => this.archived(machine, url, false));
  }

  pinnedSessions(hostId) {
    return this.store.state.sessions.filter((session) => hasThreadContent(session) && session.pinnedAt && (!hostId || session.hostId === hostId)).sort((left, right) =>
      (left.pinOrder ?? Number.MAX_SAFE_INTEGER) - (right.pinOrder ?? Number.MAX_SAFE_INTEGER) || left.pinnedAt.localeCompare(right.pinnedAt)
    );
  }

  pinEntries(hostId) {
    return this.pinnedSessions(hostId).map((session) => ({ thread_id: id("msg", session.key), pinned_at: session.pinnedAt }));
  }
  async setPin(session, pinned, restore) {
    await this.store.updateVirtualSession(session.key, {
      pinnedAt: pinned ? restore?.pinned_at || session.pinnedAt || new Date().toISOString() : null,
      pinOrder: pinned ? restore?.index ?? session.pinOrder ?? null : null
    });
    await this.changed(session, { thread_id: id("msg", session.key) }, "pins");
  }

  async orderPins(order) {
    const position = new Map(order.map((threadId, index) => [threadId, index]));
    for (const session of this.pinnedSessions()) {
      const threadId = id("msg", session.key);
      const pinOrder = position.has(threadId) ? position.get(threadId) : order.length + (session.pinOrder ?? 0);
      if (session.pinOrder === pinOrder) continue;
      await this.store.updateVirtualSession(session.key, { pinOrder });
      await this.changed(session, { thread_id: threadId }, "pins");
    }
  }


  list(machine) {
    const all = this.sessions(machine);
    const visible = all.filter((session) => !session.resolvedAt);
    const snoozed = visible.filter((session) => Date.parse(session.snoozedUntil) > Date.now()).sort((left, right) => left.snoozedUntil.localeCompare(right.snoozedUntil));
    const rows = visible.filter((session) => !(Date.parse(session.snoozedUntil) > Date.now())).map((session) => this.row(session));
    const projects = this.projectRows(all);
    const section = (sectionId, label) => ({ id: sectionId, label, threads: rows.filter((row) => row.section === sectionId) });
    return {
      serverSession: id("srv", machine.hostId),
      version: "0.28.48",
      cursor: machine.cursor || 0,
      projects,
      project: null,
      sections: [
        { id: "stopped", label: "Stopped on you", threads: [] },
        { id: "holding", label: "Holding up work", threads: [] },
        section("waiting", "Waiting on you"),
        { id: "new", label: "New since you looked", threads: [] },
        section("sent", "Sent"),
        section("quiet", "Quiet")
      ],
      snoozes: true,
      snoozed: snoozed.map((session) => this.row(session)),
      pins: this.pinnedSessions(machine.hostId).map((session) => ({ ...this.row(session), machine: machine.inboxId, pinned_at: session.pinnedAt }))
    };
  }

  liveSession(session) {
    return {
      session: session.sessionId,
      host: "pi",
      started_at: session.createdAt || session.updatedAt,
      last_seen_at: session.updatedAt,
      busy: session.status === "running",
      idle_since: session.status === "running" ? null : session.updatedAt,
      wrote_thread: true,
      send_now: true,
      last_thread: { id: id("msg", session.key), subject: session.name, at: session.updatedAt }
    };
  }

  taggable(session) {
    const project = projectFor(session);
    const owner = { host: "pi", session: session.sessionId };
    return {
      serverSession: id("srv", session.hostId),
      owner,
      sessions: [{
        session: session.sessionId, host: "pi", kind: "live", name: null,
        project: { id: project.id, name: project.name, root: project.root },
        started_at: session.createdAt || session.updatedAt, last_at: session.updatedAt,
        busy: session.status === "running", idle_since: session.status === "running" ? null : session.updatedAt,
        taggable: true, owner: true, wrote_thread: true
      }]
    };
  }

  launchProjects(machine) {
    return [...new Map(this.sessions(machine).map((session) => {
      const project = projectFor(session);
      return [project.root, { id: project.id, name: project.name, root: project.root, exists: true }];
    })).values()];
  }

  sessionList(machine, threadId) {
    const sessions = this.sessions(machine).filter((session) => session.online && (!threadId || session.key === threadId));
    const projects = [...new Map(sessions.map((session) => {
      const project = projectFor(session);
      return [project.id, { project, sessions: [this.liveSession(session)] }];
    })).values()];
    const host = this.store.getHost(machine.hostId);
    const launch = host?.online && host.launch ? {
      agents: [{ agent: "pi", name: "Pi" }], projects: this.launchProjects(machine), not_ready: []
    } : undefined;
    return { serverSession: id("srv", machine.hostId), machine: machine.inboxId, home: host?.launch?.home || "/", projects, ...(launch ? { launch } : {}) };
  }

  findByMessage(machine, messageIdValue) {
    for (const session of this.sessions(machine)) {
      if (this.messagesFor(session).some((message) => message.id === messageIdValue)) return session;
    }
    return undefined;
  }

  messageById(session, messageIdValue) {
    return this.messagesFor(session).find((message) => message.id === messageIdValue);
  }

  pendingAnnotations(session) {
    return (session.messageAnnotations || []).filter((record) => !record.sent_reply_id && !record.removed_at);
  }

  persistedAttachments(session) {
    const messages = [...session.messages, ...(session.remoteReplies || [])];
    return messages.flatMap((message, messageIndex) => (message.attachments || message.images || []).map((item, index) => attachmentFor(session, message, item, index, messageIndex)));
  }

  attachmentsModel(session) {
    const attachments = [...new Map(this.persistedAttachments(session).map((attachment) => [attachment.id, attachment])).values()];
    return {
      attachments: attachments.map(({ data: _data, mimeType, ...attachment }) => ({ ...attachment, mime_type: mimeType })),
      annotations: this.pendingAnnotations(session)
    };
  }

  async saveAnnotation(machine, messageIdValue, body, response) {
    requireKey(body.idempotency_key);
    const session = this.findByMessage(machine, messageIdValue);
    const target = session && this.messageById(session, messageIdValue);
    if (!session || !target) return send(response, 404, { code: "message_not_found" });
    const input = body.annotation;
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.id) ||
      typeof input.text !== "string" || !input.text.trim() || input.text.length > 10_000 || input.type === "DELETION" ||
      (!input.diagramAnchor && (typeof input.originalText !== "string" || !input.originalText.trim() || input.originalText.length > 20_000))) {
      return send(response, 422, { code: "validation_error", error: "A message comment needs an id, quote, and text" });
    }
    if (target.author.kind !== "agent") return send(response, 422, { code: "annotation_not_allowed", error: "Comments are allowed on agent messages" });
    session.messageAnnotations ??= [];
    const previous = session.messageAnnotations.find((record) => record.id === input.id);
    if (previous?.sent_reply_id || previous?.removed_at) return send(response, 409, { code: "annotation_closed", error: "This comment is already closed" });
    const record = {
      id: input.id,
      message_id: messageIdValue,
      thread_id: id("msg", session.key),
      attachment_id: "",
      path: messageIdValue,
      version: "current",
      message: { at: target.created_at },
      annotation: { ...input, text: input.text.trim() },
      sent_reply_id: null,
      created_at: previous?.created_at || new Date().toISOString()
    };
    if (previous) Object.assign(previous, record);
    else session.messageAnnotations.push(record);
    await this.store.persist();
    const saved = previous || record;
    await this.changed(session, { annotation: saved });
    return send(response, 200, { annotation: saved });
  }

  async removeAnnotation(machine, annotationId, response) {
    for (const session of this.sessions(machine)) {
      const record = (session.messageAnnotations || []).find((item) => item.id === annotationId);
      if (!record) continue;
      if (record.sent_reply_id || record.removed_at) return send(response, 409, { code: "annotation_closed", error: "This comment is already closed" });
      record.removed_at = new Date().toISOString();
      await this.store.persist();
      await this.changed(session, { annotation: record });
      return send(response, 200, { annotation: record });
    }
    return send(response, 404, { code: "annotation_not_found" });
  }

  async acknowledge(machine, messageIdValue, body, response) {
    const key = requireKey(body.idempotency_key);
    const session = this.findByMessage(machine, messageIdValue);
    if (!session) return send(response, 404, { code: "message_not_found" });
    session.acks ??= {};
    if (body.ack === false) {
      delete session.acks[messageIdValue];
      await this.store.persist();
      await this.changed(session, { message: this.messageById(session, messageIdValue) });
      return send(response, 200, { message: this.messageById(session, messageIdValue) });
    }
    const reaction = body.reaction || body.ack_reaction || {};
    const ack = {
      emoji: typeof reaction.emoji === "string" ? reaction.emoji : "👍",
      label: typeof reaction.label === "string" ? reaction.label : "Looks good",
      settled_seq: null,
      delivered_at: null
    };
    session.acks[messageIdValue] = ack;
    await this.store.persist();
    await this.changed(session, { message: this.messageById(session, messageIdValue) });
    await this.deliverReply({
      key: session.key, generation: session.generation, requestId: key, attachments: [],
      text: `The person reacted ${ack.emoji}${ack.label ? ` ${ack.label}` : ""} to your message (${messageIdValue}).`
    });
    ack.settled_seq = session.virtualCursor || 0;
    ack.delivered_at = new Date().toISOString();
    await this.store.persist();
    const message = this.messageById(session, messageIdValue);
    await this.changed(session, { message });
    return send(response, 200, { message });
  }

  changed(session, record, event = "record") {
    this.threadCache.delete(session.key);
    const machine = this.machines.get(session.hostId);
    if (!machine) return Promise.resolve();
    const existing = this.changeBatches.get(session.hostId);
    if (existing) {
      existing.session = session;
      existing.record = record;
      existing.event = event;
      return existing.promise;
    }
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    const batch = { session, record, event, promise, resolve, reject, timer: undefined };
    batch.timer = setTimeout(() => this.flushChange(session.hostId), 25);
    this.changeBatches.set(session.hostId, batch);
    return promise;
  }

  async flushChange(hostId) {
    const batch = this.changeBatches.get(hostId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.changeBatches.delete(hostId);
    const machine = this.machines.get(hostId);
    if (!machine) return batch.resolve();
    try {
      machine.cursor = (machine.cursor || 0) + 1;
      await this.persist();
      const data = JSON.stringify(batch.record || { message: this.lastMessage(batch.session) });
      for (const stream of this.streams.get(hostId) || []) {
        if (!stream.destroyed && !stream.writableEnded) stream.write(`id: ${machine.cursor}\nevent: ${batch.event}\ndata: ${data}\n\n`);
      }
      batch.resolve();
    } catch (error) {
      batch.reject(error);
    }
  }

  async flushChanges() {
    await Promise.all([...this.changeBatches.keys()].map((hostId) => this.flushChange(hostId)));
  }

  async hostOffline(hostId) {
    await this.flushChange(hostId);
    for (const stream of this.streams.get(hostId) || []) stream.end();
    this.streams.delete(hostId);
  }

  events(machine, request, response) {
    if (!this.store.getHost(machine.hostId)?.online) return send(response, 503, { code: "machine_offline", error: "Host is offline" });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(`event: hello\ndata: {"cursor":${machine.cursor || 0}}\n\n`);
    const streams = this.streams.get(machine.hostId) || new Set();
    streams.add(response);
    this.streams.set(machine.hostId, streams);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
    });
  }


  creationHost(machine, request, response) {
    if (request.headers["x-plannotator-window"] !== "1") {
      send(response, 403, { code: "window_only", error: "Folder operations require the Inbox window" });
      return null;
    }
    const host = this.store.getHost(machine.hostId);
    if (!host?.online) {
      send(response, 503, { code: "machine_offline", error: "Host is offline" });
      return null;
    }
    if (host.launch?.creation !== 1) {
      send(response, 409, { code: "agent_unavailable", error: "Host launch creation is unavailable" });
      return null;
    }
    return host;
  }

  async creationResult(response, operation) {
    try {
      return send(response, 200, await operation());
    } catch (error) {
      const refused = ["hidden", "system", "outside"].includes(error.code);
      const validation = refused || ["validation_error", "folder_missing", "folder_unavailable"].includes(error.code);
      return send(response, validation ? 422 : 502, { code: refused ? "validation_error" : error.code || "host_operation_failed", error: error.message });
    }
  }

  async launchMessage(machine, body, request, response) {
    if (request.headers["x-plannotator-window"] !== "1") return send(response, 403, { code: "window_only", error: "Launching an agent requires the Inbox window" });
    const to = body.to?.launch;
    const existingProject = typeof to?.project_id === "string";
    const scratch = to?.scratch === true;
    const folder = typeof to?.folder === "string" && to.folder.trim() ? to.folder.trim() : null;
    if (!to || to.agent !== "pi" || (!existingProject && !scratch && !folder) || typeof body.body !== "string" || !body.body.trim()) {
      return send(response, 422, { code: "validation_error", error: "Launch needs a Pi agent, a project or folder, and a message" });
    }
    if (to.clone && (!folder || typeof to.clone.url !== "string" || !to.clone.url.trim())) return send(response, 422, { code: "validation_error", error: "Clone needs a repository URL and destination folder" });
    if (Array.isArray(body.uploads) && body.uploads.length) return send(response, 422, { code: "validation_error", error: "Attachments are not supported when launching" });
    let project;
    if (existingProject) project = this.launchProjects(machine).find((candidate) => candidate.id === to.project_id);
    else {
      if (!this.creationHost(machine, request, response)) return;
      project = { id: "", name: body.thread_name || (scratch ? "Scratch" : path.basename(folder)), root: folder || "" };
    }
    if (!project) return send(response, 422, { code: "project_not_found", error: "Project is not available on this host" });
    let started;
    try {
      started = await this.startLaunch({ machine, project, body });
    } catch (error) {
      const refused = ["hidden", "system", "outside"].includes(error.code);
      if (refused || ["validation_error", "folder_missing", "folder_unavailable"].includes(error.code)) return send(response, 422, { code: refused ? "validation_error" : error.code, error: error.message });
      throw error;
    }
    const { session, launch } = started;
    const key = requireKey(body.idempotency_key);
    let previous = (session.remoteReplies || []).find((message) => message.requestId === key);
    if (!previous) {
      await this.deliverReply({ key: session.key, generation: session.generation, requestId: key, text: body.body.trim(), attachments: [] });
      previous = (await this.store.appendRemoteReply(session.key, { requestId: key, text: body.body.trim(), attachments: [] })).message;
    }
    await this.changed(session);
    const reply = this.virtualMessage(session, previous, 0);
    return send(response, 200, {
      thread_id: id("msg", session.key), message: reply, project: projectFor(session), replayed: started.replayed,
      launch: { id: launch.id, state: "starting" }
    }, started.replayed ? { "idempotent-replayed": "true" } : {});
  }

  async reply(_machine, session, body, _request, response, compose = false) {
    const key = requireKey(body.idempotency_key);
    const words = compose ? body.body : body.words;
    const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
    const attachments = (body.uploads || []).map((uploadId) => this.uploads.get(uploadId)).filter(Boolean);
    if ((typeof words !== "string" && !feedback && attachments.length === 0) || (typeof words === "string" && !words.trim() && !feedback && attachments.length === 0)) {
      return send(response, 422, { code: "validation_error", error: "Message text, feedback, or an attachment is required" });
    }
    const combined = [typeof words === "string" ? words.trim() : "", feedback].filter(Boolean).join("\n\n");
    const text = combined || (attachments.every((attachment) => attachment.mimeType?.startsWith("image/")) ? "Image attached" : "Files attached");
    const previous = (session.remoteReplies || []).find((message) => message.requestId === key);
    if (previous) return send(response, 200, { reply: this.virtualMessage(session, previous, session.messages.length), replayed: true }, { "idempotent-replayed": "true" });
    const pending = {
      requestId: key,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment, data: attachment.data ? Buffer.from(attachment.data).toString("base64") : "" })),
      clearDraft: typeof body.clear_draft === "string" ? body.clear_draft : null,
      combined,
      uploadIds: Array.isArray(body.uploads) ? body.uploads : [],
      annotationIds: Array.isArray(body.annotation_ids) ? body.annotation_ids.filter((value) => typeof value === "string") : []
    };
    const queued = (session.pendingReplies || []).find((reply) => reply.requestId === key);
    if (queued) return send(response, 202, { outbox: { key, words: queued.combined, thread: session.name, state: "queued" } });
    try {
      await this.deliverReply({ key: session.key, generation: session.generation, requestId: key, text, attachments });
    } catch (error) {
      if (error.code !== "session_offline") throw error;
      await this.store.queueRemoteReply(session.key, pending);
      return send(response, 202, { outbox: { key, words: combined, thread: session.name, state: "queued" } });
    }
    await this.finishReply(session, pending);
    const reply = this.virtualMessage(session, session.remoteReplies.find((message) => message.requestId === key), session.messages.length);
    if (compose) return send(response, 200, { thread_id: id("msg", session.key), message: reply, project: projectFor(session), replayed: false });
    return send(response, 200, { reply });
  }

  async finishReply(session, pending) {
    if (session.resolvedAt) await this.store.updateVirtualSession(session.key, { resolvedAt: null, backFromArchive: false });
    const appended = await this.store.appendRemoteReply(session.key, pending);
    if (pending.clearDraft) await this.drafts.clearSent(id("msg", session.key), pending.clearDraft, pending.combined, pending.uploadIds);
    const reply = this.virtualMessage(session, appended.message, session.messages.length);
    const annotationIds = new Set(pending.annotationIds || []);
    for (const record of session.messageAnnotations || []) {
      if (annotationIds.has(record.id) && !record.removed_at) record.sent_reply_id = reply.id;
    }
    if (annotationIds.size) await this.store.persist();
    await this.changed(session);
  }

  async flushReplies(session) {
    if (!session.pendingReplies?.length) return;
    const existing = this.replyFlushes.get(session.key);
    if (existing) return existing;
    const flush = (async () => {
      while (session.pendingReplies?.length) {
        const pending = session.pendingReplies[0];
        await this.deliverReply({ key: session.key, generation: session.generation, requestId: pending.requestId, text: pending.text, attachments: pending.attachments || [] });
        await this.finishReply(session, pending);
        await this.store.completeRemoteReply(session.key, pending.requestId);
      }
    })().finally(() => this.replyFlushes.delete(session.key));
    this.replyFlushes.set(session.key, flush);
    return flush;
  }

  threadIds(value, field) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10_000 || !value.every((threadId) => typeof threadId === "string" && /^msg_[0-9A-HJKMNP-TV-Z]{26}$/.test(threadId))) {
      throw Object.assign(new Error(`${field}: a list of thread ids (msg_).`), { code: "validation_error" });
    }
    return value;
  }

  async markProjectSessionRead(session) {
    const latestSeq = Math.max(0, ...this.messagesFor(session).map((message) => message.seq || 0));
    await this.store.updateVirtualSession(session.key, {
      readAt: new Date().toISOString(),
      seenThroughSeq: latestSeq,
      seenBeforeRead: session.seenThroughSeq ?? 0
    });
    await this.changed(session, { row: this.row(session) });
  }

  async markProjectSessionUnread(session) {
    await this.store.updateVirtualSession(session.key, {
      readAt: null,
      seenThroughSeq: session.seenBeforeRead ?? 0,
      seenBeforeRead: null,
      backFromArchive: false
    });
    await this.changed(session, { row: this.row(session) });
  }

  async projectAction(machine, projectId, action, body, response) {
    try {
      const sessions = this.sessions(machine).filter((session) => projectFor(session).id === projectId);
      if (!sessions.length) return send(response, 404, { code: "project_not_found" });
      if (body.resolved !== undefined && typeof body.resolved !== "boolean") return send(response, 422, { code: "validation_error", error: "resolved must be a boolean" });
      const batchId = body.batch_id ?? body.idempotency_key ?? null;
      if (batchId !== null && (typeof batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(batchId))) return send(response, 422, { code: "validation_error", error: "batch_id: 1 to 128 letters, digits, _ or -" });
      const resolved = body.resolved !== false;
      const route = `${action}:${projectId}:${action === "resolve" ? String(resolved) : ""}`;
      const replayKey = batchId === null ? null : `${machine.hostId}:${batchId}`;
      if (replayKey) {
        const seen = this.batches.get(replayKey);
        if (seen && seen.route !== route) return send(response, 409, { code: "batch_id_reused", error: "This batch_id answered another request" });
        if (seen) return send(response, 200, { ...seen.answer, replayed: true }, { "idempotent-replayed": "true" });
      }
      const project = () => this.projectRows(sessions).find((item) => item.id === projectId) || null;
      let answer;
      if (action === "read") {
        const read = [];
        const looked = [];
        const affected = [];
        for (const session of sessions.filter((item) => !item.resolvedAt && this.row(item).waiting_on_person)) {
          const threadId = id("msg", session.key);
          affected.push(threadId);
          const latestSeq = Math.max(0, ...this.messagesFor(session).map((message) => message.seq || 0));
          if (session.readAt && (session.seenThroughSeq ?? 0) >= latestSeq) {
            looked.push(threadId);
            continue;
          }
          read.push(threadId);
          await this.markProjectSessionRead(session);
        }
        answer = { project: project(), batch: { read, looked }, threads: affected.map((threadId) => this.row(sessions.find((session) => id("msg", session.key) === threadId))) };
      } else if (action === "unread") {
        const named = [...this.threadIds(body.threads, "threads"), ...this.threadIds(body.looked, "looked")];
        const done = [];
        const skipped = [];
        for (const threadId of new Set(named)) {
          const session = sessions.find((item) => id("msg", item.key) === threadId);
          if (!session) {
            skipped.push(threadId);
            continue;
          }
          await this.markProjectSessionUnread(session);
          done.push(this.row(session));
        }
        answer = { project: project(), threads: done, skipped };
      } else if (resolved) {
        const resolvedIds = [];
        const read = [];
        for (const session of sessions.filter((item) => !item.resolvedAt)) {
          const threadId = id("msg", session.key);
          if (session.backFromArchive) {
            read.push(threadId);
            await this.markProjectSessionRead(session);
          } else {
            resolvedIds.push(threadId);
            await this.store.updateVirtualSession(session.key, { resolvedAt: new Date().toISOString(), backFromArchive: false });
            await this.changed(session, { row: this.row(session) });
          }
        }
        answer = { project: project(), batch: { resolved: resolvedIds, read }, threads: [...resolvedIds, ...read].map((threadId) => this.row(sessions.find((session) => id("msg", session.key) === threadId))) };
      } else {
        if (!body.threads || typeof body.threads !== "object" || Array.isArray(body.threads)) return send(response, 422, { code: "validation_error", error: "threads: { resolved: [ids], read: [ids] }" });
        const undoResolved = new Set(this.threadIds(body.threads.resolved, "threads.resolved"));
        const named = [...undoResolved, ...this.threadIds(body.threads.read, "threads.read")];
        const done = [];
        const skipped = [];
        for (const threadId of new Set(named)) {
          const session = sessions.find((item) => id("msg", item.key) === threadId);
          if (!session) {
            skipped.push(threadId);
            continue;
          }
          if (undoResolved.has(threadId)) {
            await this.store.updateVirtualSession(session.key, { resolvedAt: null, backFromArchive: false });
            await this.changed(session, { row: this.row(session) });
          } else await this.markProjectSessionUnread(session);
          done.push(this.row(session));
        }
        answer = { project: project(), threads: done, skipped };
      }
      if (replayKey) {
        this.batches.set(replayKey, { route, answer });
        if (this.batches.size > 50) this.batches.delete(this.batches.keys().next().value);
      }
      return send(response, 200, { ...answer, replayed: false });
    } catch (error) {
      if (error.code === "validation_error") return send(response, 422, { code: error.code, error: error.message });
      throw error;
    }
  }

  storeUsage() {
    return {
      dir: this.file ? path.dirname(this.file) : "",
      bytes: Buffer.byteLength(JSON.stringify(this.store.state)),
      projects: this.projectRows(this.store.state.sessions.filter(hasThreadContent)).length
    };
  }

  async deleteThread(machine, threadId, response) {
    const session = this.session(machine, threadId);
    if (!session) return send(response, 404, { code: "thread_not_found" });
    await this.drafts.delete(threadId);
    await this.store.deleteVirtualSession(session.key);
    this.threadCache.delete(session.key);
    await this.changed(session, { thread_id: threadId }, "deletions");
    return send(response, 200, { ok: true, store: this.storeUsage() });
  }
  async route(request, response) {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname.replace("/api/inbox/device/", "");
    if (route === "pair" && request.method === "POST") return this.pair(request, response);
    const machine = this.authenticated(request);
    if (!machine) return send(response, 401, { code: "device_token_invalid", error: "Unknown machine token" });
    if (route === "health") {
      const host = this.store.getHost(machine.hostId);
      if (!host?.online) return send(response, 503, { code: "machine_offline", error: "Host is offline" });
      return send(response, 200, { ok: true, inbox_id: machine.inboxId, machine_links: 1, version: "0.28.60", launch_from_machines: host.launch ? 1 : 0 });
    }
    if (route === "events") return this.events(machine, request, response);
    if (route === "threads" && request.method === "GET") return send(response, 200, this.list(machine));
    if (route === "projects" && request.method === "GET") return send(response, 200, { projects: this.list(machine).projects });
    if (route === "threads/archived" && request.method === "GET") return send(response, 200, this.archived(machine, url));
    if (route === "sessions" && request.method === "GET") return send(response, 200, this.sessionList(machine));
    if (route === "search" && request.method === "GET") return send(response, 200, { serverSession: id("srv", machine.hostId), ...this.search(machine, url) });
    if (route === "launch/folders") {
      if (request.method !== "GET") return send(response, 405, { error: "Use GET." });
      const host = this.creationHost(machine, request, response);
      if (!host) return;
      return this.creationResult(response, () => this.listFolders({ hostId: host.id, path: url.searchParams.get("path") || "~" }));
    }
    if (route === "launch/clone-check") {
      if (request.method !== "GET") return send(response, 405, { error: "Use GET." });
      const host = this.creationHost(machine, request, response);
      if (!host) return;
      return this.creationResult(response, () => this.cloneCheck({ hostId: host.id, url: url.searchParams.get("url") || "" }));
    }
    if (route === "launch/clone") {
      if (request.method !== "GET") return send(response, 405, { error: "Use GET." });
      const host = this.creationHost(machine, request, response);
      if (!host) return;
      return this.creationResult(response, async () => {
        const result = await this.cloneTarget({ hostId: host.id, url: url.searchParams.get("url") || "", into: url.searchParams.get("into") || undefined });
        const target = { ...result };
        delete target.real;
        delete target.intoReal;
        delete target.repo;
        return target;
      });
    }
    if (route === "skills" && request.method === "GET") return send(response, 200, { skills: [] });
    if (route === "skills/content" && request.method === "GET") return send(response, 200, { content: "" });
    if (route === "messages" && request.method === "POST") {
      const body = await bodyJson(request);
      if (body.to?.launch) return this.launchMessage(machine, body, request, response);
      const session = this.sessions(machine).find((item) => item.sessionId === body.to?.session && item.online);
      if (!session) return send(response, 409, { code: "session_not_live", error: "Session is not live" });
      return this.reply(machine, session, body, request, response, true);
    }
    if (route === "uploads" && request.method === "POST") {
      const bytes = await bodyBytes(request);
      const uploadId = id("upl", randomUUID());
      const name = (url.searchParams.get("name") || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const upload = { upload_id: uploadId, name, data: bytes, mimeType: sniffMimeType(bytes, request.headers["content-type"]) };
      this.uploads.set(uploadId, upload);
      await this.persistUpload(upload);
      return send(response, 200, { upload: { upload_id: uploadId, name, size: bytes.length, mime_type: upload.mimeType } });
    }
    let match = route.match(new RegExp("^uploads/([^/]+)/text$"));
    if (match && request.method === "GET") {
      const upload = this.uploads.get(match[1]);
      return upload ? send(response, 200, { text: upload.data.toString("utf8") }) : send(response, 404, { code: "upload_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)/draft(/delete)?$"));
    if (match) {
      const session = this.session(machine, match[1]);
      if (!session) return send(response, 404, { code: "thread_not_found" });
      if (request.method === "GET" && !match[2]) return send(response, 200, { serverSession: id("srv", session.hostId), draft: this.drafts.get(match[1]) });
      if (request.method !== "POST") return send(response, 405, { error: "Use GET or POST" });
      if (match[2]) return send(response, 200, { ok: true, deleted: await this.drafts.delete(match[1]) });
      try {
        return send(response, 200, { draft: await this.drafts.save(match[1], await bodyJson(request)) });
      } catch (error) {
        return send(response, error.code === "draft_conflict" ? 409 : 422, { code: error.code, error: error.message, draft: error.draft });
      }
    }
    match = route.match(new RegExp("^threads/([^/]+)/taggable$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      return session ? send(response, 200, this.taggable(session)) : send(response, 404, { code: "thread_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)/attachments$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      return session ? send(response, 200, this.attachmentsModel(session)) : send(response, 404, { code: "thread_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      if (!session) return send(response, 404, { code: "thread_not_found" });
      let body = this.threadCache.get(session.key);
      if (!body) {
        body = JSON.stringify(this.thread(session));
        this.threadCache.set(session.key, body);
      }
      return sendSerialized(response, 200, body);
    }
    match = route.match(new RegExp("^threads/([^/]+)/sessions$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      return session ? send(response, 200, this.sessionList(machine, session.key)) : send(response, 404, { code: "thread_not_found" });
    }
    match = route.match(new RegExp("^annotations/([^/]+)/remove$"));
    if (match && request.method === "POST") return this.removeAnnotation(machine, match[1], response);
    match = route.match(new RegExp("^messages/([^/]+)/annotations$"));
    if (match && request.method === "POST") return this.saveAnnotation(machine, match[1], await bodyJson(request), response);
    match = route.match(new RegExp("^messages/([^/]+)/ack$"));
    if (match && request.method === "POST") return this.acknowledge(machine, match[1], await bodyJson(request), response);
    match = route.match(new RegExp("^threads/([^/]+)/(seen|read|unread|mark-unread|snooze)$"));
    if (match && request.method === "POST") {
      const session = this.session(machine, match[1]);
      if (!session) return send(response, 404, { code: "thread_not_found" });
      if (match[2] === "snooze") {
        const body = await bodyJson(request);
        const until = body.until === null ? null : body.until;
        if (until !== null && (typeof until !== "string" || !Number.isFinite(Date.parse(until)))) return send(response, 422, { code: "validation_error", error: "until must be an ISO time or null" });
        const at = typeof body.at === "string" ? body.at : new Date().toISOString();
        await this.store.updateVirtualSession(session.key, { snoozedUntil: until, snoozedAt: at });
        await this.changed(session, { thread_id: id("msg", session.key) }, "snoozes");
        return send(response, 200, { snoozed: until ? { until, at } : null });
      }
      if (match[2] === "seen") {
        const body = await bodyJson(request);
        const through = body.through_seq;
        if (through !== undefined && through !== null && (!Number.isInteger(through) || through < 0)) {
          return send(response, 422, { code: "validation_error", field: "through_seq", error: "through_seq must be a non-negative integer or null" });
        }
        const newest = Math.max(0, ...this.messagesFor(session).map((message) => message.seq || 0));
        const requested = typeof through === "number" ? Math.min(through, newest) : newest;
        const seenThroughSeq = Math.max(session.seenThroughSeq ?? 0, requested);
        if (seenThroughSeq > (session.seenThroughSeq ?? 0)) {
          await this.store.updateVirtualSession(session.key, { seenThroughSeq });
          await this.changed(session);
        }
        return send(response, 200, { thread: this.row(session) });
      }
      if (match[2] === "mark-unread") {
        const latestAgent = this.messagesFor(session).filter((message) => message.author.kind === "agent" && message.seq > 0).at(-1);
        const throughSeq = latestAgent ? latestAgent.seq - 1 : 0;
        await this.store.updateVirtualSession(session.key, { seenThroughSeq: throughSeq });
        await this.changed(session);
        return send(response, 200, { thread: this.row(session), wrote: Boolean(latestAgent), through_seq: throughSeq });
      }
      const read = match[2] === "read";
      const latestSeq = Math.max(0, ...this.messagesFor(session).map((message) => message.seq || 0));
      await this.store.updateVirtualSession(session.key, {
        readAt: read ? new Date().toISOString() : null,
        seenThroughSeq: read ? latestSeq : session.seenBeforeRead ?? session.seenThroughSeq ?? 0,
        seenBeforeRead: read ? session.seenThroughSeq ?? 0 : null
      });
      await this.changed(session);
      return send(response, 200, { thread: this.row(session) });
    }
    match = route.match(new RegExp("^launch/([^/]+)/(stop|retry|trust|delete)$"));
    if (match && request.method === "POST") {
      const action = match[2];
      if (request.headers["x-plannotator-window"] !== "1") return send(response, 403, { code: "window_only", error: "Launch lifecycle actions require the Inbox window" });
      const session = this.sessions(machine).find((item) => item.launch?.id === match[1]);
      if (!session || (session.launch.deleted_at && action !== "delete")) return send(response, 404, { code: "launch_not_found" });
      const alreadyDeleted = Boolean(session.launch.deleted_at);
      try {
        if (action === "stop") await this.stopLaunch(session);
        else if (action === "retry") await this.retryLaunch(session);
        else if (action === "trust") await this.trustLaunch(session);
        else {
          const result = await this.deleteLaunch(session);
          if (!alreadyDeleted) await this.changed(session);
          return send(response, 200, { ok: true, ...result });
        }
        await this.changed(session);
        return send(response, 200, { run: this.run(session) });
      } catch (error) {
        const status = error.code === "validation_error" ? 422 : error.code === "launch_not_found" ? 404 : 400;
        return send(response, status, { code: error.code || "launch_failed", error: error.message });
      }
    }
    match = route.match(new RegExp("^messages/([^/]+)/reply$"));
    if (match && request.method === "POST") {
      const session = this.findByMessage(machine, match[1]);
      if (!session) return send(response, 404, { code: "message_not_found" });
      return this.reply(machine, session, await bodyJson(request), request, response);
    }
    match = route.match(new RegExp("^messages/([^/]+)/picks$"));
    if (match && request.method === "POST") {
      const session = this.findByMessage(machine, match[1]);
      if (!session || match[1] !== id("msg", session.key, "stop-control")) return send(response, 404, { code: "message_not_found" });
      const body = await bodyJson(request);
      if (!JSON.stringify(body.picks).includes("Stop agent")) return send(response, 422, { code: "validation_error", error: "Unknown choice" });
      await this.stopSession({ key: session.key, generation: session.generation, requestId: requireKey(body.idempotency_key) });
      await this.store.updateVirtualSession(session.key, { stopRequestedAt: new Date().toISOString() });
      await this.changed(session);
      return send(response, 200, { message: this.controlMessage(session) });
    }
    match = route.match(new RegExp("^projects/([^/]+)/(read|unread|resolve)$"));
    if (match && request.method === "POST") return this.projectAction(machine, match[1], match[2], await bodyJson(request), response);

    match = route.match(new RegExp("^threads/([^/]+)/delete$"));
    if (match && request.method === "POST") return this.deleteThread(machine, match[1], response);


    match = route.match(new RegExp("^messages/([^/]+)/resolve$"));
    if (match && request.method === "POST") {
      const session = this.findByMessage(machine, match[1]);
      if (!session) return send(response, 404, { code: "message_not_found" });
      const body = await bodyJson(request);
      await this.store.updateVirtualSession(session.key, { resolvedAt: body.resolved === false ? null : new Date().toISOString() });
      await this.changed(session);
      return send(response, 200, { row: this.row(session) });
    }
    match = route.match(new RegExp("^attachments/([^/]+)/(image|download)$"));
    if (match && request.method === "GET") {
      for (const session of this.sessions(machine)) {
        const attachment = this.persistedAttachments(session).find((item) => item.id === match[1]);
        if (attachment) return sendBytes(response, 200, attachment.data, attachment.mimeType);
      }
      return send(response, 404, { code: "attachment_not_found" });
    }
    return send(response, 404, { code: "device_route_not_found", error: "Not found" });
  }
}

function requireKey(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("idempotency_key is required");
  return value.trim();
}
