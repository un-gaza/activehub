import http from 'node:http';
import {createStorage} from './lib/storage.mjs';
import {approvedBusiness} from './lib/business.mjs';
import {createSiteStore} from './lib/visitor-site.mjs';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync} from 'node:fs';
import {resolve, extname} from 'node:path';
const storage = await createStorage();
const db = storage.sqlite;
const dir = resolve(process.env.DATA_DIR || 'data');
const all = (sql, ...args) => storage.all(sql, ...args);
const one = (sql, ...args) => storage.one(sql, ...args);
const run = (sql, ...args) => storage.run(sql, ...args);
const transaction = fn => storage.transaction(fn);
async function saveBackup() {
  if (!db) return;
  const {backup} = await import('node:sqlite');
  const dest = resolve(dir, 'backups');
  mkdirSync(dest, {
    recursive: true
  });
  await backup(db, resolve(dest, `activehub-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
  const files = readdirSync(dest).filter(x => x.startsWith('activehub-') && x.endsWith('.sqlite')).sort();
  for (const file of files.slice(0, -14)) unlinkSync(resolve(dest, file));
}
if (db) setInterval(() => saveBackup().catch(console.error), 24 * 3600000).unref();
const now = () => new Date().toISOString();
const paymentMethods = new Set(['cash', 'bank_palestine', 'jawwal_pay', 'palpay']);
if(process.env.CATALOG_SEED!=='0'){
  const catalog=[['ساعة الإنترنت',200],['ساعة الكهرباء',300],['ساعة الإنترنت والكهرباء',500],['قهوة',300],['نسكافيه',300],['شاي',200],['كابتشينو',null]];
  await transaction(async()=>{for(const [name,price] of catalog)if(!await one('SELECT id FROM products WHERE name=?',name))await run('INSERT INTO products(name,price,cost,stock,minimum,service,price_ready) VALUES(?,?,0,0,0,1,?)',name,price??0,price===null?0:1);});
}
async function audit(action, user) {
  await run('INSERT INTO audit(action,actor,created) VALUES(?,?,?)', action, user.username, now());
}
function fail(message, status = 400) {
  throw Object.assign(new Error(message), {
    status
  });
}
function str(v, max = 500) {
  if (typeof v !== 'string') fail('بيانات نصية غير صالحة');
  return v.trim().slice(0, max);
}
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) fail('المبلغ غير صالح');
  return Math.round(n * 100);
}
function integer(v, min = 0) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > 1000000) fail('الكمية غير صالحة');
  return n;
}
function required(v) {
  const s = str(v, 120);
  if (!s) fail('الاسم مطلوب');
  return s;
}
async function balance(id) {
  return (await one(`SELECT COALESCE((SELECT SUM(total) FROM invoices WHERE customer_id=? AND status='active'),0)-COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id=? AND status='active'),0) value`, id, id)).value;
}
if (!await one('SELECT id FROM users LIMIT 1')) {
  if (storage.postgres && !process.env.INITIAL_ADMIN_PASSWORD) throw new Error('Initialize the hosted database before serving requests');
  const credentials = {};
  for (const role of ['admin', 'viewer']) {
    const password = (role === 'admin' ? process.env.INITIAL_ADMIN_PASSWORD : process.env.INITIAL_VIEWER_PASSWORD) || randomBytes(12).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    await run('INSERT INTO users(username,hash,salt,role) VALUES(?,?,?,?)', role, scryptSync(password, salt, 64).toString('hex'), salt, role);
    credentials[role] = password;
  }
  if (!storage.postgres) writeFileSync(resolve(dir, 'initial-credentials.json'), JSON.stringify(credentials, null, 2), {
    mode: 0o600
  });
  console.log('Initial credentials saved locally in data/initial-credentials.json');
}
const defaults = {
  name: approvedBusiness.name,
  tagline: 'مساحتك للتركيز. وجهتك للإنجاز.',
  description: 'مساحة عمل مشتركة في غزة، تجمع المستقلين والطلاب وفرق العمل في بيئة تساعد على التركيز والتواصل.',
  phone: approvedBusiness.phone,
  address: approvedBusiness.address,
  hours: approvedBusiness.hours,
  facebook: approvedBusiness.facebook,
  instagram: approvedBusiness.instagram,
  services: 'مساحات عمل مريحة\nخدمات الإنترنت والطاقة\nالمشروبات والضيافة\nخدمات مالية ورقمية — للاستفسار تواصل معنا',
  currency: '₪'
};
for (const [k, v] of Object.entries(defaults)) await run('INSERT OR IGNORE INTO settings VALUES(?,?)', k, v);
const settings = async () => Object.fromEntries((await all('SELECT * FROM settings')).map(x => [x.key, x.value]));
const siteStore=createSiteStore(storage,settings);
async function snapshot() {
  return {
    settings: await settings(),
    customers: await Promise.all((await all('SELECT * FROM customers ORDER BY id DESC')).map(async c => ({
      ...c,
      balance: await balance(c.id)
    }))),
    products: await all('SELECT * FROM products WHERE active=1 ORDER BY id DESC'),
    invoices: await Promise.all((await all(`SELECT i.*,c.name customer FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC`)).map(async i => ({
      ...i,
      items: await all('SELECT * FROM items WHERE invoice_id=?', i.id)
    }))),
    payments: await all('SELECT p.*,c.name customer FROM payments p LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.id DESC'),
    expenses: await all('SELECT * FROM expenses ORDER BY id DESC'),
    movements: await all('SELECT m.*,p.name product FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC'),
    audit: await all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')
  };
}
const attempts = new Map();
async function body(req) {
  const limit=req.url?.split('?')[0]==='/api/site/upload'?2800000:100000;
  if(req.body!==undefined){const value=typeof req.body==='string'?JSON.parse(req.body):req.body;if(!value||typeof value!=='object'||Array.isArray(value))fail('طلب غير صالح');if(Buffer.byteLength(JSON.stringify(value))>limit)fail('الطلب كبير جداً');return value;}
  const chunks=[];let size=0;
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));size+=chunk.length;
    if (size > limit) fail('الطلب كبير جداً');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    fail('طلب غير صالح');
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const secure = process.env.COOKIE_SECURE === '1' || Boolean(process.env.VERCEL);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const json = (value, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host}`) fail('مصدر الطلب غير مسموح', 403);
      if (url.pathname === '/api/public' && req.method === 'GET') return json({...await settings(),site:await siteStore.published()});
      if (/^\/api\/site-media\/[a-f0-9]{32}$/.test(url.pathname)&&req.method==='GET') {
        const media=await one('SELECT * FROM site_media WHERE id=?',url.pathname.split('/').pop());
        if(!media)fail('الصورة غير موجودة',404);
        res.writeHead(200,{'Content-Type':media.mime,'Cache-Control':'public, max-age=31536000, immutable'});return res.end(Buffer.from(media.content,'base64'));
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        let a = attempts.get(key);
        if (!a || a.until < Date.now()) {
          a = {
            count: 0,
            until: Date.now() + 900000
          };
          attempts.set(key, a);
        }
        if (a.count >= 12) fail('محاولات كثيرة، أعد المحاولة بعد 15 دقيقة', 429);
        const b = await body(req);
        const u = await one('SELECT * FROM users WHERE username=?', str(b.username, 40));
        const hash = scryptSync(str(b.password, 200), u?.salt || 'dummy', 64);
        if (!u || !timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) {
          a.count++;
          fail('اسم المستخدم أو كلمة المرور غير صحيحة', 401);
        }
        attempts.delete(key);
        await run('DELETE FROM sessions WHERE expires<?', Date.now());
        const token = randomBytes(32).toString('hex');
        await run('INSERT INTO sessions VALUES(?,?,?)', token, u.id, Date.now() + 12 * 3600000);
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        return json({
          username: u.username,
          role: u.role
        });
      }
      const token = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1] || '';
      const user = await one('SELECT u.id,u.username,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?', token, Date.now());
      if (!user) fail('يرجى تسجيل الدخول', 401);
      if (url.pathname === '/api/me' && req.method === 'GET') return json(user);
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        await run('DELETE FROM sessions WHERE token=?', token);
        res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json({
          ok: true
        });
      }
      if (url.pathname === '/api/data' && req.method === 'GET') return json(await snapshot());
      if(url.pathname==='/api/site/editor'&&req.method==='GET'){if(user.role!=='admin')fail('هذا الحساب للمشاهدة فقط',403);return json(await siteStore.editor());}
      if (req.method !== 'POST') fail('المسار غير موجود', 404);
      if (user.role !== 'admin') fail('هذا الحساب للمشاهدة فقط', 403);
      const b = await body(req);
      if(/^\/api\/site\/(draft|publish|discard|restore)$/.test(url.pathname))return json(await transaction(async()=>{const result=await siteStore.write(url.pathname.split('/').pop(),b,user);await audit('إدارة صفحة الزوار: '+url.pathname.split('/').pop(),user);return result;}));
      if(url.pathname==='/api/site/upload'){
        const bytes=Buffer.from(typeof b.content==='string'?b.content:'','base64');
        const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
        if(!mime||bytes.length>2000000||bytes.length<20)fail('ارفع صورة PNG أو JPEG أو WebP بحجم أقصى 2 MB');
        const id=randomBytes(16).toString('hex');await run('INSERT INTO site_media(id,mime,content) VALUES(?,?,?)',id,mime,bytes.toString('base64'));return json({url:'/api/site-media/'+id});
      }
      if (url.pathname === '/api/password') {
        const target = await one('SELECT * FROM users WHERE username=?', str(b.username, 40));
        if (!target) fail('الحساب غير موجود');
        const password = str(b.password, 200);
        if (password.length < 12) fail('استخدم كلمة مرور من 12 حرفاً على الأقل');
        const salt = randomBytes(16).toString('hex');
        await transaction(async () => {
          await run('UPDATE users SET hash=?,salt=? WHERE id=?', scryptSync(password, salt, 64).toString('hex'), salt, target.id);
          await run('DELETE FROM sessions WHERE user_id=?', target.id);
          await audit('تغيير كلمة مرور ' + target.username, user);
        });
        return json({
          ok: true
        });
      }
      const result = await transaction(async () => {
        if ((/^\/api\/(delete|restore)\/(customer|invoice|payment)$/).test(url.pathname)) {
          const [, operation, entity] = url.pathname.match(/^\/api\/(delete|restore)\/(customer|invoice|payment)$/);
          const table = {customer:'customers',invoice:'invoices',payment:'payments'}[entity];
          const id = integer(b.id, 1);
          const record = await one(`SELECT * FROM ${table} WHERE id=?`, id);
          if (!record) fail('السجل غير موجود', 404);
          const deleted = operation === 'delete' ? 1 : 0;
          if (record.deleted === deleted) return {
            ok: true
          };
          if (entity === 'customer' && deleted && await balance(id) !== 0) fail('لا يمكن حذف العميل قبل تسوية رصيده المستحق أو الرصيد لصالحه', 409);
          await run(`UPDATE ${table} SET deleted=? WHERE id=?`, deleted, id);
          await audit((deleted ? 'نقل إلى المحذوفات: ' : 'استعادة: ') + (entity === 'customer' ? 'العميل ' + record.name : entity==='payment'?'الدفعة RC-'+id:'الفاتورة #' + id), user);
        } else if (url.pathname === '/api/customers') {
          const name = required(b.name);
          if (b.id) {
            if (!await one('SELECT id FROM customers WHERE id=? AND deleted=0', integer(b.id, 1))) fail('العميل غير موجود');
            await run('UPDATE customers SET name=?,phone=?,notes=? WHERE id=?', name, str(b.phone, 40), str(b.notes), b.id);
          } else await run('INSERT INTO customers(name,phone,notes) VALUES(?,?,?)', name, str(b.phone, 40), str(b.notes));
          await audit('حفظ العميل: ' + name, user);
        } else if (url.pathname === '/api/products') {
          const values = [required(b.name), money(b.price), money(b.cost), integer(b.minimum), b.service ? 1 : 0];
          if (b.id) {
            if (!await one('SELECT id FROM products WHERE id=?', integer(b.id, 1))) fail('الصنف غير موجود');
            await run('UPDATE products SET name=?,price=?,cost=?,minimum=?,service=?,price_ready=1 WHERE id=?', ...values, b.id);
          } else await run('INSERT INTO products(name,price,cost,minimum,service,stock) VALUES(?,?,?,?,?,?)', ...values, integer(b.stock));
          await audit('حفظ الصنف: ' + b.name, user);
        } else if (url.pathname === '/api/stock') {
          const p = await one('SELECT * FROM products WHERE id=? AND active=1', integer(b.product_id, 1));
          if (!p || p.service) fail('اختر منتجاً مخزنياً');
          const q = integer(b.quantity, 1) * (b.kind === 'waste' ? -1 : 1);
          if (p.stock + q < 0) fail('الرصيد المخزني غير كافٍ');
          const cost = money(b.cost);
          await run('UPDATE products SET stock=stock+? WHERE id=?', q, p.id);
          await run('INSERT INTO movements(product_id,quantity,cost,reason,created,actor) VALUES(?,?,?,?,?,?)', p.id, q, cost, required(b.reason), now(), user.username);
          await audit('حركة مخزون: ' + p.name, user);
        } else if (url.pathname === '/api/sales') {
          const key = str(b.key, 100);
          if (key.length < 16) fail('معرف العملية غير صالح');
          const previous = await one('SELECT result FROM requests WHERE key=?', key);
          if (previous) return JSON.parse(previous.result);
          if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) fail('أضف أصنافاً للفاتورة');
          const seen = new Set();
          const items = await Promise.all(b.items.map(async x => {
            const p = await one('SELECT * FROM products WHERE id=? AND active=1', integer(x.id, 1));
            if (!p || seen.has(p.id)) fail('صنف غير صالح أو مكرر');
            seen.add(p.id);
            const quantity = integer(x.quantity, 1);
            if (!p.service && p.stock < quantity) fail('المخزون غير كافٍ: ' + p.name);
            if (!p.price_ready && x.price === undefined) fail('حدد سعر الصنف: ' + p.name);
            const price = x.price === undefined ? p.price : money(x.price);
            if (!p.price_ready && price <= 0) fail('حدد سعراً أكبر من صفر: ' + p.name);
            return {
              ...p,
              price,
              quantity
            };
          }));
          const subtotal = items.reduce((s, p) => s + p.price * p.quantity, 0);
          const discount = money(b.discount || 0);
          if (discount > subtotal) fail('الخصم يتجاوز المجموع');
          const total = subtotal - discount, paid = money(b.paid);
          if (paid > total) fail('المدفوع يتجاوز الإجمالي');
          let customer = b.customer_id ? integer(b.customer_id, 1) : null;
          if (customer && !await one('SELECT id FROM customers WHERE id=? AND deleted=0', customer)) fail('العميل غير موجود');
          if (b.new_customer) {
            if (customer) fail('اختر عميلاً مسجلاً أو عميلاً جديداً');
            const c = b.new_customer;
            const name = required(c.name);
            customer = Number((await run('INSERT INTO customers(name,phone,notes) VALUES(?,?,?)', name, str(c.phone || '', 40), str(c.notes || ''))).lastInsertRowid);
            await audit('إضافة عميل من شاشة البيع: ' + name, user);
          }
          if (!customer && paid !== total) fail('البيع الآجل يتطلب اختيار عميل');
          const method = required(b.method);
          if (!paymentMethods.has(method)) fail('طريقة دفع غير صالحة');
          const id = Number((await run('INSERT INTO invoices(customer_id,created,total,paid,discount,actor) VALUES(?,?,?,?,?,?)', customer, now(), total, paid, discount, user.username)).lastInsertRowid);
          for (const p of items) {
            await run('INSERT INTO items(invoice_id,product_id,name,quantity,price,cost,service) VALUES(?,?,?,?,?,?,?)', id, p.id, p.name, p.quantity, p.price, p.cost, p.service);
            if (!p.service) await run('UPDATE products SET stock=stock-? WHERE id=?', p.quantity, p.id);
          }
          if (paid) await run('INSERT INTO payments(customer_id,invoice_id,amount,method,created,actor) VALUES(?,?,?,?,?,?)', customer, id, paid, method, now(), user.username);
          await audit('إنشاء فاتورة #' + id, user);
          const r = {
            ok: true,
            invoice_id: id
          };
          await run('INSERT INTO requests VALUES(?,?)', key, JSON.stringify(r));
          return r;
        } else if (url.pathname === '/api/payments') {
          const key = str(b.key, 100);
          if (key.length < 16) fail('معرف العملية غير صالح');
          const previous = await one('SELECT result FROM requests WHERE key=?', key);
          if (previous) return JSON.parse(previous.result);
          const id = integer(b.customer_id, 1), amount = money(b.amount);
          if (!await one('SELECT id FROM customers WHERE id=?', id)) fail('العميل غير موجود');
          if (amount <= 0 || amount > await balance(id)) fail('المبلغ يجب أن يكون أكبر من صفر وألا يتجاوز الدين');
          if (!paymentMethods.has(b.method)) fail('طريقة الدفع غير صالحة');
          const payment = Number((await run('INSERT INTO payments(customer_id,amount,method,created,actor) VALUES(?,?,?,?,?)', id, amount, b.method, now(), user.username)).lastInsertRowid);
          await audit('تحصيل من العميل #' + id, user);
          const r = {
            ok: true,
            payment_id: payment
          };
          await run('INSERT INTO requests VALUES(?,?)', key, JSON.stringify(r));
          return r;
        } else if (url.pathname === '/api/refunds') {
          const key = str(b.key, 100);
          if (key.length < 16) fail('معرف العملية غير صالح');
          const previous = await one('SELECT result FROM requests WHERE key=?', key);
          if (previous) return JSON.parse(previous.result);
          const id = integer(b.customer_id, 1), amount = money(b.amount);
          if (!await one('SELECT id FROM customers WHERE id=?', id)) fail('العميل غير موجود');
          if (amount <= 0 || amount > -await balance(id)) fail('المبلغ يتجاوز الرصيد المستحق للعميل');
          if (!paymentMethods.has(b.method)) fail('طريقة الدفع غير صالحة');
          const reason = required(b.reason);
          const payment = Number((await run('INSERT INTO payments(customer_id,amount,method,created,actor) VALUES(?,?,?,?,?)', id, -amount, b.method, now(), user.username)).lastInsertRowid);
          await audit('رد رصيد للعميل #' + id + ' — ' + reason, user);
          const r = {
            ok: true,
            payment_id: payment
          };
          await run('INSERT INTO requests VALUES(?,?)', key, JSON.stringify(r));
          return r;
        } else if (url.pathname === '/api/void') {
          const inv = await one('SELECT * FROM invoices WHERE id=?', integer(b.id, 1));
          if (!inv || inv.status !== 'active') fail('الفاتورة غير قابلة للإلغاء');
          const reason = required(b.reason);
          await run("UPDATE invoices SET status='void',reason=? WHERE id=?", reason, inv.id);
          await run("UPDATE payments SET status='void' WHERE invoice_id=?", inv.id);
          for (const i of await all('SELECT * FROM items WHERE invoice_id=?', inv.id)) if (!i.service) await run('UPDATE products SET stock=stock+? WHERE id=?', i.quantity, i.product_id);
          await audit('إلغاء فاتورة #' + inv.id + ' — ' + reason, user);
        } else if (url.pathname === '/api/expenses') {
          const amount = money(b.amount);
          if (!amount) fail('المبلغ مطلوب');
          await run('INSERT INTO expenses(title,amount,created,actor) VALUES(?,?,?,?)', required(b.title), amount, now(), user.username);
          await audit('مصروف: ' + b.title, user);
        } else if (url.pathname === '/api/settings') {
          for(const key of ['facebook','instagram'])if(b[key]){let parsed;try{parsed=new URL(b[key]);}catch{fail('رابط التواصل غير صالح');}const hosts=key==='facebook'?['facebook.com','www.facebook.com','m.facebook.com']:['instagram.com','www.instagram.com'];if(parsed.protocol!=='https:'||!hosts.includes(parsed.hostname)||parsed.username||parsed.password)fail('استخدم رابط '+key+' الرسمي بصيغة HTTPS');}
          for (const k of Object.keys(defaults)) if ((k in b)) await run('UPDATE settings SET value=? WHERE key=?', str(b[k], 3000), k);
          await audit('تحديث بيانات الموقع', user);
        } else fail('المسار غير موجود', 404);
        return {
          ok: true
        };
      });
      return json(result);
    }
    const fonts = new Set(['Cairo-Variable.ttf', 'Cairo-OFL.txt', 'IBMPlexSansArabic-Regular.ttf', 'IBMPlexSansArabic-Medium.ttf', 'IBMPlexSansArabic-SemiBold.ttf', 'IBMPlexSansArabic-Bold.ttf', 'OFL.txt']);
    const font = url.pathname.startsWith('/fonts/') && fonts.has(url.pathname.slice(7)) ? url.pathname.slice(7) : null;
    const image = ['/images/active-hub-approved.png','/images/active-hub-logo.jpg'].includes(url.pathname);
    const siteAsset=['/site.js','/site.css'].includes(url.pathname);
    const file = siteAsset?url.pathname.slice(1):image ? url.pathname.slice(1) : font ? 'fonts/' + font : url.pathname === '/app.js' ? 'app.js' : url.pathname === '/style.css' ? 'style.css' : url.pathname === '/theme.css' ? 'theme.css' : url.pathname === '/' || url.pathname === '/admin' ? 'index.html' : null;
    if (!file) fail('غير موجود', 404);
    const content = readFileSync(new URL('./public/' + file, import.meta.url));
    res.writeHead(200, {
      'Content-Type': ({
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.ttf': 'font/ttf',
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.txt': 'text/plain; charset=utf-8'
      })[extname(file)],
      ...font || image ? {
        'Cache-Control': 'public, max-age=86400'
      } : {}
    });
    res.end(content);
  } catch (e) {
    json({
      error: e.status ? e.message : 'تعذر إتمام العملية'
    }, e.status || 500);
    if (!e.status) console.error(e);
  }
});
export default server;
if (!process.env.VERCEL) server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Active Hub: http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`);
  saveBackup().catch(console.error);
});
