/// <reference types="vite/client" />
declare module "virtual:twig-benchmarks" {
  const data: import("../scripts/benchmarks").DiskComparison[];
  export default data;
}
