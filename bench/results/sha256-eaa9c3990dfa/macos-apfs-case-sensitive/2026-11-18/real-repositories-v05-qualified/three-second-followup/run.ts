import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, statfsSync } from "node:fs";
import { join } from "node:path";

const main = "/Users/leostera/Developer/github.com/leostera/git-twig/main";
const cwd = "/Users/leostera/Developer/github.com/leostera/git-twig/bench-v05-macos-real-results";
const output = join(main,"target/v05-real-macos-stability-2026-11-18");
const prior = join(main,"target/v05-real-macos-2026-11-17");
const original = JSON.parse(readFileSync(join(prior,"manifest.json"),"utf8"));
const jobs = original.jobs.filter((j:any)=>["openclaw","pulumi"].includes(j.name));
const bin = join(prior,"bin");
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const sync=(args:string[])=>{
 const r=Bun.spawnSync(args,{cwd,stdout:"pipe",stderr:"pipe"});
 if(r.exitCode)throw new Error(new TextDecoder().decode(r.stderr));
 return new TextDecoder().decode(r.stdout).trim();
};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const workers=()=>{const r=Bun.spawnSync(["pgrep","-x","twig-real-bench"],{stdout:"pipe",stderr:"pipe"});return new TextDecoder().decode(r.stdout).trim().split(/\s+/).filter(Boolean).map(Number);};
const knownOtherAlive=()=>{
 const r=Bun.spawnSync(["ps","-p","59270","-o","command="],{stdout:"pipe",stderr:"pipe"});
 return new TextDecoder().decode(r.stdout).includes("v05-real-20261117T234358");
};
if(existsSync(join(output,"manifest.json")))throw new Error("Refusing to overwrite stability campaign");
mkdirSync(output,{recursive:true});
const commit=sync(["git","rev-parse","HEAD"]);
if(sync(["git","status","--porcelain"]))throw new Error("Dedicated harness checkout must be clean");
const manifest={
 ...original,
 startedAt:new Date().toISOString(),harnessCheckoutCommit:commit,
 followupOf:{directory:prior,manifestSHA256:sha(join(prior,"manifest.json")),reason:"Owner requested reruns until allocation sampling settles; four original Git observations were unstable and remain unchanged."},
 jobs,
 stoppingRule:{eligibility:"First complete three-round paired campaign per repository where every before/afterStatus allocation sample is stable, all byte/mode/link/source/private-write checks pass, and Twig is native.",selection:"Stability only, independent of measured savings. Retain every attempt, stable or unstable; do not pool or silently discard attempts.",maxAttemptsPerRepository:5,maxElapsedMinutes:150,quietSecondsBeforeEachAttempt:60},
 notes:[...original.notes,"A separate real-repository campaign was observed active on this Mac during preflight. These followups wait for it and any other observed real-bench worker to finish, then require 60 seconds without workers.","Known other active campaign controller PID59270: target/v05-real-20261117T234358. It is not modified or stopped.","Same published binary, frozen Git/harness, pins, 32-GiB image size, warmup, batch size and three paired repetitions as the original allocation campaign."]
};
writeFileSync(join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
let current:string|null=null;
const attempts:any[]=[];
const qualified:Record<string,string>={};
const started=Date.now(),deadline=started+150*60_000;
const state=(phase:string,extra={})=>{
 writeFileSync(join(output,"state.tmp"),JSON.stringify({phase,supervisorPid:process.pid,updatedAt:new Date().toISOString(),current,attempts,qualified,...extra},null,2)+"\n");
 renameSync(join(output,"state.tmp"),join(output,"state.json"));
};
const guard=()=>{
 if(Date.now()>deadline)throw new Error("Campaign elapsed safety limit; retained attempts remain available");
 const fs=statfsSync(main);if(fs.bavail*fs.bsize<128*2**30)throw new Error("Free-space guard");
 if(sync(["git","rev-parse","HEAD"])!==commit||sync(["git","status","--porcelain"]))throw new Error("Dedicated checkout changed");
 for(const b of Object.values(original.binaries) as any[])if(sha(b.path)!==b.sha256)throw new Error("Frozen binary changed");
};
const idle=async()=>{
 let quietSince:number|null=null;
 while(true){
  guard();const active=workers(),other=knownOtherAlive();
  if(active.length||other){quietSince=null;state("waiting-for-idle",{otherWorkerPids:active,knownOtherControllerAlive:other});}
  else{
   quietSince??=Date.now();
   if(Date.now()-quietSince>=60_000)return;
   state("waiting-for-quiet-window",{quietForSeconds:Math.floor((Date.now()-quietSince)/1000)});
  }
  await wait(15_000);
 }
};
const env:Record<string,string>={};
for(const key of ["HOME","TMPDIR","LANG","LC_ALL","USER","LOGNAME","SHELL"])if(process.env[key])env[key]=process.env[key]!;
Object.assign(env,{PATH:bin+":"+process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_EXEC_PATH:original.gitExecPath,GIT_TEMPLATE_DIR:""});
try{
 for(let attempt=1;attempt<=5&&Object.keys(qualified).length<jobs.length;attempt++){
  for(const job of jobs){
   if(qualified[job.name])continue;
   current=job.name+"-attempt-"+attempt;await idle();guard();
   const dir=join(output,current);mkdirSync(dir);
   const file=join(dir,job.name+".json");
   const args=[join(bin,"twig-real-bench"),"--repo",job.name+"="+job.path,"--revision",job.name+"="+job.revision,"--candidate",join(bin,"git-twig"),"--filesystem","case-sensitive-image","--image-gib","32","--worktrees","1","--concurrency","1","--repeats","3","--warmup","true","--output",file];
   writeFileSync(join(dir,"command.json"),JSON.stringify(args,null,2)+"\n",{flag:"wx"});
   const log=openSync(join(dir,"worker.log"),"wx");
   const child=Bun.spawn(args,{cwd,env,stdout:log,stderr:log,stdin:"ignore"});
   state("running",{childPid:child.pid});
   const timer=setInterval(()=>{const f=statfsSync(main);if(f.bavail*f.bsize<128*2**30)child.kill("SIGTERM");state("running",{childPid:child.pid});},5000);
   const exitCode=await child.exited;clearInterval(timer);closeSync(log);
   if(!existsSync(file))throw new Error("Missing result: "+current+" exit "+exitCode);
   const data=JSON.parse(readFileSync(file,"utf8"));
   const record:any={repository:job.name,attempt,rawFile:file,sha256:sha(file),exitCode,cohorts:data.cohorts.length,failures:data.failures,allocationStable:false,comparisonEligible:false};
   attempts.push(record);
   if(exitCode||data.failures.length||data.cohorts.length!==6||data.commit!==commit||data.dirty||data.candidateSha256!==original.binaries["git-twig"].sha256)throw new Error("Failed, incompatible or incomplete attempt: "+current);
   const pairs=new Set(data.cohorts.map((c:any)=>c.backend+":"+c.repeat));
   if(pairs.size!==6||!["git:0","git:1","git:2","twig:0","twig:1","twig:2"].every(k=>pairs.has(k)))throw new Error("Unpaired attempt");
   for(const c of data.cohorts){
    if(c.failed||c.succeeded!==1||c.operations.length!==1||c.sourceCommit!==job.revision||c.targetCommit!==job.revision||!c.sourceUnchanged||!c.privateWriteTested||c.operations.some((o:any)=>!o.verified||o.exitCode!==0||o.error||(c.backend==="twig"&&!o.nativeCow)))throw new Error("Correctness/native/private-write failure: "+current);
   }
   record.observations=data.cohorts.map((c:any)=>({backend:c.backend,round:c.repeat,bytes:c.growthAfterStatusBytes,beforeStable:c.before.stable,afterStatusStable:c.afterStatus.stable}));
   record.allocationStable=data.cohorts.every((c:any)=>c.before.stable&&c.afterStatus.stable);
   record.comparisonEligible=record.allocationStable&&data.cohorts.every((c:any)=>c.growthAfterStatusBytes>0);
   if(record.comparisonEligible)qualified[job.name]=file;
   writeFileSync(join(dir,"assessment.json"),JSON.stringify(record,null,2)+"\n",{flag:"wx"});
   state("attempt-completed",{childPid:null});
  }
 }
 current=null;
 if(Object.keys(qualified).length===jobs.length)state("completed",{childPid:null});
 else state("stopped-at-safety-limit",{childPid:null,reason:"No fully stable paired campaign for every repository within five attempts; all data retained."});
}catch(error){state("failed",{error:String(error),childPid:null});console.error(error);process.exitCode=1;}
