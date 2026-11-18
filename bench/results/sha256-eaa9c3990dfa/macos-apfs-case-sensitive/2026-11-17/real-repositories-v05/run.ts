import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statfsSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";

const main = "/Users/leostera/Developer/github.com/leostera/git-twig/main";
const run = join(main, "target/v05-real-macos-2026-11-17");
const bin = join(run, "bin");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const command = (args: string[]) => {
  const p = Bun.spawnSync(args, { cwd: main, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(new TextDecoder().decode(p.stderr));
  return new TextDecoder().decode(p.stdout).trim();
};
if (existsSync(join(run, "manifest.json"))) throw new Error("Refusing to overwrite a campaign");
if (command(["git","status","--porcelain"])) throw new Error("Harness checkout must be clean");
if (command(["git","diff","4d2622f77ea8bfecc1f3fd6f1930686648990bbd","HEAD","--","crates/twig-bench"])) throw new Error("Frozen worker source changed");
mkdirSync(bin, {recursive:true});
const sources = {
 "git-twig": join(main,"target/release-v0.5.0/unpacked/aarch64-apple-darwin/git-twig"),
 "twig-real-bench": resolve(main,"../feat-integrate-adopt/target/build/release/twig-real-bench"),
 "git": command(["sh","-c","command -v git"]),
};
for (const [name, path] of Object.entries(sources)) copyFileSync(path,join(bin,name));
const jobs = [
 {name:"workers-starter", path:join(main,"target/workers-starter"), revision:"d0b1ee485dc1cf2bc0b2a3511cf8cf1057624d02",worktrees:10},
 {name:"twig", path:main, revision:"96c43950e4c0d8524de4ad53157c136eb222d39c",worktrees:10},
 {name:"axo", path:"/Users/leostera/Developer/github.com/leostera/axo", revision:"67af816be26633039e8507d93d577b2073d6f5fd",worktrees:1},
 {name:"linux", path:join(main,"target/kernel-input.git"), revision:"23c62304dde29abe92013d85910d03a77dada35d",worktrees:1},
 {name:"openclaw", path:join(main,"target/apfs-v04-final-2026-11-17/input/openclaw.git"), revision:"410c0dda40702e25263b49b8b7d0786a5e49e366",worktrees:1},
 {name:"pulumi", path:resolve(main,"../exp-issue5-reproduction-fixtures/docs"), revision:"430261138aa08539cd598b9269bfe8f82fd49b78",worktrees:1},
];
const commit=command(["git","rev-parse","HEAD"]);
for(const job of jobs) command(["git","-C",job.path,"cat-file","-e",job.revision+"^{commit}"]);
const binaries=Object.fromEntries(Object.keys(sources).map(name=>[name,{path:join(bin,name),sha256:sha(join(bin,name))}]));
if(command([join(bin,"git-twig"),"--version"])!=="git-twig 0.5.0") throw new Error("Not the published v0.5.0 candidate");
const manifest={
 schemaVersion:1,startedAt:new Date().toISOString(),harnessCheckoutCommit:commit,
 candidateSourceTag:"v0.5.0",candidateSourceCommit:"4d2622f77ea8bfecc1f3fd6f1930686648990bbd",
 workerSourceCommit:"4d2622f77ea8bfecc1f3fd6f1930686648990bbd",
 platform:command(["sw_vers"]),cpu:command(["sysctl","-n","machdep.cpu.brand_string"]),
 gitVersion:command([join(bin,"git"),"--version"]),gitExecPath:command([join(bin,"git"),"--exec-path"]),
 binaries,jobs,config:{filesystem:"case-sensitive-image",imageGib:32,repeats:3,concurrency:1,warmup:true,minimumHostFreeGiB:128},
 notes:["Published v0.5.0 GitHub arm64 archive, not an earlier candidate.","Real repository pins and batch sizes match the historical v0.4 campaign. Allocation-only refresh; raw harness timings are retained but not promoted as website claims.","Additional isolated filesystem allocation after first status, including Git metadata; not exclusive per-file allocation or adopted-space savings.","Three paired rounds; separate image and seed per backend/round. No measured retries or silent exclusions. All correctness and native/private-write checks remain enabled.","Shared Apple M1 Ultra host, warm cache. No intentional competing tests, builds, or benchmark campaigns. No application code/dependencies executed."]
};
writeFileSync(join(run,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
let current:string|null=null;
const completed:unknown[]=[];
const state=(phase:string,extra={})=>{
 const data={phase,supervisorPid:process.pid,updatedAt:new Date().toISOString(),current,completed,...extra};
 writeFileSync(join(run,"state.tmp"),JSON.stringify(data,null,2)+"\n");renameSync(join(run,"state.tmp"),join(run,"state.json"));
};
const guard=()=>{
 const fs=statfsSync(main);if(fs.bavail*fs.bsize<128*2**30)throw new Error("Free-space guard");
 if(command(["git","rev-parse","HEAD"])!==commit||command(["git","status","--porcelain"]))throw new Error("Harness checkout changed");
 for(const item of Object.values(binaries)) if(sha(item.path)!==item.sha256)throw new Error("Frozen binary changed");
};
const env:Record<string,string>={};
for(const key of ["HOME","TMPDIR","LANG","LC_ALL","USER","LOGNAME","SHELL"])if(process.env[key])env[key]=process.env[key]!;
Object.assign(env,{PATH:bin+":"+process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_EXEC_PATH:manifest.gitExecPath,GIT_TEMPLATE_DIR:""});
try{
 for(const job of jobs){
  guard();current=job.name;state("running");
  const output=join(run,job.name+".json");
  const args=[join(bin,"twig-real-bench"),"--repo",job.name+"="+job.path,"--revision",job.name+"="+job.revision,"--candidate",join(bin,"git-twig"),"--filesystem","case-sensitive-image","--image-gib","32","--worktrees",String(job.worktrees),"--concurrency","1","--repeats","3","--warmup","true","--output",output];
  writeFileSync(join(run,job.name+".command.json"),JSON.stringify(args,null,2)+"\n",{flag:"wx"});
  const log=openSync(join(run,job.name+".log"),"wx");
  const child=Bun.spawn(args,{cwd:main,env,stdout:log,stderr:log,stdin:"ignore"});
  state("running",{childPid:child.pid});
  const timer=setInterval(()=>{const f=statfsSync(main);if(f.bavail*f.bsize<128*2**30)child.kill("SIGTERM");state("running",{childPid:child.pid});},5000);
  const code=await child.exited;clearInterval(timer);closeSync(log);
  if(!existsSync(output))throw new Error("Missing result: "+job.name+" exit "+code);
  const data=JSON.parse(readFileSync(output,"utf8"));
  completed.push({repository:job.name,exitCode:code,cohorts:data.cohorts.length,failures:data.failures});
  state("running",{childPid:null});
  if(code!==0||data.failures.length||data.cohorts.length!==6)throw new Error("Failed/incomplete cohort: "+job.name);
  for(const c of data.cohorts){
   if(c.failed!==0||c.succeeded!==job.worktrees||!c.sourceUnchanged||!c.privateWriteTested||c.operations.some((o:any)=>!o.verified||o.exitCode!==0||o.error||(c.backend==="twig"&&!o.nativeCow)))throw new Error("Correctness/private-write/native gate: "+job.name);
  }
 }
 current=null;state("completed",{childPid:null});
}catch(error){state("failed",{error:String(error),childPid:null});console.error(error);process.exitCode=1;}
