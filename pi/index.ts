import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerPiMonitor } from "./extension"

export default function PrMonitorPi(pi: ExtensionAPI): void {
  registerPiMonitor({ pi })
}
