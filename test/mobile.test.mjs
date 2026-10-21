import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

function mobileContext(){
 const events={},history=[];const context=vm.createContext({crypto:{randomUUID},URL,console,setTimeout,location:{href:'http://localhost/admin',pathname:'/admin'},navigator:{userAgent:'iPhone',onLine:true},history:{pushState:(state,_,url)=>history.push({state,url:String(url)}),replaceState(){}},document:{addEventListener(){},querySelector:()=>null},window:{matchMedia:query=>({matches:query.includes('max-width')}),addEventListener:(name,handler)=>events[name]=handler,scrollTo(){}}});
 vm.runInContext(readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'')+'\n'+readFileSync('public/mobile.js','utf8')+'\nMobileUI.open=html=>globalThis.sheetHTML=html;MobileUI.close=()=>{};render=()=>{globalThis.rendered=true;};',context);return {context,events,history};
}
test('mobile navigation and More expose all allowed pages while preserving viewer restrictions',()=>{
 const {context}=mobileContext();vm.runInContext("user={role:'admin',username:'admin'};page='pos';globalThis.nav=mobileNavigation();MobileUI.more();",context);
 assert.ok(context.nav.includes('mobile-sale'));assert.ok(context.nav.includes('data-page="pos"'));assert.ok(context.nav.includes('aria-current="page"'));assert.ok(context.sheetHTML.includes('data-page="visitor"'));assert.ok(context.sheetHTML.includes('data-page="products"'));assert.ok(context.sheetHTML.includes('data-page="audit"'));
 vm.runInContext("user={role:'viewer',username:'viewer'};page='invoices';globalThis.nav=mobileNavigation();MobileUI.more();",context);
 for(const key of ['pos','visitor','settings']){assert.ok(!context.nav.includes(`data-page="${key}"`));assert.ok(!context.sheetHTML.includes(`data-page="${key}"`));}assert.ok(context.sheetHTML.includes('data-page="reports"'));assert.ok(context.nav.includes('viewer-nav'));
 const html=vm.runInContext("table(['العميل','الرصيد'],[['<b>Customer</b>','10 ₪']])",context);assert.ok(html.includes('data-label="العميل"'));assert.ok(html.includes('scope="col"'));
});
test('mobile back navigation supports allowed pages and never opens restricted viewer pages',()=>{
 const {context,events,history}=mobileContext();vm.runInContext("user={role:'viewer'};page='dashboard';MobileUI.trackPage('customers');",context);assert.ok(history[0].url.endsWith('?view=customers'));
 context.location.href='http://localhost/admin?view=settings';events.popstate();assert.equal(vm.runInContext('page',context),'dashboard');assert.ok(!context.rendered);
 context.location.href='http://localhost/admin?view=invoices';events.popstate();assert.equal(vm.runInContext('page',context),'invoices');assert.equal(context.rendered,true);
});
test('home-screen install is explicit, offers Safari instructions, and consumes the browser prompt once',async()=>{
 const {context,events}=mobileContext();await vm.runInContext('MobileUI.install()',context);assert.ok(context.sheetHTML.includes('Safari'));assert.ok(context.sheetHTML.includes('HTTPS'));
 let prompted=0,prevented=0;events.beforeinstallprompt({preventDefault(){prevented++;},async prompt(){prompted++;},userChoice:Promise.resolve({outcome:'accepted'})});assert.equal(prompted,0);assert.equal(prevented,1);await vm.runInContext('MobileUI.install()',context);assert.equal(prompted,1);assert.equal(vm.runInContext('MobileUI.installPrompt',context),null);
 const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/admin');assert.equal(manifest.dir,'rtl');assert.ok(readFileSync('public'+manifest.icons[0].src,'utf8').includes('<svg'));
});
