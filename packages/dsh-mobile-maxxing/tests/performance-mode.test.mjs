import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
function extract(name){const start=source.indexOf('    function '+name+'(');assert.ok(start>=0);const end=source.indexOf('\n    }',start)+6;return vm.runInNewContext('('+source.slice(start,end)+')');}
const write=extract('writeOwnedAttribute'),remove=extract('removeOwnedAttribute');
function node(){const attrs=new Map();return{sets:0,removes:0,getAttribute:k=>attrs.get(k)??null,hasAttribute:k=>attrs.has(k),setAttribute(k,v){this.sets++;attrs.set(k,v)},removeAttribute(k){this.removes++;attrs.delete(k)}};}
test('#144 stable marker passes perform no attribute writes',()=>{const el=node();write(el,'data-rdsh-session','');for(let i=0;i<100;i++)write(el,'data-rdsh-session','');assert.equal(el.sets,1);});
test('#144 marker changes stringify like DOM and are not swallowed',()=>{const el=node();write(el,'aria-expanded',false);write(el,'aria-expanded',false);write(el,'aria-expanded',true);write(el,'data-count',1);write(el,'data-count','1');assert.equal(el.sets,3);assert.equal(el.getAttribute('aria-expanded'),'true');});
test('#144 removing an absent marker is a no-op',()=>{const el=node();remove(el,'data-rdsh-running');assert.equal(el.removes,0);write(el,'data-rdsh-running','');remove(el,'data-rdsh-running');remove(el,'data-rdsh-running');assert.equal(el.removes,1);});

const effectiveMotion=extract('effectiveMotion');
test('#144 OS reduced motion is the default, not an explicit override',()=>{assert.equal(effectiveMotion(null,false),'standard');assert.equal(effectiveMotion(null,true),'reduced');assert.equal(effectiveMotion('invalid',true),'reduced');for(const mode of ['standard','reduced','off'])assert.equal(effectiveMotion(mode,true),mode);});

function motionHarness({mobile=true,reduced=false,storage=new Map(),denied=false}={}) {
 const root=node();const state={motion:null};let writes=0;
 const head=[];const sandbox={phone:()=>mobile,MOTION_KEY:'dsh-mobile-maxxing:motion',motionQuery:{matches:reduced},state,onDemandStyles:new Map(),CSS_MOTION:'/* motion */',
 document:{documentElement:root,head:{append(style){style.isConnected=true;head.push(style)}},createElement(){const attrs=new Map();return{isConnected:false,textContent:'',setAttribute:(k,v)=>attrs.set(k,v),getAttribute:k=>attrs.get(k)??null,remove(){this.isConnected=false;head.splice(head.indexOf(this),1)}}}},emit:patch=>Object.assign(state,patch),clearTypingAnimations(){},
 localStorage:{getItem:key=>{if(denied)throw Error('denied');return storage.get(key)??null},setItem(key,value){writes++;if(denied)throw Error('denied');storage.set(key,value)},removeItem(key){writes++;storage.delete(key)}}};
 for(const name of ['effectiveMotion','writeOwnedAttribute','readMotion','currentMotion','applyMotion','writeMotion','syncOnDemandStyle']) {const start=source.indexOf('    function '+name+'(');const end=source.indexOf(String.fromCharCode(10)+'    }',start)+6;vm.runInNewContext(source.slice(start,end),sandbox)}
 state.motion=sandbox.readMotion();sandbox.applyMotion();return{api:sandbox,state,root,storage,head,writes:()=>writes};
}
test('#144 motion preference survives reload without changing shared settings',()=>{const first=motionHarness();first.api.writeMotion('off');assert.equal(first.root.getAttribute('data-rdsh-motion'),'off');const next=motionHarness({storage:first.storage});assert.equal(next.state.motion,'off');assert.equal(next.api.currentMotion(),'off');assert.deepEqual([...first.storage.keys()],['dsh-mobile-maxxing:motion']);});
test('#144 OS preference applies only until the user chooses an override',()=>{const h=motionHarness({reduced:true});assert.equal(h.api.currentMotion(),'reduced');h.api.writeMotion('standard');assert.equal(h.api.currentMotion(),'standard');h.api.motionQuery.matches=false;h.api.writeMotion(null);assert.equal(h.api.currentMotion(),'standard');h.api.motionQuery.matches=true;h.api.applyMotion();assert.equal(h.root.getAttribute('data-rdsh-motion'),'reduced');});
test('#144 desktop reads and writes no motion preference or marker',()=>{const storage=new Map([['dsh-mobile-maxxing:motion','off']]);const h=motionHarness({mobile:false,storage});h.api.writeMotion('reduced');assert.equal(h.writes(),0);assert.equal(h.root.sets,0);assert.equal(storage.get('dsh-mobile-maxxing:motion'),'off');});
test('#144 storage failure still applies the page-local choice',()=>{const h=motionHarness({denied:true});h.api.writeMotion('off');assert.equal(h.state.motion,'off');assert.equal(h.root.getAttribute('data-rdsh-motion'),'off');});
const needsFast=extract('needsFastPass');
test('#144 only text-only paragraph mutations inside the chat skip fast decoration',()=>{const target={tagName:'P',closest:selector=>selector==='[data-rdsh-center-col]'?{}:null};const record={type:'childList',target,addedNodes:[{nodeType:3}],removedNodes:[]};assert.equal(needsFast(record),false);assert.equal(needsFast({...record,addedNodes:[{nodeType:1}]}),true);assert.equal(needsFast({...record,type:'attributes'}),true);assert.equal(needsFast({...record,target:{...target,tagName:'BUTTON'}}),true);assert.equal(needsFast({...record,target:{...target,closest:()=>null}}),true);});

test('#144 Settings CSS is absent at chat boot and has one scoped lifetime',()=>{
 const start=source.indexOf('    function syncSettingsStyle('),end=source.indexOf(String.fromCharCode(10)+'    }',start)+6;let created=0,removed=0;let mobile=true;
 const sandbox={settingsStyle:null,CSS_SETTINGS:'/* settings */',phone:()=>mobile,document:{createElement(){created++;return{setAttribute(){},remove(){removed++}}},head:{append(){}}}};
 vm.runInNewContext(source.slice(start,end),sandbox);sandbox.syncSettingsStyle(null);assert.equal(created,0);sandbox.syncSettingsStyle({});sandbox.syncSettingsStyle({});assert.equal(created,1);sandbox.syncSettingsStyle(null);assert.equal(removed,1);mobile=false;sandbox.syncSettingsStyle({});assert.equal(created,1);
 const css=source.slice(source.indexOf('const CSS_PHONE ='),source.indexOf('const CSS = CSS_DEVICE'));assert.ok(!css.includes('Settings: full screen'));
});




test('#144 a transient decoration failure retries fast work after a text-only mutation',()=>{
 const frames=[],calls=[];const sandbox={live:true,scheduled:false,fastDirty:true,lastDecorateAt:0,DECORATE_MIN_MS:120,Date:{now:()=>1000},globalThis:{__RDSH_MOBILE_UX_RUNNING__:new Set()},requestAnimationFrame:run=>frames.push(run),console:{error(){}},decorate(fast){calls.push(fast);if(calls.length===1)throw Error('service temporarily missing')}};
 const start=source.indexOf('    function scheduleDecorate('),end=source.indexOf(String.fromCharCode(10)+'    }',start)+6;vm.runInNewContext(source.slice(start,end),sandbox);sandbox.scheduleDecorate();frames.shift()();sandbox.scheduleDecorate({fast:false});frames.shift()();assert.deepEqual(calls,[true,true]);
});


test('#144 the universal motion overrides exist only while motion is reduced or off',()=>{
 const h=motionHarness();
 assert.equal(h.head.length,0,'the standard setting pays for no universal rule');
 h.api.writeMotion('reduced');assert.equal(h.head.length,1);assert.equal(h.head[0].textContent,'/* motion */');
 h.api.writeMotion('off');assert.equal(h.head.length,1,'switching between reduced and off keeps one sheet');
 h.api.writeMotion('standard');assert.equal(h.head.length,0,'back to standard removes the sheet');
 const os=motionHarness({reduced:true});assert.equal(os.head.length,1,'the OS reduced preference installs it at boot');
});
test('#144 the universal motion rules are not part of the always-on phone sheet',()=>{
 const css=source.slice(source.indexOf('const CSS_PHONE ='),source.indexOf('const CSS = CSS_DEVICE'));
 assert.ok(!css.includes('html[data-rdsh-motion="off"] *'),'the phone sheet still carries a universal motion rule');
 const motion=source.slice(source.indexOf('const CSS_MOTION ='),source.indexOf('const CSS_FILES_HIGHLIGHT ='));
 assert.ok(motion.includes('html[data-rdsh-motion="reduced"] *'));
 assert.ok(motion.includes('html[data-rdsh-motion="off"] * { scroll-behavior: auto !important; }'));
});

test('markup inside a message body skips fast decoration unless it brings a control',()=>{
 const inMarkdown=(tagName)=>({tagName,closest:(selector)=>selector==='[data-rdsh-center-col]'||selector==='[data-chat-flow-kind] [class*="_markdown"]'?{}:null});
 const element=(control)=>({nodeType:1,matches:()=>control==='self',querySelector:()=>control==='inside'?{}:null});
 const record=(target,added,removed=[])=>({type:'childList',target,addedNodes:added,removedNodes:removed});
 // A streamed list item, table cell or highlighter span: nothing to decorate.
 assert.equal(needsFast(record(inMarkdown('UL'),[element(null),{nodeType:3}])),false);
 assert.equal(needsFast(record(inMarkdown('SPAN'),[],[element(null)])),false);
 // A control, a link or a labelled node arriving (or leaving) still runs the pass.
 assert.equal(needsFast(record(inMarkdown('DIV'),[element('inside')])),true);
 assert.equal(needsFast(record(inMarkdown('DIV'),[element('self')])),true);
 assert.equal(needsFast(record(inMarkdown('DIV'),[],[element('inside')])),true);
 // Outside a message body any element change runs the pass, as before.
 const chat={tagName:'DIV',closest:(selector)=>selector==='[data-rdsh-center-col]'?{}:null};
 assert.equal(needsFast(record(chat,[element(null)])),true);
 // The control list covers what the decorators act on.
 const body=source.slice(source.indexOf('    function needsFastPass('),source.indexOf('    function scheduleDecorate('));
 for(const selector of ['button','a','input','img','[role]','[aria-label]','[data-slot]'])assert.ok(body.includes(selector),selector);
});
