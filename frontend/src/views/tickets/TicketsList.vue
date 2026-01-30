<template>
  <n-card title="我的工单">
    <n-space justify="space-between" style="margin-bottom: 16px;">
      <n-select
        v-model:value="status"
        :options="statusOptions"
        placeholder="按状态筛选"
        clearable
        style="max-width: 200px"
        @update:value="fetchTickets"
      />
      <n-button type="primary" @click="goCreate">新建工单</n-button>
    </n-space>

    <div class="table-responsive">
      <n-data-table :columns="columns" :data="tickets" :loading="loading" />
    </div>
    <n-pagination
      v-model:page="page"
      v-model:page-size="pageSize"
      :page-count="pageCount"
      show-size-picker
      :page-sizes="[10, 20, 50]"
      style="margin-top: 16px; text-align: right;"
      @update:page="fetchTickets"
      @update:page-size="fetchTickets"
    />
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard,
  NSpace,
  NSelect,
  NButton,
  NDataTable,
  NPagination,
  NTag,
  useMessage
} from 'naive-ui';
import { getTickets } from '@/api/tickets';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const router = useRouter();
const message = useMessage();

const tickets = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref('');

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

const statusOptions = [
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'in_progress' },
  { label: '已解决', value: 'resolved' },
  { label: '已关闭', value: 'closed' }
];

const statusMap = {
  open: { label: '待处理', type: 'primary' },
  in_progress: { label: '处理中', type: 'warning' },
  resolved: { label: '已解决', type: 'success' },
  closed: { label: '已关闭', type: 'default' }
};

const columns = [
  {
    title: '工单号',
    key: 'ticket_no'
  },
  {
    title: '标题',
    key: 'title'
  },
  {
    title: '分类',
    key: 'category',
    render(row) {
      const categoryMap = {
        technical: '技术问题',
        billing: '账单问题',
        account: '账户问题',
        other: '其他'
      };
      return categoryMap[row.category] || row.category;
    }
  },
  {
    title: '状态',
    key: 'status',
    render(row) {
      const info = statusMap[row.status] || { label: row.status, type: 'default' };
      return h(
        NTag,
        { type: info.type },
        { default: () => info.label }
      );
    }
  },
  {
    title: '优先级',
    key: 'priority',
    render(row) {
      const priorityMap = {
        low: '低',
        medium: '中',
        high: '高',
        urgent: '紧急'
      };
      return priorityMap[row.priority] || row.priority;
    }
  },
  {
    title: '创建时间',
    key: 'created_at',
    render(row) {
      return formatDateTimeUtc8(row.created_at);
    }
  },
  {
    title: '操作',
    key: 'actions',
    render(row) {
      return h(
        NButton,
        {
          text: true,
          type: 'primary',
          size: 'small',
          onClick: () => goDetail(row)
        },
        { default: () => '查看' }
      );
    }
  }
];

async function fetchTickets() {
  loading.value = true;
  try {
    const res = await getTickets({
      page: page.value,
      size: pageSize.value,
      status: status.value
    });
    tickets.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (err) {
    message.error(err.message || '获取工单失败');
  } finally {
    loading.value = false;
  }
}

function goCreate() {
  router.push('/tickets/new');
}

function goDetail(row) {
  router.push(`/tickets/${row.id}`);
}

onMounted(fetchTickets);
</script>

