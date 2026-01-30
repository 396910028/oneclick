import http from './http';

export function getPlans(params) {
  return http.get('/plans', { params });
}

export function getPlanDetail(id) {
  return http.get(`/plans/${id}`);
}

