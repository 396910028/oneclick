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
    <n-modal v-model:show="showUnsubscribeModal" preset="card" title="退订" style="width: 420px;">
      <n-form ref="unsubFormRef" :model="unsubForm" label-placement="left" label-width="120px">
        <n-alert v-if="remainingInfo" type="info" style="margin-bottom: 16px;">
          <div>剩余天数：{{ remainingInfo.remaining_days }} 天</div>
          <div>剩余流量：{{ remainingInfo.remaining_traffic_gb }} GB</div>
        </n-alert>
        <n-form-item label="退订方式">
          <n-radio-group v-model:value="unsubForm.refund_type">
            <n-radio value="full">全额退订（将扣减所有剩余天数和流量，套餐将失效）</n-radio>
            <n-radio value="partial">部分退订</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="扣减天数">
          <n-input-number v-model:value="unsubForm.duration_days_deduct" :min="0" :max="remainingInfo ? remainingInfo.remaining_days : undefined" :disabled="unsubForm.refund_type === 'full'" style="width: 100%" placeholder="0 表示不扣减时长" />
        </n-form-item>
        <n-form-item label="扣减流量 (GB)">
          <n-input-number v-model:value="unsubForm.traffic_gb_deduct" :min="0" :max="remainingInfo ? parseFloat(remainingInfo.remaining_traffic_gb) : undefined" :precision="2" :disabled="unsubForm.refund_type === 'full'" style="width: 100%" placeholder="0 表示不扣减流量" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="unsubForm.remark" type="textarea" placeholder="选填" :rows="2" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showUnsubscribeModal = false">取消</n-button>
          <n-button type="warning" :loading="unsubLoading" @click="submitUnsubscribe">确认退订</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, watch, h } from 'vue';
import { NCard, NDataTable, NPagination, NTag, NButton, NPopconfirm, NModal, NForm, NFormItem, NInputNumber, NInput, NRadioGroup, NRadio, useMessage } from 'naive-ui';
import { getOrders, cancelOrder, getOrderRemaining, unsubscribeOrder } from '@/api/orders';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const message = useMessage();

const orders = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);

const showUnsubscribeModal = ref(false);
const unsubForm = ref({ duration_days_deduct: 0, traffic_gb_deduct: 0, remark: '', full_refund: false });
const unsubFormRef = ref(null);
const unsubLoading = ref(false);
const remainingInfo = ref(null);

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
    key: 'order_no',
    minWidth: 140,
    maxWidth: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: '套餐',
    key: 'plan_name',
    minWidth: 100,
    maxWidth: 180,
    ellipsis: { tooltip: true }
  },
  {
    title: '金额',
    key: 'amount',
    width: 90,
    render(row) {
      return `¥${row.amount}`;
    }
  },
  {
    title: '时长',
    key: 'duration_days',
    width: 80,
    render(row) {
      const d = Number(row.duration_days);
      if (d === 0) return '-';
      return `${row.duration_days} 天`;
    }
  },
  {
    title: '流量',
    key: 'traffic_amount',
    width: 90,
    render(row) {
      const bytes = Number(row.traffic_amount) || 0;
      if (bytes === 0) return '-';
      const gb = (bytes / (1024 ** 3)).toFixed(2);
      return bytes > 0 ? gb + ' GB' : gb + ' GB';
    }
  },
  {
    title: '备注',
    key: 'remark',
    width: 100,
    ellipsis: { tooltip: true },
    render(row) {
      return row.remark || '-';
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
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
    width: 120,
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
    width: 160,
    render(row) {
      return formatDateTimeUtc8(row.created_at);
    }
  },
  {
    title: '支付时间',
    key: 'paid_at',
    width: 160,
    render(row) {
      return formatDateTimeUtc8(row.paid_at);
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render(row) {
      const actions = [];
      if (row.status === 'pending') {
        actions.push(
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
        );
      } else if (row.status === 'paid' && row.order_type !== 'unsubscribe') {
        actions.push(
          h(
            NButton,
            {
              size: 'small',
              type: 'warning',
              onClick: () => openUnsubscribeModal()
            },
            { default: () => '退订' }
          )
        );
      }
      return actions.length ? h('div', { style: 'display: flex; gap: 8px;' }, actions) : null;
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

async function openUnsubscribeModal() {
  try {
    const res = await getOrderRemaining();
    remainingInfo.value = res.data || null;
    if (!remainingInfo.value || !remainingInfo.value.can_unsubscribe) {
      message.warning('您当前没有可退订的套餐');
      return;
    }
    unsubForm.value = {
      duration_days_deduct: 0,
      traffic_gb_deduct: 0,
      remark: '',
      refund_type: 'partial'
    };
    showUnsubscribeModal.value = true;
  } catch (e) {
    message.error(e.message || '获取剩余信息失败');
  }
}

// 监听退订方式，全额退订时自动填入剩余天数和流量
watch(() => unsubForm.value.refund_type, (type) => {
  if (type === 'full' && remainingInfo.value) {
    unsubForm.value.duration_days_deduct = remainingInfo.value.remaining_days || 0;
    unsubForm.value.traffic_gb_deduct = parseFloat(remainingInfo.value.remaining_traffic_gb || 0);
  } else if (type === 'partial') {
    unsubForm.value.duration_days_deduct = 0;
    unsubForm.value.traffic_gb_deduct = 0;
  }
});

async function submitUnsubscribe() {
  const d = Number(unsubForm.value.duration_days_deduct) || 0;
  const g = Number(unsubForm.value.traffic_gb_deduct) || 0;
  const isFullRefund = unsubForm.value.refund_type === 'full';
  if (!isFullRefund && d <= 0 && g <= 0) {
    message.warning('请填写扣减天数或扣减流量至少一项，或选择全额退订');
    return;
  }
  unsubLoading.value = true;
  try {
    const res = await unsubscribeOrder({
      duration_days_deduct: d,
      traffic_gb_deduct: g,
      remark: (unsubForm.value.remark || '').trim(),
      full_refund: isFullRefund
    });
    message.success(res.data?.removed_from_plan ? '全额退订已生效，套餐已失效' : '退订已生效');
    showUnsubscribeModal.value = false;
    await fetchOrders();
  } catch (e) {
    message.error(e.response?.data?.message || e.message || '退订失败');
  } finally {
    unsubLoading.value = false;
  }
}

onMounted(fetchOrders);
</script>

