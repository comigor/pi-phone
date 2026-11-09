import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function conflict(draft) {
  return Object.assign(new Error("This reply changed in another window since you opened it."), { code: "draft_conflict", draft });
}

function files(value) {
  if (!Array.isArray(value)) return null;
  return value.map((file) => typeof file === "string" ? { upload_id: file } : file).filter((file) => file && typeof file.upload_id === "string");
}

export class DraftStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "drafts.json");
    this.drafts = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      for (const draft of saved.drafts || []) {
        if (draft && typeof draft.thread_id === "string" && typeof draft.body === "string") this.drafts.set(draft.thread_id, draft);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(threadId) {
    return this.drafts.get(threadId) || null;
  }

  persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ drafts: [...this.drafts.values()] })}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeQueue;
  }

  async save(threadId, input) {
    const body = input.body ?? "";
    if (typeof body !== "string" || body.length > 65_000) throw Object.assign(new Error("Invalid draft body"), { code: "validation_error" });
    const base = input.base ?? null;
    if (base !== null && typeof base !== "string") throw Object.assign(new Error("Invalid draft base"), { code: "validation_error" });
    const existing = this.get(threadId);
    const ownWords = typeof input.base_body === "string" && existing?.body === input.base_body;
    if ((existing?.updated_at || null) !== base && !ownWords) throw conflict(existing);
    let nextFiles = existing?.files || [];
    const hasOps = input.files_add !== undefined || input.files_remove !== undefined || input.files_place !== undefined;
    if (hasOps) {
      const add = files(input.files_add) || [];
      const remove = new Set(Array.isArray(input.files_remove) ? input.files_remove : []);
      const place = new Map((Array.isArray(input.files_place) ? input.files_place : []).map((entry) => [entry.upload_id, entry.pasted]));
      const added = new Map(add.map((file) => [file.upload_id, file]));
      nextFiles = nextFiles.filter((file) => !remove.has(file.upload_id)).map((file) => {
        if (added.has(file.upload_id)) return added.get(file.upload_id);
        const pasted = place.get(file.upload_id);
        return pasted && file.pasted ? { ...file, pasted } : file;
      });
      const present = new Set(nextFiles.map((file) => file.upload_id));
      nextFiles.push(...add.filter((file) => !remove.has(file.upload_id) && !present.has(file.upload_id)));
    } else {
      const incoming = files(input.files);
      if (incoming) {
        if (input.all_files === true) nextFiles = incoming;
        else {
          const named = new Set(incoming.map((file) => file.upload_id));
          nextFiles = [...nextFiles.filter((file) => !file.pasted && !named.has(file.upload_id)), ...incoming];
        }
      }
    }
    if (!body.trim() && nextFiles.length === 0) {
      await this.delete(threadId);
      return null;
    }
    const at = new Date().toISOString();
    const draft = {
      v: 1,
      thread_id: threadId,
      body,
      created_at: existing?.created_at || at,
      updated_at: existing && at <= existing.updated_at ? new Date(Date.parse(existing.updated_at) + 1).toISOString() : at,
      ...(nextFiles.length ? { files: nextFiles } : {})
    };
    this.drafts.set(threadId, draft);
    await this.persist();
    return draft;
  }

  async delete(threadId) {
    const deleted = this.drafts.delete(threadId);
    if (deleted) await this.persist();
    return deleted;
  }

  async clearSent(threadId, updatedAt, words, uploads = []) {
    const existing = this.get(threadId);
    if (!existing) return false;
    const carried = new Set(uploads);
    if (existing.updated_at === updatedAt) {
      const left = (existing.files || []).filter((file) => !carried.has(file.upload_id));
      if (!left.length) return this.delete(threadId);
      this.drafts.set(threadId, { ...existing, body: "", files: left });
      await this.persist();
      return true;
    }
    if (typeof words !== "string" || existing.body.trim() !== words.trim() || !(existing.files || []).every((file) => carried.has(file.upload_id))) return false;
    return this.delete(threadId);
  }
}
