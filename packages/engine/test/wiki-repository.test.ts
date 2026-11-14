import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { and, eq, schema } from "@agenteschat/db";
import {
  connectWikiRepository,
  createWikiPage,
  deleteWikiPage,
  disconnectWikiRepository,
  type GitHubAppConfig,
  getWikiPage,
  getWikiRepository,
  gitBlobSha,
  listWikiVersions,
  noteFileName,
  noteFileText,
  notePath,
  pageOfPath,
  parseNoteFile,
  queueWikiRepositoryPush,
  renameWikiPage,
  requestWikiRepositorySync,
  resumeWikiRepository,
  setWikiPageAudience,
  setWikiPageLock,
  syncWikiRepository,
  updateWikiPage,
  ValidationError,
  WIKI_REPOSITORY_SYNC_JOB,
  type WikiActor,
  type WikiRepositoryDeps,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP: GitHubAppConfig = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  slug: "agentes-chat",
};
const API = "https://api.github.test";

/**
 * A fake GitHub with one repository (`acme/notes`, branch `main`): the git data API the sync uses (refs, commits,
 * trees, blobs) over flat file maps, and the app's installation token. `push` is someone writing on GitHub; `protect`
 * makes the branch refuse direct commits; `failNext` answers the next call to the repository with that response.
 */
function fakeGitHub(initial: Record<string, string> = {}) {
  let n = 0;
  // Ids as git's: 40 hex characters.
  const id = (prefix: string) => createHash("sha1").update(`${prefix}${++n}`).digest("hex");
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const putTree = (files: Map<string, string>) => {
    const sha = id("tree");
    for (const [, text] of files) blobs.set(gitBlobSha(text), text);
    trees.set(sha, new Map(files));
    return sha;
  };
  const root = putTree(new Map(Object.entries(initial)));
  let head = id("commit");
  commits.set(head, { tree: root, parents: [] });
  const calls: string[] = [];
  const messages: string[] = [];
  /** Optional: runs just before the branch moves (someone pushing first). */
  let beforeRef: (() => void) | null = null;
  let protectedBranch = false;
  let failing: { status: number; headers: Record<string, string> } | null = null;

  const files = () => trees.get(commits.get(head)?.tree ?? "") ?? new Map<string, string>();
  const push = (changes: Record<string, string | null>) => {
    const next = new Map(files());
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) next.delete(path);
      else next.set(path, text);
    }
    const sha = id("commit");
    commits.set(sha, { tree: putTree(next), parents: [head] });
    head = sha;
    return sha;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetch: typeof globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (path === "/repos/acme/notes/installation") return json(200, { id: 1 });
    if (path === "/app/installations/1/access_tokens") {
      return json(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (init?.headers && (init.headers as Record<string, string>).authorization !== "Bearer ghs_test") {
      return json(401, {});
    }
    if (failing) {
      const out = json(failing.status, { message: "slow down" }, failing.headers);
      failing = null;
      return out;
    }
    const repo = "/repos/acme/notes";
    if (path === repo) return json(200, { full_name: "acme/notes", default_branch: "main" });
    if (path === `${repo}/git/ref/heads/main`) return json(200, { object: { sha: head } });
    if (path.startsWith(`${repo}/git/ref/heads/`)) return json(404, {});
    const commit = /^\/repos\/acme\/notes\/git\/commits\/(\w+)$/.exec(path);
    if (commit && method === "GET") {
      const c = commits.get(commit[1] as string);
      return c ? json(200, { sha: commit[1], tree: { sha: c.tree } }) : json(404, {});
    }
    const tree = /^\/repos\/acme\/notes\/git\/trees\/(\w+)$/.exec(path);
    if (tree && method === "GET") {
      const t = trees.get(tree[1] as string);
      if (!t) return json(404, {});
      return json(200, {
        truncated: false,
        tree: [...t].map(([p, text]) => ({
          path: p,
          mode: "100644",
          type: "blob",
          sha: gitBlobSha(text),
          size: Buffer.byteLength(text),
        })),
      });
    }
    const blob = /^\/repos\/acme\/notes\/git\/blobs\/(\w+)$/.exec(path);
    if (blob) {
      const text = blobs.get(blob[1] as string);
      return text === undefined
        ? json(404, {})
        : json(200, { content: Buffer.from(text).toString("base64"), encoding: "base64" });
    }
    if (path === `${repo}/git/trees` && method === "POST") {
      const next = new Map(trees.get(body.base_tree) ?? []);
      for (const e of body.tree as { path: string; content?: string; sha?: string | null }[]) {
        if (e.sha === null) {
          if (!next.has(e.path)) return json(422, { message: "path not in tree" });
          next.delete(e.path);
        } else next.set(e.path, e.content ?? "");
      }
      return json(201, { sha: putTree(next) });
    }
    if (path === `${repo}/git/commits` && method === "POST") {
      const sha = id("commit");
      commits.set(sha, { tree: body.tree, parents: body.parents });
      messages.push(body.message);
      return json(201, { sha });
    }
    if (path === `${repo}/git/refs/heads/main` && method === "PATCH") {
      beforeRef?.();
      beforeRef = null;
      if (protectedBranch) return json(422, { message: "Protected branch update failed" });
      if (commits.get(body.sha)?.parents[0] !== head) return json(422, { message: "not a fast forward" });
      head = body.sha;
      return json(200, { object: { sha: head } });
    }
    return json(404, { message: `fake: ${method} ${path}` });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    push,
    files,
    calls,
    messages,
    head: () => head,
    onNextRef: (fn: () => void) => {
      beforeRef = fn;
    },
    protect: (on: boolean) => {
      protectedBranch = on;
    },
    failNext: (status: number, headers: Record<string, string> = {}) => {
      failing = { status, headers };
    },
  };
}

async function world(initial: Record<string, string> = {}) {
  f = await setup();
  const gh = fakeGitHub(initial);
  await f.db.insert(schema.githubAppInstallations).values({
    orgId: f.org.id,
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    createdByUserId: f.owner.id,
  });
  const deps: WikiRepositoryDeps = {
    db: f.db,
    pubsub: f.pubsub,
    github: { app: () => APP, http: { fetch: gh.fetch, apiUrl: API } },
  };
  return { gh, deps };
}

const person = (): WikiActor => ({ type: "person", userId: f.owner.id });
const wiki = () => ({ db: f.db, pubsub: f.pubsub });
const repositoryRow = async () =>
  (await f.db.select().from(schema.wikiRepositories).where(eq(schema.wikiRepositories.orgId, f.org.id)))[0];
const repositoryId = async () => (await repositoryRow())?.id as string;
/** Runs syncs until one has nothing left to do, as the queued jobs would. */
async function settle(deps: WikiRepositoryDeps) {
  const id = await repositoryId();
  for (let i = 0; i < 6; i++) {
    const out = await syncWikiRepository(deps, f.org.id, id);
    if (typeof out !== "object" || (out.pulled === 0 && out.pushed === 0 && !out.more)) return out;
  }
  throw new Error("the sync never settled");
}
const page = (ref: string) => getWikiPage(f.db, person(), f.org.id, ref);
const connect = (deps: WikiRepositoryDeps, path?: string) =>
  connectWikiRepository(deps, f.owner.id, f.org.id, { repository: "acme/notes", ...(path ? { path } : {}) });
const queuedSyncs = async () =>
  (
    await f.db
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, WIKI_REPOSITORY_SYNC_JOB), eq(schema.outbox.status, "pending")))
  ).length;

describe("the note format", () => {
  test("frontmatter is kept as written; tags and aliases come from it; the git blob id is git's", () => {
    const text = "---\ntitle: x\ntags:\n  - vendas\n  - '#rh'\naliases: [Guia, Manual]\n---\n\n# Texto\n";
    const note = parseNoteFile(text);
    expect(note.tags).toEqual(["vendas", "rh"]);
    expect(note.aliases).toEqual(["Guia", "Manual"]);
    expect(note.body).toBe("# Texto\n");
    expect(noteFileText({ body: note.body, tags: ["vendas", "rh"] }, note.head).text).toBe(text);
    // New tags rewrite only the tags block, where it was.
    expect(noteFileText({ body: "# Texto\n", tags: ["ops"] }, note.head).text).toBe(
      "---\ntitle: x\ntags:\n  - ops\naliases: [Guia, Manual]\n---\n\n# Texto\n",
    );
    expect(noteFileText({ body: "a", tags: [] }, "").text).toBe("a\n");
    // `git hash-object` of "hello\n".
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(notePath({ title: 'Q&A: "vendas"?', folder: "Processos/RH" })).toBe("Processos/RH/Q&A- -vendas--.md");
    expect(pageOfPath("Processos/Guia #1.md")).toEqual({ title: "Guia 1", folder: "Processos" });
  });

  test("a file name is one every disk takes and the listing never leaves out", () => {
    expect(noteFileName(".env")).toBe("env");
    expect(noteFileName("Notas. ")).toBe("Notas");
    expect(noteFileName("CON")).toBe("CON-");
    expect(noteFileName("node_modules")).toBe("node_modules-");
    expect(noteFileName("...")).toBe("page");
    expect(notePath({ title: "Deploy", folder: ".github/x" })).toBe("github/x/Deploy.md");
    // An accent written as two characters (a Mac) is the same name.
    expect(pageOfPath("Férias.md").title).toBe("Férias");
  });
});

describe("connecting", () => {
  test("only an administrator connects; the default branch is used; a repository the app doesn't reach is refused", async () => {
    const { deps } = await world({ "README.md": "# Notas\n" });
    const member = await addMember(f.db, f.org.id, "member");
    await expect(connectWikiRepository(deps, member.id, f.org.id, { repository: "acme/notes" })).rejects.toThrow();
    await expect(
      connectWikiRepository(deps, f.owner.id, f.org.id, { repository: "acme/other" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      connectWikiRepository(deps, f.owner.id, f.org.id, { repository: "acme/notes", branch: "gone" }),
    ).rejects.toMatchObject({ code: "wiki.repo_branch_missing" });
    await expect(
      connectWikiRepository(deps, f.owner.id, f.org.id, { repository: "acme/notes", path: "../x" }),
    ).rejects.toMatchObject({ code: "wiki.repo_path_invalid" });
    const view = await connect(deps);
    expect(view).toMatchObject({
      provider: "github",
      owner: "acme",
      repo: "notes",
      branch: "main",
      path: "",
      status: "active",
      syncing: true,
      url: "https://github.com/acme/notes",
    });
    expect(await getWikiRepository(f.db, member.id, f.org.id)).toMatchObject({ repo: "notes" });
    // Only one sync waits, however many changes ask for one.
    expect(await queuedSyncs()).toBe(1);
    await requestWikiRepositorySync(f.db, f.org.id);
    expect(await queuedSyncs()).toBe(1);
  });
});

describe("syncing", () => {
  test("the first sync joins both sides: notes become pages, pages become notes, a page and a note at one path are one", async () => {
    const { gh, deps } = await world({
      "Processos/Férias.md": "---\ntags: [rh]\n---\n\nAvise com 30 dias.\n",
      "Glossário.md": "MRR: receita recorrente.\n",
      ".obsidian/app.json": "{}",
    });
    await createWikiPage(wiki(), person(), f.org.id, { title: "Glossário", body: "Antigo." });
    await createWikiPage(wiki(), person(), f.org.id, { title: "Deploy", folder: "Eng", body: "Passo a passo." });
    await connect(deps);
    await settle(deps);

    const ferias = await page("ferias");
    expect(ferias).toMatchObject({ title: "Férias", folder: "Processos", tags: ["rh"], body: "Avise com 30 dias.\n" });
    // The repository's text won; ours is the version before it.
    const glossario = await page("glossario");
    expect(glossario.body).toBe("MRR: receita recorrente.\n");
    const versions = await listWikiVersions(f.db, person(), f.org.id, "glossario");
    expect(versions.map((v) => v.noteCode ?? v.note)).toEqual(["repository", "created"]);
    expect(versions[0]?.noteParams?.commit).toMatch(/^[0-9a-f]{7}$/);
    // Our page went there; nothing hidden was read.
    expect(gh.files().get("Eng/Deploy.md")).toBe("Passo a passo.\n");
    expect(gh.messages).toHaveLength(1);
    const repo = await getWikiRepository(f.db, f.owner.id, f.org.id);
    expect(repo).toMatchObject({ notes: 3, pending: 0, held: [], syncing: false, status: "active", errorCode: null });
    // Its own saves asked for no other sync.
    expect((await repositoryRow())?.dirty).toBe(false);
    // Nothing more to do: a sync on an unchanged branch asks GitHub only where the branch is.
    gh.calls.length = 0;
    expect(await syncWikiRepository(deps, f.org.id, await repositoryId())).toEqual({
      pulled: 0,
      pushed: 0,
      more: false,
    });
    expect(gh.calls.filter((c) => c.startsWith("GET /repos/acme/notes/git/trees"))).toEqual([]);
  });

  test("edits go both ways; where both changed a note the repository's stays and ours is in the history", async () => {
    const { gh, deps } = await world({ "Guia.md": "---\nautor: ana\n---\n\nUm.\n" });
    await connect(deps);
    await settle(deps);

    // Here → there, the frontmatter kept; the save asked for a sync.
    const g = await page("guia");
    await updateWikiPage(wiki(), person(), f.org.id, "guia", { baseVersion: g.version, body: "Dois.\n" });
    expect((await repositoryRow())?.dirty).toBe(true);
    expect((await page("guia")).repository).toMatchObject({ state: "pending", stopped: false });
    await settle(deps);
    expect(gh.files().get("Guia.md")).toBe("---\nautor: ana\n---\n\nDois.\n");
    expect(gh.messages.at(-1)).toContain("Update wiki: Guia");
    expect((await page("guia")).repository).toEqual({
      state: "synced",
      stopped: false,
      url: "https://github.com/acme/notes/blob/main/Guia.md",
    });

    // There → here.
    gh.push({ "Guia.md": "---\nautor: ana\n---\n\nTrês.\n" });
    await settle(deps);
    expect((await page("guia")).body).toBe("Três.\n");

    // Both: the repository wins.
    const now = await page("guia");
    await updateWikiPage(wiki(), person(), f.org.id, "guia", { baseVersion: now.version, body: "Daqui.\n" });
    gh.push({ "Guia.md": "---\nautor: ana\n---\n\nDe lá.\n" });
    await settle(deps);
    expect((await page("guia")).body).toBe("De lá.\n");
    expect(gh.files().get("Guia.md")).toBe("---\nautor: ana\n---\n\nDe lá.\n");
    const history = await listWikiVersions(f.db, person(), f.org.id, "guia");
    expect(history.map((v) => v.noteCode ?? v.note).slice(0, 2)).toEqual(["repository", "edited"]);
  });

  test("a page renamed here while its note changed there: the text comes from there, the new name goes there", async () => {
    const { gh, deps } = await world({ "Antigo.md": "um\n" });
    await connect(deps);
    await settle(deps);
    await renameWikiPage(wiki(), person(), f.org.id, "antigo", { title: "Novo" });
    gh.push({ "Antigo.md": "dois\n" });
    await settle(deps);
    expect((await page("novo")).body).toBe("dois\n");
    expect([...gh.files().keys()]).toEqual(["Novo.md"]);
    expect(gh.files().get("Novo.md")).toBe("dois\n");
  });

  test("a note removed, moved or renamed there: the page goes to the trash, moves or is renamed", async () => {
    const { gh, deps } = await world({ "A.md": "Texto A\n", "B.md": "Texto B\n", "C.md": "Texto C\n" });
    await connect(deps);
    await settle(deps);
    const b = await page("b");
    gh.push({ "A.md": null, "B.md": null, "Pasta/Bê.md": "Texto B\n", "C.md": null, "Cê.md": "Texto C\n" });
    await settle(deps);
    await expect(page("a")).rejects.toThrow();
    const moved = await getWikiPage(f.db, person(), f.org.id, b.id);
    expect(moved).toMatchObject({ title: "Bê", folder: "Pasta" });
    // Old links keep resolving through the alias.
    expect((await page("b")).id).toBe(b.id);
    expect((await page("ce")).body).toBe("Texto C\n");
    expect([...gh.files().keys()].sort()).toEqual(["Cê.md", "Pasta/Bê.md"]);
  });

  test("a page deleted, renamed or moved here leaves, follows or moves its note", async () => {
    const { gh, deps } = await world({ "Um.md": "1\n", "Dois.md": "2\n" });
    await connect(deps);
    await settle(deps);
    await deleteWikiPage(wiki(), person(), f.org.id, "um");
    await renameWikiPage(wiki(), person(), f.org.id, "dois", { title: "Segundo" });
    await settle(deps);
    expect([...gh.files().keys()]).toEqual(["Segundo.md"]);
    expect(gh.files().get("Segundo.md")).toBe("2\n");
  });

  test("a page in the trash whose note changed there comes back, with its history", async () => {
    const { gh, deps } = await world({ "Volta.md": "antes\n" });
    await connect(deps);
    await settle(deps);
    const before = await page("volta");
    await deleteWikiPage(wiki(), person(), f.org.id, "volta");
    gh.push({ "Volta.md": "depois\n" });
    await settle(deps);
    const back = await page("volta");
    expect(back.id).toBe(before.id);
    expect(back.body).toBe("depois\n");
    expect(gh.files().get("Volta.md")).toBe("depois\n");
  });

  test("a page limited to some people never goes there, and leaves when it becomes limited; a locked page follows the repository", async () => {
    const { gh, deps } = await world({ "Aberta.md": "a\n" });
    await createWikiPage(wiki(), person(), f.org.id, { title: "Salários", body: "segredo" });
    const onlyMe = { roleIds: [], userIds: [f.owner.id] };
    await setWikiPageAudience(wiki(), f.owner.id, f.org.id, "salarios", onlyMe);
    await connect(deps);
    await settle(deps);
    expect([...gh.files().keys()].sort()).toEqual(["Aberta.md"]);
    expect((await page("salarios")).repository).toEqual({ state: "local", stopped: false, url: null });

    await setWikiPageAudience(wiki(), f.owner.id, f.org.id, "aberta", onlyMe);
    await settle(deps);
    expect([...gh.files().keys()]).toEqual([]);
    // Its page stays as it is.
    expect((await page("aberta")).body).toBe("a\n");

    await createWikiPage(wiki(), person(), f.org.id, { title: "Regras", body: "Nossa.\n" });
    await settle(deps);
    await setWikiPageLock(wiki(), f.owner.id, f.org.id, "regras", true);
    gh.push({ "Regras.md": "Mudada lá.\n" });
    await settle(deps);
    expect((await page("regras")).body).toBe("Mudada lá.\n");
    expect(gh.files().get("Regras.md")).toBe("Mudada lá.\n");
  });

  test("a note that can't be a page is kept aside with why; one too long to read isn't written over", async () => {
    const deep = `${"a/".repeat(9)}Fundo.md`;
    const { gh, deps } = await world({ [deep]: "x\n", "Ok.md": "ok\n" });
    await connect(deps);
    await settle(deps);
    expect((await getWikiRepository(f.db, f.owner.id, f.org.id))?.held).toEqual([
      { path: deep, code: "wiki.folder_depth" },
    ]);

    // Grown past what a page holds there: the page keeps its last text, and isn't written over the note.
    const big = `${"x".repeat(200_001)}\n`;
    gh.push({ "Ok.md": big });
    await settle(deps);
    const ok = await page("ok");
    expect(ok.body).toBe("ok\n");
    expect(ok.repository?.state).toBe("held");
    await updateWikiPage(wiki(), person(), f.org.id, "ok", { baseVersion: ok.version, body: "nosso\n" });
    await settle(deps);
    expect(gh.files().get("Ok.md")).toBe(big);
  });

  test("someone pushing first makes the sync start over, within the same run", async () => {
    const { gh, deps } = await world({ "Ok.md": "ok\n" });
    await connect(deps);
    await settle(deps);
    const ok = await page("ok");
    await updateWikiPage(wiki(), person(), f.org.id, "ok", { baseVersion: ok.version, body: "nosso\n" });
    gh.onNextRef(() => gh.push({ "Outra.md": "nova\n" }));
    const out = await syncWikiRepository(deps, f.org.id, await repositoryId());
    expect(out).toMatchObject({ pushed: 1 });
    expect(gh.files().get("Ok.md")).toBe("nosso\n");
    expect((await page("outra")).body).toBe("nova\n");
  });

  test("GitHub asking to wait leaves the sync on and says so; a protected branch stops it with why", async () => {
    const { gh, deps } = await world({ "A.md": "a\n" });
    await connect(deps);
    await settle(deps);

    gh.failNext(403, { "x-ratelimit-remaining": "0" });
    gh.push({ "A.md": "b\n" });
    await expect(syncWikiRepository(deps, f.org.id, await repositoryId())).rejects.toThrow();
    expect(await getWikiRepository(f.db, f.owner.id, f.org.id)).toMatchObject({
      status: "active",
      errorCode: "wiki.repo_unreachable",
    });
    await settle(deps);
    expect((await page("a")).body).toBe("b\n");
    expect((await getWikiRepository(f.db, f.owner.id, f.org.id))?.errorCode).toBeNull();

    gh.protect(true);
    const a = await page("a");
    await updateWikiPage(wiki(), person(), f.org.id, "a", { baseVersion: a.version, body: "c\n" });
    expect(await syncWikiRepository(deps, f.org.id, await repositoryId())).toBe("stopped");
    expect(await getWikiRepository(f.db, f.owner.id, f.org.id)).toMatchObject({
      status: "error",
      errorCode: "wiki.repo_protected",
      pending: 1,
    });
    expect((await page("a")).repository).toMatchObject({ state: "pending", stopped: true });
    // Saves while it is stopped queue nothing; starting it again sends what waited.
    const a2 = await page("a");
    await updateWikiPage(wiki(), person(), f.org.id, "a", { baseVersion: a2.version, body: "d\n" });
    expect((await repositoryRow())?.dirty).toBe(false);
    gh.protect(false);
    await resumeWikiRepository(deps, f.owner.id, f.org.id);
    await settle(deps);
    expect(gh.files().get("A.md")).toBe("d\n");
  });

  test("a stopped sync says why; a push from GitHub queues the sync; disconnecting keeps both sides", async () => {
    const { gh, deps } = await world({ "A.md": "a\n" });
    await connect(deps);
    await settle(deps);
    await f.db.delete(schema.githubAppInstallations);
    const out = await syncWikiRepository(deps, f.org.id, await repositoryId());
    expect(out).toBe("stopped");
    expect(await getWikiRepository(f.db, f.owner.id, f.org.id)).toMatchObject({
      status: "error",
      errorCode: "wiki.repo_not_installed",
    });

    await f.db.insert(schema.githubAppInstallations).values({
      orgId: f.org.id,
      installationId: 1,
      accountLogin: "acme",
      accountType: "Organization",
      createdByUserId: f.owner.id,
    });
    await resumeWikiRepository(deps, f.owner.id, f.org.id);
    await settle(deps);
    const pushed = gh.push({ "A.md": "b\n" });
    const payload = {
      ref: "refs/heads/main",
      after: pushed,
      repository: { full_name: "Acme/Notes" },
      installation: { id: 1 },
    };
    expect(await queueWikiRepositoryPush(f.db, { ...payload, ref: "refs/heads/other" })).toBe(false);
    expect(await queueWikiRepositoryPush(f.db, { ...payload, installation: { id: 2 } })).toBe(false);
    expect(await queueWikiRepositoryPush(f.db, payload)).toBe(true);
    await settle(deps);
    expect((await page("a")).body).toBe("b\n");
    // Our own commit, told back by GitHub, is let go.
    const a = await page("a");
    await updateWikiPage(wiki(), person(), f.org.id, "a", { baseVersion: a.version, body: "c\n" });
    await settle(deps);
    expect(await queueWikiRepositoryPush(f.db, { ...payload, after: gh.head() })).toBe(false);

    await disconnectWikiRepository(deps, f.owner.id, f.org.id);
    expect(await getWikiRepository(f.db, f.owner.id, f.org.id)).toBeNull();
    expect((await page("a")).body).toBe("c\n");
    expect((await page("a")).repository).toBeNull();
    expect(gh.files().get("A.md")).toBe("c\n");
  });

  test("whoever connected it no longer an administrator: the sync stops until an administrator starts it again", async () => {
    const { deps } = await world({ "A.md": "a\n" });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    await connectWikiRepository(deps, admin.id, f.org.id, { repository: "acme/notes" });
    await settle(deps);
    await f.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, admin.id)));
    await requestWikiRepositorySync(f.db, f.org.id);
    expect(await syncWikiRepository(deps, f.org.id, await repositoryId())).toBe("stopped");
    expect((await getWikiRepository(f.db, f.owner.id, f.org.id))?.errorCode).toBe("wiki.repo_owner_gone");
    await resumeWikiRepository(deps, f.owner.id, f.org.id);
    expect((await repositoryRow())?.createdByUserId).toBe(f.owner.id);
    expect(await settle(deps)).toMatchObject({ pulled: 0, pushed: 0 });
  });
});
