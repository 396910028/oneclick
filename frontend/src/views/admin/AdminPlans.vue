<template>
  <n-space vertical :size="16">
    <!-- 总套餐管理 -->
    <n-card title="总套餐管理">
      <n-space style="margin-bottom: 16px;">
        <n-button type="primary" @click="openCreateGroup">
          <template #icon>
            <span style="font-size: 1em;">+</span>
          </template>
          创建总套餐
        </n-button>
      </n-space>
      <div class="table-responsive">
        <n-data-table :columns="groupColumns" :data="groupList" :loading="groupLoading" />
      </div>
      <n-empty v-if="!groupLoading && groupList.length === 0" description="暂无总套餐，点击上方「创建总套餐」添加" style="margin: 24px 0;" />
    </n-card>

    <!-- 子套餐管理 -->
    <n-card title="子套餐管理">
      <n-space style="margin-bottom: 16px;">
        <n-button type="primary" @click="openCreatePlan">
          <template #icon>
            <span style="font-size: 1em;">+</span>
          </template>
          创建子套餐
        </n-button>
      </n-space>
      <div class="table-responsive">
        <n-data-table :columns="planColumns" :data="planList" :loading="planLoading" />
      </div>
      <n-empty v-if="!planLoading && planList.length === 0" description="暂无子套餐，点击上方「创建子套餐」添加" style="margin: 24px 0;" />
    </n-card>

    <!-- 总套餐创建/编辑弹窗 -->
    <n-modal v-model:show="showGroupModal" preset="card" :title="groupModalTitle" style="width: 520px;" @after-leave="resetGroupForm">
      <n-form ref="groupFormRef" :model="groupForm" label-placement="left" label-width="110px">
        <n-form-item label="总套餐标识" path="group_key" required>
          <n-input v-model:value="groupForm.group_key" placeholder="例如：basic / pro / vip（唯一标识）" :disabled="isEditingGroup" />
        </n-form-item>
        <n-form-item label="总套餐名称" path="name" required>
          <n-input v-model:value="groupForm.name" placeholder="例如：基础套餐 / 高级套餐" />
        </n-form-item>
        <n-form-item label="等级" path="level" required>
          <n-input-number v-model:value="groupForm.level" :min="0" style="width: 100%" placeholder="必填，数字越大等级越高（用于升级判断）" />
        </n-form-item>
        <n-form-item label="总套餐互斥" path="is_exclusive" required>
          <n-select
            v-model:value="groupForm.is_exclusive"
            :options="shareOptions"
            style="width: 100%"
            placeholder="必选：控制该总套餐是否与其他互斥总套餐不能并存"
          />
          <span class="form-hint">互斥：该总套餐与其他互斥总套餐不能同时生效（同一总套餐下的子套餐可以共存/升级）</span>
        </n-form-item>
        <n-form-item label="共享设备数" path="connections">
          <n-input-number v-model:value="groupForm.connections" :min="1" style="width: 100%" placeholder="该总套餐下所有子套餐共用" />
        </n-form-item>
        <n-form-item label="限速 (Mbps)" path="speed_limit">
          <n-input-number v-model:value="groupForm.speed_limit" :min="0" style="width: 100%" placeholder="0 表示不限速" />
        </n-form-item>
        <n-form-item label="套餐列表展示" path="is_public">
          <n-switch v-model:value="groupForm.is_public" :checked-value="1" :unchecked-value="0" />
          <span class="form-hint">关闭后，该总套餐及其下所有子套餐均不在用户端「套餐列表」中显示</span>
        </n-form-item>
        <n-form-item label="启用" path="status">
          <n-switch v-model:value="groupForm.status" :checked-value="1" :unchecked-value="0" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showGroupModal = false">取消</n-button>
          <n-button type="primary" :loading="groupSubmitLoading" @click="submitGroup">{{ isEditingGroup ? '保存' : '创建' }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 子套餐创建/编辑弹窗 -->
    <n-modal v-model:show="showPlanModal" preset="card" :title="planModalTitle" style="width: 520px;" @after-leave="resetPlanForm">
      <n-form ref="planFormRef" :model="planForm" label-placement="left" label-width="110px">
        <n-form-item label="所属总套餐" path="group_id" required>
          <n-select
            v-model:value="planForm.group_id"
            :options="groupOptions"
            :loading="groupLoading"
            style="width: 100%"
            placeholder="必选：选择该子套餐所属的总套餐"
            @update:value="handleGroupSelect"
          />
        </n-form-item>
        <n-form-item label="总套餐名称" path="group_name_display">
          <n-input :value="selectedGroupName" readonly placeholder="自动显示（从总套餐继承）" />
        </n-form-item>
        <n-form-item label="子套餐名称" path="name" required>
          <n-input v-model:value="planForm.name" placeholder="例如：基础套餐-月 / 高级套餐-年" />
        </n-form-item>
        <n-form-item label="描述" path="description">
          <n-input v-model:value="planForm.description" type="textarea" placeholder="套餐说明（选填）" :rows="2" />
        </n-form-item>
        <n-divider style="margin: 12px 0;">价格与时长</n-divider>
        <n-form-item label="套餐价格" path="price" required>
          <n-input-number v-model:value="planForm.price" :min="0" style="width: 100%" placeholder="必填，单一价格" />
        </n-form-item>
        <n-form-item label="持续时间（天）" path="duration_days" required>
          <n-input-number v-model:value="planForm.duration_days" :min="1" style="width: 100%" placeholder="必填，例如：30（月）、365（年）" />
        </n-form-item>
        <n-divider style="margin: 12px 0;">流量（设备数、限速由总套餐决定）</n-divider>
        <n-form-item label="流量 (GB)" path="traffic_limit">
          <n-input-number v-model:value="planForm.traffic_limit_gb" :min="0" style="width: 100%" placeholder="0=无流量，>0 为套餐流量(GB)" />
        </n-form-item>
        <n-form-item label="状态" path="status_plan">
          <n-space>
            <n-switch v-model:value="planForm.status" :checked-value="1" :unchecked-value="0" /> 启用/停用
            <n-switch v-model:value="planForm.is_public" :checked-value="1" :unchecked-value="0" /> 上架/下架
          </n-space>
          <span class="form-hint">关闭「上架」后用户端套餐列表不显示</span>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showPlanModal = false">取消</n-button>
          <n-button type="primary" :loading="planSubmitLoading" @click="submitPlan">{{ isEditingPlan ? '保存' : '创建' }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import {
  NCard,
  NSpace,
  NButton,
  NDataTable,
  NTag,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSwitch,
  NSelect,
  NDivider,
  NEmpty,
  NPopconfirm,
  useMessage
} from 'naive-ui';
import {
  getAdminPlanGroups,
  postAdminPlanGroup,
  putAdminPlanGroup,
  deleteAdminPlanGroup,
  getAdminPlans,
  postAdminPlan,
  putAdminPlan,
  deleteAdminPlan
} from '@/api/admin';

const message = useMessage();

// 总套餐相关
const groupList = ref([]);
const groupLoading = ref(false);
const showGroupModal = ref(false);
const groupSubmitLoading = ref(false);
const groupFormRef = ref(null);
const editGroupId = ref(null);

const groupForm = ref({
  group_key: '',
  name: '',
  level: 0,
  is_exclusive: 0,
  status: 1,
  is_public: 1,
  connections: 1,
  speed_limit: 0
});

const isEditingGroup = computed(() => editGroupId.value != null);
const groupModalTitle = computed(() => (isEditingGroup.value ? '编辑总套餐' : '新建总套餐'));

const shareOptions = [
  { label: '可共享（可与其他总套餐同时存在）', value: 0 },
  { label: '互斥（与其他互斥总套餐不能并存）', value: 1 }
];

const groupColumns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '总套餐标识', key: 'group_key', minWidth: 100, maxWidth: 140, ellipsis: { tooltip: true } },
  { title: '总套餐名称', key: 'name', minWidth: 100, maxWidth: 180, ellipsis: { tooltip: true } },
  { title: '等级', key: 'level', width: 60 },
  {
    title: '互斥',
    key: 'is_exclusive',
    width: 80,
    render: (row) => (row.is_exclusive ? '互斥' : '可共享')
  },
  { title: '设备', key: 'connections', width: 60 },
  {
    title: '限速',
    key: 'speed_limit',
    width: 80,
    render: (row) => (row.speed_limit ? row.speed_limit + ' Mbps' : '不限')
  },
  {
    title: '状态',
    key: 'status_row',
    width: 140,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(
          NPopconfirm,
          {
            onPositiveClick: () => toggleGroupStatus(row),
            positiveText: '确定',
            negativeText: '取消'
          },
          {
            default: () => (row.status ? '确定停用该总套餐？' : '确定启用该总套餐？'),
            trigger: () =>
              h(
                NTag,
                {
                  type: row.status ? 'success' : 'default',
                  style: { cursor: 'pointer' }
                },
                () => (row.status ? '启用' : '停用')
              )
          }
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => toggleGroupPublic(row),
            positiveText: '确定',
            negativeText: '取消'
          },
          {
            default: () => (row.is_public ? '确定下架该总套餐？' : '确定上架该总套餐？'),
            trigger: () =>
              h(
                NTag,
                {
                  type: row.is_public ? 'success' : 'default',
                  style: { cursor: 'pointer' }
                },
                () => (row.is_public ? '上架' : '下架')
              )
          }
        )
      ])
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(NButton, { size: 'small', onClick: () => editGroup(row) }, { default: () => '编辑' }),
        h(
          NButton,
          {
            size: 'small',
            type: 'error',
            tertiary: true,
            onClick: () => doDeleteGroup(row.id)
          },
          { default: () => '删除' }
        )
      ])
  }
];

// 子套餐相关
const planList = ref([]);
const planLoading = ref(false);
const showPlanModal = ref(false);
const planSubmitLoading = ref(false);
const planFormRef = ref(null);
const editPlanId = ref(null);
const selectedGroupName = ref('');

const planForm = ref({
  group_id: null,
  name: '',
  description: '',
  price: 0,
  duration_days: 30,
  traffic_limit_gb: 0,
  is_public: 1,
  status: 1
});

const isEditingPlan = computed(() => editPlanId.value != null);
const planModalTitle = computed(() => (isEditingPlan.value ? '编辑子套餐' : '新建子套餐'));

const groupOptions = computed(() => {
  return groupList.value
    .filter((g) => g.status === 1)
    .map((g) => ({
      label: `${g.name} (${g.group_key})`,
      value: g.id,
      level: g.level,
      name: g.name
    }));
});

const planColumns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '总套餐', key: 'group_name', minWidth: 100, maxWidth: 140, ellipsis: { tooltip: true } },
  { title: '子套餐名称', key: 'name', minWidth: 100, maxWidth: 200, ellipsis: { tooltip: true } },
  { title: '价格', key: 'price', width: 80, render: (row) => `¥${row.price}` },
  {
    title: '时长',
    key: 'duration_days',
    width: 80,
    render: (row) => `${row.duration_days} 天`
  },
  {
    title: '流量',
    key: 'traffic_limit',
    width: 90,
    render: (row) => {
      const gb = row.traffic_limit ? Math.floor(row.traffic_limit / 1024 ** 3) : 0;
      return gb === 0 ? '无流量' : gb + 'GB';
    }
  },
  {
    title: '状态',
    key: 'status_row',
    width: 140,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(
          NPopconfirm,
          {
            onPositiveClick: () => togglePlanStatus(row),
            positiveText: '确定',
            negativeText: '取消'
          },
          {
            default: () => (row.status ? '确定停用该子套餐？' : '确定启用该子套餐？'),
            trigger: () =>
              h(
                NTag,
                {
                  type: row.status ? 'success' : 'default',
                  style: { cursor: 'pointer' }
                },
                () => (row.status ? '启用' : '停用')
              )
          }
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => togglePlanPublic(row),
            positiveText: '确定',
            negativeText: '取消'
          },
          {
            default: () => (row.is_public ? '确定下架该子套餐？' : '确定上架该子套餐？'),
            trigger: () =>
              h(
                NTag,
                {
                  type: row.is_public ? 'success' : 'default',
                  style: { cursor: 'pointer' }
                },
                () => (row.is_public ? '上架' : '下架')
              )
          }
        )
      ])
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    fixed: 'right',
    render: (row) =>
      h(NButton, { size: 'small', onClick: () => editPlan(row) }, { default: () => '编辑' })
  }
];

// 总套餐相关函数
async function fetchGroupList() {
  groupLoading.value = true;
  try {
    const res = await getAdminPlanGroups();
    const list = res.data || [];
    groupList.value = list.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  } catch (e) {
    message.error(e.message || '获取总套餐列表失败');
  } finally {
    groupLoading.value = false;
  }
}

function getDefaultGroupForm() {
  return {
    group_key: '',
    name: '',
    level: 0,
    is_exclusive: 0,
    status: 1,
    is_public: 1,
    connections: 1,
    speed_limit: 0
  };
}

function openCreateGroup() {
  editGroupId.value = null;
  groupForm.value = { ...getDefaultGroupForm() };
  showGroupModal.value = true;
}

function resetGroupForm() {
  groupForm.value = { ...getDefaultGroupForm() };
  editGroupId.value = null;
}

function editGroup(row) {
  editGroupId.value = row.id;
  groupForm.value = {
    group_key: row.group_key ?? '',
    name: row.name ?? '',
    level: row.level ?? 0,
    is_exclusive: row.is_exclusive ?? 0,
    status: row.status ?? 1,
    is_public: row.is_public != null ? Number(row.is_public) : 1,
    connections: Number(row.connections) || 1,
    speed_limit: Number(row.speed_limit) || 0
  };
  showGroupModal.value = true;
}

async function submitGroup() {
  if (!groupForm.value.group_key || !groupForm.value.name || groupForm.value.level == null) {
    message.warning('请填写总套餐标识、名称和等级');
    return;
  }
  groupSubmitLoading.value = true;
  try {
    if (editGroupId.value) {
      await putAdminPlanGroup(editGroupId.value, groupForm.value);
      message.success('总套餐已更新');
    } else {
      await postAdminPlanGroup(groupForm.value);
      message.success('总套餐已添加');
    }
    showGroupModal.value = false;
    await fetchGroupList();
    // 刷新子套餐列表（因为下拉选项可能变了）
    await fetchPlanList();
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    groupSubmitLoading.value = false;
  }
}

async function doDeleteGroup(id) {
  try {
    await deleteAdminPlanGroup(id);
    message.success('总套餐已删除');
    await fetchGroupList();
    await fetchPlanList();
  } catch (e) {
    message.error(e.message || '删除失败');
  }
}

async function toggleGroupStatus(row) {
  try {
    const next = row.status ? 0 : 1;
    await putAdminPlanGroup(row.id, { status: next });
    message.success(next ? '已启用' : '已停用');
    await fetchGroupList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function toggleGroupPublic(row) {
  try {
    const next = row.is_public ? 0 : 1;
    await putAdminPlanGroup(row.id, { is_public: next });
    message.success(next ? '已上架' : '已下架');
    await fetchGroupList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

// 子套餐相关函数
async function fetchPlanList() {
  planLoading.value = true;
  try {
    const res = await getAdminPlans();
    const list = res.data || [];
    planList.value = list.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  } catch (e) {
    message.error(e.message || '获取子套餐列表失败');
  } finally {
    planLoading.value = false;
  }
}

function getDefaultPlanForm() {
  return {
    group_id: null,
    name: '',
    description: '',
    price: 0,
    duration_days: 30,
    traffic_limit_gb: 0,
    is_public: 1,
    status: 1
  };
}

function openCreatePlan() {
  editPlanId.value = null;
  planForm.value = { ...getDefaultPlanForm() };
  selectedGroupName.value = '';
  showPlanModal.value = true;
}

function resetPlanForm() {
  planForm.value = { ...getDefaultPlanForm() };
  editPlanId.value = null;
  selectedGroupName.value = '';
}

function handleGroupSelect(groupId) {
  const group = groupList.value.find((g) => g.id === groupId);
  selectedGroupName.value = group ? group.name : '';
}

function editPlan(row) {
  editPlanId.value = row.id;
  const bytes = Number(row.traffic_limit) || 0;
  planForm.value = {
    group_id: row.group_id ?? null,
    name: row.name ?? '',
    description: row.description ?? '',
    price: Number(row.price) || 0,
    duration_days: Number(row.duration_days) || 30,
    traffic_limit_gb: Math.floor(bytes / (1024 ** 3)),
    is_public: row.is_public != null ? Number(row.is_public) : 1,
    status: row.status != null ? Number(row.status) : 1
  };
  selectedGroupName.value = row.group_name ?? '';
  handleGroupSelect(row.group_id);
  showPlanModal.value = true;
}

async function submitPlan() {
  if (!planForm.value.name || planForm.value.price == null || !planForm.value.group_id || planForm.value.duration_days == null) {
    message.warning('请填写子套餐名称、所属总套餐、价格和持续时间');
    return;
  }
  const gb = Number(planForm.value.traffic_limit_gb) || 0;
  const payload = {
    ...planForm.value,
    traffic_limit: gb * (1024 ** 3)
  };
  delete payload.traffic_limit_gb;
  delete payload.speed_limit;
  delete payload.connections;
  planSubmitLoading.value = true;
  try {
    if (editPlanId.value) {
      await putAdminPlan(editPlanId.value, payload);
      message.success('子套餐已更新');
    } else {
      await postAdminPlan(payload);
      message.success('子套餐已添加');
    }
    showPlanModal.value = false;
    await fetchPlanList();
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    planSubmitLoading.value = false;
  }
}

async function togglePlanStatus(row) {
  try {
    const next = row.status ? 0 : 1;
    await putAdminPlan(row.id, { status: next });
    message.success(next ? '已启用' : '已停用');
    await fetchPlanList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function togglePlanPublic(row) {
  try {
    const next = row.is_public ? 0 : 1;
    await putAdminPlan(row.id, { is_public: next });
    message.success(next ? '已上架' : '已下架');
    await fetchPlanList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

onMounted(async () => {
  await Promise.all([fetchGroupList(), fetchPlanList()]);
});
</script>

<style scoped>
.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--n-text-color-3);
}
</style>
