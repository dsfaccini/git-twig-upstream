# RFD0019 — Isolated ZFS and NFS test guests

- Status: implementation contract
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Test OpenZFS and NFSv4.2 inside two disposable local Linux guests rather than
installing filesystem/server modules into the development host or using paid
cloud resources. The server owns separate new virtual data disks for ZFS and XFS;
the client mounts explicit NFSv4.2 exports. This extends RFD0018's capability and
checkout contracts without assuming that either filesystem supports FICLONE.

The local host lacks a usable KVM device. QEMU software emulation is acceptable
for correctness/capability checks, not latency, throughput or capacity claims.
Bound guest CPU, RAM, virtual disk sizes and process lifetime. Retain images and
raw logs under ignored target directories; commit only reusable code/config and
explicitly selected compact measurements. No release, push or publication is
part of this contract.

## Guide-level contract

The server runs ZFS and an NFS server using only its virtual data devices. Test
source/destination/common-Git-directory layouts within and across datasets, and
client checkouts over NFS. Probe cloning independently before requiring Twig's
native path. A refusal must delegate correctly rather than authorize unchecked
bytes. Compare actual checkout files, links, modes, index/status and source
preservation against Git. Keep partial failures as failures, not capacity data.

## Reference-level contract

- Download an official Linux cloud image over HTTPS and verify its published
  SHA-256 before boot. Record the digest, guest kernel/tool versions, accelerator,
  mount/export properties and clone-probe outcome.
- Boot new qcow2 overlays over that immutable base; create distinct empty virtual
  disks with explicit serial identifiers. Check those identifiers before any
  mkfs or zpool operation. Never forward a host physical disk or partition.
- Use generated lab-only SSH keys, locked passwords and loopback-only forwarded
  SSH ports. Never commit or display private keys. Guest package installation
  uses a management NIC; test traffic uses a separate private guest network.
- Bind NFS to the private server address. Restrict exports to the one client
  address with root squashing. Do not forward NFS/RPC ports to the host or LAN.
  Dataset/export roots belong to the unprivileged fixture UID.
- Pin NFS version 4.2 explicitly and inspect the negotiated mount. An advertised
  protocol version does not prove server-side CLONE or useful allocation savings.
- Keep ZFS pool/dataset feature properties and cloning settings explicit. Test
  accepted and refused clones without replacing private raw-byte certification.
- Measure any later allocation claims on the isolated server dataset/filesystem,
  not from client NFS statvfs or sparse host-image size. Software-emulated guest
  timings are not representative performance results.
- Shut down guests cleanly when finished or report a budget stop. Retain their
  images and diagnostic logs. Guest restarts/disconnect tests must target only
  these owned guests, never a shared NFS service.

## Alternatives and limitations

Host module installation and kernel NFS exports would be simpler, but change
shared development-host state. Remote/cloud VMs could provide hardware
virtualization, but require separate authorization for deployment/cost and are
unnecessary for the first correctness slice. Existing loopback mounts cannot
supply a missing ZFS implementation or a real NFS client/server boundary.

Guest provisioning and emulator failures are infrastructure findings, not Twig
backend failures. Do not weaken tests or claim support merely because a guest
boots or a mount succeeds. Restart/latency/allocation experiments remain separate
bounded slices after baseline checkout correctness is established.
