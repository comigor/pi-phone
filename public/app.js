const state = { hosts: [], sessions: [], inbox: [], view: "inbox", inboxFilter: "pending", selectedKey: undefined, selectedSession: undefined, streamingText: "", sending: false };
const drafts = new Map();
const sidebar = document.querySelector("#sidebar-content");
const main = document.querySelector("#main");
let socket;
let reconnectTimer;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(text) {
  const node = document.querySelector("#toast");
  node.textContent = text;
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 3500);
}

function projectName(session) {
  return session.name || session.cwd?.split("/").filter(Boolean).pop() || "Pi session";
}

function setView(view) {
  state.view = view;
  state.selectedKey = undefined;
  state.selectedSession = undefined;
  history.pushState({}, "", "/");
  document.querySelector(".sidebar").classList.remove("hidden-mobile");
  main.classList.add("hidden-mobile");
  render();
}

function selectSession(key) {
  state.selectedKey = key;
  state.selectedSession = state.sessions.find((item) => item.key === key);
  state.streamingText = "";
  history.pushState({}, "", `/session/${encodeURIComponent(key)}`);
  document.querySelector(".sidebar").classList.add("hidden-mobile");
  main.classList.remove("hidden-mobile");
  send({ type: "subscribe", sessionKey: key });
  render();
}

function renderSidebar() {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === state.view));
  document.querySelector("#inbox-filter").hidden = state.view !== "inbox";
  document.querySelectorAll("[data-filter]").forEach((button) => button.classList.toggle("active", button.dataset.filter === state.inboxFilter));
  const pending = state.inbox.filter((item) => item.status === "pending");
  document.querySelector("#inbox-count").textContent = pending.length;
  document.querySelector("#agent-count").textContent = state.sessions.filter((item) => item.online).length;
  sidebar.replaceChildren();
  if (state.view === "inbox") {
    const items = state.inboxFilter === "pending" ? pending : state.inbox;
    if (!items.length) {
      sidebar.append(element("div", "empty", state.inboxFilter === "pending" ? "No unanswered messages." : "No agent updates yet."));
      return;
    }
    for (const item of items) {
      const host = state.hosts.find((entry) => entry.id === item.hostId);
      const button = element("button", "card-button");
      button.append(element("div", "card-title", item.project));
      const meta = element("div", "card-meta");
      meta.append(element("span", `status-pill ${item.status}`, item.status), document.createTextNode(`${host?.name ?? "Host"} · ${new Date(item.createdAt).toLocaleString()}`));
      button.append(meta, element("div", "card-preview", item.body || item.title));
      button.addEventListener("click", () => selectSession(item.sessionKey));
      sidebar.append(button);
    }
    return;
  }
  const pendingHosts = state.hosts.filter((host) => !host.paired);
  if (pendingHosts.length) {
    sidebar.append(element("div", "section-label", "Pair computers"));
    for (const host of pendingHosts) {
      const row = element("div", "host-row");
      row.append(element("div", "card-title", host.name), element("div", "card-meta", `Code ${host.pairingCode}`));
      const approve = element("button", "primary-button", "Approve");
      approve.addEventListener("click", async () => {
        const response = await fetch(`/api/hosts/${encodeURIComponent(host.id)}/approve`, { method: "POST" });
        if (!response.ok) return toast("Could not approve host");
        toast(`${host.name} paired`);
      });
      row.append(approve);
      sidebar.append(row);
    }
  }
  sidebar.append(element("div", "section-label", "Live sessions"));
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt?.localeCompare(a.updatedAt));
  if (!sessions.length) sidebar.append(element("div", "empty", "Start Pi on a paired computer. It will appear automatically."));
  for (const session of sessions) {
    const host = state.hosts.find((entry) => entry.id === session.hostId);
    const button = element("button", "card-button");
    button.append(element("div", "card-title", projectName(session)));
    const meta = element("div", "card-meta");
    meta.append(element("span", `status-pill ${session.online ? "online" : ""}`, session.online ? session.status : "offline"), document.createTextNode(host?.name ?? "Host"));
    button.append(meta, element("div", "card-preview", session.cwd));
    button.addEventListener("click", () => selectSession(session.key));
    sidebar.append(button);
  }
}

function renderMain() {
  main.replaceChildren();
  if (!state.selectedKey) {
    const empty = element("section", "empty");
    empty.append(element("h1", "", state.view === "inbox" ? "Your agents, when they need you" : "Every live Pi session"));
    empty.append(element("p", "", state.view === "inbox" ? "Finished runs and questions arrive here automatically. Open one and answer in the original session." : "Pair a computer, then start Pi normally. No session command is needed."));
    main.append(empty);
    return;
  }
  const session = state.selectedSession ?? state.sessions.find((item) => item.key === state.selectedKey);
  if (!session) {
    main.append(element("div", "empty", "This session is not available."));
    return;
  }
  const chat = element("section", "chat");
  const header = element("header", "chat-header");
  const back = element("button", "secondary-button back-button", "Back");
  back.addEventListener("click", () => setView(state.view));
  const title = element("h1", "", projectName(session));
  title.prepend(back);
  header.append(title, element("div", "card-meta", `${session.cwd} · ${session.online ? session.status : "offline"}`));
  const messages = element("div", "messages");
  for (const message of session.messages ?? []) messages.append(renderMessage(message));
  if (state.streamingText) messages.append(renderMessage({ role: "assistant", text: state.streamingText, streaming: true }));
  const composer = element("form", "composer");
  const row = element("div", "composer-row");
  const input = element("textarea");
  input.value = drafts.get(session.key) ?? "";
  input.placeholder = session.online ? "Answer this agent…" : "Session is offline";
  input.disabled = !session.online || state.sending;
  input.setAttribute("aria-label", "Message to agent");
  input.addEventListener("input", () => drafts.set(session.key, input.value));
  const submit = element("button", "primary-button", state.sending ? "Sending" : "Send");
  submit.disabled = !session.online || state.sending;
  row.append(input, submit);
  composer.append(row);
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    state.sending = true;
    const accepted = send({ type: "reply", requestId: crypto.randomUUID(), sessionKey: session.key, generation: session.generation, text });
    if (!accepted) state.sending = false;
    render();
  });
  chat.append(header, messages, composer);
  main.append(chat);
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
}

function renderMessage(message) {
  const wrapper = element("article", `message ${message.role}`);
  let role = "Tool result";
  if (message.streaming) role = "Agent · streaming";
  else if (message.role === "user") role = "You";
  else if (message.role === "assistant") role = "Agent";
  wrapper.append(element("div", `message-role ${message.streaming ? "streaming" : ""}`, role));
  wrapper.append(element("div", "message-body", message.text || message.errorMessage || ""));
  for (const tool of message.toolCalls ?? []) wrapper.append(element("div", "tool-call", tool.name));
  return wrapper;
}

function renderStreaming() {
  const messages = document.querySelector(".messages");
  if (!messages) return;
  messages.querySelector(".message-role.streaming")?.closest("article")?.remove();
  if (state.streamingText) messages.append(renderMessage({ role: "assistant", text: state.streamingText, streaming: true }));
  messages.scrollTop = messages.scrollHeight;
}

function render() {
  renderSidebar();
  renderMain();
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  toast("Reconnecting to the inbox; try again in a moment");
  return false;
}

function handleMessage(message) {
  if (message.type === "state") {
    const previous = state.selectedSession;
    Object.assign(state, { hosts: message.hosts, sessions: message.sessions, inbox: message.inbox });
    if (state.selectedKey) {
      const selected = message.sessions.find((item) => item.key === state.selectedKey);
      state.selectedSession = selected ? { ...selected, messages: previous?.messages } : undefined;
    }
    renderSidebar();
    if (state.selectedKey && (!previous || !state.selectedSession || previous.online !== state.selectedSession.online || previous.status !== state.selectedSession.status)) renderMain();
    return;
  }
  if (message.type === "session_patch" && message.session) {
    const previous = state.sessions.find((item) => item.key === message.session.key);
    const messages = [...(previous?.messages || [])];
    for (const incoming of message.session.messages || []) {
      const index = messages.findIndex((item) => item.id === incoming.id);
      if (index >= 0) messages[index] = incoming;
      else messages.push(incoming);
    }
    message = { ...message, type: "session", session: { ...previous, ...message.session, messages } };
  }
  if (message.type === "session" && message.session) {
    const index = state.sessions.findIndex((item) => item.key === message.session.key);
    if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...message.session };
    else state.sessions.push(message.session);
    renderSidebar();
    if (state.selectedKey === message.session.key) {
      const previous = state.selectedSession;
      state.selectedSession = message.session;
      state.streamingText = "";
      if (previous?.online !== message.session.online || previous?.status !== message.session.status || previous?.messages?.length !== message.session.messages?.length) renderMain();
    }
    return;
  }
  if (message.type === "session_event") {
    if (message.sessionKey !== state.selectedKey) return;
    const update = message.event?.assistantMessageEvent;
    if (update?.type === "text_delta") {
      state.streamingText += update.delta;
      renderStreaming();
    }
    return;
  }
  if (message.type === "inbox") {
    const index = state.inbox.findIndex((item) => item.id === message.item.id);
    if (index >= 0) state.inbox[index] = message.item;
    else state.inbox.unshift(message.item);
    renderSidebar();
    return;
  }
  if (message.type === "reply_result") {
    state.sending = false;
    if (message.ok) drafts.delete(state.selectedKey);
    else toast(message.error || "Reply was not delivered");
    renderMain();
    return;
  }
  if (message.type === "error") {
    state.sending = false;
    toast(message.error);
    if (state.selectedKey) renderMain();
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  socket.addEventListener("open", () => {
    document.querySelector("#connection").textContent = "Connected";
    document.querySelector("#connection").classList.add("online");
    if (state.selectedKey) send({ type: "subscribe", sessionKey: state.selectedKey });
  });
  socket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      toast("Ignored an invalid server message");
    }
  });
  socket.addEventListener("close", () => {
    document.querySelector("#connection").textContent = "Reconnecting";
    document.querySelector("#connection").classList.remove("online");
    reconnectTimer = setTimeout(connect, 2000);
  });
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function enableNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return toast("Push notifications are not supported in this browser");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return toast("Notification permission was not granted");
  const registration = await navigator.serviceWorker.register("/sw.js");
  const { publicKey } = await (await fetch("/api/push/public-key")).json();
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
  const response = await fetch("/api/push/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) });
  if (!response.ok) return toast("Could not register this device for alerts");
  document.querySelector("#notifications").textContent = "Alerts on";
  toast("Notifications enabled on this device");
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  state.inboxFilter = button.dataset.filter;
  renderSidebar();
}));
document.querySelector("#home").addEventListener("click", () => setView("inbox"));
document.querySelector("#notifications").addEventListener("click", enableNotifications);
if (location.pathname.startsWith("/session/")) {
  state.selectedKey = decodeURIComponent(location.pathname.slice("/session/".length));
  state.view = "agents";
}
connect();
render();
