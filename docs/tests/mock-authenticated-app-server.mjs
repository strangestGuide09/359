import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const docs = new URL("../", import.meta.url);
const mock = `<script>
globalThis.__testErrors=[];
const recordTestError=value=>{ globalThis.__testErrors.push(String(value)); document.documentElement.dataset.testErrors=globalThis.__testErrors.join(" | "); };
addEventListener("error",event=>recordTestError(event.error?.stack||event.message));
addEventListener("unhandledrejection",event=>recordTestError(event.reason?.stack||event.reason));
globalThis.__GROCERY_LEDGER_TEST_CLIENT__ = (() => {
  const session = { user: { id: "ritesh", email: "ritesh@example.test", user_metadata: { display_name: "Ritesh" } } };
  const members = [{ household_id:"home", user_id:"ritesh", role:"owner", display_name:"Ritesh" }, { household_id:"home", user_id:"ekta", role:"partner", display_name:"Ekta" }];
  const purchases = [
    { id:"july", household_id:"home", label:"Instamart", amount:727, paid_by:"ritesh", purchased_on:"2026-07-03", created_at:"2026-08-13T10:00:00Z", archived_at:null, is_personal:false, purchase_items:[{id:"j1",name:"Green Chilli",line_total:27,is_personal:false,is_tracked_for_restock:true,display_order:0}] },
    { id:"aug", household_id:"home", label:"Blinkit", amount:603, paid_by:"ekta", purchased_on:"2026-08-13", created_at:"2026-08-13T11:00:00Z", archived_at:null, is_personal:false, purchase_items:[{id:"a1",name:"Milk",line_total:603,is_personal:false,is_tracked_for_restock:true,display_order:0}] }
  ];
  const rows = { household_members: members, households:[{id:"home",name:"All in 359",archived_at:null,purge_after:null}], purchases, receipt_backed_settlement_history:[], settlement_allocations:[], settlements:[] };
  const query = table => {
    const filters=[]; let single=false; let archived="any";
    const q={ select(){return q}, eq(field,value){filters.push([field,value]);return q}, is(field,value){if(field==="archived_at"&&value===null) archived="active";return q}, not(field,op,value){if(field==="archived_at") archived="archived";return q}, maybeSingle(){single=true;return q}, then(resolve){let data=[...(rows[table]||[])].filter(row=>filters.every(([field,value])=>row[field]===value)); if(archived==="active")data=data.filter(row=>row.archived_at==null); if(archived==="archived")data=data.filter(row=>row.archived_at!=null); return Promise.resolve({data:single?(data[0]||null):data,error:null}).then(resolve)} };
    return q;
  };
  return { auth:{ getSession:async()=>({data:{session},error:null}),getUser:async()=>({data:{user:session.user},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}) }, from:query, rpc:async()=>({data:null,error:null}), channel:()=>({on(){return this},subscribe(){return this},unsubscribe(){}}) };
})();
setTimeout(()=>{
  const box=e=>{const r=e?.getBoundingClientRect();return r&&{l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height}};
  const buttons=[...document.querySelectorAll(".command-actions button,#settle")].map(e=>({text:e.textContent.trim(),...box(e)}));
  const overlaps=[]; for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i],b=buttons[j];if(a.l<b.r&&a.r>b.l&&a.t<b.b&&a.b>b.t)overlaps.push([a.text,b.text]);}
  const rail=document.querySelector(".purchase-date-strip");
  const metrics={viewport:[innerWidth,innerHeight],pageScroll:[document.documentElement.scrollWidth,document.documentElement.clientWidth],title:box(document.querySelector(".household-masthead h1")),members:box(document.querySelector(".member-summary")),rail:box(rail),railScroll:rail?[rail.scrollWidth,rail.clientWidth]:null,buttons,overlaps};
  const output=document.createElement("output"); output.id="actual-app-layout-metrics"; output.setAttribute("aria-label","Actual app layout metrics"); output.style.cssText="position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;font-size:1px"; output.textContent=JSON.stringify(metrics); document.body.append(output);
},700);
</script>`;

const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png"};
export function createMockAuthenticatedAppServer() {
  return createServer(async (request,response)=>{
  try {
    const pathname=new URL(request.url,"http://localhost").pathname;
    if(pathname==="/mobile-harness") {
      response.writeHead(200,{"content-type":"text/html","cache-control":"no-store"});
      return response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Mobile actual-app harness</title><style>html,body{margin:0;background:#ddd}iframe{display:block;width:390px;height:844px;border:0}</style><iframe src="/?embedded=mobile" title="Grocery Ledger mobile"></iframe>');
    }
    if(pathname==="/" || pathname==="/index.html") {
      let html=await readFile(new URL("../index.html",import.meta.url),"utf8");
      html=html.replace('<script type="module" src="app.js"></script>', `${mock}<script type="module" src="app.js"></script>`);
      response.writeHead(200,{"content-type":"text/html","cache-control":"no-store"}); return response.end(html);
    }
    const safe=normalize(pathname).replace(/^\.\.(\/|\\)/,"").replace(/^\//,"");
    const file=new URL(safe,docs);
    let body=await readFile(file);
    if(pathname==="/app.js") body=Buffer.from(body.toString().replace('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";','const createClient = () => globalThis.__GROCERY_LEDGER_TEST_CLIENT__;').replace('import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";','const pdfjsLib = { GlobalWorkerOptions: {} };'));
    response.writeHead(200,{"content-type":types[extname(safe)]||"application/octet-stream","cache-control":"no-store"}); response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] || 8767);
  createMockAuthenticatedAppServer().listen(port,"127.0.0.1",()=>console.log(`Mock authenticated actual app at http://127.0.0.1:${port}/`));
}
