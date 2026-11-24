// Some provider libraries catch network errors themselves, print them and return an empty list, so a site whose domain
// no longer exists looks like "no results" forever (and logs the same ENOTFOUND on every search). A DNS lookup, cached
// for a few minutes, lets us treat that as a real provider failure that the health registry can see.
import {lookup} from 'node:dns/promises';
const cache=new Map();
export async function assertHostResolves(host,{lookupFn=lookup,now=()=>Date.now(),okMs=600000,badMs=120000}={}){
  if(!host)return;
  const hit=cache.get(host);
  if(hit&&hit.until>now()){if(hit.error)throw hit.error;return}
  try{await lookupFn(host);cache.set(host,{until:now()+okMs})}
  catch(e){
    if(!['ENOTFOUND','EAI_AGAIN','ENODATA'].includes(e?.code))return;       // other lookup trouble: let the real request decide
    const error=Object.assign(new Error(`getaddrinfo ${e.code} ${host}`),{code:e.code});
    cache.set(host,{until:now()+badMs,error});throw error;
  }
}
export const hostOf=url=>{try{return new URL(url).hostname}catch{return null}};
export const _clearHostCache=()=>cache.clear();
