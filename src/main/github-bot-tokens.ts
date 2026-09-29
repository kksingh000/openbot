// The installation tokens of the OpenBot GitHub App that the OpenBot API gives this computer, so
// that GitHub shows an agent's work as the app and not as the signed-in user.

import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { z } from "zod";
import type { GitHubFetch } from "./github-device-flow";

const logger = createOpenBotLogger("github-bot-tokens");

/** An installation token lasts one hour. It is replaced when less than this is left. */
const RENEW_MARGIN_MS = 10 * 60_000;
/** After a failure, an API with no app key, or an answer with no token, the next request waits this long. */
const RETRY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

const answerSchema = z.object({
  installations: z.array(
    z.object({
      installationId: z.number(),
      account: z.string(),
      token: z.string().min(1),
      expiresAt: z.string(),
      repositories: z.array(z.string().min(1)),
    }),
  ),
});

export interface GitHubBotToken {
  token: string;
  expiresAt: number;
}

export interface GitHubBotTokensOptions {
  /** The origin of the OpenBot API, such as `https://api.openbot.run`. */
  apiUrl: string;
  fetch: GitHubFetch;
  now: () => number;
}

/**
 * The bot token for each repository where the signed-in user can push. A repository with no bot
 * token uses the user token: the API gives a bot token only where the user can already write, so
 * the bot never reaches more than the user.
 *
 * The API gets the user token as its bearer and keeps nothing. When it has no app key, or cannot be
 * reached, agents keep working as the user.
 */
export class GitHubBotTokens {
  readonly #apiUrl: string;
  readonly #fetch: GitHubFetch;
  readonly #now: () => number;
  /** `owner/name` in lower case, as GitHub compares it. */
  #byRepository = new Map<string, GitHubBotToken>();
  /** When the next request is due. */
  #nextAt = 0;
  #failureLogged = false;

  constructor(options: GitHubBotTokensOptions) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch;
    this.#now = options.now;
  }

  /** The bot token for `owner/name`, or null when the user token applies. */
  forRepository(owner: string, name: string): string | null {
    const entry = this.#byRepository.get(`${owner}/${name}`.toLowerCase());
    return entry && entry.expiresAt > this.#now() ? entry.token : null;
  }

  /** Each repository with a valid bot token, for the file that the git credential helper reads. */
  entries(): Array<[repository: string, token: string]> {
    const now = this.#now();
    return [...this.#byRepository]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([repository, entry]) => [repository, entry.token]);
  }

  /** Whether a request is due: a token is near its end, or the last failure was long enough ago. */
  due(): boolean {
    return this.#now() >= this.#nextAt;
  }

  /** Asks for a new set at the next check, as after an install that added repositories. */
  invalidate(): void {
    this.#nextAt = 0;
  }

  clear(): void {
    this.#byRepository = new Map();
    this.#nextAt = 0;
  }

  /**
   * Replaces the set with the API's answer. Returns whether the set changed. A failure keeps the
   * tokens that are still valid and does not reject.
   */
  async renew(userToken: string, signal?: AbortSignal): Promise<boolean> {
    const before = this.#signature();
    try {
      const response = await this.#fetch(new URL("/v1/github/installation-tokens", this.#apiUrl).toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}`, Accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 503) {
        // This API has no app key: agents act as the user until it does.
        this.#byRepository = new Map();
        this.#nextAt = this.#now() + RETRY_MS;
        return before !== this.#signature();
      }
      if (!response.ok) throw new Error(`The OpenBot API refused the GitHub token request (HTTP ${response.status}).`);
      const answer = answerSchema.parse(await response.json());
      const next = new Map<string, GitHubBotToken>();
      for (const installation of answer.installations) {
        const expiresAt = Date.parse(installation.expiresAt);
        if (!Number.isFinite(expiresAt)) continue;
        registerSecretValue(installation.token);
        for (const repository of installation.repositories) {
          next.set(repository.toLowerCase(), { token: installation.token, expiresAt });
        }
      }
      this.#byRepository = next;
      const firstExpiry = Math.min(...[...next.values()].map((entry) => entry.expiresAt));
      this.#nextAt = next.size > 0 ? firstExpiry - RENEW_MARGIN_MS : this.#now() + RETRY_MS;
      this.#failureLogged = false;
    } catch (error) {
      if (signal?.aborted) return false;
      this.#nextAt = this.#now() + RETRY_MS;
      if (!this.#failureLogged) {
        this.#failureLogged = true;
        logger.warn("The GitHub App tokens could not be renewed. Agents act on GitHub as the signed-in user.", {
          cause: toLogValue(error),
        });
      }
    }
    return before !== this.#signature();
  }

  #signature(): string {
    return this.entries()
      .map(([repository, token]) => `${repository}\u0000${token}`)
      .sort()
      .join("\u0001");
  }
}
