import http from './http';

export function getTickets(params) {
  return http.get('/tickets', { params });
}

export function createTicket(payload) {
  return http.post('/tickets', payload);
}

export function getTicketDetail(id) {
  return http.get(`/tickets/${id}`);
}

export function replyTicket(id, payload) {
  return http.post(`/tickets/${id}/reply`, payload);
}

