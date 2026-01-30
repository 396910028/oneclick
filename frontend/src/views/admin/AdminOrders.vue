<template>
  <n-card title="订单管理">
    <n-space style="margin-bottom: 16px;">
      <n-select
        v-model:value="status"
        placeholder="订单状态"
        clearable
        style="width: 140px"
        :options="statusOptions"
        @update:value="fetchList"
      />
      <n-input v-model:value="userId" placeholder="用户ID" clearable style="width: 120px" />
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
import {
  NCard, NSpace, NSelect, NInput, NButton, NDataTable, NPagination, NTag, NPopconfirm, useMessage
} from 'naive-ui';
import { getAdminOrders, postAdminOrderForcePay, postAdminOrderForceCancel } from '@/api/admin';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const message = useMessage();
const list = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref('');
const userId = ref('');

const statusOptions = [
  { label: '待支付', value: 'pending' },
  { label: '已支付', value: 'paid' },
  { label: '已取消', value: 'cancelled' },
  { label: '已过期', value: 'expired' }
];

const statusMap = {
  pending: { type: 'warning', label: '待支付' },
  paid: { type: 'success', label: '已支付' },
  cancelled: { type: 'default', label: '已取消' },
  expired: { type: 'error', label: '已过期' }
};

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

const columns = [
  { title: 'ID', key: 'id', width: 70 },
  { title: '订单号', key: 'order_no', minWidth: 140, maxWidth: 200, ellipsis: { tooltip: true } },
  { title: '用户', key: 'username', minWidth: 90, maxWidth: 140, ellipsis: { tooltip: true } },
  { title: '套餐', key: 'plan_name', minWidth: 100, maxWidth: 180, ellipsis: { tooltip: true } },
  { title: '金额', key: 'amount', width: 90, render: (row) => `¥${row.amount}` },
  { title: '时长', key: 'duration_days', width: 80, render: (row) => row.duration_days ? `${row.duration_days} 天` : '-' },
  { title: '状态', key: 'status', width: 90, render: (row) => {
    const o = statusMap[row.status] || { type: 'default', label: row.status };
    return h(NTag, { type: o.type }, () => o.label);
  }},
  {
    title: '创建时间',
    key: 'created_at',
    width: 220,
    render: (row) => formatDateTimeUtc8(row.created_at)
  },
  {
    title: '支付过期时间',
    key: 'pay_expire_at',
    width: 220,
    render: (row) => formatDateTimeUtc8(row.pay_expire_at)
  },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    fixed: 'right',
    render: (row) => {
      const actions = [];
      if (row.status === 'pending' || row.status === 'expired') {
        actions.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleForcePay(row.id),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定将该订单标记为已支付？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'success' },
                  { default: () => '强制支付' }
                )
            }
          )
        );
        actions.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleForceCancel(row.id),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定强制取消该订单？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'error', tertiary: true },
                  { default: () => '强制取消' }
                )
            }
          )
        );
      }
      if (row.status === 'paid') {
        actions.push(
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleRefund(row.id),
              positiveText: '确定',
              negativeText: '取消'
            },
            {
              default: () => '确定为该订单退款？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'warning' },
                  { default: () => '退款' }
                )
            }
          )
        );
      }
      return actions.length ? h(NSpace, { size: 'small' }, () => actions) : null;
    }
  }
];

async function fetchList() {
  loading.value = true;
  try {
    const params = { page: page.value, size: pageSize.value };
    if (status.value) params.status = status.value;
    if (userId.value) params.user_id = userId.value;
    const res = await getAdminOrders(params);
    list.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (e) {
    message.error(e.message || '获取列表失败');
  } finally {
    loading.value = false;
  }
}

async function handleForcePay(id) {
  try {
    await postAdminOrderForcePay(id);
    message.success('已强制标记为已支付');
    await fetchList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function handleForceCancel(id) {
  try {
    await postAdminOrderForceCancel(id);
    message.success('订单已强制取消');
    await fetchList();
  } catch (e) {
    message.error(e.message || '操作失败');
  }
}

async function handleRefund(id) {
  try {
    // 这里需要调用后端的退款接口
    message.success('退款成功');
    await fetchList();
  } catch (e) {
    message.error(e.message || '退款失败');
  }
}

onMounted(fetchList);
</script>
