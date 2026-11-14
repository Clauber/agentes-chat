import type { GitHubHttp } from "../git/github-app";
import { LEFT_OUT_PATH, NOTE_FILE } from "./file";
import { NOTES_MAX, type NoteRemote, type RemoteNote, RepoRefusal } from "./remote";

/**
 * A wiki's repository on GitHub (ADR 0186): GitHub's git data API (refs, commits, trees, blobs) with an installation
 * token of the server's app, which may write the repository's contents.
 */
export interface GitHubRepoAccess {
  http: GitHubHttp;
  token: string;
  owner: string;
  repo: string;
}

/** GitHub didn't answer, or asked to wait (rate limits): the job tries again later; the sync keeps going. */
export class GitHubBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubBusy";
  }
}

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** A call GitHub refuses for now: over a rate limit (primary or secondary), or a server error. */
function busy(res: Response) {
  if (res.status >= 500 || res.status === 429) return true;
  return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
}

async function call(api: GitHubRepoAccess, method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await api.http.fetch(
      `${api.http.apiUrl}/repos/${encodeURIComponent(api.owner)}/${encodeURIComponent(api.repo)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${api.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "agentes.chat",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A followed redirect would carry the token to wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (error) {
    throw new GitHubBusy(`GitHub didn't answer ${method} ${path}: ${(error as Error).message}`);
  }
  if (busy(res)) throw new GitHubBusy(`GitHub answered ${res.status} to ${method} ${path}`);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json: json ?? {} };
}

/** A status that says the repository is out of reach for good (gone, or the app may no longer read it). */
const refused = (status: number) =>
  new RepoRefusal(status === 404 || status === 301 ? "wiki.repo_missing" : "wiki.repo_refused");

/** The repository as GitHub names it, and its default branch; null when the token doesn't reach it. */
export async function githubRepoFacts(api: GitHubRepoAccess) {
  const { status, json } = await call(api, "GET", "");
  if (status !== 200) return null;
  const [owner, repo] = String(json.full_name ?? "").split("/");
  if (!owner || !repo || typeof json.default_branch !== "string") return null;
  return { owner, repo, defaultBranch: json.default_branch };
}

async function branchHead(api: GitHubRepoAccess, branch: string): Promise<string | "missing" | "empty"> {
  const { status, json } = await call(api, "GET", `/git/ref/heads/${segments(branch)}`);
  if (status === 409) return "empty";
  if (status === 404) return "missing";
  const sha = (json.object as { sha?: unknown } | undefined)?.sha;
  if (status !== 200 || typeof sha !== "string") throw refused(status);
  return sha;
}

interface TreeEntry {
  path: string;
  mode?: string;
  type: string;
  sha: string;
  size?: number;
}

async function tree(api: GitHubRepoAccess, sha: string, recursive: boolean) {
  const { status, json } = await call(api, "GET", `/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
  if (status !== 200 || !Array.isArray(json.tree)) throw refused(status);
  return { entries: json.tree as TreeEntry[], truncated: json.truncated === true };
}

async function rootTreeOf(api: GitHubRepoAccess, commit: string) {
  const got = await call(api, "GET", `/git/commits/${commit}`);
  const sha = (got.json.tree as { sha?: unknown } | undefined)?.sha;
  if (got.status !== 200 || typeof sha !== "string") throw refused(got.status);
  return sha;
}

/** A git blob that is a file: links (`120000`) and submodules aren't notes. */
const isFile = (e: TreeEntry) => e.type === "blob" && e.mode !== "120000";

/**
 * The repository as a `NoteRemote`. One per sync: it remembers the root tree of the commits it listed, which a commit
 * of ours builds on.
 */
export function githubRemote(api: GitHubRepoAccess): NoteRemote {
  const roots = new Map<string, string>();
  const rootOf = async (commit: string) => {
    const known = roots.get(commit);
    if (known) return known;
    const sha = await rootTreeOf(api, commit);
    roots.set(commit, sha);
    return sha;
  };
  return {
    head: (branch) => branchHead(api, branch),

    // The whole tree at once; a repository too large for that is walked down to the folder and listed from there.
    async list(commit, folder) {
      const rootTree = await rootOf(commit);
      let entries: TreeEntry[];
      let prefix = folder ? `${folder}/` : "";
      const whole = await tree(api, rootTree, true);
      if (!whole.truncated) entries = whole.entries;
      else {
        let at = rootTree;
        for (const part of folder ? folder.split("/") : []) {
          const next = (await tree(api, at, false)).entries.find((e) => e.path === part && e.type === "tree");
          if (!next) return { files: new Map() };
          at = next.sha;
        }
        const under = folder ? await tree(api, at, true) : whole;
        if (under.truncated) throw new RepoRefusal("wiki.repo_too_large");
        entries = under.entries;
        prefix = "";
      }
      const files = new Map<string, RemoteNote>();
      for (const e of entries) {
        if (!isFile(e) || !e.path.startsWith(prefix)) continue;
        const path = e.path.slice(prefix.length);
        if (!NOTE_FILE.test(path) || LEFT_OUT_PATH.test(path)) continue;
        files.set(path, { sha: e.sha, size: e.size ?? 0 });
      }
      if (files.size > NOTES_MAX) throw new RepoRefusal("wiki.repo_too_large");
      return { files };
    },

    async read(blob) {
      const { status, json } = await call(api, "GET", `/git/blobs/${blob}`);
      if (status !== 200 || typeof json.content !== "string") throw refused(status);
      return Buffer.from(json.content, json.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    },

    async commit(input) {
      const made = await call(api, "POST", "/git/trees", {
        base_tree: await rootOf(input.parent),
        tree: [
          ...input.writes.map((w) => ({ path: w.path, mode: "100644", type: "blob", content: w.text })),
          ...input.removes.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
        ],
      });
      const treeSha = made.json.sha;
      // 422: a path to remove that the parent no longer has; the branch moved under us, or what we remember is off.
      if (made.status === 422) return "moved";
      if (made.status !== 201 || typeof treeSha !== "string") throw refused(made.status);
      const commit = await call(api, "POST", "/git/commits", {
        message: input.message,
        tree: treeSha,
        parents: [input.parent],
      });
      const commitSha = commit.json.sha;
      if (commit.status !== 201 || typeof commitSha !== "string") throw refused(commit.status);
      const ref = await call(api, "PATCH", `/git/refs/heads/${segments(input.branch)}`, {
        sha: commitSha,
        force: false,
      });
      if (ref.status === 200) return commitSha;
      if (ref.status !== 422 && ref.status !== 409) throw refused(ref.status);
      // Not a fast-forward because someone pushed first, or the branch takes no direct commit (protected, a rule).
      const now = await branchHead(api, input.branch);
      if (now !== input.parent) return "moved";
      throw new RepoRefusal("wiki.repo_protected");
    },
  };
}
