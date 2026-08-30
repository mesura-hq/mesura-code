import type { SymmetriaDictationMode } from "@symmetria/broker-contract";

import { cn } from "~/lib/utils";

const MATERIAL_SYMBOL_PATHS: Record<SymmetriaDictationMode, string> = {
  clipboard:
    "M360 240Q327 240 303.5 263.5Q280 287 280 320V800Q280 833 303.5 856.5Q327 880 360 880H720Q753 880 776.5 856.5Q800 833 800 800V320Q800 287 776.5 263.5Q753 240 720 240ZM360 320H720V800H360ZM200 80Q167 80 143.5 103.5Q120 127 120 160V720H200V160H640V80Z",
  inject:
    "M160 160Q127 160 103.5 183.5Q80 207 80 240V360H160V240H800V720H160V600H80V720Q80 753 103.5 776.5Q127 800 160 800H800Q833 800 856.5 776.5Q880 753 880 720V240Q880 207 856.5 183.5Q833 160 800 160ZM460 300 404 358 487 440H80V520H487L404 602L460 660L640 480Z",
  submit: "M120 160V800L880 480ZM200 280 674 480 200 680V540L440 480L200 420Z",
};

const MATERIAL_SYMBOL_NAMES: Record<SymmetriaDictationMode, string> = {
  clipboard: "content_copy",
  inject: "input",
  submit: "send",
};

export function MaterialDictationModeIcon(props: {
  mode: SymmetriaDictationMode;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 960 960"
      data-material-symbol={MATERIAL_SYMBOL_NAMES[props.mode]}
      className={cn("fill-current", props.className)}
    >
      <path transform="translate(0 960) scale(1 -1)" d={MATERIAL_SYMBOL_PATHS[props.mode]} />
    </svg>
  );
}
