export const loginPage = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Herdr Office · Sign in</title><link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#14151f;--panel:#1d1f2e;--ink:#e9ecff;--dim:#8b90b8;--accent:#ffd166;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:14px/1.4 ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;
background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:24px 24px}
form{width:min(340px,calc(100vw - 32px));background:var(--panel);border:2px solid #3a3d5c;padding:24px;box-shadow:6px 6px 0 #0008}
h1{margin:0 0 4px;font-size:18px;letter-spacing:.12em;color:var(--accent);text-transform:uppercase}
p{margin:0 0 18px;color:var(--dim)}label{display:block;margin-bottom:6px;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
input{width:100%;padding:10px;background:#0f1019;border:2px solid #3a3d5c;color:var(--ink);font:inherit;outline:none}
input:focus{border-color:var(--accent)}button{margin-top:14px;width:100%;padding:10px;background:var(--accent);color:#1b1500;border:0;font:inherit;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
button:hover{filter:brightness(1.1)}.err{color:var(--bad);margin:10px 0 0;min-height:1.2em}
</style></head><body>
<form method="post" action="/login">
<h1>Herdr Office</h1><p>Badge in to enter the building.</p>
<label for="t">Access token</label><input id="t" name="token" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Enter</button><div class="err">${error}</div>
</form></body></html>`;
