const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "jsonc", "js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "yaml", "yml", "toml", "xml", "svg", "sh", "py", "rb", "go", "rs", "java", "c", "h", "cc", "cpp", "cs", "sql", "log"]);

export function attachmentKind(attachment) {
  const mime = attachment.mimeType || attachment.mime_type || "application/octet-stream";
  const extension = (attachment.name || attachment.path || "").split(".").pop()?.toLowerCase() || "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/html" || extension === "html" || extension === "htm") return "html";
  if (mime === "text/markdown" || extension === "md" || extension === "markdown") return "markdown";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || TEXT_EXTENSIONS.has(extension)) return "code";
  return "file";
}

export function isTextAttachment(attachment) {
  return ["html", "markdown", "code"].includes(attachmentKind(attachment));
}

function contentDisposition(disposition, name) {
  const fallback = String(name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name || "attachment"))}`;
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end };
}

export function sendAttachmentBytes(request, response, attachment, route) {
  const data = attachment.data;
  const size = data.length;
  const etag = `"${attachment.sent_sha256}"`;
  const type = route === "download"
    ? attachmentKind(attachment) === "pdf" ? "application/pdf" : "application/octet-stream"
    : attachment.mimeType || attachment.mime_type || "application/octet-stream";
  const headers = {
    "content-type": type,
    "content-security-policy": "sandbox",
    "content-disposition": contentDisposition(route === "download" ? "attachment" : "inline", attachment.name),
    "cache-control": route === "download" ? "no-store" : "private, no-cache",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    etag
  };
  if (request.method !== "HEAD" && request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const range = request.headers["if-range"] && request.headers["if-range"] !== etag ? null : parseRange(request.headers.range, size);
  if (range?.invalid) {
    response.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
    response.end();
    return;
  }
  const status = range ? 206 : 200;
  const start = range?.start || 0;
  const end = range?.end ?? size - 1;
  const length = size ? end - start + 1 : 0;
  response.writeHead(status, {
    ...headers,
    "content-length": length,
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {})
  });
  response.end(request.method === "HEAD" || !length ? undefined : data.subarray(start, end + 1));
}
