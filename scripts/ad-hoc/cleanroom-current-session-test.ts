import {bootstrapEnv} from '../../scripts/build/bootstrap-env.mjs';Object.assign(process.env,bootstrapEnv());
const {decrypt}=await import('../../src/lib/db/encryption.ts');const {default:Database}=await import('better-sqlite3');
const {executeChatGptWebCleanRoom}=await import('../../open-sse/utils/chatgptWebExecutorAdapter.ts');
const {PlaywrightChatGptWebBrowserSession}=await import('../../open-sse/utils/chatgptWebBrowserSession.ts');
const {chromium}=await import('playwright');
const db=new Database('/Users/primage/.omniroute/storage.sqlite',{readonly:true});const row=db.prepare('SELECT id,api_key,provider_specific_data FROM provider_connections WHERE provider=? AND is_active=1 ORDER BY updated_at DESC LIMIT 1').get('chatgpt-web');db.close();
const credentials={connectionId:row.id,apiKey:decrypt(row.api_key,{quiet:true}),providerSpecificData:JSON.parse(row.provider_specific_data||'{}')};let browser;
try {
const deps={createSession:async input=>{
 browser=await chromium.launch({headless:false,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({storageState:input.storageState,userAgent:input.userAgent,locale:input.locale,timezoneId:input.timezone});const page=await context.newPage();
 await page.goto('https://chatgpt.com/?temporary-chat=true',{waitUntil:'domcontentloaded'});console.log('PAGE',JSON.stringify({url:page.url(),title:await page.title()}));
 return new PlaywrightChatGptWebBrowserSession(page,{selection:input.selection,closePageOnCleanup:true});
}};
const response=await executeChatGptWebCleanRoom({model:'gpt-5-6',body:{messages:[{role:'user',content:'Responda somente CLEANROOMCONFIG20.'}]},stream:false,credentials,signal:AbortSignal.timeout(45000)},deps);
console.log('HTTP',response.status,'BODY',await response.text());
}catch(error){console.log('LIVE_ERROR',error.message);}finally{await browser?.close();process.exit(0);}
