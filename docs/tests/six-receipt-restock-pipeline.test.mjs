import assert from "node:assert/strict";
import test from "node:test";
import { parseReceipt } from "../receipt-parser.js";
import { normalizeReviewedItem, reviewedItemsForSave } from "../reviewed-item-state.js";
import { importReviewedPurchase, loadReviewedPurchases } from "../reviewed-purchase-store.js";
import { canonicalRestockKey, restockEligibility, qualifiesForRestockSuggestion } from "../restock.js";

function clientStore() {
  const purchases=[];
  return { purchases, rpc:async(name,args)=>{ assert.equal(name,"import_reviewed_purchase"); const id=`receipt-${purchases.length+1}`; purchases.push({id,household_id:args.p_household_id,label:args.p_label,category:args.p_category,purchased_on:args.p_purchased_on,archived_at:null,purchase_items:args.p_items.map((item,index)=>({...item,id:`${id}-item-${index}`}))}); return {data:id,error:null}; }, from:table=>{ assert.equal(table,"purchases"); const q={select(){return q},eq(){return q},is:async()=>({data:purchases,error:null}),not:async()=>({data:[],error:null})}; return q;} };
}

test("six local receipts save, reload, and unlock Possible Buys on distinct actual dates", async () => {
  const client=clientStore();
  const receipts=[
    ["Date of Invoice: 01-07-2026","Akshayakalpa Organic Malai Paneer (Pack) 145.00","Amount payable 145.00"],
    ["Invoice Date: 02 Jul 2026","Akshayakalpa Organic Malai Paneer Pack 145.00","Amount payable 145.00"],
    ["Date of Invoice: 03-07-2026","Boondi 75.00","Amount payable 75.00"],
    ["Purchase Date: July 5, 2026","Milk 60.00","Amount payable 60.00"],
    ["Invoice: 07-Jul-2026","Tomato 40.00","Amount payable 40.00"],
    ["Receipt Date: 09/07/2026","Rice 80.00","Amount payable 80.00"]
  ];
  for (const [index,lines] of receipts.entries()) {
    const parsed=parseReceipt([[{y:800,text:"Blinkit"},...lines.map((text,line)=>({y:700-line*30,text}))]],"2026-08-20");
    assert.ok(parsed.defaults.date.startsWith("2026-07-"));
    const items=reviewedItemsForSave(parsed.items.map(normalizeReviewedItem));
    await importReviewedPurchase(client,{p_household_id:"household",p_paid_by:"ritesh",p_exact_pdf_hash:`exact-${index}`,p_content_hash:`content-${index}`,p_content_hash_reliable:true,p_label:parsed.defaults.label,p_category:"Groceries",p_amount:Number(parsed.defaults.amount),p_purchased_on:parsed.defaults.date,p_is_personal:false,p_items:items});
  }
  const loaded=await loadReviewedPurchases(client,"household");
  assert.equal(loaded.data.length,6);
  const {groups,stats}=restockEligibility(loaded.data);
  const paneer=groups.get(canonicalRestockKey("Akshayakalpa Organic Malai Paneer"));
  assert.ok(paneer);
  assert.deepEqual([...new Set(paneer.map(item=>item.purchased_on))], ["2026-07-01","2026-07-02"]);
  assert.equal(qualifiesForRestockSuggestion(paneer),true);
  assert.equal(stats.repeatTypes,1);
});
