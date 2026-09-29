import type { GitHubConnectorStatus } from "@openbot/contracts/ipc";
import { GitHubConnectorPanel } from "@openbot/ui/features/settings/GitHubConnectorPanel";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const meta = {
  title: "Settings/GitHubConnectorPanel",
  component: GitHubConnectorPanel,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof GitHubConnectorPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const DISCONNECTED: GitHubConnectorStatus = {
  available: true,
  state: "disconnected",
  login: null,
  avatarUrl: null,
  userCode: null,
  verificationUri: null,
  error: null,
};

const args = (status: Partial<GitHubConnectorStatus>, busy = false) => ({
  status: { ...DISCONNECTED, ...status },
  busy,
  onConnect: fn(),
  onCancel: fn(),
  onDisconnect: fn(),
  onOpenVerification: fn(),
  onOpenInstall: fn(),
});

export const Disconnected: Story = { args: args({}) };

export const Pending: Story = {
  args: args({ state: "pending", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" }),
};

/** GitHub has not answered the device code request yet. */
export const PendingWithoutCode: Story = { args: args({ state: "pending" }) };

export const Connected: Story = { args: args({ state: "connected", login: "octocat" }) };

export const Expired: Story = { args: args({ state: "expired", login: "octocat" }) };

export const Failed: Story = {
  args: args({ error: "The GitHub sign-in was refused." }),
};
