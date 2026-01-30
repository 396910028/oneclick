<template>
  <n-space vertical size="large">
    <n-grid :cols="appStore.gridCols" :x-gap="16" :y-gap="16">
      <n-gi>
        <n-card>
          <div class="stat-title">当前套餐</div>
          <div class="stat-value">
            {{ currentPlanText }}
          </div>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card>
          <div class="stat-title">到期时间</div>
          <div class="stat-value">
            {{ expireText }}
          </div>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card>
          <div class="stat-title">剩余流量</div>
          <div class="stat-value">{{ trafficText }}</div>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card title="每日签到">
      <n-space vertical :size="8">
        <n-text depth="3" style="font-size: 13px;">
          每日按 UTC+8 计算 0 点重置签到，每天随机获得 0-100MB 流量。
        </n-text>
        <div style="display: flex; align-items: center; gap: 12px;">
          <n-button
            type="primary"
            :disabled="hasSignedToday"
            :loading="signinLoading"
            @click="handleSignin"
          >
            {{
              hasSignedToday && countdownText
                ? `距下次签到 ${countdownText}`
                : hasSignedToday
                  ? '今日已签到'
                  : '立即签到'
            }}
          </n-button>
          <n-text v-if="hasSignedToday && todayBonusMB !== null" depth="2" style="font-size: 13px;">
            今日获得 {{ todayBonusMB }} MB 流量
            <span v-if="signinStreak > 1">（已连续签到 {{ signinStreak }} 天）</span>
          </n-text>
        </div>
      </n-space>
    </n-card>

    <n-card title="订阅链接" v-if="subscriptionToken">
      <n-space vertical :size="12">
        <n-alert type="info" :show-icon="false">
          <div style="font-size: 12px;">
            复制订阅链接到客户端（Clash、V2RayN、sing-box 等）即可导入节点配置。
          </div>
        </n-alert>
        <div style="display: flex; align-items: center; gap: 8px;">
          <n-text strong style="min-width: 80px;">Clash：</n-text>
          <n-input
            :value="getSubscriptionUrl('clash')"
            readonly
            style="flex: 1;"
          />
          <n-button size="small" @click="copyToClipboard(getSubscriptionUrl('clash'))">
            复制
          </n-button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <n-text strong style="min-width: 80px;">V2Ray：</n-text>
          <n-input
            :value="getSubscriptionUrl('v2ray')"
            readonly
            style="flex: 1;"
          />
          <n-button size="small" @click="copyToClipboard(getSubscriptionUrl('v2ray'))">
            复制
          </n-button>
        </div>
        <n-text depth="3" style="font-size: 12px;">
          更多客户端格式（sing-box、Surge、Quantumult）请前往「个人中心」查看
        </n-text>
      </n-space>
    </n-card>

    <n-card title="流量使用统计">
      <n-space vertical :size="12">
        <n-space align="center" :size="12">
          <n-text depth="3" style="font-size: 13px;">时间范围：</n-text>
          <n-radio-group v-model:value="trafficRangeMinutes" size="small" @update:value="fetchTrafficHistory">
            <n-radio-button :value="60">最近 60 分钟</n-radio-button>
            <n-radio-button :value="1440">最近 24 小时</n-radio-button>
          </n-radio-group>
          <n-text depth="3" style="font-size: 12px;">（每 1 分钟自动更新一次）</n-text>
        </n-space>
        <div v-if="trafficPoints.length === 0" style="height: 120px; display: flex; align-items: center; justify-content: center;">
          <n-text depth="3">暂无流量数据</n-text>
        </div>
        <div v-else>
          <div class="traffic-summary">
            <span>总上传：{{ totalUploadText }}</span>
            <span>总下载：{{ totalDownloadText }}</span>
          </div>
          <div class="traffic-table-wrapper">
            <table class="traffic-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>上传</th>
                  <th>下载</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in trafficPoints" :key="p.ts">
                  <td>{{ p.timeLabel }}</td>
                  <td>{{ p.uploadText }}</td>
                  <td>{{ p.downloadText }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onActivated } from 'vue';
import { useRoute } from 'vue-router';
import {
  NSpace,
  NGrid,
  NGi,
  NCard,
  NText,
  NInput,
  NButton,
  NAlert,
  NRadioGroup,
  NRadioButton,
  useMessage
} from 'naive-ui';
import { useAppStore } from '@/store/app';
import { getCurrentOrder } from '@/api/orders';
import { getSubscriptionToken } from '@/api/subscription';
import { getUserInfo, signinDaily } from '@/api/user';
import { getTrafficHistory } from '@/api/traffic';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const message = useMessage();
const appStore = useAppStore();
const route = useRoute();

const currentOrder = ref(null);
const subscriptionToken = ref('');
const userInfo = ref(null);
const hasSignedToday = ref(false);
const signinLoading = ref(false);
const todayBonusMB = ref(null);
const signinStreak = ref(0);
const countdownText = ref('');
let countdownTimer = null;

// 流量图表相关
const trafficRangeMinutes = ref(1440); // 默认最近 24 小时
const trafficPoints = ref([]);
let trafficTimer = null;

const currentPlanText = computed(() => {
  if (!currentOrder.value) {
    return '暂无已生效套餐';
  }
  // 只展示套餐名称，不再区分月付/季付/年付，避免视觉上“降级/切换”的混淆
  return currentOrder.value.plan_name || '已生效套餐';
});

const expireText = computed(() => {
  if (!currentOrder.value || !currentOrder.value.expire_at) return '-';
  try {
    const raw = currentOrder.value.expire_at;
    return formatDateTimeUtc8(raw);
  } catch (e) {
    console.error('格式化到期时间失败:', e);
    return '-';
  }
});

const trafficText = computed(() => {
  if (!userInfo.value) return '-';
  const total = Number(userInfo.value.traffic_total || 0);
  const used = Math.max(0, Number(userInfo.value.traffic_used || 0));
  const usedGB = (used / 1073741824).toFixed(2);

  // 不再使用“无限”文案：total <= 0 统一视为当前没有可用流量配额
  if (!Number.isFinite(total) || total <= 0) {
    return `0GB（未分配流量，已用 ${usedGB}GB）`;
  }

  const remaining = Math.max(0, total - used);
  const totalGB = (total / 1073741824).toFixed(2);
  const remainingGB = (remaining / 1073741824).toFixed(2);
  const percent = Math.min(100, (used / total) * 100).toFixed(1);
  return `${remainingGB}GB / ${totalGB}GB (已用 ${percent}%)`;
});

function getSubscriptionUrl(format) {
  if (!subscriptionToken.value) return '';
  const baseUrl = window.location.origin;
  return `${baseUrl}/api/sub/${subscriptionToken.value}?format=${format}`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    message.success('已复制到剪贴板');
  }).catch(() => {
    message.error('复制失败，请手动复制');
  });
}

function isTodaySignedUtc8(lastSigninAt) {
  if (!lastSigninAt) return false;
  const toUtc8Date = (d) => {
    const date = d instanceof Date ? d : new Date(d);
    const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().slice(0, 10);
  };
  const todayUtc8 = toUtc8Date(new Date());
  const lastUtc8 = toUtc8Date(lastSigninAt);
  return todayUtc8 === lastUtc8;
}

// 计算距离「北京时间次日 00:00:00」的毫秒数（用于倒计时与何时允许再次签到）
function computeRemainingMsToNextUtc8Midnight() {
  const nowMs = Date.now();
  const utc8OffsetMs = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  // 当前时刻在「以北京时间 0 点为基准」的刻度上的毫秒数
  const utc8NowMs = nowMs + utc8OffsetMs;
  // 下一个北京时间 0 点对应的 UTC 时间戳
  const nextMidnightUtc8Ms =
    (Math.floor(utc8NowMs / dayMs) + 1) * dayMs - utc8OffsetMs;
  const diff = nextMidnightUtc8Ms - nowMs;
  return diff > 0 ? diff : 0;
}

function formatMsToHMS(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function startSigninCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const update = () => {
    const remaining = computeRemainingMsToNextUtc8Midnight();
    if (remaining <= 0) {
      countdownText.value = '';
      hasSignedToday.value = false;
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    } else {
      countdownText.value = formatMsToHMS(remaining);
    }
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

async function fetchCurrentPlan() {
  try {
    const res = await getCurrentOrder();
    currentOrder.value = res.data.current || null;
  } catch (e) {
    // 总览非关键接口，失败时保持默认文案即可
    currentOrder.value = null;
  }
}

async function fetchSubscriptionToken() {
  try {
    const res = await getSubscriptionToken();
    subscriptionToken.value = res.data.token;
  } catch (e) {
    // 订阅 token 获取失败不影响总览页展示
    console.error('获取订阅 token 失败:', e);
  }
}

async function fetchUserInfo() {
  try {
    const res = await getUserInfo();
    userInfo.value = res.data || {};
    hasSignedToday.value = isTodaySignedUtc8(res.data?.last_signin_at);
    signinStreak.value = Number(res.data?.signin_streak || 0);
    if (hasSignedToday.value) {
      startSigninCountdown();
    }
  } catch (e) {
    console.error('获取用户信息失败:', e);
    // 确保 userInfo 有默认值，避免 computed 属性出错
    userInfo.value = userInfo.value || {};
  }
}

function formatBytesToHuman(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (n >= gb) return `${(n / gb).toFixed(2)} GB`;
  if (n >= mb) return `${(n / mb).toFixed(2)} MB`;
  if (n >= kb) return `${(n / kb).toFixed(2)} KB`;
  return `${n} B`;
}

async function fetchTrafficHistory() {
  try {
    const range = Number(trafficRangeMinutes.value || 1440);
    const res = await getTrafficHistory(range);
    const points = res.data.points || [];
    trafficPoints.value = points.map((p) => {
      const ts = new Date(p.ts);
      const timeLabel = `${ts.getHours().toString().padStart(2, '0')}:${ts
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
      return {
        ts: p.ts,
        upload: p.upload,
        download: p.download,
        timeLabel,
        uploadText: formatBytesToHuman(p.upload),
        downloadText: formatBytesToHuman(p.download)
      };
    });
  } catch (e) {
    console.error('获取流量历史失败:', e);
  }
}

const totalUploadText = computed(() => {
  const sum = trafficPoints.value.reduce((acc, p) => acc + Number(p.upload || 0), 0);
  return formatBytesToHuman(sum);
});

const totalDownloadText = computed(() => {
  const sum = trafficPoints.value.reduce((acc, p) => acc + Number(p.download || 0), 0);
  return formatBytesToHuman(sum);
});

function startTrafficAutoRefresh() {
  if (trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
  const tick = () => {
    fetchTrafficHistory();
  };
  tick();
  trafficTimer = setInterval(tick, 60 * 1000);
}

async function handleSignin() {
  if (hasSignedToday.value) return;
  signinLoading.value = true;
  try {
    const res = await signinDaily();
    const { data = {}, message: apiMessage } = res;
    hasSignedToday.value = !!data.todaySigned;
    signinStreak.value = Number(data.signinStreak || signinStreak.value || 0);
    const bonusBytes = Number(data.bonusTraffic || 0);
    todayBonusMB.value = (bonusBytes / (1024 * 1024)).toFixed(2);

    if (userInfo.value) {
      userInfo.value.traffic_total = Number(userInfo.value.traffic_total || 0) + bonusBytes;
      userInfo.value.last_signin_at = new Date().toISOString();
      userInfo.value.signin_streak = signinStreak.value;
    }

    message.success(apiMessage || '签到成功');
    startSigninCountdown();
  } catch (e) {
    message.error(e?.message || '签到失败，请稍后再试');
  } finally {
    signinLoading.value = false;
  }
}

async function loadDashboardData() {
  try {
    await Promise.allSettled([
      fetchCurrentPlan(),
      fetchSubscriptionToken(),
      fetchUserInfo(),
      fetchTrafficHistory()
    ]);
  } catch (e) {
    console.error('Dashboard 数据加载失败:', e);
    // 即使失败也确保组件能渲染
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    // 从其他标签或最小化恢复时刷新用户信息，避免「过了一天仍显示今日已签到」
    fetchUserInfo();
  }
}

onMounted(() => {
  loadDashboardData();
  startTrafficAutoRefresh();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

// 如果使用了 keep-alive，组件激活时重新加载数据
onActivated(() => {
  loadDashboardData();
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
});
</script>

<style scoped>
.stat-title {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
}

.stat-value {
  margin-top: 8px;
  font-size: 20px;
  font-weight: bold;
}

.traffic-summary {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  flex-wrap: wrap;
}

.traffic-table-wrapper {
  max-height: 220px;
  overflow: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.traffic-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.traffic-table th,
.traffic-table td {
  padding: 4px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.traffic-table th {
  text-align: left;
  background: rgba(255, 255, 255, 0.03);
}

.traffic-table tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}
</style>

