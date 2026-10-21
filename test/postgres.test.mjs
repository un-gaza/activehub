import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

test('PostgreSQL adapter handles seeded prices, atomic concurrent checkout, balances and archives',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'activehub-postgres-')),port=43000+Math.floor(Math.random()*10000),password=randomUUID();
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,DB_DRIVER:'pglite',INITIAL_ADMIN_PASSWORD:password,INITIAL_VIEWER_PASSWORD:randomUUID()},stdio:['ignore','pipe','pipe']});let cookie,errors='';child.stderr.on('data',s=>errors+=s);
 const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'server timeout')),25000);child.stdout.on('data',s=>{if(s.toString().includes('http://')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});});
  const login=await api('login',{username:'admin',password});assert.equal(login.status,200,JSON.stringify(login.body));cookie=login.cookie;
  let d=(await api('data')).body;assert.equal(d.products.length,7);const product=d.products.find(x=>x.name==='قهوة');assert.equal(product.price,300);
  const sale={key:randomUUID(),new_customer:{name:'عميل PostgreSQL',phone:'0590000000',notes:''},items:[{id:product.id,quantity:2,price:3.5}],paid:2,method:'cash'};
  const results=await Promise.all([api('sales',sale),api('sales',sale)]);for(const r of results)assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(results[0].body.invoice_id,results[1].body.invoice_id);
  d=(await api('data')).body;assert.equal(d.invoices.length,1);assert.equal(d.customers.length,1);assert.equal(d.customers[0].balance,500);assert.equal(d.invoices[0].total,700);
  const id=d.customers[0].id;assert.equal((await api('payments',{key:randomUUID(),customer_id:id,amount:5,method:'palpay'})).status,200);
  assert.equal((await api('delete/customer',{id})).status,200);assert.equal((await api('restore/customer',{id})).status,200);
  d=(await api('data')).body;assert.equal(d.customers[0].balance,0);assert.equal(d.invoices[0].items[0].price,350);
  const payment=d.payments[0];assert.equal((await api('delete/payment',{id:payment.id})).status,200);
  d=(await api('data')).body;assert.equal(d.payments.find(p=>p.id===payment.id).deleted,1);assert.equal(d.customers[0].balance,0);
  assert.equal((await api('restore/payment',{id:payment.id})).status,200);assert.equal((await api('data')).body.payments.find(p=>p.id===payment.id).deleted,0);
 }finally{await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);child.kill();});rmSync(dir,{recursive:true,force:true});}
});
