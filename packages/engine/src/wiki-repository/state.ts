import { and, type Executor, eq, inArray, isNotNull, schema } from "@agenteschat/db";
import { noteUrl } from "./remote";

const { wikiPageVersions, wikiRepositories, wikiRepositoryFiles } = schema;

/** A page's note in the wiki's repository (ADR 0186), as its page shows it. */
export interface WikiPageRepository {
  /**
   * `synced`: the note holds this version. `pending`: this version is still to be written there (in a moment, or once
   * the sync is started again: `stopped`). `review`: it waits in the wiki's pull request (`url`) for someone to merge
   * it. `declined`: that pull request was closed without merging: it stays here until it changes again. `local`:
   * limited to some people, or the repository is followed read-only, so it stays here. `held`: the note couldn't be
   * read here (too long), so the page isn't written over it.
   */
  state: "synced" | "pending" | "review" | "declined" | "local" | "held";
  /** The sync stopped until someone starts it again. */
  stopped: boolean;
  /** The repository is followed read-only: what changes here stays here (`local`) until the note changes there. */
  readOnly: boolean;
  /** The note's address, once it has one; for `review` and `declined`, the pull request's. */
  url: string | null;
  /**
   * The version made here that the repository's text replaced, both having changed the same lines: said while the page
   * is still at the repository's version (it is in the history). Null otherwise.
   */
  replaced: number | null;
}

/** `synced from the repository at <commit>, over version <n>` (`wikiRepositoryNote`), read back without the wiki. */
const OVER = /^synced from the repository at \S+, over version (\d+)$/;

/** Where a page stands with the wiki's repository; null when the wiki has none. One small read when it has none. */
export async function wikiPageRepository(
  db: Executor,
  page: { id: string; orgId: string; version: number; restricted: boolean },
): Promise<WikiPageRepository | null> {
  const [link] = await db.select().from(wikiRepositories).where(eq(wikiRepositories.orgId, page.orgId));
  if (!link) return null;
  const stopped = link.status === "error";
  const readOnly = !link.writable || link.commitMode === "none";
  const [row] = await db
    .select({
      path: wikiRepositoryFiles.path,
      pageVersion: wikiRepositoryFiles.pageVersion,
      detached: wikiRepositoryFiles.detached,
      issue: wikiRepositoryFiles.issue,
    })
    .from(wikiRepositoryFiles)
    .where(and(eq(wikiRepositoryFiles.repositoryId, link.id), eq(wikiRepositoryFiles.pageId, page.id)))
    .limit(1);
  const url = row && !row.detached ? noteUrl(link, row.path) : null;
  const base = { stopped, readOnly, replaced: null };
  if (page.restricted || row?.detached) return { ...base, state: "local", url: null };
  if (row?.issue) return { ...base, state: "held", url };
  if (row && row.pageVersion === page.version) {
    // The repository's version, written over one made here: one more small read, only for a page that is synced.
    const [current] = await db
      .select({ note: wikiPageVersions.note })
      .from(wikiPageVersions)
      .where(and(eq(wikiPageVersions.pageId, page.id), eq(wikiPageVersions.version, page.version)));
    const over = OVER.exec(current?.note ?? "");
    return { ...base, state: "synced", url, replaced: over ? Number(over[1]) : null };
  }
  if (readOnly) return { ...base, state: "local", url };
  // Through a pull request: this version is in it (or was, and was declined).
  const proposed = Object.values(link.prFiles ?? {}).find((f) => f.pageId === page.id);
  if (link.commitMode === "pull_request" && proposed?.version === page.version && link.prUrl) {
    return { ...base, state: link.prState === "declined" ? "declined" : "review", url: link.prUrl };
  }
  return { ...base, state: "pending", url };
}

/**
 * Of `pageIds`, the pages whose text came from a repository the workspace doesn't write to: a public one it follows
 * read-only, which whoever keeps it on GitHub writes, not the team. What agents read of them is outside text (ADR
 * 0053), as an email is. One small read when the wiki follows no such repository.
 */
export async function outsideWikiPages(db: Executor, orgId: string, pageIds: readonly string[]): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const [link] = await db
    .select({ id: wikiRepositories.id, public: wikiRepositories.public, writable: wikiRepositories.writable })
    .from(wikiRepositories)
    .where(eq(wikiRepositories.orgId, orgId));
  if (!link?.public || link.writable) return new Set();
  const rows = await db
    .select({ pageId: wikiRepositoryFiles.pageId })
    .from(wikiRepositoryFiles)
    .where(
      and(
        eq(wikiRepositoryFiles.repositoryId, link.id),
        isNotNull(wikiRepositoryFiles.pageId),
        inArray(wikiRepositoryFiles.pageId, [...pageIds]),
      ),
    );
  return new Set(rows.map((r) => r.pageId).filter((id): id is string => id !== null));
}
