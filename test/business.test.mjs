import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {approvedBusiness} from '../lib/business.mjs';

test('approved business details render correct phone links, working hours and official social links',async()=>{
 const source=readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');const root={innerHTML:''};
 const settings={...approvedBusiness,tagline:'مساحتك للإنجاز',description:'مساحة عمل في غزة',services:'الإنترنت\nالكهرباء\nالمشروبات'};
 const ctx=vm.createContext({crypto:{randomUUID},URL,document:{addEventListener(){},querySelector:()=>root},fetch:async()=>({ok:true,json:async()=>settings})});
 await vm.runInContext(source+'\nlanding();',ctx);
 assert.ok(root.innerHTML.includes(approvedBusiness.address));assert.ok(root.innerHTML.includes(approvedBusiness.hours));assert.ok(root.innerHTML.includes('https://wa.me/972597773944'));assert.ok(!root.innerHTML.includes('https://wa.me/00972'));assert.ok(root.innerHTML.includes('tel:+972597773944'));assert.ok(root.innerHTML.includes(approvedBusiness.instagram));assert.ok(root.innerHTML.includes('id="gallery"'));
 assert.equal(vm.runInContext("socialURL('javascript:alert(1)','facebook')",ctx),'');assert.equal(vm.runInContext("socialURL('https://example.com','instagram')",ctx),'');
});
