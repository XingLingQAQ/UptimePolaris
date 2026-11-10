export const MAINTENANCE_STYLE = `
.polaris-maintenance{--maintenance-bg:#fafbfc;--maintenance-ink:#18181b;--maintenance-muted:#626773;--maintenance-line:#e5e8ed;min-height:100dvh;background:var(--maintenance-bg);color:var(--maintenance-ink);padding:0 28px;font-family:Geist,Inter,system-ui,sans-serif}
.maintenance-wrap{max-width:1080px;min-height:100dvh;margin:auto;display:flex;flex-direction:column}
.maintenance-header{height:88px;display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--maintenance-line)}
.maintenance-brand{display:inline-flex;align-items:center;gap:12px;font-size:15px;font-weight:600;letter-spacing:-.02em}.maintenance-brand svg{display:block;flex:none}
.maintenance-login{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border:1px solid var(--maintenance-line);border-radius:8px;color:var(--maintenance-muted);text-decoration:none;font-size:14px;line-height:20px;white-space:nowrap}
.maintenance-login:hover{background:var(--maintenance-line);color:var(--maintenance-ink)}.maintenance-login:focus-visible{outline:2px solid #006fee;outline-offset:4px}
.maintenance-content{display:grid;grid-template-columns:minmax(0,640px) 1fr;align-items:center;gap:56px;flex:1;padding:80px 0 112px}
.maintenance-copy{min-width:0}.maintenance-copy h1{font-size:clamp(32px,4vw,52px);font-weight:600;letter-spacing:-.035em;line-height:1.15;overflow-wrap:anywhere;margin:0;text-wrap:balance}
.maintenance-description{font-size:17px;line-height:1.85;color:var(--maintenance-muted);margin:24px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-width:58ch}
.maintenance-end{border-top:1px solid var(--maintenance-line);margin:36px 0 0;padding-top:20px;display:flex;flex-wrap:wrap;gap:8px 12px;color:var(--maintenance-muted);font-size:14px;line-height:1.6}.maintenance-end[hidden]{display:none}.maintenance-end time{color:var(--maintenance-ink);font-weight:500}
.maintenance-visual{display:grid;place-items:center;position:relative;width:240px;height:240px;justify-self:end}.maintenance-visual>.maintenance-orbit{position:absolute;inset:0;width:100%;height:100%;opacity:.10}.maintenance-tool{position:relative;width:64px;height:64px;color:#006fee}
@media(max-width:760px){.polaris-maintenance{padding:0 22px}.maintenance-header{height:72px}.maintenance-content{grid-template-columns:1fr;align-content:center;gap:32px;padding:64px 0 88px}.maintenance-visual{grid-row:1;width:112px;height:112px;justify-self:start}.maintenance-tool{width:32px;height:32px}.maintenance-description{font-size:16px;margin-top:20px}.maintenance-brand{gap:9px}.maintenance-login{padding:7px 10px}}
@media(prefers-color-scheme:dark){:root:not(.light) .polaris-maintenance{--maintenance-bg:#111317;--maintenance-ink:#f1f3f5;--maintenance-muted:#adb4bf;--maintenance-line:#2b3038}:root:not(.light) .maintenance-visual>.maintenance-orbit{opacity:.24}:root:not(.light) .maintenance-tool{color:#67aaff}}
.dark .polaris-maintenance{--maintenance-bg:#111317;--maintenance-ink:#f1f3f5;--maintenance-muted:#adb4bf;--maintenance-line:#2b3038}.dark .maintenance-visual>.maintenance-orbit{opacity:.24}.dark .maintenance-tool{color:#67aaff}
`;
