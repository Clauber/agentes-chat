import { and, type Executor, eq, schema } from "@agenteschat/db";
import { noteUrl } from "./remote";

const { wikiRepositories, wikiRepositoryFiles } = schema;

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
}

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
  if (page.restricted || row?.detached) return { state: "local", stopped, readOnly, url: null };
  if (row?.issue) return { state: "held", stopped, readOnly, url };
  if (row && row.pageVersion === page.version) return { state: "synced", stopped, readOnly, url };
  if (readOnly) return { state: "local", stopped, readOnly, url };
  // Through a pull request: this version is in it (or was, and was declined).
  const proposed = Object.values(link.prFiles ?? {}).find((f) => f.pageId === page.id);
  if (link.commitMode === "pull_request" && proposed?.version === page.version && link.prUrl) {
    return { state: link.prState === "declined" ? "declined" : "review", stopped, readOnly, url: link.prUrl };
  }
  return { state: "pending", stopped, readOnly, url };
}
