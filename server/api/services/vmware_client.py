"""
VMware vCenter / standalone ESXi client using pyVmomi (vSphere SOAP API).
Gives real-time host CPU/memory usage, VM list, datastores, clusters.
"""
import logging
import ssl

logger = logging.getLogger(__name__)


def _make_ssl_context(verify_ssl: bool):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    if not verify_ssl:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


class VMwareClient:
    def __init__(self, host: str, username: str, password: str,
                 verify_ssl: bool = False, is_esxi: bool = False):
        self.host = host.rstrip("/")
        self.username = username
        self.password = password
        self.verify_ssl = verify_ssl
        self.is_esxi = is_esxi
        self._si = None        # ServiceInstance
        self._content = None   # RetrieveContent

    def login(self):
        from pyVim.connect import SmartConnect
        ctx = _make_ssl_context(self.verify_ssl)
        self._si = SmartConnect(
            host=self.host,
            user=self.username,
            pwd=self.password,
            sslContext=ctx,
            connectionPoolTimeout=30,
        )
        self._content = self._si.RetrieveContent()
        logger.info(f"VMware login OK: {self.host}")

    def test_connection(self):
        self.login()
        about = self._content.about
        return {
            "connected": True,
            "host": self.host,
            "type": "esxi" if self.is_esxi else "vcenter",
            "version": about.version,
            "build": about.build,
            "full_name": about.fullName,
        }

    def _container_view(self, vimtype):
        from pyVmomi import vim
        return self._content.viewManager.CreateContainerView(
            self._content.rootFolder, [vimtype], True
        )

    def get_vms(self):
        from pyVmomi import vim
        results = []
        view = self._container_view(vim.VirtualMachine)
        for vm in view.view:
            try:
                summary = vm.summary
                cfg = summary.config
                guest = summary.guest
                runtime = summary.runtime
                # createDate is on vm.config (full config), not summary.config
                create_date = None
                try:
                    if vm.config and vm.config.createDate:
                        create_date = vm.config.createDate.isoformat()
                except Exception:
                    pass
                results.append({
                    "vm": vm._moId,
                    "name": cfg.name if cfg else vm.name,
                    "power_state": str(runtime.powerState).upper().replace("POWEREDON", "POWERED_ON").replace("POWEREDOFF", "POWERED_OFF") if runtime else "UNKNOWN",
                    "cpu_count": cfg.numCpu if cfg else 0,
                    "memory_size_MiB": (cfg.memorySizeMB or 0) if cfg else 0,
                    "guest_OS": cfg.guestFullName if cfg else "",
                    "ip_address": (guest.ipAddress or "") if guest else "",
                    "host_name": vm.runtime.host.name if (vm.runtime and vm.runtime.host) else "",
                    "create_date": create_date,
                })
            except Exception as e:
                logger.debug(f"VM parse error: {e}")
        view.Destroy()
        return results

    def get_hosts(self):
        from pyVmomi import vim
        results = []
        view = self._container_view(vim.HostSystem)
        for host in view.view:
            try:
                summary = host.summary
                hardware = summary.hardware
                runtime = summary.runtime
                quick = summary.quickStats

                cpu_cores  = hardware.numCpuCores if hardware else 0
                cpu_mhz    = hardware.cpuMhz if hardware else 0       # MHz per core
                mem_mb     = (hardware.memorySize // (1024 * 1024)) if hardware else 0
                cpu_usage  = quick.overallCpuUsage if quick else 0    # MHz used
                mem_usage  = quick.overallMemoryUsage if quick else 0  # MB used

                # Cluster / parent
                parent = host.parent
                cluster_name = parent.name if parent and hasattr(parent, 'name') else ""

                results.append({
                    "host": host._moId,
                    "name": host.name,
                    "connection_state": str(runtime.connectionState).upper() if runtime else "UNKNOWN",
                    "power_state": str(runtime.powerState).upper().replace("POWEREDON", "POWERED_ON").replace("POWEREDOFF", "POWERED_OFF") if runtime else "UNKNOWN",
                    "cpu_cores": cpu_cores,
                    "cpu_mhz": cpu_mhz,
                    "cpu_usage_mhz": cpu_usage,
                    "memory_mb": mem_mb,
                    "memory_usage_mb": mem_usage,
                    "vm_count": len(host.vm) if host.vm else 0,
                    "version": summary.config.product.version if (summary.config and summary.config.product) else "",
                    "cluster_name": cluster_name,
                })
            except Exception as e:
                logger.debug(f"Host parse error: {e}")
        view.Destroy()
        return results

    def get_datastores(self):
        from pyVmomi import vim
        results = []
        view = self._container_view(vim.Datastore)
        for ds in view.view:
            try:
                info = ds.info
                summary = ds.summary
                results.append({
                    "datastore": ds._moId,
                    "name": summary.name,
                    "type": summary.type,
                    "capacity": summary.capacity or 0,    # bytes
                    "free_space": summary.freeSpace or 0, # bytes
                    "accessible": summary.accessible,
                })
            except Exception as e:
                logger.debug(f"Datastore parse error: {e}")
        view.Destroy()
        return results

    def get_clusters(self):
        from pyVmomi import vim
        results = []
        view = self._container_view(vim.ClusterComputeResource)
        for cl in view.view:
            try:
                summary = cl.summary
                config = cl.configuration
                results.append({
                    "cluster": cl._moId,
                    "name": cl.name,
                    "ha_enabled": (config.dasConfig.enabled if config and config.dasConfig else False),
                    "drs_enabled": (config.drsConfig.enabled if config and config.drsConfig else False),
                })
            except Exception as e:
                logger.debug(f"Cluster parse error: {e}")
        view.Destroy()
        return results

    def get_networks(self):
        from pyVmomi import vim
        results = []
        view = self._container_view(vim.Network)
        for net in view.view:
            try:
                results.append({"network": net._moId, "name": net.name})
            except Exception:
                pass
        view.Destroy()
        return results

    def power_on_vm(self, vm_name: str) -> bool:
        """Power on a VM by name. Returns True if task was started."""
        from pyVmomi import vim
        view = self._container_view(vim.VirtualMachine)
        try:
            for vm in view.view:
                try:
                    name = vm.config.name if vm.config else vm.name
                except Exception:
                    name = vm.name
                if name.lower() == vm_name.lower():
                    state = str(vm.runtime.powerState) if vm.runtime else ""
                    if "poweredOn" in state or "POWERED_ON" in state:
                        return True  # already on
                    vm.PowerOnVM_Task()
                    return True
        finally:
            view.Destroy()
        return False

    def close(self):
        if self._si:
            try:
                from pyVim.connect import Disconnect
                Disconnect(self._si)
            except Exception:
                pass
            self._si = None
