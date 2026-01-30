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

// 按当前有效权益计算套餐升级（预览）
export function getUpgradePreviewByEntitlement(entitlementId, newPlanId) {
  return http.get('/orders/upgrade-by-entitlement/preview', {
    params: {
      entitlement_id: entitlementId,
      new_plan_id: newPlanId
    }
  });
}

// 按当前有效权益计算套餐升级（确认，创建补差价订单）
export function confirmUpgradeByEntitlement(entitlementId, newPlanId, payMethod = 'balance') {
  return http.post('/orders/upgrade-by-entitlement/confirm', {
    entitlement_id: entitlementId,
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

