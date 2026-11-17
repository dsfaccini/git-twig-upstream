#!/usr/bin/env bun
import {existsSync,mkdirSync,writeFileSync,readFileSync,openSync,closeSync,statfsSync} from "node:fs";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
const base=resolve(process.argv[2]!);
if(!existsSync(join(base,"code/reproduce-issue5.ts")))throw new Error("Bootstrap code missing");
if(existsSync(join(base,"setup-state.json")))throw new Error("Never overwrite setup state");
const fs=statfsSync(base);if(fs.bavail*fs.bsize<48*2**30)throw new Error("At least48GiB needed before setup; estimated retained footprint<15GiB");
const env={...process.env,PATH:"/opt/homebrew/bin:"+process.env.PATH,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",TWIG_REPRO_MIN_FREE_GIB:"32"};
let phase="setup";
function save(error?:string){writeFileSync(join(base,"setup-state.json"),JSON.stringify({schemaVersion:1,phase,pid:process.pid,updatedAt:new Date().toISOString(),error},null,2)+"\n");}
async function run(argv:string[],cwd=base){console.log(new Date().toISOString(),argv.join(" "));const p=Bun.spawn(argv,{cwd,env,stdin:"ignore",stdout:"inherit",stderr:"inherit"});const exit=await p.exited;if(exit)throw new Error("Failed with exit "+exit+": "+argv[0]);}
save();
try{
 const code=join(base,"code");await run(["git","init","-b","main"],code);
 await run(["git","add","reproduce-issue5.ts"],code);
 await run(["git","-c","user.name=Twig benchmark","-c","user.email=twig@example.invalid","-c","commit.gpgsign=false","commit","-m","bench: frozen four-arm reproduction controller"],code);
 for(const version of ["0.3.0","0.4.0"]){
  const destination=join(base,"v"+version);mkdirSync(destination);
  const name=`git-twig-v${version}-aarch64-apple-darwin.tar.gz`;
  await run(["curl","-fL","--retry","2",`https://github.com/leostera/git-twig/releases/download/v${version}/${name}`,"-o",join(base,name)]);
  await run(["tar","-xzf",join(base,name),"-C",destination]);
 }
 await run(["rustup","toolchain","install","1.99.1","--profile","minimal"]);
 await run(["git","clone","--no-checkout","https://github.com/leostera/git-twig",join(base,"reported-source")]);
 await run(["git","checkout","--detach","870f52e02f5cf168f17fe5646da7312fc626225f"],join(base,"reported-source"));
 await run(["rustup","run","1.99.1","cargo","build","--release","--locked","-p","git-twig","--target-dir",join(base,"reported-target")],join(base,"reported-source"));
 await run(["git","clone","--no-checkout","https://github.com/pulumi/docs",join(base,"docs")]);
 await run(["git","checkout","--detach","430261138aa08539cd598b9269bfe8f82fd49b78"],join(base,"docs"));
 writeFileSync(join(base,"bootstrap.json"),JSON.stringify({schemaVersion:1,controllerSHA256:createHash("sha256").update(readFileSync(join(code,"reproduce-issue5.ts"))).digest("hex"),estimatedMaximumRetainedGiB:15,minimumFreeGiB:32,notes:["No existing installation upgraded or replaced; explicit toolchain1.99.1 installed alongside default.","Ordinary public clones; no Pulumi application or dependency scripts run. No fixture cleanup/deletion."]},null,2)+"\n");
 phase="measuring";save();
 const log=openSync(join(base,"controller.log"),"wx");const child=Bun.spawn(["bun",join(code,"reproduce-issue5.ts"),join(code,"results/ordinary-clone"),join(base,"docs"),join(base,"v0.3.0/git-twig"),join(base,"reported-target/release/git-twig"),join(base,"v0.4.0/git-twig")],{cwd:code,env,stdout:log,stderr:log,stdin:"ignore"});const exit=await child.exited;closeSync(log);if(exit)throw new Error("Measurement exit "+exit);
 phase="finished";save();
}catch(error){phase="failed";save(String(error));throw error;}
