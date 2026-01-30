<template>
  <n-card title="新建工单">
    <n-form :model="form" :rules="rules" ref="formRef" label-placement="top">
      <n-form-item label="标题" path="title">
        <n-input v-model:value="form.title" placeholder="请简要描述问题" />
      </n-form-item>
      <n-form-item label="分类" path="category">
        <n-select v-model:value="form.category" :options="categoryOptions" />
      </n-form-item>
      <n-form-item label="优先级" path="priority">
        <n-select v-model:value="form.priority" :options="priorityOptions" />
      </n-form-item>
      <n-form-item label="详细描述" path="content">
        <n-input
          v-model:value="form.content"
          type="textarea"
          :rows="6"
          placeholder="请尽可能详细地描述问题、时间、节点、错误信息等"
        />
      </n-form-item>
      <n-form-item>
        <n-space>
          <n-button type="primary" :loading="loading" @click="handleSubmit">
            提交工单
          </n-button>
          <n-button @click="goBack">返回</n-button>
        </n-space>
      </n-form-item>
    </n-form>
  </n-card>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSpace,
  NButton,
  useMessage
} from 'naive-ui';
import { createTicket } from '@/api/tickets';

const router = useRouter();
const message = useMessage();

const formRef = ref(null);
const loading = ref(false);

const form = ref({
  title: '',
  category: 'technical',
  priority: 'medium',
  content: ''
});

const categoryOptions = [
  { label: '技术问题', value: 'technical' },
  { label: '账单问题', value: 'billing' },
  { label: '账户问题', value: 'account' },
  { label: '其他', value: 'other' }
];

const priorityOptions = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '紧急', value: 'urgent' }
];

const rules = {
  title: {
    required: true,
    message: '请输入标题',
    trigger: 'blur'
  },
  content: {
    required: true,
    message: '请输入工单内容',
    trigger: 'blur'
  }
};

function goBack() {
  router.push('/tickets');
}

function handleSubmit() {
  formRef.value?.validate(async (errors) => {
    if (errors) return;
    loading.value = true;
    try {
      await createTicket(form.value);
      message.success('工单提交成功');
      router.push('/tickets');
    } catch (err) {
      message.error(err.message || '工单提交失败');
    } finally {
      loading.value = false;
    }
  });
}
</script>

