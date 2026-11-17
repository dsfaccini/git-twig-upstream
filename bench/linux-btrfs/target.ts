export default {
  name: "linux-btrfs",
  os: "linux",
  filesystem: "btrfs",
  workerFilesystem: "linux-btrfs-image",
  imageGib: 8,
  notes: [
    "Owned loopback images; record backing storage in --environment. No bare-device performance claim.",
  ],
} as const;
