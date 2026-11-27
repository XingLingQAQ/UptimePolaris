package polaris

import (
	"context"
	"testing"
	"time"
)

func TestAgentPublicMetricVisibility(t *testing.T) {
	live := Object{"os": "fixture-os", "arch": "x86_64", "cpu_usage": 0, "mem_used": 99, "net_up_rate": 100, "net_down_rate": 200}
	page := Object{"showOs": false, "metrics": []string{"cpu", "load"}}
	row := publicServerMetrics(live, page)
	if len(row) != 2 || row["cpu"] != 0 || row["load"] != nil {
		t.Fatal("hidden, unknown and zero metrics must stay distinct", row)
	}
	points := publicServerHistory([]Object{{"ts": 60, "cpu": 0, "mem_pct": 99, "net_up": 100, "net_down": 200}}, page)
	if len(points) != 1 || len(points[0]) != 2 || points[0]["cpu"] != 0 {
		t.Fatal("history exposed an unpublished metric", points)
	}
	all := resolveBuiltinPageView("agent", Object{})
	if len(publicServerMetrics(live, all)) != 13 {
		t.Fatal("default metrics changed", publicServerMetrics(live, all))
	}
}

func TestAgentHistoryWindowsAndWeightedBuckets(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	rows := []Object{
		{"id": "one", "agent_id": "a", "bucket_ts": 600, "cpu_avg": 0, "cpu_samples": 1, "mem_pct_avg": 90, "mem_samples": 3, "net_up_bytes": 100, "net_down_bytes": 0, "network_duration_sec": 10},
		{"id": "two", "agent_id": "a", "bucket_ts": 660, "cpu_avg": 100, "cpu_samples": 3, "mem_pct_avg": 10, "mem_samples": 1, "net_up_bytes": 900, "net_down_bytes": nil, "network_duration_sec": 30},
		{"id": "gap", "agent_id": "a", "bucket_ts": 1200, "cpu_avg": nil, "cpu_samples": 0, "mem_samples": 0, "network_duration_sec": 0},
		{"id": "old", "agent_id": "a", "bucket_ts": 540},
		{"id": "future", "agent_id": "a", "bucket_ts": 1800},
		{"id": "other", "agent_id": "b", "bucket_ts": 600},
	}
	for _, row := range rows {
		if err := s.app.store.put(ctx, "machine_history", str(row, "id"), row); err != nil {
			t.Fatal(err)
		}
	}
	history, err := s.app.machineHistory(ctx, "a", 600, 1500, 300)
	if err != nil || len(history) != 2 {
		t.Fatal(history, err)
	}
	if number(history[0]["cpu"]) != 75 || number(history[0]["mem_pct"]) != 70 || number(history[0]["net_up"]) != 25 || history[0]["net_down"] != float64(0) {
		t.Fatal("incorrect sample/duration weighting", history)
	}
	if integer(history[1], "ts") != 1200 || history[1]["cpu"] != nil || history[1]["net_up"] != nil {
		t.Fatal("missing readings filled or gaps joined", history)
	}
	minutes, err := s.app.machineHistory(ctx, "a", 600, 1500, 60)
	if err != nil || len(minutes) != 3 || integer(minutes[1], "ts") != 660 {
		t.Fatal("public minute resolution changed", minutes, err)
	}
}

func TestAgentPublicHistoryDisabledAndPaused(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	fixtures := map[string]Object{
		"agent":           {"id": "a", "name": "fixture", "active": true, "is_public": true},
		"machine":         {"reported_at": now, "report_interval_secs": 60, "cpu_usage": 23},
		"monitor":         {"id": "a", "num_id": 1, "type": "agent", "agent_id": "a", "name": "fixture", "is_public": true, "active": 1},
		"machine_history": {"id": "a", "agent_id": "a", "bucket_ts": now / 60 * 60, "cpu_avg": 23, "cpu_samples": 1},
	}
	for kind, row := range fixtures {
		if err := s.app.store.put(ctx, kind, "a", row); err != nil {
			t.Fatal(err)
		}
	}
	state, _ := s.app.presentation(ctx)
	config := object(state["config"])
	config["agentEnabled"] = true
	config["domains"] = []any{Object{"hostname": "127.0.0.1", "page": "agent"}}
	object(object(config["pages"])["agent"])["themeOptions"] = Object{"showHistory": false}
	code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/public/servers/a", nil, false)
	expectStatus(t, code, 200, result)
	if len(array(result["history"])) != 0 {
		t.Fatal("history was not disabled", result)
	}
	config["agentEnabled"] = false
	state, _ = s.app.presentation(ctx)
	code, result = s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	fixtures["agent"]["active"] = false
	if err := s.app.store.put(ctx, "agent", "a", fixtures["agent"]); err != nil {
		t.Fatal(err)
	}
	code, result = s.request(t, "GET", "/api/public/agent/detail/1", nil, false)
	expectStatus(t, code, 200, result)
	if result["online"] != false {
		t.Fatal("disabled Agent appeared online", result)
	}
}

func TestPublicAgentHardwareSettingRedaction(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	fixtures := map[string]Object{
		"agent":   {"id": "hw", "name": "hw", "active": true, "is_public": true},
		"machine": {"reported_at": now, "report_interval_secs": 60, "cpu_usage": 15, "interfaces_json": `[{"name":"tailscale0"}]`, "mounts_json": `[{"name":"/srv"}]`},
		"monitor": {"id": "hw", "num_id": 77, "type": "agent", "agent_id": "hw", "name": "hw", "is_public": true, "active": 1},
	}
	for kind, row := range fixtures {
		if err := s.app.store.put(ctx, kind, "hw", row); err != nil {
			t.Fatal(err)
		}
	}

	// Default off: omitted for both anonymous and authenticated requests.
	for _, authed := range []bool{false, true} {
		code, result := s.request(t, "GET", "/api/public/agent/detail/77", nil, authed)
		expectStatus(t, code, 200, result)
		live := object(result["live"])
		if _, ok := live["interfaces_json"]; ok {
			t.Fatalf("interfaces_json leaked when setting disabled (authed=%v): %v", authed, live)
		}
		if _, ok := live["mounts_json"]; ok {
			t.Fatalf("mounts_json leaked when setting disabled (authed=%v): %v", authed, live)
		}
	}

	code, updated := s.request(t, "PUT", "/api/admin/settings", Object{"site.showPublicAgentHardware": true}, true)
	expectStatus(t, code, 200, updated)
	if object(updated["values"])["site.showPublicAgentHardware"] != true {
		t.Fatal("setting did not persist", updated)
	}

	code, result := s.request(t, "GET", "/api/public/agent/detail/77", nil, false)
	expectStatus(t, code, 200, result)
	live := object(result["live"])
	if str(live, "interfaces_json") != `[{"name":"tailscale0"}]` || str(live, "mounts_json") != `[{"name":"/srv"}]` {
		t.Fatalf("expected hardware fields when setting enabled, got: %v", live)
	}
}
