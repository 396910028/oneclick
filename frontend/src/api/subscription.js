import http from './http';

export function getSubscriptionToken() {
  return http.get('/subscription/token');
}

export function resetSubscriptionToken() {
  return http.post('/subscription/reset-token');
}
