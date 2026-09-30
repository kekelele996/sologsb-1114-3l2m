<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MergeResult, Notebook, NotebookReading } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { notebookStore } from '@/stores/notebookStore'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const notebookState = useStore(notebookStore)

const filterCaveId = ref('')
const filterStatus = ref('')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const mergingId = ref<string | null>(null)
const resultVisible = ref(false)
const result = ref<MergeResult | null>(null)

const form = reactive({
  code: '',
  caveId: '',
  surveyor: '',
  fieldDate: new Date().toISOString().slice(0, 10),
  note: ''
})
const readings = ref<NotebookReading[]>([])

const filtered = computed(() =>
  notebookState.notebooks.filter((nb) => {
    if (filterCaveId.value && nb.caveId !== filterCaveId.value) return false
    if (filterStatus.value && nb.status !== filterStatus.value) return false
    return true
  })
)

function caveName(caveId: string): string {
  return caveState.caves.find((cave) => cave.id === caveId)?.name ?? '未归属洞穴'
}

function segmentsOf(caveId: string) {
  return segmentState.segments.filter((seg) => seg.caveId === caveId)
}

function statusMeta(status: Notebook['status']): { type: 'success' | 'danger' | 'info'; text: string } {
  if (status === 'merged') return { type: 'success', text: '已合并' }
  if (status === 'failed') return { type: 'danger', text: '合并失败' }
  return { type: 'info', text: '待合并' }
}

function defaultReading(): NotebookReading {
  const seg = segmentsOf(form.caveId)[0]
  const code = seg
    ? nextCode(
        'P',
        stationState.stations.filter((station) => station.segmentId === seg.id).map((station) => station.code)
      )
    : 'P1'
  return {
    localId: uid('row'),
    segmentId: seg?.id ?? '',
    code,
    bearing: 90,
    dip: 0,
    slopeDistance: 10,
    instrumentNo: 'SOKKIA-2',
    surveyor: form.surveyor,
    date: form.fieldDate,
    isClosurePoint: false,
    note: ''
  }
}

function openCreate(): void {
  editingId.value = null
  form.code = `NB-${String(notebookState.notebooks.length + 1).padStart(3, '0')}`
  form.caveId = caveState.caves[0]?.id ?? ''
  form.surveyor = caveState.caves.find((cave) => cave.id === form.caveId)?.surveyor ?? ''
  form.fieldDate = new Date().toISOString().slice(0, 10)
  form.note = ''
  readings.value = [defaultReading()]
  dialogVisible.value = true
}

function openEdit(notebook: Notebook): void {
  editingId.value = notebook.id
  form.code = notebook.code
  form.caveId = notebook.caveId
  form.surveyor = notebook.surveyor
  form.fieldDate = notebook.fieldDate
  form.note = notebook.note
  readings.value = notebook.readings.map((reading) => ({ ...reading, localId: uid('row') }))
  dialogVisible.value = true
}

// 切换洞穴后，不属于该洞穴的读数行改挂到新洞穴的第一个洞段
watch(
  () => form.caveId,
  (caveId) => {
    const ids = new Set(segmentsOf(caveId).map((seg) => seg.id))
    readings.value.forEach((reading) => {
      if (!ids.has(reading.segmentId)) reading.segmentId = segmentsOf(caveId)[0]?.id ?? ''
    })
  }
)

function addRow(): void {
  readings.value.push(defaultReading())
}

function removeRow(localId?: string): void {
  readings.value = readings.value.filter((reading) => reading.localId !== localId)
}

async function saveNotebook(): Promise<void> {
  if (!form.code.trim()) {
    ElMessage.warning('请填写手记编号')
    return
  }
  if (!form.caveId) {
    ElMessage.warning('请选择归属洞穴')
    return
  }
  if (readings.value.length === 0) {
    ElMessage.warning('请至少录入一行读数')
    return
  }
  for (const reading of readings.value) {
    if (!reading.segmentId) {
      ElMessage.warning('读数行缺少洞段，请先建立洞段')
      return
    }
    if (!reading.code.trim()) {
      ElMessage.warning('存在未填桩号的读数行')
      return
    }
    if (!(reading.slopeDistance > 0)) {
      ElMessage.warning(`读数 ${reading.code} 斜距必须大于 0`)
      return
    }
  }
  const existing = notebookState.notebooks.find((nb) => nb.id === editingId.value)
  const notebook: Notebook = {
    id: existing?.id ?? uid('nb'),
    code: form.code.trim(),
    caveId: form.caveId,
    surveyor: form.surveyor.trim(),
    fieldDate: form.fieldDate,
    // 落库读数不带行内临时 id
    readings: readings.value.map((reading) => ({
      segmentId: reading.segmentId,
      code: reading.code.trim(),
      bearing: reading.bearing,
      dip: reading.dip,
      slopeDistance: reading.slopeDistance,
      instrumentNo: reading.instrumentNo,
      surveyor: reading.surveyor,
      date: reading.date,
      isClosurePoint: reading.isClosurePoint,
      note: reading.note.trim()
    })),
    status: existing?.status ?? 'draft',
    mergeBatch: existing?.mergeBatch,
    mergedAt: existing?.mergedAt,
    mergeSummary: existing?.mergeSummary,
    failReason: existing?.failReason,
    note: form.note.trim(),
    createdAt: existing?.createdAt ?? new Date().toISOString()
  }
  await notebookStore.getState().save(notebook)
  dialogVisible.value = false
  ElMessage.success(existing ? '手记已更新' : '手记已建立，可随时合并')
}

async function mergeNotebook(notebook: Notebook): Promise<void> {
  mergingId.value = notebook.id
  try {
    const mergeResult = await notebookStore.getState().merge(notebook.id)
    result.value = mergeResult
    resultVisible.value = true
    if (mergeResult.alreadyMerged) {
      ElMessage.info(`手记 ${notebook.code} 已合并过，未重复写入测点`)
    } else {
      ElMessage.success(`手记 ${notebook.code} 合并完成`)
    }
  } catch (err) {
    ElMessage.error(`合并失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    mergingId.value = null
  }
}

function viewResult(notebook: Notebook): void {
  result.value = {
    notebookId: notebook.id,
    notebookCode: notebook.code,
    batchId: notebook.mergeBatch ?? '',
    created: notebook.mergeSummary?.created ?? 0,
    updated: notebook.mergeSummary?.updated ?? 0,
    conflicts: [],
    stakeChecks: [],
    recalculatedSketches: []
  }
  resultVisible.value = true
}

async function removeNotebook(notebook: Notebook): Promise<void> {
  await ElMessageBox.confirm(`确认删除外业手记「${notebook.code}」？已合并的测点读数不会被删除。`, '删除确认', {
    type: 'warning'
  })
  await notebookStore.getState().remove(notebook.id)
  ElMessage.success('手记已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">外业手记</h2>
        <p class="page-sub">
          外业分队在洞里离线记读数，回驻地后整本合并进编目台：同测点两版读数都留下，按谁复核过决定正式成果；
          合并失败整本回滚，退回重试不堆重复测点；新落测点自动对上洞段桩号区间，草图锚点与拼合偏移一起重算。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建手记
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="filterCaveId" placeholder="全部洞穴" clearable style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="filterStatus" placeholder="全部状态" clearable style="width: 160px">
        <el-option label="待合并" value="draft" />
        <el-option label="已合并" value="merged" />
        <el-option label="合并失败" value="failed" />
      </el-select>
      <el-tag type="info" effect="plain">手记 {{ filtered.length }} 本</el-tag>
    </div>

    <el-table :data="filtered" border stripe>
      <el-table-column prop="code" label="手记编号" width="150" />
      <el-table-column label="归属洞穴" min-width="160">
        <template #default="{ row }: { row: Notebook }">{{ caveName(row.caveId) }}</template>
      </el-table-column>
      <el-table-column prop="surveyor" label="外业测量人" width="120" />
      <el-table-column prop="fieldDate" label="测量日期" width="120" />
      <el-table-column label="读数" width="80">
        <template #default="{ row }: { row: Notebook }">{{ row.readings.length }} 行</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }: { row: Notebook }">
          <el-tag :type="statusMeta(row.status).type" size="small" effect="dark">{{ statusMeta(row.status).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="合并批次" width="200">
        <template #default="{ row }: { row: Notebook }">
          <span v-if="row.mergeBatch" class="mono">{{ row.mergeBatch }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="合并时间" width="170">
        <template #default="{ row }: { row: Notebook }">{{ row.mergedAt ? row.mergedAt.replace('T', ' ').slice(0, 16) : '—' }}</template>
      </el-table-column>
      <el-table-column label="合并摘要" min-width="200">
        <template #default="{ row }: { row: Notebook }">
          <span v-if="row.mergeSummary" class="muted">
            新增 {{ row.mergeSummary.created }} · 更新 {{ row.mergeSummary.updated }} · 冲突留存
            {{ row.mergeSummary.conflicts }} · 桩号校验 {{ row.mergeSummary.stakeChecks }} · 重算草图
            {{ row.mergeSummary.recalculatedSketches }}
          </span>
          <span v-else-if="row.status === 'failed'" class="fail-reason" :title="row.failReason">
            失败原因：{{ row.failReason }}
          </span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }: { row: Notebook }">
          <el-button
            v-if="row.status !== 'merged'"
            link
            type="primary"
            size="small"
            :loading="mergingId === row.id"
            @click="mergeNotebook(row)"
          >
            {{ row.status === 'failed' ? '退回重试' : '整本合并' }}
          </el-button>
          <el-button v-else link type="success" size="small" @click="viewResult(row)">查看结果</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="removeNotebook(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑外业手记' : '新建外业手记'" width="1080px" top="5vh">
      <el-form label-width="92px">
        <el-row :gutter="12">
          <el-col :span="6">
            <el-form-item label="手记编号" required>
              <el-input v-model="form.code" placeholder="如 NB-001" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="归属洞穴" required>
              <el-select v-model="form.caveId" style="width: 100%">
                <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="外业测量人">
              <el-input v-model="form.surveyor" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量日期">
              <el-date-picker v-model="form.fieldDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="手记备注">
          <el-input v-model="form.note" placeholder="外业分队、测量仪器、整体情况等" />
        </el-form-item>
      </el-form>

      <div class="readings-head">
        <b>离线读数（{{ readings.length }} 行）</b>
        <el-button size="small" type="primary" plain @click="addRow">添加一行读数</el-button>
      </div>
      <el-table :data="readings" border size="small" class="readings-table">
        <el-table-column label="洞段" width="150">
          <template #default="{ row }: { row: NotebookReading }">
            <el-select v-model="row.segmentId" size="small" style="width: 100%">
              <el-option
                v-for="seg in segmentsOf(form.caveId)"
                :key="seg.id"
                :label="`${seg.code}（${seg.startStake} → ${seg.endStake}）`"
                :value="seg.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="桩号" width="100">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input v-model="row.code" size="small" placeholder="P12" />
          </template>
        </el-table-column>
        <el-table-column label="方位角(°)" width="110">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input-number v-model="row.bearing" :min="0" :max="360" :precision="4" :controls="false" size="small" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column label="倾角(°)" width="100">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input-number v-model="row.dip" :min="-90" :max="90" :precision="4" :controls="false" size="small" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column label="斜距(m)" width="100">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input-number v-model="row.slopeDistance" :min="0" :step="0.1" :precision="3" :controls="false" size="small" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column label="仪器号" width="120">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input v-model="row.instrumentNo" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="测量人" width="100">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input v-model="row.surveyor" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="日期" width="140">
          <template #default="{ row }: { row: NotebookReading }">
            <el-date-picker v-model="row.date" type="date" value-format="YYYY-MM-DD" size="small" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column label="闭合点" width="70">
          <template #default="{ row }: { row: NotebookReading }">
            <el-switch v-model="row.isClosurePoint" />
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="140">
          <template #default="{ row }: { row: NotebookReading }">
            <el-input v-model="row.note" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }: { row: NotebookReading }">
            <el-button link type="danger" size="small" @click="removeRow(row.localId)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveNotebook">保存手记</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resultVisible" title="手记合并汇报" width="640px">
      <template v-if="result">
        <el-alert
          v-if="result.alreadyMerged"
          class="result-alert"
          type="info"
          :closable="false"
          title="该手记此前已合并过，本次为幂等检查，未重复写入测点"
        />
        <el-descriptions :column="2" border size="small" class="result-desc">
          <el-descriptions-item label="手记编号">{{ result.notebookCode }}</el-descriptions-item>
          <el-descriptions-item label="合并批次">
            <span class="mono">{{ result.batchId || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="新增测点">{{ result.created }} 个</el-descriptions-item>
          <el-descriptions-item label="更新测点">{{ result.updated }} 个（含双版本留存）</el-descriptions-item>
          <el-descriptions-item label="桩号区间校验">{{ result.stakeChecks.length }} 行全部通过</el-descriptions-item>
          <el-descriptions-item label="重算草图">{{ result.recalculatedSketches.length }} 张</el-descriptions-item>
        </el-descriptions>

        <template v-if="result.conflicts.length > 0">
          <h4 class="result-sub">同测点双版本留存（{{ result.conflicts.length }} 处）</h4>
          <el-alert
            class="result-alert"
            type="warning"
            :closable="false"
            title="外业读数与内业已复核记录撞在同一测点，两版读数均已留存；正式成果由复核版本进入，可到「测点读数」查看或改判版本。"
          />
          <ul class="conflict-list">
            <li v-for="(item, index) in result.conflicts" :key="index">
              <b>{{ item.segmentCode }} · {{ item.stationCode }}</b> — {{ item.reason }}
            </li>
          </ul>
        </template>

        <template v-if="result.stakeChecks.length > 0">
          <h4 class="result-sub">新落测点桩号</h4>
          <div class="stake-tags">
            <el-tag
              v-for="(item, index) in result.stakeChecks"
              :key="index"
              :type="item.inRange ? 'success' : 'danger'"
              size="small"
              effect="plain"
            >
              {{ item.segmentCode }} · {{ item.stationCode }} → {{ item.stake }}
            </el-tag>
          </div>
        </template>

        <template v-if="result.recalculatedSketches.length > 0">
          <h4 class="result-sub">锚点与拼合偏移已重算</h4>
          <div class="stake-tags">
            <el-tag v-for="(code, index) in result.recalculatedSketches" :key="index" type="info" size="small" effect="plain">
              {{ code }}
            </el-tag>
          </div>
        </template>
      </template>
      <template #footer>
        <el-button type="primary" @click="resultVisible = false">知道了</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.readings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0 8px;
}
.readings-table {
  width: 100%;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fail-reason {
  color: #b03030;
  font-size: 12px;
}
.result-alert {
  margin: 10px 0;
}
.result-desc {
  margin-top: 4px;
}
.result-sub {
  margin: 14px 0 6px;
  font-size: 14px;
}
.conflict-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #8a6d1f;
  line-height: 1.8;
}
.stake-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
