import { createSocket } from 'node:dgram';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { udpPacketOptions } from '../../shared/udp-probe.ts';

export const networkProbeCapabilities = ['probe_udp', ...(
  process.platform === 'win32' || (process.env.PATH ?? '').split(delimiter).some(directory => existsSync(join(directory, 'ping'))) ? ['probe_icmp'] : [])];

function udp(job, signal) {
  const packet = udpPacketOptions(job.options ?? {});
  if (!packet) throw new Error('invalid UDP packet options');
  const url = new URL(`udp://${job.target.replace(/^udp:\/\//, '')}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      try { socket.close(); } catch {}
      error ? reject(error) : resolve({ status: 1, status_code: 0, message: '' });
    };
    const abort = () => finish(new Error('UDP probe aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', finish);
    socket.once('message', message => finish(packet.expected.length && !message.includes(Buffer.from(packet.expected)) ? new Error('UDP response did not match') : null));
    socket.connect(Number(url.port), host, () => socket.send(packet.payload, error => { if (error) finish(error); }));
  });
}

async function icmp(job, signal) {
  const target = job.target.replace(/^\[|\]$/g, '');
  const windows = process.platform === 'win32';
  const program = windows ? 'powershell.exe' : 'ping';
  const args = windows ? ['-NoLogo','-NoProfile','-NonInteractive','-Command',
    '$p=[System.Net.NetworkInformation.Ping]::new();try{$r=$p.Send($env:UPTIME_PROBE_HOST,[int]$env:UPTIME_PROBE_TIMEOUT);@{ok=($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success);latency_ms=$r.RoundtripTime}|ConvertTo-Json -Compress}finally{$p.Dispose()}']
    : ['-n','-c','1','-W',String(process.platform === 'darwin' ? job.timeout_ms : Math.max(1,Math.ceil(job.timeout_ms/1000))),'--',target];
  const stdout = await new Promise((resolve,reject) => execFile(program,args,{ signal,windowsHide:true,maxBuffer:65536,
    env:{...process.env,UPTIME_PROBE_HOST:target,UPTIME_PROBE_TIMEOUT:String(job.timeout_ms)} },(error,stdout)=>error?reject(error):resolve(stdout)));
  if (windows) {
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error('ICMP did not receive an echo reply');
    return { status:1,status_code:0,message:'',latency_ms:Number(result.latency_ms) };
  }
  return {status:1,status_code:0,message:''};
}

export const networkProbe = (job,signal) => job.type === 'udp' ? udp(job,signal) : icmp(job,signal);
