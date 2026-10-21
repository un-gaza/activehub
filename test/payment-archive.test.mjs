import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

test('payment archive tabs, confirmation content and role-based actions',()=>{
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');
 const modal={innerHTML:'',classList:{add(){}},setAttribute(){},showModal(){this.open=true;}},form={};
 const ctx=vm.createContext({crypto:{randomUUID},document:{addEventListener(){},querySelector:s=>s==='#modal'?modal:s==='#delete-form'?form:null}});
 const fixture={settings:{currency:'₪'},customers:[],invoices:[],payments:[{id:31,customer:'عميل',amount:500,method:'cash',status:'active',deleted:0,created:new Date().toISOString()},{id:32,customer:'عميل',amount:200,method:'palpay',status:'active',deleted:1,created:new Date().toISOString()}]};
 vm.runInContext(source+`\ndata=${JSON.stringify(fixture)};user={role:'admin'};globalThis.active=views.invoices();paymentView='deleted';globalThis.archived=views.invoices();confirmRemoval('payment',31);user={role:'viewer'};globalThis.viewer=views.invoices();`,ctx);
 assert.ok(ctx.active.includes('RC-31'));assert.ok(!ctx.active.includes('RC-32'));assert.ok(ctx.active.includes('data-kind="payment"'));
 assert.ok(ctx.active.includes('data-action="delete-record"'));assert.ok(ctx.archived.includes('RC-32'));assert.ok(!ctx.archived.includes('RC-31'));assert.ok(ctx.archived.includes('data-action="restore-record"'));
 assert.ok(!ctx.viewer.includes('data-action="restore-record"'));assert.ok(!ctx.viewer.includes('data-action="delete-record"'));
 assert.equal(modal.open,true);assert.ok(modal.innerHTML.includes('حذف الدفعة من القائمة'));assert.ok(modal.innerHTML.includes('RC-31'));assert.ok(modal.innerHTML.includes('5.00'));assert.ok(modal.innerHTML.includes('ضمن حساب العميل والتقارير'));
});
