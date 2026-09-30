import { createStore } from 'zustand/vanilla'
import type {
  Cave,
  FieldNotebook,
  NotebookBatch,
  NotebookMergePreview,
  Segment,
  Sketch,
  Station
} from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { buildFieldStation, buildMergePreview, parseFieldNotebook, stableHash } from '@/utils/notebookMerge'
import { recalculateSketchLayouts } from '@/utils/stationVersion'

export interface NotebookState {
  batches: NotebookBatch[]
  loaded: boolean
  hydrate: () => Promise<void>
  preview: (input: unknown) => Promise<NotebookMergePreview>
  importText: (raw: string, fileName?: string) => Promise<NotebookMergePreview>
  merge: (preview: NotebookMergePreview) => Promise<NotebookBatch>
  retry: (notebookId: string) => Promise<NotebookBatch>
  remove: (notebookId: string) => Promise<void>
}

async function currentCatalog(): Promise<{ caves: Cave[]; segments: Segment[]; stations: Station[]; sketches: Sketch[] }> {
  const [caves, segments, stations, sketches] = await Promise.all([
    db.caves.toArray(),
    db.segments.toArray(),
    db.stations.toArray(),
    db.sketches.toArray()
  ])
  return { caves, segments, stations, sketches }
}

function createPreviewFromNotebook(
  notebook: FieldNotebook,
  catalog: { caves: Cave[]; segments: Segment[]; stations: Station[] }
): NotebookMergePreview {
  return buildMergePreview(notebook, catalog.caves, catalog.segments, catalog.stations)
}

function invalidBatchId(raw: string): string {
  return `INVALID-${stableHash(raw.slice(0, 4096))}`
}

export const notebookStore = createStore<NotebookState>((set, get) => ({
  batches: [],
  loaded: false,

  hydrate: async () => {
    const batches = await syncAll<NotebookBatch>(db.notebooks)
    batches.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    set({ batches, loaded: true })
  },

  preview: async (input) => {
    const notebook = parseFieldNotebook(input)
    const catalog = await currentCatalog()
    return createPreviewFromNotebook(notebook, catalog)
  },

  importText: async (raw, fileName = '未保存手记') => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      const notebookId = invalidBatchId(raw)
      const failed: NotebookBatch = {
        notebookId,
        caveName: fileName,
        team: '',
        recordedAt: new Date().toISOString().slice(0, 10),
        status: 'failed',
        mergedAt: new Date().toISOString(),
        error: `JSON 无法解析：${error instanceof Error ? error.message : String(error)}`,
        rawInput: raw,
        importedCount: 0,
        conflictCount: 0,
        createdCount: 0
      }
      await db.notebooks.put(failed)
      await get().hydrate()
      throw new Error(failed.error)
    }

    try {
      return await get().preview(parsed)
    } catch (error) {
      let notebook = parsed as Partial<FieldNotebook> | null
      if (!notebook || typeof notebook !== 'object') notebook = null
      const message = error instanceof Error ? error.message : String(error)
      const failed: NotebookBatch = {
        notebookId:
          notebook && typeof notebook.notebookId === 'string' && notebook.notebookId.trim()
            ? notebook.notebookId.trim()
            : invalidBatchId(raw),
        caveName: notebook && typeof notebook.caveName === 'string' ? notebook.caveName : fileName,
        team: notebook && typeof notebook.team === 'string' ? notebook.team : '',
        recordedAt:
          notebook && typeof notebook.recordedAt === 'string'
            ? notebook.recordedAt
            : new Date().toISOString().slice(0, 10),
        status: 'failed',
        mergedAt: new Date().toISOString(),
        error: message,
        rawInput: raw,
        importedCount: 0,
        conflictCount: 0,
        createdCount: 0
      }
      await db.notebooks.put(failed)
      await get().hydrate()
      throw error
    }
  },

  merge: async (incomingPreview) => {
    const notebook = parseFieldNotebook(incomingPreview.notebook)
    const now = new Date().toISOString()

    // 重新读取目录并校验，避免预览之后洞段/桩号被改动；事务随后保证整本原子提交。
    const catalog = await currentCatalog()
    const preview = createPreviewFromNotebook(notebook, catalog)

    const incomingStations = preview.items.map((item) => {
      const candidate = buildFieldStation(notebook, item, now)
      const existing = catalog.stations.find((station) => station.id === candidate.id)
      // 同一本手记重复合并是幂等操作：已被内业复核的外业版本不能被重试覆盖回待复核。
      return existing?.source === 'field' && existing.reviewState === 'reviewed' ? existing : candidate
    })
    const affectedSegmentIds = new Set(preview.items.map((item) => item.segmentId))
    const nextSketches = recalculateSketchLayouts(
      catalog.segments,
      [...catalog.stations, ...incomingStations],
      catalog.sketches,
      affectedSegmentIds,
      new Set(incomingStations.map((station) => station.id))
    )

    const batch: NotebookBatch = {
      notebookId: notebook.notebookId,
      caveName: notebook.caveName,
      team: notebook.team ?? '',
      recordedAt: notebook.recordedAt,
      status: 'success',
      mergedAt: now,
      importedCount: preview.items.length,
      conflictCount: preview.conflictCount,
      createdCount: preview.createdCount
    }

    const transactionPromise = db.transaction('rw', db.stations, db.sketches, db.notebooks, async () => {
      await db.stations.bulkPut(incomingStations)
      const changedSketchIds = new Set(
        nextSketches
          .filter((sketch) => {
            const old = catalog.sketches.find((item) => item.id === sketch.id)
            return old && (old.mergeOffset !== sketch.mergeOffset || old.anchorStake !== sketch.anchorStake)
          })
          .map((sketch) => sketch.id)
      )
      await db.sketches.bulkPut(nextSketches.filter((sketch) => changedSketchIds.has(sketch.id)))
      await db.notebooks.put(batch)
    })

    // 事务 reject 后再另写失败批次，保证业务表回滚和失败记录持久化互不嵌套。
    await transactionPromise.catch(async (error: unknown) => {
      const failedBatch: NotebookBatch = {
        ...batch,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        rawNotebook: notebook
      }
      await db.notebooks.put(failedBatch)
      await get().hydrate()
      throw error
    })

    await get().hydrate()
    return batch
  },

  retry: async (notebookId) => {
    const record = await db.notebooks.get(notebookId)
    if (!record) throw new Error('没有可重试的失败手记')
    if (record.rawNotebook) {
      return get().merge({
        notebook: record.rawNotebook,
        items: [],
        createdCount: record.createdCount,
        conflictCount: record.conflictCount
      })
    }
    if (record.rawInput) {
      const parsed = JSON.parse(record.rawInput) as unknown
      const preview = await get().preview(parsed)
      return get().merge(preview)
    }
    throw new Error('失败手记缺少可重试原文')
  },

  remove: async (notebookId) => {
    await db.notebooks.delete(notebookId)
    await get().hydrate()
  }
}))
