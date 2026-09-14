import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLiveEvent, emptyLiveSnapshot, parseEvent, writeRegistry, type RegistryRecord } from "../agent/lib/arc-runtime.ts";

const record=(home:string):RegistryRecord=>({schemaVersion:1,sessionId:"eve-session",runId:"run-1",label:"monitor",mode:"analyze",route:"",backend:"arc-orchestrator",model:null,cwd:process.cwd(),status:"running",startedAt:"2025-01-01T00:00:00.000Z",heartbeatAt:"2025-01-01T00:00:00.000Z",staleAfterMs:30000,liveActivity:emptyLiveSnapshot()});
const event=(data:any)=>parseEvent(`arc-orchestrator: event: ${JSON.stringify(data)}`)!;

test("session-run record is compatible, safe, atomic, and private",async()=>{const home=await mkdtemp(join(tmpdir(),"eve-monitor-"));const r=record(home);assert.equal(await writeRegistry(r,home),true);const file=join(home,"session-runs/eve-session/run-1.json");const parsed=JSON.parse(await readFile(file,"utf8"));for(const key of ["sessionId","runId","label","mode","route","backend","model","cwd","status","startedAt","heartbeatAt","staleAfterMs"])assert(key in parsed);assert.equal((await stat(file)).mode&0o777,0o600);assert.equal(await writeRegistry({...r,sessionId:"../shared"},home),false);});

test("terminal records reject late heartbeats and concurrent writes merge",async()=>{const home=await mkdtemp(join(tmpdir(),"eve-monitor-"));const r=record(home);await writeRegistry(r,home);await Promise.all([writeRegistry({...r,heartbeatAt:"2025-01-01T00:00:01.000Z"},home),writeRegistry({...r,status:"completed",endedAt:"2025-01-01T00:00:02.000Z"},home)]);const file=join(home,"session-runs/eve-session/run-1.json");const ended=JSON.parse(await readFile(file,"utf8"));assert.equal(ended.status,"completed");await writeRegistry({...r,heartbeatAt:"2099-01-01T00:00:00.000Z"},home);assert.deepEqual(JSON.parse(await readFile(file,"utf8")),ended);});

test("v1 events map to bounded structured live activity without sensitive text",()=>{let s=emptyLiveSnapshot();for(let i=1;i<=250;i++)s=applyLiveEvent(s,event({v:1,kind:"phase",seq:i,at:i,data:{phase:"plan",status:"running",model:"safe-model"}}));assert.equal(s.eventsSeen,200);assert(s.phaseHistory.length<=6);assert.equal(s.diffs.length,0);const files=event({v:1,kind:"files",seq:300,at:1,data:{count:2,files:[{file:"src/a.ts",status:"modified"},{file:".env",status:"unknown"}]}});assert.deepEqual(applyLiveEvent(emptyLiveSnapshot(),files).files?.files,[{file:"src/a.ts",status:"modified"}]);assert.equal(parseEvent("arc-orchestrator: event: {\"v\":2,\"kind\":\"diff\",\"seq\":1,\"at\":0,\"data\":{}}"),undefined);assert(!JSON.stringify(s).includes("contract"));});
