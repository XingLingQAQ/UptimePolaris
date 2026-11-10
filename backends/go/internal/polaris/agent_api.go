package polaris

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

func agentOnline(live Object, now int64) *bool {
	if live == nil || live["reported_at"] == nil {
		return nil
	}
	interval := integer(live, "report_interval_secs")
	if interval <= 0 {
		interval = 60
	}
	stale := min(3600, max(30, interval*3))
	online := now-integer(live, "reported_at") <= stale
	return &online
}
func (a *App) agentByToken(ctx context.Context, secret string) (Object, error) {
	agents, e := a.store.list(ctx, "agent")
	if e != nil {
		return nil, e
	}
	for _, agent := range agents {
		if constantEqual(str(agent, "token"), secret) {
			return agent, nil
		}
	}
	return nil, failure("invalid token", 401)
}
func (a *App) fleetRow(ctx context.Context, agent Object) Object {
	live, _ := a.store.get(ctx, "machine", str(agent, "id"))
	row := Object{"id": agent["id"], "name": agent["name"], "is_public": agent["is_public"], "active": boolean(agent["active"]), "created_at": agent["created_at"], "group_id": agent["group_id"], "tags": a.tags(ctx, "agent_tag", stringsOf(agent["tag_ids"])), "probe_enabled": boolean(agent["probe_enabled"]), "capabilities": []string{}, "online": agentOnline(live, time.Now().Unix()), "last_reported_at": live["reported_at"], "stale_for_sec": nil, "version_state": "not_reported", "probe_target_count": 0}
	for _, field := range []string{"os", "arch", "kernel", "cpu_model", "cpu_cores", "public_ip", "public_ipv6", "isp", "region", "virtualization", "transport", "version", "report_interval_secs", "cpu_usage", "mem_used", "mem_total", "disk_used", "disk_total", "load_1", "process_count", "connections_tcp", "connections_udp"} {
		row[field] = live[field]
	}
	row["uptime_sec"] = live["uptime"]
	if live["reported_at"] != nil {
		row["stale_for_sec"] = max(0, time.Now().Unix()-integer(live, "reported_at"))
	}
	if live["capabilities"] != nil {
		row["capabilities"] = live["capabilities"]
	}
	if str(live, "version") != "" {
		row["version_state"] = "unknown"
		manifest := cachedAgentManifest()
		if str(manifest, "version") != "" {
			row["version_state"] = "behind"
			if str(manifest, "version") == str(live, "version") {
				row["version_state"] = "current"
			}
		}
	}
	monitors, _ := a.store.list(ctx, "monitor")
	for _, m := range monitors {
		if source, id := checkSource(m); source == "agent" && id == str(agent, "id") {
			row["probe_target_count"] = integer(row, "probe_target_count") + 1
		}
	}
	return row
}

// 管理入口与公开 Agent 协议在此注册，公开上报依赖独立 Agent 凭据。
// Register admin and public Agent routes; public reporting uses the individual Agent credential.
func (a *App) agentRoutes() {
	a.route("GET /api/admin/agents", false, func(w http.ResponseWriter, r *http.Request) error {
		agents, e := a.store.list(r.Context(), "agent")
		if e != nil {
			return e
		}
		refreshAgentRelease()
		rows := []Object{}
		summary := Object{"total": len(agents), "online": 0, "offline": 0, "neverReported": 0, "paused": 0, "behind": 0, "latestVersion": nil}
		if v := str(cachedAgentManifest(), "version"); v != "" {
			summary["latestVersion"] = v
		}
		for _, agent := range agents {
			row := a.fleetRow(r.Context(), agent)
			rows = append(rows, row)
			key := "neverReported"
			if !boolean(row["active"]) {
				key = "paused"
			} else if online, ok := row["online"].(*bool); ok && online != nil {
				if *online {
					key = "online"
				} else {
					key = "offline"
				}
			}
			summary[key] = integer(summary, key) + 1
			if str(row, "version_state") == "behind" {
				summary["behind"] = integer(summary, "behind") + 1
			}
		}
		respond(w, 200, Object{"agents": rows, "summary": summary})
		return nil
	})
	a.route("POST /api/admin/agents", false, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		name := strings.TrimSpace(str(b, "name"))
		if name == "" || len(name) > 200 {
			return failure("invalid_name", 400)
		}
		if _, exists := b["is_public"]; exists {
			if _, ok := b["is_public"].(bool); !ok {
				return failure("visibility_invalid", 400)
			}
		}
		if boolean(b["is_public"]) && !boolean(object(a.presentation(r.Context())["config"])["agentEnabled"]) {
			return failure("agent_page_disabled", 409)
		}
		id, secret := uuid(), token(32)
		public := 0
		if boolean(b["is_public"]) {
			public = 1
		}
		row := Object{"id": id, "token": secret, "name": name, "active": 1, "probe_enabled": fallback(b, "probe_enabled", true), "is_public": public, "group_id": nil, "tag_ids": []string{}, "created_at": time.Now().Unix(), "updated_at": time.Now().Unix()}
		if e = a.store.put(r.Context(), "agent", id, row); e != nil {
			return e
		}
		respond(w, 201, Object{"id": id, "token": secret})
		return nil
	})
	a.route("POST /api/admin/agents/visibility", false, func(w http.ResponseWriter, r *http.Request) error {
		if !boolean(object(a.presentation(r.Context())["config"])["agentEnabled"]) {
			return failure("agent_page_disabled", 409)
		}
		return a.visibility(w, r, "agent")
	})
	for _, action := range []string{"rename", "active", "probe"} {
		action := action
		a.route("POST /api/admin/agents/{id}/"+action, false, func(w http.ResponseWriter, r *http.Request) error {
			b, e := body(r)
			if e != nil {
				return e
			}
			field, input := "name", "name"
			if action == "active" {
				field, input = "active", "active"
			}
			if action == "probe" {
				field, input = "probe_enabled", "enabled"
			}
			if action == "rename" {
				name := strings.TrimSpace(str(b, input))
				if name == "" || len(name) > 200 {
					return failure("invalid_name", 400)
				}
				b[input] = name
			} else {
				if _, ok := b[input].(bool); !ok {
					return failure("invalid_"+input, 400)
				}
			}
			e = a.store.mutate(r.Context(), func(t *transaction) error {
				agent, e := t.get("agent", r.PathValue("id"))
				if e != nil {
					return e
				}
				if agent == nil {
					return failure("agent_not_found", 404)
				}
				agent[field] = b[input]
				agent["updated_at"] = time.Now().Unix()
				return t.put("agent", str(agent, "id"), agent)
			})
			if e != nil {
				return e
			}
			respond(w, 200, Object{"ok": true, field: b[input]})
			return nil
		})
	}
	a.route("DELETE /api/admin/agents/{id}", false, func(w http.ResponseWriter, r *http.Request) error {
		e := a.store.mutate(r.Context(), func(t *transaction) error {
			id := r.PathValue("id")
			agent, e := t.get("agent", id)
			if e != nil {
				return e
			}
			if agent == nil {
				return failure("agent_not_found", 404)
			}
			monitors, e := t.list("monitor")
			if e != nil {
				return e
			}
			for _, m := range monitors {
				if str(m, "agent_id") == id {
					return failure("agent_in_use", 409)
				}
			}
			for _, kind := range []string{"agent", "machine", "runtime_config"} {
				if e = t.remove(kind, id); e != nil {
					return e
				}
			}
			for _, kind := range []string{"machine_history", "probe_job", "command"} {
				rows, e := t.list(kind)
				if e != nil {
					return e
				}
				for _, row := range rows {
					if str(row, "agent_id") == id {
						key := str(row, "id")
						if kind == "probe_job" {
							key = str(row, "run_id")
						}
						if e = t.remove(kind, key); e != nil {
							return e
						}
					}
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true})
		return nil
	})
	a.route("GET /api/admin/agents/{id}/detail", false, a.agentDetail)
	a.route("GET /api/agents/probe-sources", false, func(w http.ResponseWriter, r *http.Request) error {
		agents, e := a.store.list(r.Context(), "agent")
		if e != nil {
			return e
		}
		rows := []Object{}
		for _, agent := range agents {
			machine, _ := a.store.get(r.Context(), "machine", str(agent, "id"))
			online := agentOnline(machine, time.Now().Unix())
			rows = append(rows, Object{"id": agent["id"], "name": agent["name"], "active": boolean(agent["active"]), "version": machine["version"], "capabilities": fallback(machine, "capabilities", []string{}), "online": online != nil && *online, "installed": machine != nil, "probe_enabled": boolean(agent["probe_enabled"])})
		}
		respond(w, 200, Object{"agents": rows})
		return nil
	})
	a.route("GET /api/admin/agents/{id}/config", false, a.agentConfiguration)
	a.route("PUT /api/admin/agents/{id}/config", false, a.agentConfiguration)
	a.route("POST /api/admin/agents/{id}/commands", false, a.issueCommand)
	a.route("GET /api/admin/agents/{id}/commands", false, a.listCommands)
	a.route("POST /api/admin/agents/batch-commands", false, a.batchCommands)
	a.agentTransportRoutes()
}

func (a *App) agentDetail(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.store.get(r.Context(), "agent", r.PathValue("id"))
	if e != nil {
		return e
	}
	if agent == nil {
		return failure("agent_not_found", 404)
	}
	machine, _ := a.store.get(r.Context(), "machine", str(agent, "id"))
	mounts := []Object{}
	for _, v := range array(machine["mounts"]) {
		m := object(v)
		mounts = append(mounts, Object{"name": m["name"], "total": m["total_bytes"], "used": m["used_bytes"], "free": m["free_bytes"], "used_percent": m["used_percent"]})
	}
	interfaces := []Object{}
	for _, v := range array(machine["interfaces"]) {
		n := object(v)
		interfaces = append(interfaces, Object{"name": n["name"], "up_rate": n["up_rate"], "down_rate": n["down_rate"], "total_up": n["total_up_bytes"], "total_down": n["total_down_bytes"]})
	}
	monitors, e := a.store.list(r.Context(), "monitor")
	if e != nil {
		return e
	}
	targets, alerts := []Object{}, []Object{}
	for _, m := range monitors {
		if source, id := checkSource(m); source == "agent" && id == str(agent, "id") {
			targets = append(targets, Object{"monitor_id": m["id"], "num_id": m["num_id"], "name": m["name"], "type": m["type"], "target": m["target"], "interval_sec": m["interval_sec"], "active": boolean(m["active"])})
		}
		if str(m, "type") == "agent" && str(m, "agent_id") == str(agent, "id") {
			state, _ := a.store.get(r.Context(), "alert_state", str(m, "id"))
			for resource, v := range object(options(m)["alerts"]) {
				rule := clone(object(v))
				rule["resource"] = resource
				rule["monitor_id"] = m["id"]
				rule["monitor_name"] = m["name"]
				rule["active"] = boolean(object(state[resource])["active"])
				alerts = append(alerts, rule)
			}
		}
	}
	jobs, e := a.store.list(r.Context(), "probe_job")
	if e != nil {
		return e
	}
	agentJobs := []Object{}
	for _, job := range jobs {
		if str(job, "agent_id") == str(agent, "id") {
			agentJobs = append(agentJobs, project(job, []string{"run_id", "monitor_id", "monitor_name", "probe_type", "state", "attempts", "scheduled_at", "completed_at", "latency_ms", "status", "message"}))
		}
	}
	sort.Slice(agentJobs, func(i, j int) bool {
		return integer(agentJobs[i], "scheduled_at") > integer(agentJobs[j], "scheduled_at")
	})
	if len(agentJobs) > 20 {
		agentJobs = agentJobs[:20]
	}
	history, e := a.machineHistory(r.Context(), str(agent, "id"))
	if e != nil {
		return e
	}
	respond(w, 200, Object{"agent": a.fleetRow(r.Context(), agent), "install": Object{"token": agent["token"]}, "mounts": mounts, "interfaces": interfaces, "alerts": alerts, "history": history, "probe_targets": targets, "probe_jobs": agentJobs})
	return nil
}
func project(o Object, keys []string) Object {
	out := Object{}
	for _, k := range keys {
		out[k] = o[k]
	}
	return out
}
func (a *App) machineHistory(ctx context.Context, id string) ([]Object, error) {
	rows, e := a.store.list(ctx, "machine_history")
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, row := range rows {
		if str(row, "agent_id") == id && integer(row, "bucket_ts") >= time.Now().Unix()-86400 {
			point := Object{"ts": row["bucket_ts"], "cpu": row["cpu_avg"], "mem_pct": row["mem_pct_avg"], "net_up": nil, "net_down": nil}
			if seconds := number(row["network_duration_sec"]); seconds > 0 {
				if row["net_up_bytes"] != nil {
					point["net_up"] = number(row["net_up_bytes"]) / seconds
				}
				if row["net_down_bytes"] != nil {
					point["net_down"] = number(row["net_down_bytes"]) / seconds
				}
			}
			out = append(out, point)
		}
	}
	sort.Slice(out, func(i, j int) bool { return integer(out[i], "ts") < integer(out[j], "ts") })
	return out, nil
}

func (a *App) evaluateAgentAlerts(ctx context.Context, m, machine Object, result CheckResult) CheckResult {
	state, _ := a.store.get(ctx, "alert_state", str(m, "id"))
	if state == nil {
		state = Object{}
	}
	now := integer(machine, "reported_at")
	fresh := now > integer(state, "_observed_at")
	for resource, v := range object(options(m)["alerts"]) {
		rule := object(v)
		if !boolean(rule["enabled"]) {
			continue
		}
		value := number(machine["cpu_usage"])
		switch resource {
		case "memory":
			if number(machine["mem_total"]) <= 0 {
				continue
			}
			value = number(machine["mem_used"]) / number(machine["mem_total"]) * 100
		case "disk":
			if number(machine["disk_total"]) <= 0 {
				continue
			}
			value = number(machine["disk_used"]) / number(machine["disk_total"]) * 100
		case "load":
			value = number(machine["load_1"])
		}
		current := object(state[resource])
		if current == nil {
			current = Object{"since": nil, "active": false}
		}
		threshold := number(rule["threshold"])
		if !fresh {
			if boolean(current["active"]) {
				result.Status = 2
				result.Message = fmt.Sprintf("%s resource alert: %.2f", resource, value)
			}
			continue
		}
		if value >= threshold {
			if current["since"] == nil {
				current["since"] = now
			}
			if now-integer(current, "since") >= integer(rule, "duration_sec") {
				current["active"] = true
			}
		} else if !boolean(current["active"]) || value < threshold*number(rule["recovery_pct"])/100 {
			current["active"] = false
			current["since"] = nil
		}
		state[resource] = current
		if boolean(current["active"]) {
			result.Status = 2
			result.Message = fmt.Sprintf("%s resource alert: %.2f", resource, value)
		}
	}
	if fresh {
		state["_observed_at"] = now
		_ = a.store.put(ctx, "alert_state", str(m, "id"), state)
	}
	return result
}

func validRuntimeConfig(config Object) bool {
	if len(config) != 7 {
		return false
	}
	sample, report := number(config["sample_interval_secs"]), number(config["report_interval_secs"])
	if sample < 1 || sample != math.Trunc(sample) || report < sample || report > 1800 || report != math.Trunc(report) {
		return false
	}
	if _, ok := config["auto_update"].(bool); !ok {
		return false
	}
	for _, key := range []string{"include_nics", "exclude_nics", "include_mounts", "exclude_mounts"} {
		list, ok := config[key].([]any)
		if !ok || len(list) > 32 {
			return false
		}
		normalized := []any{}
		seen := map[string]bool{}
		for _, v := range list {
			s, ok := v.(string)
			if !ok || len(s) == 0 || len(s) > 256 || strings.IndexFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
				return false
			}
			if !seen[s] {
				normalized = append(normalized, s)
				seen[s] = true
			}
		}
		config[key] = normalized
	}
	return true
}
func runtimeConfigsEqual(desired, reported Object) bool {
	if len(desired) != 7 || len(reported) != 7 {
		return false
	}
	for _, key := range []string{"sample_interval_secs", "report_interval_secs", "auto_update"} {
		left, leftOK := desired[key]
		right, rightOK := reported[key]
		if !leftOK || !rightOK || encode(left) != encode(right) {
			return false
		}
	}
	for _, key := range []string{"include_nics", "exclude_nics", "include_mounts", "exclude_mounts"} {
		left, leftOK := desired[key].([]any)
		right, rightOK := reported[key].([]any)
		if !leftOK || !rightOK {
			return false
		}
		members := make(map[string]bool, len(left))
		for _, value := range left {
			name, ok := value.(string)
			if !ok {
				return false
			}
			members[name] = true
		}
		matched := make(map[string]bool, len(right))
		for _, value := range right {
			name, ok := value.(string)
			if !ok || !members[name] {
				return false
			}
			matched[name] = true
		}
		if len(members) != len(matched) {
			return false
		}
	}
	return true
}
func configState(row Object, allowed bool) Object {
	report := object(row["reported"])
	status := "unreported"
	if report != nil {
		status = "synced"
		if row["error"] != nil {
			status = "error"
		} else if row["desired_revision"] != nil && row["desired_revision"] != row["applied_revision"] {
			status = "pending"
		}
	}
	return Object{"supported": report != nil, "allowed": allowed, "current": report["config"], "installation": report["installation"], "desired": row["desired"], "desired_revision": row["desired_revision"], "applied_revision": row["applied_revision"], "status": status, "error": row["error"]}
}
func (a *App) agentConfiguration(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	agent, e := a.store.get(r.Context(), "agent", id)
	if e != nil {
		return e
	}
	if agent == nil {
		return failure("agent_not_found", 404)
	}
	allowed := boolean(a.settings(r.Context())["security.allowAgentCommands"])
	if r.Method == "GET" {
		row, e := a.store.get(r.Context(), "runtime_config", id)
		if e != nil {
			return e
		}
		respond(w, 200, configState(row, allowed))
		return nil
	}
	if !allowed {
		return failure("commands_disabled", 403)
	}
	b, e := body(r)
	if e != nil {
		return e
	}
	config := object(b["config"])
	_, hasRevision := b["expected_revision"]
	if !hasRevision || !validRuntimeConfig(config) {
		return failure("agent_config_invalid", 400)
	}
	revision := token(16)
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		row, e := t.get("runtime_config", id)
		if e != nil {
			return e
		}
		if row == nil || object(row["reported"]) == nil {
			return failure("agent_config_unsupported", 409)
		}
		if row["desired_revision"] != b["expected_revision"] {
			return failure("agent_config_conflict", 409)
		}
		installation := object(object(row["reported"])["installation"])
		if boolean(config["auto_update"]) && !boolean(installation["auto_update_supported"]) {
			return failure("agent_config_invalid", 400)
		}
		row["desired"] = config
		row["desired_revision"] = revision
		row["error"] = nil
		return t.put("runtime_config", id, row)
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "revision": revision})
	return nil
}
