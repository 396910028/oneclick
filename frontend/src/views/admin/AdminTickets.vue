<template>
  <n-card title="工单管理">
    <n-space style="margin-bottom: 16px;">
      <n-select
        v-model:value="status"
        placeholder="状态"
        clearable
        style="width: 120px"
        :options="statusOptions"
        @update:value="fetchList"
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
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NSpace, NSelect, NButton, NDataTable, NPagination, NTag, NPopconfirm, useMessage
} from 'naive-ui';
import { getAdminTickets, deleteAdminTicket } from '@/api/admin';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const router = useRouter();
const message = useMessage();
const list = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref('');

const statusOptions = [
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'in_progress' },
  { label: '已解决', value: 'resolved' },
  { label: '已关闭', value: 'closed' }
];

const statusMap = {
  open: { type: 'primary', label: '待处理' },
  in_progress: { type: 'warning', label: '处理中' },
  resolved: { type: 'success', label: '已解决' },
  closed: { type: 'default', label: '已关闭' }
};

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

const columns = [
  { title: 'ID', key: 'id', width: 70 },
  { title: '工单号', key: 'ticket_no', width: 140 },
  { title: '用户ID', key: 'user_id', width: 80 },
  { title: '标题', key: 'title', minWidth: 120, maxWidth: 280, ellipsis: { tooltip: true } },
  {
    title: '分类',
    key: 'category',
    width: 100,
    render: (row) => {
      const categoryMap = {
        technical: '技术问题',
        billing: '账单问题',
        account: '账户问题',
        other: '其他'
      };
      return categoryMap[row.category] || row.category || '-';
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row) => {
      const o = statusMap[row.status] || { type: 'default', label: row.status };
      return h(NTag, { type: o.type }, () => o.label);
    }
  },
  {
    title: '优先级',
    key: 'priority',
    width: 80,
    render: (row) => {
      const priorityMap = {
        low: '低',
        medium: '中',
        high: '高',
        urgent: '紧急'
      };
      return priorityMap[row.priority] || row.priority || '-';
    }
  },
  {
    title: '创建时间',
    key: 'created_at',
    width: 220,
    render: (row) => formatDateTimeUtc8(row.created_at)
  },
  {
    title: '到期时间',
    key: 'due_at',
    width: 220,
    render: (row) => {
      if (!row.due_at) return '-';
      return formatDateTimeUtc8(row.due_at);
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 160,
    render: (row) => h(NSpace, { size: 'small' }, () => [
      h(NButton, { size: 'small', type: 'primary', onClick: () => router.push(`/tickets/${row.id}`) }, { default: () => '查看/回复' }),
      h(NPopconfirm, {
        onPositiveClick: () => handleDelete(row.id),
        positiveText: '删除',
        negativeText: '取消'
      }, {
        default: () => '确定删除该工单？',
        trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' })
      })
    ])
  }
];

async function fetchList() {
  loading.value = true;
  try {
    const params = { page: page.value, size: pageSize.value };
    if (status.value) params.status = status.value;
    const res = await getAdminTickets(params);
    list.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (e) {
    message.error(e.message || '获取列表失败');
  } finally {
    loading.value = false;
  }
}

async function handleDelete(id) {
  try {
    await deleteAdminTicket(id);
    message.success('工单已删除');
    await fetchList();
  } catch (e) {
    message.error(e.message || '删除失败');
  }
}

onMounted(fetchList);
</script>
