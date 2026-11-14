# 0186. The wiki kept in a git repository, the repository being the source

- Status: Accepted (built: GitHub, through the server's GitHub App). An option per workspace, off until an
  administrator connects a repository
- Date: 2026-11-14
- Amends: ADR 0023 (the wiki's pages lived in Postgres alone). Builds on ADR 0156 (the GitHub App is the workspace's
  identity on GitHub)
- Code: `packages/engine/src/wiki-repository/` (`sync.ts` the sync, `remote.ts` the host as the sync sees it,
  `github.ts` GitHub's git data API, `file.ts` the note format, `queue.ts` the jobs and the `push` webhook, `state.ts`
  each page's note, `index.ts` connect, start again and disconnect); hooks in `wiki.ts` (`followRepository`,
  `wikiRepositoryNote`, `addWikiPageAliases`, `WikiPageView.repository`); routes `apps/server/src/routes/app/wiki.ts`
  (`/organizations/{orgId}/wiki/repository`), the webhook in `apps/server/src/routes/github-app.ts`, the periodic look
  in `apps/server/src/workers.ts`; web `apps/web/src/components/wiki/WikiRepository.tsx`; tables
  `wiki_repositories`, `wiki_repository_files` (migration 0274); tests `packages/engine/test/wiki-repository.test.ts`

## Context

Many teams already keep their notes as Markdown files in git: a folder of docs next to the code, or a note-taking
vault pushed to GitHub by a plugin. The wiki's import (ADR 0023) copies such notes once, and from then on the two
drift: what someone writes in the repository never reaches the wiki, and what agents and people write in the wiki
never reaches the repository. Teams don't want a second copy of what they know to keep by hand.

## Decision

1. **An option per workspace.** An administrator keeps the wiki in one repository: one branch (the default one unless
   another is named) and one folder (the whole repository unless one is named). Connecting another repository,
   branch or folder replaces the one before; disconnecting leaves the pages here and the notes there as they are.
   Administrators only: connecting writes every page that isn't limited to some people into a place everyone with
   access to the repository reads.
2. **The repository is the source.** Each side follows the other. When both changed a note since they last agreed,
   the repository's text is the page's new version and the one written here is the version before it, in the page's
   history: nothing is lost, and the repository is never written over. A locked page follows the repository too: the
   lock says who edits here. A page sent to the trash here whose note changed there comes back, with its history and
   links.
3. **A note is a page.** Every `.md`/`.markdown` file under the folder is a page: its path is the page's folder and
   title, its frontmatter is kept as written, and its `tags` and `aliases` are the page's tags and extra names.
   Hidden folders and files (`.git`, `.obsidian`) and `node_modules` are never read. A page's file name is one every
   disk takes (no `\ / : * ? " < > |`, no trailing dot or space, no device name, never hidden); two pages that would
   share a file, letter case and accents compared as disks do, get `Name (2).md`.
4. **Here to there.** Every save of the wiki (people, agents, imports, moves, audiences) queues one sync, unless one is
   already waiting (`wiki_repositories.dirty`); the sync's own saves queue none. A sync first takes what the repository
   changed, then writes what the wiki changed as one commit on top of the branch, fast-forward only: a branch someone
   pushed to meanwhile makes the sync start over (three times in a run, then the job tries again later). A sync holds
   its repository so two never write at once. Large wikis go in steps (300 notes read, 200 files or 8 MiB written per
   sync), each queuing the next.
5. **There to here.** The GitHub App subscribes to `push` (`GITHUB_APP_EVENTS`): a push to the branch a workspace keeps
   its wiki in queues its sync, and the app's own commit, told back, is let go. Every 5 minutes each connected
   repository is looked at anyway, for a webhook that never came (an app made before `push` was in its events, or a
   server GitHub can't reach). A sync on a branch that didn't move asks GitHub only where the branch is.
6. **Pages limited to some people never leave here.** A page that becomes limited has its note removed from the
   repository; a note that lands in a folder limited here becomes a limited page that stops following its note.
7. **Notes that can't be pages are held aside**, with why (too long, a name that can't be a title, folders too deep),
   until their file changes; the dialog lists them. A page whose note grew too long to read here isn't written over it.
8. **Stopping and retrying.** What a retry won't change stops the sync with a reason until an administrator starts it
   again (`wiki.repo_not_installed`, `wiki.repo_refused`, `wiki.repo_missing`, `wiki.repo_branch_missing`,
   `wiki.repo_empty`, `wiki.repo_protected` for a branch that takes no direct commits, `wiki.repo_folder_missing` for a
   folder that lists no note while pages came from it, so a renamed folder never empties the wiki,
   `wiki.repo_too_large`, `wiki.repo_owner_gone`, `wiki.repo_no_app`). GitHub not answering or asking to wait (5xx,
   429, a 403 over a rate limit) keeps it on: the job retries with the outbox's backoff and the app says it is trying
   again (`wiki.repo_unreachable` while `active`). Meanwhile saves stay here and go out when it runs again.
9. **Whose changes.** What comes from the repository is saved with the rights of the administrator who connected the
   repository, or started it again, with a version note naming the commit (`synced from the repository at <commit>`,
   noteCode `repository`). If they are no longer an administrator, the sync stops (`wiki.repo_owner_gone`) until
   another one starts it again. Commits are the GitHub App's; their message names each file and who last wrote it.
10. **Each page says where its note stands**, in its line of facts: on GitHub (a link to the file), going to GitHub,
    not on GitHub yet (stopped), only here (limited), or not updated on GitHub (held).
11. **One host today, more later.** The sync talks to the host only through `NoteRemote` (a branch's head, the notes
    of a commit with their git blobs, a note's text, one commit); `wiki_repositories.provider` says which host.
    GitHub's is the git data API with the app's installation token, so the server runs no git and keeps no clone: the
    self-host still needs only Postgres.
12. **What is remembered.** `wiki_repositories` (one per workspace: the repository, the commit both sides agreed on,
    state) and `wiki_repository_files` (per note: the git blob and the page's version both sides last agreed on, the
    title and folder that note was written under, its frontmatter): a later change on either side is told apart by
    comparing with them.

## Consequences

- GitHub only for now. Another host is another `NoteRemote` and a way to reach it, with the sync unchanged.
- An app made before `push` was among its events lists it as missing in the GitHub app's panel; until the server's
  owner ticks it, what is pushed there arrives within 5 minutes.
- Files a note embeds (images, PDFs) aren't synced: they show as missing here.
- A note renamed and edited in the same push there reads as one note removed and another added: the old page goes to
  the trash and a new one takes the text, without the old one's history.
- A first sync of a large repository or wiki takes several jobs; the dialog shows it updating meanwhile.
- A rule on the branch that refuses the app's commits (protection, required reviews, signed commits) stops the sync
  with `wiki.repo_protected`: the wiki then needs a branch the app may push to.
