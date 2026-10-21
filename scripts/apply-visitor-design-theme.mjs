import {randomUUID} from 'node:crypto';
import {createStorage} from '../lib/storage.mjs';

// Apply only the reviewed page palette and legacy service title, preserving other edits.
const storage=await createStorage();
const previous={accent:'#d6aa26',background:'#ffffff',text:'#171717'};
const palette={accent:'#bd9251',background:'#f6f3ec',text:'#263d35'};
try{await storage.transaction(async()=>{
 const row=await storage.one('SELECT * FROM site_documents WHERE id=?','main');
 if(!row)throw new Error('The visitor document must exist before applying its design');
 const documents=[JSON.parse(row.published),JSON.parse(row.draft)];let changed=false;
 for(const doc of documents){
  if(Object.entries(previous).every(([key,value])=>doc.identity[key]===value)){Object.assign(doc.identity,palette);changed=true;}
  for(const service of doc.services)if(service.title==='خدمات مالية ورقمية — للاستفسار تواصل معنا'){service.title='خدمات مالية ورقمية';changed=true;}
 }
 if(!changed)return;
 await storage.run('INSERT INTO site_versions(id,content,created,actor) VALUES(?,?,?,?)',randomUUID(),row.published,new Date().toISOString(),'design-release');
 await storage.run('UPDATE site_documents SET published=?,draft=?,revision=revision+1 WHERE id=?',JSON.stringify(documents[0]),JSON.stringify(documents[1]),'main');
 await storage.run('INSERT INTO audit(action,actor,created) VALUES(?,?,?)','تطبيق التصميم المعتمد لصفحة الزوار والألوان الجديدة','design-release',new Date().toISOString());
});console.log('Reviewed visitor design applied; previous version retained.');}finally{await storage.close();}
