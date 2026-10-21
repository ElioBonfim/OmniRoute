import { bootstrapEnv } from '../../scripts/build/bootstrap-env.mjs';
Object.assign(process.env,bootstrapEnv());
console.log('PHASE','bootstrap');
const {decrypt}=await import('../../src/lib/db/encryption.ts');const {default:Database}=await import('better-sqlite3');
console.log('PHASE','db import');
const {executeChatGptWebCleanRoom}=await import('../../open-sse/utils/chatgptWebExecutorAdapter.ts');
console.log('PHASE','adapter import');
const {chromium}=await import('playwright');
const db=new Database('/Users/primage/.omniroute/storage.sqlite',{readonly:true});const row=db.prepare('SELECT id,api_key,provider_specific_data FROM provider_connections WHERE id=?').get('e8c679d0-ed29-4a7f-97f8-040d4973c9cc');db.close();const c={id:row.id,apiKey:decrypt(row.api_key,{quiet:true}),providerSpecificData:JSON.parse(row.provider_specific_data||'{}')};
console.log('PHASE','connection');c.connectionId=c.id;let browser;
try {await executeChatGptWebCleanRoom({model:'gpt-5-6',body:{model:'gpt-5-6',messages:[{role:'user',content:'probe'}]},credentials:c,signal:new AbortController().signal}, {createSession:async input=>{
 browser=await chromium.launch({headless:false,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({storageState:input.storageState});const page=await context.newPage();
 await page.goto('https://chatgpt.com/?temporary-chat=true',{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(5000);
 console.log('PAGE',JSON.stringify({url:page.url(),title:await page.title(),composer:await page.locator('#prompt-textarea').count(),login:await page.getByTestId('login-button').count()}));
 const assets=await page.evaluate(()=>Array.from(new Set([...performance.getEntriesByType('resource').map(x=>x.name),...Array.from(document.querySelectorAll('link[rel="modulepreload"]'),x=>x.href)])).filter(x=>x.endsWith('.js')&&x.startsWith('https://chatgpt.com/')));
 console.log('ASSETS',JSON.stringify(assets));
 const fs=await import('node:fs/promises');await fs.mkdir('/Users/primage/.omniroute/operator/cleanroom-repair-20261020/assets',{recursive:true});
 for(const asset of assets){const r=await context.request.get(asset);const t=await r.text();await fs.writeFile('/Users/primage/.omniroute/operator/cleanroom-repair-20261020/assets/'+new URL(asset).pathname.split('/').at(-1),t);}
 return {url:()=>page.url(),start:async()=>async()=>{},submitPrompt:async()=>{throw new Error('diagnostic completed')}};
 }});}catch(e){console.log('RESULT',e.message);}finally{await browser?.close();process.exit(0);}
