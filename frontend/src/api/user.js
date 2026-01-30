import http from './http';

export function getUserInfo() {
  return http.get('/auth/me');
}

export function signinDaily() {
  return http.post('/auth/signin');
}
