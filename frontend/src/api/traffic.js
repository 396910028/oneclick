import http from './http';

export function getTrafficHistory(rangeMinutes = 1440) {
  return http.get('/traffic/history', {
    params: { rangeMinutes }
  });
}

