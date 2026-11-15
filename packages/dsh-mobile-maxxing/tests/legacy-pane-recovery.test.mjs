import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import vm from "node:vm";
const source=readFileSync(new URL("../client.js",import.meta.url),"utf8");
const start=source.indexOf("    function dockLegacyFloatingTabs("),end=source.indexOf("\n    }",start)+6;
function pane(id,owner,{hidden=false}={}) {return{getAttribute:()=>id,closest(selector){return selector==="[hidden]"?hidden?{}:null:{getAttribute:()=>owner}}};}
function run({mobile=true,session="current",panes=[],available=true,broken=false}={}) {
 const calls=[],messages=[];const tabs=new Map(panes.map(p=>[p.getAttribute(),{terminalData:"preserved",host:"floating"}]));let queries=0;
 const sandbox={phone:()=>mobile,shownSessionId:()=>session,optionalService:()=>available?{dock(id){calls.push(id);if(broken)throw Error("not ready");tabs.get(id).host="docked"},close(){throw Error("must not close resources")}}:null,
 document:{querySelectorAll(){queries++;return panes}},console:{warn:(...args)=>messages.push(args)}};
 vm.runInNewContext(source.slice(start,end)+";dockLegacyFloatingTabs()",sandbox);return{calls,messages,tabs,queries};
}
test("retired floats return only the visible Session's panes to the dock without closing terminals",()=>{const a=pane("a","current"),b=pane("b","other"),c=pane("c","current",{hidden:true});const r=run({panes:[a,b,c]});assert.deepEqual(r.calls,["a"]);assert.equal(r.tabs.get("a").host,"docked");assert.equal(r.tabs.get("a").terminalData,"preserved");assert.equal(r.tabs.get("b").host,"floating");assert.equal(r.tabs.get("c").host,"floating")});
test("retired float migration never touches desktop or an unavailable controller",()=>{for(const options of[{mobile:false},{available:false},{session:""}]){const r=run({...options,panes:[pane("a","current")]});assert.deepEqual(r.calls,[]);assert.equal(r.queries,0)}});
test("a failed dock reports the problem without deleting terminal data",()=>{const r=run({broken:true,panes:[pane("a","current")]});assert.equal(r.messages.length,1);assert.equal(r.tabs.get("a").terminalData,"preserved");assert.equal(r.tabs.get("a").host,"floating")});
