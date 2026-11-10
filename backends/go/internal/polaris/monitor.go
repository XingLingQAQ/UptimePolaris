package polaris

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var monitorTypes = []string{"http", "tcp", "udp", "icmp", "dns", "tls", "websocket", "push", "agent"}
var hostnamePattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$`)
var targetSchemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

func normalizeMonitorTarget(kind, target string) (string, error) {
	target = strings.TrimSpace(target)
	switch kind {
	case "http":
		if targetSchemePattern.MatchString(target) {
			lower := strings.ToLower(target)
			if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
				return "", failure("target_invalid", 400)
			}
			return target, nil
		}
		return "https://" + target, nil
	case "tcp", "udp", "tls":
		prefix := kind + "://"
		if len(target) >= len(prefix) && strings.EqualFold(target[:len(prefix)], prefix) {
			return target[len(prefix):], nil
		}
		if targetSchemePattern.MatchString(target) {
			return "", failure("target_invalid", 400)
		}
	case "icmp", "dns":
		return strings.TrimSuffix(strings.TrimPrefix(target, "["), "]"), nil
	case "push", "agent":
		return "", nil
	}
	return target, nil
}

// 合并更新后按固定顺序校验；失败码和已有来源的保留条件随该顺序生效。
// Validate merged updates in order, preserving error precedence and existing-source rules.
func (a *App) validateMonitor(t *transaction, input, stored Object) (Object, error) {
	settings := defaultSettings()
	if config, e := t.get("config", "settings"); e != nil {
		return nil, e
	} else {
		for k, v := range config {
			settings[k] = v
		}
	}
	m := Object{"name": "", "type": "", "target": "", "method": "GET", "expected_status": "200-299", "keyword": nil, "interval_sec": settings["monitor.defaultIntervalSec"], "timeout_ms": settings["monitor.defaultTimeoutMs"], "warn_days": 14, "check_ssl": 0, "check_domain": 0, "check_dns": 0, "options_json": "{}", "push_token": nil, "agent_id": nil, "is_public": 1, "group_id": nil, "active": 1, "tag_ids": []string{}}
	if stored != nil {
		m = clone(stored)
	}
	allowed := []string{"name", "type", "target", "method", "expected_status", "keyword", "interval_sec", "timeout_ms", "warn_days", "check_ssl", "check_domain", "check_dns", "options_json", "agent_id", "is_public", "group_id", "active", "tag_ids"}
	for k, v := range input {
		if !contains(allowed, k) {
			continue
		}
		m[k] = v
	}
	if _, ok := input["is_public"]; ok {
		v, ok := input["is_public"].(bool)
		if !ok {
			return nil, failure("visibility_invalid", 400)
		}
		if v {
			m["is_public"] = 1
		} else {
			m["is_public"] = 0
		}
	}
	if err := validateMonitorFields(m); err != nil {
		return nil, err
	}
	kind := str(m, "type")
	var o Object
	switch v := m["options_json"].(type) {
	case string:
		if json.Unmarshal([]byte(v), &o) != nil {
			return nil, failure("options_json_invalid", 400)
		}
	default:
		o = object(v)
	}
	if o == nil || len(encode(o)) > 64000 {
		return nil, failure("options_json_invalid", 400)
	}
	if kind == "agent" && !knownFields(o, []string{"alerts"}) || kind == "push" && len(o) > 0 {
		return nil, failure("options_json_invalid", 400)
	}
	for _, key := range []string{"active", "check_ssl", "check_domain", "check_dns"} {
		if v, exists := input[key]; exists {
			if _, ok := v.(bool); !ok {
				if _, ok := v.(float64); !ok || number(v) != 0 && number(v) != 1 {
					return nil, failure(key+"_invalid", 400)
				}
			}
		}
	}
	if err := validateMonitorOptions(o); err != nil {
		return nil, err
	}
	if err := validateMonitorSource(t, m, stored, o); err != nil {
		return nil, err
	}
	if kind != "push" && kind != "agent" {
		if _, ok := o["check_source"]; !ok {
			o["check_source"] = Object{"type": "server"}
			m["agent_id"] = nil
		}
	}
	target, err := normalizeMonitorTarget(kind, str(m, "target"))
	if err != nil {
		return nil, err
	}
	m["target"] = target
	switch kind {
	case "http", "websocket":
		u, e := url.Parse(target)
		schemes := []string{"http", "https"}
		if kind == "websocket" {
			schemes = []string{"ws", "wss"}
		}
		if e != nil || !contains(schemes, u.Scheme) || u.Hostname() == "" || u.Fragment != "" {
			return nil, failure("target_invalid", 400)
		}
	case "tcp", "udp", "tls":
		host, port, e := net.SplitHostPort(target)
		n, _ := strconv.Atoi(port)
		if e != nil || host == "" || n < 1 || n > 65535 {
			return nil, failure("target_invalid", 400)
		}
	case "icmp", "dns":
		if !hostnamePattern.MatchString(target) && net.ParseIP(target) == nil {
			return nil, failure("target_invalid", 400)
		}
	case "push", "agent":
		m["target"] = ""
	}
	if boolean(m["check_ssl"]) || boolean(m["check_domain"]) || boolean(m["check_dns"]) {
		host, _ := targetHost(m)
		if host == "" || net.ParseIP(host) != nil {
			return nil, failure("addon_needs_hostname", 400)
		}
	}
	if kind == "icmp" && !a.icmpAvailable && str(object(o["check_source"]), "type") != "agent" {
		return nil, failure("icmp_permission_unavailable", 400)
	}
	if kind == "push" {
		if str(m, "push_token") == "" {
			m["push_token"] = token(24)
		}
	} else {
		m["push_token"] = nil
	}
	if kind == "agent" {
		if err := validateAgentMonitor(t, m, o); err != nil {
			return nil, err
		}
	}
	if kind == "udp" {
		if err := validateUDPMonitor(o); err != nil {
			return nil, err
		}
	}
	if kind == "dns" || boolean(m["check_dns"]) {
		if err := validateDNSMonitor(o); err != nil {
			return nil, err
		}
	}
	for _, flag := range []string{"check_ssl", "check_domain", "check_dns"} {
		if kind == "agent" || kind == "push" || kind == "dns" || kind == "icmp" {
			m[flag] = 0
		} else if boolean(m[flag]) {
			m[flag] = 1
		} else {
			m[flag] = 0
		}
	}
	if err := validateMonitorTaxonomy(t, m, input); err != nil {
		return nil, err
	}
	m["options_json"] = encode(o)
	if boolean(m["active"]) {
		m["active"] = 1
	} else {
		m["active"] = 0
	}
	m["updated_at"] = time.Now().Unix()
	return m, nil
}

func validateMonitorFields(m Object) error {
	if strings.TrimSpace(str(m, "name")) == "" || len(str(m, "name")) > 120 {
		return failure("name_required", 400)
	}
	m["name"] = strings.TrimSpace(str(m, "name"))
	kind := str(m, "type")
	if !contains(monitorTypes, kind) {
		return failure("invalid_type", 400)
	}
	for _, spec := range []struct {
		key      string
		min, max float64
	}{{"interval_sec", 5, 86400}, {"timeout_ms", 100, 120000}, {"warn_days", 1, 365}} {
		v := number(m[spec.key])
		if v < spec.min || v > spec.max || v != math.Trunc(v) {
			return failure(spec.key+"_invalid", 400)
		}
	}
	if !contains([]string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}, str(m, "method")) {
		return failure("method_invalid", 400)
	}
	for _, part := range strings.Split(str(m, "expected_status"), ",") {
		pieces := strings.Split(strings.TrimSpace(part), "-")
		if len(pieces) > 2 {
			return failure("expected_status_invalid", 400)
		}
		lo, e := strconv.Atoi(pieces[0])
		if e != nil || lo < 100 || lo > 599 {
			return failure("expected_status_invalid", 400)
		}
		if len(pieces) == 2 {
			hi, e := strconv.Atoi(pieces[1])
			if e != nil || hi < lo || hi > 599 {
				return failure("expected_status_invalid", 400)
			}
		}
	}
	if m["keyword"] != nil {
		if _, ok := m["keyword"].(string); !ok || len(str(m, "keyword")) > 4096 {
			return failure("keyword_invalid", 400)
		}
	}
	return nil
}

func validateMonitorOptions(o Object) error {
	for _, key := range []string{"send", "expect", "encoding", "body", "jsonPath", "jsonExpected", "headerName", "headerExpected", "serverName"} {
		if v, exists := o[key]; exists {
			if _, ok := v.(string); !ok || len(str(o, key)) > 16384 {
				return failure("options_json_invalid", 400)
			}
		}
	}
	if headers, exists := o["headers"]; exists {
		values := object(headers)
		if values == nil || len(values) > 100 {
			return failure("options_json_invalid", 400)
		}
		for key, value := range values {
			if _, ok := value.(string); !ok || strings.ContainsAny(key+fmt.Sprint(value), "\r\n") {
				return failure("options_json_invalid", 400)
			}
		}
	}
	if v, exists := o["maxLatencyMs"]; exists {
		if !validNumber(v) || number(v) <= 0 || number(v) > 120000 {
			return failure("options_json_invalid", 400)
		}
	}
	if value, exists := o["auth"]; exists {
		auth := object(value)
		if auth == nil || !contains([]string{"basic", "bearer"}, str(auth, "type")) {
			return failure("options_json_invalid", 400)
		}
		for _, key := range []string{"username", "password", "token"} {
			if v, exists := auth[key]; exists {
				if _, ok := v.(string); !ok {
					return failure("options_json_invalid", 400)
				}
			}
		}
	}
	return nil
}

// 来源、监控类型与附加检查均未改变时保留绑定，否则重新验证能力。
// Preserve the binding only when the source, monitor type, and add-ons are unchanged.
func validateMonitorSource(t *transaction, m, stored, o Object) error {
	kind := str(m, "type")
	source, exists := o["check_source"]
	if !exists {
		return nil
	}
	so := object(source)
	if so == nil || !contains([]string{"server", "agent"}, str(so, "type")) || str(so, "type") == "server" && len(so) != 1 || str(so, "type") == "agent" && (!knownFields(so, []string{"type", "agent_id"}) || len(so) != 2) {
		return failure("check_source_invalid", 400)
	}
	if str(so, "type") == "server" {
		if kind != "agent" {
			m["agent_id"] = nil
		}
		return nil
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(str(so, "agent_id")) {
		return failure("check_source_invalid", 400)
	}
	oldSource, oldID := checkSource(stored)
	preserve := stored != nil && str(stored, "type") == kind && oldSource == "agent" && oldID == str(so, "agent_id")
	for _, addon := range []string{"check_ssl", "check_domain", "check_dns"} {
		if boolean(stored[addon]) != boolean(m[addon]) {
			preserve = false
		}
	}
	if preserve {
		m["agent_id"] = so["agent_id"]
		return nil
	}
	agent, e := t.get("agent", str(so, "agent_id"))
	if e != nil {
		return e
	}
	if agent != nil && !boolean(agent["probe_enabled"]) {
		return failure("agent_probe_disabled", 400)
	}
	live, e := t.get("machine", str(so, "agent_id"))
	if e != nil {
		return e
	}
	if agent == nil || !boolean(agent["active"]) || !contains(stringsOf(live["capabilities"]), "probe_"+kind) {
		return failure("agent_probe_capability_required", 400)
	}
	for _, addon := range []string{"ssl", "domain", "dns"} {
		if boolean(m["check_"+addon]) && !contains(stringsOf(live["capabilities"]), "probe_"+addon) {
			return failure("agent_probe_capability_required", 400)
		}
	}
	if kind == "udp" || kind == "icmp" {
		online := agentOnline(live, time.Now().Unix())
		if online == nil || !*online {
			return failure("agent_offline", 400)
		}
	}
	m["agent_id"] = so["agent_id"]
	return nil
}

func validateAgentMonitor(t *transaction, m, o Object) error {
	agent, e := t.get("agent", str(m, "agent_id"))
	if e != nil {
		return e
	}
	if agent == nil {
		return failure("agent_required", 400)
	}
	for key, v := range object(o["alerts"]) {
		if !contains([]string{"cpu", "memory", "disk", "load"}, key) {
			return failure("agent_alerts_invalid", 400)
		}
		rule := object(v)
		threshold := number(rule["threshold"])
		if rule == nil || threshold <= 0 || threshold > 10000 || key != "load" && threshold > 100 || number(rule["duration_sec"]) < 1 || number(rule["duration_sec"]) > 86400 || number(rule["recovery_pct"]) <= 0 || number(rule["recovery_pct"]) >= 100 {
			return failure("agent_alerts_invalid", 400)
		}
	}
	return nil
}

func validateUDPMonitor(o Object) error {
	encoding := str(o, "encoding")
	if encoding != "" && encoding != "text" && encoding != "hex" {
		return failure("options_json_invalid", 400)
	}
	send, _ := fallback(o, "send", "ping").(string)
	payload, e := packetBytes(send, encoding)
	expected, e2 := packetBytes(str(o, "expect"), encoding)
	if e != nil || e2 != nil || len(payload) == 0 || len(payload) > 4096 || len(expected) > 4096 {
		return failure("options_json_invalid", 400)
	}
	return nil
}

func validateDNSMonitor(o Object) error {
	dnsOptions := object(o["dns"])
	if !contains([]string{"A", "AAAA", "CNAME", "MX", "TXT", "NS"}, str(dnsOptions, "recordType")) {
		return failure("dns_options_invalid", 400)
	}
	if resolver := str(dnsOptions, "resolver"); resolver != "" {
		if strings.HasPrefix(resolver, "https://") {
			u, e := url.Parse(resolver)
			if e != nil || u.Host == "" {
				return failure("dns_options_invalid", 400)
			}
		} else if _, _, e := net.SplitHostPort(resolver); e != nil {
			return failure("dns_options_invalid", 400)
		}
	}
	return nil
}

func validateMonitorTaxonomy(t *transaction, m, input Object) error {
	if id := str(m, "group_id"); id != "" {
		group, e := t.get("group", id)
		if e != nil {
			return e
		}
		if group == nil {
			return failure("group_not_found", 400)
		}
	}
	if v, exists := input["tag_ids"]; exists {
		if _, ok := v.([]any); !ok {
			return failure("tag_ids_invalid", 400)
		}
	}
	for _, id := range stringsOf(m["tag_ids"]) {
		tag, e := t.get("tag", id)
		if e != nil {
			return e
		}
		if tag == nil {
			return failure("tag_not_found", 400)
		}
	}
	return nil
}

func (a *App) monitorRoutes() {
	a.route("GET /api/monitors", false, func(w http.ResponseWriter, r *http.Request) error {
		rows, e := a.store.list(r.Context(), "monitor")
		if e != nil {
			return e
		}
		for _, m := range rows {
			m["tags"] = a.tags(r.Context(), "tag", stringsOf(m["tag_ids"]))
			delete(m, "tag_ids")
		}
		sort.Slice(rows, func(i, j int) bool { return integer(rows[i], "num_id") < integer(rows[j], "num_id") })
		respond(w, 200, Object{"monitors": rows})
		return nil
	})
	a.route("POST /api/monitors", false, func(w http.ResponseWriter, r *http.Request) error {
		input, e := body(r)
		if e != nil {
			return e
		}
		var m Object
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			var e error
			m, e = a.validateMonitor(t, input, nil)
			if e != nil {
				return e
			}
			id := uuid()
			num, e := t.next("monitor")
			if e != nil {
				return e
			}
			m["id"] = id
			m["num_id"] = num
			m["created_at"] = time.Now().Unix()
			return t.put("monitor", id, m)
		})
		if e != nil {
			return e
		}
		result := Object{"id": m["id"]}
		if str(m, "push_token") != "" {
			result["push_token"] = m["push_token"]
		}
		respond(w, 201, result)
		return nil
	})
	a.route("PUT /api/monitors/{id}", false, func(w http.ResponseWriter, r *http.Request) error {
		input, e := body(r)
		if e != nil {
			return e
		}
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			id := r.PathValue("id")
			m, e := t.get("monitor", id)
			if e != nil {
				return e
			}
			if m == nil {
				return failure("not_found", 404)
			}
			m, e = a.validateMonitor(t, input, m)
			if e != nil {
				return e
			}
			return t.put("monitor", id, m)
		})
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true})
		return nil
	})
	a.route("DELETE /api/monitors/{id}", false, func(w http.ResponseWriter, r *http.Request) error {
		e := a.store.mutate(r.Context(), func(t *transaction) error {
			id := r.PathValue("id")
			m, e := t.get("monitor", id)
			if e != nil {
				return e
			}
			if m == nil {
				return failure("not_found", 404)
			}
			for _, kind := range []string{"monitor", "live", "push", "alert_state"} {
				if e = t.remove(kind, id); e != nil {
					return e
				}
			}
			if _, e = t.tx.Exec(t.store.query(`DELETE FROM polaris_readings WHERE monitor_id=?`), id); e != nil {
				return e
			}
			stats, e := t.list("day_stat")
			if e != nil {
				return e
			}
			for _, stat := range stats {
				if str(stat, "monitor_id") == id {
					if e = t.remove("day_stat", str(stat, "id")); e != nil {
						return e
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
	a.route("POST /api/monitors/visibility", false, func(w http.ResponseWriter, r *http.Request) error { return a.visibility(w, r, "monitor") })
	a.route("POST /api/monitors/check", false, func(w http.ResponseWriter, r *http.Request) error {
		input, e := body(r)
		if e != nil {
			return e
		}
		var m Object
		e = a.store.mutate(r.Context(), func(t *transaction) error { var e error; m, e = a.validateMonitor(t, input, nil); return e })
		if e != nil {
			return e
		}
		if source, _ := checkSource(m); source == "agent" {
			respond(w, 200, CheckResult{Status: 2, Message: "agent probe result not available yet"})
			return nil
		}
		select {
		case a.semaphore <- struct{}{}:
			defer func() { <-a.semaphore }()
		default:
			return failure("probe_busy", 409)
		}
		respond(w, 200, a.probe(r.Context(), m))
		return nil
	})
	a.route("POST /api/monitors/{id}/check", false, func(w http.ResponseWriter, r *http.Request) error {
		m, e := a.store.get(r.Context(), "monitor", r.PathValue("id"))
		if e != nil {
			return e
		}
		if m == nil {
			return failure("not_found", 404)
		}
		if !boolean(m["active"]) {
			return failure("monitor_paused", 409)
		}
		switch str(m, "type") {
		case "push":
			return failure("push_not_probeable", 409)
		case "agent":
			return failure("agent_not_probeable", 409)
		}
		if source, _ := checkSource(m); source == "agent" {
			return failure("agent_source_not_probeable", 409)
		}
		select {
		case a.semaphore <- struct{}{}:
			defer func() { <-a.semaphore }()
		default:
			return failure("probe_busy", 409)
		}
		result, e := a.execute(r.Context(), m, true)
		if e != nil {
			return e
		}
		respond(w, 200, result)
		return nil
	})
	a.route("GET /api/overview", false, a.overview)
	a.route("GET /api/events", false, a.events)
	a.route("POST /api/cron/tick", false, func(w http.ResponseWriter, r *http.Request) error {
		started := time.Now()
		a.cycle(r.Context(), true)
		rows, e := a.store.list(r.Context(), "live")
		if e != nil {
			return e
		}
		monitors, e := a.store.list(r.Context(), "monitor")
		if e != nil {
			return e
		}
		live := Object{}
		for _, m := range monitors {
			entry, e := a.store.get(r.Context(), "live", str(m, "id"))
			if e != nil {
				return e
			}
			if entry != nil {
				live[str(m, "id")] = entry
			}
		}
		respond(w, 200, Object{"ok": true, "tick": "completed", "ms": time.Since(started).Milliseconds(), "monitors": len(rows), "status": live})
		return nil
	})
	a.route("POST /api/cron/sync", false, a.syncHistory)
}

func (a *App) visibility(w http.ResponseWriter, r *http.Request, kind string) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	ids := stringsOf(b["ids"])
	public, ok := b["is_public"].(bool)
	if len(ids) < 1 || len(ids) > 500 || !ok {
		return failure("invalid_ids", 400)
	}
	unique := map[string]bool{}
	for _, id := range ids {
		if id == "" || strings.TrimSpace(id) != id || len(id) > 128 {
			return failure("invalid_ids", 400)
		}
		unique[id] = true
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		for id := range unique {
			o, e := t.get(kind, id)
			if e != nil {
				return e
			}
			if o == nil {
				return failure("not_found", 404)
			}
			o["is_public"] = 0
			if public {
				o["is_public"] = 1
			}
			o["updated_at"] = time.Now().Unix()
			if e = t.put(kind, id, o); e != nil {
				return e
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "updated": len(unique), "is_public": public})
	return nil
}

func (a *App) execute(ctx context.Context, m Object, force bool) (Object, error) {
	id := str(m, "id")
	owner := token(16)
	now := time.Now().Unix()
	claimed, err := a.store.claim(ctx, "monitor:"+id, owner, now, integer(m, "timeout_ms")/1000+30, force)
	if err != nil {
		return nil, err
	}
	if !claimed {
		return nil, failure("probe_busy", 409)
	}
	defer a.store.release(context.Background(), "monitor:"+id, owner, time.Now().Unix()+integer(m, "interval_sec"))
	previous, err := a.store.get(ctx, "live", id)
	if err != nil {
		return nil, err
	}
	addonsDone := make(chan Object, 1)
	go func() { addonsDone <- a.addons(ctx, m, previous) }()
	primary := a.probe(ctx, m)
	addons := <-addonsDone
	return a.persistCheck(ctx, m, primary, addons, false)
}

func (a *App) persistCheck(ctx context.Context, m Object, primary CheckResult, addons Object, passive bool) (Object, error) {
	now := time.Now().Unix()
	id := str(m, "id")
	settings := a.settings(ctx)
	maintenance := boolean(a.maintenance(ctx)["active"])
	var live Object
	event, notified := false, false
	err := a.store.mutate(ctx, func(t *transaction) error {
		current, e := t.get("monitor", id)
		if e != nil {
			return e
		}
		if current == nil || !boolean(current["active"]) {
			return failure("monitor_unavailable", 409)
		}
		if sourceVersion(current) != sourceVersion(m) {
			return failure("monitor_changed", 409)
		}
		previous, e := t.get("live", id)
		if e != nil {
			return e
		}
		fails := int64(0)
		status := primary.Status
		if primary.Status == 0 && !passive {
			fails = integer(previous, "fails") + 1
			if fails < int64(number(settings["monitor.defaultRetries"])) {
				status = 4
			}
		}
		warning := primary.Status == 2
		message := primary.Message
		for kind, v := range addons {
			if integer(object(v), "st") != 1 {
				warning = true
				if detail := str(object(v), "msg"); detail != "" {
					if message != "" {
						message += "; "
					}
					message += strings.ToUpper(kind) + ": " + detail
				}
			}
		}
		if len(message) > 1024 {
			message = message[:1024]
		}
		if status != 0 && warning {
			status = 2
		}
		var value any = primary.LatencyMs
		if str(m, "type") == "push" {
			value = nil
		}
		observedAt := now
		if integer(m, "_source_observed_at") > 0 {
			observedAt = integer(m, "_source_observed_at")
		}
		live = Object{"st": status, "ts": observedAt, "v": value, "code": primary.StatusCode, "msg": message, "fails": fails, "prev_st": previous["st"]}
		if previous == nil {
			live["prev_st"] = 1
		}
		if integer(previous, "st") == 4 {
			live["prev_st"] = fallback(previous, "settled_st", 1)
		}
		live["settled_st"] = fallback(previous, "settled_st", 1)
		if status != 4 {
			live["settled_st"] = status
		}
		if m["_source_observed_at"] != nil {
			live["source_observed_at"] = m["_source_observed_at"]
		}
		for k, v := range addons {
			live[k] = v
		}
		wantNotify := status != 4 && int64(status) != integer(live, "prev_st")
		alertPending := boolean(previous["alert_pending"])
		if status == 1 {
			if alertPending {
				wantNotify = false
			}
		} else if maintenance {
			if alertPending || wantNotify {
				live["alert_pending"] = true
			}
		} else if alertPending {
			if status == 4 {
				live["alert_pending"] = true
			} else {
				wantNotify = true
				live["prev_st"] = nil
			}
		}
		if e = t.put("live", id, live); e != nil {
			return e
		}
		if _, e = t.tx.Exec(t.store.query(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,?,?,?,?,?)`), id, observedAt, status, value, primary.StatusCode, message, encode(addons)); e != nil {
			return e
		}
		if observedAt/86400 < now/86400 {
			if e = t.remove("rollup_day", fmt.Sprint(observedAt/86400*86400)); e != nil {
				return e
			}
		}
		old := integer(previous, "st")
		if previous == nil && status != 1 || previous != nil && old != int64(status) {
			event = true
			eid, e := t.next("event")
			if e != nil {
				return e
			}
			ev := Object{"id": eid, "monitor_id": id, "monitor_name": current["name"], "from_status": nil, "to_status": status, "message": message, "created_at": now}
			if previous != nil {
				ev["from_status"] = old
			}
			if e = t.put("event", fmt.Sprint(eid), ev); e != nil {
				return e
			}
		}
		if !maintenance && wantNotify {
			notified, e = a.queueNotifications(t, current, live)
			if e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return Object{"ok": true, "monitor_id": id, "status": live["st"], "latencyMs": live["v"], "statusCode": live["code"], "message": live["msg"], "checked_at": live["ts"], "primary": primary, "event": event, "notified": notified, "maintenance": maintenance}, nil
}

func (a *App) tick() {
	a.cycle(a.ctx, false)
}
func (a *App) cycle(ctx context.Context, wait bool) {
	monitors, err := a.store.list(ctx, "monitor")
	if err != nil {
		return
	}
	var cycle sync.WaitGroup
	for _, m := range monitors {
		if !boolean(m["active"]) {
			continue
		}
		if wait {
			select {
			case a.semaphore <- struct{}{}:
			case <-ctx.Done():
				return
			}
		} else {
			select {
			case a.semaphore <- struct{}{}:
			default:
				continue
			}
		}
		a.wg.Add(1)
		cycle.Add(1)
		store := a.store
		go func(m Object) {
			defer a.wg.Done()
			defer cycle.Done()
			defer func() { <-a.semaphore }()
			if !wait {
				a.storeLock.RLock()
				defer a.storeLock.RUnlock()
				if a.store != store {
					return
				}
			}
			kind := str(m, "type")
			if kind == "push" || kind == "agent" {
				_ = a.passiveCheck(ctx, m)
				return
			}
			if source, _ := checkSource(m); source == "agent" {
				_ = a.scheduleAgentProbe(ctx, m)
				return
			}
			_, _ = a.execute(ctx, m, false)
		}(m)
	}
	if wait {
		cycle.Wait()
	}
	a.deliverPending()
	if time.Now().Unix()%60 == 0 {
		a.wg.Add(1)
		store := a.store
		go func() {
			defer a.wg.Done()
			a.storeLock.RLock()
			defer a.storeLock.RUnlock()
			if a.store == store {
				_ = a.rollupHistory(a.ctx, false)
			}
		}()
	}
}

func (a *App) passiveCheck(ctx context.Context, m Object) error {
	id := str(m, "id")
	owner := token(12)
	now := time.Now().Unix()
	claimed, e := a.store.claim(ctx, "monitor:"+id, owner, now, 15, false)
	if e != nil || !claimed {
		return e
	}
	defer a.store.release(context.Background(), "monitor:"+id, owner, now+5)
	result := CheckResult{Status: 4, Message: "waiting for first report"}
	if str(m, "type") == "push" {
		p, e := a.store.get(ctx, "push", id)
		if e != nil {
			return e
		}
		if p != nil {
			result.Status = int(integer(p, "status"))
			result.Message = str(p, "message")
			if now-integer(p, "ts") > integer(m, "interval_sec") {
				result.Status = 0
				result.Message = "push heartbeat expired"
			}
		}
	} else {
		agent, e := a.store.get(ctx, "agent", str(m, "agent_id"))
		if e != nil {
			return e
		}
		live, e := a.store.get(ctx, "machine", str(m, "agent_id"))
		if e != nil {
			return e
		}
		online := agentOnline(live, now)
		if online == nil {
			return nil
		}
		if agent == nil || !boolean(agent["active"]) {
			offline := false
			online = &offline
		}
		if online != nil {
			if *online {
				previous, e := a.store.get(ctx, "live", id)
				if e != nil {
					return e
				}
				if integer(previous, "source_observed_at") >= integer(live, "reported_at") {
					return nil
				}
				m = clone(m)
				m["_source_observed_at"] = live["reported_at"]
				result.Status = 1
				result.LatencyMs = number(live["cpu_usage"])
				result.Message = str(live, "message")
				result = a.evaluateAgentAlerts(ctx, m, live, result)
			} else {
				result.Status = 0
				result.Message = "agent is offline"
			}
		}
	}
	_, e = a.persistCheck(ctx, m, result, Object{}, true)
	return e
}
