import { createHash } from "node:crypto";

function questionKey(prefix, text) {
  return `${prefix}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

export function parseQuestions(body) {
  if (typeof body !== "string") return [];
  const questions = [];
  for (const match of body.matchAll(/:::question\s*\n([\s\S]*?)\n:::/g)) {
    const block = match[1].trim();
    const lines = block.split("\n");
    const choices = lines.filter((line) => /^- \[[ xX]?\] /.test(line)).map((line) => ({ label: line.replace(/^- \[[ xX]?\] /, "").trim() }));
    const prompt = lines.filter((line) => !/^- \[[ xX]?\] /.test(line)).join("\n").trim();
    questions.push({ key: questionKey("q", block), q: prompt, kind: "question", choices, state: "open", answer: null });
  }
  return questions;
}

export function structuredQuestions(session, message, messageId, body) {
  const source = [...(Array.isArray(message.questions) ? message.questions : []), ...(Array.isArray(message.questions) ? [] : parseQuestions(body))];
  if (Array.isArray(message.actions)) {
    for (const action of message.actions) source.push({ ...action, kind: "action", q: action.q || action.title || action.label, key: action.key || questionKey("a", JSON.stringify(action)) });
  }
  return source.map((question, index) => {
    const key = question.key || questionKey(question.kind === "action" ? "a" : "q", `${messageId}:${index}:${question.q || question.prompt}`);
    const stateKey = `${messageId}:${key}`;
    const answer = session.questionAnswers?.[stateKey];
    const action = session.actionStates?.[stateKey];
    const base = { ...question, key, q: question.q || question.prompt || "", kind: question.kind || "question" };
    if (action) return { ...base, state: action.outcome ? "closed" : "open", action_result: action.outcome ? { outcome: action.outcome, note: action.note || null, at: action.at } : null };
    if (answer) return { ...base, state: "closed", answer: answer.choice, answered_at: answer.at };
    return { ...base, state: question.state || "open", answer: question.answer ?? null, ...(base.kind === "action" ? { action_result: question.action_result || null } : {}) };
  });
}

export function questionSummary(messages) {
  const questions = messages.flatMap((message) => message.questions || []);
  const open = questions.filter((question) => question.state === "open");
  return {
    open: open.filter((question) => question.kind !== "action").length,
    picked: questions.filter((question) => question.kind !== "action" && question.state !== "open").length,
    stopped: false,
    holds_up: open.map((question) => question.key),
    prompt: open[0]?.q || null,
    actions: open.filter((question) => question.kind === "action").length
  };
}
