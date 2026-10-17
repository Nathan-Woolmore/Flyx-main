import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
export function createRemoteSources(request,{now=Date.now,makeID=randomUUID}={}){
 const grants=new Map();
 return async(body,owner)=>{
  for(const[id,g]of grants)if(g.expires<=now())grants.delete(id);
  if(body.operation==='list'){
   const value=await request({operation:'list'});const items=[];
   for(const item of(value.items??[]).slice(0,100)){
    if(typeof item.key!=='string'||typeof value.stamp!=='string')continue;
    if(grants.size>=512)grants.delete(grants.keys().next().value);
    const id=makeID();grants.set(id,{owner,key:item.key,stamp:value.stamp,expires:now()+60000});
    const clean=v=>String(v??'').replace(/https?:\/\/\S+/gi,'').slice(0,80);
    items.push({id,provider:clean(item.provider),quality:clean(item.quality),language:clean(item.language),format:clean(item.format),selected:item.selected===true});
   }return{items};
  }
  if(body.operation!=='select'||Object.keys(body).some(k=>!['operation','sourceID'].includes(k)))throw fail('SOURCE_INVALID');
  const grant=grants.get(body.sourceID);if(!grant||grant.owner!==owner||grant.expires<=now())throw fail('SOURCE_EXPIRED');grants.delete(body.sourceID);
  return request({operation:'select',key:grant.key,stamp:grant.stamp});
 };
}
