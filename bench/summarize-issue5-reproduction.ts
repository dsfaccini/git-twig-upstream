#!/usr/bin/env bun
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const root="bench/results/multi-build/macos-apfs/2026-11-17/issue5-reproduction";
const definitions=[
 ["M1 Ultra — ordinary clone","ordinary-clone"],
 ["M1 Ultra — nested ignored 50k","nested-ignored-50000"],
 ["M1 Ultra — top-level ignored 50k","top-level-ignored-50000"],
 ["M4 Pro — ordinary clone","m4/ordinary-clone"],
];
const arms=["git","released-v03","reported-870-rust1991","released-v04"];
const colors=["#89938b","#5c83aa","#bd765c","#729953"];
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
let verified=0;
const scenarios=definitions.map(([name,directory])=>{
 const base=join(root,directory!);const state=JSON.parse(readFileSync(join(base,"state.json"),"utf8"));const manifest=JSON.parse(readFileSync(join(base,"manifest.json"),"utf8"));
 if(state.phase!=="finished"||state.error||manifest.dirty!==false||state.results.length!==12)throw new Error("Incomplete scenario");
 const statistics=arms.map(arm=>{
  const points=state.results.filter((p:any)=>p.arm===arm);if(points.length!==3)throw new Error("Expected three repetitions");
  const phases:any[]=[];const resources:any[]=[];
  for(const point of points){
   if(point.exitCode||!point.verified||!point.sourceUnchanged||!point.privateWriteIsolated)throw new Error("Failed correctness check");verified++;
   const stderr=readFileSync(join(base,`${arm}-r${point.repeat}.stderr`),"utf8");
   const phase=stderr.match(/native preparation: snapshot ([\d.]+)s; raw verification\/repair ([\d.]+)s; total ([\d.]+)s/);
   if(phase)phases.push({snapshotMs:Number(phase[1])*1000,verificationMs:Number(phase[2])*1000,totalPreparationMs:Number(phase[3])*1000});
   const time=stderr.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);const rss=stderr.match(/(\d+)\s+maximum resident set size/);
   resources.push({userCpuSeconds:time?Number(time[2]):null,systemCpuSeconds:time?Number(time[3]):null,maxRssBytes:rss?Number(rss[1]):null});
  }
  const times=points.map((p:any)=>p.elapsedMs);return{arm,samples:3,p50Ms:median(times),empiricalP95Ms:Math.max(...times),empiricalP99Ms:Math.max(...times),minMs:Math.min(...times),maxMs:Math.max(...times),logicalPayloadBytesPerSecond:1255510318/(median(times)/1000),trackedFilesPerSecond:14811/(median(times)/1000),resources,phases};
 });
 const git=statistics[0]!,old=statistics[2]!;
 return{name,directory,environment:manifest.environment,ignoredSourceFiles:manifest.ignoredSourceFiles??0,statistics,severeSlowdownObserved:old.p50Ms>=60000&&old.p50Ms/git.p50Ms>=10&&git.p50Ms<=10000};
});
const summary={schemaVersion:1,inputCommit:"430261138aa08539cd598b9269bfe8f82fd49b78",verifiedMeasuredCreates:verified,scenarios,notes:["Reported target is about120s vsGit6s; no scenario is considered the reporter's exact environment. Both chips/OS builds differ from M3Max/macOS26.5.2.","Empirical p95/p99 are maxima of only three points, not reliable tail estimates.","Logical payload throughput is not physical disk IO bandwidth. CPU/RSS include the timed command's children via /usr/bin/time -l.","Ignored-file scenarios are synthetic controlled donor-state hypotheses, not evidence about Pablo's checkout. No dependency/application scripts executed.","Published v0.3 delegates with unchanged attributes; the reported slow native baseline is exact870f52e compiled with Rust1.99.1."]};
writeFileSync(join(root,"summary.json"),JSON.stringify(summary,null,2)+"\n");
const width=1000,rowHeight=140,height=130+scenarios.length*rowHeight;const max=Math.max(...scenarios.flatMap(s=>s.statistics.map(a=>a.maxMs)))*1.1;const scale=620/max;
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fafbf8"/><g font-family="system-ui,sans-serif" fill="#26352a"><text x="24" y="32" font-size="22">Issue #5 — direct CLI reproduction attempts</text><text x="24" y="57" font-size="13">Unchanged pulumi/docs input · 3 samples per arm · bars=median, whiskers=min–max · creation only</text>`;
arms.forEach((a,i)=>{svg+=`<rect x="${24+i*244}" y="76" width="12" height="12" fill="${colors[i]}"/><text x="${42+i*244}" y="87" font-size="12">${a}</text>`;});
scenarios.forEach((scenario,index)=>{
 const y=120+index*rowHeight;svg+=`<text x="24" y="${y+18}" font-size="14">${scenario.name}</text>`;
 scenario.statistics.forEach((arm,i)=>{const by=y+i*25;svg+=`<rect x="290" y="${by}" width="${arm.p50Ms*scale}" height="15" fill="${colors[i]}"/><path d="M${290+arm.minMs*scale} ${by+7}H${290+arm.maxMs*scale}" stroke="#26352a"/><text x="${300+arm.maxMs*scale}" y="${by+12}" font-size="12">${(arm.p50Ms/1000).toFixed(2)} s</text>`;});
});
svg+="</g></svg>";writeFileSync(join(root,"comparison.svg"),svg+"\n");
console.log(JSON.stringify({verifiedMeasuredCreates:verified,scenarios:scenarios.map(s=>({name:s.name,severeSlowdownObserved:s.severeSlowdownObserved,medianSeconds:s.statistics.map(a=>({arm:a.arm,seconds:a.p50Ms/1000}))}))},null,2));
