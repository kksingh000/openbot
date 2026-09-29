import { DISCONNECTED_GITHUB_CONNECTOR, type GitHubConnectorStatus } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { type GitHubConnectorPort, githubConnectorPort } from "./github-connector-port";

export interface GitHubConnectorController {
  status: () => GitHubConnectorStatus;
  busy: () => boolean;
  /** Reads the status again, for a view that opens after a first read failed. */
  reload: () => void;
  connect: () => void;
  cancel: () => void;
  disconnect: () => void;
  openVerification: () => void;
  openInstall: () => void;
}

/**
 * The GitHub connection of this computer, for the owner that shows it. Reads the status once and
 * then follows main's `changed` event, because the sign-in finishes in the browser, outside this
 * window. Call it inside a component: the subscription ends with that component.
 *
 * Cancel does not wait for another action. The connect action waits for GitHub's first answer, and
 * Cancel is the way out of that wait.
 */
export function createGitHubConnector(
  port: () => GitHubConnectorPort = githubConnectorPort,
): GitHubConnectorController {
  const [status, setStatus] = createSignal<GitHubConnectorStatus>(DISCONNECTED_GITHUB_CONNECTOR);
  const [busy, setBusy] = createSignal(false);
  let disposed = false;

  const unsubscribe = port().onChanged((next) => {
    if (!disposed) setStatus(next);
  });
  // A failed read keeps the last status. The next `reload` or `changed` event replaces it.
  const reload = () => {
    void port()
      .status()
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch(() => undefined);
  };
  onSettled(reload);
  onCleanup(() => {
    disposed = true;
    unsubscribe();
  });

  const run = (action: () => Promise<GitHubConnectorStatus | undefined>, waits = true) => {
    if (waits && busy()) return;
    if (waits) setBusy(true);
    void action()
      .then((next) => {
        if (next && !disposed) setStatus(next);
      })
      .catch((error: unknown) => {
        const { t, errorMessage } = currentText();
        toast.error(t("connector.github.actionFailed"), {
          description: errorMessage(error, t("connector.github.actionFailed")),
        });
      })
      .finally(() => {
        if (waits && !disposed) setBusy(false);
      });
  };

  return {
    status,
    busy,
    reload,
    connect: () => run(() => port().connect()),
    cancel: () => run(() => port().cancel(), false),
    disconnect: () => run(() => port().disconnect()),
    openVerification: () => run(async () => void (await port().openVerification())),
    openInstall: () => run(async () => void (await port().openInstall())),
  };
}
