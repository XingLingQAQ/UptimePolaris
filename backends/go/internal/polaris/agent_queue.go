package polaris

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/http"
	"sort"
	"time"

	"golang.org/x/net/publicsuffix"
)

// 只比较影响探测的配置；结果领取和提交均据此拒绝过期任务。
// Compare probe-relevant settings; both leasing and result submission use them to reject obsolete jobs.
func sourceVersion(m Object) string {
	return encode(project(m, []string{"type", "target", "method", "expected_status", "keyword", "timeout_ms", "interval_sec", "options_json", "check_ssl", "check_domain", "check_dns", "warn_days"}))
}
func (a *App) scheduleAgentProbe(ctx context.Context, m Object) error {
	_, agentID := checkSource(m)
	if agentID == "" {
		return nil
	}
	now := time.Now().Unix()
	owner := token(12)
	claimed, e := a.store.claim(ctx, "monitor:"+str(m, "id"), owner, now, 20, false)
	if e != nil || !claimed {
		return e
	}
	defer a.store.release(context.Background(), "monitor:"+str(m, "id"), owner, now+1)
	jobs, e := a.store.queueDocuments(ctx, a.store.db, "probe_job", "monitor_id", str(m, "id"), true, sourceVersion(m), 128)
	if e != nil {
		return e
	}
	sort.Slice(jobs, func(i, j int) bool { return integer(jobs[i], "observed_at") > integer(jobs[j], "observed_at") })
	if err := a.completeProbeJobs(ctx, m, jobs, agentID, now); err != nil {
		return err
	}
	agent, e := a.store.get(ctx, "agent", agentID)
	if e != nil {
		return e
	}
	live, e := a.store.get(ctx, "machine", agentID)
	if e != nil {
		return e
	}
	online := agentOnline(live, now)
	if agent == nil || !boolean(agent["active"]) || !boolean(agent["probe_enabled"]) || online == nil || !*online {
		return nil
	}
	scheduled := now / integer(m, "interval_sec") * integer(m, "interval_sec")
	runID := fmt.Sprintf("%s:%d", str(m, "id"), scheduled)
	return a.store.mutate(ctx, func(t *transaction) error {
		existing, e := t.get("probe_job", runID)
		if e != nil || existing != nil {
			return e
		}
		job := clone(m)
		job["run_id"] = runID
		job["monitor_id"] = m["id"]
		job["monitor_name"] = m["name"]
		job["agent_id"] = agentID
		job["probe_type"] = m["type"]
		job["scheduled_at"] = scheduled
		job["source_version"] = sourceVersion(m)
		job["state"] = "pending"
		job["attempts"] = 0
		job["consumed"] = false
		return t.put("probe_job", runID, job)
	})
}

// 消费最新结果后标记已读，旧观测不再覆盖现态。
// Mark results consumed after persistence; older observations must not overwrite live state.
func (a *App) completeProbeJobs(ctx context.Context, m Object, jobs []Object, agentID string, now int64) error {
	for _, job := range jobs {
		if !(str(job, "monitor_id") == str(m, "id") && str(job, "state") == "completed" && !boolean(job["consumed"]) && str(job, "source_version") == sourceVersion(m)) {
			continue
		}
		live, _ := a.store.get(ctx, "live", str(m, "id"))
		if integer(live, "source_observed_at") < integer(job, "observed_at") {
			addons := object(job["addons"])
			if addons == nil {
				addons = Object{}
			}
			if boolean(m["check_ssl"]) && addons["ssl"] == nil {
				if cached := cachedAgentSSL(m, live, agentID, now); cached != nil {
					addons["ssl"] = cached
				}
			}
			m["_source_observed_at"] = job["observed_at"]
			_, e := a.persistCheck(ctx, m, CheckResult{Status: int(integer(job, "status")), LatencyMs: number(job["latency_ms"]), StatusCode: int(integer(job, "status_code")), Message: str(job, "message")}, addons, false)
			if e != nil {
				return e
			}
		}
		job["consumed"] = true
		if e := a.store.put(ctx, "probe_job", str(job, "run_id"), job); e != nil {
			return e
		}
	}
	return nil
}

func cachedAgentSSL(m, live Object, agentID string, now int64) Object {
	previous := object(live["ssl"])
	if str(previous, "checkKey") != sslCacheKey(m, "agent:"+agentID, now) {
		return nil
	}
	cached := clone(previous)
	cached["st"] = 2
	if cached["days"] != nil && boolean(cached["tls_valid"]) && number(cached["days"]) > number(m["warn_days"]) {
		cached["st"] = 1
	}
	return cached
}

func (a *App) addonRequest(ctx context.Context, m Object) Object {
	host, _ := targetHost(m)
	authority := sslAuthority(m)
	if host == "" || net.ParseIP(host) != nil {
		return Object{}
	}
	addons := Object{}
	now := time.Now().Unix()
	if boolean(m["check_ssl"]) {
		previous, _ := a.store.get(ctx, "live", str(m, "id"))
		ssl := object(previous["ssl"])
		_, agentID := checkSource(m)
		if ssl == nil || str(ssl, "checkKey") != sslCacheKey(m, "agent:"+agentID, now) {
			_, port, _ := net.SplitHostPort(authority)
			addons["ssl"] = Object{"host": host, "port": numberString(port, 443), "warn_days": m["warn_days"]}
		}
	}
	if boolean(m["check_domain"]) {
		domain, _ := publicsuffix.EffectiveTLDPlusOne(host)
		addons["domain"] = Object{"domain": domain, "warn_days": m["warn_days"]}
	}
	if boolean(m["check_dns"]) {
		dns := object(options(m)["dns"])
		addons["dns"] = Object{"hostname": host, "record_type": fallback(dns, "recordType", "A"), "resolver": fallback(dns, "resolver", "https://cloudflare-dns.com/dns-query"), "expected": fallback(dns, "expected", "")}
	}
	return addons
}
func numberString(v string, def int) int {
	n := 0
	if _, e := fmt.Sscan(v, &n); e != nil {
		return def
	}
	return n
}

func (a *App) agentPoll(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	if e != nil {
		return e
	}
	now := time.Now().Unix()
	jobs, commands := []Object{}, []Object{}
	settings, e := a.settings(r.Context())
	if e != nil {
		return e
	}
	enabledCommands := boolean(settings["security.allowAgentCommands"])
	// 事务前读取附加检查缓存，事务内重新验证 Agent 和监控配置。
	// Read add-on caches first; revalidate Agent and monitor configuration in the transaction.
	requests := map[string]Object{}
	allJobs, e := a.store.queueDocuments(r.Context(), a.store.db, "probe_job", "agent_id", str(agent, "id"), false, "", 128)
	if e != nil {
		return e
	}
	for _, job := range allJobs {
		if str(job, "agent_id") == str(agent, "id") {
			requests[str(job, "run_id")] = a.addonRequest(r.Context(), job)
		}
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		current, e := t.get("agent", str(agent, "id"))
		if e != nil {
			return e
		}
		if current == nil || !boolean(current["active"]) {
			return nil
		}
		for _, kind := range []string{"probe_job", "command"} {
			if kind == "probe_job" && !boolean(current["probe_enabled"]) || kind == "command" && !enabledCommands {
				continue
			}
			leased, err := a.leaseAgentQueue(r.Context(), t, str(agent, "id"), kind, requests, now)
			if err != nil {
				return err
			}
			if kind == "command" {
				commands = leased
			} else {
				jobs = leased
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"jobs": jobs, "commands": commands})
	return nil
}

// 重试次数仅在发放租约时增加；有效租约到期前不受后续轮询影响。
// Increment attempts only when leasing; later polls cannot invalidate an unexpired lease.
func (a *App) leaseAgentQueue(ctx context.Context, t *transaction, agentID, kind string, requests map[string]Object, now int64) ([]Object, error) {
	leased := []Object{}
	rows, e := a.store.queueDocuments(ctx, t.tx, kind, "agent_id", agentID, false, "", 128)
	if e != nil {
		return nil, e
	}
	sort.Slice(rows, func(i, j int) bool { return integer(rows[i], "scheduled_at") < integer(rows[j], "scheduled_at") })
	count := 0
	for _, row := range rows {
		if str(row, "agent_id") != agentID || contains([]string{"completed", "expired"}, str(row, "state")) {
			continue
		}
		id := str(row, "run_id")
		ttl := integer(row, "interval_sec") + 120
		scheduled := integer(row, "scheduled_at")
		maxPoll := 8
		if kind == "command" {
			id = str(row, "id")
			scheduled = integer(row, "queued_at")
			ttl = 900
			maxPoll = 4
		}
		if str(row, "state") == "leased" && integer(row, "lease_until") > now {
			continue
		}
		if scheduled+ttl < now || integer(row, "attempts") >= 3 {
			row["state"] = "expired"
			if e = t.put(kind, id, row); e != nil {
				return nil, e
			}
			continue
		}
		if count >= maxPoll {
			continue
		}
		if kind == "probe_job" {
			if _, ok := requests[id]; !ok {
				continue
			}
			monitor, e := t.get("monitor", str(row, "monitor_id"))
			if e != nil {
				return nil, e
			}
			if monitor == nil || !boolean(monitor["active"]) || sourceVersion(monitor) != str(row, "source_version") {
				row["state"] = "expired"
				if e = t.put(kind, id, row); e != nil {
					return nil, e
				}
				continue
			}
		}
		lease := token(32)
		until := now + 120
		if kind == "probe_job" {
			until = now + integer(row, "timeout_ms")/1000 + 120
		}
		row["state"] = "leased"
		row["lease_token"] = lease
		row["lease_until"] = until
		row["attempts"] = integer(row, "attempts") + 1
		if kind == "command" {
			leased = append(leased, Object{"id": id, "action": row["action"], "lease_token": lease, "lease_expires_at": until})
		} else {
			o := options(row)
			delete(o, "check_source")
			addons := requests[id]
			if addons == nil {
				addons = Object{}
			}
			row["requested_addons"] = addons
			leased = append(leased, Object{"run_id": id, "monitor_id": row["monitor_id"], "target": row["target"], "type": row["probe_type"], "method": row["method"], "options": o, "expected_status": row["expected_status"], "keyword": row["keyword"], "timeout_ms": row["timeout_ms"], "lease_expires_at": until * 1000, "lease_token": lease, "addons": addons})
		}
		if e = t.put(kind, id, row); e != nil {
			return nil, e
		}
		count++
	}
	return leased, nil
}

func (a *App) agentProbeResult(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	if e != nil {
		return e
	}
	b, e := body(r)
	if e != nil {
		return failure("invalid", 400)
	}
	if str(b, "run_id") == "" || str(b, "lease_token") == "" || !validNumber(b["status"]) || !contains([]string{"0", "1", "2"}, fmt.Sprint(b["status"])) || !validNumber(b["latency_ms"]) || number(b["latency_ms"]) < 0 || number(b["latency_ms"]) > 3600000 || !validNumber(b["observed_at"]) || number(b["observed_at"]) != math.Trunc(number(b["observed_at"])) || !validNumber(b["status_code"]) || number(b["status_code"]) < 0 || number(b["status_code"]) > 999 || len(str(b, "message")) > 512 {
		return failure("invalid", 400)
	}
	now := time.Now().Unix()
	duplicate := false
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		currentAgent, e := t.get("agent", str(agent, "id"))
		if e != nil {
			return e
		}
		if currentAgent == nil || !boolean(currentAgent["active"]) || !boolean(currentAgent["probe_enabled"]) {
			return failure("stale", 409)
		}
		job, e := t.get("probe_job", str(b, "run_id"))
		if e != nil {
			return e
		}
		if job == nil || str(job, "agent_id") != str(agent, "id") {
			return failure("not_found", 404)
		}
		// 同一租约的重复回执只确认，不覆盖已保存的结果。
		// A duplicate receipt for the same lease is acknowledged without overwriting the saved result.
		if str(job, "state") == "completed" && constantEqual(str(job, "lease_token"), str(b, "lease_token")) {
			duplicate = true
			return nil
		}
		if !boolean(agent["active"]) || !boolean(agent["probe_enabled"]) || str(job, "state") != "leased" || !constantEqual(str(job, "lease_token"), str(b, "lease_token")) || integer(job, "lease_until") < now {
			return failure("stale", 409)
		}
		m, e := t.get("monitor", str(job, "monitor_id"))
		if e != nil {
			return e
		}
		if m == nil || !boolean(m["active"]) || sourceVersion(m) != str(job, "source_version") {
			return failure("stale", 409)
		}
		observed := integer(b, "observed_at")
		if observed < integer(job, "scheduled_at")-30 || observed > now+15 || observed < now-integer(job, "timeout_ms")/1000-120 {
			return failure("invalid", 400)
		}
		requested := object(job["requested_addons"])
		incoming := object(b["addons"])
		addons := Object{}
		for kind := range incoming {
			if requested[kind] == nil {
				return failure("invalid", 400)
			}
		}
		for kind := range requested {
			v := object(incoming[kind])
			if v == nil || integer(v, "status") != 1 && integer(v, "status") != 2 || len(str(v, "message")) > 512 || integer(v, "observed_at") < integer(job, "scheduled_at")-30 || integer(v, "observed_at") > now+15 {
				return failure("invalid", 400)
			}
			reading := Object{"st": v["status"], "msg": v["message"], "ts": v["observed_at"]}
			if kind == "dns" {
				if len(array(v["records"])) > 64 {
					return failure("invalid", 400)
				}
				reading["records"] = v["records"]
				reading["hostname"] = object(requested[kind])["hostname"]
				reading["recordType"] = object(requested[kind])["record_type"]
			} else {
				if v["days_left"] != nil && (!validNumber(v["days_left"]) || math.Abs(number(v["days_left"])) > 365000) {
					return failure("invalid", 400)
				}
				reading["days"] = v["days_left"]
				if v["days_left"] == nil || number(v["days_left"]) <= number(m["warn_days"]) {
					reading["st"] = 2
				}
				if kind == "ssl" {
					reading["checkKey"] = sslCacheKey(m, "agent:"+str(agent, "id"), integer(v, "observed_at"))
					if _, ok := v["tls_valid"].(bool); !ok {
						return failure("invalid", 400)
					}
					reading["tls_valid"] = v["tls_valid"]
					if !boolean(v["tls_valid"]) {
						reading["st"] = 2
					}
				}
			}
			addons[kind] = reading
		}
		job["state"] = "completed"
		job["completed_at"] = now
		job["observed_at"] = b["observed_at"]
		job["status"] = b["status"]
		job["status_code"] = b["status_code"]
		job["latency_ms"] = b["latency_ms"]
		job["message"] = b["message"]
		job["addons"] = addons
		return t.put("probe_job", str(job, "run_id"), job)
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "duplicate": duplicate})
	return nil
}

func (a *App) enqueueCommand(ctx context.Context, id, action string) (string, error) {
	if !contains([]string{"upgrade", "restart", "re_report", "check_update"}, action) {
		return "", failure("unknown_action", 400)
	}
	settings, e := a.settings(ctx)
	if e != nil {
		return "", e
	}
	if !boolean(settings["security.allowAgentCommands"]) {
		return "", failure("commands_disabled", 403)
	}
	agent, e := a.store.get(ctx, "agent", id)
	if e != nil {
		return "", e
	}
	if agent == nil || !boolean(agent["active"]) {
		return "", failure("agent_not_found", 404)
	}
	live, e := a.store.get(ctx, "machine", id)
	if e != nil {
		return "", e
	}
	if !contains(stringsOf(live["capabilities"]), "commands") {
		return "", failure("agent_unsupported", 409)
	}
	online := agentOnline(live, time.Now().Unix())
	if online == nil || !*online {
		return "", failure("agent_offline", 409)
	}
	commandID := uuid()
	row := Object{"id": commandID, "agent_id": id, "action": action, "queued_at": time.Now().Unix(), "state": "pending", "attempts": 0, "ok": nil, "message": nil, "completed_at": nil, "issued_by": nil}
	return commandID, a.store.put(ctx, "command", commandID, row)
}
func (a *App) issueCommand(w http.ResponseWriter, r *http.Request) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	id, e := a.enqueueCommand(r.Context(), r.PathValue("id"), str(b, "action"))
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "id": id})
	return nil
}
func (a *App) batchCommands(w http.ResponseWriter, r *http.Request) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	ids := stringsOf(b["ids"])
	if len(ids) < 1 || len(ids) > 500 {
		return failure("invalid_request", 400)
	}
	results := []Object{}
	for _, id := range ids {
		_, e := a.enqueueCommand(r.Context(), id, str(b, "action"))
		row := Object{"id": id, "ok": e == nil}
		if e != nil {
			row["error"] = e.Error()
		}
		results = append(results, row)
	}
	respond(w, 200, Object{"results": results})
	return nil
}
func (a *App) listCommands(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.store.list(r.Context(), "command")
	if e != nil {
		return e
	}
	commands := []Object{}
	for _, row := range rows {
		if str(row, "agent_id") == r.PathValue("id") {
			commands = append(commands, project(row, []string{"id", "agent_id", "action", "queued_at", "state", "attempts", "ok", "message", "completed_at", "issued_by"}))
		}
	}
	sort.Slice(commands, func(i, j int) bool { return integer(commands[i], "queued_at") > integer(commands[j], "queued_at") })
	if limit := queryLimit(r, 20, 100); len(commands) > limit {
		commands = commands[:limit]
	}
	settings, e := a.settings(r.Context())
	if e != nil {
		return e
	}
	respond(w, 200, Object{"commands": commands, "enabled": settings["security.allowAgentCommands"], "capability": "commands"})
	return nil
}
func (a *App) agentCommandResult(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	if e != nil {
		return e
	}
	b, e := body(r)
	if e != nil {
		return failure("invalid", 400)
	}
	if str(b, "id") == "" || str(b, "lease_token") == "" {
		return failure("invalid", 400)
	}
	if _, ok := b["ok"].(bool); !ok {
		return failure("invalid", 400)
	}
	duplicate := false
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		row, e := t.get("command", str(b, "id"))
		if e != nil {
			return e
		}
		if row == nil || str(row, "agent_id") != str(agent, "id") {
			return failure("not_found", 404)
		}
		if str(row, "state") == "completed" && constantEqual(str(row, "lease_token"), str(b, "lease_token")) {
			duplicate = true
			return nil
		}
		if str(row, "state") != "leased" || !constantEqual(str(row, "lease_token"), str(b, "lease_token")) || integer(row, "lease_until") < time.Now().Unix() {
			return failure("stale", 409)
		}
		row["ok"] = 0
		if boolean(b["ok"]) {
			row["ok"] = 1
		}
		row["message"] = str(b, "message")
		row["state"] = "completed"
		row["completed_at"] = time.Now().Unix()
		return t.put("command", str(row, "id"), row)
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "duplicate": duplicate})
	return nil
}

func (a *App) publicServers(w http.ResponseWriter, r *http.Request) error {
	kind, enabled, configured, page, e := a.pageContext(r)
	if e != nil {
		return e
	}
	if kind != "agent" || !enabled || !configured {
		return failure("not_found", 404)
	}
	agents, e := a.store.list(r.Context(), "agent")
	if e != nil {
		return e
	}
	servers := []Object{}
	for _, agent := range agents {
		if !boolean(agent["active"]) || !boolean(agent["is_public"]) {
			continue
		}
		live, e := a.store.get(r.Context(), "machine", str(agent, "id"))
		if e != nil {
			return e
		}
		row := Object{"id": agent["id"], "name": agent["name"], "online": agentOnline(live, time.Now().Unix()), "reportedAt": live["reported_at"], "group": nil, "tags": a.tags(r.Context(), "agent_tag", stringsOf(agent["tag_ids"]))}
		if publicPageCountry(page) {
			country := publicCountry(live["region"])
			if country != nil {
				row["region"] = country
			}
		}
		if group, _ := a.store.get(r.Context(), "agent_group", str(agent, "group_id")); group != nil {
			row["group"] = Object{"id": group["id"], "name": group["name"]}
		}
		for dest, source := range map[string]string{"os": "os", "arch": "arch", "cpu": "cpu_usage", "memoryUsed": "mem_used", "memoryTotal": "mem_total", "diskUsed": "disk_used", "diskTotal": "disk_total", "load": "load_1", "upload": "net_up_rate", "download": "net_down_rate", "sent": "net_up_total", "received": "net_down_total", "uptime": "uptime"} {
			row[dest] = live[source]
		}
		servers = append(servers, row)
	}
	if id := r.PathValue("id"); id != "" {
		for _, server := range servers {
			if str(server, "id") == id {
				history, e := a.machineHistory(r.Context(), id)
				if e != nil {
					return e
				}
				for _, point := range history {
					point["memory"] = point["mem_pct"]
					point["upload"] = point["net_up"]
					point["download"] = point["net_down"]
					delete(point, "mem_pct")
					delete(point, "net_up")
					delete(point, "net_down")
				}
				respond(w, 200, Object{"server": server, "history": history, "now": time.Now().Unix()})
				return nil
			}
		}
		return failure("not_found", 404)
	}
	respond(w, 200, Object{"servers": servers, "now": time.Now().Unix()})
	return nil
}

func (a *App) publicAgentDetail(w http.ResponseWriter, r *http.Request) error {
	monitors, e := a.pageMonitors(r)
	if e != nil {
		return e
	}
	num := int64(numberString(r.PathValue("num"), 0))
	for _, m := range monitors {
		if integer(m, "num_id") != num || str(m, "type") != "agent" {
			continue
		}
		live, e := a.store.get(r.Context(), "machine", str(m, "agent_id"))
		if e != nil {
			return e
		}
		safe := project(live, []string{"os", "arch", "kernel", "cpu_model", "cpu_cores", "version", "virtualization", "transport", "report_interval_secs", "cpu_usage", "mem_used", "mem_total", "swap_used", "swap_total", "load_1", "load_5", "load_15", "disk_used", "disk_total", "net_up_rate", "net_down_rate", "net_up_total", "net_down_total", "connections_tcp", "connections_udp", "process_count", "uptime", "reported_at", "updated_at"})
		history, e := a.store.list(r.Context(), "machine_history")
		if e != nil {
			return e
		}
		minutes := numberString(r.URL.Query().Get("minutes"), 60)
		minutes = min(1440, max(1, minutes))
		buckets := []Object{}
		for _, bucket := range history {
			if str(bucket, "agent_id") == str(m, "agent_id") && integer(bucket, "bucket_ts") >= time.Now().Unix()-int64(minutes)*60 {
				row := clone(bucket)
				delete(row, "agent_id")
				delete(row, "id")
				buckets = append(buckets, row)
			}
		}
		sort.Slice(buckets, func(i, j int) bool { return integer(buckets[i], "bucket_ts") < integer(buckets[j], "bucket_ts") })
		points, e := a.readings(r.Context(), str(m, "id"), time.Now().Unix()-86400, 50000)
		if e != nil {
			return e
		}
		recent := points
		if len(recent) > 120 {
			recent = recent[len(recent)-120:]
		}
		interval := integer(live, "report_interval_secs")
		if interval <= 0 {
			interval = 60
		}
		stale := min(3600, max(30, interval*3))
		var publicLive any = safe
		if live == nil {
			publicLive = nil
		}
		respond(w, 200, Object{"now": time.Now().Unix(), "monitor": Object{"id": m["id"], "num_id": m["num_id"], "name": m["name"], "type": "agent", "active": m["active"]}, "live": publicLive, "buckets": buckets, "online": agentOnline(live, time.Now().Unix()), "staleAfterSec": stale, "availability": a.history(r.Context(), str(m, "id"), points), "ring": ringOf(recent, true, "agent")})
		return nil
	}
	return failure("not_found", 404)
}
