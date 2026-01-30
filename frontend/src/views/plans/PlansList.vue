<template>
  <n-card title="套餐列表">
    <n-alert
      v-if="isAdmin"
      type="info"
      closable
      style="margin-bottom: 12px;"
    >
      当前为管理员，在本页订购套餐将<strong>免费</strong>，并自动标记为已支付（用于测试 / 运维），不会真实扣费。
    </n-alert>
    <n-space justify="space-between" style="margin-bottom: 16px;">
      <n-input
        v-model:value="keyword"
        placeholder="搜索套餐名称"
        style="max-width: 260px"
        clearable
        @keyup.enter="fetchPlans"
      />
      <n-button @click="fetchPlans">刷新</n-button>
    </n-space>

    <!-- 按总套餐归类展示子套餐 -->
    <template v-for="group in plansGrouped" :key="group.group_id">
      <n-card :title="group.group_name" style="margin-bottom: 16px;">
        <template #header-extra>
          <n-text depth="2" style="font-size: 13px;">{{ group.plans.length }} 个子套餐</n-text>
        </template>
        <n-grid :cols="appStore.gridCols" :x-gap="16" :y-gap="16">
          <n-gi v-for="plan in group.plans" :key="plan.id">
            <n-card :title="plan.name" size="small">
              <div class="plan-desc">{{ plan.description || '暂无描述' }}</div>
              <div class="plan-prices">
                <div>
                  <span class="label">价格：</span>¥{{ plan.price }}
                </div>
                <div>
                  <span class="label">时长：</span>{{ plan.duration_days }} 天
                </div>
              </div>
              <div class="plan-meta">
                <div>流量：{{ formatTraffic(plan.traffic_limit) }}</div>
                <div>限速：{{ plan.speed_limit ? plan.speed_limit + ' Mbps' : '不限速' }}</div>
                <div>设备数：{{ plan.connections }}</div>
              </div>
              <n-space justify="end" style="margin-top: 12px;">
                <n-button type="primary" @click="handleSubscribe(plan)">订阅</n-button>
              </n-space>
            </n-card>
          </n-gi>
        </n-grid>
      </n-card>
    </template>
    <n-empty v-if="!loadingPlans && !plans.length" description="暂无套餐" style="margin: 24px 0;" />

    <n-pagination
      v-model:page="page"
      v-model:page-size="pageSize"
      :page-count="pageCount"
      show-size-picker
      :page-sizes="[6, 12, 24]"
      style="margin-top: 16px; text-align: right;"
      @update:page="fetchPlans"
      @update:page-size="fetchPlans"
    />
  </n-card>

  <!-- 升级确认弹窗 -->
  <n-modal
    v-model:show="showUpgradeModal"
    preset="dialog"
    title="确认升级套餐"
    :mask-closable="false"
    :closable="!upgrading"
  >
    <template v-if="upgradePreview">
      <n-space vertical :size="12">
        <n-text>
          您当前是 <strong>{{ upgradePreview.oldOrder.plan_name }}</strong> 套餐用户
        </n-text>
        <n-text>
          旧套餐残值：<strong>¥{{ upgradePreview.oldRemainingValue }}</strong>
        </n-text>
        <n-text>
          新套餐：<strong>{{ upgradePreview.newPlan.name }}</strong>（{{ upgradePreview.newPlan.duration_days }} 天）
        </n-text>
        <n-text>
          新套餐价格：<strong>¥{{ upgradePreview.newPlan.amount }}</strong>
        </n-text>
        <n-text style="font-size: 16px; color: #18a058;">
          需补金额：<strong>¥{{ upgradePreview.needPay }}</strong>
        </n-text>
      </n-space>
    </template>
    <template #action>
      <n-space>
        <n-button :disabled="upgrading" @click="showUpgradeModal = false">
          取消
        </n-button>
        <n-button type="primary" :loading="upgrading" @click="confirmUpgradeOrder">
          确定升级
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import {
  NCard,
  NSpace,
  NInput,
  NButton,
  NGrid,
  NGi,
  NDropdown,
  NPagination,
  NAlert,
  NModal,
  NText,
  useMessage
} from 'naive-ui';
import { useAppStore } from '@/store/app';
import { useUserStore } from '@/store/user';
import { getPlans } from '@/api/plans';
import { createOrder, getCurrentOrder, getUpgradePreview, confirmUpgrade } from '@/api/orders';

const appStore = useAppStore();
const userStore = useUserStore();

const message = useMessage();

const plans = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(6);
const keyword = ref('');
const loadingPlans = ref(false);
const currentOrder = ref(null);
const upgradePreview = ref(null);
const showUpgradeModal = ref(false);
const upgrading = ref(false);

const pageCount = computed(() => Math.ceil(total.value / pageSize.value) || 1);

// 按总套餐归类：同一 group_id 的子套餐归为一组，顺序与接口一致（总套餐 ID 升序）
const plansGrouped = computed(() => {
  const list = plans.value || [];
  const map = new Map();
  for (const plan of list) {
    const gid = plan.group_id;
    if (!map.has(gid)) {
      map.set(gid, {
        group_id: gid,
        group_name: plan.group_name || `总套餐 #${gid}`,
        level: plan.level,
        plans: []
      });
    }
    map.get(gid).plans.push(plan);
  }
  return Array.from(map.values());
});

const isAdmin = computed(() => userStore.user?.role === 'admin');

function formatTraffic(bytes) {
  if (!bytes || bytes === 0) return '无流量';
  const gb = bytes / (1024 ** 3);
  return gb.toFixed(0) + ' GB';
}

async function fetchPlans() {
  loadingPlans.value = true;
  try {
    const res = await getPlans({
      page: page.value,
      size: pageSize.value,
      keyword: keyword.value
    });
    plans.value = res.data.list || [];
    total.value = res.data.total || 0;
  } catch (err) {
    message.error(err.message || '获取套餐列表失败');
  } finally {
    loadingPlans.value = false;
  }
}

async function fetchCurrentOrder() {
  try {
    const res = await getCurrentOrder();
    currentOrder.value = res.data.current || null;
  } catch (err) {
    // 非关键接口，失败时保持 null
    currentOrder.value = null;
  }
}

async function handleSubscribe(plan) {
  try {
    // 1. 检查是否是升级场景（当前有已支付订单且新套餐等级更高）
    if (currentOrder.value && !isAdmin.value) {
      const currentPlanLevel = Number(currentOrder.value.plan_level || 0);
      const newPlanLevel = Number(plan.level || 0);
      if (newPlanLevel > currentPlanLevel) {
        // 走升级流程
        await handleUpgrade(plan);
        return;
      }
    }

    // 2. 普通下单流程
    const res = await createOrder({
      plan_id: plan.id,
      pay_method: 'balance'
    });
    if (isAdmin.value) {
      message.success(
        `管理员订购成功：订单 ${res.data.order_no} 金额为 0，已自动标记为已支付`
      );
    } else {
      message.success(`订单创建成功：${res.data.order_no}`);
    }
    // 刷新当前订单
    await fetchCurrentOrder();
  } catch (err) {
    message.error(err.message || '创建订单失败');
  }
}

async function handleUpgrade(plan) {
  try {
    // 获取升级预览
    const previewRes = await getUpgradePreview(
      currentOrder.value.id,
      plan.id
    );
    upgradePreview.value = previewRes.data;

    // 如果需补金额为负数，直接报错
    if (upgradePreview.value.needPay < 0) {
      message.error('旧套餐残值超过新套餐价格，请联系客服处理');
      return;
    }

    // 显示升级确认弹窗
    showUpgradeModal.value = true;
  } catch (err) {
    message.error(err.message || '获取升级预览失败');
  }
}

async function confirmUpgradeOrder() {
  if (!upgradePreview.value) return;

  upgrading.value = true;
  try {
    const res = await confirmUpgrade(
      currentOrder.value.id,
      upgradePreview.value.newPlan.id,
      'balance'
    );

    showUpgradeModal.value = false;
    upgradePreview.value = null;

    if (res.data.amount === 0) {
      message.success('升级成功，订单已创建（金额为 0，已自动支付）');
    } else {
      message.success(`升级订单创建成功：${res.data.order_no}，需支付 ¥${res.data.amount}`);
    }

    // 刷新当前订单
    await fetchCurrentOrder();
  } catch (err) {
    message.error(err.message || '确认升级失败');
  } finally {
    upgrading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([fetchPlans(), fetchCurrentOrder()]);
});
</script>

<style scoped>
.plan-desc {
  margin-bottom: 8px;
  min-height: 40px;
}

.plan-prices {
  margin-bottom: 8px;
}

.plan-prices .label {
  color: rgba(255, 255, 255, 0.6);
}

.plan-meta {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}
</style>

