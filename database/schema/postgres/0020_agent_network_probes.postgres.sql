-- Native network protocols run on a capable Agent.
-- 原生网络协议由具备相应能力的 Agent 执行。
ALTER TABLE monitors DROP CONSTRAINT monitors_type_check;
ALTER TABLE monitors ADD CONSTRAINT monitors_type_check CHECK (type IN ('http','tcp','udp','icmp','push','agent'));
ALTER TABLE agent_probe_jobs DROP CONSTRAINT agent_probe_jobs_probe_type_check;
ALTER TABLE agent_probe_jobs ADD CONSTRAINT agent_probe_jobs_probe_type_check CHECK (probe_type IN ('http','tcp','udp','icmp'));
