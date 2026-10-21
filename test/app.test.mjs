import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';

test('sales, receivables, persistence, reversal and server permissions',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'activehub-test-'));const restoreDir=mkdtempSync(resolve(tmpdir(),'activehub-restore-'));const port=31000+Math.floor(Math.random()*10000);let child;
 async function start(storage=dir){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,CATALOG_SEED:'0',PORT:String(port),DATA_DIR:storage},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('start timeout')),10000);child.stdout.on('data',s=>{if(s.toString().includes('http://')){clearTimeout(timer);resolve();}});child.once('exit',c=>{clearTimeout(timer);reject(new Error('server exit '+c));});});}
 async function stop(){if(!child||child.exitCode!==null)return;await new Promise(r=>{child.once('exit',r);child.kill();});}
 const request=async(path,body,cookie)=>{const res=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 try{await start();const creds=JSON.parse(readFileSync(resolve(dir,'initial-credentials.json'),'utf8'));assert.equal((await request('data')).status,401);
 const a=await request('login',{username:'admin',password:creds.admin});const v=await request('login',{username:'viewer',password:creds.viewer});assert.equal(a.status,200);assert.equal(v.status,200);
 assert.equal((await request('customers',{name:'forbidden',phone:'',notes:''},v.cookie)).status,403);
 assert.equal((await request('customers',{name:'Test Customer',phone:'0590000000',notes:''},a.cookie)).status,200);
 assert.equal((await request('products',{name:'Coffee',price:10,cost:3,stock:10,minimum:2,service:false},a.cookie)).status,200);
 const sale={key:randomUUID(),customer_id:1,items:[{id:1,quantity:2}],paid:10,discount:0,method:'cash'};
 const s=await request('sales',sale,a.cookie);assert.equal(s.status,200);assert.equal((await request('sales',sale,a.cookie)).body.invoice_id,s.body.invoice_id);
 let d=(await request('data',null,a.cookie)).body;assert.equal(d.invoices.length,1);assert.equal(d.customers[0].balance,1000);assert.equal(d.products[0].stock,8);
 assert.equal((await request('sales',{...sale,key:randomUUID(),items:[{id:1,quantity:9}]},a.cookie)).status,400);
 assert.equal((await request('sales',{...sale,key:randomUUID(),customer_id:null},a.cookie)).status,400);
 assert.equal((await request('payments',{key:randomUUID(),customer_id:1,amount:11,method:'cash'},a.cookie)).status,400);
 const p={key:randomUUID(),customer_id:1,amount:10,method:'cash'};assert.equal((await request('payments',p,a.cookie)).status,200);assert.equal((await request('payments',p,a.cookie)).status,200);
 d=(await request('data',null,v.cookie)).body;assert.equal(d.customers[0].balance,0);assert.equal(d.payments.length,2);assert.equal(d.invoices.length,1);
 await stop();await start();const a2=await request('login',{username:'admin',password:creds.admin});d=(await request('data',null,a2.cookie)).body;assert.equal(d.customers[0].balance,0);assert.equal(d.products[0].stock,8);
 assert.equal((await request('void',{id:1,reason:'test reversal'},a2.cookie)).status,200);d=(await request('data',null,a2.cookie)).body;assert.equal(d.products[0].stock,10);assert.equal(d.invoices[0].status,'void');assert.equal(d.customers[0].balance,-1000);
 assert.equal((await request('void',{id:1,reason:'repeat'},a2.cookie)).status,400);
 const refund={key:randomUUID(),customer_id:1,amount:10,method:'cash',reason:'credit refund'};
 assert.equal((await request('refunds',refund,a2.cookie)).status,200);assert.equal((await request('refunds',refund,a2.cookie)).status,200);
 d=(await request('data',null,a2.cookie)).body;assert.equal(d.customers[0].balance,0);assert.equal(d.payments.filter(x=>x.amount<0).length,1);
 const copy=spawnSync(process.execPath,['scripts/backup.mjs'],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'});assert.equal(copy.status,0);const restored=new DatabaseSync(copy.stdout.trim(),{readOnly:true});assert.equal(restored.prepare('SELECT COUNT(*) n FROM invoices').get().n,1);restored.close();
 const csrf=await fetch(`http://127.0.0.1:${port}/api/customers`,{method:'POST',headers:{Cookie:a2.cookie,Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({name:'evil'})});assert.equal(csrf.status,403);
 await stop();copyFileSync(copy.stdout.trim(),resolve(restoreDir,'activehub.sqlite'));await start(restoreDir);
 const restoredLogin=await request('login',{username:'admin',password:creds.admin});assert.equal(restoredLogin.status,200);
 const restoredData=(await request('data',null,restoredLogin.cookie)).body;
 assert.equal(restoredData.customers[0].balance,0);assert.equal(restoredData.products[0].stock,10);assert.equal(restoredData.invoices[0].status,'void');assert.equal(restoredData.payments.filter(x=>x.amount<0).length,1);
 }finally{await stop();rmSync(dir,{recursive:true,force:true});rmSync(restoreDir,{recursive:true,force:true});}
});

test('Arabic view templates render data safely and cart controls do not submit sales',()=>{
 const fixture={settings:{currency:'₪'},customers:[{id:1,name:'<script>alert(1)</script>',phone:'059',notes:'test',balance:-100}],products:[{id:1,name:'قهوة',price:1000,cost:300,stock:3,minimum:5,service:0}],invoices:[{id:1,created:new Date().toISOString(),customer_id:1,customer:'أحمد',status:'active',total:1000,paid:500,items:[{product_id:1,name:'قهوة',quantity:1,price:1000,cost:300}]}],payments:[{id:1,customer_id:1,amount:500,created:new Date().toISOString(),status:'active',method:'cash'}],expenses:[],movements:[],audit:[]};
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');
 const context=vm.createContext({crypto:{randomUUID},document:{addEventListener(){}},console});
 vm.runInContext(source+`\nuser={username:'admin',role:'admin'};data=${JSON.stringify(fixture)};globalThis.result=Object.fromEntries(Object.entries(views).map(([k,v])=>[k,v()]));globalThis.cartButton=button('+','qty','icon');`,context);
 for(const html of Object.values(context.result))assert.ok(html.length>50);
 assert.ok(context.result.customers.includes('&lt;script&gt;'));assert.ok(context.result.customers.includes('رد رصيد'));assert.ok(context.cartButton.includes('type="button"'));assert.ok(context.result.pos.includes('عملية بيع جديدة'));
 assert.ok(context.result.pos.includes('عميل جديد'));assert.ok(!context.result.pos.includes('name="discount"'));assert.ok(!context.result.pos.includes('زائر'));
});
