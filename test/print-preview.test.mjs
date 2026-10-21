import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

test('thermal preview opens without printing, changes paper width and prints only on explicit confirmation',async()=>{
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');let prints=0,opened=0,decoded=0,finishFonts;
 const fontsReady=new Promise(r=>finishFonts=r),classes=new Map(),printButton={disabled:false};
 const output={innerHTML:'',querySelectorAll:()=>[{decode:async()=>{decoded++;}}]};
 const preview={innerHTML:'',open:false,showModal(){this.open=true;opened++;},close(){this.open=false;},querySelector:()=>printButton};
 const nodes={'#print':output,'#print-preview':preview,'#preview-size':{},'#preview-paper':{},'#paper-measure':{}};
 const fixture={settings:{name:'Active Hub',currency:'₪',address:'غزة',phone:'0590000000'},products:[{id:1,name:'ساعة الإنترنت والكهرباء',price:500,price_ready:1},{id:2,name:'قهوة',price:300,price_ready:1}],payments:[],invoices:[],customers:[]};
 const ctx=vm.createContext({crypto:{randomUUID},document:{querySelector:s=>nodes[s]||null,addEventListener(){},fonts:{ready:fontsReady},body:{classList:{toggle:(key,on)=>classes.set(key,on)}}},window:{print(){assert.equal(preview.open,false);prints++;}}});
 vm.runInContext(source+`\ndata=${JSON.stringify(fixture)};sampleInvoice();globalThis.after=JSON.stringify(data);`,ctx);
 assert.equal(ctx.after,JSON.stringify(fixture));assert.equal(prints,0);assert.equal(opened,1);assert.equal(preview.open,true);
 assert.ok(preview.innerHTML.includes('BIXOLON SRP-330'));assert.ok(preview.innerHTML.includes('معاينة قبل الطباعة'));assert.ok(preview.innerHTML.includes('طباعة الآن'));assert.ok(preview.innerHTML.includes(output.innerHTML));assert.ok(output.innerHTML.includes('غير مسجل'));assert.ok(output.innerHTML.includes('8.00'));assert.ok(!/[٠-٩۰-۹]/.test(output.innerHTML));
 assert.equal(output.className,'receipt-paper paper-80');
 nodes['#preview-size'].onchange({target:{value:'58'}});assert.equal(output.className,'receipt-paper paper-58');assert.equal(nodes['#preview-paper'].className,output.className);assert.ok(nodes['#paper-measure'].textContent.includes('48'));
 const confirmation=vm.runInContext('confirmPreviewPrint()',ctx);assert.equal(prints,0);assert.equal(printButton.disabled,true);
 finishFonts();await confirmation;assert.equal(prints,1);assert.equal(decoded,1);assert.equal(classes.get('print-paper-58'),true);assert.equal(classes.get('print-paper-80'),false);assert.equal(printButton.disabled,false);
 await vm.runInContext('confirmPreviewPrint()',ctx);assert.equal(prints,1);
 vm.runInContext("printDocument('تقرير','<p>تقرير تجريبي</p>',{paper:'a4'})",ctx);assert.equal(output.className,'receipt-paper paper-a4');assert.equal(prints,1);preview.close();assert.equal(prints,1);
});
