import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function createBoot(){
 const timers=new Map(),listeners={};let time=0,nextTimer=0;
 const classes=()=>({values:new Set(),add(value){this.values.add(value);},remove(value){this.values.delete(value);}});
 const items=Array.from({length:3},()=>({classList:classes(),style:{setProperty(){}}}));
 const root={classList:classes(),attributes:new Set(['inert']),removeAttribute(name){this.attributes.delete(name);},querySelectorAll:()=>items};
 const skip={addEventListener(name,fn){listeners[name]=fn;}};
 const splash={classList:classes(),removed:false,inert:false,setAttribute(){},remove(){this.removed=true;},querySelector(selector){return selector==='img'?{decode:async()=>{}}:skip;}};
 const html={classList:classes()};
 const context=vm.createContext({crypto:{randomUUID},performance:{now:()=>time},setTimeout(fn,ms){timers.set(++nextTimer,{fn,ms,due:time+ms});return nextTimer;},clearTimeout(id){timers.delete(id);},window:{matchMedia:()=>({matches:false})},document:{documentElement:html,fonts:{ready:Promise.resolve()},addEventListener(){},querySelector:selector=>selector==='#root'?root:selector==='#boot-splash'?splash:null}});
 vm.runInContext(readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'')+'\nglobalThis.intro=BootExperience;',context);
 return {context,root,splash,html,timers,listeners,items,async tick(ms){time+=ms;for(const [id,timer]of [...timers])if(timer.due<=time){timers.delete(id);timer.fn();}await settle();}};
}
test('intro stays visible for 2.8 seconds, then skeleton stays visible for one full second before content',async()=>{
 const b=createBoot();b.context.intro.start();let complete=false;const stage=b.context.intro.beforeContent().then(()=>{complete=true;});await settle();
 await b.tick(2799);assert.equal(b.context.intro.hidden,false);assert.equal(complete,false);
 await b.tick(1);assert.equal(b.context.intro.hidden,true);assert.ok(!b.root.attributes.has('inert'));assert.ok(!b.root.classList.values.has('boot-content-enter'));
 await b.tick(430);assert.equal(b.splash.removed,true);assert.equal(complete,false);
 await b.tick(999);assert.equal(complete,false);await b.tick(1);await stage;assert.equal(complete,true);
 await b.context.intro.finish();assert.ok(b.root.classList.values.has('boot-content-enter'));assert.ok(b.items.every(item=>item.classList.values.has('boot-item-visible')));
});
test('skip and a stalled request never trap the visitor behind the intro',async()=>{
 const skipped=createBoot();skipped.context.intro.start();skipped.listeners.click();assert.equal(skipped.context.intro.ready,false);assert.equal(skipped.context.intro.skipped,true);assert.ok(!skipped.root.attributes.has('inert'));
 const slow=createBoot();slow.context.intro.start();await slow.tick(6500);assert.ok(!slow.root.attributes.has('inert'));assert.equal(slow.context.intro.ready,false);
 const skeleton=vm.runInContext('visitorSkeleton()',slow.context);assert.ok(skeleton.includes('role="status"'));assert.ok(skeleton.includes('visitor-loading-hero'));assert.equal((skeleton.match(/class="visitor-loading-card"/g)||[]).length,4);
});
test('elements enter on viewport intersection; reduced motion avoids the staged animations',async()=>{
 const b=createBoot();let onIntersection;const observed=new Set();b.context.window.IntersectionObserver=class{constructor(callback){onIntersection=callback;}observe(item){observed.add(item);}unobserve(item){observed.delete(item);}};b.context.intro.start();b.context.intro.reveal();assert.equal(observed.size,3);assert.ok(b.items.every(item=>item.classList.values.has('boot-item-pending')));assert.ok(b.items.every(item=>!item.classList.values.has('boot-item-visible')));onIntersection([{target:b.items[0],isIntersecting:true},{target:b.items[1],isIntersecting:false}]);assert.ok(b.items[0].classList.values.has('boot-item-visible'));assert.ok(!b.items[1].classList.values.has('boot-item-visible'));assert.equal(observed.size,2);
 const reduced=createBoot();reduced.context.window.matchMedia=()=>({matches:true});reduced.context.intro.start();const finish=reduced.context.intro.finish();await settle();await reduced.tick(100);await finish;assert.equal(reduced.context.intro.reduced,true);assert.ok(reduced.items.every(item=>!item.classList.values.has('boot-item-pending')));
});
