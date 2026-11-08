import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

function id(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\0")).digest();
  let value = "";
  for (let index = 0; index < 26; index++) value += ID_ALPHABET[digest[index] & 31];
  return `${prefix}_${value}`;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
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

function attachmentFor(session, message, attachment, index) {
  const data = attachment.data ? Buffer.from(attachment.data, "base64") : Buffer.alloc(0);
  const mimeType = attachment.mimeType || attachment.mime_type || "application/octet-stream";
  return {
    id: id("att", session.key, message.id, attachment.name || `image-${index}`, index),
    name: attachment.name || `image-${index + 1}.png`,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    size: data.length,
    data,
    mimeType
  };
}

export class VirtualMachines {
  constructor(options) {
    this.store = options.store;
    this.deliverReply = options.deliverReply;
    this.stopSession = options.stopSession;
    this.linkMachine = options.linkMachine;
    this.publicAddress = options.publicAddress;
    this.file = path.join(options.dataDir, "virtual-machines.json");
    this.machines = new Map();
    this.streams = new Map();
    this.linkRetries = new Map();
    this.uploads = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      for (const machine of saved.machines || []) this.machines.set(machine.hostId, machine);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => writeFile(this.file, JSON.stringify({ machines: [...this.machines.values()] }, null, 2), { mode: 0o600 }));
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
    return this.store.state.sessions.filter((session) => session.hostId === machine.hostId);
  }

  session(machine, threadId) {
    return this.sessions(machine).find((session) => id("msg", session.key) === threadId);
  }

  virtualMessage(session, message, index) {
    const project = projectFor(session);
    const mid = messageId(session, message, index);
    const attachments = (message.attachments || message.images || []).map((item, attachmentIndex) => attachmentFor(session, message, item, attachmentIndex));
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
      ...(attachments.length ? { attachments: attachments.map(({ data: _data, mimeType, ...attachment }) => ({ ...attachment, mime_type: mimeType })) } : {})
    };
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
      created_at: session.updatedAt,
      resolved_at: null,
      idempotency_key: null,
      thread_name: null,
      base_path: session.cwd,
      seq: 0,
      questions: [{ key: "q-stop", q: "The agent is running.", state: running ? "open" : "closed", choices: [{ label: "Stop agent" }], answer: running ? null : "Stop agent" }]
    };
  }

  messagesFor(session) {
    const seenUserText = new Set(session.messages.filter((message) => message.role === "user").map((message) => message.text));
    const messages = [...session.messages, ...(session.remoteReplies || []).filter((message) => !seenUserText.has(message.text))];
    const result = messages.map((message, index) => this.virtualMessage(session, message, index));
    if (session.status === "running" || session.status === "waiting" || session.stopRequestedAt) result.push(this.controlMessage(session));
    return result;
  }

  row(session) {
    const project = projectFor(session);
    const messages = this.messagesFor(session);
    const last = messages.at(-1);
    const waiting = session.status !== "running";
    return {
      thread_id: id("msg", session.key),
      project_id: project.id,
      subject: session.name || project.name,
      author: { kind: "agent", host: "pi", session: session.sessionId, name: "Pi" },
      created_at: session.createdAt || session.updatedAt,
      last_at: session.updatedAt,
      last_author: last?.author.kind || "agent",
      message_count: messages.length,
      resolved_at: session.resolvedAt || null,
      questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
      waiting_on_person: waiting,
      unsent: null,
      delivery: session.online ? { state: session.status === "running" ? "running" : "idle" } : null,
      agent_after_archive: false,
      back_from_archive: false,
      read_at: session.readAt || null,
      ack: null,
      project: { id: project.id, name: project.name },
      thread_name: null,
      answered_not_sent: false,
      reask_pending: false,
      waiting_since: waiting ? session.updatedAt : null,
      unseen: session.readAt ? 0 : 1,
      sent: null,
      guide: false,
      last_agent_at: session.updatedAt,
      section: waiting ? "waiting" : "sent",
      unread: !session.readAt
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
      row: this.row(session)
    };
  }

  list(machine) {
    const sessions = this.sessions(machine);
    const rows = sessions.map((session) => this.row(session));
    const projects = [...new Map(sessions.map((session) => {
      const project = projectFor(session);
      return [project.id, { ...project, key: project.id, created_at: session.createdAt || session.updatedAt, threads: 1, unread: session.readAt ? 0 : 1, listed: 1, archived: 0 }];
    })).values()];
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
      snoozes: false,
      pins: []
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

  sessionList(machine, threadId) {
    const sessions = this.sessions(machine).filter((session) => session.online && (!threadId || session.key === threadId));
    const projects = [...new Map(sessions.map((session) => {
      const project = projectFor(session);
      return [project.id, { project, sessions: [this.liveSession(session)] }];
    })).values()];
    return { serverSession: id("srv", machine.hostId), machine: machine.inboxId, home: "/", projects };
  }

  findByMessage(machine, messageIdValue) {
    for (const session of this.sessions(machine)) {
      if (this.messagesFor(session).some((message) => message.id === messageIdValue)) return session;
    }
    return undefined;
  }

  async changed(session, record) {
    const machine = this.machines.get(session.hostId);
    if (!machine) return;
    machine.cursor = (machine.cursor || 0) + 1;
    await this.persist();
    const data = JSON.stringify(record || { message: this.messagesFor(session).at(-1) || this.controlMessage(session) });
    for (const stream of this.streams.get(machine.hostId) || []) {
      stream.write(`id: ${machine.cursor}\nevent: record\ndata: ${data}\n\n`);
    }
  }

  async hostOffline(hostId) {
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

  attachmentsFor(session, messageIdValue) {
    const original = [...session.messages, ...(session.remoteReplies || [])].find((item, index) => messageId(session, item, index) === messageIdValue);
    return (original?.attachments || original?.images || []).map((item, index) => attachmentFor(session, original, item, index));
  }

  async reply(_machine, session, body, _request, response, compose = false) {
    const key = requireKey(body.idempotency_key);
    const text = compose ? body.body : body.words;
    if (typeof text !== "string" || !text.trim()) return send(response, 422, { code: "validation_error", error: "Message text is required" });
    if (!compose && body.seen_through_seq !== session.virtualCursor) return send(response, 409, { code: "thread_moved_on", error: "Read the latest thread before replying" });
    const attachments = (body.uploads || []).map((uploadId) => this.uploads.get(uploadId)).filter(Boolean);
    const previous = (session.remoteReplies || []).find((message) => message.requestId === key);
    if (previous) return send(response, 200, { reply: this.virtualMessage(session, previous, session.messages.length), replayed: true }, { "idempotent-replayed": "true" });
    await this.deliverReply({ key: session.key, generation: session.generation, requestId: key, text, attachments });
    const appended = await this.store.appendRemoteReply(session.key, { requestId: key, text, attachments });
    await this.changed(session);
    const reply = this.virtualMessage(session, appended.message, session.messages.length);
    if (compose) return send(response, 200, { thread_id: id("msg", session.key), message: reply, project: projectFor(session), replayed: false });
    return send(response, 200, { reply, thread: this.thread(session).thread });
  }

  async route(request, response) {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname.replace("/api/inbox/device/", "");
    if (route === "pair" && request.method === "POST") return this.pair(request, response);
    const machine = this.authenticated(request);
    if (!machine) return send(response, 401, { code: "device_token_invalid", error: "Unknown machine token" });
    if (route === "health") {
      if (!this.store.getHost(machine.hostId)?.online) return send(response, 503, { code: "machine_offline", error: "Host is offline" });
      return send(response, 200, { ok: true, inbox_id: machine.inboxId, machine_links: 1, version: "0.28.48", launch_from_machines: 0 });
    }
    if (route === "events") return this.events(machine, request, response);
    if (route === "threads" && request.method === "GET") return send(response, 200, this.list(machine));
    if (route === "projects" && request.method === "GET") return send(response, 200, { projects: this.list(machine).projects });
    if (route === "threads/archived" && request.method === "GET") return send(response, 200, { threads: [] });
    if (route === "sessions" && request.method === "GET") return send(response, 200, this.sessionList(machine));
    if (route === "search" && request.method === "GET") return send(response, 200, { results: [] });
    if (route === "skills" && request.method === "GET") return send(response, 200, { skills: [] });
    if (route === "skills/content" && request.method === "GET") return send(response, 200, { content: "" });
    if (route === "messages" && request.method === "POST") {
      const body = await bodyJson(request);
      const session = this.sessions(machine).find((item) => item.sessionId === body.to?.session && item.online);
      if (!session) return send(response, 409, { code: "session_not_live", error: "Session is not live" });
      return this.reply(machine, session, body, request, response, true);
    }
    if (route === "uploads" && request.method === "POST") {
      const bytes = await bodyBytes(request);
      const uploadId = id("upl", randomUUID());
      const name = (url.searchParams.get("name") || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const upload = { upload_id: uploadId, name, data: bytes, mimeType: request.headers["content-type"] || "application/octet-stream" };
      this.uploads.set(uploadId, upload);
      return send(response, 200, { upload: { upload_id: uploadId, name, size: bytes.length } });
    }
    let match = route.match(new RegExp("^uploads/([^/]+)/text$"));
    if (match && request.method === "GET") {
      const upload = this.uploads.get(match[1]);
      return upload ? send(response, 200, { text: upload.data.toString("utf8") }) : send(response, 404, { code: "upload_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      return session ? send(response, 200, this.thread(session)) : send(response, 404, { code: "thread_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)/sessions$"));
    if (match && request.method === "GET") {
      const session = this.session(machine, match[1]);
      return session ? send(response, 200, this.sessionList(machine, session.key)) : send(response, 404, { code: "thread_not_found" });
    }
    match = route.match(new RegExp("^threads/([^/]+)/(seen|read|unread|mark-unread|snooze)$"));
    if (match && request.method === "POST") {
      const session = this.session(machine, match[1]);
      if (!session) return send(response, 404, { code: "thread_not_found" });
      const read = match[2] === "seen" || match[2] === "read";
      await this.store.updateVirtualSession(session.key, { readAt: read ? new Date().toISOString() : null });
      await this.changed(session);
      return send(response, 200, { row: this.row(session) });
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
        for (const message of this.messagesFor(session)) {
          const attachments = this.attachmentsFor(session, message.id);
          const attachment = attachments.find((item) => item.id === match[1]);
          if (attachment) return sendBytes(response, 200, attachment.data, attachment.mimeType);
        }
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
