const origin=process.env.CHECK_ORIGIN||'http://127.0.0.1:3000';
for(const path of ['/','/admin','/app.js','/style.css','/api/public']){
 const r=await fetch(origin+path);
 if(!r.ok)throw new Error(`${path}: ${r.status}`);
 console.log(`${path}: ${r.status}`);
}
