export default {
  name: "macos-apfs",
  os: "darwin",
  filesystem: "apfs",
  workerFilesystem: "isolated-image",
  imageGib: 8,
  notes: [
    "Owned APFS images on a shared Mac; not host-volume or exclusive per-file allocation claims.",
  ],
} as const;
