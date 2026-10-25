// pr-monitor — OpenCode V2 plugin entrypoint. OpenCode loads only the default
// export, which must be a definition with an `id` and a `setup` function.

import type { Plugin } from "@opencode/plugin"
import { createNodeGhRunner } from "../runtime/node-gh"
import { createPrMonitorPlugin } from "./plugin"

const PrMonitorPlugin: Plugin.Plugin = createPrMonitorPlugin({ runGh: createNodeGhRunner() })

export default PrMonitorPlugin
