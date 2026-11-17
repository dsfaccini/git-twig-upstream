#!/usr/bin/env bun
// Generate data only: never run this repository's application/dependency scripts.
import { mkdirSync, existsSync, writeFileSync, statfsSync } from "node:fs";
import { resolve, join } from "node:path";
const [sourceArg,countArg,manifestArg]=process.argv.slice(2);
if(!sourceArg||!countArg||!manifestArg)throw new Error("SOURCE COUNT MANIFEST required");
const source=resolve(sourceArg),count=Number(countArg),manifest=resolve(manifestArg);
if(!source.includes("/exp-issue5-reproduction-fixtures/")||!Number.isSafeInteger(count)||count<1||count>100000)throw new Error("Only bounded owned fixture directories allowed");
const root=join(source,"theme/node_modules",`twig-issue5-fixture-${count}`);
if(existsSync(root)||existsSync(manifest))throw new Error("Never overwrite a fixture or manifest");
const free=statfsSync(source);if(free.bavail*free.bsize<64*2**30)throw new Error("64 GiB guard");
mkdirSync(root,{recursive:true});const start=performance.now();
for(let index=0;index<count;index++){
 const directory=join(root,`package-${Math.floor(index/16).toString().padStart(6,"0")}`);
 mkdirSync(directory,{recursive:true});writeFileSync(join(directory,`file-${index.toString().padStart(6,"0")}.txt`),`Twig synthetic ignored donor file ${index}\n`+"x".repeat(256),{flag:"wx"});
 if(index%10000===0)console.log(index,"/",count);
}
writeFileSync(manifest,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),source,root,count,layout:"16 files per generated package; nested inside tracked theme ancestor; node_modules ignored by original .gitignore",setupMs:performance.now()-start,notes:["Synthetic donor-state hypothesis, not evidence that Pablo had these files.","No application or dependency scripts executed; original attributes and tracked files untouched."]},null,2)+"\n",{flag:"wx"});
