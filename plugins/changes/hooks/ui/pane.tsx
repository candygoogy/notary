import type { Elements, RenderSurface } from 'claude-code'

import { shownPath } from '../core/paths.ts'
import { turnTitle } from '../core/title.ts'
import type { FileChange, TimelineNode, TimelineRow } from '../core/timeline.ts'

type PaneElements = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Text' | 'Code'>

import type { DiffView } from '../io/diffs.ts'

export type RevertAsk = { turnId: string; key: string; path: string; mode: 'turn' | 'turnAndLater'; accept: boolean; label: string }

export type PaneInput = {
  rows: TimelineRow[]
  selected: string | null
  node: string | null
  // The selected turn's files, narrowed to `node` when one is selected.
  files: FileChange[]
  diffs: Record<string, DiffView>
  expanded: readonly string[]
  confirm: RevertAsk | null
  offer: RevertAsk | null
  // After Revert all: each skipped file's own way on, drawn on its row.
  offers: readonly RevertAsk[]
  // Revert all for the selected turn: offered while a file is pending, armed
  // after the first press.
  canRevertAll: boolean
  confirmAll: { turnId: string; label: string } | null
  notice: string | null
  // Why tracking is paused, when it is.
  paused: string | null
  cwd: string
  // When this launch began: rows from before it came from an earlier launch.
  launchedAt: number
  isWindows: boolean
  onSelect: (turnId: string) => void
  onNode: (node: string | null) => void
  onKeep: (file: FileChange) => void
  onRevert: (file: FileChange) => void
  onConfirm: (file: FileChange) => void
  onOffer: () => void
  onOfferFile: (ask: RevertAsk) => void
  onRevertAll: (turnId: string) => void
  onConfirmAll: (turnId: string) => void
  onShowAll: (file: FileChange) => void
}

const STATUS_MARK = { pending: '•', kept: '✓', reverted: '↶' } as const

// Element keys: register's ui.focus hook reads the `select-` and `node-`
// prefixes (selection only, never Keep, Revert or Confirm).
export const fileId = (file: Pick<FileChange, 'turnId' | 'key'>) => `${file.turnId}-${file.key}`

// The Changes pane: the timeline newest first; under the selected turn its
// steps (calls and agents) and its files, each with its diff, Keep and a
// two-step Revert. Pure: register.tsx computes the diffs and the handlers.
export function paneView({ Box, Button, Text, Code }: PaneElements, input: PaneInput) {
  const rows = input.rows.filter(r => r.kind === 'action' || r.files.length > 0 || r.untracked.length > 0)
  // Newest first: the first row from before this launch starts the earlier part.
  const firstEarlier = rows.findIndex(row => atOf(row) < input.launchedAt)
  const path = (p: string) => shownPath(input.cwd, p, input.isWindows)
  if (rows.length === 0) {
    return (
      <Box key="changes" flexDirection="column">
        {input.paused !== null ? <Text color="warning">{input.paused}</Text> : null}
        <Text dimColor>No changes yet. Each turn that edits files shows here, with its diffs.</Text>
      </Box>
    )
  }

  const nodeRows = (nodes: TimelineNode[], depth: number): ReturnType<typeof Button>[] =>
    nodes.flatMap(node => {
      const id = node.kind === 'call' ? node.toolUseId : node.agentId
      const name = node.kind === 'call' ? `${node.via === 'unattributed' ? 'changed during this turn (shell or you)' : node.tool}` : `agent ${node.label ?? node.agentId.slice(0, 8)}`
      const count = `${node.keys.length} ${node.keys.length === 1 ? 'file' : 'files'}`
      const isOn = input.node === id
      // Selecting sets, never toggles: a focus and a press arriving together
      // (the Desktop first click) must land on the same choice.
      const row = <Button key={`node-${id}`} plain label={`${'  '.repeat(depth + 2)}${isOn ? '●' : '○'} ${name} · ${count}`} onPress={() => input.onNode(id)} />
      return node.kind === 'agent' ? [row, ...nodeRows(node.children, depth + 1)] : [row]
    })

  const fileBlock = (file: FileChange) => {
    const id = fileId(file)
    const diff = input.diffs[file.key]
    const isConfirming = input.confirm !== null && input.confirm.turnId === file.turnId && input.confirm.key === file.key
    const counts = diff?.kind === 'diff' ? `  +${diff.added} −${diff.removed}` : ''
    const notes = [
      file.isNoop ? 'no net change' : null,
      diff?.kind === 'note' ? diff.text : null,
      diff?.kind === 'diff' && diff.eolOnly ? 'line endings only' : null,
      diff?.kind === 'diff' && diff.bomChanged ? 'byte-order mark changed' : null,
      diff?.kind === 'diff' && diff.capped ? 'too different to line up: shown as one replacement' : null,
      file.interleaved ? 'edited by two agents at once' : null,
      file.chainBroken ? 'changed outside Claude between edits; reverting this turn also undoes that' : null,
      file.edits.some(e => e.via === 'unattributed') ? 'changed during this turn (shell or you)' : null,
    ].filter((n): n is string => n !== null)
    const canAct = file.status !== 'reverted' && !file.isNoop
    const offer = input.offers.find(o => o.turnId === file.turnId && o.key === file.key)
    return (
      <Box key={`file-${id}`} flexDirection="column" marginBottom={1}>
        <Box key={`head-${id}`} flexDirection="row" gap={1}>
          <Text bold wrap="truncate-end">
            {STATUS_MARK[file.status]} {path(file.path)}
            {counts}
          </Text>
          {canAct ? <Button key={`keep-${id}`} label={file.status === 'kept' ? 'Undo keep' : 'Keep'} onPress={() => input.onKeep(file)} /> : null}
          {canAct && !isConfirming ? <Button key={`revert-${id}`} label="Revert" onPress={() => input.onRevert(file)} /> : null}
          {canAct && isConfirming ? <Button key={`confirm-${id}`} variant="primary" label={input.confirm!.label} onPress={() => input.onConfirm(file)} /> : null}
          {canAct && !isConfirming && offer !== undefined ? <Button key={`offer-${id}`} label={offer.label} onPress={() => input.onOfferFile(offer)} /> : null}
        </Box>
        {notes.map((note, i) => (
          <Text key={`note-${id}-${i}`} dimColor>
            {'  '}
            {note}
          </Text>
        ))}
        {diff?.kind === 'diff' && diff.hunks !== '' ? <Code source={diff.hunks} format="diff" path={file.path} /> : null}
        {diff?.kind === 'diff' && diff.shownRows < diff.totalRows ? (
          <Button key={`all-${id}`} plain label={`  … ${diff.totalRows - diff.shownRows} more lines · Show all`} onPress={() => input.onShowAll(file)} />
        ) : null}
      </Box>
    )
  }

  return (
    <Box key="changes" flexDirection="column">
      {input.paused !== null ? <Text color="warning">{input.paused}</Text> : null}
      {input.notice !== null ? (
        <Box key="notice" flexDirection="row" gap={1}>
          <Text wrap="wrap">{input.notice}</Text>
          {input.offer !== null ? <Button key="offer" label={input.offer.label} onPress={input.onOffer} /> : null}
        </Box>
      ) : null}
      {rows.flatMap((row, i) => (i === firstEarlier ? [earlierDivider(row), rowView(row)] : [rowView(row)]))}
    </Box>
  )

  function earlierDivider(row: TimelineRow) {
    return (
      <Text key="earlier" dimColor>
        ── Earlier · {whenOf(atOf(row))} ──
      </Text>
    )
  }

  function rowView(row: TimelineRow) {
        if (row.kind === 'action') {
          const verb = row.action.kind === 'revert' ? 'reverted' : row.action.kind === 'keep' ? 'kept' : 'unkept'
          return (
            <Text key={`action-${row.action.seq}`} dimColor>
              ↶ you {verb} {path(row.action.path)}
            </Text>
          )
        }
        const { turn, files, nodes, untracked } = row
        const isOpen = turn.turnId === input.selected
        const title = turn.kind === 'background' ? `background agent ${turn.turnId.slice('background:'.length, 'background:'.length + 8)}` : `#${turn.ordinal} ${turnTitle(turn.prompt)}`
        return (
          <Box key={`turn-${turn.turnId}`} flexDirection="column">
            <Button key={`select-${turn.turnId}`} plain label={`${isOpen ? '▾' : '▸'} ${title} · ${files.length} ${files.length === 1 ? 'file' : 'files'}`} onPress={() => input.onSelect(turn.turnId)} />
            {isOpen && turn.kind === 'turn' && input.confirmAll?.turnId === turn.turnId ? (
              <Button key={`confirmall-${turn.turnId}`} variant="primary" label={`    ${input.confirmAll.label}`} onPress={() => input.onConfirmAll(turn.turnId)} />
            ) : isOpen && turn.kind === 'turn' && input.canRevertAll ? (
              <Button key={`revertall-${turn.turnId}`} label={`    Revert all (#${turn.ordinal})`} onPress={() => input.onRevertAll(turn.turnId)} />
            ) : null}
            {isOpen && nodes.length > 1 ? (
              <Button key="node-all" plain label={`    ${input.node === null ? '●' : '○'} all steps`} onPress={() => input.onNode(null)} />
            ) : null}
            {isOpen && nodes.length > 1 ? nodeRows(nodes, 0) : null}
            {isOpen
              ? untracked.map(u => (
                  <Text key={`untracked-${u.seq}`} color="warning">
                    {'    '}⚠ {u.tool}: not tracked, {u.reason}
                  </Text>
                ))
              : null}
            {isOpen ? input.files.map(fileBlock) : null}
          </Box>
        )
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Oct 12, 14:05", in the time zone the mod runs in.
function whenOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${two(d.getHours())}:${two(d.getMinutes())}`
}

function atOf(row: TimelineRow): number {
  return row.kind === 'action' ? row.action.at : row.turn.startedAt
}
