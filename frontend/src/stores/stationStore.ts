import { createStore } from 'zustand/vanilla'
import type { Segment, Sketch, Station } from '@/types'
import { db, syncAll, syncDelete } from '@/hooks/usePersistentStore'
import { recalculateSketchLayouts } from '@/utils/stationVersion'

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  review: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

async function persistStationsAndLayouts(
  nextStations: Station[],
  affectedSegmentIds: Iterable<string>,
  preferredStationIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const [segments, sketches] = await Promise.all([db.segments.toArray() as Promise<Segment[]>, db.sketches.toArray()])
  const nextSketches = recalculateSketchLayouts(
    segments,
    nextStations,
    sketches,
    affectedSegmentIds,
    preferredStationIds
  )

  await db.transaction('rw', db.stations, db.sketches, async () => {
    await db.stations.bulkPut(nextStations)
    const changed = nextSketches.filter((sketch) => {
      const old = sketches.find((item) => item.id === sketch.id)
      return (
        old &&
        (old.mergeOffset !== sketch.mergeOffset ||
          old.anchorStake !== sketch.anchorStake ||
          old.snapped !== sketch.snapped)
      )
    })
    if (changed.length > 0) await db.sketches.bulkPut(changed)
  })
}

export const stationStore = createStore<StationState>((set, get) => ({
  stations: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ stations, loaded: true })
  },

  save: async (station) => {
    const current = get().stations
    const previous = current.find((item) => item.id === station.id)
    const next = [...current.filter((item) => item.id !== station.id), station]
    await persistStationsAndLayouts(
      next,
      previous && previous.segmentId !== station.segmentId
        ? [previous.segmentId, station.segmentId]
        : [station.segmentId],
      new Set([station.id])
    )
    await get().hydrate()
  },

  review: async (id) => {
    const target = get().stations.find((station) => station.id === id)
    if (!target) return
    const now = new Date().toISOString()
    const reviewed: Station = {
      ...target,
      reviewState: 'reviewed',
      reviewedAt: now
    }
    await persistStationsAndLayouts(
      get().stations.map((station) => (station.id === id ? reviewed : station)),
      [reviewed.segmentId],
      new Set([reviewed.id])
    )
    await get().hydrate()
  },

  remove: async (id) => {
    const target = get().stations.find((station) => station.id === id)
    await syncDelete(db.stations, id)
    if (target) {
      const remaining = get().stations.filter((station) => station.id !== id)
      const segments = await db.segments.toArray()
      const sketches = await db.sketches.toArray()
      const nextSketches = recalculateSketchLayouts(segments, remaining, sketches, [target.segmentId])
      const changed: Sketch[] = nextSketches.filter((sketch) => {
        const old = sketches.find((item) => item.id === sketch.id)
        return old && (old.mergeOffset !== sketch.mergeOffset || old.anchorStake !== sketch.anchorStake)
      })
      if (changed.length > 0) await db.sketches.bulkPut(changed)
    }
    await get().hydrate()
  }
}))
