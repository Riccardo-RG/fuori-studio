import { createServer } from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { dirname,resolve,sep,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState,newConversation,providerStatus,chatTurn,shutdownChat } from './lib/chat.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'dist');
const port=Number(process.env.PORT||4386);
const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>40000)throw Error('Messaggio troppo lungo.');}try{return JSON.parse(text);}catch{throw Error('Messaggio non valido.');}}
await getState();
const server=createServer(async(req,res)=>{
 if(!allowedHosts.has(req.headers.host)){res.writeHead(403);res.end('Host non consentito');return;}
 const origin=req.headers.origin;if(origin&&!Array.from(allowedHosts).some(host=>origin===`http://${host}`)){res.writeHead(403);res.end('Origine non consentita');return;}
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  if(pathname.startsWith('/api/')){
   if(req.method==='GET'&&pathname==='/api/studio'){json(res,200,{...(await getState()),provider:await providerStatus()});return;}
   if(req.method!=='POST'||req.headers['x-fuori-studio']!=='local'||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'Richiesta non consentita.'});return;}
   if(pathname==='/api/conversation/new'){json(res,200,await newConversation());return;}
   if(pathname==='/api/chat'){
    const payload=await body(req);if((await getState()).busy){json(res,409,{error:'Il team sta già rispondendo.'});return;}
    if(typeof payload.message!=='string'||!payload.message.trim()||payload.message.length>12000){json(res,400,{error:'Scrivi un messaggio tra 1 e 12.000 caratteri.'});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});res.flushHeaders();
    const controller=new AbortController();let complete=false;
    res.on('close',()=>{if(!complete)controller.abort();});
    const emit=(type,data)=>{if(!res.destroyed)res.write(`data: ${JSON.stringify({type,...data})}\n\n`);};
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': waiting\n\n');},15000);
    try{await chatTurn(payload.message,emit,controller.signal);}catch(error){emit('error',{message:error.message});}
    finally{complete=true;clearInterval(heartbeat);res.end();}return;
   }
   json(res,404,{error:'Comando non trovato.'});return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
  const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+sep)){res.writeHead(403);res.end('Accesso negato');return;}
  const info=await stat(file);if(!info.isFile()){res.writeHead(404);res.end('Non trovato');return;}
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:await readFile(file));
 }catch(error){if(!res.headersSent)json(res,req.url.startsWith('/api/')?400:404,{error:req.url.startsWith('/api/')?error.message:'Non trovato'});else res.end();}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`La porta ${port} è già occupata. Prova PORT=4387 npm start.`:error.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`Fuori Studio è pronto: http://127.0.0.1:${port}/`));

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{shutdownChat();server.close();setTimeout(()=>process.exit(0),1700);});
