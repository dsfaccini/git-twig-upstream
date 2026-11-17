#!/usr/bin/env bun
/** Faithful direct-source CLI comparison, not a harness-created shared seed. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, lstatSync, readdirSync, readlinkSync, readSync, appendFileSync, statfsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { loadavg } from "node:os";
const [runArg, sourceArg, v03Arg, reportedArg, v04Arg] = process.argv.slice(2);
if (![runArg,sourceArg,v03Arg,reportedArg,v04Arg].every(Boolean)) throw new Error("RUN SOURCE V03 REPORTED870 V04 required");
const run = resolve(runArg!), source = resolve(sourceArg!);
if(existsSync(run)) throw new Error("Never overwrite a run");
mkdirSync(run,{recursive:true});
const env={...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",TWIG_TRACE:"1"};
function capture(argv:string[],cwd=source):string {
 const p=Bun.spawnSync(argv,{cwd,env,stdout:"pipe",stderr:"pipe"});
 if(p.exitCode)throw new Error(new TextDecoder().decode(p.stderr));return new TextDecoder("utf8",{fatal:true}).decode(p.stdout).trim();
}
const pin="430261138aa08539cd598b9269bfe8f82fd49b78";
if(capture(["git","rev-parse","HEAD"])!==pin)throw new Error("Wrong source commit");
if(capture(["git","status","--porcelain"]))throw new Error("Source must start clean");
if(capture(["git","status","--porcelain"],process.cwd()))throw new Error("Commit harness before measurement");
const minimumFreeGiB=Number(process.env.TWIG_REPRO_MIN_FREE_GIB??64);
if(!Number.isSafeInteger(minimumFreeGiB)||minimumFreeGiB<32)throw new Error("Minimum free-space guard must be at least 32GiB");
const git=capture(["which","git"]);
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
type Arm={name:string;binary:string;native:boolean;version:string;sha256:string};
const arms:Arm[]=[
 {name:"git",binary:git,native:false},
 {name:"released-v03",binary:resolve(v03Arg!),native:false},
 {name:"reported-870-rust1991",binary:resolve(reportedArg!),native:true},
 {name:"released-v04",binary:resolve(v04Arg!),native:true},
].map(a=>({...a,version:capture([a.binary,"--version"]),sha256:hash(a.binary)}));
const raw=Bun.spawnSync([git,"ls-tree","-rz","--full-tree",pin],{cwd:source,env,stdout:"pipe",stderr:"pipe"});
if(raw.exitCode)throw new Error("Cannot inventory target");
const records=new TextDecoder("utf8",{fatal:true}).decode(raw.stdout).split("\0").filter(Boolean).map(record=>{
 const split=record.indexOf("\t");const [mode,type,oid]=record.slice(0,split).split(" ");const name=record.slice(split+1);
 if(split<0||type!=="blob"||!oid?.match(/^[0-9a-f]{40}$/)||!["100644","100755","120000"].includes(mode!)||name.startsWith("/")||name.split("/").some(x=>x===".."||x.toLowerCase()===".git"))throw new Error("Unsupported inventory");
 return {mode:mode!,name};
});
if(records.length!==14811)throw new Error("Unexpected file count");
const sourcePaths=inventory(source);
const trackedNames=new Set(records.map(r=>r.name));
const ignoredFiles=sourcePaths.filter(name=>!trackedNames.has(name)).map(name=>({name,sha256:hash(join(source,name))}));
const points=join(source,"..","reproduction-points-"+basename(run));if(existsSync(points))throw new Error("Point directory exists");mkdirSync(points);
const attrs=readFileSync(join(source,".gitattributes"));
const metadata={schemaVersion:1,generatedAt:new Date().toISOString(),harnessCommit:capture([git,"rev-parse","HEAD"],process.cwd()),dirty:false,reportedCompiler:capture(["rustup","run","1.99.1","rustc","--version"]),inputCommit:pin,sourceDirectory:source,sourceObjectStore:capture([git,"count-objects","-vH"]),sourceAlternatesPresent:existsSync(join(source,".git/objects/info/alternates")),attributes:attrs.toString(),trackedFiles:records.length,ignoredSourceFiles:ignoredFiles.length,ignoredSourceInventorySHA256:createHash("sha256").update(JSON.stringify(ignoredFiles)).digest("hex"),environment:{os:capture(["sw_vers"]),cpu:capture(["sysctl","-n","machdep.cpu.brand_string"]),git:capture([git,"--version"])},arms,config:{minimumFreeGiB,repeats:3,concurrency:1,warmup:"No discarded first-use point; all first calls retained separately by repeat index. Later repeats are warm observations.",timeout:"No automatic kill; retain partial state for investigation.",reproductionCriterion:{reportedSeconds:120,reportedGitSeconds:6,flagSlowdownRatio:10,flagSeconds:60,flagGitMaximumSeconds:10}},notes:["Actual public v0.3 and v0.4 archives; exact reported870 source compiled with Rust1.99.1. v0.3 is expected to delegate for original attributes, not exhibit the reported native slowdown.","Ordinary full remote clone with local object pack, outside ignored target directory; no shared-clone alternates. Original attributes preserved.","Source and worktrees are on real host APFS. Actual hardware and OS are recorded in environment; they differ from the reporter's M3Max/macOS26.5.2. No competing controlled builds or fetches during measurement; shared Mac background activity remains possible.","Create timing excludes independent byte/mode/inventory/source-isolation checks. All fixtures and stderr/time resource logs retained. No rm, cleanup or measured retry.","No container performance claim and no recreation of a private repository from its published size alone."]};
writeFileSync(join(run,"manifest.json"),JSON.stringify(metadata,null,2)+"\n");
const results:any[]=[];let phase="running",current="",pid:number|null=null;let golden="";
function save(error?:string){writeFileSync(join(run,"state.tmp"),JSON.stringify({schemaVersion:1,phase,current,pid,supervisorPid:process.pid,updatedAt:new Date().toISOString(),results,error},null,2)+"\n");renameSync(join(run,"state.tmp"),join(run,"state.json"));}
function compareFiles(a:string,b:string){
 const sa=lstatSync(a),sb=lstatSync(b);if(!sa.isFile()||!sb.isFile()||sa.size!==sb.size)throw new Error("File length/type mismatch: "+b);
 const fa=openSync(a,"r"),fb=openSync(b,"r"),ba=Buffer.allocUnsafe(128*1024),bb=Buffer.allocUnsafe(128*1024);
 try{let n:number;do{n=readSync(fa,ba);const m=readSync(fb,bb);if(m!==n||!ba.subarray(0,n).equals(bb.subarray(0,m)))throw new Error("Raw byte mismatch: "+b);}while(n);}finally{closeSync(fa);closeSync(fb);}
}
function inventory(root:string,relative=""):string[]{return readdirSync(join(root,relative)).flatMap(name=>{if(!relative&&name===".git")return[];const path=join(relative,name);return lstatSync(join(root,path)).isDirectory()?inventory(root,path):[path];}).sort();}
function verify(destination:string){
 const expectedPaths=destination===source?sourcePaths:records.map(r=>r.name).sort();
 if(JSON.stringify(inventory(destination))!==JSON.stringify(expectedPaths))throw new Error("Extra/missing paths");
 if(destination===source)for(const ignored of ignoredFiles)if(hash(join(source,ignored.name))!==ignored.sha256)throw new Error("Ignored source changed");
 for(const entry of records){const a=join(golden,entry.name),b=join(destination,entry.name),s=lstatSync(b);
  if(entry.mode==="120000"){if(!s.isSymbolicLink()||!readlinkSync(a,{encoding:"buffer"}).equals(readlinkSync(b,{encoding:"buffer"})))throw new Error("Symlink mismatch");}
  else{if((s.mode&0o111)!==(entry.mode==="100755"?0o111:0))throw new Error("Executable mode mismatch");compareFiles(a,b);const original=lstatSync(join(source,entry.name));if(destination!==source&&s.dev===original.dev&&s.ino===original.ino)throw new Error("Source hardlink");}
 }
}
try{
 for(let repeat=0;repeat<3;repeat++){
  const order=repeat%2?[...arms].reverse():arms;
  for(const arm of order){
   const space=statfsSync(source);if(space.bavail*space.bsize<minimumFreeGiB*2**30)throw new Error("Free-space guard");
   current=`${arm.name}-r${repeat}`;const destination=join(points,current);if(existsSync(destination))throw new Error("Existing destination");
   const args=arm.name==="git"?[git,"worktree","add","--detach",destination,"HEAD"]:[arm.binary,"new","--detach",destination,"HEAD"];
   const loadBefore=loadavg();const out=openSync(join(run,current+".stdout"),"wx"),err=openSync(join(run,current+".stderr"),"wx");
   console.log(new Date().toISOString(),"START",current);const start=performance.now();
   const child=Bun.spawn(["/usr/bin/time","-l",...args],{cwd:source,env,stdin:"ignore",stdout:out,stderr:err});pid=child.pid;save();const exitCode=await child.exited;const elapsedMs=performance.now()-start;closeSync(out);closeSync(err);
   const stderr=readFileSync(join(run,current+".stderr"),"utf8");
   const point:any={arm:arm.name,repeat,args,exitCode,elapsedMs,loadBefore,loadAfter:loadavg(),nativeCow:stderr.includes("CoW: verified tracked files"),verified:false,sourceUnchanged:false,privateWriteIsolated:false};results.push(point);save();
   if(exitCode!==0||point.nativeCow!==arm.native)throw new Error("Exit/native selection mismatch: "+current);
   if(!golden)golden=destination;
   verify(destination);verify(source);
   if(capture([git,"status","--porcelain"],destination))throw new Error("Destination is not clean");
   if(!readFileSync(join(source,".gitattributes")).equals(attrs))throw new Error("Source attributes changed");
   const file=join(destination,".gitattributes"),original=readFileSync(file);appendFileSync(file,"\n# private verification write\n");
   try{if(!readFileSync(join(source,".gitattributes")).equals(attrs))throw new Error("Private write leaked");}finally{writeFileSync(file,original);}
   point.verified=true;point.sourceUnchanged=true;point.privateWriteIsolated=true;pid=null;save();console.log(new Date().toISOString(),"DONE",current,(elapsedMs/1000).toFixed(3)+"s");
  }
 }
 phase="finished";save();
}catch(error){phase="failed";save(String(error));throw error;}
