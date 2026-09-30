import type { Segment, Sketch, Station } from '@/types'
import { stakeToNumber } from '@/utils/survey'

/** 图幅拼合台中 1 米对应的像素数 */
export const MERGE_PX_PER_METER = 1.6

/** 同一逻辑测点的归一化键：忽略大小写与空白 */
export function stationGroupKey(segmentId: string, code: string): string {
  return `${segmentId}::${code.trim().replace(/\s+/g, '').toUpperCase()}`
}

function versionRank(station: Station): number {
  if (station.reviewState === 'reviewed' && station.source === 'office') return 4
  if (station.reviewState === 'reviewed') return 3
  if (station.source === 'office') return 2
  return 1
}

function versionTime(station: Station): number {
  const time = Date.parse(station.reviewedAt ?? station.date)
  return Number.isFinite(time) ? time : 0
}

/**
 * 同一测点存在多版读数时的正式成果选择：
 * 已内业复核优先；同级时内业记录优先；仍相同则保留最近复核时间。
 */
export function pickOfficialStation(stations: Station[]): Station | undefined {
  return [...stations].sort((a, b) => {
    const rankDiff = versionRank(b) - versionRank(a)
    if (rankDiff !== 0) return rankDiff
    const timeDiff = versionTime(b) - versionTime(a)
    if (timeDiff !== 0) return timeDiff
    return a.id.localeCompare(b.id)
  })[0]
}

/** 只保留每个逻辑测点当前进入正式成果的一版，未复核外业读数在无内业版时临时采用 */
export function officialStations(stations: Station[]): Station[] {
  const groups = new Map<string, Station[]>()
  for (const station of stations) {
    const key = stationGroupKey(station.segmentId, station.code)
    const list = groups.get(key) ?? []
    list.push(station)
    groups.set(key, list)
  }
  return Array.from(groups.values())
    .map((group) => pickOfficialStation(group))
    .filter((station): station is Station => Boolean(station))
}

export function isOfficialStation(station: Station, allStations: Station[]): boolean {
  const group = allStations.filter(
    (item) => stationGroupKey(item.segmentId, item.code) === stationGroupKey(station.segmentId, station.code)
  )
  return pickOfficialStation(group)?.id === station.id
}

/** 只按草图当前锚点重算受影响洞段所在洞穴的图幅偏移，不覆盖人工修改的锚点 */
export function recalculateSketchOffsets(
  segments: Segment[],
  sketches: Sketch[],
  affectedSegmentIds: Iterable<string>
): Sketch[] {
  const affected = new Set(affectedSegmentIds)
  const affectedCaveIds = new Set(
    segments.filter((segment) => affected.has(segment.id)).map((segment) => segment.caveId)
  )
  const next = sketches.map((sketch) => ({ ...sketch }))

  for (const caveId of affectedCaveIds) {
    const caveSegmentIds = new Set(
      segments.filter((segment) => segment.caveId === caveId).map((segment) => segment.id)
    )
    const caveSketches = next
      .filter((sketch) => caveSegmentIds.has(sketch.segmentId))
      .sort((a, b) => a.mergeOrder - b.mergeOrder || a.code.localeCompare(b.code, 'zh-Hans-CN'))
    if (caveSketches.length === 0) continue

    const base = Math.min(...caveSketches.map((sketch) => stakeToNumber(sketch.anchorStake)))
    for (const sketch of caveSketches) {
      sketch.mergeOffset = Math.round((stakeToNumber(sketch.anchorStake) - base) * MERGE_PX_PER_METER)
      sketch.snapped = true
    }
  }
  return next
}

/** 由洞段、全部正式测点重算受影响洞段所在洞穴的草图锚点和图幅偏移 */
export function recalculateSketchLayouts(
  segments: Segment[],
  stations: Station[],
  sketches: Sketch[],
  affectedSegmentIds: Iterable<string>,
  preferredStationIds: ReadonlySet<string> = new Set()
): Sketch[] {
  const affected = new Set(affectedSegmentIds)
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment]))
  const affectedCaveIds = new Set(
    segments.filter((segment) => affected.has(segment.id)).map((segment) => segment.caveId)
  )

  const next = sketches.map((sketch) => ({ ...sketch }))
  const official = officialStations(stations)

  // 新落测点后，先把受影响草图的锚点贴到距原锚点最近的正式测点桩号。
  for (const sketch of next) {
    const segment = segmentMap.get(sketch.segmentId)
    if (!segment || !affectedCaveIds.has(segment.caveId) || !affected.has(sketch.segmentId)) continue
    const candidates = official
      .filter((station) => station.segmentId === sketch.segmentId)
      .map((station) => ({
        station,
        distance: Math.abs(stakeToNumber(station.stake) - stakeToNumber(sketch.anchorStake))
      }))
      .sort((a, b) => {
        const preferredDiff =
          Number(preferredStationIds.has(b.station.id)) - Number(preferredStationIds.has(a.station.id))
        if (preferredDiff !== 0) return preferredDiff
        return a.distance - b.distance
      })
    if (candidates[0]) {
      sketch.anchorStake = candidates[0].station.stake
    }
  }

  return recalculateSketchOffsets(segments, next, segments.map((segment) => segment.id))
}
