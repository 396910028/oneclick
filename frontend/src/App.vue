<template>
  <n-config-provider :theme="darkTheme">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui';

const components = {
  'n-config-provider': NConfigProvider,
  'n-message-provider': NMessageProvider,
  'n-dialog-provider': NDialogProvider
};
</script>

