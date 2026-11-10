import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  // base 跟随 vite 的 base（/cm/），保证子路径部署下路由和链接都带前缀
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
    },
    {
      path: '/invite',
      name: 'invite',
      component: () => import('../views/InviteView.vue'),
    },
    {
      path: '/desktop',
      name: 'desktop-home',
      component: () => import('../views/DesktopHomeView.vue'),
    },
    {
      path: '/meeting/:roomName',
      name: 'meeting',
      component: () => import('../views/MeetingView.vue'),
      // 通用邀请页回落到 Web 入会时，会把主题放在 query 中供会议页展示。
      props: (route) => ({
        roomName: route.params.roomName,
        subject: typeof route.query.subject === 'string' ? route.query.subject : '',
      }),
    },
    {
      // 桌面壳独立会议窗口专用页：与 Web 会议页完全分离，无返回/会议号/状态标签
      path: '/desktop/meeting/:roomName',
      name: 'desktop-meeting',
      component: () => import('../views/DesktopMeetingView.vue'),
      props: (route) => ({
        roomName: route.params.roomName,
        subject: typeof route.query.subject === 'string' ? route.query.subject : '',
      }),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

export default router;
