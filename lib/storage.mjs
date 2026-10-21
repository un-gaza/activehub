import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const identityTables=new Set(['users','customers','products','invoices','items','payments','expenses','movements','audit']);
const numericColumns=new Set(['id','customer_id','invoice_id','product_id','user_id','expires','price','cost','total','paid','discount','amount','value','balance','stock','quantity','minimum','service','active','deleted','price_ready']);
const normalizeRow=row=>row&&Object.fromEntries(Object.entries(row).map(([key,value])=>[key,numericColumns.has(key)&&typeof value==='string'&&/^-?\d+$/.test(value)?Number(value):value]));
function postgresSQL(sql){let i=0;sql=sql.replace(/\?/g,()=>'$'+(++i));if(/INSERT OR IGNORE/i.test(sql))sql=sql.replace(/INSERT OR IGNORE/i,'INSERT')+' ON CONFLICT DO NOTHING';return sql;}
export async function createStorage(){
 if(process.env.VERCEL&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL must be configured before deploying Active Hub');
 const postgres=Boolean(process.env.DATABASE_URL)||process.env.DB_DRIVER==='pglite';
 const context=new AsyncLocalStorage();let queue=Promise.resolve(),sqlite,pool,pglite;
 const exclusive=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 if(postgres){
  if(process.env.DB_DRIVER==='pglite'){const {PGlite}=await import('@electric-sql/pglite');pglite=new PGlite(resolve(process.env.DATA_DIR||'data','postgres-test'));}
  else{const {default:pg}=await import('pg');pg.types.setTypeParser(20,Number);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:15000});if(process.env.VERCEL){const {attachDatabasePool}=await import('@vercel/functions');attachDatabasePool(pool);}}
 }else{const {DatabaseSync}=await import('node:sqlite');const dir=resolve(process.env.DATA_DIR||'data');mkdirSync(dir,{recursive:true});sqlite=new DatabaseSync(resolve(dir,'activehub.sqlite'));sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');}
 const engine=async(sql,args,mode)=>postgres?(pglite?pglite.query(sql,args):pool.query(sql,args)):sqlite.prepare(sql)[mode](...args);
 const execute=(sql,args,mode)=>{const executor=context.getStore();if(executor)return executor(sql,args,mode);return postgres&&!pglite?engine(sql,args,mode):exclusive(()=>engine(sql,args,mode));};
 const storage={
  postgres,sqlite,
  async all(sql,...args){const result=await execute(postgres?postgresSQL(sql):sql,args,'all');return postgres?result.rows.map(normalizeRow):result;},
  async one(sql,...args){const result=await execute(postgres?postgresSQL(sql):sql,args,'get');return postgres?normalizeRow(result.rows[0]):result;},
  async run(sql,...args){if(!postgres)return execute(sql,args,'run');let statement=postgresSQL(sql);const table=statement.match(/^INSERT INTO\s+(\w+)/i)?.[1];if(identityTables.has(table))statement+=' RETURNING id';const result=await execute(statement,args,'run');return {lastInsertRowid:result.rows[0]?.id,changes:result.rowCount??result.affectedRows??0};},
  async transaction(fn){
   if(postgres&&!pglite){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(68142631)');const result=await context.run((sql,args)=>client.query(sql,args),fn);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
   return exclusive(async()=>{if(sqlite)sqlite.exec('BEGIN IMMEDIATE');else await pglite.exec('BEGIN');try{const result=await context.run(engine,fn);if(sqlite)sqlite.exec('COMMIT');else await pglite.exec('COMMIT');return result;}catch(e){if(sqlite)sqlite.exec('ROLLBACK');else await pglite.exec('ROLLBACK');throw e;}});
  },
  async initialize(){const schema=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8');if(postgres){if(pglite)await pglite.exec(schema);else await pool.query(schema);}else{sqlite.exec(schema.replace(/SERIAL PRIMARY KEY/g,'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/BIGINT/g,'INTEGER'));if(!sqlite.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='price_ready'))sqlite.exec('ALTER TABLE products ADD COLUMN price_ready INTEGER NOT NULL DEFAULT 1');for(const table of ['customers','invoices'])if(!sqlite.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='deleted'))sqlite.exec(`ALTER TABLE ${table} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);}},
  async close(){if(pool)await pool.end();if(pglite)await pglite.close();if(sqlite)sqlite.close();}
 };
 await storage.initialize();return storage;
}
