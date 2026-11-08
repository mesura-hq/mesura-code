import {
  type PushDeviceState,
  usePushSubscription,
} from "../../pushNotifications/usePushSubscription";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const PUSH_STATUS: Record<Exclude<PushDeviceState["kind"], "unsupported" | "unknown">, string> = {
  checking: "Checking this device…",
  blocked:
    "Notifications are blocked for this site. Allow them in the browser's site settings, then reload.",
  forbidden:
    "This connection cannot change the host's settings, which push needs. Pair this device with settings access.",
  off: "A system notification on this device when a thread needs you, even with Mesura Code closed.",
  on: "This device gets a notification when a thread waits for approval or input, or fails.",
};

function pushStatus(state: PushDeviceState): string {
  switch (state.kind) {
    case "unsupported":
      return state.reason === "desktop-shell"
        ? "Not available in the desktop app. Turn it on in the browser on your phone."
        : "Not supported in this browser. Push needs Web Push over HTTPS.";
    case "unknown":
      return `Could not check push with the host: ${state.detail}`;
    default:
      return PUSH_STATUS[state.kind];
  }
}

/** Mesura: Web Push from the host to this device, beside the page notifications. */
export function PushNotificationSettings() {
  const push = usePushSubscription();

  return (
    <SettingsRow
      title="Push to this device"
      description={push.message ?? pushStatus(push.state)}
      control={
        <div className="flex items-center gap-2">
          {push.state.kind === "on" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!push.canSendTest}
              onClick={() => void push.sendTestNotification()}
            >
              Send test notification
            </Button>
          ) : null}
          {push.state.kind === "unknown" ? (
            <Button size="sm" variant="outline" onClick={push.checkAgain}>
              Check again
            </Button>
          ) : null}
          <Switch
            checked={push.state.kind === "on"}
            disabled={!push.canToggle}
            onCheckedChange={(checked) => void push.setEnabled(checked)}
            aria-label="Push to this device"
          />
        </div>
      }
    />
  );
}
