/// <reference types="vite/client" />
declare module "virtual:twig-benchmarks" {
  const data: ReturnType<typeof import("../scripts/benchmarks").loadPlatforms>;
  export default data;
}
