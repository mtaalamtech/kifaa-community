import { Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Agents from './pages/Agents'
import AgentDetail from './pages/AgentDetail'
import SSLManager from './pages/SSLManager'
import Downloads from './pages/Downloads'
import Alerts from './pages/Alerts'
import Monitoring from './pages/Monitoring'
import MonitorDetail from './pages/MonitorDetail'
import Settings from './pages/Settings'
import Admin from './pages/Admin'
import Reports from './pages/Reports'
import ReportSchedules from './pages/ReportSchedules'
import Patches from './pages/Patches'
import PatchCompliance from './pages/PatchCompliance'
import Tasks from './pages/Tasks'
import ActiveDirectory from './pages/ActiveDirectory'
import Threats from './pages/Threats'
import Antivirus from './pages/Antivirus'
import Licenses from './pages/Licenses'
import ComplianceDashboard from './pages/ComplianceDashboard'
import RiskReview from './pages/RiskReview'
import QuarterlyReport from './pages/QuarterlyReport'
import ServiceMonitor from './pages/ServiceMonitor'
import MaintenancePlan from './pages/MaintenancePlan'
import SoftwareInventory from './pages/SoftwareInventory'
import Login from './pages/Login'

function PrivateRoute({ children }) {
  const token = localStorage.getItem('kifaa_token')
  return token ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:id" element={<AgentDetail />} />
        <Route path="ssl" element={<SSLManager />} />
        <Route path="downloads" element={<Downloads />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="monitoring" element={<Monitoring />} />
        <Route path="monitoring/:id" element={<MonitorDetail />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
        <Route path="reports" element={<Reports />} />
        <Route path="report-schedules" element={<ReportSchedules />} />
        <Route path="patches" element={<Patches />} />
        <Route path="patch-compliance" element={<PatchCompliance />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="active-directory" element={<ActiveDirectory />} />
        <Route path="threats" element={<Threats />} />
        <Route path="antivirus" element={<Antivirus />} />
        <Route path="licenses" element={<Licenses />} />
        <Route path="compliance" element={<ComplianceDashboard />} />
        <Route path="risk-review" element={<RiskReview />} />
        <Route path="quarterly-report" element={<QuarterlyReport />} />
        <Route path="service-monitor" element={<ServiceMonitor />} />
        <Route path="maintenance" element={<MaintenancePlan />} />
        <Route path="software-inventory" element={<SoftwareInventory />} />
      </Route>
    </Routes>
  )
}
