import { Plugin } from "@opencode/plugin"

// Server-side entry point. The monitor is CLI-only, but the package exports a
// `.` entry so it can be loaded safely by tooling that expects both targets.
export default Plugin.define({
  id: "sachin.subagents.server",
  setup() {},
})
