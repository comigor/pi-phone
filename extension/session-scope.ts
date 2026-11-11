const NATIVE_TASK_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?:\.jsonl)?$/i;

export function isSubagentSession(env: NodeJS.ProcessEnv = process.env, sessionFile?: string | null): boolean {
  // Native task agents share the parent process and environment. OMP nests
  // their files below a directory named from the parent session instead.
  const directories = sessionFile?.split(/[\\/]/).slice(0, -1) ?? [];
  if (directories.some((part) => part.endsWith(".jsonl") || NATIVE_TASK_DIRECTORY.test(part))) return true;
  return Boolean(env.PI_FABRIC_LINEAGE) || Number(env.PI_FABRIC_DEPTH || 0) > 0;
}
