export function isSubagentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_FABRIC_LINEAGE) || Number(env.PI_FABRIC_DEPTH || 0) > 0;
}
