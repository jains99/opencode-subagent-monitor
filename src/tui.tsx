/**
 * Subagent monitor — a responsive live panel for OpenCode V2's TUI.
 *
 * Opens a side panel (or fullscreen grid) listing every child session under
 * the current session. Each card shows the agent, run state, current tool,
 * latest assistant text, tokens/cost, and pending permission prompts.
 *
 * Succeeded subagents auto-hide shortly after they finish; failed and
 * interrupted ones stay visible until cleared.
 *
 * Keys: up/down/left/right (or h/j/k/l) select, Enter opens the subagent in
 * the current tab, x interrupts it (with confirmation), c clears visible
 * finished cards permanently, f toggles fullscreen, Esc closes.
 */

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { SessionInfo, SessionMessageAssistantTool } from "@opencode/client"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"

const PANEL_NAME = "subagent-monitor"
const CARD_HEIGHT = 6
const CARD_GAP = 1
/** How long a succeeded card stays visible after the session goes idle. */
const DONE_VISIBLE_MS = 30_000

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m tok`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`
  return `${n} tok`
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

function formatCost(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 3 : 2)}`
}

// East Asian wide characters render at two terminal cells.
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

function displayWidth(value: string): number {
  let width = 0
  for (const char of Array.from(value)) width += WIDE.test(char) ? 2 : 1
  return width
}

function truncate(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  if (width <= 0) return ""
  if (displayWidth(clean) <= width) return clean
  if (width <= 2) return "…"
  const chars = Array.from(clean)
  let used = 0
  let end = chars.length
  for (let i = 0; i < chars.length; i++) {
    const cell = WIDE.test(chars[i]) ? 2 : 1
    if (used + cell > width - 1) {
      end = i
      break
    }
    used += cell
  }
  return `${chars.slice(0, end).join("")}…`
}

function statusOf(
  ctx: ReturnType<typeof usePlugin>,
  session: SessionInfo,
): {
  glyph: string
  color: RGBA
  label: string
} {
  const running = ctx.data.session.status(session.id) === "running"
  if (running) {
    return {
      glyph: SPINNER[Math.floor(Date.now() / 120) % SPINNER.length]!,
      color: ctx.theme.text.feedback.success.base,
      label: "running",
    }
  }
  if (session.outcome === "failed") {
    return {
      glyph: "✕",
      color: ctx.theme.text.feedback.error.base,
      label: "failed",
    }
  }
  if (session.outcome === "interrupted") {
    return {
      glyph: "◌",
      color: ctx.theme.text.feedback.warning.base,
      label: "interrupted",
    }
  }
  if (session.outcome === "succeeded") {
    return {
      glyph: "✓",
      color: ctx.theme.text.feedback.success.base,
      label: "done",
    }
  }
  return {
    glyph: "○",
    color: ctx.theme.text.muted,
    label: "idle",
  }
}

function latestActivity(
  ctx: ReturnType<typeof usePlugin>,
  sessionID: string,
): { tool?: SessionMessageAssistantTool; text: string; context?: number } {
  const messages = ctx.data.session.message.list(sessionID)
  let tool: SessionMessageAssistantTool | undefined
  let text = ""
  let context: number | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== "assistant") continue
    if (context === undefined) {
      const usage = message.tokens
      const estimate =
        (usage?.input ?? 0) +
        (usage?.cache?.read ?? 0) +
        (usage?.cache?.write ?? 0)
      if (estimate > 0) context = estimate
    }
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]
      if (!part) continue
      if (!tool && part.type === "tool") tool = part
      if (!text && part.type === "text" && part.text.trim()) text = part.text
    }
    if (tool && text && context !== undefined) break
  }

  return { tool, text, context }
}

function contextLimit(
  ctx: ReturnType<typeof usePlugin>,
  session: SessionInfo,
): number | undefined {
  const ref = session.model
  if (!ref) return undefined
  const models = ctx.data.location.model.list()
  const match = models?.find(
    (model) =>
      model.providerID === ref.providerID && model.modelID === ref.id,
  )
  return match?.limit?.context
}

function toolPreview(tool: SessionMessageAssistantTool | undefined): string {
  if (!tool) return ""
  const input = tool.state.input
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""

  const record = input as Record<string, unknown>
  for (const key of [
    "command",
    "description",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
  ]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }

  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function sessionDuration(ctx: ReturnType<typeof usePlugin>, session: SessionInfo): string {
  const running = ctx.data.session.status(session.id) === "running"
  const end = running ? Date.now() : (session.time.idle ?? session.time.updated)
  return formatDuration(end - session.time.created)
}

function tokenTotal(session: SessionInfo): number {
  return (
    session.tokens.input +
    session.tokens.output +
    session.tokens.reasoning
  )
}

function Card(props: {
  session: SessionInfo
  width: number
  selected: boolean
  index: number
  /** Re-render tick from the parent; drives the spinner and elapsed time. */
  tick: number
  onSelect: (index: number) => void
}) {
  const ctx = usePlugin()
  const status = () => {
    void props.tick
    return statusOf(ctx, props.session)
  }
  const activity = () => latestActivity(ctx, props.session.id)
  const permissions = () =>
    ctx.data.session.permission.list(props.session.id)?.length ?? 0

  const inner = () => Math.max(10, props.width - 4)
  const headerRight = () => {
    void props.tick
    return sessionDuration(ctx, props.session)
  }
  const name = () => {
    const label = `${status().glyph} ${props.session.agent ?? "subagent"}`
    const right = headerRight().length
    return truncate(label, Math.max(6, inner() - right - 1))
  }

  const toolLine = () => {
    const current = activity().tool
    if (current) {
      const preview = toolPreview(current)
      return truncate(preview ? `${current.name} · ${preview}` : current.name, inner())
    }
    if (ctx.data.session.status(props.session.id) === "running") return "thinking…"
    return status().label
  }

  const quote = () => {
    const text = activity().text
    return text ? `“${truncate(text, inner() - 2)}”` : "—"
  }

  const footerLeft = () => {
    const parts: string[] = []
    const context = activity().context
    if (context !== undefined) {
      const limit = contextLimit(ctx, props.session)
      parts.push(
        limit
          ? `ctx ${formatContext(context)}/${formatContext(limit)}`
          : `ctx ${formatContext(context)}`,
      )
    }
    parts.push(formatTokens(tokenTotal(props.session)))
    parts.push(formatCost(props.session.cost))
    const left = parts.join(" · ")
    const badgeText = badge().text
    return truncate(left, Math.max(4, inner() - badgeText.length - 1))
  }

  const badge = () => {
    if (permissions() > 0) {
      return { text: `⚠ ${permissions()} ask`, color: ctx.theme.text.feedback.warning.base }
    }
    if (props.session.outcome === "failed") {
      return { text: "✕ failed", color: ctx.theme.text.feedback.error.base }
    }
    if (props.session.outcome === "interrupted") {
      return { text: "◌ stopped", color: ctx.theme.text.feedback.warning.base }
    }
    if (props.session.outcome === "succeeded") {
      return { text: "✓ done", color: ctx.theme.text.feedback.success.base }
    }
    if (ctx.data.session.status(props.session.id) === "running") {
      return { text: "running", color: ctx.theme.text.feedback.success.base }
    }
    return { text: "idle", color: ctx.theme.text.muted }
  }

  return (
    <box
      width={props.width}
      height={CARD_HEIGHT}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={
        props.selected ? ctx.theme.text.base : ctx.theme.border.base
      }
      backgroundColor={
        props.selected ? ctx.theme.background.raised.base : undefined
      }
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={() => {
        props.onSelect(props.index)
      }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={status().color} wrapMode="none" truncate>
          {name()}
        </text>
        <text fg={ctx.theme.text.muted} wrapMode="none">{headerRight()}</text>
      </box>
      <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
        {toolLine()}
      </text>
      <text fg={ctx.theme.text.base} wrapMode="none" truncate>
        {quote()}
      </text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
          {footerLeft()}
        </text>
        <text fg={badge().color} wrapMode="none">{badge().text}</text>
      </box>
    </box>
  )
}

function Empty(props: { hidden?: number }) {
  const ctx = usePlugin()
  const hidden = () => props.hidden ?? 0
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={1}
    >
      <text fg={ctx.theme.text.muted}>
        {hidden() > 0 ? "No active subagents." : "No subagents yet."}
      </text>
      <text fg={ctx.theme.text.muted}>
        {hidden() > 0
          ? `${hidden()} finished ${hidden() === 1 ? "card is" : "cards are"} hidden.`
          : "They appear here when the main agent launches one."}
      </text>
    </box>
  )
}

function SubagentPanel(props: { panel: PanelInput }) {
  const ctx = usePlugin()
  const [version, setVersion] = createSignal(0)
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [clearedState, setClearedState] = ctx.storage.store<{ ids: string[] }>(
    "cleared",
    { initial: { ids: [] } },
  )
  let scroll: ScrollBoxRenderable | undefined
  let throttle: ReturnType<typeof setTimeout> | undefined
  let rowsCache: { key: string; cols: number; rows: SessionInfo[][] } | undefined
  const synced = new Set<string>()

  const allSessions = (): SessionInfo[] => {
    version()
    const root = ctx.data.session.root(props.panel.sessionID)
    const all = ctx.data.session.list()
    const children: SessionInfo[] = []
    const queue = [root]
    while (queue.length > 0) {
      const parent = queue.shift()!
      for (const session of all) {
        if (session.parentID !== parent) continue
        children.push(session)
        queue.push(session.id)
      }
    }
    return children.sort((a, b) => a.time.created - b.time.created)
  }

  const finished = (session: SessionInfo): boolean =>
    session.outcome === "succeeded" ||
    session.outcome === "failed" ||
    session.outcome === "interrupted"

  const sessions = (): SessionInfo[] => {
    const hidden = new Set(clearedState.ids)
    const now = Date.now()
    return allSessions().filter((session) => {
      if (hidden.has(session.id) && finished(session)) return false
      // Succeeded cards auto-hide after DONE_VISIBLE_MS; failures stay.
      if (session.outcome === "succeeded") {
        const end = session.time.idle ?? session.time.updated
        if (end && now - end > DONE_VISIBLE_MS) return false
      }
      return true
    })
  }

  const hiddenCount = () => allSessions().length - sessions().length
  const finishedCount = () => sessions().filter(finished).length

  const selectedIndex = (): number => {
    const list = sessions()
    const id = selectedId()
    const index = id ? list.findIndex((session) => session.id === id) : -1
    return index >= 0 ? index : 0
  }

  const selectedSession = (): SessionInfo | undefined => {
    const list = sessions()
    if (list.length === 0) return undefined
    return list[selectedIndex()]
  }

  const layoutWidth = (): number =>
    props.panel.presentation === "fullscreen"
      ? ctx.renderer.width
      : props.panel.width

  const columns = (): number => {
    const width = layoutWidth()
    const max = width >= 150 ? 3 : width >= 96 ? 2 : 1
    return Math.min(max, Math.max(1, sessions().length))
  }

  const cardWidth = (): number => {
    const available = Math.max(24, layoutWidth() - 2)
    const gaps = CARD_GAP * (columns() - 1)
    return Math.max(22, Math.floor((available - gaps) / columns()))
  }

  // Cache row arrays so <For> items keep stable references across the 1s
  // tick — otherwise every card would remount each second.
  const rows = (): SessionInfo[][] => {
    const list = sessions()
    const cols = columns()
    const key = list.map((session) => session.id).join("\n")
    if (rowsCache && rowsCache.key === key && rowsCache.cols === cols) {
      return rowsCache.rows
    }
    const result: SessionInfo[][] = []
    for (let i = 0; i < list.length; i += cols) {
      result.push(list.slice(i, i + cols))
    }
    rowsCache = { key, cols, rows: result }
    return result
  }

  const runningCount = () =>
    sessions().filter((session) => ctx.data.session.status(session.id) === "running")
      .length

  const pruneCleared = () => {
    const ids = clearedState.ids
    if (ids.length === 0) return
    const all = new Set(ctx.data.session.list().map((session) => session.id))
    if (ids.some((id) => !all.has(id))) {
      void setClearedState((draft) => {
        draft.ids = draft.ids.filter((id) => all.has(id))
      })
    }
  }

  const bump = () => setVersion((value) => value + 1)
  const schedule = () => {
    if (throttle) return
    throttle = setTimeout(() => {
      throttle = undefined
      pruneCleared()
      bump()
    }, 100)
  }

  onMount(() => {
    props.panel.focus()
    const stop = ctx.data.listen(() => schedule())
    const timer = setInterval(bump, 1000)
    const root = ctx.data.session.root(props.panel.sessionID)
    void ctx.data.session.sync(root).catch(() => {})
    onCleanup(() => {
      stop()
      clearInterval(timer)
      if (throttle) clearTimeout(throttle)
    })
  })

  createEffect(() => {
    version()
    for (const session of sessions()) {
      if (synced.has(session.id)) continue
      synced.add(session.id)
      // Drop from `synced` on failure so the next tick retries.
      void ctx.data.session
        .message.sync(session.id)
        .catch(() => synced.delete(session.id))
      void ctx.data.session
        .permission.sync(session.id)
        .catch(() => synced.delete(session.id))
    }
  })

  createEffect(() => {
    const list = sessions()
    const id = selectedId()
    if (list.length === 0) {
      if (id !== undefined) setSelectedId(undefined)
      return
    }
    if (!id || !list.some((session) => session.id === id)) {
      setSelectedId(list[0]?.id)
    }
  })

  createEffect(() => {
    const list = sessions()
    const index = selectedIndex()
    if (!scroll || list.length === 0) return
    const row = Math.floor(index / columns())
    const top = row * (CARD_HEIGHT + CARD_GAP)
    const bottom = top + CARD_HEIGHT
    const viewTop = scroll.scrollTop
    const viewBottom = viewTop + scroll.viewport.height
    if (top < viewTop) scroll.scrollTo({ x: 0, y: top })
    else if (bottom > viewBottom) scroll.scrollTo({ x: 0, y: bottom - scroll.viewport.height })
  })

  const move = (delta: number) => {
    const list = sessions()
    const count = list.length
    if (count === 0) return
    const next = (selectedIndex() + delta + count) % count
    setSelectedId(list[next]?.id)
  }

  const openSelected = () => {
    const session = selectedSession()
    if (!session) return
    // V2 tabs are root-session-only. `tabs.focus` returns true for a child
    // without navigating, so route directly to the child inside the current tab.
    ctx.ui.router.navigate({ type: "session", sessionID: session.id })
  }

  const interruptSelected = async () => {
    const session = selectedSession()
    if (!session) return
    if (ctx.data.session.status(session.id) !== "running") return
    const label = session.agent ?? "subagent"
    const confirmed = await ctx.ui.dialog.confirm({
      title: `Interrupt ${label}?`,
      message:
        "The subagent stops after its current step. You can relaunch it from the parent session.",
      label: { confirm: "Interrupt", cancel: "Cancel" },
    })
    if (!confirmed) return
    // Re-check: it may have finished while the dialog was open.
    if (ctx.data.session.status(session.id) !== "running") {
      ctx.ui.toast.show({
        message: `${label} already finished`,
        variant: "warning",
      })
      return
    }
    try {
      await ctx.client.session.interrupt({ sessionID: session.id })
    } catch (error) {
      ctx.ui.toast.show({
        message: `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      })
    }
  }

  const clearFinished = () => {
    const hidden = new Set(clearedState.ids)
    const toAdd = allSessions()
      .filter((session) => finished(session) && !hidden.has(session.id))
      .map((session) => session.id)
    if (toAdd.length === 0) return
    void setClearedState((draft) => {
      const next = new Set(draft.ids)
      for (const id of toAdd) next.add(id)
      draft.ids = [...next]
    })
  }

  const footerHint = () => {
    const clear = finishedCount() > 0 ? " · c clear finished" : ""
    return `↑↓←→ select · ⏎ open · x interrupt${clear} · f ${
      props.panel.presentation === "fullscreen" ? "exit full" : "full"
    } · esc close`
  }

  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    priority: 100,
    commands: [
      { id: "subagent-monitor.up", bind: "up", run: () => move(-columns()) },
      { id: "subagent-monitor.down", bind: "down", run: () => move(columns()) },
      { id: "subagent-monitor.left", bind: "left", run: () => move(-1) },
      { id: "subagent-monitor.right", bind: "right", run: () => move(1) },
      { id: "subagent-monitor.k", bind: "k", run: () => move(-columns()) },
      { id: "subagent-monitor.j", bind: "j", run: () => move(columns()) },
      { id: "subagent-monitor.h", bind: "h", run: () => move(-1) },
      { id: "subagent-monitor.l", bind: "l", run: () => move(1) },
      { id: "subagent-monitor.open", bind: "enter", run: openSelected },
      { id: "subagent-monitor.interrupt", bind: "x", run: interruptSelected },
      { id: "subagent-monitor.clear", bind: "c", run: clearFinished },
      {
        id: "subagent-monitor.fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "subagent-monitor.close",
        bind: "escape",
        run: () => props.panel.close(),
      },
    ],
  }))

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      onMouseUp={() => props.panel.focus()}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={ctx.theme.text.base}>
          SUBAGENTS
        </text>
        <text fg={ctx.theme.text.muted}>
          {sessions().length === 0
            ? "none"
            : `${runningCount()} running · ${sessions().length} total`}
        </text>
      </box>

      <Show when={sessions().length > 0} fallback={<Empty hidden={hiddenCount()} />}>
        <scrollbox
          ref={scroll}
          flexGrow={1}
          width="100%"
          scrollY={true}
          scrollX={false}
          focusable={false}
          viewportCulling={true}
          verticalScrollbarOptions={{ visible: false }}
        >
          <box
            flexDirection="column"
            width="100%"
            gap={CARD_GAP}
            paddingLeft={1}
            paddingRight={1}
          >
            <For each={rows()}>
              {(row, rowIndex) => (
                <box flexDirection="row" width="100%" gap={CARD_GAP}>
                  <For each={row}>
                    {(session, index) => (
                      <Card
                        session={session}
                        width={cardWidth()}
                        selected={sessions()[selectedIndex()]?.id === session.id}
                        index={rowIndex() * columns() + index()}
                        tick={version()}
                        onSelect={(next) => {
                          setSelectedId(sessions()[next]?.id)
                          props.panel.focus()
                        }}
                      />
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>

      <box paddingLeft={1} paddingRight={1}>
        <text fg={ctx.theme.text.muted} truncate>
          {footerHint()}
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: PANEL_NAME,
  setup(context) {
    const dispose = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <SubagentPanel panel={panel} />
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "subagent-monitor.toggle",
          title: "Subagent monitor",
          description: "Show live subagent activity in a side panel",
          group: "Plugins",
          bind: "ctrl+alt+s",
          palette: true,
          slash: { name: "subagents" },
          run: () => {
            const current = context.ui.panel.current()
            if (current?.name === PANEL_NAME) {
              context.ui.panel.close()
              return
            }
            if (!context.ui.panel.open(PANEL_NAME)) {
              context.ui.toast.show({
                message: "Open a session to use the subagent monitor",
                variant: "warning",
              })
            }
          },
        },
      ],
    }))

    return dispose
  },
})
