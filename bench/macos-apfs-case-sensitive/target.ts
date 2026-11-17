export default {
  name: "macos-apfs-case-sensitive",
  os: "darwin",
  filesystem: "apfs-case-sensitive",
  workerFilesystem: "case-sensitive-image",
  imageGib: 8,
  notes: [
    "Owned case-sensitive APFS images; measure separately from the default APFS layout.",
  ],
} as const;
