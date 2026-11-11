export interface HostSkill {
  name: string;
  root: "claude" | "codex" | "universal";
  description?: string;
  humanOnly: boolean;
  dir: string;
}

export interface HostSkillContent {
  name: string;
  dir: string;
  path: string;
  content: string;
  truncated: boolean;
  humanOnly: boolean;
}

export declare function listSkills(): Promise<HostSkill[]>;
export declare function readSkillContent(name: string): Promise<HostSkillContent | null>;
