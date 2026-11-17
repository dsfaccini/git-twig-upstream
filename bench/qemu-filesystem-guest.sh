#!/usr/bin/env bash
# Local correctness guests only. Prepare owned disks/NoCloud seeds first; see linux.md.
set -euo pipefail
if [[ $# != 3 || ( $1 != server && $1 != client ) || ! $3 =~ ^[0-9]+$ ]]; then
  echo 'usage: bash bench/qemu-filesystem-guest.sh server|client ABSOLUTE_LAB_ROOT MAX_SECONDS' >&2
  exit 2
fi
role=$1
root=$2
seconds=$3
[[ $root = /* && $root != *','* && $root != *$'\n'* && $seconds -ge 60 && $seconds -le 1800 ]]
cd "$root"
for file in "$role.qcow2" "$role-seed.img"; do
  [[ -f $file && ! -L $file ]]
done
port=24022
mac=11
local_port=24101
peer_port=24102
disks=()
if [[ $role = client ]]; then
  port=24023
  mac=12
  local_port=24102
  peer_port=24101
else
  for kind in zfs xfs; do
    [[ -f $kind-data.qcow2 && ! -L $kind-data.qcow2 ]]
    disks+=(-drive "file=$kind-data.qcow2,format=qcow2,if=none,id=$kind"
      -device "virtio-blk-pci,drive=$kind,serial=twig_${kind}_data")
  done
fi
# The caller owns unique lab paths. Never replace another guest's monitor socket.
[[ ! -e $role.qmp ]]
exec timeout --signal=TERM --kill-after=20s "${seconds}s" qemu-system-x86_64 \
  -machine q35 -accel tcg,thread=multi -cpu max -smp 4 -m 4096 \
  -display none -serial "file:$role-serial.log" -monitor none \
  -qmp "unix:$role.qmp,server=on,wait=off" \
  -drive "file=$role.qcow2,format=qcow2,if=none,id=os" \
  -device virtio-blk-pci,drive=os,bootindex=1 \
  -drive "file=$role-seed.img,format=raw,if=virtio" \
  "${disks[@]}" \
  -netdev "user,id=management,hostfwd=tcp:127.0.0.1:$port-:22" \
  -device "virtio-net-pci,netdev=management,mac=52:54:00:12:00:$mac" \
  -netdev "socket,id=private,udp=127.0.0.1:$peer_port,localaddr=127.0.0.1:$local_port" \
  -device "virtio-net-pci,netdev=private,mac=52:54:00:12:01:$mac"
