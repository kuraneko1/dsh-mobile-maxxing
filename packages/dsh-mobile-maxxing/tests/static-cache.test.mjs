import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";
const source=readFileSync(new URL("../sw.js",import.meta.url),"utf8");
function worker({immutable=false,miss=false,entries=0,control,dated=Date.now(),age="0"}={}) {
 const count={fetch:0,put:0,keys:0};
 const cached=new Response("cached",{headers:{"cache-control":control??(immutable?"public,max-age=31536000,immutable":"no-cache"),date:new Date(dated).toUTCString(),age}});
 const stored=new Map([["https://test.invalid/",cached]]);
 for(let i=0;i<entries;i++)stored.set("https://test.invalid/assets/old-"+i+".js",cached);
 const cache={match:async()=>miss?undefined:cached.clone(),put:async(req,res)=>{count.put++;stored.set(typeof req==="string"?req:req.url,res)},keys:async()=>{count.keys++;return [...stored.keys()].map(url=>({url}))},delete:async key=>stored.delete(key.url)};
 const sandbox={URL,Request,Response,AbortController,setTimeout,clearTimeout,console,self:{registration:{scope:"https://test.invalid/"},addEventListener(){}},caches:{open:async()=>cache},fetch:async()=>{count.fetch++;return new Response("new",{headers:{"cache-control":"public,max-age=31536000,immutable"}})}};
 vm.runInNewContext(source+";globalThis.handle=handleStatic",sandbox);
 return{handle:()=>sandbox.handle(new Request("https://test.invalid/assets/chunk-ab12cd34.js")),count,stored};
}
test("#144 immutable cache hits do no network, writes or full scans",async()=>{const w=worker({immutable:true});for(let i=0;i<20;i++)assert.equal(await(await w.handle()).text(),"cached");assert.deepEqual(w.count,{fetch:0,put:0,keys:0})});
test("#144 mutable hits still revalidate but never trim an unchanged key set",async()=>{const w=worker();await w.handle();await Promise.resolve();assert.equal(w.count.fetch,1);assert.equal(w.count.put,1);assert.equal(w.count.keys,0)});
test("#144 newly cached assets remain bounded and protect the offline shell",async()=>{const w=worker({miss:true,entries:250});await w.handle();assert.equal(w.count.fetch,1);assert.equal(w.count.put,1);assert.equal(w.count.keys,1);assert.equal(w.stored.size,250);assert.ok(w.stored.has("https://test.invalid/"))});

test("#144 fresh icons reuse their one-day cache without writes",async()=>{const w=worker({control:"public,max-age=86400"});await w.handle();assert.deepEqual(w.count,{fetch:0,put:0,keys:0})});
test("#144 expired immutable responses revalidate rather than live forever",async()=>{const w=worker({control:"public,max-age=60,immutable",dated:Date.now()-120000});await w.handle();assert.equal(w.count.fetch,1)});
test("#144 no-cache overrides max-age and Age cannot extend freshness",async()=>{for(const options of [{control:"public,max-age=86400,no-cache"},{control:"public,max-age=60",age:"120"},{control:"public,max-age=60",age:"invalid"}]){const w=worker(options);await w.handle();assert.equal(w.count.fetch,1)}});


/** A worker whose cache writes stay pending until released. */
function slowWriter({preload}={}){
 let release;const gate=new Promise((resolve)=>{release=resolve;});const count={fetch:0,put:0,putDone:0};const waits=[];
 const cache={match:async()=>undefined,put:async()=>{count.put++;await gate;count.putDone++;},keys:async()=>[],delete:async()=>true};
 const sandbox={URL,Request,Response,AbortController,setTimeout,clearTimeout,console,self:{registration:{scope:"https://test.invalid/"},addEventListener(){}},caches:{open:async()=>cache},fetch:async()=>{count.fetch++;return new Response("net",{headers:{"content-type":"text/html"}});}};
 vm.runInNewContext(source+";globalThis.handleStatic=handleStatic;globalThis.handleNavigation=handleNavigation",sandbox);
 const event={request:new Request("https://test.invalid/"),preloadResponse:preload,waitUntil:(promise)=>waits.push(promise)};
 return{sandbox,count,release,waits,event};
}
test("a first-visit asset is returned before its cache write finishes",async()=>{
 const w=slowWriter();const waits=[];
 const response=await w.sandbox.handleStatic(new Request("https://test.invalid/assets/chunk-new.js"),(work)=>waits.push(work));
 assert.equal(await response.text(),"net");
 assert.equal(w.count.put,1);assert.equal(w.count.putDone,0,"the page waited for the cache write");
 assert.equal(waits.length,1,"the write is not kept alive with waitUntil");
 w.release();await waits[0];assert.equal(w.count.putDone,1);
});
test("a navigation uses the preloaded response and stores the shell in the background",async()=>{
 const w=slowWriter({preload:Promise.resolve(new Response("preloaded",{headers:{"content-type":"text/html"}}))});
 const response=await w.sandbox.handleNavigation(w.event);
 assert.equal(await response.text(),"preloaded");
 assert.equal(w.count.fetch,0,"the preloaded response was fetched a second time");
 // A constructed Response is not type "basic", so no shell write is queued here.
 w.release();
});
test("a navigation without preload still fetches, and falls back to the stored shell offline",async()=>{
 const w=slowWriter();
 assert.equal(await (await w.sandbox.handleNavigation(w.event)).text(),"net");
 assert.equal(w.count.fetch,1);
 w.release();
 assert.match(source,/navigationPreload\?\.enable\(\)/,"navigation preload is not enabled at activation");
});
