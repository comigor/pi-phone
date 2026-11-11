export interface GitRepo {
  host: string;
  slug: string;
  repo: string;
  url: string;
  branch?: string;
}

export interface FolderListing {
  path: string;
  exists: boolean;
  state: "folder" | "file" | "locked" | "missing";
  folders: string[];
  nearest?: { path: string; folders: string[] };
  start?: false;
  writable?: boolean;
}

export declare function listFolders(home: string, typed: string): Promise<FolderListing>;
export declare function prepareFolder(home: string, typed: string, create: boolean): Promise<string>;
export declare function parseGitRepo(text: string): GitRepo | null;
export declare function cloneTarget(home: string, url: string, into?: string): Promise<{
  into: string;
  path: string;
  name: string;
  state: "clone" | "already";
  taken: string | null;
  writable: boolean;
  real: string;
  intoReal: string;
  repo: GitRepo;
}>;
export declare function checkGitRemote(url: string): Promise<"ok" | "auth" | "not_found" | "network" | "failed">;
export declare function cloneRepository(repo: GitRepo, target: string): Promise<void>;
export declare function makeScratch(root: string, name: string): Promise<string>;
