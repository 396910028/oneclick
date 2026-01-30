<template>
  <div class="auth-page">
    <n-card class="auth-card" title="注册">
      <n-form :model="form" :rules="rules" ref="formRef">
        <n-form-item label="用户名" path="username">
          <n-input v-model:value="form.username" placeholder="请输入用户名" />
        </n-form-item>
        <n-form-item label="邮箱" path="email">
          <n-input v-model:value="form.email" placeholder="请输入邮箱" />
        </n-form-item>
        <n-form-item label="密码" path="password">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
          />
        </n-form-item>
        <n-form-item>
          <n-button type="primary" block :loading="loading" @click="handleSubmit">
            注册
          </n-button>
        </n-form-item>
        <n-form-item>
          <n-button text block @click="goLogin">已有账号？前往登录</n-button>
        </n-form-item>
      </n-form>
    </n-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, useMessage } from 'naive-ui';
import { register } from '@/api/auth';

const router = useRouter();
const message = useMessage();

const formRef = ref(null);
const loading = ref(false);

const form = ref({
  username: '',
  email: '',
  password: ''
});

const rules = {
  username: {
    required: true,
    message: '请输入用户名',
    trigger: 'blur'
  },
  email: {
    required: true,
    type: 'email',
    message: '请输入正确的邮箱',
    trigger: ['blur', 'input']
  },
  password: {
    required: true,
    message: '请输入密码',
    trigger: 'blur'
  }
};

function goLogin() {
  router.push('/auth/login');
}

function handleSubmit() {
  formRef.value?.validate(async (errors) => {
    if (errors) return;
    loading.value = true;
    try {
      await register(form.value);
      message.success('注册成功，请登录');
      router.push('/auth/login');
    } catch (err) {
      // 避免把后端/数据库等内部错误细节暴露到前端
      message.error('注册失败，请稍后再试');
    } finally {
      loading.value = false;
    }
  });
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.auth-card {
  width: 360px;
  max-width: calc(100vw - 24px);
}

@media (max-width: 480px) {
  .auth-page {
    padding: 12px;
    align-items: flex-start;
    padding-top: 24px;
  }
}
</style>

