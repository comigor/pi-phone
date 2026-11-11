export function isVisibleMessage(message) {
  if (message.role === "user") return true;
  if (message.role !== "assistant" || message.stopReason === "toolUse" || message.toolCalls?.length) return false;
  return Boolean(message.text || message.errorMessage || message.images?.length || message.attachments?.length);
}
