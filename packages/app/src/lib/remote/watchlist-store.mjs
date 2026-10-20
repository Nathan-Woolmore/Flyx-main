const kinds=new Set(['movie','tv','anime','manga']);
export function createWatchlistStore({storage,key,changed=()=>{},now=Date.now}) {
 function read(){const current=key();if(!current)throw Object.assign(new Error('Account required'),{code:'WATCHLIST_ACCOUNT_REQUIRED'});const items=JSON.parse(storage.getItem(current)||'[]');if(!Array.isArray(items)||items.length>2000)throw new Error('Invalid watchlist');return{current,items};}
 return operation=>{
  const {current,items}=read();
  if(operation.operation==='list')return{items,syncScope:current};
  if(operation.expectedScope!==undefined&&operation.expectedScope!==current)throw Object.assign(new Error('Watchlist account changed'),{code:'WATCHLIST_SCOPE_CHANGED'});
  const receiptKey=current+':phone-receipts';
  const mutationID=operation.mutationID;
  if(mutationID!==undefined&&(typeof mutationID!=='string'||!/^[a-f0-9-]{36}$/i.test(mutationID)))throw new Error('Invalid watchlist mutation');
  const receipts=mutationID?JSON.parse(storage.getItem(receiptKey)||'[]'):[];
  if(mutationID&&receipts.includes(mutationID))return{ok:true};
  const item=operation.item;
  if(!item||!kinds.has(item.kind)||typeof item.id!=='string'||!item.id||item.id.length>300)throw new Error('Invalid watchlist item');
  const match=value=>String(value.contentId)===item.id&&value.mediaType===item.kind;
  let next;
  if(operation.operation==='remove')next=items.filter(value=>!match(value));
  else if(operation.operation==='add'){
   if(typeof item.title!=='string'||item.title.length>500)throw new Error('Invalid watchlist title');
   if(items.some(match)){if(mutationID)storage.setItem(receiptKey,JSON.stringify([...receipts.slice(-511),mutationID]));return{ok:true};}
   next=[{id:`${item.kind}-${item.id}`,contentId:item.id,mediaType:item.kind,title:item.title,posterPath:item.posterURL??undefined,rating:item.rating??undefined,year:item.releaseDate?.slice(0,4),releaseDate:item.releaseDate??undefined,addedAt:now()},...items];
  }else throw new Error('Invalid watchlist operation');
  if(next.length>2000)throw new Error('Watchlist is full');
  storage.setItem(current,JSON.stringify(next));
  if(mutationID)storage.setItem(receiptKey,JSON.stringify([...receipts.slice(-511),mutationID]));
  changed();return{ok:true};
 };
}
