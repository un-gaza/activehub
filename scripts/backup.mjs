import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const dir=resolve(process.env.DATA_DIR||'data');
mkdirSync(resolve(dir,'backups'),{recursive:true});
const db=new DatabaseSync(resolve(dir,'activehub.sqlite'),{readOnly:true});
const file=resolve(dir,'backups',`manual-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
await backup(db,file);db.close();console.log(file);
