import http from './http';

export function getOrders(params) {
  return http.get('/orders', { params });
}

export function createOrder(payload) {
  return http.post('/orders', payload);
}

export function getCurrentOrder() {
  return http.get('/orders/current');
}

export function cancelOrder(id) {
  return http.post(`/orders/${id}/cancel`);
}

export function getUpgradePreview(oldOrderId, newPlanId) {
  return http.get(`/orders/${oldOrderId}/upgrade-preview`, {
    params: {
      new_plan_id: newPlanId
    }
  });
}

export function confirmUpgrade(oldOrderId, newPlanId, payMethod = 'balance') {
  return http.post(`/orders/${oldOrderId}/upgrade-confirm`, {
    new_plan_id: newPlanId,
    pay_method: payMethod
  });
}

export function getOrderRemaining(params) {
  return http.get('/orders/current/remaining', { params });
}

export function unsubscribeOrder(data) {
  return http.post('/orders/unsubscribe', data);
}

