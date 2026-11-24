// Wait for a set of slow, independent sources without letting the slowest one decide the wait.
// Once one source has answered usefully, the rest get `graceMs` to finish; anything still pending
// is reported as timed out (it keeps running and fills the caches for later).
export function settleWithGrace(promises,{graceMs=0,isGood=()=>true}={}){
  const out=new Array(promises.length).fill(null);
  const wrapped=promises.map((p,i)=>Promise.resolve(p).then(value=>{out[i]={status:'fulfilled',value}},reason=>{out[i]={status:'rejected',reason}}));
  if(!graceMs||!promises.length)return Promise.all(wrapped).then(()=>out);
  return new Promise(resolve=>{
    let timer=null,left=promises.length;
    const finish=()=>{clearTimeout(timer);resolve(out.map(x=>x||{status:'rejected',reason:new Error('Provider timed out')}))};
    wrapped.forEach((w,i)=>w.then(()=>{
      left--;
      if(left===0)return finish();
      if(!timer&&out[i].status==='fulfilled'&&isGood(out[i].value))timer=setTimeout(finish,graceMs);
    }));
  });
}
