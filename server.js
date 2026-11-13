'use strict';
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://xbetpogdplnlgfafjfmo.supabase.co').replace(/\/$/, '');
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLIC = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_aYvm5zJJRwM7qUaXQht-PQ_Whw5ZCzp';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET ? new Razorpay({key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET}) : null;
const ORIGINS = new Set(['https://royalsteel.in', 'https://www.royalsteel.in']);
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && !ORIGINS.has(origin)) return res.status(403).json({success:false,message:'Origin not allowed'});
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:'30kb'}));

// Product ID order is shared with the 46 Blogger product cards.
const SLUGS = [
'butterfly-bed','royal-sofa','king-chair','dining-table','steel-almirah','wardrobe','office-chair','computer-table','shoe-rack','dressing-table','balcony-grill','steel-rack','single-steel-bed','steel-bunk-bed','l-shape-sofa','sofa-cum-bed','steel-dining-chair','kitchen-storage-rack','tv-unit','office-table','study-table','steel-main-gate','center-table','side-table','metal-bookshelf','metal-clothes-stand','metal-corner-rack','stainless-steel-kitchen-trolley','office-filing-cabinet','folding-steel-bed','metal-garden-bench','metal-bar-stool','steel-window-grill','staircase-railing','metal-dining-bench','folding-dining-table','nesting-coffee-table-set','ottoman-stool','recliner-chair','stainless-steel-utility-cabinet','steel-locker-cabinet','kitchen-pantry-cabinet','stainless-steel-bathroom-rack','laptop-desk','printer-stand','office-reception-desk'
];
function requireDb(){if(!SUPABASE_URL||!SUPABASE_SECRET||!SUPABASE_PUBLIC)throw new Error('Supabase is not configured');}
function requirePay(){requireDb();if(!razorpay)throw new Error('Razorpay is not configured');}
async function db(path,options={}){
  requireDb();
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...options,headers:{apikey:SUPABASE_SECRET,Authorization:`Bearer ${SUPABASE_SECRET}`,'Content-Type':'application/json',Prefer:'return=representation',...(options.headers||{})}});
  const data=await r.json().catch(()=>null);
  if(!r.ok){console.error('Supabase REST error',r.status,data&&data.message);throw new Error('Database operation failed');}
  return data;
}
async function dbPublic(path,options={}){
  if(!SUPABASE_URL||!SUPABASE_PUBLIC)throw new Error('Public Supabase configuration is missing');
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...options,headers:{apikey:SUPABASE_PUBLIC,Authorization:`Bearer ${SUPABASE_PUBLIC}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await r.json().catch(()=>null);
  if(!r.ok){console.error('Public catalogue request failed',r.status,data&&data.message);throw new Error('Public catalogue read failed');}
  return data;
}
async function authUser(req){
  const m=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);if(!m)return null;
  const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SUPABASE_PUBLIC,Authorization:`Bearer ${m[1]}`}});
  if(!r.ok)return null;const u=await r.json().catch(()=>null);
  if(!u||!u.id||(!(u.email&&u.email_confirmed_at)&&!(u.phone&&u.phone_confirmed_at)))return null;
  return u;
}
async function adminUser(req){
  const u=await authUser(req);if(!u)return null;
  const q=new URLSearchParams({select:'role',id:`eq.${u.id}`,limit:'1'});
  const p=await db(`profiles?${q}`);return p&&p[0]&&p[0].role==='admin'?u:null;
}
async function catalog(){
  const q=new URLSearchParams({select:'id,slug,name,category,description,image_url,price,stock_quantity,sku,is_active,is_featured,updated_at',slug:`in.(${SLUGS.join(',')})`,is_active:'eq.true',limit:'100'});
  const rows=await dbPublic(`products?${q}`);const map=new Map((rows||[]).map(p=>[p.slug,p]));
  return SLUGS.map((slug,i)=>{const p=map.get(slug);return p?{productId:i+1,databaseId:p.id,slug:p.slug,name:p.name,category:p.category,description:p.description||'',imageUrl:p.image_url||null,price:Number(p.price||0),stockQuantity:p.stock_quantity,sku:p.sku,isActive:!!p.is_active,updatedAt:p.updated_at}:null;}).filter(Boolean);
}
function customerFrom(body){
  const name=typeof body.customerName==='string'?body.customerName.trim():'';
  const phone=String(body.customerPhone||'').replace(/\D/g,'');
  const email=String(body.customerEmail||'').trim();
  const address=typeof body.deliveryAddress==='string'?body.deliveryAddress.trim():'';
  if(name.length<2||name.length>100)throw new Error('Valid customer name is required.');
  if(!/^\d{10,15}$/.test(phone))throw new Error('Enter a valid mobile number.');
  if(email&&(email.length>150||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new Error('Enter a valid email address.');
  if(address.length<5||address.length>1000)throw new Error('Enter your complete delivery address.');
  return {name,phone,email:email||null,address};
}
async function cartItems(input,requirePriced){
  if(!Array.isArray(input)||input.length<1||input.length>46)throw new Error('Invalid cart.');
  const seen=new Set();
  for(const x of input){if(!x||!Number.isSafeInteger(x.productId)||!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>20||x.productId<1||x.productId>46)throw new Error('Invalid product or quantity.');if(seen.has(x.productId))throw new Error('Duplicate product in cart.');seen.add(x.productId);}
  const all=await catalog();const byId=new Map(all.map(p=>[p.productId,p]));
  return input.map(x=>{const p=byId.get(x.productId);if(!p||!p.isActive)throw new Error('Product unavailable.');const price=Number(p.price||0);if(!Number.isSafeInteger(price)||price<0)throw new Error('Invalid product price.');if(requirePriced&&price===0)throw new Error(`${p.name} needs a confirmed quotation before online payment.`);return {...p,quantity:x.quantity,unitPrice:price,lineTotal:price*x.quantity};});
}
async function saveOrder({user,customer,items,total,status,provider,razorpayOrderId,notes}){
  const orderRows=await db('orders',{method:'POST',body:JSON.stringify([{
    user_id:user.id,customer_name:customer.name,customer_phone:customer.phone,customer_email:customer.email||user.email||null,
    delivery_address:customer.address,product_name:items.map(x=>`${x.name} x ${x.quantity}`).join(', '),quantity:items.reduce((n,x)=>n+x.quantity,0),
    unit_price:items.length===1?items[0].unitPrice:0,subtotal_amount:total,total_amount:total,order_status:'pending',payment_status:status,
    payment_provider:provider||null,razorpay_order_id:razorpayOrderId||null,notes:notes||null
  }])});
  if(!orderRows||!orderRows.length)throw new Error('Order could not be saved.');
  const order=orderRows[0];
  try{
    await db('order_items',{method:'POST',body:JSON.stringify(items.map(x=>({order_id:order.id,product_id:x.databaseId,product_name:x.name,product_sku:x.sku,image_url:x.imageUrl,quantity:x.quantity,unit_price:x.unitPrice,line_total:x.lineTotal})))});
  }catch(e){try{await db(`orders?id=eq.${encodeURIComponent(order.id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});}catch(clean){console.error('Order cleanup failed',clean.message);}throw e;}
  return order;
}
app.get('/',(req,res)=>res.json({service:'ROYALSTEEL Payment Backend',status:'running'}));
app.get('/health',(req,res)=>res.json({service:'ROYALSTEEL Payment Backend',status:'running'}));
app.get('/catalog',async(req,res)=>{res.setHeader('Cache-Control','public, max-age=30, stale-while-revalidate=60');try{const p=await catalog();res.json({success:true,count:p.length,products:p});}catch(e){console.error('Catalog lookup failed',e.message);res.status(503).json({success:false,message:'Product catalogue is temporarily unavailable.'});}});
app.patch('/admin/product-price',async(req,res)=>{try{if(!await adminUser(req))return res.status(403).json({success:false,message:'Verified admin access is required.'});const id=Number(req.body&&req.body.productId),price=Number(req.body&&req.body.price),slug=SLUGS[id-1];if(!slug||!Number.isSafeInteger(price)||price<0||price>100000000)return res.status(400).json({success:false,message:'Enter a valid product and whole-rupee price. Use 0 for Price on Request.'});const q=new URLSearchParams({slug:`eq.${slug}`});const rows=await db(`products?${q}`,{method:'PATCH',body:JSON.stringify({price,updated_at:new Date().toISOString()})});if(!rows||!rows.length)return res.status(404).json({success:false,message:'Product was not found.'});res.json({success:true,product:{productId:id,name:rows[0].name,price:Number(rows[0].price)}});}catch(e){console.error('Admin price update failed',e.message);res.status(500).json({success:false,message:'Could not update product price.'});}});
app.post('/create-contact-order',async(req,res)=>{try{const user=await authUser(req);if(!user)return res.status(401).json({success:false,message:'Sign in with a verified account first.'});const customer=customerFrom(req.body||{}),items=await cartItems(req.body&&req.body.items,false),total=items.reduce((n,x)=>n+x.lineTotal,0),quotes=items.filter(x=>x.unitPrice===0);const order=await saveOrder({user,customer,items,total,status:quotes.length?'quote_required':'unpaid',provider:'whatsapp',notes:quotes.length?`Quotation required for: ${quotes.map(x=>x.name).join(', ')}`:'WhatsApp order request'});res.json({success:true,order_number:order.order_number,tracking_code:order.tracking_code,quote_required:quotes.map(x=>x.name),subtotal_amount:total});}catch(e){console.error('Contact order failed',e.message);res.status(/Invalid|valid|Enter|unavailable|cart|Duplicate/i.test(e.message)?400:500).json({success:false,message:e.message||'Could not save order request.'});}});
app.post('/create-order',async(req,res)=>{try{requirePay();const user=await authUser(req);if(!user)return res.status(401).json({success:false,message:'Sign in with a verified account first.'});const customer=customerFrom(req.body||{}),items=await cartItems(req.body&&req.body.items,true),total=items.reduce((n,x)=>n+x.lineTotal,0),amount=total*100;if(!Number.isSafeInteger(amount)||amount<100||amount>100000000)return res.status(400).json({success:false,message:'Invalid total amount.'});const receipt=`rs_${crypto.randomUUID().replace(/-/g,'').slice(0,32)}`;const rp=await razorpay.orders.create({amount,currency:'INR',receipt});const order=await saveOrder({user,customer,items,total,status:'unpaid',provider:'razorpay',razorpayOrderId:rp.id});try{await db('payments',{method:'POST',body:JSON.stringify([{order_id:order.id,user_id:user.id,provider:'razorpay',provider_order_id:rp.id,amount:total,currency:'INR',status:'created'}])});}catch(e){console.error('Payment ledger insert failed',e.message);}res.json({success:true,key_id:RAZORPAY_KEY_ID,order:{id:rp.id,amount:rp.amount,currency:rp.currency},database_order_id:order.id,order_number:order.order_number,tracking_code:order.tracking_code});}catch(e){console.error('Create payment order failed',e.message);res.status(/quotation before online payment/i.test(e.message)?409:/Invalid|valid|Enter|unavailable|cart/i.test(e.message)?400:500).json({success:false,message:e.message||'Could not create payment order.'});}});
const rate=new Map();
app.post('/track-order',async(req,res)=>{res.setHeader('Cache-Control','no-store, max-age=0');try{const code=String(req.body&&req.body.trackingCode||'').trim().toUpperCase().replace(/\s+/g,''),phone=String(req.body&&req.body.customerPhone||'').replace(/\D/g,'');if(!/^ROYAL-STEEL-[0-9A-F]{16}$/.test(code)||!/^\d{10,15}$/.test(phone))return res.status(400).json({success:false,message:'Enter the ROYAL-STEEL Tracking ID and checkout mobile number.'});const ip=String(req.headers['x-forwarded-for']||req.ip||'unknown').split(',')[0],key=ip+':'+phone,now=Date.now();let b=rate.get(key);if(!b||now-b.at>=600000)b={at:now,n:0};if(b.n>=8){res.setHeader('Retry-After','120');return res.status(429).json({success:false,message:'Too many tracking attempts. Please try later.'});}b.n++;rate.set(key,b);if(rate.size>3000)for(const [k,v] of rate)if(now-v.at>=600000)rate.delete(k);const q=new URLSearchParams({select:'id,tracking_code,product_name,quantity,total_amount,order_status,payment_status,created_at,updated_at',tracking_code:`eq.${code}`,customer_phone:`eq.${phone}`,limit:'2'}),found=await db(`orders?${q}`);if(!found||found.length!==1)return res.status(404).json({success:false,message:'Tracking ID and mobile number did not match an order.'});const o=found[0],eq=new URLSearchParams({select:'status,note,created_at',order_id:`eq.${o.id}`,order:'created_at.asc',limit:'100'}),events=await db(`order_status_events?${eq}`).catch(()=>[]);res.json({success:true,order:{tracking_code:o.tracking_code,product_name:o.product_name,quantity:o.quantity,total_amount:o.total_amount,order_status:o.order_status,payment_status:o.payment_status,created_at:o.created_at,updated_at:o.updated_at,events:events||[]}});}catch(e){console.error('Tracking lookup failed',e.message);res.status(500).json({success:false,message:'Unable to look up this order right now.'});}});
app.post('/verify-payment',async(req,res)=>{try{requirePay();const user=await authUser(req);if(!user)return res.status(401).json({success:false,verified:false,message:'Sign in again before verifying payment.'});const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};if(typeof razorpay_order_id!=='string'||typeof razorpay_payment_id!=='string'||typeof razorpay_signature!=='string'||!/^order_[a-zA-Z0-9]+$/.test(razorpay_order_id)||!/^pay_[a-zA-Z0-9]+$/.test(razorpay_payment_id)||!/^[a-fA-F0-9]{64}$/.test(razorpay_signature))return res.status(400).json({success:false,verified:false,message:'Invalid payment details.'});const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest(),received=Buffer.from(razorpay_signature,'hex');if(expected.length!==received.length||!crypto.timingSafeEqual(expected,received))return res.status(400).json({success:false,verified:false,message:'Payment signature verification failed.'});const ro=await razorpay.orders.fetch(razorpay_order_id),payment=await razorpay.payments.fetch(razorpay_payment_id);if(payment.order_id!==ro.id||payment.status!=='captured'||payment.amount!==ro.amount||payment.currency!==ro.currency)return res.status(400).json({success:false,verified:false,message:'Payment details do not match a captured order.'});const q=new URLSearchParams({select:'id,user_id,tracking_code,payment_status',razorpay_order_id:`eq.${razorpay_order_id}`,user_id:`eq.${user.id}`,limit:'1'}),rows=await db(`orders?${q}`);if(!rows||rows.length!==1)return res.status(404).json({success:false,verified:false,message:'Saved customer order was not found.'});const o=rows[0];if(o.payment_status!=='paid'){const uq=new URLSearchParams({id:`eq.${o.id}`});await db(`orders?${uq}`,{method:'PATCH',body:JSON.stringify({payment_status:'paid',order_status:'confirmed',payment_id:payment.id,updated_at:new Date().toISOString()})});}const pq=new URLSearchParams({provider_order_id:`eq.${razorpay_order_id}`});await db(`payments?${pq}`,{method:'PATCH',body:JSON.stringify({provider_payment_id:payment.id,status:'captured',updated_at:new Date().toISOString()})}).catch(e=>console.error('Payment ledger update failed',e.message));res.json({success:true,verified:true,payment_id:payment.id,order_id:ro.id,tracking_code:o.tracking_code});}catch(e){console.error('Payment verification failed',e.message);res.status(500).json({success:false,verified:false,message:'Could not verify payment. Contact ROYAL STEEL with the Payment ID.'});}});
module.exports = app;
