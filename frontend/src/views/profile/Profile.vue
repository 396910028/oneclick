<template>
  <n-space vertical :size="16">
    <n-card title="个人中心">
      <n-descriptions label-placement="top" :column="2">
        <n-descriptions-item label="用户名">
          {{ userStore.user?.username || '-' }}
        </n-descriptions-item>
        <n-descriptions-item label="邮箱">
          {{ userStore.user?.email || '-' }}
        </n-descriptions-item>
        <n-descriptions-item label="角色">
          {{
            userStore.user?.role === 'admin'
              ? '管理员'
              : userStore.user?.role === 'user'
                ? '普通用户'
                : userStore.user?.role || '-'
          }}
        </n-descriptions-item>
      </n-descriptions>
    </n-card>

    <n-card title="订阅链接">
      <n-space vertical :size="12">
        <n-alert type="info" :show-icon="false">
          <div style="font-size: 12px;">
            订阅链接用于在客户端（Clash、V2RayN、sing-box 等）中导入节点配置。请妥善保管，不要泄露给他人。
          </div>
        </n-alert>

        <n-space vertical :size="8" v-if="subscriptionToken">
          <div v-for="format in subscriptionFormats" :key="format.value" style="display: flex; align-items: center; gap: 8px;">
            <n-text strong style="min-width: 100px;">{{ format.label }}：</n-text>
            <n-input
              :value="getSubscriptionUrl(format.value)"
              readonly
              style="flex: 1;"
            />
            <n-button size="small" @click="copyToClipboard(getSubscriptionUrl(format.value))">
              复制
            </n-button>
          </div>
        </n-space>

        <n-space v-if="!subscriptionToken && !loading">
          <n-button type="primary" @click="fetchToken">生成订阅链接</n-button>
        </n-space>

        <n-space v-if="subscriptionToken">
          <n-popconfirm
            :on-positive-click="handleResetToken"
            positive-text="确定"
            negative-text="取消"
          >
            <template #trigger>
              <n-button type="warning" size="small">重置订阅链接</n-button>
            </template>
            重置后旧链接将失效，确定要继续吗？
          </n-popconfirm>
        </n-space>
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import {
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NSpace,
  NAlert,
  NText,
  NInput,
  NButton,
  NPopconfirm,
  useMessage
} from 'naive-ui';
import { useUserStore } from '@/store/user';
import { getSubscriptionToken, resetSubscriptionToken } from '@/api/subscription';

const message = useMessage();
const userStore = useUserStore();
const subscriptionToken = ref('');
const loading = ref(false);

const subscriptionFormats = [
  { label: 'Clash', value: 'clash', desc: 'Clash for Windows、ClashX、Clash Verge' },
  { label: 'V2Ray', value: 'v2ray', desc: 'V2RayN、V2RayNG' },
  { label: 'sing-box', value: 'sing-box', desc: 'sing-box 客户端' },
  { label: 'Surge', value: 'surge', desc: 'Surge for iOS/Mac' },
  { label: 'Quantumult', value: 'quantumult', desc: 'Quantumult X' }
];

function getSubscriptionUrl(format) {
  if (!subscriptionToken.value) return '';
  const baseUrl = window.location.origin;
  return `${baseUrl}/api/sub/${subscriptionToken.value}?format=${format}`;
}

async function fetchToken() {
  loading.value = true;
  try {
    const res = await getSubscriptionToken();
    subscriptionToken.value = res.data.token;
    message.success('订阅链接已生成');
  } catch (e) {
    message.error(e.message || '获取订阅链接失败');
  } finally {
    loading.value = false;
  }
}

async function handleResetToken() {
  try {
    const res = await resetSubscriptionToken();
    subscriptionToken.value = res.data.token;
    message.success('订阅链接已重置');
  } catch (e) {
    message.error(e.message || '重置失败');
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    message.success('已复制到剪贴板');
  }).catch(() => {
    message.error('复制失败，请手动复制');
  });
}

onMounted(() => {
  fetchToken();
});
</script>

