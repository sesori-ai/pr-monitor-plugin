import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { packageSkillDirectory } from "../runtime/package-skill"
import {
  registerPiMonitor,
  type PiMonitorController,
  type PiMonitorDependencies,
} from "./extension"

type OmpSessionSwitchEvent = {
  type: "session_switch"
  reason: "new" | "resume" | "fork"
  previousSessionFile: string | undefined
}

type OmpLifecycleApi = {
  on(
    event: "session_switch",
    handler: (event: OmpSessionSwitchEvent, context: ExtensionContext) => Promise<void> | void,
  ): void
}

export function registerOmpMonitor({
  pi,
  moduleUrl,
  dependencies,
}: {
  pi: ExtensionAPI
  moduleUrl: string
  dependencies?: PiMonitorDependencies
}): PiMonitorController {
  const controller = registerPiMonitor({ pi, dependencies })
  const ompLifecycle = pi as unknown as OmpLifecycleApi
  const skillDirectory = packageSkillDirectory({ moduleUrl })

  ompLifecycle.on("session_switch", async () => {
    await controller.dispose()
  })
  pi.on("resources_discover", () => ({ skillPaths: [skillDirectory] }))

  return controller
}
