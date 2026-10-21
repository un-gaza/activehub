import {randomUUID} from 'node:crypto';
import {createStorage} from '../lib/storage.mjs';
import {createSiteStore} from '../lib/visitor-site.mjs';

const storage=await createStorage();
const palette={accent:'#d6aa26',background:'#ffffff',text:'#171717'};
try{
 await storage.transaction(async()=>{
  const settings=async()=>Object.fromEntries((await storage.all('SELECT * FROM settings')).map(row=>[row.key,row.value]));
  const store=createSiteStore(storage,settings);await store.editor();
  const row=await storage.one('SELECT * FROM site_documents WHERE id=?','main');
  const published=JSON.parse(row.published),draft=JSON.parse(row.draft);
  if([published,draft].every(doc=>Object.entries(palette).every(([key,value])=>doc.identity[key]===value)))return;
  await storage.run('INSERT INTO site_versions(id,content,created,actor) VALUES(?,?,?,?)',randomUUID(),row.published,new Date().toISOString(),'setup');
  Object.assign(published.identity,palette);Object.assign(draft.identity,palette);
  await storage.run('UPDATE site_documents SET published=?,draft=?,revision=revision+1 WHERE id=?',JSON.stringify(published),JSON.stringify(draft),'main');
  await storage.run('INSERT INTO audit(action,actor,created) VALUES(?,?,?)','اعتماد خلفية بيضاء ولمسات ذهبية لصفحة الزوار','setup',new Date().toISOString());
 });
 console.log('Public light theme applied; existing page content and draft retained.');
}finally{await storage.close();}
