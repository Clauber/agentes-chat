import type { WikiCommitMode, WikiPage, WikiRepository } from "@agenteschat/client";
import {
  useGitHubRepos,
  useSettled,
  useWikiRepository,
  useWikiRepositoryActions,
  useWikiRepositoryCheck,
} from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
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
  OptionList,
  SearchSelect,
  SettingNote,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
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

/** The repository's state in one line: up to date since when (read-only, or not), updating, retrying, or stopped. */
function stateLine(t: TFunction, locale: string, r: WikiRepository) {
  if (r.status === "error") return t("wiki.repo.state.stopped", { repo: nameOf(r) });
  if (retrying(r)) return t("wiki.repo.state.retrying", { repo: nameOf(r) });
  if (r.syncing || !r.syncedAt) return t("wiki.repo.state.syncing", { repo: nameOf(r) });
  const when = relativeTime(t, locale, r.syncedAt);
  return t(r.writable ? "wiki.repo.state.upToDate" : "wiki.repo.state.readOnly", { repo: nameOf(r), when });
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
  if ((r.state === "review" || r.state === "declined") && r.url) {
    const declined = r.state === "declined";
    return (
      <a
        className="wiki-repo-mark"
        data-warn={declined || undefined}
        href={r.url}
        target="_blank"
        rel="noopener noreferrer"
        title={t(declined ? "wiki.repo.page.declinedHint" : "wiki.repo.page.reviewHint")}
      >
        <GitHubMark size={14} />
        {t(declined ? "wiki.repo.page.declined" : "wiki.repo.page.review")}
      </a>
    );
  }
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
  // Only here because the repository is followed read-only, or because the page is limited to some people.
  const localHint = r.readOnly && !page.audience ? t("wiki.repo.page.readOnlyHint") : t("wiki.repo.page.localHint");
  const word =
    r.state === "local"
      ? { text: t("wiki.repo.page.local"), hint: localHint }
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

/** The pull request's branch, unless someone names another. */
const PR_BRANCH = "agentes/wiki";

/**
 * How the wiki writes in its repository: straight on the branch, through a pull request, or not at all. A repository
 * the wiki may only read leaves the last one: the others say why.
 */
function WritingChoice({
  mode,
  onMode,
  branch,
  readOnly,
  disabled,
}: {
  mode: WikiCommitMode;
  onMode: (mode: WikiCommitMode) => void;
  /** The branch the wiki follows, when known. */
  branch: string | null;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const needsApp = readOnly ? t("wiki.repo.writing.needsApp") : null;
  return (
    <Field label={t("wiki.repo.writing.label")} group>
      <OptionList
        value={mode}
        onValueChange={onMode}
        aria-label={t("wiki.repo.writing.label")}
        disabled={disabled}
        options={[
          {
            value: "direct",
            title: t("wiki.repo.writing.direct"),
            description:
              needsApp ??
              (branch ? t("wiki.repo.writing.directDesc", { branch }) : t("wiki.repo.writing.directDescAny")),
            disabled: readOnly,
          },
          {
            value: "pull_request",
            title: t("wiki.repo.writing.pullRequest"),
            description:
              needsApp ??
              (branch ? t("wiki.repo.writing.pullRequestDesc", { branch }) : t("wiki.repo.writing.pullRequestDescAny")),
            disabled: readOnly,
          },
          { value: "none", title: t("wiki.repo.writing.none"), description: t("wiki.repo.writing.noneDesc") },
        ]}
      />
    </Field>
  );
}

/**
 * How the wiki hears of what changes there: at once when GitHub tells it of each push, else at its next look (every
 * 5 minutes through the app, every minute for a public repository). `short`: as a fact's value.
 */
function cadenceOf(t: TFunction, r: { writable: boolean; notifiedAt?: string | null }, short = false) {
  const when = r.notifiedAt ? "notified" : r.writable ? "app" : "public";
  return t(short ? `wiki.repo.cadence.short.${when}` : `wiki.repo.cadence.${when}`);
}

/** The picker's last option: a repository named by its address (a public one, or one the app reaches). */
const BY_ADDRESS = ":address";

function Connect({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const repos = useGitHubRepos(org.id);
  const { connect } = useWikiRepositoryActions(org.id);
  const [chosen, setChosen] = useState<string>();
  const [address, setAddress] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<WikiCommitMode>("direct");
  const [modeTouched, setModeTouched] = useState(false);
  const [prBranch, setPrBranch] = useState(PR_BRANCH);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listed = (repos.data?.accounts ?? []).flatMap((account) =>
    account.repositories.map((r) => ({ value: r.fullName, label: r.fullName, group: account.login })),
  );
  // The app reaches none: the address is the only way in, for a public repository.
  const none = !repos.isLoading && listed.length === 0;
  const options = [...listed, { value: BY_ADDRESS, label: t("wiki.repo.connect.byAddress") }];
  const byAddress = none || chosen === BY_ADDRESS;
  const named = (byAddress ? address : (chosen ?? "")).trim();
  // Asked once the name and the branch stop changing: what connecting would do, said under the name.
  const repository = useSettled(named, 500);
  const asked = useSettled(branch.trim(), 500);
  const check = useWikiRepositoryCheck(org.id, repository, asked);
  const found = check.data && repository === named ? check.data : null;
  const refusal = check.error && repository === named ? check.error : null;
  const branchRefused = errorCode(refusal) === "wiki.repo_branch_missing";
  const readOnly = found ? !found.writable : false;
  const chosenMode: WikiCommitMode = readOnly ? "none" : mode;
  // What the wiki may do there sets the choice, until someone makes one.
  useEffect(() => {
    if (found && !modeTouched) setMode(found.writable ? "direct" : "none");
  }, [found, modeTouched]);
  const status = !named
    ? undefined
    : found
      ? t(found.writable ? "wiki.repo.connect.canWrite" : "wiki.repo.connect.readOnly", {
          repo: `${found.owner}/${found.repo}`,
          branch: found.branch,
        })
      : check.isFetching || repository !== named
        ? t("wiki.repo.connect.checking")
        : undefined;
  const nameError = refusal && !branchRefused ? errorText(t, refusal, i18n.language) : undefined;
  return (
    <>
      <DialogBody>
        <form
          id="wiki-repo-connect"
          className="wiki-repo-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!found) return;
            setError(null);
            connect.mutate(
              {
                repository: named,
                ...(path.trim() ? { path: path.trim() } : {}),
                ...(branch.trim() ? { branch: branch.trim() } : {}),
                commitMode: chosenMode,
                ...(chosenMode === "pull_request" ? { prBranch: prBranch.trim() || PR_BRANCH } : {}),
              },
              { onError: (e) => setError(errorText(t, e, i18n.language)) },
            );
          }}
        >
          {!none && (
            <Field
              label={t("wiki.repo.connect.repository")}
              id="wiki-repo-name"
              example={
                byAddress ? t("wiki.repo.connect.repositoryHelp") : (status ?? t("wiki.repo.connect.repositoryHelp"))
              }
              error={byAddress ? undefined : nameError}
            >
              <SearchSelect
                id="wiki-repo-name"
                value={chosen}
                onValueChange={setChosen}
                options={options}
                disabled={repos.isLoading}
                placeholder={t("wiki.repo.connect.repositoryPlaceholder")}
                labels={{
                  search: t("wiki.repo.connect.search"),
                  searchPlaceholder: t("wiki.repo.connect.search"),
                  noResults: t("wiki.repo.connect.noResults"),
                  list: t("wiki.repo.connect.repository"),
                }}
              />
            </Field>
          )}
          {byAddress && (
            <Field
              label={none ? t("wiki.repo.connect.repository") : t("wiki.repo.connect.address")}
              id="wiki-repo-address"
              example={status ?? t("wiki.repo.connect.addressHelp")}
              error={nameError}
            >
              <Input
                id="wiki-repo-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t("wiki.repo.connect.addressPlaceholder")}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          {readOnly && (
            <SettingNote icon="info">
              {t("wiki.repo.connect.installForWrite")}{" "}
              <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "connectors" }}>
                {t("wiki.repo.connect.openConnectors")}
              </Link>
            </SettingNote>
          )}
          <WritingChoice
            mode={chosenMode}
            onMode={(next) => {
              setMode(next);
              setModeTouched(true);
            }}
            branch={found?.branch ?? null}
            readOnly={readOnly}
          />
          <details
            className="cflow__more"
            open={more || branchRefused}
            onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>{t("wiki.repo.connect.more")}</summary>
            <div className="cflow__key">
              <Field
                label={t("wiki.repo.connect.folder")}
                id="wiki-repo-path"
                example={t("wiki.repo.connect.folderHelp")}
              >
                <Input
                  id="wiki-repo-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={found?.path || t("wiki.repo.connect.folderPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t("wiki.repo.connect.branch")}
                id="wiki-repo-branch"
                example={t("wiki.repo.connect.branchHelp")}
                error={branchRefused && refusal ? errorText(t, refusal, i18n.language) : undefined}
              >
                <Input
                  id="wiki-repo-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={found?.defaultBranch ?? t("wiki.repo.connect.branchPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {chosenMode === "pull_request" && (
                <Field
                  label={t("wiki.repo.writing.branch")}
                  id="wiki-repo-pr-branch"
                  example={t("wiki.repo.writing.branchHelp")}
                >
                  <Input
                    id="wiki-repo-pr-branch"
                    value={prBranch}
                    onChange={(e) => setPrBranch(e.target.value)}
                    placeholder={PR_BRANCH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              )}
            </div>
          </details>
          <div>
            <SettingNote icon="refresh">{cadenceOf(t, { writable: !readOnly })}</SettingNote>
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
          disabled={!found || connect.isPending}
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
  const { sync, disconnect, writing } = useWikiRepositoryActions(org.id);
  const admin = can(org, "administrator");
  const stopped = repository.status === "error";
  const fail = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  const [mode, setMode] = useState<WikiCommitMode>(repository.commitMode);
  const [prBranch, setPrBranch] = useState(repository.prBranch);
  const changed =
    mode !== repository.commitMode || (mode === "pull_request" && prBranch.trim() !== repository.prBranch);
  const pull = repository.pullRequest;
  return (
    <>
      <DialogBody>
        <div className="wiki-repo-form">
          {stopped && <Alert>{whyText(t, repository)}</Alert>}
          {retrying(repository) && <Alert tone="neutral">{t("wiki.repo.manage.retrying")}</Alert>}
          {!stopped && !repository.writable && (
            <Alert tone="neutral">{t("wiki.repo.manage.readOnly", { repo: nameOf(repository) })}</Alert>
          )}
          <FactStrip
            facts={[
              {
                key: "repository",
                icon: <GitHubMark size={16} />,
                label: t("wiki.repo.connect.repository"),
                value: `${nameOf(repository)} · ${repository.branch}`,
              },
              {
                key: "folder",
                icon: "drive",
                label: t("wiki.repo.connect.folder"),
                value: repository.path || t("wiki.repo.connect.folderPlaceholder"),
              },
              { key: "notes", icon: "document", label: t("wiki.repo.manage.notes"), value: String(repository.notes) },
              {
                key: "cadence",
                icon: "refresh",
                label: t("wiki.repo.manage.cadence"),
                value: cadenceOf(t, repository, true),
              },
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
          {pull && (
            <SettingNote icon="link">
              <a href={pull.url} target="_blank" rel="noopener noreferrer">
                {t(pull.state === "declined" ? "wiki.repo.manage.prDeclined" : "wiki.repo.manage.prOpen", {
                  number: pull.number,
                })}
              </a>
            </SettingNote>
          )}
          {admin ? (
            <div className="wiki-repo-writing">
              <WritingChoice
                mode={repository.writable ? mode : "none"}
                onMode={setMode}
                branch={repository.branch}
                readOnly={!repository.writable}
              />
              {mode === "pull_request" && repository.writable && (
                <Field
                  label={t("wiki.repo.writing.branch")}
                  id="wiki-repo-pr-branch"
                  example={t("wiki.repo.writing.branchHelp")}
                >
                  <Input
                    id="wiki-repo-pr-branch"
                    value={prBranch}
                    onChange={(e) => setPrBranch(e.target.value)}
                    placeholder={PR_BRANCH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              )}
              {changed && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={writing.isPending}
                  loading={writing.isPending}
                  onClick={() =>
                    writing.mutate(
                      { commitMode: mode, ...(mode === "pull_request" ? { prBranch: prBranch.trim() } : {}) },
                      { onSuccess: () => toast.show(t("common.saved")), onError: fail },
                    )
                  }
                >
                  {t("common.save")}
                </Button>
              )}
            </div>
          ) : (
            <SettingNote icon="info">
              {t(`wiki.repo.writing.now.${repository.commitMode}`, { branch: repository.branch })}
            </SettingNote>
          )}
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
