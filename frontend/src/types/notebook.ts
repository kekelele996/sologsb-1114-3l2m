/** 外业手记文件头 */
import type { Station } from './station'

export interface FieldNotebook {
  /** 手记编号，重试时作为幂等键 */
  notebookId: string
  caveName: string
  team?: string
  recordedAt: string
  readings: FieldNotebookReading[]
}

/** 外业手记中的一条读数 */
export interface FieldNotebookReading {
  /** 所属洞段编号，如 C-01 */
  segmentCode: string
  /** 测点桩号，如 P12，与正式测点合并时使用 */
  code: string
  /** 测点所在里程桩号，如 K0+018 */
  stake: string
  bearing: number
  dip: number
  slopeDistance: number
  instrumentNo?: string
  surveyor?: string
  date?: string
  isClosurePoint?: boolean
  note?: string
}

export type NotebookMergeStatus = 'success' | 'failed'

/** 已接收整本手记的合并记录；失败时保留原文，允许退回后重试 */
export interface NotebookBatch {
  notebookId: string
  caveName: string
  team: string
  recordedAt: string
  status: NotebookMergeStatus
  /** 成功或最近一次尝试时间 */
  mergedAt: string
  error?: string
  /** 失败时保存原始手记，修正数据后可原文重试 */
  rawNotebook?: FieldNotebook
  /** JSON 结构无法解析时保存原文 */
  rawInput?: string
  importedCount: number
  conflictCount: number
  createdCount: number
}

export interface NotebookMergePreviewItem {
  reading: FieldNotebookReading
  segmentId: string
  action: 'created' | 'conflict'
  current?: Station
}

export interface NotebookMergePreview {
  notebook: FieldNotebook
  items: NotebookMergePreviewItem[]
  createdCount: number
  conflictCount: number
}
