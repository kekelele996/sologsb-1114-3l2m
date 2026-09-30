import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { recalculateSketchOffsets } from '@/utils/stationVersion'

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  setLayout: (id: string, layout: Pick<Sketch, 'mergeOffset' | 'snapped'>) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    const current = get().sketches
    const segments = await db.segments.toArray()
    const next = recalculateSketchOffsets(segments, [...current.filter((item) => item.id !== sketch.id), sketch], [
      sketch.segmentId
    ])
    await db.sketches.bulkPut(next)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    const all = get().sketches
    const reordered = orderedIds
      .map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? { ...target, mergeOrder: index + 1 } : null
      })
      .filter((item): item is Sketch => Boolean(item))

    // 调序只保存新顺序，保留当前已持久化的锚点与拼合偏移。
    await db.sketches.bulkPut(reordered)
    await get().hydrate()
  },
  setLayout: async (id, layout) => {
    const target = get().sketches.find((item) => item.id === id)
    if (!target) return
    await syncPut<Sketch>(db.sketches, { ...target, ...layout })
    await get().hydrate()
  }
}))
