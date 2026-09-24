import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Monitor, Shield, Download,
  LogOut, Server, Bell, Menu, X, Activity, Settings2, UserCog, FileText, CalendarClock, ShieldCheck, ListTodo, Users, Package, TrendingUp, ShieldAlert, KeyRound, BarChart3, ShieldBan, ClipboardList, BarChart2, Cog, Wrench
} from 'lucide-react'
import { useState } from 'react'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', exact: true },
  { to: '/agents', icon: Monitor, label: 'Agents' },
  { to: '/alerts', icon: Bell, label: 'Alerts' },
  { to: '/monitoring', icon: Activity, label: 'Monitoring' },
  { to: '/downloads', icon: Download, label: 'Agent Downloads' },
  { to: '/ssl', icon: Shield, label: 'SSL / Certificates' },
  { to: '/reports', icon: FileText, label: 'Reports' },
  { to: '/report-schedules', icon: CalendarClock, label: 'Report Schedules' },
  { to: '/patches', icon: ShieldCheck, label: 'Patch Management' },
  { to: '/patch-compliance', icon: TrendingUp, label: 'Patch Compliance' },
  { to: '/antivirus', icon: ShieldBan, label: 'Antivirus' },
  { to: '/compliance', icon: BarChart3, label: 'Compliance' },
  { to: '/quarterly-report', icon: BarChart2, label: 'Quarterly Report' },
  { to: '/active-directory', icon: Users, label: 'Active Directory' },
  { to: '/software-inventory', icon: Package, label: 'Software Inventory' },
]

const adminItems = [
  { to: '/settings', icon: Settings2, label: 'Settings' },
  { to: '/admin', icon: UserCog, label: 'Administration' },
]

export default function Layout() {
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const user = JSON.parse(localStorage.getItem('kifaa_user') || '{}')

  function logout() {
    localStorage.removeItem('kifaa_token')
    localStorage.removeItem('kifaa_user')
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-60' : 'w-16'} transition-all duration-300 bg-slate-900 border-r border-slate-700 flex flex-col`}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
            <Server size={18} className="text-white" />
          </div>
          {sidebarOpen && (
            <div>
              <div className="font-bold text-white text-sm">KIFAA</div>
              <div className="text-xs text-blue-400">Community Edition</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              <Icon size={18} className="flex-shrink-0" />
              {sidebarOpen && <span>{label}</span>}
            </NavLink>
          ))}

          {/* Admin section divider */}
          {sidebarOpen && (
            <div className="pt-3 pb-1">
              <div className="text-xs text-slate-600 font-medium uppercase tracking-wider px-3">Admin</div>
            </div>
          )}
          {!sidebarOpen && <div className="border-t border-slate-700 my-2" />}
          {adminItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              <Icon size={18} className="flex-shrink-0" />
              {sidebarOpen && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="p-3 border-t border-slate-700">
          <div className={`flex items-center gap-3 px-3 py-2 ${sidebarOpen ? '' : 'justify-center'}`}>
            <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {(user.username || 'A')[0].toUpperCase()}
            </div>
            {sidebarOpen && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-white truncate">{user.username}</div>
                <div className="text-xs text-slate-400 capitalize">{user.role}</div>
              </div>
            )}
          </div>
          <button
            onClick={logout}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 w-full mt-1 ${!sidebarOpen ? 'justify-center' : ''}`}
          >
            <LogOut size={16} />
            {sidebarOpen && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 bg-slate-900 border-b border-slate-700 flex items-center px-4 gap-4">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-slate-400 hover:text-white"
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="flex-1" />
          <button className="text-slate-400 hover:text-white relative">
            <Bell size={20} />
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
