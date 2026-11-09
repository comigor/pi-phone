function fold(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function tokens(value) {
  return [...value.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) => ({ token: fold(match[0]), start: match.index, end: match.index + match[0].length }));
}

function termsFor(query) {
  return [...new Set(tokens(query.trim().slice(0, 200)).map((item) => item.token))].slice(0, 8);
}

function rangesFor(value, terms) {
  if (!terms.length) return [];
  const last = terms.at(-1);
  return tokens(value).filter((item) => terms.includes(item.token) || item.token.startsWith(last)).map((item) => {
    const end = item.token.startsWith(last) && item.token !== last ? item.start + Math.min(last.length, item.end - item.start) : item.end;
    return [item.start, end];
  });
}

function matches(value, terms) {
  if (!terms.length) return false;
  const words = tokens(value).map((item) => item.token);
  const last = terms.at(-1);
  return terms.every((term, index) => words.some((word) => word === term || (index === terms.length - 1 && word.startsWith(last))));
}

function marked(value, terms) {
  return rangesFor(value, terms).map(([start, end]) => [start, end - start]);
}

function snippet(value, terms) {
  const ranges = rangesFor(value, terms);
  const first = ranges[0]?.[0] || 0;
  const last = ranges.at(-1)?.[1] || first;
  const start = Math.max(0, first - 60);
  const end = Math.min(value.length, Math.max(last + 140, start + 180));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return {
    text: `${prefix}${value.slice(start, end)}${suffix}`,
    marks: ranges.filter(([from, to]) => from >= start && to <= end).map(([from, to]) => [from - start + prefix.length, to - from])
  };
}

function newer(left, right) {
  return String(right.at).localeCompare(String(left.at));
}

function queryOf(params) {
  return {
    q: (params.get("q") || "").trim().slice(0, 200),
    project: params.get("project") || null,
    status: params.get("status") || null,
    from: params.get("from") || null,
    group: params.get("group") || null,
    current: params.get("current") || null,
    offset: Math.max(0, Number.parseInt(params.get("offset") || "0", 10) || 0),
    limit: Math.min(50, Math.max(1, Number.parseInt(params.get("limit") || "50", 10) || 50))
  };
}

export function paginateSearchAnswer(answer, params) {
  const query = queryOf(params);
  if (!answer.groups) return answer;
  const groups = {};
  const names = query.group ? [query.group] : ["threads", "messages", "files", "projects"];
  const caps = { threads: 5, messages: 8, files: 5, projects: 3 };
  for (const name of names) {
    const rows = answer.groups[name] || [];
    const limit = query.group ? query.limit : caps[name];
    groups[name] = rows.slice(query.group ? query.offset : 0, (query.group ? query.offset : 0) + limit);
  }
  return { ...answer, groups };
}

export function searchVirtualSessions(sessions, params, callbacks) {
  const started = performance.now();
  const query = queryOf(params);
  const terms = termsFor(query.q);
  const scoped = sessions.filter((session) => !query.project || callbacks.projectFor(session).id === query.project);
  const rows = { threads: [], messages: [], files: [], projects: [] };
  const projects = new Map();
  for (const session of scoped) {
    const project = callbacks.projectFor(session);
    const row = callbacks.row(session);
    const archived = Boolean(session.resolvedAt);
    if (query.status && (query.status === "archived" ? !archived : archived || row.section !== query.status)) continue;
    const base = { project: { id: project.id, name: project.name }, section: archived ? null : row.section, archived, at: session.updatedAt };
    const title = session.name || project.name;
    if ((!terms.length && (query.project || query.status)) || matches(title, terms)) {
      rows.threads.push({ type: "thread", id: row.thread_id, thread_id: row.thread_id, title, title_marks: marked(title, terms), thread_name: null, ...base });
    }
    for (const message of callbacks.messagesFor(session)) {
      if (!message.seq) continue;
      if (query.from && (query.from === "me" ? message.author.kind !== "person" : message.author.kind !== "agent")) continue;
      if (matches(message.body || "", terms)) {
        rows.messages.push({
          type: "message", id: message.id, thread_id: row.thread_id,
          author: message.author.kind === "person" ? { kind: "me", name: "You" } : { kind: "agent", name: "Pi", host: "pi" },
          title, thread_name: null, snippet: snippet(message.body, terms), question: null, ...base, at: message.created_at
        });
      }
      for (const attachment of message.attachments || []) {
        if (!matches(attachment.name, terms)) continue;
        const parts = attachment.name.split("/");
        rows.files.push({
          type: "file", id: attachment.id, thread_id: row.thread_id, message_id: message.id,
          name: attachment.name, name_marks: marked(attachment.name, terms), folder: parts.length > 1 ? parts.at(-2) : null,
          kind: attachment.kind || attachment.mime_type?.split("/").at(-1) || "file", title, thread_name: null, ...base, at: message.created_at
        });
      }
    }
    if (matches(`${project.name}\n${project.root}`, terms)) projects.set(project.id, { type: "project", id: project.id, project: { id: project.id, name: project.name }, name: project.name, name_marks: marked(project.name, terms), root: project.root, at: session.updatedAt });
  }
  rows.projects = [...projects.values()];
  for (const values of Object.values(rows)) values.sort((left, right) => Number(right.project?.id === query.current) - Number(left.project?.id === query.current) || newer(left, right));
  const hasFilters = Boolean(query.project || query.status || query.from);
  const answer = {
    q: query.q, terms, took_ms: Math.max(0, Math.round(performance.now() - started)), indexing: false, threads: scoped.length,
    totals: { threads: rows.threads.length, messages: rows.messages.length, files: rows.files.length, projects: rows.projects.length },
    groups: rows,
    recent: !terms.length && !hasFilters ? scoped.map((session) => {
      const row = callbacks.row(session);
      const project = callbacks.projectFor(session);
      return { type: "thread", id: row.thread_id, thread_id: row.thread_id, title: row.subject, title_marks: [], thread_name: null, project: { id: project.id, name: project.name }, section: row.section, archived: Boolean(session.resolvedAt), at: session.updatedAt };
    }).sort(newer).slice(0, 6) : null
  };
  if (!terms.length && !hasFilters) return { ...answer, totals: null, groups: null };
  if (!terms.length) {
    rows.messages = [];
    rows.files = [];
    rows.projects = [];
    answer.totals = { threads: rows.threads.length, messages: 0, files: 0, projects: 0 };
    rows.threads = rows.threads.slice(0, 20);
  }
  return answer;
}

export function mergeSearchAnswers(answers, params) {
  const present = answers.filter((answer) => answer && !answer.indexing);
  const first = present[0] || answers[0];
  const groups = {};
  for (const name of ["threads", "messages", "files", "projects"]) {
    groups[name] = present.flatMap((answer) => answer.groups?.[name] || []).sort(newer);
  }
  const totals = Object.fromEntries(Object.keys(groups).map((name) => [name, present.reduce((total, answer) => total + (answer.totals?.[name] || 0), 0)]));
  const recent = present.some((answer) => answer.recent) ? present.flatMap((answer) => answer.recent || []).sort(newer).slice(0, 6) : null;
  const merged = {
    ...first,
    q: queryOf(params).q,
    terms: present.find((answer) => answer.terms?.length)?.terms || first?.terms || [],
    took_ms: present.reduce((total, answer) => total + (answer.took_ms || 0), 0),
    indexing: false,
    threads: present.reduce((total, answer) => total + (answer.threads || 0), 0),
    totals: present.some((answer) => answer.totals) ? totals : null,
    groups: present.some((answer) => answer.groups) ? groups : null,
    recent
  };
  return paginateSearchAnswer(merged, params);
}
