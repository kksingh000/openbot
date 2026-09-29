// The built-in GitHub connection of this computer: one sign-in to the GitHub App, shared by every
// agent as the GitHub MCP server and as the credential that `gh` and `git` read.

import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  GITHUB_CONNECTOR_MCP_SERVER_ID,
  GITHUB_CONNECTOR_MCP_SERVER_NAME,
  GITHUB_CONNECTOR_MCP_SERVER_URL,
  type GitHubConnectorState,
  type GitHubConnectorStatus,
  type McpServerConfig,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, redactText, registerSecretValue, toLogValue } from "@openbot/logging";
import { z } from "zod";
import { writeFileAtomically } from "../backend/atomic-json-file";
import type { GitHubAppConfig } from "./github-connector-config";
import type { GitHubConnectorRecord, GitHubConnectorStore } from "./github-connector-store";
import {
  GITHUB_REQUEST_TIMEOUT_MS,
  type GitHubDeviceCode,
  GitHubDeviceFlowError,
  type GitHubFetch,
  type GitHubTokenSet,
  pollGitHubDeviceToken,
  refreshGitHubToken,
  requestGitHubDeviceCode,
} from "./github-device-flow";

const logger = createOpenBotLogger("github-connector");

/** A token with less time left than this is refreshed before it is handed out. */
const REFRESH_MARGIN_MS = 10 * 60_000;
/**
 * How often the token's time left is read against the wall clock. A timer set for the expiry would
 * fire late after the computer sleeps, and a refresh that failed on the network is tried again at
 * the next check.
 */
const REFRESH_CHECK_MS = 60_000;
const GIT_CREDENTIAL_KEY = "credential.https://github.com.helper";
/** The fields of `GET /user` that the status shows. */
const githubUserSchema = z.object({
  login: z.string().min(1),
  id: z.number(),
  avatar_url: z.string().nullish(),
});

export interface GitHubConnectorServiceOptions {
  /** Null when this build has no GitHub App. The connection is then not offered. */
  app: GitHubAppConfig | null;
  store: GitHubConnectorStore;
  /**
   * A folder that OpenBot owns, outside every root an agent can write. It holds the `gh` hosts file
   * and the token file that the git credential helper reads, while the connection is active.
   */
  toolDirectory: string;
  openExternal: (url: string) => Promise<void>;
  fetch?: GitHubFetch;
  now?: () => number;
}

interface PendingSignIn {
  controller: AbortController;
  /** Null while GitHub has not answered the device code request. */
  device: GitHubDeviceCode | null;
}

/**
 * Owns the GitHub sign-in of this computer: the device flow, the stored token set, its refresh, and
 * the files that `gh` and `git` read. It never imports the agent service. The agent service reads
 * `mcpServer`, `accessToken` and `agentEnvironment`, and `onAgentAccessChanged` tells it when that
 * answer changes.
 *
 * The token itself never leaves the main process except to GitHub, to the GitHub MCP server as a
 * bearer header, and into the two files below for `gh` and `git`. Each token is registered for
 * redaction before it is used.
 */
export class GitHubConnectorService {
  readonly #app: GitHubAppConfig | null;
  readonly #store: GitHubConnectorStore;
  readonly #toolDirectory: string;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #fetch: GitHubFetch;
  readonly #now: () => number;
  readonly #statusListeners = new Set<(status: GitHubConnectorStatus) => void>();
  readonly #accessListeners = new Set<() => void>();
  #pending: PendingSignIn | null = null;
  /** The stored sign-in can no longer refresh. The record stays, so the panel can name the account. */
  #expired = false;
  #error: string | null = null;
  #refreshing: Promise<GitHubConnectorRecord | null> | null = null;
  #refreshCheck: ReturnType<typeof setInterval> | null = null;
  /** Network failures of the refresh in a row. Only the first is logged. */
  #refreshFailures = 0;
  /**
   * Changes each time the stored sign-in is replaced or removed. A refresh that started before the
   * change does not write its answer back.
   */
  #generation = 0;
  #disposed = false;
  /** Store writes and the `gh` and `git` files change in this order, one change at a time. */
  #queue: Promise<void> = Promise.resolve();
  /** What agents were last told, so a change that does not alter it replaces no session. */
  #agentAccess = false;

  constructor(options: GitHubConnectorServiceOptions) {
    this.#app = options.app;
    this.#store = options.store;
    this.#toolDirectory = options.toolDirectory;
    this.#openExternal = options.openExternal;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads the stored sign-in and prepares the `gh` and `git` files. Call once, before an agent starts.
   * A file that cannot be read is logged and treated as no sign-in: a new sign-in replaces it.
   */
  async load(): Promise<void> {
    const error = await this.#store.load();
    if (error) logger.warn("The GitHub connection file could not be read.", { cause: toLogValue(error) });
    const record = this.#store.read();
    await this.#serialize(async () => {
      if (!record || !this.#app) {
        await this.#removeToolFiles();
        return;
      }
      registerTokenSecrets(record);
      if (!this.#canRefresh(record) && this.#accessTokenExpired(record)) {
        this.#expired = true;
        await this.#removeToolFiles();
      } else {
        await this.#writeToolFiles(record);
      }
    });
    this.#agentAccess = this.#agentConnected();
    if (!this.#app || this.#disposed) return;
    this.#refreshCheck = setInterval(() => this.#checkRefresh(), REFRESH_CHECK_MS);
    this.#refreshCheck.unref?.();
    this.#checkRefresh();
  }

  status(): GitHubConnectorStatus {
    const record = this.#store.read();
    const device = this.#pending?.device ?? null;
    return {
      available: this.#app !== null,
      state: this.#state(),
      login: record?.login ?? null,
      avatarUrl: record?.avatarUrl ?? null,
      userCode: device?.userCode ?? null,
      verificationUri: device?.verificationUri ?? null,
      error: this.#error,
    };
  }

  onChanged(listener: (status: GitHubConnectorStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Told when agents gain or lose GitHub. A token refresh alone is not a change. */
  onAgentAccessChanged(listener: () => void): () => void {
    this.#accessListeners.add(listener);
    return () => this.#accessListeners.delete(listener);
  }

  /**
   * Starts the device flow and opens GitHub's code page. Returns at once with the user code; the
   * wait for the user runs in the background and reports through `onChanged`.
   */
  async connect(): Promise<GitHubConnectorStatus> {
    const app = this.#app;
    if (!app) throw new Error(sourceText("error.connector.githubUnavailable"));
    this.#pending?.controller.abort();
    const pending: PendingSignIn = { controller: new AbortController(), device: null };
    this.#pending = pending;
    this.#error = null;
    this.#emitStatus();
    try {
      pending.device = await requestGitHubDeviceCode({
        clientId: app.clientId,
        fetch: this.#fetch,
        now: this.#now,
        signal: pending.controller.signal,
      });
    } catch (error) {
      if (this.#pending === pending && !pending.controller.signal.aborted) this.#fail(pending, error);
      return this.status();
    }
    if (this.#pending !== pending) return this.status();
    this.#emitStatus();
    void this.openVerification();
    void this.#finishSignIn(app, pending, pending.device);
    return this.status();
  }

  cancel(): GitHubConnectorStatus {
    this.#pending?.controller.abort();
    this.#pending = null;
    this.#error = null;
    this.#emitStatus();
    return this.status();
  }

  /**
   * Forgets the sign-in. GitHub revokes a token only with the client secret, which OpenBot does not
   * hold, so the GitHub page where the user can revoke it opens as well.
   */
  async disconnect(): Promise<GitHubConnectorStatus> {
    this.#pending?.controller.abort();
    this.#pending = null;
    this.#generation += 1;
    const hadRecord = this.#store.read() !== null;
    await this.#serialize(async () => {
      await this.#store.clear();
      await this.#removeToolFiles();
    });
    this.#expired = false;
    this.#error = null;
    this.#emitStatus();
    this.#syncAgentAccess();
    if (hadRecord && this.#app) {
      void this.#open(`https://github.com/settings/connections/applications/${encodeURIComponent(this.#app.clientId)}`);
    }
    return this.status();
  }

  async openVerification(): Promise<void> {
    const uri = this.#pending?.device?.verificationUri;
    if (uri) await this.#open(uri);
  }

  /** GitHub's page where the user picks the repositories the app may reach. */
  async openInstall(): Promise<void> {
    if (this.#app) await this.#open(`https://github.com/apps/${this.#app.slug}/installations/new`);
  }

  /**
   * The token for the GitHub MCP server, refreshed first when it has less than ten minutes left.
   * Null while the connection is not active.
   */
  async accessToken(): Promise<string | null> {
    const record = this.#store.read();
    if (!record || !this.#agentConnected()) return null;
    if (!this.#needsRefresh(record)) return record.accessToken;
    // A sign-in that replaced this one during the refresh gives its own token.
    const current = (await this.#refresh()) ?? this.#store.read();
    return current && this.#agentConnected() && !this.#accessTokenExpired(current) ? current.accessToken : null;
  }

  /** The GitHub MCP server that agents are given, or null while the connection is not active. */
  mcpServer(): McpServerConfig | null {
    if (!this.#agentConnected()) return null;
    return {
      id: GITHUB_CONNECTOR_MCP_SERVER_ID,
      name: GITHUB_CONNECTOR_MCP_SERVER_NAME,
      transport: "http",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: GITHUB_CONNECTOR_MCP_SERVER_URL,
      headers: [],
    };
  }

  /**
   * The environment that makes `gh` and `git` use this connection. It holds paths only, never the
   * token: a provider process runs for many hours and the token changes every eight, so the token
   * lives in files that each refresh rewrites.
   *
   * The empty helper value clears the helpers from the user's own git configuration for github.com.
   * Without it, a system helper such as the macOS keychain would store the short-lived token after
   * the first push, and give it back after it expired. The two entries go after the `GIT_CONFIG_*`
   * entries in `inherited`, the environment the process starts with, so those entries still apply.
   */
  agentEnvironment(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
    if (!this.#agentConnected()) return {};
    const credentialFile = this.#credentialFile().replaceAll("\\", "/");
    const first = gitConfigCount(inherited.GIT_CONFIG_COUNT);
    return {
      GH_CONFIG_DIR: this.#ghConfigDirectory(),
      GIT_CONFIG_COUNT: String(first + 2),
      [`GIT_CONFIG_KEY_${first}`]: GIT_CREDENTIAL_KEY,
      [`GIT_CONFIG_VALUE_${first}`]: "",
      [`GIT_CONFIG_KEY_${first + 1}`]: GIT_CREDENTIAL_KEY,
      [`GIT_CONFIG_VALUE_${first + 1}`]: `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password='; cat ${shellQuote(credentialFile)}; echo; }; f`,
    };
  }

  /**
   * Stops the refresh check and the sign-in, and removes the token files after the change in
   * progress. The encrypted sign-in stays.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1;
    this.#pending?.controller.abort();
    this.#pending = null;
    if (this.#refreshCheck) clearInterval(this.#refreshCheck);
    this.#refreshCheck = null;
    this.#statusListeners.clear();
    this.#accessListeners.clear();
    await this.#serialize(() => this.#removeToolFiles());
  }

  /**
   * Whether agents get GitHub. A sign-in that runs while a stored one is still valid does not take
   * GitHub away: agents keep the old account until the new one replaces it.
   */
  #agentConnected(): boolean {
    return this.#app !== null && this.#store.read() !== null && !this.#expired;
  }

  #state(): GitHubConnectorState {
    if (!this.#app) return "disconnected";
    if (this.#pending) return "pending";
    if (!this.#store.read()) return "disconnected";
    return this.#expired ? "expired" : "connected";
  }

  async #finishSignIn(app: GitHubAppConfig, pending: PendingSignIn, device: GitHubDeviceCode): Promise<void> {
    try {
      const tokens = await pollGitHubDeviceToken({
        clientId: app.clientId,
        device,
        fetch: this.#fetch,
        now: this.#now,
        signal: pending.controller.signal,
      });
      registerTokenSecrets(tokens);
      const user = await this.#readUser(tokens.accessToken, pending.controller.signal);
      const record: GitHubConnectorRecord = { ...tokens, ...user };
      // Checked in the queue: a cancel or disconnect that ran while the last change was written wins.
      const committed = await this.#serialize(async () => {
        if (this.#pending !== pending || this.#disposed) return false;
        await this.#store.write(record);
        this.#generation += 1;
        this.#pending = null;
        this.#expired = false;
        this.#error = null;
        await this.#writeToolFiles(record);
        return true;
      });
      if (!committed) return;
      this.#emitStatus();
      this.#syncAgentAccess();
    } catch (error) {
      if (pending.controller.signal.aborted || this.#pending !== pending) return;
      this.#fail(pending, error);
    }
  }

  #fail(pending: PendingSignIn, error: unknown): void {
    pending.controller.abort();
    this.#pending = null;
    this.#error = redactText(error instanceof Error ? error.message : String(error));
    if (!(error instanceof GitHubDeviceFlowError)) {
      logger.warn("The GitHub sign-in failed.", { cause: toLogValue(error) });
    }
    this.#emitStatus();
  }

  async #readUser(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Pick<GitHubConnectorRecord, "login" | "userId" | "avatarUrl">> {
    let response: Response;
    try {
      response = await this.#fetch("https://api.github.com/user", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)]),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "OpenBot",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      throw new GitHubDeviceFlowError(
        "unreachable",
        sourceText("error.connector.githubUnreachable", {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    const user = githubUserSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !user.success) {
      throw new GitHubDeviceFlowError(
        "unexpected",
        sourceText("error.connector.githubUnexpected", { detail: `user HTTP ${response.status}` }),
      );
    }
    return { login: user.data.login, userId: user.data.id, avatarUrl: user.data.avatar_url ?? null };
  }

  #needsRefresh(record: GitHubConnectorRecord): boolean {
    return record.accessTokenExpiresAt !== null && record.accessTokenExpiresAt - this.#now() < REFRESH_MARGIN_MS;
  }

  #accessTokenExpired(record: GitHubConnectorRecord): boolean {
    return record.accessTokenExpiresAt !== null && record.accessTokenExpiresAt <= this.#now();
  }

  #canRefresh(record: GitHubConnectorRecord): boolean {
    return (
      record.refreshToken !== null &&
      (record.refreshTokenExpiresAt === null || record.refreshTokenExpiresAt > this.#now())
    );
  }

  /** Starts a refresh when the token has less than ten minutes left, so `gh` and `git` keep a valid one. */
  #checkRefresh(): void {
    const record = this.#store.read();
    if (this.#disposed || !record || !this.#agentConnected() || !this.#needsRefresh(record)) return;
    void this.#refresh();
  }

  /** One refresh at a time: a hand-off and the check can ask together, and GitHub rotates the refresh token. */
  #refresh(): Promise<GitHubConnectorRecord | null> {
    this.#refreshing ??= this.#runRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /**
   * Resolves with the record to use: the new one, the old one after a network failure, or null when
   * the sign-in expired or changed during the refresh. It does not reject.
   */
  async #runRefresh(): Promise<GitHubConnectorRecord | null> {
    const generation = this.#generation;
    const record = this.#store.read();
    const app = this.#app;
    if (!record || !app || this.#expired) return null;
    // A disconnect, a new sign-in or a shutdown that ran during the refresh wins.
    const current = () => !this.#disposed && this.#generation === generation && this.#store.read() === record;
    try {
      if (!record.refreshToken || !this.#canRefresh(record)) {
        await this.#serialize(async () => {
          if (current()) await this.#expire();
        });
        return null;
      }
      let tokens: GitHubTokenSet;
      try {
        tokens = await refreshGitHubToken({
          clientId: app.clientId,
          refreshToken: record.refreshToken,
          fetch: this.#fetch,
          now: this.#now,
        });
      } catch (error) {
        if (!(error instanceof GitHubDeviceFlowError && error.failure === "refresh_rejected")) throw error;
        await this.#serialize(async () => {
          if (!current()) return;
          // Saved without the refresh token, so the next start shows the sign-in as expired too.
          const now = this.#now();
          await this.#store.write({
            ...record,
            accessTokenExpiresAt: Math.min(record.accessTokenExpiresAt ?? now, now),
            refreshToken: null,
            refreshTokenExpiresAt: null,
          });
          await this.#expire();
        });
        return null;
      }
      registerTokenSecrets(tokens);
      const next: GitHubConnectorRecord = {
        ...record,
        ...tokens,
        refreshToken: tokens.refreshToken ?? record.refreshToken,
        refreshTokenExpiresAt: tokens.refreshToken ? tokens.refreshTokenExpiresAt : record.refreshTokenExpiresAt,
      };
      const committed = await this.#serialize(async () => {
        if (!current()) return false;
        await this.#store.write(next);
        await this.#writeToolFiles(next);
        return true;
      });
      this.#refreshFailures = 0;
      return committed ? next : null;
    } catch (error) {
      this.#refreshFailures += 1;
      if (this.#refreshFailures === 1) {
        logger.warn("The GitHub token could not be refreshed. OpenBot tries again each minute.", {
          cause: toLogValue(error),
        });
      }
      return record;
    }
  }

  /** Runs in the queue. */
  async #expire(): Promise<void> {
    this.#expired = true;
    this.#error = sourceText("error.connector.githubExpired");
    await this.#removeToolFiles();
    this.#emitStatus();
    this.#syncAgentAccess();
  }

  #serialize<T>(change: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(change, change);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #ghConfigDirectory(): string {
    return join(this.#toolDirectory, "gh");
  }

  #credentialFile(): string {
    return join(this.#toolDirectory, "token");
  }

  /**
   * Both `hosts.yml` layouts: `users` for `gh` 2.40 and later, the flat keys for older releases. A
   * `GH_TOKEN` in the user's own environment still wins, as `gh` documents.
   */
  async #writeToolFiles(record: GitHubConnectorRecord): Promise<void> {
    await mkdir(this.#ghConfigDirectory(), { recursive: true, mode: 0o700 });
    // `mkdir` leaves a directory that is already there as it is. The files are 0600 either way.
    await chmod(this.#toolDirectory, 0o700);
    await chmod(this.#ghConfigDirectory(), 0o700);
    const hosts = [
      "github.com:",
      "    users:",
      `        ${record.login}:`,
      `            oauth_token: ${record.accessToken}`,
      "    git_protocol: https",
      `    oauth_token: ${record.accessToken}`,
      `    user: ${record.login}`,
      "",
    ].join("\n");
    await writeFileAtomically(join(this.#ghConfigDirectory(), "hosts.yml"), hosts);
    await writeFileAtomically(this.#credentialFile(), record.accessToken);
  }

  async #removeToolFiles(): Promise<void> {
    await rm(this.#toolDirectory, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("The GitHub token files could not be removed.", { cause: toLogValue(error) });
    });
  }

  async #open(url: string): Promise<void> {
    await this.#openExternal(url).catch((error: unknown) => {
      logger.warn("A GitHub page could not be opened.", { cause: toLogValue(error) });
    });
  }

  #emitStatus(): void {
    const status = this.status();
    for (const listener of this.#statusListeners) listener(status);
  }

  #syncAgentAccess(): void {
    const access = this.#agentConnected();
    if (access === this.#agentAccess) return;
    this.#agentAccess = access;
    for (const listener of this.#accessListeners) listener();
  }
}

function registerTokenSecrets(tokens: Pick<GitHubTokenSet, "accessToken" | "refreshToken">): void {
  registerSecretValue(tokens.accessToken);
  if (tokens.refreshToken) registerSecretValue(tokens.refreshToken);
}

/** The count of `GIT_CONFIG_*` entries already set. Git refuses a count that is not a number. */
function gitConfigCount(value: string | undefined): number {
  return value && /^\d+$/u.test(value) ? Number(value) : 0;
}

/** One POSIX shell word. Git runs a `!` helper with `sh`, on Windows too. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
