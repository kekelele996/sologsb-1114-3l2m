import type {
  FieldNotebook,
  FieldNotebookReading,
  NotebookMergePreview,
  Segment,
  Station
} from '@/types'
import { computeHorizontal, computeVertical, isValidBearing, isValidDip, stakeToNumber } from '@/utils/survey'
import { pickOfficialStation, stationGroupKey } from '@/utils/stationVersion'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), '手记必须是 JSON 对象')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  assert(typeof value === 'string' && value.trim(), `缺少或无效字段：${field}`)
  return value.trim()
}

function number(value: unknown, field: string): number {
  assert(typeof value === 'number' && Number.isFinite(value), `缺少或无效数字：${field}`)
  return value
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** 解析并校验外业手记 JSON；任何一条不合格都拒绝整本，保证失败可整体重试 */
export function parseFieldNotebook(input: unknown): FieldNotebook {
  const root = asRecord(input)
  const notebookId = text(root.notebookId, 'notebookId')
  const caveName = text(root.caveName, 'caveName')
  const recordedAt = text(root.recordedAt, 'recordedAt')
  assert(Array.isArray(root.readings) && root.readings.length > 0, 'readings 必须是非空数组')

  const readings = root.readings.map((item, index) => {
    const row = asRecord(item)
    const label = `第 ${index + 1} 条读数`
    const reading: FieldNotebookReading = {
      segmentCode: text(row.segmentCode, `${label}.segmentCode`),
      code: text(row.code, `${label}.code`),
      stake: text(row.stake, `${label}.stake`),
      bearing: number(row.bearing, `${label}.bearing`),
      dip: number(row.dip, `${label}.dip`),
      slopeDistance: number(row.slopeDistance, `${label}.slopeDistance`),
      instrumentNo: optionalText(row.instrumentNo),
      surveyor: optionalText(row.surveyor),
      date: optionalDate(row.date, recordedAt.slice(0, 10)),
      isClosurePoint: row.isClosurePoint === true,
      note: optionalText(row.note)
    }
    assert(isValidBearing(reading.bearing), `${label} 方位角必须在 0°–360° 之间`)
    assert(isValidDip(reading.dip), `${label} 倾角必须在 -90°–90° 之间`)
    assert(reading.slopeDistance > 0, `${label} 斜距必须大于 0`)
    return reading
  })

  const duplicateKeys = new Set<string>()
  const seen = new Set<string>()
  for (const reading of readings) {
    const key = `${reading.segmentCode}::${reading.code}`
    if (seen.has(key)) duplicateKeys.add(key)
    seen.add(key)
  }
  assert(duplicateKeys.size === 0, `手记内存在重复测点：${Array.from(duplicateKeys).join('、')}`)

  return {
    notebookId,
    caveName,
    team: optionalText(root.team),
    recordedAt,
    readings
  }
}

/** 生成合并预览，同时把洞段编号解析成正式洞段 ID，并校验新落测点桩号区间 */
export function buildMergePreview(
  notebook: FieldNotebook,
  caves: { id: string; name: string }[],
  segments: Segment[],
  stations: Station[]
): NotebookMergePreview {
  const cave = caves.find((item) => item.name === notebook.caveName)
  assert(cave, `找不到洞穴「${notebook.caveName}」`)
  const caveSegments = segments.filter((segment) => segment.caveId === cave.id)

  const items = notebook.readings.map((reading) => {
    const segment = caveSegments.find((item) => item.code === reading.segmentCode)
    assert(segment, `洞段「${reading.segmentCode}」不属于洞穴「${notebook.caveName}」或不存在`)
    const start = stakeToNumber(segment.startStake)
    const end = stakeToNumber(segment.endStake)
    const stake = stakeToNumber(reading.stake)
    assert(
      stake >= Math.min(start, end) && stake <= Math.max(start, end),
      `${reading.segmentCode} / ${reading.code} 的桩号 ${reading.stake} 不在洞段区间 ${segment.startStake}–${segment.endStake}`
    )

    const group = stations.filter(
      (station) => stationGroupKey(station.segmentId, station.code) === stationGroupKey(segment.id, reading.code)
    )
    const current = pickOfficialStation(group)

    return {
      reading,
      segmentId: segment.id,
      action: group.length > 0 ? ('conflict' as const) : ('created' as const),
      current
    }
  })

  const conflictCount = items.filter((item) => item.action === 'conflict').length
  return {
    notebook,
    items,
    conflictCount,
    createdCount: items.length - conflictCount
  }
}

export function stableHash(textValue: string): string {
  let hash = 5381
  for (let index = 0; index < textValue.length; index += 1) {
    hash = (hash * 33) ^ textValue.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

/** 外业版本 ID 对「手记 + 洞段 + 测点」稳定；同一本重试只会覆盖同一行，不会堆重复 */
export function fieldStationId(notebookId: string, segmentId: string, code: string): string {
  return `st_field_${stableHash([notebookId, segmentId, stationGroupKey(segmentId, code)].join('|'))}`
}

export function buildFieldStation(
  notebook: FieldNotebook,
  item: NotebookMergePreview['items'][number],
  nowIso: string
): Station {
  const { reading } = item
  return {
    id: fieldStationId(notebook.notebookId, item.segmentId, reading.code),
    segmentId: item.segmentId,
    code: reading.code.trim(),
    stake: reading.stake.trim(),
    bearing: reading.bearing,
    dip: reading.dip,
    slopeDistance: reading.slopeDistance,
    horizontalDistance: computeHorizontal(reading.dip, reading.slopeDistance),
    verticalDistance: computeVertical(reading.dip, reading.slopeDistance),
    instrumentNo: reading.instrumentNo ?? '',
    surveyor: reading.surveyor ?? notebook.team ?? '',
    date: reading.date ?? notebook.recordedAt.slice(0, 10),
    isClosurePoint: reading.isClosurePoint === true,
    source: 'field',
    reviewState: 'unreviewed',
    notebookId: notebook.notebookId,
    reviewedAt: nowIso,
    note: reading.note ?? ''
  }
}
