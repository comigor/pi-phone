import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const CONTAINERS = new Set(["/", "/Volumes", "/Users", "/home", "/mnt", "/media", "/run/media"]);
const SYSTEM = new Set(["/System", "/Library", "/Applications", "/bin", "/sbin", "/usr", "/private", "/etc", "/var", "/tmp", "/dev", "/cores", "/opt", "/Network", "/net", "/proc", "/sys", "/boot", "/efi", "/lib", "/lib32", "/lib64", "/libx32", "/run", "/root", "/snap", "/lost+found"]);
const PART = /^[A-Za-z0-9_~][A-Za-z0-9._~-]*$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);
function under(candidate, root) {
    return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}
function shown(home, candidate) {
    const realHome = path.resolve(home);
    if (candidate === realHome)
        return "~";
    return under(candidate, realHome) ? `~/${path.relative(realHome, candidate).split(path.sep).join("/")}` : candidate;
}
function resolved(home, typed) {
    if (typed.includes("\0") || typed.includes("\\"))
        throw Object.assign(new Error("Pick a folder by its full path."), { code: "outside" });
    const candidate = typed === "~" ? path.resolve(home) : typed.startsWith("~/") ? path.resolve(home, typed.slice(2)) : path.isAbsolute(typed) ? path.resolve(typed) : "";
    if (!candidate)
        throw Object.assign(new Error("Pick a folder by its full path."), { code: "outside" });
    const relative = path.relative(path.parse(candidate).root, candidate).split(path.sep);
    if (relative.some((segment) => segment === "." || segment === ".."))
        throw Object.assign(new Error("Pick a folder by its full path."), { code: "outside" });
    const homeRelative = path.relative(path.resolve(home), candidate).split(path.sep);
    const insideHome = under(candidate, path.resolve(home));
    if ((insideHome && homeRelative.some((segment) => segment.startsWith("."))) || (!insideHome && relative.some((segment) => segment.startsWith(".")))) {
        throw Object.assign(new Error("Hidden folders can't be picked."), { code: "hidden" });
    }
    if ([...SYSTEM].some((root) => under(candidate, root)) && !under(candidate, "/run/media"))
        throw Object.assign(new Error("System folders can't be picked."), { code: "system" });
    return candidate;
}
async function folderState(home, candidate) {
    const realHome = await realpath(home).catch(() => path.resolve(home));
    const start = candidate !== realHome && !CONTAINERS.has(candidate) && !under(realHome, candidate);
    try {
        const info = await lstat(candidate);
        if (!info.isDirectory() && !info.isSymbolicLink())
            return { exists: false, state: "file", real: null, shown: shown(home, candidate), start: false };
        const real = await realpath(candidate);
        resolved(home, real);
        const readable = await access(real, constants.R_OK | constants.X_OK).then(() => true, () => false);
        return { exists: readable, state: readable ? "folder" : "locked", real, shown: shown(home, real), start };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return { exists: false, state: "missing", real: null, shown: shown(home, candidate), start: false };
    }
}
async function nearest(home, candidate) {
    let current = path.dirname(candidate);
    for (;;) {
        try {
            const at = await folderState(home, current);
            if (at.exists && at.real)
                return { path: at.shown, folders: await childFolders(home, at.real) };
        }
        catch {
            return undefined;
        }
        const parent = path.dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
async function childFolders(home, real) {
    const entries = await readdir(real, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.includes("\\"))
            continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        try {
            const target = await realpath(path.join(real, entry.name));
            const info = await stat(target);
            if (info.isDirectory()) {
                resolved(home, target);
                names.push(entry.name);
            }
        }
        catch {
            // Broken links and unreadable targets stay out of the picker.
        }
    }
    return names.sort((a, b) => a.localeCompare(b)).slice(0, 500);
}
export async function listFolders(home, typed) {
    const candidate = resolved(home, typed || "~");
    const at = await folderState(home, candidate);
    if (!at.exists || !at.real) {
        return { path: at.shown, exists: false, state: at.state, folders: [], nearest: await nearest(home, candidate) };
    }
    const writable = await access(at.real, constants.W_OK | constants.X_OK).then(() => true, () => false);
    return { path: at.shown, exists: true, state: "folder", folders: await childFolders(home, at.real), ...(at.start ? {} : { start: false }), writable };
}
export async function prepareFolder(home, typed, create) {
    const candidate = resolved(home, typed);
    const at = await folderState(home, candidate);
    if (at.exists && at.real)
        return at.real;
    if (at.state !== "missing")
        throw Object.assign(new Error(`${at.shown} isn't a folder.`), { code: "folder_unavailable" });
    if (!create)
        throw Object.assign(new Error(`${at.shown} isn't there.`), { code: "folder_missing" });
    const parent = path.dirname(candidate);
    const parentState = await folderState(home, parent);
    if (!parentState.exists || !parentState.real)
        throw Object.assign(new Error(`There's no ${shown(home, parent)}. Only the last folder in a path can be made.`), { code: "folder_missing" });
    await access(parentState.real, constants.W_OK | constants.X_OK).catch(() => {
        throw Object.assign(new Error(`Can't make a folder in ${shown(home, parent)}: no permission.`), { code: "folder_unavailable" });
    });
    await mkdir(candidate).catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
    const real = await realpath(candidate);
    resolved(home, real);
    return real;
}
function plain(segment) {
    return PART.test(segment) && segment !== "." && segment !== "..";
}
export function parseGitRepo(text) {
    const value = text.trim();
    if (!value || value.startsWith("-") || /[\s\0]/.test(value))
        return null;
    let host = "";
    let slug = "";
    let transport = "https";
    let port = "";
    let user = "";
    let match;
    if ((match = /^([A-Za-z0-9_][A-Za-z0-9._-]*)@([^:/]+):(?!\/\/)(.+?)\/?$/.exec(value))) {
        [, user, host, slug] = match;
        transport = "ssh";
    }
    else if ((match = /^ssh:\/\/(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([^:/@]+)(?::(\d{1,5}))?\/(.+?)\/?$/.exec(value))) {
        [, user = "", host, port = "", slug] = match;
        transport = "ssh";
    }
    else if ((match = /^https:\/\/(?:[^@/]*@)?([^:/@?#]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:[?#].*)?$/.exec(value))) {
        [, host, port = "", slug = ""] = match;
    }
    else if ((match = /^(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/(.+?)\/?$/i.exec(value))) {
        [, host, slug] = match;
    }
    else
        return null;
    host = host.toLowerCase().replace(/^www\./, "");
    if (!HOST.test(host))
        return null;
    const segments = slug.split("/").filter(Boolean);
    if (segments.length === 0 || !segments.every((segment) => segment === "-" || plain(segment)))
        return null;
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, "");
    if (!segments[segments.length - 1])
        return null;
    let branch;
    if (FORGES.has(host) && transport === "https") {
        if (segments.length < 2)
            return null;
        let repoSegments;
        let rest;
        if (host === "gitlab.com") {
            const dash = segments.indexOf("-");
            repoSegments = dash >= 0 ? segments.slice(0, dash) : segments;
            rest = dash >= 0 ? segments.slice(dash + 1) : [];
        }
        else {
            repoSegments = segments.slice(0, 2);
            rest = segments.slice(2);
        }
        if (repoSegments.length < 2 || repoSegments.includes("-"))
            return null;
        slug = repoSegments.join("/");
        if ((rest[0] === "tree" || rest[0] === "blob") && rest[1] && BRANCH.test(rest[1]))
            branch = rest[1];
    }
    else {
        if (segments.includes("-"))
            return null;
        slug = segments.join("/");
    }
    const repo = slug.split("/").at(-1);
    const at = port && !(transport === "https" && port === "443") ? `:${port}` : "";
    const url = transport === "ssh"
        ? (port || value.startsWith("ssh://") ? `ssh://${user ? `${user}@` : ""}${host}${port ? `:${port}` : ""}/${slug}.git` : `${user ? `${user}@` : ""}${host}:${slug}.git`)
        : `https://${host}${at}/${slug}.git`;
    return { host, slug, repo, url, ...(branch ? { branch } : {}) };
}
async function originKey(candidate) {
    try {
        const { stdout } = await exec("git", ["-C", candidate, "remote", "get-url", "origin"], { timeout: 5_000 });
        const repo = parseGitRepo(stdout.trim());
        return repo ? `${repo.host}/${repo.slug}`.toLowerCase() : null;
    }
    catch {
        return null;
    }
}
export async function cloneTarget(home, url, into) {
    const repo = parseGitRepo(url);
    if (!repo)
        throw Object.assign(new Error("Not a git repo's URL."), { code: "validation_error" });
    let parent = into ? resolved(home, into) : path.join(home, "Projects");
    if (!into)
        parent = await realpath(parent).catch(() => path.resolve(home));
    const at = await folderState(home, parent);
    if (!at.exists || !at.real)
        throw Object.assign(new Error(`${at.shown} isn't there.`), { code: "folder_missing" });
    parent = at.real;
    const key = `${repo.host}/${repo.slug}`.toLowerCase();
    let taken = null;
    for (let n = 1; n <= 999; n++) {
        const name = n === 1 ? repo.repo : `${repo.repo}-${n}`;
        const candidate = path.join(parent, name);
        const exists = await lstat(candidate).then(() => true, () => false);
        if (!exists) {
            const writable = await access(parent, constants.W_OK | constants.X_OK).then(() => true, () => false);
            return { into: shown(home, parent), path: shown(home, candidate), name, state: "clone", taken, writable, real: candidate, intoReal: parent, repo };
        }
        if (await originKey(candidate) === key) {
            const real = await realpath(candidate);
            return { into: shown(home, parent), path: shown(home, real), name, state: "already", taken: null, writable: true, real, intoReal: parent, repo };
        }
        taken ??= shown(home, candidate);
    }
    throw Object.assign(new Error(`Every name for ${repo.repo} is taken in ${shown(home, parent)}.`), { code: "folder_unavailable" });
}
export async function checkGitRemote(url) {
    const repo = parseGitRepo(url);
    if (!repo)
        throw Object.assign(new Error("Not a git repo's URL."), { code: "validation_error" });
    try {
        await exec("git", ["ls-remote", "--heads", repo.url], { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        return "ok";
    }
    catch (error) {
        const text = String(error.stderr || error.message).toLowerCase();
        if (/publickey|authentication failed|permission denied|could not read username/.test(text))
            return "auth";
        if (/not found|does not exist|repository .* not found/.test(text))
            return "not_found";
        if (/could not resolve host|timed out|connection refused|network is unreachable/.test(text))
            return "network";
        return "failed";
    }
}
export async function cloneRepository(repo, target) {
    const args = ["clone"];
    if (repo.branch)
        args.push("--branch", repo.branch);
    args.push(repo.url, target);
    await exec("git", args, { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}
export async function makeScratch(root, name) {
    const slug = name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pi-session";
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let n = 1; n <= 999; n++) {
        const candidate = path.join(root, n === 1 ? slug : `${slug}-${n}`);
        try {
            await mkdir(candidate, { mode: 0o700 });
            return realpath(candidate);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    throw Object.assign(new Error(`Every scratch folder name for ${name} is taken.`), { code: "scratch_unavailable" });
}