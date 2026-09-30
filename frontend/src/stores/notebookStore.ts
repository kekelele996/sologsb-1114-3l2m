import { createStore } from 'zustand/vanilla'
import type { MergeResult, Notebook } from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { mergeNotebook } from '@/utils/notebookMerge'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'

export interface NotebookState {
  notebooks: Notebook[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (notebook: Notebook) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 整本合并进编目台（事务化，失败回滚，可重试） */
  merge: (id: string) => Promise<MergeResult>
}

export const notebookStore = createStore<NotebookState>((set, get) => ({
  notebooks: [],
  loaded: false,
  hydrate: async () => {
    const notebooks = await syncAll<Notebook>(db.notebooks)
    notebooks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ notebooks, loaded: true })
  },
  save: async (notebook) => {
    await db.notebooks.put(notebook)
    await get().hydrate()
  },
  remove: async (id) => {
    await db.notebooks.delete(id)
    await get().hydrate()
  },
  merge: async (id) => {
    const result = await mergeNotebook(id)
    // 合并会新增/更新测点与版本、重算草图锚点与拼合偏移，相关缓存一起刷新
    await Promise.all([
      get().hydrate(),
      stationStore.getState().hydrate(),
      stationStore.getState().hydrateVersions(),
      sketchStore.getState().hydrate()
    ])
    return result
  }
}))
