import { WebSocket } from "ws";

const CDP = process.env.CDP_URL;
const ws = new WebSocket(CDP);
let id = 0;
const pending = new Map();
ws.on("message", (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable"); await send("Runtime.enable");

// Collect console errors — the fastest way to find out if React threw.
const logs = [];
ws.on("message", (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.method === "Runtime.consoleAPICalled" && ["error","warning"].includes(msg.params.type))
    logs.push(msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0,200));
  if (msg.method === "Runtime.exceptionThrown")
    logs.push("EXCEPTION: " + (msg.params.exceptionDetails?.exception?.description ?? "").slice(0,300));
});

await send("Page.navigate", { url: "http://localhost:8090" });
await wait(2500);
await evalJs(`sessionStorage.setItem('nook.token', ${JSON.stringify(process.env.TOKEN)})`);
await send("Page.navigate", { url: "http://localhost:8090" });
await wait(3000);

console.log("after login, sidebar present:", await evalJs(`!!document.querySelector('aside')`));
await evalJs(`[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('New workspace'))?.click()`);
await wait(1500);
await evalJs(`[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('New page'))?.click()`);
await wait(3000);

console.log("status text:", await evalJs(`document.querySelector('.status')?.textContent`));
console.log("ProseMirror exists:", await evalJs(`!!document.querySelector('.ProseMirror')`));
console.log("ProseMirror box:", await evalJs(`(()=>{const e=document.querySelector('.ProseMirror'); if(!e) return null; const r=e.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)};})()`));
console.log("contenteditable:", await evalJs(`document.querySelector('.ProseMirror')?.getAttribute('contenteditable')`));
console.log(".editor box:", await evalJs(`(()=>{const e=document.querySelector('.editor'); if(!e) return null; const r=e.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height)};})()`));
console.log("innerHTML:", JSON.stringify(await evalJs(`document.querySelector('.ProseMirror')?.innerHTML`)));

// What is actually under the cursor when a user clicks in the middle of the blank area?
console.log("element at centre of editor area:", await evalJs(`(()=>{const e=document.querySelector('.editor'); if(!e) return null; const r=e.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return el? el.className||el.tagName : 'none';})()`));

// Focus it directly and type — does the CRDT receive it?
const box = await evalJs(`(()=>{const e=document.querySelector('.editor'); const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
await wait(400);
console.log("focused el:", await evalJs(`document.activeElement?.className || document.activeElement?.tagName`));
for (const ch of "hello") { await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }); await wait(40); }
await wait(1200);
console.log("after clicking centre and typing, innerHTML:", JSON.stringify(await evalJs(`document.querySelector('.ProseMirror')?.innerHTML`)));
console.log("console errors:", logs.slice(0,6));
process.exit(0);
