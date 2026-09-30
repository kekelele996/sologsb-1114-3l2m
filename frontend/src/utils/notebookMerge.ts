import { db } from '@/hooks/usePersistentStore'
import type { MergeResult, NotebookReading, Sketch, Station, StationVersion } from '@/types'
import {
  computeHorizontal,
  computeVertical,
  isValidBearing,
  isValidDip,
  numberToStake,
  stakeToNumber
} from '@/utils/survey'
import { uid } from '@/utils/id'

/** 图幅拼合：每米桩号差换算的横向像素（与 MergePage 的 PX_PER_METER 保持一致） */
const PX_PER_METER = 1.6

/** 从测点桩号文本中取数字序号，如 P12 -> 12 */
function stationOrder(code: string): number {
  const match = /(\d+)/.exec(code)
  return match ? Number(match[1]) : 0
}

/**
 * 按谁复核过决定哪版进入正式成果：
 * 内业复核版本优先（复核时间取最新）；两版都没复核时取最新一版读数。
 */
export function pickOfficialVersion(versions: StationVersion[]): StationVersion | undefined {
  if (versions.length === 0) return undefined
  const reviewed = versions.filter((version) => version.reviewedBy)
  const pool = reviewed.length > 0 ? reviewed : versions
  return [...pool].sort((a, b) => {
    const ta = a.reviewedAt ?? a.createdAt
    const tb = b.reviewedAt ?? b.createdAt
    return tb.localeCompare(ta)
  })[0]
}

/**
 * 把一整本外业手记合并进编目台。
 *
 * - 整本在一个 IndexedDB 事务内完成：任何一步失败则整体回滚，手记退回 failed 可重试；
 * - 幂等：同一本手记重复合并不会堆出重复测点（已合并直接返回，未合并按 洞段+桩号 对齐）；
 * - 外业读数与内业已复核记录撞上同一测点时两版都留存，复核过的版本进入正式成果；
 * - 新落测点按累计水平距推算桩号，必须落在所属洞段桩号区间内，否则整本回滚；
 * - 合并后重算草图锚点与图幅拼合偏移。
 */
export async function mergeNotebook(notebookId: string): Promise<MergeResult> {
  const notebook = await db.notebooks.get(notebookId)
  if (!notebook) throw new Error('手记不存在或已被删除')

  // 幂等命中：已合并过的手记直接返回上次结果，不重复写入
  if (notebook.status === 'merged' && notebook.mergeBatch) {
    return {
      notebookId: notebook.id,
      notebookCode: notebook.code,
      batchId: notebook.mergeBatch,
      created: 0,
      updated: 0,
      conflicts: [],
      stakeChecks: [],
      recalculatedSketches: [],
      alreadyMerged: true
    }
  }

  try {
    const result = await db.transaction(
      'rw',
      [db.notebooks, db.caves, db.segments, db.stations, db.stationVersions, db.sketches],
      async () => {
        const cave = await db.caves.get(notebook.caveId)
        if (!cave) throw new Error('手记归属洞穴不存在，无法合并')

        const segments = await db.segments.where('caveId').equals(cave.id).toArray()
        const segmentMap = new Map(segments.map((seg) => [seg.id, seg]))
        const sketches =
          segments.length > 0
            ? await db.sketches.where('segmentId').anyOf(segments.map((seg) => seg.id)).toArray()
            : []

        // ---------- 合并前校验：整本手记有问题则不进任何写入 ----------
        const readings: NotebookReading[] = notebook.readings
        if (readings.length === 0) throw new Error('手记没有任何读数，无法合并')
        const seenKeys = new Set<string>()
        for (const reading of readings) {
          const seg = segmentMap.get(reading.segmentId)
          if (!seg) throw new Error(`读数 ${reading.code.trim() || '（未填桩号）'} 不属于本洞穴已登记洞段`)
          if (!reading.code.trim()) throw new Error(`洞段 ${seg.code} 下存在未填桩号的读数`)
          if (!isValidBearing(reading.bearing)) throw new Error(`读数 ${reading.code.trim()} 方位角必须在 0°–360° 之间`)
          if (!isValidDip(reading.dip)) throw new Error(`读数 ${reading.code.trim()} 倾角必须在 -90°–90° 之间`)
          if (!(reading.slopeDistance > 0)) throw new Error(`读数 ${reading.code.trim()} 斜距必须大于 0`)
          const key = `${reading.segmentId}|${reading.code.trim()}`
          if (seenKeys.has(key)) throw new Error(`手记中存在重复读数 ${seg.code} · ${reading.code.trim()}`)
          seenKeys.add(key)
        }

        const batchId = uid('batch')
        const now = new Date().toISOString()
        const mergeResult: MergeResult = {
          notebookId: notebook.id,
          notebookCode: notebook.code,
          batchId,
          created: 0,
          updated: 0,
          conflicts: [],
          stakeChecks: [],
          recalculatedSketches: []
        }

        // ---------- 索引现有测点与版本 ----------
        const existingStations =
          segments.length > 0
            ? await db.stations
                .where('segmentId')
                .anyOf(segments.map((seg) => seg.id))
                .toArray()
            : []
        const stationByKey = new Map<string, Station>()
        for (const station of existingStations) {
          stationByKey.set(`${station.segmentId}|${station.code}`, station)
        }
        const existingVersions =
          existingStations.length > 0
            ? await db.stationVersions
                .where('stationId')
                .anyOf(existingStations.map((station) => station.id))
                .toArray()
            : []
        const versionsByStation = new Map<string, StationVersion[]>()
        for (const version of existingVersions) {
          const list = versionsByStation.get(version.stationId) ?? []
          list.push(version)
          versionsByStation.set(version.stationId, list)
        }

        const newStations: Station[] = []
        const newVersions: StationVersion[] = []
        const affectedSegmentIds = new Set<string>()
        const readingByKey = new Map<string, NotebookReading>()
        const touchedKeys: string[] = []

        for (const reading of readings) {
          const code = reading.code.trim()
          const key = `${reading.segmentId}|${code}`
          readingByKey.set(key, reading)
          touchedKeys.push(key)
          affectedSegmentIds.add(reading.segmentId)
          const horizontalDistance = computeHorizontal(reading.dip, reading.slopeDistance)
          const verticalDistance = computeVertical(reading.dip, reading.slopeDistance)
          let station = stationByKey.get(key)
          const fieldVersion: StationVersion = {
            id: uid('ver'),
            stationId: station?.id ?? uid('st'),
            source: 'field',
            batchId,
            bearing: reading.bearing,
            dip: reading.dip,
            slopeDistance: reading.slopeDistance,
            horizontalDistance,
            verticalDistance,
            instrumentNo: reading.instrumentNo,
            surveyor: reading.surveyor.trim() || notebook.surveyor,
            date: reading.date || notebook.fieldDate,
            isClosurePoint: reading.isClosurePoint,
            note: reading.note.trim(),
            official: false,
            createdAt: now
          }
          if (station) {
            const seg = segmentMap.get(station.segmentId)!
            const reviewed = (versionsByStation.get(station.id) ?? []).some((version) => version.reviewedBy)
            if (reviewed) {
              mergeResult.conflicts.push({
                stationCode: station.code,
                segmentCode: seg.code,
                reason:
                  '外业读数与内业已复核记录撞在同一测点；两版读数均留存，正式成果仍采用内业复核版本'
              })
            }
            mergeResult.updated += 1
          } else {
            station = {
              id: fieldVersion.stationId,
              segmentId: reading.segmentId,
              code,
              bearing: reading.bearing,
              dip: reading.dip,
              slopeDistance: reading.slopeDistance,
              horizontalDistance,
              verticalDistance,
              instrumentNo: reading.instrumentNo,
              surveyor: fieldVersion.surveyor,
              date: fieldVersion.date,
              isClosurePoint: reading.isClosurePoint,
              note: reading.note.trim()
            }
            newStations.push(station)
            stationByKey.set(key, station)
            mergeResult.created += 1
          }
          newVersions.push(fieldVersion)
        }

        // ---------- 桩号推算与区间校验：新落测点必须对上所属洞段桩号区间 ----------
        const segStationsBySegment = new Map<string, Station[]>()
        for (const segId of affectedSegmentIds) {
          const seg = segmentMap.get(segId)!
          const segStations = [
            ...existingStations.filter((station) => station.segmentId === segId),
            ...newStations.filter((station) => station.segmentId === segId)
          ].sort((a, b) => stationOrder(a.code) - stationOrder(b.code))
          segStationsBySegment.set(segId, segStations)
          const start = stakeToNumber(seg.startStake)
          const end = stakeToNumber(seg.endStake)
          let cum = 0
          for (const station of segStations) {
            const reading = readingByKey.get(`${station.segmentId}|${station.code}`)
            const horizontal = reading
              ? computeHorizontal(reading.dip, reading.slopeDistance)
              : station.horizontalDistance
            cum += horizontal
            const stake = numberToStake(cum + start)
            const inRange = cum + start >= start - 0.001 && cum + start <= end + 0.001
            if (reading) {
              mergeResult.stakeChecks.push({
                stationCode: station.code,
                segmentCode: seg.code,
                stake,
                inRange
              })
              if (!inRange) {
                throw new Error(
                  `新落测点 ${seg.code} · ${station.code} 推算桩号 ${stake} 超出洞段桩号区间 ${seg.startStake} → ${seg.endStake}，请核对读数或洞段起止桩号`
                )
              }
            }
            station.stake = stake
          }
        }

        // ---------- 正式成果定版：复核版本优先，无复核取最新版本 ----------
        const stationsToPut = new Map<string, Station>()
        const versionsToPut = new Map<string, StationVersion>()
        for (const key of touchedKeys) {
          const station = stationByKey.get(key)!
          const oldVersions = versionsByStation.get(station.id) ?? []
          const fieldVersion = newVersions.find((version) => version.stationId === station.id)
          const versions = fieldVersion ? [...oldVersions, fieldVersion] : oldVersions
          const official = pickOfficialVersion(versions)
          for (const version of versions) {
            versionsToPut.set(version.id, { ...version, official: version.id === official?.id })
          }
          if (official) {
            stationsToPut.set(station.id, {
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
        // 受影响洞段内测点的桩号推算结果一并落库（未被手记改动的测点只更新桩号）
        for (const segStations of segStationsBySegment.values()) {
          for (const station of segStations) {
            if (!stationsToPut.has(station.id)) {
              stationsToPut.set(station.id, { ...station })
            }
          }
        }

        // ---------- 重算草图锚点与图幅拼合偏移 ----------
        // 锚点取洞段内首个测点桩号；洞段无测点时退回洞段起始桩号
        const anchorBySegment = new Map<string, string>()
        for (const [segId, segStations] of segStationsBySegment) {
          const seg = segmentMap.get(segId)!
          anchorBySegment.set(segId, segStations[0]?.stake ?? seg.startStake)
        }
        const sketchesToPut: Sketch[] = []
        if (sketches.length > 0) {
          const anchorNumberOf = (sketch: Sketch): number => {
            const anchor =
              anchorBySegment.get(sketch.segmentId) ??
              segmentMap.get(sketch.segmentId)?.startStake ??
              sketch.anchorStake
            return stakeToNumber(anchor)
          }
          const minAnchor = Math.min(...sketches.map(anchorNumberOf))
          for (const sketch of sketches) {
            const anchor =
              anchorBySegment.get(sketch.segmentId) ??
              segmentMap.get(sketch.segmentId)?.startStake ??
              sketch.anchorStake
            const mergeOffset = Math.round((stakeToNumber(anchor) - minAnchor) * PX_PER_METER)
            if (anchor !== sketch.anchorStake || mergeOffset !== (sketch.mergeOffset ?? 0)) {
              sketchesToPut.push({ ...sketch, anchorStake: anchor, mergeOffset })
              mergeResult.recalculatedSketches.push(sketch.code)
            }
          }
        }

        // ---------- 落库（事务内整体提交，失败整体回滚） ----------
        await db.stations.bulkPut([...stationsToPut.values()])
        await db.stationVersions.bulkPut([...versionsToPut.values()])
        await db.sketches.bulkPut(sketchesToPut)
        await db.notebooks.update(notebook.id, {
          status: 'merged',
          mergeBatch: batchId,
          mergedAt: now,
          failReason: '',
          mergeSummary: {
            created: mergeResult.created,
            updated: mergeResult.updated,
            conflicts: mergeResult.conflicts.length,
            stakeChecks: mergeResult.stakeChecks.length,
            recalculatedSketches: mergeResult.recalculatedSketches.length
          }
        })
        return mergeResult
      }
    )
    return result
  } catch (err) {
    // 事务已整体回滚：单独写入失败状态与原因，手记保留，可退回重试
    const reason = err instanceof Error ? err.message : String(err)
    await db.notebooks.update(notebook.id, { status: 'failed', failReason: reason })
    throw err
  }
}
