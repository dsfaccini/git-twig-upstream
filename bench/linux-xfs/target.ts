export default {
  name: "linux-xfs",
  os: "linux",
  filesystem: "xfs",
  workerFilesystem: "linux-xfs-image",
  imageGib: 8,
  notes: [
    "Owned loopback images; record backing storage in --environment. No bare-device performance claim.",
  ],
} as const;
