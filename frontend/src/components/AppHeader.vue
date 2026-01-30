<template>
  <div class="app-header">
    <div class="left">
      <n-button
        v-if="appStore.isMobile"
        quaternary
        circle
        class="menu-btn"
        @click="appStore.toggleDrawer()"
      >
        <span class="menu-icon" aria-label="打开菜单">≡</span>
      </n-button>
      <n-text v-else depth="3" class="title-text">IP 代理面板</n-text>
    </div>
    <div class="right">
      <n-space align="center" :size="appStore.isMobile ? 8 : 16" wrap>
        <n-text v-if="!appStore.isMobile" depth="3">余额：¥0.00</n-text>
        <n-dropdown :options="options" @select="handleSelect">
          <n-button text class="username-btn">
            {{ userStore.user?.username || '未登录' }}
          </n-button>
        </n-dropdown>
        <n-tag :type="roleTagType" size="small" :bordered="false">{{ roleLabel }}</n-tag>
      </n-space>
      <n-button type="error" quaternary size="small" class="logout-btn" @click="logout">
        退出
      </n-button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { NText, NSpace, NDropdown, NButton, NTag } from 'naive-ui';
import { useUserStore } from '@/store/user';
import { useAppStore } from '@/store/app';

const router = useRouter();
const userStore = useUserStore();
const appStore = useAppStore();

const roleLabel = computed(() =>
  userStore.user?.role === 'admin' ? '管理员' : '用户'
);
const roleTagType = computed(() =>
  userStore.user?.role === 'admin' ? 'warning' : 'default'
);

const options = [
  { label: '个人中心', key: 'profile' },
  { label: '退出登录', key: 'logout' }
];

function logout() {
  userStore.logout();
  router.push('/auth/login');
}

function handleSelect(key) {
  if (key === 'logout') {
    logout();
  } else if (key === 'profile') {
    router.push('/profile');
  }
}
</script>

<style scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px;
  width: 100%;
  flex-wrap: wrap;
  gap: 8px;
}

.left {
  display: flex;
  align-items: center;
  min-width: 0;
}

.menu-btn {
  flex-shrink: 0;
}

.menu-icon {
  font-size: 1.4rem;
  line-height: 1;
  font-weight: 700;
}

.title-text {
  white-space: nowrap;
}

.right {
  display: flex;
  align-items: center;
  margin-left: auto;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px;
}

.username-btn {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  margin-left: 8px;
}

@media (max-width: 991px) {
  .header :deep(.n-space) {
    flex-wrap: wrap;
  }
  .logout-btn {
    margin-left: 4px;
  }
}

@media (max-width: 480px) {
  .username-btn {
    max-width: 80px;
  }
}
</style>

