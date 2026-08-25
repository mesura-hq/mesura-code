import { APP_STAGE_LABEL } from "../branding";
import { resolveEnvironmentIdentificationPillLabel } from "./SidebarStageBackdrop";

/**
 * The React-side twin of the `#boot-shell` markup in `apps/web/index.html`.
 * Both draw the channel-neutral cube and name the stage below it, so keep the
 * two in step whenever either changes.
 */
export function SplashScreen() {
  const stageLabel = resolveEnvironmentIdentificationPillLabel(APP_STAGE_LABEL);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 flex-col items-center justify-center gap-2.5"
        aria-label="Mesura Code splash screen"
      >
        <img alt="Mesura Code" className="size-16 object-contain" src="/splash-mark.png" />
        {stageLabel ? (
          <span className="text-[10px] font-semibold uppercase leading-none tracking-[0.18em] opacity-55">
            {stageLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
