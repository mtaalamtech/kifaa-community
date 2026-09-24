# Kifaa Frontend — React App

## Stack
- React 18, Vite, Tailwind CSS, React Router v6
- lucide-react for icons, recharts for charts, xlsx for exports, jspdf for PDFs

## Build
```bash
cd /opt/kifaa/frontend
npm run build
# Output goes to dist/ which is volume-mounted into nginx — no container restart needed
```

## Key Files
| File | Purpose |
|------|---------|
| src/App.jsx | Route definitions — add new pages here |
| src/components/Layout.jsx | Sidebar nav — add new nav links here |
| src/api/client.js | Axios instance (base URL + auth header) |
| src/pages/ | All page components |

## Adding a New Page — Checklist
1. Create `src/pages/NewPage.jsx`
2. `import NewPage from './pages/NewPage'` in App.jsx
3. Add `<Route path="new-page" element={<NewPage />} />` in App.jsx
4. Add nav entry in Layout.jsx: `{ to: '/new-page', icon: SomeIcon, label: 'New Page' }`
5. Run `npm run build`

## API Calls
```jsx
import api from '../api/client'

// GET
const res = await api.get('/endpoint')

// POST
const res = await api.post('/endpoint', { key: value })

// File download (XLSX etc.)
const token = localStorage.getItem('token')
const res = await fetch(`${import.meta.env.VITE_API_URL}/endpoint`, {
  headers: { Authorization: `Bearer ${token}` }
})
const blob = await res.blob()
// trigger download...
```

## Existing Pages
| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | / | Overview metrics |
| Agents | /agents | Agent list, deploy, details |
| Patches | /patches | Patch management |
| PatchCompliance | /patch-compliance | Compliance view |
| Monitoring | /monitoring | Service monitors |
| QuarterlyReport | /quarterly-report | Full XLSX quarterly report |
| RDPReport | /rdp-report | RDP connection report by server |
| Reports | /reports | Uptime, incident, monitor reports |
| ComplianceDashboard | /compliance | Security compliance scores |
| ActiveDirectory | /active-directory | AD management |
| Terminal | /terminal/:agentId | SSH/RDP web terminal |
| Integrations | /integrations | VMware, Proxmox, Sophos, etc. |
| SIEM | /siem | Security event log |
| Phishing | /phishing | Phishing simulation campaigns |
| BotConfig | /bot-config | Telegram/Teams bot settings |

## VITE_API_URL
Set to `/api/v1` in production (relative, goes through nginx).
Set in `.env` and passed as build arg to the Docker image.
