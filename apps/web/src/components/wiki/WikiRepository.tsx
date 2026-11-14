import type { WikiPage, WikiRepository } from "@agenteschat/client";
import { useGitHubRepos, useWikiRepository, useWikiRepositoryActions } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  FactStrip,
  Field,
  Input,
  MenuItem,
  SearchSelect,
  SettingNote,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitHubMark } from "@/components/GitHubMark";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * The wiki kept in a GitHub repository (ADR 0186): its item in the wiki's "More" menu, the line at the column's foot
 * when the two stopped following each other, the dialog that connects a repository or shows how it is going, and the
 * mark on each page saying where its note stands.
 */

const nameOf = (r: WikiRepository) => `${r.owner}/${r.repo}`;

/** Why a sync stopped, in words; a code with none of its own gets the general line. */
const WHY = {
  "wiki.repo_not_installed": "wiki.repo.why.not_installed",
  "wiki.repo_refused": "wiki.repo.why.refused",
  "wiki.repo_branch_missing": "wiki.repo.why.branch_missing",
  "wiki.repo_empty": "wiki.repo.why.empty",
  "wiki.repo_missing": "wiki.repo.why.missing",
  "wiki.repo_too_large": "wiki.repo.why.too_large",
  "wiki.repo_owner_gone": "wiki.repo.why.owner_gone",
  "wiki.repo_folder_missing": "wiki.repo.why.folder_missing",
  "wiki.repo_no_app": "wiki.repo.why.no_app",
  "wiki.repo_protected": "wiki.repo.why.protected",
} as const;
const whyText = (t: TFunction, r: WikiRepository) =>
  t(WHY[(r.errorCode ?? "") as keyof typeof WHY] ?? "wiki.repo.why.other", { repo: nameOf(r) });

/** Why a note isn't a page. */
const HELD = {
  "wiki.body_too_long": "wiki.repo.held.tooLong",
  "wiki.title_required": "wiki.repo.held.title",
  "wiki.title_empty_slug": "wiki.repo.held.title",
  "wiki.title_characters": "wiki.repo.held.title",
  "wiki.folder_depth": "wiki.repo.held.depth",
} as const;
const heldText = (t: TFunction, code: string) => t(HELD[code as keyof typeof HELD] ?? "wiki.repo.held.other");

/** It keeps going by itself, but GitHub didn't answer the last time. */
const retrying = (r: WikiRepository) => r.status === "active" && r.errorCode !== null;

/** The repository's state in one line: up to date since when, updating, retrying, or stopped. */
function stateLine(t: TFunction, locale: string, r: WikiRepository) {
  if (r.status === "error") return t("wiki.repo.state.stopped", { repo: nameOf(r) });
  if (retrying(r)) return t("wiki.repo.state.retrying", { repo: nameOf(r) });
  if (r.syncing || !r.syncedAt) return t("wiki.repo.state.syncing", { repo: nameOf(r) });
  return t("wiki.repo.state.upToDate", { repo: nameOf(r), when: relativeTime(t, locale, r.syncedAt) });
}

/**
 * The repository's item in the wiki's "More" menu: connecting is for administrators; one already connected shows how
 * it is going to whoever writes the wiki.
 */
export function WikiRepositoryMenuItem({ onOpen }: { onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const repository = useWikiRepository(org.id).data ?? null;
  const admin = can(org, "administrator");
  if (!repository && !admin) return null;
  return (
    <MenuItem
      leading={<GitHubMark size={16} className="gh-mark" />}
      description={
        repository ? (
          <span className={repository.status === "error" ? "wiki-repo-warn" : undefined}>
            {stateLine(t, i18n.language, repository)}
          </span>
        ) : (
          t("wiki.repo.menu.connectDesc")
        )
      }
      onSelect={onOpen}
    >
      {repository ? t("wiki.repo.menu.name") : t("wiki.repo.menu.connect")}
    </MenuItem>
  );
}

/** At the column's foot, only while the wiki and its repository stopped following each other. */
export function WikiRepositoryStopped({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const repository = useWikiRepository(org.id).data;
  if (repository?.status !== "error" || !can(org, "edit_wiki")) return null;
  return (
    <button type="button" className="wiki-repo-stopped wiki-repo-warn" onClick={onOpen}>
      <GitHubMark size={14} />
      {t("wiki.repo.stopped")}
    </button>
  );
}

/** Where a page's note stands on GitHub, in the page's line of facts: a link once it is there, else a word. */
export function WikiRepositoryMark({ page }: { page: WikiPage }) {
  const { t } = useTranslation();
  const r = page.repository;
  if (!r) return null;
  if (r.state === "synced" && r.url) {
    return (
      <a
        className="wiki-repo-mark"
        href={r.url}
        target="_blank"
        rel="noopener noreferrer"
        title={t("wiki.repo.page.syncedHint")}
      >
        <GitHubMark size={14} />
        {t("wiki.repo.page.synced")}
      </a>
    );
  }
  const word =
    r.state === "local"
      ? { text: t("wiki.repo.page.local"), hint: t("wiki.repo.page.localHint") }
      : r.state === "held"
        ? { text: t("wiki.repo.page.held"), hint: t("wiki.repo.page.heldHint") }
        : r.stopped
          ? { text: t("wiki.repo.page.notSent"), hint: t("wiki.repo.page.notSentHint") }
          : { text: t("wiki.repo.page.sending"), hint: t("wiki.repo.page.sendingHint") };
  const warn = r.state === "held" || (r.state === "pending" && r.stopped);
  return (
    <span className="wiki-repo-mark" data-warn={warn || undefined} title={word.hint}>
      <GitHubMark size={14} />
      {word.text}
    </span>
  );
}

/** Connects a repository when the wiki has none; else shows how it is going, with sync now and disconnect. */
export function WikiRepositoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const repository = useWikiRepository(org.id);
  const current = repository.data ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={current ? t("wiki.repo.manage.title") : t("wiki.repo.connect.title")}
      description={current ? undefined : t("wiki.repo.connect.description")}
      closeLabel={t("common.close")}
      width={520}
    >
      {repository.isLoading ? null : current ? (
        <Manage repository={current} onClose={onClose} />
      ) : (
        <Connect onClose={onClose} />
      )}
    </Dialog>
  );
}

function Connect({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const repos = useGitHubRepos(org.id);
  const { connect } = useWikiRepositoryActions(org.id);
  const [chosen, setChosen] = useState<string>();
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = (repos.data?.accounts ?? []).flatMap((account) =>
    account.repositories.map((r) => ({ value: r.fullName, label: r.fullName, group: account.login })),
  );
  const none = !repos.isLoading && options.length === 0;
  return (
    <>
      <DialogBody>
        <form
          id="wiki-repo-connect"
          className="wiki-repo-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return;
            setError(null);
            connect.mutate(
              {
                repository: chosen,
                ...(path.trim() ? { path: path.trim() } : {}),
                ...(branch.trim() ? { branch: branch.trim() } : {}),
              },
              { onError: (e) => setError(errorText(t, e, i18n.language)) },
            );
          }}
        >
          <Field
            label={t("wiki.repo.connect.repository")}
            id="wiki-repo-name"
            example={none ? undefined : t("wiki.repo.connect.repositoryHelp")}
            error={
              none ? (
                <>
                  {t("wiki.repo.connect.noRepositories")}{" "}
                  <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "connectors" }}>
                    {t("wiki.repo.connect.openConnectors")}
                  </Link>
                </>
              ) : undefined
            }
          >
            <SearchSelect
              id="wiki-repo-name"
              value={chosen}
              onValueChange={setChosen}
              options={options}
              disabled={none}
              placeholder={t("wiki.repo.connect.repositoryPlaceholder")}
              labels={{
                search: t("wiki.repo.connect.search"),
                searchPlaceholder: t("wiki.repo.connect.search"),
                noResults: t("wiki.repo.connect.noResults"),
                list: t("wiki.repo.connect.repository"),
              }}
            />
          </Field>
          <Field label={t("wiki.repo.connect.folder")} id="wiki-repo-path" example={t("wiki.repo.connect.folderHelp")}>
            <Input
              id="wiki-repo-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("wiki.repo.connect.folderPlaceholder")}
            />
          </Field>
          <Field
            label={t("wiki.repo.connect.branch")}
            id="wiki-repo-branch"
            example={t("wiki.repo.connect.branchHelp")}
          >
            <Input
              id="wiki-repo-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={t("wiki.repo.connect.branchPlaceholder")}
            />
          </Field>
          <div>
            <SettingNote icon="swap">{t("wiki.repo.connect.noteBoth")}</SettingNote>
            <SettingNote icon="clock">{t("wiki.repo.connect.noteConflict")}</SettingNote>
            <SettingNote icon="lock">{t("wiki.repo.connect.noteRestricted")}</SettingNote>
          </div>
          {error && <Alert>{error}</Alert>}
        </form>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          type="submit"
          form="wiki-repo-connect"
          variant="primary"
          disabled={!chosen || connect.isPending}
          loading={connect.isPending}
        >
          {t("wiki.repo.connect.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

function Manage({ repository, onClose }: { repository: WikiRepository; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { sync, disconnect } = useWikiRepositoryActions(org.id);
  const admin = can(org, "administrator");
  const stopped = repository.status === "error";
  const fail = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  return (
    <>
      <DialogBody>
        <div className="wiki-repo-form">
          {stopped && <Alert>{whyText(t, repository)}</Alert>}
          {retrying(repository) && <Alert tone="neutral">{t("wiki.repo.manage.retrying")}</Alert>}
          <FactStrip
            facts={[
              {
                key: "repository",
                icon: <GitHubMark size={16} />,
                label: t("wiki.repo.connect.repository"),
                value: nameOf(repository),
              },
              {
                key: "folder",
                icon: "drive",
                label: t("wiki.repo.connect.folder"),
                value: repository.path || t("wiki.repo.connect.folderPlaceholder"),
              },
              { key: "notes", icon: "document", label: t("wiki.repo.manage.notes"), value: String(repository.notes) },
              {
                key: "updated",
                icon: "clock",
                label: t("wiki.repo.manage.updated"),
                value: repository.syncing
                  ? t("wiki.repo.manage.updating")
                  : repository.syncedAt
                    ? relativeTime(t, i18n.language, repository.syncedAt)
                    : t("wiki.repo.manage.never"),
              },
            ]}
          />
          {repository.pending > 0 && (stopped || !repository.syncing) && (
            <SettingNote icon="clock">{t("wiki.repo.manage.pending", { count: repository.pending })}</SettingNote>
          )}
          {repository.held.length > 0 && (
            <div>
              <p className="wiki-repo-sub">{t("wiki.repo.manage.held", { count: repository.held.length })}</p>
              <ul className="wiki-repo-held">
                {repository.held.map((h) => (
                  <li key={h.path}>
                    <span>{h.path}</span>
                    <span>{heldText(t, h.code)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <SettingNote icon="info">
            {stopped ? t("wiki.repo.manage.noteStopped") : t("wiki.repo.manage.noteDisconnect")}
          </SettingNote>
        </div>
      </DialogBody>
      <DialogFooter>
        {admin && (
          <Button
            variant="ghost"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate(undefined, { onSuccess: onClose, onError: fail })}
          >
            {t("wiki.repo.manage.disconnect")}
          </Button>
        )}
        <Button onClick={() => window.open(repository.url, "_blank", "noopener")}>
          <GitHubMark size={16} />
          {t("wiki.repo.manage.open")}
        </Button>
        {admin && (
          <Button
            variant="primary"
            icon="refresh"
            disabled={sync.isPending || (repository.syncing && !stopped)}
            loading={sync.isPending}
            onClick={() => sync.mutate(undefined, { onError: fail })}
          >
            {stopped ? t("wiki.repo.manage.retry") : t("wiki.repo.manage.syncNow")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
