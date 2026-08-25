import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export type ControlCenterSnapshot = {
  selectedId: number | null;
  spaces: Array<{
    id: number;
    name: string;
    ownership: string;
    createdBy: string;
    tabCount: number;
    createdAt: number;
    touchedAt: number;
    recentTabTitles?: string[];
  }>;
  events: Array<{
    id: string;
    at: number;
    spaceId: number | null;
    type: string;
    detail?: string;
  }>;
};

export type ControlCenterActions = {
  snapshot(): Promise<ControlCenterSnapshot> | ControlCenterSnapshot;
  select(id: number): Promise<unknown>;
  present(id: number): Promise<unknown>;
  close(id: number): Promise<unknown>;
};

export type ControlCenter = {
  url: string;
  close(): Promise<void>;
};

function write(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  write(
    response,
    status,
    JSON.stringify(payload),
    "application/json; charset=utf-8",
  );
}

function dashboardHtml(token: string): string {
  const encodedToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ego Lite Task Spaces</title>
  <style>
    :root{color-scheme:dark;font:15px system-ui,sans-serif;background:#0b1220;color:#e5e7eb}
    body{margin:0;padding:28px;max-width:1180px;margin-inline:auto}
    header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}
    h1{margin:0;font-size:28px} .muted{color:#94a3b8} #summary{font-weight:650}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
    article{border:1px solid #273449;border-radius:14px;padding:16px;background:#111b2e;box-shadow:0 12px 40px #0004}
    article.selected{border-color:#38bdf8}.row{display:flex;justify-content:space-between;gap:12px}.name{font-weight:750;overflow-wrap:anywhere}
    .badge{padding:3px 8px;border-radius:999px;background:#24334d;font-size:12px}.meta{margin:10px 0;color:#a8b4c7;font-size:13px}
    button{border:1px solid #3b4c68;background:#17243a;color:#e5e7eb;border-radius:9px;padding:7px 10px;cursor:pointer}
    button:hover{background:#233551}.danger{border-color:#7f1d1d;color:#fecaca}.actions{display:flex;gap:8px;flex-wrap:wrap}
    details{margin-top:24px;border-top:1px solid #273449;padding-top:16px}li{margin:6px 0;color:#a8b4c7}
    .empty{padding:32px;border:1px dashed #334155;border-radius:14px;color:#94a3b8}
  </style>
</head>
<body>
  <header><div><h1>Ego Lite Task Spaces</h1><div class="muted">One runtime · explicit handoff · automatic cleanup</div></div><div id="summary">Loading…</div></header>
  <main id="spaces" class="grid"></main>
  <details><summary>Recent lifecycle events</summary><ol id="events"></ol></details>
  <script>
    const token=${encodedToken};
    const esc=(value)=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const age=(at)=>{const s=Math.max(0,Math.round((Date.now()-at)/1000));return s<60?s+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h'};
    async function api(path,method='GET'){const response=await fetch(path+'?token='+encodeURIComponent(token),{method});const body=await response.json();if(!response.ok)throw new Error(body.error||'request failed');return body}
    async function act(id,action){await api('/api/spaces/'+id+'/'+action,'POST');await refresh()}
    async function refresh(){
      try{
        const state=await api('/api/state');
        document.querySelector('#summary').textContent=state.spaces.length+' spaces';
        document.querySelector('#spaces').innerHTML=state.spaces.length?state.spaces.map(space=>
          '<article class="'+(space.id===state.selectedId?'selected':'')+'"><div class="row"><span class="name">'+esc(space.name)+'</span><span class="badge">'+esc(space.ownership)+'</span></div><div class="meta">#'+space.id+' · '+space.tabCount+' tabs · active '+age(space.touchedAt)+'</div><div class="muted meta">'+esc((space.recentTabTitles||[]).join(' · ')||'No page title yet')+'</div><div class="actions"><button onclick="act('+space.id+',\'select\')">Resume</button><button onclick="act('+space.id+',\'present\')">Open</button>'+(space.id===1?'':'<button class="danger" onclick="act('+space.id+',\'close\')">Close</button>')+'</div></article>'
        ).join(''):'<div class="empty">No task spaces.</div>';
        document.querySelector('#events').innerHTML=state.events.slice().reverse().slice(0,40).map(event=>'<li>'+new Date(event.at).toLocaleTimeString()+' · '+esc(event.type)+(event.detail?' · '+esc(event.detail):'')+'</li>').join('');
      }catch(error){document.querySelector('#summary').textContent=error.message}
    }
    refresh();setInterval(refresh,2000);
  </script>
</body>
</html>`;
}

/** Start the loopback-only Task Space Control Center. */
export async function startControlCenter(
  actions: ControlCenterActions,
  options: { host?: string; port?: number; token?: string } = {},
): Promise<ControlCenter> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomUUID();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${host}`);
        if (url.searchParams.get("token") !== token) {
          writeJson(response, 403, { ok: false, error: "invalid control token" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/") {
          write(response, 200, dashboardHtml(token), "text/html; charset=utf-8");
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
          writeJson(response, 200, await actions.snapshot());
          return;
        }
        const actionMatch = url.pathname.match(
          /^\/api\/spaces\/(\d+)\/(select|present|close)$/,
        );
        if (request.method === "POST" && actionMatch) {
          const id = Number(actionMatch[1]);
          const action = actionMatch[2] as "select" | "present" | "close";
          writeJson(response, 200, await actions[action](id));
          return;
        }
        writeJson(response, 404, { ok: false, error: "not found" });
      } catch (error) {
        writeJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("control center did not expose a TCP port");
  }
  let closed = false;
  return {
    url: `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
