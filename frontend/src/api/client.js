import axios from 'axios'

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT token to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('kifaa_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Redirect to login on 401
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('kifaa_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

export const agentsApi = {
  list: (params) => api.get('/agents', { params }),
  get: (id) => api.get(`/agents/${id}`),
  stats: () => api.get('/agents/stats/dashboard'),
  metrics: (id, metric, hours) => api.get(`/agents/${id}/metrics`, { params: { metric, hours } }),
  services: (id) => api.get(`/agents/${id}/services`),
  software: (id) => api.get(`/agents/${id}/software`),
}

export const sslApi = {
  list: () => api.get('/ssl'),
  createCSR: (data) => api.post('/ssl/csr', data),
  downloadCSR:  (id) => `/api/v1/ssl/csr/${id}/download`,
  downloadKey:  (id) => `/api/v1/ssl/${id}/download-key`,
  downloadCert: (id) => `/api/v1/ssl/${id}/download-cert`,
  uploadCert: (id, file) => {
    const form = new FormData()
    form.append('file', file)
    return api.post(`/ssl/${id}/upload-cert`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  delete: (id) => api.delete(`/ssl/${id}`),
  // Let's Encrypt
  lePreflight:   (domain) => api.get('/ssl/letsencrypt/preflight', { params: { domain } }),
  leRequest:     (data) => api.post('/ssl/letsencrypt/request', data),
  leRenew:       (id)   => api.post(`/ssl/letsencrypt/${id}/renew`),
  leAccount:     ()     => api.get('/ssl/letsencrypt/account'),
  leReloadNginx: ()     => api.post('/ssl/letsencrypt/reload-nginx'),
  setAutoRenew:  (id, enabled) => api.patch(`/ssl/${id}/auto-renew`, { enabled }),
  // Deploy to agent
  deploy: (certId, data) => api.post(`/ssl/${certId}/deploy`, data),
}

export const authApi = {
  login: (username, password) => api.post('/auth/login', { username, password }),
}

export const groupsApi = {
  list: () => api.get('/groups'),
  create: (data) => api.post('/groups', data),
  update: (id, data) => api.put(`/groups/${id}`, data),
  delete: (id) => api.delete(`/groups/${id}`),
  agents: (id) => api.get(`/groups/${id}/agents`),
  setMembers: (id, agentIds) => api.put(`/groups/${id}/members`, { agent_ids: agentIds }),
}

export const storageApi = {
  overview: (groupId) => api.get('/storage/overview', { params: groupId ? { group_id: groupId } : {} }),
  summary: () => api.get('/storage/summary'),
  history: (agentId, mount, hours) => api.get(`/storage/agent/${agentId}/history`, { params: { mount, hours } }),
  getExcludes: (agentId) => api.get(`/storage/agent/${agentId}/excludes`),
  setExclude: (agentId, mountpoint, exclude) =>
    api.post(`/storage/agent/${agentId}/exclude`, { mountpoint, exclude }),
}

export const adApi = {
  getConfig: (agentId) => api.get(`/ad/config/${agentId}`),
  saveConfig: (agentId, data) => api.post(`/ad/config/${agentId}`, data),
  test: (agentId, data) => api.post(`/ad/test/${agentId}`, data),
  testResult: (commandId) => api.get(`/ad/test-result/${commandId}`),
  sync: (agentId) => api.post(`/ad/sync/${agentId}`),
  syncStatus: (agentId) => api.get(`/ad/sync-status/${agentId}`),
  users: (agentId, params) => api.get(`/ad/users/${agentId}`, { params }),
  exportUsers: (agentId, fmt = 'csv') => api.get(`/ad/users/${agentId}/export`, { params: { fmt }, responseType: 'blob' }),
  groups: (agentId, params) => api.get(`/ad/groups/${agentId}`, { params }),
  exportGroups: (agentId, fmt = 'csv') => api.get(`/ad/groups/${agentId}/export`, { params: { fmt }, responseType: 'blob' }),
  events: (agentId, params) => api.get(`/ad/events/${agentId}`, { params }),
  action: (agentId, data) => api.post(`/ad/action/${agentId}`, data),
  bulkAction: (agentId, data) => api.post(`/ad/bulk-action/${agentId}`, data),
  actionLog: (agentId, limit) => api.get(`/ad/action-log/${agentId}`, { params: { limit } }),
  compliance: (agentId) => api.get(`/ad/compliance/${agentId}`),
  deletedUsers: (agentId, params) => api.get(`/ad/deleted-users/${agentId}`, { params }),
  restoreUser: (agentId, data) => api.post(`/ad/restore-user/${agentId}`, data),
}

export const integrationsApi = {
  list: () => api.get('/integrations'),
  getConfig: (type) => api.get(`/integrations/${type}/config`),
  updateConfig: (type, data) => api.put(`/integrations/${type}/config`, data),
  test: (type) => api.post(`/integrations/${type}/test`),
  testEsxi: (data) => api.post('/integrations/vmware/test-esxi', data),
  sync: (type) => api.post(`/integrations/${type}/sync`),
  syncLog: (type, limit = 20) => api.get(`/integrations/sync-log/${type}`, { params: { limit } }),

  unitrends: {
    dashboard: () => api.get('/integrations/unitrends/dashboard'),
    backups: (params) => api.get('/integrations/unitrends/backups', { params }),
    clients: () => api.get('/integrations/unitrends/clients'),
    alerts: (unacknowledged_only = true) => api.get('/integrations/unitrends/alerts', { params: { unacknowledged_only } }),
    storage: () => api.get('/integrations/unitrends/storage'),
  },

  sophos: {
    dashboard: () => api.get('/integrations/sophos/dashboard'),
    endpoints: (health_status) => api.get('/integrations/sophos/endpoints', { params: health_status ? { health_status } : {} }),
    alerts: (severity) => api.get('/integrations/sophos/alerts', { params: severity ? { severity } : {} }),
    licenses: () => api.get('/integrations/sophos/licenses'),
    addLicense: (data) => api.post('/integrations/sophos/licenses', data),
    updateLicense: (id, data) => api.put(`/integrations/sophos/licenses/${id}`, data),
    deleteLicense: (id) => api.delete(`/integrations/sophos/licenses/${id}`),
  },

  o365: {
    dashboard: () => api.get('/integrations/o365/dashboard'),
    users: (params) => api.get('/integrations/o365/users', { params }),
    licenses: () => api.get('/integrations/o365/licenses'),
  },

  vmware: {
    dashboard: () => api.get('/integrations/vmware/dashboard'),
    vms: (params) => api.get('/integrations/vmware/vms', { params }),
    hosts: () => api.get('/integrations/vmware/hosts'),
    datastores: () => api.get('/integrations/vmware/datastores'),
    clusters: () => api.get('/integrations/vmware/clusters'),
  },

  proxmox: {
    dashboard: () => api.get('/integrations/proxmox/dashboard'),
    nodes: () => api.get('/integrations/proxmox/nodes'),
    vms: (params) => api.get('/integrations/proxmox/vms', { params }),
    storage: () => api.get('/integrations/proxmox/storage'),
  },

  nutanix: {
    dashboard: () => api.get('/integrations/nutanix/dashboard'),
    clusters: () => api.get('/integrations/nutanix/clusters'),
    vms: (params) => api.get('/integrations/nutanix/vms', { params }),
    hosts: () => api.get('/integrations/nutanix/hosts'),
    alerts: (params) => api.get('/integrations/nutanix/alerts', { params }),
  },

  sap: {
    dashboard: () => api.get('/integrations/sap/dashboard'),
    users: (params) => api.get('/integrations/sap/users', { params }),
    employees: (params) => api.get('/integrations/sap/employees', { params }),
    updateLicense: (internalKey, licenseType) =>
      api.put(`/integrations/sap/users/${internalKey}/license`, { license_type: licenseType }),
  },

  apcUps: {
    dashboard: () => api.get('/integrations/apc-ups/dashboard'),
    devices: () => api.get('/integrations/apc-ups/devices'),
    device: (id) => api.get(`/integrations/apc-ups/devices/${id}`),
    metrics: (id, hours = 24) => api.get(`/integrations/apc-ups/devices/${id}/metrics`, { params: { hours } }),
    sync: () => api.post('/integrations/apc-ups/sync'),
    createDevice: (data) => api.post('/integrations/apc-ups/devices', data),
    updateDevice: (id, data) => api.put(`/integrations/apc-ups/devices/${id}`, data),
    deleteDevice: (id) => api.delete(`/integrations/apc-ups/devices/${id}`),
    shutdownPolicies: () => api.get('/integrations/apc-ups/shutdown-policies'),
    createShutdownPolicy: (body) => api.post('/integrations/apc-ups/shutdown-policies', body),
    updateShutdownPolicy: (id, body) => api.put(`/integrations/apc-ups/shutdown-policies/${id}`, body),
    deleteShutdownPolicy: (id) => api.delete(`/integrations/apc-ups/shutdown-policies/${id}`),
    setPolicyAgents: (id, body) => api.put(`/integrations/apc-ups/shutdown-policies/${id}/agents`, body),
    getPolicyAgents: (id) => api.get(`/integrations/apc-ups/shutdown-policies/${id}/agents`),
    shutdownEvents: (limit = 20) => api.get(`/integrations/apc-ups/shutdown-events?limit=${limit}`),
    getEventAgents: (id) => api.get(`/integrations/apc-ups/shutdown-events/${id}/agents`),
    cancelShutdownEvent: (id) => api.post(`/integrations/apc-ups/shutdown-events/${id}/cancel`, {}),
  },
}

export const siemApi = {
  events: (params) => api.get('/siem/events', { params }),
  stats: (params) => api.get('/siem/stats', { params }),
  sources: () => api.get('/siem/sources'),
}

export const rebootSchedulesApi = {
  list: () => api.get('/reboot-schedules'),
  timezone: () => api.get('/reboot-schedules/timezone'),
  create: (data) => api.post('/reboot-schedules', data),
  update: (id, data) => api.put(`/reboot-schedules/${id}`, data),
  delete: (id) => api.delete(`/reboot-schedules/${id}`),
  toggle: (id) => api.post(`/reboot-schedules/${id}/toggle`),
  test: (id) => api.post(`/reboot-schedules/${id}/test`),
}

export const phishingApi = {
  // Campaigns
  listCampaigns: () => api.get('/phishing/campaigns'),
  createCampaign: (data) => api.post('/phishing/campaigns', data),
  getCampaign: (id) => api.get(`/phishing/campaigns/${id}`),
  updateCampaign: (id, data) => api.put(`/phishing/campaigns/${id}`, data),
  deleteCampaign: (id) => api.delete(`/phishing/campaigns/${id}`),
  launchCampaign: (id) => api.post(`/phishing/campaigns/${id}/launch`),
  completeCampaign: (id) => api.post(`/phishing/campaigns/${id}/complete`),
  resetCampaign: (id) => api.post(`/phishing/campaigns/${id}/reset`),
  // Targets
  listTargets: (id) => api.get(`/phishing/campaigns/${id}/targets`),
  addTarget: (id, data) => api.post(`/phishing/campaigns/${id}/targets`, data),
  importTargets: (id, targets) => api.post(`/phishing/campaigns/${id}/targets/import`, { targets }),
  deleteTarget: (cid, tid) => api.delete(`/phishing/campaigns/${cid}/targets/${tid}`),
  // Templates
  listTemplates: () => api.get('/phishing/templates'),
  getTemplate: (id) => api.get(`/phishing/templates/${id}`),
  createTemplate: (data) => api.post('/phishing/templates', data),
  updateTemplate: (id, data) => api.put(`/phishing/templates/${id}`, data),
  cloneTemplate: (id) => api.post(`/phishing/templates/${id}/clone`),
  deleteTemplate: (id) => api.delete(`/phishing/templates/${id}`),
  // SMTP channels
  smtpChannels: () => api.get('/phishing/smtp-channels'),
}

export const patchSchedulesApi = {
  list: () => api.get('/patch-schedules'),
  create: (data) => api.post('/patch-schedules', data),
  update: (id, data) => api.put(`/patch-schedules/${id}`, data),
  delete: (id) => api.delete(`/patch-schedules/${id}`),
  runNow: (id) => api.post(`/patch-schedules/${id}/run-now`),
  getTimezone: () => api.get('/patch-schedules/timezone'),
  history: (id, limit = 50) => api.get(`/patch-schedules/${id}/history?limit=${limit}`),
  runJobs: (id, runId) => api.get(`/patch-schedules/${id}/history/${runId}/jobs`),
}

export const consolidationApi = {
  data:       () => api.get('/consolidation/data'),
  plans:      () => api.get('/consolidation/plans'),
  upsert:     (agentId, body) => api.put(`/consolidation/plans/${agentId}`, body),
  deletePlan: (agentId) => api.delete(`/consolidation/plans/${agentId}`),
  autoSuggest: () => api.post('/consolidation/auto-suggest'),
}

export const quarterlyApi = {
  scorecard: (q, y) => api.get('/quarterly/scorecard', { params: { quarter: q, year: y } }),
  findings: (y, source) => api.get('/quarterly/findings', { params: { ...(y != null ? { year: y } : {}), source } }),
  createFinding: (data) => api.post('/quarterly/findings', data),
  updateFinding: (id, data) => api.patch(`/quarterly/findings/${id}`, data),
  deleteFinding: (id) => api.delete(`/quarterly/findings/${id}`),
  categories: () => api.get('/quarterly/categories'),
  createCategory: (data) => api.post('/quarterly/categories', data),
  deleteCategory: (id) => api.delete(`/quarterly/categories/${id}`),
  incidents: (q, y) => api.get('/quarterly/incidents', { params: { quarter: q, year: y } }),
  createIncident: (data) => api.post('/quarterly/incidents', data),
  updateIncident: (id, data) => api.patch(`/quarterly/incidents/${id}`, data),
  deleteIncident: (id) => api.delete(`/quarterly/incidents/${id}`),
  sla: () => api.get('/quarterly/sla'),
  updateSla: (data) => api.patch('/quarterly/sla', data),
  saveSnapshot: (q, y) => api.post('/quarterly/snapshot', null, { params: { quarter: q, year: y } }),
}
