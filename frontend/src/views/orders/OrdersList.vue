<template>
  <n-card title="我的订单">
    <div class="table-responsive">
      <n-data-table :columns="columns" :data="orders" :loading="loading" />
    </div>
    <n-pagination
      v-model:page="page"
      v-model:page-size="pageSize"
      :page-count="pageCount"
      show-size-picker
      :page-sizes="[10, 20, 50]"
      style="margin-top: 16px; text-align: right;"
      @update:page="fetchOrders"
      @update:page-size="fetchOrders"
    />
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import { NCard, NDataTable, NPagination, NTag, NButton, NPopconfirm, useMessage } from 'naive-ui';
import { getOrders, cancelOrder } from '@/api/orders';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const message = useMessage();

const orders = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

const statusMap = {
  pending: { label: '待支付', type: 'warning' },
  paid: { label: '已支付', type: 'success' },
  cancelled: { label: '已取消', type: 'default' },
  expired: { label: '已过期', type: 'error' }
};

const columns = [
  {
    title: '订单号',
    key: 'order_no'
  },
  {
    title: '套餐',
    key: 'plan_name'
  },
  {
    title: '金额',
    key: 'amount',
    render(row) {
      return `¥${row.amount}`;
    }
  },
  {
    title: '时长',
    key: 'duration_days',
    render(row) {
      return row.duration_days ? `${row.duration_days} 天` : '-';
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
    title: '支付剩余时间',
    key: 'pay_expire_at',
    render(row) {
      if (row.status !== 'pending' || !row.pay_expire_at) return '-';
      const expire = new Date(row.pay_expire_at);
      const now = new Date();
      const diff = expire.getTime() - now.getTime();
      if (diff <= 0) return '已过期';
      const minutes = Math.ceil(diff / 60000);
      return `${minutes} 分钟`;
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
    title: '支付时间',
    key: 'paid_at',
    render(row) {
      return formatDateTimeUtc8(row.paid_at);
    }
  },
  {
    title: '操作',
    key: 'actions',
    render(row) {
      if (row.status !== 'pending') return null;

      return h(
        'div',
        { style: 'display: flex; gap: 8px;' },
        [
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              onClick: () => {
                message.info('支付功能暂未接入，请稍后。');
              }
            },
            { default: () => '去支付' }
          ),
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleCancel(row.id),
              positiveText: '确定',
              negativeText: '再想想'
            },
            {
              default: () => '确定取消该订单？',
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'error', tertiary: true },
                  { default: () => '取消订单' }
                )
            }
          )
        ]
      );
    }
  }
];

async function fetchOrders() {
  loading.value = true;
  try {
    const res = await getOrders({
      page: page.value,
      size: pageSize.value
    });
    orders.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (err) {
    message.error(err.message || '获取订单失败');
  } finally {
    loading.value = false;
  }
}

async function handleCancel(id) {
  try {
    await cancelOrder(id);
    message.success('订单已取消');
    await fetchOrders();
  } catch (err) {
    message.error(err.message || '取消订单失败');
  }
}

onMounted(fetchOrders);
</script>

