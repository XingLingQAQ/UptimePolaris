package polaris

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed installers/*
var installerFiles embed.FS
var binaryPattern = regexp.MustCompile(`^polaris-agent-(?:(\d+\.\d+\.\d+)-)?(linux-x86_64|linux-aarch64|windows-x86_64|darwin-x86_64|darwin-aarch64)(\.exe)?$`)

func (a *App) installer(w http.ResponseWriter, r *http.Request) error {
	file := r.PathValue("file")
	if file == "" {
		file = strings.TrimPrefix(r.URL.Path, "/")
	}
	if file != "install.sh" && file != "install.ps1" {
		return failure("not_found", 404)
	}
	raw, e := installerFiles.ReadFile("installers/" + file)
	if e != nil {
		return e
	}
	scheme := "http"
	if r.TLS != nil || a.config.TrustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	origin := scheme + "://" + r.Host
	if strings.ContainsAny(origin, "'\"`\r\n\\$;<>") {
		return failure("invalid_origin", 400)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, e = w.Write([]byte(strings.ReplaceAll(string(raw), "POLARIS_ORIGIN_PLACEHOLDER", origin)))
	return e
}

func (a *App) agentDownload(w http.ResponseWriter, r *http.Request) error {
	file := r.PathValue("file")
	if file == "install.sh" || file == "install.ps1" {
		return a.installer(w, r)
	}
	match := binaryPattern.FindStringSubmatch(file)
	if match == nil || (match[2] == "windows-x86_64") != (match[3] == ".exe") {
		return failure("unsupported_platform", 422)
	}
	manifest, err := latestAgentRelease()
	if err != nil {
		return err
	}
	for _, v := range array(manifest["platforms"]) {
		entry := object(v)
		if str(entry, "key") == match[2] && (match[1] == "" || file == str(entry, "file")) {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, agentReleaseURL(str(manifest, "tag"), str(entry, "file")), http.StatusFound)
			return nil
		}
	}
	return failure("release_asset_missing", 501)
}

func (a *App) agentTransportRoutes() {
	manifestHandler := func(w http.ResponseWriter, r *http.Request) error {
		manifest, err := latestAgentRelease()
		if err != nil {
			return err
		}
		respond(w, 200, manifest)
		return nil
	}
	a.route("GET /api/public/agent/capabilities", true, manifestHandler)
	a.route("GET /api/public/agent/manifest", true, manifestHandler)
	a.route("GET /api/public/agent/download/{file}", true, a.agentDownload)
	a.route("POST /api/public/agent/push/{token}", true, a.agentHTTPPush)
	a.route("GET /api/public/agent/push/{token}", true, func(w http.ResponseWriter, r *http.Request) error {
		respond(w, 200, Object{"ok": true, "transport": "http-push", "note": "POST one JSON-RPC frame, or an array of them, to this URL. The token in the path is the credential."})
		return nil
	})
	a.route("GET /api/public/agent/{token}", true, a.agentWebSocket)
	a.route("GET /api/public/agent/jobs/{token}", true, a.agentPoll)
	a.route("POST /api/public/agent/results/{token}", true, a.agentProbeResult)
	a.route("POST /api/public/agent/commands/{token}/result", true, a.agentCommandResult)
	a.route("POST /api/public/agent/config/{token}", true, a.agentConfigExchange)
}
func validNumber(v any) bool { n, ok := v.(float64); return ok && !math.IsNaN(n) && !math.IsInf(n, 0) }

func normalizedMetricRows(value any, keys []string) any {
	rows, ok := value.([]any)
	if !ok {
		return nil
	}
	out := []Object{}
	for _, v := range rows {
		row := object(v)
		name, ok := row["name"].(string)
		if !ok {
			continue
		}
		valid := true
		for _, key := range keys {
			if !validNumber(row[key]) {
				valid = false
			}
		}
		if valid {
			clean := Object{"name": name}
			for _, key := range keys {
				clean[key] = row[key]
			}
			out = append(out, clean)
		}
	}
	return out
}
func validSummary(row Object) bool {
	if row == nil {
		return false
	}
	for _, key := range []string{"bucket_ts", "sample_count", "duration_sec", "network_duration_sec"} {
		if !validNumber(row[key]) || number(row[key]) != math.Trunc(number(row[key])) || number(row[key]) < 0 {
			return false
		}
	}
	for _, key := range []string{"cpu_samples", "mem_samples"} {
		if !validNumber(row[key]) {
			return false
		}
	}
	for _, key := range []string{"cpu_avg", "cpu_max", "mem_pct_avg", "mem_pct_max", "load_1_avg", "load_5_avg", "net_up_bytes", "net_down_bytes"} {
		if row[key] != nil && !validNumber(row[key]) {
			return false
		}
	}
	return number(row["sample_count"]) > 0
}
func validFrame(frame Object) bool {
	params := object(frame["params"])
	switch str(frame, "method") {
	case "event":
		return true
	case "basicReport":
		for _, key := range []string{"name", "os", "arch", "cpu_model"} {
			if _, ok := params[key].(string); !ok {
				return false
			}
		}
		return validNumber(params["cpu_cores"])
	case "report":
		fields := map[string][]string{"cpu": {"usage"}, "ram": {"total", "used"}, "swap": {"total", "used"}, "load": {"load1", "load5", "load15"}, "disk": {"total", "used"}, "network": {"up", "down", "totalUp", "totalDown"}, "connections": {"tcp", "udp"}}
		for key, keys := range fields {
			row := object(params[key])
			if row == nil {
				return false
			}
			for _, k := range keys {
				if !validNumber(row[k]) {
					return false
				}
			}
		}
		if !validNumber(params["uptime"]) || !validNumber(params["process"]) {
			return false
		}
		if v, ok := params["observed_at"]; ok && (!validNumber(v) || number(v) != math.Trunc(number(v))) {
			return false
		}
		return len(array(params["summaries"])) <= 32
	}
	return false
}
func (a *App) dispatchFrame(ctx context.Context, agent, frame Object) (Object, error) {
	ack := Object{"ack": true, "ignored": false}
	if !validFrame(frame) {
		return nil, failure("invalid frame", 400)
	}
	p := object(frame["params"])
	now := time.Now().Unix()
	method := str(frame, "method")
	observed := now
	if v, ok := p["observed_at"]; ok {
		observed = int64(number(v))
	}
	if method == "report" && observed > now+300 {
		ack["deferred"] = true
		return ack, nil
	}
	if method == "report" && observed < now-86400 {
		ack["ignored"] = true
		return ack, nil
	}
	err := a.store.mutate(ctx, func(t *transaction) error {
		current, e := t.get("agent", str(agent, "id"))
		if e != nil {
			return e
		}
		if current == nil || !boolean(current["active"]) {
			ack["ignored"] = true
			return nil
		}
		if method == "event" {
			return nil
		}
		live, e := t.get("machine", str(agent, "id"))
		if e != nil {
			return e
		}
		if live == nil {
			live = Object{"agent_id": agent["id"], "reported_at": nil}
		}
		if method == "basicReport" {
			for _, key := range []string{"os", "arch", "kernel", "cpu_model", "cpu_cores", "version", "isp", "region", "virtualization", "transport", "report_interval_secs"} {
				if v, ok := p[key]; ok {
					live[key] = v
				}
			}
			live["public_ip"] = p["publicIp"]
			live["public_ipv6"] = p["publicIpv6"]
			values, isArray := p["capabilities"].([]any)
			validCapabilities := isArray && len(values) <= 16
			capabilities := []string{}
			for _, value := range values {
				capability, ok := value.(string)
				if !ok || !regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`).MatchString(capability) {
					validCapabilities = false
				} else if !contains(capabilities, capability) {
					capabilities = append(capabilities, capability)
				}
			}
			live["capabilities"] = nil
			if validCapabilities {
				live["capabilities"] = capabilities
			}
		} else {
			if live["reported_at"] != nil && observed <= integer(live, "reported_at") {
				ack["ignored"] = true
				return nil
			}
			for key, fields := range map[string]map[string]string{"cpu": {"usage": "cpu_usage"}, "ram": {"used": "mem_used", "total": "mem_total"}, "swap": {"used": "swap_used", "total": "swap_total"}, "load": {"load1": "load_1", "load5": "load_5", "load15": "load_15"}, "disk": {"used": "disk_used", "total": "disk_total"}, "network": {"up": "net_up_rate", "down": "net_down_rate", "totalUp": "net_up_total", "totalDown": "net_down_total"}, "connections": {"tcp": "connections_tcp", "udp": "connections_udp"}} {
				values := object(p[key])
				for source, dest := range fields {
					live[dest] = values[source]
				}
			}
			live["uptime"] = p["uptime"]
			live["process_count"] = p["process"]
			live["message"] = p["message"]
			live["interfaces"] = normalizedMetricRows(p["interfaces"], []string{"up_rate", "down_rate", "total_up_bytes", "total_down_bytes"})
			live["mounts"] = normalizedMetricRows(p["mounts"], []string{"total_bytes", "used_bytes", "free_bytes", "used_percent"})
			live["interfaces_json"] = nil
			live["mounts_json"] = nil
			if live["interfaces"] != nil {
				live["interfaces_json"] = encode(live["interfaces"])
			}
			if live["mounts"] != nil {
				live["mounts_json"] = encode(live["mounts"])
			}
			live["reported_at"] = observed
			for _, v := range array(p["summaries"]) {
				summary := object(v)
				ts := integer(summary, "bucket_ts")
				if !validSummary(summary) || ts%60 != 0 || ts < now-86400 || ts > observed || ts > now+300 || number(summary["duration_sec"]) > 3600 || number(summary["duration_sec"]) < 0 || integer(summary, "sample_count") < 1 {
					continue
				}
				id := fmt.Sprintf("%s:%d", str(agent, "id"), ts)
				existing, e := t.get("machine_history", id)
				if e != nil {
					return e
				}
				if existing != nil {
					continue
				}
				summary = clone(summary)
				summary["id"] = id
				summary["agent_id"] = agent["id"]
				summary["quality"] = "aggregate"
				if e = t.put("machine_history", id, summary); e != nil {
					return e
				}
			}
		}
		live["updated_at"] = now
		return t.put("machine", str(agent, "id"), live)
	})
	return ack, err
}

func (a *App) agentHTTPPush(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	if e != nil {
		return e
	}
	var value any
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&value) != nil {
		return failure("invalid json", 400)
	}
	frames := []any{value}
	if batch, ok := value.([]any); ok {
		frames = batch
	}
	if len(frames) == 0 {
		return failure("empty batch", 400)
	}
	if len(frames) > 40 {
		return failure("batch too large", 413)
	}
	work := 0
	for _, v := range frames {
		frame := object(v)
		if !validFrame(frame) {
			respond(w, 400, Object{"ok": false, "error": "invalid frame", "applied": 0, "received": len(frames)})
			return nil
		}
		cost := 1
		if str(frame, "method") == "basicReport" {
			cost = 2
		}
		if str(frame, "method") == "report" {
			cost = 2 + len(array(object(frame["params"])["summaries"]))
		}
		work += cost
	}
	if work > 40 {
		return failure("batch work too large", 413)
	}
	accepted, ignored, deferred := 0, 0, 0
	acks := []Object{}
	for _, v := range frames {
		frame := object(v)
		ack, e := a.dispatchFrame(r.Context(), agent, frame)
		if e != nil {
			return e
		}
		if boolean(ack["deferred"]) {
			deferred++
		} else if boolean(ack["ignored"]) {
			ignored++
		} else {
			accepted++
		}
		ack["id"] = frame["id"]
		acks = append(acks, ack)
	}
	respond(w, 200, Object{"ok": true, "applied": len(frames), "accepted": accepted, "ignored": ignored, "deferred": deferred, "received": len(frames), "acks": acks})
	return nil
}

func (a *App) agentWebSocket(w http.ResponseWriter, r *http.Request) error {
	if !websocket.IsWebSocketUpgrade(r) {
		return failure("upgrade_required", 426)
	}
	a.storeLock.RLock()
	store := a.store
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	a.storeLock.RUnlock()
	if e != nil {
		return e
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return a.sameOrigin(r) }, ReadBufferSize: 4096, WriteBufferSize: 4096}
	conn, e := upgrader.Upgrade(w, r, nil)
	if e != nil {
		return nil
	}
	defer conn.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-a.ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	conn.SetReadLimit(2 << 20)
	for {
		var frame Object
		if e = conn.ReadJSON(&frame); e != nil {
			return nil
		}
		a.storeLock.RLock()
		if a.store != store {
			a.storeLock.RUnlock()
			return nil
		}
		ack, e := a.dispatchFrame(a.ctx, agent, frame)
		a.storeLock.RUnlock()
		if e != nil {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "frame rejected"), time.Now().Add(time.Second))
			return nil
		}
		if frame["id"] != nil {
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if e = conn.WriteJSON(Object{"jsonrpc": "2.0", "id": frame["id"], "result": ack}); e != nil {
				return nil
			}
		}
	}
}

func (a *App) agentConfigExchange(w http.ResponseWriter, r *http.Request) error {
	agent, e := a.agentByToken(r.Context(), r.PathValue("token"))
	if e != nil {
		return e
	}
	b, e := body(r)
	if e != nil {
		return e
	}
	config := object(b["config"])
	installation := object(b["installation"])
	_, hasRevision := b["revision"]
	_, hasTier := installation["service_tier"]
	if !hasRevision || !hasTier || !validRuntimeConfig(config) || installation == nil || len(str(installation, "config_path")) > 1024 || len(str(installation, "executable_path")) > 1024 {
		return failure("agent_config_invalid", 400)
	}
	if _, ok := installation["auto_update_supported"].(bool); !ok {
		return failure("agent_config_invalid", 400)
	}
	for _, key := range []string{"config_path", "executable_path"} {
		if _, ok := installation[key].(string); !ok {
			return failure("agent_config_invalid", 400)
		}
	}
	if installation["service_tier"] != nil {
		if _, ok := installation["service_tier"].(string); !ok || len(str(installation, "service_tier")) > 64 {
			return failure("agent_config_invalid", 400)
		}
	}
	if b["revision"] != nil && (!regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(str(b, "revision"))) {
		return failure("agent_config_invalid", 400)
	}
	var result Object
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		id := str(agent, "id")
		row, e := t.get("runtime_config", id)
		if e != nil {
			return e
		}
		if row == nil {
			row = Object{}
		}
		row["reported"] = Object{"config": config, "installation": installation}
		row["applied_revision"] = nil
		if row["desired_revision"] != nil && row["desired_revision"] == b["revision"] && runtimeConfigsEqual(object(row["desired"]), config) && str(b, "error") == "" {
			row["applied_revision"] = b["revision"]
		}
		row["error"] = nil
		if str(b, "error") != "" {
			if len(str(b, "error")) > 512 {
				return failure("agent_config_invalid", 400)
			}
			row["error"] = b["error"]
		}
		result = row
		return t.put("runtime_config", id, row)
	})
	if e != nil {
		return e
	}
	var desired any
	if result["desired_revision"] != nil && result["desired_revision"] != result["applied_revision"] && boolean(a.settings(r.Context())["security.allowAgentCommands"]) {
		desired = Object{"revision": result["desired_revision"], "config": result["desired"]}
	}
	respond(w, 200, Object{"ok": true, "runtime_config": desired})
	return nil
}
