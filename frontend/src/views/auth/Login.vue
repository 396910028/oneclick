<template>
  <div class="auth-page">
    <n-card class="auth-card" title="登录">
      <n-form :model="form" :rules="rules" ref="formRef">
        <n-form-item label="用户名或邮箱" path="username">
          <n-input v-model:value="form.username" placeholder="请输入用户名或邮箱" />
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
            登录
          </n-button>
        </n-form-item>
        <n-form-item>
          <n-button text block @click="goRegister">没有账号？前往注册</n-button>
        </n-form-item>
      </n-form>
    </n-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, useMessage } from 'naive-ui';
import { login } from '@/api/auth';
import { useUserStore } from '@/store/user';

const router = useRouter();
const route = useRoute();
const message = useMessage();
const userStore = useUserStore();

const formRef = ref(null);
const loading = ref(false);

const form = ref({
  username: '',
  password: ''
});

const rules = {
  username: {
    required: true,
    message: '请输入用户名或邮箱',
    trigger: 'blur'
  },
  password: {
    required: true,
    message: '请输入密码',
    trigger: 'blur'
  }
};

function goRegister() {
  router.push('/auth/register');
}

function handleSubmit() {
  formRef.value?.validate(async (errors) => {
    if (errors) return;
    loading.value = true;
    try {
      const res = await login(form.value);
      userStore.setAuth(res.data.token, res.data.user);
      message.success('登录成功');
      const redirect = route.query.redirect || '/dashboard';
      router.push(redirect);
    } catch (err) {
      // 避免把后端/数据库等内部错误细节暴露到前端
      message.error('登录失败，请检查用户名/邮箱和密码');
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

