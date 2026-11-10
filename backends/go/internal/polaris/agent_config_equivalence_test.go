// 验证远程配置按过滤集合比较而非列表顺序。
// Check remote configuration by filter sets rather than list order.

package polaris

import (
	"context"
	"testing"
)

func TestAgentConfigExchangeMatchesFilterSets(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.app.store.put(ctx, "agent", "a", Object{"id": "a", "token": "fixture-token", "active": true}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.put(ctx, "config", "settings", Object{"security.allowAgentCommands": true}); err != nil {
		t.Fatal(err)
	}
	desired := Object{"sample_interval_secs": 5, "report_interval_secs": 60, "include_nics": []any{"eth0", "wlan0"}, "exclude_nics": []any{"veth0", "docker0"}, "include_mounts": []any{"/", "/data"}, "exclude_mounts": []any{"/tmp", "/run"}, "auto_update": false}
	installation := Object{"service_tier": nil, "config_path": "fixture", "executable_path": "fixture", "auto_update_supported": true}
	path := "/api/public/agent/config/fixture-token"
	code, out := s.request(t, "POST", path, Object{"config": desired, "installation": installation, "revision": nil}, false)
	expectStatus(t, code, 200, out)
	code, out = s.request(t, "PUT", "/api/admin/agents/a/config", Object{"config": desired, "expected_revision": nil}, true)
	expectStatus(t, code, 200, out)
	revision := out["revision"]
	same := clone(desired)
	same["include_nics"] = []any{"wlan0", "eth0", "wlan0"}
	same["exclude_nics"] = []any{"docker0", "veth0", "docker0"}
	same["include_mounts"] = []any{"/data", "/", "/data"}
	same["exclude_mounts"] = []any{"/run", "/tmp", "/run"}
	code, out = s.request(t, "POST", path, Object{"config": same, "installation": installation, "revision": revision}, false)
	expectStatus(t, code, 200, out)
	if out["runtime_config"] != nil {
		t.Fatalf("equivalent filters remained pending: %v", out)
	}
	code, out = s.request(t, "GET", "/api/admin/agents/a/config", nil, true)
	expectStatus(t, code, 200, out)
	if str(out, "status") != "synced" {
		t.Fatal(out)
	}
	current := object(out["current"])
	if encode(current["include_nics"]) != encode([]string{"wlan0", "eth0"}) {
		t.Fatalf("reported filter order changed: %v", current)
	}
	for _, tc := range []struct {
		name, key string
		value     any
	}{
		{"include_nics_member", "include_nics", []any{"wlan0", "eth1"}},
		{"exclude_nics_member", "exclude_nics", []any{"docker0", "veth1"}},
		{"include_mounts_case", "include_mounts", []any{"/", "/DATA"}},
		{"exclude_mounts_member", "exclude_mounts", []any{"/tmp", "/var"}},
		{"interval", "sample_interval_secs", 10},
		{"bool", "auto_update", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := clone(same)
			changed[tc.key] = tc.value
			code, out := s.request(t, "POST", path, Object{"config": changed, "installation": installation, "revision": revision}, false)
			expectStatus(t, code, 200, out)
			if object(out["runtime_config"])["revision"] != revision {
				t.Fatalf("different configuration marked synced: %v", out)
			}
			code, out = s.request(t, "GET", "/api/admin/agents/a/config", nil, true)
			expectStatus(t, code, 200, out)
			if str(out, "status") != "pending" {
				t.Fatal(out)
			}
		})
	}
	for _, tc := range []struct {
		key   string
		value any
	}{{"include_nics", []any{"eth0", 123}}, {"report_interval_secs", "60"}, {"auto_update", 1}} {
		changed := clone(same)
		changed[tc.key] = tc.value
		code, out = s.request(t, "POST", path, Object{"config": changed, "installation": installation, "revision": revision}, false)
		expectStatus(t, code, 400, out)
	}
}
