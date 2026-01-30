<template>
  <n-space vertical :size="16">
    <n-card title="面板管理">
      <n-alert type="info" :show-icon="false" style="margin-bottom: 16px;">
        <div style="font-size: 12px;">
          网站地址将用于用户详情、个人中心、总览中的「分享/订阅 URL」展示，请填写实际访问面板的完整地址（如 https://panel.example.com），勿带末尾斜杠。
        </div>
      </n-alert>
      <n-form ref="formRef" :model="form" label-placement="left" label-width="100px" style="max-width: 520px;">
        <n-form-item label="网站地址" path="panel_public_url">
          <n-input
            v-model:value="form.panel_public_url"
            placeholder="例如 https://panel.example.com（用于分享/订阅链接）"
            clearable
          />
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
import { NCard, NSpace, NForm, NFormItem, NInput, NButton, NAlert, useMessage } from 'naive-ui';
import { getAdminPanelSettings, putAdminPanelSettings } from '@/api/admin';

const message = useMessage();
const formRef = ref(null);
const form = ref({
  panel_public_url: ''
});
const saving = ref(false);

async function fetchSettings() {
  try {
    const res = await getAdminPanelSettings();
    const data = res.data || {};
    form.value = {
      panel_public_url: data.panel_public_url ?? '',
      site_name: ''
    };
  } catch (e) {
    message.error(e.message || '获取设置失败');
  }
}

async function save() {
  saving.value = true;
  try {
    await putAdminPanelSettings({ panel_public_url: form.value.panel_public_url });
    message.success('已保存');
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(fetchSettings);
</script>
