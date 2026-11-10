export const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;

export function chunkSnapshotMessages<T>(messages: T[], maxBytes = SNAPSHOT_CHUNK_BYTES): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const message of messages) {
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    if (chunk.length && bytes + messageBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(message);
    bytes += messageBytes;
  }
  if (chunk.length || !chunks.length) chunks.push(chunk);
  return chunks;
}


type HistoryEntry = {
  type: string;
  id: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

function imageContent(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "image" && typeof block.data === "string").map((block) => ({
    data: block.data,
    mimeType: block.mimeType || "image/png"
  }));
}

export function snapshotMessages(branch: readonly HistoryEntry[], latestOnly = false) {
  return (latestOnly ? branch.slice(-1) : branch).flatMap((entry) => {
    if (entry.type !== "message" || !entry.message) return [];
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = message.content;
    const toolCalls = Array.isArray(content)
      ? content.filter((block) => block?.type === "toolCall").map((block) => ({ name: block.name, arguments: block.arguments }))
      : [];
    const images = imageContent(content);
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
    const text = textContent(content) || errorMessage;
    if (message.role === "assistant" && (message.stopReason === "toolUse" || toolCalls.length > 0 || (!text && images.length === 0))) return [];
    return [{
      id: entry.id,
      role: message.role,
      text,
      images,
      toolCalls,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      errorMessage: errorMessage || undefined
    }];
  });
}
