<template>
  <n-space vertical :size="16">
    <n-card title="面板管理">
      <n-alert type="info" :show-icon="false" style="margin-bottom: 16px;">
        <div style="font-size: 12px;">
          面板设置将用于用户详情、个人中心、总览中的「分享/订阅 URL」展示，以及前端页面展示。
        </div>
      </n-alert>
      <n-form ref="formRef" :model="form" label-placement="left" label-width="120px" style="max-width: 600px;">
        <n-form-item label="网站地址" path="panel_public_url">
          <n-input
            v-model:value="form.panel_public_url"
            placeholder="例如 https://panel.example.com（用于分享/订阅链接）"
            clearable
          />
        </n-form-item>
        <n-form-item label="网站名称" path="site_name">
          <n-input
            v-model:value="form.site_name"
            placeholder="例如 我的代理服务"
            clearable
          />
        </n-form-item>
        <n-form-item label="网站公告" path="announcement">
          <n-input
            v-model:value="form.announcement"
            type="textarea"
            placeholder="网站公告内容（可选）"
            :rows="3"
            clearable
          />
        </n-form-item>
        <n-form-item label="客服链接" path="support_url">
          <n-input
            v-model:value="form.support_url"
            placeholder="例如 https://t.me/support（可选）"
            clearable
          />
        </n-form-item>
        <n-form-item label="注册开关" path="allow_register">
          <n-switch v-model:value="form.allow_register" />
          <span style="margin-left: 8px; color: var(--n-text-color-3); font-size: 12px;">允许新用户注册</span>
        </n-form-item>
        <n-form-item>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </n-form-item>
      </n-form>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { NCard, NSpace, NForm, NFormItem, NInput, NButton, NAlert, NSwitch, useMessage } from 'naive-ui';
import { getAdminPanelSettings, putAdminPanelSettings } from '@/api/admin';

const message = useMessage();
const formRef = ref(null);
const form = ref({
  panel_public_url: '',
  site_name: '',
  announcement: '',
  support_url: '',
  allow_register: true
});
const saving = ref(false);

async function fetchSettings() {
  try {
    const res = await getAdminPanelSettings();
    const data = res.data || {};
    form.value = {
      panel_public_url: data.panel_public_url ?? '',
      site_name: data.site_name ?? '',
      announcement: data.announcement ?? '',
      support_url: data.support_url ?? '',
      allow_register: data.allow_register !== undefined ? data.allow_register : true
    };
  } catch (e) {
    message.error(e.message || '获取设置失败');
  }
}

async function save() {
  saving.value = true;
  try {
    await putAdminPanelSettings(form.value);
    message.success('已保存');
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(fetchSettings);
</script>
