import http from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const dir=resolve(process.env.DATA_DIR||'data'); mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(resolve(dir,'activehub.sqlite')); db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,hash TEXT,salt TEXT,role TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT DEFAULT '',notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,price INTEGER NOT NULL,cost INTEGER NOT NULL,stock INTEGER NOT NULL,minimum INTEGER DEFAULT 5,service INTEGER DEFAULT 0,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER REFERENCES customers(id),created TEXT NOT NULL,total INTEGER NOT NULL,paid INTEGER NOT NULL,discount INTEGER DEFAULT 0,status TEXT DEFAULT 'active',reason TEXT,actor TEXT);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,invoice_id INTEGER REFERENCES invoices(id),product_id INTEGER REFERENCES products(id),name TEXT,quantity INTEGER,price INTEGER,cost INTEGER,service INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),invoice_id INTEGER REFERENCES invoices(id),amount INTEGER NOT NULL,method TEXT,created TEXT,actor TEXT,status TEXT DEFAULT 'active');
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY,title TEXT,amount INTEGER,created TEXT,actor TEXT);
CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY,product_id INTEGER REFERENCES products(id),quantity INTEGER,cost INTEGER,reason TEXT,created TEXT,actor TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT,actor TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,result TEXT);
`);
if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='price_ready'))db.exec('ALTER TABLE products ADD COLUMN price_ready INTEGER NOT NULL DEFAULT 1');
for(const table of ['customers','invoices'])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='deleted'))db.exec(`ALTER TABLE ${table} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
if(process.env.CATALOG_SEED!=='0'){
 const catalog=[['ساعة الإنترنت',200],['ساعة الكهرباء',300],['ساعة الإنترنت والكهرباء',500],['قهوة',300],['نسكافيه',300],['شاي',200],['كابتشينو',null]];
 for(const [name,price] of catalog)if(!db.prepare('SELECT id FROM products WHERE name=?').get(name))db.prepare('INSERT INTO products(name,price,cost,stock,minimum,service,price_ready) VALUES(?,?,0,0,0,1,?)').run(name,price??0,price===null?0:1);
}
async function saveBackup(){const dest=resolve(dir,'backups');mkdirSync(dest,{recursive:true});await backup(db,resolve(dest,`activehub-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`));const files=readdirSync(dest).filter(x=>x.endsWith('.sqlite')).sort();for(const file of files.slice(0,-14))unlinkSync(resolve(dest,file));}
setInterval(()=>saveBackup().catch(console.error),24*3600000).unref();
const now=()=>new Date().toISOString();
const all=(sql,...args)=>db.prepare(sql).all(...args);
const one=(sql,...args)=>db.prepare(sql).get(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const paymentMethods=new Set(['cash','bank_palestine','jawwal_pay','palpay']);
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function audit(action,user){run('INSERT INTO audit(action,actor,created) VALUES(?,?,?)',action,user.username,now());}
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function str(v,max=500){if(typeof v!=='string')fail('بيانات نصية غير صالحة');return v.trim().slice(0,max);}
function money(v){const n=Number(v);if(!Number.isFinite(n)||n<0||n>10000000)fail('المبلغ غير صالح');return Math.round(n*100);}
function integer(v,min=0){const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>1000000)fail('الكمية غير صالحة');return n;}
function required(v){const s=str(v,120);if(!s)fail('الاسم مطلوب');return s;}
function balance(id){return one(`SELECT COALESCE((SELECT SUM(total) FROM invoices WHERE customer_id=? AND status='active'),0)-COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id=? AND status='active'),0) value`,id,id).value;}
if(!one('SELECT id FROM users LIMIT 1')){
 const credentials={};for(const role of ['admin','viewer']){const password=randomBytes(12).toString('base64url');const salt=randomBytes(16).toString('hex');run('INSERT INTO users(username,hash,salt,role) VALUES(?,?,?,?)',role,scryptSync(password,salt,64).toString('hex'),salt,role);credentials[role]=password;}
 writeFileSync(resolve(dir,'initial-credentials.json'),JSON.stringify(credentials,null,2),{mode:0o600});
 console.log('Initial credentials saved locally in data/initial-credentials.json');
}
const defaults={name:'Active Hub',tagline:'مساحتك للتركيز. وجهتك للإنجاز.',description:'مساحة عمل مشتركة في غزة، تجمع المستقلين والطلاب وفرق العمل في بيئة تساعد على التركيز والتواصل.',phone:'',address:'غزة — يرجى اعتماد العنوان من الإدارة',hours:'تواصل معنا لمعرفة أوقات العمل',services:'مساحات عمل مريحة\nخدمات الإنترنت والطاقة\nالمشروبات والضيافة\nخدمات مالية ورقمية — للاستفسار تواصل معنا',currency:'₪'};
for(const [k,v]of Object.entries(defaults))run('INSERT OR IGNORE INTO settings VALUES(?,?)',k,v);
const settings=()=>Object.fromEntries(all('SELECT * FROM settings').map(x=>[x.key,x.value]));
function snapshot(){return {settings:settings(),customers:all('SELECT * FROM customers ORDER BY id DESC').map(c=>({...c,balance:balance(c.id)})),products:all('SELECT * FROM products WHERE active=1 ORDER BY id DESC'),invoices:all(`SELECT i.*,c.name customer FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC`).map(i=>({...i,items:all('SELECT * FROM items WHERE invoice_id=?',i.id)})),payments:all('SELECT p.*,c.name customer FROM payments p LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.id DESC'),expenses:all('SELECT * FROM expenses ORDER BY id DESC'),movements:all('SELECT m.*,p.name product FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC'),audit:all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')};}
const attempts=new Map();
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>100000)fail('الطلب كبير جداً');}try{return JSON.parse(data||'{}');}catch{fail('طلب غير صالح');}}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const secure=process.env.COOKIE_SECURE==='1';
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 try{
  if(url.pathname.startsWith('/api/')){
   if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`${secure?'https':'http'}://${req.headers.host}`)fail('مصدر الطلب غير مسموح',403);
   if(url.pathname==='/api/public'&&req.method==='GET')return json(settings());
   if(url.pathname==='/api/login'&&req.method==='POST'){
    const key=req.socket.remoteAddress;let a=attempts.get(key);if(!a||a.until<Date.now()){a={count:0,until:Date.now()+900000};attempts.set(key,a);}if(a.count>=12)fail('محاولات كثيرة، أعد المحاولة بعد 15 دقيقة',429);
    const b=await body(req);const u=one('SELECT * FROM users WHERE username=?',str(b.username,40));const hash=scryptSync(str(b.password,200),u?.salt||'dummy',64);if(!u||!timingSafeEqual(hash,Buffer.from(u.hash,'hex'))){a.count++;fail('اسم المستخدم أو كلمة المرور غير صحيحة',401);}
    attempts.delete(key);run('DELETE FROM sessions WHERE expires<?',Date.now());const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',token,u.id,Date.now()+12*3600000);res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure?'; Secure':''}`);return json({username:u.username,role:u.role});
   }
   const token=(req.headers.cookie||'').match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1]||'';
   const user=one('SELECT u.id,u.username,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?',token,Date.now());if(!user)fail('يرجى تسجيل الدخول',401);
   if(url.pathname==='/api/me'&&req.method==='GET')return json(user);
   if(url.pathname==='/api/logout'&&req.method==='POST'){run('DELETE FROM sessions WHERE token=?',token);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json({ok:true});}
   if(url.pathname==='/api/data'&&req.method==='GET')return json(snapshot());
   if(req.method!=='POST')fail('المسار غير موجود',404);
   if(user.role!=='admin')fail('هذا الحساب للمشاهدة فقط',403);
   const b=await body(req);
   if(url.pathname==='/api/password'){const target=one('SELECT * FROM users WHERE username=?',str(b.username,40));if(!target)fail('الحساب غير موجود');const password=str(b.password,200);if(password.length<12)fail('استخدم كلمة مرور من 12 حرفاً على الأقل');const salt=randomBytes(16).toString('hex');transaction(()=>{run('UPDATE users SET hash=?,salt=? WHERE id=?',scryptSync(password,salt,64).toString('hex'),salt,target.id);run('DELETE FROM sessions WHERE user_id=?',target.id);audit('تغيير كلمة مرور '+target.username,user);});return json({ok:true});}
   const result=transaction(()=>{
    if(/^\/api\/(delete|restore)\/(customer|invoice)$/.test(url.pathname)){
     const [,operation,entity]=url.pathname.match(/^\/api\/(delete|restore)\/(customer|invoice)$/);const table=entity==='customer'?'customers':'invoices';const id=integer(b.id,1);const record=one(`SELECT * FROM ${table} WHERE id=?`,id);if(!record)fail('السجل غير موجود',404);const deleted=operation==='delete'?1:0;if(record.deleted===deleted)return {ok:true};if(entity==='customer'&&deleted&&balance(id)!==0)fail('لا يمكن حذف العميل قبل تسوية رصيده المستحق أو الرصيد لصالحه',409);run(`UPDATE ${table} SET deleted=? WHERE id=?`,deleted,id);audit((deleted?'نقل إلى المحذوفات: ':'استعادة: ')+(entity==='customer'?'العميل '+record.name:'الفاتورة #'+id),user);
    }
    else if(url.pathname==='/api/customers'){const name=required(b.name);if(b.id){if(!one('SELECT id FROM customers WHERE id=? AND deleted=0',integer(b.id,1)))fail('العميل غير موجود');run('UPDATE customers SET name=?,phone=?,notes=? WHERE id=?',name,str(b.phone,40),str(b.notes),b.id);}else run('INSERT INTO customers(name,phone,notes) VALUES(?,?,?)',name,str(b.phone,40),str(b.notes));audit('حفظ العميل: '+name,user);}
    else if(url.pathname==='/api/products'){const values=[required(b.name),money(b.price),money(b.cost),integer(b.minimum),b.service?1:0];if(b.id){if(!one('SELECT id FROM products WHERE id=?',integer(b.id,1)))fail('الصنف غير موجود');run('UPDATE products SET name=?,price=?,cost=?,minimum=?,service=?,price_ready=1 WHERE id=?',...values,b.id);}else run('INSERT INTO products(name,price,cost,minimum,service,stock) VALUES(?,?,?,?,?,?)',...values,integer(b.stock));audit('حفظ الصنف: '+b.name,user);}
    else if(url.pathname==='/api/stock'){const p=one('SELECT * FROM products WHERE id=? AND active=1',integer(b.product_id,1));if(!p||p.service)fail('اختر منتجاً مخزنياً');const q=integer(b.quantity,1)*(b.kind==='waste'?-1:1);if(p.stock+q<0)fail('الرصيد المخزني غير كافٍ');const cost=money(b.cost);run('UPDATE products SET stock=stock+? WHERE id=?',q,p.id);run('INSERT INTO movements(product_id,quantity,cost,reason,created,actor) VALUES(?,?,?,?,?,?)',p.id,q,cost,required(b.reason),now(),user.username);audit('حركة مخزون: '+p.name,user);}
    else if(url.pathname==='/api/sales'){
     const key=str(b.key,100);if(key.length<16)fail('معرف العملية غير صالح');const previous=one('SELECT result FROM requests WHERE key=?',key);if(previous)return JSON.parse(previous.result);
     if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('أضف أصنافاً للفاتورة');
     const seen=new Set();const items=b.items.map(x=>{const p=one('SELECT * FROM products WHERE id=? AND active=1',integer(x.id,1));if(!p||seen.has(p.id))fail('صنف غير صالح أو مكرر');seen.add(p.id);const quantity=integer(x.quantity,1);if(!p.service&&p.stock<quantity)fail('المخزون غير كافٍ: '+p.name);if(!p.price_ready&&x.price===undefined)fail('حدد سعر الصنف: '+p.name);const price=x.price===undefined?p.price:money(x.price);if(!p.price_ready&&price<=0)fail('حدد سعراً أكبر من صفر: '+p.name);return {...p,price,quantity};});
     const subtotal=items.reduce((s,p)=>s+p.price*p.quantity,0);const discount=money(b.discount||0);if(discount>subtotal)fail('الخصم يتجاوز المجموع');const total=subtotal-discount,paid=money(b.paid);if(paid>total)fail('المدفوع يتجاوز الإجمالي');let customer=b.customer_id?integer(b.customer_id,1):null;if(customer&&!one('SELECT id FROM customers WHERE id=? AND deleted=0',customer))fail('العميل غير موجود');if(b.new_customer){if(customer)fail('اختر عميلاً مسجلاً أو عميلاً جديداً');const c=b.new_customer;const name=required(c.name);customer=Number(run('INSERT INTO customers(name,phone,notes) VALUES(?,?,?)',name,str(c.phone||'',40),str(c.notes||'')).lastInsertRowid);audit('إضافة عميل من شاشة البيع: '+name,user);}if(!customer&&paid!==total)fail('البيع الآجل يتطلب اختيار عميل');const method=required(b.method);if(!paymentMethods.has(method))fail('طريقة دفع غير صالحة');
     const id=Number(run('INSERT INTO invoices(customer_id,created,total,paid,discount,actor) VALUES(?,?,?,?,?,?)',customer,now(),total,paid,discount,user.username).lastInsertRowid);
     for(const p of items){run('INSERT INTO items(invoice_id,product_id,name,quantity,price,cost,service) VALUES(?,?,?,?,?,?,?)',id,p.id,p.name,p.quantity,p.price,p.cost,p.service);if(!p.service)run('UPDATE products SET stock=stock-? WHERE id=?',p.quantity,p.id);}
     if(paid)run('INSERT INTO payments(customer_id,invoice_id,amount,method,created,actor) VALUES(?,?,?,?,?,?)',customer,id,paid,method,now(),user.username);audit('إنشاء فاتورة #'+id,user);const r={ok:true,invoice_id:id};run('INSERT INTO requests VALUES(?,?)',key,JSON.stringify(r));return r;
    }
    else if(url.pathname==='/api/payments'){const key=str(b.key,100);if(key.length<16)fail('معرف العملية غير صالح');const previous=one('SELECT result FROM requests WHERE key=?',key);if(previous)return JSON.parse(previous.result);const id=integer(b.customer_id,1),amount=money(b.amount);if(!one('SELECT id FROM customers WHERE id=?',id))fail('العميل غير موجود');if(amount<=0||amount>balance(id))fail('المبلغ يجب أن يكون أكبر من صفر وألا يتجاوز الدين');if(!paymentMethods.has(b.method))fail('طريقة الدفع غير صالحة');const payment=Number(run('INSERT INTO payments(customer_id,amount,method,created,actor) VALUES(?,?,?,?,?)',id,amount,b.method,now(),user.username).lastInsertRowid);audit('تحصيل من العميل #'+id,user);const r={ok:true,payment_id:payment};run('INSERT INTO requests VALUES(?,?)',key,JSON.stringify(r));return r;}
    else if(url.pathname==='/api/refunds'){const key=str(b.key,100);if(key.length<16)fail('معرف العملية غير صالح');const previous=one('SELECT result FROM requests WHERE key=?',key);if(previous)return JSON.parse(previous.result);const id=integer(b.customer_id,1),amount=money(b.amount);if(!one('SELECT id FROM customers WHERE id=?',id))fail('العميل غير موجود');if(amount<=0||amount>-balance(id))fail('المبلغ يتجاوز الرصيد المستحق للعميل');if(!paymentMethods.has(b.method))fail('طريقة الدفع غير صالحة');const reason=required(b.reason);const payment=Number(run('INSERT INTO payments(customer_id,amount,method,created,actor) VALUES(?,?,?,?,?)',id,-amount,b.method,now(),user.username).lastInsertRowid);audit('رد رصيد للعميل #'+id+' — '+reason,user);const r={ok:true,payment_id:payment};run('INSERT INTO requests VALUES(?,?)',key,JSON.stringify(r));return r;}
    else if(url.pathname==='/api/void'){const inv=one('SELECT * FROM invoices WHERE id=?',integer(b.id,1));if(!inv||inv.status!=='active')fail('الفاتورة غير قابلة للإلغاء');const reason=required(b.reason);run("UPDATE invoices SET status='void',reason=? WHERE id=?",reason,inv.id);run("UPDATE payments SET status='void' WHERE invoice_id=?",inv.id);for(const i of all('SELECT * FROM items WHERE invoice_id=?',inv.id))if(!i.service)run('UPDATE products SET stock=stock+? WHERE id=?',i.quantity,i.product_id);audit('إلغاء فاتورة #'+inv.id+' — '+reason,user);}
    else if(url.pathname==='/api/expenses'){const amount=money(b.amount);if(!amount)fail('المبلغ مطلوب');run('INSERT INTO expenses(title,amount,created,actor) VALUES(?,?,?,?)',required(b.title),amount,now(),user.username);audit('مصروف: '+b.title,user);}
    else if(url.pathname==='/api/settings'){for(const k of Object.keys(defaults))if(k in b)run('UPDATE settings SET value=? WHERE key=?',str(b[k],3000),k);audit('تحديث بيانات الموقع',user);}
    else fail('المسار غير موجود',404);
    return {ok:true};
   });return json(result);
  }
  const fonts=new Set(['Cairo-Variable.ttf','Cairo-OFL.txt','IBMPlexSansArabic-Regular.ttf','IBMPlexSansArabic-Medium.ttf','IBMPlexSansArabic-SemiBold.ttf','IBMPlexSansArabic-Bold.ttf','OFL.txt']);
  const font=url.pathname.startsWith('/fonts/')&&fonts.has(url.pathname.slice(7))?url.pathname.slice(7):null;
  const image=url.pathname==='/images/active-hub-logo.jpg';
  const file=image?'images/active-hub-logo.jpg':font?'fonts/'+font:url.pathname==='/app.js'?'app.js':url.pathname==='/style.css'?'style.css':url.pathname==='/theme.css'?'theme.css':url.pathname==='/'||url.pathname==='/admin'?'index.html':null;if(!file)fail('غير موجود',404);
  const content=readFileSync(new URL('./public/'+file,import.meta.url));res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.ttf':'font/ttf','.jpg':'image/jpeg','.txt':'text/plain; charset=utf-8'})[extname(file)],...(font||image?{'Cache-Control':'public, max-age=86400'}:{})});res.end(content);
 }catch(e){json({error:e.status?e.message:'تعذر إتمام العملية'},e.status||500);if(!e.status)console.error(e);}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>{console.log(`Active Hub: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`);saveBackup().catch(console.error);});
