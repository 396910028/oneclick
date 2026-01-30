import MainLayout from '@/layouts/MainLayout.vue';
import Login from '@/views/auth/Login.vue';
import Register from '@/views/auth/Register.vue';
import Dashboard from '@/views/dashboard/Dashboard.vue';
import PlansList from '@/views/plans/PlansList.vue';
import OrdersList from '@/views/orders/OrdersList.vue';
import TicketsList from '@/views/tickets/TicketsList.vue';
import TicketDetail from '@/views/tickets/TicketDetail.vue';
import TicketCreate from '@/views/tickets/TicketCreate.vue';
import Profile from '@/views/profile/Profile.vue';
import AdminUsers from '@/views/admin/AdminUsers.vue';
import AdminPlans from '@/views/admin/AdminPlans.vue';
import AdminOrders from '@/views/admin/AdminOrders.vue';
import AdminTickets from '@/views/admin/AdminTickets.vue';
import AdminNodes from '@/views/admin/AdminNodes.vue';
import { useUserStore } from '@/store/user';

const routes = [
  {
    path: '/auth/login',
    name: 'Login',
    component: Login,
    meta: { public: true }
  },
  {
    path: '/auth/register',
    name: 'Register',
    component: Register,
    meta: { public: true }
  },
  {
    path: '/',
    component: MainLayout,
    children: [
      {
        path: '',
        redirect: '/dashboard'
      },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: Dashboard,
        meta: { title: '总览' }
      },
      {
        path: 'plans',
        name: 'Plans',
        component: PlansList,
        meta: { title: '套餐列表' }
      },
      {
        path: 'orders',
        name: 'Orders',
        component: OrdersList,
        meta: { title: '我的订单' }
      },
      {
        path: 'tickets',
        name: 'Tickets',
        component: TicketsList,
        meta: { title: '我的工单' }
      },
      {
        path: 'tickets/new',
        name: 'TicketCreate',
        component: TicketCreate,
        meta: { title: '新建工单' }
      },
      {
        path: 'tickets/:id',
        name: 'TicketDetail',
        component: TicketDetail,
        meta: { title: '工单详情' }
      },
      {
        path: 'profile',
        name: 'Profile',
        component: Profile,
        meta: { title: '个人中心' }
      },
      {
        path: 'admin/users',
        name: 'AdminUsers',
        component: AdminUsers,
        meta: { title: '用户管理', admin: true }
      },
      {
        path: 'admin/plans',
        name: 'AdminPlans',
        component: AdminPlans,
        meta: { title: '套餐管理', admin: true }
      },
      {
        path: 'admin/orders',
        name: 'AdminOrders',
        component: AdminOrders,
        meta: { title: '订单管理', admin: true }
      },
      {
        path: 'admin/tickets',
        name: 'AdminTickets',
        component: AdminTickets,
        meta: { title: '工单管理', admin: true }
      },
      {
        path: 'admin/nodes',
        name: 'AdminNodes',
        component: AdminNodes,
        meta: { title: '节点管理', admin: true }
      }
    ]
  }
];

// 路由守卫在 main.js 中挂载时使用
export function setupRouterGuards(router) {
  router.beforeEach((to, from, next) => {
    const userStore = useUserStore();
    if (to.meta.public) {
      // 已登录访问登录页，直接跳转 dashboard
      if (userStore.isLoggedIn && to.path === '/auth/login') {
        next('/dashboard');
      } else {
        next();
      }
      return;
    }

    if (!userStore.isLoggedIn) {
      next({ path: '/auth/login', query: { redirect: to.fullPath } });
      return;
    }

    // 管理员不使用用户工单中心：
    // - 访问 /tickets（列表）或 /tickets/new 时重定向到后台工单管理
    // - 但允许访问 /tickets/:id 作为管理员查看/回复工单详情
    if (userStore.user?.role === 'admin') {
      if (to.path === '/tickets' || to.path === '/tickets/new') {
        next('/admin/tickets');
        return;
      }
    }

    if (to.meta.admin && userStore.user?.role !== 'admin') {
      next('/dashboard');
      return;
    }

    next();
  });
}

export default routes;

