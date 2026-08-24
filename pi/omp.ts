import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerOmpMonitor } from "./omp-adapter"

export default function PrMonitorOmp(pi: ExtensionAPI): void {
  registerOmpMonitor({ pi, moduleUrl: import.meta.url })
}
