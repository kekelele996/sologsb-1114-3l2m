/** 外业手记：外业分队在洞里离线记录的一整批读数，回驻地后整本合并进编目台 */
export interface Notebook {
  id: string
  /** 手记编号，如 NB-2026-003 */
  code: string
  caveId: string
  /** 外业测量人 */
  surveyor: string
  /** 外业测量日期 */
  fieldDate: string
  /** 手记内的原始读数（离线状态，合并时逐行对上洞段与桩号） */
  readings: NotebookReading[]
  /** 合并状态：draft 未合并 / merged 已合并 / failed 合并失败待重试 */
  status: 'draft' | 'merged' | 'failed'
  /** 合并批次号（幂等键：同一批次只生效一次） */
  mergeBatch?: string
  mergedAt?: string
  /** 最近一次合并的摘要（跨会话可查） */
  mergeSummary?: {
    created: number
    updated: number
    conflicts: number
    stakeChecks: number
    recalculatedSketches: number
  }
  /** 最近一次失败原因（事务回滚后记录，便于退回重试） */
  failReason?: string
  note: string
  createdAt: string
}

/** 外业手记中的一行读数 */
export interface NotebookReading {
  /** 行内临时 id（仅用于编辑时增删行，落库时可不带） */
  localId?: string
  segmentId: string
  /** 测点桩号，如 P12 */
  code: string
  /** 前视方位角（十进制度，0-360） */
  bearing: number
  /** 倾角（十进制度，-90 ~ 90） */
  dip: number
  /** 斜距（米） */
  slopeDistance: number
  instrumentNo: string
  surveyor: string
  date: string
  isClosurePoint: boolean
  note: string
}

/**
 * 测点读数版本。
 * 外业手记合并会为每个测点留下一版 source='field' 的读数；
 * 内业复核后写入 source='internal' 的版本并记录复核人。
 * 同一测点可同时存在多版读数，正式成果取其中一版（official=true）。
 */
export interface StationVersion {
  id: string
  stationId: string
  /** 来源：外业手记 / 内业复核 */
  source: 'field' | 'internal'
  /** 合并批次号（外业手记合并时记录，便于回溯与幂等核对） */
  batchId?: string
  bearing: number
  dip: number
  slopeDistance: number
  horizontalDistance: number
  verticalDistance: number
  instrumentNo: string
  surveyor: string
  date: string
  isClosurePoint: boolean
  note: string
  /** 复核人：内业复核过的版本才有资格成为正式成果 */
  reviewedBy?: string
  reviewedAt?: string
  /** 是否为当前正式成果版本 */
  official: boolean
  createdAt: string
}

/** 手记合并结果（合并完成后向编目台汇报） */
export interface MergeResult {
  notebookId: string
  notebookCode: string
  batchId: string
  /** 新增测点数 */
  created: number
  /** 更新测点数（含同测点双版本留存） */
  updated: number
  /** 两版读数都留下的冲突清单（外业读数与内业已复核记录撞在同一测点） */
  conflicts: { stationCode: string; segmentCode: string; reason: string }[]
  /** 新落测点桩号区间校验结果 */
  stakeChecks: { stationCode: string; segmentCode: string; stake: string; inRange: boolean }[]
  /** 重算锚点的草图编号 */
  recalculatedSketches: string[]
  /** 幂等命中：该手记已合并过，本次未重复写入 */
  alreadyMerged?: boolean
}
