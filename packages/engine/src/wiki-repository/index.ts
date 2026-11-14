import { and, type Database, eq, isNotNull, isNull, or, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ValidationError } from "../errors";
import { appRepoToken } from "../git/github-app";
import { parseRepo } from "../git/repos";
import { requireActiveMembership, requirePermission } from "../organizations";
import { githubRemote, githubRepoFacts } from "./github";
import { requestWikiRepositorySync } from "./queue";
import { RepoRefusal, repositoryUrl } from "./remote";
import { WIKI_REPOSITORY_PERMISSION, type WikiRepositoryDeps } from "./sync";

export * from "./file";
export * from "./queue";
export * from "./remote";
export * from "./state";
export * from "./sync";

const { wikiRepositories, wikiRepositoryFiles, wikiPages } = schema;

type Repository = typeof wikiRepositories.$inferSelect;

/** The repository a workspace keeps its wiki in, as the app shows it. */
export interface WikiRepositoryView {
  /** Where it is hosted: `github`. */
  provider: string;
  owner: string;
  repo: string;
  branch: string;
  /** The folder the notes are under; empty = the repository's root. */
  path: string;
  /** The repository's page. */
  url: string;
  /**
   * `error`: stopped, with why in `errorCode` (`wiki.repo_not_installed`, `wiki.repo_branch_missing`…). While
   * `active`, an `errorCode` is a trouble the sync is getting past by itself (`wiki.repo_unreachable`).
   */
  status: "active" | "error";
  errorCode: string | null;
  /** A sync is running or about to. */
  syncing: boolean;
  syncedAt: string | null;
  /** Notes that are pages. */
  notes: number;
  /** Pages whose last version is still to be written there. */
  pending: number;
  /** Notes that couldn't become pages (too long, no usable name), by path with why. */
  held: { path: string; code: string }[];
}

/** The most notes held aside the app lists. */
const HELD_SHOWN = 50;

async function viewOf(db: Database, row: Repository): Promise<WikiRepositoryView> {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wikiRepositoryFiles)
    .where(and(eq(wikiRepositoryFiles.repositoryId, row.id), isNotNull(wikiRepositoryFiles.pageId)));
  const [waiting] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wikiPages)
    .leftJoin(
      wikiRepositoryFiles,
      and(eq(wikiRepositoryFiles.repositoryId, row.id), eq(wikiRepositoryFiles.pageId, wikiPages.id)),
    )
    .where(
      and(
        eq(wikiPages.orgId, row.orgId),
        isNull(wikiPages.deletedAt),
        eq(wikiPages.restricted, false),
        or(
          isNull(wikiRepositoryFiles.id),
          eq(wikiRepositoryFiles.detached, true),
          and(isNull(wikiRepositoryFiles.issue), sql`${wikiRepositoryFiles.pageVersion} <> ${wikiPages.version}`),
        ),
      ),
    );
  const held = await db
    .select({ path: wikiRepositoryFiles.path, code: wikiRepositoryFiles.issue })
    .from(wikiRepositoryFiles)
    .where(and(eq(wikiRepositoryFiles.repositoryId, row.id), isNotNull(wikiRepositoryFiles.issue)))
    .orderBy(wikiRepositoryFiles.path)
    .limit(HELD_SHOWN);
  return {
    provider: row.provider,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    path: row.path,
    url: repositoryUrl(row),
    status: row.status === "error" ? "error" : "active",
    errorCode: row.errorCode,
    syncing: row.status === "active" && (row.dirty || (row.syncingUntil !== null && row.syncingUntil > new Date())),
    syncedAt: row.syncedAt?.toISOString() ?? null,
    notes: count?.n ?? 0,
    pending: waiting?.n ?? 0,
    held: held.map((h) => ({ path: h.path, code: h.code ?? "" })),
  };
}

const rowOf = async (db: Database, orgId: string) =>
  (await db.select().from(wikiRepositories).where(eq(wikiRepositories.orgId, orgId)))[0] ?? null;

/** The repository the workspace's wiki is kept in, for any member; null when it has none. */
export async function getWikiRepository(db: Database, userId: string, orgId: string) {
  await requireActiveMembership(db, userId, orgId);
  const row = await rowOf(db, orgId);
  return row ? viewOf(db, row) : null;
}

/** `notes/wiki` from ` /notes//wiki/ `; a path that climbs out or names a hidden folder is refused. */
function cleanPath(path: string | undefined) {
  const parts = (path ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (
    parts.some((p) => p === "." || p === ".." || p.startsWith(".") || p.toLowerCase() === "node_modules") ||
    parts.join("/").length > 300
  ) {
    throw new ValidationError("That folder can't hold the wiki", "wiki.repo_path_invalid");
  }
  return parts.join("/");
}

export interface WikiRepositoryInput {
  /** `owner/name`, or the repository's address on GitHub. */
  repository: string;
  /** Left out: the repository's default branch. */
  branch?: string;
  /** The folder the notes are under; left out: the repository's root. */
  path?: string;
}

/**
 * Keeps the workspace's wiki in a GitHub repository (an administrator): the notes under that folder become pages, the
 * wiki's pages become notes there, and from then on each side follows the other, the repository being the source. The
 * repository is reached through the GitHub App's installation on it for this workspace, which must let it write.
 * Connecting another repository replaces the one before; the pages stay.
 */
export async function connectWikiRepository(
  deps: WikiRepositoryDeps,
  userId: string,
  orgId: string,
  input: WikiRepositoryInput,
): Promise<WikiRepositoryView> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, WIKI_REPOSITORY_PERMISSION);
  const named = parseRepo(input.repository);
  if (!named) throw new ValidationError("Name the repository as owner/name", "wiki.repo_invalid");
  const path = cleanPath(input.path);
  const app = deps.github?.app();
  if (!app || !deps.github) {
    throw new ValidationError("This server has no GitHub App to reach repositories with", "wiki.repo_no_app");
  }
  const got = await appRepoToken(app, deps.github.http, { db, orgId }, named.owner, named.repo, { contents: "write" });
  if ("miss" in got) {
    if (got.miss === "unreachable") throw new ValidationError("Could not reach GitHub", "github.unreachable");
    throw got.miss === "refused"
      ? new ValidationError("The GitHub App may not write to that repository", "wiki.repo_refused")
      : new ValidationError("The GitHub App isn't installed on that repository", "wiki.repo_not_installed");
  }
  const api = { http: deps.github.http, token: got.token, owner: named.owner, repo: named.repo };
  const facts = await githubRepoFacts(api).catch(() => {
    throw new ValidationError("Could not reach GitHub", "github.unreachable");
  });
  if (!facts) throw new ValidationError("The GitHub App isn't installed on that repository", "wiki.repo_not_installed");
  const branch = input.branch?.trim() || facts.defaultBranch;
  const head = await githubRemote({ ...api, owner: facts.owner, repo: facts.repo })
    .head(branch)
    .catch((error: unknown) => {
      if (error instanceof RepoRefusal) {
        throw new ValidationError("The GitHub App may not read that repository", "wiki.repo_refused");
      }
      throw new ValidationError("Could not reach GitHub", "github.unreachable");
    });
  if (head === "missing") throw new ValidationError("That branch doesn't exist", "wiki.repo_branch_missing");
  if (head === "empty") {
    throw new ValidationError("That repository has no commit yet: add a first file to it", "wiki.repo_empty");
  }
  const row = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(wikiRepositories).where(eq(wikiRepositories.orgId, orgId));
    const same =
      before &&
      before.provider === "github" &&
      before.owner.toLowerCase() === facts.owner.toLowerCase() &&
      before.repo.toLowerCase() === facts.repo.toLowerCase() &&
      before.branch === branch &&
      before.path === path;
    // Another repository, branch or folder: what was remembered of the one before no longer says anything.
    if (before && !same) await tx.delete(wikiRepositories).where(eq(wikiRepositories.id, before.id));
    const [saved] =
      before && same
        ? await tx
            .update(wikiRepositories)
            .set({ status: "active", errorCode: null, dirty: false, createdByUserId: userId, updatedAt: new Date() })
            .where(eq(wikiRepositories.id, before.id))
            .returning()
        : await tx
            .insert(wikiRepositories)
            .values({
              orgId,
              provider: "github",
              owner: facts.owner,
              repo: facts.repo,
              branch,
              path,
              createdByUserId: userId,
            })
            .returning();
    if (!saved) throw new Error("wiki repository insert returned nothing");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "wiki.repository_connected",
      target: { type: "wiki", id: orgId },
      details: { provider: "github", repository: `${facts.owner}/${facts.repo}`, branch, path },
    });
    await requestWikiRepositorySync(tx, orgId);
    return saved;
  });
  return viewOf(db, { ...row, dirty: true });
}

/** Stops keeping the wiki in its repository: the pages stay here and the notes stay there, as they are. */
export async function disconnectWikiRepository(deps: WikiRepositoryDeps, userId: string, orgId: string) {
  const { db } = deps;
  await requirePermission(db, userId, orgId, WIKI_REPOSITORY_PERMISSION);
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(wikiRepositories).where(eq(wikiRepositories.orgId, orgId)).returning();
    if (!gone) return;
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "wiki.repository_disconnected",
      target: { type: "wiki", id: orgId },
      details: {
        provider: gone.provider,
        repository: `${gone.owner}/${gone.repo}`,
        branch: gone.branch,
        path: gone.path,
      },
    });
  });
}

/**
 * Syncs now, and starts a stopped sync again (an administrator): what stopped it is tried once more, with that person
 * as who the repository's changes are saved for.
 */
export async function resumeWikiRepository(deps: WikiRepositoryDeps, userId: string, orgId: string) {
  const { db } = deps;
  await requirePermission(db, userId, orgId, WIKI_REPOSITORY_PERMISSION);
  const row = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(wikiRepositories).where(eq(wikiRepositories.orgId, orgId));
    if (!before) return null;
    const [saved] = await tx
      .update(wikiRepositories)
      .set({ status: "active", errorCode: null, createdByUserId: userId, dirty: false, updatedAt: new Date() })
      .where(eq(wikiRepositories.id, before.id))
      .returning();
    if (before.status === "error") {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "wiki.repository_resumed",
        target: { type: "wiki", id: orgId },
        details: { repository: `${before.owner}/${before.repo}`, stoppedWith: before.errorCode },
      });
    }
    await requestWikiRepositorySync(tx, orgId);
    return saved ?? null;
  });
  return row ? viewOf(db, { ...row, dirty: true }) : null;
}
