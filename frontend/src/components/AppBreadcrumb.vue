<template>
  <div class="breadcrumb-wrapper">
    <n-breadcrumb>
      <n-breadcrumb-item v-for="item in items" :key="item.path">
        {{ item.title }}
      </n-breadcrumb-item>
    </n-breadcrumb>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui';

const route = useRoute();

const items = computed(() => {
  const matched = route.matched.filter((r) => r.meta && r.meta.title);
  return matched.map((r) => ({
    path: r.path,
    title: r.meta.title
  }));
});
</script>

<style scoped>
.breadcrumb-wrapper {
  padding: 8px 0;
}
</style>

