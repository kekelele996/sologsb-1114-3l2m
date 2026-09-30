import { createStore } from 'zustand/vanilla'
import type { Station, StationVersion } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { pickOfficialVersion } from '@/utils/notebookMerge'

export interface StationState {
  stations: Station[]
  /** 全部测点读数版本（外业手记版 / 内业复核版） */
  versions: StationVersion[]
  loaded: boolean
  hydrate: () => Promise<void>
  hydrateVersions: () => Promise<void>
  save: (station: Station) => Promise<void>
  remove: (id: string) => Promise<void>
  /**
   * 复核某一版读数：记录复核人后该版成为正式成果，
   * 同测点其余版本保留但不再是正式成果。
   */
  reviewVersion: (versionId: string, reviewer: string) => Promise<void>
}

export const stationStore = createStore<StationState>((set, get) => ({
  stations: [],
  versions: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ stations, loaded: true })
  },
  hydrateVersions: async () => {
    const versions = await syncAll<StationVersion>(db.stationVersions)
    set({ versions })
  },
  save: async (station) => {
    await syncPut<Station>(db.stations, station)
    await get().hydrate()
  },
  remove: async (id) => {
    await db.transaction('rw', [db.stations, db.stationVersions], async () => {
      await syncDelete(db.stations, id)
      await db.stationVersions.where('stationId').equals(id).delete()
    })
    await get().hydrate()
    await get().hydrateVersions()
  },
  reviewVersion: async (versionId, reviewer) => {
    const version = get().versions.find((item) => item.id === versionId)
    if (!version || !reviewer.trim()) return
    const now = new Date().toISOString()
    await db.transaction('rw', [db.stations, db.stationVersions], async () => {
      await db.stationVersions.update(versionId, { reviewedBy: reviewer.trim(), reviewedAt: now })
      const versions = await db.stationVersions.where('stationId').equals(version.stationId).toArray()
      const official = pickOfficialVersion(versions)
      await db.stationVersions.where('stationId').equals(version.stationId).modify((item) => {
        item.official = item.id === official?.id
      })
      if (official) {
        const station = await db.stations.get(version.stationId)
        if (station) {
          await syncPut<Station>(db.stations, {
            ...station,
            bearing: official.bearing,
            dip: official.dip,
            slopeDistance: official.slopeDistance,
            horizontalDistance: official.horizontalDistance,
            verticalDistance: official.verticalDistance,
            instrumentNo: official.instrumentNo,
            surveyor: official.surveyor,
            date: official.date,
            isClosurePoint: official.isClosurePoint,
            note: official.note
          })
        }
      }
    })
    await get().hydrateVersions()
    await get().hydrate()
  }
}))
