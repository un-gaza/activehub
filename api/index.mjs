import server from '../server.mjs';
export default function handler(req,res){
 const url=new URL(req.url,'https://localhost');
 if(url.searchParams.has('_route'))req.url='/api/'+url.searchParams.get('_route');
 server.emit('request',req,res);
}
