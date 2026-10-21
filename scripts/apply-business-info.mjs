import {createStorage} from '../lib/storage.mjs';
import {approvedBusiness} from '../lib/business.mjs';
const storage=await createStorage();
try{await storage.transaction(async()=>{for(const [key,value] of Object.entries(approvedBusiness)){await storage.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',key,value);await storage.run('UPDATE settings SET value=? WHERE key=?',value,key);}await storage.run('INSERT INTO audit(action,actor,created) VALUES(?,?,?)','اعتماد اسم المكتب والعنوان والتواصل وساعات العمل والصفحات الرسمية','setup',new Date().toISOString());});console.log('Approved business information saved.');}finally{await storage.close();}
