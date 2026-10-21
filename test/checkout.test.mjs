import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

test('starter prices, inline customer creation, custom line prices and all four payment methods',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'activehub-checkout-'));const port=52000+Math.floor(Math.random()*10000);
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,CATALOG_SEED:'1'},stdio:['ignore','pipe','pipe']});let cookie;
 const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout')),10000);child.stdout.on('data',s=>{if(s.toString().includes('http://')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
  const creds=JSON.parse(readFileSync(resolve(dir,'initial-credentials.json'),'utf8'));cookie=(await api('login',{username:'admin',password:creds.admin})).cookie;
  const initial=(await api('data')).body;
  const products=Object.fromEntries(initial.products.map(x=>[x.name,x]));
  assert.equal(initial.products.length,7);
  for(const [name,price] of [['ساعة الإنترنت',200],['ساعة الكهرباء',300],['ساعة الإنترنت والكهرباء',500],['قهوة',300],['نسكافيه',300],['شاي',200]])assert.equal(products[name].price,price);
  assert.equal(products['كابتشينو'].price_ready,0);
  const cappuccino=products['كابتشينو'];assert.equal((await api('sales',{key:randomUUID(),new_customer:{name:'غير محفوظ'},items:[{id:cappuccino.id,quantity:1}],paid:0,method:'cash'})).status,400);
  const sale={key:randomUUID(),new_customer:{name:'عميل من نقطة البيع',phone:'0590000000',notes:'اختبار معزول'},items:[{id:products['نسكافيه'].id,quantity:1,price:4.5},{id:products['شاي'].id,quantity:2,price:1}],paid:1.5,method:'bank_palestine'};
  const result=await api('sales',sale);assert.equal(result.status,200);assert.equal((await api('sales',sale)).body.invoice_id,result.body.invoice_id);
  let d=(await api('data')).body;assert.equal(d.customers.length,1);assert.equal(d.customers[0].balance,500);assert.equal(d.invoices.length,1);assert.equal(d.invoices[0].total,650);assert.equal(d.invoices[0].discount,0);assert.equal(d.invoices[0].items.find(x=>x.product_id===products['نسكافيه'].id).price,450);assert.equal(d.products.find(x=>x.id===products['نسكافيه'].id).price,300);
  assert.equal((await api('sales',{...sale,key:randomUUID(),method:'invalid'})).status,400);assert.equal((await api('data')).body.customers.length,1);
  const id=d.customers[0].id;
  for(const method of ['cash','bank_palestine','jawwal_pay','palpay'])assert.equal((await api('payments',{key:randomUUID(),customer_id:id,amount:1.25,method})).status,200);
  d=(await api('data')).body;assert.equal(d.customers[0].balance,0);assert.equal(d.payments.length,5);
  assert.equal((await api('products',{id:cappuccino.id,name:cappuccino.name,price:4,cost:0,minimum:0,service:true})).status,200);
  d=(await api('data')).body;assert.equal(d.products.find(x=>x.id===cappuccino.id).price_ready,1);assert.equal(d.products.find(x=>x.id===cappuccino.id).price,400);
 }finally{await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);child.kill();});rmSync(dir,{recursive:true,force:true});}
});

test('checkout templates retain English numerals, new-customer form, price editing and accessible skeletons',()=>{
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');const node={innerHTML:'',setAttribute(){},removeAttribute(){}};
 const ctx=vm.createContext({crypto:{randomUUID},document:{querySelector:()=>node,addEventListener(){}}});
 vm.runInContext(source+`\nuser={role:'admin'};data={settings:{currency:'₪'},products:[{id:1,name:'قهوة',price:300,price_ready:1,service:1}],customers:[]};cart=[{id:1,name:'قهوة',price:450,base_price:300,price_ready:1,quantity:2}];globalThis.html=views.pos();globalThis.numbers=fmt(123450);globalThis.calendar=date('2026-10-21T10:00:00Z');globalThis.total=cartTotal();showLoading();`,ctx);
 assert.equal(ctx.total,900);assert.equal(ctx.numbers,'1,234.50 ₪');assert.ok(!/[٠-٩۰-۹]/.test(ctx.calendar));assert.ok(ctx.html.includes('data-line-price="1"'));assert.ok(ctx.html.includes('customer_name'));assert.ok(ctx.html.includes('بنك فلسطين'));assert.ok(ctx.html.includes('جوال باي'));assert.ok(ctx.html.includes('بال باي'));assert.ok(!ctx.html.includes('name="discount"'));assert.ok(node.innerHTML.includes('role="status"'));assert.ok(node.innerHTML.includes('skeleton'));
});

test('checkout form recalculates price changes, preserves partial payments and toggles inline customer fields',()=>{
 const fields=Object.fromEntries([['customer_id','new'],['customer_name','عميل جديد'],['customer_phone','0590000000'],['customer_notes','ملاحظة'],['paid','6.00'],['method','palpay'],['print','on']].map(([name,value])=>[name,{name,value,disabled:false,type:name==='print'?'checkbox':'text',checked:false}]));
 const form={elements:{namedItem:name=>fields[name]}};
 const nodes={'#sale-form':form,'#new-customer-fields':{hidden:false},'#sale-total':{innerHTML:''},'#remaining':{innerHTML:''},'[data-line-total="1"]':{innerHTML:''}};
 class TestFormData{constructor(){this.rows=Object.values(fields).filter(x=>!x.disabled&&(x.type!=='checkbox'||x.checked)).map(x=>[x.name,x.value]);}[Symbol.iterator](){return this.rows[Symbol.iterator]();}}
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');
 const ctx=vm.createContext({crypto:{randomUUID},document:{querySelector:s=>nodes[s]||null,addEventListener(){}},FormData:TestFormData});
 vm.runInContext(source+`\nuser={role:'admin'};data={settings:{currency:'₪'}};cart=[{id:1,name:'قهوة',price:300,quantity:2}];bindView();`,ctx);
 assert.equal(fields.paid.value,'6.00');assert.equal(nodes['#new-customer-fields'].hidden,false);assert.equal(fields.customer_name.required,true);
 form.oninput({target:{dataset:{linePrice:'1'},name:'',value:'4.50'}});
 assert.equal(fields.paid.value,'9.00');assert.equal(nodes['#sale-total'].innerHTML,'9.00 ₪');assert.equal(nodes['[data-line-total="1"]'].innerHTML,'9.00 ₪');
 fields.paid.value='1.50';form.oninput({target:{dataset:{},name:'paid'}});
 form.oninput({target:{dataset:{linePrice:'1'},name:'',value:'5.00'}});
 assert.equal(fields.paid.value,'1.50');assert.equal(nodes['#remaining'].innerHTML,'المتبقي: 8.50 ₪');
 fields.customer_id.value='42';fields.customer_id.onchange();assert.equal(nodes['#new-customer-fields'].hidden,true);assert.equal(fields.customer_name.required,false);assert.equal(fields.customer_name.disabled,true);
 vm.runInContext('bindView()',ctx);assert.equal(fields.paid.value,'1.50');assert.equal(fields.customer_id.value,'42');assert.equal(fields.customer_notes.value,'ملاحظة');
 fields.customer_id.value='new';fields.customer_id.onchange();assert.equal(fields.customer_name.disabled,false);assert.equal(fields.customer_name.required,true);
});
