import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../lib/storage.mjs';
import {resolve} from 'node:path';

if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL in the process environment before running migration');
const source=new DatabaseSync(resolve(process.env.DATA_DIR||'data','activehub.sqlite'),{readOnly:true});
const target=await createStorage();
const tables=['users','customers','products','invoices','items','payments','expenses','movements','audit','settings','requests'];
const rows={};source.exec('BEGIN');try{for(const table of tables)rows[table]=source.prepare(`SELECT * FROM ${table}`).all();source.exec('COMMIT');}finally{source.close();}
try{
 await target.transaction(async()=>{
  for(const table of tables)if(await target.one(`SELECT 1 AS present FROM ${table} LIMIT 1`))throw new Error('Destination is not empty: '+table);
  for(const table of tables)for(const row of rows[table]){const keys=Object.keys(row);await target.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(key=>row[key]));}
  for(const table of tables.filter(t=>!['settings','requests'].includes(t)))await target.one(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),EXISTS(SELECT 1 FROM ${table}))`);
 });
 console.log(JSON.stringify({migrated:true,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length])),sessionsMigrated:false}));
}finally{await target.close();}
