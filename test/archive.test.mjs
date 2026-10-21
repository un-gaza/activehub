import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

test('deleting and restoring invoices preserves the ledger; customers with balances cannot be deleted',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'activehub-archive-'));const port=32000+Math.floor(Math.random()*10000);
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,CATALOG_SEED:'0'},stdio:['ignore','pipe','pipe']});let cookie;
 const api=async(path,body,session=cookie)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout')),10000);child.stdout.on('data',s=>{if(s.toString().includes('http://')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
  const creds=JSON.parse(readFileSync(resolve(dir,'initial-credentials.json'),'utf8'));cookie=(await api('login',{username:'admin',password:creds.admin})).cookie;const viewer=(await api('login',{username:'viewer',password:creds.viewer})).cookie;
  for(const entity of ['customer','invoice','payment'])for(const action of ['delete','restore'])assert.equal((await api(action+'/'+entity,{id:1},viewer)).status,403);
  await api('customers',{name:'عميل الحذف',phone:'0590000000',notes:''});await api('products',{name:'صنف تجريبي',price:5,cost:2,stock:10,minimum:2,service:false});
  await api('sales',{key:randomUUID(),customer_id:1,items:[{id:1,quantity:2}],paid:4,method:'cash'});
  const initial=(await api('data')).body;assert.equal(initial.customers[0].balance,600);assert.equal(initial.products[0].stock,8);
  assert.equal((await api('delete/payment',{id:1})).status,200);assert.equal((await api('delete/payment',{id:1})).status,200);
  const archivedPayment=(await api('data')).body;assert.equal(archivedPayment.payments[0].deleted,1);assert.equal(archivedPayment.payments[0].amount,400);assert.equal(archivedPayment.payments[0].status,'active');assert.equal(archivedPayment.customers[0].balance,600);assert.equal(archivedPayment.invoices[0].paid,400);
  assert.equal((await api('restore/payment',{id:1})).status,200);assert.equal((await api('data')).body.payments[0].deleted,0);assert.equal((await api('delete/payment',{id:999})).status,404);
  assert.equal((await api('delete/customer',{id:1})).status,409);assert.equal((await api('delete/invoice',{id:1})).status,200);assert.equal((await api('delete/invoice',{id:1})).status,200);
  let d=(await api('data')).body;assert.equal(d.invoices[0].deleted,1);assert.equal(d.invoices[0].status,'active');assert.equal(d.invoices[0].total,1000);assert.equal(d.payments[0].status,'active');assert.equal(d.customers[0].balance,600);assert.equal(d.products[0].stock,8);
  assert.equal((await api('restore/invoice',{id:1})).status,200);assert.equal((await api('data')).body.invoices[0].deleted,0);
  await api('payments',{key:randomUUID(),customer_id:1,amount:6,method:'cash'});assert.equal((await api('delete/customer',{id:1})).status,200);
  d=(await api('data')).body;assert.equal(d.customers[0].deleted,1);assert.equal(d.invoices[0].customer,'عميل الحذف');assert.equal(d.customers[0].balance,0);
  assert.equal((await api('sales',{key:randomUUID(),customer_id:1,items:[{id:1,quantity:1}],paid:5,method:'cash'})).status,400);
  assert.equal((await api('restore/customer',{id:1})).status,200);assert.equal((await api('data')).body.customers[0].deleted,0);
  assert.equal((await api('delete/invoice',{id:999})).status,404);assert.ok(d.audit.some(x=>x.action.includes('المحذوفات')));
 }finally{await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);child.kill();});rmSync(dir,{recursive:true,force:true});}
});

test('each core product uses a different Lucide SVG and archive controls respect the viewer role',()=>{
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');
 const ctx=vm.createContext({crypto:{randomUUID},document:{addEventListener(){},querySelector(){return null;}}});
 const fixture={settings:{currency:'₪'},customers:[{id:1,name:'ظاهر',phone:'',notes:'',balance:0,deleted:0},{id:2,name:'محذوف',phone:'',notes:'',balance:0,deleted:1}],products:[],invoices:[{id:1,created:new Date().toISOString(),customer:'ظاهر',total:500,paid:500,status:'active',deleted:1}],payments:[]};
 vm.runInContext(source+`\ndata=${JSON.stringify(fixture)};user={role:'admin'};globalThis.symbols=['ساعة الإنترنت','ساعة الكهرباء','ساعة الإنترنت والكهرباء','قهوة','نسكافيه','شاي','كابتشينو'].map(productIcon);globalThis.active=views.customers();customerView='deleted';globalThis.archived=views.customers();invoiceView='deleted';globalThis.invoiceArchive=views.invoices();user={role:'viewer'};globalThis.viewer=views.customers()+views.invoices();globalThis.pos=views.pos();`,ctx);
 assert.equal(new Set(ctx.symbols).size,7);for(const svg of ctx.symbols){assert.ok(svg.startsWith('<svg'));assert.ok(svg.includes('aria-hidden="true"'));}
 assert.ok(ctx.active.includes('ظاهر'));assert.ok(!ctx.active.includes('<b>محذوف</b>'));assert.ok(ctx.active.includes('data-action="delete-record"'));
 assert.ok(ctx.archived.includes('<b>محذوف</b>'));assert.ok(ctx.archived.includes('data-action="restore-record"'));assert.ok(ctx.invoiceArchive.includes('استعادة'));
 assert.ok(!ctx.viewer.includes('data-action="delete-record"'));assert.ok(!ctx.viewer.includes('data-action="restore-record"'));assert.ok(!ctx.pos.includes('value="2"'));
});
