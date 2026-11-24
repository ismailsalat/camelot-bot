import {timingSafeEqual} from 'node:crypto';
const BRIDGE_ROUTES=new Set(['GET /api/state','GET /api/providers','GET /api/search','GET /api/episodes','POST /api/check','POST /api/play','POST /api/stop']);
function equal(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function apiAccess(req,path,{cloud=false,adminKey='',bridgeKey=''}={}) {
  const auth=req.headers.authorization||'';
  if(auth){
    if(!auth.startsWith('Bearer '))return null;
    const key=auth.slice(7);
    if(adminKey&&equal(key,adminKey))return 'admin';
    if(bridgeKey.length>=32&&equal(key,bridgeKey)&&BRIDGE_ROUTES.has(`${req.method} ${path}`))return 'bridge';
    return null;
  }
  return cloud?null:'local';
}
export function originAllowed(req,{cloud=false,role}={}) {
  if(req.method!=='POST')return true;
  const origin=req.headers.origin;
  if(!origin)return role==='bridge'||role==='admin';
  return origin===`${cloud?'https':'http'}://${req.headers.host}`;
}
