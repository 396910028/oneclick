<template>
  <n-card title="用户管理">
    <n-space style="margin-bottom: 16px;">
      <n-input
        v-model:value="keyword"
        placeholder="搜索用户名/邮箱"
        clearable
        style="width: 220px"
        @keyup.enter="fetchList"
      />
      <n-button type="primary" @click="fetchList">查询</n-button>
    </n-space>
    <div class="table-responsive">
      <n-data-table :columns="columns" :data="list" :loading="loading" />
    </div>
    <n-pagination
      v-model:page="page"
      v-model:page-size="pageSize"
      :page-count="pageCount"
      show-size-picker
      :page-sizes="[10, 20, 50]"
      style="margin-top: 16px; justify-content: flex-end;"
      @update:page="fetchList"
      @update:page-size="fetchList"
    />

    <n-drawer v-model:show="showDetailDrawer" :width="420" placement="right">
      <n-drawer-content title="用户详情" closable>
        <template v-if="detailData">
          <n-descriptions :column="1" label-placement="left" label-width="120">
            <n-descriptions-item label="注册时间">{{ detailData.created_at ? formatDateTimeUtc8(detailData.created_at) : '-' }}</n-descriptions-item>
            <n-descriptions-item label="当前套餐">{{ detailData.current_plan || '-' }}</n-descriptions-item>
            <n-descriptions-item label="套餐激活时间">{{ detailData.plan_activated_at ? formatDateTimeUtc8(detailData.plan_activated_at) : '-' }}</n-descriptions-item>
            <n-descriptions-item label="账户余额">¥{{ detailData.balance ?? 0 }}</n-descriptions-item>
            <n-descriptions-item label="分享/订阅 URL">
              <template v-if="detailData.share_url">
                <n-input :value="detailData.share_url" readonly type="textarea" :autosize="{ minRows: 2 }" />
                <n-button size="tiny" quaternary style="margin-top: 4px;" @click="copyShareUrl(detailData.share_url)">复制</n-button>
              </template>
              <span v-else>-</span>
            </n-descriptions-item>
            <n-descriptions-item label="UUID">
              <template v-if="detailData.uuids && detailData.uuids.length">
                <div v-for="(u, i) in detailData.uuids" :key="i" style="margin-bottom: 4px;">
                  <n-input :value="u.uuid" readonly size="small" />
                  <n-text v-if="u.remark" depth="3" style="font-size: 12px;">{{ u.remark }}</n-text>
                </div>
              </template>
              <span v-else>-</span>
            </n-descriptions-item>
          </n-descriptions>
        </template>
      </n-drawer-content>
    </n-drawer>
    <n-modal v-model:show="showEditModal" preset="card" title="编辑用户" style="width: 520px;">
      <n-form ref="editFormRef" :model="editForm" label-placement="left" label-width="120px">
        <n-form-item label="流量限制 (GB)" path="traffic_total_gb">
          <n-input-number
            v-model:value="editForm.traffic_total_gb"
            :min="0"
            :precision="2"
            style="width: 100%"
            placeholder="0 表示不限流量"
          />
        </n-form-item>
        <n-form-item label="已用流量 (GB)" path="traffic_used_gb">
          <n-input-number
            v-model:value="editForm.traffic_used_gb"
            :min="0"
            :precision="2"
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="到期时间" path="expired_at">
          <n-date-picker
            v-model:value="editForm.expired_at"
            type="datetime"
            format="yyyy-MM-dd HH:mm:ss"
            value-format="timestamp"
            clearable
            style="width: 100%"
            placeholder="留空表示永不过期"
          />
        </n-form-item>
        <n-form-item label="账户余额" path="balance">
          <n-input-number
            v-model:value="editForm.balance"
            :min="0"
            :precision="2"
            style="width: 100%"
          />
        </n-form-item>
        <n-alert type="warning" :show-icon="false" style="margin-top: 12px;">
          <div style="font-size: 12px;">
            <strong>流量控制和断网说明：</strong><br>
            • 设置流量限制后，当用户流量用完时，对接程序会自动拒绝连接（强行断网）<br>
            • 设置到期时间后，到期后订阅接口会返回空节点，用户无法连接<br>
            • 将用户状态设为「停用」后，用户立即无法登录和使用服务（强行断网）
          </div>
        </n-alert>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEditModal = false">取消</n-button>
          <n-button type="primary" :loading="submitLoading" @click="handleSaveEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import {
  NCard,
  NSpace,
  NInput,
  NButton,
  NDataTable,
  NPagination,
  NTag,
  NPopconfirm,
  NModal,
  NForm,
  NFormItem,
  NInputNumber,
  NDatePicker,
  NAlert,
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NText,
  useMessage
} from 'naive-ui';
import { getAdminUsers, getAdminUserDetail, patchAdminUser, deleteAdminUser } from '@/api/admin';
import { useUserStore } from '@/store/user';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const message = useMessage();
const userStore = useUserStore();
const list = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');

const currentUserId = computed(() => userStore.user?.id);

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

const columns = [
  { title: 'ID', key: 'id', width: 70 },
  { title: '用户名', key: 'username', minWidth: 100, maxWidth: 160, ellipsis: { tooltip: true } },
  { title: '邮箱', key: 'email', minWidth: 140, maxWidth: 240, ellipsis: { tooltip: true } },
  { title: '角色', key: 'role', width: 90, render: (row) => h(NTag, { type: row.role === 'admin' ? 'warning' : 'default' }, () => row.role === 'admin' ? '管理员' : '用户') },
  { title: '状态', key: 'status', width: 90, render: (row) => h(NTag, { type: row.status === 'active' ? 'success' : 'error' }, () => row.status === 'active' ? '正常' : '封禁') },
  { title: '余额', key: 'balance', width: 90, render: (row) => `¥${row.balance}` },
  {
    title: '流量使用',
    key: 'traffic',
    width: 180,
    render: (row) => {
      const total = row.traffic_total || 0;
      const used = row.traffic_used || 0;
      if (total === 0) return '不限';
      const totalGB = (total / 1073741824).toFixed(2);
      const usedGB = (used / 1073741824).toFixed(2);
      const percent = ((used / total) * 100).toFixed(1);
      return `${usedGB}GB / ${totalGB}GB (${percent}%)`;
    }
  },
  {
    title: '到期时间',
    key: 'expired_at',
    width: 200,
    render: (row) => row.expired_at ? formatDateTimeUtc8(row.expired_at) : '-'
  },
  {
    title: '注册时间',
    key: 'created_at',
    width: 200,
    render: (row) => formatDateTimeUtc8(row.created_at)
  },
  {
    title: '操作',
    key: 'actions',
    width: 280,
    fixed: 'right',
    render: (row) => {
      const isSelf = row.id === currentUserId.value;
      const btns = [];
      if (row.status === 'banned') {
        btns.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleStatus(row.id, 'active'),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定启用该用户？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'success' },
                  { default: () => '启用' }
                )
            }
          )
        );
      } else {
        btns.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleStatus(row.id, 'banned'),
              positiveText: '确定',
              negativeText: '取消',
              disabled: isSelf
            },
            {
              default: () => '确定停用该用户？停用后将无法登录。',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', disabled: isSelf },
                  { default: () => '停用' }
                )
            }
          )
        );
      }
      if (row.role === 'user') {
        // 升级为管理员前二次确认
        btns.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleRole(row.id, 'admin'),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定将该用户升级为管理员？管理员将拥有系统全部管理权限，请谨慎操作。',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'warning' },
                  { default: () => '升级管理员' }
                )
            }
          )
        );
      } else if (!isSelf) {
        // 取消管理员前二次确认
        btns.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleRole(row.id, 'user'),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定取消该用户的管理员权限？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small' },
                  { default: () => '取消管理员' }
                )
            }
          )
        );
      }
      btns.push(
        h(NButton, { size: 'small', onClick: () => openDetail(row) }, { default: () => '详情' })
      );
      btns.push(
        h(NButton, { size: 'small', type: 'info', onClick: () => editUser(row) }, { default: () => '编辑' })
      );
      btns.push(
        h(NPopconfirm, {
          onPositiveClick: () => handleDelete(row.id),
          positiveText: '删除',
          negativeText: '取消',
          disabled: isSelf
        }, {
          default: () => '确定删除该用户？其订单、工单等将一并删除。',
          trigger: () => h(NButton, { size: 'small', type: 'error', disabled: isSelf }, { default: () => '删除' })
        })
      );
      return h(NSpace, { size: 'small' }, () => btns);
    }
  }
];

const showDetailDrawer = ref(false);
const detailData = ref(null);

const showEditModal = ref(false);
const editForm = ref({
  id: null,
  traffic_total_gb: 0,
  traffic_used_gb: 0,
  expired_at: null,
  balance: 0
});
const editFormRef = ref(null);
const submitLoading = ref(false);

async function openDetail(row) {
  try {
    const res = await getAdminUserDetail(row.id);
    detailData.value = res.data || null;
    showDetailDrawer.value = true;
  } catch (e) {
    message.error(e.message || '获取用户详情失败');
  }
}

function copyShareUrl(url) {
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => message.success('已复制到剪贴板')).catch(() => message.error('复制失败'));
}

async function fetchList() {
  loading.value = true;
  try {
    const res = await getAdminUsers({ page: page.value, size: pageSize.value, keyword: keyword.value });
    list.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (e) {
    message.error(e.message || '获取列表失败');
  } finally {
    loading.value = false;
  }
}

async function handleStatus(id, status) {
  try {
    await patchAdminUser(id, { status });
    message.success(status === 'active' ? '已启用' : '已停用');
    await fetchList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function handleRole(id, role) {
  try {
    await patchAdminUser(id, { role });
    message.success(role === 'admin' ? '已设为管理员' : '已取消管理员');
    await fetchList();
    // 如果是取消自己的管理员权限，跳转到普通用户页面
    if (role !== 'admin' && id === currentUserId.value) {
      // 更新用户角色
      userStore.user.role = 'user';
      localStorage.setItem('ip_proxy_user', JSON.stringify(userStore.user));
      // 跳转到普通用户页面
      window.location.href = '/dashboard';
    }
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function handleDelete(id) {
  try {
    await deleteAdminUser(id);
    message.success('用户已删除');
    await fetchList();
  } catch (e) {
    message.error(e.message || '删除失败');
  }
}

function editUser(row) {
  editForm.value = {
    id: row.id,
    traffic_total_gb: row.traffic_total ? (row.traffic_total / 1073741824).toFixed(2) : 0,
    traffic_used_gb: row.traffic_used ? (row.traffic_used / 1073741824).toFixed(2) : 0,
    expired_at: row.expired_at ? new Date(row.expired_at).getTime() : null,
    balance: Number(row.balance) || 0
  };
  showEditModal.value = true;
}

async function handleSaveEdit() {
  submitLoading.value = true;
  try {
    const payload = {
      traffic_total: editForm.value.traffic_total_gb
        ? Math.round(Number(editForm.value.traffic_total_gb) * 1073741824)
        : 0,
      traffic_used: editForm.value.traffic_used_gb
        ? Math.round(Number(editForm.value.traffic_used_gb) * 1073741824)
        : 0,
      balance: editForm.value.balance,
      expired_at: editForm.value.expired_at
        ? new Date(editForm.value.expired_at).toISOString().slice(0, 19).replace('T', ' ')
        : null
    };
    await patchAdminUser(editForm.value.id, payload);
    message.success('用户信息已更新');
    showEditModal.value = false;
    await fetchList();
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    submitLoading.value = false;
  }
}

onMounted(fetchList);
</script>

<style scoped>
.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--n-text-color-3);
}
</style>
