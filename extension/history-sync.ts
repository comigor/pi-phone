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
