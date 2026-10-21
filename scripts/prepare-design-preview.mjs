// Local design review must never update the shared Neon database.
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStorage} from '../lib/storage.mjs';
if(process.env.VERCEL)throw new Error('Design preview preparation is local only');
const root=fileURLToPath(new URL('../',import.meta.url));
const preview=resolve(root,'.local/design-preview');mkdirSync(preview,{recursive:true});
const destination=resolve(preview,'activehub.sqlite');
if(!existsSync(destination)){
 const source=new DatabaseSync(resolve(root,'data/activehub.sqlite'),{readOnly:true});
 try{await backup(source,destination);}finally{source.close();}
 const credentials=resolve(root,'data/initial-credentials.json');
 if(existsSync(credentials))copyFileSync(credentials,resolve(preview,'initial-credentials.json'));
}
delete process.env.DATABASE_URL;delete process.env.DB_DRIVER;process.env.DATA_DIR=preview;
const storage=await createStorage();
try{await storage.transaction(async()=>{
 const row=await storage.one('SELECT * FROM site_documents WHERE id=?','main');
 if(!row)throw new Error('Open the local visitor page once before preparing its design preview');
 const published=JSON.parse(row.published),draft=JSON.parse(row.draft);
 for(const doc of [published,draft]){
  Object.assign(doc.identity,{accent:'#bd9251',background:'#f6f3ec',text:'#263d35'});
  for(const service of doc.services)if(service.title==='خدمات مالية ورقمية — للاستفسار تواصل معنا')service.title='خدمات مالية ورقمية';
 }
 await storage.run('UPDATE site_documents SET published=?,draft=?,revision=revision+1 WHERE id=?',JSON.stringify(published),JSON.stringify(draft),'main');
});console.log('Local design preview prepared in .local/design-preview. Neon was not accessed.');}finally{await storage.close();}
