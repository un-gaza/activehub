import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {initialSite,validateSite,createSiteStore} from '../lib/visitor-site.mjs';
import {createStorage} from '../lib/storage.mjs';
import {approvedBusiness} from '../lib/business.mjs';
const seed={...approvedBusiness,tagline:'Active Hub',description:'Workspace',services:'Internet\nCoffee'};
test('visitor documents: drafts, optimistic locking, versions and separate POS data on both databases',async()=>{
 const previous={DATA_DIR:process.env.DATA_DIR,DB_DRIVER:process.env.DB_DRIVER};
 try{for(const driver of ['sqlite','pglite']){
  const dir=mkdtempSync(resolve(tmpdir(),'hub-cms-'));process.env.DATA_DIR=dir;if(driver==='pglite')process.env.DB_DRIVER=driver;else delete process.env.DB_DRIVER;
  const db=await createStorage();try{
   const store=createSiteStore(db,async()=>seed),user={username:'admin'};let editor=await store.editor();const original=await store.published();editor.draft.hero.title='Draft only';editor.draft.prices[0].text='99 ₪';
   editor=await db.transaction(()=>store.write('draft',{document:editor.draft,revision:editor.revision},user));assert.equal((await store.published()).hero.title,original.hero.title);
   await assert.rejects(()=>db.transaction(()=>store.write('publish',{document:editor.draft,revision:0},user)),e=>e.status===409);
   editor=await db.transaction(()=>store.write('publish',{document:editor.draft,revision:editor.revision},user));assert.equal((await store.published()).hero.title,'Draft only');assert.equal(editor.versions.length,1);assert.equal((await db.one('SELECT COUNT(*) AS n FROM products')).n,0);
   editor=await db.transaction(()=>store.write('restore',{id:editor.versions[0].id,revision:editor.revision},user));assert.deepEqual(await store.published(),original);assert.equal(editor.versions.length,2);
   editor.draft.hero.title='Discard me';editor=await db.transaction(()=>store.write('draft',{document:editor.draft,revision:editor.revision},user));editor=await db.transaction(()=>store.write('discard',{revision:editor.revision},user));assert.deepEqual(editor.draft,original);
  }finally{await db.close();rmSync(dir,{recursive:true,force:true});}
 }}finally{for(const [k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('page rendering escapes content, honors hidden/reordered sections and uses editable developer links',()=>{
 const context=vm.createContext({document:{addEventListener(){}},window:{addEventListener(){}}});vm.runInContext(readFileSync('public/site.js','utf8')+'\nglobalThis.renderer=SitePage;',context);
 const d=initialSite(seed);d.hero.title='<script>alert(1)</script>';d.sections.find(s=>s.id==='services').visible=false;d.sections.reverse();d.gallery=[{title:'A < B',image:'/images/active-hub-approved.png'}];const html=context.renderer.render(d);
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('id="services"'));assert.ok(html.indexOf('id="contact"')<html.indexOf('id="about"'));assert.ok(html.includes('https://wa.me/972599876261'));assert.ok(html.includes('A &lt; B'));
 const bad=initialSite(seed);bad.hero.url='javascript:alert(1)';assert.throws(()=>validateSite(bad));bad.hero.url='#contact';bad.identity.logo='https://unknown.example/image.svg';assert.throws(()=>validateSite(bad));bad.identity.logo='/images/active-hub-approved.png';bad.sections[0].id='contact';assert.throws(()=>validateSite(bad));
});
test('CMS endpoints protect drafts, publish live content, persist image uploads, and enforce administrator role',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'hub-cms-http-')),port=43000+Math.floor(Math.random()*8000);const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:String(port)},stdio:['ignore','pipe','pipe']});let cookie;
 const api=async(path,body,session=cookie)=>{const res=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),12000);child.stdout.on('data',s=>{if(s.toString().includes('http://')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
  assert.equal((await api('site/editor')).status,401);const credentials=JSON.parse(readFileSync(resolve(dir,'initial-credentials.json'),'utf8'));cookie=(await api('login',{username:'admin',password:credentials.admin})).cookie;const viewer=(await api('login',{username:'viewer',password:credentials.viewer})).cookie;
  assert.equal((await api('site/editor',null,viewer)).status,403);for(const action of ['draft','publish','restore','discard','upload'])assert.equal((await api('site/'+action,{},viewer)).status,403);
  let editor=(await api('site/editor')).body;const original=(await api('public')).body.site;editor.draft.hero.title='New published heading';const saved=await api('site/draft',{document:editor.draft,revision:editor.revision});assert.equal(saved.status,200);assert.equal((await api('public')).body.site.hero.title,original.hero.title);
  assert.equal((await api('site/publish',{document:editor.draft,revision:editor.revision})).status,409);editor=saved.body;
  const png=readFileSync('public/images/active-hub-approved.png');assert.ok(png.length<2000000);const uploaded=await api('site/upload',{content:png.toString('base64')});assert.equal(uploaded.status,200);const image=await fetch(`http://127.0.0.1:${port}${uploaded.body.url}`);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await api('site/upload',{content:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')})).status,400);
  editor.draft.hero.image=uploaded.body.url;assert.equal((await api('site/publish',{document:editor.draft,revision:editor.revision})).status,200);assert.equal((await api('public')).body.site.hero.title,'New published heading');
  for(const path of ['site.js','site.css'])assert.equal((await fetch(`http://127.0.0.1:${port}/${path}`)).status,200);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
