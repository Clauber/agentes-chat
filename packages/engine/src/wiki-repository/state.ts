import { and, type Executor, eq, schema } from "@agenteschat/db";
import { noteUrl } from "./remote";

const { wikiRepositories, wikiRepositoryFiles } = schema;

/** A page's note in the wiki's repository (ADR 0186), as its page shows it. */
export interface WikiPageRepository {
  /**
   * `synced`: the note holds this version. `pending`: this version is still to be written there (in a moment, or once
   * the sync is started again: `stopped`). `local`: limited to some people, it never goes there. `held`: the note
   * couldn't be read here (too long), so the page isn't written over it.
   */
  state: "synced" | "pending" | "local" | "held";
  /** The sync stopped until someone starts it again. */
  stopped: boolean;
  /** The note's address, once it has one. */
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
  if (page.restricted || row?.detached) return { state: "local", stopped, url: null };
  if (row?.issue) return { state: "held", stopped, url };
  return { state: row && row.pageVersion === page.version ? "synced" : "pending", stopped, url };
}
