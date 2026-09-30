<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FieldNotebook, NotebookBatch, NotebookMergePreview } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { notebookStore } from '@/stores/notebookStore'
import { downloadJson } from '@/utils/export'
import { formatDms } from '@/utils/survey'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const notebookState = useStore(notebookStore)

const rawText = ref('')
const fileName = ref('')
const merging = ref(false)
const preview = ref<NotebookMergePreview | null>(null)

const previewNotebook = computed<FieldNotebook | null>(() => preview.value?.notebook ?? null)

const example: FieldNotebook = {
  notebookId: 'NB-20260930-01',
  caveName: '青龙背斜溶洞',
  team: '外业一组',
  recordedAt: '2026-09-30',
  readings: [
    {
      segmentCode: 'C-01',
      code: 'P3',
      stake: 'K0+042',
      bearing: 119.6,
      dip: -2.1,
      slopeDistance: 14.2,
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      date: '2026-09-30',
      note: '新落测点，位于廊道左壁拐点'
    },
    {
      segmentCode: 'C-01',
      code: 'P2',
      stake: 'K0+028',
      bearing: 121.8,
      dip: -1.6,
      slopeDistance: 15.6,
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      note: '与内业已复核记录同点，两版读数均保留'
    }
  ]
}

async function readFile(file: File): Promise<void> {
  fileName.value = file.name
  rawText.value = await file.text()
  preview.value = null
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  void readFile(file)
}

async function loadPreview(): Promise<void> {
  if (!rawText.value.trim()) {
    ElMessage.warning('请先选择手记文件或粘贴 JSON')
    return
  }
  try {
    preview.value = await notebookStore.getState().importText(rawText.value, fileName.value || undefined)
    ElMessage.success(`已生成预览：新增 ${preview.value.createdCount} 站，冲突 ${preview.value.conflictCount} 站`)
  } catch (error) {
    preview.value = null
    ElMessage.error(error instanceof Error ? error.message : '手记解析失败')
  }
}

function segmentCodeOf(segmentId: string): string {
  return segmentState.segments.find((segment) => segment.id === segmentId)?.code ?? '未匹配洞段'
}

function caveNameOf(name: string): string {
  return caveState.caves.find((cave) => cave.name === name)?.name ?? name
}

async function applyMerge(): Promise<void> {
  if (!preview.value) return
  merging.value = true
  try {
    const batch = await notebookStore.getState().merge(preview.value)
    ElMessage.success(`手记 ${batch.notebookId} 已合并，未产生重复测点`)
    preview.value = null
    rawText.value = ''
    fileName.value = ''
  } catch (error) {
    ElMessage.error(`合并失败，已保留失败批次供退回重试：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    merging.value = false
  }
}

async function retryBatch(batch: NotebookBatch): Promise<void> {
  if (batch.rawInput && !batch.rawNotebook) {
    rawText.value = batch.rawInput
    fileName.value = batch.caveName
    preview.value = null
    ElMessage.info('已载入失败原文，请修正后重新解析并合并')
    return
  }
  merging.value = true
  try {
    await notebookStore.getState().retry(batch.notebookId)
    ElMessage.success(`手记 ${batch.notebookId} 重试成功`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  } finally {
    merging.value = false
  }
}

async function removeBatch(batch: NotebookBatch): Promise<void> {
  await ElMessageBox.confirm(`确认移除手记「${batch.notebookId}」的合并记录？原始读数版本不会在此操作中删除。`, '移除确认', {
    type: 'warning'
  })
  await notebookStore.getState().remove(batch.notebookId)
  ElMessage.success('合并记录已移除')
}

function downloadTemplate(): void {
  downloadJson('外业手记模板.json', example)
}

function clearInput(): void {
  preview.value = null
  rawText.value = ''
  fileName.value = ''
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">外业手记合并</h2>
        <p class="page-sub">
          回驻地后整本导入离线手记。冲突测点保留外业/内业两版，正式成果按复核状态选版；同一点重试使用稳定版本 ID，不堆重复测点。
        </p>
      </div>
      <el-button @click="downloadTemplate">下载手记模板</el-button>
    </div>

    <el-card shadow="never" class="import-card">
      <div class="import-row">
        <div class="file-box">
          <label class="upload-btn">
            选择手记 JSON
            <input accept="application/json,.json" type="file" @change="onFileChange" />
          </label>
          <span class="muted">{{ fileName || '也可以直接在右侧粘贴手记内容' }}</span>
        </div>
        <div class="actions">
          <el-button type="primary" @click="loadPreview">解析并校验整本</el-button>
          <el-button @click="clearInput">清空</el-button>
        </div>
      </div>
      <el-input
        v-model="rawText"
        type="textarea"
        :rows="10"
        placeholder='{"notebookId":"NB-001","caveName":"青龙背斜溶洞","recordedAt":"2026-09-30","readings":[...]}'
      />
    </el-card>

    <template v-if="preview && previewNotebook">
      <div class="preview-head">
        <div>
          <h3 class="section-title">合并预览：{{ previewNotebook.notebookId }}</h3>
          <p class="muted">
            洞穴：{{ caveNameOf(previewNotebook.caveName) }} · 外业组：{{ previewNotebook.team || '—' }} ·
            记录日期：{{ previewNotebook.recordedAt }}
          </p>
        </div>
        <div class="summary-tags">
          <el-tag type="success" effect="plain">新落测点 {{ preview.createdCount }}</el-tag>
          <el-tag type="warning" effect="plain">同点两版 {{ preview.conflictCount }}</el-tag>
          <el-button type="primary" :loading="merging" @click="applyMerge">确认整本合并</el-button>
        </div>
      </div>

      <el-table :data="preview.items" border stripe>
        <el-table-column label="洞段" width="100">
          <template #default="{ row }">{{ segmentCodeOf(row.segmentId) }}</template>
        </el-table-column>
        <el-table-column prop="reading.code" label="测点" width="90" />
        <el-table-column prop="reading.stake" label="新读数桩号" width="120" />
        <el-table-column label="外业读数" min-width="220">
          <template #default="{ row }">
            {{ row.reading.bearing }}° ({{ formatDms(row.reading.bearing) }}) · 倾角 {{ row.reading.dip }}° ·
            斜距 {{ row.reading.slopeDistance }} m
          </template>
        </el-table-column>
        <el-table-column label="处理方式" width="120">
          <template #default="{ row }">
            <el-tag :type="row.action === 'created' ? 'success' : 'warning'" size="small" effect="plain">
              {{ row.action === 'created' ? '新落测点' : '两版保留' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前正式版" min-width="230">
          <template #default="{ row }">
            <span v-if="row.current">
              {{ row.current.source === 'field' ? '外业' : '内业' }} ·
              {{ row.current.reviewState === 'reviewed' ? '已复核' : '待复核' }} ·
              {{ row.current.bearing }}° / {{ row.current.dip }}° / {{ row.current.slopeDistance }} m
            </span>
            <span v-else class="muted">无同点记录，将按洞段桩号区间新建</span>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <h3 class="section-title">已接收手记</h3>
    <el-table :data="notebookState.batches" border stripe>
      <el-table-column prop="notebookId" label="手记编号" width="170" />
      <el-table-column prop="caveName" label="洞穴" min-width="160" />
      <el-table-column prop="team" label="外业组" width="120" />
      <el-table-column prop="recordedAt" label="记录日期" width="120" />
      <el-table-column prop="mergedAt" label="最近处理时间" width="190" />
      <el-table-column label="结果" width="110">
        <template #default="{ row }: { row: NotebookBatch }">
          <el-tag :type="row.status === 'success' ? 'success' : 'danger'" size="small" effect="plain">
            {{ row.status === 'success' ? '已合并' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="读数统计" width="190">
        <template #default="{ row }: { row: NotebookBatch }">
          共 {{ row.importedCount }} · 新落 {{ row.createdCount }} · 冲突 {{ row.conflictCount }}
        </template>
      </el-table-column>
      <el-table-column prop="error" label="失败原因" min-width="220" show-overflow-tooltip />
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: NotebookBatch }">
          <el-button
            v-if="row.status === 'failed' && (row.rawNotebook || row.rawInput)"
            link
            type="primary"
            size="small"
            :loading="merging"
            @click="retryBatch(row)"
          >
            {{ row.rawNotebook ? '退回重试' : '载入修正' }}
          </el-button>
          <el-button link type="danger" size="small" @click="removeBatch(row)">移除记录</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.import-card {
  margin-bottom: 16px;
  border-radius: 12px;
}
.import-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.file-box {
  display: flex;
  align-items: center;
  gap: 12px;
}
.upload-btn {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border: 1px solid #2f6f8f;
  border-radius: 6px;
  color: #2f6f8f;
  cursor: pointer;
  font-size: 13px;
}
.upload-btn input {
  display: none;
}
.actions {
  display: flex;
  gap: 8px;
}
.preview-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.summary-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 22px;
}
</style>
