<template>
  <n-layout has-sider class="main-layout" :has-sider="!appStore.isMobile">
    <!-- 桌面端侧栏 -->
    <n-layout-sider
      v-if="!appStore.isMobile"
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      :collapsed="appStore.collapsed"
      show-trigger="bar"
      @collapse="appStore.collapsed = true"
      @expand="appStore.collapsed = false"
    >
      <div class="logo">
        <span class="logo-text">IP Panel</span>
      </div>
      <app-sidebar />
    </n-layout-sider>

    <!-- 移动端侧栏抽屉 -->
    <n-drawer
      v-model:show="appStore.drawerVisible"
      :width="280"
      placement="left"
      :trap-focus="false"
      @mask-click="appStore.closeDrawer()"
    >
      <n-drawer-content body-content-style="padding: 0;" closable>
        <template #header>菜单</template>
        <div class="drawer-sidebar">
          <div class="logo">
            <span class="logo-text">IP Panel</span>
          </div>
          <app-sidebar :collapsed-override="false" />
        </div>
      </n-drawer-content>
    </n-drawer>

    <n-layout>
      <n-layout-header bordered class="header">
        <app-header />
      </n-layout-header>
      <n-layout-content class="content">
        <app-breadcrumb />
        <div class="page-container">
          <router-view />
        </div>
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup>
import { onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NDrawer, NDrawerContent } from 'naive-ui';
import { useAppStore } from '@/store/app';
import AppHeader from '@/components/AppHeader.vue';
import AppSidebar from '@/components/AppSidebar.vue';
import AppBreadcrumb from '@/components/AppBreadcrumb.vue';

const route = useRoute();
const appStore = useAppStore();

function updateBreakpoint() {
  appStore.setBreakpoint(window.innerWidth);
}

onMounted(() => {
  updateBreakpoint();
  window.addEventListener('resize', updateBreakpoint);
});
onUnmounted(() => {
  window.removeEventListener('resize', updateBreakpoint);
});

watch(
  () => route.path,
  () => {
    if (appStore.isMobile) appStore.closeDrawer();
  }
);
</script>

<style scoped>
.main-layout {
  height: 100vh;
}

.logo {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.logo-text {
  color: #fff;
}

.header {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.content {
  padding: 16px;
  box-sizing: border-box;
}

.page-container {
  margin-top: 12px;
}

.drawer-sidebar {
  height: 100%;
  overflow-y: auto;
}

.drawer-sidebar .logo {
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

@media (max-width: 991px) {
  .content {
    padding: 12px;
  }
}
</style>

