export type HrcTopVisibleRow = {
  id: string
}

export type HrcTopNavState = {
  selectedRowId: string | undefined
  selectedIndex: number
  marks: Readonly<Record<string, string>>
  previousVisibleRowIds?: readonly string[] | undefined
}

export type HrcTopNavAction =
  | { type: 'key'; key: 'j' | 'k' | 'gg' | 'G' | 'ctrl-d' | 'ctrl-u' | 'ctrl-f' | 'ctrl-b' }
  | { type: 'mark'; name: string }
  | { type: 'jumpToMark'; name: string }
  | { type: 'refresh' }

export type HrcTopNavContext = {
  visibleRows: readonly HrcTopVisibleRow[]
  viewportHeight: number
}

export function createNavState(input: {
  visibleRows: readonly HrcTopVisibleRow[]
  viewportHeight: number
  selectedRowId?: string | undefined
}): HrcTopNavState {
  const selectedIndex = selectedIndexFor(input.visibleRows, input.selectedRowId)
  return stateForIndex(
    input.visibleRows,
    selectedIndex,
    {},
    input.visibleRows.map((row) => row.id)
  )
}

export function reduceNavState(
  state: HrcTopNavState,
  action: HrcTopNavAction,
  context: HrcTopNavContext
): HrcTopNavState {
  const reconciled = reconcileSelection(state, context.visibleRows)

  if (action.type === 'mark') {
    if (!reconciled.selectedRowId || action.name.length === 0) return reconciled
    return {
      ...reconciled,
      marks: { ...reconciled.marks, [action.name]: reconciled.selectedRowId },
    }
  }

  if (action.type === 'jumpToMark') {
    const markedRowId = reconciled.marks[action.name]
    if (!markedRowId) return reconciled
    const markedIndex = context.visibleRows.findIndex((row) => row.id === markedRowId)
    if (markedIndex < 0) return reconciled
    return stateForIndex(context.visibleRows, markedIndex, reconciled.marks)
  }

  if (action.type === 'refresh') {
    return reconciled
  }

  const targetIndex = moveIndex(reconciled.selectedIndex, action.key, context)
  return stateForIndex(context.visibleRows, targetIndex, reconciled.marks)
}

function selectedIndexFor(
  visibleRows: readonly HrcTopVisibleRow[],
  selectedRowId: string | undefined
): number {
  if (visibleRows.length === 0) return -1
  if (selectedRowId) {
    const selectedIndex = visibleRows.findIndex((row) => row.id === selectedRowId)
    if (selectedIndex >= 0) return selectedIndex
  }
  return 0
}

function stateForIndex(
  visibleRows: readonly HrcTopVisibleRow[],
  selectedIndex: number,
  marks: Readonly<Record<string, string>>,
  previousVisibleRowIds: readonly string[] = visibleRows.map((row) => row.id)
): HrcTopNavState {
  if (visibleRows.length === 0) {
    return {
      selectedRowId: undefined,
      selectedIndex: -1,
      marks,
      previousVisibleRowIds,
    }
  }

  const clampedIndex = clamp(selectedIndex, 0, visibleRows.length - 1)
  return {
    selectedRowId: visibleRows[clampedIndex]?.id,
    selectedIndex: clampedIndex,
    marks,
    previousVisibleRowIds,
  }
}

function reconcileSelection(
  state: HrcTopNavState,
  visibleRows: readonly HrcTopVisibleRow[]
): HrcTopNavState {
  if (visibleRows.length === 0) {
    return stateForIndex(visibleRows, -1, state.marks)
  }

  if (state.selectedRowId) {
    const selectedIndex = visibleRows.findIndex((row) => row.id === state.selectedRowId)
    if (selectedIndex >= 0) return stateForIndex(visibleRows, selectedIndex, state.marks)
  }

  const fallbackIndex = nearestSurvivingIndex(state, visibleRows)
  return stateForIndex(visibleRows, fallbackIndex, state.marks)
}

function nearestSurvivingIndex(
  state: HrcTopNavState,
  visibleRows: readonly HrcTopVisibleRow[]
): number {
  const previousIds = state.previousVisibleRowIds ?? []
  if (previousIds.length === 0) return clamp(state.selectedIndex, 0, visibleRows.length - 1)

  const oldIndex =
    state.selectedRowId !== undefined
      ? previousIds.indexOf(state.selectedRowId)
      : state.selectedIndex
  const targetIndex = oldIndex >= 0 ? oldIndex : state.selectedIndex

  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [index, row] of visibleRows.entries()) {
    const previousIndex = previousIds.indexOf(row.id)
    if (previousIndex < 0) continue
    const distance = Math.abs(previousIndex - targetIndex)
    if (distance < bestDistance || (distance === bestDistance && previousIndex >= targetIndex)) {
      bestIndex = index
      bestDistance = distance
    }
  }

  if (bestDistance !== Number.POSITIVE_INFINITY) return bestIndex
  return clamp(state.selectedIndex, 0, visibleRows.length - 1)
}

function moveIndex(
  selectedIndex: number,
  key: Extract<HrcTopNavAction, { type: 'key' }>['key'],
  context: HrcTopNavContext
): number {
  if (context.visibleRows.length === 0) return -1

  const current = selectedIndex < 0 ? 0 : selectedIndex
  const halfPage = Math.max(1, Math.floor(context.viewportHeight / 2))
  const page = Math.max(1, context.viewportHeight)

  switch (key) {
    case 'j':
      return clamp(current + 1, 0, context.visibleRows.length - 1)
    case 'k':
      return clamp(current - 1, 0, context.visibleRows.length - 1)
    case 'gg':
      return 0
    case 'G':
      return context.visibleRows.length - 1
    case 'ctrl-d':
      return clamp(current + halfPage, 0, context.visibleRows.length - 1)
    case 'ctrl-u':
      return clamp(current - halfPage, 0, context.visibleRows.length - 1)
    case 'ctrl-f':
      return clamp(current + page, 0, context.visibleRows.length - 1)
    case 'ctrl-b':
      return clamp(current - page, 0, context.visibleRows.length - 1)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
