<template>
  <n-menu
    :collapsed="effectiveCollapsed"
    :collapsed-width="64"
    :options="menuOptions"
    :value="activeKey"
    @update:value="handleUpdateValue"
  />
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NMenu } from 'naive-ui';
import { useAppStore } from '@/store/app';
import { useUserStore } from '@/store/user';

const props = defineProps({
  /** 抽屉内使用时传入 false 以始终展开菜单 */
  collapsedOverride: { type: Boolean, default: undefined }
});

const router = useRouter();
const route = useRoute();
const appStore = useAppStore();
const userStore = useUserStore();

const effectiveCollapsed = computed(() =>
  props.collapsedOverride !== undefined ? props.collapsedOverride : appStore.collapsed
);

const baseMenuOptions = [
  { label: '总览', key: '/dashboard' },
  { label: '套餐列表', key: '/plans' },
  { label: '我的订单', key: '/orders' },
  { label: '工单中心', key: '/tickets' },
  { label: '个人中心', key: '/profile' }
];

const adminMenuOptions = [
  { label: '用户管理', key: '/admin/users' },
  { label: '套餐管理', key: '/admin/plans' },
  { label: '订单管理', key: '/admin/orders' },
  { label: '工单管理', key: '/admin/tickets' },
  { label: '节点管理', key: '/admin/nodes' },
  { label: '面板管理', key: '/admin/settings' }
];

const menuOptions = computed(() => {
  const isAdmin = userStore.user?.role === 'admin';
  const base = isAdmin
    ? baseMenuOptions.filter((item) => item.key !== '/tickets')
    : baseMenuOptions;
  return isAdmin ? [...base, ...adminMenuOptions] : base;
});

const activeKey = computed(() => {
  const path = route.path;
  const options = menuOptions.value;
  const match = options.find((item) => path.startsWith(item.key));
  return match ? match.key : '/dashboard';
});

function handleUpdateValue(key) {
  router.push(key);
}
</script>

