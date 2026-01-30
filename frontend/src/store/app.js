import { defineStore } from 'pinia';

const BREAKPOINT_MD = 992;  // 小于此为平板/手机（侧栏收成抽屉）
const BREAKPOINT_SM = 768;  // 小于此为手机（栅格 1 列）

export const useAppStore = defineStore('app', {
  state: () => ({
    collapsed: false,
    isMobile: false,
    drawerVisible: false,
    gridCols: 3
  }),
  actions: {
    toggleCollapsed() {
      this.collapsed = !this.collapsed;
    },
    setBreakpoint(width) {
      this.isMobile = width < BREAKPOINT_MD;
      this.gridCols = width < BREAKPOINT_SM ? 1 : width < BREAKPOINT_MD ? 2 : 3;
    },
    openDrawer() {
      this.drawerVisible = true;
    },
    closeDrawer() {
      this.drawerVisible = false;
    },
    toggleDrawer() {
      this.drawerVisible = !this.drawerVisible;
    }
  }
});

