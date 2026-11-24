// Turns "this anime" into the provider listings that really are that anime: lists each attached candidate, checks it against
// the catalogue entity (identity.mjs) and keeps only the accepted ones. Everything is reported, nothing is silently merged.
import {verifyCandidate,listingStats,reportLines} from './identity.mjs';
import {inspectCandidates,episodeMenu} from './availability.mjs';

export async function verifyEntity(entity,{byKey=new Map(),list,graceMs=0,searchIncomplete=false}){
  const cands=entity.candidates||[];
  const rows=await inspectCandidates(cands.map(c=>({provider:c.provider,id:c.id})),list,{graceMs});
  const results=[],accepted=[];
  rows.forEach((row,i)=>{
    const cand=cands[i];
    if(row.status!=='checked'){
      results.push({accept:false,pending:true,provider:cand.provider,media:cand.id,title:cand.title,confirm:cand.confirm,count:0,max:0,reason:'the episode list did not load in time'});
      return;
    }
    const verdict=verifyCandidate(entity,cand,listingStats(row.episodes),byKey);
    results.push(verdict);
    if(verdict.accept)accepted.push({...row,title:cand.title,confirm:cand.confirm,reason:verdict.reason});
  });
  const pending=results.filter(r=>r.pending).length;
  return {key:entity.key,at:Date.now(),accepted,results,pending,
    rejected:results.filter(r=>!r.accept&&!r.pending),
    menu:episodeMenu(accepted,{incomplete:pending>0||searchIncomplete}),
    report:reportLines(entity,results)};
}
