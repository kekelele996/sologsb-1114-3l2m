<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Station, StationVersion } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { computeHorizontal, computeVertical, formatDms, isValidBearing, isValidDip } from '@/utils/survey'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
const editingId = ref<string | null>(null)
const lastSaved = ref<string>('')

const versionsVisible = ref(false)
const viewingStation = ref<Station | null>(null)
const reviewer = ref('')

const form = reactive({
  code: 'P1',
  bearing: 90,
  dip: 0,
  slopeDistance: 10,
  instrumentNo: 'SOKKIA-2',
  surveyor: '',
  date: new Date().toISOString().slice(0, 10),
  isClosurePoint: false,
  note: ''
})

const cavesWithSegments = computed(() => caveState.caves)
const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))

const segmentStations = computed(() =>
  stationState.stations
    .filter((station) => station.segmentId === selectedSegmentId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 已保存测点 + 当前待录入测点一起参与闭合差计算，实时反映累计闭合差 */
const pendingStation = computed<Station>(() => ({
  id: 'pending',
  segmentId: selectedSegmentId.value,
  code: form.code,
  bearing: form.bearing,
  dip: form.dip,
  slopeDistance: form.slopeDistance,
  horizontalDistance: previewHorizontal.value,
  verticalDistance: previewVertical.value,
  instrumentNo: form.instrumentNo,
  surveyor: form.surveyor,
  date: form.date,
  isClosurePoint: form.isClosurePoint,
  note: form.note
}))

const closureInput = computed<Station[]>(() => [...segmentStations.value, pendingStation.value])
const { result: closureResult, over: closureOver } = useClosureCheck(closureInput)

const previewHorizontal = computed(() => computeHorizontal(form.dip, form.slopeDistance))
const previewVertical = computed(() => computeVertical(form.dip, form.slopeDistance))

/** 异常读数：方位角或倾角超范围、斜距非正、水平距大于斜距 */
function isAbnormal(station: Station): boolean {
  if (!isValidBearing(station.bearing)) return true
  if (!isValidDip(station.dip)) return true
  if (!(station.slopeDistance > 0)) return true
  return station.horizontalDistance > Math.abs(station.slopeDistance) + 0.001
}

function rowClassName(param: { row: Station }): string {
  return isAbnormal(param.row) ? 'abnormal-row' : ''
}

function refreshDefaultCode(): void {
  form.code = nextCode('P', segmentStations.value.map((station) => station.code))
}

// IndexedDB 数据是异步水合的，洞穴/洞段到达后自动选中第一条，避免空选
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list.length > 0 ? list[0].id : ''
    }
  },
  { immediate: true }
)

watch(
  () => selectedSegmentId.value,
  () => {
    editingId.value = null
    refreshDefaultCode()
  },
  { immediate: true }
)

async function submit(continueNext: boolean): Promise<void> {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写测点桩号')
    return
  }
  if (!(form.slopeDistance > 0)) {
    ElMessage.warning('斜距必须大于 0')
    return
  }
  if (!isValidBearing(form.bearing)) {
    ElMessage.warning('前视方位角必须在 0°–360° 之间')
    return
  }
  if (!isValidDip(form.dip)) {
    ElMessage.warning('倾角必须在 -90°–90° 之间')
    return
  }
  const existing = stationState.stations.find((station) => station.id === editingId.value)
  const station: Station = {
    id: existing?.id ?? uid('st'),
    segmentId: selectedSegmentId.value,
    code: form.code.trim(),
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note.trim()
  }
  await stationStore.getState().save(station)
  lastSaved.value = `${station.code} · 水平距 ${station.horizontalDistance} m / 垂距 ${station.verticalDistance} m`
  ElMessage.success(existing ? `测点 ${station.code} 已更新` : `测点 ${station.code} 已录入`)
  editingId.value = null
  form.isClosurePoint = false
  form.note = ''
  if (continueNext) {
    await stationStore.getState().hydrate()
    form.code = nextCode('P', segmentStations.value.map((item) => item.code))
  }
}

function editStation(station: Station): void {
  editingId.value = station.id
  form.code = station.code
  form.bearing = station.bearing
  form.dip = station.dip
  form.slopeDistance = station.slopeDistance
  form.instrumentNo = station.instrumentNo
  form.surveyor = station.surveyor
  form.date = station.date
  form.isClosurePoint = station.isClosurePoint
  form.note = station.note
}

/** 某测点的全部读数版本（外业手记版 / 内业复核版），按时间倒序 */
function versionsOf(stationId: string): StationVersion[] {
  return stationState.versions
    .filter((version) => version.stationId === stationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function openVersions(station: Station): void {
  viewingStation.value = station
  const reviewed = versionsOf(station.id).find((version) => version.reviewedBy)
  reviewer.value = reviewed?.reviewedBy ?? ''
  versionsVisible.value = true
}

/** 复核某一版读数：复核人写入后该版成为正式成果 */
async function reviewVersion(version: StationVersion): Promise<void> {
  if (!reviewer.value.trim()) {
    ElMessage.warning('请填写复核人')
    return
  }
  await stationStore.getState().reviewVersion(version.id, reviewer.value)
  ElMessage.success(`已由 ${reviewer.value.trim()} 复核，该版读数进入正式成果`)
}

async function removeStation(station: Station): Promise<void> {
  await ElMessageBox.confirm(`确认删除测点「${station.code}」？`, '删除确认', { type: 'warning' })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点与读数录入</h2>
        <p class="page-sub">
          录入前视方位角、倾角与斜距，系统自动推算水平距与垂距，并实时累计该洞段的导线闭合差；异常读数整行高亮。
        </p>
      </div>
      <el-tag v-if="lastSaved" type="success" effect="plain">最近保存：{{ lastSaved }}</el-tag>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in cavesWithSegments" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 220px">
        <el-option
          v-for="segment in segmentOptions"
          :key="segment.id"
          :label="`${segment.code}（${segment.startStake} → ${segment.endStake}）`"
          :value="segment.id"
        />
      </el-select>
      <SegmentTag v-if="currentSegment" :type="currentSegment.type" :closed="currentSegment.closed" size="small" />
      <el-button :disabled="!selectedSegmentId" @click="refreshDefaultCode">重算下一桩号</el-button>
    </div>

    <el-card shadow="never" class="form-card">
      <el-form label-width="96px">
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="测点桩号" required>
              <el-input v-model="form.code" placeholder="如 P12" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="前视方位角">
              <BearingInput v-model="form.bearing" kind="bearing" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="倾角">
              <BearingInput v-model="form.dip" kind="dip" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="斜距(m)" required>
              <el-input-number v-model="form.slopeDistance" :min="0" :step="0.1" :precision="3" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="仪器号">
              <el-input v-model="form.instrumentNo" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量人">
              <el-input v-model="form.surveyor" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="闭合点">
              <el-switch v-model="form.isClosurePoint" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="岩壁、滴水、崩塌堆积等现场情况" />
        </el-form-item>
        <div class="preview">
          <el-tag effect="plain">自动推算：水平距 {{ previewHorizontal.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">垂距 {{ previewVertical.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">方位角 {{ formatDms(form.bearing) }}</el-tag>
          <el-tag effect="plain">倾角 {{ formatDms(form.dip) }}</el-tag>
        </div>
        <div class="actions">
          <el-button type="primary" @click="submit(false)">{{ editingId ? '保存修改' : '保存测点' }}</el-button>
          <el-button type="success" plain @click="submit(true)">保存并录入下一站</el-button>
          <el-button v-if="editingId" @click="editingId = null">取消编辑</el-button>
        </div>
      </el-form>
    </el-card>

    <ClosureBadge
      class="closure"
      :closure="closureResult.closure"
      :threshold="closureResult.threshold"
      :level="closureResult.level"
      :detail="closureResult.detail"
      :count="segmentStations.length"
    />
    <el-alert
      v-if="closureOver"
      class="alert"
      type="error"
      :closable="false"
      title="闭合差已超限"
      description="当前洞段累计闭合差超过阈值，建议复测异常测点或对读数做误差分配。"
    />

    <h3 class="section-title">本洞段读数（{{ segmentStations.length }} 站）</h3>
    <el-table :data="segmentStations" border stripe :row-class-name="rowClassName">
      <el-table-column prop="code" label="桩号" width="90" />
      <el-table-column label="推算桩号" width="110">
        <template #default="{ row }: { row: Station }">
          <span v-if="row.stake" class="mono">{{ row.stake }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="方位角" width="150">
        <template #default="{ row }: { row: Station }">{{ row.bearing }}° / {{ formatDms(row.bearing) }}</template>
      </el-table-column>
      <el-table-column label="倾角" width="140">
        <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
      </el-table-column>
      <el-table-column prop="slopeDistance" label="斜距(m)" width="100" />
      <el-table-column prop="horizontalDistance" label="水平距(m)" width="110" />
      <el-table-column prop="verticalDistance" label="垂距(m)" width="100" />
      <el-table-column prop="instrumentNo" label="仪器号" width="110" />
      <el-table-column prop="surveyor" label="测量人" width="90" />
      <el-table-column prop="date" label="日期" width="120" />
      <el-table-column label="闭合点" width="90">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="row.isClosurePoint" type="success" size="small" effect="plain">是</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="读数状态" width="110">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="isAbnormal(row)" type="danger" size="small" effect="dark">异常</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="读数版本" width="110">
        <template #default="{ row }: { row: Station }">
          <el-tag
            v-if="versionsOf(row.id).length > 1"
            type="warning"
            size="small"
            effect="dark"
            @click="openVersions(row)"
          >
            多版本 {{ versionsOf(row.id).length }}
          </el-tag>
          <span v-else class="muted">单版本</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }: { row: Station }">
          <el-button link type="primary" size="small" @click="editStation(row)">编辑</el-button>
          <el-button link type="warning" size="small" @click="openVersions(row)">版本</el-button>
          <el-button link type="danger" size="small" @click="removeStation(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="versionsVisible" title="测点读数版本" width="720px" top="6vh">
      <template v-if="viewingStation">
        <div class="version-head">
          <b>{{ viewingStation.code }}</b>
          <span class="muted">两版读数都留下，编目台按谁复核过决定哪版进入正式成果</span>
        </div>
        <div class="reviewer-row">
          <span class="muted">复核人：</span>
          <el-input v-model="reviewer" size="small" placeholder="内业复核人姓名" style="width: 180px" />
          <span class="muted">在下方选择一版读数并填写复核人后，该版即成为正式成果</span>
        </div>
        <div v-for="version in versionsOf(viewingStation.id)" :key="version.id" class="version-card" :class="{ official: version.official }">
          <div class="version-tags">
            <el-tag :type="version.source === 'field' ? 'info' : 'success'" size="small" effect="plain">
              {{ version.source === 'field' ? '外业手记' : '内业复核' }}
            </el-tag>
            <el-tag v-if="version.official" type="success" size="small" effect="dark">正式成果</el-tag>
            <el-tag v-if="version.reviewedBy" type="warning" size="small" effect="plain">
              已复核 · {{ version.reviewedBy }} · {{ version.reviewedAt?.replace('T', ' ').slice(0, 16) }}
            </el-tag>
            <el-tag v-else type="info" size="small" effect="plain">未复核</el-tag>
          </div>
          <el-descriptions :column="3" border size="small" class="version-desc">
            <el-descriptions-item label="方位角">{{ version.bearing }}°</el-descriptions-item>
            <el-descriptions-item label="倾角">{{ version.dip }}°</el-descriptions-item>
            <el-descriptions-item label="斜距">{{ version.slopeDistance }} m</el-descriptions-item>
            <el-descriptions-item label="水平距">{{ version.horizontalDistance }} m</el-descriptions-item>
            <el-descriptions-item label="垂距">{{ version.verticalDistance }} m</el-descriptions-item>
            <el-descriptions-item label="仪器号">{{ version.instrumentNo || '—' }}</el-descriptions-item>
            <el-descriptions-item label="测量人">{{ version.surveyor || '—' }}</el-descriptions-item>
            <el-descriptions-item label="日期">{{ version.date }}</el-descriptions-item>
            <el-descriptions-item label="闭合点">{{ version.isClosurePoint ? '是' : '否' }}</el-descriptions-item>
          </el-descriptions>
          <div class="version-note muted">备注：{{ version.note || '—' }}</div>
          <div class="version-actions">
            <el-button
              v-if="!version.reviewedBy"
              size="small"
              type="warning"
              plain
              @click="reviewVersion(version)"
            >
              复核并采用此版
            </el-button>
            <span v-else class="muted">该版已经复核，作为正式成果使用</span>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0 0 96px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 14px 0 0 96px;
}
.closure {
  margin-bottom: 12px;
}
.alert {
  margin-bottom: 12px;
}
:deep(.abnormal-row) {
  background: #fdf2f2 !important;
}
:deep(.abnormal-row td) {
  color: #b03030;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.version-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.reviewer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
}
.version-card {
  border: 1px solid #e2e9f0;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fafbfd;
}
.version-card.official {
  border-color: #2f6f8f;
  background: #f0f7fb;
}
.version-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.version-desc {
  margin-bottom: 6px;
}
.version-note {
  font-size: 12px;
  margin-bottom: 8px;
}
.version-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
</style>
