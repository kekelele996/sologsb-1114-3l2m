/** 读数来源：外业手记或内业复核 */
export type StationSource = 'field' | 'office'

/** 复核状态 */
export type StationReviewState = 'unreviewed' | 'reviewed'

/** Station 测点：由方位角与斜距自动推算水平距与垂距；同一逻辑测点可保留多版读数 */
export interface Station {
  id: string
  segmentId: string
  /** 测点桩号，如 P12，也是外业/内业版本的合并键 */
  code: string
  /** 测点所在桩号，必须落在所属洞段区间内 */
  stake: string
  /** 前视方位角（十进制度，0-360） */
  bearing: number
  /** 倾角（十进制度，-90 ~ 90） */
  dip: number
  /** 斜距（米） */
  slopeDistance: number
  /** 水平距（米），由斜距与倾角推算 */
  horizontalDistance: number
  /** 垂距（米），由斜距与倾角推算 */
  verticalDistance: number
  /** 仪器号 */
  instrumentNo: string
  /** 测量人 */
  surveyor: string
  /** 测量日期 */
  date: string
  /** 是否闭合点 */
  isClosurePoint: boolean
  /** 读数来源 */
  source: StationSource
  /** 是否已由内业复核 */
  reviewState: StationReviewState
  /** 外业手记编号 */
  notebookId?: string
  /** 最近一次复核/写入时间 ISO 字符串 */
  reviewedAt?: string
  note: string
}

export interface ClosureResult {
  /** 闭合差（米） */
  closure: number
  /** 阈值（米） */
  threshold: number
  /** 是否超限 */
  over: boolean
  level: '优' | '良' | '超限'
  /** 参与计算的测点数 */
  count: number
  /** 累计水平位移（东向 / 北向） */
  east: number
  north: number
  /** 计算过程说明 */
  detail: string
}
