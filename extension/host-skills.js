import { open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const META_HEAD = 65_536;
const CONTENT_HEAD = META_HEAD + 20_000 * 4 + 4_096;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

async function readHead(file, cap) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, cap)).toString("utf8"), truncated: bytesRead > cap };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function directories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (SKIP.has(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const dir = path.join(root, entry.name);
      try {
        if ((await stat(dir)).isDirectory()) result.push(dir);
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

async function roots() {
  const home = process.env.HOME?.trim() || os.homedir();
  const candidates = [
    { dir: path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), "skills"), root: "claude" },
    { dir: path.join(process.env.CODEX_HOME?.trim() || path.join(home, ".codex"), "skills"), root: "codex" },
    { dir: path.join(home, ".agents", "skills"), root: "universal" },
    { dir: path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "agents", "skills"), root: "universal" }
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = await realpath(candidate.dir).catch(() => candidate.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function discover() {
  const byName = new Map();
  for (const { dir, root } of await roots()) {
    for (const child of await directories(dir)) {
      const candidates = [];
      let hasSkill = false;
      try {
        hasSkill = (await stat(path.join(child, "SKILL.md"))).isFile();
      } catch {}
      if (hasSkill) candidates.push(child);
      else {
        for (const grandchild of await directories(child)) {
          try {
            if ((await stat(path.join(grandchild, "SKILL.md"))).isFile()) candidates.push(grandchild);
          } catch {}
        }
      }
      for (const sourcePath of candidates) {
        const name = path.basename(sourcePath);
        if (!byName.has(name)) byName.set(name, { name, root, dir: sourcePath, path: path.join(sourcePath, "SKILL.md") });
      }
    }
  }
  return [...byName.values()];
}

function metadata(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  let block;
  let failClosed = false;
  if (match) block = match[1];
  else if (/^---\r?\n/.test(text)) {
    block = text.replace(/^---\r?\n/, "");
    failClosed = true;
  } else return { humanOnly: false };
  let description;
  let humanOnly = false;
  let sawFlag = false;
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const matchLine = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[index]);
    if (!matchLine) continue;
    const key = matchLine[1].toLowerCase();
    const value = matchLine[2].trim();
    if (key === "disable-model-invocation") {
      sawFlag = true;
      humanOnly = /^(true|yes|on|1)$/i.test(value);
    } else if (key === "description") {
      if (!value || /^[>|][+-]?$/.test(value)) {
        const parts = [];
        for (let next = index + 1; next < lines.length && /^[ \t]/.test(lines[next]); next++) parts.push(lines[next].trim());
        description = parts.filter(Boolean).join(" ");
      } else description = value.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    }
  }
  if (failClosed && !sawFlag) humanOnly = true;
  return { ...(description ? { description: description.slice(0, 200) } : {}), humanOnly };
}

export async function listSkills() {
  const result = [];
  const discovered = (await discover()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500);
  for (const skill of discovered) {
    const head = await readHead(skill.path, META_HEAD);
    if (!head) continue;
    result.push({ name: skill.name, root: skill.root, ...metadata(head.text), dir: skill.dir });
  }
  return result;
}

export async function readSkillContent(name) {
  if (!name || name === "." || name === "..") return null;
  const skill = (await discover()).find((candidate) => candidate.name === name);
  if (!skill) return null;
  const head = await readHead(skill.path, CONTENT_HEAD);
  if (!head) return null;
  const raw = head.text.replace(/^\uFEFF/, "");
  if (head.truncated && /^---\r?\n/.test(raw) && !/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(raw)) return null;
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
  if (!body) return null;
  return {
    name: skill.name,
    dir: skill.dir,
    path: skill.path,
    content: body.slice(0, 20_000),
    truncated: head.truncated || body.length > 20_000,
    humanOnly: metadata(head.text).humanOnly
  };
}
