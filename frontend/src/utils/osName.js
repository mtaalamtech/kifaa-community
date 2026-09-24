const WIN_BUILD_MAP = {
  '10.0.26100': 'Windows 11 24H2',
  '10.0.22631': 'Windows 11 23H2',
  '10.0.22621': 'Windows 11 22H2',
  '10.0.22000': 'Windows 11 21H2',
  '10.0.20348': 'Windows Server 2022',
  '10.0.19045': 'Windows 10 22H2',
  '10.0.19044': 'Windows 10 21H2',
  '10.0.19043': 'Windows 10 21H1',
  '10.0.19042': 'Windows 10 20H2',
  '10.0.19041': 'Windows 10 2004',
  '10.0.18363': 'Windows 10 1909',
  '10.0.18362': 'Windows 10 1903',
  '10.0.17763': 'Windows Server 2019',
  '10.0.17134': 'Windows 10 1803',
  '10.0.16299': 'Windows 10 1709',
  '10.0.15063': 'Windows 10 1703',
  '10.0.14393': 'Windows Server 2016',
  '10.0.10586': 'Windows 10 1511',
  '10.0.10240': 'Windows 10 1507',
  '6.3.9600':   'Windows Server 2012 R2',
  '6.2.9200':   'Windows Server 2012',
  '6.1.7601':   'Windows Server 2008 R2',
  '6.1.7600':   'Windows 7',
  '6.0.6002':   'Windows Server 2008',
  '5.2.3790':   'Windows Server 2003',
  '5.1.2600':   'Windows XP',
}

function buildLookup(version) {
  if (!version) return null
  // Take only first 3 parts (major.minor.build) — ignore patch/revision level
  const build = version.split('.').slice(0, 3).join('.')
  return WIN_BUILD_MAP[build] || null
}

// Linux distro short-name → proper display name (fallback for old agents)
const LINUX_NAME_MAP = {
  'ubuntu':      'Ubuntu',
  'debian':      'Debian',
  'centos':      'CentOS',
  'rhel':        'Red Hat Enterprise Linux',
  'fedora':      'Fedora',
  'arch':        'Arch Linux',
  'alpine':      'Alpine Linux',
  'amazon':      'Amazon Linux',
  'oracle':      'Oracle Linux',
  'rocky':       'Rocky Linux',
  'almalinux':   'AlmaLinux',
  'suse':        'SUSE Linux Enterprise',
  'sles':        'SUSE Linux Enterprise Server',
  'opensuse':    'openSUSE',
  'opensuse-leap':'openSUSE Leap',
  'raspbian':    'Raspbian',
  'linuxmint':   'Linux Mint',
  'kali':        'Kali Linux',
}

function friendlyLinux(name, version) {
  const lower = name.toLowerCase().trim()
  // Already a full name (contains space = likely already descriptive)
  if (name.includes(' ') && !name.match(/^\w+\s+\d/)) return name
  // Look up short ID
  const mapped = LINUX_NAME_MAP[lower] || LINUX_NAME_MAP[lower.split(/[\s-]/)[0]]
  const base = mapped || name
  return version ? `${base} ${version}` : base
}

export function friendlyOS(osName, osVersion) {
  if (!osName) {
    // No name at all — try to map raw version string via build map
    return buildLookup(osVersion) || osVersion || '—'
  }

  // Strip leading "Microsoft " (case-insensitive)
  let n = osName.replace(/^Microsoft\s+/i, '').trim()

  // Bare "Windows" with no version detail — use os_version to look up build name
  if (/^windows$/i.test(n)) {
    return buildLookup(osVersion) || (osVersion ? `Windows ${osVersion}` : 'Windows')
  }

  // "Windows X.Y.Z" or "Windows X.Y.Z.W" — raw version from old agent fallback
  const buildMatch = n.match(/^[Ww]indows\s+(\d+\.\d+\.\d+)/)
  if (buildMatch) {
    const mapped = WIN_BUILD_MAP[buildMatch[1]]
    if (mapped) return mapped
    const vMapped = buildLookup(osVersion)
    if (vMapped) return vMapped
    return `Windows ${buildMatch[1]}`
  }

  // Linux short names (old agents before /etc/os-release fix)
  // e.g. "suse 12.4" → "SUSE Linux Enterprise 12.4"
  const lowerN = n.toLowerCase()
  if (!lowerN.startsWith('windows')) {
    const linuxMapped = LINUX_NAME_MAP[lowerN.split(' ')[0]]
    if (linuxMapped) {
      const ver = n.split(' ').slice(1).join(' ') || osVersion || ''
      return ver ? `${linuxMapped} ${ver}` : linuxMapped
    }
  }

  return n || buildLookup(osVersion) || osVersion || '—'
}
