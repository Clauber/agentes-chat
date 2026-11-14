import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, lt, or, schema } from "@agenteschat/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishOrgEvent } from "../events";
import { appRepoToken } from "../git/github-app";
import type { GitHubAppAccess } from "../git/github-call";
import { requirePermission } from "../organizations";
import { closedRefusal, orgStanding } from "../standing";
import {
  addWikiPageAliases,
  cleanFolder,
  createWikiPage,
  deleteWikiPage,
  moveWikiPage,
  renameWikiPage,
  restoreWikiPage,
  updateWikiPage,
  type WikiActor,
  type WikiDeps,
  WikiVersionConflictError,
  wikiRepositoryNote,
} from "../wiki";
import { gitBlobSha, noteFileText, notePath, pageOfPath, parseNoteFile, pathKey } from "./file";
import { GitHubBusy, githubRemote } from "./github";
import { queueWikiRepositorySync } from "./queue";
import { NOTE_MAX_BYTES, type NoteRemote, type RemoteNote, RepoRefusal } from "./remote";

const { wikiPages, wikiRepositories, wikiRepositoryFiles, users, agents } = schema;

type Repository = typeof wikiRepositories.$inferSelect;
type FileRow = typeof wikiRepositoryFiles.$inferSelect;
type Page = typeof wikiPages.$inferSelect;

export interface WikiRepositoryDeps {
  db: Database;
  pubsub?: PubSub;
  /** The server's GitHub App: a repository on GitHub is reached with its installation's token. Absent: no sync. */
  github?: GitHubAppAccess;
}

/** A sync holds its repository this long at most; one that died lets go by itself. */
const HOLD_MS = 10 * 60_000;
/** A sync that found another one running tries again this much later. */
const BUSY_RETRY_MS = 15_000;
/** Times one sync starts over when the branch moved under it; then the job tries again later. */
const ROUNDS = 3;
/**
 * Notes read from the repository in one sync, and files (and their bytes) written in one commit: the next sync takes
 * the rest.
 */
export const WIKI_REPOSITORY_BATCH = { read: 300, write: 200, bytes: 8 * 1024 * 1024 };

export type WikiRepositorySync =
  /** Not connected, stopped, or the workspace is closed. */
  | "off"
  /** Another sync holds it: it runs once more when that one ends. */
  | "busy"
  /** Stopped with a reason a person has to look at (`errorCode`). */
  | "stopped"
  | { pulled: number; pushed: number; more: boolean };

/** Why a write here was refused (a name too long, a folder too deep): the note is kept aside with it. */
const refusal = (error: unknown) =>
  error instanceof ValidationError || error instanceof ConflictError || error instanceof ForbiddenError
    ? error.code
    : error instanceof NotFoundError
      ? "wiki.page_not_found"
      : null;

const basename = (path: string) => path.split("/").pop() ?? path;
const dirname = (path: string) => path.split("/").slice(0, -1).join("/");

interface Sync {
  deps: WikiRepositoryDeps;
  /** The wiki as the sync writes it: its own saves queue no other sync. */
  wiki: WikiDeps;
  link: Repository;
  remote: NoteRemote;
  actor: WikiActor;
  /** The commit being synced with: the versions it brings say which. */
  head: string;
  /** Every note the repository lists (after a pull: as the wiki now has them), by path. */
  files: Map<string, RemoteNote>;
  rows: Map<string, FileRow>;
}

/** Whoever keeps the wiki in a repository: connects it, starts it again, and is who its changes are saved for. */
export const WIKI_REPOSITORY_PERMISSION = "administrator" as const;

/**
 * One sync of a workspace's wiki with its repository (job `wiki.repository.sync`, ADR 0186). First what the repository
 * changed comes in: a new note is a new page, a changed one a new version, a removed one goes to the trash, a moved or
 * renamed one moves or renames its page. Then what the wiki changed goes out as one commit. Where both changed a note,
 * the repository's text stays and ours is the version before it in the page's history.
 *
 * Left alone: a page limited to some people, which never goes to the repository (one that was there leaves it).
 */
export async function syncWikiRepository(
  deps: WikiRepositoryDeps,
  orgId: string,
  repositoryId: string,
): Promise<WikiRepositorySync> {
  const { db } = deps;
  if (closedRefusal(await orgStanding(db, orgId))) return "off";
  const now = new Date();
  const [link] = await db
    .update(wikiRepositories)
    .set({ syncingUntil: new Date(now.getTime() + HOLD_MS), dirty: false })
    .where(
      and(
        eq(wikiRepositories.id, repositoryId),
        eq(wikiRepositories.orgId, orgId),
        eq(wikiRepositories.status, "active"),
        or(isNull(wikiRepositories.syncingUntil), lt(wikiRepositories.syncingUntil, now)),
      ),
    )
    .returning();
  if (!link) {
    // Held by another sync: this one comes back once that has had time to end. `dirty` stays set meanwhile, so no
    // other change queues a job of its own: one waits at a time.
    const [held] = await db
      .update(wikiRepositories)
      .set({ dirty: true })
      .where(and(eq(wikiRepositories.id, repositoryId), eq(wikiRepositories.status, "active")))
      .returning({ id: wikiRepositories.id });
    if (!held) return "off";
    await queueWikiRepositorySync(db, orgId, repositoryId, new Date(Date.now() + BUSY_RETRY_MS));
    return "busy";
  }
  let outcome: WikiRepositorySync = "stopped";
  let stop: string | null = null;
  let unreachable = false;
  try {
    outcome = await run(deps, link);
  } catch (error) {
    if (!(error instanceof RepoRefusal)) {
      // The host didn't answer: the job tries again, and the app says so meanwhile. Anything else (a page saved this
      // very instant) just tries again.
      unreachable = error instanceof GitHubBusy;
      throw error;
    }
    stop = error.code;
  } finally {
    const done = typeof outcome === "object" ? outcome : null;
    const at = new Date();
    // What changed while it ran flipped `dirty` and queued the next sync already.
    const [after] = await db
      .update(wikiRepositories)
      .set({
        syncingUntil: null,
        updatedAt: at,
        ...(stop ? { status: "error", errorCode: stop, dirty: false } : {}),
        ...(unreachable ? { errorCode: "wiki.repo_unreachable" } : {}),
        ...(done ? { syncedAt: at, errorCode: null } : {}),
      })
      .where(eq(wikiRepositories.id, link.id))
      .returning({ status: wikiRepositories.status, errorCode: wikiRepositories.errorCode });
    if (after?.status === "active" && done?.more) await queueWikiRepositorySync(db, orgId, link.id);
    const changed =
      (done !== null && (done.pulled > 0 || done.pushed > 0)) ||
      after?.status !== link.status ||
      (after?.errorCode ?? null) !== link.errorCode;
    // The apps read the wiki again: what each page's note holds, and how the repository is going.
    if (after && changed) {
      await publishOrgEvent(deps.pubsub, {
        type: "org.broadcast",
        orgId,
        event: { type: "wiki.page.updated", action: "repository", page: { id: "", restricted: true } },
      });
    }
  }
  return outcome;
}

/** The repository's host, reached as the workspace: GitHub through the server's app installed on that repository. */
async function remoteOf(deps: WikiRepositoryDeps, link: Repository): Promise<NoteRemote> {
  if (link.provider !== "github") throw new RepoRefusal("wiki.repo_provider");
  const app = deps.github?.app();
  if (!app || !deps.github) throw new RepoRefusal("wiki.repo_no_app");
  const got = await appRepoToken(app, deps.github.http, { db: deps.db, orgId: link.orgId }, link.owner, link.repo, {
    contents: "write",
  });
  if ("miss" in got) {
    if (got.miss === "unreachable") throw new GitHubBusy("GitHub didn't answer for the app's token");
    throw new RepoRefusal(got.miss === "refused" ? "wiki.repo_refused" : "wiki.repo_not_installed");
  }
  return githubRemote({ http: deps.github.http, token: got.token, owner: link.owner, repo: link.repo });
}

async function run(deps: WikiRepositoryDeps, link: Repository) {
  const { db } = deps;
  const orgId = link.orgId;
  // What the repository changes is saved with the rights of who connected it, while they still hold them.
  const userId = link.createdByUserId;
  if (!userId) throw new RepoRefusal("wiki.repo_owner_gone");
  await requirePermission(db, userId, orgId, WIKI_REPOSITORY_PERMISSION).catch(() => {
    throw new RepoRefusal("wiki.repo_owner_gone");
  });
  const remote = await remoteOf(deps, link);
  let pulled = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const head = await remote.head(link.branch);
    if (head === "missing") throw new RepoRefusal("wiki.repo_branch_missing");
    if (head === "empty") throw new RepoRefusal("wiki.repo_empty");
    const rowList = await db.select().from(wikiRepositoryFiles).where(eq(wikiRepositoryFiles.repositoryId, link.id));
    // The branch is where we left it: what it holds is what we remember, and nothing more is asked of the host. A
    // round after the branch moved lists it again.
    const listed = round === 0 && head === link.headSha ? null : await remote.list(head, link.path);
    const sync: Sync = {
      deps,
      wiki: { db, pubsub: deps.pubsub, fromRepository: true },
      link,
      remote,
      actor: { type: "person", userId },
      head,
      files: listed?.files ?? new Map(rowList.map((r) => [r.path, { sha: r.blobSha, size: 0 }])),
      rows: new Map(rowList.map((r) => [r.path, r])),
    };
    // A folder that held the wiki and now lists nothing was renamed or emptied: nothing is thrown away on that.
    if (listed?.files.size === 0 && rowList.some((r) => r.pageId && !r.detached)) {
      throw new RepoRefusal("wiki.repo_folder_missing");
    }
    const got = listed ? await pull(sync) : { count: 0, more: false };
    pulled += got.count;
    // Notes still to read: nothing is written before every note has its page, or a page could take a note's path.
    if (got.more) return { pulled, pushed: 0, more: true };
    const pushed = await push(sync);
    if (pushed === "moved") continue;
    await db.update(wikiRepositories).set({ headSha: pushed.head }).where(eq(wikiRepositories.id, link.id));
    return { pulled, pushed: pushed.count, more: pushed.more };
  }
  // Someone keeps pushing: the job tries again a little later.
  throw new Error("the branch kept moving while syncing");
}

// ── Rows ─────────────────────────────────────────────────────────────────────

type RowValues = Pick<FileRow, "path" | "blobSha"> &
  Partial<Pick<FileRow, "pageId" | "pageVersion" | "title" | "folder" | "head" | "detached" | "issue">>;

async function saveRow(sync: Sync, values: RowValues) {
  const full = {
    pageId: null,
    pageVersion: 0,
    title: "",
    folder: "",
    head: "",
    detached: false,
    issue: null,
    ...values,
    updatedAt: new Date(),
  };
  const [row] = await sync.deps.db
    .insert(wikiRepositoryFiles)
    .values({ orgId: sync.link.orgId, repositoryId: sync.link.id, ...full })
    .onConflictDoUpdate({ target: [wikiRepositoryFiles.repositoryId, wikiRepositoryFiles.path], set: full })
    .returning();
  if (row) sync.rows.set(row.path, row);
  return row;
}

async function dropRow(sync: Sync, row: FileRow) {
  await sync.deps.db.delete(wikiRepositoryFiles).where(eq(wikiRepositoryFiles.id, row.id));
  if (sync.rows.get(row.path)?.id === row.id) sync.rows.delete(row.path);
}

const pageById = async (db: Database, orgId: string, id: string): Promise<Page | null> =>
  (
    await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.id, id), eq(wikiPages.orgId, orgId)))
  )[0] ?? null;

/** What a row remembers of a page as both sides now hold it. */
const tiedTo = (page: Pick<Page, "id" | "version" | "title" | "folder">) => ({
  pageId: page.id,
  pageVersion: page.version,
  title: page.title,
  folder: page.folder,
});

// ── From the repository ──────────────────────────────────────────────────────

/** A note of the repository as a new page; one that can't be a page is kept with why, until its file changes. */
async function createFromNote(sync: Sync, path: string, sha: string, text: string) {
  const { link, wiki, actor } = sync;
  const note = parseNoteFile(text);
  const at = pageOfPath(path);
  try {
    const view = await createWikiPage(
      wiki,
      actor,
      link.orgId,
      {
        title: at.title,
        folder: at.folder,
        body: note.body,
        tags: note.tags,
        note: wikiRepositoryNote(sync.head),
        source: { type: "github", id: `${link.owner}/${link.repo}` },
      },
      { allowDuplicate: true },
    );
    if (note.aliases.length) await addWikiPageAliases(wiki.db, link.orgId, view.id, note.aliases);
    await saveRow(sync, {
      path,
      blobSha: sha,
      ...tiedTo(view),
      head: note.head,
      // It landed in a folder limited to some people here: the page keeps that, and the two stop following each other.
      detached: view.audience !== null,
    });
  } catch (error) {
    const code = refusal(error);
    if (!code) throw error;
    await saveRow(sync, { path, blobSha: sha, issue: code });
  }
}

/** A page takes its note's text and tags as a new version: the repository's wins over an edit made here meanwhile. */
async function updateFromNote(sync: Sync, row: FileRow, page: Page, sha: string, text: string) {
  const { link, wiki, actor } = sync;
  const note = parseNoteFile(text);
  try {
    const view = await updateWikiPage(wiki, actor, link.orgId, page.id, {
      baseVersion: page.version,
      body: note.body,
      tags: note.tags,
      note: wikiRepositoryNote(sync.head),
    });
    if (note.aliases.length) await addWikiPageAliases(wiki.db, link.orgId, view.id, note.aliases);
    // The name both sides agreed on stays: a page renamed or moved here meanwhile still moves its note.
    await saveRow(sync, {
      path: row.path,
      blobSha: sha,
      ...tiedTo(view),
      title: row.title,
      folder: row.folder,
      head: note.head,
    });
  } catch (error) {
    // Someone saved the page this instant: the job runs again and reads it fresh.
    if (error instanceof WikiVersionConflictError) throw new Error("the page changed while syncing");
    const code = refusal(error);
    if (!code) throw error;
    await saveRow(sync, { ...row, blobSha: sha, issue: code });
  }
}

/**
 * A page in the trash whose note changed in the repository: the note is still there, so the page comes back with its
 * history and links, and takes the note's text. False when it can't (its address taken meanwhile).
 */
async function restoreFromNote(sync: Sync, row: FileRow, page: Page, sha: string, text: string) {
  try {
    await restoreWikiPage(sync.wiki, sync.actor, sync.link.orgId, page.id);
  } catch (error) {
    if (refusal(error)) return false;
    throw error;
  }
  const back = await pageById(sync.deps.db, sync.link.orgId, page.id);
  if (!back || back.deletedAt) return false;
  await updateFromNote(sync, row, back, sha, text);
  return true;
}

/** A note moved or renamed in the repository (same text at another path): its page follows, history and links kept. */
async function followMoves(sync: Sync) {
  const { link, wiki, actor, files, rows } = sync;
  const gone = [...rows.values()].filter((r) => !files.has(r.path) && r.pageId && !r.detached && !r.issue);
  const fresh = [...files].filter(([path]) => !rows.has(path));
  for (const row of gone) {
    const same = fresh.filter(([, f]) => f.sha === row.blobSha);
    const only = same.length === 1 && gone.filter((g) => g.blobSha === row.blobSha).length === 1 ? same[0] : null;
    if (!only || !row.pageId) continue;
    const [to] = only;
    let page = await pageById(wiki.db, link.orgId, row.pageId);
    if (!page || page.deletedAt || page.restricted) continue;
    const at = pageOfPath(to);
    try {
      if (basename(to) !== basename(row.path) && at.title) {
        await renameWikiPage(wiki, actor, link.orgId, page.id, { title: at.title });
      }
      if (dirname(to) !== dirname(row.path)) {
        await moveWikiPage(wiki, actor, link.orgId, page.id, cleanFolder(dirname(to)));
      }
    } catch (error) {
      // A name another page holds, a folder too deep: the page stays as it is named here, at its note's new path.
      if (!refusal(error)) throw error;
    }
    page = (await pageById(wiki.db, link.orgId, page.id)) ?? page;
    await dropRow(sync, row);
    await saveRow(sync, { path: to, blobSha: row.blobSha, ...tiedTo(page), head: row.head });
  }
}

/** The live, open pages no note is tied to yet, by the path their note would have: a note already there is theirs. */
async function unlinkedByPath(sync: Sync) {
  const tied = new Set([...sync.rows.values()].map((r) => r.pageId).filter(Boolean));
  const pages = await sync.deps.db
    .select({ id: wikiPages.id, title: wikiPages.title, folder: wikiPages.folder })
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, sync.link.orgId), isNull(wikiPages.deletedAt), eq(wikiPages.restricted, false)));
  const byPath = new Map<string, string>();
  for (const p of pages) {
    const key = pathKey(notePath(p));
    if (!tied.has(p.id) && !byPath.has(key)) byPath.set(key, p.id);
  }
  return byPath;
}

async function pull(sync: Sync) {
  const { link, files, rows, remote } = sync;
  const { db } = sync.deps;
  let read = 0;
  let count = 0;
  let more = false;
  await followMoves(sync);
  const waiting = await unlinkedByPath(sync);
  for (const [path, file] of files) {
    const row = rows.get(path);
    if (row && row.blobSha === file.sha) continue;
    const page = row?.pageId ? await pageById(db, link.orgId, row.pageId) : null;
    // Limited to some people here: the note is left as it is there, and the page as it is here.
    if (row?.detached && (!page || page.deletedAt || page.restricted)) {
      await saveRow(sync, { ...row, blobSha: file.sha });
      continue;
    }
    if (file.size > NOTE_MAX_BYTES) {
      await saveRow(sync, { ...(row ?? { path }), blobSha: file.sha, issue: "wiki.body_too_long" });
      continue;
    }
    if (read >= WIKI_REPOSITORY_BATCH.read) {
      more = true;
      break;
    }
    read++;
    const text = await remote.read(file.sha);
    count++;
    if (row && page && !page.deletedAt) {
      if (page.restricted) await saveRow(sync, { ...row, blobSha: file.sha, detached: true });
      else await updateFromNote(sync, row, page, file.sha, text);
      continue;
    }
    if (row && page?.deletedAt && !page.restricted && (await restoreFromNote(sync, row, page, file.sha, text))) {
      continue;
    }
    // The first sync of a wiki that already had this page: the two are tied, and the note's text is the page's.
    const waits = row ? undefined : waiting.get(pathKey(path));
    const adopted = waits ? await pageById(db, link.orgId, waits) : null;
    if (adopted && !adopted.deletedAt) {
      waiting.delete(pathKey(path));
      const note = parseNoteFile(text);
      const base = { path, blobSha: file.sha, ...tiedTo(adopted), head: note.head };
      if (noteFileText(adopted, note.head).text === text) await saveRow(sync, base);
      else {
        const tied = await saveRow(sync, base);
        if (tied) await updateFromNote(sync, tied, adopted, file.sha, text);
      }
      continue;
    }
    await createFromNote(sync, path, file.sha, text);
  }
  if (more) return { count, more };
  // Notes the repository no longer has: their pages go to the trash, where they wait as any deleted page does.
  for (const row of [...rows.values()]) {
    if (files.has(row.path)) continue;
    const page = row.pageId && !row.detached ? await pageById(db, link.orgId, row.pageId) : null;
    if (page && !page.deletedAt && !page.restricted) {
      try {
        await deleteWikiPage(sync.wiki, sync.actor, link.orgId, page.id);
        count++;
      } catch (error) {
        if (!refusal(error)) throw error;
      }
    }
    await dropRow(sync, row);
  }
  return { count, more };
}

// ── To the repository ────────────────────────────────────────────────────────

/** `path`, or `Name (2).md`… while another note holds it (as disks compare names: `pathKey`). */
function freePath(path: string, taken: Set<string>) {
  if (!taken.has(pathKey(path))) return path;
  const stem = path.replace(/\.md$/, "");
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} (${n}).md`;
    if (!taken.has(pathKey(next))) return next;
  }
  return `${stem} (${Date.now()}).md`;
}

/** Who last wrote each page, by name, for the commit's message. */
async function writers(db: Database, pages: Page[]) {
  const ids = (type: string) => [...new Set(pages.filter((p) => p.updatedByType === type).map((p) => p.updatedById))];
  const people = ids("person");
  const bots = ids("agent");
  const names = new Map<string, string>();
  if (people.length) {
    for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people))) {
      names.set(u.id, u.name);
    }
  }
  if (bots.length) {
    for (const a of await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, bots))) {
      names.set(a.id, a.name);
    }
  }
  return names;
}

/** One commit with what the wiki changed since both sides last agreed; `moved` when the branch moved meanwhile. */
async function push(sync: Sync) {
  const { link, files, rows, remote, head } = sync;
  const { db } = sync.deps;
  const live = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      folder: wikiPages.folder,
      version: wikiPages.version,
      restricted: wikiPages.restricted,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, link.orgId), isNull(wikiPages.deletedAt)));
  const liveIds = new Set(live.map((p) => p.id));
  const byPage = new Map([...rows.values()].filter((r) => r.pageId).map((r) => [r.pageId as string, r]));
  const taken = new Set([...files.keys(), ...rows.keys()].map(pathKey));
  const writes: { path: string; text: string; head: string; sha: string; page: Page; from: FileRow | null }[] = [];
  const removes = new Set<string>();
  const dropped: FileRow[] = [];
  let bytes = 0;
  let more = false;

  for (const light of live) {
    const row = byPage.get(light.id) ?? null;
    if (light.restricted) {
      // Limited to some people since it was written there: its note leaves the repository.
      if (row && !row.detached) {
        if (files.has(row.path)) removes.add(row.path);
        dropped.push(row);
      }
      continue;
    }
    // A note the wiki can't read (too long): its page isn't written over it.
    if (row?.issue) continue;
    // Nothing new: the version both sides hold, under the name they agreed on.
    const same = row && light.title === row.title && light.folder === row.folder;
    if (row && same && row.pageVersion === light.version && !row.detached) continue;
    if (writes.length >= WIKI_REPOSITORY_BATCH.write || bytes >= WIKI_REPOSITORY_BATCH.bytes) {
      more = true;
      break;
    }
    const page = await pageById(db, link.orgId, light.id);
    if (!page || page.deletedAt) continue;
    const moved = row !== null && (page.title !== row.title || page.folder !== row.folder);
    // Its own old path is free for it: a rename that only changes the letters' case keeps the name.
    if (row && moved) taken.delete(pathKey(row.path));
    const path = !row || moved ? freePath(notePath(page), taken) : row.path;
    const { head: top, text } = noteFileText(page, row?.head ?? "");
    const sha = gitBlobSha(text);
    if (row && !moved && (sha === row.blobSha || files.get(path)?.sha === sha)) {
      // Nothing a file holds changed (a pin, a lock, an audience): only what we remember of it.
      await saveRow(sync, { ...row, blobSha: sha, ...tiedTo(page), detached: false, head: top });
      continue;
    }
    taken.add(pathKey(path));
    bytes += Buffer.byteLength(text, "utf8");
    writes.push({ path, text, head: top, sha, page, from: row });
    if (row && moved && files.has(row.path)) removes.add(row.path);
  }
  // Pages deleted here, or gone for good: their notes leave the repository.
  for (const row of rows.values()) {
    if (row.detached || row.issue || (row.pageId && liveIds.has(row.pageId))) continue;
    if (files.has(row.path)) removes.add(row.path);
    dropped.push(row);
  }
  for (const w of writes) removes.delete(w.path);

  let at = head;
  if (writes.length || removes.size) {
    const names = await writers(
      db,
      writes.map((w) => w.page),
    );
    const prefix = link.path ? `${link.path}/` : "";
    const lines = [
      ...writes.map((w) => `- ${w.path}${names.has(w.page.updatedById) ? ` (${names.get(w.page.updatedById)})` : ""}`),
      ...[...removes].map((path) => `- removed ${path}`),
    ];
    const first = writes[0];
    const subject =
      writes.length === 1 && removes.size <= 1 && first
        ? `Update wiki: ${first.page.title}`
        : `Update wiki: ${writes.length + removes.size} notes`;
    const made = await remote.commit({
      branch: link.branch,
      parent: head,
      message: `${subject}\n\n${lines.join("\n")}`,
      writes: writes.map((w) => ({ path: `${prefix}${w.path}`, text: w.text })),
      removes: [...removes].map((path) => `${prefix}${path}`),
    });
    // Someone pushed meanwhile: nothing was written, and the sync starts over from the new head.
    if (made === "moved") return "moved" as const;
    at = made;
  }
  for (const row of dropped) await dropRow(sync, row);
  for (const w of writes) {
    if (w.from && w.from.path !== w.path) await dropRow(sync, w.from);
    await saveRow(sync, { path: w.path, blobSha: w.sha, ...tiedTo(w.page), head: w.head });
  }
  return { head: at, count: writes.length + removes.size, more };
}
