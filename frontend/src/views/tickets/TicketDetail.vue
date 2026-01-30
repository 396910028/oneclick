<template>
  <n-card :title="`工单详情：${ticket?.ticket_no || ''}`">
    <n-spin :show="loading">
      <div v-if="ticket">
        <n-descriptions bordered :column="1" label-placement="top">
          <n-descriptions-item label="标题">
            {{ ticket.title }}
          </n-descriptions-item>
          <n-descriptions-item label="分类">
            {{ ticket.category }}
          </n-descriptions-item>
          <n-descriptions-item label="状态">
            {{ ticket.status }}
          </n-descriptions-item>
          <n-descriptions-item label="优先级">
            {{ ticket.priority }}
          </n-descriptions-item>
          <n-descriptions-item label="内容">
            {{ ticket.content }}
          </n-descriptions-item>
        </n-descriptions>

        <n-card title="回复记录" size="small" style="margin-top: 16px;">
          <div v-if="replies.length === 0">暂无回复</div>
            <n-timeline v-else>
              <n-timeline-item
                v-for="reply in replies"
                :key="reply.id"
                :type="reply.is_admin ? 'success' : 'default'"
                :title="reply.is_admin ? '客服回复' : '用户回复'"
                :time="reply.created_at_text"
              >
                {{ reply.content }}
              </n-timeline-item>
            </n-timeline>
        </n-card>

        <n-card title="添加回复" size="small" style="margin-top: 16px;">
          <n-input
            v-model:value="replyContent"
            type="textarea"
            :rows="4"
            placeholder="请输入回复内容"
          />
          <div v-if="isAdmin" style="margin-top: 12px;">
            <n-radio-group v-model:value="replyStatus">
              <n-space>
                <n-radio value="resolved">已解决</n-radio>
                <n-radio value="open">待用户补充</n-radio>
              </n-space>
            </n-radio-group>
          </div>
          <n-space justify="end" style="margin-top: 12px;">
            <n-button type="primary" :loading="replyLoading" @click="handleReply">
              提交回复
            </n-button>
          </n-space>
        </n-card>
      </div>
    </n-spin>
  </n-card>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import {
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NSpin,
  NInput,
  NSpace,
  NButton,
  NTimeline,
  NTimelineItem,
  NRadioGroup,
  NRadio,
  useMessage
} from 'naive-ui';
import { getTicketDetail, replyTicket } from '@/api/tickets';
import { postAdminTicketReply } from '@/api/admin';
import { useUserStore } from '@/store/user';
import { formatDateTimeUtc8 } from '@/utils/datetime';

const route = useRoute();
const message = useMessage();

const ticket = ref(null);
const replies = ref([]);
const loading = ref(false);
const replyContent = ref('');
const replyLoading = ref(false);
const replyStatus = ref('');

const userStore = useUserStore();
const isAdmin = computed(() => userStore.user?.role === 'admin');

async function fetchDetail() {
  loading.value = true;
  try {
    const res = await getTicketDetail(route.params.id);
    ticket.value = res.data.ticket;
    const rawReplies = res.data.replies || [];
    replies.value = rawReplies.map((r) => ({
      ...r,
      created_at_text: formatDateTimeUtc8(r.created_at)
    }));
  } catch (err) {
    message.error(err.message || '获取工单详情失败');
  } finally {
    loading.value = false;
  }
}

async function handleReply() {
  // 普通用户不能在已解决的工单中回复
  if (!isAdmin.value && ticket.value.status === 'resolved') {
    message.warning('该工单已完结，如有问题请重新发起工单');
    return;
  }
  if (!replyContent.value.trim()) {
    message.warning('请输入回复内容');
    return;
  }
  // 管理员需要选择处理结果
  if (isAdmin.value && !replyStatus.value) {
    message.warning('请选择处理结果（已解决 或 待用户补充）');
    return;
  }
  replyLoading.value = true;
  try {
    if (isAdmin.value) {
      await postAdminTicketReply(route.params.id, {
        content: replyContent.value,
        // 前端选项映射为后端使用的状态：已解决 -> resolved，待用户补充 -> open
        status: replyStatus.value
      });
    } else {
      await replyTicket(route.params.id, { content: replyContent.value });
    }
    message.success('回复成功');
    replyContent.value = '';
    replyStatus.value = '';
    await fetchDetail();
  } catch (err) {
    message.error(err.message || '回复失败');
  } finally {
    replyLoading.value = false;
  }
}

onMounted(fetchDetail);
</script>

