import http from './http';

// 用户管理
export function getAdminUsers(params) {
  return http.get('/admin/users', { params });
}
export function patchAdminUser(id, data) {
  return http.patch(`/admin/users/${id}`, data);
}
export function deleteAdminUser(id) {
  return http.delete(`/admin/users/${id}`);
}
export function getAdminUserDetail(id) {
  return http.get(`/admin/users/${id}`);
}
export function getAdminUserRemaining(id, params) {
  return http.get(`/admin/users/${id}/remaining`, { params });
}
export function postAdminUserUnsubscribe(userId, data) {
  return http.post(`/admin/users/${userId}/unsubscribe`, data);
}

// 总套餐管理
export function getAdminPlanGroups() {
  return http.get('/admin/plan-groups');
}
export function postAdminPlanGroup(data) {
  return http.post('/admin/plan-groups', data);
}
export function putAdminPlanGroup(id, data) {
  return http.put(`/admin/plan-groups/${id}`, data);
}
export function deleteAdminPlanGroup(id) {
  return http.delete(`/admin/plan-groups/${id}`);
}

// 子套餐管理
export function getAdminPlans() {
  return http.get('/admin/plans');
}
export function postAdminPlan(data) {
  return http.post('/admin/plans', data);
}
export function putAdminPlan(id, data) {
  return http.put(`/admin/plans/${id}`, data);
}
export function deleteAdminPlan(id) {
  return http.delete(`/admin/plans/${id}`);
}

// 订单管理
export function getAdminOrders(params) {
  return http.get('/admin/orders', { params });
}

export function postAdminOrderForcePay(id) {
  return http.post(`/admin/orders/${id}/force-pay`);
}

export function postAdminOrderForceCancel(id) {
  return http.post(`/admin/orders/${id}/force-cancel`);
}

// 工单管理
export function getAdminTickets(params) {
  return http.get('/admin/tickets', { params });
}
export function patchAdminTicket(id, data) {
  return http.patch(`/admin/tickets/${id}`, data);
}
export function postAdminTicketReply(id, data) {
  return http.post(`/admin/tickets/${id}/reply`, data);
}
export function deleteAdminTicket(id) {
  return http.delete(`/admin/tickets/${id}`);
}

// 节点管理
export function getAdminNodes() {
  return http.get('/admin/nodes');
}

export function postAdminNode(data) {
  return http.post('/admin/nodes', data);
}

export function putAdminNode(id, data) {
  return http.put(`/admin/nodes/${id}`, data);
}

export function deleteAdminNode(id) {
  return http.delete(`/admin/nodes/${id}`);
}

// node-agent（一键绑定节点）
export function postAdminNodeAgentImport(data) {
  return http.post('/admin/node-agent/import', data);
}

// 面板设置：INTERNAL_API_KEY
export function getAdminInternalApiKey() {
  return http.get('/admin/settings/internal-api-key');
}
export function postAdminInternalApiKey(data) {
  return http.post('/admin/settings/internal-api-key', data);
}

// 面板设置：面板网址
export function getAdminPanelSettings() {
  return http.get('/admin/settings/panel');
}
export function putAdminPanelSettings(data) {
  return http.put('/admin/settings/panel', data);
}

export function updateAdminInternalApiKey(value) {
  return http.post('/admin/settings/internal-api-key', { value });
}
